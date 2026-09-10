/* 工作流节点：ComfyUI / RunningHub 的可执行定义，表单由目录 schema 派生。
 *
   不进创建菜单的默认建节点路径：它必须先选一份工作流，菜单项打开的是选择器，
   建节点走 `CanvasGeneratorEngine.workflowNodePatch`（那里会带上这里的默认值）。 */

import { IconTask } from '../../../components/icons'
import { WorkflowNode } from '../CanvasNodes'
import { CASCADE_RUNTIME_FIELDS } from './definition'
import type { NodeDefinition } from './definition'

export const workflowNodeDefinition: NodeDefinition = {
  type: 'workflow',
  label: '工作流',
  icon: IconTask,
  category: 'workflow',
  defaults: () => ({
    workflow_values: {},
    workflow_credential_id: null,
    workflow_use_wallet: false,
    completed_task_ids: [],
  }),
  width: 340,
  contentSized: false,
  ports: {
    in: ['image', 'video', 'audio', 'file', 'text', 'control'],
    out: ['image', 'video', 'audio', 'file'],
  },
  get View() {
    return WorkflowNode
  },
  cardLike: true,
  toolbar: 'none',
  cascadeExecutable: true,
  taskTypes: ['workflow.*'],
  runtimeFields: [
    ...CASCADE_RUNTIME_FIELDS,
    /* 落图幂等用的任务 id 表。刷新后 `recoverCanvasWorkflowTasks` 会重新走一遍
       落图（按 asset_id 去重），不需要把它带进画布 JSON */
    'completed_task_ids',
  ],
  menus: { classic: false, smart: false },
  hint: 'ComfyUI / RunningHub',
  generatorEngine: 'workflow',
}
