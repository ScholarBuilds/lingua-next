"""凭据保险箱（CR-007 模块 19）：秘密类型推断、读出与填充记台账、带口令的导出导入、删改边界。"""

import io

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import select

import domain.credentials as credentials
from domain import vault
from domain.credentials import CredentialError, decrypt_config
from domain.models import CredentialAccess, ProviderCredential


class _FakeSettings:
    def __init__(self, key: str) -> None:
        self.config_key = key


@pytest.fixture(autouse=True)
def _config_key(monkeypatch):
    key = Fernet.generate_key().decode()
    monkeypatch.setattr(credentials, "get_settings", lambda: _FakeSettings(key))
    return key


def test_secret_kind_is_derived_from_provider_type() -> None:
    assert vault.secret_kind("password") == "password"
    assert vault.secret_kind("bearer") == "bearer"
    assert vault.secret_kind("cookies") == "cookies"
    assert vault.secret_kind("youtube") == "cookies"
    assert vault.secret_kind("deepseek") == "api_key"
    assert vault.secret_kind("volc_speech") == "api_key"
    assert vault.secret_kind("codex_cli") == "login"
    assert vault.secret_kind("edge_tts") == "none"


async def test_secret_types_only_list_vault_kinds(client) -> None:
    r = await client.get("/vault/secret-types")
    assert r.status_code == 200
    kinds = {t["provider_type"]: t["secret_kind"] for t in r.json()}
    assert kinds == {
        "password": "password",
        "bearer": "bearer",
        "cookies": "cookies",
        "google_oauth_client": "api_key",
    }


async def test_create_reveal_and_ledger(client, session) -> None:
    r = await client.post(
        "/vault/credentials",
        json={
            "name": "Coursera",
            "provider_type": "password",
            "config": {
                "url": "https://www.coursera.org",
                "username": "scholar",
                "password": "hunter2-long",
            },
        },
    )
    assert r.status_code == 201, r.text
    view = r.json()
    assert view["kind"] == "secret"
    assert view["secret_kind"] == "password"
    assert view["managed_in"] == "vault"
    assert view["masked"]["password"] != "hunter2-long"
    assert view["secret_fields"] == ["password", "totp_secret"]
    assert view["used_by"] == ["电脑操控 · 只填充"]

    stored = await session.get(ProviderCredential, view["id"])
    assert stored is not None
    assert stored.config["password"].startswith("enc:")
    assert decrypt_config(stored.config)["password"] == "hunter2-long"

    r = await client.post(f"/vault/credentials/{view['id']}/reveal", json={"field": "password"})
    assert r.status_code == 200
    assert r.json() == {"field": "password", "value": "hunter2-long"}
    # 非秘密字段不给读：username 是明文列，不该走读出这条路
    r = await client.post(f"/vault/credentials/{view['id']}/reveal", json={"field": "username"})
    assert r.status_code == 400

    r = await client.get(f"/vault/credentials/{view['id']}/access")
    assert [(e["mode"], e["field"], e["purpose"]) for e in r.json()] == [
        ("read", "password", "vault.reveal")
    ]

    listed = (await client.get("/vault/credentials")).json()
    mine = next(item for item in listed if item["id"] == view["id"])
    assert mine["last_access"]["mode"] == "read"


async def test_fill_is_ledgered_separately_and_refuses_disabled(client, session) -> None:
    r = await client.post(
        "/vault/credentials",
        json={"name": "GitHub", "provider_type": "bearer", "config": {"token": "ghp_secret_token"}},
    )
    cid = r.json()["id"]
    value = await vault.fill(session, cid, "token", purpose="computer-use")
    await session.commit()
    assert value == "ghp_secret_token"
    modes = (await session.execute(select(CredentialAccess.mode))).scalars().all()
    assert modes == ["fill"]

    await client.patch(f"/vault/credentials/{cid}", json={"enabled": False})
    with pytest.raises(CredentialError):
        await vault.fill(session, cid, "token", purpose="computer-use")


async def test_model_credentials_are_managed_in_settings(client) -> None:
    r = await client.post(
        "/config/credentials",
        json={
            "name": "DS",
            "kind": "llm",
            "provider_type": "deepseek",
            "config": {"api_key": "sk-1234567890abcd"},
        },
    )
    assert r.status_code == 201, r.text
    cid = r.json()["id"]
    listed = (await client.get("/vault/credentials")).json()
    mine = next(item for item in listed if item["id"] == cid)
    assert mine["managed_in"] == "settings"
    assert mine["secret_kind"] == "api_key"
    assert (await client.delete(f"/vault/credentials/{cid}")).status_code == 409
    assert (
        await client.patch(f"/vault/credentials/{cid}", json={"config": {"api_key": "x"}})
    ).status_code == 409
    # 读出对模型凭据同样开放，也同样记台账
    r = await client.post(f"/vault/credentials/{cid}/reveal", json={"field": "api_key"})
    assert r.json()["value"] == "sk-1234567890abcd"
    r = await client.post(
        "/vault/credentials", json={"name": "x", "provider_type": "deepseek", "config": {}}
    )
    assert r.status_code == 400


async def test_retired_provider_does_not_break_vault_listing(client, session) -> None:
    retired = ProviderCredential(
        name="旧实时语音",
        kind="realtime",
        provider_type="volc_duplex",
        config=credentials.encrypt_config({"api_key": "retired-secret"}),
        enabled=False,
    )
    session.add(retired)
    await session.commit()

    response = await client.get("/vault/credentials")

    assert response.status_code == 200
    item = next(row for row in response.json() if row["id"] == retired.id)
    assert item["provider_label"] == "volc_duplex（已停用）"
    assert item["secret_kind"] == "none"
    assert item["secret_fields"] == []


async def test_patch_keeps_secret_when_left_blank(client, session) -> None:
    r = await client.post(
        "/vault/credentials",
        json={
            "name": "Site",
            "provider_type": "password",
            "config": {"username": "a", "password": "old-password"},
        },
    )
    cid = r.json()["id"]
    r = await client.patch(
        f"/vault/credentials/{cid}",
        json={"name": "Site 2", "config": {"password": "", "username": "b"}},
    )
    assert r.status_code == 200
    row = await session.get(ProviderCredential, cid)
    await session.refresh(row)
    plain = decrypt_config(row.config)
    assert row.name == "Site 2"
    assert plain["username"] == "b"
    assert plain["password"] == "old-password"


async def test_export_import_roundtrip_with_passphrase(client, session) -> None:
    await client.post(
        "/vault/credentials",
        json={
            "name": "Coursera",
            "provider_type": "password",
            "config": {"username": "s", "password": "plain-secret-that-must-not-leak"},
        },
    )
    r = await client.post("/vault/export", json={"passphrase": "short"})
    assert r.status_code == 422  # 口令长度由请求体校验兜住
    r = await client.post("/vault/export", json={"passphrase": "correct horse battery"})
    assert r.status_code == 200
    assert r.headers["content-disposition"].startswith("attachment;")
    bundle = r.content
    assert b"plain-secret-that-must-not-leak" not in bundle

    wrong = await client.post(
        "/vault/import",
        files={"file": ("v.json", io.BytesIO(bundle), "application/json")},
        data={"passphrase": "wrong passphrase"},
    )
    assert wrong.status_code == 400

    ok = await client.post(
        "/vault/import",
        files={"file": ("v.json", io.BytesIO(bundle), "application/json")},
        data={"passphrase": "correct horse battery"},
    )
    assert ok.status_code == 200
    # 同名同类型已存在：跳过而不是复制一份
    assert ok.json() == {"imported": 0, "skipped": 1}

    await session.execute(ProviderCredential.__table__.delete())
    await session.commit()
    again = await client.post(
        "/vault/import",
        files={"file": ("v.json", io.BytesIO(bundle), "application/json")},
        data={"passphrase": "correct horse battery"},
    )
    assert again.json() == {"imported": 1, "skipped": 0}
    row = (await session.execute(select(ProviderCredential))).scalar_one()
    assert row.name == "Coursera"
    assert decrypt_config(row.config)["password"] == "plain-secret-that-must-not-leak"
    modes = (
        (await session.execute(select(CredentialAccess.mode).order_by(CredentialAccess.id)))
        .scalars()
        .all()
    )
    assert modes == ["export", "import", "import"]


async def test_delete_secret(client) -> None:
    r = await client.post(
        "/vault/credentials",
        json={
            "name": "Tmp",
            "provider_type": "cookies",
            "config": {"cookies_text": "# Netscape\nfoo"},
        },
    )
    cid = r.json()["id"]
    assert (await client.delete(f"/vault/credentials/{cid}")).status_code == 200
    assert (await client.delete(f"/vault/credentials/{cid}")).status_code == 404


async def test_status_reports_env_when_key_is_explicit(client, monkeypatch) -> None:
    from app import config as app_config
    from app.routers import vault as vault_router

    class _S:
        config_key = "explicit"
        vault_key_backend = "auto"

    monkeypatch.setattr(vault_router, "get_settings", lambda: _S())
    assert app_config is not None
    r = await client.get("/vault/status")
    assert r.status_code == 200
    assert r.json()["key_source"] == "env"
