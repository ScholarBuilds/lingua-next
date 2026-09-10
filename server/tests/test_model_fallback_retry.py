"""选路 fallback、同路由重试、绑定参数注入、稳定错误码与用量归一化。

LLM 与出图全程替身：替身 AsyncOpenAI 按 ``base_url`` 分派脚本，同一条脚本按顺序消费，
这样主部署与 fallback 部署（不同凭据的不同地址）可以各演各的。退避睡眠换成记录器。
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import httpx
import pytest
from openai import APIConnectionError, APIStatusError

import domain.llm as llm
import domain.model_runtime as model_runtime
from domain import imagegen
from domain.imagegen import ImageGenError, RenderResult, image_failure_code
from domain.model_catalog import (
    ModelCatalogError,
    ResolvedModelRoute,
    resolve_model_candidates,
    resolve_model_route,
    validate_protocol_options,
)
from domain.model_invocations import normalize_usage
from domain.model_runtime import ModelCallFailure, prepare_chat_route
from domain.models import CapabilityBinding, ModelDeployment, ProviderCredential
from tests.test_image_prompts import _capture_generate

ALIAS = "explain-standard"
PRIMARY_BASE = "https://primary.example/v1"
BACKUP_BASE = "https://backup.example/v1"

# ---------------------------------------------------------------------------
# 替身
# ---------------------------------------------------------------------------


def _request() -> httpx.Request:
    return httpx.Request("POST", "https://example.invalid/v1/chat/completions")


def _status_error(status: int, message: str, *, headers: dict | None = None) -> APIStatusError:
    return APIStatusError(
        message,
        response=httpx.Response(status, headers=headers or {}, request=_request()),
        body={"error": {"message": message}},
    )


def _completion(content: str, *, model: str = "fake-model", usage: dict | None = None):
    return SimpleNamespace(
        id=f"req-{model}",
        model=model,
        usage=usage,
        choices=[SimpleNamespace(message=SimpleNamespace(content=content), finish_reason="stop")],
    )


def _chunk(text: str | None, *, finish: str | None = None, model: str = "fake-model"):
    delta = SimpleNamespace(content=text, reasoning_content=None, tool_calls=None)
    return SimpleNamespace(
        id="req-stream",
        model=model,
        usage=None,
        choices=[SimpleNamespace(delta=delta, finish_reason=finish)],
    )


class _Stream:
    """脚本项是分块或异常：迭代到异常就地抛出（模拟流中途断线）。"""

    def __init__(self, items: list) -> None:
        self._items = list(items)

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self._items:
            raise StopAsyncIteration
        item = self._items.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item


def _scripted_openai(script: dict[str, list]):
    """替身 AsyncOpenAI：按 base_url 取脚本，每次 create 消费一项。

    脚本项：异常实例 → create 抛出；list → 流式分块；其它 → 非流式响应对象。
    ``calls`` 记录 (base_url, kwargs)。
    """
    calls: list[tuple[str, dict]] = []

    class FakeClient:
        def __init__(self, *, base_url: str, **_kwargs) -> None:
            self.base_url = base_url
            self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

        async def _create(self, **kwargs):
            calls.append((self.base_url, kwargs))
            queue = script[self.base_url]
            item = queue.pop(0) if queue else _completion("fallback-default")
            if isinstance(item, BaseException):
                raise item
            if isinstance(item, list):
                return _Stream(item)
            return item

        async def close(self) -> None:
            return None

    return FakeClient, calls


@pytest.fixture
def no_sleep(monkeypatch) -> list[float]:
    """退避不真睡，只记下每次决定等多久。"""
    delays: list[float] = []

    async def _record(seconds: float) -> None:
        delays.append(seconds)

    monkeypatch.setattr(llm, "_sleep", _record)
    return delays


async def _ledger(client, **params) -> list[dict]:
    query = "&".join(f"{key}={value}" for key, value in params.items())
    items = (await client.get(f"/config/model-invocations?{query}")).json()["items"]
    return sorted(items, key=lambda item: (item["created_at"], item["attempt"]))


# ---------------------------------------------------------------------------
# 建数据
# ---------------------------------------------------------------------------


async def _credential(
    session,
    name: str,
    *,
    base: str,
    enabled: bool = True,
    provider_type: str = "openai_compatible",
) -> ProviderCredential:
    row = ProviderCredential(
        name=name,
        kind="llm",
        provider_type=provider_type,
        config={"api_base": base, "api_key": f"sk-{name}"},
        enabled=enabled,
    )
    session.add(row)
    await session.flush()
    return row


async def _deployment(
    session,
    credential: ProviderCredential,
    model: str,
    *,
    adapter_type: str = "openai",
    enabled: bool = True,
    protocol_options: dict | None = None,
    media_types: list[str] | None = None,
) -> ModelDeployment:
    row = ModelDeployment(
        credential_id=credential.id,
        upstream_model_id=model,
        adapter_type=adapter_type,
        media_types=media_types or ["chat"],
        enabled=enabled,
        protocol_options=protocol_options,
    )
    session.add(row)
    await session.flush()
    return row


async def _bind(
    session,
    deployment: ModelDeployment | None,
    *,
    capability: str = ALIAS,
    params: dict | None = None,
    fallback: list[dict] | None = None,
) -> CapabilityBinding:
    row = CapabilityBinding(
        capability=capability,
        credential_id=deployment.credential_id if deployment else None,
        deployment_id=deployment.id if deployment else None,
        target=deployment.upstream_model_id if deployment else None,
        params=params,
        fallback=fallback,
    )
    session.add(row)
    await session.commit()
    return row


async def _seed_chain(
    session, *, primary_enabled: bool = True, primary_options: dict | None = None
) -> tuple[ModelDeployment, ModelDeployment]:
    """主部署 primary.example + fallback 部署 backup.example（按 credential/target 引用）。"""
    primary_cred = await _credential(session, "primary", base=PRIMARY_BASE)
    backup_cred = await _credential(session, "backup", base=BACKUP_BASE)
    primary = await _deployment(
        session,
        primary_cred,
        "primary-model",
        enabled=primary_enabled,
        protocol_options=primary_options,
    )
    backup = await _deployment(session, backup_cred, "backup-model")
    await _bind(
        session,
        primary,
        fallback=[{"credential_id": backup_cred.id, "target": "backup-model"}],
    )
    return primary, backup


# ---------------------------------------------------------------------------
# 候选解析
# ---------------------------------------------------------------------------


async def test_candidates_follow_binding_then_fallback_and_skip_disabled(session) -> None:
    primary, backup = await _seed_chain(session)

    candidates = await resolve_model_candidates(session, ALIAS)
    assert [c.deployment_id for c in candidates] == [primary.id, backup.id]
    assert [c.source for c in candidates] == ["binding", "fallback"]
    assert candidates[0].fallbacks == (candidates[1],)
    assert candidates[1].fallbacks == ()
    assert "api_key" not in candidates[0].view()

    # 显式部署排最前，绑定主部署退居 fallback 之前
    explicit = await resolve_model_candidates(session, ALIAS, deployment_id=backup.id)
    assert [c.deployment_id for c in explicit] == [backup.id, primary.id]
    assert explicit[0].source == "explicit"

    # 主部署停用：不抛错，fallback 接管
    primary.enabled = False
    await session.commit()
    route = await resolve_model_route(session, ALIAS)
    assert route is not None and route.deployment_id == backup.id
    assert route.source == "fallback" and route.fallbacks == ()

    # 全部不可用才抛，文案说明原因
    backup.enabled = False
    await session.commit()
    with pytest.raises(ModelCatalogError, match="停用"):
        await resolve_model_route(session, ALIAS)


async def test_fallback_prefers_a_deployment_whose_adapter_still_has_a_plugin(session) -> None:
    """同名部署有好几条时，adapter 已经没有插件的（退役的 litellm 行）排最后。"""
    primary_cred = await _credential(session, "primary", base=PRIMARY_BASE)
    backup_cred = await _credential(session, "backup", base=BACKUP_BASE)
    primary = await _deployment(session, primary_cred, "primary-model")
    stale = await _deployment(session, backup_cred, "backup-model", adapter_type="litellm")
    await _bind(
        session,
        primary,
        fallback=[{"credential_id": backup_cred.id, "target": "backup-model"}],
    )
    only_stale = await resolve_model_candidates(session, ALIAS)
    assert [c.deployment_id for c in only_stale] == [primary.id, stale.id]

    direct = await _deployment(session, backup_cred, "backup-model", adapter_type="openai")
    await session.commit()
    with_direct = await resolve_model_candidates(session, ALIAS)
    assert [c.deployment_id for c in with_direct] == [primary.id, direct.id]


async def test_legacy_binding_without_deployment_still_resolves_to_none(session) -> None:
    cred = await _credential(session, "legacy", base=PRIMARY_BASE)
    session.add(CapabilityBinding(capability=ALIAS, credential_id=cred.id, target="x"))
    await session.commit()
    assert await resolve_model_candidates(session, ALIAS) == []
    assert await resolve_model_route(session, ALIAS) is None


def test_retry_policy_in_protocol_options_is_validated() -> None:
    ok = validate_protocol_options({"retry_policy": {"mode": "never"}})
    assert ok == {"retry_policy": {"mode": "never"}}
    with pytest.raises(ModelCatalogError, match="mode"):
        validate_protocol_options({"retry_policy": {"mode": "sometimes"}})
    with pytest.raises(ModelCatalogError, match="对象"):
        validate_protocol_options({"retry_policy": "never"})


# ---------------------------------------------------------------------------
# fallback 真实生效 + 台账链
# ---------------------------------------------------------------------------


async def test_disabled_primary_is_taken_over_by_fallback(client, session, monkeypatch) -> None:
    _primary, backup = await _seed_chain(session, primary_enabled=False)
    fake, calls = _scripted_openai({BACKUP_BASE: [_completion('{"ok": 1}', model="backup-2026")]})
    monkeypatch.setattr(model_runtime, "AsyncOpenAI", fake)

    result, model, _latency = await llm.complete_json(ALIAS, "sys", "user")

    assert result == {"ok": 1} and model == "backup-2026"
    assert [base for base, _ in calls] == [BACKUP_BASE]
    rows = await _ledger(client, plugin_id="openai")
    assert len(rows) == 1
    assert rows[0]["deployment_id"] == backup.id
    assert rows[0]["attempt"] == 1 and rows[0]["parent_invocation_id"] is None
    assert rows[0]["request"]["route"]["selection_source"] == "fallback"


async def test_auth_failure_switches_to_fallback_and_links_ledger_rows(
    client, session, monkeypatch, no_sleep
) -> None:
    primary, backup = await _seed_chain(session)
    fake, calls = _scripted_openai(
        {
            PRIMARY_BASE: [_status_error(401, "bad key")],
            BACKUP_BASE: [_completion("rescued", model="backup-2026")],
        }
    )
    monkeypatch.setattr(model_runtime, "AsyncOpenAI", fake)

    text = await llm.complete_text(ALIAS, [{"role": "user", "content": "hi"}])

    assert text == "rescued"
    assert [base for base, _ in calls] == [PRIMARY_BASE, BACKUP_BASE]
    assert no_sleep == []  # AUTH 不重试同一路由，直接切候选
    rows = await _ledger(client, plugin_id="openai")
    assert len(rows) == 2
    first, second = rows
    assert first["deployment_id"] == primary.id
    assert first["status"] == "failed" and first["error_code"] == "AUTH"
    assert first["attempt"] == 1 and first["parent_invocation_id"] is None
    assert second["deployment_id"] == backup.id
    assert second["status"] == "succeeded" and second["model"] == "backup-2026"
    assert second["attempt"] == 2 and second["parent_invocation_id"] == first["id"]
    assert second["request"]["route"]["selection_source"] == "fallback"


async def test_exhausted_chain_raises_with_last_failure(
    client, session, monkeypatch, no_sleep
) -> None:
    await _seed_chain(session)
    fake, calls = _scripted_openai(
        {
            PRIMARY_BASE: [_status_error(401, "bad key")],
            BACKUP_BASE: [_status_error(403, "forbidden")],
        }
    )
    monkeypatch.setattr(model_runtime, "AsyncOpenAI", fake)

    with pytest.raises(llm.LLMUnavailable) as caught:
        await llm.complete_text(ALIAS, [{"role": "user", "content": "hi"}])

    assert caught.value.failure.code == "AUTH"
    assert caught.value.failure.status == 403
    assert isinstance(caught.value.__cause__, APIStatusError)
    assert len(calls) == 2
    rows = await _ledger(client, plugin_id="openai", status="failed")
    assert [row["attempt"] for row in rows] == [1, 2]
    assert rows[1]["parent_invocation_id"] == rows[0]["id"]


async def test_unknown_failures_neither_retry_nor_fall_over(
    client, session, monkeypatch, no_sleep
) -> None:
    """模型回了非 JSON：换供应商救不回来，保持原语义直接报错，不动 fallback。"""
    await _seed_chain(session)
    fake, calls = _scripted_openai({PRIMARY_BASE: [_completion("not json")]})
    monkeypatch.setattr(model_runtime, "AsyncOpenAI", fake)

    with pytest.raises(llm.LLMUnavailable, match="非 JSON"):
        await llm.complete_json(ALIAS, "sys", "user")
    assert [base for base, _ in calls] == [PRIMARY_BASE]
    assert no_sleep == []


# ---------------------------------------------------------------------------
# 同路由重试
# ---------------------------------------------------------------------------


async def test_rate_limit_is_retried_on_the_same_route(
    client, session, monkeypatch, no_sleep
) -> None:
    primary, _backup = await _seed_chain(session)
    fake, calls = _scripted_openai(
        {
            PRIMARY_BASE: [
                _status_error(429, "slow down", headers={"retry-after": "2"}),
                _completion("after retry"),
            ]
        }
    )
    monkeypatch.setattr(model_runtime, "AsyncOpenAI", fake)

    text = await llm.complete_text(ALIAS, [{"role": "user", "content": "hi"}])

    assert text == "after retry"
    assert [base for base, _ in calls] == [PRIMARY_BASE, PRIMARY_BASE]
    assert no_sleep == [2.0]  # 采纳供应商 Retry-After
    rows = await _ledger(client, plugin_id="openai")
    assert [row["attempt"] for row in rows] == [1, 2]
    assert rows[0]["error_code"] == "RATE_LIMIT" and rows[0]["deployment_id"] == primary.id
    assert rows[1]["status"] == "succeeded" and rows[1]["deployment_id"] == primary.id
    assert rows[1]["parent_invocation_id"] == rows[0]["id"]


async def test_retry_budget_then_fallback(client, session, monkeypatch, no_sleep) -> None:
    """默认策略两次重试；用尽后 503 属于可切换码，转到 fallback。"""
    await _seed_chain(session)
    fake, calls = _scripted_openai(
        {
            PRIMARY_BASE: [_status_error(503, "down")] * 3,
            BACKUP_BASE: [_completion("backup wins")],
        }
    )
    monkeypatch.setattr(model_runtime, "AsyncOpenAI", fake)

    text = await llm.complete_text(ALIAS, [{"role": "user", "content": "hi"}])

    assert text == "backup wins"
    assert [base for base, _ in calls] == [PRIMARY_BASE] * 3 + [BACKUP_BASE]
    assert len(no_sleep) == 2 and all(delay > 0 for delay in no_sleep)
    rows = await _ledger(client, plugin_id="openai")
    assert [row["attempt"] for row in rows] == [1, 2, 3, 4]
    assert {row["parent_invocation_id"] for row in rows[1:]} == {rows[0]["id"]}
    assert [row["error_code"] for row in rows[:3]] == ["SERVER"] * 3


async def test_retry_policy_never_from_deployment_options(
    client, session, monkeypatch, no_sleep
) -> None:
    await _seed_chain(session, primary_options={"retry_policy": {"mode": "never"}})
    fake, calls = _scripted_openai(
        {
            PRIMARY_BASE: [_status_error(429, "slow down")],
            BACKUP_BASE: [_completion("backup")],
        }
    )
    monkeypatch.setattr(model_runtime, "AsyncOpenAI", fake)

    route = await prepare_chat_route(ALIAS, "chat.complete")
    assert route.snapshot.retry_policy.mode == "never"
    assert route.snapshot.view()["retry_policy"] == {"mode": "never"}
    assert [item["source"] for item in route.snapshot.fallbacks] == ["fallback"]

    text = await llm.complete_text(ALIAS, [{"role": "user", "content": "hi"}])
    assert text == "backup"
    assert [base for base, _ in calls] == [PRIMARY_BASE, BACKUP_BASE]
    assert no_sleep == []


# ---------------------------------------------------------------------------
# 流式：只在吐字前重试 / 切换
# ---------------------------------------------------------------------------


async def test_stream_retries_only_before_the_first_delta(
    client, session, monkeypatch, no_sleep
) -> None:
    await _seed_chain(session)
    fake, calls = _scripted_openai(
        {
            PRIMARY_BASE: [
                _status_error(503, "down"),
                [_chunk("Hel"), _chunk("lo", finish="stop")],
            ]
        }
    )
    monkeypatch.setattr(model_runtime, "AsyncOpenAI", fake)

    events = [e async for e in llm.stream_text(ALIAS, [{"role": "user", "content": "hi"}])]
    assert [e["text"] for e in events if e["type"] == "delta"] == ["Hel", "lo"]
    assert events[-1]["text"] == "Hello"
    assert len(calls) == 2 and len(no_sleep) == 1

    rows = await _ledger(client, plugin_id="openai")
    assert [row["attempt"] for row in rows] == [1, 2]
    assert rows[0]["error_code"] == "SERVER"


async def test_stream_failure_after_first_delta_is_final(
    client, session, monkeypatch, no_sleep
) -> None:
    await _seed_chain(session)
    fake, calls = _scripted_openai(
        {
            PRIMARY_BASE: [[_chunk("par"), APIConnectionError(request=_request())]],
            BACKUP_BASE: [[_chunk("never")]],
        }
    )
    monkeypatch.setattr(model_runtime, "AsyncOpenAI", fake)

    events: list[dict] = []
    with pytest.raises(llm.LLMUnavailable) as caught:
        async for event in llm.stream_text(ALIAS, [{"role": "user", "content": "hi"}]):
            events.append(event)

    assert events == [{"type": "delta", "text": "par"}]
    assert caught.value.failure.code == "TRANSPORT"
    assert isinstance(caught.value.__cause__, APIConnectionError)
    assert [base for base, _ in calls] == [PRIMARY_BASE]
    assert no_sleep == []


async def test_stream_json_empty_response_retries_then_degrades(
    client, session, monkeypatch, no_sleep
) -> None:
    """吐字前的空响应：主路由不重试（never）→ 切 fallback 按默认策略重试两次 → 链用尽后
    退到非流式再试一次；done 事件形状不变。"""
    await _seed_chain(session, primary_options={"retry_policy": {"mode": "never"}})
    payload = json.dumps(
        {"context_meaning": "a", "pos_in_context": "n.", "explanation": "e", "memory_hint": "m"}
    )
    empty = [_chunk(None, finish="stop")]
    fake, calls = _scripted_openai(
        {
            PRIMARY_BASE: [list(empty), _completion(payload)],
            BACKUP_BASE: [list(empty), list(empty), list(empty)],
        }
    )
    monkeypatch.setattr(model_runtime, "AsyncOpenAI", fake)

    events = [e async for e in llm.stream_json(ALIAS, "sys", "user", kind="word_explain")]
    assert events[-1]["type"] == "done" and events[-1]["schema_error"] is False
    assert events[-1]["result"]["context_meaning"] == "a"
    assert [(base, kwargs.get("stream")) for base, kwargs in calls] == [
        (PRIMARY_BASE, True),
        (BACKUP_BASE, True),
        (BACKUP_BASE, True),
        (BACKUP_BASE, True),
        (PRIMARY_BASE, None),
    ]
    assert len(no_sleep) == 2
    rows = await _ledger(client, plugin_id="openai", status="failed")
    assert [row["error_code"] for row in rows] == ["EMPTY_RESPONSE"] * 4
    assert [row["attempt"] for row in rows] == [1, 2, 3, 4]
    assert [row["request"]["route"]["selection_source"] for row in rows] == [
        "binding",
        "fallback",
        "fallback",
        "fallback",
    ]


# ---------------------------------------------------------------------------
# 绑定参数注入
# ---------------------------------------------------------------------------


async def test_binding_params_are_injected_by_provider_whitelist(
    client, session, monkeypatch
) -> None:
    cred = await _credential(session, "primary", base=PRIMARY_BASE)
    deployment = await _deployment(
        session, cred, "primary-model", protocol_options={"top_p": 0.5, "custom": "x"}
    )
    await _bind(
        session,
        deployment,
        params={"temperature": 0.2, "reasoning_effort": "low", "chain": ["a"], "max_tokens": None},
    )
    fake, calls = _scripted_openai({PRIMARY_BASE: [_completion("ok"), _completion("ok")]})
    monkeypatch.setattr(model_runtime, "AsyncOpenAI", fake)

    route = await prepare_chat_route(ALIAS, "chat.complete")
    options = route.snapshot.view()["protocol_options"]
    assert options["temperature"] == 0.2 and options["top_p"] == 0.5 and options["custom"] == "x"
    assert route.snapshot.view()["param_keys"] == [
        "max_tokens",
        "reasoning_effort",
        "temperature",
        "top_p",
    ]

    await llm.complete_text(ALIAS, [{"role": "user", "content": "hi"}])
    _base, kwargs = calls[0]
    assert kwargs["temperature"] == 0.2
    assert kwargs["reasoning_effort"] == "low"
    assert kwargs["top_p"] == 0.5
    assert "chain" not in kwargs and "custom" not in kwargs and "max_tokens" not in kwargs

    # 调用方显式给的参数优先于绑定
    await llm.complete_text(ALIAS, [{"role": "user", "content": "hi"}], temperature=0.9)
    assert calls[1][1]["temperature"] == 0.9
    assert calls[1][1]["reasoning_effort"] == "low"

    rows = await _ledger(client, plugin_id="openai")
    assert rows[0]["request"]["params"] == {
        "reasoning_effort": "low",
        "temperature": 0.2,
        "top_p": 0.5,
    }
    assert rows[1]["request"]["params"] == {"reasoning_effort": "low", "top_p": 0.5}


async def test_cli_provider_injects_nothing(session) -> None:
    cred = await _credential(session, "codex", base="", provider_type="codex_cli")
    deployment = await _deployment(session, cred, "gpt-5-codex", adapter_type="codex")
    await _bind(session, deployment, params={"temperature": 0.2, "reasoning_effort": "high"})
    seen: list[dict] = []

    class _Completions:
        async def create(self, **kwargs):
            seen.append(kwargs)
            return _Stream([_chunk("cli", finish="stop")])

    class _Client:
        chat = SimpleNamespace(completions=_Completions())

        async def close(self) -> None:
            return None

    route = await prepare_chat_route(ALIAS, "chat.stream")
    assert route.snapshot.plugin_id == "codex"
    assert route.snapshot.param_keys == frozenset()
    assert route.snapshot.view()["protocol_options"]["temperature"] == 0.2

    request = {"messages": [{"role": "user", "content": "hi"}], "stream": True}
    prepared = route.prepare_call(request, timeout=5.0, client_factory=lambda _r: _Client())
    async with prepared as call:
        chunks = [c async for c in call.stream_chunks(model=route.snapshot.model, **request)]
        await call.succeed(response={"text": "cli"})
    assert chunks
    assert "temperature" not in seen[0] and "reasoning_effort" not in seen[0]


# ---------------------------------------------------------------------------
# coded 失败与用量归一化
# ---------------------------------------------------------------------------


async def test_coded_call_raises_model_call_failure_with_stable_code(
    client, session, monkeypatch
) -> None:
    await _seed_chain(session)
    fake, _calls = _scripted_openai({PRIMARY_BASE: [_status_error(429, "slow down")]})
    monkeypatch.setattr(model_runtime, "AsyncOpenAI", fake)
    route = await prepare_chat_route(ALIAS, "chat.complete")
    request = {"messages": [{"role": "user", "content": "hi"}]}

    with pytest.raises(ModelCallFailure) as caught:
        async with route.prepare_call(request, timeout=5.0, coded_failures=True) as call:
            await call.complete_chunks(model=route.snapshot.model, **request)

    assert caught.value.failure.code == "RATE_LIMIT"
    assert isinstance(caught.value, model_runtime.ModelRuntimeError)
    assert isinstance(caught.value.__cause__, APIStatusError)
    assert call.failure is caught.value.failure
    rows = await _ledger(client, plugin_id="openai", status="failed")
    assert rows[0]["error_code"] == "RATE_LIMIT" and rows[0]["error_type"] == "APIStatusError"


async def test_usage_is_normalized_into_five_buckets(client, session, monkeypatch) -> None:
    await _seed_chain(session)
    usage = {
        "prompt_tokens": 100,
        "completion_tokens": 40,
        "total_tokens": 140,
        "prompt_tokens_details": {"cached_tokens": 30},
        "completion_tokens_details": {"reasoning_tokens": 10},
    }
    fake, _calls = _scripted_openai({PRIMARY_BASE: [_completion("ok", usage=usage)]})
    monkeypatch.setattr(model_runtime, "AsyncOpenAI", fake)

    await llm.complete_text(ALIAS, [{"role": "user", "content": "hi"}])

    row = (await _ledger(client, plugin_id="openai"))[0]
    assert row["usage"] == usage  # 线协议原貌保留
    assert row["input_tokens"] == 70  # 扣掉缓存命中
    assert row["output_tokens"] == 40
    assert row["cache_read_tokens"] == 30
    assert row["cache_write_tokens"] is None
    assert row["reasoning_tokens"] == 10


def test_normalize_usage_accepts_image_and_kernel_shapes() -> None:
    image = normalize_usage(
        {"input_tokens": 50, "output_tokens": 8, "input_tokens_details": {"cached_tokens": 20}}
    )
    assert image is not None
    assert (image.input_tokens, image.output_tokens, image.cache_read_tokens) == (30, 8, 20)
    kernel = normalize_usage({"input_tokens": 5, "output_tokens": 2, "cache_write_tokens": 1})
    assert kernel is not None and kernel.cache_write_tokens == 1 and kernel.input_tokens == 5
    assert normalize_usage({"latency_ms": 12}) is None
    assert normalize_usage(None) is None


# ---------------------------------------------------------------------------
# 图片 fallback
# ---------------------------------------------------------------------------


def _image_route(deployment_id: int, base: str, model: str, **extra) -> ResolvedModelRoute:
    return ResolvedModelRoute(
        deployment_id=deployment_id,
        adapter_type="openai",
        upstream_model_id=model,
        provider_type="openai_compatible",
        credential_config={"api_base": base, "api_key": "sk-image"},
        protocol_options={},
        **extra,
    )


def _scripted_images(script: dict[str, list]):
    """按模型名分派的 images.generate 替身；脚本项是异常或 RenderResult 用的图字节。"""
    seen: list[str] = []

    def route_client(route):
        model = route.upstream_model_id

        class _Images:
            async def generate(self, **kwargs):
                seen.append(model)
                item = script[model].pop(0)
                if isinstance(item, BaseException):
                    raise item
                import base64

                usage = SimpleNamespace(model_dump=lambda: {"input_tokens": 3, "output_tokens": 1})
                return SimpleNamespace(
                    data=[SimpleNamespace(b64_json=base64.b64encode(item).decode(), url=None)],
                    usage=usage,
                    model=model,
                )

        class _Client:
            images = _Images()

            async def close(self) -> None:
                return None

        return _Client(), model

    return route_client, seen


async def test_image_render_falls_over_on_server_error(client, monkeypatch) -> None:
    backup = _image_route(2, BACKUP_BASE, "backup-image", source="fallback")
    primary = _image_route(1, PRIMARY_BASE, "primary-image", fallbacks=(backup,))
    route_client, seen = _scripted_images(
        {"primary-image": [_status_error(503, "down")], "backup-image": [b"png-bytes"]}
    )
    monkeypatch.setattr(imagegen, "route_client", route_client)

    result = await imagegen.render_images(
        "a cat", alias="image-free", size="1024x1024", quality="high", n=1, route=primary
    )

    assert result.images == [b"png-bytes"] and result.model_reported == "backup-image"
    assert seen == ["primary-image", "backup-image"]
    rows = await _ledger(client, plugin_id="openai")
    assert len(rows) == 2
    assert rows[0]["status"] == "failed" and rows[0]["error_code"] == "SERVER"
    assert rows[0]["deployment_id"] == 1 and rows[0]["attempt"] == 1
    assert rows[1]["status"] == "succeeded" and rows[1]["deployment_id"] == 2
    assert rows[1]["attempt"] == 2 and rows[1]["parent_invocation_id"] == rows[0]["id"]
    assert rows[1]["input_tokens"] == 3 and rows[1]["output_tokens"] == 1
    assert rows[1]["request"]["route"]["selection_source"] == "fallback"
    assert rows[0]["request"]["route"]["fallbacks"][0]["deployment_id"] == 2


async def test_image_render_does_not_fall_over_on_auth_error(client, monkeypatch) -> None:
    backup = _image_route(2, BACKUP_BASE, "backup-image", source="fallback")
    primary = _image_route(1, PRIMARY_BASE, "primary-image", fallbacks=(backup,))
    route_client, seen = _scripted_images(
        {"primary-image": [_status_error(401, "bad key")], "backup-image": [b"png-bytes"]}
    )
    monkeypatch.setattr(imagegen, "route_client", route_client)

    with pytest.raises(ImageGenError) as caught:
        await imagegen.render_images(
            "a cat", alias="image-free", size="1024x1024", quality="high", n=1, route=primary
        )

    assert caught.value.kind == "auth" and caught.value.code == "AUTH"
    assert seen == ["primary-image"]
    rows = await _ledger(client, plugin_id="openai")
    assert len(rows) == 1 and rows[0]["error_code"] == "AUTH"


def test_image_failure_code_falls_back_to_kind_and_cause() -> None:
    assert image_failure_code(ImageGenError("timeout", "slow")) == "TIMEOUT"
    assert image_failure_code(ImageGenError("connect", "down")) == "TRANSPORT"
    assert image_failure_code(ImageGenError("api", "meh")) == "UNKNOWN"
    chained = ImageGenError("api", "HTTP 429")
    chained.__cause__ = _status_error(429, "slow down")
    assert image_failure_code(chained) == "RATE_LIMIT"
    assert image_failure_code(RuntimeError("boom")) == "UNKNOWN"


def test_image_binding_params_only_fill_defaults(monkeypatch) -> None:
    seen = _capture_generate(monkeypatch)
    route = _image_route(
        1,
        PRIMARY_BASE,
        "primary-image",
        params={"quality": "low", "size": "256x256", "moderation": "low", "output_format": "webp"},
    )
    prepared = imagegen.prepare_image_route("image-free", "image.generate", route)
    assert prepared.snapshot.view()["params"]["moderation"] == "low"

    import asyncio

    asyncio.run(
        imagegen.render_images(
            "x", alias="image-free", size="1024x1024", quality="high", n=1, route=route
        )
    )
    assert seen[0]["size"] == "1024x1024" and seen[0]["quality"] == "high"
    assert seen[0]["moderation"] == "low"
    assert seen[0]["output_format"] == "png"  # 调用方给了就不动


def test_render_result_type_unchanged() -> None:
    assert RenderResult(images=[b"x"]).revised_prompts == []
