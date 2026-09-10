/* 输出节点：一次运行的产物组。可整体转成输入组，或打包下载 */

import { IconDownload } from '../../../components/icons'
import { OutputNode } from '../CanvasNodes'
import { CASCADE_RUNTIME_FIELDS } from './definition'
import type { NodeDefinition } from './definition'

export const outputNodeDefinition: NodeDefinition = {
  type: 'output',
  label: '输出',
  icon: IconDownload,
  category: 'media',
  defaults: () => ({ items: [] }),
  width: 420,
  contentSized: true,
  ports: {
    in: ['image', 'video', 'audio', 'file'],
    out: ['image', 'video', 'audio', 'file'],
  },
  get View() {
    return OutputNode
  },
  /* 裸媒体，不是卡片。输出节点装的就是图/视频/音频，和图片节点装的东西一模一样；
     给它套白卡片 + 带分隔线的标题栏，同一张图摆在输出节点里就比摆在图片节点里
     重一大截，画布上一眼看去像两种东西。标题收成浮在左上角的小徽标
     （canvas.css 的 `.cvc-node:not(.cvc-node-card)` 那一族）。 */
  cardLike: false,
  toolbar: 'none',
  cascadeExecutable: false,
  taskTypes: [],
  runtimeFields: CASCADE_RUNTIME_FIELDS,
  menus: { classic: false, smart: false },
}
