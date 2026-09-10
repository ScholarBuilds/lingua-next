"""本地 whisper 转写：跟读比对、场景陪练回合与视频字幕都经 ASR seam 走这里。

模型按名称缓存单例——large-v3 权重 2.9GB，按请求加载会打爆内存。
cpu_threads 限为 4：M1 Max 10 核下留出余量给并发的第二条转写与 CTC 对齐。
"""

from __future__ import annotations

import asyncio
import logging
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from app.config import get_settings
from domain.kernel.capability_seam import (
    CapabilitySeam,
    PreparedRoute,
    RouteRequest,
    RouteSnapshot,
)
from domain.plugin_runtime import RegistrationHandle
from domain.subtitles import Cue

logger = logging.getLogger(__name__)

ASR_PLUGIN_ID = "faster-whisper"
ASR_PROVIDER_TYPE = "faster_whisper"
# 火山那家的 provider_type，与凭据表同名；放在这里免得选路函数反向依赖 volc_asr
VOLC_ASR_PROVIDER_TYPE = "volc_speech"
ASR_OPERATION = "asr.transcribe"

_models: dict[str, Any] = {}
_models_lock = threading.Lock()


def _model(model_name: str) -> Any:
    with _models_lock:
        cached = _models.get(model_name)
        if cached is None:
            from faster_whisper import WhisperModel

            cached = WhisperModel(model_name, compute_type="int8", cpu_threads=4)
            _models[model_name] = cached
        return cached


def transcribe_audio(path: str, model_name: str) -> str:
    """音频文件 → 整段转写文本（跑在线程池调用方）。"""
    segments, _info = _model(model_name).transcribe(path, vad_filter=True)
    return " ".join(seg.text.strip() for seg in segments if seg.text.strip())


def transcribe_cues(
    media_path: str,
    model_name: str,
    on_progress: Callable[[int], None] | None = None,
) -> tuple[list[Cue], float]:
    """句级转写（跑在线程池），进度按时间轴映射 60-95。

    word_timestamps=True：词级时间轴供卡拉OK高亮（FR-19），faster-whisper 原生支持。
    condition_on_previous_text 保持默认 True：关掉虽快 40%，但实测丢 7.7% 的词（ADR-007）。
    """
    import av

    with av.open(media_path) as container:
        has_audio = any(s.type == "audio" for s in container.streams)
        container_duration = (container.duration or 0) / av.time_base
    if not has_audio:  # 无音轨样片：faster-whisper 解码会炸，直接视为无语音
        return [], container_duration

    segments, info = _model(model_name).transcribe(
        media_path, vad_filter=True, word_timestamps=True
    )
    duration = info.duration or 0.0
    cues: list[Cue] = []
    for seg in segments:
        text = seg.text.strip()
        if not text:
            continue
        words = [
            [int(w.start * 1000), int(w.end * 1000), w.word.strip()]
            for w in (seg.words or [])
            if w.word.strip()
        ]
        cues.append(
            Cue(
                start_ms=int(seg.start * 1000),
                end_ms=int(seg.end * 1000),
                text=text,
                words=words or None,
            )
        )
        if duration and on_progress is not None:
            on_progress(60 + int(min(seg.end / duration, 1.0) * 35))
    return cues, duration


@dataclass(frozen=True)
class AsrTranscript:
    """整段文本；带词级时间戳的调用另给句级 cue 与音频时长。"""

    text: str
    cues: list[Cue] = field(default_factory=list)
    duration_s: float = 0.0


class AsrRouteProvider(Protocol):
    async def transcribe(
        self,
        route: PreparedAsrRoute,
        *,
        path: str,
        word_timestamps: bool,
        on_progress: Callable[[int], None] | None,
    ) -> AsrTranscript: ...


@dataclass(frozen=True)
class PreparedAsrRoute(PreparedRoute[RouteSnapshot, AsrRouteProvider]):
    async def transcribe(
        self,
        *,
        path: str,
        word_timestamps: bool = False,
        on_progress: Callable[[int], None] | None = None,
    ) -> AsrTranscript:
        return await self._provider.transcribe(
            self,
            path=path,
            word_timestamps=word_timestamps,
            on_progress=on_progress,
        )


ASR_PROVIDER_KIND = "model-asr-provider"
asr_runtime: CapabilitySeam[RouteRequest, RouteSnapshot, AsrRouteProvider] = CapabilitySeam(
    ASR_PROVIDER_KIND, label="ASR", ready_source="asr"
)


def register_asr_route_provider(
    *,
    plugin_id: str,
    provider: AsrRouteProvider,
    operations: set[str] | frozenset[str] = frozenset({ASR_OPERATION}),
    replace: bool = False,
) -> RegistrationHandle:
    return asr_runtime.register(
        plugin_id=plugin_id,
        provider=provider,
        operations=operations,
        replace=replace,
    )


def prepare_asr_route(
    request: RouteRequest,
    operation: str = ASR_OPERATION,
) -> PreparedAsrRoute:
    return asr_runtime.prepare_as(PreparedAsrRoute, request, operation)


def prepare_local_asr_route(model_name: str, *, capability: str) -> PreparedAsrRoute:
    """本地 faster-whisper 路由：无凭据、无部署，model 即 whisper 模型名。"""
    return prepare_asr_route(
        RouteRequest(
            capability=capability,
            plugin_id=ASR_PLUGIN_ID,
            provider_type=ASR_PROVIDER_TYPE,
            model=model_name,
        )
    )


async def prepare_preferred_asr_route(session: Any, *, capability: str) -> PreparedAsrRoute:
    """配了火山语音凭据就走火山极速版，否则退回本地 whisper。

    > [!info] 选路不由插件表的 priority 决定
    >
    > `priority` 参与的是「同一 provider_type 下选哪个适配器」，而这里要在**两个不同
    > provider_type** 之间选，判据是「凭据在不在」——插件表看不见凭据。所以这一层显式写。

    同素材实测（7 条视频 / 46 分钟，`scripts/compare_asr.py`）：火山快 20 倍、不占内存、
    自带标点、无零宽词跨度；代价是词级时间戳比 CTC 强制对齐松（绝对偏移中位 50ms）。
    凭据缺失、被禁用或解密失败都静默落到本地——转写是整条视频管线的第一步，
    不该因为一条凭据没配就整片跑不动。
    """
    from sqlalchemy import select

    from domain.credentials import decrypt_config
    from domain.models import ProviderCredential

    try:
        credential = (
            await session.execute(
                select(ProviderCredential)
                .where(
                    ProviderCredential.provider_type == VOLC_ASR_PROVIDER_TYPE,
                    ProviderCredential.enabled,
                )
                .order_by(ProviderCredential.id)
                .limit(1)
            )
        ).scalar_one_or_none()
        if credential is not None:
            config = decrypt_config(credential.config)
            if config.get("app_id") and config.get("access_key"):
                from domain.volc_asr import prepare_volc_asr_route

                return prepare_volc_asr_route(config, capability=capability)
    except Exception:  # noqa: BLE001
        logger.warning("解析火山 ASR 凭据失败，退回本地 whisper", exc_info=True)

    return prepare_local_asr_route(get_settings().whisper_model, capability=capability)


async def transcribe_with_fallback(
    route: PreparedAsrRoute,
    *,
    path: str,
    word_timestamps: bool = False,
    on_progress: Callable[[int], None] | None = None,
    capability: str,
    fallback_model: str | None = None,
) -> AsrTranscript:
    """先按选好的路由转写；走的是远端而它失败了，降级到本地 whisper 重跑一次。

    > [!danger] 选路期回落不等于运行期回落
    >
    > `prepare_preferred_asr_route` 只在「凭据读不出来」时落回本地。一旦选中火山，
    > **调用失败就没有第二条路**了——而失败的现实来源恰恰不在凭据上：
    > 免费额度用尽、账号只开了 TTS 没开录音文件识别、上游临时故障。
    > 后果分两类：worker 里 `pipeline.step()` 重抛 → 整条视频管线 failed、
    > `video.status='failed'`，而同一条管线的 punctuate 与 align 两步都是「失败即降级」；
    > 路由里 `repair.py` 只有 try/finally 没有 except，直接 500。
    >
    > 本地 whisper 一直装着，让它兜住这一次。降级会写进日志，
    > 台账里也留得下两条记录（远端那条 failed、本地那条 success），排障看得出发生过什么。

    > [!warning] 降级不是无条件的
    >
    > 「没有音轨」「音频转码失败」这类换个引擎也救不了，重试一遍只是浪费一次
    > 2.9GB 模型加载。只在**上游明确拒绝或网络反复失败**时降级。

    `fallback_model` 让调用方挑回落用哪一档。请求路径（API 进程）传
    `settings.whisper_fallback_model`（small，464MB）；视频管线在 worker 里跑，
    不传即沿用 `whisper_model`（large-v3）。
    """
    if route.snapshot.plugin_id == ASR_PLUGIN_ID:
        return await route.transcribe(
            path=path, word_timestamps=word_timestamps, on_progress=on_progress
        )

    from domain.volc_asr import NoAudioTrack, VolcAsrError

    try:
        return await route.transcribe(
            path=path, word_timestamps=word_timestamps, on_progress=on_progress
        )
    except NoAudioTrack:
        raise
    except VolcAsrError as exc:
        logger.warning(
            "火山 ASR 失败，降级到本地 whisper 重跑：%s", exc, exc_info=True
        )

    settings = get_settings()
    # 请求路径传 small：回落会把模型常驻进 API 进程，large-v3 是 2.6GB
    model = fallback_model or settings.whisper_model
    local = prepare_local_asr_route(model, capability=capability)
    return await local.transcribe(
        path=path, word_timestamps=word_timestamps, on_progress=on_progress
    )


class _FasterWhisperProvider:
    async def transcribe(
        self,
        route: PreparedAsrRoute,
        *,
        path: str,
        word_timestamps: bool,
        on_progress: Callable[[int], None] | None,
    ) -> AsrTranscript:
        source = Path(path)
        request: dict[str, Any] = {
            "file_name": source.name,
            "audio_bytes": source.stat().st_size if source.exists() else None,
        }
        if word_timestamps:
            request["word_timestamps"] = True
        request["vad_filter"] = True
        model_name = route.snapshot.model
        async with route.span(request=request) as span:
            if word_timestamps:
                cues, duration = await asyncio.to_thread(
                    transcribe_cues, path, model_name, on_progress
                )
                span.finish(
                    response={
                        "cue_count": len(cues),
                        "duration_s": round(duration, 3),
                        "word_count": sum(len(cue.words or []) for cue in cues),
                    }
                )
                return AsrTranscript(
                    text=" ".join(cue.text for cue in cues),
                    cues=cues,
                    duration_s=duration,
                )
            text = await asyncio.to_thread(transcribe_audio, path, model_name)
            span.finish(response={"text": text, "character_count": len(text)})
            return AsrTranscript(text=text)


async def transcribe_audio_logged(
    path: str,
    model_name: str,
    *,
    capability: str = "asr",
    session: Any | None = None,
) -> str:
    """整段转写，台账身份由 seam 写入。

    给了 session 就按凭据选路（配了火山走火山，否则本地）；不给就一律本地——
    默认值保守是有意的：没有 session 的调用方多半在 worker 深处，
    悄悄替它选一条要联网的路会让离线场景莫名其妙地失败。
    """
    route = (
        await prepare_preferred_asr_route(session, capability=capability)
        if session is not None
        else prepare_local_asr_route(model_name, capability=capability)
    )
    # 这个 helper 只被四条请求路径用（跟读/陪练/语音改写/跟读比对），
    # 一律回落到小模型：它们跑在 API 进程里，不该为降级路径常驻 2.6GB
    transcript = await transcribe_with_fallback(
        route,
        path=path,
        capability=capability,
        fallback_model=get_settings().whisper_fallback_model,
    )
    return transcript.text


_BUILTIN_ASR_PROVIDER_HANDLES = (
    register_asr_route_provider(plugin_id=ASR_PLUGIN_ID, provider=_FasterWhisperProvider()),
)

# 放在文件最末尾：volc_asr 反向 import 本模块，早一行就是循环 import。
# 不能只靠 prepare_preferred_asr_route 里那个惰性 import——那样在**第一次真走火山之前**
# `wired_operations_index()` 里没有 volc-asr 这一项，插件目录会显示成「声明了但没接线」，
# 而且 API 与 worker 两个进程各自什么时候被点亮还不一样。
from domain import volc_asr as _volc_asr  # noqa: E402,F401
