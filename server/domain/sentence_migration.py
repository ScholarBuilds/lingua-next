"""重建句层时把用户的学习记录迁到新句上（BR-25 确认门的另一半）。

`build_sentence_layer` 的第一句是 `delete(SubtitleSentence)`，而 `study_unit_state`
（已学 ✓ / 收藏 / 旗标 / text_override / 听写成绩）与 `shadow_recording`（录音 +
逐词比对 + AI 点评）都挂 `ondelete="CASCADE"`：不搬就是一次静默的数据丢失，
磁盘上的录音还会变孤儿。确认门只拦住了「代理自动重跑」，用户点过确认之后同样不该丢。

匹配走归一化词序列（复用 `sentence_ops._locate`），不逐字符比：
断句阈值一改，同一段话会被切成不同的块，标点与大小写也跟着变。
时间轴只作同分裁决——新旧句的时间都来自同一份词级时间戳，重叠最多的那条就是落点。

内存 SQLite 不开外键约束，靠 CASCADE 清关联行会与 PostgreSQL 结果不一致而测试全绿，
所以这里旧行一律显式 DELETE / UPDATE（踩坑索引）。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from domain.models import (
    ShadowRecording,
    StudyUnit,
    StudyUnitState,
    SubtitleIssue,
    SubtitleSentence,
    SubtitleTrack,
)
from domain.sentence_ops import _locate, _norm

logger = logging.getLogger(__name__)

#: 学习记录搬不过去时落的问题类型。体检的 `_store_issues` 每轮都会清空 open 问题，
#: 但这条不是「产物的属性」而是一次性事故记录，必须豁免（见 worker/tasks._store_issues）。
ISSUE_KIND_RECORDS_LOST = "records_lost"

#: 用户状态里需要搬走的字段。布尔按「或」合并（两句并一句时不能把已学 ✓ 弄丢），
#: 标量取第一条非空。
_STATE_FLAGS = ("learned", "starred", "flagged")


@dataclass(frozen=True)
class OldUnit:
    """重建前的学习句快照。`state` 为 None 表示用户没在这句上留过痕迹。"""

    id: int
    text: str
    start_ms: int
    end_ms: int
    state: dict | None = None


@dataclass(frozen=True)
class OldSentence:
    """重建前的语法句快照：跟读录音挂在这一层。"""

    id: int
    text: str
    start_ms: int
    end_ms: int


@dataclass(frozen=True)
class OldRecording:
    """跟读录音的归属快照。`audio_key` 不参与迁移，文件原地不动。"""

    id: int
    sentence_id: int
    unit_id: int | None


@dataclass(frozen=True)
class LearningSnapshot:
    video_id: int
    units: tuple[OldUnit, ...] = ()
    sentences: tuple[OldSentence, ...] = ()
    recordings: tuple[OldRecording, ...] = ()

    @property
    def has_records(self) -> bool:
        """没有状态也没有录音就不必走迁移，首建句层是这条路。"""
        return any(u.state for u in self.units) or bool(self.recordings)


def _tokens(text: str) -> list[str]:
    return [t for t in (_norm(t) for t in (text or "").split()) if t]


def _text_score(old_text: str, new_text: str) -> int:
    """2=词序列完全一致；1=一方是另一方的片段（拆句/并句）；0=不相干。

    两个方向都要试：拆句时新句是旧句的一段，并句时旧句是新句的一段。
    """
    old_tokens, new_tokens = _tokens(old_text), _tokens(new_text)
    if not old_tokens or not new_tokens:
        return 0
    if old_tokens == new_tokens:
        return 2
    if _locate(new_text, old_text) is not None or _locate(old_text, new_text) is not None:
        return 1
    return 0


def _overlap_ms(a_start: int, a_end: int, b_start: int, b_end: int) -> int:
    return max(0, min(a_end, b_end) - max(a_start, b_start))


def _best_match(
    old_text: str,
    old_start: int,
    old_end: int,
    candidates: list[tuple[int, str, int, int]],
) -> int | None:
    """在候选 (id, text, start_ms, end_ms) 里挑落点，文本先决、时间裁决同分。"""
    best_id: int | None = None
    best_key: tuple[int, int, int] | None = None
    for cand_id, text, start_ms, end_ms in candidates:
        score = _text_score(old_text, text)
        if score == 0:
            continue
        key = (
            score,
            _overlap_ms(old_start, old_end, start_ms, end_ms),
            -abs(start_ms - old_start),
        )
        if best_key is None or key > best_key:
            best_key, best_id = key, cand_id
    return best_id


async def snapshot_learning_records(session: AsyncSession, track_id: int) -> LearningSnapshot:
    """删句层之前把要保的东西抄下来。

    一律走列查询而不取 ORM 实体：随后要对同一批行下 bulk DELETE，
    身份映射里留着已删对象，下一次 flush 会撞上。
    """
    video_id = (
        await session.execute(select(SubtitleTrack.video_id).where(SubtitleTrack.id == track_id))
    ).scalar_one_or_none()
    if video_id is None:
        return LearningSnapshot(video_id=0)

    sentence_rows = (
        await session.execute(
            select(
                SubtitleSentence.id,
                SubtitleSentence.text,
                SubtitleSentence.start_ms,
                SubtitleSentence.end_ms,
            )
            .where(SubtitleSentence.track_id == track_id)
            .order_by(SubtitleSentence.start_ms, SubtitleSentence.id)
        )
    ).all()
    sentences = tuple(
        OldSentence(id=r[0], text=r[1], start_ms=r[2], end_ms=r[3]) for r in sentence_rows
    )

    unit_rows = (
        await session.execute(
            select(
                StudyUnit.id,
                StudyUnit.text,
                StudyUnit.start_ms,
                StudyUnit.end_ms,
                StudyUnitState.learned,
                StudyUnitState.starred,
                StudyUnitState.flagged,
                StudyUnitState.text_override,
                StudyUnitState.dictation_accuracy,
                StudyUnitState.video_id,
            )
            .outerjoin(StudyUnitState, StudyUnitState.unit_id == StudyUnit.id)
            .where(StudyUnit.track_id == track_id)
            .order_by(StudyUnit.start_ms, StudyUnit.id)
        )
    ).all()
    units: list[OldUnit] = []
    for row in unit_rows:
        state = None
        if row[9] is not None:  # 有 study_unit_state 行才算「用户留过痕迹」
            state = {
                "learned": bool(row[4]),
                "starred": bool(row[5]),
                "flagged": bool(row[6]),
                "text_override": row[7],
                "dictation_accuracy": row[8],
                "video_id": row[9],
            }
        units.append(OldUnit(id=row[0], text=row[1], start_ms=row[2], end_ms=row[3], state=state))

    sentence_ids = [s.id for s in sentences]
    recordings: tuple[OldRecording, ...] = ()
    if sentence_ids:
        rec_rows = (
            await session.execute(
                select(ShadowRecording.id, ShadowRecording.sentence_id, ShadowRecording.unit_id)
                .where(ShadowRecording.sentence_id.in_(sentence_ids))
                .order_by(ShadowRecording.id)
            )
        ).all()
        recordings = tuple(
            OldRecording(id=r[0], sentence_id=r[1], unit_id=r[2]) for r in rec_rows
        )

    return LearningSnapshot(
        video_id=video_id, units=tuple(units), sentences=sentences, recordings=recordings
    )


@dataclass
class MigrationStats:
    states_total: int = 0
    states_moved: int = 0
    recordings_total: int = 0
    recordings_moved: int = 0
    lost_examples: list[str] = field(default_factory=list)

    @property
    def lost(self) -> int:
        return (self.states_total - self.states_moved) + (
            self.recordings_total - self.recordings_moved
        )

    def as_metrics(self) -> dict:
        return {
            "records_total": self.states_total + self.recordings_total,
            "records_moved": self.states_moved + self.recordings_moved,
            "records_lost": self.lost,
        }


async def migrate_learning_records(
    session: AsyncSession,
    track_id: int,
    snapshot: LearningSnapshot,
    new_sentences: list[SubtitleSentence],
    new_units: list[StudyUnit],
) -> dict:
    """把快照里的状态与录音挂到新句上，搬不动的落一条 `SubtitleIssue`。

    调用时机：新句层已 flush 拿到 id、旧句层**尚未删除**。新旧共存期间靠序号正负区分
    （新行占负号），这样旧文本还能拿来比对，删除也能按 `ordinal >= 0` 一次扫干净。

    幂等：状态按新学习句 id 建行，`study_unit_state.unit_id` 唯一；同一次重建里两条旧
    状态落到同一新句时合并成一行，连跑两次不会翻倍。
    """
    stats = MigrationStats()
    if not snapshot.has_records:
        await _clear_stale_issues(session, snapshot.video_id)
        return stats.as_metrics()

    unit_candidates = [(u.id, u.text, u.start_ms, u.end_ms) for u in new_units]
    sentence_candidates = [(s.id, s.text, s.start_ms, s.end_ms) for s in new_sentences]

    unit_map: dict[int, int] = {}
    for old in snapshot.units:
        target = _best_match(old.text, old.start_ms, old.end_ms, unit_candidates)
        if target is not None:
            unit_map[old.id] = target

    sentence_map: dict[int, int] = {}
    for old_sentence in snapshot.sentences:
        target = _best_match(
            old_sentence.text, old_sentence.start_ms, old_sentence.end_ms, sentence_candidates
        )
        if target is not None:
            sentence_map[old_sentence.id] = target

    # 两条旧状态落到同一条新学习句（两句并一句）时合并，别让唯一约束把第二条顶掉
    merged: dict[int, dict] = {}
    for old in snapshot.units:
        if not old.state:
            continue
        stats.states_total += 1
        new_unit_id = unit_map.get(old.id)
        if new_unit_id is None:
            if len(stats.lost_examples) < 3:
                stats.lost_examples.append(old.text[:40])
            continue
        stats.states_moved += 1
        slot = merged.setdefault(new_unit_id, {"video_id": old.state["video_id"]})
        for flag in _STATE_FLAGS:
            slot[flag] = bool(slot.get(flag)) or bool(old.state[flag])
        if slot.get("text_override") is None:
            slot["text_override"] = old.state["text_override"]
        if old.state["dictation_accuracy"] is not None:
            slot["dictation_accuracy"] = max(
                slot.get("dictation_accuracy") or 0, old.state["dictation_accuracy"]
            )

    for new_unit_id, payload in merged.items():
        session.add(
            StudyUnitState(
                unit_id=new_unit_id,
                video_id=payload["video_id"],
                learned=bool(payload.get("learned")),
                starred=bool(payload.get("starred")),
                flagged=bool(payload.get("flagged")),
                text_override=payload.get("text_override"),
                dictation_accuracy=payload.get("dictation_accuracy"),
            )
        )

    for rec in snapshot.recordings:
        stats.recordings_total += 1
        new_sentence_id = sentence_map.get(rec.sentence_id)
        if new_sentence_id is None:
            continue
        stats.recordings_moved += 1
        # 只改归属，audio_key / 比对 / 点评原样留着——文件在磁盘上没动
        await session.execute(
            update(ShadowRecording)
            .where(ShadowRecording.id == rec.id)
            .values(
                sentence_id=new_sentence_id,
                unit_id=unit_map.get(rec.unit_id) if rec.unit_id else None,
            )
        )

    await _clear_stale_issues(session, snapshot.video_id)
    if stats.lost:
        session.add(
            SubtitleIssue(
                video_id=snapshot.video_id,
                sentence_id=None,
                source="health",
                kind=ISSUE_KIND_RECORDS_LOST,
                severity="error",
                detail=_lost_detail(stats),
            )
        )
        logger.warning(
            "轨 %s 重建句层：%s 条学习记录/录音找不到新落点", track_id, stats.lost
        )
    return stats.as_metrics()


def _lost_detail(stats: MigrationStats) -> str:
    lost_states = stats.states_total - stats.states_moved
    lost_recordings = stats.recordings_total - stats.recordings_moved
    parts = []
    if lost_states:
        parts.append(f"{lost_states} 条学习记录（已学 ✓ / 收藏 / 旗标 / 听写成绩）")
    if lost_recordings:
        parts.append(f"{lost_recordings} 条跟读录音")
    detail = "重建句层后，" + "、".join(parts) + "在新句里找不到落点，已随旧句一并清除"
    if stats.lost_examples:
        detail += "。例：" + " / ".join(f"「{t}」" for t in stats.lost_examples)
    return detail


async def _clear_stale_issues(session: AsyncSession, video_id: int) -> None:
    """重跑幂等：上一次重建留下的未处理丢失提示先清掉，本次没丢就不该还挂着。"""
    await session.execute(
        delete(SubtitleIssue).where(
            SubtitleIssue.video_id == video_id,
            SubtitleIssue.kind == ISSUE_KIND_RECORDS_LOST,
            SubtitleIssue.state == "open",
        )
    )


async def purge_old_sentence_layer(session: AsyncSession, track_id: int) -> None:
    """删掉旧句层及其残留关联行（新行此刻还占着负序号，扫不到）。

    顺序按依赖自底向上；不靠 FK 的 CASCADE——内存 SQLite 上它根本不触发。
    """
    old_units = select(StudyUnit.id).where(StudyUnit.track_id == track_id, StudyUnit.ordinal >= 0)
    old_sentences = select(SubtitleSentence.id).where(
        SubtitleSentence.track_id == track_id, SubtitleSentence.ordinal >= 0
    )
    await session.execute(delete(StudyUnitState).where(StudyUnitState.unit_id.in_(old_units)))
    await session.execute(
        delete(ShadowRecording).where(ShadowRecording.sentence_id.in_(old_sentences))
    )
    await session.execute(
        delete(SubtitleIssue).where(SubtitleIssue.sentence_id.in_(old_sentences))
    )
    await session.execute(
        delete(StudyUnit).where(StudyUnit.track_id == track_id, StudyUnit.ordinal >= 0)
    )
    await session.execute(
        delete(SubtitleSentence).where(
            SubtitleSentence.track_id == track_id, SubtitleSentence.ordinal >= 0
        )
    )
    await session.flush()
