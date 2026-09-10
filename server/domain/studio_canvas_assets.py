"""从持久化画布中建立可检索、可下载的资产索引。"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Iterator
from io import BytesIO
from pathlib import PurePosixPath
from typing import Any
from zipfile import ZIP_DEFLATED, ZipFile

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from domain import image_assets, studio, studio_media_assets
from domain.models import ImageAsset, StudioCanvas, StudioMediaAsset
from domain.storage import get_storage

SKIP_KEYS = frozenset({"logs", "settings", "params", "metadata", "meta", "prompt", "caption"})


def _references(value: object, path: str = "") -> Iterator[tuple[str, dict[str, Any]]]:
    if isinstance(value, dict):
        asset_id = value.get("asset_id")
        media_id = value.get("media_asset_id")
        url = value.get("url")
        if isinstance(asset_id, int):
            yield path, {"asset_type": "image", "asset_id": asset_id, **value}
        elif isinstance(media_id, int):
            yield path, {"asset_type": "media", "asset_id": media_id, **value}
        elif isinstance(url, str) and url.strip().startswith(("/api/", "http://", "https://")):
            yield path, {"asset_type": "external", **value}
        for key, child in value.items():
            if key in SKIP_KEYS or key in {"asset_id", "media_asset_id", "url", "poster_url"}:
                continue
            next_path = f"{path}.{key}" if path else str(key)
            yield from _references(child, next_path)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from _references(child, f"{path}[{index}]")


def _external_kind(raw: dict[str, Any]) -> str:
    explicit = str(raw.get("kind") or raw.get("type") or "").lower()
    if explicit in {"image", "video", "audio", "file"}:
        return explicit
    suffix = PurePosixPath(str(raw.get("url") or "").split("?", 1)[0]).suffix.lower()
    if suffix in studio_media_assets.VIDEO_EXTENSIONS:
        return "video"
    if suffix in studio_media_assets.AUDIO_EXTENSIONS:
        return "audio"
    if suffix in {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg"}:
        return "image"
    return "file"


def _clean_name(raw: object, fallback: str) -> str:
    value = str(raw or "").strip()
    return value[:180] if value else fallback


async def index(session: AsyncSession) -> dict[str, Any]:
    canvases = list(
        (
            await session.execute(
                select(StudioCanvas)
                .where(StudioCanvas.deleted_at.is_(None))
                .order_by(StudioCanvas.pinned.desc(), StudioCanvas.updated_at.desc())
            )
        ).scalars()
    )
    raw_refs: list[tuple[StudioCanvas, dict[str, Any]]] = []
    image_ids: set[int] = set()
    media_ids: set[int] = set()
    for canvas in canvases:
        seen: set[tuple[str, object]] = set()
        for node in canvas.nodes or []:
            if not isinstance(node, dict):
                continue
            for source_path, raw in _references(node):
                key = (str(raw.get("asset_type")), raw.get("asset_id") or raw.get("url"))
                if key in seen:
                    continue
                seen.add(key)
                copied = {**raw, "source_path": source_path, "node": node}
                raw_refs.append((canvas, copied))
                if copied["asset_type"] == "image":
                    image_ids.add(int(copied["asset_id"]))
                elif copied["asset_type"] == "media":
                    media_ids.add(int(copied["asset_id"]))
    images = {
        row.id: row
        for row in (
            await session.execute(select(ImageAsset).where(ImageAsset.id.in_(image_ids)))
        ).scalars()
    } if image_ids else {}
    media = {
        row.id: row
        for row in (
            await session.execute(
                select(StudioMediaAsset).where(StudioMediaAsset.id.in_(media_ids))
            )
        ).scalars()
    } if media_ids else {}

    items: list[dict[str, Any]] = []
    counts = {"all": 0, "smart": 0, "classic": 0}
    canvas_counts = {"all": len(canvases), "smart": 0, "classic": 0}
    per_canvas: dict[int, int] = {}
    for canvas in canvases:
        canvas_counts[canvas.kind] = canvas_counts.get(canvas.kind, 0) + 1
    for canvas, raw in raw_refs:
        asset_type = str(raw["asset_type"])
        node = raw["node"]
        if asset_type == "image":
            row = images.get(int(raw["asset_id"]))
            kind = "image"
            url = (
                image_assets.asset_url(row.id, "display", int(row.created_at.timestamp()))
                if row
                else ""
            )
            name = _clean_name(raw.get("name"), f"图片 #{raw['asset_id']}")
            missing = row is None
        elif asset_type == "media":
            row = media.get(int(raw["asset_id"]))
            kind = row.kind if row else str(raw.get("kind") or "file")
            url = f"/api/studio/media-assets/{row.id}/content" if row else ""
            name = _clean_name(
                raw.get("name") or (row.name if row else ""),
                f"媒体 #{raw['asset_id']}",
            )
            missing = row is None
        else:
            kind = _external_kind(raw)
            url = str(raw.get("url") or "").strip()
            fallback = PurePosixPath(url.split("?", 1)[0]).name or "外部素材"
            name = _clean_name(raw.get("name"), fallback)
            missing = False
        identity = f"{asset_type}:{raw.get('asset_id') or url}"
        item_id = hashlib.sha1(f"{canvas.id}:{identity}".encode()).hexdigest()[:24]
        item = {
            "id": item_id,
            "asset_type": asset_type,
            "asset_id": raw.get("asset_id"),
            "url": url,
            "name": name,
            "kind": kind,
            "missing": missing,
            "canvas_id": canvas.id,
            "canvas_title": canvas.title,
            "canvas_kind": canvas.kind,
            "canvas_icon": canvas.icon,
            "canvas_owner": canvas.owner,
            "canvas_color": canvas.color,
            "canvas_updated_at": canvas.updated_at.isoformat() if canvas.updated_at else "",
            "node_id": str(node.get("id") or ""),
            "node_title": str(node.get("title") or node.get("type") or "节点")[:120],
            "node_type": str(node.get("type") or ""),
            "source_path": raw["source_path"],
        }
        items.append(item)
        counts["all"] += 1
        counts[canvas.kind] = counts.get(canvas.kind, 0) + 1
        per_canvas[canvas.id] = per_canvas.get(canvas.id, 0) + 1
    canvas_views = [
        {**studio.canvas_summary_view(row), "asset_count": per_canvas.get(row.id, 0)}
        for row in canvases
    ]
    categories = [
        {
            "id": "all",
            "name": "全部画布",
            "count": counts["all"],
            "canvas_count": canvas_counts["all"],
        },
        {
            "id": "smart",
            "name": "智能画布",
            "count": counts["smart"],
            "canvas_count": canvas_counts["smart"],
        },
        {
            "id": "classic",
            "name": "普通画布",
            "count": counts["classic"],
            "canvas_count": canvas_counts["classic"],
        },
    ]
    return {"categories": categories, "canvases": canvas_views, "items": items}


def _archive_name(name: str, used: set[str]) -> str:
    cleaned = re.sub(r"[^\w.()\- ]+", "-", name, flags=re.UNICODE).strip(" .-") or "asset"
    stem = PurePosixPath(cleaned).stem
    suffix = PurePosixPath(cleaned).suffix
    candidate = cleaned
    index = 2
    while candidate.lower() in used:
        candidate = f"{stem}-{index}{suffix}"
        index += 1
    used.add(candidate.lower())
    return candidate


async def download_zip(session: AsyncSession, item_ids: list[str]) -> tuple[bytes, int]:
    catalog = await index(session)
    selected = {item["id"]: item for item in catalog["items"] if item["id"] in item_ids}
    image_ids = [item["asset_id"] for item in selected.values() if item["asset_type"] == "image"]
    media_ids = [item["asset_id"] for item in selected.values() if item["asset_type"] == "media"]
    images = {
        row.id: row
        for row in (
            await session.execute(select(ImageAsset).where(ImageAsset.id.in_(image_ids)))
        ).scalars()
    } if image_ids else {}
    media = {
        row.id: row
        for row in (
            await session.execute(
                select(StudioMediaAsset).where(StudioMediaAsset.id.in_(media_ids))
            )
        ).scalars()
    } if media_ids else {}
    output = BytesIO()
    used: set[str] = set()
    count = 0
    storage = get_storage()
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        for item_id in item_ids:
            item = selected.get(item_id)
            if item is None:
                continue
            if item["asset_type"] == "image":
                row = images.get(item["asset_id"])
            elif item["asset_type"] == "media":
                row = media.get(item["asset_id"])
            else:
                row = None
            if row is None:
                continue
            archive.writestr(_archive_name(item["name"], used), await storage.read(row.storage_key))
            count += 1
    return output.getvalue(), count
