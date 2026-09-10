/* LLM 节点：改写上游文字、看图，或保留多轮对话 */

import { MessageSquareText } from '@/components/NexusIcon'

import { LlmNode } from '../CanvasNodes'
import { CASCADE_RUNTIME_FIELDS } from './definition'
import type { NodeDefinition } from './definition'

export const llmNodeDefinition: NodeDefinition = {
  type: 'llm',
  label: 'LLM',
  icon: MessageSquareText,
  category: 'generator',
  defaults: () => ({
    title: 'LLM',
    llm_mode: 'node',
    llm_system_enabled: false,
    llm_messages: [],
  }),
  width: 420,
  contentSized: false,
  ports: { in: ['image', 'video', 'text', 'control'], out: ['text'] },
  get View() {
    return LlmNode
  },
  cardLike: true,
  toolbar: 'none',
  cascadeExecutable: true,
  taskTypes: [],
  runtimeFields: CASCADE_RUNTIME_FIELDS,
  menus: { classic: true, smart: false },
  hint: '改写、看图或多轮对话',
}
