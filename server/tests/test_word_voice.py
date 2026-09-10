"""按词钉死的发音音色（FR-495）与释义朗读场景（tts-meaning）。"""

from types import SimpleNamespace

from domain.credentials import encrypt_config
from domain.models import ProviderCredential


async def test_word_voice_crud_normalizes_word(client):
    r = await client.put("/tts/word-voices/ Apple ", json={"voice": "edge:en-GB-SoniaNeural"})
    assert r.status_code == 200, r.text
    assert r.json() == {"word": "apple", "voice": "edge:en-GB-SoniaNeural", "rate": 0}

    r = await client.put(
        "/tts/word-voices/apple", json={"voice": "edge:en-US-AriaNeural", "rate": -10}
    )
    assert r.json()["voice"] == "edge:en-US-AriaNeural" and r.json()["rate"] == -10

    r = await client.get("/tts/word-voices")
    assert r.json() == {
        "voices": {"apple": {"voice": "edge:en-US-AriaNeural", "rate": -10}},
        "epoch": 0,
    }

    r = await client.delete("/tts/word-voices/APPLE")
    assert r.json() == {"ok": True, "word": "apple"}
    assert (await client.get("/tts/word-voices")).json() == {"voices": {}, "epoch": 0}


async def test_word_voice_rejects_bad_word_and_bad_voice(client):
    r = await client.put(f"/tts/word-voices/{'a' * 65}", json={"voice": "edge:x"})
    assert r.status_code == 422
    r = await client.put("/tts/word-voices/%20", json={"voice": "edge:x"})
    assert r.status_code == 422
    # 三段式前缀缺凭据 id
    r = await client.put("/tts/word-voices/apple", json={"voice": "azure:nope"})
    assert r.status_code == 422
    r = await client.put("/tts/word-voices/apple", json={"voice": "edge:x", "rate": 500})
    assert r.status_code == 422


async def test_word_voice_rejects_disabled_credential(client, session):
    cred = ProviderCredential(
        name="azure",
        kind="tts",
        provider_type="azure_speech",
        enabled=False,
        config=encrypt_config({"api_key": "k", "region": "eastus"}),
    )
    session.add(cred)
    await session.commit()
    r = await client.put(
        "/tts/word-voices/apple", json={"voice": f"azure:{cred.id}:en-US-JennyNeural"}
    )
    assert r.status_code == 409


async def test_meaning_scene_falls_back_to_chinese_edge_voice(client, monkeypatch, tmp_path):
    from app.routers import tts as tts_router

    seen: dict = {}

    async def fake_synthesis(prepared, *, text, voice_id, rate, path):
        seen["voice"] = voice_id
        seen["plugin"] = prepared.snapshot.plugin_id
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"ID3fake")
        return SimpleNamespace(path=path, provider="edge-tts", stream=None)

    monkeypatch.setattr(tts_router, "_run_synthesis", fake_synthesis)
    monkeypatch.setattr(
        tts_router, "_cache_path", lambda text, voice, rate: tmp_path / f"{voice}.mp3"
    )
    r = await client.get("/tts", params={"text": "苹果，水果", "scene": "meaning"})
    assert r.status_code == 200, r.text
    assert seen["voice"] == "zh-CN-XiaoxiaoNeural" and seen["plugin"] == "edge-tts"

    # 英文场景没绑定仍是 503，不悄悄换音色
    r = await client.get("/tts", params={"text": "apple", "scene": "word"})
    assert r.status_code == 503


async def test_meaning_capability_listed_in_bindings(client):
    r = await client.get("/config/bindings")
    assert r.status_code == 200, r.text
    caps = {row["capability"] for row in r.json()}
    assert "tts-meaning" in caps
