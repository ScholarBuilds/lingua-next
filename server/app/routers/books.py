import re
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import Response
from sqlalchemy import func, select

from app.config import get_settings
from app.media import media_response
from app.owner import CurrentOwner
from app.queue import get_queue
from app.routers.dict import SessionDep
from app.routers.progress import progress_state
from domain.import_dispatch import record_import, try_dispatch
from domain.models import (
    AnalysisResult,
    Annotation,
    Article,
    Book,
    Paragraph,
    ReadingProgress,
    Sentence,
    VocabOccurrence,
)
from domain.storage import get_storage

router = APIRouter(tags=["books"])

BOOK_EXTS = {".epub", ".pdf", ".txt", ".md"}


def _slugify(name: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "book"
    return f"{base[:80]}-{uuid.uuid4().hex[:6]}"


@router.post("/books/upload", status_code=201)
async def upload_book(file: UploadFile, session: SessionDep) -> dict:
    ext = Path(file.filename or "").suffix.lower()
    if ext not in BOOK_EXTS:
        raise HTTPException(status_code=400, detail="仅支持 epub/pdf/txt/md")
    slug = _slugify(Path(file.filename).stem)
    file_key = f"books/{slug}{ext}"
    # 走 storage：写盘在线程池里做，不阻塞事件循环；临时文件 + rename 保证原子
    await get_storage().write(file_key, await file.read())

    book = Book(slug=slug, title=Path(file.filename).stem, file_key=file_key, status="pending")
    session.add(book)
    await session.flush()
    await record_import(session, "parse_book", book.id)
    await session.commit()
    await try_dispatch(session)
    return {"id": book.id, "slug": slug, "status": "pending"}


@router.get("/books")
async def list_books(owner: CurrentOwner, session: SessionDep) -> list[dict]:
    stmt = select(Book).order_by(Book.created_at.desc())
    books = (await session.execute(stmt)).scalars().all()
    # 三条聚合 SQL 覆盖全部书籍，避免 N+1：段落总数 / 已读段数+最近时间 / 最近打开章节
    totals = dict(
        (
            await session.execute(
                select(Article.book_id, func.count(Paragraph.id))
                .join(Paragraph, Paragraph.article_id == Article.id)
                .where(Article.book_id.is_not(None))
                .group_by(Article.book_id)
            )
        ).all()
    )
    # read_paragraphs 每章一行且数组内已去重，sum(数组长度) 即全书去重已读段数
    progress_rows = (
        await session.execute(
            select(
                Article.book_id,
                ReadingProgress.read_paragraphs,
                ReadingProgress.updated_at,
            )
            .join(ReadingProgress, ReadingProgress.article_id == Article.id)
            .where(
                Article.book_id.is_not(None),
                ReadingProgress.user_id == owner.id,
            )
        )
    ).all()
    reads: dict[int, tuple[int, datetime | None]] = {}
    for book_id, ordinals, opened in progress_rows:
        read, latest = reads.get(book_id, (0, None))
        reads[book_id] = (
            read + len(set(ordinals or [])),
            opened if latest is None or (opened is not None and opened > latest) else latest,
        )
    last_articles = dict(
        (
            await session.execute(
                select(Article.book_id, ReadingProgress.article_id)
                .join(ReadingProgress, ReadingProgress.article_id == Article.id)
                .where(
                    Article.book_id.is_not(None),
                    ReadingProgress.user_id == owner.id,
                )
                .distinct(Article.book_id)
                .order_by(Article.book_id, ReadingProgress.updated_at.desc())
            )
        ).all()
    )
    media_root = Path(get_settings().media_root)
    out = []
    for b in books:
        read, opened = reads.get(b.id, (0, None))
        pct, state = progress_state(read, totals.get(b.id, 0))
        cover_url = None
        if b.cover_key:
            # 带版本参数：封面换了 URL 才变，浏览器缓存才会失效。
            # 少了它，替换封面后用户看到的还是旧图（同名 URL 命中强缓存）。
            cover_url = f"/api/books/{b.id}/cover?v={_cover_version(media_root / b.cover_key)}"
        out.append(
            {
                "id": b.id,
                "slug": b.slug,
                "title": b.title,
                "author": b.author,
                "status": b.status,
                "error": b.error,
                "source": b.source,
                "difficulty": b.difficulty,
                "tags": b.tags or [],
                "blurb": b.blurb,
                "external_id": b.external_id,
                "cover_url": cover_url,
                "progress_pct": pct,
                "state": state,
                "last_article_id": last_articles.get(b.id),
                "last_opened_at": opened.isoformat() if opened else None,
            }
        )
    return out


def _cover_version(path: Path) -> str:
    """封面版本号：取文件 mtime 的整数秒，换图必变、不换图恒定。"""
    try:
        return str(int(path.stat().st_mtime))
    except OSError:
        return "0"


def _image_mime(path: Path) -> str:
    """按文件头判断图片类型（封面落盘时统一叫 .img，扩展名不带信息）。"""
    head = path.open("rb").read(12)
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head.startswith(b"GIF8"):
        return "image/gif"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if head.startswith(b"<svg") or head.startswith(b"<?xml"):
        return "image/svg+xml"
    return "image/jpeg"


@router.get("/books/{book_id}/cover")
async def book_cover(book_id: int, session: SessionDep) -> Response:
    book = await session.get(Book, book_id)
    if book is None or not book.cover_key:
        raise HTTPException(status_code=404, detail="no cover")  # 前端回落程序化封面
    path = Path(get_settings().media_root) / book.cover_key
    if not path.exists():
        raise HTTPException(status_code=404, detail="no cover")
    # 封面统一存成 .img，扩展名猜不出类型；按文件头嗅探给真实 MIME
    return media_response(
        book.cover_key,
        media_type=_image_mime(path),
        cache_control="public, max-age=604800",
    )


@router.get("/books/{book_id}/chapters")
async def list_chapters(book_id: int, session: SessionDep) -> list[dict]:
    if await session.get(Book, book_id) is None:
        raise HTTPException(status_code=404, detail="book not found")
    stmt = (
        select(Article, func.count(Paragraph.id))
        .outerjoin(Paragraph, Paragraph.article_id == Article.id)
        .where(Article.book_id == book_id)
        .group_by(Article.id)
        .order_by(Article.ordinal)
    )
    return [
        {"id": a.id, "ordinal": a.ordinal, "title": a.title, "paragraphs": count}
        for a, count in (await session.execute(stmt)).all()
    ]


@router.delete("/books/{book_id}")
async def delete_book(book_id: int, session: SessionDep, force: bool = False) -> dict:
    book = await session.get(Book, book_id)
    if book is None:
        raise HTTPException(status_code=404, detail="book not found")
    article_ids = select(Article.id).where(Article.book_id == book_id).scalar_subquery()
    annotations = (
        await session.execute(
            select(func.count())
            .select_from(Annotation)
            .where(Annotation.article_id.in_(article_ids))
        )
    ).scalar_one()
    occurrences = (
        await session.execute(
            select(func.count())
            .select_from(VocabOccurrence)
            .where(VocabOccurrence.article_id.in_(article_ids))
        )
    ).scalar_one()
    if (annotations or occurrences) and not force:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "书内尚有批注或生词语境，确认后用 ?force=true 强删",
                "annotations": annotations,
                "vocab_occurrences": occurrences,
            },
        )
    # 媒体文件清理：原件 + 封面（生词 occurrence 保留语境文本，不随书删除）
    storage = get_storage()
    for key in (book.file_key, book.cover_key):
        if key:
            await storage.delete(key)
    await session.delete(book)  # DB 级联：article → paragraph/sentence/annotation/progress
    await session.commit()
    return {"ok": True, "annotations": annotations, "vocab_occurrences": occurrences}


@router.get("/articles/{article_id}")
async def article_payload(article_id: int, owner: CurrentOwner, session: SessionDep) -> dict:
    article = await session.get(Article, article_id)
    if article is None:
        raise HTTPException(status_code=404, detail="article not found")
    paragraphs = (
        (
            await session.execute(
                select(Paragraph)
                .where(Paragraph.article_id == article_id)
                .order_by(Paragraph.ordinal)
            )
        )
        .scalars()
        .all()
    )
    para_ids = [p.id for p in paragraphs]
    sentences: dict[int, list] = {}
    if para_ids:
        for s in (
            await session.execute(
                select(Sentence)
                .where(Sentence.paragraph_id.in_(para_ids))
                .order_by(Sentence.paragraph_id, Sentence.ordinal)
            )
        ).scalars():
            sentences.setdefault(s.paragraph_id, []).append(
                [s.id, s.char_start, s.char_end, s.content_hash]
            )
    progress = (
        await session.execute(
            select(ReadingProgress).where(
                ReadingProgress.user_id == owner.id,
                ReadingProgress.article_id == article_id,
            )
        )
    ).scalar_one_or_none()
    return {
        "id": article.id,
        "title": article.title,
        "book_id": article.book_id,
        "ordinal": article.ordinal,
        "progress": {
            "last_paragraph_ordinal": progress.last_paragraph_ordinal,
            "read_paragraph_ordinals": progress.read_paragraphs or [],
            "duration_s": progress.duration_s,
        }
        if progress
        else None,
        "paragraphs": [
            {
                "id": p.id,
                "ordinal": p.ordinal,
                "kind": p.kind,
                "text": p.text,
                "tokens": p.tokens or [],
                "sentences": sentences.get(p.id, []),
            }
            for p in paragraphs
        ],
    }


@router.post("/articles/{article_id}/translate", status_code=202)
async def enqueue_translate(article_id: int, session: SessionDep, engine: str = "auto") -> dict:
    if await session.get(Article, article_id) is None:
        raise HTTPException(status_code=404, detail="article not found")
    queue = await get_queue()
    job = await queue.enqueue_job(
        "translate_article", article_id, engine, _job_id=f"translate_article:{article_id}"
    )
    # 同 id 任务在队列或结果保留期内 → arq 返回 None，视为已在处理
    return {"queued": job is not None, "article_id": article_id, "engine": engine}


@router.get("/articles/{article_id}/translations")
async def article_translations(article_id: int, session: SessionDep) -> dict:
    if await session.get(Article, article_id) is None:
        raise HTTPException(status_code=404, detail="article not found")
    sentence_rows = (
        await session.execute(
            select(Sentence.id, Sentence.content_hash)
            .join(Paragraph, Sentence.paragraph_id == Paragraph.id)
            .where(Paragraph.article_id == article_id)
        )
    ).all()
    hashes = {h for _, h in sentence_rows}
    if not hashes:
        return {"translations": {}}
    cached = (
        await session.execute(
            select(AnalysisResult.content_hash, AnalysisResult.result).where(
                AnalysisResult.scope == "sentence",
                AnalysisResult.kind == "translate",
                AnalysisResult.content_hash.in_(hashes),
                AnalysisResult.is_active,
            )
        )
    ).all()
    by_hash = {h: r.get("text") for h, r in cached}
    return {"translations": {sid: by_hash[h] for sid, h in sentence_rows if h in by_hash}}
