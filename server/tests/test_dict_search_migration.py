import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect

from domain.models import DictGloss


def test_gloss_cover_upgrade_and_downgrade_preserve_rows():
    path = Path(__file__).parents[1] / "migrations/versions/d0e1f2a3b4c5_dict_gloss_cover.py"
    spec = importlib.util.spec_from_file_location("gloss_cover", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        DictGloss.__table__.create(connection)
        connection.exec_driver_sql("DROP INDEX ix_dict_gloss_learner_cover")
        connection.execute(DictGloss.__table__.insert(), {
            "word": "computer", "gloss": "电脑", "tier": 1, "sense_idx": 0,
        })
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        assert "ix_dict_gloss_learner_cover" in {
            index["name"] for index in inspect(connection).get_indexes("dict_gloss")
        }
        migration.downgrade()
        assert "ix_dict_gloss_learner_cover" not in {
            index["name"] for index in inspect(connection).get_indexes("dict_gloss")
        }
        assert connection.exec_driver_sql("SELECT word, gloss FROM dict_gloss").all() == [
            ("computer", "电脑")
        ]
    engine.dispose()
