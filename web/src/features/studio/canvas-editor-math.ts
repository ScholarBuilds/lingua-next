/* 图片编辑器的几何与状态计算（模块 17 · FR-466）。
 *
   和 `image-math.ts` 一样单独成模块：`CanvasEditor.tsx` 拖着一堆渲染依赖，
   放在里面的函数在 vitest 里根本 import 不进来。判据和常量放这儿，测试直接测。

   扩图与宫格拼接两段是从蓝本翻译的（CR-005 允许直接移植）：
   - 扩图双向：`Infinite-Canvas/static/js/canvas.js:5521 resizeOutpaintFromDrag`
   - 宫格拼接：`Infinite-Canvas/static/js/smart-canvas.js:11633 gridJoinDragTarget`、
     `:11724 gridJoinAutoDims`、`:11735 gridJoinBaseCellSize`、`:12057 gridJoinCanvasSize` */

function clamp(value: number, lo: number, hi: number): number {
  if (hi < lo) return lo
  if (value < lo) return lo
  return value > hi ? hi : value
}

/* ==================== AI 扩图 ==================== */

/** 四周各往外扩多少像素（原图像素） */
export interface Pad {
  top: number
  right: number
  bottom: number
  left: number
}

export const NO_PAD: Pad = { top: 0, right: 0, bottom: 0, left: 0 }

/** 单边最多扩到原图对应边长的多少倍。挡住手滑拖出一张几万像素的画布 */
export const MAX_PAD_RATIO = 2

/** 八个手柄。四条边 + 四个角，与裁剪那套同名同位 */
export type OutpaintHandle = 'n' | 'e' | 's' | 'w' | 'nw' | 'ne' | 'se' | 'sw'

/** 手柄 → 拖动位移怎么变成「往外扩多少」。
 *  往左拖（dx 为负）拉左边框是**扩大**，所以左/上是 -1。 */
const GROW: Record<OutpaintHandle, { x: number; y: number }> = {
  n: { x: 0, y: -1 },
  s: { x: 0, y: 1 },
  w: { x: -1, y: 0 },
  e: { x: 1, y: 0 },
  nw: { x: -1, y: -1 },
  ne: { x: 1, y: -1 },
  se: { x: 1, y: 1 },
  sw: { x: -1, y: 1 },
}

/** 手柄拖动会动到哪两条边。单边模式下只动这里列出的第一组 */
const SIDES: Record<OutpaintHandle, Array<'top' | 'right' | 'bottom' | 'left'>> = {
  n: ['top'],
  s: ['bottom'],
  w: ['left'],
  e: ['right'],
  nw: ['top', 'left'],
  ne: ['top', 'right'],
  se: ['bottom', 'right'],
  sw: ['bottom', 'left'],
}

export function padSize(natW: number, natH: number, pad: Pad): { w: number; h: number } {
  return {
    w: Math.max(1, Math.round(natW + pad.left + pad.right)),
    h: Math.max(1, Math.round(natH + pad.top + pad.bottom)),
  }
}

export function clampPad(pad: Pad, natW: number, natH: number, maxRatio = MAX_PAD_RATIO): Pad {
  const maxW = Math.max(0, natW * maxRatio)
  const maxH = Math.max(0, natH * maxRatio)
  return {
    top: Math.round(clamp(pad.top, 0, maxH)),
    bottom: Math.round(clamp(pad.bottom, 0, maxH)),
    left: Math.round(clamp(pad.left, 0, maxW)),
    right: Math.round(clamp(pad.right, 0, maxW)),
  }
}

/** 拖一个扩图手柄。
 *
 *  `symmetric` 为真时**两侧同时等量扩展**（拖左边框，右边也往外走同样多），
 *  这是默认手感，也是蓝本 `resizeOutpaintFromDrag` 的判据——它写的是
 *  `nextW = start.w + growX * 2` 再重新居中。
 *
 *  这里没有照抄「重新居中」：那样会把一键比例预设留下的不对称留白抹平
 *  （比如 16:9 预设只在左右加边，拖一下上边框会连左右也跟着重排）。
 *  改成两侧各加同样多，总宽同样是 `+grow*2`，而已有的不对称保留。
 *
 *  `symmetric` 为假时只动被拖的那条边（角手柄则是那两条）。
 *
 *  `dx`/`dy` 传**原图像素**位移，调用方按按下那一刻的缩放比换算好。 */
export function applyOutpaintDrag(
  handle: OutpaintHandle,
  dx: number,
  dy: number,
  base: Pad,
  opts: { natW: number; natH: number; symmetric: boolean; maxRatio?: number },
): Pad {
  const dir = GROW[handle]
  const growX = dir.x * dx
  const growY = dir.y * dy
  const next: Pad = { ...base }
  const touched = new Set(SIDES[handle])

  const bump = (side: keyof Pad, amount: number): void => {
    next[side] = base[side] + amount
  }

  if (opts.symmetric) {
    if (dir.x !== 0) {
      bump('left', growX)
      bump('right', growX)
    }
    if (dir.y !== 0) {
      bump('top', growY)
      bump('bottom', growY)
    }
  } else {
    if (touched.has('left')) bump('left', growX)
    if (touched.has('right')) bump('right', growX)
    if (touched.has('top')) bump('top', growY)
    if (touched.has('bottom')) bump('bottom', growY)
  }

  return clampPad(next, opts.natW, opts.natH, opts.maxRatio)
}

/** 一键外扩到某个比例：只往外补，不裁切，原图居中。
 *  翻译自 `MaskCanvas.padForRatio`，判据一字不改——它已经在生图控制台用了一轮。 */
export function padForRatio(w: number, h: number, rw: number, rh: number): Pad {
  const target = rw / rh
  if (w / h > target) {
    const extra = Math.max(0, Math.round(w / target) - h)
    const top = Math.floor(extra / 2)
    return { top, bottom: extra - top, left: 0, right: 0 }
  }
  const extra = Math.max(0, Math.round(h * target) - w)
  const left = Math.floor(extra / 2)
  return { top: 0, bottom: 0, left, right: extra - left }
}

/* ==================== 遮罩笔迹 → 绘制指令 ==================== */

/** 一笔。坐标是**原图像素**，扁平存 [x0,y0,x1,y1,…] */
export interface MaskStroke {
  points: number[]
  /** 笔宽，同样按原图像素 */
  size: number
  erase: boolean
}

export type MaskOp =
  | { op: 'fill' }
  | { op: 'stroke'; composite: 'destination-out' | 'source-over'; width: number; points: number[] }

/** 笔迹 → 蒙版的绘制指令序列。
 *
 *  > [!warning] 蒙版语义：透明 = 要模型重画
 *  >
 *  > OpenAI `images/edits` 读 mask 的 **alpha 通道**：alpha 为 0 的像素交给模型重画，
 *  > 不透明的原样保留。所以底色铺满不透明黑（= 全部保留），笔刷用 `destination-out`
 *  > 打洞（= 打掉的才重画），橡皮再用 `source-over` 把洞补回不透明。
 *  > 写反了会得到「只改没涂的地方」这种正好相反的结果，**而且上游不报错**。
 *
 *  之所以把它做成一串指令再交给 canvas 执行，就是为了让上面这条语义
 *  能在单测里被断言住——直接对着 CanvasRenderingContext2D 写，node 里测不了。 */
export function maskOps(strokes: MaskStroke[]): MaskOp[] {
  const out: MaskOp[] = [{ op: 'fill' }]
  for (const stroke of strokes) {
    if (stroke.points.length < 2) continue
    out.push({
      op: 'stroke',
      composite: stroke.erase ? 'source-over' : 'destination-out',
      width: Math.max(1, stroke.size),
      points: stroke.points,
    })
  }
  return out
}

/* ==================== 弹窗内切图 / 快捷键 ==================== */

export type EditorKeyAction = 'undo' | 'redo' | 'prev' | 'next'

export interface KeyLike {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
}

/** 弹窗里认哪些键。
 *
 *  `⌘Z` / `Ctrl+Z` 撤销、`⌘⇧Z` / `Ctrl+Y` 重做、方向键切上一张/下一张。
 *  左右与上下等价——一组图在用户脑子里既可能是横排也可能是竖排。
 *
 *  调用方要**先**排除焦点在输入框里的情况：那时的 ⌘Z 是撤销打字、
 *  方向键是移动光标（滑杆也吃方向键），都不该被这里接管。 */
export function matchEditorKey(e: KeyLike, isMac: boolean): EditorKeyAction | null {
  const mod = isMac ? e.metaKey === true : e.ctrlKey === true
  const key = e.key.toLowerCase()
  if (mod && key === 'z') return e.shiftKey === true ? 'redo' : 'undo'
  if (mod && key === 'y') return 'redo'
  if (mod || e.altKey === true) return null
  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') return 'prev'
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') return 'next'
  return null
}

/** 切到第几张。**到头就停住，不回绕**。
 *
 *  回绕会让「一直按右」悄悄从最后一张跳回第一张——用户以为还在往后翻，
 *  实际已经在看重复的图了。停住则按不动就是到头了，反馈是确定的。 */
export function stepIndex(index: number, delta: number, total: number): number {
  if (total <= 0) return 0
  return clamp(Math.round(index + delta), 0, total - 1)
}

/* ==================== 宫格拼接 ==================== */

export interface JoinSize {
  id: number
  w: number
  h: number
}

export interface JoinCell {
  id: number
  x: number
  y: number
  w: number
  h: number
  row: number
  col: number
}

export interface JoinLayout {
  cols: number
  rows: number
  cellW: number
  cellH: number
  gap: number
  items: JoinCell[]
}

/** 几张图默认排几行几列（蓝本 `gridJoinAutoDims`）：列数取张数的平方根向上取整 */
export function joinAutoDims(count: number): { rows: number; cols: number } {
  const n = Math.max(1, Math.round(count))
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)))
  return { rows: Math.max(1, Math.ceil(n / cols)), cols }
}

/** 每格多大（蓝本 `gridJoinBaseCellSize`）：取所有图里最大的宽高，
 *  再整体缩到长边不超过 `limit`。格子等大，排出来才是整齐的宫格。 */
export function joinCellSize(sizes: JoinSize[], limit = 420): { w: number; h: number } {
  if (sizes.length === 0) return { w: limit, h: limit }
  const maxW = Math.max(1, ...sizes.map((s) => Math.max(1, s.w)))
  const maxH = Math.max(1, ...sizes.map((s) => Math.max(1, s.h)))
  const k = Math.min(1, limit / Math.max(maxW, maxH))
  return { w: Math.max(1, Math.round(maxW * k)), h: Math.max(1, Math.round(maxH * k)) }
}

/** 按顺序把图摆进网格。坐标单位是「布局像素」，导出时再整体乘一个 outputScale。 */
export function buildJoinLayout(
  order: number[],
  sizes: JoinSize[],
  cols: number,
  gap: number,
  cellLimit = 420,
): JoinLayout {
  const known = new Map(sizes.map((s) => [s.id, s]))
  const ids = order.filter((id) => known.has(id))
  const cell = joinCellSize(
    ids.map((id) => known.get(id) as JoinSize),
    cellLimit,
  )
  const g = Math.max(0, Math.round(gap))
  const c = Math.max(1, Math.min(Math.round(cols), Math.max(1, ids.length)))
  const rows = Math.max(1, Math.ceil(ids.length / c))
  const items = ids.map((id, i) => {
    const row = Math.floor(i / c)
    const col = i % c
    return {
      id,
      x: col * (cell.w + g),
      y: row * (cell.h + g),
      w: cell.w,
      h: cell.h,
      row: row + 1,
      col: col + 1,
    }
  })
  return { cols: c, rows, cellW: cell.w, cellH: cell.h, gap: g, items }
}

/** 成品画布多大（蓝本 `gridJoinCanvasSize`）：按行列算一次，再让每个格子的右下角兜一次底。
 *  最后一行没排满时，高度还是整行——留白比把最后一格顶到边上好看，也好预期。 */
export function joinCanvasSize(layout: JoinLayout): { w: number; h: number } {
  const byGrid = {
    w: layout.cols * layout.cellW + Math.max(0, layout.cols - 1) * layout.gap,
    h: layout.rows * layout.cellH + Math.max(0, layout.rows - 1) * layout.gap,
  }
  const size = layout.items.reduce(
    (acc, item) => ({ w: Math.max(acc.w, item.x + item.w), h: Math.max(acc.h, item.y + item.h) }),
    byGrid,
  )
  return { w: Math.max(1, Math.ceil(size.w)), h: Math.max(1, Math.ceil(size.h)) }
}

/** 拖到哪一格上了（蓝本 `gridJoinDragTarget`）。
 *
 *  判据两条，缺一不可：拖动块的中心落进了某一格（`inside`），
 *  或者离某一格中心足够近（两者尺寸最大值的 0.55 倍以内）。
 *  只用「落进去」的话，格与格之间有间距时松手会经常什么都不发生；
 *  只用距离的话，密排时会抢到不相干的邻居。
 *  排序也照抄：先要落进去的，再按距离近的。 */
export function joinDropTarget(
  layout: JoinLayout,
  draggedId: number,
  dx: number,
  dy: number,
): number | null {
  const dragged = layout.items.find((it) => it.id === draggedId)
  if (dragged === undefined) return null
  const cx = dragged.x + dx + dragged.w / 2
  const cy = dragged.y + dy + dragged.h / 2
  const scored = layout.items
    .filter((it) => it.id !== draggedId)
    .map((it) => ({
      id: it.id,
      inside: cx >= it.x && cx <= it.x + it.w && cy >= it.y && cy <= it.y + it.h,
      dist: Math.hypot(cx - (it.x + it.w / 2), cy - (it.y + it.h / 2)),
      reach: Math.max(dragged.w, dragged.h, it.w, it.h) * 0.55,
    }))
    .filter((it) => it.inside || it.dist < it.reach)
    .sort((a, b) => Number(b.inside) - Number(a.inside) || a.dist - b.dist)
  return scored[0]?.id ?? null
}

/** 交换两个 id 在顺序里的位置。找不到就原样返回（拖到空处不该改变什么） */
export function swapInOrder(order: number[], a: number, b: number): number[] {
  const i = order.indexOf(a)
  const j = order.indexOf(b)
  if (i < 0 || j < 0 || i === j) return order
  const next = [...order]
  next[i] = b
  next[j] = a
  return next
}

/** 成品要放大/缩小多少倍才达到目标长边，同时不越过画布的物理上限。
 *
 *  `maxEdge` / `maxArea` 是浏览器那条线：iOS Safari 的画布面积上限是 16,777,216，
 *  超过整张返回空白**且不报错**——所以宁可少放大也不能越过它。 */
export function joinOutputScale(
  size: { w: number; h: number },
  targetLong: number,
  maxEdge: number,
  maxArea: number,
): number {
  const long = Math.max(1, Math.max(size.w, size.h))
  let k = Math.max(0.05, targetLong / long)
  if (long * k > maxEdge) k = maxEdge / long
  const area = size.w * k * (size.h * k)
  if (area > maxArea) k *= Math.sqrt(maxArea / area)
  return k
}

/* ==================== 撤销栈 ==================== */

/** 一条撤销历史。`past` 末尾是最近一步，`future` 开头是最近一次被撤掉的 */
export interface History<T> {
  past: T[]
  future: T[]
}

export function emptyHistory<T>(): History<T> {
  return { past: [], future: [] }
}

/** 这次改动要不要新压一格历史。
 *
 *  拖一次裁剪选框会触发上百次 set，每次都压栈的话按一次 ⌘Z 只退回一帧，
 *  用户要按两百下才回到起点。`coalesceMs` 内的连续改动算同一步。 */
export function shouldRecord(nowMs: number, lastAtMs: number, coalesceMs: number): boolean {
  return nowMs - lastAtMs > coalesceMs
}

/** 记一步。**同时清空 redo**——从历史中间改出了新分支，原来的「后面」就不存在了 */
export function recordHistory<T>(h: History<T>, prev: T, limit: number): History<T> {
  return { past: [...h.past, prev].slice(-limit), future: [] }
}

/** 撤销一步。没有可撤的返回 null（调用方据此让按钮置灰） */
export function undoHistory<T>(h: History<T>, current: T, limit: number): { history: History<T>; value: T } | null {
  const prev = h.past[h.past.length - 1]
  if (prev === undefined) return null
  return { history: { past: h.past.slice(0, -1), future: [current, ...h.future].slice(0, limit) }, value: prev }
}

/** 重做一步 */
export function redoHistory<T>(h: History<T>, current: T, limit: number): { history: History<T>; value: T } | null {
  const next = h.future[0]
  if (next === undefined) return null
  return { history: { past: [...h.past, current].slice(-limit), future: h.future.slice(1) }, value: next }
}
