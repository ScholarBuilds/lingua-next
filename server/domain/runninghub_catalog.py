"""RunningHub 在线目录、双 Key 诊断与可执行条目同步。

Model API、AI App 和 Workflow 的远端定义最终都落到 ``StudioWorkflow``；
凭据只从 ``ProviderCredential`` 解密后用于本次请求，绝不写进目录 JSON。
"""

from __future__ import annotations

import json
import re
import uuid
from typing import Any, Literal
from urllib.parse import quote

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from domain.credentials import decrypt_config, workflow_base, workflow_headers
from domain.models import ProviderCredential, StudioWorkflow
from domain.network_policy import routed_http_client
from domain.studio_workflows import StudioWorkflowError, _hash, validate_definition

RemoteKind = Literal["model", "app", "workflow"]


def normalize_source_id(value: str, kind: RemoteKind) -> str:
    text = str(value or "").strip()
    if kind in {"app", "workflow"}:
        match = re.search(r"/run/(?:ai-app|workflow)/([0-9A-Za-z_-]+)", text)
        if match:
            return match.group(1)
    return text


def _root(config: dict[str, Any]) -> str:
    return workflow_base(config, "runninghub").removesuffix("/openapi/v2")


def _key(config: dict[str, Any], *, wallet: bool) -> str:
    raw_value = config.get("wallet_api_key") if wallet else config.get("api_key")
    value = str(raw_value or "").strip()
    if not value:
        label = "账户余额 Key" if wallet else "积分 Key"
        raise StudioWorkflowError(f"RunningHub {label} 未配置")
    return value


async def credential_config(
    session: AsyncSession, credential_id: int
) -> tuple[ProviderCredential, dict[str, Any]]:
    row = await session.get(ProviderCredential, credential_id)
    if row is None or row.provider_type != "runninghub":
        raise StudioWorkflowError("RunningHub 凭据不存在", 404)
    if not row.enabled:
        raise StudioWorkflowError("RunningHub 凭据已停用", 409)
    return row, decrypt_config(row.config)


def _unwrap_items(payload: Any) -> list[dict[str, Any]]:
    queue = [payload]
    while queue:
        current = queue.pop(0)
        if isinstance(current, list):
            return [dict(item) for item in current if isinstance(item, dict)]
        if not isinstance(current, dict):
            continue
        for key in ("data", "models", "list", "items", "records", "result"):
            nested = current.get(key)
            if isinstance(nested, (dict, list)):
                queue.append(nested)
    return []


def normalize_model(raw: dict[str, Any]) -> dict[str, Any] | None:
    model_id = str(
        raw.get("name_en") or raw.get("id") or raw.get("name") or raw.get("endpoint") or ""
    ).strip()
    endpoint = str(raw.get("endpoint") or model_id).strip().strip("/")
    if not model_id or not endpoint:
        return None
    output = str(raw.get("output_type") or raw.get("outputType") or "").strip().lower()
    if output not in {"image", "video", "audio", "chat"}:
        output = "workflow"
    params = raw.get("params")
    return {
        "id": model_id,
        "endpoint": endpoint.removeprefix("openapi/v2/"),
        "title": str(
            raw.get("name_cn")
            or raw.get("display_name")
            or raw.get("displayName")
            or raw.get("title")
            or model_id
        ).strip(),
        "output_type": output,
        "params": [dict(item) for item in params if isinstance(item, dict)]
        if isinstance(params, list)
        else [],
    }


async def fetch_models(config: dict[str, Any]) -> list[dict[str, Any]]:
    """Model API 只接受 Enterprise-Shared（目标 UI 称账户余额）Key。"""
    root = _root(config)
    runtime = {**config, "api_key": _key(config, wallet=True)}
    async with routed_http_client(timeout=30.0, follow_redirects=True) as client:
        response = await client.get(
            f"{root}/openapi/v2/models", headers=workflow_headers(runtime)
        )
    if response.status_code in (401, 403):
        raise StudioWorkflowError(f"账户余额 Key 无效（HTTP {response.status_code}）", 401)
    if response.status_code >= 400:
        raise StudioWorkflowError(
            f"RunningHub 模型目录返回 HTTP {response.status_code}：{response.text[:240]}",
            502,
        )
    try:
        raw_items = _unwrap_items(response.json())
    except ValueError as exc:
        raise StudioWorkflowError("RunningHub 模型目录返回非 JSON", 502) from exc
    items = [item for raw in raw_items if (item := normalize_model(raw)) is not None]
    if not items:
        raise StudioWorkflowError("RunningHub 模型目录为空", 502)
    return sorted(items, key=lambda item: (item["output_type"], item["title"].lower()))


def _field_options(field: dict[str, Any]) -> list[str]:
    for key in (
        "options",
        "optionList",
        "values",
        "enum",
        "choices",
        "items",
        "list",
        "selectOptions",
        "fieldData",
    ):
        value = field.get(key)
        if not isinstance(value, list):
            continue
        result = []
        for item in value:
            if isinstance(item, dict):
                item = item.get("value") or item.get("label") or item.get("name")
            if item not in (None, ""):
                result.append(str(item))
        if result:
            return result
    return []


def _field_type(name: str, value: Any, declared: Any = "") -> str:
    text = f"{name} {declared}".lower()
    declared_text = str(declared or "").strip().upper()
    if declared_text in {"IMAGE", "VIDEO", "AUDIO", "BOOLEAN", "NUMBER", "SELECT"}:
        return declared_text
    if re.search(r"image|img|mask|photo|picture", text):
        return "IMAGE"
    if re.search(r"video|movie", text):
        return "VIDEO"
    if re.search(r"audio|sound|music|voice", text):
        return "AUDIO"
    if isinstance(value, bool):
        return "BOOLEAN"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return "NUMBER"
    return "TEXT"


def normalize_field(raw: dict[str, Any], index: int = 0, *, node: str = "app") -> dict:
    name = str(
        raw.get("fieldName")
        or raw.get("fieldKey")
        or raw.get("inputName")
        or raw.get("name")
        or raw.get("key")
        or raw.get("paramName")
        or raw.get("id")
        or f"field_{index + 1}"
    ).strip()
    node_id = str(raw.get("nodeId") or raw.get("node_id") or raw.get("groupId") or node)
    value = raw.get("fieldValue")
    if value is None:
        value = raw.get("defaultValue", raw.get("value", raw.get("default", "")))
    if isinstance(value, (dict, list)):
        value = json.dumps(value, ensure_ascii=False)
    options = _field_options(raw)
    field_type = _field_type(
        name, value, raw.get("fieldType") or raw.get("type") or raw.get("valueType")
    )
    if options and field_type == "TEXT":
        field_type = "SELECT"
    return {
        "id": str(raw.get("id") or f"{node_id}::{name}"),
        "nodeId": node_id,
        "fieldName": name,
        "fieldValue": "" if value is None else value,
        "fieldType": field_type,
        "label": str(raw.get("label") or raw.get("title") or raw.get("name") or name),
        "enabled": bool(raw.get("enabled", True)),
        "group": str(raw.get("group") or raw.get("category") or ""),
        "note": str(raw.get("note") or raw.get("description") or ""),
        "options": options,
        "required": bool(raw.get("required", False)),
        "random_enabled": bool(raw.get("random_enabled", False)),
        "min": raw.get("min", ""),
        "max": raw.get("max", ""),
        "step": raw.get("step", ""),
        "imageOrder": int(raw.get("imageOrder") or raw.get("image_order") or 0),
    }


def _app_field_source(data: Any) -> list[dict[str, Any]]:
    if not isinstance(data, dict):
        return []
    for path in (
        ("nodeInfoList",),
        ("fields",),
        ("inputs",),
        ("inputList",),
        ("formItems",),
        ("params",),
        ("parameters",),
        ("apiParams",),
        ("config", "fields"),
        ("webapp", "fields"),
        ("webapp", "inputs"),
    ):
        value: Any = data
        for key in path:
            value = value.get(key) if isinstance(value, dict) else None
        if isinstance(value, list) and value:
            return [dict(item) for item in value if isinstance(item, dict)]
        if isinstance(value, dict) and value:
            return [
                {"fieldName": key, "fieldValue": child} for key, child in value.items()
            ]
    return []


async def fetch_app(config: dict[str, Any], app_id: str) -> dict[str, Any]:
    app_id = normalize_source_id(app_id, "app")
    if not app_id:
        raise StudioWorkflowError("webappId 必填")
    api_key = _key(config, wallet=False)
    root = _root(config)
    endpoint = (
        f"{root}/api/webapp/apiCallDemo?apiKey={quote(api_key, safe='')}"
        f"&webappId={quote(app_id, safe='')}"
    )
    async with routed_http_client(timeout=120.0, follow_redirects=True) as client:
        response = await client.get(endpoint, headers=workflow_headers(config))
    if response.status_code >= 400:
        raise StudioWorkflowError(
            f"RunningHub 应用参数返回 HTTP {response.status_code}：{response.text[:240]}",
            502,
        )
    try:
        payload = response.json()
    except ValueError as exc:
        raise StudioWorkflowError("RunningHub 应用参数返回非 JSON", 502) from exc
    if isinstance(payload, dict) and payload.get("code") not in (0, "0", None):
        raise StudioWorkflowError(str(payload.get("msg") or "RunningHub 应用参数拉取失败"), 502)
    data = payload.get("data") if isinstance(payload, dict) else {}
    data = data if isinstance(data, dict) else {}
    return {
        "kind": "app",
        "source_id": app_id,
        "title": str(data.get("name") or data.get("title") or f"AI 应用 {app_id[-6:]}").strip(),
        "description": str(data.get("description") or data.get("note") or "").strip(),
        "payload": {"id": app_id, "app_id": app_id, "type": "app"},
        "ui_schema": {
            "fields": [
                normalize_field(field, index)
                for index, field in enumerate(_app_field_source(data))
            ]
        },
    }


def collect_workflow_fields(workflow: Any) -> list[dict[str, Any]]:
    if not isinstance(workflow, dict):
        return []
    result = []
    for node_id, node in workflow.items():
        if not isinstance(node, dict) or not isinstance(node.get("inputs"), dict):
            continue
        group = str(
            (node.get("_meta") or {}).get("title")
            or node.get("class_type")
            or node.get("type")
            or ""
        )
        for field_name, value in node["inputs"].items():
            if (
                isinstance(value, list)
                and len(value) == 2
                and isinstance(value[0], str)
                and isinstance(value[1], int)
            ):
                continue
            field = normalize_field(
                {
                    "nodeId": str(node_id),
                    "fieldName": str(field_name),
                    "fieldValue": value,
                    "group": group,
                    "enabled": False,
                },
                len(result),
                node=str(node_id),
            )
            field["required"] = field["fieldType"] == "IMAGE"
            result.append(field)
    return result


async def fetch_workflow(config: dict[str, Any], workflow_id: str) -> dict[str, Any]:
    workflow_id = normalize_source_id(workflow_id, "workflow")
    if not workflow_id:
        raise StudioWorkflowError("workflowId 必填")
    api_key = _key(config, wallet=False)
    root = _root(config)
    runtime = {**config, "api_key": api_key}
    async with routed_http_client(timeout=180.0, follow_redirects=True) as client:
        response = await client.post(
            f"{root}/api/openapi/getJsonApiFormat",
            headers=workflow_headers(runtime, json_body=True),
            json={"apiKey": api_key, "workflowId": workflow_id},
        )
    if response.status_code >= 400:
        raise StudioWorkflowError(
            f"RunningHub 工作流参数返回 HTTP {response.status_code}：{response.text[:240]}",
            502,
        )
    try:
        raw = response.json()
    except ValueError as exc:
        raise StudioWorkflowError("RunningHub 工作流参数返回非 JSON", 502) from exc
    if not isinstance(raw, dict) or raw.get("code") not in (0, "0"):
        raise StudioWorkflowError(str(raw.get("msg") if isinstance(raw, dict) else raw), 502)
    data = raw.get("data") if isinstance(raw.get("data"), dict) else {}
    prompt = data.get("prompt")
    if isinstance(prompt, str):
        try:
            workflow_json = json.loads(prompt)
        except json.JSONDecodeError as exc:
            raise StudioWorkflowError("RunningHub 工作流 JSON 解析失败", 502) from exc
    else:
        workflow_json = prompt if isinstance(prompt, dict) else {}
    return {
        "kind": "workflow",
        "source_id": workflow_id,
        "title": str(data.get("name") or data.get("title") or f"工作流 {workflow_id[-6:]}").strip(),
        "description": str(data.get("description") or "").strip(),
        "payload": {
            "id": workflow_id,
            "workflow_id": workflow_id,
            "type": "workflow",
            "workflow_json": workflow_json,
        },
        "ui_schema": {
            "fields": collect_workflow_fields(workflow_json),
            "optionalImageMode": "prune-workflow",
        },
    }


def model_definition(item: dict[str, Any]) -> dict[str, Any]:
    fields = [
        normalize_field(param, index, node="model")
        for index, param in enumerate(item.get("params") or [])
        if isinstance(param, dict)
    ]
    return {
        "kind": "model",
        "source_id": str(item["id"]),
        "title": str(item.get("title") or item["id"]),
        "description": f"RunningHub Model API · {item.get('output_type') or 'workflow'}",
        "payload": {
            "id": str(item["id"]),
            "endpoint": str(item.get("endpoint") or item["id"]),
            "output_type": str(item.get("output_type") or "workflow"),
            "type": "model",
        },
        "ui_schema": {"fields": fields},
    }


async def remote_definition(
    config: dict[str, Any], kind: RemoteKind, source_id: str
) -> dict[str, Any]:
    if kind == "app":
        return await fetch_app(config, source_id)
    if kind == "workflow":
        return await fetch_workflow(config, source_id)
    source_id = normalize_source_id(source_id, "model")
    models = await fetch_models(config)
    item = next((item for item in models if item["id"] == source_id), None)
    if item is None:
        raise StudioWorkflowError("RunningHub 模型不在当前在线目录中", 404)
    return model_definition(item)


async def upsert_remote(
    session: AsyncSession,
    *,
    definition: dict[str, Any],
    title: str | None = None,
    description: str | None = None,
    ui_schema: dict[str, Any] | None = None,
) -> StudioWorkflow:
    kind = str(definition["kind"])
    source_id = str(definition["source_id"])
    payload = dict(definition["payload"])
    schema = dict(ui_schema if ui_schema is not None else definition["ui_schema"])
    if description is not None:
        payload["note"] = description.strip()
    validate_definition(payload, schema)
    key = f"runninghub:remote:{kind}:{source_id}"
    row = (
        await session.execute(select(StudioWorkflow).where(StudioWorkflow.key == key))
    ).scalar_one_or_none()
    values = {
        "title": (title or definition["title"] or source_id).strip(),
        "provider": "runninghub",
        "kind": kind,
        "source": "user",
        "source_id": source_id,
        "payload": payload,
        "ui_schema": schema,
        "content_hash": _hash(payload, schema),
        "enabled": True,
    }
    if row is None:
        row = StudioWorkflow(key=key or f"user:{uuid.uuid4().hex}", **values)
        session.add(row)
    else:
        for field, value in values.items():
            setattr(row, field, value)
    await session.commit()
    await session.refresh(row)
    return row


async def diagnostics(config: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {
        "points": {"configured": bool(str(config.get("api_key") or "").strip())},
        "wallet": {"configured": bool(str(config.get("wallet_api_key") or "").strip())},
    }
    if not result["wallet"]["configured"]:
        result["wallet"].update(
            ok=False,
            detail="未配置账户余额 Key；Model API 与 LLM API 不可用",
            model_count=0,
        )
        return result
    try:
        models = await fetch_models(config)
    except StudioWorkflowError as exc:
        result["wallet"].update(ok=False, detail=str(exc), model_count=0)
    else:
        result["wallet"].update(
            ok=True,
            detail=f"Enterprise-Shared Key 可用，发现 {len(models)} 个 Model API 模型",
            model_count=len(models),
        )
    result["points"].update(
        ok=None,
        detail=(
            "已配置；AI App/Workflow 会在拉取或执行时校验"
            if result["points"]["configured"]
            else "未配置；AI App/Workflow 需要积分 Key 或 Enterprise-Shared Key"
        ),
    )
    return result
