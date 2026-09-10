import json
import os
import sqlite3
from pathlib import Path

from cryptography.fernet import Fernet
from starlette.testclient import TestClient

from app.desktop_runtime import (
    StartupTokenMiddleware,
    _configure_desktop_profile,
    _is_internal_mcp_request,
    _spa_response,
    rekey_sqlite_credentials,
)
from domain import vault_key
from domain.credentials import ENC_PREFIX


def test_startup_token_accepts_header_only() -> None:
    async def endpoint(scope, receive, send):
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    client = TestClient(StartupTokenMiddleware(endpoint, "secret"))
    assert client.get("/", headers={"X-Nexus-Startup-Token": "secret"}).status_code == 204
    client.cookies.set("nexus_startup", "secret")
    assert client.get("/").status_code == 401
    client.cookies.clear()
    assert client.get("/").status_code == 401
    assert (
        client.get(
            "/",
            headers={"X-Nexus-Startup-Token": "secret", "Origin": "https://attacker.test"},
        ).status_code
        == 403
    )


def test_desktop_profile_uses_local_vault_file(monkeypatch) -> None:
    monkeypatch.setenv("LINGUA_RUNTIME_PROFILE", "developer")
    monkeypatch.setenv("LINGUA_VAULT_KEY_BACKEND", "keychain")

    _configure_desktop_profile()

    assert os.environ["LINGUA_RUNTIME_PROFILE"] == "desktop"
    assert os.environ["LINGUA_VAULT_KEY_BACKEND"] == "file"


def test_startup_token_defers_only_shared_mcp_path_to_inner_bearer_guard() -> None:
    async def endpoint(scope, receive, send):
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    client = TestClient(StartupTokenMiddleware(endpoint, "secret"))
    assert client.post("/mcp").status_code == 204
    assert client.post("/mcp/desktop").status_code == 401
    assert client.post("/api/mcp/browser").status_code == 401
    assert client.post("/mcp/desktop/extra").status_code == 401
    assert not _is_internal_mcp_request(
        {"type": "http", "root_path": "/api", "path": "/api/mcp/desktop"}
    )
    assert (
        client.get(
            "/",
            headers={"X-Nexus-Startup-Token": "secret", "Origin": "http://testserver"},
        ).status_code
        == 204
    )


def test_spa_serves_asset_or_index_without_path_escape(tmp_path: Path) -> None:
    (tmp_path / "index.html").write_text("index", encoding="utf-8")
    (tmp_path / "app.js").write_text("asset", encoding="utf-8")
    assert isinstance(_spa_response(tmp_path, "app.js"), object)
    assert _spa_response(tmp_path, "unknown-route").path.name == "index.html"
    assert _spa_response(tmp_path, "../secret").status_code == 404


def test_rekey_sqlite_credentials_uses_desktop_key(monkeypatch, tmp_path: Path) -> None:
    database = tmp_path / "nexus.sqlite3"
    old_key = Fernet.generate_key().decode()
    new_key = Fernet.generate_key().decode()
    encrypted = ENC_PREFIX + Fernet(old_key.encode()).encrypt(b"secret").decode()
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE provider_credential (id INTEGER PRIMARY KEY, config JSON)")
        connection.execute(
            "INSERT INTO provider_credential (id, config) VALUES (?, ?)",
            (1, json.dumps({"api_key": encrypted, "api_base": "https://example.test"})),
        )
    monkeypatch.setattr(vault_key, "load_master_key", lambda: (new_key, "file"))

    result = rekey_sqlite_credentials(database, old_key)

    assert result == {"credentials": 1, "rows_rekeyed": 1, "fields_rekeyed": 1}
    with sqlite3.connect(database) as connection:
        row = connection.execute("SELECT config FROM provider_credential").fetchone()
        stored = json.loads(row[0])
    decrypted = Fernet(new_key.encode()).decrypt(
        stored["api_key"][len(ENC_PREFIX) :].encode()
    )
    assert decrypted == b"secret"


def test_rekey_sqlite_credentials_is_idempotent(monkeypatch, tmp_path: Path) -> None:
    database = tmp_path / "nexus.sqlite3"
    old_key = Fernet.generate_key().decode()
    new_key = Fernet.generate_key().decode()
    encrypted = ENC_PREFIX + Fernet(new_key.encode()).encrypt(b"secret").decode()
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE provider_credential (id INTEGER PRIMARY KEY, config JSON)")
        connection.execute(
            "INSERT INTO provider_credential (id, config) VALUES (?, ?)",
            (1, json.dumps({"api_key": encrypted})),
        )
    monkeypatch.setattr(vault_key, "load_master_key", lambda: (new_key, "file"))

    assert rekey_sqlite_credentials(database, old_key)["fields_rekeyed"] == 0
