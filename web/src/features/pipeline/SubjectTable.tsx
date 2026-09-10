/* 主体列表（需求 12 FR-240）：列完全由域声明驱动，组件内不出现任何域专有字段名。

   新增文章域时这个文件一行都不用改——这是 BR-35「新增域不改公共组件」的落点。 */

import type { SubjectColumn, SubjectRow, PipelineSpec } from '../../lib/api-pipeline'

const TONE_CLASS: Record<string, string> = {
  ok: 'ok', warn: 'warn', err: 'err', accent: 'accent', muted: '',
}

function healthChip(spec: PipelineSpec, key: string) {
  const bucket = spec.health.find((h) => h.key === key)
  if (bucket === undefined) return <span className="chip">{key}</span>
  return <span className={`chip ${TONE_CLASS[bucket.tone] ?? ''}`}>{bucket.label}</span>
}

/** 按列声明的 kind 渲染单元格；未知 kind 退化为纯文本，不抛错 */
function Cell({
  col,
  row,
  spec,
}: {
  col: SubjectColumn
  row: SubjectRow
  spec: PipelineSpec
}) {
  const value = row[col.key]

  if (col.kind === 'status') return healthChip(spec, row.health)

  if (col.kind === 'ratio') {
    const r = value as { done: number; total: number } | undefined
    if (r === undefined || r.total === 0) return <span className="st-dim">—</span>
    const full = r.done >= r.total
    return (
      <span className={full ? undefined : 'st-warn'}>
        {r.done.toLocaleString()}/{r.total.toLocaleString()}
      </span>
    )
  }

  if (col.kind === 'chips') {
    const n = Number(value ?? 0)
    return n > 0 ? <span className="chip warn">{n} 问题</span> : <span className="st-dim">干净</span>
  }

  if (col.kind === 'run') {
    const run = value as { id: number | null; status: string; at: string | null } | null | undefined
    if (!run) return <span className="st-dim">未跑过</span>
    return (
      <span className="st-run">
        {run.id !== null && `#${run.id}`}
        <i className={`st-dot ${run.status}`} />
        {RUN_TEXT[run.status] ?? run.status}
      </span>
    )
  }

  if (col.kind === 'number') {
    return <span>{Number(value ?? 0).toLocaleString()}</span>
  }

  if (col.kind === 'when') {
    return <span className="st-dim">{value ? String(value).slice(5, 16).replace('T', ' ') : '—'}</span>
  }

  return <span>{value === null || value === undefined ? '—' : String(value)}</span>
}

const RUN_TEXT: Record<string, string> = {
  /** 有产物但无 run 记录：管线改造之前生成的历史数据 */
  legacy: '早期生成',
  success: '成功',
  failed: '失败',
  running: '执行中',
  pending: '排队',
  cancelled: '已取消',
  awaiting_input: '待确认',
}

interface SubjectTableProps {
  spec: PipelineSpec
  rows: SubjectRow[]
  onOpen: (row: SubjectRow) => void
  emptyHint?: string
}

export function SubjectTable({ spec, rows, onOpen, emptyHint }: SubjectTableProps) {
  if (rows.length === 0) {
    return (
      <div className="st-empty">
        <div className="st-empty-title">这里还什么都没有</div>
        <div className="st-empty-hint">{emptyHint || spec.empty_hint}</div>
      </div>
    )
  }
  return (
    <div className="st-wrap">
      <table className="st">
        <thead>
          <tr>
            {spec.columns.map((c) => (
              <th
                key={c.key}
                style={{ width: c.width ?? undefined, textAlign: c.align }}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} onClick={() => onOpen(row)} tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onOpen(row)
              }}
            >
              {spec.columns.map((c) => (
                <td key={c.key} style={{ textAlign: c.align }}
                  className={c.kind === 'text' ? 'st-title' : 'st-num'}
                >
                  <Cell col={c} row={row} spec={spec} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
