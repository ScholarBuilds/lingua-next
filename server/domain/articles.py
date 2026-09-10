"""文章导入：纯文本分段 + 网页正文抽取 + 段落/句子落库（模块 02 扩展）。

落库函数与 parse_book 共用，保证书籍章节与独立文章的分句词元化口径一致（BR-01）。
"""

import re
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from domain.analysis import content_key
from domain.models import Article, Paragraph, Sentence
from domain.network_policy import routed_http_client
from domain.segmentation import split_sentences, tokenize


class ExtractError(Exception):
    """网页正文抽取失败（非 HTML / 反爬空壳 / 纯导航页）。"""


def utf16_slice(text: str, start: int, end: int) -> str:
    """按 UTF-16 码元偏移切片（句子/批注偏移口径，BR-01）。"""
    return text.encode("utf-16-le")[start * 2 : end * 2].decode("utf-16-le", errors="ignore")


def utf16_len(text: str) -> int:
    """文本的 UTF-16 码元长度（批注区间越界校验用）。"""
    return len(text.encode("utf-16-le")) // 2


@dataclass
class PlainParagraph:
    kind: str
    text: str


def split_plain_text(text: str) -> list[PlainParagraph]:
    """纯文本切段：优先按空行切；整体无空行时按单换行切；段内换行折叠为空格。"""
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    chunks = [c for c in normalized.split("\n\n") if c.strip()]
    if len(chunks) <= 1 and "\n" in normalized.strip():
        chunks = [line for line in normalized.split("\n") if line.strip()]
    paragraphs = []
    for chunk in chunks:
        collapsed = " ".join(chunk.split())
        if collapsed:
            paragraphs.append(PlainParagraph(kind="text", text=collapsed))
    return paragraphs


MIN_EXTRACT_CHARS = 80  # 短于此的"正文"多半是导航/提示文案，不是文章

# 老式网页（如 paulgraham.com）用连续 <br> 分段，trafilatura 会整篇折叠成一行：
# 抽取前把双 <br> 换成哨兵词，抽取后还原为空行
_BR_RUN_RE = re.compile(r"(?is)(?:<br[^>]*>\s*){2,}")
_PARA_SENTINEL = "⁋⁋"


def extract_html_article(html: str, url: str | None = None) -> tuple[str | None, str]:
    """trafilatura 抽取网页正文，返回 (标题, 正文纯文本)；抽不到正文抛 ExtractError。"""
    import trafilatura

    prepared = _BR_RUN_RE.sub(f" {_PARA_SENTINEL} ", html)
    text = trafilatura.extract(prepared, url=url, include_comments=False)
    if text and _PARA_SENTINEL[0] in text:
        parts = re.split(rf"\s*{_PARA_SENTINEL[0]}+\s*", text)
        text = "\n\n".join(part for part in (p.strip() for p in parts) if part)
    if text:
        # 表格布局页面（老站常见）trafilatura 会给单元格文本包 markdown 竖线，逐行剥掉
        text = "\n".join(
            re.sub(r"^\|\s*", "", line).rstrip("| ").rstrip() for line in text.split("\n")
        )
    if not text or len(text.strip()) < MIN_EXTRACT_CHARS:
        raise ExtractError("未能从页面抽取到正文（可能不是文章页或被反爬拦截）")
    title = None
    metadata = trafilatura.extract_metadata(html, default_url=url)
    if metadata is not None and metadata.title:
        title = metadata.title.strip()[:512] or None
    return title, text


async def persist_paragraphs(
    session: AsyncSession, article_id: int, paragraphs: list
) -> tuple[int, int]:
    """段落列表落库（词元化 + 分句），返回 (段落数, 句子数)。

    段落项只要求有 .kind/.text（ParsedParagraph 与 PlainParagraph 通用）。
    """
    saved_paragraphs = saved_sentences = 0
    for p_ord, para in enumerate(paragraphs):
        row = Paragraph(
            article_id=article_id,
            ordinal=p_ord,
            kind=para.kind,
            text=para.text,
            tokens=tokenize(para.text) if para.kind != "code" else [],
        )
        session.add(row)
        await session.flush()
        saved_paragraphs += 1
        if para.kind != "code":
            for s_ord, (start, end) in enumerate(split_sentences(para.text)):
                session.add(
                    Sentence(
                        paragraph_id=row.id,
                        ordinal=s_ord,
                        char_start=start,
                        char_end=end,
                        content_hash=content_key(para.text[start:end]),
                    )
                )
                saved_sentences += 1
    return saved_paragraphs, saved_sentences


async def replace_article_content(
    session: AsyncSession, article: Article, paragraphs: list
) -> tuple[int, int]:
    """重解析幂等：清掉旧段落（级联句子）后重新落库并置 ready。"""
    await session.execute(delete(Paragraph).where(Paragraph.article_id == article.id))
    counts = await persist_paragraphs(session, article.id, paragraphs)
    article.status = "ready"
    article.error = None
    return counts


async def fetch_url_html(url: str) -> str:
    """httpx 拉取网页 HTML，非 2xx 或非文本响应直接报错。"""

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
        )
    }
    async with routed_http_client(
        follow_redirects=True, timeout=30.0, headers=headers
    ) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        content_type = resp.headers.get("content-type", "")
        if content_type and "html" not in content_type and "text" not in content_type:
            raise ExtractError(f"目标不是网页（Content-Type: {content_type[:80]}）")
        return resp.text


def utcnow() -> datetime:
    return datetime.now(UTC)
