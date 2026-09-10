"""APIMart Midjourney 异步任务协议。

这里只处理上游提交、轮询、二次操作与图片下载。StudioTask 状态、
启动恢复和本地资产入库由 worker 统一管理。上游 task id 会先落库再轮询，
进程重启时继续查询，不重复扣费。

协议实现挂在 Midjourney seam 上：``submit_generate`` / ``submit_action`` /
``wait_for_output`` 先冻结路由再分发给 Provider，台账身份由 seam 写入。
"""

from __future__ import annotations

import asyncio
import base64
import io
import mimetypes
import re
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.parse import urljoin

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from domain.kernel.capability_seam import (
    CapabilitySeam,
    PreparedRoute,
    RouteRequest,
    RouteSnapshot,
    SeamError,
)
from domain.model_catalog import ResolvedModelRoute
from domain.models import ImageAsset
from domain.network_policy import routed_http_client
from domain.plugin_runtime import RegistrationHandle
from domain.storage import get_storage

POLL_INTERVAL_S = 4.0
TASK_TIMEOUT_S = 1800.0
MAX_IMAGE_BYTES = 50 * 1024 * 1024
MAX_REFERENCE_BYTES = 12 * 1024 * 1024

GENERATE_PATHS = {
    "imagine": "generations",
    "blend": "generations/blend",
    "edit": "generations/edits",
}
ACTION_PATHS = {
    "upscale": "upscale",
    "variation": "variation",
    "high_variation": "high-variation",
    "low_variation": "low-variation",
    "reroll": "reroll",
    "zoom": "zoom",
    "pan": "pan",
    "inpaint": "inpaint",
    "remix_strong": "remix-strong",
    "remix_subtle": "remix-subtle",
    "modal": "modal",
}
SUCCESS_STATUSES = frozenset({"success", "succeeded", "completed", "complete", "done"})
FAILURE_STATUSES = frozenset(
    {"failure", "failed", "error", "cancelled", "canceled", "expired", "rejected"}
)
_TASK_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,240}$")

MIDJOURNEY_PLUGIN_ID = "apimart"
MIDJOURNEY_CAPABILITY = "midjourney"
MIDJOURNEY_POLL_OPERATION = "midjourney.poll"
MIDJOURNEY_OPERATIONS = frozenset(
    {f"midjourney.{name}" for name in (*GENERATE_PATHS, *ACTION_PATHS, "poll")}
)
MIDJOURNEY_PROVIDER_KIND = "model-midjourney-provider"


class MidjourneyError(Exception):
    def __init__(self, kind: str, message: str, *, retryable: bool = True) -> None:
        super().__init__(message)
        self.kind = kind
        self.retryable = retryable


@dataclass(frozen=True)
class MidjourneyHandle:
    provider_task_id: str
    base_url: str
    credential_config: dict[str, Any]
    model: str
    deployment_id: int
    action: str
    prompt: str
    plugin_id: str = MIDJOURNEY_PLUGIN_ID
    provider_type: str = MIDJOURNEY_PLUGIN_ID


@dataclass(frozen=True)
class MidjourneyOutput:
    provider_task_id: str
    status: str
    action: str
    prompt: str
    images: list[bytes]
    source_urls: list[str]
    buttons: list[dict[str, str]]
    modal_required: bool = False


class MidjourneyRouteProvider(Protocol):
    async def submit_generate(
        self,
        route: PreparedMidjourneyRoute,
        session: AsyncSession,
        *,
        mode: str,
        prompt: str,
        size: str,
        version: str,
        speed: str,
        reference_asset_ids: list[int],
        options: dict[str, Any] | None,
        client: httpx.AsyncClient | None,
    ) -> MidjourneyHandle: ...

    async def submit_action(
        self,
        route: PreparedMidjourneyRoute,
        session: AsyncSession,
        *,
        task_id: str,
        action: str,
        speed: str,
        index: int | None,
        direction: str | None,
        zoom_ratio: float | None,
        custom_id: str | None,
        prompt: str,
        mask_asset_id: int | None,
        client: httpx.AsyncClient | None,
    ) -> MidjourneyHandle: ...

    async def wait_for_output(
        self,
        route: PreparedMidjourneyRoute,
        handle: MidjourneyHandle,
        *,
        client: httpx.AsyncClient | None,
        timeout_s: float,
        poll_interval_s: float,
    ) -> MidjourneyOutput: ...


@dataclass(frozen=True)
class PreparedMidjourneyRoute(PreparedRoute[RouteSnapshot, MidjourneyRouteProvider]):
    pass


midjourney_runtime: CapabilitySeam[RouteRequest, RouteSnapshot, MidjourneyRouteProvider] = (
    CapabilitySeam(MIDJOURNEY_PROVIDER_KIND, label="Midjourney", ready_source="midjourney")
)


def register_midjourney_route_provider(
    *,
    plugin_id: str,
    provider: MidjourneyRouteProvider,
    operations: set[str] | frozenset[str] = MIDJOURNEY_OPERATIONS,
    replace: bool = False,
) -> RegistrationHandle:
    return midjourney_runtime.register(
        plugin_id=plugin_id,
        provider=provider,
        operations=operations,
        replace=replace,
    )


def prepare_midjourney_route(request: RouteRequest, operation: str) -> PreparedMidjourneyRoute:
    try:
        return midjourney_runtime.prepare_as(PreparedMidjourneyRoute, request, operation)
    except SeamError as exc:
        raise MidjourneyError("binding", str(exc), retryable=False) from exc


def prepare_midjourney_model_route(
    route: ResolvedModelRoute,
    operation: str,
) -> PreparedMidjourneyRoute:
    return prepare_midjourney_route(
        RouteRequest.from_model_route(MIDJOURNEY_CAPABILITY, route),
        operation,
    )


def _handle_route(handle: MidjourneyHandle) -> PreparedMidjourneyRoute:
    """轮询阶段只有句柄：按句柄上记的插件与凭据重新冻结一条 poll 路由。"""
    return prepare_midjourney_route(
        RouteRequest(
            capability=MIDJOURNEY_CAPABILITY,
            plugin_id=handle.plugin_id,
            provider_type=handle.provider_type,
            model=handle.model,
            credentials=handle.credential_config,
            deployment_id=handle.deployment_id,
        ),
        MIDJOURNEY_POLL_OPERATION,
    )


def _base_url(config: Mapping[str, Any]) -> str:
    raw = str(config.get("api_base") or "https://api.apimart.ai").strip()
    raw = raw.rstrip("/")
    if not raw.startswith(("http://", "https://")):
        raise MidjourneyError(
            "input", "APIMart API Base 必须以 http:// 或 https:// 开头", retryable=False
        )
    if raw.endswith("/v1"):
        raw = raw[:-3]
    return raw.rstrip("/")


def _headers(config: Mapping[str, Any]) -> dict[str, str]:
    api_key = str(config.get("api_key") or "").strip()
    if not api_key:
        raise MidjourneyError("auth", "APIMart API Key 未配置", retryable=False)
    return {
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }


def _client(base_url: str, timeout: float = 180.0) -> httpx.AsyncClient:
    return routed_http_client(
        timeout=httpx.Timeout(connect=20.0, read=timeout, write=180.0, pool=20.0),
        follow_redirects=True,
    )


def _detail(payload: Any) -> str:
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
            return str(error.get("message") or error.get("detail") or error)[:500]
        for key in ("fail_reason", "message", "detail", "error_message"):
            value = payload.get(key)
            if value:
                return str(value)[:500]
    return str(payload)[:500]


def _http_error(response: httpx.Response, stage: str) -> MidjourneyError:
    try:
        detail = _detail(response.json())
    except ValueError:
        detail = response.text[:500]
    if response.status_code in {401, 403}:
        return MidjourneyError(
            "auth",
            f"APIMart {stage}鉴权失败（HTTP {response.status_code}）：{detail}",
            retryable=False,
        )
    if response.status_code in {400, 404, 422}:
        return MidjourneyError(
            "input",
            f"APIMart {stage}拒绝请求（HTTP {response.status_code}）：{detail}",
            retryable=False,
        )
    if response.status_code == 402:
        return MidjourneyError("quota", f"APIMart 余额不足：{detail}", retryable=False)
    if response.status_code == 429:
        return MidjourneyError("rate_limit", f"APIMart 请求过于频繁：{detail}")
    return MidjourneyError(
        "api", f"APIMart {stage}返回 HTTP {response.status_code}：{detail}"
    )


def _task_id(value: Any) -> str:
    if isinstance(value, list):
        for child in value:
            found = _task_id(child)
            if found:
                return found
        return ""
    if not isinstance(value, dict):
        return ""
    for key in ("task_id", "taskId", "id"):
        candidate = str(value.get(key) or "").strip()
        if _TASK_ID_RE.fullmatch(candidate):
            return candidate
    for key in ("data", "result", "detail"):
        found = _task_id(value.get(key))
        if found:
            return found
    return ""


def _payload_node(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    data = value.get("data")
    if isinstance(data, dict):
        return data
    if isinstance(data, list) and data and isinstance(data[0], dict):
        return data[0]
    return value


def _status(value: Any) -> str:
    node = _payload_node(value)
    return str(node.get("status") or node.get("task_status") or "").strip().lower()


def _image_urls(value: Any) -> list[str]:
    node = _payload_node(value)
    raw = node.get("image_urls") or node.get("imageUrls")
    urls: list[str] = []
    if isinstance(raw, str):
        urls.append(raw)
    elif isinstance(raw, list):
        urls.extend(str(item) for item in raw if isinstance(item, str))
    result = node.get("result")
    if isinstance(result, dict):
        images = result.get("images")
        if isinstance(images, list):
            for item in images:
                if isinstance(item, str):
                    urls.append(item)
                elif isinstance(item, dict) and isinstance(item.get("url"), str):
                    urls.append(str(item["url"]))
    if not urls:
        grid = node.get("grid_image_url") or node.get("gridImageUrl")
        if isinstance(grid, str):
            urls.append(grid)
    return list(dict.fromkeys(url.strip() for url in urls if url.strip()))


def _buttons(value: Any) -> list[dict[str, str]]:
    raw = _payload_node(value).get("buttons")
    if not isinstance(raw, list):
        return []
    result: list[dict[str, str]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        custom_id = str(item.get("customId") or item.get("custom_id") or "").strip()
        label = str(item.get("label") or item.get("emoji") or "").strip()
        if custom_id:
            result.append({"custom_id": custom_id, "label": label})
    return result


def _prompt(value: Any, fallback: str) -> str:
    node = _payload_node(value)
    return str(node.get("prompt") or fallback).strip()


async def _asset_data_url(
    session: AsyncSession,
    asset_id: int,
    *,
    mask: bool = False,
) -> str:
    row = await session.get(ImageAsset, asset_id)
    if row is None:
        raise MidjourneyError("input", f"参考图资产不存在：{asset_id}", retryable=False)
    if not str(row.mime or "").startswith("image/"):
        raise MidjourneyError("input", f"资产不是图片：{asset_id}", retryable=False)
    data = await get_storage().read(row.storage_key)
    if len(data) > MAX_REFERENCE_BYTES:
        raise MidjourneyError(
            "input", f"参考图 {asset_id} 超过 12 MiB 上限", retryable=False
        )
    mime = row.mime or mimetypes.guess_type(row.storage_key)[0] or "image/png"
    if mask:
        data = _transparent_mask(data)
        mime = "image/png"
    encoded = base64.b64encode(data).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def _transparent_mask(data: bytes) -> bytes:
    """把画布编辑器的白色涂抹遮罩转成 APIMart 要的透明重绘区。"""
    from PIL import Image

    try:
        source = Image.open(io.BytesIO(data)).convert("RGBA")
        luminance = source.convert("L")
    except Exception as exc:
        raise MidjourneyError(
            "input", f"遮罩不是可解析的图片：{type(exc).__name__}", retryable=False
        ) from exc
    alpha = luminance.point(lambda value: 255 - value)
    output = Image.new("RGBA", source.size, (255, 255, 255, 255))
    output.putalpha(alpha)
    buffer = io.BytesIO()
    output.save(buffer, format="PNG")
    result = buffer.getvalue()
    if len(result) > MAX_REFERENCE_BYTES:
        raise MidjourneyError("input", "转换后的遮罩超过 12 MiB", retryable=False)
    return result


def _handle(
    route: PreparedMidjourneyRoute,
    task_id: str,
    action: str,
    prompt: str,
) -> MidjourneyHandle:
    snapshot = route.snapshot
    return MidjourneyHandle(
        provider_task_id=task_id,
        base_url=_base_url(route.credentials),
        credential_config=dict(route.credentials),
        model=snapshot.model,
        deployment_id=int(snapshot.deployment_id or 0),
        action=action,
        prompt=prompt,
        plugin_id=snapshot.plugin_id,
        provider_type=snapshot.provider_type,
    )


def resume_handle(
    route: ResolvedModelRoute,
    provider_task_id: str,
    *,
    action: str,
    prompt: str,
) -> MidjourneyHandle:
    task_id = str(provider_task_id or "").strip()
    if not _TASK_ID_RE.fullmatch(task_id):
        raise MidjourneyError("input", "Midjourney 上游任务 ID 无效", retryable=False)
    return MidjourneyHandle(
        provider_task_id=task_id,
        base_url=_base_url(route.credential_config),
        credential_config=route.credential_config,
        model=route.upstream_model_id,
        deployment_id=route.deployment_id,
        action=action,
        prompt=prompt,
        plugin_id=route.adapter_type,
        provider_type=route.provider_type,
    )


async def _post_json(
    client: httpx.AsyncClient | None,
    base_url: str,
    url: str,
    *,
    headers: dict[str, str],
    payload: dict[str, Any],
    stage: str,
    not_json: str,
) -> Any:
    owned = client is None
    if client is None:
        client = _client(base_url)
    try:
        response = await client.post(url, headers=headers, json=payload)
    finally:
        if owned:
            await client.aclose()
    if response.status_code >= 400:
        raise _http_error(response, stage)
    try:
        return response.json()
    except ValueError as exc:
        raise MidjourneyError("api", not_json) from exc


async def _download_image(client: httpx.AsyncClient, base_url: str, url: str) -> bytes:
    target = urljoin(f"{base_url}/", url)
    response = await client.get(target, headers={"Accept": "image/*"})
    if response.status_code >= 400:
        raise _http_error(response, "下载图片")
    length = response.headers.get("content-length")
    if length and length.isdigit() and int(length) > MAX_IMAGE_BYTES:
        raise MidjourneyError("api", "Midjourney 结果图超过 50 MiB")
    if len(response.content) > MAX_IMAGE_BYTES:
        raise MidjourneyError("api", "Midjourney 结果图超过 50 MiB")
    return response.content


class _ApimartMidjourneyProvider:
    async def submit_generate(
        self,
        route: PreparedMidjourneyRoute,
        session: AsyncSession,
        *,
        mode: str,
        prompt: str,
        size: str,
        version: str,
        speed: str,
        reference_asset_ids: list[int],
        options: dict[str, Any] | None,
        client: httpx.AsyncClient | None,
    ) -> MidjourneyHandle:
        snapshot = route.snapshot
        async with route.span(
            request={
                "phase": "submit",
                "mode": mode,
                "prompt": prompt,
                "size": size,
                "version": version,
                "speed": speed,
                "reference_asset_ids": reference_asset_ids,
                "options": options,
            },
        ) as span:
            image_urls = [
                await _asset_data_url(session, asset_id) for asset_id in reference_asset_ids
            ]
            payload: dict[str, Any] = {
                "speed": speed,
                "metadata": {"lingua_deployment_id": snapshot.deployment_id},
            }
            if mode != "blend":
                payload["prompt"] = prompt
                payload["version"] = version
            if size:
                payload["size"] = size
            if image_urls:
                payload["image_urls"] = image_urls
            for key, value in (options or {}).items():
                if value is not None:
                    payload[key] = value
            base_url = _base_url(route.credentials)
            body = await _post_json(
                client,
                base_url,
                f"{base_url}/v1/midjourney/{GENERATE_PATHS[mode]}",
                headers=_headers(route.credentials),
                payload=payload,
                stage="任务提交",
                not_json="APIMart 提交结果不是 JSON",
            )
            task_id = _task_id(body)
            if not task_id:
                raise MidjourneyError("api", f"APIMart 未返回 task_id：{_detail(body)}")
            handle = _handle(route, task_id, mode, prompt)
            span.finish(
                response={"provider_task_id": handle.provider_task_id, "action": handle.action},
                provider_request_id=handle.provider_task_id,
            )
            return handle

    async def submit_action(
        self,
        route: PreparedMidjourneyRoute,
        session: AsyncSession,
        *,
        task_id: str,
        action: str,
        speed: str,
        index: int | None,
        direction: str | None,
        zoom_ratio: float | None,
        custom_id: str | None,
        prompt: str,
        mask_asset_id: int | None,
        client: httpx.AsyncClient | None,
    ) -> MidjourneyHandle:
        snapshot = route.snapshot
        payload: dict[str, Any] = {
            "task_id": task_id,
            "speed": speed,
            "metadata": {"lingua_deployment_id": snapshot.deployment_id},
        }
        if index is not None:
            payload["index"] = index
        if direction:
            payload["direction"] = direction
        if zoom_ratio is not None:
            payload["zoom_ratio"] = zoom_ratio
        if custom_id:
            payload["custom_id"] = custom_id
        if prompt.strip():
            payload["prompt"] = prompt.strip()
        if action == "modal":
            if mask_asset_id is None:
                raise MidjourneyError("input", "局部重绘需要遮罩图", retryable=False)
            payload["mask_url"] = await _asset_data_url(session, mask_asset_id, mask=True)

        async with route.span(
            request={
                "phase": "submit",
                "parent_task_id": task_id,
                "action": action,
                "speed": speed,
                "index": index,
                "direction": direction,
                "zoom_ratio": zoom_ratio,
                "custom_id": custom_id,
                "prompt": prompt,
                "mask_asset_id": mask_asset_id,
            },
        ) as span:
            base_url = _base_url(route.credentials)
            body = await _post_json(
                client,
                base_url,
                f"{base_url}/v1/midjourney/generations/{ACTION_PATHS[action]}",
                headers=_headers(route.credentials),
                payload=payload,
                stage="二次操作提交",
                not_json="APIMart 操作结果不是 JSON",
            )
            next_task_id = _task_id(body)
            if not next_task_id:
                raise MidjourneyError("api", f"APIMart 未返回新 task_id：{_detail(body)}")
            handle = _handle(route, next_task_id, action, prompt.strip())
            span.finish(
                response={"provider_task_id": handle.provider_task_id, "action": handle.action},
                provider_request_id=handle.provider_task_id,
            )
            return handle

    async def wait_for_output(
        self,
        route: PreparedMidjourneyRoute,
        handle: MidjourneyHandle,
        *,
        client: httpx.AsyncClient | None,
        timeout_s: float,
        poll_interval_s: float,
    ) -> MidjourneyOutput:
        owned = client is None
        if client is None:
            client = _client(handle.base_url)
        deadline = time.monotonic() + timeout_s
        try:
            async with route.span(
                request={
                    "phase": "poll",
                    "provider_task_id": handle.provider_task_id,
                    "action": handle.action,
                },
            ) as span:
                while time.monotonic() < deadline:
                    response = await client.get(
                        f"{handle.base_url}/v1/midjourney/{handle.provider_task_id}",
                        headers=_headers(route.credentials),
                    )
                    if response.status_code >= 400:
                        raise _http_error(response, "任务查询")
                    try:
                        payload = response.json()
                    except ValueError as exc:
                        raise MidjourneyError("api", "APIMart 任务查询结果不是 JSON") from exc
                    status = _status(payload)
                    if status == "modal":
                        span.finish(
                            response={"status": status, "modal_required": True},
                            provider_request_id=handle.provider_task_id,
                        )
                        return MidjourneyOutput(
                            provider_task_id=handle.provider_task_id,
                            status=status,
                            action=handle.action,
                            prompt=_prompt(payload, handle.prompt),
                            images=[],
                            source_urls=[],
                            buttons=_buttons(payload),
                            modal_required=True,
                        )
                    if status in SUCCESS_STATUSES:
                        urls = _image_urls(payload)
                        if not urls:
                            raise MidjourneyError(
                                "api", f"Midjourney 任务成功但没有图片：{_detail(payload)}"
                            )
                        images = [
                            await _download_image(client, handle.base_url, url) for url in urls
                        ]
                        output = MidjourneyOutput(
                            provider_task_id=handle.provider_task_id,
                            status=status,
                            action=str(
                                _payload_node(payload).get("action") or handle.action
                            ).lower(),
                            prompt=_prompt(payload, handle.prompt),
                            images=images,
                            source_urls=urls,
                            buttons=_buttons(payload),
                        )
                        span.finish(
                            response={
                                "status": status,
                                "image_count": len(images),
                                "button_count": len(output.buttons),
                            },
                            provider_request_id=handle.provider_task_id,
                        )
                        return output
                    if status in FAILURE_STATUSES:
                        raise MidjourneyError(
                            "provider_failed",
                            f"Midjourney 任务失败：{_detail(_payload_node(payload))}",
                            retryable=False,
                        )
                    await asyncio.sleep(poll_interval_s)
                raise MidjourneyError("timeout", "Midjourney 任务超过 30 分钟仍未完成")
        finally:
            if owned:
                await client.aclose()


async def submit_generate(
    session: AsyncSession,
    *,
    route: ResolvedModelRoute,
    mode: str,
    prompt: str,
    size: str,
    version: str,
    speed: str,
    reference_asset_ids: list[int],
    options: dict[str, Any] | None = None,
    client: httpx.AsyncClient | None = None,
) -> MidjourneyHandle:
    normalized_mode = mode.strip().lower()
    if normalized_mode not in GENERATE_PATHS:
        raise MidjourneyError("input", f"不支持的 Midjourney 模式：{mode}", retryable=False)
    cleaned_prompt = prompt.strip()
    if normalized_mode != "blend" and not cleaned_prompt:
        raise MidjourneyError("input", "Midjourney 提示词不能为空", retryable=False)
    if normalized_mode == "blend" and not 2 <= len(reference_asset_ids) <= 4:
        raise MidjourneyError("input", "Midjourney 融图需要 2–4 张参考图", retryable=False)
    if normalized_mode == "edit" and not reference_asset_ids:
        raise MidjourneyError("input", "Midjourney 编辑至少需要 1 张参考图", retryable=False)
    if len(reference_asset_ids) > 4:
        raise MidjourneyError("input", "Midjourney 参考图最多 4 张", retryable=False)

    prepared = prepare_midjourney_model_route(route, f"midjourney.{normalized_mode}")
    return await prepared.provider.submit_generate(
        prepared,
        session,
        mode=normalized_mode,
        prompt=cleaned_prompt,
        size=size,
        version=version,
        speed=speed,
        reference_asset_ids=reference_asset_ids,
        options=options,
        client=client,
    )


async def submit_action(
    session: AsyncSession,
    *,
    route: ResolvedModelRoute,
    task_id: str,
    action: str,
    speed: str,
    index: int | None = None,
    direction: str | None = None,
    zoom_ratio: float | None = None,
    custom_id: str | None = None,
    prompt: str = "",
    mask_asset_id: int | None = None,
    client: httpx.AsyncClient | None = None,
) -> MidjourneyHandle:
    normalized_action = action.strip().lower().replace("-", "_")
    if normalized_action not in ACTION_PATHS:
        raise MidjourneyError("input", f"不支持的 Midjourney 操作：{action}", retryable=False)
    parent_id = str(task_id or "").strip()
    if not _TASK_ID_RE.fullmatch(parent_id):
        raise MidjourneyError("input", "Midjourney 父任务 ID 无效", retryable=False)

    prepared = prepare_midjourney_model_route(route, f"midjourney.{normalized_action}")
    return await prepared.provider.submit_action(
        prepared,
        session,
        task_id=parent_id,
        action=normalized_action,
        speed=speed,
        index=index,
        direction=direction,
        zoom_ratio=zoom_ratio,
        custom_id=custom_id,
        prompt=prompt,
        mask_asset_id=mask_asset_id,
        client=client,
    )


async def wait_for_output(
    handle: MidjourneyHandle,
    *,
    client: httpx.AsyncClient | None = None,
    timeout_s: float = TASK_TIMEOUT_S,
    poll_interval_s: float = POLL_INTERVAL_S,
) -> MidjourneyOutput:
    prepared = _handle_route(handle)
    return await prepared.provider.wait_for_output(
        prepared,
        handle,
        client=client,
        timeout_s=timeout_s,
        poll_interval_s=poll_interval_s,
    )


_BUILTIN_MIDJOURNEY_PROVIDER_HANDLES = (
    register_midjourney_route_provider(
        plugin_id=MIDJOURNEY_PLUGIN_ID,
        provider=_ApimartMidjourneyProvider(),
    ),
)
