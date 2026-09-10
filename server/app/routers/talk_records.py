import asyncio
import json
import logging
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import String, cast, delete, func, or_, select, update
from sqlalchemy.exc import IntegrityError

from app.owner import CurrentOwner
from app.routers.dict import SessionDep
from domain.analysis import content_key, get_cached, save_result
from domain.llm import LLMUnavailable
from domain.model_invocations import invocation_context
from domain.models import AnalysisResult, TalkCoachBatch, TalkSession, TalkTurn
from domain.scenarios import get_scenario_merged
from domain.talk import CHAT_ALIAS, close_talk_session, coach_message

router = APIRouter(prefix="/sessions", tags=["talk"])
logger = logging.getLogger(__name__)


def utc_timestamp(value):
    if value is None:
        return None
    return value.replace(tzinfo=UTC).isoformat() if value.tzinfo is None else value.isoformat()


async def recover_interrupted(db):
    await db.execute(
        update(TalkCoachBatch)
        .where(TalkCoachBatch.status == "running")
        .values(status="interrupted", error="服务已重启，请手动重试", updated_at=datetime.now(UTC))
    )
    talks = list(
        (
            await db.scalars(
                select(TalkSession).where(
                    TalkSession.mode == "realtime", TalkSession.ended_at.is_(None)
                )
            )
        ).all()
    )
    for talk in talks:
        last_message = await db.scalar(
            select(func.max(TalkTurn.created_at)).where(TalkTurn.session_id == talk.id)
        )
        await close_talk_session(db, talk, ended_at=last_message or talk.started_at)
    await db.commit()


async def owned_session(db, session_id, owner):
    talk = await db.get(TalkSession, session_id)
    if talk is None or talk.user_id not in (None, owner.id):
        raise HTTPException(404, "session not found")
    return talk


async def owned_turn(db, session_id, turn_id, owner):
    await owned_session(db, session_id, owner)
    turn = await db.get(TalkTurn, turn_id)
    if turn is None or turn.session_id != session_id:
        raise HTTPException(404, "turn not found")
    return turn


def batch_payload(batch, analysis):
    return {
        "id": batch.id,
        "batch_index": batch.batch_index,
        "status": batch.status,
        "error": batch.error,
        "saved_replies": batch.saved_replies,
        "created_at": utc_timestamp(batch.created_at),
        "model": analysis.model if analysis else None,
        "result": analysis.result if analysis else None,
    }


async def read_batches(db, turn_ids):
    rows = (
        await db.execute(
            select(TalkCoachBatch, AnalysisResult)
            .outerjoin(AnalysisResult, TalkCoachBatch.analysis_id == AnalysisResult.id)
            .where(TalkCoachBatch.turn_id.in_(turn_ids))
            .order_by(TalkCoachBatch.batch_index)
        )
    ).all()
    grouped: dict[int, list] = {}
    for batch, analysis in rows:
        updated = batch.updated_at
        if updated.tzinfo is None:
            updated = updated.replace(tzinfo=UTC)
        if batch.status == "running" and updated < datetime.now(UTC) - timedelta(minutes=3):
            batch.status = "interrupted"
            batch.error = "生成中断，请手动重试"
        grouped.setdefault(batch.turn_id, []).append(batch_payload(batch, analysis))
    await db.commit()
    return grouped


@router.get("/{session_id}/records")
async def records(
    session_id: int,
    session: SessionDep,
    owner: CurrentOwner,
    before: int | None = None,
    limit: int = Query(50, ge=1, le=50),
    q: str = Query("", max_length=200),
    role: str | None = None,
    saved: bool = False,
):
    talk = await owned_session(session, session_id, owner)
    if role not in (None, "user", "assistant"):
        raise HTTPException(422, "invalid role")
    conditions = [TalkTurn.session_id == session_id]
    if role:
        conditions.append(TalkTurn.role == role)
    if saved:
        favorite_batches = select(TalkCoachBatch.turn_id).where(
            cast(TalkCoachBatch.saved_replies, String) != "[]"
        )
        conditions.append(
            or_(
                TalkTurn.saved.is_(True),
                cast(TalkTurn.saved_texts, String) != "[]",
                TalkTurn.id.in_(favorite_batches),
            )
        )
    if q.strip():
        pattern = f"%{q.strip().replace('/', '//').replace('%', '/%').replace('_', '/_')}%"
        searchable = [AnalysisResult.result[key].as_string() for key in ("translation", "intent")]
        searchable.extend(
            AnalysisResult.result["replies"][index][key].as_string()
            for index in range(3)
            for key in ("en", "zh")
        )
        matches = (
            select(TalkCoachBatch.turn_id)
            .join(AnalysisResult, TalkCoachBatch.analysis_id == AnalysisResult.id)
            .where(or_(*(value.ilike(pattern, escape="/") for value in searchable)))
        )
        conditions.append(or_(TalkTurn.text.ilike(pattern, escape="/"), TalkTurn.id.in_(matches)))
    total = await session.scalar(select(func.count(TalkTurn.id)).where(*conditions))
    if before is not None:
        conditions.append(TalkTurn.ordinal < before)
    turns = list(
        (
            await session.scalars(
                select(TalkTurn)
                .where(*conditions)
                .order_by(TalkTurn.ordinal.desc())
                .limit(limit + 1)
            )
        ).all()
    )
    has_more = len(turns) > limit
    turns = turns[:limit]
    batches = await read_batches(session, [turn.id for turn in turns])
    return {
        "total": total,
        "ended_at": utc_timestamp(talk.ended_at),
        "next_cursor": turns[-1].ordinal if has_more else None,
        "items": [
            {
                "id": t.id,
                "message_id": t.message_id,
                "ordinal": t.ordinal,
                "role": t.role,
                "text": t.text,
                "complete": t.complete,
                "saved": t.saved,
                "saved_texts": t.saved_texts,
                "created_at": utc_timestamp(t.created_at),
                "batches": batches.get(t.id, []),
            }
            for t in reversed(turns)
        ],
    }


@router.get("/{session_id}/turns/{turn_id}/coach")
async def batches(session_id: int, turn_id: int, session: SessionDep, owner: CurrentOwner):
    await owned_turn(session, session_id, turn_id, owner)
    return (await read_batches(session, [turn_id])).get(turn_id, [])


class BatchRequest(BaseModel):
    batch_index: int = Field(default=0, ge=0, lt=20)
    retry: bool = False


@router.post("/{session_id}/turns/{turn_id}/coach")
async def generate_batch(
    session_id: int,
    turn_id: int,
    body: BatchRequest,
    session: SessionDep,
    owner: CurrentOwner,
):
    turn = await owned_turn(session, session_id, turn_id, owner)
    if turn.role != "assistant":
        raise HTTPException(422, "只能为对方的回复生成辅助")
    existing = (await read_batches(session, [turn_id])).get(turn_id, [])
    current = next((b for b in existing if b["batch_index"] == body.batch_index), None)
    if current and (current["status"] in ("ready", "running") or not body.retry):
        return current
    previous_batches = [b for b in existing if b["batch_index"] < body.batch_index]
    if len(previous_batches) != body.batch_index or any(
        b["status"] != "ready" for b in previous_batches
    ):
        raise HTTPException(409, "请先完成上一批推荐")
    if current:
        claimed = await session.execute(
            update(TalkCoachBatch)
            .where(
                TalkCoachBatch.id == current["id"],
                TalkCoachBatch.status.in_(("failed", "interrupted")),
            )
            .values(status="running", error=None, updated_at=datetime.now(UTC))
        )
        await session.commit()
        if not claimed.rowcount:
            return next(
                b
                for b in (await read_batches(session, [turn_id]))[turn_id]
                if b["batch_index"] == body.batch_index
            )
        batch = await session.get(TalkCoachBatch, current["id"])
    else:
        batch = TalkCoachBatch(
            turn_id=turn_id,
            batch_index=body.batch_index,
            saved_replies=[],
            status="running",
            updated_at=datetime.now(UTC),
        )
        session.add(batch)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        return next(
            b
            for b in (await read_batches(session, [turn_id]))[turn_id]
            if b["batch_index"] == body.batch_index
        )
    batch_id = batch.id
    talk = await session.get(TalkSession, session_id)
    scenario = await get_scenario_merged(session, talk.scenario_key) if talk.scenario_key else None
    history = list(
        (
            await session.scalars(
                select(TalkTurn)
                .where(TalkTurn.session_id == session_id, TalkTurn.ordinal <= turn.ordinal)
                .order_by(TalkTurn.ordinal.desc())
                .limit(13)
            )
        ).all()
    )
    context = [{"role": t.role, "text": t.text} for t in reversed(history)]
    previous = [r["en"] for b in previous_batches for r in b["result"]["replies"]]
    fingerprint = content_key(
        json.dumps(
            {
                "owner": owner.id,
                "session": session_id,
                "turn": turn.id,
                "batch": body.batch_index,
                "history": context,
                "difficulty": talk.difficulty,
                "scenario": scenario,
                "previous": previous,
                "version": 1,
            },
            ensure_ascii=False,
            sort_keys=True,
        )
    )
    address = dict(
        scope="sentence",
        content_hash=content_key(turn.text),
        context_hash=fingerprint,
        kind="talk_coach",
        provider=f"llm:{CHAT_ALIAS}",
    )
    try:
        analysis = await get_cached(session, **address)
        if analysis is None:
            await session.commit()
            metadata: dict = {}
            with invocation_context(source="talk.coach", talk_session_id=session_id):
                async with asyncio.timeout(90):
                    result = await coach_message(
                        turn.text,
                        talk.difficulty,
                        scenario,
                        variant=body.batch_index,
                        previous_replies=previous,
                        history=context,
                        metadata=metadata,
                    )
            analysis = await save_result(session, **address, result=result, **metadata)
        batch.analysis_id, batch.status = analysis.id, "ready"
    except (LLMUnavailable, TimeoutError):
        batch.status, batch.error = "failed", "辅助生成失败，请检查模型服务后重试"
        analysis = None
    except asyncio.CancelledError:
        batch.status, batch.error = "interrupted", "生成中断，请手动重试"
        await session.commit()
        raise
    except Exception:
        logger.exception("对话辅助失败 turn=%s batch=%s", turn_id, body.batch_index)
        await session.rollback()
        batch = await session.get(TalkCoachBatch, batch_id)
        batch.status, batch.error = "failed", "辅助保存失败，请重试"
        analysis = None
    batch.updated_at = datetime.now(UTC)
    await session.commit()
    return batch_payload(batch, analysis)


class SaveExpression(BaseModel):
    saved: bool
    batch_index: int | None = Field(default=None, ge=0, lt=20)
    reply_index: int | None = Field(default=None, ge=0, lt=3)
    text: str | None = Field(default=None, min_length=1, max_length=10000)


@router.put("/{session_id}/turns/{turn_id}/saved")
async def save_expression(
    session_id: int,
    turn_id: int,
    body: SaveExpression,
    session: SessionDep,
    owner: CurrentOwner,
):
    turn = await owned_turn(session, session_id, turn_id, owner)
    if body.batch_index is None and body.reply_index is None:
        if body.text is None:
            turn.saved = body.saved
        else:
            if body.text not in turn.text:
                raise HTTPException(422, "收藏内容不属于这条消息")
            values = list(turn.saved_texts)
            if body.saved and body.text not in values:
                values.append(body.text)
            if not body.saved:
                values = [value for value in values if value != body.text]
            turn.saved_texts = values
    elif body.batch_index is not None and body.reply_index is not None:
        batch = await session.scalar(
            select(TalkCoachBatch).where(
                TalkCoachBatch.turn_id == turn_id,
                TalkCoachBatch.batch_index == body.batch_index,
                TalkCoachBatch.status == "ready",
            )
        )
        if batch is None:
            raise HTTPException(404, "batch not found")
        values = set(batch.saved_replies)
        if body.saved:
            values.add(body.reply_index)
        else:
            values.discard(body.reply_index)
        batch.saved_replies = sorted(values)
    else:
        raise HTTPException(422, "批次与回答序号必须同时提供")
    await session.commit()
    return {"saved": body.saved}


@router.delete("/{session_id}")
async def delete_session(session_id: int, session: SessionDep, owner: CurrentOwner):
    talk = await owned_session(session, session_id, owner)
    if talk.ended_at is None:
        raise HTTPException(409, "请先结束会话")
    turns = select(TalkTurn.id).where(TalkTurn.session_id == session_id)
    if await session.scalar(
        select(TalkCoachBatch.id)
        .where(TalkCoachBatch.turn_id.in_(turns), TalkCoachBatch.status == "running")
        .limit(1)
    ):
        raise HTTPException(409, "辅助内容仍在保存，请完成后再删除")
    analysis_ids = list(
        (
            await session.scalars(
                select(TalkCoachBatch.analysis_id).where(
                    TalkCoachBatch.turn_id.in_(turns), TalkCoachBatch.analysis_id.is_not(None)
                )
            )
        ).all()
    )
    await session.execute(delete(TalkCoachBatch).where(TalkCoachBatch.turn_id.in_(turns)))
    await session.execute(delete(TalkTurn).where(TalkTurn.session_id == session_id))
    await session.delete(talk)
    if analysis_ids:
        await session.execute(delete(AnalysisResult).where(AnalysisResult.id.in_(analysis_ids)))
    await session.commit()
    return {"deleted": True}
