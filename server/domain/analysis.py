"""分析结果缓存服务：按内容指纹寻址，命中即免费（ADR-006）。"""

import hashlib
import re
import unicodedata

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from domain.models import AnalysisResult

_WS_RE = re.compile(r"\s+")


def content_key(text: str) -> str:
    """规范化文本指纹：NFC → strip → 连续空白折叠为单空格 → sha256 hex。"""
    normalized = _WS_RE.sub(" ", unicodedata.normalize("NFC", text).strip())
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


async def get_cached(
    session: AsyncSession,
    scope: str,
    content_hash: str,
    context_hash: str,
    kind: str,
    provider: str,
    lang_pair: str = "en->zh",
) -> AnalysisResult | None:
    stmt = (
        select(AnalysisResult)
        .where(
            AnalysisResult.scope == scope,
            AnalysisResult.content_hash == content_hash,
            AnalysisResult.context_hash == context_hash,
            AnalysisResult.kind == kind,
            AnalysisResult.provider == provider,
            AnalysisResult.lang_pair == lang_pair,
            AnalysisResult.is_active,
        )
        .limit(1)
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def save_result(
    session: AsyncSession,
    scope: str,
    content_hash: str,
    context_hash: str,
    kind: str,
    provider: str,
    result: dict,
    model: str | None = None,
    lang_pair: str = "en->zh",
    latency_ms: int | None = None,
) -> AnalysisResult:
    """落库新版本：同寻址键旧版本置 is_active=False，version 递增。"""
    addr = (
        (AnalysisResult.scope == scope)
        & (AnalysisResult.content_hash == content_hash)
        & (AnalysisResult.context_hash == context_hash)
        & (AnalysisResult.kind == kind)
        & (AnalysisResult.provider == provider)
        & (AnalysisResult.lang_pair == lang_pair)
    )
    max_version = (
        await session.execute(
            select(AnalysisResult.version)
            .where(addr)
            .order_by(AnalysisResult.version.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if max_version is not None:
        await session.execute(
            update(AnalysisResult).where(addr, AnalysisResult.is_active).values(is_active=False)
        )
    row = AnalysisResult(
        scope=scope,
        content_hash=content_hash,
        context_hash=context_hash,
        kind=kind,
        provider=provider,
        model=model,
        lang_pair=lang_pair,
        result=result,
        version=(max_version or 0) + 1,
        is_active=True,
        latency_ms=latency_ms,
    )
    session.add(row)
    try:
        await session.commit()
    except IntegrityError:
        # 同一地址并发落库（AI 补全任务与用户同时打开同一张词卡）：后到的复用先到的行，
        # 不能让用户那一侧的请求 500
        await session.rollback()
        existing = await get_cached(
            session, scope, content_hash, context_hash, kind, provider, lang_pair
        )
        if existing is None:
            raise
        return existing
    return row
