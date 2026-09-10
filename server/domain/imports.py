"""文档导入解析：PDF/TXT/MD → 章节/段落纯结构 + 自定义词表文本解析（不触库，可独立测试）。

结构复用 domain.epub 的 ParsedBook/ParsedChapter/ParsedParagraph，
worker 侧 parse_book/ingest_article 按扩展名分发后走同一条 persist_paragraphs 管线。
"""

import csv
import io
import json
import re
from pathlib import Path

from domain.epub import ParsedBook, ParsedChapter, ParsedParagraph

DOCUMENT_EXTS = {".pdf", ".txt", ".md"}
CHAPTER_CHUNK = 200  # 全书单章过长时按此段数切分，阅读器免加载超长页面


class DocumentParseError(Exception):
    """文档解析失败，message 直接面向用户展示。"""


class ScannedPdfError(DocumentParseError):
    """无文本层的扫描版 PDF。"""


def decode_text(data: bytes) -> str:
    """utf-8（含 BOM）优先，中文本地文件回退 gb18030，最后宽松解码兜底。"""
    for encoding in ("utf-8-sig", "gb18030"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def _chunk_chapters(
    chapters: list[ParsedChapter], chunk: int = CHAPTER_CHUNK
) -> list[ParsedChapter]:
    """全书只有一章且过长时按 ~chunk 段切多章。"""
    if len(chapters) != 1 or len(chapters[0].paragraphs) <= int(chunk * 1.5):
        return chapters
    paras = chapters[0].paragraphs
    base = chapters[0].title
    return [
        ParsedChapter(
            title=f"{base} · Part {i // chunk + 1}"[:200],
            paragraphs=paras[i : i + chunk],
        )
        for i in range(0, len(paras), chunk)
    ]


# ---------------------------------------------------------------- txt

_TXT_CHAPTER_RE = re.compile(
    r"^(chapter\s+(?:[0-9]+|[ivxlc]+)\b.*"
    r"|第\s*[0-9０-９一二三四五六七八九十百千零两]+\s*[章回节卷部篇].*)$",
    re.IGNORECASE,
)


def parse_txt(text: str, fallback_title: str) -> ParsedBook:
    """纯文本：空行分段；整体无空行时单换行分段；"Chapter X"/"第X章" 行分章。"""
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    per_line = "\n\n" not in normalized  # 整体无空行：单换行即分段
    chapters: list[ParsedChapter] = []
    buffer: list[str] = []

    def ensure_chapter() -> ParsedChapter:
        if not chapters:
            chapters.append(ParsedChapter(title=fallback_title[:200]))
        return chapters[-1]

    def flush() -> None:
        if not buffer:
            return
        joined = " ".join(" ".join(buffer).split())
        buffer.clear()
        if joined:
            ensure_chapter().paragraphs.append(ParsedParagraph(kind="text", text=joined))

    for line in normalized.split("\n"):
        stripped = line.strip()
        if not stripped:
            flush()
            continue
        if len(stripped) <= 100 and _TXT_CHAPTER_RE.match(stripped):
            flush()
            chapters.append(
                ParsedChapter(
                    title=stripped[:200],
                    paragraphs=[ParsedParagraph(kind="heading", text=stripped)],
                )
            )
            continue
        buffer.append(stripped)
        if per_line:
            flush()
    flush()
    chapters = [c for c in chapters if c.paragraphs]
    return ParsedBook(
        title=fallback_title, author=None, cover=None, chapters=_chunk_chapters(chapters)
    )


# ---------------------------------------------------------------- markdown

_MD_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
_MD_LIST_RE = re.compile(r"^\s{0,3}(?:[-*+]|\d{1,3}[.)])\s+(.*)$")
_MD_HR_RE = re.compile(r"^\s{0,3}([-*_])\s*(?:\1\s*){2,}$")
_MD_FENCE_RE = re.compile(r"^\s{0,3}(`{3,}|~{3,})\s*(\S*)\s*$")


def strip_md_inline(text: str) -> str:
    """剥离行内 markdown 语法：图片/链接留文字，粗体斜体去标记，行内代码去反引号。"""
    text = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"(\*\*|__)(.+?)\1", r"\2", text)
    text = re.sub(r"(?<!\w)([*_])([^*_]+?)\1(?!\w)", r"\2", text)
    text = re.sub(r"`([^`]*)`", r"\1", text)
    return text


def parse_md(text: str, fallback_title: str) -> ParsedBook:
    """Markdown：#/## 标题分章，###+ 作段内标题；语法剥离保留正文；围栏内容保留为 code 段。"""
    chapters: list[ParsedChapter] = []
    buffer: list[str] = []
    quote_buffer: list[str] = []
    code_lines: list[str] | None = None
    fence = ""

    def ensure_chapter() -> ParsedChapter:
        if not chapters:
            chapters.append(ParsedChapter(title=fallback_title[:200]))
        return chapters[-1]

    def flush_text() -> None:
        if not buffer:
            return
        joined = strip_md_inline(" ".join(" ".join(buffer).split())).strip()
        buffer.clear()
        if joined:
            ensure_chapter().paragraphs.append(ParsedParagraph(kind="text", text=joined))

    def flush_quote() -> None:
        if not quote_buffer:
            return
        joined = strip_md_inline(" ".join(" ".join(quote_buffer).split())).strip()
        quote_buffer.clear()
        if joined:
            ensure_chapter().paragraphs.append(ParsedParagraph(kind="quote", text=joined))

    def flush_code() -> None:
        nonlocal code_lines
        if code_lines is None:
            return
        content = "\n".join(code_lines).strip("\n")
        code_lines = None
        if content.strip():
            ensure_chapter().paragraphs.append(ParsedParagraph(kind="code", text=content))

    for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if code_lines is not None:
            m = _MD_FENCE_RE.match(line)
            if m and m.group(1)[0] == fence[0] and len(m.group(1)) >= len(fence):
                flush_code()
            else:
                code_lines.append(line)
            continue
        m = _MD_FENCE_RE.match(line)
        if m:
            flush_text()
            flush_quote()
            fence = m.group(1)
            code_lines = []
            continue
        stripped = line.strip()
        if not stripped:
            flush_text()
            flush_quote()
            continue
        hm = _MD_HEADING_RE.match(stripped)
        if hm:
            flush_text()
            flush_quote()
            title = strip_md_inline(hm.group(2)).strip()
            if not title:
                continue
            if len(hm.group(1)) <= 2:
                chapters.append(
                    ParsedChapter(
                        title=title[:200],
                        paragraphs=[ParsedParagraph(kind="heading", text=title)],
                    )
                )
            else:
                ensure_chapter().paragraphs.append(ParsedParagraph(kind="heading", text=title))
            continue
        if _MD_HR_RE.match(stripped):
            flush_text()
            flush_quote()
            continue
        if stripped.startswith(">"):
            flush_text()
            quote_buffer.append(stripped.lstrip("> ").strip())
            continue
        lm = _MD_LIST_RE.match(line)
        if lm:
            flush_text()
            flush_quote()
            item = strip_md_inline(lm.group(1)).strip()
            if item:
                ensure_chapter().paragraphs.append(ParsedParagraph(kind="text", text=item))
            continue
        flush_quote()
        buffer.append(stripped)
    flush_code()  # 未闭合围栏视为代码段
    flush_text()
    flush_quote()

    # 只有标题行没有正文的"空章"丢弃（同 epub 口径）
    def _not_empty(c: ParsedChapter) -> bool:
        return not (len(c.paragraphs) == 1 and c.paragraphs[0].kind == "heading")

    chapters = [c for c in chapters if _not_empty(c)]
    return ParsedBook(
        title=fallback_title, author=None, cover=None, chapters=_chunk_chapters(chapters)
    )


# ---------------------------------------------------------------- pdf

_PDF_INDENT_RE = re.compile(r"^(?:\s{2,}|\t)")


def pdf_page_paragraphs(page_text: str) -> list[ParsedParagraph]:
    """页文本 → 段落：空行分段，缩进行视为新段开头，连字符断词跨行合并。"""
    paragraphs: list[ParsedParagraph] = []
    buffer = ""

    def flush() -> None:
        nonlocal buffer
        collapsed = " ".join(buffer.split())
        buffer = ""
        if collapsed:
            paragraphs.append(ParsedParagraph(kind="text", text=collapsed))

    for line in page_text.split("\n"):
        stripped = line.strip()
        if not stripped:
            flush()
            continue
        if buffer and _PDF_INDENT_RE.match(line):
            flush()
        if buffer.endswith("-") and stripped[:1].islower():
            buffer = buffer[:-1] + stripped
        else:
            buffer = f"{buffer} {stripped}" if buffer else stripped
    flush()
    return paragraphs


def parse_pdf(path: str | Path, fallback_title: str) -> ParsedBook:
    """pypdf 逐页抽文本层；无文本层（扫描版）抛 ScannedPdfError。"""
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    pages = [page.extract_text() or "" for page in reader.pages]
    if not any(p.strip() for p in pages):
        raise ScannedPdfError("扫描版 PDF 暂不支持，需先 OCR")
    paragraphs: list[ParsedParagraph] = []
    for page_text in pages:
        paragraphs.extend(pdf_page_paragraphs(page_text))

    title, author = fallback_title, None
    try:
        meta = reader.metadata
        if meta is not None:
            title = (meta.title or "").strip()[:512] or fallback_title
            author = (meta.author or "").strip()[:256] or None
    except Exception:  # 元数据损坏不影响正文导入
        pass
    chapters = _chunk_chapters(
        [ParsedChapter(title=title[:200], paragraphs=paragraphs)]
    )
    return ParsedBook(title=title, author=author, cover=None, chapters=chapters)


def parse_document(path: str | Path, fallback_title: str) -> ParsedBook:
    """按扩展名分发 pdf/txt/md 解析，返回与 epub 同构的 ParsedBook。"""
    p = Path(path)
    ext = p.suffix.lower()
    if ext == ".pdf":
        return parse_pdf(p, fallback_title)
    text = decode_text(p.read_bytes())
    if ext == ".md":
        return parse_md(text, fallback_title)
    if ext == ".txt":
        return parse_txt(text, fallback_title)
    raise DocumentParseError(f"不支持的文件类型：{ext or '未知'}")


# ---------------------------------------------------------------- 自定义词表

_HEADER_WORDS = {"word", "单词", "词条"}


def _iter_delimited(content: str, delimiter: str):
    try:
        reader = csv.reader(io.StringIO(content), delimiter=delimiter)
        first = True
        for row in reader:
            line_no = reader.line_num
            if not row or not any(cell.strip() for cell in row):
                continue
            word = row[0].strip()
            translation = row[1].strip() if len(row) > 1 else None
            if first:
                first = False
                if word.lower() in _HEADER_WORDS:  # 表头行跳过
                    continue
            yield line_no, word, translation
    except csv.Error as exc:
        raise ValueError(f"CSV/TSV 解析失败：{exc}") from None


def _iter_json(content: str):
    try:
        data = json.loads(content)
    except json.JSONDecodeError as exc:
        raise ValueError(f"JSON 解析失败：{exc}") from None
    if not isinstance(data, list):
        raise ValueError('JSON 需为数组：[{"word", "translation"?}] 或 ["word"]')
    for i, item in enumerate(data, start=1):
        if isinstance(item, str):
            yield i, item, None
        elif isinstance(item, dict):
            translation = item.get("translation")
            yield i, str(item.get("word") or ""), (
                translation if isinstance(translation, str) else None
            )
        else:
            yield i, "", None  # 类型错误 → 记为无效行


def parse_wordlist(
    content: str, format: str
) -> tuple[list[tuple[str, str | None]], int, list[dict]]:
    """解析词表文本，返回 (去重条目 [(word, translation)], 重复数, 无效行 [{line, reason}])。

    word 统一 strip + 折叠空白 + 小写（与 vocab_entry/dict_entry 口径一致）。
    格式不合法（坏 JSON 等）抛 ValueError。
    """
    if format in ("csv", "tsv"):
        rows = _iter_delimited(content, "," if format == "csv" else "\t")
    elif format == "json":
        rows = _iter_json(content)
    else:
        raise ValueError(f"不支持的格式：{format}")

    items: list[tuple[str, str | None]] = []
    seen: set[str] = set()
    dup = 0
    invalid: list[dict] = []
    for line_no, word, translation in rows:
        word = " ".join((word or "").split()).lower()
        translation = (translation or "").strip() or None
        if not word:
            invalid.append({"line": line_no, "reason": "空词条或格式错误"})
            continue
        if len(word) > 128:
            invalid.append({"line": line_no, "reason": "词条超长（>128 字符）"})
            continue
        if word in seen:
            dup += 1
            continue
        seen.add(word)
        items.append((word, translation))
    return items, dup, invalid
