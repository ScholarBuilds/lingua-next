"""任务摘要与跨领域历史的统一身份和筛选。"""

import base64
import json
from datetime import datetime

from fastapi import HTTPException
from sqlalchemy import String, and_, cast, func, literal, or_, select, union_all

from domain.models import PipelineRun, StudioFlowRun, StudioTask

ACTIVE = {"queued", "submitting", "running", "recovering", "pending"}
ATTENTION = {"failed", "partial", "awaiting_input", "interrupted"}


def records():
    covered = (
        select(StudioTask.id)
        .where(StudioTask.invocation["image_job_id"].as_integer() == PipelineRun.subject_id)
        .exists()
    )
    queries = []
    for kind, model in [("task", StudioTask), ("flow", StudioFlowRun), ("pipeline", PipelineRun)]:
        query = select(
            literal(kind).label("kind"),
            cast(model.id, String).label("id"),
            model.created_at.label("at"),
            model.status.label("status"),
        )
        if kind == "pipeline":
            query = query.where(~and_(PipelineRun.domain == "image_gen", covered))
        queries.append(query)
    return union_all(*queries).subquery()


async def summary(session):
    source = records()
    counts = dict(
        (
            await session.execute(select(source.c.status, func.count()).group_by(source.c.status))
        ).all()
    )
    return {
        "active": sum(n for status, n in counts.items() if status in ACTIVE),
        "attention": sum(n for status, n in counts.items() if status in ATTENTION),
        "total": sum(counts.values()),
    }


async def history_ids(
    session, scope: str, cursor: str | None, limit: int, identity: str | None = None
):
    source = records()
    query = select(source)
    if identity:
        kind, separator, row_id = identity.partition(":")
        if not separator or kind not in {"task", "flow", "pipeline"} or not row_id:
            raise HTTPException(422, "任务标识格式为 task:ID、flow:ID 或 pipeline:ID")
        query = query.where(source.c.kind == kind, source.c.id == row_id)
    if scope == "active":
        query = query.where(source.c.status.in_(ACTIVE))
    elif scope == "failed":
        query = query.where(source.c.status.in_(ATTENTION))
    elif scope == "finished":
        query = query.where(source.c.status.not_in(ACTIVE | ATTENTION))
    elif scope != "all":
        raise HTTPException(422, "无效的任务筛选")
    if cursor:
        try:
            at, kind, row_id = json.loads(base64.urlsafe_b64decode(cursor))
            at = datetime.fromisoformat(at)
            if kind not in {"task", "flow", "pipeline"} or not isinstance(row_id, str):
                raise ValueError("cursor")
        except (ValueError, TypeError) as error:
            raise HTTPException(422, "无效的历史游标") from error
        query = query.where(
            or_(
                source.c.at < at,
                and_(source.c.at == at, source.c.kind < kind),
                and_(source.c.at == at, source.c.kind == kind, source.c.id < row_id),
            )
        )
    rows = (
        await session.execute(
            query.order_by(source.c.at.desc(), source.c.kind.desc(), source.c.id.desc()).limit(
                limit + 1
            )
        )
    ).all()
    page = rows[:limit]
    next_cursor = None
    if len(rows) > limit:
        last = page[-1]
        next_cursor = base64.urlsafe_b64encode(
            json.dumps([last.at.isoformat(), last.kind, last.id]).encode()
        ).decode()
    return page, next_cursor
