"""SSE pipeline 帧、NOTIFY 唤醒与关停收尾。

- pipeline 帧：单条 PipelineRun 快照（字段对齐 /api/pipeline/stream 的 ActiveItem），
  不带 id 行，任何变化 ≤1 轮推一帧，重复快照去重。
- NOTIFY：写侧 before_commit 钩子只在 PostgreSQL 发 pg_notify，SQLite 静默跳过；
  读侧 NotifyHub 用桩连接验证唤醒路径，不依赖真 PG。
- 收尾：API lifespan 与 worker on_shutdown 都先 flush 台账事件、再取消消费者。
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import db as app_db
from app import main as app_main
from app.db import NotifyHub, close_notify_hubs, event_wakeup
from domain import model_invocations
from domain.model_invocations import InvocationEventWriter
from domain.models import PipelineRun, PipelineStep, StudioTaskEvent, Video
from domain.pipeline import (
    PIPELINE_VERSION,
    list_pipeline_runs_updated_since,
    pipeline_run_snapshots,
    pipeline_run_view,
)
from domain.studio_tasks import (
    EVENT_NOTIFY_CHANNEL,
    emit_event_notify,
    list_task_events,
    new_task,
    request_event_notify,
    transition,
)
from domain.task_event_stream import (
    KEEP_ALIVE_FRAME,
    PipelineRunSnapshotTracker,
    iter_sse_frames,
)
from worker.main import WorkerSettings, shutdown_worker

# ---- 夹具 ----


def _parse(frame: str) -> dict:
    """把一帧 SSE 文本拆成字段；data 行按 JSON 解析。"""
    fields: dict = {}
    for line in frame.rstrip("\n").split("\n"):
        key, _, value = line.partition(": ")
        fields[key] = value
    if "data" in fields:
        fields["data"] = json.loads(fields["data"])
    return fields


class _Stopper:
    """前 ``polls`` 次询问放行，之后宣告断开。"""

    def __init__(self, polls: int) -> None:
        self.remaining = polls

    async def __call__(self) -> bool:
        self.remaining -= 1
        return self.remaining < 0


async def _no_sleep(_seconds: float) -> None:
    return None


def _run(video_id: int, *, status: str = "running", **extra: Any) -> PipelineRun:
    return PipelineRun(
        domain="video",
        subject_id=video_id,
        video_id=video_id,
        kind="ingest",
        trigger="user",
        status=status,
        code_version=PIPELINE_VERSION,
        started_at=datetime.now(UTC),
        **extra,
    )


def _step(run_id: int, name: str, ordinal: int, status: str, **extra: Any) -> PipelineStep:
    return PipelineStep(
        run_id=run_id,
        name=name,
        ordinal=ordinal,
        status=status,
        code_version=PIPELINE_VERSION,
        **extra,
    )


# ---- 窗口查询 ----


async def test_updated_since_keeps_live_runs_and_windowed_finishes(session) -> None:
    video = Video(title="窗口测试")
    session.add(video)
    await session.commit()
    now = datetime.now(UTC)
    live_old = _run(video.id, status="running")
    live_old.started_at = now - timedelta(hours=3)
    just_done = _run(video.id, status="success")
    just_done.finished_at = now
    stale_done = _run(video.id, status="failed")
    stale_done.started_at = now - timedelta(hours=3)
    stale_done.finished_at = now - timedelta(hours=2)
    session.add_all([live_old, just_done, stale_done])
    await session.commit()
    # created_at 是 CURRENT_TIMESTAMP，只能把窗口推到未来才能把三条的"新建"都排除
    since = now + timedelta(seconds=5)

    rows = await list_pipeline_runs_updated_since(session, since=since)

    ids = [row.id for row in rows]
    assert live_old.id in ids, "活跃 run 不看窗口，始终返回"
    assert stale_done.id not in ids, "早已收口的 run 不再出现"
    recent = await list_pipeline_runs_updated_since(session, since=now - timedelta(seconds=1))
    assert just_done.id in [row.id for row in recent], "刚收口的 run 靠 finished_at 落进窗口"


# ---- 快照 view ----


def test_run_view_aligns_active_item_shape_and_progress_spans() -> None:
    run = _run(7)
    run.id = 12
    steps = [
        _step(12, "download", 0, "success", attempt=1, duration_ms=800),
        _step(12, "probe", 1, "skipped", attempt=1),
        _step(12, "transcribe", 3, "running", attempt=1),
    ]
    view = pipeline_run_view(run, steps, title="测试视频")

    assert view["run_id"] == 12
    assert view["domain"] == "video"
    assert view["subject_id"] == 7
    assert view["video_id"] == 7, "主体列沿用 ActiveItem 的 video_id 字段名"
    assert view["kind"] == "ingest"
    assert view["status"] == "running"
    assert view["live"] is True
    assert view["title"] == "测试视频"
    assert view["current_step"] == "transcribe"
    assert view["current_label"] == "语音转写"
    assert view["failed_steps"] == []
    assert view["done_steps"] == 2
    assert view["total_steps"] > 3, "分母是管线声明的节点数，不随已记录行数漂移"
    # transcribe 的 progress_span 是 (60, 92)：正在跑取区间起点
    assert view["progress"] == 60
    assert [s["name"] for s in view["steps"]] == ["download", "probe", "transcribe"]
    assert view["steps"][0] == {
        "name": "download", "label": "下载媒体", "status": "success",
        "ordinal": 0, "attempt": 1, "duration_ms": 800, "error_kind": None,
    }


def test_run_view_failed_and_success_states() -> None:
    run = _run(7, status="failed")
    run.id = 3
    run.error = "boom"
    steps = [
        _step(3, "download", 0, "success", attempt=1),
        _step(3, "transcribe", 3, "failed", attempt=1, error_kind="network"),
    ]
    view = pipeline_run_view(run, steps)
    assert view["live"] is False
    assert view["failed_steps"] == ["transcribe"]
    assert view["error"] == "boom"
    assert view["error_kind"] == "network"
    assert view["title"] == "#7", "查不到主体标题时按 id 兜底"

    done = _run(7, status="success")
    done.id = 4
    assert pipeline_run_view(done, [])["progress"] == 100


def test_run_view_keeps_only_latest_attempt_and_uses_subject_progress() -> None:
    run = _run(7)
    run.id = 5
    steps = [
        _step(5, "download", 0, "failed", attempt=1),
        _step(5, "download", 0, "running", attempt=2),
    ]
    view = pipeline_run_view(run, steps, subject_progress=37)
    assert [s["attempt"] for s in view["steps"]] == [2], "同名节点只留最新 attempt"
    assert view["failed_steps"] == []
    assert view["progress"] == 37, "视频域活跃 run 用 Video.progress 的实时值"


async def test_snapshots_batch_titles_and_progress(session) -> None:
    video = Video(title="raw", title_zh="中文名", progress=41)
    session.add(video)
    await session.commit()
    run = _run(video.id)
    session.add(run)
    await session.commit()
    session.add(_step(run.id, "download", 0, "running"))
    await session.commit()

    views = await pipeline_run_snapshots(session, [run])

    assert len(views) == 1
    assert views[0]["title"] == "中文名"
    assert views[0]["progress"] == 41
    assert views[0]["current_step"] == "download"
    assert await pipeline_run_snapshots(session, []) == []


# ---- 组帧与去重 ----


def test_pipeline_tracker_dedupes_identical_snapshots() -> None:
    tracker = PipelineRunSnapshotTracker()
    view = {"run_id": 1, "status": "running"}
    assert tracker.accept(view) is not None
    assert tracker.accept(dict(view)) is None
    assert tracker.accept({"run_id": 1, "status": "success"}) is not None


async def test_stream_emits_pipeline_frames_on_every_change(session_factory) -> None:
    async with session_factory() as session:
        video = Video(title="流测试", progress=0)
        session.add(video)
        await session.commit()
        run = _run(video.id)
        session.add(run)
        await session.commit()
        session.add(_step(run.id, "download", 0, "running"))
        await session.commit()
        run_id, video_id = run.id, video.id

    rounds = 0

    async def sleep(_seconds: float) -> None:
        nonlocal rounds
        rounds += 1
        if rounds != 1:
            return
        # 第二轮之前节点收口、run 收口：快照变了，必须再推一帧
        async with session_factory() as session:
            row = (
                await session.execute(
                    select(PipelineStep).where(PipelineStep.run_id == run_id)
                )
            ).scalar_one()
            row.status = "success"
            row.finished_at = datetime.now(UTC)
            target = await session.get(PipelineRun, run_id)
            assert target is not None
            target.status = "success"
            target.finished_at = datetime.now(UTC)
            await session.commit()

    raw = [
        frame
        async for frame in iter_sse_frames(
            session_factory, should_stop=_Stopper(3), sleep=sleep
        )
    ]
    frames = [_parse(frame) for frame in raw if frame != KEEP_ALIVE_FRAME]
    pipeline_frames = [f for f in frames if f.get("event") == "pipeline"]

    assert len(pipeline_frames) == 2, "初始快照一帧 + 收口一帧，第三轮无变化不推"
    assert all("id" not in f for f in pipeline_frames), "pipeline 帧不带 id 行，不动游标"
    first, second = (f["data"] for f in pipeline_frames)
    assert first["run_id"] == run_id
    assert first["domain"] == "video"
    assert first["subject_id"] == video_id
    assert (first["status"], first["live"]) == ("running", True)
    assert first["current_step"] == "download"
    assert (second["status"], second["live"]) == ("success", False)
    assert second["progress"] == 100
    assert second["finished_at"] is not None
    # 第三轮回看窗口里同一快照又被查到：不重复推，只有 keep-alive
    assert raw[-1] == KEEP_ALIVE_FRAME


# ---- NOTIFY 写侧钩子 ----


class _FakeDialect:
    def __init__(self, name: str) -> None:
        self.name = name


class _FakeBind:
    def __init__(self, name: str) -> None:
        self.dialect = _FakeDialect(name)


class _FakeSession:
    """emit_event_notify 只碰 info/new/bind/execute 四样。"""

    def __init__(self, dialect: str = "postgresql", new: tuple = ()) -> None:
        self.info: dict = {}
        self.new = list(new)
        self.bind = _FakeBind(dialect)
        self.executed: list[tuple[str, dict | None]] = []

    def execute(self, statement, params=None):
        self.executed.append((str(statement), params))


def test_notify_hook_sends_pg_notify_when_flagged() -> None:
    fake = _FakeSession()
    request_event_notify(fake)  # type: ignore[arg-type]
    emit_event_notify(fake)  # type: ignore[arg-type]
    assert len(fake.executed) == 1
    statement, params = fake.executed[0]
    assert "pg_notify" in statement
    assert params == {"channel": EVENT_NOTIFY_CHANNEL}
    assert fake.info == {}, "标记一次性消费"
    # 没有标记也没有新事件行：什么都不发
    emit_event_notify(fake)  # type: ignore[arg-type]
    assert len(fake.executed) == 1


def test_notify_hook_detects_queued_event_in_session_new() -> None:
    event_row = StudioTaskEvent(
        task_id="t1", seq=1, event_type="task.queued", status="queued"
    )
    fake = _FakeSession(new=(event_row,))
    emit_event_notify(fake)  # type: ignore[arg-type]
    assert len(fake.executed) == 1, "new_task 的 queued 事件没经过 transition，靠 new 检测兜住"


def test_notify_hook_silently_skips_non_postgres() -> None:
    fake = _FakeSession(dialect="sqlite")
    request_event_notify(fake)  # type: ignore[arg-type]
    emit_event_notify(fake)  # type: ignore[arg-type]
    assert fake.executed == []
    assert fake.info == {}


async def test_transition_commit_on_sqlite_passes_through(session) -> None:
    """真 SQLite 会话上走完 transition → commit：钩子静默跳过，不炸也不留标记。"""
    task = new_task(tool_id="infinite-canvas", task_type="image.generate")
    session.add(task)
    await session.commit()
    transition(task, "running", stage="provider_running", progress=10)
    await session.commit()
    assert "lingua_event_notify_pending" not in session.sync_session.info
    rows = await list_task_events(session, task_id=task.id)
    assert [row.event_type for row in rows] == ["task.queued", "task.running"]


# ---- NOTIFY 读侧唤醒 ----


class _FakeListenConn:
    def __init__(self) -> None:
        self.closed = False
        self.callbacks: list = []

    def is_closed(self) -> bool:
        return self.closed

    async def add_listener(self, channel: str, callback) -> None:
        self.callbacks.append((channel, callback))

    async def close(self) -> None:
        self.closed = True

    def notify(self) -> None:
        for _channel, callback in self.callbacks:
            callback(None, 0, _channel, "")


async def test_notify_hub_wakes_waiter_immediately() -> None:
    conn = _FakeListenConn()

    async def connect() -> _FakeListenConn:
        return conn

    hub = NotifyHub(connect, "chan")
    waiter = asyncio.create_task(hub.wait(0, timeout=5.0))
    for _ in range(20):
        await asyncio.sleep(0)  # 让 waiter 完成建连并挂上 Future
        if conn.callbacks:
            break
    conn.notify()
    assert await asyncio.wait_for(waiter, timeout=1.0) == 1
    assert [channel for channel, _ in conn.callbacks] == ["chan"]


async def test_notify_hub_returns_missed_notifications_without_waiting() -> None:
    conn = _FakeListenConn()

    async def connect() -> _FakeListenConn:
        return conn

    hub = NotifyHub(connect, "chan")
    await hub.wait(0, timeout=0.01)  # 建连并超时
    conn.notify()  # 通知落在两次 wait 之间
    assert await asyncio.wait_for(hub.wait(0, timeout=30.0), timeout=1.0) == 1
    await hub.close()
    assert conn.closed


async def test_notify_hub_degrades_to_sleep_when_connect_fails() -> None:
    attempts = 0

    async def connect() -> _FakeListenConn:
        nonlocal attempts
        attempts += 1
        raise ConnectionError("pg down")

    hub = NotifyHub(connect, "chan", retry_seconds=60.0)
    assert await hub.wait(0, timeout=0.01) == 0
    assert await hub.wait(0, timeout=0.01) == 0
    assert attempts == 1, "退避窗口内不重复撞连接"


async def test_event_wakeup_falls_back_to_plain_sleep_on_sqlite(session_factory) -> None:
    assert event_wakeup(session_factory) is asyncio.sleep


async def test_event_wakeup_uses_listen_hub_on_postgres(monkeypatch) -> None:
    conn = _FakeListenConn()

    def fake_connect_factory(_engine):
        async def connect() -> _FakeListenConn:
            return conn

        return connect

    monkeypatch.setattr(app_db, "_asyncpg_connect", fake_connect_factory)
    engine = create_async_engine("postgresql+asyncpg://u:p@localhost:5432/x")
    try:
        factory = async_sessionmaker(engine, expire_on_commit=False)
        wakeup = event_wakeup(factory)
        assert wakeup is not asyncio.sleep
        await wakeup(0.01)  # 建连（桩），超时返回
        conn.notify()
        await asyncio.wait_for(wakeup(30.0), timeout=1.0)  # 有通知：立刻返回
    finally:
        await close_notify_hubs()
        await engine.dispose()
    assert conn.closed, "close_notify_hubs 断开 LISTEN 连接"


# ---- 关停收尾 ----


async def test_app_lifespan_flushes_then_cancels_event_writer(monkeypatch) -> None:
    writer = InvocationEventWriter()
    writer._ensure()  # 拉起消费者任务
    assert writer._task is not None and not writer._task.done()
    monkeypatch.setattr(model_invocations, "event_writer", writer)
    order: list[str] = []

    async def fake_flush() -> None:
        assert writer._task is not None and not writer._task.done()
        order.append("flush")

    monkeypatch.setattr(model_invocations, "flush_invocation_events", fake_flush)

    async with app_main.lifespan(app_main.app):
        order.append("serving")

    assert order == ["serving", "flush"]
    assert writer._task.cancelled()


async def test_worker_shutdown_flushes_then_cancels_event_writer(monkeypatch) -> None:
    writer = InvocationEventWriter()
    writer._ensure()
    monkeypatch.setattr(model_invocations, "event_writer", writer)
    flushed: list[bool] = []

    async def fake_flush() -> None:
        assert writer._task is not None
        flushed.append(not writer._task.done())

    monkeypatch.setattr(model_invocations, "flush_invocation_events", fake_flush)

    await shutdown_worker({})

    assert flushed == [True], "flush 时消费者还活着，取消发生在其后"
    assert writer._task is not None and writer._task.cancelled()
    assert WorkerSettings.on_shutdown is shutdown_worker
