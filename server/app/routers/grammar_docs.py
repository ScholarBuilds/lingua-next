"""语法讲义文档接口（Obsidian 式三栏阅读器的服务端）。

语料是本机 Obsidian vault（`Settings.grammar_docs_root`），平台侧默认只读：
tree / content / search 只扫文件不落库，improve 只产出改进稿绝不写文件。
正文写回只允许走 apply——用户在前端确认过 AI 改稿后才会调，写回前先备份到
`Settings.grammar_docs_backup_dir`。library/import 只把用户选中的旧目录复制进
NEXUS 讲义目录，遇到同名文件不覆盖。

与模块 15（grammar_concepts）的分工：15 把讲义切成概念进库供学习路径用，
这里按「整篇文档」原样呈现，两边共用同一个 vault 与同一套跳过规则。

划词批注是这里唯一进库的东西（`grammar_doc_annotation`）：讲义本身仍在磁盘上，
批注只存「选中了哪段话」，落点每次读取时按当前正文现算，见 :func:`relocate`。
"""

from __future__ import annotations

import json
import logging
import os
import re
import tempfile
from collections.abc import AsyncGenerator
from contextlib import suppress
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import SessionFactory
from app.routers.dict import SessionDep
from domain import image_describe, studio_gpt
from domain.grammar_library import import_markdown_tree
from domain.grammar_notes import SKIP_DIRS, strip_front_matter
from domain.llm import LLMUnavailable, stream_text
from domain.models import GrammarDocAnnotation

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/grammar/docs", tags=["grammar"])

SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
# 全文完善送给模型的正文上限：讲义最长上万字，整篇塞进去既慢又容易把输出截断。
# 截前 8000 字符并在提示词里说明，产出仍以「改进稿」形式交给用户确认
IMPROVE_MAX_CHARS = 8_000
# 讲义完善是「按用户要求改写自然文本」，与词汇/短语讲解同一档通用能力
IMPROVE_ALIAS = "explain-standard"
SEARCH_MAX_HITS_PER_DOC = 5
SNIPPET_MAX_CHARS = 200

# 批注锚点的前后文长度：短了区分不开重复句，长了正文一改就整体失配，32 字符是折中
ANNOTATION_EDGE_CHARS = 32
# 送给模型的上下文半径：代词、省略、承接上句的主语都要靠它才解得开
ANALYZE_CONTEXT_CHARS = 200
# 批注分析的三档能力。语法拆解归「深度语法」（配置中心 grammar-deep 那一档，
# 语法三级分析与句子精讲已经在用）；讲透与中译是通用讲解，与全文完善同一档
ANALYZE_CAPABILITIES = {
    "grammar": "grammar-deep",
    "explain": IMPROVE_ALIAS,
    "translate": IMPROVE_ALIAS,
}

# 与 grammar_notes 的切分规则一致；这里只为取 tags 列表——
# strip_front_matter 刻意只解析标量键，列表键得自己扫
_FRONT_MATTER = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)


def _front_matter_scalars(text: str) -> dict[str, str]:
    match = _FRONT_MATTER.match(text)
    if match is None:
        return {}
    out: dict[str, str] = {}
    for line in match.group(1).splitlines():
        if ":" not in line or line.lstrip().startswith("-"):
            continue
        key, value = line.split(":", 1)
        value = value.strip().strip("\"'")
        if value:
            out[key.strip()] = value
    return out


def _root() -> Path:
    return Path(get_settings().grammar_docs_root).resolve()


Collection = Literal["grammar", "vocabulary", "patterns", "scenes", "software"]
COLLECTION_DIRS = {
    "vocabulary": "01.英语词汇",
    "patterns": "03.英语句型手册",
    "scenes": "04.英语场景",
    "software": "05.软件英语",
}

SOFTWARE_ID = re.compile(r"^[a-z0-9][a-z0-9-]{1,63}$")
IMAGE_MIMES = {b"\x89PNG\r\n\x1a\n": "image/png", b"\xff\xd8\xff": "image/jpeg"}


def _collection_root(root: Path, collection: Collection, library: str | None = None) -> Path:
    if collection == "grammar":
        base = root
    else:
        directory = COLLECTION_DIRS[collection]
        base = root / directory
        # 开发环境可直接指向 Obsidian 的 02.英语基础语法；桌面副本则把五个集合
        # 汇总在 data/desktop/grammar。两种布局使用同一套相对文档路径。
        if not base.exists() and root.name == "02.英语基础语法":
            base = root.parent / directory
    if collection != "software":
        return base
    if library is None:
        return base
    if not SOFTWARE_ID.fullmatch(library):
        raise HTTPException(status_code=400, detail="软件 ID 不合法")
    for child in base.iterdir() if base.is_dir() else ():
        if not child.is_dir() or child.name.startswith("."):
            continue
        outlines = list(child.glob("00.*_大纲.md"))
        if (
            outlines
            and _front_matter_scalars(outlines[0].read_text(encoding="utf-8")).get("software_id")
            == library
        ):
            return child
    raise HTTPException(status_code=404, detail="软件讲义库不存在")


def _collection_of(path: str) -> Collection:
    first = Path(path).parts[0] if Path(path).parts else ""
    return next(
        (key for key, directory in COLLECTION_DIRS.items() if first == directory), "grammar"
    )


def _software_library_from_path(path: str) -> str | None:
    parts = Path(path).parts
    if len(parts) < 2 or parts[0] != COLLECTION_DIRS["software"]:
        return None
    outline = _collection_root(_root(), "software") / parts[1]
    files = list(outline.glob("00.*_大纲.md")) if outline.is_dir() else []
    return (
        _front_matter_scalars(files[0].read_text(encoding="utf-8")).get("software_id")
        if files
        else None
    )


def _collection_scan(
    root: Path, collection: Collection, library: str | None = None
) -> tuple[list[dict], list[dict]]:
    source = _collection_root(root, collection, library)
    loose, chapters = _scan(source)
    if collection == "grammar":
        return loose, [
            chapter for chapter in chapters if chapter["name"] not in COLLECTION_DIRS.values()
        ]
    prefix = Path(COLLECTION_DIRS[collection])
    if collection == "software":
        prefix /= source.name
    for doc in loose + [doc for chapter in chapters for doc in chapter["docs"]]:
        doc["path"] = str(prefix / doc["path"])
    return loose, chapters


def _doc_entry(path: Path, root: Path) -> dict:
    return {"path": str(path.relative_to(root)), "name": path.stem}


def _scan(root: Path) -> tuple[list[dict], list[dict]]:
    """扫 vault → (根目录直属文档, 章节列表)。排序全按文件名，编号前缀天然有序。"""
    if not root.is_dir():
        return [], []
    loose = [_doc_entry(p, root) for p in sorted(root.glob("*.md"), key=lambda p: p.name)]
    chapters: list[dict] = []
    for child in sorted(root.iterdir(), key=lambda p: p.name):
        if not child.is_dir() or child.name in SKIP_DIRS or child.name.startswith("."):
            continue
        docs = [
            _doc_entry(p, root)
            for p in sorted(child.rglob("*.md"), key=lambda p: str(p.relative_to(root)))
            if not any(part in SKIP_DIRS for part in p.relative_to(root).parts)
        ]
        if docs:
            chapters.append({"name": child.name, "docs": docs})
    return loose, chapters


def _flat_order(
    root: Path, collection: Collection = "grammar", library: str | None = None
) -> list[dict]:
    """prev/next 用的全局顺序：loose 在前，章节按名字顺序接在其后。"""
    loose, chapters = _collection_scan(root, collection, library)
    out = list(loose)
    for chapter in chapters:
        out.extend(chapter["docs"])
    return out


# SKIP_DIRS 的比较必须大小写不敏感：vault 落在 macOS 默认的大小写不敏感 APFS 上，
# `.CLAUDE-SESSION/x.md` 在文件系统层能命中真文件，而集合比较是区分大小写的——
# 复查实测用这个写法读出过被刻意排除的会话记录
_SKIP_FOLDED = {name.casefold() for name in SKIP_DIRS}


def _resolve(root: Path, rel: str) -> Path:
    """相对路径 → vault 内绝对路径。

    越界（`../`）、绝对路径、非 .md、指向跳过目录、任何点号目录一律 400——
    正常前端只会回传 tree 给出的路径，这些形态只可能来自构造出的请求，
    校验松了等于把整个文件系统暴露给 content/apply。

    拦截面必须与 _scan 一致：_scan 把所有顶层点号目录挡在树外（.obsidian、
    .trash、.claude-session…），这里若只查 SKIP_DIRS 三个名字，树上看不见的
    目录反而能被 content 读、被 apply 写。
    """
    if not rel or Path(rel).is_absolute():
        raise HTTPException(status_code=400, detail="路径必须是 vault 内的相对路径")
    parts = Path(rel).parts
    sibling = bool(
        parts and parts[0] in COLLECTION_DIRS.values() and root.name == "02.英语基础语法"
    )
    allowed_root = root.parent if sibling else root
    target = (allowed_root / rel).resolve()
    if target.suffix != ".md" or not target.is_relative_to(allowed_root):
        raise HTTPException(status_code=400, detail="路径必须指向 vault 内的 .md 文件")
    for part in target.relative_to(allowed_root).parts:
        if part.startswith(".") or part.casefold() in _SKIP_FOLDED:
            raise HTTPException(status_code=400, detail="路径必须指向 vault 内的 .md 文件")
    return target


def _existing_doc(root: Path, rel: str) -> Path:
    target = _resolve(root, rel)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="讲义不存在")
    return target


def _vault_relative(target: Path, root: Path) -> Path:
    return (
        target.relative_to(root) if target.is_relative_to(root) else target.relative_to(root.parent)
    )


def _parse_tags(text: str) -> list[str]:
    """front matter 里的 tags：块列表为主（vault 现状），顺带兼容行内 [a, b]。"""
    m = _FRONT_MATTER.match(text)
    if not m:
        return []
    tags: list[str] = []
    in_tags = False
    for line in m.group(1).splitlines():
        stripped = line.strip()
        if stripped.startswith("tags:"):
            rest = stripped[len("tags:") :].strip()
            if rest.startswith("[") and rest.endswith("]"):
                return [t.strip().strip("\"'") for t in rest[1:-1].split(",") if t.strip()]
            in_tags = True
            continue
        if in_tags:
            if stripped.startswith("-"):
                tags.append(stripped.lstrip("-").strip().strip("\"'"))
                continue
            break
    return tags


def _doc_body(text: str) -> str:
    """正文统一形态：剥 front matter 后再去掉紧跟的空行。

    content / search / improve 都走这里——search 的行号要对得上 content
    返回的正文，行号基准只能有一个。
    """
    return strip_front_matter(text)[1].lstrip("\n")


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


# 讲义文件端点是同步文件 IO，写成 def 让 FastAPI 丢进线程池——同一个 uvicorn
# 进程还跑着实时语音 websocket，扫盘和导入不能卡事件循环。
@router.get("/tree")
def doc_tree(collection: Collection = "grammar", library: str | None = None) -> dict:
    loose, chapters = _collection_scan(_root(), collection, library)
    return {"chapters": chapters, "loose": loose}


@router.get("/library")
def library_status(collection: Collection = "grammar", library: str | None = None) -> dict:
    root = _collection_root(_root(), collection, library)
    loose, chapters = _collection_scan(_root(), collection, library)
    return {
        "root": str(root),
        "exists": root.is_dir(),
        "documents": len(loose) + sum(len(chapter["docs"]) for chapter in chapters),
        "runtime_profile": get_settings().runtime_profile,
    }


def _software_outlines() -> list[tuple[Path, dict[str, str]]]:
    base = _collection_root(_root(), "software")
    if not base.is_dir():
        return []
    out: list[tuple[Path, dict[str, str]]] = []
    for child in sorted(base.iterdir(), key=lambda path: path.name):
        if not child.is_dir() or child.name.startswith("_") or child.name.startswith("."):
            continue
        outlines = sorted(child.glob("00.*_大纲.md"))
        if not outlines:
            continue
        meta = _front_matter_scalars(outlines[0].read_text(encoding="utf-8"))
        if SOFTWARE_ID.fullmatch(meta.get("software_id", "")):
            out.append((child, meta))
    return out


@router.get("/software/libraries")
def software_libraries() -> dict:
    items: list[dict] = []
    for root, meta in _software_outlines():
        docs = [
            path
            for path in root.rglob("*.md")
            if not any(part.startswith((".", "_")) for part in path.relative_to(root).parts)
        ]
        screenshots = int(meta.get("screenshots", "0") or 0)
        items.append(
            {
                "software_id": meta["software_id"],
                "software_name": meta.get("software_name", root.name),
                "platform": meta.get("platform", ""),
                "version": meta.get("version", meta.get("software_version", "")),
                "captured_at": meta.get("captured_at", ""),
                "cover": meta.get("cover", ""),
                "status": meta.get("status", "reviewed"),
                "screenshots": screenshots,
                "documents": len(docs),
                "outline": str(
                    Path(COLLECTION_DIRS["software"])
                    / root.name
                    / root.glob("00.*_大纲.md").__next__().name
                ),
            }
        )
    return {"items": items}


def _software_root(software_id: str) -> Path:
    return _collection_root(_root(), "software", software_id)


def _sniff_image(data: bytes) -> str | None:
    for signature, mime in IMAGE_MIMES.items():
        if data.startswith(signature):
            return mime
    return None


@router.get("/assets/{software_id}/{asset_path:path}")
def software_asset(software_id: str, asset_path: str, request: Request) -> Response:
    settings = get_settings()
    host = request.client.host if request.client else ""
    if settings.runtime_profile != "desktop" or host not in {"127.0.0.1", "::1", "testclient"}:
        raise HTTPException(status_code=403, detail="软件截图仅允许桌面本机读取")
    if not asset_path or Path(asset_path).is_absolute():
        raise HTTPException(status_code=400, detail="图片路径不合法")
    library_root = _software_root(software_id)
    assets_root = (library_root / "_assets" / "screenshots").resolve()
    candidate = assets_root / asset_path
    if candidate.is_symlink():
        raise HTTPException(status_code=400, detail="图片路径不允许符号链接")
    target = candidate.resolve()
    if not target.is_relative_to(assets_root) or any(
        part.startswith(".") for part in Path(asset_path).parts
    ):
        raise HTTPException(status_code=400, detail="图片路径不合法")
    cursor = candidate
    while cursor != assets_root:
        if cursor.is_symlink():
            raise HTTPException(status_code=400, detail="图片路径不允许符号链接")
        cursor = cursor.parent
    if not target.is_file():
        raise HTTPException(status_code=404, detail="图片不存在")
    data = target.read_bytes()
    mime = _sniff_image(data)
    if mime is None:
        raise HTTPException(status_code=415, detail="只允许读取真实 PNG 或 JPEG 图片")
    return Response(
        data,
        media_type=mime,
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
    )


@router.get("/software/resolve-legacy-source")
def resolve_legacy_source(
    collection: str = "",
    page: str = "",
    capture: str = "",
    entry: str = "",
) -> dict:
    for root, meta in _software_outlines():
        mapping = root / "_meta" / "legacy-source-map.json"
        if not mapping.is_file():
            continue
        raw = json.loads(mapping.read_text(encoding="utf-8"))
        keys = [
            "|".join((collection, page, capture, entry)),
            "|".join((collection, page, capture, "")),
            "|".join((collection, page, "", "")),
        ]
        for key in keys:
            if key in raw.get("mappings", {}):
                return {"found": True, "library": meta["software_id"], **raw["mappings"][key]}
    return {"found": False, "message": "原截图定位已归档"}


class ImportLibraryBody(BaseModel):
    source_path: str = Field(min_length=1, max_length=4096)


@router.post("/library/import")
def import_library(body: ImportLibraryBody, collection: Collection = "grammar") -> dict:
    try:
        result = import_markdown_tree(Path(body.source_path), _collection_root(_root(), collection))
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return result.view()


@router.get("/content")
def doc_content(path: str) -> dict:
    root = _root()
    target = _existing_doc(root, path)
    text = target.read_text(encoding="utf-8")
    meta, _ = strip_front_matter(text)
    body = _doc_body(text)
    props: dict = {k: meta[k] for k in ("title", "date", "description", "categories") if k in meta}
    props["tags"] = _parse_tags(text)

    rel = str(_vault_relative(target, root))
    collection = _collection_of(rel)
    order = _flat_order(
        root, collection, _software_library_from_path(rel) if collection == "software" else None
    )
    idx = next((i for i, d in enumerate(order) if d["path"] == rel), None)
    prev_doc = order[idx - 1] if idx is not None and idx > 0 else None
    next_doc = order[idx + 1] if idx is not None and idx + 1 < len(order) else None
    return {
        "path": rel,
        "name": target.stem,
        "props": props,
        "body": body,
        # 文件原始全文（含 front matter，一字未动）。body 是 raw 的后缀——
        # 前端「节段完善→写回」按 raw 的区间拼接，不自己重组 front matter
        "raw": text,
        "mtime": datetime.fromtimestamp(target.stat().st_mtime, tz=UTC).isoformat(),
        # 前端只做「约 N 字」展示，字符数足够
        "words": len(body),
        "prev": prev_doc,
        "next": next_doc,
    }


@router.get("/search")
def search_docs(
    q: str = "", collection: Collection = "grammar", library: str | None = None
) -> dict:
    query = q.strip().lower()
    if not query:
        return {"items": []}
    root = _root()
    loose, chapters = _collection_scan(root, collection, library)
    entries = [(d, None) for d in loose] + [
        (d, chapter["name"]) for chapter in chapters for d in chapter["docs"]
    ]
    items: list[dict] = []
    for doc, chapter_name in entries:
        # 行号对齐 content 返回的 body（front matter 已剥），前端才能按行跳转
        body = _doc_body(_existing_doc(root, doc["path"]).read_text(encoding="utf-8"))
        hits: list[dict] = []
        total = 0
        for lineno, line in enumerate(body.splitlines(), start=1):
            if query in line.lower():
                total += 1
                if len(hits) < SEARCH_MAX_HITS_PER_DOC:
                    hits.append({"line": lineno, "text": line.strip()[:SNIPPET_MAX_CHARS]})
        if total:
            items.append(
                {
                    "path": doc["path"],
                    "name": doc["name"],
                    "chapter": chapter_name,
                    "n": total,
                    "hits": hits,
                }
            )
    # sort 稳定：同命中数保持 tree 顺序
    items.sort(key=lambda x: -x["n"])
    return {"items": items}


class ImproveBody(BaseModel):
    path: str
    selection: str | None = None
    instruction: str | None = None
    # 用户在输入框里粘/拖进来的附件。图片走多模态块，其它文件尽力抽正文；
    # 两者都是「这一轮的临时素材」，不入讲义、不落库，只影响这一次改写
    ref_asset_ids: list[int] = Field(default_factory=list)
    file_asset_ids: list[int] = Field(default_factory=list)


IMPROVE_SYSTEM = (
    "你是英语语法讲义的编辑，负责在保留作者个人风格的前提下完善内容。\n"
    "硬性要求：\n"
    "1. 保持作者原有的行文风格、标题层级与结构，callout、表格、列表原样沿用；\n"
    "2. 不加「首先/其次/综上所述/值得注意的是」这类 AI 腔套话；\n"
    "3. 输出只有改进后的 Markdown 本体：不带解释、不带代码围栏、不带任何前后缀。"
)

# 只在真带了附件时才追加：没带附件还讲一遍「附件是约束」，模型会去找不存在的东西
IMPROVE_ATTACHMENT_SYSTEM = (
    "\n4. 用户随这条消息带来的文件与图片是**约束与素材**，不是背景资料："
    "里面的术语、例句、体例、截图内容要落进改后的讲义，与正文冲突时以它们为准；"
    "标着读不出正文的附件，知道有这么个文件在即可，不要凭空编造它的内容。"
)

SOFTWARE_IMPROVE_SYSTEM = (
    "\n4. 这是软件英语讲义。必须原样保留所有相对图片引用、capture-* 与 "
    "expression-* HTML 锚点、界面原文表、来源和版本说明；不得改写真实界面英文，"
    "不得补写截图里没有出现的控件或操作结果；个人数据不得进入正文。"
)


async def _attachment_blocks(
    session: AsyncSession, image_ids: list[int], file_ids: list[int]
) -> list[dict]:
    """附件资产 id → 本轮 user 消息的 content 块。

    块构造一律复用 `studio_gpt`：图片读展示图变体、直读存储不下载再上传（BR-144），
    其它文件尽力抽正文、抽不出只留文件名。

    逐个 id 调而不是整批丢进去：那两个函数碰到不存在的 id 会抛 DescribeError，
    整批调等于一个坏附件把整轮完善拖成 500。坏的那个降级成一行说明，
    与 `canvas_set._attachment_lines` 同一条判据——用户带了这个文件本身就是信息，
    悄悄丢掉的话他会以为 AI 读过了。
    """
    blocks: list[dict] = []
    broken = 0
    for group, build in (
        (image_ids, studio_gpt.image_blocks),
        (file_ids, studio_gpt.file_blocks),
    ):
        for asset_id in group[: studio_gpt.MAX_INPUT_ATTACHMENTS]:
            try:
                blocks.extend(await build(session, [asset_id]))
            except image_describe.DescribeError as exc:
                broken += 1
                logger.info("讲义完善跳过读不出的附件 id=%s：%s", asset_id, exc)
    if broken:
        note = f"另外有 {broken} 个附件读不出来（文件已丢失或格式不支持），按没有它们处理。"
        blocks.append({"type": "text", "text": note})
    return blocks


def _improve_messages(
    name: str,
    body: str,
    selection: str | None,
    instruction: str | None,
    blocks: list[dict] | None = None,
    software: bool = False,
) -> list[dict]:
    system = (
        IMPROVE_SYSTEM
        + (SOFTWARE_IMPROVE_SYSTEM if software else "")
        + (IMPROVE_ATTACHMENT_SYSTEM if blocks else "")
    )
    if selection:
        user = (
            f"下面是讲义《{name}》正文中的一个小节（精确的 Markdown 源码切片）。"
            "只完善这一小节，输出改进后的这一小节本身，标题行等 Markdown 标记照常保留。\n\n"
            f"{selection}"
        )
    else:
        truncated = len(body) > IMPROVE_MAX_CHARS
        note = (
            "（正文过长，以下只截取了开头部分；完善这一部分即可，风格保持与全篇一致）\n"
            if truncated
            else ""
        )
        user = f"完善讲义《{name}》，输出改进后的全文。{note}\n\n{body[:IMPROVE_MAX_CHARS]}"
    if instruction:
        user += f"\n\n用户附加要求：{instruction}"
    # 没带附件时 content 保持纯字符串：无条件改成块数组，会让每一次普通完善
    # 都变成多模态请求（部分上游对块数组的处理与纯文本并不等价）
    content: str | list[dict] = [{"type": "text", "text": user}, *blocks] if blocks else user
    return [{"role": "system", "content": system}, {"role": "user", "content": content}]


@router.post("/improve", response_model=None)
async def improve_doc(
    body: ImproveBody, session: SessionDep, stream: bool = False
) -> dict | StreamingResponse:
    """产出改进稿，**绝不写文件**——落盘由 /apply 在用户确认后单独走。"""
    root = _root()
    target = _existing_doc(root, body.path)
    doc_body = _doc_body(target.read_text(encoding="utf-8"))
    blocks = await _attachment_blocks(session, body.ref_asset_ids, body.file_asset_ids)
    messages = _improve_messages(
        target.stem,
        doc_body,
        body.selection,
        body.instruction,
        blocks,
        _collection_of(body.path) == "software",
    )

    if not stream:
        text, model = "", ""
        try:
            async for ev in stream_text(IMPROVE_ALIAS, messages):
                if ev["type"] == "done":
                    text, model = ev["text"], ev["model"]
        except LLMUnavailable as exc:
            raise HTTPException(status_code=503, detail="LLM 网关未配置或不可用") from exc
        return {"text": text, "model": model}

    async def gen() -> AsyncGenerator[str, None]:
        try:
            async for ev in stream_text(IMPROVE_ALIAS, messages):
                if ev["type"] == "delta":
                    yield _sse("delta", {"type": "delta", "text": ev["text"]})
                elif ev["type"] == "done":
                    yield _sse("done", {"type": "done", "text": ev["text"], "model": ev["model"]})
        except LLMUnavailable:
            yield _sse("error", {"type": "error", "message": "LLM 网关未配置或不可用"})

    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)


class ApplyBody(BaseModel):
    path: str
    content: str
    # 打开文档时拿到的 mtime。写回是「以当时的 raw 为基底整篇覆盖」，
    # 期间文件被 Obsidian 改过的话，盲写等于把外部编辑静默回滚
    base_mtime: str | None = None


def _write_backup(backup_dir: Path, rel: Path, original: str) -> Path:
    """独占创建备份，绝不覆盖已有备份。

    时间戳只有秒粒度时，前端双击「应用」会在同一秒进来两次：第二次读到的
    「原文」已经是 AI 稿，同名 write_text 会把唯一一份真原文备份覆盖掉——
    「原文永远找得回来」就此失守。微秒 + open('x') 独占创建，撞名再撞名
    （虚拟化时钟粒度粗的极端情形）就递增后缀。
    """
    stem_dir = backup_dir / Path(str(rel)[: -len(".md")])
    stem_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d%H%M%S%f")
    for attempt in range(100):
        name = f"{stamp}.md" if attempt == 0 else f"{stamp}-{attempt}.md"
        path = stem_dir / name
        try:
            with path.open("x", encoding="utf-8") as f:
                f.write(original)
        except FileExistsError:
            continue
        return path
    raise HTTPException(status_code=500, detail="备份文件名冲突，放弃写回")


@router.post("/apply")
def apply_doc(body: ApplyBody) -> dict:
    """AI 完善 → 用户确认后的落盘步：先备份原文，再原子写回 vault。"""
    root = _root()
    target = _existing_doc(root, body.path)
    rel = _vault_relative(target, root)

    if body.base_mtime is not None:
        current = datetime.fromtimestamp(target.stat().st_mtime, tz=UTC).isoformat()
        if current != body.base_mtime:
            raise HTTPException(
                status_code=409, detail="文件在打开之后被外部修改过，刷新后重新完善"
            )

    backup_dir = Path(get_settings().grammar_docs_backup_dir)
    backup_path = _write_backup(backup_dir, rel, target.read_text(encoding="utf-8"))

    # 同目录临时文件 + rename：写一半崩掉也不会留下半篇讲义
    fd, tmp = tempfile.mkstemp(dir=target.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(body.content)
        os.replace(tmp, target)
    except BaseException:
        with suppress(FileNotFoundError):
            os.unlink(tmp)
        raise
    return {"ok": True, "backup": str(backup_path.relative_to(backup_dir))}


# ---- 划词批注 ----


def _occurrences(body: str, needle: str) -> list[int]:
    """全部出现位置。允许重叠：中文讲义里「的的」这类叠字用 str.split 会漏。"""
    out: list[int] = []
    at = body.find(needle)
    while at >= 0:
        out.append(at)
        at = body.find(needle, at + 1)
    return out


def relocate(
    body: str, quote: str, prefix: str, suffix: str, start_hint: int
) -> tuple[int, int] | None:
    """在当前正文里找回批注的落点，找不到返回 None。

    讲义允许 AI 改写后写回，存下的字符偏移随时会整体错位，而错位的高亮盖在
    别的句子上比不显示更糟——所以偏移只当提示，真正的判据是文本本身。

    一档：`prefix + quote + suffix` 整体匹配。同一句话在文中出现多次时（讲义里
    「见上文」「同理」这类重复很常见），前后各 32 字符足以把它们区分开。
    二档：改动落在前后文里、整体匹配不上时，退到只匹配 quote，取离 `start_hint`
    最近的一次——偏移已经不准，但「离原位最近」仍是能给出的最好猜测。
    """
    if not quote:
        return None
    hint = max(start_hint, 0)
    anchored = [pos + len(prefix) for pos in _occurrences(body, prefix + quote + suffix)]
    found = anchored or _occurrences(body, quote)
    if not found:
        return None
    start = min(found, key=lambda pos: abs(pos - hint))
    return start, start + len(quote)


def _current_body(root: Path, rel: str) -> str | None:
    """批注所指讲义的当前正文；文件被删/改名/移进归档目录时返回 None。

    这条路上不抛 400/404：批注还在库里，列出来告诉用户「找不到落点」，
    比让整个列表接口失败有用。
    """
    try:
        target = _resolve(root, rel)
    except HTTPException:
        return None
    if not target.is_file():
        return None
    return _doc_body(target.read_text(encoding="utf-8"))


def _annotation_dict(row: GrammarDocAnnotation, body: str | None) -> dict:
    span = (
        relocate(body, row.quote, row.prefix, row.suffix, row.start_hint)
        if body is not None
        else None
    )
    return {
        "id": row.id,
        "doc_path": row.doc_path,
        "quote": row.quote,
        "prefix": row.prefix,
        "suffix": row.suffix,
        "start_hint": row.start_hint,
        "note": row.note,
        "color": row.color,
        "ai_kind": row.ai_kind,
        "ai_result": row.ai_result,
        # 服务端现算的落点：前端据此上高亮，为 null 时提示「原文已变，找不到落点」
        "resolved_start": span[0] if span else None,
        "resolved_end": span[1] if span else None,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


class AnnotationCreate(BaseModel):
    path: str
    quote: str = Field(min_length=1)
    prefix: str = ""
    suffix: str = ""
    start_hint: int = Field(default=0, ge=0)
    color: str = Field(default="yellow", min_length=1, max_length=16)
    note: str | None = None


class AnnotationPatch(BaseModel):
    note: str | None = None
    color: str | None = Field(default=None, min_length=1, max_length=16)


@router.get("/annotations")
async def list_annotations(path: str, session: SessionDep) -> dict:
    root = _root()
    target = _existing_doc(root, path)
    body = _doc_body(target.read_text(encoding="utf-8"))
    rows = (
        (
            await session.execute(
                select(GrammarDocAnnotation)
                .where(GrammarDocAnnotation.doc_path == str(_vault_relative(target, root)))
                # 按创建时的偏移排，近似阅读顺序；重定位后的顺序由前端按 resolved_start 定
                .order_by(GrammarDocAnnotation.start_hint, GrammarDocAnnotation.id)
            )
        )
        .scalars()
        .all()
    )
    return {"items": [_annotation_dict(row, body) for row in rows]}


@router.post("/annotations")
async def create_annotation(body: AnnotationCreate, session: SessionDep) -> dict:
    root = _root()
    target = _existing_doc(root, body.path)
    row = GrammarDocAnnotation(
        doc_path=str(_vault_relative(target, root)),
        quote=body.quote,
        # 前后文只取贴着选区的那 32 字符：前端多送了也按这个口径截，
        # 否则同一条批注存的锚点长度不一致，relocate 的一档判据就不稳定
        prefix=body.prefix[-ANNOTATION_EDGE_CHARS:],
        suffix=body.suffix[:ANNOTATION_EDGE_CHARS],
        start_hint=body.start_hint,
        color=body.color,
        note=(body.note or "").strip() or None,
    )
    session.add(row)
    await session.commit()
    return _annotation_dict(row, _doc_body(target.read_text(encoding="utf-8")))


@router.patch("/annotations/{annotation_id}")
async def update_annotation(annotation_id: int, body: AnnotationPatch, session: SessionDep) -> dict:
    row = await session.get(GrammarDocAnnotation, annotation_id)
    if row is None:
        raise HTTPException(status_code=404, detail="批注不存在")
    if "color" in body.model_fields_set and body.color:
        row.color = body.color
    if "note" in body.model_fields_set:  # 显式传 null 表示清空批注
        row.note = (body.note or "").strip() or None
    await session.commit()
    # server onupdate 的 updated_at 在 UPDATE 后过期，主动刷新避免同步 IO 报错
    await session.refresh(row)
    return _annotation_dict(row, _current_body(_root(), row.doc_path))


@router.delete("/annotations/{annotation_id}")
async def delete_annotation(annotation_id: int, session: SessionDep) -> dict:
    row = await session.get(GrammarDocAnnotation, annotation_id)
    if row is None:
        raise HTTPException(status_code=404, detail="批注不存在")
    await session.delete(row)
    await session.commit()
    return {"ok": True}


ANALYZE_SYSTEM = (
    "你是英语语法讲义的讲解者，读者是中文母语的英语学习者。\n"
    "硬性要求：\n"
    "1. 全程中文讲解，开头第一句就是结论，不写背景铺垫；\n"
    "2. 不用「首先/其次/综上所述/值得注意的是」这类 AI 腔套话；\n"
    "3. 输出纯 Markdown 本体：不带代码围栏、不带解释性的前后缀。"
)

ANALYZE_TASKS = {
    "grammar": (
        "拆解下面这段的语法结构：主干是什么、各成分充当什么、时态语态与从句关系如何，"
        "有省略或倒装要点出来。"
    ),
    "explain": (
        "把下面这段讲透：它在说什么、为什么这么说、读者最容易在哪里理解错。"
        "举例说明时用能直接对上这段内容的例子。"
    ),
    "translate": (
        "给出下面这段的精准中文翻译。术语按它在讲义上下文里的用法译，"
        "宁可直白也不要意译到走样；译文之后可以补一两句难点说明。"
    ),
}


def _analyze_context(row: GrammarDocAnnotation, body: str | None) -> str:
    """批注原文在当前正文里的前后文。

    只把选区交给模型的话，代词指代、省略、承接上一句的主语全部无解——
    而「它指的是什么」恰恰是划词最常问的东西。正文里找不回落点时退用建批注
    时存下的那点前后文，聊胜于无。
    """
    span = relocate(body, row.quote, row.prefix, row.suffix, row.start_hint) if body else None
    if span is None:
        return f"{row.prefix}{row.quote}{row.suffix}"
    start, end = span
    return body[max(0, start - ANALYZE_CONTEXT_CHARS) : end + ANALYZE_CONTEXT_CHARS]


def _analyze_messages(kind: str, row: GrammarDocAnnotation, body: str | None) -> list[dict]:
    user = (
        f"{ANALYZE_TASKS[kind]}\n\n"
        f"【要分析的原文】\n{row.quote}\n\n"
        f"【它在讲义里的上下文，仅供你理解，不要分析上下文本身】\n{_analyze_context(row, body)}"
    )
    if row.note:
        user += f"\n\n【用户自己写的批注，回答时照顾他的关注点】\n{row.note}"
    return [{"role": "system", "content": ANALYZE_SYSTEM}, {"role": "user", "content": user}]


def _cached_analysis(row: GrammarDocAnnotation, kind: str) -> dict | None:
    """同 kind 且有正文才算命中——换了 kind 的旧结果不能顶上（ADR-006 的缓存口径）。"""
    if row.ai_kind != kind or not isinstance(row.ai_result, dict):
        return None
    return row.ai_result if row.ai_result.get("text") else None


def _ai_result(text: str, model: str) -> dict:
    return {"text": text, "model": model, "at": datetime.now(UTC).isoformat()}


def detached_session():
    """流式收尾落库用的 session。

    请求作用域那个在 SSE 生成器跑到 done 时已经在拆，再拿去 await 只会连带炸掉。
    单抽成函数是为了让 conftest 覆写它指向内存库（与 studio_gpt 同款）。
    """
    return SessionFactory()


async def _persist_analysis(annotation_id: int, kind: str, text: str, model: str) -> None:
    try:
        async with detached_session() as own:
            row = await own.get(GrammarDocAnnotation, annotation_id)
            if row is None:
                return
            row.ai_kind = kind
            row.ai_result = _ai_result(text, model)
            await own.commit()
    except Exception as exc:  # noqa: BLE001 — 缓存写失败不该连累已经吐给用户的正文
        logger.warning("批注分析结果落库失败 id=%s kind=%s: %s", annotation_id, kind, exc)


class AnalyzeBody(BaseModel):
    kind: str
    refresh: bool = False


@router.post("/annotations/{annotation_id}/analyze", response_model=None)
async def analyze_annotation(
    annotation_id: int, body: AnalyzeBody, session: SessionDep, stream: bool = False
) -> dict | StreamingResponse:
    """对一条批注做 AI 分析，结果按 kind 缓存在该行上，`refresh` 才重算。"""
    capability = ANALYZE_CAPABILITIES.get(body.kind)
    if capability is None:
        raise HTTPException(status_code=400, detail="kind 只能是 grammar / explain / translate")
    row = await session.get(GrammarDocAnnotation, annotation_id)
    if row is None:
        raise HTTPException(status_code=404, detail="批注不存在")

    kind = body.kind
    cached = None if body.refresh else _cached_analysis(row, kind)
    # 生成器跑起来时请求会话可能已在拆，ORM 属性一律先取成普通值
    row_id = row.id
    messages = [] if cached else _analyze_messages(kind, row, _current_body(_root(), row.doc_path))

    if not stream:
        if cached:
            return {"text": cached["text"], "model": cached.get("model", ""), "cached": True}
        text, model = "", ""
        try:
            async for ev in stream_text(capability, messages):
                if ev["type"] == "done":
                    text, model = ev["text"], ev["model"]
        except LLMUnavailable as exc:
            raise HTTPException(status_code=503, detail="LLM 网关未配置或不可用") from exc
        row.ai_kind, row.ai_result = kind, _ai_result(text, model)
        await session.commit()
        return {"text": text, "model": model, "cached": False}

    async def gen() -> AsyncGenerator[str, None]:
        if cached:
            # 缓存命中也按流式形状回，前端不必为两条路各写一套渲染
            yield _sse("delta", {"type": "delta", "text": cached["text"]})
            yield _sse(
                "done",
                {"type": "done", "text": cached["text"], "model": cached.get("model", "")},
            )
            return
        text, model = "", ""
        try:
            async for ev in stream_text(capability, messages):
                if ev["type"] == "delta":
                    yield _sse("delta", {"type": "delta", "text": ev["text"]})
                elif ev["type"] == "done":
                    text, model = ev["text"], ev["model"]
                    yield _sse("done", {"type": "done", "text": text, "model": model})
        except LLMUnavailable:
            yield _sse("error", {"type": "error", "message": "LLM 网关未配置或不可用"})
            return
        if text:
            await _persist_analysis(row_id, kind, text, model)

    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)
