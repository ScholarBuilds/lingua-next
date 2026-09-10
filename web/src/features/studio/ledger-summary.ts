/* 账本顶部那行汇总的纯计算：把已加载的调用行折成成功率、P95 时延与调用量分布。

   口径都按「已加载的这批行」算，不额外请求聚合接口——账本本来就是分页 + SSE 的滚动窗口，
   再要一份服务端全量统计会和眼前这张表对不上号，比没有更误导。 */

import type { ModelInvocation } from '@/lib/api-config'

/** 终态：进行中的行不进成功率分母，否则每开一次新调用成功率都要掉一下 */
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'abandoned'])

export interface LedgerTally {
  key: string
  count: number
}

export interface LedgerSummary {
  /** 参与统计的行数 = 当前已加载的行数 */
  total: number
  running: number
  succeeded: number
  failed: number
  /** 终态里成功的占比（0-1）。一条终态都没有时为 null，不拿 0/0 当 0% */
  successRate: number | null
  p95FirstTokenMs: number | null
  p95LatencyMs: number | null
  byCapability: LedgerTally[]
  byModel: LedgerTally[]
}

/** 最近秩法：取第 ceil(fraction × n) 个（1 基）。小样本也总落在真实观测值上，不做插值。 */
export function percentile(values: number[], fraction: number): number | null {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(fraction * sorted.length)))
  return sorted[rank - 1] ?? null
}

function tally(values: (string | null | undefined)[], limit: number): LedgerTally[] {
  const counts = new Map<string, number>()
  for (const value of values) {
    if (typeof value !== 'string' || value === '') continue
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    // 同量按名字排，免得两次渲染顺序乱跳
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.key < b.key ? -1 : 1))
    .slice(0, limit)
}

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function summarizeInvocations(rows: ModelInvocation[], limit = 4): LedgerSummary {
  let running = 0
  let succeeded = 0
  let failed = 0
  let terminal = 0
  const firstTokens: number[] = []
  const latencies: number[] = []
  for (const row of rows) {
    if (row.status === 'running') running += 1
    if (TERMINAL.has(row.status)) terminal += 1
    if (row.status === 'succeeded') succeeded += 1
    if (row.status === 'failed') failed += 1
    const firstToken = finite(row.first_token_ms)
    if (firstToken !== null) firstTokens.push(firstToken)
    const latency = finite(row.latency_ms)
    if (latency !== null) latencies.push(latency)
  }
  return {
    total: rows.length,
    running,
    succeeded,
    failed,
    successRate: terminal === 0 ? null : succeeded / terminal,
    p95FirstTokenMs: percentile(firstTokens, 0.95),
    p95LatencyMs: percentile(latencies, 0.95),
    byCapability: tally(
      rows.map((row) => row.capability ?? row.operation),
      limit,
    ),
    byModel: tally(
      rows.map((row) => row.model),
      limit,
    ),
  }
}

/** 成功率的显示口径：没有终态行时照实留横杠 */
export function formatRate(rate: number | null): string {
  if (rate === null) return '—'
  return `${Math.round(rate * 100)}%`
}
