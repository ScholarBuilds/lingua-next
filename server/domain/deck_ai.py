"""本级 AI 补全（FR-502）：把本内每个词的「AI 语境释义」与「拆开记」跑完，落 analysis_result。

词卡命中条件必须一字不差地复现（否则跑出来的东西词卡永远看不到）：
- 释义：scope="word"，content_hash=content_key(词.lower())（openWord 已小写），
  context_hash=content_key(例句 or f"{本名}：{词}")（全角冒号，见 DeckDetail.tsx contextOf），
  kind="word_explain"；例句来源与 wordlists._item_row 同一口径（decks.deck_word_contexts）。
- 拆开记：按 lemma 寻址（WordCard 传的是 lemma ?? surface，decks.lemma_of 复刻同一算法），
  context_hash=""，kind="word_breakdown"，音标取 lemma 的 DictEntry（与 analyze.py 一致）。

分片续跑：desktop 档队列租约 3600 秒到期会把作业重派给另一条 loop，arq 到点直接取消；
每次作业处理至多 SLICE_WORDS 个词，连续完成的前缀即时写回 cursor。
job_id 带 cursor，避免同名作业被 INSERT OR IGNORE 吞掉。取消后停止补位，
在飞的调用自然返回并落库，再结束任务。
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime

from sqlalchemy import select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from domain import decks, tts_preload
from domain.analysis import content_key, save_result
from domain.llm import LLMUnavailable, complete_json, word_breakdown_prompt, word_explain_prompt
from domain.model_invocations import invocation_context
from domain.models import AnalysisResult, DeckAiRun, DictEntry

KINDS = ("explain", "breakdown", "tts")
ACTIVE_STATUSES = ("queued", "running")
CONCURRENCY = get_settings().deck_ai_concurrency
SLICE_WORDS = max(80, CONCURRENCY * 8)
# 连续这么多次「模型不可用」且本片一次都没成功 → 绑定缺失或上游全挂，别空转
BREAKER = 5
CAPABILITY = "explain-standard"
PROVIDER = f"llm:{CAPABILITY}"
_gate = asyncio.Semaphore(CONCURRENCY)
# 队列重派的同一本作业不能与原作业同时推进游标。
_run_lock = asyncio.Lock()


class RunBusy(Exception):
    """同时只跑一本：另一本还在 queued / running。"""

    def __init__(self, run: DeckAiRun) -> None:
        super().__init__(run.deck_key)
        self.run = run


@asynccontextmanager
async def detached_session() -> AsyncIterator[AsyncSession]:
    from app.db import SessionFactory

    async with SessionFactory() as session:
        yield session


def context_of(deck_name: str, word: str, example_en: str | None) -> str:
    # 与 web/src/features/vocab/DeckDetail.tsx 的 contextOf 同一串（全角冒号 U+FF1A）
    return example_en or f"{deck_name}：{word}"


def job_id(run_id: int, cursor: int) -> str:
    return f"deck_ai:{run_id}:{cursor}"


def explain_address(word: str, context: str) -> dict:
    return {
        "scope": "word",
        "content_hash": content_key(word.lower()),
        "context_hash": content_key(context),
        "kind": "word_explain",
        "provider": PROVIDER,
    }


def breakdown_address(lemma: str) -> dict:
    return {
        "scope": "word",
        "content_hash": content_key(lemma.lower()),
        "context_hash": "",
        "kind": "word_breakdown",
        "provider": PROVIDER,
    }


def run_public(run: DeckAiRun) -> dict:
    return {
        "id": run.id,
        "deck_key": run.deck_key,
        "kinds": list(run.kinds or []),
        "refresh": run.refresh,
        "status": run.status,
        "total": run.total,
        "done": run.done,
        "cached": run.cached,
        "generated": run.generated,
        "failed": run.failed,
        "current_word": run.current_word,
        "error": run.error,
        "cancel_requested": run.cancel_requested_at is not None,
        "created_at": run.created_at.isoformat() if run.created_at else None,
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "finished_at": run.finished_at.isoformat() if run.finished_at else None,
    }


async def active_run(session: AsyncSession) -> DeckAiRun | None:
    stmt = (
        select(DeckAiRun)
        .where(DeckAiRun.status.in_(ACTIVE_STATUSES))
        .order_by(DeckAiRun.id.desc())
        .limit(1)
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def latest_run(session: AsyncSession, key: str) -> DeckAiRun | None:
    stmt = select(DeckAiRun).where(DeckAiRun.deck_key == key).order_by(DeckAiRun.id.desc()).limit(1)
    return (await session.execute(stmt)).scalar_one_or_none()


async def start_run(
    session: AsyncSession, key: str, user_id: str, kinds: list[str], refresh: bool
) -> DeckAiRun:
    """建 queued 行并 flush，不 commit、不入队；本不存在抛 UnknownDeck，有活抛 RunBusy。"""
    chosen = [k for k in KINDS if k in kinds]
    if not chosen:
        raise ValueError("kinds 至少选一项：explain / breakdown")
    busy = await active_run(session)
    if busy is not None:
        raise RunBusy(busy)
    total = len(await decks.deck_word_contexts(session, key, user_id))
    run = DeckAiRun(
        user_id=user_id, deck_key=key, kinds=chosen, refresh=refresh, total=total, status="queued"
    )
    session.add(run)
    await session.flush()
    return run


async def request_cancel(session: AsyncSession, run: DeckAiRun) -> None:
    if run.status in ACTIVE_STATUSES and run.cancel_requested_at is None:
        run.cancel_requested_at = datetime.now(UTC)
    # 还没被认领的作业不用等分片边界
    if run.status == "queued":
        _finish(run, "cancelled")


async def enqueue(queue, run: DeckAiRun) -> None:
    await queue.enqueue_job("run_deck_ai", run.id, _job_id=job_id(run.id, run.cursor))


async def reconcile(session: AsyncSession, queue) -> int:
    """worker 重启：running 的回 queued 并从 cursor 重新入队。任务幂等（命中即跳过），
    判 interrupted 只是在浪费用户一次点击。"""
    rows = list(
        (await session.execute(select(DeckAiRun).where(DeckAiRun.status == "running"))).scalars()
    )
    for run in rows:
        run.cursor = max(run.cursor, run.done)
        run.status = "queued"
        run.current_word = None
    await session.commit()
    if queue is not None:
        for run in rows:
            await enqueue(queue, run)
    return len(rows)


def _finish(run: DeckAiRun, status: str, error: str | None = None) -> None:
    run.status = status
    run.error = error
    run.current_word = None
    run.finished_at = datetime.now(UTC)


async def _call(kind: str, system: str, user: str, deck_key: str) -> tuple[dict, str, int]:
    async with _gate:
        with invocation_context(source="vocab.deck_ai", deck=deck_key, kind=kind):
            return await complete_json(CAPABILITY, system, user)


async def _cached_addresses(
    session: AsyncSession, addresses: list[tuple[str, str, str]]
) -> set[tuple[str, str, str]]:
    found: set[tuple[str, str, str]] = set()
    unique = list(dict.fromkeys(addresses))
    for start in range(0, len(unique), 128):
        # 三列寻址分块限制绑定参数数量，不读取分析正文。
        rows = await session.execute(
            select(
                AnalysisResult.content_hash, AnalysisResult.context_hash, AnalysisResult.kind
            ).where(
                AnalysisResult.scope == "word",
                AnalysisResult.provider == PROVIDER,
                AnalysisResult.lang_pair == "en->zh",
                AnalysisResult.is_active.is_(True),
                tuple_(
                    AnalysisResult.content_hash, AnalysisResult.context_hash, AnalysisResult.kind
                ).in_(unique[start : start + 128]),
            )
        )
        found.update(tuple(row) for row in rows)
    return found


async def run_slice(run_id: int, *, session_factory=None) -> tuple[str, int]:
    """处理一片，返回 ("continue" | "done" | "failed" | "cancelled" | "stop", cursor)。"""
    factory = session_factory or detached_session
    async with _run_lock, factory() as session:
        run = await session.get(DeckAiRun, run_id)
        if run is None:
            return "stop", 0
        if run.status not in ACTIVE_STATUSES:
            return "stop", run.cursor
        if run.cancel_requested_at is not None:
            _finish(run, "cancelled")
            await session.commit()
            return "cancelled", run.cursor
        run.status = "running"
        run.started_at = run.started_at or datetime.now(UTC)
        await session.commit()

        try:
            deck_name = await decks.deck_name(session, run.deck_key)
            pairs = await decks.deck_word_contexts(session, run.deck_key, run.user_id)
        except decks.UnknownDeck:
            _finish(run, "failed", "单词本不存在了")
            await session.commit()
            return "failed", run.cursor
        run.total = len(pairs)
        window = pairs[run.cursor : run.cursor + SLICE_WORDS]
        entries: dict[str, DictEntry] = {}
        if window:
            names = {w for w, _ in window}
            stmt = select(DictEntry).where(DictEntry.word.in_(names))
            entries = {e.word: e for e in (await session.execute(stmt)).scalars()}
        kinds = list(run.kinds or [])
        if "breakdown" in kinds:
            lemmas = {
                lemma
                for entry in entries.values()
                if (lemma := decks.lemma_of(entry.exchange, entry.word)) and lemma not in entries
            }
            if lemmas:
                rows = await session.execute(select(DictEntry).where(DictEntry.word.in_(lemmas)))
                entries.update((entry.word, entry) for entry in rows.scalars())
        word_plans = []
        for word, example in window:
            plans = []
            entry = entries.get(word)
            if "explain" in kinds:
                context = context_of(deck_name, word, example)
                plans.append(
                    ("explain", explain_address(word, context), word_explain_prompt(word, context))
                )
            if "breakdown" in kinds:
                lemma = decks.lemma_of(entry.exchange if entry else None, word) or word
                target = entries.get(lemma)
                phonetic = target.phonetic if target is not None else None
                plans.append(
                    (
                        "breakdown",
                        breakdown_address(lemma),
                        word_breakdown_prompt(lemma.lower(), phonetic),
                    )
                )
            word_plans.append(plans)
        hits = (
            set()
            if run.refresh
            else await _cached_addresses(
                session,
                [
                    (addr["content_hash"], addr["context_hash"], addr["kind"])
                    for plans in word_plans
                    for _, addr, _ in plans
                ],
            )
        )
        prepared = []
        for plans in word_plans:
            missing = [
                plan
                for plan in plans
                if (plan[1]["content_hash"], plan[1]["context_hash"], plan[1]["kind"]) not in hits
            ]
            prepared.append((missing, len(plans) - len(missing)))
        # 缓存查询会触发 autoflush；模型台账使用独立连接，等待网络前必须释放写事务。
        await session.commit()

        deck_key = run.deck_key

        async def complete_word(index):
            plans, cached = prepared[index]
            outcomes = await asyncio.gather(
                *(_call(kind, system, user, deck_key) for kind, _, (system, user) in plans),
                return_exceptions=True,
            )
            audio = None
            if "tts" in kinds:
                word, example = window[index]
                audio = await asyncio.gather(
                    tts_preload.preload(word, "word", factory),
                    *([tts_preload.preload(example, "sentence", factory)] if example else []),
                    return_exceptions=True,
                )
            return index, plans, cached, outcomes, audio

        next_index = 0
        checkpoint = 0
        base_cursor = run.cursor
        completed = {}
        pending = set()
        breaker = 0
        slice_generated = 0
        stopping = None
        try:
            while next_index < len(window) or pending:
                await session.refresh(run)
                if run.cancel_requested_at is not None:
                    stopping = "cancelled"
                # refresh 也会开启事务，不能跨模型请求持有连接和事务。
                await session.commit()
                while stopping is None and next_index < len(window) and len(pending) < CONCURRENCY:
                    pending.add(asyncio.create_task(complete_word(next_index)))
                    next_index += 1
                if not pending:
                    break
                ready, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
                for task in ready:
                    index, plans, cached, outcomes, audio = task.result()
                    generated = failed = 0
                    if audio is not None:
                        if any(isinstance(item, BaseException) for item in audio):
                            failed += 1
                        elif all(audio):
                            cached += 1
                        else:
                            generated += 1
                    for (_, addr, _), outcome in zip(plans, outcomes, strict=True):
                        if isinstance(outcome, BaseException):
                            failed += 1
                            breaker = breaker + 1 if isinstance(outcome, LLMUnavailable) else 0
                            continue
                        result, model, latency_ms = outcome
                        await save_result(
                            session, **addr, result=result, model=model, latency_ms=latency_ms
                        )
                        generated += 1
                        slice_generated += 1
                        breaker = 0
                    # 缓存并发冲突的回滚会过期会话中的 ORM 对象。
                    await session.refresh(run)
                    completed[index] = (cached, generated, failed)
                    # 仅提交连续完成的前缀，重启不会跳过慢请求或重复累加进度。
                    while checkpoint in completed:
                        hits, created, errors = completed.pop(checkpoint)
                        run.cached += hits
                        run.generated += created
                        run.failed += errors
                        checkpoint += 1
                    run.cursor = base_cursor + checkpoint
                    run.done = run.cursor
                    run.current_word = window[index][0]
                    await session.commit()
                if breaker >= BREAKER and slice_generated == 0:
                    stopping = stopping or "failed"
            await session.refresh(run)
            if run.cancel_requested_at is not None:
                stopping = "cancelled"
            if stopping is not None:
                _finish(
                    run,
                    stopping,
                    "模型连续不可用：检查「词语解释」能力的绑定" if stopping == "failed" else None,
                )
                await session.commit()
                return stopping, run.cursor
        finally:
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)

        if run.cursor >= run.total:
            _finish(run, "done")
            await session.commit()
            return "done", run.cursor
        await session.commit()
        return "continue", run.cursor
