import type { ImageAsset } from '@/lib/api-image'
import type { StudioTask } from '@/lib/api-studio'

export type KleinEngine = 'local' | 'modelscope'

export interface KleinHistoryItem {
  taskId: string
  engine: KleinEngine
  prompt: string
  createdAt: string | null
  asset: ImageAsset
  references: ImageAsset[]
  loraStrength: number | null
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

function uniqueIds(values: unknown[]): number[] {
  const ids = values.flatMap((value) => {
    const id = positiveId(value)
    return id === null ? [] : [id]
  })
  return [...new Set(ids)]
}

export function kleinResultAssetIds(task: Pick<StudioTask, 'result'>): number[] {
  const result = task.result
  if (result === null) return []
  const direct = Array.isArray(result.asset_ids) ? result.asset_ids : []
  const items = Array.isArray(result.items)
    ? result.items.map((item) => recordOf(item)?.asset_id)
    : []
  return uniqueIds([...direct, ...items])
}

export function kleinReferenceAssetIds(
  task: Pick<StudioTask, 'invocation' | 'source_context'>,
): number[] {
  const context = task.source_context
  const explicit = Array.isArray(context?.reference_asset_ids)
    ? context.reference_asset_ids
    : []
  const options = recordOf(task.invocation?.options)
  const invocation = Array.isArray(options?.ref_asset_ids) ? options.ref_asset_ids : []
  return uniqueIds([...explicit, ...invocation])
}

export function kleinTaskPrompt(
  task: Pick<StudioTask, 'invocation' | 'source_context'>,
): string {
  const fields = recordOf(task.invocation?.fields)
  for (const value of [
    task.invocation?.prompt,
    task.invocation?.prompt_override,
    fields?.f_prompt,
    task.source_context?.prompt,
  ]) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

export function kleinHistoryItems(
  task: Pick<StudioTask, 'id' | 'task_type' | 'invocation' | 'result' | 'source_context' | 'created_at'>,
  assets: ImageAsset[],
): KleinHistoryItem[] {
  const byId = new Map(assets.map((asset) => [asset.id, asset]))
  const references = kleinReferenceAssetIds(task).flatMap((id) => {
    const asset = byId.get(id)
    return asset === undefined || asset.status === 'archived' ? [] : [asset]
  })
  const rawStrength = task.source_context?.lora_strength
  const loraStrength = typeof rawStrength === 'number' && Number.isFinite(rawStrength)
    ? rawStrength
    : null
  const explicit = task.source_context?.klein_engine
  const engine: KleinEngine = explicit === 'modelscope' ? 'modelscope' : 'local'
  return kleinResultAssetIds(task).flatMap((id) => {
    const asset = byId.get(id)
    if (asset === undefined || asset.status === 'archived') return []
    return [{
      taskId: task.id,
      engine,
      prompt: kleinTaskPrompt(task) || asset.prompt,
      createdAt: task.created_at,
      asset,
      references,
      loraStrength,
    }]
  })
}

export function kleinCloudSize(width: number, height: number): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 1024, height: 1024 }
  }
  const max = 2048
  const longest = Math.max(width, height)
  const scale = longest > max ? max / longest : 1
  const align = (value: number) => Math.min(max, Math.max(512, Math.round(value * scale / 64) * 64))
  return { width: align(width), height: align(height) }
}
