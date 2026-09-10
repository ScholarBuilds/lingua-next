import { useLayoutEffect, useMemo } from 'react'
import { useUrlValue } from '@/lib/urlState'
import { useWorkspaceStore } from '@/lib/workspaceStore'

import { IconChevronRight, IconFileText } from '../../../components/icons'
import type { DocTree } from '../../../lib/api-grammar-docs'

interface Props {
  tree: DocTree
  current: string | null
  onOpen: (path: string) => void
  stateKey: string
}

export function FileTree({ tree, current, onOpen, stateKey }: Props) {
  const [filter, setFilter] = useUrlValue<string>('docFilter', '')
  const recordKey = `tree:${stateKey}`
  const expanded = useWorkspaceStore(s => s.records[`grammar:${recordKey}`]?.expanded)
  const ready = useWorkspaceStore(s => s.ready)
  const open = new Set(expanded ?? [])

  // 当前文档换了章节，把那个章节展开（不收别人）
  const currentChapter = current?.includes('/') === true ? current.split('/')[0] : null
  useLayoutEffect(() => {
    if (currentChapter === null || !ready) return
    const store = useWorkspaceStore.getState()
    const prev = store.records[`grammar:${recordKey}`]?.expanded ?? []
    if (!prev.includes(currentChapter)) store.put('grammar', recordKey, { expanded: [...prev, currentChapter] })
  }, [currentChapter, ready, recordKey])

  const q = filter.trim().toLowerCase()
  const chapters = useMemo(() => {
    if (q === '') return tree.chapters
    return tree.chapters
      .map((c) => ({ ...c, docs: c.docs.filter((d) => d.name.toLowerCase().includes(q)) }))
      .filter((c) => c.docs.length > 0)
  }, [tree, q])
  const loose = q === '' ? tree.loose : tree.loose.filter((d) => d.name.toLowerCase().includes(q))

  const toggle = (name: string) => {
      const next = new Set(open)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      useWorkspaceStore.getState().put('grammar', recordKey, { expanded: [...next] })
  }

  return (
    <nav className="glib-tree" aria-label="讲义目录">
      <input
        className="glib-tree-filter"
        placeholder="筛选文档…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="glib-tree-list">
        {loose.map((d) => (
          <button
            key={d.path}
            className={`glib-tree-doc loose ${d.path === current ? 'on' : ''}`}
            onClick={() => onOpen(d.path)}
          >
            <IconFileText />
            <span>{d.name}</span>
          </button>
        ))}
        {chapters.map((c) => {
          const expanded = q !== '' || open.has(c.name)
          return (
            <div key={c.name} className="glib-tree-chapter">
              <button
                className={`glib-tree-head ${expanded ? 'open' : ''}`}
                onClick={() => toggle(c.name)}
                aria-expanded={expanded}
              >
                <IconChevronRight />
                <span>{c.name}</span>
                <i>{c.docs.length}</i>
              </button>
              {expanded && (
                <div className="glib-tree-docs">
                  {c.docs.map((d) => (
                    <button
                      key={d.path}
                      className={`glib-tree-doc ${d.path === current ? 'on' : ''}`}
                      onClick={() => onOpen(d.path)}
                    >
                      <IconFileText />
                      <span>{d.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        })}
        {chapters.length === 0 && loose.length === 0 && (
          <p className="glib-tree-empty">没有匹配「{filter}」的文档</p>
        )}
      </div>
    </nav>
  )
}
