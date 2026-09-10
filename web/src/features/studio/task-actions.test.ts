import { describe, expect, it } from 'vitest'

import { canRerunTask } from './taskActions'

describe('canRerunTask', () => {
  it('只允许统一执行器支持的终态任务再次运行', () => {
    expect(canRerunTask({ status: 'succeeded', task_type: 'image.generate' })).toBe(true)
    expect(canRerunTask({ status: 'failed', task_type: 'workflow.comfyui' })).toBe(true)
    expect(canRerunTask({ status: 'running', task_type: 'image.generate' })).toBe(false)
    expect(canRerunTask({ status: 'succeeded', task_type: 'asset.tag' })).toBe(false)
  })
})
