"""百炼 Qwen、Cartesia 流式朗读与 MiniMax 对照试听。"""

import base64
import json
import time
import uuid
from collections.abc import AsyncIterator

import aiohttp

from domain.network_policy import routed_http_client, speech_proxy

CARTESIA_VERSION = "2026-08-14"
DEFAULT_MODELS = {
    "bailian_tts": "qwen3-tts-flash-realtime",
    "cartesia_tts": "sonic-3.6",
    "minimax_tts": "speech-2.8-turbo",
}
QWEN_VOICES = (
    ("Cherry", "芊悦", "Female"),
    ("Serena", "苏瑶", "Female"),
    ("Ethan", "晨煦", "Male"),
    ("Chelsie", "千雪", "Female"),
    ("Momo", "茉兔", "Female"),
    ("Vivian", "十三", "Female"),
    ("Moon", "月白", "Male"),
    ("Maia", "四月", "Female"),
    ("Kai", "凯", "Male"),
    ("Nofish", "不吃鱼", "Male"),
    ("Bella", "萌宝", "Female"),
    ("Jennifer", "詹妮弗", "Female"),
    ("Ryan", "甜茶", "Male"),
    ("Katerina", "卡捷琳娜", "Female"),
    ("Aiden", "艾登", "Male"),
    ("Eldric Sage", "沧明子", "Male"),
    ("Mia", "乖小妹", "Female"),
    ("Bellona", "燕铮莺", "Female"),
    ("Mochi", "沙小弥", "Male"),
    ("Vincent", "田叔", "Male"),
    ("Bunny", "萌小姬", "Female"),
    ("Neil", "阿闻", "Male"),
    ("Elias", "墨讲师", "Female"),
    ("Arthur", "徐大爷", "Male"),
    ("Nini", "邻家妹妹", "Female"),
    ("Seren", "小婉", "Female"),
    ("Pip", "顽屁小孩", "Male"),
    ("Stella", "少女阿月", "Female"),
    ("Bodega", "博德加", "Male"),
    ("Sonrisa", "索尼莎", "Female"),
    ("Alek", "阿列克", "Male"),
    ("Dolce", "多尔切", "Male"),
    ("Sohee", "素熙", "Female"),
    ("Ono Anna", "小野杏", "Female"),
    ("Lenn", "莱恩", "Male"),
    ("Emilien", "埃米尔安", "Male"),
    ("Andre", "安德雷", "Male"),
    ("Radio Gol", "拉迪奥戈尔", "Male"),
    ("Jada", "上海阿珍", "Female"),
    ("Dylan", "北京晓东", "Male"),
    ("Li", "南京老李", "Male"),
    ("Marcus", "陕西秦川", "Male"),
    ("Roy", "闽南阿杰", "Male"),
    ("Peter", "天津李彼得", "Male"),
    ("Sunny", "四川晴儿", "Female"),
    ("Eric", "四川程川", "Male"),
    ("Rocky", "粤语阿强", "Male"),
    ("Kiki", "粤语阿清", "Female"),
)


def headers(config: dict, provider: str) -> dict:
    key = config.get("api_key")
    if not key:
        raise ValueError("API Key 未配置")
    result = {"Authorization": f"Bearer {key}"}
    if provider == "cartesia_tts":
        result["Cartesia-Version"] = CARTESIA_VERSION
    return result


def bailian_endpoint(config: dict) -> str:
    model = config.get("model") or DEFAULT_MODELS["bailian_tts"]
    if model not in {"qwen3-tts-flash-realtime", "qwen3-tts-flash-realtime-2025-11-27"}:
        raise ValueError("百炼朗读支持 qwen3-tts-flash-realtime 及 2025-11-27 版本")
    region = config.get("region") or "beijing"
    hosts = {"beijing": "dashscope.aliyuncs.com", "singapore": "dashscope-intl.aliyuncs.com"}
    if region not in hosts:
        raise ValueError("百炼地域请选择 beijing 或 singapore，密钥必须属于同一地域")
    return f"wss://{hosts[region]}/api-ws/v1/realtime"


async def list_voices(config: dict, provider_type: str) -> list[dict]:
    auth = headers(config, provider_type)
    if provider_type == "bailian_tts":
        bailian_endpoint(config)
        return [
            {"id": voice, "label": f"{name} · {voice}", "locale": "multilingual", "gender": gender}
            for voice, name, gender in QWEN_VOICES
        ]
    async with routed_http_client(timeout=20) as client:
        if provider_type == "minimax_tts":
            response = await client.post(
                "https://api.minimax.cn/v1/get_voice", headers=auth, json={"voice_type": "all"}
            )
            response.raise_for_status()
            data = response.json()
            if data.get("base_resp", {}).get("status_code") != 0:
                raise ValueError("MiniMax 音色目录鉴权失败")
            return [
                {
                    "id": v["voice_id"],
                    "label": v.get("voice_name") or v["voice_id"],
                    "locale": "multilingual",
                    "gender": "",
                }
                for group in ("system_voice", "voice_cloning", "voice_generation")
                for v in data.get(group, [])
            ]
        voices, cursor = [], None
        for _ in range(100):
            params = {"limit": 100}
            if cursor:
                params["starting_after"] = cursor
            response = await client.get(
                "https://api.cartesia.ai/voices", headers=auth, params=params
            )
            response.raise_for_status()
            data = response.json()
            for voice in data["data"]:
                voices.append(
                    {
                        "id": voice["id"],
                        "label": voice.get("name") or voice["id"],
                        "locale": voice.get("language") or "multilingual",
                        "gender": voice.get("gender") or "",
                    }
                )
            if not data.get("has_more"):
                return voices
            next_cursor = data.get("next_page") or (
                data["data"][-1]["id"] if data["data"] else None
            )
            if not next_cursor or next_cursor == cursor:
                raise ValueError("Cartesia 音色目录分页无进展")
            cursor = next_cursor
        raise ValueError("Cartesia 音色目录超过分页上限")


async def synthesize(
    config: dict, provider: str, text: str, voice: str, rate: int, metrics: dict
) -> AsyncIterator[bytes]:
    started = time.monotonic()
    auth = headers(config, provider)
    model = config.get("model") or DEFAULT_MODELS[provider]
    speed = max(0.5, min(2.0, 1 + rate / 100))
    if provider == "bailian_tts":
        async with (
            aiohttp.ClientSession(trust_env=False) as client,
            client.ws_connect(
                bailian_endpoint(config),
                params={"model": model},
                headers=auth,
                proxy=await speech_proxy(),
                max_msg_size=2_000_000,
                receive_timeout=30,
            ) as ws,
        ):
            metrics["connection_ms"] = round((time.monotonic() - started) * 1000)
            await ws.send_json(
                {
                    "event_id": uuid.uuid4().hex,
                    "type": "session.update",
                    "session": {
                        "voice": voice,
                        "mode": "server_commit",
                        "response_format": "mp3",
                        "sample_rate": 24000,
                        "speech_rate": speed,
                        "language_type": "Auto",
                    },
                }
            )
            sent = False
            async for message in ws:
                if message.type != aiohttp.WSMsgType.TEXT:
                    raise ValueError("百炼语音连接中断")
                event = json.loads(message.data)
                if event["type"] == "session.updated" and not sent:
                    await ws.send_json(
                        {
                            "event_id": uuid.uuid4().hex,
                            "type": "input_text_buffer.append",
                            "text": text,
                        }
                    )
                    await ws.send_json({"event_id": uuid.uuid4().hex, "type": "session.finish"})
                    sent = True
                elif event["type"] == "response.audio.delta":
                    yield base64.b64decode(event["delta"], validate=True)
                elif event["type"] == "session.finished":
                    return
                elif event["type"] == "error":
                    raise ValueError("百炼合成失败，请检查模型、音色和账户额度")
            raise ValueError("百炼语音未正常结束")
    async with routed_http_client(timeout=30) as client:
        if provider == "cartesia_tts":
            async with client.stream(
                "POST",
                "https://api.cartesia.ai/tts/bytes",
                headers=auth,
                json={
                    "model_id": model,
                    "transcript": text,
                    "voice": voice,
                    "output_format": {
                        "container": "mp3",
                        "sample_rate": 44100,
                        "bit_rate": 128000,
                    },
                    "generation_config": {"speed": speed},
                },
            ) as response:
                response.raise_for_status()
                metrics["connection_ms"] = round((time.monotonic() - started) * 1000)
                if not response.headers.get("content-type", "").startswith("audio/"):
                    raise ValueError("Cartesia 未返回音频")
                async for chunk in response.aiter_bytes():
                    if chunk:
                        yield chunk
            return
        response = await client.post(
            "https://api.minimax.cn/v1/t2a_v2",
            headers=auth,
            json={
                "model": model,
                "text": text,
                "stream": False,
                "voice_setting": {"voice_id": voice, "speed": speed, "vol": 1, "pitch": 0},
                "audio_setting": {"format": "mp3", "sample_rate": 24000, "bitrate": 128000},
            },
        )
        response.raise_for_status()
        data = response.json()
        if data.get("base_resp", {}).get("status_code") != 0:
            raise ValueError("MiniMax 试听失败，请检查账户额度与音色")
        yield bytes.fromhex(data["data"]["audio"])
