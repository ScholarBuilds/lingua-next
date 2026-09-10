import { useNavigate } from 'react-router-dom'

import { IconArrowUpRight, IconSpeaker } from '../../components/icons'
import type { ReviewCard, ReviewIntervals, ReviewRating } from '../../lib/api'
import { playTts } from '../../lib/audio'
import { splitContext, statusLabel, tagLabel } from './shared'

interface FlashcardProps {
  card: ReviewCard
  intervals: ReviewIntervals
  /** review=先翻面再评分；learn=正面全亮，仅"下一个" */
  mode: 'review' | 'learn'
  flipped: boolean
  spelling: boolean
  typed: string
  spellErr: boolean
  spellDone: boolean
  leaving: boolean
  onFlip: () => void
  onRate: (rating: ReviewRating) => void
  onNext: () => void
}

/** 释义按行渲染（ECDICT translation 以 \n 分行） */
export function DefLines({ text }: { text: string | null }) {
  if (!text) return <div className="fc-def">暂无释义</div>
  return (
    <div className="fc-def">
      {text.split('\n').map((line, i) => (
        <div key={i} className="fc-def-line">
          {line}
        </div>
      ))}
    </div>
  )
}

/** 语境句：高亮目标词，或拼写模式下挖空 */
export function ContextLine({ card, blank }: { card: ReviewCard; blank?: boolean }) {
  if (!card.context) return null
  return (
    <p className="fc-context">
      <em>
        “
        {splitContext(card.context.text, card.word).map((p, i) =>
          p.hit ? <b key={i}>{blank ? '____' : p.text}</b> : p.text,
        )}
        ”
      </em>
    </p>
  )
}

export function SourceChip({ card }: { card: ReviewCard }) {
  const navigate = useNavigate()
  const ctx = card.context
  if (!ctx) return null
  return (
    <button
      className="chip link"
      title="跳转到原文"
      onClick={() => navigate(`/read/${ctx.article_id}?sid=${ctx.sentence_id}`)}
    >
      {ctx.source_label}
      <IconArrowUpRight />
    </button>
  )
}

/** 词典标签行：考纲标签 + 词频档 */
export function TagLine({ card }: { card: ReviewCard }) {
  const parts: string[] = []
  if (card.tags.length > 0) parts.push(card.tags.map(tagLabel).join(' / '))
  // 契约为数字档位，后端实测返回"很常见"等文案，分别渲染
  if (typeof card.freq_band === 'number') parts.push(`词频 Band ${card.freq_band}`)
  else if (card.freq_band) parts.push(`词频${card.freq_band}`)
  if (parts.length === 0) return null
  return <div className="fc-def-src">ECDICT · {parts.join(' · ')}</div>
}

function SpellSlots({
  word,
  typed,
  err,
}: {
  word: string
  typed: string
  err: boolean
}) {
  return (
    <div className={`spell-slots${err ? ' err' : ''}`}>
      {word.split('').map((ch, i) => (
        <span
          key={i}
          className={`spell-slot${ch === ' ' ? ' space' : ''}`}
        >
          {i < typed.length ? ch : ''}
        </span>
      ))}
    </div>
  )
}

const RATINGS: Array<{ rating: ReviewRating; label: string; cls: string }> = [
  { rating: 1, label: '忘记了', cls: 'act-forgot' },
  { rating: 2, label: '模糊', cls: 'act-fuzzy' },
  { rating: 3, label: '认识', cls: 'act-know' },
]

export function Flashcard({
  card,
  intervals,
  mode,
  flipped,
  spelling,
  typed,
  spellErr,
  spellDone,
  leaving,
  onFlip,
  onRate,
  onNext,
}: FlashcardProps) {
  const play = () => playTts(card.word, 'vocab')
  const showBack = mode === 'learn' || flipped
  // 多词短语或"无词典释义但有语境"的条目降级渲染：
  // 隐藏音标/词典标签区，正面显示短语+来源，背面只保留语境+译文
  const isPhrase = /\s/.test(card.word.trim())
  const degraded = isPhrase || (!card.translation && card.context !== null)

  return (
    <div className={`card flashcard${leaving ? ' leaving' : ''}`}>
      <div className="fc-top">
        <span className="chip accent">FSRS · {statusLabel(card.status)}</span>
        <span className="chip">{card.context ? '来自阅读' : '词表'}</span>
        <button className="icon-btn" title="播放发音 (P)" onClick={play}>
          <IconSpeaker />
        </button>
      </div>

      {spelling && !showBack ? (
        <>
          {/* 拼写正面：只留释义 + 挖空语境 + 音标，单词以字母槽呈现 */}
          {(!degraded || card.translation) && <DefLines text={card.translation} />}
          <ContextLine card={card} blank />
          {!degraded && card.phonetic && <div className="fc-phon">/{card.phonetic}/</div>}
          <SpellSlots word={card.word} typed={typed} err={spellErr} />
          <div className="spell-hint">逐字母拼写 · Enter 显示答案 · Tab 返回识记</div>
        </>
      ) : (
        <>
          <div className="fc-word">{card.word}</div>
          {!degraded && card.phonetic && (
            <div className="fc-phon">
              /{card.phonetic}/
              <button
                className="icon-btn"
                title="播放发音 (P)"
                style={{ width: 24, height: 24 }}
                onClick={play}
              >
                <IconSpeaker />
              </button>
            </div>
          )}
          {degraded && !showBack && card.context !== null && (
            <div style={{ marginTop: 14 }}>
              <SourceChip card={card} />
            </div>
          )}

          {showBack ? (
            <>
              <ContextLine card={card} />
              <SourceChip card={card} />
              {(!degraded || card.translation) && (
                <>
                  <div className="fc-divider">
                    <span>{degraded ? '译文' : '释义'}</span>
                  </div>
                  <DefLines text={card.translation} />
                </>
              )}
              {!degraded && card.definition && (
                <div className="fc-def-en">
                  {card.definition.split('\n').map((line, i) => (
                    <div key={i}>{line}</div>
                  ))}
                </div>
              )}
              {!degraded && <TagLine card={card} />}
              {spellDone && <div className="spell-ok">拼写正确，已判定「认识」</div>}

              {mode === 'learn' ? (
                <div className="fc-actions">
                  <div className="fc-act">
                    <button className="act-next" onClick={onNext}>
                      下一个
                    </button>
                    <div className="fc-int">空格 / Enter</div>
                  </div>
                </div>
              ) : (
                <div className="fc-actions">
                  {RATINGS.map(({ rating, label, cls }) => (
                    <div className="fc-act" key={rating}>
                      <button className={cls} onClick={() => onRate(rating)}>
                        {label}
                      </button>
                      <div className="fc-int">{intervals[String(rating)] ?? ''}</div>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <button className="fc-reveal" onClick={onFlip}>
              显示答案（空格）
            </button>
          )}
        </>
      )}
    </div>
  )
}
