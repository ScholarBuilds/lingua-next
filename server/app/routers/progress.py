"""阅读进度：段落级已读集合 upsert + 时长累计（模块 02）。"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.owner import CurrentOwner
from app.routers.dict import SessionDep
from domain.models import Article, ReadingProgress, StudyTimeLog

router = APIRouter(tags=["progress"])

FINISHED_PCT = 98.0


def progress_state(read: int, total: int) -> tuple[float, str]:
    """(已读段数, 总段数) → (百分比, unstarted|reading|finished)。"""
    pct = min(round(read / total * 100, 1), 100.0) if total else 0.0
    if pct >= FINISHED_PCT:
        return pct, "finished"
    if pct > 0:
        return pct, "reading"
    return pct, "unstarted"


class ProgressBody(BaseModel):
    article_id: int
    last_paragraph_ordinal: int = Field(default=0, ge=0)
    read_paragraph_ordinals: list[int] = Field(default_factory=list)
    duration_s_delta: int = Field(default=0, ge=0)


def _progress_dict(row: ReadingProgress) -> dict:
    return {
        "article_id": row.article_id,
        "last_paragraph_ordinal": row.last_paragraph_ordinal,
        "read_paragraph_ordinals": row.read_paragraphs or [],
        "duration_s": row.duration_s,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


@router.post("/progress")
async def upsert_progress(body: ProgressBody, owner: CurrentOwner, session: SessionDep) -> dict:
    if await session.get(Article, body.article_id) is None:
        raise HTTPException(status_code=404, detail="article not found")
    incoming = {o for o in body.read_paragraph_ordinals if o >= 0}
    row = (
        await session.execute(
            select(ReadingProgress).where(
                ReadingProgress.user_id == owner.id,
                ReadingProgress.article_id == body.article_id,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        row = ReadingProgress(
            user_id=owner.id,
            article_id=body.article_id,
            last_paragraph_ordinal=body.last_paragraph_ordinal,
            read_paragraphs=sorted(incoming),
            duration_s=body.duration_s_delta,
        )
        session.add(row)
    else:
        # 已读集合并集去重；整列表重新赋值让 JSON 列变更可被 ORM 侦测
        row.read_paragraphs = sorted(set(row.read_paragraphs or []) | incoming)
        row.last_paragraph_ordinal = body.last_paragraph_ordinal
        row.duration_s += body.duration_s_delta
    if body.duration_s_delta > 0:
        session.add(
            StudyTimeLog(user_id=owner.id, kind="reading", seconds=body.duration_s_delta)
        )

    await session.commit()
    # server onupdate 的 updated_at 在 UPDATE 后过期，主动刷新避免同步 IO 报错
    await session.refresh(row)
    return _progress_dict(row)
