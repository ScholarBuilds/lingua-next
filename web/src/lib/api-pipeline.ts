import { requestJson } from './http'

/* 管线可观测性 API（需求 09 v6 FR-64~80）。
   形状对齐 Dagster 的 Run/Step：一次运行是 run，节点是其下的 step。 */

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  return requestJson<T>(url, init)
}

function jsonPost(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

export type StepStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped'
export type RunStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled'
/** 重跑范围（抄 Dagster step subset 语义） */
export type RerunScope = 'single' | 'downstream' | 'failed'

export interface Tunable {
  name: string
  label: string
  /* textarea 是模块 16 加的：生图节点的提示词是整段文本 */
  type: 'text' | 'number' | 'bool' | 'select' | 'textarea'
  default: string | number | boolean | null
  options: string[]
  /** select 的中文显示名，与 options 一一对应；后端 spec_view 提供 */
  choices?: Array<{ value: string; label: string }>
  hint: string
}

export interface HelpSection {
  title: string
  body: string
  bullets: string[]
}

export interface StepSpec {
  name: string
  label: string
  group: 'ingest' | 'enrich' | 'check'
  /** 重跑这一步会连带影响什么，人话 */
  rerun_hint?: string
  /** 什么情况下这一步会被跳过 */
  skip_when?: string
  depends_on: string[]
  note: string
  /** 能否只跑这一步：重建句层的节点会连累下游产物，只能连着下游跑 */
  single_ok: boolean
  tunables: Tunable[]
  /** 该节点在整体 0-100 进度里占的区间（FR-148） */
  progress_span: [number, number]
}

/** 节点耗时基线（FR-148）：历史成功执行的中位数 + 样本量 */
export interface StepEta {
  p50_ms: number
  samples: number
  min_ms: number
  max_ms: number
}

export interface PipelineStepV1 {
  id: number
  name: string
  label: string
  group: 'ingest' | 'enrich' | 'check'
  depends_on: string[]
  ordinal: number
  status: StepStatus
  attempt: number
  started_at: string | null
  finished_at: string | null
  duration_ms: number | null
  error: string | null
  error_kind: string | null
  /** 做了什么：量化产出 */
  metrics: Record<string, unknown>
  /** 用了什么：实际的模型与参数 */
  config: Record<string, unknown>
  logs: string | null
  code_version: string | null
  /** 产物由旧版管线生成（抄 Dagster staleness） */
  stale: boolean
}

export interface PipelineRunV1 {
  id: number
  video_id: number
  kind: string
  trigger: string
  status: RunStatus
  from_step: string | null
  scope: RerunScope | null
  config_override: Record<string, Record<string, unknown>>
  code_version: string | null
  parent_run_id: number | null
  started_at: string | null
  finished_at: string | null
  error: string | null
}

export interface HealthIssue {
  code: string
  level: 'error' | 'warn' | 'info'
  message: string
  fix_step: string | null
}

export interface HealthReport {
  ok: boolean
  gate: 'ready' | 'degraded' | 'failed'
  issues: HealthIssue[]
  metrics: Record<string, unknown>
}

export interface SubtitleIssueV1 {
  id: number
  sentence_id: number | null
  source: 'ai' | 'health'
  kind: string
  severity: 'info' | 'warn' | 'error'
  detail: string
  suggestion: string | null
  state: 'open' | 'accepted' | 'dismissed'
  /** 怎么修（FR-143）：replace_text | replace_translation | mark_noise |
      merge_prev | merge_next | split_at | manual；旧数据为 null 按 kind 兜底 */
  action: string | null
  anchor: string | null
}

export interface AutofixPreviewItem {
  video_id: number
  title: string
  auto: number
  agent: number
}

export interface AutofixPreview {
  videos: number
  issues: number
  auto_applicable: number
  agent_sessions: number
  items: AutofixPreviewItem[]
}

export interface AutofixAllResult {
  videos: number
  truncated: number
  auto_applied: number
  handed_to_agent: number
  agent_sessions: number
  queued_translate: number
}

export interface AutofixResult {
  video_id: number
  total: number
  auto_applied: number
  auto_failed: number
  handed_to_agent: number
  session_id: number | null
  queued_translate: boolean
}

export interface StepHistoryEntry {
  run_id: number
  status: StepStatus
  duration_ms: number | null
  started_at: string | null
  stale: boolean
}

export interface IssueChange {
  field: string
  old: string | null
  new: string
}

export interface VideoPipeline {
  video: {
    id: number
    title: string
    title_zh: string | null
    status: string
    progress: number
    error: string | null
    error_kind: string | null
    duration_s: number | null
  }
  run: PipelineRunV1 | null
  steps: PipelineStepV1[]
  runs: PipelineRunV1[]
  /** 各节点跨 run 的执行史（新→旧）：灰节点的「上次执行」与抽屉历史列表（FR-135/136） */
  history: Record<string, StepHistoryEntry[]>
  /** 节点名 → 历史耗时基线，没跑过的节点没有条目（FR-148） */
  eta: Record<string, StepEta>
  health: HealthReport
  issues: SubtitleIssueV1[]
  catalog: StepSpec[]
  version: string
}

/** 进度中心一行：一条正在处理（或刚失败）的视频 */
export interface ActiveItem {
  video_id: number
  /** 这条 run 干的是哪个主体：视频域是 video id，image_gen 域是 ImageJob id。
   *  服务端一直在发，前端以前没声明——任务坞要靠它认出「这条 run 是某个工坊任务
   *  的执行细节」，从而不再并列成第二行。 */
  subject_id?: number
  /** 所属管线域，浮层据此跳对详情页 */
  domain: string
  title: string
  status: string
  /** 真正在执行中；失败与产出不达标这类"需要关注但没在跑"的为 false */
  live: boolean
  progress: number
  error: string | null
  error_kind: string | null
  run_id: number | null
  current_step: string | null
  current_label: string | null
  failed_steps: string[]
  done_steps: number
  total_steps: number
}

export interface ActivePayload {
  items: ActiveItem[]
  active: number
}

/** SSE `event: pipeline` 帧（走 /studio/tasks/events/stream，不带 id、不推进游标）：
 *  一条 PipelineRun 的快照，字段对齐 ActiveItem 的单条 run 形状。任何 PipelineRun
 *  变化 ≤1s 推一帧；status 是 run 原始状态（pending / running / success / failed /
 *  cancelled / awaiting_input），不是 ActiveItem 那种按视频折算过的展示状态 */
export interface PipelineEventFrame {
  run_id: number
  domain: string
  subject_id: number
  title: string
  kind: string
  status: string
  progress: number
  error: string | null
  current_step: string | null
  current_label: string | null
  failed_steps: string[]
  done_steps: number
  total_steps: number
  started_at: string | null
  finished_at: string | null
  updated_at: string | null
}

export interface RunListItem extends PipelineRunV1 {
  /** 主体标题：视频取片名，场景本取本名，由服务端按域解析 */
  video_title: string
  failed_steps: string[]
  duration_ms: number | null
  /** 该视频当前未处理的校验问题数（FR-138） */
  open_issues: number
  /** 管线域与主体 id：旧版 _run_view 只给 video_id，这两个字段缺席时按视频域处理 */
  domain?: string
  subject_id?: number
}

export interface RunListQuery {
  status?: string
  /** 按管线域过滤（FR-243）；不传则跨域返回 */
  domain?: string
  video_id?: number
  subject_id?: number
  kind?: string
  trigger?: string
  since?: string
  until?: string
  offset?: number
  limit?: number
}

export interface VideoOverviewRow {
  video_id: number
  title: string
  status: string
  sentences: number
  translated: number
  pipeline_version: string | null
  stale: boolean
  last_run: PipelineRunV1 | null
  /** 未处理的校验问题数（FR-138）：点角标直达该视频的问题清单 */
  open_issues: number
}

export interface StaleVideo {
  video_id: number
  title: string
  status: string
  produced_version: string | null
  current_version: string
}

export const apiPipeline = {
  catalog: () =>
    req<{ version: string; steps: StepSpec[]; scopes: RerunScope[] }>('/api/pipeline/catalog'),

  /** 已注册的全部管线定义（FR-214） */
  pipelines: () => req<PipelineDefView[]>('/api/pipeline/pipelines'),

  /** 跨域总览：管线中心顶层视图（FR-214） */
  domains: () => req<DomainOverview[]>('/api/pipeline/domains'),

  /** 全局待办：跨域聚合需要处理的事（FR-241） */
  todo: () => req<TodoPayload>('/api/pipeline/todo'),

  /** 某域的主体列表，列由该域声明（FR-240） */
  domainSubjects: (
    domain: string,
    params: { health?: string; q?: string; offset?: number; limit?: number } = {},
  ) => {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') qs.set(k, String(v))
    }
    const tail = qs.toString()
    return req<SubjectListPayload>(
      `/api/pipeline/subjects/${encodeURIComponent(domain)}${tail ? `?${tail}` : ''}`,
    )
  },

  /** 运行矩阵：行=节点，列=最近 N 次运行（FR-215） */
  matrix: (domain: string, limit = 12) =>
    req<RunMatrix>(`/api/pipeline/matrix/${encodeURIComponent(domain)}?limit=${limit}`),

  /** 任意域的单主体全链路，与 /videos/{id} 同构（FR-190） */
  subject: (domain: string, subjectId: number, runId?: number) =>
    req<SubjectPipeline>(
      `/api/pipeline/subjects/${encodeURIComponent(domain)}/${subjectId}` +
        (runId === undefined ? '' : `?run_id=${runId}`),
    ),

  /** 节点产物详情，节点抽屉「产物」页签数据源（FR-198） */
  artifact: (domain: string, subjectId: number, step: string) =>
    req<ArtifactDetail>(
      `/api/pipeline/subjects/${encodeURIComponent(domain)}/${subjectId}/artifact/${encodeURIComponent(step)}`,
    ),

  active: () => req<ActivePayload>('/api/pipeline/active'),

  overview: () => req<VideoOverviewRow[]>('/api/pipeline/overview'),

  runs: (query: RunListQuery = {}) => {
    const q = new URLSearchParams(
      Object.entries(query)
        .filter(([, v]) => v !== undefined && v !== '')
        .map(([k, v]) => [k, String(v)]),
    )
    return req<{ total: number; items: RunListItem[] }>(
      `/api/pipeline/runs${q.toString() ? `?${q}` : ''}`,
    )
  },

  videoPipeline: (videoId: number | string, runId?: number) =>
    req<VideoPipeline>(
      `/api/pipeline/videos/${videoId}${runId !== undefined ? `?run_id=${runId}` : ''}`,
    ),

  /** 从指定节点按范围重跑，config 是节点级参数覆盖（FR-75/76） */
  rerun: (body: {
    video_id: number
    from_step?: string | null
    scope: RerunScope
    config?: Record<string, Record<string, unknown>>
  }) => req<{ queued: boolean; video_id: number; steps: string[] }>('/api/pipeline/rerun', jsonPost(body)),

  verify: (videoId: number, aiReview = true) =>
    req<{ queued: boolean }>(`/api/pipeline/verify/${videoId}?ai_review=${aiReview}`, {
      method: 'POST',
    }),

  /** 一键把该视频所有未处理问题交给系统 + AI（FR-144） */
  autofix: (videoId: number) =>
    req<AutofixResult>(`/api/pipeline/videos/${videoId}/autofix`, { method: 'POST' }),

  /** 全库批量修复：先预演看清规模，再执行（FR-146） */
  autofixAllPreview: () => req<AutofixPreview>('/api/pipeline/autofix-all/preview'),
  autofixAll: () => req<AutofixAllResult>('/api/pipeline/autofix-all', { method: 'POST' }),

  stale: () => req<StaleVideo[]>('/api/pipeline/stale'),

  patchSentence: (sentenceId: number, body: { text?: string; text_zh?: string }) =>
    req<{ id: number; text: string; text_zh: string | null; stale_steps: string[] }>(
      `/api/pipeline/sentences/${sentenceId}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    ),

  patchIssue: (issueId: number, state: 'accepted' | 'dismissed' | 'open') =>
    req<{
      id: number
      state: string
      applied: boolean
      change: IssueChange | null
      /** 改的是原文时旧译文失效，服务端已自动补译这一句（FR-140） */
      queued_translate: boolean
    }>(
      `/api/pipeline/issues/${issueId}?state=${state}`,
      { method: 'PATCH' },
    ),
}

/* 全局共享一条 SSE：外壳的进度入口与追踪页都要订阅，各开一条会让服务端
   每秒多查一遍库。最后一个订阅者退订时才关连接。 */
let source: EventSource | null = null
let latest: ActivePayload = { items: [], active: 0 }
const listeners = new Set<(p: ActivePayload) => void>()

/** SSE 订阅进度中心；返回取消函数。断线由 EventSource 自动重连（FR-68） */
export function subscribeActive(onData: (payload: ActivePayload) => void): () => void {
  listeners.add(onData)
  onData(latest) // 新订阅者立刻拿到最后一帧，不用等下次推送
  if (source === null) {
    source = new EventSource('/api/pipeline/stream')
    source.onmessage = (ev) => {
      try {
        latest = JSON.parse(ev.data) as ActivePayload
      } catch {
        return // keep-alive 帧不是 JSON
      }
      listeners.forEach((fn) => fn(latest))
    }
  }
  return () => {
    listeners.delete(onData)
    if (listeners.size === 0) {
      source?.close()
      source = null
    }
  }
}

/* ---- 多域管线（需求 12 FR-190、FR-214） ---- */

export interface PipelineDefView {
  domain: string
  label: string
  subject_table: string
  version: string
  steps: StepSpec[]
}

export interface ArtifactView {
  step: string
  summary: string | null
  bytes: number | null
  sha: string
  human_edited: boolean
  created_at: string | null
}

export interface InterruptView {
  id: number
  run_id: number
  step: string
  kind: string
  payload: Record<string, unknown> | null
}

export interface SubjectPipeline {
  domain: string
  label: string
  subject_id: number
  spec: StepSpec[]
  steps: PipelineStepV1[]
  stale: string[]
  artifacts: ArtifactView[]
  interrupts: InterruptView[]
  runs: Array<{
    id: number
    kind: string
    status: RunStatus | 'awaiting_input'
    trigger: string
    started_at: string | null
    finished_at: string | null
    error: string | null
  }>
  current_run_id: number | null
}

export interface ArtifactDetail extends ArtifactView {
  payload: unknown
  blob_key: string | null
  input_fingerprint: string
  code_version: string
}

export interface DomainStat {
  domain: string
  label: string
  subject_table: string
  steps: number
  subjects: number
  running: number
  failed: number
  success: number
  /** 待人工确认的暂停点数，独立于 failed 呈现（FR-218） */
  awaiting: number
  issues: number
}

export interface MatrixCell {
  status: StepStatus
  duration_ms: number | null
  error: string | null
}

export interface RunMatrix {
  domain: string
  label: string
  runs: Array<{
    id: number
    subject_id: number
    kind: string
    status: RunStatus | 'awaiting_input'
    started_at: string | null
  }>
  steps: Array<{ name: string; label: string; group: string; failures: number }>
  cells: Record<string, Record<string, MatrixCell>>
}

/* ---- 域 UI 声明（FR-235~239） ---- */

export interface SubjectColumn {
  key: string
  label: string
  kind: 'text' | 'number' | 'ratio' | 'status' | 'chips' | 'run' | 'when'
  align: 'left' | 'right'
  width: number | null
}

export interface HealthBucket {
  key: string
  label: string
  tone: 'ok' | 'warn' | 'err' | 'accent' | 'muted'
  /** 计入全局待办的档位 */
  actionable: boolean
}

export interface DomainAction {
  key: string
  label: string
  tone: 'primary' | 'normal' | 'danger'
  confirm: string | null
  preview: boolean
}

export interface PipelineSpec {
  domain: string
  label: string
  subject_table: string
  steps: number
  version: string
  detail_route: string
  empty_hint: string
  columns: SubjectColumn[]
  health: HealthBucket[]
  actions: DomainAction[]
  run_kinds: Array<{ key: string; label: string }>
  /** 帮助浮层内容，由域声明 */
  help: HelpSection[]
}

export interface DomainOverview extends PipelineSpec {
  subjects: number
  health_counts: Record<string, number>
  actionable: number
  issues: number
  last_run: { id: number; status: string; at: string | null } | null
}

export interface SubjectRow {
  id: number
  title: string
  health: string
  /** 最近运行；id 为 null 且 status 为 legacy 表示改造前的历史产物 */
  last_run?: { id: number | null; status: string; at: string | null } | null
  [key: string]: unknown
}

export interface SubjectListPayload {
  items: SubjectRow[]
  total: number
  health_counts: Record<string, number>
  spec: PipelineSpec
}

export interface TodoItem {
  domain: string
  domain_label: string
  kind: string
  key: string
  label: string
  count: number
  tone: 'ok' | 'warn' | 'err' | 'accent' | 'muted'
}

export interface TodoPayload {
  total: number
  waiting: number
  items: TodoItem[]
}
