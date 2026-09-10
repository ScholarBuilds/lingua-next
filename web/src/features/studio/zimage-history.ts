import type { ImageAsset } from '@/lib/api-image'
import type { StudioTask } from '@/lib/api-studio'

export type ZImageEngine = 'local' | 'modelscope'

export interface ZImageHistoryItem {
  taskId: string
  engine: ZImageEngine
  prompt: string
  createdAt: string | null
  asset: ImageAsset
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function positiveId(value: unknown): number | null {
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

export function zImageTaskAssetIds(task: Pick<StudioTask, 'result'>): number[] {
  const result = task.result
  if (result === null) return []
  const ids: number[] = []
  if (Array.isArray(result.asset_ids)) {
    for (const value of result.asset_ids) {
      const id = positiveId(value)
      if (id !== null) ids.push(id)
    }
  }
  if (Array.isArray(result.items)) {
    for (const value of result.items) {
      const id = positiveId(objectOf(value)?.asset_id)
      if (id !== null) ids.push(id)
    }
  }
  return [...new Set(ids)]
}

export function zImageTaskPrompt(
  task: Pick<StudioTask, 'invocation' | 'source_context'>,
): string {
  const invocation = task.invocation
  const fields = objectOf(invocation?.fields)
  for (const value of [
    invocation?.prompt_override,
    fields?.f_prompt,
    task.source_context?.prompt,
  ]) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

export function zImageTaskEngine(
  task: Pick<StudioTask, 'task_type' | 'source_context'>,
): ZImageEngine {
  const explicit = task.source_context?.zimage_engine
  if (explicit === 'local' || explicit === 'modelscope') return explicit
  return task.task_type.startsWith('workflow.') ? 'local' : 'modelscope'
}

export function zImageHistoryItems(
  task: Pick<StudioTask, 'id' | 'task_type' | 'invocation' | 'result' | 'source_context' | 'created_at'>,
  assets: ImageAsset[],
): ZImageHistoryItem[] {
  const byId = new Map(assets.map((asset) => [asset.id, asset]))
  const prompt = zImageTaskPrompt(task)
  const engine = zImageTaskEngine(task)
  return zImageTaskAssetIds(task).flatMap((id) => {
    const asset = byId.get(id)
    if (asset === undefined || asset.status === 'archived') return []
    return [{
      taskId: task.id,
      engine,
      prompt: prompt || asset.prompt,
      createdAt: task.created_at,
      asset,
    }]
  })
}

export function normalizeZImageDimension(value: number): number | null {
  if (!Number.isInteger(value) || value < 256 || value > 4096 || value % 64 !== 0) return null
  return value
}
