"""模型调用台账：结构化日志、脱敏、任务上下文传播与逐步事件。

一次调用是一行 :class:`ModelInvocation` 快照加一串 :class:`ModelInvocationEvent`：
``request.header``（dispatch 前冻结的脱敏请求）→ ``chunk.*``（流式分块；文本 delta 按
:class:`ChunkEventBatcher` 合并成批）→ ``finish`` / ``error``。事件经
:class:`InvocationEventWriter` 的单消费者队列异步批量落库，写失败只记日志，不影响调用。
首 token、解码速率、工具耗时都能从事件的 ``elapsed_ms`` 派生，不另存列。
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager, contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from urllib.parse import parse_qsl, urlsplit, urlunsplit

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from domain.kernel.llm_types import (
    BlockEndChunk,
    FinishChunk,
    ReasoningDeltaChunk,
    StreamChunk,
    TextDeltaChunk,
    TokenUsage,
    ToolCallDeltaChunk,
    UsageChunk,
)
from domain.model_plugins import model_plugin_identity
from domain.models import ModelInvocation, ModelInvocationEvent
from domain.providers.openai_chat import map_usage

logger = logging.getLogger(__name__)

EVENT_REQUEST_HEADER = "request.header"
EVENT_CHUNK_TEXT = "chunk.text"
EVENT_CHUNK_REASONING = "chunk.reasoning"
EVENT_CHUNK_TOOL_DELTA = "chunk.tool_delta"
EVENT_CHUNK_USAGE = "chunk.usage"
EVENT_FINISH = "finish"
EVENT_ERROR = "error"
EVENT_TYPES = frozenset(
    {
        EVENT_REQUEST_HEADER,
        EVENT_CHUNK_TEXT,
        EVENT_CHUNK_REASONING,
        EVENT_CHUNK_TOOL_DELTA,
        EVENT_CHUNK_USAGE,
        EVENT_FINISH,
        EVENT_ERROR,
    }
)
# 文本 delta 攒到这么多字符或隔了这么久就落一条事件：行数可控，回放粒度仍够看
TEXT_BATCH_CHARS = 64
TEXT_BATCH_MS = 200
# 队列上限：上游疯狂吐字而数据库卡住时丢事件而不是撑爆内存
EVENT_QUEUE_LIMIT = 20_000
EVENT_WRITE_BATCH = 200
# 这些上下文键升格成 ModelInvocation 的列；其余键留在 JSON context
_COLUMN_CONTEXT_KEYS = ("canvas_id", "node_id", "flow_run_id", "tool_id")

_SECRET_MARKERS = (
    "api_key",
    "apikey",
    "access_key",
    "authorization",
    "cookie",
    "password",
    "secret",
)
_MAX_STRING = 8_000
_INLINE_SECRET_PATTERNS = (
    re.compile(r"(?i)(bearer\s+)[a-z0-9._~+/=-]+"),
    re.compile(r"(?i)((?:api[_-]?key|access[_-]?token|token|secret|password)\s*[=:]\s*)[^\s,;&]+"),
    re.compile(r"\bsk-[a-zA-Z0-9_-]{8,}\b"),
)
_context: ContextVar[dict[str, Any] | None] = ContextVar("model_invocation_context", default=None)


def _is_secret(key: str) -> bool:
    normalized = key.lower().replace("-", "_")
    if any(marker in normalized for marker in _SECRET_MARKERS):
        return True
    return normalized == "token" or normalized.endswith("_token")


def _safe_string(value: str) -> str:
    if value.startswith("data:"):
        return f"[DATA_URL {len(value)} chars]"
    sanitized = value
    for pattern in _INLINE_SECRET_PATTERNS:
        sanitized = pattern.sub(r"\1[REDACTED]" if pattern.groups else "[REDACTED]", sanitized)
    if sanitized.startswith(("http://", "https://")):
        parsed = urlsplit(sanitized)
        query = parse_qsl(parsed.query, keep_blank_values=True)
        sensitive_query = any(
            _is_secret(key)
            or key.lower().startswith(("x-amz-", "x-goog-", "x-cos-"))
            or key.lower() in {"credential", "key-pair-id", "policy", "sig", "signature"}
            for key, _value in query
        )
        if sensitive_query:
            sanitized = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "[REDACTED]", ""))
    if len(sanitized) > _MAX_STRING:
        return sanitized[:_MAX_STRING] + f"…[TRUNCATED {len(sanitized) - _MAX_STRING} chars]"
    return sanitized


def safe_payload(value: Any, *, key: str = "", depth: int = 0) -> Any:
    """保留可调试内容，移除密钥、二进制和超长 data URL。"""
    if key and _is_secret(key):
        return "[REDACTED]"
    if depth >= 8:
        return "[MAX_DEPTH]"
    if value is None or isinstance(value, bool | int | float):
        return value
    if isinstance(value, bytes | bytearray | memoryview):
        return f"[BINARY {len(value)} bytes]"
    if isinstance(value, str):
        return _safe_string(value)
    if isinstance(value, dict):
        return {
            str(item_key): safe_payload(item_value, key=str(item_key), depth=depth + 1)
            for item_key, item_value in value.items()
        }
    if isinstance(value, (list, tuple, set, frozenset)):
        return [safe_payload(item, depth=depth + 1) for item in value]
    return str(value)


def _token(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def normalize_usage(usage: Any) -> TokenUsage | None:
    """任意线协议 usage → 五桶 TokenUsage；认不出形状时返回 None，不猜。

    OpenAI / DeepSeek 对话用 ``prompt_tokens`` / ``completion_tokens``（含缓存命中，由
    :func:`map_usage` 扣减）；OpenAI 图片接口与内核自己的账目已经是 ``input_tokens`` /
    ``output_tokens`` 口径，直接取。
    """
    if usage is None:
        return None
    if hasattr(usage, "model_dump"):
        usage = usage.model_dump(exclude_none=True)
    if not isinstance(usage, dict):
        return None
    if "prompt_tokens" in usage or "completion_tokens" in usage:
        return map_usage(usage)
    if "input_tokens" not in usage and "output_tokens" not in usage:
        return None
    details = usage.get("input_tokens_details")
    cache_read = _token(usage.get("cache_read_tokens"))
    if cache_read is None and isinstance(details, dict):
        cache_read = _token(details.get("cached_tokens"))
    return TokenUsage(
        input_tokens=max((_token(usage.get("input_tokens")) or 0) - (cache_read or 0), 0),
        output_tokens=_token(usage.get("output_tokens")) or 0,
        cache_read_tokens=cache_read,
        cache_write_tokens=_token(usage.get("cache_write_tokens")),
        reasoning_tokens=_token(usage.get("reasoning_tokens")),
    )


def usage_columns(usage: Any) -> dict[str, int | None]:
    """归一化后的五桶，按台账列名给出；认不出形状时五列全空。"""
    normalized = normalize_usage(usage)
    if normalized is None:
        return dict.fromkeys(
            (
                "input_tokens",
                "output_tokens",
                "cache_read_tokens",
                "cache_write_tokens",
                "reasoning_tokens",
            )
        )
    return normalized.model_dump()


@contextmanager
def invocation_context(**values: Any) -> Iterator[None]:
    """给同一异步调用链附加 task/canvas/tool 等关联字段。"""
    merged = {
        **(_context.get() or {}),
        **{key: value for key, value in values.items() if value is not None},
    }
    token = _context.set(merged)
    try:
        yield
    finally:
        _context.reset(token)


@asynccontextmanager
async def detached_session() -> AsyncIterator[AsyncSession]:
    from app.db import SessionFactory

    async with SessionFactory() as session:
        yield session


async def _persist_start(row: ModelInvocation) -> bool:
    try:
        async with detached_session() as session:
            session.add(row)
            await session.commit()
        return True
    except Exception as exc:
        logger.warning("模型调用台账写入失败 id=%s: %s", row.id, exc)
        return False


async def _persist_finish(invocation_id: str, values: dict[str, Any]) -> None:
    try:
        async with detached_session() as session:
            row = await session.get(ModelInvocation, invocation_id)
            if row is None:
                return
            for key, value in values.items():
                setattr(row, key, value)
            await session.commit()
    except Exception as exc:
        logger.warning("模型调用台账更新失败 id=%s: %s", invocation_id, exc)


@dataclass(frozen=True)
class PendingEvent:
    invocation_id: str
    seq: int
    type: str
    time: datetime
    data: dict[str, Any] | None


class InvocationEventWriter:
    """事件的异步批量落库：``append`` 只进队列，单个消费者按批写，落库失败只记日志。

    消费者任务惰性绑定到当前事件循环；换了循环（测试逐例新建循环、worker 重启）就重建
    队列与任务。``flush`` 等队列清空，供测试和关停前收尾用。
    """

    def __init__(
        self, *, limit: int = EVENT_QUEUE_LIMIT, batch_size: int = EVENT_WRITE_BATCH
    ) -> None:
        self.limit = limit
        self.batch_size = batch_size
        self._loop: asyncio.AbstractEventLoop | None = None
        self._queue: asyncio.Queue[PendingEvent] | None = None
        self._task: asyncio.Task[None] | None = None
        self.dropped = 0

    def _ensure(self) -> asyncio.Queue[PendingEvent] | None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return None
        if self._queue is None or self._loop is not loop or self._task is None or self._task.done():
            self._loop = loop
            self._queue = asyncio.Queue(maxsize=self.limit)
            self._task = loop.create_task(self._consume(self._queue), name="invocation-events")
        return self._queue

    def append(self, event: PendingEvent) -> bool:
        queue = self._ensure()
        if queue is None:
            logger.warning(
                "模型调用事件丢弃（无事件循环）id=%s seq=%s", event.invocation_id, event.seq
            )
            return False
        try:
            queue.put_nowait(event)
        except asyncio.QueueFull:
            self.dropped += 1
            logger.warning(
                "模型调用事件队列已满，丢弃 id=%s seq=%s", event.invocation_id, event.seq
            )
            return False
        return True

    async def flush(self) -> None:
        queue = self._queue
        if queue is None or self._loop is not asyncio.get_running_loop():
            return
        await queue.join()

    async def _consume(self, queue: asyncio.Queue[PendingEvent]) -> None:
        while True:
            batch = [await queue.get()]
            while len(batch) < self.batch_size:
                try:
                    batch.append(queue.get_nowait())
                except asyncio.QueueEmpty:
                    break
            try:
                await self._write(batch)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("模型调用事件写入失败（%d 条）: %s", len(batch), exc)
            finally:
                for _ in batch:
                    queue.task_done()

    @staticmethod
    async def _write(batch: list[PendingEvent]) -> None:
        async with detached_session() as session:
            session.add_all(
                ModelInvocationEvent(
                    invocation_id=item.invocation_id,
                    seq=item.seq,
                    type=item.type,
                    time=item.time,
                    data=item.data,
                )
                for item in batch
            )
            await session.commit()


event_writer = InvocationEventWriter()


async def flush_invocation_events() -> None:
    """等待已入队的事件全部落库（或落库失败被记日志）。"""
    await event_writer.flush()


def _coerce_int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _coerce_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


class ModelInvocationSpan:
    def __init__(
        self,
        *,
        plugin_id: str,
        operation: str,
        model: str | None,
        capability: str | None = None,
        deployment_id: int | None = None,
        request: dict[str, Any] | None = None,
        plugin_version: str | None = None,
        plugin_generation: int | None = None,
        runtime_generation: int | None = None,
        parent_invocation_id: str | None = None,
        attempt: int = 1,
    ) -> None:
        inherited = dict(_context.get() or {})
        if plugin_version is None or plugin_generation is None:
            try:
                current_version, current_generation = model_plugin_identity(plugin_id)
            except ValueError:
                current_version, current_generation = None, None
            plugin_version = plugin_version or current_version
            plugin_generation = plugin_generation or current_generation
        self.id = uuid.uuid4().hex
        self._started = time.monotonic()
        self._first_token_ms: int | None = None
        self._persisted = False
        self._seq = 0
        self._finish_reason: str | None = None
        # created_at 由这里给定而不是交给数据库默认值：SQLite 的 CURRENT_TIMESTAMP 只有秒精度，
        # 游标分页按 (created_at, id) 做键集比较时会把同一行再翻出来
        self._row = ModelInvocation(
            id=self.id,
            plugin_id=plugin_id,
            plugin_version=plugin_version,
            plugin_generation=plugin_generation,
            runtime_generation=runtime_generation,
            operation=operation,
            capability=capability,
            deployment_id=deployment_id or inherited.pop("deployment_id", None),
            task_id=inherited.pop("task_id", None),
            source=inherited.pop("source", None),
            canvas_id=_coerce_int(inherited.pop("canvas_id", None)),
            node_id=_coerce_str(inherited.pop("node_id", None)),
            flow_run_id=_coerce_str(inherited.pop("flow_run_id", None)),
            tool_id=_coerce_str(inherited.pop("tool_id", None)),
            request=safe_payload(request),
            status="running",
            parent_invocation_id=parent_invocation_id,
            attempt=max(1, int(attempt)),
            context=safe_payload(inherited) or None,
            created_at=datetime.now(UTC),
        )
        self._row.model = model

    async def start(self) -> ModelInvocationSpan:
        self._persisted = await _persist_start(self._row)
        logger.info(
            "model.invoke.start id=%s plugin=%s operation=%s model=%s capability=%s",
            self.id,
            self._row.plugin_id,
            self._row.operation,
            self._row.model,
            self._row.capability,
        )
        return self

    def mark_first_token(self) -> int:
        """记下首个可见 token 到达的时刻（相对 span 起点的毫秒数）；只有第一次生效。"""
        if self._first_token_ms is None:
            self._first_token_ms = self.elapsed_ms()
        return self._first_token_ms

    @property
    def first_token_ms(self) -> int | None:
        return self._first_token_ms

    @property
    def event_seq(self) -> int:
        """已追加的事件数；下一条事件的 seq 是它加一。"""
        return self._seq

    def elapsed_ms(self) -> int:
        return int((time.monotonic() - self._started) * 1000)

    def record_event(self, type: str, data: dict[str, Any] | None = None) -> int | None:
        """追加一条事件（异步落库）。台账行没写成时事件也无处挂靠，直接跳过。"""
        if type not in EVENT_TYPES:
            raise ValueError(f"未知的模型调用事件类型：{type}")
        if not self._persisted:
            return None
        self._seq += 1
        event_writer.append(
            PendingEvent(
                invocation_id=self.id,
                seq=self._seq,
                type=type,
                time=datetime.now(UTC),
                data=safe_payload(data) if data is not None else None,
            )
        )
        return self._seq

    def request_header(self, header: dict[str, Any]) -> int | None:
        """dispatch 前的请求快照：messages / system / tools 等，脱敏后落 ``request.header``。"""
        return self.record_event(EVENT_REQUEST_HEADER, {**header, "elapsed_ms": self.elapsed_ms()})

    def note_finish_reason(self, reason: str) -> None:
        self._finish_reason = reason

    async def succeed(
        self,
        *,
        model: str | None = None,
        response: dict[str, Any] | None = None,
        usage: dict[str, Any] | None = None,
        provider_request_id: str | None = None,
        first_token_ms: int | None = None,
    ) -> None:
        latency_ms = int((time.monotonic() - self._started) * 1000)
        ttft = first_token_ms if first_token_ms is not None else self._first_token_ms
        payload = response
        if ttft is not None:
            # 首 token 时延跟着响应走：台账里一眼能看出"等了多久才开始吐字"
            payload = {**(response or {}), "first_token_ms": ttft}
        values = {
            "status": "succeeded",
            "model": model or self._row.model,
            "response": safe_payload(payload),
            "usage": safe_payload(usage),
            **usage_columns(usage),
            "provider_request_id": provider_request_id,
            "latency_ms": latency_ms,
            "finished_at": datetime.now(UTC),
        }
        if self._persisted:
            await _persist_finish(self.id, values)
            self.record_event(
                EVENT_FINISH,
                {
                    "status": "succeeded",
                    "elapsed_ms": latency_ms,
                    "first_token_ms": ttft,
                    "finish_reason": self._finish_reason,
                    "model": values["model"],
                    "provider_request_id": provider_request_id,
                    "usage": usage_columns(usage) if usage is not None else None,
                    "response": payload,
                },
            )
        logger.info(
            "model.invoke.end id=%s status=succeeded model=%s latency_ms=%d first_token_ms=%s",
            self.id,
            values["model"],
            latency_ms,
            ttft,
        )

    async def fail(
        self, exc: BaseException, *, status: str = "failed", code: str | None = None
    ) -> None:
        """写失败终态。``code`` 缺省取异常自带的 ``failure.code``（LlmFailure 载体）。"""
        latency_ms = int((time.monotonic() - self._started) * 1000)
        if code is None:
            carried = getattr(exc, "failure", None)
            carried_code = getattr(carried, "code", None)
            code = carried_code if isinstance(carried_code, str) else None
        values = {
            "status": status,
            "latency_ms": latency_ms,
            "error_type": type(exc).__name__,
            "error_message": safe_payload(str(exc)),
            "error_code": code,
            "finished_at": datetime.now(UTC),
        }
        if self._persisted:
            await _persist_finish(self.id, values)
            self.record_event(
                EVENT_ERROR,
                {
                    "status": status,
                    "elapsed_ms": latency_ms,
                    "first_token_ms": self._first_token_ms,
                    "error_code": code,
                    "error_type": values["error_type"],
                    "error_message": str(exc),
                },
            )
        logger.info(
            "model.invoke.end id=%s status=%s error_type=%s error_code=%s latency_ms=%d",
            self.id,
            status,
            values["error_type"],
            code,
            latency_ms,
        )


@dataclass
class _TextBatch:
    type: str
    index: int
    started_ms: int
    last_ms: int
    parts: list[str] = field(default_factory=list)

    @property
    def chars(self) -> int:
        return sum(len(part) for part in self.parts)


class ChunkEventBatcher:
    """把内核 StreamChunk 折成台账事件：文本 / 推理 delta 攒批，其余分块各一条。

    同一块（type + index）的连续 delta 攒到 ``max_chars`` 或首个 delta 起超过 ``max_wait_ms``
    就落一条 ``chunk.text`` / ``chunk.reasoning``；块切换、block-end、工具 / 用量 / 结束分块
    到来时先把攒着的落掉，事件顺序与分块顺序一致。FinishChunk 不单独成事件，它的
    reason 交给 span 随 ``finish`` 事件写。
    """

    def __init__(
        self,
        span: ModelInvocationSpan,
        *,
        max_chars: int = TEXT_BATCH_CHARS,
        max_wait_ms: int = TEXT_BATCH_MS,
        clock_ms: Any = None,
    ) -> None:
        self.span = span
        self.max_chars = max_chars
        self.max_wait_ms = max_wait_ms
        self._clock_ms = clock_ms or span.elapsed_ms
        self._pending: _TextBatch | None = None
        self._closed = False

    def _flush(self) -> None:
        batch, self._pending = self._pending, None
        if batch is None or not batch.parts:
            return
        self.span.record_event(
            batch.type,
            {
                "index": batch.index,
                "text": "".join(batch.parts),
                "chars": batch.chars,
                "elapsed_ms": batch.started_ms,
                "end_ms": batch.last_ms,
            },
        )

    def _push_delta(self, type: str, index: int, text: str) -> None:
        now = self._clock_ms()
        pending = self._pending
        if pending is not None and (pending.type != type or pending.index != index):
            self._flush()
            pending = None
        if pending is not None and now - pending.started_ms >= self.max_wait_ms:
            self._flush()
            pending = None
        if pending is None:
            pending = _TextBatch(type=type, index=index, started_ms=now, last_ms=now)
            self._pending = pending
        pending.parts.append(text)
        pending.last_ms = now
        if pending.chars >= self.max_chars:
            self._flush()

    def push(self, chunk: StreamChunk) -> None:
        if self._closed:
            return
        match chunk:
            case TextDeltaChunk():
                if chunk.text:
                    self._push_delta(EVENT_CHUNK_TEXT, chunk.index, chunk.text)
            case ReasoningDeltaChunk():
                if chunk.text:
                    self._push_delta(EVENT_CHUNK_REASONING, chunk.index, chunk.text)
            case ToolCallDeltaChunk():
                self._flush()
                self.span.record_event(
                    EVENT_CHUNK_TOOL_DELTA,
                    {
                        "index": chunk.index,
                        "id": chunk.id,
                        "name": chunk.name,
                        "arguments_delta": chunk.arguments_delta,
                        "elapsed_ms": self._clock_ms(),
                    },
                )
            case UsageChunk():
                self._flush()
                self.span.record_event(
                    EVENT_CHUNK_USAGE,
                    {"usage": chunk.usage.model_dump(), "elapsed_ms": self._clock_ms()},
                )
            case BlockEndChunk():
                pending = self._pending
                if pending is not None and pending.index == chunk.index:
                    self._flush()
            case FinishChunk():
                self._flush()
                self.span.note_finish_reason(chunk.reason.kind)
            case _:
                return

    def close(self) -> None:
        """落掉攒着的文本；可重复调用。"""
        if self._closed:
            return
        self._flush()
        self._closed = True


def invocation_cursor(row: ModelInvocation) -> str:
    """列表分页游标：按 (created_at, id) 键集翻页，新插入的行不会让后页错位。"""
    return f"{row.created_at.isoformat()}|{row.id}"


def parse_invocation_cursor(cursor: str) -> tuple[datetime, str]:
    # ISO 时间里没有竖线，从第一个竖线切：id 部分原样保留
    created_raw, separator, invocation_id = cursor.partition("|")
    if not separator or not created_raw or not invocation_id:
        raise ValueError("无效的分页游标")
    return datetime.fromisoformat(created_raw), invocation_id


def _bind_time(value: datetime) -> datetime:
    """带时区的参数先换算到 UTC：SQLite 存的是无时区 UTC 串，直接绑定会按本地偏移比错。"""
    return value.astimezone(UTC) if value.tzinfo is not None else value


def invocation_view(row: ModelInvocation) -> dict[str, Any]:
    response = row.response if isinstance(row.response, dict) else None
    first_token = response.get("first_token_ms") if response else None
    return {
        "id": row.id,
        "plugin_id": row.plugin_id,
        "plugin_version": row.plugin_version,
        "plugin_generation": row.plugin_generation,
        "runtime_generation": row.runtime_generation,
        "operation": row.operation,
        "capability": row.capability,
        "deployment_id": row.deployment_id,
        "task_id": row.task_id,
        "source": row.source,
        "canvas_id": row.canvas_id,
        "node_id": row.node_id,
        "flow_run_id": row.flow_run_id,
        "tool_id": row.tool_id,
        "request": row.request,
        "response": row.response,
        "provider_request_id": row.provider_request_id,
        "model": row.model,
        "status": row.status,
        "usage": row.usage,
        "latency_ms": row.latency_ms,
        "first_token_ms": first_token if isinstance(first_token, int) else None,
        "error_type": row.error_type,
        "error_message": row.error_message,
        "error_code": row.error_code,
        "parent_invocation_id": row.parent_invocation_id,
        "attempt": row.attempt,
        "input_tokens": row.input_tokens,
        "output_tokens": row.output_tokens,
        "cache_read_tokens": row.cache_read_tokens,
        "cache_write_tokens": row.cache_write_tokens,
        "reasoning_tokens": row.reasoning_tokens,
        "context": row.context,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "finished_at": row.finished_at.isoformat() if row.finished_at else None,
    }


def invocation_event_view(row: ModelInvocationEvent) -> dict[str, Any]:
    return {
        "id": row.id,
        "invocation_id": row.invocation_id,
        "seq": row.seq,
        "type": row.type,
        "time": row.time.isoformat() if row.time else None,
        "data": row.data,
    }


@dataclass(frozen=True)
class InvocationPage:
    items: list[ModelInvocation]
    next_cursor: str | None


async def list_invocations(
    session: AsyncSession,
    *,
    status: str | None = None,
    plugin_id: str | None = None,
    task_id: str | None = None,
    capability: str | None = None,
    canvas_id: int | None = None,
    node_id: str | None = None,
    flow_run_id: str | None = None,
    tool_id: str | None = None,
    source: str | None = None,
    error_code: str | None = None,
    since: datetime | None = None,
    cursor: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> InvocationPage:
    """按 created_at 倒序列出台账行；``cursor`` 接上一页的 ``next_cursor`` 继续往旧翻。"""
    stmt = select(ModelInvocation)
    equals = (
        (ModelInvocation.status, status),
        (ModelInvocation.plugin_id, plugin_id),
        (ModelInvocation.task_id, task_id),
        (ModelInvocation.capability, capability),
        (ModelInvocation.node_id, node_id),
        (ModelInvocation.flow_run_id, flow_run_id),
        (ModelInvocation.tool_id, tool_id),
        (ModelInvocation.source, source),
        (ModelInvocation.error_code, error_code),
    )
    for column, value in equals:
        if value:
            stmt = stmt.where(column == value)
    if canvas_id is not None:
        stmt = stmt.where(ModelInvocation.canvas_id == canvas_id)
    if since is not None:
        stmt = stmt.where(ModelInvocation.created_at >= _bind_time(since))
    if cursor:
        created_at, invocation_id = parse_invocation_cursor(cursor)
        bound = _bind_time(created_at)
        stmt = stmt.where(
            or_(
                ModelInvocation.created_at < bound,
                (ModelInvocation.created_at == bound) & (ModelInvocation.id < invocation_id),
            )
        )
    page_size = max(1, min(limit, 500))
    stmt = (
        stmt.order_by(ModelInvocation.created_at.desc(), ModelInvocation.id.desc())
        .offset(max(0, offset))
        .limit(page_size)
    )
    rows = list((await session.execute(stmt)).scalars())
    next_cursor = invocation_cursor(rows[-1]) if len(rows) == page_size else None
    return InvocationPage(items=rows, next_cursor=next_cursor)


async def list_invocation_events(
    session: AsyncSession,
    invocation_id: str,
    *,
    after_seq: int = 0,
    limit: int = 2000,
) -> list[ModelInvocationEvent]:
    stmt = (
        select(ModelInvocationEvent)
        .where(ModelInvocationEvent.invocation_id == invocation_id)
        .where(ModelInvocationEvent.seq > max(0, after_seq))
        .order_by(ModelInvocationEvent.seq)
        .limit(max(1, min(limit, 5000)))
    )
    return list((await session.execute(stmt)).scalars())


async def list_invocations_updated_since(
    session: AsyncSession,
    *,
    since: datetime,
    limit: int = 200,
) -> list[ModelInvocation]:
    """自 ``since`` 起新建或写过终态的台账行，按创建顺序；供 SSE 推 invocation 帧。"""
    bound = _bind_time(since)
    stmt = (
        select(ModelInvocation)
        .where(or_(ModelInvocation.created_at >= bound, ModelInvocation.finished_at >= bound))
        .order_by(ModelInvocation.created_at, ModelInvocation.id)
        .limit(max(1, min(limit, 500)))
    )
    return list((await session.execute(stmt)).scalars())
