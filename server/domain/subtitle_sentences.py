"""字幕三级结构：cue 文本流 → 语法句 → 学习句（ADR-007 FR-23/24，需求 v3 第 10 节）。

cue 由 ASR 按长度硬切（faster-whisper 约 98 字符一段），与句子边界无关：15 号视频
71 条 cue 中 52 条断在半句、46 条以小写承接上条。听写、跟读、中译英、句收藏全部
建立在半句之上，故引入三级结构：

    cue        时间轴单位，原样保留（卡拉OK高亮、进度条跳转、A-B 循环）
    语法句      语境单位（翻译送审语境、AI 陪读引用、词组区间定位）
    学习句      练习单位（听写/跟读/中译英/句收藏/已学标记）

学习句阈值取自 Netflix Timed Text Style Guide：单条 ≤7 秒、每行 42 字符最多 2 行。
647 句实测样本中约一成需要二次切分。
"""

import re
from dataclasses import dataclass

from domain.segmentation import split_sentences

# Netflix：单条字幕最长 7 秒、每行 42 字符最多 2 行
MAX_UNIT_S = 7.0
MAX_UNIT_CHARS = 84
# 词间停顿达到该阈值视为自然停顿，可作切点
GAP_S = 0.30
# 超过该间隔必定切开（无视最小词数）：视频里的无语音画面会把学习句撑到十几秒，
# 15 号视频实测 "I've" 与 "arrived" 之间隔了 17.8 秒静音
HARD_GAP_S = 2.0
# 两端各留的最少词数，避免切出单词碎片
MIN_EDGE_WORDS = 2

# 从属连词/并列连词：标点与停顿都没有时的最后切点
CONJUNCTIONS = frozenset(
    {
        "and", "but", "or", "so", "because", "that", "which", "who", "when",
        "while", "if", "then", "although", "though", "since", "unless", "after",
        "before", "as", "where",
    }
)

# 非语音标记：环境音、说话人标注、YouTube 脏话屏蔽占位、拟声
# 全库 4904 条 cue 实测：整条噪声 46 条、句内嵌 7 处，方括号与全角/半角圆括号都出现过
_NOISE_WHOLE = re.compile(r"^\s*[\[\(【（][^\]\)】）]{1,24}[\]\)】）]\s*$")
_NOISE_INLINE = re.compile(
    r"[\[\(【（]\s*(?:music|applause|laughter|cheering|__+|音乐|掌声|笑声|欢呼)\s*[\]\)】）]",
    re.IGNORECASE,
)


def is_noise(text: str) -> bool:
    """整条即非语音标记（`[Music]`、`（音乐）`、`[ __ ]` 等）。"""
    return bool(_NOISE_WHOLE.match(text))


def strip_inline_noise(text: str) -> str:
    """剔除句内嵌的已知噪声标记，保留其余内容。"""
    return re.sub(r"\s{2,}", " ", _NOISE_INLINE.sub(" ", text)).strip()


class Word:
    """带全局字符偏移的词：把 cue 内的词级时间戳映射到拼接后的全文。"""

    __slots__ = ("start_ms", "end_ms", "surface", "gs", "ge", "cue_id")

    def __init__(self, start_ms: int, end_ms: int, surface: str, gs: int, ge: int, cue_id: int):
        self.start_ms = start_ms
        self.end_ms = end_ms
        self.surface = surface
        self.gs = gs
        self.ge = ge
        self.cue_id = cue_id


def join_cues(cues: list[dict]) -> tuple[str, list[Word]]:
    """cue 列表 → (拼接全文, 带全局偏移的词序列)。

    cue 之间补一个空格；每个词在 cue.text 内的位置换算为全文偏移，
    后续分句只需按字符区间把词归到句里。
    """
    parts: list[str] = []
    words: list[Word] = []
    cursor = 0
    for c in cues:
        t = (c.get("text") or "").strip()
        if not t:
            continue
        if parts:
            cursor += 1  # 连接空格
        base = cursor
        pos = 0
        for w in c.get("words") or []:
            start_ms, end_ms, surface = int(w[0]), int(w[1]), str(w[2])
            idx = t.find(surface, pos)
            if idx < 0:
                idx = pos
            words.append(
                Word(start_ms, end_ms, surface, base + idx, base + idx + len(surface), c["id"])
            )
            pos = idx + len(surface)
        parts.append(t)
        cursor = base + len(t)
    return " ".join(parts), words


@dataclass(frozen=True)
class Limits:
    """学习句切分阈值。可在追踪页按节点覆盖后重切（需求 09 v6 FR-76）。"""

    max_unit_s: float = MAX_UNIT_S
    max_unit_chars: int = MAX_UNIT_CHARS
    gap_s: float = GAP_S


DEFAULT_LIMITS = Limits()


def _find_split(
    words: list[Word], text: str, lo: int, hi: int, limits: Limits
) -> int | None:
    """在词下标区间 [lo, hi) 内找最佳切点，返回切点词下标（该词起新段）。

    优先级：句中标点 > 词间停顿 ≥gap_s > 从属连词；同级取最接近中点者。
    """
    best: int | None = None
    best_rank = 99
    mid = (lo + hi) // 2
    for i in range(lo + MIN_EDGE_WORDS, hi - MIN_EDGE_WORDS + 1):
        prev, cur = words[i - 1], words[i]
        tail = text[prev.gs : prev.ge]
        gap = (cur.start_ms - prev.end_ms) / 1000.0
        if re.search(r"[,;:—]$", tail):
            rank = 0
        elif gap >= limits.gap_s:
            rank = 1
        elif cur.surface.lower().strip(".,!?;:") in CONJUNCTIONS:
            rank = 2
        else:
            continue
        closer = best is not None and abs(i - mid) < abs(best - mid)
        if rank < best_rank or (rank == best_rank and closer):
            best, best_rank = i, rank
    return best


def _find_hard_gap(words: list[Word], lo: int, hi: int) -> int | None:
    """区间内最大的超阈值静音位置；静音跨越必须切开，不受最小词数约束。"""
    best: int | None = None
    best_gap = HARD_GAP_S
    for i in range(lo + 1, hi):
        gap = (words[i].start_ms - words[i - 1].end_ms) / 1000.0
        if gap >= best_gap:
            best, best_gap = i, gap
    return best


def _split_unit(
    words: list[Word], text: str, lo: int, hi: int, limits: Limits = DEFAULT_LIMITS
) -> list[tuple[int, int]]:
    """递归切分词区间 [lo, hi) 为满足阈值的学习句；无合法切点则原样保留。"""
    hard = _find_hard_gap(words, lo, hi)
    if hard is not None:
        return _split_unit(words, text, lo, hard, limits) + _split_unit(
            words, text, hard, hi, limits
        )
    span_s = (words[hi - 1].end_ms - words[lo].start_ms) / 1000.0
    chars = words[hi - 1].ge - words[lo].gs
    if span_s <= limits.max_unit_s and chars <= limits.max_unit_chars:
        return [(lo, hi)]
    if hi - lo < MIN_EDGE_WORDS * 2:
        return [(lo, hi)]
    cut = _find_split(words, text, lo, hi, limits)
    if cut is None:
        return [(lo, hi)]
    return _split_unit(words, text, lo, cut, limits) + _split_unit(
        words, text, cut, hi, limits
    )


def build_sentences(cues: list[dict], limits: Limits = DEFAULT_LIMITS) -> list[dict]:
    """cue 列表 → 语法句列表，每句含学习句、词级时间戳、来源 cue。

    返回 [{text, start_ms, end_ms, is_noise, src_cue_ids,
           words: [[start_ms, end_ms, surface, char_start, char_end], ...],
           units: [{text, start_ms, end_ms, char_start, char_end}, ...]}]
    时间戳取首词 start / 末词 end（非按字符比例插值）；char 偏移相对本句。
    """
    full, words = join_cues(cues)
    if not full:
        return []

    out: list[dict] = []
    wi = 0
    for s, e in split_sentences(full):
        raw = full[s:e].strip()
        if not raw:
            continue

        # 该句覆盖的词区间
        while wi < len(words) and words[wi].ge <= s:
            wi += 1
        lo = wi
        hi = lo
        while hi < len(words) and words[hi].gs < e:
            hi += 1

        if hi <= lo:
            # 无词级时间戳兜底（官方字幕轨）：整句归到最近的 cue 时间
            continue

        cleaned = strip_inline_noise(raw)
        noise = is_noise(raw) or not cleaned
        mine = words[lo:hi]
        sent_words = [
            [w.start_ms, w.end_ms, w.surface, max(0, w.gs - s), max(0, w.ge - s)] for w in mine
        ]
        units = [
            {
                "text": full[words[a].gs : words[b - 1].ge].strip(),
                "start_ms": words[a].start_ms,
                "end_ms": words[b - 1].end_ms,
                "char_start": max(0, words[a].gs - s),
                "char_end": max(0, words[b - 1].ge - s),
            }
            for a, b in ([(lo, hi)] if noise else _split_unit(words, full, lo, hi, limits))
        ]
        out.append(
            {
                "text": raw,
                "start_ms": mine[0].start_ms,
                "end_ms": mine[-1].end_ms,
                "is_noise": noise,
                "src_cue_ids": sorted({w.cue_id for w in mine}),
                "words": sent_words,
                "units": [u for u in units if u["text"]],
            }
        )
        wi = hi
    return out
