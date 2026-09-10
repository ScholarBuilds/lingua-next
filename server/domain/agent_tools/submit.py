"""长任务工具的公共接线：把注册表里的能力包成「提交拿 task_id」的对话工具。

与 :mod:`domain.agent_tools.image_generate` 的分工：那个工具当场出图、当场入库，一轮
之内就能把图贴回对话；这里的编辑、视频、工作流都要 worker 跑几十秒到几分钟，工具体
只负责**提交**——建任务、入队、把 task_id 交回去。产物与进度由任务中心那条既有事件流
回传，工具里同步轮询会把整条 SSE 卡死，模型也拿不到中间状态。

三条底线：

- **合同只有一份**：入参 schema 从 ``tool_execution`` 的 ``@tool_operation`` 注册表派生，
  校验也只在那里做一次（``parse_tool_operation_input``）。声明里少掉的字段是宿主代填的
  事实（部署、凭据、上传字节）或对话里给不出来的旧写法，不是另一份放松过的合同；注册表
  给某个能力加了字段，这里的工具声明自动跟着多一项。
- **提交走统一执行器**：``start_tool_operation`` 建任务、冻结插件快照、入队，与 REST、
  画布、DAG、MCP 同一条路，台账里按 tool_id / source_route 就能把这次调用捞出来。
- **失败原样回给模型**：任何一步炸了都抛 :class:`AgentToolError`，由 ToolRuntime 落成
  is_error 结果，对话循环把它转成 tool 消息——模型据此换个说法重试，而不是干等。
"""

from __future__ import annotations

import copy
import json
from collections.abc import Awaitable, Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, ConfigDict, create_model
from sqlalchemy.ext.asyncio import AsyncSession

from domain import tool_plugins
from domain.kernel.llm_types import ContentBlock, TextBlock
from domain.kernel.tool_runtime import ToolDefinition, ToolRunContext, tool
from domain.model_invocations import invocation_context
from domain.models import StudioTask
from domain.tool_execution import (
    parse_tool_operation_input,
    require_operation,
    start_tool_operation,
)

# 对话代理自己的插件 id；能力归属优先记在它名下
AGENT_PLUGIN_ID = "gpt-creative"
# 台账里的来源标记，与画布的 studio.canvas.llm 同一套命名
SOURCE = "studio.gpt.agent"

# 同一能力被多个插件声明时的挑选顺序：真正接线好的排前面
_STATUS_RANK = {"ready": 0, "beta": 1, "planned": 2}


class AgentToolError(RuntimeError):
    """面向模型的失败：消息会原样进 tool 结果，写成模型能据此改参数的话。"""


@dataclass(frozen=True)
class TaskToolTurn:
    """一轮对话里长任务工具可用的宿主事实。

    队列不在这里拿：整轮不调长任务工具时不该去碰 arq，所以由 :func:`acquire_queue`
    在真要提交时才取。
    """

    session: AsyncSession
    chat_id: int
    image_deployment_id: int | None = None

    @property
    def source_route(self) -> str:
        return f"/studio/gpt-chats/{self.chat_id}/send"


_turn: ContextVar[TaskToolTurn | None] = ContextVar("agent_task_turn", default=None)


@contextmanager
def bind_turn(
    session: AsyncSession,
    *,
    chat_id: int,
    image_deployment_id: int | None = None,
) -> Iterator[None]:
    """在 ``with`` 块内把本轮的会话与所选部署交给长任务工具体。"""
    token = _turn.set(
        TaskToolTurn(
            session=session,
            chat_id=chat_id,
            image_deployment_id=image_deployment_id,
        )
    )
    try:
        yield
    finally:
        _turn.reset(token)


def current_turn() -> TaskToolTurn | None:
    return _turn.get()


def require_turn(tool_name: str) -> TaskToolTurn:
    turn = _turn.get()
    if turn is None:
        raise AgentToolError(f"{tool_name} 只能在绑定了会话的对话回合内执行")
    return turn


async def acquire_queue() -> Any:
    """取 arq 队列。单独抽成函数是给测试留的接缝，与 MCP 出口同一种写法。"""
    from app.queue import get_queue

    return await get_queue()


class SubmittedTask(BaseModel):
    """一次提交的回执。

    产物不在这里：任务还在排队，图片 / 视频 / 工作流产出由任务中心那条事件流带回来。
    """

    task_id: str
    operation: str
    tool_id: str
    status: str
    label: str
    # DAG 运行 id；只有 flow.run 这类自带运行记录的能力才有
    run_id: str | None = None


def owner_plugin_id(operation: str) -> str:
    """这次提交记在哪个工具插件名下。

    对话代理自己声明了这项能力就记自己名下；还没声明时退到已声明该能力、状态最靠前的
    那个插件——``require_tool_operation`` 只认插件声明过的能力，退不了连提交都提交不了。
    工具目录把这几项能力划给 gpt-creative 之后，这里自动改记对话代理自己。
    """
    normalized = operation.strip().lower()
    candidates = [
        item for item in tool_plugins.list_tool_plugins() if normalized in item["capabilities"]
    ]
    if not candidates:
        raise AgentToolError(f"没有工具插件声明能力 {normalized}，先在工具目录里认领它")
    if any(item["id"] == AGENT_PLUGIN_ID for item in candidates):
        return AGENT_PLUGIN_ID
    candidates.sort(key=lambda item: (_STATUS_RANK.get(str(item["status"]), 9), str(item["id"])))
    return str(candidates[0]["id"])


# ---- 入参：按注册表合同派生 ----


def derive_args_model(
    name: str,
    operation: str,
    *,
    withheld: Mapping[str, str],
    describe: Mapping[str, str] | None = None,
    narrow: Mapping[str, dict[str, Any]] | None = None,
    extra: Mapping[str, tuple[Any, Any]] | None = None,
) -> type[BaseModel]:
    """按能力的注册表合同派生对话版入参模型。

    ``withheld`` 是不发给模型的字段（键是字段名，值是原因，只为让这份名单自解释）：
    要么由宿主在执行时代填，要么在对话里根本给不出来。名单里出现合同上没有的字段直接
    报错——上游改名时宁可当场炸，也不要悄悄把一个新字段漏给模型。

    其余字段连同约束原样带过来，只额外覆盖 description，以及用 ``narrow`` 往声明里补
    枚举这类**收窄提示**。收窄只是告诉模型选什么，真正的校验仍然只有注册表那一处。
    """
    spec = require_operation(operation)
    contract = set(spec.input.model_fields)
    unknown = sorted((set(withheld) | set(narrow or {}) | set(describe or {})) - contract)
    if unknown:
        raise ValueError(f"{operation} 的合同上没有这些字段：{unknown}")
    hints = dict(describe or {})
    extras = dict(narrow or {})
    fields: dict[str, Any] = {}
    for field_name, info in spec.input.model_fields.items():
        if field_name in withheld:
            continue
        # 复制一份再写说明：注册表模型是全域共用的，不能就地改它的 FieldInfo
        clone = copy.copy(info)
        if field_name in hints:
            clone.description = hints[field_name]
        if field_name in extras:
            clone.json_schema_extra = dict(extras[field_name])
        fields[field_name] = (info.annotation, clone)
    fields.update(dict(extra or {}))
    return create_model(name, __config__=ConfigDict(extra="forbid"), **fields)


# ---- 提交 ----


async def submit_operation(
    operation: str,
    payload: Mapping[str, Any],
    *,
    turn: TaskToolTurn,
    label: str,
    source_context: Mapping[str, Any] | None = None,
) -> SubmittedTask:
    """校验 → 建任务 → 入队，全部交给统一执行器；失败一律转成面向模型的错误。"""
    tool_id = owner_plugin_id(operation)
    context = {"source": SOURCE, "chat_id": turn.chat_id, **dict(source_context or {})}
    try:
        body = parse_tool_operation_input(operation, dict(payload))
        queue = await acquire_queue()
        with invocation_context(source=SOURCE, source_route=turn.source_route, tool_id=tool_id):
            result = await start_tool_operation(
                turn.session,
                queue,
                tool_id=tool_id,
                operation=operation,
                body=body,
                source_route=turn.source_route,
                source_context=context,
            )
    except ValueError as exc:
        # ToolExecutionError（合同 / 前置条件）与 require_tool_operation 的 ValueError
        raise AgentToolError(str(exc)) from exc
    return submitted(result.task, operation=operation, tool_id=tool_id, label=label)


def submitted(
    task: StudioTask,
    *,
    operation: str,
    tool_id: str,
    label: str,
    run_id: str | None = None,
) -> SubmittedTask:
    return SubmittedTask(
        task_id=str(task.id),
        operation=operation,
        tool_id=tool_id,
        status=str(task.status),
        label=label,
        run_id=run_id,
    )


# ---- 工具组装 ----

RunFn = Callable[[Any, TaskToolTurn], Awaitable[SubmittedTask]]

RESULT_NOTE = (
    "任务已经提交，正在后台跑。产物完成后会自动出现在对话里，"
    "你现在只要用一句话说明提交了什么、大概要等一会儿；不要重复提交，也不要假装已经看到结果。"
)


@dataclass(frozen=True)
class SubmitBrief:
    """一项能力在对话里的形象。

    ``description`` 是模型选不选这个工具的**唯一依据**，要写清什么时候该用它、参数从哪来。
    """

    name: str
    operation: str
    label: str
    description: str
    withheld: Mapping[str, str] = field(default_factory=dict)
    describe: Mapping[str, str] = field(default_factory=dict)
    narrow: Mapping[str, dict[str, Any]] = field(default_factory=dict)
    # 对话侧独有的字段（如蒙版资产 id），或需要就地改写的合同字段（如允许 0 表示「不知道」）
    extra: Mapping[str, tuple[Any, Any]] = field(default_factory=dict)

    def args_model(self) -> type[BaseModel]:
        return derive_args_model(
            f"{_camel(self.name)}Args",
            self.operation,
            withheld=self.withheld,
            describe=self.describe,
            narrow=self.narrow,
            extra=self.extra,
        )


def _camel(name: str) -> str:
    return "".join(part.capitalize() for part in name.split("_") if part)


def render_submitted(args: BaseModel, value: SubmittedTask) -> list[ContentBlock]:
    """回给模型的工具结果：提交回执，不含产物。"""
    del args
    payload = {
        "ok": True,
        "task_id": value.task_id,
        "operation": value.operation,
        "status": value.status,
        "note": RESULT_NOTE,
    }
    return [TextBlock(text=json.dumps(payload, ensure_ascii=False))]


def build_submit_tool(brief: SubmitBrief, run: RunFn) -> ToolDefinition:
    """把一项能力包成对话工具：schema 由注册表派生，工具体只做「补齐宿主事实 + 提交」。"""
    args_model = brief.args_model()

    async def execute(args: BaseModel, exec: ToolRunContext) -> SubmittedTask:
        del exec
        return await run(args, require_turn(brief.name))

    return tool(
        brief.name,
        description=brief.description,
        input=args_model,
        output=SubmittedTask,
        render=render_submitted,
        # 提交完就返回，真正的活在 worker 里；与 tool_plugins 的 task 一致
        runtime_kind="task",
    )(execute)


def host_payload(args: BaseModel, *, drop: Sequence[str] = (), **overrides: Any) -> dict[str, Any]:
    """模型给的参数 + 宿主代填的字段 → 交给注册表校验的载荷。

    ``drop`` 是只在对话侧存在、需要翻译成合同字段的入参（如蒙版资产 id）。合同上有默认值
    的字段一律不在这里补，缺省语义以注册表为准。
    """
    payload = args.model_dump(exclude=set(drop))
    payload.update({key: value for key, value in overrides.items() if value is not None})
    return payload


__all__ = [
    "AGENT_PLUGIN_ID",
    "SOURCE",
    "AgentToolError",
    "SubmitBrief",
    "SubmittedTask",
    "TaskToolTurn",
    "acquire_queue",
    "bind_turn",
    "build_submit_tool",
    "current_turn",
    "derive_args_model",
    "host_payload",
    "owner_plugin_id",
    "render_submitted",
    "require_turn",
    "submit_operation",
    "submitted",
]
