"""数据库引擎与会话工厂，以及事件流 SSE 的 LISTEN 唤醒设施。

写侧提交任务事件时会在同一事务里 ``pg_notify``（domain.studio_tasks.emit_event_notify），
这里负责读侧：进程内共享一条 asyncpg 原生连接做 LISTEN，把通知扇出给所有 SSE 循环。
worker 与 API 是两个进程，事件经数据库这条 NOTIFY 通道才推得醒对面的 SSE。
SQLite / 连接失败等没有 NOTIFY 的场合退化为纯轮询（asyncio.sleep），行为不变只是慢到 1s。
"""

import asyncio
import logging
import time
from collections.abc import AsyncGenerator, Awaitable, Callable
from typing import Any, Protocol

import asyncpg
from sqlalchemy import event
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.config import get_settings
from domain.studio_tasks import EVENT_NOTIFY_CHANNEL

logger = logging.getLogger(__name__)

engine = create_async_engine(get_settings().database_url, pool_pre_ping=True)
SessionFactory = async_sessionmaker(engine, expire_on_commit=False)


if engine.dialect.name == "sqlite":

    @event.listens_for(engine.sync_engine, "connect")
    def _configure_sqlite(dbapi_connection, _connection_record) -> None:
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA busy_timeout=5000")
        finally:
            cursor.close()


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    async with SessionFactory() as session:
        yield session


class ListenConnection(Protocol):
    """LISTEN 连接只用到的三个动词；asyncpg.Connection 天然满足，测试给桩。"""

    def is_closed(self) -> bool: ...

    async def add_listener(self, channel: str, callback: Callable[..., Any]) -> Any: ...

    async def close(self) -> Any: ...


# 重连退避：连不上 PG 时别每个轮询周期都去撞一次
LISTEN_RETRY_SECONDS = 5.0


class NotifyHub:
    """一条 LISTEN 连接扇出给多个等待者。

    ``seq`` 单调递增，`wait(seen, timeout)` 等到 ``seq > seen`` 或超时——通知落在
    两次 wait 之间（SSE 正在查库时）也不会丢，下一次 wait 立即返回。连接惰性建立，
    断了在退避窗口后重连，期间退化为定时返回（等价纯轮询）。
    """

    def __init__(
        self,
        connect: Callable[[], Awaitable[ListenConnection]],
        channel: str,
        *,
        retry_seconds: float = LISTEN_RETRY_SECONDS,
    ) -> None:
        self._connect = connect
        self.channel = channel
        self.retry_seconds = retry_seconds
        self.seq = 0
        self._conn: ListenConnection | None = None
        self._connecting: asyncio.Lock | None = None
        self._retry_at = 0.0
        self._waiters: set[asyncio.Future[None]] = set()

    def _on_notify(self, *_args: Any) -> None:
        """asyncpg 的 listener 回调（connection, pid, channel, payload）。"""
        self.seq += 1
        for waiter in self._waiters:
            if not waiter.done():
                waiter.set_result(None)
        self._waiters.clear()

    async def _ensure(self) -> bool:
        if self._conn is not None and not self._conn.is_closed():
            return True
        if time.monotonic() < self._retry_at:
            return False
        if self._connecting is None:
            self._connecting = asyncio.Lock()
        async with self._connecting:
            if self._conn is not None and not self._conn.is_closed():
                return True
            try:
                conn = await self._connect()
                await conn.add_listener(self.channel, self._on_notify)
            except Exception as exc:
                self._retry_at = time.monotonic() + self.retry_seconds
                logger.warning("LISTEN %s 建连失败，退化为轮询：%s", self.channel, exc)
                return False
            self._conn = conn
            return True

    async def wait(self, seen: int, timeout: float) -> int:
        """等到有新通知（``seq > seen``）或超时，返回当前 seq。"""
        if self.seq > seen:
            return self.seq
        if not await self._ensure():
            await asyncio.sleep(timeout)
            return self.seq
        waiter: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self._waiters.add(waiter)
        try:
            await asyncio.wait_for(waiter, timeout)
        except TimeoutError:
            pass
        finally:
            self._waiters.discard(waiter)
        return self.seq

    async def close(self) -> None:
        conn, self._conn = self._conn, None
        if conn is not None and not conn.is_closed():
            try:
                await conn.close()
            except Exception as exc:  # noqa: BLE001 — 关停收尾，失败只记日志
                logger.warning("LISTEN 连接关闭失败：%s", exc)
        for waiter in self._waiters:
            if not waiter.done():
                waiter.set_result(None)
        self._waiters.clear()


def _asyncpg_connect(engine_: AsyncEngine) -> Callable[[], Awaitable[ListenConnection]]:
    """从 SQLAlchemy URL 建 asyncpg 原生连接——LISTEN 不能走 ORM 连接池
    （归还时不会 UNLISTEN，监听器会漏给下一个借走连接的人）。"""
    url = engine_.url

    async def connect() -> ListenConnection:
        return await asyncpg.connect(
            host=url.host,
            port=url.port,
            user=url.username,
            password=url.password,
            database=url.database,
        )

    return connect


_hubs: dict[str, NotifyHub] = {}


def notify_hub_for(engine_: AsyncEngine, channel: str = EVENT_NOTIFY_CHANNEL) -> NotifyHub:
    key = f"{engine_.url.render_as_string(hide_password=True)}#{channel}"
    hub = _hubs.get(key)
    if hub is None:
        hub = _hubs[key] = NotifyHub(_asyncpg_connect(engine_), channel)
    return hub


def event_wakeup(
    session_factory: async_sessionmaker[AsyncSession],
    channel: str = EVENT_NOTIFY_CHANNEL,
) -> Callable[[float], Awaitable[None]]:
    """SSE 循环的「等通知或超时」；喂给 iter_sse_frames 的 ``sleep`` 形参。

    以会话工厂绑定的引擎为准（而不是模块级 engine）：测试把 SessionFactory 换成
    内存 SQLite 时，这里跟着退化为 asyncio.sleep，不会去连真 PG。
    """
    bind = session_factory.kw.get("bind")
    if not isinstance(bind, AsyncEngine) or bind.dialect.name != "postgresql":
        return asyncio.sleep
    hub = notify_hub_for(bind, channel)
    seen = hub.seq

    async def wait(timeout: float) -> None:
        nonlocal seen
        seen = await hub.wait(seen, timeout)

    return wait


async def close_notify_hubs() -> None:
    """关停收尾：断开全部 LISTEN 连接，放行还在等的循环。"""
    hubs = list(_hubs.values())
    _hubs.clear()
    for hub in hubs:
        await hub.close()
