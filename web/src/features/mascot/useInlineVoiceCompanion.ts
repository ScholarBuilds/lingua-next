/* 驻页语音陪读：不跳页，在阅读页内直接建立火山实时语音会话。
   采集复用 ../talk/realtimeAudio.ts 的 MicCapture；播放用本目录带音量分析的
   AnalyserPcmPlayer（嘴型驱动）。WS 协议与 talk/RealtimeSessionPage 一致，
   额外上行 {"type":"context","text":...} 点句上下文帧（后端转 ChatTextQuery）。 */

import { useEffect } from 'react'
import { create } from 'zustand'

import { api, talkRealtimeWsUrl } from '../../lib/api'
import { apiM5 } from '../../lib/api-m5'
import { pendingRefs, refToPrompt, useCompanionContext } from '../companion/contextStore'
import { MicCapture } from '../talk/realtimeAudio'
import { AnalyserPcmPlayer } from './analyserPlayer'

export type VoiceStatus = 'idle' | 'connecting' | 'listening' | 'speaking' | 'ended' | 'error'

export interface VoiceLine {
  id: number
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
}

interface VoiceCompanionState {
  status: VoiceStatus
  /** 会话绑定的文章，其他文章的面板不显示本会话 */
  articleId: number | null
  /** 陪读来源类型：文章 13 与视频 13 是两回事，只比 id 会误判为同一会话 */
  sourceKind: 'article' | 'video' | 'grammar' | null
  grammarKey: string | null
  sessionId: number | null
  lines: VoiceLine[]
  elapsed: number
  error: string | null
  micError: string | null
  /** 麦克风不可用时启用了合成上行流（ln-dev-fake-mic=1），状态条显示"模拟麦克风" */
  fakeMic: boolean
  audioBlocked: boolean
}

const IDLE_STATE: VoiceCompanionState = {
  status: 'idle',
  articleId: null,
  sourceKind: null,
  grammarKey: null,
  sessionId: null,
  lines: [],
  elapsed: 0,
  error: null,
  micError: null,
  fakeMic: false,
  audioBlocked: false,
}

export const useVoiceCompanionStore = create<VoiceCompanionState>(() => ({ ...IDLE_STATE }))

const set = useVoiceCompanionStore.setState
const get = useVoiceCompanionStore.getState

export const VOICE_STATUS_TEXT: Record<VoiceStatus, string> = {
  idle: '',
  connecting: '连接中…',
  listening: '聆听中 · 直接开口即可',
  speaking: 'AI 正在说话 · 开口可打断',
  ended: '语音陪读已结束',
  error: '语音陪读出错',
}

/* ---- 单例会话资源（同时只允许一场语音陪读） ---- */

interface LiveSession {
  ws: WebSocket | null
  mic: MicCapture
  player: AnalyserPcmPlayer
  tick: ReturnType<typeof setInterval> | undefined
  speakTimer: ReturnType<typeof setTimeout> | undefined
  /** 麦克风不可用时的静音保活（火山无上行音频约 10s 报 DialogAudioIdleTimeout） */
  silenceTimer: ReturnType<typeof setInterval> | undefined
  unsubscribeReader: (() => void) | null
  alive: boolean
}

let live: LiveSession | null = null
let lineId = 0

/** 开发/无麦环境的合成上行开关 */
const FAKE_MIC_KEY = 'ln-dev-fake-mic'

/** 看板娘嘴型驱动：AI 说话时的下行音量 0~1 */
export function getVoiceLevel(): number {
  if (live === null || get().status !== 'speaking') return 0
  return live.player.level()
}

function activeStatus(): boolean {
  const s = get().status
  return s === 'connecting' || s === 'listening' || s === 'speaking'
}

/** listening/speaking 之间的切换不覆盖终态 */
function safeStatus(next: VoiceStatus): void {
  const s = get().status
  if (s === 'ended' || s === 'error' || s === 'idle') return
  set({ status: next })
}

function pushLine(role: VoiceLine['role'], text: string, interim: boolean): void {
  lineId += 1
  set({ lines: [...get().lines, { id: lineId, role, text, interim }] })
}

function appendAiDelta(delta: string): void {
  const lines = get().lines
  const last = lines[lines.length - 1]
  if (last !== undefined && last.role === 'ai' && last.interim) {
    set({ lines: [...lines.slice(0, -1), { ...last, text: last.text + delta }] })
  } else {
    pushLine('ai', delta, true)
  }
}

function finalizeLast(role: VoiceLine['role']): void {
  const lines = get().lines
  const last = lines[lines.length - 1]
  if (last !== undefined && last.role === role && last.interim) {
    set({ lines: [...lines.slice(0, -1), { ...last, interim: false }] })
  }
}

function upsertUserLine(text: string, interim: boolean): void {
  const lines = get().lines
  const last = lines[lines.length - 1]
  if (last !== undefined && last.role === 'user' && last.interim) {
    set({ lines: [...lines.slice(0, -1), { ...last, text, interim }] })
  } else {
    pushLine('user', text, interim)
  }
}

function teardown(session: LiveSession): void {
  session.alive = false
  session.unsubscribeReader?.()
  session.unsubscribeReader = null
  if (session.speakTimer !== undefined) clearTimeout(session.speakTimer)
  if (session.tick !== undefined) clearInterval(session.tick)
  if (session.silenceTimer !== undefined) clearInterval(session.silenceTimer)
  session.mic.stop()
  session.player.close()
  const ws = session.ws
  if (ws !== null) {
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
  session.ws = null
  if (live === session) live = null
}

function fail(session: LiveSession, msg: string): void {
  if (!session.alive) return
  set({ status: 'error', error: msg })
  teardown(session)
}

/* ---- 会话生命周期 ---- */

/** 陪读来源：文章或视频（07 v2 FR-17）。videoId 会带上当前学习句用于截断定位。 */
export interface CompanionSource {
  grammar?: { sentence: string; analysis: string; source: string }
  articleId?: number
  videoId?: number
  unitOrdinal?: number
}

export function startVoiceCompanion(source: number | CompanionSource): void {
  const src: CompanionSource =
    typeof source === 'number' ? { articleId: source } : source
  const articleId = src.articleId ?? src.videoId ?? 0
  const sourceKind = src.grammar !== undefined ? 'grammar' : src.videoId !== undefined ? 'video' : 'article'
  const grammarKey = src.grammar !== undefined ? JSON.stringify(src.grammar) : null
  const sourceBody = {
    ...(src.grammar !== undefined ? { grammar_context: src.grammar } : {}),
    ...(src.articleId !== undefined ? { article_id: src.articleId } : {}),
    ...(src.videoId !== undefined ? { video_id: src.videoId } : {}),
    ...(src.unitOrdinal !== undefined ? { unit_ordinal: src.unitOrdinal } : {}),
  }
  if (live !== null) {
    if (get().articleId === articleId && get().sourceKind === sourceKind && get().grammarKey === grammarKey && activeStatus()) {
      return // 已在进行中
    }
    destroyVoiceCompanion()
  }
  lineId = 0
  set({ ...IDLE_STATE, status: 'connecting', articleId, sourceKind, grammarKey })

  const session: LiveSession = {
    ws: null,
    mic: new MicCapture(),
    player: new AnalyserPcmPlayer(),
    tick: undefined,
    speakTimer: undefined,
    silenceTimer: undefined,
    unsubscribeReader: null,
    alive: true,
  }
  live = session

  /* 引用只是"AI 待会儿要看的"，加了不发（FR-311）。
     火山的 ChatTextQuery(501) 语义就是用户提问，模型收到必答——加个引用就抢答，
     等于点一下句子 AI 就开始讲，用户根本没问。引用改为随下一次提问一起送出。 */

  const cancelSpeakTimer = () => {
    if (session.speakTimer !== undefined) {
      clearTimeout(session.speakTimer)
      session.speakTimer = undefined
    }
  }

  /** tts_end 后等本地队列播完再回到聆听态 */
  const scheduleListening = () => {
    cancelSpeakTimer()
    session.speakTimer = setTimeout(
      () => safeStatus('listening'),
      Math.max(120, session.player.remaining() * 1000),
    )
  }

  const finish = () => {
    if (!session.alive) return
    const s = get().status
    teardown(session)
    if (s !== 'error') set({ status: 'ended' })
  }

  const handleMessage = (ev: MessageEvent) => {
    if (!session.alive) return
    if (typeof ev.data !== 'string') {
      // 二进制帧 = 24k float32 PCM，入播放队列并驱动嘴型
      session.player.enqueue(ev.data as ArrayBuffer)
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
        session.tick = setInterval(() => set({ elapsed: get().elapsed + 1 }), 1000)
        break
      case 'opening':
        if (msg.text !== undefined && msg.text !== '') pushLine('ai', msg.text, false)
        break
      case 'asr':
        if (typeof msg.text === 'string') upsertUserLine(msg.text, msg.final !== true)
        break
      case 'asr_end':
        finalizeLast('user')
        break
      case 'user_start':
        // 用户开口打断：立即停止并清空本地播放队列
        session.player.flush()
        cancelSpeakTimer()
        safeStatus('listening')
        break
      case 'reply':
        if (msg.text !== undefined && msg.text !== '') appendAiDelta(msg.text)
        break
      case 'reply_end':
        finalizeLast('ai')
        break
      case 'tts_end':
        scheduleListening()
        break
      case 'finished':
        finish()
        break
      case 'error':
        fail(session, msg.message ?? '实时会话出错')
        break
    }
  }

  void (async () => {
    let created
    try {
      created = await apiM5.createRealtimeSession(sourceBody)
    } catch (err) {
      fail(session, err instanceof Error ? err.message : '实时会话创建失败')
      return
    }
    if (!session.alive) {
      void api.endTalkSession(created.session_id).catch((error: unknown) => {
        console.warn('结束未连接的语音会话失败', error)
      })
      return
    }
    set({ sessionId: created.session_id })

    const ws = new WebSocket(talkRealtimeWsUrl(created.ws_path))
    ws.binaryType = 'arraybuffer'
    session.ws = ws
    ws.onmessage = handleMessage
    ws.onopen = () => {
      if (!session.alive) return
      void session.player.resume().then(() => {
        if (session.alive) set({ audioBlocked: session.player.blocked })
      })
      session.mic
        .start((pcm) => {
          if (session.ws?.readyState === WebSocket.OPEN) session.ws.send(pcm.buffer)
        })
        .catch((err: unknown) => {
          if (!session.alive) return
          const fake = localStorage.getItem(FAKE_MIC_KEY) === '1'
          if (fake) set({ fakeMic: true })
          else set({ micError: err instanceof Error ? err.message : '麦克风启动失败' })
          // 无麦克风也能"只听 + 点句"：上行保活帧避免火山音频空闲超时断会话。
          // ln-dev-fake-mic=1 时改为"静音 + 间歇低幅提示音"的合成流（数值合成 PCM，
          // 与 Oscillator→MediaStreamDestination 在线路上等价，免复制 talk 采集管线），
          // 让上行链路真实携带非零音频；ASR 转写为空/噪声属预期
          let frame = 0
          const chunk = new Int16Array(1600) // 100ms @ 16kHz
          session.silenceTimer = setInterval(() => {
            if (session.ws?.readyState !== WebSocket.OPEN) return
            frame += 1
            chunk.fill(0)
            // 每 ~12s 插入 200ms 的 440Hz 低幅正弦（帧 120、121）
            if (fake && frame % 120 <= 1) {
              for (let i = 0; i < chunk.length; i += 1) {
                chunk[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 16000) * 0x7fff * 0.05)
              }
            }
            session.ws.send(chunk.buffer)
          }, 100)
        })
    }
    ws.onerror = () => {
      if (session.alive && activeStatus()) fail(session, '实时连接失败，请确认服务端已启动')
    }
    ws.onclose = () => finish()
  })()
}

/** 用户点结束：通知服务端收尾，本地立即停音并转历史 */
/** 主动给 AI 发一句话（快捷追问、文字输入、主动检验都走这条）。

    与点句注入同一条 ChatTextQuery 通道；未连接时静默忽略，由调用方先起会话。 */
/** AI 空闲（连着但没在说话）：主动检验只在这个时机发起，不打断当前对话（BR-08）。 */
export function voiceIdle(): boolean {
  return get().status === 'listening'
}

export function sendCompanionText(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === '' || live === null) return false
  const ws = live.ws
  if (ws === null || ws.readyState !== WebSocket.OPEN) return false
  // 攒着的引用随这次提问一并出去，AI 才知道"这句"指的是哪句（FR-311）
  const waiting = get().sourceKind === 'grammar' ? [] : pendingRefs()
  const body =
    waiting.length > 0
      ? `${waiting.map(refToPrompt).join('\n')}\n\n${trimmed}`
      : trimmed
  ws.send(JSON.stringify({ type: 'ask', text: body }))
  if (get().sourceKind === 'grammar') pushLine('user', trimmed, false)
  if (waiting.length > 0) useCompanionContext.getState().markSent()
  return true
}


export function stopVoiceCompanion(): void {
  const session = live
  if (session === null) return
  session.player.flush()
  const ws = session.ws
  if (ws !== null && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'end' }))
  }
  teardown(session)
  if (activeStatus() || get().status === 'connecting') set({ status: 'ended' })
}

/** 硬清理：离开阅读页 / 切章时调用，终态也归零 */
export function destroyVoiceCompanion(): void {
  const session = live
  if (session !== null) {
    const ws = session.ws
    if (ws !== null && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'end' }))
      } catch {
        /* 忽略 */
      }
    }
    teardown(session)
  }
  set({ ...IDLE_STATE })
}

/** 结束后收起历史字幕 */
export function dismissVoiceHistory(): void {
  const s = get().status
  if (s === 'ended' || s === 'error') set({ ...IDLE_STATE })
}

/** 自动播放被浏览器拦截时，用户手势后恢复 */
export function resumeVoiceAudio(): void {
  const session = live
  if (session === null) return
  void session.player.resume().then(() => {
    if (session.alive) set({ audioBlocked: session.player.blocked })
  })
}

/** 阅读页装载：绑定清理时机（切章 / 卸载时结束会话） */
export function useInlineVoiceCompanion(articleId: string): void {
  useEffect(() => () => destroyVoiceCompanion(), [articleId])
}
