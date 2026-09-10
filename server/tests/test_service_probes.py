from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from app.routers import service_probes
from domain.audio_runtime import AudioSynthesis
from domain.models import CapabilityBinding, ProviderCredential
from domain.volc_realtime import ServerEvent, VolcRealtimeError


async def test_voice_probe_uses_bound_credential_and_cleans_sample(client, session, monkeypatch):
    cred = ProviderCredential(
        name="Edge",
        kind="tts",
        provider_type="edge_tts",
        config={},
        models_cache={"items": [{"id": "en-US-AriaNeural", "locale": "en-US"}]},
    )
    session.add(cred)
    await session.flush()
    session.add(
        CapabilityBinding(
            capability="tts-word",
            credential_id=cred.id,
            target="en-US-AriaNeural",
            params={"rate": 10},
        )
    )
    await session.commit()
    paths = []

    async def synthesize(**kwargs):
        path = kwargs["cache_path"]
        paths.append(path)
        assert kwargs["rate"] == 10
        path.write_bytes(b"ID3-test")
        return AudioSynthesis(provider="edge", path=path)

    factory = Mock(return_value=SimpleNamespace(synthesize=synthesize))
    monkeypatch.setattr(service_probes, "legacy_audio_route", factory)
    result = await client.post("/config/voice-probe", json={"capability": "tts-word"})
    assert result.status_code == 200 and result.json()["ok"]
    assert result.json()["audio"] == "SUQzLXRlc3Q="
    assert not paths[0].exists()
    assert factory.call_args.kwargs["provider_type"] == "edge_tts"
    assert (
        await client.post(
            "/config/voice-probe", json={"credential_id": cred.id, "voice": "unknown"}
        )
    ).status_code == 422


@pytest.mark.parametrize("failure", [None, "connect", "empty", "error"])
async def test_realtime_probe_requires_audio_and_always_closes(client, monkeypatch, failure):
    from domain import volc_realtime

    socket = AsyncMock()
    socket.receive.side_effect = [ServerEvent(event=100), ServerEvent(audio=b"pcm")]
    if failure == "connect":
        socket.connect.side_effect = VolcRealtimeError("握手失败")
    elif failure == "empty":
        socket.receive.side_effect = [None]
    elif failure == "error":
        socket.receive.side_effect = [ServerEvent(error_code=403)]
    route = SimpleNamespace(open_client=lambda: socket, snapshot=SimpleNamespace(model=""))
    monkeypatch.setattr(volc_realtime, "resolve_realtime_route", AsyncMock(return_value=route))
    result = await client.post("/config/realtime-probe", json={})
    assert result.status_code == 200
    assert result.json()["ok"] is (failure is None)
    socket.close.assert_awaited_once()
    socket.send_audio.assert_not_called()


async def test_translation_probe_rejects_unknown_engine(client):
    result = await client.post("/config/translation-probe", json={"engine": "untrusted"})
    assert result.status_code == 422


async def test_realtime_preview_returns_wav_and_closes_without_microphone(client, monkeypatch):
    import base64
    import io
    import wave

    from domain import volc_realtime

    socket = AsyncMock()
    socket.receive.side_effect = [
        ServerEvent(audio=b"\x01\x00" * 1200),
        ServerEvent(event=volc_realtime.EVENT_TTS_ENDED),
    ]
    route = SimpleNamespace(open_client=lambda: socket, snapshot=SimpleNamespace(model=""))
    monkeypatch.setattr(volc_realtime, "resolve_realtime_route", AsyncMock(return_value=route))
    response = await client.post("/config/realtime-probe", json={"preview": True})
    result = response.json()
    assert result["ok"] and result["mime_type"] == "audio/wav"
    with wave.open(io.BytesIO(base64.b64decode(result["audio"]))) as audio:
        assert audio.getframerate() == 24000
        assert audio.getnchannels() == 1
        assert audio.getnframes() == 1200
    socket.close.assert_awaited_once()
    socket.send_audio.assert_not_called()


async def test_voice_probe_honors_preview_sample_and_rate(client, session, monkeypatch):
    cred = ProviderCredential(
        name="Edge",
        kind="tts",
        provider_type="edge_tts",
        config={},
        models_cache={"items": [{"id": "en-US-AriaNeural", "locale": "en-US"}]},
    )
    session.add(cred)
    await session.commit()

    async def synthesize(**kwargs):
        assert kwargs["rate"] == -25
        assert kwargs["text"] == "A custom sample."
        kwargs["cache_path"].write_bytes(b"ID3-test")
        return AudioSynthesis(provider="edge", path=kwargs["cache_path"])

    monkeypatch.setattr(
        service_probes,
        "legacy_audio_route",
        lambda *a, **kw: SimpleNamespace(synthesize=synthesize),
    )
    response = await client.post(
        "/config/voice-probe",
        json={
            "credential_id": cred.id,
            "voice": "en-US-AriaNeural",
            "rate": -25,
            "sample": " A custom sample. ",
        },
    )
    assert response.json()["ok"]
    invalid = await client.post("/config/voice-probe", json={"rate": 101})
    assert invalid.status_code == 422
