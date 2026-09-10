import { requestJson } from './http'

/* 生图与视觉资产接口封装（模块 16）。
   生图与工坊保留同一领域错误语义。 */

export class ApiImageError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiImageError'
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return requestJson<T>(`/api${path}`, init, (status, message) => new ApiImageError(status, message))
}

export function jsonBody(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

/* ---- 目录 ---- */

export interface ImageTarget {
  key: string
  label: string
  size: string
  sizes: string[]
  quality: string
  default_style: string
  allow_text: boolean
  aspect_note: string
  applies: boolean
}

export interface StylePreset {
  key: string
  label: string
  hint: string
  builtin: boolean
  /** cover=封面专用（自制） | general/photo/art/concept/game/craft/commerce/misc */
  category: string
  /** 注入提示词 style.render 的描述词，选择器里当预览用 */
  render: string
  avoid: string[]
  tags: string[]
  /** 出处：自制 / 自定义 / 导入的写清楚仓库与许可 */
  source: string
}

export interface StyleCategory {
  key: string
  label: string
  count: number
}

/** 用户自定义画风。内置的只读，这批可增删改 */
export interface CustomStyle {
  key: string
  label: string
  hint: string
  category: string
  render: string
  palette: string
  lighting: string
  texture: string
  avoid: string[]
  builtin: false
  source: string
  updated_at: string | null
}

export interface StyleLibrary {
  styles: StylePreset[]
  categories: StyleCategory[]
  custom: CustomStyle[]
  allowed_categories: string[]
  imported_count: number
}

/** 一个应用格子。后端 `domain/image_apps.py` 的注册表条目（FR-427）。
    前端不硬编码功能格子，全部由这张表驱动——加应用只加数据（BR-114） */
export interface ImageApp {
  key: string
  label: string
  category: string
  /** generate=文生图 | edit=改图 | vision=看图 | local=纯前端处理 */
  engine: 'generate' | 'edit' | 'vision' | 'local'
  target_key: string
  hint: string
  /** prompt | image | images | mask | outpaint */
  inputs: string[]
  /** 锁死的上游参数，用户不可改（如人像锁 input_fidelity=high） */
  fixed: Record<string, string>
  ratio: string | null
  style_key: string | null
  badge: string | null
  needs_image: boolean
  needs_mask: boolean
  costs_money: boolean
  default_style: string
  default_size: string
  sizes: string[]
  quality: string
  aspect_note: string
  applies: boolean
}

export interface ImageCategory {
  key: string
  label: string
  hint: string
  count: number
}

export interface RatioOption {
  key: string
  label: string
  hint: string
  /** 档位 → 请求尺寸 */
  sizes: Record<string, string>
  /** 档位 → 实测返回尺寸。标定过才有；有就以它为准展示（FR-432） */
  measured: Record<string, string>
  /** 档位 → 是否超过上游标注的实验性分辨率（2560×1440）。不拦人，但要标出来 */
  experimental: Record<string, boolean>
  /** 宽/高，画比例预览框用 */
  value: number
}

export interface SizeTier {
  key: string
  label: string
  hint: string
}

export interface SizeCatalog {
  ratios: RatioOption[]
  tiers: SizeTier[]
  step: number
  calibrated: boolean
  /** 标定数据说明换档位到底改不改像素。
      null=还没标定；false=**实测证明档位不起作用，只有比例生效** */
  tiers_effective: boolean | null
}

export interface ImageCatalog {
  targets: ImageTarget[]
  styles: StylePreset[]
  qualities: string[]
  /** 配置中心里的全局默认质量档（CR-005 §3.5，出厂 high）。
      各工具的初始值取它，用户在某处微调不写回全局 */
  default_quality?: string
  capabilities: string[]
  max_n: number
  apps: ImageApp[]
  categories: ImageCategory[]
  sizes: SizeCatalog
  style_categories: StyleCategory[]
  output_formats: string[]
  backgrounds: string[]
}

/* ---- 资产 ---- */

export interface ImageAsset {
  id: number
  /** 用户可改的素材名；null 时界面回落为素材编号。 */
  display_name: string | null
  sha: string
  /** 展示尺寸（宽 768 webp）。URL 自带 /api 前缀与 ?v=，直接放进 <img src> */
  url: string
  thumb_url: string
  full_url: string
  width: number
  height: number
  bytes: number
  mime: string
  target_key: string
  style_key: string | null
  prompt: string
  prompt_structure: Record<string, unknown> | null
  brief: Record<string, unknown> | null
  alias: string | null
  model: string | null
  size_req: string | null
  quality: string | null
  usage: Record<string, unknown> | null
  subject_domain: string | null
  subject_id: number | null
  run_id: number | null
  step: string | null
  source: string
  /** 素材分组（M2 FR-477）。null = 没归组 */
  group_id: number | null
  /** AI 打的中文摘要与标签；tagged_at 为 null 表示还没打过标 */
  caption: string | null
  tags: string[]
  tagged_at: string | null
  /** 编辑链的上一环（FR-435）。null = 这是根图 */
  parent_id: number | null
  /** 产生这一环的应用 key，如 replace_bg */
  op: string | null
  status: 'candidate' | 'applied' | 'archived'
  favorite: boolean
  created_at: string | null
}

export interface AssetPage {
  total: number
  items: ImageAsset[]
}

export interface AssetFilters {
  app?: string
  op?: string
  parent_id?: number
  q?: string
  target?: string
  style?: string
  source?: string
  status?: string
  favorite?: boolean
  subject_domain?: string
  subject_id?: number
  /** 素材分组筛选（M2）。传 0 = 只看没归组的 */
  group_id?: number
  /** 按 AI 标签筛选，命中任一即可 */
  tag?: string
  /** 只看还没打过标的，用来批量补标 */
  untagged?: boolean
  limit?: number
  offset?: number
}

export interface PromptPreview {
  prompt: string
  structure: Record<string, unknown> | null
  brief: Record<string, unknown> | null
  /** 这次真正用的尺寸。比例不指定时由立意挑，前端只能从这里知道结果 */
  size: string
  ratio: string | null
  /** 比例是不是立意挑的（而不是用户钉的） */
  aspect_chosen: boolean
}

export interface JobCreated {
  job_id: string
  image_job_id: number
  studio_task_id: string
  domain: string
}

export interface JobDetail {
  id: number
  studio_task_id: string | null
  target_key: string
  status: string
  error: string | null
  applied_asset_id: number | null
  assets: ImageAsset[]
}

export interface ProbeResult {
  ok: boolean
  kind?: string
  detail?: string
  latency_ms?: number
  model?: string | null
  asset?: ImageAsset
}

export interface ImageStats {
  count: number
  mb: number
  candidates: number
}

/** 编辑链：从根图到当前这张的完整路径 + 直接子节点（FR-435 / BR-117） */
export interface Lineage {
  chain: ImageAsset[]
  children: ImageAsset[]
}

/** 描述词反推的结果（FR-436） */
export interface DescribeResult {
  prompt: string
  zh: string
  tags: string[]
  model: string | null
  latency_ms: number
}

/** 提示词的中文解读（FR-446）。

    出图之前先看懂这段英文到底要画什么。`missing` 是最有价值的一段：把中文意图
    和最终提示词逐条比对，列出「你说了但提示词里没有」的要点——这件事光看英文
    提示词是看不出来的，而它恰恰决定了出来的图为什么不是你想要的那张。 */
export interface PromptExplain {
  summary: string
  points: { label: string; text: string }[]
  missing: string[]
  model: string | null
  latency_ms: number
}

/** 对话改词的一轮（FR-447）。role 只有这两种，系统提示词不进历史 */
export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
  /** assistant 这一轮把提示词改成了什么。没改就是 null */
  prompt?: string | null
}

export interface ChatPromptResult {
  reply: string
  prompt: string | null
  changed: boolean
  model: string | null
  latency_ms: number
}

export interface EditJobCreated {
  studio_task_id: string
}

/** 流式探测结论（FR-433）。supported=false 时前端退回「状态 + 已跑秒数」，
    绝不伪造中间帧（AC-113） */
export interface StreamProbe {
  supported: boolean
  partials: number
  detail: string
  latency_ms: number
}

/** 批量策划拆出来的一条子任务（FR-437） */
export interface BatchTask {
  label: string
  prompt_zh: string
  ratio: string
  tier: string
  n: number
}

function query(filters: AssetFilters): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') params.set(key, String(value))
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

/** 「谁在用这张图」。服务端已经把结论拼成 `summary` 那一句中文，
    前端直接显示就行——自己再拼一遍只会与服务端的判据慢慢分叉。 */
export interface AssetUsage {
  asset_id: number
  display_name: string | null
  status: string
  /** 引用了它的画布。画布节点是 JSON 引用不是外键，删了会留一个加载不出来的空框 */
  canvases: { id: number; title: string; node_count: number; trashed: boolean }[]
  /** 编辑链子代数量（换背景 / 扩图 / 加水印 各算一代） */
  children: number
  child_ids: number[]
  applied_to: { subject_domain: string; subject_id: number; label: string; title: string } | null
  /** 原图 key 被别处占着（如单词本封面直接引用 storage_key），这些文件删资产时会保留 */
  shared_objects: { key: string; held_by: string[] }[]
  references: string[]
  /** 不带 force 能不能删 */
  deletable: boolean
  summary: string
}

export interface AssetDeleteResult {
  asset_id: number
  deleted: boolean
  status: number
  removed_objects?: string[]
  /** 盘上本来就没有的，不算失败 */
  missing_objects?: string[]
  /** 被别处占着所以保留的文件，held_by 是中文标签 */
  kept_objects?: { key: string; held_by: string[] }[]
  /** 真删失败的。storage_clean 只看这一类 */
  failed_objects?: { key: string; error: string }[]
  storage_clean?: boolean
  orphaned_children?: number[]
  orphaned_canvases?: { id: number; title: string; node_count: number; trashed: boolean }[]
  /** deleted=false 时说明为什么 */
  reason?: string
  children?: number
}

export interface AssetBulkDeleteResult {
  deleted: number
  failed: number
  storage_clean: boolean
  /** 顺序与请求的 ids 一致 */
  results: AssetDeleteResult[]
}

export const apiImage = {
  catalog: () => request<ImageCatalog>('/images/catalog'),

  assets: (filters: AssetFilters = {}) => request<AssetPage>(`/images/assets${query(filters)}`),

  asset: (id: number) => request<ImageAsset>(`/images/assets/${id}`),

  patchAsset: (
    id: number,
    patch: { display_name?: string | null; favorite?: boolean; status?: string },
  ) =>
    request<ImageAsset>(`/images/assets/${id}`, jsonBody('PATCH', patch)),

  /** 删之前先问「谁在用它」。画布节点用 JSON 里的 asset_id 引用资产，**不是外键**，
      删掉不会报错，只会在画布上留一个再也加载不出来的空框——所以要先说清楚。 */
  assetUsage: (id: number) => request<AssetUsage>(`/images/assets/${id}/usage`),

  /** 真删：库行 + 存储对象。与 `patchAsset({status:'archived'})` 的软删是两件事，
      归档还能翻出来，这个删完就没了。有编辑链子代时默认拒绝，force 才删。 */
  deleteAsset: (id: number, force = false) =>
    request<AssetDeleteResult>(`/images/assets/${id}${force ? '?force=true' : ''}`, {
      method: 'DELETE',
    }),

  previewDeleteAssets: (ids: number[]) =>
    request<{ items: AssetUsage[] }>('/images/assets/delete-preview', jsonBody('POST', { ids })),
  bulkDeleteAssets: (ids: number[], forceIds: number[] = []) =>
    request<AssetBulkDeleteResult>('/images/assets/bulk-delete', jsonBody('POST', { ids, force_ids: forceIds })),

  applyAsset: (id: number, subjectDomain: string, subjectId: number) =>
    request<ImageAsset>(
      `/images/assets/${id}/apply`,
      jsonBody('POST', { subject_domain: subjectDomain, subject_id: subjectId }),
    ),

  /** 立意 + 写词两步，不出图。出图很贵，先看提示词再决定要不要花这笔钱 */
  previewPrompt: (body: {
    target_key: string
    idea?: string
    style_key?: string | null
    /** 留空 = 不指定比例，由立意按画面内容挑一个 */
    size?: string | null
    tier?: string
    subject_domain?: string | null
    subject_id?: number | null
  }) => request<PromptPreview>('/images/preview-prompt', jsonBody('POST', body)),

  createJob: (body: {
    target_key: string
    idea?: string
    prompt_override?: string
    style_key?: string | null
    /** 留空 = 不指定比例，由立意按画面内容挑一个 */
    size?: string | null
    tier?: string
    quality?: string | null
    n?: number
    alias?: string
    /** 指定真实模型部署；留空时继续跟随 alias 的全局能力绑定 */
    deployment_id?: number | null
    subject_domain?: string | null
    subject_id?: number | null
    /** 高级参数，留空 = 用上游默认 */
    output_format?: string | null
    background?: string | null
    output_compression?: number | null
    moderation?: string | null
    /** ModelScope AIGC 原生参数；普通生图不传。 */
    negative_prompt?: string | null
    seed?: number | null
    steps?: number | null
    guidance?: number | null
    loras?: string | Record<string, number> | null
    ref_asset_ids?: number[]
    /** 统一任务中心回跳上下文 */
    tool_id?: string
    source_route?: string | null
    source_context?: Record<string, unknown> | null
  }) => request<JobCreated>('/images/jobs', jsonBody('POST', body)),

  /** 全部画风：自制 + 导入 + 自定义 */
  styles: () => request<StyleLibrary>('/images/styles'),

  createStyle: (body: Omit<CustomStyle, 'builtin' | 'source' | 'updated_at'>) =>
    request<CustomStyle>('/images/styles', jsonBody('POST', body)),

  updateStyle: (key: string, body: Omit<CustomStyle, 'builtin' | 'source' | 'updated_at'>) =>
    request<CustomStyle>(`/images/styles/${key}`, jsonBody('PATCH', body)),

  /** 删风格不影响已经出过的图：资产行上存的是当初渲染好的完整提示词，不是引用 */
  deleteStyle: (key: string) =>
    request<void>(`/images/styles/${encodeURIComponent(key)}`, { method: 'DELETE' }),

  job: (id: number) => request<JobDetail>(`/images/jobs/${id}`),

  rerun: (id: number, body: { from_step: string; scope?: string; config?: unknown }) =>
    request<{ image_job_id: number }>(`/images/jobs/${id}/rerun`, jsonBody('POST', body)),

  /** 会真的花一次钱，只在用户显式点击时调 */
  test: (alias: string, deploymentId?: number) => request<ProbeResult>('/images/test', jsonBody('POST', { alias, deployment_id: deploymentId })),

  stats: () => request<ImageStats>('/images/stats'),

  edit: (form: FormData) =>
    request<{ items: ImageAsset[] }>('/images/edit', { method: 'POST', body: form }),

  /** 持久化编辑任务：上传输入先落服务端存储，切页后 worker 仍会继续执行 */
  createEditJob: (form: FormData) =>
    request<EditJobCreated>('/images/edit-jobs', { method: 'POST', body: form }),

  /** 编辑链：任一环都能查到从根图到它的完整路径 */
  lineage: (id: number) => request<Lineage>(`/images/assets/${id}/lineage`),

  /** 传图反推提示词。走视觉 LLM，比出图便宜得多 */
  describe: (form: FormData) =>
    request<DescribeResult>('/images/describe', { method: 'POST', body: form }),

  /** 提示词扩写。显式按钮触发，不做自动优化——静默改写会让「改了词没变化」无法归因 */
  enhancePrompt: (body: { text: string; app_key: string; style_key?: string | null }) =>
    request<{ prompt: string; model: string | null }>(
      '/images/enhance-prompt',
      jsonBody('POST', body),
    ),

  /** 把最终英文提示词讲成中文。只调文本模型，不出图 */
  explainPrompt: (body: {
    prompt: string
    app_key: string
    style_key?: string | null
    idea?: string
  }) => request<PromptExplain>('/images/explain-prompt', jsonBody('POST', body)),

  /** 对话式改提示词：用中文说要改什么，拿回改好的英文提示词 */
  chatPrompt: (body: {
    messages: { role: 'user' | 'assistant'; content: string }[]
    prompt: string
    app_key: string
    style_key?: string | null
  }) => request<ChatPromptResult>('/images/chat-prompt', jsonBody('POST', body)),

  /** 探测中转是否透传流式。不透传就老老实实退回旧形态 */
  streamProbe: (alias: string) =>
    request<StreamProbe>('/images/stream-probe', jsonBody('POST', { alias })),

  /** 一句话拆成若干子任务，返回可编辑的方案，此时还没开始出图 */
  planBatch: (body: { idea: string; app_key: string; max_tasks?: number }) =>
    request<{ tasks: BatchTask[] }>('/images/plan-batch', jsonBody('POST', body)),

  /** 批量执行：一次入队多条，返回各自的 image_job_id */
  runBatch: (body: { app_key: string; tasks: BatchTask[]; alias?: string }) =>
    request<{
      batch_id: string
      jobs: { image_job_id: number; studio_task_id: string; label: string }[]
    }>(
      '/images/batch',
      jsonBody('POST', body),
    ),

  /** 纯前端修图的产物回存。source=local（BR-118） */
  saveLocal: (form: FormData) =>
    request<ImageAsset>('/images/local', { method: 'POST', body: form }),

  /** 尺寸档位标定：每档实发一张最低质量图，把实际返回尺寸写回档位表。会真的出图 */
  calibrate: (body: { alias?: string; ratios?: string[] }) =>
    request<{ results: { ratio: string; tier: string; requested: string; actual: string }[] }>(
      '/images/calibrate',
      jsonBody('POST', body),
    ),

  /** 流式出图。**只在探测确认中转透传后才调**；探不通就走 createJob 那条老路。
      用 fetch 读流而不是 EventSource——后者只支持 GET，而出图参数放不进 query。 */
  streamGenerate: async (
    body: {
      prompt: string
      app_key: string
      size: string
      quality?: string
      alias?: string
      partial_images?: number
    },
    on: {
      partial: (p: { index: number; b64: string; size: string | null }) => void
      done: (items: ImageAsset[], latencyMs: number) => void
      error: (detail: string) => void
    },
    signal?: AbortSignal,
  ): Promise<void> => {
    const resp = await fetch('/api/images/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    if (!resp.ok || resp.body === null) {
      let message = `请求失败 (${resp.status})`
      try {
        const parsed = (await resp.json()) as { detail?: unknown }
        if (typeof parsed.detail === 'string') message = parsed.detail
      } catch {
        /* 非 JSON 响应体 */
      }
      on.error(message)
      return
    }
    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // SSE 以空行分帧；最后一段可能不完整，留在 buffer 里等下一轮
      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        const eventLine = frame.split('\n').find((l) => l.startsWith('event: '))
        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '))
        if (dataLine === undefined) continue
        const payload = JSON.parse(dataLine.slice(6)) as Record<string, unknown>
        const kind = eventLine?.slice(7) ?? ''
        if (kind === 'partial') {
          on.partial(payload as unknown as { index: number; b64: string; size: string | null })
        } else if (kind === 'done') {
          on.done(payload.items as ImageAsset[], Number(payload.latency_ms ?? 0))
        } else if (kind === 'error') {
          on.error(String(payload.detail ?? '出图失败'))
        }
      }
    }
  },
}
