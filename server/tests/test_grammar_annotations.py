"""讲义划词批注（app/routers/grammar_docs 的批注段）。

正确性压在重定位上：讲义是磁盘上的 .md 且允许 AI 改写后写回，批注存的偏移
随时会整体错位。错位的高亮盖在别的句子上比不显示更糟，所以 `relocate` 的三档
（精确命中 / 正文改动后靠 quote 找回 / 彻底找不到）与「同一句出现多次时选对哪一个」
都必须在单测里炸。analyze 的 LLM 全程打桩，验能力名、上下文拼装与缓存命中。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.config import get_settings
from app.routers import grammar_docs

NOUN = """---
title: 名词
---

# 名词

名词是实词，语法上充当主语。

语法功能很多，主语、宾语都能当。
"""

VERB = """# 动词

动词表示动作。

主语是句子的主体。

再说一次：主语是句子的主体。

最后一次：主语是句子的主体。
"""

DOC = "01.第一章/01.名词.md"
DUP_DOC = "01.第一章/02.动词.md"


@pytest.fixture
def vault(tmp_path, monkeypatch) -> Path:
    """两篇讲义的小 vault：一篇正常，一篇故意让同一句出现三次。"""
    root = tmp_path / "vault"

    def write(rel: str, text: str) -> None:
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")

    write(DOC, NOUN)
    write(DUP_DOC, VERB)
    settings = get_settings()
    monkeypatch.setattr(settings, "grammar_docs_root", str(root), raising=False)
    monkeypatch.setattr(
        settings, "grammar_docs_backup_dir", str(tmp_path / "backups"), raising=False
    )
    return root


def _sse_events(raw: str) -> list[tuple[str, dict]]:
    out = []
    for block in raw.strip().split("\n\n"):
        lines = block.splitlines()
        out.append((lines[0].removeprefix("event: "), json.loads(lines[1].removeprefix("data: "))))
    return out


def _fake_stream(calls: list, text: str = "分析结果"):
    async def fake(capability: str, messages: list[dict]):
        calls.append((capability, messages))
        yield {"type": "delta", "text": text[:1]}
        yield {"type": "done", "text": text, "model": "fake-model", "latency_ms": 1}

    return fake


async def _body_of(client, path: str) -> str:
    resp = await client.get("/grammar/docs/content", params={"path": path})
    return resp.json()["body"]


async def _make(client, path: str, quote: str, occurrence: int = 0, **extra) -> dict:
    """按真实正文算出锚点再建批注——前端就是这么取的，测试别自己编偏移。"""
    body = await _body_of(client, path)
    at = -1
    for _ in range(occurrence + 1):
        at = body.index(quote, at + 1)
    payload = {
        "path": path,
        "quote": quote,
        "prefix": body[max(0, at - 32) : at],
        "suffix": body[at + len(quote) : at + len(quote) + 32],
        "start_hint": at,
        **extra,
    }
    resp = await client.post("/grammar/docs/annotations", json=payload)
    assert resp.status_code == 200, resp.text
    return resp.json()


# ---- relocate 三档 ----


def test_relocate_exact_hit():
    body = "开头一句。名词是实词，语法上充当主语。收尾一句。"
    quote = "名词是实词"
    at = body.index(quote)
    span = grammar_docs.relocate(body, quote, body[:at], body[at + len(quote) : at + 6], at)
    assert span == (at, at + len(quote))


def test_relocate_falls_back_to_quote_after_rewrite():
    """AI 改写把前后文换掉、原句留着：整体匹配失败，靠 quote 仍要找回来。"""
    quote = "名词是实词"
    old = "旧开头。" + quote + "，语法上充当主语。"
    at_old = old.index(quote)
    new = "改写后的开头，多了一大段铺垫文字。" + quote + "，在句子里充当主语。"
    span = grammar_docs.relocate(
        new, quote, old[:at_old], old[at_old + len(quote) :], at_old
    )
    assert span == (new.index(quote), new.index(quote) + len(quote))


def test_relocate_returns_none_when_quote_gone():
    """整段被重写掉：宁可不给落点，也不能随便挑一句盖上去。"""
    body = "整篇都被重写了，一个字都没留。"
    assert grammar_docs.relocate(body, "名词是实词", "旧开头。", "。", 4) is None


def test_relocate_empty_quote_is_none():
    assert grammar_docs.relocate("随便一段正文。", "", "", "", 0) is None


def test_relocate_picks_occurrence_by_edges():
    """同一句出现三次，prefix/suffix 说了算——start_hint 故意指向第一次。"""
    quote = "主语是句子的主体"
    body = f"甲说：{quote}。乙说：{quote}。丙说：{quote}。"
    third = body.rindex(quote)
    span = grammar_docs.relocate(body, quote, "丙说：", "。", 0)
    assert span == (third, third + len(quote))


def test_relocate_picks_nearest_occurrence_when_edges_broken():
    """前后文都对不上时退到 start_hint：取离原位最近的那一次，不是第一次。"""
    quote = "主语是句子的主体"
    body = f"甲说：{quote}。乙说：{quote}。丙说：{quote}。"
    second = body.index(quote, body.index(quote) + 1)
    span = grammar_docs.relocate(body, quote, "早就没了的前文", "早就没了的后文", second + 2)
    assert span == (second, second + len(quote))


# ---- CRUD ----


async def test_create_and_list(client, vault):
    created = await _make(client, DOC, "名词是实词", note="这句要背", color="green")
    assert created["doc_path"] == DOC
    assert created["quote"] == "名词是实词"
    assert created["note"] == "这句要背"
    assert created["color"] == "green"
    assert created["ai_kind"] is None and created["ai_result"] is None
    assert created["created_at"] and created["updated_at"]

    body = await _body_of(client, DOC)
    at = body.index("名词是实词")
    assert (created["resolved_start"], created["resolved_end"]) == (at, at + 5)

    items = (await client.get("/grammar/docs/annotations", params={"path": DOC})).json()["items"]
    assert [i["id"] for i in items] == [created["id"]]
    assert items[0]["resolved_start"] == at


async def test_list_only_returns_this_doc(client, vault):
    await _make(client, DOC, "名词是实词")
    other = await _make(client, DUP_DOC, "动词表示动作")
    resp = await client.get("/grammar/docs/annotations", params={"path": DUP_DOC})
    assert [i["id"] for i in resp.json()["items"]] == [other["id"]]


async def test_create_validates_path(client, vault):
    resp = await client.post(
        "/grammar/docs/annotations",
        json={"path": "../外部.md", "quote": "x", "prefix": "", "suffix": "", "start_hint": 0},
    )
    assert resp.status_code == 400
    resp = await client.post(
        "/grammar/docs/annotations",
        json={"path": "01.第一章/99.没有.md", "quote": "x", "prefix": "", "suffix": "",
              "start_hint": 0},
    )
    assert resp.status_code == 404


async def test_create_truncates_edges(client, vault):
    """前端多送了前后文也按 32 字符存：锚点长度不一致会让 relocate 的一档判据不稳。"""
    resp = await client.post(
        "/grammar/docs/annotations",
        json={
            "path": DOC,
            "quote": "名词是实词",
            "prefix": "前" * 100,
            "suffix": "后" * 100,
            "start_hint": 6,
        },
    )
    assert resp.status_code == 200
    row = resp.json()
    assert len(row["prefix"]) == 32 and len(row["suffix"]) == 32


async def test_resolves_after_doc_rewritten(client, vault):
    """AI 改稿写回后，落点跟着正文走而不是停在旧偏移上。"""
    created = await _make(client, DOC, "名词是实词")
    rewritten = "# 名词\n\n补了一整段导语，位置整体后移。\n\n名词是实词，语法上充当主语。\n"
    (vault / DOC).write_text(rewritten, encoding="utf-8")

    items = (await client.get("/grammar/docs/annotations", params={"path": DOC})).json()["items"]
    at = rewritten.index("名词是实词")
    assert items[0]["id"] == created["id"]
    assert items[0]["resolved_start"] == at
    assert items[0]["start_hint"] != at  # 存的偏移已经过期，只作提示


async def test_null_span_when_quote_gone(client, vault):
    """原句被删掉：两个字段都为 null，前端据此提示「找不到落点」。"""
    await _make(client, DOC, "名词是实词")
    (vault / DOC).write_text("# 名词\n\n整篇重写，原句一个字都没留。\n", encoding="utf-8")
    items = (await client.get("/grammar/docs/annotations", params={"path": DOC})).json()["items"]
    assert items[0]["resolved_start"] is None
    assert items[0]["resolved_end"] is None


async def test_patch_note_and_color(client, vault):
    created = await _make(client, DOC, "名词是实词", note="旧笔记")
    resp = await client.patch(
        f"/grammar/docs/annotations/{created['id']}", json={"note": "新笔记", "color": "pink"}
    )
    assert resp.status_code == 200
    row = resp.json()
    assert row["note"] == "新笔记" and row["color"] == "pink"
    assert row["resolved_start"] == created["resolved_start"]


async def test_patch_null_note_clears(client, vault):
    created = await _make(client, DOC, "名词是实词", note="旧笔记")
    row = (
        await client.patch(f"/grammar/docs/annotations/{created['id']}", json={"note": None})
    ).json()
    assert row["note"] is None
    assert row["color"] == "yellow"  # 没传的字段不动


async def test_patch_and_delete_missing_404(client, vault):
    resp = await client.patch("/grammar/docs/annotations/999", json={"note": "x"})
    assert resp.status_code == 404
    assert (await client.delete("/grammar/docs/annotations/999")).status_code == 404


async def test_delete(client, vault):
    created = await _make(client, DOC, "名词是实词")
    resp = await client.delete(f"/grammar/docs/annotations/{created['id']}")
    assert resp.status_code == 200 and resp.json() == {"ok": True}
    items = (await client.get("/grammar/docs/annotations", params={"path": DOC})).json()["items"]
    assert items == []


# ---- analyze ----


async def test_analyze_uses_context_and_capability(client, vault, monkeypatch):
    created = await _make(client, DOC, "名词是实词", note="这里没懂")
    calls: list = []
    monkeypatch.setattr(grammar_docs, "stream_text", _fake_stream(calls))

    resp = await client.post(
        f"/grammar/docs/annotations/{created['id']}/analyze", json={"kind": "grammar"}
    )
    assert resp.status_code == 200
    assert resp.json() == {"text": "分析结果", "model": "fake-model", "cached": False}

    capability, messages = calls[0]
    assert capability == "grammar-deep"
    system, user = messages[0]["content"], messages[1]["content"]
    assert "首先" in system and "综上所述" in system  # 明写禁用的套话
    assert "名词是实词" in user
    assert "语法上充当主语" in user  # 上下文一起给了模型
    assert "这里没懂" in user  # 用户自己的批注也带上


async def test_analyze_capability_per_kind(client, vault, monkeypatch):
    created = await _make(client, DOC, "名词是实词")
    calls: list = []
    monkeypatch.setattr(grammar_docs, "stream_text", _fake_stream(calls))
    for kind in ("explain", "translate"):
        resp = await client.post(
            f"/grammar/docs/annotations/{created['id']}/analyze",
            json={"kind": kind, "refresh": True},
        )
        assert resp.status_code == 200
    assert [c[0] for c in calls] == ["explain-standard", "explain-standard"]


async def test_analyze_caches_and_refresh_recomputes(client, vault, monkeypatch):
    created = await _make(client, DOC, "名词是实词")
    calls: list = []
    monkeypatch.setattr(grammar_docs, "stream_text", _fake_stream(calls))
    url = f"/grammar/docs/annotations/{created['id']}/analyze"

    first = (await client.post(url, json={"kind": "explain"})).json()
    assert first["cached"] is False
    assert len(calls) == 1

    # 缓存落在了这一行上，列表接口能直接读到
    items = (await client.get("/grammar/docs/annotations", params={"path": DOC})).json()["items"]
    assert items[0]["ai_kind"] == "explain"
    assert items[0]["ai_result"]["text"] == "分析结果"
    assert items[0]["ai_result"]["model"] == "fake-model"
    assert items[0]["ai_result"]["at"]

    second = (await client.post(url, json={"kind": "explain"})).json()
    assert second == {"text": "分析结果", "model": "fake-model", "cached": True}
    assert len(calls) == 1  # 命中缓存不再打模型

    monkeypatch.setattr(grammar_docs, "stream_text", _fake_stream(calls, text="重算结果"))
    again = (await client.post(url, json={"kind": "explain", "refresh": True})).json()
    assert again["text"] == "重算结果" and again["cached"] is False
    assert len(calls) == 2


async def test_analyze_other_kind_does_not_hit_cache(client, vault, monkeypatch):
    """换 kind 就得重算——上一档的结果顶上去等于答非所问。"""
    created = await _make(client, DOC, "名词是实词")
    calls: list = []
    monkeypatch.setattr(grammar_docs, "stream_text", _fake_stream(calls))
    url = f"/grammar/docs/annotations/{created['id']}/analyze"
    await client.post(url, json={"kind": "explain"})
    await client.post(url, json={"kind": "translate"})
    assert len(calls) == 2


async def test_analyze_stream_sse_and_persists(client, vault, monkeypatch):
    created = await _make(client, DOC, "名词是实词")
    calls: list = []
    monkeypatch.setattr(grammar_docs, "stream_text", _fake_stream(calls))

    resp = await client.post(
        f"/grammar/docs/annotations/{created['id']}/analyze",
        params={"stream": "true"},
        json={"kind": "translate"},
    )
    assert resp.headers["content-type"].startswith("text/event-stream")
    events = _sse_events(resp.text)
    assert events[0] == ("delta", {"type": "delta", "text": "分"})
    assert events[-1][0] == "done"
    assert events[-1][1]["text"] == "分析结果"
    assert events[-1][1]["model"] == "fake-model"

    items = (await client.get("/grammar/docs/annotations", params={"path": DOC})).json()["items"]
    assert items[0]["ai_kind"] == "translate"
    assert items[0]["ai_result"]["text"] == "分析结果"


async def test_analyze_stream_cache_hit_keeps_event_shape(client, vault, monkeypatch):
    created = await _make(client, DOC, "名词是实词")
    calls: list = []
    monkeypatch.setattr(grammar_docs, "stream_text", _fake_stream(calls))
    url = f"/grammar/docs/annotations/{created['id']}/analyze"
    await client.post(url, json={"kind": "grammar"})

    resp = await client.post(url, params={"stream": "true"}, json={"kind": "grammar"})
    events = _sse_events(resp.text)
    assert [e[0] for e in events] == ["delta", "done"]
    assert events[-1][1]["text"] == "分析结果"
    assert len(calls) == 1


async def test_analyze_context_survives_rewrite(client, vault, monkeypatch):
    """正文改过之后，送给模型的上下文取的是**当前**正文，不是建批注时那份。"""
    created = await _make(client, DOC, "名词是实词")
    (vault / DOC).write_text(
        "# 名词\n\n名词是实词，改写后这里换成了新的解释。\n", encoding="utf-8"
    )
    calls: list = []
    monkeypatch.setattr(grammar_docs, "stream_text", _fake_stream(calls))
    await client.post(
        f"/grammar/docs/annotations/{created['id']}/analyze", json={"kind": "explain"}
    )
    user = calls[0][1][1]["content"]
    assert "改写后这里换成了新的解释" in user
    assert "语法上充当主语" not in user


async def test_analyze_bad_kind_and_missing(client, vault):
    created = await _make(client, DOC, "名词是实词")
    resp = await client.post(
        f"/grammar/docs/annotations/{created['id']}/analyze", json={"kind": "summary"}
    )
    assert resp.status_code == 400
    resp = await client.post("/grammar/docs/annotations/999/analyze", json={"kind": "grammar"})
    assert resp.status_code == 404


async def test_analyze_llm_unavailable_503(client, vault, monkeypatch):
    created = await _make(client, DOC, "名词是实词")

    async def broken(capability: str, messages: list[dict]):
        raise grammar_docs.LLMUnavailable("网关未配置")
        yield  # 不会执行到；只为保持异步生成器形态

    monkeypatch.setattr(grammar_docs, "stream_text", broken)
    resp = await client.post(
        f"/grammar/docs/annotations/{created['id']}/analyze", json={"kind": "grammar"}
    )
    assert resp.status_code == 503


async def test_analyze_stream_llm_unavailable_emits_error(client, vault, monkeypatch):
    created = await _make(client, DOC, "名词是实词")

    async def broken(capability: str, messages: list[dict]):
        raise grammar_docs.LLMUnavailable("网关未配置")
        yield

    monkeypatch.setattr(grammar_docs, "stream_text", broken)
    resp = await client.post(
        f"/grammar/docs/annotations/{created['id']}/analyze",
        params={"stream": "true"},
        json={"kind": "grammar"},
    )
    events = _sse_events(resp.text)
    assert events[-1][0] == "error"
    # 失败不许写进缓存，否则下次直接返回一条空结果
    items = (await client.get("/grammar/docs/annotations", params={"path": DOC})).json()["items"]
    assert items[0]["ai_kind"] is None


async def test_analyze_uses_stored_edges_when_quote_gone(client, vault, monkeypatch):
    """正文里找不回落点也要能分析：退用建批注时存下的前后文。"""
    created = await _make(client, DOC, "名词是实词")
    (vault / DOC).write_text("# 名词\n\n整篇重写。\n", encoding="utf-8")
    calls: list = []
    monkeypatch.setattr(grammar_docs, "stream_text", _fake_stream(calls))
    resp = await client.post(
        f"/grammar/docs/annotations/{created['id']}/analyze", json={"kind": "explain"}
    )
    assert resp.status_code == 200
    assert "名词是实词" in calls[0][1][1]["content"]
