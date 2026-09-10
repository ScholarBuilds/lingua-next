import type { StudioFlowRun } from '@/lib/api-studio'
import type { CascadeState } from './canvasStore'
import { subscribeFlowEvents } from './taskEvents'

export const FLOW_NODE_ACTIVE = new Set(['queued', 'submitting', 'running', 'recovering'])

interface CascadeFlowNodeMeta {
  canvas_node_id: string
  target_node_id: string
  round: number
  label: string
}

export function cascadeRunMetadata(run: StudioFlowRun): {
  nodeMap: Record<string, CascadeFlowNodeMeta>
  roundNodes: Record<string, string[]>
  edgeKeys: string[]
} {
  const context = run.source_context ?? {}
  const nodeMap: Record<string, CascadeFlowNodeMeta> = {}
  const rawMap = context.node_map
  if (typeof rawMap === 'object' && rawMap !== null) {
    for (const [flowNodeId, raw] of Object.entries(rawMap)) {
      if (typeof raw !== 'object' || raw === null) continue
      const value = raw as Record<string, unknown>
      if (typeof value.canvas_node_id !== 'string' || typeof value.target_node_id !== 'string') continue
      nodeMap[flowNodeId] = {
        canvas_node_id: value.canvas_node_id,
        target_node_id: value.target_node_id,
        round: Math.max(1, Number(value.round) || 1),
        label: String(value.label ?? value.canvas_node_id),
      }
    }
  }
  const roundNodes: Record<string, string[]> = {}
  const rawRounds = context.round_nodes
  if (typeof rawRounds === 'object' && rawRounds !== null) {
    for (const [round, raw] of Object.entries(rawRounds)) {
      if (Array.isArray(raw)) roundNodes[round] = raw.filter((id): id is string => typeof id === 'string')
    }
  }
  const edgeKeys = Array.isArray(context.edge_keys)
    ? context.edge_keys.filter((key): key is string => typeof key === 'string')
    : []
  return { nodeMap, roundNodes, edgeKeys }
}

export function cascadeStateFromRun(run: StudioFlowRun): CascadeState {
  const context = run.source_context ?? {}
  const { nodeMap, roundNodes } = cascadeRunMetadata(run)
  const statuses = run.checkpoint.nodes
  const activeRounds: number[] = []
  const roundNumbers = Object.keys(roundNodes).map(Number).filter(Number.isFinite)
  let doneRounds = roundNumbers.length > 0 ? Math.max(0, Math.min(...roundNumbers) - 1) : 0
  for (const [round, ids] of Object.entries(roundNodes)) {
    const values = ids.map((id) => statuses[id]?.status ?? 'pending')
    if (values.some((status) => FLOW_NODE_ACTIVE.has(status))) activeRounds.push(Number(round))
    if (values.length > 0 && values.every((status) => !FLOW_NODE_ACTIVE.has(status) && status !== 'pending')) {
      doneRounds += 1
    }
  }
  const activeId = Object.keys(statuses).find((id) => FLOW_NODE_ACTIVE.has(statuses[id].status))
  const failedId = Object.keys(statuses).find((id) => ['failed', 'cancelled'].includes(statuses[id].status))
  const nextId = Object.keys(statuses).find((id) => statuses[id].status === 'pending')
  const focusId = activeId ?? failedId ?? nextId
  return {
    startId: String(context.start_id ?? ''),
    loopId: typeof context.loop_id === 'string' ? context.loop_id : null,
    mode: context.mode === 'parallel' ? 'parallel' : 'serial',
    total: Math.max(1, Number(context.total) || Object.keys(roundNodes).length || 1),
    doneRounds,
    activeRounds: activeRounds.filter(Number.isFinite).sort((a, b) => a - b),
    nodeLabel: focusId === undefined
      ? '正在收尾'
      : `${FLOW_NODE_ACTIVE.has(statuses[focusId]?.status) ? '正在运行' : '等待运行'}「${nodeMap[focusId]?.label ?? focusId}」`,
    stopRequested: run.status === 'cancelled',
    runId: run.id,
  }
}

export function cascadeRunWaiter(runId: string): { wait: (ms: number) => Promise<void>; dispose: () => void } {
  let wake: (() => void) | null = null
  let pending = false
  const unsubscribe = subscribeFlowEvents((frame) => {
    if (frame.id !== runId) return
    if (wake !== null) wake()
    else pending = true
  })
  return {
    wait: (ms) => new Promise((resolve) => {
      if (pending) {
        pending = false
        resolve()
        return
      }
      const timer = setTimeout(() => {
        wake = null
        resolve()
      }, ms)
      wake = () => {
        clearTimeout(timer)
        wake = null
        resolve()
      }
    }),
    dispose: () => {
      unsubscribe()
      wake?.()
      wake = null
    },
  }
}
