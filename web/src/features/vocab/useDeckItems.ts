import { useEffect, useState } from 'react'

import type { DeckFilter, DeckItem } from '../../lib/api-deck'

export function filterDeckItems(items: DeckItem[], filter: DeckFilter) {
  return items.filter(item => filter === 'all' || (filter === 'new' ? item.bucket === 'new'
    : filter === 'mastered' ? item.bucket === 'mature'
      : filter === 'difficult' ? item.bucket === 'hard' || item.difficult
        : (item.bucket === 'learning' || item.bucket === 'young') && !item.difficult))
}

export function mergeDeckItems(previous: DeckItem[], incoming: DeckItem[], filter: DeckFilter = 'all') {
  const merged = new Map(previous.map(item => [item.word.trim().toLowerCase(), item]))
  incoming.forEach(item => {
    const key = item.word.trim().toLowerCase()
    if (merged.has(key) || filterDeckItems([item], filter).length) merged.set(key, item)
  })
  return [...merged.values()]
}

export function updateDeckStages(items: DeckItem[], stages: Record<string, string>): DeckItem[] {
  return items.map(item => {
    const stage = stages[item.word.trim().toLowerCase()]
    if (!stage) return item
    return { ...item,
      mark: stage === 'mastered' || stage === 'hard' || stage === 'learning' ? stage : null,
      difficult: stage === 'hard',
      bucket: stage === 'mastered' ? 'mature' : stage === 'hard' ? 'hard' : stage === 'unseen' ? 'new' : 'learning',
    }
  })
}

export function useDeckItems(scope: string, source: DeckItem[], filter: DeckFilter) {
  const [snapshot, setSnapshot] = useState(() => ({ scope, source, items: filterDeckItems(source, filter) }))
  let current = snapshot
  // 筛选范围决定成员，服务端刷新只更新内容和追加分页，避免标记时挤走当前词。
  if (snapshot.scope !== scope || snapshot.source !== source) {
    current = { scope, source, items: snapshot.scope === scope ? mergeDeckItems(snapshot.items, source, filter) : filterDeckItems(source, filter) }
    setSnapshot(current)
  }
  useEffect(() => {
    const update = (event: Event) => {
      const stages = (event as CustomEvent<Record<string, string>>).detail
      setSnapshot(previous => ({ ...previous, items: updateDeckStages(previous.items, stages) }))
    }
    window.addEventListener('word-stages-changed', update)
    return () => window.removeEventListener('word-stages-changed', update)
  }, [])
  return current.items
}
