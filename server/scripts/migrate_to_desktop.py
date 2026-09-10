from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import shutil
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import inspect, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from app.config import get_settings
from domain.credentials import decrypt_config
from domain.models import Base, ProviderCredential


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


async def _counts(engine: AsyncEngine) -> dict[str, int]:
    async with engine.connect() as connection:
        names = await connection.run_sync(lambda sync: inspect(sync).get_table_names())
        result: dict[str, int] = {}
        for name in sorted(names):
            if name == "alembic_version":
                continue
            quoted = connection.dialect.identifier_preparer.quote(name)
            result[name] = int(
                (await connection.execute(text(f"SELECT COUNT(*) FROM {quoted}"))).scalar()
            )
        return result


def _media_manifest(root: Path) -> list[dict[str, Any]]:
    if not root.is_dir():
        return []
    return [
        {"path": str(file.relative_to(root)), "bytes": file.stat().st_size, "sha256": _sha256(file)}
        for file in sorted(root.rglob("*"))
        if file.is_file()
    ]


async def _verify_credentials(source: AsyncEngine) -> int:
    async with source.connect() as connection:
        rows = (await connection.execute(select(ProviderCredential.config))).scalars()
        configs = list(rows)
    for config in configs:
        decrypt_config(config)
    return len(configs)


async def _copy_tables(
    source: AsyncEngine, target: AsyncEngine
) -> tuple[dict[str, int], dict[str, list[str]]]:
    copied: dict[str, int] = {}
    missing_columns: dict[str, list[str]] = {}
    async with source.connect() as source_connection, target.begin() as target_connection:

        def source_schema(sync_connection) -> dict[str, set[str]]:
            inspector = inspect(sync_connection)
            return {
                name: {column["name"] for column in inspector.get_columns(name)}
                for name in inspector.get_table_names()
            }

        source_tables = await source_connection.run_sync(source_schema)
        for table in Base.metadata.sorted_tables:
            source_columns = source_tables.get(table.name)
            if source_columns is None:
                continue
            existing = int(
                (
                    await target_connection.execute(select(text("count(*)")).select_from(table))
                ).scalar()
            )
            if existing:
                raise RuntimeError(f"目标表 {table.name} 不是空表，拒绝覆盖")
            shared_columns = [column for column in table.c if column.name in source_columns]
            absent = [column.name for column in table.c if column.name not in source_columns]
            if absent:
                missing_columns[table.name] = absent
            result = await source_connection.execute(select(*shared_columns))
            count = 0
            while rows := result.mappings().fetchmany(500):
                await target_connection.execute(table.insert(), [dict(row) for row in rows])
                count += len(rows)
            copied[table.name] = count
        violations = (await target_connection.execute(text("PRAGMA foreign_key_check"))).all()
        if violations:
            raise RuntimeError(f"SQLite 外键校验失败：{violations[:10]}")
    return copied, missing_columns


def _pg_dump(source_url: str, destination: Path) -> None:
    executable = shutil.which("pg_dump")
    if executable is None:
        raise RuntimeError(
            "找不到 pg_dump；请安装 PostgreSQL 客户端，或用 --source-backup 传入已生成的 custom-format 备份"
        )
    parsed = make_url(source_url)
    url = parsed.set(drivername="postgresql", password=None)
    env = os.environ.copy()
    if parsed.password:
        env["PGPASSWORD"] = parsed.password
    subprocess.run(
        [
            executable,
            "--format=custom",
            "--file",
            str(destination),
            url.render_as_string(hide_password=True),
        ],
        check=True,
        env=env,
    )


async def migrate(args: argparse.Namespace) -> dict[str, Any]:
    source = create_async_engine(args.source_url)
    target = create_async_engine(f"sqlite+aiosqlite:///{args.target}")
    try:
        source_counts = await _counts(source)
        credential_count = await _verify_credentials(source)
        media = _media_manifest(args.media_root)
        report: dict[str, Any] = {
            "created_at": datetime.now(UTC).isoformat(),
            "mode": "apply" if args.apply else "dry-run",
            "source_tables": source_counts,
            "source_records": sum(source_counts.values()),
            "media_files": len(media),
            "media_bytes": sum(item["bytes"] for item in media),
            "credentials_verified": credential_count,
        }
        if args.apply:
            if not args.target.is_file():
                raise RuntimeError("目标 SQLite 基线不存在，请先从安装包复制基线")
            args.backup_dir.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            if make_url(args.source_url).get_backend_name() == "postgresql":
                source_backup = getattr(args, "source_backup", None)
                if source_backup is None:
                    source_backup = args.backup_dir / f"postgres-{stamp}.dump"
                    _pg_dump(args.source_url, source_backup)
                if not source_backup.is_file() or source_backup.stat().st_size == 0:
                    raise RuntimeError("PostgreSQL 备份不存在或为空")
                report["source_backup"] = {
                    "name": source_backup.name,
                    "bytes": source_backup.stat().st_size,
                    "sha256": _sha256(source_backup),
                }
            shutil.copy2(args.target, args.backup_dir / f"desktop-before-{stamp}.sqlite3")
            copied_tables, missing_columns = await _copy_tables(source, target)
            report["copied_tables"] = copied_tables
            report["source_missing_columns"] = missing_columns
            if args.media_root.is_dir():
                shutil.copytree(args.media_root, args.target_media, dirs_exist_ok=True)
                copied_media = _media_manifest(args.target_media)
                if copied_media != media:
                    raise RuntimeError("媒体文件 checksum 校验失败")
            report["target_tables"] = await _counts(target)
            report["foreign_keys"] = "ok"
            report["credentials"] = "pending-desktop-file-rekey"
        args.manifest.parent.mkdir(parents=True, exist_ok=True)
        args.manifest.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        return report
    finally:
        await source.dispose()
        await target.dispose()


def main() -> None:
    settings = get_settings()
    parser = argparse.ArgumentParser(description="Dry-run or migrate NEXUS data to desktop SQLite")
    parser.add_argument("--source-url", default=settings.database_url)
    parser.add_argument("--target", type=Path, required=True)
    parser.add_argument("--media-root", type=Path, default=Path(settings.media_root))
    parser.add_argument("--target-media", type=Path, required=True)
    parser.add_argument("--backup-dir", type=Path, required=True)
    parser.add_argument(
        "--source-backup",
        type=Path,
        help="已由容器或外部 pg_dump -Fc 生成的 PostgreSQL 备份",
    )
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    print(json.dumps(asyncio.run(migrate(args)), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
