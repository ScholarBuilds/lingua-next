/* 多域管线视图（需求 12 FR-190、FR-212、FR-216）：任意域的单主体拓扑图。

   节点渲染复用视频管线的 StepNode，画布布局复用 dag.ts —— 换一个域只是换一份
   catalog 与 steps，这正是「新增域不改公共组件」（BR-35）要验证的事。 */

import { ReactFlow, Background, Controls } from '@xyflow/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import '@xyflow/react/dist/style.css'

import { Overlay, useEscapeClose } from '../../components/Overlay'
import { IconClose, IconHelp } from '../../components/icons'
import { VIconRefresh as IconRefresh } from '../video/icons'
import { apiPipeline } from '../../lib/api-pipeline'
import type { HelpSection, RerunScope } from '../../lib/api-pipeline'
import { buildGraph, formatDuration } from './dag'
import { ArtifactView } from './ArtifactView'
import { ConfirmPanel } from './ConfirmPanel'
import { StepNode, TunableField } from './PipelinePage'
import './pipeline.css'

const nodeTypes = { stepNode: StepNode }

function fmtArtifactBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`
}

interface SubjectPipelinePaneProps {
  domain: string
  subjectId: number
  /** 节点重跑回调：由所属域自己实现（场景本走 /scenario-decks/{id}/rerun）。
      config 是节点参数覆盖，形如 {cover: {prompt: '...'}}（模块 16 FR-413） */
  onRerun?: (
    step: string,
    scope: RerunScope,
    config?: Record<string, Record<string, unknown>>,
  ) => Promise<unknown>
  onClose?: () => void
}

export function SubjectPipelinePane({
  domain,
  subjectId,
  onRerun,
  onClose,
}: SubjectPipelinePaneProps) {
  const queryClient = useQueryClient()
  const [picked, setPicked] = useState<string | null>(null)
  const [showHelp, setShowHelp] = useState(false)
  // 节点参数表单。首版这里只有两个按钮、不收参数，于是「在节点里改提示词」
  // 在非视频域根本落不了地（模块 16 FR-413 记了这笔）
  const [tunables, setTunables] = useState<Record<string, unknown>>({})

  const domainsQuery = useQuery({
    queryKey: ['pipeline-domains'],
    queryFn: apiPipeline.domains,
    staleTime: 5 * 60_000,
  })
  const domainSpec = domainsQuery.data?.find((d) => d.domain === domain)

  /* 触发后的强制轮询窗口（FR-423）。
     只判「有节点在 running」是不够的：点下重跑的那一刻任务还在 arq 队列里排着，
     一个 running 都没有，轮询当场停掉——于是必须手动刷新才看得到它在跑。 */
  const [pollUntil, setPollUntil] = useState(0)
  const query = useQuery({
    queryKey: ['subject-pipeline', domain, subjectId],
    queryFn: () => apiPipeline.subject(domain, subjectId),
    refetchInterval: (q) => {
      const busy =
        q.state.data?.steps.some((x) => x.status === 'running' || x.status === 'pending') ?? false
      return busy || Date.now() < pollUntil ? 1500 : false
    },
    refetchIntervalInBackground: true,
  })
  const data = query.data
  // 当前选中的这个节点是不是正在跑——决定要不要给它开实时视图
  const runningNow = data?.steps.some((x) => x.name === picked && x.status === 'running') ?? false

  const artifactQuery = useQuery({
    queryKey: ['subject-artifact', domain, subjectId, picked],
    queryFn: () => apiPipeline.artifact(domain, subjectId, picked as string),
    enabled: picked !== null,
    retry: false,
    // 执行中没有产物（404 是常态），跑完要立刻出来，所以跟着一起轮询
    refetchInterval: () => (runningNow ? 2000 : false),
    refetchIntervalInBackground: true,
  })

  const rerun = useMutation({
    mutationFn: ({
      step,
      scope,
      config,
    }: {
      step: string
      scope: RerunScope
      config?: Record<string, Record<string, unknown>>
    }) => (onRerun ? onRerun(step, scope, config) : Promise.resolve(null)),
    onSuccess: () => {
      // 不再关掉节点：用户刚点了重跑，最想看的就是它跑起来的样子
      setTunables({})
      // 给 arq 派活留出余量；见到 running 后由 busy 判据接管
      setPollUntil(Date.now() + 60_000)
      void queryClient.invalidateQueries({ queryKey: ['subject-pipeline', domain, subjectId] })
    },
  })

  const pick = (name: string | null) => {
    setPicked(name)
    setTunables({})
  }

  const graph = useMemo(() => {
    if (data === undefined) return { nodes: [], edges: [] }
    const summaries = Object.fromEntries(
      data.artifacts.filter((a) => a.summary).map((a) => [a.step, a.summary as string]),
    )
    const withStale = data.steps.map((s) => ({ ...s, stale: data.stale.includes(s.name) }))
    return buildGraph(data.spec, withStale, {}, 0, summaries)
  }, [data])

  const pickedStep = data?.steps.find((s) => s.name === picked)
  const pickedSpec = data?.spec.find((s) => s.name === picked)
  // 表单预填用上次实际生效的 config，与视频域 RerunDialog 同一口径：
  // 用户看到的默认值就是这个节点上次真正跑的参数，而不是声明里的静态默认
  const lastConfig = (pickedStep?.config ?? {}) as Record<string, unknown>
  const nodeConfig =
    picked === null
      ? undefined
      : { [picked]: { ...lastConfig, ...tunables } }
  const pipelineHelp = domainSpec?.help ?? []
  // 下游节点数：按依赖闭包算，让"后面全部"这个说法有具体数字支撑
  const downstreamCount = useMemo(() => {
    if (data === undefined || picked === null) return 0
    const out = new Set<string>()
    let frontier = new Set([picked])
    while (frontier.size > 0) {
      const next = new Set<string>()
      for (const spec of data.spec) {
        if (out.has(spec.name) || spec.name === picked) continue
        if (spec.depends_on.some((d) => frontier.has(d))) {
          out.add(spec.name)
          next.add(spec.name)
        }
      }
      frontier = next
    }
    return out.size
  }, [data, picked])

  if (query.isPending) {
    return (
      <div className="state-block">
        <div className="spinner" />
        <div>加载管线…</div>
      </div>
    )
  }
  if (query.isError || data === undefined) {
    return <div className="state-block">管线加载失败：{query.error?.message}</div>
  }
  if (data.runs.length === 0) {
    return <div className="state-block">该主体还没有管线运行记录</div>
  }

  return (
    <div className="sp-wrap">
      <div className="sp-head">
        <b>{data.label}生成过程</b>
        <span className="sp-run">
          #{data.current_run_id} · {data.runs[0]?.status}
        </span>
        {data.interrupts.length > 0 && <span className="sp-wait">待确认</span>}
        <div style={{ flex: 1 }} />
        <button
          className={`btn btn-soft${showHelp ? ' active' : ''}`}
          onClick={() => setShowHelp((v) => !v)}
          title="这张图怎么读、每个节点在干什么"
        >
          <IconHelp />
          怎么用
        </button>
        {onClose && (
          <button className="icon-btn" onClick={onClose} title="关闭">
            <IconClose />
          </button>
        )}
      </div>

      <div className="sp-canvas">
        <ReactFlow
          nodes={graph.nodes}
          edges={graph.edges}
          nodeTypes={nodeTypes}
          fitView
          proOptions={{ hideAttribution: true }}
          onNodeClick={(_, node) => pick(node.id)}
          nodesDraggable={false}
          nodesConnectable={false}
        >
          <Background gap={16} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>

      {showHelp && (
        <HelpSheet spec={pipelineHelp} onClose={() => setShowHelp(false)} />
      )}

      {picked !== null && (
        /* 居中大弹窗（FR-422）：右侧窄抽屉塞不下「图 + 画了什么 + 提示词 +
           实时日志 + 重跑表单」，读和改都难受。三个域共用这一套 */
        <Overlay onClose={() => pick(null)} card="sp-modal">
          <div className="sp-drawer-head">
            <b>{pickedSpec?.label ?? picked}</b>
            <span className={`sp-chip${runningNow ? ' running' : ''}`}>
              {runningNow ? '执行中' : (pickedStep?.status ?? 'idle')}
            </span>
            {pickedStep?.duration_ms != null && (
              <span className="sp-dur">{formatDuration(pickedStep.duration_ms)}</span>
            )}
            {runningNow && pickedStep?.started_at && (
              <Elapsed since={pickedStep.started_at} />
            )}
            <div style={{ flex: 1 }} />
            <button className="icon-btn" onClick={() => pick(null)}>
              <IconClose />
            </button>
          </div>

          <div className="sp-modal-body">
          <div className="sp-col">
          {pickedSpec?.note && <div className="sp-note">{pickedSpec.note}</div>}
          {pickedSpec?.skip_when && (
            <div className="sp-skip">
              <b>什么时候会跳过</b>
              {pickedSpec.skip_when}
            </div>
          )}
          {/* 执行中就把后端能证明的东西摆出来：状态、已跑多久、日志。
              不编进度百分比——上游不给进度，匀速条是骗人（BR-110） */}
          {runningNow && (
            <div className="sp-running">
              <span className="sp-running-dot" />
              正在执行，日志会随进度追加
            </div>
          )}
          {pickedStep?.logs && <div className="sp-logs">{pickedStep.logs}</div>}
          {pickedStep?.error && <div className="form-err">{pickedStep.error}</div>}

          <div className="sp-sec-title">产物</div>
          {artifactQuery.isPending && <div className="sp-muted">读取中…</div>}
          {artifactQuery.isError && <div className="sp-muted">该节点没有可查看的产物</div>}
          {artifactQuery.data && (
            <>
              <div className="sp-meta">
                <span>{artifactQuery.data.summary ?? '—'}</span>
                {/* 这个字节数是**产物 JSON** 的大小，不是图片的。不写清楚，
                    「1994×789 · 1 张 / 3011 B」读起来就是「这张图只有 3KB」 */}
                <span title="这一步产物记录的大小，与图片文件无关">
                  产物 {fmtArtifactBytes(artifactQuery.data.bytes ?? 0)}
                </span>
                <span title={artifactQuery.data.sha}>sha {artifactQuery.data.sha.slice(0, 10)}</span>
                {artifactQuery.data.human_edited && <span className="sp-edited">人工改过</span>}
              </div>
              <ArtifactView
                step={picked}
                payload={artifactQuery.data.payload}
                context={`${domain === 'scenario_deck' ? '场景本' : '视频'} #${subjectId}`}
                onUsePrompt={(text) => setTunables((prev) => ({ ...prev, prompt: text }))}
              />
            </>
          )}

          </div>

          <div className="sp-col sp-col-ops">
          {picked === 'confirm' && data.interrupts.some((i) => i.step === 'confirm') && (
            <ConfirmPanel
              domain={domain}
              subjectId={subjectId}
              onDone={() => {
                setPicked(null)
                void queryClient.invalidateQueries({
                  queryKey: ['subject-pipeline', domain, subjectId],
                })
              }}
            />
          )}

          {onRerun && (
            <>
              <div className="sp-sec-title">重跑</div>
              {pickedSpec?.rerun_hint && (
                <div className="sp-muted">重跑影响：{pickedSpec.rerun_hint}</div>
              )}
              {(pickedSpec?.tunables.length ?? 0) > 0 && (
                <div className="sp-tunables">
                  {pickedSpec?.tunables.map((t) => (
                    <TunableField
                      key={t.name}
                      tunable={t}
                      value={tunables[t.name] ?? lastConfig[t.name] ?? t.default}
                      onChange={(v) => setTunables((prev) => ({ ...prev, [t.name]: v }))}
                    />
                  ))}
                </div>
              )}
              <div className="sp-actions">
                <button
                  className="btn btn-soft"
                  disabled={rerun.isPending}
                  title="后面的节点沿用旧产物，只重算这一步"
                  onClick={() =>
                    rerun.mutate({ step: picked, scope: 'single', config: nodeConfig })
                  }
                >
                  <IconRefresh />
                  只重算这一步
                </button>
                <button
                  className="btn btn-primary"
                  disabled={rerun.isPending}
                  title={`这一步以及后面 ${downstreamCount} 个节点全部重跑`}
                  onClick={() =>
                    rerun.mutate({ step: picked, scope: 'downstream', config: nodeConfig })
                  }
                >
                  <IconRefresh />
                  这一步及后面全部
                </button>
              </div>
              <div className="sp-muted">
                {downstreamCount > 0
                  ? `「后面全部」会重跑 ${downstreamCount} 个下游节点；范围外且已有产物的节点直接复用，不重算。`
                  : '这是最后一步，两个选项效果相同。'}
              </div>
              {rerun.isError && <div className="form-err">{rerun.error.message}</div>}
            </>
          )}
          </div>
          </div>
        </Overlay>
      )}
    </div>
  )
}

/** 执行中的已跑时长：每秒自增，只报事实不报预估 */
function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const secs = Math.max(0, Math.round((now - new Date(since).getTime()) / 1000))
  return <span className="sp-dur">已跑 {secs}s</span>
}

/** 帮助浮层（FR-251）：内容由域声明，新增域时不必回头改这里 */
function HelpSheet({ spec, onClose }: { spec: HelpSection[]; onClose: () => void }) {
  useEscapeClose(onClose)
  return (
    <aside className="sp-help">
      <div className="sp-help-head">
        <b>这张图怎么用</b>
        <div style={{ flex: 1 }} />
        <button className="icon-btn" onClick={onClose} title="关闭">
          <IconClose />
        </button>
      </div>
      <div className="sp-help-body">
        {spec.length === 0 && <div className="sp-muted">这个域还没写帮助内容</div>}
        {spec.map((section) => (
          <section key={section.title}>
            <b>{section.title}</b>
            {section.body && <p>{section.body}</p>}
            {section.bullets.length > 0 && (
              <ul>
                {section.bullets.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </aside>
  )
}
