/* 全站统一的浮层外壳。

   全仓十五处手写 `<div className="overlay" onClick={onClose}>`，其中**只有四处**
   处理了 Esc——用户在哪个弹窗按 Esc 有没有反应全凭运气。与其逐个补，不如收成
   一个组件：新加浮层默认就有 Esc 与点击遮罩关闭，想漏也漏不掉。

   > [!warning] Esc 只能关最上面那一层
   >
   > 浮层是会嵌套的（节点弹窗里点开大图、设置弹窗里开二级面板）。每个浮层各自
   > 挂一个 window keydown 监听的话，一次 Esc 会把整摞全关掉——用户只想退出大图，
   > 结果连节点弹窗一起没了。所以这里维护一个栈，全局只绑一个监听，只调栈顶。 */

import type { ReactNode } from 'react'
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'

import { useFullscreenElement } from './FullscreenPortal'

/** 当前打开的浮层栈，后进先出 */
const stack: Array<{ close: () => void }> = []
let bound = false

/* 栈变化的订阅者。让页面能问「现在有浮层开着吗」——
   页面级全局快捷键必须据此让路，否则浮层开着时按 Delete 删的是**背后画布上的节点**
   （编辑器正在编的那个节点恰好是选中态，一按就没了，而且是不可见的破坏）。 */
const watchers = new Set<() => void>()
function notify(): void {
  for (const fn of watchers) fn()
}

/** 现在有几层浮层开着。0 = 没有 */
export function overlayDepth(): number {
  return stack.length
}

/** 订阅「有没有浮层开着」。给页面级快捷键当开关用。
 *
 *  用 `useSyncExternalStore` 而不是自己 useState + useEffect：
 *  浮层的挂载与页面的渲染在同一批里发生，晚一帧才知道就会漏掉那一帧的按键。 */
export function useOverlayOpen(): boolean {
  return useSyncExternalStore(
    (fn) => {
      watchers.add(fn)
      return () => watchers.delete(fn)
    },
    () => stack.length > 0,
    () => false,
  )
}

function ensureBound(): void {
  if (bound) return
  bound = true
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || stack.length === 0) return
    // 阻止继续冒泡，避免下层页面自己的 Esc 处理（阅读器工具条等）跟着触发
    e.stopPropagation()
    stack[stack.length - 1].close()
  })
}

/** 加入浮层栈，Esc 时若自己在栈顶就关闭（STD-UI-002）。
 *
 *  给用不了 `<Overlay>` 结构的层用：侧滑抽屉、`FullscreenPortal` 里的浮层、
 *  以及带自定义遮罩的面板。它们必须与 `<Overlay>` 共用同一个栈，否则两套
 *  Esc 各管各的，嵌套时又会一次全关掉。
 *
 *  `enabled` 传 false 时不入栈——用于"正在打字，这一下 Esc 不该关面板"。 */
export function useEscapeClose(onClose: () => void, enabled = true): void {
  const latest = useRef(onClose)
  latest.current = onClose
  useEffect(() => {
    if (!enabled) return
    ensureBound()
    const entry = { close: () => latest.current() }
    stack.push(entry)
    notify()
    return () => {
      const i = stack.indexOf(entry)
      if (i >= 0) stack.splice(i, 1)
      notify()
    }
  }, [enabled])
}

export function Overlay({
  onClose,
  card = '',
  children,
  dismissable = true,
  labelledBy,
}: {
  onClose: () => void
  /** 追加到 .overlay-card 上的尺寸/布局类，如 "sp-modal" */
  card?: string
  children: ReactNode
  /** 关掉后 Esc 与点遮罩都不再关闭——留给必须做出选择的确认框 */
  dismissable?: boolean
  labelledBy?: string
}) {
  // onClose 每次渲染都是新函数，用 ref 持有才不会反复重挂监听
  const latest = useRef(onClose)
  latest.current = onClose
  useEscapeClose(onClose, dismissable)
  const fullscreen = useFullscreenElement()

  const layer = (
    <div className="overlay" onClick={dismissable ? () => latest.current() : undefined}>
      <div
        className={card === '' ? 'overlay-card' : `overlay-card ${card}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
      >
        {children}
      </div>
    </div>
  )

  /* **一律 portal 出去**，不留在调用方的 DOM 位置。
   *
   *  `position: fixed` 只在没有 transform / filter / contain 祖先时才相对视口定位。
   *  画布的生成条是 `transform: translateX(-50%)` 定位的，从它里面打开词库时，
   *  遮罩变成相对生成条定位（实测宽 918 而不是视口的 1560），卡片跟着跑偏、
   *  下沿超出视口 232px——用户看到的是「弹窗弹出来一半在屏幕外」。
   *  这条对任何有 transform 祖先的调用点都成立，所以修在这里而不是逐个躲。
   *
   *  宿主取全屏元素优先：Fullscreen API 只渲染全屏元素的后代子树，
   *  全屏期间挂到 body 上的浮层等于凭空消失（本仓踩过）。 */
  return createPortal(layer, fullscreen ?? document.body)
}
