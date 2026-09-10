"""单词本领域层（模块 05 v2）：四类本的同构视图与掌握度统计。

生词本、考纲本是虚拟本（不占 wordlist 表行），导入本与 AI 场景本落库，
列表接口统一返回同构对象，前端不按类型分支取数（FR-149）。
"""

from datetime import UTC, datetime

from sqlalchemy import ColumnElement, Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from domain.dict_forms import lemma_of as lemma_of
from domain.models import DictEntry, VocabEntry, Wordlist, WordlistItem, WordScene

# 掌握度四档，口径对齐 Anki：复习间隔满 21 天算 mature（已掌握）
MATURE_STABILITY_DAYS = 21.0

# 场景本分组：顺序即详情页的分节顺序（FR-159）
GROUP_LABELS: dict[str, str] = {
    "core_noun": "核心名词",
    "action": "常用动作",
    "descriptor": "描述词",
    "phrase": "高频短语",
    "pattern": "句型",
}

# FSRS difficulty 上界 10，超过 7 视为难词，供详情页「困难词」筛选（FR-160）
DIFFICULT_THRESHOLD = 7.0


def is_difficult(card: dict | None) -> bool:
    difficulty = (card or {}).get("difficulty")
    return isinstance(difficulty, int | float) and difficulty >= DIFFICULT_THRESHOLD


VOCAB_KEY = "__vocab__"  # 与前端 shared.ts 的 VOCAB_BOOK_KEY 同值，免去映射层
EXAM_WORDLISTS: dict[str, tuple[str, str]] = {
    "zk": ("中考", "📗"),
    "gk": ("高考", "📘"),
    "cet4": ("四级", "📙"),
    "cet6": ("六级", "📕"),
    "ky": ("考研", "🎓"),
    "toefl": ("托福", "🗽"),
    "ielts": ("雅思", "🎯"),
    "gre": ("GRE", "🏛"),
}


async def exam_totals(session: AsyncSession) -> dict[str, int]:
    """按标签组合扫描一次词典，再折算每个考纲的词数。"""
    rows = await session.execute(
        select(DictEntry.tag, func.count())
        .where(DictEntry.tag.is_not(None), DictEntry.tag != "")
        .group_by(DictEntry.tag)
    )
    totals = dict.fromkeys(EXAM_WORDLISTS, 0)
    for tags, count in rows:
        for key in set(tags.split()):
            if key in totals:
                totals[key] += count
    return totals


def empty_mastery() -> dict[str, int]:
    return {"new": 0, "learning": 0, "young": 0, "mature": 0, "hard": 0}


def mastery_bucket(card: dict | None) -> str:
    """按 FSRS 卡片状态归档：未复习过算 learning，稳定度过 21 天算 mature。"""
    if not card or card.get("last_review") is None:
        return "learning"
    if card.get("state") in (1, 3):  # learning / relearning
        return "learning"
    stability = card.get("stability")
    if isinstance(stability, int | float) and stability >= MATURE_STABILITY_DAYS:
        return "mature"
    return "young"


def color_seed_of(text: str) -> int:
    """本名哈希成稳定色种，前端据此算渐变，导入本无需人工配色。"""
    seed = 0
    for ch in text:
        seed = (seed * 31 + ord(ch)) % 360
    return seed


async def learned_index(session: AsyncSession, user_id: str | None = None) -> dict[str, dict]:
    """全量已学词索引 {word: {bucket, tag, last_review_at}}。

    vocab_entry 是用户已学词集合（千级），一次拉全比按本发多次 join 更省；
    考纲本的 340 万行只贡献 total，不参与掌握度计算。
    """
    from domain import study_stage

    rows = (
        await session.execute(
            select(
                VocabEntry.word,
                study_stage.sql_stage(session.bind.dialect.name),
                VocabEntry.last_review_at,
                DictEntry.tag,
                VocabEntry.due_at,
            )
            .outerjoin(DictEntry, DictEntry.word == VocabEntry.word)
            .where(VocabEntry.user_id == user_id if user_id is not None else True)
        )
    ).all()
    missing_tags = [word for word, _, _, tag, _ in rows if not tag]
    tags = {}
    if missing_tags:
        tags = dict((await session.execute(
            select(func.lower(DictEntry.word), DictEntry.tag)
            .where(func.lower(DictEntry.word).in_(missing_tags), DictEntry.tag.is_not(None))
        )).all())
    return {
        word: {
            "bucket": study_stage.STAGE_BUCKET[stage],
            "tags": set((tag or tags.get(word) or "").split()),
            "last_review_at": last_review_at,
            "due_at": due_at,
        }
        for word, stage, last_review_at, tag, due_at in rows
    }


def _fold(
    words: list[str], index: dict[str, dict], total: int
) -> tuple[dict[str, int], datetime | None]:
    """把一批词按索引折算成四档分布，未在索引中的记为 new。"""
    mastery = empty_mastery()
    last: datetime | None = None
    for word in words:
        hit = index.get(word) or index.get(word.lower())
        if hit is None:
            mastery["new"] += 1
            continue
        mastery[hit["bucket"]] += 1
        when = hit["last_review_at"]
        if when is not None and (last is None or when > last):
            last = when
    # total 大于明细行数时（考纲本只统计已学词），差额补进 new
    mastery["new"] += max(total - sum(mastery.values()), 0)
    return mastery, last


def deck_view(
    *,
    key: str,
    name: str,
    kind: str,
    total: int,
    mastery: dict[str, int],
    emoji: str | None = None,
    color_seed: int | None = None,
    last_studied_at: datetime | None = None,
    description: str | None = None,
    category: str | None = None,
    cefr: str | None = None,
    source: str = "builtin",
    status: str = "ready",
    pinned: bool = False,
    archived: bool = False,
    daily_new_limit: int = 10,
    deletable: bool = False,
    editable: bool = False,
    cover_url: str | None = None,
) -> dict:
    """单词本对外统一形状：四类本共用，前端只认这一种结构。"""
    learned = total - mastery["new"]
    return {
        "key": key,
        "name": name,
        "kind": kind,
        "emoji": emoji,
        "color_seed": color_seed if color_seed is not None else color_seed_of(key),
        # AI 生成封面（模块 16 FR-420）。为空则前端回落 emoji + 渐变——
        # 那套兜底零请求、离线可用，不因为有了生图就删
        "cover_url": cover_url,
        "description": description,
        "category": category,
        "cefr": cefr,
        "source": source,
        "status": status,
        "total": total,
        "learned": max(learned, 0),
        "mastery": mastery,
        "last_studied_at": last_studied_at.isoformat() if last_studied_at else None,
        "pinned": pinned,
        "archived": archived,
        "daily_new_limit": daily_new_limit,
        "deletable": deletable,
        "editable": editable,
    }


def vocab_deck(index: dict[str, dict]) -> dict:
    """生词本：收藏与领取的全部词，恒存在且不可删（BR-29）。"""
    mastery, last = _fold(list(index.keys()), index, len(index))
    return deck_view(
        key=VOCAB_KEY,
        name="生词本",
        kind="system",
        emoji="⭐",
        color_seed=42,
        description="阅读、视频、口语里收藏的词",
        total=len(index),
        mastery=mastery,
        last_studied_at=last,
    )


def exam_deck(key: str, total: int, index: dict[str, dict], cover_key: str | None = None) -> dict:
    """考纲本：total 走 ECDICT tag 统计，掌握度只看已学词命中该 tag 的部分。

    封面按 deck key 走 `deck_cover` 表（FR-420a）——考纲本是虚拟的，没有
    wordlist 行，`wordlist.cover_key` 那条路走不通。
    """
    name, emoji = EXAM_WORDLISTS[key]
    words = [w for w, hit in index.items() if key in hit["tags"]]
    mastery, last = _fold(words, index, total)
    return deck_view(
        key=key,
        name=name,
        kind="exam",
        emoji=emoji,
        color_seed=color_seed_of(key),
        total=total,
        mastery=mastery,
        last_studied_at=last,
        cover_url=key_cover_url(key, cover_key),
    )


def key_cover_url(key: str, cover_key: str | None) -> str | None:
    """虚拟本的封面 URL。形状与 `_cover_url` 一致（/api 前缀 + ?v= 版本参数），
    两处踩过的坑同样适用：少 /api 会被 SPA 吞成 index.html，少 ?v= 换图一周不刷新。"""
    if not cover_key:
        return None
    return f"/api/wordlists/key/{key}/cover?v={cover_key[-12:]}"


def custom_deck(row: Wordlist, words: list[str], total: int, index: dict[str, dict]) -> dict:
    """导入本与场景本：明细在 wordlist_item，封面与元信息取自本行。"""
    mastery, last = _fold(words, index, total)
    return deck_view(
        key=f"custom:{row.id}",
        name=row.name,
        kind="scenario" if row.kind == "scenario" else "custom",
        emoji=row.emoji,
        color_seed=row.color_seed or color_seed_of(row.name),
        description=row.description,
        category=row.category,
        cefr=row.cefr,
        source=row.source,
        status=row.status,
        total=total,
        mastery=mastery,
        last_studied_at=last,
        pinned=row.pinned_at is not None,
        archived=row.archived_at is not None,
        daily_new_limit=row.daily_new_limit,
        deletable=True,
        editable=True,
        cover_url=_cover_url(row),
    )


def _cover_url(row: Wordlist) -> str | None:
    """封面 URL：必须带 /api 前缀与 ?v= 版本参数。

    没有 /api 会被 SPA 回落吞成 index.html（图片静默失败），没有 ?v= 则换了封面
    一周内看不到新图（媒体响应是一周强缓存）。两条都是踩过的坑。
    """
    if not row.cover_key:
        return None
    # 封面 key 自带内容指纹，换图即换 key，版本参数取 id 足够让 URL 变化
    return f"/api/wordlists/{row.id}/cover?v={row.cover_key[-12:]}"


async def custom_deck_words(
    session: AsyncSession, user_id: str | None = None
) -> tuple[dict[int, list[str]], dict[int, int]]:
    """落库本的词归属与总数。

    只取已学词的归属明细（受 vocab_entry 量级约束），总数走 SQL 聚合，
    避免把上万词的导入本整表拉进内存。
    """
    owned = (
        await session.execute(
            select(WordlistItem.wordlist_id, WordlistItem.word).join(
                VocabEntry,
                (VocabEntry.word == func.lower(WordlistItem.word))
                & (VocabEntry.user_id == user_id if user_id is not None else True),
            )
        )
    ).all()
    words: dict[int, list[str]] = {}
    for wordlist_id, word in owned:
        words.setdefault(wordlist_id, []).append(word)
    totals = dict(
        (
            await session.execute(
                select(WordlistItem.wordlist_id, func.count()).group_by(WordlistItem.wordlist_id)
            )
        ).all()
    )
    return words, totals


def now_utc() -> datetime:
    return datetime.now(UTC)


# ---- 本 → 词集合 / 本名 / 例句语境（清缓存、清进度、AI 补全共用，FR-499~502） ----


class UnknownDeck(LookupError):
    """key 不是四类本之一。domain 层不引 fastapi，router 包一层转 404。"""


def tag_filter(key: str) -> ColumnElement[bool]:
    # tag 为空格分隔标签串，前后补空格后按 " key " 整词匹配
    return func.concat(" ", DictEntry.tag, " ").like(f"% {key} %")


def custom_id_of(key: str) -> int | None:
    """ "custom:3" → 3；非自定义 key 返回 None，格式坏了抛 UnknownDeck。"""
    if not key.startswith("custom:"):
        return None
    try:
        return int(key.split(":", 1)[1])
    except ValueError:
        raise UnknownDeck(key) from None


def deck_words_select(key: str) -> Select | None:
    """本 → 词列子查询；空 key 或生词本返回 None 表示「全部」。

    考纲本上万词别展开成 IN (...) 参数（SQLite 有参数上限），两库都吃子查询。
    """
    if not key or key == VOCAB_KEY:
        return None
    custom_id = custom_id_of(key)
    if custom_id is not None:
        return select(WordlistItem.word).where(WordlistItem.wordlist_id == custom_id)
    if key not in EXAM_WORDLISTS:
        raise UnknownDeck(key)
    return select(DictEntry.word).where(tag_filter(key))


async def deck_words(session: AsyncSession, key: str) -> set[str] | None:
    """本 → 词集合；None 表示不过滤（生词本）。"""
    stmt = deck_words_select(key)
    if stmt is None:
        return None
    return set((await session.execute(stmt)).scalars())


async def deck_name(session: AsyncSession, key: str) -> str:
    """与 GET /wordlists 列表里的 name 一字不差：AI 补全拼语境要靠它命中词卡的指纹。"""
    if key == VOCAB_KEY:
        return "生词本"
    custom_id = custom_id_of(key)
    if custom_id is not None:
        row = await session.get(Wordlist, custom_id)
        if row is None:
            raise UnknownDeck(key)
        return row.name
    if key not in EXAM_WORDLISTS:
        raise UnknownDeck(key)
    return EXAM_WORDLISTS[key][0]


async def deck_word_contexts(
    session: AsyncSession, key: str, user_id: str
) -> list[tuple[str, str | None]]:
    """本内 (词, 例句) 按词排序。例句来源与 wordlists._item_row 同一口径：
    场景本取 WordlistItem.example_en，考纲本取 WordScene.example_en，生词本没有例句。"""
    if key == VOCAB_KEY:
        stmt = (
            select(VocabEntry.word)
            .where(VocabEntry.user_id == user_id)
            .distinct()
            .order_by(VocabEntry.word)
        )
        return [(w, None) for w in (await session.execute(stmt)).scalars()]
    custom_id = custom_id_of(key)
    if custom_id is not None:
        stmt = (
            select(WordlistItem.word, WordlistItem.example_en)
            .where(WordlistItem.wordlist_id == custom_id)
            .order_by(WordlistItem.word)
        )
        return [(w, ex) for w, ex in (await session.execute(stmt)).all()]
    if key not in EXAM_WORDLISTS:
        raise UnknownDeck(key)
    stmt = (
        select(DictEntry.word, WordScene.example_en)
        .outerjoin(WordScene, WordScene.word == DictEntry.word)
        .where(tag_filter(key))
        .order_by(DictEntry.word)
    )
    return [(w, ex) for w, ex in (await session.execute(stmt)).all()]
