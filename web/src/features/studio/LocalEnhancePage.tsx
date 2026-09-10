import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeftRight,
  Check,
  Download,
  ImagePlus,
  LoaderCircle,
  Settings2,
  Sparkles,
  Trash2,
  X,
  Zap,
} from '@/components/NexusIcon'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

import { apiConfig } from '@/lib/api-config'
import { apiImage } from '@/lib/api-image'
import type { ImageAsset } from '@/lib/api-image'
import { apiStudio } from '@/lib/api-studio'
import type { StudioTask } from '@/lib/api-studio'

import { AssetPicker } from './AssetPicker'
import {
  enhanceHistoryItems,
  enhanceSourceAssetId,
  enhanceTaskAssetIds,
} from './enhance-history'
import type { EnhanceHistoryItem } from './enhance-history'
import { useInitialImageAsset } from './useInitialImageAsset'
import './canvas.css'
import './local-enhance.css'

const TOOL_ID = 'enhance'
const PAGE_SIZE = 24
const ACTIVE = new Set(['queued', 'submitting', 'running', 'recovering'])

interface HistoryPage {
  items: EnhanceHistoryItem[]
  nextOffset: number | null
}

function randomSeed(): number {
  try {
    const value = new Uint32Array(1)
    crypto.getRandomValues(value)
    return value[0] ?? 0
  } catch {
    return Math.floor(Math.random() * 4_294_967_296)
  }
}

async function waitForTask(taskId: string): Promise<StudioTask> {
  const deadline = Date.now() + 30 * 60 * 1000
  while (Date.now() < deadline) {
    const task = await apiStudio.task(taskId)
    if (task.status === 'succeeded') return task
    if (task.status === 'failed' || task.status === 'cancelled') {
      throw new Error(task.error ?? `工作流${task.status === 'failed' ? '失败' : '已取消'}`)
    }
    await new Promise((resolve) => window.setTimeout(resolve, 1000))
  }
  throw new Error('等待工作流完成超时；任务仍保留在任务中心，可稍后查看或重试')
}

async function loadHistoryPage(offset: number): Promise<HistoryPage> {
  const response = await apiStudio.tasks({
    tool_id: TOOL_ID,
    status: 'succeeded',
    limit: PAGE_SIZE,
    offset,
  })
  const ids = [...new Set(response.items.flatMap((task) => [
    ...enhanceTaskAssetIds(task),
    ...(enhanceSourceAssetId(task) === null ? [] : [enhanceSourceAssetId(task)!]),
  ]))]
  const settled = await Promise.allSettled(ids.map((id) => apiImage.asset(id)))
  const assets = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
  return {
    items: response.items.flatMap((task) => enhanceHistoryItems(task, assets)),
    nextOffset: response.items.length === PAGE_SIZE ? offset + PAGE_SIZE : null,
  }
}

function Comparison({
  before,
  after,
  tall = false,
}: {
  before: ImageAsset
  after: ImageAsset
  tall?: boolean
}): JSX.Element {
  const [position, setPosition] = useState(50)
  const stage = useRef<HTMLDivElement | null>(null)
  const drag = useRef<number | null>(null)
  const move = (clientX: number) => {
    const rect = stage.current?.getBoundingClientRect()
    if (rect === undefined || rect.width === 0) return
    setPosition(Math.max(0, Math.min(100, (clientX - rect.left) / rect.width * 100)))
  }
  return (
    <div
      ref={stage}
      className={`enh-compare${tall ? ' is-tall' : ''}`}
      onPointerDown={(event) => {
        drag.current = event.pointerId
        event.currentTarget.setPointerCapture(event.pointerId)
        move(event.clientX)
      }}
      onPointerMove={(event) => { if (drag.current === event.pointerId) move(event.clientX) }}
      onPointerUp={() => { drag.current = null }}
      onPointerCancel={() => { drag.current = null }}
    >
      <img src={after.full_url} alt="增强结果" draggable={false} />
      <div style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}><img src={before.full_url} alt="原图" draggable={false} /></div>
      <i style={{ left: `${position}%` }}><ArrowLeftRight /></i>
      <b>ORIGINAL</b><b>REMASTERED</b>
    </div>
  )
}

function Lightbox({ item, onClose }: { item: EnhanceHistoryItem; onClose: () => void }): JSX.Element {
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', keydown)
    return () => {
      document.body.style.overflow = previous
      window.removeEventListener('keydown', keydown)
    }
  }, [onClose])
  return (
    <div className="enh-lightbox" role="dialog" aria-modal="true" aria-label="增强结果对比" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <button className="enh-close" onClick={onClose} aria-label="关闭"><X /></button>
      <div className="enh-lightbox-body">
        {item.source === null ? <img className="enh-single" src={item.asset.full_url} alt="增强结果" /> : <Comparison before={item.source} after={item.asset} tall />}
        <span className="enh-resolution">{item.asset.width} × {item.asset.height}</span>
        <a href={item.asset.full_url} download={`Remaster-${item.asset.id}.png`}><Download />保存成品</a>
      </div>
    </div>
  )
}

export default function LocalEnhancePage(): JSX.Element {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const loadTrigger = useRef<HTMLButtonElement | null>(null)
  const hovering = useRef(false)
  const [source, setSource] = useState<ImageAsset | null>(null)
  const [result, setResult] = useState<EnhanceHistoryItem | null>(null)
  const [strength, setStrength] = useState(0.5)
  const [upscale, setUpscale] = useState(false)
  const [resolution, setResolution] = useState<2048 | 4096>(2048)
  const [picking, setPicking] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [runStage, setRunStage] = useState('')
  const [preview, setPreview] = useState<EnhanceHistoryItem | null>(null)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())

  useInitialImageAsset((asset) => { setSource(asset); setResult(null) })

  const workflows = useQuery({
    queryKey: ['studio-workflows', 'enhance-local'],
    queryFn: () => apiStudio.workflows('?provider=comfyui&enabled=true'),
  })
  const credentials = useQuery({
    queryKey: ['cfg-creds', 'workflow'],
    queryFn: () => apiConfig.credentials('workflow'),
  })
  const tasks = useQuery({
    queryKey: ['enhance-local-tasks'],
    queryFn: () => apiStudio.tasks({ tool_id: TOOL_ID, limit: 50 }),
    refetchInterval: (query) => (query.state.data?.items ?? []).some((task) => ACTIVE.has(task.status)) ? 1500 : false,
  })
  const history = useInfiniteQuery({
    queryKey: ['enhance-local-history'],
    queryFn: ({ pageParam }) => loadHistoryPage(pageParam),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset ?? undefined,
  })

  const enhanceWorkflow = (workflows.data?.items ?? []).find((item) => item.key === 'comfyui:Z-Image-Enhance')
  const upscaleWorkflow = (workflows.data?.items ?? []).find((item) => item.key === 'comfyui:upscale')
  const credential = (credentials.data ?? []).find((item) => item.enabled && item.provider_type === 'comfyui')
  const activeTasks = (tasks.data?.items ?? []).filter((task) =>
    ACTIVE.has(task.status) && task.source_context?.enhance_engine === 'local',
  )
  const latestFailure = (tasks.data?.items ?? []).find((task) =>
    task.status === 'failed' && task.source_context?.enhance_engine === 'local',
  )
  const terminalSignature = (tasks.data?.items ?? [])
    .filter((task) => task.status === 'succeeded' && task.source_context?.enhance_engine === 'local')
    .map((task) => `${task.id}:${task.updated_at ?? ''}`)
    .join('|')
  const items = useMemo(() => {
    const unique = new Map<number, EnhanceHistoryItem>()
    for (const item of history.data?.pages.flatMap((page) => page.items) ?? []) {
      if (!unique.has(item.asset.id)) unique.set(item.asset.id, item)
    }
    return [...unique.values()]
  }, [history.data])
  const configured = credential !== undefined && enhanceWorkflow !== undefined && (!upscale || upscaleWorkflow !== undefined)
  const configMessage = credential === undefined
    ? '还没有启用的 ComfyUI 执行器凭据'
    : enhanceWorkflow === undefined
      ? '内置 Z-Image-Enhance 工作流尚未载入'
      : upscale && upscaleWorkflow === undefined
        ? '内置 SeedVR2 upscale 工作流尚未载入'
        : `本机 · ${credential.name}`

  useEffect(() => {
    if (terminalSignature !== '') void queryClient.invalidateQueries({ queryKey: ['enhance-local-history'] })
  }, [queryClient, terminalSignature])

  useEffect(() => {
    const node = loadTrigger.current
    if (node === null || !history.hasNextPage) return
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !history.isFetchingNextPage) void history.fetchNextPage()
    }, { rootMargin: '180px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [history.fetchNextPage, history.hasNextPage, history.isFetchingNextPage])

  const pick = useCallback((asset: ImageAsset) => { setSource(asset); setResult(null) }, [])
  const uploadFile = useCallback(async (file: File) => {
    if (!file.type.startsWith('image/')) { toast.error('只能上传图片文件'); return }
    setUploading(true)
    try {
      const form = new FormData()
      form.set('image', file)
      form.set('op', 'upload')
      pick(await apiImage.saveLocal(form))
      void queryClient.invalidateQueries({ queryKey: ['studio-picker-assets'] })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '上传失败')
    } finally {
      setUploading(false)
    }
  }, [pick, queryClient])

  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      if (!hovering.current) return
      const file = [...(event.clipboardData?.files ?? [])].find((item) => item.type.startsWith('image/'))
      if (file !== undefined) { event.preventDefault(); void uploadFile(file) }
    }
    window.addEventListener('paste', paste)
    return () => window.removeEventListener('paste', paste)
  }, [uploadFile])

  const run = useMutation({
    mutationFn: async () => {
      if (source === null) throw new Error('请先选择输入图片')
      if (credential === undefined || enhanceWorkflow === undefined) throw new Error(configMessage)
      setRunStage(upscale ? 'PHASE 1/2 · ENHANCING' : 'ENHANCING')
      const phaseOne = await apiStudio.runTool(TOOL_ID, {
        operation: 'workflow.run',
        input: {
          workflow_id: enhanceWorkflow.id,
          credential_id: credential.id,
          fields: { f_image: `asset:${source.id}`, f_strength: strength },
        },
        source_route: '/studio/enhance',
        source_context: {
          enhance_engine: 'local', enhance_stage: 'detail', source_asset_id: source.id,
          strength, history_visible: !upscale,
        },
      })
      void queryClient.invalidateQueries({ queryKey: ['enhance-local-tasks'] })
      const enhancedTask = await waitForTask(phaseOne.id)
      const enhancedId = enhanceTaskAssetIds(enhancedTask)[0]
      if (enhancedId === undefined) throw new Error('细节增强完成，但任务没有返回图片资产')
      if (!upscale) {
        const asset = await apiImage.asset(enhancedId)
        return { taskId: enhancedTask.id, asset, source, strength, resolution: null, createdAt: enhancedTask.created_at } satisfies EnhanceHistoryItem
      }
      if (upscaleWorkflow === undefined) throw new Error('内置 SeedVR2 upscale 工作流尚未载入')
      setRunStage('PHASE 2/2 · UPSCALING')
      const phaseTwo = await apiStudio.runTool(TOOL_ID, {
        operation: 'workflow.run',
        input: {
          workflow_id: upscaleWorkflow.id,
          credential_id: credential.id,
          fields: { f_image: `asset:${enhancedId}`, f_seed: randomSeed(), f_resolution: resolution },
        },
        source_route: '/studio/enhance',
        source_context: {
          enhance_engine: 'local', enhance_stage: 'upscale', source_asset_id: source.id,
          intermediate_asset_id: enhancedId, strength, upscale_resolution: resolution,
          history_visible: true,
        },
      })
      void queryClient.invalidateQueries({ queryKey: ['enhance-local-tasks'] })
      const finalTask = await waitForTask(phaseTwo.id)
      const finalId = enhanceTaskAssetIds(finalTask)[0]
      if (finalId === undefined) throw new Error('超分完成，但任务没有返回图片资产')
      return {
        taskId: finalTask.id,
        asset: await apiImage.asset(finalId),
        source,
        strength,
        resolution,
        createdAt: finalTask.created_at,
      } satisfies EnhanceHistoryItem
    },
    onSuccess: (item) => {
      setResult(item)
      setRunStage('')
      void queryClient.invalidateQueries({ queryKey: ['enhance-local-history'] })
      void queryClient.invalidateQueries({ queryKey: ['studio-tasks'] })
      toast.success(upscale ? `细节增强与 ${resolution === 2048 ? '2K' : '4K'} 超分已完成` : '细节增强已完成')
    },
    onError: (error: Error) => { setRunStage(''); toast.error(error.message) },
  })

  const archive = useMutation({
    mutationFn: async (ids: number[]) => {
      const settled = await Promise.allSettled(ids.map((id) => apiImage.patchAsset(id, { status: 'archived' })))
      const failed = settled.filter((item) => item.status === 'rejected').length
      if (failed > 0) throw new Error(`已归档 ${ids.length - failed} 张，${failed} 张失败`)
      return ids.length
    },
    onSuccess: (count) => {
      setSelecting(false)
      setSelected(new Set())
      void queryClient.invalidateQueries({ queryKey: ['enhance-local-history'] })
      void queryClient.invalidateQueries({ queryKey: ['img-assets'] })
      toast.success(`已移入归档 ${count} 张`)
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const toggle = (id: number) => setSelected((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const drop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault()
    const file = event.dataTransfer.files[0]
    if (file !== undefined) void uploadFile(file)
  }
  const busy = run.isPending || activeTasks.length > 0

  return (
    <main className="enh-page">
      <header className="enh-title"><div><span>Z IMAGE®</span><h1>细节增强与超分</h1></div><p>先用 Z-Image 修复细节；需要时把阶段一的真实结果继续交给 SeedVR2 放大。</p></header>
      <section className="enh-workbench">
        <form className="enh-controls" onSubmit={(event) => { event.preventDefault(); if (configured && source !== null) run.mutate() }}>
          <div className="enh-field"><span>01 · INPUT SOURCE</span><button type="button" className={`enh-drop${source === null ? '' : ' has-image'}`} onClick={() => setPicking(true)} onDragOver={(event) => event.preventDefault()} onDrop={drop} onMouseEnter={() => { hovering.current = true }} onMouseLeave={() => { hovering.current = false }}>{source === null ? <><ImagePlus /><strong>{uploading ? '上传中…' : '选择、拖入或粘贴图片'}</strong></> : <><img src={source.url} alt="输入图片" /><i>更换图片</i></>}</button></div>
          <label className="enh-field"><span>02 · REFINEMENT STRENGTH <b>{strength.toFixed(2)}</b></span><input type="range" min="0.1" max="1" step="0.01" value={strength} onChange={(event) => setStrength(Number(event.target.value))} /></label>
          <div className="enh-upscale"><label><span><Sparkles />SUPER RESOLUTION<small>阶段二：SeedVR2 高清放大</small></span><input type="checkbox" checked={upscale} onChange={(event) => setUpscale(event.target.checked)} /></label>{upscale && <div><button type="button" className={resolution === 2048 ? 'active' : ''} onClick={() => setResolution(2048)}>2× · 2K</button><button type="button" className={resolution === 4096 ? 'active' : ''} onClick={() => setResolution(4096)}>4× · 4K</button></div>}</div>
          <p className="enh-route">{configMessage}</p>
          {!configured && <button type="button" className="enh-config" onClick={() => navigate('/studio/workflows')}><Settings2 />去配置 ComfyUI</button>}
          <button className="enh-run" disabled={!configured || source === null || busy}>{busy ? <LoaderCircle className="enh-spin" /> : <Zap />}{busy ? runStage || 'PROCESSING' : 'BEGIN REMASTERING'}</button>
          {latestFailure !== undefined && activeTasks.length === 0 && <p className="enh-error">最近任务失败：{latestFailure.error ?? latestFailure.stage ?? '未知错误'}</p>}
        </form>
        <div className="enh-output">
          {result !== null && result.source !== null ? <><Comparison before={result.source} after={result.asset} /><button onClick={() => setPreview(result)}>全屏对比</button><a href={result.asset.full_url} download={`Remaster-${result.asset.id}.png`}><Download /></a></> : busy ? <div className="enh-processing"><LoaderCircle /><strong>{runStage || activeTasks[0]?.stage || 'COMPUTING PIXELS'}</strong><span>{activeTasks[0] === undefined ? '任务已提交' : `${Math.round(activeTasks[0].progress)}%`}</span></div> : <div className="enh-ready"><Sparkles /><strong>CANVAS READY</strong><span>增强结果会在这里进行前后对比</span></div>}
        </div>
      </section>

      <section className="enh-gallery">
        <div className="enh-gallery-head"><div><span>REMASTER ARCHIVE</span><h2>增强历史</h2></div><div>{selecting ? <><span>已选 {selected.size} 张</span><button onClick={() => setSelected(new Set(items.map((item) => item.asset.id)))}>全选已加载</button><button className="danger" disabled={selected.size === 0 || archive.isPending} onClick={() => { if (window.confirm(`把选中的 ${selected.size} 张图片移入归档？`)) archive.mutate([...selected]) }}><Trash2 />移入归档</button><button onClick={() => { setSelecting(false); setSelected(new Set()) }}>取消</button></> : <button disabled={items.length === 0} onClick={() => setSelecting(true)}>批量选择</button>}</div></div>
        {history.isError && <div className="enh-empty"><strong>历史加载失败</strong><button onClick={() => void history.refetch()}>重试</button></div>}
        <div className="enh-grid">{activeTasks.map((task) => <div className="enh-card enh-card-loading" key={task.id}><LoaderCircle /><strong>{task.source_context?.enhance_stage === 'upscale' ? 'UPSCALING' : 'ENHANCING'}</strong><span>{task.stage ?? '正在排队'} · {Math.round(task.progress)}%</span></div>)}{items.map((item) => <button type="button" className={`enh-card${selecting ? ' selecting' : ''}${selected.has(item.asset.id) ? ' selected' : ''}`} key={item.asset.id} onClick={() => selecting ? toggle(item.asset.id) : setPreview(item)} aria-pressed={selecting ? selected.has(item.asset.id) : undefined}><img src={item.asset.url} alt={`增强结果 ${item.asset.id}`} loading="lazy" />{item.resolution !== null && <span>{item.resolution === 2048 ? '2K' : '4K'}</span>}{selecting && <i>{selected.has(item.asset.id) && <Check />}</i>}<b>强度 {item.strength.toFixed(2)}</b></button>)}</div>
        {!history.isPending && !history.isError && activeTasks.length === 0 && items.length === 0 && <div className="enh-empty"><Sparkles /><strong>还没有本机增强作品</strong><p>选择图片和增强强度，完成后会出现在这里。</p></div>}
        {history.hasNextPage && <button ref={loadTrigger} className="enh-load" onClick={() => void history.fetchNextPage()} disabled={history.isFetchingNextPage}>{history.isFetchingNextPage ? '读取中…' : '加载更多历史'}</button>}
      </section>

      {picking && <AssetPicker onClose={() => setPicking(false)} onPick={pick} />}
      {preview !== null && <Lightbox item={preview} onClose={() => setPreview(null)} />}
    </main>
  )
}
