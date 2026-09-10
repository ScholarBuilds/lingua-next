"""随包的配置（CR-012 §6.16 第四轮，2026-09-05）。

模型 / 语音 / 生图凭据、模型部署、能力绑定、按词音色与设置项。

scholar 要朋友装好就和自己的开发环境一模一样，所以配置随包，分两段：
- 导出（打包时）：从开发用桌面库挑出配置行写进一个小 SQLite，敏感字段从开发主密钥换成一把
  随机生成的包密钥，库与密钥一起进安装包；开发主密钥本身不出本机。
- 应用（sidecar 启动时）：配置库与包密钥的哈希当戳，戳变了就按名字合并进用户库——缺的补、
  已有的不动（朋友自己改过的凭据与绑定不会被包盖掉），凭据与部署的 id 重新分配、外键跟着改；
  然后把包密钥加密的字段换成本机主密钥，包密钥只在这一步被读。

不随包的：个人账号的刷新令牌（Gmail，kind=oauth）、贾维斯记忆、代理地址这类只属于这台机器的事实。
"""

from __future__ import annotations

import hashlib
import sqlite3
import stat
from pathlib import Path

from cryptography.fernet import Fernet
from sqlalchemy import create_engine

from domain.desktop_content import read_stamp, write_stamp
from domain.models import (
    Base,
    CapabilityBinding,
    ModelDeployment,
    ProviderCredential,
    UserPref,
    WordVoice,
)
from domain.vault_rekey import rekey_credentials

CONFIG_TABLES = (
    "provider_credential",
    "model_deployment",
    "capability_binding",
    "word_voice",
    "user_pref",
)
# 个人账号（Gmail 刷新令牌）默认不随包：给朋友的是配置，不是 scholar 的邮箱
PERSONAL_CREDENTIAL_KINDS = ("oauth",)
# 贾维斯记忆是 scholar 的对话史；查词索引标记随内容基线走；代理地址与缓存纪元是这台机器的事实——
# `network` 装到别人机器上会把所有上游请求送进一个不存在的 127.0.0.1:7890
EXCLUDED_PREF_KEYS = ("jarvis.memory", "dict_search.build", "network", "tts.cache_epoch")


def _columns(connection: sqlite3.Connection, schema: str, table: str) -> list[str]:
    return [row[1] for row in connection.execute(f"PRAGMA {schema}.table_info({table})")]


def _shared_columns(connection: sqlite3.Connection, table: str) -> list[str]:
    src = set(_columns(connection, "src", table))
    return [c for c in _columns(connection, "main", table) if c in src]


def _rollback_if_open(connection: sqlite3.Connection) -> None:
    if connection.in_transaction:
        connection.execute("ROLLBACK")


def export_bundle(
    source_db: Path,
    source_key: str,
    out_db: Path,
    out_key_file: Path,
    *,
    include_personal: bool = False,
) -> dict:
    """从开发库导出配置到 `out_db`，敏感字段换成写进 `out_key_file` 的新包密钥。"""
    if out_db.exists():
        out_db.unlink()
    engine = create_engine(f"sqlite:///{out_db}")
    Base.metadata.create_all(
        engine,
        tables=[
            ProviderCredential.__table__,
            ModelDeployment.__table__,
            CapabilityBinding.__table__,
            WordVoice.__table__,
            UserPref.__table__,
        ],
    )
    engine.dispose()
    bundle_key = Fernet.generate_key().decode()
    counts: dict[str, int] = {}
    connection = sqlite3.connect(out_db, isolation_level=None)
    try:
        connection.execute("PRAGMA foreign_keys=OFF")
        connection.execute("ATTACH DATABASE ? AS src", (str(source_db),))
        connection.execute("BEGIN")
        kinds = () if include_personal else PERSONAL_CREDENTIAL_KINDS
        kind_filter = f" WHERE kind NOT IN ({','.join('?' * len(kinds))})" if kinds else ""
        cols = ", ".join(_shared_columns(connection, "provider_credential"))
        counts["provider_credential"] = connection.execute(
            f"INSERT INTO main.provider_credential ({cols}) "
            f"SELECT {cols} FROM src.provider_credential{kind_filter}",
            list(kinds),
        ).rowcount
        cols = ", ".join(_shared_columns(connection, "model_deployment"))
        counts["model_deployment"] = connection.execute(
            f"INSERT INTO main.model_deployment ({cols}) SELECT {cols} FROM src.model_deployment "
            "WHERE credential_id IN (SELECT id FROM main.provider_credential)"
        ).rowcount
        cols = ", ".join(_shared_columns(connection, "capability_binding"))
        counts["capability_binding"] = connection.execute(
            f"INSERT INTO main.capability_binding ({cols}) "
            f"SELECT {cols} FROM src.capability_binding "
            "WHERE (credential_id IS NULL "
            "OR credential_id IN (SELECT id FROM main.provider_credential)) "
            "AND (deployment_id IS NULL "
            "OR deployment_id IN (SELECT id FROM main.model_deployment))"
        ).rowcount
        cols = ", ".join(_shared_columns(connection, "word_voice"))
        counts["word_voice"] = connection.execute(
            f"INSERT INTO main.word_voice ({cols}) SELECT {cols} FROM src.word_voice"
        ).rowcount
        cols = ", ".join(_shared_columns(connection, "user_pref"))
        placeholders = ",".join("?" * len(EXCLUDED_PREF_KEYS))
        counts["user_pref"] = connection.execute(
            f"INSERT INTO main.user_pref ({cols}) SELECT {cols} FROM src.user_pref "
            f"WHERE key NOT IN ({placeholders})",
            list(EXCLUDED_PREF_KEYS),
        ).rowcount
        connection.execute("COMMIT")
        connection.execute("DETACH DATABASE src")
        connection.execute("BEGIN")
        rekeyed = rekey_credentials(connection, source_key, bundle_key)
        connection.execute("COMMIT")
    except Exception:
        _rollback_if_open(connection)
        raise
    finally:
        connection.close()
    out_key_file.write_text(bundle_key + "\n", encoding="utf-8")
    out_key_file.chmod(stat.S_IRUSR | stat.S_IWUSR)
    return {"tables": counts, **rekeyed}


def bundle_stamp(bundle_db: Path, key_file: Path) -> str:
    digest = hashlib.sha256()
    for path in (bundle_db, key_file):
        digest.update(path.read_bytes())
    return digest.hexdigest()


def _merge_credentials(connection: sqlite3.Connection, counts: dict[str, int]) -> dict[int, int]:
    existing = {
        name: cid
        for cid, name in connection.execute("SELECT id, name FROM main.provider_credential")
    }
    cols = [c for c in _shared_columns(connection, "provider_credential") if c != "id"]
    joined = ", ".join(cols)
    placeholders = ", ".join("?" * len(cols))
    name_idx = cols.index("name")
    mapping: dict[int, int] = {}
    rows = connection.execute(
        f"SELECT id, {joined} FROM src.provider_credential ORDER BY id"
    ).fetchall()
    for row in rows:
        src_id, values = row[0], list(row[1:])
        name = values[name_idx]
        if name in existing:
            mapping[src_id] = existing[name]
            continue
        cursor = connection.execute(
            f"INSERT INTO main.provider_credential ({joined}) VALUES ({placeholders})", values
        )
        mapping[src_id] = existing[name] = cursor.lastrowid
        counts["provider_credential"] += 1
    return mapping


def _merge_deployments(
    connection: sqlite3.Connection, cred_map: dict[int, int], counts: dict[str, int]
) -> dict[int, int]:
    existing = {
        (cred, model, adapter): did
        for did, cred, model, adapter in connection.execute(
            "SELECT id, credential_id, upstream_model_id, adapter_type FROM main.model_deployment"
        )
    }
    cols = [c for c in _shared_columns(connection, "model_deployment") if c != "id"]
    joined = ", ".join(cols)
    placeholders = ", ".join("?" * len(cols))
    cred_idx, model_idx, adapter_idx = (
        cols.index("credential_id"),
        cols.index("upstream_model_id"),
        cols.index("adapter_type"),
    )
    mapping: dict[int, int] = {}
    rows = connection.execute(
        f"SELECT id, {joined} FROM src.model_deployment ORDER BY id"
    ).fetchall()
    for row in rows:
        src_id, values = row[0], list(row[1:])
        cred = cred_map.get(values[cred_idx])
        if cred is None:
            continue
        values[cred_idx] = cred
        key = (cred, values[model_idx], values[adapter_idx])
        if key in existing:
            mapping[src_id] = existing[key]
            continue
        cursor = connection.execute(
            f"INSERT INTO main.model_deployment ({joined}) VALUES ({placeholders})", values
        )
        mapping[src_id] = existing[key] = cursor.lastrowid
        counts["model_deployment"] += 1
    return mapping


def _merge_bindings(
    connection: sqlite3.Connection,
    cred_map: dict[int, int],
    dep_map: dict[int, int],
    counts: dict[str, int],
) -> None:
    existing = {
        row[0] for row in connection.execute("SELECT capability FROM main.capability_binding")
    }
    cols = [c for c in _shared_columns(connection, "capability_binding") if c != "id"]
    joined = ", ".join(cols)
    placeholders = ", ".join("?" * len(cols))
    cap_idx, cred_idx, dep_idx = (
        cols.index("capability"),
        cols.index("credential_id"),
        cols.index("deployment_id"),
    )
    rows = connection.execute(
        f"SELECT id, {joined} FROM src.capability_binding ORDER BY id"
    ).fetchall()
    for row in rows:
        values = list(row[1:])
        if values[cap_idx] in existing:
            continue
        # 绑定指向的凭据 / 部署在上面没合并进来（理论上不会），照 ON DELETE SET NULL 的口径落空
        values[cred_idx] = cred_map.get(values[cred_idx]) if values[cred_idx] is not None else None
        values[dep_idx] = dep_map.get(values[dep_idx]) if values[dep_idx] is not None else None
        connection.execute(
            f"INSERT INTO main.capability_binding ({joined}) VALUES ({placeholders})", values
        )
        existing.add(values[cap_idx])
        counts["capability_binding"] += 1


def apply_bundle(
    database: Path,
    bundle_db: Path,
    key_file: Path,
    local_key: str,
    stamp_file: Path,
) -> dict:
    """把包内配置合并进用户库（只补缺），再把包密钥加密的字段换成本机主密钥；戳相同直接返回。"""
    stamp = bundle_stamp(bundle_db, key_file)
    if read_stamp(stamp_file) == stamp:
        return {"skipped": True, "stamp": stamp}
    bundle_key = key_file.read_text(encoding="utf-8").strip()
    counts = {table: 0 for table in CONFIG_TABLES}
    connection = sqlite3.connect(database, isolation_level=None)
    try:
        connection.execute("PRAGMA foreign_keys=OFF")
        connection.execute("ATTACH DATABASE ? AS src", (str(bundle_db),))
        connection.execute("BEGIN")
        cred_map = _merge_credentials(connection, counts)
        dep_map = _merge_deployments(connection, cred_map, counts)
        _merge_bindings(connection, cred_map, dep_map, counts)
        for table in ("word_voice", "user_pref"):
            cols = ", ".join(_shared_columns(connection, table))
            counts[table] = connection.execute(
                f"INSERT OR IGNORE INTO main.{table} ({cols}) SELECT {cols} FROM src.{table}"
            ).rowcount
        connection.execute("COMMIT")
        connection.execute("DETACH DATABASE src")
        connection.execute("BEGIN")
        rekeyed = rekey_credentials(connection, bundle_key, local_key)
        connection.execute("COMMIT")
    except Exception:
        _rollback_if_open(connection)
        raise
    finally:
        connection.close()
    write_stamp(stamp_file, stamp, {"applied": counts, "fields_rekeyed": rekeyed["fields_rekeyed"]})
    return {"skipped": False, "stamp": stamp, "applied": counts, **rekeyed}
