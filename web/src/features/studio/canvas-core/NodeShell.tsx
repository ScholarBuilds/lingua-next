/* 画布内核 · 节点外壳与端口（模块 17 · CR-005 §3.1 / 需求 §6.7）
 *
   移植自 Infinite-Canvas `static/js/smart-canvas.js` 的节点渲染与
   `startNodeDrag` / `startLink` / `startNodeResize`（约 6100~6360 行同族逻辑）。

   外壳负责所有节点共用的东西：定位、选中态、拖拽、缩放手柄、输入输出端口、
   头部悬浮工具条。节点自己的内容（图片网格、提示词输入、循环参数）由 children 给，
   外壳一概不认识——蓝本这里是一个几百行的 if/else 按 type 拼 HTML，
   加一种节点就要动那个巨型函数。

   **拖拽用指针捕获，不用 window 全局监听**：蓝本靠 `window.onmousemove` 追踪，
   鼠标拖出窗口再松开就丢 mouseup，节点会粘在指针上跟着走。 */

import { useCallback, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'

import type { Point, Rect, ResizeHandle, Viewport } from './geometry'
import { capturePointer, releasePointer, resizeCursor, resizeRectBy, safeScale } from './geometry'
import { selectModeOf } from './selection'
import type { SelectMode } from './selection'

import './canvas-core.css'

export type PortSide = 'in' | 'out'

/** 不指定时只给右下角：改造前就是这一个，老调用方接上来行为不变 */
const DEFAULT_HANDLES: readonly ResizeHandle[] = ['se']
/** 缩放下限的兜底。真正的下限由调用方按内容算（分组要放得下最宽的成员） */
const DEFAULT_MIN_SIZE = { w: 120, h: 80 }

export interface NodeShellProps {
  id: string
  x: number
  y: number
  width?: number
  height?: number
  selected?: boolean
  /** 正在跑：外框走呼吸动效 */
  running?: boolean
  /** 排队中：外框虚线 */
  queued?: boolean
  title?: ReactNode
  /** 头部右上角的角标，例如「3 轮 · 并发」 */
  badge?: ReactNode
  /** 选中或悬停时浮在头部上方的工具条 */
  toolbar?: ReactNode
  children?: ReactNode
  viewport: Viewport
  /** 拖动结束时回调新的世界坐标。拖动过程中由外壳自己用 transform 走，
   *  不每帧往 store 写——100 个节点时每帧 setState 会把帧率打到 20 以下。
   *  `alt` = 按住 Alt 拖的：调用方应该复制一份放到新位置，原节点不动。 */
  onMove?: (id: string, x: number, y: number, opts: { append: boolean; alt: boolean; altShift: boolean }) => void
  /** 拖动中的实时位移，给「一起拖多个选中节点」用 */
  onMoveLive?: (id: string, dx: number, dy: number) => void
  onSelect?: (id: string, mode: SelectMode) => void
  onContextMenu?: (id: string, screen: Point) => void
  /** 双击。**把原始事件一并交出去**：多图节点要知道双击落在哪一张缩略图上，
   *  而内核不认识「资产」这种业务概念，只能由调用方从事件里自己取。
   *  少了这个参数的后果很隐蔽——节点里层若也接了双击，两个处理器一先一后各调一次，
   *  后跑的这个用 undefined 把前面取到的落点覆盖掉，表现为「点第 3 张打开的是第 1 张」。 */
  onDoubleClick?: (id: string, event: ReactMouseEvent) => void
  /** 从端口拖出连线 */
  onPortDown?: (id: string, side: PortSide, e: ReactPointerEvent) => void
  /** 拖到这个节点上方（连线落点判定用） */
  onPortEnter?: (id: string, side: PortSide) => void
  onPortLeave?: () => void
  /** 缩放手柄回调。不给就不渲染任何手柄。
   *
   *  交出去的是**整块矩形**而不只是宽高：拖左边缘和上边缘时 `x`/`y` 要跟着走
   *  （左边界外移，不是整体平移），只回宽高的话调用方没法还原这一半。
   *  `handle` 一并给出，调用方要撑大到自己的下限时才知道该钉住哪条边。
   *
   *  `first` 只在这次缩放的第一帧为 true——调用方据此打一次撤销快照，
   *  每帧都打的话撤销栈会被一次拖动塞满几十格。 */
  onResize?: (id: string, rect: Rect, handle: ResizeHandle, first: boolean) => void
  /** 渲染哪几个方位的手柄。缺省只给右下角，与改造前一致。
   *  高度不落库的节点（图片按比例定型）只该给改宽度的那几个。 */
  resizeHandles?: readonly ResizeHandle[]
  /** 缩放下限。外壳按它夹住矩形——夹在调用方那边的话，
   *  宽度顶到下限后继续拖，`x` 还在跟着指针走，节点会一边保持宽度一边横移。 */
  minSize?: { w: number; h: number }
  /** 端口高亮：连线拖拽中，这个端口是合法落点 */
  portHint?: PortSide | null
  className?: string
}

export function NodeShell({
  id,
  x,
  y,
  width,
  height,
  selected,
  running,
  queued,
  title,
  badge,
  toolbar,
  children,
  viewport,
  onMove,
  onMoveLive,
  onSelect,
  onContextMenu,
  onDoubleClick,
  onPortDown,
  onPortEnter,
  onPortLeave,
  onResize,
  resizeHandles = DEFAULT_HANDLES,
  minSize = DEFAULT_MIN_SIZE,
  portHint,
  className = '',
}: NodeShellProps): JSX.Element {
  const elRef = useRef<HTMLDivElement | null>(null)
  /* 拖动/缩放中把工具条藏起来：跟着节点飞的工具条很干扰（蓝本同款行为） */
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{
    pointerId: number
    startClient: Point
    startXY: Point
    moved: boolean
    append: boolean
    /** 按下时压住了「⌘ 点已选中的节点」这一下，松手且没拖动过才真的减选 */
    deferredToggle: boolean
    alt: boolean
    altShift: boolean
  } | null>(null)
  const resizeRef = useRef<{
    pointerId: number
    handle: ResizeHandle
    startClient: Point
    startRect: Rect
    /** 这次缩放是否已经报过第一帧 */
    reported: boolean
  } | null>(null)

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      if (e.button !== 0) return
      const target = e.target as HTMLElement
      /* 节点里的输入控件、按钮、端口、缩放手柄都不该触发整块拖动。
         `.nodrag` 是给节点内容自己标的逃生口。 */
      if (target.closest('.nodrag, input, textarea, select, button, .cvc-port, .cvc-resize, [contenteditable="true"]')) {
        return
      }
      e.stopPropagation()
      const mode = selectModeOf(e)
      /* 拖动要拖的是**整个选区**，所以按在已选中的节点上时不改选择——
         ⌘ 点本该是减选，可这一下要是拖动的起手，减掉它整组就散了。
         真正的减选发生在松手且没拖动过的时候（见 finish）。 */
      const append = mode !== 'replace'
      // Alt 拖是「复制这一个」：不要顺手改选中集，否则松手会把整组都复制掉
      if (!e.altKey && !(mode === 'toggle' && selected === true)) onSelect?.(id, mode)
      const el = elRef.current
      if (el === null) return
      capturePointer(el, e.pointerId)
      dragRef.current = {
        pointerId: e.pointerId,
        startClient: { x: e.clientX, y: e.clientY },
        startXY: { x, y },
        moved: false,
        append,
        deferredToggle: mode === 'toggle' && selected === true && !e.altKey,
        /* Alt 在按下那一刻就记住：拖到一半松开 Alt 再松手，
           用户预期仍然是「复制」——他是带着复制的意图开始这次拖的 */
        alt: e.altKey,
        altShift: e.altKey && e.shiftKey,
      }
    },
    [id, x, y, selected, onSelect],
  )

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      const resize = resizeRef.current
      if (resize !== null && resize.pointerId === e.pointerId) {
        const scale = safeScale(viewport.scale)
        const next = resizeRectBy(
          resize.startRect,
          resize.handle,
          (e.clientX - resize.startClient.x) / scale,
          (e.clientY - resize.startClient.y) / scale,
          minSize,
        )
        const first = !resize.reported
        resize.reported = true
        if (first) setDragging(true)
        onResize?.(
          id,
          {
            x: Math.round(next.x),
            y: Math.round(next.y),
            width: Math.round(next.width),
            height: Math.round(next.height),
          },
          resize.handle,
          first,
        )
        return
      }
      const drag = dragRef.current
      if (drag === null || drag.pointerId !== e.pointerId) return
      const scale = safeScale(viewport.scale)
      const dx = (e.clientX - drag.startClient.x) / scale
      const dy = (e.clientY - drag.startClient.y) / scale
      if (!drag.moved && Math.hypot(dx * scale, dy * scale) > 3) {
        drag.moved = true
        setDragging(true)
      }
      if (!drag.moved) return
      onMoveLive?.(id, dx, dy)
    },
    [id, viewport.scale, onMoveLive, onResize, minSize],
  )

  const finish = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      const el = elRef.current
      if (el !== null) releasePointer(el, e.pointerId)
      const resize = resizeRef.current
      if (resize !== null && resize.pointerId === e.pointerId) {
        resizeRef.current = null
        setDragging(false)
        return
      }
      const drag = dragRef.current
      if (drag === null || drag.pointerId !== e.pointerId) return
      dragRef.current = null
      setDragging(false)
      if (!drag.moved) {
        // ⌘ 点已选中的节点、且这一下没拖动：现在才把它从选区里摘掉
        if (drag.deferredToggle) onSelect?.(id, 'toggle')
        return
      }
      const scale = safeScale(viewport.scale)
      onMove?.(
        id,
        Math.round(drag.startXY.x + (e.clientX - drag.startClient.x) / scale),
        Math.round(drag.startXY.y + (e.clientY - drag.startClient.y) / scale),
        { append: drag.append, alt: drag.alt, altShift: drag.altShift },
      )
    },
    [id, viewport.scale, onMove, onSelect],
  )

  const style: CSSProperties = { left: x, top: y }
  if (width !== undefined) style.width = width
  if (height !== undefined) style.height = height

  const cls = [
    'cvc-node',
    selected === true ? 'cvc-node-on' : '',
    dragging ? 'cvc-node-dragging' : '',
    running === true ? 'cvc-node-running' : '',
    queued === true ? 'cvc-node-queued' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      ref={elRef}
      className={cls}
      style={style}
      data-node-id={id}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onDoubleClick={(e) => {
        e.stopPropagation()
        onDoubleClick?.(id, e)
      }}
      onContextMenu={(e) => {
        if (onContextMenu === undefined) return
        e.preventDefault()
        e.stopPropagation()
        onContextMenu(id, { x: e.clientX, y: e.clientY })
      }}
    >
      {/* 工具条挂在节点上方而不是内部：节点缩得很小时也不会被内容挤掉 */}
      {toolbar !== undefined && <div className="cvc-node-tools nodrag">{toolbar}</div>}

      {(title !== undefined || badge !== undefined) && (
        <div className="cvc-node-head">
          <span className="cvc-node-title">{title}</span>
          {badge !== undefined && <span className="cvc-node-badge">{badge}</span>}
        </div>
      )}

      {children}

      <span
        className={portHint === 'in' ? 'cvc-port cvc-port-in cvc-port-hint' : 'cvc-port cvc-port-in'}
        data-port="in"
        onPointerDown={(e) => {
          e.stopPropagation()
          onPortDown?.(id, 'in', e)
        }}
        onPointerEnter={() => onPortEnter?.(id, 'in')}
        onPointerLeave={() => onPortLeave?.()}
      />
      <span
        className={portHint === 'out' ? 'cvc-port cvc-port-out cvc-port-hint' : 'cvc-port cvc-port-out'}
        data-port="out"
        onPointerDown={(e) => {
          e.stopPropagation()
          onPortDown?.(id, 'out', e)
        }}
        onPointerEnter={() => onPortEnter?.(id, 'out')}
        onPointerLeave={() => onPortLeave?.()}
      />

      {onResize !== undefined &&
        resizeHandles.map((handle) => (
          <span
            key={handle}
            className={`cvc-resize cvc-resize-${handle}`}
            data-handle={handle}
            /* 指针形状走 `resizeCursor` 这一张表，不在 CSS 里再抄一份 */
            style={{ cursor: resizeCursor(handle) }}
            onPointerDown={(e) => {
              e.stopPropagation()
              const el = elRef.current
              if (el === null) return
              capturePointer(el, e.pointerId)
              resizeRef.current = {
                pointerId: e.pointerId,
                handle,
                startClient: { x: e.clientX, y: e.clientY },
                /* 高度没落库的节点量 DOM：拖上边缘要靠它算下边缘钉在哪 */
                startRect: { x, y, width: width ?? el.offsetWidth, height: height ?? el.offsetHeight },
                reported: false,
              }
            }}
          />
        ))}
    </div>
  )
}

/** 节点悬浮工具条上的一个按钮：**图标 + 中文字**（蓝本同款）。
 *
 *  `text` 是按钮上显示的短词（「裁剪」），`label` 是悬停时的完整说明
 *  （「裁剪：拖选框留下想要的部分」）。两者分开是因为按钮只有 24px 高，
 *  塞完整说明会把工具条撑得比节点还宽；而只有图标又猜不出是什么。
 *  窄屏时文字自动收起（CSS media query），只剩图标 + title。 */
export function NodeToolButton({
  icon,
  text,
  label,
  onClick,
  active,
  disabled,
  disabledReason,
}: {
  icon: ReactNode
  text: string
  label: string
  onClick: () => void
  active?: boolean
  disabled?: boolean
  /** 禁用原因。灰一个按钮却不说为什么，用户只会以为坏了 */
  disabledReason?: string
}): JSX.Element {
  return (
    <button
      type="button"
      className={active === true ? 'cvc-tool cvc-tool-on' : 'cvc-tool'}
      title={disabled === true && disabledReason !== undefined ? disabledReason : label}
      aria-label={label}
      disabled={disabled}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      {icon}
      <span>{text}</span>
    </button>
  )
}
