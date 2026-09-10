import { describe, expect, it } from 'vitest'

import type { StudioTask, StudioToolPlugin } from '@/lib/api-studio'

import {
  groupStudioTools,
  summarizeStudioActivity,
  toolGap,
  toolTone,
} from './toolRegistry'

function tool(over: Partial<StudioToolPlugin> & { id: string }): StudioToolPlugin {
  return {
    label: over.id,
    hint: '',
    category: 'create',
    status: 'ready',
    route: `/studio/${over.id}`,
    blueprint: 'ST-00',
    runtime_kind: 'page',
    capabilities: [],
    operation_contracts: {},
    surfaces: ['studio.home'],
    input_schema: {},
    output_schema: {},
    resume_policy: 'none',
    version: '1.0.0',
    generation: 1,
    ...over,
  } as StudioToolPlugin
}

function ids(tools: { id: string }[]): string[] {
  return tools.map((item) => item.id)
}

describe('工具状态归一', () => {
  it('已删掉的 partial 与未知值都按 beta 收', () => {
    expect(toolTone('ready')).toBe('ready')
    expect(toolTone('planned')).toBe('planned')
    expect(toolTone('beta')).toBe('beta')
    expect(toolTone('partial')).toBe('beta')
    expect(toolTone(' READY ')).toBe('ready')
    expect(toolTone('experimental')).toBe('beta')
  })

  it('gap 只认非空字符串，缺字段的旧后端返回 null', () => {
    expect(toolGap(tool({ id: 'a' }))).toBeNull()
    expect(toolGap({ ...tool({ id: 'a' }), gap: '  ' } as StudioToolPlugin)).toBeNull()
    expect(toolGap({ ...tool({ id: 'a' }), gap: 42 } as unknown as StudioToolPlugin)).toBeNull()
    expect(toolGap({ ...tool({ id: 'a' }), gap: ' 只支持单图 ' } as StudioToolPlugin)).toBe(
      '只支持单图',
    )
  })
})

describe('工坊卡片分组', () => {
  it('主力入口单独成段并按约定顺序排，不跟着服务端字母序走', () => {
    const sections = groupStudioTools([
      tool({ id: 'asset-library', category: 'manage' }),
      tool({ id: 'chat-image' }),
      tool({ id: 'infinite-canvas' }),
      tool({ id: 'image-console' }),
    ])
    expect(sections).toHaveLength(1)
    expect(sections[0].id).toBe('primary')
    expect(sections[0].lead).toBe(true)
    expect(ids(sections[0].tools)).toEqual([
      'infinite-canvas',
      'image-console',
      'chat-image',
      'asset-library',
    ])
  })

  it('分段按固定顺序输出，空段不出现', () => {
    const sections = groupStudioTools([
      tool({ id: 'update-backup', category: 'connect', status: 'planned', route: null }),
      tool({ id: 'prompt-library', category: 'manage' }),
      tool({ id: 'infinite-canvas' }),
      tool({ id: 'video-director' }),
    ])
    expect(sections.map((section) => section.id)).toEqual([
      'primary',
      'motion',
      'library',
      'connect',
    ])
  })

  it('没登记位置的新工具按服务端 category 落段，排在登记过的之后并保持服务端顺序', () => {
    const sections = groupStudioTools([
      tool({ id: 'brand-new-tool', category: 'create' }),
      tool({ id: 'another-new-tool', category: 'create' }),
      tool({ id: 'enhance' }),
      tool({ id: 'online-image' }),
    ])
    const image = sections.find((section) => section.id === 'image')
    expect(image).toBeDefined()
    expect(ids(image?.tools ?? [])).toEqual([
      'online-image',
      'enhance',
      'brand-new-tool',
      'another-new-tool',
    ])
  })

  it('planned 沉到本段末尾', () => {
    const sections = groupStudioTools([
      tool({ id: 'online-image', status: 'planned', route: null }),
      tool({ id: 'enhance', status: 'ready' }),
      tool({ id: 'angle-control', status: 'beta', gap: '只支持单图' }),
    ])
    expect(ids(sections[0].tools)).toEqual(['enhance', 'angle-control', 'online-image'])
  })

  it('每张卡都补上图标，未知 id 也有兜底', () => {
    const sections = groupStudioTools([tool({ id: 'infinite-canvas' }), tool({ id: 'x-unknown' })])
    for (const section of sections) {
      for (const item of section.tools) expect(item.icon).toBeTypeOf('object')
    }
  })
})

describe('首页活跃度', () => {
  function task(over: Partial<StudioTask> & { id: string }): StudioTask {
    return {
      domain: 'studio',
      tool_id: 'image-console',
      task_type: 'image.generate',
      parent_task_id: null,
      batch_id: null,
      source_route: null,
      source_context: null,
      capability: null,
      deployment_id: null,
      invocation: null,
      provider_task_id: null,
      canvas_id: null,
      node_id: null,
      execution_group_id: null,
      status: 'succeeded',
      stage: null,
      progress: 1,
      result: null,
      error: null,
      retryable: false,
      created_at: null,
      started_at: null,
      heartbeat_at: null,
      finished_at: null,
      event_seq: 0,
      updated_at: null,
      ...over,
    } as StudioTask
  }

  // 判据是本地自然日，所以时间一律用本地构造，避免测试跟着机器时区飘
  const now = new Date(2026, 7, 22, 21, 0, 0)
  const iso = (day: number, hour: number, minute: number) =>
    new Date(2026, 7, day, hour, minute).toISOString()

  it('活跃态计进行中，只有当天完成的成功任务计今天完成', () => {
    const activity = summarizeStudioActivity(
      [
        task({ id: '1', status: 'running' }),
        task({ id: '2', status: 'queued' }),
        task({ id: '3', status: 'succeeded', finished_at: iso(22, 9, 30) }),
        task({ id: '4', status: 'succeeded', finished_at: iso(21, 23, 59) }),
        // 失败与没有完成时间的行都不算完成
        task({ id: '5', status: 'failed', finished_at: iso(22, 10, 0) }),
        task({ id: '6', status: 'succeeded', finished_at: null }),
        task({ id: '7', status: 'succeeded', finished_at: 'not-a-date' }),
      ],
      now,
    )
    expect(activity).toEqual({ running: 2, doneToday: 1 })
  })

  it('空列表返回两个零', () => {
    expect(summarizeStudioActivity([], now)).toEqual({ running: 0, doneToday: 0 })
  })
})
