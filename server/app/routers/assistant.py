"""语音助理 API（CR-007 模块 20）。

一轮 = 一段录音（或一句文字）→ 转写 → 代理 → 一句要念的话 + 动作 + 待确认。
会话存成 mode=assistant 的 TalkSession；待确认的动作由 ``/assistant/approve`` 兑现——
发邮件走模块 18 那个带 confirm 的端点，审计与它同源。
"""

from __future__ import annotations

import tempfile
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy import func, select

from app.config import get_settings
from app.db import SessionFactory
from app.owner import OWNER_ID, CurrentOwner
from app.routers.dict import SessionDep
from app.routers.google import SendBody, send_mail
from domain import assistant, briefing, extensions
from domain.credentials import get_binding
from domain.model_invocations import ModelInvocationSpan, invocation_context
from domain.model_runtime import ModelRuntimeError, prepare_chat_route
from domain.models import TalkSession, TalkTurn
from domain.transcribe import transcribe_audio_logged

router = APIRouter(prefix="/assistant", tags=["assistant"])

HISTORY_TURNS = 10


@asynccontextmanager
async def detached_session():
    """代理工具各自开 session（不复用请求那个：工具在代理循环里并发、各自提交）。
    测试的 conftest 会把这个名字接管到内存库，别在工具里直接引 SessionFactory。"""
    async with SessionFactory() as s:
        yield s


AUDIO_SUFFIX = {
    "audio/webm": ".webm",
    "audio/ogg": ".ogg",
    "audio/mp4": ".mp4",
    "audio/x-m4a": ".m4a",
    "audio/wav": ".wav",
}


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


async def _transcribe_upload(session, audio: UploadFile) -> str:
    content_type = (audio.content_type or "").split(";")[0].strip().lower()
    suffix = AUDIO_SUFFIX.get(content_type, Path(audio.filename or "").suffix or ".webm")
    data = await audio.read()
    if not data:
        raise HTTPException(status_code=400, detail="没有收到录音")
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(data)
        path = Path(tmp.name)
    try:
        text = await transcribe_audio_logged(
            str(path), get_settings().whisper_model, capability="assistant.asr", session=session
        )
    finally:
        path.unlink(missing_ok=True)
    text = " ".join(text.split())
    if not text:
        raise HTTPException(status_code=400, detail="没听清，再说一遍")
    return text


async def _resolve_capability(session) -> str:
    if await get_binding(session, assistant.DEFAULT_CAPABILITY) is not None:
        return assistant.DEFAULT_CAPABILITY
    return assistant.FALLBACK_CAPABILITY


async def _load_session(session, session_id: int | None) -> TalkSession:
    if session_id is not None:
        talk = await session.get(TalkSession, session_id)
        if talk is None or talk.mode != "assistant":
            raise HTTPException(status_code=404, detail="助理会话不存在")
        return talk
    talk = TalkSession(mode="assistant", user_id=OWNER_ID, difficulty="medium")
    session.add(talk)
    await session.flush()
    return talk


async def _history(session, talk: TalkSession) -> list[tuple[str, str]]:
    rows = (
        await session.execute(
            select(TalkTurn)
            .where(TalkTurn.session_id == talk.id)
            .order_by(TalkTurn.ordinal.desc())
            .limit(HISTORY_TURNS)
        )
    ).scalars()
    turns = [(row.role, row.text) for row in rows]
    turns.reverse()
    return turns


def _turn_view(row: TalkTurn) -> dict:
    extra = row.feedback or {}
    return {
        "id": row.id,
        "ordinal": row.ordinal,
        "role": row.role,
        "text": row.text,
        "actions": extra.get("actions", []),
        "pending": extra.get("pending", []),
        "at": _iso(row.created_at) if hasattr(row, "created_at") else None,
    }


async def take_turn(
    session, spoken: str, session_id: int | None, route: str, selection: str
) -> dict:
    """一轮的公共部分：解析能力 → 存用户回合 → 跑代理 → 存助理回合。HTTP 与常听 WebSocket 共用。"""
    capability = await _resolve_capability(session)
    try:
        prepared = await prepare_chat_route(capability, "chat.complete")
    except ModelRuntimeError as exc:
        span = await ModelInvocationSpan(
            plugin_id="unresolved",
            operation="chat.complete",
            model=capability,
            capability=capability,
            request={"source": "assistant", "text": spoken[:200]},
        ).start()
        await span.fail(exc)
        raise HTTPException(
            status_code=503,
            detail="助理还没有模型：到设置 · 模型服务把「语音助理」绑到一个模型",
        ) from exc

    talk = await _load_session(session, session_id)
    history = await _history(session, talk)
    ordinal = int(
        await session.scalar(select(func.count()).where(TalkTurn.session_id == talk.id)) or 0
    )
    session.add(TalkTurn(session_id=talk.id, ordinal=ordinal + 1, role="user", text=spoken))
    await session.commit()

    deps = assistant.AssistantDeps(
        session_factory=detached_session,
        route=route,
        selection=selection,
    )
    toolsets = await extensions.mcp_toolsets(session)
    with invocation_context(source="assistant", subject_type="talk_session", subject_id=talk.id):
        try:
            reply = await assistant.run_turn(
                assistant.model_for(capability, prepared),
                deps,
                spoken,
                history=history,
                toolsets=toolsets,
            )
        except Exception as exc:  # noqa: BLE001 - 上游模型的各种失败统一成 502，原因原样带回
            detail = f"助理没答上来：{type(exc).__name__}: {exc}"[:300]
            raise HTTPException(status_code=502, detail=detail) from exc

    session.add(
        TalkTurn(
            session_id=talk.id,
            ordinal=ordinal + 2,
            role="assistant",
            text=reply.text,
            feedback={"actions": reply.actions, "pending": reply.pending, "capability": capability},
        )
    )
    await session.commit()
    return {
        "session_id": talk.id,
        "transcript": spoken,
        "reply": reply.text,
        "actions": reply.actions,
        "pending": reply.pending,
        "capability": capability,
    }


@router.post("/turn")
async def assistant_turn(
    session: SessionDep,
    owner: CurrentOwner,
    text: Annotated[str | None, Form()] = None,
    session_id: Annotated[int | None, Form()] = None,
    route: Annotated[str, Form()] = "/",
    selection: Annotated[str, Form()] = "",
    audio: UploadFile | None = None,
) -> dict:
    spoken = (text or "").strip()
    if audio is not None and not spoken:
        spoken = await _transcribe_upload(session, audio)
    if not spoken:
        raise HTTPException(status_code=400, detail="说点什么，或者打字")
    return await take_turn(session, spoken, session_id, route, selection)


@router.get("/sessions")
async def list_sessions(session: SessionDep, limit: int = 5) -> list[dict]:
    talks = list(
        (
            await session.execute(
                select(TalkSession)
                .where(TalkSession.mode == "assistant")
                .order_by(TalkSession.started_at.desc())
                .limit(max(1, min(limit, 20)))
            )
        ).scalars()
    )
    out: list[dict] = []
    for talk in talks:
        turns = (
            await session.execute(
                select(TalkTurn).where(TalkTurn.session_id == talk.id).order_by(TalkTurn.ordinal)
            )
        ).scalars()
        out.append(
            {
                "id": talk.id,
                "started_at": _iso(talk.started_at),
                "turns": [_turn_view(t) for t in turns],
            }
        )
    return out


class ApproveBody(BaseModel):
    type: str
    payload: dict[str, Any]


@router.post("/approve")
async def approve(body: ApproveBody, session: SessionDep) -> dict:
    """兑现待确认动作。发邮件走模块 18 那个端点：同一处 confirm、同一处审计。"""
    if body.type == "send_mail":
        try:
            send = SendBody(**body.payload, confirm=True)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=f"待确认动作缺字段：{exc}") from exc
        sent = await send_mail(send, session)
        return {"ok": True, "type": body.type, "result": sent}
    raise HTTPException(status_code=400, detail=f"不认识的待确认动作：{body.type}")


@router.get("/tools")
async def tools() -> list[dict]:
    return [{"name": n, "group": g, "description": d} for n, g, d in assistant.TOOL_CATALOG]


# ---- 例程（表在模块 22，这里保留助理页用的三个入口） ----


@router.get("/routines")
async def list_routines(session: SessionDep) -> list[dict]:
    from app.routers.extensions import _routine_rows

    return await _routine_rows(session)


@router.post("/routines/{key}/run")
async def run_routine(key: str, session: SessionDep) -> dict:
    from app.routers.extensions import run_routine_now

    return await run_routine_now(key, session)


@router.get("/brief/today")
async def brief_today(session: SessionDep) -> dict:
    row = await briefing.latest_run(session, briefing.MORNING_BRIEF, today_only=True)
    if row is None:
        return {"brief": None}
    return {"brief": {"text": row.text, "payload": row.payload, "at": _iso(row.created_at)}}
