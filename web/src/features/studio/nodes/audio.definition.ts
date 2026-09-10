/* 音频节点：只装资产，不发起调用 */

import { IconSpeaker } from '../../../components/icons'
import { AudioNode } from '../CanvasNodes'
import { CASCADE_RUNTIME_FIELDS } from './definition'
import type { NodeDefinition } from './definition'

export const audioNodeDefinition: NodeDefinition = {
  type: 'audio',
  label: '音频',
  icon: IconSpeaker,
  category: 'media',
  defaults: () => ({ items: [] }),
  width: 316,
  contentSized: false,
  ports: { in: [], out: ['audio'] },
  get View() {
    return AudioNode
  },
  cardLike: false,
  toolbar: 'none',
  cascadeExecutable: false,
  taskTypes: [],
  runtimeFields: CASCADE_RUNTIME_FIELDS,
  menus: { classic: false, smart: false },
}
