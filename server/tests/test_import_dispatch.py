from unittest.mock import AsyncMock

from sqlalchemy import select

from app.queue import DatabaseQueue
from domain.import_dispatch import dispatch_pending, record_import
from domain.models import Article, ImportDispatch


async def test_failed_dispatch_preserves_intent_and_retries_same_execution(session, tmp_path):
    article = Article(
        ordinal=0,
        title="retained",
        source_kind="url",
        source_url="https://example.com",
        status="pending",
    )
    session.add(article)
    await session.flush()
    intent = await record_import(session, "ingest_article", article.id)
    await session.commit()
    broken = AsyncMock()
    broken.enqueue_job.side_effect = RuntimeError("offline")
    assert (await dispatch_pending(session, broken))["failed"] == 1
    assert intent.status == "pending"
    queue = DatabaseQueue(str(tmp_path / "queue.sqlite3"))
    assert (await dispatch_pending(session, queue))["dispatched"] == 1
    job = await queue.claim()
    assert job.job_id == intent.id
    await queue.finish(job, None)
    intent.status = "pending"
    await session.commit()
    assert (await dispatch_pending(session, queue))["dispatched"] == 1
    assert await queue.claim() is None
    assert len((await session.scalars(select(ImportDispatch))).all()) == 1
