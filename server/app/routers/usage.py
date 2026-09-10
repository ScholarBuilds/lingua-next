"""用量统计：本地台账是唯一口径（M5-B3）。

- `invocations`：model_invocation 台账按 capability × plugin_id × model 聚合，所有调用都在这里
- `analysis`：analysis_result 本地口径（只覆盖缓存型 AI 产物）

不再有任何外部网关的 spend / budget 段：费用口径只认本地台账。
"""

from datetime import UTC, datetime, timedelta
from math import ceil, floor

from fastapi import APIRouter, Query
from sqlalchemy import select

from app.routers.dict import SessionDep
from domain.models import AnalysisResult, ModelInvocation

router = APIRouter(prefix="/usage", tags=["usage"])

# 缓存命中不落新行，行数即真实生成次数；命中率无法由本表推算，接口不提供 cache_rate
ANALYSIS_NOTICE = (
    "count=真实生成次数（每行一次生成/重生成）；缓存命中不落新行，命中率无法由本表推算"
)

INVOCATIONS_NOTICE = (
    "model_invocation 本地台账：count 含进行中；failed 含 failed/cancelled/abandoned；"
    "延迟分位只统计成功行；tokens 同时认 prompt/completion 与 input/output 两种口径，"
    "没有 usage 的行计 0"
)

FAILED_STATUSES = frozenset({"failed", "cancelled", "abandoned"})


async def _analysis_by_kind(session, cutoff: datetime) -> list[dict]:
    stmt = select(
        AnalysisResult.kind,
        AnalysisResult.provider,
        AnalysisResult.latency_ms,
        AnalysisResult.cost_micros,
    ).where(AnalysisResult.created_at >= cutoff)
    rows = (await session.execute(stmt)).all()
    groups: dict[tuple[str, str], dict] = {}
    latencies: dict[tuple[str, str], list[int]] = {}
    for row in rows:
        key = (row.kind, row.provider)
        bucket = groups.setdefault(
            key,
            {
                "kind": row.kind,
                "provider": row.provider,
                "count": 0,
                "cost_micros": None,
            },
        )
        bucket["count"] += 1
        if row.cost_micros is not None:
            bucket["cost_micros"] = (bucket["cost_micros"] or 0) + row.cost_micros
        if row.latency_ms is not None:
            latencies.setdefault(key, []).append(row.latency_ms)
    for key, bucket in groups.items():
        ordered = sorted(latencies.get(key, []))
        bucket["latency_p50_ms"] = percentile(ordered, 0.5)
        bucket["latency_p95_ms"] = percentile(ordered, 0.95)
    return sorted(groups.values(), key=lambda b: (-b["count"], b["kind"], b["provider"]))


def percentile(values: list[int], q: float) -> int | None:
    """线性插值分位数，与 PostgreSQL percentile_cont 同口径；输入须已升序。"""
    if not values:
        return None
    if len(values) == 1:
        return values[0]
    pos = (len(values) - 1) * q
    lo, hi = floor(pos), ceil(pos)
    if lo == hi:
        return round(values[lo])
    return round(values[lo] + (values[hi] - values[lo]) * (pos - lo))


def usage_tokens(usage: object) -> tuple[int, int]:
    """从 usage JSON 取 (input, output)：OpenAI 的 prompt/completion 与 input/output 都认。"""
    if not isinstance(usage, dict):
        return 0, 0

    def pick(*keys: str) -> int:
        for key in keys:
            value = usage.get(key)
            if isinstance(value, int | float) and not isinstance(value, bool):
                return int(value)
        return 0

    return pick("prompt_tokens", "input_tokens"), pick("completion_tokens", "output_tokens")


async def _invocations_by_route(session, cutoff: datetime) -> list[dict]:
    """台账按 capability × plugin_id × model 聚合；分位数在 Python 端算，SQLite 也能跑。"""
    stmt = select(
        ModelInvocation.capability,
        ModelInvocation.plugin_id,
        ModelInvocation.model,
        ModelInvocation.status,
        ModelInvocation.latency_ms,
        ModelInvocation.usage,
    ).where(ModelInvocation.created_at >= cutoff)
    rows = (await session.execute(stmt)).all()
    groups: dict[tuple[str | None, str, str | None], dict] = {}
    latencies: dict[tuple[str | None, str, str | None], list[int]] = {}
    for row in rows:
        key = (row.capability, row.plugin_id, row.model)
        bucket = groups.setdefault(
            key,
            {
                "capability": row.capability,
                "plugin_id": row.plugin_id,
                "model": row.model,
                "count": 0,
                "succeeded": 0,
                "failed": 0,
                "input_tokens": 0,
                "output_tokens": 0,
            },
        )
        bucket["count"] += 1
        if row.status == "succeeded":
            bucket["succeeded"] += 1
            if row.latency_ms is not None:
                latencies.setdefault(key, []).append(int(row.latency_ms))
        elif row.status in FAILED_STATUSES:
            bucket["failed"] += 1
        prompt, completion = usage_tokens(row.usage)
        bucket["input_tokens"] += prompt
        bucket["output_tokens"] += completion
    out = []
    for key, bucket in groups.items():
        ordered = sorted(latencies.get(key, []))
        bucket["latency_p50_ms"] = percentile(ordered, 0.5)
        bucket["latency_p95_ms"] = percentile(ordered, 0.95)
        out.append(bucket)
    out.sort(key=lambda b: (-b["count"], b["capability"] or "", b["plugin_id"], b["model"] or ""))
    return out


def _invocations_total(by_route: list[dict]) -> dict:
    keys = ("count", "succeeded", "failed", "input_tokens", "output_tokens")
    return {key: sum(bucket[key] for bucket in by_route) for key in keys}


@router.get("/summary")
async def usage_summary(session: SessionDep, days: int = Query(default=30, ge=1, le=365)) -> dict:
    cutoff = datetime.now(UTC) - timedelta(days=days)
    by_route = await _invocations_by_route(session, cutoff)
    invocations = {
        "by_route": by_route,
        "total": _invocations_total(by_route),
        "notice": INVOCATIONS_NOTICE,
    }
    analysis = {"by_kind": await _analysis_by_kind(session, cutoff), "notice": ANALYSIS_NOTICE}
    return {"days": days, "invocations": invocations, "analysis": analysis}
