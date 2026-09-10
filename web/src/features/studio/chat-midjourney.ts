/* 对话生图里的 Midjourney 二次动作（放大 / 变体 / 重塑 / 缩放 / 平移）。

   为什么要单独一层：画布上二次动作的上下文长在节点属性里（`mj_last_task_id`
   之类），对话没有节点。对话能靠的只有**任务台账**——`midjourney.generate` 与
   `midjourney.action` 的 StudioTask 里已经持久化了上游 task id、出图数与产出的
   资产 id，刷新页面后照样读得到，不用另建一份会和台账对不上的本地状态。

   判据只认引擎，不猜：一张图能不能接着放大 / 变体，取决于**它是不是某条
   Midjourney 任务的产物**。别的引擎（gpt-image、即梦、ModelScope…）没有上游
   task id 也没有 U/V 概念，按钮一律不出现——出现了点下去只能报错。 */

import type { StudioTask } from '@/lib/api-studio'
import { midjourneyActionLayout } from './canvasStore'
import type { MidjourneyActionLayout } from './canvasStore'

export const MIDJOURNEY_VERSIONS = ['8.2', '8.1', '7', '6.1', '5.2', '5.1'] as const
export type MidjourneyVersion = (typeof MIDJOURNEY_VERSIONS)[number]

export const MIDJOURNEY_SPEEDS = ['relax', 'fast', 'turbo'] as const
export type MidjourneySpeed = (typeof MIDJOURNEY_SPEEDS)[number]

/** 默认版本跟画布节点保持一致，换了一处两边就会给出不同的动作面板 */
export const DEFAULT_MIDJOURNEY_VERSION: MidjourneyVersion = '8.2'

/** 一张图能接着做什么。缺任何一项都不给动作入口——宁可不给，不给错的 */
export interface MidjourneyShot {
  /** 上游任务 id，二次动作的必填参数 */
  providerTaskId: string
  deploymentId: number
  version: MidjourneyVersion
  speed: MidjourneySpeed
  /** 这一批出了几张图：4 张是宫格，1 张是已放大的单图，动作面板不一样 */
  imageCount: number
  /** 这张图在宫格里的序号（1–4）。U1/V1 靠它 */
  index: number
}

function textField(source: Record<string, unknown> | null | undefined, key: string): string {
  const value = source?.[key]
  return typeof value === 'string' ? value : ''
}

function assetIds(result: Record<string, unknown> | null | undefined): number[] {
  const raw = result?.asset_ids
  if (!Array.isArray(raw)) return []
  return raw.filter((value): value is number => Number.isInteger(value) && (value as number) > 0)
}

function asVersion(value: string): MidjourneyVersion | null {
  return (MIDJOURNEY_VERSIONS as readonly string[]).includes(value)
    ? (value as MidjourneyVersion)
    : null
}

function asSpeed(value: string): MidjourneySpeed {
  return (MIDJOURNEY_SPEEDS as readonly string[]).includes(value)
    ? (value as MidjourneySpeed)
    : 'relax'
}

/** 是不是这场对话发起的 Midjourney 任务。两个条件缺一不可：
 *  任务类型是 midjourney.*，且 source_context 指向这场对话。 */
export function isChatMidjourneyTask(task: StudioTask, chatId: number): boolean {
  if (!task.task_type.startsWith('midjourney.')) return false
  const context = task.source_context
  return typeof context?.chat_id === 'number' && context.chat_id === chatId
}

/** 台账 → 「资产 id 能接着做什么」。
 *
 *  按创建时间正序扫一遍：二次动作任务自己不记版本，只记父任务的上游 id，
 *  所以先扫到的 generate 把版本登记下来，后面的 action 顺着 `invocation.task_id`
 *  继承。继承不到就退回默认版本——退回的后果只是动作面板形态可能不对，
 *  比凭空猜一个版本号强。 */
export function midjourneyShots(tasks: StudioTask[], chatId: number): Map<number, MidjourneyShot> {
  const ordered = [...tasks].sort((left, right) =>
    (left.created_at ?? '').localeCompare(right.created_at ?? ''),
  )
  const versions = new Map<string, MidjourneyVersion>()
  const shots = new Map<number, MidjourneyShot>()
  for (const task of ordered) {
    if (!isChatMidjourneyTask(task, chatId)) continue
    if (task.status !== 'succeeded') continue
    const providerTaskId = textField(task.result, 'provider_task_id')
    if (providerTaskId === '') continue
    const parentId = textField(task.invocation, 'task_id')
    const version =
      asVersion(textField(task.invocation, 'version')) ??
      versions.get(parentId) ??
      DEFAULT_MIDJOURNEY_VERSION
    versions.set(providerTaskId, version)
    // 还要补遮罩的那一步没出图，接着动作只会撞在同一个 modal 上
    if (task.result?.modal_required === true) continue
    const deploymentId = task.deployment_id
    if (deploymentId === null || deploymentId <= 0) continue
    const ids = assetIds(task.result)
    ids.forEach((assetId, position) => {
      shots.set(assetId, {
        providerTaskId,
        deploymentId,
        version,
        speed: asSpeed(textField(task.invocation, 'speed')),
        imageCount: ids.length,
        index: position + 1,
      })
    })
  }
  return shots
}

export interface MidjourneyShotAction {
  /** 传给 /studio/midjourney/actions 的 action 名 */
  name:
    | 'upscale'
    | 'variation'
    | 'remix_strong'
    | 'remix_subtle'
    | 'low_variation'
    | 'high_variation'
    | 'reroll'
  label: string
  title: string
  /** 宫格动作要带序号；单图动作不带 */
  index?: number
}

/** 一张图旁边摆哪几个按钮。形态完全由 `midjourneyActionLayout` 决定，
 *  和画布节点同一个判据——两边给出不同按钮的话，用户会以为对话少了功能。 */
export function midjourneyShotActions(shot: MidjourneyShot | undefined): MidjourneyShotAction[] {
  if (shot === undefined) return []
  const layout: MidjourneyActionLayout = midjourneyActionLayout(shot.version, shot.imageCount)
  if (layout === 'legacy-grid') {
    return [
      { name: 'upscale', label: `U${shot.index}`, title: '放大这一张', index: shot.index },
      { name: 'variation', label: `V${shot.index}`, title: '按这一张出变体', index: shot.index },
    ]
  }
  if (layout === 'remix-grid') {
    return [
      {
        name: 'remix_subtle',
        label: `R${shot.index}`,
        title: '弱重塑：保留构图微调',
        index: shot.index,
      },
      {
        name: 'remix_strong',
        label: `R+${shot.index}`,
        title: '强重塑：大幅改写',
        index: shot.index,
      },
    ]
  }
  if (layout === 'single') {
    return [
      { name: 'low_variation', label: '弱变体', title: '小幅变化' },
      { name: 'high_variation', label: '强变体', title: '大幅变化' },
      { name: 'reroll', label: '重出', title: '按原提示词重新生成' },
    ]
  }
  return []
}
