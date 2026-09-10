"""``edit_image`` 工具：在已有的图上改，落到统一执行器的 ``image.edit``。

覆盖蒙版重绘、AI 扩图与多图融合——它们在 :mod:`domain.image_apps` 里只差一个 app_key，
背后是同一条编辑通路，所以这里也只是一个工具，由模型按用户想干什么挑应用。

参考图一律用**对话里已经入库的资产 id**：合同上那条 ``uploads``（先落存储再交 storage_key）
是给表单上传用的，对话里没有这种字节。蒙版是唯一的例外，见 :func:`_mask_upload`。
"""

from __future__ import annotations

import logging
import uuid

from pydantic import Field
from sqlalchemy.ext.asyncio import AsyncSession

from domain import image_apps
from domain.agent_tools.submit import (
    AgentToolError,
    SubmitBrief,
    SubmittedTask,
    TaskToolTurn,
    build_submit_tool,
    host_payload,
    submit_operation,
)
from domain.models import ImageAsset
from domain.storage import StorageError, get_storage

logger = logging.getLogger(__name__)

TOOL_NAME = "edit_image"
OPERATION = "image.edit"
LABEL = "图片编辑"

# 不发给模型的合同字段：宿主代填，或对话里根本给不出来
WITHHELD = {
    "uploads": "表单上传的字节，对话里只有已入库的资产 id",
    "mask": "要 storage_key，对话侧改用 mask_asset_id 翻译",
    "deployment_id": "本轮用户在界面上选的生图部署",
    "alias": "生图能力别名固定 image-free（BR-141）",
    "quality": "质量档由用途默认决定，不让模型加价",
    "size": "参考编辑跟随原图尺寸，与画布同一套语义",
    "n": "一次只出一张，模型改多张就是成倍花钱",
    "parent_id": "血缘起点由第一张参考图推出来（BR-117）",
}


def edit_app_choices() -> list[str]:
    """走编辑通路的应用键。取自应用注册表，加了应用这里自动多一个选项。"""
    return sorted(key for key, app in image_apps.APPS.items() if app.engine == "edit")


def _app_menu() -> str:
    """给模型看的应用清单：key=中文名（一句话用途）。"""
    return "；".join(
        f"{key}={image_apps.APPS[key].label}（{image_apps.APPS[key].hint}）"
        for key in edit_app_choices()
    )


DESCRIPTION = (
    "在一张已有的图上改：局部重绘、消除、换背景、换风格、AI 扩图、多图融合、一致性续画。"
    "用户说「把这张图的 X 改成 Y」「把它扩成横版」「把这两张揉一起」时调它，"
    "不要改用 generate_image 从零重画——那样主体和构图都会变。"
    "参考图必须是对话里出现过或用户传上来的资产 id；一次只出一张，跑完自动贴回对话。"
)

BRIEF = SubmitBrief(
    name=TOOL_NAME,
    operation=OPERATION,
    label=LABEL,
    description=DESCRIPTION,
    withheld=WITHHELD,
    describe={
        "prompt": (
            "英文指令，只说**要改成什么样**，不要复述整张画面；"
            "扩图写补出来的区域画什么，融合写两张图怎么结合。"
        ),
        "ref_asset_ids": (
            "要改的图的资产 id，按重要性排序，第一张是底图。"
            "多图融合（image_fusion）至少两张，其余应用一张就够。"
        ),
        "app_key": f"用哪个编辑应用，默认 image_to_image。可选：{_app_menu()}",
    },
    narrow={"app_key": {"enum": edit_app_choices()}},
    extra={
        "mask_asset_id": (
            int | None,
            Field(
                default=None,
                ge=1,
                description=(
                    "蒙版图的资产 id：白色区域会被重画。"
                    "inpaint / erase / replace_object / replace_bg 必须给，"
                    "没有就先让用户在图片编辑里涂一张再传上来，别自己编一个 id。"
                ),
            ),
        )
    },
)


async def _mask_upload(session: AsyncSession, asset_id: int) -> dict[str, str]:
    """把蒙版资产的字节复制成一份临时上传。

    不能直接把资产的 storage_key 当 ``UploadRef`` 交上去：worker 跑完会**删掉**上传输入，
    那删的就是用户资产库里的原文件。复制一份临时的，删的是副本。
    """
    row = await session.get(ImageAsset, asset_id)
    if row is None:
        raise AgentToolError(f"蒙版资产不存在：{asset_id}")
    storage = get_storage()
    key = f"studio-task-inputs/{uuid.uuid4().hex}/mask-{uuid.uuid4().hex}.bin"
    try:
        await storage.write(key, await storage.read(row.storage_key))
    except StorageError as exc:
        raise AgentToolError(f"蒙版保存失败：{exc}") from exc
    return {"name": f"mask-{row.id}.png", "storage_key": key}


async def _discard(key: str) -> None:
    try:
        await get_storage().delete(key)
    except StorageError:
        logger.warning("对话编辑任务的临时蒙版清理失败：%s", key)


async def run(args, turn: TaskToolTurn) -> SubmittedTask:
    refs = list(dict.fromkeys(args.ref_asset_ids))
    if not refs:
        raise AgentToolError("要先有参考图：把对话里那张图的资产 id 填进 ref_asset_ids")
    mask = await _mask_upload(turn.session, args.mask_asset_id) if args.mask_asset_id else None
    payload = host_payload(
        args,
        drop=("mask_asset_id",),
        ref_asset_ids=refs,
        mask=mask,
        deployment_id=turn.image_deployment_id,
    )
    try:
        return await submit_operation(OPERATION, payload, turn=turn, label=LABEL)
    except AgentToolError:
        # 提交没成的话没有任务会来读这份蒙版，留着就是存储里的垃圾
        if mask is not None:
            await _discard(mask["storage_key"])
        raise


EDIT_IMAGE = build_submit_tool(BRIEF, run)

__all__ = [
    "BRIEF",
    "DESCRIPTION",
    "EDIT_IMAGE",
    "LABEL",
    "OPERATION",
    "TOOL_NAME",
    "WITHHELD",
    "edit_app_choices",
    "run",
]
