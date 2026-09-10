"""桌面 SQLite 基线：空表结构 + alembic 版本，可选把内容表从开发库拷进来（熟人内测包用）。

用法（server 目录）：
    uv run python -m scripts.build_desktop_baseline out.sqlite3 --revision <head>
    uv run python -m scripts.build_desktop_baseline out.sqlite3 --revision <head> \\
        --content-from ../data/desktop/nexus.sqlite3 --seed-media ../data/desktop/media out-media/

内容表 = 装进去就能用、与「这个人学了什么」无关的数据：ECDICT 与查词侧表、音标主档与音位卡、
CEFR-J 语法点 / 卡片 / 构式 / 概念、40 本内置公版书的正文与构式命中、考纲本的场景分组与封面、
就绪的视频连字幕与学习单元、按指纹寻址的 AI / 翻译产物（字幕译文、词组、词卡释义）。
学习进度、收藏、凭据、模型部署、任务台账、生成图片一律不拷——那是 scholar 自己的。
"""

from __future__ import annotations

import argparse
import asyncio
import shutil
import sqlite3
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from domain.models import Base

# 整表拷贝：没有 user 列、也不引用用户对象的内容表
CONTENT_TABLES = (
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
# 按内置书过滤的那几张：article 也可能属于用户的场景本（deck_id），只认 book.source='builtin'
BUILTIN_BOOK_WHERE = "id IN (SELECT id FROM src.book WHERE source = 'builtin')"
BUILTIN_ARTICLE_WHERE = "book_id IN (SELECT id FROM src.book WHERE source = 'builtin')"
BUILTIN_PARAGRAPH_WHERE = (
    "article_id IN (SELECT a.id FROM src.article a JOIN src.book b ON b.id = a.book_id "
    "WHERE b.source = 'builtin')"
)
KEPT_VIDEO_WHERE = "status = 'ready' AND duration_s >= 15"
KEPT_TRACK_WHERE = (
    "track_id IN (SELECT t.id FROM src.subtitle_track t JOIN src.video v ON v.id = t.video_id "
    "WHERE v.status = 'ready' AND v.duration_s >= 15)"
)
FILTERED_TABLES: tuple[tuple[str, str], ...] = (
    ("book", BUILTIN_BOOK_WHERE),
    ("article", BUILTIN_ARTICLE_WHERE),
    ("paragraph", BUILTIN_PARAGRAPH_WHERE),
    ("sentence", f"paragraph_id IN (SELECT id FROM src.paragraph WHERE {BUILTIN_PARAGRAPH_WHERE})"),
    (
        "grammar_occurrence",
        "source_kind = 'article' AND paragraph_id IN "
        f"(SELECT id FROM src.paragraph WHERE {BUILTIN_PARAGRAPH_WHERE})",
    ),
    # 视频库整体随包（scholar 决策）：只收就绪且不是几秒钟测试片的；字幕 / 句层 / 学习单元 / 复核问题跟着走
    ("video", KEPT_VIDEO_WHERE),
    ("subtitle_track", f"video_id IN (SELECT id FROM src.video WHERE {KEPT_VIDEO_WHERE})"),
    ("subtitle_cue", KEPT_TRACK_WHERE),
    ("subtitle_sentence", KEPT_TRACK_WHERE),
    ("study_unit", KEPT_TRACK_WHERE),
    ("subtitle_issue", f"video_id IN (SELECT id FROM src.video WHERE {KEPT_VIDEO_WHERE})"),
    # AI / 翻译产物按内容指纹寻址（ADR-006）：字幕译文、视频词组、词卡释义都在这里，
    # 不带的话朋友没密钥就看不到中文字幕。只剔掉口语陪练的教练反馈（那是对话记录）
    ("analysis_result", "kind <> 'talk_coach'"),
    # 查词索引的构建元数据要跟着侧表走，其它偏好是 scholar 的
    ("user_pref", "key = 'dict_search.build'"),
)
# 内置书、音位示范音、朗读缓存所在的媒体目录；本封面按 deck_cover.storage_key 逐个拷，
# 视频按保留下来的 video 行逐个拷（媒体目录里还有测试片与别的东西）
MEDIA_SEED_DIRS = ("books", "covers", "phoneme_ipa", "phoneme_demo", "tts")


async def build(destination: Path, revision: str) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.unlink(missing_ok=True)
    engine = create_async_engine(f"sqlite+aiosqlite:///{destination}")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
            await connection.execute(
                text(
                    "CREATE TABLE IF NOT EXISTS alembic_version (version_num VARCHAR(32) NOT NULL)"
                )
            )
            await connection.execute(
                text("INSERT INTO alembic_version (version_num) VALUES (:revision)"),
                {"revision": revision},
            )
            await connection.execute(text("PRAGMA foreign_key_check"))
    finally:
        await engine.dispose()


def _columns(connection: sqlite3.Connection, schema: str, table: str) -> list[str]:
    rows = connection.execute(f"PRAGMA {schema}.table_info({table})").fetchall()
    return [str(row[1]) for row in rows]


def copy_content(destination: Path, source: Path) -> dict[str, int]:
    """ATTACH 开发库，按目标表的列名拷（两边列序可能不同：迁移加的列排在末尾，create_all 按模型序）。"""
    if not source.is_file():
        raise SystemExit(f"内容库不存在：{source}")
    counts: dict[str, int] = {}
    connection = sqlite3.connect(destination)
    try:
        connection.execute("ATTACH DATABASE ? AS src", (str(source),))
        plan: list[tuple[str, str | None]] = [(t, None) for t in CONTENT_TABLES] + list(
            FILTERED_TABLES
        )
        for table, where in plan:
            target_cols = _columns(connection, "main", table)
            source_cols = set(_columns(connection, "src", table))
            missing = [c for c in target_cols if c not in source_cols]
            if missing:
                raise SystemExit(f"内容库的 {table} 缺列 {missing}：先把开发库迁到 head")
            cols = ", ".join(target_cols)
            sql = f"INSERT INTO main.{table} ({cols}) SELECT {cols} FROM src.{table}"
            if where:
                sql += f" WHERE {where}"
            cursor = connection.execute(sql)
            counts[table] = cursor.rowcount
            connection.commit()
        bad = connection.execute("PRAGMA foreign_key_check").fetchall()
        if bad:
            raise SystemExit(f"拷完外键不闭合：{bad[:5]}")
        connection.execute("DETACH DATABASE src")
        connection.execute("VACUUM")
    finally:
        connection.close()
    return counts


def seed_media(destination: Path, media_root: Path, dest: Path) -> list[str]:
    """内置书 / 封面 / 音位示范音整目录拷，本封面按表里的 key 逐个拷；返回拷了哪些相对路径。"""
    copied: list[str] = []
    dest.mkdir(parents=True, exist_ok=True)
    for name in MEDIA_SEED_DIRS:
        src_dir = media_root / name
        if not src_dir.is_dir():
            continue
        shutil.copytree(src_dir, dest / name, dirs_exist_ok=True)
        copied.append(f"{name}/")
    connection = sqlite3.connect(destination)
    try:
        keys = [str(k) for (k,) in connection.execute("SELECT storage_key FROM deck_cover")]
    finally:
        connection.close()
    for key in keys:
        src_file = media_root / key
        if not src_file.is_file():
            raise SystemExit(f"本封面文件不存在：{src_file}")
        target = dest / key
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src_file, target)
        copied.append(key)
    copied.extend(_seed_video_media(destination, media_root, dest))
    return copied


def _seed_video_media(destination: Path, media_root: Path, dest: Path) -> list[str]:
    """每条保留的视频拷正片、缩略图与同号的字幕文件（`videos/<id>.*`）。"""
    connection = sqlite3.connect(destination)
    try:
        rows = connection.execute("SELECT id, file_key, thumb_key FROM video").fetchall()
    finally:
        connection.close()
    copied: list[str] = []
    videos_dir = media_root / "videos"
    for video_id, file_key, thumb_key in rows:
        wanted = {k for k in (file_key, thumb_key) if k}
        if videos_dir.is_dir():
            wanted.update(f"videos/{p.name}" for p in videos_dir.glob(f"{video_id}.*"))
        for key in sorted(wanted):
            src_file = media_root / key
            if not src_file.is_file():
                raise SystemExit(f"视频 {video_id} 的媒体文件不存在：{src_file}")
            target = dest / key
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src_file, target)
            copied.append(key)
    return copied


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the current NEXUS desktop SQLite baseline")
    parser.add_argument("destination", type=Path)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--content-from", type=Path, help="把内容表从这个开发库拷进基线")
    parser.add_argument(
        "--seed-media",
        nargs=2,
        type=Path,
        metavar=("MEDIA_ROOT", "DEST"),
        help="把内置书 / 封面 / 音位示范音从 MEDIA_ROOT 拷到 DEST（要配合 --content-from）",
    )
    args = parser.parse_args()
    destination = args.destination.resolve()
    asyncio.run(build(destination, args.revision))
    if args.content_from is not None:
        counts = copy_content(destination, args.content_from.resolve())
        for table, n in counts.items():
            print(f"  {table}: {n}")
        print(f"内容基线 {destination.stat().st_size / 1_048_576:.0f} MB")
    if args.seed_media is not None:
        if args.content_from is None:
            raise SystemExit("--seed-media 要配合 --content-from")
        media_root, dest = (p.resolve() for p in args.seed_media)
        copied = seed_media(destination, media_root, dest)
        print(f"媒体种子 {len(copied)} 项 → {dest}")


if __name__ == "__main__":
    main()
