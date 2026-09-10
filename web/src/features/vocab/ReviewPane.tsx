import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { IconAlert, IconCheck } from '../../components/icons'
import { api } from '../../lib/api'
import type { ReviewCard, ReviewIntervals, ReviewRating } from '../../lib/api'
import { playTts } from '../../lib/audio'
import { Flashcard } from './Flashcard'

const LEAVE_MS = 200
const AUTO_RATE_MS = 1200

interface ReviewPaneProps {
  autoplay: boolean
}

export function ReviewPane({ autoplay }: ReviewPaneProps) {
  const queryClient = useQueryClient()
  const queueQuery = useQuery({
    queryKey: ['review-queue'],
    queryFn: () => api.reviewQueue(50),
  })

  const [cards, setCards] = useState<ReviewCard[]>([])
  const [intervals, setIntervals] = useState<ReviewIntervals>({})
  const [idx, setIdx] = useState(0)
  const [flipped, setFlipped] = useState(false)
  const [spelling, setSpelling] = useState(false)
  const [typed, setTyped] = useState('')
  const [spellErr, setSpellErr] = useState(false)
  const [spellDone, setSpellDone] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [doneCount, setDoneCount] = useState(0)

  const autoTimer = useRef<number | undefined>(undefined)
  const errTimer = useRef<number | undefined>(undefined)
  const leaveTimer = useRef<number | undefined>(undefined)

  // 队列到达/刷新时重置本轮会话（dataUpdatedAt 保证内容相同的重取也能重置）
  useEffect(() => {
    const data = queueQuery.data
    if (!data) return
    setCards(data.items)
    setIntervals(data.intervals ?? {})
    setIdx(0)
    setFlipped(false)
    setTyped('')
    setSpellErr(false)
    setSpellDone(false)
    setDoneCount(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueQuery.data, queueQuery.dataUpdatedAt])

  useEffect(
    () => () => {
      window.clearTimeout(autoTimer.current)
      window.clearTimeout(errTimer.current)
      window.clearTimeout(leaveTimer.current)
    },
    [],
  )

  const card: ReviewCard | undefined = cards[idx]
  const finished = cards.length > 0 && idx >= cards.length
  const emptyQueue = queueQuery.isSuccess && cards.length === 0
  // 间隔文案：卡片自带的优先（FSRS 状态不同间隔不同），评分响应更新的做兜底
  const activeIntervals = card?.intervals ?? intervals

  // 新卡自动发音（可在顶栏关闭）
  useEffect(() => {
    if (card && autoplay) playTts(card.word, 'vocab')
  }, [card, autoplay])

  const [reviewRun] = useState(() => crypto.randomUUID())
  const pendingRating = useRef<ReviewRating | null>(null)
  const rateMutation = useMutation({
    mutationFn: ({ vocabId, rating }: { vocabId: number; rating: ReviewRating }) =>
      api.submitReview(vocabId, rating, `${reviewRun}:${vocabId}`, card?.card_version ?? null),
    onSuccess: (res) => { pendingRating.current = null; setIntervals(res.intervals); advance() },
  })

  const advance = () => {
    if (leaving) return
    window.clearTimeout(autoTimer.current)
    setLeaving(true)
    leaveTimer.current = window.setTimeout(() => {
      setLeaving(false)
      setFlipped(false)
      setTyped('')
      setSpellErr(false)
      setSpellDone(false)
      setIdx((i) => i + 1)
      setDoneCount((n) => n + 1)
    }, LEAVE_MS)
  }

  const rate = (rating: ReviewRating) => {
    if (!card || leaving || rateMutation.isPending) return
    window.clearTimeout(autoTimer.current)
    pendingRating.current ??= rating
    rateMutation.mutate({ vocabId: card.vocab_id, rating: pendingRating.current })
  }

  const skip = () => {
    if (!card || leaving || rateMutation.isPending) return
    pendingRating.current = null
    advance()
  }

  const toggleSpelling = () => {
    if (leaving) return
    window.clearTimeout(autoTimer.current)
    setSpelling((v) => !v)
    setFlipped(false)
    setTyped('')
    setSpellErr(false)
    setSpellDone(false)
  }

  // 本轮完成后刷新统计
  const finishedRef = useRef(false)
  useEffect(() => {
    if (finished && !finishedRef.current) {
      finishedRef.current = true
      void queryClient.invalidateQueries({ queryKey: ['review-stats'] })
    }
    if (!finished) finishedRef.current = false
  }, [finished, queryClient])

  // 快捷键：拼写模式拦截字母输入；识记模式空格翻面、1-4 评分、S 拼写、P 发音
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target instanceof HTMLElement ? e.target : null
      if (
        t &&
        (t.isContentEditable ||
          (typeof t.closest === 'function' && t.closest('input, textarea, select') !== null))
      )
        return
      if (!card || leaving) return

      if (spelling && !flipped) {
        if (e.key === 'Tab') {
          e.preventDefault()
          toggleSpelling()
          return
        }
        if (e.key === 'Enter') {
          e.preventDefault()
          setFlipped(true)
          return
        }
        if (e.key === 'Backspace') {
          e.preventDefault()
          setTyped((s) => s.slice(0, -1))
          return
        }
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault()
          if (spellErr) return
          const expected = card.word[typed.length]
          if (expected !== undefined && e.key.toLowerCase() === expected.toLowerCase()) {
            const next = typed + expected
            setTyped(next)
            if (next.length === card.word.length) {
              // 拼写完成：翻面确认，稍候自动判「认识」
              setSpellDone(true)
              setFlipped(true)
              autoTimer.current = window.setTimeout(() => rate(3), AUTO_RATE_MS)
            }
          } else {
            // 拼错：抖动示错后清空重来
            setSpellErr(true)
            errTimer.current = window.setTimeout(() => {
              setSpellErr(false)
              setTyped('')
            }, 350)
          }
        }
        return
      }

      if (e.code === 'Space') {
        if (t !== null && typeof t.closest === 'function' && t.closest('button') !== null) return
        e.preventDefault()
        if (!flipped) setFlipped(true)
        return
      }
      if (e.key === 's' || e.key === 'S') {
        toggleSpelling()
        return
      }
      if (e.key === 'p' || e.key === 'P') {
        playTts(card.word, 'vocab')
        return
      }
      if (flipped) {
        if (e.key === '1') rate(1)
        else if (e.key === '2') rate(2)
        else if (e.key === '3') rate(3)
        else if (e.key === '4') rate(4)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (queueQuery.isPending) {
    return (
      <div className="review-wrap">
        <div className="state-block">
          <div className="spinner" />
          <div>加载复习队列…</div>
        </div>
      </div>
    )
  }

  if (queueQuery.isError) {
    return (
      <div className="review-wrap">
        <div className="state-block">
          <IconAlert />
          <div>复习队列加载失败：{queueQuery.error.message}</div>
          <button className="btn btn-outline" onClick={() => void queueQuery.refetch()}>
            重试
          </button>
        </div>
      </div>
    )
  }

  if (emptyQueue || finished || !card) {
    return (
      <DoneBlock
        roundCount={doneCount}
        emptyStart={emptyQueue}
        onRestart={() => void queryClient.invalidateQueries({ queryKey: ['review-queue'] })}
      />
    )
  }

  return (
    <div className="review-wrap">
      <div className="review-col">
        <div className="progress-row">
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{ width: `${(doneCount / cards.length) * 100}%` }}
            />
          </div>
          <span className="progress-num">
            {Math.min(doneCount + 1, cards.length)} / {cards.length}
          </span>
        </div>

        {rateMutation.isError && (
          <div className="review-sync-err" role="alert">评分同步失败：{rateMutation.error.message}
            <button className="btn btn-outline" onClick={() => rate(pendingRating.current ?? 1)}>重试评分</button>
          </div>
        )}

        <Flashcard
          key={card.vocab_id}
          card={card}
          intervals={activeIntervals}
          mode="review"
          flipped={flipped}
          spelling={spelling}
          typed={typed}
          spellErr={spellErr}
          spellDone={spellDone}
          leaving={leaving}
          onFlip={() => setFlipped(true)}
          onRate={rate}
          onNext={skip}
        />

        <div className="aux-row">
          <button
            className={`btn-ghost-sm${spelling ? ' active' : ''}`}
            onClick={(e) => {
              toggleSpelling()
              e.currentTarget.blur()
            }}
          >
            拼写模式
          </button>
          <button
            className="btn-ghost-sm"
            title="标记已掌握（rating 4）"
            onClick={(e) => {
              rate(4)
              e.currentTarget.blur()
            }}
          >
            太简单{activeIntervals['4'] ? ` · ${activeIntervals['4']}` : ''}
          </button>
          <button
            className="btn-ghost-sm"
            onClick={(e) => {
              skip()
              e.currentTarget.blur()
            }}
          >
            跳过
          </button>
        </div>

        <div className="kbd-bar">
          {spelling && !flipped ? (
            <>
              <b>字母键</b> 拼写 · <b>Enter</b> 显示答案 · <b>Tab</b> 返回识记
            </>
          ) : (
            <>
              <b>空格</b> 显示答案 · <b>1/2/3</b> 评分 · <b>4</b> 太简单 · <b>S</b> 拼写 ·{' '}
              <b>P</b> 发音
            </>
          )}
        </div>
      </div>
    </div>
  )
}

interface DoneBlockProps {
  roundCount: number
  /** 队列本来就为空（而非做完一轮） */
  emptyStart: boolean
  onRestart: () => void
}

function DoneBlock({ roundCount, emptyStart, onRestart }: DoneBlockProps) {
  const navigate = useNavigate()
  const statsQuery = useQuery({ queryKey: ['review-stats'], queryFn: api.reviewStats })
  const stats = statsQuery.data

  return (
    <div className="review-wrap">
      <div className="review-col">
        <div className="done-block">
          <div className="done-icon">
            <IconCheck />
          </div>
          <div className="done-title">
            {emptyStart ? '当前没有到期的卡片' : `本轮复习完成，共 ${roundCount} 张`}
          </div>
          {emptyStart && (
            <div className="done-sub">可从左侧词表点「+」学一批新词</div>
          )}
          {stats && (
            <div className="done-stats">
              <span>
                今日已复习 <b>{stats.reviewed_today}</b>
              </span>
              <span>
                新学 <b>{stats.new_today}</b>
              </span>
              <span>
                连续 <b>{stats.streak_days}</b> 天
              </span>
            </div>
          )}
          {stats && stats.upcoming.length > 0 && (
            <div className="done-upcoming">
              待复习排期：
              {stats.upcoming
                .slice(0, 3)
                .map((u) => `${u.date} ${u.count} 词`)
                .join(' · ')}
            </div>
          )}
          <div className="done-actions">
            {stats && stats.due_now > 0 ? (
              <button className="btn btn-primary" onClick={onRestart}>
                继续复习（{stats.due_now}）
              </button>
            ) : (
              <button className="btn btn-outline" onClick={() => navigate('/vocab')}>
                返回书架
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
