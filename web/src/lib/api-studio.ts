/* 创作工坊的 API 客户端（模块 17 M1）。

   工坊后端只做**编排与持久化**（BR-141）：画布与对话会话两张 JSONB 表。
   出图本身全部走 api-image 的既有端点——资产、血缘、用量因此自动归一（BR-140）。 */

import { ApiImageError, request, jsonBody } from './api-image'

/* ==================== 画布 ==================== */

/** 画布上的一张图（或一段媒体）。已入库的用 asset_id 引用，外部的才落 url */
export interface CanvasItem {
  asset_id?: number
  media_asset_id?: number
  url?: string
  poster_url?: string | null
  kind: 'image' | 'video' | 'audio' | 'file'
  name?: string
  mime?: string
  duration_ms?: number | null
  w?: number
  h?: number
  /** 套模板时库里找不到这张图。画成空位，别当坏图（BR-110 不伪造） */
  missing?: boolean
}

/** 输入框「出几张」。
 *  one = 就一张；fixed = 用 `n`；auto = 由 AI 从提示词判断（走成套方案）。
 *  缺省（旧画布）时按 `n` 反推，见 `canvas-composer.genModeOf`。 */
export type CanvasCountMode = 'one' | 'fixed' | 'auto'

/** 输入框「怎么跑」。
 *  parallel = 同时发 N 个请求、各自成败；serial = 逐张跑，后一张把前一张的产物
 *  当参考（一致性的来源）。缺省 parallel。 */
export type CanvasRunMode = 'parallel' | 'serial'

/** 节点的生成参数快照。空字段 = 用画布默认 */
export interface CanvasRunSettings {
  alias?: string
  /** 节点级真实模型；null/缺省 = 跟随 image-free 全局绑定 */
  deployment_id?: number | null
  style_key?: string | null
  /** null/缺省 = 不指定，由立意挑（与控制台同口径） */
  size?: string | null
  quality?: string
  n?: number
  /** 缺省时按 `n` 反推，旧画布不需要迁移 */
  count_mode?: CanvasCountMode
  run_mode?: CanvasRunMode
  /** 即梦 CLI 节点工具条的原生超分辨率。 */
  upscale_resolution?: '2k' | '4k' | '8k'
}

export interface CanvasVideoRunSettings {
  deployment_id?: number | null
  /** 从 Infinite-Canvas 导入时保留，用来自动匹配本机部署。 */
  model_hint?: string
  provider_hint?: string
  duration?: number
  aspect_ratio?: string
  resolution?: string
  generate_audio?: boolean
  fixed_camera?: boolean
  watermark?: boolean
  seed?: number
  reference_mode?: 'first_frame' | 'first_last' | 'multi_frame' | 'multimodal'
  /** 源项目参数原样保留；目前 OpenAI/火山直连协议不接收这两项。 */
  enhance_prompt?: boolean
  enable_upsample?: boolean
}

export interface VideoReferenceInput {
  asset_id: number
  role: 'first_frame' | 'last_frame' | 'reference_image'
}

export interface VideoMediaReferenceInput {
  media_asset_id: number
  kind: 'video' | 'audio'
}

/** 工作流节点中可保存、可导入的分镜片段。LTX 以帧计时，MiniMax 以秒计时。 */
export interface CanvasWorkflowSegment {
  id: string
  start: number
  length: number
  prompt: string
  type: 'text' | 'image'
  asset_id?: number
  guideStrength?: number
  aspect_ratio?: string
  megapixels?: number
  seed?: number
  /** MiniMax H3 每个片段自己的多模态参考轨。 */
  references?: CanvasItem[]
  result?: CanvasItem
  trim_in?: number
  trim_out?: number
}

/** LTX Director 的独立音频轨片段，长度与裁剪量均以帧计。 */
export interface CanvasWorkflowAudioSegment {
  id: string
  start: number
  length: number
  trim_start: number
  audio_duration_frames?: number
  media_asset_id?: number
  name?: string
  url?: string
  missing?: boolean
}

export interface CanvasWorkflowTimeline {
  kind: 'ltx' | 'minimax'
  segments: CanvasWorkflowSegment[]
  selected_id?: string
  /** MiniMax 以秒、LTX 以帧保存播放头；编辑器 UI 状态随画布文档恢复。 */
  playhead?: number
  timeline_zoom?: number
  image_track_height?: number
  audio_track_height?: number
  display_mode?: 'seconds' | 'frames'
  loop?: boolean
  preview_height?: number
  asset_pane_width?: number
  video_track_height?: number
  reference_track_height?: number
  frame_rate?: number
  duration_frames?: number
  audio_segments?: CanvasWorkflowAudioSegment[]
  selected_audio_id?: string
  selected_track?: 'image' | 'audio'
}

export interface CanvasNode {
  id: string
  type:
    | 'image'
    | 'video'
    | 'audio'
    | 'file'
    | 'workflow'
    | 'prompt'
    | 'llm'
    | 'modelscope'
    | 'midjourney'
    | 'output'
    | 'loop'
    | 'group'
  x: number
  y: number
  w?: number
  h?: number
  title?: string
  /** image 节点：图列表（多图网格） */
  items?: CanvasItem[]
  /** image 节点：提示词草稿。正文里 @ 引用的位置写成「图N」 */
  prompt_draft?: string
  /** 草稿的富文本形态（含 @ token）。只有它能把 token 原样还原回编辑框 */
  prompt_draft_html?: string
  /** 草稿里 @ 引用了哪些图。它们既进提示词的映射表，也真作为参考图发上去 */
  prompt_draft_refs?: { asset_id: number; label: string }[]
  /** 从底部参考条手动加入的图片。与上游连线、正文 @ 引用分开保存，可独立删除和排序。 */
  manual_references?: CanvasItem[]
  run_settings?: CanvasRunSettings
  /** video 节点：独立于图片参数的真实视频调用快照 */
  video_settings?: CanvasVideoRunSettings
  /** workflow 节点：目录定义、参数与凭据选择。 */
  workflow_id?: number
  workflow_provider?: 'comfyui' | 'runninghub'
  workflow_kind?: string
  workflow_values?: Record<string, unknown>
  /** MiniMax 分镜 / LTX 时间轴，随画布一起持久化和导入导出。 */
  workflow_timeline?: CanvasWorkflowTimeline
  workflow_credential_id?: number | null
  workflow_use_wallet?: boolean
  /** RunningHub AI 应用的实例规格：空值/未设为 24G，plus 为 48G。 */
  workflow_instance_type?: '' | 'plus'
  /** RunningHub 数字字段的逐项随机开关；缺省沿用目录字段的 random_enabled。 */
  workflow_random_fields?: Record<string, boolean>
  workflow_has_thumbnail?: boolean
  completed_task_ids?: string[]
  /** prompt 节点：正文 */
  text?: string
  /** LLM 节点：单次处理 / 持久对话两种交互。 */
  llm_mode?: 'node' | 'chat'
  /** null = 跟随全局 chat-general 能力绑定。 */
  llm_deployment_id?: number | null
  llm_system_enabled?: boolean
  llm_system_prompt?: string
  llm_input?: string
  llm_output?: string
  /** LLM 节点模式的输入/输出分栏高度；拖动中线后随画布持久化。 */
  llm_input_height?: number
  llm_output_height?: number
  llm_chat_input?: string
  llm_messages?: { role: 'user' | 'assistant'; content: string }[]
  llm_temperature?: number
  /** ModelScope 专用生成节点：选中的真实部署与原生参数。 */
  ms_deployment_id?: number | null
  /** 从 Infinite-Canvas 导入时保留的上游模型 ID，用来自动匹配本地部署。 */
  ms_model_hint?: string
  ms_size?: string
  ms_count?: number
  ms_negative_prompt?: string
  ms_seed?: number | null
  ms_steps?: number | null
  ms_guidance?: number | null
  ms_lora_enabled?: boolean
  ms_lora_id?: string
  ms_lora_strength?: number
  /** APIMart Midjourney 专用异步节点。上游 task id 随画布持久化。 */
  mj_deployment_id?: number | null
  mj_provider_hint?: string
  mj_mode?: 'imagine' | 'blend' | 'edit'
  mj_size?: string
  mj_version?: '8.2' | '8.1' | '7' | '6.1' | '5.2' | '5.1'
  mj_speed?: 'relax' | 'fast' | 'turbo'
  mj_last_task_id?: string
  mj_last_action?: string
  mj_last_task_status?: string
  mj_last_image_count?: number
  mj_last_prompt?: string
  mj_last_buttons?: { custom_id: string; label: string }[]
  mj_modal_task_id?: string
  mj_modal_prompt?: string
  mj_mask_asset_id?: number | null
  /** 画布级联失败投影：保留失败节点和可从此继续的下游顺序。 */
  cascade_status?: 'queued' | 'running' | 'done' | 'failed' | 'stopped'
  cascade_error?: string
  cascade_failed_round?: number
  cascade_total?: number
  cascade_loop_id?: string | null
  cascade_retry_order?: string[]
  cascade_retry_ref_ids?: number[]
  cascade_retry_media_refs?: CanvasItem[]
  /** 服务端级联失败快照；续跑时复用已成功 checkpoint。 */
  cascade_run_id?: string
  cascade_failed_flow_node_id?: string
  /** 历史分组节点：归档的是哪个节点的旧图 */
  history_for?: string

  /* ---- loop 节点（FR-464 · CR-005 §3.3）：级联执行的轮次控制 ---- */
  /** 跑几轮。不设产品上限，只有防手滑的物理上限 LOOP_MAX */
  count?: number
  /** 循环（串行，一轮喂下一轮，出一致性）/ 并发（同时跑，出多样性） */
  mode?: 'serial' | 'parallel'
  /** 起始计数。《计数》从这个数开始，图片切片也从这一张开始 */
  loop_start?: number
  /** 并发模式的池子大小。不填走全局默认（蓝本硬编码 6，这里做成可配） */
  parallel_limit?: number
  /** 每轮取一条拼进提示词，支持占位符《计数》《总数》《进度》 */
  variable_prompts?: string[]
  /** 开启图片切片：每轮从上游图片列表里取 image_batch_size 张 */
  image_input?: boolean
  /** 图片切片模式下每轮取几张上游图 */
  image_batch_size?: number

  /* ---- group 节点（FR-461）：画布中的画布 ---- */
  /** 组内的提示词/循环成员节点 id */
  member_ids?: string[]
}

/** 连线三语义（FR-462）。缺省按 flow 读 */
export interface CanvasConnection {
  from: string
  to: string
  kind?: 'input' | 'flow' | 'history'
}

export interface CanvasViewport {
  x: number
  y: number
  scale: number
}

export interface CanvasSummary {
  id: number
  title: string
  icon: string
  kind: 'classic' | 'smart'
  owner: string
  color: string
  pinned: boolean
  project: string
  board_x: number | null
  board_y: number | null
  node_count: number
  /** 列表卡片的封面：画布里最新一张图 */
  thumb_asset_id: number | null
  created_at: string
  updated_at: string
}

export interface CanvasDetail {
  id: number
  title: string
  icon: string
  kind: 'classic' | 'smart'
  owner: string
  color: string
  pinned: boolean
  project: string
  board_x: number | null
  board_y: number | null
  nodes: CanvasNode[]
  connections: CanvasConnection[]
  viewport: CanvasViewport | null
  /** 服务端记的删除：{节点 id: 删除生效的版本}。合并时用它区分
      「另一个标签页新建的」与「别人刚删掉的」——这两件事在客户端看来一模一样 */
  deleted_nodes?: Record<string, number>
  settings: Record<string, unknown>
  /** 乐观锁：内容每存一次 +1，PUT 带 base_version，不匹配返回 409 + 最新全量 */
  version: number
  updated_at: string
}

export interface StudioProject {
  id: string
  name: string
  order: number
  canvas_count: number
  created_at: string
  updated_at: string
}

export interface CanvasSavePayload {
  nodes: CanvasNode[]
  connections: CanvasConnection[]
  viewport: CanvasViewport
  settings?: Record<string, unknown>
  base_version: number
}

/** 409 时响应体里带最新全量，前端按 BR-145 合并后重存 */
export interface CanvasConflict {
  detail: string
  canvas: CanvasDetail
}

export interface CanvasAssetCategory {
  id: 'all' | 'smart' | 'classic'
  name: string
  count: number
  canvas_count: number
}

export interface CanvasAssetCanvas extends CanvasSummary {
  asset_count: number
}

export interface CanvasAssetItem {
  id: string
  asset_type: 'image' | 'media' | 'external'
  asset_id: number | null
  url: string
  name: string
  kind: 'image' | 'video' | 'audio' | 'file'
  missing: boolean
  canvas_id: number
  canvas_title: string
  canvas_kind: 'smart' | 'classic'
  canvas_icon: string
  canvas_owner: string
  canvas_color: string
  canvas_updated_at: string
  node_id: string
  node_title: string
  node_type: string
  source_path: string
}

export interface CanvasAssetIndex {
  categories: CanvasAssetCategory[]
  canvases: CanvasAssetCanvas[]
  items: CanvasAssetItem[]
}

export interface CanvasWorkflowImportResult {
  nodes: CanvasNode[]
  connections: CanvasConnection[]
  reused: number
  rebuilt: number
  missing: string[]
}

async function requestDownload(path: string, body: unknown): Promise<{ blob: Blob; filename: string }> {
  let response: Response
  try {
    response = await fetch(`/api${path}`, jsonBody('POST', body))
  } catch {
    throw new ApiImageError(0, '网络连接失败')
  }
  if (!response.ok) {
    let message = `请求失败 (${response.status})`
    try {
      const payload = (await response.json()) as { detail?: unknown }
      if (typeof payload.detail === 'string') message = payload.detail
    } catch {
      /* 非 JSON 错误响应，保留状态码 */
    }
    throw new ApiImageError(response.status, message)
  }
  const disposition = response.headers.get('content-disposition') ?? ''
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  const filename = encoded === undefined ? 'canvas-workflow' : decodeURIComponent(encoded)
  return { blob: await response.blob(), filename }
}

/* ==================== 统一多媒体资产 ==================== */

/** 附件预览。`kind` 决定前端怎么渲染 */
export interface MediaPreview {
  kind: 'markdown' | 'text' | 'table' | 'binary'
  name?: string
  text?: string
  rows?: string[][]
  sheet?: string
}

export interface StudioMediaAsset {
  id: number
  kind: 'video' | 'audio' | 'file'
  name: string
  mime: string
  bytes: number
  width: number | null
  height: number | null
  duration_ms: number | null
  source_task_id: string | null
  source_url: string | null
  details: Record<string, unknown> | null
  parent_id: number | null
  group_id: number | null
  status: string
  favorite: boolean
  url: string
  poster_url: string | null
  created_at: string | null
}

/* ==================== 对话生图 ==================== */

export interface ChatImageTurn {
  role: 'user' | 'assistant'
  /** user：这一轮说的话 */
  text?: string
  /** user：这一轮带的参考（资产 id） */
  ref_asset_ids?: number[]
  /** assistant：这一轮产出的图 */
  asset_ids?: number[]
  /** assistant：失败时的原因，原样展示 */
  error?: string
  /** assistant：真实耗时 */
  latency_ms?: number
  at?: string
}

export interface ChatSummary {
  id: number
  title: string
  pinned: boolean
  turn_count: number
  /** 列表卡片封面：最后一张产图 */
  last_asset_id: number | null
  updated_at: string
}

export interface ChatDetail {
  id: number
  title: string
  pinned: boolean
  turns: ChatImageTurn[]
  version: number
  updated_at: string
}


/* ==================== 素材分组与打标（M2 · FR-477） ==================== */

/** 素材分组。两级：parent_id 为 null 的是「库」，有值的是库下的文件夹。
 *
 *  与蓝本最大的不同：这里的分组只是**给同一份资产贴归属**，不复制文件。
 *  所以删组绝不删图——图是模块 16 的资产，工坊没有处置权（BR-140）。 */
export interface AssetGroup {
  id: number
  name: string
  parent_id: number | null
  /** 直接挂在这个组下的资产数（不含子组） */
  count: number
}

export interface SharedFolder {
  id: number
  name: string
  rel_path: string
  path: string
  exists: boolean
  created_at: string | null
}

export interface SharedFolderItem {
  id: string
  name: string
  url: string
  kind: 'image' | 'video' | 'audio' | 'file'
  size: number
  last_modified: number
  relative_path: string
  folder_id: number
}

export interface SharedFolderNode {
  id: string
  name: string
  path: string
  items: SharedFolderItem[]
  children: SharedFolderNode[]
}

export interface SharedFolderTree {
  folder: SharedFolder
  tree: SharedFolderNode
}

export interface SharedFolderImportResult {
  items: Array<{
    path: string
    asset_type: 'image' | 'media'
    id: number
    kind: 'image' | 'video' | 'audio' | 'file'
  }>
  failed: Array<{ path: string; reason: string }>
}

/** 一次 AI 打标的结果。失败不阻断入库，所以 caption 可能为空 */
export interface AssetTagResult {
  asset_id: number
  caption: string
  tags: string[]
  error?: string
}

/** URL 批量导入的逐条结果。失败的照实回报，不静默吞 */
export interface ImportUrlResult {
  url: string
  ok: boolean
  asset_id?: number
  /** 失败原因原文 */
  reason?: string
}

/** 细节增强的强度档。提示词由服务端拥有——它是提示词工程产物，
 *  和画风预设同一性质，放前端就没法版本化也没法测（与角度指令不同，
 *  后者是随手拖动实时生成的呈现逻辑，留在前端）。 */
export interface EnhancePreset {
  key: string
  label: string
  hint: string
  /** 真正发给模型的英文指令 */
  prompt: string
}

export interface StudioCatalog {
  enhance_presets: EnhancePreset[]
  /** 增强不放大像素时照实说的那句话（BR-150），文案也归服务端 */
  enhance_note: string
  tool_categories: StudioToolCategory[]
  tools: StudioToolPlugin[]
}

/** 卡片状态是产品事实：ready 打开就能完整做完一件事；beta 能做完但有明确缺口
 *  （缺口在 gap 里，一句话）；planned 还没有可用的东西。旧的 partial 档已从服务端删掉。 */
export type StudioToolStatus = 'ready' | 'beta' | 'planned'
export type StudioToolCategoryId = 'create' | 'manage' | 'connect'

export interface StudioToolCategory {
  id: StudioToolCategoryId
  label: string
  hint: string
}

export interface StudioToolPlugin {
  id: string
  label: string
  hint: string
  category: StudioToolCategoryId
  status: StudioToolStatus
  /** 仅 beta 非空：这张卡还缺什么，界面上 hover 显示 */
  gap: string
  route: string | null
  blueprint: string
  runtime_kind: string
  capabilities: string[]
  operation_contracts: Record<string, {
    input_schema: Record<string, unknown>
    output_schema: Record<string, unknown>
  }>
  surfaces: string[]
  input_schema: Record<string, unknown>
  output_schema: Record<string, unknown>
  resume_policy: string
  version: string
  generation: number
}


/* ==================== 提示词库（M3 · FR-478） ==================== */

/** 提示词分组。与素材分组同形：两级，parent 为 null 的是「库」 */
export interface PromptGroup {
  id: number
  name: string
  parent_id: number | null
  count: number
}

/** 一条提示词。builtin 是随版本发布的内置模板（负数 id，不落表）：
 *  **不可改、不可删、也不可收藏**——它没有落库的行，改动与收藏状态都无处可存，
 *  而且写进表就要维护「哪行是上版本发的、用户改过没有」的同步逻辑，判错就冲掉用户改动。
 *  想改或想收藏，先 `forkPrompt` 复制成自建条目。
 *  内置条目的 favorite 恒 false、used_count 恒 0、updated_at 恒 null。 */
export interface PromptItem {
  id: number
  group_id: number | null
  title: string
  /** 正向提示词正文 */
  body: string
  /** 负向/要避开什么。空串 = 没写 */
  negative: string
  /** 适用场景一句话 */
  scene: string
  /** 内置模板来源；自建条目为 null */
  source: string | null
  /** 源项目内的稳定出处；自建条目为 null */
  source_ref: string | null
  builtin: boolean
  favorite: boolean
  /** 被套用过几次，用来排「最近常用」 */
  used_count: number
  /** 模板变量。服务端按正文里的 `{{name}}` 占位现算，前端不必自己扫正文 */
  variables: PromptVariable[]
  /** 当前版本号。内置模板不落库，没有版本链，恒为 null */
  version: number | null
  updated_at: string | null
}

/** 一个模板变量。名字由正文里的 `{{name}}` 占位决定，这里只带人写的说明。 */
export interface PromptVariable {
  name: string
  /** 表单上显示的名字。空串就直接显示变量名 */
  label: string
  description: string
  /** 没填时用它。留空且 required 时套用会被服务端拦下 */
  default: string
  required: boolean
}

/** 填好变量之后的正文。缺必填变量时服务端返回 400，不会回半成品。 */
export interface RenderedPrompt {
  body: string
  negative: string
  values: Record<string, string>
}

export interface PromptItemDraft {
  title: string
  body: string
  negative?: string
  scene?: string
  group_id?: number | null
  variables?: PromptVariable[]
}

/** 提示词与工作流共用的一条历史版本。快照不随列表回传，回滚时服务端自己取。 */
export interface StudioRevision {
  version: number
  /** 一句话备注。留空的那些只能靠时间认 */
  note: string
  /** 手工标了「保留」的不参与保留窗口的裁剪 */
  pinned: boolean
  created_at: string | null
}

export interface RevisionList {
  items: StudioRevision[]
  /** 保留窗口：未标记的版本只留最近这么多条 */
  keep_recent: number
}

/* ==================== GPT 创作对话（M3 · FR-476） ==================== */

export interface GptTurn {
  role: 'user' | 'assistant'
  /** 文本内容。assistant 出图那一轮可能只有图没有话 */
  content: string
  /** user：这一轮带的图（资产 id） */
  image_asset_ids?: number[]
  /** user：这一轮带的视频、音频或通用文件 */
  media_asset_ids?: number[]
  /** user：这一轮 Agent 出图使用的画幅 */
  image_size?: string
  /** assistant：这一轮 Agent 出的图 */
  asset_ids?: number[]
  /** assistant：这一轮提交的后台任务 id。刷新后顺着它回任务中心找产物 */
  task_ids?: string[]
  /** assistant：失败原因原文 */
  error?: string
  latency_ms?: number
  at?: string
}

export interface GptChatSummary {
  id: number
  title: string
  pinned: boolean
  turn_count: number
  updated_at: string
}

export interface GptChatDetail {
  id: number
  title: string
  pinned: boolean
  /** 系统提示词。空 = 用服务端默认 */
  system_prompt: string
  turns: GptTurn[]
  version: number
  updated_at: string
}

/** SSE 事件。meta 先行给出这一轮用的模型，delta 是文本增量，
 *  image 是 Agent 真出了一张图，done 收尾带完整 assistant 轮次 */
export type GptStreamEvent =
  | { type: 'meta'; chat_model: string | null; image_alias: string; image_size: string }
  | { type: 'delta'; text: string }
  | { type: 'image'; asset_id: number; url: string; prompt: string }
  /** 长任务只回执，产物由任务中心那条事件流后补 */
  | {
      type: 'task'
      task_id: string
      operation: string
      tool_id: string
      status: string
      label: string
      run_id: string | null
    }
  | { type: 'done'; turn: GptTurn }
  | { type: 'error'; detail: string }


/* ==================== 工作流模板（M4 · FR-482） ==================== */

/** 画布子图打包成的模板。资产按 sha256 引用：导入时同内容的图直接复用既有资产，
 *  不重复落盘；库里没有的才从模板里带的字节重建。 */
export interface WorkflowTemplate {
  id: number
  name: string
  note: string
  /** 模板里有几个节点、引用了几张图 */
  node_count: number
  asset_count: number
  /** ZIP 中随工作流保存的图片、视频、音频和文件数。 */
  resource_count: number
  /** true 表示原始资源字节已落对象存储，可在原资产删除后重建。 */
  packaged: boolean
  package_bytes: number
  created_at: string
}

export interface AssetTagSettings {
  deployment_id: number | null
  caption_prompt: string
  classification_prompt: string
  user_prompt: string
}

export type AssetStorageKind = 'generated' | 'upload' | 'local'

export interface AssetStorageBucket {
  kind: AssetStorageKind
  prefix: string
  path: string
  count: number
  archived: number
  bytes: number
  objects: number
}

export interface ArchivedStorageAsset {
  id: number
  name: string
  source: string
  op: string | null
  width: number
  height: number
  bytes: number
  objects: number
  thumb_url: string
  created_at: string | null
  reclaimable: boolean
  references: string[]
}

export interface AssetStorageOverview {
  backend: 'local' | 'object'
  root: string | null
  prefixes: Record<AssetStorageKind, string>
  defaults: Record<AssetStorageKind, string>
  buckets: AssetStorageBucket[]
  total_assets: number
  archived_assets: number
  reclaimable_assets: number
  reclaimable_bytes: number
  archived_items: ArchivedStorageAsset[]
  archived_truncated: boolean
}

/** ComfyUI / RunningHub 可执行工作流。与上面的“画布子图模板”是两种数据。 */
export interface ExecutableWorkflow {
  id: number
  key: string
  title: string
  provider: 'comfyui' | 'runninghub'
  kind: string
  source: 'bundled' | 'user'
  source_id: string | null
  enabled: boolean
  node_count: number
  field_count: number
  has_thumbnail: boolean
  content_hash: string
  /** 定义每改一次 +1。回滚也是往前推一版，不倒退 */
  version: number
  created_at: string
  updated_at: string
}

export interface ExecutableWorkflowDetail extends ExecutableWorkflow {
  payload: Record<string, unknown>
  ui_schema: Record<string, unknown> | null
}

export type RunningHubRemoteKind = 'model' | 'app' | 'workflow'

export interface RunningHubRemoteModel {
  id: string
  endpoint: string
  title: string
  output_type: 'image' | 'video' | 'audio' | 'chat' | 'workflow'
  params: Record<string, unknown>[]
}

export interface RunningHubRemoteDefinition {
  kind: RunningHubRemoteKind
  source_id: string
  title: string
  description: string
  payload: Record<string, unknown>
  ui_schema: { fields: Record<string, unknown>[]; [key: string]: unknown }
}

export interface RunningHubDiagnostics {
  points: {
    configured: boolean
    ok: boolean | null
    detail: string
  }
  wallet: {
    configured: boolean
    ok: boolean
    detail: string
    model_count: number
  }
}

export interface TemplateImportResult {
  /** 追加进画布的节点（id 已重映射，不会和现有节点撞） */
  nodes: CanvasNode[]
  connections: CanvasConnection[]
  /** 复用了几张既有资产 */
  reused: number
  /** 指纹模板恒为 0；资产化工作流可从随包 ZIP 重建原始资源。 */
  rebuilt: number
  /** 库里找不到的图。节点上对应的 item 会带 missing:true，画布该画成空位 */
  missing: { node_id: string; sha256: string }[]
  missing_note: string
}

/* ==================== 视频抽帧（M4 · FR-483） ==================== */

/** 抽帧片源：视频学习库的 `video` 与创作域的 `studio_media_asset`。 */
export type FrameSourceKind = 'library' | 'studio'

export interface VideoForFrames {
  /** 两个片源各有一套从 1 开始的 id，`source` 与 `id` 必须成对使用 */
  source: FrameSourceKind
  id: number
  /** `${source}:${id}`。下拉框只拿 id 当值的话，两边的 3 号会撞成同一项 */
  ref: string
  title: string
  duration_s: number | null
  /** 播放地址由服务端给。前端照 id 自己拼就是取错片源的入口 */
  stream_url: string
}

export interface FrameShot {
  asset_id: number
  url: string
  /** 这一帧在视频里的秒数 */
  at_s: number
}

/* ==================== 打标队列（M4 · FR-484） ==================== */

/** 批量打标改成后台任务：200 张同步串行会让请求挂十几分钟（M2 已知余项）。 */
export interface TagJob {
  job_id: string
  total: number
  done: number
  failed: number
  /** running | done | failed */
  status: string
  /** 整批挂掉时的原因原文（逐条失败在 items[].error 里） */
  error?: string
  /** 逐条结果，边跑边填 */
  items: AssetTagResult[]
}

/* ==================== 统一创作任务（v2 · BR-174） ==================== */

export type StudioTaskStatus =
  | 'queued'
  | 'submitting'
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'recovering'

export interface StudioTask {
  id: string
  domain: string
  tool_id: string
  task_type: string
  parent_task_id: string | null
  batch_id: string | null
  source_route: string | null
  source_context: Record<string, unknown> | null
  capability: string | null
  deployment_id: number | null
  invocation: Record<string, unknown> | null
  provider_task_id: string | null
  canvas_id: number | null
  node_id: string | null
  execution_group_id: string | null
  status: StudioTaskStatus
  stage: string | null
  progress: number
  result: Record<string, unknown> | null
  error: string | null
  retryable: boolean
  created_at: string | null
  started_at: string | null
  heartbeat_at: string | null
  finished_at: string | null
  event_seq: number
  updated_at: string | null
}

export interface StudioToolRun extends StudioTask {
  image_job_id?: number
}

export interface StudioTaskEvent {
  cursor: number
  task_id: string
  seq: number
  event_type: string
  status: StudioTaskStatus
  stage: string | null
  progress: number | null
  message: string | null
  payload: Record<string, unknown> | null
  canvas_id: number | null
  node_id: string | null
  created_at: string | null
}

/** SSE `event: canvas` 帧里的一条落图记录：服务端 projector 往哪个节点加了几张 */
export interface CanvasEventLanded {
  node_id: string
  task_id: string | null
  flow_run_id: string | null
  added: number
}

/** SSE `event: canvas` 帧。画布 updated_at 一变就推一帧（别的标签页保存也算），
 *  不带 id 行、不推进游标。origin=projector 是服务端落图，landed 列明细；
 *  origin=save 是普通保存，landed 为空。帧本身不带内容，前端拿 version 与本地比，
 *  比本地新才拉全量合并 */
export interface CanvasEventFrame {
  canvas_id: number
  version: number
  updated_at: string
  origin: 'projector' | 'save'
  landed: CanvasEventLanded[]
}

/* ==================== 持久化工具 DAG ==================== */

/** 节点形态。缺省 `tool`——历史定义没有这个字段，读到 undefined 一律按工具节点走 */
export type StudioFlowNodeKind = 'tool' | 'map' | 'subflow' | 'input' | 'output'

/** 节点失败后 run 怎么走：整条失败 / 只跳过下游 / 当没事继续 */
export type StudioFlowFailurePolicy = 'fail_run' | 'skip_downstream' | 'continue'

export interface StudioFlowRetry {
  max: number
  backoff_ms: number
}

/** 五类节点共有的执行策略。服务端 dump 会把没设的字段写成 null，读的一侧要允许 */
export interface StudioFlowNodeBase {
  id: string
  source_context?: Record<string, unknown> | null
  /** 结果为假的节点转 skipped，下游按 on_failure 决定跳不跳 */
  when?: string | null
  on_failure?: StudioFlowFailurePolicy
  retry?: StudioFlowRetry | null
  timeout_s?: number | null
}

/** 工具节点：一次真实 StudioTask。`kind` 缺省即此类——历史定义没有这个字段，
 *  读到 undefined 一律按工具节点走，所以工具、能力、入参在这一支上是必填的 */
export interface StudioFlowToolNode extends StudioFlowNodeBase {
  kind?: 'tool'
  tool_id: string
  operation: string
  input: Record<string, unknown>
}

/** kind=map：over 求值出列表，逐项实例化 template，实例 id 是 `<node>.<index>`。
 *  template 的 id 由展开时生成，这里可以缺省 */
export interface StudioFlowMapNode extends StudioFlowNodeBase {
  kind: 'map'
  over: unknown
  template: Omit<StudioFlowToolNode, 'id'> & { id?: string }
}

/** kind=subflow：整条子 DAG 当一个节点跑 */
export interface StudioFlowSubflowNode extends StudioFlowNodeBase {
  kind: 'subflow'
  flow_id: number
  inputs?: Record<string, unknown> | null
}

/** kind=input：沉淀成模板后的一个运行参数，schema 决定运行表单长什么样 */
export interface StudioFlowInputNode extends StudioFlowNodeBase {
  kind: 'input'
  name: string
  schema?: Record<string, unknown> | null
}

/** kind=output：取值表达式汇进 run.outputs[name] */
export interface StudioFlowOutputNode extends StudioFlowNodeBase {
  kind: 'output'
  name: string
  value: unknown
}

/** 判别联合，判别键是 `kind`（缺省 = tool）。
 *  这样「工具节点一定有 input」写进了类型里，读的一侧不必再对 input 做非空断言 */
export type StudioFlowNode =
  | StudioFlowToolNode
  | StudioFlowMapNode
  | StudioFlowSubflowNode
  | StudioFlowInputNode
  | StudioFlowOutputNode

/** 从定义里取一个工具节点。定义是从服务端读回来的，kind 可能是任意一支，
 *  拿它的 input 之前先收窄；不是工具节点就是调用方用错了地方 */
export function asFlowToolNode(node: StudioFlowNode | undefined): StudioFlowToolNode {
  if (node === undefined) throw new Error('节点不存在')
  if (node.kind !== undefined && node.kind !== 'tool') {
    throw new Error(`节点 ${node.id} 不是工具节点（kind=${node.kind}）`)
  }
  return node
}

export interface StudioFlowEdge {
  from: string
  to: string
}

export interface StudioFlowDefinition {
  nodes: StudioFlowNode[]
  edges: StudioFlowEdge[]
}

export interface StudioFlowSummary {
  id: number
  title: string
  description: string | null
  version: number
  enabled: boolean
  node_count: number
  edge_count: number
  created_at: string | null
  updated_at: string | null
  /** 由 input 节点汇出的运行参数表单契约 */
  input_schema?: Record<string, unknown> | null
}

export interface StudioFlowDetail extends StudioFlowSummary {
  definition: StudioFlowDefinition
}

/** 定时 / 终态两类触发器 */
export type StudioFlowTriggerBody =
  | { kind: 'cron'; cron: string }
  | { kind: 'task_terminal'; task_type: string; statuses: string[] }

export interface StudioFlowTrigger {
  id: number
  flow_id: number
  kind: 'cron' | 'task_terminal'
  cron?: string | null
  task_type?: string | null
  statuses?: string[] | null
  enabled?: boolean
  created_at?: string | null
  last_fired_at?: string | null
}

export interface StudioFlowNodeCheckpoint {
  status: string
  task_id: string | null
  attempt: number
  result: Record<string, unknown> | null
  error: string | null
  /** waiting_input 节点等的是什么形状的值；缺省时前端回落到定义里的 input 节点 schema */
  input_schema?: Record<string, unknown> | null
}

export interface StudioFlowRun {
  id: string
  flow_id: number | null
  parent_run_id: string | null
  flow_version: number
  status: string
  error: string | null
  inputs: Record<string, unknown>
  source_context: Record<string, unknown> | null
  checkpoint: { version: number; nodes: Record<string, StudioFlowNodeCheckpoint> }
  /** output 节点汇出的结果；没有 output 节点时为空 */
  outputs?: Record<string, unknown> | null
  progress: number
  created_at: string | null
  started_at: string | null
  heartbeat_at: string | null
  finished_at: string | null
  updated_at: string | null
}

/* ==================== 调用 ==================== */

/** 循环节点的 AI 编排结果（服务端已归一化，每个字段都是合法值） */
export interface LoopPlan {
  title: string
  mode: 'serial' | 'parallel'
  count: number
  loop_start: number
  variable_prompts: string[]
  image_input: boolean
  image_batch_size: number
  /** 模型为什么这样配。显示给用户看，帮他判断要不要采纳 */
  why: string
}

/* ---- 成套出图（模块 17） ---- */

/** AI 反问的一个问题。形状取自 MCP elicitation 的受限 schema：
 *  单选/多选/填空三种，选项扁平，不嵌套——这样前端一个渲染器就能吃下全部 */
export interface SetQuestion {
  id: string
  type: 'single' | 'multi' | 'text'
  title: string
  hint: string
  options: { value: string; label: string; hint: string }[]
  min?: number
  max?: number
  placeholder?: string
}

/** 送给规划端的附件引用。**只传 id 与文件名**——正文由服务端按 id 去存储层读，
 *  让浏览器把一份 pdf 的正文读出来再发回来，等于把同一份字节过两遍网 */
export interface SetAttachment {
  kind: string
  name: string
  media_asset_id?: number
  asset_id?: number
}

/** 一次作答。`answer` 单选是字符串、多选是数组、填空是字符串 */
export interface SetAnswer {
  id: string
  title: string
  answer: string | string[]
}

/** 方案里可以随便调、调了**不需要重新规划**的东西（张数、画幅…） */
export interface PlanVariable {
  key: string
  label: string
  type: 'number' | 'option' | 'string'
  value: string | number
  options: string[]
}

/** 一步 = 一张图。`id` 是稳定锚点，改动 patch 靠它定位 */
export interface PlanStep {
  id: string
  title: string
  prompt: string
  dependsOn: string[]
}

export interface SetPlan {
  goal: string
  /** consistent = 一致成套（串行）；varied = 多样备选（并发） */
  intent: 'consistent' | 'varied'
  variables: PlanVariable[]
  steps: PlanStep[]
  rationale: string
}

/** 改动的一档。1=本地改不进模型，2=增量重算，3=整份重新规划 */
export type PlanTier = 1 | 2 | 3

/** 方案 → 底层执行参数。用户不填这些，系统填 */
export interface SetRunConfig {
  mode: 'serial' | 'parallel'
  count: number
  loop_start: number
  variable_prompts: string[]
  image_input: boolean
  image_batch_size: number
  title: string
}

export const apiStudio = {
  /* ---- 跨页面任务中心 ---- */
  runTool: (
    toolId: string,
    body: {
      operation: string
      input: Record<string, unknown>
      source_route?: string | null
      source_context?: Record<string, unknown> | null
    },
  ) =>
    request<StudioToolRun>(
      `/studio/tools/${encodeURIComponent(toolId)}/runs`,
      jsonBody('POST', body),
    ),

  tasks: (
    filters: {
      status?: string
      tool_id?: string
      domain?: string
      canvas_id?: number
      node_id?: string
      source_node_id?: string
      origin_node_id?: string
      limit?: number
      offset?: number
    } = {},
  ) =>
    request<{ items: StudioTask[] }>(
      `/studio/tasks${
        Object.keys(filters).length === 0
          ? ''
          : `?${new URLSearchParams(
              Object.entries(filters)
                .filter(([, value]) => value !== undefined)
                .map(([key, value]) => [key, String(value)]),
            ).toString()}`
      }`,
    ),

  task: (id: string) => request<StudioTask>(`/studio/tasks/${encodeURIComponent(id)}`),

  taskEvents: (id: string, after = 0) =>
    request<{ items: StudioTaskEvent[] }>(
      `/studio/tasks/${encodeURIComponent(id)}/events?after=${Math.max(0, after)}`,
    ),

  retryTask: (id: string) =>
    request<StudioTask>(`/studio/tasks/${encodeURIComponent(id)}/retry`, { method: 'POST' }),

  rerunTask: (id: string) =>
    request<StudioTask>(`/studio/tasks/${encodeURIComponent(id)}/rerun`, { method: 'POST' }),

  /** 202 返回打上取消标记后的任务快照；已终态的任务 409。 */
  cancelTask: (id: string) =>
    request<{ task: StudioTask }>(`/studio/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),

  cleanupTasks: (taskIds: string[]) =>
    request<{ deleted: number; missing: string[] }>(
      '/studio/tasks/cleanup',
      jsonBody('POST', { task_ids: taskIds }),
    ),

  mediaAssets: (
    filters: {
      kind?: string
      status?: string
      group_id?: number
      favorite?: boolean
      q?: string
      limit?: number
      offset?: number
    } = {},
  ) =>
    request<{ items: StudioMediaAsset[]; total: number }>(
      `/studio/media-assets${
        Object.keys(filters).length === 0
          ? ''
          : `?${new URLSearchParams(
              Object.entries(filters)
                .filter(([, value]) => value !== undefined)
                .map(([key, value]) => [key, String(value)]),
            ).toString()}`
      }`,
    ),

  mediaAsset: (id: number) => request<StudioMediaAsset>(`/studio/media-assets/${id}`),

  /** 附件预览的结构化内容。pdf 不走这里——浏览器内置阅读器直接渲染原文件 */
  mediaAssetPreview: (id: number) =>
    request<MediaPreview>(`/studio/media-assets/${id}/preview`),

  uploadMediaAsset: (file: File) => {
    const form = new FormData()
    form.set('file', file)
    return request<StudioMediaAsset>('/studio/media-assets', { method: 'POST', body: form })
  },

  patchMediaAsset: (
    id: number,
    body: { favorite?: boolean; status?: 'active' | 'archived'; group_id?: number | null },
  ) => request<StudioMediaAsset>(`/studio/media-assets/${id}`, jsonBody('PATCH', body)),

  deleteMediaAsset: (id: number) =>
    request<{ ok: true }>(`/studio/media-assets/${id}`, { method: 'DELETE' }),

  exportMiniMaxTimeline: (body: {
    clips: Array<{
      media_asset_id: number
      start: number
      end: number
      duration: number
    }>
    filename: string
  }) => request<StudioMediaAsset>('/studio/minimax/timeline-export', jsonBody('POST', body)),

  /* ---- 画布 ---- */
  projects: () => request<{ items: StudioProject[] }>('/studio/projects'),

  createProject: (body: { name: string }) =>
    request<StudioProject>('/studio/projects', jsonBody('POST', body)),

  patchProject: (id: string, body: { name?: string; sort?: number }) =>
    request<StudioProject>(`/studio/projects/${id}`, jsonBody('PATCH', body)),

  deleteProject: (id: string) =>
    request<{ ok: true; moved: number }>(`/studio/projects/${id}`, { method: 'DELETE' }),

  canvases: (trashed = false, project?: string) => {
    const params = new URLSearchParams()
    if (trashed) params.set('trashed', '1')
    if (project !== undefined) params.set('project', project)
    const query = params.size > 0 ? `?${params}` : ''
    return request<{ items: CanvasSummary[] }>(`/studio/canvases${query}`)
  },

  createCanvas: (body: {
    title?: string
    icon?: string
    kind?: 'classic' | 'smart'
    project?: string
    board_x?: number
    board_y?: number
  }) =>
    request<CanvasDetail>('/studio/canvases', jsonBody('POST', body)),

  canvas: (id: number) => request<CanvasDetail>(`/studio/canvases/${id}`),

  /** 内容保存。409 时抛的 Error.message 是 detail，最新全量要另行 GET */
  saveCanvas: (id: number, body: CanvasSavePayload) =>
    request<{ version: number; updated_at: string }>(
      `/studio/canvases/${id}`,
      jsonBody('PUT', body),
    ),

  runCanvasLlm: (body: {
    canvas_id: number
    node_id: string
    message: string
    system_prompt?: string
    messages?: { role: 'user' | 'assistant'; content: string }[]
    image_asset_ids?: number[]
    video_media_asset_ids?: number[]
    deployment_id?: number | null
    temperature?: number
  }) => request<{ text: string }>('/studio/canvas-llm', jsonBody('POST', body)),

  /** meta 更新不刷排序时间（BR-146）：打个标签不该把画布顶到最前 */
  patchCanvasMeta: (
    id: number,
    body: {
      title?: string
      icon?: string
      color?: string
      pinned?: boolean
      project?: string
      owner?: string
      board_x?: number
      board_y?: number
    },
  ) => request<{ ok: true }>(`/studio/canvases/${id}/meta`, jsonBody('PATCH', body)),

  trashCanvas: (id: number) =>
    request<{ ok: true }>(`/studio/canvases/${id}`, { method: 'DELETE' }),

  restoreCanvas: (id: number) =>
    request<{ ok: true }>(`/studio/canvases/${id}/restore`, jsonBody('POST', {})),

  purgeCanvas: (id: number) =>
    request<{ ok: true }>(`/studio/canvases/${id}/purge`, { method: 'DELETE' }),

  exportCanvasWorkflow: (body: {
    nodes: CanvasNode[]
    connections: CanvasConnection[]
    include_resources: boolean
    filename: string
    target_format?: 'lingua-canvas-workflow' | 'infinite-canvas-workflow'
  }) => requestDownload('/studio/canvas-workflows/export', body),

  exportCanvasPackage: (
    id: number,
    body: { include_resources: boolean; filename: string },
  ) => requestDownload(`/studio/canvas-workflows/canvases/${id}/export`, body),

  downloadOutputImages: (body: { asset_ids: number[]; filename: string }) =>
    requestDownload('/studio/canvas-workflows/outputs/download', body),

  importCanvasWorkflow: (file: File) => {
    const form = new FormData()
    form.set('file', file)
    return request<CanvasWorkflowImportResult>('/studio/canvas-workflows/import', {
      method: 'POST',
      body: form,
    })
  },

  /* ---- 画布资产索引 ---- */
  canvasAssets: () => request<CanvasAssetIndex>('/studio/canvas-assets'),

  downloadCanvasAssets: (body: { item_ids: string[]; filename: string }) =>
    requestDownload('/studio/canvas-assets/download', body),

  /* ---- 对话生图 ---- */
  chats: () => request<{ items: ChatSummary[] }>('/studio/chats'),

  createChat: (body: { title?: string }) =>
    request<ChatDetail>('/studio/chats', jsonBody('POST', body)),

  chat: (id: number) => request<ChatDetail>(`/studio/chats/${id}`),

  saveChatTurns: (id: number, body: { turns: ChatImageTurn[]; base_version: number }) =>
    request<{ version: number; updated_at: string }>(
      `/studio/chats/${id}`,
      jsonBody('PUT', body),
    ),

  /* ---- 工坊目录（工具的服务端常量） ---- */
  catalog: () => request<StudioCatalog>('/studio/catalog'),

  /* ---- 持久化工具 DAG ---- */
  flows: () => request<{ items: StudioFlowSummary[] }>('/studio/flows'),

  flow: (id: number) => request<StudioFlowDetail>(`/studio/flows/${id}`),

  createFlow: (body: {
    title: string
    description?: string | null
    definition: StudioFlowDefinition
  }) => request<StudioFlowDetail>('/studio/flows', jsonBody('POST', body)),

  updateFlow: (id: number, body: {
    title: string
    description?: string | null
    definition: StudioFlowDefinition
    base_version: number
    enabled: boolean
  }) => request<StudioFlowDetail>(`/studio/flows/${id}`, jsonBody('PUT', body)),

  deleteFlow: (id: number) =>
    request<{ ok: true }>(`/studio/flows/${id}`, { method: 'DELETE' }),

  /** 运行参数表单契约。由定义里的 input 节点汇出，模板面板据此渲染表单 */
  flowSchema: (id: number) =>
    request<{ input_schema: Record<string, unknown> }>(`/studio/flows/${id}/schema`),

  flowTriggers: (flowId: number) =>
    request<{ items: StudioFlowTrigger[] }>(`/studio/flows/${flowId}/triggers`),

  createFlowTrigger: (flowId: number, body: StudioFlowTriggerBody) =>
    request<StudioFlowTrigger>(`/studio/flows/${flowId}/triggers`, jsonBody('POST', body)),

  deleteFlowTrigger: (flowId: number, triggerId: number) =>
    request<{ ok: true }>(
      `/studio/flows/${flowId}/triggers/${triggerId}`,
      { method: 'DELETE' },
    ),

  runFlow: (id: number, body: {
    inputs: Record<string, unknown>
    source_context?: Record<string, unknown>
  }) => request<StudioFlowRun>(`/studio/flows/${id}/runs`, jsonBody('POST', body)),

  runInlineFlow: (body: {
    definition: StudioFlowDefinition
    inputs?: Record<string, unknown>
    source_context?: Record<string, unknown>
  }) => request<StudioFlowRun>('/studio/flows/runs', jsonBody('POST', body)),

  flowRuns: (query: {
    flow_id?: number
    status?: string
    canvas_id?: number
    context_kind?: string
    limit?: number
  } = {}) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value))
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : ''
    return request<{ items: StudioFlowRun[] }>(`/studio/flows/runs${suffix}`)
  },

  flowRun: (id: string) =>
    request<StudioFlowRun>(`/studio/flows/runs/${encodeURIComponent(id)}`),

  retryFlowRun: (id: string) =>
    request<StudioFlowRun>(
      `/studio/flows/runs/${encodeURIComponent(id)}/retry`,
      { method: 'POST' },
    ),

  /** 不带 body = 把 failed/cancelled 节点回 pending 续跑；
   *  带 body = 给某个 waiting_input 节点补上人工输入再往下走 */
  resumeFlowRun: (id: string, body?: { node_id: string; resume_value: unknown }) =>
    request<StudioFlowRun>(
      `/studio/flows/runs/${encodeURIComponent(id)}/resume`,
      body === undefined ? { method: 'POST' } : jsonBody('POST', body),
    ),

  /** 把一次运行沉淀成可复用工作流：字面输入抽成 input 节点 */
  promoteFlowRun: (id: string, body?: { title?: string; description?: string | null }) =>
    request<StudioFlowDetail>(
      `/studio/flows/runs/${encodeURIComponent(id)}/promote`,
      body === undefined ? { method: 'POST' } : jsonBody('POST', body),
    ),

  cancelFlowRun: (id: string) =>
    request<StudioFlowRun>(
      `/studio/flows/runs/${encodeURIComponent(id)}/cancel`,
      { method: 'POST' },
    ),

  /* ---- 素材分组 ---- */
  assetGroups: () => request<{ items: AssetGroup[] }>('/studio/asset-groups'),

  createAssetGroup: (body: { name: string; parent_id?: number | null }) =>
    request<AssetGroup>('/studio/asset-groups', jsonBody('POST', body)),

  patchAssetGroup: (id: number, body: { name?: string; parent_id?: number | null }) =>
    request<AssetGroup>(`/studio/asset-groups/${id}`, jsonBody('PATCH', body)),

  /** 删组只解除归属，**不删资产**——图归模块 16 管 */
  deleteAssetGroup: (id: number) =>
    request<{ ok: true; released: number }>(`/studio/asset-groups/${id}`, { method: 'DELETE' }),

  /* ---- 项目内共享目录（只读浏览，选择后复制入库） ---- */
  sharedFolders: () =>
    request<{ items: SharedFolder[] }>('/studio/shared-folders'),

  registerSharedFolder: (body: { path: string; name?: string }) =>
    request<SharedFolder>('/studio/shared-folders', jsonBody('POST', body)),

  deleteSharedFolder: (id: number) =>
    request<{ ok: true }>(`/studio/shared-folders/${id}`, { method: 'DELETE' }),

  sharedFolderTree: (id: number) =>
    request<SharedFolderTree>(`/studio/shared-folders/${id}/tree`),

  importSharedFolderFiles: (
    id: number,
    body: { paths: string[]; group_id?: number | null },
  ) => request<SharedFolderImportResult>(
    `/studio/shared-folders/${id}/import`,
    jsonBody('POST', body),
  ),

  /** 批量把资产挪进某个组；group_id 传 null = 移出分组 */
  moveAssets: (body: { asset_ids: number[]; group_id: number | null }) =>
    request<{ moved: number }>('/studio/assets/move', jsonBody('POST', body)),

  /* ---- AI 打标 ---- */
  /** 同步跑完再返回。逐条独立，一条失败不影响其它条（结果里带 error） */
  tagAssets: (body: { asset_ids: number[] }) =>
    request<{ items: AssetTagResult[] }>('/studio/assets/tag', jsonBody('POST', body)),

  assetSettings: () => request<AssetTagSettings>('/studio/assets/settings'),

  saveAssetSettings: (body: AssetTagSettings) =>
    request<AssetTagSettings>('/studio/assets/settings', jsonBody('PUT', body)),

  assetStorage: () => request<AssetStorageOverview>('/studio/assets/storage'),

  saveAssetStoragePrefixes: (body: Record<AssetStorageKind, string>) =>
    request<{ prefixes: Record<AssetStorageKind, string> }>(
      '/studio/assets/storage-prefixes',
      jsonBody('PUT', body),
    ),

  purgeAssetStorage: (assetIds: number[]) =>
    request<{ purged: number; removed_objects: number; removed_bytes: number }>(
      '/studio/assets/storage/purge',
      jsonBody('POST', { asset_ids: assetIds }),
    ),

  /* ---- URL 批量导入 ---- */
  importUrls: (body: {
    items: { url: string; name?: string }[]
    group_id?: number | null
    auto_tag?: boolean
  }) => request<{ items: ImportUrlResult[] }>('/studio/assets/import-urls', jsonBody('POST', body)),

  /* ---- 提示词库 ---- */
  promptGroups: () => request<{ items: PromptGroup[] }>('/studio/prompt-groups'),

  createPromptGroup: (body: { name: string; parent_id?: number | null }) =>
    request<PromptGroup>('/studio/prompt-groups', jsonBody('POST', body)),

  patchPromptGroup: (id: number, body: { name?: string; parent_id?: number | null }) =>
    request<PromptGroup>(`/studio/prompt-groups/${id}`, jsonBody('PATCH', body)),

  /** 删组只解除归属，条目退回未归组——与素材分组同一条口径 */
  deletePromptGroup: (id: number) =>
    request<{ ok: true; released: number }>(`/studio/prompt-groups/${id}`, { method: 'DELETE' }),

  prompts: (filters: { group_id?: number; q?: string; favorite?: boolean; builtin?: boolean } = {}) =>
    request<{ items: PromptItem[] }>(
      `/studio/prompts${
        Object.keys(filters).length === 0
          ? ''
          : `?${new URLSearchParams(
              Object.entries(filters)
                .filter(([, v]) => v !== undefined)
                .map(([k, v]) => [k, String(v)]),
            ).toString()}`
      }`,
    ),

  createPrompt: (body: PromptItemDraft) =>
    request<PromptItem>('/studio/prompts', jsonBody('POST', body)),

  /** 内置条目不可改：服务端会 400。要改就先「复制为自建」 */
  patchPrompt: (id: number, body: Partial<PromptItemDraft> & { favorite?: boolean }) =>
    request<PromptItem>(`/studio/prompts/${id}`, jsonBody('PATCH', body)),

  deletePrompt: (id: number) =>
    request<{ ok: true }>(`/studio/prompts/${id}`, { method: 'DELETE' }),

  /** 把内置模板复制成一条可改的自建条目 */
  forkPrompt: (id: number) =>
    request<PromptItem>(`/studio/prompts/${id}/fork`, jsonBody('POST', {})),

  /** 套用一次：used_count+1，用来排「最近常用」。失败不该阻断套用本身 */
  usePrompt: (id: number) =>
    request<{ ok: true; used_count: number }>(`/studio/prompts/${id}/use`, jsonBody('POST', {})),

  /** 把变量值填进正文。缺必填变量返回 400 并点名是哪几个——
   *  这一步存在的意义就是不让 `{{name}}` 原样发到模型那边去，所以别在前端兜底跳过 */
  renderPrompt: (id: number, values: Record<string, string>) =>
    request<RenderedPrompt>(`/studio/prompts/${id}/render`, jsonBody('POST', { values })),

  promptRevisions: (id: number) => request<RevisionList>(`/studio/prompts/${id}/revisions`),

  /** 回滚：旧内容重新提交成新的一版，版本号继续往前走 */
  restorePrompt: (id: number, version: number) =>
    request<PromptItem>(`/studio/prompts/${id}/revisions/${version}/restore`, jsonBody('POST', {})),

  pinPromptRevision: (id: number, version: number, pinned: boolean) =>
    request<StudioRevision>(
      `/studio/prompts/${id}/revisions/${version}`,
      jsonBody('PATCH', { pinned }),
    ),

  /* ---- GPT 创作对话 ---- */
  gptChats: () => request<{ items: GptChatSummary[] }>('/studio/gpt-chats'),

  createGptChat: (body: { title?: string; system_prompt?: string }) =>
    request<GptChatDetail>('/studio/gpt-chats', jsonBody('POST', body)),

  gptChat: (id: number) => request<GptChatDetail>(`/studio/gpt-chats/${id}`),

  patchGptChat: (
    id: number,
    body: { title?: string; pinned?: boolean; system_prompt?: string },
  ) => request<{ ok: true }>(`/studio/gpt-chats/${id}/meta`, jsonBody('PATCH', body)),

  deleteGptChat: (id: number) =>
    request<{ ok: true }>(`/studio/gpt-chats/${id}`, { method: 'DELETE' }),

  /** 发一轮并读 SSE。服务端边跑边持久化，断流也不丢已生成的内容 */
  sendGpt: async (
    id: number,
    body: {
      text: string
      image_asset_ids?: number[]
      media_asset_ids?: number[]
      image_size?: string
      chat_deployment_id?: number | null
      image_deployment_id?: number | null
    },
    on: (event: GptStreamEvent) => void,
    /** 传进来才能真中断。不传的话「停止」只能停止接收，后台照样把流读完 */
    signal?: AbortSignal,
  ): Promise<void> => {
    const resp = await fetch(`/api/studio/gpt-chats/${id}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    if (!resp.ok || resp.body === null) {
      const detail = await resp.text().catch(() => '')
      on({ type: 'error', detail: detail || `HTTP ${resp.status}` })
      return
    }
    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      // 中断时 read() 抛 AbortError：这是用户主动停的，不该冒成错误弹窗。
      // 服务端那边照样把已生成的内容落库（stream_turn 的 finally），所以不丢东西
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return
        throw err
      }
      const { done, value } = chunk
      if (done) break
      buf += decoder.decode(value, { stream: true })
      // SSE 以空行分帧；最后一段可能不完整，留在 buf 里等下一片
      const frames = buf.split('\n\n')
      buf = frames.pop() ?? ''
      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data:'))
        if (line === undefined) continue
        try {
          on(JSON.parse(line.slice(5).trim()) as GptStreamEvent)
        } catch {
          // 单帧解析失败不该中断整条流：后面的帧照读
        }
      }
    }
  },

  /* ---- 工作流模板 ---- */
  templates: () => request<{ items: WorkflowTemplate[] }>('/studio/templates'),

  /** 把画布上选中的子图存成模板。资产只存 sha 与元信息，不复制字节 */
  saveTemplate: (body: {
    name: string
    note?: string
    nodes: CanvasNode[]
    connections: CanvasConnection[]
    include_resources?: boolean
  }) => request<WorkflowTemplate>('/studio/templates', jsonBody('POST', body)),

  importTemplate: (file: File) => {
    const form = new FormData()
    form.set('file', file)
    return request<WorkflowTemplate>('/studio/templates/import', { method: 'POST', body: form })
  },

  renameTemplate: (id: number, name: string) =>
    request<WorkflowTemplate>(`/studio/templates/${id}`, jsonBody('PATCH', { name })),

  downloadTemplate: (id: number) =>
    requestDownload(`/studio/templates/${id}/download`, undefined),

  downloadTemplates: (ids: number[]) =>
    requestDownload('/studio/templates/download', { ids }),

  /** 取模板并重映射 id，直接追加进当前画布 */
  /** offset 是落点：服务端不知道当前画布已有什么，前端给个不叠死的位置 */
  applyTemplate: (id: number, offset?: { offset_x: number; offset_y: number }) =>
    request<TemplateImportResult>(`/studio/templates/${id}/apply`, jsonBody('POST', offset ?? {})),

  deleteTemplate: (id: number) =>
    request<{ ok: true }>(`/studio/templates/${id}`, { method: 'DELETE' }),

  /* ---- ComfyUI / RunningHub 工作流目录 ---- */
  workflows: (query = '') =>
    request<{ items: ExecutableWorkflow[] }>(`/studio/workflows${query}`),

  workflow: (id: number) =>
    request<ExecutableWorkflowDetail>(`/studio/workflows/${id}`),

  /** 裸节点图与导出物走同一个入口：payload 传导出物整包时，
   *  供应商 / 类型 / 输入映射一律以导出物为准，title 留空就沿用它里面的名字 */
  importWorkflow: (body: {
    title?: string
    provider: 'comfyui' | 'runninghub'
    kind: string
    payload: Record<string, unknown>
    ui_schema?: Record<string, unknown> | null
  }) =>
    request<ExecutableWorkflowDetail>('/studio/workflows', jsonBody('POST', body)),

  patchWorkflow: (
    id: number,
    body: { enabled?: boolean; title?: string; ui_schema?: Record<string, unknown> | null },
  ) =>
    request<ExecutableWorkflowDetail>(
      `/studio/workflows/${id}`,
      jsonBody('PATCH', body),
    ),

  deleteWorkflow: (id: number) =>
    request<{ ok: true }>(`/studio/workflows/${id}`, { method: 'DELETE' }),

  /** 导出自包含 JSON。凭据字段与本机绝对路径在服务端就被抹掉，
   *  抹了哪些写在导出物的 `redacted` 里 */
  exportWorkflow: (id: number) => requestDownload(`/studio/workflows/${id}/export`, {}),

  workflowRevisions: (id: number) => request<RevisionList>(`/studio/workflows/${id}/revisions`),

  restoreWorkflow: (id: number, version: number) =>
    request<ExecutableWorkflowDetail>(
      `/studio/workflows/${id}/revisions/${version}/restore`,
      jsonBody('POST', {}),
    ),

  pinWorkflowRevision: (id: number, version: number, pinned: boolean) =>
    request<StudioRevision>(
      `/studio/workflows/${id}/revisions/${version}`,
      jsonBody('PATCH', { pinned }),
    ),

  runWorkflow: (
    id: number,
    body: {
      credential_id: number
      fields: Record<string, unknown>
      use_wallet?: boolean
      instance_type?: '' | 'plus'
      source_route?: string
      source_context?: Record<string, unknown>
    },
  ) =>
    request<StudioTask>(
      `/studio/workflows/${id}/runs`,
      jsonBody('POST', body),
    ),

  runningHubDiagnostics: (credentialId: number) =>
    request<RunningHubDiagnostics>(
      `/studio/runninghub/diagnostics?credential_id=${credentialId}`,
    ),

  runningHubModels: (credentialId: number) =>
    request<{ items: RunningHubRemoteModel[] }>(
      `/studio/runninghub/models?credential_id=${credentialId}`,
    ),

  previewRunningHubRemote: (body: {
    credential_id: number
    kind: RunningHubRemoteKind
    source_id: string
  }) =>
    request<RunningHubRemoteDefinition>(
      '/studio/runninghub/remote/preview',
      jsonBody('POST', body),
    ),

  syncRunningHubRemote: (body: {
    credential_id: number
    kind: RunningHubRemoteKind
    source_id: string
    title?: string
    description?: string
    ui_schema?: Record<string, unknown>
  }) =>
    request<ExecutableWorkflowDetail>(
      '/studio/runninghub/remote/sync',
      jsonBody('POST', body),
    ),

  /* ---- 异步视频生成 ---- */
  runVideo: (body: {
    deployment_id: number
    prompt: string
    duration: number
    aspect_ratio: string
    resolution: string
    reference_asset_id?: number | null
    references?: VideoReferenceInput[]
    media_references?: VideoMediaReferenceInput[]
    options?: Record<string, unknown>
    source_route?: string
    source_context?: Record<string, unknown>
  }) => request<StudioTask>('/studio/videos/runs', jsonBody('POST', body)),

  /* ---- APIMart Midjourney 持久任务 ---- */
  runMidjourney: (body: {
    deployment_id: number
    mode: 'imagine' | 'blend' | 'edit'
    prompt: string
    size: string
    version: '8.2' | '8.1' | '7' | '6.1' | '5.2' | '5.1'
    speed: 'relax' | 'fast' | 'turbo'
    reference_asset_ids: number[]
    options?: Record<string, unknown>
    source_route?: string
    source_context?: Record<string, unknown>
  }) => request<StudioTask>('/studio/midjourney/runs', jsonBody('POST', body)),

  runMidjourneyAction: (body: {
    deployment_id: number
    task_id: string
    action:
      | 'upscale'
      | 'variation'
      | 'high_variation'
      | 'low_variation'
      | 'reroll'
      | 'zoom'
      | 'pan'
      | 'inpaint'
      | 'modal'
      | 'remix_strong'
      | 'remix_subtle'
    speed: 'relax' | 'fast' | 'turbo'
    index?: number | null
    direction?: 'left' | 'right' | 'up' | 'down' | null
    zoom_ratio?: number | null
    custom_id?: string | null
    prompt?: string
    mask_asset_id?: number | null
    source_route?: string
    source_context?: Record<string, unknown>
  }) => request<StudioTask>('/studio/midjourney/actions', jsonBody('POST', body)),

  /* ---- 视频抽帧 ---- */
  framesSources: () => request<{ items: VideoForFrames[] }>('/studio/frames/videos'),

  /** 按秒数列表抽帧并入库。每帧一张资产，source='frame'。
   *  片源域必填——服务端不给默认值，缺了直接 422，免得静默抽错片子 */
  extractFrames: (body: {
    source: FrameSourceKind
    video_id: number
    at_seconds: number[]
  }) =>
    request<{ items: FrameShot[]; failed: { at_s: number; error: string }[] }>(
      '/studio/frames/extract',
      jsonBody('POST', body),
    ),

  /* ---- 打标队列 ---- */
  startTagJob: (body: { asset_ids: number[] }) =>
    request<TagJob>('/studio/assets/tag-job', jsonBody('POST', body)),

  tagJob: (jobId: string) => request<TagJob>(`/studio/assets/tag-job/${jobId}`),

  /* ---- 循环节点的 AI 编排（FR-465） ---- */

  /** 一句话变成一整套循环配置。只调文本模型，不出图——产出是可改的草稿 */
  planLoop: (body: { idea: string; upstream_images?: number; upstream_prompt?: string }) =>
    request<LoopPlan>('/studio/canvas/plan-loop', jsonBody('POST', body)),

  /* ---- 成套出图（模块 17） ---- */

  /** 还缺什么信息就问什么。返回一组可点选的问题 */
  setAsk: (body: {
    idea: string
    answered?: SetAnswer[]
    upstream_images?: number
    attachments?: SetAttachment[]
    note?: string
    /** 用户按了「再问我几个」。这一轮服务端不许回「够了」 */
    more?: boolean
    /** 已经摆在界面上、用户还没答的问题标题。
     *  不回传的话模型不知道自己问过什么，会换个说法重问同一件事 */
    asked?: string[]
    alias?: string
  }) =>
    request<{ enough: boolean; questions: SetQuestion[] }>(
      '/studio/canvas/set/ask',
      jsonBody('POST', body),
    ),

  /** 产出实施方案。只调文本模型，不出图，可以随便重来 */
  setDraft: (body: {
    idea: string
    answered?: SetAnswer[]
    upstream_images?: number
    attachments?: SetAttachment[]
    note?: string
    want?: number | null
    alias?: string
  }) => request<SetPlan>('/studio/canvas/set/draft', jsonBody('POST', body)),

  /** 把改动落到方案上，并告诉前端这一批属于哪一档 */
  setPatch: (body: { plan: SetPlan; ops: Record<string, unknown>[] }) =>
    request<{ tier: PlanTier; plan: SetPlan; run: SetRunConfig }>(
      '/studio/canvas/set/patch',
      jsonBody('POST', body),
    ),

  patchChatMeta: (id: number, body: { title?: string; pinned?: boolean }) =>
    request<{ ok: true }>(`/studio/chats/${id}/meta`, jsonBody('PATCH', body)),

  deleteChat: (id: number) =>
    request<{ ok: true }>(`/studio/chats/${id}`, { method: 'DELETE' }),
}
