import pytest
from sqlalchemy import func, select

from domain.models import VocabEntry, VocabOccurrence


async def test_word_status_uses_shared_mark_across_sources(client):
    result = await client.post("/wordlists/mark", json={"words": ["security"], "mark": "mastered"})
    assert result.status_code == 200
    result = (await client.get("/vocab/status", params={"words": "Security,unseenword"})).json()
    assert result["stages"] == {"security": "mastered", "unseenword": "unseen"}
    await client.post("/wordlists/mark", json={"words": ["security"], "mark": "hard"})
    assert (await client.get("/vocab/status", params={"words": "security"})).json()["stages"][
        "security"
    ] == "hard"


async def test_collection_keeps_scheduling_separate_and_tracks_sources(client, session):
    first = await client.post(
        "/vocab",
        json={
            "word": "context",
            "context_text": "The context makes the meaning clear.",
            "source": {
                "kind": "reader",
                "label": "Sample",
                "locator": {"article_id": 12, "sentence_id": 3},
            },
        },
    )
    assert first.status_code == 201, first.text
    payload = first.json()
    assert payload["created"] is True
    assert payload["occurrence_created"] is True
    assert payload["scheduled"] is False
    entry = await session.scalar(select(VocabEntry).where(VocabEntry.word == "context"))
    assert entry is not None
    assert entry.fsrs_card is None
    assert entry.due_at is None

    duplicate = await client.post(
        "/vocab",
        json={
            "word": "context",
            "context_text": "A changed rendering of the same sentence.",
            "source": {
                "kind": "reader",
                "label": "Sample",
                "locator": {"article_id": 12, "sentence_id": 3},
            },
        },
    )
    assert duplicate.status_code == 201
    assert duplicate.json()["occurrence_created"] is False

    second_source = await client.post(
        "/vocab",
        json={
            "word": "context",
            "context_text": "I heard context in a conversation.",
            "source": {
                "kind": "talk",
                "label": "Conversation",
                "locator": {"session_id": "session-1", "turn_id": 8},
            },
        },
    )
    assert second_source.status_code == 201
    assert second_source.json()["occurrences"] == 2
    assert await session.scalar(select(func.count(VocabOccurrence.id))) == 2

    enrolled = await client.post(f"/vocab/{entry.id}/enroll")
    assert enrolled.status_code == 200
    assert enrolled.json()["enrolled"] is True
    repeated = await client.post(f"/vocab/{entry.id}/enroll")
    assert repeated.status_code == 200
    assert repeated.json()["enrolled"] is False
    await session.refresh(entry)
    assert entry.fsrs_card is not None
    assert entry.due_at is not None


async def test_collection_rejects_external_source_locators(client):
    response = await client.post(
        "/vocab",
        json={
            "word": "unsafe",
            "context_text": "unsafe",
            "source": {
                "kind": "reader",
                "locator": {"article_id": "https://example.com/article"},
            },
        },
    )
    assert response.status_code == 422


@pytest.mark.parametrize(
    ("kind", "locator"),
    [
        ("reader", {"article_id": 1, "sentence_id": 2}),
        ("video", {"video_id": 1, "cue_id": 2}),
        ("talk", {"session_id": "session-1", "turn_id": "turn-2"}),
        ("grammar", {"document": "grammar-1", "section": "section-2"}),
        ("wordlist", {"deck": "gk", "word": "source"}),
        ("practice", {"session_id": "practice-1", "question_id": "question-2"}),
        ("manual", {}),
    ],
)
async def test_collection_accepts_supported_source_kinds(client, session, kind, locator):
    response = await client.post(
        "/vocab",
        json={
            "word": "source",
            "context_text": "This word came from a learning surface.",
            "source": {"kind": kind, "label": kind, "locator": locator},
        },
    )

    assert response.status_code == 201, response.text
    assert response.json()["occurrence"]["source_kind"] == kind
    entry = await session.scalar(select(VocabEntry).where(VocabEntry.word == "source"))
    assert entry is not None
    assert entry.fsrs_card is None


async def test_overview_keeps_all_exam_wordlists(client):
    response = await client.get("/vocab/overview")
    assert response.status_code == 200, response.text
    exam_keys = {deck["key"] for deck in response.json()["decks"] if deck["kind"] == "exam"}
    assert exam_keys == {"zk", "gk", "cet4", "cet6", "ky", "ielts", "toefl", "gre"}
