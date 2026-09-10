"""查词侧表入库（FR-508~510）：dict_head 联想 / dict_gloss 汉英反查 / dict_related 同义关系。

用法（server 目录；桌面档要带 LINGUA_DATABASE_URL 指到 data/desktop/nexus.sqlite3）：
    uv run python scripts/seed_dict_search.py                      # 三张表都重建
    uv run python scripts/seed_dict_search.py --index              # 只重建 dict_head + dict_gloss
    uv run python scripts/seed_dict_search.py --related --wordnet-download   # 只重建同义关系，缺语料先下载

三张表都是导出物，整表 DELETE 后重灌（SQLite 没有 TRUNCATE）。重建期间 /dict/search 回 ready=false。
跑之前 API 别开 --reload。
"""

import argparse
import asyncio
import io
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import delete, insert, select  # noqa: E402

from app.db import SessionFactory, engine  # noqa: E402
from domain import dict_search  # noqa: E402
from domain.dict_search_build import (  # noqa: E402
    COMMON_FRQ_MAX,
    TIER_LEARNER,
    EntryRow,
    build_related,
    gloss_rows,
    head_row,
    pos_weights,
)
from domain.models import DictEntry, DictGloss, DictHead, DictRelated, WordPhoneme  # noqa: E402

PAGE = 20_000
BATCH = 3_000  # 9 列 × 3000 = 27000 个绑定变量，低于 SQLite 的 32766 上限
COMMIT_EVERY = 60_000

# nltk 自带的 downloader 走重定向到 CDN 的地址，受限网络下直接失败；拉官方仓库的原始 zip，
# 落盘路径与 downloader 一致（同 seed_phonemes.py）
NLTK_BASE = "https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages"
WORDNET_PKG = ("corpora/wordnet", "corpora")


def ensure_wordnet(download: bool) -> None:
    import nltk

    try:
        nltk.data.find(WORDNET_PKG[0])
        return
    except LookupError:
        if not download:
            raise SystemExit(
                "缺 WordNet 语料：加 --wordnet-download 从 nltk_data 仓库拉一次（约 10 MB）"
            ) from None
    root = Path(nltk.data.path[0] if nltk.data.path else Path.home() / "nltk_data")
    print(f"下载 nltk 语料 {WORDNET_PKG[0]} …")
    req = urllib.request.Request(
        f"{NLTK_BASE}/{WORDNET_PKG[0]}.zip", headers={"User-Agent": "lingua-next/1.0"}
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        blob = resp.read()
    dest = root / WORDNET_PKG[1]
    dest.mkdir(parents=True, exist_ok=True)
    zipfile.ZipFile(io.BytesIO(blob)).extractall(dest)


async def load_common_and_phon(session) -> tuple[set[str], dict[str, str]]:
    """常用单 token 词集合（给词组判层）+ word_phoneme 的标准 IPA。"""
    common: set[str] = set()
    last = ""
    while True:
        stmt = (
            select(DictEntry.word, DictEntry.frq, DictEntry.tag)
            .where(DictEntry.word > last)
            .order_by(DictEntry.word)
            .limit(PAGE)
        )
        rows = (await session.execute(stmt)).all()
        if not rows:
            break
        for word, frq, tag in rows:
            if " " not in word and (
                (frq or 0) > 0 and frq <= COMMON_FRQ_MAX or (tag or "").strip()
            ):
                common.add(word.lower())
        last = rows[-1][0]
    phon: dict[str, str] = {}
    rows = await session.execute(select(WordPhoneme.word, WordPhoneme.ipa_uk, WordPhoneme.ipa_us))
    for word, uk, us in rows:
        ipa = uk or us
        if ipa:
            phon[word.lower()] = ipa
    return common, phon


async def _flush(session, table, rows: list[dict]) -> None:
    for i in range(0, len(rows), BATCH):
        await session.execute(insert(table), rows[i : i + BATCH])
    rows.clear()


async def build_index(session, common: set[str], phon: dict[str, str]) -> tuple[int, int, int]:
    """一遍扫 dict_entry，同时产出 dict_head 与 dict_gloss。按主键分页，不开流式游标。"""
    await session.execute(delete(DictGloss))
    await session.execute(delete(DictHead))
    await session.commit()
    heads: list[dict] = []
    glosses: list[dict] = []
    n_head = n_gloss = n_seen = 0
    since_commit = 0
    last = ""
    started = time.monotonic()
    cols = (
        DictEntry.word,
        DictEntry.translation,
        DictEntry.frq,
        DictEntry.bnc,
        DictEntry.tag,
        DictEntry.collins,
        DictEntry.oxford,
        DictEntry.exchange,
        DictEntry.phonetic,
    )
    while True:
        stmt = select(*cols).where(DictEntry.word > last).order_by(DictEntry.word).limit(PAGE)
        rows = (await session.execute(stmt)).all()
        if not rows:
            break
        for raw in rows:
            row = EntryRow(*raw)
            head = head_row(row, common, phon)
            if head is None:
                continue
            heads.append(head)
            glosses.extend(gloss_rows(head, row.translation))
            if len(heads) >= BATCH:
                n_head += len(heads)
                n_gloss += len(glosses)
                since_commit += len(heads)
                await _flush(session, DictHead, heads)
                await _flush(session, DictGloss, glosses)
            if since_commit >= COMMIT_EVERY:
                await session.commit()
                since_commit = 0
        n_seen += len(rows)
        last = rows[-1][0]
        print(
            f"  扫描 {n_seen} 行 · head {n_head} · gloss {n_gloss} · {time.monotonic() - started:.0f}s",
            end="\r",
        )
    n_head += len(heads)
    n_gloss += len(glosses)
    await _flush(session, DictHead, heads)
    await _flush(session, DictGloss, glosses)
    await session.commit()
    print()
    return n_seen, n_head, n_gloss


async def build_related_table(session) -> int:
    from nltk.corpus import wordnet as wn

    wn.ensure_loaded()
    rows = (
        await session.execute(
            select(DictHead.word, DictHead.lc).where(DictHead.tier == TIER_LEARNER)
        )
    ).all()
    tier1 = {lc for _, lc in rows}
    # 词性占比给义项重排用：按词分批查，别把六万个词塞进一个 IN
    pos_of: dict[str, dict[str, int]] = {}
    words = [word for word, _ in rows]
    for i in range(0, len(words), 500):
        chunk = words[i : i + 500]
        for word, pos in (
            await session.execute(
                select(DictEntry.word, DictEntry.pos).where(DictEntry.word.in_(chunk))
            )
        ).all():
            if pos:
                pos_of[word.lower()] = pos_weights(pos)
    print(f"  WordNet 遍历 {len(tier1)} 个学习者层词 …")
    related = build_related(tier1, wn, pos_of)
    count = len(related)
    await session.execute(delete(DictRelated))
    await _flush(session, DictRelated, related)
    await session.commit()
    return count


async def main(args: argparse.Namespace) -> None:
    do_index = args.index or not args.related
    do_related = args.related or not args.index
    if do_related:
        ensure_wordnet(args.wordnet_download)
    meta: dict = {}
    async with SessionFactory() as session:
        existing = await dict_search.build_meta(session)
        meta.update(existing)
        started = time.monotonic()
        if do_index:
            print("准备常用词集合与音标 …")
            common, phon = await load_common_and_phon(session)
            print(f"  常用词 {len(common)} · 音标 {len(phon)}")
            n_seen, n_head, n_gloss = await build_index(session, common, phon)
            meta.update({"ecdict_rows": n_seen, "head_rows": n_head, "gloss_rows": n_gloss})
            print(
                f"dict_head {n_head} 行 · dict_gloss {n_gloss} 行 · {time.monotonic() - started:.0f}s"
            )
        if do_related:
            n_related = await build_related_table(session)
            meta.update({"related_rows": n_related, "wordnet": "3.0"})
            print(f"dict_related {n_related} 行 · {time.monotonic() - started:.0f}s")
        meta["schema"] = 1
        await dict_search.write_build_meta(session, meta)
        await session.commit()
    await engine.dispose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="重建查词侧表")
    parser.add_argument("--index", action="store_true", help="只重建 dict_head + dict_gloss")
    parser.add_argument("--related", action="store_true", help="只重建 dict_related（WordNet）")
    parser.add_argument("--all", action="store_true", help="全部重建（默认）")
    parser.add_argument("--wordnet-download", action="store_true", help="缺 WordNet 语料时下载")
    asyncio.run(main(parser.parse_args()))
