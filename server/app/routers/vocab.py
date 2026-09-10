"""生词收藏、来源语境与学习计划。"""

import hashlib
import json
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select

from app.owner import CurrentOwner
from app.routers.dict import SessionDep
from domain import srs, study_stage
from domain.models import (
    DictEntry,
    PracticeAnswer,
    PracticeSession,
    VocabEntry,
    VocabOccurrence,
    Wordlist,
    WordlistItem,
)

router = APIRouter(prefix="/vocab", tags=["vocab"])

SourceKind = Literal[
    "reader", "video", "talk", "grammar", "wordlist", "practice", "manual", "software"
]
LOCATOR_KEYS: dict[str, set[str]] = {
    "software": {"collection", "page", "capture", "entry"},
    "reader": {"article_id", "sentence_id"},
    "video": {"video_id", "cue_id"},
    "talk": {"session_id", "turn_id"},
    "grammar": {"document", "section"},
    "wordlist": {"deck", "word"},
    "practice": {"session_id", "question_id"},
    "manual": set(),
}


class VocabSource(BaseModel):
    kind: SourceKind
    label: str | None = Field(default=None, max_length=160)
    locator: dict[str, int | str] = Field(default_factory=dict)

    @field_validator("locator")
    @classmethod
    def validate_locator(cls, value: dict[str, int | str], info):
        kind = info.data.get("kind")
        if kind and not set(value).issubset(LOCATOR_KEYS[kind]):
            raise ValueError("来源定位字段无效")
        for item in value.values():
            if isinstance(item, str) and (len(item) > 160 or "://" in item):
                raise ValueError("来源定位只能使用内部标识")
        return value


class VocabBody(BaseModel):
    word: str = Field(max_length=128)
    lemma: str | None = Field(default=None, max_length=128)
    article_id: int | None = None
    sentence_id: int | None = None
    video_id: int | None = None
    cue_id: int | None = None
    context_text: str = Field(max_length=4000)
    source: VocabSource | None = None


def _legacy_source(body: VocabBody) -> VocabSource:
    if body.video_id is not None:
        return VocabSource(
            kind="video",
            locator={
                "video_id": body.video_id,
                **({"cue_id": body.cue_id} if body.cue_id is not None else {}),
            },
        )
    if body.article_id is not None:
        return VocabSource(
            kind="reader",
            locator={
                "article_id": body.article_id,
                **({"sentence_id": body.sentence_id} if body.sentence_id is not None else {}),
            },
        )
    return VocabSource(kind="manual")


def _source_fingerprint(source: VocabSource, context: str) -> str:
    payload: dict = {"kind": source.kind, "locator": source.locator}
    if not source.locator:
        payload["context"] = context.strip()
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()


def _entry_dict(entry: VocabEntry, occurrences: int) -> dict:
    return {
        "id": entry.id,
        "word": entry.word,
        "lemma": entry.lemma,
        "status": entry.status,
        "scheduled": entry.fsrs_card is not None,
        "due_at": entry.due_at.isoformat() if entry.due_at else None,
        "created_at": entry.created_at.isoformat() if entry.created_at else None,
        "occurrences": occurrences,
    }


@router.post("", status_code=201)
async def add_vocab(body: VocabBody, owner: CurrentOwner, session: SessionDep) -> dict:
    word = body.word.strip().lower()
    if not word:
        raise HTTPException(status_code=400, detail="empty word")
    entry = await session.scalar(
        select(VocabEntry).where(VocabEntry.user_id == owner.id, VocabEntry.word == word)
    )
    created = entry is None
    if entry is None:
        entry = VocabEntry(
            user_id=owner.id,
            word=word,
            lemma=body.lemma,
            source=(body.source.kind if body.source else "manual"),
        )
        session.add(entry)
        await session.flush()

    source = body.source or _legacy_source(body)
    fingerprint = _source_fingerprint(source, body.context_text)
    occurrence = await session.scalar(
        select(VocabOccurrence).where(
            VocabOccurrence.vocab_id == entry.id,
            VocabOccurrence.source_fingerprint == fingerprint,
        )
    )
    occurrence_created = occurrence is None
    if occurrence is None:
        occurrence = VocabOccurrence(
            vocab_id=entry.id,
            article_id=body.article_id,
            sentence_id=body.sentence_id,
            video_id=body.video_id,
            cue_id=body.cue_id,
            source_kind=source.kind,
            source_label=source.label,
            source_locator=source.locator,
            source_fingerprint=fingerprint,
            context_text=body.context_text,
        )
        session.add(occurrence)
    await session.commit()
    count = await session.scalar(
        select(func.count()).select_from(VocabOccurrence).where(
            VocabOccurrence.vocab_id == entry.id
        )
    )
    return {
        **_entry_dict(entry, count or 0),
        "created": created,
        "occurrence_created": occurrence_created,
        "occurrence": {
            "id": occurrence.id,
            "source_kind": occurrence.source_kind,
            "source_label": occurrence.source_label,
            "source_locator": occurrence.source_locator,
            "context_text": occurrence.context_text,
        },
    }


@router.get("")
async def list_vocab(owner: CurrentOwner, session: SessionDep) -> list[dict]:
    stmt = (
        select(VocabEntry, func.count(VocabOccurrence.id))
        .outerjoin(VocabOccurrence, VocabOccurrence.vocab_id == VocabEntry.id)
        .where(VocabEntry.user_id == owner.id)
        .group_by(VocabEntry.id)
        .order_by(VocabEntry.created_at.desc())
    )
    rows = (await session.execute(stmt)).all()
    latest: dict[int, VocabOccurrence] = {}
    for occurrence in (
        await session.scalars(
            select(VocabOccurrence)
            .join(VocabEntry, VocabEntry.id == VocabOccurrence.vocab_id)
            .where(VocabEntry.user_id == owner.id)
            .order_by(VocabOccurrence.added_at, VocabOccurrence.id)
        )
    ).all():
        latest[occurrence.vocab_id] = occurrence
    return [
        {
            **_entry_dict(entry, count),
            "latest_context": latest[entry.id].context_text if entry.id in latest else None,
            "latest_source": (
                {
                    "kind": latest[entry.id].source_kind,
                    "label": latest[entry.id].source_label,
                    "locator": latest[entry.id].source_locator,
                }
                if entry.id in latest
                else None
            ),
        }
        for entry, count in rows
    ]


@router.get("/overview")
async def vocab_overview(owner: CurrentOwner, session: SessionDep) -> dict:
    from app.routers.practice import history, read_profile
    from app.routers.review import review_stats
    from app.routers.wordlists import list_wordlists

    decks = await list_wordlists(owner, session, include_archived=True)
    stats = await review_stats(owner, session)
    profile = await read_profile(owner, session)
    resume = await history(owner, session, offset=0, limit=5, status="unfinished")
    weak_rows = (
        await session.execute(
            select(PracticeSession.mode, func.count(PracticeAnswer.id))
            .join(PracticeAnswer, PracticeAnswer.session_id == PracticeSession.id)
            .where(
                PracticeSession.user_id == owner.id,
                PracticeAnswer.verdict.in_(["incorrect", "assisted"]),
            )
            .group_by(PracticeSession.mode)
            .order_by(func.count(PracticeAnswer.id).desc())
            .limit(3)
        )
    ).all()
    return {
        "decks": decks,
        "stats": stats,
        "profile": profile,
        "resume": resume["items"],
        "weak_modes": [{"mode": mode, "count": count} for mode, count in weak_rows],
    }


@router.get("/membership")
async def deck_membership(word: str, session: SessionDep) -> dict:
    normalized = word.strip().lower()
    if not normalized or len(normalized) > 128:
        return {"word": normalized, "decks": []}
    dictionary = await session.scalar(select(DictEntry).where(DictEntry.word == normalized))
    keys = set(dictionary.tag.split() if dictionary and dictionary.tag else [])
    custom = (
        await session.execute(
            select(Wordlist.id)
            .join(WordlistItem, WordlistItem.wordlist_id == Wordlist.id)
            .where(WordlistItem.word == normalized, Wordlist.status != "draft")
        )
    ).scalars()
    keys.update(f"custom:{wordlist_id}" for wordlist_id in custom)
    return {"word": normalized, "decks": sorted(keys)}


@router.post("/{vocab_id}/enroll")
async def enroll_vocab(vocab_id: int, owner: CurrentOwner, session: SessionDep) -> dict:
    entry = await session.scalar(
        select(VocabEntry).where(
            VocabEntry.id == vocab_id, VocabEntry.user_id == owner.id
        )
    )
    if entry is None:
        raise HTTPException(status_code=404, detail="vocab not found")
    enrolled = entry.fsrs_card is None
    if enrolled:
        entry.fsrs_card = srs.init_card()
        entry.due_at = datetime.now(UTC)
        entry.status = "learning"
        await session.commit()
    count = await session.scalar(
        select(func.count()).select_from(VocabOccurrence).where(
            VocabOccurrence.vocab_id == entry.id
        )
    )
    return {**_entry_dict(entry, count or 0), "enrolled": enrolled}


@router.delete("/{vocab_id}")
async def delete_vocab(vocab_id: int, owner: CurrentOwner, session: SessionDep) -> dict:
    entry = await session.scalar(
        select(VocabEntry).where(
            VocabEntry.id == vocab_id, VocabEntry.user_id == owner.id
        )
    )
    if entry is None:
        raise HTTPException(status_code=404, detail="vocab not found")
    await session.delete(entry)
    await session.commit()
    return {"ok": True}


@router.get("/status")
async def vocab_status(words: str, owner: CurrentOwner, session: SessionDep) -> dict:
    wanted = {w.strip().lower() for w in words.split(",") if w.strip()}
    if not wanted:
        return {"collected": []}
    found = list(
        (
            await session.scalars(
                select(VocabEntry).where(
                    VocabEntry.user_id == owner.id, VocabEntry.word.in_(wanted)
                )
            )
        ).all()
    )
    entries = {entry.word: entry for entry in found}
    return {
        "collected": list(entries),
        "stages": {word: study_stage.stage(entries.get(word)) for word in wanted},
    }


@router.get("/software-sources")
async def software_sources(word: str, owner: CurrentOwner, session: SessionDep):
    normalized = word.strip().lower()
    if not normalized or len(normalized) > 128:
        raise HTTPException(422, "单词无效")
    rows = await session.scalars(
        select(VocabOccurrence)
        .join(VocabEntry, VocabEntry.id == VocabOccurrence.vocab_id)
        .where(
            VocabEntry.user_id == owner.id,
            VocabEntry.word == normalized,
            VocabOccurrence.source_kind == "software",
        )
        .order_by(VocabOccurrence.added_at.desc(), VocabOccurrence.id.desc())
        .limit(50)
    )
    return {
        "items": [
            {
                "id": row.id,
                "label": row.source_label,
                "locator": row.source_locator,
                "context": row.context_text,
            }
            for row in rows
        ]
    }
