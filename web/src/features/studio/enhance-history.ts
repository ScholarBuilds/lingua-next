import type { ImageAsset } from '@/lib/api-image'
import type { StudioTask } from '@/lib/api-studio'

export interface EnhanceHistoryItem {
  taskId: string
  asset: ImageAsset
  source: ImageAsset | null
  strength: number
  resolution: 2048 | 4096 | null
  createdAt: string | null
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function positiveId(value: unknown): number | null {
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

export function enhanceTaskAssetIds(task: Pick<StudioTask, 'result'>): number[] {
  const result = task.result
  if (result === null) return []
  const values: unknown[] = Array.isArray(result.asset_ids) ? [...result.asset_ids] : []
  if (Array.isArray(result.items)) {
    values.push(...result.items.map((item) => recordOf(item)?.asset_id))
  }
  return [...new Set(values.flatMap((value) => {
    const id = positiveId(value)
    return id === null ? [] : [id]
  }))]
}

export function enhanceSourceAssetId(
  task: Pick<StudioTask, 'source_context'>,
): number | null {
  return positiveId(task.source_context?.source_asset_id)
    ?? positiveId(task.source_context?.asset_id)
}

export function enhanceHistoryItems(
  task: Pick<StudioTask, 'id' | 'result' | 'source_context' | 'created_at'>,
  assets: ImageAsset[],
): EnhanceHistoryItem[] {
  if (task.source_context?.enhance_engine !== 'local') return []
  if (task.source_context?.history_visible === false) return []
  const byId = new Map(assets.map((asset) => [asset.id, asset]))
  const source = byId.get(enhanceSourceAssetId(task) ?? -1) ?? null
  const rawStrength = Number(task.source_context?.strength ?? 0.5)
  const strength = Number.isFinite(rawStrength) ? rawStrength : 0.5
  const rawResolution = Number(task.source_context?.upscale_resolution)
  const resolution = rawResolution === 2048 || rawResolution === 4096 ? rawResolution : null
  return enhanceTaskAssetIds(task).flatMap((id) => {
    const asset = byId.get(id)
    if (asset === undefined || asset.status === 'archived') return []
    return [{ taskId: task.id, asset, source, strength, resolution, createdAt: task.created_at }]
  })
}
