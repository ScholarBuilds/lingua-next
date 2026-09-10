"""AI 修复工作台 API（需求 09 v7 FR-85~92）。

会话/消息/审计动作的 CRUD + SSE 推送 + 语音转文字 + 高危确认门 + 换模型重试。
代理本体跑在 worker（arq 任务 repair_agent_turn），这里只管数据与派活。
"""

import asyncio
import json
import tempfile
import uuid
from collections.abc import AsyncGenerator
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select

from app.config import get_settings
from app.queue import get_queue
from app.routers.dict import SessionDep
from domain.models import ModelDeployment, RepairAction, RepairMessage, RepairSession, Video
from domain.pipeline import STEP_BY_NAME
from domain.repair_agent import DEFAULT_ALIAS
from domain.transcribe import transcribe_audio_logged

router = APIRouter(prefix="/repair", tags=["repair"])

SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
VOICE_EXTS = {".webm", ".ogg", ".mp4", ".m4a", ".wav"}

# 工具名 → 用户可读文案（审计流展示）
TOOL_LABELS = {
    "inspect_video": "体检视频",
    "list_sentences": "查阅句子",
    "get_step_info": "查看节点记录",
    "edit_sentence": "修改句子",
    "merge_sentences": "合并句子",
    "split_sentence": "拆分句子",
    "resegment_sentence": "按标点重切",
    "rerun_pipeline": "重跑管线",
    "resolve_issues": "处理校验问题",
    "run_verify": "体检回归",
}


def _session_view(row: RepairSession) -> dict:
    spec = STEP_BY_NAME.get(row.step_name or "")
    return {
        "id": row.id,
        "video_id": row.video_id,
        "step_name": row.step_name,
        "step_label": spec.label if spec else None,
        "status": row.status,
        "model_alias": row.model_alias,
        "model_deployment_id": row.model_deployment_id,
        "pending_action": row.pending_action,
        "parent_session_id": row.parent_session_id,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


def _message_view(m: RepairMessage) -> dict:
    return {
        "id": m.id, "role": m.role, "content": m.content,
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


def _action_view(a: RepairAction) -> dict:
    return {
        "id": a.id,
        "tool": a.tool,
        "label": TOOL_LABELS.get(a.tool, a.tool),
        "args": a.args or {},
        "status": a.status,
        "result": a.result or {},
        "error": a.error,
        "duration_ms": a.duration_ms,
        "created_at": a.created_at.isoformat() if a.created_at else None,
    }


class SessionCreate(BaseModel):
    video_id: int
    step_name: str | None = None
    model_alias: str | None = None
    model_deployment_id: int | None = None
    parent_session_id: int | None = None


@router.post("/sessions", status_code=201)
async def create_session(body: SessionCreate, session: SessionDep) -> dict:
    """开修复会话；带 parent_session_id 即"换模型重试"，问题上下文自动搬入（FR-89）。"""
    if await session.get(Video, body.video_id) is None:
        raise HTTPException(status_code=404, detail="video not found")
    if body.step_name is not None and body.step_name not in STEP_BY_NAME:
        raise HTTPException(status_code=400, detail=f"未知节点：{body.step_name}")
    if body.model_deployment_id is not None:
        deployment = await session.get(ModelDeployment, body.model_deployment_id)
        if deployment is None:
            raise HTTPException(status_code=400, detail="模型部署不存在")
        if not deployment.enabled:
            raise HTTPException(status_code=400, detail="模型部署已停用")
        if "chat" not in (deployment.media_types or []):
            raise HTTPException(status_code=400, detail="修复 Agent 只能选 Chat 模型部署")

    row = RepairSession(
        video_id=body.video_id,
        step_name=body.step_name,
        model_alias=(body.model_alias or DEFAULT_ALIAS).strip(),
        model_deployment_id=body.model_deployment_id,
        parent_session_id=body.parent_session_id,
    )
    session.add(row)
    await session.flush()

    if body.parent_session_id is not None:
        parent_msgs = (
            (
                await session.execute(
                    select(RepairMessage)
                    .where(RepairMessage.session_id == body.parent_session_id)
                    .order_by(RepairMessage.id)
                )
            )
            .scalars()
            .all()
        )
        transcript = "\n".join(
            f"[{m.role}] {m.content}" for m in parent_msgs if m.role in ("user", "assistant")
        )
        if transcript:
            session.add(
                RepairMessage(
                    session_id=row.id, role="system",
                    content="上一个会话未能解决问题，以下是完整经过，请换个思路继续：\n"
                            + transcript[:6000],
                )
            )
    await session.commit()
    await session.refresh(row)
    return _session_view(row)


@router.get("/sessions")
async def list_sessions(session: SessionDep, video_id: int) -> list[dict]:
    rows = (
        (
            await session.execute(
                select(RepairSession)
                .where(RepairSession.video_id == video_id)
                .order_by(RepairSession.id.desc())
                .limit(20)
            )
        )
        .scalars()
        .all()
    )
    return [_session_view(r) for r in rows]


async def _detail(session, row: RepairSession) -> dict:
    messages = (
        (
            await session.execute(
                select(RepairMessage)
                .where(RepairMessage.session_id == row.id)
                .order_by(RepairMessage.id)
            )
        )
        .scalars()
        .all()
    )
    actions = (
        (
            await session.execute(
                select(RepairAction)
                .where(RepairAction.session_id == row.id)
                .order_by(RepairAction.id)
            )
        )
        .scalars()
        .all()
    )
    return {
        **_session_view(row),
        "messages": [_message_view(m) for m in messages],
        "actions": [_action_view(a) for a in actions],
    }


@router.get("/sessions/{session_id}")
async def session_detail(session_id: int, session: SessionDep) -> dict:
    row = await session.get(RepairSession, session_id)
    if row is None:
        raise HTTPException(status_code=404, detail="session not found")
    return await _detail(session, row)


class MessageCreate(BaseModel):
    content: str


@router.post("/sessions/{session_id}/messages", status_code=202)
async def send_message(session_id: int, body: MessageCreate, session: SessionDep) -> dict:
    """用户发一条消息 → 入库并派一轮代理。代理执行中不接新消息（避免并发改数据）。"""
    row = await session.get(RepairSession, session_id)
    if row is None:
        raise HTTPException(status_code=404, detail="session not found")
    if row.status == "working":
        raise HTTPException(status_code=409, detail="代理正在执行上一轮，稍候")
    content = body.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="消息为空")

    session.add(RepairMessage(session_id=session_id, role="user", content=content))
    row.updated_at = datetime.now(UTC)
    await session.commit()

    queue = await get_queue()
    await queue.enqueue_job(
        "repair_agent_turn", session_id,
        _job_id=f"repair:{session_id}:{uuid.uuid4().hex[:6]}",
    )
    return {"queued": True}


@router.post("/sessions/{session_id}/confirm", status_code=202)
async def confirm_pending(session_id: int, session: SessionDep) -> dict:
    """确认高危操作（BR-25）：放行代理挂起的动作并续跑一轮。"""
    row = await session.get(RepairSession, session_id)
    if row is None:
        raise HTTPException(status_code=404, detail="session not found")
    if not row.pending_action:
        raise HTTPException(status_code=400, detail="没有待确认的操作")
    if row.status == "working":
        raise HTTPException(status_code=409, detail="代理正在执行，稍候")

    row.status = "confirmed"  # repair_agent_turn 读到该状态即视为已放行
    session.add(
        RepairMessage(
            session_id=session_id, role="system",
            content=f"用户已确认执行：{json.dumps(row.pending_action, ensure_ascii=False)}。"
                    "请继续完成该操作及后续修复。",
        )
    )
    await session.commit()
    queue = await get_queue()
    await queue.enqueue_job(
        "repair_agent_turn", session_id,
        _job_id=f"repair:{session_id}:{uuid.uuid4().hex[:6]}",
    )
    return {"queued": True}


@router.post("/sessions/{session_id}/reject")
async def reject_pending(session_id: int, session: SessionDep) -> dict:
    """否决高危操作：清掉挂起动作，给代理留一条系统注记。"""
    row = await session.get(RepairSession, session_id)
    if row is None:
        raise HTTPException(status_code=404, detail="session not found")
    row.pending_action = None
    session.add(
        RepairMessage(
            session_id=session_id, role="system",
            content="用户否决了该高危操作，请换其他方案或询问用户意见。",
        )
    )
    await session.commit()
    return {"ok": True}


@router.post("/sessions/{session_id}/voice")
async def voice_to_text(session_id: int, file: UploadFile, session: SessionDep) -> dict:
    """语音描述问题 → whisper 转文字（FR-91）。返回文本进输入框，由用户过目后发送。

    复用跟读比对的转写链路；音频用完即删不落库（BR-12 同款隐私口径）。
    """
    if await session.get(RepairSession, session_id) is None:
        raise HTTPException(status_code=404, detail="session not found")
    ext = Path(file.filename or "").suffix.lower()
    if ext not in VOICE_EXTS:
        raise HTTPException(status_code=400, detail="仅支持 webm/ogg/mp4/m4a/wav 音频")
    data = await file.read()
    if len(data) > 15 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="音频过大（>15MB）")

    tmp = Path(tempfile.mkstemp(suffix=ext, prefix="repair-voice-")[1])
    try:
        tmp.write_bytes(data)
        text = await transcribe_audio_logged(
            str(tmp),
            get_settings().whisper_model,
            capability="repair.voice.asr",
            session=session,
        )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 - 上游多种异常统一成 502，与另外三个转写入口同口径
        # 这里原来只有 try/finally：ASR 抛什么就裸抛什么，前端拿到的是 500 而不是 502，
        # 而同一件事在 shadowing/talk/videos 三处都是 502
        raise HTTPException(status_code=502, detail="音频转写失败") from exc
    finally:
        tmp.unlink(missing_ok=True)
    return {"text": text.strip()}


@router.get("/sessions/{session_id}/stream")
async def stream_session(session_id: int, request: Request) -> StreamingResponse:
    """会话 SSE：消息、动作、状态有变化即推整包（代理执行中前端实时看到工具进度）。"""
    from app.db import SessionFactory

    async def gen() -> AsyncGenerator[str, None]:
        last = ""
        while not await request.is_disconnected():
            async with SessionFactory() as session:
                row = await session.get(RepairSession, session_id)
                if row is None:
                    yield 'data: {"error": "session gone"}\n\n'
                    return
                payload = await _detail(session, row)
            body = json.dumps(payload, ensure_ascii=False)
            if body != last:
                last = body
                yield f"data: {body}\n\n"
            else:
                yield ": keep-alive\n\n"
            await asyncio.sleep(1.0)

    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)
