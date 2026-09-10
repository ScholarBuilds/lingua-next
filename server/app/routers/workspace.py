from typing import Literal
from urllib.parse import parse_qsl, urlsplit

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import delete, select

from app.owner import CurrentOwner
from app.routers.dict import SessionDep
from domain.models import WorkspaceSnapshot

router = APIRouter(prefix="/workspace", tags=["workspace"])
Module = Literal[
    "today",
    "read",
    "video",
    "vocab",
    "dict",
    "software-english",
    "grammar",
    "talk",
    "studio",
    "mail",
    "accounts",
    "extensions",
    "tasks",
    "settings",
]


class SnapshotValue(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    route: str | None = Field(default=None, max_length=2048)
    scroll: dict[str, float] = Field(default_factory=dict, max_length=24)
    anchor: str | None = Field(default=None, max_length=256)
    offset: float = Field(default=0, ge=-100_000_000, le=100_000_000)
    text: str | None = Field(default=None, max_length=100_000)
    selected: str | None = Field(default=None, max_length=2048)
    expanded: list[str] = Field(default_factory=list, max_length=200)
    width: float | None = Field(default=None, ge=120, le=1600)

    @field_validator("route")
    @classmethod
    def internal_route(cls, value: str | None) -> str | None:
        if value is None:
            return None
        parsed = urlsplit(value)
        if (
            not value.startswith("/")
            or value.startswith("//")
            or "\\" in value
            or parsed.scheme
            or parsed.netloc
            or any(ord(c) < 32 for c in value)
        ):
            raise ValueError("仅支持站内页面")
        root = parsed.path.split("/")[1]
        if root not in {
            "",
            "read",
            "video",
            "vocab",
            "dict",
            "software-english",
            "grammar",
            "talk",
            "studio",
            "mail",
            "accounts",
            "extensions",
            "tasks",
            "pipeline",
            "settings",
        }:
            raise ValueError("未知页面")
        if any(
            any(
                secret in key.lower()
                for secret in ("token", "secret", "password", "auth", "code", "key")
            )
            for key, _ in parse_qsl(parsed.query)
        ):
            raise ValueError("工作位置不能包含认证参数")
        return value

    @field_validator("scroll")
    @classmethod
    def scroll_positions(cls, value: dict[str, float]) -> dict[str, float]:
        if any(len(k) > 120 or not 0 <= v <= 100_000_000 for k, v in value.items()):
            raise ValueError("无效滚动位置")
        return value


class SnapshotPut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    module: Module
    key: str = Field(min_length=1, max_length=2048, pattern=r"^[^\x00-\x1f\x7f]+$")
    version: Literal[1] = 1
    value: SnapshotValue


@router.get("/snapshots")
async def snapshots(
    owner: CurrentOwner, session: SessionDep, offset: int = Query(0, ge=0)
) -> list[dict]:
    rows = (
        await session.scalars(
            select(WorkspaceSnapshot)
            .where(
                WorkspaceSnapshot.user_id == owner.id,
            )
            .order_by(WorkspaceSnapshot.module, WorkspaceSnapshot.key)
            .offset(offset)
            .limit(500)
        )
    ).all()
    return [
        {"module": r.module, "key": r.key, "version": r.version, "value": r.value} for r in rows
    ]


@router.put("/snapshots")
async def put_snapshot(body: SnapshotPut, owner: CurrentOwner, session: SessionDep) -> dict:
    # 凭据页只保留导航，秘密输入不进入通用快照。
    if body.value.text is not None and body.module not in {
        "grammar",
        "talk",
        "studio",
        "mail",
        "video",
    }:
        raise HTTPException(422, "该页面不支持保存草稿")
    row = await session.get(WorkspaceSnapshot, (owner.id, body.module, body.key))
    if row is None:
        row = WorkspaceSnapshot(user_id=owner.id, module=body.module, key=body.key)
        session.add(row)
    row.version = body.version
    row.value = body.value.model_dump(exclude_none=True)
    await session.commit()
    return {"saved": True}


@router.delete("/snapshots", status_code=204)
async def clear_snapshots(owner: CurrentOwner, session: SessionDep) -> None:
    await session.execute(delete(WorkspaceSnapshot).where(WorkspaceSnapshot.user_id == owner.id))
    await session.commit()
