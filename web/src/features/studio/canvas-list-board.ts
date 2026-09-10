import { zoomAtPoint } from './canvas-core/geometry'
import type { Point, Viewport } from './canvas-core/geometry'

export const BOARD_MIN_SCALE = 0.3
export const BOARD_MAX_SCALE = 2
export const BOARD_CARD_WIDTH = 248
export const BOARD_CARD_HEIGHT = 190

const BOARD_X0 = 40
const BOARD_Y0 = 40
const BOARD_X_STRIDE = 276
const BOARD_Y_STRIDE = 216

/** 桌面再宽也不铺超过 4 列：一行卡片太多会逼着眼睛横扫 */
export const BOARD_COLUMNS_MAX = 4

export interface BoardCanvasLike {
  id: number
  board_x: number | null
  board_y: number | null
}

export interface BoardCanvasPosition<T extends BoardCanvasLike> {
  canvas: T
  x: number
  y: number
  generated: boolean
}

/**
 * 补位列数由桌面实测宽度决定。卡片是固定 248px 宽的绝对定位块，列数写死就等于
 * 窄屏时把卡片摆到可视区外面——那是「列表完全不回流」的根因。
 * 宽度还没量到（首帧 clientWidth 为 0）时退回最大列数，量到之后重算一遍。
 */
export function boardColumns(width?: number): number {
  if (width === undefined || !Number.isFinite(width) || width <= 0) return BOARD_COLUMNS_MAX
  // 首列左边距与末列右侧留同样的余量；除末列外每列占一个 stride，末列只占卡宽
  const usable = width - BOARD_X0 * 2
  const fit = Math.floor((usable - BOARD_CARD_WIDTH) / BOARD_X_STRIDE) + 1
  return Math.min(BOARD_COLUMNS_MAX, Math.max(1, fit))
}

/**
 * Infinite-Canvas 的兼容排布：已有世界坐标原样保留；旧画布没有坐标时，
 * 从现有卡片数量之后的网格槽开始补位。generated 用来触发首次持久化。
 */
export function layoutBoardCanvases<T extends BoardCanvasLike>(
  items: T[],
  width?: number,
): BoardCanvasPosition<T>[] {
  const positionedCount = items.filter((item) => item.board_x !== null && item.board_y !== null).length
  const columns = boardColumns(width)
  let autoIndex = positionedCount

  return items.map((canvas) => {
    if (canvas.board_x !== null && canvas.board_y !== null) {
      return { canvas, x: canvas.board_x, y: canvas.board_y, generated: false }
    }
    const col = autoIndex % columns
    const row = Math.floor(autoIndex / columns)
    autoIndex += 1
    return {
      canvas,
      x: BOARD_X0 + col * BOARD_X_STRIDE,
      y: BOARD_Y0 + row * BOARD_Y_STRIDE,
      generated: true,
    }
  })
}

/** 与原项目 resetView 同一套边界与居中算法。 */
export function fitBoardCanvases(
  items: Array<{ x: number; y: number }>,
  width: number,
  height: number,
): Viewport {
  if (items.length === 0 || width <= 0 || height <= 0) return { x: 0, y: 0, scale: 1 }

  const minX = Math.min(...items.map((item) => item.x))
  const minY = Math.min(...items.map((item) => item.y))
  const maxX = Math.max(...items.map((item) => item.x + BOARD_CARD_WIDTH))
  const maxY = Math.max(...items.map((item) => item.y + BOARD_CARD_HEIGHT))
  const spanX = Math.max(1, maxX - minX)
  const spanY = Math.max(1, maxY - minY)
  const padding = width < 640 ? 20 : 40
  const fitX = (width - padding * 2) / spanX
  const fitY = (height - padding * 2) / spanY
  const fitScale = Math.min(1, fitX, fitY)
  /* 纵向放不下可以往下拖着看，横向放不下就是「卡片跑到视口右边外面」，必须让步：
     所以只在横向真的塞不下时才越过 0.9 这道可读性下限，一路缩到 BOARD_MIN_SCALE。 */
  const preferred = Math.max(fitScale, Math.min(0.9, fitX))
  const scale = width < 640
    ? 1
    : Math.min(BOARD_MAX_SCALE, Math.max(BOARD_MIN_SCALE, preferred))
  // 留 1px 容差：scale 正好等于 fitX 时浮点误差会让「刚好放得下」判成放不下
  const fitsX = spanX * scale <= width - padding * 2 + 1
  const fitsY = spanY * scale <= height - padding * 2 + 1

  return {
    scale,
    x: Math.round((fitsX ? (width - spanX * scale) / 2 : padding) - minX * scale),
    y: Math.round((fitsY ? Math.max(padding, (height - spanY * scale) / 2) : padding) - minY * scale),
  }
}

/** 原项目滚轮是一格 1.1 倍，并始终把指针下的世界点钉在原位。 */
export function zoomBoardAt(viewport: Viewport, anchor: Point, zoomIn: boolean): Viewport {
  return zoomAtPoint(viewport, anchor, zoomIn ? 1.1 : 1 / 1.1, {
    min: BOARD_MIN_SCALE,
    max: BOARD_MAX_SCALE,
  })
}
