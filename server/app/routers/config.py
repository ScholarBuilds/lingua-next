"""配置中心 API：供应商凭据 CRUD、模型/音色刷新、连通测试、能力绑定、偏好与审计（模块 11）。

密钥安全（FR-04）：任何响应只回掩码；编辑时 config 留空/缺字段 = 不修改。
能力绑定直接指向一条 model_deployment，保存即生效，不存在任何外部网关的同步步骤。
"""

import asyncio
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal, NoReturn

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.config import get_settings
from app.routers.dict import SessionDep
from app.routers.pronunciation import settings_router as pronunciation_settings_router
from app.routers.service_probes import router as service_probe_router
from domain import (
    cli_bridge,
    image_defaults,
    network_policy,
    provider_onboarding,
    tts_cache,
    volcengine_assets,
    youtube_login,
)
from domain.audio_runtime import audio_route_provider_views
from domain.credentials import (
    ALL_CAPABILITIES,
    DEFAULT_LLM_CAPABILITY,
    IMAGE_CAPABILITIES,
    LLM_CAPABILITIES,
    LLM_COMPAT_TYPES,
    PROVIDER_TYPES,
    REALTIME_COMPAT_TYPES,
    VIDEO_COMPAT_TYPES,
    CredentialError,
    decrypt_config,
    encrypt_config,
    masked_config,
    normalize_chain,
    probe_config,
    provider_spec,
    refresh_models,
    run_test,
)
from domain.imagegen import image_route_provider_views
from domain.model_catalog import (
    ModelCatalogError,
    deployment_view,
    normalize_media_types,
    sync_cached_models,
    validate_protocol_options,
)
from domain.model_invocations import (
    invocation_event_view,
    invocation_view,
    list_invocation_events,
    list_invocations,
)
from domain.model_plugins import (
    adapter_for_provider,
    get_model_plugin,
    has_model_plugin,
    list_model_plugins,
)
from domain.model_runtime import chat_route_provider_views
from domain.models import (
    AnalysisResult,
    CapabilityBinding,
    ConfigAudit,
    ModelDeployment,
    ModelInvocation,
    ModelScopeLora,
    ProviderCredential,
    UserPref,
)
from domain.video_generation import video_route_provider_views
from domain.workflow_execution import workflow_route_provider_views

router = APIRouter(prefix="/config", tags=["config"])
router.include_router(service_probe_router)
router.include_router(pronunciation_settings_router)


def _audit(session, action: str, summary: str) -> None:
    session.add(ConfigAudit(action=action, summary=summary))


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


# ---- 供应商类型 ----


@router.get("/provider-types")
async def list_provider_types() -> list[dict]:
    """可录入的供应商类型 + 授权引导（需求 17 §4.4）。

    `onboarding` 为 null 表示这个类型还没写引导——UI 据此决定不渲染引导卡，
    而不是拿一个空壳去画一张什么都没有的卡片。

    `probeable` 为 true 表示表单打开时该去调 `/config/credentials/probe`，
    前端不用自己维护一份「哪些是本机 CLI」的名单。
    """
    return [
        {
            "kind": spec["kind"],
            "compatible_kinds": spec.get("compatible_kinds", []),
            "provider_type": ptype,
            "label": spec["label"],
            "fields": spec["fields"],
            "notes": spec.get("notes", ""),
            "recommendation": spec.get("recommendation"),
            "onboarding": provider_onboarding.onboarding_for(ptype),
            "probeable": ptype in cli_bridge.PROBE_PROVIDER_TYPES,
        }
        for ptype, spec in PROVIDER_TYPES.items()
    ]


@router.get("/credentials/probe")
async def probe_cli_credential(provider_type: str) -> dict:
    """本机 CLI 供应商自动探测：可执行文件在哪、登录了没有、缺的东西怎么补。

    表单打开就调一次，探到什么就直接显示什么，探不到才把手填输入框露出来——
    `cli_bridge.resolve_executable` 本来就在调用时 which，让用户填路径是白问的。

    **响应只含路径与布尔**：auth 文件的内容、token、key 一律不出服务端。

    路由必须排在 ``/credentials/{credential_id}`` 前面，否则 "probe" 会先被
    当成 int 路径参数解析，直接 422。
    """
    try:
        return cli_bridge.probe_provider(provider_type).view()
    except cli_bridge.CliBridgeError as exc:
        _raise_cli_error(exc)


@router.get("/model-plugins")
async def get_model_plugins() -> list[dict]:
    """模型协议插件清单；配置页与调用点均以此判断能力，不维护前端副本。"""
    chat_providers = chat_route_provider_views()
    image_providers = image_route_provider_views()
    video_providers = video_route_provider_views()
    audio_providers = audio_route_provider_views()
    workflow_providers = workflow_route_provider_views()
    return [
        {
            **item,
            **chat_providers.get(
                item["id"],
                {"chat_provider_operations": [], "chat_runtime_generation": None},
            ),
            **image_providers.get(
                item["id"],
                {"image_provider_operations": [], "image_runtime_generation": None},
            ),
            **video_providers.get(
                item["id"],
                {"video_provider_operations": [], "video_runtime_generation": None},
            ),
            **audio_providers.get(
                item["id"],
                {"audio_provider_operations": [], "audio_runtime_generation": None},
            ),
            **workflow_providers.get(
                item["id"],
                {
                    "workflow_provider_operations": [],
                    "workflow_runtime_generation": None,
                },
            ),
        }
        for item in list_model_plugins()
    ]


@router.get("/model-invocations")
async def get_model_invocations(
    session: SessionDep,
    status: str | None = None,
    plugin_id: str | None = None,
    task_id: str | None = None,
    capability: str | None = None,
    canvas_id: int | None = None,
    node_id: str | None = None,
    flow_run_id: str | None = None,
    tool_id: str | None = None,
    source: str | None = None,
    error_code: str | None = None,
    since: str | None = None,
    cursor: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> dict:
    """台账列表，created_at 倒序；``cursor`` 传上一页的 ``next_cursor`` 往旧翻。"""
    since_at: datetime | None = None
    if since:
        try:
            since_at = datetime.fromisoformat(since)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="since 必须是 ISO 8601 时间") from exc
    try:
        page = await list_invocations(
            session,
            status=status,
            plugin_id=plugin_id,
            task_id=task_id,
            capability=capability,
            canvas_id=canvas_id,
            node_id=node_id,
            flow_run_id=flow_run_id,
            tool_id=tool_id,
            source=source,
            error_code=error_code,
            since=since_at,
            cursor=cursor,
            limit=limit,
            offset=offset,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "items": [invocation_view(row) for row in page.items],
        "next_cursor": page.next_cursor,
    }


@router.get("/model-invocations/{invocation_id}/events")
async def get_model_invocation_events(
    invocation_id: str,
    session: SessionDep,
    after: int = 0,
    limit: int = 2000,
) -> dict:
    """一次调用的逐步事件（按 seq 升序），连同台账行当前快照。"""
    row = await session.get(ModelInvocation, invocation_id)
    if row is None:
        raise HTTPException(status_code=404, detail="模型调用不存在")
    events = await list_invocation_events(session, invocation_id, after_seq=after, limit=limit)
    return {
        "invocation": invocation_view(row),
        "items": [invocation_event_view(event) for event in events],
    }


# ---- 凭据 CRUD ----


def _credential_view(cred: ProviderCredential) -> dict:
    cache = cred.models_cache or {}
    items = cache.get("items") or []
    return {
        "id": cred.id,
        "name": cred.name,
        "kind": cred.kind,
        "provider_type": cred.provider_type,
        "enabled": cred.enabled,
        "status": cred.status,
        "status_detail": cred.status_detail,
        "last_tested_at": _iso(cred.last_tested_at),
        "masked": masked_config(cred.config),
        "models": items,
        "models_count": len(items),
        "models_refreshed_at": cache.get("refreshed_at"),
    }


@router.get("/credentials")
async def list_credentials(session: SessionDep, kind: str | None = None) -> list[dict]:
    stmt = select(ProviderCredential).order_by(ProviderCredential.id)
    rows = list((await session.execute(stmt)).scalars())
    if kind == "llm":
        rows = [c for c in rows if c.kind == "llm" or c.provider_type in LLM_COMPAT_TYPES]
    elif kind == "realtime":  # 实时语音复用 volc_speech 凭据（tts+realtime 共用）
        rows = [c for c in rows if c.kind == "realtime" or c.provider_type in REALTIME_COMPAT_TYPES]
    elif kind == "video":
        rows = [c for c in rows if c.kind == "video" or c.provider_type in VIDEO_COMPAT_TYPES]
    elif kind:
        rows = [c for c in rows if c.kind == kind]
    return [_credential_view(c) for c in rows]


class CredentialCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    kind: str = Field(min_length=1, max_length=16)
    provider_type: str = Field(min_length=1, max_length=32)
    config: dict[str, Any] = Field(default_factory=dict)


def _validate_config(spec: dict, config: dict, *, partial: bool) -> None:
    for field in spec["fields"]:
        if not field["required"]:
            continue
        value = config.get(field["name"])
        if partial and (value is None or value == ""):
            continue  # PATCH 留空 = 不修改
        if not partial and not (isinstance(value, str) and value.strip()):
            raise HTTPException(status_code=400, detail=f"缺少必填字段：{field['name']}")


@router.post("/credentials", status_code=201)
async def create_credential(body: CredentialCreate, session: SessionDep) -> dict:
    try:
        spec = provider_spec(body.provider_type)
    except CredentialError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if body.kind != spec["kind"]:
        raise HTTPException(
            status_code=400,
            detail=f"kind 与类型不符：{body.provider_type} 应为 {spec['kind']}",
        )
    _validate_config(spec, body.config, partial=False)
    try:
        stored = encrypt_config(body.config)
    except CredentialError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    cred = ProviderCredential(
        name=body.name,
        kind=body.kind,
        provider_type=body.provider_type,
        config=stored,
    )
    session.add(cred)
    _audit(
        session,
        "credential.create",
        f"新增凭据「{body.name}」（{body.kind}/{body.provider_type}）",
    )
    await session.commit()
    await session.refresh(cred)
    return _credential_view(cred)


class CredentialPatch(BaseModel):
    name: str | None = None
    enabled: bool | None = None
    config: dict[str, Any] | None = None


class CredentialProbe(BaseModel):
    provider_type: str = Field(min_length=1, max_length=32)
    credential_id: int | None = Field(default=None, gt=0)
    config: dict[str, Any] = Field(default_factory=dict)


@router.post("/credential-probe")
async def probe_credential(body: CredentialProbe, session: SessionDep) -> dict:
    """用表单草稿做连通测试；敏感值只存在于本次请求内存中。

    编辑既有凭据时允许密码留空：服务端临时合并已保存配置再探测，但不会
    回写配置、状态、模型缓存或审计记录。
    """
    try:
        spec = provider_spec(body.provider_type)
    except CredentialError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    config: dict[str, Any] = {}
    if body.credential_id is not None:
        credential = await session.get(ProviderCredential, body.credential_id)
        if credential is None:
            raise HTTPException(status_code=404, detail="凭据不存在")
        if credential.provider_type != body.provider_type:
            raise HTTPException(status_code=400, detail="凭据与供应商类型不匹配")
        try:
            config = decrypt_config(credential.config)
        except CredentialError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

    for key, value in body.config.items():
        if value is None or value == "":
            continue
        config[key] = value
    _validate_config(spec, config, partial=False)
    try:
        return await probe_config(body.provider_type, config)
    except CredentialError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.patch("/credentials/{credential_id}")
async def patch_credential(credential_id: int, body: CredentialPatch, session: SessionDep) -> dict:
    cred = await session.get(ProviderCredential, credential_id)
    if cred is None:
        raise HTTPException(status_code=404, detail="凭据不存在")
    changes: list[str] = []
    if body.name is not None and body.name != cred.name:
        changes.append(f"更名为「{body.name}」")
        cred.name = body.name
    if body.enabled is not None and body.enabled != cred.enabled:
        changes.append("启用" if body.enabled else "停用")
        cred.enabled = body.enabled
    if body.config:
        spec = provider_spec(cred.provider_type)
        _validate_config(spec, body.config, partial=True)
        merged = dict(cred.config)
        for key, value in body.config.items():
            if value is None or value == "":
                continue  # 留空/缺字段 = 不修改（FR-04）
            merged[key] = value
            changes.append(f"更新 {key}")
        try:
            cred.config = encrypt_config(merged)
        except CredentialError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        cred.status = "untested"  # 配置变了，旧测试结论作废
        cred.status_detail = None
    if changes:
        _audit(session, "credential.update", f"凭据「{cred.name}」：{'、'.join(changes)}")
    await session.commit()
    await session.refresh(cred)
    return _credential_view(cred)


async def _referencing_bindings(session, credential_id: int) -> list[CapabilityBinding]:
    rows = list((await session.execute(select(CapabilityBinding))).scalars())
    hit = []
    for b in rows:
        in_fallback = any(
            isinstance(f, dict) and f.get("credential_id") == credential_id
            for f in b.fallback or []
        )
        if b.credential_id == credential_id or in_fallback:
            hit.append(b)
    return hit


@router.delete("/credentials/{credential_id}")
async def delete_credential(credential_id: int, session: SessionDep, force: bool = False) -> dict:
    cred = await session.get(ProviderCredential, credential_id)
    if cred is None:
        raise HTTPException(status_code=404, detail="凭据不存在")
    referenced = await _referencing_bindings(session, credential_id)
    if referenced and not force:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "凭据被绑定引用，删除前请改绑或携带 ?force=true",
                "bindings": [b.capability for b in referenced],
            },
        )
    for b in referenced:  # force：置空主绑定并清理 fallback 引用
        if b.credential_id == credential_id:
            b.credential_id = None
        b.fallback = [
            f
            for f in b.fallback or []
            if not (isinstance(f, dict) and f.get("credential_id") == credential_id)
        ] or None
    name = cred.name
    await session.delete(cred)
    _audit(
        session,
        "credential.delete",
        f"删除凭据「{name}」"
        + (f"，置空绑定：{'、'.join(b.capability for b in referenced)}" if referenced else ""),
    )
    await session.commit()
    return {"deleted": credential_id, "cleared_bindings": [b.capability for b in referenced]}


@router.post("/credentials/{credential_id}/refresh-models")
async def refresh_credential_models(credential_id: int, session: SessionDep) -> dict:
    cred = await session.get(ProviderCredential, credential_id)
    if cred is None:
        raise HTTPException(status_code=404, detail="凭据不存在")
    try:
        result = await refresh_models(cred)
    except CredentialError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    deployments = None
    spec = provider_spec(cred.provider_type)
    default_adapter = adapter_for_provider(
        cred.provider_type,
        fallback=str(spec.get("default_adapter") or "openai"),
    )
    if cred.kind in {"llm", "image", "video"}:
        deployments = await sync_cached_models(session, cred, adapter_type=default_adapter)
    _audit(
        session,
        "credential.refresh_models",
        f"凭据「{cred.name}」刷新列表：{result['count']} 项"
        + (
            f"；同步真实模型目录：新增 {deployments['created']}，更新 {deployments['updated']}"
            if deployments is not None
            else ""
        ),
    )
    await session.commit()
    return {**result, "deployments": deployments}


# ---- 真实模型目录（模块 17 v2） ----


def _deployment_with_credential(row: ModelDeployment, creds: dict[int, ProviderCredential]) -> dict:
    return deployment_view(row, creds.get(row.credential_id))


@router.get("/model-deployments")
async def list_model_deployments(
    session: SessionDep,
    credential_id: int | None = None,
    media_type: str | None = None,
    enabled: bool | None = None,
) -> list[dict]:
    stmt = select(ModelDeployment).order_by(
        ModelDeployment.sort, ModelDeployment.upstream_model_id, ModelDeployment.id
    )
    if credential_id is not None:
        stmt = stmt.where(ModelDeployment.credential_id == credential_id)
    if enabled is not None:
        stmt = stmt.where(ModelDeployment.enabled == enabled)
    rows = list((await session.execute(stmt)).scalars())
    if media_type:
        try:
            normalized = normalize_media_types([media_type])[0]
        except (ModelCatalogError, IndexError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        rows = [row for row in rows if normalized in (row.media_types or [])]
    credential_ids = {row.credential_id for row in rows}
    creds = (
        {
            row.id: row
            for row in (
                await session.execute(
                    select(ProviderCredential).where(ProviderCredential.id.in_(credential_ids))
                )
            ).scalars()
        }
        if credential_ids
        else {}
    )
    return [_deployment_with_credential(row, creds) for row in rows]


class DeploymentCreate(BaseModel):
    credential_id: int
    upstream_model_id: str = Field(min_length=1, max_length=255)
    display_name: str | None = Field(default=None, max_length=160)
    # 默认 OpenAI 兼容直连；网关不再是任何路径上的缺省
    adapter_type: str = Field(default="openai", max_length=32)
    media_types: list[str] = Field(default_factory=list)
    protocol_options: dict[str, Any] | None = None
    enabled: bool = True
    sort: int = 0


async def _deployment_values(body: DeploymentCreate) -> dict:
    adapter = body.adapter_type.strip().lower()
    if not has_model_plugin(adapter):
        raise HTTPException(status_code=400, detail=f"未知 adapter：{body.adapter_type}")
    try:
        media_types = normalize_media_types(body.media_types)
        protocol_options = validate_protocol_options(body.protocol_options)
    except ModelCatalogError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    unsupported = set(media_types) - get_model_plugin(adapter).media_types
    if unsupported:
        raise HTTPException(
            status_code=400,
            detail=f"adapter {adapter} 不支持媒体类型：{'、'.join(sorted(unsupported))}",
        )
    return {
        "upstream_model_id": body.upstream_model_id.strip(),
        "display_name": body.display_name.strip() if body.display_name else None,
        "adapter_type": adapter,
        "media_types": media_types,
        "protocol_options": protocol_options,
        "enabled": body.enabled,
        "sort": body.sort,
    }


@router.post("/model-deployments", status_code=201)
async def create_model_deployment(body: DeploymentCreate, session: SessionDep) -> dict:
    cred = await session.get(ProviderCredential, body.credential_id)
    if cred is None:
        raise HTTPException(status_code=404, detail="凭据不存在")
    values = await _deployment_values(body)
    exists = (
        await session.execute(
            select(ModelDeployment).where(
                ModelDeployment.credential_id == body.credential_id,
                ModelDeployment.upstream_model_id == values["upstream_model_id"],
                ModelDeployment.adapter_type == values["adapter_type"],
            )
        )
    ).scalar_one_or_none()
    if exists is not None:
        raise HTTPException(status_code=409, detail="该供应商下已存在同名模型和 adapter")
    row = ModelDeployment(credential_id=body.credential_id, discovered=False, **values)
    session.add(row)
    _audit(
        session,
        "model_deployment.create",
        f"新增模型「{values['upstream_model_id']}」· {cred.name}/{values['adapter_type']}",
    )
    await session.commit()
    await session.refresh(row)
    return deployment_view(row, cred)


class DeploymentPatch(BaseModel):
    display_name: str | None = Field(default=None, max_length=160)
    adapter_type: str | None = Field(default=None, max_length=32)
    media_types: list[str] | None = None
    protocol_options: dict[str, Any] | None = None
    enabled: bool | None = None
    sort: int | None = None


@router.patch("/model-deployments/{deployment_id}")
async def patch_model_deployment(
    deployment_id: int, body: DeploymentPatch, session: SessionDep
) -> dict:
    row = await session.get(ModelDeployment, deployment_id)
    if row is None:
        raise HTTPException(status_code=404, detail="模型部署不存在")
    try:
        adapter = row.adapter_type
        if body.adapter_type is not None:
            adapter = body.adapter_type.strip().lower()
            if not has_model_plugin(adapter):
                raise ModelCatalogError(f"未知 adapter：{body.adapter_type}")
        if body.media_types is not None:
            row.media_types = normalize_media_types(body.media_types)
        unsupported = set(row.media_types or []) - get_model_plugin(adapter).media_types
        if unsupported:
            raise ModelCatalogError(
                f"adapter {adapter} 不支持媒体类型：{'、'.join(sorted(unsupported))}"
            )
        if adapter != row.adapter_type:
            duplicate = (
                await session.execute(
                    select(ModelDeployment).where(
                        ModelDeployment.credential_id == row.credential_id,
                        ModelDeployment.upstream_model_id == row.upstream_model_id,
                        ModelDeployment.adapter_type == adapter,
                        ModelDeployment.id != row.id,
                    )
                )
            ).scalar_one_or_none()
            if duplicate is not None:
                raise ModelCatalogError("该供应商下已存在同名模型和 adapter")
            row.adapter_type = adapter
        if "protocol_options" in body.model_fields_set:
            row.protocol_options = validate_protocol_options(body.protocol_options)
    except ModelCatalogError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if body.display_name is not None:
        row.display_name = body.display_name.strip() or None
    if body.enabled is not None:
        row.enabled = body.enabled
    if body.sort is not None:
        row.sort = body.sort
    cred = await session.get(ProviderCredential, row.credential_id)
    _audit(session, "model_deployment.update", f"更新模型「{row.upstream_model_id}」")
    await session.commit()
    await session.refresh(row)
    return deployment_view(row, cred)


@router.delete("/model-deployments/{deployment_id}")
async def delete_model_deployment(
    deployment_id: int, session: SessionDep, force: bool = False
) -> dict:
    row = await session.get(ModelDeployment, deployment_id)
    if row is None:
        raise HTTPException(status_code=404, detail="模型部署不存在")
    bindings = list(
        (
            await session.execute(
                select(CapabilityBinding).where(CapabilityBinding.deployment_id == deployment_id)
            )
        ).scalars()
    )
    if bindings and not force:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "模型仍被能力绑定引用，改绑后再删或携带 ?force=true",
                "bindings": [binding.capability for binding in bindings],
            },
        )
    name = row.upstream_model_id
    for binding in bindings:
        binding.deployment_id = None
    await session.delete(row)
    _audit(session, "model_deployment.delete", f"删除模型部署「{name}」")
    await session.commit()
    return {"deleted": deployment_id, "cleared_bindings": [b.capability for b in bindings]}


# ---- ModelScope LoRA 目录 ----


def _modelscope_lora_view(row: ModelScopeLora) -> dict:
    return {
        "id": row.id,
        "credential_id": row.credential_id,
        "lora_id": row.lora_id,
        "display_name": row.display_name,
        "target_model": row.target_model,
        "default_strength": row.default_strength,
        "enabled": row.enabled,
        "note": row.note,
        "created_at": _iso(row.created_at),
        "updated_at": _iso(row.updated_at),
    }


class ModelScopeLoraCreate(BaseModel):
    credential_id: int
    lora_id: str = Field(min_length=1, max_length=255)
    display_name: str | None = Field(default=None, max_length=160)
    target_model: str = Field(min_length=1, max_length=255)
    default_strength: float = Field(default=0.8, ge=0, le=2)
    enabled: bool = True
    note: str | None = Field(default=None, max_length=300)


class ModelScopeLoraPatch(BaseModel):
    display_name: str | None = Field(default=None, max_length=160)
    target_model: str | None = Field(default=None, min_length=1, max_length=255)
    default_strength: float | None = Field(default=None, ge=0, le=2)
    enabled: bool | None = None
    note: str | None = Field(default=None, max_length=300)


async def _modelscope_credential(session, credential_id: int) -> ProviderCredential:
    credential = await session.get(ProviderCredential, credential_id)
    if credential is None:
        raise HTTPException(status_code=404, detail="凭据不存在")
    if credential.provider_type != "modelscope":
        raise HTTPException(status_code=400, detail="LoRA 目录只能绑定 ModelScope 凭据")
    return credential


async def _duplicate_modelscope_lora(
    session,
    *,
    credential_id: int,
    target_model: str,
    lora_id: str,
    exclude_id: int | None = None,
) -> bool:
    stmt = select(ModelScopeLora.id).where(
        ModelScopeLora.credential_id == credential_id,
        ModelScopeLora.target_model == target_model,
        ModelScopeLora.lora_id == lora_id,
    )
    if exclude_id is not None:
        stmt = stmt.where(ModelScopeLora.id != exclude_id)
    return (await session.execute(stmt)).scalar_one_or_none() is not None


@router.get("/modelscope-loras")
async def list_modelscope_loras(
    session: SessionDep,
    credential_id: int | None = None,
    target_model: str | None = None,
    enabled: bool | None = None,
) -> list[dict]:
    stmt = select(ModelScopeLora).order_by(
        ModelScopeLora.target_model,
        ModelScopeLora.display_name,
        ModelScopeLora.lora_id,
        ModelScopeLora.id,
    )
    if credential_id is not None:
        stmt = stmt.where(ModelScopeLora.credential_id == credential_id)
    if target_model is not None and target_model.strip():
        stmt = stmt.where(ModelScopeLora.target_model == target_model.strip())
    if enabled is not None:
        stmt = stmt.where(ModelScopeLora.enabled == enabled)
    rows = list((await session.execute(stmt)).scalars())
    return [_modelscope_lora_view(row) for row in rows]


@router.post("/modelscope-loras", status_code=201)
async def create_modelscope_lora(
    body: ModelScopeLoraCreate,
    session: SessionDep,
) -> dict:
    credential = await _modelscope_credential(session, body.credential_id)
    lora_id = body.lora_id.strip()
    target_model = body.target_model.strip()
    if await _duplicate_modelscope_lora(
        session,
        credential_id=credential.id,
        target_model=target_model,
        lora_id=lora_id,
    ):
        raise HTTPException(status_code=409, detail="该模型下已存在同名 LoRA")
    row = ModelScopeLora(
        credential_id=credential.id,
        lora_id=lora_id,
        display_name=body.display_name.strip() if body.display_name else None,
        target_model=target_model,
        default_strength=body.default_strength,
        enabled=body.enabled,
        note=body.note.strip() if body.note else None,
    )
    session.add(row)
    _audit(
        session,
        "modelscope_lora.create",
        f"新增 ModelScope LoRA「{row.display_name or row.lora_id}」· {target_model}",
    )
    await session.commit()
    await session.refresh(row)
    return _modelscope_lora_view(row)


@router.patch("/modelscope-loras/{lora_row_id}")
async def patch_modelscope_lora(
    lora_row_id: int,
    body: ModelScopeLoraPatch,
    session: SessionDep,
) -> dict:
    row = await session.get(ModelScopeLora, lora_row_id)
    if row is None:
        raise HTTPException(status_code=404, detail="LoRA 不存在")
    target_model = body.target_model.strip() if body.target_model is not None else row.target_model
    if await _duplicate_modelscope_lora(
        session,
        credential_id=row.credential_id,
        target_model=target_model,
        lora_id=row.lora_id,
        exclude_id=row.id,
    ):
        raise HTTPException(status_code=409, detail="该模型下已存在同名 LoRA")
    if body.display_name is not None:
        row.display_name = body.display_name.strip() or None
    if body.target_model is not None:
        row.target_model = target_model
    if body.default_strength is not None:
        row.default_strength = body.default_strength
    if body.enabled is not None:
        row.enabled = body.enabled
    if body.note is not None:
        row.note = body.note.strip() or None
    _audit(session, "modelscope_lora.update", f"更新 ModelScope LoRA「{row.lora_id}」")
    await session.commit()
    await session.refresh(row)
    return _modelscope_lora_view(row)


@router.delete("/modelscope-loras/{lora_row_id}")
async def delete_modelscope_lora(lora_row_id: int, session: SessionDep) -> dict:
    row = await session.get(ModelScopeLora, lora_row_id)
    if row is None:
        raise HTTPException(status_code=404, detail="LoRA 不存在")
    label = row.display_name or row.lora_id
    await session.delete(row)
    _audit(session, "modelscope_lora.delete", f"删除 ModelScope LoRA「{label}」")
    await session.commit()
    return {"deleted": lora_row_id}


class DeploymentSyncBody(BaseModel):
    adapter_type: str = Field(default="openai", max_length=32)


@router.post("/credentials/{credential_id}/sync-model-deployments")
async def sync_model_deployments(
    credential_id: int, body: DeploymentSyncBody, session: SessionDep
) -> dict:
    cred = await session.get(ProviderCredential, credential_id)
    if cred is None:
        raise HTTPException(status_code=404, detail="凭据不存在")
    try:
        result = await sync_cached_models(
            session, cred, adapter_type=body.adapter_type.strip().lower()
        )
    except ModelCatalogError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _audit(
        session,
        "model_deployment.sync",
        f"凭据「{cred.name}」同步真实模型目录：新增 {result['created']}，更新 {result['updated']}",
    )
    await session.commit()
    return result


@router.post("/credentials/{credential_id}/test")
async def test_credential(credential_id: int, session: SessionDep) -> dict:
    cred = await session.get(ProviderCredential, credential_id)
    if cred is None:
        raise HTTPException(status_code=404, detail="凭据不存在")
    try:
        result = await run_test(cred)
    except CredentialError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    _audit(
        session,
        "credential.test",
        f"凭据「{cred.name}」测试：{'正常' if result['ok'] else result['detail']}",
    )
    await session.commit()
    return result


async def _volcengine_asset_credential(
    session, credential_id: int
) -> tuple[ProviderCredential, dict[str, Any]]:
    cred = await session.get(ProviderCredential, credential_id)
    if cred is None:
        raise HTTPException(status_code=404, detail="凭据不存在")
    if cred.provider_type != "volcengine_video":
        raise HTTPException(status_code=400, detail="该凭据不是火山方舟视频凭据")
    if not cred.enabled:
        raise HTTPException(status_code=409, detail="火山方舟凭据已停用")
    try:
        return cred, decrypt_config(cred.config)
    except CredentialError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


def _raise_volcengine_asset_error(exc: volcengine_assets.VolcengineAssetError) -> NoReturn:
    status = {
        "input": 400,
        "auth": 401,
        "timeout": 504,
    }.get(exc.kind, 502)
    raise HTTPException(status_code=status, detail=str(exc)) from exc


@router.post("/credentials/{credential_id}/volcengine-assets/test")
async def test_volcengine_assets(credential_id: int, session: SessionDep) -> dict:
    cred, config = await _volcengine_asset_credential(session, credential_id)
    try:
        result = await volcengine_assets.diagnostics(config)
    except volcengine_assets.VolcengineAssetError as exc:
        _raise_volcengine_asset_error(exc)
    _audit(session, "volcengine_assets.test", f"凭据「{cred.name}」测试 Ark 素材库签名")
    await session.commit()
    return result


class VolcengineAssetCreateBody(BaseModel):
    public_url: str = Field(min_length=8, max_length=4096)
    name: str = Field(default="asset", min_length=1, max_length=60)
    kind: Literal["image", "video", "audio"] = "image"
    group_name: str = Field(default="可信素材", min_length=1, max_length=60)


@router.post("/credentials/{credential_id}/volcengine-assets", status_code=202)
async def create_volcengine_asset(
    credential_id: int, body: VolcengineAssetCreateBody, session: SessionDep
) -> dict:
    cred, config = await _volcengine_asset_credential(session, credential_id)
    asset_type = {"image": "Image", "video": "Video", "audio": "Audio"}[body.kind]
    try:
        result = await volcengine_assets.create_asset(
            config,
            public_url=body.public_url,
            name=body.name,
            asset_type=asset_type,
            group_name=body.group_name,
        )
    except volcengine_assets.VolcengineAssetError as exc:
        _raise_volcengine_asset_error(exc)
    _audit(
        session,
        "volcengine_assets.create",
        f"凭据「{cred.name}」提交火山 {asset_type} 素材 {result['asset_id']}",
    )
    await session.commit()
    return result


@router.get("/credentials/{credential_id}/volcengine-assets/{asset_id}")
async def get_volcengine_asset(credential_id: int, asset_id: str, session: SessionDep) -> dict:
    _cred, config = await _volcengine_asset_credential(session, credential_id)
    try:
        return await volcengine_assets.get_asset(config, asset_id)
    except volcengine_assets.VolcengineAssetError as exc:
        _raise_volcengine_asset_error(exc)


class CliHelpBody(BaseModel):
    command: str = Field(default="", max_length=64)


async def _cli_credential(session, credential_id: int) -> ProviderCredential:
    cred = await session.get(ProviderCredential, credential_id)
    if cred is None:
        raise HTTPException(status_code=404, detail="凭据不存在")
    if cred.provider_type not in {"codex_cli", "gemini_cli", "jimeng_cli"}:
        raise HTTPException(status_code=400, detail="该凭据不是本机 CLI")
    return cred


def _raise_cli_error(exc: cli_bridge.CliBridgeError) -> NoReturn:
    status = 504 if exc.kind == "timeout" else (400 if exc.kind in {"input", "missing"} else 502)
    raise HTTPException(status_code=status, detail=str(exc)) from exc


@router.get("/credentials/{credential_id}/cli-status")
async def cli_credential_status(credential_id: int, session: SessionDep) -> dict:
    cred = await _cli_credential(session, credential_id)
    try:
        return await cli_bridge.provider_status(decrypt_config(cred.config), cred.provider_type)
    except cli_bridge.CliBridgeError as exc:
        _raise_cli_error(exc)


@router.post("/credentials/{credential_id}/cli-help")
async def cli_credential_help(credential_id: int, body: CliHelpBody, session: SessionDep) -> dict:
    cred = await _cli_credential(session, credential_id)
    try:
        text = await cli_bridge.provider_help(
            decrypt_config(cred.config), cred.provider_type, body.command
        )
    except cli_bridge.CliBridgeError as exc:
        _raise_cli_error(exc)
    return {"text": text}


@router.post("/credentials/{credential_id}/cli-login")
async def cli_credential_login(credential_id: int, session: SessionDep) -> dict:
    cred = await _cli_credential(session, credential_id)
    if cred.provider_type != "jimeng_cli":
        raise HTTPException(status_code=400, detail="只有即梦 CLI 支持服务内扫码登录")
    try:
        result = await cli_bridge.jimeng_login_start(decrypt_config(cred.config))
    except cli_bridge.CliBridgeError as exc:
        _raise_cli_error(exc)
    _audit(session, "credential.cli_login", f"凭据「{cred.name}」启动即梦扫码登录")
    await session.commit()
    return result


@router.get("/credentials/{credential_id}/cli-login")
async def cli_credential_login_status(credential_id: int, session: SessionDep) -> dict:
    cred = await _cli_credential(session, credential_id)
    if cred.provider_type != "jimeng_cli":
        raise HTTPException(status_code=400, detail="只有即梦 CLI 支持服务内扫码登录")
    try:
        return await cli_bridge.jimeng_login_status(decrypt_config(cred.config))
    except cli_bridge.CliBridgeError as exc:
        _raise_cli_error(exc)


@router.post("/credentials/{credential_id}/cli-logout")
async def cli_credential_logout(credential_id: int, session: SessionDep) -> dict:
    cred = await _cli_credential(session, credential_id)
    if cred.provider_type != "jimeng_cli":
        raise HTTPException(status_code=400, detail="只有即梦 CLI 支持退出登录")
    try:
        result = await cli_bridge.jimeng_logout(decrypt_config(cred.config))
    except cli_bridge.CliBridgeError as exc:
        _raise_cli_error(exc)
    _audit(session, "credential.cli_logout", f"凭据「{cred.name}」退出即梦 CLI")
    await session.commit()
    return result


# ---- YouTube 内置登录（Playwright 持久化 profile，FR-21） ----


async def _upsert_login_credential(session, cookies_text: str) -> ProviderCredential:
    """登录导出的 cookies 写入凭据库：取 kind=video_source 首条，没有则建「YouTube 登录」。

    带 login_profile 标记（video_source.build_ytdlp_opts 据此每次下载前现导最新 cookies）。
    """
    cred = (
        await session.execute(
            select(ProviderCredential)
            .where(ProviderCredential.kind == "video_source")
            .order_by(ProviderCredential.id)
            .limit(1)
        )
    ).scalar_one_or_none()
    if cred is None:
        cred = ProviderCredential(
            name="YouTube 登录",
            kind="video_source",
            provider_type="youtube",
            config={},
        )
        session.add(cred)
    merged = dict(cred.config or {})
    merged["cookies_text"] = cookies_text
    merged["login_profile"] = True
    cred.config = encrypt_config(merged)
    cred.status = "ok"
    cred.status_detail = None
    cred.last_tested_at = datetime.now(UTC)
    return cred


@router.post("/youtube/login")
async def youtube_login_start(session: SessionDep) -> dict:
    """弹出内置 Chromium 登录窗（后台任务），前端轮询 status 等结果。"""
    if not youtube_login.start_login_window():
        return {"status": "already_open"}
    _audit(session, "youtube.login", "打开 YouTube 内置登录窗口")
    await session.commit()
    return {"status": "window_opened"}


@router.get("/youtube/login/status")
async def youtube_login_status(session: SessionDep) -> dict:
    """登录状态轮询：窗口开着 → checking；登录成功首次查询时自动导出 cookies 写凭据。"""
    if youtube_login.login_window_open():
        return {"logged_in": False, "checking": True}
    if youtube_login.pending_sync():
        try:
            cookies_text = await asyncio.to_thread(youtube_login.export_cookies_sync)
        except youtube_login.YoutubeLoginError as exc:
            # 保留待同步标记：下次轮询重试导出（前端展示 detail 后可停止轮询）
            return {"logged_in": False, "checking": False, "detail": str(exc)}
        try:
            cred = await _upsert_login_credential(session, cookies_text)
        except CredentialError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        _audit(
            session,
            "youtube.login",
            f"YouTube 登录成功，cookies 已导出写入凭据「{cred.name}」",
        )
        await session.commit()
        youtube_login.mark_synced()
        return {"logged_in": True, "checking": False, "credential_id": cred.id}
    result: dict = {"logged_in": youtube_login.profile_logged_in(), "checking": False}
    login_result = youtube_login.last_login_result()
    if not result["logged_in"] and login_result and login_result != "success":
        result["detail"] = {
            "timeout": "登录窗口超时未完成（5 分钟），请重试",
            "closed": "登录窗口被关闭，未检测到登录态",
        }.get(login_result, login_result)
    return result


# ---- 能力绑定 ----

# 能力的展示元数据：名称 / 说明 / 分组 / 媒体类型 / 探测口径。键集合与
# credentials.ALL_CAPABILITIES 一一对应（有测试守着），设置页不再维护前端副本。
# 分组决定选路口径：模型能力挑部署，朗读与实时语音挑凭据+音色，翻译链只有引擎顺序。
_GROUP_ROUTING: dict[str, tuple[str | None, str | None]] = {
    "llm": ("chat", "chat.complete"),
    "image": ("image", "image.generate"),
    "voice": ("audio", "audio.synthesize"),
    "realtime": ("audio", "realtime.session"),
    "translate": (None, None),
}


def _cap(
    label: str, description: str, *, group: str, test_kind: str | None = None
) -> dict[str, Any]:
    media_type, operation = _GROUP_ROUTING[group]
    return {
        "label": label,
        "description": description,
        "group": group,
        "media_type": media_type,
        "operation": operation,
        "test_kind": test_kind,
    }


CAPABILITY_META: dict[str, dict[str, Any]] = {
    DEFAULT_LLM_CAPABILITY: _cap(
        "全局默认模型",
        "所有 AI 功能默认用它；个别用途要用别的模型，在下面单独指定",
        group="llm",
        test_kind="text",
    ),
    "translate-fast": _cap(
        "快速翻译", "句子点译、双语对照、字幕翻译 · 要快", group="llm", test_kind="text"
    ),
    "explain-standard": _cap(
        "词语解释", "AI 语境释义、词组解释、陪读问答", group="llm", test_kind="json"
    ),
    "grammar-deep": _cap(
        "深度语法", "语法三级分析、句子精讲、整篇摘要 · 要准", group="llm", test_kind="json"
    ),
    "companion": _cap("陪读对话", "看板娘语音陪读与场景对话的大脑", group="llm", test_kind="text"),
    "summary": _cap("全文概要", "整篇文章摘要与章节导读", group="llm", test_kind="json"),
    "repair-agent": _cap(
        "修复代理",
        "管线 AI 修复的大脑 · 工具调用要求高，建议绑最强模型",
        group="llm",
        test_kind="text",
    ),
    "chat-general": _cap(
        "创作对话",
        "工坊 GPT 创作对话的大脑 · 它自己决定何时调生图工具，建议绑最强模型",
        group="llm",
        test_kind="text",
    ),
    "assistant": _cap(
        "语音助理",
        "工作台助理的大脑 · 中英混说、调工具（阅读 / 邮件 / 日历 / 复习 / 任务），"
        "回复会被念出来；建议绑强模型",
        group="llm",
        test_kind="text",
    ),
    "tts-word": _cap("查词发音", "点词、词卡的单词朗读", group="voice"),
    "tts-sentence": _cap("句子朗读", "阅读器逐句朗读", group="voice"),
    "tts-chapter": _cap("整篇连读", "整章连续朗读", group="voice"),
    "tts-vocab": _cap("背单词发音", "词库复习时的发音", group="voice"),
    "tts-video": _cap("视频字幕", "视频字幕句朗读", group="voice"),
    "tts-assistant": _cap(
        "助理朗读",
        "语音助理念回复与早报，中文为主；没绑时用 edge 晓晓（zh-CN），要中英混说选火山双语音色",
        group="voice",
    ),
    "tts-meaning": _cap(
        "释义朗读",
        "听读单词时念中文释义；没绑时用 edge 晓晓（zh-CN）",
        group="voice",
    ),
    "image-cover": _cap(
        "封面配图", "单词本/书籍封面 · 画面要简洁、缩到卡片大小仍认得出", group="image"
    ),
    "image-illustration": _cap("插图", "场景短文配图、对话场景卡 · 叙事性画面", group="image"),
    "image-free": _cap("自由出图", "生图工作台里手动出的图", group="image"),
    "realtime-voice": _cap("实时语音", "端到端语音对话（陪读 / 场景陪练）", group="realtime"),
    "translate-chain": _cap("翻译链", "句子点译与双语对照的引擎降级顺序", group="translate"),
}


def _capability_fields(capability: str) -> dict[str, Any]:
    meta = CAPABILITY_META.get(capability)
    if meta is not None:
        return {**meta, "known": True}
    # 库里残留的未知能力名照常展示，不猜它的媒体类型。known=false 让设置页把它们跟
    # 真正的用途分开摆——它们没有中文名，直接混进列表就是把 slug 摆到用户眼前（核心原则 6）
    return {
        "label": capability,
        "description": "",
        "known": False,
        "group": "llm",
        "media_type": None,
        "operation": None,
        "test_kind": None,
    }


def _ready_plugins(operation: str | None, plugins: list[dict]) -> list[dict]:
    if operation is None:
        return []
    return [
        {"id": item["id"], "name": item["name"], "execution": item["execution"]}
        for item in plugins
        if operation in item["ready_operations"]
    ]


def _deployment_options(
    media_type: str | None,
    deployments: list[ModelDeployment],
    creds: dict[int, ProviderCredential],
    ready_ids: set[str],
) -> list[dict]:
    """该能力可选的部署：启用、凭据启用、媒体类型匹配；adapter 是否接线由 ready 标出。"""
    if media_type is None:
        return []
    out: list[dict] = []
    for row in deployments:
        if not row.enabled or media_type not in (row.media_types or []):
            continue
        cred = creds.get(row.credential_id)
        if cred is None or not cred.enabled:
            continue
        out.append({**deployment_view(row, cred), "ready": row.adapter_type in ready_ids})
    return out


def _binding_view(
    b: CapabilityBinding,
    creds: dict[int, ProviderCredential],
    deployments: dict[int, ModelDeployment] | None = None,
) -> dict:
    cred = creds.get(b.credential_id) if b.credential_id else None
    deployment = (deployments or {}).get(b.deployment_id) if b.deployment_id is not None else None
    if b.capability == "translate-chain":
        healthy = bool((b.params or {}).get("chain"))
    else:
        healthy = cred is not None and cred.enabled and (deployment is None or deployment.enabled)
    return {
        "capability": b.capability,
        "credential_id": b.credential_id,
        "deployment_id": b.deployment_id,
        "target": b.target,
        "params": b.params,
        "fallback": b.fallback,
        "healthy": healthy,
        "bound": True,
        **_capability_fields(b.capability),
        "credential_name": cred.name if cred else None,
        "provider_type": cred.provider_type if cred else None,
        "deployment": (
            deployment_view(deployment, creds.get(deployment.credential_id))
            if deployment is not None
            else None
        ),
        "ready_plugins": [],
        "deployment_options": [],
        # 这条能力自己没挑模型，运行时会用全局默认那条（domain/model_catalog._candidate_specs）
        "follows_default": b.deployment_id is None
        and b.capability in DEFAULT_FOLLOWER_CAPABILITIES,
    }


def _unbound_view(capability: str) -> dict:
    return {
        "capability": capability,
        "credential_id": None,
        "deployment_id": None,
        "target": None,
        "params": None,
        "fallback": None,
        "healthy": False,
        "bound": False,
        **_capability_fields(capability),
        "credential_name": None,
        "provider_type": None,
        "deployment": None,
        "ready_plugins": [],
        "deployment_options": [],
        "follows_default": capability in DEFAULT_FOLLOWER_CAPABILITIES,
    }


@router.get("/bindings")
async def list_bindings(session: SessionDep) -> list[dict]:
    """全部能力各一行：未绑定的也列出（bound=false），附元数据、就绪插件与可选部署。

    绑定表由这一个响应驱动，前端不再维护能力清单副本。
    """
    rows = {b.capability: b for b in (await session.execute(select(CapabilityBinding))).scalars()}
    creds = {c.id: c for c in (await session.execute(select(ProviderCredential))).scalars()}
    deployments = list(
        (
            await session.execute(
                select(ModelDeployment).order_by(ModelDeployment.sort, ModelDeployment.id)
            )
        ).scalars()
    )
    by_id = {d.id: d for d in deployments}
    plugins = list_model_plugins()
    known = set(ALL_CAPABILITIES)
    capabilities = [*ALL_CAPABILITIES, *sorted(cap for cap in rows if cap not in known)]
    out: list[dict] = []
    for capability in capabilities:
        binding = rows.get(capability)
        view = _binding_view(binding, creds, by_id) if binding else _unbound_view(capability)
        ready = _ready_plugins(view["operation"], plugins)
        view["ready_plugins"] = ready
        view["deployment_options"] = _deployment_options(
            view["media_type"], deployments, creds, {item["id"] for item in ready}
        )
        out.append(view)
    return out


class BindingPut(BaseModel):
    credential_id: int | None = None
    deployment_id: int | None = None
    target: str | None = Field(default=None, max_length=128)
    params: dict[str, Any] | None = None
    fallback: list[dict[str, Any]] | None = None


MODEL_CAPABILITIES = (DEFAULT_LLM_CAPABILITY, *LLM_CAPABILITIES, *IMAGE_CAPABILITIES)
# 「待改绑」红点只看真正的用途：全局默认没配不是历史遗留，是还没设，设置页自己会显眼地说
LEGACY_SCAN_CAPABILITIES = (*LLM_CAPABILITIES, *IMAGE_CAPABILITIES)
# 跟随全局默认的能力集合，与 domain/model_catalog._default_followers() 同源
DEFAULT_FOLLOWER_CAPABILITIES = frozenset(LLM_CAPABILITIES)


def _capability_operation(capability: str) -> str:
    return "image.generate" if capability in IMAGE_CAPABILITIES else "chat.complete"


def _direct_adapter_for(provider_type: str, capability: str) -> str | None:
    """按凭据类型推断能直连的 adapter；推断不出返回 None。"""
    adapter = adapter_for_provider(
        provider_type,
        fallback="",
        operation=_capability_operation(capability),
    )
    return adapter or None


async def _resolve_legacy_deployment(
    session,
    *,
    capability: str,
    credential: ProviderCredential,
    target: str,
) -> ModelDeployment:
    """把旧设置页的 credential + target 写法补成 v2 deployment 引用。

    adapter 按凭据类型推断：OpenAI 兼容家族（含 DeepSeek 官方）直连，推断不出
    就按 OpenAI 兼容协议落。同名直连部署已存在就复用，没有就补一条未发现的。
    """
    adapter = _direct_adapter_for(credential.provider_type, capability) or "openai"
    row = (
        await session.execute(
            select(ModelDeployment).where(
                ModelDeployment.credential_id == credential.id,
                ModelDeployment.upstream_model_id == target,
                ModelDeployment.adapter_type == adapter,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        row = ModelDeployment(
            credential_id=credential.id,
            upstream_model_id=target,
            adapter_type=adapter,
            media_types=["image" if capability in IMAGE_CAPABILITIES else "chat"],
            discovered=False,
        )
        session.add(row)
        await session.flush()
    if not row.enabled:
        raise HTTPException(status_code=400, detail="模型部署已停用，无法绑定")
    return row


@router.get("/bindings/legacy")
async def list_legacy_bindings(session: SessionDep) -> dict:
    """还没指到一条可用部署的 LLM / 生图能力清单。

    三种情形：没有绑定行（调用时直接报未绑定）、绑定没挂部署只留了模型名、
    挂的部署的 adapter 已经没有对应插件（历史遗留行，调用必失败）。
    设置页据此打「待改绑」，回填脚本跑之前也靠它核对。
    ``direct_deployment_id`` 是同凭据同模型已存在的可用直连部署，有就能直接切。
    """
    bindings = {
        b.capability: b
        for b in (
            await session.execute(
                select(CapabilityBinding).where(
                    CapabilityBinding.capability.in_(MODEL_CAPABILITIES)
                )
            )
        ).scalars()
    }
    creds = {c.id: c for c in (await session.execute(select(ProviderCredential))).scalars()}
    deployments = list((await session.execute(select(ModelDeployment))).scalars())
    by_id = {d.id: d for d in deployments}
    items: list[dict[str, Any]] = []
    for capability in LEGACY_SCAN_CAPABILITIES:
        binding = bindings.get(capability)
        deployment = (
            by_id.get(binding.deployment_id)
            if binding is not None and binding.deployment_id is not None
            else None
        )
        if binding is None:
            reason = "unbound"
        elif deployment is None:
            reason = "no_deployment"
        elif not has_model_plugin(deployment.adapter_type):
            reason = "stale_deployment"
        else:
            continue
        cred = (
            creds.get(binding.credential_id)
            if binding is not None and binding.credential_id is not None
            else None
        )
        suggested = _direct_adapter_for(cred.provider_type, capability) if cred else None
        direct = None
        if cred is not None and binding is not None and binding.target:
            candidates = [
                d
                for d in deployments
                if d.credential_id == cred.id
                and d.upstream_model_id == binding.target
                and d.enabled
                and has_model_plugin(d.adapter_type)
            ]
            candidates.sort(key=lambda d: (d.adapter_type != suggested, d.id))
            direct = candidates[0] if candidates else None
        items.append(
            {
                "capability": capability,
                "reason": reason,
                "credential_id": cred.id if cred else None,
                "credential_name": cred.name if cred else None,
                "provider_type": cred.provider_type if cred else None,
                "target": binding.target if binding is not None else None,
                "deployment_id": deployment.id if deployment is not None else None,
                "adapter_type": deployment.adapter_type if deployment is not None else None,
                "suggested_adapter": suggested,
                "direct_deployment_id": direct.id if direct is not None else None,
            }
        )
    return {"count": len(items), "items": items}


@router.put("/bindings/{capability}")
async def put_binding(capability: str, body: BindingPut, session: SessionDep) -> dict:
    if capability not in ALL_CAPABILITIES:
        raise HTTPException(status_code=400, detail=f"未知能力：{capability}")

    params = body.params
    deployment: ModelDeployment | None = None
    credential_id = body.credential_id
    target = body.target
    if body.deployment_id is not None:
        deployment = await session.get(ModelDeployment, body.deployment_id)
        if deployment is None:
            raise HTTPException(status_code=404, detail="模型部署不存在")
        if not deployment.enabled:
            raise HTTPException(status_code=400, detail="模型部署已停用，无法绑定")
        credential_id = deployment.credential_id
        target = deployment.upstream_model_id
    cred: ProviderCredential | None = None
    chain: list[str] | None = None
    if capability == "translate-chain":
        if body.deployment_id is not None:
            raise HTTPException(status_code=400, detail="translate-chain 不使用模型部署")
        chain = normalize_chain((params or {}).get("chain"))
        if not chain:
            raise HTTPException(status_code=400, detail="translate-chain 需要 params.chain 非空")
        params = {**(params or {}), "chain": chain}
    else:
        if credential_id is None:
            raise HTTPException(status_code=400, detail="credential_id 或 deployment_id 必填")
        cred = await session.get(ProviderCredential, credential_id)
        if cred is None:
            raise HTTPException(status_code=404, detail="凭据不存在")
        if not cred.enabled:
            raise HTTPException(status_code=400, detail=f"凭据「{cred.name}」已停用，无法绑定")
        if cred.provider_type == "minimax_tts":
            raise HTTPException(
                status_code=400, detail="MiniMax 仅用于音色对照试听，暂不支持用途绑定"
            )
        # 生图能力同样必填 target：不填也能存会得到一个看着 healthy 实则调不通的绑定
        if capability in MODEL_CAPABILITIES and not target:
            raise HTTPException(status_code=400, detail="该能力绑定需要 target 模型名")
        if deployment is None and target and capability in MODEL_CAPABILITIES:
            deployment = await _resolve_legacy_deployment(
                session,
                capability=capability,
                credential=cred,
                target=target,
            )

    binding = (
        await session.execute(
            select(CapabilityBinding).where(CapabilityBinding.capability == capability)
        )
    ).scalar_one_or_none()
    if binding is None:
        binding = CapabilityBinding(capability=capability)
        session.add(binding)
    binding.credential_id = None if capability == "translate-chain" else credential_id
    binding.deployment_id = (
        None if capability == "translate-chain" else deployment.id if deployment else None
    )
    binding.target = None if capability == "translate-chain" else target
    binding.params = params
    binding.fallback = body.fallback or None

    if chain is not None:
        summary = f"翻译链更新为 {' → '.join(chain)}"
    else:
        adapter = deployment.adapter_type if deployment is not None else "legacy"
        cred_name = cred.name if cred is not None else "-"
        summary = f"{capability} 绑定「{cred_name}」/{target or '-'} · {adapter}"
    _audit(session, "binding.update", summary)
    await session.commit()
    creds = {cred.id: cred} if cred else {}
    deployments = {deployment.id: deployment} if deployment is not None else None
    return _binding_view(binding, creds, deployments)


@router.delete("/bindings/{capability}")
async def clear_binding(capability: str, session: SessionDep) -> dict:
    """把一条能力改回「跟随全局默认模型」。

    PUT 做不到这件事：它要求 credential_id 或 deployment_id 必填（不填 400），
    语义上是「绑到哪」，没有「不绑到任何地方」这一档。清空只能单独开一个动作。

    删的是整行而不是把 deployment_id 置空——两者运行时等价（都跟随默认），
    但留一行主键在那儿会让「从没设过」和「设过又清掉」在 GET 里长得不一样，
    而它们本来就是同一件事。params 与 fallback 跟着一起走：它们是给那条模型配的，
    模型都不指定了，采样参数留着只会在下次改绑时悄悄复活。
    """
    if capability not in DEFAULT_FOLLOWER_CAPABILITIES:
        raise HTTPException(
            status_code=400,
            detail=f"{_capability_fields(capability)['label']} 没有可跟随的默认，只能直接改绑",
        )
    binding = (
        await session.execute(
            select(CapabilityBinding).where(CapabilityBinding.capability == capability)
        )
    ).scalar_one_or_none()
    if binding is not None:
        await session.delete(binding)
        _audit(session, "binding.update", f"{capability} 改为跟随全局默认模型")
        await session.commit()
    return _unbound_view(capability)


# ---- 生图全局默认（CR-005 §3.5） ----


@router.get("/image-defaults")
async def get_image_defaults(session: SessionDep) -> dict:
    """全产品出图的默认参数。各工具在这个基础上微调，微调不写回这里。"""
    current = await image_defaults.load(session)
    return {
        "quality": image_defaults.quality(),
        "qualities": list(image_defaults.QUALITIES),
        "factory": {"quality": image_defaults.FALLBACK_QUALITY},
        "stored": current,
    }


class ImageDefaultsBody(BaseModel):
    quality: Literal["low", "medium", "high"]


@router.put("/image-defaults")
async def put_image_defaults(body: ImageDefaultsBody, session: SessionDep) -> dict:
    try:
        stored = await image_defaults.save(session, quality=body.quality)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"quality": image_defaults.quality(), "stored": stored}


# ---- 偏好（阅读与外观整包 KV） ----


@router.get("/prefs")
async def get_prefs(session: SessionDep) -> dict:
    rows = (await session.execute(select(UserPref))).scalars()
    return {row.key: row.value for row in rows}


@router.put("/prefs")
async def put_prefs(body: dict[str, Any], session: SessionDep) -> dict:
    if network_policy.PREF_KEY in body:
        raise HTTPException(422, "网络设置请使用 /config/network 接口")
    for key, value in body.items():
        row = await session.get(UserPref, key)
        if row is None:
            session.add(UserPref(key=key, value=value))
        else:
            row.value = value
    await session.commit()
    rows = (await session.execute(select(UserPref))).scalars()
    return {row.key: row.value for row in rows}


@router.get("/network")
async def get_network(session: SessionDep) -> network_policy.NetworkPolicy:
    return await network_policy.load_policy(session)


@router.put("/network")
async def put_network(body: network_policy.NetworkPolicy, session: SessionDep):
    row = await session.get(UserPref, network_policy.PREF_KEY)
    if row is None:
        session.add(UserPref(key=network_policy.PREF_KEY, value=body.model_dump()))
    else:
        row.value = body.model_dump()
    _audit(session, "network.update", f"修改客户端网络路由：{body.scope}")
    await session.commit()
    return body


@router.post("/network/probe")
async def probe_network(body: network_policy.NetworkPolicy):
    return await network_policy.probe_speech_network(body)


# ---- 审计 ----


@router.get("/audit")
async def list_audit(session: SessionDep, limit: int = 20) -> list[dict]:
    stmt = select(ConfigAudit).order_by(ConfigAudit.id.desc()).limit(max(1, min(limit, 100)))
    return [
        {
            "id": row.id,
            "action": row.action,
            "summary": row.summary,
            "created_at": _iso(row.created_at),
        }
        for row in (await session.execute(stmt)).scalars()
    ]


# ---- 存储统计与清理 ----


def _dir_mb(path: Path) -> float:
    if not path.exists():
        return 0.0
    total = sum(f.stat().st_size for f in path.rglob("*") if f.is_file())
    return round(total / (1024 * 1024), 2)


@router.get("/storage-stats")
async def storage_stats(session: SessionDep) -> dict:
    media_root = Path(get_settings().media_root)
    analysis_rows = (
        await session.execute(select(func.count()).select_from(AnalysisResult))
    ).scalar_one()
    return {
        "tts_cache_mb": _dir_mb(media_root / "tts"),
        "local_models_mb": _dir_mb(Path(get_settings().local_models_root)),
        "analysis_rows": analysis_rows,
        "media_mb": _dir_mb(media_root),
    }


def _clear_directory_files(root: Path) -> tuple[float, int]:
    cleared, files = 0, 0
    if root.exists():
        for file in root.rglob("*"):
            if file.is_file():
                cleared += file.stat().st_size
                file.unlink(missing_ok=True)
                files += 1
    return round(cleared / (1024 * 1024), 2), files


@router.post("/clear-tts-cache")
async def clear_tts_cache(session: SessionDep) -> dict:
    tts_dir = Path(get_settings().media_root) / "tts"
    cleared_mb, files = _clear_directory_files(tts_dir)
    # 浏览器还有 7 天缓存，光删文件用户听到的仍是旧音；代号 +1 让前端 URL 变掉
    epoch = await tts_cache.bump_epoch(session)
    _audit(session, "storage.clear_tts", f"清理 TTS 缓存 {files} 个文件（{cleared_mb} MB）")
    await session.commit()
    return {"cleared_mb": cleared_mb, "files": files, "epoch": epoch}


@router.post("/clear-local-models")
async def clear_local_models(session: SessionDep) -> dict:
    cleared_mb, files = _clear_directory_files(Path(get_settings().local_models_root))
    _audit(session, "storage.clear_models", f"清理本地模型 {files} 个文件（{cleared_mb} MB）")
    await session.commit()
    return {"cleared_mb": cleared_mb, "files": files}
