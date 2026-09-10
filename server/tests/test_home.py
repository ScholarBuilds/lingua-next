"""「今天」首页聚合（CR-006 D5）。

进度口径要与书架 / 视频库一致：书按整本算、视频按播放位置算；
时长只算本周；最近加入按三类合并倒序。
"""

from datetime import UTC, datetime, timedelta

from app.owner import OWNER_ID
from domain.models import (
    Article,
    Book,
    Paragraph,
    ReadingProgress,
    StudyTimeLog,
    TalkSession,
    Video,
    VideoStudyProgress,
    VocabEntry,
)


async def test_home_empty(client) -> None:
    r = await client.get("/home")
    assert r.status_code == 200
    body = r.json()
    assert body["review_due"] == 0
    assert body["today_minutes"] == 0
    assert len(body["week_minutes"]) == 7
    assert body["continue"] == {"reading": None, "video": None, "talk": None}
    assert body["recent"] == []
    assert body["plan"]["daily_new"] == 10
    assert body["plan"]["resume"] == []


async def test_pinned_reading_survives_new_recent_content_and_deletion(client, session):
    from sqlalchemy import delete

    from domain.models import UserPref

    for ident in [1, 2]:
        session.add(Article(id=ident, ordinal=ident, title=f"Reading {ident}", status="ready"))
        await session.flush()
        session.add(
            ReadingProgress(
                user_id=OWNER_ID,
                article_id=ident,
                read_paragraphs=[],
                updated_at=datetime.now(UTC) + timedelta(seconds=ident),
            )
        )
    session.add(UserPref(key="today", value={"pinned": ["reading:1"]}))
    await session.commit()
    home = (await client.get("/home")).json()
    assert home["continue"]["reading"]["article_id"] == 2
    assert home["plan"]["resume"][0]["key"] == "reading:1"
    assert home["plan"]["resume"][0]["title"] == "Reading 1"
    await session.execute(delete(ReadingProgress).where(ReadingProgress.article_id == 1))
    await session.execute(delete(Article).where(Article.id == 1))
    await session.commit()
    unavailable = (await client.get("/home")).json()["plan"]["resume"][0]
    assert unavailable["unavailable"]
    assert unavailable["href"] == "/read"


async def test_home_plan_uses_profile_and_filters_finished_and_other_owners(client, session):
    from domain.models import GrammarPractice, PracticeProfile, PracticeSession

    session.add(PracticeProfile(user_id=OWNER_ID, daily_new=7, timezone="Pacific/Honolulu"))
    for ident, user, status in [
        ("active", OWNER_ID, "paused"),
        ("done", OWNER_ID, "finished"),
        ("foreign", "other-owner", "active"),
    ]:
        session.add(
            PracticeSession(
                id=ident,
                user_id=user,
                mode="learn",
                status=status,
                scope={},
                questions=[{}, {}],
                cursor=1,
            )
        )
    session.add(GrammarPractice(id="grammar", user_id=OWNER_ID, mode="review", questions=[{}]))
    await session.commit()
    response = await client.get("/home")
    assert response.status_code == 200, response.text
    plan = response.json()["plan"]
    assert plan["daily_new"] == 7
    assert plan["timezone"] == "Pacific/Honolulu"
    assert {row["key"] for row in plan["resume"]} == {"practice:active", "grammar:grammar"}
    assert plan["resume"][0]["progress"] == "1 / 2 题"


async def test_home_aggregates(client, session) -> None:
    now = datetime.now(UTC)
    book = Book(slug="pride", title="Pride and Prejudice", author="Jane Austen", status="ready")
    session.add(book)
    await session.flush()
    chapter = Article(book_id=book.id, ordinal=1, title="Chapter 1", status="ready")
    session.add(chapter)
    await session.flush()
    for i in range(4):
        session.add(Paragraph(article_id=chapter.id, ordinal=i, text=f"p{i}"))
    session.add(
        ReadingProgress(
            user_id=OWNER_ID,
            article_id=chapter.id,
            last_paragraph_ordinal=1,
            read_paragraphs=[0, 1],
        )
    )
    video = Video(title="Why cities are getting quieter", status="ready", duration_s=200)
    session.add(video)
    await session.flush()
    session.add(VideoStudyProgress(user_id=OWNER_ID, video_id=video.id, last_pos_s=50.0))
    session.add(
        TalkSession(
            user_id=OWNER_ID,
            mode="voice",
            scenario_key="hotel_checkin",
            started_at=now - timedelta(minutes=9),
            ended_at=now,
        )
    )
    session.add(StudyTimeLog(user_id=OWNER_ID, kind="reading", seconds=600, created_at=now))
    session.add(VocabEntry(user_id=OWNER_ID, word="apple", due_at=now - timedelta(days=1)))
    session.add(VocabEntry(user_id=OWNER_ID, word="pear", due_at=now + timedelta(days=1)))
    await session.commit()

    r = await client.get("/home")
    assert r.status_code == 200
    body = r.json()
    assert body["review_due"] == 1
    assert body["today_minutes"] == 10
    assert sum(body["week_minutes"]) == 10

    reading = body["continue"]["reading"]
    assert reading["article_id"] == chapter.id
    assert reading["title"] == "Pride and Prejudice"
    assert reading["chapter"] == "Chapter 1"
    assert reading["progress_pct"] == 50.0
    assert reading["state"] == "reading"

    video_card = body["continue"]["video"]
    assert video_card["video_id"] == video.id
    assert video_card["progress_pct"] == 25.0

    talk = body["continue"]["talk"]
    assert talk["title"] == "酒店入住"
    assert talk["minutes"] == 9

    kinds = [item["kind"] for item in body["recent"]]
    assert sorted(kinds) == ["book", "video"]
    book_item = next(item for item in body["recent"] if item["kind"] == "book")
    assert book_item["href"] == f"/read/{chapter.id}"


async def test_home_skips_companion_sessions(client, session) -> None:
    session.add(TalkSession(user_id=OWNER_ID, mode="companion", scenario_key=None))
    await session.commit()
    r = await client.get("/home")
    assert r.json()["continue"]["talk"] is None
