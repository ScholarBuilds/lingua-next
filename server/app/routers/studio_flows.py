"""创作工具 DAG 定义、运行快照、断点恢复与触发器 API。"""

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.queue import get_queue
from app.routers.dict import SessionDep
from domain.models import StudioFlow, StudioFlowRun, StudioTask
from domain.studio_flows import (
    FLOW_CANCELLABLE_STATUSES,
    StudioFlowError,
    create_flow,
    create_trigger,
    delete_trigger,
    flow_run_view,
    flow_schema_view,
    flow_tick_job_id,
    flow_view,
    interrupt_view,
    list_flow_interrupts,
    list_triggers,
    new_flow_run,
    new_inline_flow_run,
    promote_run_to_flow,
    resume_flow_input,
    resume_flow_run,
    retry_flow_run,
    trigger_view,
    update_flow,
    validate_flow_inputs,
)
from domain.studio_tasks import ACTIVE_STATUSES, request_cancel

router = APIRouter(prefix="/studio/flows", tags=["studio-flows"])


class FlowCreateBody(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=2000)
    definition: dict


class FlowUpdateBody(FlowCreateBody):
    base_version: int = Field(ge=1)
    enabled: bool = True


class FlowRunBody(BaseModel):
    inputs: dict = Field(default_factory=dict)
    source_context: dict | None = None


class InlineFlowRunBody(FlowRunBody):
    definition: dict


class FlowResumeBody(BaseModel):
    """带 node_id 时是"把人工输入填回挂起节点"，不带就是旧的失败重入语义。"""

    node_id: str | None = Field(default=None, min_length=1, max_length=96)
    resume_value: Any = None


class FlowPromoteBody(BaseModel):
    title: str | None = Field(default=None, max_length=160)
    description: str | None = Field(default=None, max_length=2000)


class FlowTriggerBody(BaseModel):
    kind: str = Field(min_length=1, max_length=24)
    cron: str | None = Field(default=None, max_length=120)
    task_type: str | None = Field(default=None, max_length=64)
    statuses: list[str] | None = None
    inputs: dict | None = None
    enabled: bool = True


def _flow_error(exc: StudioFlowError) -> HTTPException:
    return HTTPException(status_code=exc.status, detail=str(exc))


async def _enqueue_tick(session, row: StudioFlowRun, *, marker: str) -> None:
    """给已存在的运行再补一次 tick；入队失败要让用户当场看到，别静默停在挂起。"""
    try:
        queue = await get_queue()
        await queue.enqueue_job(
            "run_studio_flow",
            row.id,
            _job_id=flow_tick_job_id(row.id, marker=marker),
        )
    except Exception as exc:
        row.error = f"DAG 入队失败：{type(exc).__name__}: {exc}"
        row.heartbeat_at = datetime.now(UTC)
        await session.commit()
        raise HTTPException(status_code=503, detail=row.error) from exc


async def _enqueue_run(session, row: StudioFlowRun) -> None:
    try:
        queue = await get_queue()
        await queue.enqueue_job("run_studio_flow", row.id, _job_id=flow_tick_job_id(row.id))
    except Exception as exc:
        now = datetime.now(UTC)
        row.status = "failed"
        row.error = f"DAG 入队失败：{type(exc).__name__}: {exc}"
        row.finished_at = now
        row.heartbeat_at = now
        await session.commit()
        raise HTTPException(status_code=503, detail=row.error) from exc


@router.get("")
async def list_flows(session: SessionDep, enabled: bool | None = None) -> dict:
    stmt = select(StudioFlow)
    if enabled is not None:
        stmt = stmt.where(StudioFlow.enabled == enabled)
    rows = list((await session.execute(stmt.order_by(StudioFlow.updated_at.desc()))).scalars())
    return {"items": [flow_view(row) for row in rows]}


@router.post("", status_code=201)
async def post_flow(body: FlowCreateBody, session: SessionDep) -> dict:
    try:
        row = await create_flow(
            session,
            title=body.title,
            description=body.description,
            definition=body.definition,
        )
    except StudioFlowError as exc:
        raise _flow_error(exc) from exc
    return flow_view(row, detail=True)


@router.get("/runs")
async def list_flow_runs(
    session: SessionDep,
    flow_id: int | None = None,
    status: str | None = None,
    canvas_id: int | None = None,
    context_kind: str | None = None,
    limit: int = 50,
) -> dict:
    stmt = select(StudioFlowRun)
    if flow_id is not None:
        stmt = stmt.where(StudioFlowRun.flow_id == flow_id)
    if status is not None:
        stmt = stmt.where(StudioFlowRun.status == status)
    wanted = max(1, min(limit, 200))
    # JSON 路径查询在 SQLite/PostgreSQL 的语法不同。候选集上限 500，
    # 再在应用层过滤，保持本机与生产数据库同一份行为。
    candidate_limit = 500 if canvas_id is not None or context_kind is not None else wanted
    stmt = stmt.order_by(StudioFlowRun.created_at.desc()).limit(candidate_limit)
    rows = list((await session.execute(stmt)).scalars())
    if canvas_id is not None:
        rows = [row for row in rows if (row.source_context or {}).get("canvas_id") == canvas_id]
    if context_kind is not None:
        rows = [row for row in rows if (row.source_context or {}).get("kind") == context_kind]
    rows = rows[:wanted]
    return {"items": [flow_run_view(row) for row in rows]}


@router.post("/runs", status_code=202)
async def run_inline_flow(body: InlineFlowRunBody, session: SessionDep) -> dict:
    try:
        row = new_inline_flow_run(
            body.definition,
            inputs=body.inputs,
            source_context=body.source_context,
        )
    except StudioFlowError as exc:
        raise _flow_error(exc) from exc
    session.add(row)
    await session.commit()
    await _enqueue_run(session, row)
    await session.refresh(row)
    return flow_run_view(row)


@router.get("/runs/{run_id}")
async def get_flow_run(run_id: str, session: SessionDep) -> dict:
    row = await session.get(StudioFlowRun, run_id)
    if row is None:
        raise HTTPException(status_code=404, detail="DAG 运行不存在")
    return flow_run_view(row)


@router.post("/runs/{run_id}/retry", status_code=202)
async def retry_run(run_id: str, session: SessionDep) -> dict:
    original = await session.get(StudioFlowRun, run_id)
    if original is None:
        raise HTTPException(status_code=404, detail="DAG 运行不存在")
    if original.status not in {"failed", "partial", "cancelled"}:
        raise HTTPException(status_code=409, detail="只能重试已结束且未完全成功的 DAG")
    try:
        row = retry_flow_run(original)
    except StudioFlowError as exc:
        raise _flow_error(exc) from exc
    session.add(row)
    await session.commit()
    await _enqueue_run(session, row)
    await session.refresh(row)
    return flow_run_view(row)


@router.post("/runs/{run_id}/resume", status_code=202)
async def resume_run(
    run_id: str,
    session: SessionDep,
    body: FlowResumeBody | None = None,
) -> dict:
    original = await session.get(StudioFlowRun, run_id)
    if original is None:
        raise HTTPException(status_code=404, detail="DAG 运行不存在")
    if body is not None and body.node_id:
        if original.status not in FLOW_CANCELLABLE_STATUSES:
            raise HTTPException(status_code=409, detail="DAG 运行已结束，不能填人工输入")
        try:
            await resume_flow_input(
                session,
                original,
                node_id=body.node_id,
                resume_value=body.resume_value,
            )
        except StudioFlowError as exc:
            raise _flow_error(exc) from exc
        await _enqueue_tick(session, original, marker=f"resume:{body.node_id}")
        await session.refresh(original)
        return flow_run_view(original)
    if original.status not in {"failed", "partial", "cancelled"}:
        raise HTTPException(status_code=409, detail="只能继续已结束且未完全成功的 DAG")
    try:
        row = resume_flow_run(original)
    except StudioFlowError as exc:
        raise _flow_error(exc) from exc
    session.add(row)
    await session.commit()
    await _enqueue_run(session, row)
    await session.refresh(row)
    return flow_run_view(row)


@router.get("/runs/{run_id}/interrupts")
async def list_run_interrupts(run_id: str, session: SessionDep, status: str = "waiting") -> dict:
    row = await session.get(StudioFlowRun, run_id)
    if row is None:
        raise HTTPException(status_code=404, detail="DAG 运行不存在")
    rows = await list_flow_interrupts(session, run_id, status=status or None)
    return {"items": [interrupt_view(item) for item in rows]}


@router.post("/runs/{run_id}/promote", status_code=201)
async def promote_run(run_id: str, body: FlowPromoteBody, session: SessionDep) -> dict:
    """把一次跑通的运行快照固化成可复用的工作流模板。"""
    row = await session.get(StudioFlowRun, run_id)
    if row is None:
        raise HTTPException(status_code=404, detail="DAG 运行不存在")
    try:
        flow = await promote_run_to_flow(
            session,
            row,
            title=body.title,
            description=body.description,
        )
    except StudioFlowError as exc:
        raise _flow_error(exc) from exc
    return flow_view(flow, detail=True)


async def _cancel_child_tasks(session, run: StudioFlowRun) -> list[str]:
    """级联取消 checkpoint 里仍活跃的子任务；没有活跃子任务时不碰 Redis。"""
    nodes = (run.checkpoint or {}).get("nodes") or {}
    task_ids = [
        str(state["task_id"])
        for state in nodes.values()
        if isinstance(state, dict) and state.get("task_id")
    ]
    if not task_ids:
        return []
    rows = list(
        (
            await session.execute(
                select(StudioTask).where(
                    StudioTask.id.in_(task_ids),
                    StudioTask.status.in_(tuple(ACTIVE_STATUSES)),
                )
            )
        ).scalars()
    )
    if not rows:
        return []
    redis = await get_queue()
    for task in rows:
        await request_cancel(session, redis, task)
    return [task.id for task in rows]


@router.post("/runs/{run_id}/cancel")
async def cancel_run(run_id: str, session: SessionDep) -> dict:
    row = await session.get(StudioFlowRun, run_id)
    if row is None:
        raise HTTPException(status_code=404, detail="DAG 运行不存在")
    if row.status not in FLOW_CANCELLABLE_STATUSES:
        raise HTTPException(status_code=409, detail="DAG 运行已结束")
    now = datetime.now(UTC)
    row.status = "cancelled"
    row.error = "用户取消了 DAG 运行；仍在执行的子任务已一并请求取消"
    row.heartbeat_at = now
    row.finished_at = now
    await session.commit()
    await _cancel_child_tasks(session, row)
    # PostgreSQL 服务器维护的 updated_at 在 commit 后会过期；必须在
    # async session 中显式刷新，否则序列化时会触发同步懒加载。
    await session.refresh(row)
    return flow_run_view(row)


@router.get("/{flow_id}")
async def get_flow(flow_id: int, session: SessionDep) -> dict:
    row = await session.get(StudioFlow, flow_id)
    if row is None:
        raise HTTPException(status_code=404, detail="DAG 定义不存在")
    return flow_view(row, detail=True)


@router.put("/{flow_id}")
async def put_flow(flow_id: int, body: FlowUpdateBody, session: SessionDep) -> dict:
    row = await session.get(StudioFlow, flow_id)
    if row is None:
        raise HTTPException(status_code=404, detail="DAG 定义不存在")
    try:
        row = await update_flow(
            session,
            row,
            base_version=body.base_version,
            title=body.title,
            description=body.description,
            definition=body.definition,
            enabled=body.enabled,
        )
    except StudioFlowError as exc:
        raise _flow_error(exc) from exc
    return flow_view(row, detail=True)


@router.delete("/{flow_id}")
async def delete_flow(flow_id: int, session: SessionDep) -> dict:
    row = await session.get(StudioFlow, flow_id)
    if row is None:
        raise HTTPException(status_code=404, detail="DAG 定义不存在")
    await session.delete(row)
    await session.commit()
    return {"ok": True}


@router.get("/{flow_id}/schema")
async def get_flow_schema(flow_id: int, session: SessionDep) -> dict:
    row = await session.get(StudioFlow, flow_id)
    if row is None:
        raise HTTPException(status_code=404, detail="DAG 定义不存在")
    return flow_schema_view(row)


@router.get("/{flow_id}/triggers")
async def get_flow_triggers(flow_id: int, session: SessionDep) -> dict:
    flow = await session.get(StudioFlow, flow_id)
    if flow is None:
        raise HTTPException(status_code=404, detail="DAG 定义不存在")
    rows = await list_triggers(session, flow_id)
    return {"items": [trigger_view(row) for row in rows]}


@router.post("/{flow_id}/triggers", status_code=201)
async def post_flow_trigger(flow_id: int, body: FlowTriggerBody, session: SessionDep) -> dict:
    try:
        row = await create_trigger(
            session,
            flow_id=flow_id,
            kind=body.kind,
            cron=body.cron,
            task_type=body.task_type,
            statuses=body.statuses,
            inputs=body.inputs,
            enabled=body.enabled,
        )
    except StudioFlowError as exc:
        raise _flow_error(exc) from exc
    return trigger_view(row)


@router.delete("/{flow_id}/triggers/{trigger_id}")
async def delete_flow_trigger(flow_id: int, trigger_id: int, session: SessionDep) -> dict:
    try:
        await delete_trigger(session, flow_id=flow_id, trigger_id=trigger_id)
    except StudioFlowError as exc:
        raise _flow_error(exc) from exc
    return {"ok": True}


@router.post("/{flow_id}/runs", status_code=202)
async def run_flow(flow_id: int, body: FlowRunBody, session: SessionDep) -> dict:
    flow = await session.get(StudioFlow, flow_id)
    if flow is None:
        raise HTTPException(status_code=404, detail="DAG 定义不存在")
    if not flow.enabled:
        raise HTTPException(status_code=409, detail="DAG 已停用")
    try:
        validate_flow_inputs(flow.input_schema, body.inputs)
        row = new_flow_run(
            flow,
            inputs=body.inputs,
            source_context=body.source_context,
        )
    except StudioFlowError as exc:
        raise _flow_error(exc) from exc
    session.add(row)
    await session.commit()
    await _enqueue_run(session, row)
    await session.refresh(row)
    return flow_run_view(row)
