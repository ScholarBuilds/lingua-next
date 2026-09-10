"""素材库共享目录 API。"""

import mimetypes

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.routers.dict import SessionDep
from domain import studio_shared_folders

router = APIRouter(prefix="/studio/shared-folders", tags=["studio-shared-folders"])


class SharedFolderRegisterBody(BaseModel):
    path: str = Field(min_length=1, max_length=1024)
    name: str = Field(default="", max_length=120)


class SharedFolderImportBody(BaseModel):
    paths: list[str] = Field(min_length=1, max_length=200)
    group_id: int | None = None


def _error(exc: studio_shared_folders.StudioSharedFolderError) -> HTTPException:
    return HTTPException(status_code=exc.status, detail=str(exc))


@router.get("")
async def list_shared_folders(session: SessionDep) -> dict:
    return {"items": await studio_shared_folders.list_folders(session)}


@router.post("", status_code=201)
async def register_shared_folder(body: SharedFolderRegisterBody, session: SessionDep) -> dict:
    try:
        return await studio_shared_folders.register_folder(
            session, path=body.path, name=body.name
        )
    except studio_shared_folders.StudioSharedFolderError as exc:
        raise _error(exc) from exc


@router.delete("/{folder_id}")
async def unregister_shared_folder(folder_id: int, session: SessionDep) -> dict:
    try:
        await studio_shared_folders.unregister_folder(session, folder_id)
    except studio_shared_folders.StudioSharedFolderError as exc:
        raise _error(exc) from exc
    return {"ok": True}


@router.get("/{folder_id}/tree")
async def get_shared_folder_tree(folder_id: int, session: SessionDep) -> dict:
    try:
        row = await studio_shared_folders.get_folder(session, folder_id)
        tree = studio_shared_folders.scan_tree(row)
        folder = studio_shared_folders.folder_view(row)
    except studio_shared_folders.StudioSharedFolderError as exc:
        raise _error(exc) from exc
    return {"folder": folder, "tree": tree}


@router.get("/{folder_id}/file", response_model=None)
async def get_shared_folder_file(
    folder_id: int, path: str, session: SessionDep
):
    try:
        row = await studio_shared_folders.get_folder(session, folder_id)
        file_path = studio_shared_folders.child_path(row, path)
    except studio_shared_folders.StudioSharedFolderError as exc:
        raise _error(exc) from exc
    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    if file_path.suffix.lower() not in studio_shared_folders.MEDIA_EXTENSIONS:
        raise HTTPException(status_code=400, detail="不支持的文件类型")
    return FileResponse(
        file_path,
        media_type=mimetypes.guess_type(file_path.name)[0] or "application/octet-stream",
    )


@router.post("/{folder_id}/import")
async def import_shared_folder_files(
    folder_id: int, body: SharedFolderImportBody, session: SessionDep
) -> dict:
    try:
        return await studio_shared_folders.import_files(
            session,
            folder_id=folder_id,
            paths=body.paths,
            group_id=body.group_id,
        )
    except studio_shared_folders.StudioSharedFolderError as exc:
        raise _error(exc) from exc
