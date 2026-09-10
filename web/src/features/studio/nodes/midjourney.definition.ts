/* Midjourney 节点：APIMart 原生任务，出图后还能放大、变体、局部重绘 */

import { Sparkles } from '@/components/NexusIcon'

import { MidjourneyNode } from '../CanvasNodes'
import { CASCADE_RUNTIME_FIELDS } from './definition'
import type { NodeDefinition } from './definition'

export const midjourneyNodeDefinition: NodeDefinition = {
  type: 'midjourney',
  label: 'Midjourney',
  icon: Sparkles,
  category: 'generator',
  defaults: () => ({
    title: 'Midjourney',
    mj_mode: 'imagine',
    mj_size: '1:1',
    mj_version: '8.2',
    mj_speed: 'relax',
  }),
  width: 440,
  contentSized: false,
  ports: { in: ['image', 'text', 'control'], out: ['image'] },
  get View() {
    return MidjourneyNode
  },
  cardLike: true,
  toolbar: 'none',
  cascadeExecutable: true,
  taskTypes: [],
  runtimeFields: [
    ...CASCADE_RUNTIME_FIELDS,
    /* 上游任务句柄与按钮表：刷新后由 `recoverCanvasImageTasks → updateMidjourneySource`
       从已完成的 midjourney 任务重新投影，存进画布 JSON 只会留下过期的按钮。
       `mj_modal_prompt` 不在此列——那是用户自己打的字，属于文档态。 */
    'mj_last_task_id',
    'mj_last_action',
    'mj_last_task_status',
    'mj_last_image_count',
    'mj_last_prompt',
    'mj_last_buttons',
    'mj_modal_task_id',
  ],
  menus: { classic: true, smart: false },
  hint: '生成后继续放大、变体和重绘',
}
