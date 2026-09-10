"""stream_json / stream_text 单测：schema 校验、非流式重试回退，LLM 全程 mock。"""

import json
import re
from pathlib import Path
from types import SimpleNamespace

import pytest

import domain.llm as llm
import domain.model_runtime as model_runtime
from domain.llm import LLMUnavailable, missing_keys, stream_json, stream_text
from tests.model_binding_stub import seed_default_bindings

WORD_OK = {
    "context_meaning": "释义",
    "pos_in_context": "n.",
    "explanation": "讲解",
    "memory_hint": "提示",
}


def _chunk(text: str | None):
    delta = SimpleNamespace(content=text)
    return SimpleNamespace(model="fake-model", choices=[SimpleNamespace(delta=delta)])


class _FakeStream:
    def __init__(self, texts: list[str]):
        self._chunks = [_chunk(t) for t in texts]

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self._chunks:
            raise StopAsyncIteration
        return self._chunks.pop(0)


def make_fake_openai(stream_texts: list[str], retry_content: str = "{}"):
    """替身 AsyncOpenAI：stream=True 回放 stream_texts，非流式返回 retry_content。"""
    calls: list[dict] = []

    class FakeClient:
        def __init__(self, *args, **kwargs):
            self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

        async def _create(self, **kwargs):
            calls.append(kwargs)
            if kwargs.get("stream"):
                return _FakeStream(stream_texts)
            message = SimpleNamespace(content=retry_content)
            return SimpleNamespace(model="fake-model", choices=[SimpleNamespace(message=message)])

        async def close(self):
            pass

    return FakeClient, calls


async def _collect(gen):
    return [ev async for ev in gen]


@pytest.fixture
async def bound_models(session):
    """能力先绑定直连部署：没绑定的话路由直接报未绑定，走不到流式解析这一层。"""
    return await seed_default_bindings(session)


def test_missing_keys_per_kind() -> None:
    assert missing_keys("word_explain", WORD_OK) == set()
    assert missing_keys("word_explain", {"context_meaning": "x"}) == {
        "pos_in_context",
        "explanation",
        "memory_hint",
    }
    # 新增三种 kind 均已登记必填键
    assert missing_keys("sentence_deep", {}) == {
        "translation",
        "chunks",
        "collocations",
        "structure_note",
    }
    assert missing_keys("phrase", {}) == {
        "meaning",
        "literal_vs_idiomatic",
        "usage_scenes",
        "example",
    }
    assert missing_keys("summary", {}) == {"summary_zh", "difficulty", "key_vocab", "themes"}
    # 未登记 kind 只要求 JSON 对象；非对象一律不通过
    assert missing_keys("unknown_kind", {"anything": 1}) == set()
    assert missing_keys("word_explain", ["not", "a", "dict"]) == {"<object>"}


async def test_stream_json_ok_no_retry(bound_models, monkeypatch) -> None:
    payload = json.dumps(WORD_OK, ensure_ascii=False)
    pieces = [payload[:10], payload[10:25], payload[25:]]
    fake, calls = make_fake_openai(pieces)
    monkeypatch.setattr(model_runtime, "AsyncOpenAI", fake)

    events = await _collect(stream_json("explain-standard", "sys", "user", kind="word_explain"))
    deltas = [e["text"] for e in events if e["type"] == "delta"]
    assert "".join(deltas) == payload
    done = events[-1]
    assert done["type"] == "done"
    assert done["schema_error"] is False
    assert done["result"] == WORD_OK
    assert done["model"] == "fake-model"
    assert len(calls) == 1  # 一次成功不触发重试


async def test_stream_json_bad_json_retries_strict(bound_models, monkeypatch) -> None:
    retry = json.dumps(WORD_OK, ensure_ascii=False)
    fake, calls = make_fake_openai(["这不是 JSON {{{"], retry_content=retry)
    monkeypatch.setattr(model_runtime, "AsyncOpenAI", fake)

    events = await _collect(stream_json("explain-standard", "sys", "user", kind="word_explain"))
    done = events[-1]
    assert done["schema_error"] is False
    assert done["result"] == WORD_OK
    assert len(calls) == 2
    assert not calls[1].get("stream")  # 重试走非流式
    assert "严格输出 JSON" in calls[1]["messages"][0]["content"]  # 提示词加严


async def test_stream_json_missing_keys_triggers_retry(bound_models, monkeypatch) -> None:
    partial = json.dumps({"context_meaning": "只有一个键"}, ensure_ascii=False)
    retry = json.dumps(WORD_OK, ensure_ascii=False)
    fake, calls = make_fake_openai([partial], retry_content=retry)
    monkeypatch.setattr(model_runtime, "AsyncOpenAI", fake)

    events = await _collect(stream_json("explain-standard", "sys", "user", kind="word_explain"))
    done = events[-1]
    assert done["schema_error"] is False
    assert done["result"] == WORD_OK
    assert len(calls) == 2  # 缺必填键同样触发重试


async def test_stream_json_retry_fails_keeps_raw(bound_models, monkeypatch) -> None:
    raw = "still not json"
    fake, calls = make_fake_openai([raw], retry_content="also broken")
    monkeypatch.setattr(model_runtime, "AsyncOpenAI", fake)

    events = await _collect(stream_json("explain-standard", "sys", "user", kind="word_explain"))
    done = events[-1]
    assert done["schema_error"] is True
    assert done["result"] == {"raw_text": raw, "schema_error": True}  # 部分成功不丢内容
    assert len(calls) == 2


async def test_stream_text_deltas_and_done(bound_models, monkeypatch) -> None:
    fake, calls = make_fake_openai(["Hello ", "world", "!"])
    monkeypatch.setattr(model_runtime, "AsyncOpenAI", fake)

    events = await _collect(stream_text("explain-standard", [{"role": "user", "content": "hi"}]))
    assert [e["text"] for e in events if e["type"] == "delta"] == ["Hello ", "world", "!"]
    assert events[-1]["type"] == "done"
    assert events[-1]["text"] == "Hello world!"
    assert len(calls) == 1


async def test_stream_text_empty_raises(bound_models, monkeypatch) -> None:
    fake, _calls = make_fake_openai(["   "])
    monkeypatch.setattr(model_runtime, "AsyncOpenAI", fake)
    with pytest.raises(LLMUnavailable):
        await _collect(stream_text("explain-standard", [{"role": "user", "content": "hi"}]))


async def test_done_model_is_upstream_name_never_capability(bound_models, monkeypatch) -> None:
    """done 事件的 model 位只放上游真名。

    这个字段会被 analyze 路由原样落进 `analysis_result.model`，填能力名等于伪造出处。
    校验失败那条路（schema_error）以前最容易漏，所以专挑它验。
    """
    fake, _calls = make_fake_openai(["still not json"], retry_content="also broken")
    monkeypatch.setattr(model_runtime, "AsyncOpenAI", fake)

    events = await _collect(stream_json("explain-standard", "sys", "user", kind="word_explain"))
    done = events[-1]
    assert done["schema_error"] is True
    assert done["model"] == "fake-model"
    assert done["model"] != "explain-standard"


def test_llm_module_says_capability_not_alias() -> None:
    """`domain/llm.py` 里表示能力的标识符一律 `capability`。

    `alias` 是 LiteLLM 网关时代的措辞（那时注册的真是别名），网关 2026-08-23 已删除，
    再留着这个词只会让人把能力名当模型名渲染给用户。口径见
    01.项目文档/02.架构/02.模型命名与展示口径.md。
    """
    src = Path(llm.__file__).read_text(encoding="utf-8")
    assert re.search(r"\bcapability\b", src)
    assert re.search(r"\balias\b", src) is None
