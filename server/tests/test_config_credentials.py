"""配置中心凭据域测试：加解密、掩码、绑定候选解析、翻译链归一、参数构造、绑定保存、CLI 探测。"""

import json
from types import SimpleNamespace

import httpx
import pytest
from cryptography.fernet import Fernet
from sqlalchemy import select

import domain.credentials as credentials
from domain import cli_bridge
from domain.credentials import (
    ENC_PREFIX,
    CredentialError,
    decrypt_config,
    encrypt_config,
    mask,
    masked_config,
    normalize_chain,
    pick_candidate,
)
from domain.models import CapabilityBinding, ConfigAudit, ModelDeployment, ProviderCredential


class _FakeSettings:
    def __init__(self, key: str) -> None:
        self.config_key = key


@pytest.fixture(autouse=True)
def _config_key(monkeypatch):
    key = Fernet.generate_key().decode()
    monkeypatch.setattr(credentials, "get_settings", lambda: _FakeSettings(key))
    return key


def test_encrypt_roundtrip_only_sensitive_fields() -> None:
    plain = {"api_key": "sk-secret-1234567890", "api_base": "https://api.example.com/v1"}
    stored = encrypt_config(plain)
    assert stored["api_key"].startswith(ENC_PREFIX)
    assert stored["api_base"] == plain["api_base"]  # 非敏感字段不加密
    assert decrypt_config(stored) == plain


def test_volcengine_asset_keys_are_encrypted_and_masked() -> None:
    plain = {
        "api_key": "ark-api-key-1234567890",
        "access_key_id": "AKLT-access-id-123456",
        "secret_access_key": "volc-secret-access-key-123456",
        "project_name": "default",
        "region": "cn-beijing",
    }
    stored = encrypt_config(plain)
    assert stored["access_key_id"].startswith(ENC_PREFIX)
    assert stored["secret_access_key"].startswith(ENC_PREFIX)
    assert decrypt_config(stored) == plain
    assert set(masked_config(stored)) == {
        "api_key",
        "access_key_id",
        "secret_access_key",
    }


def test_encrypt_idempotent_no_double_encryption() -> None:
    stored = encrypt_config({"access_key": "AKLTsecretsecret1234"})
    twice = encrypt_config(stored)
    assert twice["access_key"] == stored["access_key"]
    assert decrypt_config(twice)["access_key"] == "AKLTsecretsecret1234"


def test_decrypt_with_wrong_key_raises(monkeypatch) -> None:
    stored = encrypt_config({"api_key": "sk-original-key-000111"})
    other = Fernet.generate_key().decode()
    monkeypatch.setattr(credentials, "get_settings", lambda: _FakeSettings(other))
    with pytest.raises(CredentialError, match="不匹配"):
        decrypt_config(stored)


def test_missing_config_key_raises(monkeypatch) -> None:
    monkeypatch.setattr(credentials, "get_settings", lambda: _FakeSettings(""))
    with pytest.raises(CredentialError, match="LINGUA_CONFIG_KEY"):
        encrypt_config({"api_key": "sk-abc-1234567890"})


def test_file_backend_uses_file_key_even_when_env_file_has_a_key(monkeypatch) -> None:
    file_key = Fernet.generate_key().decode()
    monkeypatch.setattr(
        credentials,
        "get_settings",
        lambda: SimpleNamespace(
            config_key=Fernet.generate_key().decode(), vault_key_backend="file"
        ),
    )
    monkeypatch.setattr("domain.vault_key.load_master_key", lambda: (file_key, "file"))

    stored = credentials.encrypt_value("secret")

    assert Fernet(file_key.encode()).decrypt(stored.removeprefix("enc:").encode()) == b"secret"


def test_mask_shapes() -> None:
    assert mask("sk-1234567890abcdefde") == "sk-12…efde"
    assert mask("short") == "sh…"  # 过短只留前2，避免反推


def test_masked_config_masks_plaintext_not_ciphertext() -> None:
    stored = encrypt_config(
        {"api_key": "test-api-key-53cafe9876543210efde", "api_base": "https://x/v1"}
    )
    masked = masked_config(stored)
    assert masked == {"api_key": "test-…efde"}  # 掩码基于明文；api_base 不出现


def _cred(cred_id: int, enabled: bool) -> ProviderCredential:
    return ProviderCredential(
        id=cred_id,
        name=f"c{cred_id}",
        kind="llm",
        provider_type="openai_compatible",
        config={},
        enabled=enabled,
    )


def test_pick_candidate_prefers_main_binding() -> None:
    creds = {1: _cred(1, True), 2: _cred(2, True)}
    picked = pick_candidate([(1, "a"), (2, "b")], creds)
    assert picked is not None and (picked[0].id, picked[1]) == (1, "a")


def test_pick_candidate_falls_back_when_disabled_or_deleted() -> None:
    creds = {2: _cred(2, True)}
    # 主绑定凭据已删除（不在 map 中）→ 落到 fallback
    picked = pick_candidate([(1, "a"), (2, "b")], creds)
    assert picked is not None and (picked[0].id, picked[1]) == (2, "b")
    # 主绑定停用 → 落到 fallback
    creds = {1: _cred(1, False), 2: _cred(2, True)}
    picked = pick_candidate([(1, "a"), (2, "b")], creds)
    assert picked is not None and picked[0].id == 2


def test_pick_candidate_exhausted_returns_none() -> None:
    creds = {1: _cred(1, False)}
    assert pick_candidate([(1, "a"), (None, None), (9, "x")], creds) is None


def test_normalize_chain_accepts_both_shapes() -> None:
    assert normalize_chain(["llm", "google"]) == ["llm", "google"]
    assert normalize_chain(
        [
            {"engine": "llm", "enabled": True},
            {"engine": "bing", "enabled": False},
            {"engine": "google"},
        ]
    ) == ["llm", "google"]
    assert normalize_chain(None) == []


async def test_gemini_model_discovery_keeps_exact_image_model_names(monkeypatch) -> None:
    requests: list[httpx.Request] = []
    real_client = httpx.AsyncClient

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            json={
                "models": [
                    {
                        "name": "models/gemini-2.5-flash-image",
                        "displayName": "Gemini 2.5 Flash Image",
                        "supportedGenerationMethods": ["generateContent"],
                    },
                    {
                        "name": "models/gemini-3-pro-image-preview",
                        "displayName": "Gemini 3 Pro Image Preview",
                        "supportedGenerationMethods": ["generateContent"],
                    },
                    {
                        "name": "models/gemini-2.5-pro",
                        "supportedGenerationMethods": ["generateContent"],
                    },
                ]
            },
        )

    def factory(**kwargs):
        return real_client(transport=httpx.MockTransport(handler), timeout=15.0)

    monkeypatch.setattr(credentials.httpx, "AsyncClient", factory)
    items = await credentials._gemini_fetch_models(  # noqa: SLF001 - 协议单测
        {"api_key": "secret"}, "gemini_image"
    )
    assert [item["id"] for item in items] == [
        "gemini-2.5-flash-image",
        "gemini-3-pro-image-preview",
    ]
    assert all(item["media_types"] == ["image"] for item in items)
    assert requests[0].headers["x-goog-api-key"] == "secret"


def test_video_provider_types_expose_executable_adapters() -> None:
    openai_video = credentials.provider_spec("openai_video")
    volcengine_video = credentials.provider_spec("volcengine_video")

    assert openai_video["kind"] == "video"
    assert openai_video["default_adapter"] == "openai"
    assert volcengine_video["kind"] == "video"
    assert volcengine_video["default_adapter"] == "volcengine"
    fields = {field["name"] for field in volcengine_video["fields"]}
    assert {
        "api_key",
        "api_base",
        "access_key_id",
        "secret_access_key",
        "project_name",
        "region",
    } <= fields


async def test_llm_probe_detects_agnes_json_mode_and_redacts_response(monkeypatch) -> None:
    real_client = httpx.AsyncClient
    api_key = "sk-sensitive-probe-key"

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/models"
        assert request.headers["authorization"] == f"Bearer {api_key}"
        return httpx.Response(
            200,
            json={
                "data": [{"id": "agnes-image-alpha"}],
                "debug_echo": api_key,
            },
        )

    def factory(**kwargs):
        return real_client(
            transport=httpx.MockTransport(handler),
            timeout=kwargs.get("timeout"),
            follow_redirects=kwargs.get("follow_redirects", False),
        )

    monkeypatch.setattr(credentials.httpx, "AsyncClient", factory)
    result = await credentials._llm_test(  # noqa: SLF001 - protocol probe unit test
        {"api_base": "https://apihub.agnes-ai.com", "api_key": api_key},
        "openai_compatible",
    )

    assert result["ok"] is True
    assert result["protocol"] == "openai"
    assert result["detected_adapter_type"] == "openai"
    assert result["image_request_mode"] == "openai-json"
    assert result["model_count"] == 1
    assert api_key not in result["raw_preview"]
    assert "***" in result["raw_preview"]


async def test_llm_probe_falls_back_to_non_generating_task_endpoint(monkeypatch) -> None:
    real_client = httpx.AsyncClient
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == "/v1/models":
            return httpx.Response(404, json={"message": "route not found"})
        return httpx.Response(404, json={"message": "task id not found"})

    def factory(**kwargs):
        return real_client(
            transport=httpx.MockTransport(handler),
            timeout=kwargs.get("timeout"),
            follow_redirects=kwargs.get("follow_redirects", False),
        )

    monkeypatch.setattr(credentials.httpx, "AsyncClient", factory)
    result = await credentials._llm_test(  # noqa: SLF001 - protocol probe unit test
        {"api_base": "https://api.apimart.ai/v1", "api_key": "test-key"},
        "apimart",
    )

    assert result["ok"] is True
    assert result["protocol"] == "apimart"
    assert result["detected_adapter_type"] == "apimart"
    assert result["model_count"] == 0
    assert [request.method for request in requests] == ["GET", "GET"]
    assert requests[1].url.path.endswith("/tasks/healthcheck_probe_do_not_submit")


async def test_llm_probe_rejects_html_login_page(monkeypatch) -> None:
    real_client = httpx.AsyncClient

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            text="<!doctype html><title>Sign in</title>",
            headers={"content-type": "text/html"},
        )

    def factory(**kwargs):
        return real_client(
            transport=httpx.MockTransport(handler),
            timeout=kwargs.get("timeout"),
            follow_redirects=kwargs.get("follow_redirects", False),
        )

    monkeypatch.setattr(credentials.httpx, "AsyncClient", factory)
    result = await credentials._llm_test(  # noqa: SLF001 - protocol probe unit test
        {"api_base": "https://gateway.example/v1", "api_key": "test-key"},
        "openai_compatible",
    )

    assert result["ok"] is False
    assert result["error_type"] == "api"
    assert "HTML" in result["detail"]
    assert "Sign in" in result["raw_preview"]


def test_local_cli_provider_types_expose_ready_adapters_and_media() -> None:
    codex = credentials.provider_spec("codex_cli")
    gemini = credentials.provider_spec("gemini_cli")
    jimeng = credentials.provider_spec("jimeng_cli")

    assert codex["default_adapter"] == "codex"
    assert codex["compatible_kinds"] == ["llm"]
    assert gemini["default_adapter"] == "gemini-cli"
    assert gemini["compatible_kinds"] == ["llm"]
    assert jimeng["default_adapter"] == "jimeng"
    assert jimeng["compatible_kinds"] == ["video"]
    models = cli_bridge.provider_models("jimeng_cli")
    assert {item["media_types"][0] for item in models} == {"image", "video"}


# ---- 绑定保存：直接指向一条部署，没有任何外部同步步骤 ----


async def _seed_binding_targets(
    session,
) -> tuple[ProviderCredential, ModelDeployment]:
    cred = ProviderCredential(
        name="gpt 中转",
        kind="llm",
        provider_type="openai_compatible",
        config=encrypt_config({"api_base": "https://gw.example/v1", "api_key": "sk-x-1234567890"}),
    )
    session.add(cred)
    await session.flush()
    direct = ModelDeployment(
        credential_id=cred.id,
        upstream_model_id="gpt-5.4-mini",
        adapter_type="openai",
        media_types=["chat"],
    )
    session.add(direct)
    await session.commit()
    return cred, direct


async def _binding_row(session, capability: str) -> CapabilityBinding:
    # 绑定由请求作用域的另一个 session 写入，按库里的值刷新身份映射
    return (
        await session.execute(
            select(CapabilityBinding)
            .where(CapabilityBinding.capability == capability)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()


async def test_put_binding_links_deployment_and_records_audit(client, session) -> None:
    _, direct = await _seed_binding_targets(session)

    resp = await client.put("/config/bindings/explain-standard", json={"deployment_id": direct.id})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["deployment_id"] == direct.id
    # 响应里不再有任何网关同步字段
    assert "gateway_sync" not in body

    row = await _binding_row(session, "explain-standard")
    assert row.deployment_id == direct.id
    audit = (await session.execute(select(ConfigAudit))).scalars().one()
    assert "explain-standard" in audit.summary


async def test_legacy_binding_infers_direct_adapter_from_provider_type(client, session) -> None:
    """旧式 credential + target 写法：一律落直连部署。"""
    deepseek = ProviderCredential(
        name="DeepSeek 官方",
        kind="llm",
        provider_type="deepseek",
        config=encrypt_config({"api_key": "sk-ds-1234567890"}),
    )
    ollama = ProviderCredential(
        name="本机 Ollama",
        kind="llm",
        provider_type="ollama",
        config={"api_base": "http://localhost:11434"},
    )
    session.add_all([deepseek, ollama])
    await session.commit()

    resp = await client.put(
        "/config/bindings/translate-fast",
        json={"credential_id": deepseek.id, "target": "deepseek-chat"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    created = await session.get(ModelDeployment, body["deployment_id"])
    assert created is not None
    assert created.adapter_type == "openai"
    assert created.media_types == ["chat"]
    assert created.discovered is False

    # Ollama 没有插件认领 provider_type，但它本身就是 OpenAI 兼容的：
    # 推断不出专属 adapter 时按 openai 直连落
    resp = await client.put(
        "/config/bindings/summary",
        json={"credential_id": ollama.id, "target": "qwen3"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    fallback = await session.get(ModelDeployment, body["deployment_id"])
    assert fallback is not None and fallback.adapter_type == "openai"


# ---- 本机 CLI 凭据自动探测（合同 C2）----


def _fake_bin(directory, *names: str) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    for name in names:
        exe = directory / name
        exe.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        exe.chmod(0o755)


@pytest.fixture
def _isolated_probe(monkeypatch, tmp_path):
    """把探测彻底关进 tmp：PATH 只剩伪造目录，兜底目录清空，HOME 指向 tmp。

    不隔离的话结果取决于跑测试这台机器上装没装 codex，两个分支各自只有一半概率跑到。
    """
    home = tmp_path / "home"
    home.mkdir()
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("PATH", str(bin_dir))
    monkeypatch.setattr(cli_bridge, "_EXTRA_BIN_DIRS", ())
    return home, bin_dir


def test_probe_codex_reports_paths_and_login_without_leaking_token(_isolated_probe) -> None:
    home, bin_dir = _isolated_probe
    _fake_bin(bin_dir, "codex", "gpt-image-2-skill")
    auth = home / ".codex" / "auth.json"
    auth.parent.mkdir(parents=True)
    auth.write_text(
        json.dumps({"auth_mode": "chatgpt", "tokens": {"access_token": "sk-live-000000secret"}}),
        encoding="utf-8",
    )

    result = cli_bridge.probe_provider("codex_cli").view()

    assert result["provider_type"] == "codex_cli"
    assert result["found"] is True
    assert result["logged_in"] is True
    assert result["remediation"] == []
    by_key = {item["key"]: item for item in result["fields"]}
    assert by_key["executable"]["detected"] == str(bin_dir / "codex")
    assert by_key["executable"]["source"] == "which"
    assert by_key["helper_executable"]["detected"] == str(bin_dir / "gpt-image-2-skill")
    assert by_key["auth_file"]["detected"] == str(auth)
    assert by_key["auth_file"]["source"] == "default_path"
    # 脱敏是硬要求：响应里只能有路径与布尔
    dumped = json.dumps(result, ensure_ascii=False)
    assert "sk-live-000000secret" not in dumped
    assert "sk-" not in dumped


def test_probe_codex_missing_gives_install_and_login_commands(_isolated_probe) -> None:
    result = cli_bridge.probe_provider("codex_cli").view()

    assert result["found"] is False
    assert result["logged_in"] is False
    assert all(item["detected"] is None for item in result["fields"])
    howtos = {item["problem"]: item["howto"] for item in result["remediation"]}
    assert howtos["未找到 Codex CLI"] == "npm i -g @openai/codex"
    assert howtos["未找到 gpt-image-2-skill"] == "npm i -g gpt-image-2-skill"


def test_probe_codex_login_prompt_when_installed_but_not_logged_in(_isolated_probe) -> None:
    _, bin_dir = _isolated_probe
    _fake_bin(bin_dir, "codex", "gpt-image-2-skill")

    result = cli_bridge.probe_provider("codex_cli").view()

    assert result["found"] is True
    assert result["logged_in"] is False
    assert result["remediation"] == [
        {"problem": "Codex 还没登录", "howto": "在终端跑 codex login"}
    ]


def test_probe_falls_back_to_common_bin_dirs_when_path_is_stripped(
    monkeypatch, tmp_path
) -> None:
    """launchd / 双击脚本拉起来的进程 PATH 只剩系统目录，which 找不到但文件就在那儿。"""
    home = tmp_path / "home"
    home.mkdir()
    extra = tmp_path / "opt-bin"
    _fake_bin(extra, "dreamina")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("PATH", str(tmp_path / "empty"))
    monkeypatch.setattr(cli_bridge, "_EXTRA_BIN_DIRS", (str(extra),))

    result = cli_bridge.probe_provider("jimeng_cli").view()

    assert result["found"] is True
    assert result["fields"][0]["detected"] == str(extra / "dreamina")
    assert result["fields"][0]["source"] == "path"
    # 即梦没有廉价的登录判据，不能拿 False 冒充「没登录」
    assert result["logged_in"] is None


def test_probe_gemini_reads_login_state_from_credential_file(_isolated_probe) -> None:
    home, bin_dir = _isolated_probe
    _fake_bin(bin_dir, "gemini")
    creds = home / ".gemini" / "google_accounts.json"
    creds.parent.mkdir(parents=True)
    creds.write_text(json.dumps({"active": "someone@example.com"}), encoding="utf-8")

    result = cli_bridge.probe_provider("gemini_cli").view()

    assert result["found"] is True
    assert result["logged_in"] is True
    assert result["remediation"] == []
    # 登录文件的内容不出去，只用它的存在性
    assert "someone@example.com" not in json.dumps(result, ensure_ascii=False)


def test_probe_rejects_provider_without_cli() -> None:
    with pytest.raises(cli_bridge.CliBridgeError) as exc_info:
        cli_bridge.probe_provider("openai")
    assert exc_info.value.kind == "input"


async def test_probe_endpoint_serves_cli_types_and_rejects_others(client, _isolated_probe) -> None:
    _, bin_dir = _isolated_probe
    _fake_bin(bin_dir, "codex")

    resp = await client.get("/config/credentials/probe", params={"provider_type": "codex_cli"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["found"] is True
    assert [item["key"] for item in body["fields"]] == [
        "executable",
        "helper_executable",
        "auth_file",
    ]
    # 装了 codex 但没登录、也没装 helper：两条都要给出具体的下一步命令
    assert {item["problem"] for item in body["remediation"]} == {
        "Codex 还没登录",
        "未找到 gpt-image-2-skill",
    }
    assert all(item["howto"].strip() for item in body["remediation"])

    resp = await client.get("/config/credentials/probe", params={"provider_type": "openai"})
    assert resp.status_code == 400


async def test_provider_types_flag_which_forms_should_auto_probe(client) -> None:
    """前端不该自己维护一份「哪些是本机 CLI」的名单。"""
    resp = await client.get("/config/provider-types")
    assert resp.status_code == 200, resp.text
    probeable = {item["provider_type"] for item in resp.json() if item["probeable"]}
    assert probeable == {"codex_cli", "gemini_cli", "jimeng_cli"}
