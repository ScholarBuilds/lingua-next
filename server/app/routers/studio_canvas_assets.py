"""持久化画布资产索引 API。"""

from urllib.parse import quote

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.routers.dict import SessionDep
from domain import studio_canvas_assets

router = APIRouter(prefix="/studio/canvas-assets", tags=["studio-canvas-assets"])


class CanvasAssetDownloadBody(BaseModel):
    item_ids: list[str] = Field(min_length=1, max_length=500)
    filename: str = Field(default="canvas-assets.zip", max_length=160)


@router.get("")
async def list_canvas_assets(session: SessionDep) -> dict:
    return await studio_canvas_assets.index(session)


@router.post("/download")
async def download_canvas_assets(body: CanvasAssetDownloadBody, session: SessionDep) -> Response:
    data, count = await studio_canvas_assets.download_zip(session, body.item_ids)
    if count == 0:
        raise HTTPException(status_code=400, detail="所选项目没有可打包的本地资产")
    filename = body.filename.strip() or "canvas-assets.zip"
    if not filename.lower().endswith(".zip"):
        filename += ".zip"
    return Response(
        data,
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"},
    )
