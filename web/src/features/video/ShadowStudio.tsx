/* 跟读工作台弹窗（FR-335~345）。

   取代原来的行内展开卡：录音按钮小、只能录一条、刷新即失、AI 点评还要跳到陪读面板去看。
   这里一站做完——录音、试听、逐词比对、AI 流式点评、历史回看，都不离开弹窗。

   录音落库遵循 BR-12 的「用户明确保存才落库」：只录不动作的留在本地 blob，
   点了「比对并保存」才上传——那一步本来就要把音频送到服务端。 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { Overlay } from '../../components/Overlay'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { IconAlert, IconClose, IconSparkle, IconTrash } from '../../components/icons'
import { apiVideo } from '../../lib/api-video'
import { AssessmentPanel } from './AssessmentPanel'
import type { Assessment } from './AssessmentPanel'
import type { ShadowRecordingV1 } from '../../lib/api-video'
import { stopTts } from '../../lib/audio'
import { Markdown } from '../../components/Markdown'
import { requireMic } from '../../lib/mic'
import type { CuePhrase } from '../../lib/api-video'
import type { WordSelection } from '../reader/readerStore'
import { CueText } from './CueText'
import type { PhraseHost } from './CueText'
import { VIconMicLine, VIconPause, VIconPlaySolid, VIconRestart } from './icons'
import type { EnvelopeSource } from './videoUtils'
import { resample, speechEnvelope } from './videoUtils'

const BUCKETS = 48

function Wave({ bars, mine }: { bars: number[]; mine?: boolean }) {
  return (
    <div className={`ss-wave${mine === true ? ' mine' : ''}`}>
      {bars.map((h, i) => (
        <i key={i} style={{ height: `${Math.max(2, Math.round(h * 26))}px` }} />
      ))}
    </div>
  )
}

function clock(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

interface ShadowStudioProps {
  videoId: number
  sentenceId: number
  unitId?: number
  /** 原句文本与词级时间戳，用来画原句包络和逐词点读 */
  source: EnvelopeSource & { text: string }
  /** 词组区间：弹窗里的原句与右栏一样要有三色标注（FR-352） */
  phrases: CuePhrase[] | null
  /** 原句正在播放：按钮要变正在播放的样子，不能点了没反应 */
  playing: boolean
  /** 词级卡拉OK区间：跟着读到哪个词就亮哪个词 */
  karaoke: [number, number] | null
  /** 播放原句（整句），再点暂停 */
  onPlayOriginal: () => void
  /** 从句首重读（FR-360） */
  onReplayOriginal: () => void
  /** 字幕自带译文（FR-361） */
  zh: string | null
  onWord?: (sel: WordSelection) => void
  onPhrase?: (phrase: CuePhrase, host: PhraseHost) => void
  onClose: () => void
}

export function ShadowStudio({
  videoId,
  sentenceId,
  unitId,
  source,
  phrases,
  playing,
  karaoke,
  onPlayOriginal,
  onReplayOriginal,
  zh,
  onWord,
  onPhrase,
  onClose,
}: ShadowStudioProps) {
  const qc = useQueryClient()
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [level, setLevel] = useState(0)
  const [micError, setMicError] = useState<string | null>(null)
  const [myWave, setMyWave] = useState<number[] | null>(null)
  const [localUrl, setLocalUrl] = useState<string | null>(null)
  /** 当前展开查看的历史条目；null = 看刚录的这条 */
  const [openId, setOpenId] = useState<number | null>(null)
  const [review, setReview] = useState<{ text: string; score: number | null } | null>(null)
  // 发音诊断按录音缓存：服务端已落库，这里只存当前展开的那条
  const [assessment, setAssessment] = useState<{ id: number; data: Assessment } | null>(null)
  const [assessing, setAssessing] = useState(false)
  /** 正在回放的音频源；'mine' = 刚录的本地那条，数字 = 历史条目 id（FR-354） */
  const [nowPlaying, setNowPlaying] = useState<'mine' | number | null>(null)
  /** 展开的历史条目；点同一条再收起（FR-355） */
  const [expanded, setExpanded] = useState<number | null>(null)
  const [reviewing, setReviewing] = useState(false)

  const blobRef = useRef<Blob | null>(null)
  const recRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const startedRef = useRef(0)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const acRef = useRef<AbortController | null>(null)
  const rafRef = useRef(0)

  const origBars = speechEnvelope(source, BUCKETS)

  const history = useQuery({
    queryKey: ['shadow', videoId, sentenceId],
    queryFn: () => apiVideo.listShadow(videoId, sentenceId),
  })

  const current: ShadowRecordingV1 | undefined =
    openId !== null ? history.data?.find((r) => r.id === openId) : undefined

  /* 上传即落库并比对（FR-339/340）：这一步是用户的明确动作 */
  const submit = useMutation({
    mutationFn: () => {
      const blob = blobRef.current
      if (blob === null) throw new Error('还没有录音')
      const ext = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'mp4' : 'webm'
      return apiVideo.createShadow({
        file: new File([blob], `shadow.${ext}`, { type: blob.type }),
        sentenceId,
        unitId,
        durationMs: elapsed,
      })
    },
    onSuccess: (rec) => {
      void qc.invalidateQueries({ queryKey: ['shadow', videoId, sentenceId] })
      setOpenId(rec.id)
      setReview(null)
      toast.success(`比对完成 · 准确率 ${rec.accuracy ?? 0}%`)
    },
    onError: (e: Error) => toast.error(e.message || '比对失败'),
  })

  const remove = useMutation({
    mutationFn: (id: number) => apiVideo.deleteShadow(id),
    onSuccess: (_d, id) => {
      void qc.invalidateQueries({ queryKey: ['shadow', videoId, sentenceId] })
      if (openId === id) setOpenId(null)
    },
  })

  useEffect(
    () => () => {
      recRef.current?.stream.getTracks().forEach((t) => t.stop())
      if (localUrl !== null) URL.revokeObjectURL(localUrl)
      audioRef.current?.pause()
      acRef.current?.abort()
      cancelAnimationFrame(rafRef.current)
      // 弹窗里点词/点句触发的 TTS 也一并停掉（FR-350）
      stopTts()
    },
    [localUrl],
  )

  // 展开历史条目时把已存的点评带出来，不重新调用 AI（FR-344）
  useEffect(() => {
    if (current?.review) setReview({ text: current.review, score: current.score })
    else setReview(null)
    // 服务端已把已算过的诊断随列表带回来，直接用；没有则留空等用户点
    setAssessment(
      current?.assessment != null ? { id: current.id, data: current.assessment } : null,
    )
  }, [current?.id, current?.review, current?.score, current?.assessment])

  const start = async () => {
    setMicError(null)
    try {
      const stream = await requireMic({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      })
      const rec = new MediaRecorder(stream)
      recRef.current = rec
      chunksRef.current = []
      startedRef.current = Date.now()

      // 实时电平：录音时按钮外圈跟着涨落，不然分不清有没有在收音
      const ctx = new AudioContext()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      ctx.createMediaStreamSource(stream).connect(analyser)
      const buf = new Uint8Array(analyser.frequencyBinCount)
      const tick = () => {
        analyser.getByteTimeDomainData(buf)
        let peak = 0
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128) / 128)
        setLevel(peak)
        setElapsed(Date.now() - startedRef.current)
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)

      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      rec.onstop = () => {
        cancelAnimationFrame(rafRef.current)
        setLevel(0)
        stream.getTracks().forEach((t) => t.stop())
        void ctx.close()
        const blob = new Blob(chunksRef.current, { type: rec.mimeType })
        blobRef.current = blob
        if (localUrl !== null) URL.revokeObjectURL(localUrl)
        setLocalUrl(URL.createObjectURL(blob))
        setOpenId(null)
        setReview(null)
        void blob
          .arrayBuffer()
          .then((b) => new AudioContext().decodeAudioData(b))
          .then((audio) => {
            const ch = audio.getChannelData(0)
            const abs: number[] = []
            const step = Math.max(1, Math.floor(ch.length / 4096))
            for (let i = 0; i < ch.length; i += step) abs.push(Math.abs(ch[i]))
            setMyWave(resample(abs, BUCKETS))
          })
          .catch(() => setMyWave(null))
      }
      rec.start()
      setRecording(true)
      setElapsed(0)
    } catch (err) {
      setMicError(err instanceof Error ? err.message : '麦克风不可用')
    }
  }

  const stop = () => {
    if (recRef.current?.state === 'recording') recRef.current.stop()
    setRecording(false)
  }

  /** 丢弃刚录的这条（FR-363）：还没上传，纯本地清掉就行，不必先存再删 */
  const discard = () => {
    if (nowPlaying === 'mine') {
      audioRef.current?.pause()
      setNowPlaying(null)
    }
    if (localUrl !== null) URL.revokeObjectURL(localUrl)
    blobRef.current = null
    setLocalUrl(null)
    setMyWave(null)
    setElapsed(0)
  }

  /** 回放/暂停同一个按钮：正在放这条就停，否则换成这条（FR-354） */
  const play = useCallback(
    (url: string, key: 'mine' | number) => {
      if (nowPlaying === key) {
        audioRef.current?.pause()
        setNowPlaying(null)
        return
      }
      audioRef.current?.pause()
      const audio = new Audio(url)
      audioRef.current = audio
      audio.addEventListener('ended', () => setNowPlaying(null), { once: true })
      audio.addEventListener('error', () => setNowPlaying(null), { once: true })
      setNowPlaying(key)
      void audio.play().catch(() => setNowPlaying(null))
    },
    [nowPlaying],
  )

  /* AI 点评流式打进弹窗底部（FR-342） */
  const askReview = (recId: number) => {
    acRef.current?.abort()
    const ac = new AbortController()
    acRef.current = ac
    setReviewing(true)
    setReview({ text: '', score: null })
    void apiVideo
      .reviewShadow(
        recId,
        {
          onDelta: (t) => setReview((r) => ({ text: (r?.text ?? '') + t, score: r?.score ?? null })),
          onDone: (d) => {
            setReview({ text: d.text, score: d.score })
            setReviewing(false)
            void qc.invalidateQueries({ queryKey: ['shadow', videoId, sentenceId] })
          },
          onError: (m) => {
            setReviewing(false)
            toast.error(m)
          },
        },
        ac.signal,
      )
      .catch(() => setReviewing(false))
  }

  const shown = current ?? null
  const canSubmit = blobRef.current !== null && !submit.isPending

  return (
    <Overlay onClose={onClose} card="ss-card">
        <div className="overlay-head">
          <div className="overlay-title">跟读练习</div>
          <div style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose}>
            <IconClose />
          </button>
        </div>

        {/* 原句：整句播放 + 逐词点读，录之前先听清楚（FR-337） */}
        <div className="ss-orig">
          <button
            className={`ss-play${playing ? ' on' : ''}`}
            title={playing ? '暂停' : '播放原句'}
            onClick={onPlayOriginal}
          >
            {playing ? (
              <VIconPause style={{ width: 13, height: 13 }} />
            ) : (
              <VIconPlaySolid style={{ width: 13, height: 13 }} />
            )}
          </button>
          {/* 与右栏同一套渲染（FR-352）：词组三色标注、读到哪个词亮哪个、点词查词卡 */}
          <div className="ss-sent-body">
            <p className="ss-text">
              <CueText
                cue={{ id: sentenceId, text: source.text, phrases }}
                onWord={onWord}
                onPhrase={onPhrase}
                karaoke={karaoke}
              />
              {/* 从头读跟在句末（FR-362） */}
              <button className="sent-replay" title="从头读这句" onClick={onReplayOriginal}>
                <VIconRestart style={{ width: 11, height: 11 }} />
              </button>
            </p>
            {/* 跟读前先看懂意思，译文用字幕自带的（FR-361） */}
            {zh !== null && zh !== '' && <p className="ss-zh">{zh}</p>}
          </div>
        </div>
        <Wave bars={origBars} />

        {/* 录音区 */}
        <div className="ss-rec">
          <button
            className={`ss-mic${recording ? ' on' : ''}`}
            style={{ '--lv': level.toFixed(3) } as React.CSSProperties}
            onClick={() => (recording ? stop() : void start())}
          >
            <span className="ss-mic-ring" />
            <VIconMicLine />
          </button>
          <div className="ss-rec-meta">
            <b>{recording ? '录音中…点一下结束' : localUrl !== null ? '录好了' : '点一下开始跟读'}</b>
            <span>{clock(elapsed)}</span>
          </div>
          <div style={{ flex: 1 }} />
          {localUrl !== null && !recording && (
            <button className="btn btn-soft btn-sm" onClick={() => play(localUrl, 'mine')}>
              {nowPlaying === 'mine' ? (
                <VIconPause style={{ width: 11, height: 11 }} />
              ) : (
                <VIconPlaySolid style={{ width: 11, height: 11 }} />
              )}
              {nowPlaying === 'mine' ? '暂停' : '试听'}
            </button>
          )}
          {localUrl !== null && !recording && (
            <>
            <button
              className="btn btn-soft btn-sm"
              title="丢掉这条重录"
              disabled={submit.isPending}
              onClick={discard}
            >
              <IconTrash />
              丢弃
            </button>
            <button
              className={`btn btn-primary btn-sm${submit.isPending ? ' loading' : ''}`}
              disabled={!canSubmit}
              onClick={() => submit.mutate()}
            >
              {submit.isPending && <span className="spinner" />}
              {submit.isPending ? '比对中…' : '比对并保存'}
            </button>
            </>
          )}
        </div>
        {myWave !== null && !recording && <Wave bars={myWave} mine />}

        {micError !== null && (
          <div className="ss-err">
            <IconAlert />
            {micError}
          </div>
        )}

        {/* 逐词比对结果 */}
        {shown !== null && shown.items.length > 0 && (
          <div className="ss-diff">
            <div className="ss-diff-head">
              <b>{shown.accuracy}%</b>
              <span>
                读对 {shown.correct}/{shown.total}
                {(shown.extra ?? 0) > 0 && ` · 多读 ${shown.extra}`}
              </span>
              {shown.score !== null && <span className="ss-score">AI 评分 {shown.score}</span>}
              <div style={{ flex: 1 }} />
              <button
                className="btn btn-soft btn-sm"
                disabled={reviewing}
                onClick={() => askReview(shown.id)}
              >
                <IconSparkle />
                {reviewing ? '点评中…' : shown.review ? '重新点评' : 'AI 点评'}
              </button>
            </div>
            <div className="ss-words">
              {shown.items.map((it, i) => (
                <span
                  key={i}
                  className={`ss-w ${it.status}`}
                  title={it.got ? `你读成 ${it.got}` : undefined}
                >
                  {it.word}
                </span>
              ))}
            </div>
            <div className="ss-raw">识别到：{shown.transcript || '（无）'}</div>

            {/* 发音诊断（FR-398）：第 0 层零新依赖，音素层缺件自动降级 */}
            {assessment?.id !== shown.id && (
              <button
                className="btn btn-soft btn-sm ss-assess-btn"
                disabled={assessing}
                onClick={() => {
                  setAssessing(true)
                  void apiVideo
                    .assessShadow(shown.id)
                    .then((d) => setAssessment({ id: shown.id, data: d }))
                    .catch((e: Error) => toast.error(e.message))
                    .finally(() => setAssessing(false))
                }}
              >
                {assessing ? '分析中…' : '发音诊断'}
              </button>
            )}
            {assessment?.id === shown.id && (
              <AssessmentPanel
                data={assessment.data}
                recordingId={shown.id}
                onNarrate={(id, onDelta) => apiVideo.narrateShadow(id, onDelta)}
              />
            )}
          </div>
        )}

        {/* AI 点评：流式打进来 */}
        {review !== null && (
          <div className="ss-review">
            <div className="ss-review-head">
              <IconSparkle />
              AI 点评
              {review.score !== null && <b className="ss-score">{review.score} 分</b>}
              {reviewing && <span className="ss-dot" />}
            </div>
            <div className="ss-review-body">
              {review.text === '' && reviewing ? (
                '正在听你的录音…'
              ) : (
                <Markdown text={review.text} />
              )}
            </div>
          </div>
        )}

        {/* 历史：留着才看得出进步（FR-341） */}
        {(history.data?.length ?? 0) > 0 && (
          <div className="ss-hist">
            <div className="ss-hist-label">本句练习记录 {history.data?.length}</div>
            {history.data?.map((r) => (
              <div key={r.id} className={`ss-hist-item${openId === r.id ? ' on' : ''}`}>
                <button
                  className="ss-hist-main"
                  title={expanded === r.id ? '收起' : '展开这条'}
                  onClick={() => {
                    // 点同一条即收起（FR-355）
                    const on = expanded === r.id
                    setExpanded(on ? null : r.id)
                    setOpenId(on ? null : r.id)
                  }}
                >
                  <i className={`ss-hist-caret${expanded === r.id ? ' on' : ''}`} />
                  <span className="ss-hist-acc">{r.accuracy ?? '—'}%</span>
                  {r.score !== null && <span className="ss-hist-score">{r.score} 分</span>}
                  <span className="ss-hist-time">
                    {r.created_at?.slice(5, 16).replace('T', ' ')}
                  </span>
                </button>
                <button
                  className="icon-btn"
                  title={nowPlaying === r.id ? '暂停' : '回放这条'}
                  onClick={() => play(r.audio_url, r.id)}
                >
                  {nowPlaying === r.id ? (
                    <VIconPause style={{ width: 11, height: 11 }} />
                  ) : (
                    <VIconPlaySolid style={{ width: 11, height: 11 }} />
                  )}
                </button>
                <button
                  className="icon-btn"
                  title="删除这条"
                  onClick={() => remove.mutate(r.id)}
                >
                  <IconTrash />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="overlay-foot">
          <span className="sp-muted">录音与点评已保存，下次打开还在</span>
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </Overlay>
  )
}
