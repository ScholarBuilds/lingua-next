"""工具运行时：注册表、作用域可见性与 pre → guard → around → post → result 执行管线。

翻译自 deepseek-harness（TypeScript）：

- ``packages/core/tools/src/index.ts`` :142-208 事件签名、:211-302 ToolDefinition、
  :379-421 ToolRunContext、:556-601 决策类型、:1037-1128 register/restrict/guard、
  :1152-1206 view、:1463-1560 prepare/execute、:1569-1676 dispatch/finish、
  :1689-1862 serviceAsk/createSuccessResult/postExecute
- ``packages/core/tools/src/schema.ts`` :449-458 参数→schema、:545-617 defineTool/validateArgs

Code Mode（run_code 传输、ts-types/py-types SDK 渲染）不在翻译范围。

Python 化的取舍：

- 参数与输出用 pydantic 模型替代 JSON Schema 规格。``input.model_json_schema()`` 去掉
  title/default 噪音后就是发给模型的 parameters；输入校验在 pre-execute 之前完成，失败
  直接落为 is_error 结果（TS 里是工具体内抛 ToolArgsError，再经 post-execute）。
- 取消信号用 ``asyncio.Event``。around 包装器可替换 ``exec.cancel``，运行时把调用方事件
  与替换事件熔合后交给工具体，调用方取消永远不会被包装器脱开；工具体结束后恢复原事件。
- ``timeout_ms`` 由运行时在工具体外直接施加（TS 由独立的 timeout-policy 插件实现），
  超时会取消工具体协程并落为 ``TIMEOUT`` 错误。
- 层存储复用 :class:`domain.kernel.events.ScopedLayers`：工具按名注册，守卫以自增键
  注册，求值顺序与 TS 一致（全局 → 远祖先 → 近祖先 → 本 scope）。
- 拒绝 / 阻断结果在 TS 里只有 message，这里额外带 ``DENIED`` / ``BLOCKED`` 错误码，
  方便 agent loop 路由。
"""

from __future__ import annotations

import asyncio
import itertools
import json
import logging
import uuid
import weakref
from collections.abc import Awaitable, Callable, Iterable, Mapping
from dataclasses import dataclass, field, replace
from functools import cached_property
from types import MappingProxyType
from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel, ConfigDict, ValidationError, field_validator

from domain.kernel.events import Disposer, EventBus, ScopedLayers, ScopeKey
from domain.kernel.llm_types import ContentBlock, Message, TextBlock, ToolSchema

if TYPE_CHECKING:
    from domain.kernel.approval import ApprovalService

logger = logging.getLogger(__name__)

# 错误码。前五个与 TS 常量一一对应，TIMEOUT / DENIED / BLOCKED 为 Python 版新增
TOOL_ABORTED = "ABORTED"
TOOL_ABORTED_BEFORE_DISPATCH = "ABORTED_BEFORE_DISPATCH"
TOOL_UNKNOWN = "UNKNOWN_TOOL"
TOOL_INVALID_ARGS = "INVALID_ARGS"
TOOL_INVALID_OUTPUT = "INVALID_TOOL_OUTPUT"
TOOL_TIMEOUT = "TIMEOUT"
TOOL_DENIED = "DENIED"
TOOL_BLOCKED = "BLOCKED"

ExecutionMode = Literal["parallel", "exclusive"]
RuntimeKind = Literal["inline", "task"]
TypedRefKind = Literal["image", "video", "audio", "file", "text"]

_REF_PREFIXES = ("asset:", "media:", "text:")
_SCHEMA_MAPS = frozenset({"properties", "$defs", "definitions", "patternProperties"})
_SCHEMA_NOISE = frozenset({"title", "default"})


# ---------------------------------------------------------------------------
# 异常
# ---------------------------------------------------------------------------


class ToolRuntimeError(Exception):
    """带路由码的运行时异常；``code`` 会进入 :class:`ToolError`。"""

    def __init__(self, message: str, code: str) -> None:
        super().__init__(message)
        self.code = code


class ToolNotFoundError(ToolRuntimeError):
    """模型点名的工具在该作用域不可见。"""

    def __init__(self, name: str) -> None:
        super().__init__(f'unknown tool "{name}"', TOOL_UNKNOWN)


class ToolArgsError(ToolRuntimeError):
    """模型给出的参数不符合 input 模型。"""

    def __init__(self, violations: list[str]) -> None:
        super().__init__("invalid arguments: " + "; ".join(violations), TOOL_INVALID_ARGS)
        self.violations = violations


class ToolOutputError(ToolRuntimeError):
    """工具体或 post-execute 替换的值不符合 output 模型，或投影函数失败。"""

    def __init__(self, name: str, violations: list[str]) -> None:
        super().__init__(
            f'tool "{name}" returned invalid output: ' + "; ".join(violations),
            TOOL_INVALID_OUTPUT,
        )
        self.violations = violations


class ToolTimeoutError(ToolRuntimeError):
    """工具体超过 ``timeout_ms`` 未返回。"""

    def __init__(self, name: str, timeout_ms: float) -> None:
        super().__init__(f'tool "{name}" timed out after {timeout_ms:g} ms', TOOL_TIMEOUT)


# ---------------------------------------------------------------------------
# 输出基类
# ---------------------------------------------------------------------------


class TypedRef(BaseModel):
    """工具输出里 ``items`` 元素的基类：以引用而非内联数据指向资产。

    ``ref`` 形如 ``asset:N`` / ``media:N`` / ``text:<id>``；``asset_id`` /
    ``media_asset_id`` 是解析后的数字 id，供落库与渲染直接使用。
    """

    model_config = ConfigDict(frozen=True)

    kind: TypedRefKind
    ref: str
    asset_id: int | None = None
    media_asset_id: int | None = None

    @field_validator("ref")
    @classmethod
    def _check_ref(cls, value: str) -> str:
        if not value.startswith(_REF_PREFIXES):
            raise ValueError(f"ref 必须以 {'/'.join(_REF_PREFIXES)} 开头，收到 {value!r}")
        return value


# ---------------------------------------------------------------------------
# 结果与执行上下文
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ToolError:
    """失败详情：``message`` 面向模型，``name`` / ``code`` 供策略与诊断路由。"""

    message: str
    name: str | None = None
    code: str | None = None


@dataclass(frozen=True, eq=False)
class ToolResult:
    """一次工具调用的最终结果；成功时 ``value`` 是 output 模型实例，失败时为 None。"""

    call_id: str
    name: str
    value: BaseModel | None
    content: list[ContentBlock]
    is_error: bool
    error: ToolError | None
    meta: dict[str, Any] = field(default_factory=dict)
    additional_contexts: list[Message] = field(default_factory=list)
    concludes_turn: bool = False


@dataclass(eq=False)
class ToolRunContext:
    """管线内的一次待执行调用。

    ``arguments`` 是经 JSON 快照并深冻结的参数；``cancel`` 在 around 阶段可被包装器替换，
    其余字段只读。``tools/result`` 派发前整个对象被冻结，之后任何属性赋值都抛错。
    """

    call_id: str
    root_call_id: str
    name: str
    arguments: Mapping[str, Any]
    scope: ScopeKey | None
    agent_id: str | None
    parent_call_id: str | None
    cancel: asyncio.Event
    token: str
    deferred: list[Message] = field(default_factory=list)
    _concludes_turn: bool = field(default=False, init=False, repr=False)
    _frozen: bool = field(default=False, init=False, repr=False)

    def __setattr__(self, name: str, value: Any) -> None:
        if self.__dict__.get("_frozen", False):
            raise AttributeError(f"ToolRunContext 已冻结（tools/result 之后），不能再赋值 {name!r}")
        object.__setattr__(self, name, value)

    def defer_context(self, message: Message) -> None:
        """把一条上下文挂到本次调用的结果上，agent loop 在 tool/result 之后再追加。"""
        self.deferred.append(message)

    def conclude_turn(self) -> None:
        """把成功结果标记为本轮终止；只有权威的成功结果才能终止外层运行。"""
        self._concludes_turn = True

    @property
    def concludes_turn(self) -> bool:
        return self._concludes_turn

    def _freeze(self) -> None:
        object.__setattr__(self, "_frozen", True)


# ---------------------------------------------------------------------------
# 决策类型（数据，不是回调）
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Allow:
    kind: Literal["allow"] = "allow"


@dataclass(frozen=True)
class Deny:
    reason: str
    kind: Literal["deny"] = "deny"


@dataclass(frozen=True)
class Ask:
    reason: str | None = None
    kind: Literal["ask"] = "ask"


PreToolDecision = Allow | Deny | Ask
ALLOW = Allow()


@dataclass(frozen=True)
class Accept:
    """接受结果；``value`` 与 ``content`` 至多替换一个，``additional_contexts`` 追加到结果上。"""

    value: BaseModel | None = None
    content: list[ContentBlock] | None = None
    additional_contexts: list[Message] | None = None
    kind: Literal["accept"] = "accept"


@dataclass(frozen=True)
class Block:
    """阻断结果：``feedback`` 成为错误内容，工具体延迟的上下文被丢弃。"""

    feedback: list[ContentBlock]
    additional_contexts: list[Message] | None = None
    kind: Literal["block"] = "block"


PostToolDecision = Accept | Block
ACCEPT = Accept()


# ---------------------------------------------------------------------------
# 工具定义
# ---------------------------------------------------------------------------

ExecuteFn = Callable[[Any, ToolRunContext], Awaitable[Any]]
RenderFn = Callable[[Any, Any], list[ContentBlock]]
PresentationMetaFn = Callable[[Any, Any], dict[str, Any]]
ToolGuard = Callable[[ToolRunContext], str | None]


@dataclass(frozen=True, eq=False)
class ToolDefinition:
    """一个已注册工具：schema（由 input 模型派生）+ 执行函数 + 可选的投影与呈现回调。

    - ``execute(args, exec)``：``args`` 是校验过的 input 实例，返回 output 实例或其 dict。
    - ``render(args, value)``：把输出投影成模型可见的内容块；缺省为 JSON 文本块。
    - ``presentation_meta(args, value)``：UI 回放用的纯投影，只对顶层调用计算。
    - ``concurrency_safe``：``True`` 或返回 ``True`` 的分类器才允许与兄弟调用并行。
    - ``present_call`` / ``present_result``：UI 呈现回调，参数对不上 schema 时软失败。
    """

    name: str
    description: str
    input: type[BaseModel]
    output: type[BaseModel]
    execute: ExecuteFn
    timeout_ms: float | None = None
    concurrency_safe: bool | Callable[[Any], bool] = False
    render: RenderFn | None = None
    presentation_meta: PresentationMetaFn | None = None
    present_call: Callable[[Any], Any] | None = None
    present_result: Callable[[Any, ToolResult], Any] | None = None
    runtime_kind: RuntimeKind = "inline"

    def __post_init__(self) -> None:
        if not self.name:
            raise ValueError("工具名不能为空")
        for label, model in (("input", self.input), ("output", self.output)):
            if not (isinstance(model, type) and issubclass(model, BaseModel)):
                raise TypeError(f'tool "{self.name}" 的 {label} 必须是 pydantic BaseModel 子类')
        if not callable(self.execute):
            raise TypeError(f'tool "{self.name}" 的 execute 必须可调用')
        if self.timeout_ms is not None and not (
            isinstance(self.timeout_ms, int | float)
            and self.timeout_ms > 0
            and self.timeout_ms != float("inf")
        ):
            raise ValueError(f'tool "{self.name}" 的 timeout_ms 必须是正数')
        if self.runtime_kind not in ("inline", "task"):
            raise ValueError(f'tool "{self.name}" 的 runtime_kind 必须是 inline 或 task')

    @cached_property
    def parameters(self) -> dict[str, Any]:
        """发给模型的 JSON Schema：去掉 pydantic 生成的 title 与 default 噪音。"""
        stripped: dict[str, Any] = _strip_schema_noise(self.input.model_json_schema())
        return stripped

    def schema(self) -> dict[str, Any]:
        """OpenAI function 格式，只含 name / description / parameters。"""
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }

    def tool_schema(self) -> ToolSchema:
        """llm_types 的 :class:`ToolSchema` 视图，供 GenerateOptions.tools 直接使用。"""
        return ToolSchema(name=self.name, description=self.description, parameters=self.parameters)

    def call_view(self, arguments: Mapping[str, Any]) -> Any | None:
        """待执行状态的 UI 视图；参数对不上 schema（回放旧日志）时返回 None 而不抛。"""
        if self.present_call is None:
            return None
        args = self._soft_args(arguments)
        return None if args is None else self.present_call(args)

    def result_view(self, arguments: Mapping[str, Any], result: ToolResult) -> Any | None:
        """完成状态的 UI 视图；同样软校验参数。"""
        if self.present_result is None:
            return None
        args = self._soft_args(arguments)
        return None if args is None else self.present_result(args, result)

    def _soft_args(self, arguments: Mapping[str, Any]) -> BaseModel | None:
        try:
            return self.input.model_validate(plain_arguments(arguments))
        except ValidationError:
            return None


def tool(
    name: str,
    *,
    description: str,
    input: type[BaseModel],
    output: type[BaseModel],
    timeout_ms: float | None = None,
    concurrency_safe: bool | Callable[[Any], bool] = False,
    render: RenderFn | None = None,
    presentation_meta: PresentationMetaFn | None = None,
    present_call: Callable[[Any], Any] | None = None,
    present_result: Callable[[Any, ToolResult], Any] | None = None,
    runtime_kind: RuntimeKind = "inline",
) -> Callable[[ExecuteFn], ToolDefinition]:
    """把 ``async def execute(args, exec)`` 包成 :class:`ToolDefinition`（对应 TS defineTool）。"""

    def wrap(execute: ExecuteFn) -> ToolDefinition:
        return ToolDefinition(
            name=name,
            description=description,
            input=input,
            output=output,
            execute=execute,
            timeout_ms=timeout_ms,
            concurrency_safe=concurrency_safe,
            render=render,
            presentation_meta=presentation_meta,
            present_call=present_call,
            present_result=present_result,
            runtime_kind=runtime_kind,
        )

    return wrap


# ---------------------------------------------------------------------------
# 调度器视图（agent loop 的并行调度器按阶段调用）
# ---------------------------------------------------------------------------


@dataclass(frozen=True, eq=False)
class ScheduledPreparation:
    """prepare 阶段的产物：``dispatch`` 进入 around/工具体；``post-result`` 仍要过
    post-execute；``final-result`` 直接收尾。"""

    kind: Literal["dispatch", "post-result", "final-result"]
    exec: ToolRunContext
    result: ToolResult | None = None


@dataclass(frozen=True, eq=False)
class ScheduledDispatch:
    kind: Literal["post-result", "final-result"]
    result: ToolResult


@dataclass(eq=False)
class _ExecState:
    """放在包装器可见对象之外的执行状态：原始取消事件、解析到的定义、校验后的参数。"""

    caller_cancel: asyncio.Event
    definition: ToolDefinition | None
    args: BaseModel | None
    body_invoked: bool = False


# ---------------------------------------------------------------------------
# 运行时
# ---------------------------------------------------------------------------


class ToolRuntime:
    """工具注册表与执行管线。作用域注册遮蔽全局；一套可见性解析同时喂给 schema、查找与执行。

    执行顺序固定：冻结参数 + 校验 input → ``tools/pre-execute``（waterfall，终端 allow）
    → ask 走审批 → 守卫 → ``tools/execute``（around，终端是工具体）→ 校验 output + render
    → ``tools/post-execute``（waterfall，终端 accept）→ 冻结 → ``tools/result``（emit）。
    工具体与监听器抛出的异常都落为 is_error 结果，``execute`` 本身不抛。
    """

    def __init__(self, bus: EventBus, approval: ApprovalService | None = None) -> None:
        self.bus = bus
        self.approval = approval
        self._tools: ScopedLayers[ToolDefinition] = ScopedLayers(
            bus.scopes, on_change=self._emit_change
        )
        self._guards: ScopedLayers[ToolGuard] = ScopedLayers(bus.scopes)
        self._guard_seq = itertools.count(1)
        self._states: weakref.WeakKeyDictionary[ToolRunContext, _ExecState] = (
            weakref.WeakKeyDictionary()
        )
        # 由本运行时为某次执行归一化过的结果 → 那次执行的 token
        self._canonical: weakref.WeakKeyDictionary[ToolResult, str] = weakref.WeakKeyDictionary()

    # ---- 注册 ----

    def register(self, definition: ToolDefinition, *, scope: ScopeKey | None = None) -> Disposer:
        """全局或按作用域注册；作用域内遮蔽同名全局工具，同层重名抛 DuplicateEntryError。"""
        if not isinstance(definition, ToolDefinition):
            raise TypeError("register 只接受 ToolDefinition（用 @tool 构造）")
        return self._tools.set(definition.name, definition, scope)

    def restrict(
        self,
        scope: ScopeKey | None,
        allow: Iterable[str] | None = None,
        deny: Iterable[str] | None = None,
    ) -> Disposer:
        """限制作用域能看到的继承面（全局 + 祖先层）；本 scope 自己注册的工具不受影响。"""
        return self._tools.restrict(scope, allow, deny)

    def guard(self, fn: ToolGuard, scope: ScopeKey | None = None) -> Disposer:
        """注册单调守卫：在 pre-execute 之后、工具体之前求值，只能返回拒绝理由，不能放行。"""
        if not callable(fn):
            raise TypeError("guard 必须可调用")
        return self._guards.set(f"guard#{next(self._guard_seq)}", fn, scope, notify=False)

    # ---- 读 ----

    def view(self, scope: ScopeKey | None = None) -> dict[str, ToolDefinition]:
        """``scope`` 视角下可见的工具（限制已应用、作用域遮蔽已生效）。"""
        return self._tools.view(scope)

    def get(self, name: str, scope: ScopeKey | None = None) -> ToolDefinition | None:
        return self._tools.get(name, scope)

    def schemas(self, scope: ScopeKey | None = None) -> list[dict[str, Any]]:
        """OpenAI function 格式的工具清单，只含 name / description / parameters。"""
        return [definition.schema() for definition in self.view(scope).values()]

    def tool_schemas(self, scope: ScopeKey | None = None) -> list[ToolSchema]:
        return [definition.tool_schema() for definition in self.view(scope).values()]

    def execution_mode(
        self,
        name: str,
        arguments: Mapping[str, Any],
        *,
        scope: ScopeKey | None = None,
    ) -> ExecutionMode:
        """并行调度分类：只有 ``concurrency_safe`` 为 True 或分类器返回 True 才并行，
        未知工具、参数不合法、分类器抛错一律独占。"""
        definition = self.get(name, scope)
        if definition is None:
            return "exclusive"
        safe = definition.concurrency_safe
        if isinstance(safe, bool):
            return "parallel" if safe else "exclusive"
        try:
            args = definition.input.model_validate(plain_arguments(arguments))
            return "parallel" if safe(args) is True else "exclusive"
        except Exception:
            return "exclusive"

    # ---- 执行 ----

    async def execute(
        self,
        name: str,
        arguments: Mapping[str, Any],
        *,
        scope: ScopeKey | None = None,
        cancel: asyncio.Event | None = None,
        agent_id: str | None = None,
        parent_call_id: str | None = None,
        call_id: str | None = None,
        root_call_id: str | None = None,
    ) -> ToolResult:
        """跑完整管线并返回最终结果（与 ``tools/result`` 监听器收到的是同一个对象）。

        进入之后到结果物化之前的取消：工具体未开始 → ``ABORTED_BEFORE_DISPATCH``；
        已开始则等它跑完，再把成功结果换成 ``ABORTED``（工具自带的结构化错误保留）。
        """
        prepared = await self.scheduler_prepare(
            name,
            arguments,
            scope=scope,
            cancel=cancel,
            agent_id=agent_id,
            parent_call_id=parent_call_id,
            call_id=call_id,
            root_call_id=root_call_id,
        )
        return await self._complete(prepared)

    async def _complete(self, prepared: ScheduledPreparation) -> ToolResult:
        if prepared.kind == "dispatch":
            dispatched = await self.scheduler_dispatch(prepared.exec)
            if dispatched.kind == "post-result":
                return await self.scheduler_finalize(prepared.exec, dispatched.result)
            return self.scheduler_finish(prepared.exec, dispatched.result)
        assert prepared.result is not None
        if prepared.kind == "post-result":
            return await self.scheduler_finalize(prepared.exec, prepared.result)
        return self.scheduler_finish(prepared.exec, prepared.result)

    async def scheduler_prepare(
        self,
        name: str,
        arguments: Mapping[str, Any],
        *,
        scope: ScopeKey | None = None,
        cancel: asyncio.Event | None = None,
        agent_id: str | None = None,
        parent_call_id: str | None = None,
        call_id: str | None = None,
        root_call_id: str | None = None,
    ) -> ScheduledPreparation:
        """物化参数、校验 input，跑有序的 pre-execute / 审批 / 守卫，决定下一阶段。"""
        exec, failed = self._create_execution(
            name,
            arguments,
            scope=scope,
            cancel=cancel,
            agent_id=agent_id,
            parent_call_id=parent_call_id,
            call_id=call_id,
            root_call_id=root_call_id,
        )
        if failed is not None:
            return failed
        if self._caller_cancelled(exec):
            return ScheduledPreparation(
                "final-result", exec, _aborted_before_dispatch_result(exec)
            )
        try:
            gate = await self.bus.waterfall(
                "tools/pre-execute", exec, scope=exec.scope, terminal=_allow_terminal
            )
            decision, approval_cancelled = await self._resolve_gate(exec, gate)
            if self._caller_cancelled(exec) and approval_cancelled:
                return ScheduledPreparation(
                    "post-result", exec, _aborted_before_dispatch_result(exec)
                )
            reason = self._guard_reason(exec) if decision.kind == "allow" else decision.reason
            if reason is not None:
                return ScheduledPreparation("post-result", exec, _denied_result(exec, reason))
            if self._caller_cancelled(exec):
                return ScheduledPreparation(
                    "post-result", exec, _aborted_before_dispatch_result(exec)
                )
            return ScheduledPreparation("dispatch", exec)
        except Exception as error:
            return ScheduledPreparation("final-result", exec, _error_result(exec, error))

    async def scheduler_dispatch(self, exec: ToolRunContext) -> ScheduledDispatch:
        """跑 around 包装器与工具体。工具失败与未知工具仍要过 post-execute；管线失败直接收尾。"""
        try:

            async def body(*_: Any) -> ToolResult:
                return await self._dispatch_body(exec)

            raw = await self.bus.waterfall(
                "tools/execute", exec, scope=exec.scope, terminal=body
            )
            normalized = self._normalize_dispatch_result(exec, raw)
            if exec.deferred:
                normalized = self._mark_canonical(
                    exec,
                    replace(
                        normalized,
                        additional_contexts=[*exec.deferred, *normalized.additional_contexts],
                    ),
                )
            if self._caller_cancelled(exec) and not normalized.is_error:
                normalized = self._cancellation_result(exec, normalized)
            return ScheduledDispatch("post-result", normalized)
        except Exception as error:
            return ScheduledDispatch("final-result", _error_result(exec, error))

    async def scheduler_finalize(self, exec: ToolRunContext, result: ToolResult) -> ToolResult:
        """跑有序的 post-execute，再物化并通知最终结果。"""
        try:
            post = await self._post_execute(exec, result)
            if self._caller_cancelled(exec) and not post.is_error:
                post = self._cancellation_result(exec, post)
            return self.scheduler_finish(exec, post)
        except Exception as error:
            return self.scheduler_finish(exec, _error_result(exec, error))

    def scheduler_finish(self, exec: ToolRunContext, result: ToolResult) -> ToolResult:
        """物化最终结果、冻结执行对象、派发 ``tools/result``（监听器异常被吞掉记日志）。"""
        final = _materialize(exec, result)
        exec._freeze()
        self._states.pop(exec, None)
        try:
            self.bus.emit("tools/result", exec, final, scope=exec.scope)
        except Exception:
            logger.exception('tool "%s" (%s): tools/result 派发失败', exec.name, exec.call_id)
        return final

    # ---- 管线内部 ----

    def _create_execution(
        self,
        name: str,
        arguments: Mapping[str, Any],
        *,
        scope: ScopeKey | None,
        cancel: asyncio.Event | None,
        agent_id: str | None,
        parent_call_id: str | None,
        call_id: str | None,
        root_call_id: str | None,
    ) -> tuple[ToolRunContext, ScheduledPreparation | None]:
        """铸造执行对象：参数 JSON 快照 + 深冻结，再按 input 模型校验。

        未知工具不在这里拒绝：让 pre-execute 监听器看到每一个到达注册表的名字，
        到 dispatch 阶段才报 ``UNKNOWN_TOOL``（与 TS 一致）。
        """
        resolved_call_id = call_id or uuid.uuid4().hex
        base: dict[str, Any] = {
            "call_id": resolved_call_id,
            "root_call_id": root_call_id or resolved_call_id,
            "name": name,
            "scope": scope,
            "agent_id": agent_id,
            "parent_call_id": parent_call_id,
            "cancel": cancel if cancel is not None else asyncio.Event(),
            "token": uuid.uuid4().hex,
        }
        definition = self.get(name, scope)
        try:
            snapshot = _json_snapshot(arguments)
            if not isinstance(snapshot, dict):
                raise TypeError("tool execution arguments must be a JSON object")
        except (TypeError, ValueError) as error:
            exec = ToolRunContext(arguments=MappingProxyType({}), **base)
            self._states[exec] = _ExecState(base["cancel"], definition, None)
            return exec, ScheduledPreparation("final-result", exec, _error_result(exec, error))
        exec = ToolRunContext(arguments=_deep_freeze(snapshot), **base)
        state = _ExecState(base["cancel"], definition, None)
        self._states[exec] = state
        if definition is None:
            return exec, None
        try:
            state.args = definition.input.model_validate(snapshot)
        except ValidationError as error:
            failure = _error_result(exec, ToolArgsError(_violations(error)))
            return exec, ScheduledPreparation("post-result", exec, failure)
        return exec, None

    async def _resolve_gate(
        self, exec: ToolRunContext, gate: Any
    ) -> tuple[Allow | Deny, bool]:
        """把 pre-execute 的决策收敛为 allow/deny；ask 经审批席位裁决。"""
        if isinstance(gate, Allow | Deny):
            return gate, False
        if isinstance(gate, Ask):
            return await self._service_ask(exec, gate)
        raise TypeError(f"tools/pre-execute 监听器必须返回 Allow/Deny/Ask，收到 {gate!r}")

    async def _service_ask(self, exec: ToolRunContext, ask: Ask) -> tuple[Allow | Deny, bool]:
        """审批席位缺席时按 'unavailable' 处理（fail closed）；四种结果一一映射，
        三种非放行各带不同理由，让模型分得清"人拒绝了"和"没有审批通道"。"""
        name = exec.name
        unavailable = f'tool "{name}" requires approval, but no approval channel is available'
        if self.approval is None:
            suffix = f": {ask.reason}" if ask.reason else ""
            return Deny(unavailable + suffix), False
        reason = ask.reason or f'tool "{name}" requires approval'
        outcome = await self.approval.request(exec, reason)
        if outcome == "allowed-once":
            return ALLOW, False
        if outcome == "rejected":
            return Deny(f'the user rejected tool "{name}"'), False
        if outcome == "cancelled":
            return Deny(f'approval for tool "{name}" was cancelled'), True
        if outcome == "unavailable":
            return Deny(unavailable), False
        raise TypeError(f"审批席位返回了未知结果 {outcome!r}")

    def _guard_reason(self, exec: ToolRunContext) -> str | None:
        """全局守卫先于作用域链（远祖先在前），第一个拒绝理由即生效。"""
        for guard in self._guards.view(exec.scope).values():
            reason = guard(exec)
            if reason is not None:
                return reason
        return None

    async def _dispatch_body(self, exec: ToolRunContext) -> ToolResult:
        """把调用方取消事件熔合回包装器的替换事件后跑工具体；取消不会丢弃已启动的工具体。"""
        state = self._state(exec)
        wrapper_cancel = exec.cancel
        fused, dispose = _fuse_cancel(state.caller_cancel, wrapper_cancel)
        if fused.is_set():
            dispose()
            return _aborted_before_dispatch_result(exec)
        exec.cancel = fused
        try:
            definition = self._resolve_for_body(exec, state)
            state.body_invoked = True
            returned = await self._run_body(definition, state, exec, fused)
            result = self._create_success_result(exec, definition, returned)
            return _aborted_result(exec, result) if fused.is_set() else result
        except Exception as error:
            return _error_result(exec, error)
        finally:
            dispose()
            exec.cancel = wrapper_cancel

    def _resolve_for_body(self, exec: ToolRunContext, state: _ExecState) -> ToolDefinition:
        definition = self.get(exec.name, exec.scope)
        if definition is None:
            raise ToolNotFoundError(exec.name)
        if state.args is None or definition is not state.definition:
            # prepare 之后定义被换过（重注册）：按现在可执行的那个重新校验参数
            try:
                state.args = definition.input.model_validate(plain_arguments(exec.arguments))
            except ValidationError as error:
                raise ToolArgsError(_violations(error)) from error
            state.definition = definition
        return definition

    async def _run_body(
        self,
        definition: ToolDefinition,
        state: _ExecState,
        exec: ToolRunContext,
        fused: asyncio.Event,
    ) -> Any:
        coro = definition.execute(state.args, exec)
        if definition.timeout_ms is None:
            return await coro
        try:
            return await asyncio.wait_for(coro, timeout=definition.timeout_ms / 1000)
        except TimeoutError as error:
            fused.set()
            raise ToolTimeoutError(definition.name, definition.timeout_ms) from error

    def _create_success_result(
        self, exec: ToolRunContext, definition: ToolDefinition, candidate: Any
    ) -> ToolResult:
        """校验 output、render 成内容块、按需计算 presentation_meta，并标记为本次执行的规范结果。"""
        state = self._state(exec)
        try:
            value = definition.output.model_validate(candidate)
        except ValidationError as error:
            raise ToolOutputError(definition.name, _violations(error)) from error
        args = state.args
        try:
            content = (
                definition.render(args, value)
                if definition.render is not None
                else [TextBlock(text=value.model_dump_json())]
            )
        except Exception as error:
            raise ToolOutputError(
                definition.name, [f"render failed: {_error_message(error)}"]
            ) from error
        if not isinstance(content, list):
            raise ToolOutputError(definition.name, ["render must return a list of content blocks"])
        meta: dict[str, Any] = {}
        if exec.parent_call_id is None and definition.presentation_meta is not None:
            try:
                projected = _json_snapshot(definition.presentation_meta(args, value))
            except Exception as error:
                raise ToolOutputError(
                    definition.name, [f"presentation_meta failed: {_error_message(error)}"]
                ) from error
            if not isinstance(projected, dict):
                raise ToolOutputError(definition.name, ["presentation_meta must return a dict"])
            meta = projected
        return self._mark_canonical(
            exec,
            ToolResult(
                call_id=exec.call_id,
                name=exec.name,
                value=value,
                content=list(content),
                is_error=False,
                error=None,
                meta=meta,
                additional_contexts=[],
                concludes_turn=exec.concludes_turn,
            ),
        )

    def _normalize_dispatch_result(self, exec: ToolRunContext, raw: Any) -> ToolResult:
        """around 包装器自己造的结果要过一遍 output 合同；本次执行已归一化的直接放行。"""
        if isinstance(raw, ToolResult) and self._canonical.get(raw) == exec.token:
            return raw
        if not isinstance(raw, ToolResult):
            raise TypeError(f"tools/execute 包装器必须返回 ToolResult，收到 {raw!r}")
        if raw.is_error:
            return self._mark_canonical(
                exec, replace(raw, call_id=exec.call_id, name=exec.name, value=None)
            )
        definition = self.get(exec.name, exec.scope)
        if definition is None:
            raise ToolNotFoundError(exec.name)
        normalized = self._create_success_result(exec, definition, raw.value)
        return self._mark_canonical(
            exec, replace(normalized, additional_contexts=list(raw.additional_contexts))
        )

    async def _post_execute(self, exec: ToolRunContext, result: ToolResult) -> ToolResult:
        """跑 ``tools/post-execute`` 并应用决策：accept 保留成功（可换 value 或 content），
        block 变成 is_error 且内容为 feedback。工具体延迟的上下文在 accept 时保留，
        block 时丢弃——阻断只暴露决策自己给的上下文。"""
        decision = await self.bus.waterfall(
            "tools/post-execute", exec, result, scope=exec.scope, terminal=_accept_terminal
        )
        if not isinstance(decision, Accept | Block):
            raise TypeError(f"tools/post-execute 监听器必须返回 Accept/Block，收到 {decision!r}")
        decision_contexts = list(decision.additional_contexts or [])
        if isinstance(decision, Block):
            message = _failure_message_from_content(decision.feedback)
            return self._mark_canonical(
                exec,
                ToolResult(
                    call_id=exec.call_id,
                    name=exec.name,
                    value=None,
                    content=list(decision.feedback),
                    is_error=True,
                    error=ToolError(message, name="ToolBlocked", code=TOOL_BLOCKED),
                    additional_contexts=decision_contexts,
                ),
            )
        if decision.value is not None and decision.content is not None:
            raise TypeError("tools/post-execute 的 accept 不能同时替换 value 和 content")
        contexts = [*result.additional_contexts, *decision_contexts]
        if decision.value is not None:
            if result.is_error:
                raise TypeError("tools/post-execute 不能替换失败结果的 value")
            definition = self.get(exec.name, exec.scope)
            if definition is None:
                raise ToolNotFoundError(exec.name)
            replaced = self._create_success_result(exec, definition, decision.value)
            return self._mark_canonical(exec, replace(replaced, additional_contexts=contexts))
        return self._mark_canonical(
            exec,
            replace(
                result,
                content=list(decision.content) if decision.content is not None else result.content,
                additional_contexts=contexts,
            ),
        )

    def _mark_canonical(self, exec: ToolRunContext, result: ToolResult) -> ToolResult:
        self._canonical[result] = exec.token
        return result

    def _state(self, exec: ToolRunContext) -> _ExecState:
        state = self._states.get(exec)
        if state is None:
            raise RuntimeError("调度器不变量被破坏：执行对象不是本运行时 prepare 出来的")
        return state

    def _caller_cancelled(self, exec: ToolRunContext) -> bool:
        return self._state(exec).caller_cancel.is_set()

    def _cancellation_result(self, exec: ToolRunContext, prior: ToolResult) -> ToolResult:
        if self._state(exec).body_invoked:
            return _aborted_result(exec, prior)
        return _aborted_before_dispatch_result(exec, prior)

    def _emit_change(self) -> None:
        try:
            self.bus.emit("tools/change")
        except Exception:
            logger.exception("tools/change 派发失败")


# ---------------------------------------------------------------------------
# 模块级工具函数
# ---------------------------------------------------------------------------


async def _allow_terminal(*_: Any) -> PreToolDecision:
    return ALLOW


async def _accept_terminal(*_: Any) -> PostToolDecision:
    return ACCEPT


def plain_arguments(arguments: Mapping[str, Any]) -> dict[str, Any]:
    """把冻结参数还原成普通 dict / list（校验、日志、落库用）。"""
    thawed: dict[str, Any] = _thaw(arguments)
    return thawed


def _thaw(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {key: _thaw(item) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return [_thaw(item) for item in value]
    return value


def _json_snapshot(value: Any) -> Any:
    """无损 JSON 快照：既做深拷贝，也拒绝 NaN / 不可序列化的值。"""
    return json.loads(json.dumps(value, allow_nan=False))


def _deep_freeze(value: Any) -> Any:
    if isinstance(value, dict):
        return MappingProxyType({key: _deep_freeze(item) for key, item in value.items()})
    if isinstance(value, list):
        return tuple(_deep_freeze(item) for item in value)
    return value


def _strip_schema_noise(node: Any, *, is_map: bool = False) -> Any:
    """去掉 pydantic schema 里的 title / default；``properties`` / ``$defs`` 的键是字段名，
    不能当成 schema 关键字剥掉。"""
    if isinstance(node, dict):
        out: dict[str, Any] = {}
        for key, item in node.items():
            if not is_map and key in _SCHEMA_NOISE:
                continue
            out[key] = _strip_schema_noise(item, is_map=(not is_map and key in _SCHEMA_MAPS))
        return out
    if isinstance(node, list):
        return [_strip_schema_noise(item) for item in node]
    return node


def _violations(error: ValidationError) -> list[str]:
    return [
        f"{'.'.join(str(part) for part in item['loc']) or '<root>'}: {item['msg']}"
        for item in error.errors()
    ]


def _error_message(error: BaseException) -> str:
    try:
        return str(error) or type(error).__name__
    except Exception:
        return "<unprintable thrown value>"


def _error_result(exec: ToolRunContext, error: BaseException) -> ToolResult:
    message = _error_message(error)
    code = getattr(error, "code", None)
    return ToolResult(
        call_id=exec.call_id,
        name=exec.name,
        value=None,
        content=[TextBlock(text=f"Error: {message}")],
        is_error=True,
        error=ToolError(
            message,
            name=type(error).__name__,
            code=code if isinstance(code, str) else None,
        ),
    )


def _denied_result(exec: ToolRunContext, reason: str) -> ToolResult:
    return ToolResult(
        call_id=exec.call_id,
        name=exec.name,
        value=None,
        content=[TextBlock(text=f"Error: {reason}")],
        is_error=True,
        error=ToolError(reason, name="ToolDenied", code=TOOL_DENIED),
    )


def _aborted_result(exec: ToolRunContext, prior: ToolResult | None = None) -> ToolResult:
    """工具体已启动之后被取消：成功结果被替换，延迟的上下文保留。"""
    return ToolResult(
        call_id=exec.call_id,
        name=exec.name,
        value=None,
        content=[TextBlock(text="Error: tool call aborted")],
        is_error=True,
        error=ToolError("tool call aborted", name="AbortError", code=TOOL_ABORTED),
        additional_contexts=list(prior.additional_contexts) if prior is not None else [],
    )


def _aborted_before_dispatch_result(
    exec: ToolRunContext, prior: ToolResult | None = None
) -> ToolResult:
    return ToolResult(
        call_id=exec.call_id,
        name=exec.name,
        value=None,
        content=[TextBlock(text="Error: tool call aborted before dispatch")],
        is_error=True,
        error=ToolError(
            "tool call aborted before dispatch",
            name="AbortError",
            code=TOOL_ABORTED_BEFORE_DISPATCH,
        ),
        additional_contexts=list(prior.additional_contexts) if prior is not None else [],
    )


def _materialize(exec: ToolRunContext, result: ToolResult) -> ToolResult:
    """最终提交前物化一次：身份字段以执行对象为准，容器字段复制一份不再共享。"""
    return replace(
        result,
        call_id=exec.call_id,
        name=exec.name,
        content=list(result.content),
        meta=dict(result.meta),
        additional_contexts=list(result.additional_contexts),
    )


def _failure_message_from_content(content: list[ContentBlock]) -> str:
    parts: list[str] = []
    for block in content:
        block_type = getattr(block, "type", None)
        if block_type == "text":
            parts.append(getattr(block, "text", ""))
        else:
            parts.append(f"[{block_type} content]")
    text = "\n".join(parts)
    return text if text else "tool result blocked by post-execute policy"


def _noop() -> None:
    return None


def _fuse_cancel(
    caller: asyncio.Event, wrapper: asyncio.Event
) -> tuple[asyncio.Event, Callable[[], None]]:
    """把调用方与包装器的取消事件熔合成一个：任一触发即触发；dispose 收掉中继任务。"""
    if caller is wrapper:
        return caller, _noop
    fused = asyncio.Event()
    if caller.is_set() or wrapper.is_set():
        fused.set()
        return fused, _noop

    async def relay(source: asyncio.Event) -> None:
        await source.wait()
        fused.set()

    tasks = [asyncio.create_task(relay(caller)), asyncio.create_task(relay(wrapper))]

    def dispose() -> None:
        for task in tasks:
            if not task.done():
                task.cancel()

    return fused, dispose


__all__ = [
    "ACCEPT",
    "ALLOW",
    "TOOL_ABORTED",
    "TOOL_ABORTED_BEFORE_DISPATCH",
    "TOOL_BLOCKED",
    "TOOL_DENIED",
    "TOOL_INVALID_ARGS",
    "TOOL_INVALID_OUTPUT",
    "TOOL_TIMEOUT",
    "TOOL_UNKNOWN",
    "Accept",
    "Allow",
    "Ask",
    "Block",
    "Deny",
    "ExecutionMode",
    "PostToolDecision",
    "PreToolDecision",
    "RuntimeKind",
    "ScheduledDispatch",
    "ScheduledPreparation",
    "ToolArgsError",
    "ToolDefinition",
    "ToolError",
    "ToolGuard",
    "ToolNotFoundError",
    "ToolOutputError",
    "ToolResult",
    "ToolRunContext",
    "ToolRuntime",
    "ToolRuntimeError",
    "ToolTimeoutError",
    "TypedRef",
    "plain_arguments",
    "tool",
]
