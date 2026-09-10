/* 扩展与例程（模块 22）：一张表列每个扩展贡献了什么、状态、缺的权限；例程一栏管时间表与开关 */

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'

import { Topbar } from '../../components/Topbar'
import { speakAssistant } from '../../lib/audio'
import { ApiError } from '../../lib/api'
import { apiExtensions } from '../../lib/api-extensions'
import type { ExtensionRow, ExtensionStatus, PermissionKey, RoutineRow } from '../../lib/api-extensions'
import './extensions.css'
import { useUrlValue } from '@/lib/urlState'

const KIND_LABEL: Record<ExtensionRow['kind'], string> = {
  builtin: '内置模块',
  local: '本地扩展',
  mcp: 'MCP 服务器',
  routine: '例程',
}

const STATUS_LABEL: Record<ExtensionStatus, string> = {
  ready: '就绪',
  disabled: '已停用',
  needs_permission: '缺权限',
  invalid: '清单有错',
}

function statusChip(status: ExtensionStatus): string {
  if (status === 'ready') return 'chip ok'
  if (status === 'needs_permission') return 'chip warn'
  return 'chip'
}

function when(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

type Tab = 'extensions' | 'routines'

export function ExtensionsPage() {
  const [params, setParams] = useSearchParams()
  const tab: Tab = params.get('tab') === 'routines' ? 'routines' : 'extensions'
  const setTab = (t: Tab) => setParams(t === 'extensions' ? {} : { tab: t }, { replace: true })
  return (
    <div className="main">
      <Topbar
        title="扩展"
        meta={
          <div className="ext-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'extensions'} className={tab === 'extensions' ? 'on' : ''} onClick={() => setTab('extensions')}>扩展</button>
            <button role="tab" aria-selected={tab === 'routines'} className={tab === 'routines' ? 'on' : ''} onClick={() => setTab('routines')}>例程</button>
          </div>
        }
      />
      <div className="page-body">
        <div className="ext-inner">{tab === 'extensions' ? <ExtensionsTab /> : <RoutinesTab />}</div>
      </div>
    </div>
  )
}

function ExtensionsTab() {
  const qc = useQueryClient()
  const catalog = useQuery({ queryKey: ['extensions'], queryFn: apiExtensions.list })
  const [filter, setFilter] = useUrlValue<'all' | ExtensionRow['kind'] | 'attn'>('filter', 'all', ['all', 'builtin', 'local', 'mcp', 'routine', 'attn'])
  const [testResult, setTestResult] = useState<Record<string, string>>({})
  const refresh = () => void qc.invalidateQueries({ queryKey: ['extensions'] })
  const rescan = useMutation({ mutationFn: apiExtensions.rescan, onSuccess: refresh })
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { enabled?: boolean; granted?: PermissionKey[] } }) => apiExtensions.patch(id, body),
    onSuccess: () => {
      refresh()
      void qc.invalidateQueries({ queryKey: ['routines'] })
    },
  })
  const test = useMutation({
    mutationFn: (id: string) => apiExtensions.test(id),
    onSuccess: (res, id) => {
      setTestResult((m) => ({
        ...m,
        [id]: res.ok ? (res.tools ? `连上了，${res.tools.length} 个工具：${res.tools.slice(0, 6).join('、')}` : res.note ?? '正常') : res.error ?? '没连上',
      }))
    },
  })

  const items = catalog.data?.items ?? []
  const points = catalog.data?.points ?? []
  const permLabel = new Map((catalog.data?.permissions ?? []).map((p) => [p.key, p.label]))
  const attn = items.filter((i) => i.status === 'needs_permission' || i.status === 'invalid')
  const shown = items.filter((i) => (filter === 'all' ? true : filter === 'attn' ? attn.includes(i) : i.kind === filter))
  const counts = {
    builtin: items.filter((i) => i.kind === 'builtin').length,
    local: items.filter((i) => i.kind === 'local').length,
    mcp: items.filter((i) => i.kind === 'mcp').length,
    routine: items.filter((i) => i.kind === 'routine').length,
  }

  return (
    <>
      <div className="ext-head">
        <div className="seg">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部 {items.length}</button>
          <button className={filter === 'builtin' ? 'active' : ''} onClick={() => setFilter('builtin')}>内置模块 {counts.builtin}</button>
          <button className={filter === 'local' ? 'active' : ''} onClick={() => setFilter('local')}>本地 {counts.local}</button>
          <button className={filter === 'mcp' ? 'active' : ''} onClick={() => setFilter('mcp')}>MCP {counts.mcp}</button>
          <button className={filter === 'routine' ? 'active' : ''} onClick={() => setFilter('routine')}>例程 {counts.routine}</button>
          {attn.length > 0 && (
            <button className={filter === 'attn' ? 'active' : ''} onClick={() => setFilter('attn')}>需要处理 {attn.length}</button>
          )}
        </div>
        <button className="btn btn-outline" disabled={rescan.isPending} onClick={() => rescan.mutate()}>
          {rescan.isPending ? '扫描中' : '重新扫描'}
        </button>
      </div>

      <div className="card ext-table-card">
        <table className="ext-tbl">
          <thead>
            <tr><th>扩展</th><th>类型</th><th>贡献了什么</th><th>权限</th><th>状态</th><th></th></tr>
          </thead>
          <tbody>
            {shown.map((x) => (
              <tr key={x.id} className={x.status === 'disabled' ? 'off' : ''}>
                <td className="name">
                  <b>{x.name}</b>
                  <small>{x.description || (x.source === 'builtin' ? '' : x.source.replace(/^.*\/data\/extensions\//, 'data/extensions/'))}</small>
                  {x.error && <small className="err">{x.error}</small>}
                </td>
                <td className="kind">{KIND_LABEL[x.kind]}<small className="mono">v{x.version}</small></td>
                <td>
                  <div className="chips">
                    {points.filter((p) => (x.contributions[p.key] ?? 0) > 0).map((p) => (
                      <span key={p.key} className="chip" title={p.key === 'tools' ? x.tools.join('、') : undefined}>
                        {p.label} {x.contributions[p.key]}
                      </span>
                    ))}
                    {x.mcp && <span className="chip mono">{x.mcp.transport} · {x.mcp.target}</span>}
                  </div>
                </td>
                <td>
                  <div className="chips">
                    {x.permissions.map((p) => {
                      const granted = x.source === 'builtin' || x.granted.includes(p)
                      return x.source === 'builtin' ? (
                        <span key={p} className="chip">{permLabel.get(p) ?? p}</span>
                      ) : (
                        <button
                          key={p}
                          className={`chip${granted ? ' ok' : ' warn'}`}
                          title={granted ? '点一下收回' : '点一下授予'}
                          disabled={patch.isPending}
                          onClick={() =>
                            patch.mutate({
                              id: x.id,
                              body: { granted: granted ? x.granted.filter((g) => g !== p) : [...x.granted, p] },
                            })
                          }
                        >
                          {permLabel.get(p) ?? p}{granted ? '' : ' · 未授'}
                        </button>
                      )
                    })}
                  </div>
                </td>
                <td><span className={statusChip(x.status)}>{STATUS_LABEL[x.status]}</span></td>
                <td className="actions">
                  {x.status !== 'invalid' && (
                    <button className="btn-ghost-sm" disabled={patch.isPending} onClick={() => patch.mutate({ id: x.id, body: { enabled: !x.enabled } })}>
                      {x.enabled ? '停用' : '启用'}
                    </button>
                  )}
                  {x.mcp && x.status === 'ready' && (
                    <button className="btn-ghost-sm" disabled={test.isPending} onClick={() => test.mutate(x.id)}>测试</button>
                  )}
                  {testResult[x.id] && <small className="ext-test">{testResult[x.id]}</small>}
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr><td colSpan={6} className="ext-empty">{catalog.isLoading ? '加载中' : '没有这一类'}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="ext-add">
        <div className="card ext-how">
          <b>加一个本地扩展</b>
          <p>在 <code>{catalog.data?.dir ?? 'data/extensions'}</code> 下建一个目录，放一份 <code>manifest.yaml</code>，点「重新扫描」。示例在 <code>example/</code>，默认关着。</p>
          <p>它能贡献：{points.map((p) => p.label).join('、')}。要的权限在表里点一下授予；缺权限的扩展不会就绪。</p>
        </div>
        <div className="card ext-how">
          <b>接一个 MCP 服务器</b>
          <p>manifest 里写 <code>mcp:</code>（stdio 命令或 http 地址），启用后它的工具立刻进助理，工具名带扩展 id 前缀。点「测试」连一次看有几个工具。</p>
        </div>
        <div className="card ext-how">
          <b>定一个例程</b>
          <p>manifest 里写 <code>routines:</code>：一句交给助理的话 + 时间表（<code>HH:MM</code> 或五段 cron）。产出在「例程」栏，可念出来；早报也是一条例程。</p>
        </div>
      </div>
      {patch.isError && <p className="ext-err">{patch.error instanceof ApiError ? patch.error.message : '没改成'}</p>}
    </>
  )
}

function RoutinesTab() {
  const qc = useQueryClient()
  const routines = useQuery({ queryKey: ['routines'], queryFn: apiExtensions.routines, refetchInterval: 30_000 })
  const [editing, setEditing] = useState<Record<string, string>>({})
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['routines'] })
    void qc.invalidateQueries({ queryKey: ['assistant-routines'] })
    void qc.invalidateQueries({ queryKey: ['home'] })
  }
  const patch = useMutation({
    mutationFn: ({ key, body }: { key: string; body: { enabled?: boolean; schedule?: string; speak?: boolean } }) => apiExtensions.patchRoutine(key, body),
    onSuccess: refresh,
  })
  const run = useMutation({ mutationFn: (key: string) => apiExtensions.runRoutine(key), onSuccess: refresh })
  const rows: RoutineRow[] = routines.data ?? []
  const err = patch.error ?? run.error

  return (
    <>
      <div className="ext-routines">
        {rows.map((r) => (
          <div key={r.key} className={`card ext-routine${r.enabled ? '' : ' off'}`}>
            <div className="ext-routine-head">
              <b>{r.label}</b>
              <span className="chip">{r.kind === 'brief' ? '早报' : '交给助理'}</span>
              <span className="chip mono">{r.source === 'builtin' ? '内置' : r.source}</span>
              {r.last_status === 'failed' && <span className="chip warn">上次失败</span>}
              <div className="right">
                <button className="btn-ghost-sm" disabled={run.isPending} onClick={() => run.mutate(r.key)}>{run.isPending && run.variables === r.key ? '跑着' : '现在跑'}</button>
                <button className="btn-ghost-sm" onClick={() => patch.mutate({ key: r.key, body: { enabled: !r.enabled } })}>{r.enabled ? '停用' : '启用'}</button>
              </div>
            </div>
            <div className="ext-routine-row">
              <label>
                时间表
                <input
                  value={editing[r.key] ?? r.schedule}
                  onChange={(e) => setEditing((m) => ({ ...m, [r.key]: e.target.value }))}
                  onBlur={() => {
                    const v = (editing[r.key] ?? r.schedule).trim()
                    if (v && v !== r.schedule) patch.mutate({ key: r.key, body: { schedule: v } })
                    setEditing((m) => {
                      const { [r.key]: _drop, ...rest } = m
                      return rest
                    })
                  }}
                />
                <small>{r.schedule_label} · 按本机时区</small>
              </label>
              <label className="ext-check">
                <input type="checkbox" checked={r.speak} onChange={(e) => patch.mutate({ key: r.key, body: { speak: e.target.checked } })} />
                产出念出来
              </label>
            </div>
            {r.prompt && <p className="ext-routine-prompt">「{r.prompt}」</p>}
            {r.detail && !r.prompt && <p className="ext-routine-prompt">{r.detail}</p>}
            <div className="ext-routine-last">
              {r.last ? (
                <>
                  <small>上次 {when(r.last.at)}</small>
                  <p>{r.last.text}</p>
                  <button className="btn-ghost-sm" onClick={() => speakAssistant(r.last!.text)}>念一遍</button>
                </>
              ) : (
                <small>还没跑过</small>
              )}
            </div>
          </div>
        ))}
        {rows.length === 0 && <div className="ext-empty card">{routines.isLoading ? '加载中' : '没有例程'}</div>}
      </div>
      {err && <p className="ext-err">{err instanceof ApiError ? err.message : '没成功'}</p>}
    </>
  )
}
