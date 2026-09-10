"""节点产物层（需求 12 FR-195~198）：分步重跑与人工修正的事实源。

两个指纹各管一头：input_fingerprint 决定这个节点要不要跑（输入没变就跳过），
content_sha256 决定下游要不要陈旧（产物没变下游不用重跑）。
"""

import hashlib
import json
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from domain.models import StepArtifact
from domain.pipeline import StepSpec

# 超过此体积的产物落盘，库里只存 key + sha + size
BLOB_THRESHOLD = 256 * 1024


def _canonical(value: Any) -> str:
    """稳定序列化：键排序 + 无多余空白，保证同样内容指纹一致。"""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_of(value: Any) -> str:
    return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def input_fingerprint(
    spec: StepSpec,
    *,
    dep_shas: dict[str, str],
    config: dict | None = None,
    prompt_sha: str | None = None,
    model_id: str | None = None,
) -> str:
    """节点输入指纹（FR-196）。

    prompt 与解析后的模型 id 必须纳入：改 prompt 或换模型却复用旧产物，
    是这类缓存最容易踩的坑。
    """
    return sha256_of(
        {
            "step": spec.name,
            "deps": dict(sorted(dep_shas.items())),
            "config": config or {},
            "code": spec.code_version,
            "prompt": prompt_sha,
            "model": model_id,
        }
    )


async def current(
    session: AsyncSession, domain: str, subject_id: int, step: str
) -> StepArtifact | None:
    return (
        await session.execute(
            select(StepArtifact).where(
                StepArtifact.domain == domain,
                StepArtifact.subject_id == subject_id,
                StepArtifact.step == step,
                StepArtifact.is_current.is_(True),
            )
        )
    ).scalar_one_or_none()


async def dep_shas(
    session: AsyncSession, domain: str, subject_id: int, deps: tuple[str, ...]
) -> dict[str, str]:
    """依赖节点的当前内容指纹；缺失的记空串，让指纹自然不同于"依赖已产出"的情形。"""
    out: dict[str, str] = {}
    for name in deps:
        row = await current(session, domain, subject_id, name)
        out[name] = row.content_sha256 if row else ""
    return out


async def cache_hit(
    session: AsyncSession, domain: str, subject_id: int, step: str, fingerprint: str
) -> StepArtifact | None:
    """输入指纹命中且产物未被人工改过 → 可直接复用（FR-196）。

    人工改过的产物不参与缓存判定：它的内容已经与输入不对应，
    命中缓存反而会让人以为"重跑了"。
    """
    row = await current(session, domain, subject_id, step)
    if row is None or row.human_edited:
        return None
    return row if row.input_fingerprint == fingerprint else None


async def record(
    session: AsyncSession,
    *,
    domain: str,
    subject_id: int,
    step: str,
    payload: Any,
    input_fp: str,
    run_id: int | None = None,
    code_version: str = "1",
    summary: str | None = None,
    blob_key: str | None = None,
    content_key: str | None = None,
) -> StepArtifact:
    """写入节点产物。

    内容指纹相同则不建新版本，只更新指纹与归属 run（FR-197）——重跑三次得到
    同样结果不该在历史里堆三条。内容变了才把旧版本降级为历史版本。
    """
    # 内容指纹优先用调用方给的（如字幕文本序列的哈希）：metrics 相同不代表产物相同
    if content_key is not None:
        content_sha = sha256_of(content_key)
    else:
        content_sha = sha256_of(payload) if blob_key is None else blob_key
    body = _canonical(payload) if payload is not None else ""
    size = len(body.encode("utf-8"))
    existing = await current(session, domain, subject_id, step)

    if existing is not None and existing.content_sha256 == content_sha:
        existing.input_fingerprint = input_fp
        existing.produced_by_run_id = run_id
        existing.code_version = code_version
        if summary is not None:
            existing.summary = summary
        await session.flush()
        return existing

    if existing is not None:
        # 旧版本留着可 diff，只摘掉 current 标记（部分唯一索引要求同时只有一条 current）
        await session.execute(
            update(StepArtifact)
            .where(StepArtifact.id == existing.id)
            .values(is_current=False)
        )
        await session.flush()

    row = StepArtifact(
        domain=domain,
        subject_id=subject_id,
        step=step,
        input_fingerprint=input_fp,
        content_sha256=content_sha,
        payload=None if blob_key else payload,
        blob_key=blob_key,
        bytes=size,
        summary=summary,
        produced_by_run_id=run_id,
        code_version=code_version,
        is_current=True,
    )
    session.add(row)
    await session.flush()
    return row


async def mark_edited(
    session: AsyncSession,
    domain: str,
    subject_id: int,
    step: str,
    payload: Any,
    patch: dict | None = None,
) -> StepArtifact | None:
    """人工修正回写（FR-198）：重算内容指纹，下游随之陈旧。"""
    row = await current(session, domain, subject_id, step)
    if row is None:
        return None
    row.payload = payload
    row.content_sha256 = sha256_of(payload)
    row.human_edited = True
    row.edit_patch = patch
    await session.flush()
    return row


async def stale_steps(
    session: AsyncSession, domain: str, subject_id: int, steps: tuple[StepSpec, ...]
) -> set[str]:
    """产物已过时的节点集合，供 UI 标"陈旧"。

    判据取 Make/Bazel 的时间戳法：任一依赖的产物比本节点产物新，或本节点的
    code_version 已变，即判陈旧。比反推输入指纹简单且无歧义。

    只做提示不自动重跑——非确定性节点自动级联会把全库标脏（BR-41）。
    """
    rows = {
        r.step: r
        for r in (
            await session.execute(
                select(StepArtifact).where(
                    StepArtifact.domain == domain,
                    StepArtifact.subject_id == subject_id,
                    StepArtifact.is_current.is_(True),
                )
            )
        ).scalars()
    }
    out: set[str] = set()
    for spec in steps:
        row = rows.get(spec.name)
        if row is None:
            continue
        if row.code_version != spec.code_version:
            out.add(spec.name)
            continue
        for dep in spec.depends_on:
            upstream = rows.get(dep)
            if upstream is not None and upstream.created_at > row.created_at:
                out.add(spec.name)
                break
    return out
