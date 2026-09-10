from contextlib import asynccontextmanager
from types import SimpleNamespace

from domain import tts_preload
from domain.audio_runtime import AudioSynthesis, tts_cache_path


async def test_preload_writes_playback_cache_and_skips_existing(tmp_path, monkeypatch):
    class Session:
        async def get(self, *_args):
            return None

    @asynccontextmanager
    async def factory():
        yield Session()

    calls = []

    async def chunks():
        yield b"audio"

    async def synthesize(**kwargs):
        calls.append(kwargs)
        return AudioSynthesis(provider="test", stream=chunks())

    route = SimpleNamespace(synthesize=synthesize)

    async def resolve(*_args):
        return SimpleNamespace(route=route, voice_id="voice", rate=0)

    monkeypatch.setattr(
        tts_preload, "get_settings", lambda: SimpleNamespace(media_root=str(tmp_path))
    )
    monkeypatch.setattr(tts_preload, "resolve_scene_route", resolve)
    monkeypatch.setattr(tts_preload, "cache_voice_of", lambda *_: ("voice", "test"))
    assert not await tts_preload.preload("hello", "word", factory)
    assert tts_cache_path(str(tmp_path), "hello", "voice", 0).read_bytes() == b"audio"
    assert await tts_preload.preload("hello", "word", factory)
    assert len(calls) == 1
