"""LLM 运行时：adapter 路由注册表 + 可被 waterfall 拦截的流式调用入口。

翻译自 deepseek-harness ``packages/llm/llm/src/``：

- ``index.ts`` :70-118 LlmError；:191-260 LlmAdapter 抽象；:365-440 registerAdapter /
  prepareRoutes / commitRoutes 的"先全量校验、再一段同步提交"；:608-754 模型元数据的
  校验与脱钩；:780-814 调用配置对模型能力的解析；:824-869 prepareCall 的一次性分发句柄；
  :877-891 forAdapter 剥离不属于目标 adapter 的回放状态；:898-1011 adapterStream 的
  异常归一
- ``adapter-failure.ts`` normalizeLlmFailure
- ``error.ts`` HarnessError：``code`` 与 ``message`` 分离，按 code 路由、不解析文案

Python 化的取舍：

- 路由键是 ``"provider/model"`` 或 ``"provider/*"``（原版只按 provider 注册）：同一供应商
  下可以给个别模型指定专属 adapter，解析时精确路由优先于通配。model 名允许含 ``/``，
  只在第一个 ``/`` 处切分。
- ``AdapterHandle.replace`` 既能换 adapter 实例也能换路由集（原版只换路由）；已
  ``prepare_call`` 的调用仍绑定替换前的 adapter 与重试策略。
- Cordis 的 ``ctx.effect`` 用 :class:`Scopes` 的 effect 代替：带 scope 注册的 adapter
  随作用域释放。
- ``resolve_model`` 是同步钩子，所以 ``prepare_call`` 也是同步的；要走网络的模型发现放在
  ``async list_models``。
- 取消用 ``asyncio.Event`` 表示（对应 AbortSignal）。adapter 观察到置位后抛
  ``asyncio.CancelledError`` 或 ``ABORTED`` 码的 :class:`LlmError`，边界统一归一成
  ``finish{aborted}``；事件已置位时其它失败也按 aborted 收尾。
- 流结束没有 finish 分块时补 ``finish{stop}``；finish 之后 adapter 再吐的分块丢弃并关闭
  其迭代器（分块协议规定 finish 之后不再有分块）。
- 图片→纯文本的投影（``content.ts``）不在本模块范围，模型元数据不带 input_modalities。
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import math
from abc import ABC, abstractmethod
from collections.abc import AsyncGenerator, AsyncIterable, AsyncIterator, Callable, Sequence
from dataclasses import dataclass
from typing import Any, cast, get_args

from pydantic import BaseModel, ConfigDict, model_validator

from domain.kernel.events import EventBus, KernelError, ScopeError, ScopeKey
from domain.kernel.llm_retry import NormalRetryPolicy, ResolvedRetryPolicy
from domain.kernel.llm_types import (
    AbortedFinish,
    ErrorFinish,
    FinishChunk,
    GenerateOptions,
    LlmCallConfig,
    LlmFailure,
    LlmFailureCode,
    Message,
    ModelSource,
    StopFinish,
    StreamChunk,
    call_config_equals,
)

logger = logging.getLogger(__name__)

ADAPTERS_UPDATED_EVENT = "llm/adapters-updated"
STREAM_EVENT = "llm/stream"
WILDCARD_MODEL = "*"

_FROZEN = ConfigDict(frozen=True)
_FAILURE_CODES: frozenset[str] = frozenset(get_args(LlmFailureCode))
# 调用方把请求拼错了（没有对应 adapter、prepared 调用被改动、模型不支持该推理强度）：
# 落到 finish 分块时归为 INVALID_REQUEST，与供应商拒绝非法请求同一类
_REQUEST_ERROR_CODES: frozenset[str] = frozenset(
    {
        "NO_ADAPTER",
        "INVALID_PREPARED_CALL",
        "UNSUPPORTED_REASONING_EFFORT",
        "INVALID_MODEL_INFO",
        "INVALID_CATALOG",
    }
)
_CONFIG_FIELDS: frozenset[str] = frozenset(LlmCallConfig.model_fields)


def failure_code_for(code: str) -> LlmFailureCode:
    """把 harness 错误码折到 :data:`LlmFailureCode`：供应商码原样、请求类错误归
    ``INVALID_REQUEST``、其余 ``UNKNOWN``。"""
    if code in _FAILURE_CODES:
        return cast(LlmFailureCode, code)
    if code in _REQUEST_ERROR_CODES:
        return "INVALID_REQUEST"
    return "UNKNOWN"


class LlmError(KernelError):
    """带稳定机器码的 LLM 失败；按 ``code`` 路由，不要解析 ``message``。

    ``failure`` 是随异常保存的可序列化事实，供 finish 分块与日志使用。
    """

    def __init__(
        self,
        message: str,
        code: str,
        *,
        status: int | None = None,
        provider_retry_after_ms: float | None = None,
        request_id: str | None = None,
        cause: BaseException | None = None,
    ) -> None:
        if not isinstance(message, str) or not message:
            raise ValueError("LlmError message 必须是非空字符串")
        if not isinstance(code, str) or not code:
            raise ValueError("LlmError code 必须是非空字符串")
        if status is not None and (
            not isinstance(status, int) or isinstance(status, bool) or not 100 <= status <= 599
        ):
            raise ValueError("LlmError status 必须是 100 到 599 之间的整数")
        if provider_retry_after_ms is not None and (
            not math.isfinite(provider_retry_after_ms) or provider_retry_after_ms <= 0
        ):
            raise ValueError("LlmError provider_retry_after_ms 必须是正的有限数")
        if request_id is not None and (not isinstance(request_id, str) or not request_id):
            raise ValueError("LlmError request_id 必须是非空字符串")
        super().__init__(message)
        self.code = code
        self.failure = LlmFailure(
            message=message,
            code=failure_code_for(code),
            status=status,
            provider_retry_after_ms=(
                None if provider_retry_after_ms is None else int(provider_retry_after_ms)
            ),
            request_id=request_id,
        )
        if cause is not None:
            self.__cause__ = cause

    def __str__(self) -> str:
        return f"[{self.code}] {self.args[0]}"


def _error_message(error: BaseException) -> str:
    text = str(error)
    return text if text else type(error).__name__ or "LLM adapter failed"


def normalize_llm_failure(error: BaseException) -> LlmFailure:
    """把 adapter 边界抛出的任意异常压成可序列化的失败事实。

    :class:`LlmError` 与自带 ``failure`` 属性的异常沿用它们携带的事实；取消归 ``ABORTED``，
    超时归 ``TIMEOUT``，其余一律 ``UNKNOWN``——第三方 SDK 的错误码不是这套词汇。
    """
    if isinstance(error, asyncio.CancelledError):
        return LlmFailure(message="LLM call aborted", code="ABORTED")
    if isinstance(error, LlmError):
        return error.failure
    carried = getattr(error, "failure", None)
    if isinstance(carried, LlmFailure):
        return carried
    if isinstance(error, TimeoutError):
        return LlmFailure(message=_error_message(error), code="TIMEOUT")
    return LlmFailure(message=_error_message(error), code="UNKNOWN")


def adapter_failure_chunk(error: BaseException, cancel: asyncio.Event | None = None) -> FinishChunk:
    """一次 adapter 抛出 → 流协议的终止分块；取消信号已置位或失败码为 ABORTED 时记作 aborted。"""
    failure = normalize_llm_failure(error)
    if (cancel is not None and cancel.is_set()) or failure.code == "ABORTED":
        return FinishChunk(reason=AbortedFinish(failure=failure))
    return FinishChunk(reason=ErrorFinish(failure=failure))


# ---------------------------------------------------------------------------
# 供应商 / 模型元数据
# ---------------------------------------------------------------------------


class ProviderInfo(BaseModel):
    """一条供应商路由的展示元数据；``id`` 必须等于路由里的 provider。"""

    model_config = _FROZEN

    id: str
    name: str


class ReasoningEffortInfo(BaseModel):
    model_config = _FROZEN

    id: str
    name: str
    description: str | None = None


class ModelInfo(BaseModel):
    """一个精确模型的元数据。目录成员身份只是建议，不参与路由与请求校验。

    ``default_max_tokens`` / ``default_reasoning_effort`` 是 adapter 配置的默认值，调用方
    没给时物化进请求；``reasoning_efforts`` 为 ``None`` 表示模型不暴露推理强度。
    """

    model_config = _FROZEN

    provider: str
    id: str
    name: str
    description: str | None = None
    context_window: int | None = None
    default_max_tokens: int | None = None
    reasoning_efforts: list[ReasoningEffortInfo] | None = None
    default_reasoning_effort: str | None = None

    @model_validator(mode="after")
    def _check(self) -> ModelInfo:
        if not self.provider or not self.id or not self.name:
            raise ValueError("provider / id / name 必须非空")
        if self.context_window is not None and self.context_window <= 0:
            raise ValueError("context_window 必须是正整数")
        if self.default_max_tokens is not None and self.default_max_tokens <= 0:
            raise ValueError("default_max_tokens 必须是正整数")
        if self.reasoning_efforts is None:
            if self.default_reasoning_effort is not None:
                raise ValueError("没有 reasoning_efforts 就不能有 default_reasoning_effort")
            return self
        if not self.reasoning_efforts:
            raise ValueError("reasoning_efforts 给了就不能为空")
        ids = [effort.id for effort in self.reasoning_efforts]
        if len(set(ids)) != len(ids) or any(not effort_id for effort_id in ids):
            raise ValueError("reasoning_efforts 的 id 必须非空且互不重复")
        if self.default_reasoning_effort is not None and self.default_reasoning_effort not in ids:
            raise ValueError("default_reasoning_effort 必须是 reasoning_efforts 之一")
        return self

    def effort_ids(self) -> list[str]:
        return [effort.id for effort in self.reasoning_efforts or []]


# ---------------------------------------------------------------------------
# Adapter 抽象
# ---------------------------------------------------------------------------


class LlmAdapter(ABC):
    """供应商线协议 ↔ 内核消息 / 分块词汇的翻译层。

    唯一必须实现的是 :meth:`stream`（异步生成器）。其余钩子都按路由里的 provider 询问，
    同一个 adapter 实例可以同时负责多条路由。
    """

    def provider_info(self, provider: str) -> ProviderInfo:
        return ProviderInfo(id=provider, name=provider)

    def retry_policy(self, provider: str) -> ResolvedRetryPolicy | None:
        """供应商自带的重试策略；``None`` 用 normal 默认值。"""
        return None

    async def list_models(self, provider: str) -> list[ModelInfo]:
        """可供展示的模型目录，只是建议：未列出的模型 id 仍可能被接受。"""
        return []

    def resolve_model(self, provider: str, model: str) -> ModelInfo:
        """一个精确模型的全部元数据；与目录无关，也不校验路由。"""
        return ModelInfo(provider=provider, id=model, name=model)

    @abstractmethod
    def stream(
        self, options: GenerateOptions, *, cancel: asyncio.Event | None = None
    ) -> AsyncIterator[StreamChunk]:
        """把一次请求流成原始分块；实现必须观察 ``cancel``。"""


# ---------------------------------------------------------------------------
# 路由与注册
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Route:
    provider: str
    model: str

    @property
    def key(self) -> str:
        return f"{self.provider}/{self.model}"

    @property
    def is_wildcard(self) -> bool:
        return self.model == WILDCARD_MODEL


def parse_route(route: str) -> Route:
    """``"provider/model"`` 或 ``"provider/*"``；只在第一个 ``/`` 处切分。"""
    if not isinstance(route, str) or "/" not in route:
        raise LlmError(f'路由 "{route}" 必须写成 "provider/model" 或 "provider/*"', "INVALID_ROUTE")
    provider, _, model = route.partition("/")
    if not provider or not model:
        raise LlmError(f'路由 "{route}" 的 provider 与 model 都不能为空', "INVALID_ROUTE")
    return Route(provider=provider, model=model)


@dataclass(frozen=True)
class _Registration:
    route: Route
    adapter: LlmAdapter
    provider: ProviderInfo
    retry_policy: ResolvedRetryPolicy


class AdapterHandle:
    """``register_adapter`` 的返回：释放函数 + 对同一注册的原子替换。

    替换先全量校验候选集（与他人冲突、路由写错、元数据不合法都原样抛出，当前路由不动），
    再在一段同步代码里完成交换，没有请求能看到中间的空档。替换成空路由集是合法的（配置
    清空了但注册还活着），首次注册则不允许为空。
    """

    def __init__(self, runtime: LlmRuntime, adapter: LlmAdapter) -> None:
        self._runtime = runtime
        self._adapter = adapter
        self._owned: set[str] = set()
        self._released = False
        self._disposer: Callable[[], None] = self._release

    @property
    def adapter(self) -> LlmAdapter:
        return self._adapter

    @property
    def routes(self) -> list[str]:
        return sorted(self._owned)

    @property
    def released(self) -> bool:
        return self._released

    def replace(
        self, adapter: LlmAdapter | None = None, *, routes: Sequence[str] | None = None
    ) -> None:
        """换 adapter 实例、换路由集，或两者一起换；不传的沿用当前值。"""
        if self._released:
            raise LlmError("已释放的注册不能再替换路由或 adapter", "REGISTRATION_DISPOSED")
        next_adapter = adapter if adapter is not None else self._adapter
        next_routes = list(routes) if routes is not None else sorted(self._owned)
        registrations = self._runtime._prepare_routes(next_routes, next_adapter, self._owned)
        self._adapter = next_adapter
        self._runtime._commit_routes(self._owned, registrations)

    def dispose(self) -> None:
        """释放当前持有的全部路由；重复调用无副作用。"""
        self._disposer()

    def __call__(self) -> None:
        self.dispose()

    def _release(self) -> None:
        if self._released:
            return
        self._released = True
        self._runtime._commit_routes(self._owned, ())


@dataclass(frozen=True)
class _ResolvedCall:
    config: LlmCallConfig
    adapter_defaults: dict[str, bool]


def _as_call_config(config: LlmCallConfig, updates: dict[str, Any]) -> LlmCallConfig:
    """从（可能是 GenerateOptions 的）配置里抠出纯调用配置，叠加物化的默认值。"""
    data = config.model_dump(include=set(_CONFIG_FIELDS))
    data.update(updates)
    return LlmCallConfig.model_validate(data)


def _resolve_call_with_info(config: LlmCallConfig, info: ModelInfo) -> _ResolvedCall:
    """按模型能力校验请求控制项并物化 adapter 默认值；不做钳制、不做别名。"""
    updates: dict[str, Any] = {}
    if config.max_tokens is None and info.default_max_tokens is not None:
        updates["max_tokens"] = info.default_max_tokens
    requested = config.reasoning_effort
    if info.reasoning_efforts is None:
        if requested is not None:
            raise LlmError(
                f'模型 "{config.provider}/{config.model}" 不支持推理强度 "{requested}"',
                "UNSUPPORTED_REASONING_EFFORT",
            )
    else:
        effective = requested if requested is not None else info.default_reasoning_effort
        if effective is not None:
            if effective not in info.effort_ids():
                raise LlmError(
                    f'模型 "{config.provider}/{config.model}" 不支持推理强度 "{effective}"',
                    "UNSUPPORTED_REASONING_EFFORT",
                )
            if requested != effective:
                updates["reasoning_effort"] = effective
    return _ResolvedCall(
        config=_as_call_config(config, updates),
        adapter_defaults={
            key: True for key in ("reasoning_effort", "max_tokens") if key in updates
        },
    )


Dispatch = Callable[..., Any]


@dataclass(frozen=True)
class _PreparedDispatch:
    registration: _Registration
    config: LlmCallConfig
    dispatch: Dispatch


class PreparedCall:
    """一次调用的冻结视图：配置、重试策略、adapter 引用在 prepare 时一起定下来。

    之后 adapter 被替换也影响不到这次调用，请求头日志与实际分发必然出自同一代注册。
    :meth:`stream` 只能调用一次，且传入请求的调用配置字段必须与 :attr:`config` 完全一致。
    """

    def __init__(
        self,
        runtime: LlmRuntime,
        registration: _Registration,
        resolved: _ResolvedCall,
        model: ModelInfo,
        *,
        options: GenerateOptions | None,
        scope: ScopeKey | None,
        cancel: asyncio.Event | None,
    ) -> None:
        self._runtime = runtime
        self._registration = registration
        self._config = resolved.config
        self._adapter_defaults = dict(resolved.adapter_defaults)
        self._model = model
        self._options = options
        self._scope = scope
        self._cancel = cancel
        self._dispatched = False

    @property
    def config(self) -> LlmCallConfig:
        """物化了 adapter 默认值的纯调用配置。"""
        return self._config

    @property
    def adapter_defaults(self) -> dict[str, bool]:
        """哪些字段是 adapter 物化的而非调用方提出的（键：reasoning_effort / max_tokens）。"""
        return dict(self._adapter_defaults)

    @property
    def retry_policy(self) -> ResolvedRetryPolicy:
        return self._registration.retry_policy

    @property
    def adapter(self) -> LlmAdapter:
        return self._registration.adapter

    @property
    def model(self) -> ModelInfo:
        return self._model

    @property
    def context_window(self) -> int | None:
        return self._model.context_window

    @property
    def dispatched(self) -> bool:
        return self._dispatched

    def stream(self, options: GenerateOptions | None = None) -> AsyncIterator[StreamChunk]:
        """通过 prepare 时捕获的注册分发一次；不传 ``options`` 就用 prepare 时给的请求。"""
        if self._dispatched:
            raise LlmError("prepared 调用只能分发一次", "INVALID_PREPARED_CALL")
        target = options if options is not None else self._options
        if target is None:
            raise LlmError(
                "prepare_call 只收到了 LlmCallConfig，stream() 必须传入完整的 GenerateOptions",
                "INVALID_PREPARED_CALL",
            )
        if not call_config_equals(target, self._config):
            raise LlmError("prepared 调用的配置在分发前被改动", "INVALID_PREPARED_CALL")
        self._dispatched = True
        prepared = _PreparedDispatch(
            registration=self._registration,
            config=self._config,
            dispatch=self._registration.adapter.stream,
        )
        return self._runtime._stream_with(
            target, scope=self._scope, cancel=self._cancel, prepared=prepared
        )


async def _aclose(iterator: AsyncIterator[Any]) -> None:
    aclose = getattr(iterator, "aclose", None)
    if aclose is not None:
        await aclose()


# ---------------------------------------------------------------------------
# 运行时
# ---------------------------------------------------------------------------


class LlmRuntime:
    """adapter 注册表 + 流式调用 API；每次调用都经过 ``llm/stream`` waterfall。

    waterfall 监听器签名 ``async def listener(options, *, next)``：``await next(options2)``
    拿到内层的分块流（可以包装后返回），不调 ``next`` 就用自己的流短路。注册表变动时
    ``emit("llm/adapters-updated")``。
    """

    def __init__(self, bus: EventBus) -> None:
        self.bus = bus
        self._routes: dict[str, _Registration] = {}

    # ---- 注册 ----

    def register_adapter(
        self, routes: Sequence[str], adapter: LlmAdapter, *, scope: ScopeKey | None = None
    ) -> AdapterHandle:
        """给 ``routes`` 注册 adapter，全有或全无；任一路由已被别的注册持有抛 DUPLICATE_ADAPTER。

        带 ``scope`` 的注册随作用域释放。
        """
        if not routes:
            raise LlmError("adapter 至少要注册一条路由", "INVALID_ADAPTER")
        if scope is not None and scope not in self.bus.scopes:
            raise ScopeError(f"作用域 {scope!r} 不存在或已释放，无法注册 adapter")
        handle = AdapterHandle(self, adapter)
        self._commit_routes(handle._owned, self._prepare_routes(routes, adapter, handle._owned))
        if scope is not None:
            handle._disposer = self.bus.scopes.effect(scope, handle._release)
        return handle

    def _prepare_routes(
        self, routes: Sequence[str], adapter: LlmAdapter, owned: set[str]
    ) -> list[_Registration]:
        """全量校验一个候选路由集；本注册已持有的路由视为可用。不改任何状态。"""
        seen: set[str] = set()
        registrations: list[_Registration] = []
        for raw in routes:
            route = parse_route(raw)
            key = route.key
            if key in seen or (key in self._routes and key not in owned):
                raise LlmError(f'路由 "{key}" 已经有 adapter 了', "DUPLICATE_ADAPTER")
            info = adapter.provider_info(route.provider)
            if not isinstance(info, ProviderInfo) or info.id != route.provider or not info.name:
                raise LlmError(
                    f'路由 "{key}" 的供应商元数据必须保留 id 且 name 非空', "INVALID_ADAPTER"
                )
            seen.add(key)
            policy = adapter.retry_policy(route.provider)
            registrations.append(
                _Registration(
                    route=route,
                    adapter=adapter,
                    provider=info,
                    retry_policy=policy if policy is not None else NormalRetryPolicy(),
                )
            )
        return registrations

    def _commit_routes(self, owned: set[str], registrations: Sequence[_Registration]) -> None:
        """一段同步代码里完成释放 + 重新登记，随后广播变更。"""
        for key in owned:
            self._routes.pop(key, None)
        owned.clear()
        for registration in registrations:
            self._routes[registration.route.key] = registration
            owned.add(registration.route.key)
        self.bus.emit(ADAPTERS_UPDATED_EVENT)

    # ---- 查询 ----

    def list_routes(self) -> list[str]:
        return list(self._routes)

    def list_providers(self) -> list[ProviderInfo]:
        """有 adapter 的供应商，按注册顺序去重。"""
        seen: dict[str, ProviderInfo] = {}
        for registration in self._routes.values():
            seen.setdefault(registration.provider.id, registration.provider)
        return list(seen.values())

    def resolve(self, provider: str, model: str) -> LlmAdapter | None:
        """精确路由优先于 ``provider/*``；都没有返回 ``None``。"""
        registration = self._registration_for(provider, model)
        return registration.adapter if registration is not None else None

    def provider_retry_policy(self, provider: str, model: str) -> ResolvedRetryPolicy:
        return self._registration(provider, model).retry_policy

    async def list_models(self, provider: str) -> list[ModelInfo]:
        """汇总该供应商所有路由的 adapter 目录；provider 不符或 id 重复抛 INVALID_CATALOG。"""
        adapters: list[LlmAdapter] = []
        for registration in self._routes.values():
            if registration.route.provider == provider and not any(
                registration.adapter is seen for seen in adapters
            ):
                adapters.append(registration.adapter)
        if not adapters:
            raise LlmError(f'供应商 "{provider}" 没有注册任何 adapter', "NO_ADAPTER")
        models: list[ModelInfo] = []
        ids: set[str] = set()
        for adapter in adapters:
            for model in await adapter.list_models(provider):
                if not isinstance(model, ModelInfo) or model.provider != provider:
                    raise LlmError(
                        f'供应商 "{provider}" 的目录条目 provider 不符', "INVALID_CATALOG"
                    )
                if model.id in ids:
                    raise LlmError(
                        f'供应商 "{provider}" 的目录里模型 "{model.id}" 重复', "INVALID_CATALOG"
                    )
                ids.add(model.id)
                models.append(model)
        return models

    def resolve_model_info(self, provider: str, model: str) -> ModelInfo:
        registration = self._registration(provider, model)
        return self._normalize_model_info(registration, model)

    def resolve_call_config(self, config: LlmCallConfig) -> LlmCallConfig:
        """按模型能力校验并物化默认值，不绑定后续分发；要绑定用 :meth:`prepare_call`。"""
        registration = self._registration(config.provider, config.model)
        info = self._normalize_model_info(registration, config.model)
        return _resolve_call_with_info(config, info).config

    # ---- 调用 ----

    def prepare_call(
        self,
        config: LlmCallConfig,
        *,
        scope: ScopeKey | None = None,
        cancel: asyncio.Event | None = None,
    ) -> PreparedCall:
        """在当前注册下解析一次调用；返回的句柄把注册、配置、重试策略一起冻住。

        传 :class:`GenerateOptions` 时 ``PreparedCall.stream()`` 可不带参数。
        """
        registration = self._registration(config.provider, config.model)
        info = self._normalize_model_info(registration, config.model)
        resolved = _resolve_call_with_info(config, info)
        return PreparedCall(
            self,
            registration,
            resolved,
            info,
            options=config if isinstance(config, GenerateOptions) else None,
            scope=scope,
            cancel=cancel,
        )

    def stream(
        self,
        options: GenerateOptions,
        *,
        scope: ScopeKey | None = None,
        cancel: asyncio.Event | None = None,
    ) -> AsyncIterator[StreamChunk]:
        """流式调用：``llm/stream`` waterfall 套在 adapter 外层。

        adapter 的选择、分发与迭代失败都变成终止分块（error / aborted）；监听器与下游
        消费者的异常照常抛出。
        """
        return self._stream_with(options, scope=scope, cancel=cancel, prepared=None)

    # ---- 内部 ----

    def _registration_for(self, provider: str, model: str) -> _Registration | None:
        exact = self._routes.get(f"{provider}/{model}")
        if exact is not None:
            return exact
        return self._routes.get(f"{provider}/{WILDCARD_MODEL}")

    def _registration(self, provider: str, model: str) -> _Registration:
        registration = self._registration_for(provider, model)
        if registration is None:
            raise LlmError(f'没有 adapter 负责 "{provider}/{model}"', "NO_ADAPTER")
        return registration

    def _normalize_model_info(self, registration: _Registration, model: str) -> ModelInfo:
        provider = registration.route.provider
        info = registration.adapter.resolve_model(provider, model)
        if not isinstance(info, ModelInfo) or info.provider != provider or info.id != model:
            raise LlmError(
                f'adapter 给 "{provider}/{model}" 返回的模型元数据 provider / id 不符',
                "INVALID_MODEL_INFO",
            )
        return info

    def _for_adapter(self, options: GenerateOptions, adapter: LlmAdapter) -> GenerateOptions:
        """剥掉历史路由归别的 adapter 所有的回放状态；没有可剥的就原样返回。"""
        messages: list[Message] = []
        changed = False
        for message in options.messages:
            source = message.source
            if (
                message.role != "assistant"
                or not isinstance(source, ModelSource)
                or source.replay_state is None
                or self.resolve(source.provider, source.model) is adapter
            ):
                messages.append(message)
                continue
            stripped = ModelSource(provider=source.provider, model=source.model)
            messages.append(message.model_copy(update={"source": stripped}))
            changed = True
        return options.model_copy(update={"messages": messages}) if changed else options

    async def _stream_with(
        self,
        options: GenerateOptions,
        *,
        scope: ScopeKey | None,
        cancel: asyncio.Event | None,
        prepared: _PreparedDispatch | None,
    ) -> AsyncGenerator[StreamChunk, None]:
        def terminal(final: GenerateOptions) -> AsyncIterator[StreamChunk]:
            return self._adapter_stream(final, cancel=cancel, prepared=prepared)

        result = await self.bus.waterfall(STREAM_EVENT, options, scope=scope, terminal=terminal)
        if not isinstance(result, AsyncIterable):
            raise TypeError(
                f"'{STREAM_EVENT}' 监听器必须返回异步可迭代对象，得到 {type(result).__name__}"
            )
        iterator = result.__aiter__()
        exhausted = False
        try:
            while True:
                try:
                    chunk = await iterator.__anext__()
                except StopAsyncIteration:
                    exhausted = True
                    break
                yield chunk
        finally:
            if not exhausted:
                await _aclose(iterator)

    async def _adapter_stream(
        self,
        options: GenerateOptions,
        *,
        cancel: asyncio.Event | None,
        prepared: _PreparedDispatch | None,
    ) -> AsyncGenerator[StreamChunk, None]:
        """最终的 adapter 边界：选择、分发、构造迭代器、迭代中的失败都压成一个终止分块。"""
        iterator: AsyncIterator[StreamChunk]
        try:
            if prepared is None:
                registration = self._registration(options.provider, options.model)
                info = self._normalize_model_info(registration, options.model)
                resolved_config = _resolve_call_with_info(options, info).config
                dispatch: Dispatch = registration.adapter.stream
            else:
                registration = prepared.registration
                resolved_config = prepared.config
                dispatch = prepared.dispatch
                if not call_config_equals(options, resolved_config):
                    raise LlmError("prepared 调用的配置在分发前被改动", "INVALID_PREPARED_CALL")
            resolved_options = (
                options
                if call_config_equals(options, resolved_config)
                else options.model_copy(update=resolved_config.model_dump())
            )
            source = dispatch(
                self._for_adapter(resolved_options, registration.adapter), cancel=cancel
            )
            if inspect.isawaitable(source):
                source = await source
            iterator = source.__aiter__()
        except (Exception, asyncio.CancelledError) as error:
            self._log_adapter_failure(options, error)
            yield adapter_failure_chunk(error, cancel)
            return

        exhausted = False
        try:
            while True:
                try:
                    chunk = await iterator.__anext__()
                except StopAsyncIteration:
                    exhausted = True
                    break
                except (Exception, asyncio.CancelledError) as error:
                    exhausted = True
                    self._log_adapter_failure(options, error)
                    yield adapter_failure_chunk(error, cancel)
                    return
                # adapter 自己的 try 到此为止：下游在 yield 点抛回来的异常照常向上传
                yield chunk
                if isinstance(chunk, FinishChunk):
                    return
            yield FinishChunk(reason=StopFinish())
        finally:
            if not exhausted:
                await _aclose(iterator)

    @staticmethod
    def _log_adapter_failure(options: GenerateOptions, error: BaseException) -> None:
        if isinstance(error, LlmError | asyncio.CancelledError):
            return
        logger.warning(
            "adapter %s/%s 抛出未归类异常，已压成 finish 分块",
            options.provider,
            options.model,
            exc_info=error,
        )


__all__ = [
    "ADAPTERS_UPDATED_EVENT",
    "STREAM_EVENT",
    "WILDCARD_MODEL",
    "AdapterHandle",
    "LlmAdapter",
    "LlmError",
    "LlmRuntime",
    "ModelInfo",
    "PreparedCall",
    "ProviderInfo",
    "ReasoningEffortInfo",
    "Route",
    "adapter_failure_chunk",
    "failure_code_for",
    "normalize_llm_failure",
    "parse_route",
]
