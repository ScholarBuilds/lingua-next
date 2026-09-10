/* 全局任务中心：三类主体同页可见（调研 §5.3「全局任务中心」）。

   - 创作任务：StudioTask 持久任务，可取消 / 重试 / 再次运行 / 清理记录
   - 工作流运行：FlowRun（画布级联、成套出图、DAG 编排），flow 帧实时更新，可取消 / 重试 / 打开画布
   - 管线运行：PipelineRun（视频 / 书籍 / 场景本入库等），pipeline 帧实时更新，可跳转管线页

   三类行折叠成同一种行模型（taskQueries.TaskCenterRow）：统一的状态芯片、
   进度条与「回到来源」动作。 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Ban, GitBranch, RotateCw, Trash2, Waypoints } from '@/components/NexusIcon'
import { toast } from 'sonner'

import { IconTask } from '@/components/icons'
import { Topbar } from '@/components/Topbar'
import { apiPipeline } from '@/lib/api-pipeline'
import { apiStudio } from '@/lib/api-studio'
import type { StudioFlowRun, StudioTask } from '@/lib/api-studio'

import {
  ACTIVE_FLOW_STATUSES,
  FLOW_RUNS_QUERY_KEY,
  PIPELINE_RUNS_QUERY_KEY,
  flowRow,
  mergeFlowRun,
  coveredImageJobs,
  isCoveredByTask,
  pipelineRows,
  rowInScope,
  taskRow,
} from './taskQueries'
import type { TaskCenterRow, TaskCenterScope } from './taskQueries'
import { useTaskHistory, useTaskSummary } from './taskHistory'
import type { PipelineEventFrame } from '@/lib/api-pipeline'
import { canCancelTask, canRerunTask, TERMINAL_TASK_STATUSES } from './taskActions'
import { studioToolIcon, useStudioToolCatalog } from './toolRegistry'
import { PipelineOverview } from '../pipeline/PipelineOverview'
import './task-center.css'

const SCOPES: ReadonlyArray<{ id: TaskCenterScope; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'active', label: '运行中' },
  { id: 'failed', label: '需处理' },
  { id: 'finished', label: '已结束' },
]

function formatTime(raw: string | null): string {
  if (raw === null) return '时间未记录'
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return raw
  return date.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

/** 三类行共用的外壳：图标、标题、状态芯片、进度条、错误与「回到来源」 */
function RowShell({
  row,
  icon,
  children,
}: {
  row: TaskCenterRow
  icon: JSX.Element
  children?: ReactNode
}): JSX.Element {
  const navigate = useNavigate()
  const meta = [row.stage, row.context, formatTime(row.createdAt)]
    .filter((part): part is string => part !== null)
  return (
    <article className={`stt-row stt-row-${row.tone}`}>
      <div className="stt-row-icon">{icon}</div>
      <div className="stt-row-main">
        <div className="stt-row-head">
          <strong>{row.title}</strong>
          <span className={`stt-state stt-tone-${row.tone}`}>{row.statusLabel}</span>
          {row.kind !== '' && <code>{row.kind}</code>}
        </div>
        <div className="stt-row-meta">
          {meta.map((part, index) => (
            <span key={index}>{index > 0 ? `· ${part}` : part}</span>
          ))}
        </div>
        {row.active && row.progress !== null && (
          <div className="stt-bar" aria-label={`进度 ${Math.round(row.progress)}%`}>
            <i style={{ width: `${Math.max(2, Math.min(100, row.progress))}%` }} />
          </div>
        )}
        {row.error !== null && <div className="stt-error">{row.error}</div>}
      </div>
      <div className="stt-row-side">
        {row.active && row.progress !== null && <b>{Math.round(row.progress)}%</b>}
        {children}
        {row.sourceRoute !== null && (
          <button className="btn btn-soft" onClick={() => navigate(row.sourceRoute!)}>
            回到来源
          </button>
        )}
      </div>
    </article>
  )
}

function Group({
  icon,
  label,
  hint,
  count,
  error,
  children,
}: {
  icon: JSX.Element
  label: string
  hint: string
  count: number
  error: string | null
  children: ReactNode
}): JSX.Element {
  return (
    <section className="stt-group">
      <div className="stt-group-head">
        {icon}
        <h2>{label}</h2>
        <b>{count}</b>
        <span>{hint}</span>
        {error !== null && <em>加载失败：{error}</em>}
      </div>
      <div className="stt-list">{children}</div>
    </section>
  )
}

export default function TaskCenterPage(): JSX.Element {
  const [scope, setScope] = useState<TaskCenterScope>('all')
  const [params, setParams] = useSearchParams()
  /* 管线中心并进来后的两个视图（CR-006 D4）：列表按状态筛，总览按域看健康。
     视图记在 URL 上，/pipeline 深链才有地方落。 */
  const view = params.get('view') === 'pipelines' ? 'pipelines' : 'list'
  const setView = (next: 'list' | 'pipelines') => {
    const q = new URLSearchParams(params)
    if (next === 'pipelines') q.set('view', 'pipelines')
    else q.delete('view')
    setParams(q, { replace: true })
  }
  const queryClient = useQueryClient()
  const identity = params.get('focus') ?? ''
  const history = useTaskHistory(identity ? 'all' : scope, identity)
  const summary = useTaskSummary()
  const tasksQuery = { ...history, data: { items: history.data?.tasks ?? [] } }
  const flowsQuery = { ...history, data: { items: history.data?.flows ?? [] } }
  const pipeline = { query: { ...history, data: { items: history.data?.pipeline ?? [] } }, frames: {} as Record<string, PipelineEventFrame> }
  const toolCatalog = useStudioToolCatalog()

  const retry = useMutation({
    mutationFn: (id: string) => apiStudio.retryTask(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['studio-tasks'] })
      toast.success('重试任务已入队')
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const rerun = useMutation({
    mutationFn: (id: string) => apiStudio.rerunTask(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['studio-tasks'] })
      toast.success('已按原请求快照创建新任务')
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const cancel = useMutation({
    mutationFn: (id: string) => apiStudio.cancelTask(id),
    onSuccess: ({ task }) => {
      // 先用返回的快照替换列表里的那一行，再让列表重新拉取，不等 SSE 也能立刻看到状态变化。
      queryClient.setQueryData<{ items: StudioTask[] }>(['studio-tasks'], (current) =>
        current === undefined
          ? current
          : { ...current, items: current.items.map((item) => (item.id === task.id ? task : item)) },
      )
      void queryClient.invalidateQueries({ queryKey: ['studio-tasks'] })
      toast.success(task.status === 'cancelled' ? '任务已取消' : '已请求取消，任务会在下一个检查点停止')
    },
    onError: (error: Error) => {
      // 409 说明任务已经收口，列表是旧的，顺手刷一次。
      void queryClient.invalidateQueries({ queryKey: ['studio-tasks'] })
      toast.error(error.message)
    },
  })
  const cleanup = useMutation({
    mutationFn: (ids: string[]) => apiStudio.cleanupTasks(ids),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['studio-tasks'] })
      toast.success(`已清理 ${result.deleted} 条任务记录，生成资产仍保留`)
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const mergeFlowRunIntoCache = (run: StudioFlowRun): void => {
    void queryClient.invalidateQueries({ queryKey: ['studio-tasks'] })
    queryClient.setQueryData<{ items: StudioFlowRun[] }>(FLOW_RUNS_QUERY_KEY, (current) =>
      current === undefined ? { items: [run] } : { ...current, items: mergeFlowRun(current.items, run) },
    )
  }
  const flowCancel = useMutation({
    mutationFn: (id: string) => apiStudio.cancelFlowRun(id),
    onSuccess: (run) => {
      mergeFlowRunIntoCache(run)
      toast.success('已停止后续调度，已提交的节点任务会继续收口')
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const flowRetry = useMutation({
    mutationFn: (id: string) => apiStudio.retryFlowRun(id),
    onSuccess: (run) => {
      mergeFlowRunIntoCache(run)
      toast.success('已从原始快照新建一次重试')
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const pipelineRerun = useMutation({
    mutationFn: (videoId: number) => apiPipeline.rerun({ video_id: videoId, scope: 'failed' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PIPELINE_RUNS_QUERY_KEY })
      toast.success('已从失败节点重跑')
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const tasks = tasksQuery.data?.items ?? []
  const flowRuns = flowsQuery.data?.items ?? []
  const pipelineList = pipeline.query.data?.items ?? []
  const tools = new Map((toolCatalog.data?.tools ?? []).map((tool) => [tool.id, tool]))

  const taskRowsAll = useMemo(
    () => tasks.map((task) => taskRow(task, tools.get(task.tool_id)?.label)),
    // tools 每次渲染新建 Map，依赖用目录数据本身
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, toolCatalog.data],
  )
  const flowRowsAll = useMemo(() => flowRuns.map((run) => flowRow(run)), [flowRuns])
  /* image_gen 域的管线 run 是工坊任务的执行细节，两边都列同一份活会占两行。
     判据与浮层共用 `coveredImageJobs` / `isCoveredByTask`，两处各写一份必然长歪。 */
  const pipelineRowsAll = useMemo(() => {
    const covered = coveredImageJobs(tasks, false)
    const bySubject = new Map(pipelineList.map((item) => [String(item.id), item]))
    return pipelineRows(pipelineList, pipeline.frames).filter((row) => {
      const item = bySubject.get(row.id)
      // 列表项的 domain 是可选的（历史 run 可能没带），拿不到就不折——宁可多列一行
      return item === undefined || !isCoveredByTask(item.domain ?? '', item.subject_id, covered)
    })
  }, [pipelineList, pipeline.frames, tasks])
  /** run id → 域与主体：重跑按钮只对视频域的失败 run 开放 */
  const pipelineMeta = useMemo(() => {
    const map = new Map<string, { domain: string; subjectId: number }>()
    for (const item of pipelineList) {
      map.set(String(item.id), {
        domain: item.domain ?? 'video',
        subjectId: item.subject_id ?? item.video_id ?? 0,
      })
    }
    for (const frame of Object.values(pipeline.frames)) {
      map.set(String(frame.run_id), { domain: frame.domain, subjectId: frame.subject_id })
    }
    return map
  }, [pipelineList, pipeline.frames])

  const taskById = new Map(tasks.map((task) => [task.id, task]))
  const flowById = new Map(flowRuns.map((run) => [run.id, run]))

  const taskRowsShown = taskRowsAll.filter((row) => rowInScope(row, scope))
  const flowRowsShown = flowRowsAll.filter((row) => rowInScope(row, scope))
  const pipelineRowsShown = pipelineRowsAll.filter((row) => rowInScope(row, scope))
  const allRows = [...taskRowsAll, ...flowRowsAll, ...pipelineRowsAll]
  const activeCount = summary.data?.active ?? 0
  const failedCount = summary.data?.attention ?? 0
  const cleanableIds = taskRowsShown
    .filter((row) => TERMINAL_TASK_STATUSES.has(row.status))
    .map((row) => row.id)

  const loading = tasksQuery.isPending && flowsQuery.isPending && pipeline.query.isPending
  const nothing =
    !loading
    && taskRowsShown.length === 0
    && flowRowsShown.length === 0
    && pipelineRowsShown.length === 0
  const refreshing = tasksQuery.isFetching || flowsQuery.isFetching || pipeline.query.isFetching

  return (
    <div className="main">
      {/* 侧栏已经写着「任务」，页内不再重复一个大标题；数字贴标题当状态，不当动作 */}
      <Topbar
        title="任务"
        meta={
          <>
            <span className={`chip${activeCount > 0 ? ' accent' : ''}`}>{activeCount} 在跑</span>
            <span className={`chip${failedCount > 0 ? ' warn' : ''}`}>{failedCount} 需处理</span>
            <span className="chip">{summary.data?.total ?? allRows.length} 条记录</span>
          </>
        }
      />
      <div className="content">
      <main className="stt">
      <nav className="stt-tabs" aria-label="任务视图与筛选">
        <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}><IconTask />任务</button>
        <button className={view === 'pipelines' ? 'active' : ''} onClick={() => setView('pipelines')}><Waypoints />管线总览</button>
        <i className="stt-tabs-sep" aria-hidden />
        {view === 'list' && SCOPES.map((item) => (
          <button key={item.id} className={scope === item.id ? 'active' : ''} onClick={() => setScope(item.id)}>{item.label}</button>
        ))}
        <span />
        <button
          onClick={() => {
            void history.refetch()
            void summary.refetch()
          }}
          disabled={refreshing}
        >刷新</button>
        <button
          className="stt-clean"
          disabled={cleanableIds.length === 0 || cleanup.isPending}
          onClick={() => {
            if (!window.confirm(`清理当前范围内 ${cleanableIds.length} 条已结束的创作任务记录？生成资产会继续保留。`)) return
            cleanup.mutate(cleanableIds)
          }}
        ><Trash2 />清理已结束</button>
      </nav>

      {view === 'list' && <form className="stt-search" onSubmit={event => {
        event.preventDefault()
        const value = String(new FormData(event.currentTarget).get('identity') ?? '').trim()
        const next = new URLSearchParams(params)
        if (value) next.set('focus', value)
        else next.delete('focus')
        setScope('all')
        setParams(next)
      }}>
        <label>定位历史任务 <input className="input" key={identity} name="identity" defaultValue={identity} placeholder="task:ID / flow:ID / pipeline:ID" /></label>
        <button type="submit" className="btn btn-outline">查找</button>
        {identity && <button type="button" className="btn btn-outline" onClick={() => { const next = new URLSearchParams(params); next.delete('focus'); setParams(next) }}>清除定位</button>}
      </form>}

      {view === 'pipelines' && <PipelineOverview />}

      {view === 'list' && (
        <>
      {loading && <div className="state-block"><div className="spinner" /><div>加载任务…</div></div>}
      {nothing && (
        <div className="stt-empty"><IconTask /><strong>这个范围还没有任务</strong><p>从生图控制台、画布或素材导入发起的任务会先登记，再进入后台队列。</p></div>
      )}

      {taskRowsShown.length > 0 && (
        <Group
          icon={<IconTask />}
          label="创作任务"
          hint="生图、增强、视频与工作流节点等持久任务"
          count={taskRowsShown.length}
          error={tasksQuery.isError ? tasksQuery.error.message : null}
        >
          {taskRowsShown.map((row) => {
            const task = taskById.get(row.id)
            if (task === undefined) return null
            const ToolIcon = studioToolIcon(task.tool_id)
            const canRetry = task.retryable && ['failed', 'partial', 'cancelled'].includes(task.status)
            return (
              <RowShell key={row.key} row={row} icon={ToolIcon ? <ToolIcon /> : <IconTask />}>
                {canCancelTask(task) && (
                  <button
                    className="btn btn-danger"
                    disabled={cancel.isPending && cancel.variables === task.id}
                    onClick={() => cancel.mutate(task.id)}
                    title="在下一个检查点停止任务；已提交给供应商的调用不一定能追回"
                  >
                    <Ban />{cancel.isPending && cancel.variables === task.id ? '取消中…' : '取消'}
                  </button>
                )}
                {canRetry && (
                  <button
                    className="btn btn-primary"
                    disabled={retry.isPending && retry.variables === task.id}
                    onClick={() => retry.mutate(task.id)}
                  >
                    {retry.isPending && retry.variables === task.id ? '入队中…' : '重试'}
                  </button>
                )}
                {canRerunTask(task) && (
                  <button
                    className="btn btn-soft"
                    disabled={rerun.isPending && rerun.variables === task.id}
                    onClick={() => {
                      if (!window.confirm('再次运行会重新调用模型或工作流，可能产生费用。确认继续？')) return
                      rerun.mutate(task.id)
                    }}
                    title="按原请求快照发起一次新调用"
                  >
                    <RotateCw />{rerun.isPending && rerun.variables === task.id ? '入队中…' : '再次运行'}
                  </button>
                )}
                {TERMINAL_TASK_STATUSES.has(task.status) && (
                  <button
                    className="btn btn-ghost stt-clean-one"
                    disabled={cleanup.isPending && cleanup.variables?.includes(task.id) === true}
                    onClick={() => {
                      if (!window.confirm('清理这条任务记录？生成资产会继续保留。')) return
                      cleanup.mutate([task.id])
                    }}
                    title="只清理任务记录，生成资产继续保留"
                  >
                    <Trash2 />{cleanup.isPending && cleanup.variables?.includes(task.id) === true ? '清理中…' : '清理记录'}
                  </button>
                )}
              </RowShell>
            )
          })}
        </Group>
      )}

      {flowRowsShown.length > 0 && (
        <Group
          icon={<GitBranch />}
          label="工作流运行"
          hint="画布级联、成套出图与 DAG 编排的可恢复运行"
          count={flowRowsShown.length}
          error={flowsQuery.isError ? flowsQuery.error.message : null}
        >
          {flowRowsShown.map((row) => {
            const run = flowById.get(row.id)
            if (run === undefined) return null
            const canRetryFlow = ['failed', 'partial', 'cancelled'].includes(run.status)
            return (
              <RowShell key={row.key} row={row} icon={<GitBranch />}>
                {ACTIVE_FLOW_STATUSES.has(run.status) && (
                  <button
                    className="btn btn-danger"
                    disabled={flowCancel.isPending && flowCancel.variables === run.id}
                    onClick={() => flowCancel.mutate(run.id)}
                    title="停止后续节点调度；已提交的节点任务会继续收口"
                  >
                    <Ban />{flowCancel.isPending && flowCancel.variables === run.id ? '取消中…' : '取消'}
                  </button>
                )}
                {canRetryFlow && (
                  <button
                    className="btn btn-primary"
                    disabled={flowRetry.isPending && flowRetry.variables === run.id}
                    onClick={() => {
                      if (!window.confirm('重试会从原始快照新建一次运行并重新调用模型，可能产生费用。确认继续？')) return
                      flowRetry.mutate(run.id)
                    }}
                  >
                    <RotateCw />{flowRetry.isPending && flowRetry.variables === run.id ? '入队中…' : '重试'}
                  </button>
                )}
              </RowShell>
            )
          })}
        </Group>
      )}

      {pipelineRowsShown.length > 0 && (
        <Group
          icon={<Waypoints />}
          label="管线运行"
          hint="视频、书籍、场景本等入库与增强管线"
          count={pipelineRowsShown.length}
          error={pipeline.query.isError ? pipeline.query.error.message : null}
        >
          {pipelineRowsShown.map((row) => {
            const meta = pipelineMeta.get(row.id)
            const canRerunPipeline =
              row.status === 'failed' && meta !== undefined && meta.domain === 'video' && meta.subjectId > 0
            return (
              <RowShell key={row.key} row={row} icon={<Waypoints />}>
                {canRerunPipeline && (
                  <button
                    className="btn btn-primary"
                    disabled={pipelineRerun.isPending && pipelineRerun.variables === meta.subjectId}
                    onClick={() => pipelineRerun.mutate(meta.subjectId)}
                    title="从失败节点及其下游重跑"
                  >
                    <RotateCw />{pipelineRerun.isPending && pipelineRerun.variables === meta.subjectId ? '入队中…' : '重跑'}
                  </button>
                )}
              </RowShell>
            )
          })}
        </Group>
      )}
        </>
      )}
      {history.isError && <p role="alert">任务读取失败：{history.error.message}<button className="btn btn-outline" onClick={() => void history.refetch()}>重试</button></p>}
      {history.hasNextPage && <button className="btn btn-outline" disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>{history.isFetchingNextPage ? '正在读取…' : '加载更多记录'}</button>}
      </main>
      </div>
    </div>
  )
}
