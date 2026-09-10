/* 视频内叠加字幕：词级卡拉OK高亮（按 cue.words 二分定位当前词）+ 双语行 +
   词组提示行（原设计 IPA 行的取舍替代：词组区间下彩色释义，见交付报告）。
   自带 rAF 循环驱动高亮，只有词下标变化才 setState。 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'

import type { CuePhrase, CueV2 } from '../../lib/api-video'
import type { WordSelection } from '../reader/readerStore'
import { useVocabCollectionStore } from '../../lib/vocabCollectionStore'
import { findActiveWord, phraseColorClass } from './videoUtils'

interface CaptionWord {
  surface: string
  /** 小写词元（去首尾标点） */
  word: string
  startMs: number
  /** 在 cue.text 中的字符区间（用于词卡选中态与词组归属） */
  charStart: number
  charEnd: number
  /** 命中的词组下标，-1 无 */
  phraseIdx: number
  /** 是否为该词组的首词（词组提示行只在首词下渲染） */
  phraseHead: boolean
}

/** cue.words（含标点的表面词）→ 字符区间映射 + 词组归属 */
function buildWords(cue: CueV2): CaptionWord[] {
  const words = cue.words ?? []
  const phrases = cue.phrases ?? []
  const out: CaptionWord[] = []
  let cursor = 0
  let lastPhrase = -1
  for (const [ws, , surface] of words) {
    let idx = cue.text.indexOf(surface, cursor)
    if (idx < 0) idx = cursor
    const charStart = idx
    const charEnd = idx + surface.length
    cursor = charEnd
    let phraseIdx = -1
    for (let i = 0; i < phrases.length; i++) {
      const p = phrases[i]
      if (charStart < p[1] && charEnd > p[0]) {
        phraseIdx = i
        break
      }
    }
    out.push({
      surface,
      word: surface.toLowerCase().replace(/^[^a-z']+|[^a-z']+$/g, ''),
      startMs: ws,
      charStart,
      charEnd,
      phraseIdx,
      phraseHead: phraseIdx >= 0 && phraseIdx !== lastPhrase,
    })
    lastPhrase = phraseIdx
  }
  return out
}

interface KaraokeCaptionProps {
  cue: CueV2
  zh: string | undefined
  videoRef: RefObject<HTMLVideoElement | null>
  playing: boolean
  showEn: boolean
  showZh: boolean
  /** 词组提示行开关（控制条切换） */
  phraseHints: boolean
  onWord: (sel: WordSelection) => void
  onPhrase: (phrase: CuePhrase, cue: CueV2) => void
}

export function KaraokeCaption({
  cue,
  zh,
  videoRef,
  playing,
  showEn,
  showZh,
  phraseHints,
  onWord,
  onPhrase,
}: KaraokeCaptionProps) {
  const collected = useVocabCollectionStore((state) => state.collected)
  const words = useMemo(() => buildWords(cue), [cue])
  const spans = useMemo(() => cue.words ?? [], [cue])
  const [nowIdx, setNowIdx] = useState(-1)
  const nowRef = useRef(-1)
  /* 词组整体悬浮：逐词 span 平铺没有词组容器，CSS 选不到"同组的前面兄弟"，
     故用一个分组下标驱动同组各词一起高亮 */
  const [hoverPhrase, setHoverPhrase] = useState(-1)

  /* rAF 驱动当前词：下标变化才触发渲染 */
  useEffect(() => {
    setHoverPhrase(-1)
  }, [cue.id])

  useEffect(() => {
    nowRef.current = -1
    setNowIdx(-1)
    const el = videoRef.current
    if (el === null || spans.length === 0) return
    let raf = 0
    const tick = () => {
      const v = videoRef.current
      if (v !== null) {
        const idx = findActiveWord(spans, v.currentTime * 1000)
        if (idx !== nowRef.current) {
          nowRef.current = idx
          setNowIdx(idx)
        }
      }
      raf = requestAnimationFrame(tick)
    }
    if (playing) raf = requestAnimationFrame(tick)
    else {
      // 暂停态同步一次（seek 后高亮正确）
      const idx = findActiveWord(spans, el.currentTime * 1000)
      nowRef.current = idx
      setNowIdx(idx)
    }
    return () => cancelAnimationFrame(raf)
  }, [spans, playing, videoRef, cue.id])

  if (!showEn && (!showZh || zh === undefined)) return null

  return (
    <div className="vm-caption">
      {showEn && words.length > 0 && (
        <div className="vm-capen">
          {words.map((w, i) => {
            const phrase = w.phraseIdx >= 0 ? (cue.phrases ?? [])[w.phraseIdx] : null
            const inPhrase = phrase !== null
            const cls = [
              'vm-kw',
              i < nowIdx ? 'past' : '',
              i === nowIdx ? 'now' : '',
              collected.has(w.word) ? 'vocab' : '',
              inPhrase ? `inph ${phraseColorClass(String(phrase[2]))}` : '',
              inPhrase && w.phraseIdx === hoverPhrase ? 'phover' : '',
            ]
              .filter(Boolean)
              .join(' ')
            return (
              <span
                key={`${cue.id}-${i}`}
                className={cls}
                title={inPhrase ? phrase[3] : undefined}
                onMouseEnter={() => setHoverPhrase(w.phraseIdx)}
                onMouseLeave={() => setHoverPhrase(-1)}
                onClick={(e) => {
                  e.stopPropagation()
                  // 词组是一个语义单元：区间内点哪个词都查整个词组（与右栏一致）
                  if (inPhrase) {
                    onPhrase(phrase, cue)
                    return
                  }
                  if (w.word === '') return
                  onWord({
                    word: w.word,
                    surface: w.surface.replace(/^[^A-Za-z']+|[^A-Za-z']+$/g, ''),
                    paragraphId: cue.id,
                    start: w.charStart,
                    end: w.charEnd,
                    sentenceId: null,
                    sentenceHash: null,
                    sentenceText: cue.text,
                  })
                }}
              >
                <i className="t">{w.surface}</i>
                {phraseHints && inPhrase && (
                  <i className={`sub ${phraseColorClass(String(phrase[2]))}`}>
                    {w.phraseHead ? phrase[3] : '·'}
                  </i>
                )}
              </span>
            )
          })}
        </div>
      )}
      {showEn && words.length === 0 && (
        <div className="vm-capen">
          <span className="vm-kw now">
            <i className="t">{cue.text}</i>
          </span>
        </div>
      )}
      {showZh && zh !== undefined && <div className="vm-capzh">{zh}</div>}
    </div>
  )
}
