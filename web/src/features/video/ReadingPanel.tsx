/* 阅读模式：cues 按停顿拼段落，.prose 精读排版；点词=词卡、词组高亮可点、
   点句回跳播放；当前句底色跟随。 */

import { useMemo } from 'react'

import type { CuePhrase, CueV2 } from '../../lib/api-video'
import type { WordSelection } from '../reader/readerStore'
import { CueText } from './CueText'
import type { PhraseHost } from './CueText'
import { formatClock } from './videoUtils'

/** 句间停顿 > 1.8s 或累计 6 句起新段 */
function paragraphs(cues: CueV2[]): CueV2[][] {
  const out: CueV2[][] = []
  let cur: CueV2[] = []
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i]
    const prev = cues[i - 1]
    const gap = prev !== undefined ? c.start_ms - prev.end_ms : 0
    if (cur.length > 0 && (gap > 1800 || cur.length >= 6)) {
      out.push(cur)
      cur = []
    }
    cur.push(c)
  }
  if (cur.length > 0) out.push(cur)
  return out
}

interface ReadingPanelProps {
  cues: CueV2[]
  activeIdx: number
  title: string
  channel: string | null
  durationS: number | null
  textOf: (cue: CueV2) => string
  onWord: (sel: WordSelection) => void
  onPhrase: (phrase: CuePhrase, cue: PhraseHost) => void
  onJump: (i: number) => void
}

export function ReadingPanel({
  cues,
  activeIdx,
  title,
  channel,
  durationS,
  textOf,
  onWord,
  onPhrase,
  onJump,
}: ReadingPanelProps) {
  const paras = useMemo(() => paragraphs(cues), [cues])
  const activeId = activeIdx >= 0 ? cues[activeIdx]?.id : -1

  return (
    <div className="vm-read">
      <div className="vm-read-inner">
        <div className="vm-read-title">{title}</div>
        <div className="vm-read-sub">
          {channel !== null && <span>{channel}</span>}
          {durationS !== null && durationS > 0 && <span>{formatClock(durationS)}</span>}
          <span>{cues.length} 句</span>
          <span className="chip">点词查释 · 点句回跳播放</span>
        </div>
        <div className="prose">
          {paras.map((para, pi) => (
            <p key={pi}>
              {para.map((cue) => (
                <span
                  key={cue.id}
                  className={`vm-read-cue${cue.id === activeId ? ' current' : ''}`}
                  onClick={() => onJump(cues.indexOf(cue))}
                >
                  <CueText cue={cue} text={textOf(cue)} onWord={onWord} onPhrase={onPhrase} />{' '}
                </span>
              ))}
            </p>
          ))}
        </div>
      </div>
    </div>
  )
}
