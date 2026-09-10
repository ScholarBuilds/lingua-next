"""vtt/srt 字幕解析：毫秒精度，合并 YouTube auto 字幕的滚动重复行。"""

import re
from dataclasses import dataclass

_TS_RE = re.compile(r"(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})")
_CUE_LINE_RE = re.compile(
    r"(?:(?:\d+):)?(?:\d{1,2}):(?:\d{2})[.,](?:\d{3})\s*-->\s*"
    r"(?:(?:\d+):)?(?:\d{1,2}):(?:\d{2})[.,](?:\d{3})"
)
_TAG_RE = re.compile(r"<[^>]+>")  # vtt 内联标签：<c>、<00:00:01.000> 等


@dataclass
class Cue:
    start_ms: int
    end_ms: int
    text: str
    # 词级时间戳 [[start_ms,end_ms,word],...]：whisper 实测填充，解析路径为 None
    words: list | None = None


def _parse_ts(ts: str) -> int:
    match = _TS_RE.match(ts.strip())
    if match is None:
        raise ValueError(f"bad timestamp: {ts!r}")
    hours, minutes, seconds, millis = match.groups()
    return ((int(hours or 0) * 60 + int(minutes)) * 60 + int(seconds)) * 1000 + int(millis)


def _clean_text(raw: str) -> str:
    text = _TAG_RE.sub("", raw)
    text = text.replace("&nbsp;", " ").replace("&amp;", "&")
    text = text.replace("&lt;", "<").replace("&gt;", ">").replace("&#39;", "'")
    return " ".join(text.split())


def parse_subtitles(content: str) -> list[Cue]:
    """解析 vtt 或 srt 文本为 Cue 列表（自动识别格式，两者时间行语法同构）。"""
    cues: list[Cue] = []
    lines = content.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if "-->" not in line or not _CUE_LINE_RE.search(line):
            i += 1
            continue
        start_raw, _, end_raw = line.partition("-->")
        # vtt 时间行尾可带定位参数（align:start position:0%），截掉
        start_ms = _parse_ts(start_raw)
        end_ms = _parse_ts(end_raw.strip().split(" ")[0])
        i += 1
        text_lines: list[str] = []
        while i < len(lines) and lines[i].strip():
            text_lines.append(_clean_text(lines[i]))
            i += 1
        text = " ".join(t for t in text_lines if t).strip()
        if text and end_ms > start_ms:
            cues.append(Cue(start_ms=start_ms, end_ms=end_ms, text=text))
    return _merge_rolling_duplicates(cues)


def _merge_rolling_duplicates(cues: list[Cue]) -> list[Cue]:
    """合并滚动重复：YouTube auto 字幕相邻 cue 常重复上一行文本。

    规则：后一条以前一条文本开头 → 去掉重复前缀只留新增部分；
    完全相同 → 并入前一条并延长时间轴。
    """
    merged: list[Cue] = []
    for cue in cues:
        if merged:
            prev = merged[-1]
            if cue.text == prev.text:
                prev.end_ms = max(prev.end_ms, cue.end_ms)
                continue
            if cue.text.startswith(prev.text + " "):
                cue = Cue(
                    start_ms=cue.start_ms,
                    end_ms=cue.end_ms,
                    text=cue.text[len(prev.text) :].strip(),
                )
        merged.append(cue)
    return merged
