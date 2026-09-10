"""三级字幕结构与跟读比对的单测（ADR-007）。"""

import asyncio

import pytest

from domain import punctuation as pt
from domain.punctuation import chunk_by_segments, needs_restore, normalize_words
from domain.shadowing import diff_words
from domain.subtitle_sentences import (
    MAX_UNIT_CHARS,
    MAX_UNIT_S,
    build_sentences,
    is_noise,
    strip_inline_noise,
)


def _cue(cue_id: int, start_ms: int, text: str, words: list) -> dict:
    return {"id": cue_id, "text": text, "words": words, "start_ms": start_ms,
            "end_ms": words[-1][1] if words else start_ms}


def _even_words(text: str, start_ms: int, per_word_ms: int = 300) -> list:
    """按空白切词并均匀铺时间戳，供分句用例造数据。"""
    out = []
    pos = 0
    t = start_ms
    for w in text.split():
        idx = text.find(w, pos)
        out.append([t, t + per_word_ms, w])
        pos = idx + len(w)
        t += per_word_ms
    return out


class TestNoise:
    def test_whole_line_markers(self):
        for text in ("[Music]", "[音乐]", "（音乐）", "[ __ ]", "(Applause)", "【掌声】"):
            assert is_noise(text), text

    def test_normal_line_is_not_noise(self):
        assert not is_noise("All right, so here we are.")
        assert not is_noise("(I think) it works")  # 句内括号不算整条噪声

    def test_strip_inline_only_known_markers(self):
        assert strip_inline_noise("Hello [Music] world") == "Hello world"
        assert strip_inline_noise("Keep (this) text") == "Keep (this) text"


class TestBuildSentences:
    def test_splits_across_cues(self):
        """cue 按长度硬切，句子跨 cue 时要合回来。"""
        cues = [
            _cue(1, 0, "Hello there. This is", _even_words("Hello there. This is", 0)),
            _cue(2, 1200, "a test.", _even_words("a test.", 1200)),
        ]
        sents = build_sentences(cues)
        assert [s["text"] for s in sents] == ["Hello there.", "This is a test."]
        assert sents[1]["src_cue_ids"] == [1, 2]

    def test_sentence_time_from_words(self):
        cues = [_cue(1, 500, "One two three.", _even_words("One two three.", 500))]
        s = build_sentences(cues)[0]
        assert s["start_ms"] == 500
        assert s["end_ms"] == 500 + 3 * 300

    def test_long_sentence_split_into_units(self):
        text = (
            "I have not been waking up early on most days just because a lot of my clubs "
            "have not started yet, and classes are slowly picking up, so there was no point."
        )
        cues = [_cue(1, 0, text, _even_words(text, 0, 400))]
        units = build_sentences(cues)[0]["units"]
        assert len(units) > 1
        for u in units:
            assert (u["end_ms"] - u["start_ms"]) / 1000 <= MAX_UNIT_S + 0.01

    def test_hard_gap_forces_split(self):
        """静音跨越必切：否则学习句里会有十几秒空等（15 号视频实测 17.8s）。"""
        words = [[0, 300, "I've"], [18_000, 18_300, "arrived"], [18_300, 18_600, "here."]]
        sents = build_sentences([_cue(1, 0, "I've arrived here.", words)])
        units = sents[0]["units"]
        assert len(units) == 2
        assert units[0]["text"] == "I've"

    def test_unit_char_range_maps_back(self):
        text = "Alpha beta gamma delta."
        cues = [_cue(1, 0, text, _even_words(text, 0))]
        s = build_sentences(cues)[0]
        for u in s["units"]:
            assert s["text"][u["char_start"] : u["char_end"]] == u["text"]

    def test_noise_sentence_marked_and_not_split(self):
        cues = [_cue(1, 0, "[Music]", _even_words("[Music]", 0))]
        s = build_sentences(cues)[0]
        assert s["is_noise"]
        assert len(s["units"]) == 1

    def test_units_are_monotonic(self):
        text = "First sentence here. Second one follows. Third and last."
        cues = [_cue(1, 0, text, _even_words(text, 0))]
        units = [u for s in build_sentences(cues) for u in s["units"]]
        starts = [u["start_ms"] for u in units]
        assert starts == sorted(starts)

    def test_short_sentence_stays_single_unit(self):
        cues = [_cue(1, 0, "And that's cool.", _even_words("And that's cool.", 0))]
        s = build_sentences(cues)[0]
        assert len(s["units"]) == 1
        assert len(s["units"][0]["text"]) <= MAX_UNIT_CHARS


class TestPunctuation:
    def test_normalize_ignores_case_and_punctuation(self):
        assert normalize_words("Hello, world!") == normalize_words("hello world")

    def test_normalize_detects_dropped_word(self):
        assert normalize_words("a b c") != normalize_words("a c")

    def test_needs_restore_on_sparse_stops(self):
        assert needs_restore("word " * 60)  # 零句末标点
        assert not needs_restore("Short one. Another one. A third one.")

    def test_chunking_respects_segment_boundary(self):
        segs = ["a" * 900, "b" * 900, "c" * 100]
        chunks = chunk_by_segments(segs, limit=1000)
        # 不变量：每块不超限，且没有 segment 被切断（词序列校验依赖这一点）
        assert all(len(c) <= 1000 for c in chunks)
        assert "".join(chunks).replace(" ", "") == "".join(segs)
        assert chunks[0] == "a" * 900

    def test_chunking_packs_short_segments(self):
        chunks = chunk_by_segments(["one", "two", "three"], limit=1000)
        assert chunks == ["one two three"]


class TestShadowing:
    def test_perfect_read(self):
        r = diff_words("And that is cool", "and that is cool")
        assert r["accuracy"] == 100
        assert all(i["status"] == "ok" for i in r["items"])

    def test_wrong_word_recorded_with_got(self):
        r = diff_words("these guys are here", "those guys are here")
        wrong = [i for i in r["items"] if i["status"] == "wrong"]
        assert wrong and wrong[0]["got"] == "those"

    def test_missing_word(self):
        r = diff_words("one two three four", "one three four")
        assert [i["status"] for i in r["items"]].count("miss") == 1

    def test_extra_words_counted(self):
        r = diff_words("one two", "one two three four")
        assert r["extra"] == 2
        assert r["accuracy"] == 100  # 原句全读对了，多读单独计

    def test_empty_spoken(self):
        r = diff_words("one two", "")
        assert r["accuracy"] == 0
        assert all(i["status"] == "miss" for i in r["items"])


class TestPunctuationFallback:
    """三层兜底：重试 → 二分切小块 → 标记（FR-39/40/41）。"""

    @staticmethod
    def _run(coro):
        return asyncio.run(coro)

    def test_retry_succeeds_on_second_call(self, monkeypatch: pytest.MonkeyPatch):
        """首次输出词序列不一致，重试一次通过——18 号那种失败本可救回。"""
        calls = {"n": 0}

        async def fake(alias, messages, temperature=None):
            calls["n"] += 1
            text = messages[-1]["content"]
            return "dropped words" if calls["n"] == 1 else text + "."

        monkeypatch.setattr(pt, "complete_text", fake)
        out, stat = self._run(pt.restore_punctuation(["one two three four five six " * 8]))
        assert calls["n"] == 2
        assert stat["passed"] == 1 and stat["failed"] == 0
        assert out.endswith(".")

    def test_splits_when_retry_fails(self, monkeypatch: pytest.MonkeyPatch):
        """整块两次都不过就二分：小块更容易保持词序列一致。"""
        seen: list[int] = []

        async def fake(alias, messages, temperature=None):
            text = messages[-1]["content"]
            seen.append(len(text))
            if len(text) > 500:  # 大块一律"改词"，逼出二分
                return "garbage"
            return text + "."

        monkeypatch.setattr(pt, "complete_text", fake)
        long_text = "alpha beta gamma delta epsilon zeta " * 40  # 约 1400 字符
        out, stat = self._run(pt.restore_punctuation([long_text]))
        assert any(n <= 500 for n in seen), "应出现二分后的小块"
        assert stat["passed"] == 1
        assert normalize_words(out) == normalize_words(long_text)  # 词序列始终不变

    def test_marks_failure_when_all_attempts_fail(self, monkeypatch: pytest.MonkeyPatch):
        """最终失败要落 failed 计数并回退原文，不静默留黏连（BR-14）。"""

        async def fake(alias, messages, temperature=None):
            return "totally different words here"

        monkeypatch.setattr(pt, "complete_text", fake)
        src = "one two three four " * 30
        out, stat = self._run(pt.restore_punctuation([src]))
        assert stat["failed"] >= 1 and stat["passed"] == 0
        assert normalize_words(out) == normalize_words(src)  # 原文完整回退

    def test_api_error_does_not_crash(self, monkeypatch: pytest.MonkeyPatch):
        async def fake(alias, messages, temperature=None):
            raise RuntimeError("gateway down")

        monkeypatch.setattr(pt, "complete_text", fake)
        src = "word " * 60
        out, stat = self._run(pt.restore_punctuation([src]))
        assert stat["restored"] is False
        assert normalize_words(out) == normalize_words(src)
