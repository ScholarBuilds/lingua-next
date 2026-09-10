"""管线可观测性与节点级重跑（需求 09 v6 FR-64~80，选型见 ADR-008）。

对外形状对齐 Dagster 的 Run/Step：一次运行是一条 run，节点是其下的 step，
重跑产生新 run 并以 parent_run_id 指向原 run，历次可对比。
"""

import asyncio
import json
import uuid
from collections.abc import AsyncGenerator
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select

from app.queue import get_queue
from app.routers.dict import SessionDep
from domain import artifacts, ratchet, subjects
from domain import pipeline as pipeline_def
from domain.models import (
    PipelineInterrupt,
    PipelineRun,
    PipelineStep,
    RepairMessage,
    RepairSession,
    StepArtifact,
    StudyUnit,
    SubtitleIssue,
    SubtitleSentence,
    SubtitleTrack,
    Video,
    Wordlist,
)
from domain.pipeline import (
    PIPELINE_VERSION,
    SCOPES,
    STEP_BY_NAME,
    catalog,
    resolve_scope,
)
from domain.pipeline_health import inspect

router = APIRouter(prefix="/pipeline", tags=["pipeline"])

# 未完成的视频状态：进度中心只关心这些
ACTIVE_STATUSES = ("pending", "downloading", "transcribing", "translating")
SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
# SSE 推送间隔：节点切换以秒计，1 秒足够跟手且不压库
STREAM_TICK_S = 1.0


def _run_view(run: PipelineRun) -> dict:
    """run 行 → 前端视图。

    `domain` / `subject_id` 必带：任务中心把管线 run 和工坊任务、工作流 run 合并成
    一个列表后，只给 video_id 的历史 run 在没有实时帧时判不出域，也拼不出
    `/pipeline/{domain}/{subject_id}` 的跳转地址。video_id 保留给视频域的老调用方。
    """
    return {
        "id": run.id,
        "domain": run.domain,
        "subject_id": run.subject_id,
        "video_id": run.video_id,
        "kind": run.kind,
        "trigger": run.trigger,
        "status": run.status,
        "from_step": run.from_step,
        "scope": run.scope,
        "config_override": run.config_override or {},
        "code_version": run.code_version,
        "parent_run_id": run.parent_run_id,
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "finished_at": run.finished_at.isoformat() if run.finished_at else None,
        "error": run.error,
    }


def _step_view(step: PipelineStep, domain: str = "video") -> dict:
    """节点行 → 前端视图。

    spec 必须按域取：`STEP_BY_NAME` 是**视频**管线的映射，拿它去查场景本或生图的
    节点一律 miss，label 退化成 `cover` 这种内部名、depends_on 变空数组。
    首版漏了 domain 形参，非视频域一直在吃这个哑巴亏。
    """
    spec = pipeline_def.get_pipeline(domain).by_name.get(step.name)
    return {
        "id": step.id,
        "name": step.name,
        "label": spec.label if spec else step.name,
        "group": spec.group if spec else "ingest",
        "depends_on": list(spec.depends_on) if spec else [],
        "ordinal": step.ordinal,
        "status": step.status,
        "attempt": step.attempt,
        "started_at": step.started_at.isoformat() if step.started_at else None,
        "finished_at": step.finished_at.isoformat() if step.finished_at else None,
        "duration_ms": step.duration_ms,
        "error": step.error,
        "error_kind": step.error_kind,
        "metrics": step.metrics or {},
        "config": step.config or {},
        "logs": step.logs,
        "code_version": step.code_version,
        # 陈旧标记（FR-66）：抄 Dagster asset code_version staleness
        "stale": bool(step.code_version and step.code_version != PIPELINE_VERSION),
    }


@router.get("/pipelines")
async def pipelines() -> list[dict]:
    """已注册的全部管线定义：管线中心按域分区的数据源（FR-214）。"""
    return pipeline_def.pipeline_catalog()


def _pipeline_view(definition) -> dict:
    """域的 UI 声明（FR-235~239）：前端据此渲染列、健康档、动作与筛选器。"""
    return {
        "domain": definition.domain,
        "label": definition.label,
        "subject_table": definition.subject_table,
        "steps": len(definition.steps),
        "version": definition.version,
        "detail_route": definition.detail_route,
        "empty_hint": definition.empty_hint,
        "columns": [
            {
                "key": c.key, "label": c.label, "kind": c.kind,
                "align": c.align, "width": c.width,
            }
            for c in definition.columns
        ],
        "health": [
            {"key": h.key, "label": h.label, "tone": h.tone, "actionable": h.actionable}
            for h in definition.health
        ],
        "actions": [
            {
                "key": a.key, "label": a.label, "tone": a.tone,
                "confirm": a.confirm, "preview": a.preview,
            }
            for a in definition.actions
        ],
        "run_kinds": [{"key": k, "label": v} for k, v in definition.run_kinds],
        "help": [
            {"title": h.title, "body": h.body, "bullets": list(h.bullets)}
            for h in definition.help
        ],
    }


async def _subject_titles(session, runs) -> dict[tuple[str, int], str]:
    """(域, 主体 id) → 展示标题。按域分批查，避免每条 run 一次查询。"""
    out: dict[tuple[str, int], str] = {}
    video_ids = [r.subject_id for r in runs if r.domain == "video"]
    deck_ids = [r.subject_id for r in runs if r.domain == "scenario_deck"]
    if video_ids:
        for vid, title, title_zh in (
            await session.execute(
                select(Video.id, Video.title, Video.title_zh).where(Video.id.in_(video_ids))
            )
        ).all():
            out[("video", vid)] = title_zh or title or f"视频 {vid}"
    if deck_ids:
        for wid, name, emoji in (
            await session.execute(
                select(Wordlist.id, Wordlist.name, Wordlist.emoji).where(Wordlist.id.in_(deck_ids))
            )
        ).all():
            out[("scenario_deck", wid)] = f"{emoji or '📘'} {name}"
    return out


@router.get("/domains")
async def domain_overview(session: SessionDep) -> list[dict]:
    """跨域总览（FR-214）：UI 声明 + 主体健康分布 + 最近活动。"""
    out = []
    for definition in pipeline_def.PIPELINES.values():
        rows = await subjects.subject_rows(session, definition.domain, limit=0)
        latest = (
            await session.execute(
                select(PipelineRun)
                .where(PipelineRun.domain == definition.domain)
                .order_by(PipelineRun.id.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        counts = rows["health_counts"]
        actionable = sum(
            counts.get(h.key, 0) for h in definition.health if h.actionable
        )
        issues = 0
        if definition.domain == "video":
            issues = (
                await session.execute(
                    select(func.count())
                    .select_from(SubtitleIssue)
                    .where(SubtitleIssue.state == "open")
                )
            ).scalar_one()
        # 先落成局部变量再取 isoformat，三元里连着写类型收窄不了
        last_at = (latest.finished_at or latest.started_at) if latest else None
        out.append(
            {
                **_pipeline_view(definition),
                "subjects": rows["total"],
                "health_counts": counts,
                "actionable": actionable,
                "issues": int(issues),
                "last_run": (
                    {
                        "id": latest.id,
                        "status": latest.status,
                        "at": last_at.isoformat() if last_at else None,
                    }
                    if latest
                    else None
                ),
            }
        )
    return out


@router.get("/subjects/{domain}")
async def domain_subjects(
    domain: str,
    session: SessionDep,
    health: str = "",
    q: str = "",
    offset: int = 0,
    limit: int = 50,
) -> dict:
    """某个域的主体列表（FR-240）：行的字段与该域 columns 声明一一对应。"""
    if domain not in pipeline_def.PIPELINES:
        raise HTTPException(status_code=404, detail=f"未知管线域 {domain}")
    payload = await subjects.subject_rows(
        session, domain, health=health, q=q, offset=offset, limit=min(max(limit, 1), 200)
    )
    return {**payload, "spec": _pipeline_view(pipeline_def.PIPELINES[domain])}


@router.get("/todo")
async def global_todo(session: SessionDep) -> dict:
    """全局待办（FR-241）：跨域聚合"需要你处理的事"，点任一项直达域内筛选结果。

    只收 actionable 的健康档与未处理问题——把"处理中"也算进待办会让这条永远不空。
    """
    items: list[dict] = []
    for definition in pipeline_def.PIPELINES.values():
        rows = await subjects.subject_rows(session, definition.domain, limit=0)
        for bucket in definition.health:
            if not bucket.actionable:
                continue
            n = rows["health_counts"].get(bucket.key, 0)
            if n > 0:
                items.append(
                    {
                        "domain": definition.domain,
                        "domain_label": definition.label,
                        "kind": "health",
                        "key": bucket.key,
                        "label": f"{definition.label} {bucket.label}",
                        "count": n,
                        "tone": bucket.tone,
                    }
                )
    open_issues = (
        await session.execute(
            select(func.count()).select_from(SubtitleIssue).where(SubtitleIssue.state == "open")
        )
    ).scalar_one()
    if open_issues:
        items.append(
            {
                "domain": "video",
                "domain_label": "视频学习",
                "kind": "issues",
                "key": "open_issues",
                "label": "字幕问题待修",
                "count": int(open_issues),
                "tone": "warn",
            }
        )
    waiting = (
        await session.execute(
            select(func.count())
            .select_from(PipelineInterrupt)
            .where(PipelineInterrupt.status == "waiting")
        )
    ).scalar_one()
    items.sort(key=lambda i: -i["count"])
    return {"total": sum(i["count"] for i in items), "waiting": int(waiting), "items": items}


@router.get("/matrix/{domain}")
async def run_matrix(domain: str, session: SessionDep, limit: int = 12) -> dict:
    """运行矩阵（FR-215）：行=节点，列=最近 N 次运行，一眼看出哪个节点反复失败。

    形态取自 Airflow Grid View，这是当前完全缺失的一层。
    """
    if domain not in pipeline_def.PIPELINES:
        raise HTTPException(status_code=404, detail=f"未知管线域 {domain}")
    limit = min(max(limit, 1), 40)
    runs = (
        (
            await session.execute(
                select(PipelineRun)
                .where(PipelineRun.domain == domain)
                .order_by(PipelineRun.id.desc())
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    run_ids = [r.id for r in runs]
    cells: dict[str, dict[str, dict]] = {}
    if run_ids:
        rows = (
            (
                await session.execute(
                    select(PipelineStep).where(PipelineStep.run_id.in_(run_ids))
                )
            )
            .scalars()
            .all()
        )
        for row in rows:
            cells.setdefault(row.name, {})[str(row.run_id)] = {
                "status": row.status,
                "duration_ms": row.duration_ms,
                "error": (row.error or "")[:120] or None,
            }

    definition = pipeline_def.get_pipeline(domain)
    # 失败次数排序供 UI 高亮"最不稳的节点"
    failures = {
        name: sum(1 for c in per_run.values() if c["status"] == "failed")
        for name, per_run in cells.items()
    }
    return {
        "domain": domain,
        "label": definition.label,
        "runs": [
            {
                "id": r.id,
                "subject_id": r.subject_id,
                "kind": r.kind,
                "status": r.status,
                "started_at": r.started_at.isoformat() if r.started_at else None,
            }
            for r in reversed(runs)
        ],
        "steps": [
            {
                "name": spec.name,
                "label": spec.label,
                "group": spec.group,
                "failures": failures.get(spec.name, 0),
            }
            for spec in definition.steps
        ],
        "cells": cells,
    }


@router.get("/subjects/{domain}/{subject_id}")
async def subject_pipeline(
    domain: str, subject_id: int, session: SessionDep, run_id: int | None = None
) -> dict:
    """任意域的单主体全链路（FR-190）：与 /videos/{id} 同构，供拓扑图复用同一套渲染。"""
    if domain not in pipeline_def.PIPELINES:
        raise HTTPException(status_code=404, detail=f"未知管线域 {domain}")
    runs = (
        (
            await session.execute(
                select(PipelineRun)
                .where(PipelineRun.domain == domain, PipelineRun.subject_id == subject_id)
                .order_by(PipelineRun.id.desc())
                .limit(20)
            )
        )
        .scalars()
        .all()
    )
    current = next((r for r in runs if r.id == run_id), None) or (runs[0] if runs else None)
    steps: list[dict] = []
    if current is not None:
        rows = (
            (
                await session.execute(
                    select(PipelineStep)
                    .where(PipelineStep.run_id == current.id)
                    .order_by(PipelineStep.ordinal)
                )
            )
            .scalars()
            .all()
        )
        steps = [_step_view(row, domain) for row in rows]

    art_rows = (
        (
            await session.execute(
                select(StepArtifact).where(
                    StepArtifact.domain == domain,
                    StepArtifact.subject_id == subject_id,
                    StepArtifact.is_current.is_(True),
                )
            )
        )
        .scalars()
        .all()
    )
    waiting = (
        (
            await session.execute(
                select(PipelineInterrupt)
                .join(PipelineRun, PipelineRun.id == PipelineInterrupt.run_id)
                .where(
                    PipelineRun.domain == domain,
                    PipelineRun.subject_id == subject_id,
                    PipelineInterrupt.status == "waiting",
                )
            )
        )
        .scalars()
        .all()
    )
    spec = pipeline_def.get_pipeline(domain)
    stale = await artifacts.stale_steps(session, domain, subject_id, spec.steps)
    return {
        "domain": domain,
        "label": spec.label,
        "subject_id": subject_id,
        "spec": pipeline_def.catalog(domain),
        "steps": steps,
        "stale": sorted(stale),
        "artifacts": [
            {
                "step": a.step,
                "summary": a.summary,
                "bytes": a.bytes,
                "sha": a.content_sha256[:12],
                "human_edited": a.human_edited,
                "created_at": a.created_at.isoformat() if a.created_at else None,
            }
            for a in art_rows
        ],
        "interrupts": [
            {"id": i.id, "run_id": i.run_id, "step": i.step, "kind": i.kind, "payload": i.payload}
            for i in waiting
        ],
        "runs": [
            {
                "id": r.id,
                "kind": r.kind,
                "status": r.status,
                "trigger": r.trigger,
                "started_at": r.started_at.isoformat() if r.started_at else None,
                "finished_at": r.finished_at.isoformat() if r.finished_at else None,
                "error": r.error,
            }
            for r in runs
        ],
        "current_run_id": current.id if current else None,
    }


@router.get("/subjects/{domain}/{subject_id}/artifact/{step}")
async def subject_artifact(domain: str, subject_id: int, step: str, session: SessionDep) -> dict:
    """节点产物详情（FR-198）：节点抽屉的「产物」页签数据源。"""
    row = await artifacts.current(session, domain, subject_id, step)
    if row is None:
        raise HTTPException(status_code=404, detail="该节点尚无产物")
    return {
        "step": row.step,
        "payload": row.payload,
        "blob_key": row.blob_key,
        "bytes": row.bytes,
        "summary": row.summary,
        "sha": row.content_sha256,
        "input_fingerprint": row.input_fingerprint,
        "human_edited": row.human_edited,
        "code_version": row.code_version,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


@router.get("/catalog")
async def step_catalog(domain: str = "video") -> dict:
    """节点目录：前端画 DAG 与渲染重跑表单的唯一事实源。"""
    return {"version": PIPELINE_VERSION, "steps": catalog(), "scopes": list(SCOPES)}


async def _active_payload(session) -> dict:
    """进度中心一帧：活跃 run + 需要关注的视频（FR-67/69）。

    活跃判定以 **run 状态**为准，不看视频状态——从中段节点重跑（修复/重切/重翻）时
    视频状态可能一直是 ready，按视频状态算会把这类 run 漏成隐形（实测踩过）。
    """
    running_runs = (
        (
            await session.execute(
                select(PipelineRun)
                .where(PipelineRun.status == "running")
                .order_by(PipelineRun.id.desc())
                .limit(30)
            )
        )
        .scalars()
        .all()
    )
    # 需要关注但没有活跃 run 的视频：排队中 / 失败 / 产出不达标
    attention = (
        (
            await session.execute(
                select(Video)
                .where(Video.status.in_((*ACTIVE_STATUSES, "failed", "degraded")))
                .order_by(Video.id.desc())
                .limit(30)
            )
        )
        .scalars()
        .all()
    )
    run_by_video: dict[int, int] = {}
    for run in running_runs:  # 同视频多 run 时取最新（列表已按 id 降序）
        run_by_video.setdefault(run.video_id, run.id)

    video_ids = list({*run_by_video.keys(), *(v.id for v in attention)})
    if not video_ids:
        return {"items": [], "active": 0}
    videos = (
        (await session.execute(select(Video).where(Video.id.in_(video_ids))))
        .scalars()
        .all()
    )
    videos.sort(key=lambda v: (v.id not in run_by_video, -v.id))
    steps_by_run: dict[int, list[PipelineStep]] = {}
    if run_by_video:
        all_steps = (
            (
                await session.execute(
                    select(PipelineStep)
                    .where(PipelineStep.run_id.in_(list(run_by_video.values())))
                    .order_by(PipelineStep.ordinal)
                )
            )
            .scalars()
            .all()
        )
        for step in all_steps:
            steps_by_run.setdefault(step.run_id, []).append(step)

    items = []
    for video in videos:
        run_id = run_by_video.get(video.id)
        steps = steps_by_run.get(run_id or -1, [])
        running = next((s for s in steps if s.status == "running"), None)
        failed = [s.name for s in steps if s.status == "failed"]
        # 有活跃 run 的视频即使状态是 ready（中段重跑）也显示为处理中
        shown_status = "processing" if run_id is not None else video.status
        items.append({
            "video_id": video.id,
            "domain": "video",
            "title": video.title,
            "status": shown_status,
            # 真正在跑 vs 只是需要关注（失败/不达标）：两者混在一个列表里，
            # 浮层会把"3 个不达标"说成"3 个执行中"（实测误导）
            "live": run_id is not None or video.status in ACTIVE_STATUSES,
            "progress": video.progress,
            "error": video.error,
            "error_kind": video.error_kind,
            "run_id": run_id,
            "current_step": running.name if running else None,
            "current_label": (
                (STEP_BY_NAME[running.name].label if running.name in STEP_BY_NAME else running.name)
                if running
                else None
            ),
            "failed_steps": failed,
            "done_steps": sum(1 for s in steps if s.status in ("success", "skipped")),
            "total_steps": len(steps),
        })
    # 非视频域的活跃 run 也要进来：浮层要覆盖所有管线，
    # 否则生成场景本时切走页面就"失联"（FR-245）
    others = (
        (
            await session.execute(
                select(PipelineRun)
                .where(
                    PipelineRun.domain != "video",
                    PipelineRun.status.in_(("running", "pending")),
                )
                .order_by(PipelineRun.id.desc())
                .limit(20)
            )
        )
        .scalars()
        .all()
    )
    if others:
        titles = await _subject_titles(session, others)
        other_steps = (
            (
                await session.execute(
                    select(PipelineStep).where(
                        PipelineStep.run_id.in_([r.id for r in others])
                    )
                )
            )
            .scalars()
            .all()
        )
        by_run: dict[int, list] = {}
        for row in other_steps:
            by_run.setdefault(row.run_id, []).append(row)
        for run in others:
            steps = by_run.get(run.id, [])
            spec = pipeline_def.get_pipeline(run.domain)
            done = sum(1 for st in steps if st.status in ("success", "skipped"))
            running = next((st for st in steps if st.status == "running"), None)
            label = (
                spec.by_name[running.name].label
                if running and running.name in spec.by_name
                else None
            )
            items.append({
                "video_id": run.subject_id,
                "domain": run.domain,
                "title": titles.get((run.domain, run.subject_id)) or f"#{run.subject_id}",
                "status": "processing",
                "live": True,
                "progress": round(done / max(len(spec.steps), 1) * 100),
                "error": None,
                "error_kind": None,
                "run_id": run.id,
                "current_step": running.name if running else None,
                "current_label": label,
                "failed_steps": [st.name for st in steps if st.status == "failed"],
                "done_steps": done,
                "total_steps": len(spec.steps),
            })
    return {"items": items, "active": len(run_by_video) + len(others)}


@router.get("/active")
async def active_runs(session: SessionDep) -> dict:
    """进度中心一次性拉取（SSE 不可用时的兜底）。"""
    return await _active_payload(session)


@router.get("/stream")
async def stream_active(request: Request) -> StreamingResponse:
    """进度中心 SSE 推送（FR-68）：替掉 3 秒轮询，空闲时零请求。

    只在内容变化时下发。每轮显式检查客户端是否已断开——不检查的话，浏览器关了页
    生成器仍会每秒查一次库，攒几个僵尸连接就是持续的无用负载。
    """
    from app.db import SessionFactory

    async def gen() -> AsyncGenerator[str, None]:
        last = ""
        while not await request.is_disconnected():
            async with SessionFactory() as session:
                payload = await _active_payload(session)
            body = json.dumps(payload, ensure_ascii=False)
            if body != last:
                last = body
                yield f"data: {body}\n\n"
            else:
                yield ": keep-alive\n\n"
            await asyncio.sleep(STREAM_TICK_S)

    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)


@router.get("/runs")
async def list_runs(
    session: SessionDep,
    status: str | None = None,
    domain: str | None = None,
    video_id: int | None = None,
    subject_id: int | None = None,
    kind: str | None = None,
    trigger: str | None = None,
    since: str | None = None,
    until: str | None = None,
    offset: int = 0,
    limit: int = 20,
    run_ids: Annotated[list[int] | None, Query()] = None,
) -> dict:
    """运行记录列表（FR-82）：管线中心历史区的数据源，服务端分页与筛选。"""
    conds = []
    if run_ids is not None:
        conds.append(PipelineRun.id.in_(run_ids))
    if status:
        conds.append(PipelineRun.status == status)
    if domain:
        conds.append(PipelineRun.domain == domain)
    if video_id is not None:
        conds.append(PipelineRun.video_id == video_id)
    if subject_id is not None:
        conds.append(PipelineRun.subject_id == subject_id)
    if kind:
        conds.append(PipelineRun.kind == kind)
    if trigger:
        conds.append(PipelineRun.trigger == trigger)
    for raw, op in ((since, "ge"), (until, "le")):
        if raw:
            try:
                bound = datetime.fromisoformat(raw)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=f"时间格式不合法：{raw}") from exc
            conds.append(
                PipelineRun.created_at >= bound if op == "ge" else PipelineRun.created_at <= bound
            )

    total = (
        await session.execute(
            select(func.count()).select_from(PipelineRun).where(*conds)
        )
    ).scalar_one()
    runs = (
        (
            await session.execute(
                select(PipelineRun)
                .where(*conds)
                .order_by(PipelineRun.id.desc())
                .offset(max(0, offset))
                .limit(max(1, min(limit, 100)))
            )
        )
        .scalars()
        .all()
    )
    # 主体标题按域批量补：视频取 video 表，场景本取 wordlist 表
    titles = await _subject_titles(session, runs)
    rows = [(run, titles.get((run.domain, run.subject_id)), None) for run in runs]

    run_ids = [run.id for run, _t, _tz in rows]
    failed_by_run: dict[int, list[str]] = {}
    durations: dict[int, int] = {}
    if run_ids:
        steps = (
            await session.execute(
                select(
                    PipelineStep.run_id, PipelineStep.name,
                    PipelineStep.status, PipelineStep.duration_ms,
                ).where(PipelineStep.run_id.in_(run_ids))
            )
        ).all()
        for rid, name, st, dur in steps:
            if st == "failed":
                failed_by_run.setdefault(rid, []).append(name)
            if dur:
                durations[rid] = durations.get(rid, 0) + dur

    issue_counts = await _open_issue_counts(
        session, [run.video_id for run, _t, _tz in rows if run.video_id is not None]
    )

    return {
        "total": total,
        "items": [
            {
                **_run_view(run),
                "video_title": title_zh or title,
                "failed_steps": failed_by_run.get(run.id, []),
                "duration_ms": durations.get(run.id),
                # 非视频域 video_id 为空，直接当 0 条问题，不去查这张视频专属的表
                "open_issues": issue_counts.get(run.video_id, 0) if run.video_id else 0,
            }
            for run, title, title_zh in rows
        ],
    }


async def _open_issue_counts(session, video_ids: list[int]) -> dict[int, int]:
    """视频 → 未处理问题数（FR-138）。一次 group by，别在循环里查。"""
    if not video_ids:
        return {}
    rows = (
        await session.execute(
            select(SubtitleIssue.video_id, func.count())
            .where(SubtitleIssue.video_id.in_(video_ids), SubtitleIssue.state == "open")
            .group_by(SubtitleIssue.video_id)
        )
    ).all()
    return {vid: n for vid, n in rows}


@router.get("/overview")
async def videos_overview(session: SessionDep) -> list[dict]:
    """全量视频链路概览（FR-99）：库内所有视频一行一条，没跑过新管线的也列出。

    「跑过才配出现」是 v7 的盲区——旧产物恰恰是最需要被看见和重跑的。
    """
    videos = (
        (await session.execute(select(Video).order_by(Video.id.desc()))).scalars().all()
    )
    latest = (
        select(PipelineRun.video_id, func.max(PipelineRun.id).label("run_id"))
        .group_by(PipelineRun.video_id)
        .subquery()
    )
    run_rows = (
        await session.execute(
            select(PipelineRun).join(latest, latest.c.run_id == PipelineRun.id)
        )
    ).scalars()
    run_by_video = {r.video_id: r for r in run_rows}

    # 句数/译文/管线版本：一次聚合，避免 N+1
    tracks = (
        (
            await session.execute(
                select(SubtitleTrack).where(SubtitleTrack.kind.in_(("whisper", "official")))
            )
        )
        .scalars()
        .all()
    )
    track_by_video = {t.video_id: t for t in tracks}
    track_ids = [t.id for t in tracks]
    sent_stats: dict[int, tuple[int, int]] = {}
    if track_ids:
        rows = (
            await session.execute(
                select(
                    SubtitleSentence.track_id,
                    func.count(),
                    func.count(SubtitleSentence.text_zh),
                )
                .where(SubtitleSentence.track_id.in_(track_ids))
                .group_by(SubtitleSentence.track_id)
            )
        ).all()
        sent_stats = {tid: (total, zh) for tid, total, zh in rows}

    issue_counts = await _open_issue_counts(session, [v.id for v in videos])

    out = []
    for video in videos:
        run = run_by_video.get(video.id)
        track = track_by_video.get(video.id)
        produced = ((track.meta or {}).get("pipeline") or {}).get("version") if track else None
        total, zh = sent_stats.get(track.id, (0, 0)) if track else (0, 0)
        out.append({
            "video_id": video.id,
            "title": video.title_zh or video.title,
            "status": video.status,
            "sentences": total,
            "translated": zh,
            "pipeline_version": produced,
            "stale": produced != PIPELINE_VERSION,
            "last_run": _run_view(run) if run else None,
            "open_issues": issue_counts.get(video.id, 0),
        })
    return out


@router.get("/videos/{video_id}")
async def video_pipeline(session: SessionDep, video_id: int, run_id: int | None = None) -> dict:
    """单条视频的全链路：指定 run 或最新 run + 历次运行列表（FR-71/74）。"""
    video = await session.get(Video, video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="video not found")

    runs = (
        (
            await session.execute(
                select(PipelineRun)
                .where(PipelineRun.video_id == video_id)
                .order_by(PipelineRun.id.desc())
                .limit(20)
            )
        )
        .scalars()
        .all()
    )
    current = next((r for r in runs if r.id == run_id), None) or (runs[0] if runs else None)
    steps: list[dict] = []
    if current is not None:
        rows = (
            (
                await session.execute(
                    select(PipelineStep)
                    .where(PipelineStep.run_id == current.id)
                    .order_by(PipelineStep.ordinal)
                )
            )
            .scalars()
            .all()
        )
        steps = [_step_view(s, "video") for s in rows]

    # 各节点跨 run 的执行史（紧凑行）：驱动灰节点的「上次执行」、抽屉历史列表，
    # 以及执行中节点的耗时预估（FR-148）
    history: dict[str, list[dict]] = {}
    if runs:
        hist_rows = (
            (
                await session.execute(
                    select(PipelineStep)
                    .where(PipelineStep.run_id.in_([r.id for r in runs]))
                    .order_by(PipelineStep.run_id.desc(), PipelineStep.ordinal)
                )
            )
            .scalars()
            .all()
        )
        for row in hist_rows:
            history.setdefault(row.name, []).append({
                "run_id": row.run_id,
                "status": row.status,
                "duration_ms": row.duration_ms,
                "started_at": row.started_at.isoformat() if row.started_at else None,
                "stale": row.code_version != PIPELINE_VERSION if row.code_version else False,
            })

    health = await inspect(session, video_id)
    issues = (
        (
            await session.execute(
                select(SubtitleIssue)
                .where(SubtitleIssue.video_id == video_id)
                .order_by(SubtitleIssue.id)
            )
        )
        .scalars()
        .all()
    )
    return {
        "video": {
            "id": video.id, "title": video.title, "title_zh": video.title_zh,
            "status": video.status, "progress": video.progress,
            "error": video.error, "error_kind": video.error_kind,
            "duration_s": video.duration_s,
        },
        "run": _run_view(current) if current else None,
        "steps": steps,
        "runs": [_run_view(r) for r in runs],
        "health": health,
        "issues": [_issue_view(i) for i in issues],
        "history": history,
        # 节点耗时基线（FR-148）：历史成功执行的**中位数**——均值会被一次异常
        # 慢跑拖偏，中位数稳。样本量一并给出，让前端能说清"依据几次历史"
        "eta": {
            name: {
                "p50_ms": sorted(d)[len(d) // 2],
                "samples": len(d),
                "min_ms": min(d),
                "max_ms": max(d),
            }
            for name, rows in history.items()
            if (d := [r["duration_ms"] for r in rows
                      if r["status"] == "success" and r["duration_ms"]])
        },
        "catalog": catalog(),
        "version": PIPELINE_VERSION,
    }


def _issue_view(issue: SubtitleIssue) -> dict:
    return {
        "id": issue.id,
        "sentence_id": issue.sentence_id,
        "source": issue.source,
        "kind": issue.kind,
        "severity": issue.severity,
        "detail": issue.detail,
        "suggestion": issue.suggestion,
        "state": issue.state,
        "action": issue.action,
        "anchor": issue.anchor,
    }


class RerunBody(BaseModel):
    video_id: int
    from_step: str | None = None
    scope: str = "downstream"
    config: dict = Field(default_factory=dict)
    # 覆盖人工修改：默认关闭，勾选后自动结果才会盖过人工版本（FR-206、BR-36）
    override_manual: bool = False


@router.post("/rerun", status_code=202)
async def rerun(body: RerunBody, session: SessionDep) -> dict:
    """从指定节点按指定范围重跑，可带配置覆盖（FR-75/76）。"""
    video = await session.get(Video, body.video_id)
    if video is None:
        raise HTTPException(status_code=404, detail="video not found")
    if body.scope not in SCOPES:
        raise HTTPException(status_code=400, detail=f"scope 仅支持 {'/'.join(SCOPES)}")
    if body.from_step is not None and body.from_step not in STEP_BY_NAME:
        raise HTTPException(status_code=400, detail=f"未知节点：{body.from_step}")
    if body.scope != "failed" and body.from_step is None:
        raise HTTPException(status_code=400, detail="需要指定起点节点")
    # FR-203：视频节点已接产物层，single 重跑只重算本步产物，下游按内容指纹自行判定
    # 是否陈旧，不再需要确认门。人工修改另有 ratchet 保护（BR-36）。

    parent = (
        await session.execute(
            select(PipelineRun.id)
            .where(PipelineRun.video_id == body.video_id)
            .order_by(PipelineRun.id.desc())
            .limit(1)
        )
    ).scalar_one_or_none()

    queue = await get_queue()
    await queue.enqueue_job(
        "run_pipeline", body.video_id, body.from_step, body.scope,
        body.config or None, "retry", parent,
        _job_id=f"rerun:{body.video_id}:{uuid.uuid4().hex[:6]}",
    )
    planned = (
        resolve_scope(body.from_step or "", body.scope, [])
        if body.from_step
        else ["（按上次失败节点解析）"]
    )
    return {"queued": True, "video_id": body.video_id, "steps": planned}


@router.post("/verify/{video_id}", status_code=202)
async def verify(video_id: int, session: SessionDep, ai_review: bool = True) -> dict:
    """只重跑体检与 AI 校验节点（FR-77/80），不动任何产物。"""
    if await session.get(Video, video_id) is None:
        raise HTTPException(status_code=404, detail="video not found")
    queue = await get_queue()
    await queue.enqueue_job(
        "run_pipeline", video_id, "verify", "single",
        {"verify": {"ai_review": ai_review}}, "retry", None,
        _job_id=f"verify:{video_id}:{uuid.uuid4().hex[:6]}",
    )
    return {"queued": True, "video_id": video_id}


async def _autofix_video(session, video_id: int, queue) -> dict:
    """一条视频的自动修复（v10.7 FR-144 / v10.8 FR-146）。

    两段式：先用确定性分派把能自动执行的落地（不烧 token、不等模型），
    剩下 action=manual 的打包成一份清单交给代理——一个会话处理全部，
    不是一条一个对话。被单视频端点与全库批量端点共用，避免两套逻辑漂移。
    """
    from domain.sentence_ops import apply_issue_action, resolve_action

    issues = (
        (
            await session.execute(
                select(SubtitleIssue).where(
                    SubtitleIssue.video_id == video_id, SubtitleIssue.state == "open"
                )
            )
        )
        .scalars()
        .all()
    )

    auto_done = 0
    auto_failed = 0
    needs_zh = False
    track_id: int | None = None
    manual: list[SubtitleIssue] = []

    for issue in issues:
        action = resolve_action(issue.kind, issue.action, issue.suggestion)
        if issue.sentence_id is None or action == "manual":
            manual.append(issue)
            continue
        row = await session.get(SubtitleSentence, issue.sentence_id)
        if row is None:
            manual.append(issue)
            continue
        track_id = row.track_id
        try:
            out = await apply_issue_action(
                session, issue.sentence_id, action, issue.suggestion, issue.anchor
            )
        except ValueError:
            auto_failed += 1
            manual.append(issue)
            continue
        if out["applied"]:
            issue.state = "accepted"
            auto_done += 1
            needs_zh = needs_zh or bool(out["needs_zh"])
        else:
            manual.append(issue)

    if needs_zh and track_id is not None:
        track = await session.get(SubtitleTrack, track_id)
        if track is not None:
            meta = dict(track.meta or {})
            meta["zh_refill_at"] = datetime.now(UTC).isoformat()
            track.meta = meta
    await session.commit()

    if needs_zh and track_id is not None:
        await queue.enqueue_job(
            "translate_track", track_id, _job_id=f"zhfill:{track_id}:{uuid.uuid4().hex[:6]}"
        )

    session_id: int | None = None
    if manual:
        lines = [
            f"这条视频还有 {len(manual)} 个问题没能自动修复，逐条核实并处理，"
            "能修的修、修不了的说明原因，最后跑一次体检汇报前后对比：",
            "",
        ]
        for issue in manual[:40]:
            loc = f"句 #{issue.sentence_id}" if issue.sentence_id else "整体"
            line = f"- [{issue.kind}] {loc}：{issue.detail}"
            if issue.suggestion:
                line += f"（原建议：{issue.suggestion[:80]}）"
            lines.append(line)
        agent_session = RepairSession(
            video_id=video_id, step_name="verify", status="running",
        )
        session.add(agent_session)
        await session.commit()
        session.add(
            RepairMessage(
                session_id=agent_session.id, role="user", content="\n".join(lines)
            )
        )
        await session.commit()
        session_id = agent_session.id
        await queue.enqueue_job(
            "repair_agent_turn", session_id,
            _job_id=f"autofix:{video_id}:{uuid.uuid4().hex[:6]}",
        )

    return {
        "video_id": video_id,
        "total": len(issues),
        "auto_applied": auto_done,
        "auto_failed": auto_failed,
        "handed_to_agent": len(manual),
        "session_id": session_id,
        "queued_translate": needs_zh,
    }


@router.post("/videos/{video_id}/autofix", status_code=202)
async def autofix(video_id: int, session: SessionDep) -> dict:
    """把该视频所有未处理问题一次性修掉（FR-144）。"""
    if await session.get(Video, video_id) is None:
        raise HTTPException(status_code=404, detail="video not found")
    return await _autofix_video(session, video_id, await get_queue())


@router.get("/autofix-all/preview")
async def autofix_all_preview(session: SessionDep) -> dict:
    """全库批量修复的预演（FR-146）：点下去会动多少数据，先说清楚再动手。

    批量写回字幕是不可撤销的，且会给每条有 manual 问题的视频各开一个代理会话
    （要烧 token）。让用户看到确切数字再决定，而不是点完才知道。
    """
    from domain.sentence_ops import resolve_action

    rows = (
        (
            await session.execute(
                select(SubtitleIssue, Video.title, Video.title_zh)
                .join(Video, Video.id == SubtitleIssue.video_id)
                .where(SubtitleIssue.state == "open")
                .order_by(SubtitleIssue.video_id)
            )
        )
        .all()
    )
    by_video: dict[int, dict] = {}
    for issue, title, title_zh in rows:
        entry = by_video.setdefault(
            issue.video_id,
            {"video_id": issue.video_id, "title": title_zh or title, "auto": 0, "agent": 0},
        )
        action = resolve_action(issue.kind, issue.action, issue.suggestion)
        if issue.sentence_id is not None and action != "manual":
            entry["auto"] += 1
        else:
            entry["agent"] += 1
    items = sorted(by_video.values(), key=lambda v: -(v["auto"] + v["agent"]))
    return {
        "videos": len(items),
        "issues": sum(v["auto"] + v["agent"] for v in items),
        "auto_applicable": sum(v["auto"] for v in items),
        "agent_sessions": sum(1 for v in items if v["agent"] > 0),
        "items": items,
    }


@router.post("/autofix-all", status_code=202)
async def autofix_all(session: SessionDep, limit: int = 30) -> dict:
    """一键修复全库所有待处理问题（FR-146）。

    确定性部分同步跑完（单条约 16ms，几十条也就一瞬），代理部分每条视频入队一个
    会话由 worker 串行消化。`limit` 兜底防止一次点爆队列——被截断会如实回报，
    不做静默截断。
    """
    from domain.sentence_ops import resolve_action  # noqa: F401  预热同一分派口径

    video_ids = (
        (
            await session.execute(
                select(SubtitleIssue.video_id)
                .where(SubtitleIssue.state == "open")
                .group_by(SubtitleIssue.video_id)
                .order_by(SubtitleIssue.video_id)
            )
        )
        .scalars()
        .all()
    )
    truncated = max(0, len(video_ids) - limit)
    targets = video_ids[:limit]

    queue = await get_queue()
    results = []
    for vid in targets:
        results.append(await _autofix_video(session, vid, queue))

    return {
        "videos": len(results),
        "truncated": truncated,
        "auto_applied": sum(r["auto_applied"] for r in results),
        "handed_to_agent": sum(r["handed_to_agent"] for r in results),
        "agent_sessions": sum(1 for r in results if r["session_id"] is not None),
        "queued_translate": sum(1 for r in results if r["queued_translate"]),
        "items": results,
    }


@router.get("/stale")
async def stale_videos(session: SessionDep) -> list[dict]:
    """用旧管线跑出来的视频（FR-66）：可批量重跑。"""
    tracks = (
        (
            await session.execute(
                select(SubtitleTrack, Video.title, Video.status)
                .join(Video, Video.id == SubtitleTrack.video_id)
                .where(SubtitleTrack.kind.in_(("whisper", "official")))
            )
        )
        .all()
    )
    out = []
    for track, title, status in tracks:
        produced = ((track.meta or {}).get("pipeline") or {}).get("version")
        if produced != PIPELINE_VERSION:
            out.append({
                "video_id": track.video_id, "title": title, "status": status,
                "produced_version": produced, "current_version": PIPELINE_VERSION,
            })
    return out


class SentencePatch(BaseModel):
    text: str | None = None
    text_zh: str | None = None


@router.patch("/sentences/{sentence_id}")
async def patch_sentence(
    sentence_id: int, body: SentencePatch, session: SessionDep
) -> dict:
    """字幕句就地编辑（FR-78）：改完标记下游失效并提示重算。

    改英文会让译文、词组、学习句切分全部对不上，故清掉本句的下游产物并回报
    需要重跑哪些节点；只改中文则不影响上游。
    """
    row = await session.get(SubtitleSentence, sentence_id)
    if row is None:
        raise HTTPException(status_code=404, detail="sentence not found")

    stale_steps: list[str] = []
    if body.text is not None and body.text.strip() and body.text != row.text:
        from domain.analysis import content_key

        row.text = body.text.strip()
        row.content_hash = content_key(row.text)
        row.text_zh = None  # 原文变了，旧译文与旧词组区间都失效
        row.phrases = None
        ratchet.mark(row, "text")
        ratchet.clear(row, "text_zh")  # 译文已作废，旧的人工锁一并失效
        await session.execute(
            delete(StudyUnit).where(
                StudyUnit.track_id == row.track_id, StudyUnit.sentence_id == row.id
            )
        )
        stale_steps = ["sentences", "translate", "enrich.phrases"]
    if body.text_zh is not None:
        row.text_zh = body.text_zh.strip() or None
        # 人工改过的译文此后不被重跑覆盖（FR-205、BR-36）
        ratchet.mark(row, "text_zh")
    await session.commit()
    return {
        "id": row.id,
        "text": row.text,
        "text_zh": row.text_zh,
        "stale_steps": stale_steps,
        "locked_fields": sorted(row.edited_fields or {}),
    }


@router.patch("/issues/{issue_id}")
async def patch_issue(issue_id: int, session: SessionDep, state: str = "dismissed") -> dict:
    """采纳或忽略一条校验问题（FR-77）：采纳即把建议写回句子。"""
    if state not in ("open", "accepted", "dismissed"):
        raise HTTPException(status_code=400, detail="state 仅支持 open/accepted/dismissed")
    issue = await session.get(SubtitleIssue, issue_id)
    if issue is None:
        raise HTTPException(status_code=404, detail="issue not found")

    applied = False
    change: dict | None = None
    needs_zh = False
    track_id: int | None = None
    reason: str | None = None
    if state == "accepted" and issue.sentence_id:
        from domain.sentence_ops import apply_issue_action, resolve_action

        action = resolve_action(issue.kind, issue.action, issue.suggestion)
        row = await session.get(SubtitleSentence, issue.sentence_id)
        if row is not None:
            track_id = row.track_id
            try:
                out = await apply_issue_action(
                    session, issue.sentence_id, action, issue.suggestion, issue.anchor
                )
                applied = bool(out["applied"])
                change = out["change"]
                needs_zh = bool(out["needs_zh"])
                reason = out.get("reason")
            except ValueError as exc:
                reason = str(exc)
    issue.state = state
    await session.commit()

    # 补译只补空缺的句（translate_track 自带"已有译文即跳过"），
    # 且不走 DAG——走 DAG 会连带跑 enrich 与 verify，verify 又重刷问题清单
    queued_translate = False
    if needs_zh and track_id is not None:
        # 在轨上打个补译时间戳：置空是同步的、补译是异步的，中间这几秒
        # 体检必然看到缺口。有它体检才能区分"真缺"与"正在补"（FR-142）
        track = await session.get(SubtitleTrack, track_id)
        if track is not None:
            meta = dict(track.meta or {})
            meta["zh_refill_at"] = datetime.now(UTC).isoformat()
            track.meta = meta
            await session.commit()
        queue = await get_queue()
        await queue.enqueue_job(
            "translate_track", track_id,
            _job_id=f"zhfill:{track_id}:{uuid.uuid4().hex[:6]}",
        )
        queued_translate = True

    return {
        "id": issue.id, "state": state, "applied": applied, "change": change,
        "queued_translate": queued_translate, "reason": reason,
    }
