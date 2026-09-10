"""按本清 TTS 缓存的两半：目录求交删文件、浏览器缓存代（FR-499）。"""

from domain import tts_cache
from domain.audio_runtime import EDGE_FALLBACK_VOICE, tts_cache_path
from domain.models import WordVoice


def _touch(root, word, voice, rate=0):
    path = tts_cache_path(str(root), word, voice, rate)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"ID3" + word.encode())
    return path


def test_purge_removes_only_words_in_scope(tmp_path):
    kept = _touch(tmp_path, "zebra", "en-US-AriaNeural")
    doomed = [
        _touch(tmp_path, "apple", "en-US-AriaNeural"),
        _touch(tmp_path, "apple", "volc:en_female_x", -10),
        _touch(tmp_path, "pear", "en-US-AriaNeural"),
    ]
    stray = tmp_path / "tts" / "not-a-cache.txt"
    stray.write_text("x")

    files, mb = tts_cache.purge_word_audio(
        str(tmp_path), {"apple", "pear"}, {"en-US-AriaNeural", "volc:en_female_x"}, {0, -10}
    )
    assert files == 3
    assert mb >= 0
    assert kept.exists() and stray.exists()
    assert not any(p.exists() for p in doomed)


def test_purge_on_missing_dir_is_noop(tmp_path):
    assert tts_cache.purge_word_audio(str(tmp_path), {"apple"}, {"x"}, {0}) == (0, 0.0)


async def test_epoch_starts_at_zero_and_bumps(session):
    assert await tts_cache.current_epoch(session) == 0
    assert await tts_cache.bump_epoch(session) == 1
    await session.commit()
    assert await tts_cache.bump_epoch(session) == 2
    await session.commit()
    assert await tts_cache.current_epoch(session) == 2


async def test_candidate_voices_cover_fallbacks_and_pinned(session):
    session.add(WordVoice(word="apple", voice="edge:en-GB-RyanNeural", rate=-10))
    await session.commit()
    voices, rates = await tts_cache.candidate_voices(session)
    assert EDGE_FALLBACK_VOICE in voices
    assert set(tts_cache.ACCENT_EDGE_VOICES) <= voices
    assert "en-GB-RyanNeural" in voices
    assert {0, -10} <= rates
