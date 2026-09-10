/* 生图控制台（模块 16 FR-428 ~ FR-441）。

   三轮的形态是「应用驱动」：页面自己不认识任何一个功能，全部由后端的应用注册表
   （`domain/image_apps.py`）决定——显示哪些控件看 `app.inputs`，走哪条通路看
   `app.engine`。所以新增一个应用只需在后端加一条记录，这个文件一行都不用改
   （BR-114 / AC-109）。

   四条通路，仅此四条：

   | engine | 提交到 | 调模型 |
   | --- | --- | --- |
   | generate | `/images/jobs`（入队走管线） | 是 |
   | edit | `/images/edit`（多图 + 可选蒙版） | 是 |
   | vision | `/images/describe`（反推提示词，不出图） | 是，很便宜 |
   | local | 前端 Filerobot 改完 `/images/local` 回存 | **否** |

   与二轮的另一处不同：**保留左侧主导航**（FR-428 推翻 FR-421）。生图是常驻工作区，
   出图 → 回词库看效果 → 回来改图的往返频率压过了画布面积。大画布改由查看器的
   全屏审图补，需要它的是「审图」那一刻，不是整个使用过程。

   四轮把参数从「摊在侧栏」改成「设置行 + 弹窗」（FR-443）。摊开的问题不是难看，
   是长不大：画风一百多个、比例要能预览、高级参数还在增加，全塞进 320px 只会越挤越糟。 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'

import { Overlay } from '@/components/Overlay'
import type { ImageAsset, Lineage } from '@/lib/api-image'
import { apiImage } from '@/lib/api-image'
import { normalizeQuality } from '@/lib/image-defaults'
import { runImageEditTask } from '@/lib/image-edit-task'
import { apiPipeline } from '@/lib/api-pipeline'

import type { AdvancedValue } from './AdvancedDialog'
import { AdvancedDialog } from './AdvancedDialog'
import { AppPicker } from './AppPicker'
import { ApplyBar } from './ApplyBar'
import { BatchPlanner } from './BatchPlanner'
import { GalleryRail } from './GalleryRail'
import type { GenPhase } from './GenerationStage'
import { GenerationStage } from './GenerationStage'
import type { MaskResult } from './MaskCanvas'
import { MaskCanvas } from './MaskCanvas'
import type { ConfigDialog } from './ParamPanel'
import { ParamPanel } from './ParamPanel'
import { PromptStudio } from './PromptStudio'
import { RatioDialog } from './RatioDialog'
import { ResultViewer } from './ResultViewer'
import { RetouchStudio } from './RetouchStudio'
import { StreamChip, useStreamSupport } from './StreamChip'
import { StyleStudio } from './StyleStudio'
import type { RefImage } from './consoleStore'
import { NO_STYLE, promptStateOf, useConsoleStore } from './consoleStore'
import './image.css'

/** 管线节点状态 → 生成态步骤条。这几个节点是真的，不是编出来凑数的（BR-110） */
const PHASE_STATE: Record<string, GenPhase['state']> = {
  success: 'done',
  running: 'running',
  failed: 'failed',
  skipped: 'done',
}

const DEFAULT_APP = 'text_to_image'

/** 用途 → 语义能力别名。业务代码只认别名，模型名与密钥住在配置中心（BR-100） */
const ALIAS_BY_TARGET: Record<string, string> = {
  deck_cover: 'image-cover',
  book_cover: 'image-cover',
  talk_scene: 'image-illustration',
  passage_illustration: 'image-illustration',
  word_mnemonic: 'image-illustration',
  ui_illustration: 'image-illustration',
}

export function ImagePage() {
  const params = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const catalog = useQuery({ queryKey: ['img-catalog'], queryFn: apiImage.catalog })
  const stats = useQuery({ queryKey: ['img-stats'], queryFn: apiImage.stats })

  const apps = useMemo(() => catalog.data?.apps ?? [], [catalog.data])
  const appKey = params.appKey ?? DEFAULT_APP
  const app = apps.find((a) => a.key === appKey)

  /* ---- 会话状态放 store，切走页面不丢（FR-444）。
         控制台是常驻工作区，出图 → 回词库看效果 → 回来改图是主路径，而切路由会把
         这个组件卸载掉。写了一半的想法、挑好的画风、刚出的图、正在跑的任务都得留住。 */
  const {
    idea, prompt, promptOrigin, handWritten,
    styleKey, ratio, pickedRatio, tier, advanced, refs, chat, explain,
    results, picked, jobId, startedAt, railOpen, paramsOpen,
    set: setConsole, fillPrompt, typePrompt, addRefs: pushRefs, removeRef: dropRef,
    pushChat, clearChat, onAppChanged,
  } = useConsoleStore()

  // ---- 只属于「这一次停留」的，留在组件里：关掉页面本来就该消失
  const [mask, setMask] = useState<MaskResult | null>(null)
  const [dialog, setDialog] = useState<ConfigDialog | null>(null)
  /* 画风选择器不走 `dialog`：创作台开着的时候还要能在它上面叠一层选画风，
     两层同时在场，选完立刻能看到提示词跟着重写。挤进同一个状态就只能二选一。 */
  const [stylePicker, setStylePicker] = useState(false)
  const [ratioPicker, setRatioPicker] = useState(false)
  const [picking, setPicking] = useState(false)
  const [viewing, setViewing] = useState<ImageAsset | null>(null)
  const [lightbox, setLightbox] = useState<ImageAsset | null>(null)
  const [retouch, setRetouch] = useState<{ src: string; name: string; parent: number | null } | null>(null)
  const [planning, setPlanning] = useState(false)
  // 流式推来的最新一张中间图。它是上游真实像素，不是本地编的进度（BR-110）
  const [partial, setPartial] = useState<{ index: number; b64: string } | null>(null)
  const [streaming, setStreaming] = useState(false)
  const [streamSupport, setStreamSupport] = useStreamSupport()
  const [tick, setTick] = useState(() => Date.now())

  /* 想法一改，上一次立意挑的画幅就不再描述「接下来会发生什么」了。
     留着它，侧栏会理直气壮地写「AI 选了宽屏 16:9」，而下一次出图它可能挑竖屏——
     显示一个不会发生的值，比什么都不显示更糟（STD-UI-006 同一条口径）。 */
  const setIdea = useCallback(
    (v: string) => setConsole({ idea: v, pickedRatio: null }),
    [setConsole],
  )
  const setStyleKey = useCallback((v: string | null) => setConsole({ styleKey: v }), [setConsole])
  const setRatio = useCallback((v: string | null) => setConsole({ ratio: v }), [setConsole])
  const setTier = useCallback((v: string) => setConsole({ tier: v }), [setConsole])
  const setAdvanced = useCallback((v: AdvancedValue) => setConsole({ advanced: v }), [setConsole])
  const setResults = useCallback((v: ImageAsset[]) => setConsole({ results: v }), [setConsole])
  const setPicked = useCallback((v: number | null) => setConsole({ picked: v }), [setConsole])
  const setJobId = useCallback((v: number | null) => setConsole({ jobId: v }), [setConsole])
  const setStartedAt = useCallback((v: number | null) => setConsole({ startedAt: v }), [setConsole])

  const fileInput = useRef<HTMLInputElement>(null)

  // 应用锁定的东西优先于用户选择：人像的高保真、封面的固定画幅都是能不能用的分水岭
  const effectiveRatio = app?.ratio ?? ratio ?? null
  const effectiveStyle = styleKey ?? app?.default_style ?? ''
  const noStyle = effectiveStyle === NO_STYLE
  /** 用户（或应用）钉住比例了吗。没钉就把画幅交给立意按画面内容挑 */
  const autoRatio = effectiveRatio === null
  const effectiveQuality = advanced.quality
  const sizes = catalog.data?.sizes
  /** 提交给后端的尺寸。不指定比例时传 null——**不能回落成应用默认**，
   *  那样立意就没机会挑了，而通用出图的默认往往就是个方块。 */
  const requestSize = useMemo(() => {
    if (effectiveRatio === null) return null
    const row = sizes?.ratios.find((r) => r.key === effectiveRatio)
    return row?.sizes[tier] ?? app?.default_size ?? '1024x1024'
  }, [effectiveRatio, sizes, tier, app])

  /** 界面显示、生成态骨架按它画的尺寸。不指定时用立意最近挑的那个 */
  const effectiveSize = useMemo(() => {
    if (requestSize !== null) return requestSize
    const row = sizes?.ratios.find((r) => r.key === pickedRatio)
    return row?.sizes[tier] ?? app?.default_size ?? '1024x1024'
  }, [requestSize, sizes, pickedRatio, tier, app])

  // 换应用时把不适用的输入收掉：锁了比例就丢掉用户选的比例，不要图的应用丢掉蒙版
  // 换应用时把不适用的输入收掉，但**留住提示词与参考图**（BR-119）
  useEffect(() => {
    setMask(null)
    onAppChanged(appKey, app?.ratio ?? null, normalizeQuality(app?.quality))
  }, [appKey, app?.ratio, app?.quality, onAppChanged])

  const addRefs = useCallback(
    (files: FileList | null) => {
      if (files === null) return
      const next: RefImage[] = Array.from(files)
        .filter((f) => f.type.startsWith('image/'))
        .map((f) => ({
          id: `${f.name}-${f.size}-${f.lastModified}`,
          file: f,
          url: URL.createObjectURL(f),
        }))
      if (next.length === 0) {
        toast.error('选中的不是图片文件')
        return
      }
      pushRefs(next)
    },
    [pushRefs],
  )

  const removeRef = (id: string) => {
    dropRef(id)
    setMask(null)
  }

  /** 把画廊或结果里的一张图拉进来当参考图——编辑链就是这么接起来的 */
  const useAsRef = useCallback(async (asset: ImageAsset) => {
    const resp = await fetch(asset.full_url)
    if (!resp.ok) {
      toast.error('取原图失败，无法作为参考图')
      return
    }
    const blob = await resp.blob()
    const file = new File([blob], `asset-${asset.id}.png`, { type: blob.type || 'image/png' })
    // 换成单张：这条路径是「拿这张图去改」，留着上一批参考图只会混淆
    useConsoleStore.getState().refs.forEach((r) => URL.revokeObjectURL(r.url))
    setConsole({ refs: [{ id: `asset-${asset.id}`, file, url: URL.createObjectURL(file) }] })
  }, [setConsole])

  // ---- 提交 ----

  const preview = useMutation({
    mutationFn: () =>
      apiImage.previewPrompt({
        target_key: app?.target_key ?? 'free',
        idea,
        style_key: effectiveStyle,
        size: requestSize,
        tier,
      }),
    // 记下这份提示词是按哪个画风与尺寸生成的：管线看到 prompt_override 非空就原样
    // 发给模型、画风完全不参与，不记就没法提醒用户「画风改了但提示词没跟上」。
    // 尺寸记后端**真正用的**那个——不指定比例时它是立意挑的，前端事先并不知道
    onSuccess: (d) => {
      fillPrompt(d.prompt, { style: effectiveStyle, size: d.size })
      if (d.ratio !== null) setConsole({ pickedRatio: d.ratio })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const enhance = useMutation({
    mutationFn: () =>
      apiImage.enhancePrompt({
        text: prompt || idea,
        app_key: appKey,
        style_key: effectiveStyle,
      }),
    onSuccess: (d) => {
      fillPrompt(d.prompt, { style: effectiveStyle, size: effectiveSize })
      toast.success('提示词已扩写，可以继续手改')
    },
    onError: (e: Error) => toast.error(e.message),
  })

  /** 把最终英文提示词讲成中文。文本模型，出图之前先看懂会得到什么 */
  const explainMut = useMutation({
    mutationFn: () =>
      apiImage.explainPrompt({
        prompt,
        app_key: appKey,
        style_key: effectiveStyle,
        idea,
      }),
    // 记下这份解读讲的是哪一段提示词：提示词一变解读就作废，
    // 留着比没有更糟——用户会照着一段讲旧提示词的中文去判断该不该出图
    onSuccess: (d) => setConsole({ explain: d, explainOf: prompt }),
    onError: (e: Error) => toast.error(e.message),
  })

  /** 对话式改词：每轮都拿当前提示词当底稿，可以一句一句收敛 */
  const chatMut = useMutation({
    mutationFn: (text: string) =>
      apiImage.chatPrompt({
        messages: [
          ...chat.map((t) => ({ role: t.role, content: t.content })),
          { role: 'user' as const, content: text },
        ],
        prompt,
        app_key: appKey,
        style_key: effectiveStyle,
      }),
    // 先把用户那句摆上去，别让人对着一个空界面等一两秒
    onMutate: (text: string) => pushChat([{ role: 'user', content: text }]),
    onSuccess: (d) => {
      pushChat([{ role: 'assistant', content: d.reply, prompt: d.prompt }])
      if (d.prompt === null) return
      /* 聊出来的提示词算「用户定的」，和手写同一档：它承载着好几轮明确指令，
         再按画风从头重写一遍等于把这些指令全丢掉。所以标成 handWritten，
         同时界面上照实说明画风此时不参与（STD-UI-006）。 */
      setConsole({
        prompt: d.prompt,
        promptOrigin: null,
        handWritten: true,
        explain: null,
        explainOf: '',
      })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const generate = useMutation({
    mutationFn: () =>
      apiImage.createJob({
        target_key: app?.target_key ?? 'free',
        idea,
        /* 只有**手写**的提示词才当覆盖用。
         *
         * 「先看提示词」是预览，不该把参数焊死：提示词一旦当成覆盖发出去，管线就原样
         * 用它、画风完全不参与，于是后来改的画风全都无效——「为什么出的都是柔和扁平
         * 插画」就是这么来的。所以画风变了之后这份预览作废，传空让管线按当前画风重写。 */
        prompt_override: promptState.kind === 'stale' ? '' : prompt,
        style_key: effectiveStyle,
        size: requestSize,
        tier,
        quality: effectiveQuality,
        n: advanced.count,
        alias: ALIAS_BY_TARGET[app?.target_key ?? ''] ?? 'image-free',
        tool_id: 'image-console',
        source_route: `/image/${appKey}`,
        source_context: { app_key: appKey },
      }),
    onSuccess: (d) => {
      setJobId(d.image_job_id)
      setResults([])
      setStartedAt(Date.now())
    },
    onError: (e: Error) => toast.error(e.message),
  })

  /** 流式出图：探测确认透传后才走这条。中途每张部分图都是上游推来的真图 */
  const runStreaming = useCallback(async () => {
    setStreaming(true)
    setPartial(null)
    setResults([])
    setStartedAt(Date.now())
    try {
      await apiImage.streamGenerate(
        {
          prompt: prompt || idea,
          app_key: appKey,
          size: effectiveSize,
          quality: effectiveQuality,
          alias: ALIAS_BY_TARGET[app?.target_key ?? ''] ?? 'image-free',
        },
        {
          partial: (p) => setPartial({ index: p.index, b64: p.b64 }),
          done: (items) => {
            setResults(items)
            setPicked(items[0]?.id ?? null)
            setPartial(null)
            void queryClient.invalidateQueries({ queryKey: ['img-assets'] })
            void queryClient.invalidateQueries({ queryKey: ['img-stats'] })
          },
          error: (detail) => {
            toast.error(detail)
            // 上游这次没透传就把开关落回去，下次别再白等一遍
            if (detail.includes('未透传')) setStreamSupport('off')
          },
        },
      )
    } finally {
      setStreaming(false)
    }
  }, [prompt, idea, appKey, effectiveSize, effectiveQuality, app, queryClient, setStreamSupport])

  const edit = useMutation({
    mutationFn: async () => {
      const form = new FormData()
      form.set('prompt', prompt || idea)
      form.set('app_key', appKey)
      form.set('alias', ALIAS_BY_TARGET[app?.target_key ?? ''] ?? 'image-free')
      form.set('quality', effectiveQuality)
      form.set('n', String(advanced.count))
      if (effectiveRatio !== null) form.set('size', effectiveSize)
      // 扩图把「原图贴在放大画布上」的合成图当底图送上去，透明区即蒙版——
      // 服务端因此零改动（FR-431）
      if (mask?.composite) {
        form.append('images', mask.composite, 'composite.png')
      } else {
        refs.forEach((r) => form.append('images', r.file, r.file.name))
      }
      if (mask?.mask) form.set('mask', mask.mask, 'mask.png')
      const parent = refs[0]?.id.startsWith('asset-') ? refs[0].id.slice(6) : null
      if (parent !== null) form.set('parent_id', parent)
      const items = await runImageEditTask(form, {
        toolId: 'image-console',
        sourceRoute: `/image/${appKey}`,
        sourceContext: { app_key: appKey },
      })
      return { items }
    },
    onSuccess: (d) => {
      setResults(d.items)
      setPicked(d.items[0]?.id ?? null)
      void queryClient.invalidateQueries({ queryKey: ['img-assets'] })
      void queryClient.invalidateQueries({ queryKey: ['img-stats'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const describe = useMutation({
    mutationFn: async () => {
      const first = refs[0]
      if (!first) throw new Error('先选一张图')
      const form = new FormData()
      form.set('image', first.file, first.file.name)
      return apiImage.describe(form)
    },
    onSuccess: (d) => {
      fillPrompt(d.prompt, { style: effectiveStyle, size: effectiveSize })
      setIdea(d.zh)
      toast.success('已反推出提示词，切到别的应用就能拿它出图')
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const job = useQuery({
    queryKey: ['img-job', jobId],
    queryFn: () => apiImage.job(jobId as number),
    enabled: jobId !== null,
    refetchInterval: (q) => {
      const s = q.state.data?.status
      return s === 'done' || s === 'failed' ? false : 2000
    },
    // 不开这个，切走页面轮询就停在「生成中」，回来还是那样（本仓记录过的坑）
    refetchIntervalInBackground: true,
  })

  const finished = job.data?.status === 'done' ? job.data : null
  useEffect(() => {
    if (finished === null) return
    setResults(finished.assets)
    setPicked(useConsoleStore.getState().picked ?? finished.assets[0]?.id ?? null)
    void queryClient.invalidateQueries({ queryKey: ['img-assets'] })
    void queryClient.invalidateQueries({ queryKey: ['img-stats'] })
  }, [finished, queryClient])

  useEffect(() => {
    if (job.data?.status === 'failed' && job.data.error) toast.error(job.data.error)
  }, [job.data?.status, job.data?.error])

  const running =
    generate.isPending ||
    edit.isPending ||
    streaming ||
    (jobId !== null && job.data !== undefined && !['done', 'failed'].includes(job.data.status))

  // 已跑秒数：只在执行中推，闲着不空转
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setTick(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])

  const shown = results.find((a) => a.id === picked) ?? results[0] ?? null

  const lineage = useQuery({
    queryKey: ['img-lineage', viewing?.id],
    queryFn: () => apiImage.lineage(viewing?.id as number),
    enabled: viewing !== null,
  })

  const editApps = useMemo(
    () => apps.filter((a) => a.engine === 'edit' || a.engine === 'local'),
    [apps],
  )

  // ---- 画风库：内置 111 个 + 用户自定义。单独一条查询，改完自定义风格重拉即可
  const styleLib = useQuery({ queryKey: ['img-styles'], queryFn: apiImage.styles })
  const currentStyle = useMemo(
    () => styleLib.data?.styles.find((s) => s.key === effectiveStyle),
    [styleLib.data, effectiveStyle],
  )

  // ---- 出图过程中的真实节点。管线给的是 brief/prompt/render/store/apply 五个节点
  //      各自的状态与耗时，所以步骤条画的是真数据，不是编的百分比（BR-110）
  const track = useQuery({
    queryKey: ['img-track', jobId],
    queryFn: () => apiPipeline.subject('image_gen', jobId as number),
    enabled: jobId !== null && running,
    refetchInterval: 1200,
    refetchIntervalInBackground: true,
  })
  const phases: GenPhase[] = useMemo(() => {
    const steps = track.data?.steps ?? []
    return steps.map((s) => ({
      key: s.name,
      label: s.label || s.name,
      state: PHASE_STATE[s.status] ?? 'pending',
      ms: s.duration_ms ?? undefined,
    }))
  }, [track.data])

  // ---- 侧栏摘要 ----
  // 选了「按用途默认」时 effectiveRatio 是空的，这时按生效尺寸反查是哪一档，
  // 否则实测值与实验性标记都显示不出来——而它们恰恰是这时最该看到的
  const ratioRow = useMemo(() => {
    const rows = sizes?.ratios ?? []
    const hit = rows.find((r) => r.key === (effectiveRatio ?? pickedRatio))
    if (hit) return hit
    return rows.find((r) => Object.values(r.sizes).includes(effectiveSize))
  }, [sizes, effectiveRatio, pickedRatio, effectiveSize])
  // 骨架要按真实出图比例画。选了「按用途默认」时 ratioRow 是空的，
  // 这时从生效尺寸现算，别退化成方块——方块骨架出来一张宽幅图，观感是错的
  const stageRatio = useMemo(() => {
    if (ratioRow) return ratioRow.value
    const [w, h] = effectiveSize.split('x').map(Number)
    return w > 0 && h > 0 ? w / h : 1
  }, [ratioRow, effectiveSize])
  const measured = ratioRow?.measured[tier]
  /* 不指定比例时行上要说清「现在是什么状态」而不是报一个假的当前值：
     还没写过提示词就是「等 AI 挑」，写过了就把它挑的那个显示出来。 */
  const ratioLabel = autoRatio
    ? pickedRatio && ratioRow
      ? `不指定 · AI 选了${ratioRow.label}`
      : '不指定 · AI 按想法挑'
    : `${ratioRow?.label ?? '自定义'} · ${tier.toUpperCase()}`
  const ratioSub = autoRatio
    ? pickedRatio
      ? `照着「${idea.trim().slice(0, 14) || '你的想法'}」挑的，想固定住就自己选一个`
      : '手机整屏挑竖屏、横幅挑宽屏、头像挑正方形——画幅由画什么决定'
    : measured
      ? sizes?.tiers_effective === false
        ? `实测出图 ${measured}——这个网关不认分辨率档，只有比例生效`
        : `实测出图 ${measured}（请求 ${effectiveSize}，上游会自己取整）`
      : `请求 ${effectiveSize}${ratioRow?.experimental[tier] ? ' · 上游标注为实验性分辨率' : ''}`

  /* 提示词覆盖了画风的时候必须说出来。

     管线看到 `prompt_override` 非空就把它**原样**发给模型，风格预设完全不参与。
     于是「先看提示词」按当时的画风生成一份正文之后，再改画风就没有任何效果，
     而侧栏还显示着新画风——出来的图一直是旧画风，用户看不出原因。实测踩过。 */
  const promptState = promptStateOf(
    prompt,
    promptOrigin,
    handWritten,
    effectiveStyle,
    requestSize,
  )
  const staleStyleLabel = useMemo(() => {
    if (promptState.kind !== 'stale') return ''
    return styleLib.data?.styles.find((s) => s.key === promptState.wasStyle)?.label ?? promptState.wasStyle
  }, [promptState, styleLib.data])

  /* 换了画风就把提示词重写掉，不要让用户自己去点那个按钮。

     四轮时这里只弹一条「出图会按当前画风重写」的提醒，重写要用户手动触发。
     那是把系统的账算到用户头上：他改画风的意思本来就是「按这个画风来」，
     还要他理解「提示词是上一次画风的产物、所以现在作废了」这条内部机制。
     文本模型这一步便宜，直接重写就是了。

     两个前提缺一不可：**只重写机器生成的那份**（手写或聊出来的是用户的明确输入，
     不能覆盖），**得有中文想法**（没有原话就无从重写，这时只能照实提醒）。
     `rewroteFor` 记下试过的那一档，失败了也不会在这一档上反复打转。 */
  const rewroteFor = useRef<string | null>(null)
  useEffect(() => {
    if (promptState.kind !== 'stale' || idea.trim() === '' || preview.isPending) return
    const tag = `${effectiveStyle}|${effectiveSize}`
    if (rewroteFor.current === tag) return
    rewroteFor.current = tag
    preview.mutate()
  }, [promptState.kind, idea, effectiveStyle, effectiveSize, preview.isPending, preview.mutate])

  /* 创作台一打开就把提示词读成中文，不用等用户去点。

     「我都看不懂提示词最终的目标」是真实反馈，而看不懂的代价是等半天出一张不对的图。
     解读走文本模型，比出图便宜两个数量级，默认做掉就好。
     `explainedFor` 挡住失败重试打转：解读失败时 explain 仍是 null，
     不记一笔的话这个 effect 会一直重发。 */
  const explainedFor = useRef<string | null>(null)
  useEffect(() => {
    if (dialog !== 'prompt' || prompt.trim() === '') return
    if (explain !== null || explainMut.isPending) return
    if (explainedFor.current === prompt) return
    // 打字的时候别每敲一个字就发一次
    const timer = window.setTimeout(() => {
      explainedFor.current = prompt
      explainMut.mutate()
    }, 700)
    return () => window.clearTimeout(timer)
  }, [dialog, prompt, explain, explainMut.isPending, explainMut.mutate])

  const advancedSummary = `${advanced.quality} · ${advanced.count} 张`
  const advancedChips = useMemo(() => {
    const chips: string[] = []
    if (tier !== '1k') chips.push(tier.toUpperCase())
    if (advanced.quality === 'high') chips.push('high')
    if (advanced.outputFormat) chips.push(advanced.outputFormat)
    if (advanced.background === 'transparent') chips.push('透明底')
    return chips
  }, [tier, advanced])

  const cost = useMemo(
    () => ({
      free: app?.engine === 'local',
      visionOnly: app?.engine === 'vision',
      calls: advanced.count,
      tier,
      quality: advanced.quality,
      hot: tier !== '1k' || advanced.quality === 'high',
    }),
    [app, advanced, tier],
  )

  // ---- 提交分发：四条通路，页面本身不认识具体应用 ----
  const canSubmit = (): string | null => {
    if (app === undefined) return '应用还没加载好'
    if (app.needs_image && refs.length === 0 && mask === null) return '先选一张图'
    if (app.inputs.includes('images') && refs.length < 2) return '这个应用至少要两张图'
    if (app.needs_mask && mask?.mask == null) return '先涂出要改的区域'
    // 扩图靠的是「原图贴在放大画布上」的合成图。画布导出失败（跨域污染、toBlob 返回 null）
    // 时 MaskCanvas 会把结果作废成 null，这时若不拦住，就会拿原图当底图提交——
    // 用户以为在扩图，实际出的是一张没扩的图，还照样等了一轮
    if (app.inputs.includes('outpaint') && mask?.composite == null) {
      return '扩图画布还没准备好，拖一下边框；若提示导出失败请换一张图'
    }
    // 判据看注册表的 inputs，不是硬列引擎：修图与反推都不收提示词，
    // 用引擎名逐个排除的话，以后加一个不要提示词的应用还得回来改这里
    if (app.inputs.includes('prompt') && prompt.trim() === '' && idea.trim() === '') {
      return '写一句话说说要画什么'
    }
    return null
  }

  const submit = () => {
    if (app === undefined) return
    const blocked = canSubmit()
    if (blocked !== null) {
      toast.error(blocked)
      return
    }
    if (app.engine === 'generate') {
      // 探通了就走流式（能看到真实中间图），否则走队列那条老路
      if (streamSupport === 'on' && advanced.count === 1) void runStreaming()
      else generate.mutate()
    }
    else if (app.engine === 'edit') edit.mutate()
    else if (app.engine === 'vision') describe.mutate()
    else if (app.engine === 'local') {
      const first = refs[0]
      if (!first) {
        toast.error('先选一张图')
        return
      }
      setRetouch({
        src: first.url,
        name: first.file.name,
        parent: first.id.startsWith('asset-') ? Number(first.id.slice(6)) : null,
      })
    }
  }

  const saveRetouched = async (blob: Blob) => {
    const form = new FormData()
    form.set('image', blob, 'retouched.png')
    form.set('op', 'retouch')
    if (retouch?.parent != null) form.set('parent_id', String(retouch.parent))
    const asset = await apiImage.saveLocal(form)
    setResults([asset])
    setPicked(asset.id)
    setRetouch(null)
    toast.success('改完的图已存进资产库')
    void queryClient.invalidateQueries({ queryKey: ['img-assets'] })
  }

  if (catalog.isLoading) {
    return (
      <main className="page imgc">
        <div className="imgc-empty" style={{ margin: 'auto' }}>正在读取应用目录…</div>
      </main>
    )
  }
  if (catalog.isError || app === undefined) {
    return (
      <main className="page imgc">
        <div className="imgc-empty" style={{ margin: 'auto' }}>
          <b>{catalog.isError ? '读取应用目录失败' : `没有这个应用：${appKey}`}</b>
          <button className="btn btn-outline" onClick={() => navigate(`/image/${DEFAULT_APP}`)}>
            回到文生图
          </button>
        </div>
      </main>
    )
  }

  const bodyClass = `imgc-body${railOpen ? '' : ' no-rail'}${paramsOpen ? '' : ' no-params'}`

  return (
    <main className="page imgc">
      <header className="imgc-top">
        <button className="imgc-app" onClick={() => setPicking(true)} title="切换应用">
          <b>{app.label}</b>
          <span className="imgc-app-cat">
            {catalog.data?.categories.find((c) => c.key === app.category)?.label ?? app.category}
          </span>
          <span className="imgc-app-caret">▾</span>
        </button>
        <span className="imgc-hint">{app.hint}</span>
        <span className="imgc-spacer" />
        <StreamChip state={streamSupport} onState={setStreamSupport} />
        {stats.data && (
          <span className="imgc-stat">
            {stats.data.count} 张 · {stats.data.mb} MB
          </span>
        )}
      </header>

      <div className={bodyClass}>
        {paramsOpen ? (
          <aside className="imgc-params">
            <ParamPanel
              app={app}
              idea={idea}
              prompt={prompt}
              style={currentStyle}
              ratioLabel={ratioLabel}
              ratioSub={ratioSub}
              advancedSummary={advancedSummary}
              advancedChips={advancedChips}
              noStyle={noStyle}
              autoRatio={autoRatio}
              promptState={promptState}
              staleStyleLabel={staleStyleLabel}
              canRewrite={idea.trim() !== ''}
              regenerating={preview.isPending}
              onRegenPrompt={() => preview.mutate()}
              refs={refs}
              cost={cost}
              running={running}
              onOpen={(which) => {
                if (which === 'style') setStylePicker(true)
                else if (which === 'ratio') setRatioPicker(true)
                else setDialog(which)
              }}
              onAddRefs={() => fileInput.current?.click()}
              onRemoveRef={removeRef}
              onSubmit={submit}
              onPlan={() => setPlanning(true)}
              onCollapse={() => setConsole({ paramsOpen: false })}
            />
          </aside>
        ) : (
          <button className="imgc-cuff" onClick={() => setConsole({ paramsOpen: true })}>参数</button>
        )}

        <section className="imgc-stage">
          <div className="imgc-view">
            {app.needs_mask || app.inputs.includes('outpaint') ? (
              refs[0] ? (
                <MaskCanvas
                  src={refs[0].url}
                  mode={app.inputs.includes('outpaint') ? 'outpaint' : 'paint'}
                  onChange={setMask}
                />
              ) : (
                <div className="imgc-empty">
                  <b>先选一张要改的图</b>
                  左边点「选图」上传，或者从右边画廊里拖一张过来。
                </div>
              )
            ) : running ? (
              <GenerationStage
                phases={phases}
                elapsedMs={startedAt === null ? 0 : Math.max(0, tick - startedAt)}
                partial={partial}
                count={advanced.count}
                ratio={stageRatio}
                error={job.data?.status === 'failed' ? job.data.error : null}
              />
            ) : results.length > 1 ? (
              <div className="imgc-grid">
                {results.map((a) => (
                  <button
                    key={a.id}
                    className={picked === a.id ? 'on' : ''}
                    onClick={() => setPicked(a.id)}
                    onDoubleClick={() => setViewing(a)}
                  >
                    <img src={a.url} alt="" />
                  </button>
                ))}
              </div>
            ) : shown ? (
              <img src={shown.url} alt="" onClick={() => setLightbox(shown)} title="点开看大图" />
            ) : (
              <div className="imgc-empty">
                <b>{app.label}</b>
                {app.hint}
              </div>
            )}
          </div>

          {shown && !running && (
            <div className="imgc-facts">
              <span>{shown.width}×{shown.height}</span>
              <span>{(shown.bytes / 1024 / 1024).toFixed(1)} MB</span>
              {shown.quality && <span>{shown.quality} 档</span>}
              {shown.source === 'local' && <span className="chip">本地修图</span>}
              {shown.status === 'applied' && <span className="chip ok">已应用</span>}
              <span className="imgc-spacer" />
              <button className="btn-ghost-sm" onClick={() => setViewing(shown)}>详情与继续加工</button>
              <ApplyBar asset={shown} />
              <a className="btn-ghost-sm" href={shown.full_url} download={`image-${shown.id}.png`}>
                下载
              </a>
            </div>
          )}


        </section>

        {/* 折叠态由 GalleryRail 自己渲染窄边，这里只管开关状态 */}
        <GalleryRail
          selectedId={shown?.id ?? null}
          onPick={(a) => setViewing(a)}
          apps={apps}
          collapsed={!railOpen}
          onToggleCollapse={() => setConsole({ railOpen: !railOpen })}
        />
      </div>

      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          addRefs(e.target.files)
          e.target.value = ''
        }}
      />

      {picking && (
        <AppPicker
          apps={apps}
          categories={catalog.data?.categories ?? []}
          current={appKey}
          onPick={(key) => {
            setPicking(false)
            navigate(`/image/${key}`)
          }}
          onClose={() => setPicking(false)}
        />
      )}

      {viewing && (
        <ResultViewer
          asset={viewing}
          siblings={results}
          lineage={(lineage.data as Lineage | undefined) ?? null}
          editApps={editApps}
          onPick={setViewing}
          onSendTo={(key, asset) => {
            setViewing(null)
            void useAsRef(asset).then(() => navigate(`/image/${key}`))
          }}
          onRerun={(asset) => {
            setViewing(null)
            // 「再来一张」用的就是这张图当初那份提示词，画风与尺寸也跟着它走，
            // 否则侧栏会显示当前画风、实际出的却是旧画风（提示词覆盖时画风不参与）
            fillPrompt(asset.prompt, {
              style: asset.style_key ?? effectiveStyle,
              size: asset.size_req ?? effectiveSize,
            })
            generate.mutate()
          }}
          onClose={() => setViewing(null)}
        />
      )}

      {lightbox && (
        <Overlay onClose={() => setLightbox(null)} card="imgc-lightbox">
          <img src={lightbox.full_url} alt="" />
        </Overlay>
      )}

      {retouch && (
        <RetouchStudio
          src={retouch.src}
          filename={retouch.name}
          onSave={saveRetouched}
          onClose={() => setRetouch(null)}
        />
      )}

      <PromptStudio
        open={dialog === 'prompt'}
        idea={idea}
        prompt={prompt}
        structure={(preview.data?.structure as Record<string, unknown> | null) ?? null}
        style={currentStyle}
        noStyle={noStyle}
        promptState={promptState}
        staleStyleLabel={staleStyleLabel}
        explain={explain}
        chat={chat}
        busy={{
          preview: preview.isPending,
          enhance: enhance.isPending,
          explain: explainMut.isPending,
          chat: chatMut.isPending,
        }}
        onIdea={setIdea}
        onPrompt={typePrompt}
        onPreview={() => preview.mutate()}
        onEnhance={() => enhance.mutate()}
        onExplain={() => {
          // 手动点的那一下要能盖过自动解读的去重，否则「重新读一遍」点了没反应
          explainedFor.current = prompt
          explainMut.mutate()
        }}
        onChat={(text) => chatMut.mutate(text)}
        onClearChat={clearChat}
        ratioLabel={ratioLabel}
        ratioSub={ratioSub}
        autoRatio={autoRatio}
        ratioLocked={app.ratio}
        onOpenStyle={() => setStylePicker(true)}
        onOpenRatio={() => setRatioPicker(true)}
        onPickNoStyle={() => setStyleKey(NO_STYLE)}
        onPickAutoRatio={() => setRatio(null)}
        onClose={() => setDialog(null)}
      />

      <StyleStudio
        open={stylePicker}
        value={effectiveStyle}
        library={styleLib.data}
        onPick={(key) => {
          setStyleKey(key)
          setStylePicker(false)
        }}
        onChanged={() => {
          void queryClient.invalidateQueries({ queryKey: ['img-styles'] })
          void queryClient.invalidateQueries({ queryKey: ['img-catalog'] })
        }}
        onClose={() => setStylePicker(false)}
      />

      <RatioDialog
        open={ratioPicker}
        ratios={sizes?.ratios ?? []}
        tiers={sizes?.tiers ?? []}
        ratio={effectiveRatio}
        pickedRatio={pickedRatio}
        tier={tier}
        tiersEffective={sizes?.tiers_effective ?? null}
        locked={app.ratio}
        onPick={(nextRatio, nextTier) => {
          setRatio(nextRatio)
          setTier(nextTier)
        }}
        onClose={() => setRatioPicker(false)}
      />

      <AdvancedDialog
        open={dialog === 'advanced'}
        value={advanced}
        qualities={catalog.data?.qualities ?? []}
        outputFormats={catalog.data?.output_formats ?? []}
        backgrounds={catalog.data?.backgrounds ?? []}
        maxN={catalog.data?.max_n ?? 1}
        locked={app.fixed}
        onChange={setAdvanced}
        onClose={() => setDialog(null)}
      />

      {planning && (
        <BatchPlanner
          appKey={appKey}
          apps={apps}
          ratios={sizes?.ratios ?? []}
          tiers={sizes?.tiers ?? []}
          onClose={() => setPlanning(false)}
          onRun={async (tasks) => {
            const out = await apiImage.runBatch({ app_key: appKey, tasks })
            setPlanning(false)
            toast.success(`已下 ${out.jobs.length} 单，去管线里能看到每一条`)
          }}
        />
      )}
    </main>
  )
}
