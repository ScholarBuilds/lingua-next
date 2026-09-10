/* 对话生图的 Midjourney 二次动作判据。
 *
 * 守的是一条会静默出错的规则：**动作入口只跟着引擎走**。别的引擎出的图没有上游
 * task id，按钮画出来点下去只能报错；而「按钮少了」和「按钮点了没反应」在界面上
 * 都不报错，只能靠这里拦。 */

import { describe, expect, it } from 'vitest'

import type { StudioTask } from '@/lib/api-studio'
import { midjourneyShotActions, midjourneyShots } from './chat-midjourney'

function task(over: Partial<StudioTask>): StudioTask {
  return {
    id: 't',
    domain: 'studio',
    tool_id: 'infinite-canvas',
    task_type: 'midjourney.generate',
    parent_task_id: null,
    batch_id: null,
    source_route: '/studio/chat/7',
    source_context: { chat_id: 7 },
    capability: 'midjourney',
    deployment_id: 5,
    invocation: { version: '7', speed: 'fast' },
    provider_task_id: 'p-1',
    canvas_id: null,
    node_id: null,
    execution_group_id: null,
    status: 'succeeded',
    stage: 'completed',
    progress: 100,
    result: { provider_task_id: 'p-1', asset_ids: [11, 12, 13, 14] },
    error: null,
    retryable: false,
    created_at: '2026-08-23T01:00:00+00:00',
    started_at: null,
    heartbeat_at: null,
    finished_at: null,
    event_seq: 0,
    updated_at: null,
    ...over,
  }
}

describe('二次动作只认 Midjourney 引擎', () => {
  it('宫格四张各自带自己的序号', () => {
    const shots = midjourneyShots([task({})], 7)
    expect([...shots.keys()]).toEqual([11, 12, 13, 14])
    expect(shots.get(13)).toMatchObject({
      providerTaskId: 'p-1',
      deploymentId: 5,
      version: '7',
      speed: 'fast',
      imageCount: 4,
      index: 3,
    })
    expect(midjourneyShotActions(shots.get(13)).map((a) => a.label)).toEqual(['U3', 'V3'])
  })

  it('别的引擎出的图一个动作都没有', () => {
    const other = task({
      id: 'v1',
      task_type: 'video.generate',
      result: { asset_ids: [21] },
    })
    const shots = midjourneyShots([other], 7)
    expect(shots.size).toBe(0)
    expect(midjourneyShotActions(shots.get(21))).toEqual([])
  })

  it('别的对话的任务不串味', () => {
    const elsewhere = task({ source_context: { chat_id: 8 }, result: { provider_task_id: 'p-9', asset_ids: [31] } })
    expect(midjourneyShots([elsewhere], 7).size).toBe(0)
  })

  it('没跑成功、没有上游 id、没有部署的都不给入口', () => {
    const failed = task({ id: 'f', status: 'failed', result: { asset_ids: [41] } })
    const noProvider = task({ id: 'n', result: { asset_ids: [42] } })
    const noDeployment = task({
      id: 'd',
      deployment_id: null,
      result: { provider_task_id: 'p-2', asset_ids: [43] },
    })
    expect(midjourneyShots([failed, noProvider, noDeployment], 7).size).toBe(0)
  })

  it('还要补遮罩的那一步不给入口——它自己就没出图', () => {
    const modal = task({
      id: 'm',
      task_type: 'midjourney.action',
      result: { provider_task_id: 'p-3', asset_ids: [], modal_required: true },
    })
    expect(midjourneyShots([modal], 7).size).toBe(0)
  })

  it('二次动作任务沿父任务继承版本，动作面板才不会换形态', () => {
    const generate = task({
      id: 'g',
      created_at: '2026-08-23T01:00:00+00:00',
      invocation: { version: '8.2', speed: 'relax' },
      result: { provider_task_id: 'p-a', asset_ids: [51, 52, 53, 54] },
    })
    // 二次动作的 invocation 里只有父任务的上游 id，没有版本
    const reroll = task({
      id: 'r',
      task_type: 'midjourney.action',
      created_at: '2026-08-23T01:05:00+00:00',
      invocation: { task_id: 'p-a', action: 'reroll', speed: 'relax' },
      result: { provider_task_id: 'p-b', asset_ids: [61, 62, 63, 64] },
    })
    // 顺序打乱也要能接上：台账按创建时间正序扫
    const shots = midjourneyShots([reroll, generate], 7)
    expect(shots.get(51)?.version).toBe('8.2')
    expect(shots.get(61)?.version).toBe('8.2')
    // v8.x 的宫格是重塑不是 U/V，与画布节点同一个判据
    expect(midjourneyShotActions(shots.get(62)).map((a) => a.label)).toEqual(['R2', 'R+2'])
  })

  it('放大后的单图给变体与重出', () => {
    const upscale = task({
      id: 'u',
      task_type: 'midjourney.action',
      invocation: { task_id: 'p-1', action: 'upscale', speed: 'relax' },
      result: { provider_task_id: 'p-c', asset_ids: [71] },
    })
    const shots = midjourneyShots([upscale], 7)
    expect(shots.get(71)?.imageCount).toBe(1)
    expect(midjourneyShotActions(shots.get(71)).map((a) => a.name)).toEqual([
      'low_variation',
      'high_variation',
      'reroll',
    ])
  })

  it('没有上下文就是没有按钮', () => {
    expect(midjourneyShotActions(undefined)).toEqual([])
  })
})
