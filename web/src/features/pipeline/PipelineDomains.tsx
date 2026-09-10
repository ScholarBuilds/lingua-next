/* 管线中心顶层视图（需求 12 FR-214、FR-215、FR-218）：跨域总览 + 运行矩阵。

   矩阵形态取自 Airflow Grid View：行是节点、列是历次运行，一眼看出哪个节点
   反复失败——这是原先"只有运行列表"完全表达不了的一层。 */

import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { apiPipeline } from '../../lib/api-pipeline'
import { formatDuration } from './dag'

const CELL_TEXT: Record<string, string> = {
  success: '成功',
  failed: '失败',
  skipped: '跳过',
  running: '执行中',
  pending: '等待',
}

export function RunMatrixView({ domain }: { domain: string }) {
  const [limit, setLimit] = useState(12)
  const query = useQuery({
    queryKey: ['pipeline-matrix', domain, limit],
    queryFn: () => apiPipeline.matrix(domain, limit),
  })
  const data = query.data

  if (query.isPending) return <div className="state-block"><div className="spinner" /></div>
  if (query.isError) return <div className="state-block">矩阵加载失败：{query.error.message}</div>
  if (data === undefined || data.runs.length === 0) {
    return <div className="state-block">该域还没有运行记录</div>
  }

  const worst = Math.max(...data.steps.map((s) => s.failures), 0)

  return (
    <div className="pm-wrap">
      <div className="pm-head">
        <b>{data.label} · 运行矩阵</b>
        <span className="pm-hint">行=节点，列=运行（左旧右新）</span>
        <div style={{ flex: 1 }} />
        <div className="seg">
          {[12, 24, 40].map((n) => (
            <button key={n} className={limit === n ? 'active' : undefined} onClick={() => setLimit(n)}>
              近 {n}
            </button>
          ))}
        </div>
      </div>

      <div className="pm-scroll">
        <table className="pm-table">
          <thead>
            <tr>
              <th className="pm-step-col">节点</th>
              {data.runs.map((r) => (
                <th key={r.id} title={`#${r.id} ${r.kind} · 主体 ${r.subject_id}`}>
                  {r.id}
                </th>
              ))}
              <th className="pm-fail-col">失败</th>
            </tr>
          </thead>
          <tbody>
            {data.steps.map((step) => (
              <tr key={step.name}>
                <td className="pm-step-col" title={step.name}>
                  {step.label}
                </td>
                {data.runs.map((run) => {
                  const cell = data.cells[step.name]?.[String(run.id)]
                  const status = cell?.status ?? 'none'
                  return (
                    <td key={run.id}>
                      <span
                        className={`pm-cell ${status}`}
                        title={
                          cell
                            ? `${CELL_TEXT[cell.status] ?? cell.status}${
                                cell.duration_ms ? ` · ${formatDuration(cell.duration_ms)}` : ''
                              }${cell.error ? `\n${cell.error}` : ''}`
                            : '本次运行未包含该节点'
                        }
                      />
                    </td>
                  )
                })}
                <td className="pm-fail-col">
                  {step.failures > 0 && (
                    <span className={`pm-fail${step.failures === worst && worst > 0 ? ' worst' : ''}`}>
                      {step.failures}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="pm-legend">
        {(['success', 'failed', 'skipped', 'running'] as const).map((s) => (
          <span key={s}>
            <i className={`pm-cell ${s}`} />
            {CELL_TEXT[s]}
          </span>
        ))}
        <span>
          <i className="pm-cell none" />
          未包含
        </span>
      </div>
    </div>
  )
}
