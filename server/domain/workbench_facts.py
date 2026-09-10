from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import UTC, datetime

from sqlalchemy import func, or_, select

from app.db import SessionFactory
from app.owner import OWNER_ID
from domain import gmail
from domain.credentials import CredentialError
from domain.gmail import GmailError
from domain.google_oauth import GoogleAuthError
from domain.models import GoogleAccount, MailMessage, PipelineRun, StudioTask, VocabEntry

RUNNING_TASK_STATUSES = ("queued", "submitting", "running", "recovering")
RUNNING_RUN_STATUSES = ("pending", "running")
MAIL_ERRORS = (GoogleAuthError, GmailError, CredentialError)


@asynccontextmanager
async def detached_session():
    async with SessionFactory() as session:
        yield session


async def current_time() -> dict:
    now = datetime.now().astimezone()
    weekday = "一二三四五六日"[now.weekday()]
    return {
        "date": now.strftime("%Y-%m-%d"),
        "time": now.strftime("%H:%M"),
        "weekday": f"星期{weekday}",
        "timezone": now.tzname(),
        "spoken": f"{now.month} 月 {now.day} 日星期{weekday}，{now.hour} 点 {now.minute:02d} 分",
    }


async def review_status() -> dict:
    async with detached_session() as session:
        due = await session.scalar(
            select(func.count())
            .select_from(VocabEntry)
            .where(VocabEntry.user_id == OWNER_ID, VocabEntry.due_at <= datetime.now(UTC))
        )
    return {"due": int(due or 0)}


async def running_tasks() -> dict:
    async with detached_session() as session:
        tasks = await session.scalar(
            select(func.count())
            .select_from(StudioTask)
            .where(StudioTask.status.in_(RUNNING_TASK_STATUSES))
        )
        runs = await session.scalar(
            select(func.count())
            .select_from(PipelineRun)
            .where(PipelineRun.status.in_(RUNNING_RUN_STATUSES))
        )
        failed = await session.scalar(
            select(func.count())
            .select_from(StudioTask)
            .where(or_(StudioTask.status == "failed", StudioTask.status == "partial"))
        )
    return {"running": int(tasks or 0) + int(runs or 0), "failed": int(failed or 0)}


async def inbox_summary() -> dict:
    async with detached_session() as session:
        accounts = list((await session.execute(select(GoogleAccount))).scalars())
        if not accounts:
            return {"connected": False, "message": "还没有连接 Google 账号"}
        names = {account.id: account.email for account in accounts}
        unread = dict(
            (
                await session.execute(
                    select(MailMessage.account_id, func.count())
                    .where(MailMessage.unread.is_(True))
                    .group_by(MailMessage.account_id)
                )
            ).all()
        )
        latest = (
            await session.execute(
                select(MailMessage)
                .order_by(MailMessage.sent_at.desc().nullslast(), MailMessage.id.desc())
                .limit(5)
            )
        ).scalars()
        recent = [
            {
                "message_id": message.id,
                "account": names.get(message.account_id),
                "from": message.from_name or message.from_addr,
                "subject": message.subject,
                "unread": message.unread,
            }
            for message in latest
        ]
    return {
        "connected": True,
        "unread": {names[account_id]: int(count) for account_id, count in unread.items()},
        "recent": recent,
    }


async def calendar_today() -> dict:
    events: list[dict] = []
    errors: list[str] = []
    async with detached_session() as session:
        accounts = list((await session.execute(select(GoogleAccount))).scalars())
        if not accounts:
            return {"connected": False, "message": "还没有连接 Google 账号"}
        for account in accounts:
            try:
                events.extend(await gmail.calendar_today(session, account))
            except MAIL_ERRORS as exc:
                errors.append(f"{account.email}：{exc}")
        await session.commit()
    events.sort(key=lambda event: str(event.get("start") or ""))
    return {"connected": True, "events": events, "errors": errors}
