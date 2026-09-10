"""「今天」首页聚合（CR-006 D5）：接着来、到期复习、本周时长、最近加入。

只读、不建表：阅读 / 视频 / 对话各取最近一条进度，时长按本周逐日求和，
最近加入按书、独立文章、视频三类的 created_at 合并排序。
进度口径与书架、视频库一致，别在这里另算一套。
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi import APIRouter
from sqlalchemy import func, select

from app.config import get_settings
from app.owner import CurrentOwner
from app.routers.books import _cover_version
from app.routers.dict import SessionDep
from app.routers.progress import progress_state
from domain.briefing import MORNING_BRIEF, latest_run
from domain.models import (
    Article,
    Book,
    GrammarPractice,
    Paragraph,
    PracticeAnswer,
    PracticeProfile,
    PracticeSession,
    ReadingProgress,
    StudyTimeLog,
    TalkSession,
    UserPref,
    Video,
    VideoStudyProgress,
    VocabEntry,
)
from domain.scenarios import get_scenario

router = APIRouter(tags=["home"])

RECENT_LIMIT = 8


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return (value.replace(tzinfo=UTC) if value.tzinfo is None else value).isoformat()


def _local(value: datetime, tz) -> datetime:
    # SQLite 测试驱动不保留 tzinfo，按 UTC 补上再换本地
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(tz)


async def _continue_reading(session, owner_id: str, article_id: int | None = None) -> dict | None:
    row = (
        await session.execute(
            select(ReadingProgress, Article)
            .join(Article, Article.id == ReadingProgress.article_id)
            .where(
                ReadingProgress.user_id == owner_id,
                True if article_id is None else Article.id == article_id,
            )
            .order_by(ReadingProgress.updated_at.desc())
            .limit(1)
        )
    ).first()
    if row is None:
        return None
    progress, article = row
    book = await session.get(Book, article.book_id) if article.book_id is not None else None
    if book is not None:
        total = await session.scalar(
            select(func.count(Paragraph.id))
            .join(Article, Article.id == Paragraph.article_id)
            .where(Article.book_id == book.id)
        )
        read_lists = (
            await session.execute(
                select(ReadingProgress.read_paragraphs)
                .join(Article, Article.id == ReadingProgress.article_id)
                .where(Article.book_id == book.id, ReadingProgress.user_id == owner_id)
            )
        ).scalars()
        read = sum(len(set(item or [])) for item in read_lists)
    else:
        total = await session.scalar(
            select(func.count(Paragraph.id)).where(Paragraph.article_id == article.id)
        )
        read = len(set(progress.read_paragraphs or []))
    pct, state = progress_state(read, int(total or 0))
    cover_url = None
    if book is not None and book.cover_key:
        media_root = Path(get_settings().media_root)
        cover_url = f"/api/books/{book.id}/cover?v={_cover_version(media_root / book.cover_key)}"
    return {
        "article_id": article.id,
        "title": book.title if book is not None else article.title,
        "chapter": article.title if book is not None else None,
        "author": book.author if book is not None else None,
        "book_id": book.id if book is not None else None,
        "cover_url": cover_url,
        "progress_pct": pct,
        "state": state,
        "updated_at": _iso(progress.updated_at),
    }


async def _continue_video(session, owner_id: str, video_id: int | None = None) -> dict | None:
    row = (
        await session.execute(
            select(VideoStudyProgress, Video)
            .join(Video, Video.id == VideoStudyProgress.video_id)
            .where(
                VideoStudyProgress.user_id == owner_id,
                True if video_id is None else Video.id == video_id,
            )
            .order_by(VideoStudyProgress.updated_at.desc())
            .limit(1)
        )
    ).first()
    if row is None:
        return None
    progress, video = row
    duration = int(video.duration_s or 0)
    pct = min(round(progress.last_pos_s / duration * 100, 1), 100.0) if duration else 0.0
    return {
        "video_id": video.id,
        "title": video.title,
        "title_zh": video.title_zh,
        "channel": video.channel,
        "last_pos_s": progress.last_pos_s,
        "duration_s": video.duration_s,
        "progress_pct": pct,
        "thumb_url": f"/api/videos/{video.id}/thumb" if video.thumb_key else None,
        "updated_at": _iso(progress.updated_at),
    }


async def _continue_talk(session, owner_id: str, session_id: int | None = None) -> dict | None:
    talk = (
        await session.execute(
            select(TalkSession)
            .where(
                TalkSession.user_id == owner_id,
                TalkSession.mode.not_in(("companion", "assistant")),
                True if session_id is None else TalkSession.id == session_id,
            )
            .order_by(TalkSession.started_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if talk is None:
        return None
    scenario = get_scenario(talk.scenario_key) if talk.scenario_key else None
    minutes = None
    if talk.ended_at is not None and talk.started_at is not None:
        minutes = max(1, int((talk.ended_at - talk.started_at).total_seconds() // 60))
    return {
        "session_id": talk.id,
        "scenario_key": talk.scenario_key,
        "title": scenario["title"] if scenario else "自由对话",
        "mode": talk.mode,
        "difficulty": talk.difficulty,
        "started_at": _iso(talk.started_at),
        "ended_at": _iso(talk.ended_at),
        "minutes": minutes,
    }


async def _week_minutes(session, owner_id: str, now: datetime, tz=None) -> tuple[list[int], int]:
    tz = tz or now.astimezone().tzinfo
    today = now.astimezone(tz).date()
    week_start = today - timedelta(days=today.weekday())
    week_start_utc = datetime(
        week_start.year, week_start.month, week_start.day, tzinfo=tz
    ).astimezone(UTC)
    logs = (
        await session.execute(
            select(StudyTimeLog.created_at, StudyTimeLog.seconds).where(
                StudyTimeLog.user_id == owner_id, StudyTimeLog.created_at >= week_start_utc
            )
        )
    ).all()
    per_day = [0] * 7
    today_s = 0
    for created, seconds in logs:
        day = _local(created, tz).date()
        idx = (day - week_start).days
        if 0 <= idx < 7:
            per_day[idx] += seconds
        if day == today:
            today_s += seconds
    return [s // 60 for s in per_day], today_s // 60


async def _recent(session) -> list[dict]:
    items: list[dict] = []
    books = (
        await session.execute(select(Book).order_by(Book.created_at.desc()).limit(RECENT_LIMIT))
    ).scalars()
    for book in books:
        first = await session.scalar(
            select(Article.id)
            .where(Article.book_id == book.id, Article.is_section.is_(False))
            .order_by(Article.ordinal)
            .limit(1)
        )
        items.append(
            {
                "kind": "book",
                "id": book.id,
                "title": book.title,
                "subtitle": book.author,
                "status": book.status,
                "created_at": book.created_at,
                "href": f"/read/{first}" if book.status == "ready" and first else "/read",
            }
        )
    articles = (
        await session.execute(
            select(Article)
            .where(Article.book_id.is_(None), Article.deck_id.is_(None))
            .order_by(Article.created_at.desc())
            .limit(RECENT_LIMIT)
        )
    ).scalars()
    for article in articles:
        items.append(
            {
                "kind": "article",
                "id": article.id,
                "title": article.title,
                "subtitle": article.source_kind,
                "status": article.status,
                "created_at": article.created_at,
                "href": f"/read/{article.id}" if article.status == "ready" else "/read",
            }
        )
    videos = (
        await session.execute(select(Video).order_by(Video.created_at.desc()).limit(RECENT_LIMIT))
    ).scalars()
    for video in videos:
        items.append(
            {
                "kind": "video",
                "id": video.id,
                "title": video.title,
                "subtitle": video.channel,
                "status": video.status,
                "created_at": video.created_at,
                "href": f"/video/{video.id}" if video.status in ("ready", "degraded") else "/video",
            }
        )
    items.sort(key=lambda it: it["created_at"] or datetime.min.replace(tzinfo=UTC), reverse=True)
    for it in items:
        it["created_at"] = _iso(it["created_at"])
    return items[:RECENT_LIMIT]


@router.get("/home")
async def home(owner: CurrentOwner, session: SessionDep) -> dict:
    now = datetime.now(UTC)
    profile = await session.get(PracticeProfile, owner.id)
    timezone = profile.timezone if profile else "UTC"
    zone = ZoneInfo(timezone)
    local_start = now.astimezone(zone).replace(hour=0, minute=0, second=0, microsecond=0)
    day_start, day_end = (
        local_start.astimezone(UTC),
        (local_start + timedelta(days=1)).astimezone(UTC),
    )
    learned = await session.scalar(
        select(func.count(PracticeAnswer.id))
        .join(PracticeSession)
        .where(
            PracticeSession.user_id == owner.id,
            PracticeSession.mode == "learn",
            PracticeAnswer.created_at >= day_start,
            PracticeAnswer.created_at < day_end,
            PracticeAnswer.verdict.in_(["correct", "assisted", "incorrect"]),
        )
    )
    completed = await session.scalar(
        select(func.count(PracticeSession.id)).where(
            PracticeSession.user_id == owner.id,
            PracticeSession.status == "finished",
            PracticeSession.finished_at >= day_start,
            PracticeSession.finished_at < day_end,
        )
    )
    resume = []
    for kind, model in [("practice", PracticeSession), ("grammar", GrammarPractice)]:
        rows = (
            await session.scalars(
                select(model)
                .where(
                    model.user_id == owner.id,
                    model.status.in_(["active", "paused"]),
                )
                .order_by(model.updated_at.desc())
            )
        ).all()
        for row in rows:
            if row.cursor >= len(row.questions):
                continue
            resume.append(
                {
                    "key": f"{kind}:{row.id}",
                    "kind": kind,
                    "title": "语法训练"
                    if kind == "grammar"
                    else {
                        "learn": "新词学习",
                        "review": "到期复习",
                        "spelling": "拼写训练",
                        "dictation": "听写训练",
                        "listening": "听力训练",
                    }.get(row.mode, "词汇训练"),
                    "progress": f"{row.cursor} / {len(row.questions)} 题",
                    "updated_at": _iso(row.updated_at),
                    "href": f"/grammar?tab=points&practice={row.id}"
                    if kind == "grammar"
                    else f"/vocab?v=practice&id={row.id}",
                    "priority": 1,
                }
            )
    today_pref = await session.get(UserPref, "today")
    pinned = (
        today_pref.value.get("pinned", [])
        if today_pref and isinstance(today_pref.value, dict)
        else []
    )
    if not isinstance(pinned, list):
        pinned = []
    for key in dict.fromkeys(value for value in pinned if isinstance(value, str)):
        kind, _, raw_id = key.partition(":")
        if kind not in {"reading", "video", "talk"} or not raw_id.isdigit():
            continue
        load = {"reading": _continue_reading, "video": _continue_video, "talk": _continue_talk}[
            kind
        ]
        item = await load(session, owner.id, int(raw_id))
        href = {
            "reading": f"/read/{raw_id}",
            "video": f"/video/{raw_id}",
            "talk": f"/talk/session?id={raw_id}",
        }[kind]
        if item is None:
            resume.append(
                {
                    "key": key,
                    "kind": kind,
                    "title": "置顶内容已不可用",
                    "progress": "内容或学习断点已删除",
                    "unavailable": "内容或学习断点已删除，可取消置顶后返回对应模块。",
                    "href": {"reading": "/read", "video": "/video", "talk": "/talk"}[kind],
                    "priority": 3,
                    "updated_at": None,
                }
            )
            continue
        progress = (
            f"阅读 {round(item['progress_pct'])}%"
            if kind == "reading"
            else f"视频 {round(item['progress_pct'])}%"
            if kind == "video"
            else f"上次 {item['minutes'] or 0} 分钟 · 查看记录"
            if item["ended_at"]
            else "未结束的对话"
        )
        resume.append(
            {
                "key": key,
                "kind": kind,
                "title": item["title"],
                "progress": progress,
                "href": href,
                "priority": 3,
                "updated_at": item.get("updated_at", item.get("started_at")),
            }
        )
    review_due = await session.scalar(
        select(func.count())
        .select_from(VocabEntry)
        .where(VocabEntry.user_id == owner.id, VocabEntry.due_at <= now)
    )
    week, today_minutes = await _week_minutes(session, owner.id, now, zone)
    brief = await latest_run(session, MORNING_BRIEF, today_only=True)
    return {
        "plan": {
            "day": local_start.date().isoformat(),
            "timezone": timezone,
            "daily_new": profile.daily_new if profile else 10,
            "learned": int(learned or 0),
            "completed_practices": int(completed or 0),
            "resume": resume,
        },
        "brief": (
            {"text": brief.text, "payload": brief.payload, "at": _iso(brief.created_at)}
            if brief is not None
            else None
        ),
        "review_due": int(review_due or 0),
        "today_minutes": today_minutes,
        "week_minutes": week,
        "continue": {
            "reading": await _continue_reading(session, owner.id),
            "video": await _continue_video(session, owner.id),
            "talk": await _continue_talk(session, owner.id),
        },
        "recent": await _recent(session),
    }
