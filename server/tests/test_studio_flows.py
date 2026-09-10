"""创作工具 DAG：定义校验、快照、调度与恢复。"""

from sqlalchemy import select

from domain import studio_gpt
from domain.models import ImageAsset, StudioFlowRun, StudioTask
from domain.studio_flows import (
    StudioFlowError,
    advance_flow_run,
    create_flow,
    new_flow_run,
    new_inline_flow_run,
    normalize_definition,
    resolve_node_input,
    resume_flow_run,
)
from domain.studio_tasks import transition
from worker.tasks import run_studio_chat


def _definition() -> dict:
    return {
        "nodes": [
            {
                "id": "draft",
                "tool_id": "infinite-canvas",
                "operation": "image.generate",
                "input": {"prompt": {"$input": "prompt"}},
            },
            {
                "id": "polish",
                "tool_id": "infinite-canvas",
                "operation": "image.generate",
                "input": {
                    "prompt": {"$node": "draft", "path": "next_prompt"},
                    "quality": "high",
                },
            },
        ],
        "edges": [{"from": "draft", "to": "polish"}],
    }


def test_flow_definition_rejects_cycles_and_implicit_dependencies() -> None:
    cyclic = _definition()
    cyclic["edges"].append({"from": "polish", "to": "draft"})
    try:
        normalize_definition(cyclic)
    except StudioFlowError as exc:
        assert "存在环" in str(exc)
    else:
        raise AssertionError("环形 DAG 应被拒绝")

    missing_edge = _definition()
    missing_edge["edges"] = []
    try:
        normalize_definition(missing_edge)
    except StudioFlowError as exc:
        assert "必须建立直接连线" in str(exc)
    else:
        raise AssertionError("未声明依赖的节点引用应被拒绝")

    incoming_without_edge = {
        "nodes": [
            {
                "id": "join",
                "tool_id": "infinite-canvas",
                "operation": "chat.general",
                "input": {"prompt": "merge", "context": {"$incoming": "text"}},
            }
        ],
        "edges": [],
    }
    try:
        normalize_definition(incoming_without_edge)
    except StudioFlowError as exc:
        assert "至少要有一条入边" in str(exc)
    else:
        raise AssertionError("$incoming 没有直接上游时应被拒绝")


def test_resolve_node_input_flattens_direct_upstream_results_in_edge_order() -> None:
    checkpoint = {
        "first": {"status": "succeeded", "result": {"asset_ids": [7, 8]}},
        "second": {"status": "partial", "result": {"asset_ids": [9]}},
    }
    assert resolve_node_input(
        {"refs": {"$incoming": "asset_ids"}},
        inputs={},
        checkpoint_nodes=checkpoint,
        incoming_node_ids=["first", "second"],
    ) == {"refs": [7, 8, 9]}


def test_resolve_node_input_composes_text_and_projects_typed_artifacts() -> None:
    checkpoint = {
        "writer": {"status": "succeeded", "result": {"text": "cinematic light"}},
        "image": {"status": "succeeded", "result": {"asset_ids": [7, 7, 8]}},
        "workflow": {
            "status": "partial",
            "result": {
                "items": [
                    {"kind": "video", "media_asset_id": 12},
                    {"kind": "audio", "media_asset_id": 13},
                ]
            },
        },
    }
    resolved = resolve_node_input(
        {
            "prompt": {
                "$concat": [
                    {"$node": "writer", "path": "text"},
                    "portrait",
                    "portrait",
                ],
                "separator": "\n",
            },
            "image_ids": {
                "$artifacts": [{"$node": "image"}],
                "kinds": ["image"],
                "field": "asset_id",
                "limit": 16,
            },
            "ordered_image_ids": {
                "$artifacts": [
                    {"$node": "image"},
                    {"kind": "image", "asset_id": 8},
                    {"kind": "image", "asset_id": 10},
                ],
                "kinds": ["image"],
                "field": "asset_id",
                "limit": 16,
            },
            "typed_refs": {
                "$artifacts": [{"$node": "workflow"}],
                "kinds": ["video", "audio"],
                "field": "typed_ref",
            },
            "first_ref": {
                "$artifacts": [{"$node": "image"}],
                "kinds": ["image"],
                "field": "ref",
                "scalar": True,
                "default": "",
            },
        },
        inputs={},
        checkpoint_nodes=checkpoint,
        incoming_node_ids=["writer", "image", "workflow"],
    )
    assert resolved == {
        "prompt": "cinematic light\nportrait",
        "image_ids": [7, 8],
        "ordered_image_ids": [7, 8, 10],
        "typed_refs": [
            {"kind": "video", "ref": "media:12"},
            {"kind": "audio", "ref": "media:13"},
        ],
        "first_ref": "asset:7",
    }

    dynamic = resolve_node_input(
        {
            "$replace": {
                "$coalesce": [
                    {"$concat": ["", {"$node": "writer", "path": "text"}]},
                    "fallback",
                ]
            },
            "values": {"light": "light 2/5"},
        },
        inputs={},
        checkpoint_nodes=checkpoint,
        incoming_node_ids=["writer"],
    )
    assert dynamic == "cinematic light 2/5"


def test_inline_flow_run_freezes_definition_without_saved_flow() -> None:
    run = new_inline_flow_run(
        _definition(),
        inputs={"prompt": "frozen"},
        source_context={"kind": "canvas_cascade", "canvas_id": 3},
    )
    assert run.flow_id is None
    assert run.flow_version == 1
    assert run.definition_snapshot == normalize_definition(_definition())
    assert run.source_context == {"kind": "canvas_cascade", "canvas_id": 3}
    assert run.checkpoint["nodes"]["draft"]["status"] == "pending"


async def test_flow_api_persists_snapshot_before_enqueue(client, session, monkeypatch) -> None:
    calls: list[tuple] = []

    class Queue:
        async def enqueue_job(self, *args, **kwargs):
            calls.append((args, kwargs))

    async def fake_queue():
        return Queue()

    monkeypatch.setattr("app.routers.studio_flows.get_queue", fake_queue)
    created = await client.post(
        "/studio/flows",
        json={"title": "两步生图", "definition": _definition()},
    )
    assert created.status_code == 201, created.text
    flow = created.json()
    assert flow["node_count"] == 2
    assert flow["version"] == 1

    response = await client.post(
        f"/studio/flows/{flow['id']}/runs",
        json={
            "inputs": {"prompt": "a moonlit paper boat"},
            "source_context": {"canvas_id": 7, "node_id": "flow-node"},
        },
    )
    assert response.status_code == 202, response.text
    body = response.json()
    assert body["status"] == "queued"
    assert body["checkpoint"]["nodes"]["draft"]["status"] == "pending"
    assert calls == [
        (
            ("run_studio_flow", body["id"]),
            {"_job_id": f"studio-flow-tick:{body['id']}"},
        )
    ]
    stored = await session.get(StudioFlowRun, body["id"])
    assert stored is not None
    assert stored.definition_snapshot == flow["definition"]


async def test_inline_flow_api_persists_snapshot_before_enqueue(
    client, session, monkeypatch
) -> None:
    calls: list[tuple] = []

    class Queue:
        async def enqueue_job(self, *args, **kwargs):
            calls.append((args, kwargs))

    async def fake_queue():
        return Queue()

    monkeypatch.setattr("app.routers.studio_flows.get_queue", fake_queue)
    response = await client.post(
        "/studio/flows/runs",
        json={
            "definition": _definition(),
            "inputs": {"prompt": "inline"},
            "source_context": {"kind": "canvas_cascade", "canvas_id": 7},
        },
    )
    assert response.status_code == 202, response.text
    body = response.json()
    assert body["flow_id"] is None
    assert body["status"] == "queued"
    assert body["source_context"]["kind"] == "canvas_cascade"
    assert calls == [
        (
            ("run_studio_flow", body["id"]),
            {"_job_id": f"studio-flow-tick:{body['id']}"},
        )
    ]
    stored = await session.get(StudioFlowRun, body["id"])
    assert stored is not None
    assert stored.flow_id is None

    filtered = await client.get("/studio/flows/runs?canvas_id=7&context_kind=canvas_cascade")
    assert filtered.status_code == 200
    assert [item["id"] for item in filtered.json()["items"]] == [body["id"]]
    empty = await client.get("/studio/flows/runs?canvas_id=8&context_kind=canvas_cascade")
    assert empty.status_code == 200
    assert empty.json()["items"] == []

    cancelled = await client.post(f"/studio/flows/runs/{body['id']}/cancel")
    assert cancelled.status_code == 200, cancelled.text
    cancelled_body = cancelled.json()
    assert cancelled_body["status"] == "cancelled"
    assert cancelled_body["finished_at"] is not None
    assert cancelled_body["updated_at"] is not None


async def test_flow_advance_maps_outputs_and_completes_checkpoint(session) -> None:
    flow = await create_flow(
        session,
        title="两步生图",
        description=None,
        definition=_definition(),
    )
    run = new_flow_run(flow, inputs={"prompt": "first prompt"})
    session.add(run)
    await session.commit()
    calls: list[tuple] = []

    class Queue:
        async def enqueue_job(self, *args, **kwargs):
            calls.append((args, kwargs))

    first = await advance_flow_run(session, Queue(), run.id)
    assert first.run.status == "running"
    assert len(first.started_task_ids) == 1
    assert calls[0][0][0] == "generate_image"
    assert calls[0][1] == {"_job_id": f"studio-flow-node:{run.id}:draft"}

    draft = await session.get(StudioTask, first.started_task_ids[0])
    assert draft is not None
    assert draft.batch_id == run.id
    assert draft.source_context["flow_node_id"] == "draft"
    transition(draft, "running", stage="test")
    transition(
        draft,
        "succeeded",
        stage="completed",
        result={"next_prompt": "second prompt"},
    )
    await session.commit()

    second = await advance_flow_run(session, Queue(), run.id)
    assert second.run.status == "running"
    assert len(second.started_task_ids) == 1
    polish = await session.get(StudioTask, second.started_task_ids[0])
    assert polish is not None
    assert polish.parent_task_id == draft.id
    assert polish.invocation["prompt_override"] == "second prompt"
    transition(polish, "running", stage="test")
    transition(polish, "succeeded", stage="completed", result={"asset_ids": [42]})
    await session.commit()

    completed = await advance_flow_run(session, Queue(), run.id)
    assert completed.run.status == "succeeded"
    assert completed.needs_poll is False
    assert completed.run.checkpoint["nodes"]["draft"]["result"] == {"next_prompt": "second prompt"}
    assert completed.run.checkpoint["nodes"]["polish"]["result"] == {"asset_ids": [42]}


async def test_flow_applies_node_context_and_limits_parallel_tasks(session) -> None:
    definition = {
        "nodes": [
            {
                "id": node_id,
                "tool_id": "infinite-canvas",
                "operation": "chat.general",
                "input": {"prompt": node_id},
                "source_context": {"node_id": f"canvas-{node_id}", "round": 2},
            }
            for node_id in ("one", "two", "three")
        ],
        "edges": [],
    }
    run = new_inline_flow_run(
        definition,
        inputs={},
        source_context={"canvas_id": 9, "max_parallel_tasks": 2},
    )
    session.add(run)
    await session.commit()
    calls: list[tuple] = []

    class Queue:
        async def enqueue_job(self, *args, **kwargs):
            calls.append((args, kwargs))

    advanced = await advance_flow_run(session, Queue(), run.id)
    assert len(advanced.started_task_ids) == 2
    tasks = list(
        (
            await session.execute(
                select(StudioTask).where(StudioTask.id.in_(advanced.started_task_ids))
            )
        ).scalars()
    )
    assert {task.node_id for task in tasks} == {"canvas-one", "canvas-two"}
    assert {task.canvas_id for task in tasks} == {9}
    assert {task.source_context["round"] for task in tasks} == {2}
    assert all("max_parallel_tasks" not in task.source_context for task in tasks)
    assert run.checkpoint["nodes"]["three"]["status"] == "pending"


async def test_flow_image_auto_selects_generate_or_edit_after_input_resolution(session) -> None:
    source = ImageAsset(
        sha256="9" * 64,
        storage_key="images/test/flow-auto.png",
        mime="image/png",
        width=64,
        height=64,
        bytes=16,
        target_key="free",
        prompt="source",
        source="test",
    )
    session.add(source)
    await session.commit()
    await session.refresh(source)
    run = new_inline_flow_run(
        {
            "nodes": [
                {
                    "id": "generate",
                    "tool_id": "infinite-canvas",
                    "operation": "image.auto",
                    "input": {"prompt": "new image", "ref_asset_ids": []},
                },
                {
                    "id": "edit",
                    "tool_id": "infinite-canvas",
                    "operation": "image.auto",
                    "input": {
                        "prompt": "edit image",
                        "ref_asset_ids": [source.id],
                        "size": "1024x1024",
                    },
                },
            ],
            "edges": [],
        },
        inputs={},
    )
    session.add(run)
    await session.commit()
    calls: list[tuple] = []

    class Queue:
        async def enqueue_job(self, *args, **kwargs):
            calls.append((args, kwargs))

    advanced = await advance_flow_run(session, Queue(), run.id)
    tasks = list(
        (
            await session.execute(
                select(StudioTask).where(StudioTask.id.in_(advanced.started_task_ids))
            )
        ).scalars()
    )
    by_type = {task.task_type: task for task in tasks}
    assert set(by_type) == {"image.generate", "image.edit"}
    assert by_type["image.edit"].invocation["ref_asset_ids"] == [source.id]
    assert by_type["image.edit"].invocation["size"] is None
    assert {call[0][0] for call in calls} == {"generate_image", "edit_image_task"}


async def test_flow_reuses_identical_image_request_and_projects_result_to_each_node(
    session,
) -> None:
    definition = {
        "nodes": [
            {
                "id": node_id,
                "tool_id": "infinite-canvas",
                "operation": "image.generate",
                "input": {
                    "prompt": "same request",
                    "size": "1024x1024",
                    "quality": "high",
                },
            }
            for node_id in ("left", "right")
        ],
        "edges": [],
    }
    run = new_inline_flow_run(definition, inputs={})
    session.add(run)
    await session.commit()
    calls: list[tuple] = []

    class Queue:
        async def enqueue_job(self, *args, **kwargs):
            calls.append((args, kwargs))

    first = await advance_flow_run(session, Queue(), run.id)
    assert len(first.started_task_ids) == 1
    assert len(calls) == 1
    checkpoint = first.run.checkpoint["nodes"]
    assert checkpoint["left"]["task_id"] == checkpoint["right"]["task_id"]
    assert checkpoint["left"]["request_key"] == checkpoint["right"]["request_key"]

    task = await session.get(StudioTask, first.started_task_ids[0])
    assert task is not None
    transition(task, "running", stage="test")
    transition(task, "succeeded", stage="completed", result={"asset_ids": [91]})
    await session.commit()

    completed = await advance_flow_run(session, Queue(), run.id)
    assert completed.run.status == "succeeded"
    assert completed.run.checkpoint["nodes"]["left"]["result"] == {"asset_ids": [91]}
    assert completed.run.checkpoint["nodes"]["right"]["result"] == {"asset_ids": [91]}
    tasks = list(
        (await session.execute(select(StudioTask).where(StudioTask.batch_id == run.id))).scalars()
    )
    assert [item.id for item in tasks] == [task.id]


async def test_resume_flow_keeps_success_and_continues_failed_checkpoint(session) -> None:
    definition = {
        "nodes": [
            {
                "id": node_id,
                "tool_id": "infinite-canvas",
                "operation": "chat.general",
                "input": {
                    "prompt": node_id if previous is None else {"$node": previous, "path": "text"}
                },
            }
            for node_id, previous in (("one", None), ("two", "one"), ("three", "two"))
        ],
        "edges": [{"from": "one", "to": "two"}, {"from": "two", "to": "three"}],
    }
    original = new_inline_flow_run(definition, inputs={})
    original.status = "failed"
    original.checkpoint["nodes"]["one"].update(
        {"status": "succeeded", "task_id": "task-one", "result": {"text": "kept"}}
    )
    original.checkpoint["nodes"]["two"].update(
        {"status": "failed", "task_id": "task-two", "error": "boom", "attempt": 1}
    )
    resumed = resume_flow_run(original)
    assert resumed.parent_run_id == original.id
    assert resumed.checkpoint["nodes"]["one"] == original.checkpoint["nodes"]["one"]
    assert resumed.checkpoint["nodes"]["two"] == {
        "status": "pending",
        "task_id": None,
        "attempt": 1,
        "result": None,
        "error": None,
    }
    assert resumed.checkpoint["nodes"]["three"]["status"] == "pending"


async def test_resume_flow_api_persists_checkpoint_before_enqueue(
    client, session, monkeypatch
) -> None:
    original = new_inline_flow_run(
        _definition(),
        inputs={"prompt": "resume me"},
        source_context={"kind": "canvas_cascade", "canvas_id": 17},
    )
    original.status = "failed"
    original.checkpoint["nodes"]["draft"].update(
        {
            "status": "succeeded",
            "task_id": "completed-task",
            "result": {"next_prompt": "keep this"},
        }
    )
    original.checkpoint["nodes"]["polish"].update(
        {"status": "failed", "task_id": "failed-task", "error": "boom"}
    )
    session.add(original)
    await session.commit()
    calls: list[tuple] = []

    class Queue:
        async def enqueue_job(self, *args, **kwargs):
            calls.append((args, kwargs))

    async def fake_queue():
        return Queue()

    monkeypatch.setattr("app.routers.studio_flows.get_queue", fake_queue)
    response = await client.post(f"/studio/flows/runs/{original.id}/resume")
    assert response.status_code == 202, response.text
    body = response.json()
    assert body["id"] != original.id
    assert body["parent_run_id"] == original.id
    assert body["checkpoint"]["nodes"]["draft"] == original.checkpoint["nodes"]["draft"]
    assert body["checkpoint"]["nodes"]["polish"]["status"] == "pending"
    assert body["checkpoint"]["nodes"]["polish"]["task_id"] is None
    assert calls == [
        (
            ("run_studio_flow", body["id"]),
            {"_job_id": f"studio-flow-tick:{body['id']}"},
        )
    ]

    stored = await session.get(StudioFlowRun, body["id"])
    assert stored is not None
    assert stored.parent_run_id == original.id

    conflict = await client.post(f"/studio/flows/runs/{body['id']}/resume")
    assert conflict.status_code == 409


async def test_recovering_flow_requeues_adopted_queued_node_with_stable_id(session) -> None:
    flow = await create_flow(
        session,
        title="恢复测试",
        description=None,
        definition={"nodes": [_definition()["nodes"][0]], "edges": []},
    )
    run = new_flow_run(flow, inputs={"prompt": "recover me"})
    session.add(run)
    await session.commit()
    calls: list[tuple] = []

    class Queue:
        async def enqueue_job(self, *args, **kwargs):
            calls.append((args, kwargs))

    first = await advance_flow_run(session, Queue(), run.id)
    task_id = first.started_task_ids[0]
    run = await session.get(StudioFlowRun, run.id)
    run.status = "recovering"
    await session.commit()

    recovered = await advance_flow_run(session, Queue(), run.id)
    assert recovered.active_task_ids == (task_id,)
    assert calls[-1][1] == {"_job_id": f"studio-flow-node:{run.id}:draft"}
    tasks = list(
        (await session.execute(select(StudioTask).where(StudioTask.batch_id == run.id))).scalars()
    )
    assert [task.id for task in tasks] == [task_id]


async def test_flow_merges_two_llm_outputs_and_worker_completes_join(
    session, session_factory, monkeypatch
) -> None:
    definition = {
        "nodes": [
            {
                "id": "left",
                "tool_id": "infinite-canvas",
                "operation": "chat.general",
                "input": {"prompt": "left draft"},
            },
            {
                "id": "right",
                "tool_id": "infinite-canvas",
                "operation": "chat.general",
                "input": {"prompt": "right draft"},
            },
            {
                "id": "join",
                "tool_id": "infinite-canvas",
                "operation": "chat.general",
                "input": {
                    "prompt": "merge both drafts",
                    "context": {"$incoming": "text"},
                },
            },
        ],
        "edges": [
            {"from": "left", "to": "join"},
            {"from": "right", "to": "join"},
        ],
    }
    flow = await create_flow(session, title="LLM merge", description=None, definition=definition)
    run = new_flow_run(flow, inputs={})
    session.add(run)
    await session.commit()
    calls: list[tuple] = []

    class Queue:
        async def enqueue_job(self, *args, **kwargs):
            calls.append((args, kwargs))

    first = await advance_flow_run(session, Queue(), run.id)
    assert len(first.started_task_ids) == 2
    assert [call[0][0] for call in calls] == ["run_studio_chat", "run_studio_chat"]
    source_tasks = list(
        (
            await session.execute(
                select(StudioTask).where(StudioTask.id.in_(first.started_task_ids))
            )
        ).scalars()
    )
    by_node = {task.source_context["flow_node_id"]: task for task in source_tasks}
    for node_id, text in (("left", "alpha"), ("right", "beta")):
        task = by_node[node_id]
        transition(task, "running", stage="test")
        transition(task, "succeeded", stage="completed", result={"text": text})
    await session.commit()

    second = await advance_flow_run(session, Queue(), run.id)
    assert len(second.started_task_ids) == 1
    join = await session.get(StudioTask, second.started_task_ids[0])
    assert join is not None
    assert join.invocation["context"] == ["alpha", "beta"]
    assert join.parent_task_id is None
    assert join.source_context["parent_task_ids"] == [
        by_node["left"].id,
        by_node["right"].id,
    ]
    invocation = dict(join.invocation or {})
    invocation["video_media_asset_ids"] = [31]
    join.invocation = invocation
    await session.commit()

    captured: dict = {}

    async def fake_complete(alias, messages, temperature, *, deployment_id=None):
        captured.update(
            {
                "alias": alias,
                "messages": messages,
                "temperature": temperature,
                "deployment_id": deployment_id,
            }
        )
        return "merged result"

    async def fake_video_blocks(_session, asset_ids):
        assert asset_ids == [31]
        return [{"type": "text", "text": "视频关键帧"}]

    monkeypatch.setattr("worker.tasks.SessionFactory", session_factory)
    monkeypatch.setattr("worker.tasks.complete_text", fake_complete)
    monkeypatch.setattr(studio_gpt, "video_blocks", fake_video_blocks)
    result = await run_studio_chat({}, join.id)
    assert result == {"ok": True, "text": "merged result"}
    assert captured["alias"] == "chat-general"
    assert captured["messages"][-1]["content"] == [
        {
            "type": "text",
            "text": "参考上游结果：\n- alpha\n- beta\n\n当前任务：\nmerge both drafts",
        },
        {"type": "text", "text": "视频关键帧"},
    ]

    await session.refresh(join)
    completed = await advance_flow_run(session, Queue(), run.id)
    assert completed.run.status == "succeeded"
    assert completed.run.checkpoint["nodes"]["join"]["result"] == {"text": "merged result"}
