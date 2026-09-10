"""统一模型运行时：冻结模型路由，并把 Chat 执行交给可撤销 Provider 插件。

Chat 消费者拿到 :class:`PreparedChatCall` 之后走 :meth:`PreparedChatCall.stream_chunks` /
:meth:`PreparedChatCall.complete_chunks`：线协议在这里翻译成内核的 StreamChunk，首 token
时刻、上游回报的模型名 / 请求 id / 用量由调用门面自己记账，失败统一归一成
:class:`domain.kernel.llm_types.LlmFailure` 并把失败码写进台账。

路由解析走 :func:`domain.model_catalog.resolve_model_candidates`：首个可用候选冻结为主路由，
其余以脱敏视图挂在 ``snapshot.fallbacks``；绑定上的调用参数并进 ``snapshot.protocol_options``，
dispatch 前按 Provider 登记的白名单注入请求（显式 kwargs 优先）。一个候选都没有时直接抛
``ModelRuntimeError``（文案见 :func:`unbound_capability_message`）。Chat 一律直连上游，
网关已不在任何路径上。

``prepare_call(coded_failures=True)`` 的调用把上游异常归一成 :class:`ModelCallFailure`
（带稳定失败码）抛出，供 ``domain.llm`` 的重试 / fallback 编排；缺省仍抛 SDK 原始异常，
探针、GPT 对话等按 SDK 异常类型分支的旧消费者不受影响。
"""

from __future__ import annotations

import asyncio
import inspect
from collections.abc import AsyncIterable, AsyncIterator, Callable, Mapping
from contextlib import asynccontextmanager
from copy import deepcopy
from dataclasses import dataclass, field
from types import MappingProxyType, SimpleNamespace
from typing import Any, Protocol

from openai import AsyncOpenAI
from sqlalchemy.ext.asyncio import AsyncSession

from domain import gateway
from domain.credentials import CredentialError, openai_base
from domain.kernel.llm_retry import (
    NormalRetryPolicy,
    ResolvedRetryPolicy,
    RetryPolicyError,
    resolve_retry_policy,
)
from domain.kernel.llm_types import LlmFailure, StreamChunk, is_token_delta
from domain.model_catalog import (
    ModelCatalogError,
    ResolvedModelRoute,
    resolve_model_candidates,
)
from domain.model_invocations import ChunkEventBatcher
from domain.model_plugins import get_model_plugin, model_plugin_identity
from domain.plugin_runtime import (
    PluginManifest,
    PluginRegistry,
    PluginRegistryError,
    RegistrationHandle,
)
from domain.providers.openai_chat import (
    failure_from_exception,
    translate_openai_chunks,
    translate_openai_response,
)


class ModelRuntimeError(ValueError):
    pass


class ModelCallFailure(ModelRuntimeError):
    """一次上游调用失败的稳定事实：``failure.code`` 才是分支依据，文案只给人看。

    ``__cause__`` 指向上游原始异常（SDK 异常 / 消费者抛的 LLMUnavailable）。
    """

    def __init__(self, failure: LlmFailure) -> None:
        super().__init__(failure.message)
        self.failure = failure


def unbound_capability_message(capability: str) -> str:
    """能力没有可用部署时的统一文案。

    早期版本会回落到网关的同名别名上，而网关默认根本没启动，用户看到的是
    「连接被拒绝 :4000」——错误指向网关，真实原因却是这条能力没配模型。
    """
    return f"能力 {capability} 尚未绑定模型，去设置 · 模型服务（/settings/models）选一个部署"


# 交互式调用预算 60s：两次退避（约 0.5s + 1s）之后还不行就该切 fallback 或报错，
# 而不是像 agent loop 那样攒到五次。部署可在 protocol_options.retry_policy 覆盖。
DEFAULT_CHAT_RETRY_POLICY: ResolvedRetryPolicy = NormalRetryPolicy(max_retries=2)

# OpenAI 兼容线协议认得的采样参数；其它键即使写在绑定参数里也不会进请求
OPENAI_CHAT_PARAM_KEYS: frozenset[str] = frozenset(
    {"temperature", "max_tokens", "top_p", "reasoning_effort"}
)


def chat_failure(exc: BaseException) -> LlmFailure:
    """任意异常 → 中立失败事实。取消 / 消费者关流归 ABORTED，自带 ``failure`` 的沿用，
    其余交给 openai SDK 的状态码映射。"""
    if isinstance(exc, asyncio.CancelledError | GeneratorExit):
        return LlmFailure(message="LLM call aborted", code="ABORTED")
    carried = getattr(exc, "failure", None)
    if isinstance(carried, LlmFailure):
        return carried
    return failure_from_exception(exc)


def _attr(obj: Any, name: str) -> Any:
    """SDK 对象取属性、dict 取键；缺失按 None。"""
    if obj is None:
        return None
    if isinstance(obj, Mapping):
        return obj.get(name)
    return getattr(obj, name, None)


def _usage_dict(value: Any) -> dict[str, Any] | None:
    """上游 usage → 可落库的 dict；保留线协议原貌（prompt_tokens …），台账口径不变。"""
    if value is None:
        return None
    if hasattr(value, "model_dump"):
        dumped = value.model_dump(exclude_none=True)
        return dict(dumped) if isinstance(dumped, dict) else None
    if isinstance(value, Mapping):
        return dict(value)
    return None


_HEADER_KEYS = ("model", "stream", "messages", "tools", "tool_choice", "response_format")


def _request_header(kwargs: Mapping[str, Any], injected: Mapping[str, Any]) -> dict[str, Any]:
    """发给上游的请求冻结快照：消息、系统提示、工具与注入参数；脱敏由台账在落库前做。"""
    header: dict[str, Any] = {
        key: deepcopy(kwargs[key]) for key in _HEADER_KEYS if kwargs.get(key) is not None
    }
    messages = kwargs.get("messages")
    if isinstance(messages, list):
        system = [
            _attr(message, "content")
            for message in messages
            if _attr(message, "role") == "system" and _attr(message, "content")
        ]
        if system:
            header["system"] = system
    if injected:
        header["params"] = dict(injected)
    return header


def _freeze(value: Any) -> Any:
    """递归冻结公开路由配置，避免 prepared call 被后续配置修改污染。"""
    if isinstance(value, dict):
        return MappingProxyType({str(key): _freeze(item) for key, item in value.items()})
    if isinstance(value, list | tuple):
        return tuple(_freeze(item) for item in value)
    if isinstance(value, set | frozenset):
        return frozenset(_freeze(item) for item in value)
    return deepcopy(value)


def _thaw(value: Any) -> Any:
    """把冻结快照转回可 JSON 序列化的独立副本。"""
    if isinstance(value, Mapping):
        return {str(key): _thaw(item) for key, item in value.items()}
    if isinstance(value, tuple | list):
        return [_thaw(item) for item in value]
    if isinstance(value, set | frozenset):
        return sorted((_thaw(item) for item in value), key=repr)
    return deepcopy(value)


class SecretHandle:
    """只在 Provider 执行边界读取；repr 和公开快照不暴露值。"""

    __slots__ = ("_values",)

    def __init__(self, values: dict[str, str | None]):
        self._values = dict(values)

    def get(self, key: str, default: str | None = None) -> str | None:
        return self._values.get(key, default)

    def materialize(self) -> dict[str, str | None]:
        """Return a short-lived copy for the selected adapter execution boundary."""
        return dict(self._values)

    def __repr__(self) -> str:
        return "SecretHandle([REDACTED])"


@dataclass(frozen=True)
class ChatRouteRequest:
    """Provider 解析一次 Chat 路由所需的内部事实；不会进入公开日志。"""

    plugin_id: str
    provider_type: str
    model: str
    protocol_options: dict[str, Any]
    credentials: SecretHandle


@dataclass(frozen=True)
class ChatRouteEndpoint:
    """Provider 返回的公开端点与短期密钥句柄。"""

    base_url: str
    transport: str
    secrets: SecretHandle


class ChatRouteProvider(Protocol):
    """Chat Service Provider：解析端点，并为一次冻结路由创建协议客户端。"""

    def resolve(self, request: ChatRouteRequest) -> ChatRouteEndpoint: ...

    def open_client(self, route: PreparedChatRoute, timeout: float) -> Any: ...


@dataclass(frozen=True)
class _ChatProviderRegistration:
    """注册表里的一代 Provider 连同它声明的参数白名单，替换 / 卸载时一起换代。"""

    provider: ChatRouteProvider
    param_keys: frozenset[str]


def _policy_view(policy: ResolvedRetryPolicy) -> dict[str, Any]:
    view: dict[str, Any] = {"mode": policy.mode}
    if isinstance(policy, NormalRetryPolicy):
        view["max_retries"] = policy.max_retries
        view["retryable_codes"] = sorted(policy.retryable_codes)
    return view


@dataclass(frozen=True)
class ResolvedRouteSnapshot:
    capability: str
    operation: str
    selection_source: str
    deployment_id: int | None
    plugin_id: str
    plugin_version: str
    plugin_generation: int
    runtime_generation: int
    provider_type: str
    # 实际发给端点的模型名：经网关时是能力别名，直连时是上游真名
    model: str
    # 部署行上的上游真名；旧别名路由没有部署行时为 None。台账靠它显示真实模型
    upstream_model_id: str | None
    base_url: str
    transport: str
    # 部署协议参数 + 绑定调用参数（后者覆盖前者）；dispatch 只注入 param_keys 里的键
    protocol_options: Mapping[str, Any]
    param_keys: frozenset[str] = frozenset()
    retry_policy: ResolvedRetryPolicy = DEFAULT_CHAT_RETRY_POLICY
    # 主路由之后的候选（脱敏视图）；消费者按 deployment_id 重新 prepare 即可切换
    fallbacks: tuple[Mapping[str, Any], ...] = ()

    def view(self) -> dict[str, Any]:
        return {
            "capability": self.capability,
            "operation": self.operation,
            "selection_source": self.selection_source,
            "deployment_id": self.deployment_id,
            "plugin_id": self.plugin_id,
            "plugin_version": self.plugin_version,
            "plugin_generation": self.plugin_generation,
            "runtime_generation": self.runtime_generation,
            "provider_type": self.provider_type,
            "model": self.model,
            "upstream_model_id": self.upstream_model_id,
            "base_url": self.base_url,
            "transport": self.transport,
            "protocol_options": _thaw(self.protocol_options),
            "param_keys": sorted(self.param_keys),
            "retry_policy": _policy_view(self.retry_policy),
            "fallbacks": [_thaw(item) for item in self.fallbacks],
        }


@dataclass(frozen=True)
class PreparedChatRoute:
    """绑定某一 Provider 注册代际的不可变调用准备结果。"""

    snapshot: ResolvedRouteSnapshot
    secrets: SecretHandle
    _provider: ChatRouteProvider = field(repr=False, compare=False)

    def open_client(self, timeout: float) -> Any:
        """Create the protocol client owned by the provider frozen for this call."""
        return self._provider.open_client(self, timeout)

    def prepare_call(
        self,
        request: dict[str, Any],
        *,
        timeout: float,
        capability: str | None = None,
        client_factory: Callable[[PreparedChatRoute], Any] | None = None,
        coded_failures: bool = False,
        parent_invocation_id: str | None = None,
        attempt: int = 1,
    ) -> PreparedChatCall:
        """冻结一次请求；返回对象只允许 dispatch 一次。

        ``client_factory`` 只用于旧消费者的渐进迁移与测试注入；默认仍由
        当前路由冻结的 Provider 创建客户端。``coded_failures`` 打开后上游失败以
        :class:`ModelCallFailure` 抛出；``parent_invocation_id`` / ``attempt`` 把重试链
        写进台账。
        """
        return PreparedChatCall(
            route=self,
            request=deepcopy(request),
            timeout=timeout,
            capability=capability or self.snapshot.capability,
            client_factory=client_factory,
            coded_failures=coded_failures,
            parent_invocation_id=parent_invocation_id,
            attempt=attempt,
        )


class PreparedChatCall:
    """Chat Consumer 的一次性调用门面，统一台账、客户端和终态。"""

    def __init__(
        self,
        *,
        route: PreparedChatRoute,
        request: dict[str, Any],
        timeout: float,
        capability: str,
        client_factory: Callable[[PreparedChatRoute], Any] | None,
        coded_failures: bool = False,
        parent_invocation_id: str | None = None,
        attempt: int = 1,
    ) -> None:
        self.route = route
        self.request = request
        self.timeout = timeout
        self.capability = capability
        self._client_factory = client_factory
        self._coded = coded_failures
        self._parent_invocation_id = parent_invocation_id
        self._attempt = max(1, attempt)
        self._client: Any | None = None
        self._span: Any | None = None
        self._state = "prepared"
        # 从上游响应里观察到的事实：succeed 缺省就用它们，消费者不必再自己攒
        self._reported_model: str | None = None
        self._provider_request_id: str | None = None
        self._raw_usage: dict[str, Any] | None = None
        self._failure: LlmFailure | None = None
        self._ledger: ChunkEventBatcher | None = None

    @property
    def state(self) -> str:
        return self._state

    @property
    def reported_model(self) -> str | None:
        """上游响应回报的模型名；没收到时为 None。"""
        return self._reported_model

    @property
    def provider_request_id(self) -> str | None:
        return self._provider_request_id

    @property
    def raw_usage(self) -> dict[str, Any] | None:
        """线协议原样的 usage（最后一帧为准）。"""
        return self._raw_usage

    @property
    def failure(self) -> LlmFailure | None:
        """写入失败终态时归一出的失败事实。"""
        return self._failure

    @property
    def first_token_ms(self) -> int | None:
        return self._span.first_token_ms if self._span is not None else None

    @property
    def invocation_id(self) -> str | None:
        """这次尝试的台账 id；dispatch 之前为 None。"""
        return self._span.id if self._span is not None else None

    @property
    def attempt(self) -> int:
        return self._attempt

    def _coded_failure(self, exc: BaseException) -> BaseException:
        """coded 模式把上游失败换成带稳定码的 ModelCallFailure；取消 / 关流原样。"""
        if not self._coded or isinstance(exc, asyncio.CancelledError | GeneratorExit):
            return exc
        if isinstance(exc, ModelRuntimeError):
            return exc
        return ModelCallFailure(self._failure or chat_failure(exc))

    def _inject_params(self, kwargs: dict[str, Any]) -> dict[str, Any]:
        """按 Provider 白名单把路由参数补进请求；调用方显式给的键不动。返回实际注入的键值。"""
        options = self.route.snapshot.protocol_options
        injected: dict[str, Any] = {}
        for key in sorted(self.route.snapshot.param_keys):
            if key in kwargs:
                continue
            value = options.get(key)
            if value is None:
                continue
            injected[key] = _thaw(value)
        kwargs.update(injected)
        return injected

    def _note(self, payload: Any) -> None:
        """记下一帧（或整个响应）携带的模型名 / 请求 id / 用量。"""
        model = _attr(payload, "model")
        if model:
            self._reported_model = str(model)
        request_id = _attr(payload, "id")
        if request_id:
            self._provider_request_id = str(request_id)
        usage = _usage_dict(_attr(payload, "usage"))
        if usage is not None:
            self._raw_usage = usage

    async def _observed(self, raw: AsyncIterable[Any]) -> AsyncIterator[Any]:
        async for payload in raw:
            self._note(payload)
            yield payload

    async def stream_chunks(self, **kwargs: Any) -> AsyncIterator[StreamChunk]:
        """流式分发并翻译成内核 StreamChunk；首个可见 delta 的时刻记为 first_token_ms。

        上游抛出的异常先写失败终态（带失败码）再原样向上抛，调用方仍能按 SDK 异常类型分支。
        """
        response = await self.dispatch(**{**kwargs, "stream": True})
        snapshot = self.route.snapshot
        translated = translate_openai_chunks(
            self._observed(response), provider=snapshot.plugin_id, model=snapshot.model
        )
        ledger = ChunkEventBatcher(self._span) if self._span is not None else None
        # 消费者提前 break 时生成器的 finally 要等到回收才跑；终态写入前由 succeed / fail 先关账
        self._ledger = ledger
        try:
            async for chunk in translated:
                if self._span is not None and is_token_delta(chunk):
                    self._span.mark_first_token()
                if ledger is not None:
                    ledger.push(chunk)
                yield chunk
        except BaseException as exc:
            if isinstance(exc, asyncio.CancelledError):
                status = "cancelled"
            elif isinstance(exc, GeneratorExit):
                status = "abandoned"
            else:
                status = "failed"
            # 攒着的文本先落，error 事件才排在它后面
            if ledger is not None:
                ledger.close()
            await self.fail(exc, status=status)
            coded = self._coded_failure(exc)
            if coded is exc:
                raise
            raise coded from exc
        finally:
            if ledger is not None:
                ledger.close()
            aclose = getattr(translated, "aclose", None)
            if aclose is not None:
                await aclose()

    async def complete_chunks(self, **kwargs: Any) -> list[StreamChunk]:
        """非流式分发，翻译成与流式等价的 StreamChunk 序列。"""
        kwargs.pop("stream", None)
        response = await self.dispatch(**kwargs)
        self._note(response)
        if self._span is not None:
            self._span.mark_first_token()
        snapshot = self.route.snapshot
        chunks = translate_openai_response(
            response, provider=snapshot.plugin_id, model=snapshot.model
        )
        if self._span is not None:
            ledger = ChunkEventBatcher(self._span)
            for chunk in chunks:
                ledger.push(chunk)
            ledger.close()
        return chunks

    async def __aenter__(self) -> PreparedChatCall:
        return self

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        del exc_type, traceback
        if exc is not None and self._state in {"starting", "dispatched"}:
            if isinstance(exc, asyncio.CancelledError):
                status = "cancelled"
            elif isinstance(exc, GeneratorExit):
                status = "abandoned"
            else:
                status = "failed"
            await self.fail(exc, status=status)
        elif self._state == "dispatched":
            failure = ModelRuntimeError("Chat 调用已返回，但消费者未写入终态")
            await self.fail(failure, status="abandoned")
        await self._close_client()

    async def dispatch(self, **kwargs: Any) -> Any:
        """建立台账后发起唯一一次上游请求。"""
        if self._state != "prepared":
            raise ModelRuntimeError(f"Chat prepared call 不能重复执行：{self._state}")
        self._state = "starting"
        from domain.model_invocations import ModelInvocationSpan

        snapshot = self.route.snapshot
        injected = self._inject_params(kwargs)
        ledger_request = {**deepcopy(self.request), "route": snapshot.view()}
        if injected:
            ledger_request["params"] = injected
        self._span = await ModelInvocationSpan(
            plugin_id=snapshot.plugin_id,
            plugin_version=snapshot.plugin_version,
            plugin_generation=snapshot.plugin_generation,
            runtime_generation=snapshot.runtime_generation,
            operation=snapshot.operation,
            model=snapshot.model,
            capability=self.capability,
            deployment_id=snapshot.deployment_id,
            request=ledger_request,
            parent_invocation_id=self._parent_invocation_id,
            attempt=self._attempt,
        ).start()
        self._span.request_header(_request_header(kwargs, injected))
        try:
            self._client = (
                self._client_factory(self.route)
                if self._client_factory is not None
                else self.route.open_client(self.timeout)
            )
            response = await self._client.chat.completions.create(**kwargs)
        except BaseException as exc:
            status = "cancelled" if isinstance(exc, asyncio.CancelledError) else "failed"
            await self.fail(exc, status=status)
            coded = self._coded_failure(exc)
            if coded is exc:
                raise
            raise coded from exc
        self._state = "dispatched"
        return response

    async def succeed(
        self,
        *,
        model: str | None = None,
        response: dict[str, Any] | None = None,
        usage: dict[str, Any] | None = None,
        provider_request_id: str | None = None,
        first_token_ms: int | None = None,
    ) -> None:
        """写成功终态；模型名 / 用量 / 请求 id 不传就用从响应里观察到的。"""
        if self._state != "dispatched" or self._span is None:
            raise ModelRuntimeError(f"Chat 调用当前不能写入成功终态：{self._state}")
        if self._ledger is not None:
            self._ledger.close()
        await self._span.succeed(
            model=model or self._reported_model,
            response=response,
            usage=usage if usage is not None else self._raw_usage,
            provider_request_id=provider_request_id or self._provider_request_id,
            first_token_ms=first_token_ms,
        )
        self._state = "succeeded"

    async def fail(
        self, exc: BaseException, *, status: str = "failed", code: str | None = None
    ) -> None:
        """写失败终态；失败码缺省由 :func:`chat_failure` 归一。"""
        if self._state not in {"starting", "dispatched"} or self._span is None:
            return
        if self._ledger is not None:
            self._ledger.close()
        self._failure = chat_failure(exc)
        await self._span.fail(exc, status=status, code=code or self._failure.code)
        self._state = status

    async def _close_client(self) -> None:
        client, self._client = self._client, None
        if client is None:
            return
        close = getattr(client, "close", None)
        if close is None:
            return
        result = close()
        if inspect.isawaitable(result):
            await result


CHAT_PROVIDER_KIND = "model-chat-provider"
_chat_providers: PluginRegistry[_ChatProviderRegistration] = PluginRegistry(CHAT_PROVIDER_KIND)


def register_chat_route_provider(
    *,
    plugin_id: str,
    provider: ChatRouteProvider,
    operations: set[str] | frozenset[str],
    replace: bool = False,
    param_keys: frozenset[str] | set[str] | None = None,
) -> RegistrationHandle:
    """为模型插件登记真实 Chat Provider；句柄卸载后恢复上一代实现。

    ``param_keys`` 是该 Provider 允许从路由参数注入请求的键；缺省按 OpenAI 兼容线协议，
    不走线协议的（CLI 桥接）传空集合。
    """
    plugin = get_model_plugin(plugin_id)
    normalized = frozenset(value.strip().lower() for value in operations if value.strip())
    if not normalized:
        raise PluginRegistryError("Chat Provider 至少要声明一个操作")
    if not normalized <= plugin.ready_operations:
        raise PluginRegistryError(
            f"Chat Provider 操作必须属于模型插件 {plugin.id} 的 ready_operations"
        )
    manifest = PluginManifest(
        id=plugin.id,
        kind=CHAT_PROVIDER_KIND,
        name=f"{plugin.name} Chat Provider",
        version="1.0.0",
        capabilities=normalized,
    )
    registration = _ChatProviderRegistration(
        provider=provider,
        param_keys=(
            OPENAI_CHAT_PARAM_KEYS if param_keys is None else frozenset(param_keys)
        ),
    )
    return _chat_providers.register(manifest, registration, replace=replace)


def chat_route_provider_views() -> dict[str, dict[str, Any]]:
    """返回当前真实挂载的 Chat Provider，而不是模型插件的声明能力。"""
    return {
        item.manifest.id: {
            "chat_provider_operations": sorted(item.manifest.capabilities),
            "chat_runtime_generation": item.generation,
        }
        for item in _chat_providers.list()
    }


@asynccontextmanager
async def detached_session() -> AsyncIterator[AsyncSession]:
    from app.db import SessionFactory

    async with SessionFactory() as session:
        yield session


class _OpenAIChatProvider:
    def resolve(self, request: ChatRouteRequest) -> ChatRouteEndpoint:
        config = request.credentials.materialize()
        try:
            base_url = openai_base(config, request.provider_type)
        except CredentialError as exc:
            raise ModelRuntimeError(str(exc)) from exc
        return ChatRouteEndpoint(
            base_url=base_url,
            transport="openai-chat",
            secrets=SecretHandle({"api_key": config.get("api_key") or "not-required"}),
        )

    def open_client(self, route: PreparedChatRoute, timeout: float) -> AsyncOpenAI:
        return AsyncOpenAI(
            base_url=route.snapshot.base_url,
            api_key=route.secrets.get("api_key") or "not-required",
            timeout=timeout,
            max_retries=0,
            # openai 3.x 的类型桩按 httpx2 标注，运行期同样接受项目在用的 httpx 0.28 客户端
            http_client=gateway.http_client(timeout, route.snapshot.base_url),  # type: ignore[arg-type]
        )


class _CliChatCompletions:
    def __init__(self, route: PreparedChatRoute) -> None:
        self.route = route

    async def create(self, **kwargs):
        from domain import cli_bridge

        result = await cli_bridge.generate_chat(
            self.route.snapshot.provider_type,
            config={
                key: value
                for key, value in self.route.secrets.materialize().items()
                if value is not None
            },
            messages=list(kwargs.get("messages") or []),
            model=self.route.snapshot.model,
        )

        async def chunks():
            for start in range(0, len(result.text), 80):
                yield SimpleNamespace(
                    model=self.route.snapshot.model,
                    id=None,
                    usage=None,
                    choices=[
                        SimpleNamespace(
                            delta=SimpleNamespace(
                                content=result.text[start : start + 80],
                                tool_calls=[],
                            )
                        )
                    ],
                )

        return chunks()


class _CliChatClient:
    def __init__(self, route: PreparedChatRoute) -> None:
        self.chat = SimpleNamespace(completions=_CliChatCompletions(route))

    async def close(self) -> None:
        return None


class _CliChatProvider:
    def resolve(self, request: ChatRouteRequest) -> ChatRouteEndpoint:
        return ChatRouteEndpoint(
            base_url=f"local-cli://{request.plugin_id}",
            transport="cli-chat",
            secrets=request.credentials,
        )

    def open_client(self, route: PreparedChatRoute, timeout: float) -> _CliChatClient:
        del timeout
        return _CliChatClient(route)


def _secret_strings(values: dict[str, Any]) -> SecretHandle:
    return SecretHandle(
        {str(key): None if value is None else str(value) for key, value in values.items()}
    )


def _route_request(plugin_id: str, route: ResolvedModelRoute) -> ChatRouteRequest:
    return ChatRouteRequest(
        plugin_id=plugin_id,
        provider_type=route.provider_type,
        model=route.upstream_model_id,
        # 绑定上的调用参数压在部署协议参数之上：同一部署给不同能力用时各自有各自的采样设置
        protocol_options={**route.protocol_options, **route.params},
        credentials=_secret_strings(route.credential_config),
    )


def _route_retry_policy(route: ResolvedModelRoute) -> ResolvedRetryPolicy:
    raw = route.protocol_options.get("retry_policy")
    if raw is None:
        return DEFAULT_CHAT_RETRY_POLICY
    if not isinstance(raw, Mapping):
        raise ModelRuntimeError("retry_policy 必须是对象")
    try:
        return resolve_retry_policy(raw)
    except RetryPolicyError as exc:
        raise ModelRuntimeError(str(exc)) from exc


async def prepare_chat_route(
    capability: str,
    operation: str,
    *,
    deployment_id: int | None = None,
    selection_source: str | None = None,
) -> PreparedChatRoute:
    """冻结模型插件、Chat Provider 代际、模型、端点、公开协议配置和 fallback 候选。

    ``selection_source`` 由编排层在切换候选时传 ``"fallback"``：按 deployment_id 重新
    prepare 的候选在目录里看是"显式部署"，台账上要记成它真实的来历。
    """
    normalized_operation = operation.strip().lower()
    try:
        async with detached_session() as session:
            candidates = await resolve_model_candidates(
                session,
                capability,
                deployment_id=deployment_id,
            )
    except (CredentialError, ModelCatalogError) as exc:
        raise ModelRuntimeError(str(exc)) from exc
    if not candidates:
        raise ModelRuntimeError(unbound_capability_message(capability))
    route = candidates[0]
    plugin_id = route.adapter_type
    try:
        plugin = get_model_plugin(plugin_id)
        runtime = _chat_providers.resolve(
            normalized_operation,
            preferred_id=plugin.id,
        )
    except (ValueError, PluginRegistryError) as exc:
        raise ModelRuntimeError(
            f"模型插件 {plugin_id} 没有可用的 {normalized_operation} Provider"
        ) from exc
    if not plugin.supports(normalized_operation):
        raise ModelRuntimeError(f"模型插件 {plugin.id} 不支持操作：{normalized_operation}")
    if not plugin.is_ready(normalized_operation):
        raise ModelRuntimeError(f"模型插件 {plugin.id} 的 {normalized_operation} 尚未接入执行")

    request = _route_request(plugin.id, route)
    registration = runtime.implementation
    endpoint = registration.provider.resolve(request)
    if not endpoint.base_url.strip() or not endpoint.transport.strip():
        raise ModelRuntimeError(f"模型插件 {plugin.id} 返回了无效 Chat 端点")
    version, generation = model_plugin_identity(plugin.id)
    if selection_source is None:
        selection_source = route.source
    snapshot = ResolvedRouteSnapshot(
        capability=capability,
        operation=normalized_operation,
        selection_source=selection_source,
        deployment_id=route.deployment_id,
        plugin_id=plugin.id,
        plugin_version=version,
        plugin_generation=generation,
        runtime_generation=runtime.generation,
        provider_type=request.provider_type,
        model=request.model,
        upstream_model_id=route.upstream_model_id,
        base_url=endpoint.base_url,
        transport=endpoint.transport,
        protocol_options=_freeze(request.protocol_options),
        param_keys=registration.param_keys,
        retry_policy=_route_retry_policy(route),
        fallbacks=tuple(_freeze(item.view()) for item in route.fallbacks),
    )
    return PreparedChatRoute(
        snapshot=snapshot,
        secrets=endpoint.secrets,
        _provider=registration.provider,
    )


_BUILTIN_CHAT_PROVIDER_HANDLES = (
    register_chat_route_provider(
        plugin_id="openai",
        provider=_OpenAIChatProvider(),
        operations={"chat.complete", "chat.stream"},
    ),
    register_chat_route_provider(
        plugin_id="codex",
        provider=_CliChatProvider(),
        operations={"chat.stream"},
        param_keys=frozenset(),
    ),
    register_chat_route_provider(
        plugin_id="gemini-cli",
        provider=_CliChatProvider(),
        operations={"chat.stream"},
        param_keys=frozenset(),
    ),
)
