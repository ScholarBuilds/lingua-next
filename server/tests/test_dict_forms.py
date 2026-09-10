"""exchange 词形解析（FR-508）：两个方向都要能走。"""

import pytest

from domain import decks
from domain.dict_forms import forms_of, lemma_guesses, lemma_of, parse_exchange


@pytest.mark.parametrize(
    ("exchange", "expected"),
    [
        (
            "p:was/3:is/d:been/i:being/s:bes",
            {"p": "was", "3": "is", "d": "been", "i": "being", "s": "bes"},
        ),
        ("", {}),
        (None, {}),
        (":x/p:", {}),  # 键或值为空的段跳过
        ("p:a/p:b", {"p": "b"}),  # 同键后者覆盖
    ],
)
def test_parse_exchange(exchange, expected):
    assert parse_exchange(exchange) == expected


def test_forms_of_keeps_fixed_order_and_merges_same_spelling():
    forms = forms_of("go", "i:going/p:went/d:gone/3:goes/s:goes")
    assert [f["word"] for f in forms] == ["went", "gone", "going", "goes"]
    assert [f["code"] for f in forms] == ["p", "d", "i", "3"]
    assert forms[-1]["codes"] == ["3", "s"]
    assert forms[-1]["label"] == "第三人称单数 / 复数"
    assert forms[0]["label"] == "过去式"


def test_forms_of_skips_self_and_lemma_segments():
    # 原形与自己相同的段不算形态，0:/1: 不是形态
    assert forms_of("run", "p:ran/i:running/d:run/3:runs/s:runs/0:run/1:p") == [
        {"code": "p", "codes": ["p"], "label": "过去式", "word": "ran"},
        {"code": "i", "codes": ["i"], "label": "现在分词", "word": "running"},
        {"code": "3", "codes": ["3", "s"], "label": "第三人称单数 / 复数", "word": "runs"},
    ]
    assert forms_of("apple", None) == []


def test_lemma_of_still_reachable_through_decks():
    assert decks.lemma_of is lemma_of
    assert lemma_of("0:go/1:p", "went") == "go"
    assert lemma_of("0:apple/s:apples", "apple") is None


def test_lemma_guesses():
    assert "study" in lemma_guesses("studies")
    assert lemma_guesses("abandoned") == ["abandon", "abandone"]
    assert lemma_guesses("bus") == []  # 太短不回退
