"""AI 陪读接口：一篇文章一个陪读会话，基于文章上下文的流式问答（M5-B2）。

不建新表：会话复用 TalkSession(mode="companion", scenario_key=None)，
article_id 暂存在 session.summary JSONB（{"article_id": N}，陪读会话不产出
练习总结，该字段空闲可安全借用）；问答回合按 ordinal 落 TalkTurn。

注意：本路由尚未挂载到 app/main.py（该文件由主协调方维护），需在 main.py 加
`app.include_router(companion_router)` 后生效。
"""

import json
from collections.abc import AsyncGenerator

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.owner import CurrentOwner
from app.routers.dict import SessionDep
from domain.companion import (
    COMPANION_ALIAS,
    HISTORY_TURNS,
    build_companion_context,
    build_companion_system_prompt,
)
from domain.llm import LLMUnavailable, stream_text
from domain.models import Article, TalkSession, TalkTurn

router = APIRouter(prefix="/companion", tags=["companion"])

SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _session_payload(talk: TalkSession) -> dict:
    return {
        "id": talk.id,
        "article_id": (talk.summary or {}).get("article_id"),
        "mode": talk.mode,
        "started_at": talk.started_at.isoformat() if talk.started_at else None,
        "ended_at": talk.ended_at.isoformat() if talk.ended_at else None,
    }


def _turn_payload(turn: TalkTurn) -> dict:
    return {
        "id": turn.id,
        "ordinal": turn.ordinal,
        "role": turn.role,
        "text": turn.text,
        "created_at": turn.created_at.isoformat() if turn.created_at else None,
    }


async def _find_article_session(
    session: AsyncSession, user_id: str, article_id: int
) -> TalkSession | None:
    """一文一会话：找该文章已有的陪读会话。summary 为 JSONB，跨方言起见在
    Python 侧过滤（陪读会话量级很小，全量扫无压力）。"""
    rows = (
        await session.execute(
            select(TalkSession)
            .where(
                TalkSession.user_id == user_id,
                TalkSession.mode == "companion",
                TalkSession.ended_at.is_(None),
            )
            .order_by(TalkSession.started_at.desc(), TalkSession.id.desc())
        )
    ).scalars()
    for talk in rows:
        if (talk.summary or {}).get("article_id") == article_id:
            return talk
    return None


async def _load_companion_session(
    session: AsyncSession, user_id: str, session_id: int
) -> TalkSession:
    talk = (
        await session.execute(
            select(TalkSession).where(
                TalkSession.id == session_id, TalkSession.user_id == user_id
            )
        )
    ).scalar_one_or_none()
    if talk is None or talk.mode != "companion":
        raise HTTPException(status_code=404, detail="陪读会话不存在")
    return talk


class CompanionSessionCreate(BaseModel):
    article_id: int


@router.post("/sessions", status_code=201)
async def create_companion_session(
    body: CompanionSessionCreate, owner: CurrentOwner, session: SessionDep
) -> dict:
    article = await session.get(Article, body.article_id)
    if article is None:
        raise HTTPException(status_code=404, detail="article not found")
    existing = await _find_article_session(session, owner.id, body.article_id)
    if existing is not None:  # 一文一会话：已有会话直接复用
        return {**_session_payload(existing), "article_title": article.title, "reused": True}
    talk = TalkSession(
        user_id=owner.id,
        mode="companion",
        scenario_key=None,
        summary={"article_id": body.article_id},
    )
    session.add(talk)
    await session.commit()
    return {**_session_payload(talk), "article_title": article.title, "reused": False}


@router.get("/sessions")
async def list_companion_sessions(
    owner: CurrentOwner, session: SessionDep, article_id: int | None = None
) -> list[dict]:
    """陪读会话列表；带 article_id 时用于查找该文章的已有会话。"""
    stmt = (
        select(TalkSession, func.count(TalkTurn.id))
        .outerjoin(TalkTurn, TalkTurn.session_id == TalkSession.id)
        .where(TalkSession.user_id == owner.id, TalkSession.mode == "companion")
        .group_by(TalkSession.id)
        .order_by(TalkSession.started_at.desc(), TalkSession.id.desc())
    )
    rows = (await session.execute(stmt)).all()
    payloads = [
        {**_session_payload(talk), "turn_count": count} for talk, count in rows
    ]
    if article_id is not None:
        payloads = [p for p in payloads if p["article_id"] == article_id]
    return payloads


@router.get("/sessions/{session_id}")
async def companion_session_detail(
    session_id: int, owner: CurrentOwner, session: SessionDep
) -> dict:
    talk = await _load_companion_session(session, owner.id, session_id)
    turns = (
        await session.execute(
            select(TalkTurn).where(TalkTurn.session_id == session_id).order_by(TalkTurn.ordinal)
        )
    ).scalars()
    return {**_session_payload(talk), "turns": [_turn_payload(t) for t in turns]}


class AskBody(BaseModel):
    question: str
    paragraph_ordinal: int | None = None


@router.post("/sessions/{session_id}/ask", response_model=None)
async def companion_ask(
    session_id: int, body: AskBody, owner: CurrentOwner, session: SessionDep
) -> StreamingResponse:
    """SSE 流式回答：delta 逐块吐正文，done 带全文与落库后的回合。"""
    question = body.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="question 不能为空")
    talk = await _load_companion_session(session, owner.id, session_id)
    if talk.ended_at is not None:
        raise HTTPException(status_code=409, detail="会话已结束")
    article_id = (talk.summary or {}).get("article_id")
    ctx = await build_companion_context(session, article_id, body.paragraph_ordinal)
    if ctx is None:
        raise HTTPException(status_code=404, detail="陪读文章已不存在")

    history = list(
        (
            await session.execute(
                select(TalkTurn)
                .where(TalkTurn.session_id == session_id)
                .order_by(TalkTurn.ordinal.desc())
                .limit(HISTORY_TURNS)
            )
        ).scalars()
    )[::-1]  # 取最近 8 轮（16 条），再翻回时间正序
    messages = [
        {
            "role": "system",
            "content": build_companion_system_prompt(
                ctx["title"], ctx["content"], ctx["truncated"]
            ),
        },
        *({"role": t.role, "content": t.text} for t in history),
        {"role": "user", "content": question},
    ]

    async def gen() -> AsyncGenerator[str, None]:
        answer = ""
        model = COMPANION_ALIAS
        try:
            async for ev in stream_text(COMPANION_ALIAS, messages):
                if ev["type"] == "delta":
                    yield _sse("delta", {"text": ev["text"]})
                else:
                    answer, model = ev["text"], ev["model"]
        except LLMUnavailable:
            yield _sse("error", {"message": "LLM 网关未配置或不可用"})
            return
        next_ordinal = (
            await session.execute(
                select(func.coalesce(func.max(TalkTurn.ordinal), -1)).where(
                    TalkTurn.session_id == session_id
                )
            )
        ).scalar_one() + 1
        user_turn = TalkTurn(
            session_id=session_id, ordinal=next_ordinal, role="user", text=question
        )
        assistant_turn = TalkTurn(
            session_id=session_id, ordinal=next_ordinal + 1, role="assistant", text=answer
        )
        session.add_all([user_turn, assistant_turn])
        await session.commit()
        yield _sse("done", {
            "text": answer,
            "model": model,
            "user_turn": _turn_payload(user_turn),
            "assistant_turn": _turn_payload(assistant_turn),
        })

    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)
