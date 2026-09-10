/* 素材库（FR-477 · M2）：模块 16 资产库之上的分组、AI 打标、URL 导入与检索。

   这里只加「归属」和「标签」两层元信息，图本身仍归模块 16 管（BR-140）——
   所以页面里所有删除类动作都不删图，删组只解除归属。

   批量打标两条路：不超过 8 张走同步接口当场打完；再多就交后台队列（FR-484），
   进度按 job_id 轮询，done/total/failed 三个数原样来自服务端。 */

import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import type { InfiniteData } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArchiveRestore,
  Download,
  FolderCog,
  HardDrive,
  Maximize2,
  RotateCcw,
  Save,
  Settings2,
  Trash2,
  Upload,
} from '@/components/NexusIcon'

import {
  IconAlert,
  IconCheck,
  IconClose,
  IconFileText,
  IconLink,
  IconSearch,
  IconSparkle,
  IconStar,
  IconVideo,
} from '../../components/icons'
import { ActionPicker, Picker } from '@/components/ui/picker'
import { Overlay } from '../../components/Overlay'
import { apiImage } from '../../lib/api-image'
import type { AssetFilters, AssetPage, ImageAsset } from '../../lib/api-image'
import { apiConfig } from '../../lib/api-config'
import { apiStudio } from '../../lib/api-studio'
import type {
  AssetGroup,
  AssetStorageKind,
  AssetStorageOverview,
  AssetTagResult,
  AssetTagSettings,
  StudioMediaAsset,
  TagJob,
} from '../../lib/api-studio'
import { rectFromPoints, rectsIntersect } from './canvas-core'
import type { Rect } from './canvas-core'
import { ImageViewer } from '../../components/ImageViewer'
import { AssetDetailPanel } from './AssetDetailPanel'
import { AssetGroupTree, sameScope } from './AssetGroupTree'
import type { Scope } from './AssetGroupTree'
import { AssetManagerTabs } from './AssetManagerTabs'
import { AssetImportUrls } from './AssetImportUrls'
import { CanvasAssetLibrary } from './CanvasAssetLibrary'
import { SharedFolderLibrary } from './SharedFolderLibrary'
import './asset-library.css'
import { saveFile } from '@/lib/shell'

const PAGE_SIZE = 60
/** 打标分批：一次全塞给同步接口，几十张要等好几分钟且中途看不到任何结果 */
const TAG_CHUNK = 8
/** 超过这个张数就交后台队列。同步接口是串行调模型，十几张起就会把请求挂到超时 */
const QUEUE_OVER = 8
/** 队列进度问多勤。数字全部来自服务端，前端不插值也不估 */
const JOB_POLL_MS = 2000
/** 队列跑着时离开这一页也不该丢进度，回来接着看同一个 job */
const JOB_KEY = 'sal-tag-job'
/** 失败原文最多弹几条 toast，其余留在卡片上，不刷屏也不吞 */
const TOAST_CAP = 3

function errText(e: unknown): string {
  return e instanceof Error ? e.message : '未知错误'
}

function saveDownload(result: { blob: Blob; filename: string }): void {
  saveFile(result.blob, result.filename)
}

/** 资产行的边界归一。

    M2 的 group_id/caption/tags/tagged_at 是这一轮才加到 image_asset 上的列，
    后端没跟上时接口回的行里根本没有 tags 这个键，`for (const t of a.tags)`
    直接把整页炸成白屏（实测踩到）。接口是系统边界，缺字段在这里补默认。 */
function normalize(raw: ImageAsset): ImageAsset {
  const loose = raw as unknown as Record<string, unknown>
  return {
    ...raw,
    display_name: typeof loose.display_name === 'string' ? loose.display_name : null,
    tags: Array.isArray(loose.tags) ? (loose.tags as string[]) : [],
    caption: typeof loose.caption === 'string' ? loose.caption : null,
    tagged_at: typeof loose.tagged_at === 'string' ? loose.tagged_at : null,
    group_id: typeof loose.group_id === 'number' ? loose.group_id : null,
    favorite: loose.favorite === true,
  }
}

type LibraryKind = 'image' | 'video' | 'audio' | 'file' | 'shared' | 'canvas'

export default function AssetLibraryPage() {
  const [kind, setKind] = useState<LibraryKind>('image')
  const managerTabs = (active: 'assets' | 'canvas' | 'local') => (
    <AssetManagerTabs
      active={active}
      onAssets={() => setKind('image')}
      onCanvas={() => setKind('canvas')}
      onLocal={() => setKind('shared')}
    />
  )
  return kind === 'canvas' ? (
    <CanvasAssetLibrary tabs={managerTabs('canvas')} />
  ) : kind === 'shared' ? (
    <SharedFolderLibrary tabs={managerTabs('local')} />
  ) : kind === 'image' ? (
    <ImageAssetLibrary onKind={setKind} managerTabs={managerTabs('assets')} />
  ) : (
    <MediaAssetLibrary kind={kind} onKind={setKind} managerTabs={managerTabs('assets')} />
  )
}

function LibraryTabs({ kind, onKind }: { kind: LibraryKind; onKind: (kind: LibraryKind) => void }) {
  const tabs: { key: LibraryKind; label: string }[] = [
    { key: 'image', label: '图片' },
    { key: 'video', label: '视频' },
    { key: 'audio', label: '音频' },
    { key: 'file', label: '文件' },
  ]
  return (
    <div className="sal-kind-tabs" aria-label="素材类型">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          className={kind === tab.key ? 'sal-kind-tab is-active' : 'sal-kind-tab'}
          onClick={() => onKind(tab.key)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}

function ImageAssetLibrary({
  onKind,
  managerTabs,
}: {
  onKind: (kind: LibraryKind) => void
  managerTabs: ReactNode
}) {
  const qc = useQueryClient()
  const [scope, setScope] = useState<Scope>({ kind: 'all' })
  const [text, setText] = useState('')
  const [q, setQ] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [batch, setBatch] = useState(false)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [detailId, setDetailId] = useState<number | null>(null)
  /** 看大图停在第几张（在 `visible` 里的下标）。null = 没开 */
  const [viewing, setViewing] = useState<number | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [tagging, setTagging] = useState<{ done: number; total: number } | null>(null)
  const [tagFailed, setTagFailed] = useState<Map<number, string>>(new Map())
  // 刷新/离开再回来都能接上：真正的进度在服务端，这里只存一个 job_id
  const [jobId, setJobId] = useState<string | null>(() => sessionStorage.getItem(JOB_KEY))
  const [job, setJob] = useState<TagJob | null>(null)
  const [jobError, setJobError] = useState<string | null>(null)
  const [bodyEl, setBodyEl] = useState<HTMLDivElement | null>(null)
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null)
  const uploadRef = useRef<HTMLInputElement | null>(null)
  const [uploading, setUploading] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [marquee, setMarquee] = useState<Rect | null>(null)
  const marqueeDrag = useRef<{
    pointerId: number
    start: { x: number; y: number }
    base: Set<number>
  } | null>(null)

  // 搜索是模糊匹配，每敲一下打一次接口太浪费，停 300ms 再发
  useEffect(() => {
    const timer = window.setTimeout(() => setQ(text.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [text])

  const groupsQuery = useQuery({ queryKey: ['sal-groups'], queryFn: () => apiStudio.assetGroups() })
  const groups: AssetGroup[] = groupsQuery.data?.items ?? []
  const groupsError = groupsQuery.isError ? errText(groupsQuery.error) : null

  const filters = useMemo<AssetFilters>(() => {
    const f: AssetFilters = { limit: PAGE_SIZE }
    if (scope.kind === 'ungrouped') f.group_id = 0
    else if (scope.kind === 'untagged') f.untagged = true
    else if (scope.kind === 'archived') f.status = 'archived'
    else if (scope.kind === 'group') f.group_id = scope.id
    if (q !== '') f.q = q
    // 接口的 tag 只收一个标签；选了多个时不传，改在已加载的这批里筛（下面有说明）
    if (tags.length === 1 && scope.kind !== 'untagged') f.tag = tags[0]
    return f
  }, [scope, q, tags])

  const page = useInfiniteQuery({
    queryKey: ['sal-assets', filters],
    queryFn: ({ pageParam }) => apiImage.assets({ ...filters, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0)
      return loaded < last.total ? loaded : undefined
    },
    placeholderData: keepPreviousData,
  })

  const { fetchNextPage, hasNextPage, isFetchingNextPage } = page
  const total = page.data?.pages[0]?.total ?? null
  // 侧栏「全部素材」右边那个数只有在真的没筛任何条件时才等于全部；
  // 搜索/标签筛过之后还挂在那儿，会让人以为素材少了一大半
  const totalForSide = scope.kind === 'all' && q === '' && tags.length === 0 ? total : null

  // 服务端按 created_at 倒序返回；这里再排一次，保证跨页拼起来的顺序始终一致
  const items = useMemo(() => {
    const flat = (page.data?.pages.flatMap((p) => p.items) ?? []).map(normalize)
    return [...flat].sort((a, b) => {
      const at = a.created_at ?? ''
      const bt = b.created_at ?? ''
      if (at !== bt) return bt.localeCompare(at)
      return b.id - a.id
    })
  }, [page.data])

  // 接口回的行里连 tags 键都没有 = 后端的 M2 列还没上线。这时打标与归属按钮点了
  // 也不会有效果，照实说出来（STD-UI-006），不让用户对着没反应的按钮猜
  const m2Missing = useMemo(() => {
    const flat = page.data?.pages.flatMap((p) => p.items) ?? []
    return flat.length > 0 && flat.every((a) => !('tags' in (a as unknown as object)))
  }, [page.data])

  // chips 从已加载的结果里聚合，按出现次数排
  const tagCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const a of items) for (const t of a.tags) map.set(t, (map.get(t) ?? 0) + 1)
    return [...map.entries()].sort((x, y) => (y[1] === x[1] ? x[0].localeCompare(y[0]) : y[1] - x[1]))
  }, [items])

  const visible = useMemo(() => {
    if (tags.length === 0) return items
    return items.filter((a) => a.tags.some((t) => tags.includes(t)))
  }, [items, tags])

  // 从 items 而不是 visible 里找：标签筛选把它挡掉时，详情不该跟着消失
  const detail = detailId === null ? null : (items.find((a) => a.id === detailId) ?? null)

  // 换了筛选条件等于换了一份列表，旧的选中项与滚动位置不该留着
  useEffect(() => {
    setPicked(new Set())
    bodyEl?.scrollTo({ top: 0 })
  }, [filters, bodyEl])

  // 触底预拉下一页。IO 在自动化面板里可能一次都不回调，所以下面另留一个按钮兜底
  useEffect(() => {
    if (sentinel === null || bodyEl === null || !hasNextPage) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) void fetchNextPage()
      },
      { root: bodyEl, rootMargin: '400px' },
    )
    io.observe(sentinel)
    return () => io.disconnect()
  }, [sentinel, bodyEl, hasNextPage, isFetchingNextPage, fetchNextPage])

  const refreshAssets = () => void qc.invalidateQueries({ queryKey: ['sal-assets'] })

  const del = useMutation({
    mutationFn: async (ids: number[]) => {
      const { items: usages } = await apiImage.previewDeleteAssets(ids)
      const referenced = usages.filter(u => !u.deletable)
      if (!window.confirm(`彻底删除 ${ids.length} 张素材？其中 ${referenced.length} 张被引用，默认跳过。删除后无法恢复。`)) {
        return null
      }
      const forceIds = referenced.length && window.confirm(
        `是否同时强制删除以下 ${referenced.length} 张被引用素材？关联内容可能失效。\n\n` +
        referenced.map(u => `#${u.asset_id} ${u.summary || '仍有引用'}`).join('\n'),
      ) ? referenced.map(u => u.asset_id) : []
      return apiImage.bulkDeleteAssets(ids, forceIds)
    },
    onSuccess: (res) => {
      if (res === null) return
      refreshAssets()
      refreshGroups()
      setPicked(new Set())
      setDetailId(null)
      if (res.failed > 0) {
        const first = res.results.find((r) => !r.deleted)
        toast.error(`${res.deleted} 张已删，${res.failed} 张没删掉：${first?.reason ?? '未知原因'}`)
      } else if (!res.storage_clean) {
        toast.warning(`已删除 ${res.deleted} 张，但有文件没清干净`)
      } else toast.success(`已删除 ${res.deleted} 张`)
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : '删除失败'),
  })
  const refreshGroups = () => void qc.invalidateQueries({ queryKey: ['sal-groups'] })

  /** 局部改一张图，不整页重拉——重拉会让刚打完标的结果在眼前闪一下又跳走 */
  const patchInCache = (raw: ImageAsset) => {
    const next = normalize(raw)
    qc.setQueriesData<InfiniteData<AssetPage>>({ queryKey: ['sal-assets'] }, (old) => {
      if (old === undefined) return old
      return {
        ...old,
        pages: old.pages.map((p) => ({
          ...p,
          items: p.items.map((a) => (a.id === next.id ? next : a)),
        })),
      }
    })
  }

  // 队列轮询的 effect 依赖它，所以要稳定：捕获的 qc 与 setState 本身都是稳的
  const applyTagResults = useCallback(
    (results: AssetTagResult[]) => {
      const ok = new Map<number, AssetTagResult>()
      for (const r of results) if (r.error === undefined || r.error === '') ok.set(r.asset_id, r)
      if (ok.size > 0) {
        const now = new Date().toISOString()
        qc.setQueriesData<InfiniteData<AssetPage>>({ queryKey: ['sal-assets'] }, (old) => {
          if (old === undefined) return old
          return {
            ...old,
            pages: old.pages.map((p) => ({
              ...p,
              items: p.items.map((a) => {
                const hit = ok.get(a.id)
                if (hit === undefined) return a
                return { ...a, caption: hit.caption, tags: hit.tags, tagged_at: now }
              }),
            })),
          }
        })
      }
      setTagFailed((prev) => {
        const next = new Map(prev)
        for (const r of results) {
          if (r.error !== undefined && r.error !== '') next.set(r.asset_id, r.error)
          else next.delete(r.asset_id)
        }
        return next
      })
    },
    [qc],
  )

  /** 队列轮询。setTimeout 链而不是 setInterval：一次问慢了不会把下一次叠上来。
   *
   *  界面上的 done/total/failed 全部照抄这里拿到的 TagJob，前端不做任何估算——
   *  假进度条比没有进度条更坏（BR-110）。 */
  useEffect(() => {
    if (jobId === null) return
    let alive = true
    let timer = 0
    const tick = async (): Promise<void> => {
      try {
        const j = await apiStudio.tagJob(jobId)
        if (!alive) return
        setJob(j)
        setJobError(null)
        // 边跑边把已出的结果贴到卡片上，不等整批跑完
        applyTagResults(j.items)
        if (j.status === 'running') {
          timer = window.setTimeout(() => void tick(), JOB_POLL_MS)
          return
        }
        sessionStorage.removeItem(JOB_KEY)
        setJobId(null)
        if (j.failed > 0) {
          toast.error(`打标队列结束：共 ${j.total} 张，完成 ${j.done}，失败 ${j.failed}（原因逐条列在上面）`)
        } else {
          toast.success(`打标队列跑完：共 ${j.total} 张，完成 ${j.done}`)
        }
      } catch (e) {
        if (!alive) return
        // 查不到就别再轮了（服务重启后 job 不在内存里是常态），原因照抄给用户
        sessionStorage.removeItem(JOB_KEY)
        setJobId(null)
        setJobError(errText(e))
      }
    }
    void tick()
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [jobId, applyTagResults])

  const jobRunning = jobId !== null
  const tagBusy = tagging !== null || jobRunning

  /** 交后台队列。返回后这一页就只剩轮询，用户可以走开 */
  const startTagJob = async (ids: number[]) => {
    try {
      const started = await apiStudio.startTagJob({ asset_ids: ids })
      sessionStorage.setItem(JOB_KEY, started.job_id)
      setJob(started)
      setJobError(null)
      setJobId(started.job_id)
      setPicked(new Set())
      toast.success(`${ids.length} 张交给后台队列了，进度在上面实时更新，可以离开这一页`)
    } catch (e) {
      toast.error(`打标队列没起来：${errText(e)}`)
    }
  }

  const runTag = async (ids: number[]) => {
    if (ids.length === 0 || tagBusy) return
    // 同步接口是一张一张串着调模型，十几张就能把请求挂到超时——过线交队列
    if (ids.length > QUEUE_OVER) {
      await startTagJob(ids)
      return
    }
    setTagging({ done: 0, total: ids.length })
    let okCount = 0
    let badCount = 0
    let toasted = 0
    for (let i = 0; i < ids.length; i += TAG_CHUNK) {
      const slice = ids.slice(i, i + TAG_CHUNK)
      try {
        const res = await apiStudio.tagAssets({ asset_ids: slice })
        applyTagResults(res.items)
        for (const r of res.items) {
          if (r.error !== undefined && r.error !== '') {
            badCount += 1
            if (toasted < TOAST_CAP) {
              toast.error(`#${r.asset_id} 打标失败：${r.error}`)
              toasted += 1
            }
          } else {
            okCount += 1
          }
        }
      } catch (e) {
        // 整段请求没通（网络/接口不在），这一段全记失败，原文照抄到每张卡上
        const reason = errText(e)
        applyTagResults(slice.map((id) => ({ asset_id: id, caption: '', tags: [], error: reason })))
        badCount += slice.length
        if (toasted < TOAST_CAP) {
          toast.error(`${slice.length} 张打标失败：${reason}`)
          toasted += 1
        }
      }
      setTagging({ done: Math.min(i + TAG_CHUNK, ids.length), total: ids.length })
    }
    setTagging(null)
    if (okCount > 0 && badCount === 0) toast.success(`打标完成，成功 ${okCount} 张`)
    else if (okCount > 0) toast.success(`成功 ${okCount} 张，失败 ${badCount} 张（失败原因在卡片上，可单张重试）`)
    else if (badCount > TOAST_CAP) toast.error(`${badCount} 张全部失败，原因逐张标在卡片上`)
  }

  const moveTo = async (ids: number[], groupId: number | null) => {
    if (ids.length === 0) return
    try {
      const r = await apiStudio.moveAssets({ asset_ids: ids, group_id: groupId })
      const name = groupId === null ? '未归组' : (groups.find((g) => g.id === groupId)?.name ?? `#${groupId}`)
      toast.success(`${r.moved} 张已移到「${name}」`)
      for (const id of ids) {
        const hit = items.find((a) => a.id === id)
        if (hit !== undefined) patchInCache({ ...hit, group_id: groupId })
      }
      setPicked(new Set())
      refreshGroups()
      // 当前视图按归属筛过，移走的那几张不该再留在里面
      if (scope.kind === 'group' || scope.kind === 'ungrouped') refreshAssets()
    } catch (e) {
      toast.error(errText(e))
    }
  }

  const uploadLocal = async (files: FileList) => {
    setUploading(true)
    let saved = 0
    try {
      for (const file of Array.from(files)) {
        const form = new FormData()
        form.set('image', file)
        form.set('op', 'upload')
        const row = await apiImage.saveLocal(form)
        if (scope.kind === 'group') {
          await apiStudio.moveAssets({ asset_ids: [row.id], group_id: scope.id })
        }
        saved += 1
      }
      toast.success(`${saved} 张本地图片已存入素材库`)
      refreshAssets()
      refreshGroups()
    } catch (error) {
      toast.error(`本地上传失败：${errText(error)}`)
    } finally {
      setUploading(false)
    }
  }

  const changeArchive = async (ids: number[], archived: boolean) => {
    if (ids.length === 0) return
    try {
      await Promise.all(ids.map((id) => apiImage.patchAsset(id, {
        status: archived ? 'archived' : 'candidate',
      })))
      toast.success(archived ? `${ids.length} 张已移入归档` : `${ids.length} 张已恢复`)
      setPicked(new Set())
      setDetailId(null)
      refreshAssets()
    } catch (error) {
      toast.error(errText(error))
    }
  }

  const downloadPicked = async (ids: number[]) => {
    if (ids.length === 0 || downloading) return
    setDownloading(true)
    try {
      saveDownload(await apiStudio.downloadOutputImages({
        asset_ids: ids,
        filename: `素材-${new Date().toISOString().slice(0, 10)}`,
      }))
    } catch (error) {
      toast.error(`批量下载失败：${errText(error)}`)
    } finally {
      setDownloading(false)
    }
  }

  const clickCell = (a: ImageAsset) => {
    if (!batch) {
      setDetailId(a.id)
      return
    }
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(a.id)) next.delete(a.id)
      else next.add(a.id)
      return next
    })
  }

  const beginMarquee = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!batch || event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('button, input, textarea, select, a')) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const body = event.currentTarget.getBoundingClientRect()
    marqueeDrag.current = {
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      base: new Set(picked),
    }
    setMarquee({
      x: event.clientX - body.left + event.currentTarget.scrollLeft,
      y: event.clientY - body.top + event.currentTarget.scrollTop,
      width: 1,
      height: 1,
    })
  }

  const updateMarquee = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = marqueeDrag.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    const viewportRect = rectFromPoints(drag.start, { x: event.clientX, y: event.clientY })
    const next = new Set(drag.base)
    for (const cell of event.currentTarget.querySelectorAll<HTMLElement>('[data-asset-id]')) {
      const box = cell.getBoundingClientRect()
      if (rectsIntersect(viewportRect, {
        x: box.left,
        y: box.top,
        width: box.width,
        height: box.height,
      })) {
        const assetId = Number(cell.dataset.assetId)
        if (Number.isInteger(assetId)) next.add(assetId)
      }
    }
    setPicked(next)
    const body = event.currentTarget.getBoundingClientRect()
    setMarquee({
      x: viewportRect.x - body.left + event.currentTarget.scrollLeft,
      y: viewportRect.y - body.top + event.currentTarget.scrollTop,
      width: Math.max(1, viewportRect.width),
      height: Math.max(1, viewportRect.height),
    })
  }

  const endMarquee = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = marqueeDrag.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    marqueeDrag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setMarquee(null)
  }

  const toggleBatch = () => {
    setBatch((on) => !on)
    setPicked(new Set())
    setDetailId(null)
    marqueeDrag.current = null
    setMarquee(null)
  }

  const scopeName =
    scope.kind === 'all'
      ? '全部素材'
      : scope.kind === 'ungrouped'
        ? '未归组'
      : scope.kind === 'untagged'
          ? '未打标'
          : scope.kind === 'archived'
            ? '归档'
          : (groups.find((g) => g.id === scope.id)?.name ?? '分组')

  const pickedIds = [...picked]
  // 失败的逐条列原文，不汇总成「N 张失败」了事
  const jobFails = (job?.items ?? []).filter((r) => r.error !== undefined && r.error !== '')

  return (
    <main className="page sal-page">
      <AssetGroupTree
        groups={groups}
        // 用 isPending 不用 isLoading：retry:1 的重试等待期里 isLoading 已经是 false、
        // isError 还没到，这个窗口会让侧栏胡说「还没有库」（实测撞到）
        loading={groupsQuery.isPending}
        error={groupsError}
        total={totalForSide}
        scope={scope}
        onScope={(next) => {
          if (!sameScope(next, scope)) setDetailId(null)
          setScope(next)
        }}
        onGroupsChanged={refreshGroups}
        onAssetsChanged={refreshAssets}
      />

      <section className="sal-main">
        {managerTabs}
        <header className="sal-head">
          <div>
            <h1>素材库</h1>
            <p>{scopeName} · 分组只是给资产贴归属，图始终存在资产库里</p>
          </div>
          <LibraryTabs kind="image" onKind={onKind} />
          <span className="sal-flex" />
          <input
            ref={uploadRef}
            className="sal-hidden-file"
            type="file"
            accept="image/*"
            multiple
            onChange={(event) => {
              if (event.target.files && event.target.files.length > 0) {
                void uploadLocal(event.target.files)
              }
              event.target.value = ''
            }}
          />
          <button className="btn btn-outline" disabled={uploading} onClick={() => uploadRef.current?.click()}>
            <Upload /> {uploading ? '上传中…' : '本地上传'}
          </button>
          <button className="btn btn-outline" onClick={() => setImportOpen(true)}>
            <IconLink /> 导入 URL
          </button>
          <button className={batch ? 'btn btn-soft' : 'btn btn-outline'} onClick={toggleBatch}>
            <IconCheck /> {batch ? '退出批量' : '批量'}
          </button>
          <button className="btn btn-outline" onClick={() => setSettingsOpen(true)}>
            <Settings2 /> 设置
          </button>
        </header>

        <div className="sal-bar">
          <span className="sal-search">
            <IconSearch />
            <input
              value={text}
              placeholder="搜提示词、摘要…"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && text !== '') {
                  // 两段式：先清搜索词，不冒到浮层栈（STD-UI-002b）
                  e.stopPropagation()
                  setText('')
                }
              }}
            />
          </span>
          {tags.length > 0 && (
            <button className="btn btn-ghost-sm" onClick={() => setTags([])}>
              清空标签筛选（{tags.length}）
            </button>
          )}
        </div>

        {jobError !== null && (
          <p className="sal-note sal-note-err">
            打标队列查不下去了：{jobError}
            <button className="btn btn-ghost-sm" onClick={() => setJobError(null)}>
              知道了
            </button>
          </p>
        )}

        {job !== null && (
          <div className="sal-job">
            <div className="sal-job-line">
              <span className="sal-job-name">
                <IconSparkle /> AI 打标队列
                {job.status === 'running' ? '' : job.status === 'failed' ? ' · 失败' : ' · 结束'}
              </span>
              <span className="sal-job-num">
                完成 {job.done}/{job.total} · 失败 {job.failed}
              </span>
              <span className="sal-flex" />
              {jobRunning ? (
                <span className="sal-job-hint">
                  这几个数是每 {JOB_POLL_MS / 1000} 秒问服务端拿的真实进度；离开这一页也照跑，回来接着看
                </span>
              ) : (
                <button className="btn btn-ghost-sm" onClick={() => setJob(null)}>
                  <IconClose /> 收起
                </button>
              )}
            </div>
            <div className="sal-job-track">
              <span
                className="sal-job-fill"
                style={{ width: `${job.total === 0 ? 0 : Math.min(100, (job.done / job.total) * 100)}%` }}
              />
            </div>
            {jobFails.length > 0 && (
              <ul className="sal-job-fails">
                {jobFails.map((r) => (
                  <li key={r.asset_id}>
                    <IconAlert />
                    <span>
                      #{r.asset_id} {r.error}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {tagCounts.length > 0 && (
          <div className="sal-tags">
            {tagCounts.map(([t, n]) => (
              <button
                key={t}
                className={tags.includes(t) ? 'sal-tag sal-tag-on' : 'sal-tag'}
                disabled={scope.kind === 'untagged'}
                onClick={() =>
                  setTags((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]))
                }
              >
                {t} · {n}
              </button>
            ))}
          </div>
        )}

        {scope.kind === 'untagged' && tagCounts.length > 0 && (
          <p className="sal-note">「未打标」下按标签筛没有意义（这些图本来就没有标签），标签按钮已停用。</p>
        )}
        {scope.kind !== 'untagged' && tags.length > 1 && (
          <p className="sal-note">
            接口一次只认一个标签，所以多选是在已加载的 {items.length} 张里按「命中任一」筛的；
            要在全部素材里精确检索，只选一个标签。
          </p>
        )}
        {m2Missing && (
          <p className="sal-note sal-note-err">
            当前后端返回的资产行里没有 tags / group_id 字段，说明素材库的分组与打标列还没上线：
            图能看能搜，但打标、标签筛选、移动分组这三件事这会儿点了不会生效。
          </p>
        )}
        {page.isError && (
          <p className="sal-note sal-note-err">
            素材加载失败：{errText(page.error)}
            <button className="btn btn-ghost-sm" onClick={() => void page.refetch()}>
              重试
            </button>
          </p>
        )}

        <div
          className={batch ? 'sal-body is-selecting' : 'sal-body'}
          ref={setBodyEl}
          onPointerDown={beginMarquee}
          onPointerMove={updateMarquee}
          onPointerUp={endMarquee}
          onPointerCancel={endMarquee}
        >
          {marquee !== null && (
            <span
              className="sal-marquee"
              aria-hidden="true"
              style={{ left: marquee.x, top: marquee.y, width: marquee.width, height: marquee.height }}
            />
          )}
          {page.isPending && <p className="sal-empty">载入素材…</p>}
          {!page.isPending && !page.isError && visible.length === 0 && (
            <p className="sal-empty">
              {q !== '' || tags.length > 0
                ? '没有匹配的素材。换个词，或清掉标签筛选。'
                : scope.kind === 'archived'
                  ? '归档里还没有素材。归档后的图片会保留在这里，可随时恢复。'
                  : '这里还没有素材。去生图控制台出图，或用右上角「导入 URL」拉几张进来。'}
            </p>
          )}

          {visible.length > 0 && (
            <div className="sal-grid">
              {visible.map((a) => {
                const on = picked.has(a.id)
                const failed = tagFailed.get(a.id)
                return (
                  <button
                    key={a.id}
                    data-asset-id={a.id}
                    className={on ? 'sal-cell sal-cell-on' : 'sal-cell'}
                    title={a.caption ?? a.prompt}
                    onClick={() => clickCell(a)}
                  >
                    <img src={a.thumb_url} alt={a.caption ?? ''} loading="lazy" />
                    <span className="sal-cell-name">{a.display_name || `素材 #${a.id}`}</span>
                    {/* 悬停动作。看大图此前**根本没有入口**——想看清楚只能点开详情栏，
                        而那里也只是一张 768px 的展示图。删除此前也只有「归档」，
                        软删堆着的图会一直占着存储 */}
                    {!batch && (
                      <span
                        className="sal-cell-ops"
                        onClick={(e) => e.stopPropagation()}
                        role="presentation"
                      >
                        <button
                          aria-label="看大图"
                          title="看大图"
                          onClick={() => setViewing(visible.findIndex((x) => x.id === a.id))}
                        >
                          <Maximize2 />
                        </button>
                        <button
                          className="is-danger"
                          aria-label="删除"
                          title="彻底删除（与归档不同，删了找不回来）"
                          disabled={del.isPending}
                          onClick={() => del.mutate([a.id])}
                        >
                          <Trash2 />
                        </button>
                      </span>
                    )}
                    {on && (
                      <span className="sal-tick">
                        <IconCheck />
                      </span>
                    )}
                    {a.favorite && !on && (
                      <span className="sal-fav">
                        <IconStar filled />
                      </span>
                    )}
                    {failed !== undefined && (
                      <span className="sal-badge" title={failed}>
                        <IconAlert /> 打标失败
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}

          <div className="sal-more" ref={setSentinel}>
            {isFetchingNextPage && '载入更多…'}
            {!isFetchingNextPage && hasNextPage && (
              <button className="btn btn-ghost-sm" onClick={() => void fetchNextPage()}>
                加载更多
              </button>
            )}
            {!hasNextPage && total !== null && total > 0 && `共 ${total} 张，已到底`}
          </div>
        </div>

        {batch && (
          <div className="sal-batchbar">
            <span className="sal-batch-count">已选 {picked.size} 张</span>
            <span className="sal-batch-hint">可从网格空白处拖框多选</span>
            <ActionPicker
              className="sal-sel"
              label="移动到分组…"
              disabled={picked.size === 0 || groupsError !== null}
              onPick={(v) => void moveTo(pickedIds, v === 'none' ? null : Number(v))}
              options={[
                { value: 'none', label: '移出分组（未归组）' },
                ...groups
                  .filter((g) => g.parent_id === null)
                  .flatMap((lib) => [
                    { value: String(lib.id), label: lib.name },
                    ...groups
                      .filter((g) => g.parent_id === lib.id)
                      .map((sub) => ({ value: String(sub.id), label: `　└ ${sub.name}` })),
                  ]),
              ]}
            />
            <button
              className={tagBusy ? 'btn btn-soft loading' : 'btn btn-soft'}
              disabled={picked.size === 0 || tagBusy}
              title={
                picked.size > QUEUE_OVER
                  ? `超过 ${QUEUE_OVER} 张，这一批会交后台队列跑`
                  : `不超过 ${QUEUE_OVER} 张，直接同步打完再回来`
              }
              onClick={() => void runTag(pickedIds)}
            >
              {tagBusy ? <span className="spinner" /> : <IconSparkle />}
              {tagging !== null
                ? `打标中 ${tagging.done}/${tagging.total}`
                : jobRunning
                  ? `队列中 ${job?.done ?? 0}/${job?.total ?? 0}`
                  : picked.size > QUEUE_OVER
                    ? `AI 打标（${picked.size} 张，走队列）`
                    : 'AI 打标'}
            </button>
            <button
              className="btn btn-outline"
              disabled={picked.size === 0 || downloading}
              onClick={() => void downloadPicked(pickedIds)}
            >
              <Download /> {downloading ? '打包中…' : '下载 ZIP'}
            </button>
            <button
              className="btn btn-outline"
              disabled={picked.size === 0}
              onClick={() => void changeArchive(pickedIds, scope.kind !== 'archived')}
            >
              <ArchiveRestore /> {scope.kind === 'archived' ? '恢复' : '归档'}
            </button>
            {/* 批量彻底删除。归档只是软删，堆着的图会一直占存储；
                这里是唯一能真正清掉的入口，所以文案要说明它与归档不同 */}
            <button
              className="btn sal-danger"
              disabled={picked.size === 0 || del.isPending}
              title="彻底删除：库行与文件都清掉，与归档不同，删了找不回来"
              onClick={() => del.mutate([...picked])}
            >
              <Trash2 /> 删除
            </button>
            <span className="sal-flex" />
            {groupsError !== null && (
              <span className="sal-fail">分组接口没通，移动分组用不了：{groupsError}</span>
            )}
            <button className="btn" onClick={toggleBatch}>
              取消
            </button>
          </div>
        )}
      </section>

      {/* 看大图：看的是**原图**，不是详情栏那张 768px 展示图。
          左右键在当前筛选结果里翻，翻的顺序与网格上看到的一致 */}
      {viewing !== null && visible[viewing] !== undefined && (
        <ImageViewer
          images={visible.map((a) => ({
            id: a.id,
            url: a.full_url,
            caption: a.display_name || a.caption || `素材 #${a.id}`,
          }))}
          index={viewing}
          onIndex={setViewing}
          onClose={() => setViewing(null)}
          actions={
            <>
              <a className="btn btn-outline btn-sm" href={visible[viewing].full_url} download>
                下载原图
              </a>
              <button
                className="btn btn-outline btn-sm"
                onClick={() => {
                  setDetailId(visible[viewing].id)
                  setViewing(null)
                }}
              >
                详情
              </button>
              <button
                className="btn btn-danger btn-sm"
                disabled={del.isPending}
                onClick={() => {
                  const id = visible[viewing].id
                  del.mutate([id], {
                    onSuccess: (r) => {
                      if (r === null) return
                      // 删完停在同一位置看下一张；删掉的是最后一张就退一格
                      setViewing((i) => (i === null ? null : Math.min(i, visible.length - 2)))
                    },
                  })
                }}
              >
                删除
              </button>
            </>
          }
        />
      )}

      {detail !== null && (
        <AssetDetailPanel
          asset={detail}
          groups={groups}
          groupsError={groupsError}
          tagging={tagBusy}
          tagFailReason={tagFailed.get(detail.id)}
          onClose={() => setDetailId(null)}
          onTag={(ids) => void runTag(ids)}
          onMove={(ids, groupId) => void moveTo(ids, groupId)}
          onPatched={patchInCache}
          onArchive={(id, archived) => void changeArchive([id], archived)}
        />
      )}

      {importOpen && (
        <AssetImportUrls
          groups={groups}
          defaultGroupId={scope.kind === 'group' ? scope.id : null}
          onClose={() => setImportOpen(false)}
          onImported={() => {
            refreshAssets()
            refreshGroups()
          }}
        />
      )}
      {settingsOpen && <AssetSettingsPanel onClose={() => setSettingsOpen(false)} />}
    </main>
  )
}

const DEFAULT_ASSET_SETTINGS: AssetTagSettings = {
  deployment_id: null,
  caption_prompt: '用一句中文说清图片画的是什么、适合用在哪，40 字以内。',
  classification_prompt: '给出 3~8 个中文标签，覆盖题材、主体、风格、色调、用途，每个 2~6 字，不带 #。',
  user_prompt: '反推这张图片的描述并完成智能分类。',
}

const DEFAULT_STORAGE_PREFIXES: Record<AssetStorageKind, string> = {
  generated: 'images/generated',
  upload: 'images/upload',
  local: 'images/local',
}

const STORAGE_KIND_LABEL: Record<AssetStorageKind, string> = {
  generated: '生成素材',
  upload: '上传素材',
  local: '本地素材',
}

function AssetSettingsPanel({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const [tab, setTab] = useState<'prefs' | 'storage'>('prefs')
  const settings = useQuery({ queryKey: ['sal-settings'], queryFn: apiStudio.assetSettings })
  const storage = useQuery({ queryKey: ['sal-storage'], queryFn: apiStudio.assetStorage })
  const deployments = useQuery({
    queryKey: ['sal-chat-deployments'],
    queryFn: () => apiConfig.modelDeployments({ media_type: 'chat', enabled: true }),
  })
  const [draft, setDraft] = useState<AssetTagSettings>(DEFAULT_ASSET_SETTINGS)
  const [saving, setSaving] = useState(false)
  const [prefixes, setPrefixes] = useState<Record<AssetStorageKind, string>>(DEFAULT_STORAGE_PREFIXES)
  const [storagePicked, setStoragePicked] = useState<Set<number>>(new Set())
  const [savingStorage, setSavingStorage] = useState(false)
  const [purging, setPurging] = useState(false)

  useEffect(() => {
    if (settings.data) setDraft(settings.data)
  }, [settings.data])

  useEffect(() => {
    if (!storage.data) return
    setPrefixes(storage.data.prefixes)
    const available = new Set(
      storage.data.archived_items.filter((item) => item.reclaimable).map((item) => item.id),
    )
    setStoragePicked((current) => new Set([...current].filter((id) => available.has(id))))
  }, [storage.data])

  const save = async () => {
    setSaving(true)
    try {
      const stored = await apiStudio.saveAssetSettings(draft)
      setDraft(stored)
      toast.success('素材反推与分类设置已保存')
      onClose()
    } catch (error) {
      toast.error(errText(error))
    } finally {
      setSaving(false)
    }
  }

  const savePrefixes = async () => {
    setSavingStorage(true)
    try {
      const stored = await apiStudio.saveAssetStoragePrefixes(prefixes)
      setPrefixes(stored.prefixes)
      await storage.refetch()
      toast.success('生成、上传与本地素材目录已保存；只影响新入库对象')
    } catch (error) {
      toast.error(errText(error))
    } finally {
      setSavingStorage(false)
    }
  }

  const purgePicked = async () => {
    const ids = [...storagePicked]
    if (ids.length === 0 || purging) return
    if (!window.confirm(
      `确认永久删除 ${ids.length} 张已归档且无引用的素材？原图、展示图和缩略图都会从存储中移除，此操作不可恢复。`,
    )) return
    setPurging(true)
    try {
      const result = await apiStudio.purgeAssetStorage(ids)
      setStoragePicked(new Set())
      await Promise.all([
        storage.refetch(),
        qc.invalidateQueries({ queryKey: ['sal-assets'] }),
      ])
      toast.success(`已物理清理 ${result.purged} 张素材，回收 ${mediaSize(result.removed_bytes)}`)
    } catch (error) {
      toast.error(errText(error))
    } finally {
      setPurging(false)
    }
  }

  const storageData: AssetStorageOverview | undefined = storage.data
  const reclaimableIds = storageData?.archived_items
    .filter((item) => item.reclaimable)
    .map((item) => item.id) ?? []
  const allReclaimablePicked = reclaimableIds.length > 0
    && reclaimableIds.every((id) => storagePicked.has(id))

  return (
    <Overlay onClose={onClose} card="sal-settings-panel" labelledBy="sal-settings-title">
        <header>
          <div>
            <h2 id="sal-settings-title">素材设置</h2>
            <p>管理默认反推规则、三类保存目录和可安全回收的归档文件。</p>
          </div>
          <button className="btn btn-ghost-sm" onClick={onClose}>关闭</button>
        </header>

        <div className="sal-settings-tabs">
          <button className={tab === 'prefs' ? 'is-active' : ''} onClick={() => setTab('prefs')}>
            <Settings2 />偏好设置
          </button>
          <button className={tab === 'storage' ? 'is-active' : ''} onClick={() => setTab('storage')}>
            <HardDrive />素材管理
          </button>
        </div>

        {tab === 'prefs' ? (
          <>
            {settings.isPending && <p className="sal-note">正在读取设置…</p>}
            {settings.isError && <p className="sal-note sal-note-err">设置读取失败：{errText(settings.error)}</p>}
            <div className="sal-settings-fields">
              <label>
                视觉模型
                <Picker
                  value={draft.deployment_id === null ? 'binding' : String(draft.deployment_id)}
                  onChange={(value) => setDraft((current) => ({
                    ...current,
                    deployment_id: value === 'binding' ? null : Number(value),
                  }))}
                  options={[
                    { value: 'binding', label: '跟随 explain-standard 能力绑定' },
                    ...(deployments.data ?? []).map((item) => ({
                      value: String(item.id),
                      label: item.display_name || item.upstream_model_id,
                      hint: item.provider_type || item.adapter_type,
                    })),
                  ]}
                />
              </label>
              <label>
                反推描述规则
                <textarea
                  rows={4}
                  maxLength={4000}
                  value={draft.caption_prompt}
                  onChange={(event) => setDraft((current) => ({ ...current, caption_prompt: event.target.value }))}
                />
              </label>
              <label>
                智能分类规则
                <textarea
                  rows={4}
                  maxLength={4000}
                  value={draft.classification_prompt}
                  onChange={(event) => setDraft((current) => ({ ...current, classification_prompt: event.target.value }))}
                />
              </label>
              <label>
                图片指令
                <textarea
                  rows={2}
                  maxLength={1000}
                  value={draft.user_prompt}
                  onChange={(event) => setDraft((current) => ({ ...current, user_prompt: event.target.value }))}
                />
              </label>
            </div>

            <aside className="sal-storage-policy">
              <strong>文件管理策略</strong>
              <p>资产先归档，仍被画布、会话、任务、工作流或历史结果引用时禁止物理删除。</p>
              <p>共享文件夹继续只读挂载，复制入库后才进入统一检索和对象存储。</p>
            </aside>

            <footer>
              <button className="btn btn-outline" onClick={() => setDraft(DEFAULT_ASSET_SETTINGS)}>
                <RotateCcw />恢复默认
              </button>
              <span className="sal-flex" />
              <button className="btn" onClick={onClose}>取消</button>
              <button
                className="btn btn-primary"
                disabled={saving || !draft.caption_prompt.trim() || !draft.classification_prompt.trim() || !draft.user_prompt.trim()}
                onClick={() => void save()}
              >
                <Save />{saving ? '保存中…' : '保存设置'}
              </button>
            </footer>
          </>
        ) : (
          <>
            {storage.isPending && <p className="sal-note">正在统计素材占用与引用…</p>}
            {storage.isError && <p className="sal-note sal-note-err">素材存储读取失败：{errText(storage.error)}</p>}
            {storageData !== undefined && (
              <div className="sal-storage-manage">
                <div className="sal-storage-summary">
                  <article><span>全部素材</span><strong>{storageData.total_assets}</strong></article>
                  <article><span>已归档</span><strong>{storageData.archived_assets}</strong></article>
                  <article><span>可回收</span><strong>{storageData.reclaimable_assets}</strong></article>
                  <article><span>可释放</span><strong>{mediaSize(storageData.reclaimable_bytes)}</strong></article>
                </div>

                <section className="sal-storage-section">
                  <header>
                    <div><FolderCog /><span>保存目录</span></div>
                    <small>{storageData.backend === 'local' ? `本机根目录：${storageData.root ?? '未知'}` : '对象存储逻辑前缀'}</small>
                  </header>
                  <div className="sal-storage-prefixes">
                    {(['generated', 'upload', 'local'] as const).map((kind) => {
                      const stats = storageData.buckets.find((item) => item.kind === kind)
                      return (
                        <label key={kind}>
                          <span>{STORAGE_KIND_LABEL[kind]}</span>
                          <input
                            value={prefixes[kind]}
                            onChange={(event) => setPrefixes((current) => ({ ...current, [kind]: event.target.value }))}
                          />
                          <small title={stats?.path}>{stats?.count ?? 0} 张 · {mediaSize(stats?.bytes ?? 0)} · {stats?.path ?? prefixes[kind]}</small>
                        </label>
                      )
                    })}
                  </div>
                  <div className="sal-storage-actions">
                    <button className="btn btn-outline" onClick={() => setPrefixes(storageData.defaults)}>
                      <RotateCcw />恢复默认目录
                    </button>
                    <button className="btn btn-primary" disabled={savingStorage} onClick={() => void savePrefixes()}>
                      <Save />{savingStorage ? '保存中…' : '保存目录'}
                    </button>
                  </div>
                  <p className="sal-note">目录是存储后端内的相对前缀，只影响之后新入库的对象；已有资产继续按数据库中的 key 读取，不会因改目录失联。</p>
                </section>

                <section className="sal-storage-section">
                  <header>
                    <div><Trash2 /><span>归档文件</span></div>
                    <div className="sal-storage-actions">
                      <button
                        className="btn btn-outline"
                        disabled={reclaimableIds.length === 0}
                        onClick={() => setStoragePicked(allReclaimablePicked ? new Set() : new Set(reclaimableIds))}
                      >
                        {allReclaimablePicked ? '取消全选' : '全选可回收'}
                      </button>
                      <button
                        className="btn btn-danger"
                        disabled={storagePicked.size === 0 || purging}
                        onClick={() => void purgePicked()}
                      >
                        <Trash2 />{purging ? '清理中…' : `永久删除 ${storagePicked.size || ''}`}
                      </button>
                    </div>
                  </header>
                  {storageData.archived_items.length === 0 ? (
                    <p className="sal-storage-empty">归档中没有素材。先在图片库归档，才会进入物理清理候选。</p>
                  ) : (
                    <div className="sal-storage-files">
                      {storageData.archived_items.map((item) => (
                        <label key={item.id} className={storagePicked.has(item.id) ? 'is-selected' : ''}>
                          <input
                            type="checkbox"
                            checked={storagePicked.has(item.id)}
                            disabled={!item.reclaimable}
                            onChange={(event) => setStoragePicked((current) => {
                              const next = new Set(current)
                              if (event.target.checked) next.add(item.id)
                              else next.delete(item.id)
                              return next
                            })}
                          />
                          <img src={item.thumb_url} alt="" />
                          <span title={item.name}>{item.name}</span>
                          <small>{mediaSize(item.bytes)} · {item.width}×{item.height}</small>
                          {!item.reclaimable && <em title={item.references.join('、')}>受保护：{item.references.join('、')}</em>}
                        </label>
                      ))}
                    </div>
                  )}
                  {storageData.archived_truncated && <p className="sal-note">归档超过 500 张，本页只显示最近 500 张；清理后刷新继续处理。</p>}
                </section>
              </div>
            )}
            <footer>
              <span className="sal-flex" />
              <button className="btn" onClick={onClose}>关闭</button>
            </footer>
          </>
        )}
    </Overlay>
  )
}

function mediaSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

type MediaLibraryKind = Exclude<LibraryKind, 'image' | 'shared' | 'canvas'>

const MEDIA_KIND_LABEL: Record<MediaLibraryKind, string> = {
  video: '视频',
  audio: '音频',
  file: '文件',
}

function MediaAssetLibrary({
  kind,
  onKind,
  managerTabs,
}: {
  kind: MediaLibraryKind
  onKind: (kind: LibraryKind) => void
  managerTabs: ReactNode
}) {
  const qc = useQueryClient()
  const [scope, setScope] = useState<Scope>({ kind: 'all' })
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  const [detailId, setDetailId] = useState<number | null>(null)
  const uploadRef = useRef<HTMLInputElement | null>(null)
  const [uploading, setUploading] = useState(false)

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(text.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [text])

  const groupsQuery = useQuery({ queryKey: ['sal-groups'], queryFn: () => apiStudio.assetGroups() })
  const groups = groupsQuery.data?.items ?? []
  const groupId = scope.kind === 'group' ? scope.id : scope.kind === 'ungrouped' ? 0 : undefined
  const status = scope.kind === 'archived' ? 'archived' : 'active'
  const assets = useQuery({
    queryKey: ['sal-media-assets', kind, groupId, query, status],
    queryFn: () => apiStudio.mediaAssets({
      kind,
      status,
      group_id: groupId,
      q: query === '' ? undefined : query,
      limit: 200,
    }),
  })
  const detail = (assets.data?.items ?? []).find((asset) => asset.id === detailId) ?? null
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['sal-media-assets'] })
    void qc.invalidateQueries({ queryKey: ['sal-groups'] })
  }
  const patch = async (
    asset: StudioMediaAsset,
    body: { favorite?: boolean; status?: 'active' | 'archived'; group_id?: number | null },
  ) => {
    try {
      await apiStudio.patchMediaAsset(asset.id, body)
      refresh()
      if (body.status === 'archived') setDetailId(null)
    } catch (error) {
      toast.error(errText(error))
    }
  }
  const label = MEDIA_KIND_LABEL[kind]
  const uploadLocal = async (files: FileList) => {
    setUploading(true)
    let saved = 0
    try {
      for (const file of Array.from(files)) {
        const row = await apiStudio.uploadMediaAsset(file)
        if (scope.kind === 'group') {
          await apiStudio.patchMediaAsset(row.id, { group_id: scope.id })
        }
        saved += 1
      }
      toast.success(`${saved} 个本地${label}文件已存入素材库`)
      refresh()
    } catch (error) {
      toast.error(`本地上传失败：${errText(error)}`)
    } finally {
      setUploading(false)
    }
  }

  return (
    <main className="page sal-page">
      <AssetGroupTree
        groups={groups}
        loading={groupsQuery.isPending}
        error={groupsQuery.isError ? errText(groupsQuery.error) : null}
        total={scope.kind === 'all' && query === '' ? assets.data?.total ?? null : null}
        scope={scope}
        onScope={(next) => {
          if (next.kind === 'untagged') {
            toast.info('AI 图片标签只用于图片；视频、音频和文件可按名称检索')
            return
          }
          setScope(next)
          setDetailId(null)
        }}
        onGroupsChanged={refresh}
        onAssetsChanged={refresh}
      />
      <section className="sal-main">
        {managerTabs}
        <header className="sal-head">
          <div>
            <h1>素材库</h1>
            <p>{label}资产 · 生成任务和工作流的产物统一入库，可直接回到画布使用</p>
          </div>
          <LibraryTabs kind={kind} onKind={onKind} />
          <span className="sal-flex" />
          <input
            ref={uploadRef}
            className="sal-hidden-file"
            type="file"
            multiple
            accept={kind === 'video' ? 'video/*' : kind === 'audio' ? 'audio/*' : undefined}
            onChange={(event) => {
              if (event.target.files && event.target.files.length > 0) void uploadLocal(event.target.files)
              event.target.value = ''
            }}
          />
          <button className="btn btn-outline" disabled={uploading} onClick={() => uploadRef.current?.click()}>
            <Upload /> {uploading ? '上传中…' : '本地上传'}
          </button>
        </header>
        <div className="sal-bar">
          <span className="sal-search">
            <IconSearch />
            <input
              value={text}
              placeholder={`搜索${label}名称或 MIME 类型…`}
              onChange={(event) => setText(event.target.value)}
            />
          </span>
        </div>
        {assets.isError && (
          <p className="sal-note sal-note-err">
            {label}素材加载失败：{errText(assets.error)}
            <button className="btn btn-ghost-sm" onClick={() => void assets.refetch()}>重试</button>
          </p>
        )}
        <div className="sal-body">
          {assets.isPending && <p className="sal-empty">载入{label}素材…</p>}
          {assets.data !== undefined && assets.data.items.length === 0 && (
            <p className="sal-empty">
              {query === ''
                ? `还没有${label}资产。视频导演或工作流产出的${label}会自动出现在这里。`
                : `没有名称匹配“${query}”的${label}资产。`}
            </p>
          )}
          {(assets.data?.items.length ?? 0) > 0 && (
            <div className="sal-grid sal-media-grid">
              {assets.data?.items.map((asset) => (
                <button
                  key={asset.id}
                  className={detailId === asset.id ? 'sal-cell sal-cell-on sal-media-cell' : 'sal-cell sal-media-cell'}
                  title={asset.name}
                  onClick={() => setDetailId(asset.id)}
                >
                  {kind === 'video' && asset.poster_url !== null ? (
                    <img src={asset.poster_url} alt="" loading="lazy" />
                  ) : (
                    <span className="sal-media-icon">
                      {kind === 'video' ? <IconVideo /> : <IconFileText />}
                    </span>
                  )}
                  <span className="sal-media-name">{asset.name}</span>
                  <span className="sal-media-meta">{mediaSize(asset.bytes)} · {asset.mime}</span>
                  {asset.favorite && <span className="sal-fav"><IconStar filled /></span>}
                </button>
              ))}
            </div>
          )}
        </div>
      </section>
      {detail !== null && (
        <aside className="sal-media-detail" aria-label={`${label}资产详情`}>
          <header>
            <strong>{detail.name}</strong>
            <button className="btn-ghost-sm" aria-label="关闭" onClick={() => setDetailId(null)}>
              <IconClose />
            </button>
          </header>
          {detail.kind === 'video' && (
            <video src={detail.url} poster={detail.poster_url ?? undefined} controls playsInline preload="metadata" />
          )}
          {detail.kind === 'audio' && <audio src={detail.url} controls preload="metadata" />}
          {detail.kind === 'file' && <div className="sal-media-file"><IconFileText /></div>}
          <dl>
            <div><dt>类型</dt><dd>{detail.mime}</dd></div>
            <div><dt>大小</dt><dd>{mediaSize(detail.bytes)}</dd></div>
            {detail.duration_ms !== null && (
              <div><dt>时长</dt><dd>{(detail.duration_ms / 1000).toFixed(1)} 秒</dd></div>
            )}
            <div><dt>资产 ID</dt><dd>#{detail.id}</dd></div>
          </dl>
          <label>
            素材分组
            <Picker
              size="sm"
              value={detail.group_id === null ? 'none' : String(detail.group_id)}
              onChange={(v) => void patch(detail, { group_id: v === 'none' ? null : Number(v) })}
              options={[
                { value: 'none', label: '未归组' },
                ...groups.map((g) => ({
                  value: String(g.id),
                  label: g.parent_id === null ? g.name : `　└ ${g.name}`,
                })),
              ]}
            />
          </label>
          <div className="sal-media-actions">
            <button className="btn btn-outline" onClick={() => void patch(detail, { favorite: !detail.favorite })}>
              <IconStar filled={detail.favorite} /> {detail.favorite ? '取消收藏' : '收藏'}
            </button>
            <a className="btn btn-soft" href={detail.url} download={detail.name}>下载</a>
            <button className="btn btn-outline" onClick={() => void patch(detail, { status: detail.status === 'archived' ? 'active' : 'archived' })}>
              <ArchiveRestore /> {detail.status === 'archived' ? '恢复' : '归档'}
            </button>
          </div>
        </aside>
      )}
    </main>
  )
}
