/* 听写模式（对照 design/mockups/video-study.html 听写面板）：
   播放句 → 输入 → 逐词批改（LCS diff：对绿/错红底/漏虚线框）→ 正确率 →
   重听 / 提示 / 看答案 / 下一句；键盘流：Enter 提交、Ctrl+R 重听、Ctrl+H 提示。 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { toast } from 'sonner'

import { IconSparkle } from '../../components/icons'
import type { CueV2 } from '../../lib/api-video'
import { askAboutSentence } from '../companion/askAi'
import { VIconArrowRight, VIconPlaySolid, VIconRefresh } from './icons'
import { useVideoStudyStore } from './videoStudyStore'
import { diffWords, speechEnvelope } from './videoUtils'
import type { DiffResult } from './videoUtils'

interface DictationPanelProps {
  cues: CueV2[]
  /** 问 AI 后切到陪读面板 */
  onAskAi?: () => void
  idx: number
  setIdx: (i: number) => void
  /** 播放当前句片段（句尾自动停）；rate 覆盖慢速重听 */
  playSegment: (i: number, rate?: number) => void
  textOf: (cue: CueV2) => string
}

export function DictationPanel({
  cues,
  idx,
  setIdx,
  playSegment,
  textOf,
  onAskAi,
}: DictationPanelProps) {
  const dictDone = useVideoStudyStore((s) => s.dictDone)
  const dictStats = useVideoStudyStore((s) => s.dictStats)
  const recordDictation = useVideoStudyStore((s) => s.recordDictation)

  const cue = cues[idx] as CueV2 | undefined
  const [input, setInput] = useState('')
  const [result, setResult] = useState<DiffResult | null>(null)
  const [revealed, setRevealed] = useState(false)
  const [hintCount, setHintCount] = useState(0)
  const [listens, setListens] = useState(0)
  const [slow, setSlow] = useState(false)
  const [streak, setStreak] = useState(0)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const refText = cue !== undefined ? textOf(cue) : ''
  const refTokens = useMemo(() => refText.split(/\s+/).filter((w) => w !== ''), [refText])
  const envelope = useMemo(() => (cue !== undefined ? speechEnvelope(cue, 30) : []), [cue])

  /* 切句重置作答状态并自动播一遍 */
  useEffect(() => {
    setInput('')
    setResult(null)
    setRevealed(false)
    setHintCount(0)
    setListens(0)
    if (cue !== undefined) {
      playSegment(idx, slow ? 0.75 : undefined)
      setListens(1)
      inputRef.current?.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, cue?.id])

  if (cue === undefined) {
    return <div className="panel-empty">本视频暂无字幕，无法听写</div>
  }

  const replay = () => {
    playSegment(idx, slow ? 0.75 : undefined)
    setListens((n) => n + 1)
  }

  const submit = () => {
    if (input.trim() === '' || result !== null) return
    const r = diffWords(refText, input)
    setResult(r)
    recordDictation(cue.id, r.accuracy, r.correct, r.total)
    setStreak((s) => (r.accuracy >= 100 ? s + 1 : 0))
  }

  const hint = () => {
    setHintCount((n) => Math.min(refTokens.length, n + 1))
  }

  const next = () => {
    if (idx < cues.length - 1) setIdx(idx + 1)
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (result !== null) next()
      else submit()
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r') {
      e.preventDefault()
      replay()
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'h') {
      e.preventDefault()
      hint()
    }
  }

  const doneCount = Object.keys(dictDone).length
  const avg =
    dictStats.totalWords > 0
      ? Math.round((dictStats.correctWords / dictStats.totalWords) * 100)
      : null

  return (
    <>
      <div className="vm-panel-head">
        <h3>听写模式</h3>
        <span className="chip accent">
          第 {idx + 1} 句 / {cues.length}
        </span>
        <div style={{ flex: 1 }} />
        {avg !== null && <span className="chip ok">平均正确率 {avg}%</span>}
      </div>
      <div className="vm-mode-body">
        <div className="card vm-dict-play">
          <button className="pbtn" title="重听本句" onClick={replay}>
            <VIconPlaySolid />
          </button>
          <div className="vm-wave" style={{ flex: 1 }}>
            {envelope.map((h, i) => (
              <i key={i} style={{ height: `${Math.max(2, Math.round(h * 22))}px` }} />
            ))}
          </div>
          <div className="col">
            <b>已听 {listens} 遍</b>
            <button
              className={slow ? 'on' : ''}
              title="0.75× 慢速重听"
              onClick={() => setSlow((v) => !v)}
            >
              0.75× 慢速
            </button>
          </div>
        </div>

        <div>
          <textarea
            ref={inputRef}
            className="vm-dict-input"
            spellCheck={false}
            placeholder="听音打字，Enter 提交批改…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
          />
          <div className="vm-dict-keys">
            <span>
              <kbd>Enter</kbd> {result !== null ? '下一句' : '提交批改'}
            </span>
            <span>
              <kbd>Ctrl R</kbd> 重听
            </span>
            <span>
              <kbd>Ctrl H</kbd> 提示一词
            </span>
          </div>
        </div>

        {hintCount > 0 && result === null && (
          <div className="vm-dict-hint">
            提示：{refTokens.slice(0, hintCount).join(' ')}
            {hintCount < refTokens.length ? ' …' : ''}
          </div>
        )}

        {revealed && result === null && (
          <div className="card vm-dict-result">
            <div className="vm-dr-head">
              <span className="ttl">参考答案</span>
            </div>
            <div className="vm-mode-sent">{refText}</div>
          </div>
        )}

        {result !== null && (
          <div className="card vm-dict-result">
            <div className="vm-dr-head">
              <span className="ttl">逐词批改</span>
              <div style={{ flex: 1 }} />
              <span className={`chip ${result.accuracy >= 80 ? 'ok' : result.accuracy >= 50 ? 'warn' : 'err'}`}>
                {result.correct} / {result.total} 词 · {result.accuracy}%
              </span>
            </div>
            <div className="vm-dr-words">
              {result.items.map((w, i) => (
                <span
                  key={i}
                  className={`vm-dw ${w.status}`}
                  title={w.status === 'miss' ? '漏写' : w.status === 'wrong' ? '写错' : undefined}
                >
                  {w.word}
                  {w.status === 'wrong' && w.got !== undefined && <s>→{w.got}</s>}
                </span>
              ))}
            </div>
            <div className="vm-dr-legend">
              <span style={{ color: 'var(--ok)' }}>绿 = 正确</span>
              <span>
                <span className="vm-dw wrong" style={{ fontSize: 11, padding: '0 4px' }}>
                  红底
                </span>{' '}
                = 写错
              </span>
              <span>
                <span className="vm-dw miss" style={{ fontSize: 11, padding: '0 4px' }}>
                  虚线框
                </span>{' '}
                = 漏写
              </span>
              {result.extra > 0 && <span>多写 {result.extra} 词</span>}
            </div>
          </div>
        )}

        <div className="vm-mode-acts">
          <button className="btn btn-outline" onClick={replay}>
            <VIconRefresh />
            重听
          </button>
          <button className="btn" disabled={result !== null} onClick={hint}>
            提示
          </button>
          <button
            className="btn"
            disabled={result !== null}
            onClick={() => setRevealed((v) => !v)}
          >
            {revealed ? '收起答案' : '看答案'}
          </button>
          {result !== null && cue !== undefined && (
            <button
              className="btn"
              title="把这句和你的听写结果交给 AI 陪读"
              onClick={() => {
                askAboutSentence({ id: cue.id, text: cue.text, startMs: cue.start_ms })
                onAskAi?.()
                toast.success('已加入陪读上下文')
              }}
            >
              <IconSparkle />
              问 AI
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button
            className="btn btn-primary"
            disabled={idx >= cues.length - 1}
            onClick={next}
          >
            下一句
            <VIconArrowRight />
          </button>
        </div>

        <div className="divider" />

        <div className="vm-mode-stats">
          <span>
            本次已听写 <b>{dictStats.done}</b> 句
          </span>
          <span>
            连对 <b>{streak}</b> 句
          </span>
          <div className="vm-sess-bar">
            <i style={{ width: `${cues.length > 0 ? (doneCount / cues.length) * 100 : 0}%` }} />
          </div>
          <span>
            {doneCount} / {cues.length}
          </span>
        </div>
      </div>
    </>
  )
}
