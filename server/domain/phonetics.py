"""音素记法转换与基础度量（模块 13 FR-390）。

三套记法在项目里各有归属，不要互相替代：

- **ARPAbet**（CMUdict）：带重音数字，用来算音节数、重音型、最小对立对；
- **IPA 教学记法**（RP 风格 44 音位）：音位卡片与题面展示；
- **IPA 词典记法**（ipa-dict en_US / en_UK）：单词音标展示，直接落库不做转换。

BR-91 明确禁止把展示链路（这里）与评测链路（espeak-ng）的音素体系混用。
"""

from __future__ import annotations

import re
import unicodedata

# ─────────────────────── ARPAbet → IPA ───────────────────────

# 美音（GA）记法，与 ipa-dict en_US 对齐：ɑ 不是 ɒ、oʊ 不是 əʊ、ɝ 不是 ɜː
ARPABET_TO_IPA_US: dict[str, str] = {
    "AA": "ɑ", "AE": "æ", "AH": "ʌ", "AO": "ɔ", "AW": "aʊ", "AY": "aɪ",
    "EH": "ɛ", "ER": "ɝ", "EY": "eɪ", "IH": "ɪ", "IY": "i", "OW": "oʊ",
    "OY": "ɔɪ", "UH": "ʊ", "UW": "u",
    "B": "b", "CH": "tʃ", "D": "d", "DH": "ð", "F": "f", "G": "ɡ", "HH": "h",
    "JH": "dʒ", "K": "k", "L": "l", "M": "m", "N": "n", "NG": "ŋ", "P": "p",
    "R": "ɹ", "S": "s", "SH": "ʃ", "T": "t", "TH": "θ", "V": "v", "W": "w",
    "Y": "j", "Z": "z", "ZH": "ʒ",
}  # fmt: skip

# 教学记法（RP，中国教材沿用的 48 音标体系里的英音写法）
ARPABET_TO_IPA_TEACH: dict[str, str] = {
    "AA": "ɑː", "AE": "æ", "AH": "ʌ", "AO": "ɔː", "AW": "aʊ", "AY": "aɪ",
    "EH": "e", "ER": "ɜː", "EY": "eɪ", "IH": "ɪ", "IY": "iː", "OW": "əʊ",
    "OY": "ɔɪ", "UH": "ʊ", "UW": "uː",
    "B": "b", "CH": "tʃ", "D": "d", "DH": "ð", "F": "f", "G": "ɡ", "HH": "h",
    "JH": "dʒ", "K": "k", "L": "l", "M": "m", "N": "n", "NG": "ŋ", "P": "p",
    "R": "r", "S": "s", "SH": "ʃ", "T": "t", "TH": "θ", "V": "v", "W": "w",
    "Y": "j", "Z": "z", "ZH": "ʒ",
}  # fmt: skip

ARPABET_VOWELS = frozenset(
    {"AA", "AE", "AH", "AO", "AW", "AY", "EH", "ER", "EY", "IH", "IY", "OW", "OY", "UH", "UW"}
)

# 西里尔字符污染：ECDICT 里 28% 的音标把 ə 写成了 ә（U+04D9）。
# 这几条替换无损，用于兜底展示老数据（FR-390f）。
CYRILLIC_FIX = {
    "ә": "ə",  # ә → ə
    "є": "ɛ",  # є → ɛ
    "а": "ɑ",  # а → ɑ
    "о": "ɔ",  # о → ɔ
    "е": "e",       # е → e
    "р": "r",       # р → r
    "с": "c",       # с → c
    "х": "x",       # х → x
}  # fmt: skip


def clean_ipa(raw: str | None) -> str | None:
    """兜底清洗老音标：去斜杠方括号、修西里尔字符、DJ 冒号与重音号归一。

    只做无损替换。DJ 元音体系 → IPA 有歧义（`in` 的 i 是 ɪ、`bi:` 的 i 是 iː，
    同字符两个音），一律不碰——那正是不清洗 ECDICT 的理由。
    """
    if not raw:
        return None
    s = raw.strip().strip("/[]").strip()
    if not s:
        return None
    for bad, good in CYRILLIC_FIX.items():
        s = s.replace(bad, good)
    s = s.replace(":", "ː").replace("'", "ˈ").replace("ˌ", "ˌ")
    return s or None


def strip_stress(phone: str) -> str:
    """去掉 ARPAbet 音素尾部的重音数字：`AA1` → `AA`。"""
    return phone.rstrip("012")


def stress_digit(phone: str) -> str:
    """取重音数字，非元音返回空串。"""
    m = re.search(r"([012])$", phone)
    return m.group(1) if m else ""


def parse_arpabet(line: str) -> list[str]:
    """CMUdict 音素串 → 列表。"""
    return [p for p in line.strip().split() if p]


def syllable_count(phones: list[str]) -> int:
    """音节数 = 元音音素个数。ARPAbet 一个元音一个音节，这条是准确的。"""
    return sum(1 for p in phones if strip_stress(p) in ARPABET_VOWELS)


def stress_pattern(phones: list[str]) -> str:
    """重音型：按元音顺序取重音数字，如 `information` → `2010`。"""
    return "".join(stress_digit(p) for p in phones if strip_stress(p) in ARPABET_VOWELS)


# AH 与 ER 的读音由重音位决定，同一符号两个音位：
# `AH0` 是弱读 schwa（information 的 -tion），`AH1/AH2` 是 ʌ（cup）；
# `ER0` 是弱读 ɚ/ə（father），`ER1/ER2` 是重读 ɝ/ɜː（bird）。
# 不分开处理就会把 information 转成 ˌɪnfɜːˈmeɪʃʌn。
REDUCED_TEACH: dict[tuple[str, str], str] = {
    ("AH", "0"): "ə",
    ("ER", "0"): "ə",
    # happy tensing：词尾 -y 的 IY0 是短促的 /i/，写成 /iː/ 会把 thickly 标成 θɪkliː
    ("IY", "0"): "i",
}
REDUCED_US: dict[tuple[str, str], str] = {
    ("AH", "0"): "ə",
    ("ER", "0"): "ɚ",
    ("IY", "0"): "i",
}


def ipa_for_phone(phone: str, *, teach: bool = False) -> str:
    """单个 ARPAbet 音素 → IPA 符号，按重音位区分 AH0/AH1 与 ER0/ER1。"""
    base = strip_stress(phone)
    digit = stress_digit(phone)
    reduced = REDUCED_TEACH if teach else REDUCED_US
    hit = reduced.get((base, digit))
    if hit:
        return hit
    table = ARPABET_TO_IPA_TEACH if teach else ARPABET_TO_IPA_US
    return table.get(base, base.lower())


def arpabet_to_ipa(phones: list[str], *, teach: bool = False) -> str:
    """ARPAbet 序列 → IPA 串，重音记号前置到所在音节的首音素。

    `teach=True` 用教学记法（RP），否则用与 ipa-dict en_US 对齐的 GA 记法。
    """
    out: list[str] = []
    syl_start = 0  # 当前音节在 out 里的起始下标
    for p in phones:
        if strip_stress(p) in ARPABET_VOWELS:
            mark = {"1": "ˈ", "2": "ˌ"}.get(stress_digit(p), "")
            if mark:
                out.insert(min(syl_start, len(out)), mark)
            syl_start = len(out) + 1
        out.append(ipa_for_phone(p, teach=teach))
    return "".join(out)


def ipa_symbols(ipa: str) -> list[str]:
    """把 IPA 串切成可点击的符号列表：双字符音位（tʃ dʒ aɪ）不拆开，长音符号跟随前一个。"""
    digraphs = (
        "tʃ", "dʒ", "aɪ", "aʊ", "eɪ", "ɔɪ", "əʊ", "oʊ", "ɪə", "eə", "ʊə",
        "iː", "ɑː", "ɔː", "uː", "ɜː", "ɝ", "ɚ",
    )  # fmt: skip
    s = unicodedata.normalize("NFC", ipa)
    out: list[str] = []
    i = 0
    while i < len(s):
        if s[i] in "ˈˌ.ˑ ":
            i += 1
            continue
        hit = next((d for d in digraphs if s.startswith(d, i)), None)
        if hit:
            out.append(hit)
            i += len(hit)
        else:
            out.append(s[i])
            i += 1
    return out


def first_pron(field: str) -> str:
    """ipa-dict 一行可能给多个读音（逗号分隔），取第一个主读音。"""
    return field.split(",")[0].strip().strip("/").strip()


def normalize_word(word: str) -> str:
    """词形归一：小写、去掉 CMUdict 的同形词后缀 `(2)`。"""
    return re.sub(r"\(\d+\)$", "", word.strip().lower())
