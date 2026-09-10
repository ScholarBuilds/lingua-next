/* 级联 run 轮询等待器：SSE flow 帧是加速通道，定时轮询是兜底。
   守三条：本 run 的帧立刻唤醒；别的 run 的帧不唤醒；拉取进行中到达的帧下一轮免等。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { StudioFlowRun } from '@/lib/api-studio'

type FlowListener = (run: StudioFlowRun) => void

const flowListeners = new Set<FlowListener>()

vi.mock('./taskEvents', () => ({
  subscribeTaskEvents: () => () => {},
  subscribeFlowEvents: (listener: FlowListener) => {
    flowListeners.add(listener)
    return () => flowListeners.delete(listener)
  },
  onTaskStreamConnected: () => () => {},
}))

function frame(id: string): StudioFlowRun {
  return {
    id,
    flow_id: null,
    parent_run_id: null,
    flow_version: 1,
    status: 'running',
    error: null,
    inputs: {},
    source_context: null,
    checkpoint: { version: 1, nodes: {} },
    progress: 0,
    created_at: null,
    started_at: null,
    heartbeat_at: null,
    finished_at: null,
    updated_at: null,
  }
}

function push(id: string): void {
  for (const listener of flowListeners) listener(frame(id))
}

async function settled(promise: Promise<void>): Promise<boolean> {
  let done = false
  void promise.then(() => {
    done = true
  })
  await Promise.resolve()
  await Promise.resolve()
  return done
}

beforeEach(() => {
  vi.useFakeTimers()
  flowListeners.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('cascadeRunWaiter', () => {
  it('没有帧时等满周期才返回', async () => {
    const { cascadeRunWaiter } = await import('./canvasStore')
    const waiter = cascadeRunWaiter('run-1')
    const wait = waiter.wait(1500)
    vi.advanceTimersByTime(1499)
    expect(await settled(wait)).toBe(false)
    vi.advanceTimersByTime(1)
    expect(await settled(wait)).toBe(true)
    waiter.dispose()
  })

  it('本 run 的 flow 帧立刻唤醒，别的 run 的帧不唤醒', async () => {
    const { cascadeRunWaiter } = await import('./canvasStore')
    const waiter = cascadeRunWaiter('run-1')
    const wait = waiter.wait(1500)
    push('run-other')
    expect(await settled(wait)).toBe(false)
    push('run-1')
    expect(await settled(wait)).toBe(true)
    waiter.dispose()
  })

  it('拉取进行中到达的帧记成 pending，下一轮免等；只抵一轮', async () => {
    const { cascadeRunWaiter } = await import('./canvasStore')
    const waiter = cascadeRunWaiter('run-1')
    push('run-1')
    expect(await settled(waiter.wait(1500))).toBe(true)
    const second = waiter.wait(1500)
    expect(await settled(second)).toBe(false)
    vi.advanceTimersByTime(1500)
    expect(await settled(second)).toBe(true)
    waiter.dispose()
  })

  it('dispose 后退订，帧不再唤醒', async () => {
    const { cascadeRunWaiter } = await import('./canvasStore')
    const waiter = cascadeRunWaiter('run-1')
    const waiting = waiter.wait(1500)
    expect(await settled(waiting)).toBe(false)
    waiter.dispose()
    expect(await settled(waiting)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(flowListeners.size).toBe(0)
  })
})
