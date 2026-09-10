"""ModelScope API-Inference 异步图像协议适配器。

ModelScope 的 LLM 是 OpenAI 兼容协议，但 AIGC 图像不是同步
``images.generate``：提交时必须带 ``X-ModelScope-Async-Mode``，拿到
``task_id`` 后再用 ``X-ModelScope-Task-Type: image_generation`` 轮询。
这个差异收在 adapter 里，上层仍只认 ``RenderResult``。
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Any

import httpx

from domain.model_catalog import ResolvedModelRoute
from domain.network_policy import routed_http_client

TIMEOUT_S = 240.0
POLL_INTERVAL_S = 2.0
_TERMINAL_FAILURES = frozenset({"FAILED", "FAIL", "CANCELED", "CANCELLED"})
_ALLOWED_EXTRA = frozenset(
    {
        "negative_prompt",
        "seed",
        "steps",
        "guidance",
        "image_url",
        "loras",
    }
)


class ModelScopeImageError(Exception):
    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind


@dataclass(frozen=True)
class ModelScopeImageResult:
    images: list[bytes]
    latency_ms: int
    task_ids: list[str]


def _base_url(route: ResolvedModelRoute) -> str:
    raw = str(route.credential_config.get("api_base") or "").strip().rstrip("/")
    if not raw:
        raw = "https://api-inference.modelscope.cn/v1"
    return raw if raw.endswith("/v1") else f"{raw}/v1"


def _headers(route: ResolvedModelRoute) -> dict[str, str]:
    token = str(route.credential_config.get("api_key") or "").strip()
    if not token:
        raise ModelScopeImageError("auth", "ModelScope 访问令牌未配置")
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _error_detail(data: Any) -> str:
    if isinstance(data, dict):
        for key in ("message", "error_message", "error", "detail"):
            value = data.get(key)
            if value:
                return str(value)[:500]
    return str(data)[:500]


def _http_error(response: httpx.Response, stage: str) -> ModelScopeImageError:
    try:
        detail = _error_detail(response.json())
    except ValueError:
        detail = response.text[:500]
    kind = "auth" if response.status_code in {401, 403} else "api"
    if response.status_code == 429:
        kind = "quota"
    return ModelScopeImageError(
        kind,
        f"ModelScope {stage}失败（HTTP {response.status_code}）：{detail}",
    )


async def _one(
    client: httpx.AsyncClient,
    *,
    base_url: str,
    headers: dict[str, str],
    payload: dict[str, Any],
    deadline: float,
    poll_interval_s: float,
) -> tuple[bytes, str]:
    response = await client.post(
        f"{base_url}/images/generations",
        headers={**headers, "X-ModelScope-Async-Mode": "true"},
        json=payload,
    )
    if response.status_code >= 400:
        raise _http_error(response, "提交")
    data = response.json()
    task_id = str(data.get("task_id") or "").strip()
    if not task_id:
        raise ModelScopeImageError("api", f"ModelScope 未返回 task_id：{_error_detail(data)}")

    while time.monotonic() < deadline:
        result = await client.get(
            f"{base_url}/tasks/{task_id}",
            headers={**headers, "X-ModelScope-Task-Type": "image_generation"},
        )
        if result.status_code >= 400:
            raise _http_error(result, "轮询")
        state = result.json()
        status = str(state.get("task_status") or state.get("status") or "").upper()
        if status == "SUCCEED":
            urls = state.get("output_images") or state.get("images") or []
            if isinstance(urls, str):
                urls = [urls]
            url = str(urls[0] if urls else "").strip()
            if not url:
                raise ModelScopeImageError(
                    "api", f"ModelScope 任务成功但没有图片：{_error_detail(state)}"
                )
            image = await client.get(url)
            if image.status_code >= 400:
                raise _http_error(image, "下载结果")
            return image.content, task_id
        if status in _TERMINAL_FAILURES:
            raise ModelScopeImageError(
                "provider_failed", f"ModelScope 任务失败：{_error_detail(state)}"
            )
        await asyncio.sleep(poll_interval_s)
    raise ModelScopeImageError("timeout", "ModelScope 生图超时")


async def generate(
    prompt: str,
    *,
    route: ResolvedModelRoute,
    size: str,
    n: int,
    extra: dict[str, Any] | None = None,
    client: httpx.AsyncClient | None = None,
    timeout_s: float = TIMEOUT_S,
    poll_interval_s: float = POLL_INTERVAL_S,
) -> ModelScopeImageResult:
    """提交 n 个独立任务并轮询；ModelScope 协议没有稳定的 ``n`` 语义。"""
    cleaned = prompt.strip()
    if not cleaned:
        raise ModelScopeImageError("input", "ModelScope 提示词不能为空")
    if len(cleaned) > 2_000:
        raise ModelScopeImageError("input", "ModelScope 提示词不能超过 2000 字符")
    if n < 1:
        raise ModelScopeImageError("input", "ModelScope 生成张数至少为 1")
    base_url = _base_url(route)
    headers = _headers(route)
    payload: dict[str, Any] = {
        "model": route.upstream_model_id,
        "prompt": cleaned,
    }
    if size and size != "auto":
        payload["size"] = size
    for key, value in (extra or {}).items():
        if key in _ALLOWED_EXTRA and value is not None:
            payload[key] = value

    owned = client is None
    if client is None:
        client = routed_http_client(
            timeout=timeout_s,
            follow_redirects=True,
        )
    started = time.monotonic()
    deadline = started + timeout_s
    try:
        pairs = await asyncio.gather(
            *(
                _one(
                    client,
                    base_url=base_url,
                    headers=headers,
                    payload=payload,
                    deadline=deadline,
                    poll_interval_s=poll_interval_s,
                )
                for _ in range(n)
            )
        )
    except httpx.TimeoutException as exc:
        raise ModelScopeImageError("timeout", f"ModelScope 请求超时：{exc}") from exc
    except httpx.HTTPError as exc:
        raise ModelScopeImageError("connect", f"无法连接 ModelScope：{exc}") from exc
    finally:
        if owned:
            await client.aclose()
    return ModelScopeImageResult(
        images=[item[0] for item in pairs],
        task_ids=[item[1] for item in pairs],
        latency_ms=int((time.monotonic() - started) * 1000),
    )
