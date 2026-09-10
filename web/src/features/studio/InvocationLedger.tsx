/* 模型调用账本：一行一次真实调用，右侧检视器按 Input / Output / Raw / Timing 四页签回放。
   首屏走 REST（游标分页），之后靠任务事件流的 `invocation` 帧实时插行 / 改终态；
   60s 的整页刷新只是代理断流、睡眠唤醒后的兜底。 */

import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw, X } from '@/components/NexusIcon'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Picker } from '@/components/ui/picker'
import type { PickerOption } from '@/components/ui/picker'
import { apiConfig, subscribeInvocationFrames } from '@/lib/api-config'
import type {
  ModelInvocation,
  ModelInvocationEvent,
  ModelInvocationQuery,
} from '@/lib/api-config'

import {
  assembleOutput,
  foldInvocationTiming,
  formatMs,
  formatTokens,
  requestHeader,
} from './invocation-stats'
import { formatRate, summarizeInvocations } from './ledger-summary'
import type { LedgerTally } from './ledger-summary'

const PAGE_SIZE = 50
const LIVE_LIMIT = 500
const ALL = '*'
const STATUSES = ['running', 'succeeded', 'failed', 'cancelled', 'abandoned']
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'abandoned'])

interface Filters {
  status: string
  plugin_id: string
  capability: string
  source: string
  canvas_id: string
  task_id: string
}

const EMPTY_FILTERS: Filters = {
  status: ALL,
  plugin_id: ALL,
  capability: ALL,
  source: ALL,
  canvas_id: '',
  task_id: '',
}

function toQuery(filters: Filters): ModelInvocationQuery {
  const query: ModelInvocationQuery = { limit: PAGE_SIZE }
  if (filters.status !== ALL) query.status = filters.status
  if (filters.plugin_id !== ALL) query.plugin_id = filters.plugin_id
  if (filters.capability !== ALL) query.capability = filters.capability
  if (filters.source !== ALL) query.source = filters.source
  const canvas = filters.canvas_id.trim()
  if (canvas !== '' && Number.isSafeInteger(Number(canvas))) query.canvas_id = Number(canvas)
  const task = filters.task_id.trim()
  if (task !== '') query.task_id = task
  return query
}

/** 实时帧没经过服务端过滤，插行前按当前筛选条件再筛一遍 */
function matchesQuery(row: ModelInvocation, query: ModelInvocationQuery): boolean {
  if (query.status !== undefined && row.status !== query.status) return false
  if (query.plugin_id !== undefined && row.plugin_id !== query.plugin_id) return false
  if (query.capability !== undefined && row.capability !== query.capability) return false
  if (query.source !== undefined && row.source !== query.source) return false
  if (query.canvas_id !== undefined && row.canvas_id !== query.canvas_id) return false
  if (query.task_id !== undefined && row.task_id !== query.task_id) return false
  return true
}

function mergeRows(
  paged: ModelInvocation[],
  live: Map<string, ModelInvocation>,
  query: ModelInvocationQuery,
): ModelInvocation[] {
  const byId = new Map<string, ModelInvocation>()
  for (const row of paged) byId.set(row.id, row)
  // 实时快照比分页结果新：同 id 覆盖，新 id 插入
  for (const row of live.values()) byId.set(row.id, row)
  return [...byId.values()]
    .filter((row) => matchesQuery(row, query))
    .sort((a, b) => ((a.created_at ?? '') < (b.created_at ?? '') ? 1 : -1))
}

function formatTime(iso: string | null): string {
  if (iso === null || iso === '') return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const sameDay = date.toDateString() === new Date().toDateString()
  return sameDay ? date.toLocaleTimeString() : date.toLocaleString()
}

/* 字段读取一律 `?? null`：旧后端、旧快照可能整个缺字段（undefined），不能让它渲染成 "undefined" */

function tokenSummary(row: ModelInvocation): string {
  const input = row.input_tokens ?? null
  const output = row.output_tokens ?? null
  if (input === null && output === null) return '—'
  return `${formatTokens(input)} → ${formatTokens(output)}`
}

function canvasSummary(row: ModelInvocation): string {
  const canvasId = row.canvas_id ?? null
  const nodeId = row.node_id ?? null
  if (canvasId === null && nodeId === null) return '—'
  return `${canvasId === null ? '' : `#${canvasId}`}${nodeId === null ? '' : ` · ${nodeId}`}`
}

function optionsFor(values: Set<string>, current: string): PickerOption[] {
  const sorted = [...values].sort()
  if (current !== ALL && !values.has(current)) sorted.unshift(current)
  return [{ value: ALL, label: '全部' }, ...sorted.map((value) => ({ value, label: value }))]
}

/* ---- 检视器 ---- */

type Tab = 'input' | 'output' | 'raw' | 'timing'
const TABS: Array<[Tab, string]> = [
  ['input', 'Input'],
  ['output', 'Output'],
  ['raw', 'Raw'],
  ['timing', 'Timing'],
]

function JsonBlock({ value, empty }: { value: unknown; empty?: string }) {
  if (value === null || value === undefined) {
    return <p className="ledger-empty">{empty ?? '无'}</p>
  }
  return <pre className="ledger-pre">{JSON.stringify(value, null, 2)}</pre>
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (content === null || content === undefined) return ''
  return JSON.stringify(content, null, 2)
}

function MessageCard({ message }: { message: unknown }) {
  if (typeof message !== 'object' || message === null) {
    return <pre className="ledger-pre">{contentText(message)}</pre>
  }
  const { role, content, tool_calls: toolCalls, name } = message as Record<string, unknown>
  return (
    <article className="ledger-message">
      <span className="ledger-message-role">
        {typeof role === 'string' ? role : 'message'}
        {typeof name === 'string' ? ` · ${name}` : ''}
      </span>
      {contentText(content) !== '' && <pre className="ledger-pre">{contentText(content)}</pre>}
      {Array.isArray(toolCalls) && toolCalls.length > 0 && (
        <pre className="ledger-pre">{JSON.stringify(toolCalls, null, 2)}</pre>
      )}
    </article>
  )
}

function InputPane({
  header,
  row,
}: {
  header: Record<string, unknown> | null
  row: ModelInvocation
}) {
  if (header === null) {
    return (
      <div className="ledger-pane">
        <p className="ledger-empty">这次调用没有记录请求快照（旧记录或非 Chat 调用），以下是台账行的 request。</p>
        <JsonBlock value={row.request} />
      </div>
    )
  }
  const messages = Array.isArray(header.messages) ? header.messages : []
  const hasSystemMessage = messages.some(
    (item) => typeof item === 'object' && item !== null && (item as { role?: unknown }).role === 'system',
  )
  const system = Array.isArray(header.system) && !hasSystemMessage ? header.system : []
  const tools = Array.isArray(header.tools) ? header.tools : []
  const rest = Object.fromEntries(
    Object.entries(header).filter(
      ([key]) => !['messages', 'system', 'tools', 'elapsed_ms'].includes(key),
    ),
  )
  return (
    <div className="ledger-pane">
      {system.length > 0 && (
        <section>
          <h4>System</h4>
          {system.map((item, index) => (
            <pre className="ledger-pre" key={index}>
              {contentText(item)}
            </pre>
          ))}
        </section>
      )}
      <section>
        <h4>Messages · {messages.length}</h4>
        {messages.length === 0 && <p className="ledger-empty">没有消息</p>}
        {messages.map((item, index) => (
          <MessageCard key={index} message={item} />
        ))}
      </section>
      {tools.length > 0 && (
        <section>
          <h4>Tools · {tools.length}</h4>
          <JsonBlock value={tools} />
        </section>
      )}
      {Object.keys(rest).length > 0 && (
        <section>
          <h4>Request</h4>
          <JsonBlock value={rest} />
        </section>
      )}
    </div>
  )
}

function OutputPane({ events, row }: { events: ModelInvocationEvent[]; row: ModelInvocation }) {
  const output = useMemo(() => assembleOutput(events), [events])
  const hasChunks = output.text !== '' || output.reasoning !== '' || output.toolCalls.length > 0
  return (
    <div className="ledger-pane">
      {row.error_message != null && (
        <p className="ledger-error">
          {row.error_code ? `${row.error_code} · ` : ''}
          {row.error_type ? `${row.error_type}: ` : ''}
          {row.error_message}
        </p>
      )}
      {output.reasoning !== '' && (
        <details>
          <summary>推理 · {output.reasoning.length} 字符</summary>
          <pre className="ledger-pre">{output.reasoning}</pre>
        </details>
      )}
      {output.text !== '' && (
        <section>
          <h4>正文 · {output.text.length} 字符</h4>
          <pre className="ledger-pre">{output.text}</pre>
        </section>
      )}
      {output.toolCalls.length > 0 && (
        <section>
          <h4>工具调用 · {output.toolCalls.length}</h4>
          {output.toolCalls.map((call) => (
            <article className="ledger-message" key={call.id ?? `#${call.index}`}>
              <span className="ledger-message-role">
                {call.name ?? 'tool'}
                {call.id ? ` · ${call.id}` : ''}
              </span>
              <pre className="ledger-pre">{call.arguments}</pre>
            </article>
          ))}
        </section>
      )}
      {!hasChunks && row.status === 'running' && (
        <p className="ledger-empty">等待上游返回…</p>
      )}
      <details open={!hasChunks}>
        <summary>台账行 response</summary>
        <JsonBlock value={row.response} empty="还没有响应" />
      </details>
    </div>
  )
}

function eventSummary(event: ModelInvocationEvent): string {
  const d = event.data ?? {}
  switch (event.type) {
    case 'request.header': {
      const messages = Array.isArray(d.messages) ? d.messages.length : 0
      return `${messages} 条消息${Array.isArray(d.tools) ? ` · ${d.tools.length} 个工具` : ''}`
    }
    case 'chunk.text':
    case 'chunk.reasoning': {
      const text = typeof d.text === 'string' ? d.text : ''
      return text.length > 60 ? `${text.slice(0, 60)}…` : text
    }
    case 'chunk.tool_delta':
      return `${typeof d.name === 'string' ? d.name : ''} ${typeof d.arguments_delta === 'string' ? d.arguments_delta.slice(0, 40) : ''}`.trim()
    case 'chunk.usage': {
      const usage = (d.usage ?? {}) as Record<string, unknown>
      return `${formatTokens(typeof usage.input_tokens === 'number' ? usage.input_tokens : null)} → ${formatTokens(typeof usage.output_tokens === 'number' ? usage.output_tokens : null)}`
    }
    case 'finish':
      return typeof d.finish_reason === 'string' ? d.finish_reason : 'finish'
    case 'error':
      return `${typeof d.error_code === 'string' ? d.error_code : ''} ${typeof d.error_message === 'string' ? d.error_message : ''}`.trim()
    default:
      return ''
  }
}

function TimingPane({ events, row }: { events: ModelInvocationEvent[]; row: ModelInvocation }) {
  const timing = useMemo(() => foldInvocationTiming(events, row), [events, row])
  const span = Math.max(timing.totalMs ?? 0, timing.lastChunkMs ?? 0, 1)
  const stats: Array<[string, string]> = [
    ['首 token', formatMs(timing.ttftMs)],
    ['总耗时', formatMs(timing.totalMs)],
    [
      '解码速率',
      timing.decodeTokPerSec !== null
        ? `${timing.decodeTokPerSec} tok/s`
        : timing.decodeCharsPerSec !== null
          ? `${timing.decodeCharsPerSec} 字符/s`
          : '—',
    ],
    ['输出 tokens', formatTokens(timing.outputTokens)],
    ['分块', String(timing.chunkCount)],
    ['工具片段', timing.toolCalls > 0 ? `${timing.toolCalls} 次 · ${formatMs(timing.toolSpanMs)}` : '—'],
  ]
  return (
    <div className="ledger-pane">
      <div className="ledger-stats">
        {stats.map(([label, value]) => (
          <div className="ledger-stat" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      {timing.phases.length > 0 && (
        <div className="ledger-phases" aria-label="阶段">
          {timing.phases.map((phase) => (
            <i
              className={`ledger-phase ledger-phase-${phase.key}`}
              key={phase.key}
              title={`${phase.label} ${formatMs(phase.endMs - phase.startMs)}`}
              style={{
                left: `${(phase.startMs / span) * 100}%`,
                width: `${Math.max(((phase.endMs - phase.startMs) / span) * 100, 0.5)}%`,
              }}
            />
          ))}
        </div>
      )}
      {events.length === 0 ? (
        <p className="ledger-empty">这次调用没有逐步事件。</p>
      ) : (
        <ol className="ledger-timeline">
          {events.map((event) => {
            const elapsed = event.data?.elapsed_ms
            return (
              <li key={event.seq}>
                <code>{event.seq}</code>
                <span>{event.type}</span>
                <span className="ledger-num">
                  {typeof elapsed === 'number' ? formatMs(elapsed) : ''}
                </span>
                <em>{eventSummary(event)}</em>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}

function InvocationInspector({ row, onClose }: { row: ModelInvocation; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('input')
  const events = useQuery({
    queryKey: ['cfg-model-invocation-events', row.id],
    queryFn: () => apiConfig.modelInvocationEvents(row.id),
    // 还在跑的调用每 2s 拉一次事件增量；终态由父级收到 SSE 帧后失效一次
    refetchInterval: TERMINAL.has(row.status) ? false : 2_000,
  })
  const items = events.data?.items ?? []
  const snapshot = events.data?.invocation ?? row
  const header = useMemo(() => requestHeader(items), [items])
  return (
    <aside className="ledger-inspector">
      <div className="ledger-inspector-head">
        <div>
          <strong>{snapshot.model ?? snapshot.capability ?? snapshot.operation}</strong>
          <span>
            {snapshot.plugin_id}
            {snapshot.plugin_version ? `@${snapshot.plugin_version}` : ''} · {snapshot.operation}
            {(snapshot.attempt ?? 1) > 1 ? ` · 第 ${snapshot.attempt} 次尝试` : ''}
          </span>
          <code>{snapshot.id}</code>
        </div>
        <button className="btn btn-ghost-sm" onClick={onClose} aria-label="关闭检视器">
          <X aria-hidden />
        </button>
      </div>
      <div className="ledger-tabs" role="tablist">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? 'ledger-tab-active' : undefined}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {events.isError && <p className="ledger-error">事件读取失败：{events.error.message}</p>}
      {tab === 'input' && <InputPane header={header} row={snapshot} />}
      {tab === 'output' && <OutputPane events={items} row={snapshot} />}
      {tab === 'raw' && (
        <div className="ledger-pane">
          <JsonBlock value={{ invocation: snapshot, events: items }} />
        </div>
      )}
      {tab === 'timing' && <TimingPane events={items} row={snapshot} />}
    </aside>
  )
}

/* ---- 账本 ---- */

/** 调用量分布。能力这一行可点，点了就把筛选切过去；模型行只读（账本没有按模型的筛选项）。 */
function TallyRow({
  label,
  items,
  active,
  onPick,
}: {
  label: string
  items: LedgerTally[]
  active?: string
  onPick?: (key: string) => void
}) {
  if (items.length === 0) return null
  return (
    <div className="ledger-tally-row">
      <span className="ledger-tally-label">{label}</span>
      {items.map((item) =>
        onPick === undefined ? (
          <span className="ledger-tally" key={item.key}>
            {item.key}
            <em>{item.count}</em>
          </span>
        ) : (
          <button
            className={active === item.key ? 'ledger-tally ledger-tally-on' : 'ledger-tally'}
            key={item.key}
            onClick={() => onPick(active === item.key ? ALL : item.key)}
          >
            {item.key}
            <em>{item.count}</em>
          </button>
        ),
      )}
    </div>
  )
}

export function InvocationLedger() {
  const queryClient = useQueryClient()
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  /* 能力列要显示中文标签而不是 image-free 这种路由键（核心原则 6）。
     复用配置页那份绑定缓存，queryKey 一致所以不会多发一次请求。 */
  const capabilityLabels = useQuery({ queryKey: ['cfg-bindings'], queryFn: apiConfig.bindings })
  const capabilityText = useCallback(
    (capability: string | null, operation: string): string => {
      if (capability === null) return operation
      const hit = (capabilityLabels.data ?? []).find((b) => b.capability === capability)
      return hit?.label ?? capability
    },
    [capabilityLabels.data],
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [live, setLive] = useState<Map<string, ModelInvocation>>(() => new Map())
  const query = useMemo(() => toQuery(filters), [filters])

  const invocations = useInfiniteQuery({
    queryKey: ['cfg-model-invocations', query],
    queryFn: ({ pageParam }) => apiConfig.modelInvocations({ ...query, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    // SSE 是主路径；整页刷新只兜代理断流、睡眠唤醒
    refetchInterval: 60_000,
  })

  useEffect(
    () =>
      subscribeInvocationFrames((row) => {
        setLive((prev) => {
          const next = new Map(prev)
          next.delete(row.id)
          next.set(row.id, row)
          while (next.size > LIVE_LIMIT) {
            const oldest = next.keys().next().value
            if (oldest === undefined) break
            next.delete(oldest)
          }
          return next
        })
        if (TERMINAL.has(row.status)) {
          void queryClient.invalidateQueries({
            queryKey: ['cfg-model-invocation-events', row.id],
          })
        }
      }),
    [queryClient],
  )

  const paged = useMemo(
    () => invocations.data?.pages.flatMap((page) => page.items) ?? [],
    [invocations.data],
  )
  const rows = useMemo(() => mergeRows(paged, live, query), [paged, live, query])
  const selected = rows.find((row) => row.id === selectedId) ?? null

  // 筛选项的候选值跨筛选累积：选了某插件后仍能直接切到别的插件
  const seen = useRef({
    plugin_id: new Set<string>(),
    capability: new Set<string>(),
    source: new Set<string>(),
  })
  for (const row of rows) {
    seen.current.plugin_id.add(row.plugin_id)
    if (row.capability != null) seen.current.capability.add(row.capability)
    if (row.source != null) seen.current.source.add(row.source)
  }

  const update = (patch: Partial<Filters>) => setFilters((prev) => ({ ...prev, ...patch }))
  const filtering = (Object.keys(EMPTY_FILTERS) as Array<keyof Filters>).some(
    (key) => filters[key] !== EMPTY_FILTERS[key],
  )

  // 汇总只算眼前这批行：账本是分页 + SSE 的滚动窗口，另拉一份全量统计会和表里对不上
  const summary = useMemo(() => summarizeInvocations(rows), [rows])
  const figures: [string, string][] = [
    ['成功率', formatRate(summary.successRate)],
    ['P95 首 token', formatMs(summary.p95FirstTokenMs)],
    ['P95 总耗时', formatMs(summary.p95LatencyMs)],
    ['进行中', String(summary.running)],
    ['失败', String(summary.failed)],
  ]

  return (
    <section className="ledger">
      <div className="ledger-summary">
        <div className="ledger-figures">
          {figures.map(([label, value]) => (
            <div className="ledger-figure" key={label}>
              <b>{value}</b>
              <span>{label}</span>
            </div>
          ))}
          <div className="ledger-figure">
            <b>{summary.total}</b>
            <span>已载入</span>
          </div>
        </div>
        <div className="ledger-side">
          <span className="ledger-live">实时 SSE · 60s 兜底刷新</span>
          <button
            className="btn btn-outline btn-sm"
            disabled={invocations.isFetching}
            onClick={() => void invocations.refetch()}
          >
            <RefreshCw aria-hidden />
            {invocations.isFetching ? '刷新中…' : '刷新'}
          </button>
        </div>
      </div>

      {(summary.byCapability.length > 0 || summary.byModel.length > 0) && (
        <div className="ledger-tallies">
          <TallyRow
            label="能力"
            items={summary.byCapability}
            active={filters.capability}
            onPick={(capability) => update({ capability })}
          />
          <TallyRow label="模型" items={summary.byModel} />
        </div>
      )}

      <div className="ledger-filters">
        <label>
          <span>状态</span>
          <Picker
            size="sm"
            value={filters.status}
            onChange={(status) => update({ status })}
            options={[{ value: ALL, label: '全部' }, ...STATUSES.map((value) => ({ value, label: value }))]}
          />
        </label>
        <label>
          <span>插件</span>
          <Picker
            size="sm"
            value={filters.plugin_id}
            onChange={(plugin_id) => update({ plugin_id })}
            options={optionsFor(seen.current.plugin_id, filters.plugin_id)}
          />
        </label>
        <label>
          <span>能力</span>
          <Picker
            size="sm"
            value={filters.capability}
            onChange={(capability) => update({ capability })}
            options={optionsFor(seen.current.capability, filters.capability)}
          />
        </label>
        <label>
          <span>来源</span>
          <Picker
            size="sm"
            value={filters.source}
            onChange={(source) => update({ source })}
            options={optionsFor(seen.current.source, filters.source)}
          />
        </label>
        <label>
          <span>画布 id</span>
          <input
            inputMode="numeric"
            placeholder="全部"
            value={filters.canvas_id}
            onChange={(event) => update({ canvas_id: event.target.value })}
          />
        </label>
        <label>
          <span>任务 id</span>
          <input
            placeholder="全部"
            value={filters.task_id}
            onChange={(event) => update({ task_id: event.target.value })}
          />
        </label>
        {filtering && (
          <button className="btn btn-ghost-sm" onClick={() => setFilters(EMPTY_FILTERS)}>
            清除筛选
          </button>
        )}
      </div>

      {invocations.isError && (
        <p className="ledger-error">账本读取失败：{invocations.error.message}</p>
      )}

      <div className={selected === null ? 'ledger-layout' : 'ledger-layout ledger-layout-split'}>
        <div className="ledger-table-wrap">
          <table className="ledger-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>能力</th>
                <th>插件</th>
                <th>模型</th>
                <th>状态</th>
                <th className="ledger-num">耗时</th>
                <th className="ledger-num">首 token</th>
                <th className="ledger-num">tokens</th>
                <th>来源</th>
                <th>画布 · 节点</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className={row.id === selectedId ? 'ledger-row ledger-row-active' : 'ledger-row'}
                  onClick={() => setSelectedId(row.id === selectedId ? null : row.id)}
                >
                  <td className="ledger-dim">
                    <time dateTime={row.created_at ?? undefined}>{formatTime(row.created_at)}</time>
                  </td>
                  <td>{capabilityText(row.capability ?? null, row.operation)}</td>
                  <td>
                    <code>{row.plugin_id}</code>
                  </td>
                  <td className="ledger-model">{row.model ?? '—'}</td>
                  <td>
                    <span className={`ledger-status ledger-status-${row.status}`}>{row.status}</span>
                    {row.error_code != null && <small>{row.error_code}</small>}
                    {(row.attempt ?? 1) > 1 && <small>第 {row.attempt} 次</small>}
                  </td>
                  <td className="ledger-num">{formatMs(row.latency_ms ?? null)}</td>
                  <td className="ledger-num">{formatMs(row.first_token_ms ?? null)}</td>
                  <td className="ledger-num">{tokenSummary(row)}</td>
                  <td className="ledger-dim">{row.source ?? '—'}</td>
                  <td className="ledger-dim">{canvasSummary(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && !invocations.isPending && (
            <p className="ledger-empty">没有符合条件的模型调用。</p>
          )}
          {invocations.isPending && <p className="ledger-empty">读取账本…</p>}
          {invocations.hasNextPage && (
            <button
              className="btn btn-outline btn-sm ledger-more"
              disabled={invocations.isFetchingNextPage}
              onClick={() => void invocations.fetchNextPage()}
            >
              {invocations.isFetchingNextPage ? '加载中…' : '加载更早的调用'}
            </button>
          )}
        </div>
        {selected !== null && (
          <InvocationInspector row={selected} onClose={() => setSelectedId(null)} />
        )}
      </div>
    </section>
  )
}

export default InvocationLedger
