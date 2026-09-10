"""BlockAssembler 不变量：按 index 攒块、block-end 权威且首关胜出、截断丢工具调用、中断前缀。"""

import pytest

from domain.kernel.llm_assembler import ASSEMBLER_PLUGIN, AssemblerError, BlockAssembler
from domain.kernel.llm_types import (
    AssistantMessage,
    BlockEndChunk,
    BlockStartChunk,
    FinishChunk,
    MaxTokensFinish,
    ModelSource,
    PluginSource,
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


def _fed(*chunks) -> BlockAssembler:
    assembler = BlockAssembler()
    for chunk in chunks:
        assembler.push(chunk)
    return assembler


def test_assembles_interleaved_text_reasoning_and_tool_call_deltas():
    assembler = _fed(
        BlockStartChunk(index=0, block_type="reasoning"),
        ReasoningDeltaChunk(index=0, text="thinking…"),
        BlockEndChunk(index=0, block=ReasoningBlock(text="thinking…")),
        BlockStartChunk(index=1, block_type="text"),
        TextDeltaChunk(index=1, text="Hello"),
        TextDeltaChunk(index=1, text=" world"),
        BlockStartChunk(index=2, block_type="tool-call"),
        ToolCallDeltaChunk(index=2, id="call-1", name="echo", arguments_delta='{"text":'),
        ToolCallDeltaChunk(index=2, id="call-1", arguments_delta='"hi"}'),
        UsageChunk(usage=TokenUsage(input_tokens=10, output_tokens=5)),
        FinishChunk(reason=ToolCallsFinish()),
    )
    assert assembler.blocks() == [
        ReasoningBlock(text="thinking…"),
        TextBlock(text="Hello world"),
        ToolCallBlock(id="call-1", name="echo", arguments='{"text":"hi"}'),
    ]
    assert assembler.usage == TokenUsage(input_tokens=10, output_tokens=5)
    assert assembler.finish == ToolCallsFinish()
    assert assembler.message().role == "assistant"


def test_records_the_completed_block_from_block_end():
    assembler = _fed(
        BlockStartChunk(index=0, block_type="text"),
        TextDeltaChunk(index=0, text="hi"),
        BlockEndChunk(index=0, block=TextBlock(text="hi")),
    )
    assert assembler.blocks() == [TextBlock(text="hi")]


def test_block_end_is_authoritative_over_accumulated_deltas():
    assembler = _fed(
        TextDeltaChunk(index=0, text="streamed"),
        BlockEndChunk(index=0, block=TextBlock(text="final")),
    )
    assert assembler.blocks() == [TextBlock(text="final")]


def test_tolerates_deltas_without_block_start_or_end():
    assembler = _fed(TextDeltaChunk(index=0, text="implicit"))
    assert assembler.blocks() == [TextBlock(text="implicit")]
    assert assembler.finish == StopFinish()


def test_usage_is_none_until_a_usage_chunk_arrives():
    assembler = _fed(TextDeltaChunk(index=0, text="no usage"))
    assert assembler.usage is None
    assembler.push(UsageChunk(usage=TokenUsage(input_tokens=5, output_tokens=3)))
    assert assembler.usage == TokenUsage(input_tokens=5, output_tokens=3)


def test_unknown_open_block_type_cannot_be_assembled():
    assembler = BlockAssembler()
    # 插件扩展的块类型没有 block-end 就无法从 delta 装配；绕过校验构造一个 video 开块
    assembler.push(BlockStartChunk.model_construct(index=0, block_type="video"))
    with pytest.raises(AssemblerError, match='cannot assemble incomplete block of type "video"'):
        assembler.blocks()


def test_invariant_violation_when_order_has_no_partial():
    assembler = BlockAssembler()
    assembler._order.append(99)
    with pytest.raises(AssemblerError, match="invariant violated"):
        assembler.blocks()


def test_push_rejects_chunks_outside_the_union():
    assembler = BlockAssembler()
    with pytest.raises(AssemblerError, match="unreachable variant"):
        assembler.push({"type": "rogue-chunk"})  # type: ignore[arg-type]


def test_ignores_duplicate_block_start_for_the_same_index():
    assembler = _fed(
        BlockStartChunk(index=0, block_type="text"),
        TextDeltaChunk(index=0, text="one"),
        BlockStartChunk(index=0, block_type="text"),
        TextDeltaChunk(index=0, text=" two"),
        BlockEndChunk(index=0, block=TextBlock(text="one two")),
    )
    assert assembler.blocks() == [TextBlock(text="one two")]


def test_ignores_stragglers_after_block_end():
    assembler = _fed(
        BlockStartChunk(index=0, block_type="tool-call"),
        ToolCallDeltaChunk(index=0, id="c1", name="echo", arguments_delta="{}"),
        BlockEndChunk(index=0, block=ToolCallBlock(id="c1", name="echo", arguments="{}")),
        ToolCallDeltaChunk(index=0, id="c1", name="evil", arguments_delta="oops"),
        BlockEndChunk(index=1, block=TextBlock(text="done")),
        TextDeltaChunk(index=1, text=" more"),
        ReasoningDeltaChunk(index=1, text=" thoughts"),
    )
    assert assembler.blocks() == [
        ToolCallBlock(id="c1", name="echo", arguments="{}"),
        TextBlock(text="done"),
    ]


def test_first_block_end_wins_on_duplicate_close():
    assembler = _fed(
        BlockEndChunk(index=0, block=ReasoningBlock(text="first")),
        BlockEndChunk(index=0, block=TextBlock(text="second")),
    )
    assert assembler.blocks() == [ReasoningBlock(text="first")]


def test_tool_call_falls_back_to_generated_id_and_empty_name():
    assembler = _fed(ToolCallDeltaChunk(index=0, arguments_delta="{}"))
    assert assembler.blocks() == [ToolCallBlock(id="call-0", name="", arguments="{}")]


def test_tool_call_keeps_last_id_and_ignores_empty_name():
    assembler = _fed(
        ToolCallDeltaChunk(index=0, id="", name="", arguments_delta=""),
        ToolCallDeltaChunk(index=0, id="c9", name="run", arguments_delta="{"),
        ToolCallDeltaChunk(index=0, id="c9", name="", arguments_delta="}"),
    )
    assert assembler.blocks() == [ToolCallBlock(id="c9", name="run", arguments="{}")]


# ---------------------------------------------------------------------------
# max-tokens 截断
# ---------------------------------------------------------------------------


def test_max_tokens_drops_tool_calls_but_keeps_text_and_reasoning():
    assembler = _fed(
        BlockEndChunk(index=0, block=TextBlock(text="lead")),
        BlockEndChunk(index=1, block=ToolCallBlock(id="c1", name="echo", arguments='{"text":')),
        BlockEndChunk(index=2, block=ReasoningBlock(text="tail")),
        FinishChunk(reason=MaxTokensFinish()),
    )
    assert assembler.blocks() == [TextBlock(text="lead"), ReasoningBlock(text="tail")]
    assert assembler.finish == MaxTokensFinish()


def test_non_truncated_finish_keeps_tool_calls():
    assembler = _fed(
        BlockEndChunk(index=0, block=ToolCallBlock(id="c1", name="echo", arguments="{}")),
        FinishChunk(reason=ToolCallsFinish()),
    )
    assert assembler.blocks() == [ToolCallBlock(id="c1", name="echo", arguments="{}")]


# ---------------------------------------------------------------------------
# 回放信封
# ---------------------------------------------------------------------------

RESPONSE = {"response_id": "resp-1"}


def test_prunes_replay_entries_with_the_tool_calls_max_tokens_drops():
    assembler = _fed(
        BlockEndChunk(index=0, block=TextBlock(text="lead")),
        BlockEndChunk(index=1, block=ToolCallBlock(id="c1", name="echo", arguments='{"text":')),
        BlockEndChunk(index=2, block=ReasoningBlock(text="tail")),
        FinishChunk(
            reason=MaxTokensFinish(),
            replay_state=ReplayEnvelope(response=RESPONSE, blocks=["meta-0", "meta-1", "meta-2"]),
        ),
    )
    assert assembler.replay_state == ReplayEnvelope(response=RESPONSE, blocks=["meta-0", "meta-2"])


def test_dict_shaped_replay_envelope_is_pruned_too():
    assembler = _fed(
        BlockEndChunk(index=0, block=TextBlock(text="lead")),
        BlockEndChunk(index=1, block=ToolCallBlock(id="c1", name="echo", arguments="{")),
        FinishChunk(
            reason=MaxTokensFinish(),
            replay_state={"response": RESPONSE, "blocks": ["meta-0", "meta-1"]},
        ),
    )
    assert assembler.replay_state == ReplayEnvelope(response=RESPONSE, blocks=["meta-0"])


def test_omits_replay_metadata_whose_entries_misalign_with_blocks():
    assembler = _fed(
        BlockEndChunk(index=0, block=TextBlock(text="one")),
        BlockEndChunk(index=1, block=TextBlock(text="two")),
        FinishChunk(
            reason=StopFinish(), replay_state=ReplayEnvelope(response=RESPONSE, blocks=["m0"])
        ),
    )
    assert len(assembler.blocks()) == 2
    assert assembler.replay_state is None


def test_passes_replay_metadata_through_when_nothing_is_dropped():
    envelope = ReplayEnvelope(response=RESPONSE, blocks=["meta-0", "meta-1"])
    assembler = _fed(
        BlockEndChunk(index=0, block=TextBlock(text="partial")),
        BlockEndChunk(index=1, block=ToolCallBlock(id="c1", name="echo", arguments="{}")),
        FinishChunk(reason=ToolCallsFinish(), replay_state=envelope),
    )
    assert assembler.replay_state is envelope


def test_keeps_envelope_without_block_entries_across_a_tool_call_drop():
    envelope = ReplayEnvelope(response=RESPONSE)
    assembler = _fed(
        BlockEndChunk(index=0, block=TextBlock(text="partial")),
        BlockEndChunk(index=1, block=ToolCallBlock(id="c1", name="echo", arguments='{"text":')),
        FinishChunk(reason=MaxTokensFinish(), replay_state=envelope),
    )
    assert assembler.blocks() == [TextBlock(text="partial")]
    assert assembler.replay_state is envelope


def test_keeps_text_only_max_tokens_replay_intact():
    envelope = ReplayEnvelope(response=RESPONSE, blocks=["meta-0"])
    assembler = _fed(
        BlockEndChunk(index=0, block=TextBlock(text="partial")),
        FinishChunk(reason=MaxTokensFinish(), replay_state=envelope),
    )
    assert assembler.blocks() == [TextBlock(text="partial")]
    assert assembler.replay_state is envelope


def test_opaque_replay_state_passes_through_untouched():
    assembler = _fed(
        BlockEndChunk(index=0, block=TextBlock(text="x")),
        FinishChunk(reason=StopFinish(), replay_state="opaque-cursor"),
    )
    assert assembler.replay_state == "opaque-cursor"


# ---------------------------------------------------------------------------
# 中断前缀
# ---------------------------------------------------------------------------


def test_interrupted_keeps_closed_and_open_text_reasoning_in_order():
    assembler = _fed(
        BlockStartChunk(index=0, block_type="reasoning"),
        ReasoningDeltaChunk(index=0, text="planning"),
        BlockEndChunk(index=0, block=ReasoningBlock(text="planning")),
        BlockStartChunk(index=1, block_type="text"),
        TextDeltaChunk(index=1, text="half an ans"),
    )
    assert assembler.interrupted() == [
        ReasoningBlock(text="planning"),
        TextBlock(text="half an ans"),
    ]
    assert assembler.interrupted_blocks() == assembler.interrupted()


def test_interrupted_drops_tool_calls_open_or_closed():
    assembler = _fed(
        BlockStartChunk(index=0, block_type="text"),
        TextDeltaChunk(index=0, text="calling"),
        BlockEndChunk(index=0, block=TextBlock(text="calling")),
        BlockStartChunk(index=1, block_type="tool-call"),
        ToolCallDeltaChunk(index=1, id="c1", name="read", arguments_delta='{"a":1}'),
        BlockEndChunk(index=1, block=ToolCallBlock(id="c1", name="read", arguments='{"a":1}')),
        BlockStartChunk(index=2, block_type="tool-call"),
        ToolCallDeltaChunk(index=2, id="c2", name="read", arguments_delta='{"pa'),
    )
    assert assembler.interrupted() == [TextBlock(text="calling")]


def test_interrupted_drops_blank_blocks_and_unknown_open_types():
    assembler = BlockAssembler()
    assembler.push(BlockStartChunk(index=0, block_type="text"))
    assembler.push(TextDeltaChunk(index=0, text="  \n"))
    assembler.push(BlockStartChunk.model_construct(index=1, block_type="mystery"))
    assembler.push(BlockStartChunk(index=2, block_type="reasoning"))
    assert assembler.interrupted() == []


# ---------------------------------------------------------------------------
# 消息与 assemble()
# ---------------------------------------------------------------------------


def test_message_defaults_to_assembler_plugin_source():
    assembler = _fed(TextDeltaChunk(index=0, text="hi"))
    message = assembler.message()
    assert message.source == PluginSource(plugin=ASSEMBLER_PLUGIN)
    custom = assembler.message(ModelSource(provider="p", model="m"))
    assert custom.source == ModelSource(provider="p", model="m")
    assert custom.id != message.id


def test_assemble_returns_assistant_message_finish_and_usage():
    envelope = ReplayEnvelope(response=RESPONSE, blocks=["m0", "m1"])
    assembler = _fed(
        BlockEndChunk(index=0, block=TextBlock(text="lead")),
        BlockEndChunk(index=1, block=ToolCallBlock(id="c1", name="echo", arguments="{")),
        UsageChunk(usage=TokenUsage(input_tokens=2, output_tokens=9, reasoning_tokens=4)),
        FinishChunk(reason=MaxTokensFinish(), replay_state=envelope),
    )
    result = assembler.assemble(provider="openai", model="gpt")
    assert isinstance(result.message, AssistantMessage)
    assert result.message.content == [TextBlock(text="lead")]
    assert result.message.source == ModelSource(
        provider="openai",
        model="gpt",
        replay_state=ReplayEnvelope(response=RESPONSE, blocks=["m0"]),
    )
    assert result.finish == MaxTokensFinish()
    assert result.usage == TokenUsage(input_tokens=2, output_tokens=9, reasoning_tokens=4)


def test_assemble_without_finish_or_usage():
    result = _fed(TextDeltaChunk(index=0, text="x")).assemble(provider="p", model="m")
    assert result.finish == StopFinish()
    assert result.usage is None
    assert result.message.source.replay_state is None
