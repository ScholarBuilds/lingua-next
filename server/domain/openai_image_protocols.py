"""OpenAI-compatible image request variants used by migrated Infinite Canvas deployments.

Credentials still live in ``ProviderCredential``.  A deployment selects one request mode in
``protocol_options.image_request_mode`` so two models behind the same Base URL can use different
wire protocols without duplicating or exposing the API key.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import math
import re
import time
from dataclasses import dataclass
from fractions import Fraction
from typing import Any

import httpx

from domain.credentials import CredentialError, openai_base
from domain.model_catalog import ResolvedModelRoute
from domain.network_policy import routed_http_client

IMAGE_REQUEST_MODES = frozenset(
    {
        "openai",
        "openai-json",
        "openai-video-proxy",
        "openai-responses",
        "tudou-async",
    }
)

_SUCCESS = frozenset(
    {
        "success",
        "successful",
        "succeed",
        "succeeded",
        "completed",
        "complete",
        "done",
        "finished",
        "ok",
        "ready",
    }
)
_FAILED = frozenset(
    {
        "failure",
        "failed",
        "fail",
        "error",
        "errored",
        "canceled",
        "cancelled",
        "timeout",
        "rejected",
        "expired",
        "incomplete",
    }
)
_PENDING = frozenset({"queued", "pending", "processing", "running", "in_progress"})
_DATA_URL = re.compile(r"^data:image/[^;,]+;base64,(.+)$", re.I | re.S)
_MARKDOWN_IMAGE = re.compile(r"!\[[^\]]*\]\((https?://[^)\s]+)\)", re.I)
_PLAIN_IMAGE_URL = re.compile(
    r"https?://[^\s)\"'<>]+\.(?:png|jpe?g|webp|gif)(?:\?[^\s)\"'<>]*)?",
    re.I,
)


class ProtocolImageError(Exception):
    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind


@dataclass(frozen=True)
class ProtocolImageResult:
    images: list[bytes]
    usage: dict[str, Any] | None
    model_reported: str | None
    latency_ms: int


def image_request_mode(route: ResolvedModelRoute | None) -> str:
    if route is None:
        return "openai"
    if route.adapter_type == "tudou":
        return "tudou-async"
    if route.adapter_type == "apimart":
        return "apimart"
    configured = str(route.protocol_options.get("image_request_mode") or "").strip().lower()
    if configured in IMAGE_REQUEST_MODES:
        return configured
    return "openai"


def uses_custom_protocol(route: ResolvedModelRoute | None) -> bool:
    return image_request_mode(route) != "openai"


def _endpoint(base: str, options: dict[str, Any], key: str, default: str) -> str:
    raw = str(options.get(key) or default).strip()
    if raw.startswith(("http://", "https://")):
        return raw
    return f"{base.rstrip('/')}/{raw.lstrip('/')}"


def _headers(route: ResolvedModelRoute) -> dict[str, str]:
    headers = {"Accept": "application/json"}
    key = str(route.credential_config.get("api_key") or "").strip()
    if key:
        headers["Authorization"] = f"Bearer {key}"
    return headers


def _mime(name: str) -> str:
    lowered = name.lower()
    if lowered.endswith(".jpg") or lowered.endswith(".jpeg"):
        return "image/jpeg"
    if lowered.endswith(".webp"):
        return "image/webp"
    if lowered.endswith(".gif"):
        return "image/gif"
    return "image/png"


def _data_url(name: str, data: bytes) -> str:
    return f"data:{_mime(name)};base64,{base64.b64encode(data).decode('ascii')}"


def _size_pair(size: str) -> tuple[int, int] | None:
    match = re.fullmatch(r"\s*(\d{2,5})\s*[xX*]\s*(\d{2,5})\s*", size)
    if match is None:
        return None
    return int(match.group(1)), int(match.group(2))


def _ratio(size: str) -> str:
    pair = _size_pair(size)
    if pair is None:
        return "1:1" if size.lower() == "auto" else size
    fraction = Fraction(pair[0], pair[1]).limit_denominator(32)
    return f"{fraction.numerator}:{fraction.denominator}"


def _resolution(size: str, model: str = "") -> str:
    for value in ("4k", "2k", "1k"):
        if model.lower().endswith(f"-{value}"):
            return value
    pair = _size_pair(size)
    if pair is None:
        return size.lower() if size.lower() in {"1k", "2k", "4k"} else "1k"
    edge = max(pair)
    pixels = math.prod(pair)
    if edge >= 3000 or pixels > 4_500_000:
        return "4k"
    if edge >= 1800 or pixels > 1_800_000:
        return "2k"
    return "1k"


def _tudou_resolution(size: str, model: str = "") -> str:
    for value in ("4k", "2k", "1k"):
        if model.lower().endswith(f"-{value}"):
            return value
    pair = _size_pair(size)
    if pair is None:
        return size.lower() if size.lower() in {"1k", "2k", "4k"} else "1k"
    edge = max(pair)
    pixels = math.prod(pair)
    if edge >= 2800 or pixels >= 7_000_000:
        return "4k"
    if edge >= 1600 or pixels >= 2_000_000:
        return "2k"
    return "1k"


def _responses_size(size: str) -> str:
    pair = _size_pair(size)
    if pair is None or pair[0] == pair[1]:
        return size
    return f"{pair[1]}x{pair[0]}"


def _responses_size_instruction(size: str) -> str:
    pair = _size_pair(size)
    if pair is None:
        return ""
    if pair[0] == pair[1]:
        return "请生成正方形图片（宽高比 1:1）。Generate a SQUARE image (aspect ratio 1:1)."
    fraction = Fraction(pair[0], pair[1]).limit_denominator(32)
    zh_shape, en_shape = (
        ("横版（宽幅）", "LANDSCAPE (wide)")
        if pair[0] > pair[1]
        else ("竖版（长幅）", "PORTRAIT (tall)")
    )
    return (
        f"请生成{zh_shape}图片：宽高比 {fraction.numerator}:{fraction.denominator}，"
        f"目标尺寸为宽 {pair[0]} × 高 {pair[1]} 像素，绝对不要输出正方形（1:1）。"
        f" Generate a {en_shape} image with aspect ratio "
        f"{fraction.numerator}:{fraction.denominator}, target size {pair[0]}x{pair[1]} pixels "
        "(width x height). Never output a square 1:1 image. Do not swap width and height."
    )


def _payload_root(payload: object) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    for key in ("data", "result"):
        nested = payload.get(key)
        if isinstance(nested, dict) and any(
            marker in nested for marker in ("status", "task_status", "images", "output")
        ):
            return nested
    return payload


def _status(payload: object) -> str:
    root = _payload_root(payload)
    return str(root.get("status") or root.get("task_status") or "").strip().lower()


def _task_id(payload: object) -> str:
    if not isinstance(payload, dict):
        return ""
    candidates = [payload, payload.get("data"), payload.get("result")]
    for item in candidates:
        if not isinstance(item, dict):
            continue
        value = item.get("task_id") or item.get("taskId") or item.get("submit_id")
        if value is None and _status(item) in _PENDING:
            value = item.get("id")
        if value:
            return str(value).strip()
    return ""


def _usage(payload: object) -> dict[str, Any] | None:
    if not isinstance(payload, dict):
        return None
    for item in (payload, payload.get("data"), payload.get("result")):
        if isinstance(item, dict) and isinstance(item.get("usage"), dict):
            return dict(item["usage"])
    return None


def _model(payload: object) -> str | None:
    if not isinstance(payload, dict):
        return None
    for item in (payload, payload.get("data"), payload.get("result")):
        if isinstance(item, dict) and item.get("model"):
            return str(item["model"])
    return None


def _string_image(value: str, *, assume_base64: bool = False) -> tuple[str, str] | None:
    text = value.strip()
    if not text:
        return None
    match = _DATA_URL.match(text)
    if match is not None:
        return "base64", match.group(1)
    if text.startswith(("http://", "https://")):
        return "url", text
    markdown = _MARKDOWN_IMAGE.search(text)
    if markdown is not None:
        return "url", markdown.group(1)
    plain = _PLAIN_IMAGE_URL.search(text)
    if plain is not None:
        return "url", plain.group(0)
    if assume_base64 or (len(text) > 128 and re.fullmatch(r"[A-Za-z0-9+/=\r\n]+", text)):
        return "base64", text
    return None


def _image_values(payload: object) -> list[tuple[str, str]]:
    found: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()

    def add(item: tuple[str, str] | None) -> None:
        if item is not None and item not in seen:
            seen.add(item)
            found.append(item)

    def walk(value: object, depth: int = 0, context: str = "") -> None:
        if depth > 8 or len(found) >= 20:
            return
        if isinstance(value, list):
            for item in value:
                walk(item, depth + 1, context)
            return
        if isinstance(value, str):
            add(_string_image(value, assume_base64=context in {"b64_json", "result", "image_b64"}))
            return
        if not isinstance(value, dict):
            return
        kind = str(value.get("type") or "").lower()
        for key, item in value.items():
            lowered = str(key).lower()
            if lowered in {"b64_json", "image_b64", "partial_image_b64"}:
                if isinstance(item, str):
                    add(_string_image(item, assume_base64=True))
                continue
            if lowered == "result" and "image" in kind and isinstance(item, str):
                add(_string_image(item, assume_base64=True))
                continue
            if lowered in {"url", "output_url"} and isinstance(item, str):
                add(_string_image(item))
                continue
            if lowered == "image_url":
                if isinstance(item, dict):
                    add(_string_image(str(item.get("url") or "")))
                elif isinstance(item, str):
                    add(_string_image(item))
                continue
            walk(item, depth + 1, lowered)

    walk(payload)
    return found


async def _download(client: httpx.AsyncClient, value: tuple[str, str]) -> bytes:
    kind, raw = value
    if kind == "base64":
        try:
            return base64.b64decode(raw, validate=False)
        except (binascii.Error, ValueError) as exc:
            raise ProtocolImageError("api", "上游返回的图片 base64 无效") from exc
    response = await client.get(raw)
    if response.status_code >= 400:
        raise ProtocolImageError("api", f"下载上游图片失败：HTTP {response.status_code}")
    return response.content


def _error_detail(payload: object) -> str:
    if isinstance(payload, dict):
        root = _payload_root(payload)
        error = root.get("error")
        if isinstance(error, dict):
            detail = error.get("message") or error.get("detail") or error.get("code")
            if detail:
                return str(detail)[:500]
        for key in ("fail_reason", "message", "detail", "output_text"):
            if root.get(key):
                return str(root[key])[:500]
    return json.dumps(payload, ensure_ascii=False, default=str)[:500]


async def _json_response(response: httpx.Response) -> dict[str, Any]:
    try:
        payload = response.json()
    except ValueError as exc:
        raise ProtocolImageError(
            "api", f"上游返回非 JSON 响应：HTTP {response.status_code} {response.text[:200]}"
        ) from exc
    if response.status_code in {401, 403}:
        raise ProtocolImageError("auth", f"上游拒绝鉴权：HTTP {response.status_code}")
    if response.status_code >= 400:
        raise ProtocolImageError(
            "api", f"上游返回 HTTP {response.status_code}：{_error_detail(payload)}"
        )
    if not isinstance(payload, dict):
        raise ProtocolImageError("api", "上游响应不是 JSON 对象")
    return payload


async def _responses_stream(
    client: httpx.AsyncClient,
    url: str,
    headers: dict[str, str],
    body: dict[str, Any],
) -> dict[str, Any]:
    stream_body = {**body, "stream": True}
    try:
        async with client.stream("POST", url, headers=headers, json=stream_body) as response:
            if response.status_code in {400, 404, 405, 415, 422}:
                await response.aread()
                return await _json_response(await client.post(url, headers=headers, json=body))
            if response.status_code >= 400:
                content = await response.aread()
                raise ProtocolImageError(
                    "api",
                    f"Responses 流式请求失败：HTTP {response.status_code} {content[:200]!r}",
                )
            completed: dict[str, Any] | None = None
            images: list[dict[str, Any]] = []
            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue
                raw = line[5:].strip()
                if not raw or raw == "[DONE]":
                    continue
                try:
                    event = json.loads(raw)
                except ValueError:
                    continue
                if not isinstance(event, dict):
                    continue
                if event.get("type") in {
                    "response.completed",
                    "response.incomplete",
                } and isinstance(event.get("response"), dict):
                    completed = event["response"]
                for kind, value in _image_values(event):
                    images.append(
                        {"type": "image_generation_call", "result": value}
                        if kind == "base64"
                        else {"type": "image", "image_url": value}
                    )
            if completed is None:
                completed = {"status": "completed", "output": []}
            if images and not _image_values(completed):
                completed = {
                    **completed,
                    "output": [*(completed.get("output") or []), *images],
                }
            return completed
    except httpx.HTTPError:
        return await _json_response(await client.post(url, headers=headers, json=body))


async def _responses_submit(
    client: httpx.AsyncClient,
    url: str,
    headers: dict[str, str],
    body: dict[str, Any],
) -> dict[str, Any]:
    try:
        response = await client.post(url, headers=headers, json={**body, "background": True})
    except httpx.HTTPError:
        return await _responses_stream(client, url, headers, body)
    if response.status_code in {400, 404, 405, 415, 422}:
        return await _responses_stream(client, url, headers, body)
    return await _json_response(response)


async def _poll(
    client: httpx.AsyncClient,
    *,
    payload: dict[str, Any],
    url: str,
    headers: dict[str, str],
    interval: float,
    initial_delay: float,
    timeout: float,
) -> dict[str, Any]:
    current = payload
    deadline = time.monotonic() + timeout
    if initial_delay > 0:
        await asyncio.sleep(min(initial_delay, max(0.0, deadline - time.monotonic())))
    while time.monotonic() < deadline:
        state = _status(current)
        if _image_values(current) and state not in _FAILED:
            return current
        if state in _SUCCESS:
            return current
        if state in _FAILED:
            raise ProtocolImageError("api", f"生图任务失败：{_error_detail(current)}")
        await asyncio.sleep(min(interval, max(0.0, deadline - time.monotonic())))
        current = await _json_response(await client.get(url, headers=headers))
    raise ProtocolImageError("timeout", f"生图任务超过 {int(timeout)} 秒仍未完成")


async def render(
    *,
    route: ResolvedModelRoute,
    prompt: str,
    size: str,
    quality: str,
    n: int,
    images: list[tuple[str, bytes]],
) -> ProtocolImageResult:
    mode = image_request_mode(route)
    if mode == "openai":
        raise ProtocolImageError("binding", "标准 OpenAI 图片协议应由 SDK 执行")
    try:
        base = openai_base(route.credential_config, route.provider_type)
    except CredentialError as exc:
        raise ProtocolImageError("binding", str(exc)) from exc
    options = dict(route.protocol_options)
    headers = _headers(route)
    default_timeout = 1800 if mode in {"apimart", "tudou-async"} else 1500
    default_interval = (
        5 if mode in {"apimart", "openai-responses"} else 4 if mode == "tudou-async" else 2
    )
    default_initial_delay = 10 if mode == "apimart" else 12 if mode == "tudou-async" else 0
    timeout = max(1.0, min(float(options.get("task_timeout") or default_timeout), 1800.0))
    interval = max(0.05, min(float(options.get("poll_interval") or default_interval), 30.0))
    configured_initial_delay = options.get("initial_poll_delay", default_initial_delay)
    if configured_initial_delay is None:
        configured_initial_delay = default_initial_delay
    initial_delay = max(0.0, min(float(configured_initial_delay), 60.0))
    refs = [_data_url(name, data) for name, data in images[:20]]
    started = time.monotonic()
    try:
        async with routed_http_client(
            timeout=httpx.Timeout(connect=20.0, read=timeout, write=120.0, pool=20.0),
            follow_redirects=False,
        ) as client:
            if mode == "openai-json":
                url = _endpoint(base, options, "generation_path", "/images/generations")
                extra_body: dict[str, Any] = {"response_format": "url"}
                if refs:
                    extra_body["image"] = refs
                payload = await _json_response(
                    await client.post(
                        url,
                        headers=headers,
                        json={
                            "model": route.upstream_model_id,
                            "prompt": prompt,
                            "size": size,
                            "extra_body": extra_body,
                        },
                    )
                )
            elif mode == "openai-responses":
                url = _endpoint(base, options, "responses_path", "/responses")
                tool: dict[str, Any] = {
                    "type": "image_generation",
                    "action": "edit" if refs else "generate",
                    "quality": quality,
                }
                if size.lower() != "auto":
                    tool["size"] = _responses_size(size)
                instruction = _responses_size_instruction(size)
                content: list[dict[str, Any]] = [
                    {
                        "type": "input_text",
                        "text": f"{instruction}\n\n{prompt}" if instruction else prompt,
                    }
                ]
                content.extend({"type": "input_image", "image_url": value} for value in refs)
                payload = await _responses_submit(
                    client,
                    url,
                    headers,
                    {
                        "model": route.upstream_model_id,
                        "input": [{"role": "user", "content": content}],
                        "tools": [tool],
                        "tool_choice": {"type": "image_generation"},
                    },
                )
            elif mode == "openai-video-proxy":
                url = _endpoint(base, options, "video_proxy_path", "/videos")
                body = {
                    "model": route.upstream_model_id,
                    "prompt": prompt,
                    "aspect_ratio": _ratio(size),
                }
                if images:
                    files = [("images", (name, data, _mime(name))) for name, data in images[:6]]
                    payload = await _json_response(
                        await client.post(url, headers=headers, data=body, files=files)
                    )
                else:
                    payload = await _json_response(
                        await client.post(url, headers=headers, json=body)
                    )
            elif mode == "tudou-async":
                url = _endpoint(base, options, "generation_path", "/images/generations/async")
                body = {
                    "model": "gpt-image-2-all",
                    "prompt": prompt,
                    "size": size if _size_pair(size) is not None else _ratio(size),
                    "resolution": _tudou_resolution(size, route.upstream_model_id),
                    "quality": quality,
                }
                if refs:
                    body["images"] = refs
                payload = await _json_response(await client.post(url, headers=headers, json=body))
            else:  # APIMart adapter
                url = _endpoint(base, options, "generation_path", "/images/generations")
                body = {
                    "model": route.upstream_model_id,
                    "prompt": prompt,
                    "n": 1,
                    "size": _ratio(size),
                    "resolution": _resolution(size),
                    "official_fallback": False,
                }
                if refs:
                    body["image_urls"] = refs
                payload = await _json_response(await client.post(url, headers=headers, json=body))

            values = _image_values(payload)
            task_id = _task_id(payload)
            if not values and task_id:
                default_template = (
                    "/videos/{task_id}"
                    if mode == "openai-video-proxy"
                    else "/responses/{task_id}"
                    if mode == "openai-responses"
                    else "/tasks/{task_id}"
                )
                template = str(options.get("task_path_template") or default_template)
                task_path = template.replace("{task_id}", task_id)
                payload = await _poll(
                    client,
                    payload=payload,
                    url=_endpoint(base, {}, "task", task_path),
                    headers=headers,
                    interval=interval,
                    initial_delay=initial_delay,
                    timeout=timeout,
                )
                values = _image_values(payload)
            if not values:
                raise ProtocolImageError(
                    "api", f"{mode} 没有返回可用图片：{_error_detail(payload)}"
                )
            output = [await _download(client, value) for value in values[:n]]
    except httpx.TimeoutException as exc:
        raise ProtocolImageError("timeout", f"{mode} 图片请求超时") from exc
    except httpx.HTTPError as exc:
        raise ProtocolImageError("connect", f"{mode} 图片请求失败：{exc}") from exc
    return ProtocolImageResult(
        images=output,
        usage=_usage(payload),
        model_reported=_model(payload) or route.upstream_model_id,
        latency_ms=int((time.monotonic() - started) * 1000),
    )
