"""训练题目快照、结果判定与调度事务。"""

import re
import unicodedata
from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from domain import srs, study_stage
from domain.models import ReviewLog, VocabEntry

MODES = {"review", "learn", "spelling", "dictation", "listening", "cloze"}
HOMOPHONES = {
    "to",
    "too",
    "two",
    "there",
    "their",
    "they're",
    "here",
    "hear",
    "right",
    "write",
    "night",
    "knight",
    "sea",
    "see",
    "son",
    "sun",
    "one",
    "won",
    "no",
    "know",
    "buy",
    "by",
    "bye",
    "for",
    "four",
    "week",
    "weak",
    "wear",
    "where",
    "pair",
    "pear",
}


def utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def normalize_answer(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).casefold().replace("’", "'").split())


def _hint_steps(row: dict, mode: str, options: list[str], example: str) -> list[dict]:
    word = row["word"]
    translation = (row.get("translation") or "").strip()
    phonetic = (row.get("phonetic") or "").strip()
    pos = (row.get("pos") or "").strip()
    definition = (row.get("definition") or "").strip()
    first = word[:1]
    last = word[-1:] if len(word) > 1 else ""
    if mode in {"review", "learn"}:
        return [
            {"label": "词性与例句", "text": " · ".join(x for x in [pos, example] if x)},
            {"label": "英文释义线索", "text": definition or "暂无英文释义"},
            {
                "label": "完整中文释义",
                "text": translation or "暂无中文释义",
                "reveals_answer": True,
            },
        ]
    if mode == "spelling":
        return [
            {"label": "字符数与词形", "text": f"{len(word)} 个字母"},
            {
                "label": "首尾字母和音标",
                "text": f"{first}…{last}" + (f" · /{phonetic}/" if phonetic else ""),
            },
            {"label": "完整拼写", "text": word, "reveals_answer": True},
        ]
    if mode == "dictation":
        return [
            {
                "label": "词义与语境",
                "text": " · ".join(x for x in [pos, translation, example] if x),
            },
            {"label": "长度与首字母", "text": f"{len(word)} 个字母 · {first}…"},
            {"label": "完整拼写", "text": word, "reveals_answer": True},
        ]
    if mode == "listening":
        wrong = next((option for option in options if option != translation), "")
        return [
            {
                "label": "使用场景",
                "text": " · ".join(x for x in [pos, example] if x) or "结合发音判断词义",
            },
            {"label": "排除干扰项", "text": f"可以排除：{wrong}", "eliminate": wrong},
            {"label": "正确选项", "text": translation, "reveals_answer": True},
        ]
    return [
        {"label": "词形要求", "text": " · ".join(x for x in [pos, translation] if x)},
        {"label": "首尾字母", "text": f"{first}…{last}"},
        {"label": "完整答案", "text": word, "reveals_answer": True},
    ]


def with_hint_steps(question: dict, mode: str) -> dict:
    if question.get("hint_steps"):
        return question
    return {
        **question,
        "hint_steps": _hint_steps(
            question,
            mode,
            question.get("options") or [],
            question.get("example") or "",
        ),
    }


def build_questions(rows: list[dict], mode: str, count: int) -> list[dict]:
    questions = []
    seen = set()
    for row in rows:
        word = row["word"]
        if word in seen:
            continue
        translation = (row.get("translation") or "").strip()
        example = row.get("example_en") or (row.get("context") or {}).get("text") or ""
        pattern = re.compile(r"(?<!\w)" + re.escape(word) + r"(?!\w)", re.I)
        if (
            mode in {"cloze", "dictation"}
            and (mode == "cloze" or word.casefold() in HOMOPHONES)
            and (not example or len(pattern.findall(example)) != 1)
        ):
            continue
        prompt = pattern.sub("_____", example) if example else ""
        options = []
        if mode == "listening":
            if not translation:
                continue
            distractors = list(
                dict.fromkeys(
                    r.get("translation", "").strip()
                    for r in rows
                    if r.get("translation")
                    and r["word"] != word
                    and r["translation"].strip() != translation
                )
            )
            if len(distractors) < 3:
                continue
            options = distractors[:3]
            options.insert(len(questions) % 4, translation)
        seen.add(word)
        questions.append(
            {
                "id": str(uuid4()),
                "word": word,
                "phonetic": row.get("phonetic"),
                "pos": row.get("pos"),
                "translation": translation,
                "definition": row.get("definition"),
                "example": example,
                "example_zh": row.get("example_zh"),
                "prompt": prompt,
                "options": options,
                "hint_steps": _hint_steps(row, mode, options, example),
                "vocab_id": row.get("vocab_id"),
                "intervals": row.get("intervals"),
                "card_version": row.get("card_version"),
            }
        )
        if len(questions) == count:
            break
    return questions


def judge(question: dict, mode: str, answer: str, rating: int | None, hints: int) -> str:
    if mode in {"review", "learn"}:
        correct = rating is not None and rating >= 3
    else:
        expected = question["translation"] if mode == "listening" else question["word"]
        correct = normalize_answer(answer) == normalize_answer(expected)
    return ("assisted" if hints else "correct") if correct else "incorrect"


async def apply_rating(
    session: AsyncSession, entry: VocabEntry, rating: int, now: datetime
) -> ReviewLog:
    before = srs.card_state_name(entry.fsrs_card)
    elapsed = (
        (now - utc(entry.last_review_at)).total_seconds() / 86400 if entry.last_review_at else None
    )
    card, log, due = srs.review(entry.fsrs_card or srs.init_card(), rating, now=now)
    entry.fsrs_card, entry.due_at, entry.last_review_at = card, due, now
    entry.status = study_stage.status_of(study_stage.stage(entry))
    record = ReviewLog(
        vocab_id=entry.id,
        rating=rating,
        state_before=before,
        review_at=now,
        elapsed_days=elapsed,
        fsrs_log=log,
    )
    session.add(record)
    await session.flush()
    return record
