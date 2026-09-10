/* 任务中心的数据层：三类主体（StudioTask / FlowRun / PipelineRun）各自的查询 + SSE 折叠，
   以及把它们压成同一种行模型的纯函数。页面与浮层只认 TaskCenterRow，不再分别理解三套状态机。 */

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { apiPipeline } from '@/lib/api-pipeline'
import type { ActiveItem, ActivePayload, PipelineEventFrame, RunListItem } from '@/lib/api-pipeline'
import { apiStudio } from '@/lib/api-studio'
import type { StudioFlowRun, StudioTask } from '@/lib/api-studio'

import {
  onTaskStreamConnected,
  subscribeFlowEvents,
  subscribePipelineEvents,
  subscribeTaskEvents,
} from './taskEvents'

export const ACTIVE_TASK_STATUSES = new Set(['queued', 'submitting', 'running', 'recovering'])
/** FlowRun 的活跃态，与服务端 FLOW_ACTIVE_STATUSES 一致 */
export const ACTIVE_FLOW_STATUSES = new Set(['queued', 'running', 'recovering'])
/** PipelineRun 的活跃态；awaiting_input 是停下来等人确认，不算在跑 */
export const ACTIVE_PIPELINE_STATUSES = new Set(['pending', 'running'])

export const FLOW_RUNS_QUERY_KEY = ['studio-flow-runs'] as const
export const PIPELINE_RUNS_QUERY_KEY = ['pipeline-runs', 'task-center'] as const

/* ==================== 统一行模型 ==================== */

export type TaskCenterSubject = 'task' | 'flow' | 'pipeline'
export type TaskCenterTone = 'active' | 'ok' | 'warn' | 'err' | 'muted'
export type TaskCenterScope = 'all' | 'active' | 'failed' | 'finished'

export interface TaskCenterRow {
  /** `${subject}:${id}`，三类行混排时的 React key */
  key: string
  subject: TaskCenterSubject
  id: string
  title: string
  /** 细分类型：task_type / 工作流来源 kind / 管线 run kind */
  kind: string
  status: string
  statusLabel: string
  tone: TaskCenterTone
  active: boolean
  /** 只有活跃行才有进度；终态行为 null，避免「失败 37%」这种误导 */
  progress: number | null
  stage: string | null
  context: string | null
  error: string | null
  createdAt: string | null
  /** 「回到来源」目标路由；null 表示没有可回去的现场 */
  sourceRoute: string | null
}

export const TASK_STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  submitting: '正在提交',
  running: '运行中',
  recovering: '恢复中',
  succeeded: '已完成',
  partial: '部分完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
}

export const FLOW_STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  recovering: '恢复中',
  succeeded: '已完成',
  partial: '部分完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
}

export const PIPELINE_STATUS_LABEL: Record<string, string> = {
  pending: '排队中',
  running: '运行中',
  awaiting_input: '等待确认',
  success: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
}

const FLOW_KIND_LABEL: Record<string, string> = {
  canvas_set: '成套出图',
  canvas_cascade: '级联执行',
}

const TONE_BY_STATUS: Record<string, TaskCenterTone> = {
  succeeded: 'ok',
  success: 'ok',
  partial: 'warn',
  awaiting_input: 'warn',
  failed: 'err',
  interrupted: 'warn',
  cancelled: 'muted',
}

function toneFor(status: string, active: boolean): TaskCenterTone {
  if (active) return 'active'
  return TONE_BY_STATUS[status] ?? 'muted'
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value))
}

export function taskContextLabel(task: Pick<StudioTask, 'source_context'>): string | null {
  const context = task.source_context
  if (context === null) return null
  if (typeof context.node_id === 'string') return `节点 ${context.node_id}`
  if (typeof context.canvas_id === 'number') return `画布 #${context.canvas_id}`
  if (typeof context.chat_id === 'number') return `会话 #${context.chat_id}`
  if (typeof context.image_job_id === 'number') return `生图 #${context.image_job_id}`
  return null
}

export function taskRow(task: StudioTask, toolLabel?: string): TaskCenterRow {
  const active = ACTIVE_TASK_STATUSES.has(task.status)
  const sourceRoute =
    task.source_route !== null && task.source_route.startsWith('/') ? task.source_route : null
  return {
    key: `task:${task.id}`,
    subject: 'task',
    id: task.id,
    title: toolLabel ?? task.tool_id,
    kind: task.task_type,
    status: task.status,
    statusLabel: TASK_STATUS_LABEL[task.status] ?? task.status,
    tone: toneFor(task.status, active),
    active,
    progress: active ? clampProgress(task.progress) : null,
    stage: task.stage ?? task.capability,
    context: taskContextLabel(task),
    error: task.error,
    createdAt: task.created_at,
    sourceRoute,
  }
}

export function flowRow(run: StudioFlowRun, flowTitle?: string): TaskCenterRow {
  const active = ACTIVE_FLOW_STATUSES.has(run.status)
  const context = run.source_context ?? {}
  const kind =
    typeof context.kind === 'string' && context.kind !== ''
      ? context.kind
      : run.flow_id !== null
        ? 'flow'
        : 'inline'
  const canvasId = typeof context.canvas_id === 'number' ? context.canvas_id : null
  const nodes = Object.values(run.checkpoint?.nodes ?? {})
  const done = nodes.filter((node) => node.status === 'succeeded' || node.status === 'partial').length
  const title =
    FLOW_KIND_LABEL[kind]
    ?? flowTitle
    ?? (run.flow_id !== null ? `工作流 #${run.flow_id}` : '内联工作流')
  return {
    key: `flow:${run.id}`,
    subject: 'flow',
    id: run.id,
    title,
    kind,
    status: run.status,
    statusLabel: FLOW_STATUS_LABEL[run.status] ?? run.status,
    tone: toneFor(run.status, active),
    active,
    progress: active ? clampProgress(run.progress) : null,
    stage: nodes.length > 0 ? `${done}/${nodes.length} 节点` : null,
    context:
      canvasId !== null
        ? `画布 #${canvasId}`
        : run.flow_id !== null
          ? `DAG #${run.flow_id} · v${run.flow_version}`
          : null,
    error: run.error,
    createdAt: run.created_at,
    sourceRoute:
      canvasId !== null ? `/studio/canvas/${canvasId}` : run.flow_id !== null ? '/studio/flows' : null,
  }
}

/** 管线详情页路由：视频域有自己的页面，其余域走通用主体页 */
export function pipelineRoute(domain: string, subjectId: number): string | null {
  if (!Number.isSafeInteger(subjectId) || subjectId <= 0) return null
  return domain === 'video'
    ? `/video/${subjectId}/pipeline`
    : `/pipeline/${encodeURIComponent(domain)}/${subjectId}`
}

/** run 只会往前走：pending → running/awaiting → 终态。列表与帧谁更靠后信谁，平手信帧（更新） */
function pipelineRank(status: string): number {
  if (status === 'pending') return 0
  if (ACTIVE_PIPELINE_STATUSES.has(status) || status === 'awaiting_input') return 1
  return 2
}

export function pipelineRow(
  item: RunListItem | null,
  frame: PipelineEventFrame | null,
): TaskCenterRow | null {
  if (item === null && frame === null) return null
  const useFrame =
    frame !== null && (item === null || pipelineRank(frame.status) >= pipelineRank(item.status))
  const status = useFrame ? frame!.status : item!.status
  const active = ACTIVE_PIPELINE_STATUSES.has(status)
  const runId = frame?.run_id ?? item!.id
  const domain = frame?.domain ?? item?.domain ?? 'video'
  const subjectId = frame?.subject_id ?? item?.subject_id ?? item?.video_id ?? 0
  const frameTitle = frame?.title ?? ''
  const title = frameTitle !== '' ? frameTitle : (item?.video_title ?? '') || `#${subjectId}`
  const failedSteps = useFrame ? frame!.failed_steps : (item?.failed_steps ?? frame?.failed_steps ?? [])
  let stage: string | null = null
  if (frame !== null && (useFrame || item === null)) {
    stage =
      active && frame.current_label !== null
        ? frame.current_label
        : frame.total_steps > 0
          ? `${frame.done_steps}/${frame.total_steps} 节点`
          : null
  }
  if (!active && failedSteps.length > 0) stage = `失败节点：${failedSteps.join('、')}`
  return {
    key: `pipeline:${runId}`,
    subject: 'pipeline',
    id: String(runId),
    title,
    kind: frame?.kind ?? item?.kind ?? '',
    status,
    statusLabel: PIPELINE_STATUS_LABEL[status] ?? status,
    tone: toneFor(status, active),
    active,
    progress: active && frame !== null ? clampProgress(frame.progress) : null,
    stage,
    context: domain === 'video' ? null : domain,
    error: useFrame ? frame!.error : item!.error,
    createdAt: frame?.started_at ?? item?.started_at ?? null,
    sourceRoute: pipelineRoute(domain, subjectId),
  }
}

/** 列表（历史）与帧（实时）按 run id 合并；只在帧里出现的 run 是基线之后才开始的，也要进来 */
export function pipelineRows(
  items: RunListItem[],
  frames: Record<string, PipelineEventFrame>,
): TaskCenterRow[] {
  const seen = new Set<number>()
  const rows: TaskCenterRow[] = []
  for (const item of items) {
    seen.add(item.id)
    const row = pipelineRow(item, frames[String(item.id)] ?? null)
    if (row !== null) rows.push(row)
  }
  for (const frame of Object.values(frames)) {
    if (seen.has(frame.run_id)) continue
    const row = pipelineRow(null, frame)
    if (row !== null) rows.push(row)
  }
  return rows.sort((a, b) => Number(b.id) - Number(a.id))
}

export function rowInScope(row: TaskCenterRow, scope: TaskCenterScope): boolean {
  if (scope === 'all') return true
  if (scope === 'active') return row.active
  if (scope === 'failed') return row.tone === 'err' || row.tone === 'warn'
  return !row.active && (row.tone === 'ok' || row.tone === 'muted')
}

/* ==================== SSE 帧折叠 ==================== */

function notOlder(incoming: string | null, current: string | null): boolean {
  if (incoming === null || current === null) return true
  return incoming >= current
}

/** FlowRun 整快照帧并进列表：已有的按 id 替换（不回退到更旧的快照），新 run 插到最前 */
export function mergeFlowRun(items: StudioFlowRun[], run: StudioFlowRun): StudioFlowRun[] {
  const index = items.findIndex((item) => item.id === run.id)
  if (index === -1) return [run, ...items]
  if (!notOlder(run.updated_at, items[index].updated_at)) return items
  const next = items.slice()
  next[index] = run
  return next
}

export function upsertPipelineFrame(
  frames: Record<string, PipelineEventFrame>,
  frame: PipelineEventFrame,
): Record<string, PipelineEventFrame> {
  const key = String(frame.run_id)
  const current = frames[key]
  if (current !== undefined && !notOlder(frame.updated_at, current.updated_at)) return frames
  return { ...frames, [key]: frame }
}

function activeItemFromFrame(frame: PipelineEventFrame, current: ActiveItem | undefined): ActiveItem {
  const active = ACTIVE_PIPELINE_STATUSES.has(frame.status)
  const title = frame.title !== '' ? frame.title : (current?.title ?? `#${frame.subject_id}`)
  return {
    video_id: frame.subject_id,
    domain: frame.domain,
    title,
    // 服务端把「有活跃 run」一律显示成 processing，失败则按 run 结果显示
    status: active ? 'processing' : frame.status,
    live: active,
    progress: frame.progress,
    error: active ? null : frame.error,
    error_kind: active ? null : (current?.error_kind ?? null),
    run_id: frame.run_id,
    current_step: active ? frame.current_step : null,
    current_label: active ? frame.current_label : null,
    failed_steps: frame.failed_steps,
    done_steps: frame.done_steps,
    total_steps: frame.total_steps,
  }
}

/**
 * 把单条 PipelineRun 帧折进 /api/pipeline/active 那种全量快照。
 *
 * 活跃帧按 (domain, subject_id) 覆盖或插入；失败帧留在列表里变成「需要关注」项；
 * 成功 / 取消帧把该主体移走——成功后视频会不会判成 degraded 帧里看不出来，
 * 调用方在终态帧后补拉一次基线收敛。
 */
export function foldActivePayload(payload: ActivePayload, frame: PipelineEventFrame): ActivePayload {
  const matches = (item: ActiveItem): boolean =>
    item.domain === frame.domain && item.video_id === frame.subject_id
  const index = payload.items.findIndex(matches)
  const current = index === -1 ? undefined : payload.items[index]
  // 同主体更旧的 run 发来的迟到帧不能盖掉新 run 的状态
  if (current !== undefined && current.run_id !== null && frame.run_id < current.run_id) return payload
  let items: ActiveItem[]
  if (frame.status === 'success' || frame.status === 'cancelled') {
    if (index === -1) return payload
    items = payload.items.filter((item) => !matches(item))
  } else {
    const next = activeItemFromFrame(frame, current)
    if (index === -1) items = [next, ...payload.items]
    else {
      items = payload.items.slice()
      items[index] = next
    }
  }
  return {
    items,
    active: items.filter((item) => item.live && item.run_id !== null).length,
  }
}

/* ==================== 实时运行浮层的行 ==================== */

export interface DockRow {
  key: string
  title: string
  step: string
  progress: number
  route: string
}

/** 浮层一行：管线活跃项在前（有节点级进度），工坊活跃任务在后 */
/** 工坊任务已经覆盖到的 ImageJob id。
 *
 *  `image_gen` 域的管线 run 是工坊任务的**执行细节**——同一份活，
 *  `StudioTask.invocation.image_job_id` 与 `pipeline_run.subject_id` 指的是同一个
 *  ImageJob。两边都列的话，画布上出 2 张图会显示成「4 个任务执行中」，
 *  同一份活占两行、进度还各说各的（实测一边 0% 一边 1%）。
 *
 *  `activeOnly` 给浮层用（它只关心在跑的）；任务中心要连历史一起折，所以传 false。 */
export function coveredImageJobs(tasks: StudioTask[], activeOnly: boolean): Set<number> {
  const out = new Set<number>()
  for (const task of tasks) {
    if (activeOnly && !ACTIVE_TASK_STATUSES.has(task.status)) continue
    const jobId = (task.invocation ?? {})['image_job_id']
    if (typeof jobId === 'number') out.add(jobId)
  }
  return out
}

/** 这条管线 run 是不是某个工坊任务的执行细节。
 *  **只认 `image_gen` 域**：视频域的 run 不是任何工坊任务的细节，按 subject_id
 *  撞号折掉就等于把正在跑的视频任务从列表里抹掉。 */
export function isCoveredByTask(
  domain: string,
  subjectId: number | undefined,
  covered: ReadonlySet<number>,
): boolean {
  return domain === 'image_gen' && subjectId !== undefined && covered.has(subjectId)
}

export function dockRows(
  pipelineItems: ActiveItem[],
  tasks: StudioTask[],
  toolLabel: (toolId: string) => string | undefined = () => undefined,
): DockRow[] {
  const rows: DockRow[] = []
  const coveredJobs = coveredImageJobs(tasks, true)
  for (const item of pipelineItems) {
    if (!item.live) continue
    if (isCoveredByTask(item.domain, item.subject_id, coveredJobs)) continue
    rows.push({
      key: `pipeline:${item.domain}:${item.video_id}`,
      title: item.title !== '' ? item.title : `#${item.video_id}`,
      step: item.current_label ?? item.status,
      progress: clampProgress(item.progress),
      route: pipelineRoute(item.domain, item.video_id) ?? '/pipeline',
    })
  }
  for (const task of tasks) {
    if (!ACTIVE_TASK_STATUSES.has(task.status)) continue
    const row = taskRow(task, toolLabel(task.tool_id))
    rows.push({
      key: row.key,
      title: row.title,
      step: row.stage ?? row.statusLabel,
      progress: row.progress ?? 0,
      route: row.sourceRoute ?? '/tasks',
    })
  }
  return rows
}

/* ==================== 查询 ==================== */

export function useStudioTasks() {
  const queryClient = useQueryClient()
  useEffect(
    () =>
      subscribeTaskEvents(() => {
        void queryClient.invalidateQueries({ queryKey: ['studio-tasks'] })
      }),
    [queryClient],
  )
  return useQuery({
    queryKey: ['studio-tasks'],
    queryFn: () => apiStudio.tasks({ limit: 200 }),
    refetchInterval: (query) => {
      const items = query.state.data?.items ?? []
      // SSE 是主路径；定时刷新只负责代理断流、睡眠唤醒等情况下的最终收敛。
      return items.some((task) => ACTIVE_TASK_STATUSES.has(task.status)) ? 15_000 : 60_000
    },
  })
}

/** 工作流运行列表：flow 帧是整快照，直接并进缓存；重连后重拉一次补断线期间的变化 */
export function useFlowRuns() {
  const queryClient = useQueryClient()
  useEffect(() => {
    const offFlow = subscribeFlowEvents((run) => {
      queryClient.setQueryData<{ items: StudioFlowRun[] }>(FLOW_RUNS_QUERY_KEY, (current) =>
        current === undefined ? current : { ...current, items: mergeFlowRun(current.items, run) },
      )
    })
    const offConnected = onTaskStreamConnected(() => {
      void queryClient.invalidateQueries({ queryKey: FLOW_RUNS_QUERY_KEY })
    })
    return () => {
      offFlow()
      offConnected()
    }
  }, [queryClient])
  return useQuery({
    queryKey: FLOW_RUNS_QUERY_KEY,
    queryFn: () => apiStudio.flowRuns({ limit: 100 }),
    refetchInterval: (query) => {
      const items = query.state.data?.items ?? []
      return items.some((run) => ACTIVE_FLOW_STATUSES.has(run.status)) ? 15_000 : 60_000
    },
  })
}

/** 管线运行：历史来自 /api/pipeline/runs，实时进度来自 pipeline 帧。
 *  终态帧后延迟刷一次列表——耗时、失败节点这些完整字段只有列表接口给。 */
export function usePipelineRuns() {
  const queryClient = useQueryClient()
  const [frames, setFrames] = useState<Record<string, PipelineEventFrame>>({})
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const offFrames = subscribePipelineEvents((frame) => {
      setFrames((current) => upsertPipelineFrame(current, frame))
      if (ACTIVE_PIPELINE_STATUSES.has(frame.status) || timer !== null) return
      timer = setTimeout(() => {
        timer = null
        void queryClient.invalidateQueries({ queryKey: PIPELINE_RUNS_QUERY_KEY })
      }, 800)
    })
    const offConnected = onTaskStreamConnected(() => {
      void queryClient.invalidateQueries({ queryKey: PIPELINE_RUNS_QUERY_KEY })
    })
    return () => {
      offFrames()
      offConnected()
      if (timer !== null) clearTimeout(timer)
    }
  }, [queryClient])
  const query = useQuery({
    queryKey: PIPELINE_RUNS_QUERY_KEY,
    queryFn: () => apiPipeline.runs({ limit: 60 }),
    refetchInterval: 60_000,
  })
  return { query, frames }
}
