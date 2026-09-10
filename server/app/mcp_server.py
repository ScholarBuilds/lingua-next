"""工具箱的 MCP 出口（调研 §5.6）：把 operation 注册表投影成 streamable-http 工具清单。

dsh、Claude Code、Codex 经这条 /mcp 端点调用 lingua 的能力，画布与 REST 继续直调。
**这里不留第二份合同**：工具清单来自 :func:`domain.tool_execution.list_operations`，
入参 schema 是 ``spec.input.model_json_schema()`` 的原样投影，校验、建任务、入队全部
交给 :func:`domain.tool_execution.start_tool_operation`。新接一个 operation，MCP 清单
自动多一项，本文件不用改。

长任务拆两个工具：``<operation>_submit`` 返回 task_id，``task_wait`` 轮询到终态；
准备阶段就已终态的能力（如 flow.resume）由 submit 直接同步返回完整结果。
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import secrets
from collections.abc import AsyncIterator, Callable, Mapping
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from copy import deepcopy
from typing import Any

import mcp_types as types
from fastapi import FastAPI
from mcp.server.lowlevel import Server
from mcp.server.streamable_http_manager import (
    StreamableHTTPASGIApp,
    StreamableHTTPSessionManager,
)
from mcp.server.transport_security import TransportSecuritySettings
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.types import ASGIApp, Receive, Scope, Send

from app.config import get_settings
from domain import canvas_projector, tool_plugins
from domain.kernel.tool_runtime import TypedRef
from domain.model_invocations import invocation_context, safe_payload
from domain.models import StudioTask
from domain.studio_tasks import TERMINAL_STATUSES, task_view
from domain.tool_execution import (
    ToolExecutionError,
    ToolOperationSpec,
    list_operations,
    parse_tool_operation_input,
    start_tool_operation,
)

logger = logging.getLogger(__name__)

SERVER_NAME = "lingua-studio"
SUBMIT_SUFFIX = "_submit"
SOURCE = "mcp"

# 只做分流、自己不落任务的能力：任务类型属于被分流到的能力（image.generate /
# image.edit），照样能经 start_tool_operation 入队，所以要投影出去。
ROUTER_OPERATIONS = frozenset({"image.auto"})

# 插件状态的优先级：同一能力被多个插件声明时，挑真正接线好的那个当台账归属
_STATUS_RANK = {"ready": 0, "partial": 1, "planned": 2}

_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"})
_INTERNAL_TOKEN = secrets.token_urlsafe(32)
# Host / Origin 只认回环（DNS rebinding 防护）；门代理与工作台出口共用这两张表
ALLOWED_HOSTS: tuple[str, ...] = ("127.0.0.1:*", "localhost:*", "[::1]:*")
ALLOWED_ORIGINS: tuple[str, ...] = (
    "http://127.0.0.1:*",
    "http://localhost:*",
    "http://[::1]:*",
)

_SERVER_INSTRUCTIONS = (
    "lingua 创作工坊的工具出口。<operation>_submit 提交一次调用并返回 task_id，"
    "task_wait 等它到终态，task_status 只读快照，list_capabilities 列出全部能力与合同。"
    "产物以 TypedRef（asset:N / media:N / text:<task_id>）返回，不内联字节。"
)

_SUBMIT_OUTPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["task_id", "operation", "status", "terminal"],
    "properties": {
        "task_id": {"type": "string"},
        "operation": {"type": "string"},
        "tool_id": {"type": "string"},
        "status": {"type": "string"},
        "terminal": {"type": "boolean"},
        "task": {"type": "object"},
        "artifacts": {"type": "array"},
    },
    "additionalProperties": True,
}

_TASK_OUTPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["task_id", "status", "terminal"],
    "properties": {
        "task_id": {"type": "string"},
        "status": {"type": "string"},
        "terminal": {"type": "boolean"},
        "timed_out": {"type": "boolean"},
        "task": {"type": "object"},
        "artifacts": {"type": "array"},
    },
    "additionalProperties": True,
}


class McpToolError(ValueError):
    """工具调用层面的失败：作为 is_error 结果回给模型，不升级成协议错误。"""


# ---- 会话与队列（测试按需替换这两个接缝） ----


@asynccontextmanager
async def session_scope() -> AsyncIterator[AsyncSession]:
    """MCP 的请求不经 FastAPI 依赖，自己开会话；测试把它指到内存库。"""
    from app.db import SessionFactory

    async with SessionFactory() as session:
        yield session


async def acquire_queue() -> Any:
    from app.queue import get_queue

    return await get_queue()


# ---- 注册表投影 ----


def default_plugin_for(operation: str) -> str | None:
    """哪个工具插件为这次调用背书：优先已就绪的，同档按 id 稳定排序。"""
    candidates = [
        item
        for item in tool_plugins.list_tool_plugins()
        if operation in item["capabilities"]
    ]
    if not candidates:
        return None
    candidates.sort(key=lambda item: (_STATUS_RANK.get(item["status"], 9), item["id"]))
    return str(candidates[0]["id"])


def is_dispatchable(spec: ToolOperationSpec) -> bool:
    """能不能走完「建任务 → 入队」。

    没声明 task_types 又不是分流器的能力（M62 遗留的 flow.run / flow.resume），
    引擎内部自己 prepare 自己入队，外部入口会卡在 queue_call_for；投影出去就是一个
    调不通的工具，宁可不列。补上 task_types 后这里自动放行。
    """
    return bool(spec.task_types) or spec.operation in ROUTER_OPERATIONS


def projected_operations() -> list[tuple[ToolOperationSpec, str]]:
    """(能力, 归属插件) 列表：没有插件声明或无法分派的能力不出现在 MCP 清单里。"""
    projected: list[tuple[ToolOperationSpec, str]] = []
    for spec in list_operations():
        if not is_dispatchable(spec):
            continue
        plugin_id = default_plugin_for(spec.operation)
        if plugin_id is None:
            continue
        projected.append((spec, plugin_id))
    return projected


def submit_tool_name(operation: str) -> str:
    """image.generate → image_generate_submit（MCP 工具名不收点号）。"""
    return re.sub(r"[^a-zA-Z0-9_-]+", "_", operation) + SUBMIT_SUFFIX


def _submit_tool(spec: ToolOperationSpec, plugin_id: str) -> types.Tool:
    plugin = tool_plugins.get_tool_plugin(plugin_id)
    return types.Tool(
        name=submit_tool_name(spec.operation),
        title=f"{plugin.label} · {spec.operation}",
        description=(
            f"提交一次 {spec.operation} 调用（归属工具：{plugin.label}）。{plugin.hint}。"
            f"返回 task_id；未终态时用 task_wait 等结果。恢复策略：{spec.resume_policy}。"
        ),
        input_schema=deepcopy(spec.input_schema),
        output_schema=deepcopy(_SUBMIT_OUTPUT_SCHEMA),
    )


def tool_catalog() -> list[types.Tool]:
    settings = get_settings()
    tools = [_submit_tool(spec, plugin_id) for spec, plugin_id in projected_operations()]
    tools.append(
        types.Tool(
            name="task_wait",
            title="等待任务终态",
            description=(
                "按 task_id 轮询到 succeeded / partial / failed / cancelled 或超时。"
                "超时只是没等到，任务还在跑，可以继续等。"
            ),
            input_schema={
                "type": "object",
                "required": ["task_id"],
                "properties": {
                    "task_id": {"type": "string", "minLength": 1, "maxLength": 64},
                    "timeout_s": {
                        "type": "number",
                        "minimum": 0,
                        "maximum": settings.mcp_wait_max_timeout,
                        "description": f"默认 {settings.mcp_wait_timeout} 秒",
                    },
                },
                "additionalProperties": False,
            },
            output_schema=deepcopy(_TASK_OUTPUT_SCHEMA),
        )
    )
    tools.append(
        types.Tool(
            name="task_status",
            title="任务快照",
            description="只读：按 task_id 取一次任务视图与已产出的 TypedRef，不等待。",
            input_schema={
                "type": "object",
                "required": ["task_id"],
                "properties": {"task_id": {"type": "string", "minLength": 1, "maxLength": 64}},
                "additionalProperties": False,
            },
            output_schema=deepcopy(_TASK_OUTPUT_SCHEMA),
        )
    )
    tools.append(
        types.Tool(
            name="list_capabilities",
            title="能力清单",
            description="列出本服务投影出来的全部 operation、归属插件与输入输出合同。",
            input_schema={"type": "object", "properties": {}, "additionalProperties": False},
            output_schema={
                "type": "object",
                "required": ["operations"],
                "properties": {"operations": {"type": "array"}},
                "additionalProperties": True,
            },
        )
    )
    return tools


def capabilities_view() -> dict[str, Any]:
    operations = []
    for spec, plugin_id in projected_operations():
        plugin = tool_plugins.get_tool_plugin(plugin_id)
        contract = spec.contract()
        operations.append(
            {
                "operation": spec.operation,
                "submit_tool": submit_tool_name(spec.operation),
                "tool_id": plugin.id,
                "tool_label": plugin.label,
                "tool_status": plugin.status,
                "task_types": sorted(spec.task_types),
                "resume_policy": spec.resume_policy,
                "input_schema": contract["input_schema"],
                "output_schema": contract["output_schema"],
            }
        )
    return {"server": SERVER_NAME, "operations": operations}


# ---- 产物投影 ----


def task_artifacts(task: StudioTask) -> list[dict[str, Any]]:
    """任务产物 → TypedRef 列表，复用画布 projector 的同一份解析口径。"""
    refs: list[TypedRef] = []
    node_type = canvas_projector.task_node_type(task.task_type or "")
    items = canvas_projector.task_items(task, node_type) if node_type else []
    for item in items:
        kind = str(item.get("kind") or "image")
        if kind not in canvas_projector.MEDIA_ITEM_KINDS:
            continue
        asset_id = item.get("asset_id")
        media_asset_id = item.get("media_asset_id")
        if isinstance(asset_id, int):
            refs.append(TypedRef(kind="image", ref=f"asset:{asset_id}", asset_id=asset_id))
        elif isinstance(media_asset_id, int):
            refs.append(
                TypedRef(
                    kind=kind,  # type: ignore[arg-type]
                    ref=f"media:{media_asset_id}",
                    media_asset_id=media_asset_id,
                )
            )
    result = task.result if isinstance(task.result, dict) else {}
    if isinstance(result.get("text"), str) and result["text"].strip():
        refs.append(TypedRef(kind="text", ref=f"text:{task.id}"))
    return [ref.model_dump() for ref in refs]


def task_payload(task: StudioTask, **extra: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "task_id": task.id,
        "status": task.status,
        "terminal": task.status in TERMINAL_STATUSES,
        "task": task_view(task),
        "artifacts": task_artifacts(task),
    }
    payload.update(extra)
    return safe_payload(payload)


# ---- 工具实现 ----


def _client_label(ctx: Any) -> str:
    """把 MCP 客户端名字压成台账里能查的 slug；认不出就记 unknown。"""
    params = getattr(getattr(ctx, "session", None), "client_params", None)
    info = getattr(params, "client_info", None)
    raw = str(getattr(info, "name", "") or "").strip()
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", raw).strip("-")[:48]
    return slug or "unknown"


async def submit_operation(
    operation: str,
    plugin_id: str,
    arguments: Mapping[str, Any],
    *,
    client: str,
) -> dict[str, Any]:
    body = parse_tool_operation_input(operation, dict(arguments))
    source_route = f"{SOURCE}:{client}"
    async with session_scope() as session:
        queue = await acquire_queue()
        with invocation_context(source=SOURCE, source_route=source_route, tool_id=plugin_id):
            result = await start_tool_operation(
                session,
                queue,
                tool_id=plugin_id,
                operation=operation,
                body=body,
                source_route=source_route,
                source_context={"source": SOURCE, "client": client},
            )
        payload = task_payload(result.task, operation=operation, tool_id=plugin_id)
    if result.image_job_id is not None:
        payload["image_job_id"] = result.image_job_id
    return payload


async def _load_task(task_id: str) -> StudioTask:
    async with session_scope() as session:
        task = await session.get(StudioTask, task_id)
        if task is None:
            raise McpToolError(f"任务不存在：{task_id}")
        return task


async def task_status(task_id: str) -> dict[str, Any]:
    return task_payload(await _load_task(task_id))


async def task_wait(task_id: str, timeout_s: float | None = None) -> dict[str, Any]:
    settings = get_settings()
    limit = settings.mcp_wait_timeout if timeout_s is None else float(timeout_s)
    limit = max(0.0, min(limit, settings.mcp_wait_max_timeout))
    interval = max(0.05, settings.mcp_poll_interval)
    loop = asyncio.get_running_loop()
    deadline = loop.time() + limit
    while True:
        task = await _load_task(task_id)
        if task.status in TERMINAL_STATUSES:
            return task_payload(task, timed_out=False)
        if loop.time() >= deadline:
            return task_payload(task, timed_out=True)
        await asyncio.sleep(min(interval, max(0.0, deadline - loop.time())))


# ---- MCP 协议处理器 ----


async def _on_list_tools(_ctx: Any, _params: Any) -> types.ListToolsResult:
    return types.ListToolsResult(tools=tool_catalog())


def _ok(payload: dict[str, Any]) -> types.CallToolResult:
    text = json.dumps(payload, ensure_ascii=False, default=str)
    return types.CallToolResult(
        content=[types.TextContent(text=text)],
        structured_content=payload,
    )


def _fail(message: str) -> types.CallToolResult:
    safe = str(safe_payload(message))
    return types.CallToolResult(content=[types.TextContent(text=safe)], is_error=True)


async def _dispatch(ctx: Any, name: str, arguments: Mapping[str, Any]) -> dict[str, Any]:
    if name == "list_capabilities":
        return capabilities_view()
    if name == "task_status":
        return await task_status(str(arguments.get("task_id") or ""))
    if name == "task_wait":
        raw_timeout = arguments.get("timeout_s")
        return await task_wait(
            str(arguments.get("task_id") or ""),
            None if raw_timeout is None else float(raw_timeout),
        )
    for spec, plugin_id in projected_operations():
        if submit_tool_name(spec.operation) == name:
            return await submit_operation(
                spec.operation, plugin_id, arguments, client=_client_label(ctx)
            )
    raise McpToolError(f"未知工具：{name}")


async def _on_call_tool(ctx: Any, params: types.CallToolRequestParams) -> types.CallToolResult:
    arguments = params.arguments or {}
    try:
        return _ok(await _dispatch(ctx, params.name, arguments))
    except (McpToolError, ToolExecutionError, ValueError) as exc:
        return _fail(f"{params.name} 调用失败：{exc}")
    except Exception as exc:  # noqa: BLE001 - 兜底转成 is_error，别把栈泄给客户端
        logger.exception("MCP 工具执行异常 name=%s", params.name)
        return _fail(f"{params.name} 执行异常：{type(exc).__name__}: {exc}")


def build_server() -> Server:
    return Server(
        SERVER_NAME,
        version=get_settings().version,
        title="lingua 创作工坊",
        instructions=_SERVER_INSTRUCTIONS,
        on_list_tools=_on_list_tools,
        on_call_tool=_on_call_tool,
    )


# ---- 挂载 ----


class LoopbackBearerGuard:
    """回环 + Bearer 双闸：MCP 只服务本机 Agent，其它来源在协议之前就拦掉。"""

    def __init__(self, app: ASGIApp, token: str) -> None:
        self.app = app
        self.token = token

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        client = scope.get("client")
        host = client[0] if client else ""
        if host not in _LOOPBACK_HOSTS:
            await JSONResponse({"detail": "MCP 只接受本机回环请求"}, status_code=403)(
                scope, receive, send
            )
            return
        header = Headers(scope=scope).get("authorization", "")
        if not secrets.compare_digest(header, f"Bearer {self.token}"):
            await JSONResponse(
                {"detail": "MCP 需要 Bearer token"},
                status_code=401,
                headers={"WWW-Authenticate": 'Bearer realm="lingua-mcp"'},
            )(scope, receive, send)
            return
        await self.app(scope, receive, send)


def _transport_security() -> TransportSecuritySettings:
    """DNS rebinding 防护：Host / Origin 只认回环，浏览器页面拿不到这条端点。"""
    return TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=list(ALLOWED_HOSTS),
        allowed_origins=list(ALLOWED_ORIGINS),
    )


def attach_lifespan(
    app: FastAPI, context: Callable[[], AbstractAsyncContextManager[Any]]
) -> None:
    """把一段生命周期接进 app 的 lifespan：先于既有的进入、后于它退出。"""
    previous = app.router.lifespan_context

    @asynccontextmanager
    async def chained(scope_app: Any) -> AsyncIterator[Any]:
        async with context(), previous(scope_app) as state:
            yield state

    app.router.lifespan_context = chained


def mount_guarded_asgi(
    app: FastAPI,
    path: str,
    asgi_app: ASGIApp,
    *,
    token: str,
    lifespan: Callable[[], AbstractAsyncContextManager[Any]] | None = None,
) -> None:
    """在回环地址与 Bearer 校验后挂载 ASGI 应用。"""
    app.router.routes.append(Route(path, endpoint=LoopbackBearerGuard(asgi_app, token)))
    if lifespan is not None:
        attach_lifespan(app, lifespan)


def runtime_mcp_token() -> str:
    """返回内部 MCP 的本机令牌。"""
    return get_settings().mcp_token.strip() or _INTERNAL_TOKEN


def mount_mcp(app: FastAPI, *, internal: bool = False) -> bool:
    """把 MCP 端点挂到既有 FastAPI 上；未配置 token 时不挂载并返回 False。

    ``LINGUA_MCP_TOKEN`` 是唯一开关：不配就没有这条对外出口，工具箱仍可经 REST 与
    画布调用。挂载会把 streamable-http 的会话管理器接进 app 的 lifespan。
    """
    settings = get_settings()
    token = runtime_mcp_token() if internal else settings.mcp_token.strip()
    if not token:
        # uvicorn 默认只给自己的 logger 装 handler，根 logger 是 WARNING，
        # 启动结论用 print 才一定看得见（worker/main.py 同款做法）
        print("MCP 出口未挂载：LINGUA_MCP_TOKEN 未配置；工具箱仍可经 REST 与画布调用")
        return False
    if any(getattr(route, "path", None) == settings.mcp_path for route in app.router.routes):
        print(f"MCP 出口已挂载在 {settings.mcp_path}，跳过重复挂载")
        return True

    manager = StreamableHTTPSessionManager(
        app=build_server(),
        json_response=True,
        security_settings=_transport_security(),
    )
    mount_guarded_asgi(
        app, settings.mcp_path, StreamableHTTPASGIApp(manager), token=token, lifespan=manager.run
    )
    source = "进程内随机令牌" if internal and not settings.mcp_token.strip() else "配置令牌"
    print(
        f"MCP 出口已挂载：{settings.mcp_path}"
        f"（Bearer 鉴权，{source}，仅回环；进程请只监听 127.0.0.1）"
    )
    return True
