"""``generate_image`` 工具：出一张图并入库，走控制台同一条 render + ingest（BR-140/141）。

工具体需要一个数据库 session 与本轮选定的生图部署——这些不是模型给的参数，由
对话循环在执行前用 :func:`bind_turn` 绑到当前任务上下文里。
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass

from pydantic import BaseModel, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from domain import image_assets, image_defaults, image_prompts, imagegen
from domain.kernel.llm_types import ContentBlock, TextBlock
from domain.kernel.tool_runtime import ToolRunContext, tool
from domain.model_catalog import resolve_model_route
from domain.models import ImageAsset

TOOL_NAME = "generate_image"
# 出图走既有生图别名，不为工坊另开一个（BR-141）
IMAGE_ALIAS = "image-free"
TOOL_QUALITY = image_defaults.FALLBACK_QUALITY
DEFAULT_SIZE = "1024x1024"
# 资产血缘上的动作名：资产详情里能一眼看出这张图是聊出来的
OP_KEY = "gpt_chat"

TOOL_DESCRIPTION = (
    "生成一张图并展示给用户。用户想看图、要改图、要对比效果时调用。"
    "调用后图会自动出现在对话里，你不需要再描述图长什么样。"
)
RESULT_NOTE = "图已经出好并展示给用户了，用一两句话说说它就行"


@dataclass(frozen=True)
class ImageToolTurn:
    """一轮对话里工具体可用的宿主事实。"""

    session: AsyncSession
    deployment_id: int | None = None


_turn: ContextVar[ImageToolTurn | None] = ContextVar("image_tool_turn", default=None)


@contextmanager
def bind_turn(session: AsyncSession, *, deployment_id: int | None = None) -> Iterator[None]:
    """在 ``with`` 块内把 session 与生图部署交给工具体。"""
    token = _turn.set(ImageToolTurn(session=session, deployment_id=deployment_id))
    try:
        yield
    finally:
        _turn.reset(token)


def current_turn() -> ImageToolTurn | None:
    return _turn.get()


class GenerateImageArgs(BaseModel):
    prompt: str = Field(
        description=(
            "英文提示词，覆盖主体与动作、构图与视角、光线、材质、色调、画风。"
            "不要要求在图上写字，也不要写尺寸参数。"
        )
    )
    size: str = Field(default=DEFAULT_SIZE, description="画幅，形如 1024x1024")

    @field_validator("prompt")
    @classmethod
    def _prompt_not_blank(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("工具没给出 prompt")
        return cleaned


class GenerateImageResult(BaseModel):
    asset_id: int
    asset_ids: list[int]
    url: str
    prompt: str
    size: str
    width: int | None = None
    height: int | None = None


async def render_and_ingest(
    session: AsyncSession,
    prompt: str,
    size: str,
    *,
    deployment_id: int | None = None,
) -> ImageAsset:
    """出一张图并入库；尺寸在这里校验，不合法直接抛。"""
    cleaned = prompt.strip()
    if not cleaned:
        raise imagegen.ImageGenError("api", "工具没给出 prompt")
    selected = image_prompts.validate_size(size)
    route = await resolve_model_route(session, IMAGE_ALIAS, deployment_id=deployment_id)
    result = await imagegen.render_images(
        cleaned, alias=IMAGE_ALIAS, size=selected, quality=TOOL_QUALITY, n=1, route=route
    )
    if not result.images:
        raise imagegen.ImageGenError("api", "上游没有返回图片")
    row = await image_assets.ingest_one(
        session,
        result.images[0],
        target_key="free",
        prompt=cleaned,
        alias=IMAGE_ALIAS,
        model_reported=result.model_reported,
        size_req=selected,
        quality=TOOL_QUALITY,
        usage=imagegen.usage_with_latency(result),
        source="workbench",
        op=OP_KEY,
    )
    await session.commit()
    return row


def render_result(args: GenerateImageArgs, value: GenerateImageResult) -> list[ContentBlock]:
    """回给模型的工具结果：与旧版 tool 消息同一份 JSON 载荷。"""
    del args
    payload = {
        "ok": True,
        "asset_id": value.asset_id,
        "size": value.size,
        "note": RESULT_NOTE,
    }
    return [TextBlock(text=json.dumps(payload, ensure_ascii=False))]


@tool(
    TOOL_NAME,
    description=TOOL_DESCRIPTION,
    input=GenerateImageArgs,
    output=GenerateImageResult,
    render=render_result,
    runtime_kind="inline",
)
async def GENERATE_IMAGE(args: GenerateImageArgs, exec: ToolRunContext) -> GenerateImageResult:
    del exec
    turn = current_turn()
    if turn is None:
        raise imagegen.ImageGenError("api", f"{TOOL_NAME} 只能在绑定了会话的对话回合内执行")
    row = await render_and_ingest(
        turn.session, args.prompt, args.size, deployment_id=turn.deployment_id
    )
    view = image_assets.asset_view(row)
    return GenerateImageResult(
        asset_id=row.id,
        asset_ids=[row.id],
        url=view["url"],
        prompt=row.prompt or "",
        size=f"{row.width}x{row.height}",
        width=row.width,
        height=row.height,
    )


__all__ = [
    "DEFAULT_SIZE",
    "GENERATE_IMAGE",
    "IMAGE_ALIAS",
    "OP_KEY",
    "TOOL_NAME",
    "TOOL_QUALITY",
    "GenerateImageArgs",
    "GenerateImageResult",
    "ImageToolTurn",
    "bind_turn",
    "current_turn",
    "render_and_ingest",
    "render_result",
]
