"""工坊工具插件目录。

这里是工具身份、能力、界面贡献和运行时合同的唯一事实源；前端只保留
Lucide 图标这种本地渲染器映射。当前先包装现有工具，后续执行器通过同一
``plugin_id + generation`` 绑定到 REST、Agent、Canvas 和 Workflow。
"""

from __future__ import annotations

from dataclasses import dataclass
from types import ModuleType
from typing import Any

from domain.plugin_runtime import PluginManifest, PluginRegistry, RegistrationHandle

TOOL_PLUGIN_KIND = "studio-tool"
# 状态是产品事实，不是迁移进度：ready 打开就能完整做完一件事；beta 能做完但有
# 明确缺口（缺口写进 gap，界面 hover 显示）；planned 还没有可用的东西。
# 旧的 partial 档已删——它的「基础版 · 继续补齐」既不告诉用户能不能用，
# 也不告诉用户缺什么。
TOOL_STATUSES = frozenset({"ready", "beta", "planned"})
TOOL_CATEGORIES = (
    {
        "id": "create",
        "label": "创作工具",
        "hint": "从提示词和素材开始，生成、编辑与比较结果",
    },
    {
        "id": "manage",
        "label": "资产与配置",
        "hint": "管理素材、提示词、工作流、项目和真实模型",
    },
    {
        "id": "connect",
        "label": "连接器与维护",
        "hint": "把浏览器、Photoshop 和本机部署接进创作链路",
    },
)



def _execution_registry() -> ModuleType:
    """可执行能力的注册表在 tool_execution；它在模块顶层 import 本模块，
    这里只能在调用时再取，否则成环。"""
    from domain import tool_execution

    return tool_execution


@dataclass(frozen=True)
class ToolPlugin:
    id: str
    label: str
    hint: str
    category: str
    status: str
    gap: str
    route: str | None
    blueprint: str
    runtime_kind: str
    capabilities: frozenset[str]
    surfaces: frozenset[str]
    input_schema: dict[str, Any]
    output_schema: dict[str, Any]
    resume_policy: str

    def view(self, manifest: PluginManifest, generation: int) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "hint": self.hint,
            "category": self.category,
            "status": self.status,
            "gap": self.gap,
            "route": self.route,
            "blueprint": self.blueprint,
            "runtime_kind": self.runtime_kind,
            "capabilities": sorted(self.capabilities),
            "operation_contracts": _execution_registry().operation_contracts(
                self.capabilities
            ),
            "surfaces": sorted(self.surfaces),
            "input_schema": dict(self.input_schema),
            "output_schema": dict(self.output_schema),
            "resume_policy": self.resume_policy,
            "version": manifest.version,
            "generation": generation,
        }


_registry: PluginRegistry[ToolPlugin] = PluginRegistry(TOOL_PLUGIN_KIND)


def register_tool_plugin(
    *,
    plugin_id: str,
    label: str,
    hint: str,
    category: str,
    status: str,
    blueprint: str,
    gap: str = "",
    capabilities: set[str] | frozenset[str] = frozenset(),
    route: str | None = None,
    runtime_kind: str = "page",
    surfaces: set[str] | frozenset[str] = frozenset({"studio.home"}),
    input_schema: dict[str, Any] | None = None,
    output_schema: dict[str, Any] | None = None,
    resume_policy: str = "none",
    version: str = "1.0.0",
    replace: bool = False,
) -> RegistrationHandle:
    normalized_status = status.strip().lower()
    if normalized_status not in TOOL_STATUSES:
        raise ValueError(f"未知工具状态：{status}")
    normalized_gap = gap.strip()
    # beta 必须说清楚缺什么，否则界面上又是一个没有信息量的徽标
    if normalized_status == "beta" and not normalized_gap:
        raise ValueError(f"beta 工具必须写明缺口：{plugin_id}")
    if normalized_status != "beta" and normalized_gap:
        raise ValueError(f"只有 beta 工具才写缺口：{plugin_id}")
    category_ids = {item["id"] for item in TOOL_CATEGORIES}
    if category not in category_ids:
        raise ValueError(f"未知工具分类：{category}")
    normalized_capabilities = frozenset(value.strip().lower() for value in capabilities)
    plugin = ToolPlugin(
        id=plugin_id.strip().lower(),
        label=label.strip(),
        hint=hint.strip(),
        category=category,
        status=normalized_status,
        gap=normalized_gap,
        route=route,
        blueprint=blueprint,
        runtime_kind=runtime_kind,
        capabilities=normalized_capabilities,
        surfaces=frozenset(surfaces),
        input_schema=dict(input_schema or {"type": "object", "additionalProperties": True}),
        output_schema=dict(output_schema or {"type": "object", "additionalProperties": True}),
        resume_policy=resume_policy,
    )
    return _registry.register(
        PluginManifest(
            id=plugin.id,
            kind=TOOL_PLUGIN_KIND,
            name=plugin.label,
            version=version,
            description=plugin.hint,
            capabilities=plugin.capabilities,
            metadata={"runtime_kind": runtime_kind, "blueprint": blueprint},
        ),
        plugin,
        replace=replace,
    )


def get_tool_plugin(plugin_id: str) -> ToolPlugin:
    return _registry.require(plugin_id).implementation


def tool_plugin_identity(plugin_id: str) -> tuple[str, int]:
    registration = _registry.require(plugin_id)
    return registration.manifest.version, registration.generation


def require_tool_operation(plugin_id: str, operation: str) -> ToolPlugin:
    plugin = get_tool_plugin(plugin_id)
    normalized = operation.strip().lower()
    if normalized not in plugin.capabilities:
        raise ValueError(f"工具 {plugin.id} 不支持能力：{operation}")
    if not _execution_registry().has_operation(normalized):
        raise ValueError(f"能力尚未接入统一执行器：{operation}")
    return plugin


def list_tool_plugins() -> list[dict[str, Any]]:
    return [item.implementation.view(item.manifest, item.generation) for item in _registry.list()]


def catalog_view() -> dict[str, Any]:
    return {
        "tool_categories": [dict(item) for item in TOOL_CATEGORIES],
        "tools": list_tool_plugins(),
    }


# 状态判据是「现在打开能不能完整做完一件事」，与迁移进度无关。beta 的 gap
# 是给用户看的一句话，界面上 hover 显示，别写成内部术语。
_BuiltinSpec = dict[str, Any]


def _register_builtins() -> tuple[RegistrationHandle, ...]:
    specs: tuple[_BuiltinSpec, ...] = (
        {
            "plugin_id": "infinite-canvas",
            "label": "无限画布",
            "hint": "把图片、提示词与工作流连成可继续生成的创作图谱",
            "category": "create",
            "status": "ready",
            "route": "/studio/canvas",
            "blueprint": "ST-01",
            "capabilities": {
                "image.generate",
                "image.edit",
                "image.auto",
                "image.upscale",
                "video.generate",
                "workflow.run",
                "chat.general",
                "midjourney.generate",
                "midjourney.action",
            },
            "runtime_kind": "canvas",
            "resume_policy": "checkpoint",
        },
        {
            "plugin_id": "chat-image",
            "label": "对话生图",
            "hint": "逐轮继承参考图，保持主体和构图一致地继续修改",
            "category": "create",
            "status": "ready",
            "route": "/studio/chat",
            "blueprint": "ST-02",
            "capabilities": {
                "image.generate",
                "image.edit",
                "midjourney.generate",
                "midjourney.action",
            },
            "runtime_kind": "conversation",
            "resume_policy": "checkpoint",
        },
        {
            "plugin_id": "image-console",
            "label": "生图控制台",
            "hint": "结构化提示词、画风、画幅、批量和完整任务参数",
            "category": "create",
            "status": "ready",
            "route": "/image",
            "blueprint": "ST-03",
            "capabilities": {"image.generate", "image.edit"},
            "runtime_kind": "task",
            "resume_policy": "retry",
        },
        {
            "plugin_id": "image-editor",
            "label": "图片编辑",
            "hint": "裁剪、绘制、遮罩、扩图和多参考 AI 编辑",
            "category": "create",
            "status": "ready",
            "route": "/image/image_to_image",
            "blueprint": "ST-04",
            "capabilities": {"image.edit"},
            "runtime_kind": "task",
            "resume_policy": "retry",
        },
        {
            "plugin_id": "klein-editor",
            "label": "Flux Klein 多参考",
            "hint": "三槽位参考图通过本机 ComfyUI 或 ModelScope 合成，保留 LoRA 与历史复刻",
            "category": "create",
            "status": "ready",
            "route": "/studio/klein",
            "blueprint": "ST-04",
            "capabilities": {"image.generate", "workflow.run"},
            "runtime_kind": "task",
            "resume_policy": "retry",
        },
        {
            "plugin_id": "enhance",
            "label": "细节增强与超分",
            "hint": "AI 细节重绘与真实 2x/4x 工作流分开呈现",
            "category": "create",
            "status": "ready",
            "route": "/studio/enhance",
            "blueprint": "ST-05",
            "capabilities": {"image.edit", "workflow.run"},
            "runtime_kind": "task",
            "resume_policy": "retry",
        },
        {
            "plugin_id": "angle-control",
            "label": "角度控制",
            "hint": "用方位、俯仰与距离重画同一个主体",
            "category": "create",
            "status": "ready",
            "route": "/studio/angle",
            "blueprint": "ST-06",
            "capabilities": {"image.edit", "workflow.run"},
            "runtime_kind": "task",
            "resume_policy": "retry",
        },
        {
            "plugin_id": "zimage-generator",
            "label": "Z-Image 生成",
            "hint": "本机 Z-Image 与 ModelScope 双引擎生成，结果进入同一历史画廊",
            "category": "create",
            "status": "ready",
            "route": "/studio/zimage",
            "blueprint": "ST-07",
            "capabilities": {"image.generate", "workflow.run"},
            "runtime_kind": "task",
            "resume_policy": "retry",
        },
        {
            "plugin_id": "online-image",
            "label": "在线多平台生图",
            "hint": "OpenAI、Gemini、ModelScope 与直连适配器共用参考图、尺寸与持久历史",
            "category": "create",
            "status": "ready",
            "route": "/studio/online",
            "blueprint": "ST-07",
            "capabilities": {"image.generate", "image.edit", "image.upscale", "workflow.run"},
            "runtime_kind": "task",
            "resume_policy": "retry",
        },
        {
            "plugin_id": "gpt-creative",
            "label": "GPT 创作对话",
            "hint": "多模态对话调用生图、编辑、视频与工作流工具",
            "category": "create",
            "status": "ready",
            "route": "/studio/gpt",
            "blueprint": "ST-08",
            # 对话代理自己声明这几项，提交才记在它名下（domain/agent_tools/submit.py
            # 的 owner_plugin_id 优先认领本插件）；不声明就会退到画布或工作流中心，
            # 台账上看不出这次是对话里发起的
            "capabilities": {
                "chat.general",
                "image.generate",
                "image.edit",
                "video.generate",
                "workflow.run",
                "flow.run",
            },
            "runtime_kind": "agent",
            "resume_policy": "checkpoint",
        },
        {
            "plugin_id": "video-director",
            "label": "视频生成与导演时间线",
            "hint": "文/图生视频、首尾帧、参考轨和 MiniMax/LTX 时间线",
            "category": "create",
            "status": "ready",
            "route": "/studio/video",
            "blueprint": "ST-09",
            "capabilities": {"video.generate", "workflow.run"},
            "runtime_kind": "task",
            "resume_policy": "provider_task",
        },
        {
            "plugin_id": "panorama",
            "label": "全景预览",
            "hint": "在球面中浏览 360 全景图并导出当前视角",
            "category": "create",
            "status": "ready",
            "route": "/studio/panorama",
            "blueprint": "ST-10",
            "capabilities": set(),
            "runtime_kind": "local",
            "resume_policy": "none",
        },
        {
            "plugin_id": "frame-extractor",
            "label": "视频抽帧",
            "hint": "定位时间或逐帧移动，把画面作为素材继续创作",
            "category": "create",
            "status": "ready",
            "route": "/studio/frames",
            "blueprint": "ST-11",
            "capabilities": set(),
            "runtime_kind": "task",
            "resume_policy": "retry",
        },
        {
            "plugin_id": "grid-tool",
            "label": "宫格切拼",
            "hint": "按自定义行列切图，或把多张图片重新拼接",
            "category": "create",
            "status": "ready",
            "route": "/studio/grid",
            "blueprint": "ST-12",
            "capabilities": set(),
            "runtime_kind": "local",
            "resume_policy": "none",
        },
        {
            "plugin_id": "asset-library",
            "label": "素材库",
            "hint": "统一管理图片、视频、音频、文件、标签与参考资产",
            "category": "manage",
            "status": "ready",
            "route": "/studio/assets",
            "blueprint": "ST-13",
            "capabilities": {"vision.caption"},
            "runtime_kind": "page",
            "resume_policy": "none",
        },
        {
            "plugin_id": "prompt-library",
            "label": "提示词库",
            "hint": "模板、变量、来源与版本在各创作工具间复用",
            "category": "manage",
            "status": "ready",
            "route": "/studio/prompts",
            "blueprint": "ST-14",
            "capabilities": set(),
            "runtime_kind": "page",
            "resume_policy": "none",
        },
        {
            "plugin_id": "workflow-center",
            "label": "工作流中心",
            "hint": "管理 ComfyUI、RunningHub 和内置工作流的配置与版本",
            "category": "manage",
            "status": "ready",
            "route": "/studio/workflows",
            "blueprint": "ST-15",
            # flow.run / flow.resume 是 DAG 引擎的两项能力（M62）。以前没有任何插件
            # 声明它们，`require_tool_operation` 一律挡在门外，外部入口（REST、MCP）
            # 连提交都提交不了，只有引擎内部自己 prepare 自己入队。工作流中心就是这两
            # 项能力在界面上的归属，由它认领。
            "capabilities": {"workflow.run", "flow.run", "flow.resume"},
            "runtime_kind": "workflow",
            "resume_policy": "provider_task",
        },
        {
            "plugin_id": "model-lab",
            "label": "模型调用账本",
            "hint": "按能力、插件与来源翻每一次模型调用，逐条看入参、产出与耗时",
            "category": "manage",
            "status": "ready",
            "route": "/studio/models",
            "blueprint": "ST-16",
            "capabilities": set(),
            "runtime_kind": "page",
            "resume_policy": "none",
        },
        {
            "plugin_id": "canvas-projects",
            "label": "项目与画布",
            "hint": "项目看板、画布元数据、导入导出与回收站",
            "category": "manage",
            "status": "ready",
            "route": "/studio/canvas",
            "blueprint": "ST-17",
            "capabilities": set(),
            "runtime_kind": "page",
            "resume_policy": "none",
        },
        {
            "plugin_id": "chrome-collector",
            "label": "浏览器素材采集器",
            "hint": "扫描网页图片、视频和画布，批量导入并智能分类",
            "category": "connect",
            "status": "beta",
            "gap": "扩展没上架商店，首次要按连接器页的引导手动加载一次；"
            "HLS 流与 DRM 视频仍然抓不了",
            "route": "/studio/connectors",
            "blueprint": "ST-18",
            "capabilities": {"vision.caption"},
            "runtime_kind": "connector",
            "resume_policy": "retry",
        },
        {
            "plugin_id": "photoshop-connector",
            "label": "Photoshop 连接器",
            "hint": "素材双向、实时同步，并从 PS 直接运行生成与工作流",
            "category": "connect",
            "status": "beta",
            "gap": "面板不走 Creative Cloud 分发，首次要按连接器页的引导用 "
            "Adobe UXP Developer Tool 手动加载一次",
            "route": "/studio/connectors",
            "blueprint": "ST-19",
            "capabilities": {"image.generate", "image.edit", "workflow.run"},
            "runtime_kind": "connector",
            "resume_policy": "retry",
        },
        {
            "plugin_id": "update-backup",
            "label": "更新与备份",
            "hint": "管理员版本检查、升级前备份和可恢复回滚",
            "category": "connect",
            "status": "planned",
            "route": None,
            "blueprint": "ST-20",
            "capabilities": set(),
            "runtime_kind": "maintenance",
            "resume_policy": "checkpoint",
        },
    )
    return tuple(register_tool_plugin(**spec) for spec in specs)


_BUILTIN_HANDLES = _register_builtins()
