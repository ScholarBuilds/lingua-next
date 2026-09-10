/* 远端画布变更接入（调研 §2.7「无远端变更感知」· §5.3 服务端 projector）。

   SSE canvas 帧只带版本号，store 收到本画布的帧后决定要不要拉全量合并。这里钉住：
   版本不比本地新的帧（含自己保存推出来的那帧）不拉取；新帧拉全量按 409 同一套规则合并
   （位置本地优先、图片按 asset 并集、连线并集）并把 version 对齐；指针按着时延后到抬手；
   合并后本地攒着的脏改动以新 base_version 照常保存；projector 落图帧只对真正新接回的图提示。

   测试跑在 node 里：scheduleSave 走 window.setTimeout，指针守卫挂在 window 上，都要自己搭桩。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  CanvasConnection,
  CanvasDetail,
  CanvasEventFrame,
  CanvasEventLanded,
  CanvasNode,
} from '@/lib/api-studio'

type CanvasListener = (frame: CanvasEventFrame) => void

const { canvasListeners, canvasFetch, saveCanvas, listTasks, listFlowRuns, toastSuccess, chimeFn } =
  vi.hoisted(() => ({
    canvasListeners: new Set<(frame: CanvasEventFrame) => void>(),
    canvasFetch: vi.fn<(id: number) => Promise<CanvasDetail>>(),
    saveCanvas: vi.fn<(id: number, body: unknown) => Promise<{ version: number; updated_at: string }>>(),
    listTasks: vi.fn(() => Promise.resolve({ items: [] })),
    listFlowRuns: vi.fn(() => Promise.resolve({ items: [] })),
    toastSuccess: vi.fn(),
    chimeFn: vi.fn(),
  }))

vi.mock('./taskEvents', () => ({
  subscribeTaskEvents: () => () => {},
  subscribeFlowEvents: () => () => {},
  subscribeCanvasEvents: (listener: CanvasListener) => {
    canvasListeners.add(listener)
    return () => canvasListeners.delete(listener)
  },
  onTaskStreamConnected: () => () => {},
}))

vi.mock('../../lib/api-studio', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api-studio')>()
  return {
    ...actual,
    apiStudio: {
      ...actual.apiStudio,
      canvas: (id: number) => canvasFetch(id),
      saveCanvas: (id: number, body: unknown) => saveCanvas(id, body),
      tasks: () => listTasks(),
      flowRuns: () => listFlowRuns(),
    },
  }
})

vi.mock('sonner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sonner')>()
  return { ...actual, toast: Object.assign(vi.fn(), actual.toast, { success: toastSuccess }) }
})

vi.mock('../../lib/chime', () => ({
  chime: chimeFn,
  chimeEnabled: () => false,
  setChimeEnabled: () => {},
}))

const g = globalThis as Record<string, unknown>

type Handler = () => void

/** 最小 window：保存防抖用的计时器透传给（可能被 fake 掉的）全局计时器，指针事件可手动派发 */
function fakeWindow(): { dispatch: (type: string) => void } {
  const handlers = new Map<string, Set<Handler>>()
  g.window = {
    setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(id),
    addEventListener: (type: string, handler: Handler) => {
      const set = handlers.get(type) ?? new Set<Handler>()
      set.add(handler)
      handlers.set(type, set)
    },
    removeEventListener: (type: string, handler: Handler) => {
      handlers.get(type)?.delete(handler)
    },
  }
  return {
    dispatch: (type) => {
      for (const handler of handlers.get(type) ?? []) handler()
    },
  }
}

const CANVAS_ID = 7

const image = (asset_id: number) => ({ kind: 'image' as const, asset_id })

function node(id: string, x: number, y: number, items: number[] = []): CanvasNode {
  return { id, type: 'image', x, y, items: items.map(image) }
}

function detail(version: number, nodes: CanvasNode[], connections: CanvasConnection[] = []): CanvasDetail {
  return {
    id: CANVAS_ID,
    title: '画布',
    icon: '',
    kind: 'smart',
    owner: '',
    color: '',
    pinned: false,
    project: '',
    board_x: null,
    board_y: null,
    nodes,
    connections,
    viewport: null,
    settings: {},
    version,
    updated_at: '2026-08-22T10:00:00+00:00',
  }
}

function frame(
  version: number,
  origin: 'save' | 'projector' = 'save',
  landed: CanvasEventLanded[] = [],
  canvasId = CANVAS_ID,
): CanvasEventFrame {
  return { canvas_id: canvasId, version, updated_at: '2026-08-22T10:00:01+00:00', origin, landed }
}

function push(f: CanvasEventFrame): void {
  for (const listener of canvasListeners) listener(f)
}

/** 合并链路里有好几个 await，多转几轮微任务保证跑到头 */
async function flush(): Promise<void> {
  for (let i = 0; i < 24; i += 1) await Promise.resolve()
}

async function loadStore(): Promise<typeof import('./canvasStore')> {
  return import('./canvasStore')
}

async function open(initial: CanvasDetail): Promise<typeof import('./canvasStore')> {
  const mod = await loadStore()
  canvasFetch.mockResolvedValueOnce(initial)
  await mod.useCanvasStore.getState().load(CANVAS_ID)
  await flush()
  expect(mod.useCanvasStore.getState().loaded).toBe(true)
  expect(canvasListeners.size).toBe(1)
  canvasFetch.mockClear()
  return mod
}

let win: { dispatch: (type: string) => void }

it('merges a detached snapshot after a version conflict and preserves another canvas', async () => {
  const { ApiImageError } = await import('../../lib/api-image')
  const { useCanvasStore: store, flushSave } = await open(detail(10, [node('a', 77, 0)]))
  let reject!: (error: Error) => void
  saveCanvas.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    .mockResolvedValue({ version: 12, updated_at: '' })
  canvasFetch.mockResolvedValue(detail(11, [node('a', 1, 0), node('remote', 2, 0)]))
  const saving = flushSave()
  store.getState().reset()
  store.setState({ canvasId: 8, loaded: true, nodes: [node('b', 2, 2)], version: 20 })
  reject(new ApiImageError(409, 'conflict'))
  await saving
  expect(saveCanvas.mock.calls.at(-1)).toEqual([7, expect.objectContaining({
    base_version: 11, nodes: [expect.objectContaining({ id: 'a', x: 77 }), expect.objectContaining({ id: 'remote' })],
  })])
  expect(store.getState().nodes[0].id).toBe('b')
})

it('saves the final immutable snapshot after leaving during an earlier save', async () => {
  const { useCanvasStore: store, flushSave } = await open(detail(3, [node('a', 0, 0)]))
  let resolve!: (value: { version: number; updated_at: string }) => void
  saveCanvas.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    .mockResolvedValue({ version: 5, updated_at: '' })
  const first = flushSave()
  store.setState({ nodes: [node('a', 99, 0)] })
  const last = flushSave()
  store.getState().reset()
  store.setState({ canvasId: 8, loaded: true, nodes: [node('b', 2, 2)], version: 20 })
  resolve({ version: 4, updated_at: '' })
  await Promise.all([first, last])
  expect(saveCanvas).toHaveBeenCalledTimes(2)
  expect(saveCanvas.mock.calls[1]).toEqual([7, expect.objectContaining({
    base_version: 4, nodes: [expect.objectContaining({ id: 'a', x: 99 })],
  })])
  expect(store.getState().version).toBe(20)
  expect(store.getState().nodes[0].id).toBe('b')
})

beforeEach(() => {
  vi.useFakeTimers()
  win = fakeWindow()
  canvasListeners.clear()
  canvasFetch.mockReset()
  saveCanvas.mockReset()
  toastSuccess.mockClear()
  chimeFn.mockClear()
})

afterEach(async () => {
  const { useCanvasStore } = await loadStore()
  useCanvasStore.getState().reset()
  vi.useRealTimers()
  delete g.window
})

describe('版本门槛', () => {
  it('版本不比本地新的帧不拉取', async () => {
    const { useCanvasStore } = await open(detail(3, [node('a', 0, 0, [1])]))
    push(frame(3))
    push(frame(2))
    await flush()
    expect(canvasFetch).not.toHaveBeenCalled()
    expect(useCanvasStore.getState().version).toBe(3)
  })

  it('别的画布的帧不理会', async () => {
    await open(detail(3, [node('a', 0, 0)]))
    push(frame(9, 'save', [], CANVAS_ID + 1))
    await flush()
    expect(canvasFetch).not.toHaveBeenCalled()
  })

  it('自己的保存在飞时到的帧，等保存落地认出是自己的版本，不拉取', async () => {
    const { scheduleSave, useCanvasStore } = await open(detail(3, [node('a', 0, 0)]))
    let settle: ((v: { version: number; updated_at: string }) => void) | null = null
    saveCanvas.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve
        }),
    )
    scheduleSave()
    vi.advanceTimersByTime(450)
    await flush()
    expect(saveCanvas).toHaveBeenCalledTimes(1)
    expect(useCanvasStore.getState().saveState).toBe('saving')

    // 服务端已经落库并推帧，本地 PUT 的响应还没回来
    push(frame(4))
    await flush()
    expect(canvasFetch).not.toHaveBeenCalled()

    settle!({ version: 4, updated_at: '2026-08-22T10:00:02+00:00' })
    await flush()
    expect(useCanvasStore.getState().version).toBe(4)
    expect(useCanvasStore.getState().saveState).toBe('saved')
    expect(canvasFetch).not.toHaveBeenCalled()

    // 同一帧再来一次（重连补发）也一样忽略
    push(frame(4))
    await flush()
    expect(canvasFetch).not.toHaveBeenCalled()
  })
})

describe('合并', () => {
  it('新帧拉全量合并：位置本地优先、图片并集、连线并集，version 对齐到远端', async () => {
    const { useCanvasStore } = await open(
      detail(3, [node('a', 0, 0, [1]), node('b', 100, 100)], [{ from: 'b', to: 'a', kind: 'input' }]),
    )
    // 本地挪过 a，还没来得及存
    useCanvasStore.setState({
      nodes: useCanvasStore.getState().nodes.map((n) => (n.id === 'a' ? { ...n, x: 50, y: 60 } : n)),
    })
    canvasFetch.mockResolvedValueOnce(
      detail(
        4,
        [node('a', 999, 999, [1, 2]), node('b', 100, 100), node('c', 300, 300, [5])],
        [
          { from: 'b', to: 'a', kind: 'input' },
          { from: 'c', to: 'a', kind: 'input' },
        ],
      ),
    )
    push(frame(4))
    await flush()

    expect(canvasFetch).toHaveBeenCalledWith(CANVAS_ID)
    const s = useCanvasStore.getState()
    expect(s.version).toBe(4)
    const a = s.nodes.find((n) => n.id === 'a')
    expect(a).toMatchObject({ x: 50, y: 60 })
    expect(a?.items?.map((it) => it.asset_id)).toEqual([1, 2])
    expect(s.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c'])
    expect(s.connections).toEqual([
      { from: 'b', to: 'a', kind: 'input' },
      { from: 'c', to: 'a', kind: 'input' },
    ])
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(chimeFn).not.toHaveBeenCalled()
  })

  it('拉取失败不弹错、不动本地', async () => {
    const { useCanvasStore } = await open(detail(3, [node('a', 0, 0, [1])]))
    canvasFetch.mockRejectedValueOnce(new Error('network'))
    push(frame(4))
    await flush()
    expect(canvasFetch).toHaveBeenCalledTimes(1)
    expect(useCanvasStore.getState().version).toBe(3)
    expect(useCanvasStore.getState().nodes[0].items?.map((it) => it.asset_id)).toEqual([1])
  })

  it('在跑节点本地优先：运行中的节点不被远端覆盖', async () => {
    const { useCanvasStore } = await open(detail(3, [node('a', 0, 0)]))
    useCanvasStore.setState({
      running: { a: { label: '出图中', pending: false, startedAt: 0 } },
    })
    canvasFetch.mockResolvedValueOnce(detail(4, [node('a', 5, 5, [9])]))
    push(frame(4))
    await flush()
    const a = useCanvasStore.getState().nodes.find((n) => n.id === 'a')
    expect(a).toMatchObject({ x: 0, y: 0 })
    expect(a?.items ?? []).toEqual([])
    expect(useCanvasStore.getState().version).toBe(4)
  })

  it('合并期间到的更高版本帧接着合并，拉到的是更新的全量', async () => {
    const { useCanvasStore } = await open(detail(3, [node('a', 0, 0)]))
    let release: ((d: CanvasDetail) => void) | null = null
    canvasFetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    push(frame(4))
    await flush()
    expect(canvasFetch).toHaveBeenCalledTimes(1)
    push(frame(5))
    push(frame(6))
    await flush()
    expect(canvasFetch).toHaveBeenCalledTimes(1)

    release!(detail(4, [node('a', 0, 0, [1])]))
    canvasFetch.mockResolvedValueOnce(detail(6, [node('a', 0, 0, [1, 2, 3])]))
    await flush()
    expect(canvasFetch).toHaveBeenCalledTimes(2)
    expect(useCanvasStore.getState().version).toBe(6)
    expect(useCanvasStore.getState().nodes[0].items?.map((it) => it.asset_id)).toEqual([1, 2, 3])
  })
})

describe('拖拽中延后', () => {
  it('指针按着时攒住，抬手后再拉取合并；攒的只有最高版本那一帧', async () => {
    const { useCanvasStore } = await open(detail(3, [node('a', 0, 0)]))
    win.dispatch('pointerdown')
    push(frame(4))
    push(frame(5))
    await flush()
    expect(canvasFetch).not.toHaveBeenCalled()
    expect(useCanvasStore.getState().version).toBe(3)

    canvasFetch.mockResolvedValueOnce(detail(5, [node('a', 0, 0, [1])]))
    win.dispatch('pointerup')
    await flush()
    expect(canvasFetch).toHaveBeenCalledTimes(1)
    expect(useCanvasStore.getState().version).toBe(5)
  })

  it('reset 之后指针守卫与订阅一起拆掉', async () => {
    const { useCanvasStore } = await open(detail(3, [node('a', 0, 0)]))
    useCanvasStore.getState().reset()
    expect(canvasListeners.size).toBe(0)
    win.dispatch('pointerdown')
    win.dispatch('pointerup')
    expect(canvasFetch).not.toHaveBeenCalled()
  })
})

describe('合并后的本地脏改动', () => {
  it('照常保存，base_version 用合并后的新版本', async () => {
    const { useCanvasStore } = await open(detail(3, [node('a', 0, 0), node('b', 100, 100)]))
    useCanvasStore.getState().moveNode('a', 10, 10)
    expect(saveCanvas).not.toHaveBeenCalled()

    canvasFetch.mockResolvedValueOnce(detail(4, [node('a', 0, 0), node('b', 200, 200)]))
    saveCanvas.mockResolvedValueOnce({ version: 5, updated_at: '2026-08-22T10:00:03+00:00' })
    push(frame(4))
    await flush()
    expect(useCanvasStore.getState().version).toBe(4)
    expect(saveCanvas).not.toHaveBeenCalled()

    vi.advanceTimersByTime(450)
    await flush()
    expect(saveCanvas).toHaveBeenCalledTimes(1)
    const [, body] = saveCanvas.mock.calls[0]
    expect(body).toMatchObject({ base_version: 4 })
    const sent = (body as { nodes: CanvasNode[] }).nodes
    expect(sent.find((n) => n.id === 'a')).toMatchObject({ x: 10, y: 10 })
    expect(sent.find((n) => n.id === 'b')).toMatchObject({ x: 100, y: 100 })
    expect(useCanvasStore.getState().version).toBe(5)
    expect(useCanvasStore.getState().saveState).toBe('saved')
  })
})

describe('projector 落图帧', () => {
  it('提示真正新接回的张数并响一声', async () => {
    const { useCanvasStore } = await open(detail(3, [node('a', 0, 0, [1])]))
    canvasFetch.mockResolvedValueOnce(detail(4, [node('a', 0, 0, [1, 2, 3]), node('z', 9, 9, [8])]))
    push(frame(4, 'projector', [{ node_id: 'a', task_id: 't1', flow_run_id: null, added: 2 }]))
    await flush()
    expect(useCanvasStore.getState().nodes.find((n) => n.id === 'a')?.items).toHaveLength(3)
    expect(toastSuccess).toHaveBeenCalledTimes(1)
    expect(toastSuccess).toHaveBeenCalledWith('已从服务端接回 2 张图')
    expect(chimeFn).toHaveBeenCalledWith('done')
  })

  it('落到本地还没有的节点也算接回', async () => {
    await open(detail(3, [node('a', 0, 0)]))
    canvasFetch.mockResolvedValueOnce(detail(4, [node('a', 0, 0), node('n', 50, 50, [4, 5])]))
    push(frame(4, 'projector', [{ node_id: 'n', task_id: 't2', flow_run_id: 'r1', added: 2 }]))
    await flush()
    expect(toastSuccess).toHaveBeenCalledWith('已从服务端接回 2 张图')
  })

  it('浏览器已经先落过的图不再提示第二遍', async () => {
    await open(detail(3, [node('a', 0, 0, [1, 2])]))
    canvasFetch.mockResolvedValueOnce(detail(4, [node('a', 0, 0, [1, 2])]))
    push(frame(4, 'projector', [{ node_id: 'a', task_id: 't1', flow_run_id: null, added: 2 }]))
    await flush()
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(chimeFn).not.toHaveBeenCalled()
  })

  it('普通保存帧即使带了 landed 也不提示', async () => {
    await open(detail(3, [node('a', 0, 0)]))
    canvasFetch.mockResolvedValueOnce(detail(4, [node('a', 0, 0, [1])]))
    push(frame(4, 'save', [{ node_id: 'a', task_id: null, flow_run_id: null, added: 1 }]))
    await flush()
    expect(toastSuccess).not.toHaveBeenCalled()
  })
})
