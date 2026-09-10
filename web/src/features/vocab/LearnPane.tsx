/* 学新词 v2（FR-295~307）：键盘优先的识记流。

   键位照抄 Anki（Space / Enter 前进、R 重播音频）与 Quizlet（← / → 翻卡），不自创一套（BR-62）；
   注册走 react-hotkeys-hook，输入框过滤、清理都由库负责，不手搓全局 keydown（BR-63）。

   本批卡片存 sessionStorage：learn 接口是写操作，领取即落库并进 FSRS 队列，
   刷新后重新请求只会领到新的一批，上一批被丢在半路（BR-G-013）。 */

import { useMutation, useQueryClient } from '@tanstack/react-query'

import { Overlay } from '../../components/Overlay'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { toast } from 'sonner'

import {
  IconAlert,
  IconArrowLeft,
  IconCheck,
  IconChevronRight,
  IconClose,
  IconHelp,
  IconPlus,
} from '../../components/icons'
import { api } from '../../lib/api'
import type { ReviewCard } from '../../lib/api'
import { apiDeck } from '../../lib/api-deck'
import type { Accent } from '../../lib/audio'
import { playTts, playWordAccent, stopTts } from '../../lib/audio'
import { clearSession, readSession, writeSession } from '../../lib/session'
import { LearnCard } from './LearnCard'

const LEAVE_MS = 200
const COUNT_OPTIONS = [5, 10, 20]
/** 循环朗读间隔：一个单词约 0.8s，留出回想的空档 */
const LOOP_MS = 2200
const ACCENT_KEY = 'ln-learn-accent'
const SELFTEST_KEY = 'ln-learn-selftest'

interface Session {
  cards: ReviewCard[]
  idx: number
  collected: string[]
  startedAt: number
}

function sessionKey(listKey: string): string {
  return `ln-learn:${listKey}`
}

interface LearnPaneProps {
  listKey: string
  listName: string
  autoplay: boolean
  onAutoplay: (v: boolean) => void
  /** 回到来处的单词本页 */
  onExit: () => void
}

const SHORTCUTS: Array<[string, string]> = [
  ['空格 / Enter', '揭示 / 下一个'],
  ['→ / ←', '下一个 / 上一个'],
  ['R / P', '重播这个词'],
  ['E', '朗读例句'],
  ['U / K', '美音 / 英音'],
  ['A', '自动朗读开关'],
  ['L', '循环朗读开关'],
  ['D', '自测模式开关'],
  ['S', '收进生词本'],
  ['?', '这张快捷键表'],
  ['Esc', '退出本批'],
]

export function LearnPane({ listKey, listName, autoplay, onAutoplay, onExit }: LearnPaneProps) {
  const queryClient = useQueryClient()
  const [count, setCount] = useState(10)
  const restored = useRef(readSession<Session>(sessionKey(listKey))).current
  const [cards, setCards] = useState<ReviewCard[] | null>(restored?.cards ?? null)
  const [idx, setIdx] = useState(restored?.idx ?? 0)
  const [collected, setCollected] = useState<Set<string>>(new Set(restored?.collected ?? []))
  const startedAt = useRef(restored?.startedAt ?? Date.now())
  const [leaving, setLeaving] = useState(false)
  const leaveTimer = useRef<number | undefined>(undefined)
  const [helpOpen, setHelpOpen] = useState(false)
  const [loop, setLoop] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const [selfTest, setSelfTest] = useState(() => localStorage.getItem(SELFTEST_KEY) === '1')
  const [accent, setAccent] = useState<Accent>(() =>
    localStorage.getItem(ACCENT_KEY) === 'uk' ? 'uk' : 'us',
  )

  const learnMutation = useMutation({
    mutationFn: (n: number) => api.learnNewWords(listKey, n),
    onSuccess: (res) => {
      setCards(res.items)
      setIdx(0)
      setCollected(new Set())
      startedAt.current = Date.now()
    },
  })

  const card: ReviewCard | undefined = cards?.[idx]
  const finished = cards !== null && cards.length > 0 && idx >= cards.length

  // 本批与进度落盘：刷新后回到同一张（FR-306）
  useEffect(() => {
    if (cards === null || cards.length === 0) return
    writeSession(sessionKey(listKey), {
      cards,
      idx,
      collected: [...collected],
      startedAt: startedAt.current,
    } satisfies Session)
  }, [cards, idx, collected, listKey])

  // 学完并入复习：刷新统计 / 复习队列 / 词表进度
  const doneRef = useRef(false)
  useEffect(() => {
    if (finished && !doneRef.current) {
      doneRef.current = true
      clearSession(sessionKey(listKey))
      void queryClient.invalidateQueries({ queryKey: ['review-stats'] })
      void queryClient.invalidateQueries({ queryKey: ['review-queue'] })
      void queryClient.invalidateQueries({ queryKey: ['wordlists'] })
      void queryClient.invalidateQueries({ queryKey: ['decks'] })
    }
    if (!finished) doneRef.current = false
  }, [finished, queryClient, listKey])

  const speak = useCallback(() => {
    if (card) playWordAccent(card.word, accent, false)
  }, [card, accent])

  const speakExample = useCallback(() => {
    if (card?.context) playTts(card.context.text, 'sentence')
  }, [card])

  // 换卡：重置揭示态并按偏好自动朗读
  useEffect(() => {
    setRevealed(false)
    if (card && autoplay) playWordAccent(card.word, accent, false)
    // 依赖只认换卡：accent 放进来会和 pickAccent 自己那次播放撞成连读两遍
  }, [card?.vocab_id, autoplay])

  // 循环朗读：切词或关闭即停（BR-64）
  useEffect(() => {
    if (!loop || !card) return
    const timer = window.setInterval(() => playWordAccent(card.word, accent, false), LOOP_MS)
    return () => window.clearInterval(timer)
  }, [loop, card, accent])
  useEffect(() => setLoop(false), [card?.vocab_id])

  useEffect(
    () => () => {
      window.clearTimeout(leaveTimer.current)
      stopTts()
    },
    [],
  )

  const go = useCallback(
    (delta: number) => {
      if (leaving || cards === null) return
      const next = idx + delta
      if (next < 0) return
      setLeaving(true)
      leaveTimer.current = window.setTimeout(() => {
        setLeaving(false)
        setIdx(next)
      }, LEAVE_MS)
    },
    [leaving, cards, idx],
  )

  const jump = (target: number) => {
    if (cards === null || target === idx) return
    setIdx(Math.min(Math.max(target, 0), cards.length - 1))
  }

  const collect = useCallback(() => {
    if (!card || collected.has(card.word)) return
    setCollected((s) => new Set(s).add(card.word))
    apiDeck
      .batch('__vocab__', 'collect', [card.word])
      .then(() => toast.success(`「${card.word}」已收进生词本`))
      .catch((e: Error) => {
        setCollected((s) => {
          const n = new Set(s)
          n.delete(card.word)
          return n
        })
        toast.error(`收藏失败：${e.message}`)
      })
  }, [card, collected])

  const pickAccent = useCallback(
    (a: Accent) => {
      setAccent(a)
      localStorage.setItem(ACCENT_KEY, a)
      if (card) playWordAccent(card.word, a, false)
    },
    [card],
  )

  /* ---- 快捷键（FR-295~305）。学习中才启用，起始页/完成页不吃键 ---- */
  const live = card !== undefined && !finished
  const opts = { enabled: live && !helpOpen, preventDefault: true }

  /* 空格 / Enter 走 Anki 语义：自测模式下第一次是「揭示」，再按才前进。
     ← / → 是显式导航（Quizlet 语义），任何时候都直接翻卡，不吃揭示这一步。 */
  useHotkeys(
    'space, enter',
    () => {
      if (selfTest && !revealed) setRevealed(true)
      else go(1)
    },
    opts,
    [selfTest, revealed, go],
  )
  useHotkeys('right', () => go(1), opts, [go])
  useHotkeys('left', () => go(-1), opts, [go])
  useHotkeys('r, p', () => speak(), opts, [speak])
  useHotkeys('e', () => speakExample(), opts, [speakExample])
  useHotkeys('u', () => pickAccent('us'), opts, [pickAccent])
  useHotkeys('k', () => pickAccent('uk'), opts, [pickAccent])
  useHotkeys('a', () => onAutoplay(!autoplay), opts, [autoplay, onAutoplay])
  useHotkeys('l', () => setLoop((v) => !v), opts, [])
  useHotkeys(
    'd',
    () => {
      setSelfTest((v) => {
        localStorage.setItem(SELFTEST_KEY, v ? '0' : '1')
        return !v
      })
      setRevealed(false)
    },
    opts,
    [],
  )
  useHotkeys('s', () => collect(), opts, [collect])
  useHotkeys('shift+slash, slash', () => setHelpOpen(true), { enabled: live, preventDefault: true }, [])
  useHotkeys(
    'escape',
    () => {
      if (helpOpen) setHelpOpen(false)
      else onExit()
    },
    { enabled: cards !== null, preventDefault: true },
    [helpOpen, onExit],
  )

  const elapsedMin = useMemo(
    () => Math.max(1, Math.round((Date.now() - startedAt.current) / 60000)),
    // 只在完成页读一次即可
    [finished],
  )

  // 起始页：选数量后再取词，避免误触发写操作
  if (cards === null && !learnMutation.isPending && !learnMutation.isError) {
    return (
      <div className="review-wrap">
        <div className="review-col">
          <div className="done-block">
            <div className="done-icon accent">
              <IconPlus />
            </div>
            <div className="done-title">从「{listName}」学新词</div>
            <div className="done-sub">按词表顺序取尚未学习的单词，学完自动并入复习队列</div>
            <div className="seg">
              {COUNT_OPTIONS.map((n) => (
                <button
                  key={n}
                  className={count === n ? 'active' : undefined}
                  onClick={() => setCount(n)}
                >
                  {n} 个
                </button>
              ))}
            </div>
            <label className="lc-opt">
              <input
                type="checkbox"
                checked={selfTest}
                onChange={(e) => {
                  setSelfTest(e.target.checked)
                  localStorage.setItem(SELFTEST_KEY, e.target.checked ? '1' : '0')
                }}
              />
              自测模式：先只给单词，回想后再看释义
            </label>
            <div className="done-actions">
              <button className="btn btn-primary" onClick={() => learnMutation.mutate(count)}>
                开始学习
              </button>
              <button className="btn btn-outline" onClick={onExit}>
                返回单词本
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (learnMutation.isPending) {
    return (
      <div className="review-wrap">
        <div className="state-block">
          <div className="spinner" />
          <div>正在挑选新词…</div>
        </div>
      </div>
    )
  }

  if (learnMutation.isError) {
    return (
      <div className="review-wrap">
        <div className="state-block">
          <IconAlert />
          <div>取新词失败：{learnMutation.error.message}</div>
          <button className="btn btn-outline" onClick={() => learnMutation.mutate(count)}>
            重试
          </button>
          <button className="btn" onClick={onExit}>
            返回单词本
          </button>
        </div>
      </div>
    )
  }

  if (cards !== null && cards.length === 0) {
    return (
      <div className="review-wrap">
        <div className="state-block">
          <IconCheck />
          <div>「{listName}」已没有更多新词</div>
          <button className="btn btn-outline" onClick={onExit}>
            返回单词本
          </button>
        </div>
      </div>
    )
  }

  if (finished || !card || cards === null) {
    return (
      <div className="review-wrap">
        <div className="review-col">
          <div className="done-block">
            <div className="done-icon">
              <IconCheck />
            </div>
            <div className="done-title">已学完 {cards?.length ?? 0} 个新词</div>
            <div className="done-sub">
              收进生词本 {collected.size} 个 · 用时约 {elapsedMin} 分钟
              <br />
              这批词已并入复习队列，按 FSRS 排期出现
            </div>
            <div className="done-actions">
              <button className="btn btn-primary" onClick={onExit}>
                返回单词本
              </button>
              <button
                className="btn btn-outline"
                onClick={() => {
                  clearSession(sessionKey(listKey))
                  setCards(null)
                  setIdx(0)
                  setCollected(new Set())
                }}
              >
                再学一批
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="review-wrap">
      <div className="review-col">
        {/* 进度条可点跳转（FR-296）：想回看第 3 个不必按三次左键 */}
        <div className="progress-row">
          <button
            className="lc-nav"
            disabled={idx === 0}
            title="上一个 (←)"
            onClick={() => go(-1)}
          >
            <IconArrowLeft />
          </button>
          <div className="progress-track lc-track">
            <div className="progress-fill" style={{ width: `${(idx / cards.length) * 100}%` }} />
            <div className="lc-ticks">
              {cards.map((c, i) => (
                <button
                  key={c.vocab_id}
                  className={`lc-tick${i === idx ? ' on' : ''}${i < idx ? ' done' : ''}`}
                  title={`第 ${i + 1} 个：${c.word}`}
                  onClick={() => jump(i)}
                />
              ))}
            </div>
          </div>
          <button className="lc-nav" title="下一个 (→)" onClick={() => go(1)}>
            <IconChevronRight />
          </button>
          <span className="progress-num">
            {Math.min(idx + 1, cards.length)} / {cards.length}
          </span>
        </div>

        <LearnCard
          key={card.vocab_id}
          card={card}
          revealed={revealed}
          selfTest={selfTest}
          accent={accent}
          loop={loop}
          collected={collected.has(card.word)}
          leaving={leaving}
          onReveal={() => setRevealed(true)}
          onSpeak={speak}
          onSpeakExample={speakExample}
          onAccent={pickAccent}
          onToggleLoop={() => setLoop((v) => !v)}
          onCollect={collect}
        />

        <div className="lc-bar">
          <button className={`lc-chip${autoplay ? ' on' : ''}`} onClick={() => onAutoplay(!autoplay)}>
            自动朗读 {autoplay ? '开' : '关'} <i>A</i>
          </button>
          <button className={`lc-chip${loop ? ' on' : ''}`} onClick={() => setLoop((v) => !v)}>
            循环 {loop ? '开' : '关'} <i>L</i>
          </button>
          <button
            className={`lc-chip${selfTest ? ' on' : ''}`}
            onClick={() => {
              setSelfTest((v) => {
                localStorage.setItem(SELFTEST_KEY, v ? '0' : '1')
                return !v
              })
              setRevealed(false)
            }}
          >
            自测 {selfTest ? '开' : '关'} <i>D</i>
          </button>
          <div style={{ flex: 1 }} />
          <button className="lc-chip" title="快捷键 (?)" onClick={() => setHelpOpen(true)}>
            <IconHelp />
            快捷键
          </button>
        </div>

        <div className="kbd-bar">
          <b>← →</b> 翻卡 · <b>空格</b> 揭示 / 下一个 · <b>R</b> 重播 · <b>S</b> 收藏 · <b>?</b> 全部
        </div>
      </div>

      {helpOpen && (
        <Overlay onClose={() => setHelpOpen(false)} card="lc-help">
            <div className="overlay-head">
              <div className="overlay-title">快捷键</div>
              <div style={{ flex: 1 }} />
              <button className="icon-btn" onClick={() => setHelpOpen(false)}>
                <IconClose />
              </button>
            </div>
            <div className="lc-help-list">
              {SHORTCUTS.map(([k, desc]) => (
                <div key={k} className="lc-help-row">
                  <kbd>{k}</kbd>
                  <span>{desc}</span>
                </div>
              ))}
            </div>
            <div className="overlay-foot">
              <span className="sp-muted">键位沿用 Anki 与 Quizlet 的习惯</span>
              <button className="btn" onClick={() => setHelpOpen(false)}>
                知道了
              </button>
            </div>
          </Overlay>
      )}
    </div>
  )
}
