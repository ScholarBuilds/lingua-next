import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  Cloud,
  Copy,
  Download,
  ImagePlus,
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent, PointerEvent, WheelEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

import { apiConfig } from '@/lib/api-config'
import { useWorkspaceText } from '@/lib/workspaceStore'
import { apiImage } from '@/lib/api-image'
import type { ImageAsset } from '@/lib/api-image'
import { apiStudio } from '@/lib/api-studio'
import type { StudioTask } from '@/lib/api-studio'

import { AssetPicker } from './AssetPicker'
import {
  kleinCloudSize,
  kleinHistoryItems,
  kleinReferenceAssetIds,
  kleinResultAssetIds,
} from './klein-history'
import type { KleinEngine, KleinHistoryItem } from './klein-history'
import './canvas.css'
import './klein.css'

const TOOL_ID = 'klein-editor'
const PAGE_SIZE = 24
const ACTIVE = new Set(['queued', 'submitting', 'running', 'recovering'])

interface KleinPageData {
  items: KleinHistoryItem[]
  nextOffset: number | null
}

function randomKleinSeed(): number {
  try {
    const value = new Uint32Array(1)
    crypto.getRandomValues(value)
    return (value[0] ?? 0) % 1_000_000
  } catch {
    return Math.floor(Math.random() * 1_000_000)
  }
}

async function historyPage(offset: number): Promise<KleinPageData> {
  const response = await apiStudio.tasks({
    tool_id: TOOL_ID,
    status: 'succeeded',
    limit: PAGE_SIZE,
    offset,
  })
  const ids = [...new Set(response.items.flatMap((task) => [
    ...kleinResultAssetIds(task),
    ...kleinReferenceAssetIds(task),
  ]))]
  const settled = await Promise.allSettled(ids.map((id) => apiImage.asset(id)))
  const assets = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
  return {
    items: response.items.flatMap((task) => kleinHistoryItems(task, assets)),
    nextOffset: response.items.length === PAGE_SIZE ? offset + PAGE_SIZE : null,
  }
}

function ReferenceSlot({
  label,
  asset,
  onPick,
  onClear,
  onFile,
  onHover,
}: {
  label: string
  asset: ImageAsset | null
  onPick: () => void
  onClear: () => void
  onFile: (file: File) => void
  onHover: (hovered: boolean) => void
}): JSX.Element {
  const drop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault()
    const file = event.dataTransfer.files[0]
    if (file !== undefined) onFile(file)
  }
  return (
    <button
      type="button"
      className={`kln-slot${asset === null ? '' : ' has-image'}`}
      onClick={onPick}
      onDragOver={(event) => event.preventDefault()}
      onDrop={drop}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
    >
      {asset === null ? <ImagePlus aria-hidden /> : <img src={asset.thumb_url} alt={label} />}
      <span>{label}</span>
      {asset !== null && (
        <i
          role="button"
          tabIndex={0}
          aria-label={`清除${label}`}
          onClick={(event) => { event.stopPropagation(); onClear() }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              event.stopPropagation()
              onClear()
            }
          }}
        ><X /></i>
      )}
    </button>
  )
}

function TaskPlaceholder({ task }: { task: StudioTask }): JSX.Element {
  const cloud = task.source_context?.klein_engine === 'modelscope'
  return (
    <div className="kln-card kln-card-loading" role="status">
      <LoaderCircle aria-hidden />
      <strong>{cloud ? 'ModelScope Synthesizing' : 'Local Synthesizing'}</strong>
      <span>{task.stage ?? '正在排队'} · {Math.round(task.progress)}%</span>
      <i style={{ width: `${Math.max(4, Math.min(100, task.progress))}%` }} />
    </div>
  )
}

function ComparePreview({ before, after }: { before: ImageAsset; after: ImageAsset }): JSX.Element {
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
      className="kln-compare"
      onPointerDown={(event) => {
        drag.current = event.pointerId
        event.currentTarget.setPointerCapture(event.pointerId)
        move(event.clientX)
      }}
      onPointerMove={(event) => { if (drag.current === event.pointerId) move(event.clientX) }}
      onPointerUp={() => { drag.current = null }}
      onPointerCancel={() => { drag.current = null }}
    >
      <img src={after.full_url} alt="生成结果" draggable={false} />
      <div style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}>
        <img src={before.full_url} alt="主参考图" draggable={false} />
      </div>
      <i style={{ left: `${position}%` }}><span>↔</span></i>
      <b>MAIN</b><b>RESULT</b>
    </div>
  )
}

function Lightbox({
  item,
  onClose,
  onReplicate,
}: {
  item: KleinHistoryItem
  onClose: () => void
  onReplicate: () => void
}): JSX.Element {
  const [compare, setCompare] = useState(item.references.length > 0)
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const drag = useRef<{ id: number; x: number; y: number; ox: number; oy: number } | null>(null)
  const reset = () => { setScale(1); setOffset({ x: 0, y: 0 }) }
  const clamp = (value: number) => Math.max(0.5, Math.min(5, value))

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

  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y }
  }
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== event.pointerId) return
    setOffset({
      x: drag.current.ox + event.clientX - drag.current.x,
      y: drag.current.oy + event.clientY - drag.current.y,
    })
  }
  const pointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === event.pointerId) drag.current = null
  }
  const wheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault()
    setScale((current) => clamp(current * (event.deltaY > 0 ? 0.9 : 1.1)))
  }

  return (
    <div className="kln-lightbox" role="dialog" aria-modal="true" aria-label="Flux Klein 图片预览" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <button className="kln-lightbox-close" onClick={onClose} aria-label="关闭预览"><X /></button>
      <div className="kln-lightbox-body">
        {compare && item.references[0] !== undefined ? (
          <ComparePreview before={item.references[0]} after={item.asset} />
        ) : (
          <div
            className="kln-preview"
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onPointerUp={pointerUp}
            onPointerCancel={pointerUp}
            onWheel={wheel}
            onDoubleClick={reset}
          >
            <img src={item.asset.full_url} alt={item.prompt || 'Flux Klein'} draggable={false} style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }} />
            <div className="kln-zoom">
              <button onClick={() => setScale((value) => clamp(value - 0.25))} aria-label="缩小"><Minus /></button>
              <button onClick={reset} aria-label="重置"><Maximize2 /></button>
              <button onClick={() => setScale((value) => clamp(value + 0.25))} aria-label="放大"><Plus /></button>
            </div>
          </div>
        )}
        <span className="kln-resolution">{item.asset.width} × {item.asset.height}</span>
        <a className="kln-lightbox-download" href={item.asset.full_url} download={`Klein-${item.asset.id}.png`}><Download />下载</a>
        <div className="kln-lightbox-meta">
          <div><span>PROMPT EXECUTION</span><p>{item.prompt || '未记录提示词'}</p></div>
          <div className="kln-lightbox-actions">
            {item.references.length > 0 && <button onClick={() => setCompare((value) => !value)}><Check />{compare ? '查看结果' : '前后对比'}</button>}
            <button onClick={onReplicate}><Copy />复刻</button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function KleinPage(): JSX.Element {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const trigger = useRef<HTMLButtonElement | null>(null)
  const hoveredSlot = useRef<number | null>(null)
  const [prompt, setPrompt] = useWorkspaceText('studio', 'klein-prompt')
  const [references, setReferences] = useState<Array<ImageAsset | null>>([null, null, null])
  const [pickerSlot, setPickerSlot] = useState<number | null>(null)
  const [engine, setEngine] = useState<KleinEngine>('local')
  const [loraEnabled, setLoraEnabled] = useState(false)
  const [loraStrength, setLoraStrength] = useState(0.8)
  const [preview, setPreview] = useState<KleinHistoryItem | null>(null)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [uploadingSlot, setUploadingSlot] = useState<number | null>(null)

  const workflows = useQuery({
    queryKey: ['studio-workflows', 'klein'],
    queryFn: () => apiStudio.workflows('?provider=comfyui&enabled=true'),
  })
  const credentials = useQuery({
    queryKey: ['cfg-creds', 'workflow'],
    queryFn: () => apiConfig.credentials('workflow'),
  })
  const deployments = useQuery({
    queryKey: ['cfg-model-deployments', 'klein'],
    queryFn: () => apiConfig.modelDeployments({ media_type: 'image', enabled: true }),
  })
  const tasks = useQuery({
    queryKey: ['klein-tasks'],
    queryFn: () => apiStudio.tasks({ tool_id: TOOL_ID, limit: 50 }),
    refetchInterval: (query) => (query.state.data?.items ?? []).some((task) => ACTIVE.has(task.status)) ? 1500 : false,
  })
  const history = useInfiniteQuery({
    queryKey: ['klein-history'],
    queryFn: ({ pageParam }) => historyPage(pageParam),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset ?? undefined,
  })

  const workflow = (workflows.data?.items ?? []).find((item) => item.key === 'comfyui:Flux2-Klein')
  const credential = (credentials.data ?? []).find((item) => item.enabled && item.provider_type === 'comfyui')
  const cloudDeployment = useMemo(() => (deployments.data ?? [])
    .filter((item) => item.adapter_type === 'modelscope')
    .sort((left, right) => {
      const rank = (value: string) => /klein/i.test(value) ? 0 : 1
      return rank(left.upstream_model_id) - rank(right.upstream_model_id) || left.sort - right.sort
    })[0], [deployments.data])
  const activeTasks = (tasks.data?.items ?? []).filter((task) => ACTIVE.has(task.status))
  const latestFailure = (tasks.data?.items ?? []).find((task) => task.status === 'failed')
  const terminalSignature = (tasks.data?.items ?? [])
    .filter((task) => task.status === 'succeeded')
    .map((task) => `${task.id}:${task.updated_at ?? ''}`)
    .join('|')
  const loadedItems = useMemo(() => {
    const unique = new Map<number, KleinHistoryItem>()
    for (const item of history.data?.pages.flatMap((page) => page.items) ?? []) {
      if (!unique.has(item.asset.id)) unique.set(item.asset.id, item)
    }
    return [...unique.values()]
  }, [history.data])
  const main = references[0]
  const canRun = engine === 'local'
    ? main !== null && workflow !== undefined && credential !== undefined
    : main !== null && prompt.trim() !== '' && cloudDeployment !== undefined
  const configMessage = engine === 'local'
    ? workflow === undefined
      ? '内置 Flux2-Klein 工作流尚未载入'
      : credential === undefined
        ? '还没有启用的 ComfyUI 执行器凭据'
        : `本机 · ${credential.name}`
    : cloudDeployment === undefined
      ? '还没有启用的 ModelScope 图片部署'
      : `云端 · ${cloudDeployment.display_name || cloudDeployment.upstream_model_id}`

  useEffect(() => {
    if (terminalSignature !== '') void queryClient.invalidateQueries({ queryKey: ['klein-history'] })
  }, [queryClient, terminalSignature])

  useEffect(() => {
    const node = trigger.current
    if (node === null || !history.hasNextPage) return
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !history.isFetchingNextPage) void history.fetchNextPage()
    }, { rootMargin: '180px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [history.fetchNextPage, history.hasNextPage, history.isFetchingNextPage])

  const setSlot = useCallback((index: number, asset: ImageAsset | null) => {
    setReferences((current) => current.map((item, itemIndex) => itemIndex === index ? asset : item))
  }, [])

  const upload = useCallback(async (index: number, file: File) => {
    if (!file.type.startsWith('image/')) {
      toast.error('只能上传图片文件')
      return
    }
    setUploadingSlot(index)
    try {
      const form = new FormData()
      form.set('image', file)
      form.set('op', 'upload')
      setSlot(index, await apiImage.saveLocal(form))
      void queryClient.invalidateQueries({ queryKey: ['studio-picker-assets'] })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '上传失败')
    } finally {
      setUploadingSlot(null)
    }
  }, [queryClient, setSlot])

  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      const index = hoveredSlot.current
      if (index === null) return
      const file = [...(event.clipboardData?.files ?? [])].find((item) => item.type.startsWith('image/'))
      if (file !== undefined) {
        event.preventDefault()
        void upload(index, file)
      }
    }
    window.addEventListener('paste', paste)
    return () => window.removeEventListener('paste', paste)
  }, [upload])

  const run = useMutation({
    mutationFn: async () => {
      if (main === null) throw new Error('请先选择主图')
      const text = prompt.trim()
      const refs = references.flatMap((item) => item === null ? [] : [item.id])
      if (engine === 'local') {
        if (workflow === undefined || credential === undefined) throw new Error(configMessage)
        return apiStudio.runTool(TOOL_ID, {
          operation: 'workflow.run',
          input: {
            workflow_id: workflow.id,
            credential_id: credential.id,
            fields: {
              f_prompt: text,
              f_seed: randomKleinSeed(),
              f_main: `asset:${main.id}`,
              f_aux_a: references[1] === null ? '' : `asset:${references[1].id}`,
              f_aux_b: references[2] === null ? '' : `asset:${references[2].id}`,
              f_has_aux_a: references[1] !== null,
              f_has_aux_b: references[2] !== null,
            },
          },
          source_route: '/studio/klein',
          source_context: { klein_engine: 'local', prompt: text, reference_asset_ids: refs },
        })
      }
      if (text === '') throw new Error('ModelScope 模式需要提示词')
      if (cloudDeployment === undefined) throw new Error(configMessage)
      const size = kleinCloudSize(main.width, main.height)
      return apiStudio.runTool(TOOL_ID, {
        operation: 'image.generate',
        input: {
          prompt: text,
          deployment_id: cloudDeployment.id,
          alias: 'image-free',
          target_key: 'free',
          size: `${size.width}x${size.height}`,
          n: 1,
          options: {
            ref_asset_ids: refs,
            ...(loraEnabled ? { loras: { 'Daniel8152/Klein-enhance': loraStrength } } : {}),
          },
        },
        source_route: '/studio/klein',
        source_context: {
          klein_engine: 'modelscope', prompt: text, reference_asset_ids: refs,
          lora_strength: loraEnabled ? loraStrength : null,
        },
      })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['klein-tasks'] })
      void queryClient.invalidateQueries({ queryKey: ['studio-tasks'] })
      toast.success('Flux Klein 任务已进入后台队列')
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const archive = useMutation({
    mutationFn: async (ids: number[]) => {
      const results = await Promise.allSettled(ids.map((id) => apiImage.patchAsset(id, { status: 'archived' })))
      const failed = results.filter((item) => item.status === 'rejected').length
      if (failed > 0) throw new Error(`已归档 ${ids.length - failed} 张，${failed} 张失败`)
      return ids.length
    },
    onSuccess: (count) => {
      setSelected(new Set())
      setSelecting(false)
      void queryClient.invalidateQueries({ queryKey: ['klein-history'] })
      void queryClient.invalidateQueries({ queryKey: ['img-assets'] })
      toast.success(`已移入归档 ${count} 张`)
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const replicate = (item: KleinHistoryItem) => {
    setPrompt(item.prompt)
    setEngine(item.engine)
    setReferences([item.references[0] ?? null, item.references[1] ?? null, item.references[2] ?? null])
    setLoraEnabled(item.loraStrength !== null)
    if (item.loraStrength !== null) setLoraStrength(item.loraStrength)
    setPreview(null)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  const toggle = (id: number) => setSelected((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const archiveSelected = () => {
    if (selected.size === 0) return
    if (window.confirm(`把选中的 ${selected.size} 张图片移入归档？之后可在素材库恢复。`)) {
      archive.mutate([...selected])
    }
  }
  const busy = run.isPending || activeTasks.length > 0

  return (
    <main className="kln-page">
      <header className="kln-title"><div><span>FLUX KLEIN</span><h1>多参考生成</h1></div><p>三张参考分层合成，本机与 ModelScope 共用一份持久历史。</p></header>
      <section className="kln-workbench">
        <form className="kln-panel" onSubmit={(event) => { event.preventDefault(); if (canRun) run.mutate() }}>
          <label className="kln-field"><span>01 · INPUT PROMPT</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={5} maxLength={8000} placeholder="描述要如何组合或改造这些参考图…" /></label>
          <div className="kln-field"><span>02 · REFERENCE LAYERS</span><div className="kln-slots">
            {['MAIN', 'AUX A', 'AUX B'].map((label, index) => (
              <ReferenceSlot
                key={label}
                label={uploadingSlot === index ? 'UPLOADING' : label}
                asset={references[index] ?? null}
                onPick={() => setPickerSlot(index)}
                onClear={() => setSlot(index, null)}
                onFile={(file) => void upload(index, file)}
                onHover={(hovered) => { hoveredSlot.current = hovered ? index : null }}
              />
            ))}
          </div><small>点击从资产库选择；也可把本地图片拖进槽位，或悬停后粘贴。</small></div>
          <div className="kln-engine">
            <span>ENGINE</span>
            <div><button type="button" className={engine === 'local' ? 'active' : ''} onClick={() => setEngine('local')}><Monitor />本机</button><button type="button" className={engine === 'modelscope' ? 'active' : ''} onClick={() => setEngine('modelscope')}><Cloud />ModelScope</button></div>
            <p>{configMessage}</p>
            {engine === 'modelscope' && (
              <div className="kln-lora"><label><input type="checkbox" checked={loraEnabled} onChange={(event) => setLoraEnabled(event.target.checked)} />细节增强 LoRA</label>{loraEnabled && <label><span>强度 {loraStrength.toFixed(2)}</span><input type="range" min="0.1" max="1" step="0.05" value={loraStrength} onChange={(event) => setLoraStrength(Number(event.target.value))} /></label>}</div>
            )}
          </div>
          {(engine === 'local' ? credential === undefined || workflow === undefined : cloudDeployment === undefined) && <button type="button" className="kln-config" onClick={() => navigate(engine === 'local' ? '/studio/workflows' : '/studio/models')}><Settings2 />去配置</button>}
          <button className="kln-run" disabled={!canRun || busy}>{busy ? <LoaderCircle className="kln-spin" /> : <Zap />}{busy ? '合成中' : '执行合成'}</button>
          {latestFailure !== undefined && activeTasks.length === 0 && <p className="kln-error">最近任务失败：{latestFailure.error ?? latestFailure.stage ?? '未知错误'}</p>}
        </form>
        <div className="kln-output">
          {activeTasks[0] !== undefined ? <TaskPlaceholder task={activeTasks[0]} /> : loadedItems[0] !== undefined ? <button type="button" onClick={() => setPreview(loadedItems[0])}><img src={loadedItems[0].asset.url} alt={loadedItems[0].prompt || '最近结果'} /><span>查看最近结果</span></button> : <div><Zap /><strong>CANVAS READY</strong><span>完成的结果会在这里和下方历史同步出现</span></div>}
        </div>
      </section>

      <section className="kln-gallery">
        <div className="kln-gallery-head"><div><span>ARCHIVES</span><h2>Flux Klein 历史</h2></div><div>
          {selecting ? <><span>已选 {selected.size} 张</span><button onClick={() => setSelected(new Set(loadedItems.map((item) => item.asset.id)))}>全选已加载</button><button className="danger" disabled={selected.size === 0 || archive.isPending} onClick={archiveSelected}><Trash2 />移入归档</button><button onClick={() => { setSelecting(false); setSelected(new Set()) }}>取消</button></> : <button disabled={loadedItems.length === 0} onClick={() => setSelecting(true)}>批量选择</button>}
        </div></div>
        {history.isError && <div className="kln-empty"><strong>历史加载失败</strong><p>{history.error.message}</p><button onClick={() => void history.refetch()}>重试</button></div>}
        <div className="kln-grid">
          {activeTasks.map((task) => <TaskPlaceholder key={task.id} task={task} />)}
          {loadedItems.map((item) => <button type="button" key={item.asset.id} className={`kln-card${selecting ? ' selecting' : ''}${selected.has(item.asset.id) ? ' selected' : ''}`} onClick={() => selecting ? toggle(item.asset.id) : setPreview(item)} aria-pressed={selecting ? selected.has(item.asset.id) : undefined}><img src={item.asset.url} alt={item.prompt || `Flux Klein ${item.asset.id}`} loading="lazy" /><span className={`kln-badge ${item.engine}`}>{item.engine === 'local' ? <Monitor /> : <Cloud />}{item.engine === 'local' ? 'LOCAL' : 'MODELSCOPE'}</span>{selecting && <i className="kln-check">{selected.has(item.asset.id) && <Check />}</i>}<b>{item.prompt || 'Klein Archive'}</b></button>)}
        </div>
        {!history.isPending && !history.isError && activeTasks.length === 0 && loadedItems.length === 0 && <div className="kln-empty"><ImagePlus /><strong>还没有 Flux Klein 作品</strong><p>至少选择主图；ModelScope 模式还需要提示词。</p></div>}
        {history.hasNextPage && <button ref={trigger} className="kln-load" onClick={() => void history.fetchNextPage()} disabled={history.isFetchingNextPage}>{history.isFetchingNextPage ? '读取中…' : '加载更多历史'}</button>}
      </section>

      {pickerSlot !== null && <AssetPicker onClose={() => setPickerSlot(null)} onPick={(asset) => { setSlot(pickerSlot, asset); setPickerSlot(null) }} />}
      {preview !== null && <Lightbox item={preview} onClose={() => setPreview(null)} onReplicate={() => replicate(preview)} />}
    </main>
  )
}
