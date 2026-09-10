/* 无限画布页（FR-461~464、467~468）。

   渲染层是自研的 `canvas-core`（CR-005 §3.1，直译 Infinite-Canvas 的
   DOM+SVG 结构，已弃用 react-flow）：文档态全部在 canvasStore（zustand），节点/连线/视口
   的每次变更走 450ms 防抖 PUT，409 按 BR-145 合并。选中图节点出底部悬浮条，
   从那里出图或跑整条链；分支输出、历史归档、失败回滚、级联轮次都在 store 的
   编排函数里。 */

import { useQuery } from '@tanstack/react-query'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Clapperboard, CloudLightning, ImagePlus, LayoutGrid, MessageSquareText, ScrollText, Sparkles, Wrench, X } from '@/components/NexusIcon'
import { toast } from 'sonner'

import { Overlay, useOverlayOpen } from '../../components/Overlay'
import {
  IconArrowLeft,
  IconDownload,
  IconHelp,
  IconImage,
  IconPlus,
  IconRepeatOne,
  IconSidebar,
  IconSparkle,
  IconTask,
  IconUpload,
  IconVideo,
} from '../../components/icons'
import { CanvasBoard } from './CanvasBoard'
import {
  TOPBAR_MEDIA,
  TopbarMore,
  splitTopbarItems,
  tierFromMatches,
  topbarIconOnly,
} from './canvas-topbar'
import type { TopbarItem } from './canvas-topbar'
import { NODE_DEFINITIONS, createMenuTypes, nodeDefaults, nodeDefinition } from './nodes'
import { CanvasEdgeMenu, CanvasNodeMenu, CanvasPortMenu } from './CanvasNodeMenu'
import { GESTURES, canvasView, shortcutGroups, shortcutLabel, useCanvasShortcuts } from './canvas-core'
import type { ShortcutAction, ShortcutHandlers } from './canvas-core'
import {
  capturePointer,
  releasePointer,
  screenToCanvas,
} from './canvas-core'
import { chime, chimeEnabled, setChimeEnabled } from '../../lib/chime'
import { apiImage } from '../../lib/api-image'
import { apiConfig } from '../../lib/api-config'
import { normalizeQuality, useImageDefaults } from '../../lib/image-defaults'
import { useMediaQuery } from '../../lib/use-media-query'
import { apiStudio } from '../../lib/api-studio'
import type {
  CanvasConnection,
  CanvasNode,
  CanvasVideoRunSettings,
  StudioMediaAsset,
} from '../../lib/api-studio'
import { AssetPicker } from './AssetPicker'
import {
  CANVAS_ASSET_MIME,
  CanvasAssetPanel,
} from './CanvasAssetPanel'
import type { CanvasPanelAsset } from './CanvasAssetPanel'
import { FORM_FOCUS_SELECTOR, Picker, PillPicker } from '@/components/ui/picker'
import { AUTO_SIZE, SizePicker } from '@/components/ui/size-picker'
import { itemSrc } from './CanvasNodes'
import {
  AttachButton,
  AttachStrip,
  MAX_ATTACHMENTS,
  uploadAttachments,
} from './CanvasAttachments'
import { CanvasEditor } from './CanvasEditor'
import { LoopConfigDialog } from './LoopConfigDialog'
import { SetPlanDialog } from './SetPlanDialog'
import { CanvasWorkflowTransfer } from './CanvasWorkflowTransfer'
import { EMPTY_MENTION, MentionInput, mentionAppendText, mentionFromText } from './MentionInput'
import type { MentionValue } from './MentionInput'
import {
  BULK_CONCURRENCY,
  bulkCountPatch,
  bulkPlan,
  composeShown,
  countModePatch,
  countPatch,
  effectiveDraft,
  genModeOf,
  genPlanLine,
  genRoute,
  lastBatchFailures,
  recentClear,
  recentLabel,
  bulkStatus,
  recentLoad,
  recentPush,
  runBulk,
  serialSetPlan,
  showRunPicker,
  taskDurations,
} from './canvas-composer'
import type { BulkDraftMode } from './canvas-composer'
import { MediaAssetPicker } from './MediaAssetPicker'
import { PromptPicker } from './PromptPicker'
/* 「让 AI 写词」的客户端只有这一份（提示词库的「AI 写一条」用的也是它）。
   这里改名导入是因为 canvasStore 里另有一个同名的 `composePrompt`——
   那个是本地把上游节点的词拼起来，跟调模型完全是两件事。 */
import { composePrompt as aiComposePrompt } from './prompt-compose'
import { SaveTemplateDialog, TemplatePicker } from './TemplatePicker'
import { WorkflowNodePicker } from './WorkflowNodePicker'
import { GeneratorEnginePicker, workflowNodePatch } from './CanvasGeneratorEngine'
import { CanvasCascadeAction } from './CanvasCascadeAction'
import { CanvasRunLog } from './CanvasRunLog'
import { CanvasResourceRepair } from './CanvasResourceRepair'
import {
  WorkflowTimelineEditor,
  workflowTimelineMode,
} from './WorkflowTimelineEditor'
import {
  prepareCanvasWorkflowRun,
  timelineControlledField,
  workflowFieldDefault,
  workflowFieldId,
  workflowFieldLabel,
  workflowFieldMediaKind,
  workflowFields,
  workflowFieldType,
  workflowMediaByKind,
} from './canvasWorkflowInputs'
import type { CanvasEditorMode, CanvasEditorResult } from './CanvasEditor'

/** 画布编辑器的模式。工具条按钮直接指定进哪个 */
type EditorMode = CanvasEditorMode
import {
  EDGE_ANIM_MAX,
  EDGE_COUNT_ANIM_MAX,
  IMAGE_NODE_W,
  MAX_REFS,
  NUDGE_FAST,
  NUDGE_STEP,
  alignNodes,
  arrangeCluster,
  arrangeSelection,
  batchGroupEnabled,
  clusterOf,
  GEN_N_MAX,
  beginCanvasImageTask,
  composePrompt,
  copyNodes,
  createAutoOutput,
  duplicateNodes,
  flushSave,
  generateFrom,
  generateVideoFrom,
  groupSelection,
  imageAssetIds,
  newNodeId,
  nodeBox,
  pasteNodes,
  placeNodeInGroup,
  refAssetIds,
  referenceAssetEntries,
  refMediaItems,
  reorderReferenceAssets,
  retryCanvasImageTask,
  retryCanvasWorkflowTask,
  retryCanvasVideoTask,
  runCascade,
  runSetPlan,
  runWorkflowFrom,
  setBatchGroupEnabled,
  snapshotNudge,
  spreadNodes,
  ungroupSelection,
  useCanvasStore,
  VIDEO_MULTIFRAME_MAX_REFS,
  VIDEO_MULTIMODAL_MAX_REFS,
  videoMediaReferenceInputs,
  videoReferenceInputs,
} from './canvasStore'
import type {
  AlignMode,
  ReferenceAssetEntry,
  SaveState,
  ScvNode,
  SpreadAxis,
} from './canvasStore'
import './canvas.css'
import { saveFile } from '@/lib/shell'

/** 节点的真实尺寸。判据只有 `canvasStore.nodeBox` 一份——排布、对齐、分组整理
 *  问的必须是同一个人，各写一份就会出现「排完还是叠着，而两边单看都对」。 */
const nodeBoxOf = nodeBox

const SAVE_LABEL: Record<SaveState, string> = {
  idle: '',
  saving: '保存中…',
  saved: '已保存',
  merged: '已合并多端修改',
  error: '保存失败，改动会随下次编辑重试',
}

/** 快捷键表里的修饰键写法：mac 写 ⌘，其它平台写 Ctrl，别让 Windows 用户对着 ⌘ 猜 */
const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl'

const ARROW_DIR: Record<string, { x: number; y: number }> = {
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
}

const IMAGE_FILE_RE = /\.(?:png|jpe?g|webp|gif|avif|heic)$/i

interface CanvasCreateMenuState {
  clientX: number
  clientY: number
  point: { x: number; y: number }
  /** 右键智能分组时记住容器；选中卡片后新节点直接进该组。 */
  groupId?: string
}

function isImageFile(file: File): boolean {
  return file.type.toLowerCase().startsWith('image/') || IMAGE_FILE_RE.test(file.name)
}

function remoteImageFromTransfer(data: DataTransfer): string | null {
  const uri = data.getData('text/uri-list').split(/\r?\n/).find((line) => /^https?:\/\//i.test(line))
  if (uri !== undefined) return uri.trim()
  const html = data.getData('text/html')
  const match = html.match(/<(?:img|a)\b[^>]*(?:src|href)=["'](https?:\/\/[^"']+)["']/i)
  if (match?.[1] !== undefined) return match[1]
  const text = data.getData('text/plain').trim()
  return /^https?:\/\/\S+$/i.test(text) ? text : null
}

function itemFromMediaAsset(asset: StudioMediaAsset) {
  return {
    kind: asset.kind,
    media_asset_id: asset.id,
    url: asset.url,
    poster_url: asset.poster_url,
    name: asset.name,
    mime: asset.mime,
    duration_ms: asset.duration_ms,
    w: asset.width ?? undefined,
    h: asset.height ?? undefined,
  } as const
}

export default function CanvasPage() {
  // 路由挂的是 /studio/canvas/:canvasId，参数名要对上，取错了会拿到 NaN→0 然后 404
  const { canvasId: rawId = '' } = useParams()
  const canvasId = Number(rawId)
  return <CanvasInner canvasId={canvasId} />
}

function CanvasInner({ canvasId }: { canvasId: number }) {
  const navigate = useNavigate()
  /* 把配置中心的全局默认质量灌进 image-defaults：不调的话画布会一直用出厂默认，
     用户在配置中心改了也不生效（和后端 worker 不 load 是同一类问题） */
  useImageDefaults()
  const canvasImageDeployments = useQuery({
    queryKey: ['cfg-model-deployments', 'canvas-image'],
    queryFn: () => apiConfig.modelDeployments({ media_type: 'image', enabled: true }),
  })
  const jimengUpscaleDeployment = (canvasImageDeployments.data ?? []).find(
    (item) => item.enabled && item.adapter_type === 'jimeng',
  )

  const loaded = useCanvasStore((s) => s.loaded)
  const loadError = useCanvasStore((s) => s.loadError)
  const title = useCanvasStore((s) => s.title)
  const kind = useCanvasStore((s) => s.kind)
  const nodes = useCanvasStore((s) => s.nodes)
  const connections = useCanvasStore((s) => s.connections)
  const running = useCanvasStore((s) => s.running)
  const cascade = useCanvasStore((s) => s.cascade)
  const edgeStates = useCanvasStore((s) => s.edgeStates)
  const selectedNodeIds = useCanvasStore((s) => s.selectedNodeIds)
  const selectedEdgeIds = useCanvasStore((s) => s.selectedEdgeIds)
  const saveState = useCanvasStore((s) => s.saveState)
  const initialViewport = useCanvasStore((s) => s.initialViewport)

  const [picker, setPicker] = useState(false)
  const [mediaPicker, setMediaPicker] = useState(false)
  const [assetPanel, setAssetPanel] = useState(false)
  const [workflowPicker, setWorkflowPicker] = useState(false)
  const [workflowPickerPoint, setWorkflowPickerPoint] = useState<{ x: number; y: number } | null>(null)
  const [workflowTransfer, setWorkflowTransfer] = useState(false)
  const [createMenu, setCreateMenu] = useState<CanvasCreateMenuState | null>(null)
  /* 另外三套上下文菜单（需求 §6.8）。创建菜单是第四套，还在上面那个 state 里 */
  const [nodeMenu, setNodeMenu] = useState<{ id: string; at: { x: number; y: number } } | null>(null)
  const [edgeMenu, setEdgeMenu] = useState<{ conn: CanvasConnection; at: { x: number; y: number } } | null>(null)
  const [portMenu, setPortMenu] = useState<{
    fromId: string
    side: 'in' | 'out'
    world: { x: number; y: number }
    at: { x: number; y: number }
  } | null>(null)
  const [importing, setImporting] = useState(false)
  const [draggingFiles, setDraggingFiles] = useState(false)
  const [previewing, setPreviewing] = useState<string | null>(null)
  /** 正在用画布编辑器改哪个节点。null = 没开 */
  /** 打开画布编辑器：节点 id + 直接进哪个模式。
      工具条上的每个按钮各指一个模式，不用「先打开再点一次」 */
  const [editing, setEditing] = useState<{ nodeId: string; mode: EditorMode; assetId?: number } | null>(null)
  /** 正在开成套弹窗的节点 id + 它当前的参考图。
   *
   *  成套是**输入框里的一个动作**，不是一种节点：选中一张图、参考图天然就在手边，
   *  点「成套」就能让 AI 拿着这些参考跟你讨论；没有参考图时它就是纯文生图的成套。
   *  做成节点的话，用户得先建节点、再连线、再配置，中间三步都与他想做的事无关。 */
  const [setPlanFor, setSetPlanFor] = useState<{ nodeId: string; refs: number[]; auto?: boolean } | null>(null)
  /** 循环节点的参数表单。留给要精确控制轮次的场合 */
  const [manualLoop, setManualLoop] = useState<string | null>(null)
  /** 默认落 preview：双击一张图最常见的意图是「看清楚点」而不是「裁一刀」。
   *  工具条上的裁剪/重绘/扩图各自指名模式，不受这个默认影响 */
  const openEditor = useCallback(
    (nodeId: string, mode: EditorMode = 'preview', assetId?: number) => {
      setEditing({ nodeId, mode, assetId })
    },
    [],
  )
  const runJimengUpscale = useCallback(async (nodeId: string, assetId?: number) => {
    if (jimengUpscaleDeployment === undefined) {
      toast.error('先在设置中添加即梦 CLI 并刷新图片模型')
      return
    }
    const state = useCanvasStore.getState()
    const source = state.nodes.find((item) => item.id === nodeId)
    const sourceAssetId = assetId ?? source?.items?.find((item) => item.asset_id !== undefined)?.asset_id
    if (source === undefined || sourceAssetId === undefined) {
      toast.error('这个节点还没有可放大的入库图片')
      return
    }
    const resolution = source.run_settings?.upscale_resolution ?? '2k'
    const targetId = newNodeId()
    const planned: ScvNode = {
      id: targetId,
      type: 'image',
      x: source.x + (source.w ?? IMAGE_NODE_W) + 80,
      y: source.y,
      w: source.w ?? IMAGE_NODE_W,
      title: `高清放大 ${resolution.toUpperCase()}`,
      run_settings: { ...source.run_settings },
      items: [],
    }
    state.snapshot()
    state.addNode(planned)
    state.addConnection({ from: source.id, to: targetId, kind: 'flow' })
    state.selectOnly([targetId])
    try {
      const task = await apiStudio.runTool('infinite-canvas', {
        operation: 'image.upscale',
        input: {
          deployment_id: jimengUpscaleDeployment.id,
          asset_id: sourceAssetId,
          resolution_type: resolution,
        },
        source_route: `/studio/canvas/${canvasId}`,
        source_context: {
          canvas_id: canvasId,
          node_id: targetId,
          source_node_id: source.id,
          planned_node: planned,
          pending_target: true,
          asset_id: sourceAssetId,
          upscale_resolution: resolution,
        },
      })
      beginCanvasImageTask(targetId, task.id)
      toast.success(`即梦 ${resolution.toUpperCase()} 放大已进入后台`)
    } catch (error) {
      useCanvasStore.getState().removeNodes([targetId])
      toast.error(error instanceof Error ? error.message : '即梦图片放大入队失败')
    }
  }, [canvasId, jimengUpscaleDeployment])
  const [saveTpl, setSaveTpl] = useState(false)
  const [useTpl, setUseTpl] = useState(false)
  const [titleDraft, setTitleDraft] = useState<string | null>(null)
  const [keys, setKeys] = useState(false)
  const [runLog, setRunLog] = useState(false)
  const [resourceRepair, setResourceRepair] = useState(false)
  const importRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!Number.isFinite(canvasId)) return
    void useCanvasStore.getState().load(canvasId)
    return () => {
      // flushSave 在第一个 await 前取完状态，随后 reset 不会截走内容
      flushSave()
      useCanvasStore.getState().reset()
    }
  }, [canvasId])

  /* 快捷键（AC-155 · 需求 §6.3）。
     键位表在 `canvas-core/shortcuts.ts`，这里只提供「按下之后做什么」。
     两边同源的好处是帮助面板不会再说谎——面板只列**这里真的接了处理器**的键，
     不会出现「表上写着按了没反应」。

     四条纪律仍然成立：
     1. 焦点在输入框里一律让位（由 shortcuts.ts 统一判定）——抢走 ⌘A/⌘C
        会让提示词框根本没法全选复制；
     2. 下拉不算输入框：它没有自己的撤销与复制语义，点完质量下拉焦点留在
        上面，一起挡掉的话「选完质量顺手按 ⌘Z」会毫无反应（实测踩到）。
        只有方向键要让给它——那是切选项用的（见 FORM_FOCUS_SELECTOR）；
     3. Esc 有浮层开着时归浮层栈管（STD-UI-002），不顺手把选择也清了；
     4. ⌘V 不在这里：系统剪贴板里若有图片要先导入，keydown 阶段 preventDefault
        会把截图粘贴整个吞掉。它走 paste 事件。 */
  const shortcutHandlers = useMemo<ShortcutHandlers>(
    () => ({
      undo: () => useCanvasStore.getState().undoOnce(),
      redo: () => useCanvasStore.getState().redoOnce(),
      selectAll: () => {
        const s = useCanvasStore.getState()
        s.selectOnly(s.nodes.map((n) => n.id))
      },
      copy: () => {
        const s = useCanvasStore.getState()
        if (s.selectedNodeIds.length === 0) return
        const n = copyNodes(s.selectedNodeIds)
        if (n > 0) toast.success(`已复制 ${n} 个节点，${MOD}V 粘贴`)
      },
      cut: () => {
        const s = useCanvasStore.getState()
        if (s.selectedNodeIds.length === 0) return
        const n = copyNodes(s.selectedNodeIds)
        if (n === 0) return
        s.snapshot()
        s.removeNodes(s.selectedNodeIds)
        toast.success(`已剪切 ${n} 个节点，${MOD}V 粘贴`)
      },
      duplicate: () => {
        const s = useCanvasStore.getState()
        if (s.selectedNodeIds.length === 0) return
        duplicateNodes(s.selectedNodeIds)
      },
      /* Delete 以前是 react-flow 的 deleteKeyCode 管的，换成自研内核之后
         没人接了——删掉那行的时候差点把这个功能一起丢掉 */
      delete: () => {
        const s = useCanvasStore.getState()
        if (s.selectedNodeIds.length === 0 && s.selectedEdgeIds.length === 0) return
        s.snapshot()
        if (s.selectedNodeIds.length > 0) s.removeNodes(s.selectedNodeIds)
        if (s.selectedEdgeIds.length > 0) s.removeConnectionsByKey(s.selectedEdgeIds)
      },
      group: () => {
        const s = useCanvasStore.getState()
        if (s.selectedNodeIds.length < 2) return
        groupSelection(s.selectedNodeIds)
      },
      ungroup: () => {
        const s = useCanvasStore.getState()
        if (s.selectedNodeIds.length === 0) return
        ungroupSelection(s.selectedNodeIds)
      },
      save: () => flushSave(),
      help: () => setKeys(true),

      /* 视图控制。视口 state 住在 CanvasBoard 里，这里通过登记处调它——
         `canvasView()` 在画布还没挂载时返回 null，那时这几个键按了什么也不做，
         但它们仍然出现在帮助面板里（面板按「有没有接处理器」过滤，不按「此刻能不能用」）。 */
      fitView: () => canvasView()?.fit(),
      /* 放大到选区。没选中时明说，而不是按下去毫无动静 */
      fitSelection: () => {
        if (canvasView()?.fitSelection() === false) toast.info('先选中节点，再放大到选区')
      },
      zoomIn: () => canvasView()?.zoom(1.25),
      zoomOut: () => canvasView()?.zoom(1 / 1.25),
      resetZoom: () => canvasView()?.reset(),
      toggleOverview: () => canvasView()?.toggleOverview(),
      toggleAssets: () => setAssetPanel((v) => !v),

      /* 运行/停止整条链。选中多个时只认第一个——级联是从一个链尾往回走的，
         同时跑几条链会让「共几次出图」那个数字失去意义。 */
      run: () => {
        const s = useCanvasStore.getState()
        if (s.cascade !== null) return
        const id = s.selectedNodeIds[0]
        if (id === undefined) {
          toast.error('先选中一个节点：级联从它沿参考输入边往回找整条链')
          return
        }
        void runCascade(id)
      },
      stop: () => {
        const s = useCanvasStore.getState()
        if (s.cascade === null) return
        s.stopCascade()
      },
      escape: () => {
        setCreateMenu(null)
        setNodeMenu(null)
        setEdgeMenu(null)
        setPortMenu(null)
        // 有浮层开着时归浮层栈管，不顺手把选择也清了
        if (document.querySelector('.overlay') !== null) return
        const s = useCanvasStore.getState()
        if (s.selectedNodeIds.length === 0 && s.selectedEdgeIds.length === 0) return
        s.selectOnly([])
      },
    }),
    [],
  )
  /* 有浮层开着时，画布的全局快捷键整套让路。
     少了这一条，在图片编辑器里按 Delete 删掉的是**背后画布上正在编辑的那个节点**
     ——它恰好是选中态，一按就没了，而弹窗盖着看不见，用户直到关掉弹窗才发现。
     ⌘Enter（开跑级联）、a（素材库）、z（缩略概览）同理。 */
  const overlayOpen = useOverlayOpen()
  useCanvasShortcuts(shortcutHandlers, !overlayOpen)

  /* 方向键微移不走键位表：它要读方向、要判下拉是否有焦点（那上面方向键是切选项）、
     还要按 Shift 改步长，塞进「一个 action 一个 handler」的模型里反而绕。
     判据走 `FORM_FOCUS_SELECTOR`——按 role 判而不是按标签判，
     Radix 的下拉触发器是 `<button role="combobox">`，写死 `select` 会漏掉。 */
  useEffect(() => {
    if (overlayOpen) return
    const onArrow = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey) return
      const t = e.target instanceof Element ? e.target : null
      if (t !== null && t.closest(FORM_FOCUS_SELECTOR) !== null) return
      const dir = ARROW_DIR[e.key]
      if (dir === undefined) return
      const s = useCanvasStore.getState()
      if (s.selectedNodeIds.length === 0) return
      e.preventDefault()
      const step = NUDGE_STEP * (e.shiftKey ? NUDGE_FAST : 1)
      const pos: Record<string, { x: number; y: number }> = {}
      for (const n of s.nodes) {
        if (!s.selectedNodeIds.includes(n.id)) continue
        pos[n.id] = { x: n.x + dir.x * step, y: n.y + dir.y * step }
      }
      snapshotNudge()
      s.moveNodesTo(pos)
    }
    window.addEventListener('keydown', onArrow)
    return () => window.removeEventListener('keydown', onArrow)
  }, [overlayOpen])

  const openNode = useCallback((nodeId: string, assetId?: number) => {
    const node = useCanvasStore.getState().nodes.find((candidate) => candidate.id === nodeId)
    if (
      (node?.type === 'image' || node?.type === 'output') &&
      node.items?.some((item) => item.kind === 'image' && item.asset_id !== undefined)
    ) {
      // 双击默认看大图。裁剪不是最常见的意图，把它摆在预览前面等于每次看图都要先躲开选框
      setEditing({ nodeId: node.id, mode: 'preview', assetId })
    } else if (node?.type === 'loop') {
      // 循环节点双击进参数表单。成套已经搬到生成条上了——
      // 它是「怎么出这批图」，不是「一种节点」
      setManualLoop(node.id)
    } else if (node?.type === 'group' && assetId !== undefined) {
      // 组内缩略图双击也进预览。没命中具体某张时不开——分组本身没有「主图」，
      // 随便挑第一张给他看不如什么都不做
      setEditing({ nodeId: node.id, mode: 'preview', assetId })
    } else if (
      node !== undefined &&
      (['video', 'audio', 'file'].includes(node.type) || node.type === 'output')
    ) {
      setPreviewing(node.id)
    }
  }, [])

  /* 关流动动画的两个口子：活动边太多（跑链时），或整张画布的边本来就多。
     dash 动画每帧重绘一条 path，两百条一起跑必掉帧（FR-464 / AC-155） */
  const animOff = useMemo(
    () =>
      connections.length > EDGE_COUNT_ANIM_MAX ||
      Object.values(edgeStates).filter((s) => s === 'active').length > EDGE_ANIM_MAX,
    [edgeStates, connections.length],
  )

  const addAtPoint = useCallback(
    (patch: Omit<ScvNode, 'id' | 'x' | 'y'>, point: { x: number; y: number }, offset = 0) => {
      const s = useCanvasStore.getState()
      const id = newNodeId()
      s.snapshot()
      s.addNode({
        id,
        x: point.x - IMAGE_NODE_W / 2 + offset,
        y: point.y - 120 + offset,
        ...patch,
      })
      return id
    },
    [],
  )

  /** 在视口中心落一个新节点。offset 用来错开连续新建，别叠成一摞 */
  const addAtCenter = useCallback(
    (patch: Omit<ScvNode, 'id' | 'x' | 'y'>, offset = 0) => {
      addAtPoint(
        patch,
        screenToCanvas(window.innerWidth / 2, window.innerHeight / 2),
        offset,
      )
    },
    [addAtPoint],
  )

  const addPanelAssetAt = useCallback(
    (payload: CanvasPanelAsset, point: { x: number; y: number }) => {
      if (payload.type === 'image') {
        addAtPoint({
          ...nodeDefaults('image'),
          title: payload.asset.prompt || `图片 ${payload.asset.id}`,
          items: [{
            asset_id: payload.asset.id,
            kind: 'image',
            w: payload.asset.width,
            h: payload.asset.height,
          }],
        }, point)
        return
      }
      if (payload.type === 'media') {
        addAtPoint({
          ...nodeDefaults(payload.asset.kind),
          title: payload.asset.name,
          items: [itemFromMediaAsset(payload.asset)],
        }, point)
        return
      }
      if (payload.type === 'prompt') {
        addAtPoint({
          ...nodeDefaults('prompt'),
          title: payload.prompt.title,
          text: payload.prompt.body,
        }, point)
        void apiStudio.usePrompt(payload.prompt.id)
        return
      }
      addAtPoint(workflowNodePatch(payload.workflow), point)
    },
    [addAtPoint],
  )

  /** 智能画布的 MiniMax 卡是一键建节点，不再让用户进通用工作流弹窗二次选择。 */
  const addMiniMaxAt = useCallback(
    async (point: { x: number; y: number }, groupId?: string) => {
      try {
        const catalog = await apiStudio.workflows('?provider=comfyui&enabled=true')
        const workflow = catalog.items.find(
          (item) => item.key === 'comfyui:MiniMax_H3' || item.source_id === 'MiniMax_H3',
        )
        if (workflow === undefined) throw new Error('MiniMax H3 内置工作流不可用')
        const segmentId = `seg-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
        const id = addAtPoint(
          {
            ...workflowNodePatch(workflow),
            workflow_timeline: {
              kind: 'minimax',
              selected_id: segmentId,
              segments: [{
                id: segmentId,
                start: 0,
                length: 8,
                prompt: '',
                type: 'text',
                references: [],
                aspect_ratio: '16:9 (Widescreen)',
                megapixels: 0.4,
                trim_in: 0,
                trim_out: 8,
              }],
            },
          },
          point,
        )
        if (groupId !== undefined) placeNodeInGroup(groupId, id)
        useCanvasStore.getState().selectOnly([id])
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'MiniMax H3 节点创建失败')
      }
    },
    [addAtPoint],
  )

  const centerFlowPoint = useCallback(
    () => screenToCanvas(window.innerWidth / 2, window.innerHeight / 2),
    [],
  )

  const importFilesAt = useCallback(
    async (files: File[], point: { x: number; y: number }) => {
      const picked = files.filter((file) => file.size > 0).slice(0, 50)
      if (picked.length === 0) return
      setImporting(true)
      const s = useCanvasStore.getState()
      let landed = 0
      const failures: string[] = []
      const place = (patch: Omit<ScvNode, 'id' | 'x' | 'y'>) => {
        if (landed === 0) s.snapshot()
        const column = landed % 4
        const row = Math.floor(landed / 4)
        const width = patch.w ?? nodeDefinition(patch.type).width
        s.addNode({
          id: newNodeId(),
          x: point.x - width / 2 + column * 34,
          y: point.y - 120 + row * 34,
          ...patch,
        })
        landed += 1
      }
      for (const file of picked) {
        try {
          if (isImageFile(file)) {
            const form = new FormData()
            form.set('image', file)
            form.set('op', 'upload')
            const asset = await apiImage.saveLocal(form)
            place({
              ...nodeDefaults('image'),
              title: file.name,
              items: [{ asset_id: asset.id, kind: 'image', w: asset.width, h: asset.height }],
            })
          } else {
            const asset = await apiStudio.uploadMediaAsset(file)
            place({
              ...nodeDefaults(asset.kind),
              title: asset.name,
              items: [itemFromMediaAsset(asset)],
            })
          }
        } catch (error) {
          failures.push(`${file.name}：${error instanceof Error ? error.message : '上传失败'}`)
        }
      }
      setImporting(false)
      if (landed > 0) toast.success(`已导入 ${landed} 个素材并保存到资产库`)
      if (failures.length > 0) toast.error(failures.slice(0, 3).join('\n'))
    },
    [],
  )

  const importRemoteImageAt = useCallback(
    async (url: string, point: { x: number; y: number }) => {
      try {
        const result = await apiStudio.importUrls({ items: [{ url }], auto_tag: false })
        const imported = result.items[0]
        if (imported?.ok !== true || imported.asset_id === undefined) {
          throw new Error(imported?.reason ?? '远程图片导入失败')
        }
        const asset = await apiImage.asset(imported.asset_id)
        const s = useCanvasStore.getState()
        s.snapshot()
        s.addNode({
          id: newNodeId(),
          type: 'image',
          x: point.x - IMAGE_NODE_W / 2,
          y: point.y - 120,
          w: IMAGE_NODE_W,
          title: asset.prompt || '外部图片',
          items: [{ asset_id: asset.id, kind: 'image', w: asset.width, h: asset.height }],
        })
        toast.success('外部图片已入库并放到画布')
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '远程图片导入失败')
      }
    },
    [],
  )

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"]') !== null) return
      if (document.querySelector('.overlay') !== null) return
      const files = Array.from(event.clipboardData?.files ?? [])
      if (files.length > 0) {
        event.preventDefault()
        void importFilesAt(files, centerFlowPoint())
        return
      }
      event.preventDefault()
      pasteNodes()
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [centerFlowPoint, importFilesAt])

  const onCanvasDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).some((type) => type === 'Files' || type.startsWith('text/') || type === CANVAS_ASSET_MIME)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDraggingFiles(true)
  }, [])

  const onCanvasDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      event.preventDefault()
      setDraggingFiles(false)
      const point = screenToCanvas(event.clientX, event.clientY)
      const panelAsset = event.dataTransfer.getData(CANVAS_ASSET_MIME)
      if (panelAsset !== '') {
        try {
          addPanelAssetAt(JSON.parse(panelAsset) as CanvasPanelAsset, point)
        } catch {
          toast.error('无法读取拖入的资产')
        }
        return
      }
      const files = Array.from(event.dataTransfer.files)
      if (files.length > 0) {
        void importFilesAt(files, point)
        return
      }
      const url = remoteImageFromTransfer(event.dataTransfer)
      if (url !== null) void importRemoteImageAt(url, point)
    },
    [addPanelAssetAt, importFilesAt, importRemoteImageAt],
  )

  const downloadGroupImages = useCallback(
    async (nodeId: string) => {
      const node = useCanvasStore.getState().nodes.find((candidate) => candidate.id === nodeId)
      const assetIds = Array.from(
        new Set((node?.items ?? []).flatMap((item) =>
          item.kind === 'image' && item.asset_id !== undefined ? [item.asset_id] : [],
        )),
      )
      if (assetIds.length === 0) {
        toast.error('分组内还没有已入库图片')
        return
      }
      try {
        const result = await apiStudio.downloadOutputImages({
          asset_ids: assetIds,
          filename: `${title || '画布'}-${node?.title || '分组'}`,
        })
        saveFile(result.blob, result.filename)
        toast.success(`已打包 ${assetIds.length} 张原图`)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '批量下载失败')
      }
    },
    [title],
  )

  const commitTitle = async () => {
    const next = (titleDraft ?? '').trim()
    setTitleDraft(null)
    if (next === '' || next === title) return
    useCanvasStore.getState().setTitle(next)
    try {
      // meta 单独走 PATCH，不刷 updated_at（BR-146）
      await apiStudio.patchCanvasMeta(canvasId, { title: next })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '改名失败')
    }
  }

  const selNode =
    selectedNodeIds.length === 1 ? nodes.find((n) => n.id === selectedNodeIds[0]) ?? null : null
  const previewNode = previewing === null ? null : nodes.find((node) => node.id === previewing) ?? null
  const selectedWorkflowNodes = nodes.filter((node) => selectedNodeIds.includes(node.id))
  const selectedWorkflowIds = new Set(selectedWorkflowNodes.map((node) => node.id))
  const selectedWorkflowConnections = connections.filter(
    (connection) => selectedWorkflowIds.has(connection.from) && selectedWorkflowIds.has(connection.to),
  )

  /* 顶栏分五档降级，阈值与分组规则都在 canvas-topbar.ts。
     旧写法是一个 1360 的开关：过了就把 12 个次要按钮全摊开，
     而全摊开要 1900+ 才装得下——1512 视口实测溢出 177px，标题被压到 16px、
     最右边的按钮点不到。四条查询一起订阅，命中的最高档就是当前档。 */
  const barSm = useMediaQuery(TOPBAR_MEDIA.sm)
  const barMd = useMediaQuery(TOPBAR_MEDIA.md)
  const barLg = useMediaQuery(TOPBAR_MEDIA.lg)
  const barXl = useMediaQuery(TOPBAR_MEDIA.xl)
  const tier = tierFromMatches({ sm: barSm, md: barMd, lg: barLg, xl: barXl })

  /** 次要工具。栏上留几个由档位决定，剩下的原样进「更多」——
   *  两处同一份定义，不会出现「菜单里有、栏上没有」这种对不上的情况。
   *  顺序即优先级：越靠前越晚被折进菜单。 */
  /** 选中节点所在链路一共多少个节点。「一键整理」按钮的可用判据——
   *  链路只有它自己（或什么都没选）时按钮是灰的，点了也没有可整理的东西。 */
  const chainSize = useMemo(
    () => clusterOf(selectedNodeIds, nodeBoxOf).length,
    [selectedNodeIds, nodes, connections],
  )

  const secondary = useMemo<TopbarItem[]>(
    () => [
      {
        key: 'arrange',
        label: '一键整理',
        icon: <LayoutGrid />,
        title:
          chainSize > 1
            ? `把选中节点所在的整条链路（${chainSize} 个节点）按连线排成从左到右的列`
            : '先选中链路上任意一个节点：它至少要连着一个别的节点',
        disabled: chainSize < 2,
        onSelect: () => {
          const count = arrangeCluster(selectedNodeIds, nodeBoxOf)
          if (count > 0) toast.success(`已整理这条链路上的 ${count} 个节点`)
        },
      },
      { key: 'media', label: '媒体资产', title: '把已经生成或本地导入的视频、音频、文件放进画布', onSelect: () => setMediaPicker(true) },
      {
        key: 'assets',
        /* 栏上恒为「资产库」、菜单里才带开合状态：栏上跟着状态改字，
           按钮宽度会在每次开合时跳一下，右边一串按钮跟着位移 */
        label: assetPanel ? '收起资产库' : '资产库',
        barLabel: '资产库',
        active: assetPanel,
        title: '打开可拖拽的图片、视频、音频、文件与工作流资产栏',
        onSelect: () => setAssetPanel((open) => !open),
      },
      { key: 'wf', label: '工作流', icon: <IconTask />, title: '添加 ComfyUI / RunningHub 可执行工作流节点', onSelect: () => { setWorkflowPickerPoint(null); setWorkflowPicker(true) } },
      { key: 'llm', label: 'LLM', icon: <MessageSquareText />, title: '独立模型节点：改写上游文字、看图或保留多轮对话', onSelect: () => addAtCenter(nodeDefaults('llm')) },
      { key: 'modelscope', label: 'ModelScope', icon: <CloudLightning />, title: '使用 ModelScope 原生异步协议生图，支持参考图与 LoRA', onSelect: () => addAtCenter(nodeDefaults('modelscope')) },
      { key: 'midjourney', label: 'Midjourney', icon: <Sparkles />, title: 'APIMart 原生任务，支持放大、变体、缩放、平移和局部重绘', onSelect: () => addAtCenter(nodeDefaults('midjourney')) },
      { key: 'loop', label: '循环', icon: <IconRepeatOne />, title: '轮次控制：它的直接下游就是级联的起点', onSelect: () => addAtCenter(nodeDefaults('loop')) },
      {
        key: 'tplsave',
        label: '存模板',
        title: selectedNodeIds.length > 0 ? `把选中的 ${selectedNodeIds.length} 个节点存成模板` : '存模板要先选中一批节点（Shift 拖空白框选）',
        disabled: selectedNodeIds.length === 0,
        onSelect: () => setSaveTpl(true),
      },
      { key: 'tpluse', label: '套模板', title: '套用一个模板到当前画布', onSelect: () => setUseTpl(true) },
      { key: 'io', label: '导入/导出', icon: <IconDownload />, title: '导出选中节点，或把 JSON / ZIP 工作流追加到当前画布', onSelect: () => setWorkflowTransfer(true) },
      { key: 'logs', label: '生成日志', icon: <ScrollText />, title: '查看当前画布的持久任务、提示词、错误与输出', onSelect: () => setRunLog(true) },
      { key: 'repair', label: '资源修复', icon: <Wrench />, title: '核对当前画布的本地资产引用并替换缺失项', onSelect: () => setResourceRepair(true) },
    ],
    [assetPanel, chainSize, selectedNodeIds, addAtCenter],
  )

  /* 所有 hooks 都必须在错误分支之前执行。load() 是异步的，正常画布切到 404 时
     loadError 会在一次已完成渲染后变化；把 return 放在 useMediaQuery/useMemo 前面
     会让 React 看到本次少跑两个 hook，直接把整页交给 ErrorBoundary。 */
  if (!Number.isFinite(canvasId)) {
    return (
      <main className="page scv-page">
        <div className="scv-fault">画布地址不对。<button className="btn btn-outline" onClick={() => navigate('/studio/canvas')}>回列表</button></div>
      </main>
    )
  }
  if (loadError !== null) {
    return (
      <main className="page scv-page">
        <div className="scv-fault">
          {loadError}
          <button className="btn btn-outline" onClick={() => navigate('/studio/canvas')}>回列表</button>
        </div>
      </main>
    )
  }
  /* 当前档位放得下哪些次要工具，剩下的进「更多」。分组逻辑在 canvas-topbar.ts，
     纯函数、有单测；这里只负责把两个数组渲染出来。 */
  const { bar: barItems, more: moreItems } = splitTopbarItems(secondary, tier)
  /* 最窄一档只留图标：文字进 title 与 aria-label，命中区由 css 撑到 32px */
  const iconOnly = topbarIconOnly(tier)
  const barBtn = (it: TopbarItem): JSX.Element => {
    const text = it.barLabel ?? it.label
    return (
      <button
        key={it.key}
        className={`btn btn-outline btn-sm${it.active === true ? ' is-active' : ''}`}
        title={it.title ?? text}
        aria-label={text}
        disabled={it.disabled}
        onClick={it.onSelect}
      >
        {it.icon}
        {iconOnly && it.icon !== undefined ? null : <span>{text}</span>}
      </button>
    )
  }

  return (
    <main className="page scv-page">
      {/* 顶栏分三段：左边身份（返回/标题/状态）、中间创建类操作、右边视图辅助。
          25 个控件平铺一行是溢出的根因——中段按档位只留放得下的，其余进「更多」。 */}
      <header className="scv-topbar">
        <div className="scv-bar-lead">
          <button className="btn-ghost-sm scv-bar-icon" title="回画布列表" aria-label="回画布列表" onClick={() => navigate('/studio/canvas')}>
            <IconArrowLeft />
          </button>
          {titleDraft === null ? (
            <button className="scv-title" title={title || '未命名画布'} onClick={() => setTitleDraft(title)}>
              {title || '未命名画布'}
            </button>
          ) : (
            <input
              className="scv-title-input"
              value={titleDraft}
              autoFocus
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => void commitTitle()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitTitle()
                if (e.key === 'Escape') {
                  // 两段式：Esc 先退出改名，不往上冒去关别的层（STD-UI-002b）
                  e.stopPropagation()
                  setTitleDraft(null)
                }
              }}
            />
          )}
          <span className="scv-kind">
            {kind === 'classic' ? '经典画布 · Shift 框选' : '智能画布 · ⌘/Ctrl 或 R 框选'}
          </span>
          <span className={`scv-save scv-save-${saveState}`}>{SAVE_LABEL[saveState]}</span>
        </div>

        <div className="scv-bar-acts">
          <input
            ref={importRef}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              const files = Array.from(event.target.files ?? [])
              if (files.length > 0) void importFilesAt(files, centerFlowPoint())
              event.target.value = ''
            }}
          />
          <button
            className="btn btn-outline btn-sm"
            title="从本机导入图片、视频、音频或文件；也可以直接拖入画布或粘贴截图"
            aria-label="导入素材"
            disabled={importing}
            onClick={() => importRef.current?.click()}
          >
            <IconUpload />
            {iconOnly ? null : <span>{importing ? '导入中…' : '导入素材'}</span>}
          </button>
          <button className="btn btn-outline btn-sm" title="从素材库或本机加一个图片节点" aria-label="加图片节点" onClick={() => setPicker(true)}>
            <IconImage />
            {iconOnly ? null : <span>+ 图片</span>}
          </button>
          <button
            className="btn btn-outline btn-sm"
            title="添加原生视频节点：可连接图片作为首帧参考"
            aria-label="加视频节点"
            onClick={() => addAtCenter(nodeDefaults('video'))}
          >
            <IconVideo />
            {iconOnly ? null : <span>+ 视频</span>}
          </button>
          <button
            className="btn btn-outline btn-sm"
            title="添加提示词节点"
            aria-label="加提示词节点"
            onClick={() => addAtCenter(nodeDefaults('prompt'))}
          >
            <IconPlus />
            {iconOnly ? null : <span>提示词</span>}
          </button>
          <button
            className="btn btn-outline btn-sm"
            title="画布中的画布：图片拖进来被吸收成网格，整组可当参考"
            aria-label="加分组节点"
            onClick={() => addAtCenter(nodeDefaults('group'))}
          >
            <IconSidebar />
            {iconOnly ? null : <span>分组</span>}
          </button>
          {barItems.map(barBtn)}
          <TopbarMore items={moreItems} />
        </div>

        <div className="scv-bar-tail">
          <span className="scv-hint">拖手柄连参考 · Shift 拖空白框选</span>
          <button className="btn-ghost-sm scv-bar-icon" title="快捷键（?）" aria-label="快捷键" onClick={() => setKeys(true)}>
            <IconHelp />
          </button>
        </div>
      </header>

      <div
        className={`scv-stage${draggingFiles ? ' scv-stage-dropping' : ''}`}
        onDragOver={onCanvasDragOver}
        onDragLeave={(event) => {
          const next = event.relatedTarget
          if (!(next instanceof HTMLElement) || !event.currentTarget.contains(next)) setDraggingFiles(false)
        }}
        onDrop={onCanvasDrop}
      >
        {loaded && (
          <CanvasBoard
            kind={kind}
            nodes={nodes}
            connections={connections}
            selectedNodeIds={selectedNodeIds}
            selectedEdgeIds={selectedEdgeIds}
            edgeStates={edgeStates}
            running={running}
            viewport={initialViewport}
            animOff={animOff}
            onEditNode={(id) => openEditor(id, 'crop')}
            onNodeTool={(id, mode, assetId) => openEditor(id, mode, assetId)}
            onUpscaleNode={jimengUpscaleDeployment === undefined ? undefined : runJimengUpscale}
            onOpenNode={openNode}
            onBlankMenu={(world, client) => {
              setCreateMenu({ clientX: client.x, clientY: client.y, point: world })
            }}
            onNodeMenu={(id, screen, world) => {
              const node = useCanvasStore.getState().nodes.find((candidate) => candidate.id === id)
              if (kind === 'smart' && node?.type === 'group') {
                useCanvasStore.getState().selectOnly([id])
                setNodeMenu(null)
                setCreateMenu({
                  clientX: screen.x,
                  clientY: screen.y,
                  point: world,
                  groupId: id,
                })
                return
              }
              setNodeMenu({ id, at: screen })
            }}
            onDownloadNode={(id, assetId) => {
              const node = useCanvasStore.getState().nodes.find((n) => n.id === id)
              const items = node?.items ?? []
              /* **入库图只有 asset_id，没有 url**——`url` 那个字段只有外部导入的图才填。
                 之前这里按 `it.url` 找，于是画布上自己生成出来的图点下载一律
                 提示「还没有可下载的图」，只有导入的能下。判据改成两者都认，
                 优先点中的那一张（多图节点点第 3 张就该下第 3 张）。 */
              const hit =
                (assetId === undefined ? undefined : items.find((it) => it.asset_id === assetId)) ??
                items.find((it) => it.asset_id !== undefined || (it.url ?? '') !== '')
              if (hit === undefined) {
                toast.error('这个节点还没有可下载的图')
                return
              }
              /* 下载而不是 window.open：后者会被弹窗拦截，壳里还会被当外链送去系统浏览器。
                 按钮写的是「原图」，就得取 full 而不是 display（display 是压过的展示变体） */
              saveFile(itemSrc(hit, 'full'), hit.name ?? `canvas-${hit.asset_id ?? id}.png`)
            }}
            onDownloadGroup={(id) => void downloadGroupImages(id)}
            onEdgeMenu={(conn, screen) => setEdgeMenu({ conn, at: screen })}
            onPortDrop={(fromId, side, world, screen) => {
              if (side === 'out' && createAutoOutput(fromId, world) !== null) return
              setPortMenu({ fromId, side, world, at: screen })
            }}
          />
        )}
        {!loaded && <div className="scv-loading">载入画布…</div>}
        {loaded && nodes.length === 0 && (
          <div className="scv-empty-hint">空画布：先「+ 图片」从素材库/本地拉图，或加一个空图节点直接出图</div>
        )}
        {draggingFiles && <div className="scv-drop-hint">松手导入素材 · 会先入资产库，再生成画布节点</div>}

        {createMenu !== null && (
          <CanvasCreateMenu
            kind={kind}
            state={createMenu}
            onCreate={(patch) => {
              const id = addAtPoint(patch, createMenu.point)
              if (createMenu.groupId !== undefined && patch.type !== 'group') {
                placeNodeInGroup(createMenu.groupId, id)
              }
              useCanvasStore.getState().selectOnly([id])
              setCreateMenu(null)
            }}
            onWorkflow={() => {
              setWorkflowPickerPoint(createMenu.point)
              setWorkflowPicker(true)
              setCreateMenu(null)
            }}
            onMiniMax={() => {
              const { point, groupId } = createMenu
              setCreateMenu(null)
              void addMiniMaxAt(point, groupId)
            }}
            onClose={() => setCreateMenu(null)}
          />
        )}

        {assetPanel && (
          <CanvasAssetPanel
            onClose={() => setAssetPanel(false)}
            onAdd={(payload) => addPanelAssetAt(payload, centerFlowPoint())}
          />
        )}

        {cascade !== null && (
          <div className="scv-runbar">
            <span className="scv-runbar-dot" />
            <span className="scv-runbar-text">
              {cascade.mode === 'serial'
                ? `第 ${Math.min(cascade.doneRounds + 1, cascade.total)}/${cascade.total} 轮`
                : `已完成 ${cascade.doneRounds}/${cascade.total} 轮 · 并行在跑 ${cascade.activeRounds.length}`}
              {' · '}
              {cascade.nodeLabel}
            </span>
            <button
              className="btn btn-outline btn-sm"
              disabled={cascade.stopRequested}
              title="当前这个任务收尾后中断后续轮次，已出的图全部保留"
              onClick={() => useCanvasStore.getState().stopCascade()}
            >
              {cascade.stopRequested ? '收尾中…' : '停止'}
            </button>
          </div>
        )}

        {selNode !== null && selNode.type === 'image' && (
          <GenerateBar
            node={selNode}
            running={selNode.id in running}
            cascading={cascade !== null}
            onSetPlan={(nodeId, refs, auto) => setSetPlanFor({ nodeId, refs, auto })}
          />
        )}
        {selNode !== null && selNode.type === 'video' && (
          <VideoGenerateBar
            node={selNode}
            running={selNode.id in running}
            cascading={cascade !== null}
          />
        )}
        {selNode !== null && selNode.type === 'workflow' && (
          <WorkflowRunBar
            node={selNode}
            running={selNode.id in running}
            cascading={cascade !== null}
          />
        )}

        {/* 选中两个以上：**输入框不再被换掉**，只是作用域从「这一个」变成「这 N 个」。
            旧口径是「这时候用户要的是排版与删改，不是出图」——那条假设正好错在
            最常见的一幕：选中一批图，想一句话全改一遍。排版与删改收成上面那条
            精简的批量条（排版三组默认折叠），两者并排而不是互相顶掉。 */}
        {selectedNodeIds.length > 1 && (
          <div className="scv-bulkdock">
            <BulkBar ids={selectedNodeIds} />
            <BulkComposer ids={selectedNodeIds} />
          </div>
        )}
      </div>

      {keys && (
        <KeysHelp
          actions={new Set(Object.keys(shortcutHandlers) as ShortcutAction[])}
          onClose={() => setKeys(false)}
        />
      )}

      {runLog && <CanvasRunLog canvasId={canvasId} onClose={() => setRunLog(false)} />}
      {resourceRepair && (
        <CanvasResourceRepair canvasId={canvasId} onClose={() => setResourceRepair(false)} />
      )}

      {workflowTransfer && (
        <CanvasWorkflowTransfer
          title={title}
          nodes={selectedWorkflowNodes as unknown as CanvasNode[]}
          connections={selectedWorkflowConnections as CanvasConnection[]}
          onClose={() => setWorkflowTransfer(false)}
          onImport={(result) => {
            const point = centerFlowPoint()
            const minX = Math.min(...result.nodes.map((node) => node.x))
            const minY = Math.min(...result.nodes.map((node) => node.y))
            const dx = point.x - minX
            const dy = point.y - minY
            const s = useCanvasStore.getState()
            s.snapshot()
            for (const node of result.nodes) {
              s.addNode({ ...node, x: node.x + dx, y: node.y + dy } as ScvNode)
            }
            for (const connection of result.connections) s.addConnection(connection)
            s.selectOnly(result.nodes.map((node) => node.id))
            setWorkflowTransfer(false)
          }}
        />
      )}

      {/* 画布编辑器（FR-466）。产物已由编辑器自己入库，这里只负责把它接回画布：
          浏览器内处理（裁剪/切分/拼接）落在同一个节点上，交给模型的（遮罩重绘/扩图）
          按 FR-463 的分支式输出另起节点，原图保留——两类操作的可逆性不同，
          落法不该一样。 */}
      {/* 双击循环节点进的是**成套弹窗**：用户只说想要什么，
          轮数/并发/每轮的词由方案推出来。旧的参数表单还在
          `LoopConfigDialog`，从节点上的「手动配参数」进——
          偶尔要精确控制轮次的人还需要它。 */}
      {setPlanFor !== null && (
        <SetPlanDialog
          nodeId={setPlanFor.nodeId}
          refs={setPlanFor.refs}
          autoStart={setPlanFor.auto === true}
          onClose={() => setSetPlanFor(null)}
          onRun={(plan) => void runSetPlan(setPlanFor.nodeId, plan)}
        />
      )}
      {manualLoop !== null && (
        <LoopConfigDialog nodeId={manualLoop} onClose={() => setManualLoop(null)} />
      )}

      {editing !== null && (() => {
        const node = nodes.find((n) => n.id === editing.nodeId)
        /* 判据走 `imageAssetIds`，与分组小菜单的可用性同一条：按 `items[0].asset_id`
           判「有没有图」的话，组里第一个 item 是提示词成员或没入库的占位时，
           小菜单上预览亮着、点下去什么都不发生。 */
        const ids = imageAssetIds(node)
        const first = ids[0]
        if (node === undefined || first === undefined) return null
        return (
          <CanvasEditorHost
            nodeId={node.id}
            /* 从分组小菜单进来时这批图来自整个分组：编辑器据此把翻页提示与
               宫格拼接的说明改成「这个分组」，否则用户在分组上点预览，
               弹窗却说「这个节点共 N 张」 */
            scope={node.type === 'group' ? 'group' : 'node'}
            assetId={editing.assetId ?? first}
            initialMode={editing.mode}
            siblingIds={ids}
            onClose={() => setEditing(null)}
          />
        )
      })()}

      {saveTpl && (
        <SaveTemplateDialog
          nodes={nodes.filter((n) => selectedNodeIds.includes(n.id)) as unknown as CanvasNode[]}
          connections={
            connections.filter(
              (c) => selectedNodeIds.includes(c.from) && selectedNodeIds.includes(c.to),
            ) as CanvasConnection[]
          }
          onDone={(tpl) => {
            setSaveTpl(false)
            toast.success(`已存成模板「${tpl.name}」（${tpl.node_count} 节点 · ${tpl.asset_count} 张图）`)
          }}
          onClose={() => setSaveTpl(false)}
        />
      )}

      {useTpl && (
        <TemplatePicker
          onApply={(result) => {
            const s = useCanvasStore.getState()
            s.snapshot()
            // 服务端已经把 id 重映射过，直接追加即可
            for (const n of result.nodes) s.addNode(n as unknown as ScvNode)
            for (const c of result.connections) s.addConnection(c)
            setUseTpl(false)
            toast.success(
              result.missing.length === 0
                ? `已套用：${result.nodes.length} 个节点，复用了 ${result.reused} 张图`
                : `已套用：${result.nodes.length} 个节点，复用 ${result.reused} 张，${result.missing.length} 张库里找不到已留空位`,
            )
          }}
          onClose={() => setUseTpl(false)}
        />
      )}

      {picker && (
        <AssetPicker
          onClose={() => setPicker(false)}
          onPick={(asset) => {
            addAtCenter(
              {
                ...nodeDefaults('image'),
                items: [{ asset_id: asset.id, kind: 'image', w: asset.width, h: asset.height }],
              },
              Math.round(Math.random() * 48),
            )
          }}
        />
      )}
      {mediaPicker && (
        <MediaAssetPicker
          onClose={() => setMediaPicker(false)}
          onPick={(asset) => {
            addAtCenter(
              {
                type: asset.kind,
                w: asset.kind === 'video' ? 320 : 300,
                title: asset.name,
                items: [itemFromMediaAsset(asset)],
              },
              Math.round(Math.random() * 48),
            )
          }}
        />
      )}
      {workflowPicker && (
        <WorkflowNodePicker
          onClose={() => setWorkflowPicker(false)}
          onPick={(workflow) => {
            const patch = workflowNodePatch(workflow)
            if (workflowPickerPoint === null) {
              addAtCenter(patch, Math.round(Math.random() * 48))
            } else {
              addAtPoint(patch, workflowPickerPoint)
            }
            setWorkflowPickerPoint(null)
          }}
        />
      )}

      {previewNode !== null && (
        <MediaNodePreview node={previewNode} onClose={() => setPreviewing(null)} />
      )}

      {nodeMenu !== null && (() => {
        const node = nodes.find((n) => n.id === nodeMenu.id)
        if (node === undefined) return null
        return (
          <CanvasNodeMenu
            node={node}
            canvasTitle={title}
            at={nodeMenu.at}
            onEdit={(id, mode) => openEditor(id, mode)}
            onPreview={(id) => openNode(id)}
            onClose={() => setNodeMenu(null)}
          />
        )
      })()}

      {edgeMenu !== null && (
        <CanvasEdgeMenu conn={edgeMenu.conn} at={edgeMenu.at} onClose={() => setEdgeMenu(null)} />
      )}

      {portMenu !== null && (
        <CanvasPortMenu
          fromId={portMenu.fromId}
          side={portMenu.side}
          world={portMenu.world}
          at={portMenu.at}
          onClose={() => setPortMenu(null)}
        />
      )}
    </main>
  )
}

function CanvasCreateMenu({
  kind,
  state,
  onCreate,
  onWorkflow,
  onMiniMax,
  onClose,
}: {
  kind: 'classic' | 'smart'
  state: CanvasCreateMenuState
  onCreate: (patch: Omit<ScvNode, 'id' | 'x' | 'y'>) => void
  onWorkflow: () => void
  onMiniMax: () => void
  onClose: () => void
}) {
  /* 落点：先按右键处翻转避让，之后由用户拖动微调（拖过就以拖后的为准）。
     智能画布对齐源项目 500px 的五卡菜单；普通画布保留完整节点表。 */
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null)
  const grab = useRef<{ id: number; sx: number; sy: number; dx: number; dy: number } | null>(null)
  const menuWidth = kind === 'smart' ? 500 : 370
  const baseLeft = Math.max(12, Math.min(window.innerWidth - menuWidth - 14, state.clientX + 8))
  const baseTop = Math.max(12, Math.min(window.innerHeight - 240, state.clientY + 8))
  const left = baseLeft + (drag?.dx ?? 0)
  const top = baseTop + (drag?.dy ?? 0)

  /* 点菜单外面就关。
     **监听 mousedown 而不是 click**：打开菜单的那次 click 还在冒泡，
     刚注册的 listener 会立刻收到它并把菜单关掉（表现为「右键点了没反应」）。 */
  useEffect(() => {
    const off = (e: MouseEvent): void => {
      if ((e.target as HTMLElement | null)?.closest('.scv-create-menu') === null) onClose()
    }
    // 用 capture：画布自己也在 window 上收 pointerdown，抢在它前面拿到
    window.addEventListener('mousedown', off, true)
    return () => window.removeEventListener('mousedown', off, true)
  }, [onClose])

  return (
    <div
      className={kind === 'smart' ? 'scv-create-menu scv-create-menu-smart' : 'scv-create-menu'}
      style={{ left, top }}
      role="menu"
      aria-label="新建画布节点"
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {/* 标题栏就是拖动把手：菜单常常正好盖住用户想参考的那个节点 */}
      <header
        className="scv-create-grab"
        onPointerDown={(e) => {
          if (e.button !== 0 || (e.target as HTMLElement).closest('button') !== null) return
          capturePointer(e.currentTarget, e.pointerId)
          grab.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, dx: drag?.dx ?? 0, dy: drag?.dy ?? 0 }
        }}
        onPointerMove={(e) => {
          const g = grab.current
          if (g === null || g.id !== e.pointerId) return
          setDrag({ dx: g.dx + (e.clientX - g.sx), dy: g.dy + (e.clientY - g.sy) })
        }}
        onPointerUp={(e) => {
          releasePointer(e.currentTarget, e.pointerId)
          grab.current = null
        }}
      >
        <strong>{state.groupId === undefined ? '在这里新建' : '在分组内新建'}</strong>
        <button aria-label="关闭新建菜单" onClick={onClose}>×</button>
      </header>
      <div>
        {/* 菜单成员、图标、措辞与默认值全部来自节点注册表：以前这两套菜单各写一遍，
            同一个循环节点在智能画布建出来是 1 轮、经典画布是 3 轮 */}
        {createMenuTypes(kind).map((type) => {
          const definition = NODE_DEFINITIONS[type]
          const smart = kind === 'smart'
          const Icon = (smart ? definition.smartIcon : undefined) ?? definition.icon
          const label = (smart ? definition.smartLabel : undefined) ?? definition.label
          const hint = (smart ? definition.smartHint : undefined) ?? definition.hint
          return (
            <button key={type} role="menuitem" onClick={() => onCreate(nodeDefaults(type))}>
              <Icon /><span><strong>{label}</strong><small>{hint}</small></span>
            </button>
          )
        })}
        {/* 这两项建不出来：工作流要先选一份定义，MiniMax 要先取内置工作流并铺一条时间轴 */}
        {kind === 'smart' ? (
          <button role="menuitem" onClick={onMiniMax}>
            <Clapperboard /><span><strong>MiniMax</strong><small>时间轴片段生成视频</small></span>
          </button>
        ) : (
          <button role="menuitem" onClick={onWorkflow}>
            <IconTask /><span><strong>{NODE_DEFINITIONS.workflow.label}</strong><small>{NODE_DEFINITIONS.workflow.hint}</small></span>
          </button>
        )}
      </div>
    </div>
  )
}

function MediaNodePreview({ node, onClose }: { node: ScvNode; onClose: () => void }) {
  const item = node.items?.[node.items.length - 1]
  return (
    <Overlay onClose={onClose} card="scv-media-preview" labelledBy="scv-media-preview-title">
      <header className="scv-picker-head">
        <div>
          <h3 id="scv-media-preview-title">{node.title ?? item?.name ?? '媒体预览'}</h3>
          <span className="scv-picker-sub">{item?.mime ?? node.type}</span>
        </div>
        <button className="btn-ghost-sm" aria-label="关闭" onClick={onClose}>×</button>
      </header>
      {item?.url === undefined ? (
        <p className="scv-picker-note">这个节点还没有可预览的资产</p>
      ) : item.kind === 'video' ? (
        <video src={item.url} poster={item.poster_url ?? undefined} controls autoPlay playsInline />
      ) : item.kind === 'audio' ? (
        <div className="scv-media-preview-audio"><audio src={item.url} controls autoPlay /></div>
      ) : (
        <div className="scv-media-preview-file">
          <strong>{item.name ?? '未命名文件'}</strong>
          <a className="btn btn-primary" href={item.url} download={item.name}>下载文件</a>
        </div>
      )}
    </Overlay>
  )
}

function WorkflowRunBar({
  node,
  running,
  cascading,
}: {
  node: ScvNode
  running: boolean
  cascading: boolean
}) {
  const [materialPicker, setMaterialPicker] = useState<'video' | 'audio' | null>(null)
  const canvasId = useCanvasStore((state) => state.canvasId)
  const nodes = useCanvasStore((state) => state.nodes)
  const connections = useCanvasStore((state) => state.connections)
  const updateNode = useCanvasStore((state) => state.updateNode)
  const snapshot = useCanvasStore((state) => state.snapshot)
  const detail = useQuery({
    queryKey: ['studio-workflow', node.workflow_id, 'canvas'],
    queryFn: () => apiStudio.workflow(node.workflow_id as number),
    enabled: node.workflow_id !== undefined,
  })
  const credentials = useQuery({
    queryKey: ['cfg-creds', 'workflow', 'canvas'],
    queryFn: () => apiConfig.credentials('workflow'),
  })
  const runningHubCatalog = useQuery({
    queryKey: ['studio-workflows', 'runninghub', 'canvas-node'],
    queryFn: () => apiStudio.workflows('?provider=runninghub'),
    enabled: node.workflow_provider === 'runninghub',
  })
  const taskHistory = useQuery({
    queryKey: ['canvas-workflow-history', canvasId, node.id],
    queryFn: () => apiStudio.tasks({ canvas_id: canvasId as number, node_id: node.id, limit: 8 }),
    enabled: canvasId !== null,
    refetchInterval: running ? 1500 : false,
  })
  const refs = useMemo(
    () => refAssetIds(nodes, connections, node.id),
    [connections, node.id, nodes],
  )
  const mediaRefs = useMemo(
    () => refMediaItems(nodes, connections, node.id),
    [connections, node.id, nodes],
  )
  const linkedPrompt = useMemo(
    () => composePrompt(nodes, connections, node.id),
    [connections, node.id, nodes],
  )
  const allFields = workflowFields(detail.data).filter(
    (field) => detail.data?.provider === 'comfyui' || field.enabled !== false,
  )
  const timelineMode = workflowTimelineMode(detail.data?.title ?? node.title)
  const fields = allFields.filter((field, index) => {
    const id = workflowFieldId(field, index)
    return field.hidden !== true && !timelineControlledField(
      timelineMode,
      id,
      field,
      detail.data?.provider,
    )
  })
  const values = node.workflow_values ?? {}
  const randomFields = node.workflow_random_fields ?? {}
  const runningHubKind = detail.data?.kind ?? node.workflow_kind
  const options = (credentials.data ?? []).filter(
    (credential) => credential.enabled && credential.provider_type === node.workflow_provider,
  )
  const credentialId =
    options.find((credential) => credential.id === node.workflow_credential_id)?.id ?? options[0]?.id ?? null
  const mediaByKind = useMemo(() => workflowMediaByKind(mediaRefs), [mediaRefs])
  const preparedRun = detail.data === undefined
    ? null
    : prepareCanvasWorkflowRun(detail.data, node, mediaRefs, linkedPrompt)
  const missingMedia = preparedRun?.missingMedia ?? []
  const acceptsVideo = allFields.some((field) => workflowFieldMediaKind(field) === 'video')
  const acceptsAudio = allFields.some((field) => workflowFieldMediaKind(field) === 'audio')
  const setValue = (id: string, value: unknown) =>
    updateNode(node.id, { workflow_values: { ...values, [id]: value } })
  const busy = running || cascading

  const execute = () => {
    if (credentialId === null || preparedRun === null) return
    void runWorkflowFrom(
      node.id,
      credentialId,
      preparedRun.fields,
      node.workflow_use_wallet ?? false,
      node.workflow_instance_type ?? '',
      preparedRun.sourceContext,
    )
  }

  return (
    <div className="scv-workflow-bar">
      <header>
        <div>
          <strong>{node.title ?? '工作流'}</strong>
          <span>
            {detail.data?.provider ?? node.workflow_provider}
            {(detail.data?.provider ?? node.workflow_provider) === 'runninghub'
              ? runningHubKind === 'model'
                ? ' Model API'
                : runningHubKind === 'app'
                  ? ' AI 应用'
                  : ' 工作流'
              : ''}
            {' '}· {allFields.length} 个参数 · 上游参考{' '}
            {timelineMode === 'minimax'
              ? `${mediaRefs.filter((item) => item.kind === 'image').length} 图 / ${mediaRefs.filter((item) => item.kind === 'video').length} 视频 / ${mediaRefs.filter((item) => item.kind === 'audio').length} 音频`
              : timelineMode === 'ltx'
                ? `${refs.length} 图 / ${mediaRefs.filter((item) => item.kind === 'audio').length} 音频`
              : `${refs.length} 张`}
          </span>
        </div>
        <GeneratorEnginePicker node={node} disabled={busy} />
        {node.workflow_provider === 'runninghub' && (runningHubCatalog.data?.items.length ?? 0) > 0 && (
          <Picker
            size="sm"
            value={node.workflow_id === undefined ? '' : String(node.workflow_id)}
            placeholder="选择 RunningHub 配置"
            onChange={(v) => {
              const selected = runningHubCatalog.data?.items.find((item) => item.id === Number(v))
              if (selected === undefined) return
              snapshot()
              updateNode(node.id, {
                workflow_id: selected.id,
                workflow_provider: selected.provider,
                workflow_kind: selected.kind,
                workflow_values: {},
                workflow_random_fields: {},
                title: selected.title,
              })
            }}
            options={(runningHubCatalog.data?.items ?? []).map((item) => ({
              value: String(item.id),
              label: `${item.kind === 'model' ? 'Model API' : item.kind === 'app' ? 'AI 应用' : '工作流'} · ${item.title}`,
            }))}
          />
        )}
        <Picker
          size="sm"
          value={credentialId === undefined || credentialId === null ? '' : String(credentialId)}
          placeholder={options.length === 0 ? '没有可用凭据' : '选择凭据'}
          disabled={options.length === 0}
          onChange={(v) => {
            snapshot()
            updateNode(node.id, { workflow_credential_id: Number(v) })
          }}
          options={options.map((c) => ({ value: String(c.id), label: c.name }))}
        />
        {node.workflow_provider === 'runninghub' && runningHubKind !== 'model' && (
          <>
            <Picker
              size="sm"
              value={node.workflow_use_wallet ? 'wallet' : 'free'}
              onChange={(v) => updateNode(node.id, { workflow_use_wallet: v === 'wallet' })}
              options={[
                { value: 'free', label: 'RunningHub 币 Key' },
                { value: 'wallet', label: '账户余额 Key' },
              ]}
            />
            <Picker
              size="sm"
              value={node.workflow_instance_type === 'plus' ? 'plus' : 'default'}
              onChange={(v) => updateNode(node.id, { workflow_instance_type: v === 'plus' ? 'plus' : '' })}
              options={[
                { value: 'default', label: '24G 标准实例' },
                { value: 'plus', label: '48G Plus 实例' },
              ]}
            />
          </>
        )}
        {node.workflow_provider === 'runninghub' && runningHubKind === 'model' && (
          <span>Model API 固定使用账户余额 Key</span>
        )}
      </header>
      {timelineMode !== null && (
        <WorkflowTimelineEditor
          mode={timelineMode}
          node={node}
          refs={refs}
          mediaRefs={mediaRefs}
          linkedPrompt={linkedPrompt}
          onSnapshot={snapshot}
          onPatch={(patch) => updateNode(node.id, patch)}
        />
      )}
      {(timelineMode === 'minimax'
        || timelineMode === 'ltx'
        || (node.workflow_provider === 'runninghub' && (acceptsVideo || acceptsAudio))) && (
        <div className="scv-workflow-material-actions">
          <span>{timelineMode === 'minimax'
            ? '片段素材库'
            : timelineMode === 'ltx'
              ? 'LTX 音频轨素材'
              : 'RunningHub 媒体输入'}：可从上游连入，也可直接加入节点</span>
          {(timelineMode === 'minimax' || acceptsVideo) && (
            <button type="button" onClick={() => setMaterialPicker('video')}>+ 视频素材</button>
          )}
          {(timelineMode === 'minimax' || timelineMode === 'ltx' || acceptsAudio) && (
            <button type="button" onClick={() => setMaterialPicker('audio')}>+ 音频素材</button>
          )}
          {(node.attachments ?? []).some((item) => item.kind === 'video' || item.kind === 'audio') && (
            <button
              type="button"
              onClick={() => {
                snapshot()
                updateNode(node.id, {
                  attachments: (node.attachments ?? []).filter(
                    (item) => item.kind !== 'video' && item.kind !== 'audio',
                  ),
                })
              }}
            >清空节点素材</button>
          )}
        </div>
      )}
      {materialPicker !== null && (
        <MediaAssetPicker
          kind={materialPicker}
          onClose={() => setMaterialPicker(null)}
          onPick={(asset) => {
            const item = itemFromMediaAsset(asset)
            const attachments = node.attachments ?? []
            if (attachments.some((current) => current.media_asset_id === item.media_asset_id)) return
            snapshot()
            updateNode(node.id, { attachments: [...attachments, item] })
          }}
        />
      )}
      {(taskHistory.data?.items.length ?? 0) > 0 && (
        <details className="scv-workflow-history">
          <summary>运行记录（{taskHistory.data?.items.length ?? 0}）</summary>
          <div>
            {taskHistory.data?.items.map((task) => (
              <article key={task.id}>
                <b data-status={task.status}>{task.status}</b>
                <span>
                  {typeof task.source_context?.workflow_segment_id === 'string'
                    ? `片段 ${task.source_context.workflow_segment_id}`
                    : task.task_type}
                </span>
                <small>{task.error ?? task.stage ?? `${Math.round(task.progress)}%`}</small>
                {task.retryable && ['failed', 'partial', 'cancelled'].includes(task.status) && (
                  <button
                    type="button"
                    disabled={running}
                    onClick={() => void retryCanvasWorkflowTask(task.id, node.id).then(() => taskHistory.refetch())}
                  >重试</button>
                )}
              </article>
            ))}
          </div>
        </details>
      )}
      <div className="scv-workflow-fields">
        {detail.isPending && <span>正在读取参数…</span>}
        {detail.isError && <span className="scv-workflow-error">{detail.error.message}</span>}
        {fields.map((field, index) => {
          const id = workflowFieldId(field, index)
          const type = workflowFieldType(field)
          const value = values[id] ?? workflowFieldDefault(field)
          const label = workflowFieldLabel(field, index)
          const mediaKind = workflowFieldMediaKind(field)
          if (mediaKind !== null) {
            const allIndex = allFields.indexOf(field)
            const mediaIndex = allFields.slice(0, Math.max(0, allIndex)).filter(
              (candidate) => workflowFieldMediaKind(candidate) === mediaKind,
            ).length
            const item = mediaByKind[mediaKind][mediaIndex]
            const explicit = values[id]
            return (
              <label key={id} className="scv-workflow-field scv-workflow-media-field">
                <span>{label}{field.required === true ? ' *' : ''}</span>
                {mediaKind === 'image' && item?.asset_id !== undefined ? (
                  <img src={`/api/images/assets/${item.asset_id}/thumb`} alt="" />
                ) : item !== undefined ? (
                  <strong>{item.name ?? `${mediaKind === 'video' ? '视频' : '音频'}素材 #${item.media_asset_id ?? mediaIndex + 1}`}</strong>
                ) : explicit !== undefined && String(explicit).trim() !== '' ? (
                  <strong>已保存文件值</strong>
                ) : (
                  <em>连接上游{mediaKind === 'image' ? '图片' : mediaKind === 'video' ? '视频' : '音频'}</em>
                )}
              </label>
            )
          }
          if (type === 'boolean') {
            const checked = value === true || String(value).toLowerCase() === 'true'
            return (
              <label key={id} className="scv-workflow-field scv-workflow-check">
                <input type="checkbox" checked={checked} onFocus={snapshot} onChange={(event) => setValue(id, event.target.checked)} />
                <span>{label}</span>
              </label>
            )
          }
          const choices = Array.isArray(field.options) ? field.options.map(String) : []
          const numeric = ['number', 'int', 'integer', 'float', 'slider'].includes(type)
          if (numeric && field.random_enabled === true) {
            const randomActive = randomFields[id] !== false
            return (
              <div key={id} className="scv-workflow-field scv-workflow-random-field">
                <span>{label}</span>
                <div>
                  <input
                    type="number"
                    value={String(value ?? '')}
                    min={field.min === undefined || field.min === '' ? undefined : Number(field.min)}
                    max={field.max === undefined || field.max === '' ? undefined : Number(field.max)}
                    step={field.step === undefined || field.step === '' ? undefined : Number(field.step)}
                    disabled={randomActive}
                    onFocus={snapshot}
                    onChange={(event) => setValue(id, Number(event.target.value))}
                  />
                  <button
                    type="button"
                    aria-pressed={randomActive}
                    onClick={() => {
                      snapshot()
                      updateNode(node.id, {
                        workflow_random_fields: { ...randomFields, [id]: !randomActive },
                      })
                    }}
                  >{randomActive ? '🎲 每次随机' : '固定值'}</button>
                </div>
              </div>
            )
          }
          return (
            <label key={id} className="scv-workflow-field">
              <span>{label}</span>
              {choices.length > 0 || type === 'dropdown' || type === 'select' ? (
                <Picker
                  size="sm"
                  value={String(value ?? '')}
                  onChange={(v) => {
                    snapshot()
                    setValue(id, v)
                  }}
                  options={choices.map((choice) => ({ value: choice, label: choice }))}
                />
              ) : type === 'textarea' ? (
                <textarea
                  value={String(values[id] ?? (field.bind_prompt === true ? linkedPrompt : value) ?? '')}
                  placeholder={field.bind_prompt === true ? '自动使用上游提示词' : undefined}
                  onFocus={snapshot}
                  onChange={(event) => setValue(id, event.target.value)}
                />
              ) : (
                <input
                  type={numeric ? (type === 'slider' ? 'range' : 'number') : 'text'}
                  value={String(value ?? '')}
                  min={field.min === undefined ? undefined : Number(field.min)}
                  max={field.max === undefined ? undefined : Number(field.max)}
                  step={field.step === undefined ? undefined : Number(field.step)}
                  onFocus={snapshot}
                  onChange={(event) => setValue(id, numeric ? Number(event.target.value) : event.target.value)}
                />
              )}
            </label>
          )
        })}
      </div>
      <footer>
        {options.length === 0 && <span>先到工作流中心添加并启用 {node.workflow_provider} 凭据</span>}
        {missingMedia.length > 0 && <span>还缺必填素材：{missingMedia.join('、')}</span>}
        <CanvasCascadeAction nodeId={node.id} disabled={busy} showPlan />
        <button
          className="btn btn-primary"
          disabled={busy || detail.isPending || credentialId === null || missingMedia.length > 0}
          onClick={execute}
        >
          {running
            ? '后台运行中…'
            : timelineMode === 'ltx'
              ? '运行整条时间线'
              : timelineMode === 'minimax'
                ? '生成当前片段'
                : '运行工作流'}
        </button>
      </footer>
    </div>
  )
}

/* ==================== 底部生成悬浮条（FR-463 / FR-464） ==================== */

/** 张数常用档。不是上限——旁边的输入框可以手填任意数 */
const N_PRESETS = [1, 2, 3, 4, 6, 8]
/** 上限**与运行时同源**。两边各写一个数的话，界面允许 50、运行时砍到 4，
 *  用户填了 12 只出 4 张且不报错——这正是上一版的行为。 */
const N_MAX = GEN_N_MAX

const REFERENCE_SOURCE_LABEL: Record<ReferenceAssetEntry['source'], string> = {
  mention: '正文 @ 引用',
  attachment: '输入附件',
  self: '节点自身',
  upstream: '上游输入',
  manual: '手动参考',
}

/** 源项目底部输入器的参考缩略图条（F056）。
 *
 *  手动项才显示删除；拖动会调用 store 改真实 items / attachments / connections，
 *  因而排序不仅刷新界面，也会改变下一次模型请求里的图1、图2顺序。 */
function ReferenceInputStrip({
  node,
  entries,
  label,
  disabled,
  badges,
}: {
  node: ScvNode
  entries: ReferenceAssetEntry[]
  label: string
  disabled?: boolean
  badges?: Map<number, string>
}): JSX.Element {
  const updateNode = useCanvasStore((state) => state.updateNode)
  const snapshot = useCanvasStore((state) => state.snapshot)
  const [picking, setPicking] = useState(false)
  const [dragging, setDragging] = useState<number | null>(null)
  const [drop, setDrop] = useState<{ assetId: number; placement: 'before' | 'after' } | null>(null)

  const removeManual = (assetId: number): void => {
    const next = (node.manual_references ?? []).filter((item) => item.asset_id !== assetId)
    if (next.length === (node.manual_references ?? []).length) return
    snapshot()
    updateNode(node.id, { manual_references: next.length > 0 ? next : undefined })
  }

  return (
    <>
      <span className="scv-refs-label">{label}</span>
      <div className="scv-ref-list" aria-label="参考图列表">
        {entries.map((entry, index) => {
          const placement = drop?.assetId === entry.asset_id ? drop.placement : null
          return (
            <div
              key={entry.asset_id}
              className={`scv-ref-thumb${entry.manual ? ' scv-ref-manual' : ''}${dragging === entry.asset_id ? ' is-dragging' : ''}${placement === 'before' ? ' drop-before' : placement === 'after' ? ' drop-after' : ''}`}
              draggable={disabled !== true && entry.source !== 'mention'}
              title={`${index + 1}. ${REFERENCE_SOURCE_LABEL[entry.source]}${entry.source === 'mention' ? '（请在正文中调整顺序）' : '（拖动排序）'}`}
              onDragStart={(event) => {
                setDragging(entry.asset_id)
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('application/x-lingua-reference', String(entry.asset_id))
              }}
              onDragEnd={() => {
                setDragging(null)
                setDrop(null)
              }}
              onDragOver={(event) => {
                if (dragging === null || dragging === entry.asset_id || entry.source === 'mention') return
                event.preventDefault()
                const rect = event.currentTarget.getBoundingClientRect()
                setDrop({
                  assetId: entry.asset_id,
                  placement: event.clientX < rect.left + rect.width / 2 ? 'before' : 'after',
                })
              }}
              onDrop={(event) => {
                event.preventDefault()
                const raw = event.dataTransfer.getData('application/x-lingua-reference')
                const from = Number(raw || dragging)
                const nextPlacement = drop?.assetId === entry.asset_id ? drop.placement : 'before'
                setDragging(null)
                setDrop(null)
                if (!Number.isFinite(from)) return
                if (!reorderReferenceAssets(node.id, from, entry.asset_id, nextPlacement)) {
                  toast.info('这两张参考来自不同层级，不能直接换序')
                }
              }}
            >
              <img src={`/api/images/assets/${entry.asset_id}/thumb`} alt={`参考图 ${index + 1}`} />
              <small>{badges?.get(entry.asset_id) ?? `图${index + 1}`}</small>
              {entry.manual && (
                <button
                  type="button"
                  aria-label={`删除参考图 ${index + 1}`}
                  title="删除手动参考图"
                  disabled={disabled}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation()
                    removeManual(entry.asset_id)
                  }}
                >
                  <X />
                </button>
              )}
            </div>
          )
        })}
      </div>
      <button
        type="button"
        className={`scv-ref-add${picking ? ' active' : ''}`}
        aria-label="添加参考图"
        title="从资产库或本地上传添加参考图"
        disabled={disabled}
        onClick={() => setPicking(true)}
      >
        <ImagePlus />
      </button>
      {picking && (
        <AssetPicker
          onClose={() => setPicking(false)}
          onPick={(asset) => {
            const manual = node.manual_references ?? []
            if (manual.some((item) => item.asset_id === asset.id)) {
              toast.info('这张图已经在手动参考中')
              return
            }
            if (entries.length >= MAX_REFS && !entries.some((entry) => entry.asset_id === asset.id)) {
              toast.warning(`一次最多带 ${MAX_REFS} 张参考图`)
              return
            }
            snapshot()
            updateNode(node.id, {
              manual_references: [
                ...manual,
                {
                  kind: 'image',
                  asset_id: asset.id,
                  name: asset.alias ?? `图片 ${asset.id}`,
                  mime: asset.mime,
                  w: asset.width,
                  h: asset.height,
                },
              ],
            })
          }}
        />
      )}
    </>
  )
}

/** 单节点的底部输入框。
 *
 *  **导出只为渲染冒烟测试**（`canvas-composer-render.test.tsx`），页面之外没有消费方。
 *  纯函数测试全绿而浏览器整页白屏，本仓吃过一次（节点定义的 View 写成非 getter 触发
 *  TDZ）——vitest 与 vite dev 解析模块图的顺序不同，只有真渲染一遍才拦得住。 */
export function GenerateBar({
  node,
  running,
  cascading,
  onSetPlan,
}: {
  /** 打开成套弹窗。参考图由这里算好传上去——生成条本来就在算它 */
  onSetPlan: (nodeId: string, refs: number[], auto?: boolean) => void
  node: ScvNode
  running: boolean
  cascading: boolean
}) {
  const nodes = useCanvasStore((s) => s.nodes)
  const connections = useCanvasStore((s) => s.connections)
  const canvasId = useCanvasStore((s) => s.canvasId)
  const updateNode = useCanvasStore((s) => s.updateNode)
  const snapshot = useCanvasStore((s) => s.snapshot)
  const [collapsed, setCollapsed] = useState(false)
  const deployments = useQuery({
    queryKey: ['cfg-model-deployments', 'canvas-image'],
    queryFn: () => apiConfig.modelDeployments({ media_type: 'image', enabled: true }),
  })

  const referenceEntries = useMemo(
    () => referenceAssetEntries(nodes, connections, node.id),
    [nodes, connections, node.id],
  )
  const refs = useMemo(() => referenceEntries.map((entry) => entry.asset_id), [referenceEntries])
  const rs = node.run_settings ?? {}
  const deploymentId = rs.deployment_id ?? null
  const selectedDeployment = (deployments.data ?? []).find((item) => item.id === deploymentId)
  const deploymentMissing =
    deploymentId !== null && !(deployments.data ?? []).some((item) => item.id === deploymentId)
  const hasItems = (node.items ?? []).length > 0
  const draft = node.prompt_draft ?? ''
  const busy = running || cascading
  const mode = genModeOf(rs, N_MAX)
  const route = genRoute(mode)

  const setRun = (patch: Record<string, unknown>) =>
    updateNode(node.id, { run_settings: { ...rs, ...patch } })

  /* 这个节点最近的出图任务。**一次查询喂两件事**：估时用成功那几次的实测秒数，
     单张重试用最近一批里失败的那几个。`origin_node_id` 同时匹配 node_id 与
     source_node_id，分支出去的那些也认得回来。 */
  const recentTasks = useQuery({
    queryKey: ['canvas-node-image-tasks', canvasId, node.id],
    queryFn: () => apiStudio.tasks({ canvas_id: canvasId as number, origin_node_id: node.id, limit: 16 }),
    enabled: canvasId !== null,
    refetchInterval: busy ? 2500 : false,
    refetchIntervalInBackground: true,
  })
  /* 挂在 `data` 上而不是 `data?.items ?? []`：后者每次渲染都是新数组，
     两个 memo 会跟着每帧重算（虽然便宜，但依赖写成这样迟早骗人） */
  const taskItems = recentTasks.data?.items
  const samples = useMemo(() => taskDurations(taskItems ?? []), [taskItems])
  const failures = useMemo(() => lastBatchFailures(taskItems ?? []), [taskItems])
  const planLine = genPlanLine({ mode, hasItems, refs: refs.length, samples })

  /** 出图时真正会发出去的那段词（上游提示词节点 + 图N 映射表 + 草稿）。
   *  输入框里只看得见草稿那一截，上游连了提示词节点时两者能差出一整段。 */
  const finalPrompt = useMemo(
    () => composePrompt(nodes, connections, node.id),
    [nodes, connections, node.id],
  )
  const [showPrompt, setShowPrompt] = useState(false)

  const attachments = node.attachments ?? []
  const [attaching, setAttaching] = useState(false)
  /* 挂附件：先入库再挂 id，画布文档里不进字节。
     超过上限就截断并说清楚，而不是静默丢掉后面几个 */
  const attach = async (files: File[]): Promise<void> => {
    setAttaching(true)
    const room = MAX_ATTACHMENTS - attachments.length
    if (files.length > room) toast.warning(`最多带 ${MAX_ATTACHMENTS} 个，只收了前 ${room} 个`)
    const added = await uploadAttachments(files.slice(0, Math.max(0, room)))
    setAttaching(false)
    if (added.length === 0) return
    snapshot()
    updateNode(node.id, { attachments: [...attachments, ...added] })
  }

  /* 钉在画布底部正中，不跟随选中节点。
     跟随做过一版，实测更差：条会随着选节点在屏幕上乱跳，眼睛得重新找它在哪；
     节点靠边时还要退回底部，于是同一个控件有两种位置，肌肉记忆无从建立。
     固定位置的代价只是「不知道在编哪个节点」，而那个由节点自己的选中态说明。 */
  /** 提交出图。⌘Enter 与两个按钮共用这一条，顺手把这句词记进「最近用过」——
   *  记在提交那一刻而不是每次敲键，否则半句废话也会挤进列表。
   *
   *  三条分支都是**既有链路**，这里只按「出几张 × 怎么跑」分派：
   *  - `plan`：自动张数 → 成套弹窗，AI 问清需求后决定几张、每张写什么词；
   *  - `serial-set`：串行多图 → `runSetPlan` 的 consistent 语义，上一张的产物
   *    排进下一张的参考里。用户不必为了「出一套」先在画布上建循环节点再连线；
   *  - `single`：一张或并发多张 → `generateFrom`，N 个各自成败的单张任务。 */
  const submit = (target: 'auto' | 'inplace'): void => {
    if (busy) return
    if (route === 'plan') {
      // 成套自己会问需求，**不要求先写提示词**，所以这条在空草稿时也放行
      // 输入框里已经写了需求就直接开跑规划，不再要求在弹窗里点一次「开始」
      onSetPlan(node.id, refs, draft.trim() !== '')
      return
    }
    if (draft.trim() === '') return
    recentPush(draft)
    if (route === 'serial-set' && target === 'auto') {
      const state = useCanvasStore.getState()
      /* 用 `composePrompt` 而不是输入框里的草稿：上游提示词节点与 @ 引用的
         图N 映射表都在它里面，少了就和单张出图发的不是同一句词。 */
      const prompt = composePrompt(state.nodes, state.connections, node.id)
      if (prompt === '') {
        toast.error('先写提示词再出图（也可以连一个提示词节点上来）')
        return
      }
      void runSetPlan(node.id, serialSetPlan(prompt, mode.n ?? 2, N_MAX))
      return
    }
    void generateFrom(node.id, target).finally(() => void recentTasks.refetch())
  }

  /* 出图中排下一条：输入框本来就保持可编辑，可改完的词此前无处可去——
     用户只能盯着进度条等它跑完再点一次。排队只留一格，不做队列：
     真要连发十条的人该选「多张」，而不是点十次。 */
  const [queued, setQueued] = useState<'auto' | 'inplace' | null>(null)
  const submitRef = useRef(submit)
  submitRef.current = submit
  useEffect(() => {
    if (queued === null || busy) return
    setQueued(null)
    submitRef.current(queued)
  }, [queued, busy])
  // 换了节点就把排队作废：排的是「那个节点的下一条」，跟着选中态漂移会出错图
  useEffect(() => setQueued(null), [node.id])

  /** 主按钮与 ⌘Enter 共用。**必须是同一条**：只给按钮排队的话，
   *  跑图期间按 ⌘Enter 什么都不发生，而按钮就在旁边写着「排下一条」。 */
  const primaryAction = (): void => {
    if (queued !== null) {
      setQueued(null)
      return
    }
    if (busy) {
      if (route !== 'plan' && draft.trim() === '') return
      setQueued('auto')
      return
    }
    submit('auto')
  }

  return (
    <div
      className="scv-genbar"
      onKeyDown={(e) => {
        /* Esc 收起。正文里的第一下由 MentionInput 吃掉（失焦，STD-UI-002b），
           焦点不在正文里时才轮到这里；已经收起了就放行给画布的「取消选择」。 */
        if (e.key !== 'Escape' || e.defaultPrevented || collapsed) return
        e.preventDefault()
        e.stopPropagation()
        setCollapsed(true)
      }}
    >
      {!collapsed && (
      <>
      <div className="scv-refs">
        <ReferenceInputStrip
          node={node}
          entries={referenceEntries}
          /* 顺序影响出图（正文里的「图1」按这个顺序对号），所以标签上要写明
             这一排就是上送顺序，而不是只报一个数 */
          label={
            refs.length > 1
              ? `参考 ${refs.length} 张 · 从左到右即图1…图${refs.length}`
              : refs.length === 1
                ? '参考 1 张 · 即图1'
                : '无参考 · 文生图'
          }
          disabled={busy}
        />
        <AttachButton
          busy={attaching}
          disabled={busy}
          onPick={(files) => void attach(files)}
        />
      </div>
      {/* 附件条。图片附件同时也进上面那行的参考数，两处说的是同一批东西 */}
      <AttachStrip
        items={attachments}
        onChange={(next) => {
          snapshot()
          updateNode(node.id, { attachments: next })
        }}
      />
      <div className="scv-genbar-input">
        {/* @ 提及（FR-465）：输入 @ 从上游链路或素材库引用一张图，正文里写成「图N」，
            出图时既进映射表也真作为参考图上送。三样都要存——只存正文的话
            token 还原不回来，只存 html 的话拼提示词还得再解析一遍 */}
        <MentionInput
          value={draftValue(node)}
          upstream={refs.map((id) => ({
            asset_id: id,
            label: `上游图 ${id}`,
            thumb_url: `/api/images/assets/${id}/thumb`,
          }))}
          placeholder="想画什么、想在参考基础上改什么…（输入 @ 引用一张图，可直接粘贴或拖入文件）"
          onFiles={(files) => void attach(files)}
          /* 出图中输入框保持可编辑（实测过旧行为：`disabled` 没传，本来就能接着写）。
             这条不改是有理由的——正在跑的那一次已经把词发出去了，此刻改草稿
             只影响下一次；反过来锁住输入框会让「等图的这三十秒」白白浪费。 */
          onChange={(next) => {
            snapshot()
            updateNode(node.id, draftPatch(next))
          }}
          onSubmit={primaryAction}
        />
      </div>
      {/* 词库 / 让 AI 写 / 最近用过。与批量输入框共用同一份 */}
      <ComposerAssist
        value={draftValue(node)}
        disabled={cascading}
        onChange={(next) => {
          snapshot()
          updateNode(node.id, draftPatch(next))
        }}
      />
      <div className="scv-params">
        <GeneratorEnginePicker node={node} disabled={busy} />
        <PillPicker
          label="模型"
          value={deploymentId === null ? 'global' : String(deploymentId)}
          disabled={deployments.isPending || deployments.isError}
          onChange={(v) => setRun({ deployment_id: v === 'global' ? null : Number(v) })}
          title={
            deployments.isError
              ? `模型目录读取失败：${deployments.error.message}`
              : '这条节点固定使用哪个真实模型；跟随全局时使用设置里的 image-free 绑定'
          }
          options={[
            /* 空串不能当 Radix Select 的 item value（它用空串表示清空），
               所以「跟随全局」用一个具名值，在 onChange 里翻译回 null */
            { value: 'global', label: '跟随全局' },
            ...(deploymentMissing
              ? [{ value: String(deploymentId), label: '当前模型已停用或删除' }]
              : []),
            ...(deployments.data ?? []).map((d) => ({
              value: String(d.id),
              label: d.display_name || d.upstream_model_id,
              hint: d.credential_name || undefined,
            })),
          ]}
        />
        {selectedDeployment?.adapter_type === 'jimeng' && (
          <PillPicker
            label="高清放大"
            value={rs.upscale_resolution ?? '2k'}
            onChange={(value) => setRun({ upscale_resolution: value })}
            title="节点工具条的「高清放大」会使用这个目标分辨率"
            options={[
              { value: '2k', label: '2K' },
              { value: '4k', label: '4K' },
              { value: '8k', label: '8K' },
            ]}
          />
        )}
        <PillPicker
          label="质量"
          value={normalizeQuality(rs.quality)}
          onChange={(v) => setRun({ quality: v })}
          title="质量"
          options={[
            { value: 'low', label: 'low', hint: '草稿' },
            { value: 'medium', label: 'medium' },
            { value: 'high', label: 'high', hint: '默认' },
          ]}
        />
        {refs.length > 0 ? (
          /* 有参考图时尺寸由参考决定，选择器给不了任何有效选择——
             与其摆一个禁用的控件，不如直接说清楚为什么没得选 */
          <span className="scv-param-note" title="有参考时尺寸跟随参考">
            尺寸 · 跟随参考
          </span>
        ) : (
          <SizePicker
            value={rs.size ?? AUTO_SIZE}
            onChange={(v) => setRun({ size: v })}
          />
        )}
        {/* 出几张。三档收口了原来分散在三处的入口（张数框 / 画布上的循环节点 /
            动作行上的成套按钮），用户不必先猜自己该点哪一个 */}
        <PillPicker
          label="出几张"
          value={mode.count}
          disabled={busy}
          title="只要一张就选「1 张」；要一套就选「自动」，让 AI 从提示词里判断该出几张"
          onChange={(v) =>
            setRun(countModePatch(v as typeof mode.count, mode, N_MAX))
          }
          options={[
            { value: 'one', label: '1 张' },
            { value: 'fixed', label: '多张', hint: '自己填数字' },
            { value: 'auto', label: '自动', hint: 'AI 从提示词判断' },
          ]}
        />
        {/* 张数用 input+datalist 而不是 select：常用档点一下就好，
            要 12 张也能直接敲进去——select 给不了「不限制」这件事 */}
        {mode.count === 'fixed' && (
          <>
            <label className="scv-param-n" title={`张数上限 ${N_MAX}`}>
              <input
                type="number"
                min={1}
                max={N_MAX}
                list="scv-n-presets"
                aria-label="张数"
                value={String(mode.n ?? 1)}
                onChange={(e) => setRun(countPatch(e.target.value, N_MAX))}
              />
              张
            </label>
            <datalist id="scv-n-presets">
              {N_PRESETS.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </>
        )}
        {/* 怎么跑。只出一张时两种跑法结果一样，整个控件**隐藏而不是禁用** */}
        {showRunPicker(mode) && (
          <PillPicker
            label="怎么跑"
            value={mode.run}
            disabled={busy}
            title="都是同一句词跑 N 遍：并发各出各的，串行让后一张看见前一张（同一画面的迭代）。要「每张不同的一套」请选「自动」，那条会让 AI 先给每张写各自的词"
            onChange={(v) => setRun({ run_mode: v as typeof mode.run })}
            options={[
              { value: 'parallel', label: '并发', hint: '同时发，快' },
              { value: 'serial', label: '串行', hint: '同一句词，后一张接着前一张改' },
            ]}
          />
        )}
      </div>

      {/* 点下去之前先说清将要发生什么：几张、并发还是串行、落在哪、带几张参考、
          按最近几次估大概多久。此前点完只有一片进度条 */}
      <div className="scv-genplan">
        <span className="scv-genplan-line">
          {planLine.map((part, index) => (
            <Fragment key={`${index}-${part}`}>
              {index > 0 && <i className="scv-genplan-sep" aria-hidden />}
              {part}
            </Fragment>
          ))}
        </span>
        {/* 输入框里只看得见草稿那一截。上游连了提示词节点、或正文里有 @ 引用时，
            真正发出去的词会多出一整段映射表，展开看得见 */}
        {finalPrompt !== '' && finalPrompt !== draft.trim() && (
          <button
            type="button"
            className="scv-assist-btn nodrag"
            aria-expanded={showPrompt}
            title="上游提示词节点与「图N」映射表都会拼进去，这里是真正会发出去的全文"
            onClick={() => setShowPrompt((v) => !v)}
          >
            {showPrompt ? '收起实际提示词' : `实际提示词 ${finalPrompt.length} 字`}
          </button>
        )}
      </div>
      {showPrompt && finalPrompt !== '' && (
        <pre className="scv-genplan-prompt">{finalPrompt}</pre>
      )}

      {/* 失败的单张可以单独补，不用整批重来。只列最近一批（同一个执行组），
          三天前那次失败挂在这里既想不起来也不会去点 */}
      {failures.length > 0 && !busy && (
        <div className="scv-genfail">
          <span>上一批 {failures.length} 张没出来</span>
          {/* 按钮上带原因而不是「重试第 1 张」：同一句词出的 N 张彼此没有先后，
              「第几张」是个假坐标；真正把它们区分开的是各自为什么失败 */}
          {failures.slice(0, 3).map((task) => (
            <button
              key={task.id}
              type="button"
              className="scv-assist-btn nodrag"
              title={task.error ?? '失败原因未记录'}
              onClick={() => void retryCanvasImageTask(task.id).then(() => recentTasks.refetch())}
            >
              重试 · {recentLabel(task.error ?? '原因未记录', 12)}
            </button>
          ))}
          {failures.length > 1 && (
            <button
              type="button"
              className="scv-assist-btn nodrag"
              title="只把失败的这几张重新排队，已经出来的那几张不动"
              onClick={() =>
                void Promise.all(failures.map((task) => retryCanvasImageTask(task.id))).then(() =>
                  recentTasks.refetch(),
                )
              }
            >
              补齐失败的 {failures.length} 张
            </button>
          )}
          <em className="scv-genfail-why" title={failures[0].error ?? ''}>
            {failures[0].error ?? ''}
          </em>
        </div>
      )}
      </>
      )}

      {/* 动作**独立成行**。和参数挤在一行时，中文按钮一多就把主按钮顶出右边缘
          （实测生成条宽 680、内容要 718，「出图（分支）」被切掉 39px）。 */}
      <div className="scv-genbar-acts">
        <button
          type="button"
          className="scv-assist-btn nodrag"
          aria-expanded={!collapsed}
          title={collapsed ? '展开输入框' : '收起输入框，把画布让出来（Esc 同）'}
          onClick={() => setCollapsed((v) => !v)}
        >
          {collapsed ? '展开' : '收起'}
        </button>
        <CanvasCascadeAction nodeId={node.id} disabled={busy} showPlan />
        {/* 串行走的是「本节点下方排 N 个新节点」，「落回本节点」表达不了那件事，
            所以那一档下这个按钮不出现 */}
        {hasItems && route !== 'serial-set' && (
          <button
            className="btn btn-outline btn-sm"
            disabled={busy || draft.trim() === ''}
            /* 说的名字必须和画布上真写出来的一致：历史节点的标题条现在派生成
               「<谁> 的旧图」（output-node-view.ts 的 historyTitle），
               这里再说「历史」节点，用户按完就得在画布上找一个不存在的名字 */
            title="结果落回本节点，旧图挪进下方的「…的旧图」节点，随时翻得回去"
            onClick={() => submit('inplace')}
          >
            重生成本节点
          </button>
        )}
        {/* 成套：**不需要先写提示词**。它自己会问你要什么，
            再把整批图的每一句词写好。有参考图就带着参考图规划。
            选了「自动」时它就是主按钮本身，这里不再重复摆一个。 */}
        {route !== 'plan' && (
          <button
            className="btn btn-outline btn-sm"
            disabled={busy}
            title={
              refs.length > 0
                ? `让 AI 拿着这 ${refs.length} 张参考图跟你讨论，规划出一整套图`
                : '让 AI 问清楚需求，规划出一整套风格统一的图（或几个不同方向的方案）'
            }
            onClick={() => onSetPlan(node.id, refs)}
          >
            <IconSparkle /> 成套
          </button>
        )}
        {/* 主按钮。跑着的时候它变成「排下一条」——输入框此刻本来就能改词，
            改完却无处可去是旧行为里最钝的一处 */}
        <button
          className="btn btn-primary btn-sm"
          /* 已排队时永远点得动：排完再把草稿清空的话，禁用会让人取消不掉，
             只能眼看着队列自己作废 */
          disabled={queued === null && route !== 'plan' && draft.trim() === ''}
          title={
            queued !== null
              ? '已排队，点一下取消'
              : busy
                ? '这一批跑完之后接着出下一条，输入框里现在的词为准'
                : route === 'plan'
                  ? '让 AI 问清需求、决定出几张，再一次跑完'
                  : route === 'serial-set'
                    ? `一张接一张跑 ${mode.n ?? 2} 轮，后一张带着前一张的产物做参考`
                    : `${hasItems ? '在右侧分支出新节点，原图保留' : '出图落进本节点'}（${MOD}Enter）`
          }
          onClick={primaryAction}
        >
          {queued !== null
            ? '已排队 · 点此取消'
            : busy
              ? '排下一条'
              : route === 'plan'
                ? '规划并出图'
                : route === 'serial-set'
                  ? `串行出 ${mode.n ?? 2} 张`
                  : hasItems
                    ? '出图（分支）'
                    : '出图'}
        </button>
      </div>
    </div>
  )
}

function VideoGenerateBar({
  node,
  running,
  cascading,
}: {
  node: ScvNode
  running: boolean
  cascading: boolean
}) {
  const canvasId = useCanvasStore((s) => s.canvasId)
  const nodes = useCanvasStore((s) => s.nodes)
  const connections = useCanvasStore((s) => s.connections)
  const updateNode = useCanvasStore((s) => s.updateNode)
  const snapshot = useCanvasStore((s) => s.snapshot)
  const deployments = useQuery({
    queryKey: ['cfg-model-deployments', 'canvas-video'],
    queryFn: () => apiConfig.modelDeployments({ media_type: 'video', enabled: true }),
  })
  const videoDeployments = (deployments.data ?? []).filter(
    (item) => item.enabled && ['openai', 'volcengine', 'jimeng'].includes(item.adapter_type),
  )
  const settings = node.video_settings ?? {}
  const modelHint = (settings.model_hint ?? '').trim().toLowerCase()
  const selected =
    videoDeployments.find((item) => item.id === settings.deployment_id) ??
    videoDeployments.find(
      (item) => modelHint !== '' && item.upstream_model_id.trim().toLowerCase() === modelHint,
    ) ??
    videoDeployments[0]
  const selectedId = selected?.id ?? null
  const adapter = selected?.adapter_type === 'volcengine'
    ? 'volcengine'
    : selected?.adapter_type === 'jimeng'
      ? 'jimeng'
      : 'openai'
  const durations = adapter === 'openai'
    ? [4, 8, 12]
    : adapter === 'jimeng' && selected?.upstream_model_id === 'seedance1.0fast'
      ? [5, 8, 10]
      : adapter === 'jimeng' && selected?.upstream_model_id === 'seedance1.5pro'
        ? [5, 8, 10, 12]
        : [4, 5, 8, 10, 12, 15]
  const duration = durations.includes(settings.duration ?? 4) ? settings.duration ?? 4 : durations[0]
  const resolutionOptions = adapter === 'openai'
    ? [{ value: '720p', label: '720p' }, { value: '1080p', label: '1080p' }]
    : adapter === 'jimeng'
      ? [
          { value: '720p', label: '720p' },
          ...(settings.reference_mode === 'multi_frame'
            ? [{ value: '1080p', label: '1080p' }]
            : selected?.upstream_model_id === 'seedance2.0_vip'
            ? [{ value: '1080p', label: '1080p' }, { value: '4k', label: '4K' }]
            : []),
        ]
      : [
          { value: '', label: '自动' },
          { value: '480p', label: '480p' },
          { value: '720p', label: '720p' },
          { value: '1080p', label: '1080p' },
        ]
  const safeResolution = resolutionOptions.some((item) => item.value === settings.resolution)
    ? settings.resolution ?? '720p'
    : '720p'
  const referenceEntries = useMemo(
    () => referenceAssetEntries(nodes, connections, node.id),
    [nodes, connections, node.id],
  )
  const refs = useMemo(() => referenceEntries.map((entry) => entry.asset_id), [referenceEntries])
  const usedMediaReferences = useMemo(
    () => videoMediaReferenceInputs(refMediaItems(nodes, connections, node.id), adapter),
    [adapter, connections, node.id, nodes],
  )
  const usedReferences = useMemo(
    () => videoReferenceInputs(refs, settings, adapter).slice(
      0,
      adapter === 'jimeng' && usedMediaReferences.length > 0
        ? VIDEO_MULTIMODAL_MAX_REFS
        : VIDEO_MULTIFRAME_MAX_REFS,
    ),
    [adapter, refs, settings, usedMediaReferences.length],
  )
  const taskHistory = useQuery({
    queryKey: ['canvas-video-history', canvasId, node.id],
    queryFn: () =>
      apiStudio.tasks({
        canvas_id: canvasId as number,
        origin_node_id: node.id,
        limit: 8,
      }),
    enabled: canvasId !== null,
    refetchInterval: running || cascading ? 1500 : false,
  })
  const videoHistory = (taskHistory.data?.items ?? []).filter(
    (task) => task.task_type === 'video.generate',
  )
  const referenceBadges = useMemo(
    () => new Map(usedReferences.map((reference) => [
      reference.asset_id,
      reference.role === 'first_frame' ? '首' : reference.role === 'last_frame' ? '尾' : '参',
    ])),
    [usedReferences],
  )
  const draft = node.prompt_draft ?? ''
  const hasOutput = (node.items ?? []).some((item) => item.kind === 'video')
  const busy = running || cascading

  const setVideo = (patch: Partial<CanvasVideoRunSettings>) =>
    updateNode(node.id, { video_settings: { ...settings, ...patch } })

  return (
    <div className="scv-genbar scv-video-genbar">
      <div className="scv-refs">
        <ReferenceInputStrip
          node={node}
          entries={referenceEntries}
          label={
            usedReferences.length === 0 && usedMediaReferences.length === 0
              ? '无参考 · 文生视频'
              : adapter === 'openai'
                ? '参考图 · OpenAI 使用第 1 张'
                : usedMediaReferences.length > 0
                  ? `${adapter === 'jimeng' ? '全能参考' : '多模态参考'} · ${usedReferences.length} 图 / ${usedMediaReferences.filter((item) => item.kind === 'video').length} 视频 / ${usedMediaReferences.filter((item) => item.kind === 'audio').length} 音频`
                  : settings.reference_mode === 'multimodal'
                    ? `多参考 · ${usedReferences.length}/${Math.min(refs.length, VIDEO_MULTIMODAL_MAX_REFS)} 张`
                  : settings.reference_mode === 'multi_frame'
                    ? `多帧转场 · ${usedReferences.length}/${Math.min(refs.length, VIDEO_MULTIFRAME_MAX_REFS)} 张`
                  : settings.reference_mode === 'first_last'
                    ? usedReferences.length > 1 ? '首帧 + 尾帧' : '首帧（还缺尾帧）'
                    : '首帧参考 · 使用第 1 张'
          }
          badges={referenceBadges}
          disabled={running}
        />
      </div>
      {videoHistory.length > 0 && (
        <details className="scv-workflow-history scv-video-history">
          <summary>视频记录（{videoHistory.length}）</summary>
          <div>
            {videoHistory.map((task) => (
              <article key={task.id} title={task.id}>
                <b data-status={task.status}>{task.status}</b>
                <span>{task.task_type}</span>
                <small>{task.error ?? task.stage ?? `${Math.round(task.progress)}%`}</small>
                {task.retryable && ['failed', 'partial', 'cancelled'].includes(task.status) && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void retryCanvasVideoTask(task.id).then(() => taskHistory.refetch())}
                  >重试</button>
                )}
              </article>
            ))}
          </div>
        </details>
      )}
      <div className="scv-genbar-input">
        <MentionInput
          value={{
            /* 没存 html 时必须**升格**而不是把纯文本当 html 交出去：
               MentionInput 会 `el.innerHTML = value.html`，裸文本里的 `a < b`
               进框就变形，词库条目里的 `<img onerror>` 直接执行。
               mentionFromText 走 escapeHtml，是这条路唯一正当的入口。 */
            html: node.prompt_draft_html ?? mentionFromText(draft).html,
            text: draft,
            refs: (node.prompt_draft_refs ?? []).map((ref) => ({
              asset_id: ref.asset_id,
              label: ref.label,
              thumb_url: `/api/images/assets/${ref.asset_id}/thumb`,
            })),
          }}
          upstream={refs.map((id) => ({
            asset_id: id,
            label: `上游图 ${id}`,
            thumb_url: `/api/images/assets/${id}/thumb`,
          }))}
          placeholder="描述镜头、主体动作、运镜和光线…（输入 @ 指定首帧参考）"
          onChange={(next) => {
            snapshot()
            updateNode(node.id, {
              prompt_draft: next.text,
              prompt_draft_html: next.html,
              prompt_draft_refs: next.refs.map((ref) => ({
                asset_id: ref.asset_id,
                label: ref.label,
              })),
            })
          }}
        />
      </div>
      <div className="scv-params">
        <GeneratorEnginePicker node={node} disabled={busy} />
        <PillPicker
          label="模型"
          value={selectedId === null ? '' : String(selectedId)}
          placeholder="没有可用视频模型"
          disabled={deployments.isPending || deployments.isError || videoDeployments.length === 0}
          onChange={(v) => setVideo({ deployment_id: Number(v) })}
          title={deployments.isError ? deployments.error.message : '节点级真实视频模型'}
          options={videoDeployments.map((d) => ({
            value: String(d.id),
            label: d.display_name || d.upstream_model_id,
            hint: d.credential_name || undefined,
          }))}
        />
        <PillPicker
          label="时长"
          value={String(duration)}
          onChange={(v) => setVideo({ duration: Number(v) })}
          title="视频时长"
          options={durations.map((v) => ({ value: String(v), label: `${v} 秒` }))}
        />
        <PillPicker
          label="画幅"
          value={settings.aspect_ratio ?? '16:9'}
          onChange={(v) => setVideo({ aspect_ratio: v })}
          title="画幅"
          options={[
            { value: '16:9', label: '16:9', hint: '横屏' },
            { value: '9:16', label: '9:16', hint: '竖屏' },
            ...(adapter === 'volcengine'
              ? [
                  { value: '1:1', label: '1:1', hint: '方形' },
                  { value: '4:3', label: '4:3' },
                  { value: '3:4', label: '3:4' },
                  { value: '21:9', label: '21:9' },
                  { value: '9:21', label: '9:21' },
                  { value: 'adaptive', label: '自适应' },
                ]
              : adapter === 'jimeng'
                ? [
                    { value: '1:1', label: '1:1', hint: '方形' },
                    { value: '4:3', label: '4:3' },
                    { value: '3:4', label: '3:4' },
                    { value: '21:9', label: '21:9' },
                  ]
              : []),
          ]}
        />
        <PillPicker
          label="清晰度"
          value={safeResolution}
          onChange={(v) => setVideo({ resolution: v })}
          title="清晰度"
          options={resolutionOptions}
        />
        {adapter !== 'openai' && (refs.length > 0 || usedMediaReferences.length > 0) && (
          <PillPicker
            label="参考"
            value={settings.reference_mode ?? 'first_frame'}
            onChange={(value) => setVideo({
              reference_mode: value as NonNullable<CanvasVideoRunSettings['reference_mode']>,
            })}
            title={adapter === 'jimeng' ? '首帧、首尾帧、多帧转场或即梦图/视频/音频全能参考' : '首帧、首尾帧或 Seedance 图/视频/音频多模态参考'}
            options={[
              { value: 'first_frame', label: '首帧' },
              { value: 'first_last', label: '首尾帧' },
              ...(adapter === 'jimeng'
                ? [{ value: 'multi_frame', label: '多帧转场', hint: `最多 ${VIDEO_MULTIFRAME_MAX_REFS} 张` }]
                : []),
              { value: 'multimodal', label: adapter === 'jimeng' ? '全能参考' : '多模态', hint: `最多 ${VIDEO_MULTIMODAL_MAX_REFS} 张图` },
            ]}
          />
        )}
        {adapter === 'volcengine' && (
          <>
            <label className="scv-video-seed">
              <span>Seed</span>
              <input
                type="number"
                min={-1}
                max={2 ** 32 - 1}
                value={settings.seed ?? ''}
                placeholder="随机"
                onChange={(event) => setVideo({
                  seed: event.target.value === '' ? undefined : Number(event.target.value),
                })}
              />
            </label>
            <label className="scv-video-check">
              <input
                type="checkbox"
                checked={settings.generate_audio ?? false}
                onChange={(event) => setVideo({ generate_audio: event.target.checked })}
              />
              同步音频
            </label>
            <label className="scv-video-check">
              <input
                type="checkbox"
                checked={settings.watermark ?? false}
                onChange={(event) => setVideo({ watermark: event.target.checked })}
              />
              水印
            </label>
            <label
              className="scv-video-check"
              title={usedReferences.length > 0 ? '火山方舟的参考图场景不支持固定机位' : '固定摄像机'}
            >
              <input
                type="checkbox"
                disabled={usedReferences.length > 0}
                checked={settings.fixed_camera ?? false}
                onChange={(event) => setVideo({ fixed_camera: event.target.checked })}
              />
              固定机位
            </label>
          </>
        )}
        {(settings.enhance_prompt === true || settings.enable_upsample === true) && (
          <span className="scv-video-legacy-note" title="参数不会丢失，但当前 OpenAI/火山直连协议没有对应字段">
            已保留导入的{settings.enhance_prompt ? '提示词增强' : ''}
            {settings.enhance_prompt && settings.enable_upsample ? '、' : ''}
            {settings.enable_upsample ? '超分' : ''}配置
          </span>
        )}
        <span className="scv-flex" />
        <CanvasCascadeAction nodeId={node.id} disabled={busy} showPlan />
        <button
          className="btn btn-primary btn-sm"
          disabled={busy || selectedId === null || draft.trim() === ''}
          title={hasOutput ? '原视频保留，在右侧生成新分支' : '任务进入后台，关闭画布也会继续'}
          onClick={() => void generateVideoFrom(node.id, selectedId, adapter, selected?.upstream_model_id)}
        >
          {running ? '视频生成中…' : hasOutput ? '生成视频分支' : '生成视频'}
        </button>
      </div>
    </div>
  )
}


/* ==================== 输入框助手：词库 / 让 AI 写 / 最近用过 ==================== */

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 一个节点的草稿三件套读成 MentionValue。
 *
 *  `prompt_draft_html` 缺失时必须**升格**而不是把纯文本当 html 用：
 *  MentionInput 会 `el.innerHTML = value.html`，裸文本里的 `a < b` 进框就变形。 */
function draftValue(node: ScvNode): MentionValue {
  const text = node.prompt_draft ?? ''
  return {
    html: node.prompt_draft_html ?? mentionFromText(text).html,
    text,
    refs: (node.prompt_draft_refs ?? []).map((ref) => ({
      asset_id: ref.asset_id,
      label: ref.label,
      thumb_url: `/api/images/assets/${ref.asset_id}/thumb`,
    })),
  }
}

/** 写回节点的草稿三件套。**三个字段必须一起写**：只写 prompt_draft 的话
 *  输入框一个字都不会变——它读的是 html，`useLayoutEffect` 判定「外部没换内容」
 *  直接跳过，表现是「点了没反应」。 */
function draftPatch(value: MentionValue): Partial<ScvNode> {
  return {
    prompt_draft: value.text,
    prompt_draft_html: value.html,
    prompt_draft_refs: value.refs.map((ref) => ({ asset_id: ref.asset_id, label: ref.label })),
  }
}

/** AI 写完之后记住的两份词。用户随时能在两份之间切、能一键退回原文——
 *  看不到自己原来写了什么、退不回去的话，没人敢按第二次。 */
interface ComposeTrace {
  before: MentionValue
  after: MentionValue
  /** 写这段词的**真实上游模型名**（核心原则 6：模型位不许出现能力 slug） */
  model: string
}

/** 输入框旁边的三个入口：套词库、让 AI 写、最近用过。
 *
 *  单选与批量共用同一份。两边各写一套的话，「AI 写完能不能退回原文」
 *  这种行为会在两个地方长得不一样，而用户以为它们是同一个输入框。 */
export function ComposerAssist({
  value,
  onChange,
  disabled,
}: {
  value: MentionValue
  /** 调用方负责进撤销栈：单节点要 snapshot，批量草稿是本地态不用 */
  onChange: (next: MentionValue) => void
  disabled: boolean
}): JSX.Element {
  const [lib, setLib] = useState(false)
  const [recentOpen, setRecentOpen] = useState(false)
  const [recent, setRecent] = useState<string[]>([])
  const [composing, setComposing] = useState(false)
  const [language, setLanguage] = useState<'en' | 'zh'>('en')
  const [trace, setTrace] = useState<ComposeTrace | null>(null)

  /* click-outside 必须监听 mousedown 而不是 click：打开下拉的那一次 click
     还在冒泡，刚注册的 window listener 会立刻收到它并把面板关掉，
     表现就是「点了没反应」（CLAUDE.md 已记档的坑）。 */
  useEffect(() => {
    if (!recentOpen) return
    const onDown = (e: MouseEvent) => {
      const el = e.target instanceof Element ? e.target : null
      if (el !== null && el.closest('.scv-recent-wrap') !== null) return
      setRecentOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [recentOpen])

  /* 用户在 AI 写完之后又自己改了字，两份记录就都对不上了——这时直接收起对比条，
     而不是留一个会把他的修改盖掉的「切回扩写后」按钮。判据由当前正文导出（见
     `composeShown`），不另存一个 shown 状态。 */
  const shown = composeShown(
    value.text,
    trace === null ? null : { before: trace.before.text, after: trace.after.text },
  )

  const compose = async (): Promise<void> => {
    const draft = value.text.trim()
    if (draft === '') {
      toast.info('先写一句想要什么，AI 才有得扩写')
      return
    }
    setComposing(true)
    try {
      /* 服务端已有这条链路（提示词库的「AI 写一条」与这里是同一个端点），
         前端**一个字的提示词工程都不做**：两边各拼一套的话，
         同一个平台会写出两种风格的词，而用户以为它们出自同一处。
         `expand` 的语义是「保留原稿已经写死的一切，只补缺的维度」，
         正是输入框旁这个按钮该干的事。 */
      const out = await aiComposePrompt({
        draft,
        mode: 'expand',
        language,
        with_negative: false,
        with_variables: false,
      })
      const body = out.body.trim()
      if (body === '') {
        toast.error('模型没给出正文，换个说法再试一次')
        return
      }
      const after = mentionFromText(body)
      setTrace({ before: value, after, model: out.model })
      onChange(after)
    } catch (e) {
      toast.error(`AI 写词失败：${errText(e)}`)
    } finally {
      setComposing(false)
    }
  }

  const peek = shown === 'after' ? trace?.before.text : trace?.after.text
  const peekLabel = shown === 'after' ? '原文' : '扩写后'

  return (
    <>
      {trace !== null && shown !== null && (
        <div className="scv-ai-strip">
          <span className="scv-ai-tag">AI 扩写</span>
          {/* 「模型」位显示上游真名，不显能力 slug（核心原则 6） */}
          <span className="scv-ai-model" title="写这段词的真实模型">
            {trace.model}
          </span>
          <span className="scv-ai-seg" role="group" aria-label="切换原文与扩写后">
            <button
              type="button"
              className={shown === 'before' ? 'is-on' : ''}
              disabled={disabled}
              onClick={() => onChange(trace.before)}
            >
              原文
            </button>
            <button
              type="button"
              className={shown === 'after' ? 'is-on' : ''}
              disabled={disabled}
              onClick={() => onChange(trace.after)}
            >
              扩写后
            </button>
          </span>
          <span className="scv-ai-peek" title={peek}>
            {peekLabel}：{recentLabel(peek ?? '', 46)}
          </span>
          <button
            type="button"
            className="btn btn-ghost-sm"
            disabled={disabled}
            title="退回你自己写的那一版，并收起这条对比"
            onClick={() => {
              onChange(trace.before)
              setTrace(null)
            }}
          >
            还原
          </button>
        </div>
      )}

      <div className="scv-assist">
        <button
          type="button"
          className="scv-assist-btn nodrag"
          disabled={disabled}
          title="从提示词库套一条：可搜索、按分类找，带 {{变量}} 的会先让你填空"
          onClick={() => setLib(true)}
        >
          词库
        </button>
        <button
          type="button"
          className="scv-assist-btn nodrag"
          disabled={disabled || composing}
          title="把你写的大白话交给模型扩写成完整提示词。写完填回输入框供你再改，不会直接拿去出图"
          onClick={() => void compose()}
        >
          <IconSparkle /> {composing ? '写词中…' : 'AI 写词'}
        </button>
        <PillPicker
          label="出词"
          value={language}
          disabled={disabled || composing}
          title="AI 扩写用什么语言写正文。生图模型对英文提示词普遍更准，但中文模型吃中文更稳"
          onChange={(v) => setLanguage(v === 'zh' ? 'zh' : 'en')}
          options={[
            { value: 'en', label: '英文' },
            { value: 'zh', label: '中文' },
          ]}
        />
        <span className="scv-recent-wrap">
          <button
            type="button"
            className="scv-assist-btn nodrag"
            aria-expanded={recentOpen}
            disabled={disabled}
            title="最近提交过的提示词（只存在这台机器上，不入库）"
            onClick={() => {
              const next = !recentOpen
              if (next) setRecent(recentLoad())
              setRecentOpen(next)
            }}
          >
            最近
          </button>
          {recentOpen && (
            <div className="scv-recent" role="listbox" aria-label="最近用过的提示词">
              {recent.length === 0 ? (
                <p className="scv-recent-empty">还没有记录。提交过一次出图之后，这句词就会出现在这里。</p>
              ) : (
                recent.map((item) => (
                  <button
                    type="button"
                    key={item}
                    role="option"
                    aria-selected={false}
                    className="scv-recent-item"
                    title={item}
                    onClick={() => {
                      onChange(mentionFromText(item))
                      setRecentOpen(false)
                    }}
                  >
                    {recentLabel(item, 60)}
                  </button>
                ))
              )}
              {recent.length > 0 && (
                <button
                  type="button"
                  className="scv-recent-clear"
                  onClick={() => {
                    recentClear()
                    setRecent([])
                  }}
                >
                  清空记录
                </button>
              )}
            </div>
          )}
        </span>
      </div>

      {lib && (
        <PromptPicker
          onClose={() => setLib(false)}
          onPick={(item) => {
            /* 追加而不是覆盖：用户多半是想在已经写了的内容上叠一段。
               走 `mentionAppendText` 而不是 `mentionFromText(旧正文 + 条目)`——
               后者会把正文里的 @ 芯片一起碾平，正文上还写着「图1」而映射表已经空了。 */
            onChange(mentionAppendText(value, item.body))
            setLib(false)
          }}
        />
      )}
    </>
  )
}

/* ==================== 批量操作条（AC-155） ==================== */

const ALIGN_BTNS: { mode: AlignMode; label: string; title: string }[] = [
  { mode: 'left', label: '左', title: '左边缘对齐' },
  { mode: 'center-x', label: '横中', title: '横向居中：所有节点共用一条竖直中线' },
  { mode: 'right', label: '右', title: '右边缘对齐' },
  { mode: 'top', label: '上', title: '上边缘对齐' },
  { mode: 'center-y', label: '纵中', title: '纵向居中：所有节点共用一条水平中线' },
  { mode: 'bottom', label: '下', title: '下边缘对齐' },
]

/** 张数的批量档。`keep` = 各自不动，是默认——批量条上的参数一律得能「不改」，
 *  否则打开它就等于把选中节点的设置全推平一遍。 */
const BULK_N_PRESETS = [1, 2, 3, 4, 6, 8]

/** 选中多个节点时的输入框（E1）。
 *
 *  旧版这里把输入框整个换成批量条，理由写的是「这时候用户要的是排版与删改，不是出图」。
 *  那条假设是错的：**选中一批图正是最想「一句话全改一遍」的时刻**——
 *  五张不同的参考图、一句「都改成水彩」，旧版得点五次节点、打五遍字。
 *  现在两者并存：上面一条精简的排版/删改条，下面是作用域为「这 N 个节点」的输入框。 */
export function BulkComposer({ ids }: { ids: string[] }): JSX.Element | null {
  const nodes = useCanvasStore((s) => s.nodes)
  const connections = useCanvasStore((s) => s.connections)
  const running = useCanvasStore((s) => s.running)
  const cascade = useCanvasStore((s) => s.cascade)

  const [draft, setDraft] = useState<MentionValue>(EMPTY_MENTION)
  const [mode, setMode] = useState<BulkDraftMode>('append')
  const [quality, setQuality] = useState<string>('keep')
  const [count, setCount] = useState<string>('keep')
  const [collapsed, setCollapsed] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)

  const picked = useMemo(() => nodes.filter((n) => ids.includes(n.id)), [nodes, ids])
  const imageCount = picked.filter((n) => n.type === 'image').length

  /* 每个节点这一次真正会用的词：上游提示词节点 + 它自己的草稿 + 批量草稿。
     判据必须与 `generateFrom` 用的同一个 `composePrompt`——各算一份的话，
     这里显示「8 个都能出」，实际发出去时有三个被服务端以「没有提示词」拒掉。 */
  const plan = useMemo(
    () =>
      bulkPlan(
        picked.map((node) => ({
          id: node.id,
          type: node.type,
          prompt: effectiveDraft(
            composePrompt(nodes, connections, node.id),
            draft.text,
            mode,
          ),
          running: node.id in running,
        })),
      ),
    [picked, nodes, connections, draft.text, mode, running],
  )

  const busy = progress !== null
  const blocked = cascade !== null
  const status = bulkStatus(plan)

  if (imageCount === 0) return null

  const submit = async (): Promise<void> => {
    if (busy || blocked) return
    if (!status.canRun) {
      // 差词与真的不能出是两件事，提示也要是两句不同的话
      toast.error(
        status.needWord > 0
          ? `${status.needWord} 个节点还没有词，在输入框里写一句就能一起出`
          : '选中的节点里没有能出图的',
      )
      return
    }
    const shared = draft.text.trim()
    const targets = plan.targets
    const store = useCanvasStore.getState()

    /* 草稿与参数**先落进节点再出图**，而不是只在这一次请求里生效：
       落进去了才能在节点上看见这次用的是什么词，重跑与⌘Z 也才有东西可依。
       整批共用一次 snapshot——一次⌘Z 就该把这次批量改动整个退回去，
       而不是让用户按八次。 */
    if (shared !== '' || quality !== 'keep' || count !== 'keep') {
      store.snapshot()
      for (const id of targets) {
        const node = store.nodes.find((candidate) => candidate.id === id)
        if (node === undefined) continue
        const patch: Partial<ScvNode> = {}
        if (shared !== '') {
          const base = draftValue(node)
          Object.assign(
            patch,
            draftPatch(
              mode === 'replace' ? mentionFromText(shared) : mentionAppendText(base, shared),
            ),
          )
        }
        if (quality !== 'keep' || count !== 'keep') {
          /* 张数**连模式一起写**：只写 n 的话，批量设成 4 之后单选这个节点，
             输入框按它旧的 count_mode 显示「1 张」，而运行时读的是 n=4——
             界面与实际张数各说各的，两边还都不报错。 */
          patch.run_settings = {
            ...(node.run_settings ?? {}),
            ...(quality === 'keep' ? {} : { quality }),
            ...(count === 'keep' ? {} : bulkCountPatch(count, N_MAX)),
          }
        }
        store.updateNode(id, patch)
      }
      if (shared !== '') recentPush(shared)
    }

    setProgress({ done: 0, total: targets.length })
    /* 并发上限走 `BULK_CONCURRENCY` 而不是 `GEN_N_MAX`：后者管的是
       「一个节点这次要几张」，两个数是相乘的关系（20 个节点各 4 张 = 80 个请求）。
       失败隔离由 `runBulk` 与 `generateFrom` 两层共同兜住：单张失败在节点内部
       各自 toast，单节点炸了也只影响它自己。 */
    const outcomes = await runBulk(targets, (id) => generateFrom(id, 'auto'), {
      limit: BULK_CONCURRENCY,
      onProgress: (done, total) => setProgress({ done, total }),
    })
    setProgress(null)
    const failed = outcomes.filter((item) => !item.ok)
    if (failed.length === 0) toast.success(`已对 ${outcomes.length} 个节点出图`)
    else {
      toast.error(
        `${outcomes.length - failed.length} 个已出图，${failed.length} 个没发出去：${failed[0]?.error ?? '未知原因'}`,
      )
    }
  }

  return (
    <div
      className="scv-genbar"
      onKeyDown={(e) => {
        /* Esc 收起。第一下由 MentionInput 吃掉（失焦，STD-UI-002b），
           焦点已经不在正文里时才轮到这里；再往上冒泡就是画布的「取消选择」。 */
        if (e.key !== 'Escape' || e.defaultPrevented || collapsed) return
        e.preventDefault()
        e.stopPropagation()
        setCollapsed(true)
      }}
    >
      <div className="scv-bulk-scope">
        {/* 状态一句话说清「现在能跑几个 / 还差什么」。
            **「差一句词」不与「类型不对」并列**——前者的修法就在下面那个输入框里，
            把它们一起叫「跳过」等于把差一步说成了失败（判据在 bulkStatus）。 */}
        <b>{status.headline}</b>
        {status.note !== '' && (
          <span className={status.canRun ? 'scv-bulk-skip' : 'scv-bulk-need'}>{status.note}</span>
        )}
        <span className="scv-flex" />
        <button
          type="button"
          className="scv-assist-btn nodrag"
          aria-expanded={!collapsed}
          title={collapsed ? '展开输入框' : '收起输入框，把画布让出来（Esc 同）'}
          onClick={() => setCollapsed((v) => !v)}
        >
          {collapsed ? '展开' : '收起'}
        </button>
      </div>

      {!collapsed && (
        <>
          <div className="scv-genbar-input">
            {/* 出图中保持可编辑：这一批的词早就写进节点、发出去了，此刻改只影响下一批。
                锁住输入框只会让等图的那几十秒白白浪费——与单节点输入框同一口径。 */}
            <MentionInput
              value={draft}
              placeholder="对这批节点统一说一句…（留空则每个节点用自己的词）"
              onChange={setDraft}
              onSubmit={() => void submit()}
            />
          </div>
          <ComposerAssist value={draft} onChange={setDraft} disabled={false} />

          <div className="scv-params">
            <PillPicker
              label="这段词"
              value={mode}
              disabled={busy || draft.text.trim() === ''}
              title={
                draft.text.trim() === ''
                  ? '输入框是空的，每个节点用自己已有的词'
                  : '这段词怎么落到每个节点上。落进去之后节点上看得见，⌘Z 可整批退回'
              }
              onChange={(v) => setMode(v === 'replace' ? 'replace' : 'append')}
              options={[
                { value: 'append', label: '追加', hint: '接在各自的词后面' },
                { value: 'replace', label: '替换', hint: '整段换掉各自的词' },
              ]}
            />
            <PillPicker
              label="质量"
              value={quality}
              disabled={busy}
              title="整批改成同一档，或保持各自现在的设置"
              onChange={setQuality}
              options={[
                { value: 'keep', label: '各自不动' },
                { value: 'low', label: 'low', hint: '草稿' },
                { value: 'medium', label: 'medium' },
                { value: 'high', label: 'high' },
              ]}
            />
            <PillPicker
              label="张数"
              value={count}
              disabled={busy}
              title="每个节点各出几张，一律并发（串行是单节点输入框上的跑法）。张数与节点数是相乘的——8 个节点各 4 张就是 32 张"
              onChange={setCount}
              options={[
                { value: 'keep', label: '各自不动' },
                ...BULK_N_PRESETS.map((n) => ({ value: String(n), label: `${n} 张` })),
              ]}
            />
          </div>
        </>
      )}

      <div className="scv-genbar-acts">
        {/* 并发上限只在**真会排队时**才说。静止状态下这句是常驻噪音，
            而它想回答的问题（「会不会一下子全发出去」）只有在量大时才有人问。 */}
        <span className="scv-assist-note">
          {busy
            ? `已提交 ${progress.done}/${progress.total} · 每个节点的进度看节点自己`
            : status.ready > BULK_CONCURRENCY
              ? `同时最多跑 ${BULK_CONCURRENCY} 个，其余排队；一个失败不影响其余`
              : ''}
        </span>
        <span className="scv-flex" />
        <button
          className="btn btn-primary btn-sm"
          disabled={busy || blocked || !status.canRun}
          title={
            blocked
              ? '有级联在跑，先停了再批量出图'
              : status.canRun
                ? `对 ${status.ready} 个节点各出一次图（${MOD}Enter）。已有图的节点在右侧分支出新节点，原图保留`
                : status.needWord > 0
                  ? '在上面的输入框里写一句，这些节点就能一起出'
                  : '选中的节点里没有能出图的'
          }
          onClick={() => void submit()}
        >
          {busy ? `出图中 ${progress.done}/${progress.total}` : status.action}
        </button>
      </div>
    </div>
  )
}

function BulkBar({ ids }: { ids: string[] }) {
  const nodes = useCanvasStore((s) => s.nodes)
  const connections = useCanvasStore((s) => s.connections)
  const cascade = useCanvasStore((s) => s.cascade)
  /* 排版那三组默认收起：批量条现在和输入框叠在一起，全摊开会把画布底部
     切掉一大截。收在一个有名字的按钮后面而不是藏起来——藏起来等于没有。 */
  const [tools, setTools] = useState(false)

  const picked = useMemo(() => nodes.filter((n) => ids.includes(n.id)), [nodes, ids])
  const groups = picked.filter((n) => n.type === 'group').length
  /* 判据与 `groupSelection` 真正接受的一致：除了分组本体和空 Output，
     其余都能进组。原来只数 image/prompt，后果是选中刚生成的几个产出点「成组」，
     按钮却是灰的——而那正是最常想成组的一批东西 */
  const groupable = picked.filter(
    (n) => n.type !== 'group' && !(n.type === 'output' && (n.items ?? []).length === 0),
  ).length

  const boxOf = nodeBoxOf

  const align = (mode: AlignMode) => alignNodes(ids, mode, boxOf)
  const spread = (axis: SpreadAxis) => spreadNodes(ids, axis, boxOf)

  /* 只排选中对无连线的选区没有意义：一堆互不相连的节点摊开只会挤成一列 */
  const linked = useMemo(() => {
    const picked = new Set(ids)
    return connections.some((c) => picked.has(c.from) && picked.has(c.to))
  }, [ids, connections])

  return (
    <div className="scv-bulkbar">
      <span className="scv-bulk-count">选中 {ids.length} 个节点</span>

      <button
        className="scv-nodebtn"
        aria-expanded={tools}
        title={tools ? '收起排版工具' : '展开排版工具：只排选中、对齐、等距分布'}
        onClick={() => setTools((v) => !v)}
      >
        排版 {tools ? '▴' : '▾'}
      </button>

      {tools && (
      <>
      <span className="scv-bulk-group">
        {/* 与顶栏「一键整理」是同一套算法、不同范围，按钮说明必须把这一点说穿：
            这边只动手里选中的这几个，那边会把整条链一起排（canvasStore.arrangeCluster
            的注释是同一份口径）。两个按钮都叫「排列」而不说范围的话，用户点了哪个
            都会觉得另一个是坏的。 */}
        <button
          className="scv-nodebtn"
          disabled={!linked}
          title={
            linked
              ? `只排选中的这 ${ids.length} 个：按连线深度摊成从左到右的列，分组整体平移，链上其余节点不动`
              : '选中的节点之间没有连线（想整理整条链路用顶栏的「一键整理」）'
          }
          onClick={() => arrangeSelection(ids, boxOf)}
        >
          只排选中
        </button>
      </span>

      <span className="scv-bulk-group">
        <span className="scv-bulk-label">对齐</span>
        {ALIGN_BTNS.map((b) => (
          <button key={b.mode} className="scv-nodebtn" title={b.title} onClick={() => align(b.mode)}>
            {b.label}
          </button>
        ))}
      </span>

      <span className="scv-bulk-group">
        <span className="scv-bulk-label">等距</span>
        <button
          className="scv-nodebtn"
          disabled={ids.length < 3}
          title={ids.length < 3 ? '等距分布至少要三个节点' : '横向：首尾不动，中间按相等间隙重排'}
          onClick={() => spread('x')}
        >
          横
        </button>
        <button
          className="scv-nodebtn"
          disabled={ids.length < 3}
          title={ids.length < 3 ? '等距分布至少要三个节点' : '纵向：首尾不动，中间按相等间隙重排'}
          onClick={() => spread('y')}
        >
          纵
        </button>
      </span>
      </>
      )}

      <span className="scv-flex" />

      <button
        className="scv-nodebtn"
        disabled={groupable < 1 || cascade !== null}
        title={
          cascade !== null
            ? '有画布执行在跑，等它结束再成组'
            : groupable < 1
              ? '选中的节点里没有能进组的（分组本体和空 Output 进不去）'
              : '图片与产出节点被吸收成组内网格，提示词 / 循环变成成员；指向它们的连线改接到分组'
        }
        onClick={() => groupSelection(ids)}
      >
        成组
      </button>
      <button
        className="scv-nodebtn"
        disabled={groups === 0}
        title="把选中分组里的图拆回独立节点"
        onClick={() => ungroupSelection(ids)}
      >
        解组
      </button>
      <button
        className="scv-nodebtn scv-bulk-del"
        title="连同它们之间的连线一起删。⌘Z 可撤销"
        onClick={() => {
          const s = useCanvasStore.getState()
          s.snapshot()
          s.removeNodes(ids)
        }}
      >
        删除 {ids.length} 个
      </button>
    </div>
  )
}


function CanvasEditorHost({
  nodeId,
  assetId,
  siblingIds,
  scope = 'node',
  initialMode = 'preview',
  onClose,
}: {
  nodeId: string
  /** 一进来先看哪一张。预览里翻页会改它，所以只当初值用 */
  assetId: number
  /** 节点里**全部**图（含 assetId 本身）。预览靠它翻页，拼接靠它选备选图 */
  siblingIds: number[]
  /** 这批图是一个节点的还是整个分组的。只影响弹窗里的文案 */
  scope?: 'node' | 'group'
  initialMode?: EditorMode
  onClose: () => void
}) {
  const canvasId = useCanvasStore((state) => state.canvasId)
  const deploymentId = useCanvasStore(
    (state) =>
      state.nodes.find((node) => node.id === nodeId)?.run_settings?.deployment_id ?? null,
  )
  /** 当前看的是哪一张。预览的上一张/下一张改这里，编辑类页签跟着换主图 */
  const [currentId, setCurrentId] = useState(assetId)
  const asset = useQuery({ queryKey: ['scv-asset', currentId], queryFn: () => apiImage.asset(currentId) })
  const siblings = useQuery({
    queryKey: ['scv-assets', siblingIds],
    queryFn: () => Promise.all(siblingIds.map((id) => apiImage.asset(id))),
    enabled: siblingIds.length > 0,
  })

  /* 成组打开：把这一批图整个交给编辑器，翻页与拼接由它自己管（`CanvasEditorOpen`）。
     取不到这批图时留 undefined，编辑器退回「当前张 + siblings」的旧路径——
     一张图取失败不该让整个弹窗打不开。 */
  const openBatch = useMemo(() => {
    const list = siblings.data
    if (list === undefined || list.length === 0) return undefined
    return {
      items: list,
      startIndex: Math.max(0, list.findIndex((a) => a.id === assetId)),
      mode: initialMode,
      scope,
    }
  }, [siblings.data, assetId, initialMode, scope])

  if (asset.isPending || (siblingIds.length > 0 && siblings.isPending)) {
    return (
      <Overlay onClose={onClose} card="scv-editload">
        <p>正在取原图…</p>
      </Overlay>
    )
  }
  if (asset.data === undefined) {
    return (
      <Overlay onClose={onClose} card="scv-editload">
        <p>取原图失败：{asset.error instanceof Error ? asset.error.message : '未知原因'}</p>
      </Overlay>
    )
  }

  const done = (result: CanvasEditorResult) => {
    const s = useCanvasStore.getState()
    s.snapshot()
    const items = result.assets.map((a) => ({
      asset_id: a.id,
      kind: 'image' as const,
      w: a.width,
      h: a.height,
    }))
    const host = s.nodes.find((n) => n.id === nodeId)
    /** 产物最终落在哪个节点上。关弹窗之后要选中它并高亮新图——
     *  编辑完一屏东西回到画布却什么都没选中，用户得自己去找刚才那张 */
    let landedId = nodeId
    if (host?.type === 'group') {
      /* 分组里编辑的是**其中一张**：整体替换会把同组另外几十张一起抹掉。
         按位置就地换掉那一张，产多张（宫格切分）时在原位展开。 */
      const old = host.items ?? []
      const at = old.findIndex((it) => it.asset_id === currentId)
      const next = at < 0 ? [...old, ...items] : [...old.slice(0, at), ...items, ...old.slice(at + 1)]
      s.updateNode(nodeId, { items: next })
    } else if (result.kind === 'local') {
      // 本地处理是无损可撤的（原图还在资产库里），直接替换本节点的图
      s.updateNode(nodeId, { items })
    } else {
      // 调了模型的另起节点：原图必须留着，否则一次不满意就回不去了
      const src = s.nodes.find((n) => n.id === nodeId)
      landedId = newNodeId()
      s.addNode({
        id: landedId,
        type: 'image',
        x: (src?.x ?? 0) + (src?.w ?? IMAGE_NODE_W) + 80,
        y: src?.y ?? 0,
        title: result.action === 'outpaint' ? '扩图' : '重绘',
        items,
      })
    }

    /* 回到画布时**选中落点节点并高亮刚出的那张**。
       多张产物（宫格切分）取第一张——它是阅读顺序上的第一格。 */
    const first = result.assets[0]
    s.selectOnly([landedId])
    if (first !== undefined) s.setSelectedItem({ nodeId: landedId, assetId: first.id })

    toast.success(
      result.kind === 'local'
        ? `已${ACTION_LABEL[result.action]}，${result.assets.length} 张，已存进资产库`
        : `已${ACTION_LABEL[result.action]}，结果落在右侧新节点`,
    )
    onClose()
  }

  return (
    <CanvasEditor
      asset={asset.data}
      siblings={siblings.data ?? []}
      open={openBatch}
      initialMode={initialMode}
      onPickAsset={(next) => setCurrentId(next.id)}
      /* 重绘/扩图一开跑就在画布上登记：关掉弹窗也看得见在跑、看得见计时，
         跑完图会自己落回节点 */
      onTaskStarted={(taskId) => beginCanvasImageTask(nodeId, taskId)}
      taskContext={{
        toolId: 'infinite-canvas',
        sourceRoute: canvasId === null ? '/studio/canvas' : `/studio/canvas/${canvasId}`,
        sourceContext: {
          asset_id: currentId,
          node_id: nodeId,
          ...(canvasId === null ? {} : { canvas_id: canvasId }),
        },
        deploymentId,
      }}
      onDone={done}
      onClose={onClose}
    />
  )
}

/* ==================== 快捷键表 ==================== */

/** 帮助面板。**只列真正接了处理器的键**——键位表里还有一批（成组之外的
 *  视图缩放、运行/停止）画布还没接，列出来就是让人按了没反应，比不写更糟。
 *  面板与绑定同源（都读 `canvas-core/shortcuts`），改一处两边一起变。 */
function KeysHelp({ actions, onClose }: { actions: Set<ShortcutAction>; onClose: () => void }) {
  const groups = shortcutGroups()
    .map((g) => ({ ...g, items: g.items.filter((sp) => actions.has(sp.action)) }))
    .filter((g) => g.items.length > 0)

  return (
    <Overlay onClose={onClose} card="scv-keys" labelledBy="scv-keys-title">
      <h3 id="scv-keys-title">画布快捷键</h3>
      <table className="scv-keys-table">
        <tbody>
          {groups.map((g) => (
            <Fragment key={g.title}>
              <tr>
                <td colSpan={2}>
                  <strong className="scv-keys-group">{g.title}</strong>
                </td>
              </tr>
              {g.items.map((sp) => (
                <tr key={`${sp.action}-${sp.key}`}>
                  <td>
                    <kbd className="scv-kbd">{shortcutLabel(sp)}</kbd>
                  </td>
                  <td>{sp.hint}</td>
                </tr>
              ))}
            </Fragment>
          ))}
          <tr>
            <td colSpan={2}>
              <strong className="scv-keys-group">鼠标手势</strong>
            </td>
          </tr>
          {GESTURES.map((g) => (
            <tr key={g.label}>
              <td>
                <kbd className="scv-kbd">{g.label}</kbd>
              </td>
              <td>{g.hint}</td>
            </tr>
          ))}
          <tr>
            <td>
              <kbd className="scv-kbd">方向键</kbd>
            </td>
            <td>微移选中节点 5px，按住 Shift 是 20px</td>
          </tr>
        </tbody>
      </table>
      {/* 原来这里有一段"哪些地方快捷键会让路"的说明。删掉有两个理由：
          一是它**说反了**——写着"下拉不算输入框、只有方向键留给它"，
          而 shortcuts.ts 的 isEditable 把下拉一并算作输入框，全部快捷键都让位；
          二是即便改对了也没人需要读：光标在文本框里按键就是输入文字，
          这是浏览器默认行为，按一次就知道，不存在按错的代价。
          错的说明比没有说明更坏。 */}
      <div className="scv-keys-act">
        {/* 提示音的开关放这里：画布没有别的「设置」落点，
            而这个面板本来就是「关于这块画布怎么用」的地方 */}
        <label className="scv-keys-sound">
          <input
            type="checkbox"
            defaultChecked={chimeEnabled()}
            onChange={(e) => {
              setChimeEnabled(e.target.checked)
              // 打开时立刻响一声，让用户听到是什么动静再决定留不留
              if (e.target.checked) chime('done')
            }}
          />
          出图完成时响一声
        </label>
        {/* 「出图后自动收进分组」默认关，理由在 canvasStore.batchGroupEnabled：
            收进分组后图变成 104px 的缩略格子，比留在产出节点里小一档，
            而且吸收会删掉原产出节点、把血缘边改接到分组——这两件事不该默认替用户做。
            想要的人在这里勾一下，之后每次出图收尾自动成组。 */}
        <label className="scv-keys-sound">
          <input
            type="checkbox"
            defaultChecked={batchGroupEnabled()}
            onChange={(e) => setBatchGroupEnabled(e.target.checked)}
          />
          出图后把这个节点的产出收进一个分组
        </label>
        <button className="btn btn-outline btn-sm" onClick={onClose}>
          知道了
        </button>
      </div>
    </Overlay>
  )
}

const ACTION_LABEL: Record<CanvasEditorResult['action'], string> = {
  crop: '裁剪',
  annotate: '标注',
  mask: '重绘',
  outpaint: '扩图',
  resize: '缩放',
  split: '切分',
  join: '拼接',
}
