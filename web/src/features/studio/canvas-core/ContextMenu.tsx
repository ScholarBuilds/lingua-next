/* 画布内核 · 上下文菜单（模块 17 · CR-005 §3.8 / 需求 §6.8）
 *
   蓝本有五套彼此独立的菜单 DOM（`createMenu` / `linkCreateMenu` / `nodeInputMenu` /
   `nodeOutputMenu` / `imageNodeMenu`，见 `static/canvas.html`），逻辑重复、样式各写一遍。
   这里收成一套：菜单项由调用方按场景给，组件只管定位、键盘、关闭。

   与蓝本的区别是**每项都带一句说明**——用户明确要求「每个功能都有一定的介绍」。
   蓝本的菜单只有图标 + 两三个字，第一次用完全猜不出「循环节点」是干什么的。 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { useEscapeClose } from '../../../components/Overlay'

import './canvas-core.css'

export interface MenuItem {
  key: string
  label: string
  /** 一句话说明这个东西是干什么用的。列表型菜单必填，动作型菜单可省 */
  hint?: string
  icon?: ReactNode
  disabled?: boolean
  /** 禁用原因。禁用了却不说为什么，用户只会以为坏了 */
  disabledReason?: string
  danger?: boolean
  onSelect: () => void
}

export interface MenuSection {
  key: string
  title?: string
  items: MenuItem[]
}

export interface ContextMenuProps {
  /** 相对画布容器左上角的落点 */
  at: { x: number; y: number }
  sections: MenuSection[]
  onClose: () => void
  /** 菜单标题，例如「在这里新建」 */
  title?: string
  width?: number
}

export function ContextMenu({ at, sections, onClose, title, width = 248 }: ContextMenuProps): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState({ left: at.x, top: at.y })
  const [active, setActive] = useState(0)

  useEscapeClose(onClose)

  const flat = sections.flatMap((s) => s.items)

  /* 贴着落点弹，撞到边界朝反方向翻。
     量的是**菜单自己挂载后的实际尺寸**而不是估一个高度：菜单项数量随场景变，
     估的值在项多时算不准，翻转后照样出界。 */
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const parent = el.offsetParent as HTMLElement | null
    const maxW = parent?.clientWidth ?? window.innerWidth
    const maxH = parent?.clientHeight ?? window.innerHeight
    const margin = 8
    const w = el.offsetWidth
    const h = el.offsetHeight
    setPos({
      left: at.x + w + margin > maxW ? Math.max(margin, at.x - w) : at.x,
      top: at.y + h + margin > maxH ? Math.max(margin, at.y - h) : at.y,
    })
    el.focus({ preventScroll: true })
  }, [at.x, at.y])

  /* 点外部关闭。监听 mousedown 不是 click：打开菜单的那次 click 还在冒泡，
     监听 click 会被它立刻关掉（仓库既有坑）。 */
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [onClose])

  const move = (delta: number): void => {
    if (flat.length === 0) return
    let next = active
    for (let i = 0; i < flat.length; i += 1) {
      next = (next + delta + flat.length) % flat.length
      if (!flat[next].disabled) break
    }
    setActive(next)
  }

  const run = (item: MenuItem): void => {
    if (item.disabled) return
    item.onSelect()
    onClose()
  }

  return (
    <div
      ref={ref}
      className="cvc-menu"
      style={{ left: pos.left, top: pos.top, width }}
      role="menu"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          move(1)
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          move(-1)
        } else if (e.key === 'Enter') {
          e.preventDefault()
          const item = flat[active]
          if (item !== undefined) run(item)
        }
      }}
    >
      {title !== undefined && <div className="cvc-menu-title">{title}</div>}
      {sections.map((section, si) => (
        <div className="cvc-menu-section" key={section.key}>
          {section.title !== undefined && <div className="cvc-menu-group">{section.title}</div>}
          {section.items.map((item) => {
            const flatIndex = flat.indexOf(item)
            const note = item.disabled && item.disabledReason !== undefined ? item.disabledReason : item.hint
            return (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                className={['cvc-menu-item', item.danger ? 'cvc-menu-danger' : '', flatIndex === active ? 'cvc-menu-active' : '']
                  .filter(Boolean)
                  .join(' ')}
                disabled={item.disabled}
                onMouseEnter={() => setActive(flatIndex)}
                onClick={() => run(item)}
              >
                {item.icon !== undefined && <span className="cvc-menu-icon">{item.icon}</span>}
                <span className="cvc-menu-text">
                  <span className="cvc-menu-label">{item.label}</span>
                  {note !== undefined && note !== '' && <span className="cvc-menu-hint">{note}</span>}
                </span>
              </button>
            )
          })}
          {si < sections.length - 1 && <div className="cvc-menu-sep" />}
        </div>
      ))}
      {flat.length === 0 && <div className="cvc-menu-empty">这里没有可用的操作</div>}
    </div>
  )
}
