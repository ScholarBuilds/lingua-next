"""内核事件总线 / 作用域链 / 分层注册表的不变量测试。

不碰数据库、不发网络；覆盖 domain/kernel/events.py 从 TS 翻译过来的每条约定。
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from domain.kernel.events import (
    DuplicateEntryError,
    EventBus,
    KernelError,
    ScopedLayers,
    ScopeError,
    Scopes,
    is_bailed,
)

# ---------------------------------------------------------------------------
# Scopes
# ---------------------------------------------------------------------------


def test_scopes_chain_parent_and_labels():
    scopes = Scopes()
    preset = scopes.create(label="preset")
    agent = scopes.create(preset, label="agent")
    child = scopes.create(agent)

    assert preset.startswith("preset#")
    assert agent.startswith("agent#")
    assert scopes.parent(agent) == preset
    assert scopes.parent(preset) is None
    assert scopes.chain(child) == [child, agent, preset]
    assert scopes.chain(None) == []
    # 未登记的键只含自身，不报错
    assert scopes.chain("ghost") == ["ghost"]
    assert preset in scopes and "ghost" not in scopes


def test_scopes_create_under_unknown_parent_raises():
    scopes = Scopes()
    with pytest.raises(ScopeError):
        scopes.create("ghost")


def test_scopes_rebind_rejects_cycles_and_moves_subtree():
    scopes = Scopes()
    preset_a = scopes.create(label="a")
    preset_b = scopes.create(label="b")
    agent = scopes.create(preset_a, label="agent")
    child = scopes.create(agent, label="child")

    with pytest.raises(ScopeError, match="环"):
        scopes.rebind(preset_a, agent)
    with pytest.raises(ScopeError, match="环"):
        scopes.rebind(agent, child)
    with pytest.raises(ScopeError, match="环"):
        scopes.rebind(agent, agent)

    scopes.rebind(agent, preset_b)
    assert scopes.chain(child) == [child, agent, preset_b]
    scopes.rebind(agent, None)
    assert scopes.chain(child) == [child, agent]


def test_scopes_dispose_cascades_children_first_and_runs_effects_lifo():
    scopes = Scopes()
    parent = scopes.create(label="parent")
    child = scopes.create(parent, label="child")
    order: list[str] = []
    scopes.effect(parent, lambda: order.append("parent-1"))
    scopes.effect(parent, lambda: order.append("parent-2"))
    scopes.effect(child, lambda: order.append("child-1"))
    removed = scopes.effect(child, lambda: order.append("child-early"))

    removed()
    removed()  # 幂等
    assert order == ["child-early"]

    scopes.dispose(parent)
    assert order == ["child-early", "child-1", "parent-2", "parent-1"]
    assert parent not in scopes and child not in scopes
    assert scopes.chain(child) == [child]  # 释放后父链断开
    scopes.dispose(parent)  # 重复释放忽略
    with pytest.raises(ScopeError):
        scopes.effect(child, lambda: None)


def test_scopes_dispose_isolates_failing_effects(caplog):
    scopes = Scopes()
    key = scopes.create()
    ran: list[str] = []
    scopes.effect(key, lambda: ran.append("first"))

    def boom() -> None:
        raise RuntimeError("撤销失败")

    scopes.effect(key, boom)
    scopes.effect(key, lambda: ran.append("last"))
    scopes.dispose(key)
    assert ran == ["last", "first"]
    assert "撤销失败" in caplog.text


# ---------------------------------------------------------------------------
# EventBus：注册与退订
# ---------------------------------------------------------------------------


def test_on_returns_idempotent_disposer():
    bus = EventBus()
    seen: list[int] = []
    dispose = bus.on("ping", seen.append)
    assert bus.listeners("ping") == 1
    bus.emit("ping", 1)
    dispose()
    dispose()
    bus.emit("ping", 2)
    assert seen == [1]
    assert bus.listeners("ping") == 0


def test_same_callback_registered_twice_disposes_independently():
    bus = EventBus()
    seen: list[int] = []
    first = bus.on("ping", seen.append)
    bus.on("ping", seen.append)
    first()
    bus.emit("ping", 1)
    assert seen == [1]


def test_prepend_orders_listener_first():
    bus = EventBus()
    order: list[str] = []
    bus.on("ev", lambda: order.append("a"))
    bus.on("ev", lambda: order.append("b"))
    bus.on("ev", lambda: order.append("front"), prepend=True)
    bus.emit("ev")
    assert order == ["front", "a", "b"]


def test_once_fires_a_single_time():
    bus = EventBus()
    seen: list[int] = []
    bus.once("ev", seen.append)
    bus.emit("ev", 1)
    bus.emit("ev", 2)
    assert seen == [1]
    assert bus.listeners("ev") == 0


def test_on_with_unknown_scope_raises():
    bus = EventBus()
    with pytest.raises(ScopeError):
        bus.on("ev", lambda: None, scope="ghost")


# ---------------------------------------------------------------------------
# EventBus：emit
# ---------------------------------------------------------------------------


async def test_emit_runs_sync_and_async_listeners_and_isolates_errors(caplog):
    bus = EventBus()
    seen: list[str] = []

    def sync_ok(x: int) -> None:
        seen.append(f"sync:{x}")

    def sync_boom(x: int) -> None:
        raise RuntimeError("同步炸了")

    async def async_ok(x: int) -> None:
        await asyncio.sleep(0)
        seen.append(f"async:{x}")

    async def async_boom(x: int) -> None:
        raise RuntimeError("异步炸了")

    bus.on("ev", sync_boom)
    bus.on("ev", sync_ok)
    bus.on("ev", async_boom)
    bus.on("ev", async_ok)

    bus.emit("ev", 7)
    # emit 不等待异步回调
    assert seen == ["sync:7"]
    await bus.drain()
    assert seen == ["sync:7", "async:7"]
    assert "同步炸了" in caplog.text
    assert "异步炸了" in caplog.text


def test_emit_without_running_loop_runs_coroutine_inline():
    bus = EventBus()
    seen: list[int] = []

    async def listener(x: int) -> None:
        seen.append(x)

    bus.on("ev", listener)
    bus.emit("ev", 3)
    assert seen == [3]


def test_listener_list_is_snapshotted_per_dispatch():
    bus = EventBus()
    seen: list[str] = []

    def adder() -> None:
        seen.append("adder")
        bus.on("ev", lambda: seen.append("late"))

    bus.on("ev", adder)
    bus.emit("ev")
    assert seen == ["adder"]
    bus.emit("ev")
    # 第二次分发的快照里只有第一次挂上的 late；本次新增的要等下一次
    assert seen == ["adder", "adder", "late"]


def test_internal_dispatch_fires_for_public_events_only():
    bus = EventBus()
    trace: list[tuple[Any, ...]] = []
    bus.on("internal/dispatch", lambda *a: trace.append(a))
    bus.on("tools/result", lambda *_: None)
    scope = bus.scopes.create()

    bus.emit("tools/result", 1, 2, scope=scope)
    bus.emit("internal/other")
    assert trace == [("emit", "tools/result", (1, 2), scope)]


# ---------------------------------------------------------------------------
# EventBus：serial / bail / parallel
# ---------------------------------------------------------------------------


def test_is_bailed_treats_only_none_as_pass():
    assert not is_bailed(None)
    assert is_bailed(False)
    assert is_bailed(0)
    assert is_bailed("")


async def test_serial_returns_first_non_none_and_stops():
    bus = EventBus()
    calls: list[str] = []

    def first(x: int) -> None:
        calls.append("first")

    async def second(x: int) -> Any:
        calls.append("second")
        return False

    async def third(x: int) -> Any:
        calls.append("third")
        return "never"

    bus.on("decide", first)
    bus.on("decide", second)
    bus.on("decide", third)
    assert await bus.serial("decide", 1) is False
    assert calls == ["first", "second"]


async def test_serial_without_result_returns_none():
    bus = EventBus()
    bus.on("decide", lambda: None)
    assert await bus.serial("decide") is None
    assert await bus.serial("nobody") is None


def test_bail_sync_first_result_and_rejects_async():
    bus = EventBus()
    bus.on("pick", lambda: None)
    bus.on("pick", lambda: "hit")
    bus.on("pick", lambda: "late")
    assert bus.bail("pick") == "hit"

    async def coro() -> str:
        return "x"

    bus.on("pick2", coro)
    with pytest.raises(TypeError):
        bus.bail("pick2")


async def test_parallel_awaits_everyone_and_aggregates_failures():
    bus = EventBus()
    seen: list[str] = []

    async def slow() -> None:
        await asyncio.sleep(0.01)
        seen.append("slow")

    def fast() -> None:
        seen.append("fast")

    async def boom_a() -> None:
        raise ValueError("a")

    def boom_b() -> None:
        raise ValueError("b")

    bus.on("ev", slow)
    bus.on("ev", fast)
    await bus.parallel("ev")
    assert sorted(seen) == ["fast", "slow"]

    bus.on("ev", boom_a)
    bus.on("ev", boom_b)
    with pytest.raises(ExceptionGroup) as info:
        await bus.parallel("ev")
    assert sorted(str(e) for e in info.value.exceptions) == ["a", "b"]


# ---------------------------------------------------------------------------
# EventBus：waterfall
# ---------------------------------------------------------------------------


async def test_waterfall_next_rewrites_args_and_terminal_sees_final_args():
    bus = EventBus()
    order: list[str] = []

    async def outer(call: dict[str, Any], *, next: Any) -> Any:
        order.append("outer-in")
        result = await next({**call, "outer": True})
        order.append("outer-out")
        return {"wrapped": result}

    async def inner(call: dict[str, Any], *, next: Any) -> Any:
        order.append("inner-in")
        result = await next({**call, "inner": True})
        order.append("inner-out")
        return result

    async def terminal(call: dict[str, Any]) -> str:
        order.append("terminal")
        assert call == {"id": 1, "outer": True, "inner": True}
        return "done"

    bus.on("tools/execute", outer)
    bus.on("tools/execute", inner)
    result = await bus.waterfall("tools/execute", {"id": 1}, terminal=terminal)
    assert result == {"wrapped": "done"}
    assert order == ["outer-in", "inner-in", "terminal", "inner-out", "outer-out"]


async def test_waterfall_short_circuits_when_next_is_not_called():
    bus = EventBus()
    terminal_called = False

    async def veto(call: Any, *, next: Any) -> str:
        return "denied"

    async def after(call: Any, *, next: Any) -> Any:
        raise AssertionError("短路后不应进入")

    async def terminal(call: Any) -> str:
        nonlocal terminal_called
        terminal_called = True
        return "ran"

    bus.on("ev", veto)
    bus.on("ev", after)
    assert await bus.waterfall("ev", 1, terminal=terminal) == "denied"
    assert terminal_called is False


async def test_waterfall_next_without_args_keeps_current_args_and_accepts_sync_parts():
    bus = EventBus()

    def sync_listener(a: int, b: int, *, next: Any) -> Any:
        return next()

    async def rewrite(a: int, b: int, *, next: Any) -> Any:
        return await next(a * 10, b * 10)

    def passthrough(a: int, b: int, *, next: Any) -> Any:
        return next()

    def terminal(a: int, b: int) -> int:
        return a + b

    bus.on("ev", sync_listener)
    bus.on("ev", rewrite)
    bus.on("ev", passthrough)
    assert await bus.waterfall("ev", 1, 2, terminal=terminal) == 30


async def test_waterfall_without_listeners_calls_terminal_directly():
    bus = EventBus()

    async def terminal(x: int) -> int:
        return x + 1

    assert await bus.waterfall("nobody", 41, terminal=terminal) == 42


# ---------------------------------------------------------------------------
# EventBus：作用域过滤
# ---------------------------------------------------------------------------


def test_scope_filter_flows_up_the_chain_never_down():
    scopes = Scopes()
    bus = EventBus(scopes)
    preset = scopes.create(label="preset")
    agent = scopes.create(preset, label="agent")
    other = scopes.create(label="other")
    seen: list[str] = []

    bus.on("probe", lambda: seen.append("untagged"))
    bus.on("probe", lambda: seen.append("preset"), scope=preset)
    bus.on("probe", lambda: seen.append("agent"), scope=agent)
    bus.on("probe", lambda: seen.append("other"), scope=other)

    # 在 agent 键分发：自身与祖先收到，兄弟根不收
    bus.emit("probe", scope=agent)
    assert sorted(seen) == ["agent", "preset", "untagged"]

    # 在 preset 键分发：agent 在分发键之下，不收
    seen.clear()
    bus.emit("probe", scope=preset)
    assert sorted(seen) == ["preset", "untagged"]

    # 不带 scope 分发：只有无标签监听器
    seen.clear()
    bus.emit("probe")
    assert seen == ["untagged"]


def test_scope_filter_applies_to_every_dispatch_mode():
    scopes = Scopes()
    bus = EventBus(scopes)
    parent = scopes.create()
    child = scopes.create(parent)
    bus.on("pick", lambda: "parent", scope=parent)
    bus.on("pick", lambda: "child", scope=child, prepend=True)

    assert bus.bail("pick", scope=child) == "child"
    assert bus.bail("pick", scope=parent) == "parent"
    assert bus.bail("pick") is None


async def test_global_listener_bypasses_scope_filter_but_dies_with_scope():
    scopes = Scopes()
    bus = EventBus(scopes)
    observer = scopes.create(label="observer")
    other = scopes.create(label="other")
    seen: list[str] = []
    bus.on("probe", lambda: seen.append("global"), scope=observer, global_=True)

    bus.emit("probe", scope=other)
    bus.emit("probe")
    assert seen == ["global", "global"]

    scopes.dispose(observer)
    bus.emit("probe", scope=other)
    assert seen == ["global", "global"]
    assert bus.listeners("probe") == 0


def test_scope_dispose_removes_owned_listeners_and_descendants():
    scopes = Scopes()
    bus = EventBus(scopes)
    preset = scopes.create(label="preset")
    agent = scopes.create(preset, label="agent")
    seen: list[str] = []
    bus.on("probe", lambda: seen.append("untagged"))
    bus.on("probe", lambda: seen.append("preset"), scope=preset)
    dispose_agent_listener = bus.on("probe", lambda: seen.append("agent"), scope=agent)

    scopes.dispose(preset)
    assert bus.listeners("probe") == 1
    dispose_agent_listener()  # 已随作用域释放，再调无副作用
    bus.emit("probe", scope=agent)  # 已释放的键：只剩无标签监听器
    assert seen == ["untagged"]


# ---------------------------------------------------------------------------
# ScopedLayers
# ---------------------------------------------------------------------------


def _layers() -> tuple[Scopes, ScopedLayers[str], list[int]]:
    scopes = Scopes()
    changes: list[int] = []
    layers: ScopedLayers[str] = ScopedLayers(scopes, on_change=lambda: changes.append(1))
    return scopes, layers, changes


def test_layers_global_set_get_view_and_duplicate():
    _, layers, changes = _layers()
    dispose = layers.set("read", "global-read")
    layers.set("write", "global-write")
    assert layers.get("read") == "global-read"
    assert layers.get("missing") is None
    assert list(layers.view()) == ["read", "write"]
    assert len(changes) == 2
    with pytest.raises(DuplicateEntryError):
        layers.set("read", "again")
    dispose()
    dispose()
    assert layers.get("read") is None
    assert layers.view() == {"write": "global-write"}
    assert len(changes) == 3


def test_layers_nearer_scope_shadows_and_order_is_preserved():
    scopes, layers, _ = _layers()
    preset = scopes.create(label="preset")
    agent = scopes.create(preset, label="agent")
    layers.set("a", "g-a")
    layers.set("shared", "g-shared")
    layers.set("shared", "p-shared", scope=preset)
    layers.set("p-only", "p-only", scope=preset)
    layers.set("shared", "a-shared", scope=agent)
    layers.set("c", "a-c", scope=agent)

    assert layers.get("shared", scope=agent) == "a-shared"
    assert layers.get("shared", scope=preset) == "p-shared"
    assert layers.get("shared") == "g-shared"
    assert layers.get("p-only", scope=agent) == "p-only"
    assert layers.get("c", scope=preset) is None
    assert list(layers.view(agent).items()) == [
        ("a", "g-a"),
        ("shared", "a-shared"),
        ("p-only", "p-only"),
        ("c", "a-c"),
    ]
    assert layers.view(preset) == {"a": "g-a", "shared": "p-shared", "p-only": "p-only"}
    assert layers.view() == {"a": "g-a", "shared": "g-shared"}
    assert layers.own(agent) == {"shared": "a-shared", "c": "a-c"}
    assert layers.own(None) == {"a": "g-a", "shared": "g-shared"}
    # 读取不创建层
    ghost = scopes.create()
    assert layers.view(ghost) == {"a": "g-a", "shared": "g-shared"}
    assert layers.has_layer(ghost) is False


def test_layers_dispose_restores_and_reclaims_empty_layer():
    scopes, layers, changes = _layers()
    agent = scopes.create()
    layers.set("shared", "g")
    undo_shared = layers.set("shared", "a", scope=agent)
    undo_extra = layers.set("extra", "x", scope=agent)
    assert layers.has_layer(agent)
    assert layers.get("shared", scope=agent) == "a"

    undo_shared()
    assert layers.get("shared", scope=agent) == "g"
    assert layers.has_layer(agent)  # 还有 extra
    undo_extra()
    assert layers.has_layer(agent) is False
    assert layers.view(agent) == {"shared": "g"}
    assert len(changes) == 5


def test_layers_failed_action_reclaims_created_layer_only():
    scopes, layers, _ = _layers()
    agent = scopes.create()
    layers.set("x", "1", scope=agent)
    with pytest.raises(DuplicateEntryError):
        layers.set("x", "2", scope=agent)
    assert layers.has_layer(agent)  # 既有层不因失败被丢弃

    fresh = scopes.create()
    layers.set("dup", "g")
    layers.set("dup", "ok-shadow", scope=fresh)  # 跨层同名是遮蔽，不是重复
    assert layers.get("dup", scope=fresh) == "ok-shadow"


def test_layers_set_with_unknown_scope_raises():
    _, layers, _ = _layers()
    with pytest.raises(ScopeError):
        layers.set("x", "1", scope="ghost")


def test_restrict_filters_inherited_surface_not_own_registrations():
    scopes, layers, _ = _layers()
    preset = scopes.create(label="preset")
    agent = scopes.create(preset, label="agent")
    layers.set("read", "g-read")
    layers.set("write", "g-write")
    layers.set("shell", "g-shell")
    layers.set("preset-tool", "p-tool", scope=preset)
    layers.set("report", "a-report", scope=agent)
    layers.set("write", "a-write", scope=agent)

    dispose = layers.restrict(agent, allow={"read", "preset-tool"})
    # 继承面只剩 allow 的；本 scope 自己注册的 report / write 不受影响
    assert layers.view(agent) == {
        "read": "g-read",
        "write": "a-write",
        "preset-tool": "p-tool",
        "report": "a-report",
    }
    assert layers.get("shell", scope=agent) is None
    assert layers.get("write", scope=agent) == "a-write"
    assert layers.get("report", scope=agent) == "a-report"
    # 祖先与全局视图不受子作用域限制影响
    assert "shell" in layers.view(preset)
    assert "shell" in layers.view()

    dispose()
    assert layers.get("shell", scope=agent) == "g-shell"
    assert layers.has_layer(agent)  # 层里还有自己的条目


def test_restrict_intersects_along_the_chain():
    scopes, layers, _ = _layers()
    preset = scopes.create(label="preset")
    agent = scopes.create(preset, label="agent")
    for name in ("a", "b", "c"):
        layers.set(name, f"g-{name}")

    layers.restrict(preset, deny={"a"})
    layers.restrict(agent, allow={"a", "b"})
    # preset 去掉 a，agent 只留 a/b → 交集是 b
    assert layers.view(agent) == {"b": "g-b"}
    assert layers.view(preset) == {"b": "g-b", "c": "g-c"}
    assert layers.get("a", scope=agent) is None
    assert layers.get("c", scope=agent) is None


def test_restrict_deny_and_allow_combined_in_one_call():
    scopes, layers, _ = _layers()
    agent = scopes.create()
    for name in ("a", "b", "c"):
        layers.set(name, f"g-{name}")
    layers.restrict(agent, allow={"a", "b"}, deny={"b"})
    assert layers.view(agent) == {"a": "g-a"}


def test_restrict_validates_scope_filter_and_names():
    scopes, layers, _ = _layers()
    agent = scopes.create()
    layers.set("read", "g")
    layers.set("mine", "own", scope=agent)

    with pytest.raises(ScopeError):
        layers.restrict(None, allow={"read"})
    with pytest.raises(ScopeError):
        layers.restrict("ghost", allow={"read"})
    with pytest.raises(ValueError):
        layers.restrict(agent)
    # 本 scope 自己注册的与不存在的名字都不可限制
    with pytest.raises(KernelError, match="mine"):
        layers.restrict(agent, deny={"mine"})
    with pytest.raises(KernelError, match="typo"):
        layers.restrict(agent, allow={"read", "typo"})


def test_restriction_only_layer_is_reclaimed_on_dispose():
    scopes, layers, _ = _layers()
    agent = scopes.create()
    layers.set("read", "g")
    dispose = layers.restrict(agent, deny={"read"})
    assert layers.has_layer(agent)
    assert layers.view(agent) == {}
    dispose()
    assert layers.has_layer(agent) is False
    assert layers.view(agent) == {"read": "g"}


def test_scope_dispose_drops_layer_contributions_and_restrictions():
    scopes, layers, _ = _layers()
    preset = scopes.create(label="preset")
    agent = scopes.create(preset, label="agent")
    layers.set("read", "g")
    layers.set("own", "a", scope=agent)
    layers.restrict(agent, deny={"read"})
    layers.set("p", "p", scope=preset)

    scopes.dispose(agent)
    assert layers.has_layer(agent) is False
    assert layers.view(preset) == {"read": "g", "p": "p"}

    scopes.dispose(preset)
    assert layers.has_layer(preset) is False
    assert layers.view() == {"read": "g"}


def test_notify_can_be_suppressed_per_registration():
    _, layers, changes = _layers()
    dispose = layers.set("quiet", "1", notify=False)
    dispose()
    assert changes == []
    layers.set("loud", "1")
    assert changes == [1]


def test_bus_and_layers_share_one_scopes_instance():
    scopes = Scopes()
    bus = EventBus(scopes)
    layers: ScopedLayers[str] = ScopedLayers(scopes)
    agent = scopes.create(label="agent")
    seen: list[str] = []
    bus.on("tools/changed", lambda: seen.append("bus"), scope=agent)
    layers.set("tool", "t", scope=agent)

    scopes.dispose(agent)
    assert bus.listeners("tools/changed") == 0
    assert layers.has_layer(agent) is False
