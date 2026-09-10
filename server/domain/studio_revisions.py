"""提示词与工作流共用的版本链（模块 17 ST-14 / ST-15）。

两块业务的版本需求是同一个形状：改之前留一份快照、列出历史、回滚到某一版。
所以写一份，两边按 `entity_type` 复用，而不是各写一套几乎相同的 CRUD。

三条约定：

- **版本号只增不减**。回滚不是把版本号退回去，而是把旧内容重新提交成新的一版，
  备注写清回滚自哪一版。退版本号会让「导出物写的 version」与历史链上的同号版本
  指向两份不同的内容，之后任何按版本号对账的动作都对不上。
- **快照存整包**，不存 diff。提示词正文几 KB、工作流节点图几十 KB，存 diff 要额外
  维护一条重放链，任何一环坏掉整段历史就废了；整包是自证的。
- **不无限存**（保留策略见 `KEEP_RECENT`）。
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from domain.models import StudioRevision

ENTITY_PROMPT = "prompt"
ENTITY_WORKFLOW = "workflow"
ENTITY_TYPES = frozenset({ENTITY_PROMPT, ENTITY_WORKFLOW})

MAX_NOTE = 200

# 每个实体保留的未标记版本数。20 版覆盖「连着调一下午」的全部回退需求；
# 再往前的版本用户既想不起来内容也认不出备注，留着只是让表按编辑次数线性膨胀。
# 要长期留的那几版让用户按「保留」显式标记，标记过的不参与裁剪。
KEEP_RECENT = 20


class StudioRevisionError(Exception):
    """版本操作不合法。`status` 由路由层原样映射为 HTTP 状态码。"""

    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def clean_note(note: str | None) -> str:
    return (note or "").strip()[:MAX_NOTE]


def revision_view(row: StudioRevision) -> dict:
    return {
        "version": row.version,
        "note": row.note or "",
        "pinned": row.pinned,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "snapshot": row.snapshot or {},
    }


async def next_version(session: AsyncSession, entity_type: str, entity_id: int) -> int:
    """下一个可用版本号。取历史链的最大值 + 1，与实体行上的 version 各算各的，
    这样即使实体行的 version 因为迁移填充落后，也不会撞唯一约束。"""
    current = (
        await session.execute(
            select(func.max(StudioRevision.version)).where(
                StudioRevision.entity_type == entity_type,
                StudioRevision.entity_id == entity_id,
            )
        )
    ).scalar()
    return int(current or 0) + 1


async def record(
    session: AsyncSession,
    entity_type: str,
    entity_id: int,
    *,
    snapshot: dict[str, Any],
    note: str | None = None,
    version: int | None = None,
    pinned: bool = False,
) -> int:
    """追加一版并按保留策略裁剪，返回落库的版本号。

    不提交事务：调用方通常还要改实体行本身，两件事必须同进同出。
    """
    if entity_type not in ENTITY_TYPES:
        raise StudioRevisionError(f"未知的版本实体类型：{entity_type}")
    number = version if version is not None else await next_version(session, entity_type, entity_id)
    session.add(
        StudioRevision(
            entity_type=entity_type,
            entity_id=entity_id,
            version=number,
            snapshot=snapshot,
            note=clean_note(note),
            pinned=pinned,
        )
    )
    await session.flush()
    await prune(session, entity_type, entity_id)
    return number


async def ensure_baseline(
    session: AsyncSession,
    entity_type: str,
    entity_id: int,
    *,
    snapshot: dict[str, Any],
    note: str,
) -> bool:
    """链是空的就把这一份补成第 1 版，返回有没有补。

    不是所有实体都从本模块管的入口建出来的（RunningHub 目录同步、迁移之前建的行
    都不经过），它们第一次被编辑时如果只记「改之后」，改之前那一份就永远回不去了
    ——而那一份恰恰是用户最想回滚到的。
    """
    exists = (
        await session.execute(
            select(StudioRevision.id)
            .where(
                StudioRevision.entity_type == entity_type,
                StudioRevision.entity_id == entity_id,
            )
            .limit(1)
        )
    ).scalar()
    if exists is not None:
        return False
    await record(session, entity_type, entity_id, snapshot=snapshot, note=note, version=1)
    return True


async def prune(session: AsyncSession, entity_type: str, entity_id: int) -> int:
    """裁掉超出保留窗口的未标记版本，返回删除条数。"""
    versions = (
        (
            await session.execute(
                select(StudioRevision.version)
                .where(
                    StudioRevision.entity_type == entity_type,
                    StudioRevision.entity_id == entity_id,
                    StudioRevision.pinned.is_(False),
                )
                .order_by(StudioRevision.version.desc())
            )
        )
        .scalars()
        .all()
    )
    doomed = list(versions[KEEP_RECENT:])
    if not doomed:
        return 0
    await session.execute(
        delete(StudioRevision).where(
            StudioRevision.entity_type == entity_type,
            StudioRevision.entity_id == entity_id,
            StudioRevision.version.in_(doomed),
        )
    )
    return len(doomed)


async def list_revisions(
    session: AsyncSession, entity_type: str, entity_id: int, *, with_snapshot: bool = False
) -> list[dict]:
    """版本链，新的在前。列表默认不带快照——历史面板只显示时间和备注，
    整包快照要按版本单取，几十版一起回传纯属浪费。"""
    rows = (
        (
            await session.execute(
                select(StudioRevision)
                .where(
                    StudioRevision.entity_type == entity_type,
                    StudioRevision.entity_id == entity_id,
                )
                .order_by(StudioRevision.version.desc())
            )
        )
        .scalars()
        .all()
    )
    items = []
    for row in rows:
        view = revision_view(row)
        if not with_snapshot:
            view.pop("snapshot")
        items.append(view)
    return items


async def get_revision(
    session: AsyncSession, entity_type: str, entity_id: int, version: int
) -> StudioRevision:
    row = (
        await session.execute(
            select(StudioRevision).where(
                StudioRevision.entity_type == entity_type,
                StudioRevision.entity_id == entity_id,
                StudioRevision.version == version,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise StudioRevisionError(f"版本不存在：第 {version} 版", status=404)
    return row


async def set_pinned(
    session: AsyncSession, entity_type: str, entity_id: int, version: int, pinned: bool
) -> dict:
    """标记 / 取消「保留这一版」。取消保留后立刻按策略重裁，
    否则一条早就该裁掉的版本会一直挂着，直到下次有人编辑才被清掉。"""
    row = await get_revision(session, entity_type, entity_id, version)
    row.pinned = pinned
    await session.flush()
    if not pinned:
        await prune(session, entity_type, entity_id)
    await session.commit()
    view = revision_view(row)
    view.pop("snapshot")
    return view


async def drop_entity(session: AsyncSession, entity_type: str, entity_id: int) -> None:
    """实体被删时清掉它的版本链。没有外键：一张表挂两种实体，
    外键指不过去，删除只能显式做。"""
    await session.execute(
        delete(StudioRevision).where(
            StudioRevision.entity_type == entity_type,
            StudioRevision.entity_id == entity_id,
        )
    )
