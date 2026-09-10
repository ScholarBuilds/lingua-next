/* 看大图：完整显示、滚轮缩放、拖动查看、左右翻页。

   全仓此前有两处各写各的看图：ChatImagePage 的浮层（只有一张静图，不能缩放）
   与 CanvasEditor 的预览模式（能缩放但长在编辑器里，别处用不了）。
   资产库和素材库再各写一份就是第四份，所以收成这一个共用件。

   **默认 contain 不裁切**——这是它存在的首要理由。缩略图列表里为了排版整齐用
   `object-fit: cover`，一张 1536×1024 的横图被切掉三分之一；点开大图是用户
   唯一一次能看见整张图的机会，这里再裁就没地方看了。

   缩放/平移的判据在 `./image-viewer`，纯函数单独测——那几件事错了都不报错，
   只是手感不对（图被拖出视野找不回来、放大总是从中心跑偏）。 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { IconClose } from './icons'
import {
  clampPan,
  clampScale,
  fitSize,
  MIN_SCALE,
  oneToOneScale,
  stepIndex,
  WHEEL_STEP,
  zoomAt,
} from './image-viewer'
import type { Pan } from './image-viewer'
import { Overlay } from './Overlay'
import './image-viewer.css'

export interface ViewerImage {
  id: number | string
  /** 原图地址。看大图就该看原图，不是列表里那张 192px 缩略图 */
  url: string
  width?: number
  height?: number
  /** 标题栏左侧那行字 */
  caption?: string
}

export function ImageViewer({
  images,
  index,
  onIndex,
  onClose,
  actions,
  meta,
}: {
  images: ViewerImage[]
  index: number
  onIndex: (next: number) => void
  onClose: () => void
  /** 右下角的操作区（删除、下载…）。由调用方给，看图件不猜业务 */
  actions?: ReactNode
  /** 标题栏右侧的补充信息 */
  meta?: ReactNode
}) {
  const current = images[index]
  const [scale, setScale] = useState(MIN_SCALE)
  const [pan, setPan] = useState<Pan>({ x: 0, y: 0 })
  const [natural, setNatural] = useState({ w: 0, h: 0 })
  const [box, setBox] = useState({ w: 0, h: 0 })
  const stageRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ x: number; y: number; pan: Pan } | null>(null)

  // 换图就回到适应窗口：上一张放大到 4 倍的状态套到下一张身上没有任何道理
  useEffect(() => {
    setScale(MIN_SCALE)
    setPan({ x: 0, y: 0 })
    setNatural({ w: 0, h: 0 })
  }, [current?.id])

  useEffect(() => {
    const el = stageRef.current
    if (el === null) return
    const sync = () => setBox({ w: el.clientWidth, h: el.clientHeight })
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const go = useCallback(
    (delta: number) => {
      const next = stepIndex(index, images.length, delta)
      if (next !== null) onIndex(next)
    },
    [index, images.length, onIndex],
  )

  const applyScale = useCallback(
    (next: number, cursor?: { x: number; y: number }) => {
      const to = clampScale(next)
      setScale((from) => {
        if (to === from) return from
        const anchor = cursor ?? { x: box.w / 2, y: box.h / 2 }
        setPan((p) => clampPan(zoomAt(p, from, to, anchor, box), box, fitSize(natural, box), to))
        return to
      })
    },
    [box, natural],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); go(1) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1) }
      else if (e.key === '+' || e.key === '=') { e.preventDefault(); applyScale(scale * WHEEL_STEP) }
      else if (e.key === '-') { e.preventDefault(); applyScale(scale / WHEEL_STEP) }
      else if (e.key === '0') { e.preventDefault(); setScale(MIN_SCALE); setPan({ x: 0, y: 0 }) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go, applyScale, scale])

  /* 滚轮缩放要 passive:false 才拦得住页面滚动，而 React 的 onWheel 是被动监听——
     不自己绑的话，在大图上滚轮会把背后的列表滚走。 */
  useEffect(() => {
    const el = stageRef.current
    if (el === null) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      applyScale(
        scale * (e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP),
        { x: e.clientX - rect.left, y: e.clientY - rect.top },
      )
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [applyScale, scale])

  if (current === undefined) return null

  const fit = fitSize(natural, box)
  const zoomed = scale > MIN_SCALE
  const oneToOne = oneToOneScale(natural, box)

  const onPointerDown = (e: React.PointerEvent) => {
    if (!zoomed) return
    dragRef.current = { x: e.clientX, y: e.clientY, pan }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (d === null) return
    setPan(clampPan({ x: d.pan.x + (e.clientX - d.x), y: d.pan.y + (e.clientY - d.y) }, box, fit, scale))
  }
  const endDrag = () => { dragRef.current = null }

  return (
    <Overlay onClose={onClose} card="imgv" labelledBy="imgv-title">
      <div className="imgv-head">
        <span className="imgv-title" id="imgv-title">
          {current.caption ?? `#${current.id}`}
        </span>
        {natural.w > 0 && (
          <span className="imgv-dim">
            {natural.w} × {natural.h}
          </span>
        )}
        {meta}
        <span className="imgv-flex" />
        {images.length > 1 && (
          <span className="imgv-idx">
            {index + 1} / {images.length}
          </span>
        )}
        <button className="btn-ghost-sm" title="关闭（Esc）" onClick={onClose}>
          <IconClose />
        </button>
      </div>

      <div
        className={`imgv-stage${zoomed ? ' is-zoomed' : ''}`}
        ref={stageRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => (zoomed ? (setScale(MIN_SCALE), setPan({ x: 0, y: 0 })) : applyScale(oneToOne))}
      >
        <img
          key={current.id}
          src={current.url}
          alt={current.caption ?? ''}
          draggable={false}
          onLoad={(e) => {
            const el = e.currentTarget
            setNatural({ w: el.naturalWidth, h: el.naturalHeight })
          }}
          style={{
            width: fit.w > 0 ? `${fit.w}px` : undefined,
            height: fit.h > 0 ? `${fit.h}px` : undefined,
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
          }}
        />
        {images.length > 1 && (
          <>
            <button
              className="imgv-nav is-prev"
              disabled={index === 0}
              aria-label="上一张"
              onClick={(e) => { e.stopPropagation(); go(-1) }}
            >
              ‹
            </button>
            <button
              className="imgv-nav is-next"
              disabled={index === images.length - 1}
              aria-label="下一张"
              onClick={(e) => { e.stopPropagation(); go(1) }}
            >
              ›
            </button>
          </>
        )}
      </div>

      <div className="imgv-foot">
        <div className="imgv-zoom">
          <button onClick={() => applyScale(scale / WHEEL_STEP)} disabled={scale <= MIN_SCALE} title="缩小（-）">
            −
          </button>
          <button
            className="imgv-zoom-val"
            onClick={() => (zoomed ? (setScale(MIN_SCALE), setPan({ x: 0, y: 0 })) : applyScale(oneToOne))}
            title={zoomed ? '回到适应窗口（0）' : '按原始像素显示'}
          >
            {zoomed ? `${Math.round(scale * 100)}%` : '适应'}
          </button>
          <button onClick={() => applyScale(scale * WHEEL_STEP)} title="放大（+）">
            ＋
          </button>
          <span className="imgv-tip">滚轮缩放 · 双击切换 · ← → 翻页</span>
        </div>
        <span className="imgv-flex" />
        {actions}
      </div>
    </Overlay>
  )
}
