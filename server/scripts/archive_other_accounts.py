"""迁移 d3f1a7c2e9b4 之前跑：把非 owner 账号的学习记录导出到 归档/ 再删掉（CR-006 D8、Q3）。

owner 取最早的 admin 账号，与 b7d3e5f1a920 回填时的判定一致。只在旧 schema 上有意义——
user_account 表一旦被迁移删掉，这个脚本就没有东西可查了。

    uv run python scripts/archive_other_accounts.py            # 只看有没有、有多少
    uv run python scripts/archive_other_accounts.py --apply    # 导出并删除
"""

import argparse
import asyncio
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import inspect, text  # noqa: E402
from sqlalchemy.ext.asyncio import create_async_engine  # noqa: E402

from app.config import get_settings  # noqa: E402

OWNER_SQL = """
SELECT ua.id FROM user_account ua
JOIN user_role ur ON ur.user_id = ua.id
JOIN role r ON r.id = ur.role_id
WHERE r.code = 'admin' AND ua.deleted_at IS NULL
ORDER BY ua.created_at LIMIT 1
"""
ARCHIVE_DIR = Path(__file__).resolve().parents[2] / "归档"


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="导出并删除；不带只统计")
    args = ap.parse_args()

    engine = create_async_engine(get_settings().database_url)
    async with engine.begin() as conn:
        owner = (await conn.execute(text(OWNER_SQL))).scalar()
        if owner is None:
            print("找不到 admin 账号，无法判定 owner", file=sys.stderr)
            return 1

        def _tables(sync_conn):
            insp = inspect(sync_conn)
            return [
                t
                for t in insp.get_table_names()
                if t not in {"user_account", "user_role", "auth_session", "verification_token", "audit_event"}
                and any(c["name"] == "user_id" for c in insp.get_columns(t))
            ]

        tables = await conn.run_sync(_tables)
        dump: dict[str, list[dict]] = {}
        for table in tables:
            rows = (
                await conn.execute(
                    text(f"SELECT * FROM {table} WHERE user_id IS NOT NULL AND user_id <> :o"),
                    {"o": owner},
                )
            ).mappings().all()
            if rows:
                dump[table] = [dict(r) for r in rows]
        total = sum(len(v) for v in dump.values())
        print(f"owner={owner} 其它账号的记录：{total} 行，涉及 {len(dump)} 张表")
        for table, rows in dump.items():
            print(f"  {table}: {len(rows)}")
        if not args.apply or total == 0:
            return 0

        ARCHIVE_DIR.mkdir(exist_ok=True)
        stamp = datetime.now(UTC).strftime("%Y-%m-%d")
        out = ARCHIVE_DIR / f"{stamp}-非owner账号学习记录.json"
        out.write_text(json.dumps(dump, ensure_ascii=False, default=str, indent=1), encoding="utf-8")
        for table in dump:
            await conn.execute(
                text(f"DELETE FROM {table} WHERE user_id IS NOT NULL AND user_id <> :o"), {"o": owner}
            )
        print(f"已导出到 {out} 并删除")
    await engine.dispose()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
