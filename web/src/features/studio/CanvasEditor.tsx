/* 画布图片编辑器（模块 17 · FR-466）。

   画布节点上的一张图，进这个浮层做几件事：预览、裁剪、缩放、标注、宫格切分、
   宫格拼接、遮罩重绘、AI 扩图。前六件在浏览器里算完（即时、可反复试），
   后两件交给模型（有等待、结果每次不同）——差别写在每个模式顶部，
   说的是**等多久、结果稳不稳**，不是价钱。

   > [!warning] 产物一律经模块 16 入库，工坊不碰文件存储
   >
   > 纯前端的几件走 `/images/local`（`source=local`，BR-118）；
   > 两件编辑走既有 `/images/edit`（BR-141，不为工坊另开生成通路）。
   > 指纹去重、血缘、缩略图因此自动生效（BR-140）。

   > [!warning] 遮罩与扩图的画布为什么是自己的一份
   >
   > 这两页原来直接挂模块 16 的 `MaskCanvas`。它有两件事这里做不到：
   > 笔迹与外扩量都关在它内部，弹窗顶层的 ⌘Z 够不着（项目主人明确要快捷键撤销）；
   > 外扩手柄是单侧的，而这里要的是**拖一侧两侧同时扩**。改它属于模块 16 的文件，
   > 本轮不动别人的文件，所以画布这一层自己实现，konva 也就不用进这个文件了
   > （顺带把「一 import 就在 vitest 里炸」那条坑解掉）。
   >
   > 它踩平的两个坑一字不漏地带了过来：蒙版的 alpha 语义（**透明 = 交给模型重画**）
   > 由 `canvas-editor-math.maskOps` 承载并被单测钉住；「导出按原图像素而不是显示
   > 尺寸」体现在所有笔迹与外扩量都以原图坐标存、显示时才乘缩放比。
   > 生图控制台那边照旧用 `MaskCanvas`，两处互不影响。

   几何全部按容器实测尺寸算，两条本仓踩过的坑摆在这儿：
   - flex 列里 `width:100%` + `aspect-ratio` 会被兄弟元素压扁，所以画面尺寸一律由
     可用宽高一起反推（`Math.min(box.w/natW, box.h/natH, 1)`），不靠 CSS 撑；
   - `display:grid` 不写 `grid-template-rows/columns: minmax(0,1fr)`，子元素的
     `min-height:0` / `max-height:100%` 等于没写，画布会被内容顶出容器。 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { MutableRefObject, PointerEvent as ReactPointerEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Brush,
  ChevronLeft,
  ChevronRight,
  Combine,
  Crop,
  Eye,
  Grid3x3,
  Maximize2,
  Minimize2,
  PenLine,
  Redo2,
  Undo2,
} from '@/components/NexusIcon'

import { Overlay } from '../../components/Overlay'
import { IconClose } from '../../components/icons'
import { apiImage } from '../../lib/api-image'
import type { ImageAsset } from '../../lib/api-image'
import { runImageEditTask } from '../../lib/image-edit-task'
import type { ImageEditTaskContext } from '../../lib/image-edit-task'
import { IS_MAC, capturePointer, releasePointer, wheelZoomFactor, zoomAtPoint } from './canvas-core'
import {
  FOUR_K_PIXELS,
  evenCuts,
  nextCut,
  normalizeCuts,
  ratioLabel,
  splitRects,
} from './image-math'
import type { Cuts } from './image-math'
import type { Viewport } from './canvas-core'
import {
  MAX_PAD_RATIO,
  NO_PAD,
  applyOutpaintDrag,
  buildJoinLayout,
  emptyHistory,
  joinAutoDims,
  joinCanvasSize,
  joinDropTarget,
  joinOutputScale,
  maskOps,
  matchEditorKey,
  padForRatio,
  padSize,
  recordHistory,
  redoHistory,
  shouldRecord,
  stepIndex,
  swapInOrder,
  undoHistory,
} from './canvas-editor-math'
import type { History, JoinLayout, MaskStroke, OutpaintHandle, Pad } from './canvas-editor-math'
import './canvas-editor.css'

export interface CanvasEditorResult {
  /** 产出的资产（已入库）。裁剪/宫格产多张，编辑类产一张 */
  assets: ImageAsset[]
  /** 'local' = 在浏览器里算完的；'edit' = 交给模型生成的 */
  kind: 'local' | 'edit'
  /** 用户做的是哪种操作，用来记 op 与提示文案。
   *  **不含 preview**——看图不产出任何东西，自然也走不到这里 */
  action: Exclude<Mode, 'preview'>
}

/** 编辑器的八个页签。`preview` 是其中唯一只读的一个，也是双击的默认落点 */
export type CanvasEditorMode = 'preview' | 'crop' | 'mask' | 'outpaint' | 'split' | 'join' | 'resize' | 'annotate'
type Mode = CanvasEditorMode

/* ==================== 常量 ==================== */

/** 单张画布的长边上限。几千万像素的 canvas 会把标签页卡死，超了先缩再处理 */
const MAX_EDGE = 2048
/** 拼接成品的上限。单张已经按 MAX_EDGE 压过一轮，网格再套同一个数会把 2×2 的
 *  四张全图砍成半分辨率（实测四张 1254px 拼出来只剩 1021px 一格）。这里只挡真正
 *  拖垮浏览器的体量：长边 4096、总面积 1600 万像素（iOS Safari 的画布面积上限是
 *  16,777,216，超过就整张返回空白且不报错） */
const MAX_JOIN_EDGE = 4096
const MAX_JOIN_AREA = 16_000_000
/** 选框最小边长（原图像素） */
const MIN_CROP = 16
/** 扩图的预置提示词。用户可改 */
const OUTPAINT_PROMPT = 'Remove the white area and continue the scene naturally'

const QUALITIES: Array<[string, string]> = [
  ['low', '低'],
  ['medium', '中'],
  ['high', '高'],
]

const CROP_RATIOS: Array<{ key: string; label: string; value: number | null }> = [
  { key: 'free', label: '自由', value: null },
  { key: '1:1', label: '1:1', value: 1 },
  { key: '16:9', label: '16:9', value: 16 / 9 },
  { key: '9:16', label: '9:16', value: 9 / 16 },
  { key: '4:3', label: '4:3', value: 4 / 3 },
  { key: '3:2', label: '3:2', value: 3 / 2 },
]

const SPLIT_PRESETS: Array<{ key: string; label: string; cols: number; rows: number }> = [
  { key: '2x2', label: '2 × 2', cols: 2, rows: 2 },
  { key: '3x3', label: '3 × 3', cols: 3, rows: 3 },
  { key: '2x1', label: '2 × 1', cols: 2, rows: 1 },
  { key: '1x2', label: '1 × 2', cols: 1, rows: 2 },
]

/** 八个模式。`hint` 是鼠标悬停的一句话，说的是**这个模式做什么**——
 *  标签名（「缩放」「画笔」）在不同工具里含义不一样，光看名字猜不准。 */
const MODES: Array<{ key: Mode; label: string; icon: JSX.Element; hint: string }> = [
  { key: 'preview', label: '预览', icon: <Eye />, hint: '看大图：滚轮缩放、拖动查看、对比原图' },
  { key: 'crop', label: '裁剪', icon: <Crop />, hint: '拖选框裁掉多余部分，导出 PNG 无损' },
  { key: 'annotate', label: '画笔', icon: <PenLine />, hint: '在图上画标记，烤进图里存成新资产' },
  { key: 'mask', label: '遮罩重绘', icon: <Brush />, hint: '涂哪里、模型就重画哪里，要等十几秒' },
  { key: 'outpaint', label: 'AI 扩图', icon: <Maximize2 />, hint: '把画面往外扩，新增的一圈由模型补画' },
  { key: 'resize', label: '缩放', icon: <Minimize2 />, hint: '改成目标尺寸，重采样后另存' },
  { key: 'split', label: '宫格切分', icon: <Grid3x3 />, hint: '按行列切成若干张，逐张入库' },
  { key: 'join', label: '宫格拼接', icon: <Combine />, hint: '把这一组图拼成一张，每格拖着能换位' },
]

/** 缩放的快捷倍数。只做缩小——放大是超分，当前网关上游没有任何超分模型
 *  （2026-08-20 查过 13 个模型），拉伸像素只会让图变糊而不是变清楚 */
const RESIZE_STEPS = [0.75, 0.5, 0.35, 0.25]

/** 画笔工具。序号是给「标出第 1/2/3 处」这种批注用的，点一下自动递增 */
const PEN_TOOLS = [
  { key: 'free', label: '自由画笔', hint: '按住拖动随手画' },
  { key: 'rect', label: '矩形', hint: '框住要说的区域' },
  { key: 'ellipse', label: '圆形', hint: '圈出一个点' },
  { key: 'arrow', label: '箭头', hint: '从哪指向哪' },
  { key: 'number', label: '序号', hint: '点一下放一个圈号，自动递增' },
] as const

type PenTool = (typeof PEN_TOOLS)[number]['key']

const PEN_COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#111827', '#ffffff']

/* ==================== 通用助手 ==================== */

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

type AnchorX = 'left' | 'center' | 'right'
type AnchorY = 'top' | 'center' | 'bottom'

function clamp(value: number, lo: number, hi: number): number {
  if (hi < lo) return lo
  if (value < lo) return lo
  return value > hi ? hi : value
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const el = new window.Image()
    // crossOrigin 必须在 src 之前设：晚一步浏览器已按无凭证模式发出请求，
    // 图能显示但画布被判定为污染，导出时才炸
    el.crossOrigin = 'anonymous'
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error('图片加载失败：地址取不到，或对方站点没放行跨域读取'))
    el.src = src
  })
}

function newCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w))
  canvas.height = Math.max(1, Math.round(h))
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('浏览器没有给出 2D 画布上下文，无法导出图片')
  return [canvas, ctx]
}

function toPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    // 画布被污染时 toBlob 同步抛 SecurityError，在 executor 里抛出即转成 reject
    canvas.toBlob((blob) => {
      if (blob === null) {
        reject(new Error('浏览器没能把画布编码成 PNG'))
        return
      }
      resolve(blob)
    }, 'image/png')
  })
}

/** 长边超过 MAX_EDGE 时给出缩放比，否则 1 */
function fitScale(w: number, h: number, limit = MAX_EDGE): number {
  const long = Math.max(w, h)
  return long > limit ? limit / long : 1
}

/* 拼接成品的缩放比原来在这儿写了一遍（长边与总面积取更紧的那条）。
   现在归 `canvas-editor-math.joinOutputScale`——那边还要接「目标长边」这个档位，
   两处各算一份迟早对不上，而且这条判据只能靠单测守（超限时浏览器返回空白且不报错）。 */

function readError(err: unknown, fallback: string): string {
  if (err instanceof DOMException && err.name === 'SecurityError') {
    return '这张图来自其他站点且没放行跨域读取（CORS），浏览器禁止从画布里取像素。先把它存进资产库再来编辑。'
  }
  return err instanceof Error ? err.message : fallback
}

/** 存一张纯前端产物。source=local（BR-118） */
async function saveLocal(
  blob: Blob,
  op: Mode,
  parentId: number,
  note?: string,
): Promise<ImageAsset> {
  const form = new FormData()
  form.set('image', blob, `${op}.png`)
  form.set('op', op)
  form.set('parent_id', String(parentId))
  if (note !== undefined && note !== '') form.set('note', note)
  return apiImage.saveLocal(form)
}

/** 组件卸载后别再往 state 里写。浮层可以在请求飞在半路时关掉 */
function useAlive(): { current: boolean } {
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  return alive
}

function useImage(src: string): { img: HTMLImageElement | null; error: string | null } {
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    setImg(null)
    setError(null)
    loadImage(src).then(
      (el) => {
        if (alive) setImg(el)
      },
      (err: unknown) => {
        if (alive) setError(readError(err, '图片加载失败'))
      },
    )
    return () => {
      alive = false
    }
  }, [src])
  return { img, error }
}

/** 量容器实际尺寸。量到 0 就保留上一次的值——面板隐藏时整棵 DOM 的几何量都是 0，
 *  把画布压没了就再也长不回来 */
function useBoxSize(): [(el: HTMLDivElement | null) => void, { w: number; h: number }] {
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ w: 720, h: 460 })
  useEffect(() => {
    if (el === null) return
    const observer = new ResizeObserver(() => {
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        setSize({ w: el.clientWidth, h: el.clientHeight })
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [el])
  return [setEl, size]
}

/** 画面在舞台里的摆放：缩放比与左上偏移，全部由容器实测尺寸反推 */
function layout(box: { w: number; h: number }, natW: number, natH: number, pad: number) {
  if (natW <= 0 || natH <= 0) return { scale: 1, w: 0, h: 0, x: 0, y: 0 }
  const scale = Math.max(
    0.02,
    Math.min((box.w - pad * 2) / natW, (box.h - pad * 2) / natH, 1),
  )
  const w = natW * scale
  const h = natH * scale
  return { scale, w, h, x: (box.w - w) / 2, y: (box.h - h) / 2 }
}

/* ==================== 浮层外壳 ==================== */

/** 打开编辑器的一次「开图」。给分组预览与分组宫格拼接用：
 *  一次把整组图交进来，弹窗内部负责翻页与拼接，调用方不必跟着改 asset。
 *
 *  给了 `open` 就由弹窗自己管当前是第几张（`onPickAsset` 仍会回调，方便调用方同步高亮）；
 *  没给则沿用旧路径——`asset` 是当前张，翻页回调给调用方换。 */
export interface CanvasEditorOpen {
  /** 这一次要看/编的全部图，数组顺序就是翻页顺序 */
  items: ImageAsset[]
  /** 起始落在第几张，越界自动夹回范围内。默认 0 */
  startIndex?: number
  /** 起始页签 */
  mode?: CanvasEditorMode
  /** 数据源是单个节点还是整个分组。只影响文案，不影响行为 */
  scope?: 'node' | 'group'
}

export function CanvasEditor({
  asset,
  siblings = [],
  open,
  taskContext,
  initialMode = 'preview',
  onPickAsset,
  onTaskStarted,
  onDone,
  onClose,
}: {
  /** 要编辑的图（画布节点里的那张，已入库）。给了 `open` 时可以不传 */
  asset?: ImageAsset
  /** 同节点其余图。预览翻页与宫格拼接都吃它。可为空数组 */
  siblings?: ImageAsset[]
  /** 成组打开。见 `CanvasEditorOpen` */
  open?: CanvasEditorOpen
  taskContext?: ImageEditTaskContext
  /** 打开时直接进哪个模式。节点工具条按钮各自指一个，省掉「进来再点一次」。
   *  默认 preview——双击一张图最常见的意图是「看清楚点」，不是「裁一刀」。
   *  `open.mode` 优先于它 */
  initialMode?: Mode
  /** 切了上一张/下一张时回调。旧路径靠它换 asset，成组路径只是通知 */
  onPickAsset?: (next: ImageAsset) => void
  /** 调模型的那两个模式（重绘/扩图）任务一建好就回调，用来在画布上登记运行态 */
  onTaskStarted?: (taskId: string) => void
  onDone: (result: CanvasEditorResult) => void
  onClose: () => void
}): JSX.Element {
  const [mode, setMode] = useState<Mode>(open?.mode ?? initialMode)
  // 提示词提在外层：切模式不丢字，Esc 两段式也要看得到它（STD-UI-002b）
  const [maskPrompt, setMaskPrompt] = useState('')
  const [outpaintPrompt, setOutpaintPrompt] = useState(OUTPAINT_PROMPT)
  const promptRef = useRef<HTMLTextAreaElement | null>(null)
  const queryClient = useQueryClient()

  /* 这一次能翻到的全部图。成组打开时以 `open.items` 为准；
     旧路径把当前张与 siblings 合起来去重——调用方给的 siblings 有时含当前张有时不含。 */
  const items = useMemo(() => {
    const list = open !== undefined && open.items.length > 0 ? open.items : [...(asset === undefined ? [] : [asset]), ...siblings]
    const seen = new Set<number>()
    return list.filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)))
  }, [open, asset, siblings])

  /** 成组打开时当前张由弹窗自己记；旧路径由调用方通过 `asset` 控制 */
  const selfDriven = open !== undefined && open.items.length > 0
  const [selfIndex, setSelfIndex] = useState(() => stepIndex(open?.startIndex ?? 0, 0, open?.items.length ?? 0))
  const foundIndex = asset === undefined ? -1 : items.findIndex((a) => a.id === asset.id)
  const index = selfDriven ? stepIndex(selfIndex, 0, items.length) : Math.max(0, foundIndex)
  const current = items[index] ?? asset ?? null

  const goto = useCallback(
    (next: number): void => {
      const target = items[stepIndex(next, 0, items.length)]
      if (target === undefined || target.id === current?.id) return
      if (selfDriven) setSelfIndex(stepIndex(next, 0, items.length))
      onPickAsset?.(target)
    },
    [items, current?.id, selfDriven, onPickAsset],
  )

  const canJoin = items.length > 1

  const finish = useCallback(
    (result: CanvasEditorResult) => {
      // 资产库与用量统计都要跟着刷新，否则用户切过去看还是旧的
      void queryClient.invalidateQueries({ queryKey: ['img-assets'] })
      void queryClient.invalidateQueries({ queryKey: ['img-stats'] })
      void queryClient.invalidateQueries({ queryKey: ['studio-picker-assets'] })
      onDone(result)
    },
    [onDone, queryClient],
  )

  // 焦点在提示词框里且写了东西时，第一次 Esc 只失焦，第二次才关（STD-UI-002b）。
  // 点遮罩时输入框已经先失焦了，所以那条路径照常直接关
  const requestClose = (): void => {
    const box = promptRef.current
    const draft = mode === 'mask' ? maskPrompt : outpaintPrompt
    if (box !== null && document.activeElement === box && draft.trim() !== '') {
      box.blur()
      return
    }
    onClose()
  }

  /* 撤销与切图都绑在**弹窗顶层**而不是各面板：
     面板里的输入框拿走焦点时，绑在面板上的监听就收不到了。
     画布自己的快捷键此时已经整体让路（useOverlayOpen），不会两边一起响应。 */
  const [undoApi, setUndoApi] = useState<UndoApi>(NO_UNDO)
  const registerUndo = useCallback((api: UndoApi | null) => setUndoApi(api ?? NO_UNDO), [])
  const keyState = useRef({ undoApi, goto, index })
  keyState.current = { undoApi, goto, index }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      /* 输入框里让给浏览器：那里的 ⌘Z 是撤销打字、方向键是移动光标。
         **滑杆也算**——`input[type=range]` 靠方向键微调，抢走它就调不动了。 */
      const t = e.target
      if (t instanceof Element && t.closest('input, textarea, select, [contenteditable="true"]') !== null) return
      const action = matchEditorKey(e, IS_MAC)
      if (action === null) return
      const s = keyState.current
      e.preventDefault()
      e.stopPropagation()
      if (action === 'undo') s.undoApi.undo()
      else if (action === 'redo') s.undoApi.redo()
      else s.goto(s.index + (action === 'prev' ? -1 : 1))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  if (current === null) {
    return (
      <Overlay onClose={onClose} card="sced-card" labelledBy="sced-title">
        <header className="sced-head">
          <div className="sced-headtext">
            <h3 id="sced-title">没有可编辑的图</h3>
          </div>
          <button className="btn btn-ghost-sm" aria-label="关闭" onClick={onClose}>
            <IconClose />
          </button>
        </header>
      </Overlay>
    )
  }

  const scopeWord = open?.scope === 'group' ? '这个分组' : '这个节点'

  return (
    <Overlay onClose={requestClose} card="sced-card" labelledBy="sced-title">
      {/* 头部三列：左标题+翻页 / 中模式 tab / 右撤销+关闭（蓝本 .image-edit-head 同款 grid）。
          模式放顶部横排而不是左侧竖列——竖列会把本来就窄的舞台再切掉 148px，
          而看图这件事最不能忍的就是舞台小。 */}
      <header className="sced-head">
        <div className="sced-headtext">
          <h3 id="sced-title">{MODES.find((m) => m.key === mode)?.label ?? '编辑这张图'}</h3>
          <p className="sced-sub">
            资产 #{current.id} · {current.width}×{current.height}
          </p>
          {items.length > 1 && (
            /* 翻页放在头部而不是浮在舞台上：八个页签的舞台各有各的浮层
               （预览的百分比、缩放条、拼接的画板），浮一个全局条一定会撞上谁。
               切页不重置页签——用户是「拿同一把尺子量下一张」。 */
            <div className="sced-flip" role="group" aria-label="切换图片">
              <button
                className="sced-flip-btn"
                aria-label="上一张"
                title={`上一张（←）· ${scopeWord}共 ${items.length} 张`}
                disabled={index <= 0}
                onClick={() => goto(index - 1)}
              >
                <ChevronLeft />
              </button>
              <span className="sced-flip-num">
                {index + 1} / {items.length}
              </span>
              <button
                className="sced-flip-btn"
                aria-label="下一张"
                title={`下一张（→）· ${scopeWord}共 ${items.length} 张`}
                disabled={index >= items.length - 1}
                onClick={() => goto(index + 1)}
              >
                <ChevronRight />
              </button>
            </div>
          )}
        </div>

        <nav className="sced-mode-tabs" aria-label="编辑模式">
          {MODES.map((m) => {
            const locked = m.key === 'join' && !canJoin
            return (
              <button
                key={m.key}
                className={mode === m.key ? 'sced-mode sced-mode-on' : 'sced-mode'}
                disabled={locked}
                title={locked ? '拼接至少要两张图。先往节点里再加一张，或者从分组打开' : m.hint}
                onClick={() => setMode(m.key)}
              >
                {m.icon}
                <span>{m.label}</span>
              </button>
            )
          })}
        </nav>

        <div className="sced-headacts">
          {/* 撤销按钮和 ⌘Z 是同一套栈。留着按钮是因为快捷键本身不可见——
              只给快捷键的话，没人知道这一步可以退回去 */}
          <button
            className="sced-flip-btn"
            aria-label="撤销"
            title={IS_MAC ? '撤销（⌘Z）' : '撤销（Ctrl+Z）'}
            disabled={!undoApi.canUndo}
            onClick={() => undoApi.undo()}
          >
            <Undo2 />
          </button>
          <button
            className="sced-flip-btn"
            aria-label="重做"
            title={IS_MAC ? '重做（⌘⇧Z）' : '重做（Ctrl+Y）'}
            disabled={!undoApi.canRedo}
            onClick={() => undoApi.redo()}
          >
            <Redo2 />
          </button>
          <button className="btn btn-ghost-sm" aria-label="关闭" onClick={onClose}>
            <IconClose />
          </button>
        </div>
      </header>

      <div className="sced-body">
        <UndoBus.Provider value={registerUndo}>

        {mode === 'preview' ? (
          <PreviewPane key="preview" asset={current} siblings={items} onPick={(next) => goto(items.findIndex((x) => x.id === next.id))} />
        ) : null}
        {mode === 'crop' ? <CropPane key={`crop-${current.id}`} asset={current} onDone={finish} /> : null}
        {mode === 'resize' ? <ResizePane key={`resize-${current.id}`} asset={current} onDone={finish} /> : null}
        {mode === 'annotate' ? <AnnotatePane key={`annotate-${current.id}`} asset={current} onDone={finish} /> : null}
        {mode === 'split' ? <SplitPane key={`split-${current.id}`} asset={current} onDone={finish} /> : null}
        {mode === 'join' && canJoin ? (
          <JoinPane key="join" asset={current} items={items} scope={open?.scope ?? 'node'} onDone={finish} />
        ) : null}
        {mode === 'mask' || mode === 'outpaint' ? (
          <EditPane
            key={`${mode}-${current.id}`}
            onTaskStarted={onTaskStarted}
            mode={mode}
            asset={current}
            taskContext={taskContext}
            prompt={mode === 'mask' ? maskPrompt : outpaintPrompt}
            onPrompt={mode === 'mask' ? setMaskPrompt : setOutpaintPrompt}
            promptRef={promptRef}
            onDone={finish}
          />
        ) : null}
        </UndoBus.Provider>
      </div>
    </Overlay>
  )
}

/* ==================== 弹窗内的撤销 ==================== */

/** 一个面板对外暴露的撤销能力 */
export interface UndoApi {
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
}

const NO_UNDO: UndoApi = { undo: () => undefined, redo: () => undefined, canUndo: false, canRedo: false }

/** 弹窗把「当前面板的撤销」登记在这里，顶层的 ⌘Z 找它。
 *
 *  为什么要有这一层：⌘Z 得绑在弹窗顶层（面板里的输入框抢不到焦点时也要生效），
 *  但真正知道怎么撤的是各个面板。context 只传一个 register，
 *  面板挂载时报到、卸载时注销——切 tab 自然就换了撤销目标，不会撤到上一个面板的历史。 */
const UndoBus = createContext<(api: UndoApi | null) => void>(() => undefined)

/** 给面板做「撤销这一步操作」。
 *
 *  面板不用改自己的 useState——只报两样东西：
 *  一个**状态指纹**（变了就说明用户改了什么）与一个**还原函数**。
 *  比把每个 useState 换成 useUndoable 侵入小得多，也不会漏掉某个 setter。
 *
 *  `coalesceMs` 是关键：拖一次裁剪选框会触发上百次 set，不合并的话
 *  按一次 ⌘Z 只退回一帧，用户要按两百下才回到起点。默认 400ms 内的连续改动算一步。 */
function useUndoOf<T>(
  key: string,
  value: T,
  restore: (v: T) => void,
  opts: { coalesceMs?: number; limit?: number } = {},
): UndoApi {
  const { coalesceMs = 400, limit = 40 } = opts
  /** 栈本身是纯数据，转移规则在 `canvas-editor-math`（那边有单测守着） */
  const history = useRef<History<{ key: string; value: T }>>(emptyHistory())
  const last = useRef({ key, value })
  const lastAt = useRef(0)
  const applying = useRef(false)
  const [, bump] = useState(0)

  useEffect(() => {
    if (key === last.current.key) return
    if (applying.current) {
      // 这次变化是 undo/redo 自己造成的，不该再入栈
      applying.current = false
      last.current = { key, value }
      bump((n) => n + 1)
      return
    }
    const now = performance.now()
    if (shouldRecord(now, lastAt.current, coalesceMs)) {
      history.current = recordHistory(history.current, last.current, limit)
      bump((n) => n + 1)
    }
    lastAt.current = now
    last.current = { key, value }
  }, [key, value, coalesceMs, limit])

  const undo = useCallback(() => {
    const step = undoHistory(history.current, last.current, limit)
    if (step === null) return
    history.current = step.history
    applying.current = true
    restore(step.value.value)
    bump((n) => n + 1)
  }, [restore, limit])

  const redo = useCallback(() => {
    const step = redoHistory(history.current, last.current, limit)
    if (step === null) return
    history.current = step.history
    applying.current = true
    restore(step.value.value)
    bump((n) => n + 1)
  }, [restore, limit])

  return {
    undo,
    redo,
    canUndo: history.current.past.length > 0,
    canRedo: history.current.future.length > 0,
  }
}

/** 把本面板的撤销能力报给弹窗顶层。挂载时报到、卸载时注销 */
function useRegisterUndo(api: UndoApi): void {
  const register = useContext(UndoBus)
  useEffect(() => {
    register(api)
    return () => register(null)
    // api 每次渲染都是新对象，但里面的 canUndo/canRedo 会变，要跟着报
  }, [register, api.canUndo, api.canRedo, api.undo, api.redo])
}

/* 这里曾经有一个 ModeNote：每个模式顶部一句话说明。整个删掉了。
   它先是一条按「要不要调模型」分色的红绿告警横幅（调模型是常态，做成每屏警示条
   等于教用户少用自己付过的能力），改成中性说明条之后仍然没活下来——
   七条里六条在说「产物存进资产库、原图不动」，那是弹窗级的事实，
   写在每个模式顶上就是同一句话读七遍；剩下那条还把耗时说错了（见 mask 分支）。

   真正该说的两类都另有出处，且离决策点更近：手势写在元素自己的 title 上
   （切割线「拖动调整位置，双击删掉这条线」），约束与后果写在侧栏对应参数下面。 */

/* ==================== 裁剪 ==================== */

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

const HANDLES: Array<{ key: Handle; left: string; top: string; cursor: string }> = [
  { key: 'nw', left: '0%', top: '0%', cursor: 'nwse-resize' },
  { key: 'n', left: '50%', top: '0%', cursor: 'ns-resize' },
  { key: 'ne', left: '100%', top: '0%', cursor: 'nesw-resize' },
  { key: 'e', left: '100%', top: '50%', cursor: 'ew-resize' },
  { key: 'se', left: '100%', top: '100%', cursor: 'nwse-resize' },
  { key: 's', left: '50%', top: '100%', cursor: 'ns-resize' },
  { key: 'sw', left: '0%', top: '100%', cursor: 'nesw-resize' },
  { key: 'w', left: '0%', top: '50%', cursor: 'ew-resize' },
]

const ANCHORS: Record<Handle, [AnchorX, AnchorY]> = {
  nw: ['right', 'bottom'],
  n: ['center', 'bottom'],
  ne: ['left', 'bottom'],
  e: ['left', 'center'],
  se: ['left', 'top'],
  s: ['center', 'top'],
  sw: ['right', 'top'],
  w: ['right', 'center'],
}

/** 把矩形改成指定比例，并绕锚点缩回画面内。
 *  锚点是拖拽时**不动的那个角/边**，绕它缩放才不会出现「拖右边框，左边也跟着跑」 */
function conform(raw: Rect, ratio: number, ax: AnchorX, ay: AnchorY, W: number, H: number): Rect {
  const w = Math.min(raw.w, raw.h * ratio)
  const sized: Rect = { x: 0, y: 0, w, h: w / ratio }
  sized.x =
    ax === 'left' ? raw.x : ax === 'right' ? raw.x + raw.w - sized.w : raw.x + (raw.w - sized.w) / 2
  sized.y =
    ay === 'top' ? raw.y : ay === 'bottom' ? raw.y + raw.h - sized.h : raw.y + (raw.h - sized.h) / 2

  const px = ax === 'left' ? sized.x : ax === 'right' ? sized.x + sized.w : sized.x + sized.w / 2
  const py = ay === 'top' ? sized.y : ay === 'bottom' ? sized.y + sized.h : sized.y + sized.h / 2

  let k = 1
  const consider = (anchor: number, point: number, hi: number): void => {
    const d = point - anchor
    if (d === 0) return
    if (anchor + d > hi) k = Math.min(k, (hi - anchor) / d)
    if (anchor + d < 0) k = Math.min(k, -anchor / d)
  }
  consider(px, sized.x, W)
  consider(px, sized.x + sized.w, W)
  consider(py, sized.y, H)
  consider(py, sized.y + sized.h, H)
  const scale = clamp(k, 0.01, 1)
  return {
    x: px + (sized.x - px) * scale,
    y: py + (sized.y - py) * scale,
    w: sized.w * scale,
    h: sized.h * scale,
  }
}

function roundRect(r: Rect, W: number, H: number): Rect {
  const w = clamp(Math.round(r.w), MIN_CROP, W)
  const h = clamp(Math.round(r.h), MIN_CROP, H)
  return { x: clamp(Math.round(r.x), 0, W - w), y: clamp(Math.round(r.y), 0, H - h), w, h }
}

interface CropDrag {
  kind: 'move' | 'new' | Handle
  sx: number
  sy: number
  base: Rect
  scale: number
  ratio: number | null
  W: number
  H: number
}

/** 返回 null 表示这一下不该改选框（在图上点一下但没拖） */
function applyDrag(d: CropDrag, ev: PointerEvent): Rect | null {
  const dx = (ev.clientX - d.sx) / d.scale
  const dy = (ev.clientY - d.sy) / d.scale

  if (d.kind === 'move') {
    return roundRect(
      { ...d.base, x: clamp(d.base.x + dx, 0, d.W - d.base.w), y: clamp(d.base.y + dy, 0, d.H - d.base.h) },
      d.W,
      d.H,
    )
  }

  if (d.kind === 'new') {
    // 在图上点一下没拖动时，别把用户调好的选框换成一个 16px 的小方块
    if (Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) < 4) return null
    const x0 = clamp(d.base.x, 0, d.W)
    const y0 = clamp(d.base.y, 0, d.H)
    const x1 = clamp(d.base.x + dx, 0, d.W)
    const y1 = clamp(d.base.y + dy, 0, d.H)
    const raw: Rect = {
      x: Math.min(x0, x1),
      y: Math.min(y0, y1),
      w: Math.max(MIN_CROP, Math.abs(x1 - x0)),
      h: Math.max(MIN_CROP, Math.abs(y1 - y0)),
    }
    if (d.ratio === null) return roundRect(raw, d.W, d.H)
    // 起手那个角固定不动
    return roundRect(conform(raw, d.ratio, x1 >= x0 ? 'left' : 'right', y1 >= y0 ? 'top' : 'bottom', d.W, d.H), d.W, d.H)
  }

  const handle = d.kind
  let left = d.base.x
  let top = d.base.y
  let right = d.base.x + d.base.w
  let bottom = d.base.y + d.base.h
  if (handle.includes('w')) left = clamp(d.base.x + dx, 0, right - MIN_CROP)
  else if (handle.includes('e')) right = clamp(right + dx, left + MIN_CROP, d.W)
  if (handle.includes('n')) top = clamp(d.base.y + dy, 0, bottom - MIN_CROP)
  else if (handle.includes('s')) bottom = clamp(bottom + dy, top + MIN_CROP, d.H)

  const raw: Rect = { x: left, y: top, w: right - left, h: bottom - top }
  if (d.ratio === null) return roundRect(raw, d.W, d.H)

  const [ax, ay] = ANCHORS[handle]
  // 拖上下边框时高度带头、拖左右边框时宽度带头，拖角则整体缩进 raw 里
  const led: Rect =
    handle === 'n' || handle === 's'
      ? { ...raw, w: raw.h * d.ratio }
      : handle === 'e' || handle === 'w'
        ? { ...raw, h: raw.w / d.ratio }
        : raw
  return roundRect(conform(led, d.ratio, ax, ay, d.W, d.H), d.W, d.H)
}

function CropPane({
  asset,
  onDone,
}: {
  asset: ImageAsset
  onDone: (result: CanvasEditorResult) => void
}): JSX.Element {
  const { img, error } = useImage(asset.full_url)
  const [setBox, box] = useBoxSize()
  const [rect, setRect] = useState<Rect | null>(null)
  const [ratioKey, setRatioKey] = useState('free')
  const [busy, setBusy] = useState(false)

  // ⌘Z 撤销选框与比例的改动。拖拽会连发上百次 set，靠 coalesceMs 合成一步
  useRegisterUndo(
    useUndoOf(
      `${ratioKey}|${rect === null ? '-' : `${rect.x},${rect.y},${rect.w},${rect.h}`}`,
      { rect, ratioKey },
      useCallback((v: { rect: Rect | null; ratioKey: string }) => {
        setRect(v.rect)
        setRatioKey(v.ratioKey)
      }, []),
    ),
  )
  const alive = useAlive()

  const natW = img?.naturalWidth ?? 0
  const natH = img?.naturalHeight ?? 0
  const ratio = CROP_RATIOS.find((r) => r.key === ratioKey)?.value ?? null
  const view = layout(box, natW, natH, 22)

  const reset = useCallback((w: number, h: number) => {
    const rw = Math.round(w * 0.8)
    const rh = Math.round(h * 0.8)
    setRect({ x: Math.round((w - rw) / 2), y: Math.round((h - rh) / 2), w: rw, h: rh })
    setRatioKey('free')
  }, [])

  useEffect(() => {
    if (img !== null) reset(img.naturalWidth, img.naturalHeight)
  }, [img, reset])

  const drag = useRef<CropDrag | null>(null)
  useEffect(() => {
    const move = (ev: PointerEvent): void => {
      const d = drag.current
      if (d === null) return
      ev.preventDefault()
      const next = applyDrag(d, ev)
      if (next !== null) setRect(next)
    }
    const up = (): void => {
      drag.current = null
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [])

  const start = (kind: CropDrag['kind'], ev: ReactPointerEvent, base: Rect): void => {
    ev.stopPropagation()
    ev.preventDefault()
    // 缩放比取按下那一刻的：拖动过程中画面不重排，取实时值只会让手势越拖越快
    drag.current = { kind, sx: ev.clientX, sy: ev.clientY, base, scale: view.scale, ratio, W: natW, H: natH }
  }

  const startNew = (ev: ReactPointerEvent): void => {
    if (rect === null) return
    const host = ev.currentTarget.getBoundingClientRect()
    const x = (ev.clientX - host.left) / view.scale
    const y = (ev.clientY - host.top) / view.scale
    start('new', ev, { x, y, w: MIN_CROP, h: MIN_CROP })
  }

  const pickRatio = (key: string): void => {
    setRatioKey(key)
    const value = CROP_RATIOS.find((r) => r.key === key)?.value ?? null
    if (value === null || rect === null) return
    setRect(roundRect(conform(rect, value, 'center', 'center', natW, natH), natW, natH))
  }

  // 长边超上限的选框导出前先缩，几千万像素的 canvas 会把标签页卡死
  const outScale = rect === null ? 1 : fitScale(rect.w, rect.h)
  const outW = rect === null ? 0 : Math.max(1, Math.round(rect.w * outScale))
  const outH = rect === null ? 0 : Math.max(1, Math.round(rect.h * outScale))
  const whole = rect !== null && rect.w === natW && rect.h === natH

  const submit = async (): Promise<void> => {
    if (img === null || rect === null || busy) return
    setBusy(true)
    try {
      const [canvas, ctx] = newCanvas(outW, outH)
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, canvas.width, canvas.height)
      const row = await saveLocal(await toPng(canvas), 'crop', asset.id)
      if (!alive.current) return
      onDone({ assets: [row], kind: 'local', action: 'crop' })
    } catch (e) {
      if (alive.current) toast.error(readError(e, '裁剪失败'))
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  return (
    <>
      <div className="sced-main">
        <div className="sced-stage" ref={setBox}>
          {error !== null ? <p className="sced-msg sced-msg-bad">{error}</p> : null}
          {error === null && img === null ? <p className="sced-msg">图片加载中…</p> : null}
          {img !== null && rect !== null ? (
            <div
              className="sced-plate"
              title="在图上拖 = 画一个新选框；框内拖 = 整体移动；八个把手 = 改大小"
              style={{ left: view.x, top: view.y, width: view.w, height: view.h }}
              onPointerDown={startNew}
            >
              <img src={img.src} alt="" draggable={false} />
              <div
                className="sced-crop"
                style={{
                  left: rect.x * view.scale,
                  top: rect.y * view.scale,
                  width: rect.w * view.scale,
                  height: rect.h * view.scale,
                }}
                onPointerDown={(e) => start('move', e, rect)}
              >
                {HANDLES.map((h) => (
                  <span
                    key={h.key}
                    className="sced-grip"
                    style={{ left: h.left, top: h.top, cursor: h.cursor }}
                    onPointerDown={(e) => start(h.key, e, rect)}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <aside className="sced-side">
        <div className="sced-block">
          <span className="sced-label">比例</span>
          <div className="sced-chips">
            {CROP_RATIOS.map((r) => (
              <button
                key={r.key}
                className={ratioKey === r.key ? 'sced-chip sced-chip-on' : 'sced-chip'}
                onClick={() => pickRatio(r.key)}
              >
                {r.label}
              </button>
            ))}
          </div>
          <p className="sced-note">锁了比例之后，拖任何一个把手都按这个比例走。</p>
        </div>

        <div className="sced-block">
          <span className="sced-label">尺寸</span>
          <p className="sced-nums">
            原图 {natW || asset.width}×{natH || asset.height}
            <br />
            选框 {rect === null ? '—' : `${rect.w}×${rect.h}`}
            <br />
            裁后 {rect === null ? '—' : `${outW}×${outH}`}
          </p>
          {outScale < 1 ? (
            <p className="sced-note">
              选框长边超过 {MAX_EDGE}px，导出时按长边 {MAX_EDGE} 等比缩小——几千万像素的画布会把浏览器卡死。
            </p>
          ) : null}
          {whole ? (
            <p className="sced-note">选框就是整张图，这样裁出来只是原图的一份 PNG 副本。</p>
          ) : null}
          <button
            className="btn btn-outline btn-sm"
            disabled={img === null}
            onClick={() => {
              if (img !== null) reset(img.naturalWidth, img.naturalHeight)
            }}
          >
            重置选框
          </button>
        </div>

        <div className="sced-block">
          <p className="sced-note">导出为 PNG（无损），文件通常比原图大。</p>
        </div>

        <div className="sced-act">
          {busy && <span className="sced-status">正在裁切并入库…</span>}
          <button className="btn btn-primary" disabled={busy || rect === null || img === null} onClick={() => void submit()}>
            {busy ? '处理中…' : '裁剪并保存'}
          </button>
        </div>
      </aside>
    </>
  )
}

/* ==================== 遮罩重绘 / AI 扩图 ==================== */

/** 送给上游的两张图。`mask` 为 null 表示用户还没涂/还没扩，提交要拦住 */
interface EditPayload {
  mask: Blob | null
  composite: Blob | null
  width: number
  height: number
}

/** canvas 不认 CSS 变量，令牌只能当场读成具体色值。换主题会改 data-theme，要重读。
 *  没有 document 时（渲染冒烟测试跑在 node 里）回落到令牌默认值，别在初始化时就炸 */
function useAccent(): string {
  const read = (): string =>
    typeof document === 'undefined'
      ? '#4F46E5'
      : getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#4F46E5'
  const [color, setColor] = useState(read)
  useEffect(() => {
    const observer = new MutationObserver(() => setColor(read()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return color
}

/** 笔迹 → 底图 + 蒙版。蒙版极性由 `maskOps` 定，这里只负责执行 */
async function paintPayload(img: HTMLImageElement, strokes: MaskStroke[]): Promise<EditPayload> {
  const w = img.naturalWidth
  const h = img.naturalHeight
  const [base, bctx] = newCanvas(w, h)
  bctx.drawImage(img, 0, 0, w, h)
  const composite = await toPng(base)
  if (strokes.length === 0) return { mask: null, composite, width: w, height: h }

  const [plate, ctx] = newCanvas(w, h)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = '#000000'
  ctx.fillStyle = '#000000'
  for (const op of maskOps(strokes)) {
    if (op.op === 'fill') {
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillRect(0, 0, w, h)
      continue
    }
    ctx.globalCompositeOperation = op.composite
    ctx.lineWidth = op.width
    ctx.beginPath()
    ctx.moveTo(op.points[0], op.points[1])
    for (let i = 2; i < op.points.length; i += 2) ctx.lineTo(op.points[i], op.points[i + 1])
    ctx.stroke()
  }
  return { mask: await toPng(plate), composite, width: w, height: h }
}

/** 外扩量 → 底图 + 蒙版。原图那一块不透明保留，扩出来的一圈透明交给模型补 */
async function outpaintPayload(img: HTMLImageElement, pad: Pad): Promise<EditPayload> {
  const natW = img.naturalWidth
  const natH = img.naturalHeight
  const { w, h } = padSize(natW, natH, pad)
  const [base, bctx] = newCanvas(w, h)
  bctx.drawImage(img, pad.left, pad.top, natW, natH)
  const composite = await toPng(base)
  if (w === natW && h === natH) return { mask: null, composite, width: w, height: h }
  const [plate, ctx] = newCanvas(w, h)
  ctx.fillStyle = '#000000'
  ctx.fillRect(pad.left, pad.top, natW, natH)
  return { mask: await toPng(plate), composite, width: w, height: h }
}

/** 八个扩图手柄摆在外框的什么位置 */
const OUTPAINT_HANDLES: Array<{ key: OutpaintHandle; left: string; top: string; cursor: string }> = [
  { key: 'nw', left: '0%', top: '0%', cursor: 'nwse-resize' },
  { key: 'n', left: '50%', top: '0%', cursor: 'ns-resize' },
  { key: 'ne', left: '100%', top: '0%', cursor: 'nesw-resize' },
  { key: 'e', left: '100%', top: '50%', cursor: 'ew-resize' },
  { key: 'se', left: '100%', top: '100%', cursor: 'nwse-resize' },
  { key: 's', left: '50%', top: '100%', cursor: 'ns-resize' },
  { key: 'sw', left: '0%', top: '100%', cursor: 'nesw-resize' },
  { key: 'w', left: '0%', top: '50%', cursor: 'ew-resize' },
]

/** 一键外扩的常见比例 */
const OUTPAINT_RATIOS: Array<{ key: string; w: number; h: number }> = [
  { key: '1:1', w: 1, h: 1 },
  { key: '4:3', w: 4, h: 3 },
  { key: '3:4', w: 3, h: 4 },
  { key: '16:9', w: 16, h: 9 },
  { key: '9:16', w: 9, h: 16 },
  { key: '3:2', w: 3, h: 2 },
  { key: '2:3', w: 2, h: 3 },
]

const BRUSH_MIN = 6
const BRUSH_MAX = 200

function EditPane({
  onTaskStarted,
  mode,
  asset,
  taskContext,
  prompt,
  onPrompt,
  promptRef,
  onDone,
}: {
  /** 任务一建好就回调（早于跑完）。调用方据此在画布上登记「这个节点在跑」 */
  onTaskStarted?: (taskId: string) => void
  mode: 'mask' | 'outpaint'
  asset: ImageAsset
  taskContext?: ImageEditTaskContext
  prompt: string
  onPrompt: (text: string) => void
  promptRef: MutableRefObject<HTMLTextAreaElement | null>
  onDone: (result: CanvasEditorResult) => void
}): JSX.Element {
  const { img, error } = useImage(asset.full_url)
  const [setBox, box] = useBoxSize()
  const accent = useAccent()

  /* 笔迹与外扩量都按**原图像素**存。存显示坐标的话，窗口一改大小
     蒙版就整体错位，而错位的蒙版上游不会报错，只能出图后肉眼发现。 */
  const [strokes, setStrokes] = useState<MaskStroke[]>([])
  const [undone, setUndone] = useState<MaskStroke[]>([])
  const [pad, setPad] = useState<Pad>(NO_PAD)
  const [ratioKey, setRatioKey] = useState<string | null>(null)
  const [brush, setBrush] = useState(44)
  const [erasing, setErasing] = useState(false)
  const [symmetric, setSymmetric] = useState(true)

  const [payload, setPayload] = useState<EditPayload | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const [quality, setQuality] = useState('medium')
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const alive = useAlive()
  const busy = startedAt !== null

  const natW = img?.naturalWidth ?? asset.width
  const natH = img?.naturalHeight ?? asset.height
  const out = padSize(natW, natH, pad)
  const view = layout(box, mode === 'outpaint' ? out.w : natW, mode === 'outpaint' ? out.h : natH, 30)
  const expanded = out.w !== natW || out.h !== natH

  /* ---- 撤销：两个模式各一套，报给弹窗顶层的只有当前这个 ---- */

  const undoStroke = useCallback((): void => {
    // 先读后写，不要在 updater 里调另一个 setState（React 18 会在渲染阶段重跑 updater）
    const last = strokes[strokes.length - 1]
    if (last === undefined) return
    setStrokes((p) => p.slice(0, -1))
    setUndone((p) => [...p, last])
  }, [strokes])

  const redoStroke = useCallback((): void => {
    const last = undone[undone.length - 1]
    if (last === undefined) return
    setUndone((p) => p.slice(0, -1))
    setStrokes((p) => [...p, last])
  }, [undone])

  const strokeApi = useMemo(
    () => ({ undo: undoStroke, redo: redoStroke, canUndo: strokes.length > 0, canRedo: undone.length > 0 }),
    [undoStroke, redoStroke, strokes.length, undone.length],
  )
  // 拖手柄会连发上百次 set，靠 coalesceMs 合成一步；比例预设是瞬时的，天然一步
  const padApi = useUndoOf(
    `${pad.top},${pad.right},${pad.bottom},${pad.left}`,
    { pad, ratioKey },
    useCallback((v: { pad: Pad; ratioKey: string | null }) => {
      setPad(v.pad)
      setRatioKey(v.ratioKey)
    }, []),
  )
  useRegisterUndo(mode === 'mask' ? strokeApi : padApi)

  useEffect(() => {
    if (startedAt === null) {
      setElapsed(0)
      return
    }
    const id = window.setInterval(() => setElapsed(Math.round((Date.now() - startedAt) / 1000)), 250)
    return () => window.clearInterval(id)
  }, [startedAt])

  /* ---- 涂画 ---- */

  const painting = useRef(false)
  const drawRef = useRef<HTMLCanvasElement | null>(null)

  const toNat = (e: ReactPointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: (e.clientX - r.left) / view.scale, y: (e.clientY - r.top) / view.scale }
  }

  // 笔迹预览：盖在图上的一层半透明色，画布像素尺寸跟着显示尺寸走
  useEffect(() => {
    const canvas = drawRef.current
    if (canvas === null || mode !== 'mask') return
    canvas.width = Math.max(1, Math.round(view.w))
    canvas.height = Math.max(1, Math.round(view.h))
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = accent
    for (const stroke of strokes) {
      // 橡皮在预览层上是把颜色擦掉，与蒙版那边「把洞补回不透明」是同一件事的两面
      ctx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over'
      ctx.globalAlpha = stroke.erase ? 1 : 0.45
      ctx.lineWidth = Math.max(1, stroke.size * view.scale)
      ctx.beginPath()
      ctx.moveTo(stroke.points[0] * view.scale, stroke.points[1] * view.scale)
      for (let i = 2; i < stroke.points.length; i += 2) {
        ctx.lineTo(stroke.points[i] * view.scale, stroke.points[i + 1] * view.scale)
      }
      ctx.stroke()
    }
  }, [strokes, view.w, view.h, view.scale, accent, mode])

  /* ---- 外扩框拖拽 ---- */

  const drag = useRef<{ handle: OutpaintHandle; x: number; y: number; base: Pad; scale: number } | null>(null)
  const size = useRef({ w: natW, h: natH })
  size.current = { w: natW, h: natH }
  /** 「两侧同时扩」开关的实时值。监听只挂一次，不能把它写进依赖 */
  const symRef = useRef(symmetric)
  symRef.current = symmetric

  useEffect(() => {
    const move = (ev: PointerEvent): void => {
      const d = drag.current
      if (d === null) return
      ev.preventDefault()
      // 缩放比取按下那一刻的：画布变大后视图会重新贴合，取实时值会让同样的手势越拖越快
      const dx = (ev.clientX - d.x) / d.scale
      const dy = (ev.clientY - d.y) / d.scale
      setPad(
        applyOutpaintDrag(d.handle, dx, dy, d.base, {
          natW: size.current.w,
          natH: size.current.h,
          // 修饰键实时读：拖到一半改主意也跟得上
          symmetric: symRef.current ? !ev.altKey : ev.altKey,
        }),
      )
      setRatioKey(null)
    }
    const up = (): void => {
      drag.current = null
      painting.current = false
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [])

  /* ---- 导出（防抖 300ms，别每一笔都编码一次 PNG） ---- */

  useEffect(() => {
    if (img === null) return
    let live = true
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const next = mode === 'mask' ? await paintPayload(img, strokes) : await outpaintPayload(img, pad)
          if (!live) return
          setExportError(null)
          setPayload(next)
        } catch (err) {
          if (!live) return
          setExportError(readError(err, '底图导出失败'))
          // 导不出来就把上一版作废：宁可让提交按钮拦下，也不让旧蒙版蒙混过关
          setPayload(null)
        }
      })()
    }, 300)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [img, mode, strokes, pad])

  const ready = payload?.mask != null && payload.composite != null
  const blocked =
    prompt.trim() === ''
      ? '先写一句话说要画成什么'
      : !ready
        ? mode === 'mask'
          ? '先在图上涂出要重画的区域'
          : '先拖边框决定往外扩多少'
        : null

  const submit = async (): Promise<void> => {
    if (busy || blocked !== null || payload?.mask == null || payload.composite == null) return
    setStartedAt(Date.now())
    try {
      const form = new FormData()
      form.set('prompt', prompt.trim())
      form.set('app_key', mode === 'mask' ? 'inpaint' : 'outpaint')
      form.set('alias', 'image-free')
      form.set('quality', quality)
      form.set('n', '1')
      /* **扩图必须显式带 size**。
         合成图已经是扩后的画布（比如把 1:1 扩成 16:9），但不发 size 的话
         上游按自己的默认档出图，回来还是 1:1 方图——用户明明拖出了 16:9
         的外框，拿到的却是没扩的方图，而且不报错。
         遮罩重绘不发：那是原地改，尺寸本来就该跟随底图。 */
      if (mode === 'outpaint' && payload.width > 0 && payload.height > 0) {
        form.set('size', `${Math.round(payload.width)}x${Math.round(payload.height)}`)
      }
      // 底图送合成图而不是资产 id：扩图的底图是「原图贴在放大画布上」的那张，
      // 与库里存的不是同一张，直引资产会把扩出来的一圈丢掉
      form.append('images', payload.composite, 'composite.png')
      form.set('mask', payload.mask, 'mask.png')
      form.set('parent_id', String(asset.id))
      const items = await runImageEditTask(
        form,
        taskContext ?? {
          toolId: 'infinite-canvas',
          sourceRoute: '/studio/canvas',
          sourceContext: { asset_id: asset.id },
        },
        /* 任务一建好就在画布上登记，**早于它跑完**。
           这样用户关掉弹窗也能在节点上看到在跑、看到计时，
           跑完图会自己落回去——而不是关了弹窗就等于放弃。 */
        onTaskStarted,
      )
      const first = items[0]
      if (first === undefined) throw new Error('上游没有返回图片')
      if (!alive.current) return
      onDone({ assets: [first], kind: 'edit', action: mode })
    } catch (e) {
      if (alive.current) toast.error(e instanceof Error ? e.message : '出图失败')
    } finally {
      if (alive.current) setStartedAt(null)
    }
  }

  return (
    <>
      <div className="sced-main">
        {/* 舞台上方一条工具栏：涂画的笔刷/橡皮/粗细，扩图的比例预置与对称开关。
            放这儿而不是右侧参数栏——它们是「手上的工具」，要离画面近。 */}
        <div className="sced-tools">
          {mode === 'mask' ? (
            <>
              <div className="seg">
                <button className={erasing ? '' : 'active'} disabled={busy} onClick={() => setErasing(false)}>
                  笔刷
                </button>
                <button className={erasing ? 'active' : ''} disabled={busy} onClick={() => setErasing(true)}>
                  橡皮
                </button>
              </div>
              <label className="sced-toolsize">
                笔宽
                <input
                  className="sced-range"
                  type="range"
                  min={BRUSH_MIN}
                  max={BRUSH_MAX}
                  step={2}
                  value={brush}
                  disabled={busy}
                  onChange={(e) => setBrush(Number(e.target.value))}
                />
                <b>{brush}</b>
              </label>
              <span className="sced-toolgap" />
              <button
                className="sced-chip"
                disabled={busy || strokes.length === 0}
                title={IS_MAC ? '撤销一笔（⌘Z）' : '撤销一笔（Ctrl+Z）'}
                onClick={undoStroke}
              >
                撤销
              </button>
              <button
                className="sced-chip"
                disabled={busy || undone.length === 0}
                title={IS_MAC ? '重做（⌘⇧Z）' : '重做（Ctrl+Y）'}
                onClick={redoStroke}
              >
                重做
              </button>
              <button
                className="sced-chip"
                disabled={busy || strokes.length === 0}
                onClick={() => {
                  setUndone([...strokes].reverse())
                  setStrokes([])
                }}
              >
                清空
              </button>
              <span className="sced-toolnote">已涂 {strokes.length} 笔</span>
            </>
          ) : (
            <>
              <span className="sced-toolnote">一键外扩到</span>
              {OUTPAINT_RATIOS.map((r) => (
                <button
                  key={r.key}
                  className={ratioKey === r.key ? 'sced-chip sced-chip-on' : 'sced-chip'}
                  disabled={busy}
                  onClick={() => {
                    setPad(padForRatio(natW, natH, r.w, r.h))
                    setRatioKey(r.key)
                  }}
                >
                  {r.key}
                </button>
              ))}
              <span className="sced-toolgap" />
              <label className="sced-toolcheck" title="关掉之后拖一侧只扩一侧；开着时按住 ⌥/Alt 临时只扩一侧">
                <input
                  type="checkbox"
                  checked={symmetric}
                  disabled={busy}
                  onChange={(e) => setSymmetric(e.target.checked)}
                />
                两侧同时扩
              </label>
              <button
                className="sced-chip"
                disabled={busy || !expanded}
                onClick={() => {
                  setPad(NO_PAD)
                  setRatioKey(null)
                }}
              >
                还原
              </button>
            </>
          )}
        </div>

        <div className="sced-stage" ref={setBox}>
          {error !== null ? <p className="sced-msg sced-msg-bad">{error}</p> : null}
          {error === null && img === null ? <p className="sced-msg">图片加载中…</p> : null}

          {img !== null && mode === 'mask' ? (
            <div className="sced-plate" style={{ left: view.x, top: view.y, width: view.w, height: view.h }}>
              <img src={img.src} alt="" draggable={false} />
              <canvas
                ref={drawRef}
                className="sced-draw"
                style={{ cursor: busy ? 'not-allowed' : 'crosshair' }}
                onPointerDown={(e) => {
                  if (busy) return
                  capturePointer(e.currentTarget, e.pointerId)
                  painting.current = true
                  const p = toNat(e)
                  // 头尾各一个点、错开一丁点，圆头笔帽才画得出「点一下」的那个圆点
                  setStrokes((prev) => [
                    ...prev,
                    { points: [p.x, p.y, p.x + 0.01, p.y], size: brush / view.scale, erase: erasing },
                  ])
                  setUndone([])
                }}
                onPointerMove={(e) => {
                  if (!painting.current) return
                  const p = toNat(e)
                  setStrokes((prev) => {
                    const last = prev[prev.length - 1]
                    if (last === undefined) return prev
                    const dx = p.x - last.points[last.points.length - 2]
                    const dy = p.y - last.points[last.points.length - 1]
                    // 屏幕上挪不到 1.2px 的抖动不记点，长笔迹的点数才不会失控
                    if (Math.hypot(dx, dy) * view.scale < 1.2) return prev
                    return [...prev.slice(0, -1), { ...last, points: [...last.points, p.x, p.y] }]
                  })
                }}
                onPointerUp={(e) => {
                  releasePointer(e.currentTarget, e.pointerId)
                  painting.current = false
                }}
                onPointerLeave={() => {
                  painting.current = false
                }}
              />
            </div>
          ) : null}

          {img !== null && mode === 'outpaint' ? (
            <div
              className="sced-outframe"
              style={{ left: view.x, top: view.y, width: view.w, height: view.h }}
            >
              {/* 棋盘格铺在整个外框上，原图盖在中间——露出来的格子就是要补画的那一圈 */}
              <img
                className="sced-outimg"
                src={img.src}
                alt=""
                draggable={false}
                style={{
                  left: pad.left * view.scale,
                  top: pad.top * view.scale,
                  width: natW * view.scale,
                  height: natH * view.scale,
                }}
              />
              {OUTPAINT_HANDLES.map((h) => (
                <span
                  key={h.key}
                  className="sced-grip"
                  style={{ left: h.left, top: h.top, cursor: busy ? 'not-allowed' : h.cursor }}
                  title={symmetric ? '拖动：两侧同时外扩，按住 ⌥/Alt 只扩这一侧' : '拖动：只扩这一侧，按住 ⌥/Alt 两侧同时扩'}
                  onPointerDown={(e) => {
                    if (busy) return
                    e.preventDefault()
                    e.stopPropagation()
                    drag.current = {
                      handle: h.key,
                      x: e.clientX,
                      y: e.clientY,
                      base: pad,
                      scale: view.scale,
                    }
                  }}
                />
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <aside className="sced-side">
        <div className="sced-block">
          <span className="sced-label">提示词</span>
          <textarea
            ref={promptRef}
            className="sced-prompt"
            value={prompt}
            placeholder={mode === 'mask' ? '涂过的地方要画成什么？' : '扩出来的部分要接着画什么？'}
            onChange={(e) => onPrompt(e.target.value)}
          />
          <p className="sced-note">
            {mode === 'mask'
              ? '涂过的地方交给模型重画，没涂的像素原样保留。'
              : '扩出来的那一圈在合成图里是透明的。预置这句英文是让模型别把它当空白留着，而是顺着原画面接着画下去；改成别的也行。'}
          </p>
        </div>

        <div className="sced-block">
          <span className="sced-label">质量</span>
          <div className="seg">
            {QUALITIES.map(([key, label]) => (
              <button
                key={key}
                className={quality === key ? 'active' : ''}
                disabled={busy}
                onClick={() => setQuality(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="sced-note">档位越高越慢越贵。</p>
        </div>

        <div className="sced-block">
          <span className="sced-label">送上去的底图</span>
          <p className="sced-nums">
            原图 {natW}×{natH}
            {mode === 'outpaint' && (
              <>
                <br />
                新画布 {out.w}×{out.h}（{ratioLabel(out.w, out.h)}）
                <br />
                上 {pad.top} · 右 {pad.right} · 下 {pad.bottom} · 左 {pad.left}
              </>
            )}
          </p>
          {mode === 'outpaint' && (
            <>
              <p className="sced-note">
                {symmetric
                  ? '拖任一手柄：两侧同时等量外扩。按住 ⌥/Alt 改成只扩这一侧。'
                  : '拖任一手柄：只扩这一侧。按住 ⌥/Alt 改成两侧同时扩。'}
              </p>
              <p className="sced-note">
                单边最多扩到原图对应边长的 {MAX_PAD_RATIO} 倍。出图按新画布的尺寸走，
                扩出来的一圈在合成图里是透明的——那正是交给模型补画的部分。
              </p>
            </>
          )}
          {mode === 'outpaint' && out.w * out.h > FOUR_K_PIXELS && (
            <p className="sced-note sced-note-warn">
              这个画布已经超过 4K（{Math.round((out.w * out.h) / 10000) / 100} 万像素）。
              上游多半会按自己的档位缩回去，扩得太大不会更清楚。
            </p>
          )}
          {exportError !== null && <p className="sced-note sced-note-warn">{exportError}</p>}
        </div>

        <div className="sced-act">
          <span className={blocked !== null && !busy ? 'sced-status sced-status-bad' : 'sced-status'}>
            {busy
              ? `已跑 ${elapsed}s，出图通常 20~40s。这会儿关掉窗口不会取消请求，图照样进资产库，但不会落回这个节点`
              : (blocked ?? '')}
          </span>
          <button className="btn btn-primary" disabled={busy || blocked !== null} onClick={() => void submit()}>
            {busy ? '出图中…' : mode === 'mask' ? '重绘' : '扩图'}
          </button>
        </div>
      </aside>
    </>
  )
}

/* ==================== 宫格切分 ==================== */

/** 第 i 条分割线的像素位置。用 round 分摊余数，各格最多差 1 像素 */
/* ==================== 预览（只读，不产出） ==================== */

/** 看大图。**双击图片默认落在这里**，不是一进来就套上裁剪框。
 *
 *  蓝本把预览做成七个 tab 的第一个（smart-canvas.html:260），双击节点默认进它。
 *  我方原来双击直接跳裁剪——用户只想看清楚一张图，却得先躲开一个 80% 的选框，
 *  这是最常做的动作被最不常做的动作挡住了。
 *
 *  缩放数学直接用画布内核那套（`zoomAtPoint` / `wheelZoomFactor`），
 *  光标锚点、指数因子都和画布一致——同一个应用里两种缩放手感是很别扭的。 */
function PreviewPane({ asset, siblings, onPick }: {
  asset: ImageAsset
  siblings: ImageAsset[]
  onPick: (next: ImageAsset) => void
}): JSX.Element {
  const { img, error } = useImage(asset.full_url)
  const [setBox, box] = useBoxSize()
  const [view, setView] = useState<Viewport>({ x: 0, y: 0, scale: 1 })
  const [fitted, setFitted] = useState(true)
  const [compare, setCompare] = useState(50)
  const [comparing, setComparing] = useState(false)
  const [stage, setStage] = useState<HTMLDivElement | null>(null)
  const dragRef = useRef<{ id: number; sx: number; sy: number; vx: number; vy: number } | null>(null)

  const natW = img?.naturalWidth ?? asset.width
  const natH = img?.naturalHeight ?? asset.height

  /** 适应：整张图刚好装进舞台。默认就是它——看不全比看不清更要命 */
  const fit = useCallback((): void => {
    if (box.w <= 0 || natW <= 0) return
    const k = Math.min((box.w - 48) / natW, (box.h - 48) / natH, 1)
    setView({ scale: k, x: (box.w - natW * k) / 2, y: (box.h - natH * k) / 2 })
    setFitted(true)
  }, [box.w, box.h, natW, natH])

  /* 图换了或舞台尺寸变了就重新适应。用 natW 当依赖而不是 img 引用：
     同一张图重新加载时引用会变，但没必要重置用户已经调好的视角 */
  useEffect(() => {
    fit()
  }, [fit])

  const zoomBy = (factor: number, anchor?: { x: number; y: number }): void => {
    const a = anchor ?? { x: box.w / 2, y: box.h / 2 }
    setView((v) => zoomAtPoint(v, a, factor, { min: 0.05, max: 8 }))
    setFitted(false)
  }

  /* 滚轮缩放必须用**原生监听 + passive:false**。
     React 17 起把 wheel 挂在根节点上且是 passive 的，写 onWheel 里的
     `e.preventDefault()` 不会生效，只会往控制台刷
     「Unable to preventDefault inside passive event listener」——
     缩放看着是好的，但页面在背后跟着一起滚。画布内核那边一直是这么绑的，这里补齐。 */
  const zoomRef = useRef(zoomBy)
  zoomRef.current = zoomBy
  useEffect(() => {
    if (stage === null) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const r = stage.getBoundingClientRect()
      zoomRef.current(wheelZoomFactor(e.deltaY), { x: e.clientX - r.left, y: e.clientY - r.top })
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [stage])

  /** 当前显示尺寸相对**原图真实像素**的百分比。
   *  scale=1 不等于 100%——它是「适应」，一张 9:16 的图适应时可能只有真实像素的 47%。 */
  const pct = Math.round(view.scale * 100)

  /** 当前这张在这一组里排第几。翻页按钮在头部，这里只用来标序号与描边 */
  const prev = siblings.findIndex((s) => s.id === asset.id)

  return (
    <>
      <div className="sced-main">
        <div
          className="sced-stage sced-preview-stage"
          ref={(el) => {
            setBox(el)
            setStage(el)
          }}
          onPointerDown={(e) => {
            if (e.button !== 0) return
            if ((e.target as HTMLElement).closest('.sced-compare-grip')) return
            capturePointer(e.currentTarget, e.pointerId)
            dragRef.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y }
          }}
          onPointerMove={(e) => {
            const d = dragRef.current
            if (d === null || d.id !== e.pointerId) return
            setView((v) => ({ ...v, x: d.vx + (e.clientX - d.sx), y: d.vy + (e.clientY - d.sy) }))
            setFitted(false)
          }}
          onPointerUp={(e) => {
            releasePointer(e.currentTarget, e.pointerId)
            dragRef.current = null
          }}
        >
          {error !== null ? <p className="sced-msg sced-msg-bad">{error}</p> : null}
          {error === null && img === null ? <p className="sced-msg">图片加载中…</p> : null}
          {img !== null ? (
            <div
              className="sced-preview-plate"
              style={{
                left: view.x,
                top: view.y,
                width: natW * view.scale,
                height: natH * view.scale,
              }}
            >
              <img src={img.src} alt="" draggable={false} />
              {/* 对比原图：右半边盖一层原图，拖竖线看改动前后。
                  这里两边是同一张图（编辑器里的「原图」就是它自己），
                  真正有意义的是从画布进来看编辑产物时——那时 asset 是产物、parent 是原图。 */}
              {comparing && (
                <div className="sced-compare-cut" style={{ width: `${compare}%` }}>
                  <img src={asset.full_url} alt="" draggable={false} style={{ width: natW * view.scale }} />
                </div>
              )}
              {comparing && (
                <span
                  className="sced-compare-grip"
                  style={{ left: `${compare}%` }}
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    capturePointer(e.currentTarget, e.pointerId)
                  }}
                  onPointerMove={(e) => {
                    if (e.buttons !== 1) return
                    const host = e.currentTarget.parentElement
                    if (host === null) return
                    const r = host.getBoundingClientRect()
                    setCompare(clamp(((e.clientX - r.left) / r.width) * 100, 0, 100))
                  }}
                  onPointerUp={(e) => releasePointer(e.currentTarget, e.pointerId)}
                />
              )}
            </div>
          ) : null}

          {/* 左下角百分比 + 右下角动作，都浮在舞台上不占布局（蓝本同款） */}
          <span className="sced-zoom-badge">{pct}%</span>
          <div className="sced-preview-acts">
            <button className="sced-chip" onClick={() => zoomBy(1 / 1.25)} title="缩小">
              −
            </button>
            <button className="sced-chip" onClick={() => zoomBy(1.25)} title="放大">
              +
            </button>
            <button className={fitted ? 'sced-chip sced-chip-on' : 'sced-chip'} onClick={fit}>
              适应
            </button>
            <button
              className="sced-chip"
              onClick={() => {
                // 1:1 = 一个屏幕像素对一个图像像素，围绕舞台中心
                setView((v) => zoomAtPoint(v, { x: box.w / 2, y: box.h / 2 }, 1 / v.scale, { min: 1, max: 1 }))
                setFitted(false)
              }}
            >
              1:1
            </button>
            <button
              className={comparing ? 'sced-chip sced-chip-on' : 'sced-chip'}
              onClick={() => setComparing((v) => !v)}
              title="拉动竖线对比原图"
            >
              对比原图
            </button>
          </div>
        </div>
      </div>

      <aside className="sced-side">
        <div className="sced-block">
          <span className="sced-label">这张图</span>
          <p className="sced-nums">
            {natW}×{natH}
            <br />
            资产 #{asset.id}
            <br />
            当前显示 {pct}%
          </p>
          {/* 这里原来有一句「百分比按**原图真实像素**算…」。两个毛病：
              一是 JSX 不解析 markdown，界面上真的显示着两对星号（本仓记过这个坑）；
              二是预览只读、看不看都做不错事，而口径本身由旁边的「适应 / 1:1」
              两个按钮表达得更直接——按 1:1 就是 100%。 */}
        </div>

        {siblings.length > 1 && (
          /* 上一张/下一张两颗按钮已经挪到头部（那里每个页签都看得见），
             这里换成缩略图条：翻到第 7 张不必按六次，直接点它。 */
          <div className="sced-block">
            <span className="sced-label">
              这一组（{prev + 1}/{siblings.length}）
            </span>
            <div className="sced-pick">
              {siblings.map((s, i) => (
                <button
                  key={s.id}
                  className={s.id === asset.id ? 'sced-cell sced-cell-on' : 'sced-cell'}
                  title={`资产 #${s.id}（第 ${i + 1} 张）`}
                  onClick={() => onPick(s)}
                >
                  <img src={s.thumb_url} alt="" />
                  <em className="sced-ord">{i + 1}</em>
                </button>
              ))}
            </div>
            <p className="sced-note">← / → 也能切，切过去仍留在当前页签。</p>
          </div>
        )}

        <div className="sced-act">
          <a className="btn btn-primary" href={asset.full_url} download={`asset-${asset.id}.png`}>
            下载原图
          </a>
        </div>
      </aside>
    </>
  )
}

/* ==================== 缩放（浏览器内重采样） ==================== */

/** 按倍数缩小并另存。
 *
 *  只做**缩小**：网关上游一个超分模型都没有（2026-08-20 查过 13 个），
 *  拉伸像素只会把图变糊而不是变清楚——所以这里不提供 >1 的倍数，
 *  也不把它叫「超分」。真要放大得换供应商或接本地模型。 */
function ResizePane({
  asset,
  onDone,
}: {
  asset: ImageAsset
  onDone: (result: CanvasEditorResult) => void
}): JSX.Element {
  const { img, error } = useImage(asset.full_url)
  const [setBox, box] = useBoxSize()
  const [pct, setPct] = useState(50)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  // 滑杆一路拖过去是一步，不是每个百分点一步
  useRegisterUndo(useUndoOf(String(pct), pct, useCallback((v: number) => setPct(v), [])))
  const alive = useAlive()

  const natW = img?.naturalWidth ?? asset.width
  const natH = img?.naturalHeight ?? asset.height
  const view = layout(box, natW, natH, 22)
  const k = clamp(pct, 5, 100) / 100
  const outW = Math.max(1, Math.round(natW * k))
  const outH = Math.max(1, Math.round(natH * k))
  const saved = Math.round((1 - k * k) * 100)

  const submit = async (): Promise<void> => {
    if (img === null || busy) return
    setBusy(true)
    setFailed(null)
    try {
      const [canvas, ctx] = newCanvas(outW, outH)
      // 缩小时开高质量重采样，否则边缘会出锯齿
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, 0, 0, outW, outH)
      const row = await saveLocal(await toPng(canvas), 'resize', asset.id, `缩放到 ${pct}%（${outW}×${outH}）`)
      if (!alive.current) return
      onDone({ assets: [row], kind: 'local', action: 'resize' })
    } catch (err) {
      if (alive.current) setFailed(readError(err, '缩放失败'))
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  return (
    <>
      <div className="sced-main">
        <div className="sced-stage" ref={setBox}>
          {error !== null ? <p className="sced-msg sced-msg-bad">{error}</p> : null}
          {error === null && img === null ? <p className="sced-msg">图片加载中…</p> : null}
          {img !== null ? (
            <div className="sced-plate" style={{ left: view.x, top: view.y, width: view.w, height: view.h }}>
              <img src={img.src} alt="" draggable={false} />
            </div>
          ) : null}
        </div>
      </div>

      <aside className="sced-side">
        <div className="sced-block">
          <span className="sced-label">常用倍数</span>
          <div className="sced-chips">
            {RESIZE_STEPS.map((step) => (
              <button
                key={step}
                className={Math.round(step * 100) === pct ? 'sced-chip sced-chip-on' : 'sced-chip'}
                disabled={busy}
                onClick={() => setPct(Math.round(step * 100))}
              >
                {Math.round(step * 100)}%
              </button>
            ))}
          </div>
          <p className="sced-note">只缩不放。</p>
        </div>

        <div className="sced-block">
          <span className="sced-label">自定义</span>
          <input
            className="sced-range"
            type="range"
            min={5}
            max={100}
            step={5}
            value={pct}
            disabled={busy}
            onChange={(e) => setPct(Number(e.target.value))}
          />
          <p className="sced-nums">{pct}%</p>
        </div>

        <div className="sced-block">
          <span className="sced-label">出来是多大</span>
          <p className="sced-nums">
            原图 {natW}×{natH}
            <br />
            缩后 {outW}×{outH}
            <br />
            像素量少 {saved}%
          </p>
          <p className="sced-note">
            上游没有超分模型（查过 13 个），所以这里不提供放大——拉伸只会更糊。
            要更大的图请重新出图时把画幅调大。
          </p>
        </div>

        <div className="sced-act">
          {failed !== null && <span className="sced-status">{failed}</span>}
          <button className="btn btn-primary" disabled={busy || img === null} onClick={() => void submit()}>
            {busy ? '处理中…' : '缩放并另存'}
          </button>
        </div>
      </aside>
    </>
  )
}

/* ==================== 画笔标注（浏览器内合成） ==================== */

interface Shape {
  tool: PenTool
  color: string
  width: number
  /** free 用整条轨迹，其它用起止两点 */
  points: { x: number; y: number }[]
  /** number 工具的序号 */
  index?: number
}

/** 直接在图上画标记，产出一张新图。
 *
 *  与遮罩的区别要说清楚：**遮罩是给模型看的**（涂白＝重画那块），
 *  **画笔是给人看的**（圈出来说事）。两者都在图上涂，去向完全不同——
 *  蓝本把它们并排放着不解释，第一次用很容易搞混。 */
function AnnotatePane({
  asset,
  onDone,
}: {
  asset: ImageAsset
  onDone: (result: CanvasEditorResult) => void
}): JSX.Element {
  const { img, error } = useImage(asset.full_url)
  const [setBox, box] = useBoxSize()
  const [tool, setTool] = useState<PenTool>('free')
  const [color, setColor] = useState<string>(PEN_COLORS[0])
  const [width, setWidth] = useState(6)
  const [shapes, setShapes] = useState<Shape[]>([])
  const [redo, setRedo] = useState<Shape[]>([])
  const [drawing, setDrawing] = useState<Shape | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const alive = useAlive()

  const natW = img?.naturalWidth ?? asset.width
  const natH = img?.naturalHeight ?? asset.height
  const view = layout(box, natW, natH, 22)
  const nextNumber = shapes.filter((sp) => sp.tool === 'number').length + 1

  /* 图形按**原图坐标**存，画的时候乘一个 scale。
     存显示坐标的话，窗口一改大小所有标记就整体错位。 */
  const paint = useCallback((ctx: CanvasRenderingContext2D, list: Shape[], scale: number): void => {
    for (const sp of list) {
      const pts = sp.points
      if (pts.length === 0) continue
      ctx.strokeStyle = sp.color
      ctx.fillStyle = sp.color
      ctx.lineWidth = Math.max(1, sp.width * scale)
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      const a = { x: pts[0].x * scale, y: pts[0].y * scale }
      const b = { x: pts[pts.length - 1].x * scale, y: pts[pts.length - 1].y * scale }
      if (sp.tool === 'free') {
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        for (const pt of pts.slice(1)) ctx.lineTo(pt.x * scale, pt.y * scale)
        ctx.stroke()
      } else if (sp.tool === 'rect') {
        ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y))
      } else if (sp.tool === 'ellipse') {
        ctx.beginPath()
        ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2)
        ctx.stroke()
      } else if (sp.tool === 'arrow') {
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
        // 两翼跟着线段方向转，长度按线宽走——缩放后箭头比例才不变
        const ang = Math.atan2(b.y - a.y, b.x - a.x)
        const head = Math.max(10, sp.width * scale * 2.6)
        ctx.beginPath()
        ctx.moveTo(b.x, b.y)
        ctx.lineTo(b.x - head * Math.cos(ang - Math.PI / 7), b.y - head * Math.sin(ang - Math.PI / 7))
        ctx.moveTo(b.x, b.y)
        ctx.lineTo(b.x - head * Math.cos(ang + Math.PI / 7), b.y - head * Math.sin(ang + Math.PI / 7))
        ctx.stroke()
      } else {
        const r = Math.max(12, sp.width * scale * 2.4)
        ctx.beginPath()
        ctx.arc(a.x, a.y, r, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = sp.color === '#ffffff' ? '#111827' : '#ffffff'
        ctx.font = `700 ${Math.round(r * 1.15)}px ui-sans-serif, system-ui, sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(String(sp.index ?? 1), a.x, a.y + r * 0.04)
      }
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null || img === null) return
    canvas.width = Math.max(1, Math.round(view.w))
    canvas.height = Math.max(1, Math.round(view.h))
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    paint(ctx, drawing === null ? shapes : [...shapes, drawing], view.scale)
  }, [shapes, drawing, view.w, view.h, view.scale, img, paint])

  const toNat = (e: ReactPointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: (e.clientX - r.left) / view.scale, y: (e.clientY - r.top) / view.scale }
  }

  /* 先读后写，**不要在 updater 里调另一个 setState**：React 18 会在渲染阶段
     重跑 updater，严格模式下跑两次，于是一次撤销往 redo 栈里压两份
     （本仓已记过这条坑，这里是同一族）。 */
  const undo = useCallback((): void => {
    const last = shapes[shapes.length - 1]
    if (last === undefined) return
    setShapes((p) => p.slice(0, -1))
    setRedo((r) => [...r, last])
  }, [shapes])

  const redoOne = useCallback((): void => {
    const last = redo[redo.length - 1]
    if (last === undefined) return
    setRedo((p) => p.slice(0, -1))
    setShapes((sp) => [...sp, last])
  }, [redo])

  /* 报给弹窗顶层，⌘Z / ⌘⇧Z 就能用了。
     api 用 useMemo 定住引用，否则每次渲染都重新注册一遍。 */
  const undoApi = useMemo(
    () => ({ undo, redo: redoOne, canUndo: shapes.length > 0, canRedo: redo.length > 0 }),
    [undo, redoOne, shapes.length, redo.length],
  )
  useRegisterUndo(undoApi)

  const submit = async (): Promise<void> => {
    if (img === null || busy || shapes.length === 0) return
    setBusy(true)
    setFailed(null)
    try {
      const k = fitScale(natW, natH)
      const [canvas, ctx] = newCanvas(Math.round(natW * k), Math.round(natH * k))
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      paint(ctx, shapes, k)
      const row = await saveLocal(await toPng(canvas), 'annotate', asset.id, `画笔标注 ${shapes.length} 处`)
      if (!alive.current) return
      onDone({ assets: [row], kind: 'local', action: 'annotate' })
    } catch (err) {
      if (alive.current) setFailed(readError(err, '标注保存失败'))
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  return (
    <>
      <div className="sced-main">
        <div className="sced-stage" ref={setBox}>
          {error !== null ? <p className="sced-msg sced-msg-bad">{error}</p> : null}
          {error === null && img === null ? <p className="sced-msg">图片加载中…</p> : null}
          {img !== null ? (
            <div className="sced-plate" style={{ left: view.x, top: view.y, width: view.w, height: view.h }}>
              <img src={img.src} alt="" draggable={false} />
              <canvas
                ref={canvasRef}
                className="sced-draw"
                onPointerDown={(e) => {
                  capturePointer(e.currentTarget, e.pointerId)
                  const pt = toNat(e)
                  if (tool === 'number') {
                    // 序号是「点一下放一个」，不用拖
                    setShapes((prev) => [...prev, { tool, color, width, points: [pt], index: nextNumber }])
                    setRedo([])
                    return
                  }
                  setDrawing({ tool, color, width, points: [pt] })
                }}
                onPointerMove={(e) => {
                  if (drawing === null) return
                  const pt = toNat(e)
                  setDrawing((d) =>
                    d === null ? null : { ...d, points: d.tool === 'free' ? [...d.points, pt] : [d.points[0], pt] },
                  )
                }}
                onPointerUp={(e) => {
                  releasePointer(e.currentTarget, e.pointerId)
                  if (drawing === null) return
                  // 点一下没拖的形状不留：会变成一个看不见的零尺寸图形
                  const keep = drawing.tool === 'free' ? drawing.points.length > 1 : drawing.points.length === 2
                  if (keep) {
                    setShapes((prev) => [...prev, drawing])
                    setRedo([])
                  }
                  setDrawing(null)
                }}
              />
            </div>
          ) : null}
        </div>
      </div>

      <aside className="sced-side">
        <div className="sced-block">
          <span className="sced-label">工具</span>
          <div className="sced-chips">
            {PEN_TOOLS.map((t) => (
              <button
                key={t.key}
                className={t.key === tool ? 'sced-chip sced-chip-on' : 'sced-chip'}
                title={t.hint}
                disabled={busy}
                onClick={() => setTool(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <p className="sced-note">{PEN_TOOLS.find((t) => t.key === tool)?.hint}</p>
        </div>

        <div className="sced-block">
          <span className="sced-label">颜色</span>
          <div className="sced-chips">
            {PEN_COLORS.map((c) => (
              <button
                key={c}
                className={c === color ? 'sced-swatch sced-swatch-on' : 'sced-swatch'}
                style={{ background: c }}
                title={c}
                aria-label={`颜色 ${c}`}
                disabled={busy}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
        </div>

        <div className="sced-block">
          <span className="sced-label">粗细</span>
          <input
            className="sced-range"
            type="range"
            min={2}
            max={28}
            value={width}
            disabled={busy}
            onChange={(e) => setWidth(Number(e.target.value))}
          />
          <p className="sced-nums">{width} px</p>
        </div>

        <div className="sced-block">
          <span className="sced-label">已画 {shapes.length} 处</span>
          <div className="sced-chips">
            <button className="sced-chip" disabled={shapes.length === 0 || busy} onClick={undo}>
              撤销
            </button>
            <button
              className="sced-chip"
              disabled={redo.length === 0 || busy}
              onClick={redoOne}
            >
              重做
            </button>
            <button
              className="sced-chip"
              disabled={shapes.length === 0 || busy}
              onClick={() => {
                setShapes([])
                setRedo([])
              }}
            >
              清空
            </button>
          </div>
          <p className="sced-note">
            画的是给人看的标记，不会送给模型。要让模型改哪一块，用「遮罩重绘」。
          </p>
        </div>

        <div className="sced-act">
          {failed !== null && <span className="sced-status">{failed}</span>}
          <button className="btn btn-primary" disabled={shapes.length === 0 || busy} onClick={() => void submit()}>
            {busy ? '保存中…' : `保存标注（${shapes.length} 处）`}
          </button>
        </div>
      </aside>
    </>
  )
}

function SplitPane({
  asset,
  onDone,
}: {
  asset: ImageAsset
  onDone: (result: CanvasEditorResult) => void
}): JSX.Element {
  const { img, error } = useImage(asset.full_url)
  const [setBox, box] = useBoxSize()
  /* 切割线是**状态**而不是从行列数算出来的：只有这样才能手动拖。
     等分按钮只是往这里写一组等分值，之后每条线各自可以拖走。 */
  const [cuts, setCuts] = useState<Cuts>({ xs: evenCuts(2), ys: evenCuts(2) })
  const [gap, setGap] = useState(0)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** 正在拖第几条线。拖动中每帧都在改，落地才入撤销栈 */
  const dragCut = useRef<{ axis: 'x' | 'y'; index: number } | null>(null)

  useRegisterUndo(
    useUndoOf(
      `${cuts.xs.join(',')}|${cuts.ys.join(',')}|${gap}`,
      { cuts, gap },
      useCallback((v: { cuts: Cuts; gap: number }) => {
        setCuts(v.cuts)
        setGap(v.gap)
      }, []),
    ),
  )
  const alive = useAlive()

  const natW = img?.naturalWidth ?? asset.width
  const natH = img?.naturalHeight ?? asset.height
  const view = layout(box, natW, natH, 22)
  const rects = useMemo(() => splitRects(natW, natH, cuts, gap), [natW, natH, cuts, gap])
  const total = rects.length
  const cellW = total > 0 ? rects[0].w : natW
  const cellH = total > 0 ? rects[0].h : natH

  /** 在舞台上按下：命中一条线就开始拖，双击则删掉它。
   *
   *  **删线必须做在这里而不是线的 span 上**：按下时已经 `capturePointer` 到舞台，
   *  之后的 dblclick 会派发给捕获目标（舞台），span 上挂的 onDoubleClick 收不到——
   *  表现为「双击删线没反应」。 */
  const onPlate = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (busy || e.button !== 0) return
    const r = e.currentTarget.getBoundingClientRect()
    const fx = (e.clientX - r.left) / Math.max(1, r.width)
    const fy = (e.clientY - r.top) / Math.max(1, r.height)
    // 命中已有的线（8px 容差，换算成相对值）
    const tolX = 8 / Math.max(1, r.width)
    const tolY = 8 / Math.max(1, r.height)
    const hitX = cuts.xs.findIndex((v) => Math.abs(v - fx) < tolX)
    const hitY = cuts.ys.findIndex((v) => Math.abs(v - fy) < tolY)
    if (hitX < 0 && hitY < 0) return

    if (e.detail >= 2) {
      const axis = hitX >= 0 ? 'xs' : 'ys'
      const index = hitX >= 0 ? hitX : hitY
      setCuts((p) => ({ ...p, [axis]: p[axis].filter((_, k) => k !== index) }))
      dragCut.current = null
      return
    }
    dragCut.current = hitX >= 0 ? { axis: 'x', index: hitX } : { axis: 'y', index: hitY }
    capturePointer(e.currentTarget, e.pointerId)
  }

  const onPlateMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = dragCut.current
    if (d === null) return
    const r = e.currentTarget.getBoundingClientRect()
    const f = d.axis === 'x'
      ? (e.clientX - r.left) / Math.max(1, r.width)
      : (e.clientY - r.top) / Math.max(1, r.height)
    setCuts((prev) => {
      const axis = d.axis === 'x' ? 'xs' : 'ys'
      const next = [...prev[axis]]
      next[d.index] = Math.min(0.99, Math.max(0.01, f))
      return { ...prev, [axis]: next }
    })
  }

  const onPlateUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragCut.current === null) return
    releasePointer(e.currentTarget, e.pointerId)
    dragCut.current = null
    // 拖完排一次序：拖过头会让线的顺序乱掉，之后按 index 定位就错位了
    setCuts((prev) => ({ xs: normalizeCuts(prev.xs), ys: normalizeCuts(prev.ys) }))
  }

  const submit = async (): Promise<void> => {
    if (img === null || busy) return
    setBusy(true)
    const saved: ImageAsset[] = []
    try {
      for (const rect of rects) {
        const k = fitScale(rect.w, rect.h)
        const [canvas, ctx] = newCanvas(rect.w * k, rect.h * k)
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, canvas.width, canvas.height)
        setStatus(`正在切第 ${saved.length + 1}/${total} 张…`)
        saved.push(
          await saveLocal(
            await toPng(canvas),
            'split',
            asset.id,
            `宫格切分，第 ${rect.row} 行第 ${rect.col} 列`,
          ),
        )
      }
      if (!alive.current) return
      onDone({ assets: saved, kind: 'local', action: 'split' })
    } catch (e) {
      if (!alive.current) return
      const detail = readError(e, '切分失败')
      // 已经存进去的那几张是真进了资产库，照实报出来，也照样带回节点
      toast.error(saved.length > 0 ? `切到第 ${saved.length + 1} 张时失败：${detail}（前 ${saved.length} 张已入库）` : detail)
      if (saved.length > 0) onDone({ assets: saved, kind: 'local', action: 'split' })
    } finally {
      if (alive.current) {
        setBusy(false)
        setStatus(null)
      }
    }
  }

  return (
    <>
      <div className="sced-main">
        <div className="sced-stage" ref={setBox}>
          {error !== null ? <p className="sced-msg sced-msg-bad">{error}</p> : null}
          {error === null && img === null ? <p className="sced-msg">图片加载中…</p> : null}
          {img !== null ? (
            <div
              className="sced-plate sced-plate-cuts"
              style={{ left: view.x, top: view.y, width: view.w, height: view.h }}
              onPointerDown={onPlate}
              onPointerMove={onPlateMove}
              onPointerUp={onPlateUp}
              onPointerCancel={onPlateUp}
            >
              <img src={img.src} alt="" draggable={false} />
              {/* 每格描一个框：有 gap 时能直观看出缝隙留了多少 */}
              {rects.map((rc) => (
                <span
                  key={`c${rc.row}-${rc.col}`}
                  className="sced-slice"
                  style={{
                    left: `${(rc.x / natW) * 100}%`,
                    top: `${(rc.y / natH) * 100}%`,
                    width: `${(rc.w / natW) * 100}%`,
                    height: `${(rc.h / natH) * 100}%`,
                  }}
                />
              ))}
              {cuts.xs.map((v, i) => (
                <span
                  key={`v${i}`}
                  className="sced-line sced-line-v"
                  style={{ left: `${v * 100}%` }}
                  title="拖动调整位置，双击删掉这条线"
                />
              ))}
              {cuts.ys.map((v, i) => (
                <span
                  key={`h${i}`}
                  className="sced-line sced-line-h"
                  style={{ top: `${v * 100}%` }}
                  title="拖动调整位置，双击删掉这条线"
                />
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <aside className="sced-side">
        <div className="sced-block">
          <span className="sced-label">等分</span>
          <div className="sced-chips">
            {SPLIT_PRESETS.map((preset) => {
              const on =
                cuts.xs.length === preset.cols - 1 &&
                cuts.ys.length === preset.rows - 1 &&
                cuts.xs.every((v, i) => Math.abs(v - (i + 1) / preset.cols) < 0.001) &&
                cuts.ys.every((v, i) => Math.abs(v - (i + 1) / preset.rows) < 0.001)
              return (
                <button
                  key={preset.key}
                  className={on ? 'sced-chip sced-chip-on' : 'sced-chip'}
                  disabled={busy}
                  onClick={() => setCuts({ xs: evenCuts(preset.cols), ys: evenCuts(preset.rows) })}
                >
                  {preset.label}
                </button>
              )
            })}
          </div>
          <p className="sced-note">
            标的是「列 × 行」。点完等分之后，<b>每条线还能在图上单独拖</b>——
            不是所有图都该均匀切。
          </p>
        </div>

        <div className="sced-block">
          <span className="sced-label">切割线</span>
          <div className="sced-chips">
            <button
              className="sced-chip"
              disabled={busy}
              onClick={() => setCuts((p) => ({ ...p, xs: normalizeCuts([...p.xs, nextCut(p.xs)]) }))}
            >
              加一条竖线
            </button>
            <button
              className="sced-chip"
              disabled={busy}
              onClick={() => setCuts((p) => ({ ...p, ys: normalizeCuts([...p.ys, nextCut(p.ys)]) }))}
            >
              加一条横线
            </button>
            <button
              className="sced-chip"
              disabled={busy || (cuts.xs.length === 0 && cuts.ys.length === 0)}
              onClick={() => setCuts({ xs: [], ys: [] })}
            >
              全清
            </button>
          </div>
          <p className="sced-note">
            竖线 {cuts.xs.length} 条 · 横线 {cuts.ys.length} 条。图上双击一条线可以删掉它。
          </p>
        </div>

        <div className="sced-block">
          <span className="sced-label">间隔</span>
          <label className="sced-numbox">
            <input
              className="sced-num"
              type="number"
              min={0}
              max={200}
              value={gap}
              disabled={busy}
              onChange={(e) => setGap(clamp(Math.round(Number(e.target.value) || 0), 0, 200))}
            />
            px
          </label>
          <p className="sced-note">
            从切割线<b>两侧各扣一半</b>，于是相邻两格之间正好空出这么多像素；
            最外圈不扣，四周不会凭空少一圈。
          </p>
        </div>

        <div className="sced-block">
          <span className="sced-label">切出来是什么</span>
          <p className="sced-nums">
            原图 {natW}×{natH}
            <br />
            每格约 {cellW}×{cellH}
            <br />
            共 {total} 张
          </p>
          <p className="sced-note">除不尽的余数分摊到各格，最多差 1 像素。导出为 PNG（无损）。</p>
          {total === 1 ? (
            <p className="sced-note">一条线都没有等于没切，存出来只是原图的一份 PNG 副本。</p>
          ) : null}
        </div>

        <div className="sced-act">
          {status !== null && <span className="sced-status">{status}</span>}
          <button className="btn btn-primary" disabled={busy || img === null} onClick={() => void submit()}>
            {busy ? '处理中…' : `切成 ${total} 张`}
          </button>
        </div>
      </aside>
    </>
  )
}

/* ==================== 宫格拼接 ==================== */

/** 排版单位下每格的长边上限（蓝本 `gridJoinBaseCellSize` 里的 420）。
 *  先按这个单位把版排好，导出时整体乘一个倍数放到目标长边——
 *  排版和分辨率分开，改列数/改间距不必重新算清晰度。 */
const JOIN_CELL_LIMIT = 420

/** 成品长边可选档。蓝本默认 2048，这里沿用 */
const JOIN_LONG_STEPS = [1024, 2048, 4096]

/** 把一张图画进一格。
 *  `contain` 完整放入、四周留白（不裁掉任何内容）；
 *  `cover` 裁掉溢出的部分铺满整格（蓝本 `drawImageCover` 的做法，排出来最整齐）。 */
function drawInCell(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number,
  fit: 'contain' | 'cover',
): void {
  const iw = Math.max(1, img.naturalWidth)
  const ih = Math.max(1, img.naturalHeight)
  if (fit === 'cover') {
    // 从原图里裁一块与格子同比例的居中区域，再铺满整格
    const k = Math.max(w / iw, h / ih)
    const sw = Math.min(iw, w / k)
    const sh = Math.min(ih, h / k)
    ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h)
    return
  }
  const k = Math.min(w / iw, h / ih)
  const dw = iw * k
  const dh = ih * k
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh)
}

/** 宫格拼接（蓝本 `smart-canvas.js` 的 `gridJoin*` 一族）。
 *
 *  和「等分拼一下」的区别在于**每一格都能拖**：按住一张拖到另一张头上，两张换位。
 *  蓝本的落点判据（落进去优先、其次按中心距离，阈值取两格尺寸最大值的 0.55 倍）
 *  一并翻译过来，见 `canvas-editor-math.joinDropTarget`。
 *
 *  数据源可以是单个节点的多张图，也可以是整个分组——调用方通过
 *  `CanvasEditorOpen.items` 把哪一组图交进来，这里不关心它们从哪来。 */
function JoinPane({
  asset,
  items,
  scope,
  onDone,
}: {
  /** 当前那张。只用来当产物的 parent_id，排版里它没有特殊地位 */
  asset: ImageAsset
  /** 可参与拼接的全部图（含当前张） */
  items: ImageAsset[]
  scope: 'node' | 'group'
  onDone: (result: CanvasEditorResult) => void
}): JSX.Element {
  const [setBox, box] = useBoxSize()
  /** 参与拼接的图，**数组顺序就是排布顺序**。拖拽换位改的就是它 */
  const [order, setOrder] = useState<number[]>(() => items.map((a) => a.id))
  const [cols, setCols] = useState(() => joinAutoDims(items.length).cols)
  const [gap, setGap] = useState(8)
  const [white, setWhite] = useState(true)
  const [fit, setFit] = useState<'contain' | 'cover'>('contain')
  const [longEdge, setLongEdge] = useState(2048)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [imgs, setImgs] = useState<Map<number, HTMLImageElement>>(new Map())
  const alive = useAlive()

  // 选了哪几张、什么顺序、几列、多少缝、什么底、多大——都算一步可撤的操作
  useRegisterUndo(
    useUndoOf(
      `${order.join(',')}|${cols}|${gap}|${white}|${fit}|${longEdge}`,
      { order, cols, gap, white, fit, longEdge },
      useCallback(
        (v: {
          order: number[]
          cols: number
          gap: number
          white: boolean
          fit: 'contain' | 'cover'
          longEdge: number
        }) => {
          setOrder(v.order)
          setCols(v.cols)
          setGap(v.gap)
          setWhite(v.white)
          setFit(v.fit)
          setLongEdge(v.longEdge)
        },
        [],
      ),
    ),
  )

  /* 排版只要宽高，而宽高资产行里就有——**不必等图片下载完**。
     等下载的话，二十张图的分组要黑屏好几秒才看得到版式。 */
  const sizes = useMemo(() => items.map((a) => ({ id: a.id, w: a.width, h: a.height })), [items])
  const byId = useMemo(() => new Map(items.map((a) => [a.id, a])), [items])

  const layout: JoinLayout = useMemo(
    () => buildJoinLayout(order, sizes, cols, gap, JOIN_CELL_LIMIT),
    [order, sizes, cols, gap],
  )
  const size = useMemo(() => joinCanvasSize(layout), [layout])
  /** 目标长边算出来的倍数，与被物理上限压过之后的倍数。两者不等就说明撞线了 */
  const wantScale = longEdge / Math.max(1, Math.max(size.w, size.h))
  const outScale = joinOutputScale(size, longEdge, MAX_JOIN_EDGE, MAX_JOIN_AREA)
  const capped = outScale < wantScale - 1e-9
  const outW = Math.max(1, Math.round(size.w * outScale))
  const outH = Math.max(1, Math.round(size.h * outScale))
  const picked = layout.items.length

  /* 原图按需下载：导出要的是 full_url 且必须带 crossOrigin（晚一步设浏览器已按
     无凭证模式发出请求，图能显示但画布判定为污染，导出时才炸）。
     预览用的是资产行里的展示图，不等这一步。 */
  const poolKey = items.map((a) => a.id).join(',')
  useEffect(() => {
    let live = true
    void (async () => {
      const next = new Map<number, HTMLImageElement>()
      for (const a of items) {
        try {
          next.set(a.id, await loadImage(a.full_url))
        } catch (e) {
          if (live) setError(readError(e, `资产 #${a.id} 的原图取不到`))
          return
        }
        if (!live) return
      }
      if (live) {
        setError(null)
        setImgs(next)
      }
    })()
    return () => {
      live = false
    }
    // items 每次渲染都是新数组，依赖用 id 串
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poolKey])

  /* ---- 预览板：缩放比由容器实测尺寸反推 ---- */

  const z = Math.max(0.02, Math.min((box.w - 40) / Math.max(1, size.w), (box.h - 40) / Math.max(1, size.h), 1))
  const boardW = size.w * z
  const boardH = size.h * z

  /** 正在拖哪一格、拖了多远（**布局单位**，不是屏幕像素） */
  const [dragging, setDragging] = useState<{ id: number; dx: number; dy: number } | null>(null)
  const dragRef = useRef<{ id: number; sx: number; sy: number; z: number } | null>(null)
  const dropId = dragging === null ? null : joinDropTarget(layout, dragging.id, dragging.dx, dragging.dy)

  const endDrag = (): void => {
    const d = dragRef.current
    const live = dragging
    dragRef.current = null
    setDragging(null)
    if (d === null || live === null) return
    const target = joinDropTarget(layout, live.id, live.dx, live.dy)
    if (target !== null) setOrder((prev) => swapInOrder(prev, live.id, target))
  }

  const toggle = (id: number): void => {
    setOrder((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const submit = async (): Promise<void> => {
    if (busy || picked < 2) return
    setBusy(true)
    setStatus('正在合成…')
    try {
      const [canvas, ctx] = newCanvas(outW, outH)
      ctx.imageSmoothingQuality = 'high'
      if (white) {
        // 画布里的白底是**图像数据**不是界面样式，所以这里写死色值
        ctx.fillStyle = '#FFFFFF'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
      }
      for (const cell of layout.items) {
        const el = imgs.get(cell.id)
        if (el === undefined) throw new Error(`资产 #${cell.id} 的原图还没取到，稍等一下再拼`)
        drawInCell(
          ctx,
          el,
          cell.x * outScale,
          cell.y * outScale,
          cell.w * outScale,
          cell.h * outScale,
          fit,
        )
      }
      setStatus('正在入库…')
      const note = `宫格拼接：资产 ${layout.items.map((c) => c.id).join(' + ')}，${layout.cols} 列 ${layout.rows} 行，间距 ${gap}，${white ? '白底' : '透明底'}，${fit === 'cover' ? '裁切铺满' : '完整放入'}`
      const row = await saveLocal(await toPng(canvas), 'join', asset.id, note)
      if (!alive.current) return
      onDone({ assets: [row], kind: 'local', action: 'join' })
    } catch (e) {
      if (alive.current) toast.error(readError(e, '拼接失败'))
    } finally {
      if (alive.current) {
        setBusy(false)
        setStatus(null)
      }
    }
  }

  return (
    <>
      <div className="sced-main">
        <div className="sced-tools">
          <span className="sced-toolnote">行列</span>
          {Array.from({ length: Math.max(1, Math.min(6, picked)) }, (_, i) => i + 1).map((c) => (
            <button
              key={c}
              className={layout.cols === c ? 'sced-chip sced-chip-on' : 'sced-chip'}
              disabled={busy}
              title={`排成 ${c} 列`}
              onClick={() => setCols(c)}
            >
              {c} 列
            </button>
          ))}
          <button
            className="sced-chip"
            disabled={busy}
            title="按张数自动选一个接近正方形的行列数"
            onClick={() => setCols(joinAutoDims(picked).cols)}
          >
            自动
          </button>
          <span className="sced-toolgap" />
          <span className="sced-toolnote">
            {layout.cols} 列 × {layout.rows} 行 · 拖动格子可以换位
          </span>
        </div>

        <div className="sced-stage" ref={setBox}>
          {error !== null ? <p className="sced-msg sced-msg-bad">{error}</p> : null}
          {picked === 0 ? <p className="sced-msg">右边至少勾两张图才能拼。</p> : null}
          {picked > 0 && error === null ? (
            <div
              className={white ? 'sced-joinboard' : 'sced-joinboard sced-joinboard-alpha'}
              style={{
                left: (box.w - boardW) / 2,
                top: (box.h - boardH) / 2,
                width: boardW,
                height: boardH,
                ...(white ? { background: '#FFFFFF' } : {}),
              }}
            >
              {layout.items.map((cell, at) => {
                const item = byId.get(cell.id)
                if (item === undefined) return null
                const moving = dragging !== null && dragging.id === cell.id
                const isDrop = dropId === cell.id
                return (
                  <div
                    key={cell.id}
                    className={
                      moving
                        ? 'sced-tile sced-tile-moving'
                        : isDrop
                          ? 'sced-tile sced-tile-drop'
                          : 'sced-tile'
                    }
                    title={`资产 #${cell.id}（第 ${cell.row} 行第 ${cell.col} 列，拖到另一格上换位）`}
                    style={{
                      left: cell.x * z,
                      top: cell.y * z,
                      width: cell.w * z,
                      height: cell.h * z,
                      transform: moving ? `translate(${dragging.dx * z}px, ${dragging.dy * z}px)` : undefined,
                    }}
                    onPointerDown={(e) => {
                      if (busy || e.button !== 0) return
                      e.preventDefault()
                      capturePointer(e.currentTarget, e.pointerId)
                      dragRef.current = { id: cell.id, sx: e.clientX, sy: e.clientY, z }
                      setDragging({ id: cell.id, dx: 0, dy: 0 })
                    }}
                    onPointerMove={(e) => {
                      const d = dragRef.current
                      if (d === null || d.id !== cell.id) return
                      setDragging({
                        id: cell.id,
                        dx: (e.clientX - d.sx) / d.z,
                        dy: (e.clientY - d.sy) / d.z,
                      })
                    }}
                    onPointerUp={(e) => {
                      releasePointer(e.currentTarget, e.pointerId)
                      endDrag()
                    }}
                    onPointerCancel={endDrag}
                  >
                    <img
                      src={item.url}
                      alt=""
                      draggable={false}
                      style={{ objectFit: fit === 'cover' ? 'cover' : 'contain' }}
                    />
                    <em className="sced-ord">{at + 1}</em>
                  </div>
                )
              })}
            </div>
          ) : null}
        </div>
      </div>

      <aside className="sced-side">
        <div className="sced-block">
          <span className="sced-label">
            参与拼接（{picked}/{items.length}）
          </span>
          <div className="sced-pick">
            {items.map((it) => {
              const at = order.indexOf(it.id)
              return (
                <button
                  key={it.id}
                  className={at >= 0 ? 'sced-cell sced-cell-on' : 'sced-cell'}
                  title={at >= 0 ? `资产 #${it.id}（第 ${at + 1} 格，点一下移出）` : `资产 #${it.id}（点一下加进来）`}
                  disabled={busy}
                  onClick={() => toggle(it.id)}
                >
                  <img src={it.thumb_url} alt="" />
                  {at >= 0 ? <em className="sced-ord">{at + 1}</em> : null}
                </button>
              )
            })}
          </div>
          <div className="sced-chips">
            <button className="sced-chip" disabled={busy} onClick={() => setOrder(items.map((a) => a.id))}>
              全选
            </button>
            <button className="sced-chip" disabled={busy || picked === 0} onClick={() => setOrder([])}>
              全不选
            </button>
          </div>
          <p className="sced-note">
            角标是排布顺序。顺序在左边的画板上拖着改——把一张拖到另一张头上，两张换位。
            {scope === 'group' ? '这一组来自整个分组。' : ''}
          </p>
        </div>

        <div className="sced-block">
          <span className="sced-label">间距 {gap}px</span>
          <input
            className="sced-range"
            type="range"
            min={0}
            max={64}
            step={2}
            value={gap}
            disabled={busy}
            onChange={(e) => setGap(Number(e.target.value))}
          />
        </div>

        <div className="sced-block">
          <span className="sced-label">格内怎么放</span>
          <div className="seg">
            <button className={fit === 'contain' ? 'active' : ''} disabled={busy} onClick={() => setFit('contain')}>
              完整放入
            </button>
            <button className={fit === 'cover' ? 'active' : ''} disabled={busy} onClick={() => setFit('cover')}>
              裁切铺满
            </button>
          </div>
          <p className="sced-note">
            格子按所有图里最大的宽高定。比例不一致时，「完整放入」留白但一个像素不丢，
            「裁切铺满」齐整但会切掉边角。
          </p>
        </div>

        <div className="sced-block">
          <span className="sced-label">底色</span>
          <div className="seg">
            <button className={white ? 'active' : ''} disabled={busy} onClick={() => setWhite(true)}>
              白
            </button>
            <button className={white ? '' : 'active'} disabled={busy} onClick={() => setWhite(false)}>
              透明
            </button>
          </div>
          <p className="sced-note">间距与留白用这个底色填。透明底存为带 alpha 的 PNG。</p>
        </div>

        <div className="sced-block">
          <span className="sced-label">成品长边</span>
          <div className="sced-chips">
            {JOIN_LONG_STEPS.map((n) => (
              <button
                key={n}
                className={longEdge === n ? 'sced-chip sced-chip-on' : 'sced-chip'}
                disabled={busy}
                onClick={() => setLongEdge(n)}
              >
                {n}
              </button>
            ))}
          </div>
          <p className="sced-nums">
            成品 {outW}×{outH}
          </p>
          {capped ? (
            <p className="sced-note">
              长边 {MAX_JOIN_EDGE}px、总面积 1600 万像素两条线里更紧的那条压住了目标长边——
              超过这个体量，浏览器会整张返回空白而且不报错。
            </p>
          ) : null}
        </div>

        <div className="sced-act">
          <span className={picked < 2 ? 'sced-status sced-status-bad' : 'sced-status'}>
            {picked < 2 ? '至少要两张，右边再勾一张' : (status ?? '')}
          </span>
          <button
            className="btn btn-primary"
            disabled={busy || picked < 2 || error !== null || imgs.size < items.length}
            title={imgs.size < items.length ? '原图还在下载，稍等一下' : undefined}
            onClick={() => void submit()}
          >
            {busy ? '处理中…' : `拼接 ${picked} 张并保存`}
          </button>
        </div>
      </aside>
    </>
  )
}
