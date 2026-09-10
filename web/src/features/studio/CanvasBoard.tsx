/* 无限画布主体（模块 17 · CR-005 §3.1）——自研内核，替代 @xyflow/react。
 *
   结构直译自 Infinite-Canvas `static/canvas.html`：

       .cvc-board            视口层：框选框、切线轨迹、缩略图
         └ .cvc-world        变换层 translate(x,y) scale(s)
             ├ <svg>         连线（四元素：主路径 / 命中区 / 端点 / 断开按钮）
             └ 节点 div

   这里只做「画布是什么」，不做「节点长什么样」——视图组件、卡片外观、
   默认宽度、工具条形态一律查节点注册表（`nodes/`），外壳由
   `canvas-core/NodeShell` 统一提供。

   三处**有意与蓝本不同**：

   1. 节点矩形靠**渲染后实测**而不是查表。蓝本把 w/h 存进节点数据，
      内容一变（图片多了一张、提示词多了一行）连线端点就对不上；
   2. 视口裁剪用世界坐标算，不依赖 ResizeObserver
      （RO 在自动化里一次都不回调，是本仓记录在案的坑）；
   3. 拖动中不每帧写 store：100 节点画布上每帧 setState 会把帧率打到 20 以下，
      改成拖动期间只动 transform，松手才落库。 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'

import {
  Archive,
  Brush,
  Crop,
  Download,
  Eye,
  Grid3x3,
  LayoutGrid,
  Maximize2,
  Minimize2,
  PenLine,
  Rows3,
  Ungroup,
} from '@/components/NexusIcon'

import {
  AlignGuides,
  ConnectionLayer,
  DraftConnection,
  EraseTrail,
  Minimap,
  NodeShell,
  NodeToolButton,
  NORMAL_KEYMAP,
  SMART_KEYMAP,
  alignmentSnap,
  applySelection,
  fitRects,
  rectContains,
  rectsIntersect,
  registerCanvas,
  resetCanvasRegistry,
  resetZoom,
  unionRect,
  zoomByStep,
  useCanvasInput,
  useKeyHeld,
  useSpaceHeld,
} from './canvas-core'
import type { PortSide, Rect, RenderedConnection, SelectMode, SnapGuide } from './canvas-core'
import { RESIZE_HANDLES, WIDTH_RESIZE_HANDLES } from './canvas-core/geometry'
import {
  autoConnectTargetFor,
  bucketConnections,
  groupScopeMap,
  loopInsertionEdges,
  loopInsertionFor,
} from './canvas-core/layout'
import type { LayoutNode } from './canvas-core/layout'
import { FAR_ZOOM, hitAsset } from './CanvasNodes'
import { NODE_PORT_MATRIX, nodeDefinition } from './nodes'
import {
  boxForItems,
  imageAssetIds,
  arrangeGroupMembers,
  connKey,
  dismissCascadeFailure,
  dissolveGroup,
  explodeNode,
  fallbackBox,
  groupMinSize,
  groupSize,
  groupToolbarActions,
  newNodeId,
  retryCascadeFrom,
  resizeGroup,
  syncGroupMembership,
  useCanvasStore,
} from './canvasStore'
import type { EdgeRunState, GroupToolbarAction, ScvNode } from './canvasStore'
import type { CanvasConnection, CanvasViewport } from '../../lib/api-studio'

import './canvas-core/canvas-core.css'

/** 非分组节点的缩放下限。高度不落库，`h` 只是外壳夹矩形时的占位 */
const NODE_MIN_SIZE = { w: 120, h: 80 }

/** 节点工具条能进的模式。与 CanvasEditor 的 action 一一对应 */
export type NodeToolMode = 'crop' | 'mask' | 'outpaint' | 'split' | 'join' | 'resize' | 'annotate'

/** 节点悬浮工具条（需求 §6.7）。按钮顺序与文案对齐蓝本
 *  （`smart-canvas.js:8179` 的 actions 数组）：预览 裁剪 扩图 遮罩 画笔 宫格 下载。
 *
 *  `text` 是按钮上那两个字，`label` 是悬停时的完整说明——蓝本只有前者，
 *  第一次用猜不出「遮罩」和「画笔」的区别（一个给模型看、一个给人看）。 */
const NODE_TOOLS: { mode: NodeToolMode; icon: JSX.Element; text: string; label: string }[] = [
  { mode: 'crop', icon: <Crop />, text: '裁剪', label: '裁剪：拖选框留下想要的部分' },
  { mode: 'outpaint', icon: <Maximize2 />, text: '扩图', label: '扩图：把画布拉大，空出来的部分让模型接着画' },
  { mode: 'mask', icon: <Brush />, text: '遮罩', label: '遮罩重绘：涂白哪块就让模型重画哪块（给模型看的）' },
  { mode: 'annotate', icon: <PenLine />, text: '画笔', label: '画笔：在图上圈点标注（给人看的，不送给模型）' },
  { mode: 'resize', icon: <Minimize2 />, text: '缩放', label: '缩放：按倍数缩小另存（只缩不放，上游没有超分）' },
]

/** 分组小菜单各动作的图标。动作本身（文案、可用判据）住在
 *  `canvasStore.groupToolbarActions` 里，这里只补图标——图标是 JSX，
 *  放进 store 那份纯函数会把它拖进 React 依赖 */
const GROUP_ACTION_ICONS: Record<GroupToolbarAction, JSX.Element> = {
  arrange: <LayoutGrid />,
  preview: <Eye />,
  grid: <Grid3x3 />,
  download: <Archive />,
  ungroup: <Ungroup />,
}

/** 视口外多留这么多世界坐标再裁剪：滚动时提前把节点建出来，
 *  不然快速平移会看到节点一块块「长」出来 */
const CULL_MARGIN = 400

export interface CanvasBoardProps {
  kind: 'classic' | 'smart'
  nodes: ScvNode[]
  connections: CanvasConnection[]
  selectedNodeIds: string[]
  selectedEdgeIds: string[]
  edgeStates: Record<string, EdgeRunState>
  /** 哪些节点在跑。 给节点角上的计时药丸算已跑秒数 */
  running: Record<string, { label: string; startedAt?: number }>
  viewport: CanvasViewport | null
  /** 关掉连线流动动效 */
  animOff?: boolean
  onEditNode?: (id: string) => void
  onOpenNode?: (id: string, assetId?: number) => void
  /** 节点工具条：直接进画布编辑器的某个模式（需求 §6.7） */
  /** 工具条按钮。`assetId` 是当前看的那一张——多图节点不带它就永远只能操作第一张 */
  onNodeTool?: (id: string, mode: NodeToolMode, assetId?: number) => void
  /** 只在已配置即梦图片部署时传入，对齐蓝本的节点原生超分按钮。 */
  onUpscaleNode?: (id: string, assetId?: number) => void
  /** 工具条上的下载：把这个节点的第一张图存到本地 */
  onDownloadNode?: (id: string, assetId?: number) => void
  /** 分组工具条的原图批量下载。 */
  onDownloadGroup?: (id: string) => void
  /** 空白处右键/双击 */
  onBlankMenu?: (world: { x: number; y: number }, screen: { x: number; y: number }) => void
  /** 节点上右键 */
  onNodeMenu?: (
    id: string,
    screen: { x: number; y: number },
    world: { x: number; y: number },
  ) => void
  /** 连线上右键 */
  onEdgeMenu?: (conn: CanvasConnection, screen: { x: number; y: number }) => void
  /** 从端口拖到空白处松手：让页面弹「能接什么」的菜单 */
  onPortDrop?: (fromId: string, side: PortSide, world: { x: number; y: number }, screen: { x: number; y: number }) => void
  /** 覆盖在画布上的东西（工具条、抽屉、提示） */
  children?: ReactNode
}

interface DraftLink {
  fromId: string
  side: PortSide
  /** 跟着指针走的世界坐标 */
  to: { x: number; y: number }
  screen: { x: number; y: number }
  hoverId: string | null
}

export function CanvasBoard({
  kind,
  nodes,
  connections,
  selectedNodeIds,
  selectedEdgeIds,
  edgeStates,
  running,
  viewport,
  animOff,
  onEditNode,
  onOpenNode,
  onNodeTool,
  onUpscaleNode,
  onDownloadNode,
  onDownloadGroup,
  onBlankMenu,
  onNodeMenu,
  onEdgeMenu,
  onPortDrop,
  children,
}: CanvasBoardProps): JSX.Element {
  const worldRef = useRef<HTMLDivElement | null>(null)
  const [vp, setVp] = useState<CanvasViewport>(viewport ?? { x: 0, y: 0, scale: 1 })
  const [draft, setDraft] = useState<DraftLink | null>(null)
  /** 拖动中的实时位移。只放这里不进 store，松手才落库 */
  const [liveMove, setLiveMove] = useState<{ ids: Set<string>; dx: number; dy: number } | null>(null)
  /** 这一帧亮着的对齐参考线。拖动结束就清 */
  const [guides, setGuides] = useState<SnapGuide[]>([])
  /** 最近一次吸附补的位移。松手落库时要把它加回去——
   *  NodeShell 报上来的 x/y 是**指针的原始位置**，不含吸附，
   *  少加这一步就会出现「拖动时看着对齐了、松手又弹回歪的」。 */
  const snapRef = useRef({ dx: 0, dy: 0 })
  const isRDown = useKeyHeld('r')
  const spaceHeld = useSpaceHeld()
  const spaceRef = useRef(spaceHeld)
  spaceRef.current = spaceHeld
  /* 走 ref 而不是直接传布尔：panOverride 进了 useCanvasInput 的 effect 依赖，
     传布尔会让每次按下/松开空格都重绑一整套指针监听 */
  const panOverride = useCallback(() => spaceRef.current, [])

  /* 节点矩形：渲染后实测。查表算不准——同一个图片节点，一张图和九张图的高度差三倍，
     连线端点会挂在半空。实测一次存起来，内容变了自然会重新量。 */
  const [boxes, setBoxes] = useState<Map<string, { w: number; h: number }>>(new Map())
  useLayoutEffect(() => {
    const root = worldRef.current
    if (root === null) return
    let changed = false
    const next = new Map(boxes)
    for (const el of root.querySelectorAll<HTMLElement>('[data-node-id]')) {
      const id = el.dataset.nodeId
      if (id === undefined) continue
      const w = el.offsetWidth
      const h = el.offsetHeight
      // 面板 hidden 时几何量全是 0（本仓既有坑）：量到 0 就别覆盖已有值
      if (w === 0 || h === 0) continue
      const prev = next.get(id)
      if (prev === undefined || prev.w !== w || prev.h !== h) {
        next.set(id, { w, h })
        changed = true
      }
    }
    if (changed) setBoxes(next)
  })

  /** 落库位置上的矩形（**不含**拖动中的实时位移）。
   *  吸附要拿它当基准：拿含位移的去算，吸附出来的补偿会被下一帧再吸一次，越吸越远。 */
  const staticRectOf = useCallback(
    (n: ScvNode): Rect => {
      const measured = boxes.get(n.id)
      const fb = n.type === 'group' ? groupSize(n) : fallbackBox(n)
      return { x: n.x, y: n.y, width: measured?.w ?? fb.w, height: measured?.h ?? fb.h }
    },
    [boxes],
  )

  const rectOf = useCallback(
    (n: ScvNode): Rect => {
      const base = staticRectOf(n)
      const live = liveMove !== null && liveMove.ids.has(n.id) ? liveMove : null
      return { ...base, x: base.x + (live?.dx ?? 0), y: base.y + (live?.dy ?? 0) }
    },
    [staticRectOf, liveMove],
  )

  const rectMap = useMemo(() => {
    const m = new Map<string, Rect>()
    for (const n of nodes) m.set(n.id, rectOf(n))
    return m
  }, [nodes, rectOf])

  const commitViewport = useCallback(() => {
    useCanvasStore.getState().setViewport(vpRef.current)
  }, [])
  const vpRef = useRef(vp)
  vpRef.current = vp

  const applyViewport = useCallback((next: CanvasViewport) => {
    vpRef.current = next
    setVp(next)
  }, [])

  const selectedSet = useMemo(() => new Set(selectedNodeIds), [selectedNodeIds])

  const input = useCanvasInput({
    viewport: vp,
    setViewport: applyViewport,
    keymap: useMemo(
      () => (kind === 'classic' ? NORMAL_KEYMAP() : SMART_KEYMAP(isRDown)),
      [kind, isRDown],
    ),
    scaleBounds: { min: 0.08, max: 4 },
    panOverride,
    onViewportCommit: commitViewport,
    onMarquee: (rect, { append, contain }) => {
      const s = useCanvasStore.getState()
      const hit = nodes.filter((n) => {
        const r = rectMap.get(n.id)
        if (r === undefined) return false
        // Alt 档要求完全框住，默认档碰到就算（判据本身在 geometry 里，两边共用同一份）
        return contain ? rectContains(rect, r) : rectsIntersect(rect, r)
      })
      if (!append) s.selectOnly([])
      for (const n of hit) s.setNodeSelected(n.id, true)
    },
    onErase: (indices) => {
      const s = useCanvasStore.getState()
      const keys = indices.map((i) => connections[i]).filter(Boolean).map(connKey)
      if (keys.length === 0) return
      s.snapshot()
      s.removeConnectionsByKey(keys)
    },
    onBlankClick: () => useCanvasStore.getState().selectOnly([]),
    onBlankMenu,
  })

  /* 视口裁剪：只把看得见的节点放进 DOM。
     100 节点画布实测这是最省的一刀——不渲染就没有 img 解码、没有布局、没有重绘。 */
  const visible = useMemo(() => {
    const scale = vp.scale <= 0 ? 1 : vp.scale
    const view = {
      x: -vp.x / scale - CULL_MARGIN,
      y: -vp.y / scale - CULL_MARGIN,
      w: input.size.width / scale + CULL_MARGIN * 2,
      h: input.size.height / scale + CULL_MARGIN * 2,
    }
    if (input.size.width === 0) return nodes
    return nodes.filter((n) => {
      const r = rectMap.get(n.id)
      if (r === undefined) return true
      return r.x < view.x + view.w && r.x + r.width > view.x && r.y < view.y + view.h && r.y + r.height > view.y
    })
  }, [nodes, rectMap, vp, input.size])

  /* 节点的几何侧面。松手手势和连线分桶都按它算——两处看同一份矩形，
     不会出现「预览说能插、松手又说插不了」 */
  const layoutNodes = useMemo<LayoutNode[]>(
    () =>
      nodes.map((n) => ({
        id: n.id,
        type: n.type,
        rect: rectMap.get(n.id) ?? { x: n.x, y: n.y, width: 0, height: 0 },
        memberIds: n.member_ids,
        history: n.history_for !== undefined,
      })),
    [nodes, rectMap],
  )

  /** 成员 → 分组本体。连线合并与组内边隐藏都按这个作用域判 */
  const scopeOf = useMemo(() => {
    const scope = groupScopeMap(layoutNodes)
    return (id: string): string => scope.get(id) ?? ''
  }, [layoutNodes])

  /* 拖着 loop 悬在某条线的中点上：给那条线上虚线预览，松手就插进去。
     没有这个预览，96px 的判定范围全靠猜——插中了才知道原来可以插。 */
  const insertPreview = useMemo(() => {
    if (liveMove === null || liveMove.ids.size !== 1) return null
    const [only] = [...liveMove.ids]
    const dragged = layoutNodes.find((n) => n.id === only)
    if (only === undefined || dragged?.type !== 'loop') return null
    return loopInsertionFor(only, dragged.rect, connections, layoutNodes)?.index ?? null
  }, [liveMove, layoutNodes, connections])

  const rendered = useMemo<RenderedConnection[]>(() => {
    const buckets = bucketConnections(
      connections.map((c, index) => ({ index, from: c.from, to: c.to, kind: c.kind ?? 'flow' })),
      scopeOf,
    )
    return buckets.map((bucket) => {
      const keys = bucket.indices.map((i) => connKey(connections[i]))
      const states = keys.map((k) => edgeStates[k]).filter((v): v is EdgeRunState => v !== undefined)
      return {
        indices: bucket.indices,
        from: bucket.from,
        to: bucket.to,
        kind: bucket.kind,
        merged: bucket.merged,
        /* 合并线上任意一段在跑，整条就按在跑显示：几条边表达的是同一件事，
           分别取状态会让一条线一半亮一半灰 */
        cascade: states.find((v) => v === 'active') ?? states.find((v) => v === 'wait') ?? states[0],
        selected: keys.some((k) => selectedEdgeIds.includes(k)),
        erasing: bucket.indices.some((i) => input.erasingIndices.includes(i)),
        pending: bucket.targets.some((t) => running[t] !== undefined),
        inserting: insertPreview !== null && bucket.indices.includes(insertPreview),
      }
    })
  }, [connections, edgeStates, selectedEdgeIds, input.erasingIndices, running, scopeOf, insertPreview])

  /* ---------- 当前图 ---------- */

  /** 这个节点现在看的是哪一张。用户点过缩略图就是那张，没点过就是第一张。
   *  工具条长在节点外壳上、不在缩略图里，点它时已经没有落点信息了，只能查这里。 */
  const selectedItem = useCanvasStore((s) => s.selectedItem)
  const currentAsset = (n: ScvNode): number | undefined => {
    /* 只认已入库的**图**（`imageAssetIds`）：这个值会直接当编辑器的起始张，
       挑到一个视频或音频的资产号，弹窗就会去取一张根本不是图的资产。 */
    const ids = imageAssetIds(n)
    if (selectedItem?.nodeId === n.id && ids.includes(selectedItem.assetId)) return selectedItem.assetId
    return ids[0]
  }

  /** 分组小菜单点下去做什么。预览与宫格拼接交给编辑器：预览按组内顺序左右切换，
   *  宫格拼接直接进 join 模式，两者都拿整组的图当切换列表（编辑器读的是节点的 items）。 */
  const runGroupAction = (n: ScvNode, action: GroupToolbarAction): void => {
    if (action === 'arrange') arrangeGroupMembers(n.id)
    else if (action === 'preview') onOpenNode?.(n.id, currentAsset(n))
    else if (action === 'grid') onNodeTool?.(n.id, 'join', currentAsset(n))
    else if (action === 'download') onDownloadGroup?.(n.id)
    else dissolveGroup(n.id)
  }

  /* ---------- 节点默认尺寸 ---------- */

  /** 没存 w 的老节点该多宽。内容驱动尺寸的按自然尺寸装框，其余用注册表的类型默认宽。 */
  const fallbackWidth = (n: ScvNode): number =>
    nodeDefinition(n.type).contentSized ? boxForItems(n.items).w : nodeDefinition(n.type).width

  /* ---------- 节点拖拽 ---------- */

  /** 把分组的成员提示词并进要移动的集合。
   *
   *  分组是「画布中的画布」：图被吸收进 items 跟着框走，而提示词成员是**独立节点**
   *  叠在框上面的。少了这一步，拖走分组框时成员会原地不动被落在后面——
   *  而且拖动中的分组 z-index 会升到成员之上，看起来就是「成员被吃掉了」。
   *  归属本身没坏（松手后 syncGroupMembership 按落点重算），坏的只是位置。 */
  const withMembers = useCallback(
    (ids: Set<string>): Set<string> => {
      const out = new Set(ids)
      for (const nid of ids) {
        const n = nodes.find((v) => v.id === nid)
        if (n?.type !== 'group') continue
        for (const mid of n.member_ids ?? []) out.add(mid)
      }
      return out
    },
    [nodes],
  )

  const onNodeMoveLive = useCallback(
    (id: string, dx: number, dy: number) => {
      // 拖一个选中的节点 = 拖整组选中的节点（和 Figma 一致）
      const ids = withMembers(selectedSet.has(id) ? new Set(selectedSet) : new Set([id]))
      /* 对齐吸附。参与比对的只有**视口内、且没被拖着走**的节点：
         吸到屏幕外看不见的东西上，用户只会觉得节点自己跳了一下。 */
      const moving = unionRect(nodes.filter((n) => ids.has(n.id)).map(staticRectOf))
      if (moving === null) {
        setLiveMove({ ids, dx, dy })
        return
      }
      const snap = alignmentSnap(
        { ...moving, x: moving.x + dx, y: moving.y + dy },
        visible.filter((n) => !ids.has(n.id)).map(staticRectOf),
        { scale: vpRef.current.scale },
      )
      snapRef.current = { dx: snap.dx, dy: snap.dy }
      setLiveMove({ ids, dx: dx + snap.dx, dy: dy + snap.dy })
      setGuides(snap.guides)
    },
    [selectedSet, withMembers, nodes, visible, staticRectOf],
  )

  const onNodeMove = useCallback(
    (id: string, rawX: number, rawY: number, opts: { append: boolean; alt: boolean; altShift: boolean }) => {
      const s = useCanvasStore.getState()
      /* 把吸附补偿加回来。NodeShell 报的是指针原始落点，
         预览时那一点点吸附位移只存在于 liveMove 里，不加就会弹回去 */
      const snap = snapRef.current
      snapRef.current = { dx: 0, dy: 0 }
      setGuides([])
      const x = Math.round(rawX + snap.dx)
      const y = Math.round(rawY + snap.dy)
      /* Alt 拖 = 拖出一个副本，原节点留在原地（Figma / 蓝本同款）。
         Alt+Shift 额外保留指向它的输入连线，方便「同一批参考图再开一条分支」。 */
      if (opts.alt) {
        const src = s.nodes.find((n) => n.id === id)
        if (src === undefined) return
        s.snapshot()
        const copyId = newNodeId()
        const { id: _drop, ...rest } = src
        s.addNode({ ...rest, id: copyId, x, y })
        if (opts.altShift) {
          for (const c of s.connections) {
            if (c.to === id) s.addConnection({ from: c.from, to: copyId, kind: c.kind })
          }
        }
        s.selectOnly([copyId])
        setLiveMove(null)
        return
      }
      const live = liveMove
      s.snapshot()
      const moved: string[] = []
      // 带成员的分组走多节点分支：live.ids 已经由 withMembers 扩过
      if (live !== null && live.ids.size > 1) {
        for (const nid of live.ids) {
          const n = nodes.find((v) => v.id === nid)
          if (n === undefined) continue
          s.moveNode(nid, Math.round(n.x + live.dx), Math.round(n.y + live.dy))
          moved.push(nid)
        }
      } else {
        s.moveNode(id, x, y)
        moved.push(id)
      }
      setLiveMove(null)
      /* 松手才判定分组归属：拖动过程中反复吸收会把画布搅乱（FR-461）。
         这一步不能省——图片拖进分组框靠的就是它。 */
      for (const nid of moved) syncGroupMembership(nid)

      /* 松手手势，分支顺序照抄蓝本 `smart-canvas.js:17925` 的 endDrag：
         先看「loop 压在连线中点上」→ 插进这条链，再看「叠到别的节点上」→ 自动连线。
         多选拖动一概不触发：一次拖一堆节点，谁跟谁连没有直觉可言。 */
      if (moved.length !== 1) return
      const src = nodes.find((v) => v.id === id)
      const size = rectMap.get(id)
      if (src === undefined || size === undefined) return
      const dropped: Rect = { x, y, width: size.width, height: size.height }
      const after = useCanvasStore.getState()
      const dragged = { id, type: src.type, history: src.history_for !== undefined }

      if (src.type === 'loop') {
        const hit = loopInsertionFor(id, dropped, after.connections, layoutNodes)
        if (hit !== null) {
          after.removeConnectionsByKey([connKey(after.connections[hit.index])])
          for (const edge of loopInsertionEdges(hit.edge, id)) after.addConnection(edge)
          return
        }
      }

      /* 落进分组的那一下不再自动连线：拖进框里的意思是「放进去」，
         归属已经由上面的 syncGroupMembership 认下了，再连一条线是两件事叠在一起 */
      const inGroup = after.nodes.some((n) => n.type === 'group' && (n.member_ids ?? []).includes(id))
      if (inGroup) return
      const targetId = autoConnectTargetFor(dragged, dropped, layoutNodes, NODE_PORT_MATRIX, live?.ids)
      if (targetId === null) return
      after.addConnection({ from: id, to: targetId, kind: 'input' })
      /* 连上就把节点放回原处（蓝本 restoreDraggedNodePosition）：
         留在目标上面会把对方整个盖住，看起来像节点被吃掉了 */
      after.moveNode(id, Math.round(src.x), Math.round(src.y))
    },
    [liveMove, nodes, rectMap, layoutNodes],
  )

  /* ---------- 选择 ---------- */

  /** 点节点：裸点只选它、⇧ 加选、⌘/Ctrl 反选。
   *  三档都从同一个入口走，节点和连线的修饰键含义才不会各说各话。 */
  const selectNode = useCallback((id: string, mode: SelectMode) => {
    const s = useCanvasStore.getState()
    // 选节点时连线选择一并清掉：两边都亮着，一按 Delete 会连线也删了
    useCanvasStore.setState({ selectedNodeIds: applySelection(s.selectedNodeIds, [id], mode), selectedEdgeIds: [] })
  }, [])

  /** 点连线：同一套修饰键语义。选中之后 Delete 就能断开它 */
  const selectEdges = useCallback(
    (indices: number[], mode: SelectMode) => {
      const keys = indices.map((i) => connections[i]).filter(Boolean).map(connKey)
      if (keys.length === 0) return
      const s = useCanvasStore.getState()
      useCanvasStore.setState({ selectedNodeIds: [], selectedEdgeIds: applySelection(s.selectedEdgeIds, keys, mode) })
    },
    [connections],
  )

  /* ---------- 连线拖拽 ---------- */

  const onPortDown = useCallback(
    (id: string, side: PortSide, e: ReactPointerEvent) => {
      const world = input.toWorld(e.clientX, e.clientY)
      setDraft({ fromId: id, side, to: world, screen: { x: e.clientX, y: e.clientY }, hoverId: null })
      const move = (ev: PointerEvent): void => {
        setDraft((d) => (d === null ? null : { ...d, to: input.toWorld(ev.clientX, ev.clientY), screen: { x: ev.clientX, y: ev.clientY } }))
      }
      const up = (ev: PointerEvent): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        /* 副作用不能写进 setDraft 的 updater：React 18 会在渲染阶段重跑 updater，
           在里面调 store 的 setState 就是「rendering 期间更新另一个组件」的警告，
           而且严格模式下会跑两次 —— 连线会被加两条。 */
        setDraft(null)
        const target = (ev.target as HTMLElement | null)?.closest('[data-node-id]') as HTMLElement | null
        const toId = target?.dataset.nodeId
        if (toId !== undefined && toId !== id) {
          const s = useCanvasStore.getState()
          s.snapshot()
          // 用户手连的边一律是 input（参考输入）；flow 只由生成自动补（FR-462）
          s.addConnection(side === 'out' ? { from: id, to: toId, kind: 'input' } : { from: toId, to: id, kind: 'input' })
        } else if (onPortDrop !== undefined) {
          onPortDrop(id, side, input.toWorld(ev.clientX, ev.clientY), { x: ev.clientX, y: ev.clientY })
        }
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [input, onPortDrop],
  )

  /* 缩略概览按下前的视口。再按一次要回到这里，而不是随便找个位置 */
  const beforeOverview = useRef<CanvasViewport | null>(null)

  const view = useMemo(
    () => ({
      fit: () => {
        const rects = nodes.map(rectOf)
        if (rects.length === 0 || input.size.width === 0) return
        applyViewport(fitRects(rects, input.size.width, input.size.height))
      },
      /* 放大到选区。上限放到 2 倍而不是 1：选一个小节点按下去还停在 100%
         等于什么也没发生，而「放大到选区」的字面意思就是要看清楚它。
         留白比 fit 大一档（160），选区贴着视口边缘会让人以为还有东西没框进来。 */
      fitSelection: () => {
        const picked = new Set(useCanvasStore.getState().selectedNodeIds)
        const rects = nodes.filter((n) => picked.has(n.id)).map(rectOf)
        if (rects.length === 0 || input.size.width === 0) return false
        applyViewport(fitRects(rects, input.size.width, input.size.height, 160, 2))
        return true
      },
      zoom: (factor: number) => {
        applyViewport(zoomByStep(vpRef.current, input.size, factor, { min: 0.08, max: 4 }))
      },
      reset: () => {
        applyViewport(resetZoom(vpRef.current, input.size))
      },
      toggleOverview: () => {
        const saved = beforeOverview.current
        if (saved !== null) {
          beforeOverview.current = null
          applyViewport(saved)
          return
        }
        const rects = nodes.map(rectOf)
        if (rects.length === 0 || input.size.width === 0) return
        beforeOverview.current = { ...vpRef.current }
        applyViewport(fitRects(rects, input.size.width, input.size.height))
      },
    }),
    [nodes, rectOf, input.size, applyViewport],
  )

  /* 把坐标换算、实测尺寸与视图控制登记出去：右键菜单落点、对齐工具条、
     快捷键都要在事件回调里读，走 context 的话它们会被每帧变化的视口带着重渲染。 */
  useLayoutEffect(() => {
    registerCanvas({ toWorld: input.toWorld, boxes, size: input.size, view, viewport: vp })
    return resetCanvasRegistry
    // vp **必须在依赖里**：少了它，视口平移/缩放之后登记处还是旧值，
    // 跟着节点走的浮条会停在原地不动（实测：平移后节点跑了、条没跟上）。
    // registerCanvas 内部会比对新旧值，只有真的变了才通知订阅者，不会每帧广播。
  }, [input.toWorld, boxes, input.size, view, vp])

  const far = vp.scale < FAR_ZOOM
  /* 放大档位：1 / 2 / 4。只在跨档时变，所以缩放过程中节点的 memo 照常命中。
     向上取整就够——srcset 只升不降，浏览器不会因为缩回去而重新拉小图。 */
  const zoom = Math.min(4, 2 ** Math.max(0, Math.ceil(Math.log2(Math.max(1, vp.scale)))))

  return (
    <div
      ref={input.boardRef}
      className={[
        'cvc-board',
        input.dragMode === 'pan' ? 'cvc-panning' : '',
        input.dragMode === 'erase' ? 'cvc-erasing' : '',
        input.dragMode === 'marquee' ? 'cvc-selecting' : '',
        /* 按住空格：光标整块变抓手，告诉用户这一下拖的是画布不是节点 */
        spaceHeld ? 'cvc-space' : '',
        /* 拖线时全画布端口一起显形：正在找落点，看不见目标端口在哪
           就只能凭感觉往节点上撞 */
        draft !== null ? 'cvc-linking' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div
        ref={worldRef}
        className={selectedNodeIds.length > 1 ? 'cvc-world cvc-multi' : 'cvc-world'}
        style={{ transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.scale})` }}
      >
        <ConnectionLayer
          connections={rendered}
          rects={rectMap}
          reduceMotion={animOff}
          onContextMenu={
            onEdgeMenu === undefined
              ? undefined
              : (indices, screen) => {
                  const c = connections[indices[0] ?? -1]
                  if (c !== undefined) onEdgeMenu(c, screen)
                }
          }
          onSelect={selectEdges}
          onCut={(indices) => {
            // 合并线背后压着好几条边，断就整桶断——只断一条，线还画在那儿
            const keys = indices.map((i) => connections[i]).filter(Boolean).map(connKey)
            if (keys.length === 0) return
            const s = useCanvasStore.getState()
            s.snapshot()
            s.removeConnectionsByKey(keys)
          }}
        />
        {draft !== null && (
          <DraftConnection
            from={rectMap.get(draft.fromId) ?? { x: draft.to.x, y: draft.to.y, width: 1, height: 1 }}
            to={{ x: draft.to.x, y: draft.to.y, width: 1, height: 1 }}
          />
        )}

        {visible.map((n) => {
          const definition = nodeDefinition(n.type)
          const View = definition.View
          const run = running[n.id]
          const live = liveMove !== null && liveMove.ids.has(n.id) ? liveMove : null
          return (
            <NodeShell
              key={n.id}
              id={n.id}
              x={n.x + (live?.dx ?? 0)}
              y={n.y + (live?.dy ?? 0)}
              /* 节点没存 w 时给类型默认值：视频比图片宽一档，
                 光靠 CSS 默认的话拖过一次之后就再也回不到类型默认了 */
              /* 老画布里的节点可能没存 w（默认尺寸是后来才收进 addNode 的）。
                 那时按图的自然尺寸现算，而不是落回一个写死的窄值——
                 否则「新建的节点很大、以前建的还是小的」会显得像 bug。 */
              width={n.type === 'group' ? groupSize(n).w : (n.w ?? fallbackWidth(n))}
              /* 分组的高度也显式给：不给的话外壳高度是 auto，缩放起手量到的是
                 DOM 高度（比 store 里的 h 多出 1px 边框×2），每拖一次就长 2px */
              height={n.type === 'group' ? groupSize(n).h : undefined}
              selected={selectedSet.has(n.id)}
              running={run !== undefined}
              viewport={vp}
              /* 带表单的节点要卡片外观，图片/视频这类是裸媒体——
                 蓝本的画布上图是漂着的，不是一堆白卡片 */
              className={
                definition.cardLike ? `cvc-node-card cvc-node-${n.type}` : `cvc-node-${n.type}`
              }
              onSelect={selectNode}
              onMove={onNodeMove}
              onMoveLive={onNodeMoveLive}
              onDoubleClick={(id, event) => onOpenNode?.(id, hitAsset(event))}
              onContextMenu={(id, screen) => onNodeMenu?.(id, screen, input.toWorld(screen.x, screen.y))}
              onPortDown={onPortDown}
              /* 八向缩放。**分组给全部八个，其它节点只给改宽度的那四个**：
                 分组把 w/h 都落库，八条边都推得动；而图片这类节点只存 w，
                 高度由图的真实比例算出来（`mediaNodeBox`），给 n/s 手柄的话
                 拖了没有任何反应——比不给还糟。 */
              resizeHandles={n.type === 'group' ? RESIZE_HANDLES : WIDTH_RESIZE_HANDLES}
              /* 下限交给外壳夹：夹在回调里的话，宽度顶到下限后 x 还在跟着指针走，
                 节点会一边保持宽度一边横移。分组的下限由「放得下最宽的成员」定。 */
              minSize={n.type === 'group' ? groupMinSize(n) : NODE_MIN_SIZE}
              onResize={
                n.type === 'group'
                  ? (id, rect, handle, first) => {
                      const s = useCanvasStore.getState()
                      if (first) s.snapshot()
                      resizeGroup(id, rect, handle)
                    }
                  : (id, rect, _handle, first) => {
                      const s = useCanvasStore.getState()
                      // 只在第一帧打快照：每帧都打会让一次拖动塞满整个撤销栈，
                      // 而且 ⌘Z 要按几十次才退得回去
                      if (first) s.snapshot()
                      // 高度不落库，所以只有 w 与左边缘拖出来的 x 要写
                      s.updateNode(id, { w: rect.width, x: rect.x })
                    }
              }
              portHint={draft !== null && draft.fromId !== n.id ? (draft.side === 'out' ? 'in' : 'out') : null}
              toolbar={
                /* 只有真拿得到图的节点才给工具条：空节点上放一排灰按钮
                   既占地方又让人以为坏了 */
                definition.toolbar === 'group' ? (
                  /* 五个动作与它们的可用判据由 `groupToolbarActions` 给（蓝本
                     smartGroupToolbarHtml 的直译），这里只负责画和接事件——
                     判据留在纯函数里才测得到 */
                  <>
                    {groupToolbarActions(n).map((action) => (
                      <NodeToolButton
                        key={action.key}
                        icon={GROUP_ACTION_ICONS[action.key]}
                        text={action.text}
                        label={action.label}
                        disabled={!action.enabled}
                        disabledReason={action.disabledReason}
                        onClick={() => runGroupAction(n, action.key)}
                      />
                    ))}
                  </>
                ) : definition.toolbar === 'media' && imageAssetIds(n).length > 0 ? (
                  /* 判据与编辑器打不打得开同源：按「有没有带资产号的 item」显示的话，
                     节点里只有非图素材时这排编辑按钮照样出来，点下去弹窗直接不渲染 */
                  <>
                    <NodeToolButton
                      icon={<Eye />}
                      text="预览"
                      label="预览：滚轮缩放、拖动查看，可与原图对比"
                      onClick={() => onOpenNode?.(n.id)}
                    />
                    {NODE_TOOLS.map((t) => (
                      <NodeToolButton
                        key={t.mode}
                        icon={t.icon}
                        text={t.text}
                        label={t.label}
                        onClick={() => onNodeTool?.(n.id, t.mode, currentAsset(n))}
                      />
                    ))}
                    {onUpscaleNode !== undefined && (
                      <NodeToolButton
                        icon={<Maximize2 />}
                        text="高清放大"
                        label="即梦原生高清放大：使用节点中选定的 2K / 4K / 8K 目标"
                        onClick={() => onUpscaleNode(n.id, currentAsset(n))}
                      />
                    )}
                    {/* 宫格按钮的文案随图片数量变（蓝本同款）：一张只能切，
                        多张才谈得上拼——固定写「切分」会让人以为拼接功能不存在 */}
                    {(() => {
                      const imgs = (n.items ?? []).filter((it) => it.asset_id !== undefined).length
                      const join = imgs > 1
                      return (
                        <NodeToolButton
                          icon={<Grid3x3 />}
                          text={join ? '宫格拼接' : '宫格切分'}
                          label={
                            join
                              ? '宫格拼接：把这个节点里的多张图拼成一张'
                              : '宫格切分：按行列把这张切成多张'
                          }
                          onClick={() => onNodeTool?.(n.id, join ? 'join' : 'split', currentAsset(n))}
                        />
                      )
                    })()}
                    {/* 多图节点才给「摊开」：一次出 8 张时逐张拖出来太慢。
                        摊开后每张一个节点、都连回原节点，血缘不断。 */}
                    {(n.items ?? []).filter((it) => it.asset_id !== undefined).length > 1 && (
                      <NodeToolButton
                        icon={<Rows3 />}
                        text="摊开"
                        label="把这个节点里的图拆成一排独立节点，各自连回本节点"
                        onClick={() => explodeNode(n.id)}
                      />
                    )}
                    <NodeToolButton
                      icon={<Download />}
                      text="下载"
                      label="下载这张图的原图"
                      onClick={() => onDownloadNode?.(n.id, currentAsset(n))}
                    />
                  </>
                ) : undefined
              }
            >
              <View
                data={{
                  node: n,
                  runLabel: run !== undefined ? run.label : null,
                  runStartedAt: run?.startedAt,
                  far,
                  zoom,
                  onEdit: onEditNode,
                  onOpen: onOpenNode,
                }}
              />
              {n.cascade_status === 'failed' && (
                <div className="scv-cascade-failure nodrag nowheel" role="alert">
                  <span title={n.cascade_error}>
                    {n.cascade_error?.trim() || '级联失败'}
                  </span>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      void retryCascadeFrom(n.id)
                    }}
                  >
                    重试
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      dismissCascadeFailure(n.id)
                    }}
                  >
                    停止
                  </button>
                </div>
              )}
            </NodeShell>
          )
        })}

        {/* 参考线画在节点之后：它要压在被拖的节点上面才看得见 */}
        <AlignGuides guides={guides} />
      </div>

      {input.marquee !== null && (
        <div
          className="cvc-marquee"
          style={{
            left: input.marquee.x,
            top: input.marquee.y,
            width: input.marquee.width,
            height: input.marquee.height,
          }}
        />
      )}
      <EraseTrail points={input.eraseTrail} />

      <Minimap
        rects={nodes.map(rectOf)}
        ids={nodes.map((n) => n.id)}
        activeIds={selectedSet}
        viewport={vp}
        size={input.size}
        onJump={(world) => {
          applyViewport({
            ...vpRef.current,
            x: input.size.width / 2 - world.x * vpRef.current.scale,
            y: input.size.height / 2 - world.y * vpRef.current.scale,
          })
        }}
      />

      {children}
    </div>
  )
}
