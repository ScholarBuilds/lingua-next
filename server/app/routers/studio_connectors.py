"""Chrome / Photoshop 外部工具的稳定连接器协议。

连接器只暴露已入库的素材元数据和批量导入；生成仍复用
``/images/jobs`` 与 ``/studio/workflows``，不再建第二套任务系统。
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import io
import json
import mimetypes
import os
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Literal
from urllib.parse import urlparse

import httpx
from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    Response,
    WebSocket,
    WebSocketDisconnect,
)
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select
from starlette.requests import HTTPConnection

from app.queue import get_queue
from app.routers.dict import SessionDep
from domain import (
    image_assets,
    image_defaults,
    imagegen,
    studio,
    studio_assets,
    studio_workflows,
)
from domain.models import (
    ImageAsset,
    ModelDeployment,
    StudioAssetGroup,
    StudioCanvas,
    StudioMediaAsset,
)
from domain.network_policy import routed_http_client
from domain.storage import get_storage
from domain.studio_media_assets import (
    asset_view as media_asset_view,
)
from domain.studio_media_assets import (
    ingest_one as ingest_media,
)
from domain.studio_media_assets import (
    kind_for_upload,
)
from domain.studio_shared_folders import PROJECT_ROOT
from domain.tool_execution import ImageEditInput, ToolExecutionError, start_tool_operation

MAX_ITEMS = 200
MAX_INLINE_BYTES = 64 * 1024 * 1024
MAX_REMOTE_BYTES = 512 * 1024 * 1024
REMOTE_TIMEOUT_S = 120.0

# ==================== 连接器在不在线 ====================

# 心跳窗口：Chrome 弹窗和 UXP 面板打开时每 45 秒报一次，留两次的余量
CONNECTOR_ONLINE_WINDOW_S = 120.0
# 打包脚本的固定产物目录，相对 tools/
DIST_DIR_NAME = "dist"
BUILD_RECORD_NAME = "BUILD.json"


@dataclass(frozen=True)
class ConnectorSpec:
    """一个外部连接器的身份与它在磁盘上的位置。"""

    id: str
    tool_id: str
    label: str
    host_hint: str
    source_name: str
    package_name: str
    entry_name: str


CONNECTOR_SPECS: tuple[ConnectorSpec, ...] = (
    ConnectorSpec(
        id="chrome",
        tool_id="chrome-collector",
        label="浏览器素材采集扩展",
        host_hint="Chrome / Edge 开发者模式加载已解压目录",
        source_name="chrome-local-asset-importer",
        package_name="lingua-chrome-collector.zip",
        entry_name="manifest.json",
    ),
    ConnectorSpec(
        id="photoshop",
        tool_id="photoshop-connector",
        label="Photoshop 画布面板",
        host_hint="Adobe UXP Developer Tool 加载 manifest.json",
        source_name="photoshop-asset-connector",
        package_name="lingua-photoshop-connector.zip",
        entry_name="manifest.json",
    ),
)

CONNECTOR_BY_ID = {spec.id: spec for spec in CONNECTOR_SPECS}


@dataclass
class ConnectorPresence:
    """一次心跳。``at`` 是墙钟秒，只用来算「多久以前」。"""

    at: float
    version: str
    channel: str


_PRESENCE: dict[str, ConnectorPresence] = {}


def record_connector_presence(connector: str, version: str, channel: str) -> None:
    """记一次心跳。连接器 id 不认识就丢掉，不给未知来源建条目。"""
    key = connector.strip().lower()
    if key not in CONNECTOR_BY_ID:
        return
    _PRESENCE[key] = ConnectorPresence(
        at=time.time(),
        version=version.strip()[:40],
        channel=channel[:20],
    )


def reset_connector_presence() -> None:
    """清空心跳。给测试用，生产没有调用方。"""
    _PRESENCE.clear()


async def note_connector_presence(connection: HTTPConnection) -> None:
    """连接器自报家门：任何一次带 ``?connector=`` 的请求都算一次心跳。

    埋在路由级依赖上而不是逐个端点里，既有请求体、响应体和路径一个字节都没改；
    Web 前端读状态时不带这个参数，所以不会把自己算成连接器。
    """
    params = connection.query_params
    record_connector_presence(
        params.get("connector", ""),
        params.get("connector_version", ""),
        str(connection.scope.get("type", "")),
    )


router = APIRouter(
    prefix="/studio/connectors",
    tags=["studio-connectors"],
    dependencies=[Depends(note_connector_presence)],
)


def _revision(rows: list) -> str:
    payload = json.dumps(
        [list(row) for row in rows],
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
        default=str,
    ).encode()
    return hashlib.sha256(payload).hexdigest()


async def connector_revisions(session) -> dict[str, str]:
    """外部工具关心的资产/画布版本指纹。

    这里直接看已持久化的行，所以 Web、worker、Chrome 和 Photoshop
    从任意入口写入都不会漏通知。不只比较 created_at：改名、移组、
    标签和软删除也必须立即刷新 UXP 面板。
    """
    image_rows = list(
        (
            await session.execute(
                select(
                    ImageAsset.id,
                    ImageAsset.display_name,
                    ImageAsset.sha256,
                    ImageAsset.prompt,
                    ImageAsset.group_id,
                    ImageAsset.caption,
                    ImageAsset.tags,
                    ImageAsset.tagged_at,
                    ImageAsset.status,
                    ImageAsset.favorite,
                    ImageAsset.source,
                    ImageAsset.created_at,
                ).order_by(ImageAsset.id)
            )
        ).all()
    )
    media_rows = list(
        (
            await session.execute(
                select(
                    StudioMediaAsset.id,
                    StudioMediaAsset.name,
                    StudioMediaAsset.sha256,
                    StudioMediaAsset.kind,
                    StudioMediaAsset.group_id,
                    StudioMediaAsset.details,
                    StudioMediaAsset.status,
                    StudioMediaAsset.favorite,
                    StudioMediaAsset.created_at,
                ).order_by(StudioMediaAsset.id)
            )
        ).all()
    )
    group_rows = list(
        (
            await session.execute(
                select(
                    StudioAssetGroup.id,
                    StudioAssetGroup.name,
                    StudioAssetGroup.parent_id,
                    StudioAssetGroup.sort,
                    StudioAssetGroup.created_at,
                ).order_by(StudioAssetGroup.id)
            )
        ).all()
    )
    canvas_rows = list(
        (
            await session.execute(
                select(
                    StudioCanvas.id,
                    StudioCanvas.title,
                    StudioCanvas.icon,
                    StudioCanvas.kind,
                    StudioCanvas.owner,
                    StudioCanvas.color,
                    StudioCanvas.pinned,
                    StudioCanvas.project,
                    StudioCanvas.board_x,
                    StudioCanvas.board_y,
                    StudioCanvas.version,
                    StudioCanvas.deleted_at,
                    StudioCanvas.updated_at,
                ).order_by(StudioCanvas.id)
            )
        ).all()
    )
    return {
        "assets": _revision([*image_rows, *media_rows, *group_rows]),
        "canvas": _revision(canvas_rows),
    }


@router.websocket("/events")
async def connector_events(websocket: WebSocket, session: SessionDep) -> None:
    """Photoshop UXP 实时同步；每秒比对持久化版本，15 秒心跳。"""
    await websocket.accept()
    previous = await connector_revisions(session)
    await session.rollback()
    await websocket.send_json({"type": "ready", "revisions": previous})
    ticks = 0
    try:
        while True:
            await asyncio.sleep(1)
            current = await connector_revisions(session)
            await session.rollback()
            if current["assets"] != previous["assets"]:
                await websocket.send_json(
                    {"type": "asset_library_updated", "revision": current["assets"]}
                )
            if current["canvas"] != previous["canvas"]:
                await websocket.send_json({"type": "canvas_updated", "revision": current["canvas"]})
            previous = current
            ticks += 1
            if ticks % 15 == 0:
                await websocket.send_json({"type": "pong"})
    except (WebSocketDisconnect, RuntimeError):
        return


class ConnectorImportItem(BaseModel):
    url: str = Field(default="", max_length=8192)
    data: str = ""
    name: str = Field(default="", max_length=255)
    content_type: str = Field(default="", max_length=160)

    @model_validator(mode="after")
    def has_source(self):
        if not self.url.strip() and not self.data.strip():
            raise ValueError("url 和 data 至少填一项")
        return self


class ConnectorImportBody(BaseModel):
    items: list[ConnectorImportItem] = Field(min_length=1, max_length=MAX_ITEMS)
    group_id: int | None = None
    group_name: str = Field(default="", max_length=60)
    auto_tag: bool = False
    tag_deployment_id: int | None = Field(default=None, gt=0)
    tag_prompt: str = Field(default="", max_length=1000)


class ConnectorEditBody(BaseModel):
    prompt: str = Field(min_length=1, max_length=8000)
    deployment_id: int = Field(ge=1)
    ref_asset_ids: list[int] = Field(min_length=1, max_length=16)
    size: str | None = Field(default=None, max_length=32)
    quality: Literal["low", "medium", "high"] = image_defaults.FALLBACK_QUALITY  # type: ignore[assignment]
    n: int = Field(default=1, ge=1, le=imagegen.MAX_N)


def _client() -> httpx.AsyncClient:
    return routed_http_client(
        timeout=httpx.Timeout(connect=20.0, read=REMOTE_TIMEOUT_S, write=30.0, pool=20.0),
        follow_redirects=True,
        headers={"User-Agent": "Lingua-Studio-Connector/1.0"},
    )


def _decode_inline(value: str, declared: str) -> tuple[bytes, str]:
    encoded = value.strip()
    mime = declared.split(";", 1)[0].strip().lower()
    if encoded.startswith("data:"):
        header, separator, encoded = encoded.partition(",")
        if not separator:
            raise ValueError("data URL 缺少数据部分")
        if ";base64" not in header.lower():
            raise ValueError("只支持 base64 data URL")
        if not mime:
            mime = header[5:].split(";", 1)[0].strip().lower()
    if len(encoded) > (MAX_INLINE_BYTES * 4 // 3) + 8:
        raise ValueError(f"内联素材超过 {MAX_INLINE_BYTES // 1024 // 1024} MB 上限")
    try:
        data = base64.b64decode(encoded, validate=False)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("内联素材无法解码") from exc
    if not data:
        raise ValueError("素材内容为空")
    if len(data) > MAX_INLINE_BYTES:
        raise ValueError(f"内联素材超过 {MAX_INLINE_BYTES // 1024 // 1024} MB 上限")
    return data, mime


async def _download(url: str) -> tuple[bytes, str]:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("只支持 http(s) 素材地址")
    chunks: list[bytes] = []
    total = 0
    async with _client() as client, client.stream("GET", url) as response:
        response.raise_for_status()
        mime = (response.headers.get("content-type") or "").split(";", 1)[0].strip().lower()
        async for chunk in response.aiter_bytes():
            total += len(chunk)
            if total > MAX_REMOTE_BYTES:
                raise ValueError(f"远程素材超过 {MAX_REMOTE_BYTES // 1024 // 1024} MB 上限")
            chunks.append(chunk)
    data = b"".join(chunks)
    if not data:
        raise ValueError("素材内容为空")
    return data, mime


def _name(item: ConnectorImportItem) -> str:
    if item.name.strip():
        return PurePosixPath(item.name.strip()).name[:255]
    path = urlparse(item.url).path
    return PurePosixPath(path).name[:255] or "connector-asset"


def _mime(item: ConnectorImportItem, downloaded: str, name: str) -> str:
    return (
        item.content_type.split(";", 1)[0].strip().lower()
        or downloaded
        or (mimetypes.guess_type(name)[0] or "application/octet-stream")
    )


def _image_view(row: ImageAsset) -> dict:
    view = image_assets.asset_view(row)
    view["connector_url"] = (
        view["full_url"]
        if row.mime in {"image/png", "image/jpeg"}
        else f"/api/studio/connectors/images/{row.id}/jpeg"
    )
    return view


@router.get("/images/{asset_id}/jpeg")
async def connector_image_jpeg(
    asset_id: int,
    session: SessionDep,
    width: int = Query(default=0, ge=0, le=4096),
) -> Response:
    """UXP 不能稳定解码 WebP/AVIF，按需转一份 JPEG。"""
    row = await session.get(ImageAsset, asset_id)
    if row is None:
        raise HTTPException(status_code=404, detail="图片资产不存在")
    data = await get_storage().read(row.storage_key)
    from PIL import Image

    image = Image.open(io.BytesIO(data)).convert("RGB")
    if width and image.width > width:
        height = max(1, round(image.height * width / image.width))
        image = image.resize((width, height), Image.Resampling.LANCZOS)
    output = io.BytesIO()
    image.save(output, format="JPEG", quality=92, optimize=True)
    return Response(
        content=output.getvalue(),
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=604800, immutable"},
    )


@router.get("/catalog")
async def connector_catalog(session: SessionDep) -> dict:
    """给 UXP/Chrome 一次返回素材与画布目录，不包含任何密钥。"""
    image_rows = list(
        (
            await session.execute(
                select(ImageAsset)
                .where(ImageAsset.status != "archived")
                .order_by(ImageAsset.created_at.desc(), ImageAsset.id.desc())
                .limit(500)
            )
        ).scalars()
    )
    media_rows = list(
        (
            await session.execute(
                select(StudioMediaAsset)
                .where(StudioMediaAsset.status == "active")
                .order_by(StudioMediaAsset.created_at.desc(), StudioMediaAsset.id.desc())
                .limit(500)
            )
        ).scalars()
    )
    canvas_rows = list(
        (
            await session.execute(
                select(StudioCanvas)
                .where(StudioCanvas.deleted_at.is_(None))
                .order_by(StudioCanvas.updated_at.desc())
            )
        ).scalars()
    )
    image_by_id = {row.id: _image_view(row) for row in image_rows}
    media_by_id = {row.id: media_asset_view(row) for row in media_rows}
    canvas_assets: list[dict] = []
    for canvas in canvas_rows:
        for node in canvas.nodes or []:
            if not isinstance(node, dict):
                continue
            for item in node.get("items") or []:
                if not isinstance(item, dict):
                    continue
                asset = None
                if item.get("asset_id") is not None:
                    asset = image_by_id.get(int(item["asset_id"]))
                elif item.get("media_asset_id") is not None:
                    asset = media_by_id.get(int(item["media_asset_id"]))
                if asset is None:
                    continue
                canvas_assets.append(
                    {
                        **asset,
                        "canvas_id": canvas.id,
                        "canvas_title": canvas.title,
                        "node_id": str(node.get("id") or ""),
                        "node_title": str(node.get("title") or ""),
                    }
                )
    return {
        "groups": await studio_assets.list_groups(session),
        "images": list(image_by_id.values()),
        "media": list(media_by_id.values()),
        "canvases": [studio.canvas_summary_view(row) for row in canvas_rows],
        "canvas_assets": canvas_assets,
        "workflows": await studio_workflows.list_workflows(session, enabled=True),
    }


@router.post("/import", status_code=201)
async def connector_import(body: ConnectorImportBody, session: SessionDep) -> dict:
    tag_settings_override: dict = {}
    if body.auto_tag and body.tag_deployment_id is not None:
        deployment = await session.get(ModelDeployment, body.tag_deployment_id)
        if deployment is None:
            raise HTTPException(status_code=404, detail="分类模型部署不存在")
        if not deployment.enabled:
            raise HTTPException(status_code=400, detail="所选分类模型部署已停用")
        if deployment.media_types and "chat" not in deployment.media_types:
            raise HTTPException(status_code=400, detail="所选分类模型不支持 Chat/视觉描述")
        tag_settings_override["deployment_id"] = deployment.id
    if body.auto_tag and body.tag_prompt.strip():
        tag_settings_override["user_prompt"] = body.tag_prompt.strip()

    group_id = body.group_id
    if group_id is not None and await session.get(StudioAssetGroup, group_id) is None:
        raise HTTPException(status_code=404, detail="素材分组不存在")
    group_name = body.group_name.strip()
    if group_id is None and group_name:
        existing_group = (
            await session.execute(
                select(StudioAssetGroup).where(
                    StudioAssetGroup.name == group_name,
                    StudioAssetGroup.parent_id.is_(None),
                )
            )
        ).scalar_one_or_none()
        if existing_group is None:
            created_group = await studio_assets.create_group(session, name=group_name)
            group_id = int(created_group["id"])
        else:
            group_id = existing_group.id

    results: list[dict] = []
    image_ids: list[int] = []
    for item in body.items:
        source_url = item.url.strip()
        try:
            if item.data.strip():
                data, downloaded_mime = _decode_inline(item.data, item.content_type)
            else:
                data, downloaded_mime = await _download(source_url)
            name = _name(item)
            mime = _mime(item, downloaded_mime, name)
            real_image_mime = studio_assets.sniff_mime(data)
            if real_image_mime is not None:
                row = await image_assets.ingest_one(
                    session,
                    data,
                    target_key="free",
                    prompt=name,
                    source="connector",
                )
                row.group_id = group_id
                await session.commit()
                await session.refresh(row)
                image_ids.append(row.id)
                results.append(
                    {
                        "url": source_url,
                        "ok": True,
                        "kind": "image",
                        "asset_id": row.id,
                        "asset": _image_view(row),
                    }
                )
                continue
            if mime.startswith("image/"):
                raise ValueError("文件头不是已知图片格式")
            kind = kind_for_upload(name, mime)
            media_row = await ingest_media(
                session,
                data,
                kind=kind,
                name=name,
                mime=mime,
                source_url=source_url or None,
                details={"source": "connector"},
            )
            media_row.group_id = group_id
            await session.commit()
            await session.refresh(media_row)
            results.append(
                {
                    "url": source_url,
                    "ok": True,
                    "kind": kind,
                    "media_asset_id": media_row.id,
                    "asset": media_asset_view(media_row),
                }
            )
        except Exception as exc:
            await session.rollback()
            reason = str(exc).strip() or type(exc).__name__
            results.append({"url": source_url, "ok": False, "reason": reason})

    if body.auto_tag and image_ids:
        await studio_assets.tag_assets(
            session,
            image_ids,
            settings_override=tag_settings_override or None,
        )
    return {
        "ok": all(item["ok"] for item in results),
        "count": sum(1 for item in results if item["ok"]),
        "group_id": group_id,
        "items": results,
    }


@router.post("/edit-job", status_code=202)
async def connector_edit_job(body: ConnectorEditBody, session: SessionDep) -> dict:
    """Photoshop 参考图编辑：只传资产 ID，原图字节由 worker 从存储读。

    校验、建任务、入队全部交给统一执行入口，与 ``/studio/tools/{id}/runs`` 的
    image.edit 走同一条路，连接器不再单独维护一份参数检查。
    """
    try:
        result = await start_tool_operation(
            session,
            get_queue,
            tool_id="photoshop-connector",
            operation="image.edit",
            body=ImageEditInput(
                prompt=body.prompt,
                ref_asset_ids=body.ref_asset_ids,
                deployment_id=body.deployment_id,
                alias="image-free",
                app_key="image_to_image",
                size=body.size,
                quality=body.quality,
                n=body.n,
            ),
            source_route="/studio/canvas",
            source_context={"connector": "photoshop"},
        )
    except ToolExecutionError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc
    return {"studio_task_id": result.task.id}


# ==================== 安装位置与连接状态 ====================


def tools_root() -> Path:
    """连接器源码所在目录。容器里挂载位置不同，用 ``LINGUA_TOOLS_DIR`` 覆盖。"""
    override = os.environ.get("LINGUA_TOOLS_DIR", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    return (PROJECT_ROOT / "tools").resolve()


def _read_build_record(dist_dir: Path) -> dict:
    """打包脚本写下的产物台账。没打过包、或文件坏了都当没有。"""
    path = dist_dir / BUILD_RECORD_NAME
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    artifacts = payload.get("artifacts")
    return artifacts if isinstance(artifacts, dict) else {}


def _age_text(seconds: float) -> str:
    if seconds < 90:
        return f"{max(int(seconds), 1)} 秒前"
    if seconds < 5400:
        return f"{round(seconds / 60)} 分钟前"
    if seconds < 172800:
        return f"{round(seconds / 3600)} 小时前"
    return f"{round(seconds / 86400)} 天前"


def _presence_state(seen: ConnectorPresence | None, now: float) -> tuple[str, str]:
    """三种态，一种也不许猜。

    没收到过信号就是 ``unknown``：这台服务重启后清零，连接器又只在面板打开时说话，
    「没消息」既可能是没装，也可能是装了没开，判不出来就别替用户下结论。
    """
    if seen is None:
        return "unknown", "本次服务启动后没收到过它的信号，装没装、开没开都判不出来"
    age = max(now - seen.at, 0.0)
    if age <= CONNECTOR_ONLINE_WINDOW_S:
        return "connected", f"{_age_text(age)}刚通过一次消息"
    return "disconnected", f"最后一次通信在{_age_text(age)}，现在没连着"


@router.get("/status")
async def connector_status() -> dict:
    """连接器装在哪、连没连上。只读，不写库也不改任何进程状态。

    心跳来自连接器请求上自带的 ``?connector=``；没有真实信号一律回 ``unknown``，
    不拿「没消息」冒充「没安装」。目录给绝对路径，前端直接展示并复制，
    不让用户自己拼。
    """
    now = time.time()
    root = tools_root()
    dist_dir = root / DIST_DIR_NAME
    artifacts = _read_build_record(dist_dir)
    items: list[dict] = []
    for spec in CONNECTOR_SPECS:
        seen = _PRESENCE.get(spec.id)
        state, note = _presence_state(seen, now)
        source_dir = root / spec.source_name
        entry_path = source_dir / spec.entry_name
        package_path = dist_dir / spec.package_name
        record = artifacts.get(spec.package_name)
        items.append(
            {
                "id": spec.id,
                "tool_id": spec.tool_id,
                "label": spec.label,
                "host_hint": spec.host_hint,
                "state": state,
                "state_note": note,
                "last_seen_at": (
                    datetime.fromtimestamp(seen.at, UTC).isoformat() if seen else None
                ),
                "seen_seconds_ago": round(now - seen.at, 1) if seen else None,
                "version": seen.version if seen else "",
                "channel": seen.channel if seen else "",
                "source_dir": str(source_dir),
                "source_dir_exists": source_dir.is_dir(),
                "entry_path": str(entry_path),
                "entry_exists": entry_path.is_file(),
                "package_path": str(package_path),
                "package_exists": package_path.is_file(),
                "package_built_at": (record.get("built_at") if isinstance(record, dict) else None),
            }
        )
    return {
        "checked_at": datetime.now(UTC).isoformat(),
        "online_window_s": int(CONNECTOR_ONLINE_WINDOW_S),
        "package_command": "python3 tools/package_connectors.py",
        "connectors": items,
    }
