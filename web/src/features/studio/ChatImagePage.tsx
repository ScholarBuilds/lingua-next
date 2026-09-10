/* 对话生图（模块 17 FR-470 ~ FR-473）。

   立项理由就是「参考图锚定循环」（FR-471 / BR-148）：每轮生成完，最新产图自动
   成为下一轮参考，短中文原话直达 /images/edit 且不传 size——尺寸跟随参考比例，
   这是蓝本一致性的全部来源。首轮没有参考时走既有立意管线（/images/jobs），
   画幅由立意按内容挑（FR-451 已有），不在这里另写一套解析。

   保存语义：turns 全量 PUT + base_version。对话是线性流，409 时 GET 覆盖本地、
   把未落库的尾巴接回去再存一次即可，不需要画布那套三路合并（BR-145 是画布的事）。
   turns 里只存资产 id（BR-143 文档态），渲染时按 id 现取 URL。 */

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'

import {
  IconAlert,
  IconArrowUpRight,
  IconChat,
  IconCheck,
  IconClose,
  IconDownload,
  IconEdit,
  IconImage,
  IconLocate,
  IconPlus,
  IconSearch,
  IconSend,
  IconStar,
  IconTrash,
} from '@/components/icons'
import { Overlay } from '@/components/Overlay'
import { useConsoleStore } from '@/features/image/consoleStore'
import { apiConfig } from '@/lib/api-config'
import type { ImageAsset, JobDetail } from '@/lib/api-image'
import { ApiImageError, apiImage } from '@/lib/api-image'
import { runImageEditTask } from '@/lib/image-edit-task'
import type { ChatImageTurn, ChatSummary, StudioTask } from '@/lib/api-studio'
import { apiStudio } from '@/lib/api-studio'
import {
  DEFAULT_MIDJOURNEY_VERSION,
  MIDJOURNEY_VERSIONS,
  midjourneyShotActions,
  midjourneyShots,
} from './chat-midjourney'
import type { MidjourneyShot, MidjourneyShotAction, MidjourneyVersion } from './chat-midjourney'

import './chat-image.css'

const QUALITIES: Array<[string, string]> = [
  ['low', '低'],
  ['medium', '中'],
  ['high', '高'],
]

/** Midjourney 一次最多带几张参考图，与画布节点同一个上限 */
const MIDJOURNEY_MAX_REFS = 4
/** 一次 imagine 出四宫格：骨架先按四张画，真实张数以产物为准 */
const MIDJOURNEY_GRID = 4
const TASK_TERMINAL = new Set(['succeeded', 'partial', 'failed', 'cancelled'])
/** 2 秒一轮，最多盯一小时。与画布同一个上限 */
const TASK_POLL_MAX = 1800

/** 2 秒轮询直到任务落定。done/failed 之外的一切状态都还在跑 */
async function waitJob(imageJobId: number): Promise<JobDetail> {
  for (;;) {
    const detail = await apiImage.job(imageJobId)
    if (detail.status === 'done' || detail.status === 'failed') return detail
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}

/** 持久任务同样是 2 秒一问，上限跟画布一致（1800 次 ≈ 1 小时）。
 *  任务在服务端跑，关掉页面也不会断；这里等不到只是不再盯着，任务照跑 */
async function waitTask(taskId: string): Promise<StudioTask> {
  for (let round = 0; round < TASK_POLL_MAX; round += 1) {
    const task = await apiStudio.task(taskId)
    if (TASK_TERMINAL.has(task.status)) return task
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  throw new Error('等了一个小时还没落定，去任务中心看这条任务的进度')
}

/** 任务产出的资产 id。取不到就当没出图，不去猜 */
function taskAssetIds(task: StudioTask): number[] {
  const raw = task.result?.asset_ids
  if (!Array.isArray(raw)) return []
  return raw.filter((value): value is number => Number.isInteger(value) && (value as number) > 0)
}

/** 资产按 id 取一次、全页共享缓存：会话封面、参考条、气泡网格都从这里拿 URL */
function useAsset(id: number) {
  return useQuery({
    queryKey: ['sci-asset', id],
    queryFn: () => apiImage.asset(id),
    staleTime: Infinity,
    retry: 1,
  })
}

/* ==================== 小件 ==================== */

/** 参考条与用户气泡里的小缩略。onRemove 缺省时是纯展示 */
function RefThumb({ id, onRemove }: { id: number; onRemove?: () => void }) {
  const asset = useAsset(id)
  return (
    <span className="sci-ref">
      {asset.data !== undefined ? (
        <img className="sci-ref-img" src={asset.data.thumb_url} alt="" loading="lazy" />
      ) : (
        <span className="sci-ref-img sci-ph" />
      )}
      {onRemove !== undefined && (
        <button className="sci-ref-x" title="移除参考" onClick={onRemove}>
          <IconClose />
        </button>
      )}
    </span>
  )
}

/** AI 气泡里的一张产图：hover 出图上动作（FR-473）。
 *
 *  `shot` 有值才画放大 / 变体那一行——它只由 Midjourney 任务的台账推出来，
 *  别的引擎拿不到上游 task id，也没有 U/V 这个概念。 */
function Shot({
  id,
  isRef,
  shot,
  busy,
  onView,
  onSetRef,
  onToConsole,
  onAction,
}: {
  id: number
  isRef: boolean
  shot?: MidjourneyShot
  busy: boolean
  onView: (asset: ImageAsset) => void
  onSetRef: (asset: ImageAsset) => void
  onToConsole: (asset: ImageAsset) => void
  onAction: (assetId: number, action: MidjourneyShotAction) => void
}) {
  const asset = useAsset(id)
  const actions = midjourneyShotActions(shot)
  if (asset.isError) return <div className="sci-shot sci-shot-gone">图已不在资产库</div>
  if (asset.data === undefined) return <div className="sci-shot sci-ph" />
  const item = asset.data
  return (
    <figure className="sci-shot">
      {/* 图与 hover 浮层单独一层：动作行接在下面时，浮层还得贴着图的下沿 */}
      <div className="sci-shot-frame">
        <img src={item.url} alt={item.prompt} loading="lazy" onClick={() => onView(item)} />
        <figcaption className="sci-shot-acts">
          <button
            title={isRef ? '当前参考' : '设为下一轮参考'}
            className={isRef ? 'sci-act on' : 'sci-act'}
            onClick={() => onSetRef(item)}
          >
            <IconLocate />
          </button>
          <button title="送去控制台改" className="sci-act" onClick={() => onToConsole(item)}>
            <IconArrowUpRight />
          </button>
          <a title="下载原图" className="sci-act" href={item.full_url} download>
            <IconDownload />
          </a>
          <button title="查看大图" className="sci-act" onClick={() => onView(item)}>
            <IconSearch />
          </button>
        </figcaption>
      </div>
      {actions.length > 0 && (
        <div className="sci-mj-acts">
          {actions.map((action) => (
            <button
              key={`${action.name}-${action.index ?? 0}`}
              className="sci-mj-act"
              title={action.title}
              disabled={busy}
              onClick={() => onAction(id, action)}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </figure>
  )
}

/** 左栏一条会话：封面取最后一张产图，hover 出置顶/改名/删除 */
function SessionRow({
  item,
  active,
  onOpen,
  onPin,
  onRename,
  onDelete,
}: {
  item: ChatSummary
  active: boolean
  onOpen: () => void
  onPin: () => void
  onRename: () => void
  onDelete: () => void
}) {
  return (
    <div className={active ? 'sci-sess on' : 'sci-sess'} onClick={onOpen}>
      {item.last_asset_id !== null ? (
        <SessCover id={item.last_asset_id} />
      ) : (
        <span className="sci-sess-cover sci-sess-blank">
          <IconImage />
        </span>
      )}
      <span className="sci-sess-body">
        <span className="sci-sess-title">
          {item.pinned && <IconStar filled className="sci-sess-pin" />}
          {item.title}
        </span>
        <span className="sci-sess-sub">{item.turn_count} 轮</span>
      </span>
      <span className="sci-sess-acts" onClick={(e) => e.stopPropagation()}>
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

function SessCover({ id }: { id: number }) {
  const asset = useAsset(id)
  if (asset.data === undefined) return <span className="sci-sess-cover sci-ph" />
  return <img className="sci-sess-cover" src={asset.data.thumb_url} alt="" loading="lazy" />
}

/* ==================== 浮层 ==================== */

/** 从资产库补参考的小弹层。点选即入参考条，可多选 */
function AssetPicker({
  picked,
  onToggle,
  onClose,
}: {
  picked: number[]
  onToggle: (id: number) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const assets = useQuery({
    queryKey: ['sci-pick', q],
    queryFn: () => apiImage.assets({ q, limit: 60 }),
    placeholderData: keepPreviousData,
  })
  // Esc 两段式（STD-UI-002b）：焦点在搜索框且打了字时，第一次 Esc 只失焦
  const requestClose = () => {
    if (document.activeElement === inputRef.current && q !== '') {
      inputRef.current?.blur()
      return
    }
    onClose()
  }
  return (
    <Overlay onClose={requestClose} card="sci-picker" labelledBy="sci-picker-title">
      <div className="overlay-head">
        <span className="overlay-title" id="sci-picker-title">
          从资产库选参考
        </span>
        <button className="btn-ghost-sm" title="关闭" onClick={onClose}>
          <IconClose />
        </button>
      </div>
      <input
        ref={inputRef}
        className="sci-picker-q"
        placeholder="按提示词搜索…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="sci-picker-grid">
        {(assets.data?.items ?? []).map((a) => {
          const on = picked.includes(a.id)
          return (
            <button
              key={a.id}
              className={on ? 'sci-pick on' : 'sci-pick'}
              title={a.prompt}
              onClick={() => onToggle(a.id)}
            >
              <img src={a.thumb_url} alt="" loading="lazy" />
              {on && (
                <span className="sci-pick-tick">
                  <IconCheck />
                </span>
              )}
            </button>
          )
        })}
        {assets.data !== undefined && assets.data.items.length === 0 && (
          <div className="sci-picker-empty">没有匹配的资产</div>
        )}
      </div>
      <div className="sci-dialog-foot">
        <span className="sci-picker-count">
          {picked.length > 0 ? `已选 ${picked.length} 张作参考` : '点选图片加入参考条'}
        </span>
        <button className="btn btn-primary" onClick={onClose}>
          完成
        </button>
      </div>
    </Overlay>
  )
}

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
  // Esc 两段式：改了名还没保存时，第一次 Esc 只失焦，免得白打（STD-UI-002b）
  const requestClose = () => {
    if (document.activeElement === inputRef.current && val !== initial) {
      inputRef.current?.blur()
      return
    }
    onClose()
  }
  return (
    <Overlay onClose={requestClose} card="sci-dialog" labelledBy="sci-rename-title">
      <div className="overlay-head">
        <span className="overlay-title" id="sci-rename-title">
          重命名会话
        </span>
      </div>
      <input
        ref={inputRef}
        className="sci-dialog-input"
        value={val}
        autoFocus
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit()
        }}
      />
      <div className="sci-dialog-foot">
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
    <Overlay onClose={onClose} card="sci-dialog" labelledBy="sci-del-title">
      <div className="overlay-head">
        <span className="overlay-title" id="sci-del-title">
          删除会话
        </span>
      </div>
      <p className="sci-dialog-text">
        「{title}」的全部轮次记录会一起删掉；已产出的图仍在资产库，不受影响。
      </p>
      <div className="sci-dialog-foot">
        <button className="btn btn-outline" onClick={onClose}>
          取消
        </button>
        <button className="btn btn-primary sci-danger" onClick={onConfirm}>
          删除
        </button>
      </div>
    </Overlay>
  )
}

/** 查看大图。浮层走 components/Overlay，Esc 只关这一层（STD-UI-001/002） */
function Viewer({
  asset,
  isRef,
  onSetRef,
  onToConsole,
  onClose,
}: {
  asset: ImageAsset
  isRef: boolean
  onSetRef: (asset: ImageAsset) => void
  onToConsole: (asset: ImageAsset) => void
  onClose: () => void
}) {
  return (
    <Overlay onClose={onClose} card="sci-viewer" labelledBy="sci-viewer-title">
      <div className="overlay-head">
        <span className="overlay-title" id="sci-viewer-title">
          {asset.width} × {asset.height}
        </span>
        <button className="btn-ghost-sm" title="关闭" onClick={onClose}>
          <IconClose />
        </button>
      </div>
      <div className="sci-viewer-stage">
        <img src={asset.url} alt={asset.prompt} />
      </div>
      <div className="sci-dialog-foot">
        <button className="btn btn-outline" disabled={isRef} onClick={() => onSetRef(asset)}>
          {isRef ? '已是参考' : '设为参考'}
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

/* ==================== 页面 ==================== */

export default function ChatImagePage() {
  const params = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  // 路由是 /studio/chat/:chatId?（主协调挂载），参数名跟它保持一致
  const parsedId = params.chatId === undefined ? Number.NaN : Number(params.chatId)
  const openId = Number.isInteger(parsedId) && parsedId > 0 ? parsedId : null

  // ---- 会话列表 ----
  const chatsQ = useQuery({ queryKey: ['sci-chats'], queryFn: apiStudio.chats })
  const sessions = useMemo(() => {
    const items = chatsQ.data?.items ?? []
    return [...items].sort(
      (a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at.localeCompare(a.updated_at),
    )
  }, [chatsQ.data])

  // ---- 会话详情：本地持有 turns 与版本 ----
  const [turns, setTurns] = useState<ChatImageTurn[]>([])
  const [meta, setMeta] = useState<{ title: string; pinned: boolean } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const turnsRef = useRef<ChatImageTurn[]>([])
  const versionRef = useRef(0)
  /** 已确认落库的轮数。409 时把本地多出的尾巴接回服务端最新全量后面 */
  const syncedRef = useRef(0)
  const openIdRef = useRef<number | null>(null)
  openIdRef.current = openId

  // ---- 生成参数与输入 ----
  const [quality, setQuality] = useState('medium')
  const [count, setCount] = useState(1)
  const [refIds, setRefIds] = useState<number[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<{ chatId: number; startedAt: number; n: number } | null>(null)
  const [elapsed, setElapsed] = useState(0)

  // ---- Midjourney 引擎 ----
  const [engine, setEngine] = useState<'default' | 'midjourney'>('default')
  const [mjVersion, setMjVersion] = useState<MidjourneyVersion>(DEFAULT_MIDJOURNEY_VERSION)
  const deploymentsQ = useQuery({
    queryKey: ['sci-mj-deployments'],
    queryFn: () => apiConfig.modelDeployments({ media_type: 'image', enabled: true }),
    staleTime: 60_000,
  })
  // APIMart adapter 才跑 Midjourney 协议。一个都没有就不给这个引擎选项——
  // 摆一个点了必然报错的开关，比没有还糟
  const mjDeployment = useMemo(
    () => (deploymentsQ.data ?? []).find((item) => item.adapter_type === 'apimart'),
    [deploymentsQ.data],
  )
  const mjReady = mjDeployment !== undefined
  const useMidjourney = mjReady && engine === 'midjourney'

  /** 二次动作的上下文只认任务台账：上游 task id、出图张数、部署都在里面，
   *  刷新后照样读得到。取最近 200 条——再往前的对话按台账翻页不划算，
   *  查不到就不给按钮（不伪造入口 BR-110） */
  const mjTasksQ = useQuery({
    queryKey: ['sci-mj-tasks', openId],
    queryFn: () => apiStudio.tasks({ limit: 200 }),
    enabled: openId !== null,
    staleTime: 10_000,
  })
  const shots = useMemo(
    () =>
      openId === null
        ? new Map<number, MidjourneyShot>()
        : midjourneyShots(mjTasksQ.data?.items ?? [], openId),
    [mjTasksQ.data, openId],
  )
  const shotsRef = useRef(shots)
  shotsRef.current = shots

  // ---- 浮层 ----
  const [picking, setPicking] = useState(false)
  const [viewing, setViewing] = useState<ImageAsset | null>(null)
  const [renaming, setRenaming] = useState<{ id: number; title: string } | null>(null)
  const [deleting, setDeleting] = useState<{ id: number; title: string } | null>(null)

  const commit = useCallback((next: ChatImageTurn[]) => {
    turnsRef.current = next
    setTurns(next)
  }, [])

  // 换会话：清干净再取。取完把最近一轮产图接回参考条，继续上次的循环（FR-470）
  useEffect(() => {
    commit([])
    setMeta(null)
    setLoadError(null)
    setRefIds([])
    if (openId === null) return
    let alive = true
    apiStudio
      .chat(openId)
      .then((d) => {
        if (!alive) return
        versionRef.current = d.version
        syncedRef.current = d.turns.length
        commit(d.turns)
        setMeta({ title: d.title, pinned: d.pinned })
        const lastGen = [...d.turns]
          .reverse()
          .find((t) => t.role === 'assistant' && (t.asset_ids?.length ?? 0) > 0)
        setRefIds(lastGen?.asset_ids ?? [])
      })
      .catch((e: Error) => {
        if (alive) setLoadError(e.message)
      })
    return () => {
      alive = false
    }
  }, [openId, commit])

  // 生成中的秒表。骨架气泡上要看到真实已跑时长，不伪造进度
  useEffect(() => {
    if (busy === null) return
    setElapsed(0)
    const timer = window.setInterval(() => {
      setElapsed(Math.max(0, Math.floor((Date.now() - busy.startedAt) / 1000)))
    }, 500)
    return () => window.clearInterval(timer)
  }, [busy])

  // 新轮次落地后滚到底。显式 auto——smooth 在内嵌面板里会被整个吞掉
  const streamRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = streamRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [turns.length, busy, openId])

  /** 全量 PUT。409 = 别的端写过：GET 覆盖本地，把未落库的尾巴接回去再存一次 */
  const save = useCallback(
    async (targetId: number) => {
      if (openIdRef.current !== targetId) return
      const local = turnsRef.current
      try {
        const res = await apiStudio.saveChatTurns(targetId, {
          turns: local,
          base_version: versionRef.current,
        })
        versionRef.current = res.version
        syncedRef.current = local.length
      } catch (e) {
        if (!(e instanceof ApiImageError && e.status === 409)) throw e
        const fresh = await apiStudio.chat(targetId)
        if (openIdRef.current !== targetId) return
        const merged = [...fresh.turns, ...local.slice(syncedRef.current)]
        commit(merged)
        const res = await apiStudio.saveChatTurns(targetId, {
          turns: merged,
          base_version: fresh.version,
        })
        versionRef.current = res.version
        syncedRef.current = merged.length
      }
    },
    [commit],
  )

  /** 生成结束时用户已切到别的会话：现取最新全量把这一轮接上，结果不能丢 */
  const appendRemote = useCallback(async (targetId: number, turn: ChatImageTurn) => {
    for (let attempt = 0; ; attempt += 1) {
      const fresh = await apiStudio.chat(targetId)
      try {
        await apiStudio.saveChatTurns(targetId, {
          turns: [...fresh.turns, turn],
          base_version: fresh.version,
        })
        return
      } catch (e) {
        if (!(e instanceof ApiImageError && e.status === 409) || attempt >= 2) throw e
      }
    }
  }, [])

  /** 一轮的落地流程：跑 → 落 turn → 存。产图怎么来由 `produce` 决定，
   *  首轮生成、锚定改图与 Midjourney 二次动作共用这一段，免得三处各写一遍保存。 */
  const runTurn = useCallback(
    async (targetId: number, skeleton: number, produce: () => Promise<ImageAsset[]>) => {
      setBusy({ chatId: targetId, startedAt: Date.now(), n: skeleton })
      const started = Date.now()
      let turn: ChatImageTurn
      let producedIds: number[] = []
      try {
        const items = await produce()
        items.forEach((a) => queryClient.setQueryData(['sci-asset', a.id], a))
        producedIds = items.map((a) => a.id)
        turn = {
          role: 'assistant',
          asset_ids: producedIds,
          latency_ms: Date.now() - started,
          at: new Date().toISOString(),
        }
      } catch (e) {
        // 失败原因原样落 turns：后端 detail 是修复线索，不转译（BR-090 系）
        turn = {
          role: 'assistant',
          error: e instanceof Error ? e.message : String(e),
          at: new Date().toISOString(),
        }
      }
      try {
        if (openIdRef.current === targetId) {
          commit([...turnsRef.current, turn])
          // 最新产图自动锚定下一轮（BR-148），用户可在参考条撤掉或换
          if (producedIds.length > 0) setRefIds(producedIds)
          await save(targetId)
        } else {
          await appendRemote(targetId, turn)
        }
      } catch (e) {
        toast.error(`结果已出但保存失败：${e instanceof Error ? e.message : String(e)}`)
      }
      setBusy(null)
      void queryClient.invalidateQueries({ queryKey: ['sci-chats'] })
      // 二次动作的入口取自台账，新任务落定就得重取，否则新出的图旁边没有按钮
      void queryClient.invalidateQueries({ queryKey: ['sci-mj-tasks', targetId] })
    },
    [queryClient, commit, save, appendRemote],
  )

  const runGeneration = useCallback(
    async (targetId: number, text: string, refs: number[]) => {
      const mjRun = useMidjourney && mjDeployment !== undefined
      await runTurn(targetId, mjRun ? MIDJOURNEY_GRID : count, async () => {
        let items: ImageAsset[]
        if (mjRun) {
          // Midjourney 是持久异步任务：先入队拿到任务 id，再轮询到落定。
          // 有参考图走 edit，没有走 imagine，与画布节点同一套模式判断
          const task = await apiStudio.runMidjourney({
            deployment_id: mjDeployment.id,
            mode: refs.length > 0 ? 'edit' : 'imagine',
            prompt: text,
            size: '1:1',
            version: mjVersion,
            speed: 'relax',
            reference_asset_ids: refs.slice(0, MIDJOURNEY_MAX_REFS),
            source_route: `/studio/chat/${targetId}`,
            source_context: { chat_id: targetId },
          })
          const done = await waitTask(task.id)
          if (done.status !== 'succeeded') throw new Error(done.error ?? 'Midjourney 任务失败')
          const ids = taskAssetIds(done)
          if (ids.length === 0) throw new Error('Midjourney 任务完成了但没有出图')
          return await Promise.all(ids.map((id) => apiImage.asset(id)))
        }
        if (refs.length > 0) {
          // 锚定这条路：原话直达 /images/edit，参考按资产 id 直引（BR-144）；
          // consistent_edit 锁高保真，不传 size 则让尺寸跟随参考比例（BR-148）
          const form = new FormData()
          form.set('prompt', text)
          form.set('app_key', 'consistent_edit')
          form.set('alias', 'image-free')
          form.set('quality', quality)
          form.set('n', String(count))
          form.set('ref_asset_ids', refs.join(','))
          items = await runImageEditTask(form, {
            toolId: 'chat-image',
            sourceRoute: `/studio/chat/${targetId}`,
            sourceContext: { chat_id: targetId },
          })
        } else {
          // 首轮无参考：走立意管线，画幅由立意按内容挑（复用 FR-451，不重写解析）
          const created = await apiImage.createJob({
            target_key: 'free',
            idea: text,
            style_key: 'none',
            size: null,
            tier: '1k',
            alias: 'image-free',
            quality,
            n: count,
            tool_id: 'chat-image',
            source_route: `/studio/chat/${targetId}`,
            source_context: { chat_id: targetId },
          })
          const job = await waitJob(created.image_job_id)
          if (job.status !== 'done') throw new Error(job.error ?? '生成失败')
          items = job.assets
        }
        return items
      })
    },
    [count, quality, mjDeployment, mjVersion, useMidjourney, runTurn],
  )

  /** 放大 / 变体等二次动作。上下文来自台账里的这张图，缺一项都不发请求 */
  const runShotAction = useCallback(
    (assetId: number, action: MidjourneyShotAction) => {
      const targetId = openIdRef.current
      const shot = shotsRef.current.get(assetId)
      if (targetId === null || shot === undefined) return
      void runTurn(targetId, 1, async () => {
        const task = await apiStudio.runMidjourneyAction({
          deployment_id: shot.deploymentId,
          task_id: shot.providerTaskId,
          action: action.name,
          speed: shot.speed,
          index: action.index ?? null,
          source_route: `/studio/chat/${targetId}`,
          source_context: { chat_id: targetId, from_asset_id: assetId },
        })
        const done = await waitTask(task.id)
        if (done.status !== 'succeeded') throw new Error(done.error ?? `${action.label} 失败`)
        const ids = taskAssetIds(done)
        if (ids.length === 0) throw new Error(`${action.label} 完成了但没有出图`)
        return await Promise.all(ids.map((id) => apiImage.asset(id)))
      })
    },
    [runTurn],
  )

  const send = useCallback(async () => {
    const text = draft.trim()
    if (text === '' || busy !== null || openId === null || meta === null) return
    const refs = [...refIds]
    setDraft('')
    const userTurn: ChatImageTurn = {
      role: 'user',
      text,
      ref_asset_ids: refs,
      at: new Date().toISOString(),
    }
    commit([...turnsRef.current, userTurn])
    try {
      // 先把这句话落库再出图：生成要跑几十秒，中途刷新不该丢话
      await save(openId)
    } catch (e) {
      toast.error(`这句话保存失败（生成继续）：${e instanceof Error ? e.message : String(e)}`)
    }
    await runGeneration(openId, text, refs)
  }, [draft, busy, openId, meta, refIds, commit, save, runGeneration])

  const retry = useCallback(() => {
    if (busy !== null || openId === null) return
    const list = turnsRef.current
    const last = list[list.length - 1]
    if (last === undefined || last.role !== 'assistant' || last.error === undefined) return
    const prevUser = [...list.slice(0, -1)].reverse().find((t) => t.role === 'user')
    if (prevUser?.text === undefined) return
    // 线性流里失败轮只会在末尾：撤掉错误轮，按原话原参考重跑
    commit(list.slice(0, -1))
    void save(openId).catch(() => undefined)
    void runGeneration(openId, prevUser.text, prevUser.ref_asset_ids ?? [])
  }, [busy, openId, commit, save, runGeneration])

  // ---- 会话管理 ----

  const createChat = useCallback(async () => {
    try {
      const d = await apiStudio.createChat({})
      void queryClient.invalidateQueries({ queryKey: ['sci-chats'] })
      navigate(`/studio/chat/${d.id}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '新建会话失败')
    }
  }, [navigate, queryClient])

  const togglePin = useCallback(
    async (item: { id: number; pinned: boolean }) => {
      try {
        await apiStudio.patchChatMeta(item.id, { pinned: !item.pinned })
        if (openIdRef.current === item.id) {
          setMeta((m) => (m === null ? m : { ...m, pinned: !item.pinned }))
        }
        void queryClient.invalidateQueries({ queryKey: ['sci-chats'] })
      } catch (e) {
        toast.error(e instanceof Error ? e.message : '置顶失败')
      }
    },
    [queryClient],
  )

  const saveRename = useCallback(
    async (id: number, title: string) => {
      try {
        await apiStudio.patchChatMeta(id, { title })
        if (openIdRef.current === id) setMeta((m) => (m === null ? m : { ...m, title }))
        setRenaming(null)
        void queryClient.invalidateQueries({ queryKey: ['sci-chats'] })
      } catch (e) {
        toast.error(e instanceof Error ? e.message : '改名失败')
      }
    },
    [queryClient],
  )

  const doDelete = useCallback(
    async (id: number) => {
      try {
        await apiStudio.deleteChat(id)
        setDeleting(null)
        void queryClient.invalidateQueries({ queryKey: ['sci-chats'] })
        if (openIdRef.current === id) navigate('/studio/chat')
      } catch (e) {
        toast.error(e instanceof Error ? e.message : '删除失败')
      }
    },
    [navigate, queryClient],
  )

  // ---- 图上动作（FR-473）----

  const setAsRef = useCallback((asset: ImageAsset) => {
    // 换锚是单选语义：留着上一批参考只会混淆下一句在改谁
    setRefIds([asset.id])
    setViewing(null)
    toast.success('已设为下一轮参考')
  }, [])

  const toConsole = useCallback(
    async (asset: ImageAsset) => {
      // 仿控制台 useAsRef：取原图字节进 consoleStore 当参考，编辑链在那边接着走。
      // consoleStore 本就是为「切页不丢工作现场」立的跨页 store，不算硬造状态
      try {
        const resp = await fetch(asset.full_url)
        if (!resp.ok) throw new Error(`取原图失败 (${resp.status})`)
        const blob = await resp.blob()
        const file = new File([blob], `asset-${asset.id}.png`, {
          type: blob.type || 'image/png',
        })
        const store = useConsoleStore.getState()
        store.refs.forEach((r) => URL.revokeObjectURL(r.url))
        store.set({ refs: [{ id: `asset-${asset.id}`, file, url: URL.createObjectURL(file) }] })
        navigate('/image/image_to_image')
      } catch {
        // 取不到字节就只带人过去，别送半套状态
        navigate('/image')
        toast.error('取原图失败，请在控制台手动选参考图')
      }
    },
    [navigate],
  )

  const showSkeleton = busy !== null && busy.chatId === openId

  return (
    <main className="page sci-root">
      <aside className="sci-rail">
        <div className="sci-rail-head">
          <span className="sci-rail-title">对话生图</span>
          <button className="btn btn-primary sci-new" onClick={() => void createChat()}>
            <IconPlus /> 新建
          </button>
        </div>
        <div className="sci-rail-list">
          {chatsQ.isLoading && <div className="sci-rail-tip">读取会话…</div>}
          {chatsQ.isError && <div className="sci-rail-tip">会话列表读取失败</div>}
          {sessions.map((s) => (
            <SessionRow
              key={s.id}
              item={s}
              active={s.id === openId}
              onOpen={() => navigate(`/studio/chat/${s.id}`)}
              onPin={() => void togglePin(s)}
              onRename={() => setRenaming({ id: s.id, title: s.title })}
              onDelete={() => setDeleting({ id: s.id, title: s.title })}
            />
          ))}
          {chatsQ.data !== undefined && sessions.length === 0 && (
            <div className="sci-rail-tip">还没有会话，点上面「新建」开聊</div>
          )}
        </div>
      </aside>

      {openId === null ? (
        <section className="sci-hero">
          <IconChat className="sci-hero-icon" />
          <h2>对话生图</h2>
          <p>
            跟 AI 一句句聊着出图：首轮按你的话立意出图，之后每轮自动以上一轮产图为参考，
            说改哪就改哪。
          </p>
          <button className="btn btn-primary" onClick={() => void createChat()}>
            <IconPlus /> 新建对话
          </button>
          {sessions.length > 0 && <span className="sci-hero-sub">或从左侧选一个会话继续</span>}
        </section>
      ) : loadError !== null ? (
        <section className="sci-hero">
          <IconAlert className="sci-hero-icon" />
          <h2>会话打不开</h2>
          <p>{loadError}</p>
          <button className="btn btn-outline" onClick={() => navigate('/studio/chat')}>
            回到会话列表
          </button>
        </section>
      ) : meta === null ? (
        <section className="sci-hero">
          <p>正在打开会话…</p>
        </section>
      ) : (
        <section className="sci-main">
          <header className="sci-head">
            <button
              className="sci-head-title"
              title="重命名"
              onClick={() => setRenaming({ id: openId, title: meta.title })}
            >
              {meta.title}
              <IconEdit />
            </button>
            {meta.pinned && <span className="sci-head-pin">置顶</span>}
            <span className="sci-head-space" />
            {mjReady && (
              <div className="sci-seg" role="group" aria-label="引擎">
                <button
                  className={useMidjourney ? '' : 'on'}
                  title="默认图片模型：一句话改一处，尺寸跟随参考"
                  onClick={() => setEngine('default')}
                >
                  默认
                </button>
                <button
                  className={useMidjourney ? 'on' : ''}
                  title="Midjourney：出四宫格，出完还能接着放大与变体"
                  onClick={() => setEngine('midjourney')}
                >
                  Midjourney
                </button>
              </div>
            )}
            {useMidjourney ? (
              <div className="sci-seg" role="group" aria-label="Midjourney 版本">
                {MIDJOURNEY_VERSIONS.map((value) => (
                  <button
                    key={value}
                    className={mjVersion === value ? 'on' : ''}
                    title={`Midjourney v${value}`}
                    onClick={() => setMjVersion(value)}
                  >
                    v{value}
                  </button>
                ))}
              </div>
            ) : (
              <>
                <div className="sci-seg" role="group" aria-label="质量">
                  {QUALITIES.map(([key, label]) => (
                    <button
                      key={key}
                      className={quality === key ? 'on' : ''}
                      onClick={() => setQuality(key)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="sci-seg" role="group" aria-label="张数">
                  {[1, 2, 3, 4].map((v) => (
                    <button key={v} className={count === v ? 'on' : ''} onClick={() => setCount(v)}>
                      {v}
                    </button>
                  ))}
                </div>
              </>
            )}
          </header>

          <div className="sci-stream" ref={streamRef}>
            {turns.length === 0 && !showSkeleton && (
              <div className="sci-stream-empty">
                {useMidjourney
                  ? '说一句想要的画面就开始。Midjourney 一次出四宫格，出完每张图旁边都能接着放大或做变体。'
                  : '说一句想要的画面就开始。首轮由立意管线按内容挑画幅；出图后每轮自动以上一轮为参考，直接说「换成夜景」「衣服改成红色」就行。'}
              </div>
            )}
            {turns.map((t, i) =>
              t.role === 'user' ? (
                <div className="sci-turn sci-turn-user" key={i}>
                  <div className="sci-bubble-user">
                    {(t.ref_asset_ids?.length ?? 0) > 0 && (
                      <div className="sci-bubble-refs">
                        {(t.ref_asset_ids ?? []).map((rid) => (
                          <RefThumb key={rid} id={rid} />
                        ))}
                      </div>
                    )}
                    <p>{t.text}</p>
                  </div>
                </div>
              ) : (
                <div className="sci-turn sci-turn-ai" key={i}>
                  {t.error !== undefined ? (
                    <div className="sci-bubble-err">
                      <IconAlert />
                      <span>{t.error}</span>
                      {i === turns.length - 1 && (
                        <button className="btn btn-outline sci-retry" onClick={retry}>
                          重试
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="sci-bubble-ai">
                      <div className="sci-grid" data-n={Math.min(t.asset_ids?.length ?? 1, 4)}>
                        {(t.asset_ids ?? []).map((aid) => (
                          <Shot
                            key={aid}
                            id={aid}
                            isRef={refIds.includes(aid)}
                            shot={shots.get(aid)}
                            busy={busy !== null}
                            onView={setViewing}
                            onSetRef={setAsRef}
                            onToConsole={(a) => void toConsole(a)}
                            onAction={runShotAction}
                          />
                        ))}
                      </div>
                      {t.latency_ms !== undefined && (
                        <span className="sci-latency">{(t.latency_ms / 1000).toFixed(1)}s</span>
                      )}
                    </div>
                  )}
                </div>
              ),
            )}
            {showSkeleton && busy !== null && (
              <div className="sci-turn sci-turn-ai">
                <div className="sci-bubble-ai">
                  <div className="sci-grid" data-n={Math.min(busy.n, 4)}>
                    {Array.from({ length: busy.n }, (_, k) => (
                      <div className="sci-shot sci-ph" key={k} />
                    ))}
                  </div>
                  <span className="sci-latency">生成中 · 已 {elapsed}s</span>
                </div>
              </div>
            )}
          </div>

          <div className="sci-refbar">
            <span className="sci-refbar-label">参考</span>
            {refIds.map((rid) => (
              <RefThumb
                key={rid}
                id={rid}
                onRemove={() => setRefIds((ids) => ids.filter((x) => x !== rid))}
              />
            ))}
            <button className="sci-ref-add" title="从资产库补参考" onClick={() => setPicking(true)}>
              <IconPlus />
            </button>
            <span className="sci-refbar-note">
              {useMidjourney
                ? refIds.length > 0
                  ? `随下一句走 Midjourney 编辑模式，最多带 ${MIDJOURNEY_MAX_REFS} 张`
                  : '暂无参考 · 这一句走 Midjourney 生成，出四宫格'
                : refIds.length > 0
                  ? '随下一句发送，尺寸跟随参考比例；生成完自动换成最新产图'
                  : '暂无参考 · 这一句走立意管线，画幅按内容自动挑'}
            </span>
          </div>

          <div className="sci-input">
            <textarea
              className="sci-input-box"
              rows={2}
              placeholder="描述要生成或要改的画面，Enter 发送、Shift+Enter 换行"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void send()
                }
              }}
            />
            <button
              className="btn btn-primary sci-send"
              disabled={busy !== null || draft.trim() === ''}
              onClick={() => void send()}
            >
              <IconSend /> {busy !== null ? '生成中…' : '发送'}
            </button>
          </div>
        </section>
      )}

      {picking && (
        <AssetPicker
          picked={refIds}
          onToggle={(id) =>
            setRefIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))
          }
          onClose={() => setPicking(false)}
        />
      )}
      {viewing !== null && (
        <Viewer
          asset={viewing}
          isRef={refIds.includes(viewing.id)}
          onSetRef={setAsRef}
          onToConsole={(a) => void toConsole(a)}
          onClose={() => setViewing(null)}
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
    </main>
  )
}
