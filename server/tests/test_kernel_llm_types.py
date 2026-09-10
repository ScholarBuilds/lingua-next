"""llm_types 词汇合同：判别联合解析、冻结、消息构造、配置等值与规范 JSON。"""

import json

import pytest
from pydantic import ValidationError

from domain.kernel.llm_types import (
    CONTEXT_SUMMARY_MAX_CHARS,
    AssistantMessage,
    BlockEndChunk,
    BlockStartChunk,
    EpochHeader,
    ErrorFinish,
    FinishChunk,
    GenerateOptions,
    ImageAttachment,
    ImageBlock,
    LlmCallConfig,
    LlmFailure,
    Message,
    ModelSource,
    PluginSource,
    ReasoningBlock,
    ReasoningDeltaChunk,
    StopFinish,
    TextBlock,
    TextDeltaChunk,
    TokenUsage,
    ToolCallBlock,
    ToolCallDeltaChunk,
    ToolCallsFinish,
    ToolResultBlock,
    ToolResultMessage,
    ToolSchema,
    ToolSource,
    UsageChunk,
    UserSource,
    bound_context_summary,
    call_config_equals,
    canonical_json,
    create_assistant_message,
    create_message,
    create_tool_result_message,
    create_user_message,
    is_token_delta,
    parse_content_block,
    parse_finish_reason,
    parse_message_source,
    parse_stream_chunk,
)

# ---------------------------------------------------------------------------
# 判别联合
# ---------------------------------------------------------------------------


def test_content_block_union_dispatches_on_type():
    assert parse_content_block({"type": "text", "text": "hi"}) == TextBlock(text="hi")
    assert parse_content_block({"type": "reasoning", "text": "t"}) == ReasoningBlock(text="t")
    call = parse_content_block({"type": "tool-call", "id": "c1", "name": "echo", "arguments": "{}"})
    assert call == ToolCallBlock(id="c1", name="echo", arguments="{}")
    image = parse_content_block(
        {"type": "image", "attachment": {"mime": "image/png", "asset_id": 7}}
    )
    assert image == ImageBlock(attachment=ImageAttachment(mime="image/png", asset_id=7))


def test_tool_result_block_nests_content_blocks_recursively():
    block = parse_content_block(
        {
            "type": "tool-result",
            "tool_call_id": "c1",
            "content": [
                {"type": "text", "text": "ok"},
                {"type": "tool-result", "tool_call_id": "c0", "content": []},
            ],
        }
    )
    assert isinstance(block, ToolResultBlock)
    assert block.is_error is False
    assert isinstance(block.content[1], ToolResultBlock)


def test_unknown_block_type_rejected():
    with pytest.raises(ValidationError):
        parse_content_block({"type": "video", "url": "x"})


def test_message_source_union_dispatches_on_kind():
    assert parse_message_source({"kind": "user"}) == UserSource()
    plugin = parse_message_source(
        {"kind": "plugin", "plugin": "p", "form": "notice", "summary": "s"}
    )
    assert plugin == PluginSource(plugin="p", form="notice", summary="s")
    model = parse_message_source({"kind": "model", "provider": "openai", "model": "gpt"})
    assert model == ModelSource(provider="openai", model="gpt")
    assert parse_message_source({"kind": "tool", "call_id": "c"}) == ToolSource(call_id="c")
    with pytest.raises(ValidationError):
        parse_message_source({"kind": "plugin", "plugin": "p", "form": "色彩"})


def test_finish_reason_union_dispatches_on_kind():
    assert parse_finish_reason({"kind": "stop"}) == StopFinish()
    assert parse_finish_reason({"kind": "tool-calls"}) == ToolCallsFinish()
    err = parse_finish_reason({"kind": "error", "failure": {"message": "m", "code": "SERVER"}})
    assert isinstance(err, ErrorFinish)
    assert err.failure.status is None
    with pytest.raises(ValidationError):
        parse_finish_reason({"kind": "error"})


def test_stream_chunk_union_dispatches_on_type():
    assert parse_stream_chunk({"type": "block-start", "index": 0, "block_type": "text"}) == (
        BlockStartChunk(index=0, block_type="text")
    )
    assert parse_stream_chunk({"type": "text-delta", "index": 0, "text": "a"}) == (
        TextDeltaChunk(index=0, text="a")
    )
    end = parse_stream_chunk(
        {"type": "block-end", "index": 0, "block": {"type": "text", "text": "a"}}
    )
    assert end == BlockEndChunk(index=0, block=TextBlock(text="a"))
    usage = parse_stream_chunk({"type": "usage", "usage": {"input_tokens": 1, "output_tokens": 2}})
    assert usage == UsageChunk(usage=TokenUsage(input_tokens=1, output_tokens=2))
    finish = parse_stream_chunk({"type": "finish", "reason": {"kind": "stop"}})
    assert finish == FinishChunk(reason=StopFinish())
    with pytest.raises(ValidationError):
        parse_stream_chunk({"type": "block-start", "index": 0, "block_type": "image"})


def test_stream_chunk_round_trips_through_json():
    chunk = FinishChunk(
        reason=ErrorFinish(failure=LlmFailure(message="m", code="RATE_LIMIT", status=429)),
        replay_state={"response": {"id": "r"}},
    )
    restored = parse_stream_chunk(json.loads(chunk.model_dump_json()))
    assert restored == chunk


# ---------------------------------------------------------------------------
# 冻结与失败码
# ---------------------------------------------------------------------------


def test_models_are_frozen():
    block = TextBlock(text="a")
    with pytest.raises(ValidationError):
        block.text = "b"  # type: ignore[misc]
    usage = TokenUsage(input_tokens=1, output_tokens=1)
    with pytest.raises(ValidationError):
        usage.input_tokens = 2  # type: ignore[misc]


def test_failure_code_is_closed_vocabulary():
    LlmFailure(message="m", code="CONTEXT_WINDOW_EXCEEDED")
    with pytest.raises(ValidationError):
        LlmFailure(message="m", code="HTTP_418")  # type: ignore[arg-type]


def test_token_usage_optional_cache_fields_default_none():
    usage = TokenUsage(input_tokens=3, output_tokens=4)
    assert usage.cache_read_tokens is None
    assert usage.cache_write_tokens is None
    assert usage.reasoning_tokens is None


# ---------------------------------------------------------------------------
# 消息构造
# ---------------------------------------------------------------------------


def test_create_message_assigns_fresh_ids():
    a = create_message(role="system", content=[TextBlock(text="x")], source=UserSource())
    b = create_message(role="system", content=[TextBlock(text="x")], source=UserSource())
    assert a.id != b.id
    assert a.role == "system"


def test_create_user_message_fixes_role():
    msg = create_user_message(content=[TextBlock(text="hi")], source=UserSource())
    assert msg.role == "user"
    assert isinstance(msg, Message)


def test_create_assistant_message_carries_model_source():
    msg = create_assistant_message(
        content=[TextBlock(text="a")], provider="openai", model="gpt", replay_state={"k": 1}
    )
    assert isinstance(msg, AssistantMessage)
    assert msg.role == "assistant"
    assert msg.source == ModelSource(provider="openai", model="gpt", replay_state={"k": 1})


def test_assistant_message_rejects_non_model_source():
    with pytest.raises(ValidationError):
        AssistantMessage(id="m", content=[], source=UserSource())  # type: ignore[arg-type]


def test_create_tool_result_message_correlates_call_id():
    msg = create_tool_result_message(call_id="c1", content=[TextBlock(text="out")], is_error=True)
    assert isinstance(msg, ToolResultMessage)
    assert msg.role == "user"
    assert msg.source == ToolSource(call_id="c1")
    assert msg.tool_result.tool_call_id == "c1"
    assert msg.tool_result.is_error is True


def test_tool_result_message_requires_exactly_one_matching_block():
    with pytest.raises(ValidationError):
        ToolResultMessage(id="m", source=ToolSource(call_id="c1"), content=[TextBlock(text="x")])
    with pytest.raises(ValidationError):
        ToolResultMessage(
            id="m",
            source=ToolSource(call_id="c1"),
            content=[ToolResultBlock(tool_call_id="other", content=[])],
        )
    with pytest.raises(ValidationError):
        ToolResultMessage(
            id="m",
            source=ToolSource(call_id="c1"),
            content=[
                ToolResultBlock(tool_call_id="c1", content=[]),
                ToolResultBlock(tool_call_id="c1", content=[]),
            ],
        )


def test_bound_context_summary_ellipsizes():
    short = "x" * CONTEXT_SUMMARY_MAX_CHARS
    assert bound_context_summary(short) == short
    bounded = bound_context_summary("y" * (CONTEXT_SUMMARY_MAX_CHARS + 5))
    assert len(bounded) == CONTEXT_SUMMARY_MAX_CHARS
    assert bounded.endswith("…")


# ---------------------------------------------------------------------------
# 首 token 判据
# ---------------------------------------------------------------------------


def test_is_token_delta():
    assert is_token_delta(TextDeltaChunk(index=0, text="a"))
    assert not is_token_delta(TextDeltaChunk(index=0, text=""))
    assert is_token_delta(ReasoningDeltaChunk(index=0, text="r"))
    assert not is_token_delta(ToolCallDeltaChunk(index=0, id="c", arguments_delta=""))
    assert is_token_delta(ToolCallDeltaChunk(index=0, id="c", name="f", arguments_delta=""))
    assert is_token_delta(ToolCallDeltaChunk(index=0, id="c", arguments_delta="{"))
    assert not is_token_delta(BlockStartChunk(index=0, block_type="text"))
    assert not is_token_delta(FinishChunk(reason=StopFinish()))


# ---------------------------------------------------------------------------
# 调用配置与 EpochHeader
# ---------------------------------------------------------------------------


def _config(**overrides):
    base = {"provider": "openai", "model": "gpt", "temperature": 0.2, "max_tokens": 10}
    return LlmCallConfig(**{**base, **overrides})


def test_call_config_equals_fieldwise():
    assert call_config_equals(_config(), _config())
    assert not call_config_equals(_config(), _config(model="other"))
    assert not call_config_equals(_config(), _config(reasoning_effort="high"))
    assert not call_config_equals(_config(), _config(temperature=0.3))
    assert not call_config_equals(_config(), _config(max_tokens=11))


def test_call_config_equals_compares_stop_elementwise():
    assert call_config_equals(_config(stop=["a", "b"]), _config(stop=["a", "b"]))
    assert not call_config_equals(_config(stop=["a", "b"]), _config(stop=["b", "a"]))
    assert not call_config_equals(_config(stop=["a"]), _config(stop=["a", "b"]))
    assert not call_config_equals(_config(stop=None), _config(stop=[]))
    assert call_config_equals(_config(stop=None), _config(stop=None))


def test_canonical_json_is_order_independent_and_drops_empty_optionals():
    tool = ToolSchema(name="echo", description="d", parameters={"type": "object", "b": 1, "a": 2})
    header = EpochHeader(
        config=_config(), system="sys", tools=[tool], adapter_defaults={"max_tokens": True}
    )
    text = canonical_json(header)
    assert text == (
        '{"adapter_defaults":{"max_tokens":true},'
        '"config":{"max_tokens":10,"model":"gpt","provider":"openai","temperature":0.2},'
        '"system":"sys",'
        '"tools":[{"description":"d","name":"echo","parameters":{"a":2,"b":1,"type":"object"}}]}'
    )
    assert " " not in text

    bare = EpochHeader(config=_config(stop=[]), adapter_defaults={"max_tokens": False}, tools=[])
    assert canonical_json(bare) == canonical_json(EpochHeader(config=_config()))
    assert "stop" not in canonical_json(bare)


def test_canonical_json_keeps_non_ascii_readable():
    header = EpochHeader(config=_config(), system="中文提示")
    assert "中文提示" in canonical_json(header)


def test_generate_options_extends_call_config():
    options = GenerateOptions(
        provider="openai",
        model="gpt",
        messages=[create_user_message(content=[TextBlock(text="hi")], source=UserSource())],
        purpose="compaction",
    )
    assert isinstance(options, LlmCallConfig)
    assert options.tools is None
    assert options.session_id is None
    with pytest.raises(ValidationError):
        GenerateOptions(provider="p", model="m", messages=[], purpose="chat")  # type: ignore[arg-type]
