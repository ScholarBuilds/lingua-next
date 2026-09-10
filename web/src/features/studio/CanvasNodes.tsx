/* 画布自定义节点（FR-461）：image 图网格 · video 视频 · prompt 文本域 · loop 轮次控制 ·
   group 组内网格。

   图一律引用资产 URL 渲染，<img src> 必须带 /api 前缀——没前缀会打到 vite
   dev server 拿回 index.html，图静默裂掉（仓里踩过的坑）。 */

import { useQuery } from '@tanstack/react-query'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import { memo, useEffect, useReducer, useRef, useState } from 'react'

import {
  Clapperboard,
  Copy,
  ImagePlus,
  MessageSquareText,
  Play,
  Send,
  Sparkles,
  X,
} from '@/components/NexusIcon'
import { toast } from 'sonner'

import { IconDownload, IconFileText, IconSpeaker, IconTask } from '../../components/icons'
import { apiConfig } from '../../lib/api-config'
import { apiStudio } from '../../lib/api-studio'
import type { CanvasItem } from '../../lib/api-studio'
import {
  GROUP_CELL,
  CASCADE_POOL_DEFAULT,
  CASCADE_POOL_MAX,
  LOOP_MAX,
  boxForItems,
  cascadePlan,
  pendingAspect,
  extractItem,
  generateMidjourneyFrom,
  generateModelScopeFrom,
  groupSize,
  llmInputText,
  midjourneyActionLayout,
  MODELSCOPE_MAX_COUNT,
  MIDJOURNEY_MAX_REFS,
  refAssetIds,
  refMediaItems,
  removeFromGroup,
  retryCanvasImageTask,
  runCascade,
  runMidjourneyAction,
  useCanvasStore,
} from './canvasStore'
import type { LoopMode, ScvNode } from './canvasStore'
import { capturePointer, releasePointer, screenToCanvas } from './canvas-core'
import { FORM_FOCUS_SELECTOR, Picker } from '@/components/ui/picker'
import { GeneratorEnginePicker } from './CanvasGeneratorEngine'
import { CanvasCascadeAction } from './CanvasCascadeAction'
import {
  aspectStyle,
  gridCellAspect,
  gridColumns,
  itemAspect,
  itemSizes,
  itemSrcSet,
  rememberAspect,
} from './image-variants'
import { historyTitle, isHistoryNode, outputCaption, outputSummary } from './output-node-view'

export interface ScvNodeData extends Record<string, unknown> {
  node: ScvNode
  /** 非 null = 该节点正在生成，显示骨架/进度 */
  runLabel: string | null
  /** 缩得很远：图片换缩略图。由画布统一算好传下来——
      每个节点自己订阅缩放的话，缩放每一帧都会把全部节点重渲染一遍 */
  far?: boolean
  /** 打开画布编辑器（FR-466）。缺省 = 页面没提供入口，菜单整个不渲染 */
  onEdit?: (nodeId: string) => void
  /** 这一次生图是什么时候开始的。只在跑的时候有值，用来算已跑秒数 */
  runStartedAt?: number
  /** 放大档位（1 / 2 / 4），不是原始缩放值。
   *
   *  给 srcset 的 `sizes` 用：放大画布时要挑更大的图变体，否则越放大越糊，
   *  而那正是用户最想看清的时候。**量化成档位**是因为它进了 memo 比较——
   *  传原始 scale 的话缩放的每一帧都会把全部节点重渲染一遍，
   *  正是 `far` 那条注释在避的事。 */
  zoom?: number
  /** 双击节点打开编辑器或媒体大预览。
   *  `assetId` 是双击落点那一张——多图节点里不带的话永远只能打开第一张，
   *  九宫格节点上「点第 7 张想看大图，出来的是第 1 张」是很难自证的坑 */
  onOpen?: (nodeId: string, assetId?: number) => void
}

/** 缩到这个倍率以下就换缩略图：屏幕上还剩不到一半的像素，拉原图纯属浪费带宽和解码
    （FR-468「缩放时图片按视口远近懒切清晰度」） */
/** 节点视图的入参。内核不像 react-flow 那样往 data 里塞一堆运行态，
    只给节点它自己要显示的东西；选中态由外壳的 class 管（CSS 负责） */
export interface CanvasNodeViewProps {
  data: ScvNodeData
}

/** 缩到这个倍率以下就换缩略图：屏幕上还剩不到一半的像素，拉原图纯属浪费带宽和解码
    （FR-468）。判定在画布层做一次、结果当 `far` 传下来——每个节点自己订阅缩放的话，
    缩放的每一帧都会把全部节点重渲染一遍。 */
export const FAR_ZOOM = 0.5
const recentNodeClicks = new Map<string, number>()

/** 双击落在哪一张图上。多图节点的每张缩略图都带 `data-asset`，
 *  没命中（点的是标题、空白处）就返回 undefined，由调用方回落到第一张 */
export function hitAsset(event: ReactMouseEvent): number | undefined {
  const el = (event.target as HTMLElement).closest('[data-asset]')
  const raw = el?.getAttribute('data-asset')
  if (raw === null || raw === undefined) return undefined
  const id = Number(raw)
  return Number.isFinite(id) ? id : undefined
}

/** 订阅画布 store 派生出来的一段文字——血缘、归属这类要跨节点查的东西。
 *
 *  没写成 `useCanvasStore(selector)` 是因为 **zustand v5 在服务端渲染时走
 *  `getInitialState()`**：拿到的是模块加载那一刻的空画布，不是刚 setState 进去的
 *  那份。本仓的首帧冒烟测试跑在 react-dom/server 上（node 里没有 jsdom），
 *  用选择器写出来的文案在那里一个字都验不到——测试全绿，而画布上究竟画没画出来
 *  只能靠肉眼。这里首帧直接 `getState()` 算，两种环境读到的都是当前值。
 *
 *  **算出来的字没变就不重渲染**：store 每变一次（拖一下、跑一步、存一次）
 *  都重画全部输出节点的话，正是 `far`/`zoom` 那两条注释在避的事。 */
function useCanvasText(compute: () => string | null): string | null {
  const value = compute()
  const latest = useRef(value)
  latest.current = value
  const fn = useRef(compute)
  fn.current = compute
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(
    () =>
      useCanvasStore.subscribe(() => {
        if (fn.current() !== latest.current) bump()
      }),
    [],
  )
  return value
}

function openOnRepeatedClick(event: ReactMouseEvent, data: ScvNodeData, nodeId: string): void {
  // 点在交互部件上不算"点节点"。列表要含 Radix 的下拉部件——
  // 按标签判会漏掉 `<button role="combobox">` 这类（见 FORM_FOCUS_SELECTOR）
  if (
    (event.target as HTMLElement).closest(`a, audio, video, button, ${FORM_FOCUS_SELECTOR}`) !== null
  )
    return
  const asset = hitAsset(event)
  /* 单击就记下「现在看的是哪一张」。工具条上的裁剪/遮罩/下载都读它——
     那些按钮长在节点外壳上、不在缩略图里，点它们时已经没有落点信息了。 */
  if (asset !== undefined) useCanvasStore.getState().setSelectedItem({ nodeId, assetId: asset })
  if (event.detail >= 2) {
    recentNodeClicks.delete(nodeId)
    data.onOpen?.(nodeId, asset)
    return
  }
  const now = performance.now()
  const previous = recentNodeClicks.get(nodeId) ?? 0
  recentNodeClicks.set(nodeId, now)
  if (now - previous <= 420) {
    recentNodeClicks.delete(nodeId)
    data.onOpen?.(nodeId, asset)
  }
}

/** 节点角上的计时药丸：这一次跑了多少秒。
 *
 *  出图动辄十几秒到一分钟，只写「生成中」的话用户分不清**在跑**还是**卡住了**。
 *  蓝本在节点右上角常驻一个计时器，这里照抄。
 *
 *  实现上两点：
 *  - 一秒一跳就够，不用 rAF——rAF 每秒六十次重渲染一个只会变一次的数字；
 *  - 节点不在跑时整个不渲染，定时器也就不存在，不会有一堆空转的 interval。 */
function RunTimer({ startedAt }: { startedAt: number }): JSX.Element {
  const [now, setNow] = useState(() => performance.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(performance.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  const sec = Math.max(0, Math.round((now - startedAt) / 1000))
  const text = sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`
  return (
    <span className="scv-runtimer" title={`已跑 ${sec} 秒`}>
      {text}
    </span>
  )
}

/** items 只存 asset_id，渲染时按变体拼 URL；外部图直接用它带的 url */
export function itemSrc(it: CanvasItem, variant: 'display' | 'thumb' | 'full' = 'display'): string {
  if (it.asset_id !== undefined) return `/api/images/assets/${it.asset_id}/${variant}`
  return it.url ?? ''
}

/** 网格最多摆 8 张，多出来折叠成 +N——节点是画布上的缩影，不是看图器 */
const GRID_MAX = 8

function ItemGrid({
  items,
  far,
  current,
  hostId,
  width,
  scale,
}: {
  items: CanvasItem[]
  far: boolean
  current?: number
  hostId: string
  /** 节点在画布坐标里的宽度。srcset 的 sizes 要用 */
  width: number
  /** 画布缩放。放大时要挑更大的变体，否则越放大越糊 */
  scale: number
}) {
  /* 老画布的 item 上没存 w/h（若干条建 item 的路径只塞了 asset_id），
     比例只能等图落地时现量。量到就 bump 一次让节点重新定型——
     比例缓存在 image-variants 模块里，同一张图整个会话只量一次。 */
  const [, remeasured] = useState(0)
  const measure = (item: CanvasItem, el: HTMLImageElement): void => {
    if (rememberAspect(item, el.naturalWidth, el.naturalHeight)) remeasured((n) => n + 1)
  }

  if (items.length === 1) {
    const it = items[0]
    return (
      <div className="scv-grid">
        {it.missing === true ? (
          <div className="scv-missing-item"><ImagePlus /><span>文件缺失</span></div>
        ) : <img
          /* src 只是不支持 srcset 时的兜底；真正生效的是 srcset + sizes。
             far（缩得很小）时直接钉 thumb：那种视距下浏览器挑大图纯属浪费带宽 */
          src={itemSrc(it, far ? 'thumb' : 'display')}
          srcSet={far ? undefined : itemSrcSet(it)}
          sizes={far ? undefined : itemSizes(width, scale)}
          alt=""
          draggable={false}
          data-asset={it.asset_id}
          onLoad={(event) => measure(it, event.currentTarget)}
          /* 节点按图的真实长宽比定型：出的是什么比例，画布上就是什么比例。
             配 CSS 的 `object-fit: contain`——比例还没量到的那一瞬间是方框，
             那时也要让整张图看得见，而不是裁掉两头 */
          style={{ aspectRatio: aspectStyle(itemAspect(it)) }}
        />}
      </div>
    )
  }
  const shown = items.slice(0, GRID_MAX)
  const extra = items.length - shown.length
  /* 列数按**总张数**算，与 `boxForItems` → `mediaGridBox` 同源：节点宽度是按
     那边的列数给的预算，这里少摆一列格子就会被撑宽、多摆一列就会挤扁 */
  const columns = gridColumns(items.length)
  const cellAspect = gridCellAspect(items)
  return (
    <div
      className="scv-grid scv-many"
      /* minmax(0, 1fr) 而不是 1fr：`1fr` 的最小值是 min-content，
         图会把自己的列顶宽，网格跟着溢出节点 */
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {shown.map((it, i) => (
        /* 用与分组格子同一个组件：一次出 4 张时它们挤在一个节点里，
           想单独拿一张去当参考、去改、去删，都得先能拆出来。
           分组早就能拆了，多图节点当时漏了。 */
        <ItemCell
          key={it.asset_id ?? `${it.url}-${i}`}
          hostId={hostId}
          item={it}
          index={i}
          current={current}
          aspect={cellAspect}
          onMeasure={measure}
        />
      ))}
      {/* +N 也跟着格子的比例，否则最后一行会比前面矮一截 */}
      {extra > 0 && <div className="scv-more" style={{ aspectRatio: aspectStyle(cellAspect) }}>+{extra}</div>}
    </div>
  )
}

/* 100 节点画布上，任何一次选中变化或运行态变化都会让页面重建整份 rfNodes，
   data 全是新对象——不拦住的话 100 个节点跟着全部重渲染。
   真正决定这几个组件输出的只有 node 引用与 runLabel：选中态是 react-flow 加在外层
   wrapper 上的 class（CSS 管），onEdit 是页面的 setState（引用恒定）。 */
function sameNodeData(prev: CanvasNodeViewProps, next: CanvasNodeViewProps): boolean {
  const a = prev.data
  const b = next.data
  return (
    a.node === b.node &&
    a.runLabel === b.runLabel &&
    a.far === b.far &&
    a.zoom === b.zoom &&
    a.runStartedAt === b.runStartedAt
  )
}

function ImageNodeView({ data }: CanvasNodeViewProps) {
  const { node, runLabel } = data
  const far = data.far === true
  const items = node.items ?? []
  /* 当前看的是哪一张。工具条按它决定操作哪张，这里给它一个描边——
     不标出来的话用户点了第 3 张再点「裁剪」，无从判断编的是不是那一张 */
  const current = useCanvasStore((s) =>
    s.selectedItem?.nodeId === node.id ? s.selectedItem.assetId : undefined,
  )
  /* 历史节点的判定与文案都要读连线（`history_for` 字段是主、history 入边是备）。
     取的是**字符串**而不是对象：对象每次都判定"变了"，
     直接 Maximum update depth exceeded（本仓踩过） */
  const histTitle = useCanvasText(() => {
    const { nodes, connections } = useCanvasStore.getState()
    return isHistoryNode(node, connections) ? historyTitle(node, nodes, connections) : null
  })
  const isHistory = histTitle !== null
  const draft = (node.prompt_draft ?? '').trim()
  /* 选择器返回**数字**而不是对象：返回新对象的话每次 store 变化都判定"变了"，
     直接 Maximum update depth exceeded（本仓踩过） */
  const aspect = useCanvasStore((s) =>
    runLabel === null || items.length > 0 ? 1 : pendingAspect(s.nodes, s.connections, node.id),
  )
  return (
    <div
      className={`scv-node scv-image${isHistory ? ' scv-hist' : ''}`}
      onClickCapture={(event) => openOnRepeatedClick(event, data, node.id)}
      onDoubleClick={(event) => items.length > 0 && data.onOpen?.(node.id, hitAsset(event))}
    >
      {/* 标题显示**文件名**而不是「图片」两个字（蓝本 .image-name-badge 同款）：
          画布上十几个节点都写着「图片」等于没写，文件名才认得出是哪张。
          裸媒体节点里它由 canvas.css 定位成浮在图左上角的小徽标。
          历史节点写「<谁> 的旧图」——存的标题只有「历史」两个字，
          说不清用户刚才那张图去哪了。 */}
      <div className="scv-node-title">
        <span>
          {histTitle ??
            node.title ??
            items[0]?.name ??
            (items.length > 0 ? '未命名' : '空节点')}
        </span>
        {items.length > 1 && <span className="scv-count">{items.length} 图</span>}
      </div>
      {items.length > 0 && (
        <ItemGrid
          items={items}
          far={far}
          current={current}
          hostId={node.id}
          width={node.w ?? boxForItems(items).w}
          scale={data.zoom ?? 1}
        />
      )}
      {runLabel !== null && (
        <div
          className={items.length > 0 ? 'scv-runmask' : 'scv-skeleton'}
          /* 骨架跟着**预期出图比例**，不再是固定 150px 高的横杠。
             出竖版手机页时先给一条 2.8:1 的横条、图回来再跳成竖的，
             既是错的预告也是一次可见的跳动 */
          style={items.length > 0 ? undefined : { aspectRatio: String(aspect) }}
        >
          <span className="scv-runlabel">{runLabel}</span>
          {data.runStartedAt !== undefined && <RunTimer startedAt={data.runStartedAt} />}
        </div>
      )}
      {items.length === 0 && runLabel === null && (
        /* 空态是**这个节点唯一的说明书**：外层是裸媒体壳（透明、无边框），
           所以卡片外观得由这一层自己画，否则画布上只剩一条灰杠。
           两句话分主次——第一句说它是什么，第二句说怎么让它出东西。 */
        <div className="scv-blank">
          <ImagePlus className="scv-blank-icon" />
          <b>还是空的</b>
          <span>在下面的输入框写想画什么，或者从上游连一张图进来当画板</span>
        </div>
      )}
      {draft !== '' && <div className="scv-draft" title={draft}>{draft}</div>}
    </div>
  )
}

export const ImageNode = memo(ImageNodeView, sameNodeData)

/** 生成器的独立产物容器。与图片输入节点分开后，右键菜单才能稳定承载
 * 「转换为输入组 / 复制为输入组 / 批量下载」，又不会污染手动放入的图片。
 *
 * 外观与图片节点同款（`cardLike: false`）：产物就是一张图时，套一层带标题栏的
 * 白卡片只会让它比旁边那张裸图重一大截，而多出来的两个标签
 * （「输出」「1 项结果」）说的都是眼睛已经看到的事。判据收在
 * `output-node-view.ts`：一张图什么都不写，多张或非图片才写摘要；
 * 节点没标题就沿 flow 入边回溯，写「分支自 <源节点>」。 */
function OutputNodeView({ data }: CanvasNodeViewProps) {
  const { node, runLabel } = data
  const items = node.items ?? []
  const images = items.filter((item) => item.kind === 'image')
  const media = items.filter((item) => item.kind !== 'image')
  const current = useCanvasStore((state) =>
    state.selectedItem?.nodeId === node.id ? state.selectedItem.assetId : undefined,
  )
  /* 血缘要读 nodes/connections，取的是**字符串**：对象每次都判定"变了" */
  const caption = useCanvasText(() => {
    const { nodes, connections } = useCanvasStore.getState()
    return outputCaption(node, nodes, connections)?.text ?? null
  })
  /* 摘要只看自己的 items，不进选择器——省一次全表扫描，也省一次订阅 */
  const summary = outputSummary(items)
  return (
    <div
      className="scv-node scv-output"
      onClickCapture={(event) => openOnRepeatedClick(event, data, node.id)}
      onDoubleClick={(event) => items.length > 0 && data.onOpen?.(node.id, hitAsset(event))}
    >
      {caption !== null && (
        <div className="scv-node-title">
          <span>{caption}</span>
          {summary !== null && <span className="scv-count">{summary}</span>}
        </div>
      )}
      {images.length > 0 && (
        <ItemGrid
          items={images}
          far={data.far === true}
          current={current}
          hostId={node.id}
          width={node.w ?? boxForItems(images).w}
          scale={data.zoom ?? 1}
        />
      )}
      {media.length > 0 && (
        <div className="scv-output-media nodrag nowheel">
          {media.map((item, index) =>
            item.kind === 'video' && item.url !== undefined ? (
              <video key={`${item.url}-${index}`} src={item.url} poster={item.poster_url ?? undefined} controls playsInline preload="metadata" />
            ) : item.kind === 'audio' && item.url !== undefined ? (
              <audio key={`${item.url}-${index}`} src={item.url} controls preload="metadata" />
            ) : (
              <a key={`${item.url}-${index}`} href={item.url} download={item.name} onClick={(event) => event.stopPropagation()}>
                <IconFileText />{item.name ?? `输出 ${index + 1}`}
              </a>
            ),
          )}
        </div>
      )}
      {items.length === 0 && runLabel === null && (
        <div className="scv-blank">
          <ImagePlus className="scv-blank-icon" />
          <b>还没有产物</b>
          <span>上游任务完成后会落在这里</span>
        </div>
      )}
      {runLabel !== null && (
        <div className={items.length > 0 ? 'scv-runmask' : 'scv-skeleton'}>
          <span className="scv-runlabel">{runLabel}</span>
          {data.runStartedAt !== undefined && <RunTimer startedAt={data.runStartedAt} />}
        </div>
      )}
    </div>
  )
}

export const OutputNode = memo(OutputNodeView, sameNodeData)

function VideoNodeView({ data }: CanvasNodeViewProps) {
  const { node, runLabel } = data
  const items = (node.items ?? []).filter((item) => item.kind === 'video')
  const latest = items[items.length - 1]
  const draft = (node.prompt_draft ?? '').trim()
  return (
    <div
      className="scv-node scv-video"
      onClickCapture={(event) => openOnRepeatedClick(event, data, node.id)}
      onDoubleClick={() => data.onOpen?.(node.id)}
    >
      <div className="scv-node-title">
        <span>{node.title ?? '视频'}</span>
        {items.length > 0 && (
          <span className="scv-count">{items.length > 1 ? `${items.length} 条` : '视频资产'}</span>
        )}
      </div>
      {latest?.url !== undefined ? (
        <video
          className="scv-video-player nodrag nowheel"
          src={latest.url}
          poster={latest.poster_url ?? undefined}
          controls
          playsInline
          preload="metadata"
        />
      ) : runLabel === null ? (
        <div className="scv-blank scv-video-blank">
          <Clapperboard className="scv-blank-icon" />
          <b>还是空的</b>
          <span>写提示词并选一个视频模型</span>
        </div>
      ) : null}
      {runLabel !== null && (
        <div className={latest?.url !== undefined ? 'scv-runmask' : 'scv-skeleton'}>
          <span className="scv-runlabel">{runLabel}</span>
          {data.runStartedAt !== undefined && <RunTimer startedAt={data.runStartedAt} />}
        </div>
      )}
      {draft !== '' && <div className="scv-draft" title={draft}>{draft}</div>}
    </div>
  )
}

export const VideoNode = memo(VideoNodeView, sameNodeData)

function AudioNodeView({ data }: CanvasNodeViewProps) {
  const { node } = data
  const item = (node.items ?? []).find((candidate) => candidate.kind === 'audio')
  return (
    <div
      className="scv-node scv-audio"
      onClickCapture={(event) => openOnRepeatedClick(event, data, node.id)}
      onDoubleClick={() => data.onOpen?.(node.id)}
    >
      <div className="scv-node-title">
        <span>{node.title ?? item?.name ?? '音频'}</span>
        <span className="scv-count">音频资产</span>
      </div>
      {item?.url !== undefined ? (
        <div className="scv-audio-body nodrag nowheel">
          <IconSpeaker />
          <audio src={item.url} controls preload="metadata" />
        </div>
      ) : (
        <div className="scv-blank">
          <IconSpeaker />
          <b>还是空的</b>
          <span>连一段音频进来，或从上游生成</span>
        </div>
      )}
    </div>
  )
}

export const AudioNode = memo(AudioNodeView, sameNodeData)

function FileNodeView({ data }: CanvasNodeViewProps) {
  const { node } = data
  const item = (node.items ?? []).find((candidate) => candidate.kind === 'file')
  return (
    <div
      className="scv-node scv-file"
      onClickCapture={(event) => openOnRepeatedClick(event, data, node.id)}
      onDoubleClick={() => data.onOpen?.(node.id)}
    >
      <div className="scv-node-title">
        <span>{node.title ?? item?.name ?? '文件'}</span>
        <span className="scv-count">文件资产</span>
      </div>
      <div className="scv-file-body nodrag">
        <IconFileText />
        <div>
          <strong>{item?.name ?? '未命名文件'}</strong>
          <span>{item?.mime ?? 'application/octet-stream'}</span>
        </div>
        {item?.url !== undefined && (
          <a href={item.url} download={item.name} title="下载文件" onClick={(event) => event.stopPropagation()}>
            <IconDownload />
          </a>
        )}
      </div>
    </div>
  )
}

export const FileNode = memo(FileNodeView, sameNodeData)

function WorkflowNodeView({ data }: CanvasNodeViewProps) {
  const { node, runLabel } = data
  return (
    <div className="scv-node scv-workflow">
      <div className="scv-node-title">
        <span>{node.title ?? '工作流'}</span>
        <span className="scv-count">{node.workflow_provider ?? 'workflow'}</span>
      </div>
      <div className="scv-workflow-body">
        {node.workflow_has_thumbnail === true && node.workflow_id !== undefined ? (
          <img src={`/api/studio/workflows/${node.workflow_id}/thumbnail`} alt="" draggable={false} />
        ) : (
          <span className="scv-workflow-icon"><IconTask /></span>
        )}
        <div>
          <strong>{node.workflow_kind ?? 'workflow'}</strong>
          <span>连接上游图片后，在底部填写参数并运行</span>
        </div>
      </div>
      {runLabel !== null && (
        <div className="scv-runmask">
          <span className="scv-runlabel">{runLabel}</span>
          {data.runStartedAt !== undefined && <RunTimer startedAt={data.runStartedAt} />}
        </div>
      )}
    </div>
  )
}

export const WorkflowNode = memo(WorkflowNodeView, sameNodeData)

function PromptNodeView({ data }: CanvasNodeViewProps) {
  const { node } = data
  const updateNode = useCanvasStore((s) => s.updateNode)
  const snapshot = useCanvasStore((s) => s.snapshot)
  // 拖进分组后头部标一下归属，否则「它到底进没进去」全靠猜。
  // 选择器只吐一个字符串：订阅整个 nodes 数组的话，画布上任何一处变动都会重渲染每个提示词节点
  const owner = useCanvasStore((s) => {
    const g = s.nodes.find((n) => n.type === 'group' && (n.member_ids ?? []).includes(node.id))
    return g === undefined ? null : g.title ?? '分组'
  })
  return (
    <div className="scv-node scv-prompt">
      <div className="scv-node-title">
        <span>提示词</span>
        {owner !== null && <span className="scv-count">属于「{owner}」</span>}
      </div>
      {/* nodrag：编辑文本时别把节点拖走；nowheel：文本域内滚动别缩放画布 */}
      <textarea
        className="scv-prompt-text nodrag nowheel"
        value={node.text ?? ''}
        placeholder="给下游节点的提示词…"
        onFocus={() => snapshot()}
        onChange={(e) => updateNode(node.id, { text: e.target.value })}
      />
    </div>
  )
}

export const PromptNode = memo(PromptNodeView, sameNodeData)

function LlmNodeView({ data }: CanvasNodeViewProps) {
  const { node } = data
  const canvasId = useCanvasStore((state) => state.canvasId)
  const updateNode = useCanvasStore((state) => state.updateNode)
  const snapshot = useCanvasStore((state) => state.snapshot)
  const connectedInput = useCanvasStore((state) =>
    llmInputText(state.nodes, state.connections, node.id),
  )
  // 选择器必须返回标量；每次新建 number[] 会让 Zustand 认为永远在变。
  const imageIdsKey = useCanvasStore((state) =>
    refAssetIds(state.nodes, state.connections, node.id).slice(0, 4).join(','),
  )
  const videoIdsKey = useCanvasStore((state) =>
    refMediaItems(state.nodes, state.connections, node.id)
      .filter((item) => item.kind === 'video' && item.media_asset_id !== undefined)
      .slice(0, 3)
      .map((item) => item.media_asset_id)
      .join(','),
  )
  const viewportScale = useCanvasStore((state) => state.viewport?.scale ?? 1)
  const deployments = useQuery({
    queryKey: ['model-deployments', 'canvas-llm'],
    queryFn: () => apiConfig.modelDeployments({ enabled: true }),
    staleTime: 60_000,
  })
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const mode = node.llm_mode === 'chat' ? 'chat' : 'node'
  const history = node.llm_messages ?? []
  const imageAssetIds = imageIdsKey === '' ? [] : imageIdsKey.split(',').map(Number)
  const videoMediaAssetIds = videoIdsKey === '' ? [] : videoIdsKey.split(',').map(Number)
  const inputHeight = Math.max(70, Math.round(node.llm_input_height ?? 110))
  const outputHeight = Math.max(70, Math.round(node.llm_output_height ?? 150))
  const modelOptions = [
    { value: 'global', label: '跟随全局绑定', hint: 'chat-general' },
    ...(deployments.data ?? [])
      .filter((deployment) =>
        deployment.media_types.length === 0 || deployment.media_types.includes('chat'),
      )
      .map((deployment) => ({
        value: String(deployment.id),
        label: deployment.display_name ?? deployment.upstream_model_id,
        hint: deployment.credential_name ?? deployment.provider_type ?? deployment.adapter_type,
      })),
  ]
  const selectedDeployment =
    node.llm_deployment_id !== null &&
    node.llm_deployment_id !== undefined &&
    modelOptions.some((option) => option.value === String(node.llm_deployment_id))
      ? String(node.llm_deployment_id)
      : 'global'

  const patch = (value: Partial<ScvNode>): void => {
    snapshot()
    updateNode(node.id, value)
  }

  const complete = async (
    message: string,
    messages: { role: 'user' | 'assistant'; content: string }[],
  ): Promise<string | null> => {
    const cleaned = message.trim()
    if (cleaned === '') {
      toast.error('先给 LLM 一段输入')
      return null
    }
    if (canvasId === null) {
      toast.error('画布还没有载入')
      return null
    }
    setRunning(true)
    setError('')
    try {
      const result = await apiStudio.runCanvasLlm({
        canvas_id: canvasId,
        node_id: node.id,
        message: cleaned,
        system_prompt: node.llm_system_enabled === true ? node.llm_system_prompt ?? '' : '',
        messages,
        image_asset_ids: imageAssetIds,
        video_media_asset_ids: videoMediaAssetIds,
        deployment_id: node.llm_deployment_id ?? null,
        temperature: node.llm_temperature ?? 0.7,
      })
      return result.text
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : 'LLM 调用失败'
      setError(detail)
      toast.error(detail)
      return null
    } finally {
      setRunning(false)
    }
  }

  const runNode = async (): Promise<void> => {
    const message = connectedInput.trim() !== '' ? connectedInput : node.llm_input ?? ''
    const text = await complete(message, [])
    if (text === null) return
    snapshot()
    updateNode(node.id, { llm_output: text })
  }

  const sendChat = async (): Promise<void> => {
    const message = node.llm_chat_input ?? ''
    const text = await complete(message, history)
    if (text === null) return
    snapshot()
    updateNode(node.id, {
      llm_chat_input: '',
      llm_output: text,
      llm_messages: [
        ...history,
        { role: 'user' as const, content: message.trim() },
        { role: 'assistant' as const, content: text },
      ].slice(-40),
    })
  }

  const onChatKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    if (!running) void sendChat()
  }

  const beginPaneResize = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    snapshot()
    const startY = event.clientY
    const total = inputHeight + outputHeight
    const scale = Math.max(0.1, viewportScale)
    const onMove = (moveEvent: MouseEvent): void => {
      const delta = (moveEvent.clientY - startY) / scale
      const nextInput = Math.max(70, Math.min(total - 70, Math.round(inputHeight + delta)))
      updateNode(node.id, {
        llm_input_height: nextInput,
        llm_output_height: total - nextInput,
      })
    }
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  return (
    <div className="scv-node scv-llm">
      <div className="scv-node-title">
        <span><MessageSquareText />{node.title ?? 'LLM'}</span>
        <span className="scv-count">
          {connectedInput.trim() !== '' ? '已连文字' : '本地输入'}
          {imageAssetIds.length > 0 ? ` · ${imageAssetIds.length} 图` : ''}
          {videoMediaAssetIds.length > 0 ? ` · ${videoMediaAssetIds.length} 视频` : ''}
        </span>
      </div>

      <div className="scv-llm-controls nodrag nowheel">
        <div className="scv-llm-tabs" role="tablist" aria-label="LLM 模式">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'node'}
            className={mode === 'node' ? 'is-active' : ''}
            onClick={() => mode !== 'node' && patch({ llm_mode: 'node' })}
          >节点</button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'chat'}
            className={mode === 'chat' ? 'is-active' : ''}
            onClick={() => mode !== 'chat' && patch({ llm_mode: 'chat' })}
          >对话</button>
        </div>
        <Picker
          value={selectedDeployment}
          onChange={(value) => patch({ llm_deployment_id: value === 'global' ? null : Number(value) })}
          options={modelOptions}
          size="sm"
          aria-label="LLM 模型"
          title="可固定到某个模型部署；跟随全局时读 chat-general 能力绑定"
        />
        <label className="scv-llm-system-toggle">
          <input
            type="checkbox"
            checked={node.llm_system_enabled === true}
            onChange={(event) => patch({ llm_system_enabled: event.target.checked })}
          />
          系统提示词
        </label>
        {node.llm_system_enabled === true && (
          <textarea
            className="scv-llm-system"
            value={node.llm_system_prompt ?? ''}
            placeholder="例如：你是视觉提示词编辑，只输出改写结果。"
            onFocus={() => snapshot()}
            onChange={(event) => updateNode(node.id, { llm_system_prompt: event.target.value })}
          />
        )}
      </div>

      {mode === 'node' ? (
        <div className="scv-llm-node-mode nodrag nowheel">
          <label>
            <span>{connectedInput.trim() !== '' ? '连线输入（只读）' : '输入'}</span>
            <textarea
              style={{ height: inputHeight, minHeight: inputHeight, maxHeight: inputHeight }}
              value={connectedInput.trim() !== '' ? connectedInput : node.llm_input ?? ''}
              readOnly={connectedInput.trim() !== ''}
              placeholder="写要让模型处理的内容，或连入上游提示词 / LLM / 图片节点…"
              onFocus={() => connectedInput.trim() === '' && snapshot()}
              onChange={(event) => updateNode(node.id, { llm_input: event.target.value })}
            />
          </label>
          <button
            type="button"
            className="scv-llm-pane-resizer"
            aria-label="调整 LLM 输入和输出高度"
            title="拖动调整输入和输出高度"
            onMouseDown={beginPaneResize}
          />
          <div className="scv-llm-actions">
            <span>
              {[
                imageAssetIds.length > 0 ? `${imageAssetIds.length} 张上游图片` : '',
                videoMediaAssetIds.length > 0 ? `${videoMediaAssetIds.length} 个上游视频` : '',
              ].filter(Boolean).join(' · ')}
            </span>
            <CanvasCascadeAction nodeId={node.id} disabled={running} className="scv-nodebtn" />
            <button type="button" className="scv-nodebtn" disabled={running} onClick={() => void runNode()}>
              <Play />{running ? '处理中…' : '运行'}
            </button>
          </div>
          <div className="scv-llm-output">
            <header>
              <span>输出</span>
              <button
                type="button"
                title="复制输出"
                disabled={(node.llm_output ?? '') === ''}
                onClick={() => {
                  void navigator.clipboard.writeText(node.llm_output ?? '').then(
                    () => toast.success('已复制 LLM 输出'),
                    () => toast.error('复制失败'),
                  )
                }}
              ><Copy /></button>
            </header>
            <pre style={{ height: outputHeight, minHeight: outputHeight, maxHeight: outputHeight }}>
              {node.llm_output || '运行后的内容会出现在这里，也能继续连到图片或视频节点。'}
            </pre>
          </div>
        </div>
      ) : (
        <div className="scv-llm-chat nodrag nowheel">
          <div className="scv-llm-messages" aria-live="polite">
            {history.length === 0 && <p>在画布里保留一段对话，上下文会随节点一起保存。</p>}
            {history.map((message, index) => (
              <div key={`${message.role}-${index}`} className={`scv-llm-message is-${message.role}`}>
                <span>{message.role === 'user' ? '你' : 'LLM'}</span>
                <pre>{message.content}</pre>
              </div>
            ))}
            {running && <div className="scv-llm-thinking">LLM 正在回复…</div>}
          </div>
          <div className="scv-llm-chatbox">
            <textarea
              value={node.llm_chat_input ?? ''}
              placeholder="输入消息，Enter 发送，Shift+Enter 换行"
              onFocus={() => snapshot()}
              onChange={(event) => updateNode(node.id, { llm_chat_input: event.target.value })}
              onKeyDown={onChatKeyDown}
            />
            <button
              type="button"
              title="发送"
              disabled={running || (node.llm_chat_input ?? '').trim() === ''}
              onClick={() => void sendChat()}
            ><Send /></button>
          </div>
          {history.length > 0 && (
            <button type="button" className="scv-llm-clear" onClick={() => patch({ llm_messages: [], llm_output: '' })}>
              清空对话
            </button>
          )}
        </div>
      )}
      {error !== '' && <div className="scv-llm-error">{error}</div>}
    </div>
  )
}

export const LlmNode = memo(LlmNodeView, sameNodeData)

const MODELSCOPE_SIZE_PRESETS = [
  { value: '1024x1024', label: '1:1' },
  { value: '1536x1024', label: '3:2' },
  { value: '1024x1536', label: '2:3' },
  { value: '1024x576', label: '16:9' },
  { value: '576x1024', label: '9:16' },
  { value: '2048x2048', label: '2K' },
]

function optionalNumber(value: string): number | null {
  if (value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** ModelScope 专用生成卡。它只保存配置，图片始终落到右侧独立输出节点。 */
function ModelScopeNodeView({ data }: CanvasNodeViewProps) {
  const { node } = data
  const updateNode = useCanvasStore((state) => state.updateNode)
  const snapshot = useCanvasStore((state) => state.snapshot)
  const canvasId = useCanvasStore((state) => state.canvasId)
  const connectedInput = useCanvasStore((state) =>
    llmInputText(state.nodes, state.connections, node.id),
  )
  const refsKey = useCanvasStore((state) =>
    refAssetIds(state.nodes, state.connections, node.id).slice(0, 10).join(','),
  )
  const busy = useCanvasStore((state) =>
    state.connections.some(
      (connection) =>
        connection.from === node.id &&
        (connection.kind ?? 'flow') === 'flow' &&
        connection.to in state.running,
    ),
  )
  const outputCount = useCanvasStore((state) => {
    const targets = new Set(
      state.connections
        .filter(
          (connection) =>
            connection.from === node.id && (connection.kind ?? 'flow') === 'flow',
        )
        .map((connection) => connection.to),
    )
    return state.nodes.reduce(
      (sum, candidate) =>
        targets.has(candidate.id) && candidate.type === 'image'
          ? sum + (candidate.items ?? []).length
          : sum,
      0,
    )
  })
  const deployments = useQuery({
    queryKey: ['model-deployments', 'canvas-modelscope'],
    queryFn: () => apiConfig.modelDeployments({ media_type: 'image', enabled: true }),
    staleTime: 60_000,
  })
  const [advanced, setAdvanced] = useState(false)
  const refs = refsKey === '' ? [] : refsKey.split(',').map(Number)
  const modelOptions = (deployments.data ?? [])
    .filter(
      (deployment) =>
        (deployment.adapter_type === 'modelscope' || deployment.provider_type === 'modelscope') &&
        (deployment.media_types.length === 0 || deployment.media_types.includes('image')),
    )
    .map((deployment) => ({
      value: String(deployment.id),
      label: deployment.display_name ?? deployment.upstream_model_id,
      hint: deployment.upstream_model_id,
    }))
  const hintedDeployment = (deployments.data ?? []).find(
    (deployment) =>
      deployment.adapter_type === 'modelscope' &&
      deployment.upstream_model_id === node.ms_model_hint,
  )
  useEffect(() => {
    if (
      (node.ms_deployment_id === null || node.ms_deployment_id === undefined) &&
      hintedDeployment !== undefined
    ) {
      updateNode(node.id, { ms_deployment_id: hintedDeployment.id })
    }
  }, [hintedDeployment, node.id, node.ms_deployment_id, updateNode])
  const selectedDeployment =
    node.ms_deployment_id !== null &&
    node.ms_deployment_id !== undefined &&
    modelOptions.some((option) => option.value === String(node.ms_deployment_id))
      ? String(node.ms_deployment_id)
      : ''
  const selectedDeploymentRow = (deployments.data ?? []).find(
    (deployment) => String(deployment.id) === selectedDeployment,
  )
  const loras = useQuery({
    queryKey: [
      'modelscope-loras',
      'canvas-node',
      selectedDeploymentRow?.credential_id,
      selectedDeploymentRow?.upstream_model_id,
    ],
    queryFn: () =>
      selectedDeploymentRow === undefined
        ? Promise.resolve([])
        : apiConfig.modelscopeLoras({
            credential_id: selectedDeploymentRow.credential_id,
            target_model: selectedDeploymentRow.upstream_model_id,
            enabled: true,
          }),
    enabled: selectedDeploymentRow !== undefined,
    staleTime: 60_000,
  })
  const loraOptions = (loras.data ?? []).map((lora) => ({
    value: lora.lora_id,
    label: lora.display_name ?? lora.lora_id,
    hint: lora.lora_id,
  }))
  const selectedLora = loraOptions.some((option) => option.value === node.ms_lora_id)
    ? node.ms_lora_id ?? ''
    : ''
  const taskHistory = useQuery({
    queryKey: ['canvas-modelscope-history', canvasId, node.id],
    queryFn: () =>
      apiStudio.tasks({
        canvas_id: canvasId as number,
        origin_node_id: node.id,
        limit: 8,
      }),
    enabled: canvasId !== null,
    refetchInterval: busy ? 1500 : false,
  })
  useEffect(() => {
    if (
      loras.isSuccess &&
      node.ms_lora_enabled === true &&
      (node.ms_lora_id ?? '').trim() !== '' &&
      selectedLora === ''
    ) {
      updateNode(node.id, { ms_lora_enabled: false, ms_lora_id: '' })
    }
  }, [loras.isSuccess, node.id, node.ms_lora_enabled, node.ms_lora_id, selectedLora, updateNode])
  const count = Math.max(1, Math.min(Math.round(node.ms_count ?? 1), MODELSCOPE_MAX_COUNT))
  const size = node.ms_size ?? '1024x1024'

  const patch = (value: Partial<ScvNode>): void => {
    snapshot()
    updateNode(node.id, value)
  }

  return (
    <div className="scv-node scv-modelscope">
      <div className="scv-node-title">
        <span><Sparkles />{node.title ?? 'ModelScope 生成'}</span>
        <span className="scv-count">
          {busy ? '生成中' : `${refs.length} 参考图`}
          {outputCount > 0 ? ` · ${outputCount} 产出` : ''}
        </span>
      </div>

      <div className="scv-ms-body nodrag nowheel">
        <GeneratorEnginePicker node={node} disabled={busy} />
        <Picker
          value={selectedDeployment}
          onChange={(value) =>
            patch({
              ms_deployment_id: Number(value),
              ms_lora_enabled: false,
              ms_lora_id: '',
              ms_lora_strength: 0.8,
            })
          }
          options={modelOptions}
          placeholder={deployments.isLoading ? '正在读取模型…' : '选择 ModelScope 图片模型'}
          disabled={deployments.isLoading || modelOptions.length === 0}
          size="sm"
          aria-label="ModelScope 模型"
        />
        {modelOptions.length === 0 && !deployments.isLoading && (
          <p className="scv-ms-empty">设置中还没有启用的 ModelScope 图片部署。</p>
        )}

        <label className="scv-ms-prompt">
          <span>{connectedInput === '' ? '提示词' : '追加提示词（已连上游）'}</span>
          <textarea
            value={node.prompt_draft ?? ''}
            placeholder="描述要生成的画面，或连接上游提示词 / LLM 节点…"
            onFocus={() => snapshot()}
            onChange={(event) => updateNode(node.id, { prompt_draft: event.target.value })}
          />
        </label>
        {connectedInput !== '' && <div className="scv-ms-upstream" title={connectedInput}>上游：{connectedInput}</div>}

        <div className="scv-ms-size">
          <span>尺寸</span>
          <input
            value={size}
            aria-label="ModelScope 图片尺寸"
            placeholder="1024x1024"
            onFocus={() => snapshot()}
            onChange={(event) => updateNode(node.id, { ms_size: event.target.value })}
          />
        </div>
        <div className="scv-ms-size-chips" aria-label="尺寸快捷选项">
          {MODELSCOPE_SIZE_PRESETS.map((preset) => (
            <button
              key={preset.value}
              type="button"
              className={size === preset.value ? 'is-active' : ''}
              title={preset.value}
              onClick={() => patch({ ms_size: preset.value })}
            >{preset.label}</button>
          ))}
        </div>

        <div className="scv-ms-row">
          <label>
            <span>张数</span>
            <input
              type="number"
              min={1}
              max={MODELSCOPE_MAX_COUNT}
              value={count}
              onFocus={() => snapshot()}
              onChange={(event) =>
                updateNode(node.id, {
                  ms_count: Math.max(
                    1,
                    Math.min(Number(event.target.value) || 1, MODELSCOPE_MAX_COUNT),
                  ),
                })
              }
            />
          </label>
          <span>并发独立任务，最多 {MODELSCOPE_MAX_COUNT} 张</span>
        </div>

        <button type="button" className="scv-ms-more" onClick={() => setAdvanced((value) => !value)}>
          {advanced ? '收起高级参数' : '高级参数（负面词 · Seed · LoRA）'}
        </button>
        {advanced && (
          <div className="scv-ms-advanced">
            <label className="scv-ms-prompt">
              <span>负面提示词</span>
              <textarea
                value={node.ms_negative_prompt ?? ''}
                placeholder="text, watermark, blurry…"
                onFocus={() => snapshot()}
                onChange={(event) => updateNode(node.id, { ms_negative_prompt: event.target.value })}
              />
            </label>
            <div className="scv-ms-grid-fields">
              <label><span>Seed</span><input type="number" min={0} value={node.ms_seed ?? ''} onFocus={() => snapshot()} onChange={(event) => updateNode(node.id, { ms_seed: optionalNumber(event.target.value) })} /></label>
              <label><span>Steps</span><input type="number" min={1} max={100} value={node.ms_steps ?? ''} onFocus={() => snapshot()} onChange={(event) => updateNode(node.id, { ms_steps: optionalNumber(event.target.value) })} /></label>
              <label><span>Guidance</span><input type="number" min={1.5} max={20} step={0.1} value={node.ms_guidance ?? ''} onFocus={() => snapshot()} onChange={(event) => updateNode(node.id, { ms_guidance: optionalNumber(event.target.value) })} /></label>
            </div>
            {selectedDeploymentRow !== undefined && loras.isLoading && (
              <p className="scv-ms-lora-note">正在读取当前模型的 LoRA…</p>
            )}
            {selectedDeploymentRow !== undefined && loras.isError && (
              <p className="scv-ms-empty">LoRA 目录读取失败：{loras.error.message}</p>
            )}
            {selectedDeploymentRow !== undefined && !loras.isLoading && !loras.isError && loraOptions.length === 0 && (
              <p className="scv-ms-lora-note">当前模型没有启用的 LoRA，请先到模型实验台添加。</p>
            )}
            {loraOptions.length > 0 && (
              <>
                <label className="scv-ms-lora-toggle">
                  <input
                    type="checkbox"
                    checked={node.ms_lora_enabled === true}
                    onChange={(event) => {
                      const first = loras.data?.[0]
                      patch({
                        ms_lora_enabled: event.target.checked,
                        ...(event.target.checked && selectedLora === '' && first !== undefined
                          ? {
                              ms_lora_id: first.lora_id,
                              ms_lora_strength: Math.max(0, Math.min(first.default_strength, 1)),
                            }
                          : {}),
                      })
                    }}
                  />
                  启用 LoRA
                </label>
                {node.ms_lora_enabled === true && (
                  <div className="scv-ms-lora">
                    <Picker
                      value={selectedLora}
                      onChange={(value) => {
                        const picked = loras.data?.find((lora) => lora.lora_id === value)
                        patch({
                          ms_lora_id: value,
                          ms_lora_strength: Math.max(
                            0,
                            Math.min(picked?.default_strength ?? node.ms_lora_strength ?? 0.8, 1),
                          ),
                        })
                      }}
                      options={loraOptions}
                      placeholder="选择当前模型的 LoRA"
                      size="sm"
                      aria-label="ModelScope LoRA"
                    />
                    <label><span>强度 {(node.ms_lora_strength ?? 0.8).toFixed(2)}</span><input type="range" min={0} max={1} step={0.05} value={node.ms_lora_strength ?? 0.8} onFocus={() => snapshot()} onChange={(event) => updateNode(node.id, { ms_lora_strength: Number(event.target.value) })} /></label>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <div className="scv-ms-actions">
          <span>{refs.length > 0 ? `将上送 ${refs.length} 张参考图` : '文生图'}</span>
          <CanvasCascadeAction nodeId={node.id} disabled={busy} className="scv-nodebtn" />
          <button
            type="button"
            className="scv-nodebtn"
            disabled={busy || selectedDeployment === ''}
            onClick={() => void generateModelScopeFrom(node.id)}
          ><Play />{busy ? '生成中…' : '运行'}</button>
        </div>
        {(taskHistory.data?.items.length ?? 0) > 0 && (
          <details className="scv-workflow-history scv-ms-history">
            <summary>生成记录（{taskHistory.data?.items.length ?? 0}）</summary>
            <div>
              {taskHistory.data?.items.map((task) => (
                <article key={task.id} title={task.id}>
                  <b data-status={task.status}>{task.status}</b>
                  <span>{task.task_type}</span>
                  <small>{task.error ?? task.stage ?? `${Math.round(task.progress)}%`}</small>
                  {task.retryable && ['failed', 'partial', 'cancelled'].includes(task.status) && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void retryCanvasImageTask(task.id).then(() => taskHistory.refetch())}
                    >重试</button>
                  )}
                </article>
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  )
}

export const ModelScopeNode = memo(ModelScopeNodeView, sameNodeData)

const MIDJOURNEY_MODES = [
  { value: 'imagine', label: '生成' },
  { value: 'blend', label: '融图' },
  { value: 'edit', label: '编辑' },
]
const MIDJOURNEY_SIZES = ['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'].map((value) => ({
  value,
  label: value,
}))
const MIDJOURNEY_VERSIONS = ['8.2', '8.1', '7', '6.1', '5.2', '5.1'].map((value) => ({
  value,
  label: `v${value}`,
}))
const MIDJOURNEY_SPEEDS = [
  { value: 'relax', label: 'Relax' },
  { value: 'fast', label: 'Fast' },
  { value: 'turbo', label: 'Turbo' },
]

/** APIMart Midjourney 原生任务节点：保留 task id，成功后继续 U/V/缩放/平移/重绘。 */
function MidjourneyNodeView({ data }: CanvasNodeViewProps) {
  const { node } = data
  const updateNode = useCanvasStore((state) => state.updateNode)
  const snapshot = useCanvasStore((state) => state.snapshot)
  const connectedInput = useCanvasStore((state) =>
    llmInputText(state.nodes, state.connections, node.id),
  )
  const refsKey = useCanvasStore((state) =>
    refAssetIds(state.nodes, state.connections, node.id)
      .slice(0, MIDJOURNEY_MAX_REFS)
      .join(','),
  )
  const busy = useCanvasStore((state) =>
    state.connections.some(
      (connection) =>
        connection.from === node.id &&
        (connection.kind ?? 'flow') === 'flow' &&
        connection.to in state.running,
    ),
  )
  const deployments = useQuery({
    queryKey: ['model-deployments', 'canvas-midjourney'],
    queryFn: () => apiConfig.modelDeployments({ media_type: 'image', enabled: true }),
    staleTime: 60_000,
  })
  const refs = refsKey === '' ? [] : refsKey.split(',').map(Number)
  const modelRows = (deployments.data ?? []).filter(
    (deployment) =>
      deployment.adapter_type === 'apimart' &&
      (deployment.media_types.length === 0 || deployment.media_types.includes('image')),
  )
  const modelOptions = modelRows.map((deployment) => ({
    value: String(deployment.id),
    label: deployment.display_name ?? deployment.upstream_model_id,
    hint: deployment.credential_name ?? deployment.provider_type ?? 'APIMart',
  }))
  const hintedDeployment = modelRows.find(
    (deployment) =>
      deployment.provider_type === node.mj_provider_hint ||
      deployment.credential_name === node.mj_provider_hint ||
      deployment.upstream_model_id === node.mj_provider_hint,
  ) ?? (modelRows.length === 1 ? modelRows[0] : undefined)
  useEffect(() => {
    if (
      (node.mj_deployment_id === null || node.mj_deployment_id === undefined) &&
      hintedDeployment !== undefined
    ) {
      updateNode(node.id, { mj_deployment_id: hintedDeployment.id })
    }
  }, [hintedDeployment, node.id, node.mj_deployment_id, updateNode])
  const selectedDeployment =
    node.mj_deployment_id !== null &&
    node.mj_deployment_id !== undefined &&
    modelOptions.some((option) => option.value === String(node.mj_deployment_id))
      ? String(node.mj_deployment_id)
      : ''
  const mode = node.mj_mode ?? 'imagine'
  const version = node.mj_version ?? '8.2'
  const imageCount = Math.max(0, node.mj_last_image_count ?? 0)
  const hasTask = (node.mj_last_task_id ?? '') !== ''
  const modal = (node.mj_modal_task_id ?? '') !== ''
  const actionLayout = midjourneyActionLayout(version, imageCount, modal)

  const patch = (value: Partial<ScvNode>): void => {
    snapshot()
    updateNode(node.id, value)
  }
  const action = (
    name: Parameters<typeof runMidjourneyAction>[1],
    options?: Parameters<typeof runMidjourneyAction>[2],
  ): void => {
    void runMidjourneyAction(node.id, name, options)
  }

  return (
    <div className="scv-node scv-midjourney">
      <div className="scv-node-title">
        <span><Sparkles />{node.title ?? 'Midjourney'}</span>
        <span className="scv-count">{busy ? '执行中' : `${refs.length} 参考图`}</span>
      </div>
      <div className="scv-mj-body nodrag nowheel">
        <Picker
          value={selectedDeployment}
          onChange={(value) => patch({ mj_deployment_id: Number(value) })}
          options={modelOptions}
          placeholder={deployments.isLoading ? '正在读取模型…' : '选择 APIMart Midjourney 部署'}
          disabled={deployments.isLoading || modelOptions.length === 0}
          size="sm"
          aria-label="Midjourney 模型"
        />
        {modelOptions.length === 0 && !deployments.isLoading && (
          <p className="scv-ms-empty">设置中还没有启用的 APIMart 图片部署。</p>
        )}

        <div className="scv-mj-mode">
          {MIDJOURNEY_MODES.map((item) => (
            <button
              key={item.value}
              type="button"
              className={mode === item.value ? 'is-active' : ''}
              onClick={() => patch({ mj_mode: item.value as ScvNode['mj_mode'] })}
            >{item.label}</button>
          ))}
        </div>
        <label className="scv-ms-prompt">
          <span>{connectedInput === '' ? '提示词' : '追加提示词（已连上游）'}</span>
          <textarea
            value={node.prompt_draft ?? ''}
            placeholder={mode === 'blend' ? '融图模式只需 2–4 张参考图' : '描述要生成或修改的画面…'}
            onFocus={() => snapshot()}
            onChange={(event) => updateNode(node.id, { prompt_draft: event.target.value })}
          />
        </label>
        {connectedInput !== '' && (
          <div className="scv-ms-upstream" title={connectedInput}>上游：{connectedInput}</div>
        )}

        <div className="scv-mj-fields">
          <label><span>画幅</span><Picker value={node.mj_size ?? '1:1'} onChange={(value) => patch({ mj_size: value })} options={MIDJOURNEY_SIZES} size="sm" /></label>
          <label><span>版本</span><Picker value={version} onChange={(value) => patch({ mj_version: value as ScvNode['mj_version'] })} options={MIDJOURNEY_VERSIONS} size="sm" /></label>
          <label><span>速度</span><Picker value={node.mj_speed ?? 'relax'} onChange={(value) => patch({ mj_speed: value as ScvNode['mj_speed'] })} options={MIDJOURNEY_SPEEDS} size="sm" /></label>
        </div>

        <div className="scv-mj-runline">
          <span>{mode === 'blend' ? '需 2–4 图' : mode === 'edit' ? '需提示词 + 参考图' : '提示词，可选参考图'}</span>
          <CanvasCascadeAction nodeId={node.id} disabled={busy} className="scv-nodebtn" />
          <button
            type="button"
            className="scv-nodebtn"
            disabled={busy || selectedDeployment === ''}
            onClick={() => void generateMidjourneyFrom(node.id)}
          ><Play />{busy ? '执行中…' : '运行'}</button>
        </div>

        {(node.mj_last_task_status ?? '') !== '' && (
          <div className="scv-mj-status">
            <span>{node.mj_last_task_status}</span>
            {(node.mj_last_task_id ?? '') !== '' && (
              <code title={node.mj_last_task_id}>{node.mj_last_task_id?.slice(0, 18)}…</code>
            )}
            {imageCount > 0 && <b>{imageCount} 张</b>}
          </div>
        )}

        {hasTask && (actionLayout === 'remix-grid' || actionLayout === 'legacy-grid') && (
          <div className="scv-mj-actions">
            {actionLayout === 'remix-grid' ? (
              <>
                <div><span>弱重塑</span>{[1, 2, 3, 4].map((index) => <button key={`rs${index}`} type="button" disabled={busy} onClick={() => action('remix_subtle', { index })}>R{index}</button>)}</div>
                <div><span>强重塑</span>{[1, 2, 3, 4].map((index) => <button key={`rr${index}`} type="button" disabled={busy} onClick={() => action('remix_strong', { index })}>R+{index}</button>)}</div>
              </>
            ) : (
              <>
                <div><span>放大</span>{[1, 2, 3, 4].map((index) => <button key={`u${index}`} type="button" disabled={busy} onClick={() => action('upscale', { index })}>U{index}</button>)}</div>
                <div><span>变体</span>{[1, 2, 3, 4].map((index) => <button key={`v${index}`} type="button" disabled={busy} onClick={() => action('variation', { index })}>V{index}</button>)}</div>
              </>
            )}
            <button type="button" className="scv-mj-wide" disabled={busy} onClick={() => action('reroll')}>重新生成</button>
          </div>
        )}

        {hasTask && actionLayout === 'single' && (
          <div className="scv-mj-actions">
            <div><span>变体</span><button type="button" disabled={busy} onClick={() => action('low_variation')}>弱</button><button type="button" disabled={busy} onClick={() => action('high_variation')}>强</button></div>
            <div><span>缩放</span><button type="button" disabled={busy} onClick={() => action('zoom', { zoomRatio: 1.5 })}>1.5×</button><button type="button" disabled={busy} onClick={() => action('zoom', { zoomRatio: 2 })}>2×</button></div>
            <div><span>平移</span>{(['left', 'up', 'right', 'down'] as const).map((direction) => <button key={direction} type="button" disabled={busy} onClick={() => action('pan', { direction })}>{{ left: '左', up: '上', right: '右', down: '下' }[direction]}</button>)}</div>
            <button type="button" className="scv-mj-wide" disabled={busy} onClick={() => action('inpaint')}>局部重绘</button>
          </div>
        )}

        {modal && (
          <div className="scv-mj-modal">
            <strong>局部重绘补参</strong>
            <textarea
              value={node.mj_modal_prompt ?? ''}
              placeholder="描述透明区域要重绘成什么…"
              onFocus={() => snapshot()}
              onChange={(event) => updateNode(node.id, { mj_modal_prompt: event.target.value })}
            />
            <label>
              <span>遮罩</span>
              <select
                value={node.mj_mask_asset_id ?? ''}
                onFocus={() => snapshot()}
                onChange={(event) => updateNode(node.id, { mj_mask_asset_id: Number(event.target.value) || null })}
              >
                <option value="">选择已连接的白色涂抹图</option>
                {refs.map((assetId, index) => <option key={assetId} value={assetId}>参考图 {index + 1} · #{assetId}</option>)}
              </select>
            </label>
            <button
              type="button"
              className="scv-nodebtn"
              disabled={busy || !node.mj_mask_asset_id}
              onClick={() => action('modal', {
                prompt: node.mj_modal_prompt ?? '',
                maskAssetId: node.mj_mask_asset_id ?? undefined,
              })}
            >提交重绘</button>
          </div>
        )}
      </div>
    </div>
  )
}

export const MidjourneyNode = memo(MidjourneyNodeView, sameNodeData)

/** 循环节点（FR-461 loop · CR-005 §3.3 · 需求 17 §6.5）。
 *
   这一个节点承担蓝本 `smart-loop` 的全部职责——**循环与并发不是两个节点**，
   是同一个节点的 `mode` 字段。它本身不产图，只驱动下游链路跑 N 轮。

   三种用法可以叠加：

   | 用法       | 开关                     | 产出 |
   | ---------- | ------------------------ | ---- |
   | 变量计数   | 提示词里写《计数》       | 每轮替换成当前序号 |
   | 多提示词   | 每行一条                 | 第 n 轮取第 n 条，共享同一条上游参考图 → 一致性 |
   | 图片切片   | 开「逐张喂图」           | 每轮从上游图里取 N 张 → 批量处理一组图 |

   相对蓝本的升级：并发池可配（蓝本硬编码 6）、轮数无产品上限、
   每个模式带一句说明（蓝本只有两个没有解释的按钮）。 */

const MODE_HINT: Record<LoopMode, string> = {
  serial: '一轮跑完再跑下一轮，上一轮的图能当下一轮的参考 —— 要一致性用这个',
  parallel: '所有轮次同时跑，互不影响 —— 同一个想法要多个不同效果用这个',
}

/** 轮数快捷档。用户明确要求「有快捷选项和自定义」 */
const ROUND_PRESETS = [2, 3, 4, 6, 9, 12]

function LoopNodeView({ data }: CanvasNodeViewProps) {
  const { node } = data
  const updateNode = useCanvasStore((s) => s.updateNode)
  const snapshot = useCanvasStore((s) => s.snapshot)
  const cascade = useCanvasStore((s) => s.cascade)
  const stopCascade = useCanvasStore((s) => s.stopCascade)
  const [more, setMore] = useState(false)

  const count = Math.max(1, Math.min(node.count ?? 3, LOOP_MAX))
  const mode: LoopMode = node.mode === 'parallel' ? 'parallel' : 'serial'
  const loopStart = Math.max(1, node.loop_start ?? 1)
  const pool = Math.max(1, Math.min(node.parallel_limit ?? CASCADE_POOL_DEFAULT, CASCADE_POOL_MAX))
  const sliceOn = node.image_input === true
  const batch = Math.max(1, node.image_batch_size ?? 1)
  const mine = cascade !== null && cascade.loopId === node.id
  const busy = cascade !== null
  /* 运行前先把要跑多少说出来。级联只沿 input 边走之后这个数是稳定的：
     同一条链点几次都是同一个数，不会越跑越长。
     选择器吐一个字符串（按值比较，不会因为返回新对象而每次 set 都重渲染） */
  const planKey = useCanvasStore((s) => {
    const p = cascadePlan(s.nodes, s.connections, node.id)
    return `${p.executableNodes}/${p.rounds}/${p.gens}`
  })
  const [planNodes, planRounds, planGens] = planKey.split('/')

  const patch = (v: Partial<typeof node>): void => {
    snapshot()
    updateNode(node.id, v)
  }

  return (
    <div className={`scv-node scv-loop${mine ? ' scv-loop-on' : ''}`}>
      <div className="scv-node-title">
        <span>{node.title ?? '循环'}</span>
        <span className="scv-count">
          {mine
            ? `${cascade.doneRounds}/${cascade.total} 轮`
            : `${count} 轮 · ${mode === 'serial' ? '循环' : '并发'}`}
        </span>
      </div>

      {/* 模式：两个按钮 + 一句说明。蓝本这里只有两个字，第一次用完全猜不出区别 */}
      <div className="scv-loop-mode nodrag">
        <button
          type="button"
          className={mode === 'serial' ? 'scv-loop-tab scv-loop-tab-on' : 'scv-loop-tab'}
          title={MODE_HINT.serial}
          onClick={() => patch({ mode: 'serial' })}
        >
          循环
        </button>
        <button
          type="button"
          className={mode === 'parallel' ? 'scv-loop-tab scv-loop-tab-on' : 'scv-loop-tab'}
          title={MODE_HINT.parallel}
          onClick={() => patch({ mode: 'parallel' })}
        >
          并发
        </button>
      </div>
      <p className="scv-loop-tip">{MODE_HINT[mode]}</p>

      <div className="scv-loop-row">
        <label className="scv-loop-field">
          轮数
          <input
            className="scv-loop-num nodrag"
            type="number"
            min={1}
            max={LOOP_MAX}
            value={count}
            title="想跑几轮就填几轮，没有产品上限"
            onFocus={() => snapshot()}
            onChange={(e) =>
              updateNode(node.id, {
                count: Math.max(1, Math.min(Number(e.target.value) || 1, LOOP_MAX)),
              })
            }
          />
        </label>
        <span className="scv-loop-quick nodrag">
          {ROUND_PRESETS.map((n) => (
            <button
              key={n}
              type="button"
              className={n === count ? 'scv-loop-chip scv-loop-chip-on' : 'scv-loop-chip'}
              onClick={() => patch({ count: n })}
            >
              {n}
            </button>
          ))}
        </span>
      </div>

      <textarea
        className="scv-loop-vars nodrag nowheel"
        value={(node.variable_prompts ?? []).join('\n')}
        placeholder="每行一条轮次提示词，第 n 轮取第 n 条；可写《计数》《总数》《进度》"
        onFocus={() => snapshot()}
        onChange={(e) => updateNode(node.id, { variable_prompts: e.target.value.split('\n') })}
      />

      <button
        type="button"
        className="scv-loop-more nodrag"
        title="说清楚要什么，轮数与每轮的词由 AI 推出来"
        onClick={() => data.onOpen?.(node.id)}
      >
        成套出图（说需求，不填参数）…
      </button>

      <button type="button" className="scv-loop-more nodrag" onClick={() => setMore((v) => !v)}>
        {more ? '收起高级设置' : '高级设置（起始计数 · 逐张喂图 · 并发数）'}
      </button>

      {more && (
        <div className="scv-loop-adv nodrag">
          <label className="scv-loop-field">
            起始计数
            <input
              className="scv-loop-num"
              type="number"
              min={1}
              max={LOOP_MAX}
              value={loopStart}
              title="《计数》从这个数开始；开了逐张喂图时，也从上游第这一张开始取"
              onFocus={() => snapshot()}
              onChange={(e) => updateNode(node.id, { loop_start: Math.max(1, Number(e.target.value) || 1) })}
            />
          </label>
          {mode === 'parallel' && (
            <label className="scv-loop-field">
              并发数
              <input
                className="scv-loop-num"
                type="number"
                min={1}
                max={CASCADE_POOL_MAX}
                value={pool}
                title={`同时跑几轮。不填走默认 ${CASCADE_POOL_DEFAULT}，最大 ${CASCADE_POOL_MAX}`}
                onFocus={() => snapshot()}
                onChange={(e) =>
                  updateNode(node.id, {
                    parallel_limit: Math.max(1, Math.min(Number(e.target.value) || 1, CASCADE_POOL_MAX)),
                  })
                }
              />
            </label>
          )}
          <label className="scv-loop-check">
            <input
              type="checkbox"
              checked={sliceOn}
              onChange={(e) => patch({ image_input: e.target.checked })}
            />
            逐张喂图
          </label>
          {sliceOn && (
            <label className="scv-loop-field">
              每轮张数
              <input
                className="scv-loop-num"
                type="number"
                min={1}
                max={100}
                value={batch}
                title="每轮从上游图片列表里取几张。切一套 UI 图时按这个分批"
                onFocus={() => snapshot()}
                onChange={(e) =>
                  updateNode(node.id, {
                    image_batch_size: Math.max(1, Math.min(Number(e.target.value) || 1, 100)),
                  })
                }
              />
            </label>
          )}
          <p className="scv-loop-tip">
            {sliceOn
              ? `第 n 轮取上游第 ${loopStart} 张起的 ${batch} 张 —— 把一组图逐批处理用这个`
              : '不开时每轮都用同一批上游参考图'}
          </p>
        </div>
      )}

      <div className="scv-loop-act">
        {mine ? (
          <button
            className="btn btn-outline btn-sm nodrag"
            disabled={cascade.stopRequested}
            onClick={() => stopCascade()}
          >
            {cascade.stopRequested ? '收尾中…' : '停止'}
          </button>
        ) : (
          <>
            <span
              className="scv-loop-plan"
              title={`${planNodes} 个执行节点 × ${planRounds} 轮 = ${planGens} 次调用。级联只沿 input（参考输入）边走，所以这个数跑几次都一样`}
            >
              共 {planGens} 次调用
            </span>
            <button
              className="btn btn-primary btn-sm nodrag"
              disabled={busy}
              title="从这个循环的直接下游开始，沿 input 边逐节点生成"
              onClick={() => void runCascade(node.id)}
            >
              运行这条链
            </button>
          </>
        )}
      </div>
    </div>
  )
}

export const LoopNode = memo(LoopNodeView, sameNodeData)

/** 组内的一格。**不是死图**：双击看大图、悬停出叉号删掉、拖出来变回独立节点。
 *
 *  拖出的判定放在 12px 之后，是为了不和「点一下选中」打架；越过阈值才 `nodrag`
 *  接管指针，在那之前指针事件照常冒泡给外壳（否则想拖整个分组框反而拖不动）。 */
function ItemCell({
  hostId,
  item,
  index,
  current,
  size,
  aspect,
  onMeasure,
}: {
  hostId: string
  item: CanvasItem
  index: number
  /** 当前选中的那张，描边用 */
  current?: number
  /** 固定格子边长（分组网格用）。多图节点让 CSS 决定 */
  size?: number
  /** 格子的长宽比（多图节点用）。缺省 = 由 CSS 兜的方格 */
  aspect?: number
  /** 图落地时把量到的比例交回上层。分组网格的格子是固定方的，不需要 */
  onMeasure?: (item: CanvasItem, el: HTMLImageElement) => void
}): JSX.Element {
  const drag = useRef<{ id: number; sx: number; sy: number; out: boolean } | null>(null)
  const [pulling, setPulling] = useState(false)

  return (
    <div
      className={[
        'scv-gcell',
        pulling ? 'scv-gcell-pull' : '',
        item.asset_id !== undefined && item.asset_id === current ? 'scv-cell-on' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={
        size !== undefined
          ? { width: size, height: size }
          : aspect === undefined
            ? undefined
            : { aspectRatio: aspectStyle(aspect) }
      }
      data-asset={item.asset_id}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        drag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, out: false }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (d === null || d.id !== e.pointerId) return
        if (!d.out && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 12) {
          d.out = true
          setPulling(true)
          capturePointer(e.currentTarget, e.pointerId)
        }
      }}
      onPointerUp={(e) => {
        const d = drag.current
        drag.current = null
        if (d === null || !d.out) return
        releasePointer(e.currentTarget, e.pointerId)
        setPulling(false)
        const p = screenToCanvas(e.clientX, e.clientY)
        extractItem(hostId, index, p.x, p.y)
      }}
      onPointerCancel={() => {
        drag.current = null
        setPulling(false)
      }}
    >
      {item.missing === true ? (
        <div className="scv-missing-item"><ImagePlus /><span>文件缺失</span></div>
      ) : (
        <img
          src={itemSrc(item, 'thumb')}
          alt=""
          draggable={false}
          data-asset={item.asset_id}
          onLoad={(event) => onMeasure?.(item, event.currentTarget)}
        />
      )}
      <button
        className="scv-gcell-x nodrag"
        title="从节点里移除这张（图还在资产库里）"
        onClick={(e) => {
          e.stopPropagation()
          removeFromGroup(hostId, index)
        }}
      >
        <X />
      </button>
    </div>
  )
}

/** 分组节点（FR-461 group）：画布中的画布。图片拖进来被吸收成组内网格，
    提示词节点拖进来算成员（原节点还在，只是归属挂到这里）。 */
function GroupNodeView({ data }: CanvasNodeViewProps) {
  const { node } = data
  const items = node.items ?? []
  // 成员可能已被删掉，按当前节点表过滤，别显示一个指不到人的数字。
  // 只吐一个数字：订阅整个 nodes 数组会让每次拖拽都把所有分组节点重渲染一遍
  const members = useCanvasStore(
    (s) => (node.member_ids ?? []).filter((id) => s.nodes.some((n) => n.id === id)).length,
  )
  const { w, h } = groupSize(node)
  return (
    <div className="scv-node scv-group" style={{ width: w, height: h }}>
      <div className="scv-node-title">
        <span>{node.title ?? '分组'}</span>
        <span className="scv-count">
          {items.length} 图{members > 0 ? ` · ${members} 成员` : ''}
        </span>
      </div>
      <div className="scv-group-body">
        {items.length === 0 ? (
          <div className="scv-group-drop">把图片节点拖进来会被吸收成组内网格</div>
        ) : (
          items.map((it, i) => (
            <ItemCell
              key={it.asset_id ?? `${it.url}-${i}`}
              hostId={node.id}
              item={it}
              index={i}
              size={GROUP_CELL}
            />
          ))
        )}
      </div>
      <div className="scv-group-act">
        <span className="scv-group-note">整组当参考：组内图全部上送，成员文本与媒体按连接语义传递</span>
      </div>
    </div>
  )
}

export const GroupNode = memo(GroupNodeView, sameNodeData)
