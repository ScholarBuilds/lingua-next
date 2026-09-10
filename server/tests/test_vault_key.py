from types import SimpleNamespace

import pytest
from cryptography.fernet import Fernet

from domain import vault_key


@pytest.fixture(autouse=True)
def clear_cached_key():
    vault_key.load_master_key.cache_clear()
    yield
    vault_key.load_master_key.cache_clear()


def test_keychain_backend_never_falls_back_to_file(monkeypatch) -> None:
    monkeypatch.setattr(
        vault_key,
        "get_settings",
        lambda: SimpleNamespace(vault_key_backend="keychain", config_key=""),
    )
    monkeypatch.setattr(vault_key, "_from_keyring", lambda: None)
    monkeypatch.setattr(vault_key, "_store_keyring", lambda _key: False)
    monkeypatch.setattr(
        vault_key,
        "_store_file",
        lambda _key: pytest.fail("desktop key must not be written to a file"),
    )

    with pytest.raises(RuntimeError, match="拒绝"):
        vault_key.load_master_key()


def test_keychain_backend_ignores_environment_key(monkeypatch) -> None:
    stored = Fernet.generate_key().decode()
    monkeypatch.setattr(
        vault_key,
        "get_settings",
        lambda: SimpleNamespace(vault_key_backend="keychain", config_key="environment-key"),
    )
    monkeypatch.setattr(vault_key, "_from_keyring", lambda: stored)

    assert vault_key.load_master_key() == (stored, "keychain")


def test_file_backend_is_explicit(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(
        vault_key,
        "get_settings",
        lambda: SimpleNamespace(vault_key_backend="file", config_key=""),
    )
    monkeypatch.setattr(vault_key, "key_file", lambda: tmp_path / "vault.key")

    key, source = vault_key.load_master_key()

    assert source == "file"
    assert Fernet(key.encode())
    assert (tmp_path / "vault.key").stat().st_mode & 0o777 == 0o600


def test_desktop_profile_uses_distinct_keychain_item(monkeypatch) -> None:
    monkeypatch.setattr(
        vault_key,
        "get_settings",
        lambda: SimpleNamespace(runtime_profile="desktop", vault_key_backend="keychain"),
    )

    assert vault_key._keyring_location() == (
        vault_key.DESKTOP_KEYRING_SERVICE,
        vault_key.DESKTOP_KEYRING_ACCOUNT,
    )
