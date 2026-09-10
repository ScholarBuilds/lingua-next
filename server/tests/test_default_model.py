"""全局默认对话模型（CR-013）：候选顺序、跟随/单独指定两态、清空接口。

关键判据写在 test_bound_capability_ignores_default 与
test_default_does_not_rescue_a_disabled_binding 两条上：默认只在「这条能力自己没挑模型」
时参与，绑了模型但那条部署停用了照旧报错——把配置事故静默换成另一个模型出结果，
用户看到的是「怎么变笨了」而不是「我配的那条挂了」。
"""

from types import SimpleNamespace

import pytest

from app.routers.config import (
    CAPABILITY_META,
    DEFAULT_FOLLOWER_CAPABILITIES,
    LEGACY_SCAN_CAPABILITIES,
    MODEL_CAPABILITIES,
)
from domain.credentials import ALL_CAPABILITIES, DEFAULT_LLM_CAPABILITY, LLM_CAPABILITIES
from domain.model_catalog import _candidate_specs, _default_followers
from tests.model_binding_stub import seed_default_bindings


def binding(deployment_id=None, fallback=None, params=None):
    return SimpleNamespace(
        deployment_id=deployment_id, fallback=fallback or [], params=params or {}
    )


DEFAULT = binding(deployment_id=99)


class TestCandidateOrder:
    def test_unbound_capability_follows_the_default(self):
        assert _candidate_specs(None, None, DEFAULT) == [("default", 99, None)]

    def test_row_without_a_deployment_also_follows(self):
        assert _candidate_specs(binding(), None, DEFAULT) == [("default", 99, None)]

    def test_bound_capability_ignores_default(self):
        """自己挑了模型就用自己的，默认一点都不参与——否则「单独指定」形同虚设。"""
        assert _candidate_specs(binding(46), None, DEFAULT) == [("binding", 46, None)]

    def test_default_does_not_rescue_a_disabled_binding(self):
        """绑了模型的能力，候选里没有 default 这一档。

        部署停用时 resolve_model_candidates 会照旧抛「模型部署已停用」，而不是换一个
        模型出结果。配置事故必须显形。
        """
        specs = _candidate_specs(binding(46), None, DEFAULT)
        assert all(source != "default" for source, _, _ in specs)

    def test_explicit_pin_comes_first(self):
        assert _candidate_specs(binding(46), 77, DEFAULT) == [
            ("explicit", 77, None),
            ("binding", 46, None),
        ]

    def test_explicit_pin_is_not_duplicated_by_the_default(self):
        assert _candidate_specs(None, 99, DEFAULT) == [("explicit", 99, None)]

    def test_own_fallback_chain_outranks_the_default(self):
        """用户为这条能力亲手排的降级链，优先于通用兜底。"""
        item = {"deployment_id": 5}
        assert _candidate_specs(binding(fallback=[item]), None, DEFAULT) == [
            ("fallback", 5, item),
            ("default", 99, None),
        ]

    def test_no_binding_and_no_default_stays_empty(self):
        """两边都没配就返回空，让上层照旧抛「尚未绑定模型」（核心原则 5）。"""
        assert _candidate_specs(None, None, None) == []
        assert _candidate_specs(None, None, binding()) == []


class TestCapabilityRegistration:
    def test_default_is_a_known_capability(self):
        assert DEFAULT_LLM_CAPABILITY in ALL_CAPABILITIES
        assert DEFAULT_LLM_CAPABILITY in CAPABILITY_META

    def test_default_stays_out_of_llm_capabilities(self):
        """进了 LLM_CAPABILITIES 会被测试桩自动绑上，「没配默认」这条分支就永远测不到。"""
        assert DEFAULT_LLM_CAPABILITY not in LLM_CAPABILITIES

    def test_default_is_bindable_but_not_scanned_as_legacy(self):
        assert DEFAULT_LLM_CAPABILITY in MODEL_CAPABILITIES
        assert DEFAULT_LLM_CAPABILITY not in LEGACY_SCAN_CAPABILITIES

    def test_followers_agree_across_layers(self):
        """路由层与接口层各有一份跟随者集合，分叉了 UI 会说跟随而运行时不跟。"""
        assert _default_followers() == DEFAULT_FOLLOWER_CAPABILITIES == frozenset(LLM_CAPABILITIES)


@pytest.fixture
async def chat_deployment(session):
    return (await seed_default_bindings(session))["chat"].id


@pytest.mark.anyio
class TestBindingApi:
    async def test_default_row_is_listed_first(self, client):
        rows = (await client.get("/config/bindings")).json()
        assert rows[0]["capability"] == DEFAULT_LLM_CAPABILITY
        assert rows[0]["label"] == "全局默认模型"

    async def test_unbound_follower_reports_following(self, client):
        rows = {r["capability"]: r for r in (await client.get("/config/bindings")).json()}
        assert rows["translate-fast"]["follows_default"] is True

    async def test_default_row_itself_never_follows(self, client):
        rows = {r["capability"]: r for r in (await client.get("/config/bindings")).json()}
        assert rows[DEFAULT_LLM_CAPABILITY]["follows_default"] is False

    async def test_delete_switches_a_capability_back_to_following(self, client, chat_deployment):
        await client.put("/config/bindings/translate-fast", json={"deployment_id": chat_deployment})
        rows = {r["capability"]: r for r in (await client.get("/config/bindings")).json()}
        assert rows["translate-fast"]["follows_default"] is False

        cleared = await client.delete("/config/bindings/translate-fast")
        assert cleared.status_code == 200
        assert cleared.json()["follows_default"] is True
        assert cleared.json()["bound"] is False

        rows = {r["capability"]: r for r in (await client.get("/config/bindings")).json()}
        assert rows["translate-fast"]["follows_default"] is True
        assert rows["translate-fast"]["deployment_id"] is None

    async def test_delete_is_idempotent(self, client):
        first = await client.delete("/config/bindings/summary")
        second = await client.delete("/config/bindings/summary")
        assert first.status_code == second.status_code == 200

    async def test_cannot_clear_something_with_no_default_to_fall_back_on(self, client):
        """音色 / 生图 / 翻译链没有可跟随的默认，清空只会让它们变成不可用。"""
        for capability in ("tts-word", "image-cover", DEFAULT_LLM_CAPABILITY):
            resp = await client.delete(f"/config/bindings/{capability}")
            assert resp.status_code == 400, capability


@pytest.mark.anyio
class TestPerCallOverride:
    """使用处换模型：只影响这一次调用，且必须换缓存槽。

    不换槽的话换了模型仍旧命中上一个模型的结果——接口 200、日志干净，
    用户看到的是「换了没反应」（本仓 analyze 缓存寻址不含模型的旧账）。
    """

    async def test_pinned_model_gets_its_own_cache_slot(self, client, chat_deployment, monkeypatch):
        from app.routers import analyze

        calls: list[int | None] = []

        async def fake_complete_json(alias, system, user, *, deployment_id=None):
            calls.append(deployment_id)
            return {"zh": f"译文-{deployment_id}"}, "fake-model", 1

        monkeypatch.setattr(analyze, "complete_json", fake_complete_json)

        body = {"word": "abandon", "context": "he abandoned the plan"}
        missing = await client.post("/analyze/word?cached_only=true", json=body)
        assert missing.json() == {"result": None, "cached": False}
        assert calls == []
        first = await client.post("/analyze/word", json=body)
        assert first.status_code == 200 and first.json()["cached"] is False

        # 同一份输入再来一次：命中缓存，不再调模型
        again = await client.post("/analyze/word", json=body)
        assert again.json()["cached"] is True
        assert calls == [None]

        cached = await client.post("/analyze/word?cached_only=true", json=body)
        assert cached.json()["result"] == first.json()["result"]
        capitalized = await client.post(
            "/analyze/word?cached_only=true", json={**body, "word": "Abandon"}
        )
        assert capitalized.json()["result"] == first.json()["result"]
        other = await client.post(
            "/analyze/word?cached_only=true", json={**body, "deployment_id": chat_deployment}
        )
        assert other.json()["result"] is None
        other_context = await client.post(
            "/analyze/word?cached_only=true", json={**body, "context": "another sentence"}
        )
        assert other_context.json()["result"] is None
        assert calls == [None]

        # 钉一条部署：换槽，必须真的再调一次
        pinned = await client.post("/analyze/word", json={**body, "deployment_id": chat_deployment})
        assert pinned.status_code == 200
        assert pinned.json()["cached"] is False
        assert calls == [None, chat_deployment]

        # 钉同一条再来一次：命中它自己的槽
        assert (
            await client.post("/analyze/word", json={**body, "deployment_id": chat_deployment})
        ).json()["cached"] is True
        assert calls == [None, chat_deployment]

        # 回到不钉：仍是最早那一槽，不重算
        assert (await client.post("/analyze/word", json=body)).json()["cached"] is True
        assert calls == [None, chat_deployment]
