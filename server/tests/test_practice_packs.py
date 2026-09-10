from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import select

from domain import practice_packs
from domain.models import PracticeAnswer, PracticePack, PracticeSession


async def finished(session, index=0):
    questions = [{"id": str(uuid4()), "word": f"word{i}", "translation": "词"} for i in range(5)]
    record = PracticeSession(
        id=str(uuid4()),
        user_id="owner",
        mode="spelling",
        status="finished",
        scope={},
        questions=questions,
        cursor=5,
        version=5,
        created_at=datetime.now(UTC),
        updated_at=datetime.now(UTC),
    )
    session.add(record)
    await session.flush()
    for q in questions:
        session.add(
            PracticeAnswer(
                id=str(uuid4()),
                session_id=record.id,
                question_id=q["id"],
                answer="wrong",
                hints=0,
                replays=0,
                verdict="incorrect",
            )
        )
    await session.flush()
    pack = await practice_packs.queue_pack(session, record)
    await session.commit()
    return record, pack


async def test_daily_quota_counts_failed_calls_and_never_repeats(session, monkeypatch):
    calls = []

    async def fail(*args, **kwargs):
        calls.append(1)
        raise practice_packs.LLMUnavailable("unavailable")

    monkeypatch.setattr(practice_packs, "complete_json", fail)
    records = [await finished(session, i) for i in range(6)]
    for _ in records:
        assert await practice_packs.process_next(session, "owner")
    assert len(calls) == 5
    assert records[-1][1].status == "limited"
    assert not await practice_packs.process_next(session, "owner")
    assert await practice_packs.queue_pack(session, records[0][0]) is records[0][1]
    profile = await practice_packs.profile_for(session, "owner")
    assert await practice_packs.auto_used(session, profile) == 5


async def test_restart_marks_running_interrupted_and_manual_priority(session, monkeypatch):
    _, first = await finished(session)
    _, second = await finished(session)
    second.automatic = False
    await session.commit()

    async def fail(*args, **kwargs):
        raise practice_packs.LLMUnavailable("unavailable")

    monkeypatch.setattr(practice_packs, "complete_json", fail)
    await practice_packs.process_next(session, "owner")
    assert second.status == "failed"
    assert first.status == "queued"
    first.status = "running"
    await session.commit()
    await practice_packs.recover_packs(session)
    assert (
        await session.scalar(select(PracticePack).where(PracticePack.id == first.id))
    ).status == "interrupted"


async def test_invalid_generated_answers_are_not_published(session, monkeypatch):
    _, pack = await finished(session)

    async def invalid(*args, **kwargs):
        return (
            {
                "en": "This is a short example passage.",
                "zh": "这是一篇短文。",
                "questions": [
                    {
                        "word": "unrelated",
                        "prompt": "Fill _____ here.",
                        "answers": ["unrelated"],
                        "explanation": "说明",
                    }
                ]
                * 3,
                "advice": "练习容易混淆的词。",
            },
            "test",
            20,
        )

    monkeypatch.setattr(practice_packs, "complete_json", invalid)
    await practice_packs.process_next(session, "owner")
    assert pack.status == "failed"
    assert pack.analysis_id is None


async def test_ready_pack_is_persistent_and_cache_does_not_charge(session, monkeypatch):
    _, pack = await finished(session)
    calls = []

    async def generate(*args, **kwargs):
        calls.append(1)
        return (
            {
                "en": "A short passage to practise the five selected words.",
                "zh": "一段用于练习五个单词的短文。",
                "questions": [
                    {
                        "word": f"word{i}",
                        "prompt": "Fill _____ here.",
                        "answers": [f"word{i}"],
                        "explanation": "按语境填词",
                    }
                    for i in range(3)
                ],
                "advice": "明天再练本轮错词。",
            },
            "test",
            20,
        )

    monkeypatch.setattr(practice_packs, "complete_json", generate)
    await practice_packs.process_next(session, "owner")
    assert pack.status == "ready"
    assert (await practice_packs.pack_payload(session, pack))["result"]["zh"]
    pack.status = "queued"
    await session.commit()
    await practice_packs.process_next(session, "owner")
    assert len(calls) == 1
    assert len(pack.charged_days) == 1
