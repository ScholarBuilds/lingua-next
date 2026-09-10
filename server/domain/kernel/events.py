"""内核事件总线、作用域链与分层注册表。

翻译自 DeepSeek harness（TypeScript）：

- ``vendor/cordis/src/events.ts`` :165-243 —— dispatch 过滤，emit / parallel / serial /
  bail / waterfall 五种分发方式
- ``packages/core/scope/src/index.ts`` :39-185 —— 作用域父链、环检测，以及 ``scopeTarget``
  的过滤规则："事件沿链向上流动，不向下流动"
- ``packages/core/scope/src/store.ts`` :159-266 —— ``ScopedLayers`` 的惰性分层、链合并、
  空层回收
- ``packages/core/tools/src/index.ts`` :1071-1192 —— ``restrict`` 只过滤继承面，不过滤本
  scope 自己注册的条目

Python 化的取舍：

- Cordis 的 Fiber / Context 不搬。作用域用字符串键表示，注册归属由 :class:`Scopes`
  记账：``scopes.dispose(key)`` 级联释放子作用域及其名下全部监听器与层条目（逆注册序），
  等价于 fiber 卸载。
- 不搬 ``thisArg``：scope 以关键字参数显式传入，分发时按作用域链过滤。
- ``serial`` / ``bail`` 的"有结果"判定是 ``is not None``；TS 里 ``false`` 也算无结果，
  Python 这边 ``False`` 是有效返回值。
- ``waterfall`` 的 ``next`` 以关键字参数传给监听器，并允许 ``next(*new_args)`` 改写后续
  参数；TS 版 ``next()`` 只能沿用原参数。
- 整个模块假定在单个事件循环线程内使用，不加锁。
"""

from __future__ import annotations

import asyncio
import inspect
import itertools
import logging
from collections import deque
from collections.abc import Awaitable, Callable, Iterable
from typing import Any

logger = logging.getLogger(__name__)

ScopeKey = str
Disposer = Callable[[], None]
Listener = Callable[..., Any]


class KernelError(Exception):
    """内核原语的基础异常。"""


class ScopeError(KernelError):
    """作用域不存在、已释放、或父链会成环。"""


class DuplicateEntryError(KernelError):
    """同一层内重复注册同名条目。"""


def is_bailed(value: Any) -> bool:
    """``serial`` / ``bail`` 的终止判定：监听器返回非 ``None`` 即视为给出结果。"""
    return value is not None


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


def _once(fn: Callable[[], None]) -> Disposer:
    """把撤销函数包成幂等 disposer：重复调用只生效一次。"""
    done = False

    def dispose() -> None:
        nonlocal done
        if done:
            return
        done = True
        fn()

    return dispose


class _Effect:
    """挂在某个作用域名下的一条可撤销注册。"""

    __slots__ = ("dispose",)

    def __init__(self, dispose: Disposer) -> None:
        self.dispose = dispose


class Scopes:
    """作用域键的父链与注册归属。

    一条父关系同时支撑两个方向：注册视图沿链**向下**继承（子作用域看得见祖先各层，
    :class:`ScopedLayers`），事件放行沿链**向上**扩展（祖先标签的监听器收得到子孙键的
    事件，:class:`EventBus`）。键由本类铸造，保证进程内唯一。
    """

    def __init__(self) -> None:
        self._parents: dict[ScopeKey, ScopeKey | None] = {}
        self._children: dict[ScopeKey, list[ScopeKey]] = {}
        self._effects: dict[ScopeKey, list[_Effect]] = {}
        self._seq = itertools.count(1)

    def __contains__(self, key: object) -> bool:
        return key in self._parents

    def create(self, parent: ScopeKey | None = None, *, label: str = "scope") -> ScopeKey:
        """铸造一个新键；``parent`` 必须是仍存活的键。"""
        if parent is not None:
            self._require(parent)
        key = f"{label}#{next(self._seq)}"
        self._parents[key] = parent
        self._children[key] = []
        self._effects[key] = []
        if parent is not None:
            self._children[parent].append(key)
        return key

    def parent(self, key: ScopeKey) -> ScopeKey | None:
        return self._parents.get(key)

    def chain(self, key: ScopeKey | None) -> list[ScopeKey]:
        """从 ``key`` 到根的链，最近者在前：``[key, parent, grandparent, …]``。

        ``None`` 给空链；未登记的键只含自身，分发时等同于"只有全局监听器可见"。
        """
        chain: list[ScopeKey] = []
        cursor = key
        while cursor is not None:
            chain.append(cursor)
            cursor = self._parents.get(cursor)
        return chain

    def rebind(self, key: ScopeKey, parent: ScopeKey | None) -> None:
        """改挂父作用域。沿用 TS 的环检测：父链上不能再出现自己。"""
        self._require(key)
        if parent is not None:
            self._require(parent)
            cursor: ScopeKey | None = parent
            while cursor is not None:
                if cursor == key:
                    raise ScopeError(f"作用域 {key!r} 改挂到 {parent!r} 会形成环")
                cursor = self._parents[cursor]
        old = self._parents[key]
        if old is not None:
            self._children[old].remove(key)
        self._parents[key] = parent
        if parent is not None:
            self._children[parent].append(key)

    def effect(self, key: ScopeKey, undo: Callable[[], None]) -> Disposer:
        """把一条撤销函数挂到作用域名下；释放作用域时逆序执行。

        返回的 disposer 幂等，且提前调用会把这条注册从归属表里摘掉。
        """
        effects = self._require(key)

        def dispose() -> None:
            if cell not in effects:
                return
            effects.remove(cell)
            undo()

        cell = _Effect(dispose)
        effects.append(cell)
        return dispose

    def dispose(self, key: ScopeKey) -> None:
        """释放作用域：先子后父，各自逆注册序执行撤销。未登记或已释放的键直接忽略。"""
        if key not in self._parents:
            return
        for child in list(self._children[key]):
            self.dispose(child)
        effects = self._effects.pop(key)
        for cell in reversed(list(effects)):
            try:
                cell.dispose()
            except Exception:
                logger.exception("释放作用域 %s 时撤销函数抛出异常", key)
        parent = self._parents.pop(key)
        del self._children[key]
        if parent is not None:
            self._children[parent].remove(key)

    def _require(self, key: ScopeKey) -> list[_Effect]:
        effects = self._effects.get(key)
        if effects is None:
            raise ScopeError(f"作用域 {key!r} 不存在或已释放")
        return effects


class _Hook:
    __slots__ = ("callback", "global_", "scope")

    def __init__(self, callback: Listener, scope: ScopeKey | None, global_: bool) -> None:
        self.callback = callback
        self.scope = scope
        self.global_ = global_


class EventBus:
    """五种分发方式 + 作用域过滤的事件总线。

    过滤规则（``scope/src/index.ts:170-185``）：监听器未带 scope 时总是触发；带 scope 时
    仅当分发的 scope 等于它、或是它的后代（即 ``hook.scope in chain(dispatch_scope)``）
    才触发。``global_=True`` 的监听器带归属但不参与过滤。

    非 ``internal/`` 事件分发前会先 ``emit("internal/dispatch", mode, name, args, scope)``，
    供追踪与诊断挂载。
    """

    def __init__(self, scopes: Scopes | None = None) -> None:
        self.scopes = scopes if scopes is not None else Scopes()
        self._hooks: dict[str, list[_Hook]] = {}
        self._tasks: set[asyncio.Future[Any]] = set()

    # ---- 注册 ----

    def on(
        self,
        name: str,
        callback: Listener,
        *,
        scope: ScopeKey | None = None,
        prepend: bool = False,
        global_: bool = False,
    ) -> Disposer:
        """注册监听器，返回幂等的退订函数。带 scope 的注册随作用域释放。"""
        if scope is not None and scope not in self.scopes:
            raise ScopeError(f"作用域 {scope!r} 不存在或已释放，无法注册 {name!r} 监听器")
        hooks = self._hooks.setdefault(name, [])
        hook = _Hook(callback, scope, global_)
        if prepend:
            hooks.insert(0, hook)
        else:
            hooks.append(hook)

        def undo() -> None:
            current = self._hooks.get(name)
            if current is None:
                return
            try:
                current.remove(hook)
            except ValueError:
                return
            if not current:
                del self._hooks[name]

        if scope is None:
            return _once(undo)
        return self.scopes.effect(scope, undo)

    def once(
        self,
        name: str,
        callback: Listener,
        *,
        scope: ScopeKey | None = None,
        prepend: bool = False,
        global_: bool = False,
    ) -> Disposer:
        """只触发一次的监听器：首次触发前先退订自己。"""

        def wrapper(*args: Any, **kwargs: Any) -> Any:
            dispose()
            return callback(*args, **kwargs)

        dispose = self.on(name, wrapper, scope=scope, prepend=prepend, global_=global_)
        return dispose

    def listeners(self, name: str) -> int:
        return len(self._hooks.get(name, ()))

    # ---- 分发 ----

    def emit(self, name: str, *args: Any, scope: ScopeKey | None = None) -> None:
        """同步扇出，不等待异步回调；单个监听器的异常只记日志。"""
        for cb in self._dispatch("emit", name, args, scope):
            try:
                result = cb(*args)
            except Exception:
                logger.exception("事件 %s 的监听器 %r 抛出异常", name, cb)
                continue
            if inspect.isawaitable(result):
                self._spawn(name, cb, result)

    async def parallel(self, name: str, *args: Any, scope: ScopeKey | None = None) -> None:
        """并发跑完全部监听器；任一失败则汇总成 ``ExceptionGroup`` 抛出。"""
        callbacks = self._dispatch("parallel", name, args, scope)
        if not callbacks:
            return

        async def run(cb: Listener) -> None:
            await _maybe_await(cb(*args))

        results = await asyncio.gather(*(run(cb) for cb in callbacks), return_exceptions=True)
        errors = [r for r in results if isinstance(r, BaseException)]
        if errors:
            # 全是 Exception 时构造出来的就是 ExceptionGroup
            raise BaseExceptionGroup(f"事件 {name} 有 {len(errors)} 个监听器失败", errors)

    async def serial(self, name: str, *args: Any, scope: ScopeKey | None = None) -> Any:
        """逐个 await，返回第一个非 ``None`` 的结果；没有则 ``None``。"""
        for cb in self._dispatch("serial", name, args, scope):
            result = await _maybe_await(cb(*args))
            if is_bailed(result):
                return result
        return None

    def bail(self, name: str, *args: Any, scope: ScopeKey | None = None) -> Any:
        """``serial`` 的同步版：监听器必须是同步函数，返回第一个非 ``None`` 的结果。"""
        for cb in self._dispatch("bail", name, args, scope):
            result = cb(*args)
            if inspect.isawaitable(result):
                if inspect.iscoroutine(result):
                    result.close()
                raise TypeError(f"bail({name!r}) 只接受同步监听器，{cb!r} 返回了 awaitable")
            if is_bailed(result):
                return result
        return None

    async def waterfall(
        self,
        name: str,
        *args: Any,
        scope: ScopeKey | None = None,
        terminal: Callable[..., Any],
    ) -> Any:
        """把监听器套在 ``terminal`` 外层，由外向内执行。

        监听器签名 ``async def listener(*args, next)``：调用 ``await next(*new_args)``
        才进入下一层（不传参数则沿用当前参数），最内层的 ``next`` 调 ``terminal(*args)``；
        不调 ``next`` 即短路，自身返回值就是整个 waterfall 的结果。
        """
        callbacks = deque(self._dispatch("waterfall", name, args, scope))
        current: tuple[Any, ...] = args

        async def next_(*new_args: Any) -> Any:
            nonlocal current
            if new_args:
                current = new_args
            if callbacks:
                cb = callbacks.popleft()
                return await _maybe_await(cb(*current, next=next_))
            return await _maybe_await(terminal(*current))

        return await next_()

    async def drain(self) -> None:
        """等 ``emit`` 派生的异步回调全部跑完；测试与优雅停机用。"""
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)

    # ---- 内部 ----

    def _dispatch(
        self, mode: str, name: str, args: tuple[Any, ...], scope: ScopeKey | None
    ) -> list[Listener]:
        if not name.startswith("internal/") and self._hooks.get("internal/dispatch"):
            self.emit("internal/dispatch", mode, name, args, scope)
        hooks = self._hooks.get(name)
        if not hooks:
            return []
        chain = self.scopes.chain(scope)
        return [h.callback for h in hooks if h.global_ or h.scope is None or h.scope in chain]

    def _spawn(self, name: str, cb: Listener, awaitable: Awaitable[Any]) -> None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        if loop is None:
            # 没有事件循环就地跑完，保证副作用发生
            try:
                asyncio.run(_maybe_await(awaitable))
            except Exception:
                logger.exception("事件 %s 的异步监听器 %r 抛出异常", name, cb)
            return
        task = asyncio.ensure_future(awaitable, loop=loop)
        self._tasks.add(task)

        def done(fut: asyncio.Future[Any]) -> None:
            self._tasks.discard(fut)
            if fut.cancelled():
                return
            exc = fut.exception()
            if exc is not None:
                logger.error("事件 %s 的异步监听器 %r 抛出异常", name, cb, exc_info=exc)

        task.add_done_callback(done)


class _Restriction:
    __slots__ = ("allow", "deny")

    def __init__(self, allow: frozenset[str] | None, deny: frozenset[str] | None) -> None:
        self.allow = allow
        self.deny = deny

    def admits(self, name: str) -> bool:
        if self.allow is not None and name not in self.allow:
            return False
        return not (self.deny is not None and name in self.deny)


class _Layer[T]:
    """一个作用域对注册表的全部贡献：具名条目 + 对继承面的限制。"""

    __slots__ = ("entries", "restrictions")

    def __init__(self) -> None:
        self.entries: dict[str, T] = {}
        self.restrictions: list[_Restriction] = []

    def is_empty(self) -> bool:
        return not self.entries and not self.restrictions

    def admits(self, name: str) -> bool:
        return all(r.admits(name) for r in self.restrictions)


class ScopedLayers[T]:
    """全局层 + 按作用域惰性创建的覆盖层。

    读取永不创建层；作用域层在最后一条贡献撤销后回收。视图规则：

    - 继承面 = 全局层 ∪ 祖先各层（远祖先在前，近者遮蔽同名）
    - 链上任一层的 ``restrict`` 都过滤继承面（限制沿链相交）
    - 本 scope 自己注册的条目最后落下，遮蔽同名且**不受**限制约束

    ``scopes`` 必须与 :class:`EventBus` 共用同一个实例，否则作用域键对不上。
    """

    def __init__(
        self,
        scopes: Scopes | None = None,
        *,
        on_change: Callable[[], None] | None = None,
    ) -> None:
        self.scopes = scopes if scopes is not None else Scopes()
        self._on_change = on_change
        self._global: _Layer[T] = _Layer()
        self._scoped: dict[ScopeKey, _Layer[T]] = {}

    # ---- 写 ----

    def set(
        self, key: str, value: T, scope: ScopeKey | None = None, *, notify: bool = True
    ) -> Disposer:
        """在 ``scope`` 层（``None`` 为全局层）注册一个具名条目，返回幂等撤销函数。

        同一层内重名抛 :class:`DuplicateEntryError`；跨层同名是正常的遮蔽。
        """

        def action(layer: _Layer[T]) -> Callable[[], None]:
            if key in layer.entries:
                where = "全局层" if scope is None else f"作用域 {scope!r}"
                raise DuplicateEntryError(f"{where} 已注册 {key!r}")
            layer.entries[key] = value

            def undo() -> None:
                if layer.entries.get(key) is value:
                    del layer.entries[key]

            return undo

        return self._effect(scope, action, notify=notify)

    def restrict(
        self,
        scope: ScopeKey | None,
        allow: Iterable[str] | None = None,
        deny: Iterable[str] | None = None,
        *,
        notify: bool = True,
    ) -> Disposer:
        """限制 ``scope`` 能看到的继承面：``allow`` 只保留这些名字，``deny`` 去掉这些名字。

        必须指定 scope（全局限制会遮蔽所有作用域）；空过滤视为配置错误；名字必须是当前
        继承面上存在的（本 scope 自己注册的不可限制）。限制沿链相交，对子孙作用域同样生效。
        """
        if scope is None:
            raise ScopeError("restrict 需要具体作用域：全局限制会遮蔽所有作用域")
        self._require_scope(scope)
        if allow is None and deny is None:
            raise ValueError("restrict 至少要给 allow 或 deny，空过滤多半是配置未物化")
        allow_set = frozenset(allow) if allow is not None else None
        deny_set = frozenset(deny) if deny is not None else None
        known = self._inherited(self.scopes.chain(scope))
        unknown = sorted(((allow_set or frozenset()) | (deny_set or frozenset())) - known.keys())
        if unknown:
            raise KernelError(
                f"restrict 指名了继承面上不存在的条目 {unknown}；可限制的有 {sorted(known)}"
            )
        compiled = _Restriction(allow_set, deny_set)

        def action(layer: _Layer[T]) -> Callable[[], None]:
            layer.restrictions.append(compiled)

            def undo() -> None:
                if compiled in layer.restrictions:
                    layer.restrictions.remove(compiled)

            return undo

        return self._effect(scope, action, notify=notify)

    # ---- 读 ----

    def get(self, key: str, scope: ScopeKey | None = None) -> T | None:
        """按 ``scope`` 的视角查一个名字：本层优先，再沿链找继承面；被限制掉的读作缺席。"""
        chain = self.scopes.chain(scope)
        own = self._scoped.get(chain[0]) if chain else None
        if own is not None and key in own.entries:
            return own.entries[key]
        if not self._admits(chain, key):
            return None
        for ancestor in chain[1:]:
            layer = self._scoped.get(ancestor)
            if layer is not None and key in layer.entries:
                return layer.entries[key]
        return self._global.entries.get(key)

    def view(self, scope: ScopeKey | None = None) -> dict[str, T]:
        """``scope`` 视角下的完整有效映射，按插入序；``None`` 为全局视图。"""
        chain = self.scopes.chain(scope)
        visible = {
            name: value
            for name, value in self._inherited(chain).items()
            if self._admits(chain, name)
        }
        own = self._scoped.get(chain[0]) if chain else None
        if own is not None:
            visible.update(own.entries)
        return visible

    def own(self, scope: ScopeKey | None) -> dict[str, T]:
        """只看某一层自己注册的条目，不看链（``None`` 为全局层）。"""
        layer = self._global if scope is None else self._scoped.get(scope)
        return dict(layer.entries) if layer is not None else {}

    def has_layer(self, scope: ScopeKey) -> bool:
        """作用域层是否仍存在；用于验证空层已回收。"""
        return scope in self._scoped

    # ---- 内部 ----

    def _inherited(self, chain: list[ScopeKey]) -> dict[str, T]:
        """继承面：全局层在前，祖先层由远到近覆盖，不含链首（本 scope）。"""
        inherited = dict(self._global.entries)
        for ancestor in reversed(chain[1:]):
            layer = self._scoped.get(ancestor)
            if layer is not None:
                inherited.update(layer.entries)
        return inherited

    def _admits(self, chain: list[ScopeKey], name: str) -> bool:
        for key in chain:
            layer = self._scoped.get(key)
            if layer is not None and not layer.admits(name):
                return False
        return True

    def _require_scope(self, scope: ScopeKey) -> None:
        if scope not in self.scopes:
            raise ScopeError(f"作用域 {scope!r} 不存在或已释放")

    def _effect(
        self,
        scope: ScopeKey | None,
        action: Callable[[_Layer[T]], Callable[[], None]],
        *,
        notify: bool,
    ) -> Disposer:
        """把一次同步层变更挂到作用域名下：失败回收新建的空层，撤销后回收空层并通知。"""
        created = False
        if scope is None:
            layer = self._global
        else:
            self._require_scope(scope)
            existing = self._scoped.get(scope)
            if existing is None:
                layer = _Layer()
                self._scoped[scope] = layer
                created = True
            else:
                layer = existing
        try:
            undo = action(layer)
        except Exception:
            if scope is not None and created and layer.is_empty():
                del self._scoped[scope]
            raise

        def teardown() -> None:
            undo()
            if scope is not None and layer.is_empty() and self._scoped.get(scope) is layer:
                del self._scoped[scope]
            if notify:
                self._notify()

        disposer = _once(teardown) if scope is None else self.scopes.effect(scope, teardown)
        if notify:
            self._notify()
        return disposer

    def _notify(self) -> None:
        if self._on_change is not None:
            self._on_change()
