/* L2 域视图（需求 12 FR-242）：一个域的全部面貌。

   信息架构的关键在这一层——进了某个域，三个视图都只关于这个域。
   之前四个页签处在三种语义层级上（跨域/单域/视频专用），切页签会在层级间跳。 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'

import { IconSearch } from '../../components/icons'
import { apiPipeline } from '../../lib/api-pipeline'
import type { DomainAction, SubjectRow } from '../../lib/api-pipeline'
import { RunMatrixView } from './PipelineDomains'
import { SubjectTable } from './SubjectTable'
import { DomainRuns } from './DomainRuns'
import { SavedViews } from './SavedViews'
import { Topbar } from '../../components/Topbar'
import { SeedPicker } from '../vocab/SeedPicker'
import { useActivePipeline } from './ProgressCenter'
import { DomainTodo } from './DomainTodo'
import './pipeline.css'

type View = 'list' | 'matrix' | 'runs'

const VIEWS: Array<{ key: View; label: string }> = [
  { key: 'list', label: '主体列表' },
  { key: 'matrix', label: '运行矩阵' },
  { key: 'runs', label: '运行记录' },
]

/** 记住上次进的域与视图：日常大部分时间只关心一个域，每次重选是纯损耗 */
const LAST_VIEW_KEY = 'ln-pipeline-view'

export function DomainPage() {
  const { domain = 'video' } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const active = useActivePipeline()

  // 带 health 深链进来时强制落主体列表：点"3 个不达标"的意图是看那三个主体，
  // 落在运行记录上筛选条件无处体现。深链意图压过记住的视图偏好。
  const [params, setParams] = useSearchParams()
  const [view, setView] = useState<View>(() =>
    params.get('health')
      ? 'list'
      : ((localStorage.getItem(LAST_VIEW_KEY) as View) || 'list'),
  )
  const [pickerOpen, setPickerOpen] = useState(false)
  const [health, setHealthState] = useState(() => params.get('health') ?? '')
  // 筛选态进 URL：待办条点进来能直接落在对应档位，链接也能分享
  const setHealth = (next: string) => {
    setHealthState(next)
    if (next) params.set('health', next)
    else params.delete('health')
    setParams(params, { replace: true })
  }
  const [keyword, setKeyword] = useState('')
  const [debounced, setDebounced] = useState('')

  useEffect(() => {
    localStorage.setItem(LAST_VIEW_KEY, view)
  }, [view])
  useEffect(() => {
    localStorage.setItem('ln-pipeline-domain', domain)
  }, [domain])
  // 换域时清掉上一个域的筛选：健康档位是域私有的，带过去必然落空
  useEffect(() => {
    setHealthState(params.get('health') ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain])
  useEffect(() => {
    const t = setTimeout(() => setDebounced(keyword.trim()), 240)
    return () => clearTimeout(t)
  }, [keyword])

  const query = useQuery({
    queryKey: ['domain-subjects', domain, health, debounced],
    queryFn: () => apiPipeline.domainSubjects(domain, { health, q: debounced, limit: 200 }),
    // 有任务在跑时保持刷新，跑完自动停
    refetchInterval: active.active > 0 ? 4000 : false,
  })
  const domainsQuery = useQuery({ queryKey: ['pipeline-domains'], queryFn: apiPipeline.domains })

  const spec = query.data?.spec
  const counts = query.data?.health_counts ?? {}

  const runAction = useMutation({
    mutationFn: async (action: DomainAction) => {
      if (action.key === 'autofix_all') return apiPipeline.autofixAll()
      if (action.key === 'verify_all') {
        const ids = (query.data?.items ?? []).map((r) => r.id).slice(0, 20)
        await Promise.all(ids.map((id) => apiPipeline.verify(id, true)))
        return { queued: ids.length }
      }
      // seed_all 不在这里执行：批量生成必须先看清要生成什么（见 openPicker）
      if (action.key === 'seed_all') throw new Error('should open picker')
      if (action.key === 'purge_drafts') {
        const resp = await fetch('/api/scenario-decks/drafts/expired?hours=24', {
          method: 'DELETE',
        })
        return resp.json() as Promise<{ removed: number }>
      }
      throw new Error(`未实现的动作：${action.key}`)
    },
    onSuccess: () => {
      toast.success('已提交')
      void qc.invalidateQueries({ queryKey: ['domain-subjects'] })
      void qc.invalidateQueries({ queryKey: ['pipeline-todo'] })
    },
    onError: (e: Error) => toast.error(e.message || '执行失败'),
  })

  const openSubject = (row: SubjectRow) => {
    if (spec === undefined) return
    navigate(spec.detail_route.replace('{id}', String(row.id)).replace('{domain}', domain))
  }

  const others = useMemo(
    () => (domainsQuery.data ?? []).filter((d) => d.domain !== domain),
    [domainsQuery.data, domain],
  )

  return (
    <div className="main">
      <Topbar
        back={{ to: '/pipeline', label: '管线中心' }}
        crumbs={[{ label: '管线中心', to: '/pipeline' }]}
        title={spec?.label ?? domain}
        meta={
          <span className="dp-meta">
            {query.data?.total ?? 0} 个主体 · {spec?.steps ?? 0} 节点 · 版本 {spec?.version ?? '—'}
          </span>
        }
        actions={
          others.length > 0 ? (
            <div className="seg">
              {[{ domain, label: spec?.label ?? domain }, ...others].map((d) => (
                <button
                  key={d.domain}
                  className={d.domain === domain ? 'active' : undefined}
                  onClick={() => navigate(`/pipeline/${d.domain}`)}
                >
                  {d.label}
                </button>
              ))}
            </div>
          ) : undefined
        }
      />

      <div className="dp-bar">
        <div className="seg">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              className={view === v.key ? 'active' : undefined}
              onClick={() => setView(v.key)}
            >
              {v.label}
            </button>
          ))}
        </div>

        {view === 'list' && spec && (
          <>
            <div className="seg">
              <button className={health === '' ? 'active' : undefined} onClick={() => setHealth('')}>
                全部
              </button>
              {spec.health.map((h) => (
                <button
                  key={h.key}
                  className={health === h.key ? 'active' : undefined}
                  onClick={() => setHealth(h.key)}
                  disabled={(counts[h.key] ?? 0) === 0 && health !== h.key}
                >
                  {h.label}
                  <i className="dp-count">{counts[h.key] ?? 0}</i>
                </button>
              ))}
            </div>
            <div className="dp-search">
              <IconSearch />
              <input
                placeholder="搜索"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
              />
            </div>
          </>
        )}

        {view === 'list' && (
          <SavedViews
            domain={domain}
            current={{ health, q: debounced }}
            onApply={(v) => {
              setHealth(v.health)
              setKeyword(v.q)
            }}
          />
        )}

        <div style={{ flex: 1 }} />

        {spec?.actions.map((a) => (
          <button
            key={a.key}
            className={`btn ${a.tone === 'primary' ? 'btn-primary' : a.tone === 'danger' ? 'btn-danger' : 'btn-soft'}`}
            disabled={runAction.isPending}
            onClick={() => {
              if (a.key === 'seed_all') {
                setPickerOpen(true)
                return
              }
              if (a.confirm && !window.confirm(a.confirm)) return
              runAction.mutate(a)
            }}
          >
            {a.label}
          </button>
        ))}
      </div>

      <div className="dp-body">
        <DomainTodo
          domain={domain}
          onPick={(key) => {
            setView('list')
            setHealth(key)
          }}
        />

        {query.isPending && (
          <div className="state-block">
            <div className="spinner" />
            <div>加载中…</div>
          </div>
        )}
        {query.isError && (
          <div className="state-block">加载失败：{query.error.message}</div>
        )}

        {view === 'list' && spec && query.isSuccess && (
          <SubjectTable
            spec={spec}
            rows={query.data.items}
            onOpen={openSubject}
            emptyHint={health ? '当前筛选下没有主体，换个状态看看' : undefined}
          />
        )}
        {view === 'matrix' && <RunMatrixView domain={domain} />}
        {view === 'runs' && spec && <DomainRuns domain={domain} spec={spec} />}
      </div>

      {pickerOpen && (
        <SeedPicker
          onClose={() => setPickerOpen(false)}
          onStarted={(jobs) => {
            setPickerOpen(false)
            toast.success(`已开始生成 ${jobs.length} 个场景本`)
            void qc.invalidateQueries({ queryKey: ['domain-subjects'] })
          }}
        />
      )}
    </div>
  )
}
