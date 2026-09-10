"""ToolRuntime / @tool / 审批席位的不变量测试。

覆盖 tools/src/index.ts 与 user-approval 翻译过来的每一条合同：schema 投影、输入输出校验、
pre-execute 三种决策、守卫单调拒绝、around 包装器的取消熔合、超时、post-execute 的
accept/block、tools/result 的异常隔离、作用域遮蔽与限制、并行分类。不碰库、不发网络。
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import pytest
from pydantic import BaseModel, Field

from domain.kernel.approval import DefaultApproval
from domain.kernel.events import DuplicateEntryError, EventBus, KernelError, ScopeError
from domain.kernel.llm_types import PluginSource, TextBlock, create_user_message
from domain.kernel.tool_runtime import (
    ACCEPT,
    ALLOW,
    TOOL_ABORTED,
    TOOL_ABORTED_BEFORE_DISPATCH,
    TOOL_BLOCKED,
    TOOL_DENIED,
    TOOL_INVALID_ARGS,
    TOOL_INVALID_OUTPUT,
    TOOL_TIMEOUT,
    TOOL_UNKNOWN,
    Accept,
    Ask,
    Block,
    Deny,
    ToolDefinition,
    ToolError,
    ToolResult,
    ToolRunContext,
    ToolRuntime,
    TypedRef,
    plain_arguments,
    tool,
)

# ---------------------------------------------------------------------------
# 夹具与公用工具
# ---------------------------------------------------------------------------


class EchoArgs(BaseModel):
    text: str
    times: int = 1


class EchoOut(BaseModel):
    echoed: str


class Other(BaseModel):
    other: int = 0


@tool("echo", description="重复文本", input=EchoArgs, output=EchoOut)
async def echo(args: EchoArgs, exec: ToolRunContext) -> EchoOut:
    return EchoOut(echoed=args.text * args.times)


def user_message(text: str) -> Any:
    return create_user_message(content=[TextBlock(text=text)], source=PluginSource(plugin="t"))


@pytest.fixture
def bus() -> EventBus:
    return EventBus()


@pytest.fixture
def runtime(bus: EventBus) -> ToolRuntime:
    rt = ToolRuntime(bus)
    rt.register(echo)
    return rt


class FakeApproval:
    def __init__(self, outcome: str) -> None:
        self.outcome = outcome
        self.calls: list[tuple[str, str]] = []

    async def request(self, exec: ToolRunContext, reason: str) -> Any:
        self.calls.append((exec.name, reason))
        return self.outcome


# ---------------------------------------------------------------------------
# @tool 与 schema
# ---------------------------------------------------------------------------


def test_tool_decorator_builds_definition_and_openai_schema(runtime: ToolRuntime) -> None:
    class Inner(BaseModel):
        a: int = Field(description="内层字段")

    class Args(BaseModel):
        q: str
        inner: Inner
        n: int = 3
        opt: str | None = None
        title: str = "字段名恰好叫 title"

    @tool("nested", description="嵌套参数", input=Args, output=EchoOut)
    async def nested(args: Args, exec: ToolRunContext) -> EchoOut:
        return EchoOut(echoed=args.q)

    assert isinstance(nested, ToolDefinition)
    runtime.register(nested)

    schema = next(s for s in runtime.schemas() if s["function"]["name"] == "nested")
    assert schema["type"] == "function"
    fn = schema["function"]
    assert fn["description"] == "嵌套参数"
    params = fn["parameters"]
    assert "title" not in params
    assert params["required"] == ["q", "inner"]
    props = params["properties"]
    assert props["q"] == {"type": "string"}
    assert props["n"] == {"type": "integer"}
    assert "default" not in props["opt"] and "title" not in props["opt"]
    assert props["inner"] == {"$ref": "#/$defs/Inner"}
    assert "title" in props, "字段名叫 title 的属性不能被当噪音剥掉"
    inner = params["$defs"]["Inner"]
    assert "title" not in inner
    assert inner["properties"]["a"] == {"description": "内层字段", "type": "integer"}

    ts = runtime.tool_schemas()
    assert {t.name for t in ts} == {"echo", "nested"}


def test_tool_definition_rejects_bad_config() -> None:
    async def run(args: Any, exec: ToolRunContext) -> Any:
        return EchoOut(echoed="x")

    with pytest.raises(ValueError):
        tool("bad", description="", input=EchoArgs, output=EchoOut, timeout_ms=0)(run)
    with pytest.raises(TypeError):
        tool("bad", description="", input=dict, output=EchoOut)(run)  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        tool("", description="", input=EchoArgs, output=EchoOut)(run)


def test_typed_ref_validates_prefix() -> None:
    TypedRef(kind="image", ref="asset:12", asset_id=12)
    TypedRef(kind="text", ref="text:abc")
    with pytest.raises(ValueError):
        TypedRef(kind="image", ref="12")


def test_present_call_soft_validation() -> None:
    @tool(
        "viewed",
        description="",
        input=EchoArgs,
        output=EchoOut,
        present_call=lambda args: {"card": args.text},
        present_result=lambda args, result: {"ok": not result.is_error},
    )
    async def viewed(args: EchoArgs, exec: ToolRunContext) -> EchoOut:
        return EchoOut(echoed=args.text)

    assert viewed.call_view({"text": "hi"}) == {"card": "hi"}
    assert viewed.call_view({"bogus": 1}) is None
    result = ToolResult("c", "viewed", None, [], False, None)
    assert viewed.result_view({"text": "hi"}, result) == {"ok": True}
    assert viewed.result_view({}, result) is None


# ---------------------------------------------------------------------------
# 输入 / 输出校验
# ---------------------------------------------------------------------------


async def test_invalid_arguments_become_error_result_without_raising(
    runtime: ToolRuntime, bus: EventBus
) -> None:
    seen_post: list[ToolResult] = []
    seen_result: list[ToolResult] = []

    async def post(exec: ToolRunContext, result: ToolResult, next: Any) -> Any:
        seen_post.append(result)
        return await next()

    bus.on("tools/post-execute", post)
    bus.on("tools/result", lambda exec, result: seen_result.append(result))

    result = await runtime.execute("echo", {"times": "many"})
    assert result.is_error
    assert result.error is not None and result.error.code == TOOL_INVALID_ARGS
    assert "text" in result.error.message and "times" in result.error.message
    assert result.content[0].text.startswith("Error: invalid arguments")
    assert seen_post and seen_post[0].is_error
    assert seen_result == [result]


async def test_non_json_arguments_fail_before_policy(runtime: ToolRuntime, bus: EventBus) -> None:
    hits: list[str] = []

    async def pre(exec: ToolRunContext, next: Any) -> Any:
        hits.append("pre")
        return await next()

    bus.on("tools/pre-execute", pre)
    result = await runtime.execute("echo", {"text": float("nan")})
    assert result.is_error and hits == []


async def test_unknown_tool_reports_unknown_code(runtime: ToolRuntime, bus: EventBus) -> None:
    hits: list[str] = []

    async def pre(exec: ToolRunContext, next: Any) -> Any:
        hits.append(exec.name)
        return await next()

    bus.on("tools/pre-execute", pre)
    result = await runtime.execute("nope", {})
    assert result.is_error
    assert result.error is not None and result.error.code == TOOL_UNKNOWN
    assert hits == ["nope"], "未知工具也要让 pre-execute 监听器看到"


async def test_output_validation_failure(runtime: ToolRuntime) -> None:
    @tool("bad_out", description="", input=EchoArgs, output=EchoOut)
    async def bad_out(args: EchoArgs, exec: ToolRunContext) -> Any:
        return {"wrong": 1}

    @tool("wrong_model", description="", input=EchoArgs, output=EchoOut)
    async def wrong_model(args: EchoArgs, exec: ToolRunContext) -> Any:
        return Other()

    runtime.register(bad_out)
    runtime.register(wrong_model)
    for name in ("bad_out", "wrong_model"):
        result = await runtime.execute(name, {"text": "x"})
        assert result.is_error and result.value is None
        assert result.error is not None and result.error.code == TOOL_INVALID_OUTPUT


async def test_output_dict_is_validated_and_rendered_as_json_text(runtime: ToolRuntime) -> None:
    @tool("dict_out", description="", input=EchoArgs, output=EchoOut)
    async def dict_out(args: EchoArgs, exec: ToolRunContext) -> Any:
        return {"echoed": args.text}

    runtime.register(dict_out)
    result = await runtime.execute("dict_out", {"text": "hi"})
    assert not result.is_error
    assert isinstance(result.value, EchoOut) and result.value.echoed == "hi"
    assert result.content == [TextBlock(text='{"echoed":"hi"}')]


async def test_custom_render_and_presentation_meta(runtime: ToolRuntime) -> None:
    @tool(
        "rendered",
        description="",
        input=EchoArgs,
        output=EchoOut,
        render=lambda args, value: [TextBlock(text=f"{args.text}->{value.echoed}")],
        presentation_meta=lambda args, value: {"len": len(value.echoed)},
    )
    async def rendered(args: EchoArgs, exec: ToolRunContext) -> EchoOut:
        return EchoOut(echoed=args.text.upper())

    runtime.register(rendered)
    top = await runtime.execute("rendered", {"text": "ab"})
    assert top.content == [TextBlock(text="ab->AB")]
    assert top.meta == {"len": 2}

    nested = await runtime.execute("rendered", {"text": "ab"}, parent_call_id="outer")
    assert nested.meta == {}, "presentation_meta 只对顶层调用计算"


async def test_render_exception_is_invalid_output(runtime: ToolRuntime) -> None:
    def boom(args: Any, value: Any) -> Any:
        raise RuntimeError("render broke")

    @tool("boom_render", description="", input=EchoArgs, output=EchoOut, render=boom)
    async def boom_render(args: EchoArgs, exec: ToolRunContext) -> EchoOut:
        return EchoOut(echoed="x")

    runtime.register(boom_render)
    result = await runtime.execute("boom_render", {"text": "x"})
    assert result.is_error
    assert result.error is not None and result.error.code == TOOL_INVALID_OUTPUT
    assert "render broke" in result.error.message


# ---------------------------------------------------------------------------
# pre-execute：deny / ask / 审批
# ---------------------------------------------------------------------------


async def test_pre_execute_deny(runtime: ToolRuntime, bus: EventBus) -> None:
    ran: list[str] = []

    @tool("tracked", description="", input=EchoArgs, output=EchoOut)
    async def tracked(args: EchoArgs, exec: ToolRunContext) -> EchoOut:
        ran.append(args.text)
        return EchoOut(echoed=args.text)

    runtime.register(tracked)

    async def deny(exec: ToolRunContext, next: Any) -> Any:
        return Deny("not today")

    bus.on("tools/pre-execute", deny)
    result = await runtime.execute("tracked", {"text": "x"})
    assert result.is_error and ran == []
    assert result.error == ToolError("not today", name="ToolDenied", code=TOOL_DENIED)
    assert result.content == [TextBlock(text="Error: not today")]


async def test_pre_execute_ask_without_approval_denies(runtime: ToolRuntime, bus: EventBus) -> None:
    async def ask(exec: ToolRunContext, next: Any) -> Any:
        return Ask("needs a human")

    bus.on("tools/pre-execute", ask)
    result = await runtime.execute("echo", {"text": "x"})
    assert result.is_error
    assert result.error is not None and result.error.code == TOOL_DENIED
    assert "no approval channel" in result.error.message
    assert "needs a human" in result.error.message


async def test_pre_execute_ask_allowed_once_runs(bus: EventBus) -> None:
    approval = FakeApproval("allowed-once")
    runtime = ToolRuntime(bus, approval)
    runtime.register(echo)

    async def ask(exec: ToolRunContext, next: Any) -> Any:
        return Ask()

    bus.on("tools/pre-execute", ask)
    result = await runtime.execute("echo", {"text": "ok"})
    assert not result.is_error and result.value == EchoOut(echoed="ok")
    assert approval.calls == [("echo", 'tool "echo" requires approval')]


@pytest.mark.parametrize(
    ("outcome", "fragment"),
    [
        ("rejected", "the user rejected"),
        ("cancelled", "was cancelled"),
        ("unavailable", "no approval channel"),
    ],
)
async def test_pre_execute_ask_non_grant_outcomes_deny(
    bus: EventBus, outcome: str, fragment: str
) -> None:
    runtime = ToolRuntime(bus, FakeApproval(outcome))
    runtime.register(echo)
    bus.on("tools/pre-execute", lambda exec, next: Ask("why"))
    result = await runtime.execute("echo", {"text": "x"})
    assert result.is_error
    assert result.error is not None and result.error.code == TOOL_DENIED
    assert fragment in result.error.message


async def test_pre_execute_short_circuit_and_chain_order(
    runtime: ToolRuntime, bus: EventBus
) -> None:
    order: list[str] = []

    async def first(exec: ToolRunContext, next: Any) -> Any:
        order.append("first")
        decision = await next()
        order.append("first-after")
        return decision

    async def second(exec: ToolRunContext, next: Any) -> Any:
        order.append("second")
        return ALLOW

    bus.on("tools/pre-execute", first)
    bus.on("tools/pre-execute", second)
    result = await runtime.execute("echo", {"text": "x"})
    assert not result.is_error
    assert order == ["first", "second", "first-after"]


async def test_pre_execute_rogue_decision_is_pipeline_error(
    runtime: ToolRuntime, bus: EventBus
) -> None:
    bus.on("tools/pre-execute", lambda exec, next: "yes")
    result = await runtime.execute("echo", {"text": "x"})
    assert result.is_error and result.error is not None and result.error.name == "TypeError"


# ---------------------------------------------------------------------------
# 守卫
# ---------------------------------------------------------------------------


async def test_guard_denies_monotonically_and_respects_scope(
    runtime: ToolRuntime, bus: EventBus
) -> None:
    scope_a = bus.scopes.create()
    scope_b = bus.scopes.create(scope_a)
    scope_c = bus.scopes.create()

    runtime.guard(lambda exec: None)
    dispose = runtime.guard(lambda exec: "blocked in A", scope_a)
    # 后注册的守卫不能把前面的拒绝翻成放行
    runtime.guard(lambda exec: None, scope_a)

    denied = await runtime.execute("echo", {"text": "x"}, scope=scope_a)
    assert denied.is_error and denied.error is not None
    assert denied.error.message == "blocked in A" and denied.error.code == TOOL_DENIED

    inherited = await runtime.execute("echo", {"text": "x"}, scope=scope_b)
    assert inherited.is_error, "子作用域继承祖先守卫"

    assert not (await runtime.execute("echo", {"text": "x"}, scope=scope_c)).is_error
    assert not (await runtime.execute("echo", {"text": "x"})).is_error

    dispose()
    assert not (await runtime.execute("echo", {"text": "x"}, scope=scope_a)).is_error


async def test_guard_runs_after_pre_execute_allow(runtime: ToolRuntime, bus: EventBus) -> None:
    order: list[str] = []

    async def pre(exec: ToolRunContext, next: Any) -> Any:
        order.append("pre")
        return await next()

    bus.on("tools/pre-execute", pre)
    runtime.guard(lambda exec: order.append("guard") or "no")
    result = await runtime.execute("echo", {"text": "x"})
    assert result.is_error and order == ["pre", "guard"]


# ---------------------------------------------------------------------------
# around：取消熔合、计时、包装器自造结果
# ---------------------------------------------------------------------------


async def test_around_wrapper_replaces_cancel_and_times_body(
    runtime: ToolRuntime, bus: EventBus
) -> None:
    caller = asyncio.Event()
    own = asyncio.Event()
    timings: list[float] = []
    seen: dict[str, Any] = {}

    @tool("waiter", description="", input=Other, output=EchoOut)
    async def waiter(args: Other, exec: ToolRunContext) -> EchoOut:
        seen["body_cancel"] = exec.cancel
        await exec.cancel.wait()
        return EchoOut(echoed="woke")

    runtime.register(waiter)

    async def wrapper(exec: ToolRunContext, next: Any) -> Any:
        loop = asyncio.get_running_loop()
        original = exec.cancel
        exec.cancel = own
        loop.call_later(0.02, own.set)
        start = loop.time()
        try:
            return await next()
        finally:
            timings.append(loop.time() - start)
            seen["restored"] = exec.cancel is own
            exec.cancel = original

    bus.on("tools/execute", wrapper)
    bus.on("tools/result", lambda exec, result: seen.update(final_cancel=exec.cancel))

    result = await runtime.execute("waiter", {}, cancel=caller)
    assert seen["body_cancel"] is not caller and seen["body_cancel"] is not own
    assert seen["restored"] is True, "工具体结束后运行时恢复包装器看到的事件"
    assert seen["final_cancel"] is caller, "包装器退出后恢复调用方事件"
    assert timings and timings[0] >= 0.02
    assert not caller.is_set()
    assert result.is_error and result.error is not None and result.error.code == TOOL_ABORTED


async def test_around_wrapper_sees_caller_cancel_through_fused_event(
    runtime: ToolRuntime, bus: EventBus
) -> None:
    caller = asyncio.Event()
    own = asyncio.Event()

    @tool("waiter", description="", input=Other, output=EchoOut)
    async def waiter(args: Other, exec: ToolRunContext) -> EchoOut:
        asyncio.get_running_loop().call_later(0.01, caller.set)
        await exec.cancel.wait()
        return EchoOut(echoed="woke")

    runtime.register(waiter)

    async def wrapper(exec: ToolRunContext, next: Any) -> Any:
        exec.cancel = own
        try:
            return await next()
        finally:
            exec.cancel = caller

    bus.on("tools/execute", wrapper)
    result = await runtime.execute("waiter", {}, cancel=caller)
    assert result.is_error and result.error is not None and result.error.code == TOOL_ABORTED


async def test_around_wrapper_authored_error_skips_body_but_reaches_post(
    runtime: ToolRuntime, bus: EventBus
) -> None:
    ran: list[str] = []
    seen_post: list[ToolResult] = []

    @tool("tracked", description="", input=EchoArgs, output=EchoOut)
    async def tracked(args: EchoArgs, exec: ToolRunContext) -> EchoOut:
        ran.append("body")
        return EchoOut(echoed="x")

    runtime.register(tracked)

    async def wrapper(exec: ToolRunContext, next: Any) -> Any:
        return ToolResult(
            call_id="wrong",
            name="wrong",
            value=None,
            content=[TextBlock(text="Error: synthetic")],
            is_error=True,
            error=ToolError("synthetic", code="RETRY_EXHAUSTED"),
        )

    async def post(exec: ToolRunContext, result: ToolResult, next: Any) -> Any:
        seen_post.append(result)
        return await next()

    bus.on("tools/execute", wrapper)
    bus.on("tools/post-execute", post)
    result = await runtime.execute("tracked", {"text": "x"}, call_id="call-1")
    assert ran == [] and seen_post
    assert result.is_error and result.call_id == "call-1" and result.name == "tracked"
    assert result.error is not None and result.error.code == "RETRY_EXHAUSTED"


async def test_around_wrapper_success_value_is_revalidated(
    runtime: ToolRuntime, bus: EventBus
) -> None:
    async def wrapper(exec: ToolRunContext, next: Any) -> Any:
        inner = await next()
        return ToolResult(
            call_id=inner.call_id,
            name=inner.name,
            value=Other(),
            content=[],
            is_error=False,
            error=None,
        )

    bus.on("tools/execute", wrapper)
    result = await runtime.execute("echo", {"text": "x"})
    assert result.is_error
    assert result.error is not None and result.error.code == TOOL_INVALID_OUTPUT


async def test_timeout_ms_cancels_body_and_reports_timeout(runtime: ToolRuntime) -> None:
    flags: dict[str, bool] = {}

    @tool("slow", description="", input=Other, output=EchoOut, timeout_ms=20)
    async def slow(args: Other, exec: ToolRunContext) -> EchoOut:
        try:
            await asyncio.sleep(5)
        except asyncio.CancelledError:
            flags["cancelled"] = True
            raise
        return EchoOut(echoed="late")

    runtime.register(slow)
    result = await runtime.execute("slow", {})
    assert result.is_error and flags.get("cancelled") is True
    assert result.error is not None and result.error.code == TOOL_TIMEOUT
    assert "20 ms" in result.error.message


# ---------------------------------------------------------------------------
# 调用方取消
# ---------------------------------------------------------------------------


async def test_caller_cancel_before_dispatch(runtime: ToolRuntime, bus: EventBus) -> None:
    cancel = asyncio.Event()
    cancel.set()
    seen_post: list[ToolResult] = []

    async def post(exec: ToolRunContext, result: ToolResult, next: Any) -> Any:
        seen_post.append(result)
        return await next()

    bus.on("tools/post-execute", post)
    result = await runtime.execute("echo", {"text": "x"}, cancel=cancel)
    assert result.is_error
    assert result.error is not None and result.error.code == TOOL_ABORTED_BEFORE_DISPATCH
    assert seen_post == [], "进入管线前已取消：直接收尾，不过 post-execute"


async def test_caller_cancel_during_pre_execute(runtime: ToolRuntime, bus: EventBus) -> None:
    cancel = asyncio.Event()
    ran: list[str] = []

    @tool("tracked", description="", input=EchoArgs, output=EchoOut)
    async def tracked(args: EchoArgs, exec: ToolRunContext) -> EchoOut:
        ran.append("body")
        return EchoOut(echoed="x")

    runtime.register(tracked)

    async def pre(exec: ToolRunContext, next: Any) -> Any:
        cancel.set()
        return await next()

    bus.on("tools/pre-execute", pre)
    result = await runtime.execute("tracked", {"text": "x"}, cancel=cancel)
    assert ran == []
    assert result.error is not None and result.error.code == TOOL_ABORTED_BEFORE_DISPATCH


async def test_caller_cancel_after_body_started_replaces_success(runtime: ToolRuntime) -> None:
    cancel = asyncio.Event()

    @tool("self_cancel", description="", input=Other, output=EchoOut)
    async def self_cancel(args: Other, exec: ToolRunContext) -> EchoOut:
        exec.defer_context(user_message("ferried"))
        cancel.set()
        return EchoOut(echoed="done anyway")

    runtime.register(self_cancel)
    result = await runtime.execute("self_cancel", {}, cancel=cancel)
    assert result.is_error and result.value is None
    assert result.error is not None and result.error.code == TOOL_ABORTED
    assert [m.content[0].text for m in result.additional_contexts] == ["ferried"]


# ---------------------------------------------------------------------------
# post-execute
# ---------------------------------------------------------------------------


async def test_post_execute_block_drops_deferred_and_keeps_decision_contexts(
    runtime: ToolRuntime, bus: EventBus
) -> None:
    @tool("deferring", description="", input=Other, output=EchoOut)
    async def deferring(args: Other, exec: ToolRunContext) -> EchoOut:
        exec.defer_context(user_message("from body"))
        return EchoOut(echoed="x")

    runtime.register(deferring)

    async def block(exec: ToolRunContext, result: ToolResult, next: Any) -> Any:
        assert not result.is_error
        return Block(
            feedback=[TextBlock(text="fix it"), TextBlock(text="now")],
            additional_contexts=[user_message("from policy")],
        )

    bus.on("tools/post-execute", block)
    result = await runtime.execute("deferring", {})
    assert result.is_error and result.value is None
    assert result.content == [TextBlock(text="fix it"), TextBlock(text="now")]
    assert result.error == ToolError("fix it\nnow", name="ToolBlocked", code=TOOL_BLOCKED)
    assert [m.content[0].text for m in result.additional_contexts] == ["from policy"]


async def test_post_execute_replace_value_rerenders_and_merges_contexts(
    runtime: ToolRuntime, bus: EventBus
) -> None:
    @tool("deferring", description="", input=Other, output=EchoOut)
    async def deferring(args: Other, exec: ToolRunContext) -> EchoOut:
        exec.defer_context(user_message("from body"))
        exec.conclude_turn()
        return EchoOut(echoed="a")

    runtime.register(deferring)

    async def replace_value(exec: ToolRunContext, result: ToolResult, next: Any) -> Any:
        return Accept(value=EchoOut(echoed="b"), additional_contexts=[user_message("from policy")])

    bus.on("tools/post-execute", replace_value)
    result = await runtime.execute("deferring", {})
    assert not result.is_error
    assert result.value == EchoOut(echoed="b")
    assert result.content == [TextBlock(text='{"echoed":"b"}')]
    assert result.concludes_turn is True
    assert [m.content[0].text for m in result.additional_contexts] == ["from body", "from policy"]


async def test_post_execute_replace_content_only(runtime: ToolRuntime, bus: EventBus) -> None:
    bus.on(
        "tools/post-execute",
        lambda exec, result, next: Accept(content=[TextBlock(text="trimmed")]),
    )
    result = await runtime.execute("echo", {"text": "long" * 100})
    assert not result.is_error
    assert result.content == [TextBlock(text="trimmed")]
    assert result.value == EchoOut(echoed="long" * 100)


async def test_post_execute_invalid_replacements(runtime: ToolRuntime, bus: EventBus) -> None:
    dispose = bus.on("tools/post-execute", lambda exec, result, next: Accept(value=Other()))
    result = await runtime.execute("echo", {"text": "x"})
    assert result.is_error
    assert result.error is not None and result.error.code == TOOL_INVALID_OUTPUT
    dispose()

    bus.on(
        "tools/post-execute",
        lambda exec, result, next: Accept(value=EchoOut(echoed="b"), content=[]),
    )
    result = await runtime.execute("echo", {"text": "x"})
    assert result.is_error and result.error is not None
    assert result.error.name == "TypeError" and "value 和 content" in result.error.message


async def test_post_execute_cannot_replace_value_of_failed_result(
    runtime: ToolRuntime, bus: EventBus
) -> None:
    bus.on("tools/pre-execute", lambda exec, next: Deny("no"))
    bus.on("tools/post-execute", lambda exec, result, next: Accept(value=EchoOut(echoed="b")))
    result = await runtime.execute("echo", {"text": "x"})
    assert result.is_error and result.error is not None and result.error.name == "TypeError"


async def test_post_execute_terminal_accepts_unchanged(runtime: ToolRuntime, bus: EventBus) -> None:
    bus.on("tools/post-execute", lambda exec, result, next: next())
    result = await runtime.execute("echo", {"text": "x", "times": 2})
    assert result.value == EchoOut(echoed="xx") and result.additional_contexts == []
    assert ACCEPT.kind == "accept"


# ---------------------------------------------------------------------------
# tools/result 与冻结
# ---------------------------------------------------------------------------


async def test_result_listener_exception_is_contained(
    runtime: ToolRuntime, bus: EventBus, caplog: pytest.LogCaptureFixture
) -> None:
    hits: list[str] = []

    def broken(exec: ToolRunContext, result: ToolResult) -> None:
        raise RuntimeError("observer exploded")

    bus.on("tools/result", broken)
    bus.on("tools/result", lambda exec, result: hits.append(result.name))

    with caplog.at_level(logging.ERROR):
        result = await runtime.execute("echo", {"text": "x"})
    assert not result.is_error
    assert hits == ["echo"], "一个监听器炸了不影响后面的"
    assert any("observer exploded" in (r.exc_text or "") for r in caplog.records)


async def test_exec_frozen_after_result_and_arguments_immutable(
    runtime: ToolRuntime, bus: EventBus
) -> None:
    captured: dict[str, Any] = {}

    @tool("inspect", description="", input=NestedArgs, output=EchoOut)
    async def inspect_tool(args: NestedArgs, exec: ToolRunContext) -> EchoOut:
        captured["exec"] = exec
        captured["frozen_in_body"] = exec.arguments
        return EchoOut(echoed=",".join(args.tags))

    runtime.register(inspect_tool)
    raw = {"tags": ["a", "b"], "extra": {"k": [1, 2]}}
    result = await runtime.execute(
        "inspect", raw, call_id="c1", root_call_id="r0", agent_id="agent-1"
    )
    exec = captured["exec"]
    assert result.value == EchoOut(echoed="a,b")
    assert exec.call_id == "c1" and exec.root_call_id == "r0" and exec.agent_id == "agent-1"
    assert exec.arguments["tags"] == ("a", "b")
    assert exec.arguments["extra"]["k"] == (1, 2)
    with pytest.raises(TypeError):
        exec.arguments["tags"] = ("z",)
    with pytest.raises(AttributeError):
        exec.name = "renamed"
    assert plain_arguments(exec.arguments) == raw
    raw["tags"].append("mutated later")
    assert exec.arguments["tags"] == ("a", "b"), "参数是快照，不随调用方的 dict 变化"


class NestedArgs(BaseModel):
    tags: list[str]
    extra: dict[str, Any] = Field(default_factory=dict)


async def test_root_call_id_defaults_to_call_id_and_token_unique(
    runtime: ToolRuntime, bus: EventBus
) -> None:
    tokens: list[str] = []
    bus.on("tools/result", lambda exec, result: tokens.append(exec.token))
    first = await runtime.execute("echo", {"text": "x"}, call_id="same")
    second = await runtime.execute("echo", {"text": "x"}, call_id="same")
    assert first.call_id == second.call_id == "same"
    assert len(set(tokens)) == 2


# ---------------------------------------------------------------------------
# 作用域遮蔽、限制、tools/change
# ---------------------------------------------------------------------------


async def test_scope_shadowing_and_restrict(runtime: ToolRuntime, bus: EventBus) -> None:
    changes: list[int] = []
    bus.on("tools/change", lambda: changes.append(1))

    @tool("echo", description="作用域版", input=EchoArgs, output=EchoOut)
    async def scoped_echo(args: EchoArgs, exec: ToolRunContext) -> EchoOut:
        return EchoOut(echoed=f"scoped:{args.text}")

    @tool("extra", description="", input=EchoArgs, output=EchoOut)
    async def extra(args: EchoArgs, exec: ToolRunContext) -> EchoOut:
        return EchoOut(echoed="extra")

    scope = bus.scopes.create()
    child = bus.scopes.create(scope)
    runtime.register(extra)
    runtime.register(scoped_echo, scope=scope)
    assert len(changes) == 2

    with pytest.raises(DuplicateEntryError):
        runtime.register(scoped_echo, scope=scope)

    assert runtime.get("echo") is echo
    assert runtime.get("echo", scope) is scoped_echo
    assert runtime.get("echo", child) is scoped_echo, "子作用域继承父层的遮蔽"
    assert (await runtime.execute("echo", {"text": "x"}, scope=scope)).value == EchoOut(
        echoed="scoped:x"
    )
    assert (await runtime.execute("echo", {"text": "x"})).value == EchoOut(echoed="x")

    lift = runtime.restrict(scope, deny=["extra"])
    assert len(changes) == 3
    assert set(runtime.view(scope)) == {"echo"}
    assert set(runtime.view(child)) == {"echo"}, "限制沿链向下生效"
    assert set(runtime.view()) == {"echo", "extra"}
    hidden = await runtime.execute("extra", {"text": "x"}, scope=scope)
    assert hidden.is_error and hidden.error is not None and hidden.error.code == TOOL_UNKNOWN
    assert [s["function"]["name"] for s in runtime.schemas(scope)] == ["echo"]
    assert runtime.schemas(scope)[0]["function"]["description"] == "作用域版"

    lift()
    assert len(changes) == 4
    assert set(runtime.view(scope)) == {"echo", "extra"}

    with pytest.raises(ScopeError):
        runtime.restrict(None, deny=["extra"])
    with pytest.raises(ValueError):
        runtime.restrict(scope)
    with pytest.raises(KernelError):
        runtime.restrict(scope, allow=["ghost"])
    # 全局 echo 在继承面上，可以被指名；但限制只过滤继承面，本 scope 自己注册的 echo 不受影响，
    # 而子作用域继承到的是被遮住的那个名字，所以对子作用域它读作缺席
    mask = runtime.restrict(scope, deny=["echo"])
    assert runtime.get("echo", scope) is scoped_echo
    assert runtime.get("echo", child) is None
    assert runtime.get("echo") is echo
    mask()
    assert runtime.get("echo", child) is scoped_echo

    allow_only = runtime.restrict(child, allow=["extra"])
    assert set(runtime.view(child)) == {"extra"}
    allow_only()

    bus.scopes.dispose(scope)
    assert runtime.get("echo", scope) is echo, "作用域释放后它的注册随之撤销"


async def test_scoped_listeners_only_see_their_scope(runtime: ToolRuntime, bus: EventBus) -> None:
    scope_a = bus.scopes.create()
    scope_b = bus.scopes.create()
    seen: list[str] = []
    bus.on("tools/result", lambda exec, result: seen.append("a"), scope=scope_a)
    bus.on("tools/result", lambda exec, result: seen.append("global"))

    await runtime.execute("echo", {"text": "x"}, scope=scope_b)
    assert seen == ["global"]
    await runtime.execute("echo", {"text": "x"}, scope=scope_a)
    assert seen == ["global", "a", "global"]


# ---------------------------------------------------------------------------
# 并行分类
# ---------------------------------------------------------------------------


def test_execution_mode_concurrency_safe(runtime: ToolRuntime) -> None:
    @tool("always", description="", input=EchoArgs, output=EchoOut, concurrency_safe=True)
    async def always(args: EchoArgs, exec: ToolRunContext) -> EchoOut:
        return EchoOut(echoed="")

    @tool(
        "by_args",
        description="",
        input=EchoArgs,
        output=EchoOut,
        concurrency_safe=lambda args: args.times == 1,
    )
    async def by_args(args: EchoArgs, exec: ToolRunContext) -> EchoOut:
        return EchoOut(echoed="")

    def explode(args: Any) -> bool:
        raise RuntimeError("classifier broke")

    @tool("raising", description="", input=EchoArgs, output=EchoOut, concurrency_safe=explode)
    async def raising(args: EchoArgs, exec: ToolRunContext) -> EchoOut:
        return EchoOut(echoed="")

    for definition in (always, by_args, raising):
        runtime.register(definition)

    assert runtime.execution_mode("echo", {"text": "x"}) == "exclusive"
    assert runtime.execution_mode("always", {"text": "x"}) == "parallel"
    assert runtime.execution_mode("by_args", {"text": "x"}) == "parallel"
    assert runtime.execution_mode("by_args", {"text": "x", "times": 2}) == "exclusive"
    assert runtime.execution_mode("by_args", {"bogus": 1}) == "exclusive"
    assert runtime.execution_mode("raising", {"text": "x"}) == "exclusive"
    assert runtime.execution_mode("ghost", {}) == "exclusive"


# ---------------------------------------------------------------------------
# 审批席位
# ---------------------------------------------------------------------------


def make_exec(bus: EventBus, *, cancel: asyncio.Event | None = None) -> ToolRunContext:
    return ToolRunContext(
        call_id="c1",
        root_call_id="c1",
        name="echo",
        arguments={},
        scope=None,
        agent_id="agent-1",
        parent_call_id=None,
        cancel=cancel or asyncio.Event(),
        token="t1",
    )


async def test_default_approval_waterfall_outcomes(bus: EventBus) -> None:
    approval = DefaultApproval(bus)
    exec = make_exec(bus)

    assert await approval.request(exec, "why") == "unavailable", "没有答复者：fail closed"

    seen: list[Any] = []

    async def answerer(req: Any, next: Any) -> Any:
        seen.append(req)
        return "allowed-once"

    dispose = bus.on("approval/request", answerer)
    assert await approval.request(exec, "why") == "allowed-once"
    assert seen[0].tool_name == "echo" and seen[0].call_id == "c1"
    assert seen[0].reason == "why" and seen[0].agent_id == "agent-1"
    dispose()

    dispose = bus.on("approval/request", lambda req, next: "maybe")
    assert await approval.request(exec, "why") == "unavailable", "词汇表之外的答复归一化"
    dispose()

    def throwing(req: Any, next: Any) -> Any:
        raise RuntimeError("answerer broke")

    dispose = bus.on("approval/request", throwing)
    assert await approval.request(exec, "why") == "unavailable", "答复者抛错不泄漏给调用方"
    dispose()

    bus.on("approval/request", lambda req, next: next())
    assert await approval.request(exec, "why") == "unavailable", "全部让行则落到终端"


async def test_default_approval_never_policy_rejects_before_answerers(bus: EventBus) -> None:
    approval = DefaultApproval(bus, policy="never")
    hits: list[int] = []
    bus.on("approval/request", lambda req, next: hits.append(1) or "allowed-once", prepend=True)
    assert await approval.request(make_exec(bus), "why") == "rejected"
    assert hits == []
    approval.policy = "ask"
    assert await approval.request(make_exec(bus), "why") == "allowed-once"
    with pytest.raises(ValueError):
        approval.policy = "sometimes"  # type: ignore[assignment]


async def test_default_approval_cancel_wins_the_race(bus: EventBus) -> None:
    approval = DefaultApproval(bus)
    cancel = asyncio.Event()
    gate = asyncio.Event()

    async def slow(req: Any, next: Any) -> Any:
        await gate.wait()
        return "allowed-once"

    bus.on("approval/request", slow)
    cancel.set()
    assert await approval.request(make_exec(bus, cancel=cancel), "why") == "cancelled"

    cancel = asyncio.Event()
    task = asyncio.create_task(approval.request(make_exec(bus, cancel=cancel), "why"))
    await asyncio.sleep(0.01)
    cancel.set()
    assert await task == "cancelled"
    gate.set()
    await asyncio.sleep(0)


async def test_default_approval_wired_into_runtime(bus: EventBus) -> None:
    runtime = ToolRuntime(bus, DefaultApproval(bus))
    runtime.register(echo)
    bus.on("tools/pre-execute", lambda exec, next: Ask("dangerous"))
    reasons: list[str] = []

    async def answerer(req: Any, next: Any) -> Any:
        reasons.append(req.reason)
        return "allowed-once"

    bus.on("approval/request", answerer)
    result = await runtime.execute("echo", {"text": "ok"})
    assert not result.is_error and reasons == ["dangerous"]
