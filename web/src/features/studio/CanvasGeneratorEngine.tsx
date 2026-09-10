/* 智能画布统一引擎切换（F057）。
 *
 * Infinite-Canvas 在同一输入器里切 API / ModelScope / ComfyUI / RunningHub。
 * Lingua 的执行器按节点类型拆开，切换时只改 type 与该引擎的缺省字段，旧引擎字段
 * 留在节点 JSON 里；切回来可恢复之前的模型、尺寸和工作流，不会因一次试用丢配置。 */

import { useState } from 'react'

import { PillPicker } from '@/components/ui/picker'

import type { ExecutableWorkflow } from '../../lib/api-studio'
import type { ScvNode } from './canvasStore'
import { useCanvasStore } from './canvasStore'
import { NODE_DEFINITIONS, nodeDefinition, nodeTypeForEngine } from './nodes'
import { WorkflowNodePicker } from './WorkflowNodePicker'

export type CanvasGeneratorEngine =
  | 'api-image'
  | 'api-video'
  | 'modelscope'
  | 'comfyui'
  | 'runninghub'

/* 切换 type 会把当前生成条卸载并在同一鼠标位置挂上另一种生成条。悬停菜单若在
 * pointerup 前重建，会把同一次点击误送给新菜单的第一项，表现为「视频闪一下又回图片」。 */
let engineSwitchLockedUntil = 0

export function canvasGeneratorEngine(node: ScvNode): CanvasGeneratorEngine {
  const engine = nodeDefinition(node.type).generatorEngine
  // 工作流一种节点两档引擎，按 provider 分；其余节点类型与引擎一一对应
  if (engine === 'workflow') {
    return node.workflow_provider === 'runninghub' ? 'runninghub' : 'comfyui'
  }
  return engine ?? 'api-image'
}

/** 工作流节点的新建与原位切换共用同一份默认值。 */
export function workflowNodePatch(
  workflow: ExecutableWorkflow,
): Omit<ScvNode, 'id' | 'x' | 'y'> {
  const definition = NODE_DEFINITIONS.workflow
  return {
    ...definition.defaults(),
    type: 'workflow',
    w: definition.width,
    title: workflow.title,
    workflow_id: workflow.id,
    workflow_provider: workflow.provider,
    workflow_kind: workflow.kind,
    workflow_has_thumbnail: workflow.has_thumbnail,
  }
}

/** 不碰其它引擎字段：它们是用户已经调过的记忆，切回时要原样恢复。
 *
 *  只按目标引擎补它自己的缺省值，**不整片套用 defaults()**：图片节点的
 *  `items: []` 套到视频上会把已经出好的图抹掉。 */
export function generatorEnginePatch(
  node: ScvNode,
  engine: Exclude<CanvasGeneratorEngine, 'comfyui' | 'runninghub'>,
): Partial<ScvNode> {
  const type = nodeTypeForEngine(engine)
  const defaults = NODE_DEFINITIONS[type].defaults()
  if (type === 'video') {
    return {
      type,
      video_settings: { ...(defaults.video_settings ?? {}), ...(node.video_settings ?? {}) },
    }
  }
  if (type === 'modelscope') {
    return {
      type,
      ms_size: node.ms_size ?? defaults.ms_size,
      ms_count: node.ms_count ?? defaults.ms_count,
    }
  }
  return { type }
}

export function GeneratorEnginePicker({
  node,
  disabled,
}: {
  node: ScvNode
  disabled?: boolean
}): JSX.Element {
  const snapshot = useCanvasStore((state) => state.snapshot)
  const updateNode = useCanvasStore((state) => state.updateNode)
  const [workflowProvider, setWorkflowProvider] = useState<'comfyui' | 'runninghub' | null>(null)
  const current = canvasGeneratorEngine(node)

  const select = (value: string): void => {
    const engine = value as CanvasGeneratorEngine
    if (Date.now() < engineSwitchLockedUntil) return
    if (engine === current) return
    if (engine === 'comfyui' || engine === 'runninghub') {
      if (node.workflow_id !== undefined && node.workflow_provider === engine) {
        engineSwitchLockedUntil = Date.now() + 350
        snapshot()
        updateNode(node.id, { type: 'workflow' })
      } else {
        setWorkflowProvider(engine)
      }
      return
    }
    engineSwitchLockedUntil = Date.now() + 350
    snapshot()
    updateNode(node.id, generatorEnginePatch(node, engine))
  }

  return (
    <div className="scv-engine-picker nodrag nowheel">
      <PillPicker
        label="引擎"
        value={current}
        disabled={disabled}
        title="切换引擎会保留当前节点、连线、参考图和各引擎上次使用的参数"
        onChange={select}
        options={[
          { value: 'api-image', label: 'API 图片' },
          { value: 'api-video', label: 'API 视频' },
          { value: 'modelscope', label: 'ModelScope' },
          { value: 'comfyui', label: 'ComfyUI' },
          { value: 'runninghub', label: 'RunningHub' },
        ]}
      />
      {workflowProvider !== null && (
        <WorkflowNodePicker
          initialProvider={workflowProvider}
          title={`选择 ${workflowProvider === 'comfyui' ? 'ComfyUI' : 'RunningHub'} 配置`}
          onClose={() => setWorkflowProvider(null)}
          onPick={(workflow) => {
            snapshot()
            updateNode(node.id, workflowNodePatch(workflow))
          }}
        />
      )}
    </div>
  )
}
