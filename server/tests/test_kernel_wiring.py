"""内核接线：Chat 消费者与 Agent 工具接到 kernel 之后的合同。

- ``PreparedChatCall.stream_chunks`` 把线协议翻译成 StreamChunk，并记下首 token 时刻；
- 上游失败归一成 LlmFailure，``error_code`` 落进模型调用台账；
- ``llm.stream_text`` 在推理块存在时正文依旧干净，``LLMUnavailable`` 携带失败事实；
- ``studio_gpt`` 的工具调用经 ToolRuntime 执行，``tools/result`` 事件可观测。

LLM 与出图全程替身，不发网络。
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import httpx
import pytest
from openai import APIConnectionError, APIStatusError

import domain.model_runtime as model_runtime
from domain import imagegen, llm, studio_gpt
from domain import storage as storage_mod
from domain.agent_tools import GPT_CREATIVE_SCOPE, ensure_registered, image_generate
from domain.imagegen import RenderResult
from domain.kernel.bootstrap import Kernel, build_kernel, get_kernel, kernel
from domain.kernel.events import EventBus
from domain.kernel.llm_types import (
    BlockEndChunk,
    BlockStartChunk,
    FinishChunk,
    ReasoningDeltaChunk,
    StopFinish,
    TextDeltaChunk,
    UsageChunk,
)
from domain.model_runtime import chat_failure, prepare_chat_route
from domain.models import StudioGptChat
from tests.model_binding_stub import seed_default_bindings
from tests.test_studio import FakeStorage, noise_png

# ---------------------------------------------------------------------------
# 替身
# ---------------------------------------------------------------------------


def _chunk(
    text: str | None = None,
    *,
    reasoning: str | None = None,
    tool_calls: list | None = None,
    finish: str | None = None,
    usage: dict | None = None,
    request_id: str = "req-1",
) -> SimpleNamespace:
    delta = SimpleNamespace(content=text, reasoning_content=reasoning, tool_calls=tool_calls)
    return SimpleNamespace(
        id=request_id,
        model="fake-model",
        usage=dict(usage) if usage is not None else None,
        choices=[SimpleNamespace(delta=delta, finish_reason=finish)],
    )


def _tool_piece(index: int, name: str | None, arguments: str, call_id: str | None = None):
    return SimpleNamespace(
        index=index, id=call_id, function=SimpleNamespace(name=name, arguments=arguments)
    )


class _Stream:
    """按脚本回放；脚本项是分块，或一个异常实例（迭代到它时当场抛）。"""

    def __init__(self, items: list) -> None:
        self._items = list(items)

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self._items:
            raise StopAsyncIteration
        item = self._items.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item


def _fake_openai(
    *, stream: list | None = None, response: object | None = None, error: Exception | None = None
):
    """替身 AsyncOpenAI：stream=True 回放 ``stream``，非流式返回 ``response``，
    ``error`` 非空时 create 当场抛。"""
    calls: list[dict] = []

    class FakeClient:
        def __init__(self, *args, **kwargs):
            self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

        async def _create(self, **kwargs):
            calls.append(kwargs)
            if error is not None:
                raise error
            if kwargs.get("stream"):
                return _Stream(stream or [])
            return response

        async def close(self):
            return None

    return FakeClient, calls


def _status_error(status: int, message: str, *, headers: dict | None = None) -> APIStatusError:
    request = httpx.Request("POST", "https://example.invalid/v1/chat/completions")
    return APIStatusError(
        message,
        response=httpx.Response(status, headers=headers or {}, request=request),
        body={"error": {"message": message}},
    )


def _connection_error() -> APIConnectionError:
    return APIConnectionError(
        request=httpx.Request("POST", "https://example.invalid/v1/chat/completions")
    )


async def _ledger(client, **params) -> list[dict]:
    query = "&".join(f"{key}={value}" for key, value in params.items())
    return (await client.get(f"/config/model-invocations?{query}")).json()["items"]


@pytest.fixture
async def bound_models(session):
    """能力先绑定直连部署：没绑定的话路由直接报未绑定，压根走不到线协议这一层。"""
    return await seed_default_bindings(session)


# ---------------------------------------------------------------------------
# PreparedChatCall.stream_chunks / complete_chunks
# ---------------------------------------------------------------------------


async def test_stream_chunks_translates_wire_protocol_and_marks_first_token(
    client, bound_models, monkeypatch
) -> None:
    fake, calls = _fake_openai(
        stream=[
            _chunk(reasoning="mull"),
            _chunk("Hel"),
            _chunk("lo", finish="stop", usage={"prompt_tokens": 5, "completion_tokens": 2}),
        ]
    )
    monkeypatch.setattr(model_runtime, "AsyncOpenAI", fake)
    route = await prepare_chat_route("explain-standard", "chat.stream")
    request = {"messages": [{"role": "user", "content": "hi"}], "stream": True}

    async with route.prepare_call(request, timeout=5.0) as call:
        chunks = [c async for c in call.stream_chunks(model=route.snapshot.model, **request)]
        assert call.first_token_ms is not None and call.first_token_ms >= 0
        assert call.reported_model == "fake-model"
        assert call.provider_request_id == "req-1"
        assert call.raw_usage == {"prompt_tokens": 5, "completion_tokens": 2}
        await call.succeed(response={"text": "Hello"})

    assert calls[0]["stream"] is True
    assert [type(c) for c in chunks] == [
        BlockStartChunk,
        ReasoningDeltaChunk,
        BlockStartChunk,
        TextDeltaChunk,
        TextDeltaChunk,
        BlockEndChunk,
        BlockEndChunk,
        UsageChunk,
        FinishChunk,
    ]
    assert isinstance(chunks[-1], FinishChunk) and isinstance(chunks[-1].reason, StopFinish)
    assert isinstance(chunks[1], ReasoningDeltaChunk) and chunks[1].text == "mull"
    assert [c.text for c in chunks if isinstance(c, TextDeltaChunk)] == ["Hel", "lo"]

    row = next(
        item
        for item in await _ledger(client, plugin_id="openai", limit=10)
        if item["provider_request_id"] == "req-1"
    )
    assert row["status"] == "succeeded"
    assert row["model"] == "fake-model"
    assert row["usage"] == {"prompt_tokens": 5, "completion_tokens": 2}
    assert row["response"]["text"] == "Hello"
    assert row["response"]["first_token_ms"] == call.first_token_ms
    assert row["error_code"] is None


async def test_complete_chunks_uses_same_translation(bound_models, monkeypatch) -> None:
    message = SimpleNamespace(content="plain", reasoning_content="thinking", tool_calls=None)
    fake, calls = _fake_openai(
        response=SimpleNamespace(
            id="req-sync",
            model="sync-model",
            usage={"prompt_tokens": 3, "completion_tokens": 1},
            choices=[SimpleNamespace(message=message, finish_reason="stop")],
        )
    )
    monkeypatch.setattr(model_runtime, "AsyncOpenAI", fake)
    route = await prepare_chat_route("explain-standard", "chat.complete")
    request = {"messages": [{"role": "user", "content": "hi"}]}

    async with route.prepare_call(request, timeout=5.0) as call:
        chunks = await call.complete_chunks(model=route.snapshot.model, stream=True, **request)
        await call.succeed(response={"text": "plain"})

    assert "stream" not in calls[0]
    assert call.reported_model == "sync-model" and call.provider_request_id == "req-sync"
    assert call.first_token_ms is not None
    assert [c.text for c in chunks if isinstance(c, ReasoningDeltaChunk)] == ["thinking"]
    assert [c.text for c in chunks if isinstance(c, TextDeltaChunk)] == ["plain"]
    assert isinstance(chunks[-1], FinishChunk)


# ---------------------------------------------------------------------------
# 失败归一与 error_code 落库
# ---------------------------------------------------------------------------


async def test_upstream_status_error_persists_error_code(client, bound_models, monkeypatch) -> None:
    fake, _calls = _fake_openai(error=_status_error(429, "slow down", headers={"retry-after": "3"}))
    monkeypatch.setattr(model_runtime, "AsyncOpenAI", fake)
    route = await prepare_chat_route("explain-standard", "chat.stream")
    request = {"messages": [{"role": "user", "content": "hi"}], "stream": True}

    with pytest.raises(APIStatusError):
        async with route.prepare_call(request, timeout=5.0) as call:
            async for _ in call.stream_chunks(model=route.snapshot.model, **request):
                pass

    assert call.state == "failed"
    assert call.failure is not None
    assert call.failure.code == "RATE_LIMIT"
    assert call.failure.status == 429
    assert call.failure.provider_retry_after_ms == 3000

    row = next(
        item
        for item in await _ledger(client, plugin_id="openai", status="failed", limit=10)
        if item["error_code"] == "RATE_LIMIT"
    )
    assert row["error_type"] == "APIStatusError"
    assert "slow down" in row["error_message"]


async def test_mid_stream_failure_surfaces_as_llm_unavailable_with_failure(
    client, bound_models, monkeypatch
) -> None:
    fake, _calls = _fake_openai(stream=[_chunk("par"), _connection_error()])
    monkeypatch.setattr(model_runtime, "AsyncOpenAI", fake)

    events: list[dict] = []
    with pytest.raises(llm.LLMUnavailable) as caught:
        async for event in llm.stream_text("explain-standard", [{"role": "user", "content": "hi"}]):
            events.append(event)

    assert events == [{"type": "delta", "text": "par"}]
    assert caught.value.failure.code == "TRANSPORT"
    assert str(caught.value) == str(caught.value.__cause__)
    assert isinstance(caught.value.__cause__, APIConnectionError)

    row = next(
        item
        for item in await _ledger(client, plugin_id="openai", status="failed", limit=10)
        if item["error_code"] == "TRANSPORT"
    )
    assert row["error_type"] == "APIConnectionError"


async def test_empty_completion_is_a_coded_failure(client, bound_models, monkeypatch) -> None:
    fake, _calls = _fake_openai(
        response=SimpleNamespace(
            id="req-empty",
            model="fake-model",
            usage=None,
            choices=[SimpleNamespace(message=SimpleNamespace(content=None), finish_reason="stop")],
        )
    )
    monkeypatch.setattr(model_runtime, "AsyncOpenAI", fake)

    with pytest.raises(llm.LLMUnavailable) as caught:
        await llm.complete_text("explain-standard", [{"role": "user", "content": "hi"}])

    assert caught.value.failure.code == "EMPTY_RESPONSE"
    row = next(
        item
        for item in await _ledger(client, plugin_id="openai", status="failed", limit=10)
        if item["provider_request_id"] == "req-empty" or item["error_code"] == "EMPTY_RESPONSE"
    )
    assert row["error_code"] == "EMPTY_RESPONSE"
    assert row["error_type"] == "LLMUnavailable"


async def test_unresolved_route_failure_is_coded(client, monkeypatch) -> None:
    async def _unresolved(*_args, **_kwargs):
        raise model_runtime.ModelRuntimeError("网关里没有这个别名")

    monkeypatch.setattr(llm, "prepare_chat_route", _unresolved)
    with pytest.raises(llm.LLMUnavailable) as caught:
        await llm.complete_text("missing-alias", [{"role": "user", "content": "hi"}])
    assert str(caught.value) == "网关里没有这个别名"
    assert caught.value.failure.code == llm.UNRESOLVED_ROUTE_CODE

    row = (await _ledger(client, plugin_id="unresolved", limit=5))[0]
    assert row["status"] == "failed" and row["error_code"] == "INVALID_REQUEST"


def test_chat_failure_normalizes_every_exception_shape() -> None:
    assert chat_failure(_status_error(401, "bad key")).code == "AUTH"
    assert chat_failure(_status_error(503, "down")).code == "SERVER"
    assert chat_failure(_connection_error()).code == "TRANSPORT"
    assert chat_failure(TimeoutError("slow")).code == "TIMEOUT"
    assert chat_failure(RuntimeError("上游炸了")).code == "UNKNOWN"
    carried = llm.LLMUnavailable("x", failure=chat_failure(_status_error(429, "r")))
    assert chat_failure(carried).code == "RATE_LIMIT"
    default = llm.LLMUnavailable("没说原因")
    assert default.failure.code == "UNKNOWN" and default.failure.message == "没说原因"
    assert str(default) == "没说原因"


# ---------------------------------------------------------------------------
# 推理块不混入正文
# ---------------------------------------------------------------------------


async def test_stream_text_keeps_reasoning_out_of_visible_text(bound_models, monkeypatch) -> None:
    fake, _calls = _fake_openai(
        stream=[
            _chunk(reasoning="let me"),
            _chunk(reasoning=" think"),
            _chunk("Hello"),
            _chunk(" world", finish="stop"),
        ]
    )
    monkeypatch.setattr(model_runtime, "AsyncOpenAI", fake)

    events = [
        event
        async for event in llm.stream_text("explain-standard", [{"role": "user", "content": "hi"}])
    ]
    assert [e["text"] for e in events if e["type"] == "delta"] == ["Hello", " world"]
    assert events[-1]["type"] == "done"
    assert events[-1]["text"] == "Hello world"
    assert events[-1]["model"] == "fake-model"


async def test_stream_json_ignores_reasoning_when_parsing(bound_models, monkeypatch) -> None:
    payload = json.dumps({"ok": True})
    fake, calls = _fake_openai(stream=[_chunk(reasoning="{not json}"), _chunk(payload)])
    monkeypatch.setattr(model_runtime, "AsyncOpenAI", fake)

    events = [event async for event in llm.stream_json("explain-standard", "sys", "user")]
    assert [e["text"] for e in events if e["type"] == "delta"] == [payload]
    assert events[-1]["result"] == {"ok": True}
    assert events[-1]["schema_error"] is False
    assert len(calls) == 1


async def test_complete_json_reads_only_text_content(bound_models, monkeypatch) -> None:
    message = SimpleNamespace(content='{"ok": true}', reasoning_content="<think>no</think>")
    fake, _calls = _fake_openai(
        response=SimpleNamespace(
            id="req-json",
            model="json-model",
            usage=None,
            choices=[SimpleNamespace(message=message, finish_reason="stop")],
        )
    )
    monkeypatch.setattr(model_runtime, "AsyncOpenAI", fake)
    result, model, _latency = await llm.complete_json("explain-standard", "sys", "user")
    assert result == {"ok": True}
    assert model == "json-model"


# ---------------------------------------------------------------------------
# 内核单例与工具作用域
# ---------------------------------------------------------------------------


def test_kernel_singleton_and_named_scopes() -> None:
    assert get_kernel() is kernel
    fresh = build_kernel()
    assert fresh.bus is fresh.llm.bus is fresh.tools.bus is fresh.approval.bus

    scope = fresh.scope("gpt-creative")
    assert scope.startswith("gpt-creative#")
    assert fresh.scope("gpt-creative") == scope
    assert fresh.scope_name(scope) == "gpt-creative"
    child = fresh.scope("turn", parent="gpt-creative")
    assert fresh.bus.scopes.parent(child) == scope

    fresh.bus.scopes.dispose(scope)
    assert fresh.scope("gpt-creative") != scope  # 释放后再取是新键

    with pytest.raises(ValueError, match="同一个 EventBus"):
        Kernel(EventBus(), fresh.llm, fresh.tools, fresh.approval)


def test_agent_tools_register_into_gpt_creative_scope_only() -> None:
    fresh = build_kernel()
    scope = ensure_registered(fresh)
    assert scope == fresh.scope(GPT_CREATIVE_SCOPE)
    assert ensure_registered(fresh) == scope  # 幂等

    # 出图与三类长任务工具都只在这个作用域里可见，全局层一个都不落
    visible = fresh.tools.view(scope)
    assert image_generate.TOOL_NAME in visible
    assert not (set(visible) & set(fresh.tools.view()))

    schemas = {item["function"]["name"]: item["function"] for item in fresh.tools.schemas(scope)}
    function = schemas[image_generate.TOOL_NAME]
    assert function["parameters"]["required"] == ["prompt"]
    assert set(function["parameters"]["properties"]) == {"prompt", "size"}


def test_tools_for_size_locks_the_size_enum() -> None:
    declared = {
        item["function"]["name"]: item["function"]
        for item in studio_gpt.tools_for_size("1088x1920")
    }
    generate = declared[studio_gpt.TOOL_NAME]
    size = generate["parameters"]["properties"]["size"]
    assert size["enum"] == ["1088x1920"]
    assert "prompt" in generate["parameters"]["properties"]


# ---------------------------------------------------------------------------
# studio_gpt：工具调用经 ToolRuntime
# ---------------------------------------------------------------------------


@pytest.fixture
def fake_storage():
    fake = FakeStorage()
    storage_mod.set_storage(fake)
    yield fake
    storage_mod.set_storage(None)


class _ScriptedCompletions:
    def __init__(self, script: list) -> None:
        self.script = list(script)
        self.calls: list[dict] = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        return _Stream(self.script.pop(0) if self.script else [])


class _ScriptedClient:
    def __init__(self, script: list) -> None:
        self.completions = _ScriptedCompletions(script)
        self.chat = SimpleNamespace(completions=self.completions)

    async def close(self) -> None:
        return None


IMAGE_CALL = [
    _chunk(tool_calls=[_tool_piece(0, "generate_image", "", "call_a")]),
    _chunk(tool_calls=[_tool_piece(0, None, '{"prompt":')]),
    _chunk(tool_calls=[_tool_piece(0, None, '"a red apple"}')], finish="tool_calls"),
]


async def test_studio_gpt_tool_call_runs_through_tool_runtime(
    session, bound_models, monkeypatch, fake_storage
) -> None:
    rendered: list[dict] = []

    async def _render(prompt: str, **kwargs):
        rendered.append({"prompt": prompt, **kwargs})
        return RenderResult(images=[noise_png()], model_reported="fake-image", latency_ms=3)

    monkeypatch.setattr(imagegen, "render_images", _render)
    fake = _ScriptedClient([IMAGE_CALL, [_chunk("画好了")]])
    monkeypatch.setattr(studio_gpt, "_client", lambda _route: fake)

    chat = StudioGptChat(title="苹果")
    session.add(chat)
    await session.commit()
    await session.refresh(chat)

    observed: list[tuple] = []
    dispose = get_kernel().bus.on(
        "tools/result", lambda exec, result: observed.append((exec, result))
    )
    try:
        events = [event async for event in studio_gpt.stream_turn(session, chat, "画个苹果")]
    finally:
        dispose()

    image = next(payload for name, payload in events if name == "image")
    assert image["prompt"] == "a red apple"
    assert image["url"].startswith("/api/images/assets/")

    # 执行经过了 ToolRuntime：tools/result 在 gpt-creative 作用域里派发，参数是锁过画幅的
    assert len(observed) == 1
    exec, result = observed[0]
    assert exec.name == image_generate.TOOL_NAME
    assert exec.call_id == "call_a"
    assert exec.scope == get_kernel().scope(GPT_CREATIVE_SCOPE)
    assert exec.agent_id == f"gpt-chat:{chat.id}"
    assert dict(exec.arguments) == {"prompt": "a red apple", "size": studio_gpt.DEFAULT_SIZE}
    assert result.is_error is False
    assert isinstance(result.value, image_generate.GenerateImageResult)
    assert result.value.asset_id == image["asset_id"]
    assert rendered[0]["size"] == studio_gpt.DEFAULT_SIZE

    # 声明来自内核作用域（size 锁成本轮画幅），回填的 tool 消息是 render 出来的载荷
    declared = {
        item["function"]["name"]: item["function"] for item in fake.completions.calls[0]["tools"]
    }
    assert image_generate.TOOL_NAME in declared
    assert declared[image_generate.TOOL_NAME]["parameters"]["properties"]["size"]["enum"] == [
        studio_gpt.DEFAULT_SIZE
    ]
    tool_message = fake.completions.calls[1]["messages"][-1]
    assert tool_message["role"] == "tool" and tool_message["tool_call_id"] == "call_a"
    assert json.loads(tool_message["content"])["asset_id"] == image["asset_id"]

    done = events[-1]
    assert done[0] == "done"
    assert done[1]["turn"]["asset_ids"] == [image["asset_id"]]
    assert done[1]["turn"]["content"] == "画好了"
    assert not any(name == "error" for name, _ in events)


async def test_studio_gpt_tool_failure_is_reported_back_to_the_model(
    session, bound_models, monkeypatch, fake_storage
) -> None:
    async def _boom(prompt: str, **kwargs):
        raise imagegen.ImageGenError("content", "提示词被上游安全策略拒绝：nope")

    monkeypatch.setattr(imagegen, "render_images", _boom)
    fake = _ScriptedClient([IMAGE_CALL, [_chunk("换个说法？")]])
    monkeypatch.setattr(studio_gpt, "_client", lambda _route: fake)

    chat = StudioGptChat(title="失败")
    session.add(chat)
    await session.commit()
    await session.refresh(chat)

    observed: list[tuple] = []
    dispose = get_kernel().bus.on(
        "tools/result", lambda exec, result: observed.append((exec, result))
    )
    try:
        events = [event async for event in studio_gpt.stream_turn(session, chat, "画个东西")]
    finally:
        dispose()

    assert not any(name == "image" for name, _ in events)
    _exec, result = observed[0]
    assert result.is_error is True and result.error is not None
    assert result.error.name == "ImageGenError"
    tool_result = json.loads(fake.completions.calls[1]["messages"][-1]["content"])
    assert tool_result["ok"] is False and "安全策略" in tool_result["error"]
    assert events[-1][1]["turn"]["content"] == "换个说法？"


async def test_studio_gpt_empty_round_is_a_reported_error(
    session, bound_models, monkeypatch
) -> None:
    fake = _ScriptedClient([[]])
    monkeypatch.setattr(studio_gpt, "_client", lambda _route: fake)
    chat = StudioGptChat(title="空")
    session.add(chat)
    await session.commit()
    await session.refresh(chat)

    events = [event async for event in studio_gpt.stream_turn(session, chat, "说点什么")]
    error = next(payload for name, payload in events if name == "error")
    assert "no content" in error["detail"]
    assert events[-1][0] == "done"
    assert events[-1][1]["turn"]["error"] == error["detail"]
