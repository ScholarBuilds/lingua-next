"""Agent 工具：注册进内核 ToolRuntime、供带工具的对话循环调用的业务工具。

工具按 ``@tool`` 定义在各自模块里，这里只负责把它们放进命名作用域。注册是惰性的：
bootstrap 不 import 本包，业务模块首次要用工具时调 :func:`ensure_registered`。

两种形态：

- **当场出结果**（``image_generate``）：一轮之内出图入库，产物直接贴回对话。
- **提交拿 task_id**（``image_edit`` / ``video_generate`` / ``workflow_run``）：编辑、视频、
  工作流都要 worker 跑几十秒到几分钟，工具体只建任务并入队，进度与产物走任务中心那条既有
  事件流。这三类的入参 schema 由 ``tool_execution`` 的 operation 注册表派生，校验也只在
  那里做一次，见 :mod:`domain.agent_tools.submit`。
"""

from __future__ import annotations

from domain.agent_tools import image_edit, image_generate, submit, video_generate, workflow_run
from domain.kernel.bootstrap import Kernel, get_kernel
from domain.kernel.events import ScopeKey
from domain.kernel.tool_runtime import ToolDefinition

# GPT 创作对话的工具作用域；与 tool_plugins 里的插件 id 同名
GPT_CREATIVE_SCOPE = "gpt-creative"

GPT_CREATIVE_TOOLS: tuple[ToolDefinition, ...] = (
    image_generate.GENERATE_IMAGE,
    image_edit.EDIT_IMAGE,
    video_generate.GENERATE_VIDEO,
    workflow_run.RUN_WORKFLOW,
    workflow_run.RUN_FLOW,
)


def ensure_registered(kernel: Kernel | None = None) -> ScopeKey:
    """把 GPT 创作对话的工具注册进 ``gpt-creative`` 作用域，返回作用域键。

    重复调用无副作用：已在该作用域里的同一定义直接跳过。
    """
    target = kernel if kernel is not None else get_kernel()
    scope = target.scope(GPT_CREATIVE_SCOPE)
    visible = target.tools.view(scope)
    for definition in GPT_CREATIVE_TOOLS:
        if visible.get(definition.name) is definition:
            continue
        target.tools.register(definition, scope=scope)
    return scope


__all__ = [
    "GPT_CREATIVE_SCOPE",
    "GPT_CREATIVE_TOOLS",
    "ensure_registered",
    "image_edit",
    "image_generate",
    "submit",
    "video_generate",
    "workflow_run",
]
