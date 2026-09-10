"""构式规则入库 + 自有语料扫描（FR-401）。

用法（server 目录）：
    uv run python scripts/scan_grammar.py --rules            # 只把 55 条规则入库并自检
    uv run python scripts/scan_grammar.py --scan             # 扫书库与字幕
    uv run python scripts/scan_grammar.py --scan --limit 200 # 先小批量试
    uv run python scripts/scan_grammar.py --check

这是模块 14 差异化最强的一块：用户点一个语法点，能看到「你上周读的那本书第 3 章有
7 句用了这个结构」，点进去跳原文，带 TTS、带词级对齐、带现成的语法弹窗（FR-401b）。
任何通用语法 App 都做不到——因为它们没有用户自己的语料。
"""

import argparse
import asyncio
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import func, select, text  # noqa: E402

from app.db import SessionFactory  # noqa: E402
from domain.grammar_rules import RULES  # noqa: E402
from domain.models import (  # noqa: E402
    Article,
    GrammarConstruction,
    GrammarOccurrence,
    GrammarPoint,
    Paragraph,
    SubtitleSentence,
)
from domain.syntax import build_matcher, get_nlp  # noqa: E402

# 每个 (构式, 素材) 最多留这么多出现：imperative 这类高频构式一本书能命中几千句，
# 全存下来既没有教学价值也拖慢查询。达到上限会在日志里报出来，不静默截断
MAX_PER_SOURCE = 30
PIPE_BATCH = 200
INSERT_BATCH = 2000


async def seed_rules() -> None:
    """规则入库并按 shorthand_code 绑语法点。绑不上的显式报出来。"""
    async with SessionFactory() as s:
        codes = dict(
            (await s.execute(select(GrammarPoint.shorthand_code, GrammarPoint.id))).all()
        )
        # 精确码优先，找不到就按同前缀（去掉最后一段）匹配第一个
        by_prefix: dict[str, int] = {}
        for code, pid in codes.items():
            by_prefix.setdefault(code.rsplit(".", 1)[0], pid)
            by_prefix.setdefault(code.split(".")[0], pid)

        rows, unbound = [], []
        for r in RULES:
            pid = codes.get(r.point_code) or by_prefix.get(r.point_code)
            if pid is None:
                pid = by_prefix.get(r.point_code.rsplit(".", 1)[0]) or by_prefix.get(
                    r.point_code.split(".")[0]
                )
            if pid is None:
                unbound.append((r.key, r.point_code))
            rows.append(
                {
                    "key": r.key,
                    "grammar_point_id": pid,
                    "description": r.description,
                    "pattern": r.pattern,
                    "enabled": True,
                }
            )
        await s.execute(text("TRUNCATE TABLE grammar_construction RESTART IDENTITY CASCADE"))
        await s.execute(GrammarConstruction.__table__.insert(), rows)
        await s.commit()
    print(f"构式规则 {len(rows)} 条入库")
    if unbound:
        print(f"  ⚠ 未绑到语法点（{len(unbound)}）：{unbound}")
    else:
        print("  全部绑定到 CEFR-J 语法点")


def selftest() -> list[str]:
    """每条规则必须命中自己的例句。规则写错了在这里就该炸，不该等到扫语料。"""
    bad = []
    for r in RULES:
        m = build_matcher({r.key: r.pattern})
        from domain.syntax import match_constructions

        if not any(h["key"] == r.key for h in match_constructions(r.example, m)):
            bad.append(r.key)
    return bad


async def _load_texts(limit: int | None) -> list[tuple]:
    """待扫文本：(source_kind, source_id, paragraph_id, sentence_id, text)。"""
    async with SessionFactory() as s:
        para_stmt = (
            select(Paragraph.id, Paragraph.article_id, Paragraph.text)
            .join(Article, Article.id == Paragraph.article_id)
            .where(Paragraph.kind == "text")
            .order_by(Paragraph.id)
        )
        if limit:
            para_stmt = para_stmt.limit(limit)
        paras = (await s.execute(para_stmt)).all()
        sub_stmt = select(SubtitleSentence.id, SubtitleSentence.track_id, SubtitleSentence.text)
        if limit:
            sub_stmt = sub_stmt.limit(limit)
        subs = (await s.execute(sub_stmt)).all()
    out: list[tuple] = [("article", a, p, None, t) for p, a, t in paras if t and t.strip()]
    out += [("subtitle", tr, None, sid, t) for sid, tr, t in subs if t and t.strip()]
    return out


async def scan(limit: int | None) -> None:
    bad = selftest()
    if bad:
        print(f"规则自检未通过，先修规则再扫：{bad}")
        sys.exit(1)

    async with SessionFactory() as s:
        cons = (
            await s.execute(
                select(GrammarConstruction).where(GrammarConstruction.enabled)
            )
        ).scalars().all()
    if not cons:
        print("构式规则表为空，先跑 --rules")
        sys.exit(1)
    point_by_key = {c.key: c.grammar_point_id for c in cons}
    matcher = build_matcher({c.key: c.pattern for c in cons})

    items = await _load_texts(limit)
    print(f"待扫 {len(items)} 段文本，规则 {len(cons)} 条")

    nlp = get_nlp()
    counts: dict[tuple[str, str, int], int] = defaultdict(int)
    capped: set[tuple[str, str, int]] = set()
    rows: list[dict] = []
    total = 0

    def _u16(prefix: str) -> int:
        return sum(2 if ord(ch) > 0xFFFF else 1 for ch in prefix)

    texts = [it[4] for it in items]
    for meta, doc in zip(
        # 不能 disable lemmatizer：规则里用了 LEMMA 属性，关掉会直接抛 E155。
        # ner 与本模块无关，关掉能省约三成时间
        items, nlp.pipe(texts, batch_size=PIPE_BATCH, disable=["ner"]), strict=True
    ):
        kind, source_id, para_id, sent_id, raw = meta
        seen: set[tuple[str, int, int]] = set()
        for match_id, token_ids in matcher(doc):
            key = doc.vocab.strings[match_id]
            pid = point_by_key.get(key)
            if pid is None or not token_ids:
                continue
            lo, hi = min(token_ids), max(token_ids)
            span = doc[lo : hi + 1]
            sig = (key, span.start_char, span.end_char)
            if sig in seen:
                continue
            seen.add(sig)
            bucket = (key, kind, source_id)
            if counts[bucket] >= MAX_PER_SOURCE:
                capped.add(bucket)
                continue
            counts[bucket] += 1
            total += 1
            rows.append(
                {
                    "grammar_point_id": pid,
                    "construction_key": key,
                    "source_kind": kind,
                    "source_id": source_id,
                    "paragraph_id": para_id,
                    "sentence_id": sent_id,
                    "char_start": _u16(raw[: span.start_char]),
                    "char_end": _u16(raw[: span.end_char]),
                    "snippet": span.text[:500],
                }
            )
        if len(rows) >= INSERT_BATCH:
            await _flush(rows)
            rows = []
            print(f"  已写入 {total}", end="\r")
    if rows:
        await _flush(rows)
    print(f"\n命中 {total} 处")
    if capped:
        print(f"  {len(capped)} 个 (构式×素材) 达到 {MAX_PER_SOURCE} 条上限，多余的未入库")


async def _flush(rows: list[dict]) -> None:
    async with SessionFactory() as s:
        await s.execute(GrammarOccurrence.__table__.insert(), rows)
        await s.commit()


async def clear() -> None:
    async with SessionFactory() as s:
        await s.execute(text("TRUNCATE TABLE grammar_occurrence RESTART IDENTITY"))
        await s.commit()


async def check() -> None:
    async with SessionFactory() as s:
        total = (await s.execute(select(func.count()).select_from(GrammarOccurrence))).scalar_one()
        by_key = (
            await s.execute(
                select(GrammarOccurrence.construction_key, func.count())
                .group_by(GrammarOccurrence.construction_key)
                .order_by(func.count().desc())
            )
        ).all()
        points = (
            await s.execute(
                select(func.count(func.distinct(GrammarOccurrence.grammar_point_id)))
            )
        ).scalar_one()
    print(f"grammar_occurrence {total} 处，覆盖 {points} 个语法点")
    print("构式命中数（AC-101 要求每条 ≥1 处）：")
    zero = [r.key for r in RULES if r.key not in {k for k, _ in by_key}]
    for k, n in by_key:
        print(f"  {k:32s} {n}")
    if zero:
        print(f"  ⚠ 零命中的构式：{zero}")
    else:
        print("  55 条构式全部有真实出现  AC-101 ✅")


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rules", action="store_true")
    ap.add_argument("--scan", action="store_true")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    if args.check:
        await check()
        return
    if args.rules or not args.scan:
        bad = selftest()
        print(f"规则自检：{len(RULES)} 条，未命中 {bad or '无'}")
        await seed_rules()
    if args.scan:
        await clear()
        await scan(args.limit)
        await check()


if __name__ == "__main__":
    asyncio.run(main())
