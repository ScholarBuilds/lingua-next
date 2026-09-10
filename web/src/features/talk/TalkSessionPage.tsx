import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import {
  IconAlert,
  IconCheck,
  IconChevronDown,
  IconMic,
  IconSend,
  IconSparkle,
  IconSpeaker,
  IconStar,
  IconVoice,
} from '../../components/icons'
import { Topbar } from '../../components/Topbar'
import { api, talkTtsUrl } from '../../lib/api'
import type {
  KeySentence,
  TalkDifficulty,
  TalkScenario,
  TalkSessionDetail,
  TalkSummary,
  TalkTurn,
} from '../../lib/api'
import { createSpeechQueue, playTts, playUrl, stopTts } from '../../lib/audio'
import { streamTalkTurn } from '../../lib/talkStream'
import { RealtimeSessionPage } from './RealtimeSessionPage'
import { ScenePanel } from './ScenePanel'
import { TalkRecordsDialog, TalkRecordsView } from './TalkRecordsDialog'
import { useRecorder } from '../../lib/recorder'
import { useWorkspaceText, useWorkspaceStore } from '@/lib/workspaceStore'

const DIFF_LABEL: Record<string, string> = { easy: '简单', medium: '适中', hard: '挑战' }

function playTurnTts(turn: TalkTurn): void {
  if (turn.tts_url) playUrl(talkTtsUrl(turn.tts_url))
  else playTts(turn.text)
}

/* ---- 气泡 ---- */

function AiBubble({ turn }: { turn: TalkTurn }) {
  const [hintOpen, setHintOpen] = useState(false)
  const hintQuery = useQuery({
    queryKey: ['talk-hint', turn.text],
    queryFn: () => api.translate({ text: turn.text, engine: 'auto' }),
    enabled: hintOpen,
    staleTime: Infinity,
  })

  return (
    <div className="msg ai">
      <div className="avatar">
        <IconVoice />
      </div>
      <div className="msg-body">
        <div className="bubble">{turn.text}</div>
        <div className="msg-tools">
          <button className="icon-btn tts-sm" title="朗读" onClick={() => playTurnTts(turn)}>
            <IconSpeaker />
          </button>
          <button className="hint" onClick={() => setHintOpen((o) => !o)}>
            <IconChevronDown style={hintOpen ? { transform: 'rotate(180deg)' } : undefined} />
            {hintOpen
              ? hintQuery.isError
                ? '翻译失败，点击重试'
                : (hintQuery.data?.result.text ?? '翻译中…')
              : '中文提示'}
          </button>
        </div>
      </div>
    </div>
  )
}

function UserBubble({ turn }: { turn: TalkTurn }) {
  const fb = turn.feedback
  return (
    <div className="msg user">
      <div className="msg-body">
        <div className="bubble">{turn.text}</div>
        {fb && fb.level === 'improve' && (
          <div className="note warn">
            <IconSparkle />
            <div>
              <div>表达优化{fb.better ? `：${fb.better}` : ''}</div>
              {fb.note && <div className="note-sub">{fb.note}</div>}
            </div>
          </div>
        )}
        {fb && fb.level === 'ok' && (
          <div className="note ok">
            <IconCheck />
            表达自然
          </div>
        )}
      </div>
    </div>
  )
}

function PendingUserBubble({ text }: { text: string }) {
  return (
    <div className="msg user">
      <div className="msg-body">
        <div className="bubble pending">{text}</div>
      </div>
    </div>
  )
}

function ThinkingBubble() {
  return (
    <div className="msg ai">
      <div className="avatar">
        <IconVoice />
      </div>
      <div className="msg-body">
        <div className="bubble speaking">
          <div className="wave">
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
          <span className="speaking-tip">正在思考…</span>
        </div>
      </div>
    </div>
  )
}

/* ---- 总结卡 ---- */

function SummaryCard({ summary: raw }: { summary: TalkSummary }) {
  const [collected, setCollected] = useState<ReadonlySet<string>>(new Set())
  const collect = useMutation({
    mutationFn: (p: KeySentence) => api.collectVocab({ word: p.en, context_text: p.en }),
    onSuccess: (_data, p) => setCollected((prev) => new Set(prev).add(p.en)),
  })

  // 语音陪读会话的 summary 字段被后端借存 {article_id}，三个数组可能缺失，兜底为空
  const summary: TalkSummary = {
    done_well: raw.done_well ?? [],
    suggestions: raw.suggestions ?? [],
    key_phrases: raw.key_phrases ?? [],
  }

  return (
    <div className="card sum-card">
      <div className="sum-title">
        <IconSparkle />
        会话总结
      </div>
      {summary.done_well.length === 0 &&
        summary.suggestions.length === 0 &&
        summary.key_phrases.length === 0 && (
          <div className="panel-hint">对话回合太少，这次没有可总结的内容</div>
        )}
      {summary.done_well.length > 0 && (
        <div className="sum-sec">
          <div className="sum-label ok">做得好</div>
          <ul>
            {summary.done_well.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      )}
      {summary.suggestions.length > 0 && (
        <div className="sum-sec">
          <div className="sum-label warn">建议</div>
          <ul>
            {summary.suggestions.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      )}
      {summary.key_phrases.length > 0 && (
        <div className="sum-sec">
          <div className="sum-label">重点词组</div>
          <div className="sum-phrases">
          {summary.key_phrases.map((p) => (
            <div className="key" key={p.en}>
              <div className="key-text">
                <div className="key-en">{p.en}</div>
                <div className="key-zh">{p.zh}</div>
              </div>
              <button className="icon-btn" title="朗读" onClick={() => playTts(p.en)}>
                <IconSpeaker />
              </button>
              <button
                className={`icon-btn${collected.has(p.en) ? ' active' : ''}`}
                title={collected.has(p.en) ? '已收藏' : '收藏'}
                disabled={collected.has(p.en)}
                onClick={() => collect.mutate(p)}
              >
                <IconStar filled={collected.has(p.en)} />
              </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/* ---- 录音（按住录，松开发送） ---- */

/* ---- 回合流公共渲染 ---- */

function TurnStream({
  turns,
  pendingText,
  thinking,
  summary,
}: {
  turns: TalkTurn[]
  pendingText: string | null
  thinking: boolean
  summary: TalkSummary | null
}) {
  const streamRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = streamRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns.length, pendingText, thinking, summary])

  return (
    <div className="stream" ref={streamRef}>
      <div className="stream-inner">
        {turns.length === 0 && pendingText == null && !thinking && !summary && (
          <div className="panel-hint" style={{ textAlign: 'center', marginTop: 24 }}>
            没有预设开场白，直接输入英文或按住麦克风开聊
          </div>
        )}
        {turns.map((t) =>
          t.role === 'assistant' ? <AiBubble key={t.id} turn={t} /> : <UserBubble key={t.id} turn={t} />,
        )}
        {pendingText != null && <PendingUserBubble text={pendingText} />}
        {thinking && <ThinkingBubble />}
        {summary && <SummaryCard summary={summary} />}
      </div>
    </div>
  )
}

function SessionTopbar({
  title,
  scenario,
  difficulty,
  review,
  right,
}: {
  title: string
  scenario: TalkScenario | null
  difficulty: string
  review?: boolean
  right?: ReactNode
}) {
  return (
    <Topbar
      /* 这一页深链可达（`/talk/session?id=…`），必须自带出口：没有 back、面包屑又不可点时，
         唯一剩下的出口是侧栏菜单项，而它在本模块激活时曾经指向当前 URL——点了什么都不会发生 */
      back={{ to: '/talk', label: '对话' }}
      crumbs={[{ label: '对话', to: '/talk' }]}
      title={title}
      meta={
        <>
          {scenario && <span className="chip accent">{scenario.level}</span>}
          <span className="chip">{DIFF_LABEL[difficulty] ?? difficulty}</span>
          {review && <span className="chip">回顾</span>}
        </>
      }
      actions={right}
    />
  )
}

/* ---- 进行中的回合制会话 ---- */

function LiveTurnSession({
  scenarioKey,
  difficulty,
  resumeId,
}: {
  scenarioKey?: string
  difficulty: TalkDifficulty
  resumeId?: string
}) {
  const queryClient = useQueryClient()
  const [params, setParams] = useSearchParams()
  const createdRef = useRef(false)
  const mounted = useRef(false)
  const [session, setSession] = useState<TalkSessionDetail | null>(null)
  const [turns, setTurns] = useState<TalkTurn[]>([])
  const [summary, setSummary] = useState<TalkSummary | null>(null)
  const [recordsOpen, setRecordsOpen] = useState(false)
  const [ended, setEnded] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pendingText, setPendingText] = useState<string | null>(null)
  const [draft, setDraft] = useWorkspaceText('talk', `input:${scenarioKey ?? 'free'}`)

  useEffect(() => {
    mounted.current = true
    if (!createdRef.current) {
      createdRef.current = true
      const request = resumeId ? api.talkSession(resumeId)
        : api.createTalkSession({ mode: 'text', scenario_key: scenarioKey, difficulty })
      void request
      .then((s) => {
        const next = new URLSearchParams(params)
        next.set('live', String(s.id))
        useWorkspaceStore.getState().put('talk', 'last-route', { route: `/talk/session?${next}` })
        if (!mounted.current) return
        setParams(next, { replace: true })
        setSession(s)
        setTurns(s.turns)
        setEnded(!!s.ended_at)
        setSummary(s.summary)
        const opening = s.turns.find((t) => t.role === 'assistant')
        if (opening && !resumeId) playTurnTts(opening)
      })
      .catch((err) => {
        if (mounted.current) setCreateError(err instanceof Error ? err.message : '会话读取失败')
      })
    }
    return () => { mounted.current = false; stopTts() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onTurnPair = (pair: { user_turn: TalkTurn; assistant_turn: TalkTurn }) => {
    setTurns((t) => [...t, pair.user_turn, pair.assistant_turn])
    setPendingText(null)
    setNotice(null)
  }
  const onTurnError = (err: unknown) => {
    speechQueue.current?.stop()
    setPendingText(null)
    if (turnAbort.current?.signal.aborted) return
    setNotice(err instanceof Error ? err.message : '发送失败，请重试')
  }

  const turnAbort = useRef<AbortController | null>(null)
  const speechQueue = useRef<ReturnType<typeof createSpeechQueue> | null>(null)
  useEffect(() => () => { turnAbort.current?.abort(); speechQueue.current?.stop() }, [])
  const requestTurn = (input: string | { blob: Blob; filename: string }) => {
    turnAbort.current?.abort()
    speechQueue.current?.stop()
    const controller = new AbortController()
    turnAbort.current = controller
    const resetQueue = () => {
      speechQueue.current?.stop()
      speechQueue.current = createSpeechQueue(() => setNotice('朗读中断，可点击回复旁的朗读按钮重试'))
    }
    resetQueue()
    return streamTalkTurn(session!.id, input, controller.signal,
      (text) => speechQueue.current?.enqueue(text), resetQueue)
  }

  const sendText = useMutation({
    mutationFn: (text: string) => requestTurn(text),
    onSuccess: (pair, sentText) => {
      const current = useWorkspaceStore.getState().records[`talk:input:${scenarioKey ?? 'free'}`]?.text
      if (current?.trim() === sentText) setDraft('')
      onTurnPair(pair)
    },
    onError: onTurnError,
  })

  const sendAudio = useMutation({
    mutationFn: ({ blob, filename }: { blob: Blob; filename: string }) =>
      requestTurn({ blob, filename }),
    onSuccess: onTurnPair,
    onError: onTurnError,
  })

  const end = useMutation({
    mutationFn: () => api.endTalkSession(session!.id),
    onSuccess: (res) => {
      stopTts()
      setSummary(res.summary)
      setEnded(true)
      void queryClient.invalidateQueries({ queryKey: ['talk-sessions'] })
    },
    onError: async (err) => {
      setNotice(err instanceof Error ? err.message : '总结生成失败，请重试')
      try {
        const detail = await api.talkSession(session!.id)
        if (detail.ended_at) {
          setEnded(true)
          setNotice('会话已保存并结束，总结生成失败，可在回顾中重试')
          void queryClient.invalidateQueries({ queryKey: ['talk-sessions'] })
        }
      } catch { setNotice('无法确认会话状态，请打开对话记录检查保存结果') }
    },
  })

  const busy = sendText.isPending || sendAudio.isPending

  const submitText = () => {
    const text = draft.trim()
    if (!text || busy || !session) return
    setPendingText(text)
    sendText.mutate(text)
  }

  const recorder = useRecorder(
    (blob, filename) => {
      if (!session || busy) return
      setPendingText('语音识别中…')
      sendAudio.mutate({ blob, filename })
    },
    (msg) => setNotice(msg),
  )

  if (createError) {
    return (
      <div className="main">
        <SessionTopbar title="对话练习" scenario={null} difficulty={difficulty} />
        <div className="state-block" style={{ flex: 1 }}>
          <IconAlert />
          <div>{createError}</div>
        </div>
      </div>
    )
  }

  const scenario = session?.scenario ?? null
  const latestAssistantText = [...turns]
    .reverse()
    .find((turn) => turn.role === 'assistant')?.text ?? null

  return (
    <div className="main">
      <SessionTopbar
        title={session ? (session.scenario_title ?? '自由话题') : '连接中…'}
        scenario={scenario}
        difficulty={difficulty}
        right={
          <><button className="btn" disabled={!session || recorder.recording} onClick={() => { speechQueue.current?.stop(); stopTts(); setRecordsOpen(true) }}>对话记录 · {turns.length}</button>{!ended && (
            <button
              className="btn btn-end"
              onClick={() => end.mutate()}
              disabled={!session || end.isPending || busy}
            >
              {end.isPending ? '总结中…' : '结束会话'}
            </button>
          )}</>
        }
      />
      <div className="body-row">
        <section className="talk-stage">
          {!session ? (
            <div className="state-block" style={{ flex: 1 }}>
              <div className="spinner" />
              <div>正在开启会话…</div>
            </div>
          ) : (
            <TurnStream
              turns={turns}
              pendingText={pendingText}
              thinking={busy}
              summary={summary}
            />
          )}

          {notice && <div className="talk-notice">{notice}</div>}

          {!ended && (
            <div className="talk-inputbar">
              <button
                className={`rec-btn${recorder.recording ? ' recording' : ''}`}
                title="按住说话，松开发送"
                disabled={!session || busy}
                onPointerDown={(e) => {
                  e.preventDefault()
                  void recorder.start()
                }}
                onPointerUp={recorder.stop}
                onPointerLeave={recorder.stop}
                onPointerCancel={recorder.stop}
              >
                <IconMic />
              </button>
              {recorder.recording ? (
                <div className="rec-tip">正在录音… 松开发送，移出按钮取消</div>
              ) : (
                <input
                  className="talk-text"
                  placeholder="输入英文回复，回车发送"
                  value={draft}
                  disabled={!session || busy}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) submitText()
                  }}
                />
              )}
              <button
                className="btn btn-primary"
                onClick={submitText}
                disabled={!session || busy || draft.trim() === ''}
              >
                <IconSend />
                发送
              </button>
            </div>
          )}
        </section>
        <ScenePanel
          scenario={scenario}
          sessionId={session?.id ?? null}
          assistantText={latestAssistantText}
          turnId={[...turns].reverse().find((turn) => turn.role === 'assistant')?.id}
          onUseReply={setDraft}
        />
      </div>
      {recordsOpen && session && <TalkRecordsDialog sessionId={session.id} onClose={() => setRecordsOpen(false)} />}
    </div>
  )
}

/* ---- 历史回顾 ---- */

function ReviewSession({ sessionId }: { sessionId: string }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const detailQuery = useQuery({
    queryKey: ['talk-session', sessionId],
    queryFn: () => api.talkSession(sessionId),
  })

  const end = useMutation({
    mutationFn: () => api.endTalkSession(sessionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['talk-session', sessionId] })
      void queryClient.invalidateQueries({ queryKey: ['talk-sessions'] })
    },
  })

  useEffect(() => stopTts, [])

  const detail = detailQuery.data

  if (detailQuery.isPending) {
    return (
      <div className="main">
        <SessionTopbar title="加载中…" scenario={null} difficulty="medium" review />
        <div className="state-block" style={{ flex: 1 }}>
          <div className="spinner" />
          <div>正在加载会话…</div>
        </div>
      </div>
    )
  }

  if (detailQuery.isError || !detail) {
    return (
      <div className="main">
        <SessionTopbar title="会话回顾" scenario={null} difficulty="medium" review />
        <div className="state-block" style={{ flex: 1 }}>
          <IconAlert />
          <div>会话加载失败</div>
          <button className="btn btn-outline" onClick={() => void detailQuery.refetch()}>
            重试
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="main talk-history-page">
      <SessionTopbar
        title={detail.scenario_title ?? '自由话题'}
        scenario={detail.scenario}
        difficulty={detail.difficulty}
        review
      />
      <div className="body-row">
        <section className="talk-stage">
          <TalkRecordsView sessionId={sessionId} onDeleted={() => navigate('/talk')} />
          {detail.summary?.done_well && <details className="talk-review-summary"><summary>会话总结</summary><SummaryCard summary={detail.summary} /></details>}
          {!detail.summary?.done_well && (
            <div className="talk-reviewbar">
              <span>共 {detail.turns.length} 个回合，还没有总结</span>
              <button
                className="btn btn-soft"
                onClick={() => end.mutate()}
                disabled={end.isPending}
              >
                <IconSparkle />
                {end.isPending ? '总结中…' : '生成总结'}
              </button>
              {end.isError && (
                <span className="panel-error">
                  {end.error instanceof Error ? end.error.message : '总结失败'}
                </span>
              )}
            </div>
          )}
        </section>
        <ScenePanel
          scenario={detail.scenario}
          sessionId={detail.id}
          turnId={[...detail.turns].reverse().find((turn) => turn.role === 'assistant')?.id}
          assistantText={
            [...detail.turns].reverse().find((turn) => turn.role === 'assistant')?.text ?? null
          }
        />
      </div>
    </div>
  )
}

/* ---- 路由入口：按查询参数分发 ---- */

export function TalkSessionPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const reviewId = params.get('id')
  const mode = params.get('mode')
  const scenarioKey = params.get('scenario') ?? undefined
  const rawDiff = params.get('difficulty')
  const difficulty: TalkDifficulty =
    rawDiff === 'easy' || rawDiff === 'hard' ? rawDiff : 'medium'
  // 语音陪读：?article={id} 建会话时透传文章上下文
  const rawArticle = params.get('article')
  const articleId =
    rawArticle !== null && /^\d+$/.test(rawArticle) ? Number(rawArticle) : undefined
  const rawDeployment = params.get('deployment')
  const deploymentId =
    rawDeployment !== null && /^\d+$/.test(rawDeployment)
      ? Number(rawDeployment)
      : undefined

  useEffect(() => {
    if (!reviewId && !mode) navigate('/talk', { replace: true })
  }, [reviewId, mode, navigate])

  if (reviewId) return <ReviewSession key={reviewId} sessionId={reviewId} />
  if (mode === 'realtime')
    return (
      <RealtimeSessionPage
        key={`${scenarioKey ?? 'free'}-${difficulty}-${articleId ?? 'na'}-${deploymentId ?? 'global'}`}
        scenarioKey={scenarioKey}
        difficulty={difficulty}
        articleId={articleId}
        deploymentId={deploymentId}
      />
    )
  if (mode) return <LiveTurnSession key={`${scenarioKey ?? 'free'}-${difficulty}`} scenarioKey={scenarioKey} difficulty={difficulty} resumeId={params.get('live') ?? undefined} />
  return null
}
