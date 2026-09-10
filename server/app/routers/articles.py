"""独立文章接口：粘贴/URL/文件导入、列表与删除（模块 02 扩展）。

章节读取接口（GET /articles/{id}）沿用 books.py，本路由只管独立文章生命周期。
POST /articles 同一路径双协议：JSON（url/paste）与 multipart（kind=file 单文件）。
"""

import json
from pathlib import Path
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ValidationError
from sqlalchemy import func, select
from starlette.datastructures import UploadFile

from app.routers.dict import SessionDep
from app.routers.progress import progress_state
from domain.articles import replace_article_content, split_plain_text
from domain.import_dispatch import record_import, try_dispatch
from domain.models import Article, Paragraph, ReadingProgress
from domain.storage import get_storage

router = APIRouter(tags=["articles"])

KINDS = ("url", "paste", "file")
FILE_EXTS = {".txt", ".md", ".pdf"}


class ArticleCreate(BaseModel):
    kind: str
    url: str | None = None
    title: str | None = None
    text: str | None = None


def _derive_title(explicit: str | None, first_paragraph: str) -> str:
    if explicit and explicit.strip():
        return explicit.strip()[:512]
    words = first_paragraph.split()
    title = " ".join(words[:12])[:100]
    return title + ("…" if len(words) > 12 else "")


async def _create_file_article(upload: UploadFile, title: str | None, session: SessionDep) -> dict:
    ext = Path(upload.filename or "").suffix.lower()
    if ext not in FILE_EXTS:
        raise HTTPException(status_code=400, detail="文件文章仅支持 txt/md/pdf")
    stem = Path(upload.filename or "article").stem
    article = Article(
        book_id=None,
        ordinal=0,
        title=((title or "").strip() or stem)[:512],
        source_kind="file",
        status="pending",
    )
    session.add(article)
    await session.flush()
    file_key = f"articles/{article.id}{ext}"
    await get_storage().write(file_key, await upload.read())
    article.file_key = file_key
    await record_import(session, "ingest_article", article.id)
    await session.commit()
    await try_dispatch(session)
    return {"id": article.id, "status": article.status}


@router.post("/articles", status_code=201)
async def create_article(request: Request, session: SessionDep) -> dict:
    content_type = (request.headers.get("content-type") or "").lower()
    if content_type.startswith("multipart/form-data"):
        form = await request.form()
        kind = form.get("kind") or "file"
        if kind != "file":
            raise HTTPException(status_code=400, detail="multipart 仅支持 kind=file")
        upload = form.get("file")
        if not isinstance(upload, UploadFile):
            raise HTTPException(status_code=400, detail="缺少 file 文件字段")
        title = form.get("title")
        return await _create_file_article(
            upload, title if isinstance(title, str) else None, session
        )

    try:
        body = ArticleCreate.model_validate(await request.json())
    except (ValidationError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
    if body.kind not in KINDS:
        raise HTTPException(status_code=400, detail=f"kind 仅支持 {'/'.join(KINDS)}")
    if body.kind == "file":
        raise HTTPException(status_code=400, detail="kind=file 需用 multipart/form-data 上传文件")

    if body.kind == "paste":
        text = (body.text or "").strip()
        if not text:
            raise HTTPException(status_code=400, detail="text 不能为空")
        paragraphs = split_plain_text(text)
        if not paragraphs:
            raise HTTPException(status_code=400, detail="正文为空，没有可入库的段落")
        article = Article(
            book_id=None,
            ordinal=0,
            title=_derive_title(body.title, paragraphs[0].text),
            source_kind="paste",
            status="parsing",
        )
        session.add(article)
        await session.flush()
        # 粘贴文本量小，同步解析入库，返回即可读
        await replace_article_content(session, article, paragraphs)
        await session.commit()
        return {"id": article.id, "status": article.status}

    url = (body.url or "").strip()
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise HTTPException(status_code=400, detail="仅支持 http/https 链接")
    # 同 URL 已落库不重抓（BR）：直接返回已有文章
    existing = (
        await session.execute(
            select(Article)
            .where(Article.book_id.is_(None), Article.source_url == url)
            .order_by(Article.id.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if existing is not None:
        if existing.status in {"pending", "failed"}:
            existing.status = "pending"
            await record_import(session, "ingest_article", existing.id)
            await session.commit()
            await try_dispatch(session)
        return {"id": existing.id, "status": existing.status, "existed": True}

    article = Article(
        book_id=None,
        ordinal=0,
        title=(body.title or "").strip()[:512] or url,
        source_kind="url",
        source_url=url,
        status="pending",
    )
    session.add(article)
    await session.flush()
    await record_import(session, "ingest_article", article.id)
    await session.commit()
    await try_dispatch(session)
    return {"id": article.id, "status": article.status}


@router.get("/articles")
async def list_articles(session: SessionDep, standalone: int = 1) -> list[dict]:
    array_length = (
        func.jsonb_array_length
        if session.get_bind().dialect.name == "postgresql"
        else func.json_array_length
    )
    word_count = func.coalesce(func.sum(array_length(Paragraph.tokens)), 0)
    para_count = func.count(func.distinct(Paragraph.id))
    # ReadingProgress 与 Article 1:1，max 取到该行的已读段数（数组内已去重）
    read_count = func.coalesce(func.max(array_length(ReadingProgress.read_paragraphs)), 0)
    stmt = (
        select(Article, word_count, para_count, read_count)
        .outerjoin(Paragraph, Paragraph.article_id == Article.id)
        .outerjoin(ReadingProgress, ReadingProgress.article_id == Article.id)
        .group_by(Article.id)
        .order_by(Article.created_at.desc(), Article.id.desc())
    )
    if standalone:
        stmt = stmt.where(Article.book_id.is_(None))
    # 场景短文不进书架：它属于某个单词本，入口在词库那边（FR-264）
    stmt = stmt.where(Article.source_kind != "scenario")
    out = []
    for a, count, paras, read in (await session.execute(stmt)).all():
        pct, state = progress_state(int(read), int(paras))
        out.append(
            {
                "id": a.id,
                "title": a.title,
                "source_kind": a.source_kind,
                "source_url": a.source_url,
                "status": a.status,
                "error": a.error,
                "word_count": int(count),
                "progress_pct": pct,
                "state": state,
                "created_at": a.created_at.isoformat() if a.created_at else None,
            }
        )
    return out


@router.delete("/articles/{article_id}")
async def delete_article(article_id: int, session: SessionDep) -> dict:
    article = await session.get(Article, article_id)
    if article is None:
        raise HTTPException(status_code=404, detail="article not found")
    if article.book_id is not None:
        raise HTTPException(status_code=409, detail="书籍章节不可单独删除，请删除整本书")
    if article.file_key:  # file 文章连原件一起清理
        await get_storage().delete(article.file_key)
    await session.delete(article)
    await session.commit()
    return {"ok": True}
