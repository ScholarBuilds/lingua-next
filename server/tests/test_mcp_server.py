"""MCP 出口：清单由 operation 注册表派生，submit → wait 是唯一的长任务合同。

这里验证四件事：投影跟着注册表走（新增能力自动出现、调不通的能力不出现）、
提交与等待的合同、Bearer + 回环双闸、以及回给模型的文本不带密钥。
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from pydantic import BaseModel
from sqlalchemy import select

from app import mcp_server
from app.config import Settings
from domain import tool_plugins
from domain.models import StudioFlow, StudioFlowRun, StudioTask
from domain.studio_flows import create_flow, flow_tick_job_id
from domain.studio_tasks import new_task, transition
from domain.tool_execution import (
    ToolExecutionError,
    ToolOperationSpec,
    ToolQueueCall,
    register_operation,
    require_operation,
    unregister_operation,
)

BASE_URL = "http://127.0.0.1:8100"
TOKEN = "mcp-test-token"


class FakeQueue:
    def __init__(self) -> None:
        self.calls: list[tuple[tuple[Any, ...], dict[str, Any]]] = []

    async def enqueue_job(self, *args: Any, **kwargs: Any) -> None:
        self.calls.append((args, kwargs))


class McpClient:
    """最小 JSON-RPC 客户端：握手一次，之后带着 session id 发请求。"""

    def __init__(self, http: AsyncClient, token: str | None = TOKEN) -> None:
        self.http = http
        self.headers = {
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
        }
        if token is not None:
            self.headers["Authorization"] = f"Bearer {token}"
        self._id = 0

    async def handshake(self, client_name: str = "claude-code") -> None:
        response = await self.http.post(
            "/mcp",
            headers=self.headers,
            json={
                "jsonrpc": "2.0",
                "id": 0,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": client_name, "version": "1.0"},
                },
            },
        )
        assert response.status_code == 200, response.text
        session_id = response.headers.get("mcp-session-id")
        if session_id:
            self.headers["mcp-session-id"] = session_id
        await self.http.post(
            "/mcp",
            headers=self.headers,
            json={"jsonrpc": "2.0", "method": "notifications/initialized"},
        )

    async def rpc(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        self._id += 1
        payload: dict[str, Any] = {"jsonrpc": "2.0", "id": self._id, "method": method}
        if params is not None:
            payload["params"] = params
        response = await self.http.post("/mcp", headers=self.headers, json=payload)
        assert response.status_code == 200, response.text
        body = response.json()
        assert "error" not in body, body
        return dict(body["result"])

    async def tools(self) -> dict[str, dict[str, Any]]:
        result = await self.rpc("tools/list")
        return {item["name"]: item for item in result["tools"]}

    async def call(self, name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
        return await self.rpc("tools/call", {"name": name, "arguments": arguments or {}})


@pytest.fixture
def mcp_settings(monkeypatch) -> Settings:
    settings = Settings(
        mcp_token=TOKEN,
        mcp_wait_timeout=0.05,
        mcp_wait_max_timeout=1.0,
        mcp_poll_interval=0.01,
    )
    monkeypatch.setattr(mcp_server, "get_settings", lambda: settings)
    return settings


@pytest.fixture
def queue(monkeypatch) -> FakeQueue:
    fake = FakeQueue()

    async def _acquire() -> FakeQueue:
        return fake

    monkeypatch.setattr(mcp_server, "acquire_queue", _acquire)
    return fake


@pytest.fixture
def wired(mcp_settings, session_factory, monkeypatch) -> None:
    """把 MCP 的会话接缝指到内存库；队列由 `queue` fixture 换成假的。"""

    @asynccontextmanager
    async def _scope():
        async with session_factory() as session:
            yield session

    monkeypatch.setattr(mcp_server, "session_scope", _scope)


@pytest.fixture
def mcp(wired, queue):
    """开一条 MCP 会话。

    刻意做成由测试自己 ``async with``，而不是 async fixture：streamable-http 的会话
    管理器里是 anyio 任务组，pytest-asyncio 的 async fixture 会在另一个任务里收尾，
    退出取消域时直接 RuntimeError。
    """

    @asynccontextmanager
    async def _open(client_name: str = "claude-code"):
        app = FastAPI()
        assert mcp_server.mount_mcp(app) is True
        async with app.router.lifespan_context(app):
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url=BASE_URL) as http:
                client = McpClient(http)
                await client.handshake(client_name)
                yield client

    return _open


@pytest.fixture
def flow_dispatch_wired():
    """给 flow.run 补上 task_types 与分派，验证补完之后这条链路真的通。

    tool_execution 里落这一段之前，flow.run 只有引擎内部能用（自己 prepare 自己入队），
    投影层按 `is_dispatchable` 把它挡在 MCP 清单外面。
    """
    original = require_operation("flow.run")

    def queue_flow_tick(task: StudioTask) -> ToolQueueCall:
        run_id = str((task.invocation or {}).get("run_id") or "")
        if not run_id:
            raise ToolExecutionError("工作流运行任务缺少 run_id，无法入队")
        return ToolQueueCall(
            "run_studio_flow", (run_id,), {"_job_id": flow_tick_job_id(run_id)}
        )

    unregister_operation("flow.run")
    register_operation(
        ToolOperationSpec(
            operation="flow.run",
            input=original.input,
            prepare=original.prepare,
            queue=queue_flow_tick,
            task_types=frozenset({"flow.run"}),
            resume_policy=original.resume_policy,
            worker_function="run_studio_flow",
            output_schema=dict(original.output_schema),
        )
    )
    try:
        yield
    finally:
        unregister_operation("flow.run")
        register_operation(original)


# ---- 投影：清单跟着注册表走 ----


def test_catalog_follows_the_registry_and_skips_undispatchable_operations() -> None:
    names = {tool.name for tool in mcp_server.tool_catalog()}
    assert {"task_wait", "task_status", "list_capabilities"} <= names
    assert "image_generate_submit" in names
    # 只做分流的能力照样能入队（落库任务类型属于 image.generate / image.edit），要投影
    assert "image_auto_submit" in names
    # 没有 worker 分派的能力不投影：暴露一个调不通的工具比少列一个更糟。M62 的
    # flow.run / flow.resume 现在就卡在这里，tool_execution 补上 task_types 后自动放行。
    for operation in ("flow.run", "flow.resume"):
        dispatchable = mcp_server.is_dispatchable(require_operation(operation))
        assert (mcp_server.submit_tool_name(operation) in names) is dispatchable


def test_new_operation_shows_up_without_touching_this_module() -> None:
    class EchoInput(BaseModel):
        model_config = {"extra": "forbid"}

        text: str

    async def _prepare(session, **kwargs):  # noqa: ANN001
        raise NotImplementedError

    def _queue(task) -> ToolQueueCall:  # noqa: ANN001
        return ToolQueueCall("run_studio_chat", (task.id,), {})

    handle = tool_plugins.register_tool_plugin(
        plugin_id="sample-mcp",
        label="Echo",
        hint="mcp projection test",
        category="create",
        status="ready",
        blueprint="TEST-1",
        capabilities={"sample.echo"},
    )
    register_operation(
        ToolOperationSpec(
            operation="sample.echo",
            input=EchoInput,
            prepare=_prepare,
            queue=_queue,
            task_types=frozenset({"sample.echo"}),
            resume_policy="retry",
            worker_function="run_studio_chat",
            output_schema={"type": "object"},
        )
    )
    try:
        tools = {tool.name: tool for tool in mcp_server.tool_catalog()}
        assert "sample_echo_submit" in tools
        assert tools["sample_echo_submit"].input_schema["required"] == ["text"]
        assert tools["sample_echo_submit"].input_schema["additionalProperties"] is False
        capabilities = {
            item["operation"]: item for item in mcp_server.capabilities_view()["operations"]
        }
        assert capabilities["sample.echo"]["tool_id"] == "sample-mcp"
    finally:
        unregister_operation("sample.echo")
        handle.dispose()
    assert "sample_echo_submit" not in {tool.name for tool in mcp_server.tool_catalog()}


async def test_tools_list_serves_the_pydantic_schema_verbatim(mcp) -> None:
    async with mcp() as client:
        tools = await client.tools()
        assert "image_generate_submit" in tools
        expected = require_operation("image.generate").input.model_json_schema()
        assert tools["image_generate_submit"]["inputSchema"] == expected
        assert tools["task_wait"]["inputSchema"]["required"] == ["task_id"]

        result = await client.call("list_capabilities")
        operations = {
            item["operation"]: item for item in result["structuredContent"]["operations"]
        }
        assert operations["image.generate"]["submit_tool"] == "image_generate_submit"
        assert operations["image.generate"]["task_types"] == ["image.generate", "image.rerun"]
        assert operations["workflow.run"]["tool_id"] in {
            item["id"] for item in tool_plugins.list_tool_plugins()
        }


# ---- submit → wait 合同 ----


async def test_submit_records_the_mcp_client_and_wait_returns_artifacts(
    mcp, queue, session
) -> None:
    async with mcp() as client:
        result = await client.call("chat_general_submit", {"prompt": "写一句开场白"})
        assert result["isError"] is False
        payload = result["structuredContent"]
        task_id = payload["task_id"]
        assert payload["operation"] == "chat.general"
        assert payload["status"] == "queued"
        assert payload["terminal"] is False
        assert payload["artifacts"] == []
        assert queue.calls[0][0] == ("run_studio_chat", task_id)

        row = await session.get(StudioTask, task_id)
        assert row is not None
        assert row.source_route == "mcp:claude-code"
        assert row.source_context == {"source": "mcp", "client": "claude-code"}
        assert row.invocation["_tool_runtime"]["operation"] == "chat.general"

        waited = await client.call("task_wait", {"task_id": task_id, "timeout_s": 0.05})
        assert waited["structuredContent"]["timed_out"] is True
        assert waited["structuredContent"]["terminal"] is False

        transition(row, "running", stage="chat")
        transition(row, "succeeded", stage="done", result={"text": "早上好"})
        await session.commit()

        waited = await client.call("task_wait", {"task_id": task_id, "timeout_s": 1.0})
        body = waited["structuredContent"]
        assert body["timed_out"] is False
        assert body["terminal"] is True
        assert body["status"] == "succeeded"
        assert body["artifacts"] == [
            {"kind": "text", "ref": f"text:{task_id}", "asset_id": None, "media_asset_id": None}
        ]

        snapshot = await client.call("task_status", {"task_id": task_id})
        assert snapshot["structuredContent"]["task"]["result"] == {"text": "早上好"}


async def test_unknown_task_and_unknown_tool_come_back_as_tool_errors(mcp) -> None:
    async with mcp() as client:
        missing = await client.call("task_status", {"task_id": "nope"})
        assert missing["isError"] is True
        assert "任务不存在" in missing["content"][0]["text"]

        unknown = await client.call("no_such_tool", {})
        assert unknown["isError"] is True
        assert "未知工具" in unknown["content"][0]["text"]


def test_task_artifacts_projects_image_and_media_refs() -> None:
    image = new_task(tool_id="image-console", task_type="image.generate")
    transition(image, "running", stage="t")
    transition(image, "succeeded", stage="t", result={"asset_ids": [7, 9]})
    assert mcp_server.task_artifacts(image) == [
        {"kind": "image", "ref": "asset:7", "asset_id": 7, "media_asset_id": None},
        {"kind": "image", "ref": "asset:9", "asset_id": 9, "media_asset_id": None},
    ]

    video = new_task(tool_id="video-director", task_type="video.generate")
    transition(video, "running", stage="t")
    transition(
        video,
        "succeeded",
        stage="t",
        result={"items": [{"kind": "video", "media_asset_id": 12, "url": "/media/a.mp4"}]},
    )
    assert mcp_server.task_artifacts(video) == [
        {"kind": "video", "ref": "media:12", "asset_id": None, "media_asset_id": 12}
    ]


# ---- 鉴权与脱敏 ----


async def test_without_token_the_endpoint_is_not_mounted(monkeypatch) -> None:
    monkeypatch.setattr(mcp_server, "get_settings", lambda: Settings(mcp_token=""))
    app = FastAPI()
    assert mcp_server.mount_mcp(app) is False
    assert [route for route in app.router.routes if getattr(route, "path", "") == "/mcp"] == []


async def test_bad_or_missing_bearer_is_401(wired, queue) -> None:
    app = FastAPI()
    assert mcp_server.mount_mcp(app) is True
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url=BASE_URL) as http:
            anonymous = await http.post(
                "/mcp",
                headers={"Accept": "application/json, text/event-stream"},
                json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
            )
            assert anonymous.status_code == 401
            assert "Bearer" in anonymous.headers["www-authenticate"]

            wrong = await http.post(
                "/mcp",
                headers={
                    "Accept": "application/json, text/event-stream",
                    "Authorization": "Bearer nope",
                },
                json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
            )
            assert wrong.status_code == 401


async def test_requests_from_outside_loopback_are_refused(wired, queue) -> None:
    app = FastAPI()
    assert mcp_server.mount_mcp(app) is True
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app, client=("10.0.0.9", 51234))
        async with AsyncClient(transport=transport, base_url=BASE_URL) as http:
            response = await http.post(
                "/mcp",
                headers={
                    "Accept": "application/json, text/event-stream",
                    "Authorization": f"Bearer {TOKEN}",
                },
                json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
            )
            assert response.status_code == 403


async def test_validation_errors_do_not_leak_credentials(mcp) -> None:
    async with mcp() as client:
        result = await client.call(
            "chat_general_submit",
            {"prompt": "hi", "authorization": "Bearer sk-live-0123456789abcdef"},
        )
    assert result["isError"] is True
    text = result["content"][0]["text"]
    assert "sk-live-0123456789abcdef" not in text
    assert "REDACTED" in text


def test_task_payload_redacts_secret_keys_in_the_snapshot() -> None:
    task = new_task(
        tool_id="workflow-center",
        task_type="workflow.comfyui",
        invocation={"api_key": "sk-live-0123456789abcdef", "fields": {"prompt": "cat"}},
    )
    payload = mcp_server.task_payload(task)
    assert payload["task"]["invocation"]["api_key"] == "[REDACTED]"
    assert payload["task"]["invocation"]["fields"] == {"prompt": "cat"}


# ---- flow.run：补上分派之后经 MCP 可提交 ----


async def test_flow_run_is_submittable_once_dispatch_is_wired(
    flow_dispatch_wired, mcp, queue, session
) -> None:
    flow = await create_flow(
        session,
        title="两步出图",
        description=None,
        definition={
            "nodes": [
                {
                    "id": "draft",
                    "tool_id": "infinite-canvas",
                    "operation": "image.generate",
                    "input": {"prompt": "a cat"},
                }
            ],
            "edges": [],
        },
    )
    assert isinstance(flow, StudioFlow)

    async with mcp() as client:
        tools = await client.tools()
        assert "flow_run_submit" in tools
        result = await client.call("flow_run_submit", {"flow_id": flow.id, "inputs": {}})
    assert result["isError"] is False, result["content"][0]["text"]
    payload = result["structuredContent"]
    task = await session.get(StudioTask, payload["task_id"])
    assert task is not None
    assert task.task_type == "flow.run"
    assert task.source_route == "mcp:claude-code"
    child_run_id = task.invocation["run_id"]
    runs = list((await session.execute(select(StudioFlowRun))).scalars())
    assert [row.id for row in runs] == [child_run_id]
    assert queue.calls[0][0] == ("run_studio_flow", child_run_id)
    assert queue.calls[0][1]["_job_id"] == flow_tick_job_id(child_run_id)
