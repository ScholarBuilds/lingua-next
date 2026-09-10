"""审批席位：把 pre-execute 的 ``ask`` 决策交给答复者链裁决。

翻译自 deepseek-harness ``packages/interaction/user-approval/src/index.ts``：
:30 ``'approval/request'`` waterfall 签名、:153-192 ApprovalRequest 与策略、
:257-331 request/decide（``never`` 策略先于任何答复者、取消竞争、fail-closed
``unavailable``）。

未搬的部分：会话审计事件对（approval/asked、approval/decided）、系统提示词里的策略
陈述、以及"必须在开启的 turn 内提问"的检查——这些依赖 session 日志，由接线阶段补。
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal, Protocol

from domain.kernel.events import EventBus, ScopeKey

if TYPE_CHECKING:
    from domain.kernel.tool_runtime import ToolRunContext

logger = logging.getLogger(__name__)

ApprovalOutcome = Literal["allowed-once", "rejected", "cancelled", "unavailable"]
APPROVAL_OUTCOMES: frozenset[str] = frozenset(
    {"allowed-once", "rejected", "cancelled", "unavailable"}
)

ApprovalPolicy = Literal["ask", "never"]
APPROVAL_POLICIES: tuple[ApprovalPolicy, ...] = ("ask", "never")


@dataclass(frozen=True)
class ApprovalRequest:
    """一次只读的同进程审批问题。``call_id`` 对应 UI 已经呈现过的工具调用，参数不重复携带；
    ``cancel`` 触发即撤回问题，迟到的答复被丢弃。"""

    tool_name: str
    call_id: str
    reason: str
    scope: ScopeKey | None
    agent_id: str | None
    cancel: asyncio.Event


class ApprovalService(Protocol):
    """ToolRuntime 消费的审批席位。``allowed-once`` 是唯一的放行结果。"""

    async def request(self, exec: ToolRunContext, reason: str) -> ApprovalOutcome: ...


async def _unavailable(*_: Any) -> ApprovalOutcome:
    return "unavailable"


class DefaultApproval:
    """基于 ``approval/request`` waterfall 的默认席位。

    - ``policy='ask'``：交给答复者链；没有答复者、答复者抛错或返回词汇表之外的值，
      一律 fail closed 为 ``unavailable``。
    - ``policy='never'``：不问任何人，确定性地 ``rejected``（CI / 无人值守）。
      在分发之前就决定，prepend 注册的答复者也绕不过去。
    - 请求的 ``cancel`` 事件与答复竞争：取消先到则 ``cancelled``，迟到的答复丢弃。
    """

    def __init__(self, bus: EventBus, *, policy: ApprovalPolicy = "ask") -> None:
        self.bus = bus
        self._policy: ApprovalPolicy = "ask"
        self.policy = policy
        self._pending: set[asyncio.Task[Any]] = set()

    @property
    def policy(self) -> ApprovalPolicy:
        return self._policy

    @policy.setter
    def policy(self, value: ApprovalPolicy) -> None:
        if value not in APPROVAL_POLICIES:
            raise ValueError(f"approval policy 必须是 {APPROVAL_POLICIES} 之一，收到 {value!r}")
        self._policy = value

    async def request(self, exec: ToolRunContext, reason: str) -> ApprovalOutcome:
        req = ApprovalRequest(
            tool_name=exec.name,
            call_id=exec.call_id,
            reason=reason,
            scope=exec.scope,
            agent_id=exec.agent_id,
            cancel=exec.cancel,
        )
        if req.cancel.is_set():
            return "cancelled"
        if self._policy == "never":
            return "rejected"
        answer = asyncio.create_task(self._ask(req))
        waiter = asyncio.create_task(req.cancel.wait())
        racers: set[asyncio.Future[Any]] = {answer, waiter}
        try:
            done, _ = await asyncio.wait(racers, return_when=asyncio.FIRST_COMPLETED)
        except BaseException:
            answer.cancel()
            raise
        finally:
            waiter.cancel()
        if answer in done:
            return answer.result()
        # 取消赢了竞争：不强杀答复者，挂在 _pending 上等它自然结束，结果直接丢弃
        self._pending.add(answer)
        answer.add_done_callback(self._pending.discard)
        return "cancelled"

    async def _ask(self, req: ApprovalRequest) -> ApprovalOutcome:
        try:
            outcome = await self.bus.waterfall(
                "approval/request", req, scope=req.scope, terminal=_unavailable
            )
        except Exception:
            logger.exception(
                'approval/request 答复者抛出异常（tool "%s"），按 unavailable 处理', req.tool_name
            )
            return "unavailable"
        if outcome not in APPROVAL_OUTCOMES:
            logger.warning(
                'approval/request 答复者返回了词汇表之外的值 %r（tool "%s"），按 unavailable 处理',
                outcome,
                req.tool_name,
            )
            return "unavailable"
        result: ApprovalOutcome = outcome
        return result


__all__ = [
    "APPROVAL_OUTCOMES",
    "APPROVAL_POLICIES",
    "ApprovalOutcome",
    "ApprovalPolicy",
    "ApprovalRequest",
    "ApprovalService",
    "DefaultApproval",
]
