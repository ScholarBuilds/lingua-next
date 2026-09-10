"""创作任务取消合同、心跳租约与 save_assets 立即提交。"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

from arq.constants import abort_jobs_ss
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from domain import imagegen
from domain.models import ImageAsset, ImageJob, StudioFlowRun, StudioTask
from domain.studio_tasks import (
    StudioTaskError,
    cancel_key,
    job_key,
    list_task_events,
    new_task,
    request_cancel,
    sweep_stale_tasks,
    transition,
)
from worker import tasks as worker_tasks
from worker.main import WorkerSettings, sweep_stale_studio_tasks
from worker.tasks import StudioTaskLease, studio_task_job, upscale_image_task


class FakeRedis:
    """取消合同只用到 get/set/delete/zadd 四个动词，内存字典够用。"""

    def __init__(self) -> None:
        self.store: dict[str, object] = {}
        self.ttl: dict[str, int | None] = {}
        self.sorted: dict[str, dict[str, float]] = {}

    async def get(self, key: str):
        return self.store.get(key)

    async def set(self, key: str, value, *, ex: int | None = None):
        self.store[key] = value
        self.ttl[key] = ex

    async def delete(self, *keys: str):
        for key in keys:
            self.store.pop(key, None)
            self.ttl.pop(key, None)

    async def zadd(self, key: str, mapping: dict[str, float]):
        self.sorted.setdefault(key, {}).update(mapping)


class FakeQueue:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    async def enqueue_job(self, *args, **kwargs):
        self.calls.append((args, kwargs))


def _task(task_type: str = "image.edit", **kwargs) -> StudioTask:
    return new_task(tool_id="infinite-canvas", task_type=task_type, invocation={}, **kwargs)


# ---- request_cancel ----


async def test_request_cancel_queued_task_is_cancelled_immediately(session) -> None:
    task = _task()
    session.add(task)
    await session.commit()
    redis = FakeRedis()

    await request_cancel(session, redis, task)

    await session.refresh(task)
    assert task.status == "cancelled"
    assert task.retryable is True
    assert task.finished_at is not None
    assert redis.store[cancel_key(task.id)] == "1"
    assert redis.ttl[cancel_key(task.id)] == 24 * 3600
    events = await list_task_events(session, task_id=task.id)
    assert events[-1].event_type == "task.cancelled"
    # 没登记过 worker job，不会往 arq 的 abort 集合写东西
    assert redis.sorted == {}


async def test_request_cancel_running_task_marks_redis_and_aborts_worker_job(session) -> None:
    task = _task("workflow.comfyui")
    transition(task, "running", stage="provider_running", provider_task_id="prompt-1")
    session.add(task)
    await session.commit()
    redis = FakeRedis()
    await redis.set(job_key(task.id), b"job-abc")

    await request_cancel(session, redis, task)

    await session.refresh(task)
    assert task.status == "running", "执行中的任务只打标记，终态由 worker 收口"
    assert redis.store[cancel_key(task.id)] == "1"
    assert "job-abc" in redis.sorted[abort_jobs_ss]


async def test_request_cancel_rejects_finished_task(session) -> None:
    task = _task()
    transition(task, "failed", error="boom")
    session.add(task)
    await session.commit()
    try:
        await request_cancel(session, FakeRedis(), task)
    except StudioTaskError as exc:
        assert "已结束" in str(exc)
    else:
        raise AssertionError("终态任务不应允许取消")


async def test_request_cancel_queued_image_task_fails_its_image_job(session) -> None:
    task = _task("image.generate")
    session.add(task)
    job = ImageJob(
        target_key="free",
        idea="paper boat",
        size="1024x1024",
        quality="high",
        n=1,
        status="pending",
        studio_task_id=task.id,
    )
    session.add(job)
    await session.commit()

    await request_cancel(session, FakeRedis(), task)

    await session.refresh(job)
    assert job.status == "failed"
    assert "取消" in str(job.error)


# ---- sweep_stale_tasks ----


async def test_sweep_requeues_recoverable_and_fails_opaque_stale_tasks(session) -> None:
    stale_at = datetime.now(UTC) - timedelta(seconds=900)
    workflow = _task("workflow.comfyui")
    transition(workflow, "running", stage="provider_running", provider_task_id="prompt-42")
    workflow.heartbeat_at = stale_at
    video = _task("video.generate")
    transition(video, "submitting", stage="provider_submit")
    video.heartbeat_at = stale_at  # 还没拿到上游 ID：不可恢复
    opaque = _task("image.edit")
    transition(opaque, "running", stage="model_edit")
    opaque.heartbeat_at = stale_at
    fresh = _task("image.edit")
    transition(fresh, "running", stage="model_edit")
    queued = _task("image.edit")
    session.add_all([workflow, video, opaque, fresh, queued])
    await session.commit()
    queue = FakeQueue()

    outcome = await sweep_stale_tasks(session, lease_seconds=600, queue=queue)

    assert outcome["recovered"] == [workflow.id]
    assert set(outcome["failed"]) == {video.id, opaque.id}
    for row in (workflow, video, opaque, fresh, queued):
        await session.refresh(row)
    assert workflow.status == "recovering"
    assert workflow.stage == "lease_recover"
    assert workflow.provider_task_id == "prompt-42"
    assert queue.calls == [
        (("run_studio_workflow", workflow.id), {"_job_id": f"lease-recover:{workflow.id}"})
    ]
    assert (video.status, video.error, video.retryable) == ("failed", "lease_expired", True)
    assert (opaque.status, opaque.stage) == ("failed", "lease_expired")
    assert fresh.status == "running"
    assert queued.status == "queued"
    workflow_events = await list_task_events(session, task_id=workflow.id)
    assert workflow_events[-1].event_type == "task.recovering"


async def test_sweep_fails_recoverable_task_when_requeue_is_impossible(session) -> None:
    workflow = _task("workflow.comfyui")
    transition(workflow, "running", stage="provider_running", provider_task_id="prompt-7")
    workflow.heartbeat_at = datetime.now(UTC) - timedelta(seconds=1200)
    session.add(workflow)
    await session.commit()

    outcome = await sweep_stale_tasks(session, queue=None)

    assert outcome == {"recovered": [], "failed": [workflow.id]}
    await session.refresh(workflow)
    assert workflow.status == "failed"
    assert "恢复入队失败" in str(workflow.error)


async def test_sweep_cron_uses_worker_session_and_queue(
    session, session_factory, monkeypatch
) -> None:
    opaque = _task("image.edit")
    transition(opaque, "running", stage="model_edit")
    opaque.heartbeat_at = datetime.now(UTC) - timedelta(seconds=3600)
    session.add(opaque)
    await session.commit()
    monkeypatch.setattr("app.db.SessionFactory", session_factory)

    outcome = await sweep_stale_studio_tasks({"redis": FakeQueue()})

    assert outcome["failed"] == [opaque.id]
    await session.refresh(opaque)
    assert opaque.status == "failed"


def test_worker_settings_enable_abort_and_sweep_cron() -> None:
    assert WorkerSettings.allow_abort_jobs is True
    by_name = {job.name: job for job in WorkerSettings.cron_jobs}
    sweep = by_name["cron:sweep_stale_studio_tasks"]
    assert sweep.minute is None, "minute 不限 = 每分钟跑一次"
    assert sweep.timeout_s == 120


# ---- 取消端点 ----


async def test_cancel_endpoint_returns_202_then_409(client, session, monkeypatch) -> None:
    redis = FakeRedis()

    async def fake_queue():
        return redis

    monkeypatch.setattr("app.routers.studio_tasks.get_queue", fake_queue)
    task = _task()
    session.add(task)
    await session.commit()

    response = await client.post(f"/studio/tasks/{task.id}/cancel")
    assert response.status_code == 202, response.text
    body = response.json()
    assert body["task"]["id"] == task.id
    assert body["task"]["status"] == "cancelled"
    assert body["task"]["updated_at"] is not None
    assert redis.store[cancel_key(task.id)] == "1"

    again = await client.post(f"/studio/tasks/{task.id}/cancel")
    assert again.status_code == 409
    missing = await client.post("/studio/tasks/nope/cancel")
    assert missing.status_code == 404


async def test_cancel_endpoint_keeps_running_task_status_until_worker_finishes(
    client, session, monkeypatch
) -> None:
    redis = FakeRedis()

    async def fake_queue():
        return redis

    monkeypatch.setattr("app.routers.studio_tasks.get_queue", fake_queue)
    task = _task("video.generate")
    transition(task, "running", stage="provider_running", provider_task_id="v-1")
    session.add(task)
    await session.commit()
    await redis.set(job_key(task.id), "job-video")

    response = await client.post(f"/studio/tasks/{task.id}/cancel")
    assert response.status_code == 202, response.text
    assert response.json()["task"]["status"] == "running"
    assert "job-video" in redis.sorted[abort_jobs_ss]


async def test_cancel_endpoint_reports_queue_outage_as_503(client, session, monkeypatch) -> None:
    async def broken_queue():
        raise ConnectionError("redis down")

    monkeypatch.setattr("app.routers.studio_tasks.get_queue", broken_queue)
    task = _task()
    session.add(task)
    await session.commit()

    response = await client.post(f"/studio/tasks/{task.id}/cancel")
    assert response.status_code == 503
    await session.refresh(task)
    assert task.status == "queued"


# ---- DAG 取消级联 ----


async def test_flow_cancel_cascades_to_active_child_tasks(client, session, monkeypatch) -> None:
    redis = FakeRedis()

    async def fake_queue():
        return redis

    monkeypatch.setattr("app.routers.studio_flows.get_queue", fake_queue)
    queued = _task()
    running = _task("workflow.comfyui")
    transition(running, "running", stage="provider_running", provider_task_id="p-1")
    done = _task()
    transition(done, "running")
    transition(done, "succeeded", result={"asset_ids": [1]})
    session.add_all([queued, running, done])
    run = StudioFlowRun(
        id="flow-run-cancel",
        flow_id=None,
        parent_run_id=None,
        flow_version=1,
        definition_snapshot={"nodes": [], "edges": []},
        inputs={},
        checkpoint={
            "version": 1,
            "nodes": {
                "a": {"status": "queued", "task_id": queued.id},
                "b": {"status": "running", "task_id": running.id},
                "c": {"status": "succeeded", "task_id": done.id},
                "d": {"status": "pending", "task_id": None},
            },
        },
        status="running",
    )
    session.add(run)
    await session.commit()
    await redis.set(job_key(running.id), "job-running")

    response = await client.post(f"/studio/flows/runs/{run.id}/cancel")
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "cancelled"

    for row in (queued, running, done):
        await session.refresh(row)
    assert queued.status == "cancelled"
    assert running.status == "running"
    assert done.status == "succeeded"
    assert redis.store[cancel_key(queued.id)] == "1"
    assert redis.store[cancel_key(running.id)] == "1"
    assert cancel_key(done.id) not in redis.store
    assert list(redis.sorted[abort_jobs_ss]) == ["job-running"]


async def test_flow_cancel_without_child_tasks_never_touches_queue(
    client, session, monkeypatch
) -> None:
    async def broken_queue():
        raise AssertionError("没有活跃子任务时不该拿 Redis")

    monkeypatch.setattr("app.routers.studio_flows.get_queue", broken_queue)
    run = StudioFlowRun(
        id="flow-run-empty",
        flow_id=None,
        parent_run_id=None,
        flow_version=1,
        definition_snapshot={"nodes": [], "edges": []},
        inputs={},
        checkpoint={"version": 1, "nodes": {"a": {"status": "pending", "task_id": None}}},
        status="queued",
    )
    session.add(run)
    await session.commit()

    response = await client.post(f"/studio/flows/runs/{run.id}/cancel")
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "cancelled"


# ---- worker 租约外壳 ----


async def test_lease_skips_task_that_is_already_terminal(session, session_factory, monkeypatch):
    monkeypatch.setattr("worker.tasks.SessionFactory", session_factory)
    task = _task()
    transition(task, "cancelled", error="用户取消了任务")
    session.add(task)
    await session.commit()
    ran: list[str] = []

    @studio_task_job()
    async def body(ctx: dict, task_id: str) -> dict:
        ran.append(task_id)
        return {"ok": True}

    result = await body({}, task.id)
    assert result["ok"] is False
    assert "跳过" in result["error"]
    assert ran == []


async def test_lease_honors_cancel_mark_set_while_job_waited_in_queue(
    session, session_factory, monkeypatch
):
    """恢复入队后又被取消：worker 领到 job 时直接收口，不开跑。"""
    monkeypatch.setattr("worker.tasks.SessionFactory", session_factory)
    task = _task("workflow.comfyui")
    transition(task, "recovering", stage="startup_recover", provider_task_id="p-9")
    session.add(task)
    await session.commit()
    redis = FakeRedis()
    await redis.set(cancel_key(task.id), "1")
    ran: list[str] = []

    @studio_task_job()
    async def body(ctx: dict, task_id: str) -> dict:
        ran.append(task_id)
        return {"ok": True}

    result = await body({"redis": redis, "job_id": "job-late"}, task.id)
    assert result["ok"] is False
    assert ran == []
    await session.refresh(task)
    assert task.status == "cancelled"
    assert cancel_key(task.id) not in redis.store
    assert job_key(task.id) not in redis.store


async def test_lease_cancels_running_coroutine_and_writes_cancelled_state(
    session, session_factory, monkeypatch
):
    monkeypatch.setattr("worker.tasks.SessionFactory", session_factory)
    monkeypatch.setattr(worker_tasks, "LEASE_POLL_SECONDS", 0.01)
    monkeypatch.setattr(worker_tasks, "LEASE_ABORT_GRACE_SECONDS", 0.01)
    task = _task("video.generate")
    session.add(task)
    job = ImageJob(
        target_key="free",
        idea="x",
        size="1024x1024",
        quality="high",
        n=1,
        status="running",
        studio_task_id=task.id,
    )
    session.add(job)
    await session.commit()
    redis = FakeRedis()
    started = asyncio.Event()

    @studio_task_job()
    async def body(ctx: dict, task_id: str) -> dict:
        async with session_factory() as inner:
            row = await inner.get(StudioTask, task_id)
            transition(row, "running", stage="provider_running")
            await inner.commit()
        started.set()
        await asyncio.sleep(30)
        return {"ok": True}

    runner = asyncio.create_task(body({"redis": redis, "job_id": "job-1"}, task.id))
    await asyncio.wait_for(started.wait(), timeout=5)
    assert redis.store[job_key(task.id)] == "job-1"
    await redis.set(cancel_key(task.id), "1")

    try:
        await asyncio.wait_for(runner, timeout=5)
    except asyncio.CancelledError:
        pass
    else:
        raise AssertionError("取消后必须把 CancelledError 抛回 arq")

    assert "job-1" in redis.sorted[abort_jobs_ss], "先交给 arq 的 abort 集合"
    await session.refresh(task)
    await session.refresh(job)
    assert task.status == "cancelled"
    assert task.retryable is True
    assert job.status == "failed"
    events = await list_task_events(session, task_id=task.id)
    assert events[-1].event_type == "task.cancelled"
    # 跑完把标记与 job 登记一起清掉，不给下一次重试留旧标记
    assert cancel_key(task.id) not in redis.store
    assert job_key(task.id) not in redis.store


async def test_lease_refreshes_heartbeat_while_body_waits(session, session_factory, monkeypatch):
    monkeypatch.setattr("worker.tasks.SessionFactory", session_factory)
    monkeypatch.setattr(worker_tasks, "LEASE_POLL_SECONDS", 0.01)
    monkeypatch.setattr(worker_tasks, "LEASE_HEARTBEAT_SECONDS", 0.02)
    task = _task()
    transition(task, "running", stage="provider_running")
    task.heartbeat_at = datetime.now(UTC) - timedelta(minutes=5)
    session.add(task)
    await session.commit()
    before = task.heartbeat_at

    @studio_task_job()
    async def body(ctx: dict, task_id: str) -> dict:
        await asyncio.sleep(0.2)
        return {"ok": True}

    assert await body({}, task.id) == {"ok": True}
    await session.refresh(task)
    assert task.status == "running"
    refreshed = task.heartbeat_at
    if refreshed.tzinfo is None:
        refreshed = refreshed.replace(tzinfo=UTC)
    assert refreshed > before + timedelta(minutes=4)


async def test_lease_does_not_touch_terminal_state_written_by_body(
    session, session_factory, monkeypatch
):
    """任务函数自己已写 failed 再被取消：租约不能把终态改成 cancelled。"""
    monkeypatch.setattr("worker.tasks.SessionFactory", session_factory)
    task = _task()
    transition(task, "failed", error="provider said no")
    session.add(task)
    await session.commit()

    lease = StudioTaskLease({}, task.id)
    await lease.finish_cancelled()

    await session.refresh(task)
    assert task.status == "failed"
    assert task.error == "provider said no"


# ---- save_assets 立即提交 ----


async def test_upscale_commits_save_assets_stage_before_ingest(
    session, db_engine, monkeypatch
):
    commits: list[str | None] = []

    class CommitSpy(AsyncSession):
        async def commit(self) -> None:
            for obj in list(self.sync_session.identity_map.values()):
                if isinstance(obj, StudioTask):
                    commits.append(obj.stage)
            await super().commit()

    spy_factory = async_sessionmaker(db_engine, expire_on_commit=False, class_=CommitSpy)
    monkeypatch.setattr("worker.tasks.SessionFactory", spy_factory)

    source = ImageAsset(
        sha256="a" * 64,
        storage_key="images/test/source.png",
        mime="image/png",
        width=64,
        height=64,
        bytes=3,
        target_key="free",
        prompt="seed",
        source="workbench",
    )
    session.add(source)
    await session.commit()
    await session.refresh(source)
    task = new_task(
        tool_id="infinite-canvas",
        task_type="image.upscale",
        invocation={"asset_id": source.id, "resolution_type": "2k"},
    )
    session.add(task)
    await session.commit()

    class Route:
        upstream_model_id = "jimeng-upscale"

    class Storage:
        async def read(self, key: str) -> bytes:
            return b"png"

    class Ingested:
        def __init__(self, asset_id: int) -> None:
            self.id = asset_id

    async def fake_route(_session, _alias, *, deployment_id=None):
        return Route()

    async def fake_upscale(_image, *, resolution_type, route):
        return imagegen.RenderResult(images=[b"bigger"], model_reported="jimeng", latency_ms=3)

    async def fake_ingest(_session, _data, **_kwargs):
        return Ingested(77)

    monkeypatch.setattr("domain.model_catalog.resolve_model_route", fake_route)
    monkeypatch.setattr("domain.storage.get_storage", lambda: Storage())
    monkeypatch.setattr(imagegen, "upscale_jimeng_image", fake_upscale)
    monkeypatch.setattr("domain.image_assets.ingest_one", fake_ingest)

    result = await upscale_image_task({}, task.id)
    assert result == {"ok": True, "asset_ids": [77]}
    assert "save_assets" in commits, f"save_assets 阶段必须单独提交一次，实际：{commits}"
    assert commits.index("save_assets") < commits.index("completed")
