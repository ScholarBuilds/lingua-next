"""进程级内核单例：事件总线 + LLM 运行时 + 工具运行时 + 审批席位。

API 进程与 arq worker 都 import 这里的 ``kernel``。构造只在内存里建对象，不连库、
不发网络、不注册任何业务工具——业务工具由各自模块按需注册进命名作用域
（见 ``domain.agent_tools``）。

作用域键由 :class:`Scopes` 铸造（``label#seq``），业务层拿到的是稳定名字到键的映射：
``kernel.scope("gpt-creative")`` 首次调用创建，之后始终返回同一个键。
"""

from __future__ import annotations

from domain.kernel.approval import ApprovalPolicy, DefaultApproval
from domain.kernel.events import EventBus, ScopeKey
from domain.kernel.llm_runtime import LlmRuntime
from domain.kernel.tool_runtime import ToolRuntime


class Kernel:
    """四件套的持有者；``bus`` / ``llm`` / ``tools`` / ``approval`` 共用同一套作用域。"""

    def __init__(
        self,
        bus: EventBus,
        llm: LlmRuntime,
        tools: ToolRuntime,
        approval: DefaultApproval,
    ) -> None:
        if llm.bus is not bus or tools.bus is not bus or approval.bus is not bus:
            raise ValueError("Kernel 的 llm / tools / approval 必须挂在同一个 EventBus 上")
        self.bus = bus
        self.llm = llm
        self.tools = tools
        self.approval = approval
        self._named_scopes: dict[str, ScopeKey] = {}

    def scope(self, name: str, *, parent: str | None = None) -> ScopeKey:
        """按名字取稳定作用域键；首次调用创建（``parent`` 也按名字解析）。

        同名作用域被 ``dispose`` 之后再取会重新创建一个新键。
        """
        if not name:
            raise ValueError("作用域名字不能为空")
        key = self._named_scopes.get(name)
        if key is not None and key in self.bus.scopes:
            return key
        parent_key = self.scope(parent) if parent is not None else None
        key = self.bus.scopes.create(parent_key, label=name)
        self._named_scopes[name] = key
        return key

    def scope_name(self, key: ScopeKey) -> str | None:
        """作用域键 → 注册时用的名字；未命名的键返回 ``None``。"""
        for name, candidate in self._named_scopes.items():
            if candidate == key:
                return name
        return None


def build_kernel(*, approval_policy: ApprovalPolicy = "ask") -> Kernel:
    """组装一套全新的内核；测试与隔离场景用，生产代码走 :func:`get_kernel`。"""
    bus = EventBus()
    approval = DefaultApproval(bus, policy=approval_policy)
    return Kernel(
        bus=bus,
        llm=LlmRuntime(bus),
        tools=ToolRuntime(bus, approval),
        approval=approval,
    )


kernel: Kernel = build_kernel()


def get_kernel() -> Kernel:
    """进程级单例。"""
    return kernel


__all__ = ["Kernel", "build_kernel", "get_kernel", "kernel"]
