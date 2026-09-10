"""批注：段落 + UTF-16 char 区间锚定（与词元同口径），支持 markdown 导出（模块 02）。"""

from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.owner import CurrentOwner
from app.routers.dict import SessionDep
from domain.articles import utf16_len, utf16_slice
from domain.models import Annotation, Article, Paragraph

router = APIRouter(tags=["annotations"])


class AnnotationCreate(BaseModel):
    article_id: int
    paragraph_id: int
    char_start: int = Field(ge=0)
    char_end: int = Field(gt=0)
    color: str = Field(default="yellow", min_length=1, max_length=16)
    note: str | None = None


class AnnotationPatch(BaseModel):
    color: str | None = Field(default=None, min_length=1, max_length=16)
    note: str | None = None


def _annotation_dict(a: Annotation, paragraph_ordinal: int | None = None) -> dict:
    out = {
        "id": a.id,
        "article_id": a.article_id,
        "paragraph_id": a.paragraph_id,
        "char_start": a.char_start,
        "char_end": a.char_end,
        "color": a.color,
        "note": a.note,
        "created_at": a.created_at.isoformat() if a.created_at else None,
        "updated_at": a.updated_at.isoformat() if a.updated_at else None,
    }
    if paragraph_ordinal is not None:
        out["paragraph_ordinal"] = paragraph_ordinal
    return out


@router.post("/annotations", status_code=201)
async def create_annotation(
    body: AnnotationCreate, owner: CurrentOwner, session: SessionDep
) -> dict:
    paragraph = await session.get(Paragraph, body.paragraph_id)
    if paragraph is None or paragraph.article_id != body.article_id:
        raise HTTPException(status_code=400, detail="段落不存在或不属于该文章")
    if body.char_end <= body.char_start or body.char_end > utf16_len(paragraph.text):
        raise HTTPException(status_code=400, detail="char 区间越界（UTF-16 码元口径）")
    annotation = Annotation(
        user_id=owner.id,
        article_id=body.article_id,
        paragraph_id=body.paragraph_id,
        char_start=body.char_start,
        char_end=body.char_end,
        color=body.color,
        note=(body.note or "").strip() or None,
    )
    session.add(annotation)
    await session.commit()
    return _annotation_dict(annotation, paragraph.ordinal)


@router.get("/articles/{article_id}/annotations")
async def list_annotations(article_id: int, owner: CurrentOwner, session: SessionDep) -> list[dict]:
    if await session.get(Article, article_id) is None:
        raise HTTPException(status_code=404, detail="article not found")
    rows = (
        await session.execute(
            select(Annotation, Paragraph.ordinal)
            .join(Paragraph, Annotation.paragraph_id == Paragraph.id)
            .where(Annotation.user_id == owner.id, Annotation.article_id == article_id)
            .order_by(Paragraph.ordinal, Annotation.char_start, Annotation.id)
        )
    ).all()
    return [_annotation_dict(a, ordinal) for a, ordinal in rows]


@router.patch("/annotations/{annotation_id}")
async def update_annotation(
    annotation_id: int, body: AnnotationPatch, owner: CurrentOwner, session: SessionDep
) -> dict:
    annotation = (
        await session.execute(
            select(Annotation).where(
                Annotation.id == annotation_id, Annotation.user_id == owner.id
            )
        )
    ).scalar_one_or_none()
    if annotation is None:
        raise HTTPException(status_code=404, detail="annotation not found")
    if "color" in body.model_fields_set and body.color:
        annotation.color = body.color
    if "note" in body.model_fields_set:  # 显式传 null 表示清空笔记
        annotation.note = (body.note or "").strip() or None
    await session.commit()
    # server onupdate 的 updated_at 在 UPDATE 后过期，主动刷新避免同步 IO 报错
    await session.refresh(annotation)
    return _annotation_dict(annotation)


@router.delete("/annotations/{annotation_id}")
async def delete_annotation(annotation_id: int, owner: CurrentOwner, session: SessionDep) -> dict:
    annotation = (
        await session.execute(
            select(Annotation).where(
                Annotation.id == annotation_id, Annotation.user_id == owner.id
            )
        )
    ).scalar_one_or_none()
    if annotation is None:
        raise HTTPException(status_code=404, detail="annotation not found")
    await session.delete(annotation)
    await session.commit()
    return {"ok": True}


@router.get("/annotations/export")
async def export_annotations(
    article_id: int, owner: CurrentOwner, session: SessionDep
) -> PlainTextResponse:
    article = await session.get(Article, article_id)
    if article is None:
        raise HTTPException(status_code=404, detail="article not found")
    rows = (
        await session.execute(
            select(Annotation, Paragraph)
            .join(Paragraph, Annotation.paragraph_id == Paragraph.id)
            .where(Annotation.user_id == owner.id, Annotation.article_id == article_id)
            .order_by(Paragraph.ordinal, Annotation.char_start, Annotation.id)
        )
    ).all()
    lines = [f"# {article.title} · 批注", "", f"共 {len(rows)} 条。"]
    for annotation, paragraph in rows:
        excerpt = utf16_slice(paragraph.text, annotation.char_start, annotation.char_end)
        lines += ["", "---", "", f"> {excerpt}", ""]
        lines.append(f"- 位置：第 {paragraph.ordinal + 1} 段")
        lines.append(f"- 颜色：{annotation.color}")
        if annotation.note:
            lines.append(f"- 笔记：{annotation.note}")
    return PlainTextResponse(
        "\n".join(lines) + "\n", media_type="text/markdown; charset=utf-8"
    )
