from __future__ import annotations

import argparse
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from domain.models import Base, UserPref
from scripts import migrate_to_desktop


async def _create_database(path: Path, *, with_pref: bool) -> None:
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    if with_pref:
        async with engine.begin() as connection:
            await connection.execute(
                UserPref.__table__.insert(),
                [{"key": "probe", "value": {"enabled": True}}],
            )
    await engine.dispose()


async def test_dry_run_and_apply_copy_database_and_media(tmp_path):
    source = tmp_path / "source.sqlite3"
    target = tmp_path / "target.sqlite3"
    media = tmp_path / "media"
    target_media = tmp_path / "target-media"
    media.mkdir()
    (media / "sample.txt").write_text("nexus", encoding="utf-8")
    await _create_database(source, with_pref=True)
    await _create_database(target, with_pref=False)
    args = argparse.Namespace(
        source_url=f"sqlite+aiosqlite:///{source}",
        target=target,
        media_root=media,
        target_media=target_media,
        backup_dir=tmp_path / "backups",
        manifest=tmp_path / "migration.json",
        apply=False,
    )
    dry_run = await migrate_to_desktop.migrate(args)
    assert dry_run["mode"] == "dry-run"
    assert dry_run["source_tables"]["user_pref"] == 1
    assert dry_run["media_files"] == 1

    args.apply = True
    applied = await migrate_to_desktop.migrate(args)
    assert applied["copied_tables"]["user_pref"] == 1
    assert applied["target_tables"]["user_pref"] == 1
    assert applied["foreign_keys"] == "ok"
    assert applied["credentials"] == "pending-desktop-file-rekey"
    assert (target_media / "sample.txt").read_text(encoding="utf-8") == "nexus"


async def test_copy_tables_accepts_source_schema_before_new_nullable_columns(tmp_path):
    source = tmp_path / "old.sqlite3"
    target = tmp_path / "current.sqlite3"
    source_engine = create_async_engine(f"sqlite+aiosqlite:///{source}")
    async with source_engine.begin() as connection:
        await connection.execute(
            text(
                "CREATE TABLE computer_session ("
                "id INTEGER PRIMARY KEY, goal TEXT NOT NULL, start_url VARCHAR(2048), "
                "scope VARCHAR(16) NOT NULL, status VARCHAR(24) NOT NULL, "
                "status_detail TEXT, plan JSON, summary TEXT, step_count INTEGER NOT NULL, "
                "max_steps INTEGER NOT NULL, max_minutes INTEGER NOT NULL, "
                "current_url VARCHAR(2048), capability VARCHAR(32), created_at DATETIME NOT NULL, "
                "started_at DATETIME, ended_at DATETIME)"
            )
        )
        await connection.execute(
            text(
                "INSERT INTO computer_session "
                "(id, goal, scope, status, step_count, max_steps, max_minutes, created_at) "
                "VALUES (1, 'open app', 'desktop', 'done', 1, 40, 15, CURRENT_TIMESTAMP)"
            )
        )
    await _create_database(target, with_pref=False)
    target_engine = create_async_engine(f"sqlite+aiosqlite:///{target}")

    copied, missing = await migrate_to_desktop._copy_tables(source_engine, target_engine)

    assert copied["computer_session"] == 1
    assert missing["computer_session"] == ["conversation_id", "mission_id"]
    async with target_engine.connect() as connection:
        row = (
            await connection.execute(
                text("SELECT goal, conversation_id, mission_id FROM computer_session")
            )
        ).one()
    assert tuple(row) == ("open app", None, None)
    await source_engine.dispose()
    await target_engine.dispose()


def test_pg_dump_does_not_put_password_in_arguments(tmp_path, monkeypatch):
    calls: list[tuple[list[str], dict[str, str]]] = []

    def run(args, *, check, env):
        assert check is True
        calls.append((args, env))

    monkeypatch.setattr(migrate_to_desktop.subprocess, "run", run)
    monkeypatch.setattr(migrate_to_desktop.shutil, "which", lambda _name: "/usr/bin/pg_dump")
    migrate_to_desktop._pg_dump(
        "postgresql+asyncpg://lingua:secret-value@localhost:5432/lingua",
        tmp_path / "backup.dump",
    )
    args, env = calls[0]
    assert "secret-value" not in " ".join(args)
    assert env["PGPASSWORD"] == "secret-value"


def test_pg_dump_reports_missing_client(tmp_path, monkeypatch):
    monkeypatch.setattr(migrate_to_desktop.shutil, "which", lambda _name: None)

    with pytest.raises(RuntimeError, match="--source-backup"):
        migrate_to_desktop._pg_dump(
            "postgresql+asyncpg://lingua@localhost:5432/lingua",
            tmp_path / "backup.dump",
        )
