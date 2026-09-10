"""例程（模块 22）：一张表、一个每分钟的滴答。

早报（模块 20）原来是 worker 里一条写死的 arq cron；扩展要能声明自己的例程之后，时间表得
进库：``routine`` 一行一个（key 唯一），worker 每分钟 ``run_due`` 扫一遍，按 cron 算上一次
该触发的时刻是否晚于 ``last_run_at``。两种 kind：``brief``（拼早报）与 ``prompt``（把一句提示
交给助理代理，回复落成一条产出，可念）。产出统一进 ``routine_run``（模块 20 建的表）。

schedule 写法：``HH:MM``（每天）或五段 cron；按系统时区评估（与 arq 一致）。
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from croniter import croniter
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import SessionFactory
from domain import assistant, briefing
from domain.credentials import get_binding
from domain.model_runtime import ModelRuntimeError, prepare_chat_route
from domain.models import Routine, RoutineRun

logger = logging.getLogger(__name__)

KINDS = ("brief", "prompt")
# 首次启动 last_run_at 为空时，只补最近这么久之内错过的一次，别把几天前的都补跑
CATCH_UP = timedelta(minutes=5)


@dataclass(frozen=True)
class RoutineSpec:
    key: str
    label: str
    schedule: str
    kind: str = "prompt"
    prompt: str | None = None
    detail: str | None = None
    speak: bool = True
    source: str = "builtin"


BUILTIN: tuple[RoutineSpec, ...] = (
    RoutineSpec(
        key=briefing.MORNING_BRIEF,
        label="早报",
        schedule="07:30",
        kind="brief",
        detail="邮件 · 日程 · 任务 · 到期词",
    ),
)


@asynccontextmanager
async def detached_session():
    """滴答与例程运行各自开 session；测试的 conftest 接管这个名字到内存库。"""
    async with SessionFactory() as s:
        yield s


class ScheduleError(ValueError):
    pass


def cron_of(schedule: str) -> str:
    """``HH:MM`` → 每天那一刻的 cron；五段 cron 原样校验后返回。"""
    text = schedule.strip()
    if ":" in text and len(text.split()) == 1:
        hh, _, mm = text.partition(":")
        if not (hh.isdigit() and mm.isdigit() and 0 <= int(hh) < 24 and 0 <= int(mm) < 60):
            raise ScheduleError(f"时间写法不对：{schedule}（要 HH:MM）")
        return f"{int(mm)} {int(hh)} * * *"
    if len(text.split()) != 5 or not croniter.is_valid(text):
        raise ScheduleError(f"cron 写法不对：{schedule}（要五段，如 */30 9-18 * * 1-5）")
    return text


def describe(schedule: str) -> str:
    text = schedule.strip()
    if ":" in text and len(text.split()) == 1:
        hh, _, mm = text.partition(":")
        return f"每天 {int(hh):02d}:{int(mm):02d}"
    return f"cron {text}"


def is_due(routine: Routine, now: datetime | None = None) -> bool:
    """上一次该触发的时刻晚于 last_run_at 就到点了；从没跑过的只补 CATCH_UP 之内的。"""
    if not routine.enabled:
        return False
    now = now or datetime.now().astimezone()
    try:
        # get_prev 取的是严格早于基准的那一次：基准加一秒，正好落在整分上的这一次也算
        prev = croniter(cron_of(routine.schedule), now + timedelta(seconds=1)).get_prev(datetime)
    except ScheduleError:
        return False
    if routine.last_run_at is None:
        return now - prev <= CATCH_UP
    last = routine.last_run_at
    if last.tzinfo is None:
        last = last.replace(tzinfo=UTC)
    return prev > last


async def sync(session: AsyncSession, specs: list[RoutineSpec] | tuple[RoutineSpec, ...]) -> None:
    """按 key upsert：标签 / 类型 / 提示词 / 来源跟着声明走，时间表与开关一旦入库就归人管。
    声明里消失的扩展例程标 disabled 而不删（产出还在）。"""
    rows = {r.key: r for r in (await session.execute(select(Routine))).scalars()}
    seen: set[str] = set()
    for spec in specs:
        seen.add(spec.key)
        row = rows.get(spec.key)
        if row is None:
            session.add(
                Routine(
                    key=spec.key,
                    label=spec.label,
                    kind=spec.kind,
                    schedule=spec.schedule,
                    prompt=spec.prompt,
                    detail=spec.detail,
                    speak=spec.speak,
                    source=spec.source,
                )
            )
            continue
        row.label = spec.label
        row.kind = spec.kind
        row.prompt = spec.prompt
        row.detail = spec.detail
        row.source = spec.source
    for key, row in rows.items():
        if key not in seen and row.source != "builtin":
            row.enabled = False
    await session.flush()


async def run_routine(session: AsyncSession, routine: Routine) -> RoutineRun:
    """跑一次并记产出；失败也记（last_status=failed），让页面看得见。"""
    routine.last_run_at = datetime.now(UTC)
    try:
        if routine.kind == "brief":
            text, payload = await briefing.compose_morning_brief(session)
        elif routine.kind == "prompt":
            text = await _run_prompt(routine.prompt or routine.label)
            payload = {"kind": "prompt", "prompt": routine.prompt}
        else:
            raise ScheduleError(f"不认识的例程类型：{routine.kind}")
    except Exception as exc:
        routine.last_status = "failed"
        text = f"{routine.label}没跑成：{type(exc).__name__}: {exc}"[:500]
        run = await briefing.record_run(session, routine.key, text, {"error": True})
        await session.flush()
        logger.warning("routine %s failed: %s", routine.key, exc)
        return run
    routine.last_status = "ok"
    run = await briefing.record_run(session, routine.key, text, {**payload, "speak": routine.speak})
    await session.flush()
    return run


async def _run_prompt(prompt: str) -> str:
    """把提示词交给助理代理（工具全开），回复就是产出。"""
    async with detached_session() as db:
        capability = (
            assistant.DEFAULT_CAPABILITY
            if await get_binding(db, assistant.DEFAULT_CAPABILITY) is not None
            else assistant.FALLBACK_CAPABILITY
        )
    try:
        prepared = await prepare_chat_route(capability, "chat.complete")
    except ModelRuntimeError as exc:
        raise ScheduleError(f"助理没有模型：{exc}") from exc
    deps = assistant.AssistantDeps(session_factory=detached_session, route="/routine")
    reply = await assistant.run_turn(assistant.model_for(capability, prepared), deps, prompt)
    return reply.text


async def run_due(now: datetime | None = None) -> list[str]:
    """worker 每分钟调一次：跑所有到点的例程，返回跑过的 key。"""
    ran: list[str] = []
    async with detached_session() as db:
        rows = list((await db.execute(select(Routine).where(Routine.enabled.is_(True)))).scalars())
        for row in rows:
            if not is_due(row, now):
                continue
            await run_routine(db, row)
            ran.append(row.key)
        await db.commit()
    return ran


__all__ = [
    "BUILTIN",
    "CATCH_UP",
    "KINDS",
    "RoutineSpec",
    "ScheduleError",
    "cron_of",
    "describe",
    "detached_session",
    "is_due",
    "run_due",
    "run_routine",
    "sync",
]
