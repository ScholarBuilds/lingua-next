"""工作流两件事：``run_workflow`` 跑一条 ComfyUI / RunningHub 工作流，``run_flow`` 跑一条
自己编排的 DAG。

两者的落点不同：前者是 ``workflow.run``（任务类型 ``workflow.comfyui`` /
``workflow.runninghub``），后者是 DAG 内核那条 ``flow.run``（M62）。

id 从哪来是这两个工具最容易空转的地方：模型不可能凭空知道库里有哪几条。这里不为此常驻
一份清单进每轮提示词（几十条标题按 token 收钱），改成 **id 填 0 就把清单写进错误**——
模型下一轮拿着真 id 再调一次，代价只有一次工具调用。合同上这两个 id 是 ``ge=1``，声明里
放宽到 ``ge=0`` 就是为了留出这个探测值；0 永远走不到提交，注册表那边的约束不受影响。
"""

from __future__ import annotations

from datetime import UTC, datetime

from pydantic import Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from domain.agent_tools.submit import (
    AgentToolError,
    SubmitBrief,
    SubmittedTask,
    TaskToolTurn,
    acquire_queue,
    build_submit_tool,
    host_payload,
    owner_plugin_id,
    submit_operation,
    submitted,
)
from domain.models import ProviderCredential, StudioFlow, StudioFlowRun, StudioWorkflow
from domain.tool_execution import require_operation

# 清单最多写这么多条进错误：再多模型也挑不动，只会把上下文撑爆
MAX_LISTED = 20
# 「我不知道 id，先给我清单」的探测值
PROBE_ID = 0

WORKFLOW_TOOL_NAME = "run_workflow"
WORKFLOW_OPERATION = "workflow.run"
WORKFLOW_LABEL = "工作流运行"

FLOW_TOOL_NAME = "run_flow"
FLOW_OPERATION = "flow.run"
FLOW_LABEL = "编排运行"

WORKFLOW_WITHHELD = {
    "credential_id": "按工作流的 provider 挑一条可用凭据，模型不知道凭据 id",
    "use_wallet": "RunningHub 的账户余额开关，属于账号设置不属于这次调用",
    "instance_type": "RunningHub 的实例规格，同上",
}

FLOW_WITHHELD = {"parent_run_id": "对话发起的运行没有父运行"}

WORKFLOW_DESCRIPTION = (
    "跑一条已导入的 ComfyUI / RunningHub 工作流。"
    "用户点名某条工作流（「用那条高清修复跑一下」「跑 12 号工作流」），"
    "或者要的效果只有本机工作流做得到（特定 LoRA、超分、换脸这类）时调它。"
    "不知道 workflow_id 就填 0，报错会把库里可用的工作流列出来，别自己编一个 id。"
    "普通出图用 generate_image，不要绕这条路。"
)

FLOW_DESCRIPTION = (
    "跑一条编排好的 DAG（工作流中心里保存的多步流程），一次把生图、编辑、视频等几步连起来。"
    "用户说「跑一遍那条流程」「按上次那套流水线来」时调它。"
    "inputs 的键由这条 DAG 自己的入参 schema 规定，填错会把缺什么原样报回来；"
    "不知道 flow_id 就填 0，报错会把可用的 DAG 列出来。"
)


def _missing(given: int, label: str) -> str:
    if given == PROBE_ID:
        return f"还不知道要跑哪条{label}。"
    return f"{label} {given} 不存在或已停用。"


async def _workflow_menu(session: AsyncSession) -> str:
    rows = (
        (
            await session.execute(
                select(StudioWorkflow)
                .where(StudioWorkflow.enabled.is_(True))
                .order_by(StudioWorkflow.id.asc())
                .limit(MAX_LISTED)
            )
        )
        .scalars()
        .all()
    )
    if not rows:
        return "库里还没有启用的工作流，先去工作流中心导入一条。"
    listed = "；".join(f"{row.id}={row.title}（{row.provider}）" for row in rows)
    return f"可用的工作流：{listed}。"


async def _flow_menu(session: AsyncSession) -> str:
    rows = (
        (
            await session.execute(
                select(StudioFlow)
                .where(StudioFlow.enabled.is_(True))
                .order_by(StudioFlow.id.asc())
                .limit(MAX_LISTED)
            )
        )
        .scalars()
        .all()
    )
    if not rows:
        return "还没有启用的 DAG，先去工作流中心编一条。"
    return "可用的 DAG：" + "；".join(f"{row.id}={row.title}" for row in rows) + "。"


async def _workflow_credential(session: AsyncSession, workflow: StudioWorkflow) -> int:
    """按工作流的 provider 挑一条可用凭据；有多条时取 id 最小的那条，结果稳定。"""
    row = (
        (
            await session.execute(
                select(ProviderCredential)
                .where(
                    ProviderCredential.kind == "workflow",
                    ProviderCredential.provider_type == workflow.provider,
                    ProviderCredential.enabled.is_(True),
                )
                .order_by(ProviderCredential.id.asc())
                .limit(1)
            )
        )
        .scalars()
        .first()
    )
    if row is None:
        raise AgentToolError(
            f"没有可用的 {workflow.provider} 工作流凭据：到设置 · 供应商里配一条再跑。"
        )
    return row.id


WORKFLOW_BRIEF = SubmitBrief(
    name=WORKFLOW_TOOL_NAME,
    operation=WORKFLOW_OPERATION,
    label=WORKFLOW_LABEL,
    description=WORKFLOW_DESCRIPTION,
    withheld=WORKFLOW_WITHHELD,
    describe={
        "fields": (
            "这条工作流自己的输入项，键名由它的 ui_schema 规定（常见 prompt / image / seed）。"
            "不确定就传 {}，工作流会用自带默认值跑。"
        ),
    },
    extra={
        "workflow_id": (
            int,
            Field(ge=PROBE_ID, description="工作流的数字 id；填 0 表示不知道，报错会列出可用的"),
        )
    },
)

FLOW_BRIEF = SubmitBrief(
    name=FLOW_TOOL_NAME,
    operation=FLOW_OPERATION,
    label=FLOW_LABEL,
    description=FLOW_DESCRIPTION,
    withheld=FLOW_WITHHELD,
    describe={
        "inputs": "这条 DAG 声明的入参，键名由它的 input_schema 规定；没有入参就传 {}。",
    },
    extra={
        "flow_id": (
            int,
            Field(ge=PROBE_ID, description="DAG 的数字 id；填 0 表示不知道，报错会列出可用的"),
        )
    },
)


async def run_workflow(args, turn: TaskToolTurn) -> SubmittedTask:
    workflow = (
        None
        if args.workflow_id == PROBE_ID
        else await turn.session.get(StudioWorkflow, args.workflow_id)
    )
    if workflow is None or not workflow.enabled:
        head = _missing(args.workflow_id, "工作流")
        raise AgentToolError(f"{head}{await _workflow_menu(turn.session)}")
    payload = host_payload(
        args,
        credential_id=await _workflow_credential(turn.session, workflow),
    )
    return await submit_operation(
        WORKFLOW_OPERATION,
        payload,
        turn=turn,
        label=WORKFLOW_LABEL,
        source_context={"workflow_id": workflow.id},
    )


async def run_flow(args, turn: TaskToolTurn) -> SubmittedTask:
    """起一条 DAG 运行。

    这里没走 ``start_tool_operation``：``flow.run`` 到现在还没在注册表里声明 task_types 与
    worker 分派（M62 遗留），统一入口会卡在 ``queue_call_for``。所以照 DAG 引擎起子运行的
    同一种写法——注册表的 prepare 建运行与包装任务，再按 run_id 入队一次 tick。注册表补上
    分派之后，这段可以整体换成 ``submit_operation``。
    """
    from domain.studio_flows import flow_tick_job_id

    flow = None if args.flow_id == PROBE_ID else await turn.session.get(StudioFlow, args.flow_id)
    if flow is None or not flow.enabled:
        head = _missing(args.flow_id, "DAG")
        raise AgentToolError(f"{head}{await _flow_menu(turn.session)}")
    spec = require_operation(FLOW_OPERATION)
    tool_id = owner_plugin_id(FLOW_OPERATION)
    try:
        body = spec.input.model_validate(host_payload(args))
        result = await spec.prepare(
            turn.session,
            tool_id=tool_id,
            body=body,
            parent_task_id=None,
            batch_id=None,
            source_route=turn.source_route,
            source_context={"chat_id": turn.chat_id},
        )
    except ValueError as exc:
        raise AgentToolError(str(exc)) from exc
    run_id = str((result.task.invocation or {}).get("run_id") or "")
    await turn.session.commit()
    try:
        queue = await acquire_queue()
        await queue.enqueue_job("run_studio_flow", run_id, _job_id=flow_tick_job_id(run_id))
    except Exception as exc:
        message = f"DAG 入队失败：{type(exc).__name__}: {exc}"
        await _fail_run(turn.session, run_id, message)
        raise AgentToolError(message) from exc
    return submitted(
        result.task,
        operation=FLOW_OPERATION,
        tool_id=tool_id,
        label=FLOW_LABEL,
        run_id=run_id,
    )


async def _fail_run(session: AsyncSession, run_id: str, message: str) -> None:
    """入队没成的运行要当场标失败，不能让它在「排队中」上永远停着。"""
    row = await session.get(StudioFlowRun, run_id)
    if row is None:
        return
    row.status = "failed"
    row.error = message
    row.finished_at = datetime.now(UTC)
    await session.commit()


RUN_WORKFLOW = build_submit_tool(WORKFLOW_BRIEF, run_workflow)
RUN_FLOW = build_submit_tool(FLOW_BRIEF, run_flow)

__all__ = [
    "FLOW_BRIEF",
    "FLOW_DESCRIPTION",
    "FLOW_LABEL",
    "FLOW_OPERATION",
    "FLOW_TOOL_NAME",
    "FLOW_WITHHELD",
    "MAX_LISTED",
    "PROBE_ID",
    "RUN_FLOW",
    "RUN_WORKFLOW",
    "WORKFLOW_BRIEF",
    "WORKFLOW_DESCRIPTION",
    "WORKFLOW_LABEL",
    "WORKFLOW_OPERATION",
    "WORKFLOW_TOOL_NAME",
    "WORKFLOW_WITHHELD",
    "run_flow",
    "run_workflow",
]
