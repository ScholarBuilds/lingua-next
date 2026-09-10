"""词表（模块 05）：考纲虚拟词表（ECDICT tag）+ 自定义词表导入，浏览进度 + 领取新词。

自定义词表 key 形如 "custom:3"；导入两步走：预览（redis 暂存 10 分钟）→ 确认落库。
"""

import asyncio
import hashlib
import json
import re
import time
import uuid
from datetime import UTC, datetime
from typing import Literal, NoReturn

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field
from sqlalchemy import ColumnElement, delete, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from app.config import get_settings
from app.media import media_response
from app.owner import CurrentOwner
from app.queue import get_queue
from app.routers.dict import SessionDep, freq_band
from domain import (
    deck_ai,
    decks,
    learning_receipts,
    srs,
    study_reset,
    study_stage,
    tts_cache,
)
from domain.imports import parse_wordlist
from domain.models import (
    ConfigAudit,
    DeckCover,
    DeckScene,  # 分组按本，例句按词（见两个模型的注释）
    DeckSceneState,
    DictEntry,
    Sentence,
    SubtitleSentence,
    SubtitleTrack,
    VocabEntry,
    VocabOccurrence,
    Wordlist,
    WordlistItem,
    WordScene,
)

router = APIRouter(prefix="/wordlists", tags=["wordlists"])

# 考纲本名录收敛到 domain/decks（含封面 emoji），此处保留名称映射供校验使用
WORDLISTS: dict[str, str] = {key: name for key, (name, _emoji) in decks.EXAM_WORDLISTS.items()}

IMPORT_TOKEN_TTL = 600  # 预览 token 有效期 10 分钟

# 词频位次低于此值的是通用高频词，不作为场景推荐的证据（FR-234）
COMMON_WORD_FRQ = 4000
# 特征词命中下限：低于此数视为偶然重合，不构成推荐理由
MIN_FEATURE_HITS = 3

# 考纲总数与用户进度无关；缓存标签聚合结果，避免反复扫描词典。
_TOTAL_TTL = 300.0
_total_cache: dict[str, tuple[float, int]] = {}


def _tag_filter(key: str) -> ColumnElement[bool]:
    return decks.tag_filter(key)


def _frq_order() -> tuple[ColumnElement, ...]:
    # ECDICT 无词频数据的行存 0 而非 NULL，一并排到最后，避免专有名词/缩写霸榜
    return (func.nullif(DictEntry.frq, 0).asc().nulls_last(), DictEntry.word.asc())


def _require_key(key: str) -> None:
    if key not in WORDLISTS:
        raise HTTPException(status_code=404, detail="unknown wordlist")


def _custom_id(key: str) -> int | None:
    """ "custom:3" → 3；非自定义 key 返回 None，格式坏了 404。"""
    try:
        return decks.custom_id_of(key)
    except decks.UnknownDeck:
        raise HTTPException(status_code=404, detail="unknown wordlist") from None


async def _get_custom(session, wordlist_id: int) -> Wordlist:
    wordlist = await session.get(Wordlist, wordlist_id)
    if wordlist is None:
        raise HTTPException(status_code=404, detail="unknown wordlist")
    return wordlist


def _import_key(token: str) -> str:
    return f"wordlist_import:{token}"


class ImportBody(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    format: Literal["csv", "tsv", "json"]
    content: str


class ImportConfirmBody(BaseModel):
    token: str


@router.post("/import")
async def preview_import(body: ImportBody) -> dict:
    """解析并预览，不落库；token 十分钟内可确认。"""
    try:
        items, dup, invalid = parse_wordlist(body.content, body.format)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    if not items:
        raise HTTPException(status_code=400, detail="没有可导入的词条")
    token = uuid.uuid4().hex
    payload = {"name": body.name.strip(), "items": items, "dup": dup}
    queue = await get_queue()
    await queue.set(_import_key(token), json.dumps(payload), ex=IMPORT_TOKEN_TTL)
    return {
        "token": token,
        "new": len(items),
        "dup": dup,
        "invalid": invalid[:50],
        "sample": [{"word": w, "translation": t} for w, t in items[:10]],
    }


@router.post("/import/confirm", status_code=201)
async def confirm_import(body: ImportConfirmBody, session: SessionDep) -> dict:
    queue = await get_queue()
    raw = await queue.get(_import_key(body.token))
    if raw is None:
        raise HTTPException(status_code=410, detail="导入预览已过期，请重新提交")
    payload = json.loads(raw)
    wordlist = Wordlist(name=payload["name"], kind="custom")
    session.add(wordlist)
    await session.flush()
    for ordinal, (word, translation) in enumerate(payload["items"]):
        session.add(
            WordlistItem(
                wordlist_id=wordlist.id, word=word, translation=translation, ordinal=ordinal
            )
        )
    await session.commit()
    await queue.delete(_import_key(body.token))  # 一次性 token，防重复建表
    return {
        "wordlist_id": wordlist.id,
        "key": f"custom:{wordlist.id}",
        "imported": len(payload["items"]),
        "skipped": payload["dup"],
    }


@router.delete("/{key}")
async def delete_wordlist(key: str, session: SessionDep) -> dict:
    wordlist_id = _custom_id(key)
    if wordlist_id is None:
        raise HTTPException(status_code=400, detail="内置考纲词表不可删除")
    wordlist = await _get_custom(session, wordlist_id)
    await session.delete(wordlist)  # 级联删除 wordlist_item
    await session.commit()
    return {"ok": True}


@router.get("")
async def list_wordlists(
    owner: CurrentOwner, session: SessionDep, include_archived: bool = True
) -> list[dict]:
    """四类单词本同构列表（FR-149）：生词本 + 考纲本 + 场景本 + 导入本。

    词汇阶段在数据库派生后共用索引，避免为每个本各发一次 join；
    考纲总数按标签组合一次聚合，并缓存 5 分钟。
    """
    now = time.monotonic()
    index = await decks.learned_index(session, owner.id)
    out: list[dict] = [decks.vocab_deck(index)]

    # 虚拟本（生词本 + 八个考纲本）的封面按 deck key 存，一次取全省得逐个查
    covers = {r.key: r.storage_key for r in (await session.execute(select(DeckCover))).scalars()}

    if any(_total_cache.get(key, (0, 0))[0] <= now for key in decks.EXAM_WORDLISTS):
        totals = await decks.exam_totals(session)
        expires_at = time.monotonic() + _TOTAL_TTL
        _total_cache.update({key: (expires_at, total) for key, total in totals.items()})
    for key in decks.EXAM_WORDLISTS:
        total = _total_cache[key][1]
        out.append(decks.exam_deck(key, total, index, covers.get(key)))

    words_by_list, totals = await decks.custom_deck_words(session, owner.id)
    stmt = select(Wordlist).order_by(Wordlist.id)
    if not include_archived:
        stmt = stmt.where(Wordlist.archived_at.is_(None))
    for row in (await session.execute(stmt)).scalars():
        # 草稿本不进正式列表，只允许草稿预览页按 id 直取（BR-32）
        if row.status == "draft":
            continue
        out.append(
            decks.custom_deck(row, words_by_list.get(row.id, []), totals.get(row.id, 0), index)
        )
    cutoff = datetime.now(UTC).replace(tzinfo=None)
    due_words = {
        word
        for word, hit in index.items()
        if hit.get("due_at") and hit["due_at"].replace(tzinfo=None) <= cutoff
    }
    for item in out:
        key = item["key"]
        if key == decks.VOCAB_KEY:
            item["due_now"] = len(due_words)
        elif key in decks.EXAM_WORDLISTS:
            item["due_now"] = sum(key in index[word]["tags"] for word in due_words)
        else:
            item["due_now"] = len(due_words.intersection(words_by_list.get(_custom_id(key), [])))
    return out


class DeckPatchBody(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    emoji: str | None = Field(default=None, max_length=16)
    description: str | None = None
    color_seed: int | None = Field(default=None, ge=0, le=359)
    daily_new_limit: int | None = Field(default=None, ge=1, le=50)
    pinned: bool | None = None
    archived: bool | None = None


@router.patch("/{key}")
async def patch_wordlist(key: str, body: DeckPatchBody, session: SessionDep) -> dict:
    """改名 / 换封面 / 置顶 / 归档 / 每日新词上限（FR-150、FR-179）。"""
    wordlist_id = _custom_id(key)
    if wordlist_id is None:
        raise HTTPException(status_code=400, detail="内置词表不可编辑")
    wordlist = await _get_custom(session, wordlist_id)
    now = datetime.now(UTC)
    for field in ("name", "emoji", "description", "color_seed", "daily_new_limit"):
        value = getattr(body, field)
        if value is not None:
            setattr(wordlist, field, value)
    if body.pinned is not None:
        wordlist.pinned_at = now if body.pinned else None
    if body.archived is not None:
        wordlist.archived_at = now if body.archived else None
    await session.commit()
    await session.refresh(wordlist)  # onupdate 列 commit 后需 refresh，否则 MissingGreenlet
    index = await decks.learned_index(session)
    words_by_list, totals = await decks.custom_deck_words(session)
    return decks.custom_deck(
        wordlist, words_by_list.get(wordlist.id, []), totals.get(wordlist.id, 0), index
    )


ITEM_FILTERS = ("all", "new", "learning", "mastered", "difficult")
ITEM_SORTS = ("default", "alpha", "freq", "recent")


def _bucket_of(vocab: VocabEntry | None) -> str:
    """浏览状态：未学、学习中、困难词、已掌握；通过自测归入学习中。"""
    return study_stage.STAGE_BUCKET[study_stage.stage(vocab)]


def _item_row(
    word: str,
    entry: DictEntry | None,
    vocab: VocabEntry | None,
    *,
    fallback_translation: str | None = None,
    item: WordlistItem | None = None,
    scene: DeckScene | None = None,
    example: WordScene | None = None,
) -> dict:
    """词条对外统一形状：四类本共用，词典字段缺失时回落本自带释义。

    考纲本是虚拟的（没有 wordlist_item），素材分两处：分组按本存 `deck_scene`
    （「一本分多少组」是本的属性），例句按词存 `word_scene`（跨本共用一句）。
    三个来源在这里合流成同一组字段，前端不必区分本的种类。
    """
    card = vocab.fsrs_card if vocab else None
    return {
        "word": word,
        "phonetic": entry.phonetic if entry else None,
        "pos": entry.pos if entry else None,
        "translation": (entry.translation if entry and entry.translation else fallback_translation),
        "definition": entry.definition if entry else None,
        "frq": entry.frq if entry else None,
        "freq_band": freq_band(entry.frq) if entry else None,
        "tags": entry.tag.split() if entry and entry.tag else [],
        "collins": entry.collins if entry else None,
        "exchange": entry.exchange if entry else None,
        "status": study_stage.status_of(study_stage.stage(vocab)),
        # 入册不等于学习，空卡的状态由接触记录与人工标记判定。
        "bucket": _bucket_of(vocab),
        "difficult": study_stage.is_hard(vocab, card),
        # 人工标记单独回传：徽标要能区分「算法判的」与「我自己标的」，
        # 只给折算后的 bucket 的话，用户按下「已掌握」后看到的和算法判的长得一样
        "mark": study_stage.normalize_mark(vocab.mark) if vocab else None,
        "vocab_id": vocab.id if vocab else None,
        "due_at": vocab.due_at.isoformat() if vocab and vocab.due_at else None,
        "group_key": item.group_key if item else (scene.scene if scene else None),
        "example_en": item.example_en if item else (example.example_en if example else None),
        "example_zh": item.example_zh if item else (example.example_zh if example else None),
        "dict_miss": bool(item.dict_miss) if item else False,
        # 考纲本的分组是「场景」，比 wordlist_item 的五类语法分组多一层信息：
        # track 说明这一组是按具象场景 / 词根词族 / 抽象主题组的，前端据此换呈现
        "scene_track": scene.track if scene else None,
        "scene_root": scene.root if scene else None,
    }


@router.get("/recommend")
async def recommend_decks(
    session: SessionDep,
    video_id: int | None = None,
    article_id: int | None = None,
    limit: int = 3,
) -> list[dict]:
    """按当前学习内容推荐场景本（FR-233、FR-234）。

    推荐必须可解释：返回命中了哪些词、命中率多少，不做黑盒推荐（BR-04）。
    """
    words = await _content_words(session, video_id, article_id)
    if len(words) < 5:
        return []
    rows = (
        await session.execute(
            select(WordlistItem.wordlist_id, WordlistItem.word, Wordlist.name, Wordlist.emoji)
            .join(Wordlist, Wordlist.id == WordlistItem.wordlist_id)
            .join(DictEntry, DictEntry.word == WordlistItem.word)
            .where(
                Wordlist.kind == "scenario",
                Wordlist.status == "ready",
                Wordlist.archived_at.is_(None),
                WordlistItem.word.in_(words),
                # 只认特征词：add/make/hot 这类超高频词在任何内容里都会出现，
                # 不过滤的话推荐会退化成"谁的通用词多谁被推荐"（实测烹饪视频被推咖啡拉花，
                # 命中的全是 add/fresh/light）。ECDICT 的 frq 就是现成的区分度指标。
                DictEntry.frq > COMMON_WORD_FRQ,
            )
        )
    ).all()
    if not rows:
        return []
    hits: dict[int, dict] = {}
    for wordlist_id, word, name, emoji in rows:
        bucket = hits.setdefault(wordlist_id, {"name": name, "emoji": emoji, "words": []})
        bucket["words"].append(word)

    totals = dict(
        (
            await session.execute(
                select(WordlistItem.wordlist_id, func.count())
                .where(WordlistItem.wordlist_id.in_(hits))
                .group_by(WordlistItem.wordlist_id)
            )
        ).all()
    )
    out = [
        {
            "key": f"custom:{wordlist_id}",
            "name": data["name"],
            "emoji": data["emoji"],
            "matched": len(data["words"]),
            "total": int(totals.get(wordlist_id, 0)),
            # 覆盖率 = 该本有多少词出现在了当前内容里，这是推荐理由的量化形式
            "coverage": round(len(data["words"]) / max(int(totals.get(wordlist_id, 1)), 1), 3),
            "sample": sorted(data["words"])[:8],
        }
        for wordlist_id, data in hits.items()
    ]
    # 阈值定在 3 是因为上面已经滤掉了通用词：3 个特征词重合（queue/suitcase/scan）
    # 比 16 个通用词重合（add/fresh/hot）有说服力得多
    out = [r for r in out if r["matched"] >= MIN_FEATURE_HITS]
    out.sort(key=lambda r: (-r["matched"], -r["coverage"]))
    return out[: max(1, min(limit, 10))]


async def _content_words(session, video_id: int | None, article_id: int | None) -> set[str]:
    """取一段内容里出现过的词形集合（小写去重）。"""
    texts: list[str] = []
    if video_id is not None:
        rows = (
            await session.execute(
                select(SubtitleSentence.text)
                .join(SubtitleTrack, SubtitleTrack.id == SubtitleSentence.track_id)
                .where(SubtitleTrack.video_id == video_id, SubtitleSentence.is_noise.is_(False))
            )
        ).scalars()
        texts = list(rows)
    elif article_id is not None:
        rows = (
            await session.execute(select(Sentence.text).where(Sentence.article_id == article_id))
        ).scalars()
        texts = list(rows)
    words: set[str] = set()
    for text in texts:
        for token in re.findall(r"[A-Za-z][A-Za-z'-]*", text or ""):
            if len(token) > 2:
                words.add(token.lower())
    return words


@router.get("/{key}/words")
async def wordlist_words(
    key: str,
    owner: CurrentOwner,
    session: SessionDep,
    offset: int = 0,
    limit: int = 50,
    filter: str = "all",
    sort: str = "default",
    q: str = "",
    group: str = "",
) -> dict:
    """单词本词条列表（FR-160）：四类本同构返回，支持筛选、排序、本内搜索、分组。"""
    offset = max(offset, 0)
    # 上限 500 而不是 200：场景要一次铺开，而雅思「自然环境」实测 221 词，
    # 卡在 200 会静默丢掉后面的词——「一次取全一个场景」就成了假的
    limit = min(max(limit, 1), 500)
    if filter not in ITEM_FILTERS:
        filter = "all"
    if sort not in ITEM_SORTS:
        sort = "default"
    keyword = q.strip().lower()

    if key == decks.VOCAB_KEY:
        return await _vocab_words(session, owner.id, offset, limit, filter, sort, keyword)
    custom_id = _custom_id(key)
    if custom_id is not None:
        return await _custom_words(
            session, owner.id, custom_id, offset, limit, filter, sort, keyword, group
        )
    _require_key(key)
    return await _exam_words(session, owner.id, key, offset, limit, filter, sort, keyword, group)


async def _vocab_words(
    session, user_id: str, offset: int, limit: int, filter: str, sort: str, keyword: str
) -> dict:
    """生词本：VocabEntry 驱动，附最近一次收藏语境供词卡使用。"""
    stmt = (
        select(VocabEntry, DictEntry)
        .outerjoin(DictEntry, DictEntry.word == VocabEntry.word)
        .where(VocabEntry.user_id == user_id)
    )
    if keyword:
        stmt = stmt.where(VocabEntry.word.ilike(f"%{keyword}%"))
    stmt = stmt.where(study_stage.sql_filter(filter, session.bind.dialect.name))
    total = await session.scalar(select(func.count()).select_from(stmt.subquery()))
    order = _item_order(sort, VocabEntry.word, (VocabEntry.created_at.desc(), VocabEntry.word))
    pairs = (await session.execute(stmt.order_by(*order).offset(offset).limit(limit))).all()
    rows = [_item_row(v.word, d, v) for v, d in pairs]
    return {"items": rows, "total": total, "groups": []}


async def _exam_words(
    session,
    user_id: str,
    key: str,
    offset: int,
    limit: int,
    filter: str,
    sort: str,
    keyword: str,
    group: str = "",
) -> dict:
    """考纲本：ECDICT tag 虚拟表，词频序为默认序，过滤与分页在数据库执行。

    `word_scene` 带的场景归属与例句在这里 LEFT JOIN 进来。它按词存不按本存——
    八本词次 38,855 去重后只有 14,942，按本存同一句例句要写六遍还会不一致。
    `group` 传场景名时只出该场景的词，这是「按场景一个个学」的取词口径。
    """
    base = (
        select(DictEntry, VocabEntry, DeckScene, WordScene)
        .outerjoin(
            VocabEntry,
            (VocabEntry.word == func.lower(DictEntry.word)) & (VocabEntry.user_id == user_id),
        )
        .outerjoin(DeckScene, (DeckScene.word == DictEntry.word) & (DeckScene.deck == key))
        .outerjoin(WordScene, WordScene.word == DictEntry.word)
        .where(_tag_filter(key))
    )
    if keyword:
        base = base.where(DictEntry.word.ilike(f"%{keyword}%"))
    if group:
        base = base.where(DeckScene.scene == group)
    base = base.where(study_stage.sql_filter(filter, session.bind.dialect.name))
    total = await session.scalar(select(func.count()).select_from(base.subquery()))
    stmt = base.order_by(*_exam_order(sort)).offset(offset).limit(limit)
    rows = [
        _item_row(d.word, d, v, scene=sc, example=ex)
        for d, v, sc, ex in (await session.execute(stmt)).all()
    ]
    return {
        "items": rows,
        "total": total,
        "groups": await _exam_groups(session, user_id, key),
    }


async def _exam_groups(session, user_id: str, key: str) -> list[dict]:
    """考纲本的场景清单：按 track 再按词数排，具象场景在前、抽象主题在后。

    这就是「学完本里所有场景」的清单本身。`deck_scene` 主键带 deck，
    所以按 deck 过滤就是该本的口径，不必再回 dict_entry 过 tag。
    """
    rows = (
        await session.execute(
            select(
                DeckScene.scene,
                DeckScene.track,
                DeckScene.root,
                func.count(),
                # 已入册的词数（进了生词本）。**不是**「学会了」——
                # 这个字段早就被两处 UI 消费，改语义会让新旧进度打架，所以并列加 passed
                func.count(VocabEntry.id),
                # 通过自测的词数：这才是「学会」的口径
                func.count(VocabEntry.self_test_at),
            )
            .outerjoin(
                VocabEntry,
                (VocabEntry.word == func.lower(DeckScene.word)) & (VocabEntry.user_id == user_id),
            )
            .where(DeckScene.deck == key)
            .group_by(DeckScene.scene, DeckScene.track, DeckScene.root)
        )
    ).all()
    order = {"scene": 0, "family": 1, "theme": 2}
    out = [
        {
            "key": scene,
            "label": scene,
            "count": int(n),
            "learned": int(learned),
            "passed": int(passed),
            "track": track,
            "root": root,
        }
        for scene, track, root, n, learned, passed in rows
        if scene
    ]
    out.sort(key=lambda g: (order.get(g["track"], 9), -g["count"], g["key"]))
    return out


async def _custom_words(
    session,
    user_id: str,
    custom_id: int,
    offset: int,
    limit: int,
    filter: str,
    sort: str,
    keyword: str,
    group: str,
) -> dict:
    """导入本与场景本：明细在 wordlist_item，附分组统计供详情页分节。"""
    await _get_custom(session, custom_id)
    base = (
        select(WordlistItem, DictEntry, VocabEntry)
        .outerjoin(DictEntry, DictEntry.word == WordlistItem.word)
        .outerjoin(
            VocabEntry,
            (VocabEntry.word == func.lower(WordlistItem.word)) & (VocabEntry.user_id == user_id),
        )
        .where(WordlistItem.wordlist_id == custom_id)
    )
    if keyword:
        base = base.where(WordlistItem.word.ilike(f"%{keyword}%"))
    if group:
        base = base.where(WordlistItem.group_key == group)
    base = base.where(study_stage.sql_filter(filter, session.bind.dialect.name))
    total = await session.scalar(select(func.count()).select_from(base.subquery()))
    order = _item_order(sort, WordlistItem.word, (WordlistItem.ordinal, WordlistItem.id))
    pairs = (await session.execute(base.order_by(*order).offset(offset).limit(limit))).all()
    rows = [
        _item_row(i.word, d, v, fallback_translation=i.translation, item=i) for i, d, v in pairs
    ]

    groups = (
        await session.execute(
            select(
                WordlistItem.group_key,
                func.count(),
                func.count(VocabEntry.id),
                func.count(VocabEntry.self_test_at),
            )
            .outerjoin(
                VocabEntry,
                (VocabEntry.word == func.lower(WordlistItem.word))
                & (VocabEntry.user_id == user_id),
            )
            .where(WordlistItem.wordlist_id == custom_id)
            .group_by(WordlistItem.group_key)
            .order_by(func.min(WordlistItem.ordinal))
        )
    ).all()
    group_view = [
        {
            "key": g,
            "label": decks.GROUP_LABELS.get(g, g),
            "count": int(n),
            "learned": int(learned),
            "passed": int(passed),
        }
        for g, n, learned, passed in groups
        if g is not None
    ]
    group_view.sort(
        key=lambda x: (
            list(decks.GROUP_LABELS).index(x["key"]) if x["key"] in decks.GROUP_LABELS else 99
        )
    )
    return {"items": rows, "total": total, "groups": group_view}


def _item_order(sort: str, word, default: tuple) -> tuple:
    if sort == "alpha":
        return (word.asc(),)
    if sort == "freq":
        return (func.nullif(DictEntry.frq, 0).asc().nulls_last(), word.asc())
    if sort == "recent":
        return (VocabEntry.due_at.asc().nulls_last(), word.asc())
    return default


def _exam_order(sort: str) -> tuple:
    if sort == "alpha":
        return (DictEntry.word.asc(),)
    if sort == "recent":
        return (VocabEntry.last_review_at.desc().nulls_last(), DictEntry.word.asc())
    return _frq_order()


class BatchBody(BaseModel):
    """本内多选批量操作（FR-161）。remove 只对可编辑的本生效。"""

    action: Literal["collect", "master", "remove"]
    words: list[str] = Field(min_length=1, max_length=500)


@router.post("/{key}/batch")
async def batch_words(key: str, body: BatchBody, owner: CurrentOwner, session: SessionDep) -> dict:
    words = list(dict.fromkeys(w.strip().lower() for w in body.words if w.strip()))
    if not words:
        raise HTTPException(status_code=400, detail="没有选中词条")
    custom_id = _custom_id(key)
    if body.action == "remove":
        if custom_id is None:
            raise HTTPException(status_code=400, detail="该本不支持移出词条")
        await _get_custom(session, custom_id)
        result = await session.execute(
            delete(WordlistItem).where(
                WordlistItem.wordlist_id == custom_id, WordlistItem.word.in_(words)
            )
        )
        await session.commit()
        # 移出只解除归属，vocab_entry 与复习记录不动（BR-29）
        return {"action": "remove", "affected": result.rowcount or 0}

    now = datetime.now(UTC)
    existing = {
        row.word: row
        for row in (
            await session.execute(
                select(VocabEntry).where(VocabEntry.user_id == owner.id, VocabEntry.word.in_(words))
            )
        ).scalars()
    }
    created = 0
    updated = 0
    results = []
    entries: dict[str, VocabEntry] = {}
    for word in words:
        entry = existing.get(word)
        if entry is None:
            entry = VocabEntry(user_id=owner.id, word=word, lemma=word, source="wordlist")
            session.add(entry)
            created += 1
        else:
            updated += 1
        entries[word] = entry
        if body.action == "master":
            entry.mark = "mastered"
            entry.marked_at = now
        results.append(
            {
                "word": word,
                "created": word not in existing,
                "scheduled": entry.fsrs_card is not None,
            }
        )
    if body.action == "collect":
        await session.flush()
        source_label = WORDLISTS.get(key)
        if custom_id is not None:
            source_label = (await _get_custom(session, custom_id)).name
        fingerprints = {
            word: hashlib.sha256(
                json.dumps(
                    {"kind": "wordlist", "locator": {"deck": key, "word": word}},
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode()
            ).hexdigest()
            for word in words
        }
        existing_occurrences = set(
            (
                await session.execute(
                    select(VocabOccurrence.vocab_id, VocabOccurrence.source_fingerprint).where(
                        VocabOccurrence.vocab_id.in_([entry.id for entry in entries.values()]),
                        VocabOccurrence.source_fingerprint.in_(fingerprints.values()),
                    )
                )
            ).all()
        )
        for word, entry in entries.items():
            fingerprint = fingerprints[word]
            if (entry.id, fingerprint) in existing_occurrences:
                continue
            session.add(
                VocabOccurrence(
                    vocab_id=entry.id,
                    source_kind="wordlist",
                    source_label=source_label,
                    source_locator={"deck": key, "word": word},
                    source_fingerprint=fingerprint,
                    context_text=word,
                )
            )
    await session.commit()
    return {
        "action": body.action,
        "created": created,
        "updated": updated,
        "failed": [],
        "items": results,
    }


class LearnBody(BaseModel):
    count: int = Field(default=10, ge=1, le=50)


def _new_vocab(user_id: str, word: str, now: datetime, *, schedule: bool = True) -> VocabEntry:
    """建生词本行。

    `schedule=False` 是「入册但不排队」：点进一个场景要给几十上百个词建行，
    若照领取那样一律 `init_card() + due=now`，第二天复习队列会凭空多出上百条
    从没学过的词，把真正该复习的冲垮。入册只是「这个词进了我的本子」，
    要不要排进复习由后续的学习/自测决定。

    `fsrs_card IS NULL` 不是新状态：`review.py` 早就会给历史空卡补卡。
    """
    word = word.strip().lower()
    if not schedule:
        return VocabEntry(user_id=user_id, word=word, lemma=word, status="new", source="wordlist")
    return VocabEntry(
        user_id=user_id,
        word=word,
        lemma=word,
        status="learning",
        source="wordlist",
        fsrs_card=srs.init_card(),
        due_at=now,  # 领取即进入复习队列
    )


@router.post("/{key}/learn", status_code=201)
async def learn_words(
    key: str, body: LearnBody, owner: CurrentOwner, session: SessionDep
) -> list[dict]:
    now = datetime.now(UTC)
    cards = []
    custom_id = _custom_id(key)
    if custom_id is not None:
        wordlist = await _get_custom(session, custom_id)
        # 本级每日新词上限：一次领太多会把复习队列冲垮（FR-179）
        body.count = min(body.count, wordlist.daily_new_limit)
        stmt = (
            select(WordlistItem, DictEntry)
            .outerjoin(DictEntry, DictEntry.word == WordlistItem.word)
            .outerjoin(
                VocabEntry,
                (VocabEntry.word == func.lower(WordlistItem.word))
                & (VocabEntry.user_id == owner.id),
            )
            .where(WordlistItem.wordlist_id == custom_id, VocabEntry.id.is_(None))
            .order_by(WordlistItem.ordinal)
            .limit(body.count)
        )
        for item, d in (await session.execute(stmt)).all():
            entry = _new_vocab(owner.id, item.word, now)
            session.add(entry)
            await session.flush()
            cards.append(
                {
                    "vocab_id": entry.id,
                    "word": item.word,
                    "phonetic": d.phonetic if d else None,
                    "translation": (d.translation if d and d.translation else item.translation),
                    "definition": d.definition if d else None,
                    "tags": d.tag.split() if d and d.tag else [],
                    "freq_band": freq_band(d.frq) if d else None,
                    "frq": d.frq if d else None,
                    "status": entry.status,
                    "due_at": now.isoformat(),
                }
            )
        await session.commit()
        return cards

    _require_key(key)
    stmt = (
        select(DictEntry)
        .outerjoin(
            VocabEntry,
            (VocabEntry.word == func.lower(DictEntry.word)) & (VocabEntry.user_id == owner.id),
        )
        .where(_tag_filter(key), VocabEntry.id.is_(None))
        .order_by(*_frq_order())
        .limit(body.count)
    )
    dict_entries = (await session.execute(stmt)).scalars().all()
    for d in dict_entries:
        entry = _new_vocab(owner.id, d.word, now)
        session.add(entry)
        await session.flush()
        cards.append(
            {
                "vocab_id": entry.id,
                "word": d.word,
                "phonetic": d.phonetic,
                "translation": d.translation,
                "definition": d.definition,
                "tags": d.tag.split() if d.tag else [],
                "freq_band": freq_band(d.frq),
                "frq": d.frq,
                "status": entry.status,
                "due_at": now.isoformat(),
            }
        )
    await session.commit()
    return cards


def _cover_response(storage_key: str) -> Response:
    return media_response(
        storage_key,
        media_type="image/webp" if storage_key.endswith(".webp") else "image/png",
        cache_control="public, max-age=604800, immutable",
    )


@router.get("/{wordlist_id}/cover", response_model=None)
async def wordlist_cover(wordlist_id: int, session: SessionDep) -> Response:
    """单词本封面（模块 16 FR-420）。没有生成封面时 404，前端回落 emoji + 渐变。"""
    row = await session.get(Wordlist, wordlist_id)
    if row is None or not row.cover_key:
        raise HTTPException(status_code=404, detail="该本没有封面图")
    return _cover_response(row.cover_key)


@router.get("/key/{key}/cover", response_model=None)
async def deck_cover_by_key(key: str, session: SessionDep) -> Response:
    """虚拟本封面（FR-420a）：生词本与八个考纲本没有 wordlist 行，按 deck key 寻址。

    路径前缀用 `key/` 而不是直接吃 `{key}/cover`，是因为上面那条路由的
    路径参数是 int：`/wordlists/cet4/cover` 会先撞上它、被 422 挡掉。
    """
    row = await session.get(DeckCover, key)
    if row is None or not row.storage_key:
        raise HTTPException(status_code=404, detail="该本没有封面图")
    return _cover_response(row.storage_key)


# ─────────────── 场景学习：入册 / 曝光 / 自测（考纲本按场景学）───────────────


class SceneEnrollBody(BaseModel):
    """把一个场景的词收进生词本。不带参数——场景本身就是范围。"""


@router.post("/{key}/scenes/{scene}/enroll")
async def enroll_scene(key: str, scene: str, owner: CurrentOwner, session: SessionDep) -> dict:
    """场景入册：给该场景所有还没进生词本的词建行，**不排进复习队列**。

    与 `/learn` 的区别就在这一点：领取是「我要开始背这批」，入册只是
    「这个场景我点开了」。一个场景可能有近百词，照领取那样建卡的话，
    点开三个场景明天就有三百条待复习——真正学过的词反而被淹掉。
    """
    _require_key(key)
    now = datetime.now(UTC)
    words = (
        (
            await session.execute(
                select(DeckScene.word)
                .outerjoin(
                    VocabEntry,
                    (VocabEntry.word == func.lower(DeckScene.word))
                    & (VocabEntry.user_id == owner.id),
                )
                .where(DeckScene.deck == key, DeckScene.scene == scene, VocabEntry.id.is_(None))
            )
        )
        .scalars()
        .all()
    )
    for w in words:
        session.add(_new_vocab(owner.id, w, now, schedule=False))
    await session.commit()
    return {"scene": scene, "enrolled": len(words)}


class ExposeBody(BaseModel):
    words: list[str] = Field(min_length=1, max_length=200)


@router.post("/expose")
async def expose_words(body: ExposeBody, owner: CurrentOwner, session: SessionDep) -> dict:
    """记一次「看过」。

    > [!danger] 一个字节都不碰 FSRS
    >
    > 把「点开看一眼」当成一次 Good 评分，会把 stability 推上去，
    > 于是一个从没测过的词被排到几周后才复习。曝光只写 `exposures`
    > 与 `last_seen_at` 两列，`fsrs_card` / `due_at` 原样不动。

    打开一次就算见过，没有冷却窗也没有次数阈值——那两个值配了才自洽，
    而用户要的是「打开就变、自己能改」。现在打开即 `learning`，
    再往上走由词卡上的人工标记决定（`/mark`）。

    人工标记过的词不受影响：`stage()` 里标记优先，翻看不会把
    「已掌握」冲回「学习中」。
    """
    now = datetime.now(UTC)
    names = list(dict.fromkeys(w.strip().lower() for w in body.words if w.strip()))
    rows = {
        v.word: v
        for v in (
            await session.execute(
                select(VocabEntry).where(VocabEntry.user_id == owner.id, VocabEntry.word.in_(names))
            )
        ).scalars()
    }
    stages: dict[str, str] = {}
    for w in names:
        vocab = rows.get(w)
        if vocab is None:
            vocab = _new_vocab(owner.id, w, now, schedule=False)
            session.add(vocab)
            rows[w] = vocab
        stages[w] = study_stage.touch(vocab, now)
    await session.commit()
    return {"counted": len(names), "stages": stages}


class MarkBody(BaseModel):
    """人工标记：用户在词卡上自己按的。

    `mark` 传 null 表示清除，清除后阶段回到推断值（打开过=学习中、
    自测过=学习中、FSRS 成熟=已掌握、算法判难=困难词）。
    """

    words: list[str] = Field(min_length=1)
    mark: str | None = None


@router.post("/mark")
async def mark_words(body: MarkBody, owner: CurrentOwner, session: SessionDep) -> dict:
    """给词打上（或清除）人工标记。

    > [!danger] 不写 fsrs_card
    >
    > 「已掌握」以前是往 `fsrs_card` 塞一张合成卡（`/batch` 的 master 分支至今如此），
    > 「困难词」则是读 `fsrs_card.difficulty`。但 FSRS 的 stability/difficulty 是
    > 从真实答题结果估出来的，手按一下就改写等于往调度模型灌假数据，
    > 之后每一次复习间隔都建立在这条假数据上。标记单独一列存。
    """
    now = datetime.now(UTC)
    names = [w.strip().lower() for w in body.words if w.strip()]
    if not names:
        raise HTTPException(status_code=400, detail="没有要标记的词")
    rows = {
        v.word: v
        for v in (
            await session.execute(
                select(VocabEntry).where(VocabEntry.user_id == owner.id, VocabEntry.word.in_(names))
            )
        ).scalars()
    }
    stages: dict[str, str] = {}
    for w in names:
        vocab = rows.get(w)
        if vocab is None:
            # 没入册的词也能直接标：用户点了「已掌握」却因为没入册而失败，
            # 从界面上完全看不出原因
            vocab = _new_vocab(owner.id, w, now, schedule=False)
            session.add(vocab)
            rows[w] = vocab
        stages[w] = study_stage.set_mark(vocab, body.mark, now)
    await session.commit()
    return {"mark": study_stage.normalize_mark(body.mark), "stages": stages}


class QuizSubmitBody(BaseModel):
    """提交一小组的自测结果。

    `passed` 是前端按 `grouping.wordPassed` 判出来的（连对 ≥2 次且最后一次是拼写，
    或被显式标记「这个我认识」）——判据留在前端是因为它要在每一题之后立即反馈，
    服务端只负责持久化与场景级汇总。
    """

    passed: list[str] = Field(default_factory=list)
    first_try_ok: int = Field(default=0, ge=0)
    first_try_total: int = Field(default=0, ge=0)
    cursor: int = Field(default=0, ge=0)
    submission_id: str | None = Field(default=None, min_length=1, max_length=64)
    run_id: str | None = Field(default=None, min_length=1, max_length=36)
    version: int | None = Field(default=None, ge=0)


def _scene_words_query(key: str, scene: str):
    custom_id = _custom_id(key)
    if custom_id is not None:
        query = select(WordlistItem.word).where(WordlistItem.wordlist_id == custom_id)
        return query if scene == "*" else query.where(WordlistItem.group_key == scene)
    _require_key(key)
    if scene == "*":
        return select(DictEntry.word).where(_tag_filter(key))
    return select(DeckScene.word).where(DeckScene.deck == key, DeckScene.scene == scene)


@router.get("/{key}/scenes/{scene}/quiz")
async def scene_quiz_state(key: str, scene: str, owner: CurrentOwner, session: SessionDep) -> dict:
    """场景自测进度：测到哪、过了几个、场景算不算通过。"""
    exists = await session.scalar(_scene_words_query(key, scene).limit(1))
    if exists is None:
        raise HTTPException(404, "场景不存在")
    return await _scene_quiz_view(session, owner.id, key, scene)


@router.post("/{key}/scenes/{scene}/quiz")
async def scene_quiz_submit(
    key: str, scene: str, body: QuizSubmitBody, owner: CurrentOwner, session: SessionDep
) -> dict:
    """记一小组的自测结果，并重算场景是否通过。"""
    now = datetime.now(UTC)
    members = {
        word.lower() for word in (await session.scalars(_scene_words_query(key, scene))).all()
    }
    if not members:
        raise HTTPException(404, "场景不存在")
    names = list(dict.fromkeys(w.strip().lower() for w in body.passed if w.strip()))
    if (
        not set(names).issubset(members)
        or body.first_try_ok > body.first_try_total
        or body.first_try_total > 100
        or len(names) > 100
    ):
        raise HTTPException(422, "单词归属或成绩计数无效")
    if body.submission_id and (body.run_id is None or body.version is None):
        raise HTTPException(422, "提交需要练习轮次和预期版本")
    scope = f"scene:{key}:{scene}"
    receipt, duplicate = await learning_receipts.claim(
        session,
        owner.id,
        body.submission_id or learning_receipts.fingerprint({"scope": scope, **body.model_dump()}),
        scope,
        body.model_dump(),
    )
    if duplicate:
        return receipt.response
    insert = sqlite_insert if session.bind.dialect.name == "sqlite" else pg_insert
    await session.execute(
        insert(DeckSceneState)
        .values(user_id=owner.id, deck=key, scene=scene, version=0)
        .on_conflict_do_nothing(index_elements=["user_id", "deck", "scene"])
    )
    state = await session.scalar(
        select(DeckSceneState).where(
            DeckSceneState.user_id == owner.id,
            DeckSceneState.deck == key,
            DeckSceneState.scene == scene,
        )
    )
    expected = body.version if body.version is not None else state.version
    result = await session.execute(
        update(DeckSceneState)
        .where(DeckSceneState.id == state.id, DeckSceneState.version == expected)
        .values(version=expected + 1)
    )
    if result.rowcount != 1:
        await session.rollback()
        raise HTTPException(409, "场景进度已更新，请重新读取后开始新一轮练习")
    if names:
        rows = {
            v.word: v
            for v in (
                await session.execute(
                    select(VocabEntry).where(
                        VocabEntry.user_id == owner.id,
                        VocabEntry.word.in_(names),
                    )
                )
            ).scalars()
        }
        for w in names:
            vocab = rows.get(w)
            if vocab is None:
                vocab = _new_vocab(owner.id, w, now, schedule=False)
                session.add(vocab)
                rows[w] = vocab
            vocab.self_test_at = now
            vocab.status = study_stage.status_of(study_stage.stage(vocab))

    state.run_id = body.run_id
    state.batch_cursor = body.cursor
    state.attempts = (state.attempts or 0) + 1
    state.first_try_ok = (state.first_try_ok or 0) + body.first_try_ok
    state.first_try_total = (state.first_try_total or 0) + body.first_try_total
    await session.flush()
    response = await _scene_quiz_view(session, owner.id, key, scene, commit=False)
    receipt.response = response
    await session.commit()
    return response


async def _scene_quiz_view(
    session, user_id: str, key: str, scene: str, *, commit: bool = True
) -> dict:
    """场景自测视图。

    > [!info] `passed_at` 是缓存，判据是词级的
    >
    > 「场景通过」= 该场景每个词的 `self_test_at` 都非空。这里现算，
    > 顺手把结果写回 `deck_scene_state.passed_at` 供列表页快速读取。
    > 删掉那张表能从词级完全重建。

    > [!danger] 场景没过，绝不回写词的 FSRS
    >
    > 场景是 AND 门，FSRS 是按词的连续量。60 词里 59 个已掌握、1 个在重学时
    > 场景判不通过——但那 59 个一个都不该降级。界面说的是「59/60 已通过」。
    """
    members = _scene_words_query(key, scene).subquery()
    total, passed = (
        await session.execute(
            select(func.count(), func.count(VocabEntry.self_test_at))
            .select_from(members)
            .outerjoin(
                VocabEntry,
                (VocabEntry.word == func.lower(members.c.word)) & (VocabEntry.user_id == user_id),
            )
        )
    ).one()
    state = (
        await session.execute(
            select(DeckSceneState).where(
                DeckSceneState.user_id == user_id,
                DeckSceneState.deck == key,
                DeckSceneState.scene == scene,
            )
        )
    ).scalar_one_or_none()
    all_passed = total > 0 and passed >= total
    if state is not None:
        want = datetime.now(UTC) if all_passed else None
        if all_passed != (state.passed_at is not None):
            state.passed_at = want
            if commit:
                await session.commit()
    return {
        "scene": scene,
        "version": state.version if state else 0,
        "run_id": state.run_id if state else None,
        "total": int(total),
        "passed": int(passed),
        "all_passed": all_passed,
        "cursor": state.batch_cursor if state else 0,
        "attempts": state.attempts if state else 0,
        "first_try_ok": state.first_try_ok if state else 0,
        "first_try_total": state.first_try_total if state else 0,
    }


# ---- 本级维护：清发音缓存 / 清学习进度 / AI 补全（FR-499~502） ----


def _deck_or_404(exc: decks.UnknownDeck) -> NoReturn:
    raise HTTPException(status_code=404, detail="unknown wordlist") from exc


@router.post("/{key}/clear-audio-cache")
async def clear_deck_audio_cache(key: str, owner: CurrentOwner, session: SessionDep) -> dict:
    """删本内每个词的 TTS 缓存文件并把浏览器缓存代 +1。只清单词本身，例句与释义照旧。"""
    try:
        words = await decks.deck_words(session, key)
    except decks.UnknownDeck as exc:
        _deck_or_404(exc)
    if words is None:
        words = set(
            (
                await session.execute(select(VocabEntry.word).where(VocabEntry.user_id == owner.id))
            ).scalars()
        )
    voices, rates = await tts_cache.candidate_voices(session)
    files, cleared_mb = await asyncio.to_thread(
        tts_cache.purge_word_audio, get_settings().media_root, words, voices, rates
    )
    epoch = await tts_cache.bump_epoch(session)
    session.add(
        ConfigAudit(
            action="storage.clear_tts_deck",
            summary=f"清理「{key}」{len(words)} 词的发音缓存 {files} 个文件（{cleared_mb} MB）",
        )
    )
    await session.commit()
    return {"words": len(words), "files": files, "cleared_mb": cleared_mb, "epoch": epoch}


@router.post("/{key}/reset-progress")
async def reset_deck_progress(key: str, owner: CurrentOwner, session: SessionDep) -> dict:
    """本内词的接触 / 自测 / 标记 / FSRS / 场景进度全部归零；有出处的收藏保留（FR-501）。"""
    try:
        outcome = await study_reset.reset_deck_progress(session, owner.id, key)
    except decks.UnknownDeck as exc:
        _deck_or_404(exc)
    session.add(
        ConfigAudit(
            action="study.reset_deck",
            summary=(
                f"重置「{key}」学习进度：{outcome['words']} 词，清零 {outcome['reset']}、"
                f"删除 {outcome['deleted']}、复习记录 {outcome['review_logs']}"
            ),
        )
    )
    await session.commit()
    return outcome


class AiRunBody(BaseModel):
    kinds: list[str] = Field(default_factory=lambda: list(deck_ai.KINDS), max_length=3)
    refresh: bool = False


@router.post("/{key}/ai-runs")
async def start_deck_ai_run(
    key: str, body: AiRunBody, owner: CurrentOwner, session: SessionDep
) -> dict:
    """一键把本内所有词的 AI 语境释义 / 拆开记跑完；同时只跑一本（FR-502）。"""
    try:
        run = await deck_ai.start_run(session, key, owner.id, body.kinds, body.refresh)
    except decks.UnknownDeck as exc:
        _deck_or_404(exc)
    except deck_ai.RunBusy as exc:
        name = await decks.deck_name(session, exc.run.deck_key)
        raise HTTPException(
            status_code=409, detail=f"「{name}」正在补全，先等它跑完或取消"
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    await session.commit()
    await deck_ai.enqueue(await get_queue(), run)
    return deck_ai.run_public(run)


@router.get("/{key}/ai-runs/latest")
async def latest_deck_ai_run(key: str, session: SessionDep) -> dict:
    run = await deck_ai.latest_run(session, key)
    return {"run": deck_ai.run_public(run) if run is not None else None}


@router.post("/{key}/ai-runs/{run_id}/cancel")
async def cancel_deck_ai_run(key: str, run_id: int, session: SessionDep) -> dict:
    run = await session.get(deck_ai.DeckAiRun, run_id)
    if run is None or run.deck_key != key:
        raise HTTPException(status_code=404, detail="没有这次补全")
    await deck_ai.request_cancel(session, run)
    await session.commit()
    return deck_ai.run_public(run)
