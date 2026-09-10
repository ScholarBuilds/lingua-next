"""GPT 创作对话的四类工具：编辑、视频、工作流、DAG。

验证五件事：

- 四类工具都在对话代理的工具清单里，并且是从 ``@tool_operation`` 注册表派生的——合同
  多一个字段，工具声明自动多一项，本包不用改；
- 宿主代填的字段（部署、凭据、上传字节）不发给模型，执行时补齐；
- 提交路径的合同：真建了任务、入了队、快照写着能力名与来源；
- 失败原样回给模型，且不吞掉「下一步该怎么改」（找不到 id 时把清单写进错误）；
- 对话循环认得回执，产出 ``task`` 事件并把 task_id 落进会话。

不打真实网络，也不起 arq：队列与 LLM 都是替身，任务真进内存库。
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import pytest
from pydantic import BaseModel, Field

from domain import agent_tools, image_apps, studio_gpt
from domain import storage as storage_mod
from domain.agent_tools import image_edit, image_generate, submit, video_generate, workflow_run
from domain.kernel.bootstrap import build_kernel, get_kernel
from domain.models import (
    CapabilityBinding,
    ImageAsset,
    ModelDeployment,
    ProviderCredential,
    StudioFlow,
    StudioGptChat,
    StudioTask,
    StudioWorkflow,
)
from domain.tool_execution import (
    ToolOperationSpec,
    ToolQueueCall,
    register_operation,
    require_operation,
    unregister_operation,
)
from tests.model_binding_stub import seed_default_bindings
from tests.test_kernel_wiring import _chunk, _ScriptedClient, _tool_piece
from tests.test_studio import FakeStorage, noise_png

TASK_TOOLS = (
    image_edit.TOOL_NAME,
    video_generate.TOOL_NAME,
    workflow_run.WORKFLOW_TOOL_NAME,
    workflow_run.FLOW_TOOL_NAME,
)


class FakeQueue:
    def __init__(self) -> None:
        self.calls: list[tuple[tuple[Any, ...], dict[str, Any]]] = []

    async def enqueue_job(self, *args: Any, **kwargs: Any) -> None:
        self.calls.append((args, kwargs))


@pytest.fixture
def queue(monkeypatch) -> FakeQueue:
    fake = FakeQueue()

    async def _acquire() -> FakeQueue:
        return fake

    monkeypatch.setattr(submit, "acquire_queue", _acquire)
    monkeypatch.setattr(workflow_run, "acquire_queue", _acquire)
    return fake


@pytest.fixture
def fake_storage():
    fake = FakeStorage()
    storage_mod.set_storage(fake)
    yield fake
    storage_mod.set_storage(None)


@pytest.fixture
async def bound_models(session):
    return await seed_default_bindings(session)


async def _asset(session) -> ImageAsset:
    from domain import image_assets

    row = await image_assets.ingest_one(
        session, noise_png(), target_key="free", prompt="a cat", source="workbench"
    )
    await session.commit()
    return row


async def _workflow(session, *, provider: str = "comfyui", enabled: bool = True) -> StudioWorkflow:
    row = StudioWorkflow(
        key=f"{provider}:test-{provider}-{enabled}",
        title="高清修复",
        provider=provider,
        kind="workflow",
        source="user",
        payload={"1": {"class_type": "KSampler"}},
        content_hash="hash-1",
        enabled=enabled,
    )
    session.add(row)
    await session.commit()
    return row


async def _credential(session, *, provider: str = "comfyui") -> ProviderCredential:
    row = ProviderCredential(
        name=f"{provider} 本机",
        kind="workflow",
        provider_type=provider,
        config={"base_url": "http://127.0.0.1:8188"},
    )
    session.add(row)
    await session.commit()
    return row


async def _flow(session) -> StudioFlow:
    from domain.studio_flows import create_flow

    row = await create_flow(
        session,
        title="出图再放大",
        description=None,
        definition={
            "nodes": [
                {
                    "id": "draft",
                    "tool_id": "infinite-canvas",
                    "operation": "image.generate",
                    "input": {"prompt": {"$input": "idea"}},
                }
            ],
            "edges": [],
        },
    )
    await session.commit()
    return row


async def _video_deployment(session) -> ModelDeployment:
    credential = ProviderCredential(
        name="视频直连",
        kind="video",
        provider_type="volcengine_video",
        config={"api_base": "https://direct.example/api/v3", "api_key": "sk-video"},
    )
    session.add(credential)
    await session.flush()
    deployment = ModelDeployment(
        credential_id=credential.id,
        upstream_model_id="fake-video",
        adapter_type="volcengine",
        media_types=["video"],
    )
    session.add(deployment)
    await session.flush()
    session.add(
        CapabilityBinding(
            capability=video_generate.VIDEO_CAPABILITY,
            credential_id=credential.id,
            deployment_id=deployment.id,
            target=deployment.upstream_model_id,
        )
    )
    await session.commit()
    return deployment


# ---------------------------------------------------------------------------
# 清单与 schema 派生
# ---------------------------------------------------------------------------


def test_all_four_task_tools_are_visible_to_the_agent() -> None:
    fresh = build_kernel()
    scope = agent_tools.ensure_registered(fresh)
    names = set(fresh.tools.view(scope))
    assert names == {image_generate.TOOL_NAME, *TASK_TOOLS}
    # 注册进的是 gpt-creative 作用域，不污染全局
    assert not (names & set(fresh.tools.view()))
    assert agent_tools.ensure_registered(fresh) == scope  # 幂等


def test_each_task_tool_declares_a_real_operation_and_a_usable_description() -> None:
    fresh = build_kernel()
    scope = agent_tools.ensure_registered(fresh)
    view = fresh.tools.view(scope)
    for brief in (image_edit.BRIEF, video_generate.BRIEF, workflow_run.WORKFLOW_BRIEF):
        spec = require_operation(brief.operation)
        assert spec.task_types, f"{brief.operation} 没有 worker 分派，提交会卡在入队"
    definition = view[image_edit.TOOL_NAME]
    # 说明里要能看出「什么时候用」与「参数从哪来」，否则模型选不对工具
    assert "资产 id" in definition.description
    assert "generate_image" in definition.description
    assert definition.runtime_kind == "task"


@pytest.mark.parametrize(
    ("brief", "module"),
    [
        (image_edit.BRIEF, image_edit),
        (video_generate.BRIEF, video_generate),
        (workflow_run.WORKFLOW_BRIEF, workflow_run),
        (workflow_run.FLOW_BRIEF, workflow_run),
    ],
)
def test_schema_is_derived_from_the_registry_contract(brief, module) -> None:
    del module
    contract = require_operation(brief.operation).input.model_json_schema()
    declared = brief.args_model().model_json_schema()
    expected = (set(contract["properties"]) - set(brief.withheld)) | set(brief.extra)
    assert set(declared["properties"]) == expected
    # 扣下来的字段确实是合同上有的，改名会当场炸而不是悄悄漏给模型
    assert set(brief.withheld) <= set(contract["properties"])
    assert declared["additionalProperties"] is False


def test_contract_constraints_survive_the_projection() -> None:
    declared = image_edit.BRIEF.args_model().model_json_schema()["properties"]
    assert declared["prompt"]["maxLength"] == 8000
    assert declared["ref_asset_ids"]["maxItems"] == 16
    # 收窄只是给模型看的提示：编辑应用取自应用注册表，加一个应用这里自动多一个选项
    assert declared["app_key"]["enum"] == image_edit.edit_app_choices()
    assert "inpaint" in declared["app_key"]["enum"]
    assert all(image_apps.APPS[key].engine == "edit" for key in declared["app_key"]["enum"])


def test_withheld_names_must_exist_on_the_contract() -> None:
    with pytest.raises(ValueError, match="合同上没有这些字段"):
        submit.derive_args_model("X", "image.edit", withheld={"no_such_field": "编的"})


def test_a_new_operation_becomes_a_tool_without_touching_this_package() -> None:
    """注册表多一项能力，写一份 brief 就是一个能用的对话工具，不改公共接线。"""

    class EchoInput(BaseModel):
        model_config = {"extra": "forbid"}

        text: str = Field(min_length=1)
        secret_token: str = ""

    async def _prepare(session, **kwargs):  # noqa: ANN001
        raise NotImplementedError

    def _queue(task) -> ToolQueueCall:  # noqa: ANN001
        return ToolQueueCall("run_studio_chat", (task.id,), {})

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
        brief = submit.SubmitBrief(
            name="echo_it",
            operation="sample.echo",
            label="回声",
            description="测试用",
            withheld={"secret_token": "宿主代填"},
        )

        async def _run(args, turn):  # noqa: ANN001
            raise AssertionError("本用例只看声明")

        definition = submit.build_submit_tool(brief, _run)
        schema = definition.schema()["function"]
        assert schema["name"] == "echo_it"
        assert set(schema["parameters"]["properties"]) == {"text"}
        assert schema["parameters"]["required"] == ["text"]
        assert schema["parameters"]["properties"]["text"]["minLength"] == 1
    finally:
        unregister_operation("sample.echo")


def test_owner_plugin_always_declares_the_capability() -> None:
    """提交要挂在一个**声明过这项能力**的插件下，否则 require_tool_operation 直接挡住。"""
    from domain import tool_plugins

    by_id = {item["id"]: item for item in tool_plugins.list_tool_plugins()}
    for operation in ("image.edit", "video.generate", "workflow.run", "flow.run"):
        owner = submit.owner_plugin_id(operation)
        assert operation in by_id[owner]["capabilities"], operation
    # 对话代理自己声明了的能力记自己名下
    assert submit.owner_plugin_id("image.generate") == submit.AGENT_PLUGIN_ID
    with pytest.raises(submit.AgentToolError, match="没有工具插件声明能力"):
        submit.owner_plugin_id("nope.nothing")


# ---------------------------------------------------------------------------
# 提交路径
# ---------------------------------------------------------------------------


async def test_edit_image_submits_a_real_task_with_host_filled_contract(
    session, queue, fake_storage
) -> None:
    asset = await _asset(session)
    args = image_edit.BRIEF.args_model().model_validate(
        {"prompt": "make it snowy", "ref_asset_ids": [asset.id, asset.id], "app_key": "outpaint"}
    )
    with submit.bind_turn(session, chat_id=7, image_deployment_id=None):
        value = await image_edit.run(args, submit.require_turn(image_edit.TOOL_NAME))

    assert value.operation == "image.edit"
    assert value.label == image_edit.LABEL
    task = await session.get(StudioTask, value.task_id)
    assert task is not None
    assert task.task_type == "image.edit"
    assert task.invocation["_tool_runtime"]["operation"] == "image.edit"
    assert task.invocation["app_key"] == "outpaint"
    # 重复的参考图去掉；血缘起点由第一张参考图推出来（BR-117）
    assert task.invocation["ref_asset_ids"] == [asset.id]
    assert task.invocation["parent_id"] == asset.id
    # 宿主代填的默认值来自合同本身，不是这里另写一份
    assert task.invocation["n"] == 1
    assert task.invocation["size"] is None
    assert task.source_route == "/studio/gpt-chats/7/send"
    assert task.source_context["chat_id"] == 7
    assert queue.calls[0][0] == ("edit_image_task", value.task_id)


async def test_edit_image_copies_the_mask_instead_of_handing_over_the_asset_file(
    session, queue, fake_storage
) -> None:
    """worker 跑完会删掉上传输入。直接交资产的 storage_key，删的就是用户的原图。"""
    asset = await _asset(session)
    mask = await _asset(session)
    args = image_edit.BRIEF.args_model().model_validate(
        {
            "prompt": "erase the sign",
            "ref_asset_ids": [asset.id],
            "app_key": "inpaint",
            "mask_asset_id": mask.id,
        }
    )
    with submit.bind_turn(session, chat_id=1):
        value = await image_edit.run(args, submit.require_turn(image_edit.TOOL_NAME))

    task = await session.get(StudioTask, value.task_id)
    assert task is not None
    stored = task.invocation["mask"]["storage_key"]
    assert stored != mask.storage_key
    assert stored.startswith("studio-task-inputs/")
    assert fake_storage.blobs[stored] == fake_storage.blobs[mask.storage_key]
    # 对话侧的 mask_asset_id 只是翻译用，不会漏进合同
    assert "mask_asset_id" not in task.invocation


async def test_edit_image_without_reference_tells_the_model_what_to_do(session, queue) -> None:
    args = image_edit.BRIEF.args_model().model_validate({"prompt": "x", "ref_asset_ids": []})
    with (
        submit.bind_turn(session, chat_id=1),
        pytest.raises(submit.AgentToolError, match="ref_asset_ids"),
    ):
        await image_edit.run(args, submit.require_turn(image_edit.TOOL_NAME))
    assert queue.calls == []


async def test_generate_video_resolves_the_deployment_from_the_capability_binding(
    session, queue
) -> None:
    deployment = await _video_deployment(session)
    args = video_generate.BRIEF.args_model().model_validate(
        {"prompt": "a cat jumps", "duration": 5, "resolution": "1080p"}
    )
    with submit.bind_turn(session, chat_id=3):
        value = await video_generate.run(args, submit.require_turn(video_generate.TOOL_NAME))

    task = await session.get(StudioTask, value.task_id)
    assert task is not None
    assert task.task_type == "video.generate"
    assert task.deployment_id == deployment.id
    assert task.invocation["deployment_id"] == deployment.id
    assert task.invocation["duration"] == 5
    assert queue.calls[0][0] == ("generate_studio_video", value.task_id)


async def test_generate_video_without_a_binding_says_so_instead_of_submitting(
    session, queue
) -> None:
    args = video_generate.BRIEF.args_model().model_validate({"prompt": "a cat jumps"})
    with (
        submit.bind_turn(session, chat_id=3),
        pytest.raises(submit.AgentToolError, match=video_generate.VIDEO_CAPABILITY),
    ):
        await video_generate.run(args, submit.require_turn(video_generate.TOOL_NAME))
    assert queue.calls == []


async def test_run_workflow_picks_the_credential_by_provider(session, queue) -> None:
    workflow = await _workflow(session)
    credential = await _credential(session)
    args = workflow_run.WORKFLOW_BRIEF.args_model().model_validate(
        {"workflow_id": workflow.id, "fields": {"prompt": "hello"}}
    )
    with submit.bind_turn(session, chat_id=5):
        value = await workflow_run.run_workflow(
            args, submit.require_turn(workflow_run.WORKFLOW_TOOL_NAME)
        )

    task = await session.get(StudioTask, value.task_id)
    assert task is not None
    assert task.task_type == "workflow.comfyui"
    assert task.invocation["credential_id"] == credential.id
    assert task.invocation["fields"] == {"prompt": "hello"}
    assert task.source_context["workflow_id"] == workflow.id
    assert queue.calls[0][0] == ("run_studio_workflow", value.task_id)


async def test_run_workflow_probe_lists_what_is_available(session, queue) -> None:
    """id 不是常驻在提示词里的，模型填 0 探一次，清单从错误里拿。"""
    workflow = await _workflow(session)
    await _workflow(session, enabled=False)
    args = workflow_run.WORKFLOW_BRIEF.args_model().model_validate(
        {"workflow_id": workflow_run.PROBE_ID}
    )
    with (
        submit.bind_turn(session, chat_id=5),
        pytest.raises(submit.AgentToolError) as exc_info,
    ):
        await workflow_run.run_workflow(args, submit.require_turn(workflow_run.WORKFLOW_TOOL_NAME))
    message = str(exc_info.value)
    assert f"{workflow.id}={workflow.title}" in message
    assert "还不知道要跑哪条工作流" in message
    assert queue.calls == []


async def test_run_workflow_without_a_credential_names_the_provider(session, queue) -> None:
    workflow = await _workflow(session, provider="runninghub")
    args = workflow_run.WORKFLOW_BRIEF.args_model().model_validate({"workflow_id": workflow.id})
    with (
        submit.bind_turn(session, chat_id=5),
        pytest.raises(submit.AgentToolError, match="runninghub"),
    ):
        await workflow_run.run_workflow(args, submit.require_turn(workflow_run.WORKFLOW_TOOL_NAME))
    assert queue.calls == []


async def test_run_flow_starts_a_dag_run_and_ticks_it(session, queue) -> None:
    flow = await _flow(session)
    args = workflow_run.FLOW_BRIEF.args_model().model_validate(
        {"flow_id": flow.id, "inputs": {"idea": "雪山"}}
    )
    with submit.bind_turn(session, chat_id=9):
        value = await workflow_run.run_flow(args, submit.require_turn(workflow_run.FLOW_TOOL_NAME))

    assert value.run_id
    assert value.operation == "flow.run"
    task = await session.get(StudioTask, value.task_id)
    assert task is not None
    assert task.invocation["flow_id"] == flow.id
    assert task.invocation["inputs"] == {"idea": "雪山"}
    function, run_id = queue.calls[0][0]
    assert function == "run_studio_flow"
    assert run_id == value.run_id


async def test_run_flow_probe_lists_available_dags(session, queue) -> None:
    flow = await _flow(session)
    args = workflow_run.FLOW_BRIEF.args_model().model_validate({"flow_id": workflow_run.PROBE_ID})
    with (
        submit.bind_turn(session, chat_id=9),
        pytest.raises(submit.AgentToolError) as exc_info,
    ):
        await workflow_run.run_flow(args, submit.require_turn(workflow_run.FLOW_TOOL_NAME))
    assert f"{flow.id}={flow.title}" in str(exc_info.value)
    assert queue.calls == []


async def test_task_tools_refuse_to_run_outside_a_bound_turn() -> None:
    for name in TASK_TOOLS:
        with pytest.raises(submit.AgentToolError, match="对话回合"):
            submit.require_turn(name)


# ---------------------------------------------------------------------------
# 对话循环：回执成事件，失败回给模型
# ---------------------------------------------------------------------------


def _call(name: str, arguments: dict, call_id: str = "call_1") -> list:
    return [
        _chunk(tool_calls=[_tool_piece(0, name, "", call_id)]),
        _chunk(
            tool_calls=[_tool_piece(0, None, json.dumps(arguments, ensure_ascii=False))],
            finish="tool_calls",
        ),
    ]


async def test_stream_turn_turns_a_submission_into_a_task_event(
    session, bound_models, queue, fake_storage, monkeypatch
) -> None:
    asset = await _asset(session)
    fake = _ScriptedClient(
        [
            _call(image_edit.TOOL_NAME, {"prompt": "snow", "ref_asset_ids": [asset.id]}),
            [_chunk("在跑了")],
        ]
    )
    monkeypatch.setattr(studio_gpt, "_client", lambda _route: fake)
    chat = StudioGptChat(title="编辑")
    session.add(chat)
    await session.commit()
    await session.refresh(chat)

    events = [event async for event in studio_gpt.stream_turn(session, chat, "把它改成雪景")]

    name, payload = next((n, p) for n, p in events if n == "task")
    assert name == "task"
    assert payload["operation"] == "image.edit"
    assert payload["label"] == image_edit.LABEL
    task = await session.get(StudioTask, payload["task_id"])
    assert task is not None and task.task_type == "image.edit"

    # 工具声明里没有 size 的工具不会被硬塞画幅（extra=forbid 会当场打回）
    declared = {item["function"]["name"] for item in fake.completions.calls[0]["tools"]}
    assert declared == {image_generate.TOOL_NAME, *TASK_TOOLS}
    tool_message = fake.completions.calls[1]["messages"][-1]
    assert json.loads(tool_message["content"])["task_id"] == payload["task_id"]

    done = events[-1]
    assert done[0] == "done"
    assert done[1]["turn"]["task_ids"] == [payload["task_id"]]
    assert "asset_ids" not in done[1]["turn"]
    assert not any(n == "error" for n, _ in events)


async def test_stream_turn_reports_a_submission_failure_back_to_the_model(
    session, bound_models, queue, fake_storage, monkeypatch
) -> None:
    fake = _ScriptedClient(
        [
            _call(video_generate.TOOL_NAME, {"prompt": "a cat jumps"}),
            [_chunk("先去绑个视频模型吧")],
        ]
    )
    monkeypatch.setattr(studio_gpt, "_client", lambda _route: fake)
    chat = StudioGptChat(title="视频")
    session.add(chat)
    await session.commit()
    await session.refresh(chat)

    events = [event async for event in studio_gpt.stream_turn(session, chat, "做个视频")]

    assert not any(n == "task" for n, _ in events)
    tool_result = json.loads(fake.completions.calls[1]["messages"][-1]["content"])
    assert tool_result["ok"] is False
    assert video_generate.VIDEO_CAPABILITY in tool_result["error"]
    # 整轮没被这次失败毁掉：模型的收尾话照样落库
    assert events[-1][1]["turn"]["content"] == "先去绑个视频模型吧"


def test_locked_size_only_reaches_tools_that_declare_it() -> None:
    scope = studio_gpt.tool_scope()
    tools = get_kernel().tools
    image = tools.get(image_generate.TOOL_NAME, scope)
    edit = tools.get(image_edit.TOOL_NAME, scope)
    assert image is not None and edit is not None
    assert studio_gpt._locked_arguments(image, {"prompt": "x"}, "1024x1536") == {
        "prompt": "x",
        "size": "1024x1536",
    }
    assert studio_gpt._locked_arguments(edit, {"prompt": "x"}, "1024x1536") == {"prompt": "x"}


def test_declared_tools_keep_the_size_lock_for_image_generation_only() -> None:
    declared = {item["function"]["name"]: item for item in studio_gpt.tools_for_size("1088x1920")}
    assert set(declared) == {image_generate.TOOL_NAME, *TASK_TOOLS}
    generate = declared[image_generate.TOOL_NAME]["function"]["parameters"]["properties"]
    assert generate["size"]["enum"] == ["1088x1920"]
    assert "size" not in declared[image_edit.TOOL_NAME]["function"]["parameters"]["properties"]


def test_system_prompt_names_every_tool() -> None:
    """系统提示词与工具说明是模型选对工具的唯一依据，漏一个就等于没加。"""
    for name in (image_generate.TOOL_NAME, *TASK_TOOLS):
        assert name in studio_gpt.DEFAULT_SYSTEM, name


def test_submitted_result_tells_the_model_not_to_wait() -> None:
    value = submit.SubmittedTask(
        task_id="t-1", operation="video.generate", tool_id="video-director", status="queued",
        label="视频生成",
    )
    blocks = submit.render_submitted(SimpleNamespace(), value)
    payload = json.loads(blocks[0].text)
    assert payload["ok"] is True and payload["task_id"] == "t-1"
    assert "不要重复提交" in payload["note"]
