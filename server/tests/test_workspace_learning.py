from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select

from domain import srs
from domain.analysis import content_key, save_result
from domain.models import (
    ExerciseAttempt,
    GrammarCard,
    GrammarCardState,
    GrammarPoint,
    Video,
    VideoFeedItem,
    VideoSubscription,
)


@pytest.mark.parametrize(
    "route", ["//evil.test", "https://evil.test", "/read?token=secret", "/unknown"]
)
async def test_snapshot_rejects_unsafe_routes(client, route):
    result = await client.put(
        "/workspace/snapshots",
        json={
            "module": "read",
            "key": "last-route",
            "value": {"route": route},
        },
    )
    assert result.status_code == 422


async def test_snapshot_roundtrip_and_clear(client):
    body = {"module": "grammar", "key": "draft", "value": {"text": "I am learning."}}
    assert (await client.put("/workspace/snapshots", json=body)).status_code == 200
    body["value"]["text"] = "I was learning."
    assert (await client.put("/workspace/snapshots", json=body)).status_code == 200
    rows = (await client.get("/workspace/snapshots")).json()
    assert len(rows) == 1
    assert rows[0]["value"]["text"] == "I was learning."
    assert (await client.delete("/workspace/snapshots")).status_code == 204
    assert (await client.get("/workspace/snapshots")).json() == []


async def test_dictionary_route_has_independent_workspace(client):
    body = {"module": "dict", "key": "last-route", "value": {"route": "/dict?q=think&w=think"}}
    assert (await client.put("/workspace/snapshots", json=body)).status_code == 200
    rows = (await client.get("/workspace/snapshots")).json()
    assert rows[0]["module"] == "dict"
    assert rows[0]["value"]["route"] == body["value"]["route"]


async def test_lecture_snapshot_accepts_punctuation_in_document_name(client):
    body = {
        "module": "grammar",
        "key": "lecture:03.英语句型手册/被字句：被…了，让人给…了.md",
        "value": {},
    }
    assert (await client.put("/workspace/snapshots", json=body)).status_code == 200
    body["key"] = "lecture:\ninvalid"
    assert (await client.put("/workspace/snapshots", json=body)).status_code == 422


async def test_secret_page_cannot_save_text(client):
    response = await client.put(
        "/workspace/snapshots",
        json={
            "module": "accounts",
            "key": "editor",
            "value": {"text": "private"},
        },
    )
    assert response.status_code == 422


async def test_sentence_history_reads_saved_result_without_analysis(
    client, session_factory, monkeypatch
):
    from app.routers import grammar_concepts

    def unexpected_analysis(_text):
        raise AssertionError("读取记录不应重新解析")

    monkeypatch.setattr(grammar_concepts, "parse_deps", unexpected_analysis)
    result = {"text": "I am learning.", "words": [], "spans": [], "legend": [], "arcs": []}
    async with session_factory() as db:
        row = await save_result(
            db,
            "sentence",
            content_key(result["text"]),
            content_key("owner:sentence-lab:v1"),
            "deconstruct",
            "spacy",
            result,
        )
        own_id = row.id
        other = await save_result(
            db,
            "sentence",
            content_key("Private sentence."),
            content_key("other:sentence-lab:v1"),
            "deconstruct",
            "spacy",
            {"text": "Private sentence."},
        )
        other_id = other.id
    history = (await client.get("/grammar/sentence-history")).json()
    assert [item["id"] for item in history["items"]] == [own_id]
    saved = await client.get(f"/grammar/sentence-history/{own_id}")
    assert saved.json() == {**result, "analysis_id": own_id}
    assert (await client.get(f"/grammar/sentence-history/{other_id}")).status_code == 404
    cached = await client.post("/grammar/concepts/deconstruct", json={"text": result["text"]})
    assert cached.json() == saved.json()


@pytest.fixture
async def grammar_cards(session_factory):
    async with session_factory() as db:
        point = GrammarPoint(ext_id="fixture", shorthand_code="test", item="Tense", category="verb")
        db.add(point)
        await db.flush()
        cards = [
            GrammarCard(
                grammar_point_id=point.id,
                kind="referential",
                widget="minimal-pair",
                payload={"choices": ["is", "was"], "answer": 0, "audio": {"text": "is"}},
            )
            for _ in range(3)
        ]
        db.add_all(cards)
        await db.flush()
        db.add(
            GrammarCardState(
                user_id="owner",
                card_id=cards[0].id,
                fsrs_card=srs.init_card(),
                due_at=datetime.now(UTC) - timedelta(days=1),
            )
        )
        await db.commit()
        return point.id, [c.id for c in cards]


async def test_stats_separate_new_and_due(client, grammar_cards):
    stats = (await client.get("/grammar/stats")).json()
    assert stats["new_count"] == 2
    assert stats["due_count"] == 1
    assert stats["due"] == 3


async def test_practice_snapshot_and_idempotent_grade(client, grammar_cards, session_factory):
    created = await client.post("/grammar/practice", json={"mode": "review"})
    assert created.status_code == 200, created.text
    practice = created.json()
    assert len(practice["questions"]) == 1
    item = practice["questions"][0]
    payload = {"submission_id": item["submission_id"], "response": 0, "rating": 3}
    url = f"/grammar/practice/{practice['id']}/answer"
    first = await client.post(url, json=payload)
    assert first.status_code == 200, first.text
    again = await client.post(url, json=payload)
    assert again.json() == first.json()
    stored = (await client.get(f"/grammar/practice/{practice['id']}")).json()
    assert stored["questions"] == practice["questions"]
    assert stored["cursor"] == 1
    async with session_factory() as db:
        assert await db.scalar(select(func.count()).select_from(ExerciseAttempt)) == 1
        state = await db.scalar(select(GrammarCardState))
        assert state.reps == 1


async def test_wrong_answer_cannot_receive_easy_rating(client, grammar_cards):
    practice = (await client.post("/grammar/practice", json={"mode": "review"})).json()
    result = await client.post(
        f"/grammar/practice/{practice['id']}/answer",
        json={
            "submission_id": practice["questions"][0]["submission_id"],
            "response": 1,
            "rating": 4,
        },
    )
    assert result.status_code == 422
    assert (await client.get(f"/grammar/practice/{practice['id']}")).json()["cursor"] == 0


async def test_online_collection_deduplicates_without_download(client, session_factory):
    first = await client.post("/videos/online", json={"url": "https://youtu.be/abcdefghijk"})
    assert first.status_code == 200, first.text
    second = await client.post(
        "/videos/online", json={"url": "https://www.youtube.com/watch?v=abcdefghijk"}
    )
    assert second.json() == {"id": first.json()["id"], "existed": True}
    async with session_factory() as db:
        video = await db.get(Video, first.json()["id"])
        assert video.status == "online"
        assert video.file_key is None
        assert await db.scalar(select(func.count()).select_from(Video)) == 1


@pytest.mark.parametrize(
    "url",
    [
        "file:///tmp/movie.mp4",
        "https://127.0.0.1/watch?v=abcdefghijk",
        "https://youtube.com.evil.test/watch?v=abcdefghijk",
    ],
)
async def test_online_collection_rejects_external_targets(client, url):
    assert (await client.post("/videos/online", json={"url": url})).status_code == 422


async def test_preview_survives_reload_and_keeps_first_answer(client, grammar_cards):
    practice = (await client.post("/grammar/practice", json={"mode": "review"})).json()
    url = f"/grammar/practice/{practice['id']}/answer"
    body = {"submission_id": practice["questions"][0]["submission_id"], "response": 1, "hints": 3}
    preview = await client.post(url, json=body)
    assert preview.status_code == 200, preview.text
    restored = (await client.get(f"/grammar/practice/{practice['id']}")).json()
    assert restored["cursor"] == 0
    assert restored["questions"][0]["draft_response"] == 1
    assert restored["questions"][0]["verdict"]["correct"] is False
    body.update(response=0, hints=0, rating=4)
    assert (await client.post(url, json=body)).status_code == 422
    body["rating"] = 2
    result = (await client.post(url, json=body)).json()["result"]
    assert result["first_correct"] is False
    assert result["hints"] == 3


async def test_discovery_cursor_and_confirmed_caption_filter(client, session_factory):
    async with session_factory() as db:
        source = VideoSubscription(kind="channel", source_id="test-channel", title="Test")
        db.add(source)
        await db.flush()
        db.add_all(
            [
                VideoFeedItem(
                    subscription_id=source.id,
                    video_key=f"video{i:06}",
                    title=f"Video {i}",
                    caption_kind="auto" if i < 65 else None,
                )
                for i in range(66)
            ]
        )
        await db.commit()
    first = (await client.get("/feed", params={"paginated": True, "only_captioned": True})).json()
    assert first["total"] == 65
    assert len(first["items"]) == 30
    second = (
        await client.get(
            "/feed",
            params={"paginated": True, "only_captioned": True, "cursor": first["next_cursor"]},
        )
    ).json()
    assert len(second["items"]) == 30
    assert not {item["id"] for item in first["items"]} & {item["id"] for item in second["items"]}
    unknown = (
        await client.get(
            "/feed", params={"paginated": True, "only_captioned": True, "include_unknown": True}
        )
    ).json()
    assert unknown["total"] == 66
