/* 工坊首页的渲染侧数据层。

   工具身份、能力、路由与状态的事实源是服务端 ToolPluginRegistry；这里只贡献三样
   服务端不该管的东西：Lucide 图标、卡片的分组与排序、状态值到视觉档位的归一。 */

import { useQuery } from '@tanstack/react-query'
import {
  AppWindow,
  Boxes,
  Clapperboard,
  CloudCog,
  Crop,
  FileClock,
  Focus,
  GalleryHorizontalEnd,
  Globe,
  Grid3x3,
  Image as ImageIcon,
  LibraryBig,
  MessageSquareText,
  MessagesSquare,
  PackageOpen,
  PanelsTopLeft,
  Receipt,
  ScanSearch,
  Sparkles,
  Wand2,
  Zap,
} from '@/components/NexusIcon'
import type { LucideIcon } from '@/components/NexusIcon'

import { apiStudio } from '@/lib/api-studio'
import type { StudioTask, StudioToolPlugin } from '@/lib/api-studio'

import { ACTIVE_TASK_STATUSES } from './taskQueries'

const TOOL_ICONS: Record<string, LucideIcon> = {
  'infinite-canvas': Boxes,
  'chat-image': MessagesSquare,
  'image-console': ImageIcon,
  'image-editor': Crop,
  'klein-editor': Wand2,
  enhance: Sparkles,
  'angle-control': Focus,
  'zimage-generator': Zap,
  'online-image': CloudCog,
  'gpt-creative': MessageSquareText,
  'video-director': Clapperboard,
  panorama: Globe,
  'frame-extractor': GalleryHorizontalEnd,
  'grid-tool': Grid3x3,
  'asset-library': LibraryBig,
  'prompt-library': Wand2,
  'workflow-center': PanelsTopLeft,
  'model-lab': Receipt,
  'canvas-projects': PackageOpen,
  'chrome-collector': ScanSearch,
  'photoshop-connector': AppWindow,
  'update-backup': FileClock,
}

export interface StudioToolDefinition extends StudioToolPlugin {
  icon: LucideIcon
}

export function studioToolIcon(id: string): LucideIcon | undefined {
  return TOOL_ICONS[id]
}

export function decorateStudioTool(tool: StudioToolPlugin): StudioToolDefinition {
  return { ...tool, icon: TOOL_ICONS[tool.id] ?? Boxes }
}

/* ==================== 状态归一 ==================== */

/** 卡片上的视觉档位。可用是默认预期，所以 ready 不带任何标记。 */
export type StudioToolTone = 'ready' | 'beta' | 'planned'

/** 服务端 status → 视觉档位。
 *  取字符串而不是联合类型：服务端加新档位时这里要能兜住，未知值一律按 beta 收，
 *  宁可少标一次可用，也不要因为多出来的枚举把卡片渲染成空白。 */
export function toolTone(status: string): StudioToolTone {
  const value = status.trim().toLowerCase()
  if (value === 'ready') return 'ready'
  if (value === 'planned') return 'planned'
  return 'beta'
}

/** 一句话的已知缺口。旧后端不带这个字段，所以按可选值读，不信类型上的必填。 */
export function toolGap(tool: StudioToolPlugin): string | null {
  const value: unknown = tool.gap
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text === '' ? null : text
}

/* ==================== 卡片分组 ==================== */

export type StudioSectionId = 'primary' | 'image' | 'motion' | 'library' | 'connect'

export interface StudioSection {
  id: StudioSectionId
  label: string
  hint: string
  /** 主力入口用大卡：一天里点得最多的四个，不该和二十张卡长一个样 */
  lead: boolean
  tools: StudioToolDefinition[]
}

const SECTION_META: ReadonlyArray<Omit<StudioSection, 'tools'>> = [
  { id: 'primary', label: '常用', hint: '每天从这里进出', lead: true },
  { id: 'image', label: '生成与精修', hint: '单张图的产出与返工', lead: false },
  { id: 'motion', label: '视频与拼版', hint: '成片、抽帧与版式', lead: false },
  { id: 'library', label: '素材与流程', hint: '存下来、复用、看账', lead: false },
  { id: 'connect', label: '连接器', hint: '把外部工具接进来', lead: false },
]

/** 按使用频率与工作流顺序排定的位置。没登记的新工具走 category 兜底，排在已登记之后。 */
const TOOL_PLACEMENT: Record<string, { section: StudioSectionId; rank: number }> = {
  'infinite-canvas': { section: 'primary', rank: 0 },
  'image-console': { section: 'primary', rank: 1 },
  'chat-image': { section: 'primary', rank: 2 },
  'asset-library': { section: 'primary', rank: 3 },

  'online-image': { section: 'image', rank: 0 },
  'zimage-generator': { section: 'image', rank: 1 },
  'klein-editor': { section: 'image', rank: 2 },
  'image-editor': { section: 'image', rank: 3 },
  enhance: { section: 'image', rank: 4 },
  'angle-control': { section: 'image', rank: 5 },
  'gpt-creative': { section: 'image', rank: 6 },

  'video-director': { section: 'motion', rank: 0 },
  'frame-extractor': { section: 'motion', rank: 1 },
  'grid-tool': { section: 'motion', rank: 2 },
  panorama: { section: 'motion', rank: 3 },

  'prompt-library': { section: 'library', rank: 0 },
  'workflow-center': { section: 'library', rank: 1 },
  'canvas-projects': { section: 'library', rank: 2 },
  'model-lab': { section: 'library', rank: 3 },

  'chrome-collector': { section: 'connect', rank: 0 },
  'photoshop-connector': { section: 'connect', rank: 1 },
  'update-backup': { section: 'connect', rank: 2 },
}

const SECTION_BY_CATEGORY: Record<string, StudioSectionId> = {
  create: 'image',
  manage: 'library',
  connect: 'connect',
}

/** 兜底位次的起点，保证未登记的工具永远排在登记过的后面 */
const FALLBACK_RANK = 1000

export function groupStudioTools(tools: StudioToolPlugin[]): StudioSection[] {
  const buckets = new Map<StudioSectionId, { rank: number; tool: StudioToolDefinition }[]>()
  tools.forEach((tool, index) => {
    const placement = TOOL_PLACEMENT[tool.id]
    const section = placement?.section ?? SECTION_BY_CATEGORY[tool.category] ?? 'library'
    const rank = placement?.rank ?? FALLBACK_RANK + index
    const list = buckets.get(section) ?? []
    list.push({ rank, tool: decorateStudioTool(tool) })
    buckets.set(section, list)
  })
  return SECTION_META.flatMap((meta) => {
    const list = buckets.get(meta.id) ?? []
    if (list.length === 0) return []
    // 没做的沉到本段末尾：它点不动，占着前排只会让人反复去点
    list.sort((a, b) => {
      const plannedGap =
        Number(toolTone(a.tool.status) === 'planned') - Number(toolTone(b.tool.status) === 'planned')
      if (plannedGap !== 0) return plannedGap
      if (a.rank !== b.rank) return a.rank - b.rank
      return a.tool.id < b.tool.id ? -1 : 1
    })
    return [{ ...meta, tools: list.map((item) => item.tool) }]
  })
}

/* ==================== 首页活跃度 ==================== */

export interface StudioActivity {
  running: number
  doneToday: number
}

/** 首页顶部那行数字。取本地自然日，跨零点自动归零。 */
export function summarizeStudioActivity(
  tasks: StudioTask[],
  now: Date = new Date(),
): StudioActivity {
  const today = now.toDateString()
  let running = 0
  let doneToday = 0
  for (const task of tasks) {
    if (ACTIVE_TASK_STATUSES.has(task.status)) {
      running += 1
      continue
    }
    if (task.status !== 'succeeded') continue
    const finished = task.finished_at
    if (finished === null || finished === '') continue
    const at = new Date(finished)
    if (Number.isNaN(at.getTime())) continue
    if (at.toDateString() === today) doneToday += 1
  }
  return { running, doneToday }
}

export function useStudioToolCatalog() {
  return useQuery({
    queryKey: ['studio-catalog'],
    queryFn: apiStudio.catalog,
    staleTime: 60_000,
  })
}
