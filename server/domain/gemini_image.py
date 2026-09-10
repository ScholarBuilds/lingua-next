"""Google Gemini 原生图片 REST adapter。

Gemini 的图片接口不是 OpenAI ``/images`` 协议：文生图和参考图编辑
都走 ``models/{model}:generateContent``，图片以 content part 传入/返回。
这个模块只负责上游协议；能力绑定、持久任务和资产入库仍由创作工坊共享层处理。
"""

from __future__ import annotations

import base64
import math
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote

import httpx

from domain.credentials import CredentialError, gemini_base
from domain.image_prompts import is_auto_size, parse_size
from domain.network_policy import routed_http_client

GEMINI_TIMEOUT_S = 240.0

# Gemini 图片模型的公共安全交集。新模型可通过 protocol_options
# 的 gemini_aspect_ratios 扩展，不在业务层猜一个上游未声明支持的比例。
DEFAULT_ASPECT_RATIOS = (
    "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9",
)


class GeminiImageError(Exception):
    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind


@dataclass
class GeminiImageResult:
    images: list[bytes]
    model_reported: str | None = None
    usage: dict[str, Any] | None = None
    latency_ms: int = 0
    revised_prompts: list[str] = field(default_factory=list)


def _mime_type(name: str, data: bytes) -> str:
    lowered = name.lower()
    if data.startswith(b"\x89PNG\r\n\x1a\n") or lowered.endswith(".png"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff") or lowered.endswith((".jpg", ".jpeg")):
        return "image/jpeg"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP" or lowered.endswith(".webp"):
        return "image/webp"
    return "image/png"


def _ratio_value(raw: str) -> float:
    left, sep, right = raw.partition(":")
    if not sep:
        return 1.0
    try:
        return float(left) / float(right)
    except (TypeError, ValueError, ZeroDivisionError):
        return 1.0


def nearest_aspect_ratio(size: str, options: dict[str, Any] | None = None) -> str:
    width, height = parse_size(size)
    configured = (options or {}).get("gemini_aspect_ratios")
    allowed = (
        tuple(str(item) for item in configured if str(item).strip())
        if isinstance(configured, list) and configured
        else DEFAULT_ASPECT_RATIOS
    )
    target = width / height
    # 在对数域比较，让横竖比例的距离对称。
    return min(allowed, key=lambda raw: abs(math.log(max(_ratio_value(raw), 1e-6) / target)))


def image_size_tier(size: str) -> str:
    width, height = parse_size(size)
    longest = max(width, height)
    if longest <= 1536:
        return "1K"
    if longest <= 2560:
        return "2K"
    return "4K"


def _supports_image_size(model: str, options: dict[str, Any]) -> bool:
    override = options.get("gemini_supports_image_size")
    if isinstance(override, bool):
        return override
    lowered = model.lower()
    return "gemini-3" in lowered or "gemini-4" in lowered


def _generation_config(
    model: str,
    size: str,
    options: dict[str, Any],
) -> dict[str, Any]:
    """画幅「自动」时整个 imageConfig 都不下发，让模型自己判断比例。

    这条分支不是可选的：`nearest_aspect_ratio` 走 `parse_size`，
    而 `parse_size("auto")` 会抛 —— 没有它，任何绑到 Gemini adapter 的
    画布节点一选「画幅自动」就是 500。
    """
    pinned_ratio = options.get("gemini_aspect_ratio")
    if is_auto_size(size) and not pinned_ratio:
        return {"responseModalities": ["TEXT", "IMAGE"]}
    aspect_ratio = pinned_ratio or nearest_aspect_ratio(size, options)
    image_config: dict[str, Any] = {"aspectRatio": str(aspect_ratio)}
    if _supports_image_size(model, options):
        pinned_tier = options.get("gemini_image_size")
        tier = pinned_tier or (None if is_auto_size(size) else image_size_tier(size))
        if tier:
            image_config["imageSize"] = str(tier).upper()
    return {
        "responseModalities": ["TEXT", "IMAGE"],
        "imageConfig": image_config,
    }


def _request_parts(prompt: str, images: list[tuple[str, bytes]]) -> list[dict[str, Any]]:
    parts: list[dict[str, Any]] = [{"text": prompt}]
    parts.extend(
        {
            "inline_data": {
                "mime_type": _mime_type(name, data),
                "data": base64.b64encode(data).decode("ascii"),
            }
        }
        for name, data in images
    )
    return parts


def _response_error(status: int, detail: str) -> GeminiImageError:
    message = detail[:300] or "上游未返回错误详情"
    lowered = message.lower()
    if status in (401, 403):
        return GeminiImageError("auth", f"Gemini 拒绝鉴权（HTTP {status}）：{message}")
    if status == 404:
        return GeminiImageError("binding", f"Gemini 模型不存在（HTTP 404）：{message}")
    if status == 429:
        return GeminiImageError("api", f"Gemini 频率或配额受限（HTTP 429）：{message}")
    if status == 400 and any(word in lowered for word in ("safety", "blocked", "policy")):
        return GeminiImageError("content", f"Gemini 安全策略拒绝了请求：{message}")
    return GeminiImageError("api", f"Gemini 返回 HTTP {status}：{message}")


def _extract_response(payload: dict[str, Any]) -> tuple[list[bytes], list[str], dict | None]:
    images: list[bytes] = []
    texts: list[str] = []
    for candidate in payload.get("candidates") or []:
        if not isinstance(candidate, dict):
            continue
        content = candidate.get("content") or {}
        for part in content.get("parts") or []:
            if not isinstance(part, dict):
                continue
            text = part.get("text")
            if isinstance(text, str) and text.strip():
                texts.append(text.strip())
            inline = part.get("inlineData") or part.get("inline_data")
            if not isinstance(inline, dict) or not inline.get("data"):
                continue
            try:
                images.append(base64.b64decode(str(inline["data"]), validate=True))
            except (ValueError, TypeError) as exc:
                raise GeminiImageError("api", "Gemini 返回了无效的图片 base64") from exc
    usage = payload.get("usageMetadata") or payload.get("usage_metadata")
    return images, texts, usage if isinstance(usage, dict) else None


def _merge_usage(total: dict[str, Any], current: dict | None) -> None:
    for key, value in (current or {}).items():
        if isinstance(value, int) and isinstance(total.get(key, 0), int):
            total[key] = int(total.get(key, 0)) + value
        elif key not in total:
            total[key] = value


async def generate(
    prompt: str,
    *,
    model: str,
    credential_config: dict[str, Any],
    protocol_options: dict[str, Any] | None,
    size: str,
    n: int,
    images: list[tuple[str, bytes]] | None = None,
) -> GeminiImageResult:
    """调用原生 generateContent。

    Gemini 没有 OpenAI images API 的 ``n`` 参数等价语义；为了维持工作台
    1~4 张候选的契约，n>1 时显式执行多次独立请求。
    """
    options = dict(protocol_options or {})
    try:
        base = gemini_base(credential_config)
    except CredentialError as exc:
        raise GeminiImageError("binding", str(exc)) from exc
    api_key = str(credential_config.get("api_key") or "").strip()
    if not api_key:
        raise GeminiImageError("auth", "Gemini API Key 未配置")
    model_id = str(model).removeprefix("models/").strip()
    if not model_id:
        raise GeminiImageError("binding", "Gemini 真实模型名为空")
    endpoint = f"{base}/models/{quote(model_id, safe='')}:generateContent"
    body = {
        "contents": [{"role": "user", "parts": _request_parts(prompt, images or [])}],
        "generationConfig": _generation_config(model_id, size, options),
    }
    started = time.monotonic()
    output: list[bytes] = []
    revised: list[str] = []
    usage: dict[str, Any] = {}
    try:
        async with routed_http_client(
            timeout=GEMINI_TIMEOUT_S,
        ) as client:
            for _ in range(n):
                response = await client.post(
                    endpoint,
                    headers={"x-goog-api-key": api_key, "Content-Type": "application/json"},
                    json=body,
                )
                if response.status_code >= 400:
                    try:
                        error_body = response.json()
                        upstream_error = (error_body.get("error") or {}).get("message")
                        detail = str(upstream_error or response.text)
                    except (ValueError, AttributeError):
                        detail = response.text
                    raise _response_error(response.status_code, detail)
                try:
                    decoded = response.json()
                except ValueError as exc:
                    raise GeminiImageError("api", "Gemini 返回了非 JSON 结果") from exc
                batch, texts, current_usage = _extract_response(decoded)
                if not batch:
                    reason = str(decoded.get("promptFeedback") or "")[:220]
                    raise GeminiImageError(
                        "content" if reason else "api",
                        f"Gemini 没有返回图片{f'：{reason}' if reason else ''}",
                    )
                output.extend(batch)
                revised.extend(texts)
                _merge_usage(usage, current_usage)
    except GeminiImageError:
        raise
    except httpx.TimeoutException as exc:
        raise GeminiImageError(
            "timeout", f"Gemini 生图超时（{int(GEMINI_TIMEOUT_S)}s）"
        ) from exc
    except httpx.HTTPError as exc:
        raise GeminiImageError("connect", f"连不上 Gemini：{exc}") from exc
    return GeminiImageResult(
        images=output,
        model_reported=model_id,
        usage=usage or None,
        latency_ms=int((time.monotonic() - started) * 1000),
        revised_prompts=revised,
    )
