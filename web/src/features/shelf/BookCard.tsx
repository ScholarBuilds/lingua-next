import { useState } from 'react'
import type { MouseEvent } from 'react'

import { IconTrash } from '../../components/icons'
import type { BookWithProgress } from '../../lib/api-m5'

/* 程序化封面配色：[渐变起, 渐变止, 文字色]，按 slug 确定性取色 */
const PALETTES: Array<[string, string, string]> = [
  ['#8B6F47', '#6B5233', '#F7F1E5'],
  ['#5B67D8', '#3B2F86', '#EFF0FC'],
  ['#77883F', '#4A5423', '#F2F4E6'],
  ['#C9A84C', '#8A6A1E', '#2C230D'],
  ['#7FA8C9', '#4F7396', '#F2F7FB'],
  ['#B0573F', '#7A3526', '#FBEFE9'],
  ['#5E8F7A', '#38604F', '#EAF5EF'],
  ['#8A5FA0', '#5B3A70', '#F5EEFA'],
]

function paletteOf(slug: string): [string, string, string] {
  let hash = 0
  for (let i = 0; i < slug.length; i++) hash = (hash * 31 + slug.charCodeAt(i)) | 0
  return PALETTES[Math.abs(hash) % PALETTES.length]
}

/** 进度文案：1% 以下保留一位小数，避免刚开读显示成 0% */
export function fmtPct(pct: number): string {
  if (pct >= 1) return `${Math.round(pct)}%`
  return `${pct.toFixed(1)}%`
}

function GeneratedCover({ book }: { book: BookWithProgress }) {
  const [from, to, ink] = paletteOf(book.slug)
  return (
    <div
      className="cover"
      style={{ background: `linear-gradient(165deg, ${from}, ${to})`, color: ink }}
    >
      <div className="cover-title">{book.title}</div>
      <div className="cover-rule" style={{ background: ink }} />
      {book.author && <div className="cover-author">{book.author.toUpperCase()}</div>}
    </div>
  )
}

interface BookCardProps {
  book: BookWithProgress
  opening: boolean
  onOpen: (book: BookWithProgress) => void
  onDelete: (book: BookWithProgress) => void
}

const LEVEL_LABEL: Record<string, string> = { starter: '入门', core: '进阶', deep: '精读' }
const LEVEL_HINT: Record<string, string> = {
  starter: 'CEFR A2-B1：童书与寓言，句子短、从句浅',
  core: 'CEFR B1-B2：通俗小说与冒险科幻，叙事线性',
  deep: 'CEFR B2-C1：文学经典与思想著作，长句与古体词多',
}

export function BookCard({ book, opening, onOpen, onDelete }: BookCardProps) {
  const [imgFailed, setImgFailed] = useState(false)
  const [showError, setShowError] = useState(false)

  const ready = book.status === 'ready'
  const processing = book.status === 'pending' || book.status === 'parsing'
  const failed = book.status === 'failed'

  const handleClick = () => {
    if (ready && !opening) onOpen(book)
    else if (failed) setShowError((v) => !v)
  }

  const handleBadgeClick = (e: MouseEvent) => {
    if (failed) {
      e.stopPropagation()
      setShowError((v) => !v)
    }
  }

  const handleDelete = (e: MouseEvent) => {
    e.stopPropagation()
    onDelete(book)
  }

  const meta = opening
    ? '打开中…'
    : processing
      ? '解析中，请稍候…'
      : failed
        ? '解析失败，点击查看原因'
        : book.state === 'reading'
          ? `读到 ${fmtPct(book.progress_pct)}`
          : book.state === 'finished'
            ? '已读完'
            : (book.author ?? '未知作者')

  return (
    <div
      className={`book${ready || failed ? '' : ' disabled'}`}
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') handleClick()
      }}
    >
      <div style={{ position: 'relative' }}>
        {book.cover_url && !imgFailed ? (
          <div className="cover">
            <img src={book.cover_url} alt={book.title} onError={() => setImgFailed(true)} />
          </div>
        ) : (
          <GeneratedCover book={book} />
        )}
        {book.progress_pct > 0 && (
          <div className="cover-progress">
            <i style={{ width: `${Math.min(book.progress_pct, 100)}%` }} />
          </div>
        )}
        {processing && (
          <span className="chip cover-badge">
            <span className="spinner" />
            解析中
          </span>
        )}
        {failed && (
          <span className="chip err cover-badge" onClick={handleBadgeClick}>
            失败
          </span>
        )}
        <button className="bk-del" title="删除书籍" onClick={handleDelete}>
          <IconTrash />
        </button>
        {/* 难度角标（FR-386）：封面上直接标，不必点进去才知道啃不啃得动 */}
        {book.difficulty !== null && (
          <span className={`bk-level lv-${book.difficulty}`} title={LEVEL_HINT[book.difficulty]}>
            {LEVEL_LABEL[book.difficulty]}
          </span>
        )}
      </div>
      <div className="bk-title">{book.title}</div>
      <div className="bk-meta">{meta}</div>
      {book.tags.length > 0 && (
        <div className="bk-tags" title={book.blurb ?? undefined}>
          {book.tags.slice(0, 2).map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
      )}
      {failed && showError && <div className="book-error">{book.error ?? '未知错误'}</div>}
    </div>
  )
}
