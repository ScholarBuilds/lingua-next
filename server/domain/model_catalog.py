"""创作模型目录：真实上游模型名与调用 adapter 的持久化层（模块 17 v2）。"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from domain.kernel.llm_retry import RetryPolicyError, resolve_retry_policy
from domain.model_plugins import get_model_plugin, has_model_plugin
from domain.models import CapabilityBinding, ModelDeployment, ProviderCredential

# 会跟随全局默认模型的能力：只有 chat 类。生图与音色各有各的默认，混进来会让一条 image
# 部署被语法分析静默捡走（_candidate_deployment 不校验 media_types）
DEFAULT_LLM_CAPABILITY = "default-llm"

logger = logging.getLogger(__name__)

MEDIA_TYPES = frozenset({"chat", "image", "video", "audio", "workflow"})
_SECRET_MARKERS = ("api_key", "access_key", "secret", "token", "password")
_IMAGE_MODEL_MARKERS = (
    "gpt-image",
    "dall-e",
    "imagen",
    "imagegen",
    "qwen-image",
    "z-image",
    "flux",
    "recraft",
    "stable-diffusion",
    "sdxl",
    "kolors",
    "banana",
)
_VIDEO_MODEL_MARKERS = (
    "sora",
    "veo",
    "video",
    "seedance",
    "wan2",
    "hailuo",
    "kling",
    "runway",
    "luma",
)


def _default_followers() -> frozenset[str]:
    """延迟取值：credentials 在导入期会拉起一串外部模块，模块级导入会成环。"""
    from domain.credentials import LLM_CAPABILITIES

    return frozenset(LLM_CAPABILITIES)


class ModelCatalogError(ValueError):
    pass


@dataclass(frozen=True)
class ResolvedModelRoute:
    deployment_id: int
    adapter_type: str
    upstream_model_id: str
    provider_type: str
    credential_config: dict[str, Any]
    protocol_options: dict[str, Any]
    # 能力绑定上的调用参数（temperature / reasoning_effort …）；与部署的协议参数分开存，
    # 由各运行时按 Provider 白名单决定哪些能进请求
    params: dict[str, Any] = field(default_factory=dict)
    # 这条路由是怎么选出来的：explicit（显式部署）/ binding（绑定主部署）/ fallback /
    # default（这条能力跟随全局默认模型）
    source: str = "binding"
    # 同一次解析里排在后面的候选，主路由失败后按序切换；各自的 fallbacks 为空
    fallbacks: tuple[ResolvedModelRoute, ...] = ()

    def view(self) -> dict[str, Any]:
        """脱敏视图：进快照和台账，不带凭据。"""
        return {
            "deployment_id": self.deployment_id,
            "adapter_type": self.adapter_type,
            "upstream_model_id": self.upstream_model_id,
            "provider_type": self.provider_type,
            "source": self.source,
        }


async def _get_binding(session: AsyncSession, capability: str) -> CapabilityBinding | None:
    return (
        await session.execute(
            select(CapabilityBinding).where(CapabilityBinding.capability == capability)
        )
    ).scalar_one_or_none()


async def bound_deployment_id(session: AsyncSession, capability: str) -> int | None:
    binding = await _get_binding(session, capability)
    return binding.deployment_id if binding is not None else None


def _candidate_specs(
    binding: CapabilityBinding | None,
    deployment_id: int | None,
    default_binding: CapabilityBinding | None = None,
) -> list[tuple[str, int | None, dict[str, Any] | None]]:
    """候选顺序：显式部署 → 绑定主部署 → fallback 各项 → 全局默认。

    元素是 (来源, 部署 id, fallback 项)。

    全局默认只在**这条能力自己没有主部署**时参与——那才是「跟随默认」的语义。
    绑了模型但那条部署停用了仍旧照原样抛错：把配置事故静默换成另一个模型出结果，
    用户下次看到的是「怎么变笨了」而不是「我配的那条挂了」。
    """
    specs: list[tuple[str, int | None, dict[str, Any] | None]] = []
    if deployment_id is not None:
        specs.append(("explicit", deployment_id, None))
    if binding is not None:
        if binding.deployment_id is not None and binding.deployment_id != deployment_id:
            specs.append(("binding", binding.deployment_id, None))
        for item in binding.fallback or []:
            if not isinstance(item, dict):
                continue
            raw_id = item.get("deployment_id")
            fallback_id = (
                raw_id if isinstance(raw_id, int) and not isinstance(raw_id, bool) else None
            )
            specs.append(("fallback", fallback_id, item))
    follows_default = binding is None or binding.deployment_id is None
    if follows_default and default_binding is not None:
        default_id = default_binding.deployment_id
        if default_id is not None and default_id != deployment_id:
            specs.append(("default", default_id, None))
    return specs


async def _fallback_deployment(
    session: AsyncSession, item: dict[str, Any]
) -> tuple[ModelDeployment | None, str | None]:
    """fallback 项 {credential_id, target} → 该凭据下同名的启用部署。

    同名部署可能有好几条，adapter 已经没有插件的排最后：那种行调用必失败，
    不能因为 id 小就先被挑中。
    """
    credential_id = item.get("credential_id")
    target = str(item.get("target") or "").strip()
    if not isinstance(credential_id, int) or isinstance(credential_id, bool) or not target:
        return None, f"fallback 项缺少 credential_id / target：{item}"
    rows = list(
        (
            await session.execute(
                select(ModelDeployment).where(
                    ModelDeployment.credential_id == credential_id,
                    ModelDeployment.upstream_model_id == target,
                    ModelDeployment.enabled.is_(True),
                )
            )
        ).scalars()
    )
    if not rows:
        return None, f"fallback 没有可用部署：credential_id={credential_id} target={target}"
    rows.sort(key=lambda row: (not has_model_plugin(row.adapter_type), row.sort, row.id))
    return rows[0], None


async def _candidate_deployment(
    session: AsyncSession,
    deployment_id: int | None,
    item: dict[str, Any] | None,
) -> tuple[ModelDeployment | None, str | None]:
    if deployment_id is None:
        if item is None:
            return None, "候选没有指定部署"
        return await _fallback_deployment(session, item)
    deployment = await session.get(ModelDeployment, deployment_id)
    if deployment is None:
        return None, f"模型部署不存在：{deployment_id}"
    if not deployment.enabled:
        return None, f"模型部署已停用：{deployment.upstream_model_id}"
    return deployment, None


async def resolve_model_candidates(
    session: AsyncSession,
    capability: str,
    *,
    deployment_id: int | None = None,
) -> list[ResolvedModelRoute]:
    """按 显式部署 → 绑定主部署 → fallback 链 的顺序解析全部可用候选。

    停用的部署 / 凭据跳过而不是抛错；一个候选都不可用才抛 ModelCatalogError。
    没有任何 v2 候选（纯旧式别名绑定）返回空列表，调用方继续走网关别名。
    返回列表里 ``[0]`` 是主路由，其 ``fallbacks`` 就是余下各项。
    """
    from domain.credentials import decrypt_config

    binding = await _get_binding(session, capability)
    # 全局默认只对 chat 类能力生效：生图、音色、翻译链各有各的默认，混在一起会让一条
    # image 部署被语法分析静默捡走（model_catalog 不校验 media_types，坑在 _candidate_deployment）
    default_binding = (
        await _get_binding(session, DEFAULT_LLM_CAPABILITY)
        if capability in _default_followers()
        else None
    )
    specs = _candidate_specs(binding, deployment_id, default_binding)
    if not specs:
        return []
    # 跟随默认的能力自己没有 params，采样参数就该跟着默认那条走
    params_source = (
        binding
        if binding is not None and (binding.deployment_id is not None or binding.params)
        else default_binding
    )
    params = (
        {}
        if params_source is None
        else {
            str(key): value
            for key, value in (params_source.params or {}).items()
            if value is not None
        }
    )
    routes: list[ResolvedModelRoute] = []
    seen: set[int] = set()
    reasons: list[str] = []
    for source, candidate_id, item in specs:
        deployment, reason = await _candidate_deployment(session, candidate_id, item)
        if deployment is None:
            reasons.append(reason or "候选不可用")
            continue
        if deployment.id in seen:
            continue
        credential = await session.get(ProviderCredential, deployment.credential_id)
        if credential is None or not credential.enabled:
            reasons.append(f"模型凭据不可用：{deployment.credential_id}")
            continue
        seen.add(deployment.id)
        routes.append(
            ResolvedModelRoute(
                deployment_id=deployment.id,
                adapter_type=deployment.adapter_type,
                upstream_model_id=deployment.upstream_model_id,
                provider_type=credential.provider_type,
                credential_config=decrypt_config(credential.config),
                protocol_options=dict(deployment.protocol_options or {}),
                params=dict(params),
                source=source,
            )
        )
    if not routes:
        if len(reasons) == 1:
            raise ModelCatalogError(reasons[0])
        raise ModelCatalogError("所有候选部署都不可用：" + "；".join(reasons))
    if reasons:
        logger.info("能力 %s 跳过不可用候选：%s", capability, "；".join(reasons))
    primary, *rest = routes
    return [
        ResolvedModelRoute(**{**primary.__dict__, "fallbacks": tuple(rest)}),
        *rest,
    ]


async def resolve_model_route(
    session: AsyncSession,
    capability: str,
    *,
    deployment_id: int | None = None,
) -> ResolvedModelRoute | None:
    """解析一次调用的主路由（``fallbacks`` 挂余下候选）；没有 v2 部署时返回 None 走旧网关别名。"""
    candidates = await resolve_model_candidates(
        session,
        capability,
        deployment_id=deployment_id,
    )
    return candidates[0] if candidates else None


async def resolve_operation_deployment_id(
    session: AsyncSession,
    capability: str,
    *,
    deployment_id: int | None,
    media_type: str,
    operation: str,
) -> int | None:
    """校验显式 deployment 与真实执行插件；未显式选择时保持旧绑定兼容。"""
    if deployment_id is None:
        return await bound_deployment_id(session, capability)
    # 用户显式点名的部署不可用时不能悄悄换成绑定默认：这里是在校验他的选择
    deployment = await session.get(ModelDeployment, deployment_id)
    if deployment is None:
        raise ModelCatalogError(f"模型部署不存在：{deployment_id}")
    if not deployment.enabled:
        raise ModelCatalogError(f"模型部署已停用：{deployment.upstream_model_id}")
    credential = await session.get(ProviderCredential, deployment.credential_id)
    if credential is None or not credential.enabled:
        raise ModelCatalogError(f"模型凭据不可用：{deployment.credential_id}")
    route = await resolve_model_route(
        session,
        capability,
        deployment_id=deployment_id,
    )
    if route is None or route.deployment_id != deployment_id:
        raise ModelCatalogError(f"模型部署不可用：{deployment_id}")
    if media_type not in (deployment.media_types or []):
        label = {"image": "图片", "video": "视频", "audio": "音频"}.get(
            media_type,
            media_type,
        )
        raise ModelCatalogError(f"所选模型没有标记{label}能力")
    plugin = get_model_plugin(route.adapter_type)
    if not plugin.is_ready(operation):
        raise ModelCatalogError(f"{media_type} 执行器暂不支持 adapter：{route.adapter_type}")
    return route.deployment_id


def normalize_media_types(values: list[str] | None) -> list[str]:
    out: list[str] = []
    for raw in values or []:
        value = str(raw).strip().lower()
        if value not in MEDIA_TYPES:
            raise ModelCatalogError(f"未知媒体类型：{raw}")
        if value not in out:
            out.append(value)
    return out


def infer_media_types(model_id: str, adapter_type: str) -> list[str]:
    """上游只回模型名时的保守分类。

    只把明确的生图/视频家族归入对应媒体；其余优先当对话模型。
    最终结果还要与 adapter 声明的媒体能力取交集，不会把一个只能生图
    的执行器标成可对话。
    """
    lowered = model_id.strip().lower()
    plugin = get_model_plugin(adapter_type)
    supported = plugin.media_types
    if "image" in supported and any(marker in lowered for marker in _IMAGE_MODEL_MARKERS):
        return ["image"]
    if "video" in supported and any(marker in lowered for marker in _VIDEO_MODEL_MARKERS):
        return ["video"]
    if "chat" in supported:
        return ["chat"]
    if len(supported) == 1:
        return [next(iter(supported))]
    return []


def validate_protocol_options(options: dict[str, Any] | None) -> dict[str, Any] | None:
    if not options:
        return None

    def scan(value: object, path: str = "protocol_options") -> None:
        if isinstance(value, dict):
            for raw_key, nested in value.items():
                key = str(raw_key)
                lowered = key.lower()
                if any(marker in lowered for marker in _SECRET_MARKERS):
                    raise ModelCatalogError(
                        f"协议参数不能保存密钥字段：{path}.{key}，请放到供应商凭据"
                    )
                scan(nested, f"{path}.{key}")
        elif isinstance(value, list):
            for index, nested in enumerate(value):
                scan(nested, f"{path}[{index}]")

    scan(options)
    normalized = dict(options)
    if normalized.get("retry_policy") is not None:
        policy = normalized["retry_policy"]
        if not isinstance(policy, dict):
            raise ModelCatalogError("retry_policy 必须是对象")
        try:
            resolve_retry_policy(policy)
        except RetryPolicyError as exc:
            raise ModelCatalogError(str(exc)) from exc
    request_mode = str(normalized.get("image_request_mode") or "").strip().lower()
    if request_mode:
        from domain.openai_image_protocols import IMAGE_REQUEST_MODES

        if request_mode not in IMAGE_REQUEST_MODES:
            raise ModelCatalogError(f"未知图片请求模式：{request_mode}")
        normalized["image_request_mode"] = request_mode
    for key in (
        "generation_path",
        "edit_path",
        "responses_path",
        "video_proxy_path",
        "task_path_template",
    ):
        if key not in normalized:
            continue
        path_value = str(normalized[key] or "").strip()
        if not path_value or len(path_value) > 512:
            raise ModelCatalogError(f"协议路径 {key} 不能为空且最多 512 字符")
        if key == "task_path_template" and "{task_id}" not in path_value:
            raise ModelCatalogError("task_path_template 必须包含 {task_id}")
        normalized[key] = path_value
    for key, low, high in (
        ("poll_interval", 0.05, 30.0),
        ("initial_poll_delay", 0.0, 60.0),
        ("task_timeout", 1.0, 1800.0),
    ):
        if key not in normalized:
            continue
        try:
            number = float(normalized[key])
        except (TypeError, ValueError) as exc:
            raise ModelCatalogError(f"协议参数 {key} 必须是数字") from exc
        if not low <= number <= high:
            raise ModelCatalogError(f"协议参数 {key} 必须在 {low:g}-{high:g} 之间")
        normalized[key] = number
    return normalized


def deployment_view(
    row: ModelDeployment,
    credential: ProviderCredential | None = None,
) -> dict:
    return {
        "id": row.id,
        "credential_id": row.credential_id,
        "credential_name": credential.name if credential else None,
        "provider_type": credential.provider_type if credential else None,
        "upstream_model_id": row.upstream_model_id,
        "display_name": row.display_name,
        "adapter_type": row.adapter_type,
        "media_types": row.media_types or [],
        "protocol_options": row.protocol_options,
        "discovered": row.discovered,
        "enabled": row.enabled,
        "sort": row.sort,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


def _cache_item(raw: Any) -> tuple[str, str | None, list[str]] | None:
    if isinstance(raw, str):
        model_id = raw.strip()
        return (model_id, None, []) if model_id else None
    if not isinstance(raw, dict):
        return None
    model_id = str(raw.get("id") or raw.get("model") or raw.get("name") or "").strip()
    if not model_id:
        return None
    display = str(raw.get("display_name") or raw.get("label") or "").strip() or None
    kinds = raw.get("media_types") or raw.get("types") or raw.get("type") or raw.get("kind")
    if isinstance(kinds, str):
        kinds = [kinds]
    normalized = [str(v).lower() for v in kinds or [] if str(v).lower() in MEDIA_TYPES]
    return model_id, display, list(dict.fromkeys(normalized))


async def sync_cached_models(
    session: AsyncSession,
    credential: ProviderCredential,
    *,
    adapter_type: str = "openai",
) -> dict:
    if not has_model_plugin(adapter_type):
        raise ModelCatalogError(f"未知 adapter：{adapter_type}")
    cached = (credential.models_cache or {}).get("items") or []
    existing = list(
        (
            await session.execute(
                select(ModelDeployment).where(
                    ModelDeployment.credential_id == credential.id,
                )
            )
        ).scalars()
    )
    by_target = {(row.upstream_model_id, row.adapter_type): row for row in existing}
    created = 0
    updated = 0
    skipped = 0
    for raw in cached:
        parsed = _cache_item(raw)
        if parsed is None:
            skipped += 1
            continue
        model_id, display, media_types = parsed
        inferred = media_types or infer_media_types(model_id, adapter_type)
        item_adapter = adapter_type
        # ModelScope 一把 Token 同时返回对话和 AIGC 模型：只有明确的生图
        # 家族走原生异步 adapter，其余按 OpenAI 兼容直连（魔搭的推理端点就是
        # OpenAI 协议，走网关只是多一跳，网关退役后更是无处可去）。
        if credential.provider_type == "modelscope" and adapter_type == "modelscope":
            image_media = infer_media_types(model_id, "modelscope")
            if not any(marker in model_id.lower() for marker in _IMAGE_MODEL_MARKERS):
                item_adapter = "openai"
                inferred = infer_media_types(model_id, item_adapter)
            else:
                inferred = image_media
        row = by_target.get((model_id, item_adapter))
        if row is None:
            row = ModelDeployment(
                credential_id=credential.id,
                upstream_model_id=model_id,
                display_name=display,
                adapter_type=item_adapter,
                media_types=inferred,
                discovered=True,
            )
            session.add(row)
            by_target[(model_id, item_adapter)] = row
            created += 1
        else:
            changed = False
            if display and row.display_name != display:
                row.display_name = display
                changed = True
            if inferred and row.media_types != inferred:
                row.media_types = inferred
                changed = True
            if not row.discovered:
                row.discovered = True
                changed = True
            updated += int(changed)
    await session.flush()
    return {"created": created, "updated": updated, "skipped": skipped, "total": len(by_target)}
