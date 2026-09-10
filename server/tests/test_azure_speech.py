from unittest.mock import AsyncMock

import httpx
import pytest

from domain import azure_speech


@pytest.mark.parametrize("region", ["", "../other", "eastasia.evil.test", "east asia"])
def test_region_cannot_redirect_credentials(region):
    with pytest.raises(ValueError):
        azure_speech.endpoint({"region": region, "api_key": "test-key"})


async def test_directory_preserves_languages_and_synthesis_escapes_xml(monkeypatch):
    requests = []

    def handler(request):
        requests.append(request)
        assert request.headers["Ocp-Apim-Subscription-Key"] == "test-key"
        assert request.url.host == "eastasia.tts.speech.microsoft.com"
        if request.method == "GET":
            return httpx.Response(
                200,
                json=[
                    {
                        "ShortName": "ja-JP-NanamiNeural",
                        "LocalName": "七海",
                        "Locale": "ja-JP",
                        "Gender": "Female",
                        "StyleList": ["cheerful"],
                    }
                ],
            )
        return httpx.Response(200, content=b"ID3-test", headers={"content-type": "audio/mpeg"})

    monkeypatch.setattr(
        azure_speech,
        "routed_http_client",
        lambda **kw: httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            **kw,
        ),
    )
    config = {"region": "eastasia", "api_key": "test-key"}
    voices = await azure_speech.list_voices(config)
    assert voices[0]["locale"] == "ja-JP"
    assert voices[0]["styles"] == ["cheerful"]
    assert await azure_speech.synthesize(config, "A & B < C", voices[0]["id"], 10) == b"ID3-test"
    assert b"A &amp; B &lt; C" in requests[1].content
    assert b'rate="+10%"' in requests[1].content


async def test_synthesis_rejects_non_audio_success(monkeypatch):
    monkeypatch.setattr(
        azure_speech,
        "routed_http_client",
        lambda **kw: httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda request: httpx.Response(200, json={"error": "upstream"})
            ),
            **kw,
        ),
    )
    with pytest.raises(ValueError, match="不是音频"):
        await azure_speech.synthesize(
            {"region": "eastasia", "api_key": "test-key"}, "hello", "en-US-AriaNeural"
        )


async def test_explicit_azure_voice_keeps_credential_identity(
    client, session, monkeypatch, tmp_path
):
    from app.routers import tts
    from domain.audio_runtime import AudioSynthesis
    from domain.models import ProviderCredential

    cred = ProviderCredential(name="Azure", kind="tts", provider_type="azure_speech", config={})
    session.add(cred)
    await session.commit()
    sample = tmp_path / "sample.mp3"
    sample.write_bytes(b"audio")
    run = AsyncMock(return_value=AudioSynthesis(provider="azure", path=sample))
    monkeypatch.setattr(tts, "_run_synthesis", run)
    monkeypatch.setattr(tts, "_cache_path", lambda *args: tmp_path / "uncached.mp3")
    response = await client.get(
        "/tts", params={"text": "hello", "voice": f"azure:{cred.id}:en-US-AriaNeural"}
    )
    assert response.status_code == 200
    assert run.call_args.args[0].snapshot.plugin_id == "azure-speech"
    assert run.call_args.kwargs["voice_id"] == "en-US-AriaNeural"
    assert (
        await client.get("/tts", params={"text": "hello", "voice": "azure:bad"})
    ).status_code == 422
