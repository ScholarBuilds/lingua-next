"""练习引擎的判分（[组件：练习引擎]）。

这一层唯一的硬约束是**判分是纯函数**，所以它整个可以脱离数据库与浏览器测。
这份用例就是那条约束的兑现：同样的 (题目, 作答) 永远给同样的结果。
"""

import pytest

from domain import exercise
from domain.exercise import QuestionError, ScoreResult, norm_text, score, validate, widgets

# ────────────────────────────── 校验 ──────────────────────────────


def test_unknown_widget_is_rejected_at_authoring_time():
    """题型写错要在出题期炸，不能等用户点下去才发现。"""
    with pytest.raises(QuestionError, match="未知题型"):
        validate({"widget": "does-not-exist"})


def test_missing_required_field_is_rejected():
    with pytest.raises(QuestionError, match="缺字段"):
        validate({"widget": "minimal-pair", "choices": ["a", "b"]})


def test_misconception_without_feedback_is_rejected():
    """误区必须带定向反馈，否则命中了也说不出话。"""
    with pytest.raises(QuestionError, match="误区条目"):
        validate(
            {
                "widget": "phoneme-decode",
                "choices": ["a", "b"],
                "answer": 0,
                "misconceptions": [{"id": "x"}],
            }
        )


def test_every_registered_widget_declares_schedulability():
    """BR-94 / FR-406b：能否进 FSRS 是题型的固有属性，不能漏声明。"""
    reg = widgets()
    assert reg, "注册表不该为空"
    for name, spec in reg.items():
        assert isinstance(spec["schedulable"], bool), name
        assert spec["zh"], name


def test_speech_and_production_never_enter_srs():
    """跟读与产出型走各自的链路，塞进 SRS 就违反 BR-94。"""
    for w in ("speech-recording", "production", "affective-input", "pronunciation-timeline"):
        assert exercise.is_schedulable(w) is False, w


# ────────────────────────────── 单选 ──────────────────────────────

PAIR = {
    "id": "mp-1",
    "widget": "minimal-pair",
    "choices": ["ship", "sheep"],
    "answer": 0,
    "audio": {"text": "ship"},
    "misconceptions": [
        {"id": "confuse-iy-ih", "match": "equals", "value": "1", "feedback": "长短音混了"}
    ],
}


def test_correct_choice():
    r = score(PAIR, 0)
    assert r.correct and r.score == 1.0 and r.misconception is None


def test_wrong_choice_hits_the_bound_misconception():
    r = score(PAIR, 1)
    assert not r.correct
    assert r.misconception == "confuse-iy-ih"
    assert r.feedback == "长短音混了"


def test_empty_answer_is_wrong_not_crash():
    r = score(PAIR, None)
    assert not r.correct and r.detail["reason"] == "empty"


def test_choice_accepts_dict_response():
    """前端可能包一层 {choice: n}，两种形状都要收。"""
    assert score(PAIR, {"choice": 0}).correct


def test_scoring_is_pure():
    """同样输入必须永远同样输出——这是整层设计的立足点。"""
    a = score(PAIR, 1).to_dict()
    b = score(PAIR, 1).to_dict()
    assert a == b


# ────────────────────────────── 文本 ──────────────────────────────

TRANSFORM = {
    "id": "t-1",
    "widget": "sentence-transform",
    "prompt": "改成否定句：He went there.",
    "answer": ["He didn't go there.", "He did not go there."],
}


@pytest.mark.parametrize(
    "given",
    [
        "He didn't go there.",
        "  He did not go there  ",
        "He didn’t go there",  # 弯撇号
    ],
)
def test_transform_accepts_equivalent_writings(given: str):
    assert score(TRANSFORM, {"text": given}).correct
    assert "apostrophe" not in score(TRANSFORM, {"text": given}).detail


def test_transform_flags_missing_apostrophe_but_still_passes():
    """漏撇号是拼写不是语法：判对，但标出来让前端提一句。"""
    r = score(TRANSFORM, {"text": "he didnt go there"})
    assert r.correct
    assert r.detail["apostrophe"] is True


def test_transform_rejects_a_real_miss():
    r = score(TRANSFORM, {"text": "He didn't went there."})
    assert not r.correct
    assert r.detail["expected"] == TRANSFORM["answer"]


def test_norm_text_strips_only_trailing_punctuation():
    assert norm_text("  Hello, World!  ") == "hello, world"


# ────────────────────────────── 排序 ──────────────────────────────

ORDER = {
    "id": "o-1",
    "widget": "word-order",
    "tokens": ["there", "He", "go", "didn't"],
    "answer": ["He", "didn't", "go", "there"],
}


def test_word_order_all_correct():
    assert score(ORDER, {"order": ORDER["answer"]}).correct


def test_word_order_gives_partial_credit():
    """排序题按位置正确率给连续分：全错与差一位不该同分。"""
    r = score(ORDER, {"order": ["He", "didn't", "there", "go"]})
    assert not r.correct
    assert r.score == pytest.approx(0.5)
    assert r.detail == {"hits": 2, "of": 4}


def test_word_order_completely_wrong():
    r = score(ORDER, {"order": ["there", "go", "didn't", "He"]})
    assert r.score == 0.0


# ────────────────────────────── 找错改正 ──────────────────────────────

CORRECTION = {
    "id": "c-1",
    "widget": "error-correction",
    "sentence": "He don't like it.",
    "span": [1, 2],
    "answer": ["He doesn't like it."],
}


def test_correction_full_credit():
    assert score(CORRECTION, {"text": "He doesn't like it."}).correct


def test_correction_half_credit_for_right_span_wrong_fix():
    """圈对了错处但没改对：给半分，留下继续练的抓手。"""
    r = score(CORRECTION, {"text": "He not like it.", "span": [1, 2]})
    assert not r.correct
    assert r.score == 0.5
    assert r.detail["span_ok"] is True


def test_correction_no_credit_for_wrong_span():
    r = score(CORRECTION, {"text": "He not like it.", "span": [0, 1]})
    assert r.score == 0.0


# ────────────────────────────── 误区匹配 ──────────────────────────────


def test_misconception_regex_match():
    q = {
        "id": "r-1",
        "widget": "sentence-transform",
        "prompt": "改否定",
        "answer": ["He didn't go."],
        "misconceptions": [
            {
                "id": "aux-then-past",
                "match": "regex",
                "value": r"did(n't| not) went",
                "feedback": "时态由 did 承担",
            }
        ],
    }
    r = score(q, {"text": "He didn't went."})
    assert r.misconception == "aux-then-past"


def test_misconception_contains_match():
    q = {
        "id": "r-2",
        "widget": "sentence-transform",
        "prompt": "x",
        "answer": ["ok"],
        "misconceptions": [
            {"id": "although-but", "match": "contains", "value": "but", "feedback": "二选一"}
        ],
    }
    assert score(q, {"text": "Although rain, but we went"}).misconception == "although-but"


def test_no_misconception_falls_through_to_llm():
    """没命中预设误区时留空，交给 LLM 兜底——这是 FR-402b 的分工。"""
    q = {**TRANSFORM, "misconceptions": [{"id": "x", "value": "zzz", "feedback": "f"}]}
    r = score(q, {"text": "Totally unrelated"})
    assert r.misconception is None


# ────────────────────────────── 延后判分 ──────────────────────────────


def test_production_defers_scoring():
    """产出型不在这里判分，交给 ERRANT 两段式（BR-97）。"""
    r = score({"id": "p", "widget": "production", "prompt": "翻译"}, {"text": "I went"})
    assert r.detail["deferred"] is True


def test_production_empty_is_not_submitted():
    r = score({"id": "p", "widget": "production", "prompt": "翻译"}, {"text": "   "})
    assert not r.correct


def test_result_serializes():
    assert set(ScoreResult(True, 1.0).to_dict()) == {
        "correct",
        "score",
        "misconception",
        "feedback",
        "detail",
    }


def test_wrong_choice_reveals_the_answer():
    """答错后不告诉学习者对的是哪个，这道题就白做了。"""
    r = score(PAIR, 1)
    assert r.detail["answer"] == 0


def test_locate_reveals_nothing_extra_when_right():
    q = {
        "id": "l-1",
        "widget": "locate",
        "occurrences": [{"id": 1, "text": "a"}, {"id": 2, "text": "b"}],
        "answer": "1",
    }
    assert score(q, "1").detail == {}
