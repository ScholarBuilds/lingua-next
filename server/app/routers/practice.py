"""持久词汇训练。"""

from datetime import UTC, datetime, timedelta
from typing import Literal
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, HTTPException, Query
from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update

from app.owner import CurrentOwner
from app.routers.dict import SessionDep
from app.routers.review import review_queue
from app.routers.wordlists import wordlist_words
from domain import learning_receipts, srs, study_stage
from domain.models import (
    PracticeAnswer,
    PracticePack,
    PracticeProfile,
    PracticeSession,
    VocabEntry,
    Wordlist,
)
from domain.practice import apply_rating, build_questions, judge, with_hint_steps
from domain.practice_packs import auto_used, pack_payload, profile_for, queue_pack

router = APIRouter(prefix="/practice", tags=["practice"])


class ProfileBody(BaseModel):
    daily_new: int = Field(default=10, ge=1, le=100)
    timezone: str = Field(default="UTC", max_length=64)
    auto_enabled: bool = True
    auto_limit: int = Field(default=5, ge=0, le=5)


@router.get("/settings/profile")
async def read_profile(owner: CurrentOwner, session: SessionDep) -> dict:
    profile = await profile_for(session, owner.id)
    await session.commit()
    return {
        "daily_new": profile.daily_new,
        "timezone": profile.timezone,
        "auto_enabled": profile.auto_enabled,
        "auto_limit": profile.auto_limit,
        "auto_used": await auto_used(session, profile),
    }


@router.put("/settings/profile")
async def save_profile(body: ProfileBody, owner: CurrentOwner, session: SessionDep) -> dict:
    try:
        ZoneInfo(body.timezone)
    except ZoneInfoNotFoundError as exc:
        raise HTTPException(422, "请选择有效的时区") from exc
    profile = await profile_for(session, owner.id)
    for key, value in body.model_dump().items():
        setattr(profile, key, value)
    if not body.auto_enabled:
        await session.execute(
            update(PracticePack)
            .where(
                PracticePack.user_id == owner.id,
                PracticePack.automatic.is_(True),
                PracticePack.status == "queued",
            )
            .values(status="cancelled")
        )
    await session.commit()
    return await read_profile(owner, session)


class PrepareBody(BaseModel):
    mode: Literal["review", "learn", "spelling", "dictation", "listening", "cloze"]
    decks: list[str] = Field(default_factory=list, max_length=12)
    count: Literal[5, 10, 20, 40] = 10
    filter: Literal["all", "new", "learning", "difficult"] = "all"
    group: str = Field(default="", max_length=128)
    silent: bool = False
    return_url: str = Field(default="/vocab", max_length=2000)


async def owned(practice_id: str, owner_id: str, session) -> PracticeSession:
    record = await session.scalar(
        select(PracticeSession).where(
            PracticeSession.id == practice_id,
            PracticeSession.user_id == owner_id,
        )
    )
    if record is None:
        raise HTTPException(404, "训练不存在")
    return record


async def payload(record: PracticeSession, session) -> dict:
    answers = list(
        (
            await session.scalars(
                select(PracticeAnswer)
                .where(
                    PracticeAnswer.session_id == record.id,
                )
                .order_by(PracticeAnswer.created_at)
            )
        ).all()
    )
    counts = {
        key: sum(a.verdict == key for a in answers)
        for key in (
            "correct",
            "assisted",
            "incorrect",
            "skipped",
            "unavailable",
        )
    }
    return {
        "id": record.id,
        "mode": record.mode,
        "status": record.status,
        "scope": record.scope,
        "questions": [with_hint_steps(question, record.mode) for question in record.questions],
        "cursor": record.cursor,
        "version": record.version,
        "created_at": record.created_at,
        "updated_at": record.updated_at,
        "finished_at": record.finished_at,
        "answers": [
            {
                "id": a.id,
                "question_id": a.question_id,
                "answer": a.answer,
                "hints": a.hints,
                "replays": a.replays,
                "verdict": a.verdict,
                "rating": a.rating,
                "scheduled": a.review_log_id is not None,
            }
            for a in answers
        ],
        "counts": counts,
    }


@router.post("")
async def prepare(body: PrepareBody, owner: CurrentOwner, session: SessionDep) -> dict:
    if body.silent and body.mode in {"dictation", "listening"}:
        raise HTTPException(422, "听力训练需要声音，请选择拼写或例句挖空")
    if not body.return_url.startswith("/vocab") or body.return_url.startswith("//"):
        raise HTTPException(422, "返回地址无效")
    keys = list(dict.fromkeys(body.decks)) or ["__vocab__"]
    count = body.count
    if body.mode == "learn":
        profile = await profile_for(session, owner.id)
        zone = ZoneInfo(profile.timezone)
        local_start = (
            datetime.now(UTC).astimezone(zone).replace(hour=0, minute=0, second=0, microsecond=0)
        )
        start = local_start.astimezone(UTC)
        end = (local_start + timedelta(days=1)).astimezone(UTC)
        completed = (
            await session.scalars(
                select(PracticeAnswer)
                .join(
                    PracticeSession,
                    PracticeSession.id == PracticeAnswer.session_id,
                )
                .where(
                    PracticeSession.user_id == owner.id,
                    PracticeSession.mode == "learn",
                    PracticeAnswer.created_at >= start,
                    PracticeAnswer.created_at < end,
                    PracticeAnswer.verdict.in_(["correct", "assisted", "incorrect"]),
                )
            )
        ).all()
        count = min(count, max(0, profile.daily_new - len(completed)))
        if count == 0:
            raise HTTPException(422, "今天的新词安排已完成，可以先复习或调整计划")
    rows = []
    for key in keys:
        if body.mode == "review":
            result = await review_queue(owner, session, limit=body.count, deck=key)
            rows.extend(result["items"])
        else:
            result = await wordlist_words(
                key,
                owner,
                session,
                offset=0,
                limit=min(body.count * 5, 200),
                filter="new" if body.mode == "learn" else body.filter,
                sort="default",
                q="",
                group=body.group,
            )
            items = result["items"]
            if body.mode == "learn":
                book = (
                    await session.get(Wordlist, int(key.split(":", 1)[1]))
                    if key.startswith("custom:")
                    else None
                )
                items = items[: min(count, book.daily_new_limit if book else 10)]
            rows.extend(items)
    if body.mode == "review":
        entries = {
            v.id: v
            for v in (
                await session.scalars(
                    select(VocabEntry).where(
                        VocabEntry.user_id == owner.id,
                        VocabEntry.id.in_([r["vocab_id"] for r in rows]),
                    )
                )
            ).all()
        }
        for row in rows:
            row["card_version"] = (entries[row["vocab_id"]].fsrs_card or {}).get("last_review")
    questions = build_questions(rows, body.mode, count)
    if not questions:
        raise HTTPException(422, "这个范围内没有合适的题目，请更换范围或训练方式")
    now = datetime.now(UTC)
    record = PracticeSession(
        id=str(uuid4()),
        user_id=owner.id,
        mode=body.mode,
        status="active",
        scope=body.model_dump(exclude={"mode"}),
        questions=questions,
        cursor=0,
        version=0,
        created_at=now,
        updated_at=now,
    )
    session.add(record)
    await session.commit()
    return await payload(record, session)


@router.get("")
async def history(
    owner: CurrentOwner,
    session: SessionDep,
    offset: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=50),
    status: Literal["all", "unfinished", "finished"] = "all",
) -> dict:
    stmt = select(PracticeSession).where(PracticeSession.user_id == owner.id)
    if status == "unfinished":
        stmt = stmt.where(PracticeSession.status.in_(["active", "paused"]))
    elif status == "finished":
        stmt = stmt.where(PracticeSession.status == "finished")
    total = await session.scalar(select(func.count()).select_from(stmt.subquery()))
    records = (
        await session.scalars(
            stmt.order_by(
                PracticeSession.updated_at.desc(),
                PracticeSession.id,
            )
            .offset(offset)
            .limit(limit)
        )
    ).all()
    details: dict[str, dict[str, int]] = {
        record.id: {"completed": 0, "hints": 0, "incorrect": 0} for record in records
    }
    if details:
        for answer in (
            await session.scalars(
                select(PracticeAnswer).where(PracticeAnswer.session_id.in_(details))
            )
        ).all():
            summary = details[answer.session_id]
            summary["completed"] += answer.verdict not in {"skipped", "unavailable"}
            summary["hints"] += answer.hints
            summary["incorrect"] += answer.verdict == "incorrect"
    return {
        "total": total,
        "items": [
            {
                "id": r.id,
                "mode": r.mode,
                "status": r.status,
                "cursor": r.cursor,
                "total": len(r.questions),
                "scope": r.scope,
                "updated_at": r.updated_at,
                **details[r.id],
            }
            for r in records
        ],
    }


@router.get("/{practice_id}")
async def read(practice_id: str, owner: CurrentOwner, session: SessionDep) -> dict:
    return await payload(await owned(practice_id, owner.id, session), session)


class DraftBody(BaseModel):
    answer: str = Field(default="", max_length=4000)
    hints: int = Field(default=0, ge=0, le=20)
    replays: int = Field(default=0, ge=0, le=1000)


class ProgressBody(BaseModel):
    version: int = Field(ge=0)
    status: Literal["active", "paused", "finished"]
    draft: DraftBody = Field(default_factory=DraftBody)


@router.post("/{practice_id}/retry")
async def retry_errors(practice_id: str, owner: CurrentOwner, session: SessionDep) -> dict:
    source = await owned(practice_id, owner.id, session)
    wrong = set(
        (
            await session.scalars(
                select(PracticeAnswer.question_id).where(
                    PracticeAnswer.session_id == source.id,
                    PracticeAnswer.verdict == "incorrect",
                )
            )
        ).all()
    )
    questions = [{**q, "id": str(uuid4())} for q in source.questions if q["id"] in wrong]
    if source.mode in {"learn", "review"}:
        questions = build_questions(
            [{**q, "example_en": q.get("example", "")} for q in questions],
            "spelling",
            len(questions),
        )
    if not questions:
        raise HTTPException(422, "本轮没有需要重练的错题")
    now = datetime.now(UTC)
    record = PracticeSession(
        id=str(uuid4()),
        user_id=owner.id,
        mode="spelling" if source.mode in {"learn", "review"} else source.mode,
        scope={**source.scope, "retry_of": source.id, "draft": {}},
        questions=questions,
        status="active",
        cursor=0,
        version=0,
        created_at=now,
        updated_at=now,
    )
    session.add(record)
    await session.commit()
    return await payload(record, session)


@router.patch("/{practice_id}")
async def progress(
    practice_id: str,
    body: ProgressBody,
    owner: CurrentOwner,
    session: SessionDep,
) -> dict:
    record = await owned(practice_id, owner.id, session)
    if record.status == "finished":
        return await payload(record, session)
    scope = {**record.scope, "draft": body.draft.model_dump()}
    now = datetime.now(UTC)
    result = await session.execute(
        update(PracticeSession)
        .where(
            PracticeSession.id == record.id,
            PracticeSession.version == body.version,
        )
        .values(
            scope=scope,
            status=body.status,
            version=body.version + 1,
            updated_at=now,
            finished_at=now if body.status == "finished" else None,
        )
    )
    if result.rowcount != 1:
        await session.rollback()
        raise HTTPException(409, "训练已在其他窗口更新，请重新读取进度")
    if record.status == "finished":
        await queue_pack(session, record)
    await session.commit()
    await session.refresh(record)
    return await payload(record, session)


class AnswerBody(BaseModel):
    id: str = Field(pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
    question_id: str = Field(
        pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
    )
    version: int = Field(ge=0)
    answer: str = Field(default="", max_length=4000)
    hints: int = Field(default=0, ge=0, le=20)
    replays: int = Field(default=0, ge=0, le=1000)
    rating: int | None = Field(default=None, ge=1, le=4)
    action: Literal["answer", "skip", "unavailable"] = "answer"


@router.post("/{practice_id}/answers")
async def answer(
    practice_id: str,
    body: AnswerBody,
    owner: CurrentOwner,
    session: SessionDep,
) -> dict:
    receipt, duplicate = await learning_receipts.claim(
        session, owner.id, body.id, f"practice:{practice_id}", body.model_dump()
    )
    if duplicate:
        return receipt.response
    record = await owned(practice_id, owner.id, session)
    previous = await session.scalar(
        select(PracticeAnswer).where(
            PracticeAnswer.session_id == record.id,
            PracticeAnswer.question_id == body.question_id,
        )
    )
    if previous:
        raise HTTPException(409, "本题已提交，请重新读取进度")
    if await session.get(PracticeAnswer, body.id) is not None:
        raise HTTPException(409, "答题标识已使用，请重新读取进度")
    if record.status != "active" or record.cursor >= len(record.questions):
        raise HTTPException(409, "训练未处于答题状态")
    question = with_hint_steps(record.questions[record.cursor], record.mode)
    if question["id"] != body.question_id:
        raise HTTPException(409, "题目与当前进度不一致")
    if record.mode in {"review", "learn"} and body.action == "answer" and body.rating is None:
        raise HTTPException(422, "请选择记忆评分")
    if (
        record.mode == "review"
        and body.action == "answer"
        and body.hints >= len(question.get("hint_steps", []))
        and body.rating is not None
        and body.rating > 2
    ):
        raise HTTPException(422, "查看完整答案后只能选择忘记或困难")
    now = datetime.now(UTC)
    last = record.cursor + 1 == len(record.questions)
    result = await session.execute(
        update(PracticeSession)
        .where(
            PracticeSession.id == record.id,
            PracticeSession.version == body.version,
        )
        .values(
            cursor=record.cursor + 1,
            version=body.version + 1,
            updated_at=now,
            scope={**record.scope, "draft": {}},
            status="finished" if last else "active",
            finished_at=now if last else None,
        )
    )
    if result.rowcount != 1:
        await session.rollback()
        raise HTTPException(409, "进度已更新，请重新读取；重复提交不会再次评分")
    verdict = {"skip": "skipped", "unavailable": "unavailable"}.get(body.action)
    if verdict is None:
        verdict = judge(question, record.mode, body.answer, body.rating, body.hints)
    review_log_id = None
    if body.action == "answer":
        entry = await session.scalar(
            select(VocabEntry)
            .where(
                VocabEntry.user_id == owner.id,
                VocabEntry.word == question["word"].strip().lower(),
            )
            .with_for_update()
        )
        if record.mode == "review":
            if (
                entry is None
                or (entry.fsrs_card or {}).get("last_review") != question["card_version"]
            ):
                await session.rollback()
                raise HTTPException(409, "这个词已在其他训练中评分，可跳过本题继续")
            log = await apply_rating(session, entry, body.rating, now)
            review_log_id = log.id
        elif record.mode == "learn":
            profile = await profile_for(session, owner.id)
            await session.execute(
                update(PracticeProfile)
                .where(PracticeProfile.user_id == owner.id)
                .values(daily_new=PracticeProfile.daily_new)
            )
            local_start = now.astimezone(ZoneInfo(profile.timezone)).replace(
                hour=0,
                minute=0,
                second=0,
                microsecond=0,
            )
            learned = await session.scalar(
                select(func.count(PracticeAnswer.id))
                .join(
                    PracticeSession,
                    PracticeSession.id == PracticeAnswer.session_id,
                )
                .where(
                    PracticeSession.user_id == owner.id,
                    PracticeSession.mode == "learn",
                    PracticeAnswer.created_at >= local_start.astimezone(UTC),
                    PracticeAnswer.created_at < (local_start + timedelta(days=1)).astimezone(UTC),
                    PracticeAnswer.verdict.in_(["correct", "assisted", "incorrect"]),
                )
            )
            if learned >= profile.daily_new:
                await session.rollback()
                raise HTTPException(409, "今天的新词安排已完成，请暂停或调整计划")
            if entry is not None and (entry.exposures or 0) > 0:
                await session.rollback()
                raise HTTPException(409, "这个词已在其他训练中学习，可跳过继续")
            if entry is None:
                entry = VocabEntry(
                    user_id=owner.id, word=question["word"].strip().lower(), source="wordlist"
                )
                session.add(entry)
            entry.last_seen_at = now
            entry.exposures = (entry.exposures or 0) + 1
            if not entry.fsrs_card:
                entry.fsrs_card = srs.init_card()
                entry.due_at = now
                entry.status = "learning"
            entry.status = study_stage.status_of(study_stage.stage(entry))
    session.add(
        PracticeAnswer(
            id=body.id,
            session_id=record.id,
            question_id=body.question_id,
            answer=body.answer,
            hints=body.hints,
            replays=body.replays,
            verdict=verdict,
            rating=body.rating,
            review_log_id=review_log_id,
            created_at=now,
        )
    )
    if record.status == "finished":
        await queue_pack(session, record)
    await session.flush()
    await session.refresh(record)
    response = await payload(record, session)
    receipt.response = jsonable_encoder(response)
    await session.commit()
    return response


@router.get("/{practice_id}/pack")
async def read_pack(practice_id: str, owner: CurrentOwner, session: SessionDep) -> dict:
    await owned(practice_id, owner.id, session)
    pack = await session.scalar(select(PracticePack).where(PracticePack.session_id == practice_id))
    return {"pack": await pack_payload(session, pack)}


class PackRequest(BaseModel):
    confirm_cost: bool = False


@router.post("/{practice_id}/pack")
async def request_pack(
    practice_id: str,
    body: PackRequest,
    owner: CurrentOwner,
    session: SessionDep,
) -> dict:
    record = await owned(practice_id, owner.id, session)
    pack = await session.scalar(select(PracticePack).where(PracticePack.session_id == practice_id))
    if pack and pack.status in {"ready", "running", "queued"}:
        return {"pack": await pack_payload(session, pack)}
    if not body.confirm_cost:
        raise HTTPException(409, "手动生成可能产生模型费用，请确认后继续")
    if pack is None:
        pack = await queue_pack(session, record, automatic=False)
    else:
        pack.automatic, pack.status, pack.error = False, "queued", None
    if pack is None:
        raise HTTPException(422, "需要先完成至少 5 个不同单词的有效训练")
    await session.commit()
    return {"pack": await pack_payload(session, pack)}
