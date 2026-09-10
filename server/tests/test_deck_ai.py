"""本级 AI 补全（FR-502）：命中条件、分片续跑、取消、熔断、对账。"""

import asyncio
from contextlib import asynccontextmanager

import pytest
from sqlalchemy import event
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from domain import deck_ai
from domain.analysis import content_key, get_cached, save_result
from domain.llm import LLMUnavailable
from domain.models import (
    AnalysisResult,
    Base,
    DeckAiRun,
    DictEntry,
    VocabEntry,
    Wordlist,
    WordlistItem,
    WordScene,
)


async def test_audio_preload_has_shared_progress_and_failure(session, factory, monkeypatch):
    session.add_all([DictEntry(word="apple", tag="zk"), DictEntry(word="pear", tag="zk")])
    await session.commit()

    async def preload(text, scene, session_factory):
        assert scene == "word"
        if text == "pear":
            raise ValueError("audio unavailable")
        return True

    monkeypatch.setattr(deck_ai.tts_preload, "preload", preload)
    run = await deck_ai.start_run(session, "zk", "owner", ["tts"], False)
    await session.commit()
    assert await deck_ai.run_slice(run.id, session_factory=factory) == ("done", 2)
    assert run.cached == 1 and run.failed == 1


async def test_cached_deck_uses_chunked_address_queries(session, factory, fake_llm):
    for index in range(130):
        word = f"word{index:03}"
        session.add(DictEntry(word=word, tag="zk"))
        session.add(
            AnalysisResult(**deck_ai.explain_address(word, f"中考：{word}"), result={"ok": True})
        )
    await session.commit()
    run = await deck_ai.start_run(session, "zk", "owner", ["explain"], False)
    await session.commit()
    statements = []

    def record(_conn, _cursor, statement, _parameters, _context, _many):
        if statement.lstrip().upper().startswith("SELECT") and "analysis_result" in statement:
            statements.append(statement)

    engine = session.bind.sync_engine
    event.listen(engine, "before_cursor_execute", record)
    try:
        assert await deck_ai.run_slice(run.id, session_factory=factory) == ("done", 130)
    finally:
        event.remove(engine, "before_cursor_execute", record)
    assert len(statements) == 2
    assert all("analysis_result.result" not in statement for statement in statements)
    assert run.cached == 130 and not fake_llm


async def test_slow_word_does_not_drain_at_eighty_words(session, factory, monkeypatch):
    session.add_all(DictEntry(word=f"word{i:03}", tag="zk") for i in range(100))
    await session.commit()
    crossed = asyncio.Event()
    calls = 0

    async def complete(*_args):
        nonlocal calls
        calls += 1
        if calls == 1:
            await asyncio.wait_for(crossed.wait(), 3)
        if calls >= 81:
            crossed.set()
        return {"ok": True}, "fake", 1

    monkeypatch.setattr(deck_ai, "complete_json", complete)
    run = await deck_ai.start_run(session, "zk", "owner", ["explain"], False)
    await session.commit()
    assert await deck_ai.run_slice(run.id, session_factory=factory) == ("done", 100)
    assert crossed.is_set() and run.failed == 0 and run.generated == 100


async def test_batch_cache_keeps_full_address_and_active_version(session):
    addr = deck_ai.explain_address("apple", "An apple a day.")
    session.add_all(
        [
            AnalysisResult(**{**addr, "provider": "other"}, result={}),
            AnalysisResult(**addr, lang_pair="zh->en", result={}),
            AnalysisResult(**{**addr, "scope": "sentence"}, result={}),
            AnalysisResult(**{**addr, "context_hash": "different"}, result={}),
            AnalysisResult(**addr, result={}, is_active=False),
        ]
    )
    await session.commit()
    key = (addr["content_hash"], addr["context_hash"], addr["kind"])
    assert await deck_ai._cached_addresses(session, [key]) == set()
    await save_result(session, **addr, result={"ok": True})
    assert await deck_ai._cached_addresses(session, [key]) == {key}


async def test_slow_request_does_not_block_refilling_slots(session, factory, monkeypatch):
    await _seed(session)
    monkeypatch.setattr(deck_ai, "CONCURRENCY", 2)
    monkeypatch.setattr(deck_ai, "_gate", asyncio.Semaphore(2))
    third_started = asyncio.Event()
    active = peak = calls = 0

    async def complete(*_args):
        nonlocal active, peak, calls
        calls += 1
        order = calls
        active += 1
        peak = max(peak, active)
        try:
            if order == 1:
                await asyncio.wait_for(third_started.wait(), 1)
            elif order == 3:
                third_started.set()
            return {"ok": True}, "fake", 1
        finally:
            active -= 1

    monkeypatch.setattr(deck_ai, "complete_json", complete)
    run = await deck_ai.start_run(session, "zk", "owner", ["explain"], False)
    await session.commit()
    assert await deck_ai.run_slice(run.id, session_factory=factory) == ("done", 5)
    assert third_started.is_set() and peak == 2
    assert run.generated == 5 and run.failed == 0 and run.cursor == run.done == 5


async def test_cached_progress_releases_sqlite_writer_before_model_call(tmp_path, monkeypatch):
    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'cache.sqlite3'}", connect_args={"timeout": 0.1}
    )
    factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with factory() as session:
            await _seed(session)
            await save_result(
                session,
                **deck_ai.explain_address("apple", "An apple a day."),
                result={"cached": True},
            )
            run = await deck_ai.start_run(session, "zk", "owner", ["explain"], False)
            await session.commit()
            run_id = run.id
        calls = 0

        async def complete(*_args):
            nonlocal calls
            calls += 1
            word = f"ledger-{calls}"
            async with factory() as writer:
                writer.add(VocabEntry(user_id="owner", word=word))
                await writer.commit()
            return {"ok": True}, "fake", 1

        monkeypatch.setattr(deck_ai, "complete_json", complete)
        assert await deck_ai.run_slice(run_id, session_factory=factory) == ("done", 5)
        async with factory() as session:
            run = await session.get(DeckAiRun, run_id)
            assert run.cached == 1 and run.generated == 4 and run.failed == 0
    finally:
        await engine.dispose()


async def test_cancel_drains_inflight_without_scheduling_more(session, factory, monkeypatch):
    await _seed(session)
    monkeypatch.setattr(deck_ai, "CONCURRENCY", 2)
    monkeypatch.setattr(deck_ai, "_gate", asyncio.Semaphore(2))
    started = asyncio.Event()
    release = asyncio.Event()
    calls = 0

    async def complete(*_args):
        nonlocal calls
        calls += 1
        if calls == 2:
            started.set()
        await release.wait()
        return {"ok": True}, "fake", 1

    monkeypatch.setattr(deck_ai, "complete_json", complete)
    run = await deck_ai.start_run(session, "zk", "owner", ["explain"], False)
    await session.commit()
    task = asyncio.create_task(deck_ai.run_slice(run.id, session_factory=factory))
    await asyncio.wait_for(started.wait(), 1)
    await deck_ai.request_cancel(session, run)
    await session.commit()
    release.set()
    assert await task == ("cancelled", 2)
    assert calls == 2 and run.generated == 2


async def test_cache_conflict_rollback_does_not_expire_progress(
    session, factory, fake_llm, monkeypatch
):
    await _seed(session)
    original = deck_ai.save_result

    async def save_after_conflict(session, **values):
        await session.rollback()
        return await original(session, **values)

    monkeypatch.setattr(deck_ai, "save_result", save_after_conflict)
    run = await deck_ai.start_run(session, "zk", "owner", ["explain"], False)
    await session.commit()
    run_id = run.id
    assert await deck_ai.run_slice(run_id, session_factory=factory) == ("done", 5)
    assert run.generated == 5 and run.done == 5


async def _seed(session) -> Wordlist:
    session.add_all(
        [
            DictEntry(word="apple", tag="zk", phonetic="ˈæpl", exchange="0:apple/s:apples"),
            DictEntry(word="ran", tag="zk", exchange="0:run/p:ran"),
            DictEntry(word="run", phonetic="rʌn"),
            DictEntry(word="pear", tag="zk"),
            DictEntry(word="plum", tag="zk"),
            DictEntry(word="fig", tag="zk"),
            WordScene(word="apple", example_en="An apple a day."),
        ]
    )
    custom = Wordlist(name="厨房用具")
    session.add(custom)
    await session.flush()
    session.add(WordlistItem(wordlist_id=custom.id, word="spoon", example_en="Use a spoon."))
    await session.commit()
    return custom


@pytest.fixture
def fake_llm(monkeypatch):
    calls: list[tuple[str, str]] = []

    async def complete(capability, system, user, **_):
        calls.append((capability, user))
        return {"ok": True}, "fake-model", 7

    monkeypatch.setattr(deck_ai, "complete_json", complete)
    return calls


@pytest.fixture
def factory(session):
    @asynccontextmanager
    async def _factory():
        yield session

    return _factory


async def test_run_hits_the_same_addresses_as_the_word_card(session, fake_llm, factory):
    await _seed(session)
    run = await deck_ai.start_run(session, "zk", "owner", ["explain", "breakdown"], False)
    await session.commit()
    assert run.total == 5

    outcome, cursor = await deck_ai.run_slice(run.id, session_factory=factory)
    assert (outcome, cursor) == ("done", 5)
    assert run.status == "done" and run.done == 5
    assert run.generated == 10 and run.cached == 0 and run.failed == 0

    # 释义：有例句用例句，没有用「本名：词」（全角冒号）；拆开记：ran 按 lemma run 寻址
    assert await get_cached(
        session,
        "word",
        content_key("apple"),
        content_key("An apple a day."),
        "word_explain",
        deck_ai.PROVIDER,
    )
    assert await get_cached(
        session,
        "word",
        content_key("pear"),
        content_key("中考：pear"),
        "word_explain",
        deck_ai.PROVIDER,
    )
    assert await get_cached(
        session, "word", content_key("run"), "", "word_breakdown", deck_ai.PROVIDER
    )
    assert (
        await get_cached(
            session, "word", content_key("ran"), "", "word_breakdown", deck_ai.PROVIDER
        )
        is None
    )
    assert any("rʌn" in user for _, user in fake_llm)

    # 二跑全部命中，一次都不调
    again = await deck_ai.start_run(session, "zk", "owner", ["explain", "breakdown"], False)
    await session.commit()
    before = len(fake_llm)
    assert await deck_ai.run_slice(again.id, session_factory=factory) == ("done", 5)
    assert len(fake_llm) == before and again.cached == 10 and again.generated == 0


async def test_slices_resume_from_cursor_and_cancel_stops_at_boundary(
    session, fake_llm, factory, monkeypatch
):
    await _seed(session)
    monkeypatch.setattr(deck_ai, "SLICE_WORDS", 2)
    run = await deck_ai.start_run(session, "zk", "owner", ["explain"], False)
    await session.commit()
    assert await deck_ai.run_slice(run.id, session_factory=factory) == ("continue", 2)
    assert run.status == "running" and run.done == 2
    assert deck_ai.job_id(run.id, 2) == f"deck_ai:{run.id}:2"
    assert await deck_ai.run_slice(run.id, session_factory=factory) == ("continue", 4)

    await deck_ai.request_cancel(session, run)
    await session.commit()
    calls_before = len(fake_llm)
    assert await deck_ai.run_slice(run.id, session_factory=factory) == ("cancelled", 4)
    assert run.status == "cancelled" and len(fake_llm) == calls_before


async def test_breaker_fails_run_when_model_is_down(session, factory, monkeypatch):
    await _seed(session)

    async def down(*_args, **_kwargs):
        raise LLMUnavailable("no binding")

    monkeypatch.setattr(deck_ai, "complete_json", down)
    run = await deck_ai.start_run(session, "zk", "owner", ["explain", "breakdown"], False)
    await session.commit()
    outcome, _ = await deck_ai.run_slice(run.id, session_factory=factory)
    assert outcome == "failed" and run.status == "failed"
    assert run.error and run.failed >= deck_ai.BREAKER


async def test_refresh_regenerates_even_when_cached(session, fake_llm, factory):
    custom = await _seed(session)
    await save_result(
        session, **deck_ai.explain_address("spoon", "Use a spoon."), result={"old": 1}
    )
    run = await deck_ai.start_run(session, f"custom:{custom.id}", "owner", ["explain"], True)
    await session.commit()
    assert await deck_ai.run_slice(run.id, session_factory=factory) == ("done", 1)
    assert run.generated == 1 and run.cached == 0
    row = await get_cached(session, **deck_ai.explain_address("spoon", "Use a spoon."))
    assert row is not None and row.result == {"ok": True} and row.version == 2


async def test_reconcile_requeues_running_runs(session):
    await _seed(session)
    run = await deck_ai.start_run(session, "zk", "owner", ["explain"], False)
    run.status = "running"
    run.done = 2
    await session.commit()
    jobs: list[tuple] = []

    class Queue:
        async def enqueue_job(self, function, *args, **kwargs):
            jobs.append((function, args, kwargs))

    assert await deck_ai.reconcile(session, Queue()) == 1
    assert run.status == "queued"
    assert jobs == [("run_deck_ai", (run.id,), {"_job_id": f"deck_ai:{run.id}:2"})]


async def test_endpoints_start_poll_and_refuse_a_second_run(client, session, monkeypatch):
    custom = await _seed(session)
    jobs: list[tuple] = []

    class Queue:
        async def enqueue_job(self, function, *args, **kwargs):
            jobs.append((function, args, kwargs))

    async def fake_queue():
        return Queue()

    monkeypatch.setattr("app.routers.wordlists.get_queue", fake_queue)
    r = await client.post("/wordlists/zk/ai-runs", json={"kinds": ["explain", "breakdown"]})
    assert r.status_code == 200, r.text
    run = r.json()
    assert (
        run["status"] == "queued" and run["total"] == 5 and run["kinds"] == ["explain", "breakdown"]
    )
    assert jobs[0][0] == "run_deck_ai" and jobs[0][2] == {"_job_id": f"deck_ai:{run['id']}:0"}

    r = await client.post(f"/wordlists/custom:{custom.id}/ai-runs", json={})
    assert r.status_code == 409 and "中考" in r.json()["detail"]

    latest = (await client.get("/wordlists/zk/ai-runs/latest")).json()["run"]
    assert latest["id"] == run["id"] and latest["cancel_requested"] is False
    assert (await client.get(f"/wordlists/custom:{custom.id}/ai-runs/latest")).json() == {
        "run": None
    }

    r = await client.post(f"/wordlists/zk/ai-runs/{run['id']}/cancel")
    assert r.status_code == 200 and r.json()["status"] == "cancelled"
    assert (await client.post("/wordlists/zk/ai-runs", json={"kinds": []})).status_code == 422
    assert (await client.post("/wordlists/nope/ai-runs", json={})).status_code == 404

    session.expire_all()
    stored = await session.get(DeckAiRun, run["id"])
    assert stored is not None and stored.status == "cancelled"
