"""创作域多媒体资产 API。"""

from typing import Annotated

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from pydantic import BaseModel
from sqlalchemy import func, or_, select

from app.media import media_response
from app.routers.dict import SessionDep
from domain.models import StudioAssetGroup, StudioMediaAsset
from domain.storage import get_storage
from domain.studio_media_assets import (
    MEDIA_KINDS,
    StudioMediaAssetError,
    asset_preview,
    asset_view,
    ingest_one,
    kind_for_upload,
)

router = APIRouter(prefix="/studio/media-assets", tags=["studio-media-assets"])
MAX_UPLOAD_BYTES = 512 * 1024 * 1024


async def _asset(session: SessionDep, asset_id: int) -> StudioMediaAsset:
    row = await session.get(StudioMediaAsset, asset_id)
    if row is None:
        raise HTTPException(status_code=404, detail="媒体资产不存在")
    return row


@router.get("")
async def list_media_assets(
    session: SessionDep,
    kind: str | None = None,
    status: str | None = "active",
    group_id: int | None = None,
    favorite: bool | None = None,
    q: str | None = Query(default=None, max_length=120),
    limit: int = Query(default=60, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> dict:
    if kind is not None and kind not in MEDIA_KINDS:
        raise HTTPException(status_code=400, detail=f"未知媒体类型：{kind}")
    filters = []
    if kind is not None:
        filters.append(StudioMediaAsset.kind == kind)
    if status is not None:
        filters.append(StudioMediaAsset.status == status)
    if group_id is not None:
        filters.append(
            StudioMediaAsset.group_id.is_(None)
            if group_id == 0
            else StudioMediaAsset.group_id == group_id
        )
    if favorite is not None:
        filters.append(StudioMediaAsset.favorite.is_(favorite))
    if q:
        term = f"%{q.strip()}%"
        filters.append(
            or_(
                StudioMediaAsset.name.ilike(term),
                StudioMediaAsset.mime.ilike(term),
            )
        )
    stmt = (
        select(StudioMediaAsset)
        .where(*filters)
        .order_by(StudioMediaAsset.created_at.desc(), StudioMediaAsset.id.desc())
        .offset(offset)
        .limit(limit)
    )
    count_stmt = select(func.count()).select_from(StudioMediaAsset).where(*filters)
    rows = list((await session.execute(stmt)).scalars())
    total = int((await session.execute(count_stmt)).scalar_one())
    return {"items": [asset_view(row) for row in rows], "total": total}


@router.get("/{asset_id}/preview")
async def preview_media_asset(asset_id: int, session: SessionDep) -> dict:
    """附件预览的结构化内容（md / 纯文本 / 表格；其余回 binary）。

    pdf 不走这里——浏览器内置阅读器直接渲染原文件（`/{id}/content`），
    比把版式拆成纯文本再拼回去忠实得多，也不用引 pdf.js。
    """
    try:
        return await asset_preview(session, asset_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="媒体资产不存在") from exc


@router.post("", status_code=201)
async def upload_media_asset(
    session: SessionDep,
    file: Annotated[UploadFile, File()],
) -> dict:
    """本地视频、音频和通用文件入库；同内容按 sha256 复用。"""
    chunks: list[bytes] = []
    size = 0
    while chunk := await file.read(1024 * 1024):
        size += len(chunk)
        if size > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="单个素材不能超过 512 MB")
        chunks.append(chunk)
    data = b"".join(chunks)
    name = file.filename or "asset"
    mime = file.content_type or "application/octet-stream"
    try:
        row = await ingest_one(
            session,
            data,
            kind=kind_for_upload(name, mime),
            name=name,
            mime=mime,
            details={"source": "local-upload"},
        )
    except StudioMediaAssetError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await session.commit()
    await session.refresh(row)
    return asset_view(row)


@router.get("/{asset_id}")
async def get_media_asset(asset_id: int, session: SessionDep) -> dict:
    return asset_view(await _asset(session, asset_id))


@router.get("/{asset_id}/content", response_model=None)
async def get_media_content(asset_id: int, session: SessionDep):
    row = await _asset(session, asset_id)
    # video/audio 要能被 <video>/<audio> 内联播放；通用文件才作为附件下载。
    return media_response(
        row.storage_key,
        media_type=row.mime,
        filename=row.name if row.kind == "file" else None,
    )


@router.get("/{asset_id}/poster", response_model=None)
async def get_media_poster(asset_id: int, session: SessionDep):
    row = await _asset(session, asset_id)
    if not row.poster_key:
        raise HTTPException(status_code=404, detail="媒体资产没有封面")
    return media_response(row.poster_key, media_type="image/webp")


class MediaAssetPatch(BaseModel):
    favorite: bool | None = None
    status: str | None = None
    group_id: int | None = None


@router.patch("/{asset_id}")
async def patch_media_asset(
    asset_id: int,
    body: MediaAssetPatch,
    session: SessionDep,
) -> dict:
    row = await _asset(session, asset_id)
    if body.status is not None:
        if body.status not in {"active", "archived"}:
            raise HTTPException(status_code=400, detail="status 只能是 active/archived")
        row.status = body.status
    if body.favorite is not None:
        row.favorite = body.favorite
    if "group_id" in body.model_fields_set:
        if (
            body.group_id is not None
            and await session.get(StudioAssetGroup, body.group_id) is None
        ):
            raise HTTPException(status_code=404, detail="素材分组不存在")
        row.group_id = body.group_id
    await session.commit()
    await session.refresh(row)
    return asset_view(row)


@router.delete("/{asset_id}")
async def delete_media_asset(asset_id: int, session: SessionDep) -> dict:
    """永久删除明确指定的媒体资产及其存储对象。"""
    row = await _asset(session, asset_id)
    keys = [key for key in (row.storage_key, row.poster_key) if key]
    await session.delete(row)
    await session.commit()
    storage = get_storage()
    for key in keys:
        await storage.delete(key)
    return {"ok": True}
