"""LLM 能力探针（M5-B3）。

设置页的「测一下」经模型插件层走：按能力绑定解析到真实部署后发一条极短补全，成功
与否都记进 model_invocation 台账（source=probe）。能力没绑定部署时不发请求，
error_type=route，台账留一行 plugin_id=unresolved。

网关那套「别名 CRUD + 健康检查」已随网关退役一并下线（前端没有任何消费者），Chat 侧的
网关适配器也已删除：探针一律直连绑定部署的上游端点。此后代码里再没有「别名」这个概念，
只有能力名（capability）与上游真实模型名（model）两层。
"""

import time
from typing import Any

import httpx
from fastapi import APIRouter
from openai import APIConnectionError, APIStatusError, APITimeoutError
from pydantic import BaseModel, Field

from app.config import get_settings
from domain.model_invocations import ModelInvocationSpan, invocation_context
from domain.model_runtime import ModelRuntimeError, prepare_chat_route

router = APIRouter(prefix="/llm", tags=["llm-probe"])

PROBE_SOURCE = "probe"
PROBE_OPERATION = "chat.complete"
# 探针只要模型证明"能连通、能鉴权、能出字"，提示词越短越省；不限 max_tokens 是因为
# 推理模型会先把预算花在思考上，限太死反而回空内容、误报 empty
PROBE_MESSAGES = [
    {"role": "system", "content": "You are a connectivity probe. Reply with the single word: pong"},
    {"role": "user", "content": "ping"},
]


class ProbeEmpty(Exception):
    """模型正常返回但内容为空：连通和鉴权都没问题，只是没出字。"""


def _usage_dict(resp: Any) -> dict | None:
    usage = getattr(resp, "usage", None)
    if usage is None:
        return None
    if hasattr(usage, "model_dump"):
        return usage.model_dump(exclude_none=True)
    if isinstance(usage, dict):
        return dict(usage)
    return None


def classify_probe_error(exc: BaseException) -> tuple[str, str]:
    """异常 → (error_type, 可展示的错误文本)。

    connect/timeout 来自传输层；auth 是 401/403；其余带状态码的归 status；
    empty 是模型回了空内容；route 是绑定本身解析不出可执行部署。
    """
    if isinstance(exc, ProbeEmpty):
        return "empty", str(exc)
    if isinstance(exc, APITimeoutError | httpx.TimeoutException):
        return "timeout", str(exc)
    if isinstance(exc, APIConnectionError | httpx.ConnectError | httpx.NetworkError):
        return "connect", str(exc)
    if isinstance(exc, APIStatusError):
        kind = "auth" if exc.status_code in (401, 403) else "status"
        return kind, f"HTTP {exc.status_code}: {exc.message}"
    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code
        return ("auth" if code in (401, 403) else "status"), f"HTTP {code}: {exc}"
    if isinstance(exc, ModelRuntimeError):
        return "route", str(exc)
    return "error", f"{type(exc).__name__}: {exc}"


async def probe_route(
    capability: str,
    *,
    deployment_id: int | None = None,
    timeout: float | None = None,
) -> dict:
    """经插件层真实调用一次该能力当前绑定的模型；不抛异常，结果里给分类。"""
    timeout = timeout or get_settings().probe_timeout
    request: dict[str, Any] = {"messages": [dict(m) for m in PROBE_MESSAGES]}
    result: dict[str, Any] = {
        "ok": False,
        "capability": capability,
        "model": None,
        "plugin_id": None,
        "selection_source": None,
        "deployment_id": deployment_id,
        "transport": None,
        "latency_ms": 0,
        "sample": None,
        "usage": None,
        "error_type": None,
        "error": None,
    }
    with invocation_context(source=PROBE_SOURCE):
        try:
            route = await prepare_chat_route(
                capability, PROBE_OPERATION, deployment_id=deployment_id
            )
        except ModelRuntimeError as exc:
            # 路由都解析不出来也要留一行台账，和 domain/llm 的口径一致：
            # 这条没有真实模型可报，model 位落能力名并靠 plugin_id=unresolved 标明
            span = await ModelInvocationSpan(
                plugin_id="unresolved",
                operation=PROBE_OPERATION,
                model=capability,
                capability=capability,
                deployment_id=deployment_id,
                request=request,
            ).start()
            await span.fail(exc)
            result["error_type"], result["error"] = classify_probe_error(exc)
            return result

        snapshot = route.snapshot
        result.update(
            {
                "model": snapshot.model,
                "plugin_id": snapshot.plugin_id,
                "selection_source": snapshot.selection_source,
                "deployment_id": snapshot.deployment_id,
                "transport": snapshot.transport,
            }
        )
        started = time.monotonic()
        try:
            async with route.prepare_call(request, timeout=timeout) as call:
                resp = await call.dispatch(model=snapshot.model, **request)
                choices = getattr(resp, "choices", None) or []
                message = getattr(choices[0], "message", None) if choices else None
                content = (getattr(message, "content", None) or "").strip()
                result["latency_ms"] = int((time.monotonic() - started) * 1000)
                result["model"] = getattr(resp, "model", None) or snapshot.model
                result["usage"] = _usage_dict(resp)
                if not content:
                    empty = ProbeEmpty("模型返回内容为空")
                    await call.fail(empty)
                    result["error_type"], result["error"] = classify_probe_error(empty)
                    return result
                result["sample"] = content[:200]
                await call.succeed(
                    model=result["model"],
                    response={"text": content[:200]},
                    usage=result["usage"],
                    provider_request_id=getattr(resp, "id", None),
                )
        except Exception as exc:
            # prepare_call 的 __aexit__ 已把失败写进台账，这里只做分类
            result["latency_ms"] = int((time.monotonic() - started) * 1000)
            result["error_type"], result["error"] = classify_probe_error(exc)
            return result
    result["ok"] = True
    return result


class TestBody(BaseModel):
    # 装的是能力名（translate-fast 这种），不是模型名。字段名 `alias` 是网关时代
    # 留下的线上契约，前端 api-config.llmTest 还按这个名字发，改名要前后端同步
    alias: str = Field(min_length=1, max_length=128)
    # 指定部署时绕过绑定直接测该部署（设置页"测这个模型"）
    deployment_id: int | None = None


@router.post("/test")
async def test_capability(body: TestBody) -> dict:
    """真实调用一次该能力：绑定到哪个部署就测哪个。

    返回里的 `capability` 是能力名，`model` 是上游真名（优先取响应回报的那个）。
    error_type 区分 connect/timeout/auth/status/empty/route，null 即正常。
    """
    return await probe_route(body.alias, deployment_id=body.deployment_id)
