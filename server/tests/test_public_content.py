import gzip
import hashlib
import json
import sqlite3

import pytest
from sqlalchemy import create_engine

from domain.models import Base
from scripts.install_public_content import install


def package(tmp_path, *, private=False):
    pack = tmp_path / "pack"
    pack.mkdir()
    source = tmp_path / "seed.sqlite3"
    with sqlite3.connect(source) as db:
        db.execute(
            "CREATE TABLE book (id INTEGER PRIMARY KEY, slug TEXT, title TEXT, "
            "source TEXT, status TEXT)"
        )
        db.execute("INSERT INTO book VALUES (1,'demo','Demo','builtin','ready')")
        if private:
            db.execute("CREATE TABLE provider_credential (secret TEXT)")
    (pack / "content.sqlite3.gz").write_bytes(gzip.compress(source.read_bytes()))
    (pack / "grammar").mkdir()
    (pack / "grammar" / "lesson.md").write_text("Public lesson")
    files = {
        str(p.relative_to(pack)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in pack.rglob("*")
        if p.is_file()
    }
    (pack / "manifest.json").write_text(json.dumps({"stamp": "test", "files": files}))
    target = tmp_path / "user.sqlite3"
    engine = create_engine(f"sqlite:///{target}")
    Base.metadata.create_all(engine)
    engine.dispose()
    return pack, target


def test_starter_is_idempotent_and_preserves_edits(tmp_path):
    pack, target = package(tmp_path)
    media, grammar = tmp_path / "media", tmp_path / "grammar"
    install(pack, target, media, grammar)
    (grammar / "lesson.md").write_text("My own note")
    install(pack, target, media, grammar)
    with sqlite3.connect(target) as db:
        assert db.execute("SELECT count(*) FROM book").fetchone()[0] == 1
        assert db.execute("SELECT count(*) FROM provider_credential").fetchone()[0] == 0
    assert (grammar / "lesson.md").read_text() == "My own note"


def test_rejects_private_tables_before_import(tmp_path):
    pack, target = package(tmp_path, private=True)
    with pytest.raises(ValueError, match="non-content"):
        install(pack, target, tmp_path / "media", tmp_path / "grammar")
    assert not (tmp_path / "grammar").exists()


def test_rejects_modified_files_before_import(tmp_path):
    pack, target = package(tmp_path)
    (pack / "grammar" / "lesson.md").write_text("Tampered")
    with pytest.raises(ValueError, match="checksum"):
        install(pack, target, tmp_path / "media", tmp_path / "grammar")


def test_rejects_path_escape(tmp_path):
    pack, target = package(tmp_path)
    manifest = json.loads((pack / "manifest.json").read_text())
    manifest["files"]["../outside"] = "ignored"
    (pack / "manifest.json").write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match="Unsafe"):
        install(pack, target, tmp_path / "media", tmp_path / "grammar")
