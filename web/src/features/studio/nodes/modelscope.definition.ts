/* ModelScope 节点：原生异步生图协议，带参考图与 LoRA */

import { CloudLightning } from '@/components/NexusIcon'

import { ModelScopeNode } from '../CanvasNodes'
import { CASCADE_RUNTIME_FIELDS } from './definition'
import type { NodeDefinition } from './definition'

export const modelscopeNodeDefinition: NodeDefinition = {
  type: 'modelscope',
  label: 'ModelScope',
  icon: CloudLightning,
  category: 'generator',
  defaults: () => ({ title: 'ModelScope 生成', ms_size: '1024x1024', ms_count: 1 }),
  width: 420,
  contentSized: false,
  ports: { in: ['image', 'text', 'control'], out: ['image'] },
  get View() {
    return ModelScopeNode
  },
  cardLike: true,
  toolbar: 'none',
  cascadeExecutable: true,
  taskTypes: [],
  runtimeFields: CASCADE_RUNTIME_FIELDS,
  menus: { classic: true, smart: false },
  hint: '异步生图、参考图与 LoRA',
  generatorEngine: 'modelscope',
}
