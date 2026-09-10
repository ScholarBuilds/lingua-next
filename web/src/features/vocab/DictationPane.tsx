/* 听写模式（需求 01 v2 FR-221~229）：只播音频 → 拼写 → 判定。

   与「拼写」的区别是题面不给词形也不给释义，全靠听。提示按梯度逐级解锁，
   每级降低得分系数；判定容忍轻微偏差但必须重打一遍（qwerty-learner 的肌肉记忆逻辑）。 */

import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'

import { IconCheck, IconSpeaker } from '../../components/icons'
import type { DeckItem } from '../../lib/api-deck'
import { apiDeck } from '../../lib/api-deck'
import { playTts, ttsUrl } from '../../lib/audio'
import {
  diffChars,
  judge,
  maskVowels,
  skeleton,
  syllables,
} from './dictation'
import type { Verdict } from './dictation'

const AUTO_PLAY_DELAY = 150
const SLOW_RATE = 0.7
const MAX_HINT = 6

interface DictationPaneProps {
  deckKey: string
  deckName: string
  onExit: () => void
}

export function DictationPane({ deckKey, deckName, onExit }: DictationPaneProps) {
  const [idx, setIdx] = useState(0)
  const [typed, setTyped] = useState('')
  const [hint, setHint] = useState(0)
  const [replays, setReplays] = useState(0)
  const [outcome, setOutcome] = useState<{
    verdict: Verdict
    hint: string | null
    typed: string
  } | null>(null)
  const [retyping, setRetyping] = useState(false)
  const [done, setDone] = useState<Array<{ word: string; verdict: Verdict }>>([])
  const [noAudio, setNoAudio] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // 只取有释义的词：同音异形词纯听无法判别，必须有消歧上下文（FR-228）
  const query = useQuery({
    queryKey: ['dictation-words', deckKey],
    queryFn: () => apiDeck.words(deckKey, { limit: 40, filter: 'learning' }),
  })
  const items: DeckItem[] = useMemo(
    () => (query.data?.items ?? []).filter((w) => w.translation),
    [query.data],
  )
  const current = items[idx]

  const speak = (slow = false) => {
    if (current === undefined || noAudio) return
    if (slow) {
      const audio = new Audio(ttsUrl(current.word, 'word'))
      audio.playbackRate = SLOW_RATE
      void audio.play().catch(() => undefined)
    } else {
      playTts(current.word, 'word')
    }
    setReplays((n) => n + 1)
  }

  // 进题自动播一次，延迟避开入场动画与上一题音频重叠（FR-221）
  useEffect(() => {
    if (current === undefined || noAudio) return
    const timer = setTimeout(() => playTts(current.word, 'word'), AUTO_PLAY_DELAY)
    inputRef.current?.focus()
    return () => clearTimeout(timer)
  }, [current, noAudio])

  const result = useMemo(
    () => (current === undefined ? null : judge(typed, current.word)),
    [typed, current],
  )

  const next = () => {
    setTyped('')
    setHint(0)
    setReplays(0)
    setOutcome(null)
    setRetyping(false)
    setIdx((i) => i + 1)
  }

  const check = () => {
    if (current === null || current === undefined || result === null) return
    // 判错后必须完整重打一遍才能进入下一题（FR-227）
    if (retyping) {
      if (result.verdict === 'correct') next()
      return
    }
    setOutcome({ verdict: result.verdict, hint: result.hint, typed })
    setDone((d) => [...d, { word: current.word, verdict: result.verdict }])
    if (result.verdict === 'correct') {
      setTimeout(next, 700)
    } else {
      setRetyping(true)
      setTyped('')
    }
  }

  if (query.isPending) {
    return (
      <div className="state-block">
        <div className="spinner" />
        <div>准备听写…</div>
      </div>
    )
  }
  if (items.length === 0) {
    return (
      <div className="state-block">
        本内没有可听写的词（需要已在学习中且有释义）
        <button className="btn btn-outline" onClick={onExit}>
          返回
        </button>
      </div>
    )
  }
  if (current === undefined) {
    const right = done.filter((d) => d.verdict === 'correct').length
    return (
      <div className="dic-done">
        <b>听写完成</b>
        <div className="dic-score">
          {right} / {done.length}
        </div>
        <div className="dic-wrong">
          {done
            .filter((d) => d.verdict !== 'correct')
            .map((d) => (
              <span key={d.word}>{d.word}</span>
            ))}
        </div>
        <button className="btn btn-primary" onClick={onExit}>
          返回单词本
        </button>
      </div>
    )
  }

  return (
    <div className="dic">
      <div className="dic-head">
        <span className="dic-title">听写 · {deckName}</span>
        <span className="dic-progress">
          {idx + 1} / {items.length}
        </span>
        <div style={{ flex: 1 }} />
        <button
          className={`btn-ghost-sm${noAudio ? ' active' : ''}`}
          title="降级为「释义 → 拼写」，60 分钟内不再排听写"
          onClick={() => setNoAudio((v) => !v)}
        >
          {noAudio ? '恢复听写' : '现在不方便听'}
        </button>
        <button className="btn-ghost-sm" onClick={onExit}>
          退出
        </button>
      </div>

      <div className="dic-card">
        {noAudio ? (
          <div className="dic-fallback">{current.translation}</div>
        ) : (
          <button className="dic-play" onClick={() => speak(false)} title="重播（Tab）">
            <IconSpeaker />
          </button>
        )}

        {!noAudio && (
          <div className="dic-tools">
            <button className="btn-ghost-sm" onClick={() => speak(true)}>
              慢速
            </button>
            <button
              className="btn-ghost-sm"
              disabled={hint >= MAX_HINT}
              onClick={() => setHint((h) => Math.min(h + 1, MAX_HINT))}
            >
              提示（{hint}/{MAX_HINT}）
            </button>
            {replays > 0 && <span className="dic-replays">重播 {replays} 次</span>}
          </div>
        )}

        <HintRow item={current} level={hint} />

        <input
          ref={inputRef}
          className={`dic-input${outcome ? ` ${outcome.verdict}` : ''}`}
          value={typed}
          placeholder={retyping ? '重打一遍正确拼写' : '听到什么就打什么'}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              check()
            }
            if (e.key === 'Tab') {
              e.preventDefault()
              speak(e.shiftKey)
            }
          }}
        />

        {outcome !== null && (
          <div className={`dic-verdict ${outcome.verdict}`}>
            {outcome.verdict === 'correct' && (
              <>
                <IconCheck /> 正确
              </>
            )}
            {outcome.verdict === 'almost' && <>{outcome.hint ?? '接近了'}，请重打一遍</>}
            {outcome.verdict === 'wrong' && (
              <div className="dic-diff">
                {diffChars(outcome.typed, current.word).map((part, i) => (
                  <span key={i} className={`dic-${part.kind}`}>
                    {part.text}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="dic-hint-foot">Enter 提交 · Tab 重播 · Shift+Tab 慢速</div>
      </div>
    </div>
  )
}

/** 提示梯度渲染：逐级解锁，不可跳级（FR-223） */
function HintRow({ item, level }: { item: DeckItem; level: number }) {
  if (level === 0) return null
  return (
    <div className="dic-hints">
      {level >= 1 && (
        <span className="dic-syl">{'● '.repeat(syllables(item.word)).trim()}</span>
      )}
      {level >= 2 && <span className="dic-skeleton">{skeleton(item.word)}</span>}
      {level >= 3 && (
        <span className="dic-first">
          {item.word[0]}
          {item.phonetic ? ` /${item.phonetic}/` : ''}
        </span>
      )}
      {level >= 4 && <span className="dic-zh">{item.translation}</span>}
      {level >= 5 && <span className="dic-mask">{maskVowels(item.word)}</span>}
      {level >= 6 && <span className="dic-answer">{item.word}</span>}
    </div>
  )
}
