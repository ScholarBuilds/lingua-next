/* 视频节点：云端模型出片，可接图片当首帧 */

import { IconVideo } from '../../../components/icons'
import { VideoNode } from '../CanvasNodes'
import { CASCADE_RUNTIME_FIELDS, EMPTY_NODE_W } from './definition'
import type { NodeDefinition } from './definition'

export const videoNodeDefinition: NodeDefinition = {
  type: 'video',
  label: '视频',
  icon: IconVideo,
  category: 'media',
  defaults: () => ({
    items: [],
    video_settings: { duration: 4, aspect_ratio: '16:9', resolution: '720p' },
  }),
  width: EMPTY_NODE_W,
  contentSized: true,
  ports: { in: ['image', 'video', 'audio', 'text', 'control'], out: ['video'] },
  get View() {
    return VideoNode
  },
  cardLike: false,
  toolbar: 'none',
  cascadeExecutable: true,
  taskTypes: ['video.generate'],
  runtimeFields: CASCADE_RUNTIME_FIELDS,
  menus: { classic: true, smart: false },
  hint: '云端模型或首帧生视频',
  generatorEngine: 'api-video',
}
