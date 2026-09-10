"""语法讲义的切分逻辑（FR-407a）。

放在 domain 而不是脚本里，是为了能单测：切分错了不会报错，
只会让某个概念的正文少一截或者整篇消失，而这种错必须在单测里炸。

> [!danger] 只切分，不改字
>
> BR-94。行文是用户自己的，AI 改写会引入 AI 腔且不可逆。
> 这里读 YAML front matter 与标题层级，按结构切，正文原样保留。
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path

# 归档目录与会话记录不是讲义
SKIP_DIRS = {"_归档-旧版", ".claude-session", ".obsidian"}
# 大纲本身是目录，不是概念
SKIP_FILES = {"00.英语基础语法_大纲.md"}


@dataclass
class Concept:
    slug: str
    source_path: str
    chapter: str
    doc_title: str
    title: str
    heading_path: list[str]
    body_md: str
    order_index: int

    @property
    def content_hash(self) -> str:
        return hashlib.sha256(self.body_md.encode("utf-8")).hexdigest()[:32]


_FRONT_MATTER = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)
_H1 = re.compile(r"^#\s+(.+?)\s*$", re.MULTILINE)
_H2 = re.compile(r"^##\s+(.+?)\s*$", re.MULTILINE)
# 概念标题里的编号（"1.2 什么是名词性从句"）留在展示标题里，
# 但做 slug 时剥掉——Obsidian 侧调整编号不该让 slug 变、进度丢
_LEADING_NUM = re.compile(r"^[\d.]+\s*")


def strip_front_matter(text: str) -> tuple[dict[str, str], str]:
    """剥掉 YAML front matter，顺带取出 title/description。

    不引 yaml 依赖：这里只需要顶层的几个标量键，正则够用，
    而 front matter 里的 tags 列表本模块用不到。
    """
    m = _FRONT_MATTER.match(text)
    if not m:
        return {}, text
    meta: dict[str, str] = {}
    for line in m.group(1).splitlines():
        if line.startswith((" ", "-", "\t")) or ":" not in line:
            continue
        k, _, v = line.partition(":")
        meta[k.strip()] = v.strip().strip("\"'")
    return meta, text[m.end() :]


def slugify(*parts: str) -> str:
    """稳定 slug：中文原样保留（库里是 utf8，检索也方便），只压空白与分隔符。"""
    raw = "/".join(_LEADING_NUM.sub("", p).strip() for p in parts if p)
    raw = re.sub(r"[\s　]+", "-", raw)
    return re.sub(r"[^\w一-鿿/\-]", "", raw)[:190]


def split_document(path: Path, root: Path) -> tuple[list[Concept], list[str]]:
    """一篇讲义 → 概念列表 + 告警列表。"""
    text = path.read_text(encoding="utf-8")
    meta, body = strip_front_matter(text)
    rel = str(path.relative_to(root))
    chapter = path.parent.name if path.parent != root else "00.总览"

    h1 = _H1.search(body)
    doc_title = meta.get("title") or (h1.group(1) if h1 else path.stem)

    warnings: list[str] = []
    marks = list(_H2.finditer(body))
    if not marks:
        # 整篇一个概念。**不能静默丢**：一篇八千字的讲义没进库，
        # 表现是「学习路径里少了一节」，没人会去查为什么
        warnings.append(f"{rel}：没有二级标题，整篇作为一个概念")
        return (
            [
                Concept(
                    slug=slugify(chapter, doc_title),
                    source_path=rel,
                    chapter=chapter,
                    doc_title=doc_title,
                    title=doc_title,
                    heading_path=[doc_title],
                    body_md=body[h1.end() :].strip() if h1 else body.strip(),
                    order_index=0,
                )
            ],
            warnings,
        )

    out: list[Concept] = []
    for i, m in enumerate(marks):
        title = m.group(1).strip()
        end = marks[i + 1].start() if i + 1 < len(marks) else len(body)
        section = body[m.end() : end].strip()
        if not section:
            warnings.append(f"{rel} / {title}：正文为空，跳过")
            continue
        out.append(
            Concept(
                slug=slugify(chapter, doc_title, title),
                source_path=rel,
                chapter=chapter,
                doc_title=doc_title,
                title=title,
                heading_path=[doc_title, title],
                body_md=section,
                order_index=i,
            )
        )
    return out, warnings


def collect(root: Path) -> tuple[list[Concept], list[str]]:
    concepts: list[Concept] = []
    warnings: list[str] = []
    for path in sorted(root.rglob("*.md")):
        if any(part in SKIP_DIRS for part in path.relative_to(root).parts):
            continue
        if path.name in SKIP_FILES:
            continue
        got, warn = split_document(path, root)
        concepts.extend(got)
        warnings.extend(warn)
    # slug 撞车说明两篇里有同名章节，必须显形——否则后一条会覆盖前一条
    seen: dict[str, str] = {}
    for c in concepts:
        if c.slug in seen:
            warnings.append(f"slug 冲突 {c.slug}：{seen[c.slug]} 与 {c.source_path}")
        seen[c.slug] = c.source_path
    return concepts, warnings


