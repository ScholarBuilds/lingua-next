"""凭据保险箱（CR-007 模块 19）：秘密类型、访问台账、填充与读出、带口令的导出导入。

表还是 ``provider_credential``：它本来就是一张「加密 config 的凭据表」，泛化的是它装的东西
（站点密码、Bearer 令牌、cookies 也进来）和拿出去的方式：

- 读出（reveal）：人看，值回到浏览器；
- 填充（fill）：执行器拿去用（打进输入框、放进请求头），值不经模型上下文；
- 供应商调用（LLM / TTS）照旧走 ``credentials.get_decrypted``，不记台账——太密，记了也没人看。

前两种各记一行台账（``credential_access``）。
"""

from __future__ import annotations

import base64
import json
import os
from datetime import UTC, datetime

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from domain.credentials import (
    LLM_COMPAT_TYPES,
    SENSITIVE_FIELDS,
    VIDEO_COMPAT_TYPES,
    CredentialError,
    decrypt_config,
    encrypt_config,
    provider_spec,
)
from domain.models import CredentialAccess, ProviderCredential

# 秘密类型：保险箱按它分栏、UI 按它挑图标；oauth 留给模块 18 的 Google 账号
SECRET_KINDS = ("api_key", "oauth", "password", "cookies", "bearer", "totp", "login", "none")
SECRET_LABELS = {
    "api_key": "API Key",
    "oauth": "OAuth 令牌",
    "password": "账号密码",
    "cookies": "浏览器 cookies",
    "bearer": "访问令牌",
    "totp": "一次性口令",
    "login": "本机登录态",
    "none": "无密钥",
}
# 通用秘密的供应商类型（kind=secret），在保险箱页新建；模型供应商仍在设置 · 模型服务里加
SECRET_PROVIDER_TYPES = ("password", "bearer", "cookies", "google_oauth_client")
ACCESS_MODES = ("read", "fill", "export", "import")

EXPORT_FORMAT = "lingua-vault/1"
_SCRYPT_N = 2**15
_SCRYPT_R = 8
_SCRYPT_P = 1


def secret_kind(provider_type: str) -> str:
    """由供应商类型推出秘密类型：不在每个类型字典上再写一遍，字段名已经说明了它是什么。"""
    if provider_type == "google_account":
        return "oauth"
    if provider_type == "google_oauth_client":
        return "api_key"
    if provider_type in SECRET_PROVIDER_TYPES:
        return provider_type
    if provider_type in LLM_COMPAT_TYPES or provider_type in VIDEO_COMPAT_TYPES:
        return "login"
    fields = {f["name"] for f in provider_spec(provider_type)["fields"]}
    if "cookies_text" in fields:
        return "cookies"
    if fields & set(SENSITIVE_FIELDS):
        return "api_key"
    return "none"


def secret_fields(provider_type: str) -> list[str]:
    """这条凭据里哪些字段是秘密（可读出 / 可填充）。"""
    return [
        f["name"] for f in provider_spec(provider_type)["fields"] if f["name"] in SENSITIVE_FIELDS
    ]


def used_by_labels(
    cred: ProviderCredential, deployments: int, capabilities: list[str]
) -> list[str]:
    """谁在用：按种类推，不猜。"""
    if cred.provider_type == "google_oauth_client":
        return ["Google 账号授权"]
    if cred.kind == "oauth":
        return ["邮件", "日历"]
    if cred.kind == "secret":
        return ["电脑操控 · 只填充"]
    if cred.kind == "video_source":
        return ["视频下载"]
    labels: list[str] = []
    if deployments:
        labels.append(f"模型部署 {deployments}")
    if capabilities:
        labels.append(f"能力绑定 {len(capabilities)}")
    if not labels:
        labels.append(
            {"tts": "朗读", "realtime": "实时语音", "translate": "翻译"}.get(cred.kind, "模型服务")
        )
    return labels


async def record_access(
    session: AsyncSession,
    cred: ProviderCredential | None,
    mode: str,
    *,
    field: str | None = None,
    purpose: str,
) -> CredentialAccess:
    if mode not in ACCESS_MODES:
        raise ValueError(f"未知访问方式：{mode}")
    row = CredentialAccess(
        credential_id=cred.id if cred is not None else None,
        credential_name=cred.name if cred is not None else "",
        mode=mode,
        field=field,
        purpose=purpose,
    )
    session.add(row)
    return row


def _plain_field(cred: ProviderCredential, field: str) -> str:
    if field not in secret_fields(cred.provider_type):
        raise CredentialError(f"{field} 不是这条凭据的秘密字段")
    value = decrypt_config(cred.config).get(field)
    if not isinstance(value, str) or not value:
        raise CredentialError(f"{field} 为空")
    return value


async def reveal(
    session: AsyncSession, cred: ProviderCredential, field: str, *, purpose: str
) -> str:
    """读出：人看。记一行台账再返回明文。"""
    value = _plain_field(cred, field)
    await record_access(session, cred, "read", field=field, purpose=purpose)
    return value


async def fill(session: AsyncSession, credential_id: int, field: str, *, purpose: str) -> str:
    """填充：给执行器用。调用方只能拿去做「把它填进去」这个动作，不得进模型上下文。"""
    cred = await session.get(ProviderCredential, credential_id)
    if cred is None or not cred.enabled:
        raise CredentialError("凭据不存在或已停用")
    value = _plain_field(cred, field)
    await record_access(session, cred, "fill", field=field, purpose=purpose)
    return value


async def last_access_by_credential(session: AsyncSession) -> dict[int, CredentialAccess]:
    rows = (
        await session.execute(
            select(CredentialAccess)
            .where(CredentialAccess.credential_id.is_not(None))
            .order_by(CredentialAccess.created_at.desc(), CredentialAccess.id.desc())
        )
    ).scalars()
    latest: dict[int, CredentialAccess] = {}
    for row in rows:
        assert row.credential_id is not None
        latest.setdefault(row.credential_id, row)
    return latest


# ---- 导出 / 导入：口令派生 Fernet 密钥，主密钥不出本机 ----


def _passphrase_key(passphrase: str, salt: bytes) -> bytes:
    kdf = Scrypt(salt=salt, length=32, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P)
    return base64.urlsafe_b64encode(kdf.derive(passphrase.encode("utf-8")))


def export_bundle(rows: list[ProviderCredential], passphrase: str) -> bytes:
    if len(passphrase) < 8:
        raise CredentialError("导出口令至少 8 位")
    items = [
        {
            "name": row.name,
            "kind": row.kind,
            "provider_type": row.provider_type,
            "enabled": row.enabled,
            "config": decrypt_config(row.config),
        }
        for row in rows
    ]
    salt = os.urandom(16)
    payload = Fernet(_passphrase_key(passphrase, salt)).encrypt(
        json.dumps(items, ensure_ascii=False).encode("utf-8")
    )
    envelope = {
        "format": EXPORT_FORMAT,
        "exported_at": datetime.now(UTC).isoformat(),
        "count": len(items),
        "kdf": {
            "name": "scrypt",
            "salt": base64.b64encode(salt).decode(),
            "n": _SCRYPT_N,
            "r": _SCRYPT_R,
            "p": _SCRYPT_P,
        },
        "payload": payload.decode(),
    }
    return json.dumps(envelope, ensure_ascii=False, indent=1).encode("utf-8")


def import_bundle(raw: bytes, passphrase: str) -> list[dict]:
    try:
        envelope = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CredentialError("不是保险箱导出文件") from exc
    if not isinstance(envelope, dict) or envelope.get("format") != EXPORT_FORMAT:
        raise CredentialError("不是保险箱导出文件（format 不匹配）")
    kdf = envelope.get("kdf") or {}
    try:
        salt = base64.b64decode(kdf["salt"])
        key = _passphrase_key(passphrase, salt)
        plain = Fernet(key).decrypt(str(envelope["payload"]).encode())
    except (KeyError, ValueError, InvalidToken) as exc:
        raise CredentialError("口令不对，或文件已损坏") from exc
    items = json.loads(plain.decode("utf-8"))
    if not isinstance(items, list):
        raise CredentialError("导出内容形态不对")
    return items


async def import_items(session: AsyncSession, items: list[dict]) -> tuple[int, int]:
    """按 (provider_type, name) 去重；返回 (导入数, 跳过数)。"""
    existing = {
        (row.provider_type, row.name)
        for row in (await session.execute(select(ProviderCredential))).scalars()
    }
    imported = skipped = 0
    for item in items:
        try:
            spec = provider_spec(str(item.get("provider_type", "")))
        except CredentialError:
            skipped += 1
            continue
        name = str(item.get("name") or "").strip()
        if not name or (item["provider_type"], name) in existing:
            skipped += 1
            continue
        session.add(
            ProviderCredential(
                name=name,
                kind=str(item.get("kind") or spec["kind"]),
                provider_type=item["provider_type"],
                enabled=bool(item.get("enabled", True)),
                config=encrypt_config(dict(item.get("config") or {})),
            )
        )
        existing.add((item["provider_type"], name))
        imported += 1
    return imported, skipped
