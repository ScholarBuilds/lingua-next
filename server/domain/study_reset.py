"""按本清学习进度（FR-501）。

进度是按词存的（`vocab_entry` 全局唯一 (user_id, word)），所以「清这一本」= 清本内这些词，
同一个词在别的本里的进度一起归零——文案要写明。收藏保留：有阅读 / 视频出处
（`vocab_occurrence`）的条目留着清零，只因看过 / 听过 / 标过而自动建的条目整行删，
场景 chip 的「入册」数才会回到 0。

测试内存库不开外键，CASCADE 靠不住，`review_log` 与 `practice_answer.review_log_id`
（无 ondelete 的普通 FK）都显式处理。全部走子查询，考纲本上万词不展开成 IN 参数。
"""

from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from domain import decks
from domain.models import DeckSceneState, PracticeAnswer, ReviewLog, VocabEntry, VocabOccurrence


async def reset_deck_progress(session: AsyncSession, user_id: str, key: str) -> dict:
    """不 commit，调用方与审计行一起提交。key 不认识抛 decks.UnknownDeck。"""
    scope = decks.deck_words_select(key)
    ids = select(VocabEntry.id).where(VocabEntry.user_id == user_id)
    if scope is not None:
        ids = ids.where(VocabEntry.word.in_(scope))
    words = (await session.execute(select(func.count()).select_from(ids.subquery()))).scalar_one()

    logs = select(ReviewLog.id).where(ReviewLog.vocab_id.in_(ids))
    await session.execute(
        update(PracticeAnswer)
        .where(PracticeAnswer.review_log_id.in_(logs))
        .values(review_log_id=None)
        .execution_options(synchronize_session=False)
    )
    review_logs = (
        await session.execute(
            delete(ReviewLog)
            .where(ReviewLog.vocab_id.in_(ids))
            .execution_options(synchronize_session=False)
        )
    ).rowcount
    with_source = select(VocabOccurrence.vocab_id).distinct()
    deleted = (
        await session.execute(
            delete(VocabEntry)
            .where(VocabEntry.id.in_(ids), VocabEntry.id.not_in(with_source))
            .execution_options(synchronize_session=False)
        )
    ).rowcount
    reset = (
        await session.execute(
            update(VocabEntry)
            .where(VocabEntry.id.in_(ids))
            .values(
                exposures=0,
                last_seen_at=None,
                self_test_at=None,
                mark=None,
                marked_at=None,
                fsrs_card=None,
                due_at=None,
                last_review_at=None,
                status="new",
            )
            .execution_options(synchronize_session=False)
        )
    ).rowcount
    scene_states = (
        await session.execute(
            delete(DeckSceneState)
            .where(DeckSceneState.user_id == user_id, DeckSceneState.deck == key)
            .execution_options(synchronize_session=False)
        )
    ).rowcount
    return {
        "words": int(words),
        "reset": reset,
        "deleted": deleted,
        "review_logs": review_logs,
        "scene_states": scene_states,
    }
