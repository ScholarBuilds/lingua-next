"""统一模型适配器插件目录。

这里描述"有哪些协议、能处理什么"。哪些操作已经接线不再手写：各条 seam 的 Provider
注册表是唯一事实源，``ModelPlugin.is_ready`` 与 ``/config/model-plugins`` 的
``ready_operations`` 都由它们聚合。凭据和模型实例仍由 ``ProviderCredential`` /
``ModelDeployment`` 持久化，密钥不会进入插件清单。
"""

from __future__ import annotations

from collections.abc import Callable, Collection, Mapping
from dataclasses import dataclass
from importlib import import_module
from typing import Any

from domain.plugin_runtime import (
    PluginManifest,
    PluginRegistry,
    PluginRegistryError,
    RegistrationHandle,
)

MODEL_PLUGIN_KIND = "model-adapter"
MODEL_MEDIA_TYPES = frozenset({"chat", "image", "video", "audio", "workflow"})

ReadyOperationsSource = Callable[[], Mapping[str, Collection[str]]]

# "已接线操作"的事实源：名字 → 取 plugin_id → 操作集合的函数。
# seam 模块 import 时会用同名登记自己的注册表（见 CapabilitySeam.ready_source），
# 这张表只是兜底：本进程还没 import 过那个 seam 时按模块路径惰性加载，
# 保证 API / worker 看到的目录一致，也避免目录模块反向 import 各 seam。
_ready_sources: dict[str, ReadyOperationsSource] = {}


def register_ready_operations_source(
    name: str,
    source: ReadyOperationsSource,
) -> Callable[[], None]:
    """登记一处已接线事实源，返回注销函数；同名登记直接覆盖。"""
    key = name.strip().lower()
    if not key:
        raise PluginRegistryError("已接线事实源名字不能为空")
    _ready_sources[key] = source

    def detach() -> None:
        if _ready_sources.get(key) is source:
            _ready_sources.pop(key, None)

    return detach


def _lazy_source(name: str, module_name: str, attribute: str) -> ReadyOperationsSource:
    """按模块路径惰性取注册表：旧 seam 暴露 ``*_route_provider_views``，新 seam 暴露实例。"""

    def source() -> Mapping[str, Collection[str]]:
        target = getattr(import_module(module_name), attribute)
        provider_operations = getattr(target, "provider_operations", None)
        if callable(provider_operations):
            return dict(provider_operations())
        views = target()
        key = f"{name}_provider_operations"
        return {plugin_id: tuple(view.get(key) or ()) for plugin_id, view in views.items()}

    return source


for _name, _module, _attribute in (
    ("chat", "domain.model_runtime", "chat_route_provider_views"),
    ("image", "domain.imagegen", "image_route_provider_views"),
    ("video", "domain.video_generation", "video_route_provider_views"),
    ("audio", "domain.audio_runtime", "audio_route_provider_views"),
    ("workflow", "domain.workflow_execution", "workflow_route_provider_views"),
    ("asr", "domain.transcribe", "asr_runtime"),
    ("realtime", "domain.volc_realtime", "realtime_runtime"),
    ("midjourney", "domain.midjourney", "midjourney_runtime"),
):
    register_ready_operations_source(_name, _lazy_source(_name, _module, _attribute))


def wired_operations_index() -> dict[str, frozenset[str]]:
    """一次扫完所有事实源：plugin_id → 已接线操作。"""
    index: dict[str, set[str]] = {}
    for source in list(_ready_sources.values()):
        for plugin_id, operations in source().items():
            bucket = index.setdefault(plugin_id.strip().lower(), set())
            bucket.update(value.strip().lower() for value in operations if value.strip())
    return {plugin_id: frozenset(values) for plugin_id, values in index.items()}


def wired_operations(plugin_id: str) -> frozenset[str]:
    normalized = plugin_id.strip().lower()
    wired: set[str] = set()
    for source in list(_ready_sources.values()):
        wired.update(
            value.strip().lower() for value in source().get(normalized, ()) if value.strip()
        )
    return frozenset(wired)


@dataclass(frozen=True)
class ModelPlugin:
    id: str
    name: str
    media_types: frozenset[str]
    operations: frozenset[str]
    provider_types: frozenset[str]
    execution: str

    def supports(self, operation: str) -> bool:
        return operation.strip().lower() in self.operations

    def wired_operations(self) -> frozenset[str]:
        """已接线操作：声明过且某条 seam 注册表里挂着 Provider。"""
        return wired_operations(self.id) & self.operations

    def is_ready(self, operation: str) -> bool:
        normalized = operation.strip().lower()
        return normalized in self.operations and normalized in wired_operations(self.id)

    @property
    def ready_operations(self) -> frozenset[str]:
        """旧 seam 注册守卫读的"可接线上限"，等于声明的 operations。

        已接线集合看 :meth:`wired_operations`；五份旧 seam 迁到 CapabilitySeam 后删除。
        """
        return self.operations

    def view(self, manifest: PluginManifest, wired: Collection[str] | None = None) -> dict:
        ready = (frozenset(wired) if wired is not None else wired_operations(self.id))
        ready &= self.operations
        ready_media = sorted({value.split(".", 1)[0] for value in ready})
        return {
            "id": self.id,
            "name": self.name,
            "version": manifest.version,
            "description": manifest.description,
            "media_types": sorted(self.media_types),
            "operations": sorted(self.operations),
            "ready_operations": sorted(ready),
            "ready_media_types": ready_media,
            "provider_types": sorted(self.provider_types),
            "execution": self.execution,
            "priority": manifest.priority,
        }


_registry: PluginRegistry[ModelPlugin] = PluginRegistry(MODEL_PLUGIN_KIND)


def register_model_plugin(
    *,
    plugin_id: str,
    name: str,
    media_types: set[str] | frozenset[str],
    operations: set[str] | frozenset[str],
    provider_types: set[str] | frozenset[str] = frozenset(),
    execution: str = "direct",
    version: str = "1.0.0",
    description: str = "",
    priority: int = 0,
    replace: bool = False,
) -> RegistrationHandle:
    normalized_media = frozenset(value.strip().lower() for value in media_types)
    unknown = normalized_media - MODEL_MEDIA_TYPES
    if unknown:
        raise PluginRegistryError(f"模型插件包含未知媒体类型：{sorted(unknown)}")
    normalized_operations = frozenset(value.strip().lower() for value in operations)
    plugin = ModelPlugin(
        id=plugin_id.strip().lower(),
        name=name.strip(),
        media_types=normalized_media,
        operations=normalized_operations,
        provider_types=frozenset(value.strip().lower() for value in provider_types),
        execution=execution.strip().lower(),
    )
    manifest = PluginManifest(
        id=plugin.id,
        kind=MODEL_PLUGIN_KIND,
        name=plugin.name,
        version=version,
        description=description,
        capabilities=normalized_operations,
        priority=priority,
    )
    return _registry.register(manifest, plugin, replace=replace)


def get_model_plugin(plugin_id: str) -> ModelPlugin:
    return _registry.require(plugin_id).implementation


def has_model_plugin(plugin_id: str) -> bool:
    return _registry.get(plugin_id) is not None


def model_plugin_ids() -> frozenset[str]:
    return frozenset(item.manifest.id for item in _registry.list())


def model_plugin_identity(plugin_id: str) -> tuple[str, int]:
    registration = _registry.require(plugin_id)
    return registration.manifest.version, registration.generation


def list_model_plugins() -> list[dict[str, Any]]:
    wired = wired_operations_index()
    return [
        item.implementation.view(item.manifest, wired.get(item.manifest.id, frozenset()))
        for item in _registry.list()
    ]


def adapter_for_provider(
    provider_type: str,
    *,
    fallback: str = "openai",
    operation: str | None = None,
) -> str:
    """按凭据类型挑默认 adapter：优先级高的插件先命中。

    同一 provider_type 可以被多个插件认领，优先级决定默认走哪条。传 ``operation``
    时只在已接线的插件里找，没有就回 ``fallback``。
    """
    normalized = provider_type.strip().lower()
    matches = [
        item
        for item in _registry.list()
        if normalized in item.implementation.provider_types
        and (operation is None or item.implementation.is_ready(operation))
    ]
    return matches[0].manifest.id if matches else fallback


def _register_builtins() -> tuple[RegistrationHandle, ...]:
    specs = (
        {
            "plugin_id": "openai",
            "name": "OpenAI 兼容直连",
            "media_types": {"chat", "image", "video"},
            "operations": {
                "chat.complete",
                "chat.stream",
                "image.generate",
                "image.edit",
                "image.stream",
                "video.generate",
            },
            # DeepSeek 官方 API 本身就是 OpenAI 兼容的，走这条直连
            "provider_types": {
                "deepseek",
                "openai",
                "openai_compatible",
                "openai_image",
                "openai_video",
            },
            "priority": 90,
        },
        {
            "plugin_id": "gemini",
            "name": "Gemini 原生",
            "media_types": {"chat", "image"},
            "operations": {"chat.complete", "chat.stream", "image.generate", "image.edit"},
            "provider_types": {"gemini", "gemini_image"},
            "priority": 70,
        },
        {
            "plugin_id": "volcengine",
            "name": "火山引擎",
            "media_types": {"video", "audio"},
            "operations": {
                "video.generate",
                "audio.synthesize",
                "realtime.session",
                "realtime.duplex",
            },
            "provider_types": {"volcengine_video", "volc_speech", "volc_realtime"},
            "priority": 70,
        },
        {
            "plugin_id": "azure-speech",
            "name": "Azure Speech",
            "media_types": {"audio"},
            "operations": {"audio.synthesize"},
            "provider_types": {"azure_speech"},
            "priority": 40,
        },
        {
            "plugin_id": "bailian-tts",
            "name": "阿里百炼语音",
            "media_types": {"audio"},
            "operations": {"audio.synthesize"},
            "provider_types": {"bailian_tts"},
            "priority": 40,
        },
        {
            "plugin_id": "cartesia",
            "name": "Cartesia",
            "media_types": {"audio"},
            "operations": {"audio.synthesize"},
            "provider_types": {"cartesia_tts"},
            "priority": 40,
        },
        {
            "plugin_id": "minimax-tts",
            "name": "MiniMax 试听",
            "media_types": {"audio"},
            "operations": {"audio.synthesize"},
            "provider_types": {"minimax_tts"},
            "priority": 40,
        },
        {
            "plugin_id": "edge-tts",
            "name": "Edge TTS",
            "media_types": {"audio"},
            "operations": {"audio.synthesize"},
            "provider_types": {"edge_tts"},
            "priority": 40,
        },
        {
            "plugin_id": "faster-whisper",
            "name": "Faster Whisper 本地 ASR",
            "media_types": {"audio"},
            "operations": {"asr.transcribe"},
            "provider_types": {"faster_whisper"},
            "execution": "local",
            "priority": 60,
        },
        {
            # > [!danger] 优先级必须低于 volcengine(70)，它俩认领同一个 provider_type
            #
            # 火山的 TTS、实时语音、ASR 共用一把 key，凭据类型都是 volc_speech。
            # `adapter_for_provider(provider_type)` 不带 operation 时按 (-priority, id)
            # 取第一个——同为 70 时 "volc-asr" < "volcengine"，于是 TTS 解析到一个
            # 没声明 audio.synthesize 的插件，`/tts` 三条分支里两条当场 503，
            # 且与配没配 ASR 凭据无关。调用侧补 operation 是正解（见 tts.py），
            # 这里压低优先级是第二道：让「不带 operation 问 volc_speech」
            # 保持接火山 ASR 之前的答案。
            #
            # ASR 选路不看这个数：`prepare_volc_asr_route` 显式给 plugin_id。
            "plugin_id": "volc-asr",
            "name": "火山大模型录音文件识别（极速版）",
            "media_types": {"audio"},
            "operations": {"asr.transcribe"},
            "provider_types": {"volc_speech"},
            "priority": 65,
        },
        {
            "plugin_id": "apimart",
            "name": "APIMart",
            "media_types": {"image"},
            "operations": {
                "image.generate",
                "image.edit",
                "midjourney.imagine",
                "midjourney.blend",
                "midjourney.edit",
                "midjourney.upscale",
                "midjourney.variation",
                "midjourney.high_variation",
                "midjourney.low_variation",
                "midjourney.reroll",
                "midjourney.zoom",
                "midjourney.pan",
                "midjourney.inpaint",
                "midjourney.modal",
                "midjourney.remix_strong",
                "midjourney.remix_subtle",
                "midjourney.poll",
            },
            "provider_types": {"apimart"},
        },
        {
            "plugin_id": "tudou",
            "name": "土豆兼容",
            "media_types": {"image"},
            "operations": {"image.generate", "image.edit"},
        },
        {
            "plugin_id": "modelscope",
            "name": "ModelScope",
            "media_types": {"image"},
            "operations": {"image.generate", "image.edit"},
        },
        {
            "plugin_id": "jimeng",
            "name": "即梦",
            "media_types": {"image", "video"},
            "operations": {"image.generate", "image.edit", "image.upscale", "video.generate"},
            "provider_types": {"jimeng_cli"},
            "execution": "connector",
        },
        {
            "plugin_id": "runninghub",
            "name": "RunningHub",
            "media_types": {"workflow"},
            "operations": {"workflow.run"},
            "execution": "workflow",
        },
        {
            "plugin_id": "comfyui",
            "name": "ComfyUI",
            "media_types": {"workflow"},
            "operations": {"workflow.run"},
            "execution": "workflow",
        },
        {
            "plugin_id": "codex",
            "name": "Codex CLI",
            "media_types": {"chat", "image"},
            "operations": {"chat.complete", "chat.stream", "image.generate", "image.edit"},
            "provider_types": {"codex_cli"},
            "execution": "connector",
        },
        {
            "plugin_id": "gemini-cli",
            "name": "Gemini CLI",
            "media_types": {"chat", "image"},
            "operations": {"chat.complete", "chat.stream", "image.generate", "image.edit"},
            "provider_types": {"gemini_cli"},
            "execution": "connector",
        },
    )
    return tuple(register_model_plugin(**spec) for spec in specs)


_BUILTIN_HANDLES = _register_builtins()
