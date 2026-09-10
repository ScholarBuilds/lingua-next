"""画布子图的 JSON/ZIP 导入导出 API。"""

from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.routers.dict import SessionDep
from domain import studio_canvas_workflows
from domain.models import StudioCanvas

router = APIRouter(prefix="/studio/canvas-workflows", tags=["studio-canvas-workflows"])


class WorkflowExportBody(BaseModel):
    nodes: list
    connections: list
    include_resources: bool = False
    filename: str = Field(default="canvas-workflow", max_length=180)
    target_format: str = Field(
        default=studio_canvas_workflows.FORMAT,
        pattern="^(lingua-canvas-workflow|infinite-canvas-workflow)$",
    )


class CanvasExportBody(BaseModel):
    include_resources: bool = False
    filename: str = Field(default="canvas", max_length=180)


class OutputImageDownloadBody(BaseModel):
    asset_ids: list[Annotated[int, Field(strict=True, ge=1)]] = Field(
        min_length=1,
        max_length=studio_canvas_workflows.MAX_OUTPUT_DOWNLOADS,
    )
    filename: str = Field(default="canvas-output", max_length=180)


def _filename(value: str, suffix: str) -> str:
    base = studio_canvas_workflows._safe_filename(value, "canvas-workflow")
    if not base.lower().endswith(suffix):
        base += suffix
    return base


@router.post("/export", response_model=None)
async def export_workflow(body: WorkflowExportBody, session: SessionDep):
    try:
        document, archive = await studio_canvas_workflows.build_export(
            session,
            nodes=body.nodes,
            connections=body.connections,
            include_resources=body.include_resources,
            target_format=body.target_format,
        )
    except studio_canvas_workflows.CanvasWorkflowError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    suffix = ".zip" if body.include_resources else ".json"
    filename = _filename(body.filename, suffix)
    headers = {"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"}
    if archive is not None:
        return Response(archive, media_type="application/zip", headers=headers)
    import json

    return Response(
        json.dumps(document, ensure_ascii=False, indent=2),
        media_type="application/json",
        headers=headers,
    )


@router.post("/canvases/{canvas_id}/export", response_model=None)
async def export_canvas(canvas_id: int, body: CanvasExportBody, session: SessionDep):
    row = await session.get(StudioCanvas, canvas_id)
    if row is None or row.deleted_at is not None:
        raise HTTPException(status_code=404, detail="画布不存在")
    try:
        document, archive = await studio_canvas_workflows.build_canvas_export(
            session,
            canvas=row,
            include_resources=body.include_resources,
        )
    except studio_canvas_workflows.CanvasWorkflowError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    suffix = ".zip" if body.include_resources else ".json"
    filename = _filename(body.filename, suffix)
    headers = {"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"}
    if archive is not None:
        return Response(archive, media_type="application/zip", headers=headers)
    import json

    return Response(
        json.dumps(document, ensure_ascii=False, indent=2),
        media_type="application/json",
        headers=headers,
    )


@router.post("/outputs/download", response_model=None)
async def download_output_images(body: OutputImageDownloadBody, session: SessionDep):
    try:
        archive = await studio_canvas_workflows.build_output_image_archive(
            session,
            asset_ids=body.asset_ids,
        )
    except studio_canvas_workflows.CanvasWorkflowError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    filename = _filename(body.filename, ".zip")
    headers = {"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"}
    return Response(archive, media_type="application/zip", headers=headers)


@router.post("/import")
async def import_workflow(
    session: SessionDep,
    file: Annotated[UploadFile, File()],
) -> dict:
    raw = await file.read(studio_canvas_workflows.MAX_IMPORT_BYTES + 1)
    try:
        return await studio_canvas_workflows.import_workflow(
            session,
            raw=raw,
            filename=file.filename or "workflow.json",
        )
    except studio_canvas_workflows.CanvasWorkflowError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
