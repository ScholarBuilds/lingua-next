from sqlalchemy import event

from domain import decks
from domain.models import DictEntry


async def test_exam_totals_counts_exact_tags_in_one_query(session, db_engine):
    session.add_all([
        DictEntry(word="first", tag="cet4 cet6"),
        DictEntry(word="second", tag="cet4 cet6"),
        DictEntry(word="duplicate", tag="cet4 cet4"),
        DictEntry(word="spacing", tag="  cet6  ky "),
        DictEntry(word="substring", tag="xcet4 cet40"),
        DictEntry(word="empty", tag=""),
        DictEntry(word="missing", tag=None),
    ])
    await session.commit()
    statements = []

    def capture(_conn, _cursor, statement, _parameters, _context, _executemany):
        statements.append(statement)

    event.listen(db_engine.sync_engine, "before_cursor_execute", capture)
    try:
        totals = await decks.exam_totals(session)
    finally:
        event.remove(db_engine.sync_engine, "before_cursor_execute", capture)

    assert totals == {
        "zk": 0, "gk": 0, "cet4": 3, "cet6": 3,
        "ky": 1, "toefl": 0, "ielts": 0, "gre": 0,
    }
    assert len(statements) == 1
    assert "GROUP BY" in statements[0]
    assert "LIKE" not in statements[0]


async def test_exam_totals_empty_dictionary(session):
    assert await decks.exam_totals(session) == dict.fromkeys(decks.EXAM_WORDLISTS, 0)


async def test_shelf_reuses_then_refreshes_all_exam_totals(client, session, monkeypatch):
    from app.routers import wordlists

    monkeypatch.setattr(wordlists, "_total_cache", {})
    session.add(DictEntry(word="first", tag="cet4 cet6"))
    await session.commit()

    response = await client.get("/wordlists")
    assert response.status_code == 200
    totals = {row["key"]: row["total"] for row in response.json()}
    assert totals["cet4"] == totals["cet6"] == 1

    session.add(DictEntry(word="second", tag="cet4"))
    await session.commit()
    cached = {row["key"]: row["total"] for row in (await client.get("/wordlists")).json()}
    assert cached["cet4"] == 1

    wordlists._total_cache["cet4"] = (0, 1)
    refreshed = {row["key"]: row["total"] for row in (await client.get("/wordlists")).json()}
    assert refreshed["cet4"] == 2
    assert refreshed["cet6"] == 1
    assert len({expiry for expiry, _ in wordlists._total_cache.values()}) == 1
