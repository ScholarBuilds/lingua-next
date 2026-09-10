/* 画布内核 · 几何与视口数学（模块 17 · CR-005 §3.1）
 *
   移植自 Infinite-Canvas：
   - `static/js/smart-canvas.js` `applyViewport` / `screenToWorld` / `viewportCenter`
   - 同文件连线渲染段（约 6394~6436 行）的端点与控制点算法
   - 同文件 `shell.addEventListener('wheel', ...)`（约 18011 行）的光标锚点缩放

   这里只放纯函数：给定数字算出数字，不碰 DOM、不碰 React。
   手感就藏在这些常数里（控制点的 0.45、最小 50/36、缩放的 0.001），
   照抄蓝本的值，别凭感觉调——差一点点，线的弧度和缩放的跟手程度就变了。 */

/** 世界坐标系里的一块矩形。节点、视口窗、框选框都用它 */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

/** 视口：world 层的 `translate(x,y) scale(scale)` */
export interface Viewport {
  x: number
  y: number
  scale: number
}

/** 连线三语义（BR-142）。缺省按 flow 读 */
export type ConnectionKind = 'input' | 'flow' | 'history'

/* ==================== 视口 ==================== */

/** 蓝本的 `safeScale`：只挡住 NaN/0/负数，**不设上下限**。
 *
 *  蓝本原样如此（`smart-canvas.js:1323`）。缩放上限交给交互层按需决定，
 *  数学层不替调用方做主——缩略图预览要缩到 0.05，节点内看图要放到 8，
 *  在这里钉死会把两边都限制掉。 */
export function safeScale(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 1
}

/** 屏幕坐标 →世界坐标。`origin` 是画布容器的 `getBoundingClientRect()` 左上角 */
export function screenToWorld(clientX: number, clientY: number, origin: Point, viewport: Viewport): Point {
  const scale = safeScale(viewport.scale)
  return {
    x: (clientX - origin.x - viewport.x) / scale,
    y: (clientY - origin.y - viewport.y) / scale,
  }
}

/** 世界坐标 → 屏幕坐标（相对容器左上角，不含 origin 偏移） */
export function worldToScreen(point: Point, viewport: Viewport): Point {
  const scale = safeScale(viewport.scale)
  return { x: point.x * scale + viewport.x, y: point.y * scale + viewport.y }
}

/** 视口中心对应的世界坐标 */
export function viewportCenter(width: number, height: number, viewport: Viewport): Point {
  const scale = safeScale(viewport.scale)
  return { x: (width / 2 - viewport.x) / scale, y: (height / 2 - viewport.y) / scale }
}

/** 滚轮缩放因子。蓝本：`Math.exp(-deltaY * 0.001)`
 *
 *  用指数而不是线性加减，是为了让「连续滚动」的缩放速度与滚动量成比例，
 *  且正反向严格互逆（滚上去再滚回来能精确回到原点）。 */
export function wheelZoomFactor(deltaY: number): number {
  return Math.exp(-deltaY * 0.001)
}

/** 以某个屏幕点为锚缩放：那个点底下的内容保持不动。
 *
 *  `anchor` 是相对画布容器左上角的坐标（已减去 origin）。 */
export function zoomAtPoint(viewport: Viewport, anchor: Point, factor: number, bounds?: { min: number; max: number }): Viewport {
  const prev = safeScale(viewport.scale)
  const before = { x: (anchor.x - viewport.x) / prev, y: (anchor.y - viewport.y) / prev }
  let next = safeScale(prev * factor)
  if (bounds) next = Math.min(bounds.max, Math.max(bounds.min, next))
  return {
    scale: next,
    x: anchor.x - before.x * next,
    y: anchor.y - before.y * next,
  }
}

/** 把一组矩形装进给定视口尺寸，返回能全部看到的视口。
 *
 *  `padding` 是世界坐标下的留白。没有矩形时回落到 scale=1、原点居中。 */
export function fitRects(rects: Rect[], width: number, height: number, padding = 120, maxScale = 1): Viewport {
  if (rects.length === 0 || width <= 0 || height <= 0) return { x: width / 2, y: height / 2, scale: 1 }
  const minX = Math.min(...rects.map((r) => r.x)) - padding
  const minY = Math.min(...rects.map((r) => r.y)) - padding
  const maxX = Math.max(...rects.map((r) => r.x + r.width)) + padding
  const maxY = Math.max(...rects.map((r) => r.y + r.height)) + padding
  const spanX = Math.max(1, maxX - minX)
  const spanY = Math.max(1, maxY - minY)
  const scale = Math.min(maxScale, width / spanX, height / spanY)
  return {
    scale,
    x: (width - spanX * scale) / 2 - minX * scale,
    y: (height - spanY * scale) / 2 - minY * scale,
  }
}

/* ==================== 连线 ==================== */

/** 连线两端在世界坐标里的落点。
 *
 *  input/flow 走**水平**：源右边中点 → 目标左边中点。
 *  history 走**垂直**：源下边中点 → 目标上边中点——归档关系画成竖着往下挂，
 *  和横向的执行流一眼区分得开。 */
export function connectionEndpoints(from: Rect, to: Rect, kind: ConnectionKind = 'flow'): { fx: number; fy: number; tx: number; ty: number } {
  if (kind === 'history') {
    return {
      fx: from.x + from.width / 2,
      fy: from.y + from.height,
      tx: to.x + to.width / 2,
      ty: to.y,
    }
  }
  return {
    fx: from.x + from.width,
    fy: from.y + from.height / 2,
    tx: to.x,
    ty: to.y + to.height / 2,
  }
}

/** 三次贝塞尔的 SVG path。控制点偏移取「两端距离的 45%」，并兜一个最小值，
 *  这样近距离的两个节点之间也有可见的弧度，不会退化成一根直棍。 */
export function connectionPath(from: Rect, to: Rect, kind: ConnectionKind = 'flow'): string {
  const { fx, fy, tx, ty } = connectionEndpoints(from, to, kind)
  if (kind === 'history') {
    const dy = Math.max(36, Math.abs(ty - fy) * 0.45)
    return `M${fx} ${fy} C ${fx} ${fy + dy}, ${tx} ${ty - dy}, ${tx} ${ty}`
  }
  const dx = Math.max(50, Math.abs(tx - fx) * 0.45)
  return `M${fx} ${fy} C ${fx + dx} ${fy}, ${tx - dx} ${ty}, ${tx} ${ty}`
}

/** 连线中点：删除按钮挂在这里 */
export function connectionMidpoint(from: Rect, to: Rect, kind: ConnectionKind = 'flow'): Point {
  const { fx, fy, tx, ty } = connectionEndpoints(from, to, kind)
  return { x: (fx + tx) / 2, y: (fy + ty) / 2 }
}

/* ==================== 命中与选择 ==================== */

/** 两个矩形是否相交（框选判定用：碰到就算选中，不要求完全包住） */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

/** `outer` 有没有把 `inner` 完整框住（含边界重合）。
 *
 *  框选按住 Alt 时用它换掉相交判定：一堆节点叠在一起时「碰到就选」会把
 *  只擦到框边一角的邻居也拽进来，而这时候用户要的恰恰是精确圈一批。 */
export function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  )
}

/** 矩形中心 */
export function rectCenter(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
}

/** 点落在矩形里（含边界） */
export function rectContainsPoint(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height
}

/** 叠放命中：拿一个点去问「压在谁身上」。
 *
 *  移植自 Infinite-Canvas `static/js/smart-canvas.js:9945` `rectOverlapNode`——
 *  蓝本判的是**被拖节点的中心点**落在谁的矩形里，而不是两个矩形相交。
 *  相交判定在这里会误伤：节点稍微擦到邻居的边角就算叠上去，
 *  而中心点要求「明确盖住对方」，跟人眼看到的「我把它放到那个节点上了」一致。
 *
 *  蓝本取第一个命中的，这里取**最后一个**：候选按画布绘制顺序传进来，
 *  后画的盖在上面，人看到的是最上面那个。分组框和它的成员重叠时，
 *  取第一个会连到框上，取最后一个才是成员——后者才是用户想连的。 */
export function rectOverlapAt(
  point: Point,
  candidates: { id: string; rect: Rect }[],
  exclude?: ReadonlySet<string>,
): string | null {
  let hit: string | null = null
  for (const c of candidates) {
    if (exclude?.has(c.id) === true) continue
    if (rectContainsPoint(c.rect, point)) hit = c.id
  }
  return hit
}

/** 半径内离得最近的那个点。`loop` 拖到连线中点上判插入用的就是它。
 *
 *  同距离时取先来的，保证同一份输入永远给同一个结果——
 *  否则拖动过程中预览会在两条线之间来回跳。 */
export function nearestPointHit<T extends { point: Point }>(
  from: Point,
  candidates: T[],
  maxDistance: number,
): (T & { distance: number }) | null {
  let best: (T & { distance: number }) | null = null
  for (const c of candidates) {
    const distance = Math.hypot(from.x - c.point.x, from.y - c.point.y)
    if (distance > maxDistance) continue
    if (best === null || distance < best.distance) best = { ...c, distance }
  }
  return best
}

/** 由拖拽的起止两点得到规范化矩形（支持四个方向拖） */
export function rectFromPoints(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  }
}

/** 切线擦除沿指针路径采样的取样点。
 *
 *  蓝本按每 8px 一个点、最多 12 个点（`eraseConnectionsAlongPointer`）。
 *  只判起止两点的话，快速划过时会从连线上方「跳」过去而切不断——
 *  这几个采样点就是「划过去就断」这个手感的全部来源。 */
export function samplePointerPath(from: Point, to: Point, stepPx = 8, maxSteps = 12): Point[] {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const steps = Math.max(1, Math.min(maxSteps, Math.ceil(Math.hypot(dx, dy) / stepPx)))
  const out: Point[] = []
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps
    out.push({ x: from.x + dx * t, y: from.y + dy * t })
  }
  return out
}

/* ==================== 排布 ==================== */

/** 网格整理：把若干节点按行列摆齐，返回每个节点的新左上角。
 *
 *  `columns` 给 0 时按总数开方取近似正方形。 */
export function arrangeGrid(
  sizes: { id: string; width: number; height: number }[],
  origin: Point,
  gap = 32,
  columns = 0,
): { id: string; x: number; y: number }[] {
  if (sizes.length === 0) return []
  const cols = columns > 0 ? columns : Math.max(1, Math.round(Math.sqrt(sizes.length)))
  const colWidth = Math.max(...sizes.map((s) => s.width))
  const out: { id: string; x: number; y: number }[] = []
  let rowTop = origin.y
  let rowHeight = 0
  sizes.forEach((size, i) => {
    const col = i % cols
    if (col === 0 && i > 0) {
      rowTop += rowHeight + gap
      rowHeight = 0
    }
    out.push({ id: size.id, x: origin.x + col * (colWidth + gap), y: rowTop })
    rowHeight = Math.max(rowHeight, size.height)
  })
  return out
}

/** 指针捕获失败不该让整个交互挂掉。
 *
 *  它在两种情况下会抛 NotFoundError：合成事件（自动化、某些无障碍工具）没有真实
 *  active pointer；以及指针在调用前已经抬起。两种都不是错误状态——
 *  捕获只是「拖出元素外也继续收事件」的优化，没有它拖拽照样能用，
 *  只是拖太远会断。不 try 的话，这一行抛出会让后面设置拖拽状态的代码整段不执行，
 *  表现为「按下去没反应」。 */
export function capturePointer(el: Element, pointerId: number): void {
  try {
    el.setPointerCapture(pointerId)
  } catch {
    /* 见上：捕获是优化不是前提 */
  }
}

/** 释放同理：没捕获过就释放会抛 */
export function releasePointer(el: Element, pointerId: number): void {
  try {
    if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId)
  } catch {
    /* 同上 */
  }
}

/* ==================== 八向缩放 ==================== */

/** 缩放手柄的方位。蓝本 `canvas.js:12564` 按字母分解方向：
 *  含 `e` 动右边、含 `s` 动下边、含 `w` 动左边、含 `n` 动上边，
 *  它那边的 `'resize'` 等价于这里的 `'se'`。 */
export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/** 八个方位，顺序固定：先四条边再四个角，渲染顺序照这个走 */
export const RESIZE_HANDLES: readonly ResizeHandle[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

/** 只改宽度的那几个。高度不落库的节点（图片按比例定型）只能给这些——
 *  给一个动不了对边的手柄，用户拖了发现没反应，比不给还糟。 */
export const WIDTH_RESIZE_HANDLES: readonly ResizeHandle[] = ['e', 'w', 'se', 'sw']

/** 把矩形撑到至少 `min`，同时**钉住这次拖动没在动的那条边**。
 *
 *  拖左边缘（含 `w`）时右边缘是静止的，撑宽只能往左长；拖右边缘则相反。
 *  这条规则不写对的表现很具体：宽度已经顶到下限之后继续往左拖，
 *  矩形会一边保持宽度一边整体左移——看着像「拖着拖着节点自己跑了」。 */
export function growRectAnchored(rect: Rect, handle: ResizeHandle, min: { w: number; h: number }): Rect {
  const out = { ...rect }
  if (out.width < min.w) {
    const right = out.x + out.width
    out.width = min.w
    if (handle.includes('w')) out.x = right - min.w
  }
  if (out.height < min.h) {
    const bottom = out.y + out.height
    out.height = min.h
    if (handle.includes('n')) out.y = bottom - min.h
  }
  return out
}

/** 八向缩放：按手柄方位挪动对应的边，另外两条边原地不动。
 *
 *  `dx`/`dy` 是**世界坐标**里的位移（调用方先把屏幕位移除以 scale）。
 *  往左拖 `w` 手柄是「左边界外移」——`x` 跟着变小、宽度变大，
 *  而不是整块平移；这是八向里最容易写错的一处。 */
export function resizeRectBy(
  rect: Rect,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  min: { w: number; h: number } = { w: 1, h: 1 },
): Rect {
  let { x, y } = rect
  let width = rect.width
  let height = rect.height
  if (handle.includes('e')) width = rect.width + dx
  if (handle.includes('w')) {
    x = rect.x + dx
    width = rect.width - dx
  }
  if (handle.includes('s')) height = rect.height + dy
  if (handle.includes('n')) {
    y = rect.y + dy
    height = rect.height - dy
  }
  return growRectAnchored({ x, y, width, height }, handle, min)
}

/** 手柄对应的鼠标指针。外壳直接把它写成行内 `cursor`，CSS 那边不再重复一份——
 *  同一张映射表分两处写，迟早出现「拖上边缘却显示斜向箭头」。 */
export function resizeCursor(handle: ResizeHandle): string {
  if (handle === 'n' || handle === 's') return 'ns-resize'
  if (handle === 'e' || handle === 'w') return 'ew-resize'
  return handle === 'ne' || handle === 'sw' ? 'nesw-resize' : 'nwse-resize'
}
