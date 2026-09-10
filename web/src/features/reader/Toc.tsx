import type { Chapter } from '../../lib/api'

interface TocProps {
  bookTitle: string | undefined
  chapters: Chapter[] | undefined
  loading: boolean
  currentId: number | undefined
  onSelect: (articleId: number) => void
}

export function Toc({ bookTitle, chapters, loading, currentId, onSelect }: TocProps) {
  return (
    <aside className="toc">
      <div className="toc-group">{bookTitle ?? '目录'}</div>
      {loading &&
        Array.from({ length: 8 }, (_, i) => (
          <div
            key={i}
            className="skeleton skeleton-line"
            style={{ margin: '10px 10px 0', width: `${75 - (i % 3) * 12}%` }}
          />
        ))}
      {chapters?.map((ch) => (
        <button
          key={ch.id}
          className={`toc-ch${ch.id === currentId ? ' current' : ''}`}
          onClick={() => onSelect(ch.id)}
        >
          <span className="toc-num">{ch.ordinal}</span>
          <span className="toc-title">{ch.title}</span>
          <span className="toc-meta">{ch.paragraphs} 段</span>
        </button>
      ))}
    </aside>
  )
}
