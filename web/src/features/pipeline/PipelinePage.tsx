/* 全链路追踪页（需求 09 v6 FR-71~78 · v10.1 FR-133~136）：全屏 DAG 画布 + 浮层体系。

   交互语义抄 Dagster：页面是「一次运行」的视角（顶部切历次运行），点节点看它
   做了什么、用了什么；从任意节点按 single/downstream 重跑；重跑可改配置。
   v10.1 重排：画布满屏，问题清单/耗时分布/帮助/节点详情全部悬浮在画布上层，
   不再挤压布局；本次未执行的节点显示它最近一次真实执行（Dagster asset 视角的
   "latest materialization" 思路），灰不等于坏。 */

import '@xyflow/react/dist/style.css'

import { Background, Controls, ReactFlow } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { Handle, Position } from '@xyflow/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

import { Overlay } from '../../components/Overlay'
import { IconClose, IconSparkle } from '../../components/icons'
import { Picker } from '@/components/ui/picker'
import { apiPipeline } from '../../lib/api-pipeline'
import type {
  HealthIssue,
  StepEta,
  IssueChange,
  PipelineStepV1,
  RerunScope,
  StepHistoryEntry,
  StepSpec,
  SubtitleIssueV1,
  VideoPipeline,
} from '../../lib/api-pipeline'
import { useActivePipeline } from './ProgressCenter'
import { RepairPanel } from './RepairPanel'
import { buildGraph, formatDuration } from './dag'
import type { StepNodeData } from './dag'
import './pipeline.css'

const SCOPE_LABEL: Record<RerunScope, string> = {
  single: '仅此节点（下游沿用旧产物）',
  downstream: '此节点及全部下游（推荐）',
  failed: '所有失败节点及其下游',
}

const ISSUE_KIND_LABEL: Record<string, string> = {
  wrong_word: '疑似错词',
  bad_split: '断句不当',
  noise: '噪声残留',
  translation_mismatch: '译文不符',
}

type OverlayKind = 'issues' | 'timing' | 'help' | null

/** 问题 → 修复会话的开场白（FR-139）。
    体检问题与 AI 校验问题的 suggestion 语义不同：前者是「该重跑哪个节点」，
    后者才是「这句该改成什么」。套同一个模板会给代理喂出
    「句 #? 有问题…AI 建议：transcribe」这种读不通的话。 */
function repairFromIssue(issue: SubtitleIssueV1): { step: string | null; draft: string } {
  if (issue.source === 'health' || issue.sentence_id === null) {
    return {
      step: issue.suggestion,
      draft:
        `这条视频有个产出问题：${issue.detail}` +
        (issue.suggestion !== null ? `\n体检给出的修复节点是 ${issue.suggestion}。` : '') +
        '\n请先核实问题是否属实，再决定怎么修。',
    }
  }
  return {
    step: 'verify',
    draft:
      `句 #${issue.sentence_id} 有问题：${issue.detail}` +
      (issue.suggestion !== null ? `\nAI 建议改为：${issue.suggestion}` : '') +
      '\n请核实并修复。',
  }
}

/** 单条问题的处理结果（FR-137）：行不消失，原地演进 */
type HandledResult =
  | { phase: 'writing' }
  | { phase: 'done'; applied: boolean; change: IssueChange | null; refilling?: boolean }
  | { phase: 'failed'; error: string }

export function PipelinePage() {
  const { videoId = '' } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  // 管线中心按 run 行点入时带 ?run=，直达该次运行（FR-83）
  const initialRun = params.get('run')
  const [runId, setRunId] = useState<number | undefined>(
    initialRun !== null ? Number(initialRun) : undefined,
  )
  const [picked, setPicked] = useState<string | null>(params.get('node'))
  const [rerunStep, setRerunStep] = useState<StepSpec | null>(null)
  // ?panel=issues 从管线中心的问题角标点进来时直开问题清单（FR-138）
  const [overlay, setOverlay] = useState<OverlayKind>(
    params.get('panel') === 'issues' ? 'issues' : null,
  )
  // AI 修复面板（FR-85）：open + 锚定节点 + 可选预填草稿（从问题清单进来）
  const [repair, setRepair] = useState<{ step: string | null; draft?: string } | null>(null)
  // 每条问题的处理状态机（FR-137）：写回中 → 已写回(diff) / 失败(可重试)。
  // 行留在原地展示结果而不是消失——"采纳了不知道啥情况"就是旧版行消失造成的
  const [handled, setHandled] = useState<Record<number, HandledResult>>({})
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null)
  /* 批量结果汇总（FR-137）：本地单条写回仅 ~16ms，20 条 320ms 跑完，
     进度条一闪而过等于没有——完成后留一条常驻汇总，才叫"知道发生了什么" */
  const [batchResult, setBatchResult] = useState<{
    ok: number
    skipped: number
    failed: number
  } | null>(null)
  // 从节点历史跳转运行时保住选中节点（默认切运行要清空，避免看串数据）
  const keepPickedRef = useRef(false)

  const active = useActivePipeline()
  const running = active.items.some(
    (i) => i.video_id === Number(videoId) && i.current_step !== null,
  )

  const query = useQuery({
    queryKey: ['pipeline', videoId, runId],
    queryFn: () => apiPipeline.videoPipeline(videoId, runId),
    // 有节点在跑就跟着 SSE 的节奏刷新，跑完自然停
    refetchInterval: running ? 2000 : false,
  })

  const data = query.data
  const graph = useMemo(
    () =>
      data
        ? buildGraph(data.catalog, data.steps, data.history, data.video.progress)
        : { nodes: [], edges: [] },
    [data],
  )
  const stepByName = useMemo(
    () => new Map((data?.steps ?? []).map((s) => [s.name, s])),
    [data],
  )
  const specByName = useMemo(
    () => new Map((data?.catalog ?? []).map((s) => [s.name, s])),
    [data],
  )

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['pipeline', videoId] })
    void qc.invalidateQueries({ queryKey: ['videos'] })
    // 采纳会改句子文本：学习页的 cues/sentences 缓存一并失效
    void qc.invalidateQueries({
      predicate: (q) => ['cues', 'sentences', 'video'].includes(String(q.queryKey[0])),
    })
  }

  const rerun = useMutation({
    mutationFn: (body: {
      from_step?: string | null
      scope: RerunScope
      config?: Record<string, Record<string, unknown>>
    }) => apiPipeline.rerun({ video_id: Number(videoId), ...body }),
    onSuccess: (d) => {
      toast.success(`已入队重跑：${d.steps.join(' → ')}`)
      setRerunStep(null)
      setPicked(null)
      invalidate()
    },
    onError: (e: Error) => toast.error(e.message || '重跑失败'),
  })

  const verify = useMutation({
    mutationFn: () => apiPipeline.verify(Number(videoId), true),
    onSuccess: () => {
      toast.success('已入队体检与 AI 校验')
      invalidate()
    },
    onError: (e: Error) => toast.error(e.message || '体检失败'),
  })

  /** 一键全部修复（FR-144）：能自动执行的批量落地，剩下的一次性交给代理 */
  const autofix = useMutation({
    mutationFn: () => apiPipeline.autofix(Number(videoId)),
    onSuccess: (d) => {
      const parts = [`自动修复 ${d.auto_applied} 条`]
      if (d.handed_to_agent > 0) parts.push(`${d.handed_to_agent} 条交给 AI 处理中`)
      if (d.queued_translate) parts.push('正在补译')
      toast.success(parts.join(' · '))
      invalidate()
      if (d.session_id !== null) {
        // 代理会话开在浮层里，工具动作与结论实时可见
        setOverlay(null)
        setRepair({ step: 'verify' })
      }
    },
    onError: (e: Error) => toast.error(e.message || '一键修复失败'),
  })

  const dismissIssue = useMutation({
    mutationFn: (id: number) => apiPipeline.patchIssue(id, 'dismissed'),
    onSuccess: () => {
      toast.success('已忽略')
      invalidate()
    },
    onError: (e: Error) => toast.error(e.message || '操作失败'),
  })

  /** 采纳单条：行内状态机驱动，成功原地显示 diff（FR-137） */
  const acceptOne = async (issue: SubtitleIssueV1): Promise<boolean> => {
    setHandled((prev) => ({ ...prev, [issue.id]: { phase: 'writing' } }))
    try {
      const d = await apiPipeline.patchIssue(issue.id, 'accepted')
      setHandled((prev) => ({
        ...prev,
        [issue.id]: {
          phase: 'done',
          applied: d.applied,
          change: d.change,
          refilling: d.queued_translate,
        },
      }))
      return d.applied
    } catch (e) {
      setHandled((prev) => ({
        ...prev,
        [issue.id]: { phase: 'failed', error: (e as Error).message || '写回失败' },
      }))
      return false
    }
  }

  /** 一键全部采纳（FR-137）：逐条串行写回，头部进度条实时走 */
  const acceptAll = async (targets: SubtitleIssueV1[]) => {
    setBatch({ done: 0, total: targets.length })
    setBatchResult(null)
    let ok = 0
    let failed = 0
    for (const [idx, t] of targets.entries()) {
      try {
        if (await acceptOne(t)) ok += 1
        else failed += 0 // applied=false 归入"未写回"，下面按差值算
      } catch {
        failed += 1
      }
      setBatch({ done: idx + 1, total: targets.length })
    }
    setBatch(null)
    setBatchResult({ ok, skipped: targets.length - ok - failed, failed })
    invalidate()
    toast.success(`批量采纳完成：${ok}/${targets.length} 条已写回字幕`)
  }

  // 切换运行记录时收起详情，免得看着上一次运行的节点数据；两个例外：
  // ① 从节点抽屉的历史执行跳过来的——用户就是想看同一节点在那次运行的样子
  // ② runId 没真的变过——effect 挂载时也会跑一次，会把 ?node= 深链带进来的
  //    选中直接擦掉。用「记住上一次的 runId」判断而不是「是否首帧」，
  //    因为 dev 的 StrictMode 会双次挂载，首帧守卫第二次就失效了
  const lastRunRef = useRef<number | undefined>(runId)
  useEffect(() => {
    if (lastRunRef.current === runId) return
    lastRunRef.current = runId
    if (keepPickedRef.current) {
      keepPickedRef.current = false
      return
    }
    setPicked(null)
  }, [runId])

  // 节点选中进 URL（?node=）：刷新/分享后直达同一节点
  useEffect(() => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (picked !== null) next.set('node', picked)
        else next.delete('node')
        return next
      },
      { replace: true },
    )
  }, [picked, setParams])

  // Esc 逐层关闭。节点弹窗与修复会话都已加入 components/Overlay 的浮层栈
  // （栈只关最上面一层，修复会话另有「先失焦再关闭」的两段式），
  // 这里只管尚未入栈的重跑弹窗与问题浮层，并显式避开那两层免得重复触发。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || repair !== null || picked !== null) return
      if (rerunStep !== null) setRerunStep(null)
      else if (overlay !== null) setOverlay(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [repair, rerunStep, picked, overlay])

  if (query.isPending) return <div className="panel-hint">载入链路…</div>
  if (query.isError || data === undefined) {
    return <div className="panel-error">链路读取失败：{(query.error as Error)?.message}</div>
  }

  const gate = data.health.gate
  const openIssues = data.issues.filter((i) => i.state === 'open')
  const badge = openIssues.length + data.health.issues.length

  return (
    <div className="content pl-content">
      <div className="pl-full">
        <header className="pl-head">
          <button className="btn-ghost-sm" onClick={() => navigate(`/video/${videoId}`)}>
            ← 返回学习页
          </button>
          <h2 title={data.video.title}>{data.video.title_zh ?? data.video.title}</h2>
          <span className={`pl-gate ${gate}`}>
            {gate === 'ready' ? '产出达标' : gate === 'degraded' ? '产出不达标' : '失败'}
          </span>
          <div style={{ flex: 1 }} />
          {data.runs.length > 1 && (
            <Picker
              size="sm"
              className="input pl-runsel"
              value={String(runId ?? data.run?.id ?? '')}
              onChange={(v) => setRunId(Number(v))}
              options={data.runs.map((r) => ({
                value: String(r.id),
                label: `#${r.id} ${r.kind}${r.from_step !== null ? ` · 自 ${r.from_step}` : ' · 全量'}`,
                hint: r.status,
              }))}
            />
          )}
          <button
            className="btn-ghost-sm"
            disabled={verify.isPending}
            onClick={() => verify.mutate()}
          >
            {verify.isPending ? '排队中…' : '重新体检'}
          </button>
          <button
            className="btn btn-sm"
            disabled={rerun.isPending}
            onClick={() => rerun.mutate({ scope: 'failed' })}
          >
            从失败处重跑
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => setRepair({ step: picked })}
          >
            <IconSparkle />
            AI 修复
          </button>
        </header>

        <div className="pl-canvas">
          <ReactFlow
            nodes={graph.nodes}
            edges={graph.edges}
            nodeTypes={{ stepNode: StepNode }}
            onNodeClick={(_e, node) => setPicked(node.id)}
            onPaneClick={() => setPicked(null)}
            fitView
            fitViewOptions={{ padding: 0.12, minZoom: 0.55, maxZoom: 1.05 }}
            proOptions={{ hideAttribution: true }}
            nodesDraggable={false}
            nodesConnectable={false}
            edgesFocusable={false}
          >
            <Background gap={18} size={1} />
            <Controls showInteractive={false} position="bottom-right" />
          </ReactFlow>

          {/* 画布右上：浮动入口（FR-133），问题数即角标 */}
          <div className="pl-fabs">
            <button
              className={`pl-fab${overlay === 'issues' ? ' on' : ''}${badge > 0 ? ' warn' : ''}`}
              title="问题清单：体检问题 + AI 校验问题"
              onClick={() => setOverlay((o) => (o === 'issues' ? null : 'issues'))}
            >
              问题
              {badge > 0 && <i className="pl-fab-badge">{badge}</i>}
            </button>
            <button
              className={`pl-fab${overlay === 'timing' ? ' on' : ''}`}
              title="本次运行的耗时分布"
              onClick={() => setOverlay((o) => (o === 'timing' ? null : 'timing'))}
            >
              耗时
            </button>
            <button
              className={`pl-fab${overlay === 'help' ? ' on' : ''}`}
              title="这张图怎么读 / 怎么用"
              onClick={() => setOverlay((o) => (o === 'help' ? null : 'help'))}
            >
              帮助
            </button>
          </div>

          {/* 画布左下：状态图例（FR-135），解释"灰的不是坏了" */}
          <div className="pl-legend">
            <span><i className="dot ok" />成功</span>
            <span><i className="dot run" />进行中</span>
            <span><i className="dot err" />失败</span>
            <span><i className="dot dim" />本次未执行</span>
            <span><i className="dot stale" />陈旧产物</span>
          </div>

          {overlay === 'issues' && (
            <>
              <div className="pl-scrim" onClick={() => batch === null && setOverlay(null)} />
              <IssuesOverlay
                health={data.health.issues}
                issues={data.issues}
                handled={handled}
                batch={batch}
                batchResult={batchResult}
                onClearResult={() => setBatchResult(null)}
                onAccept={(issue) => void acceptOne(issue).then(() => invalidate())}
                onAcceptAll={(targets) => void acceptAll(targets)}
                onAutofix={() => autofix.mutate()}
                autofixPending={autofix.isPending}
                onDismiss={(id) => dismissIssue.mutate(id)}
                onFixStep={(step) => rerun.mutate({ from_step: step, scope: 'downstream' })}
                onRepairIssue={(issue) => setRepair(repairFromIssue(issue))}
                specLabel={(name) => specByName.get(name)?.label ?? name}
                onClose={() => batch === null && setOverlay(null)}
              />
            </>
          )}

          {overlay === 'timing' && (
            <div className="pl-sheet-bottom">
              <div className="panel-head">
                <h3>耗时分布 · 本次运行</h3>
                <div style={{ flex: 1 }} />
                <button className="icon-btn" onClick={() => setOverlay(null)}>
                  <IconClose />
                </button>
              </div>
              <Gantt steps={data.steps} />
            </div>
          )}

          {overlay === 'help' && <HelpOverlay data={data} onClose={() => setOverlay(null)} />}

          {repair !== null ? (
            <div className="pl-sheet pl-sheet-repair">
              <RepairPanel
                videoId={Number(videoId)}
                stepName={repair.step}
                stepLabel={
                  repair.step !== null ? (specByName.get(repair.step)?.label ?? null) : null
                }
                initialDraft={repair.draft}
                autoSend={repair.draft !== undefined}
                onClose={() => setRepair(null)}
                onDataChanged={invalidate}
              />
            </div>
          ) : (
            picked !== null && (
              <NodeDrawer
                step={stepByName.get(picked)}
                spec={specByName.get(picked)}
                history={data.history[picked] ?? []}
                eta={data.eta[picked]}
                videoProgress={data.video.progress}
                currentRunId={data.run?.id ?? null}
                videoId={Number(videoId)}
                onClose={() => setPicked(null)}
                onRerun={(spec) => setRerunStep(spec)}
                onRepair={(name) => setRepair({ step: name })}
                onOpenIssues={() => setOverlay('issues')}
                onSwitchRun={(id) => {
                  keepPickedRef.current = true
                  setRunId(id)
                }}
              />
            )
          )}
        </div>

        <RerunDialog
          spec={rerunStep}
          step={rerunStep ? stepByName.get(rerunStep.name) : undefined}
          pending={rerun.isPending}
          onClose={() => setRerunStep(null)}
          onSubmit={(scope, config) =>
            rerun.mutate({ from_step: rerunStep?.name, scope, config })
          }
        />
      </div>
    </div>
  )
}

/** 节点渲染：视频管线与场景本管线共用，保证两处视觉语言一致 */
export function StepNode({ data }: NodeProps) {
  const d = data as StepNodeData
  const idleKnown = (d.status === 'skipped' || d.status === 'idle') && d.lastExec !== null
  return (
    <div className={`dag-node ${d.status}${d.stale ? ' stale' : ''}${idleKnown ? ' known' : ''}`}>
      <Handle type="target" position={Position.Top} />
      <div className="dag-node-top">
        <span className="dag-dot" />
        <b>{d.label}</b>
        {d.duration_ms !== null && <span className="dag-dur">{formatDuration(d.duration_ms)}</span>}
      </div>
      <div className="dag-node-sum">
        {d.summary ||
          (idleKnown
            ? `本次未跑 · 上次 #${d.lastExec!.run_id} ${d.lastExec!.status === 'failed' ? '失败' : formatDuration(d.lastExec!.duration_ms)}`
            : '—')}
      </div>
      {d.stale && <span className="dag-stale">陈旧</span>}
      {d.status === 'running' && d.livePct !== null && (
        <span className="dag-node-bar">
          <i style={{ width: `${Math.max(3, d.livePct)}%` }} />
        </span>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

const STATUS_TEXT: Record<string, string> = {
  success: '成功',
  failed: '失败',
  running: '进行中',
  skipped: '本次未执行',
  pending: '待执行',
  idle: '从未执行',
}

/** 执行中节点的实时进度（FR-148）：秒表 + 进度条 + 预计剩余。

    两个来源，优先真实的：
    - **真实百分比**：download 按字节、transcribe 按音频段实时回写整体进度，
      按节点的 progress_span 换算出"这一步跑到哪了"
    - **历史推算**：没有细粒度上报的节点（标点/对齐/翻译等），用
      已用时 ÷ 历史中位数 估算

    不撒谎的三条：① 历史样本 < 2 次不给 ETA，只显示秒表；② 超出预估不继续爬也不
    倒数成负数，切成不确定态并明说"已超出预估"；③ 推算出来的进度条画成条纹，
    与真实进度视觉可区分。 */
function RunningProgress({
  startedAt,
  span,
  videoProgress,
  eta,
}: {
  startedAt: string
  span: [number, number] | undefined
  videoProgress: number
  eta: StepEta | undefined
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const elapsed = Math.max(0, now - new Date(startedAt).getTime())
  // 真实进度：整体进度落在本节点区间内才算数（区间为零宽的节点没有细粒度上报）
  const width = span ? span[1] - span[0] : 0
  const realPct =
    span !== undefined && width > 0 && videoProgress >= span[0]
      ? Math.min(100, ((videoProgress - span[0]) / width) * 100)
      : null

  // 历史推算：样本太少不给预估，宁可只显示秒表也不编一个数
  const reliable = eta !== undefined && eta.samples >= 2
  const estPct = reliable ? Math.min(100, (elapsed / eta.p50_ms) * 100) : null
  const overrun = reliable && elapsed > eta.p50_ms

  const pct = realPct ?? estPct
  const estimated = realPct === null
  const remain = reliable && !overrun ? eta.p50_ms - elapsed : null

  return (
    <div className="pl-live">
      <div className="pl-live-top">
        <span className="pl-live-elapsed">{formatDuration(elapsed)}</span>
        {remain !== null && <span className="pl-live-eta">约剩 {formatDuration(remain)}</span>}
        {overrun && <span className="pl-live-over">已超出预估，仍在执行</span>}
        {!reliable && realPct === null && (
          <span className="pl-live-note">
            {eta === undefined ? '首次执行，无历史可参考' : '历史样本不足，暂不预估'}
          </span>
        )}
      </div>
      <div className={`pl-live-bar${pct === null || overrun ? ' indet' : ''}`}>
        <i
          className={estimated ? 'est' : undefined}
          style={pct !== null && !overrun ? { width: `${Math.max(2, pct)}%` } : undefined}
        />
      </div>
      {pct !== null && !overrun && (
        <div className="pl-live-cap">
          {estimated
            ? `按历史中位数推算（${eta!.samples} 次样本：${formatDuration(eta!.min_ms)}–${formatDuration(eta!.max_ms)}）`
            : `实时进度 ${Math.round(pct)}%`}
        </div>
      )}
    </div>
  )
}

/** 节点抽屉（FR-136）：悬浮在画布右侧——时间线 / 指标 / 配置 / 日志 / 历史执行 / 动作 */
function NodeDrawer({
  step,
  spec,
  history,
  eta,
  videoProgress,
  currentRunId,
  videoId,
  onClose,
  onRerun,
  onRepair,
  onOpenIssues,
  onSwitchRun,
}: {
  step: PipelineStepV1 | undefined
  spec: StepSpec | undefined
  history: StepHistoryEntry[]
  eta: StepEta | undefined
  videoProgress: number
  currentRunId: number | null
  videoId: number
  onClose: () => void
  onRerun: (spec: StepSpec) => void
  onRepair: (stepName: string) => void
  onOpenIssues: () => void
  onSwitchRun: (runId: number) => void
}) {
  const navigate = useNavigate()
  if (spec === undefined) return null
  const metrics = Object.entries(step?.metrics ?? {})
  const config = Object.entries(step?.config ?? {})
  const executed = history.filter((h) => h.status === 'success' || h.status === 'failed')
  const notRunThisTime = step === undefined || step.status === 'skipped'
  // 有量化产出的节点提供「查看产物」下钻（去学习页看句子/词组的实际效果）
  const hasArtifacts = ['sentences', 'units', 'translated', 'cues'].some(
    (k) => step?.metrics?.[k] !== undefined,
  )

  const copyJson = () => {
    void navigator.clipboard
      .writeText(JSON.stringify({ metrics: step?.metrics, config: step?.config }, null, 2))
      .then(() => toast.success('指标与配置已复制为 JSON'))
  }

  return (
    /* 居中大弹窗（FR-422）：与场景本、生图三个域统一一套。
       400px 侧栏读不动也改不动——日志、指标表、历史执行挤成一条 */
    <Overlay onClose={onClose} card="pl-node-modal">
      <div className="panel-head">
        <h3>{spec.label}</h3>
        <span className={`pl-badge ${step?.status ?? 'idle'}`}>
          {STATUS_TEXT[step?.status ?? 'idle']}
        </span>
        <div style={{ flex: 1 }} />
        <button className="icon-btn" title="关闭（Esc）" onClick={onClose}>
          <IconClose />
        </button>
      </div>
      <div className="pl-node-body">
      <div className="pl-node-col">
        {spec.note !== '' && <p className="pl-note">{spec.note}</p>}

        {notRunThisTime && executed.length > 0 && (
          <div className="pl-lastrun">
            本次运行未执行该节点（灰显 ≠ 出错）。
            <button className="btn-ghost-sm" onClick={() => onSwitchRun(executed[0].run_id)}>
              查看最近一次执行 #{executed[0].run_id}
            </button>
          </div>
        )}

        {step?.error != null && step.error !== '' && (
          <div className="panel-error pl-err">
            {step.error_kind !== null && <b>[{step.error_kind}] </b>}
            {step.error}
          </div>
        )}

        {step?.status === 'running' && step.started_at != null && (
          <RunningProgress
            startedAt={step.started_at}
            span={spec.progress_span}
            videoProgress={videoProgress}
            eta={eta}
          />
        )}

        {step?.started_at != null && (
          <div className="pl-sec">
            <div className="wc-label">时间线</div>
            <table className="pl-kv">
              <tbody>
                <tr>
                  <td>开始</td>
                  <td>{new Date(step.started_at).toLocaleString()}</td>
                </tr>
                {step.finished_at !== null && (
                  <tr>
                    <td>结束</td>
                    <td>{new Date(step.finished_at).toLocaleString()}</td>
                  </tr>
                )}
                <tr>
                  <td>耗时</td>
                  <td>{formatDuration(step.duration_ms)}</td>
                </tr>
                {step.attempt > 1 && (
                  <tr>
                    <td>重试</td>
                    <td>第 {step.attempt} 次尝试</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        <div className="pl-sec">
          <div className="wc-label">
            做了什么
            {metrics.length > 0 && (
              <button className="btn-ghost-sm re" onClick={copyJson}>
                复制 JSON
              </button>
            )}
          </div>
          {metrics.length > 0 ? (
            <table className="pl-kv">
              <tbody>
                {metrics.map(([k, v]) => (
                  <tr
                    key={k}
                    className={k === 'issues' || k === 'ai_issues' ? 'pl-kv-link' : undefined}
                    onClick={
                      k === 'issues' || k === 'ai_issues' ? () => onOpenIssues() : undefined
                    }
                    title={k === 'issues' || k === 'ai_issues' ? '点击查看问题清单' : undefined}
                  >
                    <td>{k}</td>
                    <td>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="wc-muted">本次没有产出记录</div>
          )}
          {hasArtifacts && (
            <button
              className="btn-ghost-sm pl-artifact"
              onClick={() => navigate(`/video/${videoId}`)}
            >
              去学习页看产物（字幕 / 译文 / 词组）→
            </button>
          )}
        </div>

        <div className="pl-sec">
          <div className="wc-label">用了什么</div>
          {config.length > 0 || step?.code_version != null ? (
            <table className="pl-kv">
              <tbody>
                {config.map(([k, v]) => (
                  <tr key={k}>
                    <td>{k}</td>
                    <td>{String(v)}</td>
                  </tr>
                ))}
                {step?.code_version != null && (
                  <tr>
                    <td>管线版本</td>
                    <td>
                      {step.code_version}
                      {step.stale && <span className="chip warn">陈旧</span>}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          ) : (
            <div className="wc-muted">无参数记录</div>
          )}
        </div>

        {step?.logs != null && step.logs !== '' && (
          <details className="pl-sec" open={step.status === 'failed'}>
            <summary className="wc-label pl-fold">执行日志</summary>
            <pre className="pl-logs">{step.logs}</pre>
          </details>
        )}

      </div>

      <div className="pl-node-col pl-node-ops">
        {executed.length > 0 && (
          <div className="pl-sec">
            <div className="wc-label">历史执行 · {executed.length} 次</div>
            <div className="pl-hist">
              {executed.map((h) => (
                <button
                  key={h.run_id}
                  className={`pl-hist-row${h.run_id === currentRunId ? ' cur' : ''}`}
                  title="切到这次运行查看当时的产出与参数"
                  onClick={() => onSwitchRun(h.run_id)}
                >
                  <span className={`pl-badge ${h.status}`}>{STATUS_TEXT[h.status]}</span>
                  <b>#{h.run_id}</b>
                  <span className="pl-hist-dur">{formatDuration(h.duration_ms)}</span>
                  <span className="pl-hist-time">
                    {h.started_at !== null ? new Date(h.started_at).toLocaleString() : ''}
                  </span>
                  {h.stale && <span className="chip warn">陈旧</span>}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="pl-detail-act">
          <button className="btn btn-primary" onClick={() => onRerun(spec)}>
            重跑这一步…
          </button>
          <button
            className="btn btn-soft"
            title="用自然语言描述这一步的问题，AI 自动排查修复"
            onClick={() => onRepair(spec.name)}
          >
            向 AI 反馈问题
          </button>
        </div>
      </div>
      </div>
    </Overlay>
  )
}

/** 问题清单（FR-134 · v10.2 FR-137）：居中大模态。
    13 条问题挤在 400px 侧栏读不动——改居中两栏，左列问题右列建议对照。
    每行是个状态机：待处理 → 写回中 → 已写回(diff) / 失败(可重试)，行不消失，
    "采纳了不知道啥情况"就是旧版行消失造成的。 */
function IssuesOverlay({
  health,
  issues,
  handled,
  batch,
  batchResult,
  onClearResult,
  onAccept,
  onAcceptAll,
  onAutofix,
  autofixPending,
  onDismiss,
  onFixStep,
  onRepairIssue,
  specLabel,
  onClose,
}: {
  health: HealthIssue[]
  issues: SubtitleIssueV1[]
  handled: Record<number, HandledResult>
  batch: { done: number; total: number } | null
  batchResult: { ok: number; skipped: number; failed: number } | null
  onClearResult: () => void
  onAccept: (issue: SubtitleIssueV1) => void
  onAcceptAll: (targets: SubtitleIssueV1[]) => void
  onAutofix: () => void
  autofixPending: boolean
  onDismiss: (id: number) => void
  onFixStep: (step: string) => void
  onRepairIssue: (issue: SubtitleIssueV1) => void
  specLabel: (name: string) => string
  onClose: () => void
}) {
  // 本轮已处理过的也留在列表里（原地显示结果），只有历史遗留的已处理才收进折叠区
  const all = issues.filter((i) => i.state === 'open' || handled[i.id] !== undefined)
  // 库里的问题有两种来源：AI 逐句裁判 与 体检落库。混在"AI 校验问题"下会误导
  const live = all.filter((i) => i.source === 'ai')
  const healthRows = all.filter((i) => i.source !== 'ai')
  // 实时体检报告与落库的体检问题常是同一件事（同一句 message/detail），
  // 两边都渲染就会看到重复行；落库那条带操作按钮，优先保留它
  const healthTexts = new Set(healthRows.map((i) => i.detail.trim()))
  const liveHealth = health.filter((h) => !healthTexts.has(h.message.trim()))
  const archived = issues.filter((i) => i.state !== 'open' && handled[i.id] === undefined)
  const autoApplicable = live.filter(
    (i) => i.state === 'open' && i.suggestion !== null && i.sentence_id !== null,
  )
  const pending =
    liveHealth.length + all.filter((i) => i.state === 'open').length

  return (
    <aside className="pl-modal" role="dialog" aria-modal="true">
      <div className="panel-head pl-modal-head">
        <h3>问题清单</h3>
        <span className="chip">{pending} 待处理</span>
        <div style={{ flex: 1 }} />
        {autoApplicable.length > 0 && (
          <button
            className="btn btn-soft btn-sm"
            disabled={batch !== null || autofixPending}
            title="只把「能直接写回字幕」的那些逐条应用，结果在下方各行可见"
            onClick={() => onAcceptAll(autoApplicable)}
          >
            {batch !== null
              ? `写回中 ${batch.done}/${batch.total}`
              : `采纳可直接写回的（${autoApplicable.length}）`}
          </button>
        )}
        {pending > 0 && (
          <button
            className="btn btn-primary btn-sm"
            disabled={batch !== null || autofixPending}
            title="能自动执行的立即落地，剩下的一次性交给 AI 自主处理，不用一条条对话"
            onClick={onAutofix}
          >
            <IconSparkle />
            {autofixPending ? '处理中…' : `一键全部修复（${pending}）`}
          </button>
        )}
        <button
          className="icon-btn"
          title="关闭（Esc）"
          disabled={batch !== null}
          onClick={onClose}
        >
          <IconClose />
        </button>
      </div>

      {batch !== null && (
        <div className="pl-batch">
          <div className="pl-batch-bar">
            <i style={{ width: `${(batch.done / Math.max(1, batch.total)) * 100}%` }} />
          </div>
          <span>
            正在逐条写回字幕 {batch.done}/{batch.total}，完成前请勿关闭
          </span>
        </div>
      )}

      {batch === null && batchResult !== null && (
        <div className="pl-batch result">
          <span className="pl-batch-sum">
            <b>批量写回完成</b>
            <span className="ok">{batchResult.ok} 条已写回字幕</span>
            {batchResult.skipped > 0 && (
              <span className="warn">{batchResult.skipped} 条无法自动写回</span>
            )}
            {batchResult.failed > 0 && (
              <span className="err">{batchResult.failed} 条失败</span>
            )}
          </span>
          <span className="pl-batch-note">
            每条的改动前后见下方各行；写回不可撤销，需回改请用「AI 修复」
          </span>
          <button className="icon-btn" title="收起" onClick={onClearResult}>
            <IconClose />
          </button>
        </div>
      )}

      <div className="panel-body pl-modal-body">
        {pending === 0 && all.length === 0 && (
          <div className="wc-muted">没有待处理的问题，这条视频的产出是干净的。</div>
        )}

        {(liveHealth.length > 0 || healthRows.length > 0) && (
          <div className="pl-sec">
            <div className="wc-label">体检问题 · 按节点修</div>
            {liveHealth.map((issue) => (
              <div key={issue.code} className={`pl-hitem ${issue.level}`}>
                <span>{issue.message}</span>
                {issue.fix_step !== null && (
                  <button className="btn-ghost-sm" onClick={() => onFixStep(issue.fix_step!)}>
                    重跑 {specLabel(issue.fix_step)}
                  </button>
                )}
              </div>
            ))}
            {healthRows.map((issue) => (
              <div key={issue.id} className={`pl-hitem ${issue.severity}`}>
                <span>{issue.detail}</span>
                {issue.suggestion !== null && (
                  <button
                    className="btn-ghost-sm"
                    onClick={() => onFixStep(issue.suggestion!)}
                  >
                    重跑 {specLabel(issue.suggestion)}
                  </button>
                )}
                <button className="btn-ghost-sm" onClick={() => onRepairIssue(issue)}>
                  AI 修复
                </button>
                {issue.state === 'open' && (
                  <button className="btn-ghost-sm" onClick={() => onDismiss(issue.id)}>
                    忽略
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {live.length > 0 && (
          <div className="pl-sec">
            <div className="wc-label">
              <IconSparkle />
              AI 校验问题 · 采纳即写回字幕
            </div>
            {live.map((issue) => (
              <IssueRow
                key={issue.id}
                issue={issue}
                result={handled[issue.id]}
                busy={batch !== null}
                onAccept={() => onAccept(issue)}
                onDismiss={() => onDismiss(issue.id)}
                onRepair={() => onRepairIssue(issue)}
              />
            ))}
          </div>
        )}

        {archived.length > 0 && (
          <details className="pl-sec">
            <summary className="wc-label pl-fold">往次已处理 · {archived.length} 条</summary>
            {archived.map((issue) => (
              <div key={issue.id} className="pl-issue done">
                <div className="pl-issue-main">
                  <div className="pl-issue-head">
                    <span className="chip">{ISSUE_KIND_LABEL[issue.kind] ?? issue.kind}</span>
                    <span className={`chip ${issue.state === 'accepted' ? 'ok' : 'ghost'}`}>
                      {issue.state === 'accepted' ? '已采纳' : '已忽略'}
                    </span>
                    {issue.sentence_id !== null && (
                      <span className="pl-issue-loc">句 #{issue.sentence_id}</span>
                    )}
                  </div>
                  <div className="pl-issue-detail">{issue.detail}</div>
                </div>
              </div>
            ))}
          </details>
        )}
      </div>
    </aside>
  )
}

/** 帮助浮层（FR-135 / FR-251）：内容改由域声明提供，与场景本管线同源。

   原先内容硬编码在这里，收掉单节点重跑确认门之后「服务端会拒绝」那段就过时了，
   而没人会想起来同步一个写死在组件里的文案。 */
function HelpOverlay({ data, onClose }: { data: VideoPipeline; onClose: () => void }) {
  const domains = useQuery({
    queryKey: ['pipeline-domains'],
    queryFn: apiPipeline.domains,
    staleTime: 5 * 60_000,
  })
  const sections = domains.data?.find((d) => d.domain === 'video')?.help ?? []

  return (
    <aside className="pl-sheet pl-help">
      <div className="panel-head">
        <h3>这张图怎么读</h3>
        <div style={{ flex: 1 }} />
        <button className="icon-btn" title="关闭（Esc）" onClick={onClose}>
          <IconClose />
        </button>
      </div>
      <div className="panel-body pl-detail-body pl-help-body">
        <section>
          <b>当前这次运行</b>
          <p>
            #{data.run?.id ?? '—'}。顶部下拉可切历次运行——入库是一次全量运行，
            之后的每次重跑、每次体检都是独立的一次。
          </p>
        </section>
        {sections.map((sec) => (
          <section key={sec.title}>
            <b>{sec.title}</b>
            {sec.body && <p>{sec.body}</p>}
            {sec.bullets.length > 0 && (
              <ul>
                {sec.bullets.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </section>
        ))}
        <section>
          <b>快捷键</b>
          <p>Esc 逐层关闭浮层；点画布空白处收起节点详情。</p>
        </section>
      </div>
    </aside>
  )
}

function RerunDialog({
  spec,
  step,
  pending,
  onClose,
  onSubmit,
}: {
  spec: StepSpec | null
  step: PipelineStepV1 | undefined
  pending: boolean
  onClose: () => void
  onSubmit: (scope: RerunScope, config: Record<string, Record<string, unknown>>) => void
}) {
  const [scope, setScope] = useState<RerunScope>('downstream')
  const [values, setValues] = useState<Record<string, unknown>>({})

  // 打开时用上次实际生效的参数预填，改哪项一目了然
  useEffect(() => {
    if (spec === null) return
    setScope('downstream')
    const initial: Record<string, unknown> = {}
    spec.tunables.forEach((t) => {
      const prev = step?.config?.[t.name]
      initial[t.name] = prev !== undefined && prev !== null ? prev : t.default
    })
    setValues(initial)
  }, [spec, step])

  if (spec === null) return null

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[560px] max-w-[92vw]">
        <DialogHeader>
          <DialogTitle>重跑「{spec.label}」</DialogTitle>
        </DialogHeader>
        <div className="pl-form">
          <label className="pl-field">
            <span>范围</span>
            <Picker
              size="sm"
              className="input"
              value={scope}
              onChange={(v) => setScope(v as RerunScope)}
              options={(
                ['downstream', ...(spec.single_ok ? (['single'] as const) : [])] as RerunScope[]
              ).map((s2) => ({ value: s2, label: SCOPE_LABEL[s2] }))}
            />
          </label>

          {spec.tunables.map((t) => (
            <TunableField
              key={t.name}
              tunable={t}
              value={values[t.name]}
              onChange={(v) => setValues((prev) => ({ ...prev, [t.name]: v }))}
            />
          ))}

          {spec.tunables.length === 0 && (
            <div className="wc-muted">这一步没有可调参数，直接重跑即可。</div>
          )}
        </div>
        <div className="pl-form-foot">
          <button className="btn-ghost-sm" onClick={onClose}>
            取消
          </button>
          <button
            className="btn btn-primary"
            disabled={pending}
            onClick={() => onSubmit(scope, { [spec.name]: values })}
          >
            {pending ? '入队中…' : '开始重跑'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function TunableField({
  tunable,
  value,
  onChange,
}: {
  tunable: import('../../lib/api-pipeline').Tunable
  value: unknown
  onChange: (v: unknown) => void
}) {
  return (
    <label className="pl-field">
      <span>{tunable.label}</span>
      {tunable.type === 'bool' ? (
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
      ) : tunable.type === 'select' ? (
        <Picker
          size="sm"
          className="input"
          value={String(value ?? '')}
          onChange={onChange}
          /* 有中文标签就用中文：soft-flat / clean-isometric 这种裸键没人看得懂。
             空串是"未选"，交给 placeholder——Radix Select 不收空串当选项值 */
          placeholder="不指定"
          options={(tunable.choices ?? tunable.options.map((o) => ({ value: o, label: o })))
            .filter((c) => c.value !== '')
            .map((c) => ({ value: c.value, label: c.label }))}
        />
      ) : tunable.type === 'textarea' ? (
        /* 生图节点的提示词是整段文本，单行 input 里根本看不清（模块 16 FR-413） */
        <textarea
          className="input pl-textarea"
          rows={6}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          className="input"
          type={tunable.type === 'number' ? 'number' : 'text'}
          step="any"
          value={String(value ?? '')}
          onChange={(e) =>
            onChange(tunable.type === 'number' ? Number(e.target.value) : e.target.value)
          }
        />
      )}
      {tunable.hint !== '' && <em className="pl-hint">{tunable.hint}</em>}
    </label>
  )
}

/** Gantt 时间轴（FR-73）：哪一步最慢一眼看出 */
function Gantt({ steps }: { steps: PipelineStepV1[] }) {
  const timed = steps.filter((s) => s.started_at !== null && s.duration_ms !== null)
  if (timed.length === 0) return <div className="wc-muted">本次运行没有计时数据</div>
  const t0 = Math.min(...timed.map((s) => new Date(s.started_at!).getTime()))
  const t1 = Math.max(
    ...timed.map((s) => new Date(s.started_at!).getTime() + (s.duration_ms ?? 0)),
  )
  const span = Math.max(1, t1 - t0)
  return (
    <div className="pl-gantt">
      {timed.map((s) => {
        const start = new Date(s.started_at!).getTime() - t0
        return (
          <div key={s.id} className="pl-gantt-row">
            <span className="pl-gantt-name">{s.label}</span>
            <span className="pl-gantt-track">
              <i
                className={s.status}
                style={{
                  left: `${(start / span) * 100}%`,
                  width: `${Math.max(0.8, ((s.duration_ms ?? 0) / span) * 100)}%`,
                }}
              />
            </span>
            <span className="pl-gantt-dur">{formatDuration(s.duration_ms)}</span>
          </div>
        )
      })}
    </div>
  )
}

function IssueRow({
  issue,
  result,
  busy,
  onAccept,
  onDismiss,
  onRepair,
}: {
  issue: SubtitleIssueV1
  result: HandledResult | undefined
  busy: boolean
  onAccept: () => void
  onDismiss: () => void
  onRepair: () => void
}) {
  const canAutoApply = issue.suggestion !== null && issue.sentence_id !== null
  const phase = result?.phase
  const doneRes = result !== undefined && result.phase === 'done' ? result : null
  const failRes = result !== undefined && result.phase === 'failed' ? result : null

  return (
    <div className={`pl-issue ${issue.severity}${phase ? ` ph-${phase}` : ''}`}>
      <div className="pl-issue-main">
        <div className="pl-issue-head">
          <span className={`chip ${issue.severity === 'error' ? 'warn' : ''}`}>
            {ISSUE_KIND_LABEL[issue.kind] ?? issue.kind}
          </span>
          {issue.source === 'ai' && <span className="chip ghost">AI 裁判</span>}
          {issue.sentence_id !== null && (
            <span className="pl-issue-loc">句 #{issue.sentence_id}</span>
          )}
          <div style={{ flex: 1 }} />
          {phase === 'writing' && (
            <span className="pl-issue-state writing">
              <span className="spinner" />
              写回中…
            </span>
          )}
          {doneRes !== null && doneRes.applied && (
            <span className="pl-issue-state ok">✓ 已写回字幕</span>
          )}
          {doneRes !== null && !doneRes.applied && (
            <span className="pl-issue-state warn">已标记，但无法自动写回</span>
          )}
          {phase === 'failed' && <span className="pl-issue-state err">写回失败</span>}
        </div>

        <div className="pl-issue-cols">
          <div className="pl-issue-detail">{issue.detail}</div>
          {issue.suggestion !== null && (
            <div className="pl-issue-fix">
              <em>建议</em>
              {issue.suggestion}
            </div>
          )}
        </div>

        {doneRes !== null && doneRes.refilling === true && (
          <div className="pl-issue-note">
            改的是原文，旧译文已失效——后台正在只补这一句的译文，不用重跑整条中文轨。
          </div>
        )}
        {doneRes !== null && doneRes.change != null && (
          <div className="pl-issue-diff">
            <span className="pl-diff-tag">{doneRes.change.field}</span>
            <del>{doneRes.change.old ?? '（空）'}</del>
            <span className="pl-diff-arrow">→</span>
            <ins>{doneRes.change.new}</ins>
          </div>
        )}
        {doneRes !== null && !doneRes.applied && (
          <div className="pl-issue-note">
            这条缺少句子定位或建议内容，服务端无法自动写回——可转「AI 修复」人工确认。
          </div>
        )}
        {failRes !== null && <div className="panel-error pl-issue-note">{failRes.error}</div>}
      </div>

      <div className="pl-issue-act">
        {canAutoApply && phase !== 'writing' && phase !== 'done' && (
          <button className="btn btn-sm" disabled={busy} onClick={onAccept}>
            {phase === 'failed' ? '重试写回' : '采纳并写回'}
          </button>
        )}
        {phase !== 'writing' && (
          <button className="btn-ghost-sm" title="转给 AI 修复代理处理" onClick={onRepair}>
            AI 修复
          </button>
        )}
        {phase === undefined && (
          <button className="btn-ghost-sm" disabled={busy} onClick={onDismiss}>
            忽略
          </button>
        )}
      </div>
    </div>
  )
}
