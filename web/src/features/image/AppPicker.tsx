/* 应用选择器（模块 16 FR-429）。类名前缀 apk-，独占。

   格子是数据不是代码：这里一个应用名都不认识，全部来自后端注册表
   （`domain/image_apps.py` → catalog.apps / catalog.categories）。分类顺序、组内
   顺序后端都排好了，前端不再排一遍——「学习资产排第一」这条约定住在后端。

   local 引擎的格子给了不同的强调色（绿）：它跑在浏览器里，即时出结果。这是用户在
   二十几个格子之间最关心的一条差别，值得占一个颜色维度。 */

import {
  Check,
  Crop,
  GraduationCap,
  Images,
  Search,
  ShoppingBag,
  Sparkles,
  UserRound,
  WandSparkles,
  X,
} from '@/components/NexusIcon'
import type { LucideIcon } from '@/components/NexusIcon'
import type { KeyboardEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Overlay } from '@/components/Overlay'
import type { ImageApp, ImageCategory } from '@/lib/api-image'

import './AppPicker.css'

/** 分类图标。分类是后端注册表的数据，这里查不到就退回通用图标，不硬失败 */
const CATEGORY_ICON: Record<string, LucideIcon> = {
  learning: GraduationCap,
  create: Sparkles,
  edit: WandSparkles,
  commerce: ShoppingBag,
  portrait: UserRound,
  retouch: Crop,
}

function iconOf(category: string): LucideIcon {
  return CATEGORY_ICON[category] ?? Images
}

interface Group {
  key: string
  label: string
  hint: string
  items: ImageApp[]
}

export function AppPicker({
  apps,
  categories,
  current,
  onPick,
  onClose,
}: {
  apps: ImageApp[]
  categories: ImageCategory[]
  current: string
  onPick: (key: string) => void
  onClose: () => void
}) {
  const currentApp = apps.find((a) => a.key === current)
  const [cat, setCat] = useState(
    () => currentApp?.category ?? categories[0]?.key ?? '',
  )
  const [text, setText] = useState('')
  const [active, setActive] = useState(0)

  const inputRef = useRef<HTMLInputElement>(null)
  const itemRefs = useRef(new Map<string, HTMLButtonElement>())

  const needle = text.trim().toLowerCase()
  const searching = needle !== ''

  const labelOf = useMemo(() => {
    const map = new Map(categories.map((c) => [c.key, c]))
    return (key: string) => map.get(key)
  }, [categories])

  // 搜索时跨分类匹配 label 与 hint；不搜索时按当前分类过滤
  const visible = useMemo(() => {
    if (searching) {
      return apps.filter(
        (a) =>
          a.label.toLowerCase().includes(needle) || a.hint.toLowerCase().includes(needle),
      )
    }
    return apps.filter((a) => a.category === cat)
  }, [apps, cat, needle, searching])

  // 搜索结果按分类分组展示。apps 已按分类顺序排好，按出现顺序建组即可保序
  const groups = useMemo(() => {
    const out: Group[] = []
    const at = new Map<string, number>()
    for (const app of visible) {
      let i = at.get(app.category)
      if (i === undefined) {
        i = out.length
        at.set(app.category, i)
        const meta = labelOf(app.category)
        out.push({
          key: app.category,
          label: meta?.label ?? app.category,
          hint: meta?.hint ?? '',
          items: [],
        })
      }
      out[i].items.push(app)
    }
    return out
  }, [visible, labelOf])

  // 每个分类的命中数：搜索时用它把没命中的分类压暗
  const matched = useMemo(() => {
    const counts = new Map<string, number>()
    for (const app of visible) counts.set(app.category, (counts.get(app.category) ?? 0) + 1)
    return counts
  }, [visible])

  const indexOf = useMemo(() => {
    const map = new Map<string, number>()
    visible.forEach((app, i) => map.set(app.key, i))
    return map
  }, [visible])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // 列表一变就把高亮落回当前应用，落不到就回到第一个
  useEffect(() => {
    const i = visible.findIndex((a) => a.key === current)
    setActive(i >= 0 ? i : 0)
  }, [visible, current])

  useEffect(() => {
    const app = visible[active]
    if (!app) return
    // smooth 在内嵌浏览器面板里会被整个吞掉，一律 auto
    itemRefs.current.get(app.key)?.scrollIntoView({ block: 'nearest', behavior: 'auto' })
  }, [active, visible])

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (visible.length === 0) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((i) => (i + step + visible.length) % visible.length)
      return
    }
    if (e.key !== 'Enter') return
    // 焦点在分类按钮上时 Enter 归它自己，别抢
    if ((e.target as HTMLElement).tagName === 'BUTTON') return
    e.preventDefault()
    const app = visible[active]
    if (app) onPick(app.key)
  }

  const paneHint = searching ? '' : (labelOf(cat)?.hint ?? '')

  return (
    <Overlay onClose={onClose} card="apk-card" labelledBy="apk-title">
      <div className="apk" onKeyDown={onKeyDown}>
        <header className="apk-head">
          <h2 className="apk-title" id="apk-title">
            选择创作应用
          </h2>
          <div className="apk-search">
            <Search />
            <input
              ref={inputRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="搜应用名或说明"
              aria-label="搜索应用"
            />
            {searching && (
              <button className="apk-clear" onClick={() => setText('')} aria-label="清空搜索">
                <X />
              </button>
            )}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <X />
          </button>
        </header>

        <div className="apk-body">
          <nav className="apk-cats" aria-label="应用分类">
            {categories.map((c) => {
              const Icon = iconOf(c.key)
              const hit = matched.get(c.key) ?? 0
              const on = !searching && c.key === cat
              return (
                <button
                  key={c.key}
                  className={`apk-cat${on ? ' on' : ''}${searching && hit === 0 ? ' dim' : ''}`}
                  title={c.hint}
                  aria-current={on ? 'true' : undefined}
                  onClick={() => {
                    setText('')
                    setCat(c.key)
                  }}
                >
                  <Icon />
                  <span className="apk-cat-name">{c.label}</span>
                  <span className="apk-cat-n">{searching ? hit : c.count}</span>
                </button>
              )
            })}
          </nav>

          <div className="apk-list">
            {paneHint !== '' && <p className="apk-pane-hint">{paneHint}</p>}

            {visible.length === 0 ? (
              <p className="apk-empty">没有匹配的应用</p>
            ) : (
              groups.map((group) => {
                const GroupIcon = iconOf(group.key)
                return (
                  <section className="apk-group" key={group.key}>
                    {searching && (
                      <h3 className="apk-group-head">
                        <GroupIcon />
                        {group.label}
                      </h3>
                    )}
                    <div className="apk-grid">
                      {group.items.map((app) => {
                        const Icon = iconOf(app.category)
                        const free = app.engine === 'local'
                        const i = indexOf.get(app.key) ?? -1
                        const classes = [
                          'apk-item',
                          free ? 'free' : '',
                          app.key === current ? 'on' : '',
                          i === active ? 'active' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')
                        return (
                          <button
                            key={app.key}
                            ref={(el) => {
                              if (el) itemRefs.current.set(app.key, el)
                              else itemRefs.current.delete(app.key)
                            }}
                            className={classes}
                            aria-current={app.key === current ? 'true' : undefined}
                            onMouseEnter={() => i >= 0 && setActive(i)}
                            onClick={() => onPick(app.key)}
                          >
                            <span className="apk-item-top">
                              <span className="apk-icon">
                                <Icon />
                              </span>
                              <span className="apk-label">{app.label}</span>
                              {app.key === current && <Check className="apk-check" />}
                              {app.badge && <span className="apk-badge">{app.badge}</span>}
                            </span>
                            <span className="apk-hint" title={app.hint}>
                              {app.hint}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </section>
                )
              })
            )}
          </div>
        </div>

        <footer className="apk-foot">
          <span>
            <b className="apk-key">↑</b>
            <b className="apk-key">↓</b> 选择
          </span>
          <span>
            <b className="apk-key">Enter</b> 打开
          </span>
          <span>
            <b className="apk-key">Esc</b> 关闭
          </span>
          <span className="apk-foot-free">绿色格子在浏览器里跑，即时出结果</span>
        </footer>
      </div>
    </Overlay>
  )
}
