from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import aiosqlite
from arq import create_pool
from arq.connections import ArqRedis, RedisSettings
from arq.constants import in_progress_key_prefix, job_key_prefix

from app.config import get_settings


class QueuePort(Protocol):
    async def enqueue_job(self, function: str, *args: Any, **kwargs: Any) -> Any: ...

    async def get(self, key: str) -> bytes | None: ...

    async def set(self, key: str, value: Any, *, ex: int | None = None) -> Any: ...

    async def delete(self, *keys: str) -> int: ...

    async def zadd(self, name: str, mapping: dict[str, float]) -> int: ...


@dataclass(frozen=True)
class LocalJobHandle:
    job_id: str


@dataclass(frozen=True)
class ClaimedJob:
    job_id: str
    function: str
    args: list[Any]
    generation: int
    attempt: int


class DatabaseQueue:
    def __init__(self, path: str) -> None:
        self.path = Path(path).expanduser()
        self.owner = f"desktop-{uuid.uuid4()}"
        self._ready = False

    async def initialize(self) -> None:
        if self._ready:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        async with aiosqlite.connect(self.path) as db:
            await db.executescript(
                """
                PRAGMA journal_mode=WAL;
                PRAGMA busy_timeout=5000;
                CREATE TABLE IF NOT EXISTS local_job (
                    job_id TEXT PRIMARY KEY,
                    function TEXT NOT NULL,
                    args_json TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'queued',
                    available_at REAL NOT NULL,
                    lease_owner TEXT,
                    lease_until REAL,
                    generation INTEGER NOT NULL DEFAULT 0,
                    attempt INTEGER NOT NULL DEFAULT 0,
                    result_json TEXT,
                    error TEXT,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS ix_local_job_claim
                    ON local_job(status, available_at, lease_until);
                CREATE TABLE IF NOT EXISTS local_kv (
                    key TEXT PRIMARY KEY,
                    value BLOB NOT NULL,
                    expires_at REAL
                );
                CREATE TABLE IF NOT EXISTS local_zset (
                    name TEXT NOT NULL,
                    member TEXT NOT NULL,
                    score REAL NOT NULL,
                    PRIMARY KEY (name, member)
                );
                """
            )
            await db.execute("BEGIN IMMEDIATE")
            columns = {
                row[1]
                for row in await (await db.execute("PRAGMA table_info(local_job)")).fetchall()
            }
            if "dedup_key" not in columns:
                await db.execute("ALTER TABLE local_job ADD COLUMN dedup_key TEXT")
                await db.execute("UPDATE local_job SET dedup_key=job_id")
            await db.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS ix_local_job_active_key "
                "ON local_job(dedup_key) WHERE status IN ('queued', 'running')"
            )
            await db.commit()
        self._ready = True

    async def enqueue_job(self, function: str, *args: Any, **kwargs: Any) -> LocalJobHandle | None:
        await self.initialize()
        dedup_key = str(kwargs.pop("_job_id", "") or uuid.uuid4())
        job_id = str(kwargs.pop("_execution_id", None) or uuid.uuid4())
        defer = float(kwargs.pop("_defer_by", 0) or 0)
        if kwargs:
            unsupported = ", ".join(sorted(kwargs))
            raise ValueError(f"desktop queue 不支持这些作业参数：{unsupported}")
        now = time.time()
        async with aiosqlite.connect(self.path) as db:
            cursor = await db.execute(
                """
                INSERT OR IGNORE INTO local_job
                    (job_id, dedup_key, function, args_json, available_at, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    job_id,
                    dedup_key,
                    function,
                    json.dumps(args, ensure_ascii=False),
                    now + defer,
                    now,
                    now,
                ),
            )
            await db.commit()
            return LocalJobHandle(job_id) if cursor.rowcount else None

    async def claim(self, *, lease_seconds: float = 60.0) -> ClaimedJob | None:
        await self.initialize()
        now = time.time()
        async with aiosqlite.connect(self.path) as db:
            await db.execute("PRAGMA busy_timeout=5000")
            await db.execute("BEGIN IMMEDIATE")
            row = await (
                await db.execute(
                    """
                    SELECT job_id, function, args_json, generation, attempt
                    FROM local_job
                    WHERE available_at <= ?
                      AND (status = 'queued' OR (status = 'running' AND lease_until < ?))
                    ORDER BY available_at, created_at
                    LIMIT 1
                    """,
                    (now, now),
                )
            ).fetchone()
            if row is None:
                await db.commit()
                return None
            generation = int(row[3]) + 1
            attempt = int(row[4]) + 1
            await db.execute(
                """
                UPDATE local_job
                SET status='running', lease_owner=?, lease_until=?, generation=?,
                    attempt=?, updated_at=?
                WHERE job_id=?
                """,
                (self.owner, now + lease_seconds, generation, attempt, now, row[0]),
            )
            await db.commit()
        return ClaimedJob(str(row[0]), str(row[1]), json.loads(row[2]), generation, attempt)

    async def finish(self, job: ClaimedJob, result: Any) -> bool:
        return await self._finish(job, "complete", result_json=json.dumps(result, default=str))

    async def fail(self, job: ClaimedJob, error: str, *, retry: bool) -> bool:
        status = "queued" if retry else "failed"
        delay = min(60.0, 2.0 ** min(job.attempt, 5)) if retry else 0.0
        return await self._finish(job, status, error=error, available_at=time.time() + delay)

    async def _finish(
        self,
        job: ClaimedJob,
        status: str,
        *,
        result_json: str | None = None,
        error: str | None = None,
        available_at: float | None = None,
    ) -> bool:
        await self.initialize()
        now = time.time()
        async with aiosqlite.connect(self.path) as db:
            cursor = await db.execute(
                """
                UPDATE local_job
                SET status=?, result_json=?, error=?, available_at=?, lease_owner=NULL,
                    lease_until=NULL, updated_at=?
                WHERE job_id=? AND generation=? AND lease_owner=?
                """,
                (
                    status,
                    result_json,
                    error,
                    available_at if available_at is not None else now,
                    now,
                    job.job_id,
                    job.generation,
                    self.owner,
                ),
            )
            await db.commit()
            return bool(cursor.rowcount)

    async def get(self, key: str) -> bytes | None:
        await self.initialize()
        now = time.time()
        async with aiosqlite.connect(self.path) as db:
            row = await (
                await db.execute("SELECT value, expires_at FROM local_kv WHERE key=?", (key,))
            ).fetchone()
            if row is None:
                return None
            if row[1] is not None and float(row[1]) <= now:
                await db.execute("DELETE FROM local_kv WHERE key=?", (key,))
                await db.commit()
                return None
            value = row[0]
            return value if isinstance(value, bytes) else str(value).encode()

    async def set(self, key: str, value: Any, *, ex: int | None = None) -> bool:
        await self.initialize()
        raw = value if isinstance(value, bytes) else str(value).encode()
        expires_at = time.time() + ex if ex is not None else None
        async with aiosqlite.connect(self.path) as db:
            await db.execute(
                """
                INSERT INTO local_kv(key, value, expires_at) VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at
                """,
                (key, raw, expires_at),
            )
            await db.commit()
        return True

    async def delete(self, *keys: str) -> int:
        await self.initialize()
        if not keys:
            return 0
        placeholders = ",".join("?" for _ in keys)
        async with aiosqlite.connect(self.path) as db:
            cursor = await db.execute(f"DELETE FROM local_kv WHERE key IN ({placeholders})", keys)
            await db.commit()
            return int(cursor.rowcount)

    async def zadd(self, name: str, mapping: dict[str, float]) -> int:
        await self.initialize()
        async with aiosqlite.connect(self.path) as db:
            for member, score in mapping.items():
                await db.execute(
                    """
                    INSERT INTO local_zset(name, member, score) VALUES (?, ?, ?)
                    ON CONFLICT(name, member) DO UPDATE SET score=excluded.score
                    """,
                    (name, member, score),
                )
            await db.commit()
        return len(mapping)


class RedisQueue:
    def __init__(self, redis: ArqRedis) -> None:
        self.redis = redis

    def __getattr__(self, name: str) -> Any:
        return getattr(self.redis, name)

    async def enqueue_job(self, function: str, *args: Any, **kwargs: Any) -> Any:
        dedup_key = kwargs.pop("_job_id", None)
        execution_id = kwargs.pop("_execution_id", None)
        if not dedup_key:
            return await self.redis.enqueue_job(function, *args, _job_id=execution_id, **kwargs)
        key = f"nexus:queue:active:{dedup_key}"
        async with self.redis.lock(f"{key}:lock", timeout=10, blocking_timeout=5):
            previous = await self.redis.get(key)
            if previous:
                execution = previous.decode() if isinstance(previous, bytes) else previous
                if await self.redis.exists(
                    job_key_prefix + execution, in_progress_key_prefix + execution
                ):
                    return None
            execution = str(execution_id or uuid.uuid4())
            await self.redis.set(key, execution)
            job = await self.redis.enqueue_job(function, *args, _job_id=execution, **kwargs)
            return job


_pool: QueuePort | None = None


async def get_queue() -> QueuePort:
    global _pool
    if _pool is None:
        settings = get_settings()
        if settings.runtime_profile == "desktop":
            local = DatabaseQueue(settings.desktop_queue_path)
            await local.initialize()
            _pool = local
        else:
            _pool = RedisQueue(await create_pool(RedisSettings.from_dsn(settings.redis_url)))
    return _pool


def reset_queue() -> None:
    global _pool
    _pool = None
