"""生图服务层（模块 16 FR-407）：唯一出口，四步编排。

调用方有三个——管线节点、生图工作台、其它模块直接调——它们拿到的是同一套用途
定义、同一套风格预设、同一套失败语义。不存在第二条代码路径。

模型按**能力名**路由（`image-cover` / `image-illustration` / `image-free`），
业务代码里不出现任何模型名与密钥（BR-100，与 LLM 同一条铁律）。换模型是在配置中心改一次
绑定的事；能力没绑定部署就直接报「未绑定」。上游真名只在台账与 UI 的「模型」位出现。

四步：

    plan_brief   LLM 把主体信息想成具体可画之物
    render_prompt 骨架 + 风格预设 + 构图禁区 → 最终提示词
    render_images 按绑定直连模型，拿 n 张候选
    ingest        体检、转码、派生缩略图、入资产库

`generate_for()` 把四步串起来，给"我只想要一张图"的调用方；管线把四步拆成节点，
给"我要看每一步、想单独重跑其中一步"的场景。两者共用同一组函数。
"""

from __future__ import annotations

import asyncio
import base64
import logging
import time
from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from openai import APIConnectionError, APIStatusError, APITimeoutError, AsyncOpenAI
from sqlalchemy.ext.asyncio import AsyncSession

from domain import (
    cli_bridge,
    gateway,
    image_assets,
    image_defaults,
    image_prompts,
    modelscope_image,
    openai_image_protocols,
)
from domain.image_prompts import ImageTarget, PromptError
from domain.kernel.llm_types import LlmFailureCode
from domain.llm import LLMUnavailable, complete_json
from domain.model_catalog import ResolvedModelRoute, resolve_model_route
from domain.model_invocations import ModelInvocationSpan
from domain.model_plugins import get_model_plugin, model_plugin_identity
from domain.model_runtime import unbound_capability_message
from domain.network_policy import routed_http_client
from domain.plugin_runtime import (
    PluginManifest,
    PluginRegistry,
    PluginRegistryError,
    RegistrationHandle,
)
from domain.providers.openai_chat import failure_from_exception

logger = logging.getLogger(__name__)

# 生图能力名
IMAGE_CAPABILITIES = ("image-cover", "image-illustration", "image-free")

# 立意那一步用哪个 LLM 能力。它只是把中文场景想成英文画面，不需要强模型
BRIEF_CAPABILITY = "explain-standard"

# 出图比聊天慢得多：1024 见方 medium 档实测十几秒，high 档更久
IMAGE_TIMEOUT_S = 240.0
MAX_N = 4
IMAGE_STREAM_NOT_SUPPORTED = "上游未透传流式，请改用非流式"

# openai SDK 的 images.generate 认得的可选参数。不在这张表里的走 extra_body
SDK_KNOWN = frozenset(
    {"background", "moderation", "output_compression", "output_format", "quality", "size"}
)
# 绑定参数里允许当请求缺省值的键：尺寸 / 质量 / 张数永远由调用方决定，绑定参数不碰
BINDING_PARAM_KEYS = frozenset({"background", "moderation", "output_compression", "output_format"})

# 出图失败后值得换下一条候选部署再试的失败码；鉴权 / 请求非法换供应商也是同样的错
IMAGE_FALLBACK_CODES: frozenset[str] = frozenset({"RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"})
_KIND_CODES: dict[str, LlmFailureCode] = {
    "timeout": "TIMEOUT",
    "connect": "TRANSPORT",
    "auth": "AUTH",
    "content": "INVALID_REQUEST",
    "binding": "INVALID_REQUEST",
}


class ImageGenError(Exception):
    """生图失败。`kind` 分型供 UI 决定提示什么：

    connect  上游连不上
    auth     密钥无效
    timeout  超时
    binding  能力没绑或绑得不完整
    content  提示词被上游安全策略拒绝
    api      其余上游错误
    """

    def __init__(self, kind: str, message: str, *, code: LlmFailureCode | None = None) -> None:
        super().__init__(message)
        self.kind = kind
        # 内核中立失败码；没显式给的按 kind 或原始异常推断（见 image_failure_code）
        self.code = code


def image_failure_code(exc: BaseException) -> LlmFailureCode:
    """出图异常 → 稳定失败码：显式码 > 链上的 SDK 异常 > 分型映射 > UNKNOWN。"""
    if isinstance(exc, asyncio.CancelledError):
        return "ABORTED"
    explicit = getattr(exc, "code", None)
    if isinstance(exc, ImageGenError) and isinstance(explicit, str):
        return explicit  # type: ignore[return-value]
    cause: BaseException | None = exc
    while cause is not None:
        if isinstance(cause, APIStatusError | APIConnectionError | APITimeoutError):
            return failure_from_exception(cause).code
        cause = cause.__cause__
    if isinstance(exc, ImageGenError):
        return _KIND_CODES.get(exc.kind, "UNKNOWN")
    return failure_from_exception(exc).code


@dataclass
class RenderResult:
    """一次上游调用的结果：n 张图的原始字节 + 计费信息。"""

    images: list[bytes]
    model_reported: str | None = None
    usage: dict | None = None
    latency_ms: int = 0
    revised_prompts: list[str] = field(default_factory=list)


@runtime_checkable
class ImageRouteProvider(Protocol):
    """图片 Service Provider：持有某一模型插件的真实协议实现。

    只有 generate / edit 是每个 Provider 都得有的。放大与流式各自只有一家上游支持
    （放大是即梦 CLI，流式是 OpenAI 兼容线），并进这个协议就等于逼另外三个 Provider
    写一堆只会抛异常的空方法——真正决定谁会被调到的是注册时声明的 operations。
    """

    async def generate(self, route: PreparedImageRoute, **kwargs: Any) -> RenderResult: ...

    async def edit(self, route: PreparedImageRoute, **kwargs: Any) -> RenderResult: ...


@runtime_checkable
class UpscaleImageProvider(ImageRouteProvider, Protocol):
    """额外支持 `image.upscale` 的 Provider。"""

    async def upscale(self, route: PreparedImageRoute, **kwargs: Any) -> RenderResult: ...


@runtime_checkable
class StreamingImageProvider(ImageRouteProvider, Protocol):
    """额外支持 `image.stream` 的 Provider。"""

    def open_stream_client(self, route: PreparedImageRoute, timeout: float) -> tuple[Any, str]: ...


@dataclass(frozen=True)
class ImageRouteSnapshot:
    capability: str
    operation: str
    deployment_id: int
    plugin_id: str
    plugin_version: str
    plugin_generation: int
    runtime_generation: int
    provider_type: str
    # 实际发给端点的模型名
    model: str
    # 部署行上的上游真名。台账靠它显示真实模型
    upstream_model_id: str
    # 这条路由怎么选出来的（explicit / binding / fallback）与后备候选视图
    selection_source: str
    fallbacks: tuple[dict[str, Any], ...] = ()
    # 绑定上的调用参数；只有 BINDING_PARAM_KEYS 里的键会当请求缺省值
    params: dict[str, Any] = field(default_factory=dict)

    def view(self) -> dict[str, Any]:
        return {
            "capability": self.capability,
            "operation": self.operation,
            "deployment_id": self.deployment_id,
            "plugin_id": self.plugin_id,
            "plugin_version": self.plugin_version,
            "plugin_generation": self.plugin_generation,
            "runtime_generation": self.runtime_generation,
            "provider_type": self.provider_type,
            "model": self.model,
            "upstream_model_id": self.upstream_model_id,
            "selection_source": self.selection_source,
            "fallbacks": [dict(item) for item in self.fallbacks],
            "params": dict(self.params),
        }


@dataclass(frozen=True)
class PreparedImageRoute:
    """绑定模型插件与图片 Provider 代际的不可变执行准备结果。"""

    snapshot: ImageRouteSnapshot
    _route: ResolvedModelRoute = field(repr=False, compare=False)
    _provider: ImageRouteProvider = field(repr=False, compare=False)

    async def generate(self, **kwargs: Any) -> RenderResult:
        return await self._provider.generate(self, **kwargs)

    async def edit(self, **kwargs: Any) -> RenderResult:
        return await self._provider.edit(self, **kwargs)

    async def upscale(self, **kwargs: Any) -> RenderResult:
        # 能走到这里说明路由把 image.upscale 派给了不支持放大的 Provider——
        # 注册时的 operations 校验本该拦住，兜底给一句能看懂的话而不是 AttributeError
        provider = self._provider
        if not isinstance(provider, UpscaleImageProvider):
            raise ImageGenError("binding", f"{self.snapshot.plugin_id} 的部署不支持图片放大")
        return await provider.upscale(self, **kwargs)

    def open_stream_client(self, timeout: float) -> tuple[Any, str]:
        provider = self._provider
        if not isinstance(provider, StreamingImageProvider):
            raise ImageGenError("api", IMAGE_STREAM_NOT_SUPPORTED)
        return provider.open_stream_client(self, timeout)


IMAGE_PROVIDER_KIND = "model-image-provider"
_image_providers: PluginRegistry[ImageRouteProvider] = PluginRegistry(IMAGE_PROVIDER_KIND)


def register_image_route_provider(
    *,
    plugin_id: str,
    provider: ImageRouteProvider,
    operations: set[str] | frozenset[str],
    replace: bool = False,
) -> RegistrationHandle:
    """登记可撤销图片 Provider；替换句柄卸载后恢复上一代实现。"""
    plugin = get_model_plugin(plugin_id)
    normalized = frozenset(value.strip().lower() for value in operations if value.strip())
    if not normalized:
        raise PluginRegistryError("图片 Provider 至少要声明一个操作")
    if not normalized <= plugin.ready_operations:
        raise PluginRegistryError(
            f"图片 Provider 操作必须属于模型插件 {plugin.id} 的 ready_operations"
        )
    manifest = PluginManifest(
        id=plugin.id,
        kind=IMAGE_PROVIDER_KIND,
        name=f"{plugin.name} Image Provider",
        version="1.0.0",
        capabilities=normalized,
    )
    return _image_providers.register(manifest, provider, replace=replace)


def image_route_provider_views() -> dict[str, dict[str, Any]]:
    return {
        item.manifest.id: {
            "image_provider_operations": sorted(item.manifest.capabilities),
            "image_runtime_generation": item.generation,
        }
        for item in _image_providers.list()
    }


def prepare_image_route(
    capability: str,
    operation: str,
    route: ResolvedModelRoute | None,
) -> PreparedImageRoute:
    """冻结已解析模型路由与当前图片 Provider 实现。

    ``route`` 为 None 意味着这条能力没有任何可用部署，直接抛「未绑定」。
    """
    normalized_operation = operation.strip().lower()
    if route is None:
        raise ImageGenError("binding", unbound_capability_message(capability))
    plugin_id = route.adapter_type
    try:
        plugin = get_model_plugin(plugin_id)
        runtime = _image_providers.resolve(normalized_operation, preferred_id=plugin.id)
    except (ValueError, PluginRegistryError) as exc:
        raise ImageGenError(
            "binding", f"模型插件 {plugin_id} 没有可用的 {normalized_operation} Provider"
        ) from exc
    if not plugin.supports(normalized_operation):
        raise ImageGenError("binding", f"模型插件 {plugin.id} 不支持操作：{normalized_operation}")
    if not plugin.is_ready(normalized_operation):
        raise ImageGenError(
            "binding", f"模型插件 {plugin.id} 的 {normalized_operation} 尚未接入执行"
        )
    version, generation = model_plugin_identity(plugin.id)
    frozen_route = deepcopy(route)
    model = route.upstream_model_id
    return PreparedImageRoute(
        snapshot=ImageRouteSnapshot(
            capability=capability,
            operation=normalized_operation,
            deployment_id=route.deployment_id,
            plugin_id=plugin.id,
            plugin_version=version,
            plugin_generation=generation,
            runtime_generation=runtime.generation,
            provider_type=route.provider_type,
            model=model,
            upstream_model_id=route.upstream_model_id,
            selection_source=route.source,
            # 候选与绑定参数随路由一起冻结：fallback 切换时用这份脱敏视图，不再回库
            fallbacks=tuple(item.view() for item in route.fallbacks),
            params={k: v for k, v in route.params.items() if v is not None},
        ),
        _route=frozen_route,
        _provider=runtime.implementation,
    )


def _route_candidates(route: ResolvedModelRoute | None) -> list[ResolvedModelRoute | None]:
    """主路由 + 它挂着的 fallback 候选。

    route 为 None 时仍返回 ``[None]``：让「未绑定」由 prepare_image_route 统一抛，
    错误文案只有一处。
    """
    if route is None:
        return [None]
    fallbacks = getattr(route, "fallbacks", ()) or ()
    return [route, *fallbacks]


def route_client(route: ResolvedModelRoute) -> tuple[AsyncOpenAI, str]:
    """按部署直连上游：只支持 OpenAI 兼容那一族适配器。"""
    if route.adapter_type not in {"openai", "apimart", "tudou", "modelscope"}:
        raise ImageGenError(
            "binding",
            f"模型 {route.upstream_model_id} 的 adapter={route.adapter_type} 尚未实现图片调用",
        )
    from domain.credentials import CredentialError, openai_base

    try:
        base_url = openai_base(route.credential_config, route.provider_type)
    except CredentialError as exc:
        raise ImageGenError("binding", str(exc)) from exc
    return (
        AsyncOpenAI(
            base_url=base_url,
            api_key=str(route.credential_config.get("api_key") or "not-required"),
            timeout=IMAGE_TIMEOUT_S,
            max_retries=0,
            # 上游是本机时不能走系统代理，否则全部调用静默 502（见 domain/gateway）
            http_client=gateway.http_client(IMAGE_TIMEOUT_S, base_url),  # type: ignore[arg-type]
        ),
        route.upstream_model_id,
    )


def classify(exc: Exception) -> tuple[str, str]:
    """上游异常 → (分型, 面向用户的中文消息)。"""
    if isinstance(exc, APITimeoutError):
        return "timeout", f"生图超时（{int(IMAGE_TIMEOUT_S)}s），换低一档质量或小一点的尺寸再试"
    if isinstance(exc, APIConnectionError):
        return "connect", "连不上模型服务，请检查供应商地址、网络和服务状态"
    if isinstance(exc, APIStatusError):
        status = exc.status_code
        detail = str(getattr(exc, "message", "") or exc)[:300]
        if status in (401, 403):
            return "auth", f"上游拒绝鉴权（HTTP {status}）：{detail}"
        if status == 400 and any(
            token in detail.lower() for token in ("safety", "moderation", "policy", "rejected")
        ):
            return "content", f"提示词被上游安全策略拒绝：{detail}"
        if status == 404:
            return (
                "binding",
                f"上游没有这个模型（HTTP 404）：{detail}。"
                "到设置 · 模型服务把生图能力绑到一个具体模型上",
            )
        return "api", f"上游返回 HTTP {status}：{detail}"
    return "api", f"{type(exc).__name__}: {exc}"[:300]


# ---- ① 立意 ----


async def plan_brief(
    target: ImageTarget,
    subject: dict,
    idea: str = "",
    *,
    aspects: list[dict] | None = None,
) -> dict:
    """让 LLM 把主体信息想成具体可画之物。

    `aspects` 非空时顺带让它挑画幅（用户选了「不指定比例」）。候选清单由调用方给，
    因为比例目录住在 image_sizes，而那个模块 import 本模块的上游。

    失败不抛：brief 是锦上添花，拿不到就退回用主体原文当 focal——
    图会平庸但不会没有（BR-108 生图失败不阻断宿主流程的同一精神）。
    """
    system, user = image_prompts.build_brief_prompt(target, subject, idea, aspects=aspects)
    try:
        raw, _model, _ms = await complete_json(BRIEF_CAPABILITY, system, user)
    except LLMUnavailable as exc:
        logger.warning("生图立意失败，退回主体原文：%s", exc)
        return image_prompts.clean_brief({"focal": _fallback_focal(subject, idea)})
    return image_prompts.clean_brief(raw)


def _fallback_focal(subject: dict, idea: str) -> str:
    for key in ("title_en", "title", "name", "description"):
        value = str(subject.get(key) or "").strip()
        if value:
            return value
    return idea or "a simple everyday scene"


# ---- ③ 出图 ----


async def render_images(
    prompt: str,
    *,
    # 装的是能力名（image-cover 这种）。参数名还叫 alias 是网关时代留下的，
    # 路由器 / worker / 画布都按关键字传，改名要连调用方一起动，见 blockers
    alias: str,
    size: str,
    quality: str = image_defaults.FALLBACK_QUALITY,
    n: int = 1,
    output_format: str = "png",
    background: str | None = None,
    extra: dict | None = None,
    route: ResolvedModelRoute | None = None,
) -> RenderResult:
    """生图公开出口：执行层可替换，调用台账在这个稳定边界统一记录。

    主路由失败且失败码属于 IMAGE_FALLBACK_CODES 时按 ``route.fallbacks`` 依次换候选；
    每次尝试各记一行台账，后续尝试带 parent_invocation_id / attempt。
    """
    candidates = _route_candidates(route)
    parent_id: str | None = None
    for attempt, candidate in enumerate(candidates, 1):
        last = attempt == len(candidates)
        try:
            prepared = prepare_image_route(alias, "image.generate", candidate)
        except ImageGenError as exc:
            if last:
                raise
            logger.warning("生图候选 %s 无法准备，跳过：%s", attempt, exc)
            continue
        snapshot = prepared.snapshot
        span = await ModelInvocationSpan(
            plugin_id=snapshot.plugin_id,
            plugin_version=snapshot.plugin_version,
            plugin_generation=snapshot.plugin_generation,
            runtime_generation=snapshot.runtime_generation,
            operation=snapshot.operation,
            capability=alias,
            deployment_id=snapshot.deployment_id,
            model=snapshot.model,
            request={
                "prompt": prompt,
                "size": size,
                "quality": quality,
                "n": n,
                "output_format": output_format,
                "background": background,
                "extra": extra,
                "route": snapshot.view(),
            },
            parent_invocation_id=parent_id,
            attempt=attempt,
        ).start()
        try:
            result = await _render_images_impl(
                prompt,
                capability=alias,
                size=size,
                quality=quality,
                n=n,
                output_format=output_format,
                background=background,
                extra=extra,
                route=candidate,
                prepared=prepared,
            )
        except BaseException as exc:
            code = image_failure_code(exc)
            status = "cancelled" if isinstance(exc, asyncio.CancelledError) else "failed"
            await span.fail(exc, status=status, code=code)
            if status == "cancelled" or last or code not in IMAGE_FALLBACK_CODES:
                raise
            parent_id = parent_id or span.id
            logger.warning(
                "生图候选 %s 失败（%s），切到下一条候选：%s", snapshot.deployment_id, code, exc
            )
            continue
        await span.succeed(
            model=result.model_reported or snapshot.model,
            response={
                "image_count": len(result.images),
                "revised_prompts": result.revised_prompts,
            },
            usage=result.usage,
        )
        return result
    raise ImageGenError("binding", "没有可用的生图候选")


async def _render_images_impl(
    prompt: str,
    *,
    capability: str,
    size: str,
    quality: str = image_defaults.FALLBACK_QUALITY,
    n: int = 1,
    output_format: str = "png",
    background: str | None = None,
    extra: dict | None = None,
    route: ResolvedModelRoute | None = None,
    prepared: PreparedImageRoute | None = None,
) -> RenderResult:
    """调生图模型。返回 n 张原始字节。

    GPT image 系列**只回 b64_json 不回 url**，所以这里不做 URL 分支；
    但仍兼容返回 url 的供应商（如部分 Imagen 配置），拿到 url 就下回来。
    """
    if n < 1 or n > MAX_N:
        raise ImageGenError("api", f"单次张数须在 1~{MAX_N} 之间，收到 {n}")
    size = image_prompts.validate_size(size)
    if quality not in image_prompts.QUALITIES:
        raise ImageGenError("api", f"未知质量档：{quality}")
    # 「自动」= 请求里干脆不带 size，让上游按提示词内容自己判断。
    # 传一个占位尺寸等于替用户做了决定，而他选的正是「别替我决定」。
    auto_size = image_prompts.is_auto_size(size)
    selected = prepared or prepare_image_route(capability, "image.generate", route)
    return await selected.generate(
        prompt=prompt,
        capability=capability,
        size=size,
        quality=quality,
        n=n,
        output_format=output_format,
        background=background,
        extra=extra,
        auto_size=auto_size,
    )


async def _openai_generate(
    route: PreparedImageRoute,
    *,
    prompt: str,
    capability: str,
    size: str,
    quality: str,
    n: int,
    output_format: str,
    background: str | None,
    extra: dict | None,
    auto_size: bool,
) -> RenderResult:
    resolved = route._route
    if openai_image_protocols.uses_custom_protocol(resolved):
        try:
            result = await openai_image_protocols.render(
                route=resolved,
                prompt=prompt,
                size=size,
                quality=quality,
                n=n,
                images=[],
            )
        except openai_image_protocols.ProtocolImageError as exc:
            raise ImageGenError(exc.kind, str(exc)) from exc
        return RenderResult(
            images=result.images,
            model_reported=result.model_reported,
            usage=result.usage,
            latency_ms=result.latency_ms,
        )

    client, model_name = route_client(resolved)
    kwargs: dict = {
        "model": model_name,
        "prompt": prompt,
        "quality": quality,
        "n": n,
        "output_format": output_format,
    }
    if not auto_size:
        kwargs["size"] = size
    if background:
        kwargs["background"] = background
    # 高级参数整包透传。SDK 的 generate 不认的（如 input_fidelity）走 extra_body，
    # 直接当命名参数发会 TypeError
    for key, value in (extra or {}).items():
        if value is None or key in kwargs:
            continue
        if key in SDK_KNOWN:
            kwargs[key] = value
        else:
            kwargs.setdefault("extra_body", {})[key] = value
    # 绑定参数只当缺省值：调用方给了的不动，尺寸 / 质量 / 张数根本不在候选键里
    for key, value in route.snapshot.params.items():
        if key in BINDING_PARAM_KEYS and key not in kwargs and value is not None:
            kwargs[key] = value
    started = time.monotonic()
    try:
        resp = await client.images.generate(**kwargs)
    except Exception as exc:
        kind, message = classify(exc)
        raise ImageGenError(kind, message, code=image_failure_code(exc)) from exc
    finally:
        await client.close()

    latency_ms = int((time.monotonic() - started) * 1000)
    images: list[bytes] = []
    revised: list[str] = []
    for item in resp.data or []:
        if getattr(item, "revised_prompt", None):
            revised.append(str(item.revised_prompt))
        if item.b64_json:
            images.append(base64.b64decode(item.b64_json))
        elif getattr(item, "url", None):
            images.append(await _fetch(str(item.url)))
    if not images:
        raise ImageGenError("api", "上游返回了空结果，一张图都没有")
    usage = resp.usage.model_dump() if getattr(resp, "usage", None) else None
    return RenderResult(
        images=images,
        model_reported=getattr(resp, "model", None),
        usage=usage,
        latency_ms=latency_ms,
        revised_prompts=revised,
    )


async def _fetch(url: str) -> bytes:

    async with routed_http_client(timeout=60.0) as http:
        resp = await http.get(url)
    if resp.status_code >= 400:
        raise ImageGenError("api", f"取图失败 HTTP {resp.status_code}")
    return resp.content


async def edit_images(
    prompt: str,
    *,
    # 装的是能力名（image-cover 这种）。参数名还叫 alias 是网关时代留下的，
    # 路由器 / worker / 画布都按关键字传，改名要连调用方一起动，见 blockers
    alias: str,
    images: list[tuple[str, bytes]],
    mask: tuple[str, bytes] | None = None,
    size: str | None = None,
    quality: str = image_defaults.FALLBACK_QUALITY,
    n: int = 1,
    input_fidelity: str | None = None,
    route: ResolvedModelRoute | None = None,
) -> RenderResult:
    """图片编辑公开出口：只记输入摘要，不把原始图片字节写入日志。"""
    prepared = prepare_image_route(alias, "image.edit", route)
    snapshot = prepared.snapshot
    span = await ModelInvocationSpan(
        plugin_id=snapshot.plugin_id,
        plugin_version=snapshot.plugin_version,
        plugin_generation=snapshot.plugin_generation,
        runtime_generation=snapshot.runtime_generation,
        operation=snapshot.operation,
        capability=alias,
        deployment_id=snapshot.deployment_id,
        model=snapshot.model,
        request={
            "prompt": prompt,
            "inputs": [{"name": name, "bytes": len(data)} for name, data in images],
            "mask": None if mask is None else {"name": mask[0], "bytes": len(mask[1])},
            "size": size,
            "quality": quality,
            "n": n,
            "input_fidelity": input_fidelity,
            "route": snapshot.view(),
        },
    ).start()
    try:
        result = await _edit_images_impl(
            prompt,
            capability=alias,
            images=images,
            mask=mask,
            size=size,
            quality=quality,
            n=n,
            input_fidelity=input_fidelity,
            route=route,
            prepared=prepared,
        )
    except BaseException as exc:
        status = "cancelled" if isinstance(exc, asyncio.CancelledError) else "failed"
        await span.fail(exc, status=status)
        raise
    await span.succeed(
        model=result.model_reported or snapshot.model,
        response={"image_count": len(result.images)},
        usage=result.usage,
    )
    return result


async def upscale_jimeng_image(
    image: tuple[str, bytes],
    *,
    resolution_type: str,
    route: ResolvedModelRoute,
) -> RenderResult:
    """Dreamina native 2K/4K/8K upscale with the normal invocation ledger."""
    prepared = prepare_image_route("image-free", "image.upscale", route)
    snapshot = prepared.snapshot
    span = await ModelInvocationSpan(
        plugin_id=snapshot.plugin_id,
        plugin_version=snapshot.plugin_version,
        plugin_generation=snapshot.plugin_generation,
        runtime_generation=snapshot.runtime_generation,
        operation=snapshot.operation,
        capability="image-free",
        deployment_id=snapshot.deployment_id,
        model=snapshot.model,
        request={
            "input": {"name": image[0], "bytes": len(image[1])},
            "resolution_type": resolution_type,
            "route": snapshot.view(),
        },
    ).start()
    try:
        result = await prepared.upscale(
            image=image,
            resolution_type=resolution_type,
        )
    except BaseException as exc:
        status = "cancelled" if isinstance(exc, asyncio.CancelledError) else "failed"
        await span.fail(exc, status=status)
        raise
    await span.succeed(response={"image_count": len(result.images)})
    return result


async def _edit_images_impl(
    prompt: str,
    *,
    capability: str,
    images: list[tuple[str, bytes]],
    mask: tuple[str, bytes] | None = None,
    size: str | None = None,
    quality: str = image_defaults.FALLBACK_QUALITY,
    n: int = 1,
    input_fidelity: str | None = None,
    route: ResolvedModelRoute | None = None,
    prepared: PreparedImageRoute | None = None,
) -> RenderResult:
    """参考图重绘 / 局部修改（FR-417）：走 `/v1/images/edits`。

    `images` 是 [(文件名, 字节)]，可多张（同系列重绘时把已有的图一并给进去）；
    `mask` 给了就是局部重绘，只改蒙版透明的那块。
    """
    if not images:
        raise ImageGenError("api", "参考图重绘至少要一张原图")
    if n < 1 or n > MAX_N:
        raise ImageGenError("api", f"单次张数须在 1~{MAX_N} 之间，收到 {n}")
    if quality not in image_prompts.QUALITIES:
        raise ImageGenError("api", f"未知质量档：{quality}")
    resolved_size = image_prompts.validate_size(size or "1024x1024")
    selected = prepared or prepare_image_route(capability, "image.edit", route)
    return await selected.edit(
        prompt=prompt,
        capability=capability,
        images=images,
        mask=mask,
        size=size,
        resolved_size=resolved_size,
        quality=quality,
        n=n,
        input_fidelity=input_fidelity,
    )


async def _openai_edit(
    route: PreparedImageRoute,
    *,
    prompt: str,
    capability: str,
    images: list[tuple[str, bytes]],
    mask: tuple[str, bytes] | None,
    size: str | None,
    resolved_size: str,
    quality: str,
    n: int,
    input_fidelity: str | None,
) -> RenderResult:
    resolved = route._route
    if openai_image_protocols.uses_custom_protocol(resolved):
        if mask is not None:
            raise ImageGenError(
                "binding",
                f"{openai_image_protocols.image_request_mode(resolved)} 不支持透明蒙版文件，"
                "请用提示词描述局部修改区域或切换标准 OpenAI edits 协议。",
            )
        try:
            result = await openai_image_protocols.render(
                route=resolved,
                prompt=prompt,
                size=resolved_size,
                quality=quality,
                n=n,
                images=images,
            )
        except openai_image_protocols.ProtocolImageError as exc:
            raise ImageGenError(exc.kind, str(exc)) from exc
        return RenderResult(
            images=result.images,
            model_reported=result.model_reported,
            usage=result.usage,
            latency_ms=result.latency_ms,
        )

    client, model_name = route_client(resolved)
    kwargs: dict = {
        "model": model_name,
        "prompt": prompt,
        "image": [(name, data) for name, data in images],
        "n": n,
        "quality": quality,
    }
    # 「自动」与"没传"在这里行为一致（都不下发 size，由上游跟随参考图），
    # 但仍要显式判一下：不判的话 validate_size("auto") 之后会把字面量 "auto"
    # 塞进请求体，上游只会回一个看不懂的 400
    if size and not image_prompts.is_auto_size(size):
        kwargs["size"] = image_prompts.validate_size(size)
    if mask is not None:
        kwargs["mask"] = mask
    if input_fidelity:
        kwargs["input_fidelity"] = input_fidelity
    started = time.monotonic()
    try:
        resp = await client.images.edit(**kwargs)
    except Exception as exc:
        kind, message = classify(exc)
        raise ImageGenError(kind, message) from exc
    finally:
        await client.close()
    out = [base64.b64decode(i.b64_json) for i in (resp.data or []) if i.b64_json]
    if not out:
        raise ImageGenError("api", "重绘返回了空结果")
    return RenderResult(
        images=out,
        model_reported=getattr(resp, "model", None),
        usage=resp.usage.model_dump() if getattr(resp, "usage", None) else None,
        latency_ms=int((time.monotonic() - started) * 1000),
    )


async def _render_gemini(
    prompt: str,
    *,
    route: ResolvedModelRoute,
    size: str,
    n: int,
    images: list[tuple[str, bytes]],
) -> RenderResult:
    """Gemini adapter 的窄转换层，保持上层只认 RenderResult。"""
    from domain.gemini_image import GeminiImageError, generate

    try:
        result = await generate(
            prompt,
            model=route.upstream_model_id,
            credential_config=route.credential_config,
            protocol_options=route.protocol_options,
            size=size,
            n=n,
            images=images,
        )
    except GeminiImageError as exc:
        raise ImageGenError(exc.kind, str(exc)) from exc
    return RenderResult(
        images=result.images,
        model_reported=result.model_reported,
        usage=result.usage,
        latency_ms=result.latency_ms,
        revised_prompts=result.revised_prompts,
    )


class _OpenAIImageProvider:
    async def generate(self, route: PreparedImageRoute, **kwargs: Any) -> RenderResult:
        return await _openai_generate(route, **kwargs)

    async def edit(self, route: PreparedImageRoute, **kwargs: Any) -> RenderResult:
        return await _openai_edit(route, **kwargs)

    def open_stream_client(self, route: PreparedImageRoute, timeout: float) -> tuple[Any, str]:
        del timeout
        resolved = route._route
        if openai_image_protocols.uses_custom_protocol(resolved):
            raise ImageGenError("api", IMAGE_STREAM_NOT_SUPPORTED)
        return route_client(resolved)


class _GeminiImageProvider:
    async def generate(self, route: PreparedImageRoute, **kwargs: Any) -> RenderResult:
        return await _render_gemini(
            kwargs["prompt"],
            route=route._route,
            size=kwargs["size"],
            n=kwargs["n"],
            images=[],
        )

    async def edit(self, route: PreparedImageRoute, **kwargs: Any) -> RenderResult:
        if kwargs["mask"] is not None:
            raise ImageGenError(
                "binding",
                "Gemini 原生图片协议不接受 OpenAI 透明蒙版；"
                "可改用自然语言说明局部修改区域，或换 OpenAI 编辑适配器。",
            )
        return await _render_gemini(
            kwargs["prompt"],
            route=route._route,
            size=kwargs["resolved_size"],
            n=kwargs["n"],
            images=kwargs["images"],
        )


class _ModelScopeImageProvider:
    async def generate(self, route: PreparedImageRoute, **kwargs: Any) -> RenderResult:
        resolved = route._route
        try:
            result = await modelscope_image.generate(
                kwargs["prompt"],
                route=resolved,
                size=kwargs["size"],
                n=kwargs["n"],
                extra=kwargs["extra"],
            )
        except modelscope_image.ModelScopeImageError as exc:
            raise ImageGenError(exc.kind, str(exc)) from exc
        return RenderResult(
            images=result.images,
            model_reported=resolved.upstream_model_id,
            latency_ms=result.latency_ms,
        )

    async def edit(self, route: PreparedImageRoute, **kwargs: Any) -> RenderResult:
        resolved = route._route
        encoded: list[str] = []
        # image_describe 依赖本模块的错误分型，延迟导入避免循环初始化。
        from domain import image_describe

        for _name, data in kwargs["images"]:
            mime, b64 = image_describe._prepare(data, "image/png")
            encoded.append(f"data:{mime};base64,{b64}")
        try:
            result = await modelscope_image.generate(
                kwargs["prompt"],
                route=resolved,
                size=kwargs["resolved_size"],
                n=kwargs["n"],
                extra={"image_url": encoded},
            )
        except modelscope_image.ModelScopeImageError as exc:
            raise ImageGenError(exc.kind, str(exc)) from exc
        return RenderResult(
            images=result.images,
            model_reported=resolved.upstream_model_id,
            latency_ms=result.latency_ms,
        )


class _CliImageProvider:
    async def generate(self, route: PreparedImageRoute, **kwargs: Any) -> RenderResult:
        resolved = route._route
        try:
            result = await cli_bridge.generate_images(
                resolved.provider_type,
                config=resolved.credential_config,
                prompt=kwargs["prompt"],
                model=resolved.upstream_model_id,
                size=kwargs["size"],
                n=kwargs["n"],
                references=[],
            )
        except cli_bridge.CliBridgeError as exc:
            raise ImageGenError(exc.kind, str(exc)) from exc
        return RenderResult(
            images=result.images,
            model_reported=resolved.upstream_model_id,
            latency_ms=result.latency_ms,
        )

    async def edit(self, route: PreparedImageRoute, **kwargs: Any) -> RenderResult:
        if kwargs["mask"] is not None:
            raise ImageGenError(
                "binding",
                "CLI 图片桥接不接受 OpenAI 透明蒙版，请用提示词说明局部修改区域。",
            )
        resolved = route._route
        try:
            result = await cli_bridge.generate_images(
                resolved.provider_type,
                config=resolved.credential_config,
                prompt=kwargs["prompt"],
                model=resolved.upstream_model_id,
                size=kwargs["resolved_size"],
                n=kwargs["n"],
                references=kwargs["images"],
            )
        except cli_bridge.CliBridgeError as exc:
            raise ImageGenError(exc.kind, str(exc)) from exc
        return RenderResult(
            images=result.images,
            model_reported=resolved.upstream_model_id,
            latency_ms=result.latency_ms,
        )

    async def upscale(self, route: PreparedImageRoute, **kwargs: Any) -> RenderResult:
        resolved = route._route
        if resolved.adapter_type != "jimeng" or resolved.provider_type != "jimeng_cli":
            raise ImageGenError("binding", "图片放大必须使用即梦 CLI 部署")
        try:
            result = await cli_bridge.upscale_jimeng_image(
                config=resolved.credential_config,
                image=kwargs["image"],
                resolution_type=kwargs["resolution_type"],
            )
        except cli_bridge.CliBridgeError as exc:
            raise ImageGenError(exc.kind, str(exc)) from exc
        return RenderResult(
            images=result.images,
            model_reported=resolved.upstream_model_id,
            latency_ms=result.latency_ms,
        )


_OPENAI_IMAGE_PROVIDER = _OpenAIImageProvider()
_CLI_IMAGE_PROVIDER = _CliImageProvider()
_BUILTIN_IMAGE_PROVIDER_HANDLES = (
    register_image_route_provider(
        plugin_id="openai",
        provider=_OPENAI_IMAGE_PROVIDER,
        operations={"image.generate", "image.edit", "image.stream"},
    ),
    register_image_route_provider(
        plugin_id="apimart",
        provider=_OPENAI_IMAGE_PROVIDER,
        operations={"image.generate", "image.edit"},
    ),
    register_image_route_provider(
        plugin_id="tudou",
        provider=_OPENAI_IMAGE_PROVIDER,
        operations={"image.generate", "image.edit"},
    ),
    register_image_route_provider(
        plugin_id="gemini",
        provider=_GeminiImageProvider(),
        operations={"image.generate", "image.edit"},
    ),
    register_image_route_provider(
        plugin_id="modelscope",
        provider=_ModelScopeImageProvider(),
        operations={"image.generate", "image.edit"},
    ),
    register_image_route_provider(
        plugin_id="codex",
        provider=_CLI_IMAGE_PROVIDER,
        operations={"image.generate", "image.edit"},
    ),
    register_image_route_provider(
        plugin_id="gemini-cli",
        provider=_CLI_IMAGE_PROVIDER,
        operations={"image.generate", "image.edit"},
    ),
    register_image_route_provider(
        plugin_id="jimeng",
        provider=_CLI_IMAGE_PROVIDER,
        operations={"image.generate", "image.edit", "image.upscale"},
    ),
)


# ---- ④ 落库 ----


def usage_with_latency(result: RenderResult) -> dict | None:
    """把本次调用耗时并进 usage 一起落库。

    `latency_ms` 原本只在 `/images/jobs` 的响应里存在，资产行上没有——于是资产详情
    永远显示不出「这张图画了多久」。它和 token 用量一样是这次调用的事实，该跟着图走。
    """
    if result.usage is None and result.latency_ms <= 0:
        return None
    return {**(result.usage or {}), "latency_ms": result.latency_ms}


async def ingest(
    session: AsyncSession,
    result: RenderResult,
    *,
    target: ImageTarget,
    prompt: str,
    structure: dict | None,
    brief: dict | None,
    style_key: str | None,
    # 装的是能力名（image-cover 这种）。参数名还叫 alias 是网关时代留下的，
    # 路由器 / worker / 画布都按关键字传，改名要连调用方一起动，见 blockers
    alias: str,
    size: str,
    quality: str,
    subject_domain: str | None = None,
    subject_id: int | None = None,
    run_id: int | None = None,
    step: str | None = None,
    source: str = "pipeline",
) -> list:
    """把一次调用产出的**全部**候选图入库。

    不筛选：已经付过费了，丢掉未选中的等于白花钱（BR-106）。
    单张体检不过只跳过那一张，其余照常入库。
    """
    rows = []
    for index, data in enumerate(result.images):
        try:
            row = await image_assets.ingest_one(
                session,
                data,
                target_key=target.key,
                prompt=prompt,
                prompt_structure=structure,
                brief=brief,
                style_key=style_key,
                alias=alias,
                model_reported=result.model_reported,
                size_req=size,
                quality=quality,
                n_index=index,
                usage=usage_with_latency(result),
                subject_domain=subject_domain,
                subject_id=subject_id,
                run_id=run_id,
                step=step,
                source=source,
            )
        except image_assets.ImageAssetError as exc:
            logger.warning("第 %d 张体检未过，已跳过：%s", index + 1, exc)
            continue
        rows.append(row)
    if not rows:
        raise ImageGenError("api", "生成的图全部没通过体检，请重试或换个提示词")
    return rows


# ---- 串起来 ----


async def generate_for(
    session: AsyncSession,
    *,
    target_key: str,
    subject: dict | None = None,
    idea: str = "",
    # 装的是能力名（image-cover 这种）。参数名还叫 alias 是网关时代留下的，
    # 路由器 / worker / 画布都按关键字传，改名要连调用方一起动，见 blockers
    alias: str = "image-cover",
    prompt_override: str = "",
    style_key: str | None = None,
    size: str | None = None,
    quality: str | None = None,
    n: int = 1,
    subject_domain: str | None = None,
    subject_id: int | None = None,
    run_id: int | None = None,
    step: str | None = None,
    source: str = "pipeline",
) -> dict:
    """一句话拿图：四步全跑。返回 {assets, prompt, structure, brief, latency_ms}。

    `prompt_override` 非空则跳过立意与写词两步直接用它——用户在节点里手写了
    提示词，说明他不想要 AI 那一版，再叫一次模型改写等于没听他的。
    """
    target = image_prompts.get_target(target_key)
    resolved_size = size or target.size
    resolved_quality = quality or target.quality

    brief: dict | None = None
    structure: dict | None = None
    if prompt_override.strip():
        # 手写提示词也要补画布：上游按提示词里的比例出图，不看 size 参数
        prompt = image_prompts.ensure_canvas(prompt_override.strip(), resolved_size)
    else:
        from domain import image_styles  # 延迟导入：它反过来要 image_prompts，顶层导会成环

        await image_styles.ensure_loaded(session)
        brief = await plan_brief(target, subject or {}, idea)
        prompt, structure = image_prompts.render_prompt(
            target, brief, style_key=style_key, size=resolved_size
        )

    result = await render_images(
        prompt,
        alias=alias,
        size=resolved_size,
        quality=resolved_quality,
        n=n,
        route=await resolve_model_route(session, alias),
    )
    rows = await ingest(
        session,
        result,
        target=target,
        prompt=prompt,
        structure=structure,
        brief=brief,
        style_key=style_key or target.default_style,
        alias=alias,
        size=resolved_size,
        quality=resolved_quality,
        subject_domain=subject_domain,
        subject_id=subject_id,
        run_id=run_id,
        step=step,
        source=source,
    )
    return {
        "assets": rows,
        "prompt": prompt,
        "structure": structure,
        "brief": brief,
        "latency_ms": result.latency_ms,
        "model": result.model_reported,
        "usage": result.usage,
    }


def prompt_error_message(exc: PromptError) -> str:
    return str(exc)
