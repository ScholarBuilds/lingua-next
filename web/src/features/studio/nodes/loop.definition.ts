/* 循环节点：轮次控制。它自己不产图，它的直接下游才是级联起点。
 *
   默认轮数曾在三处各写一遍（1 / 3 / 3），建节点的入口不同拿到的轮数就不同。
   现在只有这一处，蓝本口径 3 轮。 */

import { IconRepeatOne } from '../../../components/icons'
import { LoopNode } from '../CanvasNodes'
import { CASCADE_RUNTIME_FIELDS } from './definition'
import type { NodeDefinition } from './definition'

export const loopNodeDefinition: NodeDefinition = {
  type: 'loop',
  label: '循环',
  icon: IconRepeatOne,
  category: 'control',
  defaults: () => ({ count: 3, mode: 'serial', variable_prompts: [] }),
  width: 360,
  contentSized: false,
  ports: { in: ['text', 'image', 'control'], out: ['control'] },
  get View() {
    return LoopNode
  },
  cardLike: true,
  toolbar: 'none',
  cascadeExecutable: false,
  taskTypes: [],
  runtimeFields: CASCADE_RUNTIME_FIELDS,
  menus: { classic: true, smart: true },
  hint: '让后面这条链跑多轮，本身不产图',
  smartHint: '控制运行轮数、批次和变量',
}
