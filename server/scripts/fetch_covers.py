"""内置书封面补齐（FR-387）：给封面不合格的书从 Open Library 换成真实历史书封。

用法（server 目录）：
    uv run python scripts/fetch_covers.py --audit                # 只体检，不改动
    uv run python scripts/fetch_covers.py --ids 45,43,36         # 换指定几本
    uv run python scripts/fetch_covers.py --ids 45 --dry-run     # 下载并校验但不落库

Gutenberg 的 epub 里多数带真实书封（扫描件，普遍 800px 以上），少数没有的会塞一张
自动生成的抽象几何图（大色块 + 三角形，带 Project Gutenberg 字样）——那种图不是封面，
本脚本把它们换掉。

选版规则：Open Library 按 `书名 + 作者` 搜，标题主干必须对得上（排掉合订本与改写本），
在此基础上取 edition_count 最高的条目——版次最多的通常就是这本书最广为人知的那版。
下载后做真实性校验（JPEG 头 / 尺寸 / 非纯色），不合格不落库，宁可留着旧的。
"""

import argparse
import asyncio
import io
import json
import re
import sys
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PIL import Image  # noqa: E402
from sqlalchemy import select  # noqa: E402

from app.config import get_settings  # noqa: E402
from app.db import SessionFactory  # noqa: E402
from domain.builtin_books import CATALOG  # noqa: E402
from domain.models import Book  # noqa: E402

UA = "lingua-next/1.0 (personal english learning app)"
SEARCH_URL = "https://openlibrary.org/search.json"
COVER_URL = "https://covers.openlibrary.org/b/id/{cover_id}-L.jpg?default=false"
TIMEOUT = 45

# 封面体检门槛
MIN_WIDTH = 300
MIN_HEIGHT = 420
# 图片下半部分的最大单色占比上限。Gutenberg 自动生成的封面下半是一整块纯色底
# 加几个几何形状，主色必然占大头；扫描的真书封是连续色调，不会有单色占这么多。
# 实测 41 本：8 张生成图落在 58.5%-76.5%，33 张真封面最高只有 30.9%，取 45% 留足边际。
# （曾用"色数"做判据，但黑白铜版画封面天然色少——格列佛游记 256 色却是真书封，误判了。）
MAX_FLAT_RATIO = 0.45
# 每本最多试几个候选封面（Open Library 头名也可能是小图或生成图）
MAX_TRIES = 6


def _fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return resp.read()


STOP = {"the", "a", "an", "of", "and", "s"}


def _words(title: str) -> list[str]:
    """标题 → 实词序列。虚词与撇号一并剔掉，两边用同一口径才比得了。

    （首版 `_stem` 剔虚词而 `_norm` 不剔，`"heart darkness" in "heart of darkness"`
    永远为假，把 Heart of Darkness / The Art of War 这些明明有封面的书全滤没了。）
    """
    flat = re.sub(r"[^a-z0-9 ]", " ", title.lower()).split(" or ")[0]
    # 词尾 s 一律剥掉：Grimms' / Grimm's 归一化后撇号位置不同（grimms vs grimm），
    # 复数与所有格也才对得上（fables↔fable、leagues↔league）
    return [w.rstrip("s") or w for w in flat.split() if w and w not in STOP]


def _matches(want: str, got: str) -> bool:
    """候选标题是否就是这本书：目标前 3 个实词必须是候选实词序列的**开头**。

    只要求"按序出现在任意位置"会放进 The Lost Art of War 冒充 The Art of War——
    真书名总是从头开始的，后缀（副标题、"and Good Wives"）才允许多出来。
    """
    a, b = _words(want)[:3], _words(got)
    return bool(a) and b[: len(a)] == a


def flat_ratio(im: Image.Image) -> float:
    """图片下半部分里最大单色的像素占比。"""
    small = im.resize((160, 220))
    lower = list(small.crop((0, 110, 160, 220)).getdata())
    return Counter(lower).most_common(1)[0][1] / len(lower)


def inspect(data: bytes) -> tuple[bool, str, tuple[int, int], float]:
    """封面体检：返回 (是否合格, 原因, 尺寸, 下半最大单色占比)。"""
    try:
        im = Image.open(io.BytesIO(data)).convert("RGB")
    except Exception as exc:
        return False, f"不是可解析的图片：{type(exc).__name__}", (0, 0), 0.0
    w, h = im.size
    flat = flat_ratio(im)
    if w < MIN_WIDTH or h < MIN_HEIGHT:
        return False, f"尺寸过小 {w}x{h}", (w, h), flat
    if flat > MAX_FLAT_RATIO:
        return False, f"下半是整块纯色（{flat:.0%}），是自动生成的占位图不是书封", (w, h), flat
    return True, "合格", (w, h), flat


def search_covers(title: str, author: str) -> list[tuple[int, str, int]]:
    """返回候选 [(cover_id, 命中标题, edition_count)]，按版次降序。

    返回列表而不是单个：Open Library 的头名候选也可能是张生成图或 128px 的小图，
    只试一个就放弃等于白扔掉后面那些能用的。
    """
    q = urllib.parse.urlencode(
        {
            "title": title,
            "author": author,
            "limit": 10,
            "fields": "title,author_name,cover_i,edition_count,first_publish_year",
        }
    )
    try:
        payload = json.loads(_fetch(f"{SEARCH_URL}?{q}"))
    except Exception as exc:
        print(f"    搜索失败 {type(exc).__name__}: {exc}")
        return []
    hits = []
    for doc in payload.get("docs", []):
        if not doc.get("cover_i"):
            continue
        raw = doc.get("title", "")
        # 书名要对得上；带斜杠的是合订本（"Wuthering Heights / Agnes Grey"）一律排掉
        if "/" in raw or not _matches(title, raw):
            continue
        hits.append(doc)
    hits.sort(key=lambda d: d.get("edition_count", 0), reverse=True)
    return [(d["cover_i"], d["title"], d.get("edition_count", 0)) for d in hits]


async def audit() -> list[tuple[int, str, bool, str]]:
    settings = get_settings()
    root = Path(settings.media_root)
    out = []
    async with SessionFactory() as session:
        books = (
            (await session.execute(select(Book).order_by(Book.id))).scalars().all()
        )
    for b in books:
        if not b.cover_key:
            out.append((b.id, b.title, False, "没有封面"))
            continue
        path = root / b.cover_key
        if not path.exists():
            out.append((b.id, b.title, False, "封面文件缺失"))
            continue
        ok, why, size, flat = inspect(path.read_bytes())
        out.append((b.id, b.title, ok, f"{why}｜{size[0]}x{size[1]}｜纯色占比 {flat:.0%}"))
    return out


async def replace_cover(book_id: int, *, dry_run: bool) -> bool:
    settings = get_settings()
    async with SessionFactory() as session:
        book = await session.get(Book, book_id)
        if book is None:
            print(f"  ✗ book#{book_id} 不存在")
            return False
        title, author = book.title, book.author or ""
        external = book.external_id

    # 用清单里的规范书名去搜，落库标题可能带副标题（"Frankenstein; or, the modern..."）
    entry = next((b for b in CATALOG if str(b.pg_id) == str(external)), None)
    q_title = (entry.search_title or entry.title) if entry else title
    q_author = entry.author if entry else author

    print(f"  book#{book_id} 《{q_title}》/ {q_author}")
    candidates = search_covers(q_title, q_author)
    if not candidates:
        print("    Open Library 没有匹配的封面，保留原图")
        return False

    data = None
    for cover_id, matched, editions in candidates[:MAX_TRIES]:
        try:
            blob = _fetch(COVER_URL.format(cover_id=cover_id))
        except Exception as exc:
            print(f"    cover_i={cover_id} 下载失败 {type(exc).__name__}，试下一个")
            continue
        ok, why, size, flat = inspect(blob)
        if not ok:
            print(f"    cover_i={cover_id} 不合格（{why}），试下一个")
            continue
        print(f"    ✓ cover_i={cover_id}（{matched}，{editions} 个版次）{size[0]}x{size[1]}，纯色占比 {flat:.0%}")
        data = blob
        break

    if data is None:
        print(f"    {len(candidates[:MAX_TRIES])} 个候选都不合格，保留原图")
        return False

    if dry_run:
        print("    dry-run：不落库")
        return True

    key = f"covers/{book_id}.img"
    dest = Path(settings.media_root) / key
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    async with SessionFactory() as session:
        book = await session.get(Book, book_id)
        book.cover_key = key
        await session.commit()
    print(f"    已替换 → {key}")
    return True


async def main() -> int:
    ap = argparse.ArgumentParser(description="内置书封面补齐")
    ap.add_argument("--audit", action="store_true", help="只体检全部封面，不改动")
    ap.add_argument("--ids", help="逗号分隔的 book id，替换这几本的封面")
    ap.add_argument("--dry-run", action="store_true", help="下载校验但不落库")
    args = ap.parse_args()

    if args.audit or not args.ids:
        rows = await audit()
        bad = [r for r in rows if not r[2]]
        print(f"{'id':>3}  {'状态':<4}  书名 / 详情")
        for bid, title, ok, why in rows:
            print(f"{bid:>3}  {'合格' if ok else '不合格':<4}  {title[:34]:34} {why}")
        print(f"\n合计 {len(rows)} 本，不合格 {len(bad)} 本")
        if bad:
            print(f"替换命令：uv run python scripts/fetch_covers.py --ids {','.join(str(r[0]) for r in bad)}")
        return 0

    ids = [int(x) for x in args.ids.split(",") if x.strip()]
    print(f"准备替换 {len(ids)} 本封面（dry_run={args.dry_run}）")
    done = 0
    for bid in ids:
        if await replace_cover(bid, dry_run=args.dry_run):
            done += 1
    print(f"\n完成：成功 {done} / {len(ids)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
