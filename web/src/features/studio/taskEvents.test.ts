/* 任务事件流重连控制器的守卫（调研 §2.8 V3c · §6 P0 ③）。
 *
   浏览器 EventSource 遇到非 200 / 非 event-stream 响应会直接 CLOSED 且不再重试，
   旧实现没挂 onerror，订阅者活着期间连接永远不会重建。这里钉住四件事：
   error 后按指数退避重建、open 触发 onConnected 并重置退避、退订归零后不再重建、
   flow / canvas 帧分发给各自订阅者且不推进游标。

   测试跑在 node 里（本仓 vitest 没配 jsdom），EventSource / window.localStorage 都要自己搭桩；
   每个用例 resetModules 后动态 import，拿到一个干净的控制器单例。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PipelineEventFrame } from '@/lib/api-pipeline'
import type { CanvasEventFrame, StudioFlowRun, StudioTaskEvent } from '@/lib/api-studio'

type Handler = (event: { data: string }) => void

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readyState = 0
  closed = false
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  private readonly handlers = new Map<string, Set<Handler>>()

  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, handler: Handler): void {
    const set = this.handlers.get(type) ?? new Set<Handler>()
    set.add(handler)
    this.handlers.set(type, set)
  }

  close(): void {
    this.closed = true
    this.readyState = 2
  }

  open(): void {
    this.readyState = 1
    this.onopen?.()
  }

  fail(): void {
    this.readyState = 2
    this.onerror?.()
  }

  emit(type: string, data: string): void {
    for (const handler of this.handlers.get(type) ?? []) handler({ data })
  }
}

const g = globalThis as Record<string, unknown>

function fakeStorage(seed: Record<string, string> = {}): Map<string, string> {
  const map = new Map(Object.entries(seed))
  g.window = {
    localStorage: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    },
  }
  return map
}

const CURSOR_KEY = 'lingua.studio-task-event-cursor.v1'

function taskFrame(cursor: number, taskId = 'task-1'): string {
  const event: StudioTaskEvent = {
    cursor,
    task_id: taskId,
    seq: cursor,
    event_type: 'progress',
    status: 'running',
    stage: null,
    progress: 50,
    message: null,
    payload: null,
    canvas_id: null,
    node_id: null,
    created_at: null,
  }
  return JSON.stringify(event)
}

function flowFrame(id = 'run-1', status = 'running'): string {
  const run: StudioFlowRun = {
    id,
    flow_id: null,
    parent_run_id: null,
    flow_version: 1,
    status,
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
  return JSON.stringify(run)
}

function canvasFrame(canvasId: number, version: number, origin: 'save' | 'projector' = 'save'): string {
  const frame: CanvasEventFrame = {
    canvas_id: canvasId,
    version,
    updated_at: '2026-08-22T10:00:00+00:00',
    origin,
    landed: origin === 'projector' ? [{ node_id: 'n1', task_id: 't1', flow_run_id: null, added: 2 }] : [],
  }
  return JSON.stringify(frame)
}

function pipelineFrame(runId: number, status = 'running'): string {
  const frame: PipelineEventFrame = {
    run_id: runId,
    domain: 'video',
    subject_id: 12,
    title: '演示视频',
    kind: 'ingest',
    status,
    progress: 40,
    error: null,
    current_step: 'transcribe',
    current_label: '转写中',
    failed_steps: [],
    done_steps: 2,
    total_steps: 8,
    started_at: '2026-08-22T10:00:00+00:00',
    finished_at: null,
    updated_at: '2026-08-22T10:00:05+00:00',
  }
  return JSON.stringify(frame)
}

async function load(): Promise<typeof import('./taskEvents')> {
  vi.resetModules()
  return import('./taskEvents')
}

function latest(): FakeEventSource {
  return FakeEventSource.instances[FakeEventSource.instances.length - 1]
}

beforeEach(() => {
  vi.useFakeTimers()
  // 抖动归零，退避时长可以精确断言
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
  FakeEventSource.instances = []
  g.EventSource = FakeEventSource
  fakeStorage()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete g.EventSource
  delete g.window
})

describe('backoffDelay', () => {
  it('1s 起步翻倍，封顶 30s', async () => {
    const { backoffDelay } = await load()
    const mid = () => 0.5
    expect([0, 1, 2, 3, 4, 5, 9].map((n) => backoffDelay(n, mid))).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ])
  })

  it('抖动 ±10%', async () => {
    const { backoffDelay } = await load()
    expect(backoffDelay(0, () => 0)).toBe(900)
    expect(backoffDelay(0, () => 1)).toBe(1100)
    expect(backoffDelay(5, () => 1)).toBe(33000)
  })
})

describe('连接与游标', () => {
  it('首连带上 localStorage 里的游标', async () => {
    fakeStorage({ [CURSOR_KEY]: '42' })
    const { subscribeTaskEvents } = await load()
    const off = subscribeTaskEvents(() => {})
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(latest().url).toBe('/api/studio/tasks/events/stream?after=42')
    off()
  })

  it('task 帧分发给订阅者并记住游标', async () => {
    const store = fakeStorage()
    const { subscribeTaskEvents } = await load()
    const received: StudioTaskEvent[] = []
    const off = subscribeTaskEvents((event) => received.push(event))
    latest().emit('task', taskFrame(7))
    expect(received.map((e) => e.cursor)).toEqual([7])
    expect(store.get(CURSOR_KEY)).toBe('7')
    off()
  })

  it('畸形 data 不中断后续帧', async () => {
    const { subscribeTaskEvents } = await load()
    const received: StudioTaskEvent[] = []
    const off = subscribeTaskEvents((event) => received.push(event))
    latest().emit('task', '{not json')
    latest().emit('task', '')
    latest().emit('task', JSON.stringify({ cursor: 'x', task_id: 1 }))
    latest().emit('task', taskFrame(3))
    expect(received.map((e) => e.cursor)).toEqual([3])
    off()
  })

  it('一个订阅者抛错，同一帧的其他订阅者照常收到', async () => {
    const { subscribeTaskEvents } = await load()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const received: number[] = []
    const offBad = subscribeTaskEvents(() => {
      throw new Error('订阅者自己的 bug')
    })
    const offGood = subscribeTaskEvents((event) => received.push(event.cursor))
    latest().emit('task', taskFrame(9))
    expect(received).toEqual([9])
    offBad()
    offGood()
  })

  it('多个订阅者复用同一条连接，全部退订才关', async () => {
    const { subscribeFlowEvents, subscribeTaskEvents } = await load()
    const offA = subscribeTaskEvents(() => {})
    const offB = subscribeTaskEvents(() => {})
    const offC = subscribeFlowEvents(() => {})
    expect(FakeEventSource.instances).toHaveLength(1)
    offA()
    offB()
    expect(latest().closed).toBe(false)
    offC()
    expect(latest().closed).toBe(true)
  })

  it('没有 EventSource 的环境（SSR）订阅不抛', async () => {
    delete g.EventSource
    const { subscribeTaskEvents } = await load()
    expect(() => subscribeTaskEvents(() => {})()).not.toThrow()
  })
})

describe('error 后退避重建', () => {
  it('按 1s → 2s → 4s 重建，重建时带上最新游标', async () => {
    const { subscribeTaskEvents } = await load()
    const off = subscribeTaskEvents(() => {})
    const first = latest()
    first.emit('task', taskFrame(5))
    first.fail()
    expect(first.closed).toBe(true)
    expect(FakeEventSource.instances).toHaveLength(1)

    vi.advanceTimersByTime(999)
    expect(FakeEventSource.instances).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(FakeEventSource.instances).toHaveLength(2)
    expect(latest().url).toBe('/api/studio/tasks/events/stream?after=5')

    latest().fail()
    vi.advanceTimersByTime(1999)
    expect(FakeEventSource.instances).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(FakeEventSource.instances).toHaveLength(3)

    latest().fail()
    vi.advanceTimersByTime(3999)
    expect(FakeEventSource.instances).toHaveLength(3)
    vi.advanceTimersByTime(1)
    expect(FakeEventSource.instances).toHaveLength(4)
    off()
  })

  it('连续失败封顶 30s', async () => {
    const { subscribeTaskEvents } = await load()
    const off = subscribeTaskEvents(() => {})
    for (let i = 0; i < 8; i += 1) {
      latest().fail()
      vi.advanceTimersByTime(30_000)
    }
    const before = FakeEventSource.instances.length
    latest().fail()
    vi.advanceTimersByTime(29_999)
    expect(FakeEventSource.instances).toHaveLength(before)
    vi.advanceTimersByTime(1)
    expect(FakeEventSource.instances).toHaveLength(before + 1)
    off()
  })

  it('旧连接关闭后的迟到帧不再分发', async () => {
    const { subscribeTaskEvents } = await load()
    const received: number[] = []
    const off = subscribeTaskEvents((event) => received.push(event.cursor))
    const first = latest()
    first.fail()
    vi.advanceTimersByTime(1000)
    expect(FakeEventSource.instances).toHaveLength(2)
    first.emit('task', taskFrame(11))
    expect(received).toEqual([])
    latest().emit('task', taskFrame(12))
    expect(received).toEqual([12])
    off()
  })
})

describe('open 与 onConnected', () => {
  it('连接/重连成功都触发 onConnected，并把退避重置回 1s', async () => {
    const { onTaskStreamConnected, subscribeTaskEvents } = await load()
    let connected = 0
    const offConnected = onTaskStreamConnected(() => {
      connected += 1
    })
    const off = subscribeTaskEvents(() => {})
    latest().open()
    expect(connected).toBe(1)

    latest().fail()
    vi.advanceTimersByTime(1000)
    latest().fail()
    vi.advanceTimersByTime(2000)
    expect(FakeEventSource.instances).toHaveLength(3)
    latest().open()
    expect(connected).toBe(2)

    // 成功过一次，下一次失败从 1s 重新起步
    latest().fail()
    vi.advanceTimersByTime(1000)
    expect(FakeEventSource.instances).toHaveLength(4)
    off()
    offConnected()
  })

  it('onConnected 退订后不再触发，且单独登记不会拉起连接', async () => {
    const { onTaskStreamConnected, subscribeTaskEvents } = await load()
    let connected = 0
    const offConnected = onTaskStreamConnected(() => {
      connected += 1
    })
    expect(FakeEventSource.instances).toHaveLength(0)
    const off = subscribeTaskEvents(() => {})
    offConnected()
    latest().open()
    expect(connected).toBe(0)
    off()
  })
})

describe('退订归零', () => {
  it('关闭连接并取消待执行的重连', async () => {
    const { subscribeTaskEvents } = await load()
    const off = subscribeTaskEvents(() => {})
    latest().fail()
    off()
    vi.advanceTimersByTime(120_000)
    expect(FakeEventSource.instances).toHaveLength(1)
  })

  it('重新订阅从头建连，退避从 1s 重新起步', async () => {
    const { subscribeTaskEvents } = await load()
    const off = subscribeTaskEvents(() => {})
    latest().fail()
    vi.advanceTimersByTime(1000)
    latest().fail()
    off()
    expect(FakeEventSource.instances).toHaveLength(2)

    const again = subscribeTaskEvents(() => {})
    expect(FakeEventSource.instances).toHaveLength(3)
    latest().fail()
    vi.advanceTimersByTime(1000)
    expect(FakeEventSource.instances).toHaveLength(4)
    again()
  })
})

describe('flow 帧', () => {
  it('分发给 flow 订阅者，task 订阅者不受影响，游标不动', async () => {
    const store = fakeStorage()
    const { subscribeFlowEvents, subscribeTaskEvents } = await load()
    const runs: StudioFlowRun[] = []
    const tasks: StudioTaskEvent[] = []
    const offFlow = subscribeFlowEvents((run) => runs.push(run))
    const offTask = subscribeTaskEvents((event) => tasks.push(event))
    latest().emit('flow', flowFrame('run-9', 'running'))
    latest().emit('flow', '{broken')
    latest().emit('flow', JSON.stringify({ id: 1 }))
    latest().emit('flow', flowFrame('run-9', 'succeeded'))
    expect(runs.map((r) => [r.id, r.status])).toEqual([['run-9', 'running'], ['run-9', 'succeeded']])
    expect(tasks).toEqual([])
    expect(store.has(CURSOR_KEY)).toBe(false)
    offFlow()
    offTask()
  })

  it('只有 flow 订阅者时也会建连', async () => {
    const { subscribeFlowEvents } = await load()
    const off = subscribeFlowEvents(() => {})
    expect(FakeEventSource.instances).toHaveLength(1)
    off()
    expect(latest().closed).toBe(true)
  })
})

describe('canvas 帧', () => {
  it('分发给 canvas 订阅者，task/flow 订阅者不受影响，游标不动', async () => {
    const store = fakeStorage()
    const { subscribeCanvasEvents, subscribeFlowEvents, subscribeTaskEvents } = await load()
    const frames: CanvasEventFrame[] = []
    const tasks: StudioTaskEvent[] = []
    const runs: StudioFlowRun[] = []
    const offCanvas = subscribeCanvasEvents((frame) => frames.push(frame))
    const offTask = subscribeTaskEvents((event) => tasks.push(event))
    const offFlow = subscribeFlowEvents((run) => runs.push(run))
    latest().emit('canvas', canvasFrame(7, 4))
    latest().emit('canvas', canvasFrame(7, 5, 'projector'))
    expect(frames.map((f) => [f.canvas_id, f.version, f.origin, f.landed.length])).toEqual([
      [7, 4, 'save', 0],
      [7, 5, 'projector', 1],
    ])
    expect(frames[1].landed[0]).toEqual({ node_id: 'n1', task_id: 't1', flow_run_id: null, added: 2 })
    expect(tasks).toEqual([])
    expect(runs).toEqual([])
    expect(store.has(CURSOR_KEY)).toBe(false)
    offCanvas()
    offTask()
    offFlow()
  })

  it('缺字段容错补齐；canvas_id / version 不是整数的帧整帧丢弃', async () => {
    const { subscribeCanvasEvents } = await load()
    const frames: CanvasEventFrame[] = []
    const off = subscribeCanvasEvents((frame) => frames.push(frame))
    latest().emit('canvas', '{broken')
    latest().emit('canvas', '')
    latest().emit('canvas', JSON.stringify({ canvas_id: '7', version: 4 }))
    latest().emit('canvas', JSON.stringify({ canvas_id: 7, version: 4.5 }))
    latest().emit('canvas', JSON.stringify({ canvas_id: 7, version: 4 }))
    latest().emit(
      'canvas',
      JSON.stringify({
        canvas_id: 7,
        version: 5,
        origin: 'unknown',
        landed: [{ node_id: 'n1', added: 'x' }, { task_id: 'no-node' }, null],
      }),
    )
    expect(frames).toEqual([
      { canvas_id: 7, version: 4, updated_at: '', origin: 'save', landed: [] },
      {
        canvas_id: 7,
        version: 5,
        updated_at: '',
        origin: 'save',
        landed: [{ node_id: 'n1', task_id: null, flow_run_id: null, added: 0 }],
      },
    ])
    off()
  })

  it('只有 canvas 订阅者时也会建连；三类订阅者全退订才关', async () => {
    const { subscribeCanvasEvents, subscribeFlowEvents, subscribeTaskEvents } = await load()
    const offCanvas = subscribeCanvasEvents(() => {})
    expect(FakeEventSource.instances).toHaveLength(1)
    const offTask = subscribeTaskEvents(() => {})
    const offFlow = subscribeFlowEvents(() => {})
    expect(FakeEventSource.instances).toHaveLength(1)
    offTask()
    offFlow()
    expect(latest().closed).toBe(false)
    offCanvas()
    expect(latest().closed).toBe(true)
    vi.advanceTimersByTime(120_000)
    expect(FakeEventSource.instances).toHaveLength(1)
  })

  it('旧连接关闭后的迟到 canvas 帧不再分发', async () => {
    const { subscribeCanvasEvents } = await load()
    const versions: number[] = []
    const off = subscribeCanvasEvents((frame) => versions.push(frame.version))
    const first = latest()
    first.fail()
    vi.advanceTimersByTime(1000)
    expect(FakeEventSource.instances).toHaveLength(2)
    first.emit('canvas', canvasFrame(7, 4))
    expect(versions).toEqual([])
    latest().emit('canvas', canvasFrame(7, 5))
    expect(versions).toEqual([5])
    off()
  })
})

describe('pipeline 帧', () => {
  it('分发给 pipeline 订阅者，task/flow 订阅者不受影响，游标不动', async () => {
    const store = fakeStorage()
    const { subscribeFlowEvents, subscribePipelineEvents, subscribeTaskEvents } = await load()
    const frames: PipelineEventFrame[] = []
    const tasks: StudioTaskEvent[] = []
    const runs: StudioFlowRun[] = []
    const offPipeline = subscribePipelineEvents((frame) => frames.push(frame))
    const offTask = subscribeTaskEvents((event) => tasks.push(event))
    const offFlow = subscribeFlowEvents((run) => runs.push(run))
    latest().emit('pipeline', pipelineFrame(31, 'running'))
    latest().emit('pipeline', pipelineFrame(31, 'success'))
    expect(frames.map((f) => [f.run_id, f.status, f.progress])).toEqual([
      [31, 'running', 40],
      [31, 'success', 40],
    ])
    expect(frames[0].current_label).toBe('转写中')
    expect(tasks).toEqual([])
    expect(runs).toEqual([])
    expect(store.has(CURSOR_KEY)).toBe(false)
    offPipeline()
    offTask()
    offFlow()
  })

  it('字段归一：id 兼容 run_id、video_id 兜底 subject_id、progress 夹取、failed_steps 只留字符串', async () => {
    const { subscribePipelineEvents } = await load()
    const frames: PipelineEventFrame[] = []
    const off = subscribePipelineEvents((frame) => frames.push(frame))
    latest().emit(
      'pipeline',
      JSON.stringify({
        id: 7,
        domain: 'video',
        video_id: 5,
        status: 'running',
        progress: 140,
        failed_steps: ['transcribe', 3, null],
      }),
    )
    expect(frames).toEqual([
      {
        run_id: 7,
        domain: 'video',
        subject_id: 5,
        title: '',
        kind: '',
        status: 'running',
        progress: 100,
        error: null,
        current_step: null,
        current_label: null,
        failed_steps: ['transcribe'],
        done_steps: 0,
        total_steps: 0,
        started_at: null,
        finished_at: null,
        updated_at: null,
      },
    ])
    off()
  })

  it('缺 run_id / domain / status 的帧与畸形 data 整帧丢弃，不影响后续帧', async () => {
    const { subscribePipelineEvents } = await load()
    const frames: PipelineEventFrame[] = []
    const off = subscribePipelineEvents((frame) => frames.push(frame))
    latest().emit('pipeline', '{broken')
    latest().emit('pipeline', '')
    latest().emit('pipeline', JSON.stringify({ domain: 'video', status: 'running' }))
    latest().emit('pipeline', JSON.stringify({ run_id: 3, status: 'running' }))
    latest().emit('pipeline', JSON.stringify({ run_id: 3, domain: 'video' }))
    latest().emit('pipeline', JSON.stringify({ run_id: 3.5, domain: 'video', status: 'running' }))
    latest().emit('pipeline', pipelineFrame(9))
    expect(frames.map((f) => f.run_id)).toEqual([9])
    off()
  })

  it('只有 pipeline 订阅者时也会建连；四类订阅者全退订才关', async () => {
    const { subscribeCanvasEvents, subscribePipelineEvents, subscribeTaskEvents } = await load()
    const offPipeline = subscribePipelineEvents(() => {})
    expect(FakeEventSource.instances).toHaveLength(1)
    const offTask = subscribeTaskEvents(() => {})
    const offCanvas = subscribeCanvasEvents(() => {})
    expect(FakeEventSource.instances).toHaveLength(1)
    offTask()
    offCanvas()
    expect(latest().closed).toBe(false)
    offPipeline()
    expect(latest().closed).toBe(true)
    vi.advanceTimersByTime(120_000)
    expect(FakeEventSource.instances).toHaveLength(1)
  })

  it('旧连接关闭后的迟到 pipeline 帧不再分发', async () => {
    const { subscribePipelineEvents } = await load()
    const runs: number[] = []
    const off = subscribePipelineEvents((frame) => runs.push(frame.run_id))
    const first = latest()
    first.fail()
    vi.advanceTimersByTime(1000)
    expect(FakeEventSource.instances).toHaveLength(2)
    first.emit('pipeline', pipelineFrame(21))
    expect(runs).toEqual([])
    latest().emit('pipeline', pipelineFrame(22))
    expect(runs).toEqual([22])
    off()
  })
})
