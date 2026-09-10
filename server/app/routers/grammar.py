"""语法学习与写作纠错接口（模块 14）。

四块：语法点目录与详情、句法可视化（成分着色 + 依存 JSON）、写作两段式纠错、
语法卡与 FSRS 调度。

题型的渲染与判分走[练习引擎](../../domain/exercise.py)，本模块只出内容与判分规则。
"""

from __future__ import annotations

import random
from datetime import UTC, datetime
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.owner import CurrentOwner
from app.routers.dict import SessionDep
from domain import exercise, srs
from domain.analysis import content_key
from domain.llm import LLMUnavailable
from domain.misconceptions import CATALOG as MISCONCEPTIONS
from domain.models import (
    AnalysisResult,
    Article,
    Book,
    ExerciseAttempt,
    GrammarCard,
    GrammarCardState,
    GrammarConcept,
    GrammarConstruction,
    GrammarOccurrence,
    GrammarPoint,
    GrammarPractice,
    Misconception,
    Paragraph,
    SubtitleSentence,
    SubtitleTrack,
    Video,
    WritingAttempt,
    WritingEdit,
)

router = APIRouter(prefix="/grammar", tags=["grammar"])

CEFR_LEVELS = ("A1", "A2", "B1", "B2", "C1")


@router.get("/sentence-history")
async def sentence_history(owner: CurrentOwner, session: SessionDep) -> dict:
    rows = await session.scalars(
        select(AnalysisResult)
        .where(
            AnalysisResult.context_hash == content_key(f"{owner.id}:sentence-lab:v1"),
            AnalysisResult.kind == "deconstruct",
            AnalysisResult.is_active,
        )
        .order_by(AnalysisResult.id.desc())
        .limit(30)
    )
    return {
        "items": [
            {"id": row.id, "text": row.result.get("text", ""), "created_at": row.created_at}
            for row in rows
        ]
    }


@router.get("/sentence-history/{analysis_id}")
async def sentence_result(analysis_id: int, owner: CurrentOwner, session: SessionDep) -> dict:
    row = await session.get(AnalysisResult, analysis_id)
    if (
        row is None
        or row.kind != "deconstruct"
        or row.context_hash != content_key(f"{owner.id}:sentence-lab:v1")
    ):
        raise HTTPException(404, "分析记录不存在")
    return {**row.result, "analysis_id": row.id}


# ──────────────────────────── 语法点目录（FR-400） ────────────────────────────


def _point_brief(p: GrammarPoint) -> dict:
    return {
        "id": p.id,
        "ext_id": p.ext_id,
        "code": p.shorthand_code,
        "item": p.item,
        "item_zh": p.item_zh,
        "sentence_type": p.sentence_type,
        "cefr_level": p.cefr_level,
        "cefrj_level": p.cefrj_level,
        "category": p.category,
        "note_zh": p.note_zh,
    }


@router.get("/points")
async def list_points(
    session: SessionDep,
    category: str | None = None,
    level: str | None = None,
    q: str | None = None,
) -> dict:
    """语法点目录。**按语法范畴分组而非难度排序，允许乱序进入**（FR-400d，抄 EGiU）。"""
    stmt = select(GrammarPoint).order_by(GrammarPoint.category, GrammarPoint.order_index)
    if category:
        stmt = stmt.where(GrammarPoint.category == category)
    if level:
        stmt = stmt.where(GrammarPoint.cefr_level == level)
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(
            GrammarPoint.item.ilike(like)
            | GrammarPoint.item_zh.ilike(like)
            | GrammarPoint.shorthand_code.ilike(like)
        )
    rows = (await session.execute(stmt)).scalars().all()

    # 有多少语法点在自己的语料里真的出现过——这是本模块的差异化指标，放在目录页上
    occ = dict(
        (
            await session.execute(
                select(GrammarOccurrence.grammar_point_id, func.count()).group_by(
                    GrammarOccurrence.grammar_point_id
                )
            )
        ).all()
    )
    cards = dict(
        (
            await session.execute(
                select(GrammarCard.grammar_point_id, func.count()).group_by(
                    GrammarCard.grammar_point_id
                )
            )
        ).all()
    )
    items = [
        {**_point_brief(p), "occurrences": occ.get(p.id, 0), "cards": cards.get(p.id, 0)}
        for p in rows
    ]
    cats: dict[str, list] = {}
    for it in items:
        cats.setdefault(it["category"], []).append(it)
    return {
        "items": items,
        "categories": [{"name": k, "count": len(v)} for k, v in cats.items()],
        "levels": CEFR_LEVELS,
        "total": len(items),
        "credit": "语法点目录依据 CEFR-J Grammar Profile（东京外国语大学 投野研究室）",
    }


@router.get("/points/{point_id}")
async def point_detail(point_id: int, session: SessionDep) -> dict:
    """一个语法点 = 一屏：上讲解、下练习、右侧是它在你自己语料里的出现。"""
    p = await session.get(GrammarPoint, point_id)
    if p is None:
        raise HTTPException(status_code=404, detail="没有这个语法点")
    cons = (
        (
            await session.execute(
                select(GrammarConstruction).where(GrammarConstruction.grammar_point_id == point_id)
            )
        )
        .scalars()
        .all()
    )
    occ_n = (
        await session.execute(
            select(func.count())
            .select_from(GrammarOccurrence)
            .where(GrammarOccurrence.grammar_point_id == point_id)
        )
    ).scalar_one()
    cards = (
        (await session.execute(select(GrammarCard).where(GrammarCard.grammar_point_id == point_id)))
        .scalars()
        .all()
    )
    return {
        **_point_brief(p),
        "explanation": p.explanation,
        "examples": p.examples or [],
        "constructions": [{"key": c.key, "description": c.description} for c in cons],
        "occurrences": occ_n,
        "cards": [
            {"id": c.id, "kind": c.kind, "widget": c.widget, "schedulable": c.schedulable}
            for c in cards
        ],
    }


async def _occurrence_sources(session: AsyncSession, rows: list[GrammarOccurrence]) -> dict:
    """把 occurrence 的 source_id 翻成人话：书名·章节 / 视频标题。"""
    art_ids = {r.source_id for r in rows if r.source_kind == "article"}
    track_ids = {r.source_id for r in rows if r.source_kind == "subtitle"}
    labels: dict[tuple[str, int], dict] = {}
    if art_ids:
        for aid, title, btitle, bid in (
            await session.execute(
                select(Article.id, Article.title, Book.title, Book.id)
                .outerjoin(Book, Book.id == Article.book_id)
                .where(Article.id.in_(art_ids))
            )
        ).all():
            labels[("article", aid)] = {
                "label": f"{btitle} · {title}" if btitle else title,
                "book_id": bid,
                "article_id": aid,
                "href": f"/read/{aid}",
            }
    if track_ids:
        for tid, vid, vtitle in (
            await session.execute(
                select(SubtitleTrack.id, Video.id, Video.title)
                .join(Video, Video.id == SubtitleTrack.video_id)
                .where(SubtitleTrack.id.in_(track_ids))
            )
        ).all():
            labels[("subtitle", tid)] = {
                "label": vtitle,
                "video_id": vid,
                "href": f"/video/{vid}",
            }
    return labels


@router.get("/points/{point_id}/occurrences")
async def point_occurrences(
    point_id: int, session: SessionDep, limit: int = Query(40, ge=1, le=200)
) -> dict:
    """「你上周读的那本书第 3 章有 7 句用了这个结构」（FR-401b）。

    返回的每条都能跳回原文，带段落 id 与 UTF-16 偏移——阅读器直接定位高亮。
    """
    rows = (
        (
            await session.execute(
                select(GrammarOccurrence)
                .where(GrammarOccurrence.grammar_point_id == point_id)
                .order_by(GrammarOccurrence.id)
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    labels = await _occurrence_sources(session, rows)
    by_source: dict[str, dict] = {}
    for r in rows:
        meta = labels.get((r.source_kind, r.source_id)) or {"label": f"#{r.source_id}"}
        k = f"{r.source_kind}:{r.source_id}"
        entry = by_source.setdefault(k, {**meta, "kind": r.source_kind, "items": []})
        entry["items"].append(
            {
                "id": r.id,
                "construction": r.construction_key,
                "paragraph_id": r.paragraph_id,
                "sentence_id": r.sentence_id,
                "char_start": r.char_start,
                "char_end": r.char_end,
                "snippet": r.snippet,
            }
        )
    return {"sources": list(by_source.values()), "total": len(rows)}


# ──────────────────────────── 写作纠错（FR-403） ────────────────────────────


class WritingIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    card_id: int | None = None


def _attempt_payload(a: WritingAttempt, edits: list[WritingEdit], codes: dict[int, str]) -> dict:
    return {
        "id": a.id,
        "original": a.original,
        "corrected": a.corrected,
        "status": a.status,
        "error": a.error,
        "summary": a.summary,
        "origin": a.origin,
        "card_id": a.card_id,
        "created_at": a.created_at.isoformat() if a.created_at else None,
        "edits": [
            {
                "id": e.id,
                "errant_type": e.errant_type,
                "o_str": e.o_str,
                "c_str": e.c_str,
                "char_start": e.char_start,
                "char_end": e.char_end,
                "explanation": e.explanation,
                "misconception": codes.get(e.misconception_id or -1),
                "grammar_point_id": e.grammar_point_id,
                "ordinal": e.ordinal,
            }
            for e in edits
        ],
    }


@router.post("/writing", status_code=201)
async def submit_writing(body: WritingIn, session: SessionDep, owner: CurrentOwner) -> dict:
    """两段式纠错（BR-97）：LLM 出修正句 → ERRANT 原子化 → 逐条讲解。

    整句一次过被明确禁止——一步式实测只覆盖 40.6% 的错误。
    """
    from domain.writing import WritingError, atomize, correct_sentence, explain_edits, summarize

    attempt = WritingAttempt(
        original=body.text.strip(),
        origin="card" if body.card_id else "free",
        card_id=body.card_id,
        status="pending",
        user_id=owner.id,
    )
    session.add(attempt)
    await session.commit()
    await session.refresh(attempt)

    try:
        corrected = await correct_sentence(attempt.original)
    except (WritingError, LLMUnavailable) as exc:
        attempt.status = "failed"
        attempt.error = str(exc)
        await session.commit()
        raise HTTPException(status_code=503, detail=f"批改不可用：{exc}") from exc

    edits = atomize(attempt.original, corrected)
    try:
        edits = await explain_edits(attempt.original, corrected, edits)
    except LLMUnavailable as exc:
        # 讲解失败不该丢掉已经算出来的原子编辑——那部分是确定性的
        attempt.error = f"逐条讲解不可用：{exc}"

    codes = dict((await session.execute(select(Misconception.code, Misconception.id))).all())
    points = dict(
        (await session.execute(select(Misconception.id, Misconception.remedial_point_id))).all()
    )
    rows: list[WritingEdit] = []
    for e in edits:
        mid = codes.get(e.get("misconception") or "")
        rows.append(
            WritingEdit(
                attempt_id=attempt.id,
                errant_type=e["errant_type"][:32],
                o_start=e["o_start"],
                o_end=e["o_end"],
                char_start=e["char_start"],
                char_end=e["char_end"],
                o_str=e["o_str"],
                c_str=e["c_str"],
                explanation=e.get("explanation"),
                misconception_id=mid,
                grammar_point_id=points.get(mid) if mid else None,
                ordinal=e["ordinal"],
            )
        )
    session.add_all(rows)
    # 误区命中计数：FR-402d 用它把相关语法点提前
    for mid in {r.misconception_id for r in rows if r.misconception_id}:
        m = await session.get(Misconception, mid)
        if m:
            m.hit_count += 1
    attempt.corrected = corrected
    attempt.status = "ready"
    attempt.summary = await summarize(attempt.original, edits)
    await session.commit()
    for r in rows:
        await session.refresh(r)
    return _attempt_payload(attempt, rows, {v: k for k, v in codes.items()})


@router.get("/writing")
async def list_writing(
    session: SessionDep, owner: CurrentOwner, limit: int = Query(20, ge=1, le=100)
) -> dict:
    rows = (
        (
            await session.execute(
                select(WritingAttempt)
                .where(WritingAttempt.user_id == owner.id)
                .order_by(WritingAttempt.id.desc())
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    edits = (
        (
            await session.execute(
                select(WritingEdit)
                .where(WritingEdit.attempt_id.in_([r.id for r in rows] or [0]))
                .order_by(WritingEdit.attempt_id, WritingEdit.ordinal)
            )
        )
        .scalars()
        .all()
    )
    codes = dict((await session.execute(select(Misconception.id, Misconception.code))).all())
    by_attempt: dict[int, list[WritingEdit]] = {}
    for e in edits:
        by_attempt.setdefault(e.attempt_id, []).append(e)
    return {"items": [_attempt_payload(a, by_attempt.get(a.id, []), codes) for a in rows]}


@router.get("/errors")
async def error_book(session: SessionDep, owner: CurrentOwner) -> dict:
    """错题本（FR-402d）：按 ERRANT 类型与误区统计，驱动语法点排序。"""
    by_type = (
        await session.execute(
            select(WritingEdit.errant_type, func.count())
            .join(WritingAttempt, WritingEdit.attempt_id == WritingAttempt.id)
            .where(WritingAttempt.user_id == owner.id)
            .group_by(WritingEdit.errant_type)
            .order_by(func.count().desc())
        )
    ).all()
    rows = (
        (
            await session.execute(
                select(Misconception)
                .where(Misconception.hit_count > 0)
                .order_by(Misconception.hit_count.desc())
            )
        )
        .scalars()
        .all()
    )
    points = {}
    if rows:
        ids = {m.remedial_point_id for m in rows if m.remedial_point_id}
        if ids:
            points = {
                p.id: _point_brief(p)
                for p in (
                    await session.execute(select(GrammarPoint).where(GrammarPoint.id.in_(ids)))
                ).scalars()
            }
    return {
        "by_errant_type": [{"type": t, "count": n} for t, n in by_type],
        "misconceptions": [
            {
                "code": m.code,
                "name": m.name,
                "description": m.description,
                "feedback": m.feedback,
                "count": m.hit_count,
                "remedial": points.get(m.remedial_point_id or -1),
            }
            for m in rows
        ],
        "catalog_size": len(MISCONCEPTIONS),
    }


# ──────────────────────────── 语法卡与调度（FR-404、FR-406） ────────────────────────────


@router.get("/cards/due")
async def due_cards(
    session: SessionDep,
    owner: CurrentOwner,
    limit: int = Query(20, ge=1, le=100),
    include_new: bool = True,
) -> dict:
    """到期队列。只调度可自动判定的题（FR-406b）；产出型与情感型不进 SRS。"""
    now = datetime.now(UTC)
    stmt = (
        select(GrammarCard, GrammarCardState)
        .outerjoin(
            GrammarCardState,
            (GrammarCardState.card_id == GrammarCard.id) & (GrammarCardState.user_id == owner.id),
        )
        .where(GrammarCard.schedulable)
        .where((GrammarCardState.id.is_(None)) | (GrammarCardState.due_at <= now))
        .order_by(func.coalesce(GrammarCardState.due_at, now), GrammarCard.id)
        .limit(limit)
    )
    if not include_new:
        stmt = stmt.where(GrammarCardState.id.is_not(None))
    rows = (await session.execute(stmt)).all()
    points = {}
    if rows:
        ids = {c.grammar_point_id for c, _ in rows}
        points = {
            p.id: _point_brief(p)
            for p in (
                await session.execute(select(GrammarPoint).where(GrammarPoint.id.in_(ids)))
            ).scalars()
        }
    return {
        "items": [
            {
                "card_id": c.id,
                "kind": c.kind,
                "question": {**c.payload, "widget": c.widget, "id": f"gc-{c.id}"},
                "point": points.get(c.grammar_point_id),
                "state": srs.card_state_name(st.fsrs_card if st else None),
            }
            for c, st in rows
        ],
        "total": len(rows),
    }


@router.get("/points/{point_id}/cards")
async def point_cards(point_id: int, session: SessionDep) -> dict:
    rows = (
        (
            await session.execute(
                select(GrammarCard)
                .where(GrammarCard.grammar_point_id == point_id)
                .order_by(GrammarCard.id)
            )
        )
        .scalars()
        .all()
    )
    return {
        "items": [
            {
                "card_id": c.id,
                "kind": c.kind,
                "question": {**c.payload, "widget": c.widget, "id": f"gc-{c.id}"},
            }
            for c in rows
        ]
    }


class AnswerIn(BaseModel):
    card_id: int
    response: object = None
    elapsed_ms: int | None = Field(default=None, ge=0)


@router.post("/answer")
async def answer_card(body: AnswerIn, session: SessionDep, owner: CurrentOwner) -> dict:
    """判分走练习引擎的纯函数；这里只负责持久化与误区计数。"""
    card = await session.get(GrammarCard, body.card_id)
    if card is None:
        raise HTTPException(status_code=404, detail="没有这张卡")
    question = {**card.payload, "widget": card.widget}
    try:
        result = exercise.score(question, body.response)
    except exercise.QuestionError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    mid = None
    if result.misconception:
        mid = (
            await session.execute(
                select(Misconception.id).where(Misconception.code == result.misconception)
            )
        ).scalar_one_or_none()
        if mid:
            m = await session.get(Misconception, mid)
            if m:
                m.hit_count += 1
    session.add(
        ExerciseAttempt(
            card_id=card.id,
            user_id=owner.id,
            widget=card.widget,
            correct=result.correct,
            response=body.response if isinstance(body.response, dict) else {"value": body.response},
            misconception_id=mid,
            feedback=result.feedback,
            elapsed_ms=body.elapsed_ms,
        )
    )
    await session.commit()
    payload = result.to_dict()
    if mid:
        m = await session.get(Misconception, mid)
        payload["remedial_point_id"] = m.remedial_point_id if m else None
    return payload


class GradeIn(BaseModel):
    card_id: int
    rating: int = Field(ge=1, le=4)


@router.post("/grade")
async def grade_card(body: GradeIn, session: SessionDep, owner: CurrentOwner) -> dict:
    """一题一卡（FR-406a），评分直接喂现有 `domain/srs.py`，调度逻辑零改动（FR-406c）。"""
    card = await session.get(GrammarCard, body.card_id)
    if card is None:
        raise HTTPException(status_code=404, detail="没有这张卡")
    if not card.schedulable:
        raise HTTPException(status_code=400, detail="这类题不进 SRS（FR-406b）")
    st = (
        await session.execute(
            select(GrammarCardState).where(
                GrammarCardState.card_id == card.id,
                GrammarCardState.user_id == owner.id,
            )
        )
    ).scalar_one_or_none()
    if st is None:
        st = GrammarCardState(card_id=card.id, user_id=owner.id, fsrs_card=srs.init_card())
        session.add(st)
        await session.flush()
    new_card, _log, due = srs.review(st.fsrs_card or srs.init_card(), body.rating)
    st.fsrs_card = new_card
    st.due_at = due
    st.last_review_at = datetime.now(UTC)
    st.reps += 1
    if body.rating == 1:
        st.lapses += 1
    await session.commit()
    return {
        "state": srs.card_state_name(new_card),
        "due": due.isoformat(),
        "intervals": srs.preview_intervals(new_card),
    }


@router.get("/stats")
async def stats(session: SessionDep, owner: CurrentOwner) -> dict:
    """学习概览：目录覆盖、语料绑定、卡片与到期量。"""
    now = datetime.now(UTC)
    points = (await session.execute(select(func.count()).select_from(GrammarPoint))).scalar_one()
    occ = (await session.execute(select(func.count()).select_from(GrammarOccurrence))).scalar_one()
    bound = (
        await session.execute(select(func.count(func.distinct(GrammarOccurrence.grammar_point_id))))
    ).scalar_one()
    cards = (await session.execute(select(func.count()).select_from(GrammarCard))).scalar_one()
    due = (
        await session.execute(
            select(func.count())
            .select_from(GrammarCard)
            .outerjoin(
                GrammarCardState,
                (GrammarCardState.card_id == GrammarCard.id)
                & (GrammarCardState.user_id == owner.id),
            )
            .where(GrammarCard.schedulable)
            .where((GrammarCardState.id.is_(None)) | (GrammarCardState.due_at <= now))
        )
    ).scalar_one()
    new_count = await session.scalar(
        select(func.count())
        .select_from(GrammarCard)
        .outerjoin(
            GrammarCardState,
            (GrammarCardState.card_id == GrammarCard.id) & (GrammarCardState.user_id == owner.id),
        )
        .where(GrammarCard.schedulable, GrammarCardState.id.is_(None))
    )
    attempts = (
        await session.execute(
            select(func.count())
            .select_from(ExerciseAttempt)
            .where(ExerciseAttempt.user_id == owner.id)
        )
    ).scalar_one()
    written = (
        await session.execute(
            select(func.count())
            .select_from(WritingAttempt)
            .where(WritingAttempt.user_id == owner.id)
        )
    ).scalar_one()
    return {
        "points": points,
        "occurrences": occ,
        "points_with_corpus": bound,
        "cards": cards,
        "due": due,
        "new_count": new_count,
        "due_count": due - (new_count or 0),
        "attempts": attempts,
        "writing_attempts": written,
        "widgets": exercise.widgets(),
    }


def _practice_payload(row: GrammarPractice) -> dict:
    return {
        "id": row.id,
        "mode": row.mode,
        "status": row.status,
        "questions": row.questions,
        "answers": row.answers,
        "cursor": row.cursor,
        "version": row.version,
        "updated_at": row.updated_at,
    }


class PracticeCreate(BaseModel):
    mode: Literal["review", "section", "errors"] = "review"
    point_ids: list[int] = Field(default_factory=list, max_length=40)
    count: Literal[5, 10, 20] = 5


@router.get("/section-points")
async def section_points(session: SessionDep, path: str = Query(max_length=400)) -> dict:
    mappings = await session.scalars(
        select(GrammarConcept.grammar_point_ids).where(
            GrammarConcept.source_path == path, GrammarConcept.status == "active"
        )
    )
    ids = sorted({point_id for group in mappings for point_id in group})
    count = await session.scalar(
        select(func.count())
        .select_from(GrammarCard)
        .where(GrammarCard.grammar_point_id.in_(ids), GrammarCard.schedulable)
    )
    return {"point_ids": ids, "count": count}


@router.get("/practice")
async def practice_history(owner: CurrentOwner, session: SessionDep) -> dict:
    rows = (
        await session.scalars(
            select(GrammarPractice)
            .where(GrammarPractice.user_id == owner.id)
            .order_by(GrammarPractice.updated_at.desc())
            .limit(50)
        )
    ).all()
    return {"items": [_practice_payload(row) for row in rows]}


@router.post("/practice")
async def create_practice(body: PracticeCreate, owner: CurrentOwner, session: SessionDep) -> dict:
    if body.mode == "review":
        cards = (await due_cards(session, owner, body.count, False))["items"]
    else:
        stmt = select(GrammarCard).where(GrammarCard.schedulable).order_by(GrammarCard.id)
        if body.mode == "section":
            if not body.point_ids:
                raise HTTPException(422, "本节尚未关联语法题目")
            stmt = stmt.where(GrammarCard.grammar_point_id.in_(body.point_ids))
        else:
            stmt = stmt.where(
                GrammarCard.id.in_(
                    select(ExerciseAttempt.card_id).where(
                        ExerciseAttempt.user_id == owner.id, ExerciseAttempt.correct.is_(False)
                    )
                )
            )
        rows = (await session.scalars(stmt.limit(body.count))).all()
        points = {
            p.id: _point_brief(p)
            for p in await session.scalars(
                select(GrammarPoint).where(GrammarPoint.id.in_({c.grammar_point_id for c in rows}))
            )
        }
        cards = [
            {
                "card_id": c.id,
                "kind": c.kind,
                "point": points.get(c.grammar_point_id),
                "state": "new",
                "question": {**c.payload, "widget": c.widget},
            }
            for c in rows
        ]
    if not cards:
        raise HTTPException(422, "此范围没有可练习的题目")
    row = GrammarPractice(
        id=str(uuid4()),
        user_id=owner.id,
        mode=body.mode,
        questions=[{**c, "submission_id": str(uuid4())} for c in cards],
    )
    session.add(row)
    await session.commit()
    return _practice_payload(row)


@router.get("/practice/{practice_id}")
async def read_practice(practice_id: str, owner: CurrentOwner, session: SessionDep) -> dict:
    row = await session.get(GrammarPractice, practice_id)
    if row is None or row.user_id != owner.id:
        raise HTTPException(404, "训练不存在")
    return _practice_payload(row)


class PracticeSubmit(BaseModel):
    submission_id: str = Field(min_length=1, max_length=36)
    response: object = None
    rating: int | None = Field(default=None, ge=1, le=4)
    hints: int = Field(default=0, ge=0, le=3)


@router.post("/practice/{practice_id}/answer")
async def submit_practice(
    practice_id: str, body: PracticeSubmit, owner: CurrentOwner, session: SessionDep
) -> dict:
    row = await session.get(GrammarPractice, practice_id)
    if row is None or row.user_id != owner.id:
        raise HTTPException(404, "训练不存在")
    if body.submission_id in row.answers:
        return {"result": row.answers[body.submission_id], "practice": _practice_payload(row)}
    if row.cursor >= len(row.questions):
        raise HTTPException(409, "本轮已结束")
    item = row.questions[row.cursor]
    if item["submission_id"] != body.submission_id:
        raise HTTPException(409, "请先完成当前题")
    try:
        result = exercise.score(item["question"], body.response).to_dict()
    except exercise.QuestionError as exc:
        raise HTTPException(422, str(exc)) from exc
    hints = max(body.hints, item.get("hints", 0))
    first_result = item.get("first_verdict", result)
    if body.rating is not None and (hints == 3 or not first_result["correct"]) and body.rating > 2:
        raise HTTPException(422, "看过答案或答错后请选择忘记或困难")
    claimed = await session.execute(
        update(GrammarPractice)
        .where(GrammarPractice.id == row.id, GrammarPractice.version == row.version)
        .values(version=row.version + 1)
    )
    if claimed.rowcount != 1:
        await session.rollback()
        raise HTTPException(409, "记录已更新，请重试读取")
    if body.rating is None:
        row.questions = [
            {
                **question,
                "draft_response": body.response,
                "verdict": result,
                "first_verdict": first_result,
                "hints": hints,
            }
            if index == row.cursor
            else question
            for index, question in enumerate(row.questions)
        ]
        await session.commit()
        await session.refresh(row)
        return {"result": result, "practice": _practice_payload(row)}
    session.add(
        ExerciseAttempt(
            user_id=owner.id,
            card_id=item["card_id"],
            widget=item["question"]["widget"],
            correct=first_result["correct"],
            response={"value": body.response, "hints": hints},
            feedback=result["feedback"],
        )
    )
    if row.mode != "errors":
        state = await session.scalar(
            select(GrammarCardState).where(
                GrammarCardState.card_id == item["card_id"], GrammarCardState.user_id == owner.id
            )
        )
        if state is None:
            state = GrammarCardState(
                card_id=item["card_id"],
                user_id=owner.id,
                fsrs_card=srs.init_card(),
                reps=0,
                lapses=0,
            )
            session.add(state)
        card, _, due = srs.review(state.fsrs_card or srs.init_card(), body.rating)
        state.fsrs_card, state.due_at = card, due
        state.last_review_at = datetime.now(UTC)
        state.reps += 1
        state.lapses += body.rating == 1
        result["due"] = due.isoformat()
    row.answers = {
        **row.answers,
        body.submission_id: {
            **result,
            "first_correct": first_result["correct"],
            "hints": hints,
            "response": body.response,
        },
    }
    row.cursor += 1
    row.status = "finished" if row.cursor == len(row.questions) else "active"
    await session.commit()
    await session.refresh(row)
    return {"result": row.answers[body.submission_id], "practice": _practice_payload(row)}


# ──────────────────────────── 语料定位题（FR-404 第 3 类） ────────────────────────────


@router.get("/points/{point_id}/locate")
async def locate_question(point_id: int, session: SessionDep, seed: int | None = None) -> dict:
    """在自己读过的书/看过的视频里找出该结构。复用 L2 的匹配结果，零 LLM 成本。"""
    hits = (
        (
            await session.execute(
                select(GrammarOccurrence)
                .where(GrammarOccurrence.grammar_point_id == point_id)
                .limit(60)
            )
        )
        .scalars()
        .all()
    )
    if len(hits) < 1:
        raise HTTPException(status_code=404, detail="这个语法点在你的语料里还没有出现")
    others = (
        (
            await session.execute(
                select(GrammarOccurrence)
                .where(GrammarOccurrence.grammar_point_id != point_id)
                .order_by(func.random())
                .limit(30)
            )
        )
        .scalars()
        .all()
    )
    rng = random.Random(seed)
    target = rng.choice(hits)
    para_ids = {o.paragraph_id for o in [target, *others] if o.paragraph_id}
    texts = dict(
        (
            await session.execute(
                select(Paragraph.id, Paragraph.text).where(Paragraph.id.in_(para_ids or {0}))
            )
        ).all()
    )
    sent_ids = {o.sentence_id for o in [target, *others] if o.sentence_id}
    sub_texts = dict(
        (
            await session.execute(
                select(SubtitleSentence.id, SubtitleSentence.text).where(
                    SubtitleSentence.id.in_(sent_ids or {0})
                )
            )
        ).all()
    )

    def _sentence(o: GrammarOccurrence) -> str:
        raw = texts.get(o.paragraph_id or -1) or sub_texts.get(o.sentence_id or -1) or o.snippet
        return raw[:220]

    pool = [target, *rng.sample(others, min(3, len(others)))]
    rng.shuffle(pool)
    question = {
        "id": f"loc-{point_id}-{target.id}",
        "widget": "locate",
        "prompt": "下面哪一句用到了这个语法结构？",
        "occurrences": [{"id": o.id, "text": _sentence(o), "snippet": o.snippet} for o in pool],
        "choices": [str(o.id) for o in pool],
        "answer": str(target.id),
        "meta": {
            "paragraph_id": target.paragraph_id,
            "char_start": target.char_start,
            "char_end": target.char_end,
            "construction": target.construction_key,
        },
    }
    exercise.validate(question)
    return {"question": question}
