/* 画布内核 · 缩略导航（模块 17 · CR-005 §3.1）
 *
   移植自 Infinite-Canvas `static/js/smart-canvas.js` `renderMinimap`（约 2121 行）。

   蓝本的做法：把所有节点矩形加上「当前视口窗」一起求包围盒，按包围盒等比缩放
   画进小图里。**视口窗要参与求包围盒**，否则把画面平移到空白区域时，
   小图里的视口框会跑到框外看不见，用户就不知道自己在哪了。 */

import { memo, useCallback, useRef } from 'react'

import type { Rect, Viewport } from './geometry'
import { capturePointer, releasePointer, safeScale } from './geometry'

import './canvas-core.css'

export interface MinimapProps {
  rects: Rect[]
  viewport: Viewport
  /** 画布容器尺寸，用来算视口窗在世界坐标里的位置 */
  size: { width: number; height: number }
  /** 点击/拖动缩略图：把视口中心移到这个世界坐标 */
  onJump: (world: { x: number; y: number }) => void
  width?: number
  height?: number
  /** 高亮这些节点（选中态） */
  activeIds?: Set<string>
  ids?: string[]
}

function MinimapInner({ rects, viewport, size, onJump, width = 176, height = 112, activeIds, ids }: MinimapProps): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const dragging = useRef(false)

  const scale = safeScale(viewport.scale)
  const view: Rect = {
    x: -viewport.x / scale,
    y: -viewport.y / scale,
    width: size.width / scale,
    height: size.height / scale,
  }

  /* 视口窗一起参与求包围盒：不算进来的话，平移到空白区域时
     视口框会落在小图之外，用户失去「我在哪」的参照 */
  const all = [...rects, view]
  const minX = Math.min(...all.map((r) => r.x))
  const minY = Math.min(...all.map((r) => r.y))
  const maxX = Math.max(...all.map((r) => r.x + r.width))
  const maxY = Math.max(...all.map((r) => r.y + r.height))
  const spanX = Math.max(1, maxX - minX)
  const spanY = Math.max(1, maxY - minY)
  const k = Math.min(width / spanX, height / spanY)
  const offX = (width - spanX * k) / 2
  const offY = (height - spanY * k) / 2

  const toWorld = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } => {
      const el = ref.current
      if (el === null) return { x: 0, y: 0 }
      const r = el.getBoundingClientRect()
      return {
        x: (clientX - r.left - offX) / k + minX,
        y: (clientY - r.top - offY) / k + minY,
      }
    },
    [k, minX, minY, offX, offY],
  )

  const box = (r: Rect): { left: number; top: number; width: number; height: number } => ({
    left: offX + (r.x - minX) * k,
    top: offY + (r.y - minY) * k,
    width: Math.max(2, r.width * k),
    height: Math.max(2, r.height * k),
  })

  return (
    <div
      ref={ref}
      className="cvc-minimap"
      style={{ width, height }}
      title="点或拖动可以跳到那个位置"
      onPointerDown={(e) => {
        e.stopPropagation()
        capturePointer(e.currentTarget, e.pointerId)
        dragging.current = true
        onJump(toWorld(e.clientX, e.clientY))
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return
        onJump(toWorld(e.clientX, e.clientY))
      }}
      onPointerUp={(e) => {
        dragging.current = false
        releasePointer(e.currentTarget, e.pointerId)
      }}
    >
      {rects.map((r, i) => {
        const id = ids?.[i]
        const on = id !== undefined && activeIds?.has(id) === true
        return <span key={id ?? i} className={on ? 'cvc-mini-node cvc-mini-on' : 'cvc-mini-node'} style={box(r)} />
      })}
      <span className="cvc-mini-view" style={box(view)} />
    </div>
  )
}

export const Minimap = memo(MinimapInner)
