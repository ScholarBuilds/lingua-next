"""供应商凭据库：Fernet 加解密、掩码、能力绑定解析、供应商类型注册表（模块 11 配置中心）。

config JSONB 中的敏感字段（api_key/access_key）以 "enc:" 前缀密文落库，加密密钥
LINGUA_CONFIG_KEY 走环境变量。能力绑定按 主绑定 → fallback 链逐级取首个 enabled 凭据。
"""

import asyncio
import json
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import httpx
from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from domain import cli_bridge
from domain.models import CapabilityBinding, ProviderCredential
from domain.network_policy import routed_http_client, video_config
from domain.video_source import YOUTUBE_TEST_URL, build_ytdlp_opts, classify_download_error
from domain.volc_tts import VOLC_VOICES, VolcTTSError, stream_synthesize
from domain.youtube_api import test_key

ENC_PREFIX = "enc:"
# cookies_text / data_api_key 属敏感凭据：Fernet 加密入库、掩码展示、不入日志（模块 09 BR）
SENSITIVE_FIELDS = (
    "api_key",
    "wallet_api_key",
    "access_key",
    "access_key_id",
    "secret_access_key",
    "cookies_text",
    "data_api_key",
    # 保险箱里的通用秘密（模块 19）：站点密码、一次性口令种子、访问令牌
    "password",
    "totp_secret",
    "token",
    # Google 账号（模块 18）：OAuth 客户端密钥与刷新令牌
    "client_secret",
    "refresh_token",
)

LLM_CAPABILITIES = (
    "translate-fast",
    "explain-standard",
    "grammar-deep",
    "companion",
    "summary",
    # 修复代理（需求 09 v7 FR-89）：工具调用要求高，建议绑强模型并配 fallback
    "repair-agent",
    # 创作工坊 GPT 创作对话的对话模型（需求 17 FR-476）。它是 Agent：自己决定这一轮
    # 是只说话还是调 generate_image 出图，出图别名另绑（image-*）。工具调用不稳的模型
    # 会一路只说不画，建议绑强模型
    "chat-general",
    # 语音助理的大脑（CR-007 模块 20）：中英混说、调工具（阅读 / 邮件 / 日历 / 复习 / 任务），
    # 回复会被念出来所以要短。工具调用不稳的模型会一路只说不做，建议绑强模型
    "assistant",
)
TTS_SCENES = (
    "tts-word",
    "tts-sentence",
    "tts-chapter",
    "tts-vocab",
    "tts-video",
    "tts-assistant",
    "tts-meaning",
)

# 生图能力（模块 16 FR-418）。
#
# 它们绑定的是既有的 OpenAI 兼容凭据而不是另建一套：实测「gpt 中转」的模型列表里
# 就有 gpt-image-1/1.5/2——生图模型与聊天模型住在同一个端点后面，逼用户再录一遍
# 同一把 key 没有道理。kind="image" 留给将来只有生图能力的供应商。
IMAGE_CAPABILITIES = ("image-cover", "image-illustration", "image-free")
IMAGE_BINDABLE_KINDS = ("llm", "image")

# 全局默认对话模型（CR-013）。八条 LLM 能力里没有自己绑模型的那些跟随它。
# 刻意**不进** LLM_CAPABILITIES：进了会被 /bindings/legacy 当成待改绑挂红点，
# 测试桩 seed_default_bindings 也会自动给它绑上，让「没配默认」这条分支永远测不到。
DEFAULT_LLM_CAPABILITY = "default-llm"

ALL_CAPABILITIES = (
    DEFAULT_LLM_CAPABILITY,
    *LLM_CAPABILITIES,
    *TTS_SCENES,
    *IMAGE_CAPABILITIES,
    "realtime-voice",
    "translate-chain",
)

# 实时语音复用 TTS 凭据的类型：?kind=realtime 查询时一并返回
REALTIME_COMPAT_TYPES = ("volc_speech",)
LLM_COMPAT_TYPES = ("codex_cli", "gemini_cli")
VIDEO_COMPAT_TYPES = ("jimeng_cli",)


class CredentialError(Exception):
    """凭据缺失 / 加解密失败 / 绑定不可解析。"""


# ---- 加解密与掩码 ----


def _fernet() -> Fernet:
    settings = get_settings()
    backend = getattr(settings, "vault_key_backend", "env")
    key = settings.config_key if backend in {"auto", "env"} else ""
    # 没有显式配置就去钥匙串 / 本地文件取（domain/vault_key）；测试里的假 settings 没有这个开关，
    # 按「只认环境变量」处理，免得单测往真实钥匙串里写东西
    if not key and backend != "env":
        from domain.vault_key import load_master_key

        key, _ = load_master_key()
    if not key:
        raise CredentialError("LINGUA_CONFIG_KEY 未配置，凭据库不可用")
    return Fernet(key.encode())


def encrypt_value(plain: str) -> str:
    return ENC_PREFIX + _fernet().encrypt(plain.encode()).decode()


def decrypt_value(stored: str) -> str:
    if not stored.startswith(ENC_PREFIX):
        return stored
    try:
        return _fernet().decrypt(stored[len(ENC_PREFIX) :].encode()).decode()
    except InvalidToken as exc:
        raise CredentialError("凭据解密失败：LINGUA_CONFIG_KEY 与密文不匹配") from exc


def encrypt_config(config: dict) -> dict:
    """敏感字段加密，其余原样；已是密文的字段不重复加密。"""
    out = dict(config)
    for field in SENSITIVE_FIELDS:
        value = out.get(field)
        if isinstance(value, str) and value and not value.startswith(ENC_PREFIX):
            out[field] = encrypt_value(value)
    return out


def decrypt_config(config: dict) -> dict:
    out = dict(config)
    for field in SENSITIVE_FIELDS:
        value = out.get(field)
        if isinstance(value, str) and value.startswith(ENC_PREFIX):
            out[field] = decrypt_value(value)
    return out


def mask(plain: str) -> str:
    """明文掩码：前5 + … + 尾4；过短则只留前2。"""
    if len(plain) <= 9:
        return plain[:2] + "…"
    return plain[:5] + "…" + plain[-4:]


def masked_config(config: dict) -> dict:
    """API 对外视图：仅敏感字段，值为掩码（先解密再掩码，密文形态不外泄）。"""
    out: dict[str, str] = {}
    for field in SENSITIVE_FIELDS:
        value = config.get(field)
        if isinstance(value, str) and value:
            out[field] = mask(decrypt_value(value))
    return out


# ---- 绑定解析 ----


@dataclass
class ResolvedBinding:
    """解析后的可用绑定：config 为解密明文。"""

    credential_id: int
    provider_type: str
    kind: str
    config: dict
    target: str | None
    params: dict


def pick_candidate(
    binding_pairs: list[tuple[int | None, str | None]],
    creds_by_id: dict[int, ProviderCredential],
) -> tuple[ProviderCredential, str | None] | None:
    """从 主绑定+fallback 有序候选中取首个存在且 enabled 的凭据（纯函数，供单测）。"""
    for cred_id, target in binding_pairs:
        if cred_id is None:
            continue
        cred = creds_by_id.get(cred_id)
        if cred is not None and cred.enabled:
            return cred, target
    return None


def binding_candidates(binding: CapabilityBinding) -> list[tuple[int | None, str | None]]:
    pairs: list[tuple[int | None, str | None]] = [(binding.credential_id, binding.target)]
    for item in binding.fallback or []:
        if isinstance(item, dict):
            pairs.append((item.get("credential_id"), item.get("target")))
    return pairs


async def get_binding(session: AsyncSession, capability: str) -> CapabilityBinding | None:
    stmt = select(CapabilityBinding).where(CapabilityBinding.capability == capability)
    return (await session.execute(stmt)).scalar_one_or_none()


def normalize_chain(raw: object) -> list[str]:
    """translate-chain 的 chain 容忍两种形状：["llm","google"] 或 [{engine, enabled}]。"""
    chain: list[str] = []
    if not isinstance(raw, list | tuple):
        return chain
    for item in raw:
        if isinstance(item, str) and item:
            chain.append(item)
        elif isinstance(item, dict) and item.get("engine") and item.get("enabled", True):
            chain.append(str(item["engine"]))
    return chain


async def get_decrypted(session: AsyncSession, credential_id: int) -> dict:
    """按 id 取凭据解密后的 config；不存在抛 CredentialError。"""
    cred = await session.get(ProviderCredential, credential_id)
    if cred is None:
        raise CredentialError(f"凭据不存在：id={credential_id}")
    return decrypt_config(cred.config)


async def resolve_binding(session: AsyncSession, capability: str) -> ResolvedBinding:
    """capability → 首个可用凭据（enabled 校验 + fallback 逐级），config 已解密。"""
    binding = await get_binding(session, capability)
    if binding is None:
        raise CredentialError(f"能力未绑定：{capability}")
    pairs = binding_candidates(binding)
    ids = [cid for cid, _ in pairs if cid is not None]
    if not ids:
        raise CredentialError(f"能力 {capability} 未指定凭据")
    rows = (
        await session.execute(select(ProviderCredential).where(ProviderCredential.id.in_(ids)))
    ).scalars()
    picked = pick_candidate(pairs, {c.id: c for c in rows})
    if picked is None:
        raise CredentialError(f"能力 {capability} 的凭据均已停用或被删除")
    cred, target = picked
    return ResolvedBinding(
        credential_id=cred.id,
        provider_type=cred.provider_type,
        kind=cred.kind,
        config=decrypt_config(cred.config),
        target=target,
        params=dict(binding.params or {}),
    )


# ---- 供应商实现：LLM（OpenAI 兼容 /v1/models） ----

_LLM_DEFAULT_BASES = {
    "deepseek": "https://api.deepseek.com/v1",
    "openai": "https://api.openai.com/v1",
    "openai_video": "https://api.openai.com/v1",
    "volcengine_video": "https://ark.cn-beijing.volces.com/api/v3",
    "modelscope": "https://api-inference.modelscope.cn/v1",
    "ollama": "http://localhost:11434",
}


def openai_base(config: dict, provider_type: str) -> str:
    """归一化 api_base：无则用类型默认，末尾补 /v1。"""
    base = (config.get("api_base") or _LLM_DEFAULT_BASES.get(provider_type, "")).rstrip("/")
    if not base:
        raise CredentialError("api_base 未配置")
    if provider_type == "volcengine_video" and base.endswith("/api/v3"):
        return base
    return base if base.endswith("/v1") else base + "/v1"


def _classify_http_error(exc: Exception) -> str:
    if isinstance(exc, httpx.ConnectError | httpx.ConnectTimeout):
        return "connect"
    if isinstance(exc, httpx.TimeoutException):
        return "timeout"
    return "api"


async def _llm_fetch_models(config: dict, provider_type: str) -> list[str]:
    """GET {base}/models 真实拉取上游模型列表（FR-02）。"""
    base = openai_base(config, provider_type)
    headers = {}
    if config.get("api_key"):
        headers["Authorization"] = f"Bearer {config['api_key']}"
    async with routed_http_client(timeout=15.0) as client:
        resp = await client.get(f"{base}/models", headers=headers)
    if resp.status_code in (401, 403):
        raise CredentialError(f"auth|HTTP {resp.status_code}: 密钥无效或无权限")
    if resp.status_code >= 400:
        raise CredentialError(f"api|HTTP {resp.status_code}: {resp.text[:200]}")
    data = resp.json().get("data") or []
    ids = sorted({str(m.get("id")) for m in data if isinstance(m, dict) and m.get("id")})
    if not ids:
        raise CredentialError("api|上游返回空模型列表")
    return ids


def _test_result(
    ok: bool,
    started: float,
    error_type: str | None,
    detail: str,
    **diagnostics: object,
) -> dict:
    return {
        "ok": ok,
        "latency_ms": int((time.monotonic() - started) * 1000),
        "error_type": error_type,
        "detail": detail[:300],
        **diagnostics,
    }


def _safe_probe_preview(response: httpx.Response, config: dict) -> str:
    """Return a bounded, secret-redacted upstream response for the settings panel."""
    try:
        value: object = response.json()
        text = json.dumps(value, ensure_ascii=False, indent=2, default=str)
    except ValueError:
        text = response.text
    for field in SENSITIVE_FIELDS:
        secret = str(config.get(field) or "")
        if secret:
            text = text.replace(secret, "***")
    return text[:4000]


def _probe_preview(responses: list[tuple[str, httpx.Response]], config: dict) -> str:
    """Combine probe responses without returning request headers or plaintext secrets."""
    items = [
        {
            "probe": name,
            "status": response.status_code,
            "body": _safe_probe_preview(response, config),
        }
        for name, response in responses
    ]
    return json.dumps(items, ensure_ascii=False, indent=2)[:4000]


def _is_html_response(response: httpx.Response) -> bool:
    content_type = str(response.headers.get("content-type") or "").lower()
    return "text/html" in content_type or response.text.lstrip().lower().startswith(
        ("<!doctype html", "<html")
    )


def _looks_like_api_error(response: httpx.Response, markers: tuple[str, ...]) -> bool:
    if response.status_code not in {400, 404, 405, 409, 422} or _is_html_response(response):
        return False
    text = response.text.lower()
    return any(marker in text for marker in markers)


def _detected_openai_protocol(
    provider_type: str,
    base: str,
    model_ids: list[str],
) -> tuple[str, str, str]:
    lowered = base.lower()
    if provider_type == "volcengine_video" or "ark.cn-" in lowered:
        return "volcengine", "volcengine", "openai"
    if provider_type == "apimart" or "apimart.ai" in lowered:
        return "apimart", "apimart", "openai"
    if "runninghub.cn" in lowered or "runninghub.ai" in lowered:
        return "runninghub", "runninghub", "openai"
    if "generativelanguage.googleapis.com" in lowered:
        return "gemini", "gemini", "openai"
    if "ai-tudou.net" in lowered:
        return "openai", "tudou", "tudou-async"
    if "apihub.agnes-ai.com" in lowered or any(
        model_id.lower().startswith("agnes-image-") for model_id in model_ids
    ):
        return "openai", "openai", "openai-json"
    return "openai", "openai", "openai"


async def _llm_probe(config: dict, provider_type: str) -> dict:
    base = openai_base(config, provider_type)
    headers = {"Accept": "application/json"}
    if config.get("api_key"):
        headers["Authorization"] = f"Bearer {config['api_key']}"
    async with routed_http_client(timeout=15.0, follow_redirects=False) as client:
        response = await client.get(f"{base}/models", headers=headers)
        responses = [("GET /models", response)]
        preview = _probe_preview(responses, config)
        html = _is_html_response(response)
        if response.status_code not in {401, 403} and not html:
            lowered = base.lower()
            fallback: tuple[str, str] | None = None
            if provider_type == "volcengine_video" or "ark.cn-" in lowered:
                fallback = (
                    "GET /contents/generations/tasks/{id}",
                    f"{base}/contents/generations/tasks/healthcheck_probe_do_not_submit",
                )
            elif provider_type == "apimart" or "apimart.ai" in lowered or "ai-tudou.net" in lowered:
                fallback = (
                    "GET /tasks/{id}",
                    f"{base}/tasks/healthcheck_probe_do_not_submit",
                )
            if fallback is not None and (response.status_code >= 400 or not response.content):
                fallback_response = await client.get(fallback[1], headers=headers)
                responses.append((fallback[0], fallback_response))
                preview = _probe_preview(responses, config)
                if fallback_response.status_code in {401, 403}:
                    return {
                        "ok": False,
                        "error_type": "auth",
                        "detail": f"HTTP {fallback_response.status_code}: 密钥无效或无权限",
                        "status_code": fallback_response.status_code,
                        "raw_preview": preview,
                    }
                if _looks_like_api_error(
                    fallback_response,
                    ("task", "任务", "id", "not found", "不存在", "invalid"),
                ):
                    protocol, adapter, request_mode = _detected_openai_protocol(
                        provider_type, base, []
                    )
                    return {
                        "ok": True,
                        "error_type": None,
                        "detail": "模型列表不可用，但异步任务端点已识别；未提交生成任务",
                        "status_code": fallback_response.status_code,
                        "protocol": protocol,
                        "detected_adapter_type": adapter,
                        "image_request_mode": request_mode,
                        "model_count": 0,
                        "raw_preview": preview,
                    }
            elif response.status_code >= 400:
                chat_response = await client.post(
                    f"{base}/chat/completions",
                    headers=headers,
                    json={
                        "model": "healthcheck_probe_do_not_submit",
                        "messages": [],
                    },
                )
                responses.append(("POST /chat/completions（无效模型，不生成）", chat_response))
                preview = _probe_preview(responses, config)
                if chat_response.status_code in {401, 403}:
                    return {
                        "ok": False,
                        "error_type": "auth",
                        "detail": f"HTTP {chat_response.status_code}: 密钥无效或无权限",
                        "status_code": chat_response.status_code,
                        "raw_preview": preview,
                    }
                if _looks_like_api_error(
                    chat_response,
                    ("model", "模型", "message", "chat", "completion", "invalid"),
                ):
                    protocol, adapter, request_mode = _detected_openai_protocol(
                        provider_type, base, []
                    )
                    return {
                        "ok": True,
                        "error_type": None,
                        "detail": "模型列表不可用，但 OpenAI 兼容端点已识别；未提交有效模型请求",
                        "status_code": chat_response.status_code,
                        "protocol": protocol,
                        "detected_adapter_type": adapter,
                        "image_request_mode": request_mode,
                        "model_count": 0,
                        "raw_preview": preview,
                    }
    if response.status_code in {301, 302, 303, 307, 308}:
        return {
            "ok": False,
            "error_type": "api",
            "detail": "模型端点发生跳转，请填写 API Base URL，不要填写网页登录地址",
            "status_code": response.status_code,
            "raw_preview": preview,
        }
    if response.status_code in {401, 403}:
        return {
            "ok": False,
            "error_type": "auth",
            "detail": f"HTTP {response.status_code}: 密钥无效或无权限",
            "status_code": response.status_code,
            "raw_preview": preview,
        }
    if html:
        return {
            "ok": False,
            "error_type": "api",
            "detail": "模型端点返回网页 HTML，请检查地址是否为 API Base URL",
            "status_code": response.status_code,
            "raw_preview": preview,
        }
    if response.status_code >= 400:
        return {
            "ok": False,
            "error_type": "api",
            "detail": f"HTTP {response.status_code}: {response.text[:200]}",
            "status_code": response.status_code,
            "raw_preview": preview,
        }
    try:
        payload = response.json()
    except ValueError:
        return {
            "ok": False,
            "error_type": "api",
            "detail": "模型端点返回的不是 JSON",
            "status_code": response.status_code,
            "raw_preview": preview,
        }
    data = payload.get("data") if isinstance(payload, dict) else []
    if not data and isinstance(payload, dict):
        data = payload.get("models") or payload.get("list") or []
    ids = sorted(
        {
            str(item.get("id") or item.get("name") or item.get("model"))
            for item in data or []
            if isinstance(item, dict) and (item.get("id") or item.get("name") or item.get("model"))
        }
    )
    if not ids:
        protocol, adapter, request_mode = _detected_openai_protocol(provider_type, base, [])
        return {
            "ok": True,
            "error_type": None,
            "detail": "连接正常，上游模型列表为空；已按端点特征识别协议",
            "status_code": response.status_code,
            "protocol": protocol,
            "detected_adapter_type": adapter,
            "image_request_mode": request_mode,
            "model_count": 0,
            "raw_preview": preview,
        }
    protocol, adapter, request_mode = _detected_openai_protocol(provider_type, base, ids)
    return {
        "ok": True,
        "error_type": None,
        "detail": f"可用，上游共 {len(ids)} 个模型",
        "status_code": response.status_code,
        "protocol": protocol,
        "detected_adapter_type": adapter,
        "image_request_mode": request_mode,
        "model_count": len(ids),
        "raw_preview": preview,
    }


async def _llm_test(config: dict, provider_type: str) -> dict:
    """连通测试 = 真实鉴权请求 /models（BR-03），分型 connect/auth/timeout/api。"""
    started = time.monotonic()
    try:
        result = await _llm_probe(config, provider_type)
    except CredentialError as exc:
        return _test_result(False, started, "api", str(exc))
    except httpx.HTTPError as exc:
        return _test_result(False, started, _classify_http_error(exc), str(exc))
    return _test_result(
        bool(result.pop("ok")),
        started,
        result.pop("error_type", None),
        str(result.pop("detail", "")),
        **result,
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


async def _video_fetch_models(config: dict, provider_type: str) -> list[dict]:
    """从 OpenAI 兼容 /models 保留上游真实模型名。

    有可识别的视频模型时只返回视频项；私有中转可能使用不带家族名的
    自定义 ID，这种情况保留全部，交给用户在模型实验台停用无关项。
    """
    ids = await _llm_fetch_models(config, provider_type)
    recognized = [
        model_id
        for model_id in ids
        if any(marker in model_id.lower() for marker in _VIDEO_MODEL_MARKERS)
    ]
    selected = recognized or ids
    return [{"id": model_id, "media_types": ["video"]} for model_id in selected]


async def _video_test(config: dict, provider_type: str) -> dict:
    started = time.monotonic()
    try:
        result = await _llm_probe(config, provider_type)
    except CredentialError as exc:
        return _test_result(False, started, "api", str(exc))
    except httpx.HTTPError as exc:
        return _test_result(False, started, _classify_http_error(exc), str(exc))
    ok = bool(result.pop("ok"))
    error_type = result.pop("error_type", None)
    detail = str(result.pop("detail", ""))
    if ok:
        detail = f"可用，发现 {result.get('model_count') or 0} 个上游模型"
    return _test_result(ok, started, error_type, detail, **result)


# ---- 供应商实现：Gemini 原生图片 ----

_GEMINI_DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta"


def gemini_base(config: dict) -> str:
    """归一化 Gemini REST API 地址，末尾保留 API 版本而不带 /models。"""
    base = str(config.get("api_base") or _GEMINI_DEFAULT_BASE).strip().rstrip("/")
    if not base:
        raise CredentialError("api_base 未配置")
    if base.endswith("/models"):
        base = base[: -len("/models")]
    return base.rstrip("/")


async def _gemini_fetch_models(config: dict, provider_type: str) -> list[dict]:
    """从官方 /models 拉取可输出图片的真实模型名。

    Google 的列表接口也会返回纯文本 Gemini；这类凭据的 kind 是 image，
    所以只把名称中明确带 image 的项同步进创作模型目录。仍可在模型
    实验台手动登记官方新发布、尚未符合此命名规则的模型。
    """
    api_key = str(config.get("api_key") or "").strip()
    if not api_key:
        raise CredentialError("auth|api_key 未配置")
    base = gemini_base(config)
    async with routed_http_client(
        timeout=15.0,
    ) as client:
        resp = await client.get(f"{base}/models", headers={"x-goog-api-key": api_key})
    if resp.status_code in (401, 403):
        raise CredentialError(f"auth|HTTP {resp.status_code}: 密钥无效或无权限")
    if resp.status_code >= 400:
        raise CredentialError(f"api|HTTP {resp.status_code}: {resp.text[:200]}")
    items: list[dict] = []
    for raw in resp.json().get("models") or []:
        if not isinstance(raw, dict):
            continue
        model_id = str(raw.get("name") or "").removeprefix("models/").strip()
        methods = raw.get("supportedGenerationMethods") or []
        if not model_id or "generateContent" not in methods or "image" not in model_id.lower():
            continue
        items.append(
            {
                "id": model_id,
                "display_name": str(raw.get("displayName") or "").strip() or None,
                "media_types": ["image"],
            }
        )
    if not items:
        raise CredentialError("api|上游没有返回可识别的 Gemini 图片模型")
    return sorted(items, key=lambda item: item["id"])


async def _gemini_test(config: dict, provider_type: str) -> dict:
    """连通测试只读模型列表，不触发付费生图。"""
    started = time.monotonic()
    try:
        items = await _gemini_fetch_models(config, provider_type)
    except CredentialError as exc:
        error_type, _, detail = str(exc).partition("|")
        if not detail:
            error_type, detail = "api", str(exc)
        return _test_result(False, started, error_type, detail)
    except httpx.HTTPError as exc:
        return _test_result(False, started, _classify_http_error(exc), str(exc))
    return _test_result(True, started, None, f"可用，发现 {len(items)} 个图片模型")


# ---- 供应商实现：ComfyUI / RunningHub 工作流 ----


def workflow_base(config: dict, provider_type: str) -> str:
    defaults = {
        "comfyui": "http://127.0.0.1:8188",
        "runninghub": "https://www.runninghub.ai",
    }
    base = str(config.get("api_base") or defaults.get(provider_type) or "").strip().rstrip("/")
    if not base:
        raise CredentialError("api_base 未配置")
    if not base.startswith(("http://", "https://")):
        raise CredentialError("api_base 必须以 http:// 或 https:// 开头")
    return base


def workflow_headers(config: dict, *, json_body: bool = False) -> dict[str, str]:
    headers = {"Accept": "application/json"}
    api_key = str(config.get("api_key") or "").strip()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    if json_body:
        headers["Content-Type"] = "application/json"
    return headers


async def _comfy_fetch_models(config: dict, provider_type: str) -> list[dict]:
    """ComfyUI 无“模型目录”通用语义，/object_info 的节点类型最能反映实例能力。"""
    base = workflow_base(config, provider_type)
    async with routed_http_client(
        timeout=30.0,
    ) as client:
        resp = await client.get(f"{base}/object_info", headers=workflow_headers(config))
    if resp.status_code in (401, 403):
        raise CredentialError(f"auth|HTTP {resp.status_code}: ComfyUI 鉴权失败")
    if resp.status_code >= 400:
        raise CredentialError(f"api|HTTP {resp.status_code}: {resp.text[:200]}")
    payload = resp.json()
    if not isinstance(payload, dict) or not payload:
        raise CredentialError("api|ComfyUI /object_info 返回为空")
    return [{"id": str(name), "media_types": ["workflow"]} for name in sorted(payload)]


async def _comfy_test(config: dict, provider_type: str) -> dict:
    started = time.monotonic()
    try:
        nodes = await _comfy_fetch_models(config, provider_type)
    except CredentialError as exc:
        error_type, _, detail = str(exc).partition("|")
        return _test_result(False, started, error_type or "api", detail or str(exc))
    except httpx.HTTPError as exc:
        return _test_result(False, started, _classify_http_error(exc), str(exc))
    return _test_result(True, started, None, f"可用，实例已加载 {len(nodes)} 种节点")


def _runninghub_model_items(payload: object) -> list[dict]:
    """容忍 RunningHub 国际站/国内站模型目录多种包装形状。"""
    queue: list[object] = [payload]
    raw_items: list[dict] = []
    while queue:
        current = queue.pop(0)
        if isinstance(current, list):
            raw_items.extend(item for item in current if isinstance(item, dict))
            continue
        if not isinstance(current, dict):
            continue
        for key in ("data", "models", "list", "items", "records", "result"):
            nested = current.get(key)
            if isinstance(nested, (dict, list)):
                queue.append(nested)
    result: list[dict] = []
    seen: set[str] = set()
    for raw in raw_items:
        model_id = str(
            raw.get("name_en") or raw.get("id") or raw.get("name") or raw.get("endpoint") or ""
        ).strip()
        if not model_id or model_id in seen:
            continue
        seen.add(model_id)
        output = str(raw.get("output_type") or raw.get("outputType") or "").lower()
        media = [output] if output in {"image", "video", "chat"} else ["workflow"]
        result.append(
            {
                "id": model_id,
                "display_name": str(raw.get("name_cn") or raw.get("displayName") or "").strip()
                or None,
                "media_types": media,
            }
        )
    return sorted(result, key=lambda item: item["id"])


async def _runninghub_fetch_models(config: dict, provider_type: str) -> list[dict]:
    base = workflow_base(config, provider_type)
    endpoint = base if base.endswith("/openapi/v2") else f"{base}/openapi/v2"
    runtime = {
        **config,
        "api_key": str(config.get("wallet_api_key") or config.get("api_key") or "").strip(),
    }
    async with routed_http_client(timeout=30.0, follow_redirects=True) as client:
        resp = await client.get(f"{endpoint}/models", headers=workflow_headers(runtime))
    if resp.status_code in (401, 403):
        raise CredentialError(f"auth|HTTP {resp.status_code}: RunningHub API Key 无效")
    if resp.status_code >= 400:
        raise CredentialError(f"api|HTTP {resp.status_code}: {resp.text[:200]}")
    items = _runninghub_model_items(resp.json())
    if not items:
        raise CredentialError("api|RunningHub 模型目录返回为空")
    return items


async def _runninghub_test(config: dict, provider_type: str) -> dict:
    started = time.monotonic()
    try:
        items = await _runninghub_fetch_models(config, provider_type)
    except CredentialError as exc:
        error_type, _, detail = str(exc).partition("|")
        return _test_result(False, started, error_type or "api", detail or str(exc))
    except httpx.HTTPError as exc:
        return _test_result(False, started, _classify_http_error(exc), str(exc))
    return _test_result(True, started, None, f"可用，发现 {len(items)} 个 OpenAPI 模型")


# ---- 供应商实现：火山语音（TTS 2.0 + 实时语音共用凭据） ----


# 音色目录：内置常量。前 6 个为 2026-08-17 项目内逐一实测 code=0 的音色
# （domain/volc_tts.VOLC_VOICES），其余摘自官方《大模型语音合成音色列表》
# https://docs.volcengine.com/docs/6561/1257544 "豆包语音合成模型2.0" uranus 系列
# （美式英语多语种 + 中文通用场景），未逐一实测，未授权音色合成时返回 code=45000000。
def _voice(vid: str, label: str, gender: str, locale: str) -> dict:
    return {"id": vid, "label": label, "gender": gender, "locale": locale}


_VOLC_EXTRA_VOICES: tuple[dict, ...] = (
    # 英语（多语种音色列表 · 教学/有声阅读向）
    _voice("en_female_jenny_uranus_bigtts", "Jenny · 美音女声（客服清晰）", "Female", "en-US"),
    _voice("en_female_joanne_uranus_bigtts", "Joanne · 美音女声（有声阅读）", "Female", "en-US"),
    _voice("en_female_myra_uranus_bigtts", "Myra · 美音女声（教学）", "Female", "en-US"),
    _voice("en_female_hayley_uranus_bigtts", "Hayley · 美音女声（教学配音）", "Female", "en-US"),
    _voice("en_female_natasha_uranus_bigtts", "Natasha · 美音女声（视频配音）", "Female", "en-US"),
    _voice(
        "en_female_pleasant-female_uranus_bigtts", "Elaine · 美音女声（叙述）", "Female", "en-US"
    ),
    _voice(
        "en_female_female_tutor_ms-jenny_uranus_bigtts",
        "Holly · 美音女声（家教）",
        "Female",
        "en-US",
    ),
    _voice("en_male_jamie_uranus_bigtts", "Jamie · 美音男声（通用教学）", "Male", "en-US"),
    _voice("en_male_kevin_uranus_bigtts", "Kevin · 美音男声（教学配音）", "Male", "en-US"),
    _voice("en_male_marcus_uranus_bigtts", "Marcus · 美音男声（有声阅读）", "Male", "en-US"),
    _voice("en_male_russell_uranus_bigtts", "Russell · 美音男声（教学）", "Male", "en-US"),
    _voice("en_male_alex_uranus_bigtts", "Alex · 美音男声（视频配音）", "Male", "en-US"),
    _voice("en_male_michael_uranus_bigtts", "Hank · 美音男声（教学）", "Male", "en-US"),
    _voice("en_male_adam-imitation_uranus_bigtts", "Rowan · 美音男声（有声阅读）", "Male", "en-US"),
    # 中文（"豆包语音合成模型2.0" 音色列表 · 通用场景）
    _voice("zh_female_vv_uranus_bigtts", "Vivi 2.0 · 中文女声（通用多语）", "Female", "zh-CN"),
    _voice("zh_female_xiaohe_uranus_bigtts", "小何 2.0 · 中文女声（通用）", "Female", "zh-CN"),
    _voice("zh_female_qingxinnvsheng_uranus_bigtts", "清新女声 2.0 · 中文女声", "Female", "zh-CN"),
    _voice("zh_female_shuangkuaisisi_uranus_bigtts", "爽快思思 2.0 · 中文女声", "Female", "zh-CN"),
    _voice("zh_female_cancan_uranus_bigtts", "知性灿灿 2.0 · 中文女声", "Female", "zh-CN"),
    _voice("zh_female_linjianvhai_uranus_bigtts", "邻家女孩 2.0 · 中文女声", "Female", "zh-CN"),
    _voice("zh_female_tianmeitaozi_uranus_bigtts", "甜美桃子 2.0 · 中文女声", "Female", "zh-CN"),
    _voice("zh_male_m191_uranus_bigtts", "云舟 2.0 · 中文男声（通用）", "Male", "zh-CN"),
    _voice("zh_male_taocheng_uranus_bigtts", "小天 2.0 · 中文男声（通用）", "Male", "zh-CN"),
    _voice("zh_male_liufei_uranus_bigtts", "刘飞 2.0 · 中文男声（通用）", "Male", "zh-CN"),
    _voice("zh_male_shaonianzixin_uranus_bigtts", "少年梓辛 2.0 · 中文男声", "Male", "zh-CN"),
)

VOLC_VOICE_CATALOG: tuple[dict, ...] = (*VOLC_VOICES, *_VOLC_EXTRA_VOICES)

VOLC_TEST_VOICE = "en_female_skye_uranus_bigtts"


def _classify_volc_error(message: str) -> str:
    lowered = message.lower()
    if "timeout" in lowered or "超时" in message:
        return "timeout"
    if "网络错误" in message:
        return "connect"
    if any(token in message for token in ("401", "403", "45000000", "鉴权", "unauthorized")):
        return "auth"
    return "api"


async def _volc_test(config: dict, provider_type: str) -> dict:
    """真实合成一小段文本，取到首块音频即算通过。"""
    started = time.monotonic()
    app_id, access_key = config.get("app_id", ""), config.get("access_key", "")
    if not (app_id and access_key):
        return _test_result(False, started, "auth", "app_id / access_key 未配置")
    gen = stream_synthesize("Hi", VOLC_TEST_VOICE, 0, app_id=app_id, access_key=access_key)
    try:
        await anext(gen)
    except StopAsyncIteration:
        return _test_result(False, started, "api", "合成无音频返回")
    except VolcTTSError as exc:
        return _test_result(False, started, _classify_volc_error(str(exc)), str(exc))
    finally:
        await gen.aclose()
    return _test_result(True, started, None, "合成正常")


async def _volc_list_voices(config: dict, provider_type: str) -> list[dict]:
    return [dict(v) for v in VOLC_VOICE_CATALOG]


# ---- 供应商实现：edge-tts（免费，无密钥） ----


async def _edge_list_voices(config: dict, provider_type: str) -> list[dict]:
    import edge_tts

    from domain.network_policy import speech_proxy

    fetched = await edge_tts.list_voices(proxy=await speech_proxy() or "")
    return [
        {
            "id": v["ShortName"],
            "label": v["ShortName"],
            "gender": v["Gender"],
            "locale": v["Locale"],
        }
        for v in fetched
    ]


async def _edge_test(config: dict, provider_type: str) -> dict:
    started = time.monotonic()
    try:
        voices = await _edge_list_voices(config, provider_type)
    except Exception as exc:  # edge_tts 底层异常类型不稳定，统一收敛
        detail = f"{type(exc).__name__}: {exc}"
        return _test_result(False, started, _classify_http_error(exc), detail)
    return _test_result(True, started, None, f"可用，音色 {len(voices)} 个")


async def _azure_test(config: dict, provider_type: str) -> dict:
    from domain.azure_speech import list_voices

    started = time.monotonic()
    try:
        voices = await list_voices(config)
    except (httpx.HTTPError, ValueError) as exc:
        return _test_result(
            False,
            started,
            _classify_http_error(exc),
            f"Azure 音色目录请求失败（{type(exc).__name__}），请检查区域、密钥和网络",
        )
    return _test_result(True, started, None, f"音色目录可用，共 {len(voices)} 个；可在目录中试听")


async def _azure_list_voices(config: dict, provider_type: str) -> list[dict]:
    from domain.azure_speech import list_voices

    return await list_voices(config)


async def _cloud_list_voices(config: dict, provider_type: str) -> list[dict]:
    from domain.cloud_tts import list_voices

    return await list_voices(config, provider_type)


async def _cloud_speech_test(config: dict, provider_type: str) -> dict:
    import aiohttp

    from domain.cloud_tts import synthesize

    started = time.monotonic()
    try:
        voices = await _cloud_list_voices(config, provider_type)
        if provider_type == "bailian_tts":
            stream = synthesize(config, provider_type, "Hello.", "Cherry", 0, {})
            try:
                await anext(stream)
            finally:
                await stream.aclose()
        return _test_result(True, started, None, f"目录 {len(voices)} 项；请试听确认音质与延迟")
    except (httpx.HTTPError, aiohttp.ClientError, ValueError, KeyError, TimeoutError) as exc:
        return _test_result(
            False,
            started,
            "connect",
            f"语音服务检查失败（{type(exc).__name__}），请检查密钥、地域和额度",
        )


# ---- 供应商实现：YouTube 视频源（yt-dlp 凭证，FR-21/FR-22） ----


async def _youtube_test(config: dict, provider_type: str) -> dict:
    """真实 extract_info 测试视频元数据（download=False），分型 ok/auth(bot 校验)/connect。"""
    started = time.monotonic()
    config = await video_config(config)

    def probe() -> str:
        import yt_dlp

        opts, cookie_path = build_ytdlp_opts(config)
        opts["skip_download"] = True
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(YOUTUBE_TEST_URL, download=False)
            return (info or {}).get("title") or "unknown"
        finally:
            if cookie_path:
                Path(cookie_path).unlink(missing_ok=True)

    try:
        title = await asyncio.wait_for(asyncio.to_thread(probe), timeout=90)
    except TimeoutError:
        return _test_result(False, started, "timeout", "extract_info 超时（90s）")
    except ValueError as exc:  # build_ytdlp_opts 的配置校验错误
        return _test_result(False, started, "api", str(exc))
    except Exception as exc:  # yt-dlp DownloadError 等，按消息分型
        detail = f"{type(exc).__name__}: {exc}"
        kind = classify_download_error(str(exc))
        error_type = {"bot_check": "auth", "network": "connect"}.get(kind, "api")
        return _test_result(False, started, error_type, detail)

    # Data API key 是可选增强：配了就一并验，没配不影响下载能力的判定（FR-56）
    detail = f"可用，测试视频《{title}》元数据获取成功"
    api_key = (config.get("data_api_key") or "").strip()
    if api_key:
        probe_result = await test_key(api_key)
        if not probe_result["ok"]:
            reason = probe_result["detail"]
            return _test_result(False, started, "auth", f"下载凭证正常，但 {reason}")
        detail += "；Data API v3 可用"
    return _test_result(True, started, None, detail)


async def _not_implemented_test(config: dict, provider_type: str) -> dict:
    return {
        "ok": False,
        "latency_ms": 0,
        "error_type": "api",
        "detail": f"not_implemented：{provider_type} 为预留类型，暂未接入",
    }


async def _not_implemented_models(config: dict, provider_type: str) -> list:
    raise CredentialError(f"not_implemented：{provider_type} 为预留类型，暂不支持拉取列表")


async def _cli_test(config: dict, provider_type: str) -> dict:
    started = time.monotonic()
    try:
        status = await cli_bridge.provider_status(config, provider_type)
    except cli_bridge.CliBridgeError as exc:
        return _test_result(False, started, exc.kind, str(exc))
    version = str(status.get("version") or "未报告版本")
    detail = f"CLI 可用：{version}"
    if provider_type == "jimeng_cli":
        detail += "；已登录，额度查询成功"
    elif provider_type == "codex_cli":
        detail += "；GPT Image 2 helper 可用"
    return _test_result(True, started, None, detail)


async def _cli_models(config: dict, provider_type: str) -> list:
    return cli_bridge.provider_models(provider_type)


# ---- 类型注册表 ----

_KEY_FIELD = {
    "name": "api_key",
    "label": "API Key",
    "type": "password",
    "required": True,
    "placeholder": "sk-...",
}


def _field(
    name: str, label: str, type_: str = "text", required: bool = True, placeholder: str = ""
) -> dict:
    return {
        "name": name,
        "label": label,
        "type": type_,
        "required": required,
        "placeholder": placeholder,
    }


PROVIDER_TYPES: dict[str, dict] = {
    "deepseek": {
        "kind": "llm",
        "label": "DeepSeek 官方",
        "fields": [
            dict(_KEY_FIELD),
            _field("api_base", "API Base", "url", False, "https://api.deepseek.com/v1"),
        ],
        "notes": "官方 OpenAI 兼容接口，模型列表走 /v1/models",
        "test": _llm_test,
        "list_models": _llm_fetch_models,
    },
    "openai": {
        "kind": "llm",
        "label": "OpenAI 官方",
        "fields": [
            dict(_KEY_FIELD),
            _field("api_base", "API Base", "url", False, "https://api.openai.com/v1"),
        ],
        "notes": "官方接口",
        "recommendation": {
            "category": "allround",
            "badge": "官方综合",
            "summary": "对话、图片、视频与多模态能力的官方入口。",
        },
        "test": _llm_test,
        "list_models": _llm_fetch_models,
    },
    "openai_compatible": {
        "kind": "llm",
        "label": "OpenAI 兼容中转",
        "fields": [
            _field("api_base", "API Base", "url", True, "https://example.com/v1"),
            dict(_KEY_FIELD),
        ],
        "notes": "任意 OpenAI 兼容网关/中转，只需 Base + Key",
        "test": _llm_test,
        "list_models": _llm_fetch_models,
    },
    "apimart": {
        "kind": "image",
        "label": "APIMart Midjourney",
        "fields": [
            dict(_KEY_FIELD),
            _field("api_base", "API Base", "url", False, "https://api.apimart.ai/v1"),
        ],
        "notes": "Midjourney 原生异步任务、轮询及放大/变体/重绘等二次操作。"
        "连通测试只读取模型列表，不会触发生图计费。",
        "test": _llm_test,
        "list_models": _llm_fetch_models,
        "default_adapter": "apimart",
    },
    "openai_video": {
        "kind": "video",
        "label": "OpenAI / 兼容视频",
        "fields": [
            dict(_KEY_FIELD),
            _field("api_base", "API Base", "url", False, "https://api.openai.com/v1"),
        ],
        "notes": "默认使用 OpenAI Videos 异步协议（/v1/videos），也可用于实现该协议的中转。",
        "test": _video_test,
        "list_models": _video_fetch_models,
        "default_adapter": "openai",
    },
    "volcengine_video": {
        "kind": "video",
        "label": "火山方舟 Seedance",
        "fields": [
            dict(_KEY_FIELD),
            _field(
                "api_base",
                "API Base",
                "url",
                False,
                "https://ark.cn-beijing.volces.com/api/v3",
            ),
            _field(
                "access_key_id",
                "素材库 Access Key ID（可选）",
                "password",
                False,
                "CreateAsset / GetAsset 使用",
            ),
            _field(
                "secret_access_key",
                "素材库 Secret Access Key（可选）",
                "password",
                False,
                "只在服务端加密保存",
            ),
            _field("project_name", "素材库 ProjectName", "text", False, "default"),
            _field("region", "素材库 Region", "text", False, "cn-beijing"),
        ],
        "notes": "Ark API Key 用于 Contents Generation；AK/SK 独立用于签名 V4 的"
        " CreateAssetGroup/CreateAsset/GetAsset。模型名使用控制台实际 endpoint/model ID。",
        "recommendation": {
            "category": "video",
            "badge": "国内视频",
            "summary": "Seedance 等火山方舟视频模型的原生异步协议。",
        },
        "test": _video_test,
        "list_models": _video_fetch_models,
        "default_adapter": "volcengine",
    },
    "ollama": {
        "kind": "llm",
        "label": "Ollama 本地",
        "fields": [_field("api_base", "API Base", "url", True, "http://localhost:11434")],
        "notes": "本地推理，无需密钥；模型列表走 OpenAI 兼容 /v1/models",
        "recommendation": {
            "category": "free",
            "badge": "本机免费",
            "summary": "模型和数据留在本机，不产生云端 API 费用。",
        },
        "test": _llm_test,
        "list_models": _llm_fetch_models,
    },
    "modelscope": {
        "kind": "llm",
        "label": "ModelScope 魔搭（免费额度）",
        "fields": [
            _field("api_key", "访问令牌", "password", True, "ms-..."),
            _field(
                "api_base",
                "API Base",
                "url",
                False,
                "https://api-inference.modelscope.cn/v1",
            ),
        ],
        "notes": "阿里魔搭社区的推理服务，OpenAI 兼容。**每天有免费额度**，"
        "聊天与生图共用一把令牌（Qwen 系列聊天 / Z-Image、FLUX 等生图）。"
        "模型名带命名空间，形如 Qwen/Qwen3-235B-A22B。",
        "recommendation": {
            "category": "free",
            "badge": "开源额度",
            "summary": "OpenAI 兼容的开源对话与 AIGC 推理，适合先做低成本验证。",
        },
        "test": _llm_test,
        "list_models": _llm_fetch_models,
        "default_adapter": "modelscope",
    },
    "gemini_image": {
        "kind": "image",
        "label": "Google Gemini 原生图片",
        "fields": [
            _field("api_key", "Gemini API Key", "password", True, "AIza..."),
            _field(
                "api_base",
                "API Base",
                "url",
                False,
                "https://generativelanguage.googleapis.com/v1beta",
            ),
        ],
        "notes": "官方 generateContent 图片协议；支持文生图和多张参考图编辑。"
        "连通测试只读模型列表，不会生图计费。",
        "recommendation": {
            "category": "image",
            "badge": "官方图片",
            "summary": "Gemini/Imagen 原生生图与多参考编辑。",
        },
        "test": _gemini_test,
        "list_models": _gemini_fetch_models,
        "default_adapter": "gemini",
    },
    "codex_cli": {
        "kind": "image",
        "compatible_kinds": ["llm"],
        "label": "Codex CLI 图片",
        "fields": [
            _field("executable", "Codex 路径（可选）", "text", False, "codex"),
            _field(
                "helper_executable",
                "GPT Image 2 helper 路径（可选）",
                "text",
                False,
                "gpt-image-2-skill",
            ),
            _field("auth_file", "Codex auth.json（可选）", "text", False, "~/.codex/auth.json"),
            _field("timeout", "超时秒数", "text", False, "300"),
        ],
        "notes": "使用本机 Codex 登录态和 gpt-image-2-skill；不在命令行传递 API Key。",
        "recommendation": {
            "category": "image",
            "badge": "本机 CLI",
            "summary": "沿用 Codex 本机登录态生成和编辑 GPT Image 2 图片。",
        },
        "test": _cli_test,
        "list_models": _cli_models,
        "default_adapter": "codex",
    },
    "gemini_cli": {
        "kind": "image",
        "compatible_kinds": ["llm"],
        "label": "Gemini / Antigravity CLI",
        "fields": [
            _field("executable", "agy / gemini 路径（可选）", "text", False, "agy"),
            _field("timeout", "超时秒数", "text", False, "300"),
        ],
        "notes": "优先检测 agy，其次 gemini；在受控临时目录中执行并只接收校验后的图片。",
        "recommendation": {
            "category": "image",
            "badge": "本机 CLI",
            "summary": "使用 Gemini 或 Antigravity 的本机登录态出图。",
        },
        "test": _cli_test,
        "list_models": _cli_models,
        "default_adapter": "gemini-cli",
    },
    "jimeng_cli": {
        "kind": "image",
        "compatible_kinds": ["video"],
        "label": "即梦 Dreamina CLI",
        "fields": [
            _field("executable", "dreamina 路径（可选）", "text", False, "dreamina"),
            _field("timeout", "单次 CLI 超时秒数", "text", False, "180"),
            _field("submit_poll_seconds", "提交等待秒数", "text", False, "1"),
        ],
        "notes": "一份本机登录态同时提供图片和视频；测试会读取版本与用户额度，不发起生成。",
        "recommendation": {
            "category": "allround",
            "badge": "本机 CLI",
            "summary": "使用 dreamina 的图片、参考图编辑和持久视频任务。",
        },
        "test": _cli_test,
        "list_models": _cli_models,
        "default_adapter": "jimeng",
    },
    "comfyui": {
        "kind": "workflow",
        "label": "ComfyUI 实例",
        "fields": [
            _field("api_base", "ComfyUI 地址", "url", True, "http://127.0.0.1:8188"),
            _field("api_key", "API Key（可选）", "password", False, "云端实例才需要"),
        ],
        "notes": "可配本机或局域网多媒体 ComfyUI 实例；测试读取 /object_info，"
        "运行使用 /prompt、/history 和 /view。",
        "recommendation": {
            "category": "free",
            "badge": "本机工作流",
            "summary": "使用本机或局域网 GPU 运行可编辑 ComfyUI 节点图。",
        },
        "test": _comfy_test,
        "list_models": _comfy_fetch_models,
    },
    "runninghub": {
        "kind": "workflow",
        "label": "RunningHub",
        "fields": [
            _field("api_key", "API Key", "password", True, "RunningHub 积分 Key"),
            _field(
                "wallet_api_key",
                "账户余额 Key（可选）",
                "password",
                False,
                "需要走账户余额时填写",
            ),
            _field("api_base", "API Base", "url", False, "https://www.runninghub.ai"),
        ],
        "notes": "支持 AI 应用、云端 ComfyUI 工作流、素材上传与持久任务轮询。",
        "recommendation": {
            "category": "allround",
            "badge": "云端工作流",
            "summary": "图片、视频、音频、AI App 与工作流的云端任务式 API。",
        },
        "test": _runninghub_test,
        "list_models": _runninghub_fetch_models,
    },
    "volc_speech": {
        "kind": "tts",
        "label": "火山引擎语音（豆包 2.0）",
        "fields": [
            _field("app_id", "App ID"),
            _field("access_key", "Access Key", "password"),
        ],
        "notes": "TTS 2.0（seed-tts-2.0）与端到端实时语音（volc.speech.dialog）共用同一组凭据；"
        "音色目录为内置常量（官方文档 6561/1257544），刷新即重载",
        "test": _volc_test,
        "list_models": _volc_list_voices,
    },
    "edge_tts": {
        "kind": "tts",
        "label": "Edge TTS（免费）",
        "fields": [],
        "notes": "微软 Edge 免费接口，无需密钥；音色列表动态拉取",
        "test": _edge_test,
        "list_models": _edge_list_voices,
    },
    "azure_speech": {
        "kind": "tts",
        "label": "Azure Speech",
        "fields": [
            _field("api_key", "Subscription Key", "password"),
            _field("region", "Region", "text", True, "eastasia"),
        ],
        "notes": "Azure Speech 区域音色与朗读合成；不是 Azure OpenAI 实时对话模型。",
        "test": _azure_test,
        "list_models": _azure_list_voices,
    },
    "bailian_tts": {
        "kind": "tts",
        "label": "阿里百炼 Qwen TTS",
        "fields": [
            _field("api_key", "API Key", "password"),
            _field("region", "地域（beijing / singapore）", "text", True, "beijing"),
            _field("model", "模型", "text", False, "qwen3-tts-flash-realtime"),
        ],
        "notes": "Qwen3 系统音色目录；北京与新加坡密钥不通用。连接测试会合成一句 Hello（计费）。",
        "test": _cloud_speech_test,
        "list_models": _cloud_list_voices,
    },
    "cartesia_tts": {
        "kind": "tts",
        "label": "Cartesia",
        "fields": [
            _field("api_key", "API Key", "password"),
            _field("model", "模型", "text", False, "sonic-3.6"),
        ],
        "notes": "Sonic 流式朗读，音色从账户分页拉取；沿用全客户端代理设置。",
        "test": _cloud_speech_test,
        "list_models": _cloud_list_voices,
    },
    "minimax_tts": {
        "kind": "tts",
        "label": "MiniMax（对照试听）",
        "fields": [
            _field("api_key", "API Key", "password"),
            _field("model", "模型", "text", False, "speech-2.8-turbo"),
        ],
        "notes": "仅目录试听，不进入默认朗读用途；试听为整句合成，供音质对照。",
        "test": _cloud_speech_test,
        "list_models": _cloud_list_voices,
    },
    "openai_tts": {
        "kind": "tts",
        "label": "OpenAI TTS（预留）",
        "fields": [
            dict(_KEY_FIELD),
            _field("api_base", "API Base", "url", False, "https://api.openai.com/v1"),
        ],
        "notes": "预留类型，暂未接入",
        "test": _not_implemented_test,
        "list_models": _not_implemented_models,
    },
    "kokoro": {
        "kind": "tts",
        "label": "Kokoro 本地（预留）",
        "fields": [_field("api_base", "API Base", "url", True, "http://localhost:8880")],
        "notes": "预留类型，暂未接入",
        "test": _not_implemented_test,
        "list_models": _not_implemented_models,
    },
    # ---- 保险箱通用秘密（模块 19）：不是供应商，没有 test / list_models，
    # 只是加密存着给人读出、给执行器填充 ----
    "password": {
        "kind": "secret",
        "label": "站点账号密码",
        "fields": [
            _field("url", "站点", "url", False, "https://www.coursera.org"),
            _field("username", "账号", "text", True, "邮箱或用户名"),
            _field("password", "密码", "password", True, ""),
            _field("totp_secret", "两步验证种子", "password", False, "otpauth 里的 secret，可留空"),
            _field("note", "备注", "text", False, ""),
        ],
        "notes": "电脑操控登录站点时按「填充」拿，值不经模型；人要看走「读出」，两者都记台账",
    },
    "bearer": {
        "kind": "secret",
        "label": "访问令牌（Bearer）",
        "fields": [
            _field("url", "用在哪", "url", False, "https://api.example.com"),
            _field("token", "令牌", "password", True, ""),
            _field("note", "备注", "text", False, ""),
        ],
        "notes": "扩展接 MCP 服务器、调外部 API 用的 Bearer / Personal Access Token",
    },
    "cookies": {
        "kind": "secret",
        "label": "浏览器 cookies",
        "fields": [
            _field("url", "站点", "url", False, "https://example.com"),
            _field(
                "cookies_text", "cookies.txt 内容", "password", True, "# Netscape HTTP Cookie File"
            ),
            _field("note", "备注", "text", False, ""),
        ],
        "notes": "站点登录态；YouTube 的那份仍在「YouTube 下载凭证」里，这里放其它站点",
    },
    "google_oauth_client": {
        "kind": "secret",
        "label": "Google OAuth 客户端",
        "fields": [
            _field("client_id", "Client ID", "text", True, "xxxx.apps.googleusercontent.com"),
            _field("client_secret", "Client Secret", "password", True, "GOCSPX-…"),
        ],
        "notes": "Google Cloud 里建一个「桌面应用」类型的 OAuth 客户端，只需要这一个；"
        "每个 Google 账号授权后各自的刷新令牌另存",
    },
    "google_account": {
        "kind": "oauth",
        "label": "Google 账号",
        "fields": [
            _field("email", "邮箱", "text", True, ""),
            _field("refresh_token", "刷新令牌", "password", True, ""),
        ],
        "notes": "由授权回调写入，不手填；重新授权会覆盖刷新令牌",
    },
    "youtube": {
        "kind": "video_source",
        "label": "YouTube 下载凭证",
        "fields": [
            _field(
                "cookies_text",
                "cookies.txt 内容",
                "password",
                False,
                "# Netscape HTTP Cookie File（浏览器插件 Get cookies.txt 导出后粘贴）",
            ),
            _field(
                "cookies_browser",
                "本机浏览器 cookies",
                "text",
                False,
                "chrome | safari | edge | firefox",
            ),
            _field("quality", "下载画质上限", "text", False, "1080"),
            _field("data_api_key", "Data API v3 Key", "password", False, "AIza..."),
        ],
        "notes": "cookies 三选一（内置登录窗自动维护 / 粘贴 cookies.txt / 读取本机浏览器登录态），"
        "都不配则受 YouTube bot 校验限制；Data API key 可选，配了则候选视频的时长/"
        "观看数/字幕标志走官方接口批量拉（毫秒级，1 unit/50 条），不配自动回退 yt-dlp；"
        "测试会真实拉取一条测试视频元数据；代理请在设置的网络与代理中配置",
        "test": _youtube_test,
        "list_models": _not_implemented_models,
    },
}


def provider_spec(provider_type: str) -> dict:
    spec = PROVIDER_TYPES.get(provider_type)
    if spec is None:
        raise CredentialError(f"未知供应商类型：{provider_type}")
    return spec


async def run_test(cred: ProviderCredential) -> dict:
    """按类型执行连通测试并回写状态字段（调用方负责 commit）。"""
    spec = provider_spec(cred.provider_type)
    result = await spec["test"](decrypt_config(cred.config), cred.provider_type)
    cred.status = "ok" if result["ok"] else "failed"
    cred.status_detail = None if result["ok"] else result["detail"]
    cred.last_tested_at = datetime.now(UTC)
    return result


async def probe_config(provider_type: str, config: dict) -> dict:
    """测试尚未保存的配置，不加密、不落库，也不改凭据状态。

    供应商自己的 ``test`` 实现仍是唯一协议事实源，因此草稿探测与保存后的
    “测试”按钮具有完全相同的网络行为和错误分型。
    """
    spec = provider_spec(provider_type)
    return await spec["test"](dict(config), provider_type)


async def refresh_models(cred: ProviderCredential) -> dict:
    """拉取上游模型/音色列表并落 models_cache（调用方负责 commit）。"""
    spec = provider_spec(cred.provider_type)
    try:
        items = await spec["list_models"](decrypt_config(cred.config), cred.provider_type)
    except httpx.HTTPError as exc:
        raise CredentialError(f"上游请求失败：{type(exc).__name__}: {exc}") from exc
    refreshed_at = datetime.now(UTC).isoformat()
    cred.models_cache = {"items": items, "refreshed_at": refreshed_at}
    return {"items": items, "count": len(items), "refreshed_at": refreshed_at}
