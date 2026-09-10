"""火山方舟私域素材 Assets API（签名 V4）。

Ark API Key 只负责生成；CreateAssetGroup/CreateAsset/GetAsset 使用独立 AK/SK。
本模块不持久化密钥，也不接受本地路径，避免把无法公网访问的 URL 交给上游。
"""

from __future__ import annotations

import hashlib
import hmac
import json
from datetime import UTC, datetime
from typing import Any
from urllib.parse import quote

import httpx

from domain.network_policy import routed_http_client

DEFAULT_HOST = "open.volcengineapi.com"
DEFAULT_SERVICE = "ark"
DEFAULT_REGION = "cn-beijing"
DEFAULT_VERSION = "2024-01-01"


class VolcengineAssetError(Exception):
    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind


def _hmac(key: bytes, message: str) -> bytes:
    return hmac.new(key, message.encode(), hashlib.sha256).digest()


def sign_v4_headers(
    access_key_id: str,
    secret_access_key: str,
    action: str,
    body: bytes,
    *,
    region: str = DEFAULT_REGION,
    service: str = DEFAULT_SERVICE,
    version: str = DEFAULT_VERSION,
    host: str = DEFAULT_HOST,
    x_date: str | None = None,
) -> dict[str, str]:
    """按火山 OpenAPI 通用签名规范构造 POST JSON 鉴权头。"""
    if not access_key_id or not secret_access_key:
        raise VolcengineAssetError("auth", "火山素材库 Access Key ID / Secret Access Key 未配置")
    request_date = x_date or datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    short_date = request_date[:8]
    payload_hash = hashlib.sha256(body).hexdigest()
    content_type = "application/json"
    canonical_query = f"Action={quote(action, safe='')}&Version={quote(version, safe='')}"
    canonical_headers = (
        f"content-type:{content_type}\n"
        f"host:{host}\n"
        f"x-content-sha256:{payload_hash}\n"
        f"x-date:{request_date}\n"
    )
    signed_headers = "content-type;host;x-content-sha256;x-date"
    canonical_request = "\n".join(
        [
            "POST",
            "/",
            canonical_query,
            canonical_headers,
            signed_headers,
            payload_hash,
        ]
    )
    algorithm = "HMAC-SHA256"
    scope = f"{short_date}/{region}/{service}/request"
    string_to_sign = "\n".join(
        [
            algorithm,
            request_date,
            scope,
            hashlib.sha256(canonical_request.encode()).hexdigest(),
        ]
    )
    signing_key = _hmac(
        _hmac(_hmac(_hmac(secret_access_key.encode(), short_date), region), service),
        "request",
    )
    signature = hmac.new(signing_key, string_to_sign.encode(), hashlib.sha256).hexdigest()
    return {
        "Content-Type": content_type,
        "Host": host,
        "X-Date": request_date,
        "X-Content-Sha256": payload_hash,
        "Authorization": (
            f"{algorithm} Credential={access_key_id}/{scope}, "
            f"SignedHeaders={signed_headers}, Signature={signature}"
        ),
    }


def _settings(config: dict[str, Any]) -> tuple[str, str, str, str, str]:
    access_key_id = str(config.get("access_key_id") or "").strip()
    secret_access_key = str(config.get("secret_access_key") or "").strip()
    project_name = str(config.get("project_name") or "default").strip() or "default"
    region = str(config.get("region") or DEFAULT_REGION).strip() or DEFAULT_REGION
    host = str(config.get("asset_api_host") or DEFAULT_HOST).strip() or DEFAULT_HOST
    if "/" in host or ":" in host:
        raise VolcengineAssetError("input", "asset_api_host 只能填写主机名")
    return access_key_id, secret_access_key, project_name, region, host


async def call(
    config: dict[str, Any],
    action: str,
    body: dict[str, Any],
    *,
    client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    access_key_id, secret_access_key, _project, region, host = _settings(config)
    encoded = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
    headers = sign_v4_headers(
        access_key_id,
        secret_access_key,
        action,
        encoded,
        region=region,
        host=host,
    )
    url = f"https://{host}/?Action={quote(action, safe='')}&Version={DEFAULT_VERSION}"
    owns_client = client is None
    active = client or routed_http_client(timeout=120.0, follow_redirects=True)
    try:
        response = await active.post(url, headers=headers, content=encoded)
    except httpx.TimeoutException as exc:
        raise VolcengineAssetError("timeout", f"火山 {action} 请求超时") from exc
    except httpx.HTTPError as exc:
        raise VolcengineAssetError("connect", f"火山 {action} 连接失败：{exc}") from exc
    finally:
        if owns_client:
            await active.aclose()
    try:
        payload = response.json()
    except ValueError as exc:
        raise VolcengineAssetError(
            "api", f"火山 {action} 返回非 JSON（HTTP {response.status_code}）"
        ) from exc
    metadata = payload.get("ResponseMetadata") if isinstance(payload, dict) else None
    error = metadata.get("Error") if isinstance(metadata, dict) else None
    if isinstance(error, dict):
        code = str(error.get("Code") or error.get("CodeN") or "")
        message = str(error.get("Message") or "")
        kind = "auth" if "AccessKey" in code or "Signature" in code else "api"
        raise VolcengineAssetError(kind, f"火山 {action} 失败：{code} {message}".strip())
    if response.status_code >= 400:
        raise VolcengineAssetError(
            "api", f"火山 {action} 返回 HTTP {response.status_code}：{response.text[:240]}"
        )
    result = payload.get("Result") if isinstance(payload, dict) else None
    return dict(result) if isinstance(result, dict) else dict(payload or {})


async def diagnostics(config: dict[str, Any]) -> dict[str, Any]:
    _ak, _sk, project_name, region, _host = _settings(config)
    result = await call(
        config,
        "ListAssetGroups",
        {
            "Filter": {"GroupType": "AIGC"},
            "PageNumber": 1,
            "PageSize": 1,
            "ProjectName": project_name,
        },
    )
    return {
        "ok": True,
        "project_name": project_name,
        "region": region,
        "group_count": int(result.get("TotalCount") or len(result.get("Items") or [])),
        "detail": "AK/SK 签名与 Ark 素材项目可用",
    }


async def ensure_group(
    config: dict[str, Any], group_name: str, *, client: httpx.AsyncClient
) -> str:
    _ak, _sk, project_name, _region, _host = _settings(config)
    name = (group_name or "可信素材").strip()[:60] or "可信素材"
    listed = await call(
        config,
        "ListAssetGroups",
        {
            "Filter": {"Name": name, "GroupType": "AIGC"},
            "PageNumber": 1,
            "PageSize": 10,
            "ProjectName": project_name,
        },
        client=client,
    )
    for item in listed.get("Items") or []:
        if not isinstance(item, dict):
            continue
        if str(item.get("Name") or "").strip() == name:
            group_id = str(item.get("Id") or "").strip()
            if group_id:
                return group_id
    created = await call(
        config,
        "CreateAssetGroup",
        {"Name": name, "Description": name, "ProjectName": project_name},
        client=client,
    )
    group_id = str(created.get("Id") or "").strip()
    if not group_id:
        raise VolcengineAssetError("api", "火山 CreateAssetGroup 未返回 Id")
    return group_id


async def create_asset(
    config: dict[str, Any],
    *,
    public_url: str,
    name: str,
    asset_type: str,
    group_name: str = "可信素材",
) -> dict[str, Any]:
    if not public_url.startswith(("http://", "https://")):
        raise VolcengineAssetError("input", "CreateAsset 只接受公网可访问的 http/https URL")
    if not asset_type.strip():
        raise VolcengineAssetError("input", "AssetType 必填")
    _ak, _sk, project_name, _region, _host = _settings(config)
    async with routed_http_client(timeout=120.0, follow_redirects=True) as client:
        group_id = await ensure_group(config, group_name, client=client)
        created = await call(
            config,
            "CreateAsset",
            {
                "GroupId": group_id,
                "URL": public_url,
                "AssetType": asset_type.strip(),
                "Name": (name or "asset").strip()[:60] or "asset",
                "ProjectName": project_name,
            },
            client=client,
        )
    asset_id = str(created.get("Id") or "").strip()
    if not asset_id:
        raise VolcengineAssetError("api", "火山 CreateAsset 未返回 Id")
    return {"asset_id": asset_id, "asset_uri": f"asset://{asset_id}", "status": "Processing"}


async def get_asset(config: dict[str, Any], asset_id: str) -> dict[str, Any]:
    asset_id = asset_id.strip()
    if not asset_id:
        raise VolcengineAssetError("input", "Asset Id 必填")
    _ak, _sk, project_name, _region, _host = _settings(config)
    info = await call(
        config,
        "GetAsset",
        {"Id": asset_id, "ProjectName": project_name},
    )
    status = str(info.get("Status") or "Processing")
    return {
        "asset_id": asset_id,
        "asset_uri": f"asset://{asset_id}" if status == "Active" else "",
        "status": status,
        "detail": info,
    }
