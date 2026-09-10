"""共享 fixture：内存 SQLite + 依赖注入的 HTTP 客户端。

既有测试全是纯领域逻辑（不碰库），工坊的 CRUD 是第一批要真走「路由 → 会话 →
落库」的测试，这里补上通用设施：

- `db_engine`：内存 SQLite（StaticPool 单连接，建全部表）。模型层 JSONVariant
  在 SQLite 落普通 JSON，行为与 JSONB 一致，够 CRUD 测试用。
- `client`：httpx ASGITransport 直连 app，`get_session` 被覆写指向测试引擎——
  不起真服务、不碰开发库。
"""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.db import get_session
from app.main import app
from domain.model_invocations import InvocationEventWriter, PendingEvent
from domain.models import Base


@pytest.fixture
async def db_engine():
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield engine
    finally:
        await engine.dispose()


@pytest.fixture
async def session_factory(db_engine):
    return async_sessionmaker(db_engine, expire_on_commit=False)


class BufferedEventWriter(InvocationEventWriter):
    """测试用的模型调用事件写入器：``append`` 只攒在内存，``flush`` 时一次写库。

    内存库是 StaticPool 单连接，生产里的后台消费者任务会随时插进来提交并归还连接，
    归还时的 rollback-on-return 会把请求会话刚 flush、还没 commit 的行一并回滚
    （image_asset 就这样丢过），测试结束时还会和 `engine.dispose()` 抢同一条连接。
    事件只在 ``flush_invocation_events`` 时落库，断言前显式调用即可。
    """

    def __init__(self) -> None:
        super().__init__()
        self.buffered: list[PendingEvent] = []

    def append(self, event: PendingEvent) -> bool:
        self.buffered.append(event)
        return True

    async def flush(self) -> None:
        batch, self.buffered = self.buffered, []
        if batch:
            await self._write(batch)


@pytest.fixture(autouse=True)
async def _detached_session(session_factory, monkeypatch):
    """把「自带 session 的落库」也指到内存库。

    GPT 对话断流时的落库刻意不复用请求作用域的 session（那时它已经在拆），
    自己开一个——不接管的话这条路在测试里会去连真库，既测不了也会污染开发库。
    模型调用事件写入器同样换成攒批版本，见 :class:`BufferedEventWriter`。
    """
    from contextlib import asynccontextmanager

    from app.routers import assistant as assistant_router
    from app.routers import grammar_docs
    from domain import (
        deck_ai,
        model_invocations,
        model_runtime,
        network_policy,
        routines,
        studio_gpt,
        workbench_facts,
    )

    @asynccontextmanager
    async def _factory():
        async with session_factory() as s:
            yield s

    monkeypatch.setattr(studio_gpt, "detached_session", _factory)
    monkeypatch.setattr(deck_ai, "detached_session", _factory)
    monkeypatch.setattr(model_invocations, "detached_session", _factory)
    monkeypatch.setattr(model_runtime, "detached_session", _factory)
    monkeypatch.setattr(grammar_docs, "detached_session", _factory)
    monkeypatch.setattr(assistant_router, "detached_session", _factory)
    monkeypatch.setattr(workbench_facts, "detached_session", _factory)
    monkeypatch.setattr(routines, "detached_session", _factory)
    monkeypatch.setattr(network_policy, "detached_session", _factory)
    monkeypatch.setattr(model_invocations, "event_writer", BufferedEventWriter())
    _assert_every_detached_session_is_taken_over(locals())


def _assert_every_detached_session_is_taken_over(scope: dict) -> None:
    """新写一个 detached_session 却忘了在这里接管，会静默写进开发库（CR-011 踩过）。

    扫 domain/ 里定义了这个名字的模块，逐个核对上面确实换成了内存库的工厂。
    """
    import re
    from pathlib import Path

    domain_dir = Path(__file__).resolve().parents[1] / "domain"
    declared = {
        path.stem
        for path in domain_dir.glob("*.py")
        if re.search(r"^async def detached_session\(", path.read_text(encoding="utf-8"), re.M)
    }
    missed = sorted(
        name
        for name in declared
        if not (
            (module := scope.get(name)) is not None
            and getattr(module.detached_session, "__module__", "") != f"domain.{name}"
        )
    )
    assert not missed, f"这些模块的 detached_session 没被接管，会写进开发库：{missed}"


@pytest.fixture
async def session(session_factory):
    async with session_factory() as s:
        yield s


@pytest.fixture
async def client(session_factory):
    """无账号的单人工作台（CR-006）：客户端不带任何身份，路由从 app.owner 取 owner。"""

    async def _override():
        async with session_factory() as s:
            yield s

    app.dependency_overrides[get_session] = _override
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    app.dependency_overrides.pop(get_session, None)
