"""例程（模块 20）：早报。

定时把四件事凑成一段能念出来的话：邮件（本地缓存的未读数）、今天的日程（Google 日历，
连不上就跳过这一段并说明）、任务（在跑与失败）、词汇（到期数）。产出存 routine_run，
「今天」页读最新一条，助理页可以现在跑或再念一遍。
文案按口语写：它是要被 TTS 念出来的，不是要看的。
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.owner import OWNER_ID
from domain import gmail
from domain.credentials import CredentialError
from domain.gmail import GmailError
from domain.google_oauth import GoogleAuthError
from domain.models import (
    GoogleAccount,
    MailMessage,
    PipelineRun,
    RoutineRun,
    StudioTask,
    VocabEntry,
)

MORNING_BRIEF = "morning_brief"
ROUTINES = {
    MORNING_BRIEF: {
        "label": "早报",
        "schedule": "每天 07:30",
        "detail": "邮件 · 日程 · 任务 · 到期词",
    },
}

_ACTIVE_TASK = ("queued", "submitting", "running", "recovering")
_ACTIVE_RUN = ("pending", "running")


def _clock(iso: str | None) -> str:
    if not iso or "T" not in iso:
        return "全天"
    try:
        t = datetime.fromisoformat(iso)
    except ValueError:
        return ""
    return f"{t.hour} 点" + (f"{t.minute:02d}" if t.minute else "")


async def compose_morning_brief(
    session: AsyncSession, *, now: datetime | None = None
) -> tuple[str, dict]:
    """返回 (念出来的文本, 结构化数据)。四段各自独立：一段拿不到不影响其它段。"""
    now = now or datetime.now(UTC)
    parts: list[str] = []
    data: dict = {}

    accounts = list(
        (await session.execute(select(GoogleAccount).order_by(GoogleAccount.id))).scalars()
    )
    if accounts:
        unread_rows = (
            await session.execute(
                select(MailMessage.account_id, func.count())
                .where(MailMessage.unread.is_(True))
                .group_by(MailMessage.account_id)
            )
        ).all()
        unread = {aid: int(n) for aid, n in unread_rows}
        total = sum(unread.values())
        by_account = [
            f"{a.email.split('@')[0]} {unread.get(a.id, 0)} 封"
            for a in accounts
            if unread.get(a.id, 0)
        ]
        data["mail"] = {
            "unread": total,
            "accounts": {a.email: unread.get(a.id, 0) for a in accounts},
        }
        if total:
            parts.append(f"邮件有 {total} 封没读，" + "，".join(by_account) + "。")
        else:
            parts.append("邮件没有新的。")

        events: list[dict] = []
        skipped: list[str] = []
        for account in accounts:
            try:
                events.extend(await gmail.calendar_today(session, account, now=now))
            except (GoogleAuthError, GmailError, CredentialError) as exc:
                skipped.append(f"{account.email}：{exc}")
        events.sort(key=lambda e: str(e.get("start") or ""))
        data["calendar"] = {"events": events, "skipped": skipped}
        if events:
            spoken = "，".join(f"{_clock(e.get('start'))}{e['summary']}" for e in events[:4])
            parts.append(f"今天有 {len(events)} 个安排：{spoken}。")
        elif not skipped:
            parts.append("今天没有安排。")
        else:
            parts.append("日历没拿到，账号要重新授权。")
    else:
        data["mail"] = None
        data["calendar"] = None

    running_tasks = await session.scalar(
        select(func.count()).select_from(StudioTask).where(StudioTask.status.in_(_ACTIVE_TASK))
    )
    failed_tasks = await session.scalar(
        select(func.count())
        .select_from(StudioTask)
        .where(
            StudioTask.status.in_(("failed", "partial")),
            StudioTask.created_at >= now - timedelta(days=1),
        )
    )
    running_runs = await session.scalar(
        select(func.count()).select_from(PipelineRun).where(PipelineRun.status.in_(_ACTIVE_RUN))
    )
    running = int(running_tasks or 0) + int(running_runs or 0)
    failed = int(failed_tasks or 0)
    data["tasks"] = {"running": running, "failed_24h": failed}
    if running or failed:
        bits = []
        if running:
            bits.append(f"{running} 个在跑")
        if failed:
            bits.append(f"{failed} 个失败了要看一眼")
        parts.append("任务" + "，".join(bits) + "。")
    else:
        parts.append("任务都空着。")

    due = await session.scalar(
        select(func.count())
        .select_from(VocabEntry)
        .where(VocabEntry.user_id == OWNER_ID, VocabEntry.due_at <= now)
    )
    data["vocab"] = {"due": int(due or 0)}
    parts.append(f"词汇有 {int(due or 0)} 张到期。" if due else "词汇今天没有到期的。")

    return "早上好。" + "".join(parts), data


async def record_run(session: AsyncSession, key: str, text: str, payload: dict) -> RoutineRun:
    row = RoutineRun(key=key, text=text, payload=payload)
    session.add(row)
    return row


async def latest_run(
    session: AsyncSession, key: str, *, today_only: bool = False
) -> RoutineRun | None:
    stmt = (
        select(RoutineRun)
        .where(RoutineRun.key == key)
        .order_by(RoutineRun.created_at.desc(), RoutineRun.id.desc())
    )
    if today_only:
        start = datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
        stmt = stmt.where(RoutineRun.created_at >= start.astimezone(UTC))
    return (await session.execute(stmt.limit(1))).scalar_one_or_none()
