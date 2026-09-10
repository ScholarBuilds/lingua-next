import base64
import io
import json
import wave
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from domain import azure_pronunciation, azure_speech, cloud_tts
from domain.audio_runtime import (
    AudioSynthesis,
    AudioSynthesisError,
    _primed_audio,
    cache_voice_of,
    legacy_audio_route,
)
from domain.models import ProviderCredential


class Chunks(httpx.AsyncByteStream):
    def __init__(self):
        self.tail = False
        self.closed = False

    async def __aiter__(self):
        yield b"ID3-first"
        self.tail = True
        yield b"second"

    async def aclose(self):
        self.closed = True


@pytest.mark.parametrize("provider", ["azure", "cartesia_tts"])
async def test_audio_is_yielded_before_tail_and_closes(monkeypatch, provider):
    chunks, metrics = Chunks(), {}
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, stream=chunks, headers={"content-type": "audio/mpeg"})

    module = azure_speech if provider == "azure" else cloud_tts
    monkeypatch.setattr(
        module,
        "routed_http_client",
        lambda **kw: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    config = {"region": "eastasia", "api_key": "test-only"}
    stream = (
        azure_speech.stream_synthesize(config, "Hello", "voice", metrics=metrics)
        if provider == "azure"
        else cloud_tts.synthesize(config, provider, "Hello", "voice", 0, metrics)
    )
    assert await anext(stream) == b"ID3-first"
    assert not chunks.tail
    assert metrics["connection_ms"] >= 0
    await stream.aclose()
    assert chunks.closed
    if provider == "cartesia_tts":
        assert requests[0].headers["Cartesia-Version"] == cloud_tts.CARTESIA_VERSION
        assert json.loads(requests[0].content)["voice"] == "voice"


async def test_primed_stream_can_close_before_consumer_starts():
    closed = []

    async def upstream():
        try:
            yield b"first"
            yield b"second"
        finally:
            closed.append(True)

    result = await _primed_audio("test", upstream())
    await result.stream.aclose()
    assert closed == [True]


async def test_empty_stream_rejected_before_response():
    async def empty():
        if False:
            yield b""

    with pytest.raises(AudioSynthesisError):
        await _primed_audio("test", empty())


async def test_cartesia_voice_catalog_follows_cursor(monkeypatch):
    queries = []

    def handler(request):
        queries.append(dict(request.url.params))
        index = len(queries)
        return httpx.Response(
            200,
            json={
                "data": [{"id": str(index), "name": f"Voice {index}", "language": "en"}],
                "has_more": index == 1,
                "next_page": "cursor-1",
            },
        )

    monkeypatch.setattr(
        cloud_tts,
        "routed_http_client",
        lambda **kw: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    voices = await cloud_tts.list_voices({"api_key": "test"}, "cartesia_tts")
    assert [v["id"] for v in voices] == ["1", "2"]
    assert queries[1]["starting_after"] == "cursor-1"


async def test_bailian_handshake_then_audio_and_finish(monkeypatch):
    sent, opened, closed = [], {}, []

    class Socket:
        async def send_json(self, value):
            sent.append(value)

        async def __aiter__(self):
            for event in [
                {"type": "session.updated"},
                {"type": "response.audio.delta", "delta": base64.b64encode(b"audio").decode()},
                {"type": "session.finished"},
            ]:
                yield SimpleNamespace(type=cloud_tts.aiohttp.WSMsgType.TEXT, data=json.dumps(event))

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            closed.append(True)

        @asynccontextmanager
        async def ws_connect(self, endpoint, **kwargs):
            opened.update(endpoint=endpoint, **kwargs)
            yield Socket()

    monkeypatch.setattr(cloud_tts.aiohttp, "ClientSession", lambda **kw: Client())
    monkeypatch.setattr(cloud_tts, "speech_proxy", AsyncMock(return_value=None))
    audio = b"".join(
        [
            chunk
            async for chunk in cloud_tts.synthesize(
                {"api_key": "test", "region": "beijing"}, "bailian_tts", "Hello", "Cherry", 10, {}
            )
        ]
    )
    assert audio == b"audio" and closed
    assert opened["endpoint"] == "wss://dashscope.aliyuncs.com/api-ws/v1/realtime"
    assert opened["proxy"] is None
    assert [e["type"] for e in sent] == [
        "session.update",
        "input_text_buffer.append",
        "session.finish",
    ]
    assert sent[0]["session"]["response_format"] == "mp3"
    assert sent[0]["session"]["speech_rate"] == 1.1


@pytest.mark.parametrize("config", [{"region": "evil.example"}, {"model": "qwen-tts-realtime"}])
def test_bailian_rejects_wrong_region_or_pcm_only_model(config):
    with pytest.raises(ValueError):
        cloud_tts.bailian_endpoint(config)


def test_cache_separates_account_model_and_options():
    def key(config, options=None):
        route = legacy_audio_route(
            "tts-word",
            provider_type="cartesia_tts",
            model="voice",
            credentials=config,
            protocol_options=options,
        )
        return cache_voice_of(route, "voice")[0]

    assert key({"api_key": "a"}) == key({"api_key": "a"})
    assert (
        len(
            {
                key({"api_key": "a"}),
                key({"api_key": "b"}),
                key({"api_key": "a", "model": "other"}),
                key({"api_key": "a"}, {"rate": 10}),
            }
        )
        == 4
    )


async def test_minimax_cannot_be_bound(client, session):
    credential = ProviderCredential(
        name="Compare", kind="tts", provider_type="minimax_tts", config={}
    )
    session.add(credential)
    await session.commit()
    response = await client.put(
        "/config/bindings/tts-word", json={"credential_id": credential.id, "target": "voice"}
    )
    assert response.status_code == 400


def wav_bytes(seconds=1, rate=16000):
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(b"\0\0" * int(seconds * rate))
    return output.getvalue()


@pytest.mark.parametrize(
    "audio", [b"bad", wav_bytes(0.1), wav_bytes(31), wav_bytes(rate=24000), wav_bytes()[:-10]]
)
def test_assessment_rejects_invalid_audio(audio):
    with pytest.raises(ValueError):
        azure_pronunciation.validate_wav(audio)


async def test_assessment_requests_word_scores_without_paid_prosody(monkeypatch):
    def handler(request):
        assert request.url.host == "eastasia.stt.speech.microsoft.com"
        options = json.loads(base64.b64decode(request.headers["Pronunciation-Assessment"]))
        assert options["ReferenceText"] == "Hello"
        assert "EnableProsodyAssessment" not in options
        return httpx.Response(
            200,
            json={
                "RecognitionStatus": "Success",
                "NBest": [
                    {
                        "Display": "Hello.",
                        "PronScore": 91,
                        "Words": [{"Word": "Hello", "AccuracyScore": 92, "ErrorType": "None"}],
                    }
                ],
            },
        )

    monkeypatch.setattr(
        azure_pronunciation,
        "routed_http_client",
        lambda **kw: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    result = await azure_pronunciation.assess(
        {"api_key": "test", "region": "eastasia"}, wav_bytes(), "Hello"
    )
    assert result["scores"]["PronScore"] == 91
    assert result["scores"]["ProsodyScore"] is None
    assert result["words"][0]["accuracy"] == 92


async def test_assessment_requires_enablement_and_per_request_consent(client, session, monkeypatch):
    from app.routers import pronunciation

    assess = AsyncMock(return_value={"scores": {}, "words": []})
    monkeypatch.setattr(pronunciation, "assess", assess)
    assert (await client.get("/config/pronunciation")).json()["enabled"] is False
    files = {"file": ("sample.wav", wav_bytes(), "audio/wav")}
    assert (
        await client.post(
            "/talk/pronunciation", files=files, data={"text": "Hello", "consent": "true"}
        )
    ).status_code == 409
    credential = ProviderCredential(
        name="Azure", kind="tts", provider_type="azure_speech", config={}
    )
    session.add(credential)
    await session.commit()
    assert (
        await client.put(
            "/config/pronunciation", json={"enabled": True, "credential_id": credential.id}
        )
    ).status_code == 200
    assert (
        await client.post("/talk/pronunciation", files=files, data={"text": "Hello"})
    ).status_code == 409
    assess.assert_not_called()
    result = await client.post(
        "/talk/pronunciation", files=files, data={"text": "Hello", "consent": "true"}
    )
    assert result.status_code == 200
    assess.assert_awaited_once()


async def test_tts_stream_fallback_does_not_pollute_original_cache(client, monkeypatch, tmp_path):
    from app.routers import tts

    calls = []

    async def run(route, **kwargs):
        calls.append(route.snapshot.plugin_id)
        if route.snapshot.plugin_id != "edge-tts":
            raise AudioSynthesisError("api", "unavailable")

        async def chunks():
            yield b"ID3-a"
            yield b"b"

        return AudioSynthesis(provider="edge", stream=chunks())

    monkeypatch.setattr(tts, "_run_synthesis", run)
    monkeypatch.setattr(tts, "_volc_credentials", AsyncMock(return_value={}))
    monkeypatch.setattr(
        tts, "_cache_path", lambda text, voice, rate: tmp_path / f"{voice.replace(':', '-')}.mp3"
    )
    response = await client.get("/tts", params={"text": "Hello", "voice": "volc:original"})
    assert response.content == b"ID3-ab"
    assert not (tmp_path / "volc-original.mp3").exists()
    assert (tmp_path / "en-US-AriaNeural.mp3").read_bytes() == b"ID3-ab"
    await client.get("/tts", params={"text": "Hello", "voice": "edge:en-US-AriaNeural"})
    assert calls == ["volcengine", "edge-tts"]


async def test_turn_stream_emits_sentences_and_persists_once(client, monkeypatch):
    from app.routers import talk

    async def generate(*args):
        yield {"type": "sentence", "text": "Hello, nice to meet you."}
        yield {"type": "result", "reply": "Hello, nice to meet you.", "feedback": None}

    monkeypatch.setattr(talk, "stream_chat_turn", generate)
    created = (await client.post("/talk/sessions", json={"mode": "text"})).json()
    response = await client.post(
        f"/talk/sessions/{created['id']}/turns/text?stream=true", json={"text": "Hello"}
    )
    events = [json.loads(line) for line in response.text.splitlines()]
    assert [e["type"] for e in events] == ["sentence", "done"]
    detail = (await client.get(f"/talk/sessions/{created['id']}")).json()
    assert len(detail["turns"]) == 2


async def test_incremental_reply_waits_for_sentence_and_handles_changed_final(monkeypatch):
    from domain import talk

    async def generate(*args):
        raw = '{"reply":"Hello, welcome to the hotel. How can I help you?'
        for char in raw:
            yield {"type": "delta", "text": char}
        yield {"type": "done", "result": {"reply": "Welcome back!", "feedback": None}}

    monkeypatch.setattr(talk, "stream_json", generate)
    events = [e async for e in talk.stream_chat_turn(SimpleNamespace(difficulty="easy"), [], "Hi")]
    assert events[0] == {"type": "sentence", "text": "Hello, welcome to the hotel."}
    assert events[1] == {"type": "reset"}
    assert events[2]["text"] == "Welcome back!"
    assert events[-1]["type"] == "result"
