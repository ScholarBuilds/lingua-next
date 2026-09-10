"""TTS 接口：音色按配置中心场景绑定解析（模块 11），火山 2.0 流式主档、edge 免费兜底。

`voice` 未传时按 scene（word|sentence|chapter|vocab|video|assistant|meaning）对应的
tts-* 绑定取凭据+音色+语速；显式传 voice 则临时覆盖（BR-05，不写回默认）。voice 带前缀
路由：`volc:{speaker}` 走火山单向流式（凭据取自凭据库），`edge:{name}` 走 edge-tts。
音频按内容指纹落盘缓存，火山失败自动降级 edge，实际音源见响应头 X-TTS-Provider。

按词钉死的音色（`/tts/word-voices`，FR-495）只存不解析：前端拿整张表在 `ttsUrl` 里
显式带 `voice=`，因为文件响应带 7 天浏览器缓存，同一 URL 上换音色用户听不到。
"""

import asyncio
import subprocess
import uuid
from collections.abc import AsyncGenerator
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.config import get_settings
from app.media import file_response
from app.routers.dict import SessionDep
from domain import mac_tts
from domain.audio_runtime import (
    EDGE_FALLBACK_VOICE,
    SCENE_FALLBACK_VOICE,
    AudioSynthesis,
    AudioSynthesisError,
    PreparedAudioRoute,
    cache_voice_of,
    edge_fallback_route,
    legacy_audio_route,
    prepare_audio_model_route,
    resolve_explicit_voice,
    split_voice,
    tts_cache_path,
    voice_catalog,
    volc_credentials,
)
from domain.credentials import CredentialError, resolve_binding
from domain.model_catalog import ModelCatalogError, resolve_model_route
from domain.models import WordVoice
from domain.tts_cache import current_epoch

router = APIRouter(prefix="/tts", tags=["tts"])

MAX_TEXT_LEN = 2000
SCENES = ("word", "sentence", "chapter", "vocab", "video", "assistant", "meaning")
MAX_WORD_LEN = 64
# 旧名字保住：测试与其它模块按这些名字打桩 / 引用
_split_voice = split_voice
_volc_credentials = volc_credentials


def _cache_path(text: str, voice: str, rate: int) -> Path:
    return tts_cache_path(get_settings().media_root, text, voice, rate)


def _audio_response(path: Path, provider: str) -> Response:
    return file_response(path, media_type="audio/mpeg", headers={"X-TTS-Provider": provider})


async def _resolve_explicit_voice(session, voice: str) -> tuple[str, str, dict]:
    """显式 voice → (provider_type, voice_id, credentials)；格式坏 422、凭据不可用 409。
    按词钉音色只校验不合成，也走这里。"""
    try:
        return await resolve_explicit_voice(session, voice)
    except AudioSynthesisError as exc:
        raise HTTPException(422, str(exc)) from exc
    except CredentialError as exc:
        raise HTTPException(409, str(exc)) from exc


_legacy_audio_route = legacy_audio_route
_fallback_route = edge_fallback_route
_cache_identity = cache_voice_of


async def _run_synthesis(
    route: PreparedAudioRoute,
    *,
    text: str,
    voice_id: str,
    rate: int,
    path: Path,
) -> AudioSynthesis:
    return await route.synthesize(text=text, voice=voice_id, rate=rate, cache_path=path)


@router.get("", response_model=None)
async def synthesize(
    text: str,
    session: SessionDep,
    voice: str | None = None,
    rate: int | None = None,
    scene: str = "sentence",
    deployment_id: int | None = None,
) -> Response | StreamingResponse:
    text = text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="empty text")
    if len(text) > MAX_TEXT_LEN:
        raise HTTPException(status_code=400, detail=f"文本超过 {MAX_TEXT_LEN} 字符上限")
    if scene not in SCENES:
        raise HTTPException(status_code=400, detail=f"scene 仅支持 {'/'.join(SCENES)}")

    if voice is not None and deployment_id is not None:
        raise HTTPException(status_code=400, detail="voice 与 deployment_id 不能同时指定")

    if voice is not None and voice.startswith("mac:"):
        path = _cache_path(text, voice, rate or 0)
        cached = path.exists()
        if not cached:
            try:
                await asyncio.to_thread(mac_tts.synthesize, text, voice, rate or 0, path)
            except (ValueError, OSError, subprocess.SubprocessError) as exc:
                raise HTTPException(503, "本机声音合成失败，请检查声音是否已安装") from exc
        return _audio_response(path, "mac-cache" if cached else "mac")

    capability = f"tts-{scene}"
    if deployment_id is not None:
        try:
            model_route = await resolve_model_route(
                session,
                capability,
                deployment_id=deployment_id,
            )
            if model_route is None:
                raise ModelCatalogError("TTS 模型部署不存在")
            prepared = prepare_audio_model_route(capability, model_route)
        except (AudioSynthesisError, CredentialError, ModelCatalogError) as exc:
            raise HTTPException(status_code=503, detail=f"TTS 模型不可用：{exc}") from exc
        voice_id = model_route.upstream_model_id
        if rate is None:
            rate = int(model_route.protocol_options.get("rate") or 0)
    elif voice is None:  # 按场景绑定解析（凭据+音色+语速）
        try:
            resolved = await resolve_binding(session, capability)
        except CredentialError as exc:
            if scene not in SCENE_FALLBACK_VOICE:
                raise HTTPException(status_code=503, detail=f"TTS 场景不可用：{exc}") from exc
            resolved = None
        if resolved is None:
            voice_id = SCENE_FALLBACK_VOICE[scene]
            prepared = _fallback_route(capability, voice_id)
        else:
            voice_id = resolved.target or EDGE_FALLBACK_VOICE
            try:
                prepared = _legacy_audio_route(
                    capability,
                    provider_type=resolved.provider_type,
                    model=voice_id,
                    credentials=resolved.config,
                    protocol_options=resolved.params,
                )
            except (AudioSynthesisError, CredentialError) as exc:
                raise HTTPException(status_code=503, detail=f"TTS 场景不可用：{exc}") from exc
            if rate is None:
                rate = int(resolved.params.get("rate") or 0)
    else:  # 显式 voice = 本次会话临时覆盖（BR-05）
        provider_type, voice_id, credentials = await _resolve_explicit_voice(session, voice)
        try:
            prepared = _legacy_audio_route(
                capability,
                provider_type=provider_type,
                model=voice_id,
                credentials=credentials,
            )
        except AudioSynthesisError as exc:
            raise HTTPException(status_code=503, detail=f"TTS 模型不可用：{exc}") from exc
    rate = rate or 0

    cache_voice, cache_provider = _cache_identity(prepared, voice_id)
    path = _cache_path(text, cache_voice, rate)
    if path.exists():
        return _audio_response(path, f"{cache_provider}-cache")

    try:
        result = await _run_synthesis(
            prepared,
            text=text,
            voice_id=voice_id,
            rate=rate,
            path=path,
        )
    except AudioSynthesisError as exc:
        if prepared.snapshot.plugin_id == "edge-tts":
            raise HTTPException(status_code=502, detail="TTS 暂不可用") from exc
        fallback_voice = SCENE_FALLBACK_VOICE.get(scene, EDGE_FALLBACK_VOICE)
        fallback_route = _fallback_route(capability, fallback_voice)
        fallback_path = _cache_path(text, fallback_voice, rate)
        if fallback_path.exists():
            return _audio_response(fallback_path, "edge-fallback-cache")
        try:
            result = await _run_synthesis(
                fallback_route,
                text=text,
                voice_id=fallback_voice,
                rate=rate,
                path=fallback_path,
            )
        except AudioSynthesisError as fallback_exc:
            raise HTTPException(status_code=502, detail="TTS 暂不可用") from fallback_exc
        if result.path is not None:
            return _audio_response(result.path, "edge-fallback")
        path = fallback_path

    if result.path is not None:
        return _audio_response(result.path, result.provider)
    if result.stream is not None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{path.stem}.{uuid.uuid4().hex[:8]}.part")

        async def tee() -> AsyncGenerator[bytes, None]:
            done = False
            try:
                with tmp.open("wb") as sink:
                    async for chunk in result.stream:
                        sink.write(chunk)
                        yield chunk
                done = True
            finally:
                await result.stream.aclose()
                if done:
                    tmp.replace(path)
                else:
                    tmp.unlink(missing_ok=True)

        return StreamingResponse(
            tee(),
            media_type="audio/mpeg",
            headers={"X-TTS-Provider": result.provider, "X-Accel-Buffering": "no"},
        )
    raise HTTPException(status_code=502, detail="TTS Provider 未返回音频产物")


def _normalize_word(word: str) -> str:
    word = word.strip().lower()
    if not word or len(word) > MAX_WORD_LEN:
        raise HTTPException(422, f"词长须在 1~{MAX_WORD_LEN} 字符")
    return word


def _word_voice_public(row: WordVoice) -> dict:
    return {"voice": row.voice, "rate": row.rate}


class WordVoiceBody(BaseModel):
    voice: str = Field(min_length=1, max_length=128)
    rate: int = Field(default=0, ge=-50, le=100)


@router.get("/word-voices")
async def list_word_voices(session: SessionDep) -> dict:
    """全部按词钉死的音色。个人工具、条数在百级，一次给前端装进内存表。"""
    rows = (await session.execute(select(WordVoice))).scalars()
    return {
        "voices": {row.word: _word_voice_public(row) for row in rows},
        # 清过缓存就 +1，前端拿它给 TTS URL 加 e= 让浏览器 7 天缓存失效
        "epoch": await current_epoch(session),
    }


@router.put("/word-voices/{word}")
async def put_word_voice(word: str, body: WordVoiceBody, session: SessionDep) -> dict:
    key = _normalize_word(word)
    # 只校验前缀与凭据，不合成：合成留给用户点喇叭那一下，那时才该花钱
    if body.voice.startswith("mac:"):
        if body.voice not in {item["name"] for item in await asyncio.to_thread(mac_tts.voices)}:
            raise HTTPException(422, "本机声音不可用")
    else:
        await _resolve_explicit_voice(session, body.voice)
    row = await session.get(WordVoice, key)
    if row is None:
        row = WordVoice(word=key, voice=body.voice, rate=body.rate)
        session.add(row)
    else:
        row.voice = body.voice
        row.rate = body.rate
    await session.commit()
    await session.refresh(row)
    return {"word": key, **_word_voice_public(row)}


@router.delete("/word-voices/{word}")
async def delete_word_voice(word: str, session: SessionDep) -> dict:
    key = _normalize_word(word)
    row = await session.get(WordVoice, key)
    if row is not None:
        await session.delete(row)
        await session.commit()
    return {"ok": True, "word": key}


@router.get("/voices")
async def list_voices(session: SessionDep) -> dict:
    """聚合所有 enabled TTS 凭据的 models_cache 音色目录（附 credential_id）。"""
    return {"voices": await voice_catalog(session)}


@router.get("/local-voices")
async def local_voices() -> dict:
    return {"voices": await asyncio.to_thread(mac_tts.voices)}
