"""发现页 v5 的纯函数覆盖：Data API 归一化、字幕解析、预览缓存淘汰（需求 09 v5）。"""

import json

import pytest

from domain import preview
from domain.subscriptions import parse_caption
from domain.youtube_api import (
    QuotaExceeded,
    YouTubeApiError,
    _normalize,
    _raise_for_error,
    parse_duration,
)


def test_parse_duration() -> None:
    assert parse_duration("PT1H2M3S") == 3723
    assert parse_duration("PT45S") == 45
    assert parse_duration("PT6M14S") == 374
    assert parse_duration("P1DT2H") == 93600
    # 直播中的视频返回 P0D，当作未知而不是 0 秒
    assert parse_duration("P0D") is None
    assert parse_duration(None) is None
    assert parse_duration("garbage") is None


def test_normalize_picks_best_thumb_and_casts_counts() -> None:
    got = _normalize(
        {
            "id": "abc",
            "snippet": {
                "title": "T",
                "channelTitle": "C",
                "defaultAudioLanguage": "en-GB",
                "thumbnails": {
                    "default": {"url": "d"},
                    "high": {"url": "h"},
                    "maxres": {"url": "m"},
                },
            },
            "contentDetails": {"duration": "PT2M", "caption": "true"},
            "statistics": {"viewCount": "1234"},
        }
    )
    assert got["duration_s"] == 120
    assert got["has_captions"] is True
    assert got["view_count"] == 1234
    assert got["thumb_url"] == "m"
    assert got["audio_language"] == "en-GB"


def test_normalize_tolerates_missing_stats() -> None:
    got = _normalize({"id": "x", "snippet": {}, "contentDetails": {}, "statistics": {}})
    assert got["view_count"] is None and got["has_captions"] is False


def test_quota_error_is_distinguishable() -> None:
    """配额耗尽要能与 key 无效区分开，才谈得上"回退 yt-dlp 并提示"（BR-20）。"""
    payload = {
        "error": {"message": "quota", "errors": [{"reason": "quotaExceeded"}]},
    }
    with pytest.raises(QuotaExceeded):
        _raise_for_error(payload, 403)

    bad_key = {"error": {"message": "API key not valid", "errors": [{"reason": "badRequest"}]}}
    with pytest.raises(YouTubeApiError) as exc:
        _raise_for_error(bad_key, 400)
    assert not isinstance(exc.value, QuotaExceeded)


def test_parse_caption_sniffs_format_not_extension() -> None:
    """yt-dlp 标 vtt 的可能是 json3 或 xml，按内容判定。"""
    json3 = json.dumps(
        {
            "events": [
                {"segs": [{"utf8": "Hello"}, {"utf8": " world."}]},
                {"segs": [{"utf8": "Bye"}]},
            ]
        }
    )
    assert parse_caption(json3) == "Hello world. Bye"

    vtt = "WEBVTT\nKind: captions\n\n1\n00:00:01.000 --> 00:00:03.000\n<c>Hi there</c>\n"
    assert parse_caption(vtt) == "Hi there"

    xml = '<transcript><text start="0">Hi &amp; bye</text><text start="2">Next</text></transcript>'
    assert parse_caption(xml) == "Hi & bye Next"


def test_parse_vtt_dedupes_rolling_repeats() -> None:
    """自动字幕滚动会把上一行整句重复，不去重会让词数与 wpm 翻倍。"""
    vtt = (
        "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nthe cat sat\n\n"
        "00:00:03.000 --> 00:00:05.000\nthe cat sat\n\n"
        "00:00:05.000 --> 00:00:07.000\non the mat\n"
    )
    assert parse_caption(vtt) == "the cat sat on the mat"


def test_clip_seconds_respects_size_cap() -> None:
    """码率高到 60 秒会超单条上限时缩短秒数，而不是退化成转码。"""
    # 5MB / (4000kbps / 8) ≈ 10 秒 → 取下限 15
    assert preview._clip_seconds({"tbr": 4000}, 60) == 15
    # 常见 360p 码率（444kbps）装得下 60 秒
    assert preview._clip_seconds({"tbr": 444}, 60) == 60
    # 没有码率信息时不猜，按请求秒数走
    assert preview._clip_seconds({}, 60) == 60


def test_range_bytes_never_exceeds_filesize() -> None:
    assert preview._range_bytes({"tbr": 444, "filesize": 100_000}, 60) == 100_000
    assert preview._range_bytes({"tbr": 444}, 60) > 0


def test_evict_drops_least_recently_accessed(tmp_path, monkeypatch) -> None:
    """总量超限按 atime 淘汰到 80%（BR-18）。"""
    import os

    monkeypatch.setattr(preview, "PREVIEW_DIR", tmp_path)
    monkeypatch.setattr(preview, "MAX_CACHE_BYTES", 1500)
    for idx, (name, atime) in enumerate([("old", 100), ("mid", 200), ("new", 300)]):
        path = tmp_path / f"{name}.mp4"
        path.write_bytes(b"x" * 1000)
        os.utime(path, (atime, atime + idx))

    # 3 × 1000 字节超 1500 上限 → 淘汰到 80%（1200）以下，只留最近访问的
    assert preview.evict_if_needed() == 2
    assert [p.name for p in tmp_path.glob("*.mp4")] == ["new.mp4"]


def test_evict_noop_when_under_limit(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(preview, "PREVIEW_DIR", tmp_path)
    monkeypatch.setattr(preview, "MAX_CACHE_BYTES", 10_000)
    (tmp_path / "a.mp4").write_bytes(b"x" * 1000)
    assert preview.evict_if_needed() == 0
    assert (tmp_path / "a.mp4").exists()
