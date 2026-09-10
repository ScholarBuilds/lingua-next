import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  CloudCog,
  Copy,
  Download,
  ImagePlus,
  LoaderCircle,
  Maximize2,
  Minus,
  Plus,
  Search,
  Settings2,
  SlidersHorizontal,
  Trash2,
  Upload,
  X,
  Zap,
} from '@/components/NexusIcon'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent, PointerEvent, WheelEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

import { Picker } from '@/components/ui/picker'
import type { ModelDeployment, ModelPlugin } from '@/lib/api-config'
import { apiConfig } from '@/lib/api-config'
import { useWorkspaceText } from '@/lib/workspaceStore'
import type { ImageAsset } from '@/lib/api-image'
import { apiImage } from '@/lib/api-image'
import type { StudioTask } from '@/lib/api-studio'
import { apiStudio } from '@/lib/api-studio'

import { AssetPicker } from './AssetPicker'
import {
  deploymentPage,
  onlineAspectFromSize,
  onlineHistoryItems,
  onlineImageSize,
  onlineReferenceAssetIds,
  onlineResolutionFromSize,
  onlineResultAssetIds,
  onlineWorkflowFields,
  preferredOnlineWorkflowValue,
  randomOnlineWorkflowValue,
} from './online-image-history'
import type {
  OnlineImageHistoryItem,
  OnlineRatio,
  OnlineResolution,
} from './online-image-history'
import './canvas.css'
import './online-image.css'

const TOOL_ID = 'online-image'
const PAGE_SIZE = 24
const ACTIVE = new Set(['queued', 'submitting', 'running', 'recovering'])
const QUALITY_ADAPTERS = new Set(['openai', 'apimart', 'tudou'])
type OnlineEngine = 'deployment' | 'runninghub'

interface HistoryPage {
  items: OnlineImageHistoryItem[]
  nextOffset: number | null
}

function supports(plugins: ModelPlugin[], deployment: ModelDeployment, operation: string): boolean {
  return plugins.find((plugin) => plugin.id === deployment.adapter_type)
    ?.ready_operations.includes(operation) === true
}

function deploymentName(deployment: ModelDeployment): string {
  return deployment.display_name?.trim() || deployment.upstream_model_id
}

function providerName(deployment: ModelDeployment): string {
  return deployment.credential_name?.trim()
    || deployment.provider_type?.trim()
    || deployment.adapter_type
}

async function historyPage(offset: number): Promise<HistoryPage> {
  const response = await apiStudio.tasks({ tool_id: TOOL_ID, status: 'succeeded', limit: PAGE_SIZE, offset })
  const ids = [...new Set(response.items.flatMap((task) => [
    ...onlineResultAssetIds(task),
    ...onlineReferenceAssetIds(task),
  ]))]
  const settled = await Promise.allSettled(ids.map((id) => apiImage.asset(id)))
  const assets = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
  return {
    items: response.items.flatMap((task) => onlineHistoryItems(task, assets)),
    nextOffset: response.items.length === PAGE_SIZE ? offset + PAGE_SIZE : null,
  }
}

function ReferenceSlot({
  index,
  asset,
  uploading,
  onPick,
  onClear,
  onFile,
  onHover,
}: {
  index: number
  asset: ImageAsset | null
  uploading: boolean
  onPick: () => void
  onClear: () => void
  onFile: (file: File) => void
  onHover: (active: boolean) => void
}): JSX.Element {
  const input = useRef<HTMLInputElement | null>(null)
  const label = ['MAIN', 'AUX A', 'AUX B'][index] ?? `REF ${index + 1}`
  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    const file = [...event.dataTransfer.files].find((item) => item.type.startsWith('image/'))
    if (file !== undefined) onFile(file)
  }
  return (
    <div
      className={`oni-ref${asset === null ? '' : ' has-image'}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={drop}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
    >
      {asset === null ? (
        <>
          <ImagePlus aria-hidden />
          <strong>{label}</strong>
          <span>{uploading ? '上传中…' : '点击、拖放或悬停粘贴'}</span>
          <button type="button" onClick={onPick} disabled={uploading} aria-label={`从资产库选择 ${label}`} />
        </>
      ) : (
        <>
          <img src={asset.url} alt={`${label} 参考图`} />
          <span className="oni-ref-label">{label}</span>
          <button type="button" className="oni-ref-replace" onClick={onPick}>替换</button>
          <button type="button" className="oni-ref-clear" onClick={onClear} aria-label={`清除 ${label}`}><X /></button>
        </>
      )}
      <button type="button" className="oni-ref-upload" onClick={() => input.current?.click()} title="本地上传"><Upload /></button>
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file !== undefined) onFile(file)
          event.target.value = ''
        }}
      />
    </div>
  )
}

function ActiveCard({ task }: { task: StudioTask }): JSX.Element {
  return (
    <div className="oni-card oni-card-loading" role="status">
      <LoaderCircle />
      <strong>{task.source_context?.provider_name?.toString() || '在线模型'}生成中</strong>
      <span>{task.stage ?? '排队中'} · {Math.round(task.progress)}%</span>
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
  item: OnlineImageHistoryItem
  selecting: boolean
  selected: boolean
  onOpen: () => void
  onToggle: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      className={`oni-card oni-card-image${selecting ? ' is-selecting' : ''}${selected ? ' is-selected' : ''}`}
      onClick={selecting ? onToggle : onOpen}
      aria-pressed={selecting ? selected : undefined}
    >
      <img src={item.asset.url} alt={item.prompt || `在线生图 ${item.asset.id}`} loading="lazy" />
      <span className="oni-provider-badge"><CloudCog />{item.provider}</span>
      {selecting && <span className="oni-pick">{selected && <Check />}</span>}
      <span className="oni-card-caption"><strong>{item.model || item.adapter}</strong>{item.prompt || '未记录提示词'}</span>
    </button>
  )
}

function Lightbox({
  item,
  onClose,
  onReplicate,
}: {
  item: OnlineImageHistoryItem
  onClose: () => void
  onReplicate: () => void
}): JSX.Element {
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const drag = useRef<{ id: number; x: number; y: number; ox: number; oy: number } | null>(null)
  const clamp = (value: number) => Math.max(0.5, Math.min(5, value))
  const reset = () => { setScale(1); setOffset({ x: 0, y: 0 }) }

  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', key)
    return () => { document.body.style.overflow = previous; window.removeEventListener('keydown', key) }
  }, [onClose])

  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y }
  }
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== event.pointerId) return
    setOffset({ x: drag.current.ox + event.clientX - drag.current.x, y: drag.current.oy + event.clientY - drag.current.y })
  }
  const up = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === event.pointerId) drag.current = null
  }
  const wheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault()
    setScale((value) => clamp(value + (event.deltaY < 0 ? 0.2 : -0.2)))
  }

  return (
    <div className="oni-lightbox" role="dialog" aria-modal="true" aria-label="在线生图预览" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <button className="oni-lightbox-close" onClick={onClose} aria-label="关闭"><X /></button>
      <div className="oni-lightbox-card">
        <div
          className="oni-lightbox-stage"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onWheel={wheel}
          onDoubleClick={reset}
        >
          <img src={item.asset.full_url} alt={item.prompt || '在线生图'} draggable={false} style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }} />
          <div className="oni-zoom">
            <button onClick={() => setScale((value) => clamp(value - 0.25))} aria-label="缩小"><Minus /></button>
            <button onClick={reset} aria-label="重置"><Maximize2 /></button>
            <button onClick={() => setScale((value) => clamp(value + 0.25))} aria-label="放大"><Plus /></button>
          </div>
        </div>
        <span className="oni-lightbox-resolution">{item.asset.width} × {item.asset.height}</span>
        <a className="oni-lightbox-download" href={item.asset.full_url} download={`online-${item.asset.id}.png`}><Download />下载</a>
        <div className="oni-lightbox-meta">
          <div><span>{item.provider} · {item.model || item.adapter}</span><p>{item.prompt || '未记录提示词'}</p><small>{item.size} · {item.quality} · {item.references.length} 张参考</small></div>
          <button onClick={onReplicate}><Copy />复刻</button>
        </div>
      </div>
    </div>
  )
}

export default function OnlineImagePage(): JSX.Element {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const moreTrigger = useRef<HTMLButtonElement | null>(null)
  const hoveredSlot = useRef<number | null>(null)
  const [prompt, setPrompt] = useWorkspaceText('studio', 'online-image-prompt')
  const [references, setReferences] = useState<Array<ImageAsset | null>>([null, null, null])
  const [pickerSlot, setPickerSlot] = useState<number | null>(null)
  const [uploadingSlot, setUploadingSlot] = useState<number | null>(null)
  const [engine, setEngine] = useState<OnlineEngine>('deployment')
  const [providerKey, setProviderKey] = useState('')
  const [deploymentId, setDeploymentId] = useState<number | null>(null)
  const [runningHubWorkflowId, setRunningHubWorkflowId] = useState<number | null>(null)
  const [modelSearch, setModelSearch] = useState('')
  const [modelPage, setModelPage] = useState(0)
  const [quality, setQuality] = useState('auto')
  const [count, setCount] = useState(1)
  const [ratio, setRatio] = useState<OnlineRatio>('square')
  const [resolution, setResolution] = useState<OnlineResolution>('1k')
  const [customWidth, setCustomWidth] = useState('')
  const [customHeight, setCustomHeight] = useState('')
  const [ratioWidth, setRatioWidth] = useState('')
  const [ratioHeight, setRatioHeight] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [negativePrompt, setNegativePrompt] = useState('')
  const [seed, setSeed] = useState('')
  const [steps, setSteps] = useState(28)
  const [guidance, setGuidance] = useState(3.5)
  const [loraId, setLoraId] = useState('')
  const [loraStrength, setLoraStrength] = useState(0.8)
  const [preview, setPreview] = useState<OnlineImageHistoryItem | null>(null)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())

  const deployments = useQuery({
    queryKey: ['cfg-model-deployments', 'online-image'],
    queryFn: () => apiConfig.modelDeployments({ media_type: 'image', enabled: true }),
  })
  const plugins = useQuery({ queryKey: ['cfg-model-plugins'], queryFn: apiConfig.modelPlugins })
  const modelScopeLoras = useQuery({
    queryKey: ['cfg-modelscope-loras', 'online-image'],
    queryFn: () => apiConfig.modelscopeLoras({ enabled: true }),
  })
  const runningHubWorkflows = useQuery({
    queryKey: ['studio-workflows', 'online-runninghub'],
    queryFn: () => apiStudio.workflows('?provider=runninghub&enabled=true'),
  })
  const workflowCredentials = useQuery({
    queryKey: ['cfg-creds', 'workflow'],
    queryFn: () => apiConfig.credentials('workflow'),
  })
  const runningHubEntries = useMemo(() => (runningHubWorkflows.data?.items ?? [])
    .filter((item) => !/video|视频|minimax/i.test(`${item.title} ${item.key}`)), [runningHubWorkflows.data])
  const runningHubWorkflow = runningHubEntries.find((item) => item.id === runningHubWorkflowId)
  const runningHubDetail = useQuery({
    queryKey: ['studio-workflow', 'online-runninghub', runningHubWorkflowId],
    queryFn: () => apiStudio.workflow(runningHubWorkflowId as number),
    enabled: runningHubWorkflowId !== null,
  })
  const tasks = useQuery({
    queryKey: ['online-image-tasks'],
    queryFn: () => apiStudio.tasks({ tool_id: TOOL_ID, limit: 80 }),
    refetchInterval: (query) => (query.state.data?.items ?? []).some((task) => ACTIVE.has(task.status)) ? 1500 : false,
  })
  const history = useInfiniteQuery({
    queryKey: ['online-image-history'],
    queryFn: ({ pageParam }) => historyPage(pageParam),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset ?? undefined,
  })

  const executable = useMemo(() => (deployments.data ?? [])
    .filter((deployment) => supports(plugins.data ?? [], deployment, 'image.generate'))
    .sort((left, right) => left.sort - right.sort || left.id - right.id), [deployments.data, plugins.data])
  const providers = useMemo(() => {
    const unique = new Map<string, string>()
    for (const deployment of executable) unique.set(String(deployment.credential_id), providerName(deployment))
    return [...unique].map(([value, label]) => ({ value, label }))
  }, [executable])
  const providerDeployments = useMemo(() => executable.filter((deployment) => String(deployment.credential_id) === providerKey), [executable, providerKey])
  const searchedDeployments = useMemo(() => {
    const term = modelSearch.trim().toLowerCase()
    return term === '' ? providerDeployments : providerDeployments.filter((deployment) => `${deploymentName(deployment)} ${deployment.upstream_model_id}`.toLowerCase().includes(term))
  }, [modelSearch, providerDeployments])
  const paged = deploymentPage(searchedDeployments, modelPage)
  const deployment = executable.find((item) => item.id === deploymentId)
  const compatibleLoras = (modelScopeLoras.data ?? []).filter((item) =>
    item.credential_id === deployment?.credential_id
    && item.target_model === deployment.upstream_model_id)
  const catalogLora = compatibleLoras.find((item) => item.lora_id === loraId)
  const loraPickerValue = catalogLora?.lora_id ?? 'none'
  const runningHubCredential = (workflowCredentials.data ?? []).find((item) => item.enabled && item.provider_type === 'runninghub')
  const runningHubSchemaFields = onlineWorkflowFields(runningHubDetail.data?.ui_schema)
  const runningHubPromptField = runningHubSchemaFields.find((field) => field.bindPrompt || /prompt|提示|描述/i.test(`${field.id} ${field.name}`))
  const runningHubRequiredImages = runningHubSchemaFields.filter((field) => field.type === 'image' && field.required).length
  const isModelScope = deployment?.adapter_type === 'modelscope'
  const hasReferences = references.some((item) => item !== null)
  const canEdit = deployment === undefined || isModelScope || supports(plugins.data ?? [], deployment, 'image.edit')
  const size = onlineImageSize(ratio, resolution, {
    width: Number(customWidth), height: Number(customHeight),
    ratioWidth: Number(ratioWidth), ratioHeight: Number(ratioHeight),
  })
  const deploymentMessage = deployments.isPending || plugins.isPending
    ? '正在读取图片部署…'
    : executable.length === 0
      ? '设置中还没有可执行的图片部署'
      : deployment === undefined
        ? '请选择一个模型'
        : hasReferences && !canEdit
          ? '当前部署未声明 image.edit，不能接参考图'
          : `${providerName(deployment)} · ${deployment.adapter_type}`
  const runningHubMessage = runningHubWorkflows.isPending || workflowCredentials.isPending
    ? '正在读取 RunningHub 目录…'
    : runningHubWorkflows.isError || workflowCredentials.isError
      ? 'RunningHub 目录或凭据读取失败'
    : runningHubWorkflow === undefined
      ? '还没有可执行的 RunningHub 图片工作流'
      : runningHubCredential === undefined
        ? '还没有启用的 RunningHub 执行凭据'
        : runningHubDetail.isPending
          ? '正在读取工作流字段…'
          : runningHubPromptField === undefined
            ? '当前工作流没有可绑定的提示词字段'
        : runningHubRequiredImages > references.filter((item) => item !== null).length
          ? `当前工作流至少需要 ${runningHubRequiredImages} 张参考图`
          : `RunningHub · ${runningHubWorkflow.title}`
  const configMessage = engine === 'runninghub' ? runningHubMessage : deploymentMessage
  const canRun = prompt.trim() !== '' && size !== null && (engine === 'runninghub'
    ? runningHubWorkflow !== undefined
      && runningHubCredential !== undefined
      && runningHubPromptField !== undefined
      && runningHubRequiredImages <= references.filter((item) => item !== null).length
    : deployment !== undefined && canEdit)
  const activeTasks = (tasks.data?.items ?? []).filter((task) => ACTIVE.has(task.status))
  const latestFailure = (tasks.data?.items ?? []).find((task) => task.status === 'failed')
  const terminalSignature = (tasks.data?.items ?? [])
    .filter((task) => task.status === 'succeeded')
    .map((task) => `${task.id}:${task.updated_at ?? ''}`)
    .join('|')
  const historyItems = useMemo(() => {
    const unique = new Map<number, OnlineImageHistoryItem>()
    for (const item of history.data?.pages.flatMap((page) => page.items) ?? []) {
      if (!unique.has(item.asset.id)) unique.set(item.asset.id, item)
    }
    return [...unique.values()]
  }, [history.data])
  const shown = preview ?? historyItems[0] ?? null

  useEffect(() => {
    if (providers.length === 0) { setProviderKey(''); setDeploymentId(null); return }
    if (!providers.some((provider) => provider.value === providerKey)) setProviderKey(providers[0]?.value ?? '')
  }, [providerKey, providers])

  useEffect(() => {
    const items = runningHubEntries
    if (items.length === 0) { setRunningHubWorkflowId(null); return }
    if (!items.some((item) => item.id === runningHubWorkflowId)) setRunningHubWorkflowId(items[0]?.id ?? null)
  }, [runningHubEntries, runningHubWorkflowId])

  useEffect(() => {
    setModelPage(0)
    setModelSearch('')
  }, [providerKey])

  useEffect(() => {
    if (providerDeployments.length === 0) { setDeploymentId(null); return }
    if (!providerDeployments.some((item) => item.id === deploymentId)) setDeploymentId(providerDeployments[0]?.id ?? null)
  }, [deploymentId, providerDeployments])

  useEffect(() => {
    setLoraId('')
    setLoraStrength(0.8)
  }, [deploymentId])

  useEffect(() => {
    if (modelPage !== paged.page) setModelPage(paged.page)
  }, [modelPage, paged.page])

  useEffect(() => {
    if (terminalSignature !== '') void queryClient.invalidateQueries({ queryKey: ['online-image-history'] })
  }, [queryClient, terminalSignature])

  useEffect(() => {
    const node = moreTrigger.current
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
    if (!file.type.startsWith('image/')) { toast.error('只能上传图片文件'); return }
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
      if (file !== undefined) { event.preventDefault(); void upload(index, file) }
    }
    window.addEventListener('paste', paste)
    return () => window.removeEventListener('paste', paste)
  }, [upload])

  const run = useMutation({
    mutationFn: async () => {
      const text = prompt.trim()
      if (text === '') throw new Error('请先输入提示词')
      if (size === null) throw new Error('尺寸无效：宽高需为 16 的倍数、单边 64～3840、比例 1:3～3:1')
      const referenceIds = references.flatMap((item) => item === null ? [] : [item.id])
      if (engine === 'runninghub') {
        if (runningHubWorkflow === undefined || runningHubCredential === undefined || runningHubPromptField === undefined) throw new Error(configMessage)
        const fields: Record<string, unknown> = { [runningHubPromptField.id]: text }
        let imageIndex = 0
        for (const field of runningHubSchemaFields) {
          if (field.type === 'image') {
            const assetId = referenceIds[imageIndex]
            if (assetId !== undefined) fields[field.id] = `asset:${assetId}`
            imageIndex += 1
            continue
          }
          if (field.id === runningHubPromptField.id) continue
          const key = `${field.id} ${field.name}`.toLowerCase()
          if (/aspectratio|aspect_ratio|\bratio\b/.test(key)) fields[field.id] = preferredOnlineWorkflowValue(field, onlineAspectFromSize(size))
          else if (/resolution/.test(key)) fields[field.id] = preferredOnlineWorkflowValue(field, onlineResolutionFromSize(size))
          else if (/\bwidth\b/.test(key)) fields[field.id] = Number(size.split('x')[0])
          else if (/\bheight\b/.test(key)) fields[field.id] = Number(size.split('x')[1])
          else if (field.randomEnabled) fields[field.id] = randomOnlineWorkflowValue(field)
        }
        return apiStudio.runTool(TOOL_ID, {
          operation: 'workflow.run',
          input: {
            workflow_id: runningHubWorkflow.id,
            credential_id: runningHubCredential.id,
            fields,
          },
          source_route: '/studio/online',
          source_context: {
            provider_name: 'RunningHub',
            adapter_type: 'runninghub',
            model: runningHubWorkflow.title,
            prompt: text,
            size,
            quality: 'workflow',
            count: 1,
            reference_asset_ids: referenceIds,
          },
        })
      }
      if (deployment === undefined || !canEdit) throw new Error(configMessage)
      const context = {
        provider_name: providerName(deployment),
        adapter_type: deployment.adapter_type,
        model: deployment.upstream_model_id,
        prompt: text,
        size,
        quality,
        count,
        reference_asset_ids: referenceIds,
      }
      if (referenceIds.length > 0 && deployment.adapter_type !== 'modelscope') {
        return apiStudio.runTool(TOOL_ID, {
          operation: 'image.edit',
          input: {
            prompt: text,
            ref_asset_ids: referenceIds,
            deployment_id: deployment.id,
            alias: 'image-free',
            app_key: 'image_to_image',
            size,
            quality: quality === 'auto' ? 'medium' : quality,
            n: count,
          },
          source_route: '/studio/online',
          source_context: context,
        })
      }
      const options: Record<string, unknown> = {}
      if (deployment.adapter_type === 'modelscope') {
        if (referenceIds.length > 0) options.ref_asset_ids = referenceIds
        if (negativePrompt.trim() !== '') options.negative_prompt = negativePrompt.trim()
        if (seed.trim() !== '') options.seed = Number(seed)
        options.num_inference_steps = steps
        options.guidance_scale = guidance
        if (loraId.trim() !== '') options.loras = { [loraId.trim()]: loraStrength }
      }
      return apiStudio.runTool(TOOL_ID, {
        operation: 'image.generate',
        input: {
          prompt: text,
          deployment_id: deployment.id,
          alias: 'image-free',
          target_key: 'free',
          size,
          ...(quality === 'auto' ? {} : { quality }),
          n: count,
          options,
        },
        source_route: '/studio/online',
        source_context: context,
      })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['online-image-tasks'] })
      void queryClient.invalidateQueries({ queryKey: ['studio-tasks'] })
      toast.success('在线生图任务已进入后台队列')
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
    onSuccess: (total) => {
      setSelected(new Set())
      setSelecting(false)
      setPreview(null)
      void queryClient.invalidateQueries({ queryKey: ['online-image-history'] })
      void queryClient.invalidateQueries({ queryKey: ['img-assets'] })
      toast.success(`已移入归档 ${total} 张`)
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const replicate = (item: OnlineImageHistoryItem) => {
    setPrompt(item.prompt)
    setReferences([item.references[0] ?? null, item.references[1] ?? null, item.references[2] ?? null])
    const matched = executable.find((entry) => entry.upstream_model_id === item.model && entry.adapter_type === item.adapter)
    const matchedWorkflow = runningHubEntries.find((entry) => entry.title === item.model)
    if (matched !== undefined) {
      setEngine('deployment')
      setProviderKey(String(matched.credential_id))
      setDeploymentId(matched.id)
    } else if (matchedWorkflow !== undefined) {
      setEngine('runninghub')
      setRunningHubWorkflowId(matchedWorkflow.id)
      setCount(1)
    }
    const preset = Object.entries({
      square: ['1024x1024', '2048x2048'], portrait: ['1024x1536', '1360x2048', '2352x3520'],
      landscape: ['1536x1024', '2048x1360', '3520x2352'], portrait43: ['1008x1344', '1536x2048', '2448x3264'],
      landscape43: ['1344x1008', '2048x1536', '3264x2448'], story: ['720x1280', '1152x2048', '2160x3840'],
      wide: ['1280x720', '2048x1152', '3840x2160'],
    }).find(([, values]) => values.includes(item.size))
    if (preset !== undefined) {
      setRatio(preset[0] as OnlineRatio)
      setResolution((['1k', '2k', '4k'][preset[1].indexOf(item.size)] ?? '1k') as OnlineResolution)
    } else {
      const [width, height] = item.size.split('x')
      setResolution('custom'); setCustomWidth(width ?? ''); setCustomHeight(height ?? '')
    }
    setQuality(['auto', 'low', 'medium', 'high'].includes(item.quality) ? item.quality : 'auto')
    setPreview(null)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const toggleSelected = (id: number) => setSelected((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  return (
    <div className="oni-page">
      <header className="oni-title"><div><span>ONLINE IMAGE STUDIO</span><h1>在线多平台生图</h1></div><p>OpenAI、Gemini、ModelScope、直连部署与 RunningHub 共用三参考、尺寸、持久任务与历史。</p></header>

      <main className="oni-workbench">
        <section className="oni-controls">
          <label className="oni-prompt"><span>PROMPT</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={5} placeholder="输入想生成或编辑的画面…" /></label>
          <div className="oni-reference-head"><span>REFERENCE IMAGES</span><small>最多 3 张 · 选择/上传/拖放/粘贴</small></div>
          <div className="oni-references">
            {references.map((asset, index) => (
              <ReferenceSlot key={index} index={index} asset={asset} uploading={uploadingSlot === index} onPick={() => setPickerSlot(index)} onClear={() => setSlot(index, null)} onFile={(file) => void upload(index, file)} onHover={(active) => { hoveredSlot.current = active ? index : hoveredSlot.current === index ? null : hoveredSlot.current }} />
            ))}
          </div>

          <section className="oni-model-panel">
            <div className="oni-panel-label"><SlidersHorizontal /><span>MODEL</span><b>{engine === 'runninghub' ? 'RUNNINGHUB' : deployment?.adapter_type.toUpperCase() ?? 'DEPLOYMENT'}</b></div>
            <div className="oni-engine-tabs" role="group" aria-label="在线生图执行方式">
              <button className={engine === 'deployment' ? 'is-active' : ''} onClick={() => setEngine('deployment')}>图片部署</button>
              <button className={engine === 'runninghub' ? 'is-active' : ''} onClick={() => { setEngine('runninghub'); setCount(1) }}>RunningHub</button>
            </div>
            {engine === 'deployment' ? <>
              <div className="oni-model-row">
                <Picker value={providerKey} onChange={setProviderKey} options={providers} placeholder="选择平台" aria-label="在线生图平台" disabled={providers.length === 0} />
                <Picker value={deploymentId === null ? '' : String(deploymentId)} onChange={(value) => setDeploymentId(Number(value))} options={paged.items.map((item) => ({ value: String(item.id), label: deploymentName(item), hint: item.adapter_type }))} placeholder="选择模型" aria-label="在线生图模型" disabled={paged.items.length === 0} />
              </div>
              <div className="oni-model-catalog">
                <label><Search /><input value={modelSearch} onChange={(event) => { setModelSearch(event.target.value); setModelPage(0) }} placeholder="搜索当前平台模型" /></label>
                <span>{searchedDeployments.length} 个 · {paged.page + 1}/{paged.pages} 页</span>
                <button onClick={() => setModelPage((value) => Math.max(0, value - 1))} disabled={paged.page === 0} aria-label="上一页"><ChevronLeft /></button>
                <button onClick={() => setModelPage((value) => Math.min(paged.pages - 1, value + 1))} disabled={paged.page >= paged.pages - 1} aria-label="下一页"><ChevronRight /></button>
              </div>
            </> : <div className="oni-runninghub-row">
              <Picker value={runningHubWorkflowId === null ? '' : String(runningHubWorkflowId)} onChange={(value) => setRunningHubWorkflowId(Number(value))} options={runningHubEntries.map((item) => ({ value: String(item.id), label: item.title, hint: item.kind === 'app' ? 'AI 应用' : '工作流' }))} placeholder="选择 RunningHub 图片工作流" aria-label="RunningHub 图片工作流" disabled={runningHubEntries.length === 0} />
              <small>提示词、参考图、比例与分辨率会按已发布字段自动绑定。</small>
            </div>}
            <p className={canRun ? 'is-ready' : ''}>{configMessage}</p>
            {engine === 'deployment' && executable.length === 0 && <button className="oni-config" onClick={() => navigate('/studio/models')}><Settings2 />去配置图片部署</button>}
            {engine === 'runninghub' && (runningHubEntries.length === 0 || runningHubCredential === undefined) && <button className="oni-config" onClick={() => navigate('/studio/workflows')}><Settings2 />去配置 RunningHub</button>}
          </section>

          <section className="oni-size-panel">
            <div className="oni-panel-label"><Maximize2 /><span>SIZE & OUTPUT</span><b>{size ?? '尺寸无效'}</b></div>
            <div className="oni-size-row">
              <Picker value={resolution} onChange={(value) => setResolution(value as OnlineResolution)} options={[{ value: '1k', label: '1K' }, { value: '2k', label: '2K' }, { value: '4k', label: '4K' }, { value: 'custom', label: '自定义尺寸' }]} aria-label="分辨率" />
              <Picker value={ratio} onChange={(value) => setRatio(value as OnlineRatio)} options={[{ value: 'square', label: '1:1 方图' }, { value: 'portrait', label: '2:3 竖图' }, { value: 'landscape', label: '3:2 横图' }, { value: 'portrait43', label: '3:4 竖图' }, { value: 'landscape43', label: '4:3 横图' }, { value: 'story', label: '9:16 竖屏' }, { value: 'wide', label: '16:9 宽屏' }, { value: 'custom', label: '自定义比例' }]} aria-label="画幅比例" disabled={resolution === 'custom'} />
            </div>
            {resolution === 'custom' && <div className="oni-custom-size"><input type="number" min="64" max="3840" step="16" value={customWidth} onChange={(event) => setCustomWidth(event.target.value)} placeholder="宽度" /><span>×</span><input type="number" min="64" max="3840" step="16" value={customHeight} onChange={(event) => setCustomHeight(event.target.value)} placeholder="高度" /><button disabled={references[0] === null} onClick={() => { const main = references[0]; if (main !== null) { setCustomWidth(String(Math.floor(main.width / 16) * 16)); setCustomHeight(String(Math.floor(main.height / 16) * 16)) } }}>适配主图</button></div>}
            {resolution !== 'custom' && ratio === 'custom' && <div className="oni-custom-size"><input type="number" min="1" step="1" value={ratioWidth} onChange={(event) => setRatioWidth(event.target.value)} placeholder="比例宽" /><span>:</span><input type="number" min="1" step="1" value={ratioHeight} onChange={(event) => setRatioHeight(event.target.value)} placeholder="比例高" /></div>}
            <div className="oni-size-row">
              {engine === 'runninghub'
                ? <span className="oni-adapter-note">质量与采样参数由工作流内部决定</span>
                : QUALITY_ADAPTERS.has(deployment?.adapter_type ?? '')
                  ? <Picker value={quality} onChange={setQuality} options={[{ value: 'auto', label: '质量 · 自动' }, { value: 'low', label: '质量 · 低' }, { value: 'medium', label: '质量 · 中' }, { value: 'high', label: '质量 · 高' }]} aria-label="输出质量" />
                  : <span className="oni-adapter-note">质量由 {deployment?.adapter_type ?? '当前协议'} 决定</span>}
              {engine === 'runninghub' ? <span className="oni-adapter-note">×1 · 每次运行一个完整工作流</span> : <Picker value={String(count)} onChange={(value) => setCount(Number(value))} options={[1, 2, 3, 4].map((value) => ({ value: String(value), label: `×${value}` }))} aria-label="生成张数" />}
            </div>
          </section>

          {engine === 'deployment' && isModelScope && <section className="oni-advanced"><button onClick={() => setAdvanced((value) => !value)}><SlidersHorizontal />{advanced ? '收起' : '展开'} ModelScope 高级参数</button>{advanced && <div><label><span>负面提示词</span><textarea rows={2} value={negativePrompt} onChange={(event) => setNegativePrompt(event.target.value)} /></label><label><span>Seed（留空随机）</span><input type="number" min="0" max="4294967295" step="1" value={seed} onChange={(event) => setSeed(event.target.value)} /></label><label><span>Steps {steps}</span><input type="range" min="1" max="100" step="1" value={steps} onChange={(event) => setSteps(Number(event.target.value))} /></label><label><span>Guidance {guidance.toFixed(1)}</span><input type="range" min="0" max="20" step="0.1" value={guidance} onChange={(event) => setGuidance(Number(event.target.value))} /></label>{compatibleLoras.length > 0 ? <label><span>LoRA</span><Picker value={loraPickerValue} onChange={(value) => { if (value === 'none') { setLoraId(''); return } const selected = compatibleLoras.find((item) => item.lora_id === value); if (selected !== undefined) { setLoraId(selected.lora_id); setLoraStrength(selected.default_strength) } }} options={[{ value: 'none', label: '不使用 LoRA' }, ...compatibleLoras.map((item) => ({ value: item.lora_id, label: item.display_name || item.lora_id, hint: item.lora_id }))]} aria-label="ModelScope LoRA" /></label> : <label><span>LoRA ID</span><input value={loraId} onChange={(event) => setLoraId(event.target.value)} placeholder="暂无匹配目录，可手动输入组织/LoRA" /></label>}<label><span>LoRA 强度 {loraStrength.toFixed(2)}</span><input type="range" min="0" max="2" step="0.05" value={loraStrength} disabled={loraId === ''} onChange={(event) => setLoraStrength(Number(event.target.value))} /></label></div>}</section>}

          <button className="oni-run" disabled={!canRun || run.isPending || activeTasks.length > 0} onClick={() => run.mutate()}><Zap />{run.isPending || activeTasks.length > 0 ? '生成中…' : engine === 'runninghub' ? '运行 RunningHub 工作流' : references.some((item) => item !== null) ? '按参考图编辑' : '在线生成'}</button>
        </section>

        <section className="oni-result">
          {shown === null ? <div className="oni-result-empty"><CloudCog /><strong>CANVAS READY</strong><span>任务完成后会在这里展示最新结果</span></div> : <button onClick={() => setPreview(shown)}><img src={shown.asset.url} alt={shown.prompt || '在线生图结果'} /><span>{shown.provider} · {shown.model || shown.adapter}</span></button>}
          {activeTasks.length > 0 && <div className="oni-result-running"><LoaderCircle /><strong>{activeTasks[0]?.stage ?? '生成中'}</strong><span>{Math.round(activeTasks[0]?.progress ?? 0)}%</span></div>}
        </section>
      </main>

      {latestFailure !== undefined && <div className="oni-failure"><strong>最近任务失败</strong><span>{latestFailure.error || latestFailure.stage}</span><button onClick={() => navigate('/tasks')}>查看任务</button></div>}

      <section className="oni-gallery">
        <header><div><span>ONLINE ARCHIVE</span><h2>在线生图历史</h2></div><div>{selecting ? <><span>已选 {selected.size} 张</span><button onClick={() => setSelected(new Set(historyItems.map((item) => item.asset.id)))}>全选已加载</button><button className="danger" disabled={selected.size === 0 || archive.isPending} onClick={() => { if (window.confirm(`把选中的 ${selected.size} 张图片移入归档？`)) archive.mutate([...selected]) }}><Trash2 />移入归档</button><button onClick={() => { setSelecting(false); setSelected(new Set()) }}>取消</button></> : <button disabled={historyItems.length === 0} onClick={() => setSelecting(true)}>批量选择</button>}</div></header>
        <div className="oni-grid">
          {activeTasks.map((task) => <ActiveCard key={task.id} task={task} />)}
          {historyItems.map((item) => <HistoryCard key={item.asset.id} item={item} selecting={selecting} selected={selected.has(item.asset.id)} onToggle={() => toggleSelected(item.asset.id)} onOpen={() => setPreview(item)} />)}
        </div>
        {!history.isPending && activeTasks.length === 0 && historyItems.length === 0 && <div className="oni-empty"><ImagePlus /><strong>还没有在线生图作品</strong><p>配置可执行图片部署或 RunningHub 图片工作流后，结果会连同平台、模型、参考和尺寸一起保存。</p></div>}
        {history.hasNextPage && <button ref={moreTrigger} className="oni-more" onClick={() => void history.fetchNextPage()} disabled={history.isFetchingNextPage}>{history.isFetchingNextPage ? '加载中…' : '加载更多历史'}</button>}
      </section>

      {pickerSlot !== null && <AssetPicker onClose={() => setPickerSlot(null)} onPick={(asset) => { setSlot(pickerSlot, asset); setPickerSlot(null) }} />}
      {preview !== null && <Lightbox item={preview} onClose={() => setPreview(null)} onReplicate={() => replicate(preview)} />}
    </div>
  )
}
