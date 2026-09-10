import sqlite3

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from domain.desktop_migrations import upgrade_database
from domain.models import Article, Base, VocabEntry, Wordlist, WordlistItem


def test_scene_catalog_retirement_preserves_learning_and_other_books(tmp_path):
    database = tmp_path / "catalog.sqlite3"
    engine = create_engine(f"sqlite:///{database}")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        atlas = Wordlist(name="生活英语场景百科", catalog_key="scene-atlas")
        ordinary = Wordlist(name="生活英语场景百科")
        session.add_all([atlas, ordinary, VocabEntry(user_id="owner", word="one", mark="mastered")])
        session.flush()
        session.add_all(
            [
                WordlistItem(wordlist_id=atlas.id, word="one"),
                WordlistItem(wordlist_id=ordinary.id, word="one"),
                Article(title="保留短文", source_kind="scenario", deck_id=atlas.id),
            ]
        )
        session.commit()
    engine.dispose()
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE alembic_version (version_num VARCHAR(32) PRIMARY KEY)")
        connection.execute("INSERT INTO alembic_version VALUES ('a7b8c9d0e1f2')")
        original = connection.execute("SELECT * FROM vocab_entry").fetchall()
    result = upgrade_database(database, tmp_path / "backups")
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT catalog_key FROM wordlist").fetchall() == [(None,)]
        assert connection.execute("SELECT word FROM wordlist_item").fetchall() == [("one",)]
        assert connection.execute("SELECT * FROM vocab_entry").fetchall() == original
        assert connection.execute("SELECT deck_id FROM article").fetchall() == [(None,)]
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
    with sqlite3.connect(result["backup"]) as connection:
        assert connection.execute("SELECT count(*) FROM wordlist").fetchone()[0] == 2
    assert upgrade_database(database, tmp_path / "backups")["changed"] is False


def old_database(path, revision):
    engine = create_engine(f"sqlite:///{path}")
    Base.metadata.create_all(engine)
    engine.dispose()
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE alembic_version (version_num VARCHAR(32) PRIMARY KEY)")
        connection.execute("INSERT INTO alembic_version VALUES (?)", (revision,))
        connection.execute(
            "INSERT INTO vocab_entry (word, status, mark, exposures, source) "
            "VALUES ('retained', 'known', 'mastered', 4, 'reading')"
        )
        connection.execute("DROP TABLE import_dispatch")
        connection.execute("DROP TABLE IF EXISTS scene_study_note")
        connection.execute("DROP INDEX ix_wordlist_catalog_key")
        connection.execute("ALTER TABLE wordlist DROP COLUMN catalog_key")
        if revision == "c3d4e5f6a7b8":
            connection.execute("DROP TABLE learning_receipt")
            connection.execute("ALTER TABLE deck_scene_state DROP COLUMN version")
            connection.execute("ALTER TABLE deck_scene_state DROP COLUMN run_id")


@pytest.mark.parametrize("revision", ["c3d4e5f6a7b8", "d4e5f6a7b8c9"])
def test_upgrades_old_schema_with_consistent_backup(tmp_path, revision):
    database = tmp_path / "old.sqlite3"
    old_database(database, revision)
    result = upgrade_database(database, tmp_path / "backups")
    assert result["changed"] is True
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT word, mark FROM vocab_entry").fetchone() == (
            "retained",
            "mastered",
        )
        connection.execute("SELECT * FROM learning_receipt")
        connection.execute("SELECT * FROM import_dispatch")
    with sqlite3.connect(result["backup"]) as connection:
        assert (
            connection.execute("SELECT version_num FROM alembic_version").fetchone()[0] == revision
        )
    assert upgrade_database(database, tmp_path / "backups")["changed"] is False


def test_partial_migration_is_restored(tmp_path, monkeypatch):
    from domain import desktop_migrations

    database = tmp_path / "old.sqlite3"
    old_database(database, "c3d4e5f6a7b8")

    def fail(config, target):
        config.attributes["connection"].exec_driver_sql("CREATE TABLE interrupted (id INTEGER)")
        raise RuntimeError("interrupted")

    monkeypatch.setattr(desktop_migrations.command, "upgrade", fail)
    with pytest.raises(RuntimeError, match="已恢复原库"):
        upgrade_database(database, tmp_path / "backups")
    with sqlite3.connect(database) as connection:
        assert (
            connection.execute("SELECT version_num FROM alembic_version").fetchone()[0]
            == "c3d4e5f6a7b8"
        )
        assert (
            connection.execute("SELECT name FROM sqlite_master WHERE name='interrupted'").fetchone()
            is None
        )
        assert connection.execute("SELECT word FROM vocab_entry").fetchone()[0] == "retained"
