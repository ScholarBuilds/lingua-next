"""/llm/test 插件层探针、/usage/summary 台账聚合、seed 脚本直连建档（内存 SQLite，不出网）。

三条链路共同点：都只认 capability_binding 指向的部署。探针经 prepare_chat_route 打到
绑定的部署（AsyncOpenAI 打桩），能力没绑定部署时直接报「未绑定」；用量只从
model_invocation 本地台账聚合；seed 脚本建出 adapter=openai 的部署与 deployment_id 绑定。
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from cryptography.fernet import Fernet
from openai import (
    APIConnectionError,
    APITimeoutError,
    AuthenticationError,
    PermissionDeniedError,
    RateLimitError,
)
from sqlalchemy import select

import domain.credentials as credentials
import domain.model_runtime as model_runtime
from app.routers import llm_admin, usage
from domain.model_runtime import prepare_chat_route
from domain.models import (
    AnalysisResult,
    CapabilityBinding,
    ModelDeployment,
    ModelInvocation,
    ProviderCredential,
)
from scripts import seed_config

# ---- 公共桩 ----


class FakeOpenAI:
    """替身 AsyncOpenAI：记录构造参数与请求，按配置返回内容或抛异常。"""

    clients: list[dict] = []
    calls: list[dict] = []
    content: str | None = "pong"
    error: BaseException | None = None

    def __init__(self, **kwargs):
        type(self).clients.append(kwargs)
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    async def _create(self, **kwargs):
        type(self).calls.append(kwargs)
        if type(self).error is not None:
            raise type(self).error
        return SimpleNamespace(
            id="probe-req-1",
            model="pong-model",
            usage=SimpleNamespace(
                model_dump=lambda **_: {"prompt_tokens": 3, "completion_tokens": 1}
            ),
            choices=[SimpleNamespace(message=SimpleNamespace(content=type(self).content))],
        )

    async def close(self):
        return None


@pytest.fixture
def fake_openai(monkeypatch):
    FakeOpenAI.clients = []
    FakeOpenAI.calls = []
    FakeOpenAI.content = "pong"
    FakeOpenAI.error = None
    monkeypatch.setattr(model_runtime, "AsyncOpenAI", FakeOpenAI)
    return FakeOpenAI


async def _seed_direct_chat(session, *, enabled: bool = True) -> ModelDeployment:
    credential = ProviderCredential(
        name="OpenAI 兼容直连",
        kind="llm",
        provider_type="openai_compatible",
        config={"api_base": "https://direct.example/v1", "api_key": "sk-direct-test"},
    )
    session.add(credential)
    await session.flush()
    deployment = ModelDeployment(
        credential_id=credential.id,
        upstream_model_id="direct-chat-model",
        adapter_type="openai",
        media_types=["chat"],
        enabled=enabled,
    )
    session.add(deployment)
    await session.flush()
    session.add(
        CapabilityBinding(
            capability="explain-standard",
            credential_id=credential.id,
            deployment_id=deployment.id,
            target=deployment.upstream_model_id,
        )
    )
    await session.commit()
    return deployment


async def _invocation_rows(session) -> list[ModelInvocation]:
    return list((await session.execute(select(ModelInvocation))).scalars())


def _request() -> httpx.Request:
    return httpx.Request("POST", "https://direct.example/v1/chat/completions")


def _status_error(cls, code: int, message: str):
    return cls(message, response=httpx.Response(code, request=_request()), body=None)


# ---- /llm/test 经插件层 ----


async def test_probe_direct_deployment_succeeds_and_records_probe_source(
    client, session, fake_openai
) -> None:
    deployment = await _seed_direct_chat(session)

    resp = await client.post("/llm/test", json={"alias": "explain-standard"})

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["error_type"] is None
    assert body["plugin_id"] == "openai"
    assert body["selection_source"] == "binding"
    assert body["deployment_id"] == deployment.id
    assert body["model"] == "pong-model"
    assert body["sample"] == "pong"
    assert body["usage"] == {"prompt_tokens": 3, "completion_tokens": 1}
    assert isinstance(body["latency_ms"], int)
    # 直连：客户端打上游而不是网关，模型名是上游真名
    assert fake_openai.clients[0]["base_url"] == "https://direct.example/v1"
    assert fake_openai.clients[0]["api_key"] == "sk-direct-test"
    assert fake_openai.calls[0]["model"] == "direct-chat-model"
    assert fake_openai.calls[0]["messages"][-1] == {"role": "user", "content": "ping"}

    rows = await _invocation_rows(session)
    assert len(rows) == 1
    row = rows[0]
    assert row.source == "probe"
    assert row.status == "succeeded"
    assert row.plugin_id == "openai"
    assert row.capability == "explain-standard"
    assert row.deployment_id == deployment.id
    assert row.provider_request_id == "probe-req-1"
    assert row.usage == {"prompt_tokens": 3, "completion_tokens": 1}
    assert "sk-direct-test" not in str(row.request)


async def test_probe_unbound_capability_says_unbound_not_connection_refused(
    client, session, fake_openai
) -> None:
    """没有部署行时不再回落网关别名。

    回落的年代这里会去连 127.0.0.1:4000（默认根本没启动的容器），用户看到「连接被拒绝」
    而真实原因是这条能力没配模型——错误信息指向完全错误的方向。现在直接报未绑定，
    一个字节都不发出去。
    """
    resp = await client.post("/llm/test", json={"alias": "explain-standard"})

    body = resp.json()
    assert body["ok"] is False
    assert body["error_type"] == "route"
    assert "尚未绑定模型" in body["error"] and "explain-standard" in body["error"]
    assert body["plugin_id"] is None
    assert fake_openai.clients == [] and fake_openai.calls == []

    rows = await _invocation_rows(session)
    assert [(r.plugin_id, r.source, r.status) for r in rows] == [("unresolved", "probe", "failed")]


@pytest.mark.parametrize(
    ("error", "expected_type", "fragment"),
    [
        (APITimeoutError(request=_request()), "timeout", "timed out"),
        (APIConnectionError(request=_request()), "connect", "Connection error"),
        (httpx.ConnectTimeout("connect timed out"), "timeout", "connect timed out"),
        (httpx.ConnectError("refused"), "connect", "refused"),
        (_status_error(AuthenticationError, 401, "bad key"), "auth", "HTTP 401"),
        (_status_error(PermissionDeniedError, 403, "forbidden"), "auth", "HTTP 403"),
        (_status_error(RateLimitError, 429, "slow down"), "status", "HTTP 429"),
    ],
)
async def test_probe_classifies_failures_and_records_them(
    client, session, fake_openai, error, expected_type, fragment
) -> None:
    await _seed_direct_chat(session)
    fake_openai.error = error

    body = (await client.post("/llm/test", json={"alias": "explain-standard"})).json()

    assert body["ok"] is False
    assert body["error_type"] == expected_type
    assert fragment in body["error"]
    assert body["sample"] is None
    # 路由已经解析成功，插件信息照常返回，便于界面指出"是哪个部署挂了"
    assert body["plugin_id"] == "openai"
    assert body["selection_source"] == "binding"

    rows = await _invocation_rows(session)
    assert len(rows) == 1
    assert rows[0].source == "probe"
    assert rows[0].status == "failed"
    assert rows[0].error_type == type(error).__name__


async def test_probe_empty_content_is_classified_and_recorded(client, session, fake_openai) -> None:
    await _seed_direct_chat(session)
    fake_openai.content = "   "

    body = (await client.post("/llm/test", json={"alias": "explain-standard"})).json()

    assert body["ok"] is False
    assert body["error_type"] == "empty"
    assert body["model"] == "pong-model"  # 上游回报的模型名仍透出
    rows = await _invocation_rows(session)
    assert rows[0].status == "failed"
    assert rows[0].error_type == "ProbeEmpty"
    assert rows[0].source == "probe"


async def test_probe_unresolvable_route_records_unresolved_row(
    client, session, fake_openai
) -> None:
    """绑定指向已停用部署：不发请求、error_type=route，台账留 plugin_id=unresolved 一行。"""
    await _seed_direct_chat(session, enabled=False)

    body = (await client.post("/llm/test", json={"alias": "explain-standard"})).json()

    assert body["ok"] is False
    assert body["error_type"] == "route"
    assert "停用" in body["error"]
    assert body["plugin_id"] is None
    assert fake_openai.calls == []
    rows = await _invocation_rows(session)
    assert len(rows) == 1
    assert rows[0].plugin_id == "unresolved"
    assert rows[0].source == "probe"
    assert rows[0].status == "failed"
    assert rows[0].capability == "explain-standard"


async def test_probe_explicit_deployment_bypasses_binding(client, session, fake_openai) -> None:
    deployment = await _seed_direct_chat(session)

    body = (
        await client.post(
            "/llm/test", json={"alias": "grammar-deep", "deployment_id": deployment.id}
        )
    ).json()

    assert body["ok"] is True
    assert body["selection_source"] == "explicit"
    assert body["deployment_id"] == deployment.id
    assert fake_openai.calls[0]["model"] == "direct-chat-model"
    rows = await _invocation_rows(session)
    assert rows[0].capability == "grammar-deep"


def test_classify_probe_error_covers_runtime_and_unknown() -> None:
    assert llm_admin.classify_probe_error(model_runtime.ModelRuntimeError("x"))[0] == "route"
    kind, text = llm_admin.classify_probe_error(RuntimeError("boom"))
    assert kind == "error"
    assert text == "RuntimeError: boom"


# ---- 未绑定的能力：报「未绑定」而不是「连不上网关」 ----


async def test_unbound_chat_capability_raises_binding_error_not_connection_error() -> None:
    """回落年代这里会去连默认没启动的 :4000，报的是连接被拒——指向完全错误的方向。"""
    with pytest.raises(model_runtime.ModelRuntimeError) as exc_info:
        await model_runtime.prepare_chat_route("chat-general", "chat.complete")
    message = str(exc_info.value)
    assert "chat-general" in message and "尚未绑定模型" in message
    assert "4000" not in message and "Connection" not in message


async def test_unbound_image_capability_raises_binding_error_not_connection_error() -> None:
    from domain import imagegen

    with pytest.raises(imagegen.ImageGenError) as exc_info:
        await imagegen.render_images("x", alias="image-free", size="1024x1024", n=1)
    assert exc_info.value.kind == "binding"
    assert "image-free" in str(exc_info.value) and "尚未绑定模型" in str(exc_info.value)


# ---- /usage/summary 本地台账聚合 ----


def _invocation(**overrides) -> ModelInvocation:
    values = {
        "id": uuid4().hex,
        "plugin_id": "openai",
        "operation": "chat.complete",
        "capability": "explain-standard",
        "model": "direct-chat-model",
        "status": "succeeded",
        "latency_ms": 100,
        "usage": None,
        "created_at": datetime.now(UTC),
    }
    values.update(overrides)
    return ModelInvocation(**values)


async def test_usage_summary_aggregates_invocations_by_route(client, session) -> None:
    session.add_all(
        [
            _invocation(latency_ms=100, usage={"prompt_tokens": 10, "completion_tokens": 5}),
            _invocation(latency_ms=200, usage={"input_tokens": 20, "output_tokens": 6}),
            _invocation(
                latency_ms=300,
                usage={"prompt_tokens": 30, "completion_tokens": 7, "total_tokens": 37},
            ),
            _invocation(latency_ms=400, usage=None),
            _invocation(latency_ms=1000, usage={"input_tokens": 40, "output_tokens": 8}),
            # 失败行：延迟不进分位，tokens 仍计入
            _invocation(
                status="failed", latency_ms=5000, usage={"prompt_tokens": 1, "completion_tokens": 0}
            ),
            _invocation(status="cancelled", latency_ms=50),
            _invocation(status="running", latency_ms=None),
            # 窗口外的不算
            _invocation(latency_ms=9999, created_at=datetime.now(UTC) - timedelta(days=10)),
            # 另一条路由
            _invocation(
                plugin_id="gemini",
                capability="translate-fast",
                model="gemini-3-pro",
                latency_ms=80,
                usage={"prompt_tokens": 2, "completion_tokens": 2},
            ),
        ]
    )
    await session.commit()

    resp = await client.get("/usage/summary?days=7")

    assert resp.status_code == 200
    body = resp.json()
    by_route = body["invocations"]["by_route"]
    assert [(b["capability"], b["plugin_id"], b["model"]) for b in by_route] == [
        ("explain-standard", "openai", "direct-chat-model"),
        ("translate-fast", "gemini", "gemini-3-pro"),
    ]
    main = by_route[0]
    assert main["count"] == 8
    assert main["succeeded"] == 5
    assert main["failed"] == 2
    assert main["latency_p50_ms"] == 300
    assert main["latency_p95_ms"] == 880  # 线性插值：400 + 0.8 × (1000 − 400)
    assert main["input_tokens"] == 101
    assert main["output_tokens"] == 26
    assert by_route[1]["latency_p50_ms"] == 80
    assert by_route[1]["latency_p95_ms"] == 80
    assert body["invocations"]["total"] == {
        "count": 9,
        "succeeded": 6,
        "failed": 2,
        "input_tokens": 103,
        "output_tokens": 28,
    }
    assert "台账" in body["invocations"]["notice"]
    # 接口只剩本地口径，不再有任何外部网关的 spend / budget 段
    assert set(body) == {"days", "invocations", "analysis"}
    assert body["days"] == 7


def test_percentile_matches_percentile_cont() -> None:
    assert usage.percentile([], 0.5) is None
    assert usage.percentile([7], 0.95) == 7
    assert usage.percentile([10, 20], 0.5) == 15
    assert usage.percentile([100, 200, 300, 400, 1000], 0.95) == 880
    assert usage.percentile([1, 2, 3, 4], 0.5) == 2  # 2.5 四舍五入到偶数，与 round 一致


async def test_usage_summary_analysis_percentiles_and_null_costs(client, session) -> None:
    now = datetime.now(UTC)
    for kind, provider, latency, cost, created in [
        ("translate", "a", 100, 10, now),
        ("translate", "a", 300, 20, now),
        ("translate", "a", None, None, now),
        ("translate", "b", 0, 0, now),
        ("grammar", "a", None, None, now),
        ("translate", "a", 9999, 9999, now - timedelta(days=8)),
    ]:
        session.add(
            AnalysisResult(
                scope="sentence",
                content_hash=uuid4().hex,
                kind=kind,
                provider=provider,
                result={},
                latency_ms=latency,
                cost_micros=cost,
                created_at=created,
            )
        )
    await session.commit()
    response = await client.get("/usage/summary?days=7")
    assert response.status_code == 200
    assert response.json()["analysis"]["by_kind"] == [
        {
            "kind": "translate",
            "provider": "a",
            "count": 3,
            "cost_micros": 30,
            "latency_p50_ms": 200,
            "latency_p95_ms": 290,
        },
        {
            "kind": "grammar",
            "provider": "a",
            "count": 1,
            "cost_micros": None,
            "latency_p50_ms": None,
            "latency_p95_ms": None,
        },
        {
            "kind": "translate",
            "provider": "b",
            "count": 1,
            "cost_micros": 0,
            "latency_p50_ms": 0,
            "latency_p95_ms": 0,
        },
    ]


async def test_usage_summary_empty_database(client) -> None:
    response = await client.get("/usage/summary")
    assert response.status_code == 200
    assert response.json()["analysis"]["by_kind"] == []
    assert response.json()["invocations"]["total"]["count"] == 0


@pytest.mark.parametrize("days", [0, -1, 366])
async def test_usage_summary_rejects_invalid_window(client, days) -> None:
    assert (await client.get(f"/usage/summary?days={days}")).status_code == 422


def test_usage_tokens_accepts_both_schemas() -> None:
    assert usage.usage_tokens({"prompt_tokens": 3, "completion_tokens": 1}) == (3, 1)
    assert usage.usage_tokens({"input_tokens": 5, "output_tokens": 2}) == (5, 2)
    assert usage.usage_tokens({"prompt_tokens": "bad", "output_tokens": 2.0}) == (0, 2)
    assert usage.usage_tokens(None) == (0, 0)
    assert usage.usage_tokens("[REDACTED]") == (0, 0)


# ---- seed 脚本：无网关建直连部署 + 绑定 ----


class _FakeSettings:
    def __init__(self, key: str) -> None:
        self.config_key = key


@pytest.fixture
def seed_env(monkeypatch):
    """凭据加密要 Fernet key；拉模型 / 连通测试不出网。"""
    settings = _FakeSettings(Fernet.generate_key().decode())
    monkeypatch.setattr(credentials, "get_settings", lambda: settings)

    async def fake_refresh(cred):
        cred.models_cache = {"items": [], "refreshed_at": "now"}
        return {"items": [], "count": 0, "refreshed_at": "now"}

    async def fake_test(cred):
        cred.status = "ok"
        return {"ok": True, "latency_ms": 1, "detail": None}

    monkeypatch.setattr(seed_config, "refresh_models", fake_refresh)
    monkeypatch.setattr(seed_config, "run_test", fake_test)


SEED = {
    "llm": [
        {
            "name": "DeepSeek 官方",
            "provider_type": "deepseek",
            "api_base": "https://api.deepseek.com/v1",
            "api_key": "sk-deepseek-1234567890",
        },
        {
            "name": "智谱中转",
            "provider_type": "openai_compatible",
            "api_base": "https://zhipu.example/v1",
            "api_key": "sk-zhipu-1234567890",
        },
        {
            "name": "gpt 中转",
            "provider_type": "openai_compatible",
            "api_base": "https://gpt.example/v1",
            "api_key": "sk-gpt-1234567890",
        },
    ]
}


def _prober(fail_first: set[str] = frozenset()):
    calls: list[str] = []
    failed: set[str] = set()

    async def prober(capability: str) -> dict:
        calls.append(capability)
        if capability in fail_first and capability not in failed:
            failed.add(capability)
            return {"ok": False, "latency_ms": 3, "error_type": "auth", "error": "HTTP 401"}
        return {"ok": True, "latency_ms": 12, "error_type": None, "error": None}

    return prober, calls


async def _binding_map(session) -> dict[str, CapabilityBinding]:
    rows = (await session.execute(select(CapabilityBinding))).scalars()
    return {row.capability: row for row in rows}


async def test_seed_builds_direct_deployments_and_bindings(session, seed_env) -> None:
    prober, probed = _prober()

    lines = await seed_config.run_seed(session, SEED, prober=prober)

    deployments = list((await session.execute(select(ModelDeployment))).scalars())
    assert deployments and all(d.adapter_type == "openai" for d in deployments)
    assert all(d.media_types == ["chat"] and d.enabled for d in deployments)
    by_model = {d.upstream_model_id: d for d in deployments}
    assert set(by_model) == {"deepseek-chat", "gpt-5.4-mini", "gpt-5.4"}

    bindings = await _binding_map(session)
    assert bindings["translate-fast"].deployment_id == by_model["deepseek-chat"].id
    assert bindings["translate-fast"].target == "deepseek-chat"
    assert bindings["explain-standard"].deployment_id == by_model["gpt-5.4-mini"].id
    assert bindings["companion"].deployment_id == by_model["gpt-5.4-mini"].id
    assert bindings["grammar-deep"].deployment_id == by_model["gpt-5.4"].id
    assert bindings["summary"].deployment_id == by_model["gpt-5.4"].id
    assert bindings["translate-chain"].params == {"chain": ["llm", "google"]}
    assert "tts-word" not in bindings  # seed 没给火山凭据就不建语音绑定
    assert probed == ["translate-fast", "explain-standard", "companion", "grammar-deep", "summary"]
    assert any("translate-fast → DeepSeek 官方/deepseek-chat（实测 ok 12ms）" in ln for ln in lines)

    # 插件层按绑定解析出直连路由：插件 openai、上游真名、DeepSeek 默认端点
    route = await prepare_chat_route("translate-fast", "chat.complete")
    assert route.snapshot.plugin_id == "openai"
    assert route.snapshot.selection_source == "binding"
    assert route.snapshot.model == "deepseek-chat"
    assert route.snapshot.base_url == "https://api.deepseek.com/v1"
    assert "sk-deepseek" not in repr(route.secrets)


async def test_seed_falls_back_to_zhipu_when_deepseek_probe_fails_and_is_idempotent(
    session, seed_env
) -> None:
    prober, probed = _prober(fail_first={"translate-fast"})

    lines = await seed_config.run_seed(session, SEED, prober=prober)
    bindings = await _binding_map(session)
    zhipu = (
        await session.execute(
            select(ModelDeployment).where(ModelDeployment.upstream_model_id == "deepseek-v4-flash")
        )
    ).scalar_one()
    assert bindings["translate-fast"].deployment_id == zhipu.id
    assert bindings["translate-fast"].params == {"reasoning_effort": "none"}
    assert probed[:2] == ["translate-fast", "translate-fast"]
    assert any("回退智谱" in ln for ln in lines)

    # 再跑一遍：唯一键 (credential, model, adapter) 不会撞，绑定保持单行
    await seed_config.run_seed(session, SEED, prober=None)
    deployments = list((await session.execute(select(ModelDeployment))).scalars())
    assert len(deployments) == 4  # deepseek-chat / deepseek-v4-flash / gpt-5.4-mini / gpt-5.4
    bindings = await _binding_map(session)
    assert len([b for b in bindings.values() if b.capability == "translate-fast"]) == 1
    # prober=None 时 DeepSeek 直接当可用
    assert bindings["translate-fast"].target == "deepseek-chat"


def test_seed_cli_flags() -> None:
    args = seed_config.parse_args(["--skip-probe", "x.json"])
    assert (args.seed, args.skip_probe, args.keep_seed) == ("x.json", True, False)
    assert seed_config.parse_args([]).seed == seed_config.DEFAULT_SEED
