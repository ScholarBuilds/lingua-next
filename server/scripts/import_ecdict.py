"""导入 ECDICT 词典（sqlite release 资产）到 dict_entry 表。

用法：
    uv run python scripts/import_ecdict.py [--db 本地 stardict.db 路径]

不带参数时自动下载 ecdict-sqlite release 包（约 55MB）并解压，
缓存在 ../data/ecdict/，重跑不重复下载。
"""

import argparse
import asyncio
import sqlite3
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import asyncpg
import httpx

from app.config import get_settings

RELEASE_URL = "https://github.com/skywind3000/ECDICT/releases/download/1.0.28/ecdict-sqlite-28.zip"
CACHE_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "ecdict"
COLS = [
    "word", "phonetic", "definition", "translation", "pos",
    "collins", "oxford", "tag", "bnc", "frq", "exchange",
]


async def download(dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".part")
    print(f"下载 {RELEASE_URL} ...")
    client = httpx.AsyncClient(follow_redirects=True, timeout=120)
    async with client, client.stream("GET", RELEASE_URL) as resp:
        resp.raise_for_status()
        done = 0
        with tmp.open("wb") as f:
            async for chunk in resp.aiter_bytes(1 << 20):
                f.write(chunk)
                done += len(chunk)
                print(f"\r  {done / 1e6:.0f} MB", end="", flush=True)
    tmp.rename(dest)
    print(f"\n已保存 {dest}")


async def locate_db(args_db: Path | None) -> Path:
    if args_db:
        if not args_db.exists():
            sys.exit(f"文件不存在：{args_db}")
        return args_db
    db = CACHE_DIR / "stardict.db"
    if db.exists():
        return db
    zip_path = CACHE_DIR / "ecdict-sqlite.zip"
    if not zip_path.exists():
        await download(zip_path)
    with zipfile.ZipFile(zip_path) as zf:
        name = next(n for n in zf.namelist() if n.endswith(".db"))
        print(f"解压 {name} ...")
        zf.extract(name, CACHE_DIR)
        extracted = CACHE_DIR / name
        if extracted != db:
            extracted.rename(db)
    return db


def rows(db: Path):
    conn = sqlite3.connect(db)
    try:
        cur = conn.execute(
            "SELECT word, phonetic, definition, translation, pos,"
            " collins, oxford, tag, bnc, frq, exchange FROM stardict"
        )
        while batch := cur.fetchmany(20000):
            yield from batch
    finally:
        conn.close()


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, default=None)
    args = parser.parse_args()
    db = await locate_db(args.db)

    dsn = get_settings().database_url.replace("postgresql+asyncpg://", "postgresql://")
    pg = await asyncpg.connect(dsn)
    try:
        await pg.execute("TRUNCATE dict_entry")
        seen: set[str] = set()
        batch: list[tuple] = []
        total = 0

        async def flush() -> None:
            nonlocal total, batch
            if batch:
                await pg.copy_records_to_table("dict_entry", records=batch, columns=COLS)
                total += len(batch)
                print(f"\r已导入 {total}", end="", flush=True)
                batch = []

        for row in rows(db):
            word = (row[0] or "").strip()
            if not word or len(word) > 128 or word in seen:
                continue
            seen.add(word)
            batch.append((word, *row[1:]))
            if len(batch) >= 20000:
                await flush()
        await flush()
        count = await pg.fetchval("SELECT count(*) FROM dict_entry")
        print(f"\n完成：dict_entry 共 {count} 行")
    finally:
        await pg.close()


if __name__ == "__main__":
    asyncio.run(main())
