"""Sora/OpenAI Videos 与火山方舟 Seedance 异步执行器。

这里只处理上游协议、轮询和产物下载；StudioTask 状态机与本地存储
由 worker 管理。上游 task id 先持久化再轮询，进程重启后可恢复且不重复扣费。
"""

from __future__ import annotations

import asyncio
import base64
import math
import mimetypes
import shutil
from copy import deepcopy
from dataclasses import dataclass, field, replace
from pathlib import PurePosixPath
from typing import Any, Protocol
from urllib.parse import urlparse

import anyio
import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from domain import cli_bridge, image_describe, studio_frames
from domain.model_catalog import ResolvedModelRoute
from domain.model_invocations import ModelInvocationSpan
from domain.model_plugins import get_model_plugin, model_plugin_identity
from domain.models import ImageAsset, StudioMediaAsset
from domain.network_policy import routed_http_client
from domain.plugin_runtime import (
    PluginManifest,
    PluginRegistry,
    PluginRegistryError,
    RegistrationHandle,
)
from domain.storage import get_storage

POLL_INTERVAL_S = 4.0
VIDEO_TIMEOUT_S = 3600.0
MAX_VIDEO_BYTES = 1024 * 1024 * 1024

SUCCESS_STATUSES = frozenset(
    {
        "completed",
        "complete",
        "success",
        "succeed",
        "succeeded",
        "done",
        "ready",
    }
)
FAILURE_STATUSES = frozenset(
    {
        "failed",
        "failure",
        "error",
        "errored",
        "cancelled",
        "canceled",
        "expired",
        "rejected",
    }
)


class VideoGenerationError(Exception):
    def __init__(self, kind: str, message: str, *, retryable: bool = True) -> None:
        super().__init__(message)
        self.kind = kind
        self.retryable = retryable


class VideoRouteProvider(Protocol):
    """视频 Service Provider：封装提交、恢复与轮询协议。"""

    async def submit(
        self,
        route: PreparedVideoRoute,
        session: AsyncSession,
        **kwargs: Any,
    ) -> VideoHandle: ...

    def resume(self, route: PreparedVideoRoute, provider_task_id: str) -> VideoHandle: ...

    async def wait(self, handle: VideoHandle) -> VideoOutput: ...


@dataclass(frozen=True)
class VideoRouteSnapshot:
    capability: str
    operation: str
    deployment_id: int
    plugin_id: str
    plugin_version: str
    plugin_generation: int
    runtime_generation: int
    provider_type: str
    model: str

    def view(self) -> dict[str, Any]:
        return {
            "capability": self.capability,
            "operation": self.operation,
            "deployment_id": self.deployment_id,
            "plugin_id": self.plugin_id,
            "plugin_version": self.plugin_version,
            "plugin_generation": self.plugin_generation,
            "runtime_generation": self.runtime_generation,
            "provider_type": self.provider_type,
            "model": self.model,
        }


@dataclass(frozen=True)
class PreparedVideoRoute:
    """绑定模型插件与视频 Provider 代际的不可变执行准备结果。"""

    snapshot: VideoRouteSnapshot
    _route: ResolvedModelRoute = field(repr=False, compare=False)
    _provider: VideoRouteProvider = field(repr=False, compare=False)

    async def submit(self, session: AsyncSession, **kwargs: Any) -> VideoHandle:
        handle = await self._provider.submit(self, session, **kwargs)
        return replace(handle, snapshot=self.snapshot, _provider=self._provider)

    def resume(self, provider_task_id: str) -> VideoHandle:
        handle = self._provider.resume(self, provider_task_id)
        return replace(handle, snapshot=self.snapshot, _provider=self._provider)


@dataclass(frozen=True)
class VideoHandle:
    protocol: str
    provider_task_id: str
    base_url: str
    config: dict[str, Any] = field(repr=False)
    options: dict[str, Any] = field(repr=False)
    model: str
    deployment_id: int
    snapshot: VideoRouteSnapshot | None = None
    _provider: VideoRouteProvider | None = field(default=None, repr=False, compare=False)


@dataclass(frozen=True)
class VideoOutput:
    name: str
    mime: str
    data: bytes
    source_url: str | None = None


VIDEO_PROVIDER_KIND = "model-video-provider"
_video_providers: PluginRegistry[VideoRouteProvider] = PluginRegistry(VIDEO_PROVIDER_KIND)


def register_video_route_provider(
    *,
    plugin_id: str,
    provider: VideoRouteProvider,
    operations: set[str] | frozenset[str],
    replace: bool = False,
) -> RegistrationHandle:
    """登记可撤销视频 Provider；替换句柄卸载后恢复上一代实现。"""
    plugin = get_model_plugin(plugin_id)
    normalized = frozenset(value.strip().lower() for value in operations if value.strip())
    if not normalized:
        raise PluginRegistryError("视频 Provider 至少要声明一个操作")
    if not normalized <= plugin.ready_operations:
        raise PluginRegistryError(
            f"视频 Provider 操作必须属于模型插件 {plugin.id} 的 ready_operations"
        )
    manifest = PluginManifest(
        id=plugin.id,
        kind=VIDEO_PROVIDER_KIND,
        name=f"{plugin.name} Video Provider",
        version="1.0.0",
        capabilities=normalized,
    )
    return _video_providers.register(manifest, provider, replace=replace)


def video_route_provider_views() -> dict[str, dict[str, Any]]:
    return {
        item.manifest.id: {
            "video_provider_operations": sorted(item.manifest.capabilities),
            "video_runtime_generation": item.generation,
        }
        for item in _video_providers.list()
    }


def prepare_video_route(
    capability: str,
    operation: str,
    route: ResolvedModelRoute,
) -> PreparedVideoRoute:
    """冻结已解析模型路由与当前视频 Provider 实现。"""
    normalized_operation = operation.strip().lower()
    try:
        plugin = get_model_plugin(route.adapter_type)
        runtime = _video_providers.resolve(normalized_operation, preferred_id=plugin.id)
    except (ValueError, PluginRegistryError) as exc:
        raise VideoGenerationError(
            "binding",
            f"模型插件 {route.adapter_type} 没有可用的 {normalized_operation} Provider",
            retryable=False,
        ) from exc
    if not plugin.supports(normalized_operation):
        raise VideoGenerationError(
            "binding",
            f"模型插件 {plugin.id} 不支持操作：{normalized_operation}",
            retryable=False,
        )
    if not plugin.is_ready(normalized_operation):
        raise VideoGenerationError(
            "binding",
            f"模型插件 {plugin.id} 的 {normalized_operation} 尚未接入执行",
            retryable=False,
        )
    version, generation = model_plugin_identity(plugin.id)
    frozen_route = deepcopy(route)
    return PreparedVideoRoute(
        snapshot=VideoRouteSnapshot(
            capability=capability,
            operation=normalized_operation,
            deployment_id=frozen_route.deployment_id,
            plugin_id=plugin.id,
            plugin_version=version,
            plugin_generation=generation,
            runtime_generation=runtime.generation,
            provider_type=frozen_route.provider_type,
            model=frozen_route.upstream_model_id,
        ),
        _route=frozen_route,
        _provider=runtime.implementation,
    )


def _client(base_url: str, timeout: float = 180.0) -> httpx.AsyncClient:
    return routed_http_client(
        timeout=httpx.Timeout(connect=20.0, read=timeout, write=180.0, pool=20.0),
        follow_redirects=True,
    )


def _headers(config: dict[str, Any], *, json_body: bool = False) -> dict[str, str]:
    api_key = str(config.get("api_key") or "").strip()
    if not api_key:
        raise VideoGenerationError("auth", "视频供应商 API Key 未配置", retryable=False)
    headers = {"Authorization": f"Bearer {api_key}", "Accept": "application/json"}
    if json_body:
        headers["Content-Type"] = "application/json"
    return headers


def _base(route: ResolvedModelRoute) -> str:
    default = (
        "https://ark.cn-beijing.volces.com/api/v3"
        if route.adapter_type == "volcengine"
        else "https://api.openai.com/v1"
    )
    base = str(route.credential_config.get("api_base") or default).strip().rstrip("/")
    if not base.startswith(("http://", "https://")):
        raise VideoGenerationError(
            "input", "API Base 必须以 http:// 或 https:// 开头", retryable=False
        )
    if route.adapter_type == "openai" and not base.endswith(("/v1", "/v2")):
        base += "/v1"
    return base


def _status(payload: Any) -> str:
    if not isinstance(payload, dict):
        return ""
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    return str(data.get("status") or data.get("task_status") or "").strip().lower()


def _task_id(payload: Any) -> str:
    if not isinstance(payload, dict):
        return ""
    candidates = [payload]
    for key in ("data", "result", "detail"):
        if isinstance(payload.get(key), dict):
            candidates.append(payload[key])
    for node in candidates:
        value = node.get("id") or node.get("task_id") or node.get("taskId") or node.get("video_id")
        if value:
            return str(value)
    return ""


_URL_KEYS = frozenset(
    {
        "url",
        "video_url",
        "videourl",
        "output_url",
        "outputurl",
        "download_url",
        "downloadurl",
        "video",
        "src",
        "uri",
        "content_url",
        "contenturl",
    }
)


def _urls(value: Any) -> list[str]:
    found: list[str] = []
    if isinstance(value, str) and value.startswith(("http://", "https://")):
        return [value]
    if isinstance(value, list):
        for child in value:
            found.extend(_urls(child))
    elif isinstance(value, dict):
        for key, child in value.items():
            if key.lower() in _URL_KEYS or key.lower() in {
                "data",
                "result",
                "results",
                "output",
                "outputs",
                "content",
                "videos",
            }:
                found.extend(_urls(child))
    return list(dict.fromkeys(found))


async def _asset_file(
    session: AsyncSession,
    asset_id: int | None,
) -> tuple[str, bytes, str] | None:
    if asset_id is None:
        return None
    row = await session.get(ImageAsset, asset_id)
    if row is None:
        raise VideoGenerationError("input", f"参考图资产不存在：{asset_id}", retryable=False)
    data = await get_storage().read(row.storage_key)
    ext = mimetypes.guess_extension(row.mime) or ".png"
    return f"asset-{row.id}{ext}", data, row.mime


async def _reference_files(
    session: AsyncSession,
    reference_asset_id: int | None,
    references: list[dict[str, Any]] | None,
    *,
    legacy_role: str = "first_frame",
) -> list[tuple[str, bytes, str, str]]:
    """把新的多参考合同和旧的单参考快照归一成同一队列。

    旧任务在数据库里只有 reference_asset_id，恢复时仍必须能跑；新任务
    由 API 边界验证角色和数量，这里再做一次最终防线，避免手工写入的快照绕过。
    """
    raw_items = list(references or [])
    if reference_asset_id is not None:
        if raw_items:
            raise VideoGenerationError(
                "input", "reference_asset_id 与 references 不能同时使用", retryable=False
            )
        raw_items = [{"asset_id": reference_asset_id, "role": legacy_role}]
    if len(raw_items) > 20:
        raise VideoGenerationError("input", "视频参考图最多 20 张", retryable=False)
    out: list[tuple[str, bytes, str, str]] = []
    seen: set[int] = set()
    allowed_roles = {"first_frame", "last_frame", "reference_image"}
    for item in raw_items:
        try:
            asset_id = int(item.get("asset_id") or 0)
        except (TypeError, ValueError) as exc:
            raise VideoGenerationError("input", "视频参考图 ID 无效", retryable=False) from exc
        role = str(item.get("role") or "first_frame").strip()
        if asset_id <= 0 or role not in allowed_roles:
            raise VideoGenerationError("input", "视频参考图或角色无效", retryable=False)
        if asset_id in seen:
            raise VideoGenerationError("input", "视频参考图不能重复", retryable=False)
        seen.add(asset_id)
        loaded = await _asset_file(session, asset_id)
        assert loaded is not None
        name, data, mime = loaded
        out.append((name, data, mime, role))
    return out


async def _media_reference_files(
    session: AsyncSession,
    references: list[dict[str, Any]] | None,
) -> list[tuple[str, bytes, str, str]]:
    rows = await _media_reference_rows(session, references)
    out: list[tuple[str, bytes, str, str]] = []
    for row in rows:
        data = await get_storage().read(row.storage_key)
        ext = mimetypes.guess_extension(row.mime) or (
            ".mp4" if row.kind == "video" else ".mp3"
        )
        out.append((f"media-{row.id}{ext}", data, row.mime, row.kind))
    return out


async def _media_reference_rows(
    session: AsyncSession,
    references: list[dict[str, Any]] | None,
) -> list[StudioMediaAsset]:
    raw_items = list(references or [])
    if len(raw_items) > 6:
        raise VideoGenerationError("input", "视频/音频参考最多 6 个", retryable=False)
    out: list[StudioMediaAsset] = []
    seen: set[int] = set()
    counts = {"video": 0, "audio": 0}
    for item in raw_items:
        try:
            media_id = int(item.get("media_asset_id") or 0)
        except (TypeError, ValueError) as exc:
            raise VideoGenerationError("input", "多媒体参考 ID 无效", retryable=False) from exc
        kind = str(item.get("kind") or "").strip().lower()
        if media_id <= 0 or kind not in counts:
            raise VideoGenerationError("input", "多媒体参考类型无效", retryable=False)
        if media_id in seen:
            raise VideoGenerationError("input", "视频/音频参考不能重复", retryable=False)
        seen.add(media_id)
        row = await session.get(StudioMediaAsset, media_id)
        if row is None or row.status != "active":
            raise VideoGenerationError(
                "input", f"多媒体参考不存在或已归档：{media_id}", retryable=False
            )
        if row.kind != kind or kind not in {"video", "audio"}:
            raise VideoGenerationError(
                "input", f"多媒体参考类型不匹配：{media_id}", retryable=False
            )
        counts[kind] += 1
        if counts[kind] > 3:
            label = "视频" if kind == "video" else "音频"
            raise VideoGenerationError("input", f"多模态参考最多 3 个{label}", retryable=False)
        out.append(row)
    return out


def _video_reference_seconds(duration_ms: int | None, *, max_frames: int = 4) -> list[float]:
    """均匀抽取本地参考视频关键帧，与 Infinite-Canvas 的本地回退语义一致。"""
    if duration_ms is None or duration_ms <= 0:
        return [float(index) for index in range(max_frames)]
    duration_s = duration_ms / 1000
    count = min(max_frames, max(1, math.ceil(duration_s)))
    if count == 1:
        return [0.0]
    end = max(0.0, duration_s - 0.05)
    return [round(end * index / (count - 1), 3) for index in range(count)]


async def _volcengine_media_url(row: StudioMediaAsset) -> str | None:
    """优先返回火山可直接拉取的受管 URL；本地存储留给内联/抽帧回退。"""
    source_url = str(row.source_url or "").strip()
    if source_url.startswith("asset://"):
        return source_url
    presigned = await get_storage().presigned_url(row.storage_key, ttl_s=3600)
    if presigned and presigned.startswith(("http://", "https://")):
        return presigned
    if source_url.startswith(("http://", "https://")):
        return source_url
    return None


async def _volcengine_media_reference_items(
    session: AsyncSession,
    references: list[dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    """把受管视频/音频转换为方舟 content。

    有公开/签名 URL 时保留完整媒体；纯本地视频按源项目行为抽最多四帧，
    纯本地音频以内联 data URL 提交，避免把本机路径暴露给上游。
    """
    rows = await _media_reference_rows(session, references)
    content: list[dict[str, Any]] = []
    storage = get_storage()
    for row in rows:
        remote_url = await _volcengine_media_url(row)
        if row.kind == "audio":
            url = remote_url
            if url is None:
                data = await storage.read(row.storage_key)
                url = f"data:{row.mime};base64,{base64.b64encode(data).decode('ascii')}"
            content.append(
                {
                    "type": "audio_url",
                    "audio_url": {"url": url},
                    "role": "reference_audio",
                }
            )
            continue
        if remote_url is not None:
            content.append(
                {
                    "type": "video_url",
                    "video_url": {"url": remote_url},
                    "role": "reference_video",
                }
            )
            continue
        if shutil.which("ffmpeg") is None:
            raise VideoGenerationError(
                "input", "服务器上没有 ffmpeg，无法处理本地参考视频", retryable=False
            )
        path = storage.local_path(row.storage_key)
        if path is None:
            raise VideoGenerationError(
                "input",
                "当前存储无法提供参考视频的公开 URL 或本地抽帧路径",
                retryable=False,
            )
        frames: list[dict[str, Any]] = []
        for at_s in _video_reference_seconds(row.duration_ms):
            try:
                data = await anyio.to_thread.run_sync(studio_frames._ffmpeg_frame, path, at_s)
                compressed, mime = image_describe._compress(data)
            except (studio_frames.StudioFrameError, image_describe.DescribeError):
                continue
            frames.append(
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{mime};base64,{base64.b64encode(compressed).decode('ascii')}"
                    },
                    "role": "reference_image",
                }
            )
        if not frames:
            raise VideoGenerationError(
                "input", f"无法从参考视频抽取关键帧：{row.name}", retryable=False
            )
        content.extend(frames)
    return content


def _openai_size(aspect_ratio: str, resolution: str) -> str:
    ratio = str(aspect_ratio or "16:9").strip()
    high = str(resolution or "").strip().lower() in {"1080p", "high", "pro"}
    if ratio == "16:9":
        return "1792x1024" if high else "1280x720"
    if ratio == "9:16":
        return "1024x1792" if high else "720x1280"
    raise VideoGenerationError("input", "OpenAI Videos 当前只支持 16:9 或 9:16", retryable=False)


async def submit(
    session: AsyncSession,
    *,
    route: ResolvedModelRoute,
    prompt: str,
    duration: int,
    aspect_ratio: str,
    resolution: str,
    reference_asset_id: int | None = None,
    references: list[dict[str, Any]] | None = None,
    media_references: list[dict[str, Any]] | None = None,
    options: dict[str, Any] | None = None,
) -> VideoHandle:
    prepared = prepare_video_route("video-generate", "video.generate", route)
    snapshot = prepared.snapshot
    span = await ModelInvocationSpan(
        plugin_id=snapshot.plugin_id,
        plugin_version=snapshot.plugin_version,
        plugin_generation=snapshot.plugin_generation,
        runtime_generation=snapshot.runtime_generation,
        operation=snapshot.operation,
        capability=snapshot.capability,
        deployment_id=snapshot.deployment_id,
        model=snapshot.model,
        request={
            "phase": "submit",
            "prompt": prompt,
            "duration": duration,
            "aspect_ratio": aspect_ratio,
            "resolution": resolution,
            "reference_asset_id": reference_asset_id,
            "references": references,
            "media_references": media_references,
            "options": options,
            "route": snapshot.view(),
        },
    ).start()
    try:
        handle = await _submit_impl(
            session,
            route=route,
            prompt=prompt,
            duration=duration,
            aspect_ratio=aspect_ratio,
            resolution=resolution,
            reference_asset_id=reference_asset_id,
            references=references,
            media_references=media_references,
            options=options,
            prepared=prepared,
        )
    except BaseException as exc:
        status = "cancelled" if isinstance(exc, asyncio.CancelledError) else "failed"
        await span.fail(exc, status=status)
        raise
    await span.succeed(
        response={"provider_task_id": handle.provider_task_id, "protocol": handle.protocol},
        provider_request_id=handle.provider_task_id,
    )
    return handle


async def _submit_impl(
    session: AsyncSession,
    *,
    route: ResolvedModelRoute,
    prompt: str,
    duration: int,
    aspect_ratio: str,
    resolution: str,
    reference_asset_id: int | None = None,
    references: list[dict[str, Any]] | None = None,
    media_references: list[dict[str, Any]] | None = None,
    options: dict[str, Any] | None = None,
    prepared: PreparedVideoRoute | None = None,
) -> VideoHandle:
    selected = prepared or prepare_video_route("video-generate", "video.generate", route)
    return await selected.submit(
        session,
        prompt=prompt,
        duration=duration,
        aspect_ratio=aspect_ratio,
        resolution=resolution,
        reference_asset_id=reference_asset_id,
        references=references,
        media_references=media_references,
        options=options or {},
    )


async def _submit_openai(
    session: AsyncSession,
    *,
    route: ResolvedModelRoute,
    prompt: str,
    duration: int,
    aspect_ratio: str,
    resolution: str,
    reference_asset_id: int | None,
    references: list[dict[str, Any]] | None,
    options: dict[str, Any],
) -> VideoHandle:
    if duration not in {4, 8, 12} and not route.protocol_options.get("allow_custom_seconds"):
        raise VideoGenerationError(
            "input", "OpenAI Videos 时长只支持 4、8 或 12 秒", retryable=False
        )
    base = _base(route)
    endpoint = f"{base}/{str(route.protocol_options.get('submit_path') or 'videos').lstrip('/')}"
    fields = {
        "model": route.upstream_model_id,
        "prompt": prompt.strip(),
        "seconds": str(duration),
        "size": str(options.get("size") or _openai_size(aspect_ratio, resolution)),
    }
    parts: list[tuple[str, tuple]] = [(key, (None, value)) for key, value in fields.items()]
    reference_files = await _reference_files(
        session,
        reference_asset_id,
        references,
        legacy_role=str(options.get("reference_role") or "first_frame"),
    )
    if len(reference_files) > 1:
        raise VideoGenerationError("input", "OpenAI Videos 最多只支持 1 张参考图", retryable=False)
    if reference_files:
        name, data, mime, _ = reference_files[0]
        parts.append(("input_reference", (name, data, mime)))
    try:
        async with _client(base) as client:
            response = await client.post(
                endpoint,
                headers=_headers(route.credential_config),
                files=parts,
            )
    except httpx.TimeoutException as exc:
        raise VideoGenerationError("timeout", "OpenAI 视频任务提交超时") from exc
    except httpx.HTTPError as exc:
        raise VideoGenerationError("connect", f"连不上视频供应商：{exc}") from exc
    _raise_http("OpenAI Videos", response)
    try:
        payload = response.json()
    except ValueError as exc:
        raise VideoGenerationError("api", "视频提交结果不是 JSON") from exc
    task_id = _task_id(payload)
    if not task_id:
        raise VideoGenerationError("api", f"视频提交未返回任务 ID：{str(payload)[:300]}")
    return VideoHandle(
        "openai",
        task_id,
        base,
        route.credential_config,
        route.protocol_options,
        route.upstream_model_id,
        route.deployment_id,
    )


async def _submit_volcengine(
    session: AsyncSession,
    *,
    route: ResolvedModelRoute,
    prompt: str,
    duration: int,
    aspect_ratio: str,
    resolution: str,
    reference_asset_id: int | None,
    references: list[dict[str, Any]] | None,
    media_references: list[dict[str, Any]] | None,
    options: dict[str, Any],
) -> VideoHandle:
    base = _base(route)
    endpoint = f"{base}/contents/generations/tasks"
    content: list[dict[str, Any]] = [{"type": "text", "text": prompt.strip()}]
    reference_files = await _reference_files(
        session,
        reference_asset_id,
        references,
        legacy_role=str(options.get("reference_role") or "first_frame"),
    )
    roles = [item[3] for item in reference_files]
    if roles.count("first_frame") > 1 or roles.count("last_frame") > 1:
        raise VideoGenerationError("input", "首帧和尾帧参考各最多 1 张", retryable=False)
    camera_fixed = options.get("camera_fixed", options.get("camerafixed"))
    media_content = await _volcengine_media_reference_items(session, media_references)
    if (
        media_content
        and not reference_files
        and not any(item.get("type") in {"video_url", "image_url"} for item in media_content)
    ):
        raise VideoGenerationError(
            "input", "火山方舟多模态参考不能只使用音频", retryable=False
        )
    if camera_fixed is True and (reference_files or media_content):
        raise VideoGenerationError("input", "火山方舟的固定机位不支持参考场景", retryable=False)
    for _, data, mime, role in reference_files:
        content.append(
            {
                "type": "image_url",
                "image_url": {
                    "url": f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"
                },
                "role": role,
            }
        )
    content.extend(media_content)
    body: dict[str, Any] = {
        "model": route.upstream_model_id,
        "content": content,
        "duration": duration,
        "ratio": aspect_ratio,
    }
    if resolution:
        body["resolution"] = resolution
    for key in ("watermark", "generate_audio", "seed"):
        if key in options and options[key] is not None:
            body[key] = options[key]
    if camera_fixed is not None:
        body["camera_fixed"] = camera_fixed
    try:
        async with _client(base) as client:
            response = await client.post(
                endpoint, headers=_headers(route.credential_config, json_body=True), json=body
            )
    except httpx.TimeoutException as exc:
        raise VideoGenerationError("timeout", "Seedance 视频任务提交超时") from exc
    except httpx.HTTPError as exc:
        raise VideoGenerationError("connect", f"连不上火山方舟：{exc}") from exc
    _raise_http("火山方舟", response)
    try:
        payload = response.json()
    except ValueError as exc:
        raise VideoGenerationError("api", "Seedance 提交结果不是 JSON") from exc
    task_id = _task_id(payload)
    if not task_id:
        raise VideoGenerationError("api", f"Seedance 未返回任务 ID：{str(payload)[:300]}")
    return VideoHandle(
        "volcengine",
        task_id,
        base,
        route.credential_config,
        route.protocol_options,
        route.upstream_model_id,
        route.deployment_id,
    )


async def _submit_jimeng(
    session: AsyncSession,
    *,
    route: ResolvedModelRoute,
    prompt: str,
    duration: int,
    aspect_ratio: str,
    resolution: str,
    reference_asset_id: int | None,
    references: list[dict[str, Any]] | None,
    media_references: list[dict[str, Any]] | None,
    options: dict[str, Any],
) -> VideoHandle:
    unsupported = [
        label
        for key, label in (
            ("watermark", "水印"),
            ("generate_audio", "同步音频"),
            ("camera_fixed", "固定机位"),
        )
        if options.get(key) is True
    ]
    if options.get("seed") is not None:
        unsupported.append("随机种子")
    if unsupported:
        raise VideoGenerationError(
            "input", f"即梦 CLI 不支持：{'、'.join(unsupported)}", retryable=False
        )
    reference_files = await _reference_files(
        session,
        reference_asset_id,
        references,
        legacy_role=str(options.get("reference_role") or "first_frame"),
    )
    media_files = await _media_reference_files(session, media_references)
    if media_files and not reference_files and not any(item[3] == "video" for item in media_files):
        raise VideoGenerationError("input", "即梦全能参考不能只使用音频", retryable=False)
    try:
        task_id = await cli_bridge.submit_jimeng_video(
            config=route.credential_config,
            prompt=prompt,
            model=route.upstream_model_id,
            duration=duration,
            aspect_ratio=aspect_ratio,
            resolution=resolution,
            references=[(name, data, role) for name, data, _mime, role in reference_files],
            media_references=[(name, data, kind) for name, data, _mime, kind in media_files],
            multimodal=bool(options.get("multimodal")),
        )
    except cli_bridge.CliBridgeError as exc:
        raise VideoGenerationError(exc.kind, str(exc), retryable=exc.retryable) from exc
    return VideoHandle(
        "jimeng",
        task_id,
        "",
        route.credential_config,
        route.protocol_options,
        route.upstream_model_id,
        route.deployment_id,
    )


def resume_handle(route: ResolvedModelRoute, provider_task_id: str) -> VideoHandle:
    task_id = str(provider_task_id or "").strip()
    if not task_id:
        raise VideoGenerationError("input", "上游视频任务 ID 为空", retryable=False)
    prepared = prepare_video_route("video-generate", "video.generate", route)
    return prepared.resume(task_id)


async def wait_for_output(handle: VideoHandle) -> VideoOutput:
    snapshot = handle.snapshot
    provider = handle._provider
    if snapshot is None or provider is None:
        raise VideoGenerationError(
            "binding", "视频任务未绑定 Provider 运行时", retryable=False
        )
    span = await ModelInvocationSpan(
        plugin_id=snapshot.plugin_id,
        plugin_version=snapshot.plugin_version,
        plugin_generation=snapshot.plugin_generation,
        runtime_generation=snapshot.runtime_generation,
        operation=snapshot.operation,
        capability=snapshot.capability,
        deployment_id=snapshot.deployment_id,
        model=snapshot.model,
        request={
            "phase": "wait",
            "provider_task_id": handle.provider_task_id,
            "route": snapshot.view(),
        },
    ).start()
    try:
        output = await _wait_for_output_impl(handle)
    except BaseException as exc:
        status = "cancelled" if isinstance(exc, asyncio.CancelledError) else "failed"
        await span.fail(exc, status=status)
        raise
    await span.succeed(
        response={
            "provider_task_id": handle.provider_task_id,
            "name": output.name,
            "mime": output.mime,
            "bytes": len(output.data),
            "source_url": output.source_url,
        },
        provider_request_id=handle.provider_task_id,
    )
    return output


async def _wait_for_output_impl(handle: VideoHandle) -> VideoOutput:
    provider = handle._provider
    if provider is None:
        raise VideoGenerationError(
            "binding", "视频任务未绑定 Provider 运行时", retryable=False
        )
    return await provider.wait(handle)


async def _wait_jimeng_output(handle: VideoHandle) -> VideoOutput:
    deadline = asyncio.get_running_loop().time() + VIDEO_TIMEOUT_S
    while asyncio.get_running_loop().time() < deadline:
        try:
            result = await cli_bridge.query_jimeng_video(
                config=handle.config,
                submit_id=handle.provider_task_id,
            )
        except cli_bridge.CliBridgeError as exc:
            raise VideoGenerationError(exc.kind, str(exc), retryable=exc.retryable) from exc
        if result is not None:
            return VideoOutput(
                result.name,
                result.mime,
                result.data,
                source_url=result.source_url,
            )
        await asyncio.sleep(POLL_INTERVAL_S)
    raise VideoGenerationError("timeout", "即梦视频任务运行超过 1 小时")


async def _wait_remote_output(
    handle: VideoHandle,
    *,
    status_url: str,
    download_content: bool,
) -> VideoOutput:
    deadline = asyncio.get_running_loop().time() + VIDEO_TIMEOUT_S
    while asyncio.get_running_loop().time() < deadline:
        try:
            async with _client(handle.base_url, timeout=90.0) as client:
                response = await client.get(status_url, headers=_headers(handle.config))
            _raise_http("视频任务", response)
            payload = response.json()
        except VideoGenerationError:
            raise
        except (httpx.HTTPError, ValueError) as exc:
            raise VideoGenerationError("connect", f"视频任务轮询失败：{exc}") from exc
        status = _status(payload)
        if status in FAILURE_STATUSES:
            detail = _failure_detail(payload)
            raise VideoGenerationError("provider_failed", f"上游视频任务失败：{detail}")
        urls = _urls(payload)
        if status in SUCCESS_STATUSES or urls:
            if urls:
                return await _download_url(handle, urls[0])
            if download_content:
                return await _download_openai_content(handle)
            raise VideoGenerationError("provider_failed", "视频任务完成但没有产物")
        await asyncio.sleep(POLL_INTERVAL_S)
    raise VideoGenerationError("timeout", "视频任务运行超过 1 小时")


def _failure_detail(payload: Any) -> str:
    if not isinstance(payload, dict):
        return str(payload)
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    error = data.get("error") if isinstance(data.get("error"), dict) else {}
    return str(
        data.get("fail_reason")
        or data.get("message")
        or error.get("message")
        or payload.get("message")
        or payload.get("error")
        or payload
    )[:500]


def _raise_http(provider: str, response: httpx.Response) -> None:
    if response.status_code < 400:
        return
    detail = response.text[:500]
    try:
        payload = response.json()
        if isinstance(payload, dict):
            error = payload.get("error")
            if isinstance(error, dict):
                detail = str(error.get("message") or detail)
            else:
                detail = str(payload.get("message") or detail)
    except ValueError:
        pass
    if response.status_code in {401, 403}:
        raise VideoGenerationError(
            "auth", f"{provider} 鉴权失败（HTTP {response.status_code}）：{detail}", retryable=False
        )
    if response.status_code in {400, 404, 422}:
        raise VideoGenerationError(
            "input",
            f"{provider} 拒绝了请求（HTTP {response.status_code}）：{detail}",
            retryable=False,
        )
    raise VideoGenerationError("api", f"{provider} HTTP {response.status_code}：{detail}")


async def _read_limited(response: httpx.Response) -> bytes:
    chunks: list[bytes] = []
    total = 0
    async for chunk in response.aiter_bytes():
        total += len(chunk)
        if total > MAX_VIDEO_BYTES:
            raise VideoGenerationError("api", "视频产物超过 1GB 上限")
        chunks.append(chunk)
    return b"".join(chunks)


async def _download_openai_content(handle: VideoHandle) -> VideoOutput:
    url = f"{handle.base_url}/videos/{handle.provider_task_id}/content"
    async with _client(handle.base_url, timeout=600.0) as client:
        response = await client.get(url, headers=_headers(handle.config))
    _raise_http("OpenAI 视频产物", response)
    mime = response.headers.get("content-type") or "video/mp4"
    return VideoOutput(f"{handle.provider_task_id}.mp4", mime, await _read_limited(response))


async def _download_url(handle: VideoHandle, url: str) -> VideoOutput:
    async with _client(handle.base_url, timeout=600.0) as client:
        response = await client.get(url, headers={"Accept": "*/*"})
    _raise_http("视频产物下载", response)
    name = PurePosixPath(urlparse(url).path).name or f"{handle.provider_task_id}.mp4"
    mime = response.headers.get("content-type") or mimetypes.guess_type(name)[0] or "video/mp4"
    return VideoOutput(name, mime, await _read_limited(response), source_url=url)


def _resumed_handle(
    route: PreparedVideoRoute,
    provider_task_id: str,
    *,
    protocol: str,
    base_url: str,
) -> VideoHandle:
    resolved = route._route
    return VideoHandle(
        protocol,
        provider_task_id,
        base_url,
        resolved.credential_config,
        resolved.protocol_options,
        resolved.upstream_model_id,
        resolved.deployment_id,
    )


def _reject_media_references(kwargs: dict[str, Any]) -> None:
    if kwargs.pop("media_references", None):
        raise VideoGenerationError(
            "input", "视频/音频全能参考目前只支持即梦 CLI", retryable=False
        )


class _OpenAIVideoProvider:
    async def submit(
        self,
        route: PreparedVideoRoute,
        session: AsyncSession,
        **kwargs: Any,
    ) -> VideoHandle:
        _reject_media_references(kwargs)
        return await _submit_openai(session, route=route._route, **kwargs)

    def resume(self, route: PreparedVideoRoute, provider_task_id: str) -> VideoHandle:
        return _resumed_handle(
            route,
            provider_task_id,
            protocol="openai",
            base_url=_base(route._route),
        )

    async def wait(self, handle: VideoHandle) -> VideoOutput:
        return await _wait_remote_output(
            handle,
            status_url=f"{handle.base_url}/videos/{handle.provider_task_id}",
            download_content=True,
        )


class _VolcengineVideoProvider:
    async def submit(
        self,
        route: PreparedVideoRoute,
        session: AsyncSession,
        **kwargs: Any,
    ) -> VideoHandle:
        return await _submit_volcengine(session, route=route._route, **kwargs)

    def resume(self, route: PreparedVideoRoute, provider_task_id: str) -> VideoHandle:
        return _resumed_handle(
            route,
            provider_task_id,
            protocol="volcengine",
            base_url=_base(route._route),
        )

    async def wait(self, handle: VideoHandle) -> VideoOutput:
        return await _wait_remote_output(
            handle,
            status_url=(
                f"{handle.base_url}/contents/generations/tasks/{handle.provider_task_id}"
            ),
            download_content=False,
        )


class _JimengVideoProvider:
    async def submit(
        self,
        route: PreparedVideoRoute,
        session: AsyncSession,
        **kwargs: Any,
    ) -> VideoHandle:
        return await _submit_jimeng(session, route=route._route, **kwargs)

    def resume(self, route: PreparedVideoRoute, provider_task_id: str) -> VideoHandle:
        return _resumed_handle(route, provider_task_id, protocol="jimeng", base_url="")

    async def wait(self, handle: VideoHandle) -> VideoOutput:
        return await _wait_jimeng_output(handle)


def _register_builtin_video_providers() -> tuple[RegistrationHandle, ...]:
    return (
        register_video_route_provider(
            plugin_id="openai",
            provider=_OpenAIVideoProvider(),
            operations={"video.generate"},
        ),
        register_video_route_provider(
            plugin_id="volcengine",
            provider=_VolcengineVideoProvider(),
            operations={"video.generate"},
        ),
        register_video_route_provider(
            plugin_id="jimeng",
            provider=_JimengVideoProvider(),
            operations={"video.generate"},
        ),
    )


_BUILTIN_VIDEO_PROVIDER_HANDLES = _register_builtin_video_providers()
