"""GPT 创作对话：能看图、会自己决定出图的 Agent 式流式对话（模块 17 FR-476）。

与「对话生图」（domain/studio.py + /images）的分工：那边一轮必出图，参考锚定是硬
语义；这边一轮可能只说话，**出不出图由模型自己用工具调用决定**。所以这里是一个
带工具的 Agent 循环，不是一条生成流水线。

三条底线：

- **生成同路**（BR-141）：出图工具落到 `imagegen.render_images` + `image_assets.ingest_one`，
  与控制台、画布走的是同一条出图与入库代码，不另开第二条通路；产图照样进
  `image_asset`（BR-140），血缘、去重、用量自动生效。编辑、视频、工作流这些长任务经
  `start_tool_operation` 建任务入队，与 REST、画布、DAG、MCP 同一条执行路径。
- **不打转**：工具最多连调 `MAX_TOOL_CALLS` 次、模型最多说 `MAX_ROUNDS` 轮。
  每次调用都是花钱的，模型陷进「再试一张」的循环时代价是真金白银。
- **断流不丢已出的图**（BR-110）：任何一步炸了都先 `error` 把原因原样吐出去，
  再把**已经生成的内容照样落库**（assistant 轮次带 error 字段）。已经出好的图
  是既成事实，不能因为后半程失败就让它从会话里消失。

事件顺序：`meta` → 若干 `delta`/`image`/`task` → 失败时 `error` → 恒有 `done`。
`image` 是当场出好的图，`task` 是刚提交的后台任务（编辑 / 视频 / 工作流），产物由任务
中心那条事件流后补——这里不等它，等就把整条 SSE 卡住了。
`done` 带的是**真正落库的那一轮**，失败时它里面带着 error 字段——前端拿它覆盖
流式占位即可，不必自己拼。

流与工具都接在内核上：模型回复经 `PreparedChatCall.stream_chunks` 翻译成 StreamChunk，
由 `BlockAssembler` 装配出正文与工具调用；工具声明来自 `kernel.tools.schemas(gpt-creative)`，
执行经 `kernel.tools.execute`，pre/post-execute 监听器与 `tools/result` 事件都能挂上来。
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
import time
from collections.abc import AsyncGenerator
from copy import deepcopy
from datetime import UTC, datetime
from typing import Any

import anyio
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import SessionFactory
from domain import (
    agent_tools,
    image_assets,
    image_describe,
    image_prompts,
    imagegen,
    studio_frames,
    studio_media_assets,
)
from domain.agent_tools import image_generate
from domain.agent_tools import submit as agent_submit
from domain.kernel.bootstrap import get_kernel
from domain.kernel.events import ScopeKey
from domain.kernel.llm_assembler import BlockAssembler
from domain.kernel.llm_types import (
    AbortedFinish,
    ContentBlock,
    ErrorFinish,
    TextBlock,
    TextDeltaChunk,
    ToolCallBlock,
)
from domain.kernel.tool_runtime import ToolDefinition
from domain.llm import LLMUnavailable
from domain.model_invocations import ModelInvocationSpan
from domain.model_runtime import ModelRuntimeError, PreparedChatRoute, prepare_chat_route
from domain.models import ImageAsset, StudioGptChat, StudioMediaAsset
from domain.storage import get_storage

logger = logging.getLogger(__name__)

# 对话模型走新语义别名（配置中心绑定）。它要做工具调用，建议绑强模型
CHAT_ALIAS = "chat-general"
# 出图走既有生图别名，不为工坊另开一个（BR-141）
IMAGE_ALIAS = image_generate.IMAGE_ALIAS

# 聊天比出图快得多，但带图的一轮要等上传+理解，给宽一点
CHAT_TIMEOUT_S = 180.0

# 历史截断：再往前的内容对当前这轮几乎没有影响，却按 token 收钱
MAX_HISTORY_TURNS = 20
MAX_TURN_CHARS = 4000
# 源项目统一附件条最多 20 个；图片走多模态块，其它文件尽力抽正文。
MAX_INPUT_ATTACHMENTS = 20
MAX_INPUT_IMAGES = MAX_INPUT_ATTACHMENTS
MAX_INPUT_FILES = MAX_INPUT_ATTACHMENTS
MAX_INPUT_VIDEOS = 3
MAX_VIDEO_FRAMES = 6

# 工具最多连调 2 次：每次都是一张真出的图，模型打转的代价是钱
MAX_TOOL_CALLS = 2
# 模型最多说 3 轮话（2 次工具 + 收尾那一句）
MAX_ROUNDS = MAX_TOOL_CALLS + 1

TOOL_NAME = image_generate.TOOL_NAME
TOOL_QUALITY = image_generate.TOOL_QUALITY
DEFAULT_SIZE = image_generate.DEFAULT_SIZE

# 资产血缘上的动作名：资产详情里能一眼看出这张图是聊出来的
OP_KEY = image_generate.OP_KEY

# 工具所在的内核作用域名；注册见 domain.agent_tools
TOOL_SCOPE = agent_tools.GPT_CREATIVE_SCOPE

TOOL_CAP_HINT = (
    f"本轮工具调用次数已达上限（{MAX_TOOL_CALLS} 次），不能再调了。"
    "请用文字告诉用户这一点，还要做别的让他再发一条消息。"
)
STOPPED_NOTE = f"模型连续调用工具超过 {MAX_TOOL_CALLS} 次，已停止本轮以免打转"

DEFAULT_SYSTEM = (
    "你是创作工坊里的中文创作助手，帮用户想画面、写提示词、出图出片。\n"
    "你手上有五个真能干活的工具，用户要东西时**直接调**，别只把方案写给他看："
    "generate_image 从零出一张图；edit_image 在已有的图上改（重绘、扩图、融合、换风格）；"
    "generate_video 出一段视频；run_workflow 跑一条 ComfyUI/RunningHub 工作流；"
    "run_flow 跑一条编排好的多步 DAG。"
    f"一轮里最多调 {MAX_TOOL_CALLS} 次工具。\n"
    "选工具的判据：要新画面用 generate_image；要在某张图基础上改、并且主体和构图不能变，"
    "用 edit_image 而不是重新生成；要动起来用 generate_video；"
    "用户点名某条工作流或某条流程时才用 run_workflow / run_flow。\n"
    "调用规则：prompt 一律用英文写，覆盖主体、构图、光线、材质、色调、画风，具体到能照着画；"
    "不要在图上写字（生图模型拼不对字），也不要在 prompt 里写尺寸参数，画幅用 size 参数选。"
    "要改图或做视频时，参考图用对话里已有的资产 id，不要凭空编 id。\n"
    "generate_image 出的图会立刻展示给用户；另外四个是后台任务，提交后先回一句话说明在跑什么，"
    "产物跑完自动贴回对话——不要重复提交，也不要假装已经看到结果。\n"
    "用户发图给你时，先看清楚再说话；他要改这张图就用 edit_image，把要改的地方写进 prompt。\n"
    "回复用中文，简洁直接。做不到的事直说，不要假装做过了。"
)


def tool_scope() -> ScopeKey:
    """GPT 创作对话的工具作用域键；首次使用时把 agent 工具注册进去。"""
    return agent_tools.ensure_registered(get_kernel())


def _lock_size(schema: dict, selected: str) -> dict:
    """把工具声明里的 size 锁成本轮画幅。

    源项目是用户先选画幅，Agent 再决定是否出图。因此尺寸不能再交给模型
    自由改写：枚举只给当前值，真正执行时还会在参数上再锁一次。
    """
    locked = deepcopy(schema)
    properties = locked.get("function", {}).get("parameters", {}).get("properties")
    if isinstance(properties, dict) and "size" in properties:
        properties["size"] = {
            "type": "string",
            "enum": [selected],
            "description": f"本轮用户已选定的画幅 {selected}",
        }
    return locked


def tools_for_size(size: str) -> list[dict]:
    """本轮固定画幅的工具声明：内核作用域里可见的工具，size 枚举锁成当前值。"""
    selected = image_prompts.validate_size(size)
    schemas = get_kernel().tools.schemas(scope=tool_scope())
    return [_lock_size(schema, selected) for schema in schemas]


def _now() -> datetime:
    return datetime.now(UTC)


def _client(route: PreparedChatRoute) -> Any:
    return route.open_client(CHAT_TIMEOUT_S)


def _reason(exc: Exception) -> str:
    """失败原因原样往上带（BR-110），别翻译成「操作失败」。"""
    if isinstance(exc, imagegen.ImageGenError | image_describe.DescribeError | LLMUnavailable):
        return str(exc)
    kind, message = imagegen.classify(exc)
    if kind == "binding":
        return (
            f"网关里没有 {CHAT_ALIAS} 这个别名，到设置 · 模型服务把它绑到一个支持工具调用的模型上"
        )
    if kind == "timeout":
        return f"对话模型超时（{int(CHAT_TIMEOUT_S)}s），稍后再试"
    return message


# ---- 视图 ----


def _iso(value) -> str:
    return value.isoformat() if value else ""


def chat_summary_view(row: StudioGptChat) -> dict:
    return {
        "id": row.id,
        "title": row.title,
        "pinned": row.pinned,
        "turn_count": len(row.turns or []),
        "updated_at": _iso(row.updated_at),
    }


def chat_detail_view(row: StudioGptChat) -> dict:
    return {
        "id": row.id,
        "title": row.title,
        "pinned": row.pinned,
        "system_prompt": row.system_prompt or "",
        "turns": row.turns or [],
        "version": row.version,
        "updated_at": _iso(row.updated_at),
    }


# ---- 入参：历史与图片 ----


def _clip(text: object) -> str:
    return str(text or "")[:MAX_TURN_CHARS]


def history_messages(turns: list | None) -> list[dict]:
    """历史回合 → OpenAI messages。最近 MAX_HISTORY_TURNS 轮，单条截断。

    **历史里的图不重新上送**：一张压缩图也有几百 KB，把整段会话的图每轮都重发一遍，
    第五轮就把请求体撑爆了。改为在文本里注明这一轮带过几张图，模型据此知道
    「之前聊过图」，需要细节时用户会再发一次。
    """
    messages: list[dict] = []
    for turn in (turns or [])[-MAX_HISTORY_TURNS:]:
        if not isinstance(turn, dict):
            continue
        role = turn.get("role")
        if role not in ("user", "assistant"):
            continue
        content = _clip(turn.get("content"))
        image_count = len(turn.get("image_asset_ids") or [])
        file_count = len(turn.get("media_asset_ids") or [])
        asset_count = len(turn.get("asset_ids") or [])
        if role == "user" and image_count:
            content = f"{content}（这一轮带了 {image_count} 张图）".strip()
        if role == "user" and file_count:
            content = f"{content}（这一轮带了 {file_count} 个文件）".strip()
        task_count = len(turn.get("task_ids") or [])
        if role == "assistant" and asset_count:
            content = f"{content}（这一轮出了 {asset_count} 张图）".strip()
        if role == "assistant" and task_count:
            content = f"{content}（这一轮提交了 {task_count} 个后台任务）".strip()
        if not content:
            continue
        messages.append({"role": role, "content": content})
    return messages


async def image_blocks(session: AsyncSession, asset_ids: list[int]) -> list[dict]:
    """资产 id → OpenAI 多模态 content 块。字节从存储直读（BR-144）。

    读的是展示图（宽 768 webp）而不是原图，再经 image_describe._prepare 按需压缩：
    data URL 是整段塞进请求体的，几十兆的原图会把网关顶掉。
    """
    blocks: list[dict] = []
    for asset_id in asset_ids[:MAX_INPUT_IMAGES]:
        row = await session.get(ImageAsset, asset_id)
        if row is None:
            raise image_describe.DescribeError("api", f"资产不存在：{asset_id}")
        key = image_assets.variant_key(row, "display")
        mime = image_assets.variant_mime(row, "display")
        data = await get_storage().read(key)
        clean_mime, b64 = image_describe._prepare(data, mime)
        blocks.append(
            {"type": "image_url", "image_url": {"url": f"data:{clean_mime};base64,{b64}"}}
        )
    return blocks


def video_sample_seconds(duration_ms: int | None) -> list[float]:
    """给 LLM 均匀抽最多六帧；末帧避开容器结束点，防止 ffmpeg 读空。"""
    if duration_ms is None or duration_ms <= 0:
        return [float(index) for index in range(MAX_VIDEO_FRAMES)]
    duration_s = duration_ms / 1000
    count = min(MAX_VIDEO_FRAMES, max(1, int(duration_s + 0.999)))
    if count == 1:
        return [0.0]
    end = max(0.0, duration_s - 0.05)
    return [round(end * index / (count - 1), 3) for index in range(count)]


async def video_blocks(session: AsyncSession, asset_ids: list[int]) -> list[dict]:
    """视频媒体 ID → 按时间排序的视觉关键帧块。

    只接收入库媒体和本地存储路径，不替模型下载任意 URL。视频字节不进 JSON/数据库；
    ffmpeg 逐帧读取后压成 1024 边长 JPEG，仅存在于本次上游请求内。
    """
    if not asset_ids:
        return []
    if shutil.which("ffmpeg") is None:
        raise image_describe.DescribeError("api", "服务器上没有 ffmpeg，LLM 暂时无法理解视频")
    blocks: list[dict] = []
    storage = get_storage()
    for index, asset_id in enumerate(asset_ids[:MAX_INPUT_VIDEOS], 1):
        row = await session.get(StudioMediaAsset, asset_id)
        if row is None or row.kind != "video":
            raise image_describe.DescribeError("api", f"视频资产不存在或类型不正确：{asset_id}")
        path = storage.local_path(row.storage_key)
        if path is None:
            raise image_describe.DescribeError(
                "api", "当前存储后端不提供本地路径，LLM 暂时无法抽取视频关键帧"
            )
        if not path.exists():
            raise image_describe.DescribeError("api", f"视频文件不存在：{row.name}")
        frames: list[tuple[float, str, str]] = []
        for at_s in video_sample_seconds(row.duration_ms):
            try:
                data = await anyio.to_thread.run_sync(studio_frames._ffmpeg_frame, path, at_s)
                compressed, mime = image_describe._compress(data)
                clean_mime, encoded = image_describe._prepare(compressed, mime)
                frames.append((at_s, clean_mime, encoded))
            except studio_frames.StudioFrameError:
                # 未知时长时后面的采样点可能越界；已抽到的帧仍然有用。
                continue
        if not frames:
            raise image_describe.DescribeError("api", f"无法从视频抽取关键帧：{row.name}")
        seconds = "、".join(studio_frames.fmt_seconds(at_s) for at_s, _, _ in frames)
        blocks.append(
            {
                "type": "text",
                "text": (
                    f"以下是视频 {index}「{row.name}」按时间顺序抽取的关键帧"
                    f"（{seconds} 秒），请结合顺序理解动作、场景和变化。"
                ),
            }
        )
        blocks.extend(
            {
                "type": "image_url",
                "image_url": {"url": f"data:{mime};base64,{encoded}"},
            }
            for _, mime, encoded in frames
        )
    return blocks


async def file_blocks(session: AsyncSession, asset_ids: list[int]) -> list[dict]:
    """通用附件 id → OpenAI 文本块。

    txt/Markdown/代码/PDF 尽力抽正文；视频、音频和不识别的二进制文件仍把
    文件名交给模型，不因一个读不出的附件拖垮整轮。
    """
    blocks: list[dict] = []
    for asset_id in asset_ids[:MAX_INPUT_FILES]:
        name, body = await studio_media_assets.asset_text(session, asset_id)
        if not name:
            raise image_describe.DescribeError("api", f"附件不存在：{asset_id}")
        text = f"附件：{name}"
        if body:
            text += f"\n正文：\n{body}"
        blocks.append({"type": "text", "text": text})
    return blocks


def build_messages(
    chat: StudioGptChat,
    text: str,
    blocks: list[dict] | None = None,
    attachment_blocks: list[dict] | None = None,
) -> list[dict]:
    """system + 截断历史 + 本轮用户消息。带图时本轮用多模态 content 块。"""
    system = (chat.system_prompt or "").strip() or DEFAULT_SYSTEM
    messages: list[dict] = [{"role": "system", "content": system}]
    messages.extend(history_messages(chat.turns))
    cleaned = _clip(text)
    content_blocks = [*(blocks or []), *(attachment_blocks or [])]
    if content_blocks:
        content = ([{"type": "text", "text": cleaned}] if cleaned else []) + content_blocks
        messages.append({"role": "user", "content": content})
    else:
        messages.append({"role": "user", "content": cleaned})
    return messages


# ---- 一轮流式回复 ----


def spoken_text(assembler: BlockAssembler) -> str:
    """装配器里当前攒到的正文（只取 text 块，推理块不算）；半路断掉也能读。"""
    return "".join(block.text for block in assembler.blocks() if isinstance(block, TextBlock))


def tool_calls(assembler: BlockAssembler) -> list[ToolCallBlock]:
    """装配出的工具调用；没拼出名字的片段丢掉，max-tokens 截断的由装配器自己剔除。"""
    return [
        block
        for block in assembler.blocks()
        if isinstance(block, ToolCallBlock) and block.name
    ]


def _finish_failure(assembler: BlockAssembler) -> LLMUnavailable | None:
    finish = assembler.finish
    if isinstance(finish, ErrorFinish | AbortedFinish):
        return LLMUnavailable(finish.failure.message, failure=finish.failure)
    return None


async def _stream_once(
    messages: list[dict],
    assembler: BlockAssembler,
    *,
    route: PreparedChatRoute,
    round_index: int,
    tools: list[dict],
) -> AsyncGenerator[tuple[str, dict], None]:
    """消费一次流式回复：边收边 yield delta，分块全部喂进 `assembler`。

    正文与工具调用的拼接交给装配器：工具调用是分片来的，id 与 name 通常在第一片，
    arguments 一个字符一个字符地追加，装配器按 index 攒块。
    """
    request = {
        "messages": messages,
        "tools": tools,
        "tool_choice": "auto",
        "stream": True,
        "round": round_index + 1,
        "route": route.snapshot.view(),
    }
    async with route.prepare_call(
        request,
        timeout=CHAT_TIMEOUT_S,
        capability=CHAT_ALIAS,
        client_factory=_client,
    ) as call:
        async for chunk in call.stream_chunks(
            model=route.snapshot.model,
            messages=messages,
            tools=tools,
            tool_choice="auto",
        ):
            assembler.push(chunk)
            if isinstance(chunk, TextDeltaChunk) and chunk.text:
                yield "delta", {"text": chunk.text}
        failure = _finish_failure(assembler)
        if failure is not None:
            await call.fail(failure)
            raise failure
        await call.succeed(
            response={
                "text": spoken_text(assembler),
                "tool_calls": [
                    {"id": block.id, "name": block.name, "arguments": block.arguments}
                    for block in tool_calls(assembler)
                ],
            },
        )


def _assistant_call_message(calls: list[ToolCallBlock], content: str) -> dict:
    """把模型这一轮的工具调用原样回填进 messages，下一轮它才认得自己调过什么。"""
    return {
        "role": "assistant",
        "content": content or None,
        "tool_calls": [
            {
                "id": call.id,
                "type": "function",
                "function": {"name": call.name, "arguments": call.arguments or "{}"},
            }
            for call in calls
        ],
    }


def _tool_message(call_id: str, payload: dict) -> dict:
    return {
        "role": "tool",
        "tool_call_id": call_id,
        "content": json.dumps(payload, ensure_ascii=False),
    }


def _tool_content_message(call_id: str, content: list[ContentBlock]) -> dict:
    """工具运行时 render 出来的内容块 → OpenAI tool 消息（只取文本块）。"""
    text = "".join(block.text for block in content if isinstance(block, TextBlock))
    return {"role": "tool", "tool_call_id": call_id, "content": text}


def parse_tool_arguments(arguments: str) -> dict:
    """模型给的 arguments 是 JSON 串；不合法或不是对象直接报给模型，不猜。"""
    try:
        args = json.loads(arguments or "{}")
    except json.JSONDecodeError as exc:
        raise imagegen.ImageGenError("api", f"工具参数不是合法 JSON：{arguments[:200]}") from exc
    if not isinstance(args, dict):
        raise imagegen.ImageGenError("api", "工具参数不是对象")
    return args


def _locked_arguments(
    definition: ToolDefinition,
    arguments: dict,
    selected_size: str,
) -> dict:
    """把本轮选定的画幅锁进参数。

    声明里的枚举只是告诉模型，执行以本轮选定值为准。只有合同里真有 size 的工具才补——
    编辑与视频这些工具的入参模型是 ``extra=forbid``，硬塞一个 size 会被当成非法参数打回。
    """
    if "size" not in definition.input.model_fields:
        return dict(arguments)
    return {**arguments, "size": selected_size}


def _tool_event(value: BaseModel) -> tuple[str, dict] | None:
    """工具结果 → 流事件。认不出来的结果返回 None，由调用方当失败报给模型。

    两种形态：出图当场就有资产（``image``），长任务只有回执（``task``），产物由任务中心
    那条事件流后补。
    """
    if isinstance(value, image_generate.GenerateImageResult):
        return "image", {"asset_id": value.asset_id, "url": value.url, "prompt": value.prompt}
    if isinstance(value, agent_submit.SubmittedTask):
        return "task", {
            "task_id": value.task_id,
            "operation": value.operation,
            "tool_id": value.tool_id,
            "status": value.status,
            "label": value.label,
            "run_id": value.run_id,
        }
    return None


# ---- 工具实现 ----


async def run_generate_image(
    session: AsyncSession,
    arguments: str,
    *,
    deployment_id: int | None = None,
    size_override: str | None = None,
) -> ImageAsset:
    """工具落地（直接调用入口）：出一张图并入库，与 `generate_image` 工具体同一条路。"""
    args = parse_tool_arguments(arguments)
    prompt = str(args.get("prompt") or "")
    size = size_override or str(args.get("size") or DEFAULT_SIZE)
    return await image_generate.render_and_ingest(
        session, prompt, size, deployment_id=deployment_id
    )


# ---- 落库 ----


async def append_turns(
    session: AsyncSession,
    chat: StudioGptChat,
    *,
    text: str,
    image_asset_ids: list[int],
    media_asset_ids: list[int],
    image_size: str,
    content: str,
    asset_ids: list[int],
    task_ids: list[str] | None = None,
    latency_ms: int,
    error: str | None,
) -> dict:
    """user / assistant 两轮一起 append，返回 assistant 轮次（done 事件的载荷）。

    JSON 列不做变更跟踪，必须整体重新赋值——原地 append 不会写库。
    """
    # rollback 会让会话里的实例全部过期，之后再碰 chat.turns 就是一次隐式懒加载——
    # 异步下直接 MissingGreenlet。这里显式取一次，比在每个 rollback 后各补一次可靠
    await session.refresh(chat)

    at = _now().isoformat()
    user_turn: dict = {"role": "user", "content": text, "at": at}
    if image_asset_ids:
        user_turn["image_asset_ids"] = list(image_asset_ids)
    if media_asset_ids:
        user_turn["media_asset_ids"] = list(media_asset_ids)
    user_turn["image_size"] = image_size

    assistant_turn: dict = {
        "role": "assistant",
        "content": content,
        "latency_ms": latency_ms,
        "at": _now().isoformat(),
    }
    if asset_ids:
        assistant_turn["asset_ids"] = list(asset_ids)
    # 后台任务这一轮没有产物可贴，留下 task_id 才能在刷新后顺着任务中心找回去
    if task_ids:
        assistant_turn["task_ids"] = list(task_ids)
    if error:
        assistant_turn["error"] = error

    chat.turns = [*(chat.turns or []), user_turn, assistant_turn]
    chat.version += 1
    chat.updated_at = _now()
    await session.commit()
    return assistant_turn


def detached_session():
    """给「不受请求生命周期约束」的落库用的 session。

    单独抽成函数而不是直接 `SessionFactory()`：测试跑的是内存 SQLite，
    直接引用真库的工厂会让断流落库这条路测不了（也测不准）。
    conftest 覆写这个名字即可。
    """
    return SessionFactory()


async def _persist_turn(chat_id: int, **payload) -> dict:
    """用**自己的** session 落库。

    不能复用请求作用域那个：客户端断开时它已经在拆，再拿去 await 只会连带炸掉。
    这个函数被 shield 包着，取消传不进来，所以断流也能把已生成的内容存下。
    """
    async with detached_session() as own:
        chat = await own.get(StudioGptChat, chat_id)
        if chat is None:
            raise LookupError(f"会话 {chat_id} 已不存在")
        return await append_turns(own, chat, **payload)


# ---- 对外：一轮完整对话 ----


async def stream_turn(
    session: AsyncSession,
    chat: StudioGptChat,
    text: str,
    image_asset_ids: list[int] | None = None,
    media_asset_ids: list[int] | None = None,
    *,
    chat_deployment_id: int | None = None,
    image_deployment_id: int | None = None,
    image_size: str = DEFAULT_SIZE,
) -> AsyncGenerator[tuple[str, dict], None]:
    """跑完一轮，产出 (事件名, 载荷) 给路由层拍成 SSE。

    事件：meta（本轮用哪两个别名）→ delta（文本增量）/ image（真出了一张图）
    → error（失败原因原文，可选）→ done（落库后的 assistant 轮次，恒有）。
    """
    started = time.monotonic()
    # 开头就把 id 取成普通 int：finally 里再读 chat.id 时，请求作用域的 session
    # 可能已经在拆，ORM 属性访问会触发隐式懒加载，异步下直接抛 MissingGreenlet
    # （本仓 onupdate 列那次是同一个坑）
    chat_id = int(chat.id)
    inputs = list(image_asset_ids or [])[:MAX_INPUT_IMAGES]
    file_inputs = list(media_asset_ids or [])[:MAX_INPUT_FILES]
    selected_size = image_prompts.validate_size(image_size)
    said: list[str] = []
    produced: list[int] = []
    submitted: list[str] = []
    error: str | None = None

    try:
        blocks = await image_blocks(session, inputs)
        attachments = await file_blocks(session, file_inputs)
        messages = build_messages(chat, text, blocks, attachments)
        try:
            route = await prepare_chat_route(
                CHAT_ALIAS,
                "chat.stream",
                deployment_id=chat_deployment_id,
            )
        except ModelRuntimeError as exc:
            span = await ModelInvocationSpan(
                plugin_id="unresolved",
                operation="chat.stream",
                model=CHAT_ALIAS,
                capability=CHAT_ALIAS,
                deployment_id=chat_deployment_id,
                request={"messages": messages, "stream": True},
            ).start()
            await span.fail(exc)
            raise
        yield (
            "meta",
            {
                "chat_model": route.snapshot.model,
                "chat_alias": CHAT_ALIAS,
                "chat_deployment_id": route.snapshot.deployment_id,
                "image_alias": IMAGE_ALIAS,
                "image_deployment_id": image_deployment_id,
                "image_size": selected_size,
            },
        )
        kernel = get_kernel()
        scope = tool_scope()
        declared_tools = tools_for_size(selected_size)
        agent_id = f"gpt-chat:{chat_id}"
        calls_done = 0
        for round_index in range(MAX_ROUNDS):
            assembler = BlockAssembler()
            # said 先占位再就地更新：等这一轮跑完才 append 的话，
            # 断在半路的正文会连同这一轮一起丢掉
            said.append("")
            slot = len(said) - 1
            async for event in _stream_once(
                messages,
                assembler,
                route=route,
                round_index=round_index,
                tools=declared_tools,
            ):
                said[slot] = spoken_text(assembler).strip()
                yield event
            said[slot] = spoken_text(assembler).strip()
            if said[slot] == "":
                said.pop()

            calls = tool_calls(assembler)
            if not calls:
                break
            if round_index == MAX_ROUNDS - 1:
                # 最后一轮还在调工具：停手，别陪它打转
                error = STOPPED_NOTE
                break

            messages.append(_assistant_call_message(calls, spoken_text(assembler)))
            for call in calls:
                definition = kernel.tools.get(call.name, scope)
                if definition is None:
                    messages.append(
                        _tool_message(call.id, {"ok": False, "error": f"没有 {call.name} 这个工具"})
                    )
                    continue
                if calls_done >= MAX_TOOL_CALLS:
                    messages.append(_tool_message(call.id, {"ok": False, "error": TOOL_CAP_HINT}))
                    continue
                calls_done += 1
                try:
                    arguments = parse_tool_arguments(call.arguments)
                except imagegen.ImageGenError as exc:
                    messages.append(_tool_message(call.id, {"ok": False, "error": str(exc)}))
                    continue
                with (
                    image_generate.bind_turn(session, deployment_id=image_deployment_id),
                    agent_submit.bind_turn(
                        session, chat_id=chat_id, image_deployment_id=image_deployment_id
                    ),
                ):
                    result = await kernel.tools.execute(
                        call.name,
                        _locked_arguments(definition, arguments, selected_size),
                        scope=scope,
                        call_id=call.id,
                        agent_id=agent_id,
                    )
                if result.is_error or result.value is None:
                    # 一次工具失败不该毁掉整轮对话
                    await session.rollback()
                    detail = result.error.message if result.error else "工具没有返回结果"
                    logger.warning("GPT 对话工具 %s 失败：%s", call.name, detail)
                    messages.append(_tool_message(call.id, {"ok": False, "error": detail}))
                    continue
                outcome = _tool_event(result.value)
                if outcome is None:
                    await session.rollback()
                    detail = f"{call.name} 返回了认不出来的结果：{type(result.value).__name__}"
                    logger.warning("GPT 对话工具结果异常：%s", detail)
                    messages.append(_tool_message(call.id, {"ok": False, "error": detail}))
                    continue
                name, payload = outcome
                if name == "image":
                    produced.append(int(payload["asset_id"]))
                else:
                    submitted.append(str(payload["task_id"]))
                yield name, payload
                messages.append(_tool_content_message(call.id, result.content))
    except Exception as exc:  # 网关 / 存储 / 解析各有各的异常类型，统一收敛
        await session.rollback()
        error = _reason(exc)
        logger.warning("GPT 对话失败：%s", error)
        yield "error", {"detail": error}
    else:
        if error:
            # 打转被拦下也算这轮没走完，照实说
            yield "error", {"detail": error}
    finally:
        # 落库放 finally：**客户端半路断开**时生成器被 aclose，走的正是这条路。
        # 已经出好的图是既成事实（钱已经花了、资产已经入库），会话里必须留下痕迹。
        #
        # 但直接 `await append_turns(session, ...)` 在断开时**根本落不了库**（实测
        # 两种断法都是 turns: 0）：请求作用域的 session 这时已经在拆，而且
        # CancelledError 是 BaseException，`except Exception` 兜不住。
        # 所以改成「自己开 session 的独立任务 + shield 挡住取消传播」：
        # shield 的外层 await 被取消时内层任务照样跑完。
        turn: dict | None
        task = asyncio.create_task(
            _persist_turn(
                chat_id,
                text=text,
                image_asset_ids=inputs,
                media_asset_ids=file_inputs,
                image_size=selected_size,
                content="\n\n".join(said),
                asset_ids=produced,
                task_ids=submitted,
                latency_ms=int((time.monotonic() - started) * 1000),
                error=error,
            )
        )
        try:
            turn = await asyncio.shield(task)
        except asyncio.CancelledError:
            # 客户端断了。任务不受影响会跑完，这里没人收结果而已——
            # 用户刷新页面就能看到服务端存下的那一轮
            turn = None
            logger.info("GPT 对话客户端断开，落库任务继续在后台跑完")
        except Exception as exc:
            turn = None
            logger.warning("GPT 对话落库失败：%s", _reason(exc))

    if turn is None:
        yield "error", {"detail": "本轮内容写入会话失败；已生成的图仍在资产库里"}
    else:
        yield "done", {"turn": turn}
