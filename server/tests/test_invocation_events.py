"""模型调用台账事件化：事件顺序与攒批、脱敏、上下文升列、过滤与游标分页、SSE invocation 帧。

LLM 全程替身，不发网络；事件经异步写入器落库，断言前先 ``flush_invocation_events``。
"""

from __future__ import annotations

import json
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from openai import APIConnectionError

import domain.model_runtime as model_runtime
from domain import model_invocations
from domain.kernel.llm_types import (
    BlockEndChunk,
    BlockStartChunk,
    FinishChunk,
    ReasoningDeltaChunk,
    StopFinish,
    TextBlock,
    TextDeltaChunk,
    TokenUsage,
    ToolCallDeltaChunk,
    ToolCallsFinish,
    UsageChunk,
)
from domain.model_invocations import (
    ChunkEventBatcher,
    InvocationEventWriter,
    ModelInvocationSpan,
    PendingEvent,
    flush_invocation_events,
    invocation_context,
    parse_invocation_cursor,
)
from domain.model_runtime import prepare_chat_route
from domain.task_event_stream import KEEP_ALIVE_FRAME, iter_sse_frames
from tests.model_binding_stub import seed_default_bindings
from tests.test_kernel_wiring import _chunk, _connection_error, _fake_openai

# ---------------------------------------------------------------------------
# 替身与小工具
# ---------------------------------------------------------------------------


class _Recorder:
    """替身 span：只收事件，不落库。"""

    def __init__(self) -> None:
        self.events: list[tuple[str, dict]] = []
        self.finish_reason: str | None = None

    def record_event(self, type: str, data: dict | None = None) -> int:
        self.events.append((type, data or {}))
        return len(self.events)

    def note_finish_reason(self, reason: str) -> None:
        self.finish_reason = reason

    def elapsed_ms(self) -> int:
        return 0


class _Stopper:
    def __init__(self, polls: int) -> None:
        self.remaining = polls

    async def __call__(self) -> bool:
        self.remaining -= 1
        return self.remaining < 0


def _parse(frame: str) -> dict:
    fields: dict = {}
    for line in frame.rstrip("\n").split("\n"):
        key, _, value = line.partition(": ")
        fields[key] = value
    if "data" in fields:
        fields["data"] = json.loads(fields["data"])
    return fields


async def _events(client, invocation_id: str) -> list[dict]:
    await flush_invocation_events()
    response = await client.get(f"/config/model-invocations/{invocation_id}/events")
    assert response.status_code == 200
    return response.json()["items"]


async def _ids(client, **params) -> list[str]:
    response = await client.get("/config/model-invocations", params=params)
    assert response.status_code == 200
    return [item["id"] for item in response.json()["items"]]


# ---------------------------------------------------------------------------
# 攒批器：纯逻辑
# ---------------------------------------------------------------------------


def test_batcher_merges_text_until_size_or_time() -> None:
    clock = {"now": 0}
    span = _Recorder()
    batcher = ChunkEventBatcher(span, clock_ms=lambda: clock["now"])  # type: ignore[arg-type]
    batcher.push(BlockStartChunk(index=0, block_type="text"))
    for piece in ("Hel", "lo, ", "world"):
        batcher.push(TextDeltaChunk(index=0, text=piece))
    # 12 个字符、同一毫秒：还在攒
    assert span.events == []
    clock["now"] = 250
    # 首个 delta 起超过 200ms：先把前一批落掉，新 delta 另起一批
    batcher.push(TextDeltaChunk(index=0, text="!"))
    assert [(kind, data["text"]) for kind, data in span.events] == [("chunk.text", "Hello, world")]
    assert span.events[0][1]["elapsed_ms"] == 0
    assert span.events[0][1]["end_ms"] == 0
    assert span.events[0][1]["chars"] == 12
    # 攒到 64 字符立即落
    batcher.push(TextDeltaChunk(index=0, text="x" * 70))
    assert span.events[1][1]["text"] == "!" + "x" * 70
    assert span.events[1][1]["elapsed_ms"] == 250
    # block-end 把尾巴落掉
    batcher.push(TextDeltaChunk(index=0, text="tail"))
    batcher.push(BlockEndChunk(index=0, block=TextBlock(text="ignored")))
    assert span.events[2][1]["text"] == "tail"
    batcher.close()
    batcher.close()
    assert len(span.events) == 3


def test_batcher_keeps_chunk_order_across_types() -> None:
    span = _Recorder()
    batcher = ChunkEventBatcher(span, clock_ms=lambda: 5)  # type: ignore[arg-type]
    batcher.push(ReasoningDeltaChunk(index=0, text="mull"))
    # 块切换：推理先落，正文另起
    batcher.push(TextDeltaChunk(index=1, text="Hi"))
    batcher.push(TextDeltaChunk(index=1, text=""))
    batcher.push(
        ToolCallDeltaChunk(index=2, id="call-1", name="generate_image", arguments_delta='{"p')
    )
    batcher.push(ToolCallDeltaChunk(index=2, arguments_delta='rompt":1}'))
    batcher.push(UsageChunk(usage=TokenUsage(input_tokens=3, output_tokens=2)))
    batcher.push(FinishChunk(reason=ToolCallsFinish()))
    batcher.close()
    assert [kind for kind, _ in span.events] == [
        "chunk.reasoning",
        "chunk.text",
        "chunk.tool_delta",
        "chunk.tool_delta",
        "chunk.usage",
    ]
    assert span.events[0][1]["text"] == "mull"
    assert span.events[1][1]["text"] == "Hi"
    assert span.events[2][1]["name"] == "generate_image"
    assert span.events[3][1]["arguments_delta"] == 'rompt":1}'
    assert span.events[4][1]["usage"]["output_tokens"] == 2
    # FinishChunk 不单独成事件，reason 交给 span 随 finish 写
    assert span.finish_reason == "tool-calls"


# ---------------------------------------------------------------------------
# span：事件落库、顺序、脱敏、终态
# ---------------------------------------------------------------------------


async def test_span_events_persist_in_order_and_redacted(client) -> None:
    span = await ModelInvocationSpan(
        plugin_id="openai",
        operation="chat.stream",
        model="explain-standard",
        capability="explain-standard",
        request={"messages": [{"role": "user", "content": "hi"}]},
    ).start()
    span.request_header(
        {
            "messages": [
                {"role": "system", "content": "key sk-abcdefghijklmnop"},
                {"role": "user", "content": "hi"},
            ],
            "tools": [{"name": "generate_image"}],
            "api_key": "sk-secret",
        }
    )
    batcher = ChunkEventBatcher(span)
    batcher.push(TextDeltaChunk(index=0, text="Hel"))
    batcher.push(TextDeltaChunk(index=0, text="lo"))
    batcher.push(UsageChunk(usage=TokenUsage(input_tokens=5, output_tokens=2)))
    batcher.push(FinishChunk(reason=StopFinish()))
    batcher.close()
    await span.succeed(
        model="deepseek-chat",
        response={"text": "Hello"},
        usage={"prompt_tokens": 5, "completion_tokens": 2},
        provider_request_id="req-1",
    )

    events = await _events(client, span.id)
    assert [event["seq"] for event in events] == [1, 2, 3, 4]
    assert [event["type"] for event in events] == [
        "request.header",
        "chunk.text",
        "chunk.usage",
        "finish",
    ]
    assert all(event["invocation_id"] == span.id for event in events)
    assert all(event["time"] for event in events)
    # 事件 id 是全局递增游标
    assert [event["id"] for event in events] == sorted(event["id"] for event in events)

    header = events[0]["data"]
    assert header["api_key"] == "[REDACTED]"
    assert "sk-abcdefghijklmnop" not in json.dumps(header)
    assert header["messages"][1]["content"] == "hi"
    assert header["tools"] == [{"name": "generate_image"}]
    assert events[1]["data"]["text"] == "Hello"
    finish = events[3]["data"]
    assert finish["status"] == "succeeded"
    assert finish["finish_reason"] == "stop"
    assert finish["model"] == "deepseek-chat"
    assert finish["provider_request_id"] == "req-1"
    assert finish["usage"]["input_tokens"] == 5
    assert finish["first_token_ms"] is None
    assert finish["response"]["text"] == "Hello"


async def test_fail_writes_error_event_after_pending_text(client) -> None:
    span = await ModelInvocationSpan(
        plugin_id="openai", operation="chat.stream", model="m"
    ).start()
    batcher = ChunkEventBatcher(span)
    batcher.push(TextDeltaChunk(index=0, text="par"))
    batcher.close()
    await span.fail(RuntimeError("boom"), code="TRANSPORT")

    events = await _events(client, span.id)
    assert [event["type"] for event in events] == ["chunk.text", "error"]
    assert events[0]["data"]["text"] == "par"
    error = events[1]["data"]
    assert error["status"] == "failed"
    assert error["error_code"] == "TRANSPORT"
    assert error["error_type"] == "RuntimeError"
    assert error["error_message"] == "boom"
    with pytest.raises(ValueError, match="未知的模型调用事件类型"):
        span.record_event("chunk.bogus")


async def test_events_endpoint_404_for_unknown_invocation(client) -> None:
    response = await client.get("/config/model-invocations/nope/events")
    assert response.status_code == 404


# ---------------------------------------------------------------------------
# 运行时接线：request.header → chunk.* → finish / error
# ---------------------------------------------------------------------------


async def test_runtime_stream_records_header_chunks_and_finish(
    client, session, monkeypatch
) -> None:
    await seed_default_bindings(session)
    fake, _calls = _fake_openai(
        stream=[
            _chunk(reasoning="mull"),
            _chunk("Hel"),
            _chunk("lo", finish="stop", usage={"prompt_tokens": 5, "completion_tokens": 2}),
        ]
    )
    monkeypatch.setattr(model_runtime, "AsyncOpenAI", fake)
    route = await prepare_chat_route("explain-standard", "chat.stream")
    request = {
        "messages": [
            {"role": "system", "content": "be brief"},
            {"role": "user", "content": "hi"},
        ],
        "stream": True,
    }
    async with route.prepare_call(request, timeout=5.0) as call:
        async for _ in call.stream_chunks(model=route.snapshot.model, **request):
            pass
        await call.succeed(response={"text": "Hello"})

    assert call.invocation_id is not None
    events = await _events(client, call.invocation_id)
    assert [event["type"] for event in events] == [
        "request.header",
        "chunk.reasoning",
        "chunk.text",
        "chunk.usage",
        "finish",
    ]
    header = events[0]["data"]
    assert header["model"] == route.snapshot.model
    assert header["stream"] is True
    assert header["system"] == ["be brief"]
    assert header["messages"][1] == {"role": "user", "content": "hi"}
    assert events[1]["data"]["text"] == "mull"
    assert events[2]["data"]["text"] == "Hello"
    assert events[3]["data"]["usage"]["input_tokens"] == 5
    finish = events[4]["data"]
    assert finish["first_token_ms"] == call.first_token_ms
    assert finish["finish_reason"] == "stop"
    assert finish["model"] == "fake-model"

    body = (await client.get(f"/config/model-invocations/{call.invocation_id}/events")).json()
    assert body["invocation"]["status"] == "succeeded"
    assert body["invocation"]["first_token_ms"] == call.first_token_ms


async def test_runtime_mid_stream_failure_records_error_event_last(
    client, session, monkeypatch
) -> None:
    await seed_default_bindings(session)
    fake, _calls = _fake_openai(stream=[_chunk("par"), _connection_error()])
    monkeypatch.setattr(model_runtime, "AsyncOpenAI", fake)
    route = await prepare_chat_route("explain-standard", "chat.stream")
    request = {"messages": [{"role": "user", "content": "hi"}], "stream": True}

    with pytest.raises(APIConnectionError):
        async with route.prepare_call(request, timeout=5.0) as call:
            async for _ in call.stream_chunks(model=route.snapshot.model, **request):
                pass

    assert call.invocation_id is not None
    events = await _events(client, call.invocation_id)
    assert [event["type"] for event in events] == ["request.header", "chunk.text", "error"]
    assert events[1]["data"]["text"] == "par"
    assert events[2]["data"]["error_code"] == "TRANSPORT"
    assert events[2]["data"]["error_type"] == "APIConnectionError"


async def test_runtime_complete_records_same_event_shape(client, session, monkeypatch) -> None:
    await seed_default_bindings(session)
    message = SimpleNamespace(content="plain", reasoning_content=None, tool_calls=None)
    fake, _calls = _fake_openai(
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
        await call.complete_chunks(model=route.snapshot.model, **request)
        await call.succeed(response={"text": "plain"})

    assert call.invocation_id is not None
    events = await _events(client, call.invocation_id)
    assert [event["type"] for event in events] == [
        "request.header",
        "chunk.text",
        "chunk.usage",
        "finish",
    ]
    assert "stream" not in events[0]["data"]
    assert events[1]["data"]["text"] == "plain"
    assert events[3]["data"]["provider_request_id"] == "req-sync"


# ---------------------------------------------------------------------------
# 上下文升列、过滤、游标分页
# ---------------------------------------------------------------------------


async def test_context_ids_become_columns_and_filters(client) -> None:
    with invocation_context(
        source="studio.canvas",
        tool_id="infinite-canvas",
        canvas_id="12",
        node_id="node-7",
        flow_run_id="run-1",
        workflow_id=3,
    ):
        span = await ModelInvocationSpan(
            plugin_id="openai", operation="chat.complete", model="m", capability="chat-general"
        ).start()
        await span.fail(RuntimeError("boom"), code="RATE_LIMIT")
    other = await ModelInvocationSpan(
        plugin_id="openai", operation="chat.complete", model="m", capability="translate-fast"
    ).start()
    await other.succeed(response={"text": "ok"})

    response = await client.get("/config/model-invocations", params={"canvas_id": 12})
    items = response.json()["items"]
    assert [item["id"] for item in items] == [span.id]
    row = items[0]
    assert row["canvas_id"] == 12
    assert row["node_id"] == "node-7"
    assert row["flow_run_id"] == "run-1"
    assert row["tool_id"] == "infinite-canvas"
    # 升格成列的键不再重复留在 JSON context
    assert row["context"] == {"workflow_id": 3}

    for params in (
        {"node_id": "node-7"},
        {"flow_run_id": "run-1"},
        {"tool_id": "infinite-canvas"},
        {"source": "studio.canvas"},
        {"error_code": "RATE_LIMIT"},
        {"capability": "chat-general"},
        {"status": "failed"},
    ):
        assert await _ids(client, **params) == [span.id], params
    assert await _ids(client, canvas_id=99) == []
    assert await _ids(client, capability="translate-fast") == [other.id]

    future = (datetime.now(UTC) + timedelta(minutes=1)).isoformat()
    assert await _ids(client, since=future) == []
    past = (datetime.now(UTC) - timedelta(minutes=1)).isoformat()
    assert set(await _ids(client, since=past)) == {span.id, other.id}
    response = await client.get("/config/model-invocations", params={"since": "nope"})
    assert response.status_code == 400


async def test_cursor_pagination_walks_all_rows_without_duplicates(client) -> None:
    ids: list[str] = []
    for _ in range(5):
        span = await ModelInvocationSpan(
            plugin_id="openai", operation="chat.complete", model="m"
        ).start()
        await span.succeed(response={"text": "ok"})
        ids.append(span.id)

    seen: list[str] = []
    created: list[str] = []
    cursor: str | None = None
    pages = 0
    while pages < 10:
        params: dict = {"limit": 2, "plugin_id": "openai"}
        if cursor:
            params["cursor"] = cursor
        body = (await client.get("/config/model-invocations", params=params)).json()
        pages += 1
        seen.extend(item["id"] for item in body["items"])
        created.extend(item["created_at"] for item in body["items"])
        cursor = body["next_cursor"]
        if cursor is None:
            break
    assert pages == 3
    assert len(seen) == 5
    assert set(seen) == set(ids)
    assert created == sorted(created, reverse=True)
    response = await client.get("/config/model-invocations", params={"cursor": "garbage"})
    assert response.status_code == 400


def test_cursor_roundtrip() -> None:
    created = datetime(2026, 8, 22, 20, 0, 0, 123456, tzinfo=UTC)
    cursor = f"{created.isoformat()}|abc|def"
    assert parse_invocation_cursor(cursor) == (created, "abc|def")
    with pytest.raises(ValueError):
        parse_invocation_cursor("no-separator")


# ---------------------------------------------------------------------------
# 写入器：异步批量、失败只记日志、队列有界
# ---------------------------------------------------------------------------


async def test_event_write_failure_only_logs(monkeypatch, caplog) -> None:
    @asynccontextmanager
    async def broken():
        raise RuntimeError("db down")
        yield

    monkeypatch.setattr(model_invocations, "detached_session", broken)
    writer = InvocationEventWriter()
    event = PendingEvent("inv", 1, "chunk.text", datetime.now(UTC), {"text": "x"})
    assert writer.append(event) is True
    await writer.flush()
    assert "模型调用事件写入失败" in caplog.text


async def test_event_writer_drops_when_queue_is_full(session_factory) -> None:
    writer = InvocationEventWriter(limit=1)
    first = PendingEvent("inv", 1, "chunk.text", datetime.now(UTC), {"text": "a"})
    second = PendingEvent("inv", 2, "chunk.text", datetime.now(UTC), {"text": "b"})
    assert writer.append(first) is True
    # 消费者还没来得及跑：队列满了就丢，不阻塞调用链
    assert writer.append(second) is False
    assert writer.dropped == 1
    await writer.flush()


# ---------------------------------------------------------------------------
# SSE：invocation 帧
# ---------------------------------------------------------------------------


async def test_stream_emits_invocation_frames_for_new_and_finished_rows(session_factory) -> None:
    with invocation_context(canvas_id=7):
        span = await ModelInvocationSpan(
            plugin_id="openai", operation="chat.stream", model="m"
        ).start()
    sleeps: list[float] = []

    async def sleep(seconds: float) -> None:
        sleeps.append(seconds)
        if len(sleeps) == 1:
            await span.succeed(response={"text": "ok"})

    raw = [
        frame
        async for frame in iter_sse_frames(session_factory, should_stop=_Stopper(3), sleep=sleep)
    ]
    frames = [_parse(frame) for frame in raw if frame != KEEP_ALIVE_FRAME]
    invocation_frames = [frame for frame in frames if frame.get("event") == "invocation"]
    assert [frame["data"]["status"] for frame in invocation_frames] == ["running", "succeeded"]
    assert all(frame["data"]["id"] == span.id for frame in invocation_frames)
    assert invocation_frames[1]["data"]["response"] == {"text": "ok"}
    assert invocation_frames[1]["data"]["canvas_id"] == 7
    # 整快照帧不带 id 行，不推进游标
    assert all("id" not in frame for frame in invocation_frames)
    # 第三轮快照没变：不重复推，只有 keep-alive
    assert raw[-1] == KEEP_ALIVE_FRAME

    # 按画布过滤的订阅只收本画布的调用
    filtered = [
        frame
        async for frame in iter_sse_frames(
            session_factory, canvas_id=99, should_stop=_Stopper(1), sleep=sleep
        )
    ]
    assert filtered == [KEEP_ALIVE_FRAME]
    mine = [
        frame
        async for frame in iter_sse_frames(
            session_factory, canvas_id=7, should_stop=_Stopper(1), sleep=sleep
        )
    ]
    assert [_parse(frame)["data"]["id"] for frame in mine] == [span.id]
