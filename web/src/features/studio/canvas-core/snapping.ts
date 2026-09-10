/* 画布内核 · 对齐吸附与参考线（模块 17 · CR-005 §3.1）
 *
   蓝本 `static/js/smart-canvas.js` 没有这一层：它的节点拖到哪就是哪，
   排版全靠手感，两个节点差 3px 谁也看不出来，导出/截图时才发现整排是歪的。
   Figma、Miro、tldraw 这一类画布都把「拖动时与邻居对齐」当基本功能，
   这里补上，算法是通用的三线对齐（左/中/右、上/中/下）。

   这一层**只算数**：进来是矩形，出去是位移和几条线段。
   不碰 DOM、不碰 React——手势层拿位移去改坐标，渲染层拿线段去画，
   测试拿同一份结论当断言。

   两个判断值得写下来：

   1. **容差按屏幕像素给，除以缩放换成世界坐标**。写死世界坐标的话，
      缩到 0.2 时 6 世界像素在屏幕上只有 1.2px，人眼根本对不准就吸不上；
      放到 3 倍时又变成 18px，明明离得挺远却被硬拽过去。
   2. **吸附与参考线是两件事**。位移只取最近的那一条候选，
      参考线则把「吸附之后真的对齐上了」的**每一条**都画出来——
      一次拖动同时对上三个邻居的左边，用户要看到三条线都亮，
      才知道这一下对齐的是谁。 */

import type { Rect } from './geometry'

/** 多近算「够得着」。单位是**屏幕像素**，与缩放无关。
 *
 *  6px 是试出来的下限：再小（4px）在 trackpad 上几乎吸不上，
 *  再大（10px）会在不想对齐的时候把节点拽走，手感变黏。 */
export const SNAP_TOLERANCE_PX = 6

/** 判「吸附之后到底对齐上了没有」的容差。世界坐标，纯粹为了躲浮点误差 */
export const GUIDE_EPSILON = 0.5

export type SnapAxis = 'x' | 'y'

/** 一条参考线。`axis='x'` 是竖线（画在 x=at 上，沿 y 从 start 铺到 end） */
export interface SnapGuide {
  axis: SnapAxis
  at: number
  start: number
  end: number
}

export interface SnapResult {
  /** 要把被拖的东西再挪多少才对齐。没吸上就是 0 */
  dx: number
  dy: number
  guides: SnapGuide[]
}

export interface SnapOptions {
  /** 当前缩放。容差要按它换算，缺省按 1 */
  scale?: number
  tolerancePx?: number
}

/** 一组矩形的外包围盒。多选拖动时按整体框去对齐，而不是逐个节点各吸各的
 *  ——后者会把原本排好的相对位置吸散架。 */
export function unionRect(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const r of rects) {
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.width)
    maxY = Math.max(maxY, r.y + r.height)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/** 一根轴上的三条判定线：起边、中线、止边 */
function edgesAlong(rect: Rect, axis: SnapAxis): [number, number, number] {
  return axis === 'x'
    ? [rect.x, rect.x + rect.width / 2, rect.x + rect.width]
    : [rect.y, rect.y + rect.height / 2, rect.y + rect.height]
}

/** 参考线画在 axis 上，线段本身沿**另一根轴**铺开，这里给它的起止 */
function spanAlong(rect: Rect, axis: SnapAxis): [number, number] {
  return axis === 'x' ? [rect.y, rect.y + rect.height] : [rect.x, rect.x + rect.width]
}

/** 这根轴上该挪多少。取容差内**最近**的一条候选，够不着就是 0。
 *
 *  同样近时取更小（更靠负方向）的那个位移：吸附结果必须是确定的，
 *  同一帧算两次不能给出两个答案，否则节点会在两条候选线之间抖。 */
function bestDelta(moving: Rect, others: readonly Rect[], axis: SnapAxis, tol: number): number {
  const mine = edgesAlong(moving, axis)
  let best = 0
  let bestAbs = Number.POSITIVE_INFINITY
  for (const other of others) {
    for (const theirs of edgesAlong(other, axis)) {
      for (const m of mine) {
        const delta = theirs - m
        const abs = Math.abs(delta)
        if (abs > tol || abs > bestAbs) continue
        if (abs === bestAbs && delta >= best) continue
        best = delta
        bestAbs = abs
      }
    }
  }
  return bestAbs === Number.POSITIVE_INFINITY ? 0 : best
}

/** 吸附之后真的对齐上的那几条线。同一个位置上有多个邻居时线段合并成一条长的
 *  ——三个节点左边对齐画三条重叠的短线，看起来只是一条不明所以的粗线。 */
function guidesAlong(moved: Rect, others: readonly Rect[], axis: SnapAxis): SnapGuide[] {
  const mine = edgesAlong(moved, axis)
  const [mineStart, mineEnd] = spanAlong(moved, axis)
  const byAt = new Map<number, SnapGuide>()
  for (const other of others) {
    const [theirStart, theirEnd] = spanAlong(other, axis)
    for (const theirs of edgesAlong(other, axis)) {
      if (!mine.some((m) => Math.abs(m - theirs) <= GUIDE_EPSILON)) continue
      const exist = byAt.get(theirs)
      if (exist === undefined) {
        byAt.set(theirs, {
          axis,
          at: theirs,
          start: Math.min(mineStart, theirStart),
          end: Math.max(mineEnd, theirEnd),
        })
        continue
      }
      exist.start = Math.min(exist.start, theirStart)
      exist.end = Math.max(exist.end, theirEnd)
    }
  }
  return [...byAt.values()].sort((a, b) => a.at - b.at)
}

/**
 * 拖动中的对齐吸附：给出该补多少位移，以及补完之后要画哪几条参考线。
 *
 * `moving` 传的是**已经跟着指针走到当前位置**的矩形（多选就传整体包围盒），
 * `others` 传参与对齐的邻居——调用方只该传视口内的那些，
 * 吸到屏幕外看不见的节点上，用户只会觉得节点自己跳了一下。
 */
export function alignmentSnap(moving: Rect, others: readonly Rect[], options: SnapOptions = {}): SnapResult {
  const raw = options.scale
  const scale = raw === undefined || !Number.isFinite(raw) || raw <= 0 ? 1 : raw
  const tol = (options.tolerancePx ?? SNAP_TOLERANCE_PX) / scale
  if (others.length === 0 || tol <= 0) return { dx: 0, dy: 0, guides: [] }
  const dx = bestDelta(moving, others, 'x', tol)
  const dy = bestDelta(moving, others, 'y', tol)
  const moved: Rect = { x: moving.x + dx, y: moving.y + dy, width: moving.width, height: moving.height }
  return {
    dx,
    dy,
    guides: [...guidesAlong(moved, others, 'x'), ...guidesAlong(moved, others, 'y')],
  }
}
