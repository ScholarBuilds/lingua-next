"""跟读工作台：录音落库、逐词比对、AI 流式点评（FR-335~345）。

BR-12 原文即「用户明确保存才落库」——本模块把预留的那半边补上。
只录不动作的不落库；点「逐词比对 / AI 点评 / 保存」才存，
这三件事本来就要把音频送到服务端，用户的动作就是那个"明确"。

音频文件落 media_root/recordings/{video_id}/，DB 只存相对路径：
删音频不删比对与点评，清理只作用于媒体（BR-74、BR-G-009）。
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from collections.abc import AsyncGenerator
from pathlib import Path

from fastapi import APIRouter, Form, HTTPException, UploadFile
from fastapi.responses import Response, StreamingResponse
from sqlalchemy import desc, select

from app.config import get_settings
from app.media import media_response
from app.owner import CurrentOwner
from app.routers.dict import SessionDep
from domain.llm import (
    LLMUnavailable,
    pronunciation_narrate_prompt,
    shadow_review_prompt,
    stream_text,
)
from domain.models import (
    Phoneme,
    PronunciationAssessment,
    ShadowRecording,
    StudyUnit,
    SubtitleSentence,
    SubtitleTrack,
)
from domain.shadowing import diff_words
from domain.storage import get_storage
from domain.transcribe import transcribe_audio_logged

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/videos", tags=["shadowing"])

SHADOW_EXTS = {".webm", ".ogg", ".mp4", ".m4a", ".wav"}
MAX_SHADOW_BYTES = 20 * 1024 * 1024
"""每句保留的录音条数上限：留着才看得出进步，但不能无限涨（FR-345）。"""
KEEP_PER_SENTENCE = 10
SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
SCORE_RE = re.compile(r"\[\[SCORE:\s*(\d{1,3})\s*\]\]")


def _rec_dir(video_id: int) -> Path:
    path = Path(get_settings().media_root) / "recordings" / str(video_id)
    path.mkdir(parents=True, exist_ok=True)
    return path


def _payload(row: ShadowRecording, assessment: dict | None = None) -> dict:
    return {
        "id": row.id,
        "video_id": row.video_id,
        "sentence_id": row.sentence_id,
        "unit_id": row.unit_id,
        "audio_url": f"/api/videos/shadow/{row.id}/audio",
        "duration_ms": row.duration_ms,
        "transcript": row.transcript,
        "accuracy": row.accuracy,
        "items": (row.diff or {}).get("items", []),
        "correct": (row.diff or {}).get("correct"),
        "total": (row.diff or {}).get("total"),
        "extra": (row.diff or {}).get("extra"),
        "reference": (row.diff or {}).get("reference"),
        "review": row.review,
        "score": row.score,
        "assessment": assessment,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


async def _prune(session: SessionDep, user_id: str, sentence_id: int) -> None:
    """超出上限的旧录音连音频一起清掉，保留最近的若干条。"""
    rows = (
        (
            await session.execute(
                select(ShadowRecording)
                .where(
                    ShadowRecording.user_id == user_id,
                    ShadowRecording.sentence_id == sentence_id,
                )
                .order_by(desc(ShadowRecording.created_at), desc(ShadowRecording.id))
            )
        )
        .scalars()
        .all()
    )
    root = Path(get_settings().media_root)
    for row in rows[KEEP_PER_SENTENCE:]:
        (root / row.audio_key).unlink(missing_ok=True)
        await session.delete(row)


@router.post("/shadow", status_code=201)
async def create_shadow(
    session: SessionDep,
    file: UploadFile,
    owner: CurrentOwner,
    sentence_id: int = Form(...),
    unit_id: int | None = Form(None),
    duration_ms: int | None = Form(None),
    compare: bool = Form(True),
) -> dict:
    """录音落库；compare=true 时顺带 whisper 转写 + 逐词比对（FR-339/340）。"""
    sentence = await session.get(SubtitleSentence, sentence_id)
    if sentence is None:
        raise HTTPException(status_code=404, detail="sentence not found")

    ext = Path(file.filename or "").suffix.lower()
    if ext not in SHADOW_EXTS:
        raise HTTPException(status_code=400, detail="仅支持 webm/ogg/mp4/m4a/wav 音频")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="音频为空")
    if len(data) > MAX_SHADOW_BYTES:
        raise HTTPException(status_code=400, detail="音频超过 20MB 上限")

    # 语法句是「一句」的唯一口径（BR-72）：比对基准取整句原文
    reference = sentence.text
    # 传错句的 unit 直接丢掉，别让它污染归属
    if unit_id is not None:
        unit = await session.get(StudyUnit, unit_id)
        if unit is None or unit.sentence_id != sentence_id:
            unit_id = None

    track = await session.get(SubtitleTrack, sentence.track_id)
    if track is None:
        raise HTTPException(status_code=404, detail="track not found")
    video_id = track.video_id

    name = f"{sentence_id}-{uuid.uuid4().hex[:8]}{ext}"
    path = _rec_dir(video_id) / name
    path.write_bytes(data)
    audio_key = str(path.relative_to(Path(get_settings().media_root)))

    row = ShadowRecording(
        user_id=owner.id,
        video_id=video_id,
        sentence_id=sentence_id,
        unit_id=unit_id,
        audio_key=audio_key,
        mime=file.content_type or "audio/webm",
        duration_ms=duration_ms,
    )

    if compare:
        try:
            transcript = await transcribe_audio_logged(
                str(path),
                get_settings().whisper_model,
                capability="shadowing.asr",
                session=session,
            )
        except Exception as exc:  # noqa: BLE001 - 上游多种异常统一成 502
            path.unlink(missing_ok=True)
            raise HTTPException(status_code=502, detail="音频转写失败") from exc
        if not transcript.strip():
            path.unlink(missing_ok=True)
            raise HTTPException(status_code=422, detail="未识别到语音内容，请重新录制")
        result = diff_words(reference, transcript)
        row.transcript = transcript
        row.accuracy = result["accuracy"]
        row.diff = {"reference": reference, **result}

    session.add(row)
    await session.commit()
    await session.refresh(row)
    await _prune(session, owner.id, sentence_id)
    await session.commit()
    return _payload(row)


@router.get("/{video_id}/shadow")
async def list_shadow(
    video_id: int, owner: CurrentOwner, session: SessionDep, sentence_id: int | None = None
) -> list[dict]:
    """某视频（可按句过滤）的跟读历史，时间倒序（FR-341）。"""
    stmt = select(ShadowRecording).where(
        ShadowRecording.user_id == owner.id, ShadowRecording.video_id == video_id
    )
    if sentence_id is not None:
        stmt = stmt.where(ShadowRecording.sentence_id == sentence_id)
    stmt = stmt.order_by(desc(ShadowRecording.created_at), desc(ShadowRecording.id))
    rows = (await session.execute(stmt)).scalars().all()
    done = {
        a.recording_id: a
        for a in (
            await session.execute(
                select(PronunciationAssessment).where(
                    PronunciationAssessment.recording_id.in_([r.id for r in rows] or [0])
                )
            )
        ).scalars()
    }
    return [_payload(r, _assessment_payload(done.get(r.id))) for r in rows]


@router.get("/shadow/{rec_id}/audio")
async def shadow_audio(rec_id: int, owner: CurrentOwner, session: SessionDep) -> Response:
    row = (
        await session.execute(
            select(ShadowRecording).where(
                ShadowRecording.id == rec_id, ShadowRecording.user_id == owner.id
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="recording not found")
    path = Path(get_settings().media_root) / row.audio_key
    if not path.exists():
        # 音频被清理过，但比对与点评仍在（BR-74）
        raise HTTPException(status_code=410, detail="音频已清理，分析结果仍可查看")
    return media_response(row.audio_key, media_type=row.mime)


@router.post("/shadow/{rec_id}/review", response_model=None)
async def review_shadow(
    rec_id: int, owner: CurrentOwner, session: SessionDep, refresh: bool = False
) -> StreamingResponse:
    """AI 点评：SSE 流式输出，收尾把全文与评分落库（FR-342~344）。"""
    row = (
        await session.execute(
            select(ShadowRecording).where(
                ShadowRecording.id == rec_id, ShadowRecording.user_id == owner.id
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="recording not found")
    if row.diff is None:
        raise HTTPException(status_code=400, detail="尚未比对，无法点评")

    def sse(event: str, data: dict) -> str:
        return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

    cached = row.review if not refresh else None
    diff = row.diff or {}
    system, user = shadow_review_prompt(
        diff.get("reference", ""),
        row.transcript or "",
        diff.get("items", []),
        row.accuracy or 0,
    )

    async def gen() -> AsyncGenerator[str, None]:
        if cached:  # 已点评过：重开弹窗不再调用 AI（FR-344）
            yield sse("done", {"text": cached, "score": row.score, "cached": True})
            return
        messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
        try:
            async for ev in stream_text("explain-standard", messages):
                if ev["type"] == "delta":
                    yield sse("delta", {"text": ev["text"]})
                    continue
                text = ev["text"]
                score = None
                if (m := SCORE_RE.search(text)) is not None:
                    score = max(0, min(100, int(m.group(1))))
                    text = SCORE_RE.sub("", text, count=1).lstrip()
                row.review = text
                row.score = score
                await session.commit()
                yield sse("done", {"text": text, "score": score, "cached": False})
        except LLMUnavailable:
            yield sse("error", {"message": "LLM 网关未配置或不可用"})

    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)


@router.delete("/shadow/{rec_id}")
async def delete_shadow(rec_id: int, owner: CurrentOwner, session: SessionDep) -> dict:
    row = (
        await session.execute(
            select(ShadowRecording).where(
                ShadowRecording.id == rec_id, ShadowRecording.user_id == owner.id
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="recording not found")
    await get_storage().delete(row.audio_key)
    await session.delete(row)
    await session.commit()
    return {"deleted": rec_id}


# ──────────────────────────── 发音评测（FR-398） ────────────────────────────


def _assessment_payload(row: PronunciationAssessment | None) -> dict | None:
    if row is None:
        return None
    return {
        "completeness": row.completeness,
        "fluency": row.fluency,
        "accuracy": row.accuracy,
        "words": row.words or [],
        "breaks": row.breaks or [],
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


@router.post("/shadow/{rec_id}/assess")
async def assess_shadow(
    rec_id: int, owner: CurrentOwner, session: SessionDep, refresh: bool = False
) -> dict:
    """结构化发音诊断（FR-398）。

    第 0 层零新依赖必出；音素级缺件时自动降级，`notes` 里说明原因，不报错。
    结果按录音落库，重开面板不再重算（与 ADR-006 的产物持久化同口径）。
    """
    row = (
        await session.execute(
            select(ShadowRecording).where(
                ShadowRecording.id == rec_id, ShadowRecording.user_id == owner.id
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="recording not found")
    if row.diff is None:
        raise HTTPException(status_code=400, detail="尚未比对，无法评测")

    existing = (
        await session.execute(
            select(PronunciationAssessment).where(PronunciationAssessment.recording_id == rec_id)
        )
    ).scalar_one_or_none()
    if existing is not None and not refresh:
        return _assessment_payload(existing)  # type: ignore[return-value]

    path = Path(get_settings().media_root) / row.audio_key
    if not path.exists():
        raise HTTPException(status_code=410, detail="音频已清理，无法重新评测")

    reference = (row.diff or {}).get("reference") or ""

    def _run() -> dict:
        from domain.alignment import align_text
        from domain.pronunciation import assess_full

        try:
            aligned = align_text(str(path), reference)
        except Exception as exc:  # noqa: BLE001 - 对齐失败仍可出完整度
            logger.warning("跟读对齐失败，降级为纯文本完整度：%s", exc)
            aligned = []
        return assess_full(str(path), reference, row.diff or {}, aligned).to_dict()

    # 这里原来手写了一条 ModelInvocationSpan，记的是音素 ONNX 的 audio.assess 调用。
    # 那个模型 2026-08-30 下线后，这一步只剩 CTC 强制对齐加纯算术——
    # 而对齐在视频管线里走的是 `rec.step` 不是台账（worker/tasks.py:424、:990），
    # 全仓没有第二处给它记模型调用。继续写 span 等于给一个不存在的插件记账：
    # plugin_id 查不到注册项，plugin_version / generation 全落 NULL。
    try:
        result = await asyncio.to_thread(_run)
    except Exception as exc:  # noqa: BLE001 - 对齐或打分挂了统一成 502
        raise HTTPException(status_code=502, detail="发音诊断失败") from exc

    if existing is None:
        existing = PronunciationAssessment(recording_id=rec_id)
        session.add(existing)
    existing.completeness = result["completeness"]
    existing.fluency = result["fluency"]
    existing.accuracy = result["accuracy"]
    existing.words = result["words"]
    existing.breaks = result["breaks"]
    await session.commit()
    return {**result, "recording_id": rec_id}


@router.post("/shadow/{rec_id}/narrate", response_model=None)
async def narrate_assessment(
    rec_id: int, owner: CurrentOwner, session: SessionDep
) -> StreamingResponse:
    """把确定性诊断翻译成中文说明（FR-398j）。

    **LLM 不参与打分**：分数由前三层的算法给，这里只做叙述。
    """
    row = (
        await session.execute(
            select(ShadowRecording).where(
                ShadowRecording.id == rec_id, ShadowRecording.user_id == owner.id
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="recording not found")
    a = (
        await session.execute(
            select(PronunciationAssessment).where(PronunciationAssessment.recording_id == rec_id)
        )
    ).scalar_one_or_none()
    if a is None:
        raise HTTPException(status_code=400, detail="尚未评测")

    payload = _assessment_payload(a) or {}
    symbols = {h.get("expected") for h in payload.get("phonemes", []) if h.get("expected")}
    cards = []
    if symbols:
        rows = (
            await session.execute(select(Phoneme).where(Phoneme.symbol.in_(symbols)))
        ).scalars().all()
        cards = [
            {"symbol": c.symbol, "zh_name": c.zh_name, "tips": c.tips, "常见错读": c.common_errors}
            for c in rows
        ]
    system, user = pronunciation_narrate_prompt(
        (row.diff or {}).get("reference", ""), payload, cards
    )

    def sse(event: str, data: dict) -> str:
        return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

    async def gen() -> AsyncGenerator[str, None]:
        messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
        try:
            async for ev in stream_text("explain-standard", messages):
                if ev["type"] == "delta":
                    yield sse("delta", {"text": ev["text"]})
                else:
                    yield sse("done", {"text": ev["text"]})
        except LLMUnavailable:
            yield sse("error", {"message": "LLM 网关未配置或不可用"})

    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)
