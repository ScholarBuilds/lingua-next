import importlib
from datetime import UTC, datetime

from sqlalchemy import select

from app.owner import OWNER_ID
from domain.models import DictEntry, ReviewLog, VocabEntry, VocabOccurrence


async def test_exposure_persists_across_case_and_reentry(client, session):
    session.add_all([DictEntry(word=word, tag="gk") for word in ["American", "North", "TV"]])
    await session.commit()
    for _ in range(2):
        response = await client.post(
            "/wordlists/expose", json={"words": ["American", "North", "TV"]}
        )
        assert response.status_code == 200
        assert response.json()["stages"] == {
            "american": "learning",
            "north": "learning",
            "tv": "learning",
        }
        rows = (await client.get("/wordlists/gk/words")).json()["items"]
        assert {row["bucket"] for row in rows} == {"learning"}
    records = list((await session.scalars(select(VocabEntry))).all())
    assert {row.word for row in records} == {"american", "north", "tv"}
    assert all(row.exposures == 2 for row in records)
    await client.post("/wordlists/mark", json={"words": ["TV"], "mark": "mastered"})
    await client.post("/wordlists/expose", json={"words": ["TV"]})
    status = (await client.get("/vocab/status", params={"words": "TV"})).json()
    assert status["stages"]["tv"] == "mastered"


async def test_migration_preserves_learning_and_history(session, monkeypatch):
    now = datetime.now(UTC)
    upper = VocabEntry(user_id=OWNER_ID, word="I", exposures=14)
    lower = VocabEntry(user_id=OWNER_ID, word="i", mark="mastered", marked_at=now)
    american = VocabEntry(user_id=OWNER_ID, word="American", exposures=6)
    session.add_all([upper, lower, american])
    await session.flush()
    session.add(ReviewLog(vocab_id=upper.id, rating=3, state_before="new"))
    session.add(
        VocabOccurrence(vocab_id=upper.id, source_fingerprint="source", context_text="I read.")
    )
    await session.commit()
    migration = importlib.import_module("migrations.versions.c9d0e1f2a3b4_normalize_learning_words")

    def run(connection):
        monkeypatch.setattr(migration.op, "get_bind", lambda: connection)
        migration.upgrade()
        migration.upgrade()

    await (await session.connection()).run_sync(run)
    session.expire_all()
    rows = {row.word: row for row in (await session.scalars(select(VocabEntry))).all()}
    assert set(rows) == {"i", "american"}
    assert rows["i"].exposures == 14
    assert rows["i"].mark == "mastered"
    assert rows["american"].exposures == 6
    assert (await session.scalar(select(ReviewLog))).vocab_id == lower.id
    assert (await session.scalar(select(VocabOccurrence))).vocab_id == lower.id
