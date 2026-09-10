"""跟读点评的评分解析与 prompt 契约（FR-342/343）。"""

import json

from app.routers.shadowing import SCORE_RE
from domain.llm import shadow_review_prompt


def test_score_marker_parsed_and_stripped() -> None:
    text = "[[SCORE: 87]]\n整体不错，但 confident 的重音落错了。"
    m = SCORE_RE.search(text)
    assert m is not None
    assert int(m.group(1)) == 87
    body = SCORE_RE.sub("", text, count=1).lstrip()
    assert body.startswith("整体不错")
    assert "[[SCORE" not in body


def test_score_absent_is_tolerated() -> None:
    assert SCORE_RE.search("模型这次没给评分，直接开始讲。") is None


def test_review_prompt_only_sends_problem_words() -> None:
    items = [
        {"word": "be", "got": "be", "status": "ok"},
        {"word": "confident", "got": "confidence", "status": "wrong"},
        {"word": "more", "got": None, "status": "missing"},
    ]
    _system, user = shadow_review_prompt("Be more confident.", "be confidence", items, 33)
    payload = json.loads(user)
    words = payload["有问题的词"]
    # 读对的词不占 prompt 篇幅，只把要改的送过去
    assert [w["原句词"] for w in words] == ["confident", "more"]
    assert payload["逐词比对准确率"] == 33


def test_review_prompt_demands_actionable_advice() -> None:
    system, _user = shadow_review_prompt("Be more confident.", "be confident", [], 90)
    # BR-75：只给分数或只说"不错"的输出视为不合格
    assert "禁止空泛夸奖" in system
    assert "[[SCORE:" in system
