"""数据导出：生词本 CSV 与 Anki 牌组（模块 04 扩展）。"""

import csv
import io
import os
import re
import tempfile
from collections.abc import Iterator

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.background import BackgroundTask

from app.routers.dict import SessionDep
from domain.models import Article, Book, DictEntry, VocabEntry, VocabOccurrence

router = APIRouter(prefix="/export", tags=["export"])

CSV_HEADER = ["word", "phonetic", "translation", "context", "source_label", "status", "created_at"]

# genanki 要求全局唯一的随机 id，一次生成后固定，保证重复导出可增量合并
ANKI_MODEL_ID = 1707392460
ANKI_DECK_ID = 2059400110


async def _collect_rows(session: AsyncSession) -> list[dict]:
    """拼装导出行：词条 + 词典释义 + 最近语境 + 来源标签。"""
    entries = (
        (await session.execute(select(VocabEntry).order_by(VocabEntry.created_at.asc())))
        .scalars()
        .all()
    )
    if not entries:
        return []

    lookup_words = {e.word for e in entries} | {e.lemma for e in entries if e.lemma}
    dict_map = {
        d.word: d
        for d in (
            await session.execute(select(DictEntry).where(DictEntry.word.in_(lookup_words)))
        ).scalars()
    }
    # 按 added_at 升序覆盖写，留下的即每词最近一条语境
    latest_occ: dict[int, VocabOccurrence] = {}
    for occ in (
        await session.execute(select(VocabOccurrence).order_by(VocabOccurrence.added_at.asc()))
    ).scalars():
        latest_occ[occ.vocab_id] = occ

    article_ids = {o.article_id for o in latest_occ.values() if o.article_id is not None}
    labels: dict[int, str] = {}
    if article_ids:
        rows = await session.execute(
            select(Article.id, Article.title, Book.title)
            .outerjoin(Book, Book.id == Article.book_id)
            .where(Article.id.in_(article_ids))
        )
        for article_id, article_title, book_title in rows.all():
            labels[article_id] = (
                f"{book_title} · {article_title}" if book_title else article_title
            )

    result = []
    for entry in entries:
        dict_entry = dict_map.get(entry.word)
        if dict_entry is None and entry.lemma:
            dict_entry = dict_map.get(entry.lemma)
        occ = latest_occ.get(entry.id)
        result.append(
            {
                "word": entry.word,
                "phonetic": dict_entry.phonetic if dict_entry else "",
                "translation": dict_entry.translation if dict_entry else "",
                "context": occ.context_text if occ else "",
                "source_label": (
                    labels.get(occ.article_id, "") if occ and occ.article_id else ""
                ),
                "status": entry.status,
                "created_at": entry.created_at.isoformat() if entry.created_at else "",
            }
        )
    return result


def _iter_csv(rows: list[dict]) -> Iterator[str]:
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=CSV_HEADER)
    yield "\ufeff"  # UTF-8 BOM：Excel 打开不乱码
    writer.writeheader()
    yield buf.getvalue()
    for row in rows:
        buf.seek(0)
        buf.truncate()
        writer.writerow(row)
        yield buf.getvalue()


@router.get("/vocab.csv")
async def export_csv(session: SessionDep) -> StreamingResponse:
    rows = await _collect_rows(session)
    return StreamingResponse(
        _iter_csv(rows),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="lingua-vocab.csv"'},
    )


def _highlight(context: str, word: str) -> str:
    """语境里加粗目标词（含词形大小写变体）。"""
    if not context or not word:
        return context
    return re.sub(
        rf"\b({re.escape(word)}\w*)", r"<b>\1</b>", context, flags=re.IGNORECASE
    )


def _build_apkg(rows: list[dict], dest_path: str) -> None:
    import genanki

    model = genanki.Model(
        ANKI_MODEL_ID,
        "lingua-next 生词卡",
        fields=[
            {"name": "Word"},
            {"name": "Phonetic"},
            {"name": "Translation"},
            {"name": "Context"},
            {"name": "SourceLabel"},
        ],
        templates=[
            {
                "name": "词汇卡",
                "qfmt": '<div class="word">{{Word}}</div>'
                '<div class="phonetic">{{Phonetic}}</div>',
                "afmt": '{{FrontSide}}<hr id="answer">'
                '<div class="translation">{{Translation}}</div>'
                '<div class="context">{{Context}}</div>'
                '<div class="source">{{SourceLabel}}</div>',
            }
        ],
        css=(
            ".card { font-family: -apple-system, sans-serif; text-align: center; }\n"
            ".word { font-size: 32px; font-weight: 700; }\n"
            ".phonetic { color: #888; margin-top: 4px; }\n"
            ".translation { font-size: 18px; margin: 12px 0; }\n"
            ".context { color: #444; font-style: italic; margin-top: 8px; }\n"
            ".context b { color: #c0392b; font-style: normal; }\n"
            ".source { color: #999; font-size: 12px; margin-top: 10px; }"
        ),
    )
    deck = genanki.Deck(ANKI_DECK_ID, "lingua-next 生词本")
    for row in rows:
        deck.add_note(
            genanki.Note(
                model=model,
                fields=[
                    row["word"],
                    row["phonetic"] or "",
                    row["translation"] or "",
                    _highlight(row["context"], row["word"]),
                    row["source_label"] or "",
                ],
                guid=genanki.guid_for(row["word"]),
            )
        )
    genanki.Package(deck).write_to_file(dest_path)


@router.get("/vocab.apkg")
async def export_apkg(session: SessionDep) -> FileResponse:
    rows = await _collect_rows(session)
    if not rows:
        raise HTTPException(status_code=404, detail="生词本为空，没有可导出的卡片")
    fd, path = tempfile.mkstemp(suffix=".apkg")
    os.close(fd)
    _build_apkg(rows, path)
    return FileResponse(
        path,
        filename="lingua-vocab.apkg",
        media_type="application/octet-stream",
        background=BackgroundTask(os.unlink, path),
    )
