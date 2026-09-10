"""素材库共享目录：项目内登记、只读浏览与复制入库。"""

from __future__ import annotations

import mimetypes
from pathlib import Path
from typing import Any
from urllib.parse import quote

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from domain import image_assets, studio_media_assets
from domain.models import StudioAssetGroup, StudioSharedFolder

PROJECT_ROOT = Path(__file__).resolve().parents[2]
MAX_SCAN_ENTRIES = 8000
MAX_IMPORT_ITEMS = 200
MEDIA_EXTENSIONS = frozenset(
    {
        ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp",
        ".mp4", ".webm", ".mov", ".m4v", ".mkv",
        ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac",
    }
)
IMAGE_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"})


class StudioSharedFolderError(ValueError):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def _inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def resolve_registration(raw: str) -> tuple[Path, str]:
    """把输入解析成项目内真实目录，拒绝根目录、越界路径与逃逸软链接。"""
    cleaned = (raw or "").strip().strip('"').strip("'")
    if not cleaned:
        raise StudioSharedFolderError("请提供文件夹路径")
    root = PROJECT_ROOT.resolve()
    candidate = Path(cleaned).expanduser()
    if not candidate.is_absolute():
        candidate = root / candidate
    try:
        resolved = candidate.resolve(strict=True)
    except FileNotFoundError as exc:
        raise StudioSharedFolderError("文件夹不存在") from exc
    if not resolved.is_dir():
        raise StudioSharedFolderError("路径不是文件夹")
    if resolved == root:
        raise StudioSharedFolderError("不能直接登记项目根目录，请选择子文件夹")
    if not _inside(resolved, root):
        raise StudioSharedFolderError("只允许登记项目目录内的文件夹")
    return resolved, resolved.relative_to(root).as_posix()


def folder_path(row: StudioSharedFolder, *, must_exist: bool = False) -> Path:
    root = PROJECT_ROOT.resolve()
    candidate = root / row.rel_path
    try:
        resolved = candidate.resolve(strict=must_exist)
    except FileNotFoundError as exc:
        raise StudioSharedFolderError("文件夹已不存在", status=404) from exc
    if resolved == root or not _inside(resolved, root):
        raise StudioSharedFolderError("共享文件夹路径已越界")
    if must_exist and not resolved.is_dir():
        raise StudioSharedFolderError("文件夹已不存在", status=404)
    return resolved


def child_path(row: StudioSharedFolder, relative_path: str) -> Path:
    """解析登记目录内的真实文件；软链接指向目录外时 resolve 后会被拒绝。"""
    root = folder_path(row, must_exist=True)
    cleaned = (relative_path or "").replace("\\", "/").lstrip("/")
    try:
        resolved = (root / cleaned).resolve(strict=True)
    except FileNotFoundError as exc:
        raise StudioSharedFolderError("文件不存在", status=404) from exc
    if not _inside(resolved, root):
        raise StudioSharedFolderError("非法路径")
    return resolved


def folder_view(row: StudioSharedFolder) -> dict[str, Any]:
    try:
        path = folder_path(row)
        exists = path.is_dir()
    except StudioSharedFolderError:
        path = PROJECT_ROOT / row.rel_path
        exists = False
    return {
        "id": row.id,
        "name": row.name,
        "rel_path": row.rel_path,
        "path": str(path),
        "exists": exists,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


async def list_folders(session: AsyncSession) -> list[dict[str, Any]]:
    rows = list(
        (
            await session.execute(
                select(StudioSharedFolder).order_by(
                    StudioSharedFolder.created_at, StudioSharedFolder.id
                )
            )
        ).scalars()
    )
    return [folder_view(row) for row in rows]


async def register_folder(
    session: AsyncSession, *, path: str, name: str = ""
) -> dict[str, Any]:
    resolved, rel_path = resolve_registration(path)
    clean_name = (name or resolved.name or "共享文件夹").strip()[:120]
    existing = (
        await session.execute(
            select(StudioSharedFolder).where(StudioSharedFolder.rel_path == rel_path)
        )
    ).scalar_one_or_none()
    if existing is not None:
        existing.name = clean_name
        await session.commit()
        await session.refresh(existing)
        return folder_view(existing)
    row = StudioSharedFolder(name=clean_name, rel_path=rel_path)
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return folder_view(row)


async def get_folder(session: AsyncSession, folder_id: int) -> StudioSharedFolder:
    row = await session.get(StudioSharedFolder, folder_id)
    if row is None:
        raise StudioSharedFolderError("共享文件夹不存在", status=404)
    return row


async def unregister_folder(session: AsyncSession, folder_id: int) -> None:
    row = await get_folder(session, folder_id)
    await session.delete(row)
    await session.commit()


def _kind(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in IMAGE_EXTENSIONS:
        return "image"
    return studio_media_assets.kind_for_upload(
        path.name, mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    )


def scan_tree(row: StudioSharedFolder) -> dict[str, Any]:
    root = folder_path(row, must_exist=True)
    counter = [0]

    def visit(current: Path, rel: str = "") -> dict[str, Any]:
        node: dict[str, Any] = {
            "id": f"{row.id}:{rel or '__root__'}",
            "name": current.name or row.name,
            "path": rel,
            "items": [],
            "children": [],
        }
        try:
            entries = sorted(
                current.iterdir(),
                key=lambda item: (not item.is_dir(), item.name.lower()),
            )
        except OSError:
            return node
        for entry in entries:
            if counter[0] >= MAX_SCAN_ENTRIES:
                break
            if entry.name.startswith((".", "._")) or entry.is_symlink():
                continue
            child_rel = f"{rel}/{entry.name}".lstrip("/")
            if entry.is_dir():
                child = visit(entry, child_rel)
                if child["items"] or child["children"]:
                    node["children"].append(child)
                continue
            if not entry.is_file() or entry.suffix.lower() not in MEDIA_EXTENSIONS:
                continue
            counter[0] += 1
            try:
                stat = entry.stat()
                size = stat.st_size
                modified = int(stat.st_mtime * 1000)
            except OSError:
                size = 0
                modified = 0
            node["items"].append(
                {
                    "id": f"{row.id}:{child_rel}",
                    "name": entry.name,
                    "url": (
                        f"/api/studio/shared-folders/{row.id}/file?path="
                        f"{quote(child_rel)}"
                    ),
                    "kind": _kind(entry),
                    "size": size,
                    "last_modified": modified,
                    "relative_path": child_rel,
                    "folder_id": row.id,
                }
            )
        return node

    return visit(root)


async def import_files(
    session: AsyncSession,
    *,
    folder_id: int,
    paths: list[str],
    group_id: int | None,
) -> dict[str, list[dict[str, Any]]]:
    row = await get_folder(session, folder_id)
    if group_id is not None and await session.get(StudioAssetGroup, group_id) is None:
        raise StudioSharedFolderError("素材分组不存在", status=404)
    imported: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []
    for relative_path in paths[:MAX_IMPORT_ITEMS]:
        try:
            path = child_path(row, relative_path)
            if not path.is_file() or path.suffix.lower() not in MEDIA_EXTENSIONS:
                raise StudioSharedFolderError("不支持的文件类型")
            data = path.read_bytes()
            kind = _kind(path)
            if kind == "image":
                asset = await image_assets.ingest_one(
                    session,
                    data,
                    target_key="free",
                    prompt=path.name,
                    source="import",
                )
                if asset.display_name is None:
                    asset.display_name = path.name[:160]
                asset.group_id = group_id
                await session.commit()
                imported.append(
                    {"path": relative_path, "asset_type": "image", "id": asset.id, "kind": kind}
                )
            else:
                mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
                asset = await studio_media_assets.ingest_one(
                    session,
                    data,
                    kind=kind,
                    name=path.name,
                    mime=mime,
                    details={
                        "source": "shared-folder",
                        "shared_folder_id": folder_id,
                        "relative_path": relative_path,
                    },
                )
                asset.group_id = group_id
                await session.commit()
                imported.append(
                    {"path": relative_path, "asset_type": "media", "id": asset.id, "kind": kind}
                )
        except Exception as exc:  # 每个文件独立，坏一项不回滚已经复制成功的项
            await session.rollback()
            failed.append({"path": relative_path, "reason": str(exc) or type(exc).__name__})
    return {"items": imported, "failed": failed}
