/* 管线总览（需求 12 FR-214、FR-241）：我该处理什么 + 各条管线健康吗。

   原来是独立的「管线中心」页；CR-006 D4 把它并进任务中心，成为任务页里
   按域的一个视图。域页（/pipeline/:domain）与主体下钻页原样保留。 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

import { IconSparkle } from '../../components/icons'
import { apiPipeline } from '../../lib/api-pipeline'
import type { DomainOverview, TodoItem } from '../../lib/api-pipeline'
import { useActivePipeline } from './ProgressCenter'
import './pipeline.css'

const TONE_CLASS: Record<string, string> = {
  ok: 'ok', warn: 'warn', err: 'err', accent: 'accent', muted: '',
}

/** 健康条的配色顺序：好的在左，要处理的在右，扫一眼就知道比例 */
const TONE_COLOR: Record<string, string> = {
  ok: 'var(--ok)',
  accent: 'var(--accent)',
  warn: 'var(--warn)',
  err: 'var(--err)',
  muted: 'var(--border-strong)',
}

export function PipelineOverview() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const active = useActivePipeline()

  const domains = useQuery({ queryKey: ['pipeline-domains'], queryFn: apiPipeline.domains })
  const todo = useQuery({
    queryKey: ['pipeline-todo'],
    queryFn: apiPipeline.todo,
    refetchInterval: active.active > 0 ? 5000 : false,
  })

  const fixAll = useMutation({
    mutationFn: () => apiPipeline.autofixAll(),
    onSuccess: (r) => {
      toast.success(`已处理 ${r.videos ?? 0} 条`)
      void qc.invalidateQueries({ queryKey: ['pipeline-todo'] })
      void qc.invalidateQueries({ queryKey: ['pipeline-domains'] })
    },
    onError: (e: Error) => toast.error(e.message || '修复失败'),
  })

  const list = domains.data ?? []
  const hasAny = list.some((d) => d.subjects > 0)

  return (
    <div className="pc-body pc-embedded">
      {todo.data && todo.data.items.length > 0 && (
        <TodoBar
          items={todo.data.items}
          total={todo.data.total}
          pending={fixAll.isPending}
          onFixAll={() => fixAll.mutate()}
          onPick={(item) => navigate(`/pipeline/${item.domain}?health=${item.key}`)}
        />
      )}

      {domains.isPending && (
        <div className="state-block"><div className="spinner" /><div>加载管线…</div></div>
      )}
      {domains.isError && (
        <div className="state-block">总览加载失败：{domains.error.message}</div>
      )}

      {domains.isSuccess && !hasAny && (
        <div className="pc-empty">
          <IconSparkle />
          <div className="pc-empty-title">还没有任何管线跑过</div>
          <div className="pc-empty-hint">
            管线负责把原始素材加工成可学的内容。先去导入一个视频，或用一句话生成场景本。
          </div>
          <div className="pc-empty-actions">
            <button className="btn btn-primary" onClick={() => navigate('/video')}>
              导入视频
            </button>
            <button className="btn btn-soft" onClick={() => navigate('/vocab')}>
              生成场景本
            </button>
          </div>
        </div>
      )}

      {domains.isSuccess && hasAny && (
        <div className="pc-grid">
          {list.map((d) => (
            <DomainCard key={d.domain} stat={d} onOpen={() => navigate(`/pipeline/${d.domain}`)} />
          ))}
        </div>
      )}
    </div>
  )
}

function TodoBar({
  items,
  total,
  pending,
  onFixAll,
  onPick,
}: {
  items: TodoItem[]
  total: number
  pending: boolean
  onFixAll: () => void
  onPick: (item: TodoItem) => void
}) {
  const fixable = items.some((i) => i.kind === 'issues')
  return (
    <div className="pc-todo">
      <div className="pc-todo-n">
        <b>{total}</b>
        <span>件待处理</span>
      </div>
      <div className="pc-todo-items">
        {items.map((i) => (
          <button key={`${i.domain}-${i.key}`} className="pc-pill" onClick={() => onPick(i)}>
            <i className={`pc-dot ${TONE_CLASS[i.tone] ?? ''}`} />
            {i.label} <em>{i.count}</em>
          </button>
        ))}
      </div>
      {fixable && (
        <button className={`btn btn-primary${pending ? ' loading' : ''}`} disabled={pending} onClick={onFixAll}>
          {pending && <span className="spinner" />}
          一键修复全部
        </button>
      )}
    </div>
  )
}

function DomainCard({ stat, onOpen }: { stat: DomainOverview; onOpen: () => void }) {
  const total = Math.max(stat.subjects, 1)
  const segments = stat.health
    .map((h) => ({ ...h, n: stat.health_counts[h.key] ?? 0 }))
    .filter((h) => h.n > 0)
  const idle = stat.subjects === 0

  return (
    <button className={`pc-card${idle ? ' idle' : ''}`} onClick={onOpen} disabled={idle}>
      <div className="pc-card-head">
        <b>{stat.label}</b>
        <span className="pc-key">{stat.domain}</span>
      </div>
      <div className="pc-card-main">
        <span className="pc-big">{idle ? '—' : stat.subjects.toLocaleString()}</span>
        <span className="pc-unit">{idle ? '尚未接入' : `个主体 · ${stat.steps} 节点`}</span>
      </div>
      <div className="pc-health">
        {segments.map((h) => (
          <i
            key={h.key}
            style={{ width: `${(h.n / total) * 100}%`, background: TONE_COLOR[h.tone] }}
            title={`${h.label} ${h.n}`}
          />
        ))}
      </div>
      <div className="pc-card-foot">
        {segments.map((h) => (
          <span key={h.key} className={`chip ${TONE_CLASS[h.tone] ?? ''}`}>
            {h.n} {h.label}
          </span>
        ))}
        {stat.issues > 0 && <span className="chip warn">{stat.issues} 问题</span>}
        {idle && <span className="chip">注册表已预留</span>}
      </div>
      <div className="pc-when">
        {stat.last_run
          ? `最近运行 #${stat.last_run.id} · ${stat.last_run.at?.slice(5, 16).replace('T', ' ') ?? ''}`
          : stat.empty_hint}
      </div>
    </button>
  )
}
