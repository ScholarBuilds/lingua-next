import type { PipelineEventFrame } from '@/lib/api-pipeline'
import type { CanvasEventFrame, StudioFlowRun, StudioTaskEvent } from '@/lib/api-studio'

const CURSOR_KEY = 'lingua.studio-task-event-cursor.v1'
const STREAM_PATH = '/api/studio/tasks/events/stream'
/** 退避节奏：1s → 2s → 4s … 封顶 30s，±10% 抖动，避免多个标签页同一拍撞服务端 */
const BACKOFF_BASE_MS = 1000
const BACKOFF_MAX_MS = 30_000
const BACKOFF_JITTER = 0.1

type TaskEventListener = (event: StudioTaskEvent) => void
type FlowEventListener = (run: StudioFlowRun) => void
type CanvasEventListener = (frame: CanvasEventFrame) => void
type PipelineEventListener = (frame: PipelineEventFrame) => void
type ConnectedListener = () => void

export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt))
  const jitter = (random() * 2 - 1) * BACKOFF_JITTER
  return Math.round(base * (1 + jitter))
}

function storedCursor(): number {
  try {
    const value = Number(window.localStorage.getItem(CURSOR_KEY) ?? 0)
    return Number.isSafeInteger(value) && value > 0 ? value : 0
  } catch {
    return 0
  }
}

function rememberCursor(cursor: number): void {
  if (!Number.isSafeInteger(cursor) || cursor <= 0) return
  try {
    window.localStorage.setItem(CURSOR_KEY, String(cursor))
  } catch {
    // 隐私模式或禁用本地存储时，重连仍按本次页面生命周期内记住的游标续传。
  }
}

function parseFrame(raw: MessageEvent<string>): unknown {
  try {
    return JSON.parse(raw.data)
  } catch {
    // 服务端 keep-alive 不带 data；畸形单条帧也不应打断后续帧。
    return null
  }
}

function isTaskEvent(value: unknown): value is StudioTaskEvent {
  if (typeof value !== 'object' || value === null) return false
  const event = value as Partial<StudioTaskEvent>
  return Number.isSafeInteger(event.cursor) && typeof event.task_id === 'string'
}

function isFlowRun(value: unknown): value is StudioFlowRun {
  if (typeof value !== 'object' || value === null) return false
  const run = value as Partial<StudioFlowRun>
  return typeof run.id === 'string' && typeof run.status === 'string'
}

/** canvas 帧归一：canvas_id / version 缺一不可；origin 与 landed 容错补齐，
 *  服务端少发一个字段不该让整帧作废。 */
function toCanvasFrame(value: unknown): CanvasEventFrame | null {
  if (typeof value !== 'object' || value === null) return null
  const { canvas_id, version, updated_at, origin, landed } = value as Partial<CanvasEventFrame>
  if (typeof canvas_id !== 'number' || !Number.isSafeInteger(canvas_id)) return null
  if (typeof version !== 'number' || !Number.isSafeInteger(version)) return null
  return {
    canvas_id,
    version,
    updated_at: typeof updated_at === 'string' ? updated_at : '',
    origin: origin === 'projector' ? 'projector' : 'save',
    landed: Array.isArray(landed)
      ? landed
          .filter((entry) => typeof entry?.node_id === 'string')
          .map((entry) => ({
            node_id: entry.node_id,
            task_id: entry.task_id ?? null,
            flow_run_id: entry.flow_run_id ?? null,
            added: Number.isSafeInteger(entry.added) ? entry.added : 0,
          }))
      : [],
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function intOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback
}

/** pipeline 帧归一：run_id（兼容 id）/ domain / status 缺一不可，其余字段按
 *  ActiveItem 的单条 run 形状补齐。subject_id 缺席时退回 video_id——旧管线行只有后者。 */
function toPipelineFrame(value: unknown): PipelineEventFrame | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const runId = intOr(raw.run_id, intOr(raw.id, 0))
  if (runId <= 0) return null
  if (typeof raw.domain !== 'string' || raw.domain === '') return null
  if (typeof raw.status !== 'string' || raw.status === '') return null
  const progress = typeof raw.progress === 'number' && Number.isFinite(raw.progress) ? raw.progress : 0
  return {
    run_id: runId,
    domain: raw.domain,
    subject_id: intOr(raw.subject_id, intOr(raw.video_id, 0)),
    title: typeof raw.title === 'string' ? raw.title : '',
    kind: typeof raw.kind === 'string' ? raw.kind : '',
    status: raw.status,
    progress: Math.max(0, Math.min(100, progress)),
    error: stringOrNull(raw.error),
    current_step: stringOrNull(raw.current_step),
    current_label: stringOrNull(raw.current_label),
    failed_steps: Array.isArray(raw.failed_steps)
      ? raw.failed_steps.filter((step): step is string => typeof step === 'string')
      : [],
    done_steps: intOr(raw.done_steps, 0),
    total_steps: intOr(raw.total_steps, 0),
    started_at: stringOrNull(raw.started_at),
    finished_at: stringOrNull(raw.finished_at),
    updated_at: stringOrNull(raw.updated_at),
  }
}

/**
 * 任务事件流的重连控制器。
 *
 * 浏览器原生 EventSource 只在「已建立过 event-stream 连接后断线」时自动重连；
 * 代理 502、后端没起（Vite 代理写 500 text/plain）这类非 200 / 非 event-stream 响应
 * 会直接进入 CLOSED 且永不重试。所以任何 error 都由控制器接管：销毁当前连接，
 * 按指数退避重建；generation 计数让旧连接的迟到回调不会串到新连接上。
 *
 * 游标只由 task 帧推进（落 localStorage，整页刷新后续传）；flow 帧与 pipeline 帧是整快照、
 * canvas 帧是画布版本变更通知，都不带 id 行。多个页面订阅者复用同一条连接；
 * task/flow/canvas/pipeline 四类订阅者全部归零时关闭连接并取消重连定时器。
 */
class TaskStreamController {
  private readonly taskListeners = new Set<TaskEventListener>()
  private readonly flowListeners = new Set<FlowEventListener>()
  private readonly canvasListeners = new Set<CanvasEventListener>()
  private readonly pipelineListeners = new Set<PipelineEventListener>()
  private readonly connectedListeners = new Set<ConnectedListener>()
  private source: EventSource | null = null
  private generation = 0
  private attempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  subscribeTask(listener: TaskEventListener): () => void {
    this.taskListeners.add(listener)
    this.connect()
    return () => {
      this.taskListeners.delete(listener)
      this.closeIfIdle()
    }
  }

  subscribeFlow(listener: FlowEventListener): () => void {
    this.flowListeners.add(listener)
    this.connect()
    return () => {
      this.flowListeners.delete(listener)
      this.closeIfIdle()
    }
  }

  subscribeCanvas(listener: CanvasEventListener): () => void {
    this.canvasListeners.add(listener)
    this.connect()
    return () => {
      this.canvasListeners.delete(listener)
      this.closeIfIdle()
    }
  }

  subscribePipeline(listener: PipelineEventListener): () => void {
    this.pipelineListeners.add(listener)
    this.connect()
    return () => {
      this.pipelineListeners.delete(listener)
      this.closeIfIdle()
    }
  }

  /** 只登记回调，不单独拉起连接；连接由 task/flow/canvas/pipeline 订阅者决定是否存在。 */
  onConnected(listener: ConnectedListener): () => void {
    this.connectedListeners.add(listener)
    return () => {
      this.connectedListeners.delete(listener)
    }
  }

  private get wanted(): boolean {
    return (
      this.taskListeners.size > 0
      || this.flowListeners.size > 0
      || this.canvasListeners.size > 0
      || this.pipelineListeners.size > 0
    )
  }

  private connect(): void {
    if (this.source !== null || !this.wanted) return
    // SSR / 测试等没有 EventSource 的环境：退化为订阅者各自的轮询兜底。
    if (typeof EventSource === 'undefined') return
    this.clearReconnectTimer()
    const generation = ++this.generation
    const source = new EventSource(`${STREAM_PATH}?after=${storedCursor()}`)
    this.source = source
    source.onopen = () => {
      if (generation !== this.generation) return
      this.attempt = 0
      for (const listener of this.connectedListeners) this.invoke(listener, undefined)
    }
    source.onerror = () => {
      if (generation !== this.generation) return
      this.dropSource()
      this.scheduleReconnect()
    }
    source.addEventListener('task', (raw: Event) => {
      if (generation !== this.generation) return
      this.dispatchTask(raw as MessageEvent<string>)
    })
    source.addEventListener('flow', (raw: Event) => {
      if (generation !== this.generation) return
      this.dispatchFlow(raw as MessageEvent<string>)
    })
    source.addEventListener('canvas', (raw: Event) => {
      if (generation !== this.generation) return
      this.dispatchCanvas(raw as MessageEvent<string>)
    })
    source.addEventListener('pipeline', (raw: Event) => {
      if (generation !== this.generation) return
      this.dispatchPipeline(raw as MessageEvent<string>)
    })
  }

  private dropSource(): void {
    if (this.source === null) return
    this.source.onopen = null
    this.source.onerror = null
    this.source.close()
    this.source = null
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || !this.wanted) return
    const delay = backoffDelay(this.attempt)
    this.attempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private closeIfIdle(): void {
    if (this.wanted) return
    this.generation += 1
    this.clearReconnectTimer()
    this.dropSource()
    this.attempt = 0
  }

  private dispatchTask(raw: MessageEvent<string>): void {
    const event = parseFrame(raw)
    if (!isTaskEvent(event)) return
    rememberCursor(event.cursor)
    for (const listener of this.taskListeners) this.invoke(listener, event)
  }

  private dispatchFlow(raw: MessageEvent<string>): void {
    const run = parseFrame(raw)
    if (!isFlowRun(run)) return
    for (const listener of this.flowListeners) this.invoke(listener, run)
  }

  private dispatchCanvas(raw: MessageEvent<string>): void {
    const frame = toCanvasFrame(parseFrame(raw))
    if (frame === null) return
    for (const listener of this.canvasListeners) this.invoke(listener, frame)
  }

  private dispatchPipeline(raw: MessageEvent<string>): void {
    const frame = toPipelineFrame(parseFrame(raw))
    if (frame === null) return
    for (const listener of this.pipelineListeners) this.invoke(listener, frame)
  }

  /** 一个订阅者抛错不能让同一帧的其他订阅者饿死，更不能把连接拖垮。 */
  private invoke<T>(listener: (value: T) => void, value: T): void {
    try {
      listener(value)
    } catch (error) {
      console.error('[studio-task-stream] 订阅者处理事件失败', error)
    }
  }
}

const controller = new TaskStreamController()

/**
 * 订阅全局持久任务事件。游标落在 localStorage，整页刷新后从最后一条继续；
 * 多个页面订阅者复用同一条 EventSource，不会各自建立一条长连接。
 */
export function subscribeTaskEvents(listener: TaskEventListener): () => void {
  return controller.subscribeTask(listener)
}

/** 订阅 FlowRun 整快照帧（status / checkpoint 变化后 ≤1s 推一帧）。 */
export function subscribeFlowEvents(listener: FlowEventListener): () => void {
  return controller.subscribeFlow(listener)
}

/** 订阅画布版本变更帧：任何 StudioCanvas.updated_at 变化（别的标签页保存、服务端 projector 落图）
 *  都会推一帧。帧不带内容，订阅者按 version 决定要不要拉全量。 */
export function subscribeCanvasEvents(listener: CanvasEventListener): () => void {
  return controller.subscribeCanvas(listener)
}

/** 订阅 PipelineRun 快照帧（视频 / 书籍 / 场景本等管线，任何 run 变化 ≤1s 推一帧）。
 *  与 /api/pipeline/stream 的全量快照不同，这里一帧只有一条 run；订阅者自己按
 *  (domain, subject_id) 或 run_id 折叠。 */
export function subscribePipelineEvents(listener: PipelineEventListener): () => void {
  return controller.subscribePipeline(listener)
}

/** 连接或重连成功时触发，供订阅者重拉一次基线补上断线期间漏掉的状态。 */
export function onTaskStreamConnected(listener: ConnectedListener): () => void {
  return controller.onConnected(listener)
}
