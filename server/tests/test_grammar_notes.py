"""语法讲义的切分（`domain/grammar_notes`，模块 15）。

切分错了不会抛异常，只会让某个概念的正文少一截、或者整篇讲义静默消失——
学习路径里少一节，没人会去查为什么。所以这一层的错必须在单测里炸。
"""

from pathlib import Path

from app.routers.grammar_concepts import concept_rank
from domain.grammar_notes import (
    SKIP_DIRS,
    collect,
    slugify,
    split_document,
    strip_front_matter,
)

DOC = """---
title: 名词性从句详解
date: 2025-12-21
tags:
  - 英语语法
  - 从句
description: 全面讲解名词性从句
---

# 名词性从句详解

## 1. 名词性从句概述

### 1.1 什么是名词性从句

在复合句中起名词作用的从句。

## 2. 主语从句

放在句首充当主语。

### 2.1 that 引导

That he came surprised us.
"""


def _write(tmp_path: Path, rel: str, text: str) -> Path:
    p = tmp_path / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")
    return p


def test_front_matter_is_stripped_and_parsed():
    meta, body = strip_front_matter(DOC)
    assert meta["title"] == "名词性从句详解"
    assert meta["description"] == "全面讲解名词性从句"
    assert not body.startswith("---")
    # tags 是列表，本模块用不到，跳过而不是解析成半个字符串
    assert "tags" not in meta or meta["tags"] == ""


def test_no_front_matter_returns_text_unchanged():
    meta, body = strip_front_matter("# 标题\n\n正文")
    assert meta == {}
    assert body == "# 标题\n\n正文"


def test_split_by_h2_keeps_deeper_headings_in_body(tmp_path):
    path = _write(tmp_path, "09.从句体系/03.名词性从句详解.md", DOC)
    concepts, warnings = split_document(path, tmp_path)
    assert warnings == []
    assert [c.title for c in concepts] == ["1. 名词性从句概述", "2. 主语从句"]
    # 三级标题留在概念正文里，不再往下切
    assert "### 1.1 什么是名词性从句" in concepts[0].body_md
    assert "### 2.1 that 引导" in concepts[1].body_md
    assert concepts[0].chapter == "09.从句体系"
    assert concepts[0].doc_title == "名词性从句详解"


def test_body_is_preserved_verbatim(tmp_path):
    """BR-94：只切分不改字。正文里的每一行都要原样在。"""
    path = _write(tmp_path, "09.从句体系/03.名词性从句详解.md", DOC)
    concepts, _ = split_document(path, tmp_path)
    joined = "\n".join(c.body_md for c in concepts)
    for line in ("在复合句中起名词作用的从句。", "That he came surprised us."):
        assert line in joined


def test_document_without_h2_becomes_one_concept_with_warning(tmp_path):
    """整篇八千字没进库，表现是「少了一节」。必须告警，不能静默吞掉。"""
    path = _write(tmp_path, "13.附录/01.术语表.md", "# 术语表\n\n主语 subject\n宾语 object\n")
    concepts, warnings = split_document(path, tmp_path)
    assert len(concepts) == 1
    assert concepts[0].title == "术语表"
    assert "主语 subject" in concepts[0].body_md
    assert any("没有二级标题" in w for w in warnings)


def test_empty_section_is_skipped_with_warning(tmp_path):
    path = _write(tmp_path, "01.基础入门/01.x.md", "# X\n\n## 空的\n\n## 有内容\n\n正文\n")
    concepts, warnings = split_document(path, tmp_path)
    assert [c.title for c in concepts] == ["有内容"]
    assert any("正文为空" in w for w in warnings)


def test_slug_survives_renumbering():
    """Obsidian 侧调整编号是常事。slug 跟着变就等于概念换了身份、进度全丢。"""
    a = slugify("09.从句体系", "3.名词性从句详解", "1. 名词性从句概述")
    b = slugify("09.从句体系", "5.名词性从句详解", "4. 名词性从句概述")
    assert a == b


def test_slug_distinguishes_same_title_in_different_docs():
    a = slugify("09.从句体系", "定语从句基础", "1. 概述")
    b = slugify("09.从句体系", "状语从句详解", "1. 概述")
    assert a != b


def test_collect_skips_archive_and_outline(tmp_path):
    _write(tmp_path, "09.从句体系/03.x.md", DOC)
    _write(tmp_path, "_归档-旧版/03.旧.md", DOC)
    _write(tmp_path, "00.英语基础语法_大纲.md", DOC)
    concepts, _ = collect(tmp_path)
    assert "_归档-旧版" in SKIP_DIRS
    assert {c.source_path for c in concepts} == {"09.从句体系/03.x.md"}


def test_collect_reports_slug_collision(tmp_path):
    """撞车时后一条会覆盖前一条，必须显形而不是静默少一个概念。"""
    _write(tmp_path, "09.从句体系/03.a.md", DOC)
    _write(tmp_path, "09.从句体系/05.a.md", DOC)
    _, warnings = collect(tmp_path)
    assert any("slug 冲突" in w for w in warnings)


def test_content_hash_tracks_body_only(tmp_path):
    """重导靠 hash 判断有没有改：改了的概念要变，没改的不能变。

    没改的也变 → 每次重导都全表重写，白写库；
    改了的不变 → Obsidian 侧的修改永远进不来，界面一直显示旧正文。
    """
    path = _write(tmp_path, "09.从句体系/03.x.md", DOC)
    before = {c.title: c.content_hash for c in split_document(path, tmp_path)[0]}
    path.write_text(
        DOC.replace("放在句首充当主语。", "放在句首充当主语，也可后置。"), encoding="utf-8"
    )
    after = {c.title: c.content_hash for c in split_document(path, tmp_path)[0]}
    assert after["1. 名词性从句概述"] == before["1. 名词性从句概述"]
    assert after["2. 主语从句"] != before["2. 主语从句"]


# ─────────────── 句子解构指回概念的排序 ───────────────


def _c(title, layer="reference", n_keys=1, doc_title="某篇", chapter="09.从句体系"):
    return {
        "title": title,
        "doc_title": doc_title,
        "chapter": chapter,
        "layer": layer,
        "n_keys": n_keys,
    }


def test_summary_sections_rank_last():
    """「本章小结」顺带列举很多结构，指过去找不到那个结构在哪儿讲，等于没指。"""
    items = [_c("9. 本章小结"), _c("2. 现在完成时")]
    items.sort(key=concept_rank)
    assert items[0]["title"] == "2. 现在完成时"


def test_active_layer_ranks_before_reference():
    items = [_c("A", layer="reference"), _c("B", layer="active")]
    items.sort(key=concept_rank)
    assert items[0]["title"] == "B"


def test_more_specific_concept_ranks_first():
    """只挂一个构式的概念讲的就是这个结构；挂三个的多半是顺带提到。"""
    items = [_c("泛讲", n_keys=3), _c("专讲", n_keys=1)]
    items.sort(key=concept_rank)
    assert items[0]["title"] == "专讲"


def test_chapter_number_is_only_a_tiebreak():
    """首版拿章节号当第二判据，反义疑问句的句子因此指向了「12.日常口语」。

    章节号是编写顺序，与「哪一条更该看」无关，只能做最后的稳定排序。
    """
    items = [
        _c("顺带提到", n_keys=3, chapter="12.日常口语"),
        _c("构成规则", n_keys=1, chapter="16.反义疑问句"),
    ]
    items.sort(key=concept_rank)
    assert items[0]["title"] == "构成规则"
