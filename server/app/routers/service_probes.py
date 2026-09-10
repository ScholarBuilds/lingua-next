"""配置目录与用途绑定的显式试听；不使用缓存或切换供应商。"""

import asyncio
import base64
import io
import json
import tempfile
import time
import wave
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.routers.dict import SessionDep
from domain.audio_runtime import AudioSynthesisError, legacy_audio_route
from domain.credentials import CredentialError, decrypt_config
from domain.models import CapabilityBinding, ProviderCredential
from domain.volc_tts import VolcTTSError

router = APIRouter()


class VoiceProbeBody(BaseModel):
    credential_id: int | None = Field(default=None, gt=0)
    voice: str = Field(default="", max_length=200)
    capability: str | None = Field(default=None, max_length=100)
    stream: bool = False
    rate: int = Field(default=0, ge=-50, le=100)
    sample: str | None = Field(default=None, min_length=1, max_length=500)


@router.post("/voice-probe", response_model=None)
async def voice_probe(body: VoiceProbeBody, session: SessionDep):
    credential_id, voice, rate = body.credential_id, body.voice, body.rate
    options = {}
    if body.capability:
        if not body.capability.startswith("tts-"):
            raise HTTPException(422, "请选择朗读用途")
        binding = await session.scalar(
            select(CapabilityBinding).where(
                CapabilityBinding.capability == body.capability,
            )
        )
        if binding is None:
            raise HTTPException(409, "用途尚未绑定音色")
        credential_id, voice = binding.credential_id, binding.target
        rate = int((binding.params or {}).get("rate") or 0)
        options = binding.params or {}
    cred = await session.get(ProviderCredential, credential_id) if credential_id else None
    if cred is None or not cred.enabled or cred.kind != "tts":
        raise HTTPException(409, "请选择已启用的语音供应商")
    if not voice:
        raise HTTPException(422, "请选择音色")
    items = (cred.models_cache or {}).get("items", [])
    entry = next(
        (item for item in items if isinstance(item, dict) and item.get("id") == voice), None
    )
    if entry is None:
        raise HTTPException(422, "音色不在目录中，请先刷新音色")
    text = (
        "你好，很高兴和你一起学习。"
        if entry.get("locale", "").startswith("zh")
        else "Hello! It is a lovely day to learn something new."
    )
    if body.sample and body.sample.strip():
        text = body.sample.strip()
    route = legacy_audio_route(
        body.capability or "tts-preview",
        provider_type=cred.provider_type,
        model=voice,
        credentials=decrypt_config(cred.config),
        protocol_options=options,
    )

    async def events():
        started = time.monotonic()
        first_audio_ms = None
        metrics = {}
        size = 0
        with tempfile.TemporaryDirectory(prefix="nexus-voice-probe-") as directory:
            result = None
            try:
                async with asyncio.timeout(40):
                    result = await route.synthesize(
                        text=text, voice=voice, rate=rate, cache_path=Path(directory) / "sample.mp3"
                    )
                    metrics = result.metrics
                    yield {"type": "ready", "mime_type": "audio/mpeg", "sample": text, **metrics}

                    async def chunks():
                        if result.path:
                            yield await asyncio.to_thread(result.path.read_bytes)
                        elif result.stream:
                            async for chunk in result.stream:
                                yield chunk

                    async for chunk in chunks():
                        if not chunk:
                            continue
                        size += len(chunk)
                        if size > 2_000_000:
                            raise AudioSynthesisError("size", "试听音频超出限制")
                        if first_audio_ms is None:
                            first_audio_ms = round((time.monotonic() - started) * 1000)
                        yield {
                            "type": "audio",
                            "audio": base64.b64encode(chunk).decode(),
                            "first_audio_ms": first_audio_ms,
                        }
                    if not size:
                        raise AudioSynthesisError("empty", "供应商未返回音频")
                yield {
                    "type": "done",
                    "ok": True,
                    "latency_ms": round((time.monotonic() - started) * 1000),
                    "first_audio_ms": first_audio_ms,
                    "detail": "未使用缓存或降级音色",
                    "sample": text,
                    "voice": voice,
                    "mime_type": "audio/mpeg",
                    **metrics,
                }
            except (AudioSynthesisError, CredentialError, VolcTTSError, TimeoutError) as exc:
                yield {
                    "type": "done",
                    "ok": False,
                    "latency_ms": round((time.monotonic() - started) * 1000),
                    "detail": str(exc) or "试听超时",
                    "voice": voice,
                }
            finally:
                if result and result.stream:
                    await result.stream.aclose()

    if body.stream:

        async def lines():
            async for event in events():
                yield json.dumps(event, ensure_ascii=False) + "\n"

        return StreamingResponse(
            lines(), media_type="application/x-ndjson", headers={"X-Accel-Buffering": "no"}
        )
    audio = []
    final = {}
    async for event in events():
        if event["type"] == "audio":
            audio.append(base64.b64decode(event["audio"]))
        elif event["type"] == "done":
            final = event
    if final.get("ok"):
        final["audio"] = base64.b64encode(b"".join(audio)).decode()
    return final


class TranslateProbeBody(BaseModel):
    engine: Literal["auto", "llm", "google", "bing"]


class RealtimeProbeBody(BaseModel):
    capability: Literal["realtime-voice"] = "realtime-voice"
    credential_id: int | None = Field(default=None, gt=0)
    voice: str = Field(default="", max_length=200)
    preview: bool = False


@router.post("/realtime-probe")
async def realtime_probe(body: RealtimeProbeBody, session: SessionDep) -> dict:
    from app.config import get_settings
    from domain.kernel.capability_seam import RouteRequest
    from domain.model_plugins import adapter_for_provider
    from domain.volc_realtime import (
        EVENT_TTS_ENDED,
        VolcRealtimeError,
        build_session_config,
        prepare_realtime_route,
        resolve_realtime_route,
    )

    started = time.monotonic()
    client = None
    connected_ms = None
    try:
        async with asyncio.timeout(30):
            if body.credential_id:
                credential = await session.get(ProviderCredential, body.credential_id)
                if (
                    not credential
                    or not credential.enabled
                    or credential.provider_type not in {"volc_speech", "volc_realtime"}
                ):
                    raise HTTPException(409, "请选择支持实时对话的已启用凭据")
                items = (credential.models_cache or {}).get("items", [])
                if body.voice and not any(
                    isinstance(item, dict) and item.get("id") == body.voice for item in items
                ):
                    raise HTTPException(422, "音色不在目录中，请先刷新")
                route = prepare_realtime_route(
                    RouteRequest(
                        capability=body.capability,
                        plugin_id=adapter_for_provider(
                            credential.provider_type, operation="realtime.session"
                        ),
                        provider_type=credential.provider_type,
                        model=body.voice,
                        credentials=decrypt_config(credential.config),
                    )
                )
            else:
                route = await resolve_realtime_route(session, None, capability=body.capability)
            client = route.open_client()
            await client.connect()
            kwargs = {"speaker": route.snapshot.model} if route.snapshot.model else {}
            await client.start_session(
                build_session_config(
                    "You are an English speaking partner.",
                    model=get_settings().volc_dialog_model,
                    **kwargs,
                )
            )
            connected_ms = round((time.monotonic() - started) * 1000)
            await client.say_hello("Hello. Nice to meet you.")
            audio = bytearray()
            first_audio_ms = None
            while True:
                event = await client.receive(timeout=10)
                if event is None:
                    raise VolcRealtimeError("会话在返回音频前断开")
                if event.audio:
                    if first_audio_ms is None:
                        first_audio_ms = round((time.monotonic() - started) * 1000)
                    if body.preview:
                        audio.extend(event.audio)
                        if len(audio) > 2_000_000:
                            raise VolcRealtimeError("试听音频超出限制")
                        continue
                    return {
                        "ok": True,
                        "latency_ms": round((time.monotonic() - started) * 1000),
                        "session_ms": connected_ms,
                        "detail": "实时会话已建立并收到首段音频；未采集麦克风",
                    }
                if body.preview and event.event == EVENT_TTS_ENDED and audio:
                    wav_data = io.BytesIO()
                    with wave.open(wav_data, "wb") as wav:
                        wav.setnchannels(1)
                        wav.setsampwidth(2)
                        wav.setframerate(24000)
                        wav.writeframes(audio)
                    return {
                        "ok": True,
                        "latency_ms": first_audio_ms,
                        "session_ms": connected_ms,
                        "detail": "实时会话首音频耗时；预览整句播放，未采集麦克风",
                        "audio": base64.b64encode(wav_data.getvalue()).decode(),
                        "mime_type": "audio/wav",
                    }
                if event.error_code:
                    raise VolcRealtimeError(f"供应商错误码 {event.error_code}")
    except (CredentialError, VolcRealtimeError, TimeoutError) as exc:
        return {
            "ok": False,
            "latency_ms": round((time.monotonic() - started) * 1000),
            "session_ms": connected_ms,
            "detail": str(exc) or "等待实时音频超时",
        }
    finally:
        if client is not None:
            await client.close()


@router.post("/translation-probe")
async def translation_probe(body: TranslateProbeBody) -> dict:
    from domain.translate import EngineError, translate

    started = time.monotonic()
    try:
        async with asyncio.timeout(30):
            result = await translate("Good morning. How are you today?", engine=body.engine)
        return {
            "ok": True,
            "latency_ms": round((time.monotonic() - started) * 1000),
            "detail": result["text"],
            "engine": result["engine"],
        }
    except (EngineError, TimeoutError) as exc:
        return {
            "ok": False,
            "latency_ms": round((time.monotonic() - started) * 1000),
            "detail": str(exc) or "翻译超时",
        }
