"""视频 v2 加工域测试：难度规则、词组定位（UTF-16）、词级插值、下载错误分型、凭证注册表。"""

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import select

import domain.credentials as credentials
from domain.credentials import PROVIDER_TYPES, SENSITIVE_FIELDS, encrypt_config
from domain.video_enrich import (
    cefr_distribution,
    cefr_level,
    difficulty_stars,
    first_cue_ordinal,
    interpolate_words,
    locate_phrase,
    pick_primary_track,
    tokenize_words,
)
from domain.video_source import build_ytdlp_opts, classify_download_error, format_for_quality

# ---- CEFR 定级与难度星级 ----


def test_cefr_level_by_frq_bounds() -> None:
    assert cefr_level(1, None) == "A1"  # the
    assert cefr_level(1500, None) == "A2"
    assert cefr_level(3000, None) == "B1"
    assert cefr_level(8000, None) == "B2"
    assert cefr_level(16000, None) == "C1"
    assert cefr_level(23199, None) == "C2"  # serendipity


def test_cefr_level_tag_fallback_when_no_frq() -> None:
    # frq=0 为专有名词/缺频次（踩坑索引），退回考纲标签里最低档
    assert cefr_level(0, "zk gk") == "A2"
    assert cefr_level(None, "gre") == "C2"
    assert cefr_level(0, None) is None  # 无频次无标签不定级


def test_cefr_distribution_ignores_unknown() -> None:
    dist = cefr_distribution(["A1", "A1", "B2", None])
    assert dist == {"A1": 0.667, "B2": 0.333}
    assert cefr_distribution([None, None]) == {}


def test_difficulty_stars_vocab_bands() -> None:
    # advanced = B2+C1+C2 占比：<6%→1 <12%→2 <20%→3 <30%→4 其余→5（wpm=150 不修正）
    assert difficulty_stars({"A1": 0.95, "B2": 0.05}, 150) == 1
    assert difficulty_stars({"A1": 0.90, "B2": 0.10}, 150) == 2
    assert difficulty_stars({"A1": 0.85, "C1": 0.15}, 150) == 3
    assert difficulty_stars({"A1": 0.75, "C1": 0.25}, 150) == 4
    assert difficulty_stars({"B2": 0.20, "C1": 0.20}, 150) == 5


def test_difficulty_stars_wpm_adjustment_and_clamp() -> None:
    easy = {"A1": 1.0}
    assert difficulty_stars(easy, 200) == 2  # 快语速 +1
    assert difficulty_stars(easy, 100) == 1  # 慢速 -1 后钳制下限 1
    hard = {"C2": 1.0}
    assert difficulty_stars(hard, 200) == 5  # 上限钳制 5
    assert difficulty_stars(hard, 90) == 4  # 慢速 -1
    assert difficulty_stars(easy, 0) == 1  # 无时长不做慢速修正


def test_tokenize_words_keeps_apostrophe_and_hyphen() -> None:
    assert tokenize_words("It's a well-known fact!") == ["it's", "a", "well-known", "fact"]


# ---- 词组定位（UTF-16 码元区间） ----


def test_locate_phrase_basic_and_case_insensitive() -> None:
    assert locate_phrase("We need to figure out the plan", "Figure Out") == (11, 21)
    assert locate_phrase("hello world", "absent") is None
    assert locate_phrase("hello", "  ") is None


def test_locate_phrase_utf16_offset_after_non_bmp() -> None:
    # 😀 是增补平面字符，UTF-16 占 2 码元：词组起点应比 Python 字符索引大 1
    text = "😀 give up now"
    span = locate_phrase(text, "give up")
    assert span == (3, 10)


# ---- 词级时间戳插值 ----


def test_interpolate_words_covers_span_monotonically() -> None:
    words = interpolate_words("hello brave new world", 1000, 3000)
    assert [w[2] for w in words] == ["hello", "brave", "new", "world"]
    assert words[0][0] == 1000
    assert words[-1][1] == 3000
    for (s1, e1, _), (s2, _e2, _) in zip(words, words[1:], strict=False):
        assert s1 < e1
        assert e1 == s2  # 首尾相接不留缝


def test_interpolate_words_weights_by_char_length() -> None:
    words = interpolate_words("a extraordinarily", 0, 1800)
    # 短词 "a" 的时长应显著小于长词
    assert (words[0][1] - words[0][0]) < (words[1][1] - words[1][0])


def test_interpolate_words_empty_or_invalid_span() -> None:
    assert interpolate_words("", 0, 1000) == []
    assert interpolate_words("hi", 500, 500) == []


# ---- 重点词出处定位 ----


def test_first_cue_ordinal_exact_then_inflection() -> None:
    cues = [(0, "She was running fast"), (1, "I run every day")]
    assert first_cue_ordinal(cues, "run") == 1  # 词边界精确命中优先
    assert first_cue_ordinal([(2, "He studies hard")], "study") == 2  # 屈折形前缀兜底
    assert first_cue_ordinal(cues, "absent") is None


# ---- 主轨选择 ----


class _T:
    def __init__(self, tid: int, kind: str, lang: str, is_default: bool = False) -> None:
        self.id, self.kind, self.lang, self.is_default = tid, kind, lang, is_default


def test_pick_primary_track_prefers_default_then_kind() -> None:
    tracks = [
        _T(1, "translation", "zh"),
        _T(2, "auto", "en"),
        _T(3, "whisper", "en"),
        _T(4, "official", "en"),
    ]
    assert pick_primary_track(tracks).id == 4  # official 优先
    tracks[2].is_default = True
    assert pick_primary_track(tracks).id == 3  # 默认轨压过 kind 排序
    assert pick_primary_track([_T(9, "translation", "zh")]) is None  # 只有翻译轨不可用


# ---- 下载错误分型（FR-22） ----


def test_classify_download_error_bot_check() -> None:
    msg = "ERROR: [youtube] jNQXAC9IVRw: Sign in to confirm you're not a bot."
    assert classify_download_error(msg) == "bot_check"
    assert classify_download_error("This is a private video") == "bot_check"


def test_classify_download_error_network_and_other() -> None:
    assert classify_download_error("urlopen error [Errno 60] timed out") == "network"
    assert classify_download_error("Unable to download webpage") == "network"
    assert classify_download_error("Postprocessing: ffmpeg exited with code 1") == "other"


# ---- yt-dlp 参数构造与画质 ----


def test_format_for_quality_defaults_and_max() -> None:
    assert "[height<=1080]" in format_for_quality(None)
    assert "[height<=720]" in format_for_quality("720")
    assert format_for_quality("max") == "bv*+ba/b"
    assert "[height<=1080]" in format_for_quality("weird")  # 非法值回落默认


def test_build_ytdlp_opts_cookies_text_tempfile(tmp_path) -> None:
    opts, cookie_path = build_ytdlp_opts({"cookies_text": "# Netscape HTTP Cookie File"})
    try:
        assert opts["cookiefile"] == cookie_path
        with open(cookie_path, encoding="utf-8") as f:
            assert f.read().startswith("# Netscape")
    finally:
        import os

        os.unlink(cookie_path)


def test_build_ytdlp_opts_browser_and_proxy() -> None:
    opts, cookie_path = build_ytdlp_opts(
        {"cookies_browser": "Chrome", "proxy": "http://127.0.0.1:7890"}
    )
    assert cookie_path is None
    assert opts["cookiesfrombrowser"] == ("chrome",)
    assert opts["proxy"] == "http://127.0.0.1:7890"
    with pytest.raises(ValueError, match="不支持的浏览器"):
        build_ytdlp_opts({"cookies_browser": "opera"})


# ---- YouTube 凭证类型注册表（FR-21） ----


def test_youtube_provider_registered_as_video_source() -> None:
    spec = PROVIDER_TYPES["youtube"]
    assert spec["kind"] == "video_source"
    names = [f["name"] for f in spec["fields"]]
    # data_api_key 为 v5 新增的可选加速项（FR-56），下载能力不依赖它
    assert names == ["cookies_text", "cookies_browser", "quality", "data_api_key"]
    assert "网络与代理" in spec["notes"]
    assert all(not f["required"] for f in spec["fields"])  # 全部可选（不配=无凭证默认）
    cookies_field = spec["fields"][0]
    assert cookies_field["type"] == "password"  # 敏感字段走密文输入


def test_cookies_text_is_sensitive_and_encrypted(monkeypatch) -> None:
    assert "cookies_text" in SENSITIVE_FIELDS

    class _FakeSettings:
        config_key = Fernet.generate_key().decode()

    monkeypatch.setattr(credentials, "get_settings", lambda: _FakeSettings())
    stored = encrypt_config({"cookies_text": "secret-cookie-line", "proxy": "http://p"})
    assert stored["cookies_text"].startswith("enc:")  # cookies 密文入库（BR）
    assert stored["proxy"] == "http://p"  # 非敏感字段原样


# ---- 词卡出处：统一到学习句编号（GET /videos/{id}/vocab） ----
#
# 词卡的 cue_ordinal 曾经存源字幕行 SubtitleCue.ordinal，而前端拿它去 StudyUnit
# 数组里查——两套编号完全不同（实测 video 28：cue 424 条、学习句 685 条），
# 36 张卡只有 10 张的词真在所显示的句子里。

_VOCAB_CUES = [
    "The tube carries water underground.",
    "Engineers rebuilt the aqueduct last winter.",
    "Nobody noticed the serendipity of that timing.",
]


async def _seed_vocab_video(session, items: list[dict], *, extra_track: bool = False):
    """建视频 + 主轨（cue / 句 / 学习句齐全）并落一份 video_vocab 结果。"""
    from domain.analysis import content_key, save_result
    from domain.models import StudyUnit, SubtitleCue, SubtitleSentence, SubtitleTrack, Video

    video = Video(title="Vocab fixture", status="ready")
    session.add(video)
    await session.flush()
    track = SubtitleTrack(
        video_id=video.id, kind="whisper", lang="en", label="en · whisper", is_default=True
    )
    session.add(track)
    await session.flush()

    # 源字幕行与学习句刻意错位：每条 cue 切成两条学习句，两套编号必然对不上
    for ordinal, text in enumerate(_VOCAB_CUES):
        session.add(
            SubtitleCue(
                track_id=track.id, ordinal=ordinal, start_ms=ordinal * 4000,
                end_ms=ordinal * 4000 + 3800, text=text, content_hash=f"c{ordinal}",
            )
        )
    unit_ordinal = 0
    for ordinal, text in enumerate(_VOCAB_CUES):
        sentence = SubtitleSentence(
            track_id=track.id, ordinal=ordinal, start_ms=ordinal * 4000,
            end_ms=ordinal * 4000 + 3800, text=text, content_hash=f"s{ordinal}",
        )
        session.add(sentence)
        await session.flush()
        head, tail = text.split(" ", 1)
        for piece in (head, tail):
            session.add(
                StudyUnit(
                    sentence_id=sentence.id, track_id=track.id, ordinal=unit_ordinal,
                    start_ms=ordinal * 4000, end_ms=ordinal * 4000 + 3800, text=piece,
                    char_start=0, char_end=len(piece), content_hash=f"u{unit_ordinal}",
                )
            )
            unit_ordinal += 1

    second_id = None
    if extra_track:
        other = SubtitleTrack(
            video_id=video.id, kind="official", lang="en", label="en · 官方", is_default=False
        )
        session.add(other)
        await session.flush()
        second_id = other.id
        other_texts = ["A completely different narration line.", "It mentions volcanoes only."]
        for ordinal, text in enumerate(other_texts):
            session.add(
                SubtitleCue(
                    track_id=other.id, ordinal=ordinal, start_ms=ordinal * 5000,
                    end_ms=ordinal * 5000 + 4800, text=text, content_hash=f"oc{ordinal}",
                )
            )
            sentence = SubtitleSentence(
                track_id=other.id, ordinal=ordinal, start_ms=ordinal * 5000,
                end_ms=ordinal * 5000 + 4800, text=text, content_hash=f"os{ordinal}",
            )
            session.add(sentence)
            await session.flush()
            session.add(
                StudyUnit(
                    sentence_id=sentence.id, track_id=other.id, ordinal=ordinal,
                    start_ms=ordinal * 5000, end_ms=ordinal * 5000 + 4800, text=text,
                    char_start=0, char_end=len(text), content_hash=f"ou{ordinal}",
                )
            )
        await save_result(
            session, "document", content_key("\n".join(other_texts)), "", "video_vocab", "llm",
            result={"items": [{"word": "volcanoes", "meaning_zh": "火山", "cue_ordinal": 1}]},
            model="probe",
        )

    await save_result(
        session, "document", content_key("\n".join(_VOCAB_CUES)), "", "video_vocab", "llm",
        result={"items": items}, model="probe",
    )
    await session.commit()
    return video.id, track.id, second_id


async def test_enriched_vocab_ordinal_points_at_a_unit_containing_the_word(
    session, session_factory, monkeypatch
) -> None:
    """跑一遍 _enrich_vocab：落库的 cue_ordinal 指的学习句里必须真有那个词。

    LLM 打桩，只验证服务端回查定位那一段——出处从来不信模型给的编号。
    """
    import worker.tasks as tasks
    from domain.analysis import content_key, get_cached
    from domain.models import StudyUnit, SubtitleCue
    from domain.video_enrich import contains_word

    video_id, track_id, _ = await _seed_vocab_video(session, [])
    monkeypatch.setattr(tasks, "SessionFactory", session_factory)

    async def _fake_llm(_capabilities, _system, _user):
        return (
            {
                "items": [
                    {"word": "aqueduct", "meaning_zh": "引水渠", "level": "C1"},
                    {"word": "serendipity", "meaning_zh": "机缘巧合", "level": "C2"},
                    {"word": "underground", "meaning_zh": "地下的", "level": "B1"},
                ]
            },
            "stub-model",
        )

    monkeypatch.setattr(tasks, "_llm_json", _fake_llm)

    cues = list(
        (
            await session.execute(
                select(SubtitleCue)
                .where(SubtitleCue.track_id == track_id)
                .order_by(SubtitleCue.ordinal)
            )
        ).scalars()
    )
    stat = await tasks._enrich_vocab(video_id, track_id, cues, force=True)
    assert stat["items"] == 3

    rows = (
        await session.execute(
            select(StudyUnit.ordinal, StudyUnit.text).where(StudyUnit.track_id == track_id)
        )
    ).all()
    by_ordinal = {r[0]: r[1] for r in rows}
    row = await get_cached(
        session, "document", content_key("\n".join(_VOCAB_CUES)), "", "video_vocab", "llm"
    )
    assert row is not None
    for item in row.result["items"]:
        text = by_ordinal.get(item["cue_ordinal"])
        assert text is not None, f"{item['word']} 的出处不是学习句序号"
        assert contains_word(text, item["word"]), f"{item['word']} 不在 “{text}” 里"


async def test_vocab_api_heals_legacy_cue_ordinals(client, session) -> None:
    """存量行存的是源字幕行编号，读接口要现场改对并回写。"""
    legacy = [
        {"word": "aqueduct", "meaning_zh": "引水渠", "cue_ordinal": 1, "level": "C1"},
        {"word": "serendipity", "meaning_zh": "机缘巧合", "cue_ordinal": 2, "level": "C2"},
    ]
    video_id, track_id, _ = await _seed_vocab_video(session, legacy)

    resp = await client.get(f"/videos/{video_id}/vocab")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["track_id"] == track_id

    from domain.models import StudyUnit
    from domain.video_enrich import contains_word

    rows = (
        await session.execute(
            select(StudyUnit.ordinal, StudyUnit.text).where(StudyUnit.track_id == track_id)
        )
    ).all()
    by_ordinal = {r[0]: r[1] for r in rows}
    for item in body["items"]:
        text = by_ordinal.get(item["cue_ordinal"])
        assert text is not None, f"{item['word']} 的出处指向不存在的学习句"
        assert contains_word(text, item["word"]), f"{item['word']} 不在 “{text}” 里"

    # 顺手回写：库里存的也换成了新编号，用户不必重跑 AI 加工
    from domain.analysis import content_key, get_cached

    stored = await get_cached(
        session, "document", content_key("\n".join(_VOCAB_CUES)), "", "video_vocab", "llm"
    )
    assert stored is not None
    assert [i["cue_ordinal"] for i in stored.result["items"]] == [
        i["cue_ordinal"] for i in body["items"]
    ]
    assert [i["cue_ordinal"] for i in stored.result["items"]] != [1, 2]

    again = await client.get(f"/videos/{video_id}/vocab")
    assert [i["cue_ordinal"] for i in again.json()["items"]] == [
        i["cue_ordinal"] for i in body["items"]
    ]


async def test_vocab_api_follows_track_id_query(client, session) -> None:
    """用户换了字幕轨，词卡要跟着换；不传时维持主轨行为。"""
    video_id, primary_id, other_id = await _seed_vocab_video(
        session,
        [{"word": "aqueduct", "meaning_zh": "引水渠", "cue_ordinal": 1}],
        extra_track=True,
    )

    default = await client.get(f"/videos/{video_id}/vocab")
    assert default.status_code == 200
    assert default.json()["track_id"] == primary_id
    assert [i["word"] for i in default.json()["items"]] == ["aqueduct"]

    switched = await client.get(f"/videos/{video_id}/vocab", params={"track_id": other_id})
    assert switched.status_code == 200, switched.text
    assert switched.json()["track_id"] == other_id
    assert [i["word"] for i in switched.json()["items"]] == ["volcanoes"]

    missing = await client.get(f"/videos/{video_id}/vocab", params={"track_id": 999_999})
    assert missing.status_code == 404


async def test_contains_word_matches_first_cue_ordinal_semantics() -> None:
    """自愈判据与定位判据必须同源，否则会把对的行判成错的、反复回写。"""
    from domain.video_enrich import contains_word

    assert contains_word("I run every day", "run")
    assert contains_word("He studies hard", "study")  # 屈折形前缀兜底
    assert not contains_word("Nothing relevant here", "aqueduct")
    assert not contains_word("", "run")
