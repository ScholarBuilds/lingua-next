/* 当前画布的生成日志。

   与 `/studio/models` 那本调用账本的分工：
   - 账本的单位是**一次模型调用**，全局、跨画布，看的是消息 / 分块 / token；
   - 这里的单位是**当前画布的一件活**（`StudioTask`）。一件活可能一次模型调用都没有
     （纯本地工具、命中缓存），也可能横跨十几次（工作流）。两者是一对多。

   所以复用的是**数据与算法**，不是组件：调用行、逐步事件都从台账那两个接口取，
   首 token / 阶段折叠 / 输出拼装直接用 `invocation-stats.ts`；而账本的
   `InvocationInspector` 渲染的是一行 `ModelInvocation`，套不上「一件活」这个单位
   （它没有产物、参考图、重试族，也没有任务级的阶段事件），另写一层。

   排版按「一屏能扫多少条」定：列表一行一条，选中才在右侧展开详情。
   长内容（提示词、错误堆栈、原始 JSON）一律关在自己的滚动容器里。 */

import { useQuery } from '@tanstack/react-query'
import {
  Check,
  Clipboard,
  FileOutput,
  LoaderCircle,
  RefreshCw,
  RotateCw,
  Search,
  TriangleAlert,
  X,
  XCircle,
} from '@/components/NexusIcon'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

import { Overlay } from '@/components/Overlay'
import { Picker } from '@/components/ui/picker'
import { apiConfig } from '@/lib/api-config'
import type { ModelInvocation } from '@/lib/api-config'
import { apiStudio } from '@/lib/api-studio'
import type { StudioTaskEvent } from '@/lib/api-studio'

import { foldInvocationTiming, formatMs, formatTokens } from './invocation-stats'
import {
  ACTIVE_TASK_STATUSES,
  BUCKET_LABELS,
  EMPTY_FILTERS,
  buildRunLog,
  capabilityOptions,
  filterRunLog,
  formatClock,
  formatDuration,
  isFiltering,
  nodeOptions,
  selectedRow,
  statusOptions,
  summarizeRunLog,
  toggleSelection,
  windowOptions,
} from './run-log-model'
import type { RunLogFilters, RunLogRow } from './run-log-model'
import { canRerunTask } from './taskActions'

import './run-log.css'

const RETRYABLE_STATUSES = new Set(['failed', 'partial', 'cancelled'])

type Tab = 'overview' | 'prompt' | 'request' | 'outputs' | 'timing' | 'raw'

const TABS: Array<[Tab, string]> = [
  ['overview', '概览'],
  ['prompt', '提示词'],
  ['request', '请求'],
  ['outputs', '产物'],
  ['timing', '时序'],
  ['raw', '原始'],
]

async function copy(text: string, label: string): Promise<void> {
  if (text === '') return
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`${label}已复制`)
  } catch {
    toast.error(`${label}复制失败`)
  }
}

function StatusChip({ row }: { row: RunLogRow }) {
  const tone = row.active ? 'active' : row.bucket
  const icon = row.active ? (
    <LoaderCircle aria-hidden />
  ) : row.bucket === 'succeeded' ? (
    <Check aria-hidden />
  ) : row.bucket === 'partial' ? (
    <TriangleAlert aria-hidden />
  ) : (
    <XCircle aria-hidden />
  )
  return (
    <span className={`rlg-status rlg-status-${tone}`} title={row.status}>
      {icon}
      {BUCKET_LABELS[row.bucket]}
    </span>
  )
}

function CopyBlock({ text, label, bad }: { text: string; label: string; bad?: boolean }) {
  return (
    <section className="rlg-section">
      <h4>
        {label}
        <em>{text.length} 字符</em>
        <button className="btn btn-ghost-sm" onClick={() => void copy(text, label)}>
          <Clipboard aria-hidden />
          复制
        </button>
      </h4>
      <pre className={bad === true ? 'rlg-pre rlg-pre-bad' : 'rlg-pre'}>{text}</pre>
    </section>
  )
}

function Tiles({ row }: { row: RunLogRow }) {
  if (row.outputs.length === 0) {
    return <p className="rlg-note">这次任务没有产出文件。</p>
  }
  return (
    <div className="rlg-tiles">
      {row.outputs.map((output) =>
        output.kind === 'image' ? (
          <a className="rlg-tile" key={output.key} href={output.url} target="_blank" rel="noreferrer">
            <img src={output.url} alt={output.name} loading="lazy" />
            <span>{output.name}</span>
          </a>
        ) : output.kind === 'video' ? (
          <div className="rlg-tile" key={output.key}>
            <video src={output.url} controls preload="metadata" />
            <span>{output.name}</span>
          </div>
        ) : output.kind === 'audio' ? (
          <audio className="rlg-audio" key={output.key} src={output.url} controls preload="metadata" />
        ) : (
          <a className="rlg-tile-file" key={output.key} href={output.url} download={output.name}>
            <FileOutput aria-hidden />
            {output.name}
          </a>
        ),
      )}
    </div>
  )
}

function OverviewPane({
  row,
  onPick,
  onRefresh,
}: {
  row: RunLogRow
  onPick: (id: string) => void
  onRefresh: () => void
}) {
  const task = row.task
  const retryable = task.retryable && RETRYABLE_STATUSES.has(task.status)
  const retry = async (): Promise<void> => {
    try {
      await apiStudio.retryTask(task.id)
      toast.success('已创建重试任务')
      onRefresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '重试失败')
    }
  }
  const rerun = async (): Promise<void> => {
    if (!window.confirm('再次运行会重新调用模型或工作流，可能产生费用。确认继续？')) return
    try {
      await apiStudio.rerunTask(task.id)
      toast.success('已按原请求快照创建新任务')
      onRefresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '再次运行失败')
    }
  }
  const facts: Array<[string, string]> = [
    ['任务 id', task.id],
    ['类型', task.task_type],
    ['工具', task.tool_id],
    ['节点', row.nodeId === '' ? '—' : row.nodeId],
    ['能力', row.capabilityLabel],
    ['模型', row.model],
    ['部署 id', task.deployment_id === null ? '—' : String(task.deployment_id)],
    ['上游任务 id', task.provider_task_id ?? '—'],
    ['阶段', task.stage ?? '—'],
    ['创建', formatClock(row.createdMs)],
    ['开始', task.started_at === null ? '—' : formatClock(Date.parse(task.started_at))],
    ['结束', task.finished_at === null ? '—' : formatClock(Date.parse(task.finished_at))],
  ]
  return (
    <div className="rlg-pane">
      {row.error !== '' && <CopyBlock text={row.error} label="失败原因" bad />}
      <div className="rlg-stats">
        <div className="rlg-stat">
          <span>耗时</span>
          <strong>{formatDuration(row.durationMs)}</strong>
        </div>
        <div className="rlg-stat">
          <span>首 token</span>
          <strong>{formatMs(row.firstTokenMs)}</strong>
        </div>
        <div className="rlg-stat">
          <span>产物</span>
          <strong>{row.outputs.length}</strong>
        </div>
        <div className="rlg-stat">
          <span>模型调用</span>
          <strong>{row.invocations.length}</strong>
        </div>
        <div className="rlg-stat">
          <span>尝试</span>
          <strong>
            {row.attempt} / {row.lineage.length}
          </strong>
        </div>
        <div className="rlg-stat">
          <span>进度</span>
          <strong>{Math.round(task.progress * 100)}%</strong>
        </div>
      </div>

      <section className="rlg-section">
        <h4>基本信息</h4>
        <dl className="rlg-kv">
          {facts.map(([key, value]) => (
            <Fragment key={key}>
              <dt>{key}</dt>
              <dd>{value}</dd>
            </Fragment>
          ))}
        </dl>
      </section>

      {row.lineage.length > 1 && (
        <section className="rlg-section">
          <h4>
            重试历史
            <em>共 {row.lineage.length} 次</em>
          </h4>
          <div className="rlg-attempts">
            {row.lineage.map((id, index) => (
              <button
                className={id === row.id ? 'rlg-attempt-on' : undefined}
                key={id}
                onClick={() => onPick(id)}
              >
                第 {index + 1} 次
                <code>{id}</code>
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="rlg-actions">
        <button className="btn btn-ghost-sm" onClick={() => void copy(task.id, '任务 id')}>
          <Clipboard aria-hidden />
          复制任务 id
        </button>
        {retryable && (
          <button className="btn btn-outline btn-sm" onClick={() => void retry()}>
            <RefreshCw aria-hidden />
            重试
          </button>
        )}
        {canRerunTask(task) && (
          <button
            className="btn btn-outline btn-sm"
            title="复制不可变请求快照并发起一次新调用"
            onClick={() => void rerun()}
          >
            <RotateCw aria-hidden />
            再次运行
          </button>
        )}
      </div>
    </div>
  )
}

function PromptPane({ row }: { row: RunLogRow }) {
  if (row.prompt === '' && row.sentPrompts.length === 0) {
    return (
      <div className="rlg-pane">
        <p className="rlg-note">
          这次任务没有记录提示词。纯本地工具、以及只吃参考图不吃文字的调用都属于这一类。
        </p>
      </div>
    )
  }
  return (
    <div className="rlg-pane">
      {row.prompt !== '' && <CopyBlock text={row.prompt} label="画布提交" />}
      {row.sentPrompts.map((sent) => (
        <section className="rlg-section" key={sent.invocationId}>
          <h4>
            实际发出 · {sent.model}
            {sent.rewritten && <span className="rlg-badge">已改写</span>}
            <button className="btn btn-ghost-sm" onClick={() => void copy(sent.text, '提示词')}>
              <Clipboard aria-hidden />
              复制
            </button>
          </h4>
          <pre className="rlg-pre">{sent.text}</pre>
        </section>
      ))}
      {row.sentPrompts.length === 0 && (
        <p className="rlg-note">台账里没有这次任务的请求快照，无法确认最终发出去的是哪一段。</p>
      )}
    </div>
  )
}

function RequestPane({ row }: { row: RunLogRow }) {
  return (
    <div className="rlg-pane">
      {row.references.length > 0 && (
        <section className="rlg-section">
          <h4>
            参考图
            <em>{row.references.length} 张</em>
          </h4>
          <div className="rlg-tiles">
            {row.references.map((ref) => (
              <a className="rlg-tile" key={ref.key} href={ref.url} target="_blank" rel="noreferrer">
                <img src={ref.url} alt={ref.label} loading="lazy" />
                <span>{ref.label}</span>
              </a>
            ))}
          </div>
        </section>
      )}
      <section className="rlg-section">
        <h4>请求参数</h4>
        {row.fields.length === 0 ? (
          <p className="rlg-note">这次任务没有额外参数。</p>
        ) : (
          <dl className="rlg-kv">
            {row.fields.map((field) => (
              <Fragment key={field.key}>
                <dt>{field.key}</dt>
                <dd>{field.value}</dd>
              </Fragment>
            ))}
          </dl>
        )}
      </section>
      {row.invocations.length > 0 && (
        <section className="rlg-section">
          <h4>
            上游请求快照
            <em>{row.invocations.length} 次调用</em>
          </h4>
          <pre className="rlg-pre">
            {JSON.stringify(
              row.invocations.map((item) => ({
                id: item.id,
                model: item.model,
                plugin_id: item.plugin_id,
                operation: item.operation,
                status: item.status,
                request: item.request,
              })),
              null,
              2,
            )}
          </pre>
        </section>
      )}
    </div>
  )
}

function OutputsPane({ row }: { row: RunLogRow }) {
  return (
    <div className="rlg-pane">
      <section className="rlg-section">
        <h4>
          产物
          <em>{row.outputs.length} 个</em>
        </h4>
        <Tiles row={row} />
      </section>
      <section className="rlg-section">
        <h4>结果原文</h4>
        <pre className="rlg-pre">{JSON.stringify(row.task.result ?? null, null, 2)}</pre>
      </section>
    </div>
  )
}

/** 时序：任务级阶段事件 + 模型调用级的首 token / 解码折叠。
 *  两者不是一回事——排队等了 40 秒和模型吐字慢，在这一页要能分开看到。 */
function TimingPane({ row }: { row: RunLogRow }) {
  const events = useQuery({
    queryKey: ['canvas-run-log-events', row.id],
    queryFn: () => apiStudio.taskEvents(row.id),
    refetchInterval: row.active ? 2_000 : false,
  })
  const primary: ModelInvocation | undefined = row.invocations[0]
  const frames = useQuery({
    queryKey: ['cfg-model-invocation-events', primary?.id ?? ''],
    queryFn: () => apiConfig.modelInvocationEvents(primary?.id ?? ''),
    enabled: primary !== undefined,
  })
  const timing = useMemo(
    () => foldInvocationTiming(frames.data?.items ?? [], primary ?? null),
    [frames.data, primary],
  )
  const span = Math.max(timing.totalMs ?? 0, timing.lastChunkMs ?? 0, 1)
  const items: StudioTaskEvent[] = events.data?.items ?? []
  return (
    <div className="rlg-pane">
      <div className="rlg-stats">
        <div className="rlg-stat">
          <span>端到端</span>
          <strong>{formatDuration(row.durationMs)}</strong>
        </div>
        <div className="rlg-stat">
          <span>首 token</span>
          <strong>{formatMs(timing.ttftMs ?? row.firstTokenMs)}</strong>
        </div>
        <div className="rlg-stat">
          <span>模型总时长</span>
          <strong>{formatMs(timing.totalMs)}</strong>
        </div>
        <div className="rlg-stat">
          <span>输出 tokens</span>
          <strong>{formatTokens(timing.outputTokens)}</strong>
        </div>
        <div className="rlg-stat">
          <span>分块</span>
          <strong>{timing.chunkCount}</strong>
        </div>
      </div>

      {timing.phases.length > 0 && (
        <section className="rlg-section">
          <h4>阶段分解</h4>
          <div className="rlg-bar" aria-label="耗时分解">
            {timing.phases.map((phase) => (
              <i
                className={`rlg-bar-${phase.key}`}
                key={phase.key}
                title={`${phase.label} ${formatMs(phase.endMs - phase.startMs)}`}
                style={{
                  left: `${(phase.startMs / span) * 100}%`,
                  width: `${Math.max(((phase.endMs - phase.startMs) / span) * 100, 0.5)}%`,
                }}
              />
            ))}
          </div>
        </section>
      )}

      <section className="rlg-section">
        <h4>
          任务事件
          <em>{items.length} 条</em>
        </h4>
        {events.isError && <p className="rlg-note">事件读取失败：{events.error.message}</p>}
        {!events.isError && items.length === 0 && <p className="rlg-note">没有记录到阶段事件。</p>}
        {items.length > 0 && (
          <dl className="rlg-kv">
            {items.map((event) => (
              <Fragment key={event.seq}>
                <dt>{formatClock(event.created_at === null ? null : Date.parse(event.created_at))}</dt>
                <dd>
                  {event.event_type} · {event.status}
                  {event.stage === null ? '' : ` · ${event.stage}`}
                  {event.message === null ? '' : ` — ${event.message}`}
                </dd>
              </Fragment>
            ))}
          </dl>
        )}
      </section>
    </div>
  )
}

function RawPane({ row }: { row: RunLogRow }) {
  return (
    <div className="rlg-pane">
      <section className="rlg-section">
        <h4>任务行</h4>
        <pre className="rlg-pre">{JSON.stringify(row.task, null, 2)}</pre>
      </section>
      <section className="rlg-section">
        <h4>
          模型调用
          <em>{row.invocations.length} 条</em>
        </h4>
        <pre className="rlg-pre">{JSON.stringify(row.invocations, null, 2)}</pre>
      </section>
    </div>
  )
}

/** 导出只为测试：详情面板只有点中某一行才挂载，整体渲染走不到它，
 *  而这里恰恰是失败排查信息最密集的一块（picker 的 `Items` 是同一个先例）。 */
export function DetailPanel({
  row,
  onClose,
  onPick,
  onRefresh,
}: {
  row: RunLogRow
  onClose: () => void
  onPick: (id: string) => void
  onRefresh: () => void
}) {
  const [tab, setTab] = useState<Tab>('overview')
  // 换一行就回到概览：停在「原始」页去看下一条任务的 JSON 没有意义
  useEffect(() => setTab('overview'), [row.id])
  return (
    <aside className="rlg-detail">
      <div className="rlg-detail-head">
        <div>
          <strong>{row.model}</strong>
          <span>
            {row.capabilityLabel} · {row.task.task_type}
            {row.nodeId === '' ? '' : ` · 节点 ${row.nodeId}`}
          </span>
        </div>
        <button className="btn btn-ghost-sm" onClick={onClose} aria-label="收起详情">
          <X aria-hidden />
        </button>
      </div>
      <div className="rlg-tabs" role="tablist">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? 'rlg-tab-on' : undefined}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'overview' && <OverviewPane row={row} onPick={onPick} onRefresh={onRefresh} />}
      {tab === 'prompt' && <PromptPane row={row} />}
      {tab === 'request' && <RequestPane row={row} />}
      {tab === 'outputs' && <OutputsPane row={row} />}
      {tab === 'timing' && <TimingPane row={row} />}
      {tab === 'raw' && <RawPane row={row} />}
    </aside>
  )
}

export function CanvasRunLog({ canvasId, onClose }: { canvasId: number; onClose: () => void }) {
  const [filters, setFilters] = useState<RunLogFilters>(EMPTY_FILTERS)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const tasks = useQuery({
    queryKey: ['canvas-run-log', canvasId],
    queryFn: () => apiStudio.tasks({ canvas_id: canvasId, limit: 200 }),
    refetchInterval: (current) =>
      current.state.data?.items.some((task) => ACTIVE_TASK_STATUSES.has(task.status)) ? 1500 : false,
  })
  /* 台账按画布过滤后就是这张画布上真实发生过的模型调用。取它只为两件事：
     「模型」位的真名，以及首 token / 阶段这类任务表里没有的耗时细节。 */
  const invocations = useQuery({
    queryKey: ['canvas-run-log-invocations', canvasId],
    queryFn: () => apiConfig.modelInvocations({ canvas_id: canvasId, limit: 200 }),
  })
  // 两个 queryKey 都与别处一致，命中缓存就不再多发请求
  const bindings = useQuery({ queryKey: ['cfg-bindings'], queryFn: apiConfig.bindings })
  const deployments = useQuery({
    queryKey: ['cfg-model-deployments'],
    queryFn: () => apiConfig.modelDeployments(),
  })

  const rows = useMemo(
    () =>
      buildRunLog({
        tasks: tasks.data?.items ?? [],
        invocations: invocations.data?.items ?? [],
        bindings: bindings.data ?? [],
        deployments: deployments.data ?? [],
      }),
    [tasks.data, invocations.data, bindings.data, deployments.data],
  )
  const visible = useMemo(() => filterRunLog(rows, filters), [rows, filters])
  const summary = useMemo(() => summarizeRunLog(visible), [visible])
  const selected = selectedRow(visible, selectedId)

  const update = (patch: Partial<RunLogFilters>): void =>
    setFilters((prev) => ({ ...prev, ...patch }))
  const refresh = (): void => {
    void tasks.refetch()
    void invocations.refetch()
  }

  /* 有任务没收口时列表每 1.5s 自动拉一次，那期间 `isFetching` 一直在跳。
     只有不在轮询时的 fetching 才是用户点出来的，才配改按钮文案。 */
  const polling = rows.some((row) => row.active)
  const busy = tasks.isFetching && !polling

  const figures: Array<[string, string, string]> = [
    ['共', String(summary.total), ''],
    ['成功', String(summary.succeeded), 'rlg-figure rlg-figure-ok'],
    ['失败', String(summary.failed), 'rlg-figure rlg-figure-bad'],
    ['进行中', String(summary.active), ''],
    ['产物', String(summary.outputs), ''],
    ['耗时中位', formatDuration(summary.medianMs), ''],
  ]

  return (
    <Overlay onClose={onClose} card="rlg-dialog" labelledBy="rlg-title">
      <header className="rlg-head">
        <div>
          <h2 id="rlg-title">生成日志</h2>
          <p>
            当前画布的全部生成任务，来自持久任务表，刷新页面或服务重启后仍可查询。
            跨画布的模型调用明细在「模型 · 调用账本」里。
          </p>
        </div>
        <div className="rlg-head-actions">
          <button className="btn btn-outline btn-sm" disabled={busy} onClick={refresh}>
            <RefreshCw aria-hidden />
            {busy ? '刷新中…' : polling ? '自动刷新中' : '刷新'}
          </button>
          <button className="btn btn-ghost-sm" onClick={onClose}>
            关闭
          </button>
        </div>
      </header>

      <div className="rlg-figures">
        {figures.map(([label, value, cls]) => (
          <div className={cls === '' ? 'rlg-figure' : cls} key={label}>
            {label}
            <b>{value}</b>
          </div>
        ))}
      </div>

      <div className="rlg-filters">
        <div className="rlg-field">
          <span>状态</span>
          <Picker
            size="sm"
            value={filters.status}
            onChange={(status) => update({ status })}
            options={statusOptions(rows, filters.status)}
            aria-label="按状态筛选"
          />
        </div>
        <div className="rlg-field">
          <span>能力</span>
          <Picker
            size="sm"
            value={filters.capability}
            onChange={(capability) => update({ capability })}
            options={capabilityOptions(rows, filters.capability)}
            aria-label="按能力筛选"
          />
        </div>
        <div className="rlg-field">
          <span>节点</span>
          <Picker
            size="sm"
            value={filters.node}
            onChange={(node) => update({ node })}
            options={nodeOptions(rows, filters.node)}
            aria-label="按节点筛选"
          />
        </div>
        <div className="rlg-field">
          <span>时间</span>
          <Picker
            size="sm"
            value={filters.window}
            onChange={(window) => update({ window })}
            options={windowOptions()}
            aria-label="按时间窗筛选"
          />
        </div>
        <div className="rlg-search">
          <Search aria-hidden />
          <input
            value={filters.search}
            placeholder="搜提示词、报错、模型、节点、任务 id"
            aria-label="搜索生成日志"
            onChange={(event) => update({ search: event.target.value })}
          />
          {filters.search !== '' && (
            <button onClick={() => update({ search: '' })} aria-label="清空搜索">
              <X aria-hidden />
            </button>
          )}
        </div>
        {isFiltering(filters) && (
          <button className="btn btn-ghost-sm" onClick={() => setFilters(EMPTY_FILTERS)}>
            清除筛选
          </button>
        )}
      </div>

      <div className={selected === null ? 'rlg-body' : 'rlg-body rlg-body-split'}>
        <div className="rlg-table-wrap">
          {tasks.isError ? (
            <p className="rlg-empty rlg-empty-bad">读取失败：{tasks.error.message}</p>
          ) : tasks.isPending ? (
            <p className="rlg-empty">正在读取日志…</p>
          ) : visible.length === 0 ? (
            <p className="rlg-empty">
              {rows.length === 0
                ? '当前画布还没有生成日志。跑一次生成后这里会立刻出现记录。'
                : '没有符合筛选条件的记录，换个条件或清除筛选试试。'}
            </p>
          ) : (
            <table className="rlg-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>状态</th>
                  <th>能力</th>
                  <th>模型</th>
                  <th className="rlg-num">耗时</th>
                  <th>产物</th>
                  <th>摘要</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr
                    key={row.id}
                    className={[
                      row.id === selectedId ? 'rlg-row-on' : '',
                      row.bucket === 'failed' ? 'rlg-row-bad' : '',
                    ]
                      .filter((part) => part !== '')
                      .join(' ')}
                    tabIndex={0}
                    onClick={() => setSelectedId((prev) => toggleSelection(prev, row.id))}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      setSelectedId((prev) => toggleSelection(prev, row.id))
                    }}
                  >
                    <td className="rlg-time">{formatClock(row.createdMs)}</td>
                    <td>
                      <StatusChip row={row} />
                    </td>
                    <td>
                      <span className="rlg-cap" title={row.capabilityLabel}>
                        {row.capabilityLabel}
                      </span>
                    </td>
                    <td>
                      <span className="rlg-model" title={row.model}>
                        {row.model}
                      </span>
                    </td>
                    <td
                      className="rlg-num"
                      title={
                        row.firstTokenMs === null
                          ? '端到端墙钟耗时'
                          : `首 token ${formatMs(row.firstTokenMs)}`
                      }
                    >
                      {formatDuration(row.durationMs)}
                    </td>
                    <td>
                      <span className="rlg-thumbs">
                        {row.outputs
                          .filter((output) => output.kind === 'image')
                          .slice(0, 3)
                          .map((output) => (
                            <img key={output.key} src={output.url} alt="" loading="lazy" />
                          ))}
                        <span>{row.outputs.length}</span>
                      </span>
                    </td>
                    <td>
                      <span className="rlg-gist" title={row.error !== '' ? row.error : row.prompt}>
                        {row.error !== '' ? row.error : row.prompt || '—'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {selected !== null && (
          <DetailPanel
            row={selected}
            onClose={() => setSelectedId(null)}
            onPick={setSelectedId}
            onRefresh={refresh}
          />
        )}
      </div>
    </Overlay>
  )
}
