"""创作域统一任务中心 API。"""

from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.media import media_response
from app.queue import get_queue
from app.routers.dict import SessionDep
from domain import task_history
from domain.models import ImageJob, StudioFlowRun, StudioTask
from domain.studio_flows import flow_run_view
from domain.studio_tasks import (
    TERMINAL_STATUSES,
    StudioTaskError,
    event_view,
    list_task_events,
    list_tasks,
    new_task,
    request_cancel,
    task_view,
    transition,
)
from domain.task_event_stream import iter_sse_frames
from domain.tool_execution import ToolExecutionError, enqueue_task, queue_call_for

router = APIRouter(prefix="/studio/tasks", tags=["studio-tasks"])
SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


class TaskCleanupBody(BaseModel):
    task_ids: list[str] = Field(min_length=1, max_length=200)


@router.get("/summary")
async def task_summary(session: SessionDep) -> dict:
    return await task_history.summary(session)


@router.get("/history")
async def task_history_page(
    session: SessionDep,
    scope: str = "all",
    cursor: str | None = None,
    identity: str | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
) -> dict:
    from app.routers.pipeline import list_runs

    rows, next_cursor = await task_history.history_ids(session, scope, cursor, limit, identity)
    ids = {
        kind: [row.id for row in rows if row.kind == kind] for kind in ("task", "flow", "pipeline")
    }
    tasks = (await session.scalars(select(StudioTask).where(StudioTask.id.in_(ids["task"])))).all()
    flows = (
        await session.scalars(select(StudioFlowRun).where(StudioFlowRun.id.in_(ids["flow"])))
    ).all()
    task_by_id = {row.id: row for row in tasks}
    flow_by_id = {row.id: row for row in flows}
    pipeline = (
        await list_runs(session, run_ids=[int(value) for value in ids["pipeline"]], limit=100)
        if ids["pipeline"]
        else {"items": []}
    )
    return {
        "tasks": [task_view(task_by_id[key]) for key in ids["task"] if key in task_by_id],
        "flows": [flow_run_view(flow_by_id[key]) for key in ids["flow"] if key in flow_by_id],
        "pipeline": pipeline["items"],
        "next_cursor": next_cursor,
    }


@router.get("")
async def get_tasks(
    session: SessionDep,
    status: str | None = None,
    tool_id: str | None = None,
    domain: str | None = None,
    canvas_id: int | None = None,
    node_id: str | None = None,
    source_node_id: str | None = None,
    origin_node_id: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> dict:
    try:
        rows = await list_tasks(
            session,
            status=status,
            tool_id=tool_id,
            domain=domain,
            canvas_id=canvas_id,
            node_id=node_id,
            source_node_id=source_node_id,
            origin_node_id=origin_node_id,
            limit=limit,
            offset=offset,
        )
    except StudioTaskError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"items": [task_view(row) for row in rows]}


@router.get("/events/stream")
async def stream_task_events(
    request: Request,
    after: int = 0,
    canvas_id: int | None = None,
) -> StreamingResponse:
    """全局持久任务 SSE；cursor 可从 Last-Event-ID 或 after 恢复。

    task 帧带 id 行推进游标；flow / canvas / invocation / pipeline 帧是整快照，
    不带 id 行。游标只认 global_cursor 连续才推进，缺口的等待与跳过见
    domain.task_event_stream。轮询间隔经 event_wakeup 注入：PostgreSQL 下事件
    提交即 NOTIFY 唤醒，1s 只是兜底；其它库退化为纯 1s 轮询。
    """
    from app.db import SessionFactory, event_wakeup

    raw_last = request.headers.get("last-event-id")
    try:
        initial_cursor = max(after, int(raw_last or 0))
    except ValueError:
        initial_cursor = max(after, 0)

    frames = iter_sse_frames(
        SessionFactory,
        initial_cursor=initial_cursor,
        canvas_id=canvas_id,
        should_stop=request.is_disconnected,
        sleep=event_wakeup(SessionFactory),
    )
    return StreamingResponse(frames, media_type="text/event-stream", headers=SSE_HEADERS)


@router.post("/cleanup")
async def cleanup_tasks(body: TaskCleanupBody, session: SessionDep) -> dict:
    """删除终态任务记录；生成资产与领域记录继续保留。

    一批中只要混入活动任务就整体拒绝，避免界面筛选变化时误删正在执行的队列项。
    """
    task_ids = list(dict.fromkeys(body.task_ids))
    rows = list(
        (await session.execute(select(StudioTask).where(StudioTask.id.in_(task_ids)))).scalars()
    )
    active = [row.id for row in rows if row.status not in TERMINAL_STATUSES]
    if active:
        raise HTTPException(
            status_code=409,
            detail=f"进行中任务不可清理：{', '.join(active[:5])}",
        )
    for row in rows:
        await session.delete(row)
    await session.commit()
    found = {row.id for row in rows}
    return {
        "deleted": len(rows),
        "missing": [task_id for task_id in task_ids if task_id not in found],
    }


@router.get("/{task_id}")
async def get_task(task_id: str, session: SessionDep) -> dict:
    row = await session.get(StudioTask, task_id)
    if row is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    return task_view(row)


@router.get("/{task_id}/events")
async def get_task_events(
    task_id: str,
    session: SessionDep,
    after: int = 0,
    limit: int = 200,
) -> dict:
    task = await session.get(StudioTask, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    rows = await list_task_events(
        session,
        after_cursor=after,
        task_id=task_id,
        limit=limit,
    )
    return {"items": [event_view(row) for row in rows]}


@router.post("/{task_id}/cancel", status_code=202)
async def cancel_task(task_id: str, session: SessionDep) -> dict:
    """取消任务：排队中的立即收口；已在执行的打取消标记，worker 在协作点收口。

    已执行的任务返回时仍是原状态，终态 cancelled 随后经 SSE 推到；终态任务 409。
    """
    row = await session.get(StudioTask, task_id)
    if row is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    if row.status in TERMINAL_STATUSES:
        raise HTTPException(status_code=409, detail="任务已结束，不能取消")
    try:
        redis = await get_queue()
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=f"任务队列不可用：{type(exc).__name__}: {exc}",
        ) from exc
    try:
        await request_cancel(session, redis, row)
    except StudioTaskError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    await session.refresh(row)
    return {"task": task_view(row)}


@router.post("/{task_id}/retry", status_code=202)
async def retry_task(task_id: str, session: SessionDep) -> dict:
    """复制失败任务的快照重试，保留原任务作为审计记录。

    如果旧任务已经拿到上游 ID，新任务会继续轮询该 ID，不重复提交；
    上游已明确失败的任务会在 worker 中清掉 ID，重试时新建执行。
    """
    row = await session.get(StudioTask, task_id)
    if row is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    if row.status not in {"failed", "partial", "cancelled"}:
        raise HTTPException(status_code=409, detail="只能重试已结束的任务")
    if not row.retryable:
        raise HTTPException(status_code=409, detail="该任务的失败原因不支持重试")
    try:
        queue_call_for(row)
    except ToolExecutionError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    retry = new_task(
        tool_id=row.tool_id,
        task_type=row.task_type,
        domain=row.domain,
        parent_task_id=row.id,
        batch_id=row.batch_id,
        source_route=row.source_route,
        source_context=dict(row.source_context or {}),
        capability=row.capability,
        deployment_id=row.deployment_id,
        invocation=dict(row.invocation or {}),
    )
    retry.provider_task_id = row.provider_task_id
    session.add(retry)
    image_job = None
    if row.task_type in {"image.generate", "image.rerun"}:
        image_job_id = (row.invocation or {}).get("image_job_id")
        image_job = await session.get(ImageJob, int(image_job_id))
        if image_job is None:
            raise HTTPException(status_code=409, detail="图片领域任务不存在，无法重试")
        image_job.studio_task_id = retry.id
        image_job.status = "pending"
        image_job.error = None
    await session.commit()
    try:
        queue = await get_queue()
        await enqueue_task(queue, retry)
    except Exception as exc:
        transition(
            retry,
            "failed",
            stage="queue",
            error=f"重试任务入队失败：{type(exc).__name__}: {exc}",
            retryable=True,
        )
        if image_job is not None:
            image_job.status = "failed"
            image_job.error = retry.error
        await session.commit()
        raise HTTPException(status_code=503, detail=retry.error) from exc
    await session.refresh(retry)
    return task_view(retry)


@router.post("/{task_id}/rerun", status_code=202)
async def rerun_task(task_id: str, session: SessionDep) -> dict:
    """按不可变调用快照再次运行；不会复用旧上游任务或覆盖原历史。

    图片任务创建新的 ImageJob，其他已接入统一执行器的任务复制 invocation；点击此
    接口意味着一次新的模型/工作流调用，因此前端必须先向用户确认。
    """
    row = await session.get(StudioTask, task_id)
    if row is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    if row.status not in TERMINAL_STATUSES:
        raise HTTPException(status_code=409, detail="只能再次运行已结束的任务")
    try:
        queue_call_for(row)
    except ToolExecutionError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    invocation = dict(row.invocation or {})
    rerun = new_task(
        tool_id=row.tool_id,
        task_type=row.task_type,
        domain=row.domain,
        parent_task_id=row.id,
        batch_id=row.batch_id,
        source_route=row.source_route,
        source_context=dict(row.source_context or {}),
        capability=row.capability,
        deployment_id=row.deployment_id,
        invocation=invocation,
    )
    session.add(rerun)
    await session.flush([rerun])

    image_job = None
    if row.task_type in {"image.generate", "image.edit", "image.rerun"}:
        image_job_id = invocation.get("image_job_id")
        try:
            original_job = await session.get(ImageJob, int(image_job_id))
        except (TypeError, ValueError):
            original_job = None
        if original_job is None:
            raise HTTPException(status_code=409, detail="图片领域任务不存在，无法再次运行")
        image_job = ImageJob(
            target_key=original_job.target_key,
            idea=original_job.idea,
            subject_domain=original_job.subject_domain,
            subject_id=original_job.subject_id,
            style_key=original_job.style_key,
            size=original_job.size,
            quality=original_job.quality,
            n=original_job.n,
            alias=original_job.alias,
            prompt_override=original_job.prompt_override,
            options=dict(original_job.options or {}),
            status="pending",
            studio_task_id=rerun.id,
        )
        session.add(image_job)
        await session.flush([image_job])
        rerun.invocation = {**invocation, "image_job_id": image_job.id}

    await session.commit()
    try:
        queue = await get_queue()
        await enqueue_task(queue, rerun)
    except Exception as exc:
        transition(
            rerun,
            "failed",
            stage="queue",
            error=f"再次运行入队失败：{type(exc).__name__}: {exc}",
            retryable=True,
        )
        if image_job is not None:
            image_job.status = "failed"
            image_job.error = rerun.error
        await session.commit()
        raise HTTPException(status_code=503, detail=rerun.error) from exc
    await session.refresh(rerun)
    return task_view(rerun)


@router.get("/{task_id}/outputs/{output_index}", response_model=None)
async def get_task_output(
    task_id: str,
    output_index: int,
    session: SessionDep,
) -> Response:
    row = await session.get(StudioTask, task_id)
    if row is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    items = (row.result or {}).get("items") or []
    if output_index < 0 or output_index >= len(items):
        raise HTTPException(status_code=404, detail="任务产物不存在")
    item = items[output_index]
    if not isinstance(item, dict) or not item.get("storage_key"):
        raise HTTPException(status_code=404, detail="该产物由其他资产路由提供")
    return media_response(
        str(item["storage_key"]),
        media_type=str(item.get("mime") or "application/octet-stream"),
        filename=str(item.get("name") or f"output-{output_index + 1}"),
    )
