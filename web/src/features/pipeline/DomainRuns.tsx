/* 域内运行记录（需求 12 FR-243）：筛选器的运行类型由域声明，不写死视频那三种。

   这一层的信息基本被运行矩阵覆盖，保留是因为「查某次运行的耗时与触发方式」
   还只有它能回答，所以降级为域内第三个视图，不再占顶层。 */

import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { apiPipeline } from '../../lib/api-pipeline'
import type { PipelineSpec } from '../../lib/api-pipeline'
import { formatDuration } from './dag'

const STATUS_FILTERS = [
  { key: '', label: '全部' },
  { key: 'running', label: '进行中' },
  { key: 'success', label: '成功' },
  { key: 'failed', label: '失败' },
  { key: 'awaiting_input', label: '待确认' },
]

const STATUS_TEXT: Record<string, string> = {
  success: '成功',
  failed: '失败',
  running: '执行中',
  pending: '排队',
  cancelled: '已取消',
  awaiting_input: '待确认',
}
const STATUS_TONE: Record<string, string> = {
  success: 'ok', failed: 'err', running: 'accent',
  awaiting_input: 'accent', cancelled: '',
}

export function DomainRuns({ domain, spec }: { domain: string; spec: PipelineSpec }) {
  const [status, setStatus] = useState('')
  const [kind, setKind] = useState('')
  const [page, setPage] = useState(0)
  const size = 20

  const query = useQuery({
    queryKey: ['domain-runs', domain, status, kind, page],
    queryFn: () =>
      apiPipeline.runs({
        domain,
        ...(status ? { status } : {}),
        ...(kind ? { kind } : {}),
        offset: page * size,
        limit: size,
      }),
    placeholderData: (prev) => prev,
  })

  const pages = Math.max(1, Math.ceil((query.data?.total ?? 0) / size))

  return (
    <div className="dr-wrap">
      <div className="dr-filters">
        <div className="seg">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              className={status === f.key ? 'active' : undefined}
              onClick={() => {
                setStatus(f.key)
                setPage(0)
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
        {/* 运行类型由域声明：视频是入库/AI加工/AI修复，场景本是生成/重跑 */}
        {spec.run_kinds.length > 0 && (
          <div className="seg">
            <button className={kind === '' ? 'active' : undefined} onClick={() => setKind('')}>
              全部类型
            </button>
            {spec.run_kinds.map((k) => (
              <button
                key={k.key}
                className={kind === k.key ? 'active' : undefined}
                onClick={() => {
                  setKind(k.key)
                  setPage(0)
                }}
              >
                {k.label}
              </button>
            ))}
          </div>
        )}
        <div style={{ flex: 1 }} />
        <span className="dr-page">
          <button className="btn-ghost-sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            上一页
          </button>
          {page + 1} / {pages}
          <button
            className="btn-ghost-sm"
            disabled={page + 1 >= pages}
            onClick={() => setPage((p) => p + 1)}
          >
            下一页
          </button>
        </span>
      </div>

      {query.isPending && <div className="state-block"><div className="spinner" /></div>}
      {query.isSuccess && query.data.items.length === 0 && (
        <div className="st-empty"><div className="st-empty-title">没有匹配的运行记录</div></div>
      )}

      {query.isSuccess && query.data.items.length > 0 && (
        <div className="st-wrap">
          <table className="st">
            <thead>
              <tr>
                <th style={{ width: 64 }}>Run</th>
                <th>{spec.columns[0]?.label ?? '主体'}</th>
                <th style={{ width: 80 }}>类型</th>
                <th style={{ width: 80 }}>触发</th>
                <th style={{ width: 150 }}>起点 / 范围</th>
                <th style={{ width: 92 }}>状态</th>
                <th style={{ width: 80, textAlign: 'right' }}>耗时</th>
                <th style={{ width: 96 }}>开始于</th>
              </tr>
            </thead>
            <tbody>
              {query.data.items.map((r) => (
                <tr key={r.id}>
                  <td className="st-num">#{r.id}</td>
                  <td className="st-title">{r.video_title ?? `#${r.id}`}</td>
                  <td className="st-num">
                    {spec.run_kinds.find((k) => k.key === r.kind)?.label ?? r.kind}
                  </td>
                  <td className="st-num">{r.trigger === 'user' ? '手动' : r.trigger}</td>
                  <td className="st-num">
                    {r.from_step ? `${r.from_step} · ${r.scope === 'single' ? '仅此节点' : '及下游'}` : '全量'}
                  </td>
                  <td>
                    <span className={`chip ${STATUS_TONE[r.status] ?? ''}`}>
                      {STATUS_TEXT[r.status] ?? r.status}
                    </span>
                  </td>
                  <td className="st-num" style={{ textAlign: 'right' }}>
                    {formatDuration(r.duration_ms ?? null)}
                  </td>
                  <td className="st-num">
                    {r.started_at ? r.started_at.slice(5, 16).replace('T', ' ') : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
