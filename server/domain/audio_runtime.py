"""统一音频合成 Provider 运行时。

路由层只解析能力、模型和凭据；Edge TTS 与火山流式协议由可撤销
Provider 持有。Azure Speech 使用区域 REST 合成。注册表、冻结与记账模板
复用 :mod:`domain.kernel.capability_seam`。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

import edge_tts
from sqlalchemy import select

from domain import mac_tts
from domain.credentials import CredentialError, decrypt_config, resolve_binding
from domain.kernel.capability_seam import (
    CapabilitySeam,
    PreparedRoute,
    RouteRequest,
    RouteSnapshot,
    SeamError,
)
from domain.model_catalog import ResolvedModelRoute
from domain.model_plugins import adapter_for_provider
from domain.models import ProviderCredential
from domain.network_policy import speech_proxy
from domain.plugin_runtime import RegistrationHandle
from domain.volc_tts import VolcTTSError, stream_synthesize

EDGE_FALLBACK_VOICE = "en-US-AriaNeural"
# 助理的回复中文为主，英文音色对中文一个字都不出（火山 en_* 返回无音频、edge en-US 同样）：
# 这个场景没绑定时直接用 edge 的双语音色出声，别让 HUD 哑掉；出错时的兜底也用它。
# meaning 是听读单词时念的中文释义，同理
SCENE_FALLBACK_VOICE = {"assistant": "zh-CN-XiaoxiaoNeural", "meaning": "zh-CN-XiaoxiaoNeural"}


class AudioSynthesisError(Exception):
    def __init__(self, kind: str, message: str, *, retryable: bool = True) -> None:
        super().__init__(message)
        self.kind = kind
        self.retryable = retryable


# 音频路由没有额外字段，请求与快照直接用通用形状；别名保住既有调用点的名字
AudioRouteRequest = RouteRequest
AudioRouteSnapshot = RouteSnapshot


@dataclass(frozen=True)
class AudioSynthesis:
    provider: str
    path: Path | None = None
    stream: AsyncIterator[bytes] | None = field(default=None, repr=False, compare=False)
    metrics: dict = field(default_factory=dict, repr=False, compare=False)


class AudioRouteProvider(Protocol):
    async def synthesize(
        self,
        route: PreparedAudioRoute,
        *,
        text: str,
        voice: str,
        rate: int,
        cache_path: Path,
    ) -> AudioSynthesis: ...


@dataclass(frozen=True)
class PreparedAudioRoute(PreparedRoute[RouteSnapshot, AudioRouteProvider]):
    async def synthesize(
        self,
        *,
        text: str,
        voice: str,
        rate: int,
        cache_path: Path,
    ) -> AudioSynthesis:
        return await self._provider.synthesize(
            self,
            text=text,
            voice=voice,
            rate=rate,
            cache_path=cache_path,
        )


AUDIO_PROVIDER_KIND = "model-audio-provider"
audio_seam: CapabilitySeam[RouteRequest, RouteSnapshot, AudioRouteProvider] = CapabilitySeam(
    AUDIO_PROVIDER_KIND, label="音频", ready_source="audio"
)


def register_audio_route_provider(
    *,
    plugin_id: str,
    provider: AudioRouteProvider,
    operations: set[str] | frozenset[str],
    replace: bool = False,
) -> RegistrationHandle:
    """登记可撤销音频 Provider；替换句柄卸载后恢复上一代实现。"""
    return audio_seam.register(
        plugin_id=plugin_id,
        provider=provider,
        operations=operations,
        replace=replace,
    )


def audio_route_provider_views() -> dict[str, dict[str, Any]]:
    return audio_seam.views("audio")


def prepare_audio_route(
    request: AudioRouteRequest,
    operation: str = "audio.synthesize",
) -> PreparedAudioRoute:
    try:
        return audio_seam.prepare_as(PreparedAudioRoute, request, operation)
    except SeamError as exc:
        raise AudioSynthesisError("binding", str(exc), retryable=False) from exc


def prepare_audio_model_route(
    capability: str,
    route: ResolvedModelRoute,
) -> PreparedAudioRoute:
    return prepare_audio_route(RouteRequest.from_model_route(capability, route))


def legacy_audio_route(
    capability: str,
    *,
    provider_type: str,
    model: str,
    credentials: dict,
    protocol_options: dict | None = None,
) -> PreparedAudioRoute:
    """按凭据类型（而不是 v2 部署）冻结一条合成路由：场景绑定与显式 voice 覆盖都走这里。"""
    return prepare_audio_route(
        AudioRouteRequest(
            capability=capability,
            # 带上 operation：volc_speech 同时被 volcengine(TTS/实时) 与 volc-asr 认领，
            # 不限定操作会挑到不会合成的那个
            plugin_id=adapter_for_provider(provider_type, operation="audio.synthesize"),
            provider_type=provider_type,
            model=model,
            credentials=credentials,
            protocol_options=protocol_options or {},
        )
    )


def edge_fallback_route(capability: str, voice_id: str = EDGE_FALLBACK_VOICE) -> PreparedAudioRoute:
    return legacy_audio_route(capability, provider_type="edge_tts", model=voice_id, credentials={})


@dataclass(frozen=True)
class SceneAudioRoute:
    route: PreparedAudioRoute
    voice_id: str
    rate: int


async def resolve_scene_route(session, scene: str) -> SceneAudioRoute:
    """``tts-{scene}`` 场景绑定 → 冻结路由 + 音色 + 语速；只有登记了兜底音色的场景才允许没绑定。"""
    capability = f"tts-{scene}"
    try:
        resolved = await resolve_binding(session, capability)
    except CredentialError:
        if scene not in SCENE_FALLBACK_VOICE:
            raise
        voice_id = SCENE_FALLBACK_VOICE[scene]
        return SceneAudioRoute(edge_fallback_route(capability, voice_id), voice_id, 0)
    voice_id = resolved.target or EDGE_FALLBACK_VOICE
    route = legacy_audio_route(
        capability,
        provider_type=resolved.provider_type,
        model=voice_id,
        credentials=resolved.config,
        protocol_options=resolved.params,
    )
    return SceneAudioRoute(route, voice_id, int(resolved.params.get("rate") or 0))


def cache_voice_of(route: PreparedAudioRoute, voice_id: str) -> tuple[str, str]:
    """缓存键里的音色名与来源标签：edge 保持无前缀，旧缓存才不失效。"""
    if route.snapshot.plugin_id == "edge-tts":
        return voice_id, "edge"
    if route.snapshot.plugin_id == "volcengine":
        return f"volc:{voice_id}", "volc"
    if route.snapshot.plugin_id in {"azure-speech", "bailian-tts", "cartesia", "minimax-tts"}:
        identity = json.dumps(
            {
                "model": route.credentials.get("model"),
                "region": route.credentials.get("region"),
                "options": dict(route.protocol_options),
                "account": hashlib.sha256(
                    str(route.credentials.get("api_key", "")).encode()
                ).hexdigest(),
            },
            sort_keys=True,
        )
        digest = hashlib.sha256(identity.encode()).hexdigest()[:24]
        return f"{route.snapshot.plugin_id}:{digest}:{voice_id}", route.snapshot.plugin_id
    return f"{route.snapshot.plugin_id}:{voice_id}", route.snapshot.plugin_id


def tts_cache_path(media_root: str, text: str, cache_voice: str, rate: int) -> Path:
    digest = hashlib.sha256(f"{text}|{cache_voice}|{rate}".encode()).hexdigest()
    return Path(media_root) / "tts" / f"{digest}.mp3"


class _EdgeTtsProvider:
    async def synthesize(
        self,
        route: PreparedAudioRoute,
        *,
        text: str,
        voice: str,
        rate: int,
        cache_path: Path,
    ) -> AudioSynthesis:
        async def stream():
            async with route.span(
                model=voice,
                request={
                    "text": text,
                    "voice": voice,
                    "rate": rate,
                    "route": route.snapshot.view(),
                },
            ) as span:
                communicate = edge_tts.Communicate(
                    text, voice=voice, rate=f"{rate:+d}%", proxy=await speech_proxy() or ""
                )
                size = 0
                try:
                    async for event in communicate.stream():
                        if event["type"] == "audio":
                            size += len(event["data"])
                            yield event["data"]
                except Exception as exc:
                    raise AudioSynthesisError("api", "Edge TTS 暂不可用") from exc
                span.finish(response={"audio_bytes": size, "voice": voice})

        return await _primed_audio("edge", stream())


class _AzureTtsProvider:
    async def synthesize(
        self, route: PreparedAudioRoute, *, text: str, voice: str, rate: int, cache_path: Path
    ) -> AudioSynthesis:
        import httpx

        from domain.azure_speech import stream_synthesize

        metrics = {}

        async def stream():
            async with route.span(model=voice, request={"text": text, "voice": voice}) as span:
                size = 0
                try:
                    async for chunk in stream_synthesize(
                        route.credentials, text, voice, rate, metrics=metrics
                    ):
                        size += len(chunk)
                        yield chunk
                except (httpx.HTTPError, ValueError) as exc:
                    raise AudioSynthesisError(
                        "api", "Azure 合成失败，请检查区域、密钥与网络"
                    ) from exc
                span.finish(response={"audio_bytes": size, "voice": voice})

        return await _primed_audio("azure", stream(), metrics)


async def _primed_audio(
    provider: str, stream: AsyncIterator[bytes], metrics: dict | None = None
) -> AudioSynthesis:
    try:
        first = await anext(stream)
    except StopAsyncIteration as exc:
        raise AudioSynthesisError("empty", "供应商未返回音频") from exc
    except BaseException:
        await stream.aclose()
        raise

    return AudioSynthesis(
        provider=provider,
        stream=_PrimedStream(first, stream),
        metrics=metrics if metrics is not None else {},
    )


class _PrimedStream:
    def __init__(self, first: bytes, stream: AsyncIterator[bytes]):
        self.first = first
        self.stream = stream
        self.closed = False

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self.closed:
            raise StopAsyncIteration
        if self.first:
            first, self.first = self.first, b""
            return first
        return await anext(self.stream)

    async def aclose(self):
        self.closed = True
        self.first = b""
        await self.stream.aclose()


class _VolcengineTtsProvider:
    async def synthesize(
        self,
        route: PreparedAudioRoute,
        *,
        text: str,
        voice: str,
        rate: int,
        cache_path: Path,
    ) -> AudioSynthesis:
        del cache_path
        snapshot = route.snapshot
        credentials = route.credentials
        stream = stream_synthesize(
            text,
            voice,
            rate,
            app_id=str(credentials.get("app_id") or ""),
            access_key=str(credentials.get("access_key") or ""),
            deployment_id=snapshot.deployment_id,
            capability=snapshot.capability,
            plugin_version=snapshot.plugin_version,
            plugin_generation=snapshot.plugin_generation,
            runtime_generation=snapshot.runtime_generation,
            route_view=snapshot.view(),
        )
        try:
            first = await anext(stream)
        except StopAsyncIteration as exc:
            raise AudioSynthesisError("api", "火山 TTS 未返回音频") from exc
        except VolcTTSError as exc:
            raise AudioSynthesisError("api", str(exc)) from exc

        async def with_first() -> AsyncIterator[bytes]:
            yield first
            async for chunk in stream:
                yield chunk

        return AudioSynthesis(provider="volc", stream=with_first())


class _CloudTtsProvider:
    async def synthesize(
        self, route: PreparedAudioRoute, *, text: str, voice: str, rate: int, cache_path: Path
    ) -> AudioSynthesis:
        import aiohttp
        import httpx

        from domain.cloud_tts import synthesize

        provider = route.snapshot.provider_type
        if provider == "minimax_tts" and route.snapshot.capability != "tts-preview":
            raise AudioSynthesisError("binding", "MiniMax 仅用于目录试听", retryable=False)
        metrics = {}

        async def stream():
            async with route.span(model=voice, request={"text": text, "voice": voice}) as span:
                size = 0
                try:
                    async for chunk in synthesize(
                        route.credentials, provider, text, voice, rate, metrics
                    ):
                        size += len(chunk)
                        yield chunk
                except (
                    httpx.HTTPError,
                    aiohttp.ClientError,
                    ValueError,
                    KeyError,
                    TimeoutError,
                ) as exc:
                    raise AudioSynthesisError(
                        "api", "语音合成失败，请检查模型、音色、密钥与网络"
                    ) from exc
                span.finish(response={"audio_bytes": size, "voice": voice})

        return await _primed_audio(route.snapshot.plugin_id, stream(), metrics)


def _register_builtin_audio_providers() -> tuple[RegistrationHandle, ...]:
    return (
        *(
            register_audio_route_provider(
                plugin_id=plugin, provider=_CloudTtsProvider(), operations={"audio.synthesize"}
            )
            for plugin in ("bailian-tts", "cartesia", "minimax-tts")
        ),
        register_audio_route_provider(
            plugin_id="azure-speech",
            provider=_AzureTtsProvider(),
            operations={"audio.synthesize"},
        ),
        register_audio_route_provider(
            plugin_id="edge-tts",
            provider=_EdgeTtsProvider(),
            operations={"audio.synthesize"},
        ),
        register_audio_route_provider(
            plugin_id="volcengine",
            provider=_VolcengineTtsProvider(),
            operations={"audio.synthesize"},
        ),
    )


_BUILTIN_AUDIO_PROVIDER_HANDLES = _register_builtin_audio_providers()


# ---- 显式音色（带前缀的 voice 串）与音色目录：tts 路由、按词钉音色、按本清缓存共用 ----

# provider_type → voice 前缀（也是缓存键前缀）
PROVIDER_PREFIX = {
    "volc_speech": "volc",
    "edge_tts": "edge",
    "azure_speech": "azure",
    "bailian_tts": "bailian",
    "cartesia_tts": "cartesia",
}
# 三段式前缀：{prefix}:{credential_id}:{voice_id}，凭据从 id 取
_CREDENTIAL_PREFIXES = {"azure", "bailian", "cartesia"}


def split_voice(voice: str) -> tuple[str, str]:
    """voice 参数 → (prefix, voice_id)；无前缀视为 edge，保持旧缓存键不变。"""
    prefix, _, rest = voice.partition(":")
    if rest and prefix in PROVIDER_PREFIX.values():
        return prefix, rest
    return "edge", voice


async def volc_credentials(session) -> dict | None:
    """显式 volc: 音色时取首个 enabled 的 volc_speech 凭据。"""
    stmt = (
        select(ProviderCredential)
        .where(
            ProviderCredential.provider_type == "volc_speech",
            ProviderCredential.enabled,
        )
        .order_by(ProviderCredential.id)
        .limit(1)
    )
    cred = (await session.execute(stmt)).scalar_one_or_none()
    if cred is None:
        return None
    return decrypt_config(cred.config)


async def resolve_explicit_voice(session, voice: str) -> tuple[str, str, dict]:
    """显式 voice → (provider_type, voice_id, credentials)。

    三段式前缀的凭据 id 必须是十进制且类型匹配、凭据启用：格式坏抛
    AudioSynthesisError(kind="voice")，凭据不可用抛 CredentialError；router 各自转 422 / 409。
    """
    prefix, voice_id = split_voice(voice)
    provider_type = "volc_speech" if prefix == "volc" else "edge_tts"
    credentials = (await volc_credentials(session) or {}) if prefix == "volc" else {}
    if prefix in _CREDENTIAL_PREFIXES:
        expected_type = next(key for key, value in PROVIDER_PREFIX.items() if value == prefix)
        credential_id, separator, voice_id = voice_id.partition(":")
        if not separator or not credential_id.isdecimal() or not voice_id:
            raise AudioSynthesisError("voice", "音色标识无效", retryable=False)
        credential = await session.get(ProviderCredential, int(credential_id))
        if (
            credential is None
            or not credential.enabled
            or credential.provider_type != expected_type
        ):
            raise CredentialError("语音凭据不可用")
        provider_type = expected_type
        credentials = decrypt_config(credential.config)
    return provider_type, voice_id, credentials


async def voice_catalog(session) -> list[dict]:
    """聚合所有 enabled TTS 凭据的 models_cache 音色目录（附 credential_id）。
    `name` 可直接回填 `?voice=`。"""
    stmt = (
        select(ProviderCredential)
        .where(ProviderCredential.kind == "tts", ProviderCredential.enabled)
        .order_by(ProviderCredential.id)
    )
    voices: list[dict] = []
    for cred in (await session.execute(stmt)).scalars():
        if cred.provider_type == "minimax_tts":
            continue
        prefix = PROVIDER_PREFIX.get(cred.provider_type, cred.provider_type)
        for item in (cred.models_cache or {}).get("items") or []:
            if not isinstance(item, dict) or not item.get("id"):
                continue
            voices.append(
                {
                    "name": f"{prefix}:{cred.id}:{item['id']}"
                    if prefix in _CREDENTIAL_PREFIXES
                    else f"{prefix}:{item['id']}",
                    "label": item.get("label") or item["id"],
                    "gender": item.get("gender", ""),
                    "locale": item.get("locale", ""),
                    "provider": cred.provider_type,
                    "credential_id": cred.id,
                }
            )
    voices.extend({**item, "gender": "", "provider": "mac", "credential_id": None}
                  for item in await asyncio.to_thread(mac_tts.voices))
    return voices
