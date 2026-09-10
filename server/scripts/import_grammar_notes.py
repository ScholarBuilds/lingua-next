"""语法讲义导入（FR-407）。

用法（server 目录）：
    uv run python scripts/import_grammar_notes.py            # 用默认路径
    uv run python scripts/import_grammar_notes.py --path <obsidian 语法目录>
    uv run python scripts/import_grammar_notes.py --dry-run  # 只报会切成什么，不写库

把 Obsidian 里那套 13 类 56 篇的讲义切成概念落库。

> [!danger] 只切分，不改字
>
> BR-94。行文是用户自己的，AI 改写会引入 AI 腔且不可逆，改完还没法回退。
> 这个脚本读 YAML front matter 与标题层级，按结构切，正文原样存。
> 缺口要补时新写的概念单独标 `authored_by=platform`，界面上与导入内容区分开。

切分规则：`# 一级` 是文档标题（每篇一个），`## 二级` 是概念边界，
三级及以下留在概念正文里。没有二级标题的文档整篇作为一个概念并告警——
静默吞掉一篇八千字的讲义比报错糟得多。

幂等：按 `slug`（源文件相对路径 + 标题）upsert，内容没变就跳过写库。
**掌握度与复习进度永不重置**——误区目录当初用 TRUNCATE 重灌把用户的错题本
连带清空过一次，那个教训在这里落成「只 upsert、删除只标 archived」。
"""

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select  # noqa: E402

from app.db import SessionFactory  # noqa: E402
from domain.grammar_notes import Concept, collect  # noqa: E402
from domain.models import GrammarConcept  # noqa: E402

DEFAULT_PATH = Path(
    "/Users/your-user/Documents/知识库/obsidian_en/12.软实力与英语/01.英语学习/02.英语基础语法"
)


async def upsert(concepts: list[Concept], authored_by: str) -> dict[str, int]:
    """按 slug upsert。

    > [!danger] 归档必须按来源限定范围
    >
    > 讲义有两个来源：用户 Obsidian 里的原文（`notes`）与平台补写的缺口
    > （`platform`）。归档判据若只看「这次没扫到」，跑任何一个来源都会把另一个
    > 全部归档——**539 个概念连同掌握度一起消失，而且不报错**。
    > 所以归档只在**本次来源**的范围内做。
    """
    stats = {"new": 0, "updated": 0, "unchanged": 0, "archived": 0}
    async with SessionFactory() as session:
        rows = (await session.execute(select(GrammarConcept))).scalars().all()
        by_slug = {r.slug: r for r in rows}
        incoming = {c.slug for c in concepts}

        for c in concepts:
            row = by_slug.get(c.slug)
            if row is None:
                session.add(
                    GrammarConcept(
                        slug=c.slug,
                        source_path=c.source_path,
                        chapter=c.chapter,
                        doc_title=c.doc_title,
                        title=c.title,
                        heading_path=c.heading_path,
                        body_md=c.body_md,
                        content_hash=c.content_hash,
                        order_index=c.order_index,
                        layer="reference",
                        authored_by=authored_by,
                        status="active",
                    )
                )
                stats["new"] += 1
                continue
            if row.content_hash == c.content_hash and row.status == "active":
                # 顺序与标题可能变了，但正文没变：只对齐元数据，不动 hash
                row.order_index = c.order_index
                row.doc_title = c.doc_title
                row.title = c.title
                stats["unchanged"] += 1
                continue
            row.source_path = c.source_path
            row.chapter = c.chapter
            row.doc_title = c.doc_title
            row.title = c.title
            row.heading_path = c.heading_path
            row.body_md = c.body_md
            row.content_hash = c.content_hash
            row.order_index = c.order_index
            row.authored_by = authored_by
            row.status = "active"
            stats["updated"] += 1

        # 讲义里删掉的：标 archived，**不物理删**。掌握度与复习记录挂在上面，
        # 删了等于把用户学过的痕迹一起抹掉
        for slug, row in by_slug.items():
            if slug not in incoming and row.status == "active" and row.authored_by == authored_by:
                row.status = "archived"
                stats["archived"] += 1
        await session.commit()
    return stats


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--path", type=Path, default=DEFAULT_PATH)
    ap.add_argument(
        "--authored-by",
        default="notes",
        choices=["notes", "platform"],
        help="这批讲义谁写的。平台补写的缺口用 platform，界面上与导入原文区分（BR-94）",
    )
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not args.path.exists():
        print(f"讲义目录不存在：{args.path}")
        sys.exit(1)

    concepts, warnings = collect(args.path)
    by_chapter: dict[str, int] = {}
    for c in concepts:
        by_chapter[c.chapter] = by_chapter.get(c.chapter, 0) + 1

    print(f"切出 {len(concepts)} 个概念，来自 {len({c.source_path for c in concepts})} 篇讲义")
    for ch in sorted(by_chapter):
        print(f"  {ch:<28}{by_chapter[ch]:>4} 个")
    if warnings:
        print(f"\n告警 {len(warnings)} 条：")
        for w in warnings[:20]:
            print(f"  {w}")
        if len(warnings) > 20:
            print(f"  …还有 {len(warnings) - 20} 条")

    if args.dry_run:
        print("\n--dry-run，未写库")
        return

    stats = asyncio.run(upsert(concepts, args.authored_by))
    print(
        f"\n入库：新增 {stats['new']}、更新 {stats['updated']}、"
        f"未变 {stats['unchanged']}、归档 {stats['archived']}"
    )


if __name__ == "__main__":
    main()
