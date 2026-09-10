import { describe, expect, it } from 'vitest'

import type { ModelDeployment, ModelPlugin } from '@/lib/api-config'

import {
  GPT_IMAGE_SIZES,
  appendLiveTask,
  autoGptImageSize,
  gptDeploymentsForScope,
  resolveGptImageSize,
  validateGptCustomSize,
} from './gpt-chat-controls'

function deployment(id: number, model: string, mediaTypes: string[] = []): ModelDeployment {
  return {
    id,
    credential_id: 10,
    credential_name: 'Provider',
    provider_type: 'openai',
    upstream_model_id: model,
    display_name: null,
    adapter_type: 'openai',
    media_types: mediaTypes,
    protocol_options: null,
    discovered: true,
    enabled: true,
    sort: 0,
    created_at: null,
    updated_at: null,
  }
}

const plugin: ModelPlugin = {
  id: 'openai',
  name: 'OpenAI',
  version: '1',
  description: '',
  media_types: ['chat', 'image'],
  operations: ['chat.stream', 'image.generate'],
  ready_operations: ['chat.stream', 'image.generate'],
  ready_media_types: ['chat', 'image'],
  provider_types: ['openai'],
  execution: 'direct',
  priority: 1,
}

describe('GPT chat model and image controls', () => {
  it('classifies legacy deployments with empty media types by model id', () => {
    const deployments = [deployment(1, 'gpt-5.4'), deployment(2, 'gpt-image-2')]
    expect(gptDeploymentsForScope(deployments, [plugin], 'chat').map((item) => item.id)).toEqual([1])
    expect(gptDeploymentsForScope(deployments, [plugin], 'image').map((item) => item.id)).toEqual([2])
  })

  it('requires the selected adapter to expose a ready operation', () => {
    expect(gptDeploymentsForScope([deployment(1, 'gpt-5.4')], [{ ...plugin, ready_operations: [] }], 'chat')).toEqual([])
  })

  it('keeps the seven source ratios and aligned runtime-safe presets', () => {
    expect(Object.keys(GPT_IMAGE_SIZES)).toHaveLength(7)
    expect(GPT_IMAGE_SIZES.story['2k']).toBe('1088x1920')
    for (const levels of Object.values(GPT_IMAGE_SIZES)) {
      for (const size of Object.values(levels)) {
        const [width, height] = size.split('x').map(Number)
        expect(width % 16).toBe(0)
        expect(height % 16).toBe(0)
        expect(Math.max(width, height)).toBeLessThanOrEqual(3840)
      }
    }
  })

  it('parses exact dimensions, ratios and resolution hints in auto mode', () => {
    expect(autoGptImageSize('画一张 1536×1024 的海报')).toBe('1536x1024')
    expect(autoGptImageSize('生成 9:16 2K 竖屏封面')).toBe('1088x1920')
    expect(autoGptImageSize('画一个方形图标')).toBe('1024x1024')
  })

  it('rejects invalid custom dimensions instead of correcting silently', () => {
    expect(validateGptCustomSize(1080, 1920)).toBeNull()
    expect(validateGptCustomSize(1088, 1920)).toBe('1088x1920')
    expect(resolveGptImageSize('custom', '', 'square', '1k', 128, 2048)).toBeNull()
  })
})


describe('长任务回执累积', () => {
  const task = (id: string, status = 'queued') => ({
    taskId: id, operation: 'image.edit', label: '图片编辑', status,
  })

  it('新回执按到达顺序追加', () => {
    const out = appendLiveTask(appendLiveTask([], task('t1')), task('t2'))
    expect(out.map((t) => t.taskId)).toEqual(['t1', 't2'])
  })

  /* 重连后服务端会把这一轮的回执重发一遍。不去重的话界面上就是两行一模一样的「已提交」 */
  it('同一个 task_id 只留一条，用后到的状态覆盖', () => {
    const out = appendLiveTask([task('t1', 'queued')], task('t1', 'running'))
    expect(out).toHaveLength(1)
    expect(out[0].status).toBe('running')
  })

  it('覆盖时不挪动原有位置', () => {
    const base = [task('t1'), task('t2'), task('t3')]
    const out = appendLiveTask(base, task('t2', 'succeeded'))
    expect(out.map((t) => t.taskId)).toEqual(['t1', 't2', 't3'])
    expect(out[1].status).toBe('succeeded')
  })

  it('不改原数组', () => {
    const base = [task('t1')]
    appendLiveTask(base, task('t2'))
    expect(base).toHaveLength(1)
  })
})
