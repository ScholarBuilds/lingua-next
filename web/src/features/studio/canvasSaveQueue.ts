import { toast } from 'sonner'
import type { CanvasConnection, CanvasViewport } from '@/lib/api-studio'
import type { ScvNode } from './canvasStore'
import { createTombstones } from './canvas-tombstones'

export const activeSaves = new Map<number, Promise<void>>()
export const drafts = new Map<number, SaveSnapshot>()
export const savedVersions = new Map<number, number>()
export interface SaveSnapshot {
  canvasId: number
  doc: { nodes: ScvNode[]; connections: CanvasConnection[]; viewport: CanvasViewport }
  version: number
  snapshotAt: number
  generation: number
  runningIds: Set<string>
  tombstones: ReturnType<typeof createTombstones>
}

export function readCanvasDraft(canvasId: number, generation: number): SaveSnapshot | undefined {
  try {
    const raw = localStorage.getItem(`nexus:canvas-draft:${canvasId}`)
    if (!raw) return
    const value = JSON.parse(raw)
    if (value.canvasId !== canvasId || !Array.isArray(value.doc?.nodes) ||
      !Array.isArray(value.doc?.connections) || !Number.isInteger(value.version)) return
    return { ...value, generation, runningIds: new Set(value.runningIds),
      tombstones: { nodes: new Map(value.tombstones.nodes), edges: new Map(value.tombstones.edges) } }
  } catch {
    toast.error('本机画布草稿无法读取，请检查存储权限')
  }
}

export function cacheCanvasDraft(canvasId: number): void {
  if (typeof localStorage === 'undefined') return
  try {
    const draft = drafts.get(canvasId)
    if (!draft) { localStorage.removeItem(`nexus:canvas-draft:${canvasId}`); return }
    localStorage.setItem(`nexus:canvas-draft:${canvasId}`, JSON.stringify({ ...draft,
      runningIds: [...draft.runningIds], tombstones: { nodes: [...draft.tombstones.nodes], edges: [...draft.tombstones.edges] },
    }))
  } catch {
    toast.error('本机画布缓存不可用，请在离开应用前重试保存', { id: 'canvas-cache' })
  }
}

export function drainCanvas(canvasId: number, persist: (snapshot: SaveSnapshot) => Promise<boolean>): Promise<void> {
  const active = activeSaves.get(canvasId)
  if (active) return active
  const task = (async () => {
    while (drafts.has(canvasId)) {
      const snapshot = drafts.get(canvasId)!
      if (!await persist(snapshot)) break
      if (drafts.get(canvasId) === snapshot) drafts.delete(canvasId)
      cacheCanvasDraft(canvasId)
    }
  })().finally(() => { activeSaves.delete(canvasId) })
  activeSaves.set(canvasId, task)
  return task
}
