/* 画布内核 · 指针交互（模块 17 · CR-005 §3.1）
 *
   移植自 Infinite-Canvas `static/js/smart-canvas.js` 的
   `shell.onmousedown` / `shell.oncontextmenu` / `shell.ondblclick` / `shell.addEventListener('wheel')`
   （约 17470~17560、18011 行）。

   与蓝本的两处**有意不同**：

   1. 用 Pointer Events + `setPointerCapture` 代替 `window.onmousemove`。
      蓝本靠往 window 上挂全局 handler 追踪拖拽，鼠标拖出窗口再松开就丢 mouseup，
      状态卡死在「还在拖」。指针捕获从根上没有这个问题。
   2. 修饰键组合做成 `KeyMap` 传进来。蓝本两套画布的键位本来就不一样
      （普通画布 Shift 框选，智能画布 Shift 切线、Ctrl 框选），
      硬编码就得把这个 hook 抄两份。 */

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  capturePointer,
  rectFromPoints,
  releasePointer,
  safeScale,
  samplePointerPath,
  screenToWorld,
  wheelZoomFactor,
  zoomAtPoint,
} from './geometry'
import type { Point, Rect, Viewport } from './geometry'
import { isEditable } from './shortcuts'

/** 一次拖拽正在做什么 */
export type DragMode = 'none' | 'pan' | 'marquee' | 'erase'

/** 修饰键判定。两种画布形态各传一份 */
export interface KeyMap {
  /** 左键按下时判定为框选 */
  isMarquee: (e: PointerEvent) => boolean
  /** 左键按下时判定为切线擦除 */
  isErase: (e: PointerEvent) => boolean
  /** 追加选择（不清空已选） */
  isAppend: (e: PointerEvent | MouseEvent) => boolean
}

/** 智能画布：Ctrl/⌘ 或按住 R 框选，Shift 切线。与蓝本 smart-canvas.js 一致 */
export const SMART_KEYMAP = (isRDown: () => boolean): KeyMap => ({
  isMarquee: (e) => e.ctrlKey || e.metaKey || isRDown(),
  isErase: (e) => e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey,
  isAppend: (e) => e.ctrlKey || e.metaKey || e.shiftKey,
})

/** 普通画布：Shift 框选（与蓝本 canvas.js 一致），切线走 Alt+Shift 让位 */
export const NORMAL_KEYMAP = (): KeyMap => ({
  isMarquee: (e) => e.shiftKey && !e.altKey,
  isErase: (e) => e.shiftKey && e.altKey,
  isAppend: (e) => e.ctrlKey || e.metaKey,
})

/** 一次框选的判定口径 */
export interface MarqueeOptions {
  /** 追加到已有选区，不清空 */
  append: boolean
  /** 只选**完全框住**的节点。默认是「碰到就选」（与 Figma / Illustrator 默认一致），
   *  按住 Alt 切到这一档：一堆节点叠着时，碰到就选会连边上蹭到的一起拽进来 */
  contain: boolean
}

export interface CanvasInputOptions {
  viewport: Viewport
  setViewport: (next: Viewport) => void
  keymap: KeyMap
  /** 缩放上下限。数学层不设限，交互层必须给一个，否则一路滚下去会变成 1e-8 */
  scaleBounds?: { min: number; max: number }
  /** 返回 true 时，左键按下一律当平移处理——**连节点上也算**。
   *  空格拖拽平移走的就是它：画布铺满节点时，没有这条路就找不到能按下去平移的空白。 */
  panOverride?: () => boolean
  /** 框选结束：世界坐标矩形 + 判定口径 */
  onMarquee?: (rect: Rect, options: MarqueeOptions) => void
  /** 切线结束：划中的连线下标 */
  onErase?: (indices: number[]) => void
  /** 空白处单击（没有发生拖动才触发） */
  onBlankClick?: () => void
  /** 空白处右键 / 双击：世界坐标 + **client 坐标**（菜单浮层按 client 定位，
   *  给相对容器的坐标会让菜单在有侧栏时整体偏移一个侧栏宽度） */
  onBlankMenu?: (world: Point, client: Point) => void
  /** 命中 `.cvc-hit` 的连线时不该被当成空白。默认按 DOM 找 data-conn-index */
  hitTestConnection?: (clientX: number, clientY: number) => number[]
  /** 这些选择器命中时整个交互层让路（浮层、面板、节点自己的控件） */
  passThroughSelector?: string
  /** 视口变了要保存 */
  onViewportCommit?: () => void
}

/** 默认的连线命中：靠 elementsFromPoint 找 stroke 宽 14 的 `.cvc-hit`。
 *
 *  用浏览器自己的命中测试而不是自己算点到贝塞尔的距离——三次贝塞尔求最近点
 *  没有闭式解，数值解又慢又要调容差，而 `pointer-events: stroke` 本来就精确。
 *
 *  `data-conn-index` 上挂的是**逗号分隔的一串下标**：同一来源连到同一分组各成员的边
 *  合并成一条线渲染（`layout.bucketConnections`），点中这条线等于点中它背后所有边。
 *  一次返回整串，切线和断开才会把这一桶一起处理——只断其中一条，
 *  线还画在那儿，用户会以为没删掉。 */
function defaultHitTestConnection(clientX: number, clientY: number): number[] {
  const out: number[] = []
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    const raw = (el as HTMLElement).dataset?.connIndex
    if (raw === undefined || raw === '') continue
    for (const part of raw.split(',')) {
      const n = Number(part)
      if (part !== '' && Number.isInteger(n) && n >= 0 && !out.includes(n)) out.push(n)
    }
  }
  return out
}

const DEFAULT_PASS_THROUGH =
  '.cvc-node, .overlay, .overlay-card, .cvc-menu, .cvc-minimap, .cvc-panel, input, textarea, select, button, [contenteditable="true"]'

/** 空格平移时**只有浮层**还挡路。节点被有意剔出去了——按住空格就是要从节点上面
 *  也能拖动画布；而浮层、小地图、输入框上按下去仍然归它们自己管。 */
const OVERLAY_ONLY =
  '.overlay, .overlay-card, .cvc-menu, .cvc-minimap, .cvc-panel, input, textarea, select, [contenteditable="true"]'

export interface CanvasInputState {
  /** 绑到画布容器上 */
  boardRef: (el: HTMLDivElement | null) => void
  /** 当前拖拽模式，用来给容器加 cursor 类 */
  dragMode: DragMode
  /** 框选框（屏幕坐标，相对容器）。没有在框选时为 null */
  marquee: Rect | null
  /** 切线轨迹（屏幕坐标，相对容器） */
  eraseTrail: Point[]
  /** 这一轮切线已划中的连线下标，用于给它们上预览态 */
  erasingIndices: number[]
  /** 把 clientX/clientY 换成世界坐标。节点拖拽、菜单落点都要用 */
  toWorld: (clientX: number, clientY: number) => Point
  /** 容器的当前尺寸，fitRects 之类要用 */
  size: { width: number; height: number }
}

export function useCanvasInput(options: CanvasInputOptions): CanvasInputState {
  const {
    viewport,
    setViewport,
    keymap,
    scaleBounds = { min: 0.08, max: 4 },
    panOverride,
    onMarquee,
    onErase,
    onBlankClick,
    onBlankMenu,
    hitTestConnection = defaultHitTestConnection,
    passThroughSelector = DEFAULT_PASS_THROUGH,
    onViewportCommit,
  } = options

  const [board, setBoard] = useState<HTMLDivElement | null>(null)
  const [dragMode, setDragMode] = useState<DragMode>('none')
  const [marquee, setMarquee] = useState<Rect | null>(null)
  const [eraseTrail, setEraseTrail] = useState<Point[]>([])
  const [erasingIndices, setErasingIndices] = useState<number[]>([])
  const [size, setSize] = useState({ width: 0, height: 0 })

  /* viewport 走 ref：wheel 是 passive:false 的原生监听，闭包里读 state 会读到旧值，
     而每次 viewport 变就重绑监听又会在连续滚动时丢帧。 */
  const vpRef = useRef(viewport)
  vpRef.current = viewport

  const dragRef = useRef<{
    mode: DragMode
    pointerId: number
    startClient: Point
    startWorld: Point
    startViewport: Viewport
    append: boolean
    contain: boolean
    moved: boolean
    erased: Set<number>
    lastClient: Point
  } | null>(null)

  /* 拖动过就不再算「单击空白」。没有这个标记，平移一下松手会把选择清掉 */
  const movedRef = useRef(false)

  const originOf = useCallback((): Point => {
    if (!board) return { x: 0, y: 0 }
    const r = board.getBoundingClientRect()
    return { x: r.left, y: r.top }
  }, [board])

  const toWorld = useCallback(
    (clientX: number, clientY: number): Point => screenToWorld(clientX, clientY, originOf(), vpRef.current),
    [originOf],
  )

  /* ---------- 容器尺寸 ---------- */
  useEffect(() => {
    if (!board) return
    const read = (): void => setSize({ width: board.clientWidth, height: board.clientHeight })
    read()
    /* ResizeObserver 在内嵌浏览器面板里一次都不回调（仓库既有坑），
       所以除了 RO 也挂 window resize，两条路哪条通都行。 */
    const ro = new ResizeObserver(read)
    ro.observe(board)
    window.addEventListener('resize', read)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', read)
    }
  }, [board])

  /* ---------- 滚轮缩放 ---------- */
  useEffect(() => {
    if (!board) return
    const onWheel = (e: WheelEvent): void => {
      const target = e.target as HTMLElement | null
      if (target?.closest('[data-cvc-scroll]')) return
      e.preventDefault()
      const rect = board.getBoundingClientRect()
      const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top }
      const next = zoomAtPoint(vpRef.current, anchor, wheelZoomFactor(e.deltaY), scaleBounds)
      vpRef.current = next
      setViewport(next)
    }
    board.addEventListener('wheel', onWheel, { passive: false })
    return () => board.removeEventListener('wheel', onWheel)
  }, [board, scaleBounds, setViewport])

  /* ---------- 指针拖拽 ---------- */
  useEffect(() => {
    if (!board) return

    const isPassThrough = (e: PointerEvent | MouseEvent): boolean => {
      const target = e.target as HTMLElement | null
      return Boolean(target?.closest(passThroughSelector))
    }

    const relative = (clientX: number, clientY: number): Point => {
      const r = board.getBoundingClientRect()
      return { x: clientX - r.left, y: clientY - r.top }
    }

    const onPointerDown = (e: PointerEvent): void => {
      if (dragRef.current) return
      /* 空格按住时左键一律平移，节点也不例外 */
      const override = e.button === 0 && panOverride?.() === true
      const target = e.target as HTMLElement | null
      if (override ? Boolean(target?.closest(OVERLAY_ONLY)) : isPassThrough(e)) return
      /* 每次按下都先复位「拖过没有」。右键的 button=2 会在下面 mode==='none' 时提前
         return，走不到后面的复位点——上一次拖拽留下的 true 会把紧接着的右键菜单吞掉，
         表现为「拖完画布之后第一次右键没反应，再点一次才出来」。 */
      movedRef.current = false
      /* 连线上的点击交给连线自己的 handler，不要开始平移 */
      if (!override && e.button === 0 && hitTestConnection(e.clientX, e.clientY).length > 0 && !keymap.isErase(e)) return

      let mode: DragMode = 'none'
      if (override) mode = 'pan'
      else if (e.button === 0 && keymap.isErase(e)) mode = 'erase'
      else if (e.button === 0 && keymap.isMarquee(e)) mode = 'marquee'
      else if (e.button === 0 || e.button === 1) mode = 'pan'
      if (mode === 'none') return

      e.preventDefault()
      /* 空格平移必须**掐断冒泡**：这个原生监听挂在 .cvc-board 上，事件从节点冒上来时
         先经过这里，再往上走到 React 的根容器才轮到 NodeShell 的 onPointerDown。
         不掐断的话画布在平移、节点同时也被拖着走，两个位移叠在一起。 */
      if (override) e.stopPropagation()
      capturePointer(board, e.pointerId)
      movedRef.current = false
      dragRef.current = {
        mode,
        pointerId: e.pointerId,
        startClient: { x: e.clientX, y: e.clientY },
        startWorld: toWorld(e.clientX, e.clientY),
        startViewport: { ...vpRef.current },
        append: keymap.isAppend(e),
        /* Alt 在按下那一刻就记住：拖到一半松开 Alt 再松手，
           用户预期仍然是他起手时选的那一档 */
        contain: e.altKey,
        moved: false,
        erased: new Set<number>(),
        lastClient: { x: e.clientX, y: e.clientY },
      }
      setDragMode(mode)
      if (mode === 'erase') {
        const p = relative(e.clientX, e.clientY)
        setEraseTrail([p])
        const hits = hitTestConnection(e.clientX, e.clientY)
        if (hits.length > 0) {
          hits.forEach((i) => dragRef.current?.erased.add(i))
          setErasingIndices([...dragRef.current.erased])
        }
      }
    }

    const onPointerMove = (e: PointerEvent): void => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== e.pointerId) return
      const dx = e.clientX - drag.startClient.x
      const dy = e.clientY - drag.startClient.y
      if (!drag.moved && Math.hypot(dx, dy) > 3) {
        drag.moved = true
        movedRef.current = true
      }

      if (drag.mode === 'pan') {
        const next = { ...vpRef.current, x: drag.startViewport.x + dx, y: drag.startViewport.y + dy }
        vpRef.current = next
        setViewport(next)
        return
      }

      if (drag.mode === 'marquee') {
        const a = relative(drag.startClient.x, drag.startClient.y)
        const b = relative(e.clientX, e.clientY)
        setMarquee(rectFromPoints(a, b))
        return
      }

      /* 切线：沿指针路径采样，快速划过也不会从线上跳过去 */
      const samples = samplePointerPath(drag.lastClient, { x: e.clientX, y: e.clientY })
      let changed = false
      for (const s of samples) {
        for (const idx of hitTestConnection(s.x, s.y)) {
          if (!drag.erased.has(idx)) {
            drag.erased.add(idx)
            changed = true
          }
        }
      }
      drag.lastClient = { x: e.clientX, y: e.clientY }
      setEraseTrail((prev) => [...prev.slice(-140), relative(e.clientX, e.clientY)])
      if (changed) setErasingIndices([...drag.erased])
    }

    const finishDrag = (e: PointerEvent): void => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== e.pointerId) return
      dragRef.current = null
      releasePointer(board, e.pointerId)

      if (drag.mode === 'pan' && drag.moved) onViewportCommit?.()
      if (drag.mode === 'marquee') {
        const world = rectFromPoints(drag.startWorld, toWorld(e.clientX, e.clientY))
        setMarquee(null)
        if (world.width > 4 || world.height > 4) onMarquee?.(world, { append: drag.append, contain: drag.contain })
      }
      if (drag.mode === 'erase') {
        const indices = [...drag.erased]
        setEraseTrail([])
        setErasingIndices([])
        if (indices.length > 0) onErase?.(indices)
      }
      setDragMode('none')
    }

    const onContextMenu = (e: MouseEvent): void => {
      if (isPassThrough(e)) return
      /* 这里**不**看「刚才拖过没有」。右键不参与平移（平移只认左键与中键），
         所以不存在「右键拖完松手误弹菜单」这回事；而拿上一次左键拖拽留下的标记
         去拦右键，结果是「拖完画布之后第一次右键没反应」。 */
      e.preventDefault()
      onBlankMenu?.(toWorld(e.clientX, e.clientY), { x: e.clientX, y: e.clientY })
    }

    const onDoubleClick = (e: MouseEvent): void => {
      if (isPassThrough(e)) return
      e.preventDefault()
      onBlankMenu?.(toWorld(e.clientX, e.clientY), { x: e.clientX, y: e.clientY })
    }

    const onClick = (e: MouseEvent): void => {
      if (isPassThrough(e)) return
      if (movedRef.current) {
        movedRef.current = false
        return
      }
      if (hitTestConnection(e.clientX, e.clientY).length > 0) return
      onBlankClick?.()
    }

    board.addEventListener('pointerdown', onPointerDown)
    board.addEventListener('pointermove', onPointerMove)
    board.addEventListener('pointerup', finishDrag)
    board.addEventListener('pointercancel', finishDrag)
    board.addEventListener('contextmenu', onContextMenu)
    board.addEventListener('dblclick', onDoubleClick)
    board.addEventListener('click', onClick)
    return () => {
      board.removeEventListener('pointerdown', onPointerDown)
      board.removeEventListener('pointermove', onPointerMove)
      board.removeEventListener('pointerup', finishDrag)
      board.removeEventListener('pointercancel', finishDrag)
      board.removeEventListener('contextmenu', onContextMenu)
      board.removeEventListener('dblclick', onDoubleClick)
      board.removeEventListener('click', onClick)
    }
  }, [
    board,
    keymap,
    panOverride,
    hitTestConnection,
    passThroughSelector,
    toWorld,
    setViewport,
    onMarquee,
    onErase,
    onBlankClick,
    onBlankMenu,
    onViewportCommit,
  ])

  return { boardRef: setBoard, dragMode, marquee, eraseTrail, erasingIndices, toWorld, size }
}

/** 按住 R 的追踪。蓝本用它配合左键做框选（不占 Ctrl，方便左手操作）。
 *
 *  单独一个 hook 是因为 `blur` 时必须清掉——切到别的窗口再回来，
 *  keyup 收不到，R 会一直被认为按着。 */
export function useKeyHeld(key: string): () => boolean {
  const held = useRef(false)
  useEffect(() => {
    const target = key.toLowerCase()
    const editable = (el: EventTarget | null): boolean => {
      const node = el as HTMLElement | null
      if (!node) return false
      const tag = node.tagName
      return tag === 'INPUT' || tag === 'TEXTAREA' || node.isContentEditable
    }
    const down = (e: KeyboardEvent): void => {
      if (e.key.toLowerCase() === target && !editable(e.target)) held.current = true
    }
    const up = (e: KeyboardEvent): void => {
      if (e.key.toLowerCase() === target) held.current = false
    }
    const clear = (): void => {
      held.current = false
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', clear)
    }
  }, [key])
  return useCallback(() => held.current, [])
}

/** 按住空格 = 临时平移工具（Figma / Photoshop / Miro 一律是这个键）。
 *
 *  和 `useKeyHeld` 分开写，是因为空格有两件它独有的事要处理：
 *
 *  - **按钮上的空格是「点它」**：焦点落在按钮上时不能抢，否则用户按空格想平移，
 *    结果把上一次点过的那个按钮又触发了一遍；
 *  - **要 preventDefault**：页面级的空格会滚动，滚动一次视口就跳走了。
 *
 *  返回 React state 而不是 ref 读取函数：画布要靠它切光标（`.cvc-space`），
 *  一次按下重渲一帧的代价可以接受，而光标不变的话用户不知道现在按住了什么。 */
export function useSpaceHeld(): boolean {
  const [held, setHeld] = useState(false)
  useEffect(() => {
    const skip = (el: EventTarget | null): boolean => {
      /* 让路口径与键位表**同一个判据**（`isEditable`）。这里原来自己写了一串选择器，
         漏了 `[role="option"]` / `[role="listbox"]` 这些 Radix 下拉的角色：
         尺寸/质量下拉开着按空格，选项没被选中，画布反而进了平移待命态。 */
      if (isEditable(el)) return true
      const node = el as HTMLElement | null
      if (node === null || typeof node.closest !== 'function') return false
      // 空格落在按钮/链接上是「按它」，那一份不归键位表管，得单独让
      return node.closest('button, [role="button"], a[href], summary') !== null
    }
    const down = (e: KeyboardEvent): void => {
      if (e.key !== ' ' && e.code !== 'Space') return
      if (e.repeat || skip(e.target)) return
      /* 有浮层开着时整个让路。画布的其它快捷键靠 `useCanvasShortcuts(handlers, !overlayOpen)`
         统一关掉，而这个 hook 是自己挂 window 的，得自己判——不判的话在图片编辑器里
         按空格会被这里 preventDefault 掉，而背后那块看不见的画布进了平移待命态。 */
      if (document.querySelector('.overlay') !== null) return
      e.preventDefault()
      setHeld(true)
    }
    const up = (e: KeyboardEvent): void => {
      if (e.key !== ' ' && e.code !== 'Space') return
      setHeld(false)
    }
    /* 切窗口时 keyup 收不到，回来空格会一直被认为按着——画布从此点不动节点 */
    const clear = (): void => setHeld(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', clear)
    }
  }, [])
  return held
}

/** 缩放辅助：给按钮用的定量缩放，锚点固定在视口中心 */
export function zoomByStep(viewport: Viewport, size: { width: number; height: number }, step: number, bounds: { min: number; max: number }): Viewport {
  const anchor = { x: size.width / 2, y: size.height / 2 }
  return zoomAtPoint(viewport, anchor, step, bounds)
}

/** 把 scale 归一到 1（保持视口中心不动） */
export function resetZoom(viewport: Viewport, size: { width: number; height: number }): Viewport {
  const anchor = { x: size.width / 2, y: size.height / 2 }
  return zoomAtPoint(viewport, anchor, 1 / safeScale(viewport.scale), { min: 1, max: 1 })
}
