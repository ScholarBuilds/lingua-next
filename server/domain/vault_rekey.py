"""凭据主密钥轮换：把 provider_credential 里用旧密钥加密的敏感字段改用新密钥。

逐字段处理：旧密钥能解的重加密，已经是新密钥的跳过，两把都解不开的直接报错——静默留下
一个解不开的字段，装好的包看着一切正常、用到那个供应商时才 502。桌面 sidecar 的
`--rekey-vault`（迁开发库凭据）与随包配置的导出 / 应用（domain/desktop_config）共用这一份。
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

from domain.credentials import ENC_PREFIX, SENSITIVE_FIELDS


def fernet_for(key: str, label: str) -> Fernet:
    try:
        return Fernet(key.strip().encode())
    except (TypeError, ValueError) as exc:
        raise RuntimeError(f"{label}格式无效") from exc


def rekey_credentials(connection: sqlite3.Connection, old_key: str, new_key: str) -> dict[str, int]:
    """在调用方开好的事务里重加密 main.provider_credential，提交由调用方负责。"""
    old_fernet = fernet_for(old_key, "旧凭据主密钥")
    new_fernet = fernet_for(new_key, "新凭据主密钥")
    rows_changed = 0
    fields_changed = 0
    rows = connection.execute("SELECT id, config FROM main.provider_credential").fetchall()
    for credential_id, stored_config in rows:
        config = json.loads(stored_config)
        changed = False
        for field in SENSITIVE_FIELDS:
            value = config.get(field)
            if not isinstance(value, str) or not value.startswith(ENC_PREFIX):
                continue
            token = value[len(ENC_PREFIX) :].encode()
            try:
                plain = old_fernet.decrypt(token)
            except InvalidToken:
                try:
                    new_fernet.decrypt(token)
                except InvalidToken as exc:
                    raise RuntimeError(
                        f"凭据 {credential_id} 的 {field} 无法用旧或新主密钥解密"
                    ) from exc
                continue
            config[field] = ENC_PREFIX + new_fernet.encrypt(plain).decode()
            fields_changed += 1
            changed = True
        if changed:
            connection.execute(
                "UPDATE main.provider_credential SET config = ? WHERE id = ?",
                (json.dumps(config, ensure_ascii=False), credential_id),
            )
            rows_changed += 1
    return {
        "credentials": len(rows),
        "rows_rekeyed": rows_changed,
        "fields_rekeyed": fields_changed,
    }


def rekey_sqlite_credentials(database: Path, old_key: str, new_key: str) -> dict[str, int]:
    connection = sqlite3.connect(database, isolation_level=None)
    try:
        connection.execute("BEGIN IMMEDIATE")
        result = rekey_credentials(connection, old_key, new_key)
        connection.execute("COMMIT")
    except Exception:
        if connection.in_transaction:
            connection.execute("ROLLBACK")
        raise
    finally:
        connection.close()
    return result
