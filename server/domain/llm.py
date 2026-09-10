"""LLM 结构化调用：按能力名解析到绑定部署直连上游，JSON mode 输出（ADR-004）。

四个入口都经 ``PreparedChatCall.stream_chunks`` / ``complete_chunks`` 拿到内核 StreamChunk，
再由 :class:`BlockAssembler` 装配：推理块与正文块分开，``delta`` 事件与返回文本只含正文。

路由编排（:class:`_RouteRun`）：主路由按部署的 ``ResolvedRetryPolicy`` 有界重试，预算用尽
或失败码不可重试时切到 ``snapshot.fallbacks`` 的下一条重新 prepare；每次尝试各记一行
``ModelInvocation``，后续尝试带 ``parent_invocation_id`` / ``attempt``。流式只在首个事件
吐出之前失败才会重试或切换，字已经到了前端就不能再换一份。

流式路径（stream_json）完成后做整体 JSON 解析 + 按 kind 的必填键校验，
失败自动非流式重试一次；仍失败返回 {raw_text, schema_error: true} 保留内容。
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import AsyncGenerator, AsyncIterator, Awaitable, Callable, Iterable, Mapping
from typing import Any

from domain.kernel.llm_assembler import BlockAssembler
from domain.kernel.llm_retry import decide_retry
from domain.kernel.llm_types import (
    AbortedFinish,
    ErrorFinish,
    LlmFailure,
    LlmFailureCode,
    StreamChunk,
    TextBlock,
    TextDeltaChunk,
)
from domain.model_invocations import ModelInvocationSpan
from domain.model_runtime import (
    ModelCallFailure,
    ModelRuntimeError,
    PreparedChatCall,
    PreparedChatRoute,
    chat_failure,
    prepare_chat_route,
)

logger = logging.getLogger(__name__)

# 各分析 kind 的 JSON 必填键，流式生成完成后按此做轻量 schema 校验
REQUIRED_KEYS: dict[str, frozenset[str]] = {
    "word_explain": frozenset({"context_meaning", "pos_in_context", "explanation", "memory_hint"}),
    "grammar": frozenset(
        {"translation", "backbone", "quick", "components", "tenses", "difficulty_note"}
    ),
    "sentence_deep": frozenset({"translation", "chunks", "collocations", "structure_note"}),
    "phrase": frozenset({"meaning", "literal_vs_idiomatic", "usage_scenes", "example"}),
    "summary": frozenset({"summary_zh", "difficulty", "key_vocab", "themes"}),
    "word_breakdown": frozenset(
        {"syllables", "stress", "morphemes", "formation", "mnemonic", "family"}
    ),
    "word_nuance": frozenset({"summary", "items"}),
}

STRICT_JSON_HINT = "严格输出 JSON 对象：不要输出 JSON 以外的任何字符，所有必填字段都必须给出。"

# 路由解析不到（能力没绑、插件没 Provider）归入请求类失败，与内核 NO_ADAPTER 的折算一致
UNRESOLVED_ROUTE_CODE: LlmFailureCode = "INVALID_REQUEST"

CHAT_TIMEOUT_S = 60.0

# 主路由重试预算用尽后值得换一条候选再试的失败码。ABORTED 是调用方取消，UNKNOWN 多半是
# 模型内容问题（非 JSON、content_filter），换供应商也救不回来
FALLBACK_CODES: frozenset[str] = frozenset(
    {
        "AUTH",
        "RATE_LIMIT",
        "SERVER",
        "TIMEOUT",
        "TRANSPORT",
        "EMPTY_RESPONSE",
        "INVALID_REQUEST",
        "CONTEXT_WINDOW_EXCEEDED",
    }
)


class LLMUnavailable(Exception):
    """网关不可达 / 未配置真实供应商 / 超时 / 模型没给出可用内容。

    ``failure`` 是中立的失败事实（码 + 状态 + Retry-After），``str()`` 仍是人读的原因。
    """

    def __init__(self, message: str, *, failure: LlmFailure | None = None) -> None:
        super().__init__(message)
        self.failure = failure or LlmFailure(message=message, code="UNKNOWN")


def missing_keys(kind: str | None, parsed: object) -> set[str]:
    """按 kind 检查必填键；未登记的 kind 只要求是 JSON 对象。"""
    if not isinstance(parsed, dict):
        return {"<object>"}
    required = REQUIRED_KEYS.get(kind or "")
    if not required:
        return set()
    return {k for k in required if k not in parsed}


def _failed(failure: LlmFailure) -> LLMUnavailable:
    return LLMUnavailable(failure.message, failure=failure)


def _assemble(chunks: Iterable[StreamChunk]) -> BlockAssembler:
    assembler = BlockAssembler()
    for chunk in chunks:
        assembler.push(chunk)
    return assembler


def _visible_text(assembler: BlockAssembler) -> str:
    """只取正文块：推理块不混进对外文本。"""
    return "".join(block.text for block in assembler.blocks() if isinstance(block, TextBlock))


def _finish_failure(assembler: BlockAssembler) -> LlmFailure | None:
    """流以 error / aborted 收尾时的失败事实；正常结束为 None。"""
    finish = assembler.finish
    if isinstance(finish, ErrorFinish | AbortedFinish):
        return finish.failure
    return None


async def _prepare_route(
    capability: str,
    operation: str,
    request: dict,
    *,
    deployment_id: int | None = None,
) -> PreparedChatRoute:
    try:
        route = await prepare_chat_route(
            capability,
            operation,
            deployment_id=deployment_id,
        )
    except ModelRuntimeError as exc:
        # 路由没解析出来，这条台账上根本不存在「真实模型」——model 位只好落能力名，
        # 靠 plugin_id=unresolved 标明它不是上游真名。这是唯一允许的例外
        span = await ModelInvocationSpan(
            plugin_id="unresolved",
            operation=operation,
            model=capability,
            capability=capability,
            request=request,
        ).start()
        failure = LLMUnavailable(
            str(exc), failure=LlmFailure(message=str(exc), code=UNRESOLVED_ROUTE_CODE)
        )
        await span.fail(failure)
        raise failure from exc
    return route


# 退避等待；测试替换成不睡
_sleep = asyncio.sleep


def _attempt_failure(call: PreparedChatCall, exc: BaseException) -> LlmFailure:
    """一次尝试抛出的异常 → 失败事实：coded 调用自带，其余从台账终态或异常本身归一。"""
    if isinstance(exc, ModelCallFailure | LLMUnavailable):
        return exc.failure
    return call.failure or chat_failure(exc)


def _origin(exc: BaseException) -> BaseException:
    """LLMUnavailable 的 cause 指向上游原始异常，日志和旧分支照旧能看到 SDK 类型。"""
    if isinstance(exc, ModelCallFailure) and exc.__cause__ is not None:
        return exc.__cause__
    return exc


class _RouteRun:
    """一次业务调用的路由编排：主路由有界重试 → 按 fallbacks 换路由；每次尝试独立台账。"""

    def __init__(
        self,
        capability: str,
        operation: str,
        request: dict[str, Any],
        *,
        deployment_id: int | None,
        timeout: float = CHAT_TIMEOUT_S,
    ) -> None:
        self.capability = capability
        self.operation = operation
        self.request = request
        self.deployment_id = deployment_id
        self.timeout = timeout
        self._route: PreparedChatRoute | None = None
        self._pending: list[Mapping[str, Any]] = []
        self._tried: set[int | None] = set()
        self._parent_id: str | None = None
        self._attempt = 0
        self._retries = 0

    @property
    def route(self) -> PreparedChatRoute:
        if self._route is None:
            raise ModelRuntimeError("路由尚未解析")
        return self._route

    async def start(self) -> PreparedChatRoute:
        self._route = await _prepare_route(
            self.capability,
            self.operation,
            self.request,
            deployment_id=self.deployment_id,
        )
        self._pending = list(self._route.snapshot.fallbacks)
        self._tried = {self._route.snapshot.deployment_id}
        return self._route

    def call(self) -> PreparedChatCall:
        self._attempt += 1
        return self.route.prepare_call(
            self.request,
            timeout=self.timeout,
            coded_failures=True,
            parent_invocation_id=self._parent_id,
            attempt=self._attempt,
        )

    async def recover(self, call: PreparedChatCall, failure: LlmFailure) -> bool:
        """这次失败之后还能不能再试：同路由退避重试，或切到下一条候选。False 即放弃。"""
        if self._parent_id is None:
            self._parent_id = call.invocation_id
        snapshot = self.route.snapshot
        decision = decide_retry(snapshot.retry_policy, failure, self._retries)
        if decision is not None:
            self._retries = decision.retry
            logger.info(
                "llm.retry capability=%s deployment=%s code=%s retry=%d delay_ms=%.0f",
                self.capability,
                snapshot.deployment_id,
                failure.code,
                decision.retry,
                decision.delay_ms,
            )
            await _sleep(decision.delay_ms / 1000)
            return True
        if failure.code not in FALLBACK_CODES:
            return False
        while self._pending:
            candidate = self._pending.pop(0)
            deployment_id = candidate.get("deployment_id")
            if deployment_id in self._tried:
                continue
            self._tried.add(deployment_id)
            try:
                self._route = await prepare_chat_route(
                    self.capability,
                    self.operation,
                    deployment_id=deployment_id,
                    selection_source="fallback",
                )
            except ModelRuntimeError as exc:
                logger.warning(
                    "llm.fallback.skip capability=%s deployment=%s: %s",
                    self.capability,
                    deployment_id,
                    exc,
                )
                continue
            self._retries = 0
            logger.info(
                "llm.fallback capability=%s from=%s to=%s code=%s",
                self.capability,
                snapshot.deployment_id,
                deployment_id,
                failure.code,
            )
            return True
        return False

    @staticmethod
    def give_up(exc: BaseException, failure: LlmFailure) -> LLMUnavailable:
        """放弃时对外抛的异常；消费者自己抛的 LLMUnavailable 原样放行。"""
        if isinstance(exc, LLMUnavailable):
            return exc
        return LLMUnavailable(str(_origin(exc)) or failure.message, failure=failure)


async def _run_complete[T](run: _RouteRun, body: Callable[[PreparedChatCall], Awaitable[T]]) -> T:
    """非流式：``body`` 负责消费 call 并写终态；抛出的失败由编排决定重试 / 切路由 / 放弃。"""
    await run.start()
    while True:
        call = run.call()
        try:
            async with call:
                return await body(call)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            failure = _attempt_failure(call, exc)
            if await run.recover(call, failure):
                continue
            error = run.give_up(exc, failure)
            if error is exc:
                raise
            raise error from _origin(exc)


async def _run_stream(
    run: _RouteRun, body: Callable[[PreparedChatCall], AsyncIterator[dict]]
) -> AsyncGenerator[dict, None]:
    """流式：``body`` 是产出事件的异步生成器；只有一个事件都没吐出时的失败才会重试 / 切路由。"""
    await run.start()
    while True:
        call = run.call()
        yielded = False
        try:
            async with call:
                async for event in body(call):
                    yielded = True
                    yield event
            return
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            failure = _attempt_failure(call, exc)
            if not yielded and await run.recover(call, failure):
                continue
            error = run.give_up(exc, failure)
            if error is exc:
                raise
            raise error from _origin(exc)


async def run_with_route_retry[T](
    capability: str,
    operation: str,
    request: dict[str, Any],
    body: Callable[[PreparedChatCall], Awaitable[T]],
    *,
    deployment_id: int | None = None,
    timeout: float = CHAT_TIMEOUT_S,
) -> T:
    """给其它消费者用的非流式编排入口：主路由重试 + fallback，失败抛 LLMUnavailable。"""
    run = _RouteRun(capability, operation, request, deployment_id=deployment_id, timeout=timeout)
    return await _run_complete(run, body)


def _parse_object(raw: str) -> object | None:
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


async def complete_json(
    capability: str,
    system: str,
    user: str,
    *,
    deployment_id: int | None = None,
) -> tuple[dict, str, int]:
    """按能力名解析到绑定部署直连调用，返回 (解析后 dict, 上游真实模型名, latency_ms)。"""
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]
    request = {"messages": messages, "response_format": {"type": "json_object"}}
    started = time.monotonic()

    async def body(call: PreparedChatCall) -> tuple[dict, str]:
        model = call.route.snapshot.model
        assembler = _assemble(await call.complete_chunks(model=model, **request))
        failure = _finish_failure(assembler)
        if failure is not None:
            error = _failed(failure)
            await call.fail(error)
            raise error
        content = _visible_text(assembler)
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError as exc:
            raise LLMUnavailable(f"模型返回非 JSON：{content[:200]}") from exc
        model = call.reported_model or model
        await call.succeed(model=model, response={"result": parsed})
        return parsed, model

    run = _RouteRun(capability, "chat.complete", request, deployment_id=deployment_id)
    parsed, model = await _run_complete(run, body)
    latency_ms = int((time.monotonic() - started) * 1000)
    return parsed, model, latency_ms


async def complete_text(
    capability: str,
    messages: list[dict],
    temperature: float | None = None,
    *,
    deployment_id: int | None = None,
) -> str:
    """纯文本补全（非 JSON mode）：标点恢复等"输入输出都是自然文本"的场景。"""
    request: dict = {"messages": messages}
    if temperature is not None:
        request["temperature"] = temperature

    async def body(call: PreparedChatCall) -> str:
        model = call.route.snapshot.model
        assembler = _assemble(await call.complete_chunks(model=model, **request))
        failure = _finish_failure(assembler)
        if failure is not None:
            error = _failed(failure)
            await call.fail(error)
            raise error
        content = _visible_text(assembler)
        await call.succeed(model=call.reported_model or model, response={"text": content})
        return content

    run = _RouteRun(capability, "chat.complete", request, deployment_id=deployment_id)
    return await _run_complete(run, body)


async def stream_json(
    capability: str,
    system: str,
    user: str,
    kind: str | None = None,
    *,
    deployment_id: int | None = None,
) -> AsyncGenerator[dict, None]:
    """流式 JSON 生成：逐 delta 产出 {"type": "delta", "text"}，收尾一条 done 事件。

    done 事件：{"type": "done", "result", "model", "latency_ms", "schema_error"}。
    整体 json.loads + missing_keys 校验失败时，自动非流式重试一次（提示词追加
    严格 JSON 要求）；仍失败 result 为 {"raw_text", "schema_error": true}，内容不丢。
    流以 error / aborted 收尾（空响应、截断等）：还没吐字的先走路由重试 / fallback，
    都不行再与校验失败同路走非流式重试。
    """
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]
    request = {
        "messages": messages,
        "response_format": {"type": "json_object"},
        "stream": True,
    }
    started = time.monotonic()
    # 每次尝试重置：ok / result / model / raw / finish_failure
    outcome: dict[str, Any] = {}
    run = _RouteRun(capability, "chat.stream", request, deployment_id=deployment_id)

    async def body(call: PreparedChatCall) -> AsyncIterator[dict]:
        outcome.clear()
        outcome["model"] = call.route.snapshot.model
        assembler = BlockAssembler()
        emitted = False
        async for chunk in call.stream_chunks(model=call.route.snapshot.model, **request):
            assembler.push(chunk)
            if isinstance(chunk, TextDeltaChunk) and chunk.text:
                emitted = True
                yield {"type": "delta", "text": chunk.text}
        outcome["model"] = call.reported_model or outcome["model"]
        outcome["raw"] = _visible_text(assembler)
        failure = _finish_failure(assembler)
        if failure is not None:
            error = _failed(failure)
            await call.fail(error)
            outcome["finish_failure"] = failure
            if not emitted:
                raise error
            return
        parsed = _parse_object(outcome["raw"])
        if parsed is not None and not missing_keys(kind, parsed):
            await call.succeed(model=outcome["model"], response={"result": parsed})
            outcome["ok"] = True
            outcome["result"] = parsed
            return
        await call.fail(LLMUnavailable("流式模型返回未通过 JSON schema 校验"))

    try:
        async for event in _run_stream(run, body):
            yield event
    except LLMUnavailable:
        # 吐字前就以 error / aborted 收尾且重试 / fallback 都没救回来：退到非流式再试一次
        if "finish_failure" not in outcome:
            raise
    # done 事件的 model 位只放上游真名（reported_model 优先，退到路由快照的模型）。
    # 一次调用都没发生过时宁可留空也不填能力名——那会把能力名伪造成模型写进 analysis_result
    model = outcome.get("model") or ""
    raw = outcome.get("raw") or ""
    latency_ms = int((time.monotonic() - started) * 1000)
    if outcome.get("ok"):
        yield {
            "type": "done",
            "result": outcome["result"],
            "model": model,
            "latency_ms": latency_ms,
            "schema_error": False,
        }
        return

    # 非流式重试一次：提示词追加严格 JSON 要求
    retry_result: dict | None = None
    retry_model = model
    try:
        retry_result, retry_model, retry_latency = await complete_json(
            capability,
            f"{system}\n{STRICT_JSON_HINT}",
            user,
            deployment_id=deployment_id,
        )
        latency_ms += retry_latency
    except LLMUnavailable:
        retry_result = None
    if retry_result is not None and not missing_keys(kind, retry_result):
        yield {
            "type": "done",
            "result": retry_result,
            "model": retry_model,
            "latency_ms": latency_ms,
            "schema_error": False,
        }
        return
    yield {
        "type": "done",
        "result": {"raw_text": raw, "schema_error": True},
        "model": model,
        "latency_ms": int((time.monotonic() - started) * 1000),
        "schema_error": True,
    }


async def stream_text(
    capability: str,
    messages: list[dict],
    *,
    deployment_id: int | None = None,
) -> AsyncGenerator[dict, None]:
    """自由文本流式生成（陪读问答）：逐 delta 产出文本，收尾 done 事件带全文。

    推理模型的思考内容走独立的 reasoning 块，不会出现在 delta 与 done 的正文里。
    """
    request = {"messages": messages, "stream": True}
    started = time.monotonic()
    outcome: dict[str, Any] = {}
    run = _RouteRun(capability, "chat.stream", request, deployment_id=deployment_id)

    async def body(call: PreparedChatCall) -> AsyncIterator[dict]:
        outcome.clear()
        assembler = BlockAssembler()
        async for chunk in call.stream_chunks(model=call.route.snapshot.model, **request):
            assembler.push(chunk)
            if isinstance(chunk, TextDeltaChunk) and chunk.text:
                yield {"type": "delta", "text": chunk.text}
        model = call.reported_model or call.route.snapshot.model
        failure = _finish_failure(assembler)
        if failure is not None:
            error = _failed(failure)
            await call.fail(error)
            raise error
        text = _visible_text(assembler).strip()
        if not text:
            empty = LLMUnavailable("模型未返回内容")
            await call.fail(empty)
            raise empty
        await call.succeed(model=model, response={"text": text})
        outcome["text"] = text
        outcome["model"] = model

    async for event in _run_stream(run, body):
        yield event
    yield {
        "type": "done",
        "text": outcome["text"],
        "model": outcome["model"],
        "latency_ms": int((time.monotonic() - started) * 1000),
    }


def word_explain_prompt(word: str, context: str) -> tuple[str, str]:
    """词汇讲解 prompt：返回 (system, user)。"""
    system = (
        "你是面向中国英语学习者的词汇讲解助手，用中文解释英文单词在具体语境中的含义。"
        "只输出 JSON 对象，字段：context_meaning（该词在句中的准确中文释义）、"
        "pos_in_context（在句中的词性，如 n./v./adj.）、"
        "phonetic_in_context（该词在本句读法的标准 IPA，不带斜杠；"
        "多音词必须给语境下正确的那个读音，如名词 record 给 ˈrekɔːrd、动词给 rɪˈkɔːrd）、"
        "explanation（中文讲解 2-3 句：为什么是这个意思、与常见义的区别）、"
        "memory_hint（一句话记忆提示，如词根词缀或联想）。"
    )
    user = json.dumps({"word": word, "context": context}, ensure_ascii=False)
    return system, user


def word_breakdown_prompt(word: str, phonetic: str | None = None) -> tuple[str, str]:
    """拆开记 prompt（FR-321~325）：不带语境，一个词一份，全站复用缓存。

    必须把 ECDICT 的已知音标喂进去：不给的话模型会按拼写猜发音——
    实测 parameter 被切成 pa-ra-me-ter 且重音标在 me（正确是 pa-ram-e-ter，重音在 ram）。
    """
    system = (
        "你是面向中国英语学习者的构词讲解助手，把一个英文单词拆开帮助记忆。"
        "只输出 JSON 对象，字段："
        "syllables（数组，按发音切分的音节，拼写原样切开，拼起来必须等于原词；"
        "**以给定的 phonetic 为准切分，不要按拼写想当然**）、"
        "stress（重读音节在 syllables 中的下标，0 起；单音节给 0）、"
        "ipa_syllables（数组，与 syllables 一一对应的 IPA 分段，不带斜杠，"
        "重读音节前加 ˈ；长度必须与 syllables 相同）、"
        "morphemes（数组，词素拆分，每项 {text: 词素原文, type: prefix|root|suffix|linking, "
        "gloss: 该词素的中文含义}；按在词中的先后顺序，拼起来应能还原该词；"
        "无法进一步拆分的单纯词只给一个 type 为 root 的项）、"
        "formation（构词说明，一句中文，形如 "
        "'para-(旁边) + meter(测量) → 在旁边量度的东西 → 参数'；单纯词说明它的来源或本义）、"
        "mnemonic（助记，一句中文，把词素义串成一个能记住的画面，别复述释义）、"
        "family（数组，3-5 个同词根的常见词，每项 {word: 英文, zh: 中文释义}；"
        "单纯词给同族派生词；实在没有给空数组）。"
        "不确定的词源不要编造，宁可把 morphemes 只给一个 root。"
    )
    payload: dict[str, str] = {"word": word}
    if phonetic:
        payload["phonetic"] = phonetic
    user = json.dumps(payload, ensure_ascii=False)
    return system, user


def word_nuance_prompt(word: str, synonyms: list[dict]) -> tuple[str, str]:
    """近义词辨析 prompt（FR-510）：同义词表来自 WordNet，模型只负责说差别，不负责添词。

    每个近义词的中文简释一并喂进去：让模型知道用户看到的是哪个义项，不然「desert」会被讲成沙漠。
    """
    system = (
        "你是面向中国英语学习者的近义词辨析助手。给定一个目标词和它的几个近义词（附中文简释），"
        "用中文说清它们之间的差别。只输出 JSON 对象，字段："
        "summary（一句话：这组词的共同含义，以及日常最常用的是哪一个）、"
        "items（数组，顺序与给定的近义词列表完全一致、一个不多一个不少，每项 "
        "{word: 近义词原文, difference: 与目标词的差别一句中文——说语域（口语 / 书面 / 正式）、"
        "程度强弱、常见搭配或感情色彩, example_en: 一句最能体现这个差别的英文例句, "
        "example_zh: 该例句的中文}）。"
        "不要添加列表之外的词，不确定的搭配不要编造，宁可只写语域差别。"
    )
    user = json.dumps({"word": word, "synonyms": synonyms}, ensure_ascii=False)
    return system, user


# 成分角色的封闭枚举。前端按它上色，必须与
# web/src/features/reader/grammarRole.ts 的 GRAM_ROLES 保持一致。
GRAMMAR_ROLES = ("主语", "谓语", "宾语", "表语", "定语", "状语", "连接词", "分句")


def grammar_prompt(sentence: str) -> tuple[str, str]:
    """句子语法分析 prompt：返回 (system, user)。

    > [!danger] role 必须是封闭枚举
    >
    > 早先只写「中文成分名，如 定语从句/状语」，模型就放飞了：实测 108 个成分
    > 吐出 70 种 role 串（「后置定语（过去分词短语，修饰 a truth）」「help 的宾语」）。
    > 前端只能硬映射十几个词，其余按下标轮换颜色——同一句重新分析一次颜色就变，
    > 「靠颜色记结构」这个学习方式直接失效。
    > 解释性内容不是不要，是挪进 note 字段，别塞进 role 把它污染成自由文本。

    components 允许嵌套（分句 + 分句内部的成分同时列出），前端按在原句中的
    字符区间还原成树；但每一项的 text 必须是原句里的**原样片段**，不要改写。
    """
    roles = " / ".join(GRAMMAR_ROLES)
    system = (
        "你是面向中国英语学习者的语法分析助手，用中文拆解英文句子。"
        "只输出 JSON 对象，字段：translation（整句中文翻译）、"
        "backbone（主干结构，如 '主语 + 谓语 + 宾语' 并标出对应原文片段）、"
        "quick（一句话点出本句最大难点）、"
        "components（数组，每项 {text, role, note}）、"
        "tenses（时态与语态说明）、"
        "difficulty_note（难点补充讲解，中文 1-2 句）。\n"
        "components 的三个字段各司其职：\n"
        f"- role：**只能**取这八个之一，不要自造、不要加括号后缀：{roles}。"
        "从句按它在句中充当的成分归类——定语从句填『定语』、宾语从句填『宾语』、"
        "状语从句填『状语』；并列分句与主句填『分句』。\n"
        "- text：原句里的原样片段，一个字都不要改写，标点按原样。\n"
        "- note：这一项的补充说明，中文短语，没有可省略。"
        "「修饰 a truth」「固定搭配，表示来自」「what 引导的名词性从句」这类写这里。\n"
        "分句及其内部成分可以同时列出（先写分句，紧接着写它内部的成分），"
        "不必也不要把整句拆成互不重叠的一层。"
    )
    user = json.dumps({"sentence": sentence}, ensure_ascii=False)
    return system, user


def shadow_review_prompt(
    reference: str, transcript: str, items: list[dict], accuracy: int
) -> tuple[str, str]:
    """跟读点评 prompt：返回 (system, user)。

    输出是**流式文本**而不是 JSON——点评要一边生成一边出现在弹窗里（FR-342）。
    评分放在首行的 [[SCORE:n]] 标记里，前端剥掉标记显示，服务端顺手解析入库。
    """
    system = (
        "你是面向中国英语学习者的发音跟读教练。学习者朗读了一句英文，"
        "系统已用语音识别转写并与原句逐词比对，你要据此点评。\n"
        "输出格式：第一行只写 [[SCORE:整数]]，0-100 的综合评分（准确率只是其中一项，"
        "还要考虑漏读多少、错读的是不是关键词）。之后用中文写点评，简洁分段，不用标题层级。\n"
        "点评必须落到可执行的改法：指名道姓说哪个词读错了、错在哪个音、"
        "该怎么发（可用汉字近似音或音标提示）、句子里哪里该连读或弱读、重音落在哪。\n"
        "禁止空泛夸奖和车轱辘话；没问题的地方一句带过，把篇幅留给要改的地方。"
        "识别结果可能有误差，若某处像是识别问题而非读错，直接说明，不要当成错误批评。"
    )
    misread = [
        {"原句词": it.get("word"), "听成": it.get("got"), "情况": it.get("status")}
        for it in items
        if it.get("status") != "ok"
    ]
    user = json.dumps(
        {
            "原句": reference,
            "识别到": transcript,
            "逐词比对准确率": accuracy,
            "有问题的词": misread[:40],
        },
        ensure_ascii=False,
    )
    return system, user


def pronunciation_narrate_prompt(
    reference: str, assessment: dict, phoneme_cards: list[dict]
) -> tuple[str, str]:
    """发音诊断的中文叙述（FR-398j/k）。

    **分数由前三层的确定性算法给，LLM 一个数都不许改**——它只负责把
    `/ɪ/ vs /iː/` 翻译成「你把 ship 读成了 sheep，舌位放松、别拖长」，
    并关联到对应音位卡片。评分与叙述分离，评分才可回归测试（FR-398k）。
    """
    system = (
        "你是面向中国英语学习者的发音教练。系统已用声学模型给出确定性的诊断数据，"
        "你的任务只有一个：把这些数据翻译成学习者能照着改的中文说明。\n"
        "**禁止给分、禁止改分、禁止说某处「错了」**——音素级判断的准确率只有两成，"
        "一律用「听起来更接近」「这里可以再注意」这类推测语气。\n"
        "逐条讲：哪个词的哪个音、听起来更接近什么、舌位或唇形该怎么调、"
        "对应哪张音位卡片。每条不超过两句。没有问题的维度一句带过。\n"
        "完整度与流利度是可靠信号，可以直接说；音素级只做提示。"
    )
    user = json.dumps(
        {
            "原句": reference,
            "完整度": assessment.get("completeness"),
            "流利度": assessment.get("fluency"),
            "词级置信度均值": assessment.get("accuracy"),
            "停顿事件": assessment.get("breaks", [])[:10],
            "词级明细": [
                {"词": w.get("word"), "置信度": w.get("confidence"), "状态": w.get("status")}
                for w in assessment.get("words", [])
                if w.get("status") != "ok" or (w.get("confidence") or 100) < 55
            ][:20],
            "音素级提示": assessment.get("phonemes", [])[:15],
            "相关音位卡片": phoneme_cards[:8],
        },
        ensure_ascii=False,
    )
    return system, user


def sentence_deep_prompt(sentence: str) -> tuple[str, str]:
    """句子深读 prompt：意群逐块对照 + 搭配 + 结构与文化注解。"""
    system = (
        "你是面向中国英语学习者的精读讲解助手，对英文句子做深度拆解。"
        "只输出 JSON 对象，字段：translation（整句中文翻译）、"
        "chunks（数组，按意群把句子切块并逐块对照，每项 {en: 原文片段, zh: 对应中文}，"
        "按原文顺序覆盖整句）、"
        "collocations（数组，句中值得积累的搭配，每项 {phrase: 英文搭配, meaning: 中文含义}，"
        "没有则给空数组）、"
        "structure_note（句子结构讲解，中文 1-3 句）、"
        "culture_note（文化或背景补充，中文 1-2 句，没有可给空字符串）。"
    )
    user = json.dumps({"sentence": sentence}, ensure_ascii=False)
    return system, user


def phrase_prompt(phrase: str, context: str) -> tuple[str, str]:
    """短语讲解 prompt：结合语境的含义、字面义对比、使用场景与例句。"""
    system = (
        "你是面向中国英语学习者的短语讲解助手，结合语境解释英文短语或搭配。"
        "只输出 JSON 对象，字段：meaning（该短语在语境中的中文含义）、"
        "literal_vs_idiomatic（字面义与习语义的对比说明，中文 1-2 句）、"
        "usage_scenes（数组，2-4 个常见使用场景，中文短句）、"
        "example（{en: 一个新的英文例句, zh: 例句的中文翻译}）。"
    )
    user = json.dumps({"phrase": phrase, "context": context}, ensure_ascii=False)
    return system, user


def summary_prompt(title: str, text: str, truncated: bool) -> tuple[str, str]:
    """全文摘要 prompt：中文摘要 + 难度定级 + 核心词汇 + 主题标签。"""
    system = (
        "你是面向中国英语学习者的阅读导读助手，为整篇英文文章生成学习摘要。"
        "只输出 JSON 对象，字段：summary_zh（中文摘要 3-5 句）、"
        "difficulty（文章 CEFR 难度，只能取 A2/B1/B2/C1/C2 之一）、"
        "key_vocab（数组，恰好 10 项文章核心词汇，每项 {word: 英文单词, meaning: 中文释义}）、"
        "themes（数组，2-5 个主题标签，中文）。"
        + ("输入正文因过长已截断，摘要请基于可见部分并保持概括性。" if truncated else "")
    )
    user = json.dumps({"title": title, "text": text}, ensure_ascii=False)
    return system, user
