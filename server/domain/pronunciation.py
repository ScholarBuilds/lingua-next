"""发音评测（FR-398）。

| 层 | 产出 | 依赖 |
| --- | --- | --- |
| 0 | 完整度、流利度、词级置信度 | 已有的 `diff_words` 与 CTC 词级时间戳 |
| 3 | 中文叙述 | LLM（只叙述，**不打分**） |

> [!info] 音素级的第 1/2 层已于 2026-08-30 下线
>
> 它们靠一个 1.5GB 的本地 wav2vec2-espeak ONNX 出音素后验与 GOP，再由
> `data/phonetics/calibration.json`（speechocean762 上拟合，ρ=0.687）换算成专家刻度。
> 下线的直接原因是把本地推理外包给 API：ASR 与强制对齐都有现成上游，
> **音素后验没有**——任何 ASR API 都不返回逐帧音素概率，
> 而校准模型的 31 个特征几乎全建在那上面，换供应商等于整层重做。
>
> 第 0 层不依赖它：完整度是纯文本比对，流利度与词级置信度来自 CTC 强制对齐
> （`domain/alignment`，另一个模型）。信号质量本来就更高——
> 句子级 PCC 0.742 vs 音素级 0.612。
>
> 标定产物存档在 `归档/2026-08-30-发音评分模型下线/`（它不在 git 里，
> 重建要重下 speechocean762 约 500MB 并重跑约 45 分钟特征抽取）。
"""

from __future__ import annotations

import logging
import math
import re
from dataclasses import asdict, dataclass, field

logger = logging.getLogger(__name__)

# ─────────────── 第 0 层参数 ───────────────

# 词间静音超过这个值算一次停顿。200ms 是语音学上常用的可感知停顿下限
PAUSE_MS = 250
# 句法边界处的停顿属正常；非边界处的长停顿记 UnexpectedBreak
LONG_PAUSE_MS = 500
# 该有边界停顿却没有，记 MissingBreak
MISSING_BREAK_MS = 120

# CTC 归一化置信度的经验区间：实测对齐正确文本均值 −0.661、
# 对齐无关文本 −1.825。映射到 0-100 时用这两个端点做锚，
# **不是**拍脑袋的线性缩放（校准脚本会把它换成拟合值，见 FR-399）。
CTC_GOOD = -0.45
CTC_BAD = -1.80

# 语速（词/分钟）的舒适区间，超出两侧都扣流利度
WPM_LOW, WPM_HIGH = 90, 210



@dataclass
class WordScore:
    word: str
    start: float
    end: float
    raw_score: float
    # BR-92：raw_score 是区间求和，长词天然高，必须按帧数归一化才能横向比较
    norm_score: float
    confidence: float  # 0-100
    status: str  # ok | wrong | miss | extra


@dataclass
class BreakEvent:
    kind: str  # UnexpectedBreak | MissingBreak
    index: int  # 停顿发生在第几个词之后
    ms: int
    word: str




@dataclass
class Assessment:
    completeness: float
    fluency: float
    accuracy: float
    words: list[WordScore] = field(default_factory=list)
    breaks: list[BreakEvent] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "completeness": round(self.completeness, 1),
            "fluency": round(self.fluency, 1),
            "accuracy": round(self.accuracy, 1),
            "words": [asdict(w) for w in self.words],
            "breaks": [asdict(b) for b in self.breaks],
            "notes": self.notes,
        }



def confidence_from_ctc(norm_score: float) -> float:
    """归一化 CTC 分 → 0-100 置信度。两个锚点见 `CTC_GOOD` / `CTC_BAD`。

    只用于**词级展示**（哪个词发得虚），不进准确度评分——
    实测它与专家分只有 ρ≈0.15-0.26，做分数太弱，做「哪个词要留意」够用。
    """
    if norm_score is None or math.isnan(norm_score):
        return 0.0
    t = (norm_score - CTC_BAD) / (CTC_GOOD - CTC_BAD)
    return round(max(0.0, min(1.0, t)) * 100, 1)


def completeness_score(diff: dict) -> float:
    """完整度 = 读到的词占参考词的比例，多读按超出比例扣（FR-398a）。

    直接复用模块 09 已有的 `diff_words` 结果，一行模型代码都不用写。
    """
    total = int(diff.get("total") or 0)
    if total <= 0:
        return 0.0
    missed = sum(1 for it in diff.get("items", []) if it.get("status") == "miss")
    extra = int(diff.get("extra") or 0)
    read_ratio = (total - missed) / total
    extra_penalty = min(0.3, extra / total * 0.5)
    return round(max(0.0, read_ratio - extra_penalty) * 100, 1)


_BOUNDARY_RE = re.compile(r"[,;:.!?—]$")


def _boundary_flags(reference: str, words: list[str]) -> list[bool]:
    """每个词后面是否是「该停」的位置。

    优先用 spaCy 的从句边界（FR-398c）；spaCy 不可用时退回标点判断。
    退回不是降级凑数——标点本来就是最强的边界信号，spaCy 只是多认出无标点的从句。
    """
    flags = [bool(_BOUNDARY_RE.search(w)) for w in words]
    try:
        from domain.syntax import clause_boundaries

        extra = clause_boundaries(reference, len(words))
        for i in extra:
            if 0 <= i < len(flags):
                flags[i] = True
    except Exception as exc:  # noqa: BLE001 - spaCy 缺件时保留标点判断
        logger.debug("从句边界检测不可用，退回标点：%s", exc)
    return flags


def fluency_score(
    word_times: list[tuple[float, float]],
    reference_words: list[str],
    reference: str,
) -> tuple[float, list[BreakEvent]]:
    """流利度 = 停顿分布 + 语速（FR-398b/c）。

    停顿落在从句边界是正常的，落在名词短语中间是 `UnexpectedBreak`，
    该有的边界停顿缺失是 `MissingBreak`。
    """
    if len(word_times) < 2:
        return 100.0, []
    flags = _boundary_flags(reference, reference_words)
    events: list[BreakEvent] = []
    for i in range(len(word_times) - 1):
        gap_ms = int((word_times[i + 1][0] - word_times[i][1]) * 1000)
        at_boundary = flags[i] if i < len(flags) else False
        word = reference_words[i] if i < len(reference_words) else ""
        if not at_boundary and gap_ms >= LONG_PAUSE_MS:
            events.append(BreakEvent("UnexpectedBreak", i, gap_ms, word))
        elif at_boundary and gap_ms < MISSING_BREAK_MS:
            events.append(BreakEvent("MissingBreak", i, gap_ms, word))

    span = max(1e-6, word_times[-1][1] - word_times[0][0])
    wpm = len(word_times) / span * 60
    rate_penalty = 0.0
    if wpm < WPM_LOW:
        rate_penalty = min(25.0, (WPM_LOW - wpm) * 0.25)
    elif wpm > WPM_HIGH:
        rate_penalty = min(20.0, (wpm - WPM_HIGH) * 0.2)

    unexpected = sum(1 for e in events if e.kind == "UnexpectedBreak")
    missing = sum(1 for e in events if e.kind == "MissingBreak")
    score = 100.0 - unexpected * 12.0 - missing * 5.0 - rate_penalty
    return round(max(0.0, min(100.0, score)), 1), events


def assess_layer0(diff: dict, aligned: list[dict], reference: str) -> Assessment:
    """第 0 层：零新依赖。

    `aligned` 为 CTC 对齐产物 `[{text, start, end, score, frames}]`；
    为空时仍能给完整度（那是纯文本比对），只是流利度与置信度缺失。
    """
    completeness = completeness_score(diff)
    ref_words = [it.get("word", "") for it in diff.get("items", []) if it.get("status") != "extra"]

    words: list[WordScore] = []
    status_by_word: dict[int, str] = {
        i: it.get("status", "ok") for i, it in enumerate(diff.get("items", []))
    }
    for i, a in enumerate(aligned):
        frames = max(1, int(a.get("frames") or 1))
        norm = float(a.get("score", 0.0)) / frames
        words.append(
            WordScore(
                word=a.get("text", ""),
                start=round(float(a.get("start", 0.0)), 3),
                end=round(float(a.get("end", 0.0)), 3),
                raw_score=round(float(a.get("score", 0.0)), 3),
                norm_score=round(norm, 4),
                confidence=confidence_from_ctc(norm),
                status=status_by_word.get(i, "ok"),
            )
        )

    if words:
        fluency, events = fluency_score(
            [(w.start, w.end) for w in words], ref_words or [w.word for w in words], reference
        )
        accuracy = round(sum(w.confidence for w in words) / len(words), 1)
        notes = []
    else:
        fluency, events, accuracy = 0.0, [], 0.0
        notes = ["未取到词级时间戳，流利度与词级置信度不可用"]

    return Assessment(
        completeness=completeness,
        fluency=fluency,
        accuracy=accuracy,
        words=words,
        breaks=events,
        notes=notes,
    )


def assess_full(
    audio_path: str,
    reference: str,
    diff: dict,
    aligned: list[dict],
) -> Assessment:
    """完整评测。音素层下线后它就是第 0 层，签名保留给调用方（shadowing.py）。

    `audio_path` 现在用不上了，留着是因为这一层将来若接回音素能力（换成有音素后验的
    上游、或重新装回本地模型）需要它，而改签名要动调用方与两处测试。
    """
    return assess_layer0(diff, aligned, reference)
