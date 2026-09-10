/* 章内搜索（FR-376）：在已加载的段落文本里找，命中逐条跳转并高亮。

   搜的是服务端下发的段落原文（不是 DOM 文本），所以命中位置天然是 UTF-16 偏移，
   与批注/词元同口径（BR-01），跳转定位不会因为渲染差异漂移。
   支持整词匹配与正则两档——正则是 Readest 那边验证过的高频诉求，非法正则就地提示。 */

import { useEffect, useMemo, useRef, useState } from 'react'

import { IconChevronLeft, IconChevronRight, IconClose, IconSearch } from '../../components/icons'

export interface SearchHit {
  paragraphId: number
  start: number
  end: number
  /** 命中所在段落的上下文片段，供结果列表预览 */
  preview: string
}

interface Paragraphish {
  id: number
  text: string
}

interface SearchBarProps {
  paragraphs: Paragraphish[]
  onJump: (hit: SearchHit) => void
  onClose: () => void
  /** 命中集合变化时上抛，供正文层做整篇标黄 */
  onHits: (hits: SearchHit[]) => void
}

const MAX_HITS = 500

function buildRegex(q: string, whole: boolean, regex: boolean): RegExp | string {
  try {
    if (regex) return new RegExp(q, 'gi')
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(whole ? `\\b${escaped}\\b` : escaped, 'gi')
  } catch (err) {
    return err instanceof Error ? err.message : '正则表达式无效'
  }
}

export function SearchBar({ paragraphs, onJump, onClose, onHits }: SearchBarProps) {
  const [q, setQ] = useState('')
  const [whole, setWhole] = useState(false)
  const [regex, setRegex] = useState(false)
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => inputRef.current?.focus(), [])

  const { hits, error } = useMemo(() => {
    const term = q.trim()
    if (term.length === 0) return { hits: [] as SearchHit[], error: null as string | null }
    const re = buildRegex(term, whole, regex)
    if (typeof re === 'string') return { hits: [] as SearchHit[], error: re }
    const out: SearchHit[] = []
    for (const p of paragraphs) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(p.text)) !== null) {
        if (m[0].length === 0) {
          re.lastIndex++ // 零宽匹配（如 `a*`）会死循环，手动推进
          continue
        }
        out.push({
          paragraphId: p.id,
          start: m.index,
          end: m.index + m[0].length,
          preview: p.text.slice(Math.max(0, m.index - 34), m.index + m[0].length + 46),
        })
        if (out.length >= MAX_HITS) return { hits: out, error: null }
      }
    }
    return { hits: out, error: null }
  }, [q, whole, regex, paragraphs])

  useEffect(() => {
    onHits(hits)
    setCursor(0)
  }, [hits, onHits])

  useEffect(() => () => onHits([]), [onHits])

  const go = (delta: number) => {
    if (hits.length === 0) return
    const next = (cursor + delta + hits.length) % hits.length
    setCursor(next)
    onJump(hits[next])
  }

  return (
    <div className="rs-bar">
      <div className="rs-field">
        <IconSearch />
        <input
          ref={inputRef}
          placeholder="在本章内查找"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              go(e.shiftKey ? -1 : 1)
            } else if (e.key === 'Escape') {
              onClose()
            }
          }}
        />
        <span className="rs-count">
          {error !== null
            ? '正则无效'
            : q.trim() === ''
              ? ''
              : hits.length === 0
                ? '无匹配'
                : `${cursor + 1}/${hits.length}${hits.length >= MAX_HITS ? '+' : ''}`}
        </span>
      </div>

      <button
        className={`rs-tog${whole ? ' on' : ''}`}
        title="整词匹配：只找独立单词，不匹配词中片段"
        onClick={() => setWhole(!whole)}
      >
        Ab
      </button>
      <button
        className={`rs-tog${regex ? ' on' : ''}`}
        title="正则表达式"
        onClick={() => setRegex(!regex)}
      >
        .*
      </button>

      <button className="icon-btn" title="上一个匹配（Shift+Enter）" onClick={() => go(-1)}>
        <IconChevronLeft />
      </button>
      <button className="icon-btn" title="下一个匹配（Enter）" onClick={() => go(1)}>
        <IconChevronRight />
      </button>
      <button className="icon-btn" title="关闭搜索（Esc）" onClick={onClose}>
        <IconClose />
      </button>

      {error !== null && <div className="rs-err">{error}</div>}
    </div>
  )
}
