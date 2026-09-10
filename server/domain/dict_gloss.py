"""ECDICT `translation` 的解析与词条展示口径（FR-509）。

`translation` 形如 `vt. 放弃, 抛弃, 遗弃\\nn. 放任, 无拘束`，行首可能带 `[计]` 域标签，
词性前缀有 `vt.&vi.` / `vt.,vi.` / `vt.vi.` 这类复合写法，还有整行是「go的过去式」的
变形说明。汉英反查靠把每条中文义项切成可索引的 gloss，这里是唯一的切法。
"""

import re
from dataclasses import dataclass

FREQ_BANDS = [(3000, "很常见"), (10000, "常见"), (25000, "较常见"), (50000, "不常见")]


def freq_band(frq: int | None) -> str | None:
    if not frq:
        return None
    for limit, label in FREQ_BANDS:
        if frq <= limit:
            return label
    return "罕见"


@dataclass(frozen=True, slots=True)
class Gloss:
    gloss: str
    pos: str | None
    sense_idx: int


_DOMAIN_RE = re.compile(r"^\[([^\]]{1,8})\]\s*")
_INFLECTION_LINE_RE = re.compile(
    r"^\(?\s*[A-Za-z' -]+的(过去式|过去分词|现在分词|第三人称单数|复数|比较级|最高级)"
    r"(和(过去式|过去分词|复数))?\s*\)?$"
)
_PAREN_RE = re.compile(r"[（(][^()（）]*[)）]")
_ANGLE_RE = re.compile(r"<[^<>]*>")
# 吃掉行首的一个或多个词性缩写：`n. ` / `vt.&vi. ` / `vt.,vi. ` / `vt.vi. ` / `(pl. `
_POS_RE = re.compile(r"^(?:\(?[a-z]{1,6}\.\)?(?:\s*[,&]\s*|\s*))+")
_POS_TOKEN_RE = re.compile(r"[a-z]{1,6}(?=\.)")
_SPLIT_RE = re.compile(r"[,;，；、]")
_CJK_RE = re.compile(r"[㐀-䶿一-鿿]")
_ELLIPSIS_RE = re.compile(r"(\.{3,}|…{2,})")
_EDGE_PUNCT = " 。.！!？?:：-—~～"
MAX_GLOSS_LEN = 12
SHORT_GLOSS_LEN = 12
# 域标签行的义项排在同词的普通义项之后
DOMAIN_SENSE_OFFSET = 100

POS_MAP = {
    "n": "n",
    "v": "v",
    "vt": "v",
    "vi": "v",
    "vbl": "v",
    "aux": "v",
    "a": "adj",
    "adj": "adj",
    "ad": "adv",
    "adv": "adv",
    "prep": "prep",
    "conj": "conj",
    "pron": "pron",
    "art": "art",
    "num": "num",
    "int": "interj",
    "interj": "interj",
}


def _strip_pos(line: str) -> tuple[str, str | None]:
    m = _POS_RE.match(line)
    if m is None:
        return line, None
    tokens = _POS_TOKEN_RE.findall(m.group(0))
    pos = POS_MAP.get(tokens[0]) if tokens else None
    return line[m.end() :], pos


def _clean_piece(piece: str) -> str:
    piece = _ELLIPSIS_RE.sub("…", piece).strip(_EDGE_PUNCT)
    return piece.strip()


def split_glosses(translation: str | None) -> list[Gloss]:
    """把整段中文释义切成可反查的 gloss，同一 gloss 只保留最小义项序。"""
    if not translation:
        return []
    out: list[Gloss] = []
    seen: set[str] = set()
    idx = 0
    for raw in translation.split("\n"):
        line = raw.strip()
        if not line:
            continue
        domain = _DOMAIN_RE.match(line)
        if domain is not None:
            line = line[domain.end() :]
        if _INFLECTION_LINE_RE.match(line):
            continue
        line = _ANGLE_RE.sub("", _PAREN_RE.sub("", line))
        body, pos = _strip_pos(line.strip())
        base = DOMAIN_SENSE_OFFSET if domain is not None else 0
        for piece in _SPLIT_RE.split(body):
            gloss = _clean_piece(piece)
            if not gloss or not _CJK_RE.search(gloss) or len(gloss) > MAX_GLOSS_LEN:
                continue
            keys = [gloss]
            # 「美丽的」也写一份「美丽」：输入不带「的」时才能精确命中而不靠前缀
            if len(gloss) >= 3 and gloss[-1] in "的地":
                keys.append(gloss[:-1])
            for key in keys:
                if key in seen:
                    continue
                seen.add(key)
                out.append(Gloss(key, pos, base + idx))
            idx += 1
    return out


def short_gloss(translation: str | None) -> str | None:
    """取中文释义的第一条，砍到能挂在词头上的长度（FR-381 生词小译、查词行的极短中文）。

    优先取第一条不带域标签的行；整段都是域标签行时退到首行去掉标签。变形说明行
    不跳——`went` 的「go的过去式」比空好。
    """
    if not translation:
        return None
    lines = [line.strip() for line in translation.split("\n") if line.strip()]
    if not lines:
        return None
    chosen = next((line for line in lines if not _DOMAIN_RE.match(line)), lines[0])
    body, _pos = _strip_pos(_DOMAIN_RE.sub("", chosen))
    first = _clean_piece(_SPLIT_RE.split(body, maxsplit=1)[0])
    return first[:SHORT_GLOSS_LEN] if first else None
