/* 画布内核 · 排布、连线合法性与分桶（模块 17 · CR-005 §3.1 / FR-462）
 *
   移植自 Infinite-Canvas，函数对应关系：

   | 本文件                                    | 蓝本                                                                 |
   | ----------------------------------------- | -------------------------------------------------------------------- |
   | `connectedClusterIds`                     | `static/js/smart-canvas.js:1987` `connectedSmartClusterIds`           |
   | `atomicIds`                               | `static/js/smart-canvas.js:2004` `smartArrangeAtomicIds`              |
   | `arrangeByConnections`（含成员整体平移）  | `smart-canvas.js:2033` `arrangeSmartIdsByConnections` + `moveSmartNodeAtom` |
   | `loopInsertionFor` / `loopInsertionEdges` | `smart-canvas.js:10183` `insertionConnectionForNode` / `insertLoopNodeIntoConnection` |
   | `canAutoConnect` / `autoConnectTargetFor` | `smart-canvas.js:9945` `rectOverlapNode` / `dragConnectTargetFor` / `canAutoConnectDraggedNode` |
   | `bucketConnections`                       | `smart-canvas.js:6374` 连线合并分桶段                                |
   | `canConnect` / `wouldCreateCycle` / `sanitizeConnections` | `static/js/canvas.js:15285` `canConnect` / `wouldCreateGeneratorCycle` / `sanitizeConnections` |

   `freeSpotFor` / `freeSpotsFor` **没有蓝本对应物**：蓝本建产出节点一律
   `rect.x + rect.width + 240`，谁在那儿都压上去，同一个源节点连点两次
   两个产出节点坐标完全相同。这两个函数是本仓补的落点避让。

   这一层**只算数**：进来是 id、矩形和边，出去是位置表、布尔值和分桶结果。
   不碰 DOM、不碰 store、不碰 React——手势层拿它的结论去改数据，
   测试拿它的结论当断言，两边看到的是同一套规则。 */

import { connectionMidpoint, nearestPointHit, rectCenter, rectOverlapAt, rectsIntersect } from './geometry'
import type { ConnectionKind, Point, Rect } from './geometry'

/* ==================== 手感常数 ==================== */

/** 自动排列：同一列里两个节点的纵向间距 */
export const ARRANGE_ROW_GAP = 56
/** 自动排列：相邻两列的横向间距 */
export const ARRANGE_COL_GAP = 180
/** 自动排列：一行至少占这么高（空节点也不能挤成一条缝） */
export const ARRANGE_MIN_ROW_H = 110
/** 自动排列：一列至少占这么宽 */
export const ARRANGE_MIN_COL_W = 180
/** loop 拖到连线中点多近算「插进去」。蓝本 `smart-canvas.js:10199` 的 96 */
export const LOOP_INSERT_RADIUS = 96

/* ==================== 输入类型 ==================== */

/** 排布/判定要用到的节点侧面。刻意不引 ScvNode：这层不认识业务字段 */
export interface LayoutNode {
  id: string
  type: string
  rect: Rect
  /** group 节点的成员 id。排布时组与成员是一个原子，一起走 */
  memberIds?: string[]
  /** 历史归档分组。自动连线、loop 插入都绕开它 */
  history?: boolean
}

export interface LayoutEdge {
  from: string
  to: string
  kind?: ConnectionKind
}

/** 排布结果：节点的新左上角 */
export interface Placement {
  id: string
  x: number
  y: number
}

/* ==================== 分组作用域 ==================== */

/** 节点 → 它所属的「分组作用域」id：成员给分组本体，分组本体给自己，其余不收录。
 *
 *  蓝本 `smart-canvas.js:1465` `smartGroupScopeId`。连线合并与组内边隐藏全靠它。 */
export function groupScopeMap(nodes: LayoutNode[]): Map<string, string> {
  const scope = new Map<string, string>()
  for (const n of nodes) {
    if (n.type !== 'group') continue
    scope.set(n.id, n.id)
    for (const mid of n.memberIds ?? []) scope.set(mid, n.id)
  }
  return scope
}

/** 把成员 id 折叠成它所在的分组 id（分组是排布的最小单位）。
 *
 *  蓝本用 while 循环反复折叠以支持嵌套分组；这里的分组不嵌套（FR-461 只有一层），
 *  一次映射就到底，多跑几轮只是白转。 */
export function atomicIds(ids: Iterable<string>, nodes: LayoutNode[]): string[] {
  const scope = groupScopeMap(nodes)
  const known = new Set(nodes.map((n) => n.id))
  const out = new Set<string>()
  for (const id of ids) {
    if (!known.has(id)) continue
    out.add(scope.get(id) ?? id)
  }
  return [...out]
}

/* ==================== 连通簇 ==================== */

/** 从一个节点出发，沿连线（不分方向）能走到的所有节点。
 *
 *  只选中一个节点时按这个簇整理——用户点一个节点说「整理一下」，
 *  想整理的是这条链，不是那一个孤零零的节点。 */
export function connectedClusterIds(seed: string, nodes: LayoutNode[], edges: LayoutEdge[]): string[] {
  const known = new Set(nodes.map((n) => n.id))
  if (!known.has(seed)) return []
  const seen = new Set([seed])
  const queue = [seed]
  while (queue.length > 0) {
    const id = queue.shift() as string
    for (const e of edges) {
      if (e.from !== id && e.to !== id) continue
      const next = e.from === id ? e.to : e.from
      if (!known.has(next) || seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  return [...seen]
}

/* ==================== 按连线深度分层排列 ==================== */

/** 去重后的内部边（两端都在集合里）。重复边会让入度多减一次，把拓扑序算歪 */
function internalEdges(edges: LayoutEdge[], ids: ReadonlySet<string>): LayoutEdge[] {
  const seen = new Set<string>()
  const out: LayoutEdge[] = []
  for (const e of edges) {
    if (e.from === e.to) continue
    if (!ids.has(e.from) || !ids.has(e.to)) continue
    const key = `${e.from}→${e.to}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(e)
  }
  return out
}

/** 每个节点的层深 = 从入度 0 的根算起的**最长**路径长度。
 *
 *  与蓝本的一处**有意不同**：蓝本用 `seen` 集合保证每个节点只入队一次
 *  （`smart-canvas.js:2046`），菱形结构（A→B→D、A→C→D）里 D 会停在先算到的
 *  那个深度上，最后和它的上游 C 挤在同一列，线倒着往回画。
 *  这里走 Kahn 拓扑序：出队时上游全部结算完毕，取 max 才是真正的最长路径。 */
function depthByLongestPath(atoms: LayoutNode[], internal: LayoutEdge[]): Map<string, number> {
  const depth = new Map(atoms.map((a) => [a.id, 0]))
  const indeg = new Map(atoms.map((a) => [a.id, 0]))
  for (const e of internal) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1)

  const queue = atoms.filter((a) => (indeg.get(a.id) ?? 0) === 0).map((a) => a.id)
  while (queue.length > 0) {
    const id = queue.shift() as string
    for (const e of internal) {
      if (e.from !== id) continue
      depth.set(e.to, Math.max(depth.get(e.to) ?? 0, (depth.get(id) ?? 0) + 1))
      const left = (indeg.get(e.to) ?? 0) - 1
      indeg.set(e.to, left)
      if (left === 0) queue.push(e.to)
    }
  }
  /* 环上的节点入度永远降不到 0，出不了队。它们保持已算到的深度上界，
     照样会被摆进某一列——排布不该因为用户连了个环就整个罢工。 */
  return depth
}

/**
 * 按连线深度分层排列：同一深度竖着排一列，深度递增往右走。
 *
 * 分组是原子：算位置只算分组本体，成员按同一位移整体跟着走
 * （蓝本 `translateSmartNodeWithMembers`）。少了这一步，
 * 分组框被摆到新位置而里面的提示词留在原地，看起来就是「组被拆了」。
 *
 * 返回空数组表示没什么可排（可排的原子少于 2 个）。
 */
export function arrangeByConnections(
  ids: Iterable<string>,
  nodes: LayoutNode[],
  edges: LayoutEdge[],
): Placement[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const atomIds = atomicIds(ids, nodes)
  const atoms = atomIds.map((id) => byId.get(id)).filter((n): n is LayoutNode => n !== undefined)
  if (atoms.length < 2) return []

  const startX = Math.min(...atoms.map((a) => a.rect.x))
  const startY = Math.min(...atoms.map((a) => a.rect.y))
  const idSet = new Set(atomIds)
  const depth = depthByLongestPath(atoms, internalEdges(edges, idSet))

  const columns = new Map<number, LayoutNode[]>()
  for (const a of atoms) {
    const d = depth.get(a.id) ?? 0
    columns.set(d, [...(columns.get(d) ?? []), a])
  }

  const out: Placement[] = []
  let x = startX
  for (const d of [...columns.keys()].sort((a, b) => a - b)) {
    /* 列内按原来的上下顺序排，y 相同再按 id——不然每次整理的上下次序都在变，
       用户会以为画布自己动了 */
    const col = (columns.get(d) ?? [])
      .slice()
      .sort((a, b) => a.rect.y - b.rect.y || a.id.localeCompare(b.id))
    let y = startY
    let colWidth = 0
    for (const node of col) {
      const nx = Math.round(x)
      const ny = Math.round(y)
      out.push({ id: node.id, x: nx, y: ny })
      const dx = nx - node.rect.x
      const dy = ny - node.rect.y
      for (const mid of node.memberIds ?? []) {
        const member = byId.get(mid)
        if (member === undefined) continue
        out.push({ id: mid, x: Math.round(member.rect.x + dx), y: Math.round(member.rect.y + dy) })
      }
      y += Math.max(ARRANGE_MIN_ROW_H, node.rect.height) + ARRANGE_ROW_GAP
      colWidth = Math.max(colWidth, Math.max(ARRANGE_MIN_COL_W, node.rect.width))
    }
    x += colWidth + ARRANGE_COL_GAP
  }
  return out
}

/* ==================== 新节点落点避让 ==================== */

/**
 * 新节点与已有节点之间至少留这么宽的空隙。
 *
 * 蓝本没有这一层：它建产出节点一律 `rect.x + rect.width + 240`
 * （`smart-canvas.js:8255` / `10989` / `12843`），谁在那儿都直接压上去。
 * 同一个源节点连点两次「出图」，两个产出节点的坐标一模一样，后一张把前一张盖死。
 */
export const PLACE_GAP = 28
/** 往左/往上挪的代价系数。产出默认落在来源右边，往回挪会插到来源和它的上游之间，
 *  读起来是倒着的；乘一个大于 1 的系数让候选排序天然偏向右下 */
export const PLACE_BACKWARD_COST = 1.6
/** 参与生成候选位的邻居上限。候选数是 (2n+1)²，n 不封顶的话
 *  一张几百个节点的画布每落一个节点要跑上百万次相交判定 */
const PLACE_NEIGHBOR_MAX = 32

export interface FreeSpotOptions {
  /** 与已有节点之间至少留的空隙 */
  gap?: number
  /** 往左/往上挪的代价系数 */
  backwardCost?: number
}

/** 四周各外扩 d */
function inflate(r: Rect, d: number): Rect {
  return { x: r.x - d, y: r.y - d, width: r.width + d * 2, height: r.height + d * 2 }
}

function overlapsAny(rect: Rect, blocked: readonly Rect[]): boolean {
  return blocked.some((b) => rectsIntersect(rect, b))
}

/**
 * 给一个新节点找一个**不与任何已有节点相交**的落点，并尽量贴近 `desired`。
 *
 * 这不是排布算法，是落点避让：`arrangeByConnections` 会把整条链重排，
 * 生成时用户正盯着某处看，整条链跳走是很糟的体验——所以出图只挪新节点，
 * 一个已有节点都不动。
 *
 * 候选位取自「贴着某个邻居的四条边放」的 x/y 交叉组合（矩形装箱里的
 * 角点候选集），外加 `desired` 本身和一个兜底位。按到 `desired` 的加权距离
 * 取最小，距离相同时取更靠上、更靠左的那个——落点必须是确定的，
 * 同样的画布两次点生成不能落在两个地方。
 *
 * **周围全满时**落在所有节点的最右侧（`maxRight + gap`）：那个位置一定空着，
 * 所以这个函数永远返回一个真正可用的落点，不会退化成「就摆在原地压着」。
 */
export function freeSpotFor(
  desired: Rect,
  obstacles: readonly Rect[],
  options: FreeSpotOptions = {},
): Point {
  const gap = options.gap ?? PLACE_GAP
  const backward = options.backwardCost ?? PLACE_BACKWARD_COST
  /* 障碍先外扩 gap：新矩形与外扩后的框不相交 ⇔ 与原框的间距 ≥ gap。
     这样后面只要做纯相交判定，不用到处再减一次间距 */
  const blocked = obstacles.map((o) => inflate(o, gap))
  if (!overlapsAny(desired, blocked)) return { x: desired.x, y: desired.y }

  const cx = desired.x + desired.width / 2
  const cy = desired.y + desired.height / 2
  const near = blocked
    .map((b) => ({ b, d: (b.x + b.width / 2 - cx) ** 2 + (b.y + b.height / 2 - cy) ** 2 }))
    .sort((l, r) => l.d - r.d)
    .slice(0, PLACE_NEIGHBOR_MAX)
    .map((entry) => entry.b)

  const xs = new Set<number>([desired.x])
  const ys = new Set<number>([desired.y])
  for (const b of near) {
    xs.add(b.x + b.width)
    xs.add(b.x - desired.width)
    ys.add(b.y + b.height)
    ys.add(b.y - desired.height)
  }

  /* 兜底位：所有障碍的最右边再往右让一个身位。那里一定没有东西，
     所以候选集里至少有一个是空的，函数不会无解 */
  const maxRight = blocked.reduce((max, b) => Math.max(max, b.x + b.width), desired.x)
  const candidates: Point[] = [{ x: maxRight, y: desired.y }]
  for (const x of xs) for (const y of ys) candidates.push({ x, y })

  let best: Point | null = null
  let bestScore = Number.POSITIVE_INFINITY
  for (const p of candidates) {
    const rect = { x: p.x, y: p.y, width: desired.width, height: desired.height }
    if (overlapsAny(rect, blocked)) continue
    const dx = p.x - desired.x
    const dy = p.y - desired.y
    const wx = dx < 0 ? dx * backward : dx
    const wy = dy < 0 ? dy * backward : dy
    const score = wx * wx + wy * wy
    if (score > bestScore) continue
    // 同分时取更靠上、再靠左的：落点得是确定的，同一张画布两次点生成要落在同一处
    if (score === bestScore && best !== null && (p.y > best.y || (p.y === best.y && p.x >= best.x))) {
      continue
    }
    best = p
    bestScore = score
  }
  const hit = best ?? { x: maxRight, y: desired.y }
  return { x: Math.round(hit.x), y: Math.round(hit.y) }
}

/**
 * 一次落 N 个新节点（并发出图、成套出图的槽位）。
 *
 * 逐个安置，**每安置一个就把它自己加进障碍**——少了这一步，N 个新节点
 * 各自避开了老节点，却整整齐齐叠在同一个空位上，正是「并发出的图互相盖住」。
 */
export function freeSpotsFor(
  desired: readonly Rect[],
  obstacles: readonly Rect[],
  options: FreeSpotOptions = {},
): Point[] {
  const blocked = [...obstacles]
  const out: Point[] = []
  for (const want of desired) {
    const spot = freeSpotFor(want, blocked, options)
    out.push(spot)
    blocked.push({ x: spot.x, y: spot.y, width: want.width, height: want.height })
  }
  return out
}

/* ==================== 连线合法性（端口矩阵） ==================== */

/** 一条边送的是什么。与节点注册表 `nodes/definition.ts` 的 `PortKind` 同一套词汇 */
export type PortChannel = 'image' | 'video' | 'audio' | 'file' | 'text' | 'control'

export interface PortSpec {
  /** 能往下游送什么 */
  emits: PortChannel[]
  /** 能从上游收什么 */
  accepts: PortChannel[]
}

/**
 * 端口矩阵：谁能连到谁，由「送什么 / 收什么」推出来，不写死类型对。
 *
 * 矩阵由调用方传进来，唯一产地是节点注册表——
 * `nodes/index.ts` 的 `NODE_PORT_MATRIX = derivePortMatrix(NODE_DEFINITIONS)`。
 * 新增一种节点只改它那份 `.definition.ts`，这里不用动。
 *
 * 内核不 import 注册表是有意的，也躲不开：`canvas-core` 是与业务节点无关的一层，
 * 而注册表经 `.definition.ts` → `CanvasNodes` → `canvasStore` 又绕回本文件，
 * 反向 import 会成真环（`definition.ts` 的 `EMPTY_NODE_W` 已经因为 TDZ 挪过一次家）。
 *
 * 收不了任何东西的类型（prompt/audio/file）不是漏写：提示词只往外送文本，
 * 音频和文件是躺在画布上的素材。
 */
export function derivePortMatrix(
  defs: Record<string, { ports?: { in?: PortChannel[]; out?: PortChannel[] } }>,
): Record<string, PortSpec> {
  const out: Record<string, PortSpec> = {}
  for (const [type, def] of Object.entries(defs)) {
    out[type] = { emits: def.ports?.out ?? [], accepts: def.ports?.in ?? [] }
  }
  return out
}

/** 连线两端的最小画像 */
export interface ConnectEnd {
  id: string
  type: string
  /** 历史归档分组：只收归档边，不参与常规连线 */
  history?: boolean
}

/**
 * 这条边合不合法。蓝本 `canvas.js:15285` `canConnect` 的端口化改写。
 *
 * `history` 边是归档关系（源节点 → 历史分组），不走端口矩阵——
 * 它连的本来就是一个「收不了任何东西」的分组节点。
 */
export function canConnect(
  from: ConnectEnd,
  to: ConnectEnd,
  kind: ConnectionKind,
  matrix: Readonly<Record<string, PortSpec>>,
): boolean {
  if (from.id === to.id) return false
  if (kind === 'history') return true
  if (from.history === true || to.history === true) return false
  const src = matrix[from.type]
  const dst = matrix[to.type]
  if (src === undefined || dst === undefined) return false
  return src.emits.some((c) => dst.accepts.includes(c))
}

/**
 * 加上这条边会不会成环：从 `to` 出发能不能走回 `from`。
 *
 * 蓝本 `wouldCreateGeneratorCycle` 额外为 output 节点开了一条「穿透继续走」的支路，
 * 因为它那边 output 不在常规邻接里。我们的 output 就是图上的普通节点，
 * 直接做可达性就把那条特例覆盖掉了，少一个只有作者记得的分支。
 *
 * `history` 边不算：归档是往回指的记录关系，把它算进来会让「重跑一次」这种
 * 正常操作被误判成环。
 */
export function wouldCreateCycle(from: string, to: string, edges: LayoutEdge[]): boolean {
  if (from === to) return true
  const next = new Map<string, string[]>()
  for (const e of edges) {
    if ((e.kind ?? 'flow') === 'history') continue
    next.set(e.from, [...(next.get(e.from) ?? []), e.to])
  }
  const seen = new Set([to])
  const queue = [to]
  while (queue.length > 0) {
    const id = queue.shift() as string
    if (id === from) return true
    for (const n of next.get(id) ?? []) {
      if (seen.has(n)) continue
      seen.add(n)
      queue.push(n)
    }
  }
  return false
}

/**
 * 悬空边清理：丢掉指向不存在节点的边、自环、重复边和端口矩阵不允许的边。
 *
 * 蓝本 `sanitizeConnections` 只做最后一件。前三件是我们这边的实际残留来源：
 * 节点删除与连线删除是两条路径，删节点时漏掉一条边，画布上就留下一根
 * 从空气连到空气的线，还会被级联当成真的上游去取图。
 */
export function sanitizeConnections(
  edges: LayoutEdge[],
  nodes: LayoutNode[],
  matrix: Readonly<Record<string, PortSpec>>,
): LayoutEdge[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const seen = new Set<string>()
  const out: LayoutEdge[] = []
  for (const e of edges) {
    const from = byId.get(e.from)
    const to = byId.get(e.to)
    if (from === undefined || to === undefined) continue
    if (e.from === e.to) continue
    const kind = e.kind ?? 'flow'
    const key = `${e.from}→${e.to}→${kind}`
    if (seen.has(key)) continue
    if (!canConnect(from, to, kind, matrix)) continue
    seen.add(key)
    out.push(e)
  }
  return out
}

/* ==================== 松手手势：loop 插入连线 ==================== */

/**
 * loop 节点松手时压在哪条连线的中点上（半径 `LOOP_INSERT_RADIUS`）。
 *
 * 蓝本 `insertionConnectionForNode`：只认 input/flow 两种边，跳过与 loop 自己
 * 相接的边和挂在历史分组上的边，取最近的一条。
 */
export function loopInsertionFor(
  loopId: string,
  loopRect: Rect,
  edges: LayoutEdge[],
  nodes: LayoutNode[],
  maxDistance: number = LOOP_INSERT_RADIUS,
): { index: number; edge: LayoutEdge; distance: number } | null {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const center = rectCenter(loopRect)
  const candidates: { index: number; edge: LayoutEdge; point: Point }[] = []
  edges.forEach((edge, index) => {
    const kind = edge.kind ?? 'flow'
    if (kind !== 'input' && kind !== 'flow') return
    if (edge.from === loopId || edge.to === loopId) return
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    if (from === undefined || to === undefined) return
    if (from.history === true || to.history === true) return
    candidates.push({ index, edge, point: connectionMidpoint(from.rect, to.rect, kind) })
  })
  const hit = nearestPointHit(center, candidates, maxDistance)
  return hit === null ? null : { index: hit.index, edge: hit.edge, distance: hit.distance }
}

/**
 * 把 loop 插进一条边里：原边断开，换成「上游 → loop → 下游」。
 *
 * 蓝本 `insertLoopNodeIntoConnection`：上游那半段沿用原来的语义
 * （flow 还是 flow，其余按 input 走），loop 到下游那半段一律是 input——
 * loop 给下游的是「参考输入」，不是执行血缘。
 */
export function loopInsertionEdges(edge: LayoutEdge, loopId: string): LayoutEdge[] {
  const kind = edge.kind ?? 'flow'
  return [
    { from: edge.from, to: loopId, kind: kind === 'flow' ? 'flow' : 'input' },
    { from: loopId, to: edge.to, kind: 'input' },
  ]
}

/* ==================== 松手手势：叠放自动连线 ==================== */

/** 出媒体的节点类型。自动连线的方向规则按「媒体 / 文本」两族分 */
const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'file', 'output', 'workflow', 'modelscope', 'midjourney'])

/**
 * 把 A 叠到 B 上时该不该自动连一条 A→B。蓝本 `canAutoConnectDraggedNode`。
 *
 * 比端口矩阵更保守：矩阵管「允不允许」，这里管「用户是不是真想要」。
 * 分组永远不是自动连线的目标——拖到分组框上的意思是「放进去」而不是「连上」。
 */
export function canAutoConnect(from: ConnectEnd, to: ConnectEnd): boolean {
  if (from.id === to.id) return false
  if (from.history === true || to.history === true) return false
  if (to.type === 'group') return false
  if (MEDIA_TYPES.has(from.type)) {
    return MEDIA_TYPES.has(to.type) || to.type === 'loop' || to.type === 'prompt' || to.type === 'llm'
  }
  if (from.type === 'prompt' || from.type === 'llm') return MEDIA_TYPES.has(to.type) || to.type === 'loop'
  if (from.type === 'loop' || from.type === 'group') return MEDIA_TYPES.has(to.type) || to.type === 'loop'
  return false
}

/**
 * 松手时该自动连到谁：被拖节点的中心压住的最上层节点，且两条规则都点头
 * （`canAutoConnect` 的意图规则 + `canConnect` 的端口矩阵）。
 *
 * `exclude` 传一起被拖动的那批 id——它们跟着一起走，压住彼此不算叠放。
 */
export function autoConnectTargetFor(
  dragged: ConnectEnd,
  droppedRect: Rect,
  nodes: LayoutNode[],
  matrix: Readonly<Record<string, PortSpec>>,
  exclude?: ReadonlySet<string>,
): string | null {
  const skip = new Set(exclude ?? [])
  skip.add(dragged.id)
  const hitId = rectOverlapAt(rectCenter(droppedRect), nodes.map((n) => ({ id: n.id, rect: n.rect })), skip)
  if (hitId === null) return null
  const target = nodes.find((n) => n.id === hitId)
  if (target === undefined) return null
  if (!canAutoConnect(dragged, target)) return null
  if (!canConnect(dragged, target, 'input', matrix)) return null
  return target.id
}

/* ==================== 连线分桶合并 ==================== */

export interface BucketInput {
  index: number
  from: string
  to: string
  kind: ConnectionKind
}

export interface ConnectionBucket {
  /** 画出来的起点（原样） */
  from: string
  /** 画出来的终点：合并过就是分组本体，否则是原终点 */
  to: string
  kind: ConnectionKind
  /** 这一桶盖住了原 connections 数组里的哪几条。切线/断开按下标批量处理 */
  indices: number[]
  /** 合并前的真实终点，判「下游在排队」要按它们看 */
  targets: string[]
  merged: boolean
}

/**
 * 连线分桶：同一来源连到同一分组的多个成员合成一条到分组的线，组内部的边隐藏。
 *
 * 蓝本 `smart-canvas.js:6374`。没有这一步，一个提示词连到分组里九张图就是九根线
 * 从同一个点扇出去，把分组框糊成一团——而它们表达的是同一件事。
 *
 * `history` 边不参与：归档关系本来就要一条条看清楚。
 */
export function bucketConnections(
  conns: BucketInput[],
  scopeOf: (id: string) => string,
): ConnectionBucket[] {
  const buckets = new Map<string, ConnectionBucket>()
  const out: ConnectionBucket[] = []
  for (const conn of conns) {
    const kind = conn.kind
    const fromScope = kind === 'history' ? '' : scopeOf(conn.from)
    const toScope = kind === 'history' ? '' : scopeOf(conn.to)
    // 同一分组内部的边（成员↔成员、成员↔分组本体）入组后隐藏，保持整洁
    if (fromScope !== '' && fromScope === toScope) continue
    // 终点是某个分组的成员：同一来源到该分组各成员的线并成一条到分组的线
    if (toScope !== '' && toScope !== conn.to) {
      const key = `${conn.from}|${toScope}|${kind}`
      const exist = buckets.get(key)
      if (exist === undefined) {
        const bucket: ConnectionBucket = {
          from: conn.from,
          to: toScope,
          kind,
          indices: [conn.index],
          targets: [conn.to],
          merged: true,
        }
        buckets.set(key, bucket)
        out.push(bucket)
      } else {
        exist.indices.push(conn.index)
        exist.targets.push(conn.to)
      }
      continue
    }
    out.push({ from: conn.from, to: conn.to, kind, indices: [conn.index], targets: [conn.to], merged: false })
  }
  return out
}

/* ==================== 分组成员的自适应排布 ==================== */

/** 同一行的容差：纵坐标差在这个范围内算「并排」，按 x 读。
 *  蓝本 `smart-canvas.js:1590` 排序里的 24。没有容差的话，
 *  两个肉眼并排、y 差 2px 的成员会被判成上下两行，顺序就乱了。 */
export const MEMBER_ROW_TOLERANCE = 24

/** 分组成员整理的内边距与间距。蓝本 `SMART_GROUP_ARRANGE_PADDING` / `_GAP` */
export const MEMBER_PAD = 18
export const MEMBER_GAP = 16

/** 阅读顺序：先行后列。**用户手动挪过的位置在这里被读成「顺序」**——
 *  重排会丢掉他摆的坐标，但不会打乱他排的先后。 */
export function readingOrder<T extends { x: number; y: number }>(items: readonly T[]): T[] {
  return items.slice().sort((a, b) => {
    const dy = a.y - b.y
    return Math.abs(dy) > MEMBER_ROW_TOLERANCE ? dy : a.x - b.x
  })
}

export interface MemberFlow {
  /** 每个成员相对内容区左上角的偏移 */
  cells: { id: string; dx: number; dy: number }[]
  /** 实际用到的行数 */
  rows: number
  /** 内容区实际占的宽高（不含 pad） */
  contentW: number
  contentH: number
}

/** 按可用宽度把成员流式排进若干行——拉宽就多塞几个，拉窄就折下去。
 *
 *  这才是「组里的内容根据拖拽自适应填充」：列数由拖出来的宽度决定，
 *  而不是把成员整体等比放大。等比放大那条路还会把缩放后的 w/h 写回成员，
 *  蓝本 `smart-canvas.js:1615` 记着它的后果——「拖出再拖入图片变小、
 *  整理也救不回来」，因为写进去的尺寸盖住了自然尺寸。所以这里**只算位置，
 *  不碰成员尺寸**。
 *
 *  比一行还宽的成员独占一行：宁可溢出一点，也不能排出 0 个的空行。
 *  行内成员按行高居中，和「整理」的观感一致。 */
export function flowMembers(
  sizes: readonly { id: string; w: number; h: number }[],
  innerWidth: number,
  gap = MEMBER_GAP,
): MemberFlow {
  if (sizes.length === 0) return { cells: [], rows: 0, contentW: 0, contentH: 0 }
  const rows: { id: string; w: number; h: number }[][] = []
  let row: { id: string; w: number; h: number }[] = []
  let used = 0
  for (const size of sizes) {
    const need = row.length === 0 ? size.w : used + gap + size.w
    if (row.length > 0 && need > innerWidth) {
      rows.push(row)
      row = []
      used = 0
    }
    row.push(size)
    used = row.length === 1 ? size.w : used + gap + size.w
  }
  if (row.length > 0) rows.push(row)

  const cells: { id: string; dx: number; dy: number }[] = []
  let top = 0
  let contentW = 0
  for (const line of rows) {
    const rowH = Math.max(...line.map((s) => s.h))
    let left = 0
    for (const size of line) {
      cells.push({ id: size.id, dx: Math.round(left), dy: Math.round(top + (rowH - size.h) / 2) })
      left += size.w + gap
    }
    contentW = Math.max(contentW, left - gap)
    top += rowH + gap
  }
  return { cells, rows: rows.length, contentW, contentH: top - gap }
}

/** 一行至少放得下最宽的那个成员——分组的最小宽度由它定，不是写死的数字。
 *  成员比默认框还宽时把下限写死，结果是拖到下限后成员照样戳在框外面。 */
export function widestMember(sizes: readonly { w: number }[]): number {
  return sizes.length === 0 ? 0 : Math.max(...sizes.map((s) => s.w))
}
