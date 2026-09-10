"""管线产物体检：确定性检查 + ready/degraded 判定（需求 09 v6 FR-79/80）。

从 `scripts/verify_video_pipeline.py` 提炼而来，脚本改为调用本模块，避免两套标准。
每条问题都带 `fix_step`，追踪页据此把"重跑这一步"的按钮直接摆在问题旁边。

v6 的触发故障能静默六小时，直接放行者就是"流程跑完即 ready"。这里把 ready 收紧为
「有 whisper 轨 + 句层非空 + 译文覆盖 100%」，不满足一律落 degraded。
"""

from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from domain.models import StudyUnit, SubtitleSentence, SubtitleTrack, Video
from domain.pipeline import PIPELINE_VERSION
from domain.subtitle_sentences import MAX_UNIT_CHARS, MAX_UNIT_S

# 语法句超过这个长度说明分句没生效（无标点长段被当成一句）
MAX_SENTENCE_CHARS = 400

# 采纳原文修改会置空该句译文并异步入队补译。置空是同步的、补译要几秒，
# 这段窗口里体检必然看到缺口——报成 error 会把视频误判为 degraded，
# 用户看到的就是"译文缺 N 句，多刷几次又好了"（FR-142）
ZH_REFILL_GRACE = timedelta(minutes=3)


@dataclass
class Issue:
    code: str
    level: str  # error | warn | info
    message: str
    fix_step: str | None = None


def _issue(code: str, level: str, message: str, fix_step: str | None = None) -> dict:
    return asdict(Issue(code, level, message, fix_step))


async def inspect(session: AsyncSession, video_id: int) -> dict:
    """单条视频体检 → {ok, gate, issues, metrics}。纯读，不改任何数据。"""
    video = await session.get(Video, video_id)
    if video is None:
        return {"ok": False, "gate": "failed", "issues": [], "metrics": {}}

    tracks = (
        (await session.execute(select(SubtitleTrack).where(SubtitleTrack.video_id == video_id)))
        .scalars()
        .all()
    )
    whisper = next((t for t in tracks if t.kind == "whisper"), None)
    official = next((t for t in tracks if t.kind == "official"), None)
    primary = whisper or official

    issues: list[dict] = []
    metrics: dict = {"tracks": [t.kind for t in tracks]}

    if primary is None:
        issues.append(_issue("no_track", "error", "没有可用的英文字幕轨", "transcribe"))
        return {"ok": False, "gate": "degraded", "issues": issues, "metrics": metrics}

    # ADR-007：auto 轨全小写无标点带重复词，留着只会让用户切过去看到空句层（BR-23）
    stale_auto = [t for t in tracks if t.kind == "auto"]
    if whisper is not None and stale_auto:
        issues.append(
            _issue("auto_track_left", "warn",
                   f"残留 {len(stale_auto)} 条 YouTube auto 轨（无句层，切过去是空的）",
                   "sentences")
        )

    sentences = (
        (
            await session.execute(
                select(SubtitleSentence)
                .where(SubtitleSentence.track_id == primary.id)
                .order_by(SubtitleSentence.ordinal)
            )
        )
        .scalars()
        .all()
    )
    units = (
        (
            await session.execute(
                select(StudyUnit)
                .where(StudyUnit.track_id == primary.id)
                .order_by(StudyUnit.ordinal)
            )
        )
        .scalars()
        .all()
    )

    if not sentences:
        issues.append(_issue("no_sentences", "error", "句层为空，字幕列表将显示 0 句", "sentences"))
        metrics.update({"sentences": 0, "units": 0})
        return {"ok": False, "gate": "degraded", "issues": issues, "metrics": metrics}

    speech = [s for s in sentences if not s.is_noise]
    translated = sum(1 for s in speech if (s.text_zh or "").strip())
    with_phrases = sum(1 for s in sentences if s.phrases)
    longest = max(len(s.text) for s in sentences)
    over = sum(
        1
        for u in units
        if (u.end_ms - u.start_ms) / 1000 > MAX_UNIT_S + 0.01 or len(u.text) > MAX_UNIT_CHARS
    )
    monotonic = all(units[i].start_ms <= units[i + 1].start_ms for i in range(len(units) - 1))
    meta = primary.meta or {}
    engine = (meta.get("alignment") or {}).get("engine")
    punct = meta.get("punctuation") or {}

    metrics.update({
        "sentences": len(sentences),
        "units": len(units),
        "noise": len(sentences) - len(speech),
        "translated": translated,
        "speech": len(speech),
        "with_phrases": with_phrases,
        "over_limit": over,
        "longest_sentence": longest,
        "align_engine": engine,
        "punctuation": punct or None,
        "code_version": (meta.get("pipeline") or {}).get("version"),
    })

    if speech and translated < len(speech):
        gap = len(speech) - translated
        refill_at = (primary.meta or {}).get("zh_refill_at")
        refilling = False
        if refill_at:
            try:
                started = datetime.fromisoformat(str(refill_at))
                if started.tzinfo is None:
                    started = started.replace(tzinfo=UTC)
                refilling = datetime.now(UTC) - started < ZH_REFILL_GRACE
            except ValueError:
                refilling = False
        issues.append(
            _issue(
                "translation_gap",
                "info" if refilling else "error",
                f"{gap}/{len(speech)} 句译文正在补齐（采纳原文修改后自动触发）"
                if refilling
                else f"译文缺 {gap}/{len(speech)} 句",
                "translate",
            )
        )
    if longest > MAX_SENTENCE_CHARS:
        issues.append(
            _issue("long_sentence", "warn",
                   f"存在 {longest} 字符的超长语法句，多半是标点没恢复出来", "punctuate")
        )
    if punct.get("failed"):
        issues.append(
            _issue("punctuation_failed", "warn",
                   f"标点恢复 {punct['failed']}/{punct.get('chunks', 0)} 块最终失败", "punctuate")
        )
    if not monotonic:
        issues.append(_issue("timing_disorder", "error", "学习句时间戳非单调", "align"))
    if engine is None:
        issues.append(
            _issue("no_pipeline_meta", "warn", "轨无管线 meta，是旧管线的产物", "transcribe")
        )
    elif engine != "ctc":
        issues.append(
            _issue("align_degraded", "warn", f"对齐降级为 {engine}，词级时间戳偏松", "align")
        )
    if with_phrases == 0:
        issues.append(
            _issue("no_phrases", "warn", "没有词组区间，词组高亮不可用", "enrich.phrases")
        )
    if units and over / len(units) > 0.05:
        issues.append(
            _issue("over_limit", "info",
                   f"{over}/{len(units)} 条学习句超出时长或字数上限", "sentences")
        )
    # 陈旧标记（FR-66）：抄 Dagster asset code_version staleness
    produced = (meta.get("pipeline") or {}).get("version")
    if produced and produced != PIPELINE_VERSION:
        issues.append(
            _issue("stale_pipeline", "info",
                   f"产物由 {produced} 版管线生成，当前为 {PIPELINE_VERSION}", None)
        )

    gate = gate_status(metrics, issues)
    return {
        "ok": not any(i["level"] == "error" for i in issues),
        "gate": gate,
        "issues": issues,
        "metrics": metrics,
    }


def gate_status(metrics: dict, issues: list[dict]) -> str:
    """质量门禁（FR-79）：任一 error 级问题即 degraded，不再伪装成 ready。"""
    if any(i["level"] == "error" for i in issues):
        return "degraded"
    if not metrics.get("sentences"):
        return "degraded"
    return "ready"
