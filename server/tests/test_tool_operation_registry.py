"""operation 注册表：输入合同、worker 分派与 arq 函数表都从同一张表派生。"""

from __future__ import annotations

from types import ModuleType, SimpleNamespace

import pytest
from pydantic import BaseModel

from domain import tool_execution, tool_plugins
from domain.tool_execution import (
    TOOL_OPERATION_INPUTS,
    ChatGeneralInput,
    ToolExecutionError,
    ToolOperationSpec,
    ToolQueueCall,
    VideoRunInput,
    WorkflowRunInput,
    WorkflowRunParams,
    list_operations,
    operation_contracts,
    parse_tool_operation_input,
    queue_call_for,
    register_operation,
    require_operation,
    spec_for_task_type,
    start_tool_operation,
    unregister_operation,
    worker_function_names,
    worker_functions,
)
from worker.main import WorkerSettings

# 删除手写 TOOL_OPERATION_CONTRACTS 前每个能力的 required 列表：派生 schema 不能少字段
LEGACY_REQUIRED: dict[str, list[str]] = {
    "chat.general": ["prompt"],
    "midjourney.generate": ["deployment_id", "mode", "size", "version", "speed"],
    "midjourney.action": ["deployment_id", "task_id", "action", "speed"],
    "image.generate": ["prompt"],
    "image.edit": ["prompt", "ref_asset_ids"],
    "image.auto": ["prompt"],
    "image.upscale": ["deployment_id", "asset_id", "resolution_type"],
    "video.generate": ["deployment_id", "prompt"],
    "workflow.run": ["workflow_id", "credential_id"],
    # 后补的能力（不属于旧合同）：DAG 引擎把子工作流与人工恢复也登记成能力
    "flow.run": ["flow_id"],
    "flow.resume": ["run_id", "node_id"],
}

# 旧 queue_call_for if-chain 的语义，注册表必须逐条复现
EXPECTED_DISPATCH: dict[str, str] = {
    "workflow.comfyui": "run_studio_workflow",
    "workflow.runninghub": "run_studio_workflow",
    "chat.general": "run_studio_chat",
    "video.generate": "generate_studio_video",
    "midjourney.generate": "generate_midjourney",
    "midjourney.action": "generate_midjourney",
    "image.generate": "generate_image",
    "image.rerun": "generate_image",
    "image.edit": "edit_image_task",
    "image.upscale": "upscale_image_task",
}

# M62 遗留：flow.run / flow.resume 还没声明 task_types，引擎内部自己 prepare 自己入队，
# 外部入口走 start_tool_operation 会卡在 queue_call_for。tool_execution 里给这两个
# operation 补上 task_types + queue 之后，下面两行自动并入期望分派，MCP 投影同步放行。
PLANNED_DISPATCH: dict[str, str] = {
    "flow.run": "run_studio_flow",
    "flow.resume": "run_studio_flow",
}


def _expected_dispatch(registered: dict[str, str]) -> dict[str, str]:
    expected = dict(EXPECTED_DISPATCH)
    expected.update({key: value for key, value in PLANNED_DISPATCH.items() if key in registered})
    return expected


async def _noop_prepare(session, **kwargs):  # noqa: ANN001
    raise NotImplementedError


def _task(task_type: str, invocation: dict | None = None) -> SimpleNamespace:
    return SimpleNamespace(id="task-1", task_type=task_type, invocation=invocation or {})


# ---- 合同派生 ---------------------------------------------------------------


def test_registry_covers_every_legacy_operation() -> None:
    assert {spec.operation for spec in list_operations()} == set(LEGACY_REQUIRED)
    assert set(TOOL_OPERATION_INPUTS) == set(LEGACY_REQUIRED)
    assert TOOL_OPERATION_INPUTS["video.generate"] is VideoRunInput
    assert TOOL_OPERATION_INPUTS.get("nope") is None


def test_derived_input_schema_keeps_legacy_required_fields() -> None:
    contracts = operation_contracts()
    assert set(contracts) == set(LEGACY_REQUIRED)
    for operation, legacy_required in LEGACY_REQUIRED.items():
        schema = contracts[operation]["input_schema"]
        assert set(legacy_required) <= set(schema["properties"]), operation
        # pydantic 不会凭空多出旧合同没有的硬性字段
        assert set(schema.get("required", [])) <= set(legacy_required), operation
        assert contracts[operation]["output_schema"]["type"] == "object"
        assert contracts[operation]["resume_policy"] in tool_execution.OPERATION_RESUME_POLICIES
    assert "deployment_id" in contracts["video.generate"]["input_schema"]["required"]
    assert contracts["video.generate"]["input_schema"]["required"] == ["deployment_id", "prompt"]
    assert contracts["chat.general"]["output_schema"]["required"] == ["text"]


def test_operation_contracts_can_filter_and_never_leak_cache() -> None:
    subset = operation_contracts({"video.generate", "IMAGE.generate", "not.registered"})
    assert list(subset) == ["image.generate", "video.generate"]
    subset["video.generate"]["input_schema"]["properties"].clear()
    assert "prompt" in operation_contracts()["video.generate"]["input_schema"]["properties"]


def test_plugin_catalog_reads_contracts_from_registry() -> None:
    assert not hasattr(tool_plugins, "TOOL_OPERATION_CONTRACTS")
    by_id = {item["id"]: item for item in tool_plugins.list_tool_plugins()}
    video = by_id["video-director"]["operation_contracts"]
    assert sorted(video) == ["video.generate", "workflow.run"]
    assert video["video.generate"]["input_schema"]["required"] == ["deployment_id", "prompt"]
    assert video["workflow.run"]["input_schema"]["properties"]["workflow_id"]["minimum"] == 1
    # 没有可执行合同的能力（vision.caption）不会出现在合同视图里
    assert by_id["asset-library"]["operation_contracts"] == {}
    assert tool_plugins.require_tool_operation("infinite-canvas", "image.auto").id == (
        "infinite-canvas"
    )
    with pytest.raises(ValueError, match="尚未接入统一执行器"):
        tool_plugins.require_tool_operation("asset-library", "vision.caption")
    with pytest.raises(ValueError, match="不支持能力"):
        tool_plugins.require_tool_operation("grid-tool", "image.generate")


def test_parse_input_uses_registry_contract() -> None:
    parsed = parse_tool_operation_input("Video.Generate", {"deployment_id": 3, "prompt": "x"})
    assert isinstance(parsed, VideoRunInput)
    with pytest.raises(ToolExecutionError) as exc_info:
        parse_tool_operation_input("video.generate", {"prompt": "x"})
    assert exc_info.value.status == 422
    with pytest.raises(ToolExecutionError, match="尚未接入统一执行器"):
        parse_tool_operation_input("vision.caption", {})


# ---- worker 分派 -------------------------------------------------------------


def test_queue_call_routes_every_task_type_to_its_worker() -> None:
    registered = {
        task_type: spec.worker_function
        for spec in list_operations()
        for task_type in spec.task_types
    }
    expected = _expected_dispatch(registered)
    assert registered == expected
    # 一份能喂饱所有分派的调用快照：生图要 image_job_id，工作流运行要 run_id
    snapshot = {"image_job_id": 7, "run_id": "run-1"}
    for task_type, function in expected.items():
        call = queue_call_for(_task(task_type, snapshot))
        assert isinstance(call, ToolQueueCall)
        assert call.function == function
        spec = spec_for_task_type(task_type)
        assert spec is not None and spec.worker_function == function
    # 分流能力自身不落任务，也就不占任务类型
    assert spec_for_task_type("image.auto") is None
    assert require_operation("image.auto").task_types == frozenset()


def test_operations_without_task_types_are_declared_not_accidental() -> None:
    """没有任务类型的能力只能是两种：分流器，或还没补分派的 M62 遗留。

    第三种（新写了 operation 却忘了接 worker）必须在这里炸出来，否则它会一路投影到
    MCP 清单上变成一个调不通的工具。
    """
    from app.mcp_server import ROUTER_OPERATIONS

    orphans = {spec.operation for spec in list_operations() if not spec.task_types}
    assert orphans <= ROUTER_OPERATIONS | set(PLANNED_DISPATCH)


def test_flow_capabilities_are_claimed_by_a_plugin() -> None:
    """flow.run / flow.resume 过去没有任何插件声明，外部入口连门都进不去。"""
    for operation in ("flow.run", "flow.resume"):
        plugin = tool_plugins.require_tool_operation("workflow-center", operation)
        assert plugin.id == "workflow-center"
    contracts = tool_plugins.list_tool_plugins()
    by_id = {item["id"]: item for item in contracts}
    assert set(by_id["workflow-center"]["operation_contracts"]) == {
        "flow.resume",
        "flow.run",
        "workflow.run",
    }


def test_image_generate_queue_passes_job_and_rerun_scope() -> None:
    call = queue_call_for(
        _task(
            "image.rerun",
            {"image_job_id": "7", "from_step": "render", "config": {"n": 2}, "scope": "single"},
        )
    )
    assert call == ToolQueueCall("generate_image", (7, "render", {"n": 2}, "single"), {})
    assert queue_call_for(_task("image.generate", {"image_job_id": 9})).args == (
        9,
        None,
        None,
        "downstream",
    )
    with pytest.raises(ToolExecutionError, match="缺少 image_job_id"):
        queue_call_for(_task("image.generate"))


def test_unknown_task_type_is_rejected() -> None:
    with pytest.raises(ToolExecutionError, match="尚未接入统一执行器"):
        queue_call_for(_task("image.auto"))
    with pytest.raises(ToolExecutionError, match="尚未接入统一执行器"):
        queue_call_for(SimpleNamespace(id="x", task_type=None, invocation=None))


def test_worker_settings_include_every_registered_function() -> None:
    registered = {
        task_type: spec.worker_function
        for spec in list_operations()
        for task_type in spec.task_types
    }
    names = set(worker_function_names())
    assert names == set(_expected_dispatch(registered).values())
    registered = {function.__name__ for function in WorkerSettings.functions}
    assert names <= registered
    # 非工具函数不受注册表影响
    assert {"ping", "run_studio_flow", "tag_assets_job", "run_pipeline"} <= registered
    with pytest.raises(RuntimeError, match="缺少注册表声明的 worker 函数"):
        worker_functions(ModuleType("empty_tasks"))


# ---- start_tool_operation 的合同校验 ----------------------------------------


async def test_start_tool_operation_rejects_body_of_another_contract() -> None:
    async def must_not_enqueue(*args, **kwargs):  # noqa: ANN001
        raise AssertionError("合同不匹配时不能入队")

    queue = SimpleNamespace(enqueue_job=must_not_enqueue)
    with pytest.raises(ToolExecutionError, match="能力与输入合同不匹配"):
        await start_tool_operation(
            object(),
            queue,
            tool_id="infinite-canvas",
            operation="video.generate",
            body=ChatGeneralInput(prompt="hi"),
        )
    with pytest.raises(ValueError, match="尚未接入统一执行器"):
        await start_tool_operation(
            object(),
            queue,
            tool_id="asset-library",
            operation="vision.caption",
            body=ChatGeneralInput(prompt="hi"),
        )


# ---- 注册表自身的约束 -------------------------------------------------------


def test_spec_validation_catches_miswired_operations() -> None:
    def queue(task) -> ToolQueueCall:  # noqa: ANN001
        return ToolQueueCall("x", (task.id,), {})

    with pytest.raises(ValueError, match="小写"):
        ToolOperationSpec("Sample.Op", ChatGeneralInput, _noop_prepare, None, frozenset(), "retry")
    with pytest.raises(ValueError, match="恢复策略未知"):
        ToolOperationSpec("sample.op", ChatGeneralInput, _noop_prepare, None, frozenset(), "later")
    with pytest.raises(ValueError, match="pydantic 模型"):
        ToolOperationSpec("sample.op", dict, _noop_prepare, None, frozenset(), "retry")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="成对给出"):
        ToolOperationSpec("sample.op", ChatGeneralInput, _noop_prepare, queue, frozenset(), "retry")
    with pytest.raises(ValueError, match="没有 worker 分派"):
        ToolOperationSpec(
            "sample.op", ChatGeneralInput, _noop_prepare, None, frozenset({"sample.op"}), "retry"
        )


def test_registration_rejects_duplicates_and_task_type_clashes() -> None:
    duplicate = ToolOperationSpec(
        "image.generate", ChatGeneralInput, _noop_prepare, None, frozenset(), "retry"
    )
    with pytest.raises(ValueError, match="重复注册"):
        register_operation(duplicate)

    def queue(task) -> ToolQueueCall:  # noqa: ANN001
        return ToolQueueCall("edit_image_task", (task.id,), {})

    clash = ToolOperationSpec(
        "sample.clash",
        ChatGeneralInput,
        _noop_prepare,
        queue,
        frozenset({"image.edit"}),
        "retry",
        worker_function="edit_image_task",
    )
    with pytest.raises(ValueError, match="已被其它能力占用"):
        register_operation(clash)
    assert "sample.clash" not in TOOL_OPERATION_INPUTS
    assert spec_for_task_type("image.edit") is require_operation("image.edit")


def test_registered_operation_is_visible_everywhere_until_unregistered() -> None:
    class EchoInput(BaseModel):
        model_config = {"extra": "forbid"}

        text: str

    handle = tool_plugins.register_tool_plugin(
        plugin_id="sample-echo",
        label="Echo",
        hint="registry test",
        category="create",
        status="planned",
        blueprint="TEST-1",
        capabilities={"sample.echo"},
    )
    register_operation(
        ToolOperationSpec(
            "sample.echo",
            EchoInput,
            _noop_prepare,
            None,
            frozenset(),
            "retry",
            output_schema={"type": "object"},
        )
    )
    try:
        assert TOOL_OPERATION_INPUTS["sample.echo"] is EchoInput
        assert isinstance(parse_tool_operation_input("sample.echo", {"text": "hi"}), EchoInput)
        assert operation_contracts()["sample.echo"]["input_schema"]["required"] == ["text"]
        assert tool_plugins.require_tool_operation("sample-echo", "sample.echo").id == "sample-echo"
        views = {item["id"]: item for item in tool_plugins.list_tool_plugins()}
        view = views["sample-echo"]
        assert list(view["operation_contracts"]) == ["sample.echo"]
    finally:
        unregister_operation("sample.echo")
        handle.dispose()
    assert "sample.echo" not in TOOL_OPERATION_INPUTS
    with pytest.raises(ToolExecutionError, match="尚未接入统一执行器"):
        require_operation("sample.echo")
    with pytest.raises(ValueError, match="未注册"):
        unregister_operation("sample.echo")


# ---- 路由 Body 与领域合同同源 ----------------------------------------------


async def test_workflow_and_video_route_bodies_share_domain_contract(client) -> None:
    from app.routers.studio import VideoRunBody, WorkflowRunBody

    assert issubclass(WorkflowRunBody, WorkflowRunParams)
    assert issubclass(VideoRunBody, VideoRunInput)
    assert set(WorkflowRunBody.model_fields) == set(WorkflowRunParams.model_fields) | {
        "source_route",
        "source_context",
    }
    assert set(WorkflowRunInput.model_fields) == set(WorkflowRunParams.model_fields) | {
        "workflow_id"
    }
    # ge=1 与 extra=forbid 由领域合同带进路由，在 FastAPI 校验层就拦下
    response = await client.post("/studio/workflows/1/runs", json={"credential_id": 0})
    assert response.status_code == 422
    response = await client.post(
        "/studio/videos/runs",
        json={"deployment_id": 1, "prompt": "x", "bogus": True},
    )
    assert response.status_code == 422
