/* 角度控制（模块 17 FR-475）。类名前缀 stl-（与细节增强共用 studio-tools.css）。

   三根滑杆定机位 → 实时 3D 预览 → 机位翻成中文指令原位写进提示词 → 走 /images/edit
   让模型换个角度重画同一主体。

   为什么预览不用 three.js：需求原文提的是 `@react-three/fiber`，但这里要渲染的只是
   **一个贴了图的平面**，CSS 3D 就是干这个的——`perspective` + `rotateX/rotateY` 得到
   的投影与三维引擎完全一致（单个平面绕相机转、相机绕平面转，数学上等价）。换 WebGL
   要多一整套依赖，还要接本仓已经踩过的坑（pixi 销毁丢 WebGL context，同一 canvas
   不能二次建 Application）。一个平面不值这个价。 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { toast } from 'sonner'
import {
  Check,
  Cloud,
  Copy,
  Download,
  Focus,
  ImagePlus,
  LoaderCircle,
  Maximize2,
  Minus,
  Monitor,
  Plus,
  RotateCcw,
  Settings2,
  Trash2,
  X,
} from '@/components/NexusIcon'
import { useNavigate } from 'react-router-dom'

import { apiConfig } from '../../lib/api-config'
import { apiImage } from '../../lib/api-image'
import type { ImageAsset } from '../../lib/api-image'
import { runImageEditTask } from '../../lib/image-edit-task'
import { apiStudio } from '../../lib/api-studio'
import type { StudioTask } from '../../lib/api-studio'
import { AssetPicker } from './AssetPicker'
import { ToolHeader, downloadAsset } from './StudioToolShell'
import {
  angleHistoryItems,
  angleResultAssetIds,
  angleSourceAssetId,
} from './angle-history'
import type { AngleEngine, AngleHistoryItem } from './angle-history'
import { applyAngleInstruction, buildAngleInstruction } from './angleInstruction'
import type { AnglePose } from './angleInstruction'
import { useInitialImageAsset } from './useInitialImageAsset'
// AssetPicker 的样式（scv-picker 那一组）住在 canvas.css，用它就得带上它
import './canvas.css'
import './angle.css'
import './studio-tools.css'

const QUALITIES: Array<[string, string]> = [
  ['low', '低'],
  ['medium', '中'],
  ['high', '高'],
]

/** 原机位：不转、不俯仰、标准镜头 */
const NEUTRAL: AnglePose = { yaw: 0, pitch: 0, distance: 4 }
const TOOL_ID = 'angle-control'
const PAGE_SIZE = 30
const ACTIVE = new Set(['queued', 'submitting', 'running', 'recovering'])
const ENGINE_KEY = 'angle_engine_mode'

interface AngleHistoryPage {
  items: AngleHistoryItem[]
  nextOffset: number | null
}

function storedEngine(): AngleEngine {
  try { return localStorage.getItem(ENGINE_KEY) === 'modelscope' ? 'modelscope' : 'local' }
  catch { return 'local' }
}

function randomSeed(): number {
  try {
    const value = new Uint32Array(2)
    crypto.getRandomValues(value)
    return Number((BigInt(value[0] ?? 0) << 32n | BigInt(value[1] ?? 0)) % 1_000_000_000_000_000n)
  } catch {
    return Math.floor(Math.random() * 1_000_000_000_000_000)
  }
}

async function waitForTask(taskId: string): Promise<StudioTask> {
  for (let index = 0; index < 900; index += 1) {
    const task = await apiStudio.task(taskId)
    if (task.status === 'succeeded') return task
    if (task.status === 'failed' || task.status === 'cancelled') {
      throw new Error(task.error ?? `任务${task.status === 'failed' ? '失败' : '已取消'}`)
    }
    await new Promise((resolve) => window.setTimeout(resolve, 2000))
  }
  throw new Error('页面等待超时，任务仍在后台；可到任务中心查看结果')
}

async function angleHistoryPage(offset: number): Promise<AngleHistoryPage> {
  const response = await apiStudio.tasks({
    tool_id: TOOL_ID,
    status: 'succeeded',
    limit: PAGE_SIZE,
    offset,
  })
  const ids = [...new Set(response.items.flatMap((task) => [
    ...angleResultAssetIds(task),
    ...(angleSourceAssetId(task) === null ? [] : [angleSourceAssetId(task)!]),
  ]))]
  const settled = await Promise.allSettled(ids.map((id) => apiImage.asset(id)))
  const assets = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
  return {
    items: response.items.flatMap((task) => angleHistoryItems(task, assets)),
    nextOffset: response.items.length === PAGE_SIZE ? offset + PAGE_SIZE : null,
  }
}

/** 与 CSS 里 .stl-3d 的 perspective 必须一致，否则算出来的 z 对不上投影 */
const PERSPECTIVE = 900

/** 一次生成的结果 + 当时的机位，挑图时要看得见是哪一档拍的 */
interface AngleShot {
  asset: ImageAsset
  pose: AnglePose
  instruction: string
}

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n))
const round1 = (n: number): number => Math.round(n * 10) / 10

/** 机位 → CSS transform。
 *
 *  距离用透视位移表达而不是简单 scale：`perspective(P)` 下位移 z 的平面投影缩放正好
 *  是 P/(P−z)，所以给定想要的视觉倍数 s，反解 z = P(1 − 1/s) 就能同时拿到「变大」
 *  和「近大远小更夸张」两件事——这正是广角与特写的区别所在。 */
function planeTransform(pose: AnglePose): string {
  const scale = clamp(NEUTRAL.distance / Math.max(0.1, pose.distance), 0.34, 2)
  const z = Math.round(PERSPECTIVE * (1 - 1 / scale))
  return `translateZ(${z}px) rotateY(${pose.yaw}deg) rotateX(${-pose.pitch}deg)`
}

/** 数字输入。带本地草稿：直接受控的话敲负号那一刻会被抹掉，负角度根本打不进去 */
function NumField({
  value,
  min,
  max,
  decimals,
  label,
  onCommit,
}: {
  value: number
  min: number
  max: number
  decimals: number
  label: string
  onCommit: (n: number) => void
}): JSX.Element {
  const [draft, setDraft] = useState(() => value.toFixed(decimals))
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    if (!editing) setDraft(value.toFixed(decimals))
  }, [value, decimals, editing])

  return (
    <input
      className="stl-num"
      type="text"
      inputMode="decimal"
      aria-label={label}
      value={draft}
      onFocus={() => setEditing(true)}
      onBlur={() => {
        setEditing(false)
        setDraft(value.toFixed(decimals))
      }}
      onChange={(e) => {
        const raw = e.target.value
        setDraft(raw)
        const n = Number(raw)
        if (raw.trim() !== '' && Number.isFinite(n)) onCommit(clamp(n, min, max))
      }}
    />
  )
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  decimals,
  scale,
  onChange,
  onReset,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  decimals: number
  /** 刻度说明，三段分列左中右 */
  scale: [string, string, string]
  onChange: (n: number) => void
  onReset: () => void
}): JSX.Element {
  return (
    <div className="stl-row">
      <div className="stl-row-head">
        <span className="stl-row-label">{label}</span>
        <NumField
          value={value}
          min={min}
          max={max}
          decimals={decimals}
          label={`${label}数值`}
          onCommit={onChange}
        />
        <button className="icon-btn" title={`${label}复位`} aria-label={`${label}复位`} onClick={onReset}>
          <RotateCcw />
        </button>
      </div>
      <input
        className="stl-range"
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <div className="stl-scale">
        {scale.map((s) => (
          <span key={s}>{s}</span>
        ))}
      </div>
    </div>
  )
}

function AngleLightbox({ item, onClose }: { item: AngleHistoryItem; onClose: () => void }): JSX.Element {
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const drag = useRef<{ id: number; x: number; y: number; ox: number; oy: number } | null>(null)
  const clampScale = (value: number) => Math.max(0.5, Math.min(5, value))
  const reset = () => { setScale(1); setOffset({ x: 0, y: 0 }) }

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
    <div className="ang-lightbox" role="dialog" aria-modal="true" aria-label="角度结果预览" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <button className="ang-lightbox-close" onClick={onClose} aria-label="关闭"><X /></button>
      <div className="ang-lightbox-body">
        <div
          className="ang-preview"
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.currentTarget.setPointerCapture(event.pointerId)
            drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y }
          }}
          onPointerMove={(event) => {
            if (drag.current?.id !== event.pointerId) return
            setOffset({ x: drag.current.ox + event.clientX - drag.current.x, y: drag.current.oy + event.clientY - drag.current.y })
          }}
          onPointerUp={(event) => { if (drag.current?.id === event.pointerId) drag.current = null }}
          onPointerCancel={(event) => { if (drag.current?.id === event.pointerId) drag.current = null }}
          onWheel={(event) => {
            event.preventDefault()
            setScale((current) => clampScale(current * (event.deltaY > 0 ? 0.9 : 1.1)))
          }}
          onDoubleClick={reset}
        >
          <img src={item.asset.full_url} alt={item.prompt || item.instruction} draggable={false} style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }} />
          <span>{item.asset.width} × {item.asset.height}</span>
          <div><button onClick={() => setScale((value) => clampScale(value - 0.25))} aria-label="缩小"><Minus /></button><button onClick={reset} aria-label="重置"><Maximize2 /></button><button onClick={() => setScale((value) => clampScale(value + 0.25))} aria-label="放大"><Plus /></button></div>
        </div>
        <section><div><span>GENERATED COMMAND</span><strong>{item.instruction || '自定义提示词'}</strong><p>{item.prompt}</p></div><a href={item.asset.full_url} download={`Angle-${item.asset.id}.png`}><Download />保存成品</a></section>
      </div>
    </div>
  )
}

export default function AnglePage(): JSX.Element {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const loadTrigger = useRef<HTMLButtonElement | null>(null)
  const [source, setSource] = useState<ImageAsset | null>(null)
  const [picking, setPicking] = useState(false)
  const [pose, setPoseState] = useState<AnglePose>(NEUTRAL)
  const [prompt, setPrompt] = useState(() => buildAngleInstruction(NEUTRAL))
  const [engine, setEngineState] = useState<AngleEngine>(storedEngine)
  const [quality, setQuality] = useState('medium')
  const [shots, setShots] = useState<AngleShot[]>([])
  const [busySince, setBusySince] = useState<number | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [preview, setPreview] = useState<AngleHistoryItem | null>(null)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())

  const workflows = useQuery({
    queryKey: ['studio-workflows', 'angle'],
    queryFn: () => apiStudio.workflows('?provider=comfyui&enabled=true'),
  })
  const credentials = useQuery({
    queryKey: ['cfg-creds', 'workflow'],
    queryFn: () => apiConfig.credentials('workflow'),
  })
  const deployments = useQuery({
    queryKey: ['cfg-model-deployments', 'angle'],
    queryFn: () => apiConfig.modelDeployments({ media_type: 'image', enabled: true }),
  })
  const tasks = useQuery({
    queryKey: ['angle-tasks'],
    queryFn: () => apiStudio.tasks({ tool_id: TOOL_ID, limit: 60 }),
    refetchInterval: (query) => (query.state.data?.items ?? []).some((task) => ACTIVE.has(task.status)) ? 1500 : false,
  })
  const history = useInfiniteQuery({
    queryKey: ['angle-history'],
    queryFn: ({ pageParam }) => angleHistoryPage(pageParam),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset ?? undefined,
  })

  const localWorkflow = (workflows.data?.items ?? []).find((item) => item.key === 'comfyui:2511')
  const localCredential = (credentials.data ?? []).find((item) => item.enabled && item.provider_type === 'comfyui')
  const cloudDeployment = useMemo(() => (deployments.data ?? [])
    .filter((item) => item.adapter_type === 'modelscope')
    .sort((left, right) => {
      const rank = (value: string) => /qwen[-_/ ]?image[-_/ ]?edit[-_/ ]?2511/i.test(value) ? 0 : 1
      return rank(left.upstream_model_id) - rank(right.upstream_model_id) || left.sort - right.sort
    })[0], [deployments.data])
  const activeTasks = (tasks.data?.items ?? []).filter((task) =>
    ACTIVE.has(task.status) && (task.source_context?.angle_engine === 'local' || task.source_context?.angle_engine === 'modelscope'),
  )
  const latestFailure = (tasks.data?.items ?? []).find((task) =>
    task.status === 'failed' && (task.source_context?.angle_engine === 'local' || task.source_context?.angle_engine === 'modelscope'),
  )
  const terminalSignature = (tasks.data?.items ?? [])
    .filter((task) => task.status === 'succeeded' && task.source_context?.angle_engine !== undefined)
    .map((task) => `${task.id}:${task.updated_at ?? ''}`)
    .join('|')
  const historyItems = useMemo(() => {
    const unique = new Map<number, AngleHistoryItem>()
    for (const item of history.data?.pages.flatMap((page) => page.items) ?? []) {
      if (!unique.has(item.asset.id)) unique.set(item.asset.id, item)
    }
    return [...unique.values()]
  }, [history.data])
  const busy = busySince !== null || activeTasks.length > 0
  const instruction = buildAngleInstruction(pose)
  const neutral = instruction === ''
  const configured = engine === 'local'
    ? localWorkflow !== undefined && localCredential !== undefined
    : cloudDeployment !== undefined
  const configMessage = engine === 'local'
    ? localWorkflow === undefined
      ? '内置 2511 角度工作流尚未载入'
      : localCredential === undefined
        ? '还没有启用的 ComfyUI 执行器凭据'
        : `本机 · ${localCredential.name}`
    : cloudDeployment === undefined
      ? '还没有启用的 ModelScope 图片部署'
      : `云端 · ${cloudDeployment.display_name || cloudDeployment.upstream_model_id}`

  const setEngine = (value: AngleEngine): void => {
    setEngineState(value)
    try { localStorage.setItem(ENGINE_KEY, value) } catch { /* 本次会话仍可使用 */ }
  }

  /** 改机位的唯一入口：顺手把提示词里的指令行换掉，用户写的其它内容一个字不动 */
  const setPose = useCallback((next: AnglePose) => {
    setPoseState(next)
    setPrompt((prev) => applyAngleInstruction(prev, buildAngleInstruction(next)))
  }, [])

  useEffect(() => {
    if (busySince === null) {
      setElapsed(0)
      return
    }
    const id = window.setInterval(
      () => setElapsed(Math.round((Date.now() - busySince) / 1000)),
      250,
    )
    return () => window.clearInterval(id)
  }, [busySince])

  useEffect(() => {
    if (terminalSignature !== '') void queryClient.invalidateQueries({ queryKey: ['angle-history'] })
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

  const run = useCallback(async () => {
    const text = prompt.trim()
    if (source === null || busy || text === '') return
    if (!configured) {
      toast.error(configMessage)
      return
    }
    const shotPose = pose
    const shotInstruction = buildAngleInstruction(pose)
    const sourceContext = {
      angle_engine: engine,
      source_asset_id: source.id,
      prompt: text,
      instruction: shotInstruction,
      pose: shotPose,
    }
    setBusySince(Date.now())
    try {
      let items: ImageAsset[]
      if (engine === 'local') {
        if (localWorkflow === undefined || localCredential === undefined) throw new Error(configMessage)
        const created = await apiStudio.runTool(TOOL_ID, {
          operation: 'workflow.run',
          input: {
            workflow_id: localWorkflow.id,
            credential_id: localCredential.id,
            fields: { f_image: `asset:${source.id}`, f_prompt: text, f_seed: randomSeed() },
          },
          source_route: '/studio/angle',
          source_context: sourceContext,
        })
        void queryClient.invalidateQueries({ queryKey: ['angle-tasks'] })
        const completed = await waitForTask(created.id)
        items = await Promise.all(angleResultAssetIds(completed).map((id) => apiImage.asset(id)))
      } else {
        if (cloudDeployment === undefined) throw new Error(configMessage)
        const form = new FormData()
        form.set('prompt', text)
        form.set('app_key', 'angle_shift')
        form.set('alias', 'image-free')
        form.set('quality', quality)
        form.set('n', '1')
        form.set('ref_asset_ids', String(source.id))
        items = await runImageEditTask(form, {
          toolId: TOOL_ID,
          sourceRoute: '/studio/angle',
          sourceContext,
          deploymentId: cloudDeployment.id,
        }, () => void queryClient.invalidateQueries({ queryKey: ['angle-tasks'] }))
      }
      const first = items[0]
      if (first === undefined) throw new Error('上游没有返回图片')
      setShots((prev) => [{ asset: first, pose: shotPose, instruction: shotInstruction }, ...prev])
      void queryClient.invalidateQueries({ queryKey: ['angle-history'] })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '生成失败')
    } finally {
      setBusySince(null)
    }
  }, [source, busy, prompt, configured, pose, engine, configMessage, localWorkflow, localCredential, queryClient, cloudDeployment, quality])

  /** 换底图：结果清空——它们是上一张图的机位，留着只会让标注对不上 */
  const pick = (asset: ImageAsset): void => {
    setSource(asset)
    setShots([])
    setPose(NEUTRAL)
  }
  useInitialImageAsset(pick)

  /** 拿某个结果当新底图继续换角度。新底图就是新的「原机位」，滑杆归零 */
  const adopt = (shot: AngleShot): void => {
    setSource(shot.asset)
    setPose(NEUTRAL)
    toast.success(`已把 #${shot.asset.id} 设为新原图，机位滑杆归零`)
  }

  const archive = useMutation({
    mutationFn: async (ids: number[]) => {
      const settled = await Promise.allSettled(ids.map((id) => apiImage.patchAsset(id, { status: 'archived' })))
      const failed = settled.filter((item) => item.status === 'rejected').length
      if (failed > 0) throw new Error(`已归档 ${ids.length - failed} 张，${failed} 张失败`)
      return ids.length
    },
    onSuccess: (count) => {
      setSelected(new Set())
      setSelecting(false)
      void queryClient.invalidateQueries({ queryKey: ['angle-history'] })
      void queryClient.invalidateQueries({ queryKey: ['img-assets'] })
      toast.success(`已移入归档 ${count} 张`)
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const toggleHistory = (id: number): void => setSelected((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const copyInstruction = (): void => {
    if (instruction === '') return
    void navigator.clipboard.writeText(instruction)
      .then(() => toast.success('机位命令已复制'))
      .catch(() => toast.error('复制失败'))
  }

  return (
    <main className="page stl-page">
      <ToolHeader
        icon={<Focus />}
        title="角度控制"
        sub="拖三根滑杆定机位，预览与中文命令实时同步；可用本机 2511 工作流或 ModelScope 重画同一个主体。"
        hasImage={source !== null}
        onPickImage={() => setPicking(true)}
      />

      {source === null ? (
        <div className="stl-blank">
          <span className="stl-blank-icon">
            <Focus />
          </span>
          <span className="stl-blank-title">先选一张要换角度的图</span>
          <p className="stl-blank-hint">
            资产库里挑一张，或直接上传本地图片。预览只是机位示意，真正换角度由模型重画。
          </p>
          <button className="btn btn-primary btn-lg" onClick={() => setPicking(true)}>
            <ImagePlus />
            选一张图
          </button>
        </div>
      ) : (
        <div className="stl-body">
          <section className="stl-main">
            <div className="stl-3d">
              <img
                className="stl-plane"
                src={source.url}
                alt="机位预览"
                draggable={false}
                style={{ transform: planeTransform(pose) } as CSSProperties}
              />
            </div>

            <div className="stl-block stl-wide">
              <span className="stl-label">提示词</span>
              <textarea
                className="stl-prompt"
                value={prompt}
                spellCheck={false}
                aria-label="提示词"
                onChange={(e) => setPrompt(e.target.value)}
              />
              <p className="stl-hint">
                拖滑杆只替换以「将相机」或「保持原机位」开头的那一行，其它内容（主体描述、
                要保留什么、别改什么）随便写，不会被覆盖。
              </p>
            </div>

            <div className="stl-bar">
              <button
                className="btn btn-primary btn-lg"
                disabled={busy || !configured || prompt.trim() === ''}
                onClick={() => void run()}
              >
                {busy ? <LoaderCircle className="ang-spin" /> : <Focus />}
                {busy ? `生成中… ${elapsed}s` : engine === 'local' ? '本机生成新视角' : 'ModelScope 生成新视角'}
              </button>
              {neutral && (
                <span className="stl-busy">
                  当前是中性机位；拖动任一滑杆会生成并写入命令
                </span>
              )}
            </div>

            {shots.length > 0 && (
              <div className="stl-results">
                {shots.map((shot) => (
                  <figure
                    key={shot.asset.id}
                    className={
                      shot.asset.id === source.id ? 'stl-result stl-result-on' : 'stl-result'
                    }
                  >
                    <img src={shot.asset.thumb_url} alt={shot.instruction} loading="lazy" />
                    <figcaption className="stl-result-meta">
                      水平 {shot.pose.yaw}° · 垂直 {shot.pose.pitch}° · 距离{' '}
                      {shot.pose.distance.toFixed(1)}
                      <br />
                      {shot.instruction}
                    </figcaption>
                    <div className="stl-result-acts">
                      <button
                        className="btn btn-sm btn-outline"
                        disabled={shot.asset.id === source.id}
                        onClick={() => adopt(shot)}
                      >
                        设为新原图
                      </button>
                      <button
                        className="btn btn-sm btn-outline"
                        onClick={() => {
                          void downloadAsset(shot.asset).catch((e: unknown) =>
                            toast.error(e instanceof Error ? e.message : '下载失败'),
                          )
                        }}
                      >
                        下载
                      </button>
                    </div>
                  </figure>
                ))}
              </div>
            )}
          </section>

          <aside className="stl-side">
            <div className="stl-block">
              <span className="stl-label">执行引擎</span>
              <div className="ang-engine" role="group" aria-label="角度生成引擎">
                <button className={engine === 'local' ? 'active' : ''} onClick={() => setEngine('local')}><Monitor />本机</button>
                <button className={engine === 'modelscope' ? 'active' : ''} onClick={() => setEngine('modelscope')}><Cloud />ModelScope</button>
              </div>
              <p className="stl-hint">{configMessage}</p>
              {!configured && <button className="btn btn-outline btn-sm" onClick={() => navigate(engine === 'local' ? '/studio/workflows' : '/studio/models')}><Settings2 />去配置</button>}
            </div>

            <div className="stl-block">
              <span className="stl-label">机位</span>
              <div className="stl-rows">
                <SliderRow
                  label="水平旋转"
                  value={pose.yaw}
                  min={-90}
                  max={90}
                  step={1}
                  decimals={0}
                  scale={['左 90°', '正面', '右 90°']}
                  onChange={(n) => setPose({ ...pose, yaw: Math.round(n) })}
                  onReset={() => setPose({ ...pose, yaw: NEUTRAL.yaw })}
                />
                <SliderRow
                  label="垂直俯仰"
                  value={pose.pitch}
                  min={-90}
                  max={90}
                  step={1}
                  decimals={0}
                  scale={['仰视 90°', '平视', '俯视 90°']}
                  onChange={(n) => setPose({ ...pose, pitch: Math.round(n) })}
                  onReset={() => setPose({ ...pose, pitch: NEUTRAL.pitch })}
                />
                <SliderRow
                  label="距离"
                  value={pose.distance}
                  min={0.1}
                  max={8}
                  step={0.1}
                  decimals={1}
                  scale={['特写 <4', '标准 4', '广角 >4']}
                  onChange={(n) => setPose({ ...pose, distance: round1(n) })}
                  onReset={() => setPose({ ...pose, distance: NEUTRAL.distance })}
                />
              </div>
              <div className="stl-acts">
                <button className="btn btn-outline btn-sm" onClick={() => setPose(NEUTRAL)}>
                  <RotateCcw />
                  全部复位
                </button>
              </div>
            </div>

            <div className="stl-block">
              <span className="stl-label">当前指令</span>
              <div className="ang-command">
                <p>{instruction || '调整机位后生成命令'}</p>
                <button disabled={instruction === ''} onClick={copyInstruction}><Copy />复制</button>
              </div>
              <p className="stl-hint">
                距离只决定用哪种镜头描述（{'<'}4 特写 / 4 标准 / {'>'}4 广角），不会写成
                「距离 3.2」这种模型读不懂的数。
              </p>
            </div>

            <div className="stl-block">
              <span className="stl-label">输出质量</span>
              <div className="seg" role="group" aria-label="输出质量">
                {QUALITIES.map(([key, label]) => (
                  <button
                    key={key}
                    className={quality === key ? 'active' : ''}
                    onClick={() => setQuality(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <p className="stl-hint">
              原图 #{source.id} · {source.width}×{source.height} ·{' '}
              {(source.bytes / 1024).toFixed(0)} KB
            </p>
            {latestFailure !== undefined && activeTasks.length === 0 && <p className="ang-error">最近任务失败：{latestFailure.error ?? latestFailure.stage ?? '未知错误'}</p>}
          </aside>
        </div>
      )}

      <section className="ang-gallery">
        <header><div><span>ANGLE ARCHIVE</span><h2>视角历史</h2></div><div>{selecting ? <><span>已选 {selected.size} 张</span><button onClick={() => setSelected(new Set(historyItems.map((item) => item.asset.id)))}>全选已加载</button><button className="danger" disabled={selected.size === 0 || archive.isPending} onClick={() => { if (window.confirm(`把选中的 ${selected.size} 张图片移入归档？`)) archive.mutate([...selected]) }}><Trash2 />移入归档</button><button onClick={() => { setSelecting(false); setSelected(new Set()) }}>取消</button></> : <button disabled={historyItems.length === 0} onClick={() => setSelecting(true)}>批量选择</button>}</div></header>
        {history.isError && <div className="ang-empty"><strong>历史加载失败</strong><button onClick={() => void history.refetch()}>重试</button></div>}
        <div className="ang-grid">
          {activeTasks.map((task) => <div className="ang-card ang-card-loading" key={task.id}><LoaderCircle /><strong>{task.source_context?.angle_engine === 'local' ? 'LOCAL RENDERING' : 'MODELSCOPE RENDERING'}</strong><span>{task.stage ?? '正在排队'} · {Math.round(task.progress)}%</span></div>)}
          {historyItems.map((item) => <button type="button" key={item.asset.id} className={`ang-card${selecting ? ' selecting' : ''}${selected.has(item.asset.id) ? ' selected' : ''}`} onClick={() => selecting ? toggleHistory(item.asset.id) : setPreview(item)} aria-pressed={selecting ? selected.has(item.asset.id) : undefined}><img src={item.asset.url} alt={item.instruction || item.prompt} loading="lazy" /><span className={`ang-badge ${item.engine}`}>{item.engine === 'local' ? <Monitor /> : <Cloud />}{item.engine === 'local' ? 'LOCAL' : 'MODELSCOPE'}</span>{selecting && <i>{selected.has(item.asset.id) && <Check />}</i>}<b>{item.instruction || item.prompt || 'Angle Control'}</b></button>)}
        </div>
        {!history.isPending && !history.isError && activeTasks.length === 0 && historyItems.length === 0 && <div className="ang-empty"><Focus /><strong>还没有视角作品</strong><p>选择图片并调整机位，生成结果会保留命令与来源。</p></div>}
        {history.hasNextPage && <button ref={loadTrigger} className="ang-load" onClick={() => void history.fetchNextPage()} disabled={history.isFetchingNextPage}>{history.isFetchingNextPage ? '读取中…' : '加载更多历史'}</button>}
      </section>

      {picking && <AssetPicker onClose={() => setPicking(false)} onPick={pick} />}
      {preview !== null && <AngleLightbox item={preview} onClose={() => setPreview(null)} />}
    </main>
  )
}
