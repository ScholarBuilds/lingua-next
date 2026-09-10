"""全局查词（FR-507~510）：侧表构建 + 检索层 + 两个路由。

侧表由测试直接用 dict_search_build 的构建函数灌进内存库，不跑 seed 脚本、不碰 WordNet。
"""

import pytest
from sqlalchemy import insert, update
from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.schema import CreateTable

from domain import dict_search
from domain.dict_search_build import (
    EntryRow,
    build_related,
    classify_tier,
    gloss_rows,
    head_row,
    pos_weights,
)
from domain.models import DictEntry, DictGloss, DictHead, DictRelated, VocabEntry, WordPhoneme

ENTRIES = [
    # word, translation, frq, bnc, tag, collins, oxford, exchange, phonetic
    (
        "go",
        "vi. 去, 走, 离去, 放弃\nn. 尝试",
        35,
        40,
        "zk gk",
        5,
        1,
        "i:going/p:went/d:gone/3:goes/s:goes",
        "gәu",
    ),
    ("went", "go的过去式", 0, 0, "", 0, 0, "0:go/1:p", None),
    ("gone", "a. 过去的, 用完的\ngo的过去分词", 3000, 0, "", 0, 0, "0:go/1:d", None),
    ("goes", "go的第三人称单数", 0, 0, "", 0, 0, "0:go/1:3s", None),
    ("going", "n. 进行, 离去\ngo的现在分词", 800, 0, "", 0, 0, "0:go/1:i", None),
    (
        "abandon",
        "vt. 放弃, 抛弃, 遗弃\nn. 放任",
        2182,
        2000,
        "gk cet4 ky",
        4,
        1,
        "d:abandoned/p:abandoned/i:abandoning/3:abandons/s:abandons",
        "ә'bændәn",
    ),
    (
        "abandoned",
        "a. 被抛弃的\n( abandon的过去式和过去分词 )",
        6184,
        0,
        "toefl",
        0,
        0,
        "0:abandon/1:dp",
        None,
    ),
    ("abandoning", "放弃, 抛弃\nabandon的现在分词", 0, 0, "", 0, 0, "0:abandon/1:i", None),
    ("abandonment", "n. 放弃, 遗弃", 9000, 0, "toefl", 0, 0, None, None),
    ("desert", "vt. 放弃, 遗弃\nn. 沙漠", 3200, 0, "zk", 3, 1, None, None),
    ("keep", "vt. 保持, 保留\nvi. 保持", 300, 0, "zk", 5, 1, None, None),
    ("however", "ad. 然而, 无论如何", 500, 0, "zk", 5, 1, None, None),
    ("beautiful", "a. 美丽的, 漂亮的", 700, 0, "zk", 5, 1, None, None),
    ("China", "n. 中国", 0, 900, "", 0, 0, None, None),
    ("china", "n. 瓷器", 12000, 0, "cet4", 0, 0, None, None),
    ("give", "vt. 给, 授予", 100, 0, "zk", 5, 1, None, None),
    ("up", "ad. 向上", 90, 0, "zk", 5, 1, None, None),
    ("give up", "放弃, 认输", 0, 0, "", 0, 0, None, None),
    ("give ... a hand", "帮某人一把", 0, 0, "", 0, 0, None, None),
    ("give up the ghost", "[口] 死亡", 0, 0, "", 0, 0, None, None),
    ("abandonment of a patent application", "[法] 放弃专利申请", 0, 0, "", 0, 0, None, None),
    ("zymurgy", "n. 酿造学", 0, 0, "", 0, 0, None, None),
    ("gigantic", "a. 巨大的", 8000, 0, "cet6", 0, 0, None, None),
    ("renounce", "vt. 完全放弃, 宣布放弃", 15000, 0, "gre", 0, 0, None, None),
]


class FakeLemma:
    def __init__(self, name, antonyms=(), derived=()):
        self._name, self._ant, self._der = name, antonyms, derived

    def name(self):
        return self._name

    def antonyms(self):
        return [FakeLemma(a) for a in self._ant]

    def derivationally_related_forms(self):
        return [FakeLemma(d) for d in self._der]

    def pertainyms(self):
        return []


class FakeSynset:
    def __init__(self, lemmas, pos="v"):
        self._lemmas, self._pos = lemmas, pos

    def lemmas(self):
        return self._lemmas

    def pos(self):
        return self._pos


class FakeWordNet:
    """abandon：同义 desert / forsake（后者不在学习者层，要丢）、反义 keep、派生 abandonment。"""

    def synsets(self, key):
        if key == "abandon":
            # WordNet 把名词义排在动词义前面；按 ECDICT 词性占比重排后 desert 才该在 gigantic 前
            return [
                FakeSynset([FakeLemma("abandon"), FakeLemma("gigantic")], pos="n"),
                FakeSynset(
                    [
                        FakeLemma("abandon", antonyms=("keep",), derived=("abandonment",)),
                        FakeLemma("desert"),
                        FakeLemma("forsake"),
                    ]
                ),
                FakeSynset([FakeLemma("abandon"), FakeLemma("give_up")]),
            ]
        if key == "desert":
            return [FakeSynset([FakeLemma("desert"), FakeLemma("abandon")])]
        return []


def _rows() -> list[EntryRow]:
    return [EntryRow(*r) for r in ENTRIES]


async def seed_index(session, *, with_related=True):
    session.add_all(
        [
            DictEntry(
                word=r[0],
                translation=r[1],
                frq=r[2],
                bnc=r[3],
                tag=r[4],
                collins=r[5],
                oxford=r[6],
                exchange=r[7],
                phonetic=r[8],
            )
            for r in ENTRIES
        ]
    )
    session.add(WordPhoneme(word="abandon", ipa_uk="əˈbændən", ipa_us="əˈbændən"))
    common = {
        r.word.lower()
        for r in _rows()
        if " " not in r.word and ((r.frq or 0) > 0 or (r.tag or "").strip())
    }
    heads = [
        h for h in (head_row(r, common, {"abandon": "əˈbændən"}) for r in _rows()) if h is not None
    ]
    glosses = [
        g
        for r in _rows()
        for h in [head_row(r, common, {})]
        if h is not None
        for g in gloss_rows(h, r.translation)
    ]
    await session.execute(insert(DictHead), heads)
    await session.execute(insert(DictGloss), glosses)
    if with_related:
        tier1 = {h["lc"] for h in heads if h["tier"] == 1}
        related = build_related(tier1, FakeWordNet(), {"abandon": pos_weights("v:69/n:31")})
        if related:
            await session.execute(insert(DictRelated), related)
    await session.commit()
    dict_search.reset_fuzzy_cache()
    return heads


@pytest.fixture(autouse=True)
def _reset_cache():
    dict_search.reset_fuzzy_cache()
    yield
    dict_search.reset_fuzzy_cache()


def test_classify_tier():
    by_word = {r.word: r for r in _rows()}
    common = {"give", "up", "abandon"}
    assert classify_tier(by_word["abandon"], common) == 1
    assert classify_tier(by_word["went"], common) == 3
    assert classify_tier(by_word["give up"], common) == 2
    assert classify_tier(by_word["give ... a hand"], common) is None
    assert classify_tier(by_word["give up the ghost"], common) is None  # 域标签
    assert classify_tier(by_word["abandonment of a patent application"], common) is None


def test_head_row_fields():
    row = next(r for r in _rows() if r.word == "abandoned")
    head = head_row(row, set(), {})
    assert head["lemma"] == "abandon" and head["tier"] == 1 and head["brief"] == "被抛弃的"
    assert head["frq_rank"] == 6184 and head["proper"] is False
    china = head_row(next(r for r in _rows() if r.word == "China"), set(), {})
    assert china["proper"] is True and china["frq_rank"] == 900
    # 变形行不进反查
    assert gloss_rows(head, row.translation) == []


async def test_not_ready_without_index(client):
    body = (await client.get("/dict/search", params={"q": "go"})).json()
    assert body["ready"] is False and "seed_dict_search" in body["hint"]
    body = (await client.get("/dict/suggest", params={"q": "go"})).json()
    assert body["ready"] is False and body["items"] == []


async def test_exact_forms_and_lemma(client, session):
    await seed_index(session)
    body = (await client.get("/dict/search", params={"q": "go"})).json()
    assert body["ready"] is True and body["kind"] == "en"
    assert body["exact"][0]["word"] == "go" and body["exact"][0]["phonetic"] == "gәu"
    forms = body["forms"][0]
    assert forms["lemma"] == "go"
    assert [f["word"] for f in forms["forms"]] == ["went", "gone", "going", "goes"]
    assert forms["forms"][-1]["label"] == "第三人称单数 / 复数"
    assert forms["forms"][0]["brief"] == "go的过去式"

    body = (await client.get("/dict/search", params={"q": "Went"})).json()
    assert body["exact"][0]["lemma"] == "go"
    assert body["lemmas"][0]["word"] == "go"
    assert body["forms"][0]["lemma"] == "go"
    assert body["source"]["dict"] == "ECDICT"


async def test_prefix_phrases_and_noise_filtered(client, session):
    await seed_index(session)
    body = (await client.get("/dict/search", params={"q": "aband"})).json()
    words = [m["word"] for m in body["matches"]]
    assert words[:2] == ["abandon", "abandoned"]  # 按词频，abandoning 没词频排最后
    assert "abandoning" in words and "abandon" not in [p["word"] for p in body["phrases"]]
    body = (await client.get("/dict/search", params={"q": "give"})).json()
    phrases = [p["word"] for p in body["phrases"]]
    assert phrases == ["give up"]


async def test_reverse_lookup_three_levels(client, session, monkeypatch):
    await seed_index(session)
    body = (await client.get("/dict/search", params={"q": "放弃"})).json()
    assert body["kind"] == "zh"
    words = [r["word"] for r in body["reverse"]]
    # abandon 第一义是放弃、go 是第四义：义项序压过词频
    assert words.index("abandon") < words.index("go")
    assert "abandoning" not in words and "give up" in words
    assert body["reverse"][0]["gloss"] == "放弃" and body["reverse"][0]["match"] == "exact"

    body = (await client.get("/dict/search", params={"q": "美丽"})).json()
    assert body["reverse"][0]["word"] == "beautiful"
    body = (await client.get("/dict/search", params={"q": "然"})).json()
    assert [r["word"] for r in body["reverse"]] == ["however"]
    assert body["reverse"][0]["match"] == "prefix"
    body = (await client.get("/dict/search", params={"q": "弃"})).json()
    assert "abandon" in [r["word"] for r in body["reverse"]]
    assert next(r for r in body["reverse"] if r["word"] == "abandon")["match"] == "contains"
    body = (await client.get("/dict/search", params={"q": "抛弃"})).json()
    assert [r["match"] for r in body["reverse"]][0] == "exact"
    # 精确档再多也留给前缀 / 子串各一份配额（renounce 的「完全放弃」只在子串档）
    monkeypatch.setattr(dict_search, "REVERSE_LIMIT", 1)
    body = (await client.get("/dict/search", params={"q": "放弃", "limit": 1})).json()
    levels = [r["match"] for r in body["reverse"]]
    assert levels.count("exact") == 1 and "contains" in levels
    assert any(r["word"] == "renounce" for r in body["reverse"])


async def test_reverse_prioritizes_common_words_before_secondary_tier(client, session):
    await seed_index(session)
    await session.execute(update(DictGloss).where(DictGloss.word == "abandon").values(tier=2))
    await session.commit()
    body = (await client.get("/dict/search", params={"q": "放弃"})).json()
    exact = [row["word"] for row in body["reverse"] if row["match"] == "exact"]
    assert exact.index("go") < exact.index("abandon")
    words = [row["word"] for row in body["reverse"]]
    assert len(words) == len(set(words))


async def test_related_only_within_learner_tier(client, session):
    await seed_index(session)
    body = (await client.get("/dict/search", params={"q": "abandon"})).json()
    related = body["related"]
    # forsake / give up 不在学习者层；名词义的 gigantic 按词性占比排到动词义之后
    assert [r["word"] for r in related["syn"]] == ["desert", "gigantic"]
    assert [r["word"] for r in related["ant"]] == ["keep"]
    assert [r["word"] for r in related["deriv"]] == ["abandonment"]
    assert related["syn"][0]["brief"] == "放弃"
    assert body["source"]["related"] is None  # 元数据没写 wordnet 时不冒充来源


async def test_spelling_suggestions_and_empty(client, session):
    await seed_index(session)
    body = (await client.get("/dict/search", params={"q": "abandan"})).json()
    assert body["exact"] == [] and body["matches"] == []
    assert body["suggestions"][0]["word"] == "abandon"
    assert body["suggestions"][0]["match"] == "fuzzy"
    body = (await client.get("/dict/search", params={"q": "zzzzqq"})).json()
    assert body["suggestions"] == []
    body = (await client.get("/dict/search", params={"q": "abandons"})).json()
    assert body["suggestions"][0]["match"] == "lemma_guess"
    assert body["suggestions"][0]["word"] == "abandon"


async def test_stage_attached(client, session):
    await seed_index(session)
    session.add(VocabEntry(user_id="owner", word="abandon", exposures=1))
    session.add(VocabEntry(user_id="owner", word="desert", exposures=0, mark="mastered"))
    await session.commit()
    body = (await client.get("/dict/search", params={"q": "abandon"})).json()
    assert body["exact"][0]["stage"] == "learning" and body["exact"][0]["in_vocab"] is True
    assert body["related"]["syn"][0]["stage"] == "mastered"
    assert body["related"]["ant"][0]["stage"] == "unseen"


async def test_glob_and_proper_ordering(client, session):
    await seed_index(session)
    body = (await client.get("/dict/search", params={"q": "ab*don"})).json()
    assert body["kind"] == "glob" and [m["word"] for m in body["matches"]] == ["abandon"]
    body = (await client.get("/dict/search", params={"q": "*ndon"})).json()
    assert [m["word"] for m in body["matches"]] == ["abandon"]
    body = (await client.get("/dict/search", params={"q": "china"})).json()
    assert [e["word"] for e in body["exact"]] == ["china", "China"]


async def test_suggest_flat_list(client, session):
    await seed_index(session)
    body = (await client.get("/dict/suggest", params={"q": "aban", "limit": 3})).json()
    assert body["ready"] is True and [i["word"] for i in body["items"]] == [
        "abandon",
        "abandoned",
        "abandonment",
    ]
    assert body["items"][0]["brief"] == "放弃" and "gk" in body["items"][0]["tags"]
    body = (await client.get("/dict/suggest", params={"q": "放弃"})).json()
    assert body["items"][0]["word"] == "abandon"
    body = (await client.get("/dict/suggest", params={"q": "abandan"})).json()
    assert body["items"][0]["match"] == "fuzzy"
    # 三层精确词不压常用词：aband 排到 abandon 后面；生僻前缀撞上也照给拼写建议
    session.add(DictEntry(word="aband", translation="壹个组合"))
    await session.execute(
        insert(DictHead),
        [{"word": "aband", "lc": "aband", "tier": 3, "brief": "壹个组合", "proper": False}],
    )
    await session.commit()
    body = (await client.get("/dict/suggest", params={"q": "aband", "limit": 8})).json()
    words = [i["word"] for i in body["items"]]
    assert words[0] == "abandon" and words[-1] == "aband"
    await session.execute(
        insert(DictHead),
        [{"word": "abandannaad", "lc": "abandannaad", "tier": 3, "proper": False}],
    )
    await session.commit()
    body = (await client.get("/dict/search", params={"q": "abandan"})).json()
    assert [m["word"] for m in body["matches"]] == ["abandannaad"]
    assert body["suggestions"][0]["word"] == "abandon"
    assert (await client.get("/dict/suggest", params={"q": "   "})).status_code == 400
    assert (await client.get("/dict/search", params={"q": "x" * 65})).status_code in (400, 422)


def test_dialect_guards():
    pg = str(dict_search.prefix_stmt("ab").compile(dialect=postgresql.dialect()))
    assert ">=" in pg and "<" in pg and "LIKE" not in pg and "lower(" not in pg
    assert "NULLS LAST" in pg
    assert 'COLLATE "C"' in str(
        CreateTable(DictHead.__table__).compile(dialect=postgresql.dialect())
    )
    lite = str(dict_search.prefix_stmt("ab").compile(dialect=sqlite.dialect()))
    assert "NULLS LAST" in lite and "COLLATE" not in str(
        CreateTable(DictHead.__table__).compile(dialect=sqlite.dialect())
    )
    assert dict_search.prefix_where(DictHead.lc, "give ")[1].right.value == "give!"


def test_pos_weights():
    assert pos_weights("v:69/n:31") == {"v": 69, "n": 31}
    assert pos_weights("j:99/s:1") == {"a": 100}
    assert pos_weights(None) == {} and pos_weights("x:5/n:abc") == {}


def test_glob_pattern_escapes_user_wildcards():
    assert dict_search.glob_pattern("ab*don") == ("ab%don", "ab")
    assert dict_search.glob_pattern("a_b?") == ("a\\_b_", "a_b")
    assert dict_search.normalize("  Ａbandon ") == "Abandon"
    assert dict_search.classify("放弃") == "zh" and dict_search.classify("ab*") == "glob"
