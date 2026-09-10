from collections import Counter
from datetime import UTC, datetime

import pytest
from sqlalchemy import insert, select

from app.owner import OWNER_ID
from domain import study_stage
from domain.models import DictEntry, VocabEntry, Wordlist, WordlistItem


@pytest.fixture(autouse=True)
def isolated_totals(monkeypatch):
    from app.routers import wordlists

    monkeypatch.setattr(wordlists, "_total_cache", {})


async def test_capitalized_word_mark_survives_reload_and_filter(client, session):
    session.add(DictEntry(word="I", tag="zk"))
    await session.commit()
    for mark, bucket in [("mastered", "mature"), ("hard", "hard"), ("learning", "learning")]:
        result = await client.post("/wordlists/mark", json={"words": ["I"], "mark": mark})
        assert result.status_code == 200
        response = (await client.get("/wordlists/zk/words")).json()
        assert response["items"][0]["mark"] == mark
        assert response["items"][0]["bucket"] == bucket
        summaries = {row["key"]: row for row in (await client.get("/wordlists")).json()}
        assert summaries["zk"]["mastery"][bucket] == 1


async def test_sql_stage_matches_memory_rules(client, session):
    cards = [
        None,
        {},
        {"last_review": "2026-01-01", "state": 2, "stability": 30},
        {"last_review": "2026-01-01", "state": 1, "stability": 30},
        {"last_review": "2026-01-01", "state": "1", "stability": 30},
        {"last_review": "2026-01-01", "state": True, "stability": 30},
        {"last_review": "2026-01-01", "state": False, "stability": 30},
        {"last_review": "2026-01-01", "stability": "30"},
        {"difficulty": 8},
        {"last_review": "2026-01-01", "state": 2, "stability": 30, "difficulty": 8},
    ]
    for mark in [None, "learning", "hard", "mastered", "invalid"]:
        for card in cards:
            for seen in [0, 1]:
                session.add(
                    VocabEntry(
                        user_id=OWNER_ID,
                        word=f"{mark}-{card}-{seen}",
                        mark=mark,
                        fsrs_card=card,
                        exposures=seen,
                    )
                )
    await session.flush()
    rows = (await session.execute(select(VocabEntry, study_stage.sql_stage("sqlite")))).all()
    assert all(study_stage.stage(row) == stage for row, stage in rows)
    difficult = set(
        (
            await session.scalars(
                select(VocabEntry.id).where(study_stage.sql_filter("difficult", "sqlite"))
            )
        ).all()
    )
    assert difficult == {row.id for row, _ in rows if study_stage.is_hard(row, row.fsrs_card)}
    await session.commit()
    vocab = next(
        row for row in (await client.get("/wordlists")).json() if row["key"] == "__vocab__"
    )
    counts = Counter(study_stage.STAGE_BUCKET[stage] for _, stage in rows)
    assert vocab["mastery"] == {
        bucket: counts[bucket] for bucket in ["new", "learning", "young", "mature", "hard"]
    }
    memberships = []
    for mode, bucket in [
        ("new", "new"), ("learning", "learning"),
        ("mastered", "mature"), ("difficult", "hard"),
    ]:
        response = await client.get(
            "/wordlists/__vocab__/words", params={"filter": mode, "limit": 500}
        )
        result = response.json()
        assert result["total"] == vocab["mastery"][bucket]
        assert all(item["bucket"] == bucket for item in result["items"])
        memberships.extend(item["word"] for item in result["items"])
    assert len(memberships) == len(set(memberships)) == len(rows)


@pytest.mark.parametrize("size", [1603, 10000])
async def test_all_deck_kinds_filter_count_and_page_in_sql(client, session, monkeypatch, size):
    from app.routers import wordlists

    words = [f"term{i:05}" for i in range(size)]
    await session.execute(
        insert(DictEntry),
        [{"word": word, "lc": word, "tag": "zk", "frq": i} for i, word in enumerate(words)],
    )
    await session.execute(
        insert(VocabEntry),
        [
            {
                "user_id": OWNER_ID,
                "word": word,
                "exposures": 1,
                "mark": "mastered" if i % 4 == 0 else "learning",
                "created_at": datetime.now(UTC),
            }
            for i, word in enumerate(words)
        ],
    )
    deck = Wordlist(name="large", kind="custom")
    session.add(deck)
    await session.flush()
    await session.execute(
        insert(WordlistItem),
        [{"wordlist_id": deck.id, "word": word, "ordinal": i} for i, word in enumerate(words)],
    )
    await session.commit()
    original = wordlists._item_row
    calls = []

    def track(*args, **kwargs):
        calls.append(args[0])
        return original(*args, **kwargs)

    monkeypatch.setattr(wordlists, "_item_row", track)
    expected = words[::4]
    summaries = {row["key"]: row for row in (await client.get("/wordlists")).json()}
    for key in ["__vocab__", "zk", f"custom:{deck.id}"]:
        assert summaries[key]["mastery"]["mature"] == len(expected)
        assert summaries[key]["total"] == size
        calls.clear()
        response = await client.get(
            f"/wordlists/{key}/words",
            params={
                "filter": "mastered",
                "sort": "alpha",
                "offset": len(expected) - 20,
                "limit": 50,
            },
        )
        assert response.status_code == 200, response.text
        result = response.json()
        assert result["total"] == len(expected)
        assert [row["word"] for row in result["items"]] == expected[-20:]
        assert len(calls) == 20
        assert all(
            row["status"] == "known" and row["bucket"] == "mature" for row in result["items"]
        )
