import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

import { overlayDepth } from '../../components/Overlay'
import type { DeckFilter, DeckItem, WordMark } from '../../lib/api-deck'
import { useWordModalStore } from '../reader/wordModalStore'

const MARK_KEYS: Record<string, WordMark> = { '1': 'learning', '2': 'hard', '3': 'mastered' }

type SelfTest = {
  selected: string | null
  revealed: Set<string>
  reveal: (word: string) => void
  mark: (word: string, value: WordMark) => void
}

const SelfTestContext = createContext<SelfTest | null>(null)
export const useDeckSelfTest = () => useContext(SelfTestContext)

export function DeckSelfTest({ enabled, items, onMark, onOpenWord, onLoadMore, children }: {
  enabled: boolean
  filter: DeckFilter
  items: DeckItem[]
  onMark: (word: string, value: WordMark) => Promise<void>
  onOpenWord: (item: DeckItem) => void
  onLoadMore?: () => void
  children: (items: DeckItem[]) => ReactNode
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const [revealed, setRevealed] = useState(new Set<string>())
  const openedWord = useRef<string | null>(null)
  const [saving, setSaving] = useState(false)
  const busy = useRef(false)
  const [message, setMessage] = useState('点击遮挡查看答案，再标记掌握情况')
  const [error, setError] = useState('')
  const visible = items
  const openSelected = () => {
    const item = visible.find(item => item.word === selected)
    if (!item || busy.current) return
    openedWord.current = item.word
    onOpenWord(item)
  }
  useEffect(() => {
    if (enabled && visible.length === 0) onLoadMore?.()
  }, [enabled, visible.length, onLoadMore])

  useEffect(() => {
    if (!enabled || busy.current || selected === null || visible.some(item => item.word === selected)) return
    setSelected(visible[0]?.word ?? null)
  }, [enabled, selected, visible])

  const reveal = (word: string) => {
    if (busy.current) return
    setSelected(word)
    setRevealed(previous => new Set(previous).add(word))
  }
  const move = (delta: number) => {
    if (busy.current || !visible.length) return
    const index = visible.findIndex(item => item.word === selected)
    setSelected(visible[Math.max(0, Math.min(visible.length - 1, index + delta))].word)
  }
  const mark = async (word: string, value: WordMark) => {
    if (busy.current) return
    busy.current = true
    setSaving(true)
    setError('')
    try {
      await onMark(word, value)
      setSelected(word)
      setMessage(`${word} 已标记为${value === 'learning' ? '学习中' : value === 'hard' ? '困难词' : '已掌握'}`)
    } catch (reason) {
      setSelected(word)
      setError(reason instanceof Error ? reason.message : '保存失败，请重试')
    } finally {
      busy.current = false
      setSaving(false)
    }
  }

  useEffect(() => {
    if (!enabled) return
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || overlayDepth() > 0) return
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable], [role="combobox"], [role="menu"], [role="listbox"]')) return
      const modal = useWordModalStore.getState()
      if (modal.stack.length) {
        const top = modal.stack[0]
        if (event.key.toLowerCase() === 'v' && modal.stack.length === 1 && top.kind === 'word' && top.word === openedWord.current?.toLowerCase()) {
          event.preventDefault()
          modal.close()
        }
        return
      }
      if (event.target instanceof Element && event.target.closest('[role="dialog"]')) return
      if (event.key === ' ' && selected && !busy.current) {
        event.preventDefault()
        reveal(selected)
      } else if (event.key.toLowerCase() === 'v' && selected && !busy.current) {
        event.preventDefault()
        openSelected()
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        move(event.key === 'ArrowLeft' ? -1 : 1)
      } else if (selected && MARK_KEYS[event.key]) {
        event.preventDefault()
        void mark(selected, MARK_KEYS[event.key])
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  return <SelfTestContext.Provider value={enabled ? { selected, revealed, reveal, mark: (word, value) => { void mark(word, value) } } : null}>
    {enabled && <div className="dd-self-test" role="region" aria-label="遮挡自测">
      <span>{selected ? revealed.has(selected) ? `当前词：${selected}` : '当前词：待揭示' : '遮挡自测'}</span>
      <button className="btn btn-ghost" aria-keyshortcuts="Space" disabled={!selected || saving} onClick={() => selected && reveal(selected)}>空格 查看答案</button>
      <button className="btn btn-outline" aria-keyshortcuts="V" title="V 打开或关闭词卡，Esc 关闭" disabled={!selected || saving} onClick={openSelected}>V 打开词卡</button>
      {(['learning', 'hard', 'mastered'] as const).map((value, index) => <button key={value} className="btn btn-outline" disabled={!selected || saving} onClick={() => selected && void mark(selected, value)}>{index + 1} {value === 'learning' ? '学习中' : value === 'hard' ? '困难词' : '已掌握'}</button>)}
      <span className="muted">← → 切词 · Esc 关闭词卡 · 标记后留在原位，切换筛选后更新</span>
      <span role={error ? 'alert' : 'status'}>{error || (saving ? '正在保存…' : message)}</span>
    </div>}
    {enabled && !visible.length && !onLoadMore && <div className="state-block">当前分类没有待自测的词，可切换分类继续。</div>}
    {children(visible)}
  </SelfTestContext.Provider>
}
