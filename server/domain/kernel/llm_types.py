"""LLM 供应商中立词汇：消息、内容块、流式分块、用量、失败与调用配置。

翻译自 deepseek-harness：
- ``packages/llm/llm/src/types.ts``（:40-141 内容块 / 结束原因 / 用量；
  :290-377 流式分块 / 工具 schema / 请求）
- ``packages/llm/llm/src/message.ts``（消息来源、消息构造）
- ``packages/llm/llm/src/call-config.ts``（:23-117 LlmCallConfig 与字段等值）
- ``packages/core/session/src/types.ts``（:201-228 EpochHeader）

设计约束沿用原版：adapter 只做翻译，业务层与会话日志只认这套词汇；所有模型
冻结（frozen），发布后不可改；判别联合按 ``type`` / ``kind`` 字段分派。
"""

from __future__ import annotations

import json
import uuid
from typing import Annotated, Any, Literal, cast

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, model_validator

_FROZEN = ConfigDict(frozen=True)


# ---------------------------------------------------------------------------
# 失败事实
# ---------------------------------------------------------------------------

LlmFailureCode = Literal[
    "AUTH",
    "RATE_LIMIT",
    "INVALID_REQUEST",
    "SERVER",
    "TIMEOUT",
    "TRANSPORT",
    "CONTEXT_WINDOW_EXCEEDED",
    "EMPTY_RESPONSE",
    "ABORTED",
    "UNKNOWN",
]

# 响应正常结束却一个内容块都没有：空消息会让回合静默结束，按失败分类且可安全重试
EMPTY_RESPONSE_CODE: LlmFailureCode = "EMPTY_RESPONSE"
CONTEXT_WINDOW_EXCEEDED_CODE: LlmFailureCode = "CONTEXT_WINDOW_EXCEEDED"


class LlmFailure(BaseModel):
    """可序列化的供应商 / 传输层失败事实；是否重试由策略层决定，这里只记录。"""

    model_config = _FROZEN

    message: str
    code: LlmFailureCode
    status: int | None = None
    provider_retry_after_ms: int | None = None
    request_id: str | None = None


# ---------------------------------------------------------------------------
# 内容块
# ---------------------------------------------------------------------------


class ImageAttachment(BaseModel):
    """图片附件引用：指向已落库的资产，或内联 data URL。"""

    model_config = _FROZEN

    asset_id: int | None = None
    media_asset_id: int | None = None
    mime: str
    width: int | None = None
    height: int | None = None
    data_url: str | None = None


class TextBlock(BaseModel):
    """用户可见的纯文本。"""

    model_config = _FROZEN

    type: Literal["text"] = "text"
    text: str


class ReasoningBlock(BaseModel):
    """推理 / 思考内容，与可见文本分开。"""

    model_config = _FROZEN

    type: Literal["reasoning"] = "reasoning"
    text: str


class ImageBlock(BaseModel):
    """图片引用，用户与助手内容均可携带。"""

    model_config = _FROZEN

    type: Literal["image"] = "image"
    attachment: ImageAttachment


class ToolCallBlock(BaseModel):
    """模型发起的一次工具调用；``arguments`` 保留模型产出的原始 JSON 串。"""

    model_config = _FROZEN

    type: Literal["tool-call"] = "tool-call"
    id: str
    name: str
    arguments: str


class ToolResultBlock(BaseModel):
    """回传给模型的工具结果。"""

    model_config = _FROZEN

    type: Literal["tool-result"] = "tool-result"
    tool_call_id: str
    content: list[ContentBlock]
    is_error: bool = False


ContentBlock = Annotated[
    TextBlock | ReasoningBlock | ImageBlock | ToolCallBlock | ToolResultBlock,
    Field(discriminator="type"),
]
ContentBlockType = Literal["text", "reasoning", "image", "tool-call", "tool-result"]

ToolResultBlock.model_rebuild()


# ---------------------------------------------------------------------------
# 消息来源
# ---------------------------------------------------------------------------

ContextForm = Literal["instructions", "catalog", "snapshot", "notice", "relay", "recall"]

# notice 摘要挂在折叠的会话行上并进持久日志，输入（任务标签、工具参数）本身没有长度上限
CONTEXT_SUMMARY_MAX_CHARS = 120


def bound_context_summary(summary: str) -> str:
    """把 notice 摘要截到 CONTEXT_SUMMARY_MAX_CHARS 以内，超长以省略号收尾。"""
    if len(summary) <= CONTEXT_SUMMARY_MAX_CHARS:
        return summary
    return summary[: CONTEXT_SUMMARY_MAX_CHARS - 1] + "…"


class UserSource(BaseModel):
    model_config = _FROZEN

    kind: Literal["user"] = "user"


class PluginSource(BaseModel):
    """插件注入的上下文。``kind`` 回答"谁产出的"，``form`` 回答"是什么性质的内容"，两轴独立。"""

    model_config = _FROZEN

    kind: Literal["plugin"] = "plugin"
    plugin: str
    form: ContextForm | None = None
    summary: str | None = None


class ModelSource(BaseModel):
    """由路由到的模型产出；``replay_state`` 是 adapter 私有的回放状态，对外不透明。"""

    model_config = _FROZEN

    kind: Literal["model"] = "model"
    provider: str
    model: str
    replay_state: Any | None = None


class ToolSource(BaseModel):
    model_config = _FROZEN

    kind: Literal["tool"] = "tool"
    call_id: str


MessageSource = Annotated[
    UserSource | PluginSource | ModelSource | ToolSource,
    Field(discriminator="kind"),
]

MessageRole = Literal["system", "user", "assistant"]


# ---------------------------------------------------------------------------
# 消息
# ---------------------------------------------------------------------------


class Message(BaseModel):
    """投递、持久历史、模型请求三处共用的同一份不可变消息。"""

    model_config = _FROZEN

    id: str
    role: MessageRole
    content: list[ContentBlock]
    source: MessageSource


class UserMessage(Message):
    role: Literal["user"] = "user"


class AssistantMessage(Message):
    role: Literal["assistant"] = "assistant"
    source: ModelSource


class ToolResultMessage(Message):
    """恰好携带一个 tool-result 块的 user 角色消息，块与来源的 call id 必须一致。"""

    role: Literal["user"] = "user"
    source: ToolSource

    @model_validator(mode="after")
    def _single_tool_result(self) -> ToolResultMessage:
        if len(self.content) != 1 or not isinstance(self.content[0], ToolResultBlock):
            raise ValueError("ToolResultMessage 必须恰好包含一个 tool-result 块")
        if self.content[0].tool_call_id != self.source.call_id:
            raise ValueError("tool-result 块的 tool_call_id 与 source.call_id 不一致")
        return self

    @property
    def tool_result(self) -> ToolResultBlock:
        return cast(ToolResultBlock, self.content[0])


def new_message_id() -> str:
    return str(uuid.uuid4())


def create_message(
    *, role: MessageRole, content: list[ContentBlock], source: MessageSource
) -> Message:
    """分配新身份并构造消息。"""
    return Message(id=new_message_id(), role=role, content=content, source=source)


def create_user_message(*, content: list[ContentBlock], source: MessageSource) -> UserMessage:
    return UserMessage(id=new_message_id(), content=content, source=source)


def create_assistant_message(
    *,
    content: list[ContentBlock],
    provider: str,
    model: str,
    replay_state: Any | None = None,
) -> AssistantMessage:
    return AssistantMessage(
        id=new_message_id(),
        content=content,
        source=ModelSource(provider=provider, model=model, replay_state=replay_state),
    )


def create_tool_result_message(
    *, call_id: str, content: list[ContentBlock], is_error: bool = False
) -> ToolResultMessage:
    return ToolResultMessage(
        id=new_message_id(),
        source=ToolSource(call_id=call_id),
        content=[ToolResultBlock(tool_call_id=call_id, content=content, is_error=is_error)],
    )


# ---------------------------------------------------------------------------
# 用量与结束原因
# ---------------------------------------------------------------------------


class TokenUsage(BaseModel):
    """一次模型调用的 token 账目。

    三个输入口径互不重叠：``input_tokens`` 只算未命中缓存的输入，缓存读写单独记
    （计费输入 = 三者之和）。供应商把缓存命中折进总 prompt 数的（DeepSeek /
    OpenAI 的 ``prompt_tokens``），由 adapter 扣掉。``reasoning_tokens`` 是
    ``output_tokens`` 的子集。
    """

    model_config = _FROZEN

    input_tokens: int
    output_tokens: int
    cache_read_tokens: int | None = None
    cache_write_tokens: int | None = None
    reasoning_tokens: int | None = None


class StopFinish(BaseModel):
    model_config = _FROZEN

    kind: Literal["stop"] = "stop"


class ToolCallsFinish(BaseModel):
    model_config = _FROZEN

    kind: Literal["tool-calls"] = "tool-calls"


class MaxTokensFinish(BaseModel):
    model_config = _FROZEN

    kind: Literal["max-tokens"] = "max-tokens"


class AbortedFinish(BaseModel):
    model_config = _FROZEN

    kind: Literal["aborted"] = "aborted"
    failure: LlmFailure


class ErrorFinish(BaseModel):
    model_config = _FROZEN

    kind: Literal["error"] = "error"
    failure: LlmFailure


FinishReason = Annotated[
    StopFinish | ToolCallsFinish | MaxTokensFinish | AbortedFinish | ErrorFinish,
    Field(discriminator="kind"),
]


# ---------------------------------------------------------------------------
# 流式分块协议
# ---------------------------------------------------------------------------


class ReplayEnvelope(BaseModel):
    """adapter 私有的回放元数据：``response`` 是响应级，``blocks`` 按首次出现顺序逐块一条。

    装配丢块时同位置的条目一起丢；条目数与块数对不上则整个信封作废。与块结构
    无关的 adapter 不填 ``blocks``，信封原样穿过装配。
    """

    model_config = _FROZEN

    response: Any = None
    blocks: list[Any] | None = None


StreamBlockType = Literal["text", "reasoning", "tool-call"]


class BlockStartChunk(BaseModel):
    model_config = _FROZEN

    type: Literal["block-start"] = "block-start"
    index: int
    block_type: StreamBlockType


class TextDeltaChunk(BaseModel):
    model_config = _FROZEN

    type: Literal["text-delta"] = "text-delta"
    index: int
    text: str


class ReasoningDeltaChunk(BaseModel):
    model_config = _FROZEN

    type: Literal["reasoning-delta"] = "reasoning-delta"
    index: int
    text: str


class ToolCallDeltaChunk(BaseModel):
    model_config = _FROZEN

    type: Literal["tool-call-delta"] = "tool-call-delta"
    index: int
    id: str | None = None
    name: str | None = None
    arguments_delta: str


class BlockEndChunk(BaseModel):
    """块关闭，携带装配完成的权威块。"""

    model_config = _FROZEN

    type: Literal["block-end"] = "block-end"
    index: int
    block: ContentBlock


class UsageChunk(BaseModel):
    model_config = _FROZEN

    type: Literal["usage"] = "usage"
    usage: TokenUsage


class FinishChunk(BaseModel):
    """终止分块；usage 在它之前到达，之后不再有任何分块。"""

    model_config = _FROZEN

    type: Literal["finish"] = "finish"
    reason: FinishReason
    replay_state: Any | None = None


StreamChunk = Annotated[
    BlockStartChunk
    | TextDeltaChunk
    | ReasoningDeltaChunk
    | ToolCallDeltaChunk
    | BlockEndChunk
    | UsageChunk
    | FinishChunk,
    Field(discriminator="type"),
]


def is_token_delta(chunk: StreamChunk) -> bool:
    """分块是否携带可见的模型输出（首 token 时点的判据）。空 delta（心跳、空工具帧）不算。"""
    match chunk:
        case TextDeltaChunk() | ReasoningDeltaChunk():
            return chunk.text != ""
        case ToolCallDeltaChunk():
            return chunk.arguments_delta != "" or chunk.name is not None
        case _:
            return False


# ---------------------------------------------------------------------------
# 工具 schema、调用配置、请求
# ---------------------------------------------------------------------------


class ToolSchema(BaseModel):
    """发给模型的工具描述；``parameters`` 是 JSON Schema 对象。"""

    model_config = _FROZEN

    name: str
    description: str
    parameters: dict[str, Any]


class LlmCallConfig(BaseModel):
    """一段对话请求的供应商 / 模型 / 推理强度 / 采样标量。

    这些是会影响缓存复用的请求头状态：循环按日志里的 header 快照构造请求，
    不接受逐次调用的漂移。
    """

    model_config = _FROZEN

    provider: str
    model: str
    reasoning_effort: str | None = None
    temperature: float | None = None
    max_tokens: int | None = None
    stop: list[str] | None = None


def call_config_equals(a: LlmCallConfig, b: LlmCallConfig) -> bool:
    """逐字段等值（``stop`` 逐元素比较）；用于判断提议的配置是真变化还是原样重申。"""
    if (
        a.provider != b.provider
        or a.model != b.model
        or a.reasoning_effort != b.reasoning_effort
        or a.temperature != b.temperature
        or a.max_tokens != b.max_tokens
    ):
        return False
    if a.stop is None or b.stop is None:
        return a.stop is b.stop
    return len(a.stop) == len(b.stop) and all(x == y for x, y in zip(a.stop, b.stop, strict=True))


class EpochHeader(BaseModel):
    """派生历史之外的请求状态：调用配置、系统提示、工具。最新一份完整快照即可重建。"""

    model_config = _FROZEN

    config: LlmCallConfig
    adapter_defaults: dict[str, bool] | None = None
    system: str | None = None
    tools: list[ToolSchema] | None = None


def canonical_json(header: EpochHeader) -> str:
    """EpochHeader 的规范 JSON：键排序、无空白、空可选字段一律缺省，同一 header 得同一串。"""
    data = header.model_dump(mode="json", exclude_none=True)
    defaults = {key: True for key, on in (header.adapter_defaults or {}).items() if on}
    if defaults:
        data["adapter_defaults"] = defaults
    else:
        data.pop("adapter_defaults", None)
    if not header.tools:
        data.pop("tools", None)
    if header.config.stop is not None and not header.config.stop:
        data["config"].pop("stop", None)
    return json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


class GenerateOptions(LlmCallConfig):
    """一次完整装配好的模型请求。"""

    messages: list[Message]
    system: str | None = None
    tools: list[ToolSchema] | None = None
    session_id: str | None = None
    purpose: Literal["compaction", "session-title"] | None = None


# ---------------------------------------------------------------------------
# 解析入口（日志回放、跨进程传输）
# ---------------------------------------------------------------------------

CONTENT_BLOCK_ADAPTER: TypeAdapter[Any] = TypeAdapter(ContentBlock)
MESSAGE_SOURCE_ADAPTER: TypeAdapter[Any] = TypeAdapter(MessageSource)
FINISH_REASON_ADAPTER: TypeAdapter[Any] = TypeAdapter(FinishReason)
STREAM_CHUNK_ADAPTER: TypeAdapter[Any] = TypeAdapter(StreamChunk)


def parse_content_block(data: Any) -> ContentBlock:
    return cast(ContentBlock, CONTENT_BLOCK_ADAPTER.validate_python(data))


def parse_message_source(data: Any) -> MessageSource:
    return cast(MessageSource, MESSAGE_SOURCE_ADAPTER.validate_python(data))


def parse_finish_reason(data: Any) -> FinishReason:
    return cast(FinishReason, FINISH_REASON_ADAPTER.validate_python(data))


def parse_stream_chunk(data: Any) -> StreamChunk:
    return cast(StreamChunk, STREAM_CHUNK_ADAPTER.validate_python(data))


__all__ = [
    "CONTEXT_SUMMARY_MAX_CHARS",
    "CONTEXT_WINDOW_EXCEEDED_CODE",
    "EMPTY_RESPONSE_CODE",
    "AbortedFinish",
    "AssistantMessage",
    "BlockEndChunk",
    "BlockStartChunk",
    "ContentBlock",
    "ContentBlockType",
    "ContextForm",
    "EpochHeader",
    "ErrorFinish",
    "FinishChunk",
    "FinishReason",
    "GenerateOptions",
    "ImageAttachment",
    "ImageBlock",
    "LlmCallConfig",
    "LlmFailure",
    "LlmFailureCode",
    "MaxTokensFinish",
    "Message",
    "MessageRole",
    "MessageSource",
    "ModelSource",
    "PluginSource",
    "ReasoningBlock",
    "ReasoningDeltaChunk",
    "ReplayEnvelope",
    "StopFinish",
    "StreamBlockType",
    "StreamChunk",
    "TextBlock",
    "TextDeltaChunk",
    "TokenUsage",
    "ToolCallBlock",
    "ToolCallDeltaChunk",
    "ToolCallsFinish",
    "ToolResultBlock",
    "ToolResultMessage",
    "ToolSchema",
    "ToolSource",
    "UsageChunk",
    "UserMessage",
    "UserSource",
    "bound_context_summary",
    "call_config_equals",
    "canonical_json",
    "create_assistant_message",
    "create_message",
    "create_tool_result_message",
    "create_user_message",
    "is_token_delta",
    "new_message_id",
    "parse_content_block",
    "parse_finish_reason",
    "parse_message_source",
    "parse_stream_chunk",
]
