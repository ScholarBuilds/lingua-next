"""每个音位的示范音出处表。

这张表是**实测结果不是推断**：44 条逐个打过 Commons API 验证存在，
命名规律并不自洽，靠猜必错。三个已经踩过的坑写在这里，改表前先看：

1. `/r/` 用 `Alveolar approximant`（不带 Voiced）。带 Voiced 的那个标题会重定向到
   `Voiced alveolar non-sibilant fricative`——是**另一个音**，听上去像德语的 r。
2. `/w/` 用 `labio-velar`（连字符在 labio 后）。`labial-velar` 写法在 Commons 上不存在。
3. `/s/ /z/` 用 `sibilant` 不是 `fricative`。`non-sibilant` 版本是另一个音。

而鼻音、`j`、`l`、`r` 又都**不带** Voiced 前缀，塞音擦音却带——命名不自洽是 Commons
自身的历史遗留，不是这里写错了。

**双元音一个都没有。** Commons 收的是单个音段，`Diphthong *.ogg` 与各种组合式描述
逐个试过全是 missing，分类里搜也只有无关结果。所以这 8 个走 word-clip：
用项目已有的 TTS 合成示范词、已有的强制对齐定位，切出那一段。

其中 `ɪə eə ʊə` 是英音的央化双元音，**美音里根本不存在**（poor 在 GA 读 /pʊr/ 或 /pɔːr/）。
拿默认的 en-US 音色去合成，切出来的不是目标音。这三个必须指定英音，
`clip_accent` 就是为它们存在的——记的是口音要求不是音色 id，
换供应商时由路由层挑各家对应的英音音色。
"""

from __future__ import annotations

from domain.phoneme_audio import AudioSource

CC_BY_SA_3 = "CC BY-SA 3.0"

# 单元音 12：Commons 上这批基本出自同一录音人，音色统一
_VOWELS = {
    "iː": "Close front unrounded vowel.ogg",
    "ɪ": "Near-close near-front unrounded vowel.ogg",
    # 教学写 /e/，RP 的 DRESS 实际更接近 [ɛ]，取 open-mid 才是那个音
    "e": "Open-mid front unrounded vowel.ogg",
    "æ": "Near-open front unrounded vowel.ogg",
    "ʌ": "Open-mid back unrounded vowel.ogg",
    "ɑː": "Open back unrounded vowel.ogg",
    "ɒ": "Open back rounded vowel.ogg",
    "ɔː": "Open-mid back rounded vowel.ogg",
    "ʊ": "Near-close near-back rounded vowel.ogg",
    "uː": "Close back rounded vowel.ogg",
    # 描述页原文标注 [ɜ]；Mid central unrounded vowel 这个标题不存在
    "ɜː": "Open-mid central unrounded vowel.ogg",
    # 连字符在 Mid 后。描述页原文 "Mid central vowel or schwa, [ə]"
    "ə": "Mid-central vowel.ogg",
}

# 辅音 24
_CONSONANTS = {
    "p": "Voiceless bilabial plosive.ogg",
    "b": "Voiced bilabial plosive.ogg",
    "t": "Voiceless alveolar plosive.ogg",
    "d": "Voiced alveolar plosive.ogg",
    "k": "Voiceless velar plosive.ogg",
    "ɡ": "Voiced velar plosive.ogg",
    "f": "Voiceless labiodental fricative.ogg",
    "v": "Voiced labiodental fricative.ogg",
    "θ": "Voiceless dental fricative.ogg",
    "ð": "Voiced dental fricative.ogg",
    "s": "Voiceless alveolar sibilant.ogg",  # 坑 3
    "z": "Voiced alveolar sibilant.ogg",  # 坑 3
    "ʃ": "Voiceless palato-alveolar sibilant.ogg",
    "ʒ": "Voiced palato-alveolar sibilant.ogg",
    "h": "Voiceless glottal fricative.ogg",
    "tʃ": "Voiceless palato-alveolar affricate.ogg",
    "dʒ": "Voiced palato-alveolar affricate.ogg",  # 这条是 Public domain，其余 CC BY-SA 3.0
    "m": "Bilabial nasal.ogg",
    "n": "Alveolar nasal.ogg",
    "ŋ": "Velar nasal.ogg",
    "l": "Alveolar lateral approximant.ogg",
    "r": "Alveolar approximant.ogg",  # 坑 1
    "j": "Palatal approximant.ogg",
    "w": "Voiced labio-velar approximant.ogg",  # 坑 2
}

# 双元音 8：(示范词, 口音要求, 对齐侧的等价写法)
#
# 第三项不是可选优化。对齐器用的是 r 化音素集：tour 对出来是 `ʊɹ`、here 是 `ɪɹ`，
# 而教学侧写的是 `ʊə` `ɪə`——不给等价写法，这三个音位的示范音永远是 503。
_DIPHTHONGS = {
    "eɪ": ("they", "", ()),
    "aɪ": ("high", "", ()),
    "ɔɪ": ("noise", "", ()),
    "əʊ": ("no", "", ("oʊ",)),
    "aʊ": ("now", "", ()),
    # 以下三个是英音的央化双元音，美音里不存在，必须英音合成
    "ɪə": ("here", "en-GB", ("ɪɹ", "ɪr", "ɪə̯")),
    "eə": ("air", "en-GB", ("eɹ", "ɛɹ", "ɛr", "eə̯")),
    "ʊə": ("tour", "en-GB", ("ʊɹ", "ʊr", "ʊə̯")),
}

# 降级切段时的额外要求。**这些是音位自身的属性，不是策略的属性**——
# 首选走 Commons 的音位一旦降级到切段，同样要吃到这些设置。
#
# 由来：对齐器的音素集是固定的（espeak 美音，BR-91 规定评测链路用它），
# 换 TTS 音色不改变它认得哪些符号。于是两类教学符号对不上：
#   ə  → 对齐器一律吐 ɐ（近开央元音），schwa 这个符号它不产出
#   ɒ  → 美音音素集**根本没有这个音**（LOT 并入 ɑ/ɔ），只能认 ɔ；
#        而且必须用英音合成示范词，否则切到的真是美音的 /ɑ/ 不是 /ɒ/
#   ə  → 对齐器一律吐 ɐ；更要命的是**例词全是虚词**（and/of/a/but/from），
#        而 TTS 单独念一个词必然用重读形——and 念成 /ænd/、of 念成 /ʌv/，
#        里头根本没有弱读音。schwa 的定义就是「出现在非重读音节」，
#        所以必须指定一个多音节词，让它落在非重读位上。
_CLIP_TWEAKS: dict[str, dict] = {
    "ə": {"align_alts": ("ɐ",), "clip_word": "about"},
    "ɒ": {"align_alts": ("ɔ",), "clip_accent": "en-GB"},
}


AUDIO_SOURCES: dict[str, AudioSource] = {
    **{
        s: AudioSource("commons", title=t, license=CC_BY_SA_3, **_CLIP_TWEAKS.get(s, {}))
        for s, t in _VOWELS.items()
    },
    **{
        s: AudioSource("commons", title=t, license=CC_BY_SA_3, **_CLIP_TWEAKS.get(s, {}))
        for s, t in _CONSONANTS.items()
    },
    **{
        s: AudioSource("word-clip", clip_word=w, clip_accent=v, align_alts=a)
        for s, (w, v, a) in _DIPHTHONGS.items()
    },
}

# 署名义务：CC BY-SA 3.0 要求署名并链回原页，这行由前端显示，不是可选装饰
COMMONS_CREDIT = "音位示范音 Wikimedia Commons，CC BY-SA 3.0"
