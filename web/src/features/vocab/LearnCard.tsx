/* 学新词卡面（FR-295~305）。

   与复习卡（Flashcard）拆开：复习的核心是评分，学新词的核心是「听清楚、看明白、能回想」，
   两者往同一个组件里塞会互相牵制。词典渲染的四块（释义/语境/出处/标签）从 Flashcard 复用。 */

import { IconCheck, IconSpeaker, IconStar } from '../../components/icons'
import type { ReviewCard } from '../../lib/api'
import type { Accent } from '../../lib/audio'
import { WordBreakdown } from '../reader/WordBreakdown'
import { ContextLine, DefLines, SourceChip, TagLine } from './Flashcard'
import { statusLabel } from './shared'

interface LearnCardProps {
  card: ReviewCard
  /** 自测模式下是否已揭示释义 */
  revealed: boolean
  selfTest: boolean
  accent: Accent
  loop: boolean
  collected: boolean
  leaving: boolean
  onReveal: () => void
  onSpeak: () => void
  onSpeakExample: () => void
  onAccent: (a: Accent) => void
  onToggleLoop: () => void
  onCollect: () => void
}

export function LearnCard({
  card,
  revealed,
  selfTest,
  accent,
  loop,
  collected,
  leaving,
  onReveal,
  onSpeak,
  onSpeakExample,
  onAccent,
  onToggleLoop,
  onCollect,
}: LearnCardProps) {
  const showBack = !selfTest || revealed
  const isPhrase = /\s/.test(card.word.trim())
  const degraded = isPhrase || (!card.translation && card.context !== null)

  return (
    <div className={`card flashcard lc${leaving ? ' leaving' : ''}`}>
      <div className="fc-top">
        <span className="chip accent">FSRS · {statusLabel(card.status)}</span>
        <span className="chip">{card.context ? '来自阅读' : '词表'}</span>
        <div style={{ flex: 1 }} />
        <button
          className={`lc-tool${loop ? ' on' : ''}`}
          title={loop ? '循环朗读中，点此停止 (L)' : '循环朗读这个词 (L)'}
          onClick={onToggleLoop}
        >
          <IconSpeaker />
          循环
        </button>
        <button
          className={`lc-tool${collected ? ' on' : ''}`}
          title={collected ? '已收进生词本' : '收进生词本 (S)'}
          disabled={collected}
          onClick={onCollect}
        >
          {collected ? <IconCheck /> : <IconStar />}
          {collected ? '已收' : '收藏'}
        </button>
      </div>

      {/* 朗读热区是整个词头：看着这个词的时候本来就想听它怎么念（BR-55） */}
      <div
        className="lc-head"
        role="button"
        tabIndex={0}
        title="点这里朗读 (R)"
        onClick={onSpeak}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onSpeak()
          }
        }}
      >
        <div className="fc-word">{card.word}</div>
        <div className="lc-phon-row">
          {!degraded && card.phonetic && <span className="fc-phon">/{card.phonetic}/</span>}
          <IconSpeaker className="lc-say" />
        </div>
      </div>

      <div className="lc-accents">
        {(['us', 'uk'] as const).map((a) => (
          <button
            key={a}
            className={accent === a ? 'on' : undefined}
            title={a === 'us' ? '美音 (U)' : '英音 (K)'}
            onClick={() => onAccent(a)}
          >
            {a === 'us' ? '美 US' : '英 UK'}
          </button>
        ))}
      </div>

      {showBack ? (
        <>
          {card.context && (
            <div
              className="lc-eg"
              role="button"
              tabIndex={0}
              title="点这里朗读例句 (E)"
              onClick={onSpeakExample}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  onSpeakExample()
                }
              }}
            >
              <ContextLine card={card} />
            </div>
          )}
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
          {/* 拆开记（FR-329）：与词卡弹窗共用同一个区块 */}
          {!isPhrase && <WordBreakdown word={card.word} />}
        </>
      ) : (
        <button className="fc-reveal" onClick={onReveal}>
          先回想，再看释义（空格）
        </button>
      )}
    </div>
  )
}
