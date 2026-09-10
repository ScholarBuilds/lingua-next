/* 生成日志的纯计算：把「任务表 + 模型调用台账 + 能力绑定 + 模型部署」四份数据
   折成一行一条的可扫列表，再按筛选条件与全文检索裁出要显示的那批。

   与 `/studio/models` 那本账的分工：
   - 账本（`InvocationLedger`）的单位是**一次模型调用**，全局、跨画布，字段是消息 / 分块 / token；
   - 这里的单位是**当前画布的一件活**（`StudioTask`），一件活可能一次模型调用都没有
     （纯本地工具），也可能横跨十几次（工作流）。两者是一对多，不能共用一个行模型。

   重叠的部分照抄不重写：调用行、逐步事件、以及 `invocation-stats.ts` 里那套
   首 token / 总耗时 / 输出拼装的折叠算法，全都直接复用账本那份。 */

import type { Binding, ModelDeployment, ModelInvocation } from '@/lib/api-config'
import type { StudioTask, StudioTaskStatus } from '@/lib/api-studio'
import { modelText } from '@/lib/model-label'

export { UNKNOWN_MODEL_TEXT } from '@/lib/model-label'

/** 筛选器里的「全部」。用星号而不是空串，空串在 Radix Select 里是非法值 */
export const ALL = '*'

/** 还没收口的状态，列表里要转圈、也要让轮询继续 */
export const ACTIVE_TASK_STATUSES = new Set<string>([
  'queued',
  'submitting',
  'running',
  'recovering',
])

/** 状态筛选的分桶。终态各占一档，未收口的挤成「进行中」——
 *  排查时没人关心它此刻是 queued 还是 submitting，只关心它还没出结果。 */
export type RunLogBucket = 'active' | 'succeeded' | 'partial' | 'failed' | 'cancelled'

export const BUCKET_LABELS: Record<RunLogBucket, string> = {
  active: '进行中',
  succeeded: '成功',
  partial: '部分成功',
  failed: '失败',
  cancelled: '已取消',
}

export function statusBucket(status: string): RunLogBucket {
  if (ACTIVE_TASK_STATUSES.has(status)) return 'active'
  if (status === 'succeeded') return 'succeeded'
  if (status === 'partial') return 'partial'
  if (status === 'cancelled') return 'cancelled'
  return 'failed'
}

/** 时间窗筛选。`ALL` 之外都是「最近 N 毫秒」 */
export const TIME_WINDOWS: Array<{ value: string; label: string; ms: number }> = [
  { value: '15m', label: '近 15 分钟', ms: 15 * 60_000 },
  { value: '1h', label: '近 1 小时', ms: 60 * 60_000 },
  { value: '6h', label: '近 6 小时', ms: 6 * 60 * 60_000 },
  { value: '24h', label: '近 24 小时', ms: 24 * 60 * 60_000 },
]

export type RunLogOutputKind = 'image' | 'video' | 'audio' | 'file'

export interface RunLogOutput {
  key: string
  url: string
  kind: RunLogOutputKind
  name: string
}

/** 这次调用喂进去的图：参考图、遮罩、上一版。排查「为什么长得不像」全靠它 */
export interface RunLogReference {
  key: string
  url: string
  label: string
}

/** 请求参数表的一行。值一律先字符串化，渲染层不再判类型 */
export interface RunLogField {
  key: string
  value: string
}

/** 实际发出去的提示词：一次模型调用一条。`rewritten` 为真表示与画布上填的不是同一段 */
export interface RunLogSentPrompt {
  invocationId: string
  model: string
  text: string
  rewritten: boolean
}

export interface RunLogRow {
  id: string
  task: StudioTask
  status: StudioTaskStatus
  bucket: RunLogBucket
  active: boolean
  /** 能力位只露中文标签，绑定里查不到就退回任务类型——不把 slug 摆给用户看 */
  capabilityLabel: string
  /** 原始能力键，只用于筛选与检索，不上屏 */
  capability: string
  /** 「模型」位：上游真名。查不到如实说没有（核心原则 6） */
  model: string
  nodeId: string
  createdMs: number | null
  /** 端到端墙钟耗时 */
  durationMs: number | null
  /** 首 token：只有走模型调用的任务才有 */
  firstTokenMs: number | null
  /** 画布上提交的那段 */
  prompt: string
  /** 真正发给上游的那几段 */
  sentPrompts: RunLogSentPrompt[]
  error: string
  outputs: RunLogOutput[]
  references: RunLogReference[]
  fields: RunLogField[]
  invocations: ModelInvocation[]
  /** 重试族里的第几次（1 基）。族由 parent_task_id 串起来 */
  attempt: number
  /** 本族全部尝试的任务 id，按时间升序 */
  lineage: string[]
  /** 全文检索的预拼串，已转小写 */
  haystack: string
}

export interface RunLogFilters {
  status: string
  capability: string
  node: string
  window: string
  search: string
}

export const EMPTY_FILTERS: RunLogFilters = {
  status: ALL,
  capability: ALL,
  node: ALL,
  window: ALL,
  search: '',
}

/* ------------------------------------------------------------ 取值小工具 */

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function firstText(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

function millis(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function assetUrl(id: number): string {
  return `/api/images/assets/${id}/display`
}

function assetId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return null
}

/* -------------------------------------------------------------- 提示词 */

const PROMPT_KEYS = ['prompt', 'prompt_override', 'instruction', 'command', 'idea', 'text']

/** 画布上提交的提示词。四个来源按「越靠近用户输入越优先」排。 */
export function taskPrompt(task: StudioTask): string {
  const source = record(task.source_context)
  const invocation = record(task.invocation)
  const input = record(invocation.input)
  const fields = record(invocation.fields)
  return (
    firstText(source, PROMPT_KEYS) ||
    firstText(invocation, PROMPT_KEYS) ||
    firstText(input, PROMPT_KEYS) ||
    firstText(fields, ['prompt', 'positive_prompt', 'text'])
  )
}

/** 从一次模型调用的 request 快照里挖出真正发出去的那段文字。
 *
 *  Chat 走 messages：取最后一条 user 的正文（system 是模板、assistant 是历史，
 *  排查「模型看到了什么」时最想先看到的是这一条）。生图 / 生视频走扁平的 prompt 字段。 */
export function sentPromptOf(request: Record<string, unknown> | null): string {
  if (request === null) return ''
  const messages = Array.isArray(request.messages) ? request.messages : []
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = record(messages[i])
    if (message.role !== 'user') continue
    const content = message.content
    if (typeof content === 'string' && content.trim() !== '') return content.trim()
    if (Array.isArray(content)) {
      const parts = content
        .map((part) => firstText(record(part), ['text']))
        .filter((text) => text !== '')
      if (parts.length > 0) return parts.join('\n')
    }
  }
  return (
    firstText(request, [...PROMPT_KEYS, 'positive_prompt']) ||
    firstText(record(request.input), [...PROMPT_KEYS, 'positive_prompt'])
  )
}

/* ---------------------------------------------------------------- 产物 */

function outputKind(url: string, explicit: unknown): RunLogOutputKind {
  if (explicit === 'image' || explicit === 'video' || explicit === 'audio' || explicit === 'file') {
    return explicit
  }
  const clean = url.split('?')[0].toLowerCase()
  if (/\.(mp4|webm|mov|m4v)$/.test(clean)) return 'video'
  if (/\.(mp3|wav|m4a|aac|ogg)$/.test(clean)) return 'audio'
  if (/\.(png|jpe?g|webp|gif|avif)$/.test(clean)) return 'image'
  return 'file'
}

export function taskOutputs(task: StudioTask): RunLogOutput[] {
  const result = record(task.result)
  const values: unknown[] = []
  if (Array.isArray(result.items)) values.push(...result.items)
  if (Array.isArray(result.outputs)) values.push(...result.outputs)
  if (Array.isArray(result.urls)) values.push(...result.urls)
  const ids = Array.isArray(result.asset_ids) ? result.asset_ids : []
  for (const raw of ids) {
    const id = assetId(raw)
    if (id !== null) values.push({ asset_id: id, kind: 'image' })
  }
  const seen = new Set<string>()
  const outputs: RunLogOutput[] = []
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    const item = record(value)
    const asset = assetId(item.asset_id)
    const media = assetId(item.media_asset_id)
    const raw = typeof value === 'string' ? value : firstText(item, ['url', 'path', 'src', 'uri'])
    const fromAsset = raw === '' && asset !== null
    const url = raw || (asset === null ? '' : assetUrl(asset))
    if (url === '' || seen.has(url)) continue
    seen.add(url)
    /* 资产接口的地址不带扩展名（`/api/images/assets/11/display`），
       靠后缀猜类型会一律猜成 file——图片就这么渲染成了下载链接。
       走资产 id 这条路的默认按图算，显式 kind 仍然优先。 */
    const declared = item.kind ?? item.type ?? item.media_kind
    outputs.push({
      key: asset !== null ? `image-${asset}` : media !== null ? `media-${media}` : `${index}-${url}`,
      url,
      kind: outputKind(url, declared ?? (fromAsset ? 'image' : undefined)),
      name: firstText(item, ['name', 'filename']) || `输出 ${outputs.length + 1}`,
    })
  }
  return outputs
}

/* -------------------------------------------------------------- 参考图 */

/** 键名 → 中文说明。这些键遍布 image.edit / midjourney / video.generate 三条链路 */
const REFERENCE_KEYS: Array<[string, string]> = [
  ['ref_asset_ids', '参考图'],
  ['reference_asset_ids', '参考图'],
  ['reference_asset_id', '参考图'],
  ['references', '参考图'],
  ['media_references', '参考素材'],
  ['uploads', '上传图'],
  ['mask_asset_id', '遮罩'],
  ['parent_id', '上一版'],
  ['asset_id', '原图'],
]

export function taskReferences(task: StudioTask): RunLogReference[] {
  const invocation = record(task.invocation)
  const out: RunLogReference[] = []
  const seen = new Set<string>()
  const push = (label: string, value: unknown): void => {
    const item = record(value)
    const id = assetId(typeof value === 'number' || typeof value === 'string' ? value : item.asset_id)
    const url = id !== null ? assetUrl(id) : firstText(item, ['url', 'path', 'src', 'uri'])
    if (url === '' || seen.has(url)) return
    seen.add(url)
    out.push({ key: `${label}-${url}`, url, label })
  }
  for (const [key, label] of REFERENCE_KEYS) {
    const value = invocation[key]
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) for (const item of value) push(label, item)
    else push(label, value)
  }
  return out
}

/* ---------------------------------------------------------- 请求参数表 */

/** 已经在别处单独露过的键不再进参数表，免得同一份信息看两遍 */
const FIELD_SKIP = new Set<string>([
  '_tool_runtime',
  ...PROMPT_KEYS,
  'positive_prompt',
  ...REFERENCE_KEYS.map(([key]) => key),
])

function fieldText(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

export function taskFields(task: StudioTask): RunLogField[] {
  const invocation = record(task.invocation)
  const out: RunLogField[] = []
  for (const [key, value] of Object.entries(invocation)) {
    if (FIELD_SKIP.has(key)) continue
    if (value === null || value === undefined) continue
    if (Array.isArray(value) && value.length === 0) continue
    out.push({ key, value: fieldText(value) })
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/* ------------------------------------------------------------ 重试族 */

/** 沿 parent_task_id 一路向上找根。父不在这批里就以自己为根——
 *  日志只取当前画布的 200 条，跨批的父任务查不到是常态，不能因此丢行。 */
export function lineageRoots(tasks: StudioTask[]): Map<string, string> {
  const byId = new Map<string, StudioTask>(tasks.map((task) => [task.id, task]))
  const roots = new Map<string, string>()
  for (const task of tasks) {
    const path: string[] = []
    // 自引用与环都得防：链是后端写的，前端不该因为一条脏数据就死循环
    const guard = new Set<string>()
    let cursor: StudioTask = task
    for (;;) {
      if (guard.has(cursor.id)) {
        for (const id of path) roots.set(id, cursor.id)
        break
      }
      guard.add(cursor.id)
      path.push(cursor.id)
      const known = roots.get(cursor.id)
      if (known !== undefined) {
        for (const id of path) roots.set(id, known)
        break
      }
      const parentId: string | null = cursor.parent_task_id
      const parent: StudioTask | undefined = parentId === null ? undefined : byId.get(parentId)
      if (parent === undefined) {
        for (const id of path) roots.set(id, cursor.id)
        break
      }
      cursor = parent
    }
  }
  return roots
}

/* ------------------------------------------------------------ 行的组装 */

export interface RunLogSources {
  tasks: StudioTask[]
  invocations: ModelInvocation[]
  bindings: Binding[]
  deployments: ModelDeployment[]
}

function capabilityTextOf(task: StudioTask, labels: Map<string, string>): string {
  const capability = task.capability ?? ''
  if (capability === '') return task.task_type
  return labels.get(capability) ?? task.task_type
}

/** 「模型」位的真名，三条退路依次试：
 *  1. 这次任务真实发生的调用记的 model（最可信，就是上游回的那个名字）；
 *  2. 任务冻结的 deployment_id 指向的部署；
 *  3. 当前能力绑定的部署——只有前两条都空时才用，它可能已经被改过了。 */
function modelNameOf(
  task: StudioTask,
  invocations: ModelInvocation[],
  deployments: Map<number, ModelDeployment>,
  bindings: Map<string, Binding>,
): string {
  for (const invocation of invocations) {
    const name = (invocation.model ?? '').trim()
    if (name !== '') return name
  }
  if (task.deployment_id !== null) {
    const hit = deployments.get(task.deployment_id)
    if (hit !== undefined) return hit.upstream_model_id
  }
  const binding = task.capability === null ? undefined : bindings.get(task.capability)
  return modelText(binding?.deployment?.upstream_model_id)
}

function durationOf(task: StudioTask): number | null {
  const start = millis(task.started_at) ?? millis(task.created_at)
  const end = millis(task.finished_at) ?? millis(task.updated_at)
  if (start === null || end === null || end < start) return null
  return end - start
}

export function buildRunLog(sources: RunLogSources): RunLogRow[] {
  const { tasks, invocations, bindings, deployments } = sources
  const labels = new Map(bindings.map((item) => [item.capability, item.label]))
  const bindingBy = new Map(bindings.map((item) => [item.capability, item]))
  const deploymentBy = new Map(deployments.map((item) => [item.id, item]))

  const byTask = new Map<string, ModelInvocation[]>()
  for (const invocation of invocations) {
    const taskId = invocation.task_id
    if (taskId === null) continue
    const list = byTask.get(taskId)
    if (list === undefined) byTask.set(taskId, [invocation])
    else list.push(invocation)
  }
  for (const list of byTask.values()) {
    list.sort((a, b) => ((a.created_at ?? '') < (b.created_at ?? '') ? -1 : 1))
  }

  const roots = lineageRoots(tasks)
  const families = new Map<string, StudioTask[]>()
  for (const task of tasks) {
    const root = roots.get(task.id) ?? task.id
    const list = families.get(root)
    if (list === undefined) families.set(root, [task])
    else list.push(task)
  }
  for (const list of families.values()) {
    list.sort((a, b) => (millis(a.created_at) ?? 0) - (millis(b.created_at) ?? 0))
  }

  const rows = tasks.map((task) => {
    const own = byTask.get(task.id) ?? []
    const capability = task.capability ?? ''
    const capabilityLabel = capabilityTextOf(task, labels)
    const model = modelNameOf(task, own, deploymentBy, bindingBy)
    const prompt = taskPrompt(task)
    const sentPrompts: RunLogSentPrompt[] = []
    for (const invocation of own) {
      const text = sentPromptOf(invocation.request)
      if (text === '') continue
      sentPrompts.push({
        invocationId: invocation.id,
        model: modelText(invocation.model),
        text,
        rewritten: prompt !== '' && text.trim() !== prompt.trim(),
      })
    }
    const firstTokenMs = own.reduce<number | null>(
      (acc, item) => (acc === null && typeof item.first_token_ms === 'number' ? item.first_token_ms : acc),
      null,
    )
    const outputs = taskOutputs(task)
    const family = families.get(roots.get(task.id) ?? task.id) ?? [task]
    const lineage = family.map((item) => item.id)
    const error = task.error ?? ''
    const nodeId = task.node_id ?? ''
    const haystack = [
      prompt,
      ...sentPrompts.map((item) => item.text),
      error,
      model,
      capabilityLabel,
      capability,
      nodeId,
      task.id,
      task.tool_id,
      task.task_type,
      task.provider_task_id ?? '',
      task.status,
      ...own.map((item) => `${item.error_code ?? ''} ${item.error_message ?? ''}`),
    ]
      .join('\n')
      .toLowerCase()

    return {
      id: task.id,
      task,
      status: task.status,
      bucket: statusBucket(task.status),
      active: ACTIVE_TASK_STATUSES.has(task.status),
      capabilityLabel,
      capability,
      model,
      nodeId,
      createdMs: millis(task.created_at),
      durationMs: durationOf(task),
      firstTokenMs,
      prompt,
      sentPrompts,
      error,
      outputs,
      references: taskReferences(task),
      fields: taskFields(task),
      invocations: own,
      attempt: Math.max(1, lineage.indexOf(task.id) + 1),
      lineage,
      haystack,
    } satisfies RunLogRow
  })

  return rows.sort((a, b) => (b.createdMs ?? 0) - (a.createdMs ?? 0))
}

/* -------------------------------------------------------------- 筛选 */

function windowMs(value: string): number | null {
  return TIME_WINDOWS.find((item) => item.value === value)?.ms ?? null
}

/** 检索词按空白切成多个片段，全部命中才算命中（AND）。
 *  一次排查往往同时记得「哪个节点 + 报了什么」，AND 比 OR 有用得多。 */
export function searchTerms(search: string): string[] {
  return search
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== '')
}

export function filterRunLog(
  rows: RunLogRow[],
  filters: RunLogFilters,
  now: number = Date.now(),
): RunLogRow[] {
  const span = windowMs(filters.window)
  const terms = searchTerms(filters.search)
  return rows.filter((row) => {
    if (filters.status !== ALL && row.bucket !== filters.status) return false
    if (filters.capability !== ALL && row.capability !== filters.capability) return false
    if (filters.node !== ALL && row.nodeId !== filters.node) return false
    if (span !== null) {
      // 没有时间戳的行不该被时间窗静默吞掉，宁可留着让人看见
      if (row.createdMs !== null && now - row.createdMs > span) return false
    }
    return terms.every((term) => row.haystack.includes(term))
  })
}

/** 行的展开模型：点当前行收起，点别的行换过去。
 *  单选而不是多选——详情是一整块右侧面板，同时开两份没有位置放。 */
export function toggleSelection(current: string | null, id: string): string | null {
  return current === id ? null : id
}

/** 选中的那一行还在不在眼前这批里。筛掉了就当没选中，
 *  否则会出现「表里看不到、右边还开着它的详情」。 */
export function selectedRow(rows: RunLogRow[], id: string | null): RunLogRow | null {
  if (id === null) return null
  return rows.find((row) => row.id === id) ?? null
}

export function isFiltering(filters: RunLogFilters): boolean {
  return (Object.keys(EMPTY_FILTERS) as Array<keyof RunLogFilters>).some(
    (key) => filters[key] !== EMPTY_FILTERS[key],
  )
}

/* -------------------------------------------------------------- 汇总 */

export interface RunLogSummary {
  total: number
  active: number
  succeeded: number
  failed: number
  outputs: number
  /** 已收口任务的耗时中位数；一条都没收口时为 null */
  medianMs: number | null
}

export function summarizeRunLog(rows: RunLogRow[]): RunLogSummary {
  let active = 0
  let succeeded = 0
  let failed = 0
  let outputs = 0
  const durations: number[] = []
  for (const row of rows) {
    if (row.active) active += 1
    else if (row.bucket === 'succeeded') succeeded += 1
    else if (row.bucket === 'failed') failed += 1
    outputs += row.outputs.length
    if (!row.active && row.durationMs !== null) durations.push(row.durationMs)
  }
  durations.sort((a, b) => a - b)
  const medianMs = durations.length === 0 ? null : durations[Math.floor((durations.length - 1) / 2)]
  return { total: rows.length, active, succeeded, failed, outputs, medianMs }
}

/* ------------------------------------------------------- 筛选项候选值 */

export interface RunLogOption {
  value: string
  label: string
}

/** 候选值一律从眼前这批行里长出来：画布上没跑过的能力不该出现在筛选器里。 */
export function statusOptions(rows: RunLogRow[], current: string = ALL): RunLogOption[] {
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.bucket, (counts.get(row.bucket) ?? 0) + 1)
  const order: RunLogBucket[] = ['active', 'succeeded', 'partial', 'failed', 'cancelled']
  if (current !== ALL && !counts.has(current)) counts.set(current, 0)
  return [
    { value: ALL, label: `全部 ${rows.length}` },
    ...order
      .filter((bucket) => counts.has(bucket))
      .map((bucket) => ({ value: bucket, label: `${BUCKET_LABELS[bucket]} ${counts.get(bucket)}` })),
  ]
}

/** 选中项即使已经从数据里消失也要留在候选里：
 *  Radix Select 拿不到匹配项会显示成空触发器，看着像控件坏了。 */
export function capabilityOptions(rows: RunLogRow[], current: string = ALL): RunLogOption[] {
  const labels = new Map<string, string>()
  for (const row of rows) {
    if (row.capability === '') continue
    if (!labels.has(row.capability)) labels.set(row.capability, row.capabilityLabel)
  }
  if (current !== ALL && !labels.has(current)) labels.set(current, current)
  return [
    { value: ALL, label: '全部能力' },
    ...[...labels.entries()]
      .sort((a, b) => (a[1] < b[1] ? -1 : 1))
      .map(([value, label]) => ({ value, label })),
  ]
}

export function nodeOptions(rows: RunLogRow[], current: string = ALL): RunLogOption[] {
  const nodes = new Set<string>()
  for (const row of rows) if (row.nodeId !== '') nodes.add(row.nodeId)
  if (current !== ALL) nodes.add(current)
  return [
    { value: ALL, label: '全部节点' },
    ...[...nodes].sort().map((value) => ({ value, label: value })),
  ]
}

export function windowOptions(): RunLogOption[] {
  return [
    { value: ALL, label: '不限时间' },
    ...TIME_WINDOWS.map((item) => ({ value: item.value, label: item.label })),
  ]
}

/* -------------------------------------------------------------- 格式 */

/** 墙钟耗时的短格式。与账本的 `formatMs` 分开：那边是毫秒级的模型时延，
 *  这边动辄几分钟，同一套写法会出现「184000 ms」这种没法读的数。 */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(Math.round(seconds % 60)).padStart(2, '0')}s`
}

/** 列表里的时间：当天只给时分秒，跨天才补日期。
 *  非有限值一律给横杠——`Date.parse` 解不动时返回 NaN，直接渲染就是 "Invalid Date"。 */
export function formatClock(ms: number | null | undefined, now: number = Date.now()): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  const date = new Date(ms)
  const sameDay = date.toDateString() === new Date(now).toDateString()
  return sameDay ? date.toLocaleTimeString('zh-CN') : date.toLocaleString('zh-CN')
}

