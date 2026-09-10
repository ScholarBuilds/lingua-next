"""按词清 TTS 缓存与浏览器缓存代（FR-499）。

缓存文件名是 sha256(text|voice|rate)，磁盘上反推不出词。所以反过来做：把目录里的文件名
装成集合，对 词 × 候选 (cache_voice, rate) 只算 sha256 求交。候选集要把「正在被听到」的
路径全覆盖：场景绑定、edge 兜底、前端 ACCENT_VOICES 的两把 edge 音色、按词钉死的音色，
以及音色目录里的英文音色（朗读条临时音色可能是其中任一个）。

删了服务端文件浏览器还有 7 天缓存（media.py DEFAULT_CACHE），所以每次清理都把
`tts.cache_epoch` +1，前端 ttsUrl 带 `e=` 让 URL 变掉。
"""

import os
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from domain.audio_runtime import (
    EDGE_FALLBACK_VOICE,
    AudioSynthesisError,
    cache_voice_of,
    legacy_audio_route,
    resolve_explicit_voice,
    resolve_scene_route,
    tts_cache_path,
    voice_catalog,
)
from domain.credentials import CredentialError
from domain.models import UserPref, WordVoice

# 与 web/src/lib/audio.ts 的 ACCENT_VOICES 同源：美 / 英音按钮固定用这两把 edge 音色
ACCENT_EDGE_VOICES = ("en-GB-SoniaNeural", "en-US-AriaNeural")
# 只念单词本身的两个场景吃按词清理；例句、释义各走各的
WORD_SCENES = ("word", "vocab")
PREF_KEY = "tts.cache_epoch"


async def current_epoch(session: AsyncSession) -> int:
    row = await session.get(UserPref, PREF_KEY)
    if row is None:
        return 0
    value = row.value.get("n") if isinstance(row.value, dict) else None
    return int(value) if isinstance(value, int) else 0


async def bump_epoch(session: AsyncSession) -> int:
    """+1 并返回新值；不 commit，交给调用方与审计行一起提交。"""
    row = await session.get(UserPref, PREF_KEY)
    if row is None:
        row = UserPref(key=PREF_KEY, value={"n": 0})
        session.add(row)
    n = await current_epoch(session) + 1
    row.value = {"n": n}
    return n


async def _cache_voice_for(session: AsyncSession, voice: str) -> str | None:
    if voice.startswith("mac:"):
        return voice
    try:
        provider_type, voice_id, credentials = await resolve_explicit_voice(session, voice)
        route = legacy_audio_route(
            "tts-word", provider_type=provider_type, model=voice_id, credentials=credentials
        )
    except (AudioSynthesisError, CredentialError):
        return None
    return cache_voice_of(route, voice_id)[0]


async def candidate_voices(session: AsyncSession) -> tuple[set[str], set[int]]:
    """该词可能落过盘的全部 (cache_voice) 与 (rate)。"""
    voices: set[str] = {EDGE_FALLBACK_VOICE, *ACCENT_EDGE_VOICES}
    rates: set[int] = {0}
    for scene in WORD_SCENES:
        try:
            scene_route = await resolve_scene_route(session, scene)
        except CredentialError:
            continue
        voices.add(cache_voice_of(scene_route.route, scene_route.voice_id)[0])
        rates.add(scene_route.rate)
    for voice, rate in (await session.execute(select(WordVoice.voice, WordVoice.rate))).all():
        cache_voice = await _cache_voice_for(session, voice)
        if cache_voice is not None:
            voices.add(cache_voice)
            rates.add(int(rate or 0))
    for item in await voice_catalog(session):
        # 单词是英文，中文 / 其它语言的音色不会被拿来念单词，别把三百个 edge 音色全算一遍
        if not str(item.get("locale", "")).lower().startswith("en"):
            continue
        cache_voice = await _cache_voice_for(session, item["name"])
        if cache_voice is not None:
            voices.add(cache_voice)
    return voices, rates


def purge_word_audio(
    media_root: str, words: set[str], voices: set[str], rates: set[int]
) -> tuple[int, float]:
    """同步：目录文件名求交后删除，返回 (文件数, MB)。调用方放 asyncio.to_thread。"""
    tts_dir = Path(media_root) / "tts"
    if not tts_dir.is_dir():
        return 0, 0.0
    with os.scandir(tts_dir) as it:
        present = {entry.name for entry in it if entry.is_file()}
    files = 0
    size = 0
    for word in words:
        for voice in voices:
            for rate in rates:
                name = tts_cache_path(media_root, word, voice, rate).name
                if name not in present:
                    continue
                path = tts_dir / name
                try:
                    size += path.stat().st_size
                    path.unlink()
                except FileNotFoundError:
                    continue
                files += 1
    return files, round(size / (1024 * 1024), 2)
