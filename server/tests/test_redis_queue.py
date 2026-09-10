import asyncio
from unittest.mock import AsyncMock, Mock

import pytest
from arq.constants import in_progress_key_prefix, job_key_prefix

from app.queue import RedisQueue


def redis_stub():
    values = {}
    jobs = set()
    mutex = asyncio.Lock()
    redis = Mock()
    redis.lock.return_value = mutex
    redis.get = AsyncMock(side_effect=lambda key: values.get(key))
    redis.set = AsyncMock(side_effect=lambda key, value: values.update({key: value}))
    redis.exists = AsyncMock(side_effect=lambda *keys: sum(key in jobs for key in keys))

    async def enqueue(_function, *_args, _job_id, **_kwargs):
        jobs.add(job_key_prefix + _job_id)
        return _job_id

    redis.enqueue_job = AsyncMock(side_effect=enqueue)
    return redis, jobs


async def test_only_active_business_key_is_deduplicated():
    redis, jobs = redis_stub()
    queue = RedisQueue(redis)
    first, second = await asyncio.gather(
        queue.enqueue_job("translate", 1, _job_id="article:1"),
        queue.enqueue_job("translate", 1, _job_id="article:1"),
    )
    assert first is not None and second is None
    jobs.remove(job_key_prefix + first)
    jobs.add(in_progress_key_prefix + first)
    assert await queue.enqueue_job("translate", 1, _job_id="article:1") is None
    jobs.clear()
    rerun = await queue.enqueue_job("translate", 1, _job_id="article:1")
    assert rerun is not None and rerun != first
    assert redis.enqueue_job.await_count == 2


async def test_uncertain_enqueue_keeps_active_execution_pointer():
    redis, jobs = redis_stub()
    enqueue = redis.enqueue_job.side_effect

    async def lost_response(*args, **kwargs):
        await enqueue(*args, **kwargs)
        raise ConnectionError("response lost")

    redis.enqueue_job.side_effect = lost_response
    queue = RedisQueue(redis)
    with pytest.raises(ConnectionError, match="response lost"):
        await queue.enqueue_job("ingest", 1, _job_id="article:1", _execution_id="intent-1")
    assert job_key_prefix + "intent-1" in jobs
    assert (
        await queue.enqueue_job("ingest", 1, _job_id="article:1", _execution_id="intent-1") is None
    )
    assert redis.enqueue_job.await_count == 1
