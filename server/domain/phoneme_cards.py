"""44 个英语音位的教学内容（FR-392a）。

这份表只写**教学事实**：发音部位、发音方法、中国学习者常见错读、剖面图帧、
元音四边形坐标。**例词不写在这里**——它按音素在词中的位置从 CMUdict + 词频现算
（FR-392g），凭印象写例词容易出现「这个音其实不在词首」的错。

剖面图取自 [drammock/phonetics-teaching-assets](https://github.com/drammock/phonetics-teaching-assets)
（CC0-1.0，公共领域，无署名义务）。该库缺 /l/ /w/ /tʃ/ /dʒ/ /h/ /j/，
处理方式见 `SVG_NOTES`——不自绘，而是用同一套资产里发音姿势等价的图组合表达。
"""

from __future__ import annotations

from dataclasses import dataclass, field

# 缺图音位的替代方案：都用同库已有资产，避免自绘出比例不一致的图
SVG_NOTES = {
    "l": "用 /n/ 的舌位图（同为舌尖抵齿龈），另配文字说明气流从舌两侧出",
    "w": "用元音 /u/ 的图（双唇圆拢 + 舌后高，与 /w/ 的起始姿势相同）",
    "j": "用元音 /i/ 的图（舌前高，与 /j/ 的起始姿势相同）",
    "tʃ": "两帧离散切换：/t/ 成阻 → /ʃ/ 除阻",
    "dʒ": "两帧离散切换：/d/ 成阻 → /ʒ/ 除阻",
    "h": "用中性舌位图（声门摩擦不改变口腔形状）",
}


@dataclass(frozen=True)
class PhonemeCard:
    symbol: str  # 教学 IPA（RP）
    symbol_us: str  # 美音变体
    arpabet: str  # CMUdict 音素，用于取例词与查难度
    kind: str  # vowel | consonant
    manner: str
    place: str
    voiced: bool
    zh_name: str
    tips: str
    common_errors: list[str]
    svg_frames: list[dict] = field(default_factory=list)
    chart: tuple[float, float] | None = None
    chart_to: tuple[float, float] | None = None
    highlight: list[str] = field(default_factory=list)
    contrast_with: list[str] = field(default_factory=list)


def _f(key: str, label: str) -> dict:
    return {"key": key, "label": label}


# ──────────────────────────── 元音 20 ────────────────────────────
# chart 坐标：x 0=前 1=后，y 0=闭 1=开。按 IPA 官方元音四边形排布（FR-392b）。

VOWELS: list[PhonemeCard] = [
    PhonemeCard(
        "iː", "i", "IY", "vowel", "monophthong", "前高·长", True, "长音 i",
        "舌前部抬高接近硬腭，嘴角向两边展开，音要拖足。",
        ["与 /ɪ/ 不分，把 sheep 读成 ship", "长度不够，听感变成短音"],
        [_f("vowel-i", "舌前高、双唇平展")], (0.05, 0.05), None,
        ["tongue"], ["ɪ"],
    ),
    PhonemeCard(
        "ɪ", "ɪ", "IH", "vowel", "monophthong", "前次高·短", True, "短音 i",
        "舌位比 /iː/ 略低略后，嘴唇放松，短促带过。",
        ["读成 /iː/，ship 听成 sheep", "嘴角过度用力，把短音拖长"],
        [_f("vowel-i", "舌位略低于 /iː/，唇形放松")], (0.20, 0.22), None,
        ["tongue"], ["iː"],
    ),
    PhonemeCard(
        "e", "ɛ", "EH", "vowel", "monophthong", "前中·短", True, "短音 e",
        "口张开约两指宽，舌前部处于中高位置。",
        ["与 /æ/ 混，bed 与 bad 不分"],
        [_f("neutral", "口半开、舌前中位")], (0.15, 0.45), None,
        ["tongue"], ["æ"],
    ),
    PhonemeCard(
        "æ", "æ", "AE", "vowel", "monophthong", "前低·短", True, "梅花音",
        "下巴放低、口张大，舌前部低平，听感接近汉语「哎」但更扁更靠前。",
        ["读成 /e/，bad 听成 bed", "读成汉语「艾」，滑成双元音"],
        [_f("neutral", "下巴放低、口张大")], (0.13, 0.85), None,
        ["tongue"], ["e", "ʌ"],
    ),
    PhonemeCard(
        "ʌ", "ʌ", "AH", "vowel", "monophthong", "央次低·短", True, "短音 u",
        "口略张，舌位居中偏后偏低，肌肉放松，短促。",
        ["读成汉语「阿」偏后", "与 /æ/ 混，cup 与 cap 不分"],
        [_f("neutral", "舌位居中、肌肉放松")], (0.60, 0.70), None,
        ["tongue"], ["æ", "ɑː"],
    ),
    PhonemeCard(
        "ɑː", "ɑ", "AA", "vowel", "monophthong", "后低·长", True, "长音 a",
        "口张到最大，舌身后缩压低，音拖足。",
        ["长度不够，与 /ʌ/ 混（cart 听成 cut）"],
        [_f("neutral", "口张最大、舌后缩")], (0.78, 0.95), None,
        ["tongue"], ["ʌ"],
    ),
    PhonemeCard(
        "ɒ", "ɑ", "AA", "vowel", "monophthong", "后低·短·圆唇", True, "短音 o",
        "双唇稍圆，口张开，舌后部低。美音里这个音多并入 /ɑː/。",
        ["读成 /ɔː/，把 not 拖成 nought", "唇形不圆"],
        [_f("neutral", "双唇稍圆、舌后低")], (0.96, 0.84), None,
        ["lips", "tongue"], ["ɔː"],
    ),
    PhonemeCard(
        "ɔː", "ɔ", "AO", "vowel", "monophthong", "后中·长·圆唇", True, "长音 o",
        "双唇明显圆拢前突，舌后部抬到中高位，音拖足。",
        ["唇形不够圆", "与 /ɒ/ 不分，长度不够"],
        [_f("neutral", "双唇圆拢前突")], (0.92, 0.62), None,
        ["lips"], ["ɒ", "əʊ"],
    ),
    PhonemeCard(
        "ʊ", "ʊ", "UH", "vowel", "monophthong", "后次高·短·圆唇", True, "短音 u",
        "双唇略圆但不紧张，舌后部略低于 /uː/，短促。",
        ["读成 /uː/，full 听成 fool", "唇形过紧"],
        [_f("vowel-u", "唇略圆、舌后略低")], (0.75, 0.25), None,
        ["lips", "tongue"], ["uː"],
    ),
    PhonemeCard(
        "uː", "u", "UW", "vowel", "monophthong", "后高·长·圆唇", True, "长音 u",
        "双唇收圆前突成小孔，舌后部抬到最高，音拖足。",
        ["唇形不够圆前突（这是普通话母语者的高频失分点）", "长度不足"],
        [_f("vowel-u", "双唇收圆前突、舌后最高")], (0.92, 0.05), None,
        ["lips", "tongue"], ["ʊ"],
    ),
    PhonemeCard(
        "ɜː", "ɝ", "ER", "vowel", "monophthong", "央中·长", True, "长音 er",
        "舌身平放居中，双唇自然展开不圆，音拖足。英音不卷舌，美音带卷舌。",
        ["按汉语「儿」卷舌过度（英音不该卷）", "与弱读 /ə/ 混，长度不够"],
        [_f("neutral", "舌身平放居中")], (0.42, 0.40), None,
        ["tongue"], ["ə"],
    ),
    PhonemeCard(
        "ə", "ə", "AH", "vowel", "monophthong", "央中·弱读", True, "弱读音",
        "英语里出现最多的音：完全放松、极短、永远不重读。",
        ["按拼写把弱读音节读成强元音（about 的 a 读成 /æ/）"],
        [_f("neutral", "完全放松的中性舌位")], (0.58, 0.54), None,
        ["tongue"], ["ɜː", "ʌ"],
    ),
    # 双元音：chart 为起点，chart_to 为滑动终点
    PhonemeCard(
        "eɪ", "eɪ", "EY", "vowel", "diphthong", "前中→前次高", True, "双元音 ei",
        "从 /e/ 滑向 /ɪ/，前重后轻，起点长终点短。",
        ["滑得不够，读成单元音 /e/"],
        [_f("neutral", "起点 /e/"), _f("vowel-i", "滑向 /ɪ/")],
        (0.14, 0.44), (0.20, 0.22), ["tongue"], [],
    ),
    PhonemeCard(
        "aɪ", "aɪ", "AY", "vowel", "diphthong", "央低→前次高", True, "双元音 ai",
        "从接近 /ɑ/ 的低元音滑向 /ɪ/，口先大后小。",
        ["起点不够低、滑动不足"],
        [_f("neutral", "起点口张大"), _f("vowel-i", "滑向 /ɪ/")],
        (0.50, 0.94), (0.20, 0.22), ["tongue"], [],
    ),
    PhonemeCard(
        "ɔɪ", "ɔɪ", "OY", "vowel", "diphthong", "后中圆唇→前次高", True, "双元音 oi",
        "从圆唇的 /ɔː/ 滑向 /ɪ/，唇形由圆到展。",
        ["唇形不变，全程圆唇"],
        [_f("neutral", "起点圆唇"), _f("vowel-i", "滑向 /ɪ/")],
        (0.92, 0.62), (0.20, 0.22), ["lips", "tongue"], [],
    ),
    PhonemeCard(
        "əʊ", "oʊ", "OW", "vowel", "diphthong", "央中→后次高圆唇", True, "双元音 ou",
        "英音从中性 /ə/ 起，美音起点更靠后带圆唇；终点滑向 /ʊ/。",
        ["读成汉语「欧」，起点过于靠后圆唇", "滑动不足读成单元音"],
        [_f("neutral", "起点中性"), _f("vowel-u", "滑向 /ʊ/")],
        (0.56, 0.52), (0.75, 0.25), ["lips", "tongue"], ["ɔː"],
    ),
    PhonemeCard(
        "aʊ", "aʊ", "AW", "vowel", "diphthong", "央低→后次高圆唇", True, "双元音 au",
        "从低元音滑向 /ʊ/，口由大到小、唇由展到圆。",
        ["终点唇形不圆"],
        [_f("neutral", "起点口张大"), _f("vowel-u", "滑向 /ʊ/")],
        (0.62, 0.90), (0.75, 0.25), ["lips", "tongue"], [],
    ),
    PhonemeCard(
        "ɪə", "ɪr", "IH R", "vowel", "diphthong", "前次高→央中", True, "双元音 iə",
        "从 /ɪ/ 滑向弱读 /ə/。美音里通常读成 /ɪr/ 带卷舌。",
        ["读成 /iːə/，起点过紧"],
        [_f("vowel-i", "起点 /ɪ/"), _f("neutral", "滑向 /ə/")],
        (0.20, 0.22), (0.58, 0.54), ["tongue"], [],
    ),
    PhonemeCard(
        "eə", "ɛr", "EH R", "vowel", "diphthong", "前中→央中", True, "双元音 eə",
        "从 /e/ 滑向 /ə/，口型基本不变，只是放松。",
        ["读成单元音 /e/"],
        [_f("neutral", "起点 /e/"), _f("neutral", "滑向 /ə/")],
        (0.18, 0.50), (0.58, 0.54), ["tongue"], [],
    ),
    PhonemeCard(
        "ʊə", "ʊr", "UH R", "vowel", "diphthong", "后次高圆唇→央中", True, "双元音 uə",
        "从 /ʊ/ 滑向 /ə/，唇形由圆到松。现代英音里正在并入 /ɔː/。",
        ["读成 /uːə/"],
        [_f("vowel-u", "起点 /ʊ/"), _f("neutral", "滑向 /ə/")],
        (0.75, 0.25), (0.58, 0.54), ["lips", "tongue"], [],
    ),
]

# ──────────────────────────── 辅音 24 ────────────────────────────

CONSONANTS: list[PhonemeCard] = [
    # 塞音 6
    PhonemeCard(
        "p", "p", "P", "consonant", "plosive", "双唇", False, "清双唇塞音",
        "双唇闭紧憋气再突然放开，重读音节词首要送气（手掌放嘴前能感到气流）。",
        ["不送气，pin 听成 bin", "词尾漏读"],
        [_f("p", "双唇闭紧成阻，随后除阻送气")], None, None, ["lips"], ["b"],
    ),
    PhonemeCard(
        "b", "b", "B", "consonant", "plosive", "双唇", True, "浊双唇塞音",
        "与 /p/ 同部位，但声带振动、不送气。",
        ["词尾清化，cab 听成 cap（普通话没有词尾浊塞音）"],
        [_f("b", "双唇闭紧成阻，声带振动")], None, None, ["lips"], ["p"],
    ),
    PhonemeCard(
        "t", "t", "T", "consonant", "plosive", "齿龈", False, "清齿龈塞音",
        "舌尖抵住上齿龈（不是上齿背）憋气再放开，重读音节词首送气。",
        ["舌尖抵到牙齿上，带出汉语「特」的音色", "不送气"],
        [_f("t", "舌尖抵齿龈成阻，除阻送气")], None, None, ["tongue"], ["d"],
    ),
    PhonemeCard(
        "d", "d", "D", "consonant", "plosive", "齿龈", True, "浊齿龈塞音",
        "与 /t/ 同部位，声带振动、不送气。",
        ["词尾清化，bed 听成 bet"],
        [_f("d", "舌尖抵齿龈成阻，声带振动")], None, None, ["tongue"], ["t"],
    ),
    PhonemeCard(
        "k", "k", "K", "consonant", "plosive", "软腭", False, "清软腭塞音",
        "舌后部抬起顶住软腭憋气再放开，重读音节词首送气。",
        ["不送气，coat 听成 goat"],
        [_f("k", "舌后顶软腭成阻，除阻送气")], None, None, ["tongue"], ["ɡ"],
    ),
    PhonemeCard(
        "ɡ", "ɡ", "G", "consonant", "plosive", "软腭", True, "浊软腭塞音",
        "与 /k/ 同部位，声带振动、不送气。",
        ["词尾清化，bag 听成 back"],
        [_f("g", "舌后顶软腭成阻，声带振动")], None, None, ["tongue"], ["k"],
    ),
    # 擦音 9
    PhonemeCard(
        "f", "f", "F", "consonant", "fricative", "唇齿", False, "清唇齿擦音",
        "上齿轻触下唇，气流从缝隙摩擦而出。",
        ["用双唇代替唇齿，读成汉语「夫」"],
        [_f("f", "上齿触下唇，气流摩擦")], None, None, ["lips"], ["v", "θ"],
    ),
    PhonemeCard(
        "v", "v", "V", "consonant", "fricative", "唇齿", True, "浊唇齿擦音",
        "与 /f/ 同部位，声带振动，摩擦更轻。",
        ["读成 /w/（very 听成 wery）——普通话没有 /v/，这是最高频错误之一",
         "词尾清化，读成 /f/"],
        [_f("v", "上齿触下唇，声带振动")], None, None, ["lips"], ["f", "w"],
    ),
    PhonemeCard(
        "θ", "θ", "TH", "consonant", "fricative", "齿间", False, "清齿间擦音",
        "舌尖轻放在上下齿之间（或轻抵上齿背），气流从舌齿缝摩擦送出。",
        ["读成 /s/，think 听成 sink", "读成 /f/，three 听成 free"],
        [_f("theta", "舌尖置齿间，气流摩擦")], None, None, ["tongue"], ["s", "f", "ð"],
    ),
    PhonemeCard(
        "ð", "ð", "DH", "consonant", "fricative", "齿间", True, "浊齿间擦音",
        "与 /θ/ 同部位，声带振动。this/that/the 里高频出现。",
        ["读成 /d/，this 听成 dis", "读成 /z/，they 听成 zay"],
        [_f("eth", "舌尖置齿间，声带振动")], None, None, ["tongue"], ["d", "z", "θ"],
    ),
    PhonemeCard(
        "s", "s", "S", "consonant", "fricative", "齿龈", False, "清齿龈擦音",
        "舌尖接近上齿龈留窄缝，气流摩擦成尖锐的「嘶」声。",
        ["与 /θ/ 混"],
        [_f("s", "舌尖近齿龈留缝")], None, None, ["tongue"], ["θ", "z", "ʃ"],
    ),
    PhonemeCard(
        "z", "z", "Z", "consonant", "fricative", "齿龈", True, "浊齿龈擦音",
        "与 /s/ 同部位，声带振动。复数与第三人称的 -s 大量读这个音。",
        ["词尾清化成 /s/——speechocean762 实测这是普通话母语者**低分率最高**的音素（64%）"],
        [_f("z", "舌尖近齿龈，声带振动")], None, None, ["tongue"], ["s"],
    ),
    PhonemeCard(
        "ʃ", "ʃ", "SH", "consonant", "fricative", "龈后", False, "清龈后擦音",
        "舌面靠近齿龈后部，双唇略前突，比汉语「西」更靠后、比「诗」更前。",
        ["读成汉语「诗」（卷舌过度）或「西」（过于靠前）"],
        [_f("esh", "舌面近龈后，双唇略突")], None, None, ["tongue", "lips"], ["s", "ʒ"],
    ),
    PhonemeCard(
        "ʒ", "ʒ", "ZH", "consonant", "fricative", "龈后", True, "浊龈后擦音",
        "与 /ʃ/ 同部位，声带振动。英语里出现频率最低的辅音，多在 -sion/-sure 里。",
        ["读成 /ʃ/ 或 /dʒ/"],
        [_f("ezh", "舌面近龈后，声带振动")], None, None, ["tongue", "lips"], ["ʃ", "dʒ"],
    ),
    PhonemeCard(
        "h", "h", "HH", "consonant", "fricative", "声门", False, "清声门擦音",
        "口腔保持后一个元音的形状，气流从声门直接摩擦送出，不加喉音。",
        ["读成汉语「喝」的舌根摩擦（部位太靠前）"],
        [_f("neutral", "口腔中性，摩擦发生在声门")], None, None, [], [],
    ),
    # 塞擦音 2
    PhonemeCard(
        "tʃ", "tʃ", "CH", "consonant", "affricate", "龈后", False, "清龈后塞擦音",
        "先做 /t/ 的成阻，除阻时转成 /ʃ/ 的摩擦，两个动作连成一个音。",
        ["读成汉语「气」或「吃」，部位与唇形都不对"],
        [_f("t", "① 舌尖抵齿龈成阻"), _f("esh", "② 除阻转 /ʃ/ 摩擦")],
        None, None, ["tongue"], ["dʒ", "ʃ"],
    ),
    PhonemeCard(
        "dʒ", "dʒ", "JH", "consonant", "affricate", "龈后", True, "浊龈后塞擦音",
        "与 /tʃ/ 同过程，声带全程振动。",
        ["读成汉语「基」", "词尾清化成 /tʃ/"],
        [_f("d", "① 舌尖抵齿龈成阻"), _f("ezh", "② 除阻转 /ʒ/ 摩擦")],
        None, None, ["tongue"], ["tʃ", "ʒ"],
    ),
    # 鼻音 3
    PhonemeCard(
        "m", "m", "M", "consonant", "nasal", "双唇", True, "双唇鼻音",
        "双唇闭合，软腭下降让气流走鼻腔。",
        ["词尾 -m 读成 -n"],
        [_f("m", "双唇闭合，软腭下降走鼻腔")], None, None, ["lips"], ["n"],
    ),
    PhonemeCard(
        "n", "n", "N", "consonant", "nasal", "齿龈", True, "齿龈鼻音",
        "舌尖抵住上齿龈，软腭下降走鼻腔。",
        ["与 /l/ 混（南方口音高频）", "与 /ŋ/ 混，sin 与 sing 不分"],
        [_f("n", "舌尖抵齿龈，气流走鼻腔")], None, None, ["tongue"], ["l", "ŋ"],
    ),
    PhonemeCard(
        "ŋ", "ŋ", "NG", "consonant", "nasal", "软腭", True, "软腭鼻音",
        "舌后部顶软腭，气流走鼻腔。英语里**不出现在词首**。",
        ["词尾多带出一个 /ɡ/（sing 读成 sing-g）", "与 /n/ 混"],
        [_f("eng", "舌后顶软腭，气流走鼻腔")], None, None, ["tongue"], ["n"],
    ),
    # 通音 4
    PhonemeCard(
        "l", "l", "L", "consonant", "lateral", "齿龈", True, "齿龈边音",
        "舌尖抵上齿龈，气流从舌头**两侧**流出。元音前是清亮的 light L，"
        "词尾或辅音前舌后部抬起变成沉暗的 dark L（feel 的 l 与 leaf 的 l 不同）。",
        ["词尾 dark L 读成元音或直接丢掉（miIk）", "与 /n/ 混"],
        [_f("n", "舌尖抵齿龈（气流改从两侧出）"), _f("vowel-u", "词尾 dark L：舌后同时抬起")],
        None, None, ["tongue"], ["n", "r"],
    ),
    PhonemeCard(
        "r", "ɹ", "R", "consonant", "approximant", "龈后", True, "龈后通音",
        "舌尖上卷但**不接触**任何部位，双唇略圆。英音里词尾的 r 不发音。",
        ["按汉语「日」发成擦音（舌位过紧）", "与 /l/ 混"],
        [_f("r", "舌尖上卷不接触，双唇略圆")], None, None, ["tongue", "lips"], ["l", "w"],
    ),
    PhonemeCard(
        "j", "j", "Y", "consonant", "approximant", "硬腭", True, "硬腭通音",
        "起始舌位与 /iː/ 相同，随即滑向后面的元音，全程不成阻。",
        ["读成汉语「衣」而停住，没有滑动"],
        [_f("vowel-i", "起始舌位同 /iː/，随即滑走")], None, None, ["tongue"], [],
    ),
    PhonemeCard(
        "w", "w", "W", "consonant", "approximant", "双唇软腭", True, "双唇软腭通音",
        "双唇收圆前突、舌后部抬高（等于 /uː/ 的姿势），随即滑向后面的元音。",
        ["读成 /v/（上齿咬下唇）", "唇形不够圆前突"],
        [_f("vowel-u", "唇圆舌后高（同 /uː/），随即滑走")],
        None, None, ["lips", "tongue"], ["v", "r"],
    ),
]

ALL_CARDS: list[PhonemeCard] = VOWELS + CONSONANTS

assert len(VOWELS) == 20, f"元音应为 20 个，实为 {len(VOWELS)}"
assert len(CONSONANTS) == 24, f"辅音应为 24 个，实为 {len(CONSONANTS)}"
assert len({c.symbol for c in ALL_CARDS}) == 44, "音位符号有重复"


# ──────────────────────────── 对比组（FR-393d） ────────────────────────────

# 13 个对比组，全部来自需求文档列举 + speechocean762 实测难点交叉验证
CONTRAST_GROUPS: list[dict] = [
    {"key": "θ/s", "a": "TH", "b": "S", "title": "θ / s", "note": "think 与 sink"},
    {"key": "θ/f", "a": "TH", "b": "F", "title": "θ / f", "note": "three 与 free"},
    {"key": "ð/d", "a": "DH", "b": "D", "title": "ð / d", "note": "they 与 day"},
    # scarce=True：英语里这个对比的最小对立对本来就少，生成时允许放宽词频门槛
    {
        "key": "ð/z", "a": "DH", "b": "Z", "title": "ð / z",
        "note": "breathe 与 breeze", "scarce": True,
    },
    {"key": "v/w", "a": "V", "b": "W", "title": "v / w", "note": "vest 与 west"},
    {"key": "l/n", "a": "L", "b": "N", "title": "l / n", "note": "light 与 night"},
    {"key": "n/ŋ", "a": "N", "b": "NG", "title": "n / ŋ", "note": "sin 与 sing"},
    {"key": "s/ʃ", "a": "S", "b": "SH", "title": "s / ʃ", "note": "see 与 she"},
    {"key": "iː/ɪ", "a": "IY", "b": "IH", "title": "iː / ɪ", "note": "sheep 与 ship"},
    {"key": "æ/e", "a": "AE", "b": "EH", "title": "æ / e", "note": "bad 与 bed"},
    {"key": "æ/ʌ", "a": "AE", "b": "AH", "title": "æ / ʌ", "note": "cap 与 cup"},
    {"key": "ɒ/ɔː", "a": "AA", "b": "AO", "title": "ɒ / ɔː", "note": "cot 与 caught"},
    {"key": "s/z", "a": "S", "b": "Z", "title": "词尾 s / z", "note": "price 与 prize"},
]

# HVPT 元分析：总训练约 400 分钟后收益趋平（FR-394）
HVPT_TARGET_SECONDS = 400 * 60
