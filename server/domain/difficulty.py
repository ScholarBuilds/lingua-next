"""字幕文本 → 语速与 CEFR 难度（需求 09 v5 FR-59/60，BR-21）。

入库前预估与入库后正式加工共用这一条口径：`video_enrich.cefr_level` +
`cefr_distribution` + `difficulty_stars`，避免发现页显示三星、学习页变四星。
本模块只负责「文本 + 时长 → 指标」这一段，取字幕归 `subtitles_probe`，
落库归调用方。
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from domain.models import DictEntry
from domain.video_enrich import cefr_distribution, cefr_level, difficulty_stars, tokenize_words

_IN_CHUNK = 1000  # IN 子句分片，防超长语句


async def lookup_levels(session: AsyncSession, words: list[str]) -> list[str | None]:
    """去重词型 → CEFR 档位列表（词典无词频无标签的词返回 None，不计入分布）。"""
    entries: dict[str, tuple[int | None, str | None]] = {}
    for i in range(0, len(words), _IN_CHUNK):
        rows = (
            await session.execute(
                select(DictEntry.word, DictEntry.frq, DictEntry.tag).where(
                    DictEntry.word.in_(words[i : i + _IN_CHUNK])
                )
            )
        ).all()
        entries.update({w: (frq, tag) for w, frq, tag in rows})
    return [cefr_level(*entries[w]) for w in words if w in entries]


async def estimate(session: AsyncSession, text: str, duration_s: float | None) -> dict:
    """字幕全文 + 时长 → {wpm, difficulty, cefr_dist, vocab_count, word_count}。

    分布按去重词型统计（与 enrich 一致），避免 the/a 等功能词淹没占比。
    """
    tokens = tokenize_words(text)
    unique = sorted(set(tokens))
    if not tokens:
        return {"wpm": 0.0, "difficulty": None, "cefr_dist": {},
                "vocab_count": 0, "word_count": 0}
    dist = cefr_distribution(await lookup_levels(session, unique))
    duration = float(duration_s or 0)
    wpm = round(len(tokens) / (duration / 60), 1) if duration > 0 else 0.0
    return {
        "wpm": wpm,
        "difficulty": difficulty_stars(dist, wpm),
        "cefr_dist": dist,
        "vocab_count": len(unique),
        "word_count": len(tokens),
    }
