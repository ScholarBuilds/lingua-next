"""重建句层不能丢用户的学习记录（缺陷 A 的回归守卫）。

`build_sentence_layer` 一进来就 `delete(SubtitleSentence)`，而 `study_unit_state`
与 `shadow_recording` 全挂 CASCADE：确认门只拦住自动触发，用户点了确认之后同样不该丢。
断句阈值一变新旧切分就对不上，所以匹配走归一化词序列而不是逐字符。

内存 SQLite 不开外键，CASCADE 在这里根本不触发——用例断言的是**显式**迁移与清理的结果，
真删干净了才算数（否则 PostgreSQL 上会是另一番景象而测试全绿）。
"""

from __future__ import annotations

import pytest
from sqlalchemy import func, select

from domain.models import (
    ShadowRecording,
    StudyUnit,
    StudyUnitState,
    SubtitleCue,
    SubtitleIssue,
    SubtitleSentence,
    SubtitleTrack,
    Video,
)
from domain.sentence_migration import ISSUE_KIND_RECORDS_LOST
from worker.tasks import build_sentence_layer

# 每词 400ms 的等宽词表，够 build_sentences 按停顿/长度切
_WORD_MS = 400


def _cue_words(text: str, start_ms: int) -> tuple[list, int]:
    """造词级时间戳 [[start,end,surface,char_start,char_end], ...]（句内 UTF-16 偏移）。"""
    words: list = []
    cursor = 0
    at = start_ms
    for token in text.split():
        pos = text.index(token, cursor)
        words.append([at, at + _WORD_MS, token, pos, pos + len(token)])
        cursor = pos + len(token)
        at += _WORD_MS
    return words, at


async def _seed_track(session, texts: list[str], gap_ms: int = 0) -> tuple[int, int]:
    """建一条 whisper 轨并写入 cue（带词级时间戳），返回 (video_id, track_id)。"""
    video = Video(title="Rebuild fixture", status="ready")
    session.add(video)
    await session.flush()
    track = SubtitleTrack(video_id=video.id, kind="whisper", lang="en", label="en", is_default=True)
    session.add(track)
    await session.flush()
    at = 0
    for ordinal, text in enumerate(texts):
        words, end = _cue_words(text, at)
        session.add(
            SubtitleCue(
                track_id=track.id,
                ordinal=ordinal,
                start_ms=at,
                end_ms=end,
                text=text,
                content_hash=f"cue-{ordinal}",
                words=words,
            )
        )
        at = end + gap_ms
    await session.commit()
    return video.id, track.id


async def _units(session, track_id: int) -> list[StudyUnit]:
    return list(
        (
            await session.execute(
                select(StudyUnit).where(StudyUnit.track_id == track_id).order_by(StudyUnit.ordinal)
            )
        ).scalars()
    )


async def _states(session, video_id: int) -> list[StudyUnitState]:
    return list(
        (
            await session.execute(
                select(StudyUnitState).where(StudyUnitState.video_id == video_id)
            )
        ).scalars()
    )


async def _issues(session, video_id: int) -> list[SubtitleIssue]:
    return list(
        (
            await session.execute(
                select(SubtitleIssue).where(SubtitleIssue.video_id == video_id)
            )
        ).scalars()
    )


async def test_learned_starred_and_dictation_survive_rebuild(session) -> None:
    """已学 ✓ / 收藏 / 听写成绩要落在**文本对应**的新句上，不是同一个下标。"""
    texts = [
        "The tube carries water underground.",
        "Engineers rebuilt it last winter.",
        "Nobody noticed the change at all.",
    ]
    video_id, track_id = await _seed_track(session, texts)
    await build_sentence_layer(session, track_id)
    await session.commit()

    units = await _units(session, track_id)
    target = next(u for u in units if "Engineers" in u.text)
    session.add(
        StudyUnitState(
            unit_id=target.id,
            video_id=video_id,
            learned=True,
            starred=True,
            dictation_accuracy=88,
        )
    )
    await session.commit()
    marked_text = target.text

    # 阈值变紧：切分会变，下标必然错位
    await build_sentence_layer(session, track_id, max_unit_s=3.0, max_unit_chars=40)
    await session.commit()

    units_after = await _units(session, track_id)
    states = await _states(session, video_id)
    assert len(states) == 1, "重建之后学习记录整片消失（缺陷 A）"
    moved = states[0]
    new_unit = await session.get(StudyUnit, moved.unit_id)
    assert new_unit is not None
    assert new_unit.track_id == track_id
    # 落点必须是文本对应的那条，而不是"恰好还有一条 state"
    assert "Engineers" in new_unit.text, f"落到了无关的句子：{new_unit.text}"
    assert moved.learned is True
    assert moved.starred is True
    assert moved.dictation_accuracy == 88
    assert marked_text  # 旧文本确实非空，前面的断言才有意义
    # 旧学习句不能留成孤儿（PostgreSQL 上 CASCADE 会删，内存库要靠显式清理）
    assert moved.unit_id in {u.id for u in units_after}


async def test_state_follows_when_one_sentence_splits_into_two(session) -> None:
    """一句拆成两句：至少落到能匹配上的那条，不许丢。"""
    long_text = (
        "The engineers rebuilt the tunnel last winter because the old lining had "
        "started to leak and the water was rising fast every single night."
    )
    video_id, track_id = await _seed_track(session, [long_text])
    await build_sentence_layer(session, track_id, max_unit_s=60.0, max_unit_chars=400)
    await session.commit()

    before = await _units(session, track_id)
    assert len(before) == 1, "前置条件：先切成一整条"
    session.add(StudyUnitState(unit_id=before[0].id, video_id=video_id, learned=True))
    await session.commit()

    # 收紧阈值 → 同一段话被切成多条
    await build_sentence_layer(session, track_id, max_unit_s=4.0, max_unit_chars=45)
    await session.commit()

    after = await _units(session, track_id)
    assert len(after) > 1, "前置条件：阈值收紧后确实拆开了"
    states = await _states(session, video_id)
    assert len(states) == 1
    landed = await session.get(StudyUnit, states[0].unit_id)
    assert landed is not None and landed.id in {u.id for u in after}
    assert states[0].learned is True
    # 落点必须真是拆出来的某一条，而不是残留的旧行
    assert landed.text in long_text or long_text.startswith(landed.text.rstrip("."))


async def test_two_units_merging_into_one_keeps_the_flag(session) -> None:
    """两句并成一句：两条旧状态合并进一行，已学 ✓ 不能被唯一约束顶掉。"""
    long_text = (
        "The engineers rebuilt the tunnel last winter because the old lining had "
        "started to leak and the water was rising fast every single night."
    )
    video_id, track_id = await _seed_track(session, [long_text])
    await build_sentence_layer(session, track_id, max_unit_s=4.0, max_unit_chars=45)
    await session.commit()

    before = await _units(session, track_id)
    assert len(before) >= 2, "前置条件：先切成多条"
    session.add(StudyUnitState(unit_id=before[0].id, video_id=video_id, learned=True))
    session.add(StudyUnitState(unit_id=before[1].id, video_id=video_id, starred=True))
    await session.commit()

    # 放宽阈值 → 并回一整条
    await build_sentence_layer(session, track_id, max_unit_s=60.0, max_unit_chars=400)
    await session.commit()

    after = await _units(session, track_id)
    assert len(after) == 1
    states = await _states(session, video_id)
    assert len(states) == 1, "并句时两条状态要合并，不能只剩一条或撞唯一约束"
    assert states[0].unit_id == after[0].id
    assert states[0].learned is True
    assert states[0].starred is True


async def test_shadow_recording_moves_and_keeps_audio_key(session) -> None:
    """跟读录音跟着换归属，audio_key / 比对 / 点评一个字都不改（文件在磁盘上没动）。"""
    texts = [
        "The tube carries water underground.",
        "Engineers rebuilt it last winter.",
    ]
    video_id, track_id = await _seed_track(session, texts)
    await build_sentence_layer(session, track_id)
    await session.commit()

    units = await _units(session, track_id)
    unit = next(u for u in units if "Engineers" in u.text)
    rec = ShadowRecording(
        video_id=video_id,
        sentence_id=unit.sentence_id,
        unit_id=unit.id,
        audio_key="recordings/7/abc.webm",
        mime="audio/webm",
        transcript="engineers rebuilt it last winter",
        accuracy=91,
        review="重音落在 rebuilt 上",
        score=84,
    )
    session.add(rec)
    await session.commit()
    old_sentence_id = rec.sentence_id

    await build_sentence_layer(session, track_id, max_unit_s=3.0, max_unit_chars=40)
    await session.commit()
    await session.refresh(rec)

    assert rec.audio_key == "recordings/7/abc.webm"
    assert rec.accuracy == 91 and rec.score == 84
    assert rec.sentence_id != old_sentence_id, "旧句已删，归属必须换到新句"
    moved_to = await session.get(SubtitleSentence, rec.sentence_id)
    assert moved_to is not None and moved_to.track_id == track_id
    assert "Engineers" in moved_to.text
    assert rec.unit_id is not None
    assert (await session.get(StudyUnit, rec.unit_id)) is not None


async def test_unmatchable_records_raise_a_visible_issue(session) -> None:
    """整轨换了内容 → 搬不动的不许静默丢弃，要在问题清单里看得见。"""
    video_id, track_id = await _seed_track(session, ["The tube carries water underground."])
    await build_sentence_layer(session, track_id)
    await session.commit()

    unit = (await _units(session, track_id))[0]
    session.add(StudyUnitState(unit_id=unit.id, video_id=video_id, learned=True))
    session.add(
        ShadowRecording(
            video_id=video_id,
            sentence_id=unit.sentence_id,
            unit_id=unit.id,
            audio_key="recordings/9/x.webm",
            mime="audio/webm",
        )
    )
    await session.commit()

    # 换掉 cue 文本：新句层与旧句毫无词面交集
    await session.execute(
        SubtitleCue.__table__.update()
        .where(SubtitleCue.track_id == track_id)
        .values(text="Completely different narration about volcanoes.")
    )
    words, _ = _cue_words("Completely different narration about volcanoes.", 0)
    await session.execute(
        SubtitleCue.__table__.update()
        .where(SubtitleCue.track_id == track_id)
        .values(words=words)
    )
    await session.commit()

    await build_sentence_layer(session, track_id)
    await session.commit()

    issues = [i for i in await _issues(session, video_id) if i.kind == ISSUE_KIND_RECORDS_LOST]
    assert len(issues) == 1, "找不到落点却不落 SubtitleIssue = 静默丢数据"
    assert "1 条学习记录" in issues[0].detail
    assert "1 条跟读录音" in issues[0].detail
    assert issues[0].state == "open"
    # 搬不动的行不能留成悬挂引用（PostgreSQL 上 CASCADE 会删，这里显式删）
    assert await _states(session, video_id) == []
    remaining = (
        await session.execute(
            select(func.count()).select_from(ShadowRecording).where(
                ShadowRecording.video_id == video_id
            )
        )
    ).scalar_one()
    assert remaining == 0


async def test_migration_is_idempotent(session) -> None:
    """连跑两次：state 行数不翻倍，也不会多出一条丢失提示。"""
    texts = [
        "The tube carries water underground.",
        "Engineers rebuilt it last winter.",
        "Nobody noticed the change at all.",
    ]
    video_id, track_id = await _seed_track(session, texts)
    await build_sentence_layer(session, track_id)
    await session.commit()

    units = await _units(session, track_id)
    for unit in units[:2]:
        session.add(StudyUnitState(unit_id=unit.id, video_id=video_id, learned=True))
    await session.commit()
    baseline = len(await _states(session, video_id))
    assert baseline == 2

    for _ in range(2):
        await build_sentence_layer(session, track_id)
        await session.commit()

    states = await _states(session, video_id)
    assert len(states) == baseline, "重跑两次把 state 行翻倍了"
    unit_ids = {u.id for u in await _units(session, track_id)}
    assert {s.unit_id for s in states} <= unit_ids, "state 指向了已删的旧学习句"
    assert len({s.unit_id for s in states}) == len(states)  # unit_id 唯一
    assert [i for i in await _issues(session, video_id) if i.kind == ISSUE_KIND_RECORDS_LOST] == []


async def test_first_build_needs_no_migration(session) -> None:
    """首建句层（没有旧记录）走原路：不落问题、不留残行。"""
    video_id, track_id = await _seed_track(session, ["A short line here."])
    n_sent, n_unit, migration = await build_sentence_layer(session, track_id)
    await session.commit()

    assert n_sent >= 1 and n_unit >= 1
    assert migration == {"records_total": 0, "records_moved": 0, "records_lost": 0}
    assert await _issues(session, video_id) == []


@pytest.mark.parametrize("gap_ms", [0, 900])
async def test_rebuild_keeps_ordinals_contiguous(session, gap_ms: int) -> None:
    """迁移期间新句占负序号，收尾必须落回 0..n-1（唯一约束与前端下标都依赖它）。"""
    _video_id, track_id = await _seed_track(
        session, ["First line goes here.", "Second line follows it."], gap_ms=gap_ms
    )
    await build_sentence_layer(session, track_id)
    await session.commit()
    await build_sentence_layer(session, track_id)
    await session.commit()

    sentences = list(
        (
            await session.execute(
                select(SubtitleSentence)
                .where(SubtitleSentence.track_id == track_id)
                .order_by(SubtitleSentence.ordinal)
            )
        ).scalars()
    )
    assert [s.ordinal for s in sentences] == list(range(len(sentences)))
    units = await _units(session, track_id)
    assert [u.ordinal for u in units] == list(range(len(units)))
