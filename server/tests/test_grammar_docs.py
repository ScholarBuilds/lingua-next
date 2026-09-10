"""语法讲义文档接口（app/routers/grammar_docs）。

阅读器的正确性全压在这一层：树排错序目录就乱，prev/next 错了翻页会跳章，
路径校验松了 content/apply 就能读写 vault 外的任意文件——这三类错运行时
都不报错，必须在单测里炸。improve 的 LLM 全程打桩，只验消息拼装与事件形状。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.config import get_settings
from app.routers import grammar_docs
from domain import storage as storage_mod
from domain import studio_media_assets
from tests.test_studio import FakeStorage, noise_png, seed_asset

OUTLINE = """---
title: 测试大纲
date: 2026-01-01
tags:
  - 语法
  - 大纲
categories: 英语学习
description: 大纲描述
---

# 测试大纲

语法总览。
"""

NOUN = """---
title: 名词
description: 名词讲解
---

# 名词

名词是实词，语法上充当主语。

语法功能很多。
"""

VERB = """# 动词

动词表示动作，英文叫 Verb。
"""

CLAUSE = """# 从句

从句由连词引导，语法上是句子成分。
"""


@pytest.fixture
def vault(tmp_path, monkeypatch) -> Path:
    """两章节 + loose 文档 + 归档目录的小 vault，settings 指过来。"""
    root = tmp_path / "vault"

    def write(rel: str, text: str) -> None:
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")

    write("00.测试大纲.md", OUTLINE)
    write("01.第一章/01.名词.md", NOUN)
    write("01.第一章/02.动词.md", VERB)
    write("02.第二章/01.从句.md", CLAUSE)
    write("_归档-旧版/99.旧稿.md", "# 旧稿\n\n语法 语法 语法。\n")
    settings = get_settings()
    monkeypatch.setattr(settings, "grammar_docs_root", str(root), raising=False)
    monkeypatch.setattr(
        settings, "grammar_docs_backup_dir", str(tmp_path / "backups"), raising=False
    )
    return root


@pytest.fixture
def fake_storage():
    """内存存储：图片附件的字节要真读得出来，image_blocks 才拼得出 data URL。"""
    fake = FakeStorage()
    storage_mod.set_storage(fake)
    yield fake
    storage_mod.set_storage(None)


def _sse_events(raw: str) -> list[tuple[str, dict]]:
    out = []
    for block in raw.strip().split("\n\n"):
        lines = block.splitlines()
        out.append((lines[0].removeprefix("event: "), json.loads(lines[1].removeprefix("data: "))))
    return out


def _fake_stream(calls: list):
    async def fake(alias: str, messages: list[dict]):
        calls.append((alias, messages))
        yield {"type": "delta", "text": "改"}
        yield {"type": "delta", "text": "进稿"}
        yield {"type": "done", "text": "改进稿", "model": "fake-model", "latency_ms": 1}

    return fake


async def test_tree_structure_and_order(client, vault):
    resp = await client.get("/grammar/docs/tree")
    assert resp.status_code == 200
    data = resp.json()
    assert data["loose"] == [{"path": "00.测试大纲.md", "name": "00.测试大纲"}]
    assert [c["name"] for c in data["chapters"]] == ["01.第一章", "02.第二章"]
    assert [d["name"] for d in data["chapters"][0]["docs"]] == ["01.名词", "02.动词"]
    all_paths = [d["path"] for c in data["chapters"] for d in c["docs"]]
    assert not any("_归档-旧版" in p for p in all_paths)


async def test_library_status(client, vault):
    resp = await client.get("/grammar/docs/library")

    assert resp.status_code == 200
    assert resp.json()["root"] == str(vault.resolve())
    assert resp.json()["exists"] is True
    assert resp.json()["documents"] == 4


async def test_import_library_copies_active_docs_without_overwriting(
    client, vault, tmp_path
):
    source = tmp_path / "old-vault"
    (source / "01.章节").mkdir(parents=True)
    (source / "01.章节" / "01.新讲义.md").write_text("# 新讲义\n", encoding="utf-8")
    (source / ".obsidian").mkdir()
    (source / ".obsidian" / "private.md").write_text("private", encoding="utf-8")
    (source / "_归档-旧版").mkdir()
    (source / "_归档-旧版" / "old.md").write_text("old", encoding="utf-8")

    first = await client.post(
        "/grammar/docs/library/import", json={"source_path": str(source)}
    )
    second = await client.post(
        "/grammar/docs/library/import", json={"source_path": str(source)}
    )

    assert first.status_code == 200
    assert first.json()["discovered"] == 1
    assert first.json()["copied"] == 1
    assert second.json()["copied"] == 0
    assert second.json()["unchanged"] == 1
    assert (vault / "01.章节" / "01.新讲义.md").read_text(encoding="utf-8") == "# 新讲义\n"
    assert not (vault / ".obsidian").exists()


async def test_import_library_reports_conflict_and_keeps_current_doc(
    client, vault, tmp_path
):
    source = tmp_path / "old-vault"
    source.mkdir()
    (source / "00.测试大纲.md").write_text("# 不应覆盖\n", encoding="utf-8")

    resp = await client.post(
        "/grammar/docs/library/import", json={"source_path": str(source)}
    )

    assert resp.status_code == 200
    assert resp.json()["conflicts"] == ["00.测试大纲.md"]
    assert (vault / "00.测试大纲.md").read_text(encoding="utf-8") == OUTLINE


async def test_import_library_rejects_missing_or_nested_source(client, vault, tmp_path):
    missing = await client.post(
        "/grammar/docs/library/import", json={"source_path": str(tmp_path / "missing")}
    )
    nested = await client.post(
        "/grammar/docs/library/import", json={"source_path": str(vault / "01.第一章")}
    )

    assert missing.status_code == 422
    assert nested.status_code == 422


async def test_content_props_and_neighbors(client, vault):
    resp = await client.get("/grammar/docs/content", params={"path": "00.测试大纲.md"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["name"] == "00.测试大纲"
    assert data["props"]["title"] == "测试大纲"
    assert data["props"]["tags"] == ["语法", "大纲"]
    assert data["props"]["categories"] == "英语学习"
    assert data["body"].startswith("# 测试大纲")  # front matter 已剥
    # raw 是原始全文：front matter 原样在，body 是它的后缀（前端写回按区间拼接）
    assert data["raw"].startswith("---")
    assert data["raw"].endswith(data["body"])
    assert data["words"] == len(data["body"])
    assert data["mtime"]
    # loose 排全局第一：没有 prev，next 进第一章
    assert data["prev"] is None
    assert data["next"] == {"path": "01.第一章/01.名词.md", "name": "01.名词"}


async def test_content_without_front_matter(client, vault):
    resp = await client.get("/grammar/docs/content", params={"path": "01.第一章/02.动词.md"})
    data = resp.json()
    assert data["props"]["tags"] == []
    assert data["raw"].endswith(data["body"])  # 没有 front matter 时 raw 与 body 同源
    # 跨章节翻页：prev 同章上一篇，next 进下一章
    assert data["prev"]["path"] == "01.第一章/01.名词.md"
    assert data["next"]["path"] == "02.第二章/01.从句.md"


async def test_last_doc_has_no_next(client, vault):
    resp = await client.get("/grammar/docs/content", params={"path": "02.第二章/01.从句.md"})
    assert resp.json()["next"] is None


async def test_path_traversal_rejected(client, vault):
    (vault.parent / "外部.md").write_text("# 外部", encoding="utf-8")
    resp = await client.get("/grammar/docs/content", params={"path": "../外部.md"})
    assert resp.status_code == 400


async def test_collections_isolate_tree_search_and_pagination(client, vault):
    for collection, directory in grammar_docs.COLLECTION_DIRS.items():
        if collection == "software":
            continue
        folder = vault / directory
        folder.mkdir()
        (folder / "01.讲义.md").write_text(f"# {collection}\n共同检索词", encoding="utf-8")
        (folder / "02.讲义.md").write_text("# 第二篇\n共同检索词", encoding="utf-8")
        tree = (await client.get("/grammar/docs/tree", params={"collection": collection})).json()
        assert [doc["path"] for doc in tree["loose"]] == [
            f"{directory}/01.讲义.md", f"{directory}/02.讲义.md",
        ]
        search = (await client.get(
            "/grammar/docs/search", params={"collection": collection, "q": "共同检索词"},
        )).json()
        assert len(search["items"]) == 2
        assert all(doc["path"].startswith(directory + "/") for doc in search["items"])
        content = (await client.get(
            "/grammar/docs/content", params={"path": tree["loose"][0]["path"]},
        )).json()
        assert content["prev"] is None
        assert content["next"]["path"] == f"{directory}/02.讲义.md"
    grammar = (await client.get("/grammar/docs/tree")).json()
    assert all(chapter["name"] not in grammar_docs.COLLECTION_DIRS.values()
               for chapter in grammar["chapters"])
    assert (await client.get("/grammar/docs/tree?collection=unknown")).status_code == 422


async def test_software_catalog_tree_asset_and_legacy_source(client, vault, monkeypatch):
    library = vault / "05.软件英语/01.macOS系统设置"
    (library / "01.基础入门").mkdir(parents=True)
    (library / "_assets/screenshots").mkdir(parents=True)
    (library / "_meta").mkdir()
    (library / "00.macOS系统设置_大纲.md").write_text("""---
software_id: macos-system-settings
software_name: macOS 系统设置
platform: macOS
version: 27.0 Beta
captured_at: 2026-09-09
cover: _assets/screenshots/wifi.png
status: reviewed
screenshots: 1
---
# 大纲
""", encoding="utf-8")
    (library / "01.基础入门/01.入门.md").write_text("# 入门\n\n![Wi-Fi](../../_assets/screenshots/wifi.png)\n", encoding="utf-8")
    (library / "_assets/screenshots/wifi.png").write_bytes(noise_png())
    (library / "_meta/legacy-source-map.json").write_text(json.dumps({
        "mappings": {"macos-27|wifi|wifi|": {
            "document": "05.软件英语/01.macOS系统设置/01.基础入门/01.入门.md",
            "anchor": "capture-wifi",
        }},
    }), encoding="utf-8")
    monkeypatch.setattr(get_settings(), "runtime_profile", "desktop", raising=False)

    catalog = (await client.get("/grammar/docs/software/libraries")).json()["items"]
    assert catalog[0]["software_id"] == "macos-system-settings"
    assert catalog[0]["documents"] == 2
    tree = (await client.get("/grammar/docs/tree", params={"collection": "software", "library": "macos-system-settings"})).json()
    assert tree["loose"][0]["path"].startswith("05.软件英语/01.macOS系统设置/")
    image = await client.get("/grammar/docs/assets/macos-system-settings/wifi.png")
    assert image.status_code == 200
    assert image.headers["cache-control"] == "private, no-store"
    assert image.headers["x-content-type-options"] == "nosniff"
    legacy = (await client.get("/grammar/docs/software/resolve-legacy-source", params={"collection": "macos-27", "page": "wifi", "capture": "wifi"})).json()
    assert legacy == {"found": True, "library": "macos-system-settings", "document": "05.软件英语/01.macOS系统设置/01.基础入门/01.入门.md", "anchor": "capture-wifi"}


async def test_software_assets_reject_traversal_and_non_image(client, vault, monkeypatch):
    library = vault / "05.软件英语/01.macOS系统设置"
    (library / "_assets/screenshots").mkdir(parents=True)
    (library / "00.macOS系统设置_大纲.md").write_text("---\nsoftware_id: macos-system-settings\n---\n# 大纲\n")
    (library / "_assets/screenshots/not-image.png").write_text("secret")
    monkeypatch.setattr(get_settings(), "runtime_profile", "desktop", raising=False)
    assert (await client.get("/grammar/docs/assets/macos-system-settings/not-image.png")).status_code == 415
    assert (await client.get("/grammar/docs/assets/macos-system-settings/.private.png")).status_code == 400


async def test_collection_import_preserves_original_and_scopes_destination(client, vault, tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    (source / "lesson.md").write_text("# 单词\nexample", encoding="utf-8")
    result = await client.post(
        "/grammar/docs/library/import?collection=vocabulary",
        json={"source_path": str(source)},
    )
    assert result.status_code == 200
    assert (vault / "01.英语词汇/lesson.md").read_text() == (source / "lesson.md").read_text()
    assert not (vault / "lesson.md").exists()


async def test_absolute_and_non_md_rejected(client, vault):
    resp = await client.get(
        "/grammar/docs/content", params={"path": str(vault / "00.测试大纲.md")}
    )
    assert resp.status_code == 400
    resp = await client.get("/grammar/docs/content", params={"path": "01.第一章/01.名词.txt"})
    assert resp.status_code == 400


async def test_archived_doc_rejected(client, vault):
    """归档目录不进树，content 也不放行——不然 prev/next 会对不上全局顺序。"""
    resp = await client.get("/grammar/docs/content", params={"path": "_归档-旧版/99.旧稿.md"})
    assert resp.status_code == 400


async def test_missing_doc_404(client, vault):
    resp = await client.get("/grammar/docs/content", params={"path": "01.第一章/99.不存在.md"})
    assert resp.status_code == 404


async def test_search_orders_by_hits(client, vault):
    resp = await client.get("/grammar/docs/search", params={"q": "语法"})
    items = resp.json()["items"]
    # 名词篇命中 2 行最多，排最前；归档目录不参与
    assert items[0]["path"] == "01.第一章/01.名词.md"
    assert items[0]["n"] == 2
    assert items[0]["chapter"] == "01.第一章"
    assert len(items[0]["hits"]) == 2
    assert items[0]["hits"][0]["line"] >= 1
    assert "语法" in items[0]["hits"][0]["text"]
    assert all("_归档-旧版" not in i["path"] for i in items)


async def test_search_case_insensitive(client, vault):
    resp = await client.get("/grammar/docs/search", params={"q": "verb"})
    items = resp.json()["items"]
    assert [i["path"] for i in items] == ["01.第一章/02.动词.md"]


async def test_search_empty_query(client, vault):
    resp = await client.get("/grammar/docs/search", params={"q": "  "})
    assert resp.json() == {"items": []}


async def test_apply_backs_up_then_writes(client, vault, tmp_path):
    new_content = "# 名词（改）\n\n新正文。\n"
    resp = await client.post(
        "/grammar/docs/apply", json={"path": "01.第一章/01.名词.md", "content": new_content}
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    assert data["backup"].startswith("01.第一章/01.名词/")
    # 备份的是旧文，vault 里是新文
    backup = tmp_path / "backups" / data["backup"]
    assert backup.read_text(encoding="utf-8") == NOUN
    assert (vault / "01.第一章/01.名词.md").read_text(encoding="utf-8") == new_content


async def test_apply_traversal_rejected(client, vault, tmp_path):
    resp = await client.post(
        "/grammar/docs/apply", json={"path": "../外部.md", "content": "x"}
    )
    assert resp.status_code == 400
    assert not (tmp_path / "backups").exists()


async def test_improve_non_stream(client, vault, monkeypatch):
    calls: list = []
    monkeypatch.setattr(grammar_docs, "stream_text", _fake_stream(calls))
    resp = await client.post(
        "/grammar/docs/improve",
        json={"path": "01.第一章/01.名词.md", "instruction": "补充例句"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"text": "改进稿", "model": "fake-model"}
    alias, messages = calls[0]
    assert alias == "explain-standard"
    user = messages[1]["content"]
    assert "名词是实词" in user  # 全文进了提示词
    assert "补充例句" in user


async def test_improve_stream_sse(client, vault, monkeypatch):
    calls: list = []
    monkeypatch.setattr(grammar_docs, "stream_text", _fake_stream(calls))
    resp = await client.post(
        "/grammar/docs/improve",
        params={"stream": "true"},
        json={"path": "01.第一章/01.名词.md", "selection": "名词是实词"},
    )
    assert resp.headers["content-type"].startswith("text/event-stream")
    events = _sse_events(resp.text)
    assert events[0] == ("delta", {"type": "delta", "text": "改"})
    assert events[-1][0] == "done"
    assert events[-1][1]["text"] == "改进稿"
    assert events[-1][1]["model"] == "fake-model"
    # selection 模式只送片段，不带全文
    user = calls[0][1][1]["content"]
    assert "名词是实词" in user
    assert "语法功能很多" not in user


async def test_improve_truncates_long_doc(client, vault, monkeypatch):
    long_body = "# 长文\n\n" + "语法点。" * 4000
    (vault / "02.第二章" / "02.长文.md").write_text(long_body, encoding="utf-8")
    calls: list = []
    monkeypatch.setattr(grammar_docs, "stream_text", _fake_stream(calls))
    resp = await client.post("/grammar/docs/improve", json={"path": "02.第二章/02.长文.md"})
    assert resp.status_code == 200
    user = calls[0][1][1]["content"]
    assert "正文过长" in user
    assert len(user) < len(long_body)


async def test_improve_without_attachments_keeps_plain_string_content(
    client, vault, monkeypatch
):
    """不带附件的完善必须保持纯字符串 content。

    无条件改成块数组的话，每一次普通完善都变成多模态请求——回归保护。
    """
    calls: list = []
    monkeypatch.setattr(grammar_docs, "stream_text", _fake_stream(calls))
    resp = await client.post("/grammar/docs/improve", json={"path": "01.第一章/01.名词.md"})
    assert resp.status_code == 200
    system, user = calls[0][1]
    assert isinstance(user["content"], str)
    # 附件那条系统要求也不该出现：没带附件还讲一遍会让模型去找不存在的东西
    assert "约束与素材" not in system["content"]


async def test_improve_with_image_sends_multimodal_blocks(
    client, session, vault, fake_storage, monkeypatch
):
    asset = await seed_asset(session, fake_storage, noise_png())
    calls: list = []
    monkeypatch.setattr(grammar_docs, "stream_text", _fake_stream(calls))
    resp = await client.post(
        "/grammar/docs/improve",
        json={"path": "01.第一章/01.名词.md", "ref_asset_ids": [asset.id]},
    )
    assert resp.status_code == 200
    system, user = calls[0][1]
    content = user["content"]
    assert isinstance(content, list)
    # 第一块永远是讲义正文那段纯文本，附件块跟在后面
    assert content[0]["type"] == "text" and "名词是实词" in content[0]["text"]
    assert content[1]["type"] == "image_url"
    assert content[1]["image_url"]["url"].startswith("data:image/png;base64,")
    assert "约束与素材" in system["content"]


async def test_improve_with_file_sends_its_text(client, session, vault, fake_storage, monkeypatch):
    attachment = await studio_media_assets.ingest_one(
        session,
        "所有格由 's 构成，复数名词只加撇号。".encode(),
        kind="file",
        name="体例.txt",
        mime="text/plain",
    )
    await session.commit()
    calls: list = []
    monkeypatch.setattr(grammar_docs, "stream_text", _fake_stream(calls))
    resp = await client.post(
        "/grammar/docs/improve",
        json={"path": "01.第一章/01.名词.md", "file_asset_ids": [attachment.id]},
    )
    assert resp.status_code == 200
    content = calls[0][1][1]["content"]
    texts = [b["text"] for b in content if b["type"] == "text"]
    assert any("体例.txt" in t and "复数名词只加撇号" in t for t in texts)


async def test_improve_survives_missing_asset_ids(
    client, session, vault, fake_storage, monkeypatch
):
    """一个坏附件不该把整轮完善拖成 500，好的那些照样上送。"""
    asset = await seed_asset(session, fake_storage, noise_png())
    calls: list = []
    monkeypatch.setattr(grammar_docs, "stream_text", _fake_stream(calls))
    resp = await client.post(
        "/grammar/docs/improve",
        json={
            "path": "01.第一章/01.名词.md",
            "ref_asset_ids": [asset.id, 4242],
            "file_asset_ids": [4243],
        },
    )
    assert resp.status_code == 200
    assert resp.json()["text"] == "改进稿"
    content = calls[0][1][1]["content"]
    assert sum(1 for b in content if b["type"] == "image_url") == 1
    # 读不出的附件照样告诉模型有这么个东西在，不悄悄丢
    assert any("2 个附件读不出来" in b["text"] for b in content if b["type"] == "text")


async def test_improve_truncates_attachment_lists(client, vault, monkeypatch):
    """条数上限沿用 studio_gpt.MAX_INPUT_ATTACHMENTS，超出的直接不取。"""
    seen: list[int] = []

    async def fake_files(_session, asset_ids):
        seen.extend(asset_ids)
        return [{"type": "text", "text": f"附件：{asset_ids[0]}.txt"}]

    monkeypatch.setattr(grammar_docs.studio_gpt, "file_blocks", fake_files)
    monkeypatch.setattr(grammar_docs, "stream_text", _fake_stream([]))
    limit = grammar_docs.studio_gpt.MAX_INPUT_ATTACHMENTS
    resp = await client.post(
        "/grammar/docs/improve",
        json={"path": "01.第一章/01.名词.md", "file_asset_ids": list(range(limit + 5))},
    )
    assert resp.status_code == 200
    assert seen == list(range(limit))


async def test_improve_llm_unavailable_503(client, vault, monkeypatch):
    async def broken(alias: str, messages: list[dict]):
        raise grammar_docs.LLMUnavailable("网关未配置")
        yield  # 不会执行到；只为保持异步生成器形态

    monkeypatch.setattr(grammar_docs, "stream_text", broken)
    resp = await client.post("/grammar/docs/improve", json={"path": "00.测试大纲.md"})
    assert resp.status_code == 503


async def test_apply_twice_keeps_both_backups(client, vault, tmp_path):
    """同一秒双写回（前端双击/超时重试）不许覆盖唯一一份原文备份。"""
    p = "01.第一章/01.名词.md"
    r1 = await client.post("/grammar/docs/apply", json={"path": p, "content": "# 一改\n"})
    r2 = await client.post("/grammar/docs/apply", json={"path": p, "content": "# 二改\n"})
    assert r1.status_code == 200 and r2.status_code == 200
    b1 = tmp_path / "backups" / r1.json()["backup"]
    b2 = tmp_path / "backups" / r2.json()["backup"]
    assert b1 != b2
    # 第一份备份必须仍是真原文；第二份是第一次写回后的内容
    assert b1.read_text(encoding="utf-8") == NOUN
    assert b2.read_text(encoding="utf-8") == "# 一改\n"


async def test_apply_stale_base_mtime_409(client, vault):
    """写回以打开文档时的 raw 为基底整篇覆盖——期间文件被 Obsidian 改过必须拒，
    否则外部编辑被静默回滚。"""
    p = "01.第一章/01.名词.md"
    content = (await client.get(f"/grammar/docs/content?path={p}")).json()
    # 模拟外部编辑：直接改文件并把 mtime 往后拨
    target = vault / p
    target.write_text(NOUN + "\n外部补了一段。\n", encoding="utf-8")
    import os as _os

    st = target.stat()
    _os.utime(target, (st.st_atime, st.st_mtime + 5))
    resp = await client.post(
        "/grammar/docs/apply",
        json={"path": p, "content": "# 盲写\n", "base_mtime": content["mtime"]},
    )
    assert resp.status_code == 409
    # 文件保持外部编辑后的样子
    assert "外部补了一段" in target.read_text(encoding="utf-8")


async def test_apply_fresh_base_mtime_ok(client, vault):
    p = "01.第一章/02.动词.md"
    content = (await client.get(f"/grammar/docs/content?path={p}")).json()
    resp = await client.post(
        "/grammar/docs/apply",
        json={"path": p, "content": "# 动词（改）\n", "base_mtime": content["mtime"]},
    )
    assert resp.status_code == 200


async def test_dot_dirs_rejected_even_when_unlisted(client, vault):
    """拦截面必须与 _scan 一致：树上看不见的点号目录不能被 content/apply 摸到。
    大小写变体（大小写不敏感文件系统上的绕法）一并拒。"""
    (vault / ".trash").mkdir()
    (vault / ".trash/删掉的.md").write_text("# 软删除\n", encoding="utf-8")
    for path in (".trash/删掉的.md", ".CLAUDE-SESSION/会话.md", ".obsidian/plugin.md"):
        resp = await client.get(f"/grammar/docs/content?path={path}")
        assert resp.status_code == 400, path
        resp = await client.post("/grammar/docs/apply", json={"path": path, "content": "x"})
        assert resp.status_code == 400, path
    # 归档目录的大小写变体同样拒（依赖 casefold 比较，而不是文件系统碰巧找不到）
    resp = await client.get("/grammar/docs/content?path=_归档-旧版/99.旧稿.md")
    assert resp.status_code == 400
