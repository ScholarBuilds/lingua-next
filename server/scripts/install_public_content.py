"""Install the reviewed public starter pack without copying settings or user records."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import shutil
import sqlite3
import tempfile
from contextlib import closing
from pathlib import Path

from domain.desktop_content import merge_bundled_content

TABLES = {
    "book",
    "article",
    "paragraph",
    "sentence",
    "video",
    "subtitle_track",
    "subtitle_cue",
    "subtitle_sentence",
}


def install(pack: Path, database: Path, media: Path, grammar: Path) -> dict:
    manifest = json.loads((pack / "manifest.json").read_text())
    # Verify the entire allowlisted package before changing the destination.
    for relative, expected in manifest["files"].items():
        path = pack / relative
        if Path(relative).is_absolute() or not path.resolve().is_relative_to(pack.resolve()):
            raise ValueError("Unsafe starter path")
        if any(part.startswith(".") for part in Path(relative).parts) or path.is_symlink():
            raise ValueError("Unsafe starter file")
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError(f"Starter checksum mismatch: {relative}")
    marker = database.parent / "public-content-stamp.json"
    with tempfile.TemporaryDirectory(prefix="nexus-starter-") as temporary:
        baseline = Path(temporary) / "content.sqlite3"
        with gzip.open(pack / "content.sqlite3.gz", "rb") as source, baseline.open("wb") as target:
            shutil.copyfileobj(source, target)
        with closing(sqlite3.connect(baseline.as_uri() + "?mode=ro", uri=True)) as connection:
            actual = {
                row[0]
                for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
            }
            if not actual <= TABLES:
                raise ValueError("Starter contains non-content tables")
            if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("Starter database is corrupt")
        # Copy only manifest files, never local runtime directories or credentials.
        for relative in manifest["files"]:
            parts = Path(relative).parts
            if parts[0] not in {"media", "grammar"}:
                continue
            root = media if parts[0] == "media" else grammar
            destination = root.joinpath(*parts[1:])
            if not destination.resolve().is_relative_to(root.resolve()):
                raise ValueError("Unsafe content destination")
            if destination.exists():
                continue  # Keep user edits and notes intact.
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(pack / relative, destination)
        return merge_bundled_content(database, baseline, manifest["stamp"], marker)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pack", type=Path, required=True)
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--media", type=Path, required=True)
    parser.add_argument("--grammar", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(install(args.pack, args.database, args.media, args.grammar)))


if __name__ == "__main__":
    main()
