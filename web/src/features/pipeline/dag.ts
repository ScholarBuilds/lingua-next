/* 管线 DAG 布局：节点目录 + 运行记录 → React Flow 的 nodes/edges（FR-71）。

   布局交给 dagre 自动算——十三个节点里 enrich 四步是并行分叉，手写坐标一改需求就废。 */

import dagre from 'dagre'
import { Position } from '@xyflow/react'
import type { Edge, Node } from '@xyflow/react'

import type { PipelineStepV1, StepHistoryEntry, StepSpec, StepStatus } from '../../lib/api-pipeline'

export const NODE_W = 164
// 节点压到 46px：十三节点竖排共 9 个 rank，再高就超出视口要滚动
export const NODE_H = 46

export interface StepNodeData extends Record<string, unknown> {
  label: string
  name: string
  group: string
  status: StepStatus | 'idle'
  duration_ms: number | null
  stale: boolean
  summary: string
  /** 本次未执行时，该节点最近一次真实执行（FR-135）；执行过则为 null */
  lastExec: StepHistoryEntry | null
  /** 执行中节点的真实进度百分比（FR-148）；无细粒度上报时为 null */
  livePct: number | null
}

/** 执行中节点的真实进度（FR-148）：整体进度落在本节点区间内才算数。
    区间零宽的节点（标点/对齐等瞬时步）没有细粒度上报，返回 null 交给不确定态。 */
function livePercent(
  spec: StepSpec,
  status: StepStatus | 'idle',
  videoProgress: number,
): number | null {
  if (status !== 'running') return null
  const span = spec.progress_span
  if (!span || span[1] <= span[0] || videoProgress < span[0]) return null
  return Math.min(100, ((videoProgress - span[0]) / (span[1] - span[0])) * 100)
}

/** metrics 里挑一两个最能说明问题的量，直接印在节点上 */
function summarize(step: PipelineStepV1 | undefined): string {
  if (step === undefined) return ''
  const m = step.metrics
  const pick = (key: string, suffix = ''): string | null =>
    m[key] === undefined || m[key] === null ? null : `${String(m[key])}${suffix}`
  const parts = [
    pick('cues', ' cue'),
    pick('sentences', ' 句'),
    pick('units', ' 学习句'),
    pick('translated', ' 已译'),
    pick('engine'),
    pick('retimed_cues', ' 重定时'),
    pick('passed') !== null ? `标点 ${String(m.passed)}/${String(m.chunks ?? '?')}` : null,
    pick('file_mb', 'MB'),
    pick('gate'),
    pick('issues', ' 问题'),
  ].filter((v): v is string => v !== null)
  return parts.slice(0, 2).join(' · ')
}

export function buildGraph(
  catalog: StepSpec[],
  steps: PipelineStepV1[],
  history: Record<string, StepHistoryEntry[]> = {},
  videoProgress = 0,
  /** 节点产物摘要（FR-217）：由后端提供，前端不再硬编码视频专有字段名 */
  artifactSummary: Record<string, string> = {},
): { nodes: Node<StepNodeData>[]; edges: Edge[] } {
  const byName = new Map(steps.map((s) => [s.name, s]))

  const rawNodes: Node<StepNodeData>[] = catalog.map((spec) => {
    const step = byName.get(spec.name)
    const status = step?.status ?? 'idle'
    // 本次没执行（skipped/idle）就翻它的执行史，拿最近一次真实跑过的记录
    const lastExec =
      status === 'skipped' || status === 'idle'
        ? ((history[spec.name] ?? []).find(
            (h) => h.status === 'success' || h.status === 'failed',
          ) ?? null)
        : null
    return {
      id: spec.name,
      type: 'stepNode',
      position: { x: 0, y: 0 },
      data: {
        label: spec.label,
        name: spec.name,
        group: spec.group,
        status,
        duration_ms: step?.duration_ms ?? null,
        stale: step?.stale ?? false,
        summary: artifactSummary[spec.name] ?? summarize(step),
        lastExec,
        livePct: livePercent(spec, status, videoProgress),
      },
    }
  })

  const edges: Edge[] = catalog.flatMap((spec) =>
    spec.depends_on.map((from) => {
      const upstream = byName.get(from)
      return {
        id: `${from}->${spec.name}`,
        source: from,
        target: spec.name,
        // 走过的边高亮，一眼看出这次实际跑了哪条路径
        className: upstream?.status === 'success' ? 'dag-edge done' : 'dag-edge',
        animated: byName.get(spec.name)?.status === 'running',
      }
    }),
  )

  return { nodes: layout(rawNodes, edges), edges }
}

function layout(nodes: Node<StepNodeData>[], edges: Edge[]): Node<StepNodeData>[] {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  // 竖排：链路主体是长链 + enrich 四步的一次横向分叉，TB 比 LR 更贴合这个形状
  g.setGraph({ rankdir: 'TB', nodesep: 14, ranksep: 30, marginx: 10, marginy: 10 })
  nodes.forEach((n) => g.setNode(n.id, { width: NODE_W, height: NODE_H }))
  edges.forEach((e) => g.setEdge(e.source, e.target))
  dagre.layout(g)
  return nodes.map((n) => {
    const pos = g.node(n.id) as { x: number; y: number } | undefined
    return {
      ...n,
      position: pos
        ? { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 }
        : { x: 0, y: 0 },
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
    }
  })
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  return `${m}m${Math.round((ms % 60_000) / 1000)}s`
}
