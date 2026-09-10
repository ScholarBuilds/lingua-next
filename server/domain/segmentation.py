"""分句与词元标注。

偏移一律为 UTF-16 码元（与 JS 字符串口径一致，BR-G-007/模块02 BR-01）。
英文书籍绝大多数为 BMP 字符（UTF-16 偏移 == 码点偏移），仅当段落含
增补平面字符时才构建偏移映射，避免为罕见情况付全量代价。
"""

import re

import pysbd

_seg = pysbd.Segmenter(language="en", clean=False, char_span=True)

WORD_RE = re.compile(r"[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ'’-]*")


def _utf16_map(text: str) -> list[int] | None:
    """码点索引 → UTF-16 码元索引映射；纯 BMP 文本返回 None（恒等）。"""
    if all(ord(ch) <= 0xFFFF for ch in text):
        return None
    offsets = [0] * (len(text) + 1)
    acc = 0
    for i, ch in enumerate(text):
        offsets[i] = acc
        acc += 2 if ord(ch) > 0xFFFF else 1
    offsets[len(text)] = acc
    return offsets


def split_sentences(text: str) -> list[tuple[int, int]]:
    """句子 UTF-16 区间列表（去除首尾空白后的区间）。"""
    m = _utf16_map(text)
    spans: list[tuple[int, int]] = []
    for span in _seg.segment(text):
        raw = span.sent
        lstrip = len(raw) - len(raw.lstrip())
        rstrip = len(raw) - len(raw.rstrip())
        start, end = span.start + lstrip, span.end - rstrip
        if end <= start:
            continue
        if m is not None:
            start, end = m[start], m[end]
        spans.append((start, end))
    return spans


def tokenize(text: str) -> list[list]:
    """词元数组 [[start, end, surface_lower, learnable], ...]，偏移为 UTF-16。

    lemma 不在解析期计算：查词时由 ECDICT exchange 与小写回退裁决（模块01 FR-03）。
    """
    m = _utf16_map(text)
    tokens: list[list] = []
    for match in WORD_RE.finditer(text):
        start, end = match.start(), match.end()
        surface = match.group()
        if m is not None:
            start, end = m[start], m[end]
        learnable = len(surface) > 1 or surface.lower() in ("a", "i")
        tokens.append([start, end, surface.lower(), learnable])
    return tokens
