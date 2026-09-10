"""ComfyUI / RunningHub 工作流执行器。

协议层只提交、轮询并把远端产物变成字节；持久任务状态与资产入库
由 worker 负责。这样 API 进程重启不会把正在云端运行的任务丢掉。
"""

from __future__ import annotations

import asyncio
import copy
import json
import mimetypes
import random
import re
import uuid
from dataclasses import dataclass, replace
from dataclasses import field as dataclass_field
from pathlib import PurePosixPath
from typing import Any, Protocol
from urllib.parse import urlparse

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from domain.credentials import workflow_base, workflow_headers
from domain.model_invocations import ModelInvocationSpan
from domain.model_plugins import get_model_plugin, model_plugin_identity
from domain.models import ImageAsset, StudioMediaAsset, StudioWorkflow
from domain.network_policy import routed_http_client
from domain.plugin_runtime import (
    PluginManifest,
    PluginRegistry,
    PluginRegistryError,
    RegistrationHandle,
)
from domain.storage import get_storage

POLL_INTERVAL_S = 2.0
WORKFLOW_TIMEOUT_S = 3600.0
MAX_OUTPUT_BYTES = 512 * 1024 * 1024


class WorkflowExecutionError(Exception):
    def __init__(self, kind: str, message: str, *, retryable: bool = True) -> None:
        super().__init__(message)
        self.kind = kind
        self.retryable = retryable


class WorkflowRouteProvider(Protocol):
    """工作流 Service Provider：封装运行时凭据、提交、恢复与轮询协议。"""

    def prepare_config(
        self,
        config: dict[str, Any],
        *,
        use_wallet: bool,
        workflow_kind: str | None,
    ) -> dict[str, Any]: ...

    async def submit(
        self,
        route: PreparedWorkflowRoute,
        session: AsyncSession,
        *,
        values: dict[str, Any],
        instance_type: str,
    ) -> WorkflowHandle: ...

    def resume(
        self,
        route: PreparedWorkflowRoute,
        provider_task_id: str,
    ) -> WorkflowHandle: ...

    async def wait(self, handle: WorkflowHandle) -> list[WorkflowOutput]: ...


@dataclass(frozen=True)
class WorkflowDefinition:
    id: int | None
    key: str
    provider: str
    kind: str
    source_id: str | None
    payload: dict[str, Any]
    ui_schema: dict[str, Any]
    enabled: bool


@dataclass(frozen=True)
class WorkflowRouteSnapshot:
    capability: str
    operation: str
    workflow_id: int | None
    workflow_key: str
    workflow_kind: str
    plugin_id: str
    plugin_version: str
    plugin_generation: int
    runtime_generation: int
    source_id: str | None

    def view(self) -> dict[str, Any]:
        return {
            "capability": self.capability,
            "operation": self.operation,
            "workflow_id": self.workflow_id,
            "workflow_key": self.workflow_key,
            "workflow_kind": self.workflow_kind,
            "plugin_id": self.plugin_id,
            "plugin_version": self.plugin_version,
            "plugin_generation": self.plugin_generation,
            "runtime_generation": self.runtime_generation,
            "source_id": self.source_id,
        }


@dataclass(frozen=True)
class PreparedWorkflowRoute:
    """冻结工作流定义、凭据选择与 Provider 代际的一次性路由。"""

    snapshot: WorkflowRouteSnapshot
    _workflow: WorkflowDefinition = dataclass_field(repr=False, compare=False)
    _config: dict[str, Any] = dataclass_field(repr=False, compare=False)
    _provider: WorkflowRouteProvider = dataclass_field(repr=False, compare=False)

    async def submit(
        self,
        session: AsyncSession,
        *,
        values: dict[str, Any],
        instance_type: str = "",
    ) -> WorkflowHandle:
        if not self._workflow.enabled:
            raise WorkflowExecutionError("input", "工作流已停用", retryable=False)
        handle = await self._provider.submit(
            self,
            session,
            values=copy.deepcopy(values),
            instance_type=instance_type,
        )
        return replace(handle, snapshot=self.snapshot, _provider=self._provider)

    def resume(self, provider_task_id: str) -> WorkflowHandle:
        task_id = str(provider_task_id or "").strip()
        if not task_id:
            raise WorkflowExecutionError("input", "上游任务 ID 为空", retryable=False)
        handle = self._provider.resume(self, task_id)
        return replace(handle, snapshot=self.snapshot, _provider=self._provider)


@dataclass(frozen=True)
class WorkflowHandle:
    provider: str
    provider_task_id: str
    base_url: str
    credential_config: dict[str, Any] = dataclass_field(repr=False)
    workflow_key: str | None = None
    source_id: str | None = None
    workflow_kind: str | None = None
    snapshot: WorkflowRouteSnapshot | None = None
    _provider: WorkflowRouteProvider | None = dataclass_field(
        default=None, repr=False, compare=False
    )


@dataclass(frozen=True)
class WorkflowOutput:
    name: str
    mime: str
    kind: str
    data: bytes
    source_url: str | None = None


WORKFLOW_PROVIDER_KIND = "model-workflow-provider"
_workflow_providers: PluginRegistry[WorkflowRouteProvider] = PluginRegistry(
    WORKFLOW_PROVIDER_KIND
)


def register_workflow_route_provider(
    *,
    plugin_id: str,
    provider: WorkflowRouteProvider,
    operations: set[str] | frozenset[str],
    replace: bool = False,
) -> RegistrationHandle:
    """登记可撤销工作流 Provider；替换句柄卸载后恢复上一代实现。"""
    plugin = get_model_plugin(plugin_id)
    normalized = frozenset(value.strip().lower() for value in operations if value.strip())
    if not normalized:
        raise PluginRegistryError("工作流 Provider 至少要声明一个操作")
    if not normalized <= plugin.ready_operations:
        raise PluginRegistryError(
            f"工作流 Provider 操作必须属于模型插件 {plugin.id} 的 ready_operations"
        )
    manifest = PluginManifest(
        id=plugin.id,
        kind=WORKFLOW_PROVIDER_KIND,
        name=f"{plugin.name} Workflow Provider",
        version="1.0.0",
        capabilities=normalized,
    )
    return _workflow_providers.register(manifest, provider, replace=replace)


def workflow_route_provider_views() -> dict[str, dict[str, Any]]:
    return {
        item.manifest.id: {
            "workflow_provider_operations": sorted(item.manifest.capabilities),
            "workflow_runtime_generation": item.generation,
        }
        for item in _workflow_providers.list()
    }


def _workflow_definition(
    workflow: StudioWorkflow | str,
    *,
    workflow_key: str | None = None,
    source_id: str | None = None,
    workflow_kind: str | None = None,
) -> WorkflowDefinition:
    if isinstance(workflow, str):
        provider = workflow.strip().lower()
        return WorkflowDefinition(
            id=None,
            key=str(workflow_key or ""),
            provider=provider,
            kind=str(workflow_kind or "workflow"),
            source_id=source_id,
            payload={},
            ui_schema={},
            enabled=True,
        )
    return WorkflowDefinition(
        id=workflow.id,
        key=str(workflow.key or ""),
        provider=str(workflow.provider or "").strip().lower(),
        kind=str(workflow.kind or "workflow"),
        source_id=str(workflow.source_id).strip() if workflow.source_id else None,
        payload=copy.deepcopy(workflow.payload or {}),
        ui_schema=copy.deepcopy(workflow.ui_schema or {}),
        enabled=bool(workflow.enabled),
    )


def prepare_workflow_route(
    workflow: StudioWorkflow | str,
    config: dict[str, Any],
    *,
    capability: str = "workflow-execute",
    operation: str = "workflow.run",
    use_wallet: bool = False,
    workflow_key: str | None = None,
    source_id: str | None = None,
    workflow_kind: str | None = None,
) -> PreparedWorkflowRoute:
    """冻结工作流定义、凭据选择与当前 Provider 实现。"""
    definition = _workflow_definition(
        workflow,
        workflow_key=workflow_key,
        source_id=source_id,
        workflow_kind=workflow_kind,
    )
    normalized_operation = operation.strip().lower()
    try:
        plugin = get_model_plugin(definition.provider)
        runtime = _workflow_providers.resolve(normalized_operation, preferred_id=plugin.id)
    except (ValueError, PluginRegistryError) as exc:
        raise WorkflowExecutionError(
            "binding",
            f"模型插件 {definition.provider} 没有可用的 {normalized_operation} Provider",
            retryable=False,
        ) from exc
    if not plugin.supports(normalized_operation) or not plugin.is_ready(normalized_operation):
        raise WorkflowExecutionError(
            "binding",
            f"模型插件 {plugin.id} 的 {normalized_operation} 尚未接入执行",
            retryable=False,
        )
    runtime_config = runtime.implementation.prepare_config(
        copy.deepcopy(config),
        use_wallet=use_wallet or definition.kind == "model",
        workflow_kind=definition.kind,
    )
    version, generation = model_plugin_identity(plugin.id)
    return PreparedWorkflowRoute(
        snapshot=WorkflowRouteSnapshot(
            capability=capability,
            operation=normalized_operation,
            workflow_id=definition.id,
            workflow_key=definition.key,
            workflow_kind=definition.kind,
            plugin_id=plugin.id,
            plugin_version=version,
            plugin_generation=generation,
            runtime_generation=runtime.generation,
            source_id=definition.source_id,
        ),
        _workflow=definition,
        _config=runtime_config,
        _provider=runtime.implementation,
    )


def _client(base_url: str, timeout: float = 180.0) -> httpx.AsyncClient:
    return routed_http_client(
        timeout=httpx.Timeout(connect=20.0, read=timeout, write=180.0, pool=20.0),
        follow_redirects=True,
    )


def _runtime_config(
    provider: str,
    config: dict[str, Any],
    *,
    use_wallet: bool = False,
) -> dict[str, Any]:
    """把一次执行真正使用的 Key 固定到运行时配置。

    RunningHub 素材上传、提交和轮询必须使用同一把 Key；否则同时配了
    API Key 和余额 Key 时，素材会被上传到错的账户上下文。
    """
    runtime = dict(config)
    if provider != "runninghub":
        return runtime
    api_key = str(
        (config.get("wallet_api_key") if use_wallet else None) or config.get("api_key") or ""
    ).strip()
    if not api_key:
        raise WorkflowExecutionError("auth", "RunningHub API Key 未配置", retryable=False)
    runtime["api_key"] = api_key
    return runtime


def resume_handle(
    provider: str,
    provider_task_id: str,
    config: dict[str, Any],
    *,
    use_wallet: bool = False,
    workflow_key: str | None = None,
    source_id: str | None = None,
    workflow_kind: str | None = None,
) -> WorkflowHandle:
    """用已持久化的上游任务 ID 恢复轮询，绝不重复提交。"""
    prepared = prepare_workflow_route(
        provider,
        config,
        use_wallet=use_wallet,
        workflow_key=workflow_key,
        source_id=source_id,
        workflow_kind=workflow_kind,
    )
    return prepared.resume(provider_task_id)


def _http_error(provider: str, response: httpx.Response) -> WorkflowExecutionError:
    detail = response.text[:500]
    try:
        payload = response.json()
        if isinstance(payload, dict):
            error = payload.get("error")
            if isinstance(error, dict):
                detail = str(error.get("message") or error.get("details") or detail)
            else:
                detail = str(payload.get("message") or payload.get("msg") or detail)
    except ValueError:
        pass
    if response.status_code in (401, 403):
        return WorkflowExecutionError(
            "auth",
            f"{provider} 鉴权失败（HTTP {response.status_code}）：{detail}",
            retryable=False,
        )
    if response.status_code == 400:
        return WorkflowExecutionError(
            "input", f"{provider} 拒绝了工作流：{detail}", retryable=False
        )
    return WorkflowExecutionError("api", f"{provider} 返回 HTTP {response.status_code}：{detail}")


def _fields(ui_schema: dict | None) -> list[dict[str, Any]]:
    raw = (ui_schema or {}).get("fields") or []
    return [dict(item) for item in raw if isinstance(item, dict)]


def _field_id(field: dict[str, Any]) -> str:
    node = field.get("node") or field.get("nodeId")
    input_name = field.get("input") or field.get("fieldName")
    return str(field.get("id") or f"{node}::{input_name}")


def _field_value(field: dict[str, Any], values: dict[str, Any]) -> Any:
    field_id = _field_id(field)
    if field_id in values:
        return values[field_id]
    if "default" in field:
        return field.get("default")
    return field.get("fieldValue")


def validate_run_values(ui_schema: dict | None, values: dict[str, Any]) -> None:
    allowed = {_field_id(field) for field in _fields(ui_schema)}
    unknown = sorted(str(key) for key in values if str(key) not in allowed)
    if unknown:
        raise WorkflowExecutionError(
            "input", f"包含未定义的工作流参数：{', '.join(unknown[:5])}", retryable=False
        )


def apply_comfy_fields(
    payload: dict[str, Any],
    ui_schema: dict | None,
    values: dict[str, Any],
) -> dict[str, Any]:
    validate_run_values(ui_schema, values)
    workflow = copy.deepcopy(payload)
    for field in _fields(ui_schema):
        field_id = _field_id(field)
        if field_id not in values:
            continue
        if str(field.get("type") or "").lower() == "minimax_refs":
            _apply_minimax_references(workflow, values[field_id])
            continue
        node_id = str(field.get("node") or field.get("nodeId") or "")
        input_name = str(field.get("input") or field.get("fieldName") or "")
        node = workflow.get(node_id)
        if not node_id or not input_name or not isinstance(node, dict):
            raise WorkflowExecutionError(
                "input", f"参数 {field_id} 指向了不存在的 ComfyUI 节点", retryable=False
            )
        inputs = node.setdefault("inputs", {})
        if not isinstance(inputs, dict):
            raise WorkflowExecutionError(
                "input", f"ComfyUI 节点 {node_id} 的 inputs 不是对象", retryable=False
            )
        inputs[input_name] = values[field_id]
    return workflow


def _apply_minimax_references(workflow: dict[str, Any], value: Any) -> None:
    """把已上传的多模态参考动态接入 MiniMax H3 节点。

    这部分不能表达成普通 UI field：每多一段视频都要同时增加
    LoadVideo + GetVideoComponents 两个 ComfyUI 节点。
    """
    if not isinstance(value, list):
        raise WorkflowExecutionError("input", "MiniMax 多模态参考必须是数组", retryable=False)
    target = workflow.get("136")
    inputs = target.get("inputs") if isinstance(target, dict) else None
    if not isinstance(inputs, dict):
        raise WorkflowExecutionError(
            "input", "MiniMax H3 工作流缺少参考输入节点 136", retryable=False
        )
    limits = {"image": 9, "video": 3, "audio": 3}
    buckets: dict[str, list[str]] = {kind: [] for kind in limits}
    seen: set[tuple[str, str]] = set()
    for raw in value:
        if not isinstance(raw, dict):
            raise WorkflowExecutionError("input", "MiniMax 参考项必须是对象", retryable=False)
        kind = str(raw.get("kind") or "").strip().lower()
        remote = str(raw.get("remote") or "").strip()
        if kind not in limits or not remote:
            raise WorkflowExecutionError(
                "input", "MiniMax 参考类型或远程文件名无效", retryable=False
            )
        marker = (kind, remote)
        if marker in seen:
            continue
        seen.add(marker)
        buckets[kind].append(remote)
    for kind, items in buckets.items():
        if len(items) > limits[kind]:
            label = {"image": "张参考图", "video": "段参考视频", "audio": "段参考音频"}[kind]
            raise WorkflowExecutionError(
                "input", f"MiniMax H3 最多支持 {limits[kind]} {label}", retryable=False
            )
    for index in range(limits["image"]):
        inputs[f"ref_images.ref_image_{index}"] = None
    for index in range(limits["video"]):
        inputs[f"ref_videos.ref_video_{index}"] = None
    for index in range(limits["audio"]):
        inputs[f"ref_audios.ref_audio_{index}"] = None
    for index, remote in enumerate(buckets["image"]):
        node_id = str(9000 + index)
        workflow[node_id] = {
            "class_type": "LoadImage",
            "inputs": {"image": remote},
            "_meta": {"title": f"MiniMax image {index + 1}"},
        }
        inputs[f"ref_images.ref_image_{index}"] = [node_id, 0]
    for index, remote in enumerate(buckets["video"]):
        load_id = str(9040 + index)
        components_id = str(9050 + index)
        workflow[load_id] = {
            "class_type": "LoadVideo",
            "inputs": {"file": remote},
            "_meta": {"title": f"MiniMax video {index + 1}"},
        }
        workflow[components_id] = {
            "class_type": "GetVideoComponents",
            "inputs": {"video": [load_id, 0]},
            "_meta": {"title": f"MiniMax video frames {index + 1}"},
        }
        inputs[f"ref_videos.ref_video_{index}"] = [components_id, 0]
    for index, remote in enumerate(buckets["audio"]):
        node_id = str(9060 + index)
        workflow[node_id] = {
            "class_type": "LoadAudio",
            "inputs": {"audio": remote},
            "_meta": {"title": f"MiniMax audio {index + 1}"},
        }
        inputs[f"ref_audios.ref_audio_{index}"] = [node_id, 0]


def runninghub_node_info(
    ui_schema: dict | None,
    values: dict[str, Any],
) -> list[dict[str, Any]]:
    validate_run_values(ui_schema, values)
    items: list[dict[str, Any]] = []
    for field in _fields(ui_schema):
        if field.get("enabled") is False and _field_id(field) not in values:
            continue
        node_id = str(field.get("nodeId") or field.get("node") or "")
        field_name = str(field.get("fieldName") or field.get("input") or "")
        if not node_id or not field_name:
            continue
        value = _runninghub_field_value(field, values)
        if field.get("required") is True and value in (None, "", []):
            raise WorkflowExecutionError(
                "input",
                f"RunningHub 必填参数为空：{field.get('label') or field_name}",
                retryable=False,
            )
        if value is None or (_runninghub_image_field(field) and value in ("", [])):
            continue
        items.append({"nodeId": node_id, "fieldName": field_name, "fieldValue": value})
    return items


def _runninghub_image_field(field: dict[str, Any]) -> bool:
    field_type = str(field.get("type") or field.get("fieldType") or "").lower()
    return "image" in field_type or "图片" in field_type


def _runninghub_field_key(field: dict[str, Any]) -> str:
    node_id = str(field.get("nodeId") or field.get("node") or "")
    field_name = str(field.get("fieldName") or field.get("input") or "")
    return f"{node_id}::{field_name}"


def runninghub_pruned_workflow(
    workflow: StudioWorkflow | WorkflowDefinition,
    node_info: list[dict[str, Any]],
) -> dict[str, Any] | None:
    """按源端规则裁掉未填写的可选图片槽位及其空节点。

    RunningHub 的部分工作流即使 ``nodeInfoList`` 不提交空图片字段，远端仍会执行
    原 workflow JSON 中的空 LoadImage 节点。只有目录明确启用 ``prune-workflow``
    时才发送裁剪副本；保存的定义始终保持不变。
    """

    schema = workflow.ui_schema or {}
    if str(schema.get("optionalImageMode") or "prune-workflow") != "prune-workflow":
        return None
    submitted = {
        f"{str(item.get('nodeId') or '')}::{str(item.get('fieldName') or '')}"
        for item in node_info
    }
    missing = [
        field
        for field in _fields(schema)
        if field.get("enabled") is not False
        and _runninghub_image_field(field)
        and field.get("required") is not True
        and _runninghub_field_key(field) not in submitted
    ]
    if not missing:
        return None
    payload = workflow.payload or {}
    raw = payload.get("workflow_json")
    if not isinstance(raw, dict) or not raw:
        return None
    pruned = copy.deepcopy(raw)
    remove_ids: set[str] = set()
    for field in missing:
        node_id = str(field.get("nodeId") or field.get("node") or "")
        field_name = str(field.get("fieldName") or field.get("input") or "")
        node = pruned.get(node_id)
        inputs = node.get("inputs") if isinstance(node, dict) else None
        if not isinstance(inputs, dict) or field_name not in inputs:
            continue
        del inputs[field_name]
        if not inputs:
            remove_ids.add(node_id)
    for node_id in remove_ids:
        pruned.pop(node_id, None)
    if remove_ids:
        for node in pruned.values():
            if not isinstance(node, dict) or not isinstance(node.get("inputs"), dict):
                continue
            for name, value in list(node["inputs"].items()):
                if isinstance(value, list) and value and str(value[0]) in remove_ids:
                    del node["inputs"][name]
    return pruned


def _runninghub_field_value(field: dict[str, Any], values: dict[str, Any]) -> Any:
    field_id = _field_id(field)
    if field_id in values:
        return values[field_id]
    if field.get("random_enabled") is not True:
        return _field_value(field, values)
    label = f"{field.get('fieldName') or ''} {field.get('label') or ''}".lower()
    seed_like = "seed" in label or "随机" in label or "种子" in label

    def number(name: str, fallback: float) -> float:
        try:
            raw = field.get(name)
            return fallback if raw in (None, "") else float(raw)
        except (TypeError, ValueError):
            return fallback

    minimum = number("min", 0.0)
    maximum = number("max", 4_294_967_295.0 if seed_like else 999_999.0)
    if maximum < minimum:
        minimum, maximum = maximum, minimum
    if seed_like:
        minimum = max(0.0, minimum)
        maximum = min(4_294_967_295.0, maximum)
    step = max(number("step", 1.0), 0.000001)
    value = minimum + round((random.uniform(minimum, maximum) - minimum) / step) * step
    if all(float(item).is_integer() for item in (minimum, maximum, step)):
        return int(round(value))
    return value


def _asset_reference(value: Any) -> int | None:
    match = re.fullmatch(r"asset:(\d+)", str(value or "").strip(), re.I)
    return int(match.group(1)) if match else None


def _media_reference(value: Any) -> int | None:
    match = re.fullmatch(r"media:(\d+)", str(value or "").strip(), re.I)
    return int(match.group(1)) if match else None


async def _upload_blob(
    *,
    provider: str,
    config: dict[str, Any],
    filename: str,
    data: bytes,
    mime: str,
    runninghub_model_api: bool = False,
) -> str:
    base = workflow_base(config, provider)
    if provider == "comfyui":
        endpoint = f"{base}/upload/image"
        form = {"overwrite": "true", "type": "input"}
        key = "image"
    elif runninghub_model_api:
        root = base.removesuffix("/openapi/v2")
        endpoint = f"{root}/openapi/v2/media/upload/binary"
        form = {}
        key = "file"
    else:
        root = base.removesuffix("/openapi/v2")
        endpoint = f"{root}/task/openapi/upload"
        api_key = str(config.get("wallet_api_key") or config.get("api_key") or "")
        form = {"apiKey": api_key, "fileType": "input"}
        key = "file"
    async with _client(base) as client:
        response = await client.post(
            endpoint,
            headers=workflow_headers(config),
            data=form,
            files={key: (filename, data, mime)},
        )
    if response.status_code >= 400:
        raise _http_error(provider, response)
    try:
        payload = response.json()
    except ValueError as exc:
        raise WorkflowExecutionError("api", f"{provider} 素材上传返回非 JSON") from exc
    if provider == "comfyui":
        remote = payload.get("name") if isinstance(payload, dict) else None
    elif runninghub_model_api:
        body = payload.get("data") if isinstance(payload, dict) else None
        candidates = [payload, body] if isinstance(body, dict) else [payload]
        remote = next(
            (
                item.get("download_url")
                or item.get("downloadUrl")
                or item.get("url")
                or item.get("fileUrl")
                for item in candidates
                if isinstance(item, dict)
                and (
                    item.get("download_url")
                    or item.get("downloadUrl")
                    or item.get("url")
                    or item.get("fileUrl")
                )
            ),
            None,
        )
    else:
        body = payload.get("data") if isinstance(payload, dict) else None
        remote = body.get("fileName") if isinstance(body, dict) else None
    if not remote:
        raise WorkflowExecutionError("api", f"{provider} 素材上传没有返回文件名")
    return str(remote)


async def _upload_asset(
    session: AsyncSession,
    *,
    provider: str,
    config: dict[str, Any],
    asset_id: int,
    runninghub_model_api: bool = False,
) -> str:
    row = await session.get(ImageAsset, asset_id)
    if row is None:
        raise WorkflowExecutionError("input", f"图片资产不存在：{asset_id}", retryable=False)
    data = await get_storage().read(row.storage_key)
    extension = mimetypes.guess_extension(row.mime) or ".png"
    filename = f"asset-{row.id}{extension}"
    return await _upload_blob(
        provider=provider,
        config=config,
        filename=filename,
        data=data,
        mime=row.mime,
        runninghub_model_api=runninghub_model_api,
    )


async def _upload_media_asset(
    session: AsyncSession,
    *,
    provider: str,
    config: dict[str, Any],
    media_id: int,
    expected_kind: str,
    runninghub_model_api: bool = False,
) -> str:
    row = await session.get(StudioMediaAsset, media_id)
    if row is None:
        raise WorkflowExecutionError("input", f"媒体资产不存在：{media_id}", retryable=False)
    if expected_kind != "file" and row.kind != expected_kind:
        raise WorkflowExecutionError(
            "input",
            f"参数需要 {expected_kind}，媒体 {media_id} 实际是 {row.kind}",
            retryable=False,
        )
    data = await get_storage().read(row.storage_key)
    return await _upload_blob(
        provider=provider,
        config=config,
        filename=row.name or f"media-{row.id}",
        data=data,
        mime=row.mime,
        runninghub_model_api=runninghub_model_api,
    )


async def resolve_media_values(
    session: AsyncSession,
    *,
    provider: str,
    config: dict[str, Any],
    ui_schema: dict | None,
    values: dict[str, Any],
    runninghub_model_api: bool = False,
) -> dict[str, Any]:
    resolved = dict(values)
    image_uploads: dict[int, str] = {}
    media_uploads: dict[tuple[str, int], str] = {}

    async def image_remote(asset_id: int) -> str:
        remote = image_uploads.get(asset_id)
        if remote is None:
            remote = await _upload_asset(
                session,
                provider=provider,
                config=config,
                asset_id=asset_id,
                runninghub_model_api=runninghub_model_api,
            )
            image_uploads[asset_id] = remote
        return remote

    async def media_remote(media_id: int, expected_kind: str) -> str:
        marker = (expected_kind, media_id)
        remote = media_uploads.get(marker)
        if remote is None:
            remote = await _upload_media_asset(
                session,
                provider=provider,
                config=config,
                media_id=media_id,
                expected_kind=expected_kind,
                runninghub_model_api=runninghub_model_api,
            )
            media_uploads[marker] = remote
        return remote

    for field in _fields(ui_schema):
        field_id = _field_id(field)
        if field_id not in resolved:
            continue
        field_type = str(field.get("type") or field.get("fieldType") or "").lower()
        if field_type == "minimax_refs":
            raw_items = resolved[field_id]
            if not isinstance(raw_items, list):
                raise WorkflowExecutionError(
                    "input", f"MiniMax 参考参数 {field_id} 必须是数组", retryable=False
                )
            uploaded: list[dict[str, str]] = []
            seen: set[tuple[str, str]] = set()
            for raw_item in raw_items:
                if not isinstance(raw_item, dict):
                    raise WorkflowExecutionError(
                        "input", "MiniMax 参考项必须是对象", retryable=False
                    )
                kind = str(raw_item.get("kind") or "").strip().lower()
                reference = str(raw_item.get("ref") or "").strip()
                marker = (kind, reference)
                if marker in seen:
                    continue
                seen.add(marker)
                asset_id = _asset_reference(reference)
                media_id = _media_reference(reference)
                if kind == "image" and asset_id is not None:
                    remote = await image_remote(asset_id)
                elif kind in {"video", "audio"} and media_id is not None:
                    remote = await media_remote(media_id, kind)
                else:
                    raise WorkflowExecutionError(
                        "input",
                        f"MiniMax {kind or '未知'} 参考与 {reference or '空值'} 不匹配",
                        retryable=False,
                    )
                uploaded.append({"kind": kind, "remote": remote})
            resolved[field_id] = uploaded
            continue
        if field_type == "timeline":
            try:
                timeline = (
                    json.loads(resolved[field_id])
                    if isinstance(resolved[field_id], str)
                    else copy.deepcopy(resolved[field_id])
                )
            except (json.JSONDecodeError, TypeError) as exc:
                raise WorkflowExecutionError(
                    "input", f"时间轴参数 {field_id} 不是有效 JSON", retryable=False
                ) from exc
            if not isinstance(timeline, dict):
                raise WorkflowExecutionError(
                    "input", f"时间轴参数 {field_id} 必须是对象", retryable=False
                )
            segments = timeline.get("segments")
            if isinstance(segments, list):
                for segment in segments:
                    if not isinstance(segment, dict):
                        continue
                    raw_asset_id = segment.get("asset_id", segment.get("image_asset_id"))
                    try:
                        asset_id = int(raw_asset_id) if raw_asset_id is not None else None
                    except (TypeError, ValueError):
                        asset_id = None
                    if asset_id is None:
                        image_ref = _asset_reference(segment.get("image_ref"))
                        asset_id = image_ref
                    if asset_id is None:
                        continue
                    remote = await image_remote(asset_id)
                    segment["imageFile"] = remote
                    segment["type"] = "image"
                    segment.pop("asset_id", None)
                    segment.pop("image_asset_id", None)
                    segment.pop("image_ref", None)
            audio_segments = timeline.get("audioSegments", timeline.get("audio_segments"))
            if isinstance(audio_segments, list):
                for segment in audio_segments:
                    if not isinstance(segment, dict):
                        continue
                    raw_media_id = segment.get("media_asset_id")
                    try:
                        media_id = int(raw_media_id) if raw_media_id is not None else None
                    except (TypeError, ValueError):
                        media_id = None
                    if media_id is None:
                        media_id = _media_reference(segment.get("audio_ref"))
                    if media_id is None:
                        continue
                    segment["audioFile"] = await media_remote(media_id, "audio")
                    segment["type"] = "audio"
                    segment.pop("media_asset_id", None)
                    segment.pop("audio_ref", None)
            resolved[field_id] = json.dumps(timeline, ensure_ascii=False, separators=(",", ":"))
            continue
        if field_type not in {"image", "video", "audio", "file"}:
            continue
        raw_value = resolved[field_id]
        asset_id = _asset_reference(raw_value)
        media_id = _media_reference(raw_value)
        if field_type == "image" and media_id is not None:
            raise WorkflowExecutionError(
                "input",
                f"图片参数 {field_id} 需要 asset:<图片ID>，不能使用 media:{media_id}",
                retryable=False,
            )
        if field_type != "image" and asset_id is not None:
            raise WorkflowExecutionError(
                "input",
                f"{field_type} 参数 {field_id} 需要 media:<媒体ID>，不能使用 asset:{asset_id}",
                retryable=False,
            )
        if field_type == "image" and asset_id is not None:
            resolved[field_id] = await image_remote(asset_id)
        elif field_type != "image" and media_id is not None:
            resolved[field_id] = await media_remote(media_id, field_type)
    return resolved


async def submit(
    session: AsyncSession,
    *,
    workflow: StudioWorkflow,
    config: dict[str, Any],
    values: dict[str, Any],
    use_wallet: bool = False,
    instance_type: str = "",
) -> WorkflowHandle:
    prepared = prepare_workflow_route(workflow, config, use_wallet=use_wallet)
    snapshot = prepared.snapshot
    model = snapshot.source_id or snapshot.workflow_key or None
    span = await ModelInvocationSpan(
        plugin_id=snapshot.plugin_id,
        plugin_version=snapshot.plugin_version,
        plugin_generation=snapshot.plugin_generation,
        runtime_generation=snapshot.runtime_generation,
        operation=snapshot.operation,
        capability=snapshot.capability,
        model=model,
        request={
            "phase": "submit",
            "workflow_id": snapshot.workflow_id,
            "workflow_key": snapshot.workflow_key,
            "workflow_kind": snapshot.workflow_kind,
            "fields": values,
            "use_wallet": use_wallet,
            "instance_type": instance_type,
            "route": snapshot.view(),
        },
    ).start()
    try:
        handle = await prepared.submit(
            session,
            values=values,
            instance_type=instance_type,
        )
    except BaseException as exc:
        status = "cancelled" if isinstance(exc, asyncio.CancelledError) else "failed"
        await span.fail(exc, status=status)
        raise
    await span.succeed(
        response={"provider_task_id": handle.provider_task_id},
        provider_request_id=handle.provider_task_id,
    )
    return handle


async def _submit_comfy(
    workflow: WorkflowDefinition,
    config: dict[str, Any],
    values: dict[str, Any],
) -> WorkflowHandle:
    base = workflow_base(config, "comfyui")
    body = {
        "prompt": apply_comfy_fields(workflow.payload or {}, workflow.ui_schema, values),
        "client_id": uuid.uuid4().hex,
    }
    try:
        async with _client(base) as client:
            response = await client.post(
                f"{base}/prompt", headers=workflow_headers(config, json_body=True), json=body
            )
    except httpx.TimeoutException as exc:
        raise WorkflowExecutionError("timeout", "ComfyUI 提交超时") from exc
    except httpx.HTTPError as exc:
        raise WorkflowExecutionError("connect", f"连不上 ComfyUI：{exc}") from exc
    if response.status_code >= 400:
        raise _http_error("ComfyUI", response)
    try:
        prompt_id = str(response.json().get("prompt_id") or "")
    except (ValueError, AttributeError) as exc:
        raise WorkflowExecutionError("api", "ComfyUI 提交结果不是有效 JSON") from exc
    if not prompt_id:
        raise WorkflowExecutionError("api", "ComfyUI 没有返回 prompt_id")
    return WorkflowHandle(
        "comfyui",
        prompt_id,
        base,
        config,
        workflow.key,
        str(workflow.source_id or workflow.key or "").strip() or None,
    )


async def _submit_runninghub(
    workflow: WorkflowDefinition,
    config: dict[str, Any],
    values: dict[str, Any],
    *,
    use_wallet: bool,
    instance_type: str = "",
) -> WorkflowHandle:
    base = workflow_base(config, "runninghub").removesuffix("/openapi/v2")
    api_key = str(
        (config.get("wallet_api_key") if use_wallet else None) or config.get("api_key") or ""
    ).strip()
    if not api_key:
        raise WorkflowExecutionError("auth", "RunningHub API Key 未配置", retryable=False)
    source_id = str(workflow.source_id or (workflow.payload or {}).get("id") or "").strip()
    if not source_id:
        raise WorkflowExecutionError("input", "RunningHub 工作流 ID 为空", retryable=False)
    if workflow.kind == "model":
        validate_run_values(workflow.ui_schema, values)
        endpoint_path = (
            str((workflow.payload or {}).get("endpoint") or source_id).strip().strip("/")
        )
        endpoint_path = endpoint_path.removeprefix("openapi/v2/")
        endpoint = f"{base}/openapi/v2/{endpoint_path}"
        body = {}
        for field in _fields(workflow.ui_schema):
            if field.get("enabled") is False and _field_id(field) not in values:
                continue
            name = str(
                field.get("fieldName") or field.get("fieldKey") or field.get("id") or ""
            ).strip()
            if not name:
                continue
            value = _runninghub_field_value(field, values)
            if field.get("required") is True and value in (None, "", []):
                raise WorkflowExecutionError(
                    "input",
                    f"RunningHub 必填参数为空：{field.get('label') or name}",
                    retryable=False,
                )
            if value is not None and value != "":
                body[name] = value
    elif workflow.kind == "app":
        info = runninghub_node_info(workflow.ui_schema, values)
        endpoint = f"{base}/task/openapi/ai-app/run"
        body = {
            "apiKey": api_key,
            "webappId": source_id,
            "nodeInfoList": info,
            "instanceType": "plus" if instance_type == "plus" else "default",
        }
    else:
        info = runninghub_node_info(workflow.ui_schema, values)
        endpoint = f"{base}/task/openapi/create"
        body = {
            "apiKey": api_key,
            "workflowId": source_id,
            "nodeInfoList": info,
            "addMetadata": True,
        }
        pruned_workflow = runninghub_pruned_workflow(workflow, info)
        if pruned_workflow is not None:
            body["workflow"] = pruned_workflow
    try:
        async with _client(base) as client:
            response = await client.post(
                endpoint,
                headers=workflow_headers({**config, "api_key": api_key}, json_body=True),
                json=body,
            )
    except httpx.TimeoutException as exc:
        raise WorkflowExecutionError("timeout", "RunningHub 提交超时") from exc
    except httpx.HTTPError as exc:
        raise WorkflowExecutionError("connect", f"连不上 RunningHub：{exc}") from exc
    if response.status_code >= 400:
        raise _http_error("RunningHub", response)
    try:
        payload = response.json()
    except ValueError as exc:
        raise WorkflowExecutionError("api", "RunningHub 提交结果不是 JSON") from exc
    code = payload.get("code") if isinstance(payload, dict) else None
    data = payload.get("data") if isinstance(payload, dict) else None
    task_id = str(
        (payload.get("taskId") if isinstance(payload, dict) else None)
        or (data.get("taskId") if isinstance(data, dict) else None)
        or ""
    )
    if (workflow.kind != "model" and code not in (0, "0", None)) or not task_id:
        message = payload.get("msg") if isinstance(payload, dict) else payload
        raise WorkflowExecutionError("api", f"RunningHub 提交失败：{message or payload}")
    saved_config = {**config, "api_key": api_key}
    return WorkflowHandle(
        "runninghub",
        task_id,
        base,
        saved_config,
        workflow.key,
        source_id,
        workflow.kind,
    )


async def wait_for_outputs(handle: WorkflowHandle) -> list[WorkflowOutput]:
    snapshot = handle.snapshot
    provider = handle._provider
    if snapshot is None or provider is None:
        raise WorkflowExecutionError(
            "binding", "工作流任务未绑定 Provider 运行时", retryable=False
        )
    span = await ModelInvocationSpan(
        plugin_id=snapshot.plugin_id,
        plugin_version=snapshot.plugin_version,
        plugin_generation=snapshot.plugin_generation,
        runtime_generation=snapshot.runtime_generation,
        operation=snapshot.operation,
        capability=snapshot.capability,
        model=snapshot.source_id or snapshot.workflow_key,
        request={
            "phase": "wait",
            "provider_task_id": handle.provider_task_id,
            "workflow_key": handle.workflow_key,
            "route": snapshot.view(),
        },
    ).start()
    try:
        outputs = await provider.wait(handle)
    except BaseException as exc:
        status = "cancelled" if isinstance(exc, asyncio.CancelledError) else "failed"
        await span.fail(exc, status=status)
        raise
    await span.succeed(
        response={
            "provider_task_id": handle.provider_task_id,
            "outputs": [
                {
                    "name": output.name,
                    "mime": output.mime,
                    "kind": output.kind,
                    "bytes": len(output.data),
                    "source_url": output.source_url,
                }
                for output in outputs
            ],
        },
        provider_request_id=handle.provider_task_id,
    )
    return outputs


async def _wait_comfy(handle: WorkflowHandle) -> list[WorkflowOutput]:
    deadline = asyncio.get_running_loop().time() + WORKFLOW_TIMEOUT_S
    while asyncio.get_running_loop().time() < deadline:
        try:
            async with _client(handle.base_url, timeout=60.0) as client:
                response = await client.get(
                    f"{handle.base_url}/history/{handle.provider_task_id}",
                    headers=workflow_headers(handle.credential_config),
                )
            if response.status_code >= 400:
                raise _http_error("ComfyUI", response)
            payload = response.json()
        except WorkflowExecutionError:
            raise
        except (httpx.HTTPError, ValueError) as exc:
            raise WorkflowExecutionError("connect", f"ComfyUI 轮询失败：{exc}") from exc
        history = payload.get(handle.provider_task_id) if isinstance(payload, dict) else None
        if isinstance(history, dict):
            status = history.get("status") or {}
            if isinstance(status, dict) and status.get("status_str") == "error":
                raise WorkflowExecutionError("provider_failed", f"ComfyUI 工作流失败：{status}")
            outputs = await _download_comfy_outputs(handle, history.get("outputs") or {})
            if outputs:
                return outputs
        await asyncio.sleep(POLL_INTERVAL_S)
    raise WorkflowExecutionError("timeout", "ComfyUI 工作流运行超过 1 小时")


def _kind_for(name: str, mime: str) -> str:
    mime = (mime or "").split(";", 1)[0].lower()
    suffix = PurePosixPath(name).suffix.lower()
    if mime.startswith("image/") or suffix in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
        return "image"
    if mime.startswith("video/") or suffix in {".mp4", ".webm", ".mov", ".mkv"}:
        return "video"
    if mime.startswith("audio/") or suffix in {".mp3", ".wav", ".m4a", ".ogg", ".flac"}:
        return "audio"
    if mime.startswith("text/") or suffix in {".txt", ".json", ".csv", ".srt", ".vtt"}:
        return "text"
    return "file"


async def _read_limited(response: httpx.Response) -> bytes:
    chunks: list[bytes] = []
    total = 0
    async for chunk in response.aiter_bytes():
        total += len(chunk)
        if total > MAX_OUTPUT_BYTES:
            raise WorkflowExecutionError("api", "单个工作流输出超过 512MB 上限")
        chunks.append(chunk)
    return b"".join(chunks)


async def _download_comfy_outputs(
    handle: WorkflowHandle,
    outputs: dict[str, Any],
) -> list[WorkflowOutput]:
    candidates: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    for node_output in outputs.values() if isinstance(outputs, dict) else []:
        if not isinstance(node_output, dict):
            continue
        for value in node_output.values():
            for item in value if isinstance(value, list) else [value]:
                if not isinstance(item, dict) or not item.get("filename"):
                    continue
                marker = (
                    str(item.get("filename")),
                    str(item.get("subfolder") or ""),
                    str(item.get("type") or "output"),
                )
                if marker not in seen:
                    seen.add(marker)
                    candidates.append(item)
    results: list[WorkflowOutput] = []
    async with _client(handle.base_url, timeout=300.0) as client:
        for item in candidates:
            response = await client.get(
                f"{handle.base_url}/view",
                params={
                    "filename": item["filename"],
                    "subfolder": item.get("subfolder") or "",
                    "type": item.get("type") or "output",
                },
                headers=workflow_headers(handle.credential_config),
            )
            if response.status_code >= 400:
                raise _http_error("ComfyUI", response)
            name = str(item["filename"])
            mime = (
                response.headers.get("content-type")
                or mimetypes.guess_type(name)[0]
                or "application/octet-stream"
            )
            results.append(
                WorkflowOutput(name, mime, _kind_for(name, mime), await _read_limited(response))
            )
    return results


def _runninghub_urls(value: Any) -> list[str]:
    urls: list[str] = []
    if isinstance(value, str) and value.startswith(("http://", "https://")):
        return [value]
    if isinstance(value, list):
        for child in value:
            urls.extend(_runninghub_urls(child))
    elif isinstance(value, dict):
        for key, child in value.items():
            if key.lower() in {
                "url",
                "fileurl",
                "file_url",
                "download_url",
                "imageurl",
                "image_url",
                "videourl",
                "video_url",
                "outputs",
                "results",
                "data",
                "result",
            }:
                urls.extend(_runninghub_urls(child))
    return list(dict.fromkeys(urls))


async def _wait_runninghub(handle: WorkflowHandle) -> list[WorkflowOutput]:
    deadline = asyncio.get_running_loop().time() + WORKFLOW_TIMEOUT_S
    model_api = handle.workflow_kind == "model"
    endpoint = (
        f"{handle.base_url}/openapi/v2/query"
        if model_api
        else f"{handle.base_url}/task/openapi/outputs"
    )
    api_key = str(handle.credential_config.get("api_key") or "")
    while asyncio.get_running_loop().time() < deadline:
        try:
            async with _client(handle.base_url, timeout=240.0) as client:
                response = await client.post(
                    endpoint,
                    headers=workflow_headers(handle.credential_config, json_body=True),
                    json=(
                        {"taskId": handle.provider_task_id}
                        if model_api
                        else {"apiKey": api_key, "taskId": handle.provider_task_id}
                    ),
                )
            if response.status_code >= 400:
                raise _http_error("RunningHub", response)
            payload = response.json()
        except WorkflowExecutionError:
            raise
        except (httpx.HTTPError, ValueError) as exc:
            raise WorkflowExecutionError("connect", f"RunningHub 轮询失败：{exc}") from exc
        code = payload.get("code") if isinstance(payload, dict) else None
        status = str(
            (payload.get("status") if isinstance(payload, dict) else "") or ""
        ).upper()
        if code in (805, "805") or status in {
            "FAILED",
            "FAIL",
            "ERROR",
            "CANCELLED",
            "CANCELED",
        }:
            message = payload.get("msg") if isinstance(payload, dict) else payload
            raise WorkflowExecutionError(
                "provider_failed", f"RunningHub 任务失败：{message or payload}"
            )
        urls = _runninghub_urls(payload.get("data") if isinstance(payload, dict) else payload)
        if not urls:
            urls = _runninghub_urls(payload)
        succeeded = code in (0, "0") if not model_api else status in {
            "SUCCESS",
            "SUCCEEDED",
            "COMPLETED",
            "COMPLETE",
            "FINISHED",
            "DONE",
        }
        if succeeded and urls:
            return await _download_urls(handle, urls)
        if succeeded and not urls:
            raise WorkflowExecutionError("provider_failed", "RunningHub 任务成功但没有返回产物")
        await asyncio.sleep(POLL_INTERVAL_S)
    raise WorkflowExecutionError("timeout", "RunningHub 工作流运行超过 1 小时")


async def _download_urls(handle: WorkflowHandle, urls: list[str]) -> list[WorkflowOutput]:
    results: list[WorkflowOutput] = []
    async with _client(handle.base_url, timeout=300.0) as client:
        for index, url in enumerate(urls[:20]):
            response = await client.get(url, headers={"Accept": "*/*"})
            if response.status_code >= 400:
                raise _http_error("RunningHub 产物下载", response)
            name = PurePosixPath(urlparse(url).path).name or f"output-{index + 1}"
            mime = (
                response.headers.get("content-type")
                or mimetypes.guess_type(name)[0]
                or "application/octet-stream"
            )
            results.append(
                WorkflowOutput(
                    name,
                    mime,
                    _kind_for(name, mime),
                    await _read_limited(response),
                    source_url=url,
                )
            )
    return results


class _ComfyUIWorkflowProvider:
    def prepare_config(
        self,
        config: dict[str, Any],
        *,
        use_wallet: bool,
        workflow_kind: str | None,
    ) -> dict[str, Any]:
        del use_wallet, workflow_kind
        return dict(config)

    async def submit(
        self,
        route: PreparedWorkflowRoute,
        session: AsyncSession,
        *,
        values: dict[str, Any],
        instance_type: str,
    ) -> WorkflowHandle:
        del instance_type
        workflow = route._workflow
        resolved = await resolve_media_values(
            session,
            provider=workflow.provider,
            config=route._config,
            ui_schema=workflow.ui_schema,
            values=values,
        )
        return await _submit_comfy(workflow, route._config, resolved)

    def resume(
        self,
        route: PreparedWorkflowRoute,
        provider_task_id: str,
    ) -> WorkflowHandle:
        workflow = route._workflow
        return WorkflowHandle(
            workflow.provider,
            provider_task_id,
            workflow_base(route._config, workflow.provider),
            route._config,
            workflow.key,
            workflow.source_id,
            workflow.kind,
        )

    async def wait(self, handle: WorkflowHandle) -> list[WorkflowOutput]:
        return await _wait_comfy(handle)


class _RunningHubWorkflowProvider:
    def prepare_config(
        self,
        config: dict[str, Any],
        *,
        use_wallet: bool,
        workflow_kind: str | None,
    ) -> dict[str, Any]:
        return _runtime_config(
            "runninghub",
            config,
            use_wallet=use_wallet or workflow_kind == "model",
        )

    async def submit(
        self,
        route: PreparedWorkflowRoute,
        session: AsyncSession,
        *,
        values: dict[str, Any],
        instance_type: str,
    ) -> WorkflowHandle:
        workflow = route._workflow
        resolved = await resolve_media_values(
            session,
            provider=workflow.provider,
            config=route._config,
            ui_schema=workflow.ui_schema,
            values=values,
            runninghub_model_api=workflow.kind == "model",
        )
        return await _submit_runninghub(
            workflow,
            route._config,
            resolved,
            use_wallet=False,
            instance_type=instance_type,
        )

    def resume(
        self,
        route: PreparedWorkflowRoute,
        provider_task_id: str,
    ) -> WorkflowHandle:
        workflow = route._workflow
        return WorkflowHandle(
            workflow.provider,
            provider_task_id,
            workflow_base(route._config, workflow.provider).removesuffix("/openapi/v2"),
            route._config,
            workflow.key,
            workflow.source_id,
            workflow.kind,
        )

    async def wait(self, handle: WorkflowHandle) -> list[WorkflowOutput]:
        return await _wait_runninghub(handle)


def _register_builtin_workflow_providers() -> tuple[RegistrationHandle, ...]:
    return (
        register_workflow_route_provider(
            plugin_id="comfyui",
            provider=_ComfyUIWorkflowProvider(),
            operations={"workflow.run"},
        ),
        register_workflow_route_provider(
            plugin_id="runninghub",
            provider=_RunningHubWorkflowProvider(),
            operations={"workflow.run"},
        ),
    )


_BUILTIN_WORKFLOW_PROVIDER_HANDLES = _register_builtin_workflow_providers()
