import type { ImageAsset } from '@/lib/api-image'
import type { StudioTask } from '@/lib/api-studio'

import type { AnglePose } from './angleInstruction'

export type AngleEngine = 'local' | 'modelscope'

export interface AngleHistoryItem {
  taskId: string
  asset: ImageAsset
  source: ImageAsset | null
  engine: AngleEngine
  prompt: string
  instruction: string
  pose: AnglePose
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

export function angleResultAssetIds(task: Pick<StudioTask, 'result'>): number[] {
  const result = task.result
  if (result === null) return []
  const values: unknown[] = Array.isArray(result.asset_ids) ? [...result.asset_ids] : []
  if (Array.isArray(result.items)) values.push(...result.items.map((item) => recordOf(item)?.asset_id))
  return [...new Set(values.flatMap((value) => {
    const id = positiveId(value)
    return id === null ? [] : [id]
  }))]
}

export function angleSourceAssetId(task: Pick<StudioTask, 'source_context'>): number | null {
  return positiveId(task.source_context?.source_asset_id)
    ?? positiveId(task.source_context?.asset_id)
}

function numberOr(value: unknown, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

export function angleHistoryItems(
  task: Pick<StudioTask, 'id' | 'result' | 'source_context' | 'created_at'>,
  assets: ImageAsset[],
): AngleHistoryItem[] {
  const explicit = task.source_context?.angle_engine
  if (explicit !== 'local' && explicit !== 'modelscope') return []
  const byId = new Map(assets.map((asset) => [asset.id, asset]))
  const source = byId.get(angleSourceAssetId(task) ?? -1) ?? null
  const poseRaw = recordOf(task.source_context?.pose)
  const pose: AnglePose = {
    yaw: numberOr(poseRaw?.yaw, 0),
    pitch: numberOr(poseRaw?.pitch, 0),
    distance: numberOr(poseRaw?.distance, 4),
  }
  const prompt = typeof task.source_context?.prompt === 'string' ? task.source_context.prompt : ''
  const instruction = typeof task.source_context?.instruction === 'string'
    ? task.source_context.instruction
    : ''
  return angleResultAssetIds(task).flatMap((id) => {
    const asset = byId.get(id)
    if (asset === undefined || asset.status === 'archived') return []
    return [{
      taskId: task.id,
      asset,
      source,
      engine: explicit,
      prompt: prompt || asset.prompt,
      instruction,
      pose,
      createdAt: task.created_at,
    }]
  })
}
