/* 文件节点：文档类资产的落点。正文不进画布 JSON，由服务端按 id 现抽 */

import { IconFileText } from '../../../components/icons'
import { FileNode } from '../CanvasNodes'
import { CASCADE_RUNTIME_FIELDS } from './definition'
import type { NodeDefinition } from './definition'

export const fileNodeDefinition: NodeDefinition = {
  type: 'file',
  label: '文件',
  icon: IconFileText,
  category: 'media',
  defaults: () => ({ items: [] }),
  width: 316,
  contentSized: false,
  ports: { in: [], out: ['file'] },
  get View() {
    return FileNode
  },
  cardLike: false,
  toolbar: 'none',
  cascadeExecutable: false,
  taskTypes: [],
  runtimeFields: CASCADE_RUNTIME_FIELDS,
  menus: { classic: false, smart: false },
}
