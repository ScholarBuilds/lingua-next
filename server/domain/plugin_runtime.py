"""轻量插件注册内核。

注册是可撤销的运行时效果：替换插件被卸载后，先前实现自动恢复。业务层只依赖
``kind + capability`` 合同，不依赖具体提供者。该内核不负责动态导入、热更新或
依赖注入；这些能力等真实插件包出现后再沿同一合同扩展。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from threading import RLock
from typing import Any

_ID_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$")


class PluginRegistryError(ValueError):
    pass


@dataclass(frozen=True)
class PluginManifest:
    id: str
    kind: str
    name: str
    version: str
    description: str = ""
    capabilities: frozenset[str] = frozenset()
    priority: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        plugin_id = self.id.strip().lower()
        if not _ID_PATTERN.fullmatch(plugin_id):
            raise PluginRegistryError(f"插件 id 不合法：{self.id}")
        if not self.kind.strip() or not self.name.strip() or not self.version.strip():
            raise PluginRegistryError("插件 kind、name、version 不能为空")
        capabilities = frozenset(
            value.strip().lower() for value in self.capabilities if value.strip()
        )
        object.__setattr__(self, "id", plugin_id)
        object.__setattr__(self, "kind", self.kind.strip().lower())
        object.__setattr__(self, "name", self.name.strip())
        object.__setattr__(self, "version", self.version.strip())
        object.__setattr__(self, "capabilities", capabilities)
        object.__setattr__(self, "metadata", dict(self.metadata))

    def view(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "name": self.name,
            "version": self.version,
            "description": self.description,
            "capabilities": sorted(self.capabilities),
            "priority": self.priority,
            "metadata": dict(self.metadata),
        }


@dataclass(frozen=True)
class PluginRegistration[T]:
    manifest: PluginManifest
    implementation: T
    generation: int


class RegistrationHandle:
    """幂等卸载句柄；旧实现被覆盖时，旧句柄不会误删当前实现。"""

    def __init__(self, registry: PluginRegistry[Any], registration: PluginRegistration[Any]):
        self._registry = registry
        self._registration = registration
        self._disposed = False

    @property
    def disposed(self) -> bool:
        return self._disposed

    def dispose(self) -> None:
        if self._disposed:
            return
        if self._registry._dispose(self._registration):
            self._disposed = True


class PluginRegistry[T]:
    """按插件类型隔离的注册表，支持能力解析和可逆覆盖。"""

    def __init__(self, kind: str):
        self.kind = kind.strip().lower()
        if not self.kind:
            raise PluginRegistryError("注册表类型不能为空")
        self._stacks: dict[str, list[PluginRegistration[T]]] = {}
        self._generation = 0
        self._lock = RLock()

    def register(
        self,
        manifest: PluginManifest,
        implementation: T,
        *,
        replace: bool = False,
    ) -> RegistrationHandle:
        if manifest.kind != self.kind:
            raise PluginRegistryError(f"插件类型 {manifest.kind} 与注册表类型 {self.kind} 不一致")
        with self._lock:
            stack = self._stacks.setdefault(manifest.id, [])
            if stack and not replace:
                raise PluginRegistryError(f"插件已注册：{manifest.id}")
            self._generation += 1
            registration = PluginRegistration(manifest, implementation, self._generation)
            stack.append(registration)
        return RegistrationHandle(self, registration)

    def _dispose(self, registration: PluginRegistration[Any]) -> bool:
        with self._lock:
            stack = self._stacks.get(registration.manifest.id)
            if not stack or stack[-1] is not registration:
                return False
            stack.pop()
            if not stack:
                self._stacks.pop(registration.manifest.id, None)
            return True

    def get(self, plugin_id: str) -> PluginRegistration[T] | None:
        with self._lock:
            stack = self._stacks.get(plugin_id.strip().lower())
            return stack[-1] if stack else None

    def require(self, plugin_id: str) -> PluginRegistration[T]:
        registration = self.get(plugin_id)
        if registration is None:
            raise PluginRegistryError(f"插件未注册：{plugin_id}")
        return registration

    def list(self) -> list[PluginRegistration[T]]:
        with self._lock:
            registrations = [stack[-1] for stack in self._stacks.values() if stack]
        return sorted(
            registrations,
            key=lambda item: (-item.manifest.priority, item.manifest.id),
        )

    def resolve(
        self,
        capability: str,
        *,
        preferred_id: str | None = None,
    ) -> PluginRegistration[T]:
        normalized = capability.strip().lower()
        if preferred_id:
            preferred = self.require(preferred_id)
            if normalized not in preferred.manifest.capabilities:
                raise PluginRegistryError(f"插件 {preferred.manifest.id} 不提供能力：{normalized}")
            return preferred
        for registration in self.list():
            if normalized in registration.manifest.capabilities:
                return registration
        raise PluginRegistryError(f"没有插件提供能力：{normalized}")
