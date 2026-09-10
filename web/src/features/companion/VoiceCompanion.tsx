/* 语音优先 AI 陪读（需求 07 v2 FR-282~288）。

   陪读就是「跟 AI 说话」，不是「跟 AI 打字」。所以这里没有输入框：开口即可，
   说不出来时点快捷提问，文本经同一条 realtime 会话下发（ChatTextQuery），
   与语音共用上下文，不再像旧版文章页那样维护 SSE 文字问答的第二条链路。

   文章、场景短文、视频三处共用本组件，差异只在 source / 文案 / 快捷问法。 */

import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { IconClose, IconSparkle, IconVoice } from '../../components/icons'
import { readerApi } from '../../lib/api-reader-m5'
import { ClickableEn } from '../reader/ClickableEn'
import {
  VOICE_STATUS_TEXT,
  getVoiceLevel,
  resumeVoiceAudio,
  sendCompanionText,
  startVoiceCompanion,
  stopVoiceCompanion,
  useVoiceCompanionStore,
} from '../mascot/useInlineVoiceCompanion'
import { ContextRefs } from './ContextRefs'
import { isQuizEnabled, resetQuiz, setQuizEnabled } from './quiz'
import './companion.css'

/** 会话中的追问：口语组织成本高，常问的一键发出（FR-18） */
export const FOLLOWUPS_DEFAULT = [
  '再简单点讲一遍',
  '举个例子',
  '这个词还有别的意思吗',
  '这句语法是什么结构',
  '日常口语里会怎么说',
]

/** 开场白：还没开口时点它，连上就直接把这个问题抛给 AI */
export const OPENERS_DEFAULT = ['这段讲了什么', '挑几个重点词讲讲', '带我读一遍']

export type CompanionSourceProp =
  | { articleId: number }
  | { videoId: number; unitOrdinal?: number }

interface VoiceCompanionProps {
  source: CompanionSourceProp
  /** 空态里显示的学习对象名 */
  title: string
  /** 空态副提示：各页把自己的取词/点句方式说明白 */
  hint?: string
  followups?: string[]
  openers?: string[]
  /** 视频页的「主动检验」开关，其他页无此概念 */
  showQuiz?: boolean
}

function fmtClock(sec: number): string {
  const m = Math.floor(sec / 60)
  return `${String(m).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`
}

export function VoiceCompanion({
  source,
  title,
  hint,
  followups = FOLLOWUPS_DEFAULT,
  openers = OPENERS_DEFAULT,
  showQuiz = false,
}: VoiceCompanionProps) {
  const voice = useVoiceCompanionStore()
  const [quiz, setQuiz] = useState(isQuizEnabled)
  const streamRef = useRef<HTMLDivElement>(null)
  const ringRef = useRef<HTMLSpanElement>(null)
  /** 未连上就点了快捷问：连上后补发 */
  const pendingRef = useRef<string | null>(null)

  const isVideo = 'videoId' in source
  const boundId = isVideo ? source.videoId : source.articleId
  const kind: 'article' | 'video' = isVideo ? 'video' : 'article'

  const mine = voice.articleId === boundId && voice.sourceKind === kind
  const live =
    mine &&
    (voice.status === 'connecting' || voice.status === 'listening' || voice.status === 'speaking')
  const ready = mine && (voice.status === 'listening' || voice.status === 'speaking')

  const history = useQuery({
    queryKey: ['voice-history', kind, boundId],
    queryFn: () =>
      readerApi.companionHistory(isVideo ? { video_id: boundId } : { article_id: boundId }),
    enabled: boundId > 0,
    staleTime: 60_000,
  })

  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight, behavior: 'smooth' })
  }, [voice.lines])

  // 连上后补发排队的开场问题
  useEffect(() => {
    if (!ready || pendingRef.current === null) return
    if (sendCompanionText(pendingRef.current)) pendingRef.current = null
  }, [ready, voice.status])

  // 说话音量驱动光环：静态图标看不出 AI 是否真的在出声
  useEffect(() => {
    if (!live) return
    let raf = 0
    const loop = () => {
      const el = ringRef.current
      if (el !== null) el.style.setProperty('--lv', String(getVoiceLevel().toFixed(3)))
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [live])

  const start = (opener?: string) => {
    resetQuiz()
    if (opener !== undefined) pendingRef.current = opener
    startVoiceCompanion(
      isVideo
        ? { videoId: source.videoId, ...(source.unitOrdinal !== undefined && source.unitOrdinal >= 0 ? { unitOrdinal: source.unitOrdinal } : {}) }
        : { articleId: source.articleId },
    )
  }

  const ask = (text: string) => {
    if (!ready) {
      pendingRef.current = text
      return
    }
    sendCompanionText(text)
  }

  const past = history.data ?? []

  return (
    <div className="vcp">
      <div className="vcp-head">
        <h3>AI 陪读</h3>
        {live && (
          <span className={`vcp-state ${voice.status}`}>
            <i />
            {voice.status === 'error' ? (voice.error ?? '出错') : VOICE_STATUS_TEXT[voice.status]}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {showQuiz && (
          <button
            className={`vcp-toggle${quiz ? ' on' : ''}`}
            title={quiz ? '学完几句 AI 会主动考你（点此关闭）' : '开启主动检验'}
            onClick={() => {
              const next = !quiz
              setQuiz(next)
              setQuizEnabled(next)
            }}
          >
            主动检验 {quiz ? '开' : '关'}
          </button>
        )}
        {live && (
          <>
            <span className="vcp-timer">{fmtClock(voice.elapsed)}</span>
            <button className="vcp-end" onClick={stopVoiceCompanion}>
              结束
            </button>
          </>
        )}
      </div>

      {mine && voice.micError !== null && <div className="vcp-alert">{voice.micError}</div>}
      {mine && voice.audioBlocked && live && (
        <button className="vcp-alert as-btn" onClick={resumeVoiceAudio}>
          浏览器拦截了自动播放，点此恢复声音
        </button>
      )}
      {mine && voice.status === 'error' && (
        <div className="vcp-alert">{voice.error ?? '语音陪读出错'}</div>
      )}

      <ContextRefs onAsk={ready ? ask : undefined} />

      <div className="vcp-stream" ref={streamRef}>
        {!live && voice.lines.length === 0 && (
          <div className="vcp-hero">
            <button className="vcp-orb" onClick={() => start()} title="开始语音陪读">
              <span className="vcp-orb-ring" ref={ringRef} />
              <IconVoice />
            </button>
            <div className="vcp-hero-title">和 AI 一起学《{title}》</div>
            <div className="vcp-hero-sub">
              点上面的按钮就能开口说话，全程语音，不用打字。
              <br />
              点正文里的句子只是告诉 AI「说的是这句」，它不会抢答。
              {hint !== undefined && (
                <>
                  <br />
                  {hint}
                </>
              )}
            </div>
            <div className="vcp-openers">
              {openers.map((o) => (
                <button key={o} onClick={() => start(o)}>
                  {o}
                </button>
              ))}
            </div>
            {past.length > 0 && (
              <details className="vcp-history">
                <summary>往次陪读记录（{past.length} 次）</summary>
                {past.map((h) => (
                  <div key={h.session_id} className="vcp-hist-item">
                    <div className="vcp-hist-time">
                      {h.started_at?.slice(0, 16).replace('T', ' ')}
                    </div>
                    {h.turns.map((t, i) => (
                      <div key={i} className={`vcp-hist-line ${t.role}`}>
                        <i>{t.role === 'user' ? '你' : 'AI'}</i>
                        {t.text}
                      </div>
                    ))}
                  </div>
                ))}
              </details>
            )}
          </div>
        )}

        {voice.lines.length > 0 && (
          <>
            {voice.lines.map((line) => (
              <div key={line.id} className={`vcp-msg ${line.role}`}>
                {line.role === 'ai' && (
                  <span className="vcp-avatar">
                    <IconSparkle />
                  </span>
                )}
                <div className={`vcp-bubble${line.interim ? ' interim' : ''}`}>
                  {/* 回复里的英文词可点，一键入生词本并带出处（FR-20） */}
                  {line.role === 'ai' ? <ClickableEn text={line.text} force /> : line.text}
                </div>
              </div>
            ))}
            {!live && (
              <div className="vcp-ended">
                本次陪读已结束
                <button onClick={() => start()}>再聊一会</button>
              </div>
            )}
          </>
        )}
      </div>

      {live && (
        <div className="vcp-foot">
          <span className="vcp-foot-label">说不出来时点一下</span>
          <div className="vcp-chips">
            {followups.map((f) => (
              <button key={f} disabled={!ready} onClick={() => ask(f)}>
                {f}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** 场景短文右栏用的带关闭按钮外壳 */
export function VoiceCompanionAside({
  onClose,
  ...props
}: VoiceCompanionProps & { onClose: () => void }) {
  return (
    <aside className="vcp-aside">
      <button className="vcp-aside-x icon-btn" title="收起陪读" onClick={onClose}>
        <IconClose />
      </button>
      <VoiceCompanion {...props} />
    </aside>
  )
}
