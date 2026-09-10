from datetime import UTC, datetime, timedelta
from uuid import uuid4

from sqlalchemy import func, select

from domain import srs
from domain.models import DictEntry, PracticeSession, ReviewLog, VocabEntry
from domain.practice import build_questions


async def seed(session):
    for word, meaning in [
        ("apple", "苹果"),
        ("book", "书"),
        ("cat", "猫"),
        ("door", "门"),
        ("egg", "蛋"),
    ]:
        session.add(DictEntry(word=word, translation=meaning))
        session.add(
            VocabEntry(
                user_id="owner",
                word=word,
                fsrs_card=srs.init_card(),
                due_at=datetime.now(UTC) - timedelta(days=1),
                status="learning",
            )
        )
    await session.commit()


def body(record, **kwargs):
    return {
        "id": str(uuid4()),
        "question_id": record["questions"][record["cursor"]]["id"],
        "version": record["version"],
        "rating": 3,
        **kwargs,
    }


async def test_review_snapshot_and_idempotent_rating(client, session):
    await seed(session)
    response = await client.post("/practice", json={"mode": "review", "count": 5})
    assert response.status_code == 200, response.text
    record = response.json()
    request = body(record)
    first = await client.post(f"/practice/{record['id']}/answers", json=request)
    assert first.status_code == 200, first.text
    repeated = await client.post(f"/practice/{record['id']}/answers", json=request)
    assert repeated.json() == first.json()
    loaded = (await client.get(f"/practice/{record['id']}")).json()
    assert loaded["cursor"] == 1
    assert loaded["questions"] == record["questions"]
    assert loaded["counts"]["correct"] == 1
    assert await session.scalar(select(func.count(ReviewLog.id))) == 1


async def test_review_restricts_rating_after_full_answer_hint(client, session):
    await seed(session)
    record = (await client.post("/practice", json={"mode": "review", "count": 5})).json()
    question = record["questions"][record["cursor"]]
    assert len(question["hint_steps"]) == 3
    assert question["hint_steps"][-1]["reveals_answer"] is True
    request = body(record, hints=len(question["hint_steps"]), rating=4)
    response = await client.post(f"/practice/{record['id']}/answers", json=request)
    assert response.status_code == 422
    assert (await client.get(f"/practice/{record['id']}")).json()["cursor"] == 0


async def test_new_words_are_only_scheduled_when_answered(client, session):
    for word in ["apple", "book", "cat", "door", "egg"]:
        session.add(DictEntry(word=word, translation=word, tag="zk"))
    await session.commit()
    response = await client.post("/practice", json={"mode": "learn", "decks": ["zk"], "count": 5})
    assert response.status_code == 200, response.text
    record = response.json()
    assert len(record["questions"]) == 5
    assert await session.scalar(select(func.count(VocabEntry.id))) == 0
    response = await client.post(f"/practice/{record['id']}/answers", json=body(record))
    assert response.status_code == 200, response.text
    assert await session.scalar(select(func.count(VocabEntry.id))) == 1
    assert await session.scalar(select(func.count(ReviewLog.id))) == 0


async def test_new_word_limit_applies_to_prepared_sessions(client, session):
    await seed(session)
    for entry in (await session.scalars(select(VocabEntry))).all():
        entry.exposures = 0
    await session.commit()
    result = await client.put("/practice/settings/profile", json={"daily_new": 1})
    assert result.status_code == 200
    first = (await client.post("/practice", json={"mode": "learn", "count": 5})).json()
    second = (await client.post("/practice", json={"mode": "learn", "count": 5})).json()
    result = await client.post(f"/practice/{first['id']}/answers", json=body(first))
    assert result.status_code == 200, result.text
    result = await client.post(f"/practice/{second['id']}/answers", json=body(second))
    assert result.status_code == 409
    assert (await client.get(f"/practice/{second['id']}")).json()["cursor"] == 0


async def test_drills_skips_and_unavailable_do_not_schedule(client, session):
    await seed(session)
    record = (await client.post("/practice", json={"mode": "spelling", "count": 5})).json()
    for action in ["skip", "unavailable", "answer"]:
        request = body(record, action=action, answer="wrong")
        result = await client.post(f"/practice/{record['id']}/answers", json=request)
        assert result.status_code == 200, result.text
        record = result.json()
    assert record["counts"] == {
        "correct": 0,
        "assisted": 0,
        "incorrect": 1,
        "skipped": 1,
        "unavailable": 1,
    }
    assert await session.scalar(select(func.count(ReviewLog.id))) == 0


async def test_pause_draft_conflict_and_owner_isolation(client, session):
    await seed(session)
    record = (await client.post("/practice", json={"mode": "spelling", "count": 5})).json()
    url = f"/practice/{record['id']}"
    result = await client.patch(
        url, json={"version": 0, "status": "paused", "draft": {"answer": "app", "hints": 2}}
    )
    assert result.json()["scope"]["draft"]["answer"] == "app"
    assert (await client.post(url + "/answers", json=body(record))).status_code == 409
    assert (await client.patch(url, json={"version": 0, "status": "active"})).status_code == 409
    stored = await session.get(PracticeSession, record["id"])
    stored.user_id = "someone-else"
    await session.commit()
    assert (await client.get(url)).status_code == 404
    assert (await client.get("/practice")).json()["total"] == 0


async def test_two_trainings_cannot_rate_same_snapshot(client, session):
    await seed(session)
    first = (await client.post("/practice", json={"mode": "review", "count": 5})).json()
    second = (await client.post("/practice", json={"mode": "review", "count": 5})).json()
    await client.post(f"/practice/{first['id']}/answers", json=body(first))
    failed = await client.post(f"/practice/{second['id']}/answers", json=body(second))
    assert failed.status_code == 409
    assert (await client.get(f"/practice/{second['id']}")).json()["cursor"] == 0
    assert await session.scalar(select(func.count(ReviewLog.id))) == 1


def test_homophones_need_actual_context_and_cloze_has_one_target():
    rows = [
        {"word": "sea", "translation": "海"},
        {"word": "see", "translation": "看", "example_en": "I see a cat."},
    ]
    assert [q["word"] for q in build_questions(rows, "dictation", 5)] == ["see"]
    assert build_questions(rows, "cloze", 5)[0]["prompt"] == "I _____ a cat."


def test_each_practice_mode_has_stable_progressive_hints():
    rows = [
        {
            "word": "careful",
            "translation": "adj. 小心的",
            "phonetic": "/ˈkeəfəl/",
            "example_en": "Be careful on the stairs.",
            "pos": "adj.",
        },
        {"word": "quiet", "translation": "安静的", "pos": "adj."},
        {"word": "rapid", "translation": "快速的", "pos": "adj."},
        {"word": "narrow", "translation": "狭窄的", "pos": "adj."},
    ]
    for mode in ["review", "learn", "spelling", "dictation", "listening", "cloze"]:
        question = build_questions(rows, mode, 1)[0]
        assert len(question["hint_steps"]) == 3
        assert all(step["label"] and step["text"] for step in question["hint_steps"])
        assert question["hint_steps"][-1]["reveals_answer"] is True
