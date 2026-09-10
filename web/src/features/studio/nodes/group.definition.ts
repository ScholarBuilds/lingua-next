/* 分组节点：画布中的画布。图被吸收成网格，提示词/循环作为成员叠在框上 */

import { IconSidebar } from '../../../components/icons'
import { GroupNode } from '../CanvasNodes'
import { CASCADE_RUNTIME_FIELDS } from './definition'
import type { NodeDefinition } from './definition'

export const groupNodeDefinition: NodeDefinition = {
  type: 'group',
  label: '分组',
  icon: IconSidebar,
  category: 'control',
  defaults: () => ({ title: '分组', items: [], member_ids: [] }),
  width: 340,
  contentSized: false,
  ports: { in: ['image', 'text', 'control'], out: ['image', 'text'] },
  get View() {
    return GroupNode
  },
  cardLike: true,
  toolbar: 'group',
  cascadeExecutable: false,
  taskTypes: [],
  runtimeFields: CASCADE_RUNTIME_FIELDS,
  menus: { classic: true, smart: true },
  hint: '收纳图片和控制节点',
  smartHint: '把提示词、图片、循环收进同一组',
}
