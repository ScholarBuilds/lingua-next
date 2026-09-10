from domain.subtitles import parse_subtitles

VTT = """WEBVTT
Kind: captions
Language: en

00:00:00.000 --> 00:00:02.500 align:start position:0%
All right, so here we are

00:00:02.500 --> 00:00:05.120
in front of the <c>elephants</c>

00:01:02.000 --> 00:01:04.000
the cool thing about these guys
"""

SRT = """1
00:00:01,000 --> 00:00:03,200
- Hello there.

2
00:00:03,200 --> 00:00:06,000
General Kenobi!
You are a bold one.

3
01:02:03,456 --> 01:02:05,000
Late cue.
"""


def test_parse_vtt_ms_precision_and_tags() -> None:
    cues = parse_subtitles(VTT)
    assert len(cues) == 3
    assert (cues[0].start_ms, cues[0].end_ms) == (0, 2500)
    assert cues[1].text == "in front of the elephants"  # 内联标签剥离
    assert cues[2].start_ms == 62_000


def test_parse_srt_multiline_and_hours() -> None:
    cues = parse_subtitles(SRT)
    assert len(cues) == 3
    assert cues[0].start_ms == 1000 and cues[0].end_ms == 3200
    assert cues[1].text == "General Kenobi! You are a bold one."  # 多行合并
    assert cues[2].start_ms == 1 * 3600_000 + 2 * 60_000 + 3_456


def test_rolling_duplicates_merged() -> None:
    # YouTube auto 字幕典型滚动模式：整行重复 + 前缀累积
    raw = """WEBVTT

00:00:00.000 --> 00:00:01.000
hello world

00:00:01.000 --> 00:00:02.000
hello world

00:00:02.000 --> 00:00:03.000
hello world and more
"""
    cues = parse_subtitles(raw)
    assert len(cues) == 2
    assert cues[0].text == "hello world"
    assert cues[0].end_ms == 2000  # 相同行并入并延长时间轴
    assert cues[1].text == "and more"  # 前缀重复只留新增
