/* 图片节点：画布上的主角。空节点可文生图，接上游就是参考图编辑 */

import { IconImage, IconUpload } from '../../../components/icons'
import { ImageNode } from '../CanvasNodes'
import { CASCADE_RUNTIME_FIELDS, EMPTY_NODE_W } from './definition'
import type { NodeDefinition } from './definition'

export const imageNodeDefinition: NodeDefinition = {
  type: 'image',
  label: '图片',
  icon: IconImage,
  category: 'media',
  defaults: () => ({ items: [] }),
  width: EMPTY_NODE_W,
  contentSized: true,
  ports: { in: ['image', 'text', 'control'], out: ['image'] },
  get View() {
    return ImageNode
  },
  cardLike: false,
  toolbar: 'media',
  cascadeExecutable: true,
  taskTypes: [
    'image.generate',
    'image.edit',
    'image.upscale',
    // Midjourney 任务的**落点**也是图片节点，发起方才是 midjourney 节点
    'midjourney.generate',
    'midjourney.action',
  ],
  runtimeFields: CASCADE_RUNTIME_FIELDS,
  menus: { classic: true, smart: true },
  hint: '空节点，可文生图或接参考',
  smartLabel: '上传',
  smartHint: '图片、音频、视频都能导入',
  smartIcon: IconUpload,
  generatorEngine: 'api-image',
}
