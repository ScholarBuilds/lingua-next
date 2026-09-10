"""音位示范音的取源逻辑。

这一族守的是同一条规则：**点音标要发那个音标的音**。它失效的方式都很安静——
匹配不上就是个哑按钮，切错一段就是放了别的音，两种在页面上都不报错。
"""

from __future__ import annotations

import pytest

from domain.phoneme_audio import cache_paths, match_phone
from domain.phoneme_audio_sources import AUDIO_SOURCES

# think = /θɪŋk/
THINK = [
    {"phone": "θ", "start": 0.28, "end": 0.42},
    {"phone": "ɪ", "start": 0.42, "end": 0.50},
    {"phone": "ŋ", "start": 0.50, "end": 0.60},
    {"phone": "k", "start": 0.60, "end": 0.72},
]


class TestMatchPhone:
    def test_严格命中(self):
        assert match_phone(THINK, "θ")["start"] == 0.28

    def test_找不到返回_None_而不是最接近的一段(self):
        # 放错一段音比不放更糟：学习者不会怀疑自己听到的是别的音
        assert match_phone(THINK, "z") is None

    def test_长音符对不上时退到宽松匹配(self):
        # 教学写 /iː/，对齐常吐 /i/；只做严格匹配会让长元音整类切不出来
        assert match_phone([{"phone": "i", "start": 0.1, "end": 0.3}], "iː") is not None

    def test_重音标记不影响(self):
        assert match_phone([{"phone": "ˈæ", "start": 0.2, "end": 0.4}], "æ") is not None

    @pytest.mark.parametrize(
        ("symbol", "aligned"),
        [("ʊə", "ʊɹ"), ("ɪə", "ɪɹ"), ("eə", "ɛɹ"), ("əʊ", "oʊ")],
    )
    def test_r_化写法算等价(self, symbol: str, aligned: str):
        """对齐用 r 化音素集：tour 对出来是 ʊɹ 不是教学写的 ʊə。

        不认这组等价写法，三个央化双元音的示范音永远是 503——
        这正是实测踩到的那一刀。
        """
        timings = [{"phone": aligned, "start": 0.1, "end": 0.4}]
        alts = AUDIO_SOURCES[symbol].align_alts
        assert match_phone(timings, symbol, alts) is not None
        # 反面：不给等价写法就该匹配不上，证明这条测试不是自动通过的
        assert match_phone(timings, symbol) is None

    def test_严格匹配优先于等价写法(self):
        """两种写法都在场时取严格的那个，否则会切到邻近的音段。"""
        timings = [
            {"phone": "ʊɹ", "start": 0.1, "end": 0.2},
            {"phone": "ʊə", "start": 0.5, "end": 0.7},
        ]
        hit = match_phone(timings, "ʊə", AUDIO_SOURCES["ʊə"].align_alts)
        assert hit["start"] == 0.5

    def test_空时间戳不炸(self):
        assert match_phone([], "θ") is None


class TestCachePaths:
    def test_按符号哈希而不是符号本身命名(self):
        """θ / ʃ / ɡ 在不同文件系统上的规范化形式不一致（macOS 会做 NFD 分解），
        直接拿符号当文件名会落成两份缓存、或者读的时候找不着。"""
        mp3, meta = cache_paths("/tmp/m", "θ")
        assert "θ" not in mp3.name
        assert mp3.stem == meta.stem
        assert (mp3.suffix, meta.suffix) == (".mp3", ".json")

    def test_不同符号不撞车(self):
        names = {cache_paths("/tmp/m", s)[0].name for s in AUDIO_SOURCES}
        assert len(names) == len(AUDIO_SOURCES)


class TestSources:
    def test_覆盖全部_44_个音位(self):
        from domain.phoneme_cards import CONSONANTS, VOWELS

        declared = {c.symbol for c in [*VOWELS, *CONSONANTS]}
        assert declared == set(AUDIO_SOURCES), declared ^ set(AUDIO_SOURCES)

    def test_commons_条目有标题_word_clip_条目有示范词(self):
        for symbol, src in AUDIO_SOURCES.items():
            if src.strategy == "commons":
                assert src.title, f"{symbol} 缺 Commons 标题"
                assert src.title.endswith(".ogg"), f"{symbol} 标题不像文件名"
            else:
                assert src.clip_word, f"{symbol} 缺示范词"

    def test_双元音一律走_word_clip(self):
        """Commons 收的是单个音段，没有滑动音。逐个试过组合式标题全是 missing。"""
        for symbol, src in AUDIO_SOURCES.items():
            if len(symbol.replace("ː", "")) > 1 and symbol not in ("tʃ", "dʒ"):
                assert src.strategy == "word-clip", f"{symbol} 不该走 Commons"

    def test_央化双元音必须要求英音(self):
        """ɪə eə ʊə 在美音里不存在，默认美音音色合成出来切到的不是目标音。"""
        for symbol in ("ɪə", "eə", "ʊə"):
            assert AUDIO_SOURCES[symbol].clip_accent == "en-GB", symbol

    def test_口音记的是要求不是音色_id(self):
        """音色 id 是各家专有的（Edge 与火山写法完全不同）。表里写死任何一家，
        换供应商时这三个音位就悄悄退回美音——错得没有任何迹象。"""
        for src in AUDIO_SOURCES.values():
            assert src.clip_accent in ("", "en-GB"), src.clip_accent


class TestClipTweaks:
    """对齐器的音素集是固定的（espeak 美音），有些教学符号它根本不产出。
    这一族守的是那几个必须显式配等价写法的音位——配漏了就是个哑按钮，不报错。"""

    def test_schwa_认_ɐ_且用多音节词(self):
        """两件事同时成立才切得出 schwa：
        ① 对齐器一律吐 ɐ 不吐 ə；
        ② 例词全是虚词，而 TTS 单念虚词用重读形（and→/ænd/），里头没有弱读音。
        所以必须指定一个多音节词让它落在非重读位上。"""
        src = AUDIO_SOURCES["ə"]
        assert "ɐ" in src.align_alts
        assert len(src.clip_word) > 3, "虚词切不出 schwa，要多音节词"

    def test_lot_元音认_ɔ_且要英音(self):
        """美音音素集里没有 /ɒ/（LOT 并入 ɑ/ɔ）。只认 ɔ 还不够——
        示范词也必须用英音合成，否则切到的真是美音的 /ɑ/。"""
        src = AUDIO_SOURCES["ɒ"]
        assert "ɔ" in src.align_alts
        assert src.clip_accent == "en-GB"


class TestDemoVoiceRouting:
    def test_每家都配了英音音色(self):
        """clip_accent="en-GB" 是硬要求；某一家在表里缺英音，
        那家的用户拿到的就是错的音，必须显式兜住。"""
        from app.routers.phonetics import GB_VOICE

        assert set(GB_VOICE) >= {"edge-tts", "volcengine"}
        assert all(v for v in GB_VOICE.values())
