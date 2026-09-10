"""按本清学习进度（FR-501）：有出处的保留清零、自动建的整行删、复习记录与场景进度清空。"""

from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import select

from domain.models import (
    DeckSceneState,
    DictEntry,
    PracticeAnswer,
    PracticeSession,
    ReviewLog,
    VocabEntry,
    VocabOccurrence,
)

NOW = datetime.now(UTC)


def _entry(word: str, **extra) -> VocabEntry:
    return VocabEntry(
        user_id="owner",
        word=word,
        status="learning",
        exposures=3,
        last_seen_at=NOW,
        self_test_at=NOW,
        mark="mastered",
        marked_at=NOW,
        fsrs_card={"stability": 5},
        due_at=NOW,
        last_review_at=NOW,
        **extra,
    )


async def _seed(session) -> dict[str, int]:
    session.add_all(
        [
            DictEntry(word="apple", tag="zk"),
            DictEntry(word="pear", tag="zk"),
            DictEntry(word="zebra", tag="gre"),
        ]
    )
    entries = {w: _entry(w) for w in ("apple", "pear", "zebra")}
    session.add_all(entries.values())
    await session.flush()
    # apple 是从阅读里收的（有出处），pear 只是看过（无出处），zebra 不在本里
    session.add(
        VocabOccurrence(
            vocab_id=entries["apple"].id,
            source_fingerprint="fp",
            context_text="An apple a day.",
        )
    )
    log = ReviewLog(vocab_id=entries["apple"].id, rating=3, state_before="new")
    session.add(log)
    await session.flush()
    practice = PracticeSession(
        id=str(uuid4()),
        user_id="owner",
        mode="spelling",
        status="finished",
        scope={},
        questions=[],
        created_at=NOW,
        updated_at=NOW,
    )
    session.add(practice)
    await session.flush()
    session.add(
        PracticeAnswer(
            id=str(uuid4()),
            session_id=practice.id,
            question_id="q",
            answer="apple",
            verdict="correct",
            review_log_id=log.id,
        )
    )
    session.add_all(
        [
            DeckSceneState(user_id="owner", deck="zk", scene="饮食商店", passed_at=NOW),
            DeckSceneState(user_id="owner", deck="gk", scene="饮食商店", passed_at=NOW),
        ]
    )
    await session.commit()
    # expire_all 之后再读 .id 会同步懒加载（MissingGreenlet），先把 id 抓出来
    return {w: e.id for w, e in entries.items()}


async def test_reset_keeps_collected_words_and_deletes_bare_ones(client, session):
    entries = await _seed(session)
    r = await client.post("/wordlists/zk/reset-progress")
    assert r.status_code == 200, r.text
    assert r.json() == {"words": 2, "reset": 1, "deleted": 1, "review_logs": 1, "scene_states": 1}

    session.expire_all()
    apple = await session.get(VocabEntry, entries["apple"])
    assert apple is not None
    assert (apple.exposures, apple.last_seen_at, apple.self_test_at, apple.mark) == (
        0,
        None,
        None,
        None,
    )
    assert (apple.marked_at, apple.fsrs_card, apple.due_at, apple.last_review_at) == (
        None,
        None,
        None,
        None,
    )
    assert apple.status == "new"
    assert await session.get(VocabEntry, entries["pear"]) is None
    zebra = await session.get(VocabEntry, entries["zebra"])
    assert zebra is not None and zebra.exposures == 3 and zebra.mark == "mastered"

    assert (await session.execute(select(ReviewLog))).scalars().all() == []
    answer = (await session.execute(select(PracticeAnswer))).scalar_one()
    assert answer.review_log_id is None
    states = (await session.execute(select(DeckSceneState.deck))).scalars().all()
    assert states == ["gk"]

    listing = (await client.get("/wordlists")).json()
    zk = next(d for d in listing if d["key"] == "zk")
    assert zk["mastery"] == {"new": 2, "learning": 0, "young": 0, "mature": 0, "hard": 0}
    assert (await client.get("/wordlists/zk/words?filter=new")).json()["total"] == 2


async def test_reset_vocab_deck_clears_everything_and_unknown_is_404(client, session):
    entries = await _seed(session)
    r = await client.post("/wordlists/__vocab__/reset-progress")
    assert r.status_code == 200, r.text
    assert r.json()["words"] == 3 and r.json()["deleted"] == 2
    session.expire_all()
    assert await session.get(VocabEntry, entries["zebra"]) is None
    assert (await client.post("/wordlists/nope/reset-progress")).status_code == 404
