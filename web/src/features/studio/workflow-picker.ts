/* 工作流选择弹窗的纯逻辑：用途归类、搜索、排序、使用记录。

   拆出来是为了能单测——弹窗本体在 node 里只渲染得出首帧，
   「搜『改图』能不能搜到 GPT-Image-2」这种事在首帧快照里看不出来。

   服务端目前不给工作流描述字段（`/studio/workflows` 只有 title / provider /
   kind / field_count 这些），所以「这个工作流是干什么的」只能在前端从
   标题 + kind 反推。等后端补上 description，把 `workflowPurpose` 里的
   兜底换成真值即可，调用方不用动。 */

import type { ExecutableWorkflow } from '../../lib/api-studio'

export type WorkflowPurposeId = 'video' | 'upscale' | 'edit' | 'image' | 'other'

export interface WorkflowPurpose {
  id: WorkflowPurposeId
  /** 卡片上的用途标签，两到四个字 */
  label: string
  /** 一句话说明它拿来干什么 */
  hint: string
  /** 搜索别名：用户搜「改图」也该命中标题里只写「编辑」的那些 */
  terms: string[]
}

/** 用途固定按这个顺序露出，跟着数据顺序走会让筛选条每次刷新都在跳 */
const PURPOSE_ORDER: WorkflowPurposeId[] = ['image', 'edit', 'upscale', 'video', 'other']

const PURPOSES: Record<WorkflowPurposeId, WorkflowPurpose> = {
  image: {
    id: 'image',
    label: '文生图',
    hint: '一句提示词直接出图',
    terms: ['生图', '出图', '文生图', '画图', 'image', 't2i'],
  },
  edit: {
    id: 'edit',
    label: '图片编辑',
    hint: '按参考图改图、迁移风格、补细节',
    terms: ['编辑', '改图', '重绘', '迁移', '风格', '参考图', '增强', '修图', 'edit'],
  },
  upscale: {
    id: 'upscale',
    label: '高清放大',
    hint: '放大到高清，顺带补细节',
    terms: ['放大', '超分', '高清', '画质', 'upscale'],
  },
  video: {
    id: 'video',
    label: '视频生成',
    hint: '按提示与参考图生成视频片段',
    terms: ['视频', '动画', '片段', 'video'],
  },
  other: {
    id: 'other',
    label: '通用工作流',
    hint: '自定义节点图，按自己的参数跑',
    terms: ['工作流', '通用', '自定义', 'workflow'],
  },
}

/* 先命中先算数，顺序不能乱：
   「SeedVR2 高清放大」既有「高清」又落在 upscale，得先于 edit 判；
   「Flux.2 Klein 细节增强」只有「增强」这一个线索，归 edit。 */
const MATCHERS: Array<[WorkflowPurposeId, RegExp]> = [
  ['video', /视频|动画|片段|video|clip/],
  ['upscale', /放大|超分|高清|画质|upscale|seedvr|hires/],
  ['edit', /编辑|改图|重绘|迁移|参考|增强|修图|修复|抠图|换脸|edit|inpaint|kontext/],
  ['image', /生图|出图|文生图|画图|image|txt2img|t2i/],
]

/** 从标题 + kind 反推用途。判不出来算通用，不瞎猜 */
export function workflowPurpose(workflow: ExecutableWorkflow): WorkflowPurpose {
  const text = `${workflow.title} ${workflow.kind}`.toLowerCase()
  for (const [id, re] of MATCHERS) {
    if (re.test(text)) return PURPOSES[id]
  }
  return PURPOSES.other
}

export function providerLabel(provider: ExecutableWorkflow['provider']): string {
  return provider === 'comfyui' ? 'ComfyUI' : 'RunningHub'
}

/** 来源的搜索别名。用户会搜「云端」而不是「runninghub」 */
const PROVIDER_TERMS: Record<ExecutableWorkflow['provider'], string[]> = {
  comfyui: ['comfyui', 'comfy', '本地'],
  runninghub: ['runninghub', 'rh', '云端', '在线'],
}

/** 搜索命中的整片草堆：名字之外还要能搜到用途、来源、内置/自建 */
function workflowHaystack(workflow: ExecutableWorkflow): string {
  const purpose = workflowPurpose(workflow)
  return [
    workflow.title,
    workflow.key,
    workflow.source_id ?? '',
    workflow.kind,
    providerLabel(workflow.provider),
    ...PROVIDER_TERMS[workflow.provider],
    purpose.label,
    purpose.hint,
    ...purpose.terms,
    workflow.source === 'bundled' ? '内置 预置' : '自建 导入',
  ]
    .join(' ')
    .toLowerCase()
}

/** 多个词按「都要命中」算，「klein 增强」只留同时满足两者的那条 */
export function matchesWorkflowQuery(workflow: ExecutableWorkflow, query: string): boolean {
  const needles = query.trim().toLowerCase().split(/\s+/).filter((word) => word !== '')
  if (needles.length === 0) return true
  const hay = workflowHaystack(workflow)
  return needles.every((needle) => hay.includes(needle))
}

export interface WorkflowUsage {
  /** 选中过几次 */
  count: number
  /** 上次选中的时间戳（毫秒） */
  last: number
}

export type WorkflowUsageMap = Record<string, WorkflowUsage>

export interface WorkflowFilter {
  provider: 'all' | ExecutableWorkflow['provider']
  purpose: 'all' | WorkflowPurposeId
  query: string
}

export function filterWorkflows(
  items: readonly ExecutableWorkflow[],
  filter: WorkflowFilter,
): ExecutableWorkflow[] {
  return items.filter(
    (workflow) =>
      (filter.provider === 'all' || workflow.provider === filter.provider) &&
      (filter.purpose === 'all' || workflowPurpose(workflow).id === filter.purpose) &&
      matchesWorkflowQuery(workflow, filter.query),
  )
}

/** 常用的排前面：先比次数，次数一样比最近一次，都没用过按名字排 */
export function sortWorkflows(
  items: readonly ExecutableWorkflow[],
  usage: WorkflowUsageMap,
): ExecutableWorkflow[] {
  return [...items].sort((a, b) => {
    const left = usage[a.key]
    const right = usage[b.key]
    const countGap = (right?.count ?? 0) - (left?.count ?? 0)
    if (countGap !== 0) return countGap
    const lastGap = (right?.last ?? 0) - (left?.last ?? 0)
    if (lastGap !== 0) return lastGap
    return a.title.localeCompare(b.title, 'zh')
  })
}

export interface WorkflowGroup {
  id: 'all' | 'recent' | 'rest'
  /** 空串表示这一组不加小标题 */
  label: string
  items: ExecutableWorkflow[]
}

/** 常用区最多摆一行半，再多就不叫「常用」了 */
const RECENT_MAX = 6

/** 分区展示。搜索时不分区——搜出来的顺序本身就是答案，再套个小标题只会打断阅读 */
export function groupWorkflows(
  sorted: readonly ExecutableWorkflow[],
  usage: WorkflowUsageMap,
  searching: boolean,
): WorkflowGroup[] {
  if (sorted.length === 0) return []
  const used = sorted.filter((item) => (usage[item.key]?.count ?? 0) > 0)
  if (searching || used.length === 0) {
    return [{ id: 'all', label: '', items: [...sorted] }]
  }
  const recent = used.slice(0, RECENT_MAX)
  const recentKeys = new Set(recent.map((item) => item.key))
  return [
    { id: 'recent' as const, label: '常用', items: recent },
    { id: 'rest' as const, label: '其余工作流', items: sorted.filter((item) => !recentKeys.has(item.key)) },
  ].filter((group) => group.items.length > 0)
}

export interface PurposeFacet {
  id: WorkflowPurposeId
  label: string
  count: number
}

/** 用途筛选条只列真有货的那几档，空档位摆出来只会让人白点一次 */
export function purposeFacets(items: readonly ExecutableWorkflow[]): PurposeFacet[] {
  const tally = new Map<WorkflowPurposeId, number>()
  for (const workflow of items) {
    const id = workflowPurpose(workflow).id
    tally.set(id, (tally.get(id) ?? 0) + 1)
  }
  return PURPOSE_ORDER.filter((id) => tally.has(id)).map((id) => ({
    id,
    label: PURPOSES[id].label,
    count: tally.get(id) ?? 0,
  }))
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 卡片上的「上次用过」。精确到分钟没意义，用户只想知道是不是熟面孔 */
export function usedAtLabel(last: number, now: number): string {
  const gap = Math.max(0, now - last)
  if (gap < 5 * MINUTE) return '刚刚用过'
  if (gap < HOUR) return `${Math.floor(gap / MINUTE)} 分钟前用过`
  if (gap < DAY) return `${Math.floor(gap / HOUR)} 小时前用过`
  if (gap < 2 * DAY) return '昨天用过'
  if (gap < 30 * DAY) return `${Math.floor(gap / DAY)} 天前用过`
  return '很久以前用过'
}

export interface UsageStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** 带 `lingua.` 前缀和别的站点、别的功能分开 */
const USAGE_KEY = 'lingua.studio.workflow-usage'
/** 工作流总共十几条，留 200 个位置足够；封顶是防止改名后旧键无限堆积 */
const USAGE_MAX = 200

function browserStorage(): UsageStorage | null {
  try {
    // Safari 无痕模式读 localStorage 直接抛，这项偏好不值得让弹窗跟着崩
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function isUsage(value: unknown): value is WorkflowUsage {
  if (typeof value !== 'object' || value === null) return false
  const raw = value as { count?: unknown; last?: unknown }
  return Number.isFinite(raw.count) && Number.isFinite(raw.last)
}

export function readWorkflowUsage(storage: UsageStorage | null = browserStorage()): WorkflowUsageMap {
  if (storage === null) return {}
  let raw: string | null
  try {
    raw = storage.getItem(USAGE_KEY)
  } catch {
    return {}
  }
  if (raw === null || raw === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const result: WorkflowUsageMap = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (isUsage(value)) result[key] = { count: value.count, last: value.last }
  }
  return result
}

/** 记一次选中并落盘。写失败（配额满 / 无痕模式）只是丢排序偏好，不该抛 */
export function recordWorkflowUsage(
  key: string,
  options: { now?: number; storage?: UsageStorage | null } = {},
): WorkflowUsageMap {
  const storage = options.storage === undefined ? browserStorage() : options.storage
  const now = options.now ?? Date.now()
  const current = readWorkflowUsage(storage)
  const previous = current[key]
  const next: WorkflowUsageMap = {
    ...current,
    [key]: { count: (previous?.count ?? 0) + 1, last: now },
  }
  const entries = Object.entries(next)
  const kept =
    entries.length <= USAGE_MAX
      ? entries
      : entries.sort((a, b) => b[1].last - a[1].last).slice(0, USAGE_MAX)
  const pruned = Object.fromEntries(kept)
  if (storage !== null) {
    try {
      storage.setItem(USAGE_KEY, JSON.stringify(pruned))
    } catch {
      // 落盘失败就只在本次会话里生效
    }
  }
  return pruned
}
