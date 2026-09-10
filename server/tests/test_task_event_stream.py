"""任务事件 SSE：游标缺口等待 / 超时跳过、FlowRun 帧组帧与去重、路由续传。"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from app.routers.studio_tasks import stream_task_events
from domain import task_event_stream
from domain.models import StudioFlowRun, StudioTask, StudioTaskEvent
from domain.studio_flows import list_flow_runs_updated_since, new_inline_flow_run
from domain.studio_tasks import new_task, transition
from domain.task_event_stream import (
    GAP_WAIT_SECONDS,
    KEEP_ALIVE_FRAME,
    FlowRunSnapshotTracker,
    GapAwareCursorReader,
    iter_sse_frames,
)


@dataclass
class Row:
    global_cursor: int


def _rows(*cursors: int) -> list[Row]:
    return [Row(cursor) for cursor in cursors]


def _ids(rows: list[Row]) -> list[int]:
    return [row.global_cursor for row in rows]


def _definition() -> dict:
    return {
        "nodes": [
            {
                "id": "draft",
                "tool_id": "infinite-canvas",
                "operation": "image.generate",
                "input": {"prompt": {"$input": "prompt"}},
            }
        ],
        "edges": [],
    }


def _event(task_id: str, *, cursor: int, seq: int) -> StudioTaskEvent:
    return StudioTaskEvent(
        global_cursor=cursor,
        task_id=task_id,
        seq=seq,
        event_type="task.progress",
        status="running",
        stage="provider_running",
        progress=float(seq),
    )


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


# ---- 游标读取器 ----


def test_reader_emits_contiguous_rows_and_advances_cursor() -> None:
    reader = GapAwareCursorReader(0)
    assert _ids(reader.feed(_rows(1, 2, 3), now=0.0)) == [1, 2, 3]
    assert reader.cursor == 3
    assert _ids(reader.feed(_rows(4, 5), now=1.0)) == [4, 5]
    assert reader.cursor == 5
    assert reader.feed([], now=2.0) == []
    assert reader.cursor == 5


def test_reader_holds_at_gap_and_releases_in_order_once_filled() -> None:
    reader = GapAwareCursorReader(0)
    # 7 先提交、6 还在事务里：只发 5，游标停在缺口前
    assert _ids(reader.feed(_rows(5, 7), now=0.0)) == [5]
    assert reader.cursor == 5
    assert reader.feed(_rows(7), now=1.0) == []
    assert reader.cursor == 5
    # 6 在等待窗口内提交，连同后面的按序放行
    assert _ids(reader.feed(_rows(6, 7, 8), now=2.0)) == [6, 7, 8]
    assert reader.cursor == 8


def test_reader_skips_gap_after_timeout() -> None:
    reader = GapAwareCursorReader(5)
    assert reader.feed(_rows(7, 8), now=10.0) == []
    assert reader.feed(_rows(7, 8), now=10.0 + GAP_WAIT_SECONDS - 0.1) == []
    assert reader.cursor == 5
    # 序列回滚留下的永久空洞：超时后跳过 6 继续推进
    assert _ids(reader.feed(_rows(7, 8), now=10.0 + GAP_WAIT_SECONDS)) == [7, 8]
    assert reader.cursor == 8
    # 迟到太久的 6 已落在游标之后，不会让游标倒退
    assert reader.feed(_rows(6), now=20.0) == []
    assert reader.cursor == 8


def test_reader_skips_all_stale_gaps_of_a_page_together() -> None:
    reader = GapAwareCursorReader(0)
    assert _ids(reader.feed(_rows(1, 3, 5, 7), now=0.0)) == [1]
    assert reader.feed(_rows(3, 5, 7), now=1.0) == []
    # 同一页里的三个缺口是同一轮看到的，超时后一次跳完，不按缺口数累加等待
    assert _ids(reader.feed(_rows(3, 5, 7), now=GAP_WAIT_SECONDS)) == [3, 5, 7]
    assert reader.cursor == 7


def test_reader_times_each_gap_from_first_sight() -> None:
    reader = GapAwareCursorReader(0)
    assert _ids(reader.feed(_rows(1, 3), now=0.0)) == [1]
    # 新出现的缺口从它首次被看到起计时，老缺口到期不会连带放行新缺口
    assert _ids(reader.feed(_rows(3, 6), now=GAP_WAIT_SECONDS)) == [3]
    assert reader.cursor == 3
    assert reader.feed(_rows(6), now=GAP_WAIT_SECONDS + 1.0) == []
    assert _ids(reader.feed(_rows(6), now=GAP_WAIT_SECONDS * 2)) == [6]


def test_reader_fresh_subscription_anchors_on_first_row() -> None:
    # after=0 且早期事件已随任务清理删除：第一行直接作为起点，不等 3s
    reader = GapAwareCursorReader(0)
    assert _ids(reader.feed(_rows(40, 41), now=0.0)) == [40, 41]
    assert reader.cursor == 41


def test_reader_resume_treats_missing_successor_as_gap() -> None:
    reader = GapAwareCursorReader(39)
    assert reader.feed(_rows(41), now=0.0) == []
    assert _ids(reader.feed(_rows(40, 41), now=0.5)) == [40, 41]


# ---- FlowRun 快照去重 ----


def test_snapshot_tracker_only_reports_changed_runs() -> None:
    run = new_inline_flow_run(_definition(), inputs={"prompt": "山"})
    tracker = FlowRunSnapshotTracker()
    first = tracker.accept(run)
    assert first is not None
    assert json.loads(first)["id"] == run.id
    assert json.loads(first)["status"] == "queued"
    assert tracker.accept(run) is None
    run.status = "running"
    second = tracker.accept(run)
    assert second is not None
    assert json.loads(second)["status"] == "running"
    assert tracker.accept(run) is None


def test_snapshot_tracker_memory_is_bounded() -> None:
    tracker = FlowRunSnapshotTracker(memory=2)
    runs = [new_inline_flow_run(_definition(), inputs={"prompt": str(i)}) for i in range(3)]
    for run in runs:
        assert tracker.accept(run) is not None
    # 最早的记录被挤出后再次出现会重新推帧，但记录数不会无限增长
    assert tracker.accept(runs[0]) is not None
    assert len(tracker._sent) == 2


# ---- 查询 ----


async def test_list_flow_runs_updated_since_respects_window(session) -> None:
    run = new_inline_flow_run(_definition(), inputs={"prompt": "山"})
    session.add(run)
    await session.commit()
    now = datetime.now(UTC)
    recent = await list_flow_runs_updated_since(session, since=now - timedelta(seconds=5))
    assert [row.id for row in recent] == [run.id]
    assert await list_flow_runs_updated_since(session, since=now + timedelta(seconds=5)) == []


# ---- 轮询与组帧 ----


async def test_stream_emits_keep_alive_when_idle(session_factory) -> None:
    raw = [
        frame
        async for frame in iter_sse_frames(
            session_factory, should_stop=_Stopper(1), sleep=_no_sleep
        )
    ]
    assert raw == [KEEP_ALIVE_FRAME]


async def test_stream_emits_task_and_flow_frames(session_factory) -> None:
    async with session_factory() as session:
        task = new_task(
            tool_id="infinite-canvas",
            task_type="image.generate",
            source_context={"canvas_id": 3, "node_id": "n1"},
        )
        run = new_inline_flow_run(_definition(), inputs={"prompt": "山"})
        session.add_all([task, run])
        await session.commit()

    sleeps: list[float] = []

    async def sleep(seconds: float) -> None:
        sleeps.append(seconds)
        if len(sleeps) != 1:
            return
        # 第二轮之前任务推进一步，FlowRun 状态也变了
        async with session_factory() as session:
            row = await session.get(StudioTask, task.id)
            transition(row, "running", stage="provider_running", progress=30)
            flow = await session.get(StudioFlowRun, run.id)
            flow.status = "running"
            await session.commit()

    raw = [
        frame
        async for frame in iter_sse_frames(
            session_factory, should_stop=_Stopper(2), sleep=sleep
        )
    ]
    assert sleeps == [task_event_stream.POLL_INTERVAL_SECONDS] * 2
    assert KEEP_ALIVE_FRAME not in raw

    frames = [_parse(frame) for frame in raw]
    task_frames = [f for f in frames if f.get("event") == "task"]
    flow_frames = [f for f in frames if f.get("event") == "flow"]

    assert [f["data"]["event_type"] for f in task_frames] == ["task.queued", "task.running"]
    assert [int(f["id"]) for f in task_frames] == [f["data"]["cursor"] for f in task_frames]
    assert all(f["data"]["task_id"] == task.id for f in task_frames)
    assert task_frames[1]["data"]["progress"] == 30.0

    assert [f["data"]["status"] for f in flow_frames] == ["queued", "running"]
    assert all(f["data"]["id"] == run.id for f in flow_frames)
    assert all("id" not in f for f in flow_frames)
    assert flow_frames[0]["data"]["checkpoint"]["nodes"]["draft"]["status"] == "pending"
    # 同一轮里 task 帧先于 flow 帧
    assert [f.get("event") for f in frames] == ["task", "flow", "task", "flow"]


async def test_stream_waits_for_late_commit_then_skips_permanent_gap(session_factory) -> None:
    async with session_factory() as session:
        task = new_task(tool_id="infinite-canvas", task_type="image.generate")
        session.add(task)
        await session.commit()
        # 3 号先提交，2 号取了号还没提交
        session.add(_event(task.id, cursor=3, seq=2))
        await session.commit()

    clock_values = iter([0.0, 1.0, 2.0, 2.0 + GAP_WAIT_SECONDS])
    rounds = 0

    async def sleep(_seconds: float) -> None:
        nonlocal rounds
        rounds += 1
        async with session_factory() as session:
            if rounds == 1:
                # 迟到的 2 号在等待窗口内提交
                session.add(_event(task.id, cursor=2, seq=3))
            elif rounds == 2:
                # 4、5 号随事务回滚，6 号之前是永久空洞
                session.add(_event(task.id, cursor=6, seq=4))
            await session.commit()

    raw = [
        frame
        async for frame in iter_sse_frames(
            session_factory,
            should_stop=_Stopper(4),
            sleep=sleep,
            clock=lambda: next(clock_values),
        )
    ]
    ids = [int(_parse(frame)["id"]) for frame in raw if frame.startswith("id: ")]
    assert ids == [1, 2, 3, 6]
    # 第三轮只看到 6 号且缺口刚出现：这一轮什么都不发，只有 keep-alive
    assert raw[3] == KEEP_ALIVE_FRAME
    assert raw.count(KEEP_ALIVE_FRAME) == 1


async def test_stream_canvas_filter_does_not_treat_other_canvases_as_gaps(
    session_factory,
) -> None:
    async with session_factory() as session:
        other = new_task(
            tool_id="infinite-canvas",
            task_type="image.generate",
            source_context={"canvas_id": 1, "node_id": "a"},
        )
        mine = new_task(
            tool_id="infinite-canvas",
            task_type="image.generate",
            source_context={"canvas_id": 2, "node_id": "b"},
        )
        session.add_all([other, mine])
        await session.commit()

    # 时钟不走：如果别的画布的事件被当成缺口，这一轮就什么都发不出来
    raw = [
        frame
        async for frame in iter_sse_frames(
            session_factory,
            canvas_id=2,
            should_stop=_Stopper(1),
            sleep=_no_sleep,
            clock=lambda: 0.0,
        )
    ]
    task_frames = [_parse(frame) for frame in raw if frame.startswith("id: ")]
    assert [f["data"]["task_id"] for f in task_frames] == [mine.id]
    assert all(f["data"]["canvas_id"] == 2 for f in task_frames)


# ---- 路由 ----


class _Request:
    def __init__(self, headers: dict[str, str], polls: int) -> None:
        self.headers = headers
        self.remaining = polls

    async def is_disconnected(self) -> bool:
        self.remaining -= 1
        return self.remaining < 0


async def test_route_resumes_from_last_event_id(session_factory, monkeypatch) -> None:
    async with session_factory() as session:
        task = new_task(tool_id="infinite-canvas", task_type="image.generate")
        session.add(task)
        for progress in (10, 20, 30):
            transition(task, "running", stage="provider_running", progress=progress)
        await session.commit()

    monkeypatch.setattr("app.db.SessionFactory", session_factory)
    monkeypatch.setattr(task_event_stream, "POLL_INTERVAL_SECONDS", 0)

    # 事件 1..4；Last-Event-ID 比 after 大，以它为准
    request = _Request({"last-event-id": "3"}, polls=1)
    response = await stream_task_events(request, after=1, canvas_id=None)  # type: ignore[arg-type]
    assert response.media_type == "text/event-stream"
    assert response.headers["cache-control"] == "no-cache"
    assert response.headers["x-accel-buffering"] == "no"

    frames = [
        _parse(chunk if isinstance(chunk, str) else bytes(chunk).decode("utf-8"))
        async for chunk in response.body_iterator
    ]
    assert [int(f["id"]) for f in frames] == [4]
    assert frames[0]["event"] == "task"
    assert frames[0]["data"]["task_id"] == task.id
    assert frames[0]["data"]["progress"] == 30.0
