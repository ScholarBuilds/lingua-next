"""泛型能力缝：Provider 注册表 + 冻结路由 + 记账模板。

五份手写 ``Prepared*Route``（chat / image / video / audio / workflow）结构同构：
注册表按 plugin_id 压栈、``prepare`` 冻结 Provider 实例与运行时代际、Provider 内部
"start → 业务 → succeed/fail" 三步记账。这里把共性抽成一个泛型，新接一条能力只需
写 Provider 协议与路由便捷方法；ASR / 实时语音 / 音素 / Midjourney 先走这里，
既有五份留待逐个迁移。

``ready_source`` 是该 seam 在模型插件目录里的"已接线"事实源名字：
``ModelPlugin.is_ready`` 不再读手写声明，而是聚合各 seam 注册表。
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Collection, Mapping
from copy import deepcopy
from dataclasses import dataclass, field
from types import MappingProxyType, TracebackType
from typing import Any, Protocol, Self, cast

from domain.model_catalog import ResolvedModelRoute
from domain.model_invocations import ModelInvocationSpan
from domain.model_plugins import (
    get_model_plugin,
    model_plugin_identity,
    register_ready_operations_source,
)
from domain.plugin_runtime import (
    PluginManifest,
    PluginRegistration,
    PluginRegistry,
    PluginRegistryError,
    RegistrationHandle,
)


class SeamError(PluginRegistryError):
    """路由准备失败：插件不存在、操作未声明或没有已接线 Provider。"""

    def __init__(self, kind: str, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.kind = kind
        self.retryable = retryable


class SeamRequest(Protocol):
    """prepare 的输入合同：只读身份字段 + 凭据与协议参数（准备时深拷贝）。"""

    @property
    def capability(self) -> str: ...

    @property
    def plugin_id(self) -> str: ...

    @property
    def provider_type(self) -> str: ...

    @property
    def model(self) -> str: ...

    @property
    def credentials(self) -> Mapping[str, Any]: ...

    @property
    def protocol_options(self) -> Mapping[str, Any]: ...

    @property
    def deployment_id(self) -> int | None: ...


@dataclass(frozen=True)
class RouteRequest:
    """通用路由请求；本地推理类插件没有凭据与部署，留默认值即可。"""

    capability: str
    plugin_id: str
    provider_type: str
    model: str
    credentials: dict[str, Any] = field(default_factory=dict)
    protocol_options: dict[str, Any] = field(default_factory=dict)
    deployment_id: int | None = None

    @classmethod
    def from_model_route(cls, capability: str, route: ResolvedModelRoute) -> RouteRequest:
        return cls(
            capability=capability,
            plugin_id=route.adapter_type,
            provider_type=route.provider_type,
            model=route.upstream_model_id,
            credentials=route.credential_config,
            protocol_options=route.protocol_options,
            deployment_id=route.deployment_id,
        )


@dataclass(frozen=True)
class RouteSnapshot:
    """脱敏快照：进台账与日志，不带凭据。"""

    capability: str
    operation: str
    deployment_id: int | None
    plugin_id: str
    plugin_version: str
    plugin_generation: int
    runtime_generation: int
    provider_type: str
    model: str

    def view(self) -> dict[str, Any]:
        return {
            "capability": self.capability,
            "operation": self.operation,
            "deployment_id": self.deployment_id,
            "plugin_id": self.plugin_id,
            "plugin_version": self.plugin_version,
            "plugin_generation": self.plugin_generation,
            "runtime_generation": self.runtime_generation,
            "provider_type": self.provider_type,
            "model": self.model,
        }


class RouteSpan:
    """三步记账模板：进入即 start，正常退出 succeed，异常 fail（CancelledError 记 cancelled）。

    ``finish`` 只暂存结果，终态在退出时一次写入；异常对象按抛出时的类型入账，
    Provider 要换成领域异常应在 ``async with`` 之外做，台账里才留得住原因。
    """

    def __init__(self, span: ModelInvocationSpan) -> None:
        self.inner = span
        self._outcome: dict[str, Any] = {}

    @property
    def id(self) -> str:
        return self.inner.id

    def mark_first_token(self) -> int:
        return self.inner.mark_first_token()

    def finish(
        self,
        *,
        model: str | None = None,
        response: dict[str, Any] | None = None,
        usage: dict[str, Any] | None = None,
        provider_request_id: str | None = None,
        first_token_ms: int | None = None,
    ) -> None:
        self._outcome = {
            "model": model,
            "response": response,
            "usage": usage,
            "provider_request_id": provider_request_id,
            "first_token_ms": first_token_ms,
        }

    async def __aenter__(self) -> Self:
        await self.inner.start()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        if exc is None:
            await self.inner.succeed(**self._outcome)
            return
        status = "cancelled" if isinstance(exc, asyncio.CancelledError) else "failed"
        await self.inner.fail(exc, status=status)


@dataclass(frozen=True)
class PreparedRoute[Snapshot: RouteSnapshot, Provider]:
    """冻结后的路由：Provider 实例、代际与凭据在准备时定格，之后替换 Provider 不影响它。"""

    snapshot: Snapshot
    _credentials: dict[str, Any] = field(repr=False, compare=False)
    _protocol_options: dict[str, Any] = field(repr=False, compare=False)
    _provider: Provider = field(repr=False, compare=False)

    @property
    def provider(self) -> Provider:
        return self._provider

    @property
    def credentials(self) -> Mapping[str, Any]:
        return MappingProxyType(self._credentials)

    @property
    def protocol_options(self) -> Mapping[str, Any]:
        return MappingProxyType(self._protocol_options)

    def new_span(
        self,
        *,
        request: dict[str, Any] | None = None,
        model: str | None = None,
        capability: str | None = None,
        operation: str | None = None,
        parent_invocation_id: str | None = None,
        attempt: int = 1,
    ) -> ModelInvocationSpan:
        """未启动的台账 span：插件 id / 版本 / 代际全部来自快照，调用方只填业务字段。"""
        snapshot = self.snapshot
        return ModelInvocationSpan(
            plugin_id=snapshot.plugin_id,
            plugin_version=snapshot.plugin_version,
            plugin_generation=snapshot.plugin_generation,
            runtime_generation=snapshot.runtime_generation,
            operation=operation or snapshot.operation,
            model=snapshot.model if model is None else model,
            capability=capability or snapshot.capability,
            deployment_id=snapshot.deployment_id,
            request=request,
            parent_invocation_id=parent_invocation_id,
            attempt=attempt,
        )

    def span(
        self,
        *,
        request: dict[str, Any] | None = None,
        model: str | None = None,
        capability: str | None = None,
        operation: str | None = None,
        parent_invocation_id: str | None = None,
        attempt: int = 1,
    ) -> RouteSpan:
        return RouteSpan(
            self.new_span(
                request=request,
                model=model,
                capability=capability,
                operation=operation,
                parent_invocation_id=parent_invocation_id,
                attempt=attempt,
            )
        )


class CapabilitySeam[Req: SeamRequest, Snapshot: RouteSnapshot, Provider]:
    """一条能力的 Provider 注册表与路由准备入口。

    ``kind`` 是注册表类型（同一进程内唯一），``label`` 只用于报错与 manifest 命名。
    ``snapshot_factory`` 让 seam 在通用身份字段之外再冻结自己的字段，缺省直接用
    :class:`RouteSnapshot`。
    """

    def __init__(
        self,
        kind: str,
        *,
        label: str,
        ready_source: str | None = None,
        snapshot_factory: Callable[[Req, RouteSnapshot], Snapshot] | None = None,
    ) -> None:
        self.kind = kind.strip().lower()
        self.label = label.strip()
        if not self.label:
            raise PluginRegistryError("seam label 不能为空")
        self._registry: PluginRegistry[Provider] = PluginRegistry(self.kind)
        self._snapshot_factory = snapshot_factory
        self._detach_ready_source: Callable[[], None] | None = None
        if ready_source:
            self._detach_ready_source = register_ready_operations_source(
                ready_source, self.provider_operations
            )

    def detach_ready_source(self) -> None:
        """把本 seam 从"已接线"聚合里摘掉；测试里临时 seam 用完要调。"""
        if self._detach_ready_source is not None:
            self._detach_ready_source()
            self._detach_ready_source = None

    def register(
        self,
        *,
        plugin_id: str,
        provider: Provider,
        operations: Collection[str],
        priority: int = 0,
        replace: bool = False,
    ) -> RegistrationHandle:
        """登记可撤销 Provider；替换句柄卸载后恢复上一代实现。

        操作必须在模型插件声明的 ``operations`` 之内——声明是上限，接线才算 ready。
        """
        plugin = get_model_plugin(plugin_id)
        normalized = frozenset(value.strip().lower() for value in operations if value.strip())
        if not normalized:
            raise PluginRegistryError(f"{self.label} Provider 至少要声明一个操作")
        if not normalized <= plugin.operations:
            raise PluginRegistryError(
                f"{self.label} Provider 操作必须属于模型插件 {plugin.id} 声明的 operations："
                f"{sorted(normalized - plugin.operations)}"
            )
        manifest = PluginManifest(
            id=plugin.id,
            kind=self.kind,
            name=f"{plugin.name} {self.label} Provider",
            version="1.0.0",
            capabilities=normalized,
            priority=priority,
        )
        return self._registry.register(manifest, provider, replace=replace)

    def resolve(
        self,
        operation: str,
        *,
        preferred_id: str | None = None,
    ) -> PluginRegistration[Provider]:
        return self._registry.resolve(operation, preferred_id=preferred_id)

    def generation(self, plugin_id: str) -> int | None:
        registration = self._registry.get(plugin_id)
        return registration.generation if registration is not None else None

    def provider_operations(self) -> dict[str, frozenset[str]]:
        """plugin_id → 当前已接线操作；是模型插件目录 ``ready_operations`` 的事实源。"""
        return {
            item.manifest.id: item.manifest.capabilities for item in self._registry.list()
        }

    def views(self, prefix: str) -> dict[str, dict[str, Any]]:
        """``/config/model-plugins`` 用的视图，键名与既有五条 seam 同形。"""
        return {
            item.manifest.id: {
                f"{prefix}_provider_operations": sorted(item.manifest.capabilities),
                f"{prefix}_runtime_generation": item.generation,
            }
            for item in self._registry.list()
        }

    def prepare(self, request: Req, operation: str) -> PreparedRoute[Snapshot, Provider]:
        return self.prepare_as(PreparedRoute, request, operation)

    def prepare_as[Route: PreparedRoute[Any, Any]](
        self,
        route_cls: type[Route],
        request: Req,
        operation: str,
    ) -> Route:
        """解析插件与 Provider，冻结成 ``route_cls`` 实例（各 seam 的便捷子类）。"""
        normalized_operation = operation.strip().lower()
        try:
            plugin = get_model_plugin(request.plugin_id)
        except PluginRegistryError as exc:
            raise SeamError("binding", f"模型插件不存在：{request.plugin_id}") from exc
        if not plugin.supports(normalized_operation):
            raise SeamError(
                "binding", f"模型插件 {plugin.id} 未声明操作 {normalized_operation}"
            )
        try:
            runtime = self._registry.resolve(normalized_operation, preferred_id=plugin.id)
        except PluginRegistryError as exc:
            raise SeamError(
                "binding",
                f"模型插件 {plugin.id} 的 {normalized_operation} 尚未接入执行"
                f"（没有 {self.label} Provider）",
            ) from exc
        version, generation = model_plugin_identity(plugin.id)
        identity = RouteSnapshot(
            capability=request.capability,
            operation=normalized_operation,
            deployment_id=request.deployment_id,
            plugin_id=plugin.id,
            plugin_version=version,
            plugin_generation=generation,
            runtime_generation=runtime.generation,
            provider_type=request.provider_type,
            model=request.model,
        )
        # 没有定制工厂时 Snapshot 就是 RouteSnapshot 本身，这里的 cast 只是告诉类型系统
        snapshot = (
            self._snapshot_factory(request, identity)
            if self._snapshot_factory is not None
            else cast(Snapshot, identity)
        )
        return route_cls(
            snapshot=snapshot,
            _credentials=deepcopy(dict(request.credentials)),
            _protocol_options=deepcopy(dict(request.protocol_options)),
            _provider=runtime.implementation,
        )


__all__ = [
    "CapabilitySeam",
    "PreparedRoute",
    "RouteRequest",
    "RouteSnapshot",
    "RouteSpan",
    "SeamError",
    "SeamRequest",
]
