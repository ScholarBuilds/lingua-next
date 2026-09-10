"""分析类接口：翻译 / 词汇 / 语法 / 深读 / 短语 / 摘要，统一走 AnalysisResult 缓存（ADR-006）。

生成端点均支持 ?stream=1 走 SSE：`event: delta` 逐块吐文本，`event: done` 收尾带完整
结果（缓存命中直接一条 done，上游失败补一条 `event: error`）；非流式行为保持不变。
只读接口：/lookup 只查缓存不触发生成（BR-02），/versions + /activate 管理同寻址键多版本。
"""

import json
import time
from collections.abc import AsyncGenerator

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.routers.dict import SessionDep
from domain.analysis import content_key, get_cached, save_result
from domain.llm import (
    LLMUnavailable,
    complete_json,
    grammar_prompt,
    phrase_prompt,
    sentence_deep_prompt,
    stream_json,
    summary_prompt,
    word_breakdown_prompt,
    word_explain_prompt,
    word_nuance_prompt,
)
from domain.models import AnalysisResult, Article, DictEntry, DictHead, Paragraph
from domain.translate import EngineError, auto_chain, stream_llm_translate, translate

router = APIRouter(prefix="/analyze", tags=["analyze"])

# 机器翻译统一 provider 桶：实际引擎记录在 result.engine，降级链命中互通
MT_PROVIDER = "mt"
SUMMARY_MAX_CHARS = 12_000  # 摘要输入正文上限，超出截断并在 prompt 标注
SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


def _payload(row: AnalysisResult, cached: bool) -> dict:
    return {
        "result": row.result,
        "cached": cached,
        "provider": row.provider,
        "model": row.model,
        "version": row.version,
    }


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _sse_response(gen: AsyncGenerator[str, None]) -> StreamingResponse:
    return StreamingResponse(gen, media_type="text/event-stream", headers=SSE_HEADERS)


async def _generate_llm(
    session: AsyncSession,
    *,
    scope: str,
    chash: str,
    ctx_hash: str,
    kind: str,
    alias: str,
    system: str,
    user: str,
    refresh: bool,
    stream: bool,
    deployment_id: int | None = None,
    cached_only: bool = False,
) -> dict | StreamingResponse:
    """LLM 生成类端点公共路径：缓存寻址 → 流式/非流式生成 → 落库。

    `deployment_id` 是「这一次用哪个模型」的显式覆盖，只影响本次调用，不改任何绑定。
    它必须进缓存寻址：不进的话换了模型仍旧命中上一个模型的结果，接口 200、日志干净，
    用户看到的是「换了没反应」。跟随绑定时寻址键不变，历史缓存照旧有效。
    """
    provider = f"llm:{alias}" if deployment_id is None else f"llm:{alias}#d{deployment_id}"
    row = None
    if not refresh:
        row = await get_cached(session, scope, chash, ctx_hash, kind, provider)
    if cached_only:
        return _payload(row, cached=True) if row is not None else {"result": None, "cached": False}

    if not stream:
        if row is not None:
            return _payload(row, cached=True)
        try:
            result, model, latency_ms = await complete_json(
                alias, system, user, deployment_id=deployment_id
            )
        except LLMUnavailable as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        saved = await save_result(
            session,
            scope,
            chash,
            ctx_hash,
            kind,
            provider,
            result=result,
            model=model,
            latency_ms=latency_ms,
        )
        return _payload(saved, cached=False)

    async def gen() -> AsyncGenerator[str, None]:
        if row is not None:  # 缓存命中：直接一条 done
            yield _sse("done", _payload(row, cached=True))
            return
        try:
            async for ev in stream_json(
                alias, system, user, kind=kind, deployment_id=deployment_id
            ):
                if ev["type"] == "delta":
                    yield _sse("delta", {"text": ev["text"]})
                    continue
                if ev["schema_error"]:
                    # 校验失败的残次结果不落缓存，避免占据寻址键，但内容原样返回
                    yield _sse(
                        "done",
                        {
                            "result": ev["result"],
                            "cached": False,
                            "provider": provider,
                            "model": ev["model"],
                            "version": None,
                        },
                    )
                else:
                    saved = await save_result(
                        session,
                        scope,
                        chash,
                        ctx_hash,
                        kind,
                        provider,
                        result=ev["result"],
                        model=ev["model"],
                        latency_ms=ev["latency_ms"],
                    )
                    yield _sse("done", _payload(saved, cached=False))
        except LLMUnavailable as exc:
            yield _sse("error", {"message": str(exc)})

    return _sse_response(gen())


class TranslateBody(BaseModel):
    text: str
    context: str | None = None
    engine: str = "auto"
    refresh: bool = False
    # 这一次用哪个模型；不传就走能力绑定（绑定为空再走全局默认）。只影响本次调用，不改绑定
    deployment_id: int | None = None


@router.post("/translate", response_model=None)
async def analyze_translate(
    body: TranslateBody, session: SessionDep, stream: bool = False
) -> dict | StreamingResponse:
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="empty text")
    scope = "sentence"
    chash = content_key(text)
    # context 作素材背景喂给 LLM 消解领域词歧义，并进 context_hash 位分槽缓存
    ctx_text = (body.context or "").strip() or None
    ctx_hash = content_key(ctx_text) if ctx_text else ""
    # 钉了模型就换一个缓存槽：不换的话换了模型仍旧命中上一个模型的译文，看着像「换了没反应」。
    # 降级到 google / bing 时 deployment_id 不参与，但槽照旧分开——那一次本来就该重译一遍
    provider = MT_PROVIDER if body.deployment_id is None else f"{MT_PROVIDER}#d{body.deployment_id}"
    row = None
    if not body.refresh:
        row = await get_cached(session, scope, chash, ctx_hash, "translate", provider)

    if not stream:
        if row is not None:
            return _payload(row, cached=True)
        started = time.monotonic()
        try:
            outcome = await translate(
                text, engine=body.engine, context=ctx_text, deployment_id=body.deployment_id
            )
        except EngineError as exc:
            raise HTTPException(status_code=502, detail=f"翻译引擎全部失败：{exc}") from exc
        saved = await save_result(
            session,
            scope,
            chash,
            ctx_hash,
            "translate",
            provider,
            result=outcome,
            model=outcome["engine"],
            latency_ms=int((time.monotonic() - started) * 1000),
        )
        return _payload(saved, cached=False)

    async def gen() -> AsyncGenerator[str, None]:
        if row is not None:
            yield _sse("done", _payload(row, cached=True))
            return
        started = time.monotonic()
        outcome: dict | None = None
        chain = await auto_chain() if body.engine == "auto" else (body.engine,)
        if "llm" in chain:
            try:  # llm 纯文本逐 delta 下发；中途失败由 done 事件的兜底结果覆盖
                async for ev in stream_llm_translate(
                    text, context=ctx_text, deployment_id=body.deployment_id
                ):
                    if ev["type"] == "delta":
                        yield _sse("delta", {"text": ev["text"]})
                    else:
                        outcome = {"text": ev["text"], "engine": "llm"}
            except EngineError as exc:
                if body.engine == "llm":
                    yield _sse("error", {"message": f"翻译引擎全部失败：{exc}"})
                    return
        if outcome is None:  # 按链降级机翻；显式 mt 引擎无 token 流，一条 done 收尾
            mt_engines = [e for e in chain if e != "llm"]
            errors: list[str] = []
            for engine in mt_engines or (["google"] if body.engine == "auto" else []):
                try:
                    outcome = await translate(text, engine=engine, context=ctx_text)
                    break
                except EngineError as exc:
                    errors.append(str(exc))
            if outcome is None:
                message = "; ".join(errors) or "无可用引擎"
                yield _sse("error", {"message": f"翻译引擎全部失败：{message}"})
                return
        saved = await save_result(
            session,
            scope,
            chash,
            ctx_hash,
            "translate",
            provider,
            result=outcome,
            model=outcome["engine"],
            latency_ms=int((time.monotonic() - started) * 1000),
        )
        yield _sse("done", _payload(saved, cached=False))

    return _sse_response(gen())


class WordBody(BaseModel):
    word: str
    context: str
    refresh: bool = False
    # 这一次用哪个模型；不传就走能力绑定（绑定为空再走全局默认）。只影响本次调用，不改绑定
    deployment_id: int | None = None


@router.post("/word", response_model=None)
async def analyze_word(
    body: WordBody, session: SessionDep, stream: bool = False, cached_only: bool = False
) -> dict | StreamingResponse:
    word = body.word.strip().lower()
    if not word:
        raise HTTPException(status_code=400, detail="empty word")
    system, user = word_explain_prompt(word, body.context)
    return await _generate_llm(
        session,
        scope="word",
        chash=content_key(word),
        ctx_hash=content_key(body.context),
        kind="word_explain",
        alias="explain-standard",
        system=system,
        user=user,
        refresh=body.refresh,
        stream=stream,
        deployment_id=body.deployment_id,
        cached_only=cached_only,
    )


class BreakdownBody(BaseModel):
    """拆开记（FR-321~325）：不带语境，一个词一份缓存全站复用（BR-69）。"""

    word: str
    refresh: bool = False
    # 这一次用哪个模型；不传就走能力绑定（绑定为空再走全局默认）。只影响本次调用，不改绑定
    deployment_id: int | None = None


@router.post("/breakdown", response_model=None)
async def analyze_breakdown(
    body: BreakdownBody, session: SessionDep, cached_only: bool = False
) -> dict:
    word = body.word.strip().lower()
    if not word:
        raise HTTPException(status_code=400, detail="empty word")
    chash = content_key(word)
    provider = "llm:explain-standard"
    if cached_only:
        # 探缓存不产生调用：命中直出，没命中让前端给「AI 拆解」按钮（FR-327）
        row = await get_cached(session, "word", chash, "", "word_breakdown", provider)
        if row is None:
            return {"result": None, "cached": False}
        return _payload(row, cached=True)
    # 音标锚定切分：不给的话模型按拼写猜，重音会标错（实测 parameter）
    entry = await session.get(DictEntry, word)
    system, user = word_breakdown_prompt(word, entry.phonetic if entry else None)
    result = await _generate_llm(
        session,
        scope="word",
        chash=chash,
        ctx_hash="",
        kind="word_breakdown",
        alias="explain-standard",
        system=system,
        user=user,
        refresh=body.refresh,
        stream=False,
        deployment_id=body.deployment_id,
    )
    assert isinstance(result, dict)
    return result


class NuanceBody(BaseModel):
    """近义词辨析（FR-510）：同义词表来自 WordNet 侧表，列表变了缓存就换槽。"""

    word: str
    synonyms: list[str] = Field(min_length=1, max_length=12)
    refresh: bool = False
    # 这一次用哪个模型；不传就走能力绑定（绑定为空再走全局默认）。只影响本次调用，不改绑定
    deployment_id: int | None = None


NUANCE_KIND = "word_nuance"


@router.post("/nuance", response_model=None)
async def analyze_nuance(body: NuanceBody, session: SessionDep, cached_only: bool = False) -> dict:
    word = body.word.strip().lower()
    synonyms = sorted(
        {s.strip().lower() for s in body.synonyms if s.strip() and s.strip().lower() != word}
    )
    if not word or not synonyms:
        raise HTTPException(status_code=400, detail="empty word or synonyms")
    chash = content_key(word)
    ctx_hash = content_key(" ".join(synonyms))
    provider = "llm:explain-standard"
    if cached_only:
        row = await get_cached(session, "word", chash, ctx_hash, NUANCE_KIND, provider)
        if row is None:
            return {"result": None, "cached": False}
        return _payload(row, cached=True)
    # 简释从侧表取：前端不传中文，模型看到的是用户看到的那个义项
    heads = (
        await session.execute(select(DictHead).where(DictHead.lc.in_([word, *synonyms])))
    ).scalars()
    brief = {h.lc: h.brief for h in heads}
    payload = [{"word": s, "brief": brief.get(s)} for s in synonyms]
    system, user = word_nuance_prompt(word, payload)
    result = await _generate_llm(
        session,
        scope="word",
        chash=chash,
        ctx_hash=ctx_hash,
        kind=NUANCE_KIND,
        alias="explain-standard",
        system=system,
        user=user,
        refresh=body.refresh,
        stream=False,
        deployment_id=body.deployment_id,
    )
    assert isinstance(result, dict)
    return result


class GrammarBody(BaseModel):
    sentence: str
    refresh: bool = False
    # 这一次用哪个模型；不传就走能力绑定（绑定为空再走全局默认）。只影响本次调用，不改绑定
    deployment_id: int | None = None


@router.post("/grammar", response_model=None)
async def analyze_grammar(
    body: GrammarBody, session: SessionDep, stream: bool = False
) -> dict | StreamingResponse:
    sentence = body.sentence.strip()
    if not sentence:
        raise HTTPException(status_code=400, detail="empty sentence")
    system, user = grammar_prompt(sentence)
    return await _generate_llm(
        session,
        scope="sentence",
        chash=content_key(sentence),
        ctx_hash="",
        kind="grammar",
        alias="grammar-deep",
        system=system,
        user=user,
        refresh=body.refresh,
        stream=stream,
        deployment_id=body.deployment_id,
    )


class SentenceDeepBody(BaseModel):
    sentence: str
    refresh: bool = False
    # 这一次用哪个模型；不传就走能力绑定（绑定为空再走全局默认）。只影响本次调用，不改绑定
    deployment_id: int | None = None


@router.post("/sentence_deep", response_model=None)
async def analyze_sentence_deep(
    body: SentenceDeepBody, session: SessionDep, stream: bool = False
) -> dict | StreamingResponse:
    sentence = body.sentence.strip()
    if not sentence:
        raise HTTPException(status_code=400, detail="empty sentence")
    system, user = sentence_deep_prompt(sentence)
    return await _generate_llm(
        session,
        scope="sentence",
        chash=content_key(sentence),
        ctx_hash="",
        kind="sentence_deep",
        alias="grammar-deep",
        system=system,
        user=user,
        refresh=body.refresh,
        stream=stream,
        deployment_id=body.deployment_id,
    )


class PhraseBody(BaseModel):
    phrase: str
    context: str
    refresh: bool = False
    # 这一次用哪个模型；不传就走能力绑定（绑定为空再走全局默认）。只影响本次调用，不改绑定
    deployment_id: int | None = None


@router.post("/phrase", response_model=None)
async def analyze_phrase(
    body: PhraseBody, session: SessionDep, stream: bool = False
) -> dict | StreamingResponse:
    phrase = body.phrase.strip()
    if not phrase:
        raise HTTPException(status_code=400, detail="empty phrase")
    system, user = phrase_prompt(phrase, body.context)
    return await _generate_llm(
        session,
        scope="phrase",
        chash=content_key(phrase),
        ctx_hash=content_key(body.context),
        kind="phrase",
        alias="explain-standard",
        system=system,
        user=user,
        refresh=body.refresh,
        stream=stream,
        deployment_id=body.deployment_id,
    )


class SummaryBody(BaseModel):
    article_id: int
    refresh: bool = False
    # 这一次用哪个模型；不传就走能力绑定（绑定为空再走全局默认）。只影响本次调用，不改绑定
    deployment_id: int | None = None


@router.post("/summary", response_model=None)
async def analyze_summary(
    body: SummaryBody, session: SessionDep, stream: bool = False
) -> dict | StreamingResponse:
    article = await session.get(Article, body.article_id)
    if article is None:
        raise HTTPException(status_code=404, detail="article not found")
    texts = (
        await session.execute(
            select(Paragraph.text)
            .where(Paragraph.article_id == body.article_id)
            .order_by(Paragraph.ordinal)
        )
    ).scalars()
    full_text = "\n\n".join(t for t in texts if t and t.strip())
    if not full_text:
        raise HTTPException(status_code=400, detail="文章暂无正文，无法生成摘要")
    # 缓存按 article 全文指纹寻址（scope=document），截断只影响送入模型的正文
    chash = content_key(full_text)
    truncated = len(full_text) > SUMMARY_MAX_CHARS
    prompt_text = full_text[:SUMMARY_MAX_CHARS]
    if truncated:
        prompt_text += f"\n\n[正文过长已截断，以上为前 {SUMMARY_MAX_CHARS} 字符]"
    system, user = summary_prompt(article.title, prompt_text, truncated)
    return await _generate_llm(
        session,
        scope="document",
        chash=chash,
        ctx_hash="",
        kind="summary",
        alias="explain-standard",
        system=system,
        user=user,
        refresh=body.refresh,
        stream=stream,
        deployment_id=body.deployment_id,
    )


@router.get("/lookup")
async def analyze_lookup(
    scope: str, content_hash: str, kind: str, session: SessionDep, context_hash: str = ""
) -> dict:
    """只查缓存不触发生成（BR-02）：命中返回完整结果，未中 404。"""
    stmt = (
        select(AnalysisResult)
        .where(
            AnalysisResult.scope == scope,
            AnalysisResult.content_hash == content_hash,
            AnalysisResult.context_hash == context_hash,
            AnalysisResult.kind == kind,
            AnalysisResult.is_active,
        )
        .order_by(AnalysisResult.created_at.desc())
        .limit(1)
    )
    row = (await session.execute(stmt)).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="缓存未命中")
    return _payload(row, cached=True)


@router.get("/versions")
async def analyze_versions(
    scope: str, content_hash: str, kind: str, session: SessionDep, context_hash: str = ""
) -> list[dict]:
    """同寻址参数下的全部历史版本（含非 active），新版本在前。"""
    stmt = (
        select(AnalysisResult)
        .where(
            AnalysisResult.scope == scope,
            AnalysisResult.content_hash == content_hash,
            AnalysisResult.context_hash == context_hash,
            AnalysisResult.kind == kind,
        )
        .order_by(AnalysisResult.provider, AnalysisResult.version.desc())
    )
    return [
        {
            "id": r.id,
            "version": r.version,
            "provider": r.provider,
            "model": r.model,
            "is_active": r.is_active,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in (await session.execute(stmt)).scalars()
    ]


class ActivateBody(BaseModel):
    id: int


@router.post("/activate")
async def analyze_activate(body: ActivateBody, session: SessionDep) -> dict:
    """切换 active 版本：同寻址键（含 provider/lang_pair）内互斥。"""
    row = await session.get(AnalysisResult, body.id)
    if row is None:
        raise HTTPException(status_code=404, detail="result not found")
    await session.execute(
        update(AnalysisResult)
        .where(
            AnalysisResult.scope == row.scope,
            AnalysisResult.content_hash == row.content_hash,
            AnalysisResult.context_hash == row.context_hash,
            AnalysisResult.kind == row.kind,
            AnalysisResult.provider == row.provider,
            AnalysisResult.lang_pair == row.lang_pair,
            AnalysisResult.id != row.id,
        )
        .values(is_active=False)
    )
    row.is_active = True
    await session.commit()
    return {"activated": row.id, **_payload(row, cached=True)}
