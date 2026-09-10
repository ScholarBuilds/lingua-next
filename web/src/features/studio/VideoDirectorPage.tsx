import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Clapperboard, Film, KeyRound, LoaderCircle, Play, Sparkles } from '@/components/NexusIcon'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'

import { Picker } from '@/components/ui/picker'
import { apiConfig } from '../../lib/api-config'
import { useWorkspaceText } from '@/lib/workspaceStore'
import type { Credential } from '../../lib/api-config'
import { apiImage } from '../../lib/api-image'
import { apiStudio } from '../../lib/api-studio'
import type {
  CanvasItem,
  CanvasNode,
  StudioMediaAsset,
  StudioTask,
  VideoReferenceInput,
} from '../../lib/api-studio'
import {
  AddCredButton,
  CredCard,
  CredOverlay,
  RecommendedProviderCards,
} from '../settings/credentials'
import { MediaAssetPicker } from './MediaAssetPicker'
import { VIDEO_MULTIFRAME_MAX_REFS, VIDEO_MULTIMODAL_MAX_REFS } from './canvasStore'
import { WorkflowTimelineEditor } from './WorkflowTimelineEditor'
import {
  VIDEO_TIMELINE_MODE,
  VIDEO_TIMELINE_STORAGE_KEY,
  pendingSegments,
  segmentPrompt,
  segmentReferences,
  snapDuration,
  timelineSegments,
  videoResultItem,
  withSegmentResult,
} from './video-timeline'

// 时间线编辑器的样式长在画布那张表里，全部 scv- 前缀，引进来不会串到本页
import './canvas.css'
import './video-director.css'

const TERMINAL = new Set(['succeeded', 'partial', 'failed', 'cancelled'])
/** 分镜逐段轮询：2 秒一轮，最多盯一小时。与画布同一个上限 */
const SEGMENT_POLL_MAX = 1800

/** 时间线编辑器吃的是画布节点。视频页没有画布，就地造一个只用来装时间线的节点 */
const TIMELINE_NODE_BASE: CanvasNode = {
  id: 'video-director-timeline',
  type: 'workflow',
  x: 0,
  y: 0,
  title: 'MiniMax 分镜',
}

function taskVideo(task: StudioTask | undefined): Record<string, unknown> | null {
  const items = task?.result?.items
  if (!Array.isArray(items)) return null
  const item = items.find(
    (value): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null && value.kind === 'video',
  )
  return item ?? null
}

function readStoredTimeline(): CanvasNode {
  if (typeof window === 'undefined') return TIMELINE_NODE_BASE
  try {
    const raw = window.localStorage.getItem(VIDEO_TIMELINE_STORAGE_KEY)
    if (raw === null) return TIMELINE_NODE_BASE
    const parsed = JSON.parse(raw) as CanvasNode['workflow_timeline']
    if (parsed?.kind !== VIDEO_TIMELINE_MODE || !Array.isArray(parsed.segments)) {
      return TIMELINE_NODE_BASE
    }
    return { ...TIMELINE_NODE_BASE, workflow_timeline: parsed }
  } catch {
    // 存坏了就从空白开始，不为一份草稿把整页拖崩
    return TIMELINE_NODE_BASE
  }
}

export function VideoDirectorPage(): JSX.Element {
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const [deploymentId, setDeploymentId] = useState<number | null>(() => {
    const value = Number(searchParams.get('deployment'))
    return Number.isInteger(value) && value > 0 ? value : null
  })
  const [prompt, setPrompt] = useWorkspaceText('studio', 'video-director-prompt')
  const [duration, setDuration] = useState(4)
  const [aspectRatio, setAspectRatio] = useState('16:9')
  const [resolution, setResolution] = useState('720p')
  const [referenceAssetIds, setReferenceAssetIds] = useState<number[]>([])
  const [referenceMode, setReferenceMode] = useState<'first_frame' | 'first_last' | 'multi_frame' | 'multimodal'>('first_frame')
  const [mediaReferences, setMediaReferences] = useState<StudioMediaAsset[]>([])
  const [mediaPickerKind, setMediaPickerKind] = useState<'video' | 'audio' | null>(null)
  const [generateAudio, setGenerateAudio] = useState(false)
  const [watermark, setWatermark] = useState(false)
  const [cameraFixed, setCameraFixed] = useState(false)
  const [taskId, setTaskId] = useState<string | null>(() => searchParams.get('task') || null)
  const [credentialOverlay, setCredentialOverlay] = useState<'closed' | 'add' | Credential>(
    'closed',
  )
  const [credentialPreset, setCredentialPreset] = useState<string | null>(null)
  // 视图挂在 URL 上：分镜编一半刷新、或者把链接发给自己，回来还在时间线里
  const view = searchParams.get('view') === 'timeline' ? 'timeline' : 'single'
  const [timelineNode, setTimelineNode] = useState<CanvasNode>(readStoredTimeline)
  const [running, setRunning] = useState<{ segmentId: string; taskId: string } | null>(null)
  const timelineRef = useRef(timelineNode)
  timelineRef.current = timelineNode

  const credentials = useQuery({
    queryKey: ['cfg-creds', 'video'],
    queryFn: () => apiConfig.credentials('video'),
  })
  const providerTypes = useQuery({
    queryKey: ['cfg-provider-types'],
    queryFn: apiConfig.providerTypes,
    staleTime: 300_000,
  })
  const deployments = useQuery({
    queryKey: ['cfg-model-deployments', 'video'],
    queryFn: () => apiConfig.modelDeployments({ media_type: 'video', enabled: true }),
  })
  const assets = useQuery({
    queryKey: ['video-director-assets'],
    queryFn: () => apiImage.assets(),
  })
  const task = useQuery({
    queryKey: ['studio-task', taskId],
    queryFn: () => apiStudio.task(taskId as string),
    enabled: taskId !== null,
    refetchInterval: (query) =>
      query.state.data !== undefined && TERMINAL.has(query.state.data.status) ? false : 1800,
  })

  const videoDeployments = useMemo(
    () =>
      (deployments.data ?? []).filter(
        (item) =>
          item.enabled &&
          item.media_types.includes('video') &&
          ['openai', 'volcengine', 'jimeng'].includes(item.adapter_type),
      ),
    [deployments.data],
  )
  const selectedDeployment =
    videoDeployments.find((item) => item.id === deploymentId) ?? videoDeployments[0]
  const selectedId = selectedDeployment?.id ?? null
  const isOpenAI = selectedDeployment?.adapter_type === 'openai'
  const isJimeng = selectedDeployment?.adapter_type === 'jimeng'
  const durationOptions = isOpenAI
    ? [4, 8, 12]
    : isJimeng && selectedDeployment?.upstream_model_id === 'seedance1.0fast'
      ? [5, 8, 10]
      : isJimeng && selectedDeployment?.upstream_model_id === 'seedance1.5pro'
        ? [5, 8, 10, 12]
        : [4, 5, 8, 10, 12, 15]
  const resolutionOptions = isOpenAI
    ? [{ value: '720p', label: '720p' }, { value: '1080p', label: '1080p', hint: '高清档' }]
    : isJimeng
      ? [
          { value: '720p', label: '720p' },
          ...(referenceMode === 'multi_frame'
            ? [{ value: '1080p', label: '1080p' }]
            : selectedDeployment?.upstream_model_id === 'seedance2.0_vip'
            ? [{ value: '1080p', label: '1080p' }, { value: '4k', label: '4K' }]
            : []),
        ]
      : [
          { value: '480p', label: '480p' },
          { value: '720p', label: '720p' },
          { value: '1080p', label: '1080p', hint: '高清档' },
        ]
  const safeResolution = resolutionOptions.some((item) => item.value === resolution)
    ? resolution
    : '720p'
  const recentAssets = (assets.data?.items ?? []).slice(0, VIDEO_MULTIFRAME_MAX_REFS)
  const output = taskVideo(task.data)
  const invalidJimengReferences = isJimeng
    && mediaReferences.some((item) => item.kind === 'audio')
    && referenceAssetIds.length === 0
    && !mediaReferences.some((item) => item.kind === 'video')
  const imageReferenceLimit = isOpenAI
    ? 1
    : isJimeng && referenceMode === 'multi_frame' && mediaReferences.length === 0
      ? VIDEO_MULTIFRAME_MAX_REFS
      : VIDEO_MULTIMODAL_MAX_REFS

  const run = useMutation({
    mutationFn: () => {
      if (selectedId === null) throw new Error('先添加视频供应商并同步模型')
      if (prompt.trim() === '') throw new Error('请填写视频提示词')
      const safeDuration = durationOptions.includes(duration) ? duration : durationOptions[0]
      const effectiveMode = isJimeng && mediaReferences.length > 0 ? 'multimodal' : referenceMode
      const imageIds = referenceAssetIds.slice(0, imageReferenceLimit)
      const references: VideoReferenceInput[] = effectiveMode === 'first_last'
        ? imageIds.slice(0, 2).map((asset_id, index) => ({
            asset_id,
            role: index === 0 ? 'first_frame' : 'last_frame',
          }))
        : effectiveMode === 'multimodal' || effectiveMode === 'multi_frame'
          ? imageIds.map((asset_id) => ({ asset_id, role: 'reference_image' }))
          : imageIds.slice(0, 1).map((asset_id) => ({ asset_id, role: 'first_frame' }))
      return apiStudio.runVideo({
        deployment_id: selectedId,
        prompt: prompt.trim(),
        duration: safeDuration,
        aspect_ratio: aspectRatio,
        resolution: safeResolution,
        references,
        media_references: isJimeng
          ? mediaReferences.map((item) => ({ media_asset_id: item.id, kind: item.kind as 'video' | 'audio' }))
          : [],
        options: {
          generate_audio: generateAudio,
          watermark,
          camerafixed: cameraFixed,
          multimodal: isJimeng && effectiveMode === 'multimodal',
        },
        source_route: `/studio/video?deployment=${selectedId}`,
        source_context: {
          references,
          ...(mediaReferences.length === 0
            ? {}
            : { media_references: mediaReferences.map((item) => ({ id: item.id, kind: item.kind })) }),
        },
      })
    },
    onSuccess: (created) => {
      setTaskId(created.id)
      setSearchParams(
        {
          deployment: String(created.deployment_id ?? selectedId),
          task: created.id,
          ...(view === 'timeline' ? { view } : {}),
        },
        { replace: true },
      )
      void queryClient.invalidateQueries({ queryKey: ['studio-tasks'] })
      toast.success('视频任务已进入后台')
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const active = task.data !== undefined && !TERMINAL.has(task.data.status)

  // ---- 分镜时间线（多镜头）----

  const patchTimeline = useCallback((patch: Partial<CanvasNode>) => {
    setTimelineNode((current) => ({ ...current, ...patch }))
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const timeline = timelineNode.workflow_timeline
    if (timeline === undefined) window.localStorage.removeItem(VIDEO_TIMELINE_STORAGE_KEY)
    else window.localStorage.setItem(VIDEO_TIMELINE_STORAGE_KEY, JSON.stringify(timeline))
  }, [timelineNode])

  /** 时间线素材栏认的是画布 item：最近的图 + 已选的视频/音频素材 */
  const timelineMedia = useMemo<CanvasItem[]>(
    () => [
      ...recentAssets.map((asset) => ({
        kind: 'image' as const,
        asset_id: asset.id,
        name: `#${asset.id}`,
      })),
      ...mediaReferences.map((item) => ({
        kind: item.kind as 'video' | 'audio',
        media_asset_id: item.id,
        url: item.url,
        name: item.name,
      })),
    ],
    [recentAssets, mediaReferences],
  )

  /** 单段生成：提示词、长度、参考图取这一段自己的，模型与画幅仍跟表单。
   *  产物写回 `segment.result`，编辑器的导出按钮就能把整条时间线拼成一条片子。 */
  const runSegment = useCallback(
    async (segmentId: string) => {
      const node = timelineRef.current
      const segment = timelineSegments(node).find((item) => item.id === segmentId)
      if (segment === undefined) return
      if (selectedId === null) {
        toast.error('先添加视频供应商并同步模型')
        return
      }
      const text = segmentPrompt(segment, prompt)
      if (text === '') {
        toast.error(`片段「${segmentId}」还没有提示词`)
        return
      }
      const references = segmentReferences(segment, referenceAssetIds, imageReferenceLimit)
      try {
        const created = await apiStudio.runVideo({
          deployment_id: selectedId,
          prompt: text,
          duration: snapDuration(segment.length, durationOptions),
          aspect_ratio: segment.aspect_ratio ?? aspectRatio,
          resolution: safeResolution,
          references,
          media_references: [],
          options: { generate_audio: generateAudio, watermark, camerafixed: cameraFixed },
          source_route: `/studio/video?view=timeline`,
          source_context: { workflow_segment_id: segmentId, references },
        })
        setRunning({ segmentId, taskId: created.id })
        void queryClient.invalidateQueries({ queryKey: ['studio-tasks'] })
        // 任务在服务端跑，关页面也不断；这里只等着把产物贴回这一段。
        // 盯满一小时就撒手，任务本身照跑，去任务中心看
        for (let round = 0; round < SEGMENT_POLL_MAX; round += 1) {
          await new Promise((resolve) => setTimeout(resolve, 2000))
          const latest = await apiStudio.task(created.id)
          if (!TERMINAL.has(latest.status)) continue
          if (latest.status !== 'succeeded') {
            throw new Error(latest.error ?? `片段任务${latest.status}`)
          }
          const item = videoResultItem(latest)
          if (item === null) throw new Error('任务完成了但没有拿到视频产物')
          setTimelineNode((current) => ({
            ...current,
            workflow_timeline: withSegmentResult(current.workflow_timeline, segmentId, item),
          }))
          toast.success('片段已出片，可以继续下一段或导出整条时间线')
          return
        }
        throw new Error('等了一个小时还没落定，去任务中心看这条任务的进度')
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '片段生成失败')
      } finally {
        setRunning(null)
      }
    },
    [
      aspectRatio,
      cameraFixed,
      durationOptions,
      generateAudio,
      imageReferenceLimit,
      prompt,
      queryClient,
      referenceAssetIds,
      safeResolution,
      selectedId,
      watermark,
    ],
  )

  /** 一次跑完还没出片的段。串行是刻意的：并发提交六段，
   *  上游限流先拒的那几条会分散在中间，谁失败了要一条条对着找 */
  const runPending = useCallback(async () => {
    for (const segment of pendingSegments(timelineRef.current)) {
      await runSegment(segment.id)
      if (timelineRef.current.workflow_timeline?.segments
        .find((item) => item.id === segment.id)?.result === undefined) {
        // 这一段没出片就停：后面多半是同一个原因，接着跑只会连着报同一条错
        break
      }
    }
  }, [runSegment])

  const segments = timelineSegments(timelineNode)
  const pending = pendingSegments(timelineNode)
  const selectedSegmentId = timelineNode.workflow_timeline?.selected_id ?? segments[0]?.id
  const videoTypes = (providerTypes.data ?? []).filter(
    (item) => item.kind === 'video' || item.compatible_kinds?.includes('video'),
  )

  return (
    <main className="vdr-page">
      <header className="vdr-hero">
        <div>
          <span>ST-09 · 持久异步视频</span>
          <h1>视频生成与导演</h1>
          <p>
            支持 OpenAI Videos、火山方舟 Seedance 和本机即梦 CLI。提交后可离开页面，
            上游任务 ID、进度与产物都会持久化，worker 重启后继续轮询。
          </p>
        </div>
        <Clapperboard aria-hidden />
      </header>

      <div className="vdr-views" role="group" aria-label="工作模式">
        <button
          type="button"
          className={view === 'single' ? 'is-selected' : ''}
          onClick={() => {
            searchParams.delete('view')
            setSearchParams(searchParams, { replace: true })
          }}
        >
          <Play aria-hidden />单条生成
        </button>
        <button
          type="button"
          className={view === 'timeline' ? 'is-selected' : ''}
          onClick={() => {
            searchParams.set('view', 'timeline')
            setSearchParams(searchParams, { replace: true })
          }}
        >
          <Film aria-hidden />分镜时间线
        </button>
      </div>

      <section className="vdr-credentials">
        <div className="vdr-section-title">
          <KeyRound aria-hidden />
          <div><h2>视频供应商</h2><p>密钥加密保存；刷新时同步上游真实模型名。</p></div>
        </div>
        {(credentials.data ?? []).map((credential) => (
          <CredCard
            key={credential.id}
            cred={credential}
            unitLabel="视频模型"
            refreshLabel="同步模型"
            showTest
            onEdit={() => setCredentialOverlay(credential)}
          />
        ))}
        <RecommendedProviderCards
          types={videoTypes}
          onSelect={(providerType) => {
            setCredentialPreset(providerType)
            setCredentialOverlay('add')
          }}
        />
        <AddCredButton
          text="添加视频供应商"
          onClick={() => {
            setCredentialPreset(null)
            setCredentialOverlay('add')
          }}
        />
      </section>

      <section className="vdr-workspace">
        <div className="vdr-form">
          <div className="vdr-section-title">
            <Sparkles aria-hidden />
            <div><h2>生成参数</h2><p>支持文生、首帧、首尾帧、多帧转场与即梦全能参考。</p></div>
          </div>
          <label>
            真实模型
            <Picker
              size="sm"
              value={selectedId === null ? '' : String(selectedId)}
              placeholder="没有可用视频模型"
              onChange={(v) => {
                const id = Number(v)
                setDeploymentId(id)
                setTaskId(null)
                setSearchParams({ deployment: String(id) }, { replace: true })
              }}
              options={videoDeployments.map((item) => ({
                value: String(item.id),
                label: item.upstream_model_id,
                hint: item.credential_name ?? item.provider_type ?? undefined,
              }))}
            />
          </label>
          {selectedId === null && (
            <p className="vdr-error">添加供应商后点“同步模型”，或在模型实验台手动登记视频模型。</p>
          )}
          <label>
            画面描述
            <textarea
              value={prompt}
              maxLength={4000}
              placeholder="一只纸船在月光下的湖面上缓慢前行，电影长镜头……"
              onChange={(event) => setPrompt(event.target.value)}
            />
            <small>{prompt.length} / 4000</small>
          </label>
          <div className="vdr-parameter-grid">
            <label>
              时长
              <Picker
                size="sm"
                value={String(durationOptions.includes(duration) ? duration : durationOptions[0])}
                onChange={(v) => setDuration(Number(v))}
                options={durationOptions.map((v) => ({ value: String(v), label: `${v} 秒` }))}
              />
            </label>
            <label>
              画幅
              <Picker
                size="sm"
                value={aspectRatio}
                onChange={setAspectRatio}
                options={[
                  { value: '16:9', label: '16:9', hint: '横屏' },
                  { value: '9:16', label: '9:16', hint: '竖屏' },
                  ...(!isOpenAI
                    ? [
                        { value: '1:1', label: '1:1', hint: '方形' },
                        { value: '4:3', label: '4:3' },
                        { value: '3:4', label: '3:4' },
                        { value: '21:9', label: '21:9' },
                      ]
                    : []),
                ]}
              />
            </label>
            <label>
              清晰度
              <Picker
                size="sm"
                value={safeResolution}
                onChange={setResolution}
                options={resolutionOptions}
              />
            </label>
          </div>

          <fieldset className="vdr-assets">
            <legend>参考图（最多 {imageReferenceLimit} 张）</legend>
            <button
              type="button"
              className={referenceAssetIds.length === 0 ? 'is-selected' : ''}
              onClick={() => setReferenceAssetIds([])}
            >
              纯文生视频
            </button>
            {recentAssets.map((asset) => (
              <button
                type="button"
                className={referenceAssetIds.includes(asset.id) ? 'is-selected' : ''}
                key={asset.id}
                title={`资产 #${asset.id}`}
                onClick={() => setReferenceAssetIds((current) => {
                  if (current.includes(asset.id)) return current.filter((id) => id !== asset.id)
                  return [...current, asset.id].slice(0, imageReferenceLimit)
                })}
              >
                <img src={asset.thumb_url} alt="" />
                <span>#{asset.id}</span>
              </button>
            ))}
          </fieldset>

          {!isOpenAI && referenceAssetIds.length > 0 && (
            <label>
              参考方式
              <Picker
                size="sm"
                value={referenceMode}
                onChange={(value) => {
                  const next = value as typeof referenceMode
                  setReferenceMode(next)
                  setReferenceAssetIds((current) => current.slice(
                    0,
                    isJimeng && next === 'multi_frame'
                      ? VIDEO_MULTIFRAME_MAX_REFS
                      : VIDEO_MULTIMODAL_MAX_REFS,
                  ))
                }}
                options={[
                  { value: 'first_frame', label: '首帧' },
                  { value: 'first_last', label: '首尾帧' },
                  ...(isJimeng ? [{ value: 'multi_frame', label: '多帧转场' }] : []),
                  { value: 'multimodal', label: isJimeng ? '全能参考' : '多参考' },
                ]}
              />
            </label>
          )}

          {isJimeng && (
            <fieldset className="vdr-media-references">
              <legend>即梦全能参考（各最多 3 个）</legend>
              <div className="vdr-media-actions">
                <button type="button" className="btn btn-soft" onClick={() => setMediaPickerKind('video')}>添加视频</button>
                <button type="button" className="btn btn-soft" onClick={() => setMediaPickerKind('audio')}>添加音频</button>
              </div>
              <div className="vdr-media-chips">
                {mediaReferences.map((item) => (
                  <button
                    type="button"
                    key={`${item.kind}-${item.id}`}
                    title={`移除 ${item.name}`}
                    onClick={() => setMediaReferences((current) => current.filter((value) => value.id !== item.id))}
                  >
                    <span>{item.kind === 'video' ? '视频' : '音频'}</span>{item.name}<b>×</b>
                  </button>
                ))}
              </div>
              {mediaReferences.some((item) => item.kind === 'audio')
                && referenceAssetIds.length === 0
                && !mediaReferences.some((item) => item.kind === 'video') && (
                  <small className="vdr-error">音频不能单独生成视频，请再选一张图片或一个视频。</small>
                )}
            </fieldset>
          )}

          {selectedDeployment?.adapter_type === 'volcengine' && (
            <div className="vdr-checks">
              <label><input type="checkbox" checked={generateAudio} onChange={(e) => setGenerateAudio(e.target.checked)} />生成音频</label>
              <label><input type="checkbox" checked={cameraFixed} onChange={(e) => setCameraFixed(e.target.checked)} />固定机位</label>
              <label><input type="checkbox" checked={watermark} onChange={(e) => setWatermark(e.target.checked)} />水印</label>
            </div>
          )}
          <button
            className="btn btn-primary vdr-run"
            disabled={selectedId === null || prompt.trim() === '' || invalidJimengReferences || run.isPending || active}
            onClick={() => run.mutate()}
          >
            {run.isPending ? <LoaderCircle aria-hidden /> : <Play aria-hidden />}
            {run.isPending ? '正在入队…' : active ? '任务正在运行' : '生成视频'}
          </button>
        </div>

        <aside className="vdr-result">
          <h2>运行结果</h2>
          {task.data === undefined ? (
            <div className="vdr-placeholder"><Clapperboard aria-hidden /><p>生成后在这里查看。关闭页面不会中断任务。</p></div>
          ) : (
            <>
              <div className={`vdr-task is-${task.data.status}`}>
                {active && <LoaderCircle aria-hidden />}
                <div>
                  <strong>{task.data.status} · {task.data.stage ?? '等待执行'}</strong>
                  <span>{Math.round(task.data.progress)}%</span>
                  {task.data.provider_task_id && <code>{task.data.provider_task_id}</code>}
                  {task.data.error && <p>{task.data.error}</p>}
                </div>
              </div>
              {typeof output?.url === 'string' && (
                <div className="vdr-video">
                  <video src={output.url} controls playsInline />
                  <a className="btn btn-soft" href={output.url} download>下载视频</a>
                </div>
              )}
            </>
          )}
        </aside>
      </section>

      {view === 'timeline' && (
        <section className="vdr-timeline">
          <div className="vdr-section-title">
            <Film aria-hidden />
            <div>
              <h2>分镜时间线</h2>
              <p>
                每段自己的提示词、时长与参考图各跑一次视频任务；
                模型、清晰度与音频开关跟上面的表单走。全部出片后可导出成一条片子。
              </p>
            </div>
          </div>
          <WorkflowTimelineEditor
            mode={VIDEO_TIMELINE_MODE}
            node={timelineNode}
            refs={referenceAssetIds}
            mediaRefs={timelineMedia}
            linkedPrompt={prompt}
            // 视频页没有画布那套撤销栈，快照点是空操作
            onSnapshot={() => undefined}
            onPatch={patchTimeline}
          />
          <div className="vdr-shots">
            <span>
              {segments.length} 段 · 待出片 {pending.length} 段
              {running !== null && ` · 正在跑「${running.segmentId}」`}
            </span>
            <button
              type="button"
              className="btn btn-soft"
              disabled={selectedSegmentId === undefined || running !== null || selectedId === null}
              onClick={() => {
                if (selectedSegmentId !== undefined) void runSegment(selectedSegmentId)
              }}
            >
              {running !== null ? <LoaderCircle aria-hidden /> : <Play aria-hidden />}
              生成选中片段
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={pending.length === 0 || running !== null || selectedId === null}
              onClick={() => void runPending()}
            >
              生成全部待出片（{pending.length}）
            </button>
          </div>
        </section>
      )}

      {credentialOverlay !== 'closed' && (
        <CredOverlay
          kind="video"
          types={videoTypes}
          existing={credentialOverlay === 'add' ? undefined : credentialOverlay}
          initialProviderType={
            credentialOverlay === 'add' ? credentialPreset ?? undefined : undefined
          }
          onClose={() => {
            setCredentialOverlay('closed')
            setCredentialPreset(null)
          }}
        />
      )}
      {mediaPickerKind !== null && (
        <MediaAssetPicker
          kind={mediaPickerKind}
          onClose={() => setMediaPickerKind(null)}
          onPick={(asset) => setMediaReferences((current) => {
            if (current.some((item) => item.id === asset.id)) return current
            const sameKind = current.filter((item) => item.kind === asset.kind)
            if (sameKind.length >= 3) {
              toast.error(`即梦全能参考最多 3 个${asset.kind === 'video' ? '视频' : '音频'}`)
              return current
            }
            setReferenceMode('multimodal')
            setReferenceAssetIds((items) => items.slice(0, VIDEO_MULTIMODAL_MAX_REFS))
            return [...current, asset]
          })}
        />
      )}
    </main>
  )
}

export default VideoDirectorPage
