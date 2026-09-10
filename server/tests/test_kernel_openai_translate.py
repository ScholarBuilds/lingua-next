"""OpenAI 兼容分块翻译：三路分块、tool_calls 增量拼接、usage 扣减、空响应、错误码映射。"""

from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from email.utils import format_datetime
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from openai import APIConnectionError, APIStatusError, APITimeoutError
from openai.types.chat import ChatCompletion, ChatCompletionChunk

from domain.kernel.llm_assembler import BlockAssembler
from domain.kernel.llm_types import (
    BlockEndChunk,
    BlockStartChunk,
    ErrorFinish,
    FinishChunk,
    LlmFailure,
    MaxTokensFinish,
    ReasoningBlock,
    ReasoningDeltaChunk,
    ReplayEnvelope,
    StopFinish,
    TextBlock,
    TextDeltaChunk,
    TokenUsage,
    ToolCallBlock,
    ToolCallDeltaChunk,
    ToolCallsFinish,
    UsageChunk,
)
from domain.providers.openai_chat import (
    failure_from_exception,
    failure_from_status,
    http_error_code,
    is_context_window_exceeded,
    map_finish_reason,
    map_usage,
    provider_retry_after_ms,
    translate_openai_chunks,
    translate_openai_response,
)


async def _feed(*chunks: Any) -> AsyncIterator[Any]:
    for chunk in chunks:
        yield chunk


async def _collect(*chunks: Any) -> list[Any]:
    return [
        item
        async for item in translate_openai_chunks(_feed(*chunks), provider="openai", model="gpt")
    ]


def _ns(data: Any) -> Any:
    """把 dict 递归转成 SimpleNamespace，模拟 SDK 对象的属性访问。"""
    if isinstance(data, dict):
        return SimpleNamespace(**{k: _ns(v) for k, v in data.items()})
    if isinstance(data, list):
        return [_ns(item) for item in data]
    return data


# 真实首帧签名：role + null content + 空 reasoning
FIRST = {"choices": [{"delta": {"role": "assistant", "content": None, "reasoning_content": ""}}]}


def _finish_of(chunks: list[Any]) -> Any:
    assert isinstance(chunks[-1], FinishChunk)
    return chunks[-1].reason


# ---------------------------------------------------------------------------
# 文本
# ---------------------------------------------------------------------------


async def test_streams_a_text_block_and_defers_close_usage_finish_to_stream_end():
    chunks = await _collect(
        FIRST,
        {"choices": [{"delta": {"content": "Hel"}}]},
        {"choices": [{"delta": {"content": "lo"}}]},
        {
            "choices": [{"delta": {"content": ""}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 5, "completion_tokens": 2},
        },
    )
    assert chunks[:-1] == [
        BlockStartChunk(index=0, block_type="text"),
        TextDeltaChunk(index=0, text="Hel"),
        TextDeltaChunk(index=0, text="lo"),
        BlockEndChunk(index=0, block=TextBlock(text="Hello")),
        UsageChunk(usage=TokenUsage(input_tokens=5, output_tokens=2)),
    ]
    assert _finish_of(chunks) == StopFinish()


async def test_assembles_into_the_message_block_assembler_expects():
    assembler = BlockAssembler()
    async for chunk in translate_openai_chunks(
        _feed(
            FIRST,
            {"choices": [{"delta": {"content": "hi"}}]},
            {"choices": [{"delta": {}, "finish_reason": "stop"}]},
        ),
        provider="openai",
        model="gpt",
    ):
        assembler.push(chunk)
    result = assembler.assemble(provider="openai", model="gpt")
    assert result.message.content == [TextBlock(text="hi")]
    assert result.finish == StopFinish()


async def test_accepts_sdk_objects_and_namespaces_alike():
    sdk_chunk = ChatCompletionChunk.model_validate(
        {
            "id": "chatcmpl-1",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "gpt-wire",
            "system_fingerprint": "fp_1",
            "choices": [
                {
                    "index": 0,
                    "delta": {"reasoning_content": "mull", "content": "x"},
                    "finish_reason": None,
                }
            ],
        }
    )
    ns_chunk = _ns({"choices": [{"delta": {"content": "y"}, "finish_reason": "stop"}]})
    chunks = await _collect(sdk_chunk, ns_chunk)
    assert chunks[:-1] == [
        BlockStartChunk(index=0, block_type="reasoning"),
        ReasoningDeltaChunk(index=0, text="mull"),
        BlockStartChunk(index=1, block_type="text"),
        TextDeltaChunk(index=1, text="x"),
        TextDeltaChunk(index=1, text="y"),
        BlockEndChunk(index=0, block=ReasoningBlock(text="mull")),
        BlockEndChunk(index=1, block=TextBlock(text="xy")),
    ]
    finish = chunks[-1]
    assert finish == FinishChunk(
        reason=StopFinish(),
        replay_state=ReplayEnvelope(
            response={
                "provider": "openai",
                "model": "gpt",
                "response_id": "chatcmpl-1",
                "response_model": "gpt-wire",
                "system_fingerprint": "fp_1",
                "finish_reason": "stop",
            }
        ),
    )


# ---------------------------------------------------------------------------
# 推理
# ---------------------------------------------------------------------------


async def test_empty_first_chunk_reasoning_does_not_open_a_block():
    chunks = await _collect(
        FIRST,
        {"choices": [{"delta": {"content": "plain"}}]},
        {"choices": [{"delta": {}, "finish_reason": "stop"}]},
    )
    assert not any(isinstance(c, BlockStartChunk) and c.block_type == "reasoning" for c in chunks)


async def test_streams_reasoning_then_text_as_separate_blocks():
    chunks = await _collect(
        FIRST,
        {"choices": [{"delta": {"content": None, "reasoning_content": "think"}}]},
        {"choices": [{"delta": {"content": None, "reasoning_content": "ing"}}]},
        {"choices": [{"delta": {"content": "answer", "reasoning_content": None}}]},
        {"choices": [{"delta": {}, "finish_reason": "stop"}]},
    )
    assert chunks[:-1] == [
        BlockStartChunk(index=0, block_type="reasoning"),
        ReasoningDeltaChunk(index=0, text="think"),
        ReasoningDeltaChunk(index=0, text="ing"),
        BlockStartChunk(index=1, block_type="text"),
        TextDeltaChunk(index=1, text="answer"),
        BlockEndChunk(index=0, block=ReasoningBlock(text="thinking")),
        BlockEndChunk(index=1, block=TextBlock(text="answer")),
    ]
    assert _finish_of(chunks) == StopFinish()


async def test_absent_reasoning_field_is_non_thinking():
    chunks = await _collect(
        {"choices": [{"delta": {"role": "assistant", "content": "x"}}]},
        {"choices": [{"delta": {}, "finish_reason": "stop"}]},
    )
    assert [c for c in chunks if isinstance(c, BlockStartChunk)] == [
        BlockStartChunk(index=0, block_type="text")
    ]


async def test_reasoning_field_spelling_is_accepted_as_fallback():
    chunks = await _collect(
        {"choices": [{"delta": {"reasoning": "r"}}]},
        {"choices": [{"delta": {}, "finish_reason": "stop"}]},
    )
    assert chunks[0] == BlockStartChunk(index=0, block_type="reasoning")


# ---------------------------------------------------------------------------
# 工具调用
# ---------------------------------------------------------------------------


async def test_reassembles_a_tool_call_from_fragmented_argument_deltas():
    chunks = await _collect(
        FIRST,
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call_00_x",
                                "type": "function",
                                "function": {"name": "get_weather", "arguments": ""},
                            }
                        ]
                    }
                }
            ]
        },
        {
            "choices": [
                {"delta": {"tool_calls": [{"index": 0, "function": {"arguments": '{"city"'}}]}}
            ]
        },
        {
            "choices": [
                {"delta": {"tool_calls": [{"index": 0, "function": {"arguments": ': "Paris"}'}}]}}
            ]
        },
        {
            "choices": [{"delta": {"content": ""}, "finish_reason": "tool_calls"}],
            "usage": {"prompt_tokens": 28, "completion_tokens": 6},
        },
    )
    assert chunks[:-1] == [
        BlockStartChunk(index=0, block_type="tool-call"),
        ToolCallDeltaChunk(index=0, id="call_00_x", name="get_weather", arguments_delta=""),
        ToolCallDeltaChunk(index=0, id="call_00_x", name="get_weather", arguments_delta='{"city"'),
        ToolCallDeltaChunk(
            index=0, id="call_00_x", name="get_weather", arguments_delta=': "Paris"}'
        ),
        BlockEndChunk(
            index=0,
            block=ToolCallBlock(id="call_00_x", name="get_weather", arguments='{"city": "Paris"}'),
        ),
        UsageChunk(usage=TokenUsage(input_tokens=28, output_tokens=6)),
    ]
    assert _finish_of(chunks) == ToolCallsFinish()


async def test_disambiguates_parallel_tool_calls_by_wire_index():
    chunks = await _collect(
        FIRST,
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "a",
                                "type": "function",
                                "function": {"name": "one", "arguments": "{}"},
                            },
                            {
                                "index": 1,
                                "id": "b",
                                "type": "function",
                                "function": {"name": "two", "arguments": ""},
                            },
                        ]
                    }
                }
            ]
        },
        {"choices": [{"delta": {"tool_calls": [{"index": 1, "function": {"arguments": "{}"}}]}}]},
        {"choices": [{"delta": {}, "finish_reason": "tool_calls"}]},
    )
    assert [c for c in chunks if isinstance(c, BlockEndChunk)] == [
        BlockEndChunk(index=0, block=ToolCallBlock(id="a", name="one", arguments="{}")),
        BlockEndChunk(index=1, block=ToolCallBlock(id="b", name="two", arguments="{}")),
    ]


async def test_interleaves_text_and_tool_call_blocks_with_distinct_indices():
    chunks = await _collect(
        FIRST,
        {"choices": [{"delta": {"content": "Checking."}}]},
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "c",
                                "type": "function",
                                "function": {"name": "f", "arguments": "{}"},
                            }
                        ]
                    }
                }
            ]
        },
        {"choices": [{"delta": {}, "finish_reason": "tool_calls"}]},
    )
    assert [c for c in chunks if isinstance(c, BlockStartChunk)] == [
        BlockStartChunk(index=0, block_type="text"),
        BlockStartChunk(index=1, block_type="tool-call"),
    ]


async def test_tool_call_deltas_without_id_or_name_fall_back_to_empty_strings():
    chunks = await _collect(
        FIRST,
        {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": "{}"}}]}}]},
        {"choices": [{"delta": {}, "finish_reason": "tool_calls"}]},
    )
    assert chunks[:-1] == [
        BlockStartChunk(index=0, block_type="tool-call"),
        ToolCallDeltaChunk(index=0, id="", name=None, arguments_delta="{}"),
        BlockEndChunk(index=0, block=ToolCallBlock(id="", name="", arguments="{}")),
    ]
    assert _finish_of(chunks) == ToolCallsFinish()


async def test_tool_call_delta_with_function_but_no_arguments():
    chunks = await _collect(
        FIRST,
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {"index": 0, "id": "c", "type": "function", "function": {"name": "f"}}
                        ]
                    }
                }
            ]
        },
        {"choices": [{"delta": {}, "finish_reason": "tool_calls"}]},
    )
    assert chunks[1] == ToolCallDeltaChunk(index=0, id="c", name="f", arguments_delta="")


async def test_tool_call_delta_with_no_function_object():
    chunks = await _collect(
        FIRST,
        {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "c"}]}}]},
        {"choices": [{"delta": {}, "finish_reason": "tool_calls"}]},
    )
    assert chunks[1] == ToolCallDeltaChunk(index=0, id="c", name=None, arguments_delta="")


async def test_tool_call_delta_missing_wire_index_uses_position():
    chunks = await _collect(
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [{"id": "c", "function": {"name": "f", "arguments": "{}"}}]
                    }
                }
            ]
        },
        {"choices": [{"delta": {}, "finish_reason": "tool_calls"}]},
    )
    assert chunks[-2] == BlockEndChunk(
        index=0, block=ToolCallBlock(id="c", name="f", arguments="{}")
    )


# ---------------------------------------------------------------------------
# finish 与 usage
# ---------------------------------------------------------------------------


async def test_takes_usage_from_a_trailing_usage_only_chunk():
    chunks = await _collect(
        FIRST,
        {"choices": [{"delta": {"content": "x"}}]},
        {"choices": [{"delta": {}, "finish_reason": "stop"}], "usage": None},
        {"choices": [], "usage": {"prompt_tokens": 9, "completion_tokens": 1}},
    )
    assert chunks[-2] == UsageChunk(usage=TokenUsage(input_tokens=9, output_tokens=1))
    assert _finish_of(chunks) == StopFinish()


async def test_last_usage_wins_when_attached_and_trailing_both_arrive():
    chunks = await _collect(
        FIRST,
        {
            "choices": [{"delta": {"content": "x"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1},
        },
        {"choices": [], "usage": {"prompt_tokens": 2, "completion_tokens": 2}},
    )
    usages = [c for c in chunks if isinstance(c, UsageChunk)]
    assert usages == [UsageChunk(usage=TokenUsage(input_tokens=2, output_tokens=2))]


async def test_defaults_to_stop_when_no_finish_reason_arrives():
    chunks = await _collect(FIRST, {"choices": [{"delta": {"content": "x"}}]})
    assert _finish_of(chunks) == StopFinish()


async def test_omits_usage_chunk_when_none_arrived():
    chunks = await _collect(FIRST, {"choices": [{"delta": {"content": "x"}}]})
    assert not any(isinstance(c, UsageChunk) for c in chunks)


async def test_chunk_with_no_choices_and_nothing_else_is_empty_response():
    chunks = await _collect({})
    assert chunks == [
        FinishChunk(
            reason=ErrorFinish(
                failure=LlmFailure(
                    message="model returned a completed response with no content",
                    code="EMPTY_RESPONSE",
                )
            )
        )
    ]


async def test_explicit_stop_with_no_opened_blocks_is_empty_response_after_usage():
    chunks = await _collect(
        FIRST,
        {
            "choices": [{"delta": {}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 7, "completion_tokens": 0},
        },
    )
    assert chunks[0] == UsageChunk(usage=TokenUsage(input_tokens=7, output_tokens=0))
    finish = chunks[1]
    assert isinstance(finish, FinishChunk)
    assert isinstance(finish.reason, ErrorFinish)
    assert finish.reason.failure.code == "EMPTY_RESPONSE"
    assert finish.replay_state is None


async def test_reasoning_only_stream_is_a_successful_stop():
    chunks = await _collect(
        FIRST,
        {"choices": [{"delta": {"content": None, "reasoning_content": "mull"}}]},
        {"choices": [{"delta": {}, "finish_reason": "stop"}]},
    )
    assert _finish_of(chunks) == StopFinish()


async def test_non_stop_finish_with_no_blocks_is_left_unclassified():
    chunks = await _collect(FIRST, {"choices": [{"delta": {}, "finish_reason": "length"}]})
    assert _finish_of(chunks) == MaxTokensFinish()


async def test_underlying_stream_errors_propagate_untouched():
    async def broken() -> AsyncIterator[Any]:
        yield {"choices": [{"delta": {"content": "x"}}]}
        raise RuntimeError("socket closed")

    with pytest.raises(RuntimeError, match="socket closed"):
        async for _ in translate_openai_chunks(broken(), provider="p", model="m"):
            pass


# ---------------------------------------------------------------------------
# 非流式响应
# ---------------------------------------------------------------------------


def test_translate_openai_response_yields_the_streaming_equivalent():
    response = ChatCompletion.model_validate(
        {
            "id": "chatcmpl-2",
            "object": "chat.completion",
            "created": 1,
            "model": "gpt-wire",
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "tool_calls",
                    "message": {
                        "role": "assistant",
                        "content": "Let me check.",
                        "reasoning_content": "plan",
                        "tool_calls": [
                            {
                                "id": "c1",
                                "type": "function",
                                "function": {"name": "a", "arguments": "{}"},
                            },
                            {
                                "id": "c2",
                                "type": "function",
                                "function": {"name": "b", "arguments": '{"k":1}'},
                            },
                        ],
                    },
                }
            ],
            "usage": {
                "prompt_tokens": 20,
                "completion_tokens": 8,
                "total_tokens": 28,
                "prompt_tokens_details": {"cached_tokens": 15},
            },
        }
    )
    chunks = translate_openai_response(response, provider="openai", model="gpt")
    assert chunks[:-1] == [
        BlockStartChunk(index=0, block_type="reasoning"),
        ReasoningDeltaChunk(index=0, text="plan"),
        BlockStartChunk(index=1, block_type="text"),
        TextDeltaChunk(index=1, text="Let me check."),
        BlockStartChunk(index=2, block_type="tool-call"),
        ToolCallDeltaChunk(index=2, id="c1", name="a", arguments_delta="{}"),
        BlockStartChunk(index=3, block_type="tool-call"),
        ToolCallDeltaChunk(index=3, id="c2", name="b", arguments_delta='{"k":1}'),
        BlockEndChunk(index=0, block=ReasoningBlock(text="plan")),
        BlockEndChunk(index=1, block=TextBlock(text="Let me check.")),
        BlockEndChunk(index=2, block=ToolCallBlock(id="c1", name="a", arguments="{}")),
        BlockEndChunk(index=3, block=ToolCallBlock(id="c2", name="b", arguments='{"k":1}')),
        UsageChunk(usage=TokenUsage(input_tokens=5, output_tokens=8, cache_read_tokens=15)),
    ]
    assert _finish_of(chunks) == ToolCallsFinish()
    assembler = BlockAssembler()
    for chunk in chunks:
        assembler.push(chunk)
    assert len(assembler.blocks()) == 4


def test_translate_openai_response_empty_content_is_empty_response():
    chunks = translate_openai_response(
        {"choices": [{"message": {"role": "assistant", "content": None}, "finish_reason": "stop"}]},
        provider="p",
        model="m",
    )
    assert len(chunks) == 1
    reason = _finish_of(chunks)
    assert isinstance(reason, ErrorFinish)
    assert reason.failure.code == "EMPTY_RESPONSE"


def test_translate_openai_response_joins_text_parts():
    chunks = translate_openai_response(
        {
            "choices": [
                {
                    "message": {
                        "content": [{"type": "text", "text": "a"}, {"type": "text", "text": "b"}]
                    },
                    "finish_reason": "stop",
                }
            ]
        },
        provider="p",
        model="m",
    )
    assert chunks[-2] == BlockEndChunk(index=0, block=TextBlock(text="ab"))


# ---------------------------------------------------------------------------
# finish_reason / usage 映射
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("wire", "expected"),
    [
        ("stop", StopFinish()),
        ("tool_calls", ToolCallsFinish()),
        ("function_call", ToolCallsFinish()),
        ("length", MaxTokensFinish()),
    ],
)
def test_map_finish_reason_known_values(wire, expected):
    assert map_finish_reason(wire) == expected


@pytest.mark.parametrize("wire", ["content_filter", "insufficient_system_resource", "mystery"])
def test_map_finish_reason_unknown_values_become_unknown_error(wire):
    assert map_finish_reason(wire) == ErrorFinish(
        failure=LlmFailure(message=f"model stopped: {wire}", code="UNKNOWN")
    )


def test_map_usage_subtracts_cached_tokens_from_input():
    assert map_usage(
        {
            "prompt_tokens": 283,
            "completion_tokens": 69,
            "prompt_cache_hit_tokens": 256,
            "prompt_cache_miss_tokens": 27,
            "prompt_tokens_details": {"cached_tokens": 256, "cache_write_tokens": 3},
            "completion_tokens_details": {"reasoning_tokens": 24},
        }
    ) == TokenUsage(
        input_tokens=27,
        output_tokens=69,
        cache_read_tokens=256,
        cache_write_tokens=3,
        reasoning_tokens=24,
    )


def test_map_usage_falls_back_to_prompt_cache_hit_tokens():
    assert map_usage(
        {"prompt_tokens": 10, "completion_tokens": 2, "prompt_cache_hit_tokens": 8}
    ) == (TokenUsage(input_tokens=2, output_tokens=2, cache_read_tokens=8))


def test_map_usage_omits_optional_fields_and_accepts_objects():
    assert map_usage({"prompt_tokens": 10, "completion_tokens": 2}) == TokenUsage(
        input_tokens=10, output_tokens=2
    )
    sdk_like = _ns(
        {"prompt_tokens": 4, "completion_tokens": 1, "prompt_tokens_details": {"cached_tokens": 4}}
    )
    assert map_usage(sdk_like) == TokenUsage(input_tokens=0, output_tokens=1, cache_read_tokens=4)


def test_map_usage_never_goes_negative():
    assert (
        map_usage(
            {
                "prompt_tokens": 3,
                "completion_tokens": 0,
                "prompt_tokens_details": {"cached_tokens": 5},
            }
        ).input_tokens
        == 0
    )


# ---------------------------------------------------------------------------
# HTTP 错误码
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("status", "message", "expected"),
    [
        (401, None, "AUTH"),
        (403, "forbidden", "AUTH"),
        (429, "Rate limit reached", "RATE_LIMIT"),
        (400, "invalid json", "INVALID_REQUEST"),
        (400, "This model's maximum context length is 8192 tokens.", "CONTEXT_WINDOW_EXCEEDED"),
        (400, "context_length_exceeded", "CONTEXT_WINDOW_EXCEEDED"),
        (400, "litellm.ContextWindowExceededError: prompt is too long", "CONTEXT_WINDOW_EXCEEDED"),
        (413, "payload too large", "INVALID_REQUEST"),
        (422, "validation error", "INVALID_REQUEST"),
        (408, None, "TIMEOUT"),
        (504, None, "TIMEOUT"),
        (500, None, "SERVER"),
        (502, None, "SERVER"),
        (503, None, "SERVER"),
        (404, None, "UNKNOWN"),
        (418, None, "UNKNOWN"),
    ],
)
def test_http_error_code(status, message, expected):
    assert http_error_code(status, message) == expected


@pytest.mark.parametrize(
    "detail",
    [
        "context window exceeded",
        "context-length-overflow",
        "context window limit exceeded",
        "max supported context window is 4096",
        "request is too large for this model's context window",
        "the input is too long for the model",
        "prompt (9000 tokens) exceeds the model context length (8192)",
    ],
)
def test_context_window_wording_recognized(detail):
    assert is_context_window_exceeded(detail)


@pytest.mark.parametrize(
    "detail",
    ["contextual error", "rate limit exceeded", "the context was lost", "too many requests"],
)
def test_context_window_wording_not_over_matched(detail):
    assert not is_context_window_exceeded(detail)


def test_provider_retry_after_ms_seconds_and_http_date():
    assert provider_retry_after_ms("2") == 2000
    assert provider_retry_after_ms("0") is None
    assert provider_retry_after_ms(None) is None
    assert provider_retry_after_ms("") is None
    assert provider_retry_after_ms("garbage") is None
    future = format_datetime(datetime.now(UTC) + timedelta(seconds=30), usegmt=True)
    delay = provider_retry_after_ms(future)
    assert delay is not None and 25_000 < delay <= 30_000
    past = format_datetime(datetime.now(UTC) - timedelta(seconds=30), usegmt=True)
    assert provider_retry_after_ms(past) is None


def test_failure_from_status_reads_body_and_headers():
    failure = failure_from_status(
        429,
        body={
            "error": {
                "message": "Too many requests",
                "type": "rate_limit_error",
                "code": "rate_limited",
            }
        },
        headers={"retry-after": "5", "x-request-id": "req-1"},
    )
    assert failure == LlmFailure(
        message="Too many requests",
        code="RATE_LIMIT",
        status=429,
        provider_retry_after_ms=5000,
        request_id="req-1",
    )


def test_failure_from_status_classifies_context_window_from_error_code_field():
    failure = failure_from_status(
        400, body={"error": {"code": "context_length_exceeded", "message": "oops"}}
    )
    assert failure.code == "CONTEXT_WINDOW_EXCEEDED"
    assert failure.message == "oops"


def test_failure_from_status_without_body_uses_default_message():
    failure = failure_from_status(502, body="<html>bad gateway</html>")
    assert failure.code == "SERVER"
    assert failure.message == "provider error (HTTP 502)"
    assert failure.provider_retry_after_ms is None
    assert failure.request_id is None


def _status_error(status: int, body: Any, headers: dict[str, str] | None = None) -> APIStatusError:
    request = httpx.Request("POST", "https://example.invalid/v1/chat/completions")
    response = httpx.Response(status, headers=headers or {}, request=request)
    return APIStatusError("provider rejected", response=response, body=body)


def test_failure_from_exception_maps_sdk_status_errors():
    exc = _status_error(
        401,
        {"error": {"message": "Incorrect API key"}},
        {"x-request-id": "req-9"},
    )
    failure = failure_from_exception(exc)
    assert failure.code == "AUTH"
    assert failure.status == 401
    assert failure.message == "Incorrect API key"
    assert failure.request_id == "req-9"


def test_failure_from_exception_maps_timeouts_and_transport():
    request = httpx.Request("POST", "https://example.invalid/v1/chat/completions")
    assert failure_from_exception(APITimeoutError(request=request)).code == "TIMEOUT"
    assert failure_from_exception(APIConnectionError(request=request)).code == "TRANSPORT"
    assert failure_from_exception(TimeoutError("slow")).code == "TIMEOUT"
    assert failure_from_exception(ValueError("weird")).code == "UNKNOWN"
