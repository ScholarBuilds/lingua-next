import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  Check,
  Cloud,
  Copy,
  Download,
  LoaderCircle,
  Maximize2,
  Minus,
  Monitor,
  Plus,
  Settings2,
  Trash2,
  X,
  Zap,
} from '@/components/NexusIcon'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, PointerEvent, WheelEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

import { apiConfig } from '@/lib/api-config'
import { useWorkspaceText } from '@/lib/workspaceStore'
import { apiImage } from '@/lib/api-image'
import { apiStudio } from '@/lib/api-studio'
import type { StudioTask } from '@/lib/api-studio'

import {
  normalizeZImageDimension,
  zImageHistoryItems,
  zImageTaskAssetIds,
  zImageTaskEngine,
} from './zimage-history'
import type { ZImageEngine, ZImageHistoryItem } from './zimage-history'
import './zimage.css'

const TOOL_ID = 'zimage-generator'
const PAGE_SIZE = 15
const ACTIVE = new Set(['queued', 'submitting', 'running', 'recovering'])
const ENGINE_KEY = 'zimage_engine_mode'

interface ZImageHistoryPage {
  items: ZImageHistoryItem[]
  nextOffset: number | null
}

function storedEngine(): ZImageEngine {
  try {
    return localStorage.getItem(ENGINE_KEY) === 'modelscope' ? 'modelscope' : 'local'
  } catch {
    return 'local'
  }
}

function randomSeed(): number {
  try {
    const value = new Uint32Array(1)
    crypto.getRandomValues(value)
    return Math.max(1, value[0] ?? 1)
  } catch {
    return Math.floor(Math.random() * 4_294_967_295) + 1
  }
}

async function historyPage(offset: number): Promise<ZImageHistoryPage> {
  const response = await apiStudio.tasks({
    tool_id: TOOL_ID,
    status: 'succeeded',
    limit: PAGE_SIZE,
    offset,
  })
  const ids = [...new Set(response.items.flatMap(zImageTaskAssetIds))]
  const settled = await Promise.allSettled(ids.map((id) => apiImage.asset(id)))
  const assets = settled.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  )
  return {
    items: response.items.flatMap((task) => zImageHistoryItems(task, assets)),
    nextOffset: response.items.length === PAGE_SIZE ? offset + PAGE_SIZE : null,
  }
}

function engineLabel(engine: ZImageEngine): string {
  return engine === 'local' ? 'LOCAL' : 'MODELSCOPE'
}

function ActiveCard({ task }: { task: StudioTask }): JSX.Element {
  const engine = zImageTaskEngine(task)
  return (
    <div className="zim-card zim-card-loading" role="status">
      <LoaderCircle aria-hidden />
      <strong>{engine === 'local' ? 'Local Rendering' : 'ModelScope Rendering'}</strong>
      <span>{task.stage ?? '正在排队'} · {Math.round(task.progress)}%</span>
      <i style={{ width: `${Math.max(4, Math.min(100, task.progress))}%` }} />
    </div>
  )
}

function HistoryCard({
  item,
  selecting,
  selected,
  onOpen,
  onToggle,
}: {
  item: ZImageHistoryItem
  selecting: boolean
  selected: boolean
  onOpen: () => void
  onToggle: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      className={`zim-card zim-card-image${selecting ? ' is-selecting' : ''}${selected ? ' is-selected' : ''}`}
      onClick={selecting ? onToggle : onOpen}
      aria-pressed={selecting ? selected : undefined}
      aria-label={selecting ? `${selected ? '取消选择' : '选择'}图片 ${item.asset.id}` : `预览图片 ${item.asset.id}`}
    >
      <img src={item.asset.url} alt={item.prompt || `Z-Image ${item.asset.id}`} loading="lazy" />
      <span className={`zim-engine-badge zim-engine-${item.engine}`}>
        {item.engine === 'local' ? <Monitor aria-hidden /> : <Cloud aria-hidden />}
        {engineLabel(item.engine)}
      </span>
      {selecting && (
        <span className="zim-pick" aria-hidden>{selected && <Check />}</span>
      )}
      <span className="zim-card-caption">{item.prompt || '未记录提示词'}</span>
    </button>
  )
}

function Lightbox({
  item,
  onClose,
  onReplicate,
}: {
  item: ZImageHistoryItem
  onClose: () => void
  onReplicate: () => void
}): JSX.Element {
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const drag = useRef<{ pointer: number; x: number; y: number; ox: number; oy: number } | null>(null)
  const clampScale = (value: number) => Math.max(0.5, Math.min(5, value))
  const reset = () => {
    setScale(1)
    setOffset({ x: 0, y: 0 })
  }

  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', keydown)
    return () => {
      document.body.style.overflow = previous
      window.removeEventListener('keydown', keydown)
    }
  }, [onClose])

  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = {
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      ox: offset.x,
      oy: offset.y,
    }
  }
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer !== event.pointerId) return
    setOffset({
      x: drag.current.ox + event.clientX - drag.current.x,
      y: drag.current.oy + event.clientY - drag.current.y,
    })
  }
  const pointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer === event.pointerId) drag.current = null
  }
  const wheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault()
    setScale((current) => clampScale(current * (event.deltaY > 0 ? 0.9 : 1.1)))
  }

  return (
    <div className="zim-lightbox" role="dialog" aria-modal="true" aria-label="Z-Image 图片预览" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <button className="zim-lightbox-close" onClick={onClose} aria-label="关闭预览"><X /></button>
      <div className="zim-preview-wrap">
        <div
          className="zim-preview"
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={pointerUp}
          onPointerCancel={pointerUp}
          onWheel={wheel}
          onDoubleClick={reset}
        >
          <img
            src={item.asset.full_url}
            alt={item.prompt || `Z-Image ${item.asset.id}`}
            draggable={false}
            style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
          />
          <span className="zim-resolution">{item.asset.width} × {item.asset.height}</span>
          <a className="zim-download" href={item.asset.full_url} download={`Z-Image-${item.asset.id}.png`} aria-label="下载原图">
            <Download />
          </a>
          <div className="zim-zoom" aria-label="预览缩放">
            <button onClick={() => setScale((current) => clampScale(current - 0.25))} aria-label="缩小"><Minus /></button>
            <button onClick={reset} aria-label="重置缩放"><Maximize2 /></button>
            <button onClick={() => setScale((current) => clampScale(current + 0.25))} aria-label="放大"><Plus /></button>
          </div>
        </div>
        <div className="zim-lightbox-card">
          <div>
            <span>PROMPT EXECUTION</span>
            <p>{item.prompt || '未记录提示词'}</p>
          </div>
          <button onClick={onReplicate}><Copy />复刻</button>
        </div>
      </div>
    </div>
  )
}

export default function ZImagePage(): JSX.Element {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const loadTrigger = useRef<HTMLButtonElement | null>(null)
  const [engine, setEngineState] = useState<ZImageEngine>(storedEngine)
  const [prompt, setPrompt] = useWorkspaceText('studio', 'zimage-prompt')
  const [width, setWidth] = useState(1024)
  const [height, setHeight] = useState(1024)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [preview, setPreview] = useState<ZImageHistoryItem | null>(null)

  const workflows = useQuery({
    queryKey: ['studio-workflows', 'zimage'],
    queryFn: () => apiStudio.workflows('?provider=comfyui&enabled=true'),
  })
  const workflowCredentials = useQuery({
    queryKey: ['cfg-creds', 'workflow'],
    queryFn: () => apiConfig.credentials('workflow'),
  })
  const deployments = useQuery({
    queryKey: ['cfg-model-deployments', 'zimage'],
    queryFn: () => apiConfig.modelDeployments({ media_type: 'image', enabled: true }),
  })
  const tasks = useQuery({
    queryKey: ['zimage-tasks'],
    queryFn: () => apiStudio.tasks({ tool_id: TOOL_ID, limit: 50 }),
    refetchInterval: (query) =>
      (query.state.data?.items ?? []).some((task) => ACTIVE.has(task.status)) ? 1500 : false,
  })
  const history = useInfiniteQuery({
    queryKey: ['zimage-history'],
    queryFn: ({ pageParam }) => historyPage(pageParam),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset ?? undefined,
  })

  const localWorkflow = (workflows.data?.items ?? []).find(
    (item) => item.key === 'comfyui:Z-Image',
  )
  const localCredential = (workflowCredentials.data ?? []).find(
    (item) => item.enabled && item.provider_type === 'comfyui',
  )
  const modelscopeDeployments = useMemo(
    () => (deployments.data ?? [])
      .filter((item) => item.adapter_type === 'modelscope')
      .sort((left, right) => {
        const rank = (value: string) => /z[-_ ]?image/i.test(value) ? 0 : 1
        return rank(left.upstream_model_id) - rank(right.upstream_model_id) || left.sort - right.sort
      }),
    [deployments.data],
  )
  const cloudDeployment = modelscopeDeployments[0]
  const taskItems = tasks.data?.items ?? []
  const activeTasks = taskItems.filter((task) => ACTIVE.has(task.status))
  const latestFailure = taskItems.find((task) => task.status === 'failed')
  const terminalSignature = taskItems
    .filter((task) => task.status === 'succeeded')
    .map((task) => `${task.id}:${task.updated_at ?? ''}`)
    .join('|')
  const loadedItems = useMemo(() => {
    const unique = new Map<number, ZImageHistoryItem>()
    for (const item of history.data?.pages.flatMap((page) => page.items) ?? []) {
      if (!unique.has(item.asset.id)) unique.set(item.asset.id, item)
    }
    return [...unique.values()]
  }, [history.data])
  const canRun = engine === 'local'
    ? localWorkflow !== undefined && localCredential !== undefined
    : cloudDeployment !== undefined
  const configMessage = engine === 'local'
    ? localWorkflow === undefined
      ? '内置 Z-Image 工作流尚未载入'
      : localCredential === undefined
        ? '还没有启用的 ComfyUI 执行器凭据'
        : `本机 · ${localCredential.name}`
    : cloudDeployment === undefined
      ? '还没有启用的 ModelScope 图片部署'
      : `云端 · ${cloudDeployment.display_name || cloudDeployment.upstream_model_id}`

  useEffect(() => {
    if (terminalSignature !== '') {
      void queryClient.invalidateQueries({ queryKey: ['zimage-history'] })
    }
  }, [queryClient, terminalSignature])

  useEffect(() => {
    const node = loadTrigger.current
    if (node === null || !history.hasNextPage) return
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !history.isFetchingNextPage) {
        void history.fetchNextPage()
      }
    }, { rootMargin: '180px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [history.fetchNextPage, history.hasNextPage, history.isFetchingNextPage])

  const setEngine = (value: ZImageEngine) => {
    setEngineState(value)
    try { localStorage.setItem(ENGINE_KEY, value) } catch { /* 私密模式下仍可本次使用 */ }
  }

  const run = useMutation({
    mutationFn: async () => {
      const text = prompt.trim()
      if (text === '') throw new Error('请先填写提示词')
      const safeWidth = normalizeZImageDimension(width)
      const safeHeight = normalizeZImageDimension(height)
      if (safeWidth === null || safeHeight === null) {
        throw new Error('宽高须为 256–4096 之间且可被 64 整除的整数')
      }
      const ratio = safeWidth / safeHeight
      if (ratio < 1 / 3 || ratio > 3) throw new Error('宽高比须在 1:3 与 3:1 之间')
      if (engine === 'local') {
        if (localWorkflow === undefined || localCredential === undefined) {
          throw new Error(configMessage)
        }
        return apiStudio.runTool(TOOL_ID, {
          operation: 'workflow.run',
          input: {
            workflow_id: localWorkflow.id,
            credential_id: localCredential.id,
            fields: {
              f_prompt: text,
              f_width: safeWidth,
              f_height: safeHeight,
              f_seed: randomSeed(),
            },
          },
          source_route: '/studio/zimage',
          source_context: { zimage_engine: 'local', prompt: text },
        })
      }
      if (cloudDeployment === undefined) throw new Error(configMessage)
      return apiStudio.runTool(TOOL_ID, {
        operation: 'image.generate',
        input: {
          prompt: text,
          deployment_id: cloudDeployment.id,
          alias: 'image-free',
          target_key: 'free',
          size: `${safeWidth}x${safeHeight}`,
          n: 1,
          options: {},
        },
        source_route: '/studio/zimage',
        source_context: { zimage_engine: 'modelscope', prompt: text },
      })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['zimage-tasks'] })
      void queryClient.invalidateQueries({ queryKey: ['studio-tasks'] })
      toast.success('Z-Image 任务已进入后台队列')
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const archive = useMutation({
    mutationFn: async (ids: number[]) => {
      const results = await Promise.allSettled(
        ids.map((id) => apiImage.patchAsset(id, { status: 'archived' })),
      )
      const failed = results.filter((item) => item.status === 'rejected')
      if (failed.length > 0) throw new Error(`已归档 ${ids.length - failed.length} 张，${failed.length} 张失败`)
      return ids.length
    },
    onSuccess: (count) => {
      setSelected(new Set())
      setSelecting(false)
      void queryClient.invalidateQueries({ queryKey: ['zimage-history'] })
      void queryClient.invalidateQueries({ queryKey: ['img-assets'] })
      toast.success(`已移入归档 ${count} 张`)
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!canRun) return
    run.mutate()
  }
  const toggle = (id: number) => setSelected((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const cancelSelection = () => {
    setSelecting(false)
    setSelected(new Set())
  }
  const archiveSelected = () => {
    if (selected.size === 0) return
    if (!window.confirm(`把选中的 ${selected.size} 张图片移入归档？之后可在素材库恢复。`)) return
    archive.mutate([...selected])
  }
  const replicate = (item: ZImageHistoryItem) => {
    setPrompt(item.prompt)
    setPreview(null)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  const busy = run.isPending || activeTasks.length > 0

  return (
    <main className="zim-page">
      <header className="zim-hero">
        <form className="zim-console" onSubmit={submit}>
          <div className="zim-console-main">
            <div className="zim-console-status">
              <span>UNIFIED ART CONSOLE</span>
              <b className={activeTasks.length > 0 ? 'is-busy' : ''}>
                {activeTasks.length > 0 ? `队列处理中 · ${activeTasks.length}` : '系统就绪'}
                <i />
              </b>
            </div>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={2}
              maxLength={2000}
              placeholder="描述你想看见的画面…"
              aria-label="Z-Image 提示词"
            />
          </div>
          <div className="zim-controls">
            <div className="zim-control-block">
              <span>ENGINE SOURCE</span>
              <div className={`zim-switch zim-switch-${engine}`}>
                <i />
                <button type="button" className={engine === 'local' ? 'active' : ''} onClick={() => setEngine('local')}>
                  <Monitor />本机
                </button>
                <button type="button" className={engine === 'modelscope' ? 'active' : ''} onClick={() => setEngine('modelscope')}>
                  <Cloud />ModelScope
                </button>
              </div>
            </div>
            <div className="zim-divider" />
            <label className="zim-dimensions">
              <span>DIMENSIONS</span>
              <div>
                <input type="number" min={256} max={4096} step={64} value={width} onChange={(event) => setWidth(Number(event.target.value))} aria-label="图片宽度" />
                <b>×</b>
                <input type="number" min={256} max={4096} step={64} value={height} onChange={(event) => setHeight(Number(event.target.value))} aria-label="图片高度" />
              </div>
            </label>
            <div className="zim-route-note" title={configMessage}>
              <span>{engine === 'local' ? 'COMFYUI WORKFLOW' : 'MODEL DEPLOYMENT'}</span>
              <b>{configMessage}</b>
            </div>
            <span className="zim-grow" />
            {!canRun && (
              <button type="button" className="zim-config" onClick={() => navigate(engine === 'local' ? '/studio/workflows' : '/studio/models')}>
                <Settings2 />去配置
              </button>
            )}
            <button className="zim-render" disabled={!canRun || busy || prompt.trim() === ''}>
              {busy ? <LoaderCircle className="zim-spin" /> : <Zap />}
              {busy ? '处理中' : engine === 'local' ? '本机渲染' : '云端渲染'}
            </button>
          </div>
          {latestFailure !== undefined && activeTasks.length === 0 && (
            <div className="zim-last-error">最近任务失败：{latestFailure.error ?? latestFailure.stage ?? '未知错误'}</div>
          )}
        </form>
      </header>

      <section className="zim-gallery">
        <div className="zim-gallery-head">
          <div><span>RENDER ARCHIVE</span><h1>Z-Image 历史</h1></div>
          <div className="zim-gallery-actions">
            {selecting ? (
              <>
                <span>已选 {selected.size} 张</span>
                <button onClick={() => setSelected(new Set(loadedItems.map((item) => item.asset.id)))}>全选已加载</button>
                <button className="zim-danger" disabled={selected.size === 0 || archive.isPending} onClick={archiveSelected}><Trash2 />移入归档</button>
                <button onClick={cancelSelection}>取消</button>
              </>
            ) : (
              <button disabled={loadedItems.length === 0} onClick={() => setSelecting(true)}>批量选择</button>
            )}
          </div>
        </div>

        {history.isPending && activeTasks.length === 0 && (
          <div className="zim-empty"><LoaderCircle className="zim-spin" /><strong>正在读取历史画廊</strong></div>
        )}
        {history.isError && (
          <div className="zim-empty zim-empty-error"><strong>历史加载失败</strong><p>{history.error.message}</p><button onClick={() => void history.refetch()}>重试</button></div>
        )}
        <div className="zim-grid">
          {activeTasks.map((task) => <ActiveCard task={task} key={task.id} />)}
          {loadedItems.map((item) => (
            <HistoryCard
              key={item.asset.id}
              item={item}
              selecting={selecting}
              selected={selected.has(item.asset.id)}
              onOpen={() => setPreview(item)}
              onToggle={() => toggle(item.asset.id)}
            />
          ))}
        </div>
        {!history.isPending && !history.isError && activeTasks.length === 0 && loadedItems.length === 0 && (
          <div className="zim-empty"><Zap /><strong>还没有 Z-Image 作品</strong><p>填写提示词并选择本机或 ModelScope，完成后会自动出现在这里。</p></div>
        )}
        {history.hasNextPage && (
          <button ref={loadTrigger} className="zim-load" onClick={() => void history.fetchNextPage()} disabled={history.isFetchingNextPage}>
            {history.isFetchingNextPage ? '读取中…' : '加载更多历史'}
          </button>
        )}
      </section>

      {preview !== null && (
        <Lightbox item={preview} onClose={() => setPreview(null)} onReplicate={() => replicate(preview)} />
      )}
    </main>
  )
}
