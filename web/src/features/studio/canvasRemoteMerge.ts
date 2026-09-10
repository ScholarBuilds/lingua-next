import type { CanvasItem, CanvasConnection, CanvasDetail } from '@/lib/api-studio'
import type { ScvNode } from './canvasStore'
import { isEdgeBuried, isNodeBuried } from './canvas-tombstones'
import type { TombstoneStore } from './canvas-tombstones'

export function connKey(c: CanvasConnection): string {
  return `${c.from}→${c.to}→${c.kind ?? 'flow'}`
}

export function buriedSince(
  log: Record<string, number> | undefined,
  baseVersion: number,
): string[] {
  if (log === undefined) return []
  return Object.entries(log)
    .filter(([, v]) => typeof v === 'number' && v > baseVersion)
    .map(([id]) => id)
}

export function mergeItems(a: CanvasItem[] = [], b: CanvasItem[] = []): CanvasItem[] {
  const out: CanvasItem[] = []
  const seen = new Set<string>()
  for (const it of [...a, ...b]) {
    const key =
      it.asset_id !== undefined
        ? `a${it.asset_id}`
        : it.media_asset_id !== undefined
          ? `m${it.media_asset_id}`
          : `u${it.url ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(it)
  }
  return out
}

export function mergeCanvasDocs(
  local: { nodes: ScvNode[]; connections: CanvasConnection[] },
  remote: CanvasDetail,
  runningIds: Set<string>,
  buried: TombstoneStore,
): { nodes: ScvNode[]; connections: CanvasConnection[] } {
  const remoteById = new Map(remote.nodes.map((n) => [n.id, n]))
  const nodes: ScvNode[] = []
  const seen = new Set<string>()
  const buriedNow = Date.now()
  for (const ln of local.nodes) {
    seen.add(ln.id)
    const rn = remoteById.get(ln.id)
    if (rn === undefined && !runningIds.has(ln.id) && isNodeBuried(buried, ln.id, buriedNow)) {
      continue
    }
    if (rn === undefined || runningIds.has(ln.id)) {
      nodes.push(ln)
      continue
    }
    nodes.push({ ...rn, ...ln, items: mergeItems(ln.items, rn.items) })
  }
  const now = Date.now()
  for (const rn of remote.nodes) {
    if (seen.has(rn.id)) continue
    if (isNodeBuried(buried, rn.id, now)) continue
    nodes.push(rn)
  }

  const byKey = new Map<string, CanvasConnection>()
  for (const c of [...local.connections, ...remote.connections]) {
    const key = connKey(c)
    if (isEdgeBuried(buried, key, now)) continue
    if (!byKey.has(key)) byKey.set(key, c)
  }
  const alive = new Set(nodes.map((n) => n.id))
  return {
    nodes,
    connections: [...byKey.values()].filter((c) => alive.has(c.from) && alive.has(c.to)),
  }
}
