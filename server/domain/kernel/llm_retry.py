"""模型请求的重试策略与执行。

翻译自 deepseek-harness：

- ``packages/llm/llm/src/retry-policy.ts`` :14-79 策略形态与默认值，:149-195 解析与校验
- ``packages/llm/llm-retry/src/index.ts`` :58-63 本地指数退避，:65-76 策略指纹，
  :156-208 重试决策（可重试码、预算、供应商 Retry-After 的采纳与拒绝）

原版把重试挂在 agent loop 的 ``agent/request-error`` waterfall 上，重试次数靠会话日志里
的 ``llm/retry`` 事件回数。这里没有会话日志，:func:`run_with_retry` 直接包住一次调用的
分块流：计数器跟着这次调用走，调用方用 ``on_retry`` 回调把 :class:`RetryAttempt` 落日志。

Python 化的取舍：

- 多一种 ``never`` 模式（原版只有 normal / always），给不想重试的路由一个显式值。
- 只在流还没吐出任何分块时重试：分块一旦交给下游就收不回来，再重试会重复输出。原版
  是 loop 丢掉失败步骤的部分输出后再重试，落到外部可见的结果上是一回事。
- 退避期间 ``cancel`` 置位 → 以 ``finish{aborted}`` 收尾，对应原版 ``cancellableDelay``
  返回 false 后 loop 按中断处理。
- 取消信号用 ``asyncio.Event`` 表示（对应 AbortSignal）。
"""

from __future__ import annotations

import asyncio
import inspect
import json
import math
import uuid
from collections.abc import AsyncIterable, AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass
from random import random as _system_random
from typing import Any, Literal

from domain.kernel.llm_types import (
    EMPTY_RESPONSE_CODE,
    AbortedFinish,
    ErrorFinish,
    FinishChunk,
    LlmFailure,
    StreamChunk,
)

# 与原版 dsh-timeout 的 MAX_TIMER_DELAY_MS 一致：setTimeout 能接受的最大毫秒数
MAX_TIMER_DELAY_MS = 2_147_483_647

DEFAULT_MAX_RETRIES = 5
DEFAULT_INITIAL_DELAY_MS = 500.0
DEFAULT_MAX_DELAY_MS = 10_000.0
DEFAULT_JITTER_RATIO = 0.1
DEFAULT_RETRYABLE_CODES: frozenset[str] = frozenset(
    {EMPTY_RESPONSE_CODE, "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"}
)

RetryMode = Literal["normal", "always", "never"]
RandomSource = Callable[[], float]


class RetryPolicyError(ValueError):
    """策略配置不合法：字段越界、未知键、空的可重试码集合。"""


def _is_number(value: object) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool)


def _validate_backoff(initial_delay_ms: float, max_delay_ms: float, jitter_ratio: float) -> None:
    for name, value in (("initial_delay_ms", initial_delay_ms), ("max_delay_ms", max_delay_ms)):
        if not _is_number(value) or not math.isfinite(value) or not 0 < value <= MAX_TIMER_DELAY_MS:
            raise RetryPolicyError(f"{name} 必须是 (0, {MAX_TIMER_DELAY_MS}] 内的有限数")
    if initial_delay_ms > max_delay_ms:
        raise RetryPolicyError("initial_delay_ms 不能大于 max_delay_ms")
    if not _is_number(jitter_ratio) or not 0 <= jitter_ratio <= 1:
        raise RetryPolicyError("jitter_ratio 必须在 0 到 1 之间")


@dataclass(frozen=True)
class RetryBackoff:
    """有上限的指数退避，每次本地延迟再乘一个围绕 1 对称的随机系数。"""

    initial_delay_ms: float = DEFAULT_INITIAL_DELAY_MS
    max_delay_ms: float = DEFAULT_MAX_DELAY_MS
    jitter_ratio: float = DEFAULT_JITTER_RATIO

    def __post_init__(self) -> None:
        _validate_backoff(self.initial_delay_ms, self.max_delay_ms, self.jitter_ratio)


@dataclass(frozen=True)
class NormalRetryPolicy(RetryBackoff):
    """只重试配置内的瞬时失败码，次数有预算。"""

    mode: Literal["normal"] = "normal"
    max_retries: int = DEFAULT_MAX_RETRIES
    retryable_codes: frozenset[str] = DEFAULT_RETRYABLE_CODES

    def __post_init__(self) -> None:
        super().__post_init__()
        if (
            not isinstance(self.max_retries, int)
            or isinstance(self.max_retries, bool)
            or self.max_retries < 0
        ):
            raise RetryPolicyError("max_retries 必须是非负整数")
        if not self.retryable_codes:
            raise RetryPolicyError("retryable_codes 不能为空")
        if any(not isinstance(code, str) or not code for code in self.retryable_codes):
            raise RetryPolicyError("retryable_codes 只能包含非空字符串")


@dataclass(frozen=True)
class AlwaysRetryPolicy(RetryBackoff):
    """每个失败都重试，直到成功或取消；退避仍有上限。"""

    mode: Literal["always"] = "always"


@dataclass(frozen=True)
class NeverRetryPolicy:
    """从不重试。"""

    mode: Literal["never"] = "never"


ResolvedRetryPolicy = NormalRetryPolicy | AlwaysRetryPolicy | NeverRetryPolicy

_POLICY_KEYS = frozenset({"mode", "max_retries", "retryable_codes", "backoff"})
_BACKOFF_KEYS = frozenset({"initial_delay_ms", "max_delay_ms", "jitter_ratio"})


def _validate_keys(value: Mapping[str, Any], allowed: frozenset[str], path: str) -> None:
    for key in value:
        if key not in allowed:
            raise RetryPolicyError(f'{path}: 未知键 "{key}"')


def resolve_retry_policy(
    config: Mapping[str, Any] | None = None, path: str = "retry_policy"
) -> ResolvedRetryPolicy:
    """校验、补默认值并脱钩一份供应商配置；``None`` 即 normal 默认策略。

    ``always`` / ``never`` 模式允许带着 normal 专属字段（分层配置切换模式后常残留），
    这些字段被忽略，但未知键仍然拒绝。
    """
    if config is None:
        return NormalRetryPolicy()
    _validate_keys(config, _POLICY_KEYS, path)
    mode = config.get("mode")
    try:
        backoff = _resolve_backoff(config.get("backoff"))
        match mode:
            case "normal":
                codes = config.get("retryable_codes")
                if codes is not None:
                    if not isinstance(codes, list | tuple):
                        raise RetryPolicyError("retryable_codes 必须是字符串列表")
                    if len(set(codes)) != len(codes):
                        raise RetryPolicyError("retryable_codes 不能有重复项")
                return NormalRetryPolicy(
                    initial_delay_ms=backoff.initial_delay_ms,
                    max_delay_ms=backoff.max_delay_ms,
                    jitter_ratio=backoff.jitter_ratio,
                    max_retries=config.get("max_retries", DEFAULT_MAX_RETRIES),
                    retryable_codes=(
                        frozenset(codes) if codes is not None else DEFAULT_RETRYABLE_CODES
                    ),
                )
            case "always":
                return AlwaysRetryPolicy(
                    initial_delay_ms=backoff.initial_delay_ms,
                    max_delay_ms=backoff.max_delay_ms,
                    jitter_ratio=backoff.jitter_ratio,
                )
            case "never":
                return NeverRetryPolicy()
            case _:
                raise RetryPolicyError('mode 必须是 "normal"、"always" 或 "never"')
    except RetryPolicyError as error:
        raise RetryPolicyError(f"{path}: {error}") from None


def _resolve_backoff(raw: Any) -> RetryBackoff:
    if raw is None:
        return RetryBackoff()
    if not isinstance(raw, Mapping):
        raise RetryPolicyError("backoff 必须是对象")
    _validate_keys(raw, _BACKOFF_KEYS, "backoff")
    return RetryBackoff(**{key: raw[key] for key in _BACKOFF_KEYS if key in raw})


def retry_policy_key(policy: ResolvedRetryPolicy) -> str:
    """策略指纹：同一路由换了策略，旧的重试计数就不再算数。"""
    if isinstance(policy, NeverRetryPolicy):
        return json.dumps(["never"])
    if isinstance(policy, AlwaysRetryPolicy):
        return json.dumps(
            ["always", policy.initial_delay_ms, policy.max_delay_ms, policy.jitter_ratio]
        )
    return json.dumps(
        [
            "normal",
            policy.max_retries,
            sorted(policy.retryable_codes),
            policy.initial_delay_ms,
            policy.max_delay_ms,
            policy.jitter_ratio,
        ]
    )


def local_delay(policy: RetryBackoff, retry: int, random: RandomSource | None = None) -> float:
    """第 ``retry`` 次（从 1 起）重试的本地退避毫秒数：指数增长、封顶、再抖动、再封顶。"""
    sample = (random or _system_random)()
    # 原版封顶 1024 是为了让 2 ** n 留在 JS 的 Infinity 语义里；Python 的 2.0 ** 1024 直接抛
    # OverflowError，1023 以内乘法溢出只会得到 inf，交给 min 封顶
    exponent = min(retry - 1, 1023)
    exponential = min(policy.initial_delay_ms * 2.0**exponent, policy.max_delay_ms)
    jitter = 1 - policy.jitter_ratio + 2 * policy.jitter_ratio * sample
    return min(exponential * jitter, policy.max_delay_ms)


def compute_delay(
    policy: ResolvedRetryPolicy,
    retry: int,
    failure: LlmFailure | None = None,
    *,
    random: RandomSource | None = None,
) -> float | None:
    """第 ``retry`` 次重试前要等多少毫秒；``None`` 表示这次不该重试。

    供应商给了 Retry-After 且不超过 ``max_delay_ms`` 就照用；超过上限时 normal 模式
    放弃（等那么久不如交给上层），always 模式改用本地退避。
    """
    if isinstance(policy, NeverRetryPolicy):
        return None
    hinted = failure.provider_retry_after_ms if failure is not None else None
    if hinted is not None and math.isfinite(hinted) and hinted > 0:
        if hinted > policy.max_delay_ms:
            if isinstance(policy, NormalRetryPolicy):
                return None
            return local_delay(policy, retry, random)
        return float(hinted)
    return local_delay(policy, retry, random)


@dataclass(frozen=True)
class RetryDecision:
    retry: int
    delay_ms: float


def decide_retry(
    policy: ResolvedRetryPolicy,
    failure: LlmFailure,
    previous_retries: int,
    *,
    random: RandomSource | None = None,
) -> RetryDecision | None:
    """已经重试过 ``previous_retries`` 次之后，这次失败还要不要再试；不试返回 ``None``。"""
    if isinstance(policy, NeverRetryPolicy):
        return None
    if isinstance(policy, NormalRetryPolicy):
        if failure.code not in policy.retryable_codes:
            return None
        if previous_retries >= policy.max_retries:
            return None
    retry = previous_retries + 1
    delay_ms = compute_delay(policy, retry, failure, random=random)
    if delay_ms is None:
        return None
    return RetryDecision(retry=retry, delay_ms=delay_ms)


@dataclass(frozen=True)
class RetryAttempt:
    """一次已排期的重试，交给 ``on_retry`` 落日志；字段对应原版 ``llm/retry`` 事件。

    ``retry_id`` 在同一次调用的所有重试里保持不变，``retry`` 从 1 起计。
    """

    retry_id: str
    retry: int
    max_retries: int | None
    delay_ms: float
    failure: LlmFailure
    mode: RetryMode
    policy_key: str


StreamFactory = Callable[[], AsyncIterable[StreamChunk] | Awaitable[AsyncIterable[StreamChunk]]]
RetryCallback = Callable[[RetryAttempt], Any]


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


async def _aclose(iterator: AsyncIterator[Any]) -> None:
    aclose = getattr(iterator, "aclose", None)
    if aclose is not None:
        await aclose()


async def _cancellable_delay(delay_ms: float, cancel: asyncio.Event | None) -> bool:
    """等够 ``delay_ms`` 返回 True；等待期间 ``cancel`` 置位返回 False。"""
    if cancel is None:
        await asyncio.sleep(delay_ms / 1000)
        return True
    if cancel.is_set():
        return False
    try:
        await asyncio.wait_for(cancel.wait(), timeout=delay_ms / 1000)
    except TimeoutError:
        return True
    return False


async def run_with_retry(
    policy: ResolvedRetryPolicy,
    fn: StreamFactory,
    *,
    on_retry: RetryCallback | None = None,
    cancel: asyncio.Event | None = None,
    random: RandomSource | None = None,
) -> AsyncIterator[StreamChunk]:
    """按 ``policy`` 重跑 ``fn`` 产出的分块流，直到一次流正常产出或决定不再重试。

    ``fn`` 每次调用必须返回一个全新的流（可以是异步可迭代对象，也可以是解析成它的
    awaitable）。只有流的第一个分块就是 ``finish{error}`` 时才会重试；任何分块已交给
    下游之后出现的失败原样放行。退避期间 ``cancel`` 置位，以 ``finish{aborted}`` 收尾。
    """
    retry_id = str(uuid.uuid4())
    policy_key = retry_policy_key(policy)
    max_retries = policy.max_retries if isinstance(policy, NormalRetryPolicy) else None
    retries = 0
    while True:
        source = fn()
        if inspect.isawaitable(source):
            source = await source
        iterator = source.__aiter__()
        exhausted = False
        retrying = False
        yielded = False
        try:
            while True:
                try:
                    chunk = await iterator.__anext__()
                except StopAsyncIteration:
                    exhausted = True
                    break
                if (
                    not yielded
                    and isinstance(chunk, FinishChunk)
                    and isinstance(chunk.reason, ErrorFinish)
                ):
                    failure = chunk.reason.failure
                    decision = decide_retry(policy, failure, retries, random=random)
                    if decision is None:
                        yield chunk
                        return
                    retries = decision.retry
                    if on_retry is not None:
                        await _maybe_await(
                            on_retry(
                                RetryAttempt(
                                    retry_id=retry_id,
                                    retry=decision.retry,
                                    max_retries=max_retries,
                                    delay_ms=decision.delay_ms,
                                    failure=failure,
                                    mode=policy.mode,
                                    policy_key=policy_key,
                                )
                            )
                        )
                    if not await _cancellable_delay(decision.delay_ms, cancel):
                        yield FinishChunk(
                            reason=AbortedFinish(failure=failure),
                            replay_state=chunk.replay_state,
                        )
                        return
                    retrying = True
                    break
                yielded = True
                yield chunk
        finally:
            if not exhausted:
                await _aclose(iterator)
        if not retrying:
            return


__all__ = [
    "DEFAULT_INITIAL_DELAY_MS",
    "DEFAULT_JITTER_RATIO",
    "DEFAULT_MAX_DELAY_MS",
    "DEFAULT_MAX_RETRIES",
    "DEFAULT_RETRYABLE_CODES",
    "MAX_TIMER_DELAY_MS",
    "AlwaysRetryPolicy",
    "NeverRetryPolicy",
    "NormalRetryPolicy",
    "RandomSource",
    "ResolvedRetryPolicy",
    "RetryAttempt",
    "RetryBackoff",
    "RetryCallback",
    "RetryDecision",
    "RetryMode",
    "RetryPolicyError",
    "StreamFactory",
    "compute_delay",
    "decide_retry",
    "local_delay",
    "resolve_retry_policy",
    "retry_policy_key",
    "run_with_retry",
]
