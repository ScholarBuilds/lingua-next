/* 画布节点注册表（模块 17 · 调研 §2.7）。
 *
   `satisfies Record<ScvNodeType, NodeDefinition>` 是这套东西的门禁：
   往 `CanvasNode['type']` 里加一个新类型而没在这里登记，tsc 直接报错，
   不会像以前那样"新节点建得出来但菜单里没有、级联跳过它、保存时运行态字段一起入库"。 */

import { derivePortMatrix } from '../canvas-core/layout'
import type { PortSpec } from '../canvas-core/layout'
import type { ScvNode, ScvNodeType } from '../canvasStore'
import { audioNodeDefinition } from './audio.definition'
import { fileNodeDefinition } from './file.definition'
import { groupNodeDefinition } from './group.definition'
import { imageNodeDefinition } from './image.definition'
import { llmNodeDefinition } from './llm.definition'
import { loopNodeDefinition } from './loop.definition'
import { midjourneyNodeDefinition } from './midjourney.definition'
import { modelscopeNodeDefinition } from './modelscope.definition'
import { outputNodeDefinition } from './output.definition'
import { promptNodeDefinition } from './prompt.definition'
import { videoNodeDefinition } from './video.definition'
import { workflowNodeDefinition } from './workflow.definition'
import { portsMatch } from './definition'
import type { NodeDefinition, NodeGeneratorEngine } from './definition'

export type {
  FlowNodeSpec,
  NodeCategory,
  NodeCompileContext,
  NodeDefinition,
  NodeGeneratorEngine,
  NodeIcon,
  NodeToolbarKind,
  PortKind,
} from './definition'
export { CASCADE_RUNTIME_FIELDS, EMPTY_NODE_W, portsMatch } from './definition'

export const NODE_DEFINITIONS = {
  image: imageNodeDefinition,
  video: videoNodeDefinition,
  prompt: promptNodeDefinition,
  llm: llmNodeDefinition,
  modelscope: modelscopeNodeDefinition,
  midjourney: midjourneyNodeDefinition,
  loop: loopNodeDefinition,
  group: groupNodeDefinition,
  workflow: workflowNodeDefinition,
  output: outputNodeDefinition,
  audio: audioNodeDefinition,
  file: fileNodeDefinition,
} satisfies Record<ScvNodeType, NodeDefinition>

/** 菜单与遍历的展示顺序。就是上面的声明顺序 */
export const NODE_TYPE_ORDER = Object.keys(NODE_DEFINITIONS) as ScvNodeType[]

/** 连线合法性用的端口矩阵，直接从注册表的 `ports` 派生。
 *
 *  画布内核（`canvas-core/layout`）只认矩阵不认节点类型，矩阵由这边喂给它——
 *  内核反过来 import 注册表会成真环（定义 → CanvasNodes → canvasStore → 内核）。
 *  新增一种节点只改它那份 `.definition.ts`，这里和内核都不用动。 */
export const NODE_PORT_MATRIX: Readonly<Record<string, PortSpec>> = derivePortMatrix(
  NODE_DEFINITIONS,
)

/** 能作为持久任务落点的节点类型。与「哪些定义声明了 taskTypes」一致，
 *  由 node-registry.test.ts 守住——类型系统算不出这个交集，只能测出来 */
export type TaskTargetNodeType = 'image' | 'video' | 'workflow'

export function findNodeDefinition(type: string): NodeDefinition | undefined {
  return (NODE_DEFINITIONS as Record<string, NodeDefinition | undefined>)[type]
}

/** 查定义。老画布里可能存着已经删掉的类型，这时按图片节点渲染而不是整块空白 */
export function nodeDefinition(type: string): NodeDefinition {
  return findNodeDefinition(type) ?? imageNodeDefinition
}

/** 建这种节点的完整补丁（含 type）。所有创建入口共用同一份默认值 */
export function nodeDefaults(type: ScvNodeType): Omit<ScvNode, 'id' | 'x' | 'y'> {
  return { type, ...NODE_DEFINITIONS[type].defaults() }
}

/** 这个类型的节点默认多宽。内容驱动尺寸的（图片/视频/输出）返回 undefined，
 *  由调用方按 items 的自然尺寸现算 */
export function defaultNodeWidth(type: string): number | undefined {
  const definition = findNodeDefinition(type)
  if (definition === undefined || definition.contentSized) return undefined
  return definition.width
}

export function isCascadeExecutableType(type: string): boolean {
  return findNodeDefinition(type)?.cascadeExecutable ?? false
}

/** 这条任务落在哪种节点上。`workflow.*` 这类前缀声明按前缀匹配 */
export function taskTargetNodeType(taskType: string): TaskTargetNodeType | null {
  for (const type of NODE_TYPE_ORDER) {
    for (const pattern of NODE_DEFINITIONS[type].taskTypes) {
      const matched = pattern.endsWith('.*')
        ? taskType.startsWith(pattern.slice(0, -1))
        : taskType === pattern
      if (matched) return type as TaskTargetNodeType
    }
  }
  return null
}

export function runtimeFieldsFor(type: string): (keyof ScvNode)[] {
  return findNodeDefinition(type)?.runtimeFields ?? []
}

/** 出现在这套创建菜单里的类型，按声明顺序 */
export function createMenuTypes(kind: 'classic' | 'smart'): ScvNodeType[] {
  return NODE_TYPE_ORDER.filter((type) => NODE_DEFINITIONS[type].menus[kind])
}

/** 从某个端口拖到空白处时，能接上的类型。
 *
 *  `out` 侧：新节点在下游，要能吃下来源的产出；`in` 侧反过来。
 *  只在创建菜单成员里挑——工作流得先选一份定义，输出/音频/文件是产物落点，
 *  它们都不能靠一份默认值凭空建出来。 */
export function portMenuTypes(sourceType: string, side: 'in' | 'out'): ScvNodeType[] {
  const source = nodeDefinition(sourceType)
  return NODE_TYPE_ORDER.filter((type) => {
    const candidate = NODE_DEFINITIONS[type]
    if (!candidate.menus.classic) return false
    return side === 'out'
      ? portsMatch(source.ports.out, candidate.ports.in)
      : portsMatch(candidate.ports.out, source.ports.in)
  })
}

/** 引擎 → 节点类型。工作流两个 provider 共用 workflow 节点 */
export function nodeTypeForEngine(engine: NodeGeneratorEngine): ScvNodeType {
  const found = NODE_TYPE_ORDER.find(
    (type) => NODE_DEFINITIONS[type].generatorEngine === engine,
  )
  return found ?? 'image'
}

