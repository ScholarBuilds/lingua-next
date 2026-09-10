"""增量分块装配器：把 StreamChunk 流攒成内容块与一条助手消息。

翻译自 deepseek-harness ``packages/llm/llm/src/assembler.ts``（全文）。

这是循环侧唯一的装配算法：循环一边把原始分块写日志（回放保真），一边喂给
装配器；流结束后读 ``blocks()`` / ``assemble()``，被取消时读 ``interrupted()``。

不变量：
- 按 index 攒 partial，容忍没有 block-start / block-end 的纯 delta 协议；
- block-end 携带的块是权威结果，首次关闭胜出，之后同 index 的 delta 与重复关闭一律忽略
  （失控的 adapter 既不能撑爆内存也不能改写已完成的块）；
- finish 缺席时按 ``stop``；``max-tokens`` 截断会丢掉无法安全执行的 tool-call 块，
  回放信封的逐块条目同步裁剪，两边不可能不一致；
- 中断时只保留有非空白内容的 text / reasoning 块（工具调用在派发之前被打断，
  保留它就得伪造一个结果）。
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from domain.kernel.llm_types import (
    AssistantMessage,
    BlockEndChunk,
    BlockStartChunk,
    ContentBlock,
    FinishChunk,
    FinishReason,
    MaxTokensFinish,
    Message,
    MessageSource,
    PluginSource,
    ReasoningBlock,
    ReasoningDeltaChunk,
    ReplayEnvelope,
    StopFinish,
    StreamChunk,
    TextBlock,
    TextDeltaChunk,
    TokenUsage,
    ToolCallBlock,
    ToolCallDeltaChunk,
    UsageChunk,
    create_assistant_message,
    create_message,
)

ASSEMBLER_PLUGIN = "kernel/llm_assembler"


class AssemblerError(RuntimeError):
    """装配器内部状态被破坏，或遇到本版本不会装配的块类型。"""


@dataclass
class _Partial:
    block_type: str
    text: str = ""
    tool_call_id: str | None = None
    tool_call_name: str | None = None
    tool_call_arguments: str = ""
    # block-end 写入，权威且冻结该 partial
    block: ContentBlock | None = None


@dataclass(frozen=True)
class AssembledResponse:
    """一次流的装配结果：助手消息（含回放状态）、结束原因、用量。"""

    message: AssistantMessage
    finish: FinishReason
    usage: TokenUsage | None


class BlockAssembler:
    def __init__(self) -> None:
        self._partials: dict[int, _Partial] = {}
        self._order: list[int] = []
        self._usage: TokenUsage | None = None
        self._finish: FinishReason | None = None
        self._replay_state: Any | None = None

    # ------------------------------------------------------------------
    # 喂入
    # ------------------------------------------------------------------

    def push(self, chunk: StreamChunk) -> None:
        """按流顺序喂入一个分块。"""
        match chunk:
            case BlockStartChunk():
                if chunk.index not in self._partials:
                    self._order.append(chunk.index)
                    self._partials[chunk.index] = _Partial(block_type=chunk.block_type)
            case TextDeltaChunk() | ReasoningDeltaChunk():
                kind = "text" if isinstance(chunk, TextDeltaChunk) else "reasoning"
                partial = self._ensure(chunk.index, kind)
                if partial.block is not None:
                    return  # 已被 block-end 关闭，忽略迟到的 delta
                partial.text += chunk.text
            case ToolCallDeltaChunk():
                partial = self._ensure(chunk.index, "tool-call")
                if partial.block is not None:
                    return
                if chunk.id is not None:
                    partial.tool_call_id = chunk.id
                if chunk.name:
                    partial.tool_call_name = chunk.name
                partial.tool_call_arguments += chunk.arguments_delta
            case BlockEndChunk():
                partial = self._ensure(chunk.index, chunk.block.type)
                # 首次关闭胜出：流式输出与最终块保持一致，重复关闭当作离群帧忽略
                if partial.block is not None:
                    return
                partial.block = chunk.block
            case UsageChunk():
                self._usage = chunk.usage
            case FinishChunk():
                self._finish = chunk.reason
                self._replay_state = chunk.replay_state
            case _:
                raise AssemblerError(f"unreachable variant in BlockAssembler.push: {chunk!r}")

    def _ensure(self, index: int, block_type: str) -> _Partial:
        partial = self._partials.get(index)
        if partial is None:
            partial = _Partial(block_type=block_type)
            self._partials[index] = partial
            self._order.append(index)
        return partial

    # ------------------------------------------------------------------
    # 装配
    # ------------------------------------------------------------------

    @staticmethod
    def _assemble_block(partial: _Partial, index: int) -> ContentBlock:
        if partial.block is not None:
            return partial.block
        match partial.block_type:
            case "text":
                return TextBlock(text=partial.text)
            case "reasoning":
                return ReasoningBlock(text=partial.text)
            case "tool-call":
                return ToolCallBlock(
                    id=partial.tool_call_id or f"call-{index}",
                    name=partial.tool_call_name or "",
                    arguments=partial.tool_call_arguments,
                )
            case other:
                raise AssemblerError(f'cannot assemble incomplete block of type "{other}"')

    def _must_get(self, index: int) -> _Partial:
        """不变量：``_order`` 里的每个 index 都有 partial。"""
        partial = self._partials.get(index)
        if partial is None:
            raise AssemblerError(f"BlockAssembler invariant violated: no partial for index {index}")
        return partial

    @staticmethod
    def _envelope(state: Any) -> ReplayEnvelope | None:
        """识别信封形状的回放状态；其它形状视为不透明，原样穿过。"""
        if isinstance(state, ReplayEnvelope):
            return state
        if isinstance(state, Mapping) and ("response" in state or "blocks" in state):
            return ReplayEnvelope.model_validate(dict(state))
        return None

    def _assembled(self) -> tuple[list[ContentBlock], Any | None]:
        """全部已见块上唯一的一次保留 / 丢弃决策；输出块与回放元数据同源，不会分歧。"""
        all_blocks = [self._assemble_block(self._must_get(i), i) for i in self._order]
        kept: list[bool] | None = None
        if isinstance(self.finish, MaxTokensFinish):
            kept = [block.type != "tool-call" for block in all_blocks]
        blocks = (
            all_blocks
            if kept is None
            else [b for b, keep in zip(all_blocks, kept, strict=True) if keep]
        )

        state = self._replay_state
        envelope = self._envelope(state)
        if envelope is None or envelope.blocks is None:
            return blocks, state
        if len(envelope.blocks) != len(all_blocks):
            return blocks, None
        if kept is None or len(blocks) == len(all_blocks):
            return blocks, state
        pruned = [entry for entry, keep in zip(envelope.blocks, kept, strict=True) if keep]
        return blocks, ReplayEnvelope(response=envelope.response, blocks=pruned)

    def blocks(self) -> list[ContentBlock]:
        """按流顺序装配全部已见块；max-tokens 截断丢掉 tool-call 块；
        未被 block-end 关闭的未知类型块抛 AssemblerError。"""
        return self._assembled()[0]

    def interrupted(self) -> list[ContentBlock]:
        """中断时可安全定稿的前缀：有非空白内容的 text / reasoning 块（已关闭或未关闭均可），
        按流顺序；工具调用与未知类型块一律不保留。"""
        kept: list[ContentBlock] = []
        for index in self._order:
            partial = self._must_get(index)
            kind = partial.block.type if partial.block is not None else partial.block_type
            if kind not in ("text", "reasoning"):
                continue
            block = self._assemble_block(partial, index)
            if isinstance(block, TextBlock | ReasoningBlock) and block.text.strip() != "":
                kept.append(block)
        return kept

    # 与原版同名的别名，方便对照阅读
    interrupted_blocks = interrupted

    @property
    def usage(self) -> TokenUsage | None:
        """usage 分块带来的用量；没收到则为 None。"""
        return self._usage

    @property
    def finish(self) -> FinishReason:
        """finish 分块的结束原因；流没有 finish 就结束时按 stop。"""
        return self._finish if self._finish is not None else StopFinish()

    @property
    def replay_state(self) -> Any | None:
        """终止 finish 携带的回放状态；信封形状的逐块条目随 ``blocks()`` 同步裁剪，
        条目数与块数对不上时为 None。"""
        return self._assembled()[1]

    def message(self, source: MessageSource | None = None) -> Message:
        """按 ``blocks()`` 构造一条 assistant 角色消息（默认归属装配器插件）。"""
        return create_message(
            role="assistant",
            content=self.blocks(),
            source=source if source is not None else PluginSource(plugin=ASSEMBLER_PLUGIN),
        )

    def assemble(self, *, provider: str, model: str) -> AssembledResponse:
        """流结束后一次性取走结果：带模型来源与回放状态的助手消息、结束原因、用量。"""
        blocks, replay = self._assembled()
        return AssembledResponse(
            message=create_assistant_message(
                content=blocks, provider=provider, model=model, replay_state=replay
            ),
            finish=self.finish,
            usage=self._usage,
        )


__all__ = ["ASSEMBLER_PLUGIN", "AssembledResponse", "AssemblerError", "BlockAssembler"]
