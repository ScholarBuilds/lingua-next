import { useQuery, useQueryClient } from '@tanstack/react-query'
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { useLocation, useNavigate } from 'react-router-dom'

import { IconAlert, IconSpeaker } from '../../components/icons'
import { Topbar } from '../../components/Topbar'
import { api, talkRealtimeWsUrl } from '../../lib/api'
import type { TalkDifficulty, TalkScenario } from '../../lib/api'
import { apiM5 } from '../../lib/api-m5'
import { MicCapture, PcmPlayer } from './realtimeAudio'
import { ScenePanel } from './ScenePanel'
import { TalkAvatar } from './TalkAvatar'
import { TalkRecordsDialog } from './TalkRecordsDialog'
import { TalkReplaySettings } from './TalkReplaySettings'
import { useAutoCoach } from './useAutoCoach'
import { beforeAudioPlay, stopTts } from '../../lib/audio'
import { usePrefStore } from '../../lib/prefStore'
import { useWordModalStore } from '../reader/wordModalStore'

const DIFF_LABEL: Record<string, string> = { easy: '简单', medium: '适中', hard: '挑战' }
const SESSION_CAP_S = 30 * 60

type RtStatus = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'ended' | 'error'

interface CapLine {
  id: string
  turnId?: number
  complete?: boolean
  role: 'user' | 'ai'
  text: string
  /** 用户 interim 转写 / AI 增量中，灰色显示 */
  interim: boolean
}

interface WsFrame {
  type: string
  text?: string
  final?: boolean
  message?: string
  session_id?: number
  message_id?: string
  turn_id?: number
  role?: string
  complete?: boolean
}

const STATUS_TEXT: Record<RtStatus, string> = {
  connecting: '连接中…',
  listening: '正在聆听 · 直接开口即可',
  thinking: '正在想怎么回答…',
  speaking: 'AI 正在说话 · 开口即可打断',
  ended: '会话已结束，正在生成回顾…',
  error: '会话出错',
}

function fmtClock(s: number): string {
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

function useRealtimeRuntime({
  scenarioKey,
  difficulty,
  articleId,
  deploymentId,
}: {
  scenarioKey?: string
  difficulty: TalkDifficulty
  /** 语音陪读：注入该文章上下文（来自 ?article= 查询参数） */
  articleId?: number
  /** 本次会话显式实时语音部署；留空跟随能力绑定。 */
  deploymentId?: number
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  // 陪读文章标题：仅取 title 展示在顶栏
  const articleQuery = useQuery({
    queryKey: ['article', articleId],
    queryFn: () => api.article(articleId!),
    enabled: articleId !== undefined,
    staleTime: Infinity,
  })
  const [status, setStatus] = useState<RtStatus>('connecting')
  const [scenario, setScenario] = useState<TalkScenario | null>(null)
  const [sessionId, setSessionId] = useState<number | null>(null)
  const [lines, setLines] = useState<CapLine[]>([])
  const [elapsed, setElapsed] = useState(0)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [micError, setMicError] = useState<string | null>(null)
  const [audioBlocked, setAudioBlocked] = useState(false)
  const [recordsOpen, setRecordsOpen] = useState(false)
  const [paused, setPaused] = useState(false)
  const [ending, setEnding] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const failedSaves = useRef(new Set<string>())
  const pausedRef = useRef(false)
  const stopRequestedRef = useRef(false)
  const micRef = useRef<MicCapture | null>(null)
  const wordOpen = useWordModalStore((s) => s.stack.length > 0)
  const autoCoach = usePrefStore((s) => s.prefs.talk.autoCoach)
  useAutoCoach(sessionId, lines, autoCoach)
  const practiceRef = useRef(false)
  const [practicing, setPracticing] = useState(false)

  const wsRef = useRef<WebSocket | null>(null)
  const playerRef = useRef<PcmPlayer | null>(null)
  const capIdRef = useRef(0)
  const capsRef = useRef<HTMLDivElement>(null)

  const pauseInput = () => {
    pausedRef.current = true
    setPaused(true)
    micRef.current?.setMuted(true)
    playerRef.current?.flush()
  }
  useEffect(() => beforeAudioPlay(pauseInput), [])
  useEffect(() => { if (wordOpen) pauseInput() }, [wordOpen])

  useEffect(() => {
    let alive = true
    stopRequestedRef.current = false
    const player = new PcmPlayer()
    const mic = new MicCapture()
    micRef.current = mic
    let ws: WebSocket | null = null
    let tick: ReturnType<typeof setInterval> | undefined
    let speakTimer: ReturnType<typeof setTimeout> | undefined
    let sid: number | null = null
    let endRequested = false
    let errored = false

    playerRef.current = player

    const nextId = () => {
      capIdRef.current += 1
      return `local-${capIdRef.current}`
    }

    const safeStatus = (next: RtStatus) =>
      setStatus((cur) => (cur === 'ended' || cur === 'error' ? cur : next))

    const cancelSpeakTimer = () => {
      if (speakTimer !== undefined) {
        clearTimeout(speakTimer)
        speakTimer = undefined
      }
    }

    /** tts_end 后等本地队列播完再回到聆听态 */
    const scheduleListening = () => {
      cancelSpeakTimer()
      speakTimer = setTimeout(
        () => setStatus((cur) => (cur === 'speaking' || cur === 'thinking' ? 'listening' : cur)),
        Math.max(120, player.remaining() * 1000),
      )
    }

    const pushAiLine = (text: string, id = nextId()) =>
      setLines((ls) => ls.some((l) => l.id === id) ? ls : [...ls, { id, role: 'ai', text, interim: false }])

    const appendAiDelta = (delta: string, id?: string) =>
      setLines((ls) => {
        if (id) {
          const found = ls.find((l) => l.id === id)
          return found ? ls.map((l) => l.id === id && l.interim ? { ...l, text: l.text + delta } : l)
            : [...ls, { id, role: 'ai', text: delta, interim: true }]
        }
        const last = ls[ls.length - 1]
        if (last && last.role === 'ai' && last.interim)
          return [...ls.slice(0, -1), { ...last, text: last.text + delta }]
        return [...ls, { id: nextId(), role: 'ai', text: delta, interim: true }]
      })

    const finalizeLast = (role: CapLine['role'], id?: string, text?: string) =>
      setLines((ls) => {
        if (id) return ls.map((l) => l.id === id ? { ...l, interim: false, text: text || l.text } : l)
        const last = ls[ls.length - 1]
        if (last && last.role === role && last.interim)
          return [...ls.slice(0, -1), { ...last, interim: false }]
        return ls
      })

    const upsertUserLine = (text: string, interim: boolean, id?: string) =>
      setLines((ls) => {
        if (id) return ls.some((l) => l.id === id)
          ? ls.map((l) => l.id === id ? { ...l, text, interim: true } : l)
          : [...ls, { id, role: 'user', text, interim: true }]
        const last = ls[ls.length - 1]
        if (last && last.role === 'user' && last.interim)
          return [...ls.slice(0, -1), { ...last, text, interim }]
        return [...ls, { id: nextId(), role: 'user', text, interim }]
      })

    const teardownAudio = (stopReplay = true) => {
      if (stopReplay) stopTts()
      cancelSpeakTimer()
      mic.stop()
      player.close()
      if (tick !== undefined) clearInterval(tick)
    }

    const fail = (msg: string) => {
      errored = true
      setErrorMsg(msg)
      setStatus('error')
      teardownAudio(!pausedRef.current)
    }

    const finish = () => {
      setEnding(false)
      teardownAudio(!pausedRef.current)
      if (sid != null) void queryClient.invalidateQueries({ queryKey: ['talk-records', String(sid)] })
      if (errored) return
      setStatus('ended')
    }

    const handleMessage = (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') {
        if (practiceRef.current || pausedRef.current) return
        // 二进制帧 = 24k float32 PCM，入播放队列
        player.enqueue(ev.data as ArrayBuffer)
        safeStatus('speaking')
        return
      }
      let msg: WsFrame
      try {
        msg = JSON.parse(ev.data) as WsFrame
      } catch {
        return
      }
      switch (msg.type) {
        case 'started':
          safeStatus('listening')
          tick = setInterval(() => setElapsed((e) => e + 1), 1000)
          break
        case 'opening':
          if (msg.text) pushAiLine(msg.text, msg.message_id)
          break
        case 'asr':
          if (typeof msg.text === 'string') upsertUserLine(msg.text, msg.final !== true, msg.message_id)
          break
        case 'asr_end':
          finalizeLast('user', msg.message_id, msg.text)
          safeStatus('thinking')
          break
        case 'user_start':
          // 打断验收点：立即停止并清空本地播放队列
          player.flush()
          cancelSpeakTimer()
          safeStatus('listening')
          break
        case 'reply':
          if (msg.text) appendAiDelta(msg.text, msg.message_id)
          break
        case 'reply_end':
          finalizeLast('ai', msg.message_id)
          break
        case 'turn_saved':
          if (msg.message_id && msg.turn_id != null) {
            const line: CapLine = { id: msg.message_id, turnId: msg.turn_id,
              role: msg.role === 'user' ? 'user' : 'ai', text: msg.text ?? '', interim: false, complete: msg.complete }
            setLines((ls) => ls.some((l) => l.id === line.id) ? ls.map((l) => l.id === line.id ? line : l) : [...ls, line])
            failedSaves.current.delete(msg.message_id)
            if (!failedSaves.current.size) setSaveError(null)
            void queryClient.invalidateQueries({ queryKey: ['talk-records', String(sid)] })
          }
          break
        case 'save_error':
          if (msg.message_id) failedSaves.current.add(msg.message_id)
          setSaveError(msg.message ?? '消息保存失败')
          break
        case 'tts_end':
          scheduleListening()
          break
        case 'finished':
          endRequested = true
          break
        case 'error':
          fail(msg.message ?? '实时会话出错')
          break
      }
    }

    const init = async () => {
      let created
      try {
        created = await apiM5.createRealtimeSession({
          scenario_key: scenarioKey,
          difficulty,
          article_id: articleId,
          deployment_id: deploymentId,
        })
      } catch (err) {
        if (alive) fail(err instanceof Error ? err.message : '实时会话创建失败')
        return
      }
      if (!alive || stopRequestedRef.current) {
        void api.endTalkSession(created.session_id).catch(error => {
          useLiveSession.setState({ abandonedError: error instanceof Error ? error.message : '未能结束创建中的会话' })
        })
        return
      }
      sid = created.session_id
      setSessionId(created.session_id)
      setScenario(created.scenario)

      ws = new WebSocket(talkRealtimeWsUrl(created.ws_path))
      ws.binaryType = 'arraybuffer'
      wsRef.current = ws
      ws.onmessage = handleMessage
      ws.onopen = () => {
        if (!alive) return
        if (stopRequestedRef.current) {
          ws?.send(JSON.stringify({ type: 'end' }))
          return
        }
        void player.resume().then(() => {
          if (alive) setAudioBlocked(player.blocked)
        })
        mic
          .start((pcm) => {
            if (!practiceRef.current && !pausedRef.current && ws?.readyState === WebSocket.OPEN) ws.send(pcm.buffer)
          })
          .then(() => {
            if (!alive || stopRequestedRef.current) mic.stop()
            else mic.setMuted(pausedRef.current || practiceRef.current)
          })
          .catch((err: unknown) => {
            if (alive) setMicError(err instanceof Error ? err.message : '麦克风启动失败')
          })
      }
      ws.onerror = () => {
        if (alive && !endRequested) fail('实时连接失败，请确认服务端已启动')
      }
      ws.onclose = () => {
        if (alive) finish()
      }
    }

    const startTimer = setTimeout(() => { void init() }, 0)

    return () => {
      alive = false
      clearTimeout(startTimer)
      teardownAudio()
      if (ws) {
        ws.onopen = null
        ws.onmessage = null
        ws.onerror = null
        ws.onclose = null
        try {
          ws.close()
        } catch {
          /* 尚未建立的连接 close 可能抛错 */
        }
      }
      wsRef.current = null
      playerRef.current = null
      micRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenarioKey, difficulty, articleId, deploymentId])

  useEffect(() => {
    const el = capsRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  const endSession = () => {
    stopRequestedRef.current = true
    pauseInput()
    stopTts()
    setEnding(true)
    playerRef.current?.flush()
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'end' }))
    } else {
      setEnding(false)
      setStatus('ended')
    }
  }

  const enableAudio = () => {
    void playerRef.current?.resume().then(() => setAudioBlocked(false))
  }


  const latestAssistant = [...lines]
    .reverse()
    .find((line) => line.role === 'ai' && !line.interim)

  return { navigate, articleId, difficulty, articleQuery, status, scenario, sessionId, lines, elapsed, errorMsg, micError, audioBlocked, recordsOpen, setRecordsOpen, paused, setPaused, ending, saveError, setSaveError, pausedRef, micRef, playerRef, practiceRef, practicing, setPracticing, wordOpen, capsRef, pauseInput, endSession, enableAudio, latestAssistant }
}

type LiveModel = ReturnType<typeof useRealtimeRuntime>
type LiveConfig = { scenarioKey?: string; difficulty: TalkDifficulty; articleId?: number; deploymentId?: number }
const useLiveSession = create<{
  config: LiveConfig | null; route: string; model: LiveModel | null; abandonedError: string | null
}>(() => ({ config: null, route: '', model: null, abandonedError: null }))

const SessionController = memo(function SessionController({ config }: { config: LiveConfig }) {
  const model = useRealtimeRuntime(config)
  const { pathname, search } = useLocation()
  const route = useLiveSession(s => s.route)
  const visible = pathname + search === route
  useLayoutEffect(() => { useLiveSession.setState({ model }) })
  useLayoutEffect(() => {
    if (!visible) { model.pauseInput(); stopTts(); model.setRecordsOpen(false) }
  }, [visible])
  return null
})

export function RealtimeSessionHost() {
  const abandonedError = useLiveSession(s => s.abandonedError)
  const config = useLiveSession(s => s.config)
  const model = useLiveSession(s => s.model)
  const route = useLiveSession(s => s.route)
  const location = useLocation()
  const navigate = useNavigate()
  const away = location.pathname + location.search !== route
  return <>
    {abandonedError && <div className="workspace-live-status" role="alert">会话清理失败：{abandonedError}。请在练习记录中检查会话状态。</div>}
    {config && <SessionController config={config} />}
    {away && model && <div className="workspace-live-status" role="status">
      {model.saveError ? '对话记录保存失败，请返回重试' : model.status === 'ended' || model.status === 'error' ? '对话连接已结束，可查看已保存记录' : '对话收音已暂停 · 远端仍计时'}
      <button onClick={() => navigate(route)}>返回对话</button>
      <button disabled={model.ending} onClick={() => {
        if (model.status === 'ended' || model.status === 'error') useLiveSession.setState({ config: null, model: null })
        else model.endSession()
      }}>{model.status === 'ended' || model.status === 'error' ? '关闭' : '结束会话'}</button>
    </div>}
  </>
}

export function RealtimeSessionPage(config: LiveConfig) {
  const existing = useLiveSession(s => s.config)
  const model = useLiveSession(s => s.model)
  const route = useLiveSession(s => s.route)
  const location = useLocation()
  const navigate = useNavigate()
  const same = existing !== null && JSON.stringify(existing) === JSON.stringify(config)
  const [preparing, setPreparing] = useState(false)
  const [preflightError, setPreflightError] = useState<string | null>(null)
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  if (!existing) return <section className="state-block talk-preflight">
    <h2>准备开始对话</h2>
    <p>开始后使用麦克风并连接语音服务。离开页面会暂停收音，远端仍计时。</p>
    <p>刷新或重启不会自动恢复连接；已有记录可在练习记录中查看。</p>
    {preflightError && <p role="alert">{preflightError}</p>}
    <button className="btn btn-primary" disabled={preparing} onClick={async () => {
      setPreparing(true); setPreflightError(null)
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        stream.getTracks().forEach(track => track.stop())
        if (active.current && !useLiveSession.getState().config) useLiveSession.setState({ config, route: location.pathname + location.search })
      } catch (error) { if (active.current) setPreflightError(error instanceof Error ? error.message : '无法使用麦克风') }
      finally { if (active.current) setPreparing(false) }
    }}>{preparing ? '检查麦克风…' : '开始实时对话'}</button>
    <button className="btn" onClick={() => navigate('/talk?tab=history')}>查看练习记录</button>
  </section>
  if (existing && !same) return <div className="state-block">
    <p>已有一场实时对话，请先返回或结束当前会话。</p>
    <button className="btn" onClick={() => navigate(route)}>返回当前对话</button>
    <button className="btn" disabled={model?.ending} onClick={() => {
      if (model?.status === 'ended' || model?.status === 'error') useLiveSession.setState({ config: null, model: null })
      else model?.endSession()
    }}>结束当前会话</button>
  </div>
  return model && same ? <RealtimeSessionView model={model} /> : <div className="state-block">正在准备对话…</div>
}

function RealtimeSessionView({ model }: { model: LiveModel }) {
  const { navigate, articleId, difficulty, articleQuery, status, scenario, sessionId, lines, elapsed, errorMsg, micError, audioBlocked, recordsOpen, setRecordsOpen, paused, setPaused, ending, saveError, setSaveError, pausedRef, micRef, playerRef, practiceRef, practicing, setPracticing, wordOpen, capsRef, pauseInput, endSession, enableAudio, latestAssistant } = model
  return (
    <div className="main talk-live-page">
      <Topbar
        back={{ to: '/talk', label: '对话' }}
        crumbs={[{ label: '对话', to: '/talk' }]}
        title={
          articleId !== undefined
            ? `陪读中：${articleQuery.data?.title ?? '加载文章…'}`
            : scenario
              ? scenario.title
              : '自由话题'
        }
        meta={
          <>
            {scenario && <span className="chip accent">{scenario.level}</span>}
            <span className="chip">{DIFF_LABEL[difficulty] ?? difficulty}</span>
            <span className="chip accent">实时语音</span>
          </>
        }
        actions={
          <>
            <button className="btn btn-outline" disabled={sessionId === null} onClick={() => {
              pauseInput(); stopTts(); setRecordsOpen(true)
            }}>对话记录 {lines.length}</button>
            <button className="btn btn-outline" disabled={ending || status === 'connecting' || status === 'ended' || status === 'error' || practicing || wordOpen || recordsOpen}
              onClick={() => {
                if (!paused) { pauseInput(); stopTts(); return }
                stopTts(); playerRef.current?.flush(); micRef.current?.setMuted(false)
                pausedRef.current = false; setPaused(false)
              }}>{paused ? '继续对话' : '暂停收音'}</button>
            <TalkReplaySettings onOpen={pauseInput} />
            <span className="timer">
              {fmtClock(Math.min(elapsed, SESSION_CAP_S))} / {fmtClock(SESSION_CAP_S)}
            </span>
            <button
              className="btn btn-end"
              onClick={endSession}
              disabled={ending || status === 'connecting' || status === 'ended'}
            >
              {ending ? '正在结束…' : '结束会话'}
            </button>
          </>
        }
      />

      <div className="body-row">
        <section className="talk-stage">
          {status === 'error' ? (
            <div className="state-block" style={{ flex: 1 }}>
              <IconAlert />
              <div>{errorMsg ?? '实时会话出错'}</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-outline" onClick={() => navigate('/talk')}>
                  返回场景
                </button>
                <button className="btn btn-outline" onClick={() => navigate('/settings/network')}>网络与代理设置</button>
                {sessionId != null && (
                  <button
                    className="btn btn-soft"
                    onClick={() => navigate(`/talk/session?id=${sessionId}`, { replace: true })}
                  >
                    查看回顾
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="rt-center rt-with-avatar">
              <TalkAvatar status={status} readLevel={() => playerRef.current?.audioLevel() ?? 0} readBrightness={() => playerRef.current?.audioBrightness() ?? 0.5} />
              <div className="rt-status" role="status">{ending ? '正在保存记录并结束会话…' : status === 'ended' ? '会话已结束，请在记录中查看保存结果' : practicing ? '跟读练习中 · 实时对话收音已暂停' : paused ? '收音已暂停 · 点击继续对话恢复' : STATUS_TEXT[status]}</div>
              {paused && status !== 'ended' && <p className="coach-empty">远端会话仍计时；3 分钟无上行会自动结束。</p>}
              {status === 'ended' && sessionId && <button className="btn" onClick={() => navigate(`/talk/session?id=${sessionId}`)}>查看回顾与总结</button>}

              {micError && (
                <div className="rt-alert">
                  <IconAlert />
                  {micError}
                </div>
              )}
              {audioBlocked && (
                <button className="btn btn-soft" onClick={enableAudio}>
                  <IconSpeaker />
                  点击开启声音
                </button>
              )}

              <div className="rt-caps" ref={capsRef}>
                {lines.length === 0 && status !== 'connecting' && (
                  <div className="rt-caps-empty">字幕会实时显示在这里</div>
                )}
                {lines.slice(-2).map((l) => (
                  <div
                    key={l.id}
                    className={`cap-line ${l.role}${l.interim ? ' interim' : ''}`}
                  >
                    <i>{l.role === 'user' ? '你' : 'AI'}</i>
                    {l.text}
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
        <ScenePanel
          scenario={scenario}
          sessionId={sessionId}
          assistantText={latestAssistant?.text ?? null}
          turnId={latestAssistant?.turnId}
          realtime
          suspendPractice={ending || recordsOpen || status === 'ended' || status === 'error'}
          onPracticeChange={(active) => {
            practiceRef.current = active
            setPracticing(active)
            if (active) { pauseInput(); stopTts() }
          }}
        />
      </div>
      {saveError && <div className="talk-save-error" role="alert">{saveError}<button onClick={() => {
        void navigator.clipboard.writeText(lines.map((l) => `${l.role === 'ai' ? 'AI' : '你'}：${l.text}`).join('\n')).catch(() => setSaveError('复制失败，请选中字幕复制'))
      }}>复制全部字幕</button></div>}
      {recordsOpen && sessionId !== null && <TalkRecordsDialog sessionId={sessionId} onClose={() => setRecordsOpen(false)} />}
    </div>
  )
}
