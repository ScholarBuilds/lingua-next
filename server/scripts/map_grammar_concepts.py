"""把语法概念挂到构式上（FR-407c）。

用法（server 目录）：
    uv run python scripts/map_grammar_concepts.py              # 只映射主动层
    uv run python scripts/map_grammar_concepts.py --all        # 全部 539 个
    uv run python scripts/map_grammar_concepts.py --report

概念挂上构式之后，`scan_grammar` 已经扫出来的 38 万条语料命中就成了这个概念的
**真实例句**，带书名与出处；构式表上的 `grammar_point_id` 又顺带把 CEFR-J 语法点
和它的练习题接过来。所以只需要映射这一层，例句与题都是派生的。

> [!info] 语法点不单独映射
>
> CEFR-J 有 501 个点，塞进提示词既贵又不准。而构式只有 55 条、每条都已经
> 绑好了语法点——概念 → 构式 → 语法点 这条链本来就存在，再单独映射一次
> 只会引入第二套可能互相矛盾的对应关系。

映射结果落库并可重跑：重跑覆盖 `construction_keys` 与 `grammar_point_ids`，
不动概念正文，也不动任何掌握度。
"""

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select  # noqa: E402

from app.db import SessionFactory  # noqa: E402
from domain.llm import LLMUnavailable, complete_json  # noqa: E402
from domain.models import GrammarConcept, GrammarConstruction  # noqa: E402

ALIAS = "grammar-deep"
BATCH = 12

SYSTEM_TMPL = """你把英语语法概念对应到构式识别规则上。

可用构式（key | 说明）：
{catalog}

给每个概念挑出**它讲的就是这个结构**的构式 key，可以是 0 到 3 个。

判据从严：概念正文必须在讲这个结构本身，而不是顺带提过。
- 「现在完成时」→ present-perfect ✓
- 「时态综合辨析」顺带举了完成时的例子 → 不挂 ✗
- 挑不出就给空数组，宁缺勿滥。挂错的后果是概念页展示一批不相干的例句，
  比没有例句更让人困惑。

只输出 JSON：{{"items":[{{"slug":"...","keys":["...", ...]}}]}}
key 必须来自上面的列表，原样拼写。每个输入概念都要有一条对应输出。"""


def brief(c: GrammarConcept) -> str:
    body = " ".join(c.body_md.split())[:260]
    return f"slug: {c.slug}\n标题: {c.doc_title} / {c.title}\n摘要: {body}"


async def map_batch(items: list[GrammarConcept], system: str, valid: set[str]) -> dict[str, list]:
    user = "\n\n---\n\n".join(brief(c) for c in items)
    parsed, _, _ = await complete_json(ALIAS, system, user)
    out: dict[str, list] = {}
    for it in parsed.get("items") or []:
        slug = str(it.get("slug") or "")
        if not slug:
            continue
        keys = [str(k) for k in (it.get("keys") or []) if str(k) in valid]
        out[slug] = keys[:3]
    return out


async def run(only_active: bool, report_only: bool, authored_by: str | None) -> None:
    async with SessionFactory() as session:
        cons = (
            (
                await session.execute(
                    select(GrammarConstruction).where(GrammarConstruction.enabled)
                )
            )
            .scalars()
            .all()
        )
        by_key = {c.key: c for c in cons}
        catalog = "\n".join(f"{c.key} | {c.description}" for c in sorted(cons, key=lambda x: x.key))

        stmt = select(GrammarConcept).where(GrammarConcept.status == "active")
        if only_active:
            stmt = stmt.where(GrammarConcept.layer == "active")
        # 补完缺口后只映射新加的那批，不必把已经映射好的 500 多条重跑一遍
        if authored_by is not None:
            stmt = stmt.where(GrammarConcept.authored_by == authored_by)
        concepts = list(
            (await session.execute(stmt.order_by(GrammarConcept.chapter, GrammarConcept.order_index)))
            .scalars()
            .all()
        )

        if report_only:
            mapped = [c for c in concepts if c.construction_keys]
            print(f"{len(mapped)}/{len(concepts)} 个概念挂上了构式")
            for c in mapped:
                print(f"  [{c.layer[:3]}] {c.title[:32]:<32} {', '.join(c.construction_keys)}")
            unmapped = [c for c in concepts if not c.construction_keys]
            if unmapped:
                print(f"\n未挂上的 {len(unmapped)} 个（正常：不是每个概念都对应一条可识别的构式）")
            return

        system = SYSTEM_TMPL.format(catalog=catalog)
        valid = set(by_key)
        print(f"给 {len(concepts)} 个概念找构式（每批 {BATCH} 条）…")
        result: dict[str, list] = {}
        for i in range(0, len(concepts), BATCH):
            batch = concepts[i : i + BATCH]
            try:
                got = await map_batch(batch, system, valid)
            except LLMUnavailable as exc:
                print(f"  批 {i // BATCH + 1} 失败：{str(exc)[:110]}")
                got = {}
            for c in batch:
                if c.slug not in got:
                    try:
                        got.update(await map_batch([c], system, valid))
                    except LLMUnavailable:
                        continue
            result.update(got)
            print(f"  {min(i + BATCH, len(concepts))}/{len(concepts)}")

        hit = 0
        for c in concepts:
            keys = result.get(c.slug)
            if keys is None:
                continue
            c.construction_keys = keys
            # 语法点由构式派生，不单独映射——两套对应关系会互相矛盾
            c.grammar_point_ids = sorted(
                {
                    by_key[k].grammar_point_id
                    for k in keys
                    if k in by_key and by_key[k].grammar_point_id is not None
                }
            )
            if keys:
                hit += 1
        await session.commit()
        print(f"\n{hit}/{len(concepts)} 个概念挂上了构式")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true", help="映射全部概念，默认只映射主动层")
    ap.add_argument("--report", action="store_true")
    ap.add_argument("--authored-by", choices=["notes", "platform"], help="只映射某个来源")
    args = ap.parse_args()
    asyncio.run(run(not args.all, args.report, args.authored_by))


if __name__ == "__main__":
    main()
