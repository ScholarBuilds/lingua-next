/* AI 修复会话面板（需求 09 v7 FR-85~92）：停靠在拓扑页右侧。

   用自然语言（打字或按住说话）描述问题 → 代理调有界工具修复 → 工具动作实时
   流入会话（审计可见）→ 高危操作弹确认卡（BR-25）→ 修不动一键换模型重试（FR-89）。 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { useEscapeClose } from '../../components/Overlay'
import { toast } from 'sonner'

import { IconClose, IconSparkle } from '../../components/icons'
import { apiConfig } from '../../lib/api-config'
import type { Binding } from '../../lib/api-config'
import { ModelPicker } from '@/components/model-picker/ModelPicker'
import { apiRepair, REPAIR_ALIASES, subscribeRepair } from '../../lib/api-repair'
import type { RepairActionV1, RepairDetail, RepairSessionV1 } from '../../lib/api-repair'
import { modelText } from '../../lib/model-label'
import { formatDuration } from './dag'
import { requireMic } from '../../lib/mic'
import { Markdown } from '../../components/Markdown'

interface RepairPanelProps {
  videoId: number
  /** 从拓扑图节点发起时的锚定节点 */
  stepName: string | null
  stepLabel: string | null
  onClose: () => void
  /** 代理改完数据后让追踪页刷新 */
  onDataChanged: () => void
  /** 预填输入框（如从问题清单带着上下文进来），用户可改可删 */
  initialDraft?: string
  /** 会话就绪后自动把 initialDraft 发出去（FR-139）：
      按钮写着"AI 修复"，点了就该开修，不该停在"填好了等你按发送" */
  autoSend?: boolean
}

export function RepairPanel({
  videoId,
  stepName,
  stepLabel,
  onClose,
  onDataChanged,
  initialDraft,
  autoSend,
}: RepairPanelProps) {
  const qc = useQueryClient()
  const [session, setSession] = useState<RepairSessionV1 | null>(null)
  const [detail, setDetail] = useState<RepairDetail | null>(null)
  const deployments = useQuery({
    queryKey: ['cfg-model-deployments', 'repair-agent'],
    queryFn: () => apiConfig.modelDeployments({ media_type: 'chat', enabled: true }),
  })
  // 能力绑定表：拿它把能力名翻成「中文能力名 + 当前绑定的上游真实模型名」。
  // 会话里存的 model_alias 是能力名，直接摆到「模型」位上就是拿路由键冒充模型
  const bindings = useQuery({ queryKey: ['cfg-bindings'], queryFn: () => apiConfig.bindings() })
  const [draft, setDraft] = useState(initialDraft ?? '')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [recording, setRecording] = useState(false)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const lastActionCount = useRef(0)
  // 自动发送只允许一次：StrictMode 双调用 / SSE 重连都不能触发第二次
  const autoSentRef = useRef(false)

  // 打开面板：续用该视频最近的未完结会话，否则新建（锚定节点跟随入口）
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const existing = await apiRepair.sessions(videoId)
        const open = existing.find((s) => s.step_name === stepName) ?? existing[0]
        const row =
          open ?? (await apiRepair.createSession({ video_id: videoId, step_name: stepName }))
        if (!cancelled) setSession(row)
      } catch (e) {
        toast.error((e as Error).message || '会话创建失败')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [videoId, stepName])

  // SSE 订阅会话；代理动了数据（工具成功数变化）就刷新追踪页
  useEffect(() => {
    if (session === null) return
    return subscribeRepair(session.id, (d) => {
      setDetail(d)
      const done = d.actions.filter((a) => a.status === 'success').length
      if (done !== lastActionCount.current) {
        lastActionCount.current = done
        onDataChanged()
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id])

  // 新内容进来自动滚到底
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [detail?.messages.length, detail?.actions.length, detail?.status])

  const send = useMutation({
    mutationFn: (content: string) => apiRepair.send(session!.id, content),
    onSuccess: () => setDraft(''),
    onError: (e: Error) => toast.error(e.message || '发送失败'),
  })

  // 会话建好就把预填问题发出去（FR-139）。高危动作仍走确认门（BR-25），自动开修不越权
  useEffect(() => {
    if (!autoSend || session === null || autoSentRef.current) return
    const text = (initialDraft ?? '').trim()
    if (text === '') return
    autoSentRef.current = true
    send.mutate(text)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, autoSend])

  const confirm = useMutation({
    mutationFn: () => apiRepair.confirm(session!.id),
    onError: (e: Error) => toast.error(e.message || '确认失败'),
  })
  const reject = useMutation({
    mutationFn: () => apiRepair.reject(session!.id),
    onError: (e: Error) => toast.error(e.message || '操作失败'),
  })

  const switchModel = useMutation({
    mutationFn: (selection: string) => {
      // 选项值只在本组件内部编解码：capability:<能力名> 跟随绑定，deployment:<id> 钉死一条部署
      const [kind, value] = selection.split(':', 2)
      return apiRepair.createSession({
        video_id: videoId,
        step_name: stepName,
        model_alias: kind === 'capability' ? value : REPAIR_ALIASES[0],
        model_deployment_id: kind === 'deployment' ? Number(value) : null,
        parent_session_id: session?.id,
      })
    },
    onSuccess: (row, selection) => {
      const deployment = (deployments.data ?? []).find(
        (item) => selection === `deployment:${item.id}`,
      )
      // 切到指定部署报那条部署的上游真名；跟随绑定则报该能力当前绑定的真名
      const label =
        deployment?.upstream_model_id ?? modelText(boundModel(bindings.data, row.model_alias))
      toast.success(`已切到 ${label}，问题上下文已带入`)
      setDetail(null)
      lastActionCount.current = 0
      setSession(row)
      void qc.invalidateQueries({ queryKey: ['repair-sessions', videoId] })
    },
    onError: (e: Error) => toast.error(e.message || '切换失败'),
  })

  // 语音输入（FR-91）：录音 → whisper 转文字 → 进输入框由用户过目后发送
  const toggleRecord = async () => {
    if (recording) {
      recorderRef.current?.stop()
      return
    }
    try {
      const stream = await requireMic()
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })
      chunksRef.current = []
      recorder.ondataavailable = (e) => chunksRef.current.push(e.data)
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        setRecording(false)
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        if (blob.size < 2000) return // 误触
        try {
          const { text } = await apiRepair.voice(session!.id, blob)
          if (text) setDraft((prev) => (prev ? `${prev} ${text}` : text))
          else toast.info('没听清，再说一次？')
        } catch (e) {
          toast.error((e as Error).message || '语音转写失败')
        }
      }
      recorderRef.current = recorder
      recorder.start()
      setRecording(true)
    } catch {
      toast.error('无法访问麦克风')
    }
  }

  const working = detail?.status === 'working' || detail?.status === 'confirmed'
  const pending = detail?.pending_action ?? null
  const currentDeploymentId = detail?.model_deployment_id ?? session?.model_deployment_id ?? null
  const currentDeployment = (deployments.data ?? []).find(
    (item) => item.id === currentDeploymentId,
  )
  // 会话跟随绑定时，「当前模型」要顺着绑定表查上游真名，而不是把能力名摆上去
  const currentCapability = detail?.model_alias ?? session?.model_alias ?? ''
  const currentModelLabel =
    currentDeployment?.upstream_model_id ??
    // 会话或绑定表还没到手时先留省略号：这时候不是"没绑定"，是还不知道
    (currentCapability === '' || bindings.isPending
      ? '…'
      : modelText(boundModel(bindings.data, currentCapability)))
  const [pickerOpen, setPickerOpen] = useState(false)

  /* 消息与动作按时间交错成一条流：用户看到"说了什么 → AI 做了什么"的完整过程 */
  const stream = buildStream(detail)

  /* Esc 两段式（STD-UI-002 的输入框变体）：正在输入框里且有未发送草稿时，
     第一次 Esc 只失焦，第二次才关面板。直接关会把用户刚打的字连同面板一起丢掉，
     而这个面板恰恰是用来打字描述问题的。 */
  useEscapeClose(() => {
    if (draft.trim() !== '' && document.activeElement === inputRef.current) {
      inputRef.current?.blur()
      return
    }
    onClose()
  })

  return (
    <aside className="rp-panel">
      <div className="panel-head">
        <IconSparkle />
        <h3>AI 修复{stepLabel !== null ? ` · ${stepLabel}` : ''}</h3>
        {/* 这一格是「模型」位，只放上游真名；是哪个能力在标题里说 */}
        <span
          className="rp-model"
          title={
            currentCapability === ''
              ? '当前修复 Agent 模型'
              : `当前修复 Agent 模型 · 能力「${capabilityLabel(bindings.data, currentCapability)}」`
          }
        >
          {currentModelLabel}
        </span>
        <div style={{ flex: 1 }} />
        <button
          className="input rp-switch"
          title="修不动？换个更强的模型重试，问题上下文自动带入"
          onClick={() => setPickerOpen(true)}
        >
          换模型…
        </button>
        <ModelPicker
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          options={deployments.data ?? []}
          value={currentDeploymentId}
          usage="修复代理"
          onPick={(deployment) => switchModel.mutate(`deployment:${deployment.id}`)}
          followDefault={{
            modelName: boundModel(bindings.data, REPAIR_ALIASES[0]),
            active: currentDeploymentId === null,
            onFollow: () => switchModel.mutate(`capability:${REPAIR_ALIASES[0]}`),
          }}
        />
        <button className="icon-btn" title="关闭" onClick={onClose}>
          <IconClose />
        </button>
      </div>

      <div className="rp-body" ref={scrollRef}>
        {detail === null && <div className="wc-muted rp-hint">正在连接会话…</div>}
        {detail !== null && stream.length === 0 && (
          <div className="rp-welcome">
            用你自己的话描述问题就行，比如：
            <ul>
              <li>"第 3 句的 accept 听错了，应该是 except"</li>
              <li>"断句切得太碎，帮我放宽一点"</li>
              <li>"中间有一大段黏在一起，帮我拆开"</li>
              <li>"译文腔太重，整个重翻一遍"</li>
            </ul>
            AI 会先查证，再动手修，修完自动体检并汇报前后对比。
          </div>
        )}
        {stream.map((item) =>
          item.kind === 'message' ? (
            <MessageBubble key={`m${item.message.id}`} role={item.message.role}>
              {item.message.content}
            </MessageBubble>
          ) : (
            <ActionChip key={`a${item.action.id}`} action={item.action} />
          ),
        )}
        {working && (
          <div className="rp-working">
            <span className="spinner" />
            代理执行中，工具动作会实时出现在上方…
          </div>
        )}
      </div>

      {pending !== null && (
        <div className="rp-confirm">
          <b>需要你确认</b>
          <p>{pending.reason}</p>
          <code>{JSON.stringify(pending.args)}</code>
          <div className="rp-confirm-act">
            <button
              className="btn btn-primary btn-sm"
              disabled={confirm.isPending}
              onClick={() => confirm.mutate()}
            >
              确认执行
            </button>
            <button className="btn-ghost-sm" onClick={() => reject.mutate()}>
              否决
            </button>
          </div>
        </div>
      )}

      <div className="rp-composer">
        <button
          className={`icon-btn rp-mic${recording ? ' on' : ''}`}
          title={recording ? '停止录音' : '按一下开始说话（whisper 转文字）'}
          onClick={() => void toggleRecord()}
        >
          <MicIcon />
        </button>
        <textarea
          ref={inputRef}
          className="input rp-input"
          rows={2}
          placeholder={working ? '代理执行中…' : '描述问题，或点麦克风说话'}
          value={draft}
          disabled={working}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && draft.trim() && !working) {
              e.preventDefault()
              send.mutate(draft.trim())
            }
          }}
        />
        <button
          className="btn btn-primary btn-sm"
          disabled={!draft.trim() || working || send.isPending}
          onClick={() => send.mutate(draft.trim())}
        >
          发送
        </button>
      </div>
    </aside>
  )
}

/** 该能力当前绑定的上游真实模型名；没绑定、或绑定表还没到手，都是 null。
 *
 *  会话行上的 `model_alias` 存的是能力名（`repair-agent`），要真名只能顺着绑定查。 */
function boundModel(rows: Binding[] | undefined, capability: string): string | null {
  if (capability === '') return null
  return rows?.find((b) => b.capability === capability)?.deployment?.upstream_model_id ?? null
}

/** 该能力的中文标签（绑定表随行返回）。查不到时退回能力名本身——它只会出现在
 *  「能力」位，不会被摆到「模型」位上。 */
function capabilityLabel(rows: Binding[] | undefined, capability: string): string {
  return rows?.find((b) => b.capability === capability)?.label ?? capability
}

type StreamItem =
  | { kind: 'message'; at: string; message: RepairDetail['messages'][number] }
  | { kind: 'action'; at: string; action: RepairActionV1 }

function buildStream(detail: RepairDetail | null): StreamItem[] {
  if (detail === null) return []
  const items: StreamItem[] = [
    ...detail.messages
      .filter((m) => m.role !== 'system') // 系统注记是给代理看的，不进气泡流
      .map((m) => ({ kind: 'message' as const, at: m.created_at ?? '', message: m })),
    ...detail.actions.map((a) => ({ kind: 'action' as const, at: a.created_at ?? '', action: a })),
  ]
  return items.sort((x, y) => x.at.localeCompare(y.at))
}

function MessageBubble({ role, children }: { role: string; children: string }) {
  return (
    <div className={`rp-msg ${role}`}>
      {/* 代理侧是 LLM 输出，可能带粗体/列表/表格，走统一 Markdown 渲染（FR-351） */}
      <div className="rp-msg-body">
        {role === 'user' ? children : <Markdown text={children} />}
      </div>
    </div>
  )
}

/** 工具动作芯片：做了什么、结果如何，一行看清（FR-88 审计的会话内呈现） */
function ActionChip({ action }: { action: RepairActionV1 }) {
  const summary = summarizeAction(action)
  return (
    <div className={`rp-action ${action.status}`}>
      <span className="rp-action-dot" />
      <span className="rp-action-label">{action.label}</span>
      {summary !== '' && <span className="rp-action-sum">{summary}</span>}
      {action.duration_ms !== null && (
        <span className="rp-action-dur">{formatDuration(action.duration_ms)}</span>
      )}
      {action.error !== null && <span className="rp-action-err">{action.error.slice(0, 80)}</span>}
    </div>
  )
}

function summarizeAction(a: RepairActionV1): string {
  const r = a.result
  switch (a.tool) {
    case 'rerun_pipeline':
      return String(a.args.from_step ?? '')
    case 'split_sentence':
      return r.units !== undefined ? `拆为 ${String(r.units)} 个学习句` : ''
    case 'merge_sentences':
      return r.units !== undefined ? `并为 ${String(r.units)} 个学习句` : ''
    case 'edit_sentence':
      return `句 #${String(a.args.sentence_id ?? '')}`
    case 'resolve_issues':
      return r.applied !== undefined ? `写回 ${String(r.applied)} 条` : ''
    case 'run_verify':
      return r.gate !== undefined ? `结论 ${String(r.gate)}` : ''
    case 'list_sentences': {
      const list = r.sentences
      return Array.isArray(list) ? `${list.length} 句` : ''
    }
    default:
      return ''
  }
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  )
}
