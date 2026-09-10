"""练习引擎：题目 Schema + 判分纯函数（[组件：练习引擎]）。

拆分方式抄 Khan/perseus 的包划分——`perseus-core` 管 Schema、`perseus-score`
把**评分与渲染分离**、Widget Registry 管扩展。要的是这个拆分，不是那个 npm 包
（它带着 KaTeX 与数学键盘，我们只要几种朴素题型）。

这一层唯一的硬约束：**`score()` 是纯函数**，不碰 DOM、不碰数据库、不调 LLM。
只有这样音标听辨与语法句型转换的判分才能脱离浏览器做回归测试。

误区模型抄 oppia：答错不是「不等于正确答案」，而是**命中某个可命名的误区**，
误区有限、可枚举、可统计（FR-402）。没命中任何预设误区才降级到 LLM 自由讲解。
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from typing import Any

SCHEMA_VERSION = 1


class QuestionError(ValueError):
    """题目 JSON 不合法。出题侧的问题，不是作答侧的。"""


@dataclass(frozen=True)
class ScoreResult:
    correct: bool
    # 0-1 的连续得分：多数题型非 0 即 1，排序题按位置正确率给分
    score: float
    # 命中的误区 code，未命中为空
    misconception: str | None = None
    feedback: str | None = None
    # 判分依据，用于 UI 高亮（如排序题哪几位错了）
    detail: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


# ──────────────────────────── 归一化 ────────────────────────────


def norm_text(s: str) -> str:
    """文本作答归一：NFKC、小写、压空白、去首尾标点。

    大小写与结尾句号不该判错——那不是这些题型在考的东西。
    """
    s = unicodedata.normalize("NFKC", s or "").strip().lower()
    s = s.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    s = re.sub(r"\s+", " ", s)
    return s.strip(" .!?,;:")


def norm_words(s: str) -> list[str]:
    return [w for w in re.split(r"[^a-z0-9']+", norm_text(s)) if w]


def loose_text(s: str) -> str:
    """再宽一档：连撇号也去掉。

    句型转换题考的是**语法形式**（didn't go 而不是 didn't went），
    撇号漏打属于拼写，由写作纠错的 `contraction` 误区管。
    但也不能装作没看见——命中这一档时会在 detail 里标出来，前端提一句。
    """
    return norm_text(s).replace("'", "")


# ──────────────────────────── Widget 注册 ────────────────────────────

Scorer = Callable[[dict, Any], ScoreResult]
_REGISTRY: dict[str, dict] = {}


def register(
    name: str,
    *,
    required: tuple[str, ...],
    schedulable: bool,
    zh: str,
) -> Callable[[Scorer], Scorer]:
    """注册一种题型。`schedulable=False` 的题不进 FSRS（BR-94、FR-406b）。"""

    def deco(fn: Scorer) -> Scorer:
        _REGISTRY[name] = {
            "score": fn,
            "required": required,
            "schedulable": schedulable,
            "zh": zh,
        }
        return fn

    return deco


def widgets() -> dict[str, dict]:
    """题型清单（去掉不可序列化的判分函数），供前端与文档核对。"""
    return {
        k: {"required": list(v["required"]), "schedulable": v["schedulable"], "zh": v["zh"]}
        for k, v in _REGISTRY.items()
    }


def validate(question: dict) -> None:
    """出题期校验：字段缺失在这里报，不要留到用户点下去才炸。"""
    widget = question.get("widget")
    spec = _REGISTRY.get(widget)
    if spec is None:
        raise QuestionError(f"未知题型 {widget!r}，已注册：{sorted(_REGISTRY)}")
    missing = [f for f in spec["required"] if question.get(f) in (None, "", [], {})]
    if missing:
        raise QuestionError(f"{widget} 缺字段 {missing}")
    for m in question.get("misconceptions") or []:
        if not m.get("id") or not m.get("feedback"):
            raise QuestionError(f"{widget} 的误区条目缺 id 或 feedback：{m}")


def is_schedulable(widget: str) -> bool:
    spec = _REGISTRY.get(widget)
    return bool(spec and spec["schedulable"])


def score(question: dict, response: Any) -> ScoreResult:
    """判分入口。纯函数：同样的 (题目, 作答) 永远给同样的结果。"""
    validate(question)
    return _REGISTRY[question["widget"]]["score"](question, response)


# ──────────────────────────── 误区匹配 ────────────────────────────


def match_misconception(question: dict, response: Any) -> dict | None:
    """按题目预绑的误区规则匹配作答（FR-402b）。

    三种 `match` 形式，都在这里判完，不外泄给调用方：

    | match | 含义 |
    | --- | --- |
    | `equals` | 作答归一后与 `value` 相同 |
    | `contains` | 归一后的作答包含 `value` |
    | `regex` | 对归一后的作答做正则搜索 |
    """
    text = norm_text(response if isinstance(response, str) else str(response))
    for m in question.get("misconceptions") or []:
        kind = m.get("match", "equals")
        value = norm_text(str(m.get("value", "")))
        if not value:
            continue
        hit = (
            (kind == "equals" and text == value)
            or (kind == "contains" and value in text)
            or (kind == "regex" and re.search(m["value"], text, re.I) is not None)
        )
        if hit:
            return m
    return None


def _wrong(question: dict, response: Any, *, detail: dict | None = None) -> ScoreResult:
    """统一的答错出口：先查预设误区，没命中才留空给 LLM 兜底。"""
    m = match_misconception(question, response)
    return ScoreResult(
        correct=False,
        score=0.0,
        misconception=m["id"] if m else None,
        feedback=(m or {}).get("feedback") or question.get("wrong_feedback"),
        detail=detail or {},
    )


def _right(question: dict, *, score_value: float = 1.0, detail: dict | None = None) -> ScoreResult:
    return ScoreResult(
        correct=True,
        score=score_value,
        feedback=question.get("right_feedback"),
        detail=detail or {},
    )


# ──────────────────────────── 选择型题 ────────────────────────────


def _score_choice(question: dict, response: Any) -> ScoreResult:
    """单选通用判分：`answer` 是 `choices` 里的下标或 id。"""
    answer = question["answer"]
    picked = response.get("choice") if isinstance(response, dict) else response
    if picked is None:
        return _wrong(question, "", detail={"reason": "empty"})
    if str(picked) == str(answer):
        return _right(question)
    # 误区可以绑在具体错选项上：value 写选项 id。
    # detail 带上正确答案：答错后不告诉学习者对的是哪个，这道题就白做了
    return _wrong(question, picked, detail={"picked": picked, "answer": answer})


register(
    "minimal-pair",
    required=("choices", "answer", "audio"),
    schedulable=True,
    zh="最小对立对听辨",
)(_score_choice)

register(
    "audio-choice",
    required=("choices", "answer", "audio"),
    schedulable=True,
    zh="听音选音标",
)(_score_choice)

register(
    "phoneme-decode",
    required=("choices", "answer"),
    schedulable=True,
    zh="看音标选词 / 看词选音标",
)(_score_choice)

register(
    "referential-input",
    required=("choices", "answer"),
    schedulable=True,
    zh="指称型结构化输入",
)(_score_choice)


@register(
    "affective-input",
    required=("statements",),
    schedulable=False,
    zh="情感型结构化输入",
)
def _score_affective(question: dict, response: Any) -> ScoreResult:
    """无对错，勾了就算完成。不计分、不进 SRS（FR-404 第 2 类）。"""
    picked = response.get("picked") if isinstance(response, dict) else response
    n = len(picked or [])
    return ScoreResult(correct=True, score=1.0, detail={"picked": n})


@register(
    "locate",
    required=("occurrences", "answer"),
    schedulable=True,
    zh="语料定位题",
)
def _score_locate(question: dict, response: Any) -> ScoreResult:
    """在自己读过的语料里找出该结构：判定选中的句子是否在正确出处集合里。"""
    picked = response.get("choice") if isinstance(response, dict) else response
    answers = question["answer"]
    ok = str(picked) in {str(a) for a in (answers if isinstance(answers, list) else [answers])}
    return _right(question) if ok else _wrong(question, picked, detail={"picked": picked})


# ──────────────────────────── 文本型题 ────────────────────────────


@register(
    "sentence-transform",
    required=("prompt", "answer"),
    schedulable=True,
    zh="句型转换",
)
def _score_transform(question: dict, response: Any) -> ScoreResult:
    """答案可以给多个可接受写法；比对走 `norm_text`，不因大小写与句号判错。"""
    text = response.get("text") if isinstance(response, dict) else response
    accepted = question["answer"]
    accepted = accepted if isinstance(accepted, list) else [accepted]
    got = norm_text(str(text or ""))
    if any(got == norm_text(a) for a in accepted):
        return _right(question)
    # 只差撇号：语法形式对了，算对但标出来
    loose = loose_text(str(text or ""))
    if any(loose == loose_text(a) for a in accepted):
        return _right(question, detail={"apostrophe": True})
    return _wrong(question, text, detail={"expected": accepted})


@register(
    "error-correction",
    required=("sentence", "answer"),
    schedulable=True,
    zh="找错并改正",
)
def _score_correction(question: dict, response: Any) -> ScoreResult:
    """两段判定：改对了句子才算全对；只圈对了错处给半分。"""
    text = response.get("text") if isinstance(response, dict) else response
    span = (response or {}).get("span") if isinstance(response, dict) else None
    accepted = question["answer"]
    accepted = accepted if isinstance(accepted, list) else [accepted]
    if any(norm_text(str(text or "")) == norm_text(a) for a in accepted):
        return _right(question)
    if any(loose_text(str(text or "")) == loose_text(a) for a in accepted):
        return _right(question, detail={"apostrophe": True})
    want_span = question.get("span")
    if want_span and span and list(span) == list(want_span):
        r = _wrong(question, text, detail={"span_ok": True})
        return ScoreResult(False, 0.5, r.misconception, r.feedback, r.detail)
    return _wrong(question, text, detail={"span_ok": False})


@register(
    "word-order",
    required=("tokens", "answer"),
    schedulable=True,
    zh="词块排序",
)
def _score_word_order(question: dict, response: Any) -> ScoreResult:
    """按位置正确率给连续分：全对才算 correct，部分对留下继续练的抓手。"""
    order = response.get("order") if isinstance(response, dict) else response
    answer = list(question["answer"])
    got = list(order or [])
    if got == answer:
        return _right(question)
    hits = sum(1 for i, v in enumerate(got[: len(answer)]) if v == answer[i])
    ratio = hits / len(answer) if answer else 0.0
    r = _wrong(question, " ".join(str(x) for x in got), detail={"hits": hits, "of": len(answer)})
    return ScoreResult(False, round(ratio, 3), r.misconception, r.feedback, r.detail)


@register(
    "production",
    required=("prompt",),
    schedulable=False,
    zh="产出型（走两段式纠错）",
)
def _score_production(question: dict, response: Any) -> ScoreResult:
    """产出型不在这里判分——交给 §4 的 ERRANT 两段式纠错链路（BR-97）。

    这里只确认「提交了非空文本」，真正的结论由 `writing_attempt` 给。
    """
    raw = (response or {}).get("text", "") if isinstance(response, dict) else response
    text = norm_text(str(raw or ""))
    return ScoreResult(correct=bool(text), score=1.0 if text else 0.0, detail={"deferred": True})


@register(
    "speech-recording",
    required=("target",),
    schedulable=False,
    zh="跟读提交",
)
def _score_speech(question: dict, response: Any) -> ScoreResult:
    """跟读走模块 09 的转写 + 词级 diff + 发音评测，不塞进 SRS（BR-94）。"""
    return ScoreResult(correct=True, score=1.0, detail={"deferred": True})


@register(
    "pronunciation-timeline",
    required=("target",),
    schedulable=False,
    zh="逐音素结果展示（只读）",
)
def _score_timeline(question: dict, response: Any) -> ScoreResult:
    return ScoreResult(correct=True, score=1.0, detail={"readonly": True})
