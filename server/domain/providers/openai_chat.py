"""OpenAI 兼容 chat.completions 线协议 → StreamChunk 翻译器，以及 HTTP 错误码映射。

翻译自 deepseek-harness：
- ``packages/llm/llm-deepseek/src/translate.ts``（全文：三路分块、finish / usage 延迟到流末、
  空响应判定）
- ``packages/llm/llm-deepseek/src/adapter.ts``（:53-62 mapUsage 缓存扣减；:312-345 httpErrorCode；
  :622-657 非 2xx 响应 → 失败事实）
- ``packages/llm/llm/src/error.ts``（上下文窗口溢出措辞识别）

输入用鸭子类型：同时接受 openai SDK 的 pydantic 对象与等价 dict（各类中转网关、
测试替身）。SDK 对象对 ``reasoning_content`` 这类扩展字段开放 ``extra="allow"``，
``getattr`` 能直接取到。

与 TS 版的差异：
- SDK 异步流自己处理 ``[DONE]``，没有哨兵可等；块关闭 / usage / finish 延迟到异步迭代结束。
- 线协议 ``finish_reason`` 不在已知词表（content_filter 等）时归入 ``UNKNOWN``，原词留在 message。
- 未映射的 HTTP 状态码归入 ``UNKNOWN``（原版返回 ``HTTP_<status>``）。
"""

from __future__ import annotations

import re
import time
from collections.abc import AsyncIterable, AsyncIterator, Mapping
from dataclasses import dataclass, field
from email.utils import parsedate_to_datetime
from typing import Any

from domain.kernel.llm_types import (
    CONTEXT_WINDOW_EXCEEDED_CODE,
    EMPTY_RESPONSE_CODE,
    BlockEndChunk,
    BlockStartChunk,
    ContentBlock,
    ErrorFinish,
    FinishChunk,
    FinishReason,
    LlmFailure,
    LlmFailureCode,
    MaxTokensFinish,
    ReasoningBlock,
    ReasoningDeltaChunk,
    ReplayEnvelope,
    StopFinish,
    StreamBlockType,
    StreamChunk,
    TextBlock,
    TextDeltaChunk,
    TokenUsage,
    ToolCallBlock,
    ToolCallDeltaChunk,
    ToolCallsFinish,
    UsageChunk,
)

# ---------------------------------------------------------------------------
# 鸭子类型访问
# ---------------------------------------------------------------------------


def _get(obj: Any, name: str, default: Any = None) -> Any:
    """dict 取键、对象取属性，缺失或为 None 都返回 default。"""
    if obj is None:
        return default
    value = obj.get(name, default) if isinstance(obj, Mapping) else getattr(obj, name, default)
    return default if value is None else value


# ---------------------------------------------------------------------------
# 错误分类
# ---------------------------------------------------------------------------

# 明确点名"上下文上限被超过"的结构化码与短语：context_length_exceeded / context window overflow
_STRUCTURED_CONTEXT_OVERFLOW = re.compile(
    r"(?:^|[^a-z0-9])context[\s_-](?:length|window)[\s_-]"
    r"(?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]exceeded)(?:$|[^a-z0-9])",
    re.IGNORECASE,
)
# 中转网关会把自己的异常类名原样塞进消息：ContextWindowExceededError
_CAMEL_CONTEXT_OVERFLOW = re.compile(r"context_?window_?exceeded", re.IGNORECASE)
_MAX_CONTEXT_LENGTH = re.compile(
    r"\b(?:maximum|max)(?:\s+(?:allowed|supported))?\s+context\s+(?:length|window)\b",
    re.IGNORECASE,
)
# "too large" 直接挂到模型上下文容量上的措辞
_TOO_LARGE_FOR_CONTEXT = re.compile(
    r"\b(?:request|prompt|input|messages?)\s+(?:is\s+|are\s+)?"
    r"too\s+(?:large|long)\s+for\s+(?:(?:this|the)\s+)?"
    r"(?:model(?:'s)?\s+)?context(?:\s+window)?\b",
    re.IGNORECASE,
)
_TOO_LONG_FOR_MODEL = re.compile(
    r"\b(?:input|prompt|request)\s+(?:is\s+)?too\s+(?:long|large)\s+for\s+(?:this|the)\s+model\b",
    re.IGNORECASE,
)
# "exceeds" 只有在宾语明确是模型上下文时才算
_EXCEEDS_MODEL_CONTEXT = re.compile(
    r"\b(?:input|prompt|request|messages?)\b.{0,40}"
    r"\b(?:exceed(?:s|ed)?|overflows?|is\s+larger\s+than)\b.{0,40}"
    r"\b(?:the\s+)?(?:model(?:'s)?\s+)?context(?:\s+(?:length|window))?\b",
    re.IGNORECASE,
)


def is_context_window_exceeded(detail: str) -> bool:
    """识别 OpenAI 兼容供应商与网关的上下文溢出措辞；入参是 code / type / message 拼成的一串。"""
    return any(
        pattern.search(detail)
        for pattern in (
            _STRUCTURED_CONTEXT_OVERFLOW,
            _CAMEL_CONTEXT_OVERFLOW,
            _MAX_CONTEXT_LENGTH,
            _TOO_LARGE_FOR_CONTEXT,
            _TOO_LONG_FOR_MODEL,
            _EXCEEDS_MODEL_CONTEXT,
        )
    )


def http_error_code(status: int, message: str | None = None) -> LlmFailureCode:
    """非 2xx 状态码 → 稳定的中立失败码。

    401/403 → AUTH；429 → RATE_LIMIT；400（含上下文溢出措辞时 → CONTEXT_WINDOW_EXCEEDED）
    /413/422 → INVALID_REQUEST；408/504 → TIMEOUT；其余 5xx → SERVER；其它 → UNKNOWN。
    """
    if status in (401, 403):
        return "AUTH"
    if status == 429:
        return "RATE_LIMIT"
    if status in (408, 504):
        return "TIMEOUT"
    if status == 400:
        if message and is_context_window_exceeded(message):
            return CONTEXT_WINDOW_EXCEEDED_CODE
        return "INVALID_REQUEST"
    if status in (413, 422):
        return "INVALID_REQUEST"
    if status >= 500:
        return "SERVER"
    return "UNKNOWN"


def provider_retry_after_ms(value: str | None) -> int | None:
    """解析 ``Retry-After`` 头：纯数字按秒，否则按 HTTP 日期与当前时刻求差；非正值视为无效。"""
    if value is None:
        return None
    value = value.strip()
    if not value:
        return None
    if value.isdigit():
        delay = int(value) * 1000
        return delay if delay > 0 else None
    try:
        when = parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError):
        return None
    delay = int(when.timestamp() * 1000 - time.time() * 1000)
    return delay if delay > 0 else None


def _error_detail(body: Any) -> tuple[str | None, str]:
    """从错误响应体里取出 message 与 code/type/message 拼成的分类串。"""
    error = _get(body, "error")
    if error is None:
        error = body
    fields = [_get(error, "code"), _get(error, "type"), _get(error, "message")]
    detail = " ".join(str(item) for item in fields if isinstance(item, str) and item)
    message = _get(error, "message")
    return (message if isinstance(message, str) and message else None), detail


def failure_from_status(
    status: int,
    *,
    body: Any = None,
    headers: Mapping[str, str] | None = None,
    default_message: str | None = None,
) -> LlmFailure:
    """非 2xx 响应 → 失败事实：状态码定码，响应体给 message，头里取 Retry-After 与请求 id。"""
    message, detail = _error_detail(body)
    retry_after: str | None = None
    request_id: str | None = None
    if headers is not None:
        retry_after = headers.get("retry-after") or headers.get("Retry-After")
        request_id = (
            headers.get("x-request-id")
            or headers.get("X-Request-Id")
            or headers.get("x-deepseek-request-id")
            or None
        )
    return LlmFailure(
        message=message or default_message or f"provider error (HTTP {status})",
        code=http_error_code(status, detail or None),
        status=status,
        provider_retry_after_ms=provider_retry_after_ms(retry_after),
        request_id=request_id or None,
    )


def failure_from_exception(exc: BaseException) -> LlmFailure:
    """openai SDK 异常 → 失败事实；超时先于连接错误判定（前者是后者的子类）。"""
    from openai import APIConnectionError, APIStatusError, APITimeoutError

    if isinstance(exc, APIStatusError):
        response = getattr(exc, "response", None)
        headers = getattr(response, "headers", None)
        failure = failure_from_status(
            exc.status_code,
            body=getattr(exc, "body", None),
            headers=headers,
            default_message=str(exc.message) if getattr(exc, "message", None) else None,
        )
        request_id = getattr(exc, "request_id", None)
        if request_id and failure.request_id is None:
            failure = failure.model_copy(update={"request_id": request_id})
        return failure
    if isinstance(exc, APITimeoutError):
        return LlmFailure(message=str(exc) or "request timed out", code="TIMEOUT")
    if isinstance(exc, APIConnectionError):
        return LlmFailure(message=str(exc) or "connection failed", code="TRANSPORT")
    if isinstance(exc, TimeoutError):
        return LlmFailure(message=str(exc) or "request timed out", code="TIMEOUT")
    return LlmFailure(message=str(exc) or exc.__class__.__name__, code="UNKNOWN")


# ---------------------------------------------------------------------------
# 结束原因与用量
# ---------------------------------------------------------------------------


def map_finish_reason(reason: str) -> FinishReason:
    """线协议 finish_reason → FinishReason；未知值（content_filter 等）归入 UNKNOWN。"""
    match reason:
        case "stop":
            return StopFinish()
        case "tool_calls" | "function_call":
            return ToolCallsFinish()
        case "length":
            return MaxTokensFinish()
        case _:
            return ErrorFinish(
                failure=LlmFailure(message=f"model stopped: {reason}", code="UNKNOWN")
            )


def map_usage(usage: Any) -> TokenUsage:
    """线协议 usage → 互不重叠的 TokenUsage。

    OpenAI / DeepSeek 的 ``prompt_tokens`` 包含缓存命中，这里把
    ``prompt_tokens_details.cached_tokens``（回落 ``prompt_cache_hit_tokens``）扣掉；
    ``prompt_tokens_details.cache_write_tokens`` 与 ``completion_tokens_details.reasoning_tokens``
    线上报了才带。
    """
    prompt_details = _get(usage, "prompt_tokens_details")
    completion_details = _get(usage, "completion_tokens_details")
    cache_read = _get(prompt_details, "cached_tokens")
    if cache_read is None:
        cache_read = _get(usage, "prompt_cache_hit_tokens")
    cache_write = _get(prompt_details, "cache_write_tokens")
    reasoning = _get(completion_details, "reasoning_tokens")
    prompt_tokens = int(_get(usage, "prompt_tokens", 0))
    completion_tokens = int(_get(usage, "completion_tokens", 0))
    return TokenUsage(
        input_tokens=max(prompt_tokens - int(cache_read or 0), 0),
        output_tokens=completion_tokens,
        cache_read_tokens=int(cache_read) if cache_read is not None else None,
        cache_write_tokens=int(cache_write) if cache_write is not None else None,
        reasoning_tokens=int(reasoning) if reasoning is not None else None,
    )


# ---------------------------------------------------------------------------
# 分块翻译状态机
# ---------------------------------------------------------------------------


@dataclass
class _OpenBlock:
    index: int
    kind: StreamBlockType
    text: str = ""
    # 仅 tool-call 使用
    call_id: str | None = None
    name: str | None = None

    def close(self) -> ContentBlock:
        match self.kind:
            case "text":
                return TextBlock(text=self.text)
            case "reasoning":
                return ReasoningBlock(text=self.text)
            case _:
                return ToolCallBlock(
                    id=self.call_id or "", name=self.name or "", arguments=self.text
                )


def _text_of(content: Any) -> str:
    """content 可能是字符串，也可能是多段 part 列表（非流式偶见）；只取文本段。"""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, str):
                parts.append(part)
            elif _get(part, "type", "text") == "text":
                text = _get(part, "text")
                if isinstance(text, str):
                    parts.append(text)
        return "".join(parts)
    return ""


@dataclass
class _TranslateState:
    """content / reasoning / tool_calls[i].index 各开一个块；finish 与最新 usage 延迟到流末。"""

    provider: str
    model: str
    next_index: int = 0
    text_block: _OpenBlock | None = None
    reasoning_block: _OpenBlock | None = None
    tool_blocks: dict[int, _OpenBlock] = field(default_factory=dict)
    order: list[_OpenBlock] = field(default_factory=list)
    pending_finish: FinishReason | None = None
    pending_usage: TokenUsage | None = None
    raw_finish_reason: str | None = None
    response_id: str | None = None
    response_model: str | None = None
    system_fingerprint: str | None = None

    def _open(self, kind: StreamBlockType) -> _OpenBlock:
        block = _OpenBlock(index=self.next_index, kind=kind)
        self.next_index += 1
        self.order.append(block)
        return block

    def feed(self, chunk: Any) -> list[StreamChunk]:
        out: list[StreamChunk] = []
        self.response_id = _get(chunk, "id", self.response_id)
        self.response_model = _get(chunk, "model", self.response_model)
        self.system_fingerprint = _get(chunk, "system_fingerprint", self.system_fingerprint)

        for choice in _get(chunk, "choices", []) or []:
            delta = _get(choice, "delta")

            # 推理先于正文：思考模式把它插在正文之前。首帧的空串不能开块。
            reasoning = _get(delta, "reasoning_content")
            if reasoning is None:
                reasoning = _get(delta, "reasoning")
            if isinstance(reasoning, str) and reasoning:
                if self.reasoning_block is None:
                    self.reasoning_block = self._open("reasoning")
                    out.append(
                        BlockStartChunk(index=self.reasoning_block.index, block_type="reasoning")
                    )
                self.reasoning_block.text += reasoning
                out.append(ReasoningDeltaChunk(index=self.reasoning_block.index, text=reasoning))

            content = _text_of(_get(delta, "content"))
            if content:
                if self.text_block is None:
                    self.text_block = self._open("text")
                    out.append(BlockStartChunk(index=self.text_block.index, block_type="text"))
                self.text_block.text += content
                out.append(TextDeltaChunk(index=self.text_block.index, text=content))

            for position, call in enumerate(_get(delta, "tool_calls", []) or []):
                wire_index = _get(call, "index")
                key = int(wire_index) if wire_index is not None else position
                block = self.tool_blocks.get(key)
                if block is None:
                    block = self._open("tool-call")
                    self.tool_blocks[key] = block
                    out.append(BlockStartChunk(index=block.index, block_type="tool-call"))
                call_id = _get(call, "id")
                if call_id is not None:
                    block.call_id = str(call_id)
                function = _get(call, "function")
                name = _get(function, "name")
                if name is not None:
                    block.name = str(name)
                fragment = _get(function, "arguments", "")
                fragment = fragment if isinstance(fragment, str) else ""
                block.text += fragment
                out.append(
                    ToolCallDeltaChunk(
                        index=block.index,
                        id=block.call_id or "",
                        name=block.name,
                        arguments_delta=fragment,
                    )
                )

            finish_reason = _get(choice, "finish_reason")
            if isinstance(finish_reason, str):
                self.raw_finish_reason = finish_reason
                self.pending_finish = map_finish_reason(finish_reason)

        # usage 可能挂在 finish 帧上，也可能是末尾单独一帧——取最新
        usage = _get(chunk, "usage")
        if usage is not None:
            self.pending_usage = map_usage(usage)
        return out

    def _replay(self) -> ReplayEnvelope:
        response = {
            "provider": self.provider,
            "model": self.model,
            "response_id": self.response_id,
            "response_model": self.response_model,
            "system_fingerprint": self.system_fingerprint,
            "finish_reason": self.raw_finish_reason,
        }
        return ReplayEnvelope(response={k: v for k, v in response.items() if v is not None})

    def finish(self) -> list[StreamChunk]:
        """流末：按开块顺序关块，再 usage，最后 finish。
        stop（或缺席）且一个块都没开过，是退化的空完成，归为 EMPTY_RESPONSE 错误。"""
        out: list[StreamChunk] = [
            BlockEndChunk(index=block.index, block=block.close()) for block in self.order
        ]
        if self.pending_usage is not None:
            out.append(UsageChunk(usage=self.pending_usage))
        reason: FinishReason = (
            self.pending_finish if self.pending_finish is not None else StopFinish()
        )
        if isinstance(reason, StopFinish) and not self.order:
            reason = ErrorFinish(
                failure=LlmFailure(
                    message="model returned a completed response with no content",
                    code=EMPTY_RESPONSE_CODE,
                )
            )
        replay = None if isinstance(reason, ErrorFinish) else self._replay()
        out.append(FinishChunk(reason=reason, replay_state=replay))
        return out


async def translate_openai_chunks(
    chunks: AsyncIterable[Any], *, provider: str, model: str
) -> AsyncIterator[StreamChunk]:
    """把 chat.completions 流式分块（SDK 对象或 dict）翻译成 StreamChunk。

    delta 即到即出；block-end / usage / finish 延迟到底层流结束。底层流抛出的异常
    原样向上传，由运行时归一成 error / aborted finish。
    """
    state = _TranslateState(provider=provider, model=model)
    async for chunk in chunks:
        for item in state.feed(chunk):
            yield item
    for item in state.finish():
        yield item


def translate_openai_response(response: Any, *, provider: str, model: str) -> list[StreamChunk]:
    """把非流式 ChatCompletion 翻译成与流式等价的 StreamChunk 序列，走同一套状态机。"""
    state = _TranslateState(provider=provider, model=model)
    choices = []
    for choice in _get(response, "choices", []) or []:
        message = _get(choice, "message")
        tool_calls = [
            {"index": i, "id": _get(call, "id"), "function": _get(call, "function")}
            for i, call in enumerate(_get(message, "tool_calls", []) or [])
        ]
        reasoning = _get(message, "reasoning_content")
        if reasoning is None:
            reasoning = _get(message, "reasoning")
        choices.append(
            {
                "delta": {
                    "content": _get(message, "content"),
                    "reasoning_content": reasoning,
                    "tool_calls": tool_calls,
                },
                "finish_reason": _get(choice, "finish_reason"),
            }
        )
    synthetic = {
        "id": _get(response, "id"),
        "model": _get(response, "model"),
        "system_fingerprint": _get(response, "system_fingerprint"),
        "choices": choices,
        "usage": _get(response, "usage"),
    }
    return [*state.feed(synthetic), *state.finish()]


__all__ = [
    "failure_from_exception",
    "failure_from_status",
    "http_error_code",
    "is_context_window_exceeded",
    "map_finish_reason",
    "map_usage",
    "provider_retry_after_ms",
    "translate_openai_chunks",
    "translate_openai_response",
]
