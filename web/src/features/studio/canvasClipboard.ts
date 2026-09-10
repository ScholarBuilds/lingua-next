import type { CanvasConnection } from '@/lib/api-studio'
import type { ScvNode } from './canvasStore'

export interface Clip {
  nodes: ScvNode[]
  connections: CanvasConnection[]
}

/** 断开选区外的成员与归档引用，避免副本引用原分组。 */
export function cloneBatch(clip: Clip, dx: number, dy: number, nextId: () => string): Clip {
  const idMap = new Map(clip.nodes.map((n) => [n.id, nextId()]))
  const nodes = clip.nodes.map((n) => {
    const born: ScvNode = { ...structuredClone(n), id: idMap.get(n.id) as string, x: n.x + dx, y: n.y + dy }
    if (born.member_ids !== undefined) {
      born.member_ids = born.member_ids
        .map((m) => idMap.get(m))
        .filter((m): m is string => m !== undefined)
    }
    if (born.history_for !== undefined) born.history_for = idMap.get(born.history_for)
    return born
  })
  return {
    nodes,
    connections: clip.connections.map((c) => ({
      ...c,
      from: idMap.get(c.from) as string,
      to: idMap.get(c.to) as string,
    })),
  }
}
