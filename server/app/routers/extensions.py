"""扩展与例程 API（CR-007 模块 22）。

扩展：清单来自代码（内置）与 ``data/extensions/*/manifest.yaml``（本地），状态在
``extension_state``；每次列表都现扫目录，「重新扫描」只是让前端刷新。例程：``routine`` 表，
列表时先按当前就绪的扩展同步一次声明（新增补行、消失的标 disabled）。
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.routers.dict import SessionDep
from domain import briefing, extensions, routines
from domain.models import Routine, RoutineRun

router = APIRouter(prefix="/extensions", tags=["extensions"])
routines_router = APIRouter(prefix="/routines", tags=["routines"])


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


@router.get("")
async def list_extensions(session: SessionDep) -> dict:
    infos = await extensions.catalog(session)
    await routines.sync(session, extensions.routine_specs(infos))
    await session.commit()
    return {
        "items": [i.view() for i in infos],
        "points": [{"key": k, "label": v} for k, v in extensions.CONTRIBUTION_POINTS],
        "permissions": [{"key": k, "label": v} for k, v in extensions.PERMISSIONS.items()],
        "dir": str(extensions.EXT_DIR),
    }


@router.post("/rescan")
async def rescan(session: SessionDep) -> dict:
    return await list_extensions(session)


class StateBody(BaseModel):
    enabled: bool | None = None
    granted: list[str] | None = None


@router.patch("/{ext_id}")
async def patch_extension(ext_id: str, body: StateBody, session: SessionDep) -> dict:
    infos = {i.manifest.id: i for i in await extensions.catalog(session)}
    if ext_id not in infos:
        raise HTTPException(status_code=404, detail="没有这个扩展")
    if infos[ext_id].source == "builtin" and body.granted is not None:
        raise HTTPException(status_code=400, detail="内置模块的权限不用授")
    try:
        await extensions.set_state(session, ext_id, enabled=body.enabled, granted=body.granted)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    refreshed = {i.manifest.id: i for i in await extensions.catalog(session)}
    await routines.sync(session, extensions.routine_specs(list(refreshed.values())))
    await session.commit()
    return refreshed[ext_id].view()


@router.post("/{ext_id}/test")
async def test_extension(ext_id: str, session: SessionDep) -> dict:
    infos = {i.manifest.id: i for i in await extensions.catalog(session)}
    info = infos.get(ext_id)
    if info is None:
        raise HTTPException(status_code=404, detail="没有这个扩展")
    if info.manifest.mcp is None:
        return {"ok": True, "note": "这个扩展没有 MCP 服务器，没什么可连的"}
    if info.status != "ready":
        return {"ok": False, "error": f"扩展未就绪：{info.status}"}
    return await extensions.probe_mcp(info)


# ---- 例程 ----


def _routine_view(row: Routine, last: RoutineRun | None) -> dict:
    return {
        "key": row.key,
        "label": row.label,
        "kind": row.kind,
        "schedule": row.schedule,
        "schedule_label": routines.describe(row.schedule),
        "prompt": row.prompt,
        "detail": row.detail,
        "speak": row.speak,
        "enabled": row.enabled,
        "source": row.source,
        "last_run_at": _iso(row.last_run_at),
        "last_status": row.last_status,
        "last": (
            {"text": last.text, "at": _iso(last.created_at), "payload": last.payload}
            if last
            else None
        ),
    }


async def _routine_rows(session) -> list[dict]:
    infos = await extensions.catalog(session)
    await routines.sync(session, extensions.routine_specs(infos))
    await session.commit()
    rows = list((await session.execute(select(Routine).order_by(Routine.id))).scalars())
    out = []
    for row in rows:
        out.append(_routine_view(row, await briefing.latest_run(session, row.key)))
    return out


@routines_router.get("")
async def list_routines(session: SessionDep) -> list[dict]:
    return await _routine_rows(session)


class RoutineBody(BaseModel):
    enabled: bool | None = None
    schedule: str | None = Field(default=None, max_length=64)
    speak: bool | None = None


async def _routine(session, key: str) -> Routine:
    """按 key 取一行；还没同步过（比如 worker 没跑过、页面没打开过）就先同步一次再找。"""
    row = (await session.execute(select(Routine).where(Routine.key == key))).scalar_one_or_none()
    if row is None:
        infos = await extensions.catalog(session)
        await routines.sync(session, extensions.routine_specs(infos))
        await session.commit()
        row = (
            await session.execute(select(Routine).where(Routine.key == key))
        ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="没有这个例程")
    return row


@routines_router.patch("/{key}")
async def patch_routine(key: str, body: RoutineBody, session: SessionDep) -> dict:
    row = await _routine(session, key)
    if body.schedule is not None:
        try:
            routines.cron_of(body.schedule)
        except routines.ScheduleError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        row.schedule = body.schedule.strip()
    if body.enabled is not None:
        row.enabled = body.enabled
    if body.speak is not None:
        row.speak = body.speak
    await session.commit()
    return _routine_view(row, await briefing.latest_run(session, row.key))


@routines_router.post("/{key}/run")
async def run_routine_now(key: str, session: SessionDep) -> dict:
    row = await _routine(session, key)
    await routines.run_routine(session, row)
    await session.commit()
    return _routine_view(row, await briefing.latest_run(session, row.key))


@routines_router.get("/{key}/runs")
async def routine_runs(key: str, session: SessionDep, limit: int = 20) -> list[dict]:
    rows = (
        await session.execute(
            select(RoutineRun)
            .where(RoutineRun.key == key)
            .order_by(RoutineRun.created_at.desc(), RoutineRun.id.desc())
            .limit(max(1, min(limit, 100)))
        )
    ).scalars()
    return [
        {"id": r.id, "text": r.text, "at": _iso(r.created_at), "payload": r.payload} for r in rows
    ]
