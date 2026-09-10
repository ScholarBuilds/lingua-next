"""火山豆包端到端实时语音中继（模块 06）。

浏览器 ⇆ api ⇆ 火山，凭证不出服务端。浏览器侧协议：
- 上行二进制帧 = PCM 16k 单声道 int16 音频块；文本帧 {"type": "end"} 主动结束，
  {"type": "ask", "text": "<引用句 + 用户问题>"} = 用户提问（经 ChatTextQuery 注入火山）
  {"type": "context", ...} = 同上，旧客户端别名
- 下行二进制帧 = 火山 TTS 音频（PCM 24k float32 小端）原样转发
- 下行 JSON 帧：{"type": "asr"|"reply"|"user_start"|"asr_end"|"reply_end"|
  "tts_end"|"opening"|"started"|"finished"|"error", ...}
完整文本逐轮写入 talk_turn；turn_saved 确认持久化，save_error 表示待补存。
"""

import asyncio
import contextlib
import json
import logging
import time
import uuid
from collections.abc import Callable
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, WebSocket
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import func, select

from app.config import get_settings
from app.db import SessionFactory
from app.owner import OWNER_ID, CurrentOwner
from app.routers.dict import SessionDep
from domain.asr_segments import UtteranceCollector
from domain.companion import (
    build_companion_context,
    build_companion_realtime_role,
    build_video_companion_context,
    build_video_companion_realtime_role,
)
from domain.credentials import CredentialError
from domain.grammar_voice import GrammarVoiceContext, grammar_voice_role
from domain.model_invocations import invocation_context
from domain.models import Article, TalkSession, TalkTurn, Video
from domain.scenarios import get_scenario
from domain.talk import build_system_prompt, close_talk_session
from domain.volc_realtime import (
    EVENT_ASR_ENDED,
    EVENT_ASR_INFO,
    EVENT_ASR_RESPONSE,
    EVENT_CHAT_ENDED,
    EVENT_CHAT_RESPONSE,
    EVENT_SESSION_FAILED,
    EVENT_SESSION_FINISHED,
    EVENT_TTS_ENDED,
    RealtimeSessionClient,
    VolcRealtimeError,
    build_session_config,
    extract_asr_text,
    resolve_realtime_route,
)

logger = logging.getLogger(__name__)
# uvicorn 默认只配置自家 logger，应用模块 INFO 级日志会被吞掉；
# 点句注入等转发路径日志需要可见，故本模块自带 handler
if not logger.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(levelname)s:     [realtime] %(message)s"))
    logger.addHandler(_handler)
    logger.setLevel(logging.INFO)

router = APIRouter(prefix="/talk/realtime", tags=["talk"])

DIFFICULTIES = ("easy", "medium", "hard")
MAX_SESSION_SECONDS = 30 * 60  # 会话上限 30 分钟
IDLE_SECONDS = 3 * 60  # 浏览器 3 分钟无上行自动结束
DEFAULT_OPENING = "Hi! I'm your English speaking partner. What would you like to talk about?"

_active_ws: set[int] = set()  # 同一会话同时只允许一条中继


class RealtimeSessionCreate(BaseModel):
    grammar_context: GrammarVoiceContext | None = None
    scenario_key: str | None = None
    difficulty: str = "medium"
    article_id: int | None = None  # 语音陪读：注入该文章上下文，实时讨论当前文章
    video_id: int | None = None  # 视频陪读：注入全片字幕与 AI 摘要（FR-34）
    unit_ordinal: int | None = None  # 当前学习句，字幕过长时截断窗口据此定位
    deployment_id: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def validate_grammar_source(self):
        if self.grammar_context is not None and any(
            value is not None
            for value in (self.article_id, self.video_id, self.unit_ordinal, self.scenario_key)
        ):
            raise ValueError("语法答疑不能同时指定其他会话来源")
        return self


@router.post("/sessions", status_code=201)
async def create_realtime_session(
    body: RealtimeSessionCreate, session: SessionDep, owner: CurrentOwner
) -> dict:
    try:  # 显式 deployment 优先；留空则取 realtime-voice 能力绑定
        route = await resolve_realtime_route(session, body.deployment_id)
    except CredentialError as exc:
        raise HTTPException(status_code=503, detail=f"实时语音未配置：{exc}") from exc
    selected_deployment_id = route.snapshot.deployment_id
    if body.difficulty not in DIFFICULTIES:
        raise HTTPException(status_code=400, detail=f"difficulty 仅支持 {'/'.join(DIFFICULTIES)}")
    scenario = None
    if body.scenario_key:
        scenario = get_scenario(body.scenario_key)
        if scenario is None:
            raise HTTPException(status_code=404, detail="scenario not found")
    if body.article_id is not None and await session.get(Article, body.article_id) is None:
        raise HTTPException(status_code=404, detail="article not found")
    if body.video_id is not None and await session.get(Video, body.video_id) is None:
        raise HTTPException(status_code=404, detail="video not found")
    # 不建新表：陪读出处暂存 summary JSONB（realtime 会话总结走回合制接口另存）
    ctx_ref: dict = {}
    if body.grammar_context is not None:
        ctx_ref["grammar_context"] = body.grammar_context.model_dump()
    if body.article_id is not None:
        ctx_ref["article_id"] = body.article_id
    if body.video_id is not None:
        ctx_ref["video_id"] = body.video_id
        if body.unit_ordinal is not None:
            ctx_ref["unit_ordinal"] = body.unit_ordinal
    if selected_deployment_id is not None:
        ctx_ref["deployment_id"] = selected_deployment_id
    talk = TalkSession(
        mode="realtime",
        scenario_key=body.scenario_key,
        difficulty=body.difficulty,
        summary=ctx_ref or None,
        user_id=owner.id,
    )
    session.add(talk)
    await session.commit()
    return {
        "session_id": talk.id,
        "ws_path": f"/talk/realtime/ws/{talk.id}",
        "scenario": scenario,
        "difficulty": talk.difficulty,
        "article_id": body.article_id,
        "video_id": body.video_id,
        "deployment_id": selected_deployment_id,
    }


class _TurnCollector:
    """按回合聚合 ASR/Chat 文本：451 终稿逐条拼接、中间稿只覆盖尾巴，550 增量拼接 AI 回复。"""

    def __init__(self, on_turn: Callable | None = None) -> None:
        self.turns: list[tuple[str, str]] = []  # (role, text)
        self._user = UtteranceCollector()
        self._reply_parts: list[str] = []
        self.user_id = str(uuid.uuid4())
        self.reply_id = str(uuid.uuid4())
        self.on_turn = on_turn

    def append_turn(self, role: str, text: str, message_id: str, complete=True) -> None:
        self.turns.append((role, text))
        if self.on_turn:
            self.on_turn(role, text, message_id, complete)

    def on_asr(self, text: str, interim: bool = False) -> None:
        if interim:
            self._user.on_partial(text)
        else:
            self._user.on_final(text)

    def flush_user(self, complete=True) -> str:
        text = self._user.flush()
        if text:
            self.append_turn("user", text, self.user_id, complete)
            self.user_id = str(uuid.uuid4())
        return text

    def on_reply_delta(self, content: str) -> None:
        if content:
            self._reply_parts.append(content)

    def flush_reply(self, complete=True) -> None:
        text = "".join(self._reply_parts).strip()
        if text:
            self.append_turn("assistant", text, self.reply_id, complete)
            self.reply_id = str(uuid.uuid4())
        self._reply_parts.clear()

    def flush_all(self) -> None:
        self.flush_user(complete=False)
        self.flush_reply(complete=False)


class _TurnWriter:
    def __init__(self, session_id: int, ws: WebSocket, next_ordinal: int = 0):
        self.session_id, self.ws = session_id, ws
        self.next_ordinal = next_ordinal
        self.ordinals: dict[str, int] = {}
        self.queue: asyncio.Queue = asyncio.Queue()
        self.failed: list[tuple] = []
        self.task = asyncio.create_task(self.run())

    def append(self, role, text, message_id, complete):
        if message_id not in self.ordinals:
            self.ordinals[message_id] = self.next_ordinal
            self.next_ordinal += 1
        self.queue.put_nowait(
            (role, text, message_id, complete, self.ordinals[message_id], datetime.now(UTC))
        )

    async def save(self, item):
        role, text, message_id, complete, ordinal, created_at = item
        async with SessionFactory() as db:
            turn = await db.scalar(select(TalkTurn).where(TalkTurn.message_id == message_id))
            if turn is None:
                turn = TalkTurn(
                    session_id=self.session_id,
                    ordinal=ordinal,
                    role=role,
                    text=text,
                    message_id=message_id,
                    complete=complete,
                    created_at=created_at,
                )
                db.add(turn)
                await db.commit()
            await _send_json(
                self.ws,
                {
                    "type": "turn_saved",
                    "message_id": message_id,
                    "turn_id": turn.id,
                    "ordinal": turn.ordinal,
                    "role": role,
                    "text": text,
                    "complete": complete,
                    "created_at": turn.created_at.isoformat(),
                },
            )

    async def run(self):
        while (item := await self.queue.get()) is not None:
            try:
                await self.save(item)
            except Exception:
                logger.exception("实时消息保存失败 session=%s", self.session_id)
                self.failed.append(item)
                await _send_json(
                    self.ws,
                    {
                        "type": "save_error",
                        "message_id": item[2],
                        "message": "部分消息尚未保存，结束时将重试，请保留本页",
                    },
                )

    async def finish(self):
        self.queue.put_nowait(None)
        await self.task
        for item in self.failed:
            try:
                await self.save(item)
            except Exception:
                logger.exception("实时消息重试保存失败 session=%s", self.session_id)
                await _send_json(
                    self.ws,
                    {
                        "type": "save_error",
                        "message_id": item[2],
                        "message": "消息保存失败，可复制本页字幕保留内容",
                    },
                )


async def _persist_turns(session_id: int, turns: list[tuple[str, str]]) -> None:
    if not turns:
        return
    async with SessionFactory() as db:
        next_ordinal = (
            await db.execute(
                select(func.coalesce(func.max(TalkTurn.ordinal), -1)).where(
                    TalkTurn.session_id == session_id
                )
            )
        ).scalar_one() + 1
        for role, text in turns:
            db.add(TalkTurn(session_id=session_id, ordinal=next_ordinal, role=role, text=text))
            next_ordinal += 1
        await db.commit()


async def _load_session(session_id: int) -> TalkSession | None:
    async with SessionFactory() as db:
        return await db.get(TalkSession, session_id)


async def _send_json(ws: WebSocket, payload: dict) -> None:
    with contextlib.suppress(Exception):  # 浏览器可能已断开，发送失败不影响清理
        await ws.send_json(payload)


@router.get("/history")
async def companion_history(
    session: SessionDep,
    owner: CurrentOwner,
    article_id: int | None = None,
    video_id: int | None = None,
    limit: int = 3,
) -> list[dict]:
    """按陪读出处回看历次语音问答（FR-19）。

    陪读出处存在 TalkSession.summary 的 JSONB 里（article_id / video_id），
    这里按出处筛出最近几次会话及其分轨转写。
    """
    if article_id is None and video_id is None:
        raise HTTPException(status_code=400, detail="需指定 article_id 或 video_id")
    key, value = ("article_id", article_id) if article_id is not None else ("video_id", video_id)
    # summary 列是 JSON with_variant(JSONB)，astext 是 JSONB 专有，用通用的类型化比较
    rows = (
        (
            await session.execute(
                select(TalkSession)
                .where(
                    TalkSession.mode == "realtime",
                    TalkSession.summary[key].as_integer() == value,
                    TalkSession.user_id == owner.id,
                )
                .order_by(TalkSession.started_at.desc())
                .limit(max(1, min(limit, 20)))
            )
        )
        .scalars()
        .all()
    )
    out: list[dict] = []
    for talk in rows:
        turns = (
            (
                await session.execute(
                    select(TalkTurn)
                    .where(TalkTurn.session_id == talk.id)
                    .order_by(TalkTurn.ordinal)
                )
            )
            .scalars()
            .all()
        )
        if not turns:
            continue
        out.append(
            {
                "session_id": talk.id,
                "started_at": talk.started_at.isoformat() if talk.started_at else None,
                "ended_at": talk.ended_at.isoformat() if talk.ended_at else None,
                "turns": [{"role": t.role, "text": t.text} for t in turns],
            }
        )
    return out


@router.websocket("/ws/{session_id}")
async def realtime_ws(ws: WebSocket, session_id: int) -> None:
    await ws.accept()
    talk = await _load_session(session_id)
    if talk is None or talk.mode != "realtime":
        await _send_json(ws, {"type": "error", "message": "realtime 会话不存在"})
        await ws.close(code=1008)
        return
    if talk.user_id is not None and talk.user_id != OWNER_ID:
        await _send_json(ws, {"type": "error", "message": "realtime 会话不存在"})
        await ws.close(code=1008)
        return
    if talk.ended_at is not None:
        await _send_json(ws, {"type": "error", "message": "会话已结束"})
        await ws.close(code=1008)
        return
    if session_id in _active_ws:
        await _send_json(ws, {"type": "error", "message": "该会话已有进行中的连接"})
        await ws.close(code=1008)
        return

    ctx_ref = talk.summary or {}
    async with SessionFactory() as db:
        try:
            route = await resolve_realtime_route(db, ctx_ref.get("deployment_id"))
        except CredentialError as exc:
            await _send_json(ws, {"type": "error", "message": f"实时语音未配置：{exc}"})
            await ws.close(code=1008)
            return
    video_id = ctx_ref.get("video_id")
    article_id = ctx_ref.get("article_id")
    if ctx_ref.get("grammar_context") is not None:
        context = GrammarVoiceContext.model_validate(ctx_ref["grammar_context"])
        system_role = grammar_voice_role(context)
        opening = "我们来看看这句，你想问哪一部分？"
    elif video_id is not None:  # 视频陪读：注入全片字幕与摘要替代场景 prompt（FR-34）
        async with SessionFactory() as db:
            ctx = await build_video_companion_context(db, video_id, ctx_ref.get("unit_ordinal"))
        if ctx is None:
            await _send_json(ws, {"type": "error", "message": "该视频还没有可用字幕"})
            await ws.close(code=1008)
            return
        opening = (
            f'Hi! We\'re watching "{ctx["title"]}" together. What would you like to talk about?'
        )
        system_role = build_video_companion_realtime_role(
            ctx["title"], ctx["summary"], ctx["content"], ctx["truncated"]
        )
    elif article_id is not None:  # 语音陪读：注入文章上下文替代场景 prompt
        async with SessionFactory() as db:
            ctx = await build_companion_context(db, article_id)
        if ctx is None:
            await _send_json(ws, {"type": "error", "message": "陪读文章已不存在"})
            await ws.close(code=1008)
            return
        opening = (
            f'Hi! I\'ve been reading "{ctx["title"]}" with you. What would you like to discuss?'
        )
        system_role = build_companion_realtime_role(ctx["title"], ctx["content"], ctx["truncated"])
    else:
        scenario = get_scenario(talk.scenario_key) if talk.scenario_key else None
        opening = scenario["opening_line"] if scenario else DEFAULT_OPENING
        system_role = build_realtime_system_role(scenario, talk.difficulty)

    # 客户端由冻结路由上的 Provider 建，凭据不经过本模块；台账身份同样来自路由快照
    client = route.open_client()
    async with SessionFactory() as db:
        next_ordinal = (
            await db.scalar(
                select(func.coalesce(func.max(TalkTurn.ordinal), -1)).where(
                    TalkTurn.session_id == session_id
                )
            )
        ) + 1
    speaker = route.snapshot.model or None
    speaker_kwargs = {"speaker": speaker} if speaker else {}
    with invocation_context(source="talk.realtime", talk_session_id=session_id):
        span = await route.new_span(
            model=speaker or "volc-realtime-dialogue",
            request={
                "difficulty": talk.difficulty,
                "scenario_key": talk.scenario_key,
                "article_id": article_id,
                "video_id": video_id,
                "speaker": speaker,
            },
        ).start()
    if session_id in _active_ws:
        await span.fail(RuntimeError("该会话已有进行中的连接"))
        await _send_json(ws, {"type": "error", "message": "该会话已有进行中的连接"})
        await ws.close(code=1008)
        return
    _active_ws.add(session_id)
    writer = _TurnWriter(session_id, ws, next_ordinal)
    collector = _TurnCollector(writer.append)
    failure: BaseException | None = None
    completed = False
    try:
        try:
            await client.connect()
            await client.start_session(
                build_session_config(
                    system_role, **speaker_kwargs, model=get_settings().volc_dialog_model
                )
            )
            if opening:
                await client.say_hello(opening)
        except (VolcRealtimeError, TimeoutError) as exc:
            failure = exc
            logger.warning("volc realtime 建连失败 session=%s: %s", session_id, exc)
            await _send_json(ws, {"type": "error", "message": "实时语音上游连接失败"})
            return
        if opening:
            collector.append_turn("assistant", opening, collector.reply_id)
        await _send_json(ws, {"type": "started", "session_id": session_id})
        if opening:
            await _send_json(
                ws, {"type": "opening", "text": opening, "message_id": collector.reply_id}
            )
            collector.reply_id = str(uuid.uuid4())
        await _relay(ws, client, collector)
        completed = True
    except BaseException as exc:
        failure = exc
        raise
    finally:
        with contextlib.suppress(Exception):
            await client.finish()
        with contextlib.suppress(Exception):
            await client.close()
        collector.flush_all()
        try:
            await writer.finish()
            async with SessionFactory() as db:
                await close_talk_session(db, await db.get(TalkSession, session_id))
        except Exception:
            logger.exception("realtime 回合落库失败 session=%s", session_id)
        _active_ws.discard(session_id)
        with contextlib.suppress(Exception):
            await ws.close()
        if failure is not None:
            status = "cancelled" if isinstance(failure, asyncio.CancelledError) else "failed"
            await span.fail(failure, status=status)
        elif completed:
            await span.succeed(
                response={
                    "turn_count": len(collector.turns),
                    "session_id": client.session_id,
                },
                provider_request_id=client.session_id,
            )


def build_realtime_system_role(scenario: dict | None, difficulty: str) -> str:
    """复用回合制 prompt 主体，去掉 JSON 输出要求（实时链路模型直接说话）。"""
    prompt = build_system_prompt(scenario, difficulty)
    return prompt.split("只输出 JSON")[0] + "回复务必简短口语化，适合直接朗读。"


async def _relay(
    ws: WebSocket,
    client: RealtimeSessionClient,
    collector: _TurnCollector,
) -> None:
    """双向转发直到任一侧断开、end 指令或超时。"""
    started = time.monotonic()
    last_uplink = started
    ended = asyncio.Event()

    async def browser_to_volc() -> None:
        nonlocal last_uplink
        while not ended.is_set():
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                return
            if (chunk := msg.get("bytes")) is not None:
                last_uplink = time.monotonic()
                await client.send_audio(chunk)
            elif text := msg.get("text"):
                try:
                    command = json.loads(text)
                except ValueError:
                    continue
                if not isinstance(command, dict):
                    continue
                if command.get("type") == "end":
                    return
                if command.get("type") in ("ask", "context"):
                    # 用户主动提问（快捷问法 / 文字输入），引用句已由前端拼在问题前面。
                    # ChatTextQuery(501) 的语义就是"用户说了这句话"，模型收到必答——
                    # 所以只有用户真的在问的时候才走这里，加引用卡不发（FR-311）。
                    snippet = str(command.get("text") or "").strip()[:1200]
                    if snippet:
                        last_uplink = time.monotonic()
                        collector.append_turn("user", snippet, str(uuid.uuid4()))
                        await client.chat_text_query(snippet)
                        logger.info("realtime 提问注入 ChatTextQuery(501): %.80s", snippet)

    async def volc_to_browser() -> None:
        while not ended.is_set():
            ev = await client.receive()
            if ev is None:
                await _send_json(ws, {"type": "error", "message": "上游连接中断"})
                return
            if ev.is_audio:
                with contextlib.suppress(Exception):
                    await ws.send_bytes(ev.audio)
                continue
            if ev.event == EVENT_ASR_RESPONSE:
                asr_text, interim = extract_asr_text(ev.payload)
                collector.on_asr(asr_text, interim)
                await _send_json(
                    ws,
                    {
                        "type": "asr",
                        "text": asr_text,
                        "final": not interim,
                        "message_id": collector.user_id,
                    },
                )
            elif ev.event == EVENT_ASR_ENDED:
                message_id = collector.user_id
                text = collector.flush_user()
                await _send_json(ws, {"type": "asr_end", "message_id": message_id, "text": text})
            elif ev.event == EVENT_ASR_INFO:
                collector.flush_reply(complete=False)
                # 检测到用户开口，前端应立即停掉本地播放（打断）
                await _send_json(ws, {"type": "user_start"})
            elif ev.event == EVENT_CHAT_RESPONSE:
                delta = str((ev.payload or {}).get("content") or "")
                collector.on_reply_delta(delta)
                await _send_json(
                    ws, {"type": "reply", "text": delta, "message_id": collector.reply_id}
                )
            elif ev.event == EVENT_CHAT_ENDED:
                message_id = collector.reply_id
                collector.flush_reply()
                await _send_json(ws, {"type": "reply_end", "message_id": message_id})
            elif ev.event == EVENT_TTS_ENDED:
                await _send_json(ws, {"type": "tts_end"})
            elif ev.event in (EVENT_SESSION_FINISHED, EVENT_SESSION_FAILED):
                if ev.event == EVENT_SESSION_FAILED:
                    # 火山侧主动结束的原因（如长时间纯静音）便于排查
                    logger.warning("volc SessionFailed: %s", ev.payload)
                await _send_json(ws, {"type": "finished"})
                return

    async def watchdog() -> None:
        while not ended.is_set():
            await asyncio.sleep(5)
            now = time.monotonic()
            if now - started > MAX_SESSION_SECONDS:
                await _send_json(ws, {"type": "error", "message": "会话超过 30 分钟上限"})
                return
            if now - last_uplink > IDLE_SECONDS:
                await _send_json(ws, {"type": "error", "message": "空闲超过 3 分钟，自动结束"})
                return

    tasks = [
        asyncio.create_task(browser_to_volc(), name="browser_to_volc"),
        asyncio.create_task(volc_to_browser(), name="volc_to_browser"),
        asyncio.create_task(watchdog(), name="watchdog"),
    ]
    try:
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:  # 让首个结束任务的异常浮出（VolcRealtimeError 等）
            exc = task.exception()
            if exc is not None and not isinstance(exc, VolcRealtimeError):
                logger.warning("realtime relay 任务异常: %r", exc)
            elif isinstance(exc, VolcRealtimeError):
                await _send_json(ws, {"type": "error", "message": str(exc)})
    finally:
        ended.set()
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
