/* 单词本封面卡片（需求 01 v2 FR-155、FR-156；生成封面见模块 16 FR-420）。
   有 AI 封面就铺图，没有则回落"确定性渐变 + emoji"——后者零图片请求、
   离线可用，是加载前占位与出图失败时的兜底，不因为有了生图就删。 */

import { useState } from 'react'

import { IconDownload, IconEdit, IconStar, IconTrash } from '../../components/icons'
import type { Deck } from '../../lib/api-deck'
import { deckGradient, deckInitial, MASTERY_META, relativeDay } from '../../lib/api-deck'
import { VocabCoverArtwork, vocabCoverCell } from './VocabCover'

interface DeckCardProps {
  deck: Deck
  onOpen: () => void
  onEdit?: () => void
  onDelete?: () => void
  onExport?: () => void
  onTogglePin?: () => void
}

export function DeckCard({
  deck,
  onOpen,
  onEdit,
  onDelete,
  onExport,
  onTogglePin,
}: DeckCardProps) {
  const [coverFailed, setCoverFailed] = useState(false)
  const hasImage2Cover = vocabCoverCell(deck) !== null
  const hasUploadedCover = deck.cover_url !== null && !coverFailed && !hasImage2Cover
  const hasCover = hasImage2Cover || hasUploadedCover
  const studied = relativeDay(deck.last_studied_at)
  const isAi = deck.source === 'ai'

  return (
    <div
      className={`deck-card${deck.archived ? ' archived' : ''}`}
      role="button"
      tabIndex={0}
      title={deck.description ?? deck.name}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          onOpen()
        }
      }}
    >
      <div
        className={`deck-cover${deck.emoji ? '' : ' initial'}${hasCover ? ' has-img' : ''}`}
        style={{ background: deckGradient(deck.color_seed) }}
      >
        {/* 生成封面盖在渐变之上；加载失败就退回下面的 emoji，兜底不删（FR-420） */}
        {hasImage2Cover && <VocabCoverArtwork deck={deck} />}
        {hasUploadedCover && (
          <img
            src={deck.cover_url as string}
            alt=""
            loading="lazy"
            onError={() => setCoverFailed(true)}
          />
        )}
        {!hasCover && (deck.emoji ?? deckInitial(deck.name))}

        <div className="deck-badges">
          {isAi && <span className="deck-badge ai">AI</span>}
          {deck.cefr && <span className="deck-badge">{deck.cefr}</span>}
          {deck.archived && <span className="deck-badge">已归档</span>}
        </div>

        {/* 悬停才出的操作层：位置压在封面右上，不占卡片正文空间 */}
        <div className="deck-ops" onClick={(e) => e.stopPropagation()}>
          {onTogglePin && (
            <button
              className="deck-op"
              title={deck.pinned ? '取消置顶' : '置顶'}
              onClick={onTogglePin}
            >
              <IconStar filled={deck.pinned} />
            </button>
          )}
          {onEdit && (
            <button className="deck-op" title="编辑" onClick={onEdit}>
              <IconEdit />
            </button>
          )}
          {onExport && (
            <button className="deck-op" title="导出 Anki" onClick={onExport}>
              <IconDownload />
            </button>
          )}
          {onDelete && (
            <button className="deck-op danger" title="删除" onClick={onDelete}>
              <IconTrash />
            </button>
          )}
        </div>

        {(deck.due_now ?? 0) > 0 && (
          <span className="vp-due-badge">
            待复习 {deck.due_now}
          </span>
        )}
      </div>

      <div className="deck-body">
        <div className="deck-name">{deck.name}</div>
        <div className="deck-meta">
          <span>{deck.total.toLocaleString()} 词</span>
          {studied && (
            <>
              <i className="dot" />
              <span>{studied}</span>
            </>
          )}
        </div>
        <MasteryBar deck={deck} />
      </div>
    </div>
  )
}

/** 四色分段条：段宽即占比，总词数为 0 时整条留空不误导 */
export function MasteryBar({ deck }: { deck: Deck }) {
  const total = deck.total || 1
  return (
    <div className="deck-bar">
      {MASTERY_META.map(({ key, color, label }) => {
        const count = deck.mastery[key] ?? 0
        if (count <= 0) return null
        return (
          <i
            key={key}
            style={{ width: `${(count / total) * 100}%`, background: color }}
            title={`${label} ${count.toLocaleString()}`}
          />
        )
      })}
    </div>
  )
}
