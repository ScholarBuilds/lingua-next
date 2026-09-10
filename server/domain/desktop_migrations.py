"""启动前备份、迁移与失败恢复。"""

import sqlite3
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine


def sqlite_backup(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with (
        closing(sqlite3.connect(f"file:{source}?mode=ro", uri=True)) as src,
        closing(sqlite3.connect(destination)) as dst,
    ):
        src.backup(dst)
        if dst.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise RuntimeError("SQLite 备份完整性检查失败")
    destination.chmod(0o600)


def upgrade_database(database: Path, backups: Path) -> dict:
    config = Config()
    config.set_main_option(
        "script_location", str(Path(__file__).resolve().parents[1] / "migrations")
    )
    head = ScriptDirectory.from_config(config).get_current_head()
    with closing(sqlite3.connect(f"file:{database}?mode=ro", uri=True)) as connection:
        row = connection.execute("SELECT version_num FROM alembic_version").fetchone()
    if row and row[0] == head:
        return {"changed": False, "revision": head}
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S")
    backup = backups / f"before-upgrade-{stamp}-{uuid4().hex[:8]}.sqlite3"
    sqlite_backup(database, backup)
    engine = create_engine(f"sqlite:///{database}")
    try:
        with engine.begin() as connection:
            config.attributes["connection"] = connection
            command.upgrade(config, "head")
        with closing(sqlite3.connect(database)) as connection:
            if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
                raise RuntimeError("迁移后外键检查失败")
    except Exception as error:
        engine.dispose()
        sqlite_backup(backup, database)
        raise RuntimeError(f"数据库升级失败，已恢复原库；备份：{backup}；原因：{error}") from error
    finally:
        engine.dispose()
    return {"changed": True, "revision": head, "backup": str(backup)}
