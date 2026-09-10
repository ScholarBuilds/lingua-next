/* 无限画布的文档态 store 与生成编排（FR-461~464、467~468）。

   文档态（节点/连线/视口）与运行态（生成中的骨架节点）分开：持久化时运行态
   整节点剥掉（BR-143）。持久任务保存分支落点快照，刷新后从任务事件重建运行态，
   产物仍归一到资产库。级联与失败重试都编译成服务端 DAG 执行，浏览器只投影状态、
   合并产物。 */

import { activeSaves, drafts, savedVersions, readCanvasDraft, cacheCanvasDraft, drainCanvas } from './canvasSaveQueue'
import type { SaveSnapshot } from './canvasSaveQueue'
import { connKey, buriedSince, mergeItems, mergeCanvasDocs } from './canvasRemoteMerge'
import { cloneBatch } from './canvasClipboard'
import type { Clip } from './canvasClipboard'
import { FLOW_NODE_ACTIVE, cascadeRunMetadata, cascadeStateFromRun, cascadeRunWaiter } from './canvasRunState'
export { connKey, buriedSince, mergeItems } from './canvasRemoteMerge'
export { cascadeRunWaiter } from './canvasRunState'

import { create } from 'zustand'
import { toast } from 'sonner'

import { AUTO_SIZE } from '@/components/ui/size-picker'

import { ApiImageError, apiImage, jsonBody, request } from '../../lib/api-image'
import { apiConfig } from '../../lib/api-config'
import type { ImageAsset } from '../../lib/api-image'
import { runImageEditTask } from '../../lib/image-edit-task'
import { chime } from '../../lib/chime'
import { normalizeQuality } from '../../lib/image-defaults'
import type { Quality } from '../../lib/image-defaults'
import { apiStudio } from '../../lib/api-studio'
import type {
  CanvasConnection,
  SetPlan,
  CanvasDetail,
  CanvasEventFrame,
  CanvasItem,
  CanvasNode,
  CanvasVideoRunSettings,
  CanvasViewport,
  CanvasWorkflowTimeline,
  ExecutableWorkflowDetail,
  StudioFlowDefinition,
  StudioFlowRun,
  StudioTask,
  VideoMediaReferenceInput,
  VideoReferenceInput,
} from '../../lib/api-studio'
import {
  MEMBER_GAP,
  MEMBER_PAD,
  arrangeByConnections,
  canConnect,
  connectedClusterIds,
  flowMembers,
  freeSpotFor,
  freeSpotsFor,
  readingOrder,
  widestMember,
  wouldCreateCycle,
} from './canvas-core/layout'
import type { ConnectEnd, LayoutNode } from './canvas-core/layout'
import {
  createTombstones,
  forgetEdges,
  forgetNodes,
  rememberEdges,
  rememberNodes,
  clearSettled as clearSettledTombstones,
} from './canvas-tombstones'
import { measuredBox } from './canvas-core/registry'
import { growRectAnchored } from './canvas-core/geometry'
import type { Rect, ResizeHandle } from './canvas-core/geometry'
import {
  EMPTY_NODE_W,
  NODE_PORT_MATRIX,
  defaultNodeWidth,
  findNodeDefinition,
  isCascadeExecutableType,
  runtimeFieldsFor,
  taskTargetNodeType,
} from './nodes'
import type { TaskTargetNodeType } from './nodes'
import { subscribeCanvasEvents, subscribeTaskEvents } from './taskEvents'
import {
  minimaxRunningHubFieldRole,
  prepareCanvasWorkflowRun,
  workflowFieldId,
  workflowFieldMediaKind,
  workflowFields,
} from './canvasWorkflowInputs'
import { workflowTimelineMode } from './WorkflowTimelineEditor'

/** 媒体节点的**视觉框**（蓝本 `singleImageLayout`，smart-canvas.js:1673）。
 *
 *  蓝本不是「宽度恒定」，而是把图等比装进一个 `260×220 × scale` 的框，
 *  scale 默认 2（`MEDIA_NODE_DEFAULT_SCALE`），所以框是 520×440。
 *  这带来一个我方原来没有的性质：**不管什么比例，节点的视觉面积都相当**。
 *
 *  我方原来固定 `w=260` 让高度自己撑，后果是横图只有蓝本的一半宽
 *  （520→260）而竖图比蓝本还高（440→562）——横图看不清、竖图占满屏，
 *  正是「节点默认太小」这条反馈的来源。 */
export const MEDIA_BOX_W = 520
export const MEDIA_BOX_H = 440
/** 装不下自然尺寸时的兜底框（蓝本 `260*scale × 180*scale`） */
const MEDIA_FALLBACK_W = 520
const MEDIA_FALLBACK_H = 360
/** 节点最小边长，太小就点不中了（蓝本 `Math.max(72, ...)`） */
const MEDIA_MIN_EDGE = 72

/** 把一张自然尺寸为 natW×natH 的图等比装进视觉框，返回节点该有多大。
 *  拿不到自然尺寸（还没出图的占位节点）就用兜底框。 */
export function mediaNodeBox(natW?: number, natH?: number): { w: number; h: number } {
  if (natW === undefined || natH === undefined || natW <= 0 || natH <= 0) {
    return { w: MEDIA_FALLBACK_W, h: MEDIA_FALLBACK_H }
  }
  const fit = Math.min(MEDIA_BOX_W / natW, MEDIA_BOX_H / natH)
  return {
    w: Math.max(MEDIA_MIN_EDGE, Math.round(natW * fit)),
    h: Math.max(MEDIA_MIN_EDGE, Math.round(natH * fit)),
  }
}

/** 多图节点的框（蓝本 `pendingBoxSize`，smart-canvas.js:13686）：
 *  按张数选列数，格子边长取 `clamp(基准长边 × 0.42, 96, 220)`。 */
export function mediaGridBox(count: number, natW?: number, natH?: number): { w: number; h: number } {
  const base = mediaNodeBox(natW, natH)
  if (count <= 1) return base
  const aspect = base.w / Math.max(1, base.h)
  const cols = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(count))))
  const rows = Math.ceil(count / cols)
  const cellMax = Math.max(96, Math.min(220, Math.max(base.w, base.h) * 0.42))
  const cellW = base.w >= base.h ? cellMax : Math.max(80, Math.round(cellMax * aspect))
  const cellH = base.w >= base.h ? Math.max(80, Math.round(cellMax / aspect)) : cellMax
  return { w: cols * (cellW + 8) + 16, h: rows * (cellH + 8) + 16 }
}

/** 这个类型的节点默认多宽。老画布里没存 w 的节点由渲染层用它兜底——
 *  少了这一步会出现「新建的循环节点 360、以前建的还是 316」这种不一致。
 *  数值住在节点注册表里（`nodes/<type>.definition.ts`），这里只是转发。 */
export function defaultWidthFor(type: string): number | undefined {
  return defaultNodeWidth(type)
}

/** 建节点时补上默认尺寸。
 *
 *  **收在 addNode 这一个出口**，不在十五个调用点各写一遍：本仓踩过同一个坑
 *  （生图质量的默认值曾以字面量散在十三处，改一次要替换十三处、漏一处不报错）。
 *  调用方仍可显式传 `w` 覆盖——用户拖过缩放手柄的节点走的就是这条路。 */
function withDefaultSize(node: ScvNode): ScvNode {
  if (node.w !== undefined) return node
  const definition = findNodeDefinition(node.type)
  if (definition === undefined) return node
  if (definition.contentSized) {
    const empty = (node.items ?? []).length === 0
    return { ...node, w: empty ? definition.width : boxForItems(node.items).w }
  }
  return { ...node, w: definition.width }
}

/** 从节点的第一张图取自然尺寸，算出它该占多大 */
export function boxForItems(items: CanvasItem[] | undefined): { w: number; h: number } {
  const list = items ?? []
  const first = list[0]
  return mediaGridBox(list.length, first?.w, first?.h)
}

/** @deprecated 用 `mediaNodeBox` / `boxForItems`。仍留着是因为若干处只需要一个
 *  「节点大概多宽」的粗略值（落点计算、分支间距），那些地方不值得去查自然尺寸。 */
export const IMAGE_NODE_W = 360
/** 一次出图最多拆几个并发单张任务。**不是**服务端的单请求张数上限
 *  （`imagegen.MAX_N = 4` 管的是「一次请求要几张」，这里管的是「起几次请求」）。
 *  只防手滑，不是产品级限制。界面上的 `N_MAX` 与它同源。 */
export const GEN_N_MAX = 50

/** 分支输出节点与源节点的水平间距 */
const BRANCH_GAP = 80
/** 参考图上限：自身 > input 上游，超出的丢弃（FR-463） */
/** 一次出图最多带几张参考。
 *
 *  **必须与 `MentionInput` 的插入上限同源**：那边曾经写 20、这边写 10，
 *  于是用户插到第 11 个 @ 芯片起，正文写着「图11」、映射表也写着「图11」，
 *  但那张图**根本没上送**——模型收到的编号与图对不上号，这是正确性问题不是数量问题。 */
export const MAX_REFS = 20
/** ModelScope AIGC 单节点的产出上限与蓝本一致。 */
export const MODELSCOPE_MAX_COUNT = 8
/** ModelScope API 入参层的参考图上限，与 JobBody 同源。 */
export const MODELSCOPE_MAX_REFS = 10
/** Midjourney imagine/edit/blend 参考图上限。 */
export const MIDJOURNEY_MAX_REFS = 4
/** 画布产图一律走「自由出图」这条能力，模型由 `/settings/models` 的绑定决定。
 *
 *  下面五处请求体里的 `alias` 字段装的就是它——那是网关时代留下的线上字段名，
 *  值一直是能力名而不是模型名。字段改名要前后端同步（后端 `images` 路由 +
 *  `api-image.ts` 的类型），见 blockers；在那之前用这个常量把语义写清楚。 */
const IMAGE_FREE_CAPABILITY = 'image-free'

/** 生成轮询间隔与轮数上限：2s × 180 = 6 分钟，超时按失败收尾而不是永远转圈 */
const POLL_MS = 2000
const POLL_MAX = 180
/** 视频允许在上游跑一小时；页面关掉后任务仍由 worker 持续轮询。 */
const VIDEO_POLL_MAX = 1800

/* 轮数与并发的上限（CR-005 §3.5、需求 17 §6.5.2）。
 *
   原先这三个数都以「乘钱」为由收得很紧（20 轮 / 4 并发 / 24 次出图硬拒绝），
   CR-003 已裁定调用成本不再是设计约束，用户也明确要求「并发最多不限制、
   循环的图片不要加限制」。所以产品级限制全部去掉，只留两样东西：

   - 一个**防手滑的物理上限**：输入框打错一个零就发十万个请求，这不是产品限制是事故防护；
   - 一个**超量二次确认**：不拒绝，只是在真的很大时先把数字摆出来让人确认。 */

/** 轮数的物理上限。不是产品限制，是防止输入框里多打一个零 */
export const LOOP_MAX = 999
/** 并发池默认值。可在循环节点上逐个覆盖（蓝本硬编码 6，这里做成可配） */
export const CASCADE_POOL_DEFAULT = 8
/** 并发池的物理上限。超过这个数浏览器自己的连接池先撑不住，再大也不会更快 */
export const CASCADE_POOL_MAX = 64
/** 超过这个出图次数就先要一次确认。不拒绝，只是把数字摆出来 */
export const CASCADE_CONFIRM_GENS = 60

/** 并发模式实际开几个并行槽。
 *
 *  抽成纯函数是为了能单测：这里三个夹逼条件（节点配置 / 默认 / 物理上限 / 轮数）
 *  写错任何一个都不会报错，只会让并发数悄悄退回 1 或者开到几百个，
 *  而这两种都要跑一次真实级联才看得出来。 */
export function cascadePoolSize(configured: number | undefined, totalRounds: number): number {
  const want = Number.isFinite(configured) && (configured ?? 0) > 0 ? (configured as number) : CASCADE_POOL_DEFAULT
  const capped = Math.max(1, Math.min(Math.floor(want), CASCADE_POOL_MAX))
  // 开的槽比轮数多没有意义，多出来的立刻就退出了
  return Math.max(1, Math.min(capped, Math.max(1, totalRounds)))
}
/** 级联里每轮输出节点相对源节点的纵向落位：一轮一行，看得出批次 */
const ROUND_DY = 340
/** 活动边超过这个数就关掉流动动画，几十条边一起跑动画会掉帧 */
export const EDGE_ANIM_MAX = 24
/** 边总数超过这个数也整片关掉动画：dash 动画每帧重绘一条路径，几百条一起跑必掉帧 */
export const EDGE_COUNT_ANIM_MAX = 200

/** 撤销栈上限。每一格是整份 {nodes, connections} 的深拷贝，30 步够覆盖一次连续操作，
    再深就是白占内存 */
export const UNDO_MAX = 30
/** 复制/粘贴的落点偏移：叠在原处会让人以为没生效 */
const PASTE_OFFSET = 24
/** 方向键微移步长。与 react-flow 内建的键盘微移同口径（5px，Shift 放大 4 倍），
    两条路径（焦点在节点上 / 焦点在画布上）手感才一致 */
export const NUDGE_STEP = 5
export const NUDGE_FAST = 4

export { EMPTY_NODE_W }

export function newNodeId(): string {
  return `n${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}

/* ==================== 节点类型（含 loop / group 本地编排字段） ==================== */

export type LoopMode = 'serial' | 'parallel'

export type ScvNodeType = CanvasNode['type'] | 'loop' | 'group'

export interface ScvNode extends Omit<CanvasNode, 'type'> {
  type: ScvNodeType
  /** loop：轮数 1~LOOP_MAX */
  count?: number
  /** loop：串行逐轮 await，并行走并发池 */
  mode?: LoopMode
  /** loop：每轮取一条，占位符《计数》《总数》《进度》 */
  variable_prompts?: string[]
  /** group：组内**还活着**的成员节点 id（提示词成员）。
      图片是被吸收进 items 的，原节点已删除，没有 id 可记 */
  member_ids?: string[]
  /** 成套节点：AI 产出的实施方案。**整份存在节点上**——下次打开接着改，
   *  而不是从头再问一遍。运行参数（轮数/模式/每轮提示词）由它推出来，不是反过来。 */
  set_plan?: SetPlan
  /** 输入框上挂的附件（图、视频、文档…）。
   *
   *  与 `items` 是两回事：`items` 是这个节点的**产出**，附件是喂给它的**输入**。
   *  混在一起的话，用户带一份设计规范 pdf 进来，它就变成节点的一张"图"了。
   *
   *  图片附件同时算参考图（`refAssetIds` 会收），文档附件只在规划时被读文本。
   *  不在这里存文本：单节点有 200KB 上限，一份 pdf 的正文能把整份画布顶爆——
   *  文本由服务端按 id 现抽。 */
  attachments?: CanvasItem[]
  /** 输出槽：这个节点是谁的第几轮产出。
   *
   *  **要持久化**——重跑时靠这两个字段认领已有节点，而不是又建一排新的。
   *  跨会话也生效：昨天跑过的第 3 轮，今天重跑还落在同一个节点上。 */
  slot_of?: string
  slot_round?: number
}

interface UndoSnapshot {
  nodes: ScvNode[]
  connections: CanvasConnection[]
}

export type SaveState = 'idle' | 'saving' | 'saved' | 'merged' | 'error'

/** 连线三态着色（FR-464）：排队 / 正在跑 / 已跑完 */
export type EdgeRunState = 'wait' | 'active' | 'done'

/** 级联的运行态。整块只活在内存，不进 nodes JSONB（BR-143） */
export interface CascadeState {
  /** 起点：链尾图节点，或 loop 节点 */
  startId: string
  loopId: string | null
  mode: LoopMode
  total: number
  /** 已跑完的轮数（含失败收尾的那轮） */
  doneRounds: number
  /** 正在跑的轮次，并行时不止一个 */
  activeRounds: number[]
  /** 当前在跑哪个节点，展示的是真实状态不是编的 */
  nodeLabel: string
  stopRequested: boolean
  /** 服务端持久 DAG 运行 id；提交前的瞬时状态还没有。 */
  runId?: string
}

interface RunEntry {
  label: string
  /** true = 分支骨架节点，落图前不算文档的一部分，保存时整个剥掉 */
  pending: boolean
  /** 持久任务的 id，只放运行态；服务端保存画布时不会接收它。 */
  taskId?: string
  /** 这一次是什么时候开始跑的（`performance.now()`）。
   *  节点角上的计时药丸靠它算已跑秒数——出图动辄十几秒到一分钟，
   *  没有秒数用户分不清「在跑」和「卡住了」。 */
  startedAt: number
}

interface CanvasStore {
  canvasId: number | null
  title: string
  kind: 'classic' | 'smart'
  loaded: boolean
  loadError: string | null
  nodes: ScvNode[]
  connections: CanvasConnection[]
  viewport: CanvasViewport | null
  /** 打开画布那一刻的视口。null = 后端没存过，交给 fitView */
  initialViewport: CanvasViewport | null
  version: number
  /** 多图节点里当前选中的那一张。**运行态，不入库**（BR-143）。
   *  工具条上的裁剪/遮罩/下载据此决定操作哪一张——少了它，
   *  一个 4 图节点点「裁剪」编的永远是 items[0]，用户点第 3 张也没用。 */
  selectedItem: { nodeId: string; assetId: number } | null
  setSelectedItem: (v: { nodeId: string; assetId: number } | null) => void
  running: Record<string, RunEntry>
  cascade: CascadeState | null
  edgeStates: Record<string, EdgeRunState>
  selectedNodeIds: string[]
  selectedEdgeIds: string[]
  saveState: SaveState
  /** 撤销/重做栈（AC-155）。粒度是「用户的一个动作」：一次拖拽、删一批、连一条边、
      编辑器落图、生成落图各算一步 */
  undoStack: UndoSnapshot[]
  redoStack: UndoSnapshot[]

  load: (id: number) => Promise<void>
  reset: () => void
  setTitle: (title: string) => void

  snapshot: () => void
  undoOnce: () => void
  redoOnce: () => void

  addNode: (node: ScvNode) => void
  updateNode: (id: string, patch: Partial<ScvNode>) => void
  moveNode: (id: string, x: number, y: number) => void
  /** 批量落位：对齐、分布、方向键微移共用一条路径 */
  moveNodesTo: (pos: Record<string, { x: number; y: number }>) => void
  removeNodes: (ids: string[]) => void
  addConnection: (conn: CanvasConnection) => void
  removeConnectionsByKey: (keys: string[]) => void
  setViewport: (vp: CanvasViewport) => void
  setNodeSelected: (id: string, selected: boolean) => void
  setEdgeSelected: (key: string, selected: boolean) => void
  /** 整批替换选中集（⌘A 全选、Esc 取消、粘贴后选中副本） */
  selectOnly: (ids: string[]) => void
  stopCascade: () => void
}

/* 连续的批量变更（删节点会同时来一串 node/edge remove）只入一格，
   否则第二格会把第一格盖成"删到一半"的中间态 */
let lastSnapshotAt = 0
/* StrictMode 双挂载下，前一次 load 的响应回来时可能已经 reset 过，按序号丢弃 */
let loadSeq = 0
let canvasTaskEventsUnsubscribe: (() => void) | null = null
let canvasRemoteEventsUnsubscribe: (() => void) | null = null

export const useCanvasStore = create<CanvasStore>()((set, get) => ({
  canvasId: null,
  title: '',
  kind: 'smart',
  loaded: false,
  loadError: null,
  nodes: [],
  connections: [],
  viewport: null,
  initialViewport: null,
  version: 0,
  selectedItem: null,
  setSelectedItem: (v) => set({ selectedItem: v }),
  running: {},
  cascade: null,
  edgeStates: {},
  selectedNodeIds: [],
  selectedEdgeIds: [],
  saveState: 'idle',
  undoStack: [],
  redoStack: [],

  load: async (id) => {
    const seq = ++loadSeq
    canvasTaskEventsUnsubscribe?.()
    canvasTaskEventsUnsubscribe = null
    canvasRemoteEventsUnsubscribe?.()
    canvasRemoteEventsUnsubscribe = null
    activeCanvasTaskIds.clear()
    set({ canvasId: id, loaded: false, loadError: null, saveState: 'idle' })
    try {
      if (activeSaves.has(id)) await activeSaves.get(id)
      const detail = await apiStudio.canvas(id)
      if (seq !== loadSeq) return
      savedVersions.set(id, detail.version)
      const draft = drafts.get(id) ?? readCanvasDraft(id, loadSeq)
      if (draft) drafts.set(id, draft)
      set({
        title: detail.title,
        kind: detail.kind,
        nodes: draft?.doc.nodes ?? detail.nodes,
        connections: draft?.doc.connections ?? detail.connections,
        viewport: draft?.doc.viewport ?? detail.viewport,
        initialViewport: detail.viewport,
        version: detail.version,
        loaded: true,
        running: {},
        cascade: null,
        edgeStates: {},
        selectedNodeIds: [],
        selectedEdgeIds: [],
        undoStack: [],
        redoStack: [],
        saveState: draft ? 'error' : 'idle',
      })
      // 墓碑只对一张画布、一次会话有意义，换画布就整个丢掉
      tombstones = draft?.tombstones ?? createTombstones()
      void recoverCanvasImageTasks(id)
      void recoverCanvasVideoTasks(id)
      void recoverCanvasWorkflowTasks(id)
      void recoverCanvasCascadeRun(id)
      canvasTaskEventsUnsubscribe = subscribeTaskEvents((event) => {
        if (event.canvas_id === id) void syncCanvasTaskEvent(event.task_id, id)
      })
      canvasRemoteEventsUnsubscribe = subscribeRemoteCanvas(id)
    } catch (e) {
      if (seq !== loadSeq) return
      set({ loadError: e instanceof Error ? e.message : '画布加载失败' })
    }
  },

  reset: () => {
    loadSeq += 1
    canvasTaskEventsUnsubscribe?.()
    canvasTaskEventsUnsubscribe = null
    canvasRemoteEventsUnsubscribe?.()
    canvasRemoteEventsUnsubscribe = null
    activeCanvasTaskIds.clear()
    set({
      canvasId: null,
      title: '',
      kind: 'smart',
      loaded: false,
      loadError: null,
      nodes: [],
      connections: [],
      viewport: null,
      initialViewport: null,
      version: 0,
      running: {},
      cascade: null,
      edgeStates: {},
      selectedNodeIds: [],
      selectedEdgeIds: [],
      saveState: 'idle',
      undoStack: [],
      redoStack: [],
    })
  },

  setTitle: (title) => set({ title }),

  snapshot: () => captureUndo(),

  undoOnce: () => {
    const { undoStack, redoStack, nodes, connections, selectedNodeIds } = get()
    if (undoStack.length === 0) return
    const prev = undoStack[undoStack.length - 1]
    const alive = new Set(prev.nodes.map((n) => n.id))
    /* 撤销把删掉的东西带回来了，墓碑必须当场作废——否则下一次合并会再把它抹掉，
       现象是「撤销成功了，过一秒又没了」。 */
    forgetNodes(tombstones, alive)
    forgetEdges(tombstones, prev.connections.map(connKey))
    set({
      nodes: prev.nodes,
      connections: prev.connections,
      undoStack: undoStack.slice(0, -1),
      redoStack: [...redoStack, structuredClone({ nodes, connections })].slice(-UNDO_MAX),
      selectedNodeIds: selectedNodeIds.filter((id) => alive.has(id)),
      selectedEdgeIds: [],
    })
    scheduleSave()
  },

  redoOnce: () => {
    const { undoStack, redoStack, nodes, connections, selectedNodeIds } = get()
    if (redoStack.length === 0) return
    const next = redoStack[redoStack.length - 1]
    const alive = new Set(next.nodes.map((n) => n.id))
    set({
      nodes: next.nodes,
      connections: next.connections,
      // 重做时不清 redoStack：撤销 3 步后可以连着重做 3 步
      undoStack: [...undoStack, structuredClone({ nodes, connections })].slice(-UNDO_MAX),
      redoStack: redoStack.slice(0, -1),
      selectedNodeIds: selectedNodeIds.filter((id) => alive.has(id)),
      selectedEdgeIds: [],
    })
    scheduleSave()
  },

  addNode: (node) => {
    set({ nodes: [...get().nodes, withDefaultSize(node)] })
    scheduleSave()
  },

  updateNode: (id, patch) => {
    set({ nodes: get().nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) })
    scheduleSave()
  },

  moveNode: (id, x, y) => {
    set({ nodes: get().nodes.map((n) => (n.id === id ? { ...n, x, y } : n)) })
    scheduleSave()
  },

  moveNodesTo: (pos) => {
    set({ nodes: get().nodes.map((n) => (pos[n.id] === undefined ? n : { ...n, ...pos[n.id] })) })
    scheduleSave()
  },

  removeNodes: (ids) => {
    const gone = new Set(ids)
    /* 记下墓碑：不记的话合并远端文档时这批会被当成「远端新建的」加回来——
       那就是「删了刷新又回来」。连它们身上的边一起记，否则边也会被并集带回。 */
    const now = Date.now()
    rememberNodes(tombstones, ids, now)
    rememberEdges(
      tombstones,
      get().connections.filter((c) => gone.has(c.from) || gone.has(c.to)).map(connKey),
      now,
    )
    const { nodes, connections, running, selectedNodeIds } = get()
    const nextRunning = { ...running }
    for (const id of ids) delete nextRunning[id]
    set({
      nodes: nodes
        .filter((n) => !gone.has(n.id))
        // 分组成员被删时同步摘掉引用，别留一个指不到人的 id
        .map((n) =>
          n.type === 'group' && (n.member_ids ?? []).some((mid) => gone.has(mid))
            ? { ...n, member_ids: (n.member_ids ?? []).filter((mid) => !gone.has(mid)) }
            : n,
        ),
      connections: connections.filter((c) => !gone.has(c.from) && !gone.has(c.to)),
      running: nextRunning,
      selectedNodeIds: selectedNodeIds.filter((id) => !gone.has(id)),
    })
    scheduleSave()
  },

  addConnection: (conn) => {
    const { connections, nodes } = get()
    const key = connKey(conn)
    if (conn.from === conn.to) return
    if (connections.some((c) => connKey(c) === key)) return
    /* 悬空边挡在入口：删节点和删连线是两条路径，漏一条就在画布上留下
       从空气连到空气的线，级联还会把它当成真上游去取图（FR-462）。 */
    const from = nodes.find((n) => n.id === conn.from)
    const to = nodes.find((n) => n.id === conn.to)
    if (from === undefined || to === undefined) return
    const kind = conn.kind ?? 'flow'
    const end = (n: ScvNode): ConnectEnd => ({ id: n.id, type: n.type, history: n.history_for !== undefined })
    // 端口矩阵说了算：谁能连到谁由节点「送什么/收什么」推出来，不写死类型对
    if (!canConnect(end(from), end(to), kind, NODE_PORT_MATRIX)) return
    /* 环检测：加上这条边之后能从下游走回上游的话，级联会绕着跑不完。
       只拦新边——老画布里已经存在的环照旧读出来，不然旧文档会打不开。 */
    if (kind !== 'history' && wouldCreateCycle(conn.from, conn.to, connections)) return
    set({ connections: [...connections, conn] })
    scheduleSave()
  },

  removeConnectionsByKey: (keys) => {
    const gone = new Set(keys)
    rememberEdges(tombstones, keys, Date.now())
    set({
      connections: get().connections.filter((c) => !gone.has(connKey(c))),
      selectedEdgeIds: get().selectedEdgeIds.filter((k) => !gone.has(k)),
    })
    scheduleSave()
  },

  setViewport: (vp) => {
    set({ viewport: vp })
    scheduleSave()
  },

  setNodeSelected: (id, selected) => {
    const cur = get().selectedNodeIds
    set({
      selectedNodeIds: selected ? [...cur.filter((x) => x !== id), id] : cur.filter((x) => x !== id),
    })
  },

  setEdgeSelected: (key, selected) => {
    const cur = get().selectedEdgeIds
    set({
      selectedEdgeIds: selected ? [...cur.filter((x) => x !== key), key] : cur.filter((x) => x !== key),
    })
  },

  selectOnly: (ids) => set({ selectedNodeIds: ids, selectedEdgeIds: [] }),

  /** 停止后由服务端禁止继续调度；已提交任务仍收尾，产物全部保留。 */
  stopCascade: () => {
    const c = get().cascade
    if (c === null || c.stopRequested) return
    set({ cascade: { ...c, stopRequested: true } })
    if (c.runId !== undefined) {
      void apiStudio.cancelFlowRun(c.runId).catch((error) => {
        toast.error(`停止画布执行失败：${errText(error)}`)
        const latest = get().cascade
        if (latest !== null && latest.runId === c.runId) {
          set({ cascade: { ...latest, stopRequested: false } })
        }
      })
    }
  },
}))

/* ==================== 撤销栈（AC-155） ====================

   一格 = 用户的一个动作。判定靠两条：
   - 调用点自己在动手前 `snapshot()`（拖拽起手、删除、连线、编辑器落图）；
   - 80ms 内的连续调用合成一格，接住 react-flow 把一次删除拆成 node/edge 两批派发。 */

function takeDoc(): UndoSnapshot {
  const { nodes, connections } = useCanvasStore.getState()
  return structuredClone({ nodes, connections })
}

function pushUndo(snap: UndoSnapshot): void {
  lastSnapshotAt = Date.now()
  const next = [...useCanvasStore.getState().undoStack, snap]
  // 超上限丢最旧的：撤销栈是「最近做了什么」，不是全量历史
  if (next.length > UNDO_MAX) next.splice(0, next.length - UNDO_MAX)
  // 新动作一来，之前撤销出来的那条重做分支就作废（编辑器通用语义）
  useCanvasStore.setState({ undoStack: next, redoStack: [] })
}

function captureUndo(coalesce = true): void {
  if (coalesce && Date.now() - lastSnapshotAt < 80) return
  pushUndo(takeDoc())
}

/** 生成落图前入栈：撤销要能把新出的图从画布上拿掉（图本身留在资产库里，不受影响）。
 *
 *  快照取的是**落图这一刻**的文档，再把分支骨架节点整个剥掉。不在发起生成时取样，
 *  是因为一次出图要几十秒，中途用户挪过的节点不该被这次撤销一起带回去；
 *  失败回滚的那条路径压根不会走到这里，白跑一趟也就不会在栈里留一格空操作。 */
function undoBeforeLanding(skipId: string | null): void {
  const { nodes, connections } = useCanvasStore.getState()
  const kept = skipId === null ? nodes : nodes.filter((n) => n.id !== skipId)
  const alive = new Set(kept.map((n) => n.id))
  pushUndo(
    structuredClone({
      nodes: kept,
      connections: connections.filter((c) => alive.has(c.from) && alive.has(c.to)),
    }),
  )
}

/** 级联整条链算用户的一个动作，所以只在**第一次**落图时入栈：
    撤销一次把整条链这一趟的产出全部拿掉，而不是一轮一轮往回退 */
function armLandingUndo(): (skipId: string | null) => void {
  let fired = false
  return (skipId) => {
    if (fired) return
    fired = true
    undoBeforeLanding(skipId)
  }
}

/* 方向键连按是一次「微调」，不该在栈里留几十格：600ms 内的连续微移合成一格 */
let nudgeAt = 0

export function snapshotNudge(): void {
  const now = Date.now()
  const fresh = now - nudgeAt > 600
  nudgeAt = now
  if (fresh) captureUndo(false)
}

/* ==================== 复制 / 粘贴 / 再来一份 ====================

   剪贴板只活在会话内存里，不碰系统剪贴板：画布节点不是文本，写进去既要权限，
   又会把用户真正在拷的东西冲掉。 */
let clipboard: Clip | null = null
/** 连按几次粘贴要逐次错开，否则第二次正好盖在第一次上面 */
let pasteRun = 0

/** 返回真正拷进去的节点数，调用方拿它报数 */
export function copyNodes(ids: string[]): number {
  const s = useCanvasStore.getState()
  const picked = new Set(ids)
  const nodes = s.nodes.filter((n) => picked.has(n.id))
  if (nodes.length === 0) return 0
  clipboard = structuredClone({
    nodes,
    // 只带两端都在选区里的边：拷一条悬在半空的边没有意义
    connections: s.connections.filter((c) => picked.has(c.from) && picked.has(c.to)),
  })
  pasteRun = 0
  return nodes.length
}

function landBatch(born: Clip): void {
  captureUndo(false)
  const s = useCanvasStore.getState()
  useCanvasStore.setState({
    nodes: [...s.nodes, ...born.nodes],
    connections: [...s.connections, ...born.connections],
    // 选中副本：接着拖走或再按一次 ⌘D 都是顺手的
    selectedNodeIds: born.nodes.map((n) => n.id),
    selectedEdgeIds: [],
  })
  scheduleSave()
}

export function pasteNodes(): void {
  if (clipboard === null) {
    toast.info('还没有复制过节点')
    return
  }
  pasteRun += 1
  const off = PASTE_OFFSET * pasteRun
  landBatch(cloneBatch(clipboard, off, off, newNodeId))
}

/** ⌘D：就地复制一份并选中副本，不动剪贴板 */
export function duplicateNodes(ids: string[]): void {
  const s = useCanvasStore.getState()
  const picked = new Set(ids)
  const nodes = s.nodes.filter((n) => picked.has(n.id))
  if (nodes.length === 0) return
  const conns = s.connections.filter((c) => picked.has(c.from) && picked.has(c.to))
  landBatch(cloneBatch({ nodes, connections: conns }, PASTE_OFFSET, PASTE_OFFSET, newNodeId))
}

/* ==================== 批量对齐与分布 ==================== */

export type AlignMode = 'left' | 'right' | 'top' | 'bottom' | 'center-x' | 'center-y'
export type SpreadAxis = 'x' | 'y'

export interface NodeBox {
  w: number
  h: number
}

/** react-flow 量不到真实尺寸时的兜底（开了 onlyRenderVisibleElements 之后，
    从没进过视口的节点没有 measured）。数值与 canvas.css 里的宽度一一对应 */
export function fallbackBox(n: ScvNode): NodeBox {
  if (n.type === 'group') return groupSize(n)
  /* 宽度一律走 defaultWidthFor，不在这里另写一份字面量：
     这两行原来写着 240/250，而建节点用的是 316/360——分支落点和对齐
     按窄了 70px 的框去算，结果是新建的分支贴着上一个节点。 */
  if (n.type === 'prompt') return { w: n.w ?? defaultWidthFor('prompt') ?? 316, h: 150 }
  if (n.type === 'llm') return { w: n.w ?? defaultWidthFor('llm') ?? 420, h: 520 }
  if (n.type === 'modelscope') {
    return { w: n.w ?? defaultWidthFor('modelscope') ?? 420, h: 620 }
  }
  if (n.type === 'midjourney') {
    return { w: n.w ?? defaultWidthFor('midjourney') ?? 440, h: 650 }
  }
  if (n.type === 'loop') return { w: n.w ?? defaultWidthFor('loop') ?? 360, h: 232 }
  if (n.type === 'video') return { w: n.w ?? 320, h: 260 }
  if (n.type === 'audio') return { w: n.w ?? 300, h: 126 }
  if (n.type === 'file') return { w: n.w ?? 300, h: 136 }
  if (n.type === 'workflow') return { w: n.w ?? 300, h: 188 }
  if ((n.items ?? []).length === 0) return { w: n.w ?? EMPTY_NODE_W, h: 280 }
  /* 高度走 `boxForItems`，不写 200 这个字面量：图按真实比例装框之后
     （`mediaNodeBox`，最高 440），一张竖图的节点实际有四百多高，
     按 200 去排会让没进过视口的节点排完还叠在一起。裸媒体节点的标题是
     绝对定位的小徽标（canvas.css `.cvc-node:not(.cvc-node-card)` 那条），
     不占布局，所以框高就是媒体区高，不用另加壳的高度。 */
  const box = boxForItems(n.items)
  return { w: n.w ?? box.w, h: box.h }
}

/** 节点**现在**在画布上有多大：量过的用实测值，没进过 DOM 的用兜底算式。
 *
 *  这是全仓「节点多大」的唯一判据——排布、对齐、分组整理必须问同一个人。
 *  各写一份的后果是：一边按实测的 520×440 排，另一边按写死的 360×200 排，
 *  排完看着还是重叠，而两边单看都「对」。
 *
 *  例外是**任务回调里新建节点**那条路径（`occupiedRects` / `freeSpotFor`）：
 *  那时节点还没进过 DOM，实测值一律为空，直接用 `fallbackBox` 更诚实。 */
export function nodeBox(n: ScvNode): NodeBox {
  const m = measuredBox(n.id)
  if (m !== null && m.w > 0 && m.h > 0) return m
  return n.type === 'group' ? groupSize(n) : fallbackBox(n)
}

export function alignNodes(ids: string[], mode: AlignMode, boxOf: (n: ScvNode) => NodeBox): void {
  const picked = useCanvasStore.getState().nodes.filter((n) => ids.includes(n.id))
  if (picked.length < 2) return
  const box = new Map(picked.map((n) => [n.id, boxOf(n)]))
  const w = (n: ScvNode) => box.get(n.id)?.w ?? 0
  const h = (n: ScvNode) => box.get(n.id)?.h ?? 0
  const left = Math.min(...picked.map((n) => n.x))
  const right = Math.max(...picked.map((n) => n.x + w(n)))
  const top = Math.min(...picked.map((n) => n.y))
  const bottom = Math.max(...picked.map((n) => n.y + h(n)))
  const pos: Record<string, { x: number; y: number }> = {}
  for (const n of picked) {
    let { x, y } = n
    if (mode === 'left') x = left
    else if (mode === 'right') x = right - w(n)
    else if (mode === 'center-x') x = (left + right) / 2 - w(n) / 2
    else if (mode === 'top') y = top
    else if (mode === 'bottom') y = bottom - h(n)
    else y = (top + bottom) / 2 - h(n) / 2
    pos[n.id] = { x: Math.round(x), y: Math.round(y) }
  }
  captureUndo(false)
  useCanvasStore.getState().moveNodesTo(pos)
}

/** 等距分布：首尾不动，中间按「边到边的间隙相等」重排。
    不用「中心等距」是因为节点高矮宽窄不一，中心等距看起来反而是歪的 */
export function spreadNodes(ids: string[], axis: SpreadAxis, boxOf: (n: ScvNode) => NodeBox): void {
  const picked = useCanvasStore.getState().nodes.filter((n) => ids.includes(n.id))
  if (picked.length < 3) return
  const box = new Map(picked.map((n) => [n.id, boxOf(n)]))
  const size = (n: ScvNode) => (axis === 'x' ? box.get(n.id)?.w ?? 0 : box.get(n.id)?.h ?? 0)
  const at = (n: ScvNode) => (axis === 'x' ? n.x : n.y)
  const sorted = [...picked].sort((a, b) => at(a) - at(b))
  const last = sorted[sorted.length - 1]
  const span = at(last) + size(last) - at(sorted[0])
  const used = sorted.reduce((sum, n) => sum + size(n), 0)
  const gap = (span - used) / (sorted.length - 1)
  const pos: Record<string, { x: number; y: number }> = {}
  let cur = at(sorted[0])
  for (const n of sorted) {
    pos[n.id] = axis === 'x' ? { x: Math.round(cur), y: n.y } : { x: n.x, y: Math.round(cur) }
    cur += size(n) + gap
  }
  captureUndo(false)
  useCanvasStore.getState().moveNodesTo(pos)
}

/** store 的节点翻成内核认识的矩形。排布、避让、链路整理三处共用一份，
    免得某一处忘了带 memberIds，分组在那条路径上就不再是原子 */
function toLayoutNodes(nodes: ScvNode[], boxOf: (n: ScvNode) => NodeBox): LayoutNode[] {
  return nodes.map((n) => {
    const box = boxOf(n)
    return {
      id: n.id,
      type: n.type,
      rect: { x: n.x, y: n.y, width: box.w, height: box.h },
      memberIds: n.member_ids,
      history: n.history_for !== undefined,
    }
  })
}

/** 按连线深度自动排列：有上下游关系的节点摊成从左到右的列，同列纵向排开。
    分组与它的成员算一个原子，整体平移，不会被拆散。
    蓝本 Infinite-Canvas `static/js/smart-canvas.js:2033` arrangeSmartIdsByConnections */
export function arrangeSelection(ids: string[], boxOf: (n: ScvNode) => NodeBox): void {
  const state = useCanvasStore.getState()
  const placements = arrangeByConnections(ids, toLayoutNodes(state.nodes, boxOf), state.connections)
  if (placements.length === 0) return
  const pos: Record<string, { x: number; y: number }> = {}
  for (const p of placements) pos[p.id] = { x: Math.round(p.x), y: Math.round(p.y) }
  captureUndo(false)
  useCanvasStore.getState().moveNodesTo(pos)
}

/** 归档边不参与链路整理：历史分组是往回指的记录关系，把它拉进来的话
    「整理这条链」会顺手把几十个历史节点也摊到链上，画布反而更乱 */
function clusterEdges(connections: CanvasConnection[]): CanvasConnection[] {
  return connections.filter((c) => (c.kind ?? 'flow') !== 'history')
}

/** 这些节点所在的连线链路合起来是哪些节点（沿非归档边可达，历史节点除外）。
 *
 *  一键整理的按钮拿它判可用性——链路只有它自己时按钮该是灰的。
 *  节点表只翻一次、已经在某条链里的种子直接跳过：这个函数挂在渲染路径上，
 *  按每个种子重新翻一遍全表的话，几百个节点的画布上每次出图都要白算一轮。 */
export function clusterOf(seedIds: string[], boxOf: (n: ScvNode) => NodeBox): string[] {
  const state = useCanvasStore.getState()
  const layoutNodes = toLayoutNodes(
    state.nodes.filter((n) => n.history_for === undefined),
    boxOf,
  )
  const edges = clusterEdges(state.connections)
  const all = new Set<string>()
  for (const seed of seedIds) {
    if (all.has(seed)) continue
    for (const id of connectedClusterIds(seed, layoutNodes, edges)) all.add(id)
  }
  return [...all]
}

/** 一键整理：把这些节点所在的**整条连线链路**排好版。
 *
 *  与 BulkBar 的「只排选中」是同一套排布算法（`arrangeByConnections`），
 *  **区别只在排谁**：那边排的正好是用户框选的那几个，一个不多一个不少；
 *  这边先把选区沿连线扩成整条链再排。所以两者不是重复：
 *  只选中一个节点时那边是灰的（少于两个原子不排），而这边正好接上——
 *  用户点一个节点说「整理一下」，想整理的是这条链，不是那一个孤零零的节点；
 *  反过来只想动手里这几个、不惊动链上其余节点时，用的是那边。
 *
 *  返回实际参与整理的节点数；链路只有它自己时返回 0，什么都不做。 */
export function arrangeCluster(seedIds: string[], boxOf: (n: ScvNode) => NodeBox): number {
  const cluster = clusterOf(seedIds, boxOf)
  if (cluster.length < 2) return 0
  arrangeSelection(cluster, boxOf)
  return cluster.length
}

/* ==================== 新节点落点避让（生成时自动排版） ==================== */

/** 现有节点占住的矩形。生成落点要绕开它们。
 *
 *  尺寸用 `fallbackBox` 而不是实测值：这条路径在**任务回调里**跑，
 *  那时新节点还没进过 DOM，实测值一律为空；而 `fallbackBox` 与
 *  渲染层的宽度表同源，够用来判「这块地方有没有人」。 */
function occupiedRects(ignore?: ReadonlySet<string>): Rect[] {
  return useCanvasStore
    .getState()
    .nodes.filter((n) => ignore === undefined || !ignore.has(n.id))
    .map((n) => {
      const box = n.type === 'group' ? groupSize(n) : fallbackBox(n)
      return { x: n.x, y: n.y, width: box.w, height: box.h }
    })
}

/** 新节点想落在 `desired`，与已有节点相交就就近挪开。
 *
 *  出图（不管并发还是串行）建产出节点一律走这里。少了它，同一个源节点
 *  连点两次「出图」，两个产出节点坐标一模一样，后一张把前一张盖死；
 *  Midjourney 那条更明显——每次操作只往下错 36px，四次产出叠成一摞。 */
export function freeNodeSpot(
  desired: { x: number; y: number; w: number; h: number },
  ignore?: ReadonlySet<string>,
): { x: number; y: number } {
  return freeSpotFor(
    { x: desired.x, y: desired.y, width: desired.w, height: desired.h },
    occupiedRects(ignore),
  )
}

/** 一次落 N 个新节点（并发出图 / 成套出图的槽位）：逐个避让，彼此也不重叠 */
export function freeNodeSpots(
  desired: { x: number; y: number; w: number; h: number }[],
  ignore?: ReadonlySet<string>,
): { x: number; y: number }[] {
  return freeSpotsFor(
    desired.map((d) => ({ x: d.x, y: d.y, width: d.w, height: d.h })),
    occupiedRects(ignore),
  )
}

/** 新建节点的落点：按草稿的类型与内容算出它该多大，再避开已有节点。
 *  调用方只要给「想落在哪」，不用自己去查这种节点多宽多高。 */
export function freeSpotForNode(
  draft: Partial<ScvNode> & { type: ScvNodeType },
  desired: { x: number; y: number },
  ignore?: ReadonlySet<string>,
): { x: number; y: number } {
  const box = fallbackBox({ id: '', x: desired.x, y: desired.y, ...draft })
  return freeNodeSpot({ x: desired.x, y: desired.y, w: box.w, h: box.h }, ignore)
}

/** 本地删掉过的节点与连线。合并远端文档时用它区分「远端新建的」与「我删掉的」——
 *  没有它，删完只要来一帧远端变更就复活（详见 canvas-tombstones.ts）。 */
let tombstones = createTombstones()

/* ==================== 防抖保存与 409 合并（FR-467 / BR-145） ==================== */

let saveTimer: number | null = null

export function scheduleSave(): void {
  const s = useCanvasStore.getState()
  if (s.canvasId === null || !s.loaded) return
  if (saveTimer !== null) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    void saveNow()
  }, 450)
}

export async function flushSave(): Promise<void> {
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer)
    saveTimer = null
  }
  await saveNow()
}

/** 剥掉这个节点的运行态字段（BR-143）。剥哪些由节点注册表按类型声明。
 *
 *  原来只剥骨架节点，`cascade_*` / `mj_last_*` / `completed_task_ids` 跟着节点
 *  JSON 一起落库：服务端不认识这些键，而刷新后它们又会被任务与 FlowRun 的
 *  checkpoint 重新投影一遍——存进去的那份只会是过期副本（按钮点了报"任务不存在"）。 */
export function stripRuntimeFields(node: ScvNode): ScvNode {
  let next: ScvNode | null = null
  for (const key of runtimeFieldsFor(node.type)) {
    if (!(key in node)) continue
    next ??= { ...node }
    delete next[key]
  }
  return next ?? node
}

function docForSave(s: CanvasStore): {
  nodes: ScvNode[]
  connections: CanvasConnection[]
  viewport: CanvasViewport
} {
  // 骨架节点是运行态，剥掉；连着它的边一起剥（BR-143）
  const pending = new Set(
    Object.entries(s.running)
      .filter(([, v]) => v.pending)
      .map(([k]) => k),
  )
  const nodes = s.nodes.filter((n) => !pending.has(n.id)).map(stripRuntimeFields)
  const alive = new Set(nodes.map((n) => n.id))
  return {
    nodes,
    connections: s.connections.filter((c) => alive.has(c.from) && alive.has(c.to)),
    viewport: s.viewport ?? s.initialViewport ?? { x: 0, y: 0, scale: 1 },
  }
}

/** 上送前的类型收口：loop / group 是 FR-461 定义的节点类型，契约里还没登记，
    这里按文档原样送（后端 nodes 是自由 JSON）。契约补齐后这个转换可以删 */
function nodesForWire(nodes: ScvNode[]): CanvasNode[] {
  return nodes as unknown as CanvasNode[]
}

async function saveNow(): Promise<void> {
  const s = useCanvasStore.getState()
  if (s.canvasId === null || !s.loaded) return
  const canvasId = s.canvasId
  drafts.set(canvasId, {
    canvasId, doc: structuredClone(docForSave(s)), version: s.version,
    snapshotAt: Date.now(), generation: loadSeq,
    runningIds: new Set(Object.keys(s.running)),
    tombstones: { nodes: new Map(tombstones.nodes), edges: new Map(tombstones.edges) },
  })
  cacheCanvasDraft(canvasId)
  return drainCanvas(canvasId, persistCanvasSnapshot)
}


async function persistCanvasSnapshot(snapshot: SaveSnapshot): Promise<boolean> {
  const { canvasId, snapshotAt, generation } = snapshot
  const current = () => useCanvasStore.getState().canvasId === canvasId && loadSeq === generation
  const baseVersion = Math.max(snapshot.version, savedVersions.get(canvasId) ?? 0)
  let doc = snapshot.doc
  if (current()) useCanvasStore.setState({ saveState: 'saving' })
  try {
    let res: { version: number }
    let merged = false
    try {
      res = await apiStudio.saveCanvas(canvasId, { ...doc, nodes: nodesForWire(doc.nodes), base_version: baseVersion })
    } catch (error) {
      if (!(error instanceof ApiImageError) || error.status !== 409) throw error
      const remote = await apiStudio.canvas(canvasId)
      rememberNodes(snapshot.tombstones, buriedSince(remote.deleted_nodes, baseVersion), Date.now())
      doc = { ...doc, ...mergeDocs(doc, remote, snapshot.runningIds, snapshot.tombstones) }
      res = await apiStudio.saveCanvas(canvasId, { ...doc, nodes: nodesForWire(doc.nodes), base_version: remote.version })
      merged = true
    }
    savedVersions.set(canvasId, res.version)
    if (current()) {
      clearSettledTombstones(tombstones, snapshotAt)
      lastSavedVersion = res.version
      const unchanged = JSON.stringify(docForSave(useCanvasStore.getState())) === JSON.stringify(snapshot.doc)
      useCanvasStore.setState({ version: res.version, saveState: merged ? 'merged' : 'saved',
        ...(merged && unchanged ? { nodes: doc.nodes, connections: doc.connections } : {}),
      })
    }
    return true
  } catch {
    if (current()) useCanvasStore.setState({ saveState: 'error' })
    toast.error('画布保存失败，草稿已保留', {
      id: `canvas-save-${canvasId}`,
      action: { label: '重试', onClick: () => { void drainCanvas(canvasId, persistCanvasSnapshot) } },
    })
    return false
  }
}

export function mergeDocs(local: { nodes: ScvNode[]; connections: CanvasConnection[] }, remote: CanvasDetail, runningIds: Set<string>, buried = tombstones) {
  return mergeCanvasDocs(local, remote, runningIds, buried)
}


/* ==================== 远端变更接入（SSE canvas 帧，调研 §5.3） ==================== */

/** 最近一次自己保存拿到的版本。服务端每次落库都推一帧 canvas，其中总有一帧是自己这次
    保存触发的——拿它去拉全量再合并是白跑一趟，按版本号认出来直接跳过 */
let lastSavedVersion = 0
/** 拖拽中 / 保存在飞 / 上一帧还在合并时到达的帧。只留版本最高的一帧，等空闲再应用——
    帧本身不带内容，应用时拉的总是最新全量，跳过中间的帧不丢东西 */
let deferredRemoteFrame: CanvasEventFrame | null = null
let remoteApplyActive: Promise<void> | null = null
/** 指针按着 = 用户正在拖节点、拉连线或框选。这时换掉 nodes，松手那一刻按旧引用算的
    落点就错了，先攒着等抬手 */
let pointerHeld = false

function onPointerHeldStart(): void {
  pointerHeld = true
}

function onPointerHeldEnd(): void {
  pointerHeld = false
  void drainRemoteFrame()
}

function resetRemoteCanvasSync(): void {
  lastSavedVersion = 0
  deferredRemoteFrame = null
  pointerHeld = false
}

/** 订阅本画布的 canvas 帧，并盯住指针按下/抬起。
    拖拽态住在 CanvasBoard 的组件 state 里，store 拿不到；按「指针是否按着」判断够用：
    节点拖动、连线拖拽、框选全发生在按下与抬起之间。返回的退订把两样一起拆掉 */
function subscribeRemoteCanvas(canvasId: number): () => void {
  resetRemoteCanvasSync()
  const off = subscribeCanvasEvents((frame) => {
    if (frame.canvas_id === canvasId) applyRemoteCanvas(frame)
  })
  const hasWindow = typeof window !== 'undefined'
  if (hasWindow) {
    window.addEventListener('pointerdown', onPointerHeldStart, true)
    window.addEventListener('pointerup', onPointerHeldEnd, true)
    window.addEventListener('pointercancel', onPointerHeldEnd, true)
    // 拖到窗外松手收不到 pointerup，失焦时当作抬手
    window.addEventListener('blur', onPointerHeldEnd)
  }
  return () => {
    off()
    if (hasWindow) {
      window.removeEventListener('pointerdown', onPointerHeldStart, true)
      window.removeEventListener('pointerup', onPointerHeldEnd, true)
      window.removeEventListener('pointercancel', onPointerHeldEnd, true)
      window.removeEventListener('blur', onPointerHeldEnd)
    }
    resetRemoteCanvasSync()
  }
}

function remoteFrameIsNewer(frame: CanvasEventFrame): boolean {
  const s = useCanvasStore.getState()
  if (s.canvasId !== frame.canvas_id || !s.loaded) return false
  return frame.version > s.version && frame.version !== lastSavedVersion
}

function rememberRemoteFrame(frame: CanvasEventFrame): void {
  if (deferredRemoteFrame === null || frame.version > deferredRemoteFrame.version) {
    deferredRemoteFrame = frame
  }
}

/** 收到本画布的 canvas 帧。版本不比本地新的（含自己刚保存推出来的那帧）直接丢；
    其余拉最新全量，按 409 合并同一套规则并进来（位置本地优先、图片并集、连线并集），
    version 对齐到远端。全程不打断用户、不弹错——拉不到就等下一帧或下次保存的 409 兜底 */
export function applyRemoteCanvas(frame: CanvasEventFrame): void {
  if (!remoteFrameIsNewer(frame)) return
  rememberRemoteFrame(frame)
  void drainRemoteFrame()
}

async function drainRemoteFrame(): Promise<void> {
  if (remoteApplyActive !== null || pointerHeld) return
  const frame = deferredRemoteFrame
  if (frame === null) return
  deferredRemoteFrame = null
  const run = mergeRemoteCanvas(frame)
  remoteApplyActive = run
  try {
    await run
  } finally {
    remoteApplyActive = null
  }
  // 合并期间又到了新帧
  void drainRemoteFrame()
}

async function mergeRemoteCanvas(frame: CanvasEventFrame): Promise<void> {
  // 自己的保存还在飞：等它落地再比版本。这帧多半就是那次保存推出来的，
  // 不等的话会拿旧 base_version 去存、平白撞一次 409
  const active = activeSaves.get(frame.canvas_id)
  if (active) await active
  if (pointerHeld) {
    rememberRemoteFrame(frame)
    return
  }
  if (!remoteFrameIsNewer(frame)) return
  let remote: CanvasDetail
  try {
    remote = await apiStudio.canvas(frame.canvas_id)
  } catch {
    return
  }
  const s = useCanvasStore.getState()
  if (s.canvasId !== frame.canvas_id || !s.loaded || remote.version <= s.version) return
  if (pointerHeld) {
    rememberRemoteFrame(frame)
    return
  }
  // 与 409 那条路同一件事：SSE 帧也会走合并，别人删的同样要先补进墓碑
  rememberNodes(tombstones, buriedSince(remote.deleted_nodes, s.version), Date.now())
  const landedIds = new Set(frame.landed.map((entry) => entry.node_id))
  const before = countItemsIn(s.nodes, landedIds)
  const merged = mergeDocs(
    { nodes: s.nodes, connections: s.connections },
    remote,
    new Set(Object.keys(s.running)),
  )
  useCanvasStore.setState({
    nodes: merged.nodes,
    connections: merged.connections,
    version: remote.version,
  })
  // 本地还攒着没存的改动：base_version 已换成新的，照常保存不会再撞 409
  if (saveTimer !== null || drafts.has(frame.canvas_id)) scheduleSave()
  if (frame.origin !== 'projector') return
  // 浏览器自己已经落过的图这里并不进来（asset 并集去重），只报真正新接回的张数，
  // 免得同一张图提示两遍
  const added = countItemsIn(merged.nodes, landedIds) - before
  if (added <= 0) return
  chime('done')
  toast.success(`已从服务端接回 ${added} 张图`)
}

function countItemsIn(nodes: ScvNode[], ids: Set<string>): number {
  let total = 0
  for (const node of nodes) if (ids.has(node.id)) total += (node.items ?? []).length
  return total
}

/** 这个节点接下来出的图大概是什么比例（宽/高）。给"正在生成"的骨架定形状用。
 *
 *  骨架原来固定 150px 高、跟着节点宽铺满，于是永远是一条 2.8:1 的横杠——
 *  而用户十有八九在出竖版手机页。等图出来节点又跳成竖的，闪一下。
 *  蓝本的骨架是跟着预期比例的，所以从头到尾不跳。
 *
 *  三级判据，与出图时真正生效的规则一一对应：
 *  1. 钉了画幅 → 就是它；
 *  2. 没钉但有图可参考 → 跟随参考（生成条上写的「尺寸跟随参考」就是这条）；
 *  3. 都没有 → 1（方的）。**不猜**：猜横的就是现在这个 bug 的成因。
 */
export function pendingAspect(
  nodes: ScvNode[],
  connections: CanvasConnection[],
  nodeId: string,
): number {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const node = byId.get(nodeId)
  if (node === undefined) return 1

  const pinned = (node.run_settings?.size ?? '').trim()
  if (pinned !== '' && pinned !== 'auto') {
    const [w, h] = pinned.toLowerCase().split('x').map(Number)
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return w / h
  }

  const ratioOf = (n: ScvNode | undefined): number | undefined => {
    for (const it of n?.items ?? []) {
      if (it.w !== undefined && it.h !== undefined && it.w > 0 && it.h > 0) return it.w / it.h
    }
    return undefined
  }
  // 自身的图优先（重生成场景），再沿上游找——与 refAssetIds 同一个口径
  const own = ratioOf(node) ?? ratioOf({ items: node.attachments } as ScvNode)
  if (own !== undefined) return own

  const seen = new Set([nodeId])
  const queue = [nodeId]
  while (queue.length > 0) {
    const cur = queue.shift() as string
    for (const c of connections) {
      if (c.to !== cur || (c.kind ?? 'flow') === 'history') continue
      if (seen.has(c.from)) continue
      seen.add(c.from)
      const up = byId.get(c.from)
      if (up === undefined || up.history_for !== undefined) continue
      const r = ratioOf(up)
      if (r !== undefined) return r
      queue.push(c.from)
    }
  }
  return 1
}

/* ==================== 参考汇总与生成（FR-463 / BR-149） ==================== */

export type ReferenceAssetSource = 'mention' | 'attachment' | 'self' | 'upstream' | 'manual'

/** 参考条中的一张图。保留来源是为了让拖动排序改到真正的数据源，而不是只换 DOM 顺序。 */
export interface ReferenceAssetEntry {
  asset_id: number
  source: ReferenceAssetSource
  source_node_id: string
  item_index: number
  manual: boolean
}

/** 参考汇总：@ 引用、附件、自身产出、上游、手动参考按真实请求顺序去重。
    分组按整组算，history 边不参与；来源信息供 F056 增删排序使用。 */
export function referenceAssetEntries(
  nodes: ScvNode[],
  connections: CanvasConnection[],
  nodeId: string,
): ReferenceAssetEntry[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const out: ReferenceAssetEntry[] = []
  const seenAssets = new Set<number>()
  const push = (
    items: CanvasItem[] | undefined,
    source: ReferenceAssetSource,
    sourceNodeId: string,
  ) => {
    for (const [itemIndex, it] of (items ?? []).entries()) {
      if (it.asset_id === undefined) continue
      if (seenAssets.has(it.asset_id) || out.length >= MAX_REFS) continue
      seenAssets.add(it.asset_id)
      out.push({
        asset_id: it.asset_id,
        source,
        source_node_id: sourceNodeId,
        item_index: itemIndex,
        manual: false,
      })
    }
  }
  const start = byId.get(nodeId)
  if (start === undefined) return out
  // @ 引用优先且保持顺序：映射表里的「图1/图2」就是按这个顺序编的号，
  // 上送顺序一旦和它对不上，模型看到的「图1」就是另一张
  push(
    (start.prompt_draft_refs ?? []).map((reference) => ({
      kind: 'image' as const,
      asset_id: reference.asset_id,
      name: reference.label,
    })),
    'mention',
    nodeId,
  )
  /* 附件里的图排在自身 items 前面：用户刚拖进输入框的那张，意图比节点上
     早就躺着的产出更明确。不收的话「带了张参考图却没起作用」，且无从察觉 */
  push(start.attachments, 'attachment', nodeId)
  push(start.items, 'self', nodeId)
  const seen = new Set([nodeId])
  const queue = [nodeId]
  while (queue.length > 0 && out.length < MAX_REFS) {
    const cur = queue.shift() as string
    for (const c of connections) {
      if (c.to !== cur || (c.kind ?? 'flow') === 'history') continue
      if (seen.has(c.from)) continue
      seen.add(c.from)
      const up = byId.get(c.from)
      if (up === undefined || up.history_for !== undefined) continue
      if (up.type === 'image' || up.type === 'output' || up.type === 'group') {
        push(up.items, 'upstream', up.id)
      }
      queue.push(c.from)
    }
  }
  push(start.manual_references, 'manual', nodeId)
  const manualIds = new Set(
    (start.manual_references ?? [])
      .map((item) => item.asset_id)
      .filter((assetId): assetId is number => assetId !== undefined),
  )
  return out.map((entry) => manualIds.has(entry.asset_id) ? { ...entry, manual: true } : entry)
}

/** 出图使用的 id 顺序与参考条完全同源，拖动后下一次请求立即按新顺序发送。 */
export function refAssetIds(
  nodes: ScvNode[],
  connections: CanvasConnection[],
  nodeId: string,
): number[] {
  return referenceAssetEntries(nodes, connections, nodeId).map((entry) => entry.asset_id)
}

function moveReferenceItem(
  items: CanvasItem[],
  movedAssetId: number,
  targetAssetId: number,
  placement: 'before' | 'after',
): CanvasItem[] | null {
  const from = items.findIndex((item) => item.asset_id === movedAssetId)
  const target = items.findIndex((item) => item.asset_id === targetAssetId)
  if (from < 0 || target < 0 || from === target) return null
  const next = items.slice()
  const [moved] = next.splice(from, 1)
  let insertAt = next.findIndex((item) => item.asset_id === targetAssetId)
  if (insertAt < 0) return null
  if (placement === 'after') insertAt += 1
  next.splice(insertAt, 0, moved)
  return next
}

/** 对齐 Infinite-Canvas 的参考缩略图拖动：
 *  - 同一来源节点内，改那一节点的图片顺序；
 *  - 两个直接上游之间，改输入连线顺序；
 *  - 手动参考只在手动参考集合内排序。
 *  返回 false 表示两张图来自不可直接互换的层级。 */
export function reorderReferenceAssets(
  nodeId: string,
  movedAssetId: number,
  targetAssetId: number,
  placement: 'before' | 'after' = 'before',
): boolean {
  if (movedAssetId === targetAssetId) return false
  const state = useCanvasStore.getState()
  const current = state.nodes.find((node) => node.id === nodeId)
  if (current === undefined) return false
  const entries = referenceAssetEntries(state.nodes, state.connections, nodeId)
  const moved = entries.find((entry) => entry.asset_id === movedAssetId)
  const target = entries.find((entry) => entry.asset_id === targetAssetId)
  if (moved === undefined || target === undefined || moved.source === 'mention' || target.source === 'mention') {
    return false
  }

  let nextNodes: ScvNode[] | null = null
  if (moved.source === target.source && moved.source === 'manual') {
    const next = moveReferenceItem(
      current.manual_references ?? [],
      movedAssetId,
      targetAssetId,
      placement,
    )
    if (next !== null) {
      nextNodes = state.nodes.map((node) => node.id === nodeId ? { ...node, manual_references: next } : node)
    }
  } else if (moved.source === target.source && moved.source === 'attachment') {
    const next = moveReferenceItem(current.attachments ?? [], movedAssetId, targetAssetId, placement)
    if (next !== null) {
      nextNodes = state.nodes.map((node) => node.id === nodeId ? { ...node, attachments: next } : node)
    }
  } else if (moved.source === target.source && moved.source === 'self') {
    const next = moveReferenceItem(current.items ?? [], movedAssetId, targetAssetId, placement)
    if (next !== null) {
      nextNodes = state.nodes.map((node) => node.id === nodeId ? { ...node, items: next } : node)
    }
  } else if (
    moved.source === 'upstream'
    && target.source === 'upstream'
    && moved.source_node_id === target.source_node_id
  ) {
    const source = state.nodes.find((node) => node.id === moved.source_node_id)
    const next = moveReferenceItem(source?.items ?? [], movedAssetId, targetAssetId, placement)
    if (source !== undefined && next !== null) {
      nextNodes = state.nodes.map((node) => node.id === source.id ? { ...node, items: next } : node)
    }
  }
  if (nextNodes !== null) {
    state.snapshot()
    useCanvasStore.setState({ nodes: nextNodes })
    scheduleSave()
    return true
  }

  if (moved.source !== 'upstream' || target.source !== 'upstream') return false
  const directSources = new Set(
    state.connections
      .filter((connection) => connection.to === nodeId && (connection.kind ?? 'flow') !== 'history')
      .map((connection) => connection.from),
  )
  if (!directSources.has(moved.source_node_id) || !directSources.has(target.source_node_id)) return false
  const sourceOrder = Array.from(directSources)
  const from = sourceOrder.indexOf(moved.source_node_id)
  const targetAt = sourceOrder.indexOf(target.source_node_id)
  if (from < 0 || targetAt < 0 || from === targetAt) return false
  const [movedSource] = sourceOrder.splice(from, 1)
  let insertAt = sourceOrder.indexOf(target.source_node_id)
  if (placement === 'after') insertAt += 1
  sourceOrder.splice(insertAt, 0, movedSource)
  const rank = new Map(sourceOrder.map((sourceId, index) => [sourceId, index]))
  const slots: number[] = []
  const relevant: CanvasConnection[] = []
  state.connections.forEach((connection, index) => {
    if (connection.to === nodeId && rank.has(connection.from) && (connection.kind ?? 'flow') !== 'history') {
      slots.push(index)
      relevant.push(connection)
    }
  })
  relevant.sort((a, b) => (rank.get(a.from) ?? 0) - (rank.get(b.from) ?? 0))
  const nextConnections = state.connections.slice()
  slots.forEach((slot, index) => { nextConnections[slot] = relevant[index] })
  state.snapshot()
  useCanvasStore.setState({ connections: nextConnections })
  scheduleSave()
  return true
}

/** MiniMax/工作流用的多模态参考：保留图片、视频和音频的类型与顺序。 */
export function refMediaItems(
  nodes: ScvNode[],
  connections: CanvasConnection[],
  nodeId: string,
): CanvasItem[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const out: CanvasItem[] = []
  const seen = new Set<string>()
  const push = (items?: CanvasItem[]) => {
    for (const item of items ?? []) {
      if (!['image', 'video', 'audio'].includes(item.kind)) continue
      const key = item.asset_id !== undefined
        ? `image:${item.asset_id}`
        : item.media_asset_id !== undefined
          ? `${item.kind}:${item.media_asset_id}`
          : item.url !== undefined && item.url !== ''
            ? `${item.kind}:url:${item.url}`
            : ''
      if (key === '' || seen.has(key) || out.length >= 36) continue
      seen.add(key)
      out.push({ ...item })
    }
  }
  const start = byId.get(nodeId)
  if (start === undefined) return out
  push((start.prompt_draft_refs ?? []).map((reference) => ({
    asset_id: reference.asset_id,
    kind: 'image' as const,
    name: reference.label,
  })))
  push(start.attachments)
  push(start.items)
  const seenNodes = new Set([nodeId])
  const queue = [nodeId]
  while (queue.length > 0 && out.length < 36) {
    const current = queue.shift() as string
    for (const connection of connections) {
      if (connection.to !== current || (connection.kind ?? 'flow') === 'history') continue
      if (seenNodes.has(connection.from)) continue
      seenNodes.add(connection.from)
      const upstream = byId.get(connection.from)
      if (upstream === undefined || upstream.history_for !== undefined) continue
      if (['image', 'video', 'audio', 'output', 'group'].includes(upstream.type)) push(upstream.items)
      queue.push(connection.from)
    }
  }
  push(start.manual_references)
  return out
}

export type CanvasVideoAdapter = 'openai' | 'volcengine' | 'jimeng'
export const VIDEO_MULTIMODAL_MAX_REFS = 9
export const VIDEO_MULTIFRAME_MAX_REFS = 20

/** 把节点的参考模式翻译成供应商真正接收的角色队列。 */
export function videoReferenceInputs(
  assetIds: number[],
  settings: CanvasVideoRunSettings,
  adapter: CanvasVideoAdapter,
): VideoReferenceInput[] {
  const unique = [...new Set(assetIds.filter((id) => Number.isInteger(id) && id > 0))]
  if (adapter === 'openai') {
    return unique.slice(0, 1).map((asset_id) => ({ asset_id, role: 'first_frame' }))
  }
  const mode = settings.reference_mode ?? 'first_frame'
  if (mode === 'multimodal') {
    return unique.slice(0, VIDEO_MULTIMODAL_MAX_REFS).map((asset_id) => ({
      asset_id,
      role: 'reference_image',
    }))
  }
  if (mode === 'multi_frame' && adapter === 'jimeng') {
    return unique.slice(0, VIDEO_MULTIFRAME_MAX_REFS).map((asset_id) => ({
      asset_id,
      role: 'reference_image',
    }))
  }
  if (mode === 'first_last') {
    return unique.slice(0, 2).map((asset_id, index) => ({
      asset_id,
      role: index === 0 ? 'first_frame' : 'last_frame',
    }))
  }
  return unique.slice(0, 1).map((asset_id) => ({ asset_id, role: 'first_frame' }))
}

export function videoMediaReferenceInputs(
  items: CanvasItem[],
  adapter: CanvasVideoAdapter,
): VideoMediaReferenceInput[] {
  if (adapter === 'openai') return []
  const seen = new Set<string>()
  const counts = { video: 0, audio: 0 }
  const out: VideoMediaReferenceInput[] = []
  for (const item of items) {
    if ((item.kind !== 'video' && item.kind !== 'audio') || item.media_asset_id === undefined) continue
    const key = `${item.kind}:${item.media_asset_id}`
    if (seen.has(key) || counts[item.kind] >= 3) continue
    seen.add(key)
    counts[item.kind] += 1
    out.push({ media_asset_id: item.media_asset_id, kind: item.kind })
  }
  return out
}

/** 只下发当前适配器公开协议能承载的参数，避免伪开关。 */
export function videoRequestOptions(
  settings: CanvasVideoRunSettings,
  adapter: CanvasVideoAdapter,
  hasReferences: boolean,
): Record<string, boolean | number> {
  if (adapter === 'openai') return {}
  if (adapter === 'jimeng') {
    return { multimodal: settings.reference_mode === 'multimodal' }
  }
  const seed = settings.seed
  return {
    generate_audio: settings.generate_audio ?? false,
    watermark: settings.watermark ?? false,
    // 方舟公开协议明确不支持「参考图 + 固定机位」。
    camera_fixed: hasReferences ? false : settings.fixed_camera ?? false,
    ...(typeof seed === 'number' && Number.isFinite(seed)
      ? { seed: Math.max(-1, Math.min(Math.round(seed), 2 ** 32 - 1)) }
      : {}),
  }
}

export function normalizedVideoResolution(
  resolution: string | undefined,
  adapter: CanvasVideoAdapter,
  modelId = '',
  referenceMode: CanvasVideoRunSettings['reference_mode'] = 'first_frame',
): string {
  const requested = (resolution ?? '720p').toLowerCase()
  if (adapter !== 'jimeng') return requested
  if (referenceMode === 'multi_frame') {
    return ['720p', '1080p'].includes(requested) ? requested : '720p'
  }
  if (modelId === 'seedance2.0_vip' && ['720p', '1080p', '4k'].includes(requested)) {
    return requested
  }
  return '720p'
}

/** 生成用的完整提示词：直接上游的提示词节点（含分组里的提示词成员）在前，
    节点自己的草稿在后。只取**直接**上游——整条链的文字都拽进来会互相污染 */
/** 循环节点上游的提示词条目，按连线顺序拉平。
 *
 *  蓝本 `smartLoopInputPromptItems`：循环节点自己不产词，但它**中继**上游的提示词，
 *  并按轮次轮换取用。少了这一层，`提示词 → 循环 → 图片` 这条最常见的链上
 *  提示词会**整段消失**——图照出、任务 done、界面一切正常，只是词没了。
 *
 *  上游还是循环时递归穿透，`seen` 防环（蓝本 smartLoopPromptVisiting 同款：
 *  两个循环互连时返回空而不是栈溢出）。 */
export function loopPromptItems(
  nodes: ScvNode[],
  connections: CanvasConnection[],
  loopId: string,
  seen = new Set<string>(),
): string[] {
  if (seen.has(loopId)) return []
  seen.add(loopId)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const out: string[] = []
  for (const c of connections) {
    if (c.to !== loopId || (c.kind ?? 'flow') === 'history') continue
    const from = byId.get(c.from)
    if (from === undefined) continue
    if (from.type === 'loop') {
      out.push(...loopPromptItems(nodes, connections, from.id, seen))
      continue
    }
    if (from.type === 'prompt') {
      const t = (from.text ?? '').trim()
      if (t !== '') out.push(t)
      continue
    }
    if (from.type === 'llm') {
      const t = (from.llm_output ?? '').trim()
      if (t !== '') out.push(t)
      continue
    }
    if (from.type === 'group') {
      for (const mid of from.member_ids ?? []) {
        const m = byId.get(mid)
        if (m?.type !== 'prompt' && m?.type !== 'llm') continue
        const t = (m.type === 'prompt' ? m.text : m.llm_output)?.trim() ?? ''
        if (t !== '') out.push(t)
      }
    }
  }
  return out
}

export function composePrompt(
  nodes: ScvNode[],
  connections: CanvasConnection[],
  nodeId: string,
  /** 遇到上游的循环节点时，这一轮该贡献哪段词。
   *
   *  不传就跳过循环节点——`composePrompt` 本身**没有轮次上下文**，
   *  把上游全部轮次词一股脑拼进去会污染单节点出图（那时用户根本没在跑循环）。
   *  级联运行时由 `roundPrompt` 传进来。 */
  loopContribution?: (loopId: string) => string,
): string {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const parts: string[] = []
  const takeText = (n: ScvNode | undefined) => {
    if (n === undefined) return
    if (n.type === 'loop') {
      const t = loopContribution?.(n.id)?.trim() ?? ''
      if (t !== '') parts.push(t)
      return
    }
    if (n.type === 'prompt') {
      const t = (n.text ?? '').trim()
      if (t !== '') parts.push(t)
      return
    }
    if (n.type === 'llm') {
      const t = (n.llm_output ?? '').trim()
      if (t !== '') parts.push(t)
      return
    }
    if (n.type !== 'group') return
    for (const mid of n.member_ids ?? []) {
      const m = byId.get(mid)
      if (m === undefined || (m.type !== 'prompt' && m.type !== 'llm')) continue
      const t = (m.type === 'prompt' ? m.text : m.llm_output)?.trim() ?? ''
      if (t !== '') parts.push(t)
    }
  }
  for (const c of connections) {
    if (c.to !== nodeId || (c.kind ?? 'flow') === 'history') continue
    takeText(byId.get(c.from))
  }
  const self = byId.get(nodeId)
  const draft = (self?.prompt_draft ?? '').trim()
  if (draft !== '') parts.push(draft)
  const body = [...new Set(parts)].join('\n')
  /* @ 引用要在正文前摆一张「图N：说明」的映射表，模型才知道正文里的「图1」
     指的是上送参考图里的哪一张——只发图不说编号，多图时它只能靠猜（FR-465）。 */
  const refs = self?.prompt_draft_refs ?? []
  if (refs.length === 0 || body === '') return body

  /* **只给真正会上送的那几张编号**。超出 MAX_REFS 的那些不会被发出去，
     却仍写在映射表里的话，模型会拿着一个指不到任何图的「图21」去画。
     超限的引用把正文里的「图N」回写成「@名字」——退化成文字描述，
     至少不会指错；直接删掉的话用户会以为自己没插进去。 */
  const kept = refs.slice(0, MAX_REFS)
  const dropped = refs.slice(MAX_REFS)
  let text = body
  for (let i = 0; i < dropped.length; i += 1) {
    text = text.replaceAll(`图${MAX_REFS + i + 1}`, `@${dropped[i].label}`)
  }
  const table = kept.map((r, i) => `图${i + 1}：${r.label}（asset ${r.asset_id}）`).join('\n')
  return `${table}\n\n用户需求：${text}`
}

/** LLM 节点的直接文字输入。连上游时以连线为准，节点自带输入只做无连线回落。 */
export function llmInputText(
  nodes: ScvNode[],
  connections: CanvasConnection[],
  nodeId: string,
): string {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const parts: string[] = []
  const push = (value: string | undefined): void => {
    const text = (value ?? '').trim()
    if (text !== '' && !parts.includes(text)) parts.push(text)
  }
  const take = (node: ScvNode | undefined): void => {
    if (node?.type === 'prompt') {
      push(node.text)
      return
    }
    if (node?.type === 'llm') {
      push(node.llm_output)
      return
    }
    if (node?.type === 'loop') {
      for (const item of loopPromptItems(nodes, connections, node.id)) push(item)
      return
    }
    if (node?.type !== 'group') return
    for (const memberId of node.member_ids ?? []) take(byId.get(memberId))
  }
  for (const connection of connections) {
    if (connection.to !== nodeId || (connection.kind ?? 'flow') === 'history') continue
    take(byId.get(connection.from))
  }
  return parts.join('\n')
}

/** 轮次占位符替换（FR-461）。整条提示词都替，草稿里写《计数》一样生效 */
export function applyRoundVars(text: string, round: number, total: number): string {
  return text
    .replaceAll('《计数》', String(round))
    .replaceAll('《总数》', String(total))
    .replaceAll('《进度》', `${round}/${total}`)
}

/** 循环的轮次编排：每一轮的编号、取第几条提示词、取哪几张上游图。
 *
 *  三条规则全部照抄蓝本（`smart-canvas.js:15843~15869` 与 `smartLoopInputImages:13997`），
 *  因为它们两两耦合，改一条就对不上：
 *
 *  1. **步长是 batch 不是 1**：`loopIndex = start + i × batch`。没开逐张喂图时
 *     batch 强制为 1，于是退化成 `start + i`；
 *  2. **《总数》是末轮编号不是轮数**：`end = start + (count-1) × batch`。
 *     起始计数为 1 时两者相等，所以这条只在改了起始计数时显形——
 *     生成一个系列的第 5~7 张时，《进度》该是「5/7」而不是「1/3」；
 *  3. **取图不回绕**：`refs.slice(loopIndex-1, loopIndex-1+batch)`，越界就是取不到，
 *     不绕回开头。绕回去会让最后几轮悄悄重复前面的图。
 *
 *  `loop-preview.test.ts` 把这三条钉住，`runCascade` 与配置弹窗共用它——
 *  预演与运行时同源是这个函数存在的全部意义。 */
export interface LoopSchedule {
  /** 每一轮的编号，也就是《计数》会被替换成的数 */
  index: number
  /** 0 基的轮序，用来取第几条提示词 */
  ordinal: number
  /** 取上游图的区间（1 基、闭开），没开逐张喂图时为 null */
  slice: { from: number; count: number } | null
}

export function loopBatch(loop: Pick<ScvNode, 'image_input' | 'image_batch_size'>): number {
  // 没开逐张喂图时步长恒为 1（蓝本 15845 同款）：否则改了「每轮取几张」
  // 会连《计数》的步进一起改掉，而用户完全没在配图片
  return loop.image_input === true ? Math.max(1, Math.min(loop.image_batch_size ?? 1, 100)) : 1
}

export function loopSchedule(
  loop: Pick<ScvNode, 'count' | 'loop_start' | 'image_input' | 'image_batch_size'>,
): { rounds: LoopSchedule[]; start: number; end: number; batch: number } {
  const count = Math.max(1, Math.min(loop.count ?? 1, LOOP_MAX))
  const start = Math.max(1, loop.loop_start ?? 1)
  const batch = loopBatch(loop)
  const end = start + (count - 1) * batch
  const rounds = Array.from({ length: count }, (_, i) => {
    const index = start + i * batch
    return {
      index,
      ordinal: i,
      slice: loop.image_input === true ? { from: index, count: batch } : null,
    }
  })
  return { rounds, start, end, batch }
}

/** 循环节点每一轮**实际会发什么**。配置弹窗的右栏就是它。
 *
 *  `base` 是上游提示词与节点草稿拼出来的前缀，调用方从 `composePrompt` 取。 */
export interface RoundPreview {
  /** 这一轮的编号（《计数》的值） */
  round: number
  /** 这一轮取的是第几条轮次提示词（1 基）。一条都没有时为 0 */
  fromIndex: number
  /** 替换完占位符的最终提示词 */
  text: string
  /** 这一轮会从上游取哪几张图（1 基序号）。没开逐张喂图、或已越界时为空 */
  imageSlots: number[]
}

export function previewRounds(
  loop: Pick<ScvNode, 'count' | 'loop_start' | 'variable_prompts' | 'image_input' | 'image_batch_size'>,
  opts: { base?: string; limit?: number; upstreamImages?: number } = {},
): RoundPreview[] {
  const { rounds, end } = loopSchedule(loop)
  const vars = (loop.variable_prompts ?? []).filter((v) => v.trim() !== '')
  const base = (opts.base ?? '').trim()
  /* 默认只演前 12 轮：跑 500 轮的循环把 500 张卡片全渲染出来，
     用户既看不完、页面也会卡。剩下的由调用方显示「还有 N 轮同理」。 */
  const limit = Math.max(1, opts.limit ?? 12)
  const upstream = Math.max(0, opts.upstreamImages ?? 0)

  return rounds.slice(0, limit).map((r) => {
    const fromIndex = vars.length > 0 ? (r.ordinal % vars.length) + 1 : 0
    const parts = [base]
    if (vars.length > 0) parts.push(vars[r.ordinal % vars.length].trim())
    const text = applyRoundVars(parts.filter((x) => x !== '').join('\n'), r.index, end)

    const slots: number[] = []
    if (r.slice !== null) {
      // 不回绕：越界就是没有，与蓝本 smartLoopInputImages 的 slice 一致
      for (let k = 0; k < r.slice.count; k += 1) {
        const at = r.slice.from + k
        if (at <= upstream) slots.push(at)
      }
    }
    return { round: r.index, fromIndex, text, imageSlots: slots }
  })
}

function setRunLabel(id: string, label: string): void {
  const r = useCanvasStore.getState().running
  if (!(id in r)) return
  useCanvasStore.setState({ running: { ...r, [id]: { ...r[id], label } } })
}

function markRunning(id: string, label: string, pending: boolean): void {
  const r = useCanvasStore.getState().running
  /* startedAt 只在**这个节点还没在跑**时刷新：重跑同一个节点会多次调
     markRunning 改标签（「生成中 1/4」→「2/4」），那时不该把计时清零。 */
  const startedAt = r[id]?.startedAt ?? performance.now()
  useCanvasStore.setState({ running: { ...r, [id]: { label, pending, startedAt } } })
}

function clearRunning(id: string, taskId?: string): void {
  const r = { ...useCanvasStore.getState().running }
  if (taskId !== undefined && r[id]?.taskId !== taskId) return
  delete r[id]
  useCanvasStore.setState({ running: r })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 有参考：高保真 /images/edit 直引资产（BR-144，不下载再上传）；单张一任务 */
async function editOnce(
  prompt: string,
  refs: number[],
  quality: string,
  context: CanvasTaskContext,
  deploymentId?: number | null,
): Promise<ImageAsset[]> {
  const form = new FormData()
  form.set('prompt', prompt)
  form.set('app_key', 'consistent_edit')
  form.set('alias', IMAGE_FREE_CAPABILITY)
  form.set('quality', quality)
  form.set('n', '1')
  // 逗号分隔资产 id，服务端从存储直读字节；尺寸不传，跟随参考
  form.set('ref_asset_ids', refs.join(','))
  // 血缘挂在第一张参考上（AC-141）
  form.set('parent_id', String(refs[0]))
  return runImageEditTask(form, {
    toolId: 'infinite-canvas',
    sourceRoute: `/studio/canvas/${context.canvasId}`,
    sourceContext: canvasTaskSourceContext(context),
    deploymentId,
  })
}

/** 无参考：走 /images/jobs 老路，2s 轮询到 done/failed */
/** 节点上存的画幅 → 发给服务端的值。空 = 自动。
 *
 *  **必须发 `'auto'` 而不是空串或 null**。空值在服务端一路被 `size or 默认` 吞掉，
 *  回落到 Tunable 的 `1536x608`（那个数当初是给单词卡横幅调的）。实测的后果：
 *  画布上选着「画幅自动」写「出一个移动端 app 的登录页面」，实际发出去的提示词是
 *  `…… Canvas: 1536x608, aspect ratio 2.53:1. Compose for this exact shape.`
 *  模型只能把三个手机屏并排塞进一张超宽 banner——它没有不听话，是我们让它这么画的。
 *
 *  另外，画布这条路**永远走 prompt_override**，而 prompt_override 非空时立意整步跳过。
 *  所以画布上的「自动」不存在"让立意挑比例"这层含义，只可能是"别替我决定"。
 *  老节点存的空串也按这个口径归一，否则它们会一直出超宽图。 */
function sizeParam(size: string | null | undefined): string {
  const value = (size ?? '').trim()
  return value === '' ? AUTO_SIZE : value
}

interface CanvasTaskContext {
  canvasId: number
  nodeId: string
  sourceNodeId?: string
  plannedNode?: ScvNode
  pendingTarget?: boolean
  executionGroupId?: string
}

function canvasTaskSourceContext(context: CanvasTaskContext): Record<string, unknown> {
  return {
    canvas_id: context.canvasId,
    node_id: context.nodeId,
    ...(context.sourceNodeId === undefined ? {} : { source_node_id: context.sourceNodeId }),
    ...(context.plannedNode === undefined
      ? {}
      : { planned_node: structuredClone(context.plannedNode) }),
    ...(context.pendingTarget === undefined ? {} : { pending_target: context.pendingTarget }),
    ...(context.executionGroupId === undefined
      ? {}
      : { execution_group_id: context.executionGroupId }),
  }
}

export interface ModelScopeJobOptions {
  negative_prompt?: string
  seed?: number
  steps?: number
  guidance?: number
  loras?: Record<string, number>
  ref_asset_ids: number[]
}

/** 从节点快照生成稳定请求参数；UI 输入在这里统一收口。 */
export function modelScopeJobOptions(
  node: Pick<
    ScvNode,
    | 'ms_negative_prompt'
    | 'ms_seed'
    | 'ms_steps'
    | 'ms_guidance'
    | 'ms_lora_enabled'
    | 'ms_lora_id'
    | 'ms_lora_strength'
  >,
  referenceAssetIds: number[],
): ModelScopeJobOptions {
  const negative = (node.ms_negative_prompt ?? '').trim()
  const loraId = (node.ms_lora_id ?? '').trim()
  const seed = node.ms_seed
  const steps = node.ms_steps
  const guidance = node.ms_guidance
  const loraStrength = Math.max(0, Math.min(node.ms_lora_strength ?? 0.8, 1))
  return {
    ...(negative === '' ? {} : { negative_prompt: negative }),
    ...(typeof seed === 'number' && Number.isFinite(seed)
      ? { seed: Math.max(0, Math.min(Math.round(seed), 2 ** 31 - 1)) }
      : {}),
    ...(typeof steps === 'number' && Number.isFinite(steps)
      ? { steps: Math.max(1, Math.min(Math.round(steps), 100)) }
      : {}),
    ...(typeof guidance === 'number' && Number.isFinite(guidance)
      ? { guidance: Math.max(1.5, Math.min(guidance, 20)) }
      : {}),
    ...(node.ms_lora_enabled === true && loraId !== ''
      ? { loras: { [loraId]: loraStrength } }
      : {}),
    ref_asset_ids: referenceAssetIds.slice(0, MODELSCOPE_MAX_REFS),
  }
}

async function jobOnce(
  prompt: string,
  /* 收成 Quality 而不是 `string | undefined`：这个参数曾经在两条调用路径上
     一条传归一化后的值、另一条传节点上的原始值，后者没设过质量时下发 null，
     配置中心里改的全局默认在单节点出图这条分支上**静默失效**。
     类型收紧之后，「没传就走全局默认」这件事只可能发生在 normalizeQuality 一处。 */
  quality: Quality,
  size: string | null,
  context?: CanvasTaskContext,
  deploymentId?: number | null,
  modelScopeOptions?: ModelScopeJobOptions,
): Promise<ImageAsset[]> {
  const created = await apiImage.createJob({
    target_key: 'free',
    prompt_override: prompt,
    // 明确不要画风：free 是通用用途，别让 default_style 悄悄套上插画风
    style_key: 'none',
    size,
    tier: '1k',
    quality,
    n: 1,
    alias: IMAGE_FREE_CAPABILITY,
    deployment_id: deploymentId,
    tool_id: 'infinite-canvas',
    source_route: context ? `/studio/canvas/${context.canvasId}` : '/studio/canvas',
    source_context: context ? canvasTaskSourceContext(context) : undefined,
    ...modelScopeOptions,
  })
  for (let i = 0; i < POLL_MAX; i += 1) {
    await sleep(POLL_MS)
    const job = await apiImage.job(created.image_job_id)
    if (job.status === 'done') return job.assets
    if (job.status === 'failed') throw new ApiImageError(500, job.error ?? '出图失败')
  }
  throw new ApiImageError(0, '出图超时：任务仍在后台，稍后可在资产库找到结果')
}

function toItems(assets: ImageAsset[]): CanvasItem[] {
  return assets.map((a) => ({ asset_id: a.id, kind: 'image' as const, w: a.width, h: a.height }))
}

const ACTIVE_TASKS = new Set(['queued', 'submitting', 'running', 'recovering'])
const trackedVideoTasks = new Set<string>()
const trackedWorkflowTasks = new Set<string>()
const activeCanvasTaskIds = new Map<string, Set<string>>()

function canvasTaskKey(canvasId: number, nodeId: string): string {
  return `${canvasId}:${nodeId}`
}

function taskTargetPending(task: StudioTask): boolean {
  return task.source_context?.pending_target === true
}

function setCanvasTaskRunning(
  task: StudioTask,
  canvasId: number,
  nodeId: string,
  label: string,
): void {
  const key = canvasTaskKey(canvasId, nodeId)
  const ids = activeCanvasTaskIds.get(key) ?? new Set<string>()
  ids.add(task.id)
  activeCanvasTaskIds.set(key, ids)
  const state = useCanvasStore.getState()
  if (state.canvasId !== canvasId) return
  const current = state.running[nodeId]
  useCanvasStore.setState({
    running: {
      ...state.running,
      [nodeId]: {
        label: ids.size > 1 ? `${label} · ${ids.size} 个并发任务` : label,
        pending: current?.pending === true || taskTargetPending(task),
        taskId: task.id,
        startedAt: current?.startedAt ?? performance.now(),
      },
    },
  })
}

function finishCanvasTask(taskId: string, canvasId: number, nodeId: string): void {
  const key = canvasTaskKey(canvasId, nodeId)
  const ids = activeCanvasTaskIds.get(key)
  if (ids !== undefined) {
    ids.delete(taskId)
    if (ids.size === 0) activeCanvasTaskIds.delete(key)
  }
  const state = useCanvasStore.getState()
  if (state.canvasId !== canvasId) return
  const current = state.running[nodeId]
  if (ids !== undefined && ids.size > 0) {
    if (current?.taskId === taskId) {
      useCanvasStore.setState({
        running: {
          ...state.running,
          [nodeId]: { ...current, taskId: ids.values().next().value as string },
        },
      })
    }
    return
  }
  if (current?.taskId === undefined || current.taskId === taskId) clearRunning(nodeId)
}

function plannedTaskNode(task: StudioTask, type: TaskTargetNodeType): ScvNode | null {
  const raw = task.source_context?.planned_node
  if (typeof raw !== 'object' || raw === null) return null
  const node = raw as Record<string, unknown>
  if (node.id !== task.node_id || (node.type !== type && node.type !== 'output')) return null
  if (typeof node.x !== 'number' || !Number.isFinite(node.x)) return null
  if (typeof node.y !== 'number' || !Number.isFinite(node.y)) return null
  return structuredClone(node) as unknown as ScvNode
}

/** 分支骨架不写入画布文档；刷新后由任务中的计划快照重建运行态落点。 */
function ensureTaskNode(
  task: StudioTask,
  canvasId: number,
  nodeId: string,
  type: TaskTargetNodeType,
): ScvNode | null {
  const state = useCanvasStore.getState()
  if (state.canvasId !== canvasId) return null
  const existing = state.nodes.find((node) => node.id === nodeId)
  if (existing !== undefined) return existing.type === type || existing.type === 'output' ? existing : null

  let born = plannedTaskNode(task, type)
  const sourceId =
    typeof task.source_context?.source_node_id === 'string'
      ? task.source_context.source_node_id
      : null
  const source = sourceId === null ? undefined : state.nodes.find((node) => node.id === sourceId)
  if (born === null && source !== undefined && (type === 'image' || type === 'video')) {
    const bornType = taskTargetPending(task) ? 'output' : type
    const spot = freeSpotForNode(
      { type: bornType, w: source.w, items: [] },
      {
        x: source.x + (source.w ?? (type === 'image' ? IMAGE_NODE_W : 320)) + BRANCH_GAP,
        y: source.y,
      },
    )
    born = {
      id: nodeId,
      type: bornType,
      x: spot.x,
      y: spot.y,
      w: source.w,
      title: type === 'image' ? '图片输出' : '视频输出',
      prompt_draft: source.prompt_draft,
      prompt_draft_html: source.prompt_draft_html,
      prompt_draft_refs: source.prompt_draft_refs,
      ...(type === 'image'
        ? { run_settings: source.run_settings }
        : { video_settings: source.video_settings }),
      items: [],
    }
  }
  if (born === null) return null
  const nextNode = withDefaultSize(born)
  const connections = [...state.connections]
  if (
    sourceId !== null &&
    state.nodes.some((node) => node.id === sourceId) &&
    !connections.some((connection) => connection.from === sourceId && connection.to === nodeId)
  ) {
    connections.push({ from: sourceId, to: nodeId, kind: 'flow' })
  }
  useCanvasStore.setState({ nodes: [...state.nodes, nextNode], connections })
  return nextNode
}

const syncingCanvasTasks = new Set<string>()

function canvasTaskNodeType(task: StudioTask): TaskTargetNodeType | null {
  return taskTargetNodeType(task.task_type)
}

async function removeFailedPendingTarget(task: StudioTask, canvasId: number, nodeId: string): Promise<void> {
  if (!taskTargetPending(task)) return
  const response = await apiStudio.tasks({ canvas_id: canvasId, node_id: nodeId, limit: 200 })
  if (response.items.some((item) => ACTIVE_TASKS.has(item.status))) return
  const state = useCanvasStore.getState()
  const node = state.nodes.find((item) => item.id === nodeId)
  if (state.canvasId === canvasId && node !== undefined && (node.items ?? []).length === 0) {
    state.removeNodes([nodeId])
  }
}

/** SSE 只携带轻量事件，收到后按 task id 取当前快照，避免进度事件乱序回滚画布。 */
async function syncCanvasTaskEvent(taskId: string, canvasId: number): Promise<void> {
  if (syncingCanvasTasks.has(taskId)) return
  syncingCanvasTasks.add(taskId)
  try {
    const task = await apiStudio.task(taskId)
    if (useCanvasStore.getState().canvasId !== canvasId) return
    if (task.canvas_id !== canvasId || task.node_id === null) return
    const type = canvasTaskNodeType(task)
    if (type === null) return
    const nodeId = task.node_id
    if (ACTIVE_TASKS.has(task.status)) {
      const node = ensureTaskNode(task, canvasId, nodeId, type)
      if (node === null) return
      const label =
        type === 'image'
          ? imageTaskLabel(task)
          : type === 'video'
            ? videoTaskLabel(task)
            : workflowTaskLabel(task)
      setCanvasTaskRunning(task, canvasId, nodeId, label)
      return
    }
    finishCanvasTask(task.id, canvasId, nodeId)
    if (task.status === 'succeeded' || task.status === 'partial') {
      const node = ensureTaskNode(task, canvasId, nodeId, type)
      if (node === null) return
      if (type === 'image') {
        updateMidjourneySource(task, canvasId)
        if (task.result?.modal_required === true) {
          removeEmptyMidjourneyTarget(task, canvasId, nodeId)
        } else {
          landImageTask(task, canvasId, nodeId)
        }
      }
      else if (type === 'video') landVideoTask(task, canvasId, nodeId)
      else landWorkflowTask(task, canvasId, nodeId)
    } else {
      await removeFailedPendingTarget(task, canvasId, nodeId)
    }
  } catch {
    // SSE 是加速通道；单次回查失败由现有轮询和下一条事件收敛。
  } finally {
    syncingCanvasTasks.delete(taskId)
  }
}

function videoResultItems(result: Record<string, unknown> | null | undefined): CanvasItem[] {
  const raw = result?.items
  if (!Array.isArray(raw)) return []
  const items: CanvasItem[] = []
  for (const value of raw) {
    if (typeof value !== 'object' || value === null) continue
    const item = value as Record<string, unknown>
    if (item.kind !== 'video' || typeof item.url !== 'string') continue
    const mediaId = Number(item.media_asset_id ?? item.id)
    items.push({
      kind: 'video',
      media_asset_id: Number.isInteger(mediaId) && mediaId > 0 ? mediaId : undefined,
      url: item.url,
      poster_url: typeof item.poster_url === 'string' ? item.poster_url : null,
      name: typeof item.name === 'string' ? item.name : undefined,
      mime: typeof item.mime === 'string' ? item.mime : undefined,
      duration_ms: typeof item.duration_ms === 'number' ? item.duration_ms : null,
      w: typeof item.width === 'number' ? item.width : undefined,
      h: typeof item.height === 'number' ? item.height : undefined,
    })
  }
  return items
}

function videoTaskItems(task: StudioTask): CanvasItem[] {
  return videoResultItems(task.result)
}

function landVideoTask(task: StudioTask, canvasId: number, nodeId: string): boolean {
  const s = useCanvasStore.getState()
  if (s.canvasId !== canvasId) return false
  const node = s.nodes.find((value) => value.id === nodeId)
  if (node === undefined || (node.type !== 'video' && node.type !== 'output')) return false
  const items = videoTaskItems(task)
  if (items.length === 0) return false
  const merged = mergeItems(node.items, items)
  if (merged.length !== (node.items ?? []).length) s.updateNode(nodeId, { items: merged })
  return true
}

function videoTaskLabel(task: StudioTask): string {
  if (task.status === 'queued') return '视频任务排队中'
  if (task.status === 'submitting') return '正在提交视频模型'
  if (task.status === 'recovering') return `恢复视频任务 · ${Math.round(task.progress)}%`
  return `生成视频 · ${Math.round(task.progress)}%`
}

async function trackCanvasVideoTask(
  taskId: string,
  canvasId: number,
  nodeId: string,
  removeEmptyOnFailure: boolean,
): Promise<void> {
  if (trackedVideoTasks.has(taskId)) return
  trackedVideoTasks.add(taskId)
  try {
    for (let index = 0; index < VIDEO_POLL_MAX; index += 1) {
      const task = await apiStudio.task(taskId)
      const s = useCanvasStore.getState()
      if (s.canvasId !== canvasId) {
        finishCanvasTask(taskId, canvasId, nodeId)
        return
      }
      if (ACTIVE_TASKS.has(task.status)) {
        setCanvasTaskRunning(task, canvasId, nodeId, videoTaskLabel(task))
        await sleep(POLL_MS)
        continue
      }
      finishCanvasTask(taskId, canvasId, nodeId)
      if (task.status === 'succeeded' || task.status === 'partial') {
        if (landVideoTask(task, canvasId, nodeId)) toast.success('视频已生成并接回画布')
        else toast.info('视频任务已完成，产物可在任务中心查看')
      } else {
        if (removeEmptyOnFailure) {
          const current = useCanvasStore.getState().nodes.find((node) => node.id === nodeId)
          if (current?.type === 'video' && (current.items ?? []).length === 0) {
            useCanvasStore.getState().removeNodes([nodeId])
          }
        }
        toast.error(task.error ?? '视频生成失败')
      }
      return
    }
    finishCanvasTask(taskId, canvasId, nodeId)
    toast.info('视频仍在后台生成，可稍后从任务中心或重新打开画布查看')
  } catch (error) {
    finishCanvasTask(taskId, canvasId, nodeId)
    toast.error(`视频任务状态读取失败：${errText(error)}`)
  } finally {
    trackedVideoTasks.delete(taskId)
  }
}

async function recoverCanvasVideoTasks(canvasId: number): Promise<void> {
  try {
    const response = await apiStudio.tasks({
      tool_id: 'infinite-canvas',
      canvas_id: canvasId,
      limit: 200,
    })
    if (useCanvasStore.getState().canvasId !== canvasId) return
    for (const task of response.items) {
      if (task.task_type !== 'video.generate') continue
      if (task.canvas_id !== canvasId || task.node_id === null) continue
      if (!ACTIVE_TASKS.has(task.status) && task.status !== 'succeeded' && task.status !== 'partial') {
        continue
      }
      const nodeId = task.node_id
      const node = ensureTaskNode(task, canvasId, nodeId, 'video')
      if (node?.type !== 'video') continue
      if (ACTIVE_TASKS.has(task.status)) {
        setCanvasTaskRunning(task, canvasId, nodeId, videoTaskLabel(task))
        void trackCanvasVideoTask(task.id, canvasId, nodeId, false)
      } else if (task.status === 'succeeded' || task.status === 'partial') {
        landVideoTask(task, canvasId, nodeId)
      }
    }
  } catch (error) {
    toast.error(`画布视频任务恢复失败：${errText(error)}`)
  }
}

/* ==================== 图片任务的恢复（跨刷新、跨关弹窗） ====================

   视频与工作流早就有恢复了，图片没有——`generateFrom` 与编辑器里的重绘/扩图
   都是前台 `await`，画布一切走就只弹一句 toast，刷新页面后 `running` 被清空，
   没有任何一处再去查这些任务。

   后果有两个，用户都会当成「图丢了」：
   - 在编辑器里点了重绘，关掉弹窗 → 画布上什么也看不到，图跑完也不会自己回来；
   - 出图中途刷新 → 转圈没了，图在服务端跑完了却永远落不回画布。

   恢复所需的信息其实一直都在：任务的 `source_context` 带着 canvas_id 与 node_id，
   `result.asset_ids` 带着产物。这一段只是把它们捞回来。 */

const trackedImageTasks = new Set<string>()

/** 图片任务的产物 → 画布条目 */
function imageResultItems(result: Record<string, unknown> | null | undefined): CanvasItem[] {
  const raw = result?.asset_ids
  if (!Array.isArray(raw)) return []
  const out: CanvasItem[] = []
  for (const value of raw) {
    const id = Number(value)
    if (!Number.isInteger(id) || id <= 0) continue
    out.push({ asset_id: id, kind: 'image' })
  }
  return out
}

function imageTaskItems(task: StudioTask): CanvasItem[] {
  return imageResultItems(task.result)
}

function imageTaskLabel(task: StudioTask): string {
  if (task.status === 'queued') return '排队中'
  if (task.status === 'recovering') return '恢复中'
  const stage = typeof task.stage === 'string' && task.stage !== '' ? task.stage : '生成中'
  return stage
}

function updateMidjourneySource(task: StudioTask, canvasId: number): boolean {
  if (!task.task_type.startsWith('midjourney.')) return false
  const sourceId =
    typeof task.source_context?.source_node_id === 'string'
      ? task.source_context.source_node_id
      : null
  if (sourceId === null) return false
  const state = useCanvasStore.getState()
  if (state.canvasId !== canvasId) return false
  const source = state.nodes.find((node) => node.id === sourceId)
  if (source?.type !== 'midjourney') return false
  const result = task.result ?? {}
  const providerTaskId =
    typeof result.provider_task_id === 'string'
      ? result.provider_task_id
      : task.provider_task_id ?? ''
  const action = typeof result.action === 'string'
    ? result.action
    : String(task.invocation?.action ?? task.invocation?.mode ?? '')
  const imageCount = Number(result.image_count ?? 0)
  const rawButtons = Array.isArray(result.buttons) ? result.buttons : []
  const buttons = rawButtons.flatMap((value) => {
    if (typeof value !== 'object' || value === null) return []
    const item = value as Record<string, unknown>
    if (typeof item.custom_id !== 'string') return []
    return [{ custom_id: item.custom_id, label: String(item.label ?? '') }]
  })
  const modalRequired = result.modal_required === true
  state.updateNode(sourceId, {
    mj_last_task_status: modalRequired ? 'modal' : task.status,
    mj_last_action: action,
    mj_last_image_count: Number.isFinite(imageCount) ? imageCount : 0,
    mj_last_prompt: typeof result.prompt === 'string' ? result.prompt : source.mj_last_prompt,
    mj_last_buttons: buttons,
    ...(modalRequired
      ? { mj_modal_task_id: providerTaskId }
      : {
          mj_last_task_id: providerTaskId,
          mj_modal_task_id: '',
          mj_modal_prompt: '',
        }),
  })
  return true
}

function removeEmptyMidjourneyTarget(task: StudioTask, canvasId: number, nodeId: string): void {
  if (task.result?.modal_required !== true) return
  const state = useCanvasStore.getState()
  if (state.canvasId !== canvasId) return
  const node = state.nodes.find((candidate) => candidate.id === nodeId)
  if ((node?.type === 'image' || node?.type === 'output') && (node.items ?? []).length === 0) state.removeNodes([nodeId])
}

/** 把任务产物落回节点。落法与前台出图一致：节点本来空就填进去，
 *  已经有图就**追加**——恢复回来的图不该把用户后来放的东西挤掉。 */
function landImageTask(task: StudioTask, canvasId: number, nodeId: string): boolean {
  const items = imageTaskItems(task)
  if (items.length === 0) return false
  const s = useCanvasStore.getState()
  if (s.canvasId !== canvasId) return false
  const node = s.nodes.find((n) => n.id === nodeId)
  if (node === undefined) return false
  const have = new Set((node.items ?? []).map((it) => it.asset_id))
  const fresh = items.filter((it) => !have.has(it.asset_id))
  if (fresh.length === 0) return false
  s.snapshot()
  const next = [...(node.items ?? []), ...fresh]
  s.updateNode(nodeId, { items: next, ...widthForLandedItems(node, next) })
  return true
}

/** 图落地时该不该重算节点宽度。
 *
 *  空建的图片节点宽度是 `EMPTY_NODE_W`（420），出图回来后不重算的话，一张 9:16
 *  的图会撑成 420×747——比例是对的，但节点在画布上过分高大、更容易压到邻居。
 *  蓝本 `smart-canvas.js:1673 singleImageLayout` 的做法是把图等比装进一个有界框，
 *  我们的 `boxForItems` 走 `mediaNodeBox` 已经是同一件事，这里只是把它接上。
 *
 *  **判据是「宽度还等于空态默认值」而不是「有没有 w」**：用户拖过缩放手柄的节点
 *  w 是他自己定的，重算会把他的调整冲掉。 */
function widthForLandedItems(node: ScvNode, items: CanvasItem[]): { w?: number } {
  // 内容驱动尺寸的类型（图片/视频/输出）在注册表里没有固定宽度，返回 undefined
  if (defaultWidthFor(node.type) !== undefined) return {}
  if (node.w !== undefined && node.w !== EMPTY_NODE_W) return {}
  return { w: boxForItems(items).w }
}

/** 盯着一个图片任务直到终态。与视频那条同构。 */
async function trackCanvasImageTask(taskId: string, canvasId: number, nodeId: string): Promise<void> {
  if (trackedImageTasks.has(taskId)) return
  trackedImageTasks.add(taskId)
  try {
    for (let index = 0; index < VIDEO_POLL_MAX; index += 1) {
      const task = await apiStudio.task(taskId)
      const s = useCanvasStore.getState()
      if (s.canvasId !== canvasId) {
        finishCanvasTask(taskId, canvasId, nodeId)
        return
      }
      if (ACTIVE_TASKS.has(task.status)) {
        setCanvasTaskRunning(task, canvasId, nodeId, imageTaskLabel(task))
        await sleep(POLL_MS)
        continue
      }
      finishCanvasTask(taskId, canvasId, nodeId)
      if (task.status === 'succeeded' || task.status === 'partial') {
        updateMidjourneySource(task, canvasId)
        if (task.result?.modal_required === true) {
          removeEmptyMidjourneyTarget(task, canvasId, nodeId)
          toast.info('Midjourney 已进入局部重绘，请选择遮罩后提交')
          return
        }
        if (landImageTask(task, canvasId, nodeId)) {
          chime('done')
          toast.success('图已生成并接回画布')
        }
      } else if (task.status === 'failed') {
        toast.error(`出图失败：${task.error ?? '未知原因'}`)
      }
      return
    }
    finishCanvasTask(taskId, canvasId, nodeId)
  } catch (error) {
    finishCanvasTask(taskId, canvasId, nodeId)
    toast.error(`跟踪出图任务失败：${errText(error)}`)
  } finally {
    trackedImageTasks.delete(taskId)
  }
}

/** 登记「这个节点开始跑一个图片任务了」，并接管跟踪。
 *
 *  给编辑器用：用户在弹窗里点重绘/扩图之后，画布上那个节点就该显示在跑，
 *  这样**关掉弹窗也看得见**，跑完了图会自己落回去。 */
export function beginCanvasImageTask(nodeId: string, taskId: string): void {
  const s = useCanvasStore.getState()
  if (s.canvasId === null) return
  markRunning(nodeId, '生成中', false)
  useCanvasStore.setState({
    running: { ...useCanvasStore.getState().running, [nodeId]: {
      ...useCanvasStore.getState().running[nodeId],
      taskId,
    } },
  })
  void trackCanvasImageTask(taskId, s.canvasId, nodeId)
}

/** 从节点运行记录重试一条图片任务，并重新接管画布落点与跨刷新跟踪。 */
export async function retryCanvasImageTask(taskId: string): Promise<void> {
  const canvasId = useCanvasStore.getState().canvasId
  if (canvasId === null) return
  try {
    const task = await apiStudio.retryTask(taskId)
    if (task.canvas_id !== canvasId || task.node_id === null) {
      toast.error('重试任务没有可恢复的画布落点')
      return
    }
    const node = ensureTaskNode(task, canvasId, task.node_id, 'image')
    if (node === null) {
      toast.error('重试任务的输出节点无法恢复')
      return
    }
    setCanvasTaskRunning(task, canvasId, task.node_id, imageTaskLabel(task))
    toast.success('图片任务重试已入队')
    void trackCanvasImageTask(task.id, canvasId, task.node_id)
  } catch (error) {
    toast.error(errText(error))
  }
}

/** 从节点运行记录重试视频任务；被清掉的分支节点按任务快照原位恢复。 */
export async function retryCanvasVideoTask(taskId: string): Promise<void> {
  const canvasId = useCanvasStore.getState().canvasId
  if (canvasId === null) return
  try {
    const task = await apiStudio.retryTask(taskId)
    if (task.canvas_id !== canvasId || task.node_id === null) {
      toast.error('重试任务没有可恢复的画布落点')
      return
    }
    const node = ensureTaskNode(task, canvasId, task.node_id, 'video')
    if (node === null) {
      toast.error('重试任务的视频节点无法恢复')
      return
    }
    setCanvasTaskRunning(task, canvasId, task.node_id, videoTaskLabel(task))
    toast.success('视频任务重试已入队')
    void trackCanvasVideoTask(task.id, canvasId, task.node_id, false)
  } catch (error) {
    toast.error(errText(error))
  }
}

/** 打开画布时回捞图片任务。跑着的接着跑，跑完了的把图落回去。 */
async function recoverCanvasImageTasks(canvasId: number): Promise<void> {
  try {
    const response = await apiStudio.tasks({
      tool_id: 'infinite-canvas',
      canvas_id: canvasId,
      limit: 200,
    })
    if (useCanvasStore.getState().canvasId !== canvasId) return
    for (const task of response.items) {
      if (taskTargetNodeType(task.task_type) !== 'image') continue
      if (task.canvas_id !== canvasId || task.node_id === null) continue
      if (!ACTIVE_TASKS.has(task.status) && task.status !== 'succeeded' && task.status !== 'partial') {
        continue
      }
      const nodeId = task.node_id
      const node = ensureTaskNode(task, canvasId, nodeId, 'image')
      if (node === null) continue
      if (ACTIVE_TASKS.has(task.status)) {
        setCanvasTaskRunning(task, canvasId, nodeId, imageTaskLabel(task))
        void trackCanvasImageTask(task.id, canvasId, nodeId)
      } else if (task.status === 'succeeded' || task.status === 'partial') {
        /* 已经跑完的也要落一次：用户可能是在跑到一半时关的页面，
           那张图在服务端出好了却从没回到画布上。`landImageTask` 会按
           asset_id 去重，所以重复调不会把同一张图加两遍。 */
        updateMidjourneySource(task, canvasId)
        if (task.result?.modal_required === true) {
          removeEmptyMidjourneyTarget(task, canvasId, nodeId)
        } else {
          landImageTask(task, canvasId, nodeId)
        }
      }
    }
  } catch (error) {
    toast.error(`画布出图任务恢复失败：${errText(error)}`)
  }
}

function workflowTaskItems(task: StudioTask): CanvasItem[] {
  const raw = task.result?.items
  if (!Array.isArray(raw)) return []
  const items: CanvasItem[] = []
  for (const value of raw) {
    if (typeof value !== 'object' || value === null) continue
    const item = value as Record<string, unknown>
    const kind = String(item.kind ?? '')
    if (!['image', 'video', 'audio', 'file'].includes(kind)) continue
    if (kind === 'image') {
      const assetId = Number(item.asset_id ?? item.id)
      if (!Number.isInteger(assetId) || assetId <= 0) continue
      items.push({
        kind: 'image',
        asset_id: assetId,
        w: typeof item.width === 'number' ? item.width : undefined,
        h: typeof item.height === 'number' ? item.height : undefined,
        name: typeof item.name === 'string' ? item.name : undefined,
      })
      continue
    }
    if (typeof item.url !== 'string') continue
    const mediaId = Number(item.media_asset_id ?? item.id)
    items.push({
      kind: kind as 'video' | 'audio' | 'file',
      media_asset_id: Number.isInteger(mediaId) && mediaId > 0 ? mediaId : undefined,
      url: item.url,
      poster_url: typeof item.poster_url === 'string' ? item.poster_url : null,
      name: typeof item.name === 'string' ? item.name : undefined,
      mime: typeof item.mime === 'string' ? item.mime : undefined,
      duration_ms: typeof item.duration_ms === 'number' ? item.duration_ms : null,
      w: typeof item.width === 'number' ? item.width : undefined,
      h: typeof item.height === 'number' ? item.height : undefined,
    })
  }
  return items
}

export function workflowTimelineWithResult(
  timeline: CanvasWorkflowTimeline | undefined,
  segmentId: string | null,
  result: CanvasItem,
): CanvasWorkflowTimeline | undefined {
  if (timeline?.kind !== 'minimax' || segmentId === null) return timeline
  if (!timeline.segments.some((segment) => segment.id === segmentId)) return timeline
  return {
    ...timeline,
    segments: timeline.segments.map((segment) => (
      segment.id === segmentId ? { ...segment, result } : segment
    )),
  }
}

/** 工作流任务收尾。带 canvas_id 的任务，产物 output 节点由服务端 projector 按定值 id
    建（canvas_projector.workflow_output_node_id），浏览器只记完成态与时间线结果，
    产物随 canvas 帧合并进来——两端都建会在画布上留下一真一假两份。
    没有 canvas_id 的旧任务服务端不认画布，仍由浏览器本地建节点。 */
export function landWorkflowTask(task: StudioTask, canvasId: number, nodeId: string): boolean {
  const s = useCanvasStore.getState()
  if (s.canvasId !== canvasId) return false
  const node = s.nodes.find((value) => value.id === nodeId)
  if (node?.type !== 'workflow') return false
  if ((node.completed_task_ids ?? []).includes(task.id)) return true
  const items = workflowTaskItems(task)
  if (items.length === 0) return false
  const segmentId = typeof task.source_context?.workflow_segment_id === 'string'
    ? task.source_context.workflow_segment_id
    : null
  const segmentResult = items.find((item) => item.kind === 'video') ?? items[0]
  const timeline = workflowTimelineWithResult(
    node.workflow_timeline,
    segmentId,
    segmentResult,
  )
  s.snapshot()
  s.updateNode(node.id, {
    completed_task_ids: [...(node.completed_task_ids ?? []), task.id].slice(-20),
    ...(timeline === undefined ? {} : { workflow_timeline: timeline }),
  })
  if (typeof task.canvas_id === 'number') return true
  const groups = new Map<CanvasItem['kind'], CanvasItem[]>()
  for (const item of items) groups.set(item.kind, [...(groups.get(item.kind) ?? []), item])
  const kinds = [...groups.entries()]
  /* 落点走统一的避让，不再按 `index * 26` 硬错开。
     那个 26px 远小于产出节点的高度，一个工作流吐出图片+视频+音频三类时后两个
     几乎完全盖住第一个——只露出个标题条，看着像"凭空多了个空节点"。
     分支出图那条早就接了 `freeSpotForNode`，这条一直漏着。 */
  const boxes = kinds.map(([kind, grouped]) =>
    kind === 'image' || kind === 'video' ? boxForItems(grouped) : { w: 316, h: 220 },
  )
  const spots = freeNodeSpots(
    boxes.map((box, i) => ({
      x: node.x + (node.w ?? 300) + BRANCH_GAP,
      y: node.y + i * (box.h + 24),
      w: box.w,
      h: box.h,
    })),
  )
  kinds.forEach(([kind, grouped], index) => {
    const outputId = newNodeId()
    const kindLabel = kind === 'image' ? '图片' : kind === 'video' ? '视频' : kind === 'audio' ? '音频' : '文件'
    s.addNode({
      id: outputId,
      type: 'output',
      x: spots[index].x,
      y: spots[index].y,
      w: boxes[index].w,
      title: `${node.title ?? '工作流'} · ${kindLabel}`,
      items: grouped,
    })
    s.addConnection({ from: node.id, to: outputId, kind: 'flow' })
  })
  return true
}

function workflowTaskLabel(task: StudioTask): string {
  if (task.status === 'queued') return '工作流排队中'
  if (task.status === 'submitting') return '正在提交工作流'
  if (task.status === 'recovering') return `恢复工作流 · ${Math.round(task.progress)}%`
  return `运行工作流 · ${Math.round(task.progress)}%`
}

async function trackCanvasWorkflowTask(taskId: string, canvasId: number, nodeId: string): Promise<void> {
  if (trackedWorkflowTasks.has(taskId)) return
  trackedWorkflowTasks.add(taskId)
  try {
    for (let index = 0; index < VIDEO_POLL_MAX; index += 1) {
      const task = await apiStudio.task(taskId)
      const s = useCanvasStore.getState()
      if (s.canvasId !== canvasId) {
        finishCanvasTask(taskId, canvasId, nodeId)
        return
      }
      if (ACTIVE_TASKS.has(task.status)) {
        setCanvasTaskRunning(task, canvasId, nodeId, workflowTaskLabel(task))
        await sleep(POLL_MS)
        continue
      }
      finishCanvasTask(taskId, canvasId, nodeId)
      if (task.status === 'succeeded' || task.status === 'partial') {
        if (landWorkflowTask(task, canvasId, nodeId)) toast.success('工作流完成，产物已接到画布')
        else toast.info('工作流已完成，产物可在任务中心查看')
      } else {
        toast.error(task.error ?? '工作流运行失败')
      }
      return
    }
    finishCanvasTask(taskId, canvasId, nodeId)
    toast.info('工作流仍在后台运行，可稍后从任务中心或重新打开画布查看')
  } catch (error) {
    finishCanvasTask(taskId, canvasId, nodeId)
    toast.error(`工作流状态读取失败：${errText(error)}`)
  } finally {
    trackedWorkflowTasks.delete(taskId)
  }
}

async function recoverCanvasWorkflowTasks(canvasId: number): Promise<void> {
  try {
    const response = await apiStudio.tasks({
      tool_id: 'infinite-canvas',
      canvas_id: canvasId,
      limit: 200,
    })
    if (useCanvasStore.getState().canvasId !== canvasId) return
    for (const task of response.items) {
      if (!task.task_type.startsWith('workflow.')) continue
      if (task.canvas_id !== canvasId || task.node_id === null) continue
      if (!ACTIVE_TASKS.has(task.status) && task.status !== 'succeeded' && task.status !== 'partial') {
        continue
      }
      const nodeId = task.node_id
      const node = ensureTaskNode(task, canvasId, nodeId, 'workflow')
      if (node?.type !== 'workflow') continue
      if (ACTIVE_TASKS.has(task.status)) {
        setCanvasTaskRunning(task, canvasId, nodeId, workflowTaskLabel(task))
        void trackCanvasWorkflowTask(task.id, canvasId, nodeId)
      } else if (task.status === 'succeeded' || task.status === 'partial') {
        landWorkflowTask(task, canvasId, nodeId)
      }
    }
  } catch (error) {
    toast.error(`画布工作流恢复失败：${errText(error)}`)
  }
}

export async function runWorkflowFrom(
  nodeId: string,
  credentialId: number,
  fields: Record<string, unknown>,
  useWallet = false,
  instanceType: '' | 'plus' = '',
  sourceContext: Record<string, unknown> = {},
): Promise<void> {
  const s = useCanvasStore.getState()
  const canvasId = s.canvasId
  if (canvasId === null || nodeId in s.running) return
  const node = s.nodes.find((value) => value.id === nodeId)
  if (node?.type !== 'workflow' || node.workflow_id === undefined) return
  useCanvasStore.setState({
    running: {
      ...s.running,
      [nodeId]: { label: '工作流任务入队中', pending: false, startedAt: performance.now() },
    },
  })
  try {
    const task = await apiStudio.runWorkflow(node.workflow_id, {
      credential_id: credentialId,
      fields,
      use_wallet: useWallet,
      instance_type: instanceType,
      source_route: `/studio/canvas/${canvasId}`,
      source_context: { canvas_id: canvasId, node_id: nodeId, ...sourceContext },
    })
    const current = useCanvasStore.getState().running
    useCanvasStore.setState({
      running: {
        ...current,
        [nodeId]: {
              label: workflowTaskLabel(task),
              pending: false,
              taskId: task.id ,
              startedAt: s.running[nodeId]?.startedAt ?? performance.now(),
            },
      },
    })
    toast.success('工作流已进入后台，离开画布也会继续')
    void trackCanvasWorkflowTask(task.id, canvasId, nodeId)
  } catch (error) {
    clearRunning(nodeId)
    toast.error(errText(error))
  }
}

export async function retryCanvasWorkflowTask(taskId: string, nodeId: string): Promise<void> {
  const canvasId = useCanvasStore.getState().canvasId
  if (canvasId === null || nodeId in useCanvasStore.getState().running) return
  try {
    const task = await apiStudio.retryTask(taskId)
    setCanvasTaskRunning(task, canvasId, nodeId, workflowTaskLabel(task))
    toast.success('工作流重试已入队')
    void trackCanvasWorkflowTask(task.id, canvasId, nodeId)
  } catch (error) {
    toast.error(errText(error))
  }
}

/** 视频节点提交后立即交还 UI；上游轮询由 worker 持久执行，页面只合并进度和产物。 */
export async function generateVideoFrom(
  nodeId: string,
  deploymentOverride?: number | null,
  adapter: CanvasVideoAdapter = 'openai',
  upstreamModelId = '',
): Promise<void> {
  const s = useCanvasStore.getState()
  const canvasId = s.canvasId
  if (canvasId === null || nodeId in s.running) return
  const node = s.nodes.find((value) => value.id === nodeId)
  if (node === undefined || node.type !== 'video') return
  const prompt = composePrompt(s.nodes, s.connections, nodeId)
  if (prompt === '') {
    toast.error('先写视频提示词，也可以连接一个提示词节点')
    return
  }
  const settings = node.video_settings ?? {}
  const deploymentId = deploymentOverride ?? settings.deployment_id ?? null
  if (deploymentId === null || deploymentId <= 0) {
    toast.error('先选择一个可用的视频模型')
    return
  }
  const refs = refAssetIds(s.nodes, s.connections, nodeId)
  const mediaReferences = videoMediaReferenceInputs(
    refMediaItems(s.nodes, s.connections, nodeId),
    adapter,
  )
  const references = videoReferenceInputs(refs, settings, adapter).slice(
    0,
    adapter === 'jimeng' && mediaReferences.length > 0
      ? VIDEO_MULTIMODAL_MAX_REFS
      : VIDEO_MULTIFRAME_MAX_REFS,
  )
  const branch = (node.items ?? []).length > 0
  let targetId = nodeId
  if (branch) {
    targetId = newNodeId()
    s.snapshot()
    s.addNode({
      id: targetId,
      type: 'video',
      x: node.x + (node.w ?? 320) + BRANCH_GAP,
      y: node.y,
      w: node.w ?? 320,
      title: '视频分支',
      prompt_draft: node.prompt_draft,
      prompt_draft_html: node.prompt_draft_html,
      prompt_draft_refs: node.prompt_draft_refs,
      video_settings: { ...settings, deployment_id: deploymentId },
      items: [],
    })
    s.addConnection({ from: nodeId, to: targetId, kind: 'flow' })
  } else if (settings.deployment_id !== deploymentId) {
    s.updateNode(nodeId, {
      video_settings: { ...settings, deployment_id: deploymentId },
    })
  }
  useCanvasStore.setState({
    running: {
      ...useCanvasStore.getState().running,
      [targetId]: { label: '视频任务入队中', pending: false, startedAt: performance.now() },
    },
  })
  try {
    const task = await apiStudio.runVideo({
      deployment_id: deploymentId,
      prompt,
      duration: settings.duration ?? 4,
      aspect_ratio: settings.aspect_ratio ?? '16:9',
      resolution: normalizedVideoResolution(
        settings.resolution,
        adapter,
        upstreamModelId || settings.model_hint,
        mediaReferences.length > 0 ? 'multimodal' : settings.reference_mode,
      ),
      references,
      media_references: mediaReferences,
      options: videoRequestOptions(
        settings,
        adapter,
        references.length > 0 || mediaReferences.length > 0,
      ),
      source_route: `/studio/canvas/${canvasId}`,
      source_context: {
        ...canvasTaskSourceContext({
          canvasId,
          nodeId: targetId,
          ...(branch
            ? {
                sourceNodeId: nodeId,
                plannedNode: useCanvasStore.getState().nodes.find((value) => value.id === targetId),
              }
            : {}),
          executionGroupId: crypto.randomUUID().replace(/-/g, ''),
        }),
        ...(references.length === 0
          ? {}
          : { references: references.map((reference) => ({ ...reference })) }),
        ...(mediaReferences.length === 0
          ? {}
          : { media_references: mediaReferences.map((reference) => ({ ...reference })) }),
      },
    })
    const current = useCanvasStore.getState().running
    useCanvasStore.setState({
      running: {
        ...current,
        [targetId]: {
          label: videoTaskLabel(task),
          pending: false,
          taskId: task.id,
          startedAt: current[targetId]?.startedAt ?? performance.now(),
        },
      },
    })
    toast.success('视频任务已进入后台，离开画布也会继续')
    void trackCanvasVideoTask(task.id, canvasId, targetId, branch)
  } catch (error) {
    clearRunning(targetId)
    if (branch) useCanvasStore.getState().removeNodes([targetId])
    toast.error(errText(error))
  }
}

export type GenerateMode = 'auto' | 'inplace'

/** 单节点生成（FR-463）。

    auto：节点已有图 → 右侧建骨架分支节点收结果，原图保留；空节点 → 落回自身。
    inplace：结果落回自身，旧图在落图那一刻移入「历史」节点（history 边）。
    张数 N = N 个并发单张任务（BR-149），部分失败不拖累已成的。 */
export async function generateFrom(nodeId: string, mode: GenerateMode = 'auto'): Promise<void> {
  const s = useCanvasStore.getState()
  const canvasId = s.canvasId
  if (canvasId === null) return
  if (s.cascade !== null) {
    toast.info('级联正在跑，先停了再单独出图')
    return
  }
  const node = s.nodes.find((n) => n.id === nodeId)
  if (node === undefined || node.type !== 'image') return
  if (nodeId in s.running) return
  // 上游提示词节点/分组成员的文本拼在草稿前面（FR-461：prompt 节点给下游供提示词）
  const prompt = composePrompt(s.nodes, s.connections, nodeId)
  if (prompt === '') {
    toast.error('先写提示词再出图（也可以连一个提示词节点上来）')
    return
  }
  const rs = node.run_settings ?? {}
  /* 张数 = **并发起几个单张任务**，每个任务自己 `n: 1`（见下面 Array.from 那段）。
     所以它不受服务端单请求上限 `MAX_N = 4` 约束——那条管的是「一次请求要几张」。
     这里曾经写 `Math.min(rs.n ?? 1, 4)`，把两个概念混成一个：
     界面上填了 12 张、静默只出 4 张，而且不报错。
     上限改成与界面同源的 `N_MAX`，只防手滑。 */
  const count = Math.max(1, Math.min(rs.n ?? 1, GEN_N_MAX))
  const quality = normalizeQuality(rs.quality)
  const refs = refAssetIds(s.nodes, s.connections, nodeId)

  const branch = mode === 'auto' && (node.items ?? []).length > 0
  let targetId = nodeId
  if (branch) {
    targetId = newNodeId()
    const width = node.w ?? IMAGE_NODE_W
    /* 落点避让：分支节点原来固定落在源节点右边同一处，同一个节点连点两次
       「出图」，两个分支坐标一模一样，后一张把前一张整个盖住 */
    const spot = freeSpotForNode(
      { type: 'output', w: width, items: [] },
      { x: node.x + width + BRANCH_GAP, y: node.y },
    )
    s.addNode({
      id: targetId,
      type: 'output',
      x: spot.x,
      y: spot.y,
      w: width,
      /* 草稿**三个字段必须一起带**。只带 prompt_draft 的话，正文里的 @ 芯片
         退化成裸文字「图1」而 refs 为空，映射表没了——再点一次分支，
         那个「图1」已经指向另一张图。视频分支早就三样都带，图片分支当时漏了。 */
      prompt_draft: node.prompt_draft,
      prompt_draft_html: node.prompt_draft_html,
      prompt_draft_refs: node.prompt_draft_refs,
      run_settings: { ...rs },
      items: [],
    })
    // 生成血缘自动补 flow 边（FR-462）
    s.addConnection({ from: nodeId, to: targetId, kind: 'flow' })
  }
  markRunning(targetId, count > 1 ? `生成中 0/${count}` : '生成中', branch)
  const plannedNode = branch
    ? useCanvasStore.getState().nodes.find((candidate) => candidate.id === targetId)
    : undefined
  const taskContext: CanvasTaskContext = {
    canvasId,
    nodeId: targetId,
    ...(branch ? { sourceNodeId: nodeId, plannedNode, pendingTarget: true } : {}),
    // 同一次点击拆出的 N 个单张任务共享执行组，恢复时不再按节点丢任务。
    executionGroupId: crypto.randomUUID().replace(/-/g, ''),
  }

  const results: CanvasItem[] = []
  const errors: string[] = []
  let done = 0
  await Promise.all(
    Array.from({ length: count }, async () => {
      try {
        const assets =
          refs.length > 0
            ? await editOnce(
                prompt,
                refs,
                quality,
                taskContext,
                rs.deployment_id,
              )
            : await jobOnce(
                prompt,
                quality,
                sizeParam(rs.size),
                taskContext,
                rs.deployment_id,
              )
        results.push(...toItems(assets))
      } catch (e) {
        errors.push(errText(e))
      } finally {
        done += 1
        if (count > 1) setRunLabel(targetId, `生成中 ${done}/${count}`)
      }
    }),
  )

  const st = useCanvasStore.getState()
  if (st.canvasId !== canvasId) {
    // 画布已切走：图已入资产库，不丢，只是这块画布接不到了
    if (results.length > 0) toast.info('画布已关闭，产图已入资产库')
    return
  }
  clearRunning(targetId)
  // 失败原因原样展示，不吞不改写（BR-110 口径）
  for (const msg of [...new Set(errors)]) toast.error(msg)
  if (results.length === 0) {
    // 全失败回滚：删掉空分支节点连同它的边，原节点不动
    if (branch) st.removeNodes([targetId])
    return
  }
  // 落图算一步：⌘Z 能把这次出的图从画布上拿掉
  undoBeforeLanding(branch ? targetId : null)
  landResults(nodeId, targetId, results, mode)
  // 出图收尾时把这个源节点下的产出收进一个分组。默认关，见 batchGroupEnabled
  if (batchGroupEnabled()) groupBatchOutputs(nodeId)
}

/** ModelScope 专用生成节点。一次运行总是在右侧建独立图片输出，
 *  每张图是一个独立持久任务，因此刷新后仍能按输出节点恢复。 */
export async function generateModelScopeFrom(nodeId: string): Promise<void> {
  const s = useCanvasStore.getState()
  const canvasId = s.canvasId
  if (canvasId === null) return
  const node = s.nodes.find((candidate) => candidate.id === nodeId)
  if (node === undefined || node.type !== 'modelscope') return
  const deploymentId = node.ms_deployment_id
  if (deploymentId === null || deploymentId === undefined || deploymentId <= 0) {
    toast.error('先选择一个可用的 ModelScope 图片模型')
    return
  }
  const prompt = composePrompt(s.nodes, s.connections, nodeId)
  if (prompt === '') {
    toast.error('先写提示词，也可以连接上游提示词或 LLM 节点')
    return
  }
  const busy = s.connections.some(
    (connection) =>
      connection.from === nodeId &&
      (connection.kind ?? 'flow') === 'flow' &&
      connection.to in s.running,
  )
  if (busy) return

  const count = Math.max(1, Math.min(Math.round(node.ms_count ?? 1), MODELSCOPE_MAX_COUNT))
  const refs = refAssetIds(s.nodes, s.connections, nodeId)
  const targetId = newNodeId()
  const spot = freeSpotForNode(
    { type: 'output', w: EMPTY_NODE_W, items: [] },
    { x: node.x + (node.w ?? defaultWidthFor('modelscope') ?? 420) + BRANCH_GAP, y: node.y },
  )
  const output: ScvNode = {
    id: targetId,
    type: 'output',
    x: spot.x,
    y: spot.y,
    w: EMPTY_NODE_W,
    title: 'ModelScope 输出',
    prompt_draft: prompt,
    items: [],
  }
  s.snapshot()
  s.addNode(output)
  s.addConnection({ from: nodeId, to: targetId, kind: 'flow' })
  markRunning(targetId, count > 1 ? `ModelScope 生成中 0/${count}` : 'ModelScope 生成中', true)
  const taskContext: CanvasTaskContext = {
    canvasId,
    nodeId: targetId,
    sourceNodeId: nodeId,
    plannedNode: output,
    pendingTarget: true,
    executionGroupId: crypto.randomUUID().replace(/-/g, ''),
  }
  const options = modelScopeJobOptions(node, refs)
  const results: CanvasItem[] = []
  const errors: string[] = []
  let done = 0
  await Promise.all(
    Array.from({ length: count }, async () => {
      try {
        const assets = await jobOnce(
          prompt,
          normalizeQuality(undefined),
          sizeParam(node.ms_size ?? '1024x1024'),
          taskContext,
          deploymentId,
          options,
        )
        results.push(...toItems(assets))
      } catch (error) {
        errors.push(errText(error))
      } finally {
        done += 1
        if (count > 1) setRunLabel(targetId, `ModelScope 生成中 ${done}/${count}`)
      }
    }),
  )

  const current = useCanvasStore.getState()
  if (current.canvasId !== canvasId) {
    if (results.length > 0) toast.info('画布已关闭，ModelScope 产图已入资产库')
    return
  }
  clearRunning(targetId)
  for (const message of [...new Set(errors)]) toast.error(message)
  if (results.length === 0) {
    current.removeNodes([targetId])
    return
  }
  undoBeforeLanding(targetId)
  landResults(nodeId, targetId, results, 'auto')
  if (batchGroupEnabled()) groupBatchOutputs(nodeId)
}

export type MidjourneyActionName =
  | 'upscale'
  | 'variation'
  | 'high_variation'
  | 'low_variation'
  | 'reroll'
  | 'zoom'
  | 'pan'
  | 'inpaint'
  | 'modal'
  | 'remix_strong'
  | 'remix_subtle'

export interface MidjourneyActionOptions {
  index?: number
  direction?: 'left' | 'right' | 'up' | 'down'
  zoomRatio?: number
  customId?: string
  prompt?: string
  maskAssetId?: number
}

export type MidjourneyActionLayout = 'none' | 'legacy-grid' | 'remix-grid' | 'single'

/** APIMart 返回图数决定二次操作面板；MODAL 阶段只能补交遮罩。 */
export function midjourneyActionLayout(
  version: string,
  imageCount: number,
  modalRequired = false,
): MidjourneyActionLayout {
  if (modalRequired) return 'none'
  if (imageCount >= 4) return version === '8.1' || version === '8.2' ? 'remix-grid' : 'legacy-grid'
  if (imageCount === 1) return 'single'
  return 'none'
}

function midjourneyBusy(nodeId: string): boolean {
  const state = useCanvasStore.getState()
  return state.connections.some(
    (connection) =>
      connection.from === nodeId &&
      (connection.kind ?? 'flow') === 'flow' &&
      connection.to in state.running,
  )
}

function midjourneyTarget(source: ScvNode, prompt: string): ScvNode {
  /* 原来按已有产出条数往下错 36px。36 远小于一个输出节点的高度，
     第二次操作的产出就压在第一次上面九成，四次下来叠成一摞——
     现在给一个理想落点让避让算法自己找空地 */
  const spot = freeSpotForNode(
    { type: 'output', w: EMPTY_NODE_W, items: [] },
    {
      x: source.x + (source.w ?? defaultWidthFor('midjourney') ?? 440) + BRANCH_GAP,
      y: source.y,
    },
  )
  return {
    id: newNodeId(),
    type: 'output',
    x: spot.x,
    y: spot.y,
    w: EMPTY_NODE_W,
    title: 'Midjourney 输出',
    prompt_draft: prompt,
    items: [],
  }
}

function startMidjourneyTracking(
  task: StudioTask,
  canvasId: number,
  targetId: string,
): void {
  const current = useCanvasStore.getState().running
  useCanvasStore.setState({
    running: {
      ...current,
      [targetId]: {
        label: imageTaskLabel(task),
        pending: true,
        taskId: task.id,
        startedAt: current[targetId]?.startedAt ?? performance.now(),
      },
    },
  })
  void trackCanvasImageTask(task.id, canvasId, targetId)
}

/** Midjourney 初次生成。专用节点只保存任务和操作上下文，图片落到右侧输出节点。 */
export async function generateMidjourneyFrom(nodeId: string): Promise<void> {
  const state = useCanvasStore.getState()
  const canvasId = state.canvasId
  if (canvasId === null || midjourneyBusy(nodeId)) return
  const node = state.nodes.find((candidate) => candidate.id === nodeId)
  if (node?.type !== 'midjourney') return
  const deploymentId = node.mj_deployment_id
  if (deploymentId === null || deploymentId === undefined || deploymentId <= 0) {
    toast.error('先选择一个 APIMart Midjourney 部署')
    return
  }
  const mode = node.mj_mode ?? 'imagine'
  const prompt = composePrompt(state.nodes, state.connections, nodeId)
  const refs = refAssetIds(state.nodes, state.connections, nodeId).slice(0, MIDJOURNEY_MAX_REFS)
  if (mode !== 'blend' && prompt === '') {
    toast.error('当前模式需要提示词，也可以连接上游提示词或 LLM 节点')
    return
  }
  if (mode === 'blend' && (refs.length < 2 || refs.length > 4)) {
    toast.error('融图模式需要连接 2–4 张参考图')
    return
  }
  if (mode === 'edit' && refs.length === 0) {
    toast.error('编辑模式至少需要 1 张参考图')
    return
  }
  const target = midjourneyTarget(node, prompt)
  state.snapshot()
  state.addNode(target)
  state.addConnection({ from: nodeId, to: target.id, kind: 'flow' })
  markRunning(target.id, 'Midjourney 任务入队中', true)
  state.updateNode(nodeId, { mj_last_task_status: 'queued' })
  try {
    const task = await apiStudio.runMidjourney({
      deployment_id: deploymentId,
      mode,
      prompt,
      size: node.mj_size ?? '1:1',
      version: node.mj_version ?? '8.2',
      speed: node.mj_speed ?? 'relax',
      reference_asset_ids: refs,
      source_route: `/studio/canvas/${canvasId}`,
      source_context: canvasTaskSourceContext({
        canvasId,
        nodeId: target.id,
        sourceNodeId: nodeId,
        plannedNode: target,
        pendingTarget: true,
        executionGroupId: crypto.randomUUID().replace(/-/g, ''),
      }),
    })
    useCanvasStore.getState().updateNode(nodeId, { mj_last_task_status: task.status })
    startMidjourneyTracking(task, canvasId, target.id)
    toast.success('Midjourney 任务已进入后台')
  } catch (error) {
    clearRunning(target.id)
    useCanvasStore.getState().removeNodes([target.id])
    useCanvasStore.getState().updateNode(nodeId, { mj_last_task_status: 'failed' })
    toast.error(errText(error))
  }
}

/** Midjourney 二次操作：放大、变体、重新生成、缩放、平移、重塑与局部重绘。 */
export async function runMidjourneyAction(
  nodeId: string,
  action: MidjourneyActionName,
  options: MidjourneyActionOptions = {},
): Promise<void> {
  const state = useCanvasStore.getState()
  const canvasId = state.canvasId
  if (canvasId === null || midjourneyBusy(nodeId)) return
  const node = state.nodes.find((candidate) => candidate.id === nodeId)
  if (node?.type !== 'midjourney') return
  const deploymentId = node.mj_deployment_id
  if (deploymentId === null || deploymentId === undefined || deploymentId <= 0) {
    toast.error('原 Midjourney 部署已不可用，请重新选择')
    return
  }
  const providerTaskId = action === 'modal' ? node.mj_modal_task_id : node.mj_last_task_id
  if (providerTaskId === undefined || providerTaskId === '') {
    toast.error('这个节点还没有可继续操作的 Midjourney 任务')
    return
  }
  if (action === 'modal' && options.maskAssetId === undefined) {
    toast.error('提交局部重绘前先选一张遮罩图')
    return
  }
  const target = midjourneyTarget(node, options.prompt ?? node.mj_last_prompt ?? '')
  state.snapshot()
  state.addNode(target)
  state.addConnection({ from: nodeId, to: target.id, kind: 'flow' })
  markRunning(target.id, `Midjourney ${action} 入队中`, true)
  state.updateNode(nodeId, { mj_last_task_status: 'queued' })
  try {
    const task = await apiStudio.runMidjourneyAction({
      deployment_id: deploymentId,
      task_id: providerTaskId,
      action,
      speed: node.mj_speed ?? 'relax',
      index: options.index,
      direction: options.direction,
      zoom_ratio: options.zoomRatio,
      custom_id: options.customId,
      prompt: options.prompt ?? '',
      mask_asset_id: options.maskAssetId,
      source_route: `/studio/canvas/${canvasId}`,
      source_context: canvasTaskSourceContext({
        canvasId,
        nodeId: target.id,
        sourceNodeId: nodeId,
        plannedNode: target,
        pendingTarget: true,
        executionGroupId: crypto.randomUUID().replace(/-/g, ''),
      }),
    })
    useCanvasStore.getState().updateNode(nodeId, { mj_last_task_status: task.status })
    startMidjourneyTracking(task, canvasId, target.id)
  } catch (error) {
    clearRunning(target.id)
    useCanvasStore.getState().removeNodes([target.id])
    useCanvasStore.getState().updateNode(nodeId, { mj_last_task_status: 'failed' })
    toast.error(errText(error))
  }
}

/** 落图。inplace 且节点原本有图时，旧图移入自动创建的「历史」节点（FR-463） */
function landResults(
  sourceId: string,
  targetId: string,
  results: CanvasItem[],
  mode: GenerateMode,
): void {
  const s = useCanvasStore.getState()
  const target = s.nodes.find((n) => n.id === targetId)
  if (target === undefined) {
    toast.info('落点节点已被删除，产图已入资产库')
    return
  }
  if (targetId !== sourceId) {
    // 分支节点：结果直接进网格
    s.updateNode(targetId, { items: mergeItems(target.items, results) })
    return
  }
  const old = target.items ?? []
  if (mode === 'inplace' && old.length > 0) {
    let hist = s.nodes.find((n) => n.history_for === sourceId)
    if (hist === undefined) {
      const histW = target.w ?? IMAGE_NODE_W
      const spot = freeNodeSpot({ x: target.x, y: target.y + 320, w: histW, h: 280 })
      hist = {
        id: newNodeId(),
        type: 'image',
        x: spot.x,
        y: spot.y,
        w: histW,
        title: '历史',
        history_for: sourceId,
        items: [],
      }
      s.addNode(hist)
      s.addConnection({ from: sourceId, to: hist.id, kind: 'history' })
    }
    s.updateNode(hist.id, { items: mergeItems(hist.items, old) })
    s.updateNode(sourceId, { items: results })
    return
  }
  s.updateNode(sourceId, { items: mergeItems(old, results) })
}

/* ==================== 分组节点（FR-461 group） ====================

   分组用的是**普通自定义节点**，没走 react-flow 的 parentNode：那套会把子节点
   坐标改成相对父节点，与既有的拖拽落位、保存、409 合并全都要跟着改。这里的
   「吸收」就是把图搬进 group.items 再删掉原节点，位置关系自己算。 */

export const GROUP_COLS = 3
/* 格子边长由目标总宽反推：蓝本 SMART_GROUP_DEFAULT_WIDTH = 340
   （smart-canvas.js:1343），340 = 2×8 + 3×104 + 2×6 */
export const GROUP_CELL = 104
export const GROUP_GAP = 6
export const GROUP_PAD = 8
const GROUP_HEAD = 34
const GROUP_FOOT = 34
const GROUP_EMPTY_BODY = 76
export const GROUP_W = GROUP_PAD * 2 + GROUP_COLS * GROUP_CELL + (GROUP_COLS - 1) * GROUP_GAP
/** 拖拽落点的探针：卡片左右居中、顶部往下 40px，不要求整卡落进框里 */
const DROP_PROBE_Y = 40

/** 分组外框尺寸。渲染与落点判定共用同一个算式，两边才不会错位 */
function intrinsicGroupSize(node: ScvNode): { w: number; h: number } {
  const n = (node.items ?? []).length
  const rows = Math.max(1, Math.ceil(n / GROUP_COLS))
  const body =
    n === 0 ? GROUP_EMPTY_BODY : GROUP_PAD * 2 + rows * GROUP_CELL + (rows - 1) * GROUP_GAP
  return { w: GROUP_W, h: GROUP_HEAD + body + GROUP_FOOT }
}

/** 分组默认只需包住图片网格；有独立成员节点时，容器会记下扩展后的 h。
 *  导入的 Infinite-Canvas 分组也可能自带 w/h，不能在渲染时把它压回默认尺寸。 */
export function groupSize(node: ScvNode): { w: number; h: number } {
  const intrinsic = intrinsicGroupSize(node)
  return {
    w: Math.max(intrinsic.w, node.w ?? 0),
    h: Math.max(intrinsic.h, node.h ?? 0),
  }
}

/* ==================== 分组顶部小菜单 ==================== */

export type GroupToolbarAction = 'arrange' | 'preview' | 'grid' | 'download' | 'ungroup'

export interface GroupToolbarItem {
  key: GroupToolbarAction
  /** 按钮上的字 */
  text: string
  /** 悬浮说明 */
  label: string
  enabled: boolean
  /** 停用时说清为什么。灰按钮不给理由，用户只会以为坏了 */
  disabledReason?: string
}

/** 这个节点里**已入库的图**，按 items 的顺序。
 *
 *  「有没有图可用」这件事全仓只认这一条判据：分组小菜单的可用性、批量下载真正
 *  取到的那批、画布编辑器打开时的翻页列表与起始张，都从它派生。各写一遍的下场是
 *  按钮亮着点下去没反应——比如按 `items[0].asset_id` 判「有没有图」，
 *  而组里第一个 item 恰好是没入库的占位。 */
export function imageAssetIds(node: ScvNode | undefined): number[] {
  const out: number[] = []
  for (const it of node?.items ?? []) {
    if (it.kind === 'image' && it.asset_id !== undefined) out.push(it.asset_id)
  }
  return out
}

/** 分组内**已入库**的图片数。可用判据与批量下载真正取到的是同一批——
 *  两边判据不一致的话，按钮亮着而点下去提示「没有可下载的图」 */
export function groupImageCount(node: ScvNode | undefined): number {
  return imageAssetIds(node).length
}

/**
 * 分组顶部小菜单的五个动作与各自的可用判据。
 *
 * 蓝本 `smart-canvas.js:8289` `smartGroupToolbarHtml`，判据逐条照抄：
 * 整理要有内容（图或成员）、预览与批量下载要有图、宫格拼接要**两张以上**
 * （一张只能切不能拼）、解散永远可用（空组也得能拆掉）。
 *
 * 抽成纯函数是为了能单测：这五条判据写错不会报错，只会变成一个点了没反应
 * 或者点了报错的按钮，而那要真的建一个分组才看得出来。
 */
export function groupToolbarActions(node: ScvNode | undefined): GroupToolbarItem[] {
  const images = groupImageCount(node)
  const members = (node?.member_ids ?? []).length
  return [
    {
      key: 'arrange',
      text: '整理',
      label: '整理排列：把组内成员重新排成网格',
      enabled: images + members > 0,
      disabledReason: '分组内没有可整理的内容',
    },
    {
      key: 'preview',
      text: '预览',
      label: '预览：按组内顺序查看图片，可左右切换',
      enabled: images > 0,
      disabledReason: '分组内还没有已入库图片',
    },
    {
      key: 'grid',
      text: '宫格拼接',
      label: '宫格拼接：把组内多张图拼成一张',
      enabled: images > 1,
      disabledReason: '分组至少需要 2 张已入库图片',
    },
    {
      key: 'download',
      text: '批量下载',
      label: '批量下载：把组内原图打成 ZIP',
      enabled: images > 0,
      disabledReason: '分组内还没有已入库图片',
    },
    {
      key: 'ungroup',
      text: '解散',
      label: '解散分组：图片拆回独立节点，其余成员保留',
      enabled: true,
    },
  ]
}

/** 这个点落在哪个分组里。多个重叠时取靠后那个（画布上视觉在上层） */
export function groupAt(nodes: ScvNode[], x: number, y: number, skipId: string): string | null {
  let hit: string | null = null
  for (const n of nodes) {
    if (n.type !== 'group' || n.id === skipId) continue
    const { w, h } = groupSize(n)
    if (x >= n.x && x <= n.x + w && y >= n.y && y <= n.y + h) hit = n.id
  }
  return hit
}

/** 端点改接：把指向 oldId 的边改指到 newId，自环丢弃，重复键去重 */
function rewire(conns: CanvasConnection[], oldId: string, newId: string | null): CanvasConnection[] {
  const out: CanvasConnection[] = []
  const seen = new Set<string>()
  for (const c of conns) {
    if (c.from !== oldId && c.to !== oldId) {
      const key = connKey(c)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(c)
      continue
    }
    if (newId === null) continue
    const next: CanvasConnection = {
      ...c,
      from: c.from === oldId ? newId : c.from,
      to: c.to === oldId ? newId : c.to,
    }
    if (next.from === next.to) continue
    const key = connKey(next)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(next)
  }
  return out
}

/** 图片节点拖进分组：图搬进组内网格，指向它的连线改接分组，原节点删除 */
export function absorbIntoGroup(groupId: string, nodeId: string): void {
  const s = useCanvasStore.getState()
  const group = s.nodes.find((n) => n.id === groupId)
  const node = s.nodes.find((n) => n.id === nodeId)
  if (group === undefined || group.type !== 'group') return
  if (node === undefined || node.type !== 'image') return
  if ((node.items ?? []).length === 0) return
  if (nodeId in s.running) {
    toast.error('这个节点正在出图，等它跑完再拖进分组')
    return
  }
  s.snapshot()
  useCanvasStore.setState({
    nodes: s.nodes
      .filter((n) => n.id !== nodeId)
      .map((n) => {
        if (n.id === groupId) {
          return {
            ...n,
            items: mergeItems(n.items, node.items),
            member_ids: (n.member_ids ?? []).filter((id) => id !== nodeId),
          }
        }
        if (n.type !== 'group' || !(n.member_ids ?? []).includes(nodeId)) return n
        return { ...n, member_ids: (n.member_ids ?? []).filter((id) => id !== nodeId) }
      }),
    connections: rewire(s.connections, nodeId, groupId),
    selectedNodeIds: s.selectedNodeIds.filter((id) => id !== nodeId),
  })
  scheduleSave()
}

/** 非图片节点的归属：拖进哪个分组就归哪个，拖出来就退出。只改 member_ids，
    节点本身留在画布上（与源项目的提示词 / 循环 / MiniMax 成员语义一致）。 */
function setMemberMembership(nodeId: string, groupId: string | null): void {
  const s = useCanvasStore.getState()
  const before = s.nodes
    .filter((n) => n.type === 'group' && (n.member_ids ?? []).includes(nodeId))
    .map((n) => n.id)
  if (before.length === (groupId === null ? 0 : 1) && before[0] === (groupId ?? undefined)) return
  useCanvasStore.setState({
    nodes: s.nodes.map((n) => {
      if (n.type !== 'group') return n
      const has = (n.member_ids ?? []).includes(nodeId)
      if (n.id === groupId) {
        return has ? n : { ...n, member_ids: [...(n.member_ids ?? []), nodeId] }
      }
      return has ? { ...n, member_ids: (n.member_ids ?? []).filter((id) => id !== nodeId) } : n
    }),
  })
  for (const affected of new Set([...before, ...(groupId === null ? [] : [groupId])])) {
    arrangeGroupMembers(affected)
  }
  scheduleSave()
}

/** 把分组内的独立成员排成接近正方形的网格，并让外框精确包住它们。
 *  图片在 group.items 的缩略网格中，独立成员从图片区下方开始排。 */
export function arrangeGroupMembers(groupId: string): boolean {
  const s = useCanvasStore.getState()
  const group = s.nodes.find((node) => node.id === groupId)
  if (group?.type !== 'group') return false
  /* 阅读顺序带 24px 容差（蓝本 smart-canvas.js:1590）：纯按 y 排的话，
     两个肉眼并排、y 差几像素的成员会被判成上下两行，整理完顺序就乱了 */
  const members = readingOrder(
    (group.member_ids ?? [])
      .map((id) => s.nodes.find((node) => node.id === id))
      .filter((node): node is ScvNode => node !== undefined && node.type !== 'group'),
  )
  if (members.length === 0) return false

  const pad = MEMBER_PAD
  const gap = MEMBER_GAP
  const cols = Math.max(1, Math.min(members.length, Math.round(Math.sqrt(members.length))))
  const rows = Math.ceil(members.length / cols)
  /* 尺寸走 `nodeBox`（实测优先）而不是 `member.w ?? 兜底`：`h` 基本没人存，
     以前每个成员的高度都取兜底里那个字面量，而图按真实比例定型之后
     竖图节点比它高一倍——整理完成员照样上下叠在一起。 */
  const sizes = members.map((member) => {
    const box = nodeBox(member)
    return { member, w: box.w, h: box.h }
  })
  const colWidths = Array.from({ length: cols }, () => 0)
  const rowHeights = Array.from({ length: rows }, () => 0)
  sizes.forEach((size, index) => {
    const col = index % cols
    const row = Math.floor(index / cols)
    colWidths[col] = Math.max(colWidths[col], size.w)
    rowHeights[row] = Math.max(rowHeights[row], size.h)
  })
  const colOffsets: number[] = []
  const rowOffsets: number[] = []
  let cursor = 0
  for (const width of colWidths) {
    colOffsets.push(cursor)
    cursor += width + gap
  }
  cursor = 0
  for (const height of rowHeights) {
    rowOffsets.push(cursor)
    cursor += height + gap
  }
  const contentWidth = colWidths.reduce((sum, width) => sum + width, 0) + gap * (cols - 1)
  const contentHeight = rowHeights.reduce((sum, height) => sum + height, 0) + gap * (rows - 1)
  const base = intrinsicGroupSize(group)
  const width = Math.max(base.w, contentWidth + pad * 2)
  const memberTop = group.y + base.h - GROUP_FOOT + pad
  const positions = new Map<string, { x: number; y: number }>()
  sizes.forEach((size, index) => {
    const col = index % cols
    const row = Math.floor(index / cols)
    positions.set(size.member.id, {
      x: Math.round(group.x + pad + colOffsets[col] + (colWidths[col] - size.w) / 2),
      y: Math.round(memberTop + rowOffsets[row] + (rowHeights[row] - size.h) / 2),
    })
  })
  const height = Math.max(
    base.h,
    memberTop - group.y + contentHeight + pad + GROUP_FOOT,
  )
  useCanvasStore.setState({
    nodes: s.nodes.map((node) => {
      if (node.id === groupId) return { ...node, w: width, h: height }
      const position = positions.get(node.id)
      return position === undefined ? node : { ...node, ...position }
    }),
  })
  scheduleSave()
  return true
}

/** 分组里**还有独立节点的成员**（图片是被吸收进 items 的，没有节点），
 *  按阅读顺序给出各自的当前尺寸。缩放与最小尺寸都问它。 */
function groupMemberSizes(
  nodes: ScvNode[],
  group: ScvNode,
): { id: string; x: number; y: number; w: number; h: number }[] {
  const members = (group.member_ids ?? [])
    .map((id) => nodes.find((node) => node.id === id))
    .filter((node): node is ScvNode => node !== undefined && node.type !== 'group')
  return readingOrder(
    members.map((member) => {
      const box = nodeBox(member)
      return { id: member.id, x: member.x, y: member.y, w: box.w, h: box.h }
    }),
  )
}

/** 成员区顶边相对分组左上角的偏移：图片网格底下、脚注上面。
 *  「整理」与缩放共用这一条算式，两边各写一份就会错位。 */
function memberTopOffset(group: ScvNode): number {
  return intrinsicGroupSize(group).h - GROUP_FOOT + MEMBER_PAD
}

/** 分组的最小尺寸：**至少放得下一行成员**，而不是写死的数字。
 *
 *  以前宽度下限是常量 `GROUP_W`、高度下限是字面量 220。成员比默认框还宽时
 *  （llm 节点 420、midjourney 440），拖到下限后成员照样戳在框外面。 */
function minSizeOf(group: ScvNode, sizes: readonly { w: number }[]): { w: number; h: number } {
  const intrinsic = intrinsicGroupSize(group)
  return {
    w: Math.max(intrinsic.w, sizes.length === 0 ? 0 : widestMember(sizes) + MEMBER_PAD * 2),
    h: intrinsic.h,
  }
}

export function groupMinSize(node: ScvNode): { w: number; h: number } {
  return minSizeOf(node, groupMemberSizes(useCanvasStore.getState().nodes, node))
}

/** 拖动智能分组的八向手柄。
 *
 *  成员**按新宽度重新流式排布**（拉宽就一行多塞几个，拉窄就折下去），
 *  而不是整体等比放大。等比那条路会把缩放后的 `w`/`h` 写回成员，
 *  蓝本 `smart-canvas.js:1615` 记着它的后果——「拖出再拖入图片变小、
 *  整理也救不回来」，因为写进去的尺寸盖住了自然尺寸。所以这里**一个成员的
 *  尺寸字段都不碰**，只改位置。
 *
 *  用户手动摆过的坐标会被重排覆盖，但他排的**先后顺序**留着
 *  （`readingOrder` 按行读）——「自适应填充」与「保留手摆的坐标」本来就
 *  互斥，保住顺序是两者之间唯一说得通的取舍。
 *
 *  `handle` 决定撑大时钉住哪条边：拖左边缘时右边缘不动，反之亦然。 */
export function resizeGroup(groupId: string, rect: Rect, handle: ResizeHandle = 'se'): void {
  const s = useCanvasStore.getState()
  const group = s.nodes.find((node) => node.id === groupId)
  if (group?.type !== 'group') return
  const sizes = groupMemberSizes(s.nodes, group)
  const min = minSizeOf(group, sizes)

  /* 外壳已经按静态下限夹过一遍，这里再夹一次是因为**权威口径在这**：
     成员换了、图片多了一行，下限跟着变，外壳拿到的那份可能是上一帧的。 */
  let box = growRectAnchored(
    {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    handle,
    min,
  )
  const flow = flowMembers(sizes, box.width - MEMBER_PAD * 2, MEMBER_GAP)
  const top = memberTopOffset(group)
  /* 排完发现装不下就把高度撑开。不撑的话成员会从框底下露出来——
     框还在、成员在框外，看着像"组散了" */
  if (flow.cells.length > 0) {
    box = growRectAnchored(box, handle, {
      w: min.w,
      h: Math.max(min.h, top + flow.contentH + MEMBER_PAD + GROUP_FOOT),
    })
  }

  const originX = box.x + MEMBER_PAD
  const originY = box.y + top
  const moved = new Map(
    flow.cells.map((cell) => [
      cell.id,
      { x: Math.round(originX + cell.dx), y: Math.round(originY + cell.dy) },
    ]),
  )
  const next = { x: box.x, y: box.y, w: box.width, h: box.height }
  useCanvasStore.setState({
    nodes: s.nodes.map((node) => {
      if (node.id === groupId) {
        return node.x === next.x && node.y === next.y && node.w === next.w && node.h === next.h
          ? node
          : { ...node, ...next }
      }
      const position = moved.get(node.id)
      if (position === undefined) return node
      /* 位置没变就原样返回同一个对象：拖动中每帧都换新引用的话，
         React 要把全部成员重新协调一遍，成员一多帧率就掉下去 */
      return node.x === position.x && node.y === position.y ? node : { ...node, ...position }
    }),
  })
  scheduleSave()
}

/** 从分组右键创建节点时，直接把它收入该组并排在已有成员之后。
 *
 *  图片仍走网格吸收；空图片没有可吸收内容，保留为独立节点。非图片成员是
 *  独立节点，只记 member_ids，同时把分组外框向下扩展到足以包住它。 */
export function placeNodeInGroup(groupId: string, nodeId: string): boolean {
  const s = useCanvasStore.getState()
  const group = s.nodes.find((n) => n.id === groupId)
  const node = s.nodes.find((n) => n.id === nodeId)
  if (group?.type !== 'group' || node === undefined || node.id === group.id) return false
  if (node.type === 'group' || node.type === 'output') return false
  if (node.type === 'image') {
    if ((node.items ?? []).length === 0) return false
    absorbIntoGroup(groupId, nodeId)
    return true
  }

  setMemberMembership(nodeId, groupId)
  useCanvasStore.setState({ selectedNodeIds: [nodeId], selectedEdgeIds: [] })
  return true
}

/** 把一个智能分组拖入另一个：图片与成员合并，连线改接目标组，源分组本体删除。 */
export function mergeGroupIntoGroup(sourceId: string, targetId: string): boolean {
  const s = useCanvasStore.getState()
  const source = s.nodes.find((node) => node.id === sourceId)
  const target = s.nodes.find((node) => node.id === targetId)
  if (source?.type !== 'group' || target?.type !== 'group' || sourceId === targetId) return false
  const memberIds = Array.from(
    new Set([...(target.member_ids ?? []), ...(source.member_ids ?? [])]),
  ).filter((id) => id !== sourceId && id !== targetId)
  s.snapshot()
  useCanvasStore.setState({
    nodes: s.nodes
      .filter((node) => node.id !== sourceId)
      .map((node) => {
        if (node.id === targetId) {
          return {
            ...node,
            items: mergeItems(node.items, source.items),
            member_ids: memberIds,
          }
        }
        if (node.type !== 'group') return node
        const next = (node.member_ids ?? []).filter((id) => id !== sourceId)
        return next.length === (node.member_ids ?? []).length ? node : { ...node, member_ids: next }
      }),
    connections: rewire(s.connections, sourceId, targetId),
    selectedNodeIds: [targetId],
    selectedEdgeIds: [],
  })
  arrangeGroupMembers(targetId)
  scheduleSave()
  return true
}

/** 拖拽松手后的归属判定。拖动过程中反复吸收会把画布搅乱，所以只在松手时算一次 */
export function syncGroupMembership(nodeId: string): void {
  const s = useCanvasStore.getState()
  const node = s.nodes.find((n) => n.id === nodeId)
  if (node === undefined) return
  if (node.type === 'group') {
    const size = groupSize(node)
    const gid = groupAt(s.nodes, node.x + size.w / 2, node.y + size.h / 2, nodeId)
    if (gid !== null) mergeGroupIntoGroup(nodeId, gid)
    return
  }
  const x = node.x + (node.w ?? IMAGE_NODE_W) / 2
  const gid = groupAt(s.nodes, x, node.y + DROP_PROBE_Y, nodeId)
  if (node.type === 'image') {
    if ((node.items ?? []).length === 0) setMemberMembership(nodeId, gid)
    else if (gid !== null) absorbIntoGroup(gid, nodeId)
    return
  }
  if (node.type === 'output') return
  setMemberMembership(nodeId, gid)
}

/** 解散：组内图拆回独立节点，从分组原位置铺开，提示词成员释放，连到分组的边改接第一张图。
 *
 *  蓝本 `smart-canvas.js:17264` `ungroupNode`：拆出的图**平铺在分组原位置**，
 *  非图片成员原地保留，最后把拆出来的和释放的成员一起选中——用户点了「解散」，
 *  下一步多半是接着摆弄这批东西，什么都不选中等于让他自己再框一次。
 *
 *  两处与蓝本不同：① 图按各自的自然尺寸装框（蓝本用组内缩略图的格子边长，
 *  拆出来还是缩略图那么大）；② 落点整批避让，不压到分组周围本来就有的节点。 */
export function dissolveGroup(groupId: string): void {
  const s = useCanvasStore.getState()
  const group = s.nodes.find((n) => n.id === groupId)
  if (group === undefined || group.type !== 'group') return
  s.snapshot()
  const items = group.items ?? []
  const boxes = items.map((it) => mediaNodeBox(it.w, it.h))
  const gap = 24
  const spots = freeNodeSpots(
    boxes.map((box, i) => ({
      x: group.x + (i % GROUP_COLS) * (box.w + gap),
      y: group.y + Math.floor(i / GROUP_COLS) * (box.h + gap),
      w: box.w,
      h: box.h,
    })),
    // 分组本体这一刻就要被删掉，不该再算作障碍，否则拆出的图全被推到组外面去
    new Set([groupId]),
  )
  const born: ScvNode[] = items.map((it, i) => ({
    id: newNodeId(),
    type: 'image',
    x: spots[i].x,
    y: spots[i].y,
    w: boxes[i].w,
    items: [it],
  }))
  // 一张图都没有时，连到分组的边无处可接，只能一起删
  const anchor = born.length > 0 ? born[0].id : null
  /* 选中拆出来的图和释放的成员。用 Set 累加而不是直接覆盖：批量解组会连着
     调好几次，覆盖的话只有最后一个组的产物是选中的 */
  const selection = new Set(s.selectedNodeIds.filter((id) => id !== groupId))
  for (const n of born) selection.add(n.id)
  for (const id of group.member_ids ?? []) {
    if (s.nodes.some((n) => n.id === id)) selection.add(id)
  }
  useCanvasStore.setState({
    nodes: [...s.nodes.filter((n) => n.id !== groupId), ...born],
    connections: rewire(s.connections, groupId, anchor),
    selectedNodeIds: [...selection],
    selectedEdgeIds: [],
  })
  scheduleSave()
}

export type OutputGroupMode = 'copy' | 'convert'

/** 从生成节点的输出端口拖到空白处时，与 Infinite-Canvas 一样直接落一个 Output。
 *
 * LLM 仍弹出“接下游节点”菜单：它的文本通常要继续驱动生成器，不是媒体产物。 */
const AUTO_OUTPUT_SOURCE_TYPES = new Set<ScvNode['type']>([
  'image',
  'modelscope',
  'midjourney',
  'video',
  'workflow',
])

export function createAutoOutput(
  sourceId: string,
  point: { x: number; y: number },
): string | null {
  const state = useCanvasStore.getState()
  const source = state.nodes.find((node) => node.id === sourceId)
  if (source === undefined || !AUTO_OUTPUT_SOURCE_TYPES.has(source.type)) return null

  state.snapshot()
  const outputId = newNodeId()
  const output: ScvNode = {
    id: outputId,
    type: 'output',
    x: Math.round(point.x - 40),
    y: Math.round(point.y - 63),
    w: EMPTY_NODE_W,
    title: `${source.title ?? '生成'}输出`,
    items: [],
  }
  useCanvasStore.setState({
    nodes: [...state.nodes, output],
    connections: [
      ...state.connections,
      { from: sourceId, to: outputId, kind: 'flow' },
    ],
    selectedNodeIds: [outputId],
    selectedEdgeIds: [],
  })
  scheduleSave()
  return outputId
}

/** 把 Output 节点里的图片变成可继续当参考的输入组。
 *
 * `copy` 保留原 Output，并在右下角错开 36px；`convert` 删掉 Output，
 * 丢弃它的上游血缘，只把原有下游连线改接到新组。 */
export function outputToInputGroup(outputId: string, mode: OutputGroupMode): string | null {
  const s = useCanvasStore.getState()
  const output = s.nodes.find((node) => node.id === outputId)
  if (output?.type !== 'output') return null
  const items = (output.items ?? []).filter((item) => item.kind === 'image')
  if (items.length === 0) return null

  const groupId = newNodeId()
  const offset = mode === 'copy' ? 36 : 0
  const group: ScvNode = {
    id: groupId,
    type: 'group',
    x: output.x + offset,
    y: output.y + offset,
    title: '输入组',
    items: structuredClone(items),
    member_ids: [],
  }
  s.snapshot()
  if (mode === 'copy') {
    useCanvasStore.setState({
      nodes: [...s.nodes, group],
      selectedNodeIds: [groupId],
      selectedEdgeIds: [],
    })
  } else {
    const downstream = s.connections.filter((connection) => connection.from === outputId)
    const kept = s.connections.filter(
      (connection) => connection.from !== outputId && connection.to !== outputId,
    )
    const seen = new Set(kept.map(connKey))
    const rewired: CanvasConnection[] = []
    for (const connection of downstream) {
      const next = { ...connection, from: groupId }
      const key = connKey(next)
      if (next.to === groupId || seen.has(key)) continue
      seen.add(key)
      rewired.push(next)
    }
    useCanvasStore.setState({
      nodes: [...s.nodes.filter((node) => node.id !== outputId), group],
      connections: [...kept, ...rewired],
      selectedNodeIds: [groupId],
      selectedEdgeIds: [],
      selectedItem: null,
    })
  }
  scheduleSave()
  return groupId
}

/** 把组内第 `index` 张图拖出来，落成独立的图片节点。
 *
 *  分组是「画布中的画布」，进得去也要出得来。少了这条，组内缩略图就是一堆死图——
 *  只能整组解散（把其余几十张也一并炸开）才能取回其中一张。
 *  `x/y` 是松手处的世界坐标，节点以指针为中心落下。 */
export function extractFromGroup(groupId: string, index: number, x: number, y: number): void {
  extractItem(groupId, index, x, y)
}

/** 把节点里第 `index` 张图拆出来，落成独立的图片节点。
 *
 *  分组与**多图节点**共用这一条：一次出 4 张时它们都挤在一个节点里，
 *  想单独拿一张去当参考、去改、去删，都得先能拆出来。
 *
 *  拆出的节点与原节点**保留一条 flow 边**：血缘不该因为「换了个容器」就断掉，
 *  用户后面回头看「这张是从哪来的」还找得到。分组是收纳容器不是产出来源，
 *  所以只有多图节点建边。
 *
 *  `x/y` 是松手处的世界坐标，节点以指针为中心落下。 */
export function extractItem(hostId: string, index: number, x: number, y: number): void {
  const s = useCanvasStore.getState()
  const host = s.nodes.find((n) => n.id === hostId)
  if (host === undefined) return
  const items = host.items ?? []
  const it = items[index]
  if (it === undefined) return
  s.snapshot()
  const box = mediaNodeBox(it.w, it.h)
  const born: ScvNode = {
    id: newNodeId(),
    type: 'image',
    x: Math.round(x - box.w / 2),
    y: Math.round(y - 40),
    w: box.w,
    title: host.title === undefined ? undefined : `${host.title} · 第 ${index + 1} 张`,
    items: [it],
  }
  const rest = items.filter((_, i) => i !== index)
  const linked =
    host.type === 'group'
      ? s.connections
      : [...s.connections, { from: hostId, to: born.id, kind: 'flow' as const }]
  useCanvasStore.setState({
    // 拆到只剩空框时容器仍然留着：用户可能正打算往里放别的，替他删掉是越权
    nodes: [...s.nodes.map((n) => (n.id === hostId ? { ...n, items: rest } : n)), born],
    connections: linked,
    selectedNodeIds: [born.id],
    selectedEdgeIds: [],
    selectedItem: it.asset_id === undefined ? null : { nodeId: born.id, assetId: it.asset_id },
  })
  scheduleSave()
}

/** 把多图节点**整个摊开**成一排独立节点，每张一个，都连回原节点。
 *
 *  一次出 8 张时逐张拖太慢。摊开之后原节点留一个空壳（还能继续在它上面出图），
 *  排布用与「整理选中」同一套网格算式，不另写一份。 */
export function explodeNode(hostId: string): void {
  const s = useCanvasStore.getState()
  const host = s.nodes.find((n) => n.id === hostId)
  const items = host?.items ?? []
  if (host === undefined || items.length < 2) return
  s.snapshot()
  const gap = 28
  const cols = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(items.length))))
  const boxes = items.map((it) => mediaNodeBox(it.w, it.h))
  /* 网格是理想落点，实际落点整批一起避让：宿主下方往往已经站着别的节点，
     一张张压上去正是「摊开之后图盖住图」 */
  const spots = freeNodeSpots(
    boxes.map((box, i) => ({
      x: Math.round(host.x + (i % cols) * (box.w + gap)),
      y: Math.round(host.y + (host.h ?? 320) + gap + Math.floor(i / cols) * (box.h + gap + 24)),
      w: box.w,
      h: box.h,
    })),
  )
  const born: ScvNode[] = items.map((it, i) => {
    const box = boxes[i]
    return {
      id: newNodeId(),
      type: 'image',
      x: spots[i].x,
      y: spots[i].y,
      w: box.w,
      title: host.title === undefined ? undefined : `${host.title} · 第 ${i + 1} 张`,
      items: [it],
    }
  })
  useCanvasStore.setState({
    nodes: [...s.nodes.map((n) => (n.id === hostId ? { ...n, items: [] } : n)), ...born],
    connections: [
      ...s.connections,
      ...born.map((b) => ({ from: hostId, to: b.id, kind: 'flow' as const })),
    ],
    selectedNodeIds: born.map((b) => b.id),
    selectedEdgeIds: [],
  })
  scheduleSave()
}

/** 从组、多图图片节点或 Output 里删掉一张。资产库原图不动。 */
export function removeFromGroup(groupId: string, index: number): void {
  const s = useCanvasStore.getState()
  const group = s.nodes.find((n) => n.id === groupId)
  if (group === undefined || !['group', 'image', 'output'].includes(group.type)) return
  const items = group.items ?? []
  if (items[index] === undefined) return
  s.snapshot()
  useCanvasStore.setState({
    nodes: s.nodes.map((n) => (n.id === groupId ? { ...n, items: items.filter((_, i) => i !== index) } : n)),
  })
  scheduleSave()
}

export interface GroupSelectionOptions {
  /** 分组标题。不给就是「分组」 */
  title?: string
  /** 不弹提示。自动成组（出图收尾时）走这条：那时用户没点任何按钮，
   *  弹一句「请选择要放入分组的节点」只会莫名其妙 */
  silent?: boolean
}

/** 批量成组：选中的图节点被吸收成组内网格，其余节点作为独立成员。
 *  源智能画布允许一个节点直接成组，并且循环 / MiniMax 不能在这里被忽略。
 *
 *  蓝本 `smart-canvas.js:17233` `groupSelectedNodes`：建组 → 逐个 `addNodeToSmartGroup`
 *  → `arrangeSmartGroupMembers`。这里的「吸收图片 / 登记成员 / 整理」三步是同一套。
 *
 *  返回新分组 id；没建成返回 null。 */
export function groupSelection(ids: string[], options: GroupSelectionOptions = {}): string | null {
  const s = useCanvasStore.getState()
  const fail = (message: string): null => {
    if (options.silent !== true) toast.error(message)
    return null
  }
  const picked = s.nodes.filter(
    (node) =>
      ids.includes(node.id) &&
      node.type !== 'group' &&
      // 空 Output 既没有图可吸收，也不该当成员：它是链路末端的落点，不是画布上的素材
      !(node.type === 'output' && (node.items ?? []).length === 0),
  )
  /* Output 与图片节点一样是「装着图的容器」，一起吸收成组内网格。
     它原来被整个排除在外，后果是**用户刚生成的那批图恰恰是唯一成不了组的**——
     选中三个产出点「成组」，只弹一句「请选择要放入分组的节点」。 */
  const images = picked.filter(
    (node) =>
      (node.type === 'image' || node.type === 'output') &&
      node.history_for === undefined &&
      (node.items ?? []).length > 0,
  )
  const members = picked.filter((node) => !images.some((image) => image.id === node.id))
  if (picked.length < 1) return fail('请选择要放入分组的节点')
  if (images.some((n) => n.id in s.running)) return fail('有节点正在出图，等它跑完再成组')
  const gx = Math.min(...picked.map((node) => node.x)) - 18
  const gy = Math.min(...picked.map((node) => node.y)) - 44
  let items: CanvasItem[] = []
  for (const n of images) items = mergeItems(items, n.items)
  const gid = newNodeId()
  const gone = new Set(images.map((n) => n.id))
  let conns = s.connections
  for (const id of gone) conns = rewire(conns, id, gid)
  captureUndo(false)
  useCanvasStore.setState({
    nodes: [
      ...s.nodes
        .filter((node) => !gone.has(node.id))
        .map((node) =>
          node.type === 'group' && (node.member_ids ?? []).some((id) => ids.includes(id))
            ? { ...node, member_ids: (node.member_ids ?? []).filter((id) => !ids.includes(id)) }
            : node,
        ),
      {
        id: gid,
        type: 'group',
        x: gx,
        y: gy,
        title: options.title ?? '分组',
        items,
        member_ids: members.map((member) => member.id),
      },
    ],
    connections: conns,
    selectedNodeIds: [gid],
    selectedEdgeIds: [],
  })
  arrangeGroupMembers(gid)
  scheduleSave()
  return gid
}

/* ==================== 并发出图收进分组（默认关） ==================== */

const BATCH_GROUP_KEY = 'scv.batch-group'

/** 一次出图的产物要不要自动收进一个分组。
 *
 *  **默认关**，理由写在这里免得后人以为是漏配：
 *  ① 收进分组后图是 104px 的缩略格子，而留在产出节点里是 `mediaGridBox` 的
 *     ≤220px 格子——自动开等于把「让图都能看清」这件事反着做；
 *  ② 吸收是**删掉原节点**把图搬进组，产出节点上的血缘边被改接到分组，
 *     默默替用户做这个不可见的重排，撤销一次也未必回得来。
 *  想要的人在画布上勾一下即可，勾了之后每次出图收尾自动成组。 */
export function batchGroupEnabled(): boolean {
  try {
    return window.localStorage.getItem(BATCH_GROUP_KEY) === '1'
  } catch {
    // 隐私模式下 localStorage 读取会抛，这项偏好不值得让出图流程跟着崩
    return false
  }
}

export function setBatchGroupEnabled(on: boolean): void {
  try {
    window.localStorage.setItem(BATCH_GROUP_KEY, on ? '1' : '0')
  } catch {
    // 同上：存不下就这次会话内生效，不报错
  }
}

/** 把一个源节点下**已经出完图**的产出收进一个分组。
 *
 *  蓝本的建组流程（`groupSelectedNodes` → `addNodeToSmartGroup` →
 *  `arrangeSmartGroupMembers`）整套复用，这里只负责挑出「哪些算这一批」：
 *  沿 flow 边直连、图片/产出类型、有图、不在跑、不是历史归档，
 *  并且**排除级联槽位**（`slot_of`）——槽位靠 slot_of/slot_round 跨会话认领，
 *  吸收进分组等于把槽位删了，下次重跑会重建一整排新节点。
 *
 *  少于两个不成组：一个节点自己成组，只是给它套了个更小的框。 */
export function groupBatchOutputs(sourceId: string, title = '本批产出'): string | null {
  const s = useCanvasStore.getState()
  const siblings = s.connections
    .filter((c) => c.from === sourceId && (c.kind ?? 'flow') === 'flow')
    .map((c) => s.nodes.find((n) => n.id === c.to))
    .filter(
      (n): n is ScvNode =>
        n !== undefined &&
        (n.type === 'image' || n.type === 'output') &&
        n.history_for === undefined &&
        n.slot_of === undefined &&
        !(n.id in s.running) &&
        (n.items ?? []).length > 0,
    )
  const ids = [...new Set(siblings.map((n) => n.id))]
  if (ids.length < 2) return null
  return groupSelection(ids, { title, silent: true })
}

/** 批量解组。逐个走 dissolveGroup，它们各自的 snapshot 会被 80ms 窗口合成一格 */
export function ungroupSelection(ids: string[]): void {
  const groups = useCanvasStore.getState().nodes.filter((n) => ids.includes(n.id) && n.type === 'group')
  for (const g of groups) dissolveGroup(g.id)
}

/* ==================== 级联执行（FR-464） ==================== */

/** 参与级联的边：**只认 input**。
 *
 *  蓝本（和 FR-464 初稿）写的是 input+flow，实测下来不能这么走：`flow` 是生成时
 *  系统自动补的血缘边，把它算进执行链，同一个 loop 每跑一次就会把上一次的产出节点
 *  也拉进来——第二趟链长翻倍、钱跟着翻倍，而用户从没表达过要重跑那些产出
 *  （M3 已知余项里记的「从 loop 出发会把之前的产出也算进链」就是这条）。
 *  只沿 input（用户手动连的「参考输入」）走之后，同一条链跑 N 次跑的是同一批节点，
 *  行为幂等，运行前那句「N 个图节点 × M 轮」也才是个稳定数。
 *  history 同样不参与（FR-462 原文）。 */
function chainEdges(nodes: ScvNode[], connections: CanvasConnection[]): CanvasConnection[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  return connections.filter((c) => {
    if ((c.kind ?? 'flow') !== 'input') return false
    const a = byId.get(c.from)
    const b = byId.get(c.to)
    return a !== undefined && b !== undefined && a.history_for === undefined && b.history_for === undefined
  })
}

/** 执行链：沿 input 边拓扑排序。
    - loop 起点：它的直接下游是 root，从 root 往下游铺开
    - 图节点起点（链尾）：把它的全部上游拉进来，从链头开始跑 */
export function cascadeChain(
  nodes: ScvNode[],
  connections: CanvasConnection[],
  startId: string,
): { order: string[]; edgeKeys: string[] } {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const start = byId.get(startId)
  if (start === undefined) return { order: [], edgeKeys: [] }
  const edges = chainEdges(nodes, connections)

  const member = new Set<string>()
  const queue: string[] = []
  if (start.type === 'loop') {
    for (const c of edges) if (c.from === startId) queue.push(c.to)
  } else {
    queue.push(startId)
  }
  while (queue.length > 0) {
    const id = queue.shift() as string
    if (member.has(id)) continue
    member.add(id)
    for (const c of edges) {
      if (start.type === 'loop') {
        if (c.from === id && !member.has(c.to)) queue.push(c.to)
      } else if (c.to === id && !member.has(c.from)) {
        queue.push(c.from)
      }
    }
  }
  // loop 自己不出图，成环时会被 BFS 带进来，摘掉
  if (start.type === 'loop') member.delete(startId)

  const sub = edges.filter((c) => member.has(c.from) && member.has(c.to))
  const indeg = new Map<string, number>()
  for (const id of member) indeg.set(id, 0)
  for (const c of sub) indeg.set(c.to, (indeg.get(c.to) ?? 0) + 1)
  const ready = [...member].filter((id) => (indeg.get(id) ?? 0) === 0)
  const order: string[] = []
  while (ready.length > 0) {
    const id = ready.shift() as string
    order.push(id)
    for (const c of sub) {
      if (c.from !== id) continue
      const left = (indeg.get(c.to) ?? 1) - 1
      indeg.set(c.to, left)
      if (left === 0) ready.push(c.to)
    }
  }
  // 有环时剩下的按发现顺序补在后面，别让整条链跑不起来
  for (const id of member) if (!order.includes(id)) order.push(id)
  return { order, edgeKeys: sub.map(connKey) }
}

/** 链上挂的 loop 节点：从链尾出发时也认它的轮数与串并行设置 */
function loopFor(nodes: ScvNode[], connections: CanvasConnection[], order: string[]): ScvNode | null {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const inChain = new Set(order)
  for (const c of connections) {
    // 与 chainEdges 同口径：loop 也只沿 input 边认亲，否则一条血缘边就能把轮数带进来
    if ((c.kind ?? 'flow') !== 'input' || !inChain.has(c.to)) continue
    const up = byId.get(c.from)
    if (up !== undefined && up.type === 'loop') return up
  }
  return null
}

/** 运行前能说出口的真实数字（AC-155）：这条链上有几个图节点、跑几轮、总共出几次图。
    只沿 input 边算，所以同一条链算多少次都是同一个数——这正是改掉 flow 之后
    「运行整条链」的提示才敢写死的原因。 */
export interface CascadePlan {
  imageNodes: number
  /** 当前真正会发起执行的节点；提示词、循环、分组等中继节点不计入。 */
  executableNodes: number
  rounds: number
  gens: number
  /** 链上是否挂了循环节点。count=1 时不能只靠 rounds 判断。 */
  hasLoop: boolean
  /** 与蓝本一致：只在链尾、且确有上游执行链或循环时显示级联入口。 */
  canRun: boolean
  /** 出图次数很大，跑之前先让人确认一次（不是拒绝） */
  needsConfirm: boolean
}

function isCascadeExecutable(node: ScvNode | undefined): boolean {
  return node !== undefined && isCascadeExecutableType(node.type)
}

/** 是否还有手动 input 边能走到下游执行节点。中间允许穿过 prompt/output/group 等中继。 */
function hasDownstreamCascadeNode(
  nodes: ScvNode[],
  connections: CanvasConnection[],
  startId: string,
): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const edges = chainEdges(nodes, connections)
  const seen = new Set([startId])
  const queue = edges.filter((edge) => edge.from === startId).map((edge) => edge.to)
  while (queue.length > 0) {
    const id = queue.shift() as string
    if (seen.has(id)) continue
    seen.add(id)
    if (isCascadeExecutable(byId.get(id))) return true
    for (const edge of edges) if (edge.from === id && !seen.has(edge.to)) queue.push(edge.to)
  }
  return false
}

function planOf(
  nodes: ScvNode[],
  connections: CanvasConnection[],
  startId: string,
  order: string[],
): CascadePlan {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const imageNodes = order.filter((id) => byId.get(id)?.type === 'image').length
  const executableNodes = order.filter((id) => {
    const type = byId.get(id)?.type
    return type === 'image' || type === 'llm' || type === 'modelscope' || type === 'video' || type === 'midjourney' || type === 'workflow'
  }).length
  const start = byId.get(startId)
  const loop = start?.type === 'loop' ? start : loopFor(nodes, connections, order)
  const hasLoop = loop !== null && loop !== undefined
  const rounds = loop === null || loop === undefined ? 1 : Math.max(1, Math.min(loop.count ?? 3, LOOP_MAX))
  const requestsPerRound = order.reduce((sum, id) => {
    const node = byId.get(id)
    if (node?.type === 'modelscope') {
      return sum + Math.max(1, Math.min(Math.round(node.ms_count ?? 1), MODELSCOPE_MAX_COUNT))
    }
    return node?.type === 'image' || node?.type === 'llm' || node?.type === 'video' || node?.type === 'midjourney' || node?.type === 'workflow'
      ? sum + 1
      : sum
  }, 0)
  const gens = requestsPerRound * rounds
  const canRun = start?.type === 'loop'
    ? executableNodes > 0
    : isCascadeExecutable(start) &&
      !hasDownstreamCascadeNode(nodes, connections, startId) &&
      executableNodes > 0 &&
      (executableNodes > 1 || hasLoop)
  return {
    imageNodes,
    executableNodes,
    rounds,
    gens,
    hasLoop,
    canRun,
    needsConfirm: gens > CASCADE_CONFIRM_GENS,
  }
}

export function cascadePlan(
  nodes: ScvNode[],
  connections: CanvasConnection[],
  startId: string,
): CascadePlan {
  return planOf(nodes, connections, startId, cascadeChain(nodes, connections, startId).order)
}

export interface RunCtx {
  canvasId: number
  order: string[]
  total: number
  vars: string[]
  /** 轮次编排（编号、步长、取图区间）。与配置弹窗的预演同源——
   *  两边各算一套的话，预演就是一份好看的谎言 */
  schedule: LoopSchedule[]
  /** 《总数》替换成的数：末轮编号，不是轮数（蓝本 ctx.total = endIndex） */
  endIndex: number
  /** 驱动这条链的循环节点。取图切片要沿它上溯 */
  loopId: string | null
  /** 失败重试的第一个节点沿用原轮次参考，避免重试时回落到旧图。 */
  retryRefs?: Record<string, number[]>
  /** 工作流失败重试还要冻结视频/音频引用；只有图片 ID 不够。 */
  retryMedia?: Record<string, CanvasItem[]>
  /** 第一次落图时入撤销栈，整条链算一步 */
  commitUndo: (skipId: string | null) => void
}

function patchCascadeNodes(
  ids: string[],
  patch: (node: ScvNode) => Partial<ScvNode>,
): void {
  if (ids.length === 0) return
  const wanted = new Set(ids)
  const state = useCanvasStore.getState()
  useCanvasStore.setState({
    nodes: state.nodes.map((node) =>
      wanted.has(node.id) ? { ...node, ...patch(node) } : node,
    ),
  })
  scheduleSave()
}

/** 级联取参：上游**本轮**的产图优先（这才是「链」的意思）；上游这一轮没出图
    就退回 M1 的静态取参（自身 items > 上游 items） */
/** 循环节点上游的**全部**图，按连线顺序拉平。
 *
 *  这里刻意不做 MAX_REFS 截断：截断要放在切片**之后**，否则第 11 张起
 *  永远切不到——而「逐张喂图」的常见用法恰恰是喂几十张。
 *  上游还是循环时递归穿透（蓝本 smartLoopInputImages 同款）。 */
function loopUpstreamImages(s: CanvasStore, loopId: string, seen = new Set<string>()): number[] {
  if (seen.has(loopId)) return []
  seen.add(loopId)
  const out: number[] = []
  for (const c of s.connections) {
    if (c.to !== loopId || (c.kind ?? 'flow') !== 'input') continue
    const from = s.nodes.find((n) => n.id === c.from)
    if (from === undefined) continue
    if (from.type === 'loop') {
      out.push(...loopUpstreamImages(s, from.id, seen))
      continue
    }
    for (const it of from.items ?? []) {
      if (it.asset_id !== undefined && !out.includes(it.asset_id)) out.push(it.asset_id)
    }
  }
  return out
}

function cascadeRefs(
  s: CanvasStore,
  node: ScvNode,
  outputs: Map<string, CanvasItem[]>,
  ctx: RunCtx,
  round: number,
): number[] {
  /* 逐张喂图：这一轮只带上游的其中几张，而不是每轮都把全部图一起送上去。
     切片区间由编排给（起始计数 + 序号×步长），越界就是取不到，不回绕。 */
  const slot = ctx.schedule[round - 1]?.slice
  if (slot !== null && slot !== undefined && ctx.loopId !== null) {
    const all = loopUpstreamImages(s, ctx.loopId)
    const sliced = all.slice(slot.from - 1, slot.from - 1 + slot.count)
    if (sliced.length > 0) return sliced.slice(0, MAX_REFS)
    // 切空了不静默回落到「全部图」——那会让最后几轮悄悄用错参考
    return []
  }

  const out: number[] = []
  for (const c of s.connections) {
    // 取参跟着执行链走：链只沿 input，本轮产出自然也只沿 input 往下传
    if (c.to !== node.id || (c.kind ?? 'flow') !== 'input') continue
    for (const it of outputs.get(c.from) ?? []) {
      if (it.asset_id === undefined || out.includes(it.asset_id) || out.length >= MAX_REFS) continue
      out.push(it.asset_id)
    }
  }
  if (out.length > 0) return out
  const retry = ctx.retryRefs?.[node.id]
  if (retry !== undefined) return retry.slice(0, MAX_REFS)
  return refAssetIds(s.nodes, s.connections, node.id)
}

function cascadeMediaRefs(
  s: CanvasStore,
  node: ScvNode,
  outputs: Map<string, CanvasItem[]>,
  ctx: RunCtx,
): CanvasItem[] {
  const runtime: CanvasItem[] = []
  const seen = new Set<string>()
  const push = (items: CanvasItem[]): void => {
    for (const item of items) {
      const key = item.asset_id !== undefined
        ? `image:${item.asset_id}`
        : item.media_asset_id !== undefined
          ? `${item.kind}:${item.media_asset_id}`
          : ''
      if (key === '' || seen.has(key)) continue
      seen.add(key)
      runtime.push({ ...item })
    }
  }
  for (const connection of s.connections) {
    if (connection.to !== node.id || (connection.kind ?? 'flow') !== 'input') continue
    push(outputs.get(connection.from) ?? [])
  }
  if (runtime.length > 0) return runtime
  const retry = ctx.retryMedia?.[node.id]
  if (retry !== undefined) return retry.map((item) => ({ ...item }))
  return refMediaItems(s.nodes, s.connections, node.id)
}

/** 这一轮这个节点用的提示词：上游提示词 + 自己的草稿 + 本轮的轮次提示词，
    最后统一替换占位符。轮数多于 variable_prompts 条数时循环取 */
function roundPrompt(s: CanvasStore, node: ScvNode, ctx: RunCtx, round: number): string {
  /* round 是 1 基轮序；真正写进提示词的是**编排里的编号**（起始计数 + 序号×步长）。
     这两个数在「起始计数 = 1 且没开逐张喂图」时相等，所以搞混了不会立刻显形，
     只在用户改了起始计数或每轮张数之后才对不上（而那时他会以为是模型的问题）。 */
  const slot = ctx.schedule[round - 1]
  const index = slot?.index ?? round
  const ordinal = slot?.ordinal ?? round - 1

  /* 循环节点这一轮贡献什么：**上游中继的提示词** + **它自己的轮次提示词**，
     两段都按轮序取模轮换（蓝本 smartLoopPrompt 同款）。
     位置很关键——它由 composePrompt 在遍历入边时 push，因此排在
     本节点自己的草稿**之前**。蓝本就是这个顺序（上游 → 本节点 composer 草稿），
     而靠后的指令对模型权重更高，把轮次词甩到最后会让每轮的差异被本节点草稿盖住。 */
  const contribute = (loopId: string): string => {
    const upstream = loopPromptItems(s.nodes, s.connections, loopId)
    const seg: string[] = []
    if (upstream.length > 0) seg.push(upstream[ordinal % upstream.length])
    if (ctx.vars.length > 0) seg.push(ctx.vars[ordinal % ctx.vars.length].trim())
    return seg.filter((x) => x !== '').join('\n\n')
  }

  const body = composePrompt(s.nodes, s.connections, node.id, contribute)
  return applyRoundVars(body, index, ctx.endIndex)
}

function nodeLabel(node: ScvNode): string {
  return node.title ?? (node.type === 'image' ? '图片节点' : node.type)
}

/** 这一轮这个节点的落点：第一轮且源节点还没图 → 落回自身；否则在源节点下方
    按轮次开一行新节点（沿用 M1 的分支输出 + flow 边） */
/** 找这个源节点第 `round` 轮的输出槽。
 *
 *  槽位靠 `slot_of` + `slot_round` 两个**持久化**字段认领，所以跨会话也复用：
 *  昨天跑过的第 3 轮，今天重跑还落在同一个节点上，而不是又建一排新的。 */
export function findSlot(nodes: ScvNode[], sourceId: string, round: number): ScvNode | undefined {
  return nodes.find((n) => n.slot_of === sourceId && n.slot_round === round)
}

function prepareTarget(
  node: ScvNode,
  round: number,
  total: number,
  outputType: 'image' | 'video' = 'image',
): { id: string; branch: boolean } {
  if (node.type === outputType && round === 1 && (node.items ?? []).length === 0) {
    return { id: node.id, branch: false }
  }
  const s = useCanvasStore.getState()

  /* **先找已有的槽位再考虑新建**（蓝本 `loopOutputSlotForRound`，smart-canvas.js:14741）。
     槽位靠两个持久化字段认领：`slot_of`（谁的产出）+ `slot_round`（第几轮）。

     没有这一步的话，同一条链每跑一次就往右堆一整排新节点——跑三次画布上就是
     三排一模一样的东西，用户得自己一个个删。蓝本把这两个字段存进画布 JSON，
     所以跨会话也复用同一批槽位，这里照抄。 */
  const slot = findSlot(s.nodes, node.id, round)
  if (slot !== undefined) {
    // 复用时先清空旧图：这一轮是重跑，不是往上追加
    s.updateNode(slot.id, { items: [], prompt_draft: node.prompt_draft })
    return { id: slot.id, branch: false }
  }

  const id = newNodeId()
  const w = node.w ?? IMAGE_NODE_W
  /* 一轮一行，落点避开已有节点。
     原来这里是 `while (Math.abs(n.y - y) < 60 && Math.abs(n.x - x) < w) x += w + 24`：
     纵向只看 60px、完全不看对方多高，一个 440 高的图片节点站在那一行上照样判成
     「没占」，新节点直接落在它身上。现在交给内核的落点避让，按真实矩形算。 */
  const spot = freeSpotForNode(
    { type: 'output', w, items: [] },
    { x: node.x, y: node.y + ROUND_DY * round },
  )
  s.addNode({
    id,
    type: 'output',
    x: spot.x,
    y: spot.y,
    w,
    title: total > 1 ? `第 ${round} 轮` : '级联输出',
    prompt_draft: node.prompt_draft,
    ...(outputType === 'image'
      ? { run_settings: { ...(node.run_settings ?? {}) } }
      : { video_settings: { ...(node.video_settings ?? {}) } }),
    items: [],
    slot_of: node.id,
    slot_round: round,
  })
  s.addConnection({ from: node.id, to: id, kind: 'flow' })
  return { id, branch: true }
}

async function cascadeVideoAdapter(node: ScvNode): Promise<CanvasVideoAdapter> {
  const settings = node.video_settings ?? {}
  const deploymentId = settings.deployment_id
  if (deploymentId !== null && deploymentId !== undefined) try {
    const deployments = await apiConfig.modelDeployments({ media_type: 'video', enabled: true })
    const adapter = deployments.find((deployment) => deployment.id === deploymentId)?.adapter_type
    if (adapter === 'volcengine' || adapter === 'jimeng') return adapter
  } catch {
    // 目录暂时不可用时，再用导入文档保留的提示判断。
  }
  const hint = `${settings.provider_hint ?? ''} ${settings.model_hint ?? ''}`.toLowerCase()
  if (hint.includes('jimeng') || hint.includes('dreamina') || hint.includes('即梦')) return 'jimeng'
  if (hint.includes('volc') || hint.includes('ark') || hint.includes('seedance')) return 'volcengine'
  return 'openai'
}

/** 从失败节点向下游拓扑排序；仅沿用户手连的 input 边。 */
export function cascadeRetryOrder(
  nodes: ScvNode[],
  connections: CanvasConnection[],
  startId: string,
): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  if (!byId.has(startId)) return []
  const edges = chainEdges(nodes, connections)
  const members = new Set<string>()
  const queue = [startId]
  while (queue.length > 0) {
    const id = queue.shift() as string
    if (members.has(id)) continue
    members.add(id)
    for (const edge of edges) if (edge.from === id && !members.has(edge.to)) queue.push(edge.to)
  }
  const incoming = new Map([...members].map((id) => [id, 0]))
  for (const edge of edges) {
    if (members.has(edge.from) && members.has(edge.to)) {
      incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1)
    }
  }
  const ready = [...members].filter((id) => (incoming.get(id) ?? 0) === 0)
  const order: string[] = []
  while (ready.length > 0) {
    const id = ready.shift() as string
    order.push(id)
    for (const edge of edges) {
      if (edge.from !== id || !members.has(edge.to)) continue
      const left = (incoming.get(edge.to) ?? 1) - 1
      incoming.set(edge.to, left)
      if (left === 0) ready.push(edge.to)
    }
  }
  for (const id of members) if (!order.includes(id)) order.push(id)
  return order
}

type FlowValue = unknown

interface CompiledPrompt {
  value: FlowValue
  dependencies: string[]
}

interface CompiledCascade {
  definition: StudioFlowDefinition
  sourceContext: Record<string, unknown>
}

/** 把画布交给服务端编译。
 *
 *  下面那两个 `compile*Run` 留作**预演**：用户点「运行」之前能在本地看到会跑成
 *  什么样，并顺手把输出槽建到画布上。真正提交的定义以服务端为准——凭据能不能用
 *  只有那边说得准，而且定时触发和服务端重跑根本没有浏览器。 */
async function compileOnServer(
  canvasId: number,
  body: Record<string, unknown>,
): Promise<CompiledCascade> {
  const compiled = await request<{
    definition: StudioFlowDefinition
    source_context: Record<string, unknown>
  }>(`/studio/canvases/${canvasId}/compile`, jsonBody('POST', body))
  return { definition: compiled.definition, sourceContext: compiled.source_context }
}

/** 预演算出的落点：画布节点 → 轮次 → 落点节点 id。
 *
 *  槽位是画布编辑的事（要摆位置、要能撤销），服务端不建也不该建，所以把预演的
 *  结果带过去。少了它，服务端只能把产物落回源节点，第 2 轮起就互相覆盖。 */
function compiledTargets(compiled: CompiledCascade): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  const raw = compiled.sourceContext.node_map
  if (typeof raw !== 'object' || raw === null) return out
  for (const value of Object.values(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue
    const meta = value as Record<string, unknown>
    if (typeof meta.canvas_node_id !== 'string' || typeof meta.target_node_id !== 'string') continue
    ;(out[meta.canvas_node_id] ??= {})[String(meta.round)] = meta.target_node_id
  }
  return out
}

function flowNodeKey(round: number, orderIndex: number, copy = 0): string {
  return `r${round}_n${orderIndex}${copy === 0 ? '' : `_c${copy}`}`
}

function taskResultRef(flowNodeId: string, path?: string): Record<string, unknown> {
  return path === undefined ? { $node: flowNodeId } : { $node: flowNodeId, path }
}

function artifactProjection(
  flowNodeIds: string[],
  fallback: CanvasItem[],
  options: Record<string, unknown>,
): Record<string, unknown> {
  return {
    $artifacts: flowNodeIds.map((id) => taskResultRef(id)),
    fallback: fallback.map((item) => ({ ...item })),
    ...options,
  }
}

function compiledSourcesInto(
  state: CanvasStore,
  nodeId: string,
  compiled: Map<string, string[]>,
): string[] {
  const out: string[] = []
  for (const connection of state.connections) {
    if (connection.to !== nodeId || (connection.kind ?? 'flow') !== 'input') continue
    for (const flowNodeId of compiled.get(connection.from) ?? []) {
      if (!out.includes(flowNodeId)) out.push(flowNodeId)
    }
  }
  return out
}

function compiledPrompt(
  state: CanvasStore,
  node: ScvNode,
  ctx: RunCtx,
  round: number,
  compiled: Map<string, string[]>,
): CompiledPrompt {
  const byId = new Map(state.nodes.map((candidate) => [candidate.id, candidate]))
  const dependencies: string[] = []
  const parts: FlowValue[] = []
  const pushText = (text: string | undefined): void => {
    const value = (text ?? '').trim()
    if (value !== '') parts.push(value)
  }
  const take = (candidate: ScvNode | undefined): void => {
    if (candidate === undefined) return
    if (candidate.type === 'loop') {
      const slot = ctx.schedule[round - 1]
      const ordinal = slot?.ordinal ?? round - 1
      const values = loopPromptItems(state.nodes, state.connections, candidate.id)
      if (values.length > 0) pushText(values[ordinal % values.length])
      if (ctx.vars.length > 0) pushText(ctx.vars[ordinal % ctx.vars.length])
      return
    }
    if (candidate.type === 'prompt') {
      pushText(candidate.text)
      return
    }
    if (candidate.type === 'llm') {
      const flowNodeId = compiled.get(candidate.id)?.[0]
      if (flowNodeId !== undefined) {
        parts.push(taskResultRef(flowNodeId, 'text'))
        dependencies.push(flowNodeId)
      } else {
        pushText(candidate.llm_output)
      }
      return
    }
    if (candidate.type !== 'group') return
    for (const memberId of candidate.member_ids ?? []) take(byId.get(memberId))
  }
  for (const connection of state.connections) {
    if (connection.to !== node.id || (connection.kind ?? 'flow') === 'history') continue
    take(byId.get(connection.from))
  }
  pushText(node.prompt_draft)

  let value: FlowValue = parts.length <= 1
    ? parts[0] ?? ''
    : { $concat: parts, separator: '\n' }
  const refs = node.prompt_draft_refs ?? []
  const droppedReplacements: Record<string, string> = {}
  for (const [index, reference] of refs.slice(MAX_REFS).entries()) {
    droppedReplacements[`图${MAX_REFS + index + 1}`] = `@${reference.label}`
  }
  if (Object.keys(droppedReplacements).length > 0) {
    value = typeof value === 'string'
      ? Object.entries(droppedReplacements).reduce(
          (text, [source, target]) => text.replaceAll(source, target),
          value,
        )
      : { $replace: value, values: droppedReplacements }
  }
  if (refs.length > 0 && parts.length > 0) {
    const table = refs.slice(0, MAX_REFS)
      .map((reference, index) => `图${index + 1}：${reference.label}（asset ${reference.asset_id}）`)
      .join('\n')
    if (table !== '') {
      value = typeof value === 'string'
        ? `${table}\n\n用户需求：${value}`
        : {
            $concat: [
              table,
              { $concat: ['用户需求：', value], separator: '' },
            ],
            separator: '\n\n',
          }
    }
  }
  const replacements: Record<string, string> = {
    '《计数》': String(ctx.schedule[round - 1]?.index ?? round),
    '《总数》': String(ctx.endIndex),
    '《进度》': `${ctx.schedule[round - 1]?.index ?? round}/${ctx.endIndex}`,
  }
  value = typeof value === 'string'
    ? Object.entries(replacements).reduce(
        (text, [source, target]) => text.replaceAll(source, target),
        value,
      )
    : { $replace: value, values: replacements }
  return { value, dependencies: [...new Set(dependencies)] }
}

function cascadeTaskContext(
  ctx: RunCtx,
  node: ScvNode,
  round: number,
  target: { id: string; branch: boolean } | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const targetNode = target === null
    ? undefined
    : useCanvasStore.getState().nodes.find((candidate) => candidate.id === target.id)
  return {
    canvas_id: ctx.canvasId,
    node_id: target?.id ?? node.id,
    ...(target !== null && target.id !== node.id ? { source_node_id: node.id } : {}),
    ...(target?.branch === true && targetNode !== undefined
      ? { planned_node: structuredClone(targetNode), pending_target: true }
      : {}),
    execution_group_id: crypto.randomUUID().replaceAll('-', ''),
    cascade_node_id: node.id,
    cascade_round: round,
    cascade_total: ctx.total,
    ...extra,
  }
}

function workflowRunFields(
  detail: ExecutableWorkflowDetail,
  node: ScvNode,
  staticMedia: CanvasItem[],
  sourceFlowNodeIds: string[],
  prompt: CompiledPrompt,
  staticPrompt: string,
): { fields: Record<string, unknown>; missing: string[]; context: Record<string, unknown> } {
  const prepared = prepareCanvasWorkflowRun(detail, node, staticMedia, staticPrompt)
  const fields = { ...prepared.fields }
  const schemaFields = workflowFields(detail).filter(
    (field) => detail.provider === 'comfyui' || field.enabled !== false,
  )
  const mediaOffsets = { image: 0, video: 0, audio: 0 }
  const mode = workflowTimelineMode(detail.title ?? node.title)
  const activeMiniMaxSegment = mode === 'minimax'
    ? node.workflow_timeline?.segments.find(
        (segment) => segment.id === node.workflow_timeline?.selected_id,
      ) ?? node.workflow_timeline?.segments[0]
    : undefined
  const ownsMiniMaxReferences = (activeMiniMaxSegment?.references?.length ?? 0) > 0
    || activeMiniMaxSegment?.asset_id !== undefined
  for (const [index, field] of schemaFields.entries()) {
    const id = workflowFieldId(field, index)
    const kind = workflowFieldMediaKind(field)
    const explicit = node.workflow_values?.[id]
    if (kind !== null) {
      const offset = mediaOffsets[kind]
      mediaOffsets[kind] += 1
      if (explicit !== undefined && String(explicit).trim() !== '') continue
      if (mode === 'minimax' && ['f_reference_image', 'f_minimax_references'].includes(id)) {
        continue
      }
      if (mode === 'minimax' && detail.provider === 'runninghub') {
        if (ownsMiniMaxReferences) continue
        fields[id] = artifactProjection(sourceFlowNodeIds, staticMedia, {
          kinds: [kind],
          field: 'ref',
          offset,
          limit: 1,
          scalar: true,
          default: '',
          fallback_mode: 'empty-source',
        })
        continue
      }
      fields[id] = artifactProjection(sourceFlowNodeIds, staticMedia, {
        kinds: [kind],
        field: 'ref',
        offset,
        limit: 1,
        scalar: true,
        default: '',
        fallback_mode: 'empty-source',
      })
      continue
    }
    if (explicit === undefined && (
      (field.bind_prompt === true
        && (mode !== 'minimax' || (activeMiniMaxSegment?.prompt ?? '').trim() === ''))
      || (mode === 'minimax'
        && detail.provider === 'runninghub'
        && (activeMiniMaxSegment?.prompt ?? '').trim() === ''
        && minimaxRunningHubFieldRole(field) === 'prompt')
    )) fields[id] = prompt.value
  }

  if (mode === 'minimax') {
    const timeline = node.workflow_timeline
    const active = timeline?.segments.find((segment) => segment.id === timeline.selected_id)
      ?? timeline?.segments[0]
    const ownsReferences = (active?.references?.length ?? 0) > 0 || active?.asset_id !== undefined
    if (!ownsReferences && detail.provider === 'comfyui') {
      fields.f_reference_image = artifactProjection(sourceFlowNodeIds, staticMedia, {
        kinds: ['image'],
        field: 'ref',
        limit: 1,
        scalar: true,
        default: '',
        fallback_mode: 'empty-source',
      })
      fields.f_minimax_references = artifactProjection(sourceFlowNodeIds, staticMedia, {
        kinds: ['image', 'video', 'audio'],
        field: 'typed_ref',
        limits: { image: 9, video: 3, audio: 3 },
        fallback_mode: 'empty-source',
      })
    }
    if ((active?.prompt ?? '').trim() === '' && detail.provider === 'comfyui') {
      fields.f_prompt = prompt.value
    }
  }
  return { fields, missing: prepared.missingMedia, context: prepared.sourceContext }
}

/** 把成套方案冻结成一次性服务端 DAG。
 *
 * 这里刻意保留原 `runSetPlan` 的两种语义：
 * - consistent：每步依赖前一步，且把前一步产物放在初始参考图之前；
 * - varied：每步只看初始参考图，在服务端并发池中独立执行。 */
export function compileSetPlanRun(
  state: CanvasStore,
  sourceId: string,
  plan: SetPlan,
  slots: string[],
): CompiledCascade {
  const source = state.nodes.find((node) => node.id === sourceId)
  if (source === undefined || source.type !== 'image') throw new Error('成套出图的源节点已不存在')
  if (state.canvasId === null) throw new Error('画布尚未加载')
  const steps = plan.steps.filter((step) => step.prompt.trim() !== '')
  if (steps.length === 0 || slots.length !== steps.length) throw new Error('成套方案与输出槽不匹配')

  const settings = source.run_settings ?? {}
  const baseFallback = refAssetIds(state.nodes, state.connections, sourceId).map((asset_id) => ({
    kind: 'image' as const,
    asset_id,
  }))
  const consistent = plan.intent !== 'varied'
  const definition: StudioFlowDefinition = { nodes: [], edges: [] }
  const nodeMap: Record<string, {
    canvas_node_id: string
    target_node_id: string
    round: number
    label: string
  }> = {}
  const roundNodes: Record<string, string[]> = {}
  const executionGroupId = crypto.randomUUID().replaceAll('-', '')
  let previousId: string | null = null

  for (const [index, step] of steps.entries()) {
    const round = index + 1
    const flowNodeId = `set_${round}`
    const targetId = slots[index]
    const target = state.nodes.find((node) => node.id === targetId)
    if (target === undefined) throw new Error(`第 ${round} 张的输出槽已不存在`)
    const artifactSources = consistent && previousId !== null ? [previousId] : []
    const orderedReferences = [
      ...artifactSources.map((flowNodeId) => taskResultRef(flowNodeId)),
      ...baseFallback.map((item) => ({ ...item })),
    ]
    definition.nodes.push({
      id: flowNodeId,
      tool_id: 'infinite-canvas',
      operation: 'image.auto',
      input: {
        prompt: step.prompt,
        // fallback 的语义是“没有上一步产物时才启用”，不能表达旧交互要求的
        // “上一步产物 + 初始参考”。二者必须进入同一有序 artifact 集合。
        ref_asset_ids: {
          $artifacts: orderedReferences,
          kinds: ['image'],
          field: 'asset_id',
          limit: MAX_REFS,
        },
        deployment_id: settings.deployment_id ?? null,
        alias: IMAGE_FREE_CAPABILITY,
        target_key: 'free',
        style_key: 'none',
        app_key: 'consistent_edit',
        size: sizeParam(settings.size),
        tier: '1k',
        quality: normalizeQuality(settings.quality),
        n: 1,
        options: {},
      },
      source_context: {
        canvas_id: state.canvasId,
        node_id: targetId,
        source_node_id: sourceId,
        execution_group_id: executionGroupId,
        set_plan_step_id: step.id,
        set_plan_round: round,
        set_plan_total: steps.length,
        planned_node: structuredClone(target),
        pending_target: true,
      },
    })
    if (consistent && previousId !== null) {
      definition.edges.push({ from: previousId, to: flowNodeId })
    }
    nodeMap[flowNodeId] = {
      canvas_node_id: targetId,
      target_node_id: targetId,
      round,
      label: step.title || `第 ${round} 张`,
    }
    roundNodes[String(round)] = [flowNodeId]
    previousId = flowNodeId
  }

  const edgeKeys = slots.map((targetId) => connKey({ from: sourceId, to: targetId, kind: 'flow' }))
  return {
    definition,
    sourceContext: {
      kind: 'canvas_set',
      canvas_id: state.canvasId,
      start_id: sourceId,
      loop_id: null,
      mode: consistent ? 'serial' : 'parallel',
      total: steps.length,
      max_parallel_tasks: consistent
        ? 1
        : cascadePoolSize(undefined, steps.length),
      edge_keys: edgeKeys,
      node_map: nodeMap,
      round_nodes: roundNodes,
      set_plan: {
        goal: plan.goal,
        intent: plan.intent,
        step_ids: steps.map((step) => step.id),
      },
    },
  }
}

export async function compileCascadeRun(
  state: CanvasStore,
  chain: { order: string[]; edgeKeys: string[] },
  ctx: RunCtx,
  mode: LoopMode,
  parallelLimit: number | undefined,
  rounds?: number[],
): Promise<CompiledCascade> {
  const byId = new Map(state.nodes.map((node) => [node.id, node]))
  const workflowDetails = new Map<number, ExecutableWorkflowDetail>()
  const workflowCredentials = (await apiConfig.credentials('workflow')).filter(
    (credential) => credential.enabled,
  )
  const videoAdapters = new Map<string, CanvasVideoAdapter>()
  for (const nodeId of chain.order) {
    const node = byId.get(nodeId)
    if (node?.type === 'workflow' && node.workflow_id !== undefined && !workflowDetails.has(node.workflow_id)) {
      workflowDetails.set(node.workflow_id, await apiStudio.workflow(node.workflow_id))
    }
    if (node?.type === 'video') videoAdapters.set(node.id, await cascadeVideoAdapter(node))
  }

  const definition: StudioFlowDefinition = { nodes: [], edges: [] }
  const edges = new Set<string>()
  const addEdge = (from: string, to: string): void => {
    if (from === to) return
    const key = `${from}\u0000${to}`
    if (edges.has(key)) return
    edges.add(key)
    definition.edges.push({ from, to })
  }
  const nodeMap: Record<string, { canvas_node_id: string; target_node_id: string; round: number; label: string }> = {}
  const roundNodes: Record<string, string[]> = {}
  let serialTail: string[] = []
  let maxNodeFanout = 1

  // 默认编全部轮次；失败重试只编失败那一轮，轮号保持原值，槽位与提示词编号才对得上
  const roundList = rounds ?? Array.from({ length: ctx.total }, (_, index) => index + 1)
  for (const round of roundList) {
    const compiled = new Map<string, string[]>()
    let previous = mode === 'serial' ? [...serialTail] : []
    for (const [orderIndex, nodeId] of ctx.order.entries()) {
      const node = byId.get(nodeId)
      if (node === undefined || !isCascadeExecutable(node)) continue
      const prompt = compiledPrompt(state, node, ctx, round, compiled)
      const staticPrompt = roundPrompt(state, node, ctx, round)
      const directSources = compiledSourcesInto(state, node.id, compiled)
      const dependencies = [...new Set([...previous, ...directSources, ...prompt.dependencies])]
      const staticRefs = cascadeRefs(state, node, new Map(), ctx, round)
      const staticMedia = cascadeMediaRefs(state, node, new Map(), ctx)
      const imageFallback = staticRefs.map((asset_id) => ({ kind: 'image' as const, asset_id }))
      const imageSources = ctx.schedule[round - 1]?.slice !== null && ctx.loopId !== null
        ? []
        : directSources
      const imageIds = artifactProjection(imageSources, imageFallback, {
        kinds: ['image'],
        field: 'asset_id',
        limit: MAX_REFS,
      })
      const created: string[] = []
      const addNode = (
        copy: number,
        operation: string,
        input: Record<string, unknown>,
        sourceContext: Record<string, unknown>,
      ): string => {
        const id = flowNodeKey(round, orderIndex, copy)
        definition.nodes.push({
          id,
          tool_id: 'infinite-canvas',
          operation,
          input,
          source_context: sourceContext,
        })
        for (const dependency of dependencies) addEdge(dependency, id)
        created.push(id)
        nodeMap[id] = {
          canvas_node_id: node.id,
          target_node_id: String(sourceContext.node_id ?? node.id),
          round,
          label: nodeLabel(node),
        }
        ;(roundNodes[String(round)] ??= []).push(id)
        return id
      }

      if (node.type === 'llm') {
        const fallback = applyRoundVars(node.llm_input ?? '', ctx.schedule[round - 1]?.index ?? round, ctx.endIndex).trim()
        addNode(0, 'chat.general', {
          prompt: { $coalesce: [prompt.value, fallback] },
          system_prompt: node.llm_system_enabled === true ? node.llm_system_prompt ?? '' : '',
          messages: [],
          image_asset_ids: artifactProjection(imageSources, imageFallback, {
            kinds: ['image'],
            field: 'asset_id',
            limit: 4,
          }),
          video_media_asset_ids: artifactProjection(directSources, staticMedia, {
            kinds: ['video'],
            field: 'media_asset_id',
            limit: 3,
          }),
          deployment_id: node.llm_deployment_id ?? null,
          temperature: node.llm_temperature ?? 0.7,
        }, cascadeTaskContext(ctx, node, round, null))
      } else if (node.type === 'modelscope') {
        if (node.ms_deployment_id === null || node.ms_deployment_id === undefined || node.ms_deployment_id <= 0) {
          throw new Error(`「${nodeLabel(node)}」没有可用的 ModelScope 部署`)
        }
        const count = Math.max(1, Math.min(Math.round(node.ms_count ?? 1), MODELSCOPE_MAX_COUNT))
        const target = prepareTarget(node, round, ctx.total)
        for (let copy = 0; copy < count; copy += 1) {
          addNode(copy, 'image.generate', {
            prompt: prompt.value,
            deployment_id: node.ms_deployment_id,
            alias: IMAGE_FREE_CAPABILITY,
            target_key: 'free',
            style_key: 'none',
            size: sizeParam(node.ms_size ?? '1024x1024'),
            tier: '1k',
            quality: normalizeQuality(node.run_settings?.quality),
            n: 1,
            options: {
              ...modelScopeJobOptions(node, []),
              ref_asset_ids: artifactProjection(imageSources, imageFallback, {
                kinds: ['image'],
                field: 'asset_id',
                limit: MODELSCOPE_MAX_REFS,
              }),
            },
          }, cascadeTaskContext(ctx, node, round, target))
        }
      } else if (node.type === 'image') {
        const target = prepareTarget(node, round, ctx.total)
        addNode(0, 'image.auto', {
          prompt: prompt.value,
          ref_asset_ids: imageIds,
          deployment_id: node.run_settings?.deployment_id ?? null,
          alias: IMAGE_FREE_CAPABILITY,
          target_key: 'free',
          style_key: 'none',
          app_key: 'consistent_edit',
          size: sizeParam(node.run_settings?.size),
          tier: '1k',
          quality: normalizeQuality(node.run_settings?.quality),
          n: 1,
          options: {},
        }, cascadeTaskContext(ctx, node, round, target))
      } else if (node.type === 'midjourney') {
        const deploymentId = node.mj_deployment_id
        if (deploymentId === null || deploymentId === undefined || deploymentId <= 0) {
          throw new Error(`「${nodeLabel(node)}」没有可用的 Midjourney 部署`)
        }
        const target = prepareTarget(node, round, ctx.total)
        addNode(0, 'midjourney.generate', {
          deployment_id: deploymentId,
          mode: node.mj_mode ?? 'imagine',
          prompt: prompt.value,
          size: node.mj_size ?? '1:1',
          version: node.mj_version ?? '8.2',
          speed: node.mj_speed ?? 'relax',
          reference_asset_ids: artifactProjection(imageSources, imageFallback, {
            kinds: ['image'],
            field: 'asset_id',
            limit: MIDJOURNEY_MAX_REFS,
          }),
          options: {},
        }, cascadeTaskContext(ctx, node, round, target))
      } else if (node.type === 'video') {
        const settings = node.video_settings ?? {}
        const deploymentId = settings.deployment_id
        if (deploymentId === null || deploymentId === undefined || deploymentId <= 0) {
          throw new Error(`「${nodeLabel(node)}」没有可用的视频部署`)
        }
        const adapter = videoAdapters.get(node.id) ?? 'openai'
        const referenceMode = settings.reference_mode ?? 'first_frame'
        const roles = referenceMode === 'first_last'
          ? ['first_frame', 'last_frame']
          : referenceMode === 'first_frame'
            ? ['first_frame']
            : []
        const referenceLimit = adapter === 'openai'
          ? 1
          : referenceMode === 'first_last'
            ? 2
            : referenceMode === 'multimodal'
              ? VIDEO_MULTIMODAL_MAX_REFS
              : VIDEO_MULTIFRAME_MAX_REFS
        const mediaSources = directSources
        const possibleReferences = imageSources.length > 0 || staticRefs.length > 0 || mediaSources.length > 0 || staticMedia.length > 0
        const target = prepareTarget(node, round, ctx.total, 'video')
        addNode(0, 'video.generate', {
          deployment_id: deploymentId,
          prompt: prompt.value,
          duration: settings.duration ?? 4,
          aspect_ratio: settings.aspect_ratio ?? '16:9',
          resolution: normalizedVideoResolution(
            settings.resolution,
            adapter,
            settings.model_hint,
            referenceMode,
          ),
          references: artifactProjection(imageSources, imageFallback, {
            kinds: ['image'],
            field: 'video_reference',
            roles,
            limit: referenceLimit,
          }),
          media_references: adapter === 'jimeng'
            ? artifactProjection(mediaSources, staticMedia, {
                kinds: ['video', 'audio'],
                field: 'video_media_reference',
                limits: { video: 3, audio: 3 },
                limit: 6,
              })
            : [],
          options: videoRequestOptions(settings, adapter, possibleReferences),
        }, cascadeTaskContext(ctx, node, round, target))
      } else if (node.type === 'workflow') {
        if (node.workflow_id === undefined) throw new Error(`「${nodeLabel(node)}」没有绑定工作流`)
        const detail = workflowDetails.get(node.workflow_id)
        if (detail === undefined) throw new Error(`工作流 ${node.workflow_id} 不存在`)
        const credentialId = workflowCredentials.find(
          (credential) => credential.id === node.workflow_credential_id && credential.provider_type === detail.provider,
        )?.id ?? workflowCredentials.find((credential) => credential.provider_type === detail.provider)?.id
        if (credentialId === undefined) throw new Error(`没有可用的 ${detail.provider} 工作流凭据`)
        const prepared = workflowRunFields(
          detail,
          node,
          staticMedia,
          directSources,
          prompt,
          staticPrompt,
        )
        if (prepared.missing.length > 0 && directSources.length === 0) {
          throw new Error(`「${nodeLabel(node)}」缺少必填媒体：${prepared.missing.join('、')}`)
        }
        addNode(0, 'workflow.run', {
          workflow_id: node.workflow_id,
          credential_id: credentialId,
          fields: prepared.fields,
          use_wallet: node.workflow_use_wallet ?? false,
          instance_type: node.workflow_instance_type ?? '',
        }, cascadeTaskContext(ctx, node, round, null, prepared.context))
      }
      if (created.length > 0) {
        maxNodeFanout = Math.max(maxNodeFanout, created.length)
        compiled.set(node.id, created)
        previous = [...created]
      }
    }
    if (mode === 'serial') serialTail = [...previous]
  }

  if (definition.nodes.length === 0) throw new Error('这条链没有可提交的工具节点')
  return {
    definition,
    sourceContext: {
      kind: 'canvas_cascade',
      canvas_id: ctx.canvasId,
      start_id: ctx.order.at(-1) ?? '',
      loop_id: ctx.loopId,
      mode,
      total: ctx.total,
      max_parallel_tasks: mode === 'serial'
        ? maxNodeFanout
        : Math.min(512, cascadePoolSize(parallelLimit, ctx.total) * maxNodeFanout),
      edge_keys: chain.edgeKeys,
      node_map: nodeMap,
      round_nodes: roundNodes,
    },
  }
}

const trackedCascadeRuns = new Set<string>()
const FLOW_RUN_ACTIVE = new Set(['queued', 'running', 'recovering'])

/** 把 FlowRun checkpoint 里的终态产物投影到每个冻结的画布落点。
 *
 * 同签名图片请求在服务端只会创建一个 StudioTask，但多个 DAG 节点仍各自保留
 * checkpoint。这里按 node_map 逐个落图，因此复用不会牺牲任一分支；刷新后也
 * 不依赖最先发起任务的 source_context 才能找回其他落点。 */
export function landCascadeCheckpointOutputs(run: StudioFlowRun, canvasId: number): number {
  const state = useCanvasStore.getState()
  if (state.canvasId !== canvasId) return 0
  const { nodeMap } = cascadeRunMetadata(run)
  let landed = 0
  for (const [flowNodeId, checkpoint] of Object.entries(run.checkpoint.nodes)) {
    if (!['succeeded', 'partial'].includes(checkpoint.status)) continue
    const targetId = nodeMap[flowNodeId]?.target_node_id
    if (targetId === undefined) continue
    const target = useCanvasStore.getState().nodes.find((node) => node.id === targetId)
    if (target === undefined || !['image', 'video', 'output'].includes(target.type)) continue
    const items = imageResultItems(checkpoint.result)
    const projected = items.length > 0 ? items : videoResultItems(checkpoint.result)
    if (projected.length === 0) continue
    const merged = mergeItems(target.items, projected)
    if (merged.length === (target.items ?? []).length) continue
    useCanvasStore.getState().updateNode(targetId, { items: merged })
    landed += projected.length
  }
  return landed
}

function projectCascadeRun(run: StudioFlowRun, canvasId: number): void {
  const state = useCanvasStore.getState()
  if (state.canvasId !== canvasId) return
  const { nodeMap, edgeKeys } = cascadeRunMetadata(run)
  const ranks: Record<string, number> = { done: 1, queued: 2, running: 3, failed: 4 }
  const projected = new Map<string, { status: 'done' | 'queued' | 'running' | 'failed'; error: string; round: number }>()
  for (const [flowNodeId, checkpoint] of Object.entries(run.checkpoint.nodes)) {
    const meta = nodeMap[flowNodeId]
    if (meta === undefined) continue
    const status = ['failed', 'cancelled'].includes(checkpoint.status)
      ? 'failed'
      : FLOW_NODE_ACTIVE.has(checkpoint.status)
        ? 'running'
        : checkpoint.status === 'pending'
          ? 'queued'
          : 'done'
    const previous = projected.get(meta.canvas_node_id)
    if (previous === undefined || ranks[status] >= ranks[previous.status]) {
      projected.set(meta.canvas_node_id, {
        status,
        error: checkpoint.error ?? '',
        round: meta.round,
      })
    }
  }
  useCanvasStore.setState({
    cascade: cascadeStateFromRun(run),
    edgeStates: Object.fromEntries(edgeKeys.map((key) => [
      key,
      run.status === 'succeeded' || run.status === 'partial'
        ? 'done'
        : FLOW_RUN_ACTIVE.has(run.status)
          ? 'active'
          : 'wait',
    ] as const)),
    nodes: state.nodes.map((node) => {
      const value = projected.get(node.id)
      if (value === undefined) return node
      return {
        ...node,
        cascade_status: value.status,
        cascade_error: value.error,
        cascade_failed_round: value.status === 'failed' ? value.round : undefined,
        cascade_total: Number(run.source_context?.total ?? 1),
        cascade_loop_id: typeof run.source_context?.loop_id === 'string'
          ? run.source_context.loop_id
          : null,
        cascade_retry_order: value.status === 'failed'
          ? cascadeRetryOrder(state.nodes, state.connections, node.id)
          : undefined,
        cascade_run_id: value.status === 'failed' ? run.id : undefined,
        cascade_failed_flow_node_id: value.status === 'failed'
          ? Object.entries(nodeMap).find(
              ([flowNodeId, meta]) =>
                meta.canvas_node_id === node.id &&
                ['failed', 'cancelled'].includes(run.checkpoint.nodes[flowNodeId]?.status),
            )?.[0]
          : undefined,
      }
    }),
  })
}

async function trackCascadeRun(runId: string, canvasId: number, notify = true): Promise<void> {
  if (trackedCascadeRuns.has(runId)) return
  trackedCascadeRuns.add(runId)
  const waiter = cascadeRunWaiter(runId)
  try {
    let run = await apiStudio.flowRun(runId)
    while (FLOW_RUN_ACTIVE.has(run.status)) {
      if (useCanvasStore.getState().canvasId !== canvasId) return
      projectCascadeRun(run, canvasId)
      await waiter.wait(1500)
      run = await apiStudio.flowRun(runId)
    }
    if (useCanvasStore.getState().canvasId !== canvasId) return
    projectCascadeRun(run, canvasId)
    landCascadeCheckpointOutputs(run, canvasId)
    // 任务终态与 FlowRun 终态可能在同一个 tick 到达，再扫一次保证产物落图。
    await Promise.all([
      recoverCanvasImageTasks(canvasId),
      recoverCanvasVideoTasks(canvasId),
      recoverCanvasWorkflowTasks(canvasId),
    ])
    const runLabel = run.source_context?.kind === 'canvas_set' ? '成套出图' : '级联执行'
    if (run.status === 'failed') {
      const failedState = useCanvasStore.getState()
      if (failedState.cascade?.runId === runId) useCanvasStore.setState({ cascade: null })
      if (notify) toast.error(run.error ?? `${runLabel}失败`)
      return
    }
    const finalState = useCanvasStore.getState()
    if (finalState.cascade?.runId === runId) useCanvasStore.setState({ cascade: null })
    if (run.status === 'cancelled') {
      if (notify) toast.info('已停止后续调度，已提交任务的产物会继续回到画布')
    } else {
      chime('done')
      if (notify) {
        const total = Math.max(1, Number(run.source_context?.total) || 1)
        toast.success(runLabel === '成套出图' ? `${runLabel}完成，共 ${total} 张` : `${runLabel}完成`)
      }
    }
    window.setTimeout(() => {
      const latest = useCanvasStore.getState()
      if (latest.canvasId !== canvasId || latest.cascade !== null) return
      useCanvasStore.setState({
        edgeStates: {},
        nodes: latest.nodes.map((node) => node.cascade_status === 'failed'
          ? node
          : { ...node, cascade_status: undefined }),
      })
      scheduleSave()
    }, 4000)
  } catch (error) {
    if (useCanvasStore.getState().canvasId === canvasId) {
      toast.error(`画布执行状态恢复失败：${errText(error)}`)
    }
  } finally {
    waiter.dispose()
    trackedCascadeRuns.delete(runId)
  }
}

async function recoverCanvasCascadeRun(canvasId: number): Promise<void> {
  try {
    const response = await apiStudio.flowRuns({
      canvas_id: canvasId,
      limit: 50,
    })
    if (useCanvasStore.getState().canvasId !== canvasId) return
    const canvasRuns = response.items.filter((candidate) =>
      ['canvas_cascade', 'canvas_set'].includes(String(candidate.source_context?.kind ?? '')),
    )
    const active = canvasRuns.find((candidate) => FLOW_RUN_ACTIVE.has(candidate.status))
    if (active !== undefined) {
      projectCascadeRun(active, canvasId)
      landCascadeCheckpointOutputs(active, canvasId)
      void trackCascadeRun(active.id, canvasId, false)
      return
    }
    const failed = canvasRuns.find((candidate) => candidate.status === 'failed')
    if (failed !== undefined) {
      projectCascadeRun(failed, canvasId)
      landCascadeCheckpointOutputs(failed, canvasId)
      const state = useCanvasStore.getState()
      if (state.cascade?.runId === failed.id) useCanvasStore.setState({ cascade: null })
      return
    }
    for (const completed of canvasRuns.filter((candidate) =>
      ['succeeded', 'partial'].includes(candidate.status),
    )) {
      landCascadeCheckpointOutputs(completed, canvasId)
    }
  } catch (error) {
    toast.error(`画布执行恢复失败：${errText(error)}`)
  }
}

/** 级联执行（FR-464）。startId 是链尾图节点或 loop 节点。 */
/** 按成套方案出图（模块 17）。
 *
 *  与 `runCascade` 的分工：级联是「沿着画布上的连线跑」，成套是
 *  「按一份方案跑」——方案本身就是拓扑，不需要用户先在画布上连出来。
 *
 *  两种意图对应两种跑法，这是方案里 `intent` 的**唯一**作用：
 *  - consistent：一步跟一步，**上一步的产物加进下一步的参考**，这是一致性的来源；
 *  - varied：各步同时跑，参考都用最初那一批，互不影响。
 *
 *  产物落在源节点下方一排，每步一个槽位（`slot_of` + `slot_round`），
 *  重跑复用同一批节点而不是又建一排。 */
export async function runSetPlan(sourceId: string, plan: SetPlan): Promise<void> {
  const s0 = useCanvasStore.getState()
  const canvasId = s0.canvasId
  const source = s0.nodes.find((n) => n.id === sourceId)
  if (canvasId === null || source?.type !== 'image') return
  if (s0.cascade !== null) {
    toast.info('已经有一项画布执行在运行，先停了再开')
    return
  }
  if (Object.keys(s0.running).length > 0) {
    toast.info('有节点正在单独运行，等它结束再成套出图')
    return
  }
  const steps = plan.steps.filter((st) => st.prompt.trim() !== '')
  if (steps.length === 0) {
    toast.error('方案里没有可执行的步骤')
    return
  }

  const consistent = plan.intent !== 'varied'

  /* 先把槽位一次性建好再开跑（蓝本 `precreateSingleSlots` 同款）。
     边跑边建的话，并发时几个任务会同时去建节点，落点互相抢；
     而且用户在跑之前就看不到「一共会出几张、落在哪」。 */
  const slots: string[] = []
  const nodesBeforeCreate = new Set(s0.nodes.map((node) => node.id))
  useCanvasStore.getState().snapshot()
  for (let i = 0; i < steps.length; i += 1) {
    const round = i + 1
    const exist = findSlot(useCanvasStore.getState().nodes, sourceId, round)
    if (exist !== undefined) {
      useCanvasStore.getState().updateNode(exist.id, { items: [], title: steps[i].title })
      slots.push(exist.id)
      continue
    }
    const id = newNodeId()
    const cols = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(steps.length))))
    const box = mediaNodeBox(undefined, undefined)
    /* 网格是理想落点，真落点还要避开画布上已有的东西——源节点下方那片
       多半已经站着上一次成套的产出。逐个建、逐个避，本批彼此也不会重叠 */
    const spot = freeNodeSpot({
      x: Math.round(source.x + (i % cols) * (box.w + 28)),
      y: Math.round(source.y + (source.h ?? 360) + 60 + Math.floor(i / cols) * (box.h + 60)),
      w: box.w,
      h: box.h,
    })
    useCanvasStore.getState().addNode({
      id,
      type: 'image',
      x: spot.x,
      y: spot.y,
      w: box.w,
      title: steps[i].title,
      items: [],
      slot_of: sourceId,
      slot_round: round,
    })
    useCanvasStore.getState().addConnection({ from: sourceId, to: id, kind: 'flow' })
    slots.push(id)
  }
  const edgeKeys = slots.map((targetId) => connKey({ from: sourceId, to: targetId, kind: 'flow' }))
  useCanvasStore.setState({
    cascade: {
      startId: sourceId,
      loopId: null,
      mode: consistent ? 'serial' : 'parallel',
      total: steps.length,
      doneRounds: 0,
      activeRounds: [],
      nodeLabel: `成套出图 · ${steps.length} 张`,
      stopRequested: false,
    },
    edgeStates: Object.fromEntries(edgeKeys.map((key) => [key, 'wait' as EdgeRunState])),
  })
  patchCascadeNodes(slots, () => ({
    cascade_status: 'queued',
    cascade_error: '',
    cascade_failed_round: undefined,
    cascade_total: steps.length,
    cascade_loop_id: null,
    cascade_retry_order: undefined,
    cascade_retry_ref_ids: undefined,
    cascade_retry_media_refs: undefined,
    cascade_run_id: undefined,
    cascade_failed_flow_node_id: undefined,
  }))

  try {
    // 本地先编一遍：这一步顺带把输出槽建到画布上，也是服务端不可用时的兜底
    const local = compileSetPlanRun(useCanvasStore.getState(), sourceId, plan, slots)
    let compiled = local
    try {
      compiled = await compileOnServer(canvasId, {
        mode: 'set',
        nodes: useCanvasStore.getState().nodes,
        connections: useCanvasStore.getState().connections,
        start_id: sourceId,
        plan,
        slots,
      })
    } catch (error) {
      toast.info(`服务端编译不可用，这次按本地编译提交：${errText(error)}`)
    }
    // 输出槽先持久化。页面在提交后立刻刷新，Worker 仍可按冻结 node_id 回填每一步。
    await flushSave()
    const run = await apiStudio.runInlineFlow({
      definition: compiled.definition,
      inputs: {},
      source_context: compiled.sourceContext,
    })
    if (useCanvasStore.getState().canvasId !== canvasId) return
    projectCascadeRun(run, canvasId)
    void trackCascadeRun(run.id, canvasId)
  } catch (error) {
    const latest = useCanvasStore.getState()
    if (latest.canvasId !== canvasId) return
    const emptyNewTargets = latest.nodes
      .filter((node) => !nodesBeforeCreate.has(node.id) && (node.items ?? []).length === 0)
      .map((node) => node.id)
    if (emptyNewTargets.length > 0) latest.removeNodes(emptyNewTargets)
    useCanvasStore.setState({ cascade: null, edgeStates: {} })
    patchCascadeNodes(slots, () => ({ cascade_status: undefined }))
    toast.error(`成套出图提交失败：${errText(error)}`)
  }
}

export async function runCascade(startId: string, confirmed = false): Promise<void> {
  const s0 = useCanvasStore.getState()
  const canvasId = s0.canvasId
  if (canvasId === null) return
  if (s0.cascade !== null) {
    toast.info('已经有一条链在跑，先停了再开')
    return
  }
  if (Object.keys(s0.running).length > 0) {
    toast.info('有节点正在单独出图，等它跑完再级联')
    return
  }
  const start = s0.nodes.find((n) => n.id === startId)
  if (start === undefined) return
  const chain = cascadeChain(s0.nodes, s0.connections, startId)
  // 运行前给出的数字与这里跑的必须是同一份算式，否则界面上写 3 次实际跑 5 次
  const plan = planOf(s0.nodes, s0.connections, startId, chain.order)
  if (!plan.canRun) {
    toast.error(
      plan.executableNodes === 0
        ? '这条链上没有可执行节点（级联只沿 input 边走，先连接生成或 LLM 节点）'
        : '请选择链路末端的执行节点；单节点请直接运行',
    )
    return
  }
  const loop = start.type === 'loop' ? start : loopFor(s0.nodes, s0.connections, chain.order)
  const total = plan.rounds
  const mode: LoopMode = loop?.mode === 'parallel' ? 'parallel' : 'serial'
  const vars = (loop?.variable_prompts ?? []).filter((v) => v.trim() !== '')

  if (plan.needsConfirm && !confirmed) {
    /* 不拦，只确认：用户明确要求不设产品级上限。但 60 次以上的出图
       多半是轮数打错了一位，先把算式摆出来比跑完再后悔便宜。 */
    const ok = window.confirm(
      `这条链 ${plan.executableNodes} 个执行节点 × ${total} 轮 = ${plan.gens} 次调用。\n` +
        '确认要全部跑完吗？',
    )
    if (!ok) return
  }

  useCanvasStore.setState({
    cascade: {
      startId,
      loopId: loop?.id ?? null,
      mode,
      total,
      doneRounds: 0,
      activeRounds: [],
      nodeLabel: `${plan.executableNodes} 个执行节点 × ${total} 轮`,
      stopRequested: false,
    },
    edgeStates: Object.fromEntries(chain.edgeKeys.map((k) => [k, 'wait' as EdgeRunState])),
  })
  patchCascadeNodes(chain.order, () => ({
    cascade_status: 'queued',
    cascade_error: '',
    cascade_failed_round: undefined,
    cascade_total: total,
    cascade_loop_id: loop?.id ?? null,
    cascade_retry_order: undefined,
    cascade_retry_ref_ids: undefined,
    cascade_retry_media_refs: undefined,
    cascade_run_id: undefined,
    cascade_failed_flow_node_id: undefined,
  }))

  /* 轮次编排与配置弹窗的预演走同一个函数。少了这一句，
     用户在弹窗里看到的「第 5 轮取第 3~4 张」跑起来完全不是那么回事。 */
  const sched = loopSchedule({
    count: total,
    loop_start: loop?.loop_start,
    image_input: loop?.image_input,
    image_batch_size: loop?.image_batch_size,
  })
  const ctx: RunCtx = {
    canvasId,
    order: chain.order,
    total,
    vars,
    schedule: sched.rounds,
    endIndex: sched.end,
    loopId: loop?.id ?? null,
    commitUndo: armLandingUndo(),
  }
  const nodesBeforeCompile = new Set(useCanvasStore.getState().nodes.map((node) => node.id))
  try {
    // 本地先编一遍：这一步建齐各轮的输出槽，也是服务端不可用时的兜底
    const local = await compileCascadeRun(
      useCanvasStore.getState(),
      chain,
      ctx,
      mode,
      loop?.parallel_limit,
    )
    let compiled = local
    try {
      const latest = useCanvasStore.getState()
      compiled = await compileOnServer(canvasId, {
        mode: 'cascade',
        nodes: latest.nodes,
        connections: latest.connections,
        order: chain.order,
        edge_keys: chain.edgeKeys,
        loop_mode: mode,
        total,
        vars,
        loop_id: loop?.id ?? null,
        parallel_limit: loop?.parallel_limit ?? null,
        loop_start: loop?.loop_start ?? null,
        image_input: loop?.image_input === true,
        image_batch_size: loop?.image_batch_size ?? null,
        targets: compiledTargets(local),
        // 预演刚建、还没落库的槽位，产物要带 planned_node 让 Worker 补建
        pending_node_ids: latest.nodes
          .map((node) => node.id)
          .filter((id) => !nodesBeforeCompile.has(id)),
        start_id: startId,
      })
    } catch (error) {
      toast.info(`服务端编译不可用，这次按本地编译提交：${errText(error)}`)
    }
    compiled.sourceContext.start_id = startId
    // 先把所有轮次的输出槽落库，再提交 DAG。即使页面立刻刷新，
    // 后续任务也有稳定的 node_id，不会把产物丢到只能从任务中心找的孤岛。
    await flushSave()
    const run = await apiStudio.runInlineFlow({
      definition: compiled.definition,
      inputs: {},
      source_context: compiled.sourceContext,
    })
    if (useCanvasStore.getState().canvasId !== canvasId) return
    projectCascadeRun(run, canvasId)
    void trackCascadeRun(run.id, canvasId)
  } catch (error) {
    const latest = useCanvasStore.getState()
    if (latest.canvasId !== canvasId) return
    const emptyNewTargets = latest.nodes
      .filter((node) => !nodesBeforeCompile.has(node.id) && (node.items ?? []).length === 0)
      .map((node) => node.id)
    if (emptyNewTargets.length > 0) latest.removeNodes(emptyNewTargets)
    useCanvasStore.setState({ cascade: null, edgeStates: {} })
    patchCascadeNodes(chain.order, () => ({ cascade_status: undefined }))
    toast.error(`级联提交失败：${errText(error)}`)
  }
}

/** 源画布的「从失败节点继续」：只重跑失败轮的当前节点和其下游。
    有 cascade_run_id 的走服务端 checkpoint 续跑；没有的（旧浏览器执行器留下的失败态）
    把失败节点起的子链按失败轮重新编译成 DAG 提交，下游同样由服务端跑完。 */
export async function retryCascadeFrom(nodeId: string): Promise<void> {
  const initial = useCanvasStore.getState()
  const canvasId = initial.canvasId
  const failedNode = initial.nodes.find((node) => node.id === nodeId)
  if (canvasId === null || failedNode === undefined) return
  if (initial.cascade !== null || Object.keys(initial.running).length > 0) {
    toast.info('画布上还有任务在跑，等它结束再重试')
    return
  }
  if (failedNode.cascade_run_id !== undefined) {
    try {
      const resumed = await apiStudio.resumeFlowRun(failedNode.cascade_run_id)
      if (useCanvasStore.getState().canvasId !== canvasId) return
      projectCascadeRun(resumed, canvasId)
      void trackCascadeRun(resumed.id, canvasId)
      toast.info('已从服务端 checkpoint 继续，已成功节点不会重复调用')
    } catch (error) {
      toast.error(`续跑级联失败：${errText(error)}`)
    }
    return
  }
  const stored = (failedNode.cascade_retry_order ?? []).filter((id) =>
    initial.nodes.some((node) => node.id === id),
  )
  const order = stored.length > 0
    ? stored
    : cascadeRetryOrder(initial.nodes, initial.connections, nodeId)
  if (order.length === 0) {
    toast.error('失败节点的级联上下文已不存在')
    return
  }
  const originalTotal = Math.max(1, failedNode.cascade_total ?? 1)
  const round = Math.max(1, Math.min(failedNode.cascade_failed_round ?? 1, originalTotal))
  const loop = failedNode.cascade_loop_id === null || failedNode.cascade_loop_id === undefined
    ? null
    : initial.nodes.find((node) => node.id === failedNode.cascade_loop_id && node.type === 'loop') ?? null
  const sched = loopSchedule({
    count: originalTotal,
    loop_start: loop?.loop_start,
    image_input: loop?.image_input,
    image_batch_size: loop?.image_batch_size,
  })
  const edgeKeys = chainEdges(initial.nodes, initial.connections)
    .filter((edge) => order.includes(edge.from) && order.includes(edge.to))
    .map(connKey)
  useCanvasStore.setState({
    cascade: {
      startId: nodeId,
      loopId: loop?.id ?? null,
      mode: 'serial',
      total: originalTotal,
      doneRounds: round - 1,
      activeRounds: [round],
      nodeLabel: `从「${nodeLabel(failedNode)}」继续第 ${round} 轮`,
      stopRequested: false,
    },
    edgeStates: Object.fromEntries(edgeKeys.map((key) => [key, 'wait' as EdgeRunState])),
  })
  patchCascadeNodes(order, () => ({ cascade_status: 'queued', cascade_error: '' }))
  const retryRefIds = failedNode.cascade_retry_ref_ids
  const retryMediaRefs = failedNode.cascade_retry_media_refs
  const ctx: RunCtx = {
    canvasId,
    order,
    total: originalTotal,
    vars: (loop?.variable_prompts ?? []).filter((value) => value.trim() !== ''),
    schedule: sched.rounds,
    endIndex: sched.end,
    loopId: loop?.id ?? null,
    retryRefs: retryRefIds === undefined ? undefined : { [nodeId]: [...retryRefIds] },
    retryMedia: retryMediaRefs === undefined
      ? undefined
      : { [nodeId]: retryMediaRefs.map((item) => ({ ...item })) },
    commitUndo: armLandingUndo(),
  }
  const nodesBeforeCompile = new Set(useCanvasStore.getState().nodes.map((node) => node.id))
  try {
    const compiled = await compileCascadeRun(
      useCanvasStore.getState(),
      { order, edgeKeys },
      ctx,
      'serial',
      undefined,
      [round],
    )
    compiled.sourceContext.start_id = nodeId
    // 与 runCascade 同一个理由：槽位先落库，页面随后刷新也有稳定的 node_id 接产物
    await flushSave()
    const run = await apiStudio.runInlineFlow({
      definition: compiled.definition,
      inputs: {},
      source_context: compiled.sourceContext,
    })
    if (useCanvasStore.getState().canvasId !== canvasId) return
    projectCascadeRun(run, canvasId)
    void trackCascadeRun(run.id, canvasId)
    toast.info(`已从「${nodeLabel(failedNode)}」重新提交第 ${round} 轮，由服务端继续`)
  } catch (error) {
    const latest = useCanvasStore.getState()
    if (latest.canvasId !== canvasId) return
    const emptyNewTargets = latest.nodes
      .filter((node) => !nodesBeforeCompile.has(node.id) && (node.items ?? []).length === 0)
      .map((node) => node.id)
    if (emptyNewTargets.length > 0) latest.removeNodes(emptyNewTargets)
    useCanvasStore.setState({ cascade: null, edgeStates: {} })
    patchCascadeNodes(order, () => ({
      cascade_status: undefined,
      cascade_error: '',
      cascade_failed_round: undefined,
      cascade_retry_order: undefined,
      cascade_retry_ref_ids: undefined,
      cascade_retry_media_refs: undefined,
    }))
    toast.error(`级联重试提交失败：${errText(error)}，请重新发起级联`)
  }
}

/** 放弃这次失败链，仅清理级联错误投影，已出资产不动。 */
export function dismissCascadeFailure(nodeId: string): void {
  const state = useCanvasStore.getState()
  const node = state.nodes.find((candidate) => candidate.id === nodeId)
  if (node?.cascade_status !== 'failed') return
  state.updateNode(nodeId, {
    cascade_status: undefined,
    cascade_error: '',
    cascade_failed_round: undefined,
    cascade_retry_order: undefined,
    cascade_retry_ref_ids: undefined,
    cascade_retry_media_refs: undefined,
    cascade_run_id: undefined,
    cascade_failed_flow_node_id: undefined,
  })
}
