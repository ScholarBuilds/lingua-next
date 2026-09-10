from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from contextlib import suppress
from typing import Any, cast

from app.queue import DatabaseQueue, get_queue

logger = logging.getLogger(__name__)
_task: asyncio.Task[None] | None = None


WorkerFunction = Callable[..., Awaitable[Any]]


def _functions() -> dict[str, WorkerFunction]:
    from worker.main import WorkerSettings, sweep_stale_studio_tasks

    functions = {
        function.__name__: cast(WorkerFunction, function)
        for function in WorkerSettings.functions
    }
    functions[sweep_stale_studio_tasks.__name__] = sweep_stale_studio_tasks
    return functions


async def _schedule_recurring(queue: DatabaseQueue) -> None:
    last_minute = -1
    while True:
        now = int(time.time())
        minute = now // 60
        if minute != last_minute:
            last_minute = minute
            for function in (
                "run_due_routines", "scan_flow_triggers", "sweep_stale_studio_tasks",
                "run_practice_packs", "recover_imports",
            ):
                await queue.enqueue_job(function, _job_id=f"cron:{function}:{minute}")
            if minute % 360 == 0:
                await queue.enqueue_job(
                    "poll_subscriptions", _job_id=f"cron:poll_subscriptions:{minute}"
                )
        await asyncio.sleep(1)


async def _work_loop(
    queue: DatabaseQueue,
    functions: dict[str, WorkerFunction],
    ctx: dict[str, DatabaseQueue],
) -> None:
    while True:
        job = await queue.claim(lease_seconds=3600)
        if job is None:
            await asyncio.sleep(0.25)
            continue
        function = functions.get(job.function)
        if function is None:
            await queue.fail(job, f"未知任务函数：{job.function}", retry=False)
            continue
        try:
            result = await function(ctx, *job.args)
        except asyncio.CancelledError:
            await queue.fail(job, "本地运行时退出，等待恢复", retry=True)
            raise
        except Exception as exc:
            retry = job.attempt < 3
            await queue.fail(job, f"{type(exc).__name__}: {exc}", retry=retry)
            logger.exception("本地任务 %s 执行失败", job.job_id)
        else:
            await queue.finish(job, result)


async def run_local_worker() -> None:
    queue = await get_queue()
    if not isinstance(queue, DatabaseQueue):
        return
    functions = _functions()
    from worker.main import reconcile_on_startup, shutdown_worker

    ctx = {"redis": queue}
    await reconcile_on_startup(ctx)
    try:
        async with asyncio.TaskGroup() as group:
            group.create_task(_schedule_recurring(queue))
            for _ in range(4):
                group.create_task(_work_loop(queue, functions, ctx))
    finally:
        await shutdown_worker(ctx)


async def start_local_worker() -> None:
    global _task
    if _task is None or _task.done():
        _task = asyncio.create_task(run_local_worker(), name="nexus-local-worker")


async def stop_local_worker() -> None:
    global _task
    task, _task = _task, None
    if task is None:
        return
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task
