import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, text


def test_sqlite_upgrade_preserves_old_turns_and_enforces_batch_identity():
    path = Path(__file__).parents[1] / "migrations/versions/e9f0a1b2c3d4_talk_records.py"
    spec = importlib.util.spec_from_file_location("talk_records_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE talk_turn (id INTEGER PRIMARY KEY, text TEXT)"))
        conn.execute(text("CREATE TABLE analysis_result (id INTEGER PRIMARY KEY)"))
        conn.execute(text("INSERT INTO talk_turn VALUES (1, 'Existing conversation')"))
        migration.op = Operations(MigrationContext.configure(conn))
        migration.upgrade()
        row = conn.execute(text("SELECT text, complete, saved, saved_texts FROM talk_turn")).one()
        assert tuple(row) == ("Existing conversation", 1, 0, "[]")
        indexes = conn.execute(text("PRAGMA index_list(talk_coach_batch)")).all()
        assert any(row[2] == 1 for row in indexes)
        migration.downgrade()
        assert (
            conn.execute(text("SELECT text FROM talk_turn")).scalar_one() == "Existing conversation"
        )
    engine.dispose()
