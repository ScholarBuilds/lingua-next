"""音标数据地基与发音评测（模块 13）。

三组：记法转换（`domain/phonetics`）、音位卡片内容自洽（`domain/phoneme_cards`）、
发音评测第 0 层的确定性算法（`domain/pronunciation`）。

评测的第 1/2 层要加载 318MB 的 ONNX 模型，不在单测里跑——
那属于「能跑通」而不是「算得对」，由 `calibrate_pronunciation.py` 用真语料回归。
"""

import pytest

from domain import pronunciation as pron
from domain.phoneme_cards import ALL_CARDS, CONSONANTS, CONTRAST_GROUPS, VOWELS
from domain.phonetics import (
    arpabet_to_ipa,
    clean_ipa,
    first_pron,
    ipa_symbols,
    normalize_word,
    parse_arpabet,
    stress_pattern,
    strip_stress,
    syllable_count,
)

# ────────────────────────────── 记法转换 ──────────────────────────────


@pytest.mark.parametrize(
    ("arpabet", "teach", "us"),
    [
        ("SH IH1 P", "ˈʃɪp", "ˈʃɪp"),
        ("SH IY1 P", "ˈʃiːp", "ˈʃip"),
        ("K AH1 P", "ˈkʌp", "ˈkʌp"),
        ("B ER1 D", "ˈbɜːd", "ˈbɝd"),
        # AH0 是 schwa 不是 ʌ、ER0 是弱读不是 ɜː：不分开处理就会把
        # information 转成 ˌɪnfɜːˈmeɪʃʌn（首版的真实错误）
        ("IH2 N F ER0 M EY1 SH AH0 N", "ˌɪnfəˈmeɪʃən", "ˌɪnfɚˈmeɪʃən"),
        # happy tensing：词尾 -y 是短促的 /i/，写成 /iː/ 会把 thickly 标错
        ("TH IH1 K L IY0", "ˈθɪkli", "ˈθɪkli"),
    ],
)
def test_arpabet_to_ipa(arpabet: str, teach: str, us: str):
    phones = parse_arpabet(arpabet)
    assert arpabet_to_ipa(phones, teach=True) == teach
    assert arpabet_to_ipa(phones) == us


def test_syllables_and_stress():
    phones = parse_arpabet("IH2 N F ER0 M EY1 SH AH0 N")
    assert syllable_count(phones) == 4
    assert stress_pattern(phones) == "2010"


def test_strip_stress():
    assert strip_stress("AA1") == "AA"
    assert strip_stress("NG") == "NG"


def test_ipa_symbols_keeps_digraphs_whole():
    """tʃ / aɪ / iː 是一个音位，拆开点击就会点出不存在的音。"""
    assert ipa_symbols("ˈtʃiːp") == ["tʃ", "iː", "p"]
    assert ipa_symbols("ˌɪnfəˈmeɪʃən") == ["ɪ", "n", "f", "ə", "m", "eɪ", "ʃ", "ə", "n"]


def test_clean_ipa_fixes_cyrillic_and_dj_marks():
    """ECDICT 里 28% 的音标把 ə 写成西里尔 ә；这几条替换是无损的。"""
    assert clean_ipa("/ˈwɜ:kә/") == "ˈwɜːkə"
    assert clean_ipa("'ʃip") == "ˈʃip"
    assert clean_ipa(None) is None
    assert clean_ipa("  ") is None


def test_clean_ipa_leaves_dj_vowels_alone():
    """DJ 元音体系 → IPA 有歧义（in 的 i 是 ɪ、bi: 的 i 是 iː），一律不碰。"""
    assert "ɪ" not in (clean_ipa("/in/") or "")


def test_first_pron_takes_the_main_reading():
    assert first_pron("/ˈɹɛkɚd/, /ɹɪˈkɔɹd/") == "ˈɹɛkɚd"


def test_normalize_word_drops_cmudict_variant_suffix():
    assert normalize_word("READ(2)") == "read"


# ────────────────────────────── 音位卡片 ──────────────────────────────


def test_44_phonemes():
    assert len(VOWELS) == 20
    assert len(CONSONANTS) == 24
    assert len(ALL_CARDS) == 44


def test_symbols_are_unique():
    assert len({c.symbol for c in ALL_CARDS}) == 44


def test_vowels_have_chart_positions_consonants_do_not():
    """元音用四边形定位、辅音用剖面图，两者不混（FR-392d）。"""
    for v in VOWELS:
        assert v.chart is not None, v.symbol
    for c in CONSONANTS:
        assert c.chart is None, c.symbol


def test_no_two_vowels_share_a_chart_position():
    """坐标撞车会让一个格子把另一个盖死——首版 ɜː 与 ə 就差 0.05 全糊在一起。"""
    seen: dict[tuple[float, float], str] = {}
    for v in VOWELS:
        pos = v.chart
        assert pos is not None
        key = (round(pos[0], 2), round(pos[1], 2))
        # 单元音与双元音分图渲染，只需各自组内不撞
        group = "diph" if v.chart_to else "mono"
        tag = f"{group}:{key}"
        assert tag not in seen, f"{v.symbol} 与 {seen[tag]} 坐标相同"
        seen[tag] = v.symbol


def test_diphthongs_have_a_glide_target():
    for v in VOWELS:
        if v.manner == "diphthong":
            assert v.chart_to is not None, v.symbol
        else:
            assert v.chart_to is None, v.symbol


def test_every_card_has_teaching_content():
    for c in ALL_CARDS:
        assert c.zh_name and c.tips, c.symbol
        assert c.common_errors, c.symbol
        assert c.svg_frames, c.symbol


def test_contrast_groups_reference_real_arpabet():
    valid = {c.arpabet.split()[0] for c in ALL_CARDS}
    for g in CONTRAST_GROUPS:
        assert g["a"] in valid, g["key"]
        assert g["b"] in valid, g["key"]


# ────────────────────────────── 评测第 0 层 ──────────────────────────────


def test_completeness_all_read():
    diff = {"total": 5, "extra": 0, "items": [{"status": "ok"}] * 5}
    assert pron.completeness_score(diff) == 100.0


def test_completeness_counts_missed_words():
    diff = {"total": 4, "extra": 0, "items": [{"status": "ok"}] * 3 + [{"status": "miss"}]}
    assert pron.completeness_score(diff) == 75.0


def test_completeness_penalizes_extra_words():
    diff = {"total": 4, "extra": 2, "items": [{"status": "ok"}] * 4}
    assert pron.completeness_score(diff) == 75.0


def test_completeness_of_empty_is_zero_not_crash():
    assert pron.completeness_score({}) == 0.0


def test_confidence_maps_ctc_score_into_0_100():
    """两个锚点来自实测：对齐正确文本均值 −0.661、对齐无关文本 −1.825。"""
    assert pron.confidence_from_ctc(0.0) == 100.0
    assert pron.confidence_from_ctc(-3.0) == 0.0
    mid = pron.confidence_from_ctc(-1.1)
    assert 0 < mid < 100


def test_word_score_normalizes_by_frames():
    """BR-92：raw_score 是区间求和，长词天然高，不归一化就没法横向比。"""
    diff = {"total": 2, "extra": 0, "items": [{"status": "ok"}, {"status": "ok"}]}
    aligned = [
        # 长词：原始分是短词的 5 倍，但每帧质量一样
        {"text": "responsibility", "start": 0.0, "end": 1.0, "score": -5.0, "frames": 50},
        {"text": "it", "start": 1.2, "end": 1.4, "score": -1.0, "frames": 10},
    ]
    a = pron.assess_layer0(diff, aligned, "responsibility it")
    assert a.words[0].norm_score == pytest.approx(a.words[1].norm_score)
    assert a.words[0].confidence == a.words[1].confidence


def test_fluency_flags_unexpected_break():
    """名词短语中间的长停顿是 UnexpectedBreak。"""
    words = [(0.0, 0.4), (1.5, 1.9), (2.0, 2.4)]
    score, events = pron.fluency_score(words, ["the", "big", "cat"], "the big cat")
    assert any(e.kind == "UnexpectedBreak" for e in events)
    assert score < 100


def test_fluency_allows_break_at_clause_boundary():
    """逗号处停顿是正常的，不该扣分。"""
    words = [(0.0, 0.4), (0.5, 0.9), (1.6, 2.0), (2.1, 2.5)]
    score, events = pron.fluency_score(
        words, ["I", "went,", "he", "stayed"], "I went, he stayed."
    )
    assert not any(e.kind == "UnexpectedBreak" for e in events)
    assert score >= 60


def test_fluency_of_single_word_is_full():
    assert pron.fluency_score([(0.0, 0.5)], ["hi"], "hi")[0] == 100.0


def test_layer0_without_alignment_still_gives_completeness():
    """对齐失败不该让整份诊断作废——完整度是纯文本比对得来的。"""
    diff = {"total": 3, "extra": 0, "items": [{"status": "ok"}] * 2 + [{"status": "miss"}]}
    a = pron.assess_layer0(diff, [], "a b c")
    assert a.completeness == pytest.approx(66.7, abs=0.1)
    assert a.words == []
    assert a.notes and "词级时间戳" in a.notes[0]


def test_assessment_serializes_the_layer0_shape():
    """音素层 2026-08-30 下线后 phonemes / layer / gop / accuracy_source 四个键一并去掉。

    留着永远为空的键比去掉更糟：前端会为一个永不出现的分支保留 UI，
    而读接口的人以为那一层还在、只是这次没触发。
    """
    a = pron.assess_layer0({"total": 1, "extra": 0, "items": [{"status": "ok"}]}, [], "hi")
    assert set(a.to_dict()) == {"completeness", "fluency", "accuracy", "words", "breaks", "notes"}


# ────────────────────────────── 评测落库契约 ──────────────────────────────


def test_落库字段与_assess_输出的键一一对应():
    """写入侧按键名从 `assess_full()` 的结果里取值，读出侧再拼回去。

    音素层下线时 `to_dict()` 少了 phonemes / layer / gop / accuracy_source 四个键，
    而 `shadowing.py` 的写入侧还在 `result["phonemes"]`——**这是个 KeyError**，
    整个 `/shadow/{id}/assess` 当场 500，而当时删掉的恰好是唯一覆盖这条路径的用例。
    这条守着：模型上有的列，评测结果里必须有同名键；反过来不要求
    （notes 只回给前端不落库）。
    """
    from domain.models import PronunciationAssessment

    diff = {"total": 1, "extra": 0, "items": [{"status": "ok"}]}
    produced = set(pron.assess_layer0(diff, [], "hi").to_dict())
    persisted = {
        c.name
        for c in PronunciationAssessment.__table__.columns
        if c.name not in {"id", "recording_id", "created_at"}
    }
    assert persisted <= produced, f"这些列没有对应的评测输出键：{persisted - produced}"
