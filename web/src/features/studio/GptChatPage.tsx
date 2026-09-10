/* GPT 创作对话（模块 17 FR-476）。

   通用多模态对话：文字走语义别名 chat-general，模型自己判断要出图时走 image-free，
   产图照旧经模块 16 入库（BR-140/141）——这一页只负责发起、读流、呈现。

   持久化归服务端：turns 由 /studio/gpt-chats/{id}/send 边跑边写，前端不另存一份
   （与对话生图那条线相反，那边是前端 PUT 全量）。「停止」因此走 AbortController：
   这次 HTTP 请求是真断了，不是只停止渲染。

   > [!warning] 断掉之后服务端存不存这一轮，**问过才知道，不许替它宣称**
   >
   > `stream_turn` 的 finally 是想落库的，但 2026-08-20 实测（前端点停止、curl
   > `--max-time` 半路掐，两种断法都试过）：断流之后会话里 `turns` 仍是 0 —— 取消
   > 传播下来，finally 里的 `await` 又吃到 CancelledError，那是 BaseException，
   > 它自己的 `except Exception` 兜不住。已经出的图不受影响（出图那一刻就 commit
   > 进资产库了）。
   >
   > 所以这一页不写「已经存下来了」这种话，改成停止后**真去回读**，按结果分三种说法：
   > 回读到了说回读到了、没回读到就说服务端没留下这一轮，中间那段等待期照实说在确认。
   > 无论哪种都不拿空结果盖掉用户已经看见的字。 */

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AudioLines, ChevronDown, FileText, Paperclip, Upload, Video } from '@/components/NexusIcon'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'

import {
  IconAlert,
  IconArrowUpRight,
  IconChat,
  IconClose,
  IconDownload,
  IconEdit,
  IconImage,
  IconPlus,
  IconSearch,
  IconSend,
  IconSettings,
  IconStar,
  IconTrash,
} from '@/components/icons'
import { Overlay } from '@/components/Overlay'
import { useConsoleStore } from '@/features/image/consoleStore'
import type { ImageAsset } from '@/lib/api-image'
import { ApiImageError, apiImage } from '@/lib/api-image'
import { ModelPicker, defaultModelOf } from '@/components/model-picker/ModelPicker'
import { apiConfig } from '@/lib/api-config'
import type {
  CanvasNode,
  GptChatSummary,
  GptTurn,
  StudioMediaAsset,
} from '@/lib/api-studio'
import { apiStudio } from '@/lib/api-studio'

import { AssetPicker } from './AssetPicker'
import { IMAGE_NODE_W, newNodeId } from './canvasStore'
import {
  GPT_ATTACHMENT_MAX,
  GPT_IMAGE_SIZES,
  GPT_RATIO_LABELS,
  appendLiveTask,
  gptDeploymentsForScope,
  resolveGptImageSize,
} from './gpt-chat-controls'
import type {
  GptImageLevel,
  GptLiveTask,
  GptImageRatio,
  GptImageSizeMode,
  GptModelScope,
} from './gpt-chat-controls'
import './gpt-chat.css'

/** 不显式选部署时跟随这两个能力绑定。 */
const CHAT_ALIAS = 'chat-general'
const IMAGE_ALIAS = 'image-free'
/** 弹窗里「跟随全局绑定」这一档的内部值；它不是模型 id */
const GLOBAL_DEPLOYMENT = 'global'
const MODEL_STORAGE_KEY = 'studio-gpt-models'
const SIZE_STORAGE_KEY = 'studio-gpt-image-size'

function storedJson(key: string): Record<string, unknown> {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? '{}')
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function deploymentName(item: { display_name: string | null; upstream_model_id: string }): string {
  return item.display_name?.trim() || item.upstream_model_id
}

/** 流中断的四种收尾，都不是失败：
 *  - `stopped`  刚按下停止，正在问服务端这一轮存没存
 *  - `synced`   问到了：下面这一轮是服务端存的记录
 *  - `unsaved`  问过了：服务端没有这一轮，上面那段只在当前页面
 *  - `broken`   流在没给结束事件时自己断了 */
type TurnNote = 'stopped' | 'synced' | 'unsaved' | 'broken'

/** 停止后等多久回读一次。服务端把这一轮写进库是在流关掉之后的 finally 里，
 *  贴着 abort 就去 GET 多半只能拿到旧的 turns，白白盖掉本地已收到的内容 */
const RELOAD_DELAYS_MS = [700, 1800]

interface LiveShot {
  assetId: number
  url: string
  prompt: string
}

/** 正在流式的那一轮。落定后转成 GptTurn 进 turns，live 清空 */
interface LiveState {
  chatId: number
  startedAt: number
  /** meta 事件给的对话模型名，显示在气泡角落 */
  model: string | null
  text: string
  shots: LiveShot[]
  /** 这一轮提交的后台任务回执。产物不在这条流里，由任务中心那条补 */
  tasks: GptLiveTask[]
}

/** 资产按 id 取一次、全页共享缓存：用户带的图、Agent 出的图都从这里拿 URL */
function useAsset(id: number) {
  return useQuery({
    queryKey: ['sgc-asset', id],
    queryFn: () => apiImage.asset(id),
    staleTime: Infinity,
    retry: 1,
  })
}

function useMediaAsset(id: number) {
  return useQuery({
    queryKey: ['sgc-media-asset', id],
    queryFn: () => apiStudio.mediaAsset(id),
    staleTime: Infinity,
    retry: 1,
  })
}

/** 把一张图挂到画布右侧空处。只加节点不动别人的，409 就重取最新全量再挂一次 */
async function attachToCanvas(canvasId: number, asset: ImageAsset): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    const detail = await apiStudio.canvas(canvasId)
    const x =
      detail.nodes.length === 0
        ? 0
        : Math.max(...detail.nodes.map((n) => n.x + (n.w ?? IMAGE_NODE_W))) + 60
    const y = detail.nodes.length === 0 ? 0 : Math.min(...detail.nodes.map((n) => n.y))
    const node: CanvasNode = {
      id: newNodeId(),
      type: 'image',
      x,
      y,
      w: IMAGE_NODE_W,
      title: 'GPT 对话',
      items: [{ asset_id: asset.id, kind: 'image', w: asset.width, h: asset.height }],
      prompt_draft: asset.prompt,
    }
    try {
      await apiStudio.saveCanvas(canvasId, {
        nodes: [...detail.nodes, node],
        connections: detail.connections,
        viewport: detail.viewport ?? { x: 0, y: 0, scale: 1 },
        settings: detail.settings,
        base_version: detail.version,
      })
      return
    } catch (e) {
      if (!(e instanceof ApiImageError && e.status === 409) || attempt >= 2) throw e
    }
  }
}

/* ==================== 小件 ==================== */

/** 用户气泡里带的图 / 输入区待发的图，点开看大图 */
function Thumb({ id, onOpen }: { id: number; onOpen: (asset: ImageAsset) => void }) {
  const asset = useAsset(id)
  if (asset.isError) return <span className="sgc-thumb sgc-thumb-gone">图已不在资产库</span>
  if (asset.data === undefined) return <span className="sgc-thumb sgc-ph" />
  const item = asset.data
  return (
    <button className="sgc-thumb" title={item.prompt} onClick={() => onOpen(item)}>
      <img src={item.thumb_url} alt="" loading="lazy" />
    </button>
  )
}

function MediaChip({ id }: { id: number }) {
  const query = useMediaAsset(id)
  if (query.isError) return <span className="sgc-file sgc-file-gone">附件已不在资产库</span>
  if (query.data === undefined) return <span className="sgc-file sgc-ph" />
  const asset = query.data
  const KindIcon = asset.kind === 'video' ? Video : asset.kind === 'audio' ? AudioLines : FileText
  return (
    <a className="sgc-file" href={asset.url} target="_blank" rel="noreferrer" title={`打开 ${asset.name}`}>
      <KindIcon />
      <span>{asset.name}</span>
    </a>
  )
}

/** AI 气泡里的一张产图。提示词取当时那条 image 事件的原文，重新载入后回落到资产上存的 */
function ShotCard({
  assetId,
  streamedPrompt,
  streamedUrl,
  onView,
  onToCanvas,
  onToConsole,
}: {
  assetId: number
  streamedPrompt?: string
  streamedUrl?: string
  onView: (asset: ImageAsset) => void
  onToCanvas: (asset: ImageAsset) => void
  onToConsole: (asset: ImageAsset) => void
}) {
  const asset = useAsset(assetId)
  const item = asset.data
  const prompt = streamedPrompt ?? item?.prompt ?? ''
  if (asset.isError && streamedUrl === undefined) {
    return <div className="sgc-card sgc-card-gone">图已不在资产库（id {assetId}）</div>
  }
  const src = item?.url ?? streamedUrl
  return (
    <figure className="sgc-card">
      {src === undefined ? (
        <div className="sgc-card-img sgc-ph" />
      ) : (
        <img
          className="sgc-card-img"
          src={src}
          alt={prompt}
          loading="lazy"
          onClick={() => item !== undefined && onView(item)}
        />
      )}
      {prompt !== '' && (
        <figcaption className="sgc-card-prompt" title={prompt}>
          <span className="sgc-card-tag">出图提示词</span>
          {prompt}
        </figcaption>
      )}
      <div className="sgc-card-acts">
        <button
          className="sgc-act"
          title="查看大图"
          disabled={item === undefined}
          onClick={() => item !== undefined && onView(item)}
        >
          <IconSearch />
        </button>
        <a
          className={item === undefined ? 'sgc-act sgc-act-off' : 'sgc-act'}
          title="下载原图"
          href={item?.full_url ?? '#'}
          download
        >
          <IconDownload />
        </a>
        <button
          className="sgc-act"
          title="送去画布"
          disabled={item === undefined}
          onClick={() => item !== undefined && onToCanvas(item)}
        >
          <IconPlus />
        </button>
        <button
          className="sgc-act"
          title="送去控制台改"
          disabled={item === undefined}
          onClick={() => item !== undefined && onToConsole(item)}
        >
          <IconArrowUpRight />
        </button>
      </div>
    </figure>
  )
}

/** AI 那一轮：正文 + 出图卡 + 中断说明 + 失败原文。

    正文与失败可以同时存在——流到一半才炸的话，已经写出来的字不该被错误吞掉。 */
function AiTurn({
  turn,
  model,
  note,
  promptOf,
  onView,
  onToCanvas,
  onToConsole,
  onRetry,
  onReload,
}: {
  turn: GptTurn
  model?: string
  note?: TurnNote
  promptOf: (assetId: number) => string | undefined
  onView: (asset: ImageAsset) => void
  onToCanvas: (asset: ImageAsset) => void
  onToConsole: (asset: ImageAsset) => void
  onRetry: () => void
  onReload: () => void
}) {
  const shots = turn.asset_ids ?? []
  const hasBody = turn.content !== '' || shots.length > 0
  const hasError = turn.error !== undefined && turn.error !== ''

  if (hasError && !hasBody) {
    return (
      <div className="sgc-bubble-err">
        <IconAlert />
        <span className="sgc-err-text">{turn.error}</span>
        <button className="btn btn-outline sgc-retry" onClick={onRetry}>
          重试
        </button>
      </div>
    )
  }

  return (
    <div className="sgc-bubble-ai">
      {turn.content !== '' && <p className="sgc-text">{turn.content}</p>}
      {shots.length > 0 && (
        <div className="sgc-cards">
          {shots.map((id) => (
            <ShotCard
              key={id}
              assetId={id}
              streamedPrompt={promptOf(id)}
              onView={onView}
              onToCanvas={onToCanvas}
              onToConsole={onToConsole}
            />
          ))}
        </div>
      )}
      {!hasBody && !hasError && <p className="sgc-text sgc-empty-turn">（这一轮没有内容）</p>}
      {hasError && (
        <div className="sgc-err-strip">
          <IconAlert />
          <span className="sgc-err-text">{turn.error}</span>
          <button className="btn btn-outline sgc-retry" onClick={onRetry}>
            重试
          </button>
        </div>
      )}
      {note !== undefined && (
        <div className={note === 'synced' ? 'sgc-note sgc-note-ok' : 'sgc-note'}>
          <span>
            {note === 'stopped'
              ? '已中断这次请求。上面是断掉前收到的部分，正在问服务端这一轮存没存下来…'
              : note === 'synced'
                ? '上面这一轮是从服务端回读的记录——服务端把它存下来了。'
                : note === 'unsaved'
                  ? '已中断这次请求。问过服务端了，会话里没有这一轮（它在写库前就被取消了）：上面这段只在当前页面，刷新就没了。这一路已经出的图不受影响，出图那一刻就进资产库了。'
                  : '流在收到结束事件前断了。已收到的留在上面，完整内容以服务端为准。'}
          </span>
          {note !== 'synced' && note !== 'stopped' && (
            <button className="btn btn-outline sgc-note-btn" onClick={onReload}>
              {note === 'unsaved' ? '再问一次服务端' : '载入服务端存下的内容'}
            </button>
          )}
        </div>
      )}
      <div className="sgc-meta">
        {model !== undefined && <span className="sgc-model">{model}</span>}
        {turn.latency_ms !== undefined && <span>{(turn.latency_ms / 1000).toFixed(1)}s</span>}
      </div>
    </div>
  )
}

/** 左栏一条会话 */
function SessionRow({
  item,
  active,
  onOpen,
  onPin,
  onRename,
  onDelete,
}: {
  item: GptChatSummary
  active: boolean
  onOpen: () => void
  onPin: () => void
  onRename: () => void
  onDelete: () => void
}) {
  return (
    <div className={active ? 'sgc-sess on' : 'sgc-sess'} onClick={onOpen}>
      <span className="sgc-sess-body">
        <span className="sgc-sess-title">
          {item.pinned && <IconStar filled className="sgc-sess-pin" />}
          {item.title}
        </span>
        <span className="sgc-sess-sub">{item.turn_count} 轮</span>
      </span>
      <span className="sgc-sess-acts" onClick={(e) => e.stopPropagation()}>
        <button title={item.pinned ? '取消置顶' : '置顶'} onClick={onPin}>
          <IconStar filled={item.pinned} />
        </button>
        <button title="重命名" onClick={onRename}>
          <IconEdit />
        </button>
        <button title="删除" onClick={onDelete}>
          <IconTrash />
        </button>
      </span>
    </div>
  )
}

/* ==================== 浮层 ==================== */

function RenameDialog({
  initial,
  onSave,
  onClose,
}: {
  initial: string
  onSave: (title: string) => void
  onClose: () => void
}) {
  const [val, setVal] = useState(initial)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const submit = () => {
    const title = val.trim()
    if (title !== '') onSave(title)
  }
  // Esc 两段式：改了名还没保存时，第一次 Esc 只失焦（STD-UI-002b）
  const requestClose = () => {
    if (document.activeElement === inputRef.current && val !== initial) {
      inputRef.current?.blur()
      return
    }
    onClose()
  }
  return (
    <Overlay onClose={requestClose} card="sgc-dialog" labelledBy="sgc-rename-title">
      <div className="overlay-head">
        <span className="overlay-title" id="sgc-rename-title">
          重命名会话
        </span>
      </div>
      <input
        ref={inputRef}
        className="sgc-dialog-input"
        value={val}
        autoFocus
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit()
        }}
      />
      <div className="sgc-dialog-foot">
        <button className="btn btn-outline" onClick={onClose}>
          取消
        </button>
        <button className="btn btn-primary" disabled={val.trim() === ''} onClick={submit}>
          保存
        </button>
      </div>
    </Overlay>
  )
}

function DeleteConfirm({
  title,
  onConfirm,
  onClose,
}: {
  title: string
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Overlay onClose={onClose} card="sgc-dialog" labelledBy="sgc-del-title">
      <div className="overlay-head">
        <span className="overlay-title" id="sgc-del-title">
          删除会话
        </span>
      </div>
      <p className="sgc-dialog-text">
        「{title}」的全部轮次会一起删掉；这一路出的图仍在资产库，不受影响。
      </p>
      <div className="sgc-dialog-foot">
        <button className="btn btn-outline" onClick={onClose}>
          取消
        </button>
        <button className="btn btn-primary sgc-danger" onClick={onConfirm}>
          删除
        </button>
      </div>
    </Overlay>
  )
}

/** 设置：会话级系统提示词。模型是每轮选择，放在输入区。 */
function SettingsDialog({
  initial,
  onSave,
  onClose,
}: {
  initial: string
  onSave: (systemPrompt: string) => void
  onClose: () => void
}) {
  const [val, setVal] = useState(initial)
  const areaRef = useRef<HTMLTextAreaElement | null>(null)
  const requestClose = () => {
    if (document.activeElement === areaRef.current && val !== initial) {
      areaRef.current?.blur()
      return
    }
    onClose()
  }
  return (
    <Overlay onClose={requestClose} card="sgc-settings" labelledBy="sgc-settings-title">
      <div className="overlay-head">
        <span className="overlay-title" id="sgc-settings-title">
          会话设置
        </span>
        <button className="btn-ghost-sm" title="关闭" onClick={onClose}>
          <IconClose />
        </button>
      </div>

      <label className="sgc-settings-label" htmlFor="sgc-sysprompt">
        系统提示词
      </label>
      <textarea
        id="sgc-sysprompt"
        ref={areaRef}
        className="sgc-settings-area"
        rows={7}
        placeholder="留空则用服务端默认的系统提示词"
        value={val}
        onChange={(e) => setVal(e.target.value)}
      />

      <div className="sgc-settings-note">
        <p>
          每轮的对话模型和出图模型在输入框上方选，只影响这个会话，不改设置里的绑定。
          选「跟随全局默认」就走设置 · 模型服务里「创作对话」与「自由出图」当前绑的模型。
        </p>
        <p>
          那两个用途都没绑、全局默认也没设时后端会直接报错，那条原文会原样显示在对话里——不会伪装成「模型思考中」
          让人干等。
        </p>
      </div>

      <div className="sgc-dialog-foot">
        <button className="btn btn-outline" onClick={onClose}>
          取消
        </button>
        <button className="btn btn-primary" onClick={() => onSave(val)}>
          保存
        </button>
      </div>
    </Overlay>
  )
}

/** 看大图，顺带给三个去处 */
function Viewer({
  asset,
  onToCanvas,
  onToConsole,
  onClose,
}: {
  asset: ImageAsset
  onToCanvas: (asset: ImageAsset) => void
  onToConsole: (asset: ImageAsset) => void
  onClose: () => void
}) {
  return (
    <Overlay onClose={onClose} card="sgc-viewer" labelledBy="sgc-viewer-title">
      <div className="overlay-head">
        <span className="overlay-title" id="sgc-viewer-title">
          {asset.width} × {asset.height}
        </span>
        <button className="btn-ghost-sm" title="关闭" onClick={onClose}>
          <IconClose />
        </button>
      </div>
      <div className="sgc-viewer-stage">
        <img src={asset.url} alt={asset.prompt} />
      </div>
      {asset.prompt !== '' && <p className="sgc-viewer-prompt">{asset.prompt}</p>}
      <div className="sgc-dialog-foot">
        <button className="btn btn-outline" onClick={() => onToCanvas(asset)}>
          送去画布
        </button>
        <button className="btn btn-outline" onClick={() => onToConsole(asset)}>
          送去控制台
        </button>
        <a className="btn btn-primary" href={asset.full_url} download>
          下载原图
        </a>
      </div>
    </Overlay>
  )
}

/** 挑一张画布把图挂上去。新建也在这里，省得跳出去再回来 */
function CanvasPicker({
  onPick,
  onClose,
  busy,
}: {
  onPick: (canvasId: number | 'new') => void
  onClose: () => void
  busy: boolean
}) {
  const list = useQuery({ queryKey: ['sgc-canvases'], queryFn: () => apiStudio.canvases() })
  const items = list.data?.items ?? []
  return (
    <Overlay onClose={onClose} card="sgc-canvas-pick" labelledBy="sgc-canvas-title">
      <div className="overlay-head">
        <span className="overlay-title" id="sgc-canvas-title">
          送去画布
        </span>
        <button className="btn-ghost-sm" title="关闭" onClick={onClose}>
          <IconClose />
        </button>
      </div>
      <div className="sgc-canvas-list">
        {list.isLoading && <p className="sgc-dialog-text">读取画布…</p>}
        {list.isError && (
          <p className="sgc-dialog-text">
            画布列表读取失败：{list.error instanceof Error ? list.error.message : '未知错误'}
          </p>
        )}
        {items.map((c) => (
          <button
            key={c.id}
            className="sgc-canvas-row"
            disabled={busy}
            onClick={() => onPick(c.id)}
          >
            <span className="sgc-canvas-name">{c.title}</span>
            <span className="sgc-canvas-sub">{c.node_count} 个节点</span>
          </button>
        ))}
        {list.data !== undefined && items.length === 0 && (
          <p className="sgc-dialog-text">还没有画布，新建一张就能把这张图放上去</p>
        )}
      </div>
      <div className="sgc-dialog-foot">
        <span className="sgc-dialog-hint">图会作为新节点挂在画布最右侧</span>
        <button className="btn btn-primary" disabled={busy} onClick={() => onPick('new')}>
          {busy ? '正在写入…' : '新建画布并放入'}
        </button>
      </div>
    </Overlay>
  )
}

/* ==================== 页面 ==================== */

export default function GptChatPage() {
  const params = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const parsedId = params.chatId === undefined ? Number.NaN : Number(params.chatId)
  const openId = Number.isInteger(parsedId) && parsedId > 0 ? parsedId : null

  const chatsQ = useQuery({ queryKey: ['sgc-chats'], queryFn: apiStudio.gptChats })
  const deploymentsQ = useQuery({
    queryKey: ['cfg-model-deployments', 'gpt-chat'],
    queryFn: () => apiConfig.modelDeployments({ enabled: true }),
  })
  const pluginsQ = useQuery({
    queryKey: ['cfg-model-plugins', 'gpt-chat'],
    queryFn: apiConfig.modelPlugins,
  })
  // 「跟随全局绑定」这一档要显示真名，不能把 chat-general 这种路由键摆到「模型」位上（核心原则 6）
  const bindingsQ = useQuery({ queryKey: ['cfg-bindings'], queryFn: apiConfig.bindings })
  const chatDeployments = useMemo(
    () => gptDeploymentsForScope(deploymentsQ.data ?? [], pluginsQ.data ?? [], 'chat'),
    [deploymentsQ.data, pluginsQ.data],
  )
  const imageDeployments = useMemo(
    () => gptDeploymentsForScope(deploymentsQ.data ?? [], pluginsQ.data ?? [], 'image'),
    [deploymentsQ.data, pluginsQ.data],
  )
  const sessions = useMemo(() => {
    const items = chatsQ.data?.items ?? []
    return [...items].sort(
      (a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at.localeCompare(a.updated_at),
    )
  }, [chatsQ.data])

  // ---- 会话详情 ----
  const [turns, setTurns] = useState<GptTurn[]>([])
  const [meta, setMeta] = useState<{ title: string; pinned: boolean; systemPrompt: string } | null>(
    null,
  )
  const [loadError, setLoadError] = useState<string | null>(null)
  const turnsRef = useRef<GptTurn[]>([])
  const openIdRef = useRef<number | null>(null)
  openIdRef.current = openId

  /** 本会话内才有的附注：模型名（服务端 turn 里不存）与中断标记 */
  const [models, setModels] = useState<Record<number, string>>({})
  const [notes, setNotes] = useState<Record<number, TurnNote>>({})
  /** 流里 image 事件带的提示词，按资产 id 存着给图片卡用 */
  const [shotPrompts, setShotPrompts] = useState<Record<number, string>>({})

  // ---- 流式 ----
  const [live, setLive] = useState<LiveState | null>(null)
  const liveRef = useRef<LiveState | null>(null)
  const [sending, setSending] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  /** 每次发送一个序号：停止或切会话时递增，之前那条流的后续事件一律丢弃 */
  const runRef = useRef(0)
  /** 在跑那一轮的中断闸。停止/切会话/离开页面都拿它真断请求 */
  const abortRef = useRef<AbortController | null>(null)

  // ---- 输入 ----
  const [draft, setDraft] = useState('')
  const [picked, setPicked] = useState<ImageAsset[]>([])
  const [pickedMedia, setPickedMedia] = useState<StudioMediaAsset[]>([])
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  const [chatDeployment, setChatDeployment] = useState(
    () => String(storedJson(MODEL_STORAGE_KEY).chat ?? GLOBAL_DEPLOYMENT),
  )
  const [imageDeployment, setImageDeployment] = useState(
    () => String(storedJson(MODEL_STORAGE_KEY).image ?? GLOBAL_DEPLOYMENT),
  )
  const [pickerScope, setPickerScope] = useState<GptModelScope | null>(null)
  const modelPickerRef = useRef<HTMLDivElement | null>(null)

  const savedSize = storedJson(SIZE_STORAGE_KEY)
  const [sizeMode, setSizeMode] = useState<GptImageSizeMode>(() =>
    ['auto', 'preset', 'custom'].includes(String(savedSize.mode))
      ? savedSize.mode as GptImageSizeMode
      : 'auto',
  )
  const [sizeRatio, setSizeRatio] = useState<GptImageRatio>(() =>
    Object.hasOwn(GPT_IMAGE_SIZES, String(savedSize.ratio))
      ? savedSize.ratio as GptImageRatio
      : 'square',
  )
  const [sizeLevel, setSizeLevel] = useState<GptImageLevel>(() =>
    ['1k', '2k', '4k'].includes(String(savedSize.level))
      ? savedSize.level as GptImageLevel
      : '1k',
  )
  const [customWidth, setCustomWidth] = useState(() => String(savedSize.width ?? '1024'))
  const [customHeight, setCustomHeight] = useState(() => String(savedSize.height ?? '1024'))
  const [sizeOpen, setSizeOpen] = useState(false)
  const sizePickerRef = useRef<HTMLDivElement | null>(null)

  // ---- 浮层 ----
  const [picking, setPicking] = useState(false)
  const [viewing, setViewing] = useState<ImageAsset | null>(null)
  const [renaming, setRenaming] = useState<{ id: number; title: string } | null>(null)
  const [deleting, setDeleting] = useState<{ id: number; title: string } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [toCanvas, setToCanvas] = useState<ImageAsset | null>(null)
  const [canvasBusy, setCanvasBusy] = useState(false)

  const attachmentCount = picked.length + pickedMedia.length
  const resolvedImageSize = useMemo(
    () => resolveGptImageSize(
      sizeMode,
      draft,
      sizeRatio,
      sizeLevel,
      Number(customWidth),
      Number(customHeight),
    ),
    [customHeight, customWidth, draft, sizeLevel, sizeMode, sizeRatio],
  )
  const selectedChat = chatDeployments.find((item) => String(item.id) === chatDeployment)
  const selectedImage = imageDeployments.find((item) => String(item.id) === imageDeployment)
  const chatModelLabel =
    selectedChat === undefined
      ? defaultModelOf(bindingsQ.data, CHAT_ALIAS) ?? '跟随设置'
      : deploymentName(selectedChat)
  const imageModelLabel =
    selectedImage === undefined
      ? defaultModelOf(bindingsQ.data, IMAGE_ALIAS) ?? '跟随设置'
      : deploymentName(selectedImage)
  useEffect(() => {
    window.localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify({
      chat: chatDeployment,
      image: imageDeployment,
    }))
  }, [chatDeployment, imageDeployment])

  useEffect(() => {
    if (deploymentsQ.data === undefined || pluginsQ.data === undefined) return
    if (
      chatDeployment !== GLOBAL_DEPLOYMENT
      && !chatDeployments.some((item) => String(item.id) === chatDeployment)
    ) setChatDeployment(GLOBAL_DEPLOYMENT)
    if (
      imageDeployment !== GLOBAL_DEPLOYMENT
      && !imageDeployments.some((item) => String(item.id) === imageDeployment)
    ) setImageDeployment(GLOBAL_DEPLOYMENT)
  }, [
    chatDeployment,
    chatDeployments,
    deploymentsQ.data,
    imageDeployment,
    imageDeployments,
    pluginsQ.data,
  ])

  useEffect(() => {
    window.localStorage.setItem(SIZE_STORAGE_KEY, JSON.stringify({
      mode: sizeMode,
      ratio: sizeRatio,
      level: sizeLevel,
      width: customWidth,
      height: customHeight,
    }))
  }, [customHeight, customWidth, sizeLevel, sizeMode, sizeRatio])

  useEffect(() => {
    // 模型弹层已交给 components/Overlay：它自带浮层栈、Esc 与点遮罩关闭，这里只剩画幅那个
    const close = (event: PointerEvent) => {
      const node = event.target as Node
      if (sizePickerRef.current !== null && !sizePickerRef.current.contains(node)) setSizeOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSizeOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [])

  const addFiles = useCallback(
    async (files: File[]) => {
      const usable = files.filter((file) => file.size > 0)
      const remaining = GPT_ATTACHMENT_MAX - attachmentCount
      if (remaining <= 0 || usable.length === 0) {
        if (remaining <= 0) toast.error(`一轮最多携带 ${GPT_ATTACHMENT_MAX} 个附件`)
        return
      }
      const accepted = usable.slice(0, remaining)
      if (usable.length > remaining) toast.info(`只取前 ${remaining} 个，一轮上限 ${GPT_ATTACHMENT_MAX} 个`)
      setUploading(true)
      const images: ImageAsset[] = []
      const media: StudioMediaAsset[] = []
      const failures: string[] = []
      for (const file of accepted) {
        try {
          if (file.type.startsWith('image/')) {
            const form = new FormData()
            form.set('image', file)
            form.set('op', 'upload')
            const asset = await apiImage.saveLocal(form)
            images.push(asset)
            queryClient.setQueryData(['sgc-asset', asset.id], asset)
          } else {
            const asset = await apiStudio.uploadMediaAsset(file)
            media.push(asset)
            queryClient.setQueryData(['sgc-media-asset', asset.id], asset)
          }
        } catch (error) {
          failures.push(`${file.name}：${error instanceof Error ? error.message : '上传失败'}`)
        }
      }
      setPicked((current) => [
        ...current,
        ...images.filter((asset) => !current.some((item) => item.id === asset.id)),
      ])
      setPickedMedia((current) => [
        ...current,
        ...media.filter((asset) => !current.some((item) => item.id === asset.id)),
      ])
      setUploading(false)
      if (failures.length > 0) toast.error(failures.slice(0, 3).join('\n'))
    },
    [attachmentCount, queryClient],
  )

  useEffect(() => {
    const paste = (event: globalThis.ClipboardEvent) => {
      const files = [...(event.clipboardData?.files ?? [])]
      if (files.length === 0) return
      event.preventDefault()
      void addFiles(files)
    }
    window.addEventListener('paste', paste)
    return () => window.removeEventListener('paste', paste)
  }, [addFiles])

  const applyLive = useCallback((next: LiveState | null) => {
    liveRef.current = next
    setLive(next)
  }, [])

  const commitTurns = useCallback((next: GptTurn[]) => {
    turnsRef.current = next
    setTurns(next)
  }, [])

  const appendTurn = useCallback(
    (turn: GptTurn, note?: TurnNote, model?: string | null) => {
      const index = turnsRef.current.length
      commitTurns([...turnsRef.current, turn])
      if (note !== undefined) setNotes((n) => ({ ...n, [index]: note }))
      if (model !== undefined && model !== null && model !== '') {
        setModels((m) => ({ ...m, [index]: model }))
      }
    },
    [commitTurns],
  )

  // 换会话：清干净再取。还在跑的那条流在 cleanup 里真断掉（离开页面同理）
  useEffect(() => {
    runRef.current += 1
    commitTurns([])
    applyLive(null)
    setSending(false)
    setMeta(null)
    setLoadError(null)
    setModels({})
    setNotes({})
    setShotPrompts({})
    setPicked([])
    setPickedMedia([])
    if (openId === null) return
    let alive = true
    apiStudio
      .gptChat(openId)
      .then((d) => {
        if (!alive) return
        commitTurns(d.turns)
        setMeta({ title: d.title, pinned: d.pinned, systemPrompt: d.system_prompt })
      })
      .catch((e: Error) => {
        if (alive) setLoadError(e.message)
      })
    return () => {
      alive = false
      // 切会话与离开页面都走这里：不断的话请求继续挂着，服务端那一轮也白跑到底
      abortRef.current?.abort()
      abortRef.current = null
    }
  }, [openId, commitTurns, applyLive])

  // 流式期间的秒表：显示真实已跑时长，不伪造进度。
  // 依赖只能是 startedAt——挂 live 对象的话每个 delta 都换新对象，秒表会一直被重置成 0
  const liveStartedAt = live?.startedAt ?? null
  useEffect(() => {
    if (!sending || liveStartedAt === null) return
    setElapsed(0)
    const timer = window.setInterval(() => {
      setElapsed(Math.max(0, Math.floor((Date.now() - liveStartedAt) / 1000)))
    }, 500)
    return () => window.clearInterval(timer)
  }, [sending, liveStartedAt])

  // 贴底时才跟着滚，用户翻上去看历史就别抢滚动条。显式 auto——smooth 在内嵌面板里会被吞掉
  const streamRef = useRef<HTMLDivElement | null>(null)
  const liveTick = (live?.text.length ?? 0) + (live?.shots.length ?? 0)
  useEffect(() => {
    const el = streamRef.current
    if (el === null) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight
  }, [turns.length, liveTick, openId])

  /** 按服务端最新记录整页刷新。中断之后要看这一轮的实际结果，走的就是这条。
   *
   *  `minTurns` 是给自动回读用的护栏：服务端还没把这一轮写完时回来的 turns 比本地少，
   *  照单全收就等于拿空结果盖掉用户已经看见的字。少了就整条放弃，返回 false 让调用方
   *  再等一会儿；手动点按钮时不传，用户主动要的就以服务端为准。
   *  `note` 是回读成功后给最后一条 assistant 轮次补的说明（索引全变了，旧附注作废）。 */
  const reloadFromServer = useCallback(
    async (opts: { minTurns?: number; note?: TurnNote; silent?: boolean } = {}) => {
      const id = openIdRef.current
      if (id === null) return false
      try {
        const d = await apiStudio.gptChat(id)
        if (openIdRef.current !== id) return false
        if (opts.minTurns !== undefined && d.turns.length < opts.minTurns) return false
        commitTurns(d.turns)
        setMeta({ title: d.title, pinned: d.pinned, systemPrompt: d.system_prompt })
        setModels({})
        const lastAi = d.turns.map((t) => t.role).lastIndexOf('assistant')
        setNotes(opts.note !== undefined && lastAi >= 0 ? { [lastAi]: opts.note } : {})
        void queryClient.invalidateQueries({ queryKey: ['sgc-chats'] })
        return true
      } catch (e) {
        if (opts.silent !== true) toast.error(e instanceof Error ? e.message : '刷新失败')
        return false
      }
    },
    [commitTurns, queryClient],
  )

  /** 「再问一次服务端」：只有服务端真的多出这一轮才换上来，否则原样留着并照实说 */
  const recheckOnServer = useCallback(async () => {
    const expect = turnsRef.current.length
    const ok = await reloadFromServer({ minTurns: expect, note: 'synced' })
    if (!ok) toast.info('服务端还是没有这一轮，上面那段仍然只在当前页面')
  }, [reloadFromServer])

  const runSend = useCallback(
    async (
      targetId: number,
      text: string,
      imageIds: number[],
      mediaIds: number[],
      imageSize: string,
    ) => {
      const myRun = ++runRef.current
      const startedAt = Date.now()
      const controller = new AbortController()
      abortRef.current = controller
      setSending(true)
      applyLive({ chatId: targetId, startedAt, model: null, text: '', shots: [], tasks: [] })
      let settled = false

      // sendGpt 只在 HTTP 层非 200 时给 error 事件；fetch 自己抛（服务没起、连接被掐）
      // 会一路抛出来，不接住的话 sending 永远为真，界面卡在「停止」上等一个不会来的流
      let thrown: string | null = null
      try {
        await apiStudio.sendGpt(
          targetId,
          {
            text,
            image_asset_ids: imageIds,
            media_asset_ids: mediaIds,
            image_size: imageSize,
            chat_deployment_id:
              chatDeployment === GLOBAL_DEPLOYMENT ? null : Number(chatDeployment),
            image_deployment_id:
              imageDeployment === GLOBAL_DEPLOYMENT ? null : Number(imageDeployment),
          },
          (ev) => {
            // 请求虽然真断了，但已经在管道里的帧还可能解出来一两个：按序号丢掉
            if (runRef.current !== myRun) return
            const cur = liveRef.current
            switch (ev.type) {
              case 'meta':
                if (cur !== null) applyLive({ ...cur, model: ev.chat_model })
                break
              case 'delta':
                if (cur !== null) applyLive({ ...cur, text: cur.text + ev.text })
                break
              case 'image':
                setShotPrompts((p) => ({ ...p, [ev.asset_id]: ev.prompt }))
                if (cur !== null) {
                  applyLive({
                    ...cur,
                    shots: [...cur.shots, { assetId: ev.asset_id, url: ev.url, prompt: ev.prompt }],
                  })
                }
                break
              case 'task':
                // 长任务这一轮没有产物可贴，先把回执挂上，进度归任务中心那条流
                if (cur !== null) {
                  applyLive({
                    ...cur,
                    tasks: appendLiveTask(cur.tasks, {
                      taskId: ev.task_id,
                      operation: ev.operation,
                      label: ev.label,
                      status: ev.status,
                    }),
                  })
                }
                break
              case 'done':
                settled = true
                applyLive(null)
                // 服务端返回的完整轮次是唯一真相，本地拼的那份直接丢掉
                appendTurn(ev.turn, undefined, cur?.model ?? null)
                break
              case 'error':
                settled = true
                applyLive(null)
                appendTurn(
                  {
                    role: 'assistant',
                    content: cur?.text ?? '',
                    asset_ids: (cur?.shots ?? []).map((s) => s.assetId),
                    error: ev.detail,
                    latency_ms: Date.now() - startedAt,
                    at: new Date().toISOString(),
                  },
                  undefined,
                  cur?.model ?? null,
                )
                break
            }
          },
          controller.signal,
        )
      } catch (e) {
        thrown = e instanceof Error ? e.message : String(e)
      }

      if (abortRef.current === controller) abortRef.current = null
      void queryClient.invalidateQueries({ queryKey: ['sgc-chats'] })
      // 停止/切会话已经把这一轮收好尾了，剩下的都不归这里管
      if (runRef.current !== myRun) return
      setSending(false)
      const tail = liveRef.current
      if (settled || tail === null) return
      applyLive(null)
      if (thrown !== null) {
        // 连流都没建起来：原因原样落轮次，和后端 detail 一个待遇
        appendTurn(
          {
            role: 'assistant',
            content: tail.text,
            asset_ids: tail.shots.map((s) => s.assetId),
            error: thrown,
            latency_ms: Date.now() - startedAt,
            at: new Date().toISOString(),
          },
          undefined,
          tail.model,
        )
        return
      }
      // 读到流尾都没等到 done/error：已收到的照常留下，标明它是断的
      appendTurn(
        {
          role: 'assistant',
          content: tail.text,
          asset_ids: tail.shots.map((s) => s.assetId),
          latency_ms: Date.now() - startedAt,
          at: new Date().toISOString(),
        },
        'broken',
        tail.model,
      )
    },
    [applyLive, appendTurn, chatDeployment, imageDeployment, queryClient],
  )

  const doSend = useCallback(() => {
    const text = draft.trim()
    if ((text === '' && attachmentCount === 0) || sending || openId === null || meta === null) return
    if (resolvedImageSize === null) {
      toast.error('自定义宽高需在 256–3840 之间、为 16 的倍数，且比例在 1:3–3:1 之间')
      return
    }
    const imageIds = picked.map((a) => a.id)
    const mediaIds = pickedMedia.map((a) => a.id)
    picked.forEach((a) => queryClient.setQueryData(['sgc-asset', a.id], a))
    pickedMedia.forEach((a) => queryClient.setQueryData(['sgc-media-asset', a.id], a))
    setDraft('')
    setPicked([])
    setPickedMedia([])
    appendTurn({
      role: 'user',
      content: text,
      image_asset_ids: imageIds,
      media_asset_ids: mediaIds,
      image_size: resolvedImageSize,
      at: new Date().toISOString(),
    })
    void runSend(openId, text, imageIds, mediaIds, resolvedImageSize)
  }, [
    appendTurn,
    attachmentCount,
    draft,
    meta,
    openId,
    picked,
    pickedMedia,
    queryClient,
    resolvedImageSize,
    runSend,
    sending,
  ])

  /** 停止：`abort()` 真断这次请求，不是只停止渲染。
   *
   *  断完隔一会儿回读一次会话，**问出**服务端到底存没存这一轮：存了就换成它的记录，
   *  两次都没问到就照实标 `unsaved`。全程不覆盖本地已收到的内容——回读比落库早、
   *  或者服务端压根没写，都不该让用户眼前的字凭空消失（见文件头那条实测）。 */
  const stop = useCallback(() => {
    const cur = liveRef.current
    if (cur === null) return
    runRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    applyLive(null)
    setSending(false)
    appendTurn(
      {
        role: 'assistant',
        content: cur.text,
        asset_ids: cur.shots.map((s) => s.assetId),
        latency_ms: Date.now() - cur.startedAt,
        at: new Date().toISOString(),
      },
      'stopped',
      cur.model,
    )
    const chatId = openIdRef.current
    const expect = turnsRef.current.length
    void (async () => {
      for (const wait of RELOAD_DELAYS_MS) {
        await new Promise((r) => window.setTimeout(r, wait))
        // 这期间用户又发了一轮或者换了会话，就别再插手了
        if (openIdRef.current !== chatId || turnsRef.current.length !== expect) return
        const ok = await reloadFromServer({ minTurns: expect, note: 'synced', silent: true })
        if (ok) return
      }
      // 问了两次都没有：说「没有」，不说「存下来了」
      if (openIdRef.current === chatId && turnsRef.current.length === expect) {
        setNotes((n) => ({ ...n, [expect - 1]: 'unsaved' }))
      }
    })()
  }, [applyLive, appendTurn, reloadFromServer])

  /** 失败轮的重试：按原话原图再发一轮，失败记录留着（服务端也存了它） */
  const retryFrom = useCallback(
    (index: number) => {
      if (sending || openId === null) return
      const prevUser = [...turnsRef.current.slice(0, index)].reverse().find((t) => t.role === 'user')
      if (prevUser === undefined) return
      appendTurn({
        role: 'user',
        content: prevUser.content,
        image_asset_ids: prevUser.image_asset_ids ?? [],
        media_asset_ids: prevUser.media_asset_ids ?? [],
        image_size: prevUser.image_size ?? '1024x1024',
        at: new Date().toISOString(),
      })
      void runSend(
        openId,
        prevUser.content,
        prevUser.image_asset_ids ?? [],
        prevUser.media_asset_ids ?? [],
        prevUser.image_size ?? '1024x1024',
      )
    },
    [sending, openId, appendTurn, runSend],
  )

  // ---- 会话管理 ----

  const createChat = useCallback(async () => {
    try {
      const d = await apiStudio.createGptChat({})
      void queryClient.invalidateQueries({ queryKey: ['sgc-chats'] })
      navigate(`/studio/gpt/${d.id}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '新建会话失败')
    }
  }, [navigate, queryClient])

  const togglePin = useCallback(
    async (item: { id: number; pinned: boolean }) => {
      try {
        await apiStudio.patchGptChat(item.id, { pinned: !item.pinned })
        if (openIdRef.current === item.id) {
          setMeta((m) => (m === null ? m : { ...m, pinned: !item.pinned }))
        }
        void queryClient.invalidateQueries({ queryKey: ['sgc-chats'] })
      } catch (e) {
        toast.error(e instanceof Error ? e.message : '置顶失败')
      }
    },
    [queryClient],
  )

  const saveRename = useCallback(
    async (id: number, title: string) => {
      try {
        await apiStudio.patchGptChat(id, { title })
        if (openIdRef.current === id) setMeta((m) => (m === null ? m : { ...m, title }))
        setRenaming(null)
        void queryClient.invalidateQueries({ queryKey: ['sgc-chats'] })
      } catch (e) {
        toast.error(e instanceof Error ? e.message : '改名失败')
      }
    },
    [queryClient],
  )

  const doDelete = useCallback(
    async (id: number) => {
      try {
        await apiStudio.deleteGptChat(id)
        setDeleting(null)
        void queryClient.invalidateQueries({ queryKey: ['sgc-chats'] })
        if (openIdRef.current === id) navigate('/studio/gpt')
      } catch (e) {
        toast.error(e instanceof Error ? e.message : '删除失败')
      }
    },
    [navigate, queryClient],
  )

  const saveSystemPrompt = useCallback(
    async (systemPrompt: string) => {
      if (openId === null) return
      try {
        await apiStudio.patchGptChat(openId, { system_prompt: systemPrompt })
        setMeta((m) => (m === null ? m : { ...m, systemPrompt }))
        setSettingsOpen(false)
        toast.success('系统提示词已保存，下一轮起生效')
      } catch (e) {
        toast.error(e instanceof Error ? e.message : '保存失败')
      }
    },
    [openId],
  )

  // ---- 图上动作 ----

  const sendToConsole = useCallback(
    async (asset: ImageAsset) => {
      // 与对话生图同一套 useAsRef 契约：取原图字节进 consoleStore 当参考
      try {
        const resp = await fetch(asset.full_url)
        if (!resp.ok) throw new Error(`取原图失败 (${resp.status})`)
        const blob = await resp.blob()
        const file = new File([blob], `asset-${asset.id}.png`, { type: blob.type || 'image/png' })
        const store = useConsoleStore.getState()
        store.refs.forEach((r) => URL.revokeObjectURL(r.url))
        store.set({ refs: [{ id: `asset-${asset.id}`, file, url: URL.createObjectURL(file) }] })
        navigate('/image/image_to_image')
      } catch {
        navigate('/image')
        toast.error('取原图失败，请在控制台手动选参考图')
      }
    },
    [navigate],
  )

  const putOnCanvas = useCallback(
    async (target: number | 'new') => {
      const asset = toCanvas
      if (asset === null) return
      setCanvasBusy(true)
      try {
        const canvasId = target === 'new' ? (await apiStudio.createCanvas({})).id : target
        await attachToCanvas(canvasId, asset)
        setToCanvas(null)
        setViewing(null)
        void queryClient.invalidateQueries({ queryKey: ['sgc-canvases'] })
        navigate(`/studio/canvas/${canvasId}`)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : '放到画布失败')
      } finally {
        setCanvasBusy(false)
      }
    },
    [toCanvas, navigate, queryClient],
  )

  const showLive = live !== null && live.chatId === openId

  return (
    <main className="page sgc-root">
      <aside className="sgc-rail">
        <div className="sgc-rail-head">
          <span className="sgc-rail-title">GPT 创作对话</span>
          <button className="btn btn-primary sgc-new" onClick={() => void createChat()}>
            <IconPlus /> 新建
          </button>
        </div>
        <div className="sgc-rail-list">
          {chatsQ.isLoading && <div className="sgc-rail-tip">读取会话…</div>}
          {chatsQ.isError && (
            <div className="sgc-rail-tip">
              会话列表读取失败：
              {chatsQ.error instanceof Error ? chatsQ.error.message : '未知错误'}
            </div>
          )}
          {sessions.map((s) => (
            <SessionRow
              key={s.id}
              item={s}
              active={s.id === openId}
              onOpen={() => navigate(`/studio/gpt/${s.id}`)}
              onPin={() => void togglePin(s)}
              onRename={() => setRenaming({ id: s.id, title: s.title })}
              onDelete={() => setDeleting({ id: s.id, title: s.title })}
            />
          ))}
          {chatsQ.data !== undefined && sessions.length === 0 && (
            <div className="sgc-rail-tip">还没有会话，点上面「新建」开聊</div>
          )}
        </div>
      </aside>

      {openId === null ? (
        <section className="sgc-hero">
          <IconChat className="sgc-hero-icon" />
          <h2>GPT 创作对话</h2>
          <p>
            能看图、能出图的通用对话：带几张图问，或者直接说要画什么——模型自己决定这一轮
            要不要出图，出的图照旧进资产库。
          </p>
          <button className="btn btn-primary" onClick={() => void createChat()}>
            <IconPlus /> 新建对话
          </button>
          {sessions.length > 0 && <span className="sgc-hero-sub">或从左侧选一个会话继续</span>}
        </section>
      ) : loadError !== null ? (
        <section className="sgc-hero">
          <IconAlert className="sgc-hero-icon" />
          <h2>会话打不开</h2>
          <p>{loadError}</p>
          <button className="btn btn-outline" onClick={() => navigate('/studio/gpt')}>
            回到会话列表
          </button>
        </section>
      ) : meta === null ? (
        <section className="sgc-hero">
          <p>正在打开会话…</p>
        </section>
      ) : (
        <section className="sgc-main">
          <header className="sgc-head">
            <button
              className="sgc-head-title"
              title="重命名"
              onClick={() => setRenaming({ id: openId, title: meta.title })}
            >
              {meta.title}
              <IconEdit />
            </button>
            {meta.pinned && <span className="sgc-head-pin">置顶</span>}
            <span className="sgc-head-space" />
            <span className="sgc-head-alias">
              对话 <code className="sgc-alias">{chatModelLabel}</code> · 出图{' '}
              <code className="sgc-alias">{imageModelLabel}</code>
            </span>
            <button className="btn-ghost-sm" title="会话设置" onClick={() => setSettingsOpen(true)}>
              <IconSettings />
            </button>
          </header>

          <div className="sgc-stream" ref={streamRef}>
            {turns.length === 0 && !showLive && (
              <div className="sgc-stream-empty">
                说一句就开始。带图问会把图直接给模型看；要出图就直说，模型判断该画时会调
                出图别名，图落资产库后就地显示。
              </div>
            )}

            {turns.map((t, i) =>
              t.role === 'user' ? (
                <div className="sgc-turn sgc-turn-user" key={i}>
                  <div className="sgc-bubble-user">
                    {(t.image_asset_ids?.length ?? 0) > 0 && (
                      <div className="sgc-user-imgs">
                        {(t.image_asset_ids ?? []).map((id) => (
                          <Thumb key={id} id={id} onOpen={setViewing} />
                        ))}
                      </div>
                    )}
                    {(t.media_asset_ids?.length ?? 0) > 0 && (
                      <div className="sgc-user-files">
                        {(t.media_asset_ids ?? []).map((id) => <MediaChip key={id} id={id} />)}
                      </div>
                    )}
                    <p className="sgc-text">{t.content}</p>
                  </div>
                </div>
              ) : (
                <div className="sgc-turn sgc-turn-ai" key={i}>
                  <AiTurn
                    turn={t}
                    model={models[i]}
                    note={notes[i]}
                    promptOf={(id) => shotPrompts[id]}
                    onView={setViewing}
                    onToCanvas={setToCanvas}
                    onToConsole={(a) => void sendToConsole(a)}
                    onRetry={() => retryFrom(i)}
                    onReload={() =>
                      notes[i] === 'unsaved'
                        ? void recheckOnServer()
                        : void reloadFromServer({ note: 'synced' })
                    }
                  />
                </div>
              ),
            )}

            {showLive && live !== null && (
              <div className="sgc-turn sgc-turn-ai">
                <div className="sgc-bubble-ai">
                  <p className="sgc-text">
                    {live.text === '' ? '等待模型响应' : live.text}
                    <span className="sgc-caret" />
                  </p>
                  {live.shots.length > 0 && (
                    <div className="sgc-cards">
                      {live.shots.map((s) => (
                        <ShotCard
                          key={s.assetId}
                          assetId={s.assetId}
                          streamedPrompt={s.prompt}
                          streamedUrl={s.url}
                          onView={setViewing}
                          onToCanvas={setToCanvas}
                          onToConsole={(a) => void sendToConsole(a)}
                        />
                      ))}
                    </div>
                  )}
                  {live.tasks.length > 0 && (
                    <ul className="sgc-tasks">
                      {live.tasks.map((t) => (
                        <li key={t.taskId} className="sgc-task">
                          <span className="sgc-task-label">{t.label}</span>
                          <span className="sgc-task-hint">已提交，进度看任务中心</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="sgc-meta">
                    {live.model !== null && <span className="sgc-model">{live.model}</span>}
                    <span>已 {elapsed}s</span>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div
            className={dragOver ? 'sgc-compose sgc-compose-drop' : 'sgc-compose'}
            onDragEnter={(event: DragEvent<HTMLDivElement>) => {
              if (event.dataTransfer.types.includes('Files')) setDragOver(true)
            }}
            onDragOver={(event: DragEvent<HTMLDivElement>) => {
              if (!event.dataTransfer.types.includes('Files')) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'copy'
              setDragOver(true)
            }}
            onDragLeave={(event: DragEvent<HTMLDivElement>) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(false)
            }}
            onDrop={(event: DragEvent<HTMLDivElement>) => {
              event.preventDefault()
              setDragOver(false)
              void addFiles([...event.dataTransfer.files])
            }}
          >
            {dragOver && <div className="sgc-drop-mask">松开即添加附件</div>}
            {attachmentCount > 0 && (
              <div className="sgc-picked">
                {picked.map((a) => (
                  <span className="sgc-pick" key={a.id}>
                    <img
                      className="sgc-pick-img"
                      src={a.thumb_url}
                      alt=""
                      title={a.prompt}
                      onClick={() => setViewing(a)}
                    />
                    <button
                      className="sgc-pick-x"
                      title="不带这张"
                      onClick={() => setPicked((p) => p.filter((x) => x.id !== a.id))}
                    >
                      <IconClose />
                    </button>
                  </span>
                ))}
                {pickedMedia.map((asset) => {
                  const KindIcon = asset.kind === 'video'
                    ? Video
                    : asset.kind === 'audio'
                      ? AudioLines
                      : FileText
                  return (
                    <span className="sgc-pick sgc-pick-file" key={`media-${asset.id}`}>
                      <KindIcon />
                      <span title={asset.name}>{asset.name}</span>
                      <button
                        className="sgc-pick-x"
                        title="不带这个附件"
                        onClick={() => setPickedMedia((items) => items.filter((item) => item.id !== asset.id))}
                      >
                        <IconClose />
                      </button>
                    </span>
                  )
                })}
              </div>
            )}
            <div className="sgc-control-bar" aria-label="本轮生成设置">
              <div className="sgc-pop-wrap" ref={modelPickerRef}>
                <button
                  className="sgc-control-trigger"
                  disabled={sending}
                  onClick={() => {
                    setPickerScope('chat')
                    setSizeOpen(false)
                  }}
                >
                  <span>对话 · {chatModelLabel}</span>
                  <ChevronDown />
                </button>
                <button
                  className="sgc-control-trigger"
                  disabled={sending}
                  onClick={() => {
                    setPickerScope('image')
                    setSizeOpen(false)
                  }}
                >
                  <span>出图 · {imageModelLabel}</span>
                  <ChevronDown />
                </button>
                <ModelPicker
                  open={pickerScope !== null}
                  onClose={() => setPickerScope(null)}
                  options={pickerScope === 'image' ? imageDeployments : chatDeployments}
                  value={
                    (pickerScope === 'image' ? imageDeployment : chatDeployment) === GLOBAL_DEPLOYMENT
                      ? null
                      : Number(pickerScope === 'image' ? imageDeployment : chatDeployment)
                  }
                  usage={pickerScope === 'image' ? '这次出图' : '这轮对话'}
                  onPick={(deployment) => {
                    if (pickerScope === 'image') setImageDeployment(String(deployment.id))
                    else setChatDeployment(String(deployment.id))
                  }}
                  followDefault={{
                    modelName: defaultModelOf(
                      bindingsQ.data,
                      pickerScope === 'image' ? IMAGE_ALIAS : CHAT_ALIAS,
                    ),
                    active:
                      (pickerScope === 'image' ? imageDeployment : chatDeployment) ===
                      GLOBAL_DEPLOYMENT,
                    onFollow: () => {
                      if (pickerScope === 'image') setImageDeployment(GLOBAL_DEPLOYMENT)
                      else setChatDeployment(GLOBAL_DEPLOYMENT)
                    },
                  }}
                />
                {(deploymentsQ.isError || pluginsQ.isError) && (
                  <span className="sgc-model-error">模型目录读取失败</span>
                )}
              </div>
              <div className="sgc-pop-wrap sgc-size-wrap" ref={sizePickerRef}>
                <button
                  className={resolvedImageSize === null ? 'sgc-control-trigger sgc-control-invalid' : 'sgc-control-trigger'}
                  disabled={sending}
                  onClick={() => setSizeOpen((value) => !value)}
                >
                  <span>画幅 · {sizeMode === 'auto' ? '自动' : (resolvedImageSize ?? '无效')}</span>
                  <ChevronDown />
                </button>
                {sizeOpen && (
                  <div className="sgc-size-pop">
                    <div className="sgc-pop-tabs">
                      {(['auto', 'preset', 'custom'] as const).map((mode) => (
                        <button
                          key={mode}
                          className={sizeMode === mode ? 'on' : ''}
                          onClick={() => setSizeMode(mode)}
                        >
                          {mode === 'auto' ? '自动' : mode === 'preset' ? '预设' : '自定义'}
                        </button>
                      ))}
                    </div>
                    {sizeMode === 'auto' ? (
                      <div className="sgc-size-note">
                        从提示词里识别「1536×1024」、「9:16」、「2K」等线索；没有线索时用 1024×1024。
                        <b>本轮解析：{resolvedImageSize}</b>
                      </div>
                    ) : sizeMode === 'preset' ? (
                      <>
                        <div className="sgc-ratio-grid">
                          {(Object.keys(GPT_RATIO_LABELS) as GptImageRatio[]).map((ratio) => (
                            <button
                              key={ratio}
                              className={sizeRatio === ratio ? 'on' : ''}
                              onClick={() => setSizeRatio(ratio)}
                            >
                              {GPT_RATIO_LABELS[ratio]}
                            </button>
                          ))}
                        </div>
                        <div className="sgc-level-row">
                          {(['1k', '2k', '4k'] as const).map((level) => (
                            <button
                              key={level}
                              className={sizeLevel === level ? 'on' : ''}
                              onClick={() => setSizeLevel(level)}
                            >
                              {level.toUpperCase()} <span>{GPT_IMAGE_SIZES[sizeRatio][level]}</span>
                            </button>
                          ))}
                        </div>
                      </>
                    ) : (
                      <div className="sgc-custom-size">
                        <label>
                          <span>宽</span>
                          <input type="number" min={256} max={3840} step={16} value={customWidth} onChange={(event) => setCustomWidth(event.target.value)} />
                        </label>
                        <span>×</span>
                        <label>
                          <span>高</span>
                          <input type="number" min={256} max={3840} step={16} value={customHeight} onChange={(event) => setCustomHeight(event.target.value)} />
                        </label>
                        <p className={resolvedImageSize === null ? 'sgc-size-error' : ''}>
                          {resolvedImageSize === null ? '宽高须为 16 的倍数，且比例在 1:3–3:1 之间' : resolvedImageSize}
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
              <span className="sgc-attach-count">{attachmentCount}/{GPT_ATTACHMENT_MAX}</span>
            </div>
            <div className="sgc-input">
              <input
                ref={uploadInputRef}
                className="sgc-file-input"
                type="file"
                multiple
                onChange={(event) => {
                  void addFiles([...(event.target.files ?? [])])
                  event.target.value = ''
                }}
              />
              <button
                className="sgc-addimg"
                title="从本机上传图片或文件"
                disabled={uploading || attachmentCount >= GPT_ATTACHMENT_MAX}
                onClick={() => uploadInputRef.current?.click()}
              >
                {uploading ? <Upload className="sgc-uploading" /> : <Paperclip />}
              </button>
              <button className="sgc-addimg" title="带图提问" onClick={() => setPicking(true)}>
                <IconPlus />
                <IconImage />
              </button>
              <textarea
                className="sgc-input-box"
                rows={2}
                placeholder="说点什么，也可粘贴或拖入附件。Enter 发送、Shift+Enter 换行"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  // isComposing 守卫：中文输入法选词的那次回车不能当发送
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    doSend()
                  }
                }}
              />
              {sending ? (
                <button className="btn btn-outline sgc-stop" onClick={stop}>
                  停止
                </button>
              ) : (
                <button
                  className="btn btn-primary sgc-send"
                  disabled={(draft.trim() === '' && attachmentCount === 0) || resolvedImageSize === null || uploading}
                  onClick={doSend}
                >
                  <IconSend /> 发送
                </button>
              )}
            </div>
            <p className="sgc-hint">
              {sending
                ? '生成中 · 「停止」会真的中断这次请求；已经出的图仍在资产库，正文存没存下来会去问服务端'
                : '支持图片、PDF、文本、代码、音频和视频；可选择、拖入或直接粘贴，一轮最多 20 个'}
            </p>
          </div>
        </section>
      )}

      {picking && (
        <AssetPicker
          onClose={() => setPicking(false)}
          onPick={(asset) => {
            if (picked.length + pickedMedia.length >= GPT_ATTACHMENT_MAX) {
              toast.error(`一轮最多携带 ${GPT_ATTACHMENT_MAX} 个附件`)
              return
            }
            queryClient.setQueryData(['sgc-asset', asset.id], asset)
            setPicked((p) => (p.some((x) => x.id === asset.id) ? p : [...p, asset]))
          }}
        />
      )}
      {viewing !== null && (
        <Viewer
          asset={viewing}
          onToCanvas={setToCanvas}
          onToConsole={(a) => void sendToConsole(a)}
          onClose={() => setViewing(null)}
        />
      )}
      {toCanvas !== null && (
        <CanvasPicker
          busy={canvasBusy}
          onPick={(target) => void putOnCanvas(target)}
          onClose={() => setToCanvas(null)}
        />
      )}
      {renaming !== null && (
        <RenameDialog
          initial={renaming.title}
          onSave={(title) => void saveRename(renaming.id, title)}
          onClose={() => setRenaming(null)}
        />
      )}
      {deleting !== null && (
        <DeleteConfirm
          title={deleting.title}
          onConfirm={() => void doDelete(deleting.id)}
          onClose={() => setDeleting(null)}
        />
      )}
      {settingsOpen && meta !== null && (
        <SettingsDialog
          initial={meta.systemPrompt}
          onSave={(v) => void saveSystemPrompt(v)}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </main>
  )
}
