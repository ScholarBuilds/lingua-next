"""讲义覆盖度审计（FR-407d、AC-109）。

用法（server 目录）：
    uv run python scripts/audit_grammar_coverage.py
    uv run python scripts/audit_grammar_coverage.py --level A2   # 只看某个等级

回答一个问题：**CEFR-J 的 501 个语法点里，哪些讲义压根没讲到。**
这份缺口清单就是「补齐到全覆盖」的待办。

> [!danger] 点级逐条判定做不了，别硬做
>
> CEFR-J 的 `item_zh` 是**句型描述不是术语**——「指示代词 these/those + be：
> Aren't these/those ...?」「too+形容词/副词+to不定式」。拿它当关键词去讲义正文里搜，
> 命中率必然趋近于零：首版实测「覆盖 15/501」，而讲义里现在完成时、被动语态、
> 非谓语明明都有整章。**那是判据坏了，不是讲义缺内容**，照着这个数去补会补出一堆重复。
>
> 换成范畴名去搜也一样不行，第二版实测报出 7 个「一处都没提到」的范畴，
> 其中「时态与体」对着讲义整章的《动词时态》、「虚拟与条件」对着《虚拟语气详解》。
> **CEFR-J 和这套中文讲义是两套术语体系**，同一个概念各叫各的名字，
> 字符串匹配跨不过去——这不是调调关键词能修好的，是判据选错了。
>
> 所以：
>
> - **构式覆盖**看映射（概念有没有挂上那 55 条构式），可行动。
> - **范畴覆盖**改成一次小规模 LLM 对照：24 个范畴 × 56 篇文档标题，
>   问「这个范畴由哪几篇讲」。输入小、任务清楚，比正则可靠得多。
> - **点级逐条**不做。要精确到点，唯一可靠的路是人工标注，
>   不拿字符串匹配假装能算出来。
"""

import argparse
import asyncio
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select  # noqa: E402

from app.db import SessionFactory  # noqa: E402
from domain.llm import LLMUnavailable, complete_json  # noqa: E402
from domain.models import (  # noqa: E402
    GrammarConcept,
    GrammarConstruction,
    GrammarPoint,
)

ALIAS = "grammar-deep"

SYSTEM = """你把 CEFR-J 的语法范畴对应到一套中文语法讲义的篇目上。

给出讲义篇目清单后，对每个 CEFR-J 范畴回答：这个范畴的内容由哪几篇讲义覆盖。

注意两套术语不同名，要按**内容**判断而不是按字面：
- CEFR-J 的「时态与体」对应讲义的《动词时态》系列
- 「限定词与数量」对应《冠词》《数词》《不定代词》一类
- 「使役与感官」可能散在《非谓语动词》里

覆盖不到就给空数组——报「没覆盖」比硬凑一篇有用。

只输出 JSON：{"items":[{"category":"...","docs":["篇目标题", ...]}]}"""


async def run(level: str | None) -> None:
    async with SessionFactory() as session:
        concepts = list(
            (
                await session.execute(
                    select(GrammarConcept).where(GrammarConcept.status == "active")
                )
            )
            .scalars()
            .all()
        )
        points = list(
            (await session.execute(select(GrammarPoint).order_by(GrammarPoint.id)))
            .scalars()
            .all()
        )
        cons = list(
            (
                await session.execute(
                    select(GrammarConstruction).where(GrammarConstruction.enabled)
                )
            )
            .scalars()
            .all()
        )

    print(f"讲义 {len(concepts)} 个概念，CEFR-J {len(points)} 个语法点，{len(cons)} 条构式\n")

    # ── 构式覆盖：看映射 ──
    mapped_keys: set[str] = set()
    for c in concepts:
        mapped_keys.update(str(k) for k in (c.construction_keys or []))
    missing_cons = sorted(c.key for c in cons if c.key not in mapped_keys)
    print(f"构式覆盖：{len(cons) - len(missing_cons)}/{len(cons)} 条挂上了概念")
    if missing_cons:
        print("  没挂上的：" + "、".join(missing_cons))

    # ── 范畴覆盖：交给 LLM 做术语对照，不用字符串匹配 ──
    docs = sorted({f"{c.chapter} / {c.doc_title}" for c in concepts})
    by_cat: dict[str, list[GrammarPoint]] = defaultdict(list)
    for p in points:
        if level is None or (p.cefr_level or "") == level:
            by_cat[p.category].append(p)

    cats = sorted(by_cat, key=lambda c: -len(by_cat[c]))
    user = "讲义篇目：\n" + "\n".join(docs) + "\n\nCEFR-J 范畴：\n" + "\n".join(cats)
    mapping: dict[str, list[str]] = {}
    try:
        parsed, _, _ = await complete_json(ALIAS, SYSTEM, user)
        for it in parsed.get("items") or []:
            mapping[str(it.get("category") or "")] = [str(d) for d in (it.get("docs") or [])]
    except LLMUnavailable as exc:
        print(f"\n范畴对照不可用（{str(exc)[:90]}），只报构式覆盖")
        return

    print(f"\n范畴覆盖（{len(cats)} 个 CEFR-J 语法范畴 × {len(docs)} 篇讲义）")
    print(f"{'范畴':<16}{'语法点':>6}  讲义篇目")
    gaps: list[str] = []
    for cat in cats:
        hit = mapping.get(cat) or []
        if not hit:
            gaps.append(cat)
        shown = "、".join(d.split(" / ")[-1] for d in hit[:3]) or "——"
        print(f"{cat:<16}{len(by_cat[cat]):>6}  {shown}")

    if gaps:
        print(f"\n讲义没有覆盖的范畴（{len(gaps)} 个）：" + "、".join(gaps))
        print("这才是要补的缺口。补完重跑本脚本应归零。")
    else:
        print(f"\n{len(cats)} 个范畴讲义都有对应篇目，没有整块缺口。")

    print(
        "\n注：点级逐条覆盖不在这里判定——CEFR-J 的条目名是句型描述不是术语，"
        "与讲义又是两套术语体系，字符串匹配跨不过去（见本文件 docstring）。"
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--level", help="只审计某个 CEFR 等级，如 A2")
    args = ap.parse_args()
    asyncio.run(run(args.level))


if __name__ == "__main__":
    main()
