"""内容入库与派发意图共用事务，派发失败由轮询补偿。"""

import logging
from uuid import uuid4

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.queue import QueuePort, get_queue
from domain.models import Article, Book, ImportDispatch

logger = logging.getLogger(__name__)


async def record_import(session: AsyncSession, function: str, subject_id: int) -> ImportDispatch:
    pending = await session.scalar(
        select(ImportDispatch).where(
            ImportDispatch.function == function,
            ImportDispatch.subject_id == subject_id,
            ImportDispatch.status == "pending",
        )
    )
    if pending is not None:
        return pending
    intent = ImportDispatch(id=str(uuid4()), function=function, subject_id=subject_id)
    session.add(intent)
    await session.flush()
    return intent


async def dispatch_pending(session: AsyncSession, queue: QueuePort) -> dict:
    rows = (
        await session.scalars(
            select(ImportDispatch)
            .where(ImportDispatch.status == "pending")
            .order_by(ImportDispatch.created_at)
            .limit(100)
        )
    ).all()
    dispatched = failed = 0
    for intent in rows:
        claimed = await session.execute(
            update(ImportDispatch)
            .where(ImportDispatch.id == intent.id, ImportDispatch.status == "pending")
            .values(status="dispatching", attempts=ImportDispatch.attempts + 1)
        )
        if claimed.rowcount != 1:
            continue
        try:
            await queue.enqueue_job(
                intent.function,
                intent.subject_id,
                _job_id=f"{intent.function}:{intent.subject_id}",
                _execution_id=intent.id,
            )
        except Exception as error:
            intent.status = "pending"
            intent.error = str(error)[:1000]
            failed += 1
            logger.warning("导入任务派发失败：%s", intent.id)
        else:
            intent.status = "dispatched"
            intent.error = None
            dispatched += 1
        await session.commit()
    return {"dispatched": dispatched, "failed": failed}


async def recover_imports(ctx: dict) -> dict:
    from app.db import SessionFactory

    async with SessionFactory() as session:
        for model, function in [(Article, "ingest_article"), (Book, "parse_book")]:
            known = (
                select(ImportDispatch.id)
                .where(ImportDispatch.function == function, ImportDispatch.subject_id == model.id)
                .exists()
            )
            statement = select(model.id).where(model.status == "pending", ~known).limit(100)
            if model is Article:
                statement = statement.where(Article.book_id.is_(None))
            for subject_id in (await session.scalars(statement)).all():
                await record_import(session, function, subject_id)
        await session.commit()
        return await dispatch_pending(session, ctx["redis"])


async def try_dispatch(session: AsyncSession) -> None:
    try:
        queue = await get_queue()
    except Exception:
        logger.warning("导入队列暂不可用，派发意图保留等待恢复")
        return
    await dispatch_pending(session, queue)
