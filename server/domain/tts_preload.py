"""后台预热与播放器使用相同的音色解析和磁盘寻址。"""

import asyncio
import uuid

from app.config import get_settings
from domain import mac_tts
from domain.audio_runtime import (
    cache_voice_of,
    legacy_audio_route,
    resolve_explicit_voice,
    resolve_scene_route,
    tts_cache_path,
)
from domain.models import WordVoice

_gate = asyncio.Semaphore(4)


async def preload(text: str, scene: str, session_factory) -> bool:
    async with _gate:
        async with session_factory() as session:
            pinned = await session.get(WordVoice, text.lower()) if scene == "word" else None
            if pinned is not None:
                voice, rate = pinned.voice, pinned.rate
                if voice.startswith("mac:"):
                    route = None
                    identity = voice
                else:
                    provider, name, credentials = await resolve_explicit_voice(session, voice)
                    voice = name
                    route = legacy_audio_route(
                        f"tts-{scene}", provider_type=provider, model=name, credentials=credentials
                    )
                    identity = cache_voice_of(route, voice)[0]
            else:
                resolved = await resolve_scene_route(session, scene)
                route, voice, rate = resolved.route, resolved.voice_id, resolved.rate
                identity = cache_voice_of(route, voice)[0]
        path = tts_cache_path(get_settings().media_root, text.strip(), identity, rate)
        if path.exists():
            return True
        if route is None:
            await asyncio.to_thread(mac_tts.synthesize, text, voice, rate, path)
            return False
        result = await route.synthesize(text=text, voice=voice, rate=rate, cache_path=path)
        if result.stream is not None:
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_name(f"{path.stem}.{uuid.uuid4().hex}.part")
            try:
                with temporary.open("wb") as output:
                    async for chunk in result.stream:
                        output.write(chunk)
                temporary.replace(path)
            finally:
                await result.stream.aclose()
                temporary.unlink(missing_ok=True)
        elif result.path is None:
            raise ValueError("音频预加载未返回音频")
        return False
