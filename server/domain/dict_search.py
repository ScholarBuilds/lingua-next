"""全局查词的检索层（FR-508~510）：只查三张侧表，dict_entry 只在取 exchange 时碰一下。

英文：精确 → 原形 / 变形 → 前缀联想 → 词组 → 子串 → 同义 / 反义 / 派生 → 拼写纠错；
中文：gloss 精确 → 前缀 → 子串（只扫学习者层）；带 `*` / `?` 走通配。

前缀一律写成范围谓词 `lc >= q AND lc < q_hi`：SQLite 上 `LIKE 'q%'` 在 BINARY 列是全表扫描，
范围谓词两方言都吃索引。排序里的 `nulls_last()` 必须显式写——SQLite 升序 NULL 在前、PG 在后，
不写的话没词频的变形行会排到最前面。
"""

import re
import unicodedata
from datetime import UTC, datetime

from rapidfuzz import process
from rapidfuzz.distance import DamerauLevenshtein
from sqlalchemy import ColumnElement, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from domain import study_stage
from domain.dict_forms import forms_of, lemma_guesses
from domain.dict_gloss import freq_band
from domain.models import DictEntry, DictGloss, DictHead, DictRelated, UserPref, VocabEntry

MAX_QUERY_LEN = 64
BUILD_PREF_KEY = "dict_search.build"
NOT_READY_HINT = (
    "词典检索索引还没建：cd server && uv run python scripts/seed_dict_search.py --all "
    "（桌面档带 LINGUA_DATABASE_URL 指向 data/desktop/nexus.sqlite3）"
)
RELATED_KINDS = ("syn", "ant", "deriv")
RELATED_PER_KIND = 12
MATCH_CANDIDATES = 50
PHRASE_LIMIT = 15
SUBSTRING_LIMIT = 10
REVERSE_PER_LEVEL = 60
REVERSE_LIMIT = 40
REVERSE_SECONDARY = 12
FUZZY_LIMIT = 8

CJK_RE = re.compile(r"[㐀-䶿一-鿿]")
WILDCARD_RE = re.compile(r"[*?]")
FULLWIDTH_PUNCT = str.maketrans({"＊": "*", "？": "?", "＇": "'", "－": "-"})

_ORDER = (
    DictHead.tier,
    DictHead.proper,
    DictHead.frq_rank.nulls_last(),
    func.length(DictHead.lc),
    DictHead.lc,
)


def normalize(q: str) -> str:
    q = unicodedata.normalize("NFKC", q).translate(FULLWIDTH_PUNCT).strip()
    return " ".join(q.split())


def classify(q: str) -> str:
    if CJK_RE.search(q):
        return "zh"
    if WILDCARD_RE.search(q):
        return "glob"
    return "en"


def prefix_where(col: ColumnElement, q: str) -> tuple[ColumnElement, ColumnElement]:
    return col >= q, col < q[:-1] + chr(ord(q[-1]) + 1)


def prefix_stmt(q: str):
    """给方言编译守卫用：前缀查询的 SQL 形态。"""
    return select(DictHead.word).where(*prefix_where(DictHead.lc, q)).order_by(*_ORDER)


def _entry(head: DictHead, match: str) -> dict:
    return {
        "word": head.word,
        "lc": head.lc,
        "brief": head.brief,
        "phonetic": head.phonetic,
        "tags": head.tags.split() if head.tags else [],
        "frq_rank": head.frq_rank,
        "freq_band": freq_band(head.frq_rank),
        "tier": head.tier,
        "lemma": head.lemma,
        "proper": head.proper,
        "match": match,
        "stage": "unseen",
        "in_vocab": False,
        "vocab_id": None,
        "mark": None,
    }


async def _heads(session: AsyncSession, *where: ColumnElement, limit: int) -> list[DictHead]:
    stmt = select(DictHead).where(*where).order_by(*_ORDER).limit(limit)
    return list((await session.execute(stmt)).scalars())


async def _heads_by_lc(session: AsyncSession, lcs: set[str]) -> dict[str, DictHead]:
    """同一 lc 可能两行（China / china），留排序靠前的那行。"""
    if not lcs:
        return {}
    rows = await _heads(session, DictHead.lc.in_(lcs), limit=len(lcs) * 2)
    out: dict[str, DictHead] = {}
    for head in rows:
        out.setdefault(head.lc, head)
    return out


async def is_ready(session: AsyncSession) -> bool:
    return (await session.scalar(select(DictHead.word).limit(1))) is not None


async def build_meta(session: AsyncSession) -> dict:
    row = await session.get(UserPref, BUILD_PREF_KEY)
    return dict(row.value) if row is not None and isinstance(row.value, dict) else {}


async def write_build_meta(session: AsyncSession, meta: dict) -> None:
    row = await session.get(UserPref, BUILD_PREF_KEY)
    value = {**meta, "built_at": datetime.now(UTC).isoformat(timespec="seconds")}
    if row is None:
        session.add(UserPref(key=BUILD_PREF_KEY, value=value))
    else:
        row.value = value


def _source(meta: dict) -> dict:
    return {
        "dict": "ECDICT",
        "forms": "ECDICT exchange",
        "related": "WordNet 3.0" if meta.get("wordnet") else None,
        "fuzzy": "rapidfuzz",
        "index_built_at": meta.get("built_at"),
    }


# ---- 英文 ----


async def _forms(session: AsyncSession, base_words: list[str]) -> list[dict]:
    plans: list[tuple[str, list[dict]]] = []
    wanted: set[str] = set()
    for word in base_words:
        entry = await session.get(DictEntry, word)
        forms = forms_of(word, entry.exchange if entry else None)
        if forms:
            plans.append((word, forms))
            wanted.update(f["word"].lower() for f in forms)
    heads = await _heads_by_lc(session, wanted)
    out = []
    for word, forms in plans:
        items = []
        for form in forms:
            head = heads.get(form["word"].lower())
            base = (
                _entry(head, "form")
                if head is not None
                else {
                    "word": form["word"],
                    "lc": form["word"].lower(),
                    "brief": None,
                    "phonetic": None,
                    "tags": [],
                    "match": "form",
                    "stage": "unseen",
                    "in_vocab": False,
                    "vocab_id": None,
                    "mark": None,
                }
            )
            items.append(
                {**base, "code": form["code"], "codes": form["codes"], "label": form["label"]}
            )
        out.append({"lemma": word, "forms": items})
    return out


async def _related(session: AsyncSession, base_words: list[str]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {kind: [] for kind in RELATED_KINDS}
    if not base_words:
        return out
    stmt = (
        select(DictRelated.kind, DictHead)
        .join(DictHead, DictHead.lc == DictRelated.related)
        .where(DictRelated.word.in_([w.lower() for w in base_words]))
        .order_by(
            DictRelated.kind, DictRelated.rank, DictHead.proper, DictHead.frq_rank.nulls_last()
        )
    )
    seen: dict[str, set[str]] = {kind: set() for kind in RELATED_KINDS}
    for kind, head in (await session.execute(stmt)).all():
        if kind not in out or head.lc in seen[kind] or len(out[kind]) >= RELATED_PER_KIND:
            continue
        seen[kind].add(head.lc)
        out[kind].append(_entry(head, kind))
    return out


_fuzzy_words: list[str] | None = None
_fuzzy_ranks: list[int | None] = []


def reset_fuzzy_cache() -> None:
    """seed 重建之后与每个测试开头调：候选列表是进程内缓存。"""
    global _fuzzy_words, _fuzzy_ranks
    _fuzzy_words = None
    _fuzzy_ranks = []


async def _fuzzy_choices(session: AsyncSession) -> tuple[list[str], list[int | None]]:
    global _fuzzy_words, _fuzzy_ranks
    if _fuzzy_words is None:
        stmt = select(DictHead.lc, DictHead.frq_rank).where(
            DictHead.tier == 1, DictHead.proper.is_(False), DictHead.lemma.is_(None)
        )
        rows = (await session.execute(stmt)).all()
        _fuzzy_words = [lc for lc, _ in rows]
        _fuzzy_ranks = [rank for _, rank in rows]
    return _fuzzy_words, _fuzzy_ranks


async def _fuzzy(session: AsyncSession, q: str) -> list[DictHead]:
    words, ranks = await _fuzzy_choices(session)
    if not words:
        return []
    cutoff = 1 if len(q) <= 4 else 2
    hits = process.extract(
        q, words, scorer=DamerauLevenshtein.distance, score_cutoff=cutoff, limit=24
    )
    ranked = sorted(hits, key=lambda h: (h[1], ranks[h[2]] or 10**9, len(h[0])))
    picked = [h[0] for h in ranked[:FUZZY_LIMIT]]
    heads = await _heads_by_lc(session, set(picked))
    return [heads[lc] for lc in picked if lc in heads]


async def _suggestions(session: AsyncSession, q: str) -> list[dict]:
    guesses = [g for g in lemma_guesses(q) if g != q]
    out: list[dict] = []
    if guesses:
        heads = await _heads_by_lc(session, set(guesses))
        out.extend(_entry(heads[g], "lemma_guess") for g in guesses if g in heads)
    seen = {e["lc"] for e in out}
    for head in await _fuzzy(session, q):
        if head.lc not in seen:
            seen.add(head.lc)
            out.append(_entry(head, "fuzzy"))
    return out[:FUZZY_LIMIT]


async def _search_en(session: AsyncSession, q: str, limit: int) -> dict:
    exact = await _heads(session, DictHead.lc == q, limit=4)
    lemma_lcs = {h.lemma.lower() for h in exact if h.lemma}
    lemma_heads = await _heads_by_lc(session, lemma_lcs)
    lemmas = [lemma_heads[lc] for lc in sorted(lemma_lcs) if lc in lemma_heads]
    base_words: list[str] = []
    for head in [h for h in exact if h.lemma is None] + lemmas:
        if head.word not in base_words:
            base_words.append(head.word)

    matches: list[DictHead] = []
    if len(q) >= 2:
        where = [*prefix_where(DictHead.lc, q), DictHead.lc != q, ~DictHead.lc.contains(" ")]
        # 两个字母的前缀在 170 万行里有几万条，只在学习者层里联想
        if len(q) == 2:
            where.append(DictHead.tier == 1)
        matches = await _heads(session, *where, limit=MATCH_CANDIDATES)
    phrases = await _heads(session, *prefix_where(DictHead.lc, q + " "), limit=PHRASE_LIMIT)
    substring: list[DictHead] = []
    if not exact and not matches and len(q) >= 3:
        substring = await _heads(
            session,
            DictHead.tier == 1,
            DictHead.lc.contains(q, autoescape=True),
            limit=SUBSTRING_LIMIT,
        )
    # 生僻的三层前缀词（abandan → abandannaad）不该把拼写建议挡掉：只有常用层命中才算「查到了」
    strong = exact or substring or any(h.tier <= 2 for h in matches)
    suggestions = [] if strong else await _suggestions(session, q)
    return {
        "exact": [_entry(h, "exact") for h in exact],
        "lemmas": [_entry(h, "lemma") for h in lemmas],
        "forms": await _forms(session, base_words),
        "matches": [_entry(h, "prefix") for h in matches[:limit]]
        + [_entry(h, "substring") for h in substring],
        "phrases": [_entry(h, "phrase") for h in phrases],
        "related": await _related(session, base_words),
        "reverse": [],
        "suggestions": suggestions,
    }


# ---- 中文反查 ----


async def _reverse(session: AsyncSession, q: str, limit: int) -> list[dict]:
    levels: list[tuple[str, list[ColumnElement]]] = [("exact", [DictGloss.gloss == q])]
    levels.append(("prefix", [*prefix_where(DictGloss.gloss, q), DictGloss.gloss != q]))
    # 子串只扫学习者层（十几万行），单字也扫：输「弃」要能看到放弃 / 抛弃 / 遗弃
    levels.append(("contains", [DictGloss.tier == 1, DictGloss.gloss.contains(q, autoescape=True)]))
    best: dict[str, tuple[tuple, DictGloss, str]] = {}
    for level_no, (level, where) in enumerate(levels):
        stmt = (
            select(DictGloss)
            .where(*where)
            .order_by(
                DictGloss.tier, DictGloss.sense_idx, DictGloss.frq_rank.nulls_last(), DictGloss.word
            )
            .limit(REVERSE_PER_LEVEL)
        )
        if best:
            stmt = stmt.where(DictGloss.word.not_in(best))
        for row in (await session.execute(stmt)).scalars():
            key = (
                level_no, row.tier, row.sense_idx, row.frq_rank or 10**9, len(row.word), row.word
            )
            current = best.get(row.word)
            if current is None or key < current[0]:
                best[row.word] = (key, row, level)
    # 三档各有配额：精确命中多的词（放弃 → 35 个）不能把前缀 / 子串那两档挤出一屏
    quota = {"exact": limit, "prefix": REVERSE_SECONDARY, "contains": REVERSE_SECONDARY}
    ranked = []
    for item in sorted(best.values(), key=lambda item: item[0]):
        level = item[2]
        if quota[level] <= 0:
            continue
        quota[level] -= 1
        ranked.append(item)
    heads = {
        h.word: h
        for h in await _heads(
            session, DictHead.word.in_([r.word for _, r, _ in ranked]), limit=len(ranked)
        )
    }
    out = []
    for _key, row, level in ranked:
        head = heads.get(row.word)
        if head is None:
            continue
        out.append(
            {**_entry(head, level), "gloss": row.gloss, "sense_idx": row.sense_idx, "pos": row.pos}
        )
    return out


# ---- 通配 ----


def glob_pattern(q: str) -> tuple[str, str]:
    """`ab*don` → (LIKE 模式, 首个通配符前的字面前缀)。用户打的 `%` `_` 先转义。"""
    literal = WILDCARD_RE.split(q, maxsplit=1)[0]
    pattern = (
        q.replace("\\", "\\\\")
        .replace("%", "\\%")
        .replace("_", "\\_")
        .replace("*", "%")
        .replace("?", "_")
    )
    return pattern, literal


async def _glob(session: AsyncSession, q: str, limit: int) -> list[dict]:
    pattern, literal = glob_pattern(q.lower())
    where: list[ColumnElement] = [DictHead.lc.like(pattern, escape="\\")]
    if len(literal) >= 2:
        where.extend(prefix_where(DictHead.lc, literal))
    else:
        where.append(DictHead.tier == 1)
    return [_entry(h, "glob") for h in await _heads(session, *where, limit=limit)]


# ---- 学习状态 ----


def _walk(result: dict):
    for key in ("exact", "lemmas", "matches", "phrases", "reverse", "suggestions", "items"):
        yield from result.get(key, [])
    for group in result.get("forms", []):
        yield from group["forms"]
    for entries in result.get("related", {}).values():
        yield from entries


async def attach_stages(session: AsyncSession, result: dict, owner_id: str) -> None:
    entries = list(_walk(result))
    lcs = {e["lc"] for e in entries}
    if not lcs:
        return
    stmt = select(VocabEntry).where(VocabEntry.user_id == owner_id, VocabEntry.word.in_(lcs))
    by_word = {v.word: v for v in (await session.execute(stmt)).scalars()}
    for entry in entries:
        vocab = by_word.get(entry["lc"])
        entry["stage"] = study_stage.stage(vocab)
        entry["in_vocab"] = vocab is not None
        entry["vocab_id"] = vocab.id if vocab is not None else None
        entry["mark"] = vocab.mark if vocab is not None else None


# ---- 入口 ----


async def search(session: AsyncSession, q: str, *, owner_id: str, limit: int = 20) -> dict:
    kind = classify(q)
    if not await is_ready(session):
        return {"ready": False, "hint": NOT_READY_HINT, "q": q, "kind": kind}
    empty = {
        "exact": [],
        "lemmas": [],
        "forms": [],
        "matches": [],
        "phrases": [],
        "related": {k: [] for k in RELATED_KINDS},
        "reverse": [],
        "suggestions": [],
    }
    if kind == "zh":
        # 反查一屏要看得到次要义项的词（放弃 → quit / desert 排在十几个首义词之后）
        body = {**empty, "reverse": await _reverse(session, q, max(limit, REVERSE_LIMIT))}
    elif kind == "glob":
        body = {**empty, "matches": await _glob(session, q, limit)}
    else:
        body = await _search_en(session, q.lower(), limit)
    result = {
        "ready": True,
        "q": q,
        "kind": kind,
        **body,
        "source": _source(await build_meta(session)),
    }
    await attach_stages(session, result, owner_id)
    return result


async def suggest(session: AsyncSession, q: str, *, owner_id: str, limit: int = 8) -> dict:
    """⌘K 联想的扁平版：不做变形展开与同义词。"""
    kind = classify(q)
    if not await is_ready(session):
        return {"ready": False, "hint": NOT_READY_HINT, "q": q, "kind": kind, "items": []}
    items: list[dict] = []
    if kind == "zh":
        items = await _reverse(session, q, limit)
    elif kind == "glob":
        items = await _glob(session, q, limit)
    else:
        lq = q.lower()
        exact = await _heads(session, DictHead.lc == lq, limit=2)
        seen = {h.lc for h in exact}
        # 精确命中置顶；但没词频又不是变形的三层词（aband「壹个组合」）压不过 abandon，排到联想后面
        pinned = [h for h in exact if h.tier <= 2 or h.lemma is not None]
        trailing = [h for h in exact if h not in pinned]
        items = [_entry(h, "exact") for h in pinned]
        prefix: list[dict] = []
        if len(lq) >= 2 and len(items) < limit:
            where = [*prefix_where(DictHead.lc, lq), DictHead.lc != lq]
            if len(lq) == 2:
                where.append(DictHead.tier == 1)
            for head in await _heads(session, *where, limit=limit):
                if head.lc not in seen:
                    seen.add(head.lc)
                    prefix.append(_entry(head, "phrase" if " " in head.lc else "prefix"))
        items += prefix + [_entry(h, "exact") for h in trailing]
        if not any(i["match"] == "exact" or i["tier"] <= 2 for i in items):
            items += await _suggestions(session, lq)
        items = items[:limit]
    result = {
        "ready": True,
        "q": q,
        "kind": kind,
        "items": items,
        "source": _source(await build_meta(session)),
    }
    await attach_stages(session, result, owner_id)
    return result
