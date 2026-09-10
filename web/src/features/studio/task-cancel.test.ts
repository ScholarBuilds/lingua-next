import { describe, expect, it } from 'vitest'

import { canCancelTask, CANCELLABLE_TASK_STATUSES, TERMINAL_TASK_STATUSES } from './taskActions'

describe('canCancelTask', () => {
  it('未收口的四个状态都能请求取消', () => {
    expect(canCancelTask({ status: 'queued' })).toBe(true)
    expect(canCancelTask({ status: 'submitting' })).toBe(true)
    expect(canCancelTask({ status: 'running' })).toBe(true)
    expect(canCancelTask({ status: 'recovering' })).toBe(true)
  })

  it('终态不能取消——服务端会 409', () => {
    expect(canCancelTask({ status: 'succeeded' })).toBe(false)
    expect(canCancelTask({ status: 'partial' })).toBe(false)
    expect(canCancelTask({ status: 'failed' })).toBe(false)
    expect(canCancelTask({ status: 'cancelled' })).toBe(false)
  })

  it('可取消集合与终态集合互斥且覆盖全部 8 态', () => {
    const overlap = [...CANCELLABLE_TASK_STATUSES].filter((s) => TERMINAL_TASK_STATUSES.has(s))
    expect(overlap).toEqual([])
    expect(CANCELLABLE_TASK_STATUSES.size + TERMINAL_TASK_STATUSES.size).toBe(8)
  })
})
