import os

import pytest

from domain import translate as tr
from domain.translate import EngineError, translate


async def test_auto_prefers_llm(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_llm(
        text: str, lang_pair: str, context: str | None = None, deployment_id: int | None = None
    ) -> str:
        return "大模型译文"

    def fake_free(text: str, engine: str, lang_pair: str, proxy: str | None = None) -> str:
        raise AssertionError("llm 成功时不应触发机翻")

    monkeypatch.setattr(tr, "_llm_translate", fake_llm)
    monkeypatch.setattr(tr, "_free_translate", fake_free)
    outcome = await translate("hello", engine="auto")
    assert outcome == {"text": "大模型译文", "engine": "llm"}


async def test_auto_falls_back_to_google(monkeypatch: pytest.MonkeyPatch) -> None:
    attempted: list[str] = []

    async def fake_llm(
        text: str, lang_pair: str, context: str | None = None, deployment_id: int | None = None
    ) -> str:
        raise EngineError("llm: gateway offline")

    def fake_free(text: str, engine: str, lang_pair: str, proxy: str | None = None) -> str:
        attempted.append(engine)
        return "谷歌译文"

    monkeypatch.setattr(tr, "_llm_translate", fake_llm)
    monkeypatch.setattr(tr, "_free_translate", fake_free)
    outcome = await translate("hello", engine="auto")
    assert outcome == {"text": "谷歌译文", "engine": "google"}
    assert attempted == ["google"]  # bing 已移出 auto 链


async def test_all_engines_failed_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_llm(
        text: str, lang_pair: str, context: str | None = None, deployment_id: int | None = None
    ) -> str:
        raise EngineError("llm: gateway offline")

    def fake_free(text: str, engine: str, lang_pair: str, proxy: str | None = None) -> str:
        raise RuntimeError("down")

    monkeypatch.setattr(tr, "_llm_translate", fake_llm)
    monkeypatch.setattr(tr, "_free_translate", fake_free)
    with pytest.raises(EngineError):
        await translate("hello", engine="auto")


async def test_single_engine_no_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_free(text: str, engine: str, lang_pair: str, proxy: str | None = None) -> str:
        raise RuntimeError("bing down")

    monkeypatch.setattr(tr, "_free_translate", fake_free)
    with pytest.raises(EngineError):
        await translate("hello", engine="bing")


async def test_explicit_bing_still_routable(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_free(text: str, engine: str, lang_pair: str, proxy: str | None = None) -> str:
        assert engine == "bing"
        return "必应译文"

    monkeypatch.setattr(tr, "_free_translate", fake_free)
    outcome = await translate("hello", engine="bing")
    assert outcome == {"text": "必应译文", "engine": "bing"}


@pytest.mark.parametrize("proxy", [None, "http://127.0.0.1:7890"])
def test_free_engine_ignores_environment_and_restores_sdk_factory(monkeypatch, proxy):
    monkeypatch.setenv("translators_default_region", "EN")
    monkeypatch.setenv("HTTPS_PROXY", "http://unwanted.invalid:1234")
    import translators as ts
    from translators.server import Tse

    factory = Tse.get_client_session

    def translate_stub(*args, **kwargs):
        session = Tse.get_client_session(proxies=kwargs["proxies"])
        assert session.trust_env is False
        assert session.proxies["https"] == (proxy or "")
        raise RuntimeError("upstream failure")

    monkeypatch.setattr(ts, "translate_text", translate_stub)
    with pytest.raises(RuntimeError, match="upstream failure"):
        tr._free_translate("hello", "google", "en->zh", proxy)
    assert Tse.get_client_session is factory


async def test_stream_llm_translate_yields_deltas_then_done(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_stream(alias: str, messages: list[dict], *, deployment_id: int | None = None):
        assert alias == "translate-fast"
        assert messages[0]["role"] == "system"
        for piece in ("清晨", "的", "渡轮"):
            yield {"type": "delta", "text": piece}
        yield {"type": "done", "text": "清晨的渡轮"}

    monkeypatch.setattr(tr, "stream_text", fake_stream)
    events = [ev async for ev in tr.stream_llm_translate("The morning ferry")]
    assert [ev["text"] for ev in events if ev["type"] == "delta"] == ["清晨", "的", "渡轮"]
    assert events[-1] == {"type": "done", "text": "清晨的渡轮"}


@pytest.mark.skipif(bool(os.environ.get("SKIP_NET")), reason="SKIP_NET 已设置，跳过真实网络调用")
async def test_free_chain_real_network() -> None:
    # google 作为 auto 链兜底引擎，验证其真实可用
    outcome = await translate("Good morning", engine="google")
    assert outcome["engine"] == "google"
    assert outcome["text"].strip()


async def test_context_reaches_llm(monkeypatch: pytest.MonkeyPatch) -> None:
    """翻译语境要真的进 prompt：无语境时 the tube 会被译成"管子"。"""
    seen: dict = {}

    async def fake_llm(
        text: str, lang_pair: str, context: str | None = None, deployment_id: int | None = None
    ) -> str:
        seen["context"] = context
        return "地铁到了"

    monkeypatch.setattr(tr, "_llm_translate", fake_llm)
    outcome = await translate(
        "The tube has arrived", engine="llm", context="视频《跟着博主逛伦敦学英语》；主题：旅行"
    )
    assert outcome["text"] == "地铁到了"
    assert "伦敦" in (seen["context"] or "")


def test_context_shapes_system_prompt() -> None:
    with_ctx = tr._translate_messages("hi", "en->zh", "视频《伦敦一日游》")
    without = tr._translate_messages("hi", "en->zh")
    assert "伦敦一日游" in with_ctx[0]["content"]
    assert "the tube" in with_ctx[0]["content"]  # 领域词示例随语境一起给出
    assert "出自" not in without[0]["content"]  # 无语境时不加噪声


def test_video_context_assembly() -> None:
    from worker.tasks import _video_translate_context

    class _V:
        title = "Learn English in London"
        title_zh = "跟着博主逛伦敦学英语"
        topics = ["旅行", "生活", "英式英语", "多余的"]
        summary_zh = "博主带你走一遍伦敦" * 20

    ctx = _video_translate_context(_V())
    assert ctx is not None
    assert "跟着博主逛伦敦学英语" in ctx
    assert "多余的" not in ctx  # 主题只取前三个
    assert len(ctx) < 260  # 摘要截断，避免稀释注意力
    assert _video_translate_context(None) is None
