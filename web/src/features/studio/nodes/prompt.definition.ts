/* 提示词节点：一段文本，可同时喂给多个生成节点 */

import { IconPlus } from '../../../components/icons'
import { PromptNode } from '../CanvasNodes'
import { CASCADE_RUNTIME_FIELDS } from './definition'
import type { NodeDefinition } from './definition'

export const promptNodeDefinition: NodeDefinition = {
  type: 'prompt',
  label: '提示词',
  icon: IconPlus,
  category: 'text',
  defaults: () => ({ text: '' }),
  width: 316,
  contentSized: false,
  ports: { in: [], out: ['text'] },
  get View() {
    return PromptNode
  },
  cardLike: true,
  toolbar: 'none',
  cascadeExecutable: false,
  taskTypes: [],
  runtimeFields: CASCADE_RUNTIME_FIELDS,
  menus: { classic: true, smart: true },
  hint: '可连接到多个生成节点',
  smartHint: '手写或用 LLM 生成文本',
}
