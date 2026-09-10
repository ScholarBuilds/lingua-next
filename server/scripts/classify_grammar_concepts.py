"""给语法概念分层：主动层 / 参考层（FR-407b、BR-95）。

用法（server 目录）：
    uv run python scripts/classify_grammar_concepts.py --budget 70
    uv run python scripts/classify_grammar_concepts.py --report   # 只看现状

> [!info] 判据是「不会它会读错句子」，不是「重要」
>
> BR-95。「重要」人人都会打满分，分不出层。真正能分层的问法是：
> **这个点不掌握，会不会导致把一个句子读错、或者译反意思？**
> 数词的分数读法、标点规则、缩略词表答案都是「不会」——它们进参考层，
> 不是因为不值得学，而是因为不学也不影响读懂句子。

分层不用二分类而用 0-100 打分：539 个概念不可能一次塞进上下文，
分批打二分类标签时每批都会各自凑出一堆「主动」，全局预算就守不住了。
打分再全局排序取前 N，预算是硬的。

每条都要求给出一句话理由并落库（BR-95）：分层带主观性，理由写下来才可复核可调整。
"""

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select  # noqa: E402

from app.db import SessionFactory  # noqa: E402
from domain.llm import LLMUnavailable, complete_json  # noqa: E402
from domain.models import GrammarConcept  # noqa: E402

ALIAS = "grammar-deep"
BATCH = 20

SYSTEM = """你是英语教学设计者。给每个语法概念打一个「读句必需度」分（0-100）。

判据只有一条：**这个概念不掌握，会不会导致把一个英文句子读错、或者译反意思？**

- 90-100：不掌握就会误解句子主干或逻辑关系。例：非谓语的逻辑主语、定语从句先行词判定、
  虚拟语气的时间错位、it 作形式主语、否定与倒装的作用域、时态呼应
- 60-89：不掌握会影响理解细节或产出，但一般不至于读反。例：冠词的具体用法、比较级结构
- 30-59：主要影响表达地道度，不影响读懂。例：形容词排列顺序、常用搭配
- 0-29：查得到就行，不影响读句。例：分数与小数读法、标点规则、缩略词、口语场景用语、
  学习资源推荐、术语对照表

只输出 JSON：{"items":[{"slug":"...","need":整数,"why":"一句话，说清不会它会读错什么"}]}
`why` 用中文，不超过 40 字，直接说后果，不要写「这个概念很重要」这类空话。
每个输入概念都必须有一条对应输出，slug 原样回传。"""


def brief(c: GrammarConcept) -> str:
    body = " ".join(c.body_md.split())[:220]
    return f"slug: {c.slug}\n章: {c.chapter} / {c.doc_title}\n标题: {c.title}\n摘要: {body}"


async def score_batch(items: list[GrammarConcept]) -> dict[str, tuple[int, str]]:
    user = "\n\n---\n\n".join(brief(c) for c in items)
    parsed, _, _ = await complete_json(ALIAS, SYSTEM, user)
    out: dict[str, tuple[int, str]] = {}
    for it in parsed.get("items") or []:
        slug = str(it.get("slug") or "")
        if not slug:
            continue
        try:
            need = int(it.get("need"))
        except (TypeError, ValueError):
            continue
        out[slug] = (max(0, min(100, need)), str(it.get("why") or "").strip())
    return out


async def score_all(concepts: list[GrammarConcept]) -> dict[str, tuple[int, str]]:
    scores: dict[str, tuple[int, str]] = {}
    for i in range(0, len(concepts), BATCH):
        batch = concepts[i : i + BATCH]
        try:
            got = await score_batch(batch)
        except LLMUnavailable as exc:
            print(f"  批 {i // BATCH + 1} 失败：{str(exc)[:110]}")
            got = {}
        missing = [c for c in batch if c.slug not in got]
        # 整批被拒时逐条重试。实测过一次：同样 4 个点单独发都能过、
        # 合在一批就被内容策略拒——被拒的是合并后的载荷，不是其中某一条
        for c in missing:
            try:
                got.update(await score_batch([c]))
            except LLMUnavailable:
                continue
        scores.update(got)
        print(f"  {min(i + BATCH, len(concepts))}/{len(concepts)}  已评 {len(scores)} 条")
    return scores


async def run(budget: int, report_only: bool) -> None:
    async with SessionFactory() as session:
        concepts = list(
            (
                await session.execute(
                    select(GrammarConcept)
                    .where(GrammarConcept.status == "active")
                    .order_by(GrammarConcept.chapter, GrammarConcept.order_index)
                )
            )
            .scalars()
            .all()
        )
        if report_only:
            active = [c for c in concepts if c.layer == "active"]
            print(f"共 {len(concepts)} 个概念，主动层 {len(active)} 个")
            by_ch: dict[str, int] = {}
            for c in active:
                by_ch[c.chapter] = by_ch.get(c.chapter, 0) + 1
            for ch in sorted(by_ch):
                print(f"  {ch:<28}{by_ch[ch]:>3}")
            print()
            for c in sorted(active, key=lambda x: (x.chapter, x.order_index))[:80]:
                print(f"  [{c.chapter[:6]}] {c.title[:34]:<34} {c.why_active or ''}")
            return

        print(f"给 {len(concepts)} 个概念打分（每批 {BATCH} 条）…")
        scores = await score_all(concepts)
        if len(scores) < len(concepts) * 0.9:
            print(f"只评到 {len(scores)}/{len(concepts)}，覆盖不足，不写库")
            sys.exit(1)

        ranked = sorted(
            concepts, key=lambda c: (-scores.get(c.slug, (0, ""))[0], c.chapter, c.order_index)
        )
        active_slugs = {c.slug for c in ranked[:budget]}
        for c in concepts:
            need, why = scores.get(c.slug, (0, ""))
            c.layer = "active" if c.slug in active_slugs else "reference"
            c.why_active = why or None
        await session.commit()

        cut = scores.get(ranked[budget - 1].slug, (0, ""))[0] if len(ranked) >= budget else 0
        print(f"\n主动层 {len(active_slugs)} 个，分数线 {cut}")
        by_ch: dict[str, int] = {}
        for c in concepts:
            if c.layer == "active":
                by_ch[c.chapter] = by_ch.get(c.chapter, 0) + 1
        for ch in sorted(by_ch):
            print(f"  {ch:<28}{by_ch[ch]:>3}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--budget", type=int, default=70, help="主动层概念数，BR-95 建议 60-80")
    ap.add_argument("--report", action="store_true")
    args = ap.parse_args()
    asyncio.run(run(args.budget, args.report))


if __name__ == "__main__":
    main()
