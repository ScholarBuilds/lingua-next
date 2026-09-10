/* 画布节点定义（模块 17 · 调研 §2.7「节点即插件」）。
 *
   在这之前，"一种节点是什么"散在八个文件里：`CanvasBoard` 的 VIEWS 表和卡片白名单、
   `CanvasPage` 的两套创建菜单与三十处内联默认值、`CanvasNodeMenu` 的端口菜单、
   `canvasStore` 的宽度表/级联白名单/任务落点判定、`CanvasGeneratorEngine` 的引擎互映。
   同一个循环节点的默认轮数在三处写着 1、3、3——没有任何编译期检查会提醒漏改。

   一种节点收敛成一份 `NodeDefinition`，各处改成查表。漏注册会在
   `NODE_DEFINITIONS satisfies Record<ScvNodeType, NodeDefinition>` 处报 tsc 错误。 */

import type { ComponentType, SVGProps } from 'react'

import type { ScvNode, ScvNodeType } from '../canvasStore'
import type { ScvNodeData } from '../CanvasNodes'

/** 端口上流的是什么。用来过滤"这条线还能接什么节点"——
 *  列出接不上的类型再让用户点了报错，是最没必要的挫败感。
 *  `control` 是轮次/执行控制（循环节点的产出），不带数据。 */
export type PortKind = 'image' | 'video' | 'audio' | 'file' | 'text' | 'control'

/** 节点大类。目前只影响文档可读性与菜单分组，不参与任何判定 */
export type NodeCategory = 'media' | 'text' | 'generator' | 'workflow' | 'control'

/** 节点悬浮工具条的形态。`media` 是裸图那一排（预览/裁剪/扩图…），
 *  `group` 是分组专用的整理/拼接/解散，`none` 不给工具条 */
export type NodeToolbarKind = 'none' | 'media' | 'group'

/** 生成条上的引擎档位（F057）。`workflow` 再按 provider 分 comfyui / runninghub */
export type NodeGeneratorEngine = 'api-image' | 'api-video' | 'modelscope' | 'workflow'

/** 编译成服务端 DAG 的一个工具节点。
 *
 *  `NodeDefinition.compile` 是留给编译分支的出口：目前六个分支仍写在
 *  `canvasStore.compileCascadeRun` 里，搬过来要连带拆掉那个闭包里的
 *  prompt / 参考图投影 / 工作流详情预取，属于另一项改动，所以这里先只立契约。 */
export interface FlowNodeSpec {
  operation: string
  input: Record<string, unknown>
  sourceContext?: Record<string, unknown>
}

/** 编译上下文。轮次、已编译上游、静态参考图由级联编译器备好后传进来 */
export interface NodeCompileContext {
  round: number
  total: number
  /** 已编译的上游 flow 节点 id，用于 `$artifacts` 投影 */
  sources: string[]
  /** 本轮拼好的提示词 */
  prompt: unknown
}

/** 图标组件。存组件而不是元素，定义文件才能是纯 .ts；
 *  调用方按各自的尺寸/类名渲染 `<def.icon />` */
export type NodeIcon = ComponentType<SVGProps<SVGSVGElement>>

export interface NodeDefinition {
  type: ScvNodeType
  /** 菜单里的短名 */
  label: string
  icon: NodeIcon
  category: NodeCategory
  /** 建这种节点时补什么字段。**不含 x/y/w**：落点由调用方给，
   *  宽度统一由 `withDefaultSize` 按 `width` / `contentSized` 补 */
  defaults: () => Partial<ScvNode>
  /** 类型默认宽度。老画布里没存 w 的节点由渲染层用它兜底 */
  width: number
  /** 宽度由内容算：有图时按第一张的自然尺寸装框，空态才用 `width` */
  contentSized: boolean
  ports: { in: PortKind[]; out: PortKind[] }
  /** 节点视图。**必须用 getter 声明**（`get View() { return XxxNode }`）：
   *  definition 与 CanvasNodes 之间有环（definition → CanvasNodes → CanvasGeneratorEngine
   *  → nodes/index → definition），模块求值期直接写 `View: XxxNode` 会命中 TDZ，
   *  浏览器里整页白屏而 vitest 不报（两者解析模块图的顺序不同）。 */
  View: ComponentType<{ data: ScvNodeData }>
  /** 带表单的节点要卡片外观；图片/视频这类是裸媒体，画布上是漂着的 */
  cardLike: boolean
  toolbar: NodeToolbarKind
  /** 能作为级联链上的执行节点（会真的发起一次调用） */
  cascadeExecutable: boolean
  /** 哪些持久任务**落在**这种节点上。`xxx.*` 按前缀匹配。
   *  注意 midjourney.* 落的是图片节点——发起方是 midjourney 节点，落点是 image/output */
  taskTypes: string[]
  /** 运行态字段：保存时整片剥掉（BR-143）。刷新后由任务/运行查询重新投影回来 */
  runtimeFields: (keyof ScvNode)[]
  /** 出现在哪套创建菜单里。经典与智能两套菜单的成员不同 */
  menus: { classic: boolean; smart: boolean }
  /** 菜单里的一句说明。只写标签讲不清的约束、代价或反预期，其余留空 */
  hint?: string
  /** 智能画布菜单里换的措辞（智能画布的"上传"就是经典的"图片"） */
  smartLabel?: string
  smartHint?: string
  smartIcon?: NodeIcon
  /** 生成条上归哪一档引擎。没有生成条的节点不填 */
  generatorEngine?: NodeGeneratorEngine
  compile?: (node: ScvNode, ctx: NodeCompileContext) => FlowNodeSpec | null
}

/** 级联运行态：任何节点都可能被投影上这一组，保存时一律剥掉。
 *  刷新后 `recoverCanvasCascadeRun` 会按服务端 FlowRun 的 checkpoint 重新投影。 */
export const CASCADE_RUNTIME_FIELDS: (keyof ScvNode)[] = [
  'cascade_status',
  'cascade_error',
  'cascade_failed_round',
  'cascade_total',
  'cascade_loop_id',
  'cascade_retry_order',
  'cascade_retry_ref_ids',
  'cascade_retry_media_refs',
  'cascade_run_id',
  'cascade_failed_flow_node_id',
]

/** 还没有内容的图片/视频/输出节点多宽。
 *
 *  不用媒体节点那个 520 的兜底：520 配上空态的高度是一条 2.2:1 的横杠，
 *  读起来像"出错了"而不是"这里可以放东西"。420 配 240 的最小高度是一张方正的卡片。
 *  服务端建新画布时用的 `studio.STARTER_NODE_W` 与它同值——两处不一致的话，
 *  新画布自带的节点会比右键建出来的窄一截，而这种差别没人会去查。
 *
 *  住在这里而不是 `canvasStore`：定义文件在模块初始化时就要读它，
 *  而 `canvasStore` 反过来依赖注册表，从那边取会撞上 TDZ。 */
export const EMPTY_NODE_W = 420

/** 两组端口有交集才接得上 */
export function portsMatch(out: PortKind[], into: PortKind[]): boolean {
  return out.some((kind) => into.includes(kind))
}

export type { ScvNodeType }
