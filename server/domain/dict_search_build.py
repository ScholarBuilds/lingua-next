"""查词侧表的构建函数（FR-508~510）：从 dict_entry 一行算出 dict_head / dict_gloss 行，从 WordNet
算出 dict_related 行。全部是纯函数，不开 session、不下网——seed 脚本负责读写，测试直接喂几行。"""

import re
from dataclasses import dataclass

from domain.dict_enrich import split_ecdict_phonetic
from domain.dict_forms import lemma_of
from domain.dict_gloss import short_gloss, split_glosses

TIER_LEARNER = 1
TIER_PHRASE = 2
TIER_REST = 3

# 词组每个 token 得长这样，挡掉 `give ... a hand`、`give & take`、带括号数字的条目
TOKEN_RE = re.compile(r"^[a-z][a-z'-]*$")
FUNCTION_WORDS = frozenset(
    {
        "a",
        "an",
        "the",
        "to",
        "of",
        "in",
        "on",
        "at",
        "by",
        "for",
        "with",
        "up",
        "off",
        "out",
        "down",
        "over",
        "away",
        "back",
        "sb",
        "sth",
        "one's",
        "oneself",
    }
)
# 「常用词」的词频门槛：词组的每个实词都得在这个档内才算常用词组
COMMON_FRQ_MAX = 20000
MAX_PHRASE_TOKENS = 4
RELATED_PER_KIND = 16
BRIEF_LEN = 24
TAGS_LEN = 64
PHONETIC_LEN = 64


@dataclass(frozen=True, slots=True)
class EntryRow:
    """dict_entry 的一行投影（seed 脚本按列查，不建 ORM 对象）。"""

    word: str
    translation: str | None
    frq: int | None
    bnc: int | None
    tag: str | None
    collins: int | None
    oxford: int | None
    exchange: str | None
    phonetic: str | None


def lc_of(word: str) -> str:
    return " ".join(word.lower().split())


def is_learner(row: EntryRow) -> bool:
    return bool(
        (row.frq or 0) > 0
        or (row.bnc or 0) > 0
        or (row.tag or "").strip()
        or (row.collins or 0) > 0
        or (row.oxford or 0) > 0
    )


def is_common_token(row: EntryRow) -> bool:
    """单 token 且够常用：给词组判层用。"""
    if " " in row.word:
        return False
    frq = row.frq or 0
    return (0 < frq <= COMMON_FRQ_MAX) or bool((row.tag or "").strip())


def frq_rank_of(row: EntryRow) -> int | None:
    return row.frq or row.bnc or None


def classify_tier(row: EntryRow, common: set[str]) -> int | None:
    """None 表示不入索引（长尾专业词组）。"""
    lc = lc_of(row.word)
    if " " not in lc:
        return TIER_LEARNER if is_learner(row) else TIER_REST
    if is_learner(row):
        return TIER_LEARNER
    tokens = lc.split(" ")
    if not 1 < len(tokens) <= MAX_PHRASE_TOKENS:
        return None
    if (row.translation or "").lstrip().startswith("["):
        return None
    if not all(TOKEN_RE.match(t) for t in tokens):
        return None
    if not all(t in common or t in FUNCTION_WORDS for t in tokens):
        return None
    return TIER_PHRASE


def _phonetic_of(row: EntryRow, lc: str, phon: dict[str, str]) -> str | None:
    ipa = phon.get(lc) if " " not in lc else None
    if not ipa:
        parts = split_ecdict_phonetic(row.phonetic)
        ipa = parts[0] if parts else None
    return ipa[:PHONETIC_LEN] if ipa else None


def head_row(row: EntryRow, common: set[str], phon: dict[str, str]) -> dict | None:
    tier = classify_tier(row, common)
    if tier is None:
        return None
    lc = lc_of(row.word)
    brief = short_gloss(row.translation)
    tags = (row.tag or "").strip() or None
    return {
        "word": row.word,
        "lc": lc,
        "tier": tier,
        "frq_rank": frq_rank_of(row),
        "lemma": lemma_of(row.exchange, row.word),
        "proper": row.word != row.word.lower(),
        "brief": brief[:BRIEF_LEN] if brief else None,
        "tags": tags[:TAGS_LEN] if tags else None,
        "phonetic": _phonetic_of(row, lc, phon),
    }


def gloss_rows(head: dict, translation: str | None) -> list[dict]:
    """只收学习者层与常用词组的原形行：变形行（abandoning / forgone）混进反查只会挤掉原形。"""
    if head["tier"] == TIER_REST or head["lemma"] is not None:
        return []
    return [
        {
            "gloss": g.gloss,
            "word": head["word"],
            "tier": head["tier"],
            "sense_idx": g.sense_idx,
            "pos": g.pos,
            "frq_rank": head["frq_rank"],
        }
        for g in split_glosses(translation)
    ]


def _norm_lemma(name: str) -> str:
    return name.replace("_", " ").lower()


def _collect(
    seen: dict[tuple[str, str], int], tier1_lc: set[str], word: str, kind: str, name: str, rank: int
) -> None:
    related = _norm_lemma(name)
    if related == word or related not in tier1_lc:
        return
    seen.setdefault((kind, related), rank)


# ECDICT `pos`（`v:69/n:31`）的词性码 → WordNet synset 的词性；`s` 是从属形容词，并入 a
POS_TO_WN = {"n": "n", "v": "v", "j": "a", "a": "a", "s": "a", "r": "r"}


def pos_weights(pos: str | None) -> dict[str, int]:
    """`"v:69/n:31"` → `{"v": 69, "n": 31}`，键已换成 WordNet 词性。"""
    out: dict[str, int] = {}
    for part in (pos or "").split("/"):
        code, _, weight = part.partition(":")
        wn_pos = POS_TO_WN.get(code.strip())
        if wn_pos is None or not weight.strip().isdigit():
            continue
        out[wn_pos] = out.get(wn_pos, 0) + int(weight)
    return out


def build_related(
    tier1_lc: set[str], wn, pos_of: dict[str, dict[str, int]] | None = None
) -> list[dict]:
    """只收学习者层内的词，每 (word, kind) 截 RELATED_PER_KIND。

    rank 是 synset 序：WordNet 按词性分组（名词义永远排在动词义前面），所以先按 ECDICT 的
    词性占比把常用词性的义项提前，再按 WordNet 原序——abandon 的近义词才是 desert 而不是 wantonness。
    `wn` 是 `nltk.corpus.wordnet` 那个对象，作参数传进来是为了测试能喂假的。
    """
    out: list[dict] = []
    for word in sorted(tier1_lc):
        seen: dict[tuple[str, str], int] = {}
        weights = (pos_of or {}).get(word, {})
        synsets = list(wn.synsets(word.replace(" ", "_")))
        ordered = sorted(
            enumerate(synsets), key=lambda item: (-weights.get(item[1].pos(), 0), item[0])
        )
        for rank, (_orig, syn) in enumerate(ordered):
            for lemma in syn.lemmas():
                name = _norm_lemma(lemma.name())
                if name != word:
                    _collect(seen, tier1_lc, word, "syn", name, rank)
                    continue
                for ant in lemma.antonyms():
                    _collect(seen, tier1_lc, word, "ant", ant.name(), rank)
                for deriv in lemma.derivationally_related_forms():
                    _collect(seen, tier1_lc, word, "deriv", deriv.name(), rank)
                for pert in lemma.pertainyms():
                    _collect(seen, tier1_lc, word, "deriv", pert.name(), rank)
        per_kind: dict[str, int] = {}
        ranked = sorted(seen.items(), key=lambda kv: (kv[0][0], kv[1], kv[0][1]))
        for (kind, related), rank in ranked:
            if per_kind.get(kind, 0) >= RELATED_PER_KIND:
                continue
            per_kind[kind] = per_kind.get(kind, 0) + 1
            out.append({"word": word, "kind": kind, "related": related, "rank": rank})
    return out
