import asyncio

import pytest

from app.queue import DatabaseQueue


@pytest.mark.asyncio
async def test_database_queue_recovers_expired_lease_and_fences_old_worker(tmp_path) -> None:
    queue = DatabaseQueue(str(tmp_path / "queue.sqlite3"))
    handle = await queue.enqueue_job("ping", 1, _job_id="same")
    assert handle is not None
    assert await queue.enqueue_job("ping", 1, _job_id="same") is None

    first = await queue.claim(lease_seconds=-1)
    assert first is not None
    second = await queue.claim()
    assert second is not None
    assert second.generation == first.generation + 1
    assert await queue.finish(first, {"stale": True}) is False
    assert await queue.finish(second, {"ok": True}) is True
    rerun = await queue.enqueue_job("ping", 1, _job_id="same")
    assert rerun is not None
    assert rerun.job_id != handle.job_id
    assert await queue.finish(second, {"late": True}) is False


@pytest.mark.asyncio
async def test_database_queue_kv_expiry_and_defer(tmp_path) -> None:
    queue = DatabaseQueue(str(tmp_path / "queue.sqlite3"))
    await queue.set("token", "value", ex=0)
    assert await queue.get("token") is None
    await queue.set("token", "value")
    assert await queue.get("token") == b"value"
    assert await queue.delete("token") == 1

    await queue.enqueue_job("ping", _defer_by=0.02)
    assert await queue.claim() is None
    await asyncio.sleep(0.03)
    assert await queue.claim() is not None
