"""火山豆包 TTS 2.0 单向流式合成：HTTP Chunked 逐行 JSON，音频 base64 增量下发。

接口 POST https://openspeech.bytedance.com/api/v3/tts/unidirectional
（文档《HTTP Chunked/SSE单向流式-V3》 https://www.volcengine.com/docs/6561/1598757 ）：
响应为 chunked NDJSON，每行一个 JSON 包——code=0 且 data 非空为 base64 音频增量，
code=0 且 data 为 null 是 sentence 时间戳帧，code=20000000 表示合成结束，其余 code 为错误
（45000000 音色未授权、40402003 文本超限、55000000 服务端错误）。

音色目录取自官方音色列表（豆包语音合成模型2.0 · 多语种 uranus 系列，
https://www.volcengine.com/docs/6561/1257544 ），收录前逐一实测 code=0。
"""

import asyncio
import base64
import json
import uuid
from collections.abc import AsyncGenerator, AsyncIterator

import aiohttp

from domain.model_invocations import ModelInvocationSpan
from domain.network_policy import speech_proxy

TTS_URL = "https://openspeech.bytedance.com/api/v3/tts/unidirectional"
RESOURCE_ID = "seed-tts-2.0"
END_CODE = 20000000

# 官方 2.0 多语种音色（uranus 系列），2026-08-17 逐一实测 code=0 通过
VOLC_VOICES: tuple[dict, ...] = (
    {
        "id": "en_female_skye_uranus_bigtts",
        "label": "Skye · 美音女声（通用）",
        "gender": "Female",
        "locale": "en-US",
    },
    {
        "id": "en_female_dacey_uranus_bigtts",
        "label": "Dacey · 美音女声（清亮）",
        "gender": "Female",
        "locale": "en-US",
    },
    {
        "id": "en_male_tim_uranus_bigtts",
        "label": "Tim · 美音男声（通用）",
        "gender": "Male",
        "locale": "en-US",
    },
    {
        "id": "en_male_david_uranus_bigtts",
        "label": "David · 美音男声（有声阅读）",
        "gender": "Male",
        "locale": "en-US",
    },
    {
        "id": "en_female_authoritative-british_uranus_bigtts",
        "label": "Charlotte · 英伦腔女声（教学）",
        "gender": "Female",
        "locale": "en-GB",
    },
    {
        "id": "en_male_knightley_uranus_bigtts",
        "label": "Knightley · 男声（沉稳叙述）",
        "gender": "Male",
        "locale": "en-US",
    },
)


class VolcTTSError(Exception):
    """火山 TTS 调用失败：网络 / 鉴权 / 音色未授权 / 服务端错误。"""


def parse_chunk(line: bytes | str) -> tuple[bytes, bool]:
    """单行 NDJSON → (音频字节, 是否结束帧)；sentence 帧返回 (b"", False)，错误码抛异常。"""
    try:
        packet = json.loads(line)
    except ValueError as exc:
        preview = line[:120] if isinstance(line, str) else line[:120].decode(errors="replace")
        raise VolcTTSError(f"响应非 JSON：{preview}") from exc
    code = packet.get("code", -1)
    if code == END_CODE:
        return b"", True
    if code != 0:
        raise VolcTTSError(f"code={code}: {str(packet.get('message', ''))[:200]}")
    data = packet.get("data")
    if not data:
        return b"", False
    try:
        return base64.b64decode(data), False
    except (ValueError, TypeError) as exc:
        raise VolcTTSError("音频 base64 解码失败") from exc


async def iter_ndjson_lines(chunks: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
    """把任意切块的字节流重组为完整 NDJSON 行；单行可超 64KB，不能用 readline。"""
    buf = b""
    async for chunk in chunks:
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            if line.strip():
                yield line
    if buf.strip():
        yield buf


async def stream_synthesize(
    text: str,
    voice: str,
    rate: int = 0,
    *,
    app_id: str,
    access_key: str,
    deployment_id: int | None = None,
    capability: str = "tts",
    plugin_version: str | None = None,
    plugin_generation: int | None = None,
    runtime_generation: int | None = None,
    route_view: dict | None = None,
) -> AsyncGenerator[bytes, None]:
    """流式合成：逐块 yield mp3 字节，收到结束帧停止；任何失败抛 VolcTTSError。

    凭据由调用方从配置中心凭据库解析传入（模块 11，替代 .env 路径）。
    rate 与 edge-tts 同口径的百分比语速，压到火山 speech_rate 有效区间 [-50, 100]。
    """
    request_id = str(uuid.uuid4())
    span = await ModelInvocationSpan(
        plugin_id="volcengine",
        plugin_version=plugin_version,
        plugin_generation=plugin_generation,
        runtime_generation=runtime_generation,
        operation="audio.synthesize",
        model=voice,
        capability=capability,
        deployment_id=deployment_id,
        request={
            "text": text,
            "voice": voice,
            "rate": rate,
            "request_id": request_id,
            "route": route_view,
        },
    ).start()
    chunk_count = 0
    byte_count = 0
    ended = False
    try:
        if not (app_id and access_key):
            raise VolcTTSError("火山 TTS 凭据未配置（配置中心添加 volc_speech 凭据）")
        headers = {
            "X-Api-App-Id": app_id,
            "X-Api-Access-Key": access_key,
            "X-Api-Resource-Id": RESOURCE_ID,
            "X-Api-Request-Id": request_id,
        }
        body = {
            "user": {"uid": "lingua"},
            "req_params": {
                "text": text,
                "speaker": voice,
                "audio_params": {
                    "format": "mp3",
                    "sample_rate": 24000,
                    "speech_rate": max(-50, min(100, rate)),
                },
            },
        }
        timeout = aiohttp.ClientTimeout(total=120, connect=10, sock_read=30)
        proxy = await speech_proxy()
        try:
            async with (
                aiohttp.ClientSession(timeout=timeout) as http,
                http.post(TTS_URL, json=body, headers=headers, proxy=proxy) as resp,
            ):
                if resp.status != 200:
                    detail = (await resp.text())[:200]
                    raise VolcTTSError(f"HTTP {resp.status}: {detail}")
                async for line in iter_ndjson_lines(resp.content.iter_any()):
                    audio, ended = parse_chunk(line)
                    if audio:
                        chunk_count += 1
                        byte_count += len(audio)
                        yield audio
                    if ended:
                        break
        except (aiohttp.ClientError, TimeoutError) as exc:
            raise VolcTTSError(f"网络错误：{type(exc).__name__}: {exc}") from exc
    except asyncio.CancelledError as exc:
        await span.fail(exc, status="cancelled")
        raise
    except GeneratorExit as exc:
        await span.fail(exc, status="abandoned")
        raise
    except BaseException as exc:
        await span.fail(exc)
        raise
    await span.succeed(
        response={
            "resource_id": RESOURCE_ID,
            "voice": voice,
            "chunk_count": chunk_count,
            "audio_bytes": byte_count,
            "received_end_frame": ended,
        },
        provider_request_id=request_id,
    )
