"""复习接口：FSRS 到期队列、四档评分、学习统计（模块 05）。"""

from collections import Counter
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.owner import CurrentOwner
from app.routers.dict import SessionDep, freq_band
from domain import decks, learning_receipts, srs, study_stage
from domain.models import (
    Article,
    Book,
    DictEntry,
    ReviewLog,
    VocabEntry,
    VocabOccurrence,
)
from domain.practice import apply_rating, utc

router = APIRouter(prefix="/review", tags=["review"])


@router.get("/queue")
async def review_queue(
    owner: CurrentOwner, session: SessionDep, limit: int = 50, deck: str = ""
) -> dict:
    """到期复习队列；deck 传单词本 key 时只复习该本内的词（FR-180）。

    按本过滤只收窄展示范围，不改 FSRS 到期判定——跳过的到期词次日仍在全局队列里（BR-33）。
    """
    limit = min(max(limit, 1), 200)
    now = datetime.now(UTC)
    scope = await _deck_scope(session, deck)
    if scope is not None and not scope:
        return {"items": [], "count": 0, "deck": deck}
    base = select(VocabEntry).where(
        VocabEntry.user_id == owner.id, VocabEntry.fsrs_card.isnot(None), VocabEntry.due_at <= now
    )
    if scope is not None:
        base = base.where(VocabEntry.word.in_(scope))
    entries = list(
        (await session.execute(base.order_by(VocabEntry.due_at.asc()).limit(limit))).scalars()
    )
    items = await _cards_payload(session, entries)
    return {"items": items, "count": len(items), "deck": deck or None}


async def _cards_payload(session: AsyncSession, entries: list[VocabEntry]) -> list[dict]:
    if not entries:
        return []
    words = {word for entry in entries for word in (entry.word, entry.lemma) if word}
    dictionary = {
        item.word: item
        for item in (
            await session.scalars(select(DictEntry).where(DictEntry.word.in_(words)))
        ).all()
    }
    latest = (
        select(
            VocabOccurrence.id,
            func.row_number()
            .over(
                partition_by=VocabOccurrence.vocab_id,
                order_by=(VocabOccurrence.added_at.desc(), VocabOccurrence.id.desc()),
            )
            .label("rank"),
        )
        .where(VocabOccurrence.vocab_id.in_([entry.id for entry in entries]))
        .subquery()
    )
    contexts = {}
    rows = (
        await session.execute(
            select(VocabOccurrence, Article.title, Book.title)
            .join(latest, latest.c.id == VocabOccurrence.id)
            .outerjoin(Article, Article.id == VocabOccurrence.article_id)
            .outerjoin(Book, Book.id == Article.book_id)
            .where(latest.c.rank == 1)
        )
    ).all()
    for occurrence, article, book in rows:
        contexts[occurrence.vocab_id] = {
            "text": occurrence.context_text,
            "article_id": occurrence.article_id,
            "sentence_id": occurrence.sentence_id,
            "source_label": f"{book} · {article}" if book and article else article,
        }
    result = []
    for entry in entries:
        item = dictionary.get(entry.word) or dictionary.get(entry.lemma)
        result.append(
            {
                "vocab_id": entry.id,
                "word": entry.word,
                "phonetic": item.phonetic if item else None,
                "translation": item.translation if item else None,
                "definition": item.definition if item else None,
                "tags": item.tag.split() if item and item.tag else [],
                "freq_band": freq_band(item.frq) if item else None,
                "status": entry.status,
                "card_version": (entry.fsrs_card or {}).get("last_review"),
                "context": contexts.get(entry.id),
                "intervals": srs.preview_intervals(entry.fsrs_card),
            }
        )
    return result


async def _deck_scope(session: AsyncSession, deck: str) -> set[str] | None:
    """单词本 key → 该本的词集合；空 key 或生词本返回 None 表示不过滤。"""
    if not deck:
        return None
    try:
        return await decks.deck_words(session, deck)
    except decks.UnknownDeck:
        raise HTTPException(status_code=404, detail="unknown wordlist") from None


class RatingBody(BaseModel):
    rating: int = Field(ge=1, le=4)
    submission_id: str | None = Field(default=None, min_length=1, max_length=64)
    card_version: str | None = None


@router.post("/{vocab_id}")
async def submit_review(
    vocab_id: int, body: RatingBody, owner: CurrentOwner, session: SessionDep
) -> dict:
    scope = f"review:{vocab_id}"
    receipt = None
    if body.submission_id:
        receipt, duplicate = await learning_receipts.claim(
            session, owner.id, body.submission_id, scope, body.model_dump()
        )
        if duplicate:
            return receipt.response
    entry = (
        await session.execute(
            select(VocabEntry).where(VocabEntry.id == vocab_id, VocabEntry.user_id == owner.id)
        )
    ).scalar_one_or_none()
    if entry is None:
        raise HTTPException(status_code=404, detail="vocab not found")
    now = datetime.now(UTC)
    if body.submission_id and body.card_version != (entry.fsrs_card or {}).get("last_review"):
        raise HTTPException(409, "这个词已在其他训练中评分，请重新读取")
    if not body.submission_id and entry.last_review_at and entry.due_at and utc(entry.due_at) > now:
        return {
            "next_due_at": entry.due_at.isoformat(),
            "intervals": srs.preview_intervals(entry.fsrs_card),
            "deduped": True,
        }
    expected = entry.last_review_at
    locked = await session.execute(
        update(VocabEntry)
        .where(VocabEntry.id == entry.id, VocabEntry.last_review_at == expected)
        .values(last_review_at=now)
        .execution_options(synchronize_session=False)
    )
    if locked.rowcount != 1:
        await session.rollback()
        raise HTTPException(409, "这个词已在其他训练中评分，请重新读取")
    await apply_rating(session, entry, body.rating, now)
    response = {
        "next_due_at": entry.due_at.isoformat(),
        "intervals": srs.preview_intervals(entry.fsrs_card),
    }
    if receipt is not None:
        receipt.response = response
    await session.commit()
    return response


@router.get("/report")
async def review_report(owner: CurrentOwner, session: SessionDep) -> dict:
    """学习报告：复习热力图、30 天趋势、词汇总量、来源分布、生词最多的文章。"""
    local_tz = datetime.now().astimezone().tzinfo
    today = datetime.now(UTC).astimezone(local_tz).date()

    # 近 365 天复习热力图（本地自然日聚合，只回传有记录的日期）
    year_start = datetime.combine(today - timedelta(days=364), datetime.min.time(), tzinfo=local_tz)
    heat_counts: dict[str, int] = {}
    for ts in (
        await session.execute(
            select(ReviewLog.review_at)
            .join(VocabEntry, VocabEntry.id == ReviewLog.vocab_id)
            .where(VocabEntry.user_id == owner.id, ReviewLog.review_at >= year_start)
        )
    ).scalars():
        day = utc(ts).astimezone(local_tz).date().isoformat()
        heat_counts[day] = heat_counts.get(day, 0) + 1
    heatmap = [{"date": day, "count": count} for day, count in sorted(heat_counts.items())]

    # 近 30 天逐日：复习次数 + 新学词数（补零，前端直接画折线）
    daily_start = datetime.combine(today - timedelta(days=29), datetime.min.time(), tzinfo=local_tz)
    learned_counts: dict[str, int] = {}
    for ts in (
        await session.execute(
            select(VocabEntry.created_at).where(
                VocabEntry.user_id == owner.id,
                VocabEntry.created_at >= daily_start,
            )
        )
    ).scalars():
        day = ts.astimezone(local_tz).date().isoformat()
        learned_counts[day] = learned_counts.get(day, 0) + 1
    daily = [
        {
            "date": day,
            "reviewed": heat_counts.get(day, 0),
            "learned": learned_counts.get(day, 0),
        }
        for day in ((today - timedelta(days=29 - i)).isoformat() for i in range(30))
    ]

    entries = (
        await session.scalars(select(VocabEntry).where(VocabEntry.user_id == owner.id))
    ).all()
    status_counts = Counter(study_stage.status_of(study_stage.stage(entry)) for entry in entries)
    reviews_total = (
        await session.execute(
            select(func.count())
            .select_from(ReviewLog)
            .join(VocabEntry, VocabEntry.id == ReviewLog.vocab_id)
            .where(VocabEntry.user_id == owner.id)
        )
    ).scalar_one()
    totals = {
        "vocab_total": sum(status_counts.values()),
        "known": status_counts.get("known", 0),
        "learning": status_counts.get("learning", 0),
        "new": status_counts.get("new", 0),
        "reviews_total": reviews_total,
    }

    source_counts = dict(
        (
            await session.execute(
                select(VocabEntry.source, func.count())
                .where(VocabEntry.user_id == owner.id)
                .group_by(VocabEntry.source)
            )
        ).all()
    )
    by_source = {
        "reading": source_counts.get("reading", 0),
        "wordlist": source_counts.get("wordlist", 0),
    }

    vocab_count = func.count(func.distinct(VocabOccurrence.vocab_id))
    top_stmt = (
        select(Article.title, Book.title, vocab_count)
        .select_from(VocabOccurrence)
        .join(VocabEntry, VocabEntry.id == VocabOccurrence.vocab_id)
        .join(Article, Article.id == VocabOccurrence.article_id)
        .outerjoin(Book, Book.id == Article.book_id)
        .group_by(Article.id, Book.title)
        .where(VocabEntry.user_id == owner.id)
        .order_by(vocab_count.desc())
        .limit(5)
    )
    top_articles = [
        {
            "title": f"{book_title} · {article_title}" if book_title else article_title,
            "vocab_count": count,
        }
        for article_title, book_title, count in (await session.execute(top_stmt)).all()
    ]

    return {
        "heatmap": heatmap,
        "daily": daily,
        "totals": totals,
        "by_source": by_source,
        "top_articles": top_articles,
    }


@router.get("/stats")
async def review_stats(owner: CurrentOwner, session: SessionDep) -> dict:
    now = datetime.now(UTC)
    local_tz = datetime.now().astimezone().tzinfo
    today = now.astimezone(local_tz).date()
    today_start = datetime.combine(today, datetime.min.time(), tzinfo=local_tz)

    due_scheduled = (
        await session.execute(
            select(func.count())
            .select_from(VocabEntry)
            .where(
                VocabEntry.user_id == owner.id,
                VocabEntry.fsrs_card.isnot(None),
                VocabEntry.due_at <= now,
            )
        )
    ).scalar_one()
    unscheduled = (
        await session.execute(
            select(func.count())
            .select_from(VocabEntry)
            .where(VocabEntry.user_id == owner.id, VocabEntry.fsrs_card.is_(None))
        )
    ).scalar_one()
    reviewed_today = (
        await session.execute(
            select(func.count())
            .select_from(ReviewLog)
            .join(VocabEntry, VocabEntry.id == ReviewLog.vocab_id)
            .where(VocabEntry.user_id == owner.id, ReviewLog.review_at >= today_start)
        )
    ).scalar_one()
    new_today = (
        await session.execute(
            select(func.count())
            .select_from(VocabEntry)
            .where(VocabEntry.user_id == owner.id, VocabEntry.created_at >= today_start)
        )
    ).scalar_one()
    total_vocab = (
        await session.execute(
            select(func.count()).select_from(VocabEntry).where(VocabEntry.user_id == owner.id)
        )
    ).scalar_one()

    # 连续打卡：按 ReviewLog 有记录的本地自然日，从今天（今天无记录则从昨天）向前数
    review_days = {
        ts.astimezone(local_tz).date()
        for ts in (
            await session.execute(
                select(ReviewLog.review_at)
                .join(VocabEntry, VocabEntry.id == ReviewLog.vocab_id)
                .where(VocabEntry.user_id == owner.id)
                .distinct()
            )
        ).scalars()
    }
    streak_days = 0
    cursor = today if today in review_days else today - timedelta(days=1)
    while cursor in review_days:
        streak_days += 1
        cursor -= timedelta(days=1)

    # 未来 7 天到期分布（明天起，按本地日期分桶）
    horizon = today_start + timedelta(days=8)
    upcoming_counts: dict[str, int] = {}
    due_rows = (
        await session.execute(
            select(VocabEntry.due_at).where(
                VocabEntry.user_id == owner.id,
                VocabEntry.due_at > now,
                VocabEntry.due_at < horizon,
            )
        )
    ).scalars()
    for due_at in due_rows:
        upcoming_counts.setdefault(due_at.astimezone(local_tz).date().isoformat(), 0)
        upcoming_counts[due_at.astimezone(local_tz).date().isoformat()] += 1
    upcoming = [
        {"date": d.isoformat(), "count": upcoming_counts.get(d.isoformat(), 0)}
        for d in (today + timedelta(days=i) for i in range(1, 8))
    ]

    return {
        "due_now": due_scheduled,
        "pending_learning": unscheduled,
        "reviewed_today": reviewed_today,
        "new_today": new_today,
        "streak_days": streak_days,
        "total_vocab": total_vocab,
        "upcoming": upcoming,
    }
