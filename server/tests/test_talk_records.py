import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select

from app.routers import realtime, talk_records
from domain.llm import LLMUnavailable
from domain.models import AnalysisResult, TalkCoachBatch, TalkSession, TalkTurn


async def seed(session, count=2, ended=False):
    talk = TalkSession(
        mode="realtime",
        difficulty="medium",
        user_id=None,
        ended_at=datetime.now(UTC) if ended else None,
    )
    session.add(talk)
    await session.flush()
    turns = [
        TalkTurn(
            session_id=talk.id,
            ordinal=i,
            role="assistant" if i % 2 == 0 else "user",
            text="Hello again. How are you?",
            message_id=f"{talk.id}-{i}",
        )
        for i in range(count)
    ]
    session.add_all(turns)
    await session.commit()
    return talk, turns


@pytest.fixture
def coach(monkeypatch):
    calls = []

    async def generate(text, difficulty, scenario, **kwargs):
        calls.append({"text": text, **kwargs})
        kwargs["metadata"].update(model="test-model", latency_ms=12)
        return {
            "translation": "很高兴再次见面",
            "intent": "询问近况",
            "replies": [
                {"en": f"Reply {kwargs['variant']}-{i}", "zh": "我很好", "tone": "简短"}
                for i in range(3)
            ],
        }

    monkeypatch.setattr(talk_records, "coach_message", generate)
    return calls


async def test_message_batches_persist_and_do_not_share_repeated_text(client, session, coach):
    talk, turns = await seed(session, 3)
    url = f"/talk/sessions/{talk.id}/turns/{turns[0].id}/coach"
    first = (await client.post(url, json={})).json()
    assert first["status"] == "ready"
    assert first["model"] == "test-model"
    assert (await client.post(url, json={})).json()["id"] == first["id"]
    second = (await client.post(url, json={"batch_index": 1})).json()
    assert second["batch_index"] == 1
    assert coach[1]["previous_replies"] == ["Reply 0-0", "Reply 0-1", "Reply 0-2"]
    assert len(coach[0]["history"]) == 1
    assert len((await client.get(url)).json()) == 2
    other = f"/talk/sessions/{talk.id}/turns/{turns[2].id}/coach"
    await client.post(other, json={})
    assert len(coach) == 3
    assert coach[2]["previous_replies"] == []
    assert len(coach[2]["history"]) == 3
    assert await session.scalar(select(func.count(AnalysisResult.id))) == 3


async def test_context_excludes_future_and_is_bounded(client, session, coach):
    talk, turns = await seed(session, 22)
    await client.post(f"/talk/sessions/{talk.id}/turns/{turns[18].id}/coach", json={})
    assert len(coach[0]["history"]) == 13
    for turn in turns[19:]:
        turn.text = "Future private text"
    await session.commit()
    assert "Future private text" not in str(coach[0]["history"])


async def test_pagination_search_and_expression_bookmarks(client, session, coach):
    talk, turns = await seed(session, 123)
    base = f"/talk/sessions/{talk.id}"
    latest = (await client.get(f"{base}/records")).json()
    assert len(latest["items"]) == 50 and latest["total"] == 123
    assert latest["items"][0]["ordinal"] == 73
    older = (await client.get(f"{base}/records?before={latest['next_cursor']}")).json()
    assert older["items"][-1]["ordinal"] == 72
    target = turns[0].id
    await client.post(f"{base}/turns/{target}/coach", json={})
    assert (await client.get(f"{base}/records?q=再次见面")).json()["total"] == 1
    assert (await client.get(f"{base}/records?q=%25")).json()["total"] == 0
    assert (
        await client.put(
            f"{base}/turns/{target}/saved", json={"saved": True, "text": "Hello again."}
        )
    ).status_code == 200
    saved = (await client.get(f"{base}/records?saved=true")).json()
    assert saved["total"] == 1
    assert saved["items"][0]["saved_texts"] == ["Hello again."]
    assert (
        await client.put(
            f"{base}/turns/{target}/saved", json={"saved": True, "text": "Not in this turn"}
        )
    ).status_code == 422
    await client.put(f"{base}/turns/{target}/saved", json={"saved": False, "text": "Hello again."})
    await client.put(
        f"{base}/turns/{target}/saved", json={"saved": True, "batch_index": 0, "reply_index": 1}
    )
    assert (await client.get(f"{base}/records?saved=true")).json()["items"][0]["batches"][0][
        "saved_replies"
    ] == [1]
    assert (await client.get(f"{base}/records?role=user")).json()["total"] == 61


async def test_failure_requires_explicit_retry_and_keeps_ready_batch(
    client, session, coach, monkeypatch
):
    talk, turns = await seed(session)
    url = f"/talk/sessions/{talk.id}/turns/{turns[0].id}/coach"
    await client.post(url, json={})
    original = talk_records.coach_message

    async def fail(*args, **kwargs):
        raise LLMUnavailable("offline")

    monkeypatch.setattr(talk_records, "coach_message", fail)
    result = (await client.post(url, json={"batch_index": 1})).json()
    assert result["status"] == "failed"
    monkeypatch.setattr(talk_records, "coach_message", original)
    assert (await client.post(url, json={"batch_index": 1})).json()["status"] == "failed"
    assert len(coach) == 1
    assert (await client.post(url, json={"batch_index": 1, "retry": True})).json()[
        "status"
    ] == "ready"
    assert len((await client.get(url)).json()) == 2


async def test_running_request_is_reused(client, session, monkeypatch):
    talk, turns = await seed(session)
    entered, release = asyncio.Event(), asyncio.Event()
    calls = 0

    async def slow(*args, **kwargs):
        nonlocal calls
        calls += 1
        entered.set()
        await release.wait()
        return {"translation": "你好", "intent": "问候", "replies": []}

    monkeypatch.setattr(talk_records, "coach_message", slow)
    url = f"/talk/sessions/{talk.id}/turns/{turns[0].id}/coach"
    first = asyncio.create_task(client.post(url, json={}))
    await entered.wait()
    try:
        duplicate = await client.post(url, json={"retry": True})
        assert duplicate.json()["status"] == "running"
        assert calls == 1
    finally:
        release.set()
        await first


async def test_validation_and_ownership(client, session, coach):
    talk, turns = await seed(session)
    base = f"/talk/sessions/{talk.id}"
    assert (await client.post(f"{base}/turns/{turns[1].id}/coach", json={})).status_code == 422
    assert (
        await client.post(f"{base}/turns/{turns[0].id}/coach", json={"batch_index": 2})
    ).status_code == 409
    assert (
        await client.post(f"{base}/turns/{turns[0].id}/coach", json={"batch_index": 20})
    ).status_code == 422
    talk.user_id = 98765
    await session.commit()
    assert (await client.get(f"{base}/records")).status_code == 404
    assert (await client.delete(base)).status_code == 404
    assert len(coach) == 0


async def test_restart_marks_pending_interrupted_and_closes_live_session(session):
    talk, turns = await seed(session)
    pending = TalkCoachBatch(turn_id=turns[0].id, batch_index=0, status="running")
    session.add(pending)
    await session.commit()
    await talk_records.recover_interrupted(session)
    await session.refresh(pending)
    await session.refresh(talk)
    assert pending.status == "interrupted"
    assert talk.ended_at is not None


async def test_expired_batch_only_recovers_on_read(client, session, coach):
    talk, turns = await seed(session)
    session.add(
        TalkCoachBatch(
            turn_id=turns[0].id,
            batch_index=0,
            status="running",
            updated_at=datetime.now(UTC) - timedelta(minutes=4),
        )
    )
    await session.commit()
    result = (await client.get(f"/talk/sessions/{talk.id}/turns/{turns[0].id}/coach")).json()
    assert result[0]["status"] == "interrupted"
    assert coach == []


async def test_delete_requires_end_and_removes_associated_data(client, session, coach):
    talk, turns = await seed(session)
    base = f"/talk/sessions/{talk.id}"
    assert (await client.delete(base)).status_code == 409
    await client.post(f"{base}/turns/{turns[0].id}/coach", json={})
    talk.ended_at = datetime.now(UTC)
    await session.commit()
    assert (await client.delete(base)).status_code == 200
    for model in (TalkTurn, TalkCoachBatch, AnalysisResult):
        assert await session.scalar(select(func.count(model.id))) == 0


async def test_summary_failure_does_not_lose_or_reopen_session(client, session, monkeypatch):
    from app.routers import talk as router

    talk, turns = await seed(session)

    async def fail(*args, **kwargs):
        raise LLMUnavailable("offline")

    monkeypatch.setattr(router, "summarize_session", fail)
    assert (await client.post(f"/talk/sessions/{talk.id}/end")).status_code == 503
    await session.refresh(talk)
    assert talk.ended_at is not None
    assert (await client.get(f"/talk/sessions/{talk.id}/records")).json()["total"] == 2


async def test_writer_retries_keep_original_order_and_id(session, session_factory, monkeypatch):
    talk, _ = await seed(session, 0)
    monkeypatch.setattr(realtime, "SessionFactory", session_factory)

    class Socket:
        def __init__(self):
            self.events = []

        async def send_json(self, event):
            self.events.append(event)

    socket = Socket()
    writer = realtime._TurnWriter(talk.id, socket)
    original = writer.save
    failed = False

    async def intermittent(item):
        nonlocal failed
        if not failed:
            failed = True
            raise OSError("database temporarily unavailable")
        await original(item)

    writer.save = intermittent
    writer.append("assistant", "Same text", "first", True)
    writer.append("assistant", "Same text", "second", True)
    writer.append("assistant", "Same text", "second", True)
    await writer.finish()
    rows = (await session.scalars(select(TalkTurn).order_by(TalkTurn.ordinal))).all()
    assert [r.message_id for r in rows] == ["first", "second"]
    assert any(e["type"] == "save_error" for e in socket.events)
    assert socket.events[-1]["message_id"] == "first"


def test_collector_duplicate_end_and_interruption():
    captured = []
    collector = realtime._TurnCollector(lambda *args: captured.append(args))
    collector.on_reply_delta("Hello.")
    first_id = collector.reply_id
    collector.flush_reply()
    collector.flush_reply()
    collector.on_reply_delta("Hello.")
    collector.flush_all()
    assert len(captured) == 2
    assert captured[0] == ("assistant", "Hello.", first_id, True)
    assert captured[1][2] != first_id and captured[1][3] is False
