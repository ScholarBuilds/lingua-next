/* 保存筛选视图（需求 12 FR-244）：把常用的筛选组合存下来，一键切回。

   存本地不入库：这是个人习惯而非团队资产，进库要多一套接口与迁移，不值当。 */

import { useEffect, useState } from 'react'

import { IconCheck, IconClose, IconPlus } from '../../components/icons'

export interface ViewState {
  health: string
  q: string
}

interface SavedView extends ViewState {
  name: string
}

const KEY = (domain: string) => `ln-pipeline-views:${domain}`

function load(domain: string): SavedView[] {
  try {
    const raw = localStorage.getItem(KEY(domain))
    return raw ? (JSON.parse(raw) as SavedView[]) : []
  } catch {
    return []
  }
}

export function SavedViews({
  domain,
  current,
  onApply,
}: {
  domain: string
  current: ViewState
  onApply: (v: ViewState) => void
}) {
  const [views, setViews] = useState<SavedView[]>(() => load(domain))
  const [naming, setNaming] = useState(false)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    setViews(load(domain))
  }, [domain])

  const persist = (next: SavedView[]) => {
    setViews(next)
    localStorage.setItem(KEY(domain), JSON.stringify(next))
  }

  const save = () => {
    const name = draft.trim()
    if (!name) return
    persist([...views.filter((v) => v.name !== name), { name, ...current }])
    setDraft('')
    setNaming(false)
  }

  const dirty = current.health !== '' || current.q !== ''

  return (
    <div className="sv">
      {views.map((v) => {
        const on = v.health === current.health && v.q === current.q
        return (
          <span key={v.name} className={`sv-chip${on ? ' on' : ''}`}>
            <button onClick={() => onApply(v)}>{v.name}</button>
            <button
              className="sv-x"
              title="删除这个视图"
              onClick={() => persist(views.filter((x) => x.name !== v.name))}
            >
              <IconClose />
            </button>
          </span>
        )
      })}

      {naming ? (
        <span className="sv-chip on">
          <input
            autoFocus
            className="sv-input"
            placeholder="视图名"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
              if (e.key === 'Escape') setNaming(false)
            }}
          />
          <button className="sv-x" onClick={save} title="保存">
            <IconCheck />
          </button>
        </span>
      ) : (
        dirty && (
          <button className="sv-add" onClick={() => setNaming(true)} title="把当前筛选存成视图">
            <IconPlus />
            存为视图
          </button>
        )
      )}
    </div>
  )
}
