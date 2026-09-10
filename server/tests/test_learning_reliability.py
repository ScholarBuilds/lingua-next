import asyncio
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import create_async_engine

from domain import srs, study_stage
from domain.models import Base, DeckScene, LearningReceipt, ReviewLog, VocabEntry
from tests.test_practice import body, seed


@pytest.fixture
async def db_engine(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'learning.sqlite3'}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    yield engine
    await engine.dispose()


async def test_concurrent_review_replays_one_receipt(client, session):
    await seed(session)
    record = (await client.post("/practice", json={"mode": "review", "count": 5})).json()
    request = body(record)
    results = await asyncio.gather(
        *[client.post(f"/practice/{record['id']}/answers", json=request) for _ in range(2)]
    )
    assert [response.status_code for response in results] == [200, 200]
    assert results[0].json() == results[1].json()
    assert await session.scalar(select(func.count(ReviewLog.id))) == 1


async def test_stage_reconciliation_is_read_only_until_applied(session):
    entry = VocabEntry(user_id="owner", word="kept", mark="mastered", status="learning")
    session.add(entry)
    await session.commit()
    preview = await study_stage.reconcile_status(session)
    assert preview["count"] == 1
    assert entry.status == "learning"
    result = await study_stage.reconcile_status(session, apply=True)
    assert result["changes"] == preview["changes"]
    assert entry.status == "known"
    assert entry.fsrs_card is None


async def test_scene_receipt_version_membership_and_new_run(client, session):
    session.add(DeckScene(deck="zk", word="apple", scene="food", track="scene"))
    await session.commit()
    path = "/wordlists/zk/scenes/food/quiz"
    assert (await client.get(path)).status_code == 200
    request = {
        "submission_id": str(uuid4()),
        "run_id": str(uuid4()),
        "version": 0,
        "passed": ["apple", " apple "],
        "first_try_ok": 1,
        "first_try_total": 1,
        "cursor": 1,
    }
    result = await client.post(path, json=request)
    assert result.status_code == 200, result.text
    assert (await client.post(path, json=request)).json() == result.json()
    assert result.json()["attempts"] == 1
    assert result.json()["version"] == 1
    stale = {**request, "submission_id": str(uuid4()), "cursor": 0}
    assert (await client.post(path, json=stale)).status_code == 409
    assert (await client.post(path, json={**stale, "passed": ["foreign"]})).status_code == 422
    assert (await client.post(path, json={**stale, "first_try_ok": 2})).status_code == 422
    assert (await client.post(path.replace("food", "missing"), json=request)).status_code == 404
    again = await client.post(path, json={**stale, "version": 1, "run_id": str(uuid4())})
    assert again.status_code == 200, again.text
    assert again.json()["cursor"] == 0
    assert again.json()["attempts"] == 2
    assert await session.scalar(select(func.count(VocabEntry.id))) == 1
    assert await session.scalar(select(func.count(ReviewLog.id))) == 0
    assert await session.scalar(select(func.count(LearningReceipt.id))) == 2


async def test_concurrent_first_scene_submission_rejects_stale_version(client, session):
    session.add(DeckScene(deck="zk", word="apple", scene="food", track="scene"))
    await session.commit()
    request = {
        "run_id": str(uuid4()),
        "version": 0,
        "passed": ["apple"],
        "first_try_ok": 1,
        "first_try_total": 1,
        "cursor": 1,
    }
    results = await asyncio.gather(
        *[
            client.post(
                "/wordlists/zk/scenes/food/quiz", json={**request, "submission_id": str(uuid4())}
            )
            for _ in range(2)
        ]
    )
    assert sorted(response.status_code for response in results) == [200, 409]
    assert await session.scalar(select(func.count(LearningReceipt.id))) == 1


async def test_old_review_replay_and_conflict_preserve_manual_mark(client, session):
    entry = VocabEntry(
        user_id="owner",
        word="apple",
        mark="mastered",
        fsrs_card=srs.init_card(),
        due_at=datetime.now(UTC) - timedelta(days=1),
    )
    session.add(entry)
    await session.commit()
    request = {"submission_id": str(uuid4()), "card_version": None, "rating": 1}
    first = await client.post(f"/review/{entry.id}", json=request)
    assert first.status_code == 200, first.text
    assert (await client.post(f"/review/{entry.id}", json=request)).json() == first.json()
    conflict = await client.post(
        f"/review/{entry.id}", json={**request, "submission_id": str(uuid4())}
    )
    assert conflict.status_code == 409
    await session.refresh(entry)
    assert entry.status == "known"
    assert await session.scalar(select(func.count(ReviewLog.id))) == 1
    assert (await client.get("/review/report")).json()["totals"]["known"] == 1


async def test_retry_rebuilds_spelling_hints_and_replays_original_response(client, session):
    await seed(session)
    record = (await client.post("/practice", json={"mode": "review", "count": 5})).json()
    request = body(record, rating=1)
    first = await client.post(f"/practice/{record['id']}/answers", json=request)
    second = await client.post(f"/practice/{record['id']}/answers", json=body(first.json()))
    assert second.status_code == 200, second.text
    assert (
        await client.post(f"/practice/{record['id']}/answers", json=request)
    ).json() == first.json()
    retry = await client.post(f"/practice/{record['id']}/retry")
    assert retry.status_code == 200, retry.text
    question = retry.json()["questions"][0]
    assert retry.json()["mode"] == "spelling"
    assert question["hint_steps"][-1]["text"] == question["word"]
    assert question["options"] == []
