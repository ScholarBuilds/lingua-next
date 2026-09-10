"""按本清发音缓存端点（FR-499）：只删本内词的文件，代号 +1。"""

from app.config import get_settings
from domain.audio_runtime import tts_cache_path
from domain.models import Wordlist, WordlistItem


def _touch(root, word, voice, rate=0):
    path = tts_cache_path(str(root), word, voice, rate)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"ID3" + word.encode())
    return path


async def test_clear_deck_audio_cache_removes_only_deck_words(
    client, session, tmp_path, monkeypatch
):
    monkeypatch.setattr(get_settings(), "media_root", str(tmp_path), raising=False)
    custom = Wordlist(name="厨房用具")
    session.add(custom)
    await session.flush()
    session.add_all(
        [
            WordlistItem(wordlist_id=custom.id, word="spoon"),
            WordlistItem(wordlist_id=custom.id, word="bowl"),
        ]
    )
    await session.commit()

    doomed = [
        _touch(tmp_path, "spoon", "en-US-AriaNeural"),
        _touch(tmp_path, "bowl", "en-GB-SoniaNeural"),
    ]
    kept = _touch(tmp_path, "zebra", "en-US-AriaNeural")

    r = await client.post(f"/wordlists/custom:{custom.id}/clear-audio-cache")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["words"] == 2 and body["files"] == 2 and body["epoch"] == 1
    assert not any(p.exists() for p in doomed)
    assert kept.exists()

    assert (await client.get("/tts/word-voices")).json()["epoch"] == 1
    assert (await client.post("/wordlists/nope/clear-audio-cache")).status_code == 404


async def test_global_clear_bumps_epoch_too(client, tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "media_root", str(tmp_path), raising=False)
    _touch(tmp_path, "spoon", "en-US-AriaNeural")
    r = await client.post("/config/clear-tts-cache")
    assert r.status_code == 200, r.text
    assert r.json()["files"] == 1 and r.json()["epoch"] == 1
