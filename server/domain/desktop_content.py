"""桌面包的内容升级（M91）：安装包换了内容基线，但用户目录里的库已经存在，就把缺的内容表合并进去。

首启时壳整份拷基线就够了；问题出在第二次——同一个版本号换了内容（比如加了视频）再装，库文件在、
种子标记也在，什么都不会更新，用户看到的还是老内容。这里按「内容戳」判断：包里的
`content-stamp.json` 与用户目录里记的不一样，就 ATTACH 包内基线，按表合并：

- 自然主键的词典 / 音标 / 语法 / 场景表：`INSERT OR IGNORE`，有就跳过
- 内置书与视频这两组整数主键的表：目标表空就整组拷；目标里有同 id 但不是同一条（用户自己导入的撞号）
  就整组跳过并记下——宁可少一组内容，不能把包里的字幕挂到用户自己的视频上
- `analysis_result` 按寻址六元组去重插入，不带 id（自增）
- `user_pref` 只带查词索引的构建元数据

合并只加不删：用户自己的东西一行不动。
"""

from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

NATURAL_KEY_TABLES = (
    "dict_entry",
    "dict_head",
    "dict_gloss",
    "dict_related",
    "dict_enrich",
    "word_phoneme",
    "phoneme",
    "phoneme_difficulty",
    "minimal_pair",
    "grammar_point",
    "grammar_card",
    "grammar_construction",
    "grammar_concept",
    "misconception",
    "image_style",
    "deck_scene",
    "word_scene",
    "deck_cover",
)
# (组名, 领头表, 领头表用来判「是不是同一条」的列, 组内按依赖顺序的表)
ID_GROUPS = (
    ("books", "book", "slug", ("book", "article", "paragraph", "sentence", "grammar_occurrence")),
    (
        "videos",
        "video",
        "title",
        (
            "video",
            "subtitle_track",
            "subtitle_cue",
            "subtitle_sentence",
            "study_unit",
            "subtitle_issue",
        ),
    ),
)
ANALYSIS_ADDRESS = ("scope", "content_hash", "context_hash", "kind", "provider", "lang_pair")


def read_stamp(stamp_file: Path) -> str | None:
    if not stamp_file.is_file():
        return None
    try:
        value = json.loads(stamp_file.read_text(encoding="utf-8")).get("stamp")
    except (OSError, ValueError):
        return None
    return value if isinstance(value, str) and value else None


def write_stamp(stamp_file: Path, stamp: str, extra: dict | None = None) -> None:
    stamp_file.parent.mkdir(parents=True, exist_ok=True)
    payload = {"schema": 1, "stamp": stamp, "at": datetime.now(UTC).isoformat(timespec="seconds")}
    if extra:
        payload.update(extra)
    stamp_file.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def _columns(connection: sqlite3.Connection, schema: str, table: str) -> list[str]:
    return [str(r[1]) for r in connection.execute(f"PRAGMA {schema}.table_info({table})")]


def _shared_columns(connection: sqlite3.Connection, table: str) -> list[str]:
    target = _columns(connection, "main", table)
    source = set(_columns(connection, "src", table))
    return [c for c in target if c in source]


def _insert_ignore(connection: sqlite3.Connection, table: str) -> int:
    cols = _shared_columns(connection, table)
    if not cols:
        return 0
    joined = ", ".join(cols)
    before = connection.total_changes
    connection.execute(
        f"INSERT OR IGNORE INTO main.{table} ({joined}) SELECT {joined} FROM src.{table}"
    )
    return connection.total_changes - before


def _group_conflicts(connection: sqlite3.Connection, lead: str, identity: str) -> int:
    row = connection.execute(
        f"SELECT count(*) FROM main.{lead} m JOIN src.{lead} s ON s.id = m.id "
        f"WHERE m.{identity} IS NOT s.{identity}"
    ).fetchone()
    return int(row[0])


def _merge_analysis(connection: sqlite3.Connection) -> int:
    cols = [c for c in _shared_columns(connection, "analysis_result") if c != "id"]
    if not cols:
        return 0
    joined = ", ".join(cols)
    selected = ", ".join(f"s.{c}" for c in cols)
    match = " AND ".join(f"m.{c} IS s.{c}" for c in ANALYSIS_ADDRESS)
    before = connection.total_changes
    connection.execute(
        f"INSERT INTO main.analysis_result ({joined}) SELECT {selected} FROM src.analysis_result s "
        f"WHERE NOT EXISTS (SELECT 1 FROM main.analysis_result m WHERE {match})"
    )
    return connection.total_changes - before


def merge_bundled_content(database: Path, baseline: Path, stamp: str, stamp_file: Path) -> dict:
    """把包内基线里用户库缺的内容合并进去；戳相同直接返回。返回各表 / 各组的新增行数。"""
    if read_stamp(stamp_file) == stamp:
        return {"skipped": True, "stamp": stamp}
    if not baseline.is_file():
        raise FileNotFoundError(f"安装包缺少内容基线：{baseline}")
    counts: dict[str, int] = {}
    skipped: list[str] = []
    connection = sqlite3.connect(database)
    try:
        connection.execute("PRAGMA foreign_keys=OFF")
        connection.execute("ATTACH DATABASE ? AS src", (str(baseline),))
        src_tables = {
            r[0]
            for r in connection.execute("SELECT name FROM src.sqlite_master WHERE type='table'")
        }
        main_tables = {
            r[0]
            for r in connection.execute("SELECT name FROM main.sqlite_master WHERE type='table'")
        }
        usable = src_tables & main_tables
        connection.execute("BEGIN")
        for table in NATURAL_KEY_TABLES:
            if table in usable:
                counts[table] = _insert_ignore(connection, table)
        for name, lead, identity, tables in ID_GROUPS:
            if lead not in usable:
                continue
            if _group_conflicts(connection, lead, identity) > 0:
                skipped.append(name)
                continue
            for table in tables:
                if table in usable:
                    counts[table] = _insert_ignore(connection, table)
        if "analysis_result" in usable:
            counts["analysis_result"] = _merge_analysis(connection)
        if "user_pref" in usable:
            before = connection.total_changes
            connection.execute(
                "INSERT OR REPLACE INTO main.user_pref (key, value) "
                "SELECT key, value FROM src.user_pref WHERE key = 'dict_search.build'"
            )
            counts["user_pref"] = connection.total_changes - before
        connection.execute("COMMIT")
        connection.execute("DETACH DATABASE src")
    except Exception:
        connection.execute("ROLLBACK")
        raise
    finally:
        connection.close()
    if not skipped:
        write_stamp(stamp_file, stamp, {"merged": counts, "skipped_groups": skipped})
    else:
        write_stamp(
            stamp_file, "", {"pending_stamp": stamp, "merged": counts, "skipped_groups": skipped}
        )
    return {
        "skipped": False,
        "stamp": stamp,
        "merged": counts,
        "skipped_groups": skipped,
        "partial": bool(skipped),
    }
