/* 挖空模式：词组优先挖空（AI 词组区间内的词优先，其次长词），
   点击候选词填空，即时判定（对→绿填入，错→抖动标红）。 */

import { useEffect, useMemo, useState } from 'react'

import type { CueV2 } from '../../lib/api-video'
import { VIconArrowLeft, VIconArrowRight, VIconPlaySolid, VIconRefresh } from './icons'
import { tokenizeCue } from './videoUtils'
import type { CueToken } from './videoUtils'

/** 确定性伪随机（按 cue id 播种），刷新后同句同题 */
function seededShuffle<T>(arr: T[], seed: number): T[] {
  const out = [...arr]
  let s = seed || 1
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280
    const j = Math.floor((s / 233280) * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

interface Puzzle {
  /** 按 token 序：挖空 token 的下标集合 */
  blanks: number[]
  tokens: CueToken[]
  candidates: string[]
}

function buildPuzzle(cue: CueV2, neighbors: CueV2[]): Puzzle {
  const tokens = tokenizeCue(cue.text)
  const inPhrase = (t: CueToken) =>
    (cue.phrases ?? []).some((p) => t.start < p[1] && t.end > p[0])
  // 词组词优先，其次 4+ 字母长词；至多 4 个、彼此隔开
  const phraseIdx = tokens.map((t, i) => (inPhrase(t) ? i : -1)).filter((i) => i >= 0)
  const longIdx = tokens
    .map((t, i) => (t.word.length >= 4 && !inPhrase(t) ? i : -1))
    .filter((i) => i >= 0)
  const picked: number[] = []
  for (const i of [...phraseIdx, ...seededShuffle(longIdx, cue.id * 7)]) {
    if (picked.length >= 4) break
    if (picked.some((p) => Math.abs(p - i) <= 1)) continue // 相邻不连挖
    picked.push(i)
  }
  if (picked.length === 0 && tokens.length > 0) picked.push(0)
  picked.sort((a, b) => a - b)
  // 干扰词：邻句里的 4+ 字母词，去重后取 3 个
  const answerWords = new Set(picked.map((i) => tokens[i].word))
  const pool = new Set<string>()
  for (const n of neighbors) {
    for (const t of tokenizeCue(n.text)) {
      if (t.word.length >= 4 && !answerWords.has(t.word)) pool.add(t.surface)
    }
  }
  const distractors = seededShuffle([...pool], cue.id * 13).slice(0, 3)
  const candidates = seededShuffle(
    [...picked.map((i) => tokens[i].surface), ...distractors],
    cue.id * 31,
  )
  return { blanks: picked, tokens, candidates }
}

interface ClozePanelProps {
  cues: CueV2[]
  idx: number
  setIdx: (i: number) => void
  playSegment: (i: number) => void
  zhOf: (cue: CueV2) => string | undefined
}

export function ClozePanel({ cues, idx, setIdx, playSegment, zhOf }: ClozePanelProps) {
  const cue = cues[idx] as CueV2 | undefined
  const puzzle = useMemo(
    () =>
      cue !== undefined
        ? buildPuzzle(cue, cues.slice(Math.max(0, idx - 2), idx + 3).filter((c) => c.id !== cue.id))
        : null,
    [cue, cues, idx],
  )

  /** blanks 序 → 已填词（null 未填） */
  const [filled, setFilled] = useState<Array<string | null>>([])
  /* 记「用掉了第几块」而不是「用掉了哪个词」：同一句里两个空要同一个词时
     （summer … summer），按词判会让填了一个另一个也变灰，第二个空就再也填不上 */
  const [usedIdx, setUsedIdx] = useState<number[]>([])
  const [wrongIdx, setWrongIdx] = useState<number | null>(null)
  const [mistakes, setMistakes] = useState(0)
  const [doneCues, setDoneCues] = useState<Set<number>>(new Set())

  useEffect(() => {
    setFilled(new Array<string | null>(puzzle?.blanks.length ?? 0).fill(null))
    setUsedIdx([])
    setWrongIdx(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cue?.id])

  if (cue === undefined || puzzle === null) {
    return <div className="panel-empty">本视频暂无字幕，无法挖空练习</div>
  }

  const activeBlank = filled.indexOf(null)
  const complete = puzzle.blanks.length > 0 && activeBlank < 0

  const pick = (surface: string, ci: number) => {
    if (complete || activeBlank < 0) return
    const expected = puzzle.tokens[puzzle.blanks[activeBlank]]
    if (surface.toLowerCase() === expected.word) {
      const next = [...filled]
      next[activeBlank] = expected.surface
      setFilled(next)
      setUsedIdx((u) => [...u, ci])
      setWrongIdx(null)
      if (next.every((f) => f !== null)) {
        setDoneCues((s) => new Set(s).add(cue.id))
      }
    } else {
      setWrongIdx(ci)
      setMistakes((n) => n + 1)
      window.setTimeout(() => setWrongIdx(null), 450)
    }
  }

  /* 句子渲染：挖空处画槽 */
  const parts: React.ReactNode[] = []
  let pos = 0
  puzzle.blanks.forEach((ti, bi) => {
    const t = puzzle.tokens[ti]
    if (t.start > pos) parts.push(cue.text.slice(pos, t.start))
    const val = filled[bi]
    parts.push(
      <span
        key={bi}
        className={`vm-blank${val !== null ? ' ok' : bi === activeBlank ? ' active' : ''}${
          bi === activeBlank && wrongIdx !== null ? ' err' : ''
        }`}
        style={{ minWidth: `${Math.max(3, t.word.length)* 9}px` }}
      >
        {val ?? ' '}
      </span>,
    )
    pos = t.end
  })
  if (pos < cue.text.length) parts.push(cue.text.slice(pos))

  const used = new Set(usedIdx)

  return (
    <>
      <div className="vm-panel-head">
        <h3>挖空模式</h3>
        <span className="chip accent">
          第 {idx + 1} 句 / {cues.length}
        </span>
        <div style={{ flex: 1 }} />
        {mistakes > 0 && <span className="chip warn">错 {mistakes} 次</span>}
      </div>
      <div className="vm-mode-body">
        <div className="card" style={{ padding: '16px 16px' }}>
          <div className="vm-cloze-sent">{parts}</div>
          {zhOf(cue) !== undefined && (
            <div className="vm-mode-zh" style={{ marginTop: 8 }}>
              {zhOf(cue)}
            </div>
          )}
        </div>

        <div className="vm-cands">
          {/* **key 必须用下标，不能用词文本**：候选里允许出现重复词（两个空
              要同一个词），拿文本当 key 翻到下一句时 React 会按 key 复用上一句
              的块而不是替换——实测堆出十个「summer」，当前句里根本没这个词 */}
          {puzzle.candidates.map((c, ci) => (
            <button
              key={ci}
              className={`vm-cand${used.has(ci) ? ' used' : ''}${wrongIdx === ci ? ' err' : ''}`}
              onClick={() => pick(c, ci)}
            >
              {c}
            </button>
          ))}
        </div>

        {complete && (
          <div className="vm-dict-hint" style={{ color: 'var(--ok)', background: 'var(--ok-soft)' }}>
            ✓ 全部填对！点击「下一句」继续
          </div>
        )}

        <div className="vm-mode-acts">
          <button className="btn btn-outline" onClick={() => playSegment(idx)}>
            <VIconPlaySolid style={{ width: 14, height: 14 }} />
            听本句
          </button>
          <button
            className="btn"
            onClick={() => setFilled(new Array<string | null>(puzzle.blanks.length).fill(null))}
          >
            <VIconRefresh />
            重置
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn" disabled={idx <= 0} onClick={() => setIdx(idx - 1)}>
            <VIconArrowLeft />
            上一句
          </button>
          <button
            className="btn btn-primary"
            disabled={idx >= cues.length - 1}
            onClick={() => setIdx(idx + 1)}
          >
            下一句
            <VIconArrowRight />
          </button>
        </div>

        <div className="divider" />
        <div className="vm-mode-stats">
          <span>
            本次已完成 <b>{doneCues.size}</b> 句
          </span>
          <div className="vm-sess-bar">
            <i style={{ width: `${cues.length > 0 ? (doneCues.size / cues.length) * 100 : 0}%` }} />
          </div>
          <span>
            {doneCues.size} / {cues.length}
          </span>
        </div>
      </div>
    </>
  )
}
