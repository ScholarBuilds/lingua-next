"""语法句的结构化编辑：合并、拆分、改文本重建（需求 09 v7 FR-86）。

修复代理工具箱的领域操作。三个操作共同的收尾是 `_rebuild_units`：
学习句、词组区间、译文都是语法句的派生物，句一变全部重算/置空，
不能留半新半旧的产物（v6 的 single 重跑事故教训）。
"""

import re

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from domain import ratchet
from domain.analysis import content_key
from domain.articles import utf16_len
from domain.models import StudyUnit, SubtitleSentence
from domain.subtitle_sentences import DEFAULT_LIMITS, Limits, Word, _split_unit


class SentenceOpError(Exception):
    """结构化编辑无法执行（不相邻、找不到切点、词时间戳缺失）。"""


def _words_of(row: SubtitleSentence) -> list[Word]:
    # 落库的 words 不带 cue_id（[start_ms,end_ms,surface,gs,ge]），这里补 0 占位
    return [Word(w[0], w[1], w[2], w[3], w[4], 0) for w in (row.words or [])]


async def _rebuild_units(
    session: AsyncSession, row: SubtitleSentence, limits: Limits = DEFAULT_LIMITS
) -> int:
    """按当前 text/words 重建该句的学习句；无词级时间戳则整句作一个单位。"""
    await session.execute(delete(StudyUnit).where(StudyUnit.sentence_id == row.id))
    words = _words_of(row)
    if words:
        spans = _split_unit(words, row.text, 0, len(words), limits)
        pieces = [
            (words[lo].gs, words[hi - 1].ge, words[lo].start_ms, words[hi - 1].end_ms)
            for lo, hi in spans
        ]
    else:
        pieces = [(0, utf16_len(row.text), row.start_ms, row.end_ms)]
    for idx, (gs, ge, start_ms, end_ms) in enumerate(pieces):
        text = row.text[gs:ge].strip()
        if not text:
            continue
        session.add(
            StudyUnit(
                # 占位序号必须全轨唯一且为负（(track_id, ordinal) 有唯一约束，
                # autoflush 随时可能触发）；_renumber 统一落正式序号
                sentence_id=row.id, track_id=row.track_id,
                ordinal=-(row.id * 100 + idx + 1),
                start_ms=start_ms, end_ms=end_ms, text=text,
                char_start=gs, char_end=ge, content_hash=content_key(text),
            )
        )
    return len(pieces)


async def _renumber(session: AsyncSession, track_id: int) -> None:
    """句序号与学习句全局序号重排（合并/拆分后必做，唯一约束依赖它）。"""
    sentences = (
        (
            await session.execute(
                select(SubtitleSentence)
                .where(SubtitleSentence.track_id == track_id)
                .order_by(SubtitleSentence.start_ms, SubtitleSentence.id)
            )
        )
        .scalars()
        .all()
    )
    # 先移到负区间再落位，绕开 (track_id, ordinal) 唯一约束的中途冲突
    for idx, row in enumerate(sentences):
        row.ordinal = -(idx + 1)
    await session.flush()
    for idx, row in enumerate(sentences):
        row.ordinal = idx
    units = (
        (
            await session.execute(
                select(StudyUnit)
                .where(StudyUnit.track_id == track_id)
                .order_by(StudyUnit.start_ms, StudyUnit.id)
            )
        )
        .scalars()
        .all()
    )
    # 与句同款两段式：先全部落到负区间，再排正式序号，绕开唯一约束中途冲突
    for idx, unit in enumerate(units):
        unit.ordinal = -(idx + 1) - 10_000_000
    await session.flush()
    for idx, unit in enumerate(units):
        unit.ordinal = idx


_STRIP = ".,!?;:'\"()[]—–-"


def _norm(token: str) -> str:
    return token.lower().strip(_STRIP)


def _locate(text: str, needle: str) -> int | None:
    """在句中定位 needle 起点（UTF-16 偏移）。

    先精确（大小写不敏感）；不中则按归一化词序列匹配——调用方（尤其修复代理）
    常引用自己改写过标点/大小写的版本，逐字符匹配对不上（实测踩过）。
    """
    match = re.search(re.escape(needle), text, re.IGNORECASE)
    if match is not None:
        return utf16_len(text[: match.start()])

    hay_tokens = text.split()
    hay = [_norm(t) for t in hay_tokens]
    need = [n for n in (_norm(t) for t in needle.split()) if n]
    probe = need[: min(5, len(need))]
    if len(probe) < 2:
        return None
    for i in range(len(hay) - len(probe) + 1):
        if hay[i : i + len(probe)] == probe:
            # 命中词下标 → 该词在原文中的字符位置
            char_pos = 0
            for j in range(i):
                char_pos = text.find(hay_tokens[j], char_pos) + len(hay_tokens[j])
            start = text.find(hay_tokens[i], char_pos)
            return utf16_len(text[:start])
    return None


def _mark_dirty(row: SubtitleSentence) -> None:
    """文本变了：译文与词组区间全部失效，交给 translate / enrich.phrases 重算。"""
    row.content_hash = content_key(row.text)
    row.text_zh = None
    ratchet.clear(row, "text_zh")  # 原文变了，旧译文的人工锁一并失效
    row.phrases = None


async def merge_sentences(session: AsyncSession, first_id: int, second_id: int) -> dict:
    """把相邻两句合并为一句（"第 5、6 句其实是一句话"）。"""
    a = await session.get(SubtitleSentence, first_id)
    b = await session.get(SubtitleSentence, second_id)
    if a is None or b is None:
        raise SentenceOpError("句子不存在")
    if a.track_id != b.track_id:
        raise SentenceOpError("两句不在同一字幕轨")
    if a.ordinal > b.ordinal:
        a, b = b, a
    if b.ordinal - a.ordinal != 1:
        raise SentenceOpError(f"两句不相邻（序号 {a.ordinal} 与 {b.ordinal}）")

    joiner = "" if a.text.endswith(("-", "—")) else " "
    offset = utf16_len(a.text + joiner)
    merged_words = list(a.words or [])
    for w in b.words or []:
        merged_words.append([w[0], w[1], w[2], w[3] + offset, w[4] + offset])

    a.text = a.text + joiner + b.text
    a.end_ms = b.end_ms
    a.words = merged_words or None
    a.src_cue_ids = [*(a.src_cue_ids or []), *(b.src_cue_ids or [])] or None
    a.is_noise = a.is_noise and b.is_noise
    _mark_dirty(a)

    await session.execute(delete(StudyUnit).where(StudyUnit.sentence_id == b.id))
    await session.delete(b)
    await session.flush()
    units = await _rebuild_units(session, a)
    await _renumber(session, a.track_id)
    return {"sentence_id": a.id, "text": a.text, "units": units}


async def split_sentence(session: AsyncSession, sentence_id: int, at_text: str) -> dict:
    """在指定文字处把一句拆成两句：`at_text` 是第二句的开头（大小写不敏感）。"""
    row = await session.get(SubtitleSentence, sentence_id)
    if row is None:
        raise SentenceOpError("句子不存在")
    needle = at_text.strip()
    if not needle:
        raise SentenceOpError("需要给出第二句的开头文字")
    pos = _locate(row.text, needle)
    if pos is None:
        raise SentenceOpError(f"句中找不到「{needle[:60]}」")
    if pos == 0:
        raise SentenceOpError("切点在句首，无从拆分")

    words = _words_of(row)
    if words:
        # 切点落到最近的词边界；找不到词界说明词时间戳与文本错位
        idx = next((i for i, w in enumerate(words) if w.gs >= pos), None)
        if idx is None or idx == 0:
            raise SentenceOpError("切点不在词边界上")
        head_words = [[w.start_ms, w.end_ms, w.surface, w.gs, w.ge] for w in words[:idx]]
        cut = words[idx].gs
        tail_words = [
            [w.start_ms, w.end_ms, w.surface, w.gs - cut, w.ge - cut] for w in words[idx:]
        ]
        head_end_ms, tail_start_ms = words[idx - 1].end_ms, words[idx].start_ms
    else:
        head_words, tail_words = None, None
        cut = pos
        # 无词级时间戳按字符占比近似
        span = row.end_ms - row.start_ms
        head_end_ms = row.start_ms + int(span * cut / max(1, utf16_len(row.text)))
        tail_start_ms = head_end_ms

    tail_text = row.text[cut:].strip()
    head_text = row.text[:cut].strip()
    if not head_text or not tail_text:
        raise SentenceOpError("拆分后有一侧为空")

    tail = SubtitleSentence(
        # 占位序号必须唯一且为负（(track_id, ordinal) 唯一约束在 flush 即生效），
        # _renumber 统一落正式序号——units 占位同款教训
        track_id=row.track_id, ordinal=-(row.id * 100 + 1),
        start_ms=tail_start_ms, end_ms=row.end_ms,
        text=tail_text, content_hash=content_key(tail_text),
        words=tail_words, is_noise=row.is_noise, src_cue_ids=row.src_cue_ids,
    )
    row.text = head_text
    row.end_ms = head_end_ms
    row.words = head_words
    _mark_dirty(row)

    session.add(tail)
    await session.flush()
    units_a = await _rebuild_units(session, row)
    units_b = await _rebuild_units(session, tail)
    await _renumber(session, row.track_id)
    return {
        "first_id": row.id, "second_id": tail.id,
        "first_text": row.text, "second_text": tail.text,
        "units": units_a + units_b,
    }


async def rewrite_sentence(
    session: AsyncSession, sentence_id: int, text: str | None, text_zh: str | None
) -> dict:
    """改句文本（含学习句重建与下游失效标记）；只改译文则不动英文侧。"""
    row = await session.get(SubtitleSentence, sentence_id)
    if row is None:
        raise SentenceOpError("句子不存在")
    stale: list[str] = []
    if text is not None and text.strip() and text.strip() != row.text:
        new = text.strip()
        # 词序不变（只加标点/改大小写/纠错词数相同）时按词对齐保留时间戳，否则丢弃
        old_tokens = row.text.split()
        new_tokens = new.split()
        if row.words and len(old_tokens) == len(new_tokens):
            rebuilt = []
            pos = 0
            for w, token in zip(_words_of(row), new_tokens, strict=False):
                gs = new.find(token, pos)
                gs16 = utf16_len(new[:gs])
                rebuilt.append([w.start_ms, w.end_ms, token, gs16, gs16 + utf16_len(token)])
                pos = gs + len(token)
            row.words = rebuilt
        else:
            row.words = None
        row.text = new
        _mark_dirty(row)
        await _rebuild_units(session, row)
        await _renumber(session, row.track_id)
        stale = ["translate", "enrich.phrases"]
    if text_zh is not None:
        row.text_zh = text_zh.strip() or None
        ratchet.mark(row, "text_zh")  # 此后重跑 translate 不再覆盖这句（BR-36）
    return {"sentence_id": row.id, "text": row.text, "text_zh": row.text_zh, "stale": stale}


async def mark_noise(
    session: AsyncSession, sentence_id: int, noise: bool = True
) -> dict:
    """把一句标记为噪声 / 撤销标记（v10.6 FR-141）。

    重复转写句、口播垃圾这类不该学的内容，用软删除而不是真删：
    `is_noise` 是既有语义——字幕列表、播放序列、AI 校验、陪读上下文、体检的
    speech 统计全都已经按它过滤，标了就等于从学习链路里消失。

    比硬删好在三点：时间轴与 cue 归属不用重排（避开"负数占位两段式"那套坑）、
    误判可一键撤销、原始转写留档可追溯。
    """
    row = await session.get(SubtitleSentence, sentence_id)
    if row is None:
        raise ValueError(f"句 {sentence_id} 不存在")
    before = row.is_noise
    row.is_noise = noise
    # 不调 _mark_dirty：文本没变，译文与词组区间依然有效，
    # 清掉反而会让体检报"译文缺"并触发无谓重译
    await session.flush()
    return {
        "sentence_id": sentence_id,
        "text": row.text,
        "was_noise": before,
        "is_noise": noise,
        "effect": "已移出学习链路（字幕列表/播放/校验/陪读都不再出现）"
        if noise
        else "已恢复为正常句",
    }


async def resegment_sentence(session: AsyncSession, sentence_id: int) -> dict:
    """把一句按其自身标点重新分成多句（pysbd，与管线分句同引擎）。

    典型用法：超长黏连句先用 rewrite_sentence 补好标点，再调本操作切开——
    比让调用方逐次指定切点可靠得多。
    """
    from domain.segmentation import split_sentences

    row = await session.get(SubtitleSentence, sentence_id)
    if row is None:
        raise SentenceOpError("句子不存在")
    # split_sentences 返回 UTF-16 区间列表；取各段文本
    spans = split_sentences(row.text)
    parts = [row.text[a:b].strip() for a, b in spans]
    parts = [p for p in parts if p]
    if len(parts) < 2:
        raise SentenceOpError("按标点只能切出一句——先用改写把标点补上")

    made = [row.id]
    current_id = row.id
    # 逐段拆：每次以"下一段的开头"为切点，复用 split_sentence 的全部校验与重建
    for part in parts[1:]:
        out = await split_sentence(session, current_id, part[:80])
        current_id = out["second_id"]
        made.append(current_id)
    return {"sentence_ids": made, "count": len(made)}


async def force_split_long(
    session: AsyncSession, track_id: int, max_chars: int = 400
) -> dict:
    """长句兜底（需求 09 v8 FR-102）：分句后仍超长的语法句，LLM 主动补标点再按标点切开。

    保证任何视频出管线时没有超长句漏网。词序列一致性校验兜底（BR-28）；
    LLM 恢复失败或切不出多句的如实留存，由 verify 报出而不是硬切。
    """
    from sqlalchemy import func as sa_func

    from domain.punctuation import restore_punctuation

    rows = (
        (
            await session.execute(
                select(SubtitleSentence).where(
                    SubtitleSentence.track_id == track_id,
                    SubtitleSentence.is_noise.is_(False),
                    sa_func.length(SubtitleSentence.text) > max_chars,
                )
            )
        )
        .scalars()
        .all()
    )
    processed = split_count = 0
    still_long: list[int] = []
    for row in rows:
        processed += 1
        try:
            full, stat = await restore_punctuation([row.text], force=True)
            if stat["restored"] and full.strip() and full.strip() != row.text:
                await rewrite_sentence(session, row.id, full.strip(), None)
            out = await resegment_sentence(session, row.id)
            split_count += out["count"]
            await session.commit()
        except SentenceOpError:
            still_long.append(row.id)
            await session.commit()
        except Exception:
            await session.rollback()
            still_long.append(row.id)
    return {"long_sentences": processed, "split_into": split_count, "still_long": still_long}


# 校验动作 → 领域操作的分派表（v10.7 FR-143）
_DEFAULT_BY_KIND = {
    "translation_mismatch": "replace_translation",
    "wrong_word": "replace_text",
    "noise": "mark_noise",
    "bad_split": "manual",
}


def resolve_action(kind: str, action: str | None, suggestion: str | None) -> str:
    """旧数据没有 action 字段，按 kind + 有无建议兜底，行为与 v10.6 一致。"""
    if action:
        return action
    fallback = _DEFAULT_BY_KIND.get(kind, "manual")
    if fallback in ("replace_text", "replace_translation") and not (suggestion or "").strip():
        return "manual"
    return fallback


async def apply_issue_action(
    session: AsyncSession,
    sentence_id: int,
    action: str,
    suggestion: str | None,
    anchor: str | None,
) -> dict:
    """按动作把一条校验问题落到字幕上（v10.7 FR-143）。

    返回 {applied, change, needs_zh}：change 是给 UI 看的「旧 → 新」，
    needs_zh 表示原文变了要补译（调用方负责入队，这里不碰任务队列）。
    """
    row = await session.get(SubtitleSentence, sentence_id)
    if row is None:
        raise ValueError(f"句 {sentence_id} 不存在")

    text = (suggestion or "").strip()

    if action == "replace_translation" and text:
        change = {"field": "译文", "old": row.text_zh, "new": text}
        row.text_zh = text
        ratchet.mark(row, "text_zh")
        return {"applied": True, "change": change, "needs_zh": False}

    if action == "replace_text" and text:
        change = {"field": "原文", "old": row.text, "new": text}
        row.text = text
        ratchet.mark(row, "text")
        _mark_dirty(row)
        return {"applied": True, "change": change, "needs_zh": True}

    if action == "mark_noise":
        out = await mark_noise(session, sentence_id, True)
        return {
            "applied": True,
            "change": {"field": "状态", "old": row.text, "new": "已移出学习链路（噪声）"},
            "needs_zh": False,
            "detail": out["effect"],
        }

    if action in ("merge_prev", "merge_next"):
        neighbour = await _neighbour(session, row, -1 if action == "merge_prev" else 1)
        if neighbour is None:
            return {"applied": False, "change": None, "needs_zh": False,
                    "reason": "没有相邻句可合并"}
        first, second = (neighbour, row) if action == "merge_prev" else (row, neighbour)
        before = first.text
        out = await merge_sentences(session, first.id, second.id)
        return {
            "applied": True,
            "change": {"field": "断句", "old": before, "new": out.get("text", first.text)},
            "needs_zh": True,
        }

    if action == "split_at" and (anchor or "").strip():
        before = row.text
        out = await split_sentence(session, sentence_id, anchor.strip())
        return {
            "applied": True,
            "change": {"field": "断句", "old": before, "new": out.get("first", row.text)},
            "needs_zh": True,
        }

    return {"applied": False, "change": None, "needs_zh": False,
            "reason": "该问题没有可自动执行的修法（action=manual）"}


async def _neighbour(
    session: AsyncSession, row: SubtitleSentence, delta: int
) -> SubtitleSentence | None:
    stmt = (
        select(SubtitleSentence)
        .where(
            SubtitleSentence.track_id == row.track_id,
            SubtitleSentence.ordinal == row.ordinal + delta,
        )
        .limit(1)
    )
    return (await session.execute(stmt)).scalar_one_or_none()
