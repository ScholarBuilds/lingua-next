import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text


def test_workspace_migration_roundtrip_preserves_existing_media():
    path = Path(__file__).parents[1] / "migrations/versions/f2d3e4f5a6b7_workspace_snapshots.py"
    spec = importlib.util.spec_from_file_location("workspace_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE video (id INTEGER PRIMARY KEY, title TEXT)"))
        conn.execute(text("INSERT INTO video VALUES (1, 'Existing video')"))
        migration.op = Operations(MigrationContext.configure(conn))
        migration.upgrade()
        tables = inspect(conn).get_table_names()
        assert {"workspace_snapshot", "grammar_practice", "online_video_reference"} <= set(tables)
        migration.downgrade()
        assert inspect(conn).get_table_names() == ["video"]
        assert conn.execute(text("SELECT title FROM video")).scalar_one() == "Existing video"
        migration.upgrade()
    engine.dispose()
