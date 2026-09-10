import type { ImageAsset } from '@/lib/api-image'
import type { StudioTask } from '@/lib/api-studio'

export type OnlineRatio = 'square' | 'portrait' | 'landscape' | 'portrait43' | 'landscape43' | 'story' | 'wide' | 'custom'
export type OnlineResolution = '1k' | '2k' | '4k' | 'custom'

export interface OnlineImageHistoryItem {
  taskId: string
  asset: ImageAsset
  references: ImageAsset[]
  prompt: string
  provider: string
  model: string
  adapter: string
  size: string
  quality: string
  createdAt: string | null
}

export interface OnlineWorkflowField {
  id: string
  name: string
  type: string
  required: boolean
  bindPrompt: boolean
  randomEnabled: boolean
  imageOrder: number
  min: number | null
  max: number | null
  step: number | null
  defaultValue: unknown
  options: string[]
}

export const ONLINE_SIZES: Record<Exclude<OnlineRatio, 'custom'>, Record<Exclude<OnlineResolution, 'custom'>, string>> = {
  square: { '1k': '1024x1024', '2k': '2048x2048', '4k': '3840x2160' },
  portrait: { '1k': '1024x1536', '2k': '1360x2048', '4k': '2352x3520' },
  portrait43: { '1k': '1008x1344', '2k': '1536x2048', '4k': '2448x3264' },
  landscape43: { '1k': '1344x1008', '2k': '2048x1536', '4k': '3264x2448' },
  landscape: { '1k': '1536x1024', '2k': '2048x1360', '4k': '3520x2352' },
  story: { '1k': '720x1280', '2k': '1152x2048', '4k': '2160x3840' },
  wide: { '1k': '1280x720', '2k': '2048x1152', '4k': '3840x2160' },
}

const LONG_SIDE = { '1k': 1536, '2k': 2048, '4k': 3840 } as const
const PIXEL_LIMIT = { '1k': 1_572_864, '2k': 4_194_304, '4k': 8_294_400 } as const

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function onlineWorkflowFields(
  schema: Record<string, unknown> | null | undefined,
): OnlineWorkflowField[] {
  const values = Array.isArray(schema?.fields) ? schema.fields : []
  return values.flatMap((value, index) => {
    const item = recordOf(value)
    if (item === null) return []
    const id = typeof item.id === 'string' ? item.id : ''
    if (id === '' || item.enabled === false) return []
    const fieldName = typeof item.fieldName === 'string' ? item.fieldName : ''
    const label = typeof item.label === 'string' ? item.label : ''
    const group = typeof item.group === 'string' ? item.group : ''
    const name = typeof item.name === 'string' ? item.name : label || fieldName || id
    const type = String(item.type ?? item.fieldType ?? 'text').toLowerCase()
    const role = `${id} ${name} ${fieldName} ${group}`
    const numeric = (raw: unknown): number | null => {
      if (raw === null || raw === undefined || String(raw).trim() === '') return null
      const parsed = Number(raw)
      return Number.isFinite(parsed) ? parsed : null
    }
    return [{
      id,
      name,
      type,
      required: item.required === true,
      bindPrompt: item.bind_prompt === true || (['text', 'textarea'].includes(type) && /prompt|positive|negative|text|caption|description|关键词|提示词|正向|负向|描述/i.test(role)),
      randomEnabled: item.random_enabled === true,
      imageOrder: numeric(item.imageOrder) || index + 1,
      min: numeric(item.min),
      max: numeric(item.max),
      step: numeric(item.step),
      defaultValue: item.default ?? item.fieldValue,
      options: Array.isArray(item.options) ? item.options.map(String) : [],
    }]
  }).sort((left, right) => {
    if (left.type === 'image' && right.type === 'image') return left.imageOrder - right.imageOrder
    if (left.type === 'image') return -1
    if (right.type === 'image') return 1
    return 0
  })
}

export function onlineAspectFromSize(size: string): string {
  const [width, height] = size.split('x').map(Number)
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return '1:1'
  const gcd = (left: number, right: number): number => right === 0 ? left : gcd(right, left % right)
  const divisor = gcd(width, height)
  return `${width / divisor}:${height / divisor}`
}

export function onlineResolutionFromSize(size: string): string {
  const longest = Math.max(...size.split('x').map(Number))
  if (longest >= 3200) return '4k'
  if (longest >= 1400) return '2k'
  return '1k'
}

export function preferredOnlineWorkflowValue(
  field: OnlineWorkflowField,
  preferred: string | number,
): unknown {
  const value = String(preferred)
  if (field.options.length === 0 || field.options.includes(value)) return preferred
  return field.defaultValue ?? field.options[0] ?? preferred
}

export function randomOnlineWorkflowValue(field: OnlineWorkflowField): string {
  const lower = field.min ?? 0
  const upper = field.max ?? (/seed|noise|随机|种子|噪/i.test(field.name) ? 4_294_967_295 : 999_999)
  const min = Math.min(lower, upper)
  const max = Math.max(lower, upper)
  const step = field.step !== null && field.step > 0 ? field.step : 1
  const random = crypto.getRandomValues(new Uint32Array(1))[0] / 4_294_967_295
  const value = min + Math.round(((max - min) * random) / step) * step
  return Number.isInteger(step) && Number.isInteger(min) && Number.isInteger(max)
    ? String(Math.round(value))
    : String(value)
}

function positiveId(value: unknown): number | null {
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

function uniqueIds(values: unknown[]): number[] {
  return [...new Set(values.flatMap((value) => {
    const id = positiveId(value)
    return id === null ? [] : [id]
  }))]
}

export function onlineResultAssetIds(task: Pick<StudioTask, 'result'>): number[] {
  const result = task.result
  if (result === null) return []
  const direct = Array.isArray(result.asset_ids) ? result.asset_ids : []
  const items = Array.isArray(result.items)
    ? result.items.map((item) => recordOf(item)?.asset_id)
    : []
  return uniqueIds([...direct, ...items])
}

export function onlineReferenceAssetIds(
  task: Pick<StudioTask, 'invocation' | 'source_context'>,
): number[] {
  const explicit = Array.isArray(task.source_context?.reference_asset_ids)
    ? task.source_context.reference_asset_ids
    : []
  const direct = Array.isArray(task.invocation?.ref_asset_ids)
    ? task.invocation.ref_asset_ids
    : []
  const options = recordOf(task.invocation?.options)
  const nested = Array.isArray(options?.ref_asset_ids) ? options.ref_asset_ids : []
  return uniqueIds([...explicit, ...direct, ...nested])
}

export function onlineTaskPrompt(
  task: Pick<StudioTask, 'invocation' | 'source_context'>,
): string {
  for (const value of [
    task.source_context?.prompt,
    task.invocation?.prompt,
    task.invocation?.prompt_override,
  ]) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

export function onlineHistoryItems(
  task: Pick<StudioTask, 'id' | 'invocation' | 'result' | 'source_context' | 'created_at'>,
  assets: ImageAsset[],
): OnlineImageHistoryItem[] {
  const byId = new Map(assets.map((asset) => [asset.id, asset]))
  const references = onlineReferenceAssetIds(task).flatMap((id) => {
    const asset = byId.get(id)
    return asset === undefined || asset.status === 'archived' ? [] : [asset]
  })
  const context = task.source_context ?? {}
  const prompt = onlineTaskPrompt(task)
  return onlineResultAssetIds(task).flatMap((id) => {
    const asset = byId.get(id)
    if (asset === undefined || asset.status === 'archived') return []
    return [{
      taskId: task.id,
      asset,
      references,
      prompt: prompt || asset.prompt,
      provider: typeof context.provider_name === 'string' ? context.provider_name : 'Online',
      model: typeof context.model === 'string' ? context.model : '',
      adapter: typeof context.adapter_type === 'string' ? context.adapter_type : '',
      size: typeof context.size === 'string' ? context.size : `${asset.width}x${asset.height}`,
      quality: typeof context.quality === 'string' ? context.quality : 'auto',
      createdAt: task.created_at,
    }]
  })
}

function aligned(value: number): number {
  return Math.max(64, Math.floor(value / 16) * 16)
}

export function onlineImageSize(
  ratio: OnlineRatio,
  resolution: OnlineResolution,
  custom: { width?: number; height?: number; ratioWidth?: number; ratioHeight?: number },
): string | null {
  if (resolution === 'custom') {
    const width = Number(custom.width)
    const height = Number(custom.height)
    if (!Number.isInteger(width) || !Number.isInteger(height)) return null
    if (width < 64 || height < 64 || width > 3840 || height > 3840) return null
    if (width % 16 !== 0 || height % 16 !== 0) return null
    const aspect = width / height
    return aspect >= 1 / 3 && aspect <= 3 ? `${width}x${height}` : null
  }
  if (ratio !== 'custom') return ONLINE_SIZES[ratio][resolution]
  const rw = Number(custom.ratioWidth)
  const rh = Number(custom.ratioHeight)
  if (!Number.isFinite(rw) || !Number.isFinite(rh) || rw <= 0 || rh <= 0) return null
  const aspect = rw / rh
  if (aspect < 1 / 3 || aspect > 3) return null
  const longest = LONG_SIDE[resolution]
  const pixels = PIXEL_LIMIT[resolution]
  const rawWidth = aspect >= 1
    ? longest
    : Math.min(longest * aspect, Math.sqrt(pixels * aspect))
  const rawHeight = aspect >= 1
    ? Math.min(longest / aspect, Math.sqrt(pixels / aspect))
    : longest
  return `${aligned(rawWidth)}x${aligned(rawHeight)}`
}

export function deploymentPage<T>(items: T[], page: number, size = 8): { items: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / size))
  const safePage = Math.max(0, Math.min(Math.trunc(page), pages - 1))
  return { items: items.slice(safePage * size, (safePage + 1) * size), page: safePage, pages }
}
