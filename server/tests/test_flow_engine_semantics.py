"""DAG 引擎的调度语义：条件、失败策略、重试、超时、map、子工作流、人工输入与触发器。"""

from __future__ import annotations

import copy
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.dialects import postgresql

from domain.models import StudioFlowInterrupt, StudioFlowRun, StudioTask
from domain.studio_flows import (
    StudioFlowError,
    advance_flow_run,
    create_flow,
    create_trigger,
    derive_input_schema,
    due_cron_triggers,
    fire_task_terminal_triggers,
    fire_trigger,
    flow_tick_job_id,
    lock_run_statement,
    new_flow_run,
    new_inline_flow_run,
    normalize_definition,
    promote_run_to_flow,
    resume_flow_input,
)
from domain.studio_tasks import cancel_key, new_task, transition

TOOL = "infinite-canvas"


class FakeQueue:
    """既当队列又当取消通道：DAG 超时会顺手对子任务发取消，两套动词都要有。"""

    def __init__(self) -> None:
        self.calls: list[tuple] = []
        self.store: dict[str, object] = {}
        self.sorted: dict[str, dict[str, float]] = {}

    async def enqueue_job(self, *args, **kwargs):
        self.calls.append((args, kwargs))

    async def get(self, key: str):
        return self.store.get(key)

    async def set(self, key: str, value, *, ex: int | None = None):
        self.store[key] = value

    async def delete(self, *keys: str):
        for key in keys:
            self.store.pop(key, None)

    async def zadd(self, key: str, mapping: dict[str, float]):
        self.sorted.setdefault(key, {}).update(mapping)


def _chat(node_id: str, prompt: object = "写点什么", **extra) -> dict:
    node = {
        "id": node_id,
        "tool_id": TOOL,
        "operation": "chat.general",
        "input": {"prompt": prompt},
    }
    node.update(extra)
    return node


async def _finish(session, task_id: str, *, status: str = "succeeded", result=None) -> StudioTask:
    task = await session.get(StudioTask, task_id)
    assert task is not None
    transition(task, "running", stage="test")
    transition(task, status, stage="completed", result=result, error=None if result else "boom")
    await session.commit()
    return task


async def _run(session, definition: dict, *, inputs: dict | None = None) -> StudioFlowRun:
    row = new_inline_flow_run(definition, inputs=inputs or {})
    session.add(row)
    await session.commit()
    return row


def _states(run: StudioFlowRun) -> dict:
    return run.checkpoint["nodes"]


# ---- when：条件为假判 skipped，下游照跑 ----------------------------------------


async def test_when_false_skips_node_and_downstream_still_runs(session) -> None:
    run = await _run(
        session,
        {
            "nodes": [
                _chat("maybe", when={"$input": "flag"}),
                _chat("after", "收尾"),
            ],
            "edges": [{"from": "maybe", "to": "after"}],
        },
        inputs={"flag": False},
    )
    queue = FakeQueue()

    first = await advance_flow_run(session, queue, run.id)
    assert _states(first.run)["maybe"]["status"] == "skipped"
    assert len(first.started_task_ids) == 1

    await _finish(session, first.started_task_ids[0], result={"text": "ok"})
    done = await advance_flow_run(session, queue, run.id)
    # 被条件跳过不算失败：整条运行仍是 succeeded
    assert done.run.status == "succeeded"
    assert done.run.checkpoint["nodes"]["after"]["result"] == {"text": "ok"}


async def test_when_true_runs_the_node(session) -> None:
    run = await _run(
        session,
        {"nodes": [_chat("maybe", when={"$input": "flag"})], "edges": []},
        inputs={"flag": True},
    )
    advanced = await advance_flow_run(session, FakeQueue(), run.id)
    assert len(advanced.started_task_ids) == 1
    assert _states(advanced.run)["maybe"]["status"] == "queued"


# ---- on_failure 三分支 --------------------------------------------------------


async def test_fail_run_is_still_the_default(session) -> None:
    run = await _run(session, {"nodes": [_chat("only")], "edges": []})
    queue = FakeQueue()
    first = await advance_flow_run(session, queue, run.id)
    await _finish(session, first.started_task_ids[0], status="failed")

    done = await advance_flow_run(session, queue, run.id)
    assert done.run.status == "failed"
    assert "节点 only 失败" in (done.run.error or "")


async def test_skip_downstream_marks_descendants_and_keeps_other_branches(session) -> None:
    run = await _run(
        session,
        {
            "nodes": [
                _chat("head", on_failure="skip_downstream"),
                _chat("mid", "中间"),
                _chat("tail", "结尾"),
                _chat("side", "旁路"),
            ],
            "edges": [{"from": "head", "to": "mid"}, {"from": "mid", "to": "tail"}],
        },
    )
    queue = FakeQueue()
    first = await advance_flow_run(session, queue, run.id)
    assert len(first.started_task_ids) == 2  # head 与 side 并行

    by_node = {}
    for task_id in first.started_task_ids:
        task = await session.get(StudioTask, task_id)
        by_node[task.source_context["flow_node_id"]] = task
    await _finish(session, by_node["head"].id, status="failed")
    await _finish(session, by_node["side"].id, result={"text": "旁路完成"})

    done = await advance_flow_run(session, queue, run.id)
    states = _states(done.run)
    assert states["mid"]["status"] == "skipped"
    assert states["tail"]["status"] == "skipped"
    assert states["side"]["status"] == "succeeded"
    # 有失败但整条跑完：partial 而不是 failed
    assert done.run.status == "partial"


async def test_continue_lets_downstream_run_after_a_failed_node(session) -> None:
    run = await _run(
        session,
        {
            "nodes": [
                _chat("head", on_failure="continue"),
                _chat("tail", "不依赖上游结果"),
            ],
            "edges": [{"from": "head", "to": "tail"}],
        },
    )
    queue = FakeQueue()
    first = await advance_flow_run(session, queue, run.id)
    await _finish(session, first.started_task_ids[0], status="failed")

    second = await advance_flow_run(session, queue, run.id)
    assert second.run.status == "running"
    assert len(second.started_task_ids) == 1

    await _finish(session, second.started_task_ids[0], result={"text": "继续"})
    done = await advance_flow_run(session, queue, run.id)
    assert done.run.status == "partial"
    assert _states(done.run)["head"]["status"] == "failed"


# ---- retry ------------------------------------------------------------------


async def test_retry_starts_a_new_attempt_and_gives_up_after_the_budget(session) -> None:
    run = await _run(
        session,
        {"nodes": [_chat("flaky", retry={"max": 1, "backoff_ms": 0})], "edges": []},
    )
    queue = FakeQueue()
    first = await advance_flow_run(session, queue, run.id)
    await _finish(session, first.started_task_ids[0], status="failed")

    second = await advance_flow_run(session, queue, run.id)
    assert second.run.status == "running"
    assert len(second.started_task_ids) == 1
    assert second.started_task_ids[0] != first.started_task_ids[0]
    state = _states(second.run)["flaky"]
    assert state["attempt"] == 2
    assert state["retried_task_ids"] == [first.started_task_ids[0]]

    await _finish(session, second.started_task_ids[0], status="failed")
    done = await advance_flow_run(session, queue, run.id)
    assert done.run.status == "failed"
    tasks = list(
        (await session.execute(select(StudioTask).where(StudioTask.batch_id == run.id))).scalars()
    )
    assert len(tasks) == 2


async def test_retry_backoff_holds_the_node_until_the_delay_passes(session) -> None:
    run = await _run(
        session,
        {"nodes": [_chat("flaky", retry={"max": 2, "backoff_ms": 600_000})], "edges": []},
    )
    queue = FakeQueue()
    first = await advance_flow_run(session, queue, run.id)
    await _finish(session, first.started_task_ids[0], status="failed")

    second = await advance_flow_run(session, queue, run.id)
    assert second.started_task_ids == ()
    # 退避期内不重开任务，但运行还得继续轮询
    assert second.run.status == "running"
    assert second.needs_poll is True
    assert _states(second.run)["flaky"]["retry_after"] > datetime.now(UTC).isoformat()


# ---- timeout + 取消传播 --------------------------------------------------------


async def test_timeout_fails_the_node_and_cancels_its_child_task(session) -> None:
    run = await _run(session, {"nodes": [_chat("slow", timeout_s=30)], "edges": []})
    queue = FakeQueue()
    first = await advance_flow_run(session, queue, run.id)
    task = await session.get(StudioTask, first.started_task_ids[0])
    transition(task, "running", stage="test")
    checkpoint = copy.deepcopy(first.run.checkpoint)
    checkpoint["nodes"]["slow"]["started_at"] = (
        datetime.now(UTC) - timedelta(seconds=120)
    ).isoformat()
    run_row = await session.get(StudioFlowRun, run.id)
    run_row.checkpoint = checkpoint
    await session.commit()

    done = await advance_flow_run(session, queue, run.id)
    assert done.run.status == "failed"
    assert "TIMEOUT" in _states(done.run)["slow"]["error"]
    assert queue.store[cancel_key(task.id)] == "1"


# ---- map --------------------------------------------------------------------


def _map_definition() -> dict:
    return {
        "nodes": [
            _chat("seed", "列几个词"),
            {
                "id": "fan",
                "kind": "map",
                "over": {"$node": "seed", "path": "items"},
                "template": {
                    "kind": "tool",
                    "tool_id": TOOL,
                    "operation": "chat.general",
                    "input": {"prompt": {"$item": ""}},
                    "on_failure": "continue",
                },
            },
            _chat("join", {"$node": "fan", "path": "results.0.text"}),
        ],
        "edges": [{"from": "seed", "to": "fan"}, {"from": "fan", "to": "join"}],
    }


async def test_map_expands_instances_aggregates_results_and_is_idempotent(session) -> None:
    run = await _run(session, _map_definition())
    queue = FakeQueue()
    first = await advance_flow_run(session, queue, run.id)
    await _finish(session, first.started_task_ids[0], result={"items": ["月亮", "河流"]})

    second = await advance_flow_run(session, queue, run.id)
    assert len(second.started_task_ids) == 2
    node_ids = [str(node["id"]) for node in second.run.definition_snapshot["nodes"]]
    assert node_ids == ["seed", "fan", "join", "fan.0", "fan.1"]
    assert _states(second.run)["fan"]["instances"] == ["fan.0", "fan.1"]
    prompts = {}
    for task_id in second.started_task_ids:
        task = await session.get(StudioTask, task_id)
        prompts[task.source_context["flow_node_id"]] = task.invocation["prompt"]
    assert prompts == {"fan.0": "月亮", "fan.1": "河流"}

    # 再 tick 一次不会重复展开
    again = await advance_flow_run(session, queue, run.id)
    assert len(again.run.definition_snapshot["nodes"]) == 5
    assert again.started_task_ids == ()

    for task_id, text in zip(second.started_task_ids, ("A", "B"), strict=True):
        await _finish(session, task_id, result={"text": text})
    third = await advance_flow_run(session, queue, run.id)
    fan = _states(third.run)["fan"]
    assert fan["status"] == "succeeded"
    assert fan["result"]["count"] == 2
    assert fan["result"]["results"] == [{"text": "A"}, {"text": "B"}]
    join_task = await session.get(StudioTask, third.started_task_ids[0])
    assert join_task.invocation["prompt"] == "A"


async def test_map_marks_partial_when_an_instance_fails(session) -> None:
    run = await _run(session, _map_definition())
    queue = FakeQueue()
    first = await advance_flow_run(session, queue, run.id)
    await _finish(session, first.started_task_ids[0], result={"items": ["一", "二"]})
    second = await advance_flow_run(session, queue, run.id)
    await _finish(session, second.started_task_ids[0], result={"text": "好"})
    await _finish(session, second.started_task_ids[1], status="failed")

    third = await advance_flow_run(session, queue, run.id)
    fan = _states(third.run)["fan"]
    assert fan["status"] == "partial"
    assert fan["result"]["results"] == [{"text": "好"}]


async def test_map_rejects_non_list_over_and_item_outside_template() -> None:
    definition = _map_definition()
    try:
        normalize_definition(
            {
                "nodes": [_chat("solo", {"$item": ""})],
                "edges": [],
            }
        )
    except StudioFlowError as exc:
        assert "$item/$index 只能出现在" in str(exc)
    else:
        raise AssertionError("模板之外的 $item 应被拒绝")

    bad_template = copy.deepcopy(definition)
    bad_template["nodes"][1]["template"]["id"] = "fan"
    try:
        normalize_definition(bad_template)
    except StudioFlowError as exc:
        assert "不能沿用 map 节点自己的 id" in str(exc)
    else:
        raise AssertionError("模板复用 map 自己的 id 应被拒绝")


async def test_map_over_must_resolve_to_a_list(session) -> None:
    run = await _run(session, _map_definition())
    queue = FakeQueue()
    first = await advance_flow_run(session, queue, run.id)
    await _finish(session, first.started_task_ids[0], result={"items": "不是数组"})
    second = await advance_flow_run(session, queue, run.id)
    assert second.run.status == "failed"
    assert "必须求值成数组" in _states(second.run)["fan"]["error"]


# ---- subflow ----------------------------------------------------------------


async def _child_flow(session):
    return await create_flow(
        session,
        title="子流程",
        description=None,
        definition={
            "nodes": [
                {"id": "topic", "kind": "input", "name": "topic"},
                _chat("write", {"$node": "topic", "path": "value"}),
                {
                    "id": "out",
                    "kind": "output",
                    "name": "text",
                    "value": {"$node": "write", "path": "text"},
                },
            ],
            "edges": [{"from": "topic", "to": "write"}, {"from": "write", "to": "out"}],
        },
    )


async def test_subflow_starts_a_child_run_and_hands_outputs_back(session) -> None:
    child_flow = await _child_flow(session)
    parent = await _run(
        session,
        {
            "nodes": [
                {
                    "id": "call",
                    "kind": "subflow",
                    "flow_id": child_flow.id,
                    "inputs": {"topic": "月亮"},
                },
                _chat("after", {"$node": "call", "path": "outputs.text"}),
            ],
            "edges": [{"from": "call", "to": "after"}],
        },
    )
    queue = FakeQueue()
    first = await advance_flow_run(session, queue, parent.id)
    assert len(first.started_task_ids) == 1
    call_state = _states(first.run)["call"]
    child_run_id = call_state["child_run_id"]
    assert queue.calls[-1] == (
        ("run_studio_flow", child_run_id),
        {"_job_id": flow_tick_job_id(child_run_id)},
    )
    child = await session.get(StudioFlowRun, child_run_id)
    assert child.parent_run_id == parent.id
    assert child.inputs == {"topic": "月亮"}

    child_first = await advance_flow_run(session, queue, child_run_id)
    assert _states(child_first.run)["topic"]["result"] == {"name": "topic", "value": "月亮"}
    write_task = await session.get(StudioTask, child_first.started_task_ids[0])
    assert write_task.invocation["prompt"] == "月亮"
    await _finish(session, write_task.id, result={"text": "一首关于月亮的诗"})

    child_done = await advance_flow_run(session, queue, child_run_id)
    assert child_done.run.status == "succeeded"
    assert child_done.run.outputs == {"text": "一首关于月亮的诗"}
    wrapper = await session.get(StudioTask, call_state["task_id"])
    assert wrapper.status == "succeeded"
    assert wrapper.result["outputs"] == {"text": "一首关于月亮的诗"}
    # 子运行终态要把父运行叫醒
    assert queue.calls[-1][1]["_job_id"] == flow_tick_job_id(
        parent.id, marker=f"child:{child_run_id}"
    )

    parent_second = await advance_flow_run(session, queue, parent.id)
    after_task = await session.get(StudioTask, parent_second.started_task_ids[0])
    assert after_task.invocation["prompt"] == "一首关于月亮的诗"


async def test_subflow_rejects_a_missing_flow(session) -> None:
    parent = await _run(
        session,
        {"nodes": [{"id": "call", "kind": "subflow", "flow_id": 999_999}], "edges": []},
    )
    advanced = await advance_flow_run(session, FakeQueue(), parent.id)
    assert advanced.run.status == "failed"
    assert "工作流不存在" in _states(advanced.run)["call"]["error"]


# ---- 人工输入挂起与恢复 ---------------------------------------------------------


def _waiting_definition() -> dict:
    return {
        "nodes": [
            {"id": "brief", "kind": "input", "name": "brief", "schema": {"type": "string"}},
            _chat("write", {"$node": "brief", "path": "value"}),
        ],
        "edges": [{"from": "brief", "to": "write"}],
    }


async def test_missing_input_suspends_the_run_and_records_one_interrupt(session) -> None:
    run = await _run(session, _waiting_definition())
    queue = FakeQueue()

    first = await advance_flow_run(session, queue, run.id)
    assert first.run.status == "waiting_input"
    assert first.run.waiting_node_id == "brief"
    assert first.needs_poll is False
    assert first.started_task_ids == ()

    # 再 tick 一次不会写第二条挂起点
    await advance_flow_run(session, queue, run.id)
    rows = list(
        (
            await session.execute(
                select(StudioFlowInterrupt).where(StudioFlowInterrupt.run_id == run.id)
            )
        ).scalars()
    )
    assert [(row.node_id, row.status) for row in rows] == [("brief", "waiting")]
    assert rows[0].payload == {"name": "brief", "schema": {"type": "string"}}

    await resume_flow_input(session, first.run, node_id="brief", resume_value="夜色")
    assert first.run.status == "queued"
    assert first.run.waiting_node_id is None
    assert first.run.inputs["brief"] == "夜色"
    await session.refresh(rows[0])
    assert rows[0].status == "resolved"
    assert rows[0].resume_value == {"value": "夜色"}

    resumed = await advance_flow_run(session, queue, run.id)
    write_task = await session.get(StudioTask, resumed.started_task_ids[0])
    assert write_task.invocation["prompt"] == "夜色"


async def test_input_node_default_value_never_suspends(session) -> None:
    definition = _waiting_definition()
    definition["nodes"][0]["value"] = "默认题目"
    run = await _run(session, definition)
    advanced = await advance_flow_run(session, FakeQueue(), run.id)
    assert advanced.run.status == "running"
    task = await session.get(StudioTask, advanced.started_task_ids[0])
    assert task.invocation["prompt"] == "默认题目"


async def test_resume_rejects_a_value_that_breaks_the_node_schema(session) -> None:
    run = await _run(session, _waiting_definition())
    advanced = await advance_flow_run(session, FakeQueue(), run.id)
    try:
        await resume_flow_input(session, advanced.run, node_id="brief", resume_value=7)
    except StudioFlowError as exc:
        assert exc.status == 422
    else:
        raise AssertionError("不符合 schema 的人工输入应被拒绝")


async def test_resume_api_fills_the_waiting_node_and_requeues_one_tick(
    client, session, monkeypatch
) -> None:
    queue = FakeQueue()

    async def fake_queue():
        return queue

    monkeypatch.setattr("app.routers.studio_flows.get_queue", fake_queue)
    run = await _run(session, _waiting_definition())
    await advance_flow_run(session, queue, run.id)

    listed = await client.get(f"/studio/flows/runs/{run.id}/interrupts")
    assert [item["node_id"] for item in listed.json()["items"]] == ["brief"]

    response = await client.post(
        f"/studio/flows/runs/{run.id}/resume",
        json={"node_id": "brief", "resume_value": "海雾"},
    )
    assert response.status_code == 202, response.text
    body = response.json()
    assert body["id"] == run.id
    assert body["status"] == "queued"
    assert body["waiting_node_id"] is None
    assert queue.calls[-1] == (
        ("run_studio_flow", run.id),
        {"_job_id": flow_tick_job_id(run.id, marker="resume:brief")},
    )


# ---- promote：把跑过的运行固化成模板 --------------------------------------------


async def test_promote_derives_input_schema_and_the_new_flow_runs_again(
    client, session, monkeypatch
) -> None:
    queue = FakeQueue()

    async def fake_queue():
        return queue

    monkeypatch.setattr("app.routers.studio_flows.get_queue", fake_queue)
    run = await _run(session, _waiting_definition(), inputs={"brief": "第一次"})
    await advance_flow_run(session, queue, run.id)

    promoted = await client.post(
        f"/studio/flows/runs/{run.id}/promote", json={"title": "写一段文案"}
    )
    assert promoted.status_code == 201, promoted.text
    flow = promoted.json()
    assert flow["input_schema"] == {
        "type": "object",
        "properties": {"brief": {"type": "string"}},
        "required": ["brief"],
        "additionalProperties": True,
    }

    schema = await client.get(f"/studio/flows/{flow['id']}/schema")
    assert schema.json()["inputs"] == [
        {"name": "brief", "schema": {"type": "string"}, "default": None, "required": True}
    ]
    assert schema.json()["outputs"] == []

    rejected = await client.post(f"/studio/flows/{flow['id']}/runs", json={"inputs": {}})
    assert rejected.status_code == 422

    accepted = await client.post(
        f"/studio/flows/{flow['id']}/runs", json={"inputs": {"brief": "第二次"}}
    )
    assert accepted.status_code == 202, accepted.text
    assert accepted.json()["inputs"] == {"brief": "第二次"}


def test_promote_falls_back_to_the_real_inputs_when_there_is_no_input_node() -> None:
    definition = normalize_definition({"nodes": [_chat("only")], "edges": []})
    schema = derive_input_schema(definition, sample_inputs={"prompt": "x", "n": 2})
    assert schema["properties"] == {"prompt": {"type": "string"}, "n": {"type": "integer"}}
    assert schema["required"] == []


async def test_promoted_flow_keeps_the_snapshot(session) -> None:
    run = await _run(session, _waiting_definition())
    flow = await promote_run_to_flow(session, run, title=None, description="从运行固化")
    assert flow.definition == run.definition_snapshot
    assert flow.title.startswith("运行 ")
    assert flow.description == "从运行固化"


# ---- 触发器 -------------------------------------------------------------------


async def test_cron_trigger_fires_once_per_due_point(session) -> None:
    flow = await create_flow(
        session,
        title="每分钟",
        description=None,
        definition={"nodes": [_chat("tick")], "edges": []},
    )
    trigger = await create_trigger(
        session,
        flow_id=flow.id,
        kind="cron",
        cron="* * * * *",
        inputs={"prompt": "定时"},
    )
    queue = FakeQueue()
    later = datetime.now(UTC) + timedelta(minutes=2)

    due = await due_cron_triggers(session, now=later)
    assert [row.id for row in due] == [trigger.id]

    run = await fire_trigger(session, queue, trigger, now=later)
    assert run.flow_id == flow.id
    assert run.inputs == {"prompt": "定时"}
    assert run.source_context["kind"] == "trigger"
    assert queue.calls[-1] == (
        ("run_studio_flow", run.id),
        {"_job_id": flow_tick_job_id(run.id)},
    )
    # 触发过一次就要等下一个点，重复扫描不会再建 run
    assert await due_cron_triggers(session, now=later) == []


async def test_task_terminal_trigger_matches_type_and_status(session) -> None:
    flow = await create_flow(
        session,
        title="出图之后",
        description=None,
        definition={"nodes": [_chat("after")], "edges": []},
    )
    trigger = await create_trigger(
        session,
        flow_id=flow.id,
        kind="task_terminal",
        task_type="image.generate",
        statuses=["succeeded"],
    )
    queue = FakeQueue()
    task = new_task(tool_id=TOOL, task_type="image.generate", invocation={})
    session.add(task)
    await session.commit()
    transition(task, "running", stage="test")
    transition(task, "failed", stage="done", error="boom")
    await session.commit()
    assert await fire_task_terminal_triggers(session, queue, task) == []

    ok = new_task(tool_id=TOOL, task_type="image.generate", invocation={})
    session.add(ok)
    await session.commit()
    transition(ok, "running", stage="test")
    transition(ok, "succeeded", stage="done", result={"asset_ids": [3]})
    await session.commit()
    fired = await fire_task_terminal_triggers(session, queue, ok)
    assert len(fired) == 1
    run = await session.get(StudioFlowRun, fired[0])
    assert run.inputs["task_id"] == ok.id
    assert run.inputs["task_result"] == {"asset_ids": [3]}
    assert run.source_context["trigger_id"] == trigger.id


async def test_trigger_crud_validates_and_lists(client, session) -> None:
    created = await client.post(
        "/studio/flows",
        json={"title": "触发器宿主", "definition": {"nodes": [_chat("only")], "edges": []}},
    )
    flow_id = created.json()["id"]

    bad_cron = await client.post(
        f"/studio/flows/{flow_id}/triggers", json={"kind": "cron", "cron": "不是 cron"}
    )
    assert bad_cron.status_code == 400
    missing_type = await client.post(
        f"/studio/flows/{flow_id}/triggers", json={"kind": "task_terminal"}
    )
    assert missing_type.status_code == 400
    unknown_kind = await client.post(f"/studio/flows/{flow_id}/triggers", json={"kind": "webhook"})
    assert unknown_kind.status_code == 400

    ok = await client.post(
        f"/studio/flows/{flow_id}/triggers",
        json={"kind": "cron", "cron": "0 * * * *", "inputs": {"prompt": "整点"}},
    )
    assert ok.status_code == 201, ok.text
    trigger_id = ok.json()["id"]
    listed = await client.get(f"/studio/flows/{flow_id}/triggers")
    assert [item["id"] for item in listed.json()["items"]] == [trigger_id]

    removed = await client.delete(f"/studio/flows/{flow_id}/triggers/{trigger_id}")
    assert removed.status_code == 200
    assert (await client.get(f"/studio/flows/{flow_id}/triggers")).json()["items"] == []
    assert (
        await client.delete(f"/studio/flows/{flow_id}/triggers/{trigger_id}")
    ).status_code == 404


# ---- 行锁与 tick 幂等 ----------------------------------------------------------


def test_tick_statement_takes_a_row_lock_on_postgres() -> None:
    sql = str(lock_run_statement("run-1").compile(dialect=postgresql.dialect()))
    assert "FOR UPDATE" in sql and "SKIP LOCKED" in sql


def test_tick_job_id_is_stable_and_markers_stay_distinct() -> None:
    assert flow_tick_job_id("abc") == "studio-flow-tick:abc"
    assert flow_tick_job_id("abc", marker="resume:n1") == "studio-flow-tick:abc:resume:n1"


async def test_second_tick_does_not_start_the_same_node_twice(session) -> None:
    run = await _run(session, {"nodes": [_chat("only")], "edges": []})
    queue = FakeQueue()
    first = await advance_flow_run(session, queue, run.id)
    second = await advance_flow_run(session, queue, run.id)
    assert second.started_task_ids == ()
    assert second.active_task_ids == first.started_task_ids
    tasks = list(
        (await session.execute(select(StudioTask).where(StudioTask.batch_id == run.id))).scalars()
    )
    assert len(tasks) == 1


async def test_locked_run_yields_the_tick_to_the_holder(session, monkeypatch) -> None:
    run = await _run(session, {"nodes": [_chat("only")], "edges": []})

    async def busy(_session, _run_id):
        return None

    monkeypatch.setattr("domain.studio_flows._lock_run", busy)
    advanced = await advance_flow_run(session, FakeQueue(), run.id)
    assert advanced.started_task_ids == ()
    assert advanced.needs_poll is False
    assert advanced.run.checkpoint["nodes"]["only"]["status"] == "pending"


async def test_new_flow_run_validates_inputs_against_the_saved_schema(session) -> None:
    flow = await create_flow(
        session,
        title="带 schema",
        description=None,
        definition=_waiting_definition(),
    )
    flow.input_schema = derive_input_schema(flow.definition)
    await session.commit()
    run = new_flow_run(flow, inputs={"brief": "有值"})
    session.add(run)
    await session.commit()
    advanced = await advance_flow_run(session, FakeQueue(), run.id)
    assert advanced.run.status == "running"


# ---- worker 接线 --------------------------------------------------------------


async def test_worker_tick_treats_waiting_input_as_a_normal_outcome(
    session, session_factory, monkeypatch
) -> None:
    from worker.tasks import run_studio_flow

    monkeypatch.setattr("worker.tasks.SessionFactory", session_factory)
    run = await _run(session, _waiting_definition())
    queue = FakeQueue()

    outcome = await run_studio_flow({"redis": queue}, run.id)
    assert outcome["ok"] is True
    assert outcome["status"] == "waiting_input"
    assert outcome["waiting_node_id"] == "brief"
    # 挂起不轮询：恢复端点会重新入队
    assert queue.calls == []


async def test_worker_cron_scan_fires_due_triggers(
    session, session_factory, monkeypatch
) -> None:
    from worker.tasks import scan_flow_triggers

    monkeypatch.setattr("worker.tasks.SessionFactory", session_factory)
    flow = await create_flow(
        session,
        title="定时任务",
        description=None,
        definition={"nodes": [_chat("tick")], "edges": []},
    )
    trigger = await create_trigger(session, flow_id=flow.id, kind="cron", cron="* * * * *")
    trigger.last_fired_at = datetime.now(UTC) - timedelta(minutes=5)
    await session.commit()
    queue = FakeQueue()

    outcome = await scan_flow_triggers({"redis": queue})
    assert outcome["ok"] is True
    assert len(outcome["fired"]) == 1
    run = await session.get(StudioFlowRun, outcome["fired"][0])
    assert run.flow_id == flow.id
    assert queue.calls[-1][1] == {"_job_id": flow_tick_job_id(run.id)}

    # 同一分钟内再扫不会重复建 run
    assert (await scan_flow_triggers({"redis": queue}))["fired"] == []


async def test_worker_shell_fires_task_terminal_triggers(
    session, session_factory, monkeypatch
) -> None:
    from worker.tasks import studio_task_job

    monkeypatch.setattr("worker.tasks.SessionFactory", session_factory)
    flow = await create_flow(
        session,
        title="任务终态后",
        description=None,
        definition={"nodes": [_chat("after")], "edges": []},
    )
    await create_trigger(
        session,
        flow_id=flow.id,
        kind="task_terminal",
        task_type="chat.general",
        statuses=["succeeded"],
    )
    task = new_task(tool_id=TOOL, task_type="chat.general", invocation={})
    session.add(task)
    await session.commit()
    queue = FakeQueue()

    @studio_task_job()
    async def body(ctx: dict, task_id: str) -> dict:
        async with session_factory() as inner:
            row = await inner.get(StudioTask, task_id)
            transition(row, "running", stage="test")
            transition(row, "succeeded", stage="done", result={"text": "好"})
            await inner.commit()
        return {"ok": True}

    assert await body({"redis": queue}, task.id) == {"ok": True}
    runs = list(
        (
            await session.execute(
                select(StudioFlowRun).where(StudioFlowRun.flow_id == flow.id)
            )
        ).scalars()
    )
    assert len(runs) == 1
    assert runs[0].inputs["task_id"] == task.id


async def test_resume_reopens_the_branch_that_skip_downstream_had_swallowed(session) -> None:
    from domain.studio_flows import resume_flow_run

    run = await _run(
        session,
        {
            "nodes": [
                _chat("head", on_failure="skip_downstream"),
                _chat("mid", "中间"),
                _chat("optional", "条件分支", when={"$input": "flag"}),
            ],
            "edges": [{"from": "head", "to": "mid"}],
        },
        inputs={"flag": False},
    )
    queue = FakeQueue()
    first = await advance_flow_run(session, queue, run.id)
    await _finish(session, first.started_task_ids[0], status="failed")
    done = await advance_flow_run(session, queue, run.id)
    assert done.run.status == "partial"

    resumed = resume_flow_run(done.run)
    states = resumed.checkpoint["nodes"]
    assert states["head"]["status"] == "pending"
    assert states["head"].get("settled") is None
    # 连坐跳过的重新排队，条件判假跳过的仍然跳过
    assert states["mid"]["status"] == "pending"
    assert states["optional"]["status"] == "skipped"
