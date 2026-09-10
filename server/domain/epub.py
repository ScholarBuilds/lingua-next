"""epub 解析：文件 → 章节/段落纯结构（不触库，可独立测试）。"""

from dataclasses import dataclass, field

from ebooklib import ITEM_COVER, ITEM_DOCUMENT, ITEM_IMAGE, epub
from lxml import html as lxml_html

BLOCK_TAGS = {"p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "pre", "td"}
HEADING_TAGS = {"h1", "h2", "h3", "h4", "h5", "h6"}


@dataclass
class ParsedParagraph:
    kind: str  # text | heading | code | quote
    text: str


@dataclass
class ParsedChapter:
    title: str
    paragraphs: list[ParsedParagraph] = field(default_factory=list)


@dataclass
class ParsedBook:
    title: str
    author: str | None
    cover: bytes | None
    chapters: list[ParsedChapter] = field(default_factory=list)


def _kind(tag: str) -> str:
    if tag in HEADING_TAGS:
        return "heading"
    if tag == "pre":
        return "code"
    if tag == "blockquote":
        return "quote"
    return "text"


SPLIT_HEADINGS = {"h1", "h2", "h3"}


def _blocks_from_html(raw: bytes) -> list[tuple[str, str, str]]:
    """返回 [(tag, kind, text)]，只取顶层块。"""
    tree = lxml_html.fromstring(raw)
    for bad in tree.xpath("//script|//style"):
        bad.getparent().remove(bad)
    blocks: list[tuple[str, str, str]] = []
    for el in tree.iter():
        if not isinstance(el.tag, str) or el.tag not in BLOCK_TAGS:
            continue
        # 跳过嵌套块（如 blockquote 里的 p 由外层统一收集）
        parent = el.getparent()
        while parent is not None:
            if isinstance(parent.tag, str) and parent.tag in BLOCK_TAGS:
                break
            parent = parent.getparent()
        if parent is not None:
            continue
        text = " ".join(el.text_content().split())
        if not text:
            continue  # 空块丢弃；短段落必须保留（诗歌/题词，模块02 FR-08）
        blocks.append((el.tag, _kind(el.tag), text))
    return blocks


def _chapters_from_html(raw: bytes, fallback_title: str) -> list[ParsedChapter]:
    """一个 spine 文档可能塞多章（Gutenberg 常见），按 h1-h3 标题拆分。"""
    blocks = _blocks_from_html(raw)
    if not blocks:
        return []
    chapters: list[ParsedChapter] = []
    current: ParsedChapter | None = None
    for tag, kind, text in blocks:
        if tag in SPLIT_HEADINGS:
            current = ParsedChapter(title=text[:200])
            current.paragraphs.append(ParsedParagraph(kind=kind, text=text))
            chapters.append(current)
        else:
            if current is None:
                current = ParsedChapter(title=fallback_title)
                chapters.append(current)
            current.paragraphs.append(ParsedParagraph(kind=kind, text=text))
    # 标题行之外没有正文的"空章"（如目录页连续标题）：仅 1 段且是标题的丢弃
    def _not_empty(c: ParsedChapter) -> bool:
        return not (len(c.paragraphs) == 1 and c.paragraphs[0].kind == "heading")

    return [c for c in chapters if _not_empty(c)]


def parse_epub(path: str) -> ParsedBook:
    book = epub.read_epub(path, options={"ignore_ncx": True})
    title = (book.get_metadata("DC", "title") or [("未命名", {})])[0][0]
    creators = book.get_metadata("DC", "creator")
    author = creators[0][0] if creators else None

    cover: bytes | None = None
    for item in book.get_items_of_type(ITEM_COVER):
        cover = item.get_content()
        break
    if cover is None:
        for item in book.get_items_of_type(ITEM_IMAGE):
            if "cover" in item.get_name().lower():
                cover = item.get_content()
                break

    docs = {item.get_name(): item for item in book.get_items_of_type(ITEM_DOCUMENT)}
    chapters: list[ParsedChapter] = []
    seen: set[str] = set()
    for spine_id, _linear in book.spine:
        item = book.get_item_with_id(spine_id)
        if item is None or item.get_name() in seen or item.get_name() not in docs:
            continue
        seen.add(item.get_name())
        chapters.extend(_chapters_from_html(item.get_content(), f"Chapter {len(chapters) + 1}"))
    return ParsedBook(title=title, author=author, cover=cover, chapters=chapters)
