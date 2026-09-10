"""火山豆包大模型录音文件识别（极速版）：同步 HTTP，一次调用出整片转写。

接口 POST https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash
（《录音文件识别极速版HTTP》 https://docs.volcengine.com/docs/6561/2608628 ）。

> [!warning] 别引 1354869，那是另一个东西
>
> 搜「火山 大模型语音识别」很容易命中 6561/1354869，但那是**流式 WebSocket**
> （wss://openspeech.bytedance.com/api/v3/sauc/bigmodel），而且已归入官方的「历史文档」。
> 协议、端点、鉴权头全不一样，照它写会 401 且报错不指向这里。

计费：录音文件识别有 20 小时免费试用额度，但**要手动去控制台领**——
官方计费概述（ https://www.volcengine.com/docs/6561/1359369 ）原话是
「免费试用及服务开通等操作均需手动前往豆包语音控制台开启」，
入口 https://console.volcengine.com/speech/new/overview?projectName=default 。
额度耗尽后转按量计费，此时上游会拒（4500xxxx 段），
`transcribe_with_fallback` 会降级到本地 whisper，不会让整条管线挂掉。

下面这些字段与行为是本机对真实接口实测出来的，不是照文档抄的。
鉴权与 TTS 同一套 header，但**状态码在响应头 `X-Api-Status-Code` 里，body 只放结果**
（TTS 那边是 NDJSON、状态在每行 JSON 内），照抄 volc_tts 的解析会把成功当失败。

与本地 faster-whisper 的同素材实测（7 条视频 / 46 分钟音频 / 5654 个同词配对，
2026-08-30，脚本 `scripts/compare_asr.py`）：

| | whisper large-v3 int8 + CTC 对齐 | 火山极速版 |
| --- | --- | --- |
| 转写 46 分钟音频 | 2035s（实时率 0.739×） | 93s（0.034×） |
| 常驻内存 | 3.4 GB | 0 |
| 词序列一致度 | — | 中位 97.7%（89.9%–100%） |
| 零宽词跨度 | 333（占 5.4%） | 0 |

时间戳对标 CTC 强制对齐：绝对偏移中位 50ms，±100ms 内 79%，±200ms 内 92%，
带符号中位 −20ms（一致偏早）。比 CTC 松，但没有零宽跨度——后者是渲染不出来的死数据。
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import shutil
import subprocess
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

import aiohttp

from domain.network_policy import speech_proxy
from domain.subtitles import Cue
from domain.transcribe import (
    ASR_OPERATION,
    AsrTranscript,
    PreparedAsrRoute,
    RouteRequest,
    prepare_asr_route,
    register_asr_route_provider,
)

logger = logging.getLogger(__name__)

FLASH_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash"
FLASH_RESOURCE_ID = "volc.bigasr.auc_turbo"
VOLC_ASR_PLUGIN_ID = "volc-asr"
VOLC_ASR_PROVIDER_TYPE = "volc_speech"
# 上游用它表示「一切正常」，与 TTS 的 20000000 同一套码表
OK_STATUS = "20000000"
SAMPLE_RATE = 16000
OPUS_BITRATE = "24k"
# 上游 audio.format 的取值，与 opus_bytes 的容器一致
AUDIO_FORMAT = "ogg"
# 上游 flash 接口的音频大小上限。24kbps opus 下约 6 小时，实际到不了
MAX_AUDIO_BYTES = 100 * 1024 * 1024
MAX_ATTEMPTS = 3


class VolcAsrError(RuntimeError):
    """凭据缺失、上游拒绝或网络反复失败。"""


class NoAudioTrack(VolcAsrError):
    """媒体里没有音轨。这不是失败，是「没有语音可转」——与本地 whisper 同口径。"""


def probe_audio(media_path: str) -> float | None:
    """有音轨返回容器时长（秒），没有返回 None。

    本地 whisper 那条路对无音轨样片是 `return [], duration`（transcribe.py:63-66），
    整条视频管线照常跑完、体检记 `no_track` 判 degraded。火山这条要对齐这个行为——
    抛异常的话 `pipeline.step()` 会重抛，整片入库直接 failed，
    同一个输入两条路结果不同是最难查的那种差异。
    """
    import av

    with av.open(media_path) as container:
        has_audio = any(s.type == "audio" for s in container.streams)
        duration = (container.duration or 0) / av.time_base
    return duration if has_audio else None


def opus_bytes(media_path: str) -> bytes:
    """媒体 → 16kHz 单声道 ogg/opus 24kbps 字节流。

    > [!danger] 别用无损 WAV，32 分钟的片子传不过去
    >
    > 首版传 16k/16bit WAV：32 分钟 = 60MB → base64 82MB → 加 json 序列化的副本，
    > 实测进程峰值 RSS **485MB**，而 worker `max_jobs=4`，四条视频撞一起约 1.9GB。
    > 更要命的是上游 100MB 上限对应只有约 39 分钟，而且**实测 58.8MB 的 WAV 直接
    > 504 网关超时**——不是理论风险，是当天就复现的。
    >
    > 同一条 32 分钟音频，opus 24kbps 是 **5.3MB**（11 倍）、上游 16.5s 出结果（3.5 倍），
    > 转写质量对无损 WAV 的词序列一致度 **97.24%**——而上游对同一份音频跑两次
    > 本身就有约 3% 的抖动（差异集中在笑声这类非语音内容），所以这点差在噪声里。
    > 100MB 上限自此对应约 6 小时而不是 39 分钟。
    >
    > 转码走 ffmpeg 子进程管道而不是 PyAV 逐帧循环：同一条片子 16.1s vs 59.8s，
    > 峰值 28MB vs 64MB。ffmpeg 本来就是硬依赖（Dockerfile 装、phoneme_audio 也查它）。
    """
    if shutil.which("ffmpeg") is None:
        raise VolcAsrError("未安装 ffmpeg，无法转码上传")
    proc = subprocess.run(
        [
            "ffmpeg", "-nostdin", "-v", "error", "-i", media_path,
            "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE),
            "-c:a", "libopus", "-b:a", OPUS_BITRATE, "-f", "ogg", "pipe:1",
        ],
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0 or not proc.stdout:
        detail = proc.stderr.decode("utf-8", "replace")[:200]
        raise VolcAsrError(f"音频转码失败（rc={proc.returncode}）：{detail}")
    if len(proc.stdout) > MAX_AUDIO_BYTES:
        raise VolcAsrError(
            f"音频 {len(proc.stdout) / 1048576:.0f}MB 超过上游 "
            f"{MAX_AUDIO_BYTES // 1048576}MB 上限（24kbps opus 约 6 小时到顶）"
        )
    return proc.stdout


async def recognize(
    payload: bytes,
    *,
    app_id: str,
    access_key: str,
    enable_punc: bool = True,
    enable_itn: bool = True,
    enable_ddc: bool = True,
) -> dict[str, Any]:
    """一次同步识别。31 秒音频实测 4.1s，32 分钟 58s——耗时几乎与时长无关。"""
    if not (app_id and access_key):
        raise VolcAsrError("火山语音凭据未配置（配置中心添加 volc_speech 凭据）")

    def build() -> bytes:
        """组请求体。base64 与 json 序列化对 5MB 音频约 40ms，放线程里不占事件循环。

        aiohttp 的 `json=` 参数内部就是 `dumps(...).encode()`，自己序列化好再用
        `data=` 传，body 只物化一份而不是两份。
        """
        return json.dumps(
            {
                "user": {"uid": "lingua"},
                "audio": {
                    "format": AUDIO_FORMAT,
                    "rate": SAMPLE_RATE,
                    "bits": 16,
                    "channel": 1,
                    "data": base64.b64encode(payload).decode(),
                },
                "request": {
                    "model_name": "bigmodel",
                    "enable_itn": enable_itn,
                    "enable_punc": enable_punc,
                    "enable_ddc": enable_ddc,
                    "show_utterances": True,
                },
            }
        ).encode()

    body = await asyncio.to_thread(build)
    headers = {
        "X-Api-App-Key": app_id,
        "X-Api-Access-Key": access_key,
        "X-Api-Resource-Id": FLASH_RESOURCE_ID,
        "X-Api-Sequence": "-1",
        "Content-Type": "application/json",
        # 不收 brotli：上游的错误页会带 `content-encoding: br`，而 aiohttp 没装
        # brotli 解码器时 `resp.text()` 抛 ClientPayloadError——那是 ClientError 的子类，
        # 会被下面的重试循环白白吃掉三次，最后报一个与真实原因无关的错
        "Accept-Encoding": "identity",
    }
    # 超时按体积给，不用一个统一的大数。
    #
    # 跟读录音是几秒的片子（几十 KB），给它 600s × 3 次重试 = 最坏 30 分钟——
    # 而这四条短音频链路是**同步 HTTP handler**，整段时间都占着请求作用域的
    # 数据库连接（`app/db.py` 的池上限只有 15）。真卡满 30 分钟等于把池吃掉一格。
    # 实测吞吐约 0.4MB/s（含上游识别），按 60s 起 + 每 MB 加 20s，
    # 32 分钟视频的 5.3MB 得到 166s（实测用 16.5s，留了 10 倍余量）。
    budget = 60 + int(len(payload) / 1048576 * 20)
    timeout = aiohttp.ClientTimeout(total=budget, connect=30, sock_connect=30)
    proxy = await speech_proxy()
    last: Exception | None = None

    for attempt in range(MAX_ATTEMPTS):
        # 每次换 request id：上游按它去重，复用会把重试当成同一次请求
        headers["X-Api-Request-Id"] = str(uuid.uuid4())
        try:
            async with (
                aiohttp.ClientSession(timeout=timeout) as http,
                http.post(FLASH_URL, data=body, headers=headers, proxy=proxy) as resp,
            ):
                status = resp.headers.get("X-Api-Status-Code")
                message = resp.headers.get("X-Api-Message") or ""
                # 火山排障只认 logid，失败时不带上等于让对方无从查起
                logid = resp.headers.get("X-Tt-Logid") or ""
                text = await resp.text()
            if status != OK_STATUS:
                # 上游明确拒绝（参数错、未授权、超限）重试没有意义，直接抛
                raise VolcAsrError(
                    f"火山返回 {status} {message}（logid {logid}）: {text[:200]}"
                )
            return json.loads(text)
        except (aiohttp.ClientError, TimeoutError) as exc:
            last = exc
            logger.warning("火山 ASR 第 %d 次失败：%s", attempt + 1, exc)
            if attempt + 1 < MAX_ATTEMPTS:
                await asyncio.sleep(2 * (attempt + 1))
    raise VolcAsrError(f"三次重试都失败：{type(last).__name__}: {last}")


def cues_from_result(result: dict[str, Any]) -> list[Cue]:
    """utterances → Cue。时间戳单位已是毫秒，与 Cue 同口径。

    > [!warning] words 里混着分隔用的空白 token
    >
    > 每两个词之间夹一条 `{"text": " ", "start_time": -1, "end_time": -1}`。
    > 不滤掉的话词数虚高一倍，而 -1 会让词级高亮跳回时间轴原点。
    """
    cues: list[Cue] = []
    for utt in (result.get("result") or {}).get("utterances") or []:
        text = (utt.get("text") or "").strip()
        if not text:
            continue
        words = [
            [int(w["start_time"]), int(w["end_time"]), w["text"].strip()]
            for w in utt.get("words") or []
            if (w.get("text") or "").strip() and int(w.get("start_time", -1)) >= 0
        ]
        cues.append(
            Cue(
                start_ms=int(utt.get("start_time") or 0),
                end_ms=int(utt.get("end_time") or 0),
                text=text,
                words=words or None,
            )
        )
    return cues


class _VolcAsrProvider:
    async def transcribe(
        self,
        route: PreparedAsrRoute,
        *,
        path: str,
        word_timestamps: bool,
        on_progress: Callable[[int], None] | None,
    ) -> AsrTranscript:
        source = Path(path)
        credentials = route.credentials

        # 无音轨与本地 whisper 同口径：返回空结果而不是抛。抛的话 pipeline.step()
        # 会重抛，整片入库 failed，而 whisper 那条路是照常跑完、体检判 degraded
        duration = await asyncio.to_thread(probe_audio, path)
        if duration is None:
            return AsrTranscript(text="", cues=[], duration_s=0.0)

        payload = await asyncio.to_thread(opus_bytes, path)
        if on_progress is not None:
            on_progress(65)

        request: dict[str, Any] = {
            "file_name": source.name,
            "audio_bytes": len(payload),
            "audio_format": AUDIO_FORMAT,
            "duration_s": round(duration, 3),
            "resource_id": FLASH_RESOURCE_ID,
        }
        if word_timestamps:
            request["word_timestamps"] = True
        options = route.protocol_options
        request.update(dict(options))

        async with route.span(request=request) as span:
            result = await recognize(
                payload,
                app_id=str(credentials.get("app_id") or ""),
                access_key=str(credentials.get("access_key") or ""),
                enable_punc=bool(options.get("enable_punc", True)),
                enable_itn=bool(options.get("enable_itn", True)),
                enable_ddc=bool(options.get("enable_ddc", True)),
            )
            cues = cues_from_result(result)
            text = " ".join(cue.text for cue in cues)
            span.finish(
                response={
                    "cue_count": len(cues),
                    "duration_s": round(duration, 3),
                    "word_count": sum(len(cue.words or []) for cue in cues),
                    "character_count": len(text),
                }
            )
        if on_progress is not None:
            on_progress(95)
        # 不带词级时间戳的调用方只读 text，但 cues 照给——算都算了，丢掉没好处
        return AsrTranscript(text=text, cues=cues, duration_s=duration)


def transcription_options(capability: str) -> dict[str, bool]:
    """归一化开关。标点开，ITN 与 DDC 一律关。

    > [!danger] 曾经按用途分档，那是错的——两侧必须同口径
    >
    > 第一版让字幕开 ITN、跟读关 ITN，理由是「字幕给人读，数字更好读」。
    > 漏了一件事：**跟读比对的参考文本就是字幕**（`shadowing.py` 的
    > `diff_words(reference, transcript)`，reference 取自 `subtitle_sentence`）。
    > 一侧写 `2 minutes` 一侧写 `two minutes`，逐词比对把读对的判成读错，
    > 而两边单独看都"正常"。同一个文本的生产端与消费端用不同归一化，必错。
    >
    > 定成全关而不是全开，另有三条理由：
    >
    > 1. ITN 自己就不自洽。video 11 同一句里 "takes **two** minutes" 与
    >    "needs **5** minutes" 并存（实测），它不是稳定的规则而是模型的即兴判断。
    > 2. 这是个英语学习产品。字幕要能点词查义——`2` 查不了，`two` 查得了；
    >    而 `1970` 是一个 token 却横跨 "nineteen seventy" 两个发音，
    >    词级卡拉OK 高亮直接对不上。
    > 3. DDC 删语气词与重复词。学习者听到的是 "I—I think"，字幕却写 "I think"，
    >    对不上音；跟读要比的「读漏/多读了什么」也被它抹掉。
    >
    > 实测关掉之后 video 11 整片零个阿拉伯数字，全部按朗读原样拼写。
    >
    > 形参 `capability` 留着：将来若有某条链路真的只要好读不要对齐（比如导出字幕文件），
    > 它是唯一的分档依据。现在不分。
    """
    return {"enable_punc": True, "enable_itn": False, "enable_ddc": False}


def prepare_volc_asr_route(credentials: dict[str, Any], *, capability: str) -> PreparedAsrRoute:
    """火山 ASR 路由。model 位填 resource id：UI 上「模型」那一栏要显示上游真名（核心原则 6）。"""
    return prepare_asr_route(
        RouteRequest(
            capability=capability,
            plugin_id=VOLC_ASR_PLUGIN_ID,
            provider_type=VOLC_ASR_PROVIDER_TYPE,
            model=FLASH_RESOURCE_ID,
            credentials=credentials,
            protocol_options=transcription_options(capability),
        )
    )


_PROVIDER_HANDLES = (
    register_asr_route_provider(
        plugin_id=VOLC_ASR_PLUGIN_ID,
        provider=_VolcAsrProvider(),
        operations=frozenset({ASR_OPERATION}),
    ),
)
