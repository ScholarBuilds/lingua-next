import json
import sqlite3
import stat
from pathlib import Path

import pytest
from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import create_engine

from domain.credentials import ENC_PREFIX
from domain.desktop_config import apply_bundle, export_bundle
from domain.models import Base

SOURCE_KEY = Fernet.generate_key().decode()
LOCAL_KEY = Fernet.generate_key().decode()


def _fresh(path: Path) -> None:
    engine = create_engine(f"sqlite:///{path}")
    Base.metadata.create_all(engine)
    engine.dispose()


def _enc(key: str, plain: str) -> str:
    return ENC_PREFIX + Fernet(key.encode()).encrypt(plain.encode()).decode()


def _dec(key: str, stored: str) -> str:
    return Fernet(key.encode()).decrypt(stored[len(ENC_PREFIX) :].encode()).decode()


def _credential(con: sqlite3.Connection, cid: int, name: str, kind: str, config: dict) -> None:
    con.execute(
        "INSERT INTO provider_credential (id, name, kind, provider_type, config, enabled, status) "
        "VALUES (?, ?, ?, 'openai_compatible', ?, 1, 'ok')",
        (cid, name, kind, json.dumps(config)),
    )


def _seed_source(path: Path) -> None:
    con = sqlite3.connect(path)
    _credential(
        con,
        1,
        "DeepSeek 官方",
        "llm",
        {"api_key": _enc(SOURCE_KEY, "sk-dev"), "base_url": "https://api.deepseek.com"},
    )
    _credential(con, 2, "Edge TTS", "tts", {})
    _credential(
        con, 3, "someone@gmail.com", "oauth", {"refresh_token": _enc(SOURCE_KEY, "rt-secret")}
    )
    con.execute(
        "INSERT INTO model_deployment (id, credential_id, upstream_model_id, adapter_type, "
        "media_types, discovered, enabled, sort) "
        "VALUES (10, 1, 'deepseek-chat', 'openai', '[\"text\"]', 1, 1, 0)"
    )
    con.execute(
        "INSERT INTO capability_binding (id, capability, credential_id, deployment_id, target) "
        "VALUES (20, 'translate-fast', 1, 10, 'deepseek-chat')"
    )
    con.execute(
        "INSERT INTO capability_binding "
        "(id, capability, credential_id, deployment_id, target, params) "
        'VALUES (21, \'translate-chain\', NULL, NULL, NULL, \'{"chain": ["llm", "google"]}\')'
    )
    con.execute(
        "INSERT INTO word_voice (word, voice, rate) VALUES ('record', 'volc:en_female_x', 0)"
    )
    con.executemany(
        "INSERT INTO user_pref (key, value) VALUES (?, ?)",
        [
            ("theme", '"light"'),
            ("network", '{"address": "http://127.0.0.1:7890"}'),
            ("jarvis.memory", '["私事"]'),
            ("dict_search.build", '{"stamp": 1}'),
        ],
    )
    con.commit()
    con.close()


@pytest.fixture
def bundle(tmp_path):
    source = tmp_path / "dev.sqlite3"
    _fresh(source)
    _seed_source(source)
    out_db, out_key = tmp_path / "bundle.sqlite3", tmp_path / "bundle.key"
    result = export_bundle(source, SOURCE_KEY, out_db, out_key)
    return source, out_db, out_key, result


def test_export_excludes_personal_account_and_machine_prefs_and_rekeys(bundle):
    _source, out_db, out_key, result = bundle
    assert result["tables"] == {
        "provider_credential": 2,
        "model_deployment": 1,
        "capability_binding": 2,
        "word_voice": 1,
        "user_pref": 1,
    }
    assert result["fields_rekeyed"] == 1
    assert stat.S_IMODE(out_key.stat().st_mode) == 0o600
    bundle_key = out_key.read_text().strip()
    con = sqlite3.connect(out_db)
    stored = json.loads(
        con.execute("SELECT config FROM provider_credential WHERE id = 1").fetchone()[0]
    )
    assert _dec(bundle_key, stored["api_key"]) == "sk-dev"
    with pytest.raises(InvalidToken):
        _dec(SOURCE_KEY, stored["api_key"])
    assert [r[0] for r in con.execute("SELECT key FROM user_pref")] == ["theme"]
    assert (
        con.execute("SELECT count(*) FROM provider_credential WHERE kind = 'oauth'").fetchone()[0]
        == 0
    )
    con.close()


def test_export_can_include_personal_accounts(tmp_path):
    source = tmp_path / "dev.sqlite3"
    _fresh(source)
    _seed_source(source)
    result = export_bundle(
        source, SOURCE_KEY, tmp_path / "b.sqlite3", tmp_path / "b.key", include_personal=True
    )
    assert result["tables"]["provider_credential"] == 3 and result["fields_rekeyed"] == 2


def test_export_refuses_a_key_that_cannot_open_the_source(tmp_path):
    source = tmp_path / "dev.sqlite3"
    _fresh(source)
    _seed_source(source)
    with pytest.raises(RuntimeError, match="无法用旧或新主密钥解密"):
        export_bundle(
            source, Fernet.generate_key().decode(), tmp_path / "b.sqlite3", tmp_path / "b.key"
        )


def test_apply_into_empty_user_db_matches_source_and_uses_local_key(bundle, tmp_path):
    _source, out_db, out_key, _result = bundle
    target, stamp_file = tmp_path / "user.sqlite3", tmp_path / "config-stamp.json"
    _fresh(target)
    result = apply_bundle(target, out_db, out_key, LOCAL_KEY, stamp_file)
    assert result["skipped"] is False
    assert result["applied"] == {
        "provider_credential": 2,
        "model_deployment": 1,
        "capability_binding": 2,
        "word_voice": 1,
        "user_pref": 1,
    }
    con = sqlite3.connect(target)
    cred_id, stored = con.execute(
        "SELECT id, config FROM provider_credential WHERE name = 'DeepSeek 官方'"
    ).fetchone()
    assert _dec(LOCAL_KEY, json.loads(stored)["api_key"]) == "sk-dev"
    dep_id, dep_cred = con.execute(
        "SELECT id, credential_id FROM model_deployment WHERE upstream_model_id = 'deepseek-chat'"
    ).fetchone()
    assert dep_cred == cred_id
    assert con.execute(
        "SELECT credential_id, deployment_id FROM capability_binding "
        "WHERE capability = 'translate-fast'"
    ).fetchone() == (cred_id, dep_id)
    con.close()
    # 同一份包再启动：戳相同，什么都不做
    assert apply_bundle(target, out_db, out_key, LOCAL_KEY, stamp_file)["skipped"] is True


def test_apply_keeps_user_rows_and_remaps_ids_on_collision(bundle, tmp_path):
    _source, out_db, out_key, _result = bundle
    target, stamp_file = tmp_path / "user.sqlite3", tmp_path / "config-stamp.json"
    _fresh(target)
    con = sqlite3.connect(target)
    # 朋友自己已经建了 id=1 的凭据，并且把 translate-fast 绑到了自己的模型上
    _credential(con, 1, "朋友自己的中转", "llm", {"api_key": _enc(LOCAL_KEY, "sk-friend")})
    con.execute(
        "INSERT INTO model_deployment (id, credential_id, upstream_model_id, adapter_type, "
        "media_types, discovered, enabled, sort) "
        "VALUES (1, 1, 'gpt-x', 'openai', '[\"text\"]', 1, 1, 0)"
    )
    con.execute(
        "INSERT INTO capability_binding (capability, credential_id, deployment_id, target) "
        "VALUES ('translate-fast', 1, 1, 'gpt-x')"
    )
    con.execute("INSERT INTO user_pref (key, value) VALUES ('theme', '\"dark\"')")
    con.commit()
    con.close()

    result = apply_bundle(target, out_db, out_key, LOCAL_KEY, stamp_file)
    assert result["applied"]["provider_credential"] == 2
    assert (
        result["applied"]["capability_binding"] == 1
    )  # translate-chain 补进来，translate-fast 保留朋友的
    assert result["applied"]["user_pref"] == 0
    con = sqlite3.connect(target)
    rows = dict(con.execute("SELECT name, id FROM provider_credential"))
    assert rows["朋友自己的中转"] == 1 and rows["DeepSeek 官方"] > 1
    assert (
        _dec(
            LOCAL_KEY,
            json.loads(
                con.execute("SELECT config FROM provider_credential WHERE id = 1").fetchone()[0]
            )["api_key"],
        )
        == "sk-friend"
    )
    dep = con.execute(
        "SELECT credential_id FROM model_deployment WHERE upstream_model_id = 'deepseek-chat'"
    ).fetchone()
    assert dep == (rows["DeepSeek 官方"],)
    assert con.execute(
        "SELECT credential_id, deployment_id FROM capability_binding "
        "WHERE capability = 'translate-fast'"
    ).fetchone() == (1, 1)
    assert con.execute("SELECT value FROM user_pref WHERE key = 'theme'").fetchone() == ('"dark"',)
    con.close()
