/* 画布内核 · 运行态登记处（模块 17 · CR-005 §3.1）
 *
   react-flow 时代靠 `useReactFlow()` 从任意子组件拿到两样东西：
   坐标换算（`screenToFlowPosition`）与节点实测尺寸（`getNode().measured`）。
   自研内核不带 Provider，这两样改由本模块登记。

   为什么不用 React Context：这两样东西**每帧都在变**（拖拽、缩放），
   放进 context 会让整棵子树跟着重渲染；而它们的消费者（对齐工具条、
   右键菜单落点）只在事件回调里读一次，根本不需要响应式。

   模块级单例的边界：同一时刻只有一个画布打开，切画布时 `reset()` 清空。
   真要同屏两个画布时，这里要改成按画布 id 分槽——先记在这。 */

import type { Point, Viewport } from './geometry'

/** 视图控制。快捷键与工具栏按钮都要用，但视口 state 住在 CanvasBoard 内部 */
export interface ViewControls {
  /** 把所有节点装进视口 */
  fit: () => void
  /** 把**选中的**节点铺满视口。返回 false 表示没得铺（没选中，或画布还没量到尺寸）——
   *  调用方据此提示，而不是按下去毫无反应 */
  fitSelection: () => boolean
  /** 以视口中心按倍数缩放 */
  zoom: (factor: number) => void
  /** 缩放归一到 100% */
  reset: () => void
  /** 缩略概览：第一次缩到看得见全部，再按回到原来的位置 */
  toggleOverview: () => void
}

/** 视口变化的订阅者。生成条要跟着选中节点走，就得知道视口什么时候动了 */
const viewWatchers = new Set<() => void>()

interface Registry {
  /** 当前视口。**不进 React context**：它每帧都在变，进 context 会让整棵子树重渲染 */
  viewport: Viewport
  /** 屏幕坐标 → 世界坐标。画布挂载时由 CanvasBoard 填 */
  toWorld: ((clientX: number, clientY: number) => Point) | null
  /** 节点实测尺寸。视口裁剪之后，没进过 DOM 的节点这里查不到，调用方要有兜底 */
  boxes: Map<string, { w: number; h: number }>
  /** 画布容器尺寸 */
  size: { width: number; height: number }
  view: ViewControls | null
}

const registry: Registry = {
  toWorld: null,
  boxes: new Map(),
  size: { width: 0, height: 0 },
  view: null,
  viewport: { x: 0, y: 0, scale: 1 },
}

export function registerCanvas(next: Partial<Registry>): void {
  if (next.toWorld !== undefined) registry.toWorld = next.toWorld
  if (next.boxes !== undefined) registry.boxes = next.boxes
  if (next.size !== undefined) registry.size = next.size
  if (next.view !== undefined) registry.view = next.view
  if (next.viewport !== undefined) {
    const before = registry.viewport
    registry.viewport = next.viewport
    if (
      before.x !== next.viewport.x ||
      before.y !== next.viewport.y ||
      before.scale !== next.viewport.scale
    ) {
      for (const fn of viewWatchers) fn()
    }
  }
}

/** 订阅视口变化。返回退订函数。
 *
 *  给「浮在选中节点下方」这类跟随定位用：平移或缩放之后位置就该重算。
 *  只有真的需要跟随的那一两个组件订阅，不会波及整棵树。 */
export function watchViewport(fn: () => void): () => void {
  viewWatchers.add(fn)
  return () => viewWatchers.delete(fn)
}

/** 世界坐标 → 屏幕坐标（相对画布容器左上角）。`screenToCanvas` 的反向 */
export function canvasToScreen(point: Point): Point {
  const v = registry.viewport
  return { x: point.x * v.scale + v.x, y: point.y * v.scale + v.y }
}

/** 当前缩放。跟随定位要用它换算节点的显示尺寸 */
export function canvasScale(): number {
  return registry.viewport.scale
}

export function resetCanvasRegistry(): void {
  registry.toWorld = null
  registry.boxes = new Map()
  registry.size = { width: 0, height: 0 }
  registry.view = null
  registry.viewport = { x: 0, y: 0, scale: 1 }
}

/** 视图控制。画布没挂载时返回 null——调用方据此决定要不要给快捷键接处理器，
 *  这直接决定帮助面板显不显示这几行（面板只列真的接了的） */
export function canvasView(): ViewControls | null {
  return registry.view
}

/** 屏幕坐标转世界坐标。画布还没挂载时回落原样返回——
 *  返回 null 会让每个调用点都要判空，而这个场景下「按屏幕坐标当世界坐标」
 *  的退化行为不会造成错误落点（那时画布上还没有节点）。 */
export function screenToCanvas(clientX: number, clientY: number): Point {
  return registry.toWorld?.(clientX, clientY) ?? { x: clientX, y: clientY }
}

/** 节点实测尺寸。查不到返回 null，调用方用自己的兜底算式 */
export function measuredBox(id: string): { w: number; h: number } | null {
  return registry.boxes.get(id) ?? null
}

export function canvasSize(): { width: number; height: number } {
  return registry.size
}
