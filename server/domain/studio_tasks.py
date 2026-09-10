"""创作任务的状态机与序列化（模块 17 BR-174/176）。"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from arq.constants import abort_jobs_ss
from arq.utils import timestamp_ms
from sqlalchemy import event, inspect, or_, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session, object_session

from domain.models import ImageJob, StudioTask, StudioTaskEvent

TASK_STATUSES = frozenset({
    "queued",
    "submitting",
    "running",
    "succeeded",
    "partial",
    "failed",
    "cancelled",
    "recovering",
})
TERMINAL_STATUSES = frozenset({"succeeded", "partial", "failed", "cancelled"})
ACTIVE_STATUSES = frozenset({"queued", "submitting", "running", "recovering"})
# 已被 worker 领走、靠心跳证明还活着的状态；queued 没人持有租约，不参与扫描
LEASED_STATUSES = frozenset({"submitting", "running", "recovering"})
CANCEL_KEY_PREFIX = "lingua:studio-task:cancel:"
JOB_KEY_PREFIX = "lingua:studio-task:job:"
CANCEL_MARK_TTL_SECONDS = 24 * 3600
DEFAULT_LEASE_SECONDS = 600
CANCELLED_BY_USER = "用户取消了任务"
LEASE_EXPIRED_ERROR = "lease_expired"
ALLOWED_TRANSITIONS: dict[str, frozenset[str]] = {
    "queued": frozenset({"submitting", "running", "recovering", "failed", "cancelled"}),
    "submitting": frozenset({"submitting", "running", "recovering", "failed", "cancelled"}),
    "running": frozenset({"running", "recovering", "succeeded", "partial", "failed", "cancelled"}),
    "recovering": frozenset({
        "recovering", "submitting", "running", "succeeded", "partial", "failed", "cancelled",
    }),
    "succeeded": frozenset(),
    "partial": frozenset(),
    "failed": frozenset(),
    "cancelled": frozenset(),
}


class StudioTaskError(ValueError):
    pass


# 事件流的 NOTIFY 频道：任务事件提交即唤醒 SSE 循环，worker 进程写的事件也能推醒 API
EVENT_NOTIFY_CHANNEL = "lingua_events"
_NOTIFY_PENDING = "lingua_event_notify_pending"


def request_event_notify(session: Session) -> None:
    """登记「这个事务提交时要 NOTIFY 事件流」；真正发送在 :func:`emit_event_notify`。"""
    session.info[_NOTIFY_PENDING] = True


@event.listens_for(Session, "before_commit")
def emit_event_notify(session: Session) -> None:
    """提交前在同一事务里发 ``pg_notify``。

    PostgreSQL 的 NOTIFY 是事务性的——提交才投递、回滚即作废，所以放 before_commit
    而不是 after_commit（后者不能再发 SQL，只能另开连接）。除了 transition 登记的
    标记，还看一眼 session.new 里有没有新任务事件：new_task 建的 task.queued 事件
    没有经过 transition，靠这条兜住。SQLite 等没有 NOTIFY 的库静默跳过。
    """
    pending = session.info.pop(_NOTIFY_PENDING, False)
    if not pending and not any(isinstance(obj, StudioTaskEvent) for obj in session.new):
        return
    bind = session.bind
    if bind is None or bind.dialect.name != "postgresql":
        return
    session.execute(
        text("SELECT pg_notify(:channel, '')"), {"channel": EVENT_NOTIFY_CHANNEL}
    )


class CancelStoreLike(Protocol):
    """取消标记与 worker job 登记只用到的 Redis 动词；arq 的 ArqRedis 天然满足。"""

    async def get(self, key: str) -> Any: ...

    async def set(self, key: str, value: Any, *, ex: int | None = None) -> Any: ...

    async def delete(self, *keys: str) -> Any: ...

    async def zadd(self, key: str, mapping: dict[str, float]) -> Any: ...


def cancel_key(task_id: str) -> str:
    return f"{CANCEL_KEY_PREFIX}{task_id}"


def job_key(task_id: str) -> str:
    return f"{JOB_KEY_PREFIX}{task_id}"


def is_recoverable(task: StudioTask) -> bool:
    """上游持有任务 ID 的执行（工作流/视频/MJ）断了可以续轮询；其余中断只能重试。

    启动对账与租约扫描共用这一条规则。
    """
    task_type = task.task_type or ""
    return bool(task.provider_task_id) and (
        task_type.startswith("workflow.")
        or task_type == "video.generate"
        or task_type in {"midjourney.generate", "midjourney.action"}
    )


async def is_cancel_requested(redis: CancelStoreLike, task_id: str) -> bool:
    return bool(await redis.get(cancel_key(task_id)))


async def mark_cancel_requested(redis: CancelStoreLike, task_id: str) -> None:
    await redis.set(cancel_key(task_id), "1", ex=CANCEL_MARK_TTL_SECONDS)


async def register_worker_job(redis: CancelStoreLike, task_id: str, job_id: str) -> None:
    """worker 开跑时登记 arq job id，取消端点据此让 arq 中止协程。"""
    await redis.set(job_key(task_id), job_id, ex=CANCEL_MARK_TTL_SECONDS)


async def clear_cancel_marks(redis: CancelStoreLike, task_id: str) -> None:
    await redis.delete(cancel_key(task_id), job_key(task_id))


async def abort_arq_job(redis: CancelStoreLike, job_id: str) -> None:
    """把 job 放进 arq 的 abort 集合；worker 轮询到就 cancel 协程并记成 aborted（不重试）。

    等价于 `arq.jobs.Job.abort()` 去掉"等结果"那一步——取消端点不该为此阻塞。
    """
    await redis.zadd(abort_jobs_ss, {job_id: timestamp_ms()})


async def abort_worker_job(redis: CancelStoreLike, task_id: str) -> str | None:
    """按登记的 job id 中止 arq 任务；没登记（还在排队/旧 worker）就只靠取消标记。"""
    raw = await redis.get(job_key(task_id))
    if not raw:
        return None
    job_id = raw.decode() if isinstance(raw, bytes) else str(raw)
    await abort_arq_job(redis, job_id)
    return job_id


async def fail_image_jobs(session: AsyncSession, task_id: str, error: str) -> None:
    """图片领域任务跟着 StudioTask 一起收口，不留永远 running 的 ImageJob。"""
    await session.execute(
        update(ImageJob)
        .where(
            ImageJob.studio_task_id == task_id,
            ImageJob.status.in_(("pending", "running")),
        )
        .values(status="failed", error=error)
    )


async def request_cancel(
    session: AsyncSession,
    redis: CancelStoreLike,
    task: StudioTask,
) -> StudioTask:
    """取消任务：排队中的直接收口；已被 worker 领走的打标记，由 worker 在协作点收口。

    两种分支都写 Redis 标记——排队任务也可能恰好刚被 worker 读到，标记能让它在
    下一个检查点停下。登记过 arq job id 的再让 arq 直接中止协程。
    """
    if task.status in TERMINAL_STATUSES:
        raise StudioTaskError("任务已结束，不能取消")
    await mark_cancel_requested(redis, task.id)
    if task.status == "queued":
        transition(
            task,
            "cancelled",
            stage="cancelled",
            error=CANCELLED_BY_USER,
            retryable=True,
        )
        await fail_image_jobs(session, task.id, CANCELLED_BY_USER)
        await session.commit()
    await abort_worker_job(redis, task.id)
    return task


def _as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


async def sweep_stale_tasks(
    session: AsyncSession,
    *,
    lease_seconds: int = DEFAULT_LEASE_SECONDS,
    queue: Any | None = None,
    now: datetime | None = None,
) -> dict[str, list[str]]:
    """心跳过期的活跃任务：能续轮询的置 recovering 重新入队，其余判 lease_expired。

    活跃任务通常只有几条，全部取回在 Python 里比时间——SQLite 存的是 naive 时间，
    直接在 SQL 里比 aware 参数两边行为不一致。
    """
    from domain.tool_execution import enqueue_task

    moment = now or datetime.now(UTC)
    cutoff = moment - timedelta(seconds=lease_seconds)
    rows = list(
        (
            await session.execute(
                select(StudioTask).where(StudioTask.status.in_(tuple(LEASED_STATUSES)))
            )
        ).scalars()
    )
    stale: list[StudioTask] = []
    for row in rows:
        last_seen = _as_utc(row.heartbeat_at or row.started_at or row.created_at)
        if last_seen is None or last_seen < cutoff:
            stale.append(row)
    recovered = [row for row in stale if is_recoverable(row)]
    failed = [row for row in stale if not is_recoverable(row)]
    for row in recovered:
        transition(row, "recovering", stage="lease_recover", retryable=True)
    for row in failed:
        transition(
            row,
            "failed",
            stage="lease_expired",
            error=LEASE_EXPIRED_ERROR,
            retryable=True,
        )
        await fail_image_jobs(session, row.id, LEASE_EXPIRED_ERROR)
    if stale:
        await session.commit()
    for row in recovered:
        try:
            if queue is None:
                raise RuntimeError("worker Redis 连接不存在")
            # 固定 job id：上一轮恢复还在排队时 arq 直接忽略，不会为同一任务开两份轮询
            await enqueue_task(queue, row, _job_id=f"lease-recover:{row.id}")
        except Exception as exc:
            transition(
                row,
                "failed",
                stage="lease_expired",
                error=f"租约到期后恢复入队失败：{type(exc).__name__}: {exc}",
                retryable=True,
            )
            await fail_image_jobs(session, row.id, LEASE_EXPIRED_ERROR)
            failed.append(row)
    if recovered:
        await session.commit()
    recovered_ids = [row.id for row in recovered if row.status == "recovering"]
    return {"recovered": recovered_ids, "failed": [row.id for row in failed]}


def task_view(row: StudioTask) -> dict:
    return {
        "id": row.id,
        "domain": row.domain,
        "tool_id": row.tool_id,
        "task_type": row.task_type,
        "parent_task_id": row.parent_task_id,
        "batch_id": row.batch_id,
        "source_route": row.source_route,
        "source_context": row.source_context,
        "capability": row.capability,
        "deployment_id": row.deployment_id,
        "invocation": row.invocation,
        "provider_task_id": row.provider_task_id,
        "canvas_id": row.canvas_id,
        "node_id": row.node_id,
        "execution_group_id": row.execution_group_id,
        "status": row.status,
        "stage": row.stage,
        "progress": row.progress,
        "result": row.result,
        "error": row.error,
        "retryable": row.retryable,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "started_at": row.started_at.isoformat() if row.started_at else None,
        "heartbeat_at": row.heartbeat_at.isoformat() if row.heartbeat_at else None,
        "finished_at": row.finished_at.isoformat() if row.finished_at else None,
        "event_seq": row.event_seq,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


def event_view(row: StudioTaskEvent) -> dict:
    return {
        "cursor": row.global_cursor,
        "task_id": row.task_id,
        "seq": row.seq,
        "event_type": row.event_type,
        "status": row.status,
        "stage": row.stage,
        "progress": row.progress,
        "message": row.message,
        "payload": row.payload,
        "canvas_id": row.canvas_id,
        "node_id": row.node_id,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


def new_task(
    *,
    tool_id: str,
    task_type: str,
    domain: str = "studio",
    parent_task_id: str | None = None,
    batch_id: str | None = None,
    source_route: str | None = None,
    source_context: dict[str, Any] | None = None,
    capability: str | None = None,
    deployment_id: int | None = None,
    invocation: dict[str, Any] | None = None,
    mission_id: str | None = None,
) -> StudioTask:
    context = dict(source_context or {})
    raw_canvas_id = context.get("canvas_id")
    try:
        canvas_id = int(raw_canvas_id) if raw_canvas_id is not None else None
    except (TypeError, ValueError):
        canvas_id = None
    node_id = str(context["node_id"]) if context.get("node_id") is not None else None
    task = StudioTask(
        id=uuid.uuid4().hex,
        domain=domain,
        tool_id=tool_id,
        task_type=task_type,
        parent_task_id=parent_task_id,
        batch_id=batch_id,
        source_route=source_route,
        source_context=context or None,
        capability=capability,
        deployment_id=deployment_id,
        invocation=invocation,
        mission_id=mission_id or (
            str(context["mission_id"]) if context.get("mission_id") is not None else None
        ),
        canvas_id=canvas_id,
        node_id=node_id,
        execution_group_id=(
            str(context["execution_group_id"])
            if context.get("execution_group_id") is not None
            else batch_id
        ),
        status="queued",
        progress=0.0,
        event_seq=1,
    )
    task.events.append(
        StudioTaskEvent(
            task_id=task.id,
            seq=1,
            event_type="task.queued",
            status="queued",
            stage="queued",
            progress=0.0,
            payload=None,
            canvas_id=canvas_id,
            node_id=node_id,
        )
    )
    return task


def transition(
    row: StudioTask,
    status: str,
    *,
    stage: str | None = None,
    progress: float | None = None,
    result: dict[str, Any] | None = None,
    error: str | None = None,
    retryable: bool | None = None,
    provider_task_id: str | None = None,
) -> None:
    if status not in TASK_STATUSES:
        raise StudioTaskError(f"未知任务状态：{status}")
    current = row.status or "queued"
    if status not in ALLOWED_TRANSITIONS.get(current, frozenset()):
        raise StudioTaskError(f"非法任务状态迁移：{current} -> {status}")
    now = datetime.now(UTC)
    if row.started_at is None and status in {"submitting", "running", "recovering"}:
        row.started_at = now
    if status in {"submitting", "running", "recovering"}:
        row.heartbeat_at = now
    if status in TERMINAL_STATUSES:
        row.finished_at = now
    row.status = status
    if stage is not None:
        row.stage = stage
    if progress is not None:
        row.progress = max(0.0, min(float(progress), 100.0))
    elif status == "succeeded":
        row.progress = 100.0
    if result is not None:
        row.result = result
    row.error = error
    if retryable is not None:
        row.retryable = retryable
    if provider_task_id is not None:
        row.provider_task_id = provider_task_id
    sync_session = object_session(row)
    if sync_session is not None or inspect(row).transient:
        from domain.model_invocations import safe_payload

        row.event_seq = int(row.event_seq or 0) + 1
        event_type = "task.progress" if status == current else f"task.{status}"
        event_payload = safe_payload({
            "retryable": row.retryable,
            "provider_task_id": row.provider_task_id,
            "result": result,
        })
        event = StudioTaskEvent(
            task_id=row.id,
            seq=row.event_seq,
            event_type=event_type,
            status=row.status,
            stage=row.stage,
            progress=row.progress,
            message=safe_payload(error) if error else None,
            payload=event_payload,
            canvas_id=row.canvas_id,
            node_id=row.node_id,
        )
        if sync_session is not None:
            sync_session.add(event)
            request_event_notify(sync_session)
        else:
            row.events.append(event)


async def list_tasks(
    session: AsyncSession,
    *,
    status: str | None = None,
    tool_id: str | None = None,
    domain: str | None = None,
    canvas_id: int | None = None,
    node_id: str | None = None,
    source_node_id: str | None = None,
    origin_node_id: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> list[StudioTask]:
    stmt = select(StudioTask)
    if status:
        if status not in TASK_STATUSES:
            raise StudioTaskError(f"未知任务状态：{status}")
        stmt = stmt.where(StudioTask.status == status)
    if tool_id:
        stmt = stmt.where(StudioTask.tool_id == tool_id)
    if domain:
        stmt = stmt.where(StudioTask.domain == domain)
    if canvas_id is not None:
        stmt = stmt.where(StudioTask.canvas_id == canvas_id)
    if node_id:
        stmt = stmt.where(StudioTask.node_id == node_id)
    if source_node_id:
        stmt = stmt.where(
            StudioTask.source_context["source_node_id"].as_string() == source_node_id
        )
    if origin_node_id:
        stmt = stmt.where(
            or_(
                StudioTask.node_id == origin_node_id,
                StudioTask.source_context["source_node_id"].as_string() == origin_node_id,
            )
        )
    stmt = stmt.order_by(StudioTask.created_at.desc()).offset(max(0, offset)).limit(
        max(1, min(limit, 200))
    )
    return list((await session.execute(stmt)).scalars())


async def list_task_events(
    session: AsyncSession,
    *,
    after_cursor: int = 0,
    task_id: str | None = None,
    canvas_id: int | None = None,
    limit: int = 200,
) -> list[StudioTaskEvent]:
    stmt = select(StudioTaskEvent).where(StudioTaskEvent.global_cursor > max(0, after_cursor))
    if task_id:
        stmt = stmt.where(StudioTaskEvent.task_id == task_id)
    if canvas_id is not None:
        stmt = stmt.where(StudioTaskEvent.canvas_id == canvas_id)
    stmt = stmt.order_by(StudioTaskEvent.global_cursor).limit(max(1, min(limit, 500)))
    return list((await session.execute(stmt)).scalars())
