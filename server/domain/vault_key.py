"""保险箱主密钥的来源（CR-007 模块 19，Q4 定为钥匙串）。

按序：环境变量 LINGUA_CONFIG_KEY（显式配置，Docker 与 CI 用）→ 系统钥匙串（macOS Keychain，
Linux 走 Secret Service）→ 本地文件 data/vault.key（钥匙串不可用时，0600）。
一个来源都没有时自动生成一把，优先写进钥匙串。

主密钥不随导出走：换机器要 ``POST /vault/export`` 带口令导出，再在新机器导入，
库里的密文对新机器的主密钥没有意义。
"""

from __future__ import annotations

import stat
from functools import lru_cache
from pathlib import Path

from cryptography.fernet import Fernet

from app.config import get_settings

LEGACY_KEYRING_SERVICE = "lingua-next"
LEGACY_KEYRING_ACCOUNT = "vault-master-key"
DESKTOP_KEYRING_SERVICE = "com.lingua.nexus.desktop"
DESKTOP_KEYRING_ACCOUNT = "vault-master-key-v1"


def _keyring_location() -> tuple[str, str]:
    settings = get_settings()
    if getattr(settings, "runtime_profile", "developer") == "desktop":
        return DESKTOP_KEYRING_SERVICE, DESKTOP_KEYRING_ACCOUNT
    return LEGACY_KEYRING_SERVICE, LEGACY_KEYRING_ACCOUNT


def key_file() -> Path:
    return Path(get_settings().media_root).resolve().parent / "vault.key"


def _from_keyring() -> str | None:
    import keyring
    from keyring.errors import KeyringError

    service, account = _keyring_location()
    try:
        return keyring.get_password(service, account)
    except KeyringError:
        return None


def _store_keyring(key: str) -> bool:
    import keyring
    from keyring.errors import KeyringError

    service, account = _keyring_location()
    try:
        Fernet(key.encode())
        keyring.set_password(service, account, key)
    except KeyringError:
        return False
    return True


def _from_file() -> str | None:
    path = key_file()
    if not path.is_file():
        return None
    return path.read_text(encoding="utf-8").strip() or None


def _store_file(key: str) -> None:
    path = key_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(key + "\n", encoding="utf-8")
    path.chmod(stat.S_IRUSR | stat.S_IWUSR)


@lru_cache
def load_master_key() -> tuple[str, str]:
    """返回 (密钥, 来源)，来源 ∈ env / keychain / file。"""
    settings = get_settings()
    backend = settings.vault_key_backend
    env = settings.config_key
    if env and backend in {"auto", "env"}:
        return env, "env"
    if backend == "env":
        raise RuntimeError("LINGUA_CONFIG_KEY 未配置，凭据库不可用")
    if backend in {"auto", "keychain"}:
        stored = _from_keyring()
        if stored:
            return stored, "keychain"
        fresh = Fernet.generate_key().decode()
        if _store_keyring(fresh):
            return fresh, "keychain"
        if backend == "keychain":
            raise RuntimeError("钥匙串不可用，拒绝把桌面版主密钥降级存入文件")
    stored = _from_file()
    if stored:
        return stored, "file"
    fresh = Fernet.generate_key().decode()
    _store_file(fresh)
    return fresh, "file"


def key_source() -> str:
    return load_master_key()[1]


def move_env_key_to_keychain() -> str:
    """把 .env 里的主密钥写进钥匙串，返回来源；之后从 .env 删掉那一行即可。"""
    env = get_settings().config_key
    if not env:
        raise RuntimeError("LINGUA_CONFIG_KEY 为空，没有可迁移的主密钥")
    if not _store_keyring(env):
        raise RuntimeError("钥匙串不可用（没有后端或被拒绝），主密钥仍留在 .env")
    load_master_key.cache_clear()
    return "keychain"


def install_current_key_in_keychain() -> str:
    """Keep the current vault key available to the self-contained desktop profile."""
    key, source = load_master_key()
    if source == "keychain":
        return source
    if not _store_keyring(key):
        raise RuntimeError("钥匙串不可用，不能把现有凭据安全迁入桌面版")
    return "keychain"
