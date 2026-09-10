"""内置公版书入库（模块 02 FR-368~371）：下载 Gutenberg epub → 落库 → 入队解析。

用法（server 目录）：
    uv run python scripts/seed_books.py                  # 全部 40 本，跳过已入库的
    uv run python scripts/seed_books.py --only alice-in-wonderland,moby-dick
    uv run python scripts/seed_books.py --difficulty starter
    uv run python scripts/seed_books.py --verify         # 先拉官方目录复核 pg_id 再入库
    uv run python scripts/seed_books.py --refresh        # 已入库的也重下重解析

幂等：按 external_id（Gutenberg 电子书号）判定是否已入库。中断后重跑只补缺的。
下载与入库分离：文件先落 media_root，落库后才入队 parse_book，
解析失败的书 status=failed 保留原件，重跑脚本会跳过（除非 --refresh）。
"""

import argparse
import asyncio
import csv
import io
import re
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select  # noqa: E402

from app.config import get_settings  # noqa: E402
from app.db import SessionFactory  # noqa: E402
from app.queue import get_queue  # noqa: E402
from domain.builtin_books import CATALOG, BuiltinBook  # noqa: E402
from domain.models import Book  # noqa: E402

CATALOG_URL = "https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv"
UA = "lingua-next/1.0 (personal english learning app; contact: local)"
TIMEOUT = 120


def _fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return resp.read()


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9 ]", "", s.lower()).strip()


def verify_catalog() -> list[str]:
    """拉 Gutenberg 官方全量目录，核对清单里每条 pg_id 的标题与作者姓氏。

    返回不匹配的说明列表（空列表表示全部通过）。
    """
    print(f"下载官方目录 {CATALOG_URL} …")
    raw = _fetch(CATALOG_URL).decode("utf-8", errors="replace")
    rows = {r["Text#"]: r for r in csv.DictReader(io.StringIO(raw))}
    print(f"目录条目 {len(rows)}，开始核对 {len(CATALOG)} 本")
    problems: list[str] = []
    for b in CATALOG:
        row = rows.get(str(b.pg_id))
        if row is None:
            problems.append(f"{b.slug}: pg_id={b.pg_id} 不在目录中")
            continue
        surname = (b.author_key or b.author.split()[-1]).lower()
        title_ok = _norm(b.title)[:24] in _norm(row["Title"]) or _norm(row["Title"])[:24] in _norm(
            b.title
        )
        author_ok = surname in row["Authors"].lower()
        if not (title_ok and author_ok):
            problems.append(
                f"{b.slug}: pg_id={b.pg_id} 实为《{row['Title'][:48]}》/ {row['Authors'][:40]}"
            )
    return problems


async def seed_one(book: BuiltinBook, *, refresh: bool) -> str:
    """单本入库，返回状态词：skip | ok | fail"""
    settings = get_settings()
    async with SessionFactory() as session:
        existing = (
            await session.execute(select(Book).where(Book.external_id == str(book.pg_id)))
        ).scalar_one_or_none()
        if existing is not None and not refresh:
            return "skip"

    file_key = f"books/builtin-{book.slug}.epub"
    dest = Path(settings.media_root) / file_key
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not dest.exists() or refresh:
        try:
            data = _fetch(book.url)
        except Exception as exc:
            print(f"  ✗ {book.slug}: 下载失败 {type(exc).__name__}: {exc}")
            return "fail"
        if len(data) < 4096 or not data.startswith(b"PK"):
            print(f"  ✗ {book.slug}: 下载内容不是 epub（{len(data)} bytes）")
            return "fail"
        dest.write_bytes(data)

    async with SessionFactory() as session:
        row = (
            await session.execute(select(Book).where(Book.external_id == str(book.pg_id)))
        ).scalar_one_or_none()
        if row is None:
            row = Book(slug=book.slug, external_id=str(book.pg_id))
            session.add(row)
        row.title = book.title
        row.author = book.author
        row.source = "builtin"
        row.file_key = file_key
        row.difficulty = book.difficulty
        row.tags = list(book.tags)
        row.blurb = book.blurb
        row.status = "pending"
        row.error = None
        await session.commit()
        book_id = row.id

    queue = await get_queue()
    # _job_id 去重：同一本重复触发时 arq 返回 None，不会排两次解析
    await queue.enqueue_job("parse_book", book_id, _job_id=f"parse_book:{book_id}")
    print(f"  ✓ {book.slug} → book#{book_id} ({dest.stat().st_size // 1024} KB) 已入队解析")
    return "ok"


async def main() -> int:
    ap = argparse.ArgumentParser(description="内置公版书入库")
    ap.add_argument("--only", help="逗号分隔的 slug 子集")
    ap.add_argument("--difficulty", choices=["starter", "core", "deep"], help="只入某一档")
    ap.add_argument("--verify", action="store_true", help="先拉官方目录复核 pg_id")
    ap.add_argument("--refresh", action="store_true", help="已入库的也重下重解析")
    args = ap.parse_args()

    if args.verify:
        problems = verify_catalog()
        if problems:
            print("\n目录核对未通过：")
            for p in problems:
                print("  -", p)
            return 2
        print("目录核对通过：全部 pg_id 与标题作者一致\n")

    picked = list(CATALOG)
    if args.difficulty:
        picked = [b for b in picked if b.difficulty == args.difficulty]
    if args.only:
        wanted = {s.strip() for s in args.only.split(",") if s.strip()}
        picked = [b for b in picked if b.slug in wanted]
        missing = wanted - {b.slug for b in picked}
        if missing:
            print(f"清单中没有这些 slug：{', '.join(sorted(missing))}")
            return 2
    if not picked:
        print("没有匹配的书目")
        return 2

    print(f"准备处理 {len(picked)} 本（refresh={args.refresh}）")
    tally = {"ok": 0, "skip": 0, "fail": 0}
    for b in picked:
        tally[await seed_one(b, refresh=args.refresh)] += 1

    print(f"\n完成：入队 {tally['ok']} · 跳过 {tally['skip']} · 失败 {tally['fail']}")
    if tally["ok"]:
        print("解析在 arq worker 里异步进行，用 /books 或书架页看 status 变 ready")
        print("解析完成后跑封面体检：uv run python scripts/fetch_covers.py --audit")
    return 1 if tally["fail"] else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
