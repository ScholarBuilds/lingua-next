"""任务事件 SSE 的读取与组帧：游标缺口等待、FlowRun 快照去重、画布版本帧、轮询循环。

``StudioTaskEvent.global_cursor`` 取自 PostgreSQL 序列：取号不随事务回滚，提交顺序
也不保证与取号顺序一致。先取号、后提交的事件会落在读侧 ``global_cursor > cursor``
的窗口之前，被永久跳过。这里把「连续性」当作推进游标的条件——遇到缺口先停住等
``GAP_WAIT_SECONDS``，缺口被填上就按序放行，超时（序列回滚留下的永久空洞）再跳过。

:class:`GapAwareCursorReader`、:class:`FlowRunSnapshotTracker` 与 :class:`CanvasVersionTracker`
是纯 Python 的行处理器，不碰数据库，SQLite 与 PostgreSQL 通用；:func:`iter_sse_frames`
负责轮询与 SSE 组帧。

canvas 帧：任何一次 ``StudioCanvas.updated_at`` 变化（别的标签页保存、服务端 projector
落图）都推一帧 ``{canvas_id, version, updated_at, origin, landed}``，不带 id 行、不推进
游标；前端拿它判断「远端比我新」再拉全量合并。

invocation 帧：回看窗口内新建或写过终态的 ``ModelInvocation`` 整快照（``invocation_view``），
同样不带 id 行；账本页靠它实时插行 / 改状态，不再轮询。

pipeline 帧：活跃的 ``PipelineRun`` 与窗口内新建/收口的 run 整快照（``pipeline_run_view``，
字段对齐 /api/pipeline/stream 的单条 run 形状），不带 id 行；任何 run 变化 ≤1s 推一帧，
管线中心与任务中心不必再各开一条 /pipeline/stream。

唤醒：轮询兜底间隔 1s；PostgreSQL 下写侧提交任务事件会 ``pg_notify``（见
``domain.studio_tasks.emit_event_notify``），路由层把「等通知或超时」注入 ``sleep``
（见 ``app.db.event_wakeup``），事件到达即刻进入下一轮查询，不等满 1s。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from collections.abc import AsyncGenerator, Awaitable, Callable, Sequence
from datetime import UTC, datetime, timedelta
from typing import Protocol

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from domain.canvas_projector import canvas_event_view
from domain.model_invocations import invocation_view, list_invocations_updated_since
from domain.models import ModelInvocation, StudioCanvas, StudioFlowRun, StudioTaskEvent
from domain.pipeline import list_pipeline_runs_updated_since, pipeline_run_snapshots
from domain.studio import list_canvases_updated_since
from domain.studio_flows import flow_run_view, list_flow_runs_updated_since
from domain.studio_tasks import event_view, list_task_events

GAP_WAIT_SECONDS = 3.0
POLL_INTERVAL_SECONDS = 1.0
PAGE_SIZE = 200
# FlowRun 变化窗口至少回看 1s。SQLite 的 CURRENT_TIMESTAMP 只有秒精度，且同秒的存储值
# 比带微秒的参数「短」，字符串比较会判小；整秒向下取整再多退一秒，同一秒的更新不会漏。
FLOW_LOOKBACK_SECONDS = 2
SNAPSHOT_MEMORY = 1024
KEEP_ALIVE_FRAME = ": keep-alive\n\n"


class CursorRow(Protocol):
    global_cursor: int


class GapAwareCursorReader:
    """按 global_cursor 连续推进的读取器。

    每轮喂入 ``global_cursor > cursor`` 的升序行，返回这一轮可以发射的行，并把
    ``cursor`` 推到最后一条发射行。缺口之前的行照常发射；缺口之后的行从首次看到算起
    等 ``gap_wait_seconds``，期间缺口被填上则按序放行，超时则跳过缺口继续推进。

    同一页里的多个缺口在同一轮被看到，超时后一次性全部跳过，历史积压不会按缺口数
    线性放大等待。``cursor == 0`` 表示没有续传位置（全新订阅），第一行直接作为起点，
    不把「历史事件已被清理」误判成缺口。
    """

    def __init__(self, cursor: int = 0, *, gap_wait_seconds: float = GAP_WAIT_SECONDS) -> None:
        self.cursor = max(0, int(cursor))
        self.gap_wait_seconds = gap_wait_seconds
        self._first_seen: dict[int, float] = {}

    def feed[RowT: CursorRow](self, rows: Sequence[RowT], *, now: float) -> list[RowT]:
        for row in rows:
            self._first_seen.setdefault(row.global_cursor, now)
        emitted: list[RowT] = []
        for row in rows:
            cursor = row.global_cursor
            if cursor <= self.cursor:
                continue
            contiguous = self.cursor == 0 or cursor == self.cursor + 1
            if not contiguous and now - self._first_seen[cursor] < self.gap_wait_seconds:
                break
            emitted.append(row)
            self.cursor = cursor
        self._first_seen = {
            key: seen for key, seen in self._first_seen.items() if key > self.cursor
        }
        return emitted


class FlowRunSnapshotTracker:
    """记住每个 FlowRun 最近一次推出的快照指纹，回看窗口重叠时不重复推帧。"""

    def __init__(self, *, memory: int = SNAPSHOT_MEMORY) -> None:
        self.memory = memory
        self._sent: dict[str, str] = {}

    def accept(self, run: StudioFlowRun) -> str | None:
        """返回需要推送的 data 正文；快照与上次推出的相同时返回 None。"""
        body = json.dumps(flow_run_view(run), ensure_ascii=False)
        fingerprint = hashlib.blake2b(body.encode("utf-8"), digest_size=16).hexdigest()
        if self._sent.get(run.id) == fingerprint:
            return None
        self._sent.pop(run.id, None)
        self._sent[run.id] = fingerprint
        while len(self._sent) > self.memory:
            self._sent.pop(next(iter(self._sent)))
        return body


class CanvasVersionTracker:
    """记住每个画布最近推出的 version，回看窗口重叠时同一版本不重复推帧。"""

    def __init__(self, *, memory: int = SNAPSHOT_MEMORY) -> None:
        self.memory = memory
        self._sent: dict[int, int] = {}

    def accept(self, canvas: StudioCanvas) -> str | None:
        """返回需要推送的 data 正文；这一版已经推过时返回 None。"""
        version = int(canvas.version or 0)
        if self._sent.get(canvas.id) == version:
            return None
        self._sent.pop(canvas.id, None)
        self._sent[canvas.id] = version
        while len(self._sent) > self.memory:
            self._sent.pop(next(iter(self._sent)))
        return json.dumps(canvas_event_view(canvas), ensure_ascii=False)


class InvocationSnapshotTracker:
    """记住每条台账行最近推出的快照指纹，回看窗口重叠时同一状态不重复推帧。"""

    def __init__(self, *, memory: int = SNAPSHOT_MEMORY) -> None:
        self.memory = memory
        self._sent: dict[str, str] = {}

    def accept(self, row: ModelInvocation) -> str | None:
        """返回需要推送的 data 正文；快照与上次推出的相同时返回 None。"""
        body = json.dumps(invocation_view(row), ensure_ascii=False)
        fingerprint = hashlib.blake2b(body.encode("utf-8"), digest_size=16).hexdigest()
        if self._sent.get(row.id) == fingerprint:
            return None
        self._sent.pop(row.id, None)
        self._sent[row.id] = fingerprint
        while len(self._sent) > self.memory:
            self._sent.pop(next(iter(self._sent)))
        return body


class PipelineRunSnapshotTracker:
    """记住每条 PipelineRun 最近推出的快照指纹，回看窗口重叠时不重复推帧。

    与 :class:`FlowRunSnapshotTracker` 同构，但输入是已经组装好的快照 dict——
    run 的快照要跨表拼（节点行 + 主体标题），序列化在查询侧批量做完。
    """

    def __init__(self, *, memory: int = SNAPSHOT_MEMORY) -> None:
        self.memory = memory
        self._sent: dict[int, str] = {}

    def accept(self, view: dict) -> str | None:
        """返回需要推送的 data 正文；快照与上次推出的相同时返回 None。"""
        run_id = int(view["run_id"])
        body = json.dumps(view, ensure_ascii=False)
        fingerprint = hashlib.blake2b(body.encode("utf-8"), digest_size=16).hexdigest()
        if self._sent.get(run_id) == fingerprint:
            return None
        self._sent.pop(run_id, None)
        self._sent[run_id] = fingerprint
        while len(self._sent) > self.memory:
            self._sent.pop(next(iter(self._sent)))
        return body


def task_frame(row: StudioTaskEvent) -> str:
    body = json.dumps(event_view(row), ensure_ascii=False)
    # SSE 传输层只用稳定的 task 事件名；可扩展的业务类型在 body.event_type。
    return f"id: {row.global_cursor}\nevent: task\ndata: {body}\n\n"


def flow_frame(body: str) -> str:
    # flow 帧是整快照，不带 id 行，不推进 Last-Event-ID 游标。
    return f"event: flow\ndata: {body}\n\n"


def canvas_frame(body: str) -> str:
    # canvas 帧只报版本与落图明细，同样不带 id 行。
    return f"event: canvas\ndata: {body}\n\n"


def invocation_frame(body: str) -> str:
    # invocation 帧是台账行整快照，不带 id 行。
    return f"event: invocation\ndata: {body}\n\n"


def pipeline_frame(body: str) -> str:
    # pipeline 帧是单条 run 整快照，不带 id 行，不推进 Last-Event-ID 游标。
    return f"event: pipeline\ndata: {body}\n\n"


def flow_lookback_since(polled_at: datetime) -> datetime:
    return (polled_at - timedelta(seconds=FLOW_LOOKBACK_SECONDS)).replace(microsecond=0)


async def iter_sse_frames(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    initial_cursor: int = 0,
    canvas_id: int | None = None,
    should_stop: Callable[[], Awaitable[bool]],
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> AsyncGenerator[str, None]:
    """逐帧产出 SSE 文本：task 帧（带 id）、flow / canvas / invocation 帧（不带 id）、
    keep-alive 注释。

    每轮开一个短会话查四样东西：游标之后的任务事件、上次轮询前 2s 起有变化的
    FlowRun、同一窗口内 updated_at 变过的画布、同一窗口内新建或收口的模型调用。
    ``should_stop`` 每轮询问一次（路由层传 ``request.is_disconnected``），``sleep`` 与
    ``clock`` 可注入，便于测试不真等。
    """
    reader = GapAwareCursorReader(initial_cursor)
    snapshots = FlowRunSnapshotTracker()
    canvases = CanvasVersionTracker()
    invocations = InvocationSnapshotTracker()
    pipelines = PipelineRunSnapshotTracker()
    last_poll = datetime.now(UTC)
    while not await should_stop():
        polled_at = datetime.now(UTC)
        lookback = flow_lookback_since(last_poll)
        async with session_factory() as session:
            # 缺口判断要看全局序列，canvas 过滤放到发射阶段；
            # 否则别的画布的事件全都会被当成缺口去等。
            event_rows = await list_task_events(
                session, after_cursor=reader.cursor, limit=PAGE_SIZE
            )
            run_rows = await list_flow_runs_updated_since(
                session, since=lookback, limit=PAGE_SIZE
            )
            canvas_rows = await list_canvases_updated_since(
                session, since=lookback, limit=PAGE_SIZE
            )
            invocation_rows = await list_invocations_updated_since(
                session, since=lookback, limit=PAGE_SIZE
            )
            run_views = await pipeline_run_snapshots(
                session,
                await list_pipeline_runs_updated_since(
                    session, since=lookback, limit=PAGE_SIZE
                ),
            )
        last_poll = polled_at
        sent = False
        for row in reader.feed(event_rows, now=clock()):
            if canvas_id is not None and row.canvas_id != canvas_id:
                continue
            yield task_frame(row)
            sent = True
        for run in run_rows:
            body = snapshots.accept(run)
            if body is None:
                continue
            yield flow_frame(body)
            sent = True
        for canvas in canvas_rows:
            if canvas_id is not None and canvas.id != canvas_id:
                continue
            body = canvases.accept(canvas)
            if body is None:
                continue
            yield canvas_frame(body)
            sent = True
        for invocation in invocation_rows:
            if canvas_id is not None and invocation.canvas_id != canvas_id:
                continue
            body = invocations.accept(invocation)
            if body is None:
                continue
            yield invocation_frame(body)
            sent = True
        # pipeline 帧与 flow 帧同理是全局快照，不做 canvas 过滤——管线 run 不挂画布
        for view in run_views:
            body = pipelines.accept(view)
            if body is None:
                continue
            yield pipeline_frame(body)
            sent = True
        if not sent:
            yield KEEP_ALIVE_FRAME
        # 整页都连续吃完说明还在追积压，立刻查下一页；停在缺口上的整页仍按节奏等。
        backlog = len(event_rows) >= PAGE_SIZE and reader.cursor == event_rows[-1].global_cursor
        if not backlog:
            await sleep(POLL_INTERVAL_SECONDS)
