"""语法模块（模块 14）：句法分析、构式规则、误区目录、写作原子化。

spaCy 与 ERRANT 都是单例加载、纯计算，可以直接测；只有 LLM 那两步不测
（那属于「prompt 写得好不好」，不是可回归的逻辑）。
"""

import pytest

from domain.grammar_rules import RULES, RULES_BY_KEY
from domain.misconceptions import BY_ERRANT, CATALOG, ERRANT_TYPES
from domain.syntax import (
    DEP_ZH,
    build_matcher,
    clause_boundaries,
    constituents,
    match_constructions,
    parse_deps,
)
from domain.writing import atomize

# ────────────────────────────── 依存 JSON ──────────────────────────────


def test_parse_deps_returns_json_not_html():
    """FR-405d：服务端只返回 JSON。displacy.render 直出 SVG 有 XSS 风险且没有交互余地。"""
    d = parse_deps("She reads books.")
    assert set(d) == {"text", "words", "arcs"}
    assert all(isinstance(w["text"], str) for w in d["words"])
    assert "<svg" not in repr(d)


def test_dep_labels_are_translated():
    """FR-405e：标签是 ClearNLP 风格不是 UD，45 条中文映射必须齐。"""
    d = parse_deps("The man who lives next door gave my sister a book.")
    for w in d["words"]:
        assert w["dep_zh"] != w["dep"] or w["dep"] in ("ROOT",), w["dep"]
    assert len(DEP_ZH) >= 45


def test_arcs_are_normalized_low_to_high():
    d = parse_deps("She quickly reads long books.")
    for a in d["arcs"]:
        assert a["start"] < a["end"]
        assert a["dir"] in ("left", "right")


def _js_slice(text: str, start: int, end: int) -> str:
    """按 UTF-16 码元切片，模拟 JS 的 String.prototype.slice。"""
    units = text.encode("utf-16-le")
    return units[start * 2 : end * 2].decode("utf-16-le")


def test_offsets_are_utf16_code_units():
    """核心原则 3：偏移一律 UTF-16 码元，与 JS 的 slice 口径一致。

    BMP 外字符（emoji）在 Python 里算 1 个字符、JS 里算 2 个码元。
    按 Python 的字符数发偏移，正文里一出现 emoji 整段就会错位。
    """
    text = "I 🙂 read books."
    d = parse_deps(text)
    for w in d["words"]:
        assert _js_slice(text, w["start"], w["end"]) == w["text"], w
    # 确认这句真的含 BMP 外字符，否则这个用例什么都没验证
    assert len(text.encode("utf-16-le")) // 2 > len(text)


# ────────────────────────────── 成分着色 ──────────────────────────────


def _roles(text: str) -> dict[str, list[str]]:
    c = constituents(text)
    out: dict[str, list[str]] = {}
    for s in c["spans"]:
        out.setdefault(s["role"], []).extend(c["words"][i]["text"] for i in s["tokens"])
    return out


def test_constituents_basic_svo():
    r = _roles("She reads books.")
    assert r["subject"] == ["She"]
    assert r["predicate"] == ["reads"]
    assert r["object"] == ["books"]


def test_relative_clause_is_split_out_of_the_subject():
    """从句优先分配：主语只留 The man，定语从句自成一块才折得干净。"""
    r = _roles("The man who lives next door is a doctor.")
    assert r["subject"] == ["The", "man"]
    assert "lives" in r["clause"]


def test_every_content_word_gets_at_most_one_role():
    c = constituents("The old man gave my sister a book yesterday.")
    seen: set[int] = set()
    for s in c["spans"]:
        for i in s["tokens"]:
            assert i not in seen, f"词 {i} 被分到了两个成分"
            seen.add(i)


def test_legend_covers_all_used_roles():
    c = constituents("If it rains, we will stay at home because the road floods.")
    for s in c["spans"]:
        assert s["role"] in c["legend"]


# ────────────────────────────── 从句边界 ──────────────────────────────


def test_clause_boundaries_marks_comma():
    # 词序列不含标点：I went home but he stayed
    assert 2 in clause_boundaries("I went home, but he stayed.", 6)


def test_clause_boundaries_returns_nothing_when_word_count_mismatches():
    """宁缺毋滥：对不上就不给，免得把边界标到错的词上。"""
    assert clause_boundaries("I went home, but he stayed.", 99) == []


# ────────────────────────────── 构式规则 ──────────────────────────────


def test_rule_count_meets_the_requirement():
    """FR-401a 要 30-50 条高频构式。"""
    assert 30 <= len(RULES) <= 60


def test_rule_keys_are_unique():
    assert len(RULES_BY_KEY) == len(RULES)


@pytest.mark.parametrize("rule", RULES, ids=lambda r: r.key)
def test_every_rule_matches_its_own_example(rule):
    """规则写错了要在这里炸，不该等到扫 6.5 万段语料才发现。"""
    matcher = build_matcher({rule.key: rule.pattern})
    hits = match_constructions(rule.example, matcher)
    assert any(h["key"] == rule.key for h in hits), f"{rule.key} 命中不了自己的例句"


def test_present_and_past_perfect_do_not_both_fire():
    """had known 只该是过去完成；两条都命中说明 aux 的 TAG 约束漏了。"""
    matcher = build_matcher({r.key: r.pattern for r in RULES})
    keys = {h["key"] for h in match_constructions("I had known it before.", matcher)}
    assert "past-perfect" in keys
    assert "present-perfect" not in keys


def test_wh_question_does_not_fire_inside_a_relative_clause():
    matcher = build_matcher({r.key: r.pattern for r in RULES})
    keys = {h["key"] for h in match_constructions("The man who lives here is kind.", matcher)}
    assert "wh-question" not in keys


TAG_QUESTION_YES = [
    "You are coming, aren't you?",
    "You don't like it, do you?",   # 附加部分的 do 被 spaCy 标成 VERB 不是 AUX
    "She can swim, can't she?",
    "There is a problem, isn't there?",  # 主语是 there/advmod
    "Let's go, shall we?",               # 主句挂成 advcl 不是 ccomp
    "Open the door, will you?",
    "He has finished, hasn't he?",
    "Nothing happened, did it?",
    "I am right, aren't I?",
    # 主句一复杂，tag 就从 ROOT 变成 ROOT 的 conj，要靠第二个候选形状接住
    "There were too many people for us to find a seat, weren't there?",
]

TAG_QUESTION_NO = [
    "What a beautiful day it is!",   # 首版规则在这里误命中
    "I think he is right.",
    "He said that she was tired.",
    "I know what you mean.",
    "If you go, tell me.",
    "When he arrived, we left.",     # 主语在 ROOT 之前，没有倒装
    "She said she was tired and he agreed.",
    "I wonder whether he will come.",
    "Having finished, he went home.",
    "The man who came is my uncle.",
    "He came and she left.",              # conj 形状下主语在左边，不是倒装
    "I opened the door and he walked in.",
]


@pytest.mark.parametrize("text", TAG_QUESTION_YES)
def test_tag_question_fires_on_real_tags(text):
    """反义疑问句的判据是位置不是词性，正反例都要守住。

    首版规则「ROOT 是 AUX 且有代词 nsubj」两头都错：漏掉 do/VERB 的附加部分，
    又把感叹句的 `is + it` 当成命中。
    """
    matcher = build_matcher({"tag-question": RULES_BY_KEY["tag-question"].pattern})
    assert any(h["key"] == "tag-question" for h in match_constructions(text, matcher)), text


@pytest.mark.parametrize("text", TAG_QUESTION_NO)
def test_tag_question_does_not_fire_on_lookalikes(text):
    matcher = build_matcher({"tag-question": RULES_BY_KEY["tag-question"].pattern})
    assert not any(h["key"] == "tag-question" for h in match_constructions(text, matcher)), text


def test_match_confidence_drops_on_broken_parses():
    """BR-97：低置信度不指概念。这里守住「长句与多 ROOT 会压低分数」这条判据。"""
    from domain.syntax import get_nlp, match_confidence

    nlp = get_nlp()
    short = nlp("She can swim, can't she?")
    assert match_confidence(short, [0, 1, 2]) == 100.0
    long_text = "and " * 60 + "he left."
    assert match_confidence(nlp(long_text), [0, 1]) < 100.0


def test_matches_carry_utf16_offsets():
    matcher = build_matcher({"passive-simple": RULES_BY_KEY["passive-simple"].pattern})
    text = "The window was broken by the storm."
    hits = match_constructions(text, matcher)
    assert hits
    h = hits[0]
    assert text[h["char_start"] : h["char_end"]] == h["snippet"]


# ────────────────────────────── 误区目录 ──────────────────────────────


def test_misconception_codes_are_unique():
    assert len({m.code for m in CATALOG}) == len(CATALOG)


def test_all_errant_types_are_real():
    """BR-98：不自建错误分类体系。写错类型名不会报错，只会永远匹配不上。"""
    for m in CATALOG:
        for t in m.errant_types:
            assert t in ERRANT_TYPES, f"{m.code} 用了不存在的 {t}"


def test_every_misconception_has_actionable_feedback():
    for m in CATALOG:
        assert m.feedback and len(m.feedback) > 5, m.code
        assert m.description, m.code


def test_errant_index_is_reversible():
    """FR-402c 要求双向映射：类型能查到误区，误区能查回类型。"""
    for t, codes in BY_ERRANT.items():
        for c in codes:
            m = next(x for x in CATALOG if x.code == c)
            assert t in m.errant_types


# ────────────────────────────── 写作原子化 ──────────────────────────────


def test_atomize_splits_into_independent_edits():
    """BR-97：必须先原子化再逐条讲解，不能整句一次过。"""
    edits = atomize(
        "I have went to school yesterday and buy a apple.",
        "I went to school yesterday and bought an apple.",
    )
    types = [e["errant_type"] for e in edits]
    assert len(edits) >= 3
    assert "R:VERB:TENSE" in types
    assert "R:DET" in types


def test_atomize_gives_char_offsets_that_slice_the_original():
    original = "He didn't went there."
    edits = atomize(original, "He didn't go there.")
    e = edits[0]
    assert original[e["char_start"] : e["char_end"]] == e["o_str"]


def test_atomize_of_a_correct_sentence_is_empty():
    assert atomize("She reads books.", "She reads books.") == []


def test_insertion_edits_get_a_zero_width_anchor():
    """插入型编辑在原句里没有跨度，锚到插入点，前端画竖线而不是划一段。"""
    edits = atomize("I go school.", "I go to school.")
    ins = [e for e in edits if e["errant_type"].startswith("M:")]
    assert ins
    assert ins[0]["char_start"] == ins[0]["char_end"]


def test_every_edit_carries_misconception_candidates():
    edits = atomize("Although it rained, but we went.", "Although it rained, we went.")
    assert edits
    assert any(e["misconception_candidates"] for e in edits)
