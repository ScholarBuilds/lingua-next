"""场景陪练接口：回合制语音/文字对话 + 会话总结（模块 06）。

实时语音（OpenAI Realtime）需官方 Key，当前仅留桩：/talk/realtime/session。
"""

import json
import uuid
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.owner import CurrentOwner
from app.routers.dict import SessionDep
from app.routers.pronunciation import router as pronunciation_router
from app.routers.talk_records import router as records_router
from domain.llm import LLMUnavailable
from domain.models import TalkSession, TalkTurn, UserScenario
from domain.scenarios import (
    DraftInvalid,
    generate_scenario_draft,
    get_scenario_merged,
    is_builtin_key,
    list_scenarios_merged,
    sanitize_scenario,
    validate_scenario,
)
from domain.talk import (
    chat_turn,
    close_talk_session,
    coach_message,
    stream_chat_turn,
    summarize_session,
)
from domain.transcribe import transcribe_audio_logged

router = APIRouter(prefix="/talk", tags=["talk"])
router.include_router(pronunciation_router)
router.include_router(records_router)
# 场景的创建/修改/删除/AI 草稿是内容管理动作，挂在 admin.access 下（main.py）
admin_router = APIRouter(prefix="/talk", tags=["talk"])


def _owned(talk: TalkSession, owner) -> bool:
    """NULL user_id 是迁移前的遗产行（生产库已回填），测试库里当无主放行。"""
    return talk.user_id is None or talk.user_id == owner.id


MODES = ("voice", "text")
DIFFICULTIES = ("easy", "medium", "hard")
AUDIO_EXTS = {".webm", ".ogg", ".mp4", ".m4a", ".wav"}
MAX_AUDIO_BYTES = 20 * 1024 * 1024  # 回合制录音都很短，20MB 足够


def _tts_url(text: str) -> str:
    return f"/tts?text={quote(text)}"


def _turn_payload(turn: TalkTurn) -> dict:
    return {
        "id": turn.id,
        "ordinal": turn.ordinal,
        "role": turn.role,
        "text": turn.text,
        "feedback": turn.feedback,
        "audio_key": turn.audio_key,
        "tts_url": _tts_url(turn.text) if turn.role == "assistant" else None,
    }


def _session_payload(talk: TalkSession, scenario: dict | None = None) -> dict:
    return {
        "id": talk.id,
        "mode": talk.mode,
        "scenario_key": talk.scenario_key,
        "scenario_title": scenario["title"] if scenario else None,
        "difficulty": talk.difficulty,
        "started_at": talk.started_at.isoformat() if talk.started_at else None,
        "ended_at": talk.ended_at.isoformat() if talk.ended_at else None,
    }


async def _load_turns(session: AsyncSession, session_id: int) -> list[TalkTurn]:
    rows = await session.execute(
        select(TalkTurn).where(TalkTurn.session_id == session_id).order_by(TalkTurn.ordinal)
    )
    return list(rows.scalars())


async def _get_active_session(session: AsyncSession, session_id: int, owner) -> TalkSession:
    talk = await session.get(TalkSession, session_id)
    if talk is None or not _owned(talk, owner):
        raise HTTPException(status_code=404, detail="session not found")
    if talk.ended_at is not None:
        raise HTTPException(status_code=409, detail="会话已结束，无法继续对话")
    return talk


async def _resolve_scenario(session: AsyncSession, key: str | None) -> dict | None:
    return await get_scenario_merged(session, key) if key else None


@router.get("/scenarios")
async def scenarios(session: SessionDep) -> list[dict]:
    return await list_scenarios_merged(session)


class SessionCreate(BaseModel):
    mode: str = "text"
    scenario_key: str | None = None
    difficulty: str = "medium"


@router.post("/sessions", status_code=201)
async def create_session(body: SessionCreate, session: SessionDep, owner: CurrentOwner) -> dict:
    if body.mode not in MODES:
        raise HTTPException(status_code=400, detail=f"mode 仅支持 {'/'.join(MODES)}")
    if body.difficulty not in DIFFICULTIES:
        raise HTTPException(status_code=400, detail=f"difficulty 仅支持 {'/'.join(DIFFICULTIES)}")
    scenario = None
    if body.scenario_key:
        scenario = await get_scenario_merged(session, body.scenario_key)
        if scenario is None:
            raise HTTPException(status_code=404, detail="scenario not found")
    talk = TalkSession(
        mode=body.mode,
        scenario_key=body.scenario_key,
        difficulty=body.difficulty,
        user_id=owner.id,
    )
    session.add(talk)
    await session.flush()
    turns: list[TalkTurn] = []
    if scenario:  # AI 开场白作为回合 0，前端拿 tts_url 直接播
        opening = TalkTurn(
            session_id=talk.id, ordinal=0, role="assistant", text=scenario["opening_line"]
        )
        session.add(opening)
        turns.append(opening)
    await session.commit()
    return {
        **_session_payload(talk, scenario),
        "scenario": scenario,
        "turns": [_turn_payload(t) for t in turns],
    }


async def _run_turn(
    session: AsyncSession, talk: TalkSession, user_text: str, audio_key: str | None = None
) -> dict:
    turns = await _load_turns(session, talk.id)
    scenario = await _resolve_scenario(session, talk.scenario_key)
    try:
        reply, feedback = await chat_turn(talk, turns, user_text, scenario=scenario)
    except LLMUnavailable as exc:
        raise HTTPException(status_code=503, detail="LLM 网关未配置或不可用") from exc
    return await _save_turn(session, talk, turns, user_text, reply, feedback, audio_key)


async def _save_turn(session, talk, turns, user_text, reply, feedback, audio_key=None):
    ordinal = turns[-1].ordinal + 1 if turns else 0
    user_turn = TalkTurn(
        session_id=talk.id,
        ordinal=ordinal,
        role="user",
        text=user_text,
        feedback=feedback,
        audio_key=audio_key,
    )
    assistant_turn = TalkTurn(session_id=talk.id, ordinal=ordinal + 1, role="assistant", text=reply)
    session.add_all([user_turn, assistant_turn])
    try:
        await session.commit()
    except IntegrityError as exc:  # 同会话并发提交撞 ordinal 唯一约束
        raise HTTPException(status_code=409, detail="回合提交冲突，请重试") from exc
    return {
        "user_turn": _turn_payload(user_turn),
        "assistant_turn": _turn_payload(assistant_turn),
    }


class TextTurnBody(BaseModel):
    text: str = Field(min_length=1, max_length=10000)


def _stream_turn_response(session, talk, user_text, audio_key=None):
    async def events():
        turns = await _load_turns(session, talk.id)
        scenario = await _resolve_scenario(session, talk.scenario_key)
        try:
            async for event in stream_chat_turn(talk, turns, user_text, scenario):
                if event["type"] == "result":
                    pair = await _save_turn(
                        session,
                        talk,
                        turns,
                        user_text,
                        event["reply"],
                        event["feedback"],
                        audio_key,
                    )
                    event = {"type": "done", **pair, "transcript": user_text}
                yield json.dumps(event, ensure_ascii=False) + "\n"
        except (LLMUnavailable, HTTPException) as exc:
            await session.rollback()
            detail = exc.detail if isinstance(exc, HTTPException) else "对话生成中断，请重试"
            yield json.dumps({"type": "error", "detail": detail}, ensure_ascii=False) + "\n"

    return StreamingResponse(
        events(), media_type="application/x-ndjson", headers={"X-Accel-Buffering": "no"}
    )


class CoachBody(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    variant: int = Field(default=0, ge=0, le=19)
    previous_replies: list[str] = Field(default_factory=list, max_length=57)


@router.post("/sessions/{session_id}/turns/text", response_model=None)
async def create_text_turn(
    session_id: int,
    body: TextTurnBody,
    session: SessionDep,
    owner: CurrentOwner,
    stream: bool = False,
):
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="empty text")
    talk = await _get_active_session(session, session_id, owner)
    if stream:
        return _stream_turn_response(session, talk, text)
    return await _run_turn(session, talk, text)


@router.post("/sessions/{session_id}/coach")
async def create_coach_response(
    session_id: int, body: CoachBody, session: SessionDep, owner: CurrentOwner
) -> dict:
    talk = await session.get(TalkSession, session_id)
    if talk is None or not _owned(talk, owner):
        raise HTTPException(status_code=404, detail="session not found")
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="对话内容不能为空")
    scenario = await _resolve_scenario(session, talk.scenario_key)
    try:
        if any(len(reply) > 1000 for reply in body.previous_replies):
            raise HTTPException(status_code=422, detail="推荐回答超出长度限制")
        return await coach_message(
            text,
            talk.difficulty,
            scenario,
            variant=body.variant,
            previous_replies=body.previous_replies,
        )
    except LLMUnavailable as exc:
        raise HTTPException(status_code=503, detail="对话辅助模型未配置或不可用") from exc


@router.post("/sessions/{session_id}/turns/audio", response_model=None)
async def create_audio_turn(
    session_id: int,
    file: UploadFile,
    session: SessionDep,
    owner: CurrentOwner,
    stream: bool = False,
):
    talk = await _get_active_session(session, session_id, owner)
    ext = Path(file.filename or "").suffix.lower()
    if ext not in AUDIO_EXTS:
        raise HTTPException(status_code=400, detail="仅支持 webm/ogg/mp4/m4a/wav 音频")
    data = await file.read()
    if len(data) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=400, detail="音频超过 20MB 上限")
    settings = get_settings()
    audio_key = f"talk/{session_id}-{uuid.uuid4().hex[:12]}{ext}"
    dest = Path(settings.media_root) / audio_key
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    try:
        # 回合录音很短，同步转写放线程池即可，不必过队列
        transcript = await transcribe_audio_logged(
            str(dest),
            settings.whisper_model,
            capability="talk.turn.asr",
            session=session,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail="音频转写失败") from exc
    if not transcript:
        raise HTTPException(status_code=422, detail="未识别到语音内容，请重新录制")
    if stream:
        return _stream_turn_response(session, talk, transcript, audio_key)
    result = await _run_turn(session, talk, transcript, audio_key=audio_key)
    return {"transcript": transcript, **result}


@router.post("/sessions/{session_id}/end")
async def end_session(session_id: int, session: SessionDep, owner: CurrentOwner) -> dict:
    talk = await session.get(TalkSession, session_id)
    if talk is None or not _owned(talk, owner):
        raise HTTPException(status_code=404, detail="session not found")
    from app.routers.realtime import _active_ws

    if session_id in _active_ws:
        raise HTTPException(409, "请先结束实时连接")
    if talk.ended_at is not None and talk.summary and "done_well" in talk.summary:
        return {"id": talk.id, "ended_at": talk.ended_at.isoformat(), "summary": talk.summary}
    await close_talk_session(session, talk)
    turns = await _load_turns(session, session_id)
    if any(t.role == "user" for t in turns):
        scenario = await _resolve_scenario(session, talk.scenario_key)
        try:
            summary = await summarize_session(talk, turns, scenario=scenario)
        except LLMUnavailable as exc:
            raise HTTPException(status_code=503, detail="LLM 网关未配置或不可用") from exc
    else:  # 用户没说过话，无可总结
        summary = {"done_well": [], "suggestions": [], "key_phrases": []}
    talk.summary = {**(talk.summary or {}), **summary}
    await session.commit()
    return {"id": talk.id, "ended_at": talk.ended_at.isoformat(), "summary": summary}


@router.get("/sessions")
async def list_sessions(session: SessionDep, owner: CurrentOwner) -> list[dict]:
    from sqlalchemy import or_

    by_key = {s["key"]: s for s in await list_scenarios_merged(session)}
    stmt = (
        select(TalkSession, func.count(TalkTurn.id))
        .outerjoin(TalkTurn, TalkTurn.session_id == TalkSession.id)
        .where(or_(TalkSession.user_id == owner.id, TalkSession.user_id.is_(None)))
        # 语音助理的会话（mode=assistant）另有自己的页面，不混进对话历史
        .where(TalkSession.mode != "assistant")
        .group_by(TalkSession.id)
        .order_by(TalkSession.started_at.desc(), TalkSession.id.desc())
    )
    return [
        {**_session_payload(talk, by_key.get(talk.scenario_key or "")), "turn_count": count}
        for talk, count in (await session.execute(stmt)).all()
    ]


@router.get("/sessions/{session_id}")
async def session_detail(session_id: int, session: SessionDep, owner: CurrentOwner) -> dict:
    talk = await session.get(TalkSession, session_id)
    if talk is None or not _owned(talk, owner):
        raise HTTPException(status_code=404, detail="session not found")
    turns = await _load_turns(session, session_id)
    scenario = await _resolve_scenario(session, talk.scenario_key)
    return {
        **_session_payload(talk, scenario),
        "scenario": scenario,
        "summary": talk.summary,
        "turns": [_turn_payload(t) for t in turns],
    }


class ScenarioBody(BaseModel):
    data: dict


async def _get_user_scenario(session: AsyncSession, key: str) -> UserScenario | None:
    stmt = select(UserScenario).where(UserScenario.key == key).limit(1)
    return (await session.execute(stmt)).scalar_one_or_none()


def _scenario_response(row: UserScenario) -> dict:
    return {**row.data, "key": row.key, "is_builtin": False}


@admin_router.post("/scenarios", status_code=201)
async def create_scenario(body: ScenarioBody, session: SessionDep) -> dict:
    errors = validate_scenario(body.data)
    if errors:
        raise HTTPException(status_code=400, detail="；".join(errors))
    key = str(body.data["key"])
    if is_builtin_key(key):
        raise HTTPException(status_code=409, detail="key 与内置场景冲突，请换一个 key")
    if await _get_user_scenario(session, key) is not None:
        raise HTTPException(status_code=409, detail="场景已存在，请用 PUT 更新")
    row = UserScenario(key=key, data=sanitize_scenario(body.data))
    session.add(row)
    await session.commit()
    return _scenario_response(row)


@admin_router.put("/scenarios/{key}")
async def update_scenario(key: str, body: ScenarioBody, session: SessionDep) -> dict:
    if is_builtin_key(key):
        raise HTTPException(status_code=409, detail="内置场景不可修改，请另存为新场景")
    row = await _get_user_scenario(session, key)
    if row is None:
        raise HTTPException(status_code=404, detail="scenario not found")
    data = {**body.data, "key": key}  # key 以路径为准，body 里的 key 忽略
    errors = validate_scenario(data)
    if errors:
        raise HTTPException(status_code=400, detail="；".join(errors))
    row.data = sanitize_scenario(data)
    await session.commit()
    return _scenario_response(row)


@admin_router.delete("/scenarios/{key}")
async def delete_scenario(key: str, session: SessionDep) -> dict:
    if is_builtin_key(key):
        raise HTTPException(status_code=409, detail="内置场景不可删除")
    row = await _get_user_scenario(session, key)
    if row is None:
        raise HTTPException(status_code=404, detail="scenario not found")
    await session.delete(row)
    await session.commit()
    return {"ok": True}


class DraftBody(BaseModel):
    idea: str
    level: str | None = None


@admin_router.post("/scenarios/draft")
async def draft_scenario(body: DraftBody) -> dict:
    idea = body.idea.strip()
    if not idea:
        raise HTTPException(status_code=400, detail="idea 不能为空")
    try:
        return await generate_scenario_draft(idea, body.level)
    except LLMUnavailable as exc:
        raise HTTPException(status_code=503, detail="LLM 网关未配置或不可用") from exc
    except DraftInvalid as exc:
        raise HTTPException(status_code=502, detail=f"草稿生成不完整：{exc}") from exc


@router.post("/realtime/session")
async def realtime_session() -> dict:
    """旧桩已废弃：实时语音走火山豆包中继，见 app/routers/realtime.py。"""
    raise HTTPException(
        status_code=410,
        detail="实时语音已迁移：POST /talk/realtime/sessions 建会话后连 ws_path",
    )
