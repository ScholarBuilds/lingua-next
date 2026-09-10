"""视频 AI 加工领域逻辑：难度评级规则、词组区间定位、词级时间戳插值、加工 prompt（FR-18/19）。

纯函数集合（不触库不触网），供 worker.enrich_video 组装与单测覆盖。
偏移一律 UTF-16 码元（BR-01，与 JS 口径一致）。
"""

import json
import re

from domain.articles import utf16_len

CEFR_LEVELS = ("A1", "A2", "B1", "B2", "C1", "C2")

ACCENTS = ("american", "british", "australian", "canadian", "indian", "non_native", "mixed")

PHRASE_TYPES = ("phrasal", "collocation", "idiom")

ENRICH_STEPS = ("summary", "difficulty", "phrases", "vocab")

_WORD_RE = re.compile(r"[A-Za-z][A-Za-z'-]*")

# COCA 词频位次 → CEFR 档位。依据：Cambridge EVP / 词表规模的常用近似
# （A1≈前1000 高频词、A2≈前2000、B1≈前4000、B2≈前8000、C1≈前16000，其余 C2）。
_FRQ_BOUNDS = ((1000, "A1"), (2000, "A2"), (4000, "B1"), (8000, "B2"), (16000, "C1"))

# ECDICT 考纲标签 → CEFR 近似（frq 缺失/为 0 时兜底；frq=0 多为专有名词，见踩坑索引）。
# 中考≈A2、高考/四级≈B1、六级/考研≈B2、雅思/托福≈C1、GRE≈C2。
_TAG_LEVEL = {
    "zk": "A2", "gk": "B1", "cet4": "B1", "cet6": "B2",
    "ky": "B2", "ielts": "C1", "toefl": "C1", "gre": "C2",
}


def tokenize_words(text: str) -> list[str]:
    """字幕文本 → 小写英文词序列（撇号/连字符视为词内字符）。"""
    return [w.lower() for w in _WORD_RE.findall(text)]


def cefr_level(frq: int | None, tag: str | None) -> str | None:
    """ECDICT 单词 → CEFR 档位：优先 COCA 词频，缺失时用考纲标签里最低档兜底。"""
    if frq and frq > 0:
        for bound, level in _FRQ_BOUNDS:
            if frq <= bound:
                return level
        return "C2"
    if tag:
        levels = [_TAG_LEVEL[t] for t in tag.split() if t in _TAG_LEVEL]
        if levels:
            return min(levels, key=CEFR_LEVELS.index)
    return None  # 词典无词频无标签（多为专有名词/衍生形），不计入分布


def cefr_distribution(levels: list[str | None]) -> dict[str, float]:
    """已定级词（按去重词型）→ 各档占比（0-1，三位小数）；无可定级词返回空 dict。"""
    known = [lv for lv in levels if lv]
    if not known:
        return {}
    return {
        level: round(known.count(level) / len(known), 3)
        for level in CEFR_LEVELS
        if level in known
    }


def difficulty_stars(cefr_dist: dict[str, float], wpm: float) -> int:
    """CEFR 分布 + 语速 → 1-5 星（FR-01 难度星级，规则写死可解释）。

    1) 词汇档：advanced = B2+C1+C2 占比。
       <6% → 1 星；<12% → 2 星；<20% → 3 星；<30% → 4 星；否则 5 星。
       依据：Nation (2006) 词汇覆盖率研究——95% 文本覆盖约需 4000-5000 词族
       （约 B1 上限），高级词占比越高理解门槛越高；阈值按本项目语料实测校准。
    2) 语速修正：英语对话均速约 150 wpm（Tauroza & Allison 1990）；
       wpm ≥ 180（快语速播客/访谈）加一星，0 < wpm ≤ 110（慢速英语量级，
       VOA Special English 约 90-100 wpm）减一星；结果钳制在 1-5。
    """
    advanced = sum(cefr_dist.get(level, 0.0) for level in ("B2", "C1", "C2"))
    if advanced < 0.06:
        stars = 1
    elif advanced < 0.12:
        stars = 2
    elif advanced < 0.20:
        stars = 3
    elif advanced < 0.30:
        stars = 4
    else:
        stars = 5
    if wpm >= 180:
        stars += 1
    elif 0 < wpm <= 110:
        stars -= 1
    return max(1, min(stars, 5))


def locate_phrase(text: str, phrase: str) -> tuple[int, int] | None:
    """句内定位词组（大小写不敏感），返回 UTF-16 码元区间 [start, end)；定位不到 None。"""
    phrase = phrase.strip()
    if not phrase:
        return None
    match = re.search(re.escape(phrase), text, re.IGNORECASE)
    if match is None:
        return None
    start = utf16_len(text[: match.start()])
    return start, start + utf16_len(text[match.start(): match.end()])


def interpolate_words(text: str, start_ms: int, end_ms: int) -> list[list]:
    """官方字幕无词级时间戳时，按词字符长度比例插值近似（FR-19 ▲）。

    权重 = 词长 + 1（近似词间停顿），首词起点对齐 cue 起点、末词终点对齐 cue 终点。
    返回 [[start_ms, end_ms, word], ...]，track.meta 需标 approximate:true。
    """
    words = text.split()
    if not words or end_ms <= start_ms:
        return []
    weights = [len(w) + 1 for w in words]
    total = sum(weights)
    span = end_ms - start_ms
    out: list[list] = []
    acc = 0
    for word, weight in zip(words, weights, strict=True):
        word_start = start_ms + acc * span // total
        acc += weight
        word_end = start_ms + acc * span // total
        out.append([word_start, word_end, word])
    out[-1][1] = end_ms
    return out


def _exact_word_re(word: str) -> re.Pattern:
    return re.compile(rf"(?<![A-Za-z]){re.escape(word)}(?![A-Za-z])", re.IGNORECASE)


def _inflected_word_re(word: str) -> re.Pattern:
    """原形 vs 屈折形（run/running、study/studies）：截尾前缀匹配兜底。"""
    return re.compile(rf"(?<![A-Za-z]){re.escape(word[: max(4, len(word) - 2)])}", re.IGNORECASE)


def contains_word(text: str, word: str) -> bool:
    """这句里到底有没有这个词——与 `first_cue_ordinal` 同一套判据。

    词卡出处自愈靠它判断存量 ordinal 是不是指错了句（见 `/videos/{id}/vocab`）。
    """
    word = (word or "").strip()
    if not word or not text:
        return False
    return bool(_exact_word_re(word).search(text) or _inflected_word_re(word).search(text))


def first_cue_ordinal(cue_texts: list[tuple[int, str]], word: str) -> int | None:
    """重点词回链出处：首个含该词的句序号（词边界匹配，退化前缀匹配容纳屈折形）。

    传进来的是**学习句**（StudyUnit）序号——前端词卡拿 `cue_ordinal` 去 StudyUnit
    数组里查出处，源字幕行 `SubtitleCue.ordinal` 与它是两套编号（实测 424 vs 685）。
    """
    word = word.strip()
    if not word:
        return None
    exact = _exact_word_re(word)
    for ordinal, text in cue_texts:
        if exact.search(text):
            return ordinal
    prefix = _inflected_word_re(word)
    for ordinal, text in cue_texts:
        if prefix.search(text):
            return ordinal
    return None


def pick_primary_track(tracks: list) -> object | None:
    """选加工用主字幕轨：排除翻译轨，默认轨 > official > whisper > auto，英轨优先。"""
    candidates = [t for t in tracks if t.kind != "translation"]
    if not candidates:
        return None
    kind_rank = {"official": 0, "whisper": 1, "auto": 2}
    return min(
        candidates,
        key=lambda t: (
            0 if t.is_default else 1,
            kind_rank.get(t.kind, 3),
            0 if (t.lang or "").lower().startswith("en") else 1,
            t.id,
        ),
    )


# ---- LLM prompt（全部 JSON mode，走语义别名，禁止硬编码供应商模型名） ----


def video_summary_prompt(title: str, text: str, truncated: bool) -> tuple[str, str]:
    """摘要+中文标题+主题+口音判定：单次调用产出视频卡片信息（FR-18 a）。"""
    system = (
        "你是面向中国英语学习者的视频导学助手，根据英文字幕全文生成视频卡片信息。"
        "只输出 JSON 对象，字段：title_zh（中文标题，不超过 30 字，概括内容而非直译原题）、"
        "summary_zh（中文摘要 80-120 字，概述视频剧情或内容）、"
        "topics（数组，1-3 个中文主题标签，如 生活/旅行/播客/科技/美食/访谈）、"
        "accent（说话者口音，从拼写、用词与表达特征判定，"
        "只能取 american/british/australian/canadian/indian/non_native/mixed 之一）。"
        + ("字幕因过长已截断，请基于可见部分概括。" if truncated else "")
    )
    user = json.dumps({"title": title, "subtitles": text}, ensure_ascii=False)
    return system, user


def video_phrases_prompt(sentences: list[dict]) -> tuple[str, str]:
    """逐句词组提取（FR-18 词组/搭配提取）：短语动词/搭配/习语三类，供彩色高亮。"""
    system = (
        "你是面向中国英语学习者的字幕词组标注助手。输入是带编号的英文字幕句子，"
        "找出每句中值得积累的词组：短语动词（phrasal）、常用搭配（collocation）、"
        "习语（idiom）。只输出 JSON 对象，字段 items 为数组，每项 "
        "{cue_ordinal: 对应输入句的编号, phrases: [{text: 词组原文（必须逐字取自该句，"
        "保持原大小写）, type: phrasal/collocation/idiom 之一, meaning_zh: 中文释义}]}。"
        "没有词组的句子省略；严禁编造句中不存在的词组；单个普通单词不算词组。"
    )
    user = json.dumps({"sentences": sentences}, ensure_ascii=False)
    return system, user


def video_vocab_prompt(text: str, truncated: bool) -> tuple[str, str]:
    """重点词汇表（FR-18 d，词卡模式数据源）：20-40 个词 + 释义 + CEFR。"""
    system = (
        "你是面向中国英语学习者的视频词汇助手，从英文字幕全文中挑选值得学习的重点词汇。"
        "只输出 JSON 对象，字段 items 为数组（20-40 项），每项 "
        "{word: 英文单词原形（必须出现在字幕中）, meaning_zh: 该词在视频语境中的中文释义, "
        "level: 该词 CEFR 难度，取 A1/A2/B1/B2/C1/C2 之一}。"
        "优先选对理解内容关键、且中国学习者较可能不认识的词；跳过人名地名。"
        + ("字幕因过长已截断，请基于可见部分挑选。" if truncated else "")
    )
    user = json.dumps({"subtitles": text}, ensure_ascii=False)
    return system, user
