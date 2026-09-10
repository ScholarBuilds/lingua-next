"""书签（FR-377）：段落级位置锚点，与批注的区间锚定分开。

一个段落至多一枚书签（唯一约束兜底），重复插旗按幂等处理返回既有那枚。
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.owner import CurrentOwner
from app.routers.dict import SessionDep
from domain.models import Article, Bookmark, Paragraph

router = APIRouter(tags=["bookmarks"])

PREVIEW_CHARS = 160


class BookmarkCreate(BaseModel):
    article_id: int
    paragraph_id: int
    label: str | None = Field(default=None, max_length=120)


class BookmarkPatch(BaseModel):
    label: str | None = Field(default=None, max_length=120)


def _dump(b: Bookmark, ordinal: int | None = None) -> dict:
    return {
        "id": b.id,
        "article_id": b.article_id,
        "paragraph_id": b.paragraph_id,
        "paragraph_ordinal": ordinal,
        "preview": b.preview,
        "label": b.label,
        "created_at": b.created_at.isoformat() if b.created_at else None,
    }


@router.get("/articles/{article_id}/bookmarks")
async def list_bookmarks(article_id: int, owner: CurrentOwner, session: SessionDep) -> list[dict]:
    if await session.get(Article, article_id) is None:
        raise HTTPException(status_code=404, detail="article not found")
    rows = (
        await session.execute(
            select(Bookmark, Paragraph.ordinal)
            .join(Paragraph, Paragraph.id == Bookmark.paragraph_id)
            .where(Bookmark.user_id == owner.id, Bookmark.article_id == article_id)
            .order_by(Paragraph.ordinal)
        )
    ).all()
    return [_dump(b, ordinal) for b, ordinal in rows]


@router.post("/bookmarks", status_code=201)
async def create_bookmark(
    payload: BookmarkCreate, owner: CurrentOwner, session: SessionDep
) -> dict:
    paragraph = await session.get(Paragraph, payload.paragraph_id)
    if paragraph is None or paragraph.article_id != payload.article_id:
        raise HTTPException(status_code=404, detail="paragraph not in article")
    existing = (
        await session.execute(
            select(Bookmark).where(
                Bookmark.article_id == payload.article_id,
                Bookmark.paragraph_id == payload.paragraph_id,
                Bookmark.user_id == owner.id,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:  # 同段重复插旗视为已存在，不报错
        return _dump(existing, paragraph.ordinal)
    row = Bookmark(
        user_id=owner.id,
        article_id=payload.article_id,
        paragraph_id=payload.paragraph_id,
        preview=(paragraph.text or "")[:PREVIEW_CHARS],
        label=payload.label,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return _dump(row, paragraph.ordinal)


@router.patch("/bookmarks/{bookmark_id}")
async def update_bookmark(
    bookmark_id: int, payload: BookmarkPatch, owner: CurrentOwner, session: SessionDep
) -> dict:
    row = (
        await session.execute(
            select(Bookmark).where(Bookmark.id == bookmark_id, Bookmark.user_id == owner.id)
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="bookmark not found")
    row.label = payload.label
    await session.commit()
    return _dump(row)


@router.delete("/bookmarks/{bookmark_id}")
async def delete_bookmark(bookmark_id: int, owner: CurrentOwner, session: SessionDep) -> dict:
    row = (
        await session.execute(
            select(Bookmark).where(Bookmark.id == bookmark_id, Bookmark.user_id == owner.id)
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="bookmark not found")
    await session.delete(row)
    await session.commit()
    return {"ok": True}
