"""LlmRuntime / llm_retry 的不变量测试：路由、原子替换、一次性分发、异常归一、waterfall、重试。

不碰数据库、不发网络；adapter 全部是脚本化的内存实现。
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import pytest

from domain.kernel.events import EventBus, ScopeError, Scopes
from domain.kernel.llm_retry import (
    DEFAULT_RETRYABLE_CODES,
    AlwaysRetryPolicy,
    NeverRetryPolicy,
    NormalRetryPolicy,
    RetryAttempt,
    RetryPolicyError,
    compute_delay,
    decide_retry,
    local_delay,
    resolve_retry_policy,
    retry_policy_key,
    run_with_retry,
)
from domain.kernel.llm_runtime import (
    ADAPTERS_UPDATED_EVENT,
    STREAM_EVENT,
    AdapterHandle,
    LlmAdapter,
    LlmError,
    LlmRuntime,
    ModelInfo,
    ProviderInfo,
    ReasoningEffortInfo,
    adapter_failure_chunk,
    failure_code_for,
    normalize_llm_failure,
    parse_route,
)
from domain.kernel.llm_types import (
    AbortedFinish,
    ErrorFinish,
    FinishChunk,
    GenerateOptions,
    LlmCallConfig,
    LlmFailure,
    ModelSource,
    ReasoningDeltaChunk,
    StopFinish,
    StreamChunk,
    TextBlock,
    TextDeltaChunk,
    ToolCallsFinish,
    UserSource,
    create_assistant_message,
    create_user_message,
)

# ---------------------------------------------------------------------------
# 脚手架
# ---------------------------------------------------------------------------


def _text(text: str = "hi") -> TextDeltaChunk:
    return TextDeltaChunk(index=0, text=text)


def _stop() -> FinishChunk:
    return FinishChunk(reason=StopFinish())


def _error_chunk(code: Any = "RATE_LIMIT", **facts: Any) -> FinishChunk:
    return FinishChunk(
        reason=ErrorFinish(failure=LlmFailure(message=f"{code} happened", code=code, **facts))
    )


def _options(provider: str = "openai", model: str = "gpt", **extra: Any) -> GenerateOptions:
    return GenerateOptions(
        provider=provider,
        model=model,
        messages=[create_user_message(content=[TextBlock(text="hello")], source=UserSource())],
        **extra,
    )


class ScriptedAdapter(LlmAdapter):
    """按脚本吐分块；可配置抛错、模型元数据、重试策略，并记录收到的请求与清理情况。"""

    def __init__(
        self,
        chunks: list[StreamChunk] | None = None,
        *,
        error: BaseException | None = None,
        error_after: int | None = None,
        model_info: ModelInfo | None = None,
        policy: Any = None,
        provider_name: str | None = None,
    ) -> None:
        self.chunks = chunks if chunks is not None else [_text(), _stop()]
        self.error = error
        self.error_after = error_after
        self.model_info = model_info
        self.policy = policy
        self.provider_name = provider_name
        self.calls: list[GenerateOptions] = []
        self.cancels: list[asyncio.Event | None] = []
        self.closed = 0

    def provider_info(self, provider: str) -> ProviderInfo:
        return ProviderInfo(id=provider, name=self.provider_name or provider)

    def retry_policy(self, provider: str) -> Any:
        return self.policy

    def resolve_model(self, provider: str, model: str) -> ModelInfo:
        return self.model_info or ModelInfo(provider=provider, id=model, name=model)

    async def stream(
        self, options: GenerateOptions, *, cancel: asyncio.Event | None = None
    ) -> AsyncIterator[StreamChunk]:
        self.calls.append(options)
        self.cancels.append(cancel)
        if self.error is not None and self.error_after is None:
            raise self.error
        try:
            for index, chunk in enumerate(self.chunks):
                if self.error is not None and index == self.error_after:
                    raise self.error
                yield chunk
        finally:
            self.closed += 1


async def _collect(stream: AsyncIterator[StreamChunk]) -> list[StreamChunk]:
    return [chunk async for chunk in stream]


@pytest.fixture
def runtime() -> LlmRuntime:
    return LlmRuntime(EventBus())


# ---------------------------------------------------------------------------
# 路由注册与解析
# ---------------------------------------------------------------------------


def test_parse_route_accepts_exact_and_wildcard_and_splits_on_first_slash():
    assert parse_route("openai/gpt-4o").key == "openai/gpt-4o"
    assert parse_route("openai/*").is_wildcard
    route = parse_route("openrouter/deepseek/deepseek-chat")
    assert (route.provider, route.model) == ("openrouter", "deepseek/deepseek-chat")
    for bad in ("openai", "openai/", "/gpt", ""):
        with pytest.raises(LlmError) as info:
            parse_route(bad)
        assert info.value.code == "INVALID_ROUTE"


def test_resolve_prefers_exact_route_over_wildcard(runtime: LlmRuntime):
    generic = ScriptedAdapter()
    special = ScriptedAdapter()
    runtime.register_adapter(["openai/*"], generic)
    runtime.register_adapter(["openai/o1"], special)

    assert runtime.resolve("openai", "gpt") is generic
    assert runtime.resolve("openai", "o1") is special
    assert runtime.resolve("anthropic", "claude") is None
    assert runtime.list_routes() == ["openai/*", "openai/o1"]
    assert [p.id for p in runtime.list_providers()] == ["openai"]


def test_register_rejects_empty_duplicate_and_conflicting_routes_atomically(runtime: LlmRuntime):
    with pytest.raises(LlmError) as info:
        runtime.register_adapter([], ScriptedAdapter())
    assert info.value.code == "INVALID_ADAPTER"

    with pytest.raises(LlmError) as info:
        runtime.register_adapter(["a/*", "a/*"], ScriptedAdapter())
    assert info.value.code == "DUPLICATE_ADAPTER"
    assert runtime.list_routes() == []

    runtime.register_adapter(["a/*"], ScriptedAdapter())
    with pytest.raises(LlmError) as info:
        runtime.register_adapter(["b/*", "a/*"], ScriptedAdapter())
    assert info.value.code == "DUPLICATE_ADAPTER"
    # 全有或全无：b/* 没有被登记
    assert runtime.list_routes() == ["a/*"]


def test_register_validates_provider_metadata(runtime: LlmRuntime):
    class BadInfo(ScriptedAdapter):
        def provider_info(self, provider: str) -> ProviderInfo:
            return ProviderInfo(id="someone-else", name="x")

    with pytest.raises(LlmError) as info:
        runtime.register_adapter(["a/*"], BadInfo())
    assert info.value.code == "INVALID_ADAPTER"


def test_register_captures_provider_retry_policy_and_defaults_omission(runtime: LlmRuntime):
    custom = NormalRetryPolicy(max_retries=1)
    runtime.register_adapter(["a/*"], ScriptedAdapter(policy=custom))
    runtime.register_adapter(["b/*"], ScriptedAdapter())
    assert runtime.provider_retry_policy("a", "x") is custom
    assert runtime.provider_retry_policy("b", "x") == NormalRetryPolicy()
    with pytest.raises(LlmError) as info:
        runtime.provider_retry_policy("c", "x")
    assert info.value.code == "NO_ADAPTER"


def test_adapters_updated_emitted_on_register_replace_and_dispose():
    bus = EventBus()
    runtime = LlmRuntime(bus)
    ticks: list[int] = []
    bus.on(ADAPTERS_UPDATED_EVENT, lambda: ticks.append(1))

    handle = runtime.register_adapter(["a/*"], ScriptedAdapter())
    handle.replace(routes=["a/*", "b/*"])
    handle.dispose()
    handle.dispose()  # 幂等，不再广播
    assert len(ticks) == 3
    assert runtime.list_routes() == []


# ---------------------------------------------------------------------------
# replace / dispose
# ---------------------------------------------------------------------------


def test_replace_swaps_adapter_atomically_and_keeps_prepared_call_on_old_adapter(
    runtime: LlmRuntime,
):
    old = ScriptedAdapter()
    new = ScriptedAdapter()
    handle = runtime.register_adapter(["openai/*"], old)
    prepared = runtime.prepare_call(_options())

    handle.replace(new)
    assert runtime.resolve("openai", "gpt") is new
    assert handle.adapter is new
    assert prepared.adapter is old


async def test_prepared_call_dispatches_to_captured_adapter_after_replace(runtime: LlmRuntime):
    old = ScriptedAdapter([_text("old"), _stop()])
    new = ScriptedAdapter([_text("new"), _stop()])
    handle = runtime.register_adapter(["openai/*"], old)
    prepared = runtime.prepare_call(_options())
    handle.replace(new)

    chunks = await _collect(prepared.stream())
    assert chunks[0] == _text("old")
    assert old.calls and not new.calls

    chunks = await _collect(runtime.stream(_options()))
    assert chunks[0] == _text("new")


def test_replace_validates_fully_before_touching_current_routes(runtime: LlmRuntime):
    runtime.register_adapter(["taken/*"], ScriptedAdapter())
    handle = runtime.register_adapter(["a/*"], ScriptedAdapter())
    with pytest.raises(LlmError) as info:
        handle.replace(routes=["b/*", "taken/*"])
    assert info.value.code == "DUPLICATE_ADAPTER"
    assert runtime.list_routes() == ["taken/*", "a/*"]
    assert handle.routes == ["a/*"]

    # 换成空路由集合法：注册仍活着，只是暂时不持有路由
    handle.replace(routes=[])
    assert handle.routes == []
    assert not handle.released
    handle.replace(routes=["a/x"])
    assert runtime.resolve("a", "x") is handle.adapter


def test_replace_after_dispose_raises_registration_disposed(runtime: LlmRuntime):
    handle = runtime.register_adapter(["a/*"], ScriptedAdapter())
    handle()
    assert handle.released
    with pytest.raises(LlmError) as info:
        handle.replace(routes=["a/*"])
    assert info.value.code == "REGISTRATION_DISPOSED"
    # 释放后同一路由可以重新注册
    runtime.register_adapter(["a/*"], ScriptedAdapter())


def test_scoped_registration_is_released_with_its_scope():
    scopes = Scopes()
    runtime = LlmRuntime(EventBus(scopes))
    plugin = scopes.create(label="plugin")
    handle = runtime.register_adapter(["a/*"], ScriptedAdapter(), scope=plugin)
    assert isinstance(handle, AdapterHandle)
    assert runtime.resolve("a", "x") is not None

    scopes.dispose(plugin)
    assert runtime.resolve("a", "x") is None
    assert handle.released
    with pytest.raises(LlmError):
        handle.replace(routes=["a/*"])

    with pytest.raises(ScopeError):
        runtime.register_adapter(["b/*"], ScriptedAdapter(), scope=plugin)


# ---------------------------------------------------------------------------
# prepare_call
# ---------------------------------------------------------------------------


async def test_prepared_call_streams_once_and_rejects_config_drift(runtime: LlmRuntime):
    adapter = ScriptedAdapter()
    runtime.register_adapter(["openai/*"], adapter)
    options = _options(temperature=0.2)
    prepared = runtime.prepare_call(options)
    assert prepared.config == LlmCallConfig(provider="openai", model="gpt", temperature=0.2)
    assert prepared.retry_policy == NormalRetryPolicy()
    assert prepared.adapter_defaults == {}

    with pytest.raises(LlmError) as info:
        prepared.stream(options.model_copy(update={"temperature": 0.9}))
    assert info.value.code == "INVALID_PREPARED_CALL"
    assert not prepared.dispatched

    # 换消息不算配置漂移
    later = options.model_copy(update={"messages": options.messages * 2})
    chunks = await _collect(prepared.stream(later))
    assert chunks == [_text(), _stop()]
    assert adapter.calls[0] is later

    with pytest.raises(LlmError) as info:
        prepared.stream()
    assert info.value.code == "INVALID_PREPARED_CALL"


def test_prepare_call_with_bare_config_requires_options_at_stream(runtime: LlmRuntime):
    runtime.register_adapter(["openai/*"], ScriptedAdapter())
    prepared = runtime.prepare_call(LlmCallConfig(provider="openai", model="gpt"))
    with pytest.raises(LlmError) as info:
        prepared.stream()
    assert info.value.code == "INVALID_PREPARED_CALL"
    assert not prepared.dispatched


def test_prepare_call_materializes_adapter_defaults_and_validates_reasoning(
    runtime: LlmRuntime,
):
    info = ModelInfo(
        provider="openai",
        id="gpt",
        name="GPT",
        context_window=128_000,
        default_max_tokens=4096,
        reasoning_efforts=[
            ReasoningEffortInfo(id="low", name="Low"),
            ReasoningEffortInfo(id="high", name="High"),
        ],
        default_reasoning_effort="low",
    )
    runtime.register_adapter(["openai/*"], ScriptedAdapter(model_info=info))

    prepared = runtime.prepare_call(_options())
    assert prepared.config.max_tokens == 4096
    assert prepared.config.reasoning_effort == "low"
    assert prepared.adapter_defaults == {"reasoning_effort": True, "max_tokens": True}
    assert prepared.context_window == 128_000
    assert prepared.model is info

    explicit = runtime.prepare_call(_options(max_tokens=100, reasoning_effort="high"))
    assert explicit.config.max_tokens == 100
    assert explicit.config.reasoning_effort == "high"
    assert explicit.adapter_defaults == {}

    with pytest.raises(LlmError) as err:
        runtime.prepare_call(_options(reasoning_effort="ultra"))
    assert err.value.code == "UNSUPPORTED_REASONING_EFFORT"

    assert runtime.resolve_call_config(LlmCallConfig(provider="openai", model="gpt")) == (
        LlmCallConfig(provider="openai", model="gpt", reasoning_effort="low", max_tokens=4096)
    )


def test_prepare_call_rejects_effort_on_model_without_reasoning(runtime: LlmRuntime):
    runtime.register_adapter(["openai/*"], ScriptedAdapter())
    with pytest.raises(LlmError) as err:
        runtime.prepare_call(_options(reasoning_effort="high"))
    assert err.value.code == "UNSUPPORTED_REASONING_EFFORT"


async def test_stream_path_materializes_defaults_and_passes_resolved_options(
    runtime: LlmRuntime,
):
    adapter = ScriptedAdapter(
        model_info=ModelInfo(provider="openai", id="gpt", name="GPT", default_max_tokens=512)
    )
    runtime.register_adapter(["openai/*"], adapter)
    await _collect(runtime.stream(_options()))
    assert adapter.calls[0].max_tokens == 512


def test_model_info_validation():
    with pytest.raises(ValueError):
        ModelInfo(provider="p", id="m", name="n", context_window=0)
    with pytest.raises(ValueError):
        ModelInfo(provider="p", id="m", name="n", reasoning_efforts=[])
    with pytest.raises(ValueError):
        ModelInfo(
            provider="p",
            id="m",
            name="n",
            reasoning_efforts=[ReasoningEffortInfo(id="a", name="A")],
            default_reasoning_effort="b",
        )
    with pytest.raises(ValueError):
        ModelInfo(provider="p", id="m", name="n", default_reasoning_effort="a")


def test_resolve_model_info_rejects_mismatched_identity(runtime: LlmRuntime):
    adapter = ScriptedAdapter(model_info=ModelInfo(provider="openai", id="other", name="x"))
    runtime.register_adapter(["openai/*"], adapter)
    with pytest.raises(LlmError) as err:
        runtime.resolve_model_info("openai", "gpt")
    assert err.value.code == "INVALID_MODEL_INFO"


async def test_list_models_merges_adapters_and_rejects_duplicates(runtime: LlmRuntime):
    class Catalog(ScriptedAdapter):
        def __init__(self, ids: list[str], provider: str = "openai") -> None:
            super().__init__()
            self.ids = ids
            self.owner = provider

        async def list_models(self, provider: str) -> list[ModelInfo]:
            return [ModelInfo(provider=self.owner, id=i, name=i) for i in self.ids]

    runtime.register_adapter(["openai/*"], Catalog(["a", "b"]))
    runtime.register_adapter(["openai/c"], Catalog(["c"]))
    assert [m.id for m in await runtime.list_models("openai")] == ["a", "b", "c"]

    runtime.register_adapter(["openai/d"], Catalog(["a"]))
    with pytest.raises(LlmError) as err:
        await runtime.list_models("openai")
    assert err.value.code == "INVALID_CATALOG"

    runtime.register_adapter(["x/*"], Catalog(["q"], provider="not-x"))
    with pytest.raises(LlmError) as err:
        await runtime.list_models("x")
    assert err.value.code == "INVALID_CATALOG"

    with pytest.raises(LlmError) as err:
        await runtime.list_models("nobody")
    assert err.value.code == "NO_ADAPTER"


# ---------------------------------------------------------------------------
# 异常归一
# ---------------------------------------------------------------------------


def test_llm_error_validates_facts_and_maps_codes():
    error = LlmError(
        "rate limited", "RATE_LIMIT", status=429, provider_retry_after_ms=1500, request_id="r1"
    )
    assert error.failure == LlmFailure(
        message="rate limited",
        code="RATE_LIMIT",
        status=429,
        provider_retry_after_ms=1500,
        request_id="r1",
    )
    assert str(error) == "[RATE_LIMIT] rate limited"
    assert LlmError("x", "NO_ADAPTER").failure.code == "INVALID_REQUEST"
    assert LlmError("x", "SOMETHING_ELSE").failure.code == "UNKNOWN"
    assert failure_code_for("AUTH") == "AUTH"

    for kwargs in (
        {"status": 99},
        {"status": 600},
        {"provider_retry_after_ms": 0},
        {"provider_retry_after_ms": float("inf")},
        {"request_id": ""},
    ):
        with pytest.raises(ValueError):
            LlmError("x", "SERVER", **kwargs)
    with pytest.raises(ValueError):
        LlmError("", "SERVER")
    with pytest.raises(ValueError):
        LlmError("x", "")


def test_normalize_llm_failure_covers_each_source():
    assert normalize_llm_failure(asyncio.CancelledError()).code == "ABORTED"
    assert normalize_llm_failure(TimeoutError()) == LlmFailure(
        message="TimeoutError", code="TIMEOUT"
    )
    assert normalize_llm_failure(RuntimeError("boom")) == LlmFailure(message="boom", code="UNKNOWN")
    assert normalize_llm_failure(RuntimeError()) == LlmFailure(
        message="RuntimeError", code="UNKNOWN"
    )

    class SdkError(Exception):
        failure = LlmFailure(message="sdk", code="SERVER", status=503)

    assert normalize_llm_failure(SdkError("ignored")).status == 503

    cancel = asyncio.Event()
    assert isinstance(adapter_failure_chunk(RuntimeError("x"), cancel).reason, ErrorFinish)
    cancel.set()
    assert isinstance(adapter_failure_chunk(RuntimeError("x"), cancel).reason, AbortedFinish)


async def test_unregistered_provider_becomes_terminal_error_chunk(runtime: LlmRuntime):
    chunks = await _collect(runtime.stream(_options("ghost", "m")))
    assert len(chunks) == 1
    reason = chunks[0].reason
    assert isinstance(reason, ErrorFinish)
    assert reason.failure.code == "INVALID_REQUEST"
    assert "ghost/m" in reason.failure.message


async def test_adapter_raise_before_first_chunk_preserves_llm_error_facts(runtime: LlmRuntime):
    adapter = ScriptedAdapter(
        error=LlmError("slow down", "RATE_LIMIT", status=429, provider_retry_after_ms=2000)
    )
    runtime.register_adapter(["openai/*"], adapter)
    chunks = await _collect(runtime.stream(_options()))
    assert chunks == [
        FinishChunk(
            reason=ErrorFinish(
                failure=LlmFailure(
                    message="slow down", code="RATE_LIMIT", status=429, provider_retry_after_ms=2000
                )
            )
        )
    ]


async def test_adapter_raise_mid_stream_keeps_prefix_then_error_chunk(runtime: LlmRuntime):
    adapter = ScriptedAdapter(
        [_text("a"), _text("b"), _stop()], error=RuntimeError("boom"), error_after=1
    )
    runtime.register_adapter(["openai/*"], adapter)
    chunks = await _collect(runtime.stream(_options()))
    assert chunks[0] == _text("a")
    assert isinstance(chunks[1], FinishChunk)
    assert isinstance(chunks[1].reason, ErrorFinish)
    assert chunks[1].reason.failure == LlmFailure(message="boom", code="UNKNOWN")
    assert len(chunks) == 2
    assert adapter.closed == 1


async def test_cancelled_error_becomes_aborted_finish(runtime: LlmRuntime):
    runtime.register_adapter(["openai/*"], ScriptedAdapter(error=asyncio.CancelledError()))
    chunks = await _collect(runtime.stream(_options()))
    assert len(chunks) == 1
    assert isinstance(chunks[0].reason, AbortedFinish)
    assert chunks[0].reason.failure.code == "ABORTED"


async def test_any_failure_after_cancel_event_is_aborted(runtime: LlmRuntime):
    adapter = ScriptedAdapter(error=RuntimeError("socket closed"))
    runtime.register_adapter(["openai/*"], adapter)
    cancel = asyncio.Event()
    cancel.set()
    chunks = await _collect(runtime.stream(_options(), cancel=cancel))
    assert isinstance(chunks[0].reason, AbortedFinish)
    assert chunks[0].reason.failure.message == "socket closed"
    assert adapter.cancels == [cancel]


async def test_missing_finish_is_completed_with_stop(runtime: LlmRuntime):
    runtime.register_adapter(["openai/*"], ScriptedAdapter([_text("a"), _text("b")]))
    chunks = await _collect(runtime.stream(_options()))
    assert chunks == [_text("a"), _text("b"), _stop()]


async def test_chunks_after_finish_are_dropped_and_adapter_closed(runtime: LlmRuntime):
    finish = FinishChunk(reason=ToolCallsFinish())
    adapter = ScriptedAdapter([_text("a"), finish, _text("late")])
    runtime.register_adapter(["openai/*"], adapter)
    chunks = await _collect(runtime.stream(_options()))
    assert chunks == [_text("a"), finish]
    assert adapter.closed == 1


async def test_downstream_close_awaits_adapter_cleanup(runtime: LlmRuntime):
    adapter = ScriptedAdapter([_text("a"), _text("b"), _stop()])
    runtime.register_adapter(["openai/*"], adapter)
    stream = runtime.stream(_options())
    assert await stream.__anext__() == _text("a")
    assert adapter.closed == 0
    await stream.aclose()
    assert adapter.closed == 1


async def test_consumer_exception_thrown_into_stream_is_not_normalized(runtime: LlmRuntime):
    adapter = ScriptedAdapter([_text("a"), _stop()])
    runtime.register_adapter(["openai/*"], adapter)
    stream = runtime.stream(_options())
    await stream.__anext__()
    with pytest.raises(ValueError, match="consumer"):
        await stream.athrow(ValueError("consumer"))
    assert adapter.closed == 1


async def test_adapter_returning_awaitable_iterator_is_accepted(runtime: LlmRuntime):
    class CoroutineAdapter(LlmAdapter):
        async def stream(  # type: ignore[override]
            self, options: GenerateOptions, *, cancel: asyncio.Event | None = None
        ) -> Any:
            async def gen() -> AsyncIterator[StreamChunk]:
                yield _text("x")
                yield _stop()

            return gen()

    runtime.register_adapter(["openai/*"], CoroutineAdapter())
    assert await _collect(runtime.stream(_options())) == [_text("x"), _stop()]


# ---------------------------------------------------------------------------
# llm/stream waterfall
# ---------------------------------------------------------------------------


async def test_waterfall_listener_rewrites_options_and_wraps_stream():
    bus = EventBus()
    runtime = LlmRuntime(bus)
    primary = ScriptedAdapter()
    fallback = ScriptedAdapter(
        [ReasoningDeltaChunk(index=0, text="thinking"), _text("answer"), _stop()]
    )
    runtime.register_adapter(["openai/*"], primary)
    runtime.register_adapter(["local/*"], fallback)
    seen: list[str] = []

    async def reroute(options: GenerateOptions, *, next: Any) -> Any:
        inner = await next(options.model_copy(update={"provider": "local", "model": "llama"}))

        async def without_reasoning() -> AsyncIterator[StreamChunk]:
            async for chunk in inner:
                seen.append(chunk.type)
                if isinstance(chunk, ReasoningDeltaChunk):
                    continue
                yield chunk

        return without_reasoning()

    bus.on(STREAM_EVENT, reroute)
    chunks = await _collect(runtime.stream(_options()))
    assert chunks == [_text("answer"), _stop()]
    assert seen == ["reasoning-delta", "text-delta", "finish"]
    assert not primary.calls
    assert fallback.calls[0].provider == "local"


async def test_waterfall_listener_can_short_circuit_with_its_own_stream():
    bus = EventBus()
    runtime = LlmRuntime(bus)
    adapter = ScriptedAdapter()
    runtime.register_adapter(["openai/*"], adapter)

    async def replay(options: GenerateOptions, *, next: Any) -> AsyncIterator[StreamChunk]:
        yield _text("cached")
        yield _stop()

    bus.on(STREAM_EVENT, replay)
    assert await _collect(runtime.stream(_options())) == [_text("cached"), _stop()]
    assert not adapter.calls


async def test_waterfall_listener_failure_is_thrown_not_normalized():
    bus = EventBus()
    runtime = LlmRuntime(bus)
    runtime.register_adapter(["openai/*"], ScriptedAdapter())

    async def broken(options: GenerateOptions, *, next: Any) -> Any:
        raise RuntimeError("middleware bug")

    bus.on(STREAM_EVENT, broken)
    with pytest.raises(RuntimeError, match="middleware bug"):
        await _collect(runtime.stream(_options()))


async def test_waterfall_listener_returning_non_iterable_is_a_type_error():
    bus = EventBus()
    runtime = LlmRuntime(bus)
    runtime.register_adapter(["openai/*"], ScriptedAdapter())

    async def wrong(options: GenerateOptions, *, next: Any) -> Any:
        return "not a stream"

    bus.on(STREAM_EVENT, wrong)
    with pytest.raises(TypeError):
        await _collect(runtime.stream(_options()))


async def test_waterfall_respects_scope_filter():
    scopes = Scopes()
    bus = EventBus(scopes)
    runtime = LlmRuntime(bus)
    runtime.register_adapter(["openai/*"], ScriptedAdapter())
    agent = scopes.create(label="agent")
    hits: list[str | None] = []

    async def observe(options: GenerateOptions, *, next: Any) -> Any:
        hits.append("agent")
        return await next()

    bus.on(STREAM_EVENT, observe, scope=agent)
    await _collect(runtime.stream(_options()))
    await _collect(runtime.stream(_options(), scope=agent))
    assert hits == ["agent"]


async def test_prepared_call_also_flows_through_waterfall_and_rechecks_config(
    runtime: LlmRuntime,
):
    adapter = ScriptedAdapter()
    runtime.register_adapter(["openai/*"], adapter)

    async def drift(options: GenerateOptions, *, next: Any) -> Any:
        return await next(options.model_copy(update={"temperature": 1.0}))

    runtime.bus.on(STREAM_EVENT, drift)
    chunks = await _collect(runtime.prepare_call(_options()).stream())
    assert isinstance(chunks[0].reason, ErrorFinish)
    assert chunks[0].reason.failure.code == "INVALID_REQUEST"
    assert not adapter.calls


# ---------------------------------------------------------------------------
# 回放状态归属
# ---------------------------------------------------------------------------


def _history(provider: str, replay_state: Any) -> GenerateOptions:
    history = create_assistant_message(
        content=[TextBlock(text="earlier")],
        provider=provider,
        model="m",
        replay_state=replay_state,
    )
    user = create_user_message(content=[TextBlock(text="next")], source=UserSource())
    return GenerateOptions(provider="openai", model="gpt", messages=[history, user])


async def test_replay_state_kept_for_same_adapter_and_stripped_for_other(runtime: LlmRuntime):
    shared = ScriptedAdapter()
    other = ScriptedAdapter()
    runtime.register_adapter(["openai/*", "alias/*"], shared)
    runtime.register_adapter(["foreign/*"], other)

    same = _history("alias", {"cursor": 1})
    await _collect(runtime.stream(same))
    assert shared.calls[-1] is same

    stripped = _history("foreign", {"cursor": 1})
    await _collect(runtime.stream(stripped))
    sent = shared.calls[-1]
    assert sent is not stripped
    source = sent.messages[0].source
    assert isinstance(source, ModelSource)
    assert (source.provider, source.model, source.replay_state) == ("foreign", "m", None)
    assert sent.messages[1] is stripped.messages[1]
    # 原请求未被改动
    original = stripped.messages[0].source
    assert isinstance(original, ModelSource) and original.replay_state == {"cursor": 1}

    unknown = _history("gone", {"cursor": 2})
    await _collect(runtime.stream(unknown))
    gone = shared.calls[-1].messages[0].source
    assert isinstance(gone, ModelSource) and gone.replay_state is None


# ---------------------------------------------------------------------------
# 重试策略
# ---------------------------------------------------------------------------


def test_resolve_retry_policy_defaults_and_modes():
    assert resolve_retry_policy(None) == NormalRetryPolicy(
        max_retries=5,
        retryable_codes=DEFAULT_RETRYABLE_CODES,
        initial_delay_ms=500,
        max_delay_ms=10_000,
        jitter_ratio=0.1,
    )
    assert {
        "EMPTY_RESPONSE",
        "RATE_LIMIT",
        "SERVER",
        "TIMEOUT",
        "TRANSPORT",
    } == DEFAULT_RETRYABLE_CODES
    normal = resolve_retry_policy(
        {
            "mode": "normal",
            "max_retries": 2,
            "retryable_codes": ["SERVER"],
            "backoff": {"initial_delay_ms": 10, "max_delay_ms": 20, "jitter_ratio": 0},
        }
    )
    assert normal == NormalRetryPolicy(
        max_retries=2,
        retryable_codes=frozenset({"SERVER"}),
        initial_delay_ms=10,
        max_delay_ms=20,
        jitter_ratio=0,
    )
    always = resolve_retry_policy({"mode": "always", "max_retries": 9, "retryable_codes": ["x"]})
    assert always == AlwaysRetryPolicy()
    assert resolve_retry_policy({"mode": "never"}) == NeverRetryPolicy()


@pytest.mark.parametrize(
    "config",
    [
        {"mode": "normal", "bogus": 1},
        {"mode": "normal", "backoff": {"bogus": 1}},
        {"mode": "normal", "max_retries": -1},
        {"mode": "normal", "max_retries": True},
        {"mode": "normal", "retryable_codes": []},
        {"mode": "normal", "retryable_codes": ["A", "A"]},
        {"mode": "normal", "retryable_codes": [""]},
        {"mode": "normal", "backoff": {"initial_delay_ms": 0}},
        {"mode": "normal", "backoff": {"initial_delay_ms": 20, "max_delay_ms": 10}},
        {"mode": "normal", "backoff": {"jitter_ratio": 1.5}},
        {"mode": "sometimes"},
        {},
    ],
)
def test_resolve_retry_policy_rejects_invalid_config(config: dict[str, Any]):
    with pytest.raises(RetryPolicyError) as err:
        resolve_retry_policy(config, "providers.openai.retry_policy")
    assert str(err.value).startswith("providers.openai.retry_policy")


def test_retry_policy_key_depends_on_policy_not_code_order():
    a = NormalRetryPolicy(retryable_codes=frozenset({"A", "B"}))
    b = NormalRetryPolicy(retryable_codes=frozenset({"B", "A"}))
    assert retry_policy_key(a) == retry_policy_key(b)
    assert retry_policy_key(a) != retry_policy_key(NormalRetryPolicy(max_retries=1))
    assert retry_policy_key(AlwaysRetryPolicy()) != retry_policy_key(NeverRetryPolicy())


def test_local_delay_is_bounded_exponential_with_symmetric_jitter():
    policy = NormalRetryPolicy(initial_delay_ms=100, max_delay_ms=1000, jitter_ratio=0.5)
    assert local_delay(policy, 1, lambda: 0.5) == 100
    assert local_delay(policy, 2, lambda: 0.5) == 200
    assert local_delay(policy, 1, lambda: 0.0) == 50
    assert local_delay(policy, 1, lambda: 1.0) == 150
    # 指数封顶后抖动仍不超过上限
    assert local_delay(policy, 10, lambda: 1.0) == 1000
    assert local_delay(policy, 10, lambda: 0.0) == 500
    # 零抖动允许，极大 retry 不溢出
    assert local_delay(NormalRetryPolicy(jitter_ratio=0), 5000, lambda: 0.9) == 10_000


def test_compute_delay_uses_provider_retry_after_within_cap():
    normal = NormalRetryPolicy(initial_delay_ms=100, max_delay_ms=1000, jitter_ratio=0)
    always = AlwaysRetryPolicy(initial_delay_ms=100, max_delay_ms=1000, jitter_ratio=0)
    hinted = LlmFailure(message="x", code="RATE_LIMIT", provider_retry_after_ms=700)
    over = LlmFailure(message="x", code="RATE_LIMIT", provider_retry_after_ms=5000)
    plain = LlmFailure(message="x", code="RATE_LIMIT")

    assert compute_delay(normal, 1, hinted) == 700
    assert compute_delay(normal, 1, over) is None
    assert compute_delay(always, 1, over) == 100
    assert compute_delay(normal, 3, plain) == 400
    assert compute_delay(normal, 3) == 400
    assert compute_delay(NeverRetryPolicy(), 1, plain) is None


def test_decide_retry_by_code_budget_and_mode():
    normal = NormalRetryPolicy(max_retries=2, initial_delay_ms=1, max_delay_ms=2, jitter_ratio=0)
    server = LlmFailure(message="x", code="SERVER")
    auth = LlmFailure(message="x", code="AUTH")

    first = decide_retry(normal, server, 0)
    assert first is not None and (first.retry, first.delay_ms) == (1, 1)
    second = decide_retry(normal, server, 1)
    assert second is not None and (second.retry, second.delay_ms) == (2, 2)
    assert decide_retry(normal, server, 2) is None
    assert decide_retry(normal, auth, 0) is None
    assert decide_retry(AlwaysRetryPolicy(initial_delay_ms=1, max_delay_ms=1), auth, 99) is not None
    assert decide_retry(NeverRetryPolicy(), server, 0) is None


# ---------------------------------------------------------------------------
# run_with_retry
# ---------------------------------------------------------------------------

FAST = NormalRetryPolicy(max_retries=3, initial_delay_ms=1, max_delay_ms=2, jitter_ratio=0)


class Attempts:
    """每次调用吐下一段脚本；记录被调用了几次。"""

    def __init__(self, *scripts: list[StreamChunk]) -> None:
        self.scripts = list(scripts)
        self.calls = 0

    def __call__(self) -> AsyncIterator[StreamChunk]:
        script = self.scripts[self.calls]
        self.calls += 1

        async def gen() -> AsyncIterator[StreamChunk]:
            for chunk in script:
                yield chunk

        return gen()


async def test_run_with_retry_retries_retryable_codes_then_succeeds():
    attempts = Attempts(
        [_error_chunk("RATE_LIMIT")], [_error_chunk("SERVER")], [_text("ok"), _stop()]
    )
    log: list[RetryAttempt] = []
    chunks = await _collect(run_with_retry(FAST, attempts, on_retry=log.append))
    assert chunks == [_text("ok"), _stop()]
    assert attempts.calls == 3
    assert [(a.retry, a.max_retries, a.delay_ms, a.failure.code) for a in log] == [
        (1, 3, 1, "RATE_LIMIT"),
        (2, 3, 2, "SERVER"),
    ]
    assert len({a.retry_id for a in log}) == 1
    assert {a.policy_key for a in log} == {retry_policy_key(FAST)}
    assert {a.mode for a in log} == {"normal"}


async def test_run_with_retry_stops_after_budget_and_surfaces_last_error():
    attempts = Attempts(*([[_error_chunk("SERVER")]] * 5))
    chunks = await _collect(run_with_retry(FAST, attempts))
    assert attempts.calls == 4
    assert chunks == [_error_chunk("SERVER")]


async def test_run_with_retry_passes_non_retryable_error_through():
    attempts = Attempts([_error_chunk("AUTH")], [_text("never")])
    chunks = await _collect(run_with_retry(FAST, attempts))
    assert chunks == [_error_chunk("AUTH")]
    assert attempts.calls == 1


async def test_run_with_retry_does_not_retry_once_content_was_yielded():
    attempts = Attempts([_text("partial"), _error_chunk("SERVER")], [_text("never")])
    chunks = await _collect(run_with_retry(FAST, attempts))
    assert chunks == [_text("partial"), _error_chunk("SERVER")]
    assert attempts.calls == 1


async def test_run_with_retry_does_not_touch_aborted_or_stop_finishes():
    aborted = FinishChunk(reason=AbortedFinish(failure=LlmFailure(message="x", code="ABORTED")))
    attempts = Attempts([aborted], [_text("never")])
    assert await _collect(
        run_with_retry(AlwaysRetryPolicy(initial_delay_ms=1, max_delay_ms=1), attempts)
    ) == [aborted]
    assert attempts.calls == 1


async def test_run_with_retry_always_mode_retries_any_code_and_never_mode_none():
    always = AlwaysRetryPolicy(initial_delay_ms=1, max_delay_ms=1, jitter_ratio=0)
    attempts = Attempts([_error_chunk("AUTH")], [_error_chunk("INVALID_REQUEST")], [_stop()])
    log: list[RetryAttempt] = []
    assert await _collect(run_with_retry(always, attempts, on_retry=log.append)) == [_stop()]
    assert attempts.calls == 3
    assert [a.max_retries for a in log] == [None, None]

    never = Attempts([_error_chunk("SERVER")], [_stop()])
    assert await _collect(run_with_retry(NeverRetryPolicy(), never)) == [_error_chunk("SERVER")]
    assert never.calls == 1


async def test_run_with_retry_uses_provider_retry_after_and_rejects_over_cap():
    hinted = _error_chunk("RATE_LIMIT", provider_retry_after_ms=2)
    log: list[RetryAttempt] = []
    attempts = Attempts([hinted], [_stop()])
    assert await _collect(run_with_retry(FAST, attempts, on_retry=log.append)) == [_stop()]
    assert log[0].delay_ms == 2

    over = _error_chunk("RATE_LIMIT", provider_retry_after_ms=60_000)
    attempts = Attempts([over], [_stop()])
    assert await _collect(run_with_retry(FAST, attempts)) == [over]
    assert attempts.calls == 1


async def test_run_with_retry_cancel_during_backoff_ends_with_aborted():
    slow = NormalRetryPolicy(initial_delay_ms=60_000, max_delay_ms=60_000)
    cancel = asyncio.Event()
    attempts = Attempts([_error_chunk("SERVER")], [_stop()])

    def on_retry(attempt: RetryAttempt) -> None:
        cancel.set()

    chunks = await asyncio.wait_for(
        _collect(run_with_retry(slow, attempts, on_retry=on_retry, cancel=cancel)), timeout=5
    )
    assert len(chunks) == 1
    assert isinstance(chunks[0].reason, AbortedFinish)
    assert chunks[0].reason.failure.code == "SERVER"
    assert attempts.calls == 1


async def test_run_with_retry_cancel_event_unset_waits_and_set_mid_wait_aborts():
    # 给了 cancel 但没置位：等够延迟后照常重试
    cancel = asyncio.Event()
    attempts = Attempts([_error_chunk("SERVER")], [_stop()])
    assert await _collect(run_with_retry(FAST, attempts, cancel=cancel)) == [_stop()]
    assert attempts.calls == 2

    # 等待途中置位：中断退避，以 aborted 收尾
    slow = NormalRetryPolicy(initial_delay_ms=60_000, max_delay_ms=60_000)
    cancel = asyncio.Event()
    attempts = Attempts([_error_chunk("TRANSPORT")], [_stop()])

    async def trip() -> None:
        await asyncio.sleep(0.01)
        cancel.set()

    task = asyncio.create_task(trip())
    chunks = await asyncio.wait_for(
        _collect(run_with_retry(slow, attempts, cancel=cancel)), timeout=5
    )
    await task
    assert isinstance(chunks[0].reason, AbortedFinish)
    assert chunks[0].reason.failure.code == "TRANSPORT"
    assert attempts.calls == 1


async def test_run_with_retry_awaits_async_on_retry_and_closes_failed_stream():
    closed: list[int] = []
    calls = 0

    async def fn() -> AsyncIterator[StreamChunk]:
        nonlocal calls
        calls += 1
        current = calls

        async def gen() -> AsyncIterator[StreamChunk]:
            try:
                if current == 1:
                    yield _error_chunk("TRANSPORT")
                    yield _text("unreachable")
                else:
                    yield _stop()
            finally:
                closed.append(current)

        return gen()

    seen: list[int] = []

    async def on_retry(attempt: RetryAttempt) -> None:
        await asyncio.sleep(0)
        seen.append(attempt.retry)

    assert await _collect(run_with_retry(FAST, fn, on_retry=on_retry)) == [_stop()]
    assert seen == [1]
    assert closed == [1, 2]


async def test_run_with_retry_wraps_runtime_stream_end_to_end(runtime: LlmRuntime):
    class Flaky(ScriptedAdapter):
        def __init__(self) -> None:
            super().__init__([_text("done"), _stop()])
            self.failures = 2

        async def stream(
            self, options: GenerateOptions, *, cancel: asyncio.Event | None = None
        ) -> AsyncIterator[StreamChunk]:
            self.calls.append(options)
            if self.failures:
                self.failures -= 1
                raise LlmError("overloaded", "SERVER", status=503)
            for chunk in self.chunks:
                yield chunk

    adapter = Flaky()
    runtime.register_adapter(["openai/*"], adapter)
    prepared = runtime.prepare_call(_options())
    options = _options()
    chunks = await _collect(
        run_with_retry(
            prepared.retry_policy.__class__(max_retries=3, initial_delay_ms=1, max_delay_ms=1),
            lambda: runtime.stream(options),
        )
    )
    assert chunks == [_text("done"), _stop()]
    assert len(adapter.calls) == 3
