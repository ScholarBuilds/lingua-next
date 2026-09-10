"""主体列表取数（需求 12 FR-240）：按域返回同构行，前端一套渲染吃所有域。

每个域自己知道怎么统计自己的主体，但对外形状一致：
{id, title, health, 以及该域 columns 声明里的字段}。
"""

from datetime import datetime
from typing import Any

from sqlalchemy import Integer, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from domain.models import (
    ImageAsset,
    ImageJob,
    PipelineRun,
    SubtitleIssue,
    SubtitleSentence,
    SubtitleTrack,
    Video,
    Wordlist,
    WordlistItem,
)
from domain.pipeline import PIPELINES

# 视频 status → 健康档；未列出的一律算处理中
_VIDEO_HEALTH = {
    "ready": "ready",
    "degraded": "degraded",
    "failed": "failed",
    "pending": "pending",
}


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _run_cell(run: dict | None, has_content: bool) -> dict | None:
    """最近运行单元格。

    有产物却没有 run 记录的是管线改造之前生成的历史数据，
    显示成"未跑过"会让人以为是空本（实测困惑过）。
    """
    if run is not None:
        return run
    return {"id": None, "status": "legacy", "kind": "", "at": None} if has_content else None


async def _last_runs(session: AsyncSession, domain: str) -> dict[int, dict]:
    """每个主体的最近一次运行，供列表末列展示。"""
    latest = (
        select(
            PipelineRun.subject_id.label("sid"),
            func.max(PipelineRun.id).label("rid"),
        )
        .where(PipelineRun.domain == domain)
        .group_by(PipelineRun.subject_id)
        .subquery()
    )
    rows = (
        await session.execute(
            select(PipelineRun).join(latest, PipelineRun.id == latest.c.rid)
        )
    ).scalars()
    return {
        r.subject_id: {
            "id": r.id,
            "status": r.status,
            "kind": r.kind,
            "at": _iso(r.finished_at or r.started_at),
        }
        for r in rows
    }


async def _video_rows(session: AsyncSession) -> list[dict]:
    stats = dict(
        (
            await session.execute(
                select(
                    SubtitleTrack.video_id,
                    func.count(SubtitleSentence.id),
                )
                .join(SubtitleSentence, SubtitleSentence.track_id == SubtitleTrack.id)
                .where(SubtitleSentence.is_noise.is_(False))
                .group_by(SubtitleTrack.video_id)
            )
        ).all()
    )
    translated = dict(
        (
            await session.execute(
                select(
                    SubtitleTrack.video_id,
                    func.count(SubtitleSentence.id),
                )
                .join(SubtitleSentence, SubtitleSentence.track_id == SubtitleTrack.id)
                .where(
                    SubtitleSentence.is_noise.is_(False),
                    SubtitleSentence.text_zh.is_not(None),
                )
                .group_by(SubtitleTrack.video_id)
            )
        ).all()
    )
    issues = dict(
        (
            await session.execute(
                select(SubtitleIssue.video_id, func.count())
                .where(SubtitleIssue.state == "open")
                .group_by(SubtitleIssue.video_id)
            )
        ).all()
    )
    runs = await _last_runs(session, "video")
    videos = (
        await session.execute(select(Video).order_by(Video.id.desc()))
    ).scalars()
    out = []
    for v in videos:
        total = int(stats.get(v.id, 0))
        out.append(
            {
                "id": v.id,
                "title": v.title_zh or v.title or f"视频 {v.id}",
                "health": _VIDEO_HEALTH.get(v.status, "processing"),
                "status": v.status,
                "sentences": total,
                "translated": {"done": int(translated.get(v.id, 0)), "total": total},
                "issues": int(issues.get(v.id, 0)),
                "last_run": _run_cell(runs.get(v.id), total > 0),
            }
        )
    return out


async def _scenario_rows(session: AsyncSession) -> list[dict]:
    counts = dict(
        (
            await session.execute(
                select(WordlistItem.wordlist_id, func.count())
                .group_by(WordlistItem.wordlist_id)
            )
        ).all()
    )
    in_dict = dict(
        (
            await session.execute(
                select(
                    WordlistItem.wordlist_id,
                    func.sum(func.cast(WordlistItem.dict_miss, Integer)),
                ).group_by(WordlistItem.wordlist_id)
            )
        ).all()
    )
    runs = await _last_runs(session, "scenario_deck")
    decks = (
        await session.execute(
            select(Wordlist)
            .where(Wordlist.kind == "scenario")
            .order_by(Wordlist.id.desc())
        )
    ).scalars()
    out = []
    for d in decks:
        total = int(counts.get(d.id, 0))
        missed = int(in_dict.get(d.id) or 0)
        run = runs.get(d.id)
        # 生成中的 run 优先决定健康档：草稿本正在跑时不该显示"待确认"
        health = "processing" if run and run["status"] in ("running", "pending") else None
        if health is None:
            health = "failed" if run and run["status"] == "failed" else (
                "draft" if d.status == "draft" else "ready"
            )
        out.append(
            {
                "id": d.id,
                "title": f"{d.emoji or '📘'} {d.name}",
                "health": health,
                "status": d.status,
                "words": total,
                "dict_hit": {"done": total - missed, "total": total},
                "cefr": d.cefr or "—",
                "last_run": _run_cell(run, total > 0),
            }
        )
    return out


async def _image_rows(session: AsyncSession) -> list[dict]:
    """生图任务行（模块 16）。标题取用途 + 那句话，没写就用主体信息兜。"""
    from domain.image_prompts import TARGETS

    counts = dict(
        (
            await session.execute(
                select(ImageAsset.run_id, func.count())
                .where(ImageAsset.run_id.isnot(None))
                .group_by(ImageAsset.run_id)
            )
        ).all()
    )
    runs = await _last_runs(session, "image_gen")
    jobs = (
        await session.execute(select(ImageJob).order_by(ImageJob.id.desc()))
    ).scalars()
    out = []
    for job in jobs:
        run = runs.get(job.id)
        health = "processing" if run and run["status"] in ("running", "pending") else None
        if health is None:
            health = {"failed": "failed", "done": "ready"}.get(job.status, "pending")
        target = TARGETS.get(job.target_key)
        label = target.label if target else job.target_key
        idea = (job.idea or "").strip()
        out.append(
            {
                "id": job.id,
                "title": f"{label}：{idea}" if idea else label,
                "health": health,
                "status": job.status,
                "images": int(counts.get(run["id"], 0)) if run else 0,
                "target": label,
                "last_run": _run_cell(run, job.applied_asset_id is not None),
            }
        )
    return out


_PROVIDERS = {
    "video": _video_rows,
    "scenario_deck": _scenario_rows,
    "image_gen": _image_rows,
}


async def subject_rows(
    session: AsyncSession,
    domain: str,
    *,
    health: str = "",
    q: str = "",
    offset: int = 0,
    limit: int = 50,
) -> dict[str, Any]:
    """某个域的主体列表 + 健康度分布。

    分布在过滤前统计，否则筛「只看失败」时其它档位会全变 0，
    用户就没法从筛选态切回去了。
    """
    provider = _PROVIDERS.get(domain)
    if provider is None:
        return {"items": [], "total": 0, "health_counts": {}}
    rows = await provider(session)

    buckets = {h.key: 0 for h in PIPELINES[domain].health}
    for row in rows:
        buckets[row["health"]] = buckets.get(row["health"], 0) + 1

    keyword = q.strip().lower()
    if keyword:
        rows = [r for r in rows if keyword in r["title"].lower()]
    if health:
        rows = [r for r in rows if r["health"] == health]

    total = len(rows)
    return {
        "items": rows[offset : offset + limit],
        "total": total,
        "health_counts": buckets,
    }
