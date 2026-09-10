"""worker 启动对账：可恢复的工作流不得被误判失败。"""

from domain.models import StudioFlowRun, StudioTask
from domain.studio_tasks import list_task_events, new_task, transition
from worker.main import reconcile_on_startup


async def test_startup_requeues_workflow_with_provider_id_and_fails_opaque_task(
    session, session_factory, monkeypatch
) -> None:
    workflow = new_task(
        tool_id="infinite-canvas",
        task_type="workflow.comfyui",
        invocation={"workflow_id": 1, "credential_id": 1},
    )
    transition(
        workflow,
        "running",
        stage="provider_running",
        provider_task_id="prompt-42",
    )
    opaque = new_task(tool_id="infinite-canvas", task_type="image.edit", invocation={})
    transition(opaque, "running", stage="provider_running")
    canvas_video = new_task(
        tool_id="infinite-canvas",
        task_type="video.generate",
        invocation={"deployment_id": 1},
    )
    transition(
        canvas_video,
        "running",
        stage="provider_running",
        provider_task_id="video-42",
    )
    session.add_all([workflow, opaque, canvas_video])
    await session.commit()

    monkeypatch.setattr("app.db.SessionFactory", session_factory)
    enqueued: list[tuple] = []

    class Queue:
        async def enqueue_job(self, *args, **kwargs):
            enqueued.append((args, kwargs))

    await reconcile_on_startup({"redis": Queue()})
    await session.refresh(workflow)
    await session.refresh(opaque)
    await session.refresh(canvas_video)

    assert workflow.status == "recovering"
    assert workflow.stage == "startup_recover"
    assert workflow.provider_task_id == "prompt-42"
    assert enqueued == [
        (
            ("run_studio_workflow", workflow.id),
            {"_job_id": f"recover-workflow:{workflow.id}"},
        ),
        (
            ("generate_studio_video", canvas_video.id),
            {"_job_id": f"recover-workflow:{canvas_video.id}"},
        ),
    ]
    assert canvas_video.status == "recovering"
    assert opaque.status == "failed"
    assert opaque.retryable is True
    assert "adapter" in str(opaque.error)
    workflow_events = await list_task_events(session, task_id=workflow.id)
    opaque_events = await list_task_events(session, task_id=opaque.id)
    assert workflow_events[-1].event_type == "task.recovering"
    assert opaque_events[-1].event_type == "task.failed"
    assert await session.get(StudioTask, workflow.id) is workflow


async def test_startup_requeues_active_studio_flow_run(
    session, session_factory, monkeypatch
) -> None:
    run = StudioFlowRun(
        id="flow-run-recover",
        flow_id=None,
        parent_run_id=None,
        flow_version=1,
        definition_snapshot={
            "nodes": [
                {
                    "id": "draft",
                    "tool_id": "infinite-canvas",
                    "operation": "image.generate",
                    "input": {"prompt": "recover"},
                }
            ],
            "edges": [],
        },
        inputs={},
        checkpoint={
            "version": 1,
            "nodes": {
                "draft": {
                    "status": "pending",
                    "task_id": None,
                    "attempt": 0,
                    "result": None,
                    "error": None,
                }
            },
        },
        status="running",
    )
    session.add(run)
    await session.commit()
    monkeypatch.setattr("app.db.SessionFactory", session_factory)
    enqueued: list[tuple] = []

    class Queue:
        async def enqueue_job(self, *args, **kwargs):
            enqueued.append((args, kwargs))

    await reconcile_on_startup({"redis": Queue()})
    await session.refresh(run)

    assert run.status == "recovering"
    assert run.error is None
    assert enqueued == [
        (
            ("run_studio_flow", run.id),
            {"_job_id": f"recover-studio-flow:{run.id}"},
        )
    ]
