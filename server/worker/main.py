from arq import cron
from arq.connections import RedisSettings

from app.config import get_settings
from domain.import_dispatch import recover_imports
from domain.practice_packs import recover_packs, run_practice_packs
from domain.tool_execution import worker_functions
from worker import tasks as worker_tasks
from worker.tasks import (
    enrich_video,
    generate_scenario_deck,
    ingest_article,
    ingest_video,
    parse_book,
    poll_subscriptions,
    repair_agent_turn,
    run_deck_ai,
    run_due_routines,
    run_pipeline,
    run_studio_flow,
    scan_flow_triggers,
    tag_assets_job,
    translate_article,
    translate_track,
)

settings = get_settings()


async def ping(ctx: dict) -> str:
    """队列连通性探针任务。"""
    return "pong"


async def reconcile_on_startup(ctx: dict) -> None:
    """启动对账（需求 09 v8 实测教训）：worker 被杀时执行中的 run 会留成永远
    running 的僵尸——把活跃判定、串行重跑脚本全部堵死。启动时统一判中断失败，
    修复会话同理回位（Temporal/Prefect 的 reconcile-on-boot 同款语义）。"""
    from datetime import UTC, datetime

    from arq.connections import ArqRedis
    from sqlalchemy import select, update

    from app.db import SessionFactory
    from app.queue import RedisQueue

    if isinstance(ctx.get("redis"), ArqRedis):
        ctx["redis"] = RedisQueue(ctx["redis"])
    await recover_imports(ctx)
    from domain import deck_ai, image_defaults
    from domain.models import (
        ImageJob,
        PipelineRun,
        PipelineStep,
        RepairSession,
        StudioFlowRun,
        StudioTask,
        Video,
    )
    from domain.pipeline_health import inspect
    from domain.studio_tasks import is_recoverable, transition
    from domain.tool_execution import enqueue_task

    async with SessionFactory() as session:
        # worker 是独立进程：不在这里加载，用户改了全局默认只有 API 生效，
        # worker 仍按出厂默认出图，而且两边都不报错（image_sizes 标定同款坑）
        await image_defaults.load(session)
        await recover_packs(session)
        # 本级 AI 补全是幂等分片，重启后从 cursor 续跑而不是判失败
        await deck_ai.reconcile(session, ctx.get("redis"))

    async with SessionFactory() as session:
        zombie_ids = list(
            (
                await session.execute(select(PipelineRun.id).where(PipelineRun.status == "running"))
            ).scalars()
        )
        if zombie_ids:
            await session.execute(
                update(PipelineRun)
                .where(PipelineRun.id.in_(zombie_ids))
                .values(
                    status="failed", error="worker 重启，执行被中断", finished_at=datetime.now(UTC)
                )
            )
            await session.execute(
                update(PipelineStep)
                .where(PipelineStep.run_id.in_(zombie_ids), PipelineStep.status == "running")
                .values(status="failed", error="worker 重启，执行被中断")
            )
        studio_active = list(
            (
                await session.execute(
                    select(StudioTask).where(
                        StudioTask.status.in_(("submitting", "running", "recovering"))
                    )
                )
            ).scalars()
        )
        recoverable = [task for task in studio_active if is_recoverable(task)]
        interrupted = [task for task in studio_active if task not in recoverable]
        for task in recoverable:
            transition(
                task,
                "recovering",
                stage="startup_recover",
                retryable=True,
            )
            task.finished_at = None
        interrupted_ids = [task.id for task in interrupted]
        if interrupted_ids:
            for task in interrupted:
                transition(
                    task,
                    "failed",
                    stage="startup_reconcile",
                    error="worker 重启，当前 adapter 尚不能恢复该执行；可从任务中心重试",
                    retryable=True,
                )
            await session.execute(
                update(ImageJob)
                .where(
                    ImageJob.studio_task_id.in_(interrupted_ids),
                    ImageJob.status == "running",
                )
                .values(
                    status="failed",
                    error="worker 重启，执行被中断；可从任务中心重试",
                )
            )
        flow_active = list(
            (
                await session.execute(
                    select(StudioFlowRun).where(
                        StudioFlowRun.status.in_(("queued", "running", "recovering"))
                    )
                )
            ).scalars()
        )
        for run in flow_active:
            run.status = "recovering"
            run.error = None
            run.heartbeat_at = datetime.now(UTC)
        await session.execute(
            update(RepairSession)
            .where(RepairSession.status.in_(("working", "confirmed")))
            .values(status="open")
        )
        # 卡在处理中状态的视频按体检结论落位（ready/degraded），不再伪装处理中
        stuck = (
            (
                await session.execute(
                    select(Video).where(
                        Video.status.in_(("downloading", "transcribing", "translating"))
                    )
                )
            )
            .scalars()
            .all()
        )
        await session.commit()
        recovery_failures: list[tuple[str, str]] = []
        queue = ctx.get("redis")
        for task in recoverable:
            try:
                if queue is None:
                    raise RuntimeError("worker Redis 连接不存在")
                await enqueue_task(
                    queue,
                    task,
                    _job_id=f"recover-workflow:{task.id}",
                )
            except Exception as exc:
                recovery_failures.append((task.id, f"{type(exc).__name__}: {exc}"))
        flow_recovery_failures: list[tuple[str, str]] = []
        for run in flow_active:
            try:
                if queue is None:
                    raise RuntimeError("worker Redis 连接不存在")
                await queue.enqueue_job(
                    "run_studio_flow",
                    run.id,
                    _job_id=f"recover-studio-flow:{run.id}",
                )
            except Exception as exc:
                flow_recovery_failures.append((run.id, f"{type(exc).__name__}: {exc}"))
        if recovery_failures:
            for task_id, error in recovery_failures:
                task = await session.get(StudioTask, task_id)
                if task is not None:
                    transition(
                        task,
                        "failed",
                        stage="startup_reconcile",
                        error=f"工作流恢复入队失败：{error}",
                        retryable=True,
                    )
            await session.commit()
        if flow_recovery_failures:
            for run_id, error in flow_recovery_failures:
                run = await session.get(StudioFlowRun, run_id)
                if run is not None:
                    run.error = f"DAG 恢复入队失败：{error}"
            await session.commit()
        for video in stuck:
            report = await inspect(session, video.id)
            video.status = report["gate"] if report["metrics"].get("sentences") else "failed"
        await session.commit()
        if zombie_ids or studio_active or flow_active or stuck:
            print(
                f"启动对账：{len(zombie_ids)} 条僵尸 run、"
                f"{len(recoverable)} 条工作流恢复、"
                f"{len(flow_active)} 条 DAG 恢复、"
                f"{len(interrupted)} 条创作任务判中断，{len(stuck)} 条视频状态落位"
            )


async def shutdown_worker(ctx: dict) -> None:
    """关停收尾：把队列里最后一批模型调用事件写完再退出，别让重启把它们丢了。"""
    import asyncio
    from contextlib import suppress

    from domain import model_invocations

    await model_invocations.flush_invocation_events()
    task = model_invocations.event_writer._task  # 写入器没有公开的 stop，收尾只能碰私有任务
    if task is not None and not task.done():
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task


async def sweep_stale_studio_tasks(ctx: dict) -> dict:
    """租约扫描（每分钟）：心跳停了 10 分钟的任务不再伪装运行中。

    worker 被 kill -9、Redis 抖断、协程卡死都会让心跳停下；能续轮询的重新入队，
    其余判 lease_expired 留给用户重试。启动对账只管 worker 重启那一刻，这里补上
    运行期间的失联。
    """
    from app.db import SessionFactory
    from domain.studio_tasks import sweep_stale_tasks

    async with SessionFactory() as session:
        outcome = await sweep_stale_tasks(session, queue=ctx.get("redis"))
    if outcome["recovered"] or outcome["failed"]:
        print(
            f"租约扫描：{len(outcome['recovered'])} 条重新入队、"
            f"{len(outcome['failed'])} 条判 lease_expired"
        )
    return outcome


class WorkerSettings:
    # 创作工具的 worker 函数由 tool_execution 的 operation 注册表给出，
    # 新接一个能力不用再来这里手动加一行
    functions = [
        recover_imports,
        ping,
        parse_book,
        ingest_article,
        translate_article,
        ingest_video,
        translate_track,
        enrich_video,
        run_pipeline,
        repair_agent_turn,
        poll_subscriptions,
        run_due_routines,
        generate_scenario_deck,
        run_practice_packs,
        run_deck_ai,
        run_studio_flow,
        scan_flow_triggers,
        tag_assets_job,
        *worker_functions(worker_tasks),
    ]
    cron_jobs = [
        cron(recover_imports, second=18, timeout=120),
        cron(run_practice_packs, second=12, timeout=600),
        # 订阅轮询：默认 6 小时一次，只拉列表不下载（BR-16）
        cron(poll_subscriptions, hour={0, 6, 12, 18}, minute=7),
        # 租约扫描：每分钟一次（minute 不限即逐分钟），活跃任务只有几条，秒级完成
        cron(sweep_stale_studio_tasks, second=23, timeout=120),
        # 工作流 cron 触发器：每分钟扫一次到点的规则，判据自带补偿，晚一轮不会漏
        cron(scan_flow_triggers, second=41, timeout=120),
        # 例程滴答（模块 22）：每分钟第 5 秒扫一遍 routine 表，到点的就跑；早报也走这里
        cron(run_due_routines, second=5, timeout=300),
    ]
    on_startup = reconcile_on_startup
    on_shutdown = shutdown_worker
    redis_settings = RedisSettings.from_dsn(settings.redis_url)
    max_jobs = 4
    job_timeout = 3600  # 视频下载+whisper 转写远超书籍解析，放宽到 1h
    # 取消端点把 job 放进 arq 的 abort 集合，worker 轮询到就 cancel 协程并记成 aborted
    allow_abort_jobs = True
