"""Azure Speech 区域音色目录与 SSML 合成。"""

import re
import time
from collections.abc import AsyncIterator
from xml.sax.saxutils import escape, quoteattr

from domain.network_policy import routed_http_client


def endpoint(config: dict) -> str:
    region = str(config.get("region", "")).strip().lower()
    if not re.fullmatch(r"[a-z][a-z0-9]{1,40}", region):
        raise ValueError("Azure Region 格式不正确")
    if not config.get("api_key"):
        raise ValueError("Azure Subscription Key 未配置")
    return f"https://{region}.tts.speech.microsoft.com/cognitiveservices"


async def list_voices(config: dict, provider_type: str = "azure_speech") -> list[dict]:
    async with routed_http_client(timeout=20.0) as client:
        response = await client.get(
            f"{endpoint(config)}/voices/list",
            headers={"Ocp-Apim-Subscription-Key": config["api_key"]},
        )
        response.raise_for_status()
    return [
        {
            "id": voice["ShortName"],
            "label": voice.get("LocalName") or voice["ShortName"],
            "locale": voice["Locale"],
            "gender": voice["Gender"],
            "styles": voice.get("StyleList", []),
        }
        for voice in response.json()
    ]


async def synthesize(config: dict, text: str, voice: str, rate: int = 0) -> bytes:
    return b"".join([chunk async for chunk in stream_synthesize(config, text, voice, rate)])


async def stream_synthesize(
    config: dict, text: str, voice: str, rate: int = 0, *, metrics: dict | None = None
) -> AsyncIterator[bytes]:
    started = time.monotonic()
    url = endpoint(config)
    locale = "-".join(voice.split("-")[:2])
    ssml = (
        f'<speak version="1.0" xml:lang={quoteattr(locale)}>'
        f'<voice name={quoteattr(voice)}><prosody rate="{rate:+d}%">'
        f"{escape(text)}</prosody></voice></speak>"
    )
    async with (
        routed_http_client(timeout=30.0) as client,
        client.stream(
            "POST",
            f"{url}/v1",
            headers={
                "Ocp-Apim-Subscription-Key": config["api_key"],
                "Content-Type": "application/ssml+xml",
                "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
            },
            content=ssml.encode(),
        ) as response,
    ):
        response.raise_for_status()
        if metrics is not None:
            metrics["connection_ms"] = round((time.monotonic() - started) * 1000)
        if not response.headers.get("content-type", "").startswith("audio/"):
            raise ValueError("Azure 返回内容不是音频")
        received = False
        async for chunk in response.aiter_bytes():
            if chunk:
                received = True
                yield chunk
        if not received:
            raise ValueError("Azure 未返回音频")
