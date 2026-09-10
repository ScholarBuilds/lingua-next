/* 阅读器右栏的三块新面板：书签列表 / 阅读统计 / 快捷键表。

   都是纯展示 + 跳转，没有自己的数据获取逻辑（数据由 ReaderPage 统一查再传下来），
   避免同一份 query 在两处各拉一遍。 */


import { Overlay } from '../../components/Overlay'

import { IconClose, IconTrash } from '../../components/icons'
import { IconBookmark } from './readerIcons'
import type { Bookmark } from '../../lib/api-reader-m5'

/* ═══════════════════════════ 书签 ═══════════════════════════ */

export function BookmarksPanel({
  bookmarks,
  loading,
  onJump,
  onDelete,
}: {
  bookmarks: Bookmark[] | undefined
  loading: boolean
  onJump: (b: Bookmark) => void
  onDelete: (id: number) => void
}) {
  if (loading) {
    return (
      <div className="state-block">
        <div className="spinner" />
      </div>
    )
  }
  if (!bookmarks || bookmarks.length === 0) {
    return (
      <div className="panel-empty">
        <IconBookmark />
        <div>
          本章还没有书签
          <br />
          正文右键「在这里插书签」，或按 B
        </div>
      </div>
    )
  }
  return (
    <div className="bm-list">
      {bookmarks.map((b) => (
        <div key={b.id} className="bm-item" onClick={() => onJump(b)}>
          <IconBookmark filled />
          <div className="bm-body">
            <div className="bm-preview">{b.preview || '（空段落）'}</div>
            <div className="bm-meta">
              第 {(b.paragraph_ordinal ?? 0) + 1} 段
              {b.created_at !== null && ` · ${new Date(b.created_at).toLocaleDateString()}`}
            </div>
          </div>
          <button
            className="icon-btn"
            title="删除书签"
            onClick={(e) => {
              e.stopPropagation()
              onDelete(b.id)
            }}
          >
            <IconTrash />
          </button>
        </div>
      ))}
    </div>
  )
}

/* ═══════════════════════════ 阅读统计 ═══════════════════════════ */

export interface ReadingStats {
  totalWords: number
  readParagraphs: number
  totalParagraphs: number
  durationS: number
  vocabCount: number
  translatedCount: number
  totalSentences: number
  bookmarks: number
  annotations: number
}

function fmtDuration(s: number): string {
  if (s < 60) return `${Math.round(s)} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟`
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`
}

export function StatsPanel({ stats }: { stats: ReadingStats }) {
  const pct =
    stats.totalParagraphs > 0
      ? Math.round((stats.readParagraphs / stats.totalParagraphs) * 100)
      : 0
  // 已读词数按段落占比折算；不足一分钟不给速度，样本太小的 wpm 没有意义
  const readWords = Math.round(stats.totalWords * (stats.readParagraphs / (stats.totalParagraphs || 1)))
  const wpm = stats.durationS >= 60 ? Math.round(readWords / (stats.durationS / 60)) : null
  const remainWords = Math.max(0, stats.totalWords - readWords)
  const etaMin = wpm !== null && wpm > 0 ? Math.ceil(remainWords / wpm) : null

  const rows: Array<[string, string, string?]> = [
    ['本章进度', `${pct}%`, `${stats.readParagraphs}/${stats.totalParagraphs} 段`],
    ['本章词数', stats.totalWords.toLocaleString(), `${stats.totalSentences} 句`],
    ['累计用时', fmtDuration(stats.durationS)],
    ['阅读速度', wpm !== null ? `${wpm} wpm` : '—', wpm === null ? '读满 1 分钟后统计' : undefined],
    [
      '读完还需',
      etaMin !== null ? `约 ${etaMin} 分钟` : '—',
      etaMin === null ? '按你的实际速度估算' : `剩 ${remainWords.toLocaleString()} 词`,
    ],
    ['本章生词', String(stats.vocabCount)],
    ['批注 / 书签', `${stats.annotations} / ${stats.bookmarks}`],
    [
      '译文覆盖',
      stats.totalSentences > 0
        ? `${Math.round((stats.translatedCount / stats.totalSentences) * 100)}%`
        : '—',
      `${stats.translatedCount}/${stats.totalSentences} 句`,
    ],
  ]

  return (
    <div className="rst-list">
      {rows.map(([label, value, hint]) => (
        <div key={label} className="rst-row">
          <span className="rst-label">{label}</span>
          <b className="rst-value">{value}</b>
          {hint !== undefined && <span className="rst-hint">{hint}</span>}
        </div>
      ))}
    </div>
  )
}

/* ═══════════════════════════ 快捷键 ═══════════════════════════ */

const KEYS: Array<[string, Array<[string, string]>]> = [
  [
    '阅读',
    [
      ['J', '跳到下一段'],
      ['K', '跳到上一段'],
      ['G', '回到本章开头'],
      ['Shift+G', '跳到本章末尾'],
      ['F', '专注模式'],
      ['Shift+F', '全屏'],
      ['A', '自动滚动开关'],
    ],
  ],
  [
    '朗读',
    [
      ['Space', '播放 / 暂停'],
      ['← / →', '上一句 / 下一句'],
      ['R', '重读当前句'],
      ['[ / ]', '减速 / 加速'],
    ],
  ],
  [
    '工具',
    [
      ['/ 或 Ctrl+F', '章内搜索'],
      ['B', '在当前位置插书签'],
      ['T', '排版设置'],
      ['V', '切换 原文/双语/译文'],
      ['E', '翻译本章'],
      ['C', 'AI 陪读'],
      ['?', '本表'],
      ['Esc', '关闭浮层'],
    ],
  ],
]

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Overlay onClose={onClose} card="shk-card">
        <div className="overlay-head">
          <div className="overlay-title">键盘快捷键</div>
          <div style={{ flex: 1 }} />
          <button className="icon-btn" title="关闭" onClick={onClose}>
            <IconClose />
          </button>
        </div>
        <div className="shk-grid">
          {KEYS.map(([group, items]) => (
            <section key={group}>
              <div className="shk-group">{group}</div>
              {items.map(([k, desc]) => (
                <div key={k} className="shk-row">
                  <kbd>{k}</kbd>
                  <span>{desc}</span>
                </div>
              ))}
            </section>
          ))}
        </div>
        <div className="overlay-foot">
          <span className="sp-muted">焦点在输入框内时快捷键不触发</span>
          <button className="btn" onClick={onClose}>
            知道了
          </button>
        </div>
      </Overlay>
  )
}
