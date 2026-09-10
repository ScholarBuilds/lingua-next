import { requestJson } from './http'

/* 配置中心 API：供应商凭据 / 能力绑定 / 偏好整包 / 审计 / 存储统计。
   契约与 server 配置路由对齐（2026-08-17 与后端确认）：
   - credentials 列表项自带 models 缓存（LLM=模型名数组，TTS=音色对象数组）
   - TTS 场景绑定 target 为裸音色 id，params.rate 为整数百分比（0=原速，25≈1.25×）
   - translate-chain 绑定 params.chain 为有序启用引擎数组（如 ["llm","google"]）
   - DELETE 凭据被绑定引用时 409，detail.bindings 列出受影响能力，?force=true 强删 */

export interface NetworkPolicy {
  scope: 'selected' | 'all'
  enabled: boolean
  address: string
  video: boolean
  speech: boolean
}

export interface NetworkProbe {
  reachable: boolean
  route: 'direct' | 'proxy'
  http_status: number | null
  elapsed_ms: number
  message: string
}

export interface ServiceProbeResult {
  ok: boolean
  latency_ms: number
  detail: string
  audio?: string
  mime_type?: string
  sample?: string
  session_ms?: number
}

export class ApiConfigError extends Error {
  constructor(
    public status: number,
    message: string,
    /** 后端 detail 原样保留（409 冲突时含 bindings 数组） */
    public detail: unknown = null,
  ) {
    super(message)
    this.name = 'ApiConfigError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return requestJson<T>(path, init, (status, message, detail) => new ApiConfigError(status, message, detail))
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

/* ---- 类型 ---- */

export type CredKind = 'llm' | 'tts' | 'realtime' | 'image' | 'video' | 'workflow'
export type CredStatus = 'untested' | 'ok' | 'failed'

export interface ProviderField {
  name: string
  label: string
  /** text / password / url…；前端只对 password 特殊处理 */
  type: string
  required: boolean
  placeholder?: string | null
}

/** 授权引导（需求 17 §4.4）。为 null 表示这个供应商还没写引导——
    UI 据此不渲染引导卡，而不是拿空壳画一张什么都没有的卡片 */
export interface ProviderOnboarding {
  summary?: string
  /** 计费方式。写不清楚就不写——含糊的计费说明比没有更误导 */
  pricing?: string
  home?: string
  steps?: { title: string; detail?: string; url?: string; url_label?: string }[]
  /** 字段名 → 这个字段该填什么 */
  field_help?: Record<string, string>
  /** 常见错误 → 怎么修 */
  troubles?: Record<string, string>
}

export interface ProviderType {
  kind: CredKind
  compatible_kinds?: CredKind[]
  provider_type: string
  label: string
  fields: ProviderField[]
  notes?: string | null
  recommendation?: {
    category: 'allround' | 'free' | 'image' | 'video' | string
    badge: string
    summary: string
  } | null
  onboarding?: ProviderOnboarding | null
  /** 服务端能现场探测这个类型的本机命令行工具与登录态（GET /config/credentials/probe）。
      判据留在服务端，前端不再自己维护一份「哪些是本机 CLI」的名单。 */
  probeable?: boolean
}

export interface CliStatus {
  installed?: boolean
  version?: string
  executable?: string
  helper?: string
  logged_in?: boolean | null
  credit?: unknown
}

/* ---- 凭据自动探测（GET /config/credentials/probe）----
   本机 CLI 类供应商的路径与登录态由服务端现场探测（which / 默认路径），
   表单据此决定「显示已找到的路径」还是「露出手填输入框 + 安装办法」。 */

export interface CredentialProbeField {
  key: string
  label: string
  /** 探测到的值；null 表示没找到 */
  detected: string | null
  /** which / default_path / env…，只用来向用户解释这个值哪来的 */
  source: string | null
}

export interface CredentialProbeRemedy {
  problem: string
  howto: string
}

export interface CredentialProbeReport {
  provider_type: string
  found: boolean
  fields: CredentialProbeField[]
  logged_in: boolean | null
  remediation: CredentialProbeRemedy[]
}

export interface CliLoginStatus {
  running: boolean
  logged_in: boolean | null
  text: string
  qr_url: string
  started_at?: number | null
  credit?: unknown
}

export interface VolcengineAssetDiagnostic {
  ok: boolean
  project_name: string
  region: string
  group_count: number
  detail: string
}

export interface VolcenginePrivateAsset {
  asset_id: string
  asset_uri: string
  status: string
  detail?: Record<string, unknown>
}

/** TTS 凭据 models 缓存里的音色条目 */
export interface TtsVoiceModel {
  id: string
  name: string
  label: string
  locale: string
  gender: string
}

export interface Credential {
  id: number
  name: string
  kind: CredKind
  provider_type: string
  enabled: boolean
  status: CredStatus
  status_detail: string | null
  last_tested_at: string | null
  /** 密文字段掩码：{ api_key: "sk-53…f2a1" } */
  masked: Record<string, string>
  /** 模型缓存：LLM=字符串数组；TTS=音色对象数组；无缓存=[] */
  models: unknown[]
  models_count: number
  models_refreshed_at: string | null
}

/** LLM 凭据的模型名列表（过滤掉非法项） */
export function llmModelsOf(cred: Credential): string[] {
  return (cred.models ?? []).filter((m): m is string => typeof m === 'string')
}

/** TTS 凭据的音色列表（宽松解析，缺字段兜底） */
export function ttsVoicesOf(cred: Credential): TtsVoiceModel[] {
  return (cred.models ?? []).flatMap((m) => {
    if (m === null || typeof m !== 'object') return []
    const r = m as Record<string, unknown>
    const name = typeof r.name === 'string' ? r.name : ''
    const id = typeof r.id === 'string' && r.id !== '' ? r.id : name
    if (id === '') return []
    return [
      {
        id,
        name: name !== '' ? name : id,
        label: typeof r.label === 'string' && r.label !== '' ? r.label : name !== '' ? name : id,
        locale: typeof r.locale === 'string' ? r.locale : '',
        gender: typeof r.gender === 'string' ? r.gender : '',
      },
    ]
  })
}

export interface CredTestResult {
  ok: boolean
  latency_ms: number | null
  error_type: string | null
  detail: string | null
  status_code?: number | null
  protocol?: string | null
  detected_adapter_type?: string | null
  image_request_mode?: string | null
  model_count?: number | null
  raw_preview?: string | null
}

export interface CredentialProbeDraft {
  provider_type: string
  credential_id?: number
  config: Record<string, string>
}

export interface RefreshModelsResult {
  items: unknown[]
  count: number
  refreshed_at: string
  deployments: ModelDeploymentSyncResult | null
}

export interface ModelDeploymentSyncResult {
  created: number
  updated: number
  skipped: number
  total: number
}

export interface ModelPlugin {
  id: string
  name: string
  version: string
  description: string
  media_types: string[]
  operations: string[]
  ready_operations: string[]
  chat_provider_operations?: string[]
  chat_runtime_generation?: number | null
  image_provider_operations?: string[]
  image_runtime_generation?: number | null
  video_provider_operations?: string[]
  video_runtime_generation?: number | null
  audio_provider_operations?: string[]
  audio_runtime_generation?: number | null
  workflow_provider_operations?: string[]
  workflow_runtime_generation?: number | null
  ready_media_types: string[]
  provider_types: string[]
  execution: 'direct' | 'gateway' | 'workflow' | 'connector' | string
  priority: number
}

/** 模型调用台账的一行（`invocation_view`）：SSE `event: invocation` 帧推的也是这个整快照 */
export interface ModelInvocation {
  id: string
  plugin_id: string
  plugin_version: string | null
  plugin_generation: number | null
  runtime_generation: number | null
  operation: string
  capability: string | null
  deployment_id: number | null
  task_id: string | null
  source: string | null
  canvas_id: number | null
  node_id: string | null
  flow_run_id: string | null
  tool_id: string | null
  request: Record<string, unknown> | null
  response: Record<string, unknown> | null
  provider_request_id: string | null
  model: string | null
  status: string
  usage: Record<string, unknown> | null
  latency_ms: number | null
  first_token_ms: number | null
  error_type: string | null
  error_message: string | null
  error_code: string | null
  parent_invocation_id: string | null
  attempt: number
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
  reasoning_tokens: number | null
  context: Record<string, unknown> | null
  created_at: string | null
  finished_at: string | null
}

export type ModelInvocationEventType =
  | 'request.header'
  | 'chunk.text'
  | 'chunk.reasoning'
  | 'chunk.tool_delta'
  | 'chunk.usage'
  | 'finish'
  | 'error'

/** 一次调用的逐步事件；`data.elapsed_ms` 是相对调用起点的毫秒数，首 token / 解码速率由它折算 */
export interface ModelInvocationEvent {
  id: number
  invocation_id: string
  seq: number
  type: ModelInvocationEventType | string
  time: string | null
  data: Record<string, unknown> | null
}

export interface ModelInvocationQuery {
  status?: string
  plugin_id?: string
  task_id?: string
  capability?: string
  canvas_id?: number
  node_id?: string
  flow_run_id?: string
  tool_id?: string
  source?: string
  error_code?: string
  /** ISO 8601；只看这个时刻之后创建的调用 */
  since?: string
  /** 上一页的 next_cursor；往旧翻 */
  cursor?: string | null
  limit?: number
}

export interface ModelInvocationPage {
  items: ModelInvocation[]
  next_cursor: string | null
}

function invocationQueryString(query: ModelInvocationQuery): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    params.set(key, String(value))
  }
  const text = params.toString()
  return text === '' ? '' : `?${text}`
}

export interface ModelDeployment {
  id: number
  credential_id: number
  credential_name: string | null
  provider_type: string | null
  upstream_model_id: string
  display_name: string | null
  adapter_type: string
  media_types: string[]
  protocol_options: Record<string, unknown> | null
  discovered: boolean
  enabled: boolean
  sort: number
  created_at: string | null
  updated_at: string | null
}

export interface ModelDeploymentDraft {
  credential_id: number
  upstream_model_id: string
  display_name?: string | null
  adapter_type: string
  media_types: string[]
  protocol_options?: Record<string, unknown> | null
  enabled?: boolean
  sort?: number
}

export interface ModelScopeLora {
  id: number
  credential_id: number
  lora_id: string
  display_name: string | null
  target_model: string
  default_strength: number
  enabled: boolean
  note: string | null
  created_at: string | null
  updated_at: string | null
}

export interface ModelScopeLoraDraft {
  credential_id: number
  lora_id: string
  display_name?: string | null
  target_model: string
  default_strength?: number
  enabled?: boolean
  note?: string | null
}

export interface FallbackEntry {
  credential_id: number
  target: string
  /** 有值时选路直接用这条部署；缺省按 credential_id + target 找同名启用部署（直连优先） */
  deployment_id?: number | null
}

/** 能力分组，决定绑定表这一行长什么样：模型能力挑部署，朗读/实时挑凭据+音色，翻译链只排引擎 */
export type CapabilityGroup = 'llm' | 'image' | 'voice' | 'realtime' | 'translate'

export interface ReadyPlugin {
  id: string
  name: string
  execution: string
}

/** 该能力可选的部署（启用、凭据启用、媒体类型匹配）；adapter 没接线时 ready=false */
export interface DeploymentOption extends ModelDeployment {
  ready: boolean
}

/** /config/bindings 一行：全部能力都有行，未绑定的 bound=false；元数据随行返回，前端不留副本 */
export interface Binding {
  capability: string
  credential_id: number | null
  deployment_id: number | null
  target: string | null
  params: Record<string, unknown> | null
  fallback: FallbackEntry[] | null
  healthy: boolean
  bound: boolean
  label: string
  description: string
  group: CapabilityGroup
  /** chat / image / audio；翻译链为 null */
  media_type: string | null
  /** chat.complete / image.generate / audio.synthesize / realtime.session；翻译链为 null */
  operation: string | null
  /** 旧网关探针的提示词口径，仅 LLM 能力有 */
  test_kind: 'json' | 'text' | null
  credential_name: string | null
  provider_type: string | null
  /** 当前绑定的部署整行（真名 / 供应商 / adapter）；旧式绑定或未绑定为 null */
  deployment: ModelDeployment | null
  ready_plugins: ReadyPlugin[]
  deployment_options: DeploymentOption[]
  /** 这条能力自己没挑模型，运行时用「全局默认模型」那条。全局默认自身与音色/生图恒为 false */
  follows_default: boolean
  /** 在服务端能力目录里有中文名。false 是库里的遗留行，只有 slug，不能当用途摆给用户 */
  known: boolean
}

/** 还没指到已登记部署的能力（GET /config/bindings/legacy） */
export interface LegacyBindingItem {
  capability: string
  reason: 'unbound' | 'no_deployment' | 'stale_deployment' | string
  credential_id: number | null
  credential_name: string | null
  provider_type: string | null
  target: string | null
  deployment_id: number | null
  adapter_type: string | null
  suggested_adapter: string | null
  /** 同凭据同模型已有一条可用部署，有就能一键改绑过去 */
  direct_deployment_id: number | null
}

export interface LegacyBindings {
  count: number
  items: LegacyBindingItem[]
}

export type LlmProbeErrorType =
  | 'connect'
  | 'timeout'
  | 'auth'
  | 'status'
  | 'empty'
  | 'route'
  | 'error'

/** POST /llm/test 经插件层真实调用一次的结果；记入台账 source=probe */
export interface LlmProbeResult {
  ok: boolean
  capability: string
  model: string | null
  plugin_id: string | null
  selection_source: string | null
  deployment_id: number | null
  transport: string | null
  latency_ms: number
  sample: string | null
  usage: Record<string, unknown> | null
  error_type: LlmProbeErrorType | string | null
  error: string | null
}

export interface PutBindingBody {
  credential_id?: number | null
  deployment_id?: number | null
  target?: string | null
  params?: Record<string, unknown> | null
  fallback?: FallbackEntry[] | null
}

export interface AuditEntry {
  id: number
  action: string
  summary: string
  created_at: string
}

export interface StorageStats {
  tts_cache_mb?: number
  local_models_mb?: number
  analysis_rows?: number
  media_mb?: number
  [k: string]: unknown
}

export interface ClearCacheResult {
  cleared_mb: number
  files: number
}

/** 删除凭据 409 的 detail 解析为受影响能力列表；其他错误返回 null */
export function parseCredDeleteConflict(err: unknown): string[] | null {
  if (!(err instanceof ApiConfigError) || err.status !== 409) return null
  const d = err.detail as { bindings?: unknown } | null
  if (d === null || typeof d !== 'object' || !Array.isArray(d.bindings)) return []
  return d.bindings.filter((b): b is string => typeof b === 'string')
}

/* ---- 出口 ---- */

export const apiConfig = {
  providerTypes: () => request<ProviderType[]>('/api/config/provider-types'),

  modelPlugins: () => request<ModelPlugin[]>('/api/config/model-plugins'),

  modelInvocations: (query: ModelInvocationQuery = {}) =>
    request<ModelInvocationPage>(
      `/api/config/model-invocations${invocationQueryString({ limit: 100, ...query })}`,
    ),

  /** 一次调用的逐步事件（按 seq 升序），连同台账行当前快照 */
  modelInvocationEvents: (id: string, after = 0) =>
    request<{ invocation: ModelInvocation; items: ModelInvocationEvent[] }>(
      `/api/config/model-invocations/${encodeURIComponent(id)}/events?after=${Math.max(0, after)}`,
    ),

  credentials: (kind: CredKind) =>
    request<Credential[]>(`/api/config/credentials?kind=${kind}`),

  createCredential: (body: {
    name: string
    kind: CredKind
    provider_type: string
    config: Record<string, string>
  }) => request<Credential>('/api/config/credentials', jsonInit('POST', body)),

  /** 只测试当前表单草稿；不保存配置、不改凭据状态。 */
  probeCredential: (body: CredentialProbeDraft) =>
    request<CredTestResult>('/api/config/credential-probe', jsonInit('POST', body)),

  /** 本机探测该类型的可执行文件、默认配置路径与登录态；后端未就绪时 404，调用方降级回手填 */
  credentialProbeReport: (providerType: string) =>
    request<CredentialProbeReport>(
      `/api/config/credentials/probe?provider_type=${encodeURIComponent(providerType)}`,
    ),

  /** 密码字段留空/缺字段 = 不修改 */
  updateCredential: (
    id: number,
    body: { name?: string; enabled?: boolean; config?: Record<string, string> },
  ) => request<Credential>(`/api/config/credentials/${id}`, jsonInit('PATCH', body)),

  deleteCredential: (id: number, force = false) =>
    request<{ ok?: boolean }>(`/api/config/credentials/${id}${force ? '?force=true' : ''}`, {
      method: 'DELETE',
    }),

  refreshModels: (id: number) =>
    request<RefreshModelsResult>(`/api/config/credentials/${id}/refresh-models`, {
      method: 'POST',
    }),

  voiceProbe: (body: { credential_id?: number; voice?: string; capability?: string }) =>
    request<ServiceProbeResult>('/api/config/voice-probe', jsonInit('POST', body)),

  realtimeProbe: (capability: string) =>
    request<ServiceProbeResult>('/api/config/realtime-probe', jsonInit('POST', { capability })),

  realtimeVoiceProbe: (credential_id: number, voice: string) =>
    request<ServiceProbeResult>('/api/config/realtime-probe', jsonInit('POST', { credential_id, voice, preview: true })),

  translationProbe: (engine: 'auto' | 'llm' | 'google' | 'bing') =>
    request<ServiceProbeResult>('/api/config/translation-probe', jsonInit('POST', { engine })),

  modelDeployments: (filters?: {
    credential_id?: number
    media_type?: string
    enabled?: boolean
  }) => {
    const query = new URLSearchParams()
    if (filters?.credential_id !== undefined) {
      query.set('credential_id', String(filters.credential_id))
    }
    if (filters?.media_type !== undefined) query.set('media_type', filters.media_type)
    if (filters?.enabled !== undefined) query.set('enabled', String(filters.enabled))
    const suffix = query.size > 0 ? `?${query.toString()}` : ''
    return request<ModelDeployment[]>(`/api/config/model-deployments${suffix}`)
  },

  createModelDeployment: (body: ModelDeploymentDraft) =>
    request<ModelDeployment>('/api/config/model-deployments', jsonInit('POST', body)),

  updateModelDeployment: (
    id: number,
    body: Partial<
      Pick<
        ModelDeploymentDraft,
        'display_name' | 'adapter_type' | 'media_types' | 'protocol_options' | 'enabled' | 'sort'
      >
    >,
  ) =>
    request<ModelDeployment>(
      `/api/config/model-deployments/${id}`,
      jsonInit('PATCH', body),
    ),

  deleteModelDeployment: (id: number, force = false) =>
    request<{ deleted: number; cleared_bindings: string[] }>(
      `/api/config/model-deployments/${id}${force ? '?force=true' : ''}`,
      { method: 'DELETE' },
    ),

  modelscopeLoras: (filters?: {
    credential_id?: number
    target_model?: string
    enabled?: boolean
  }) => {
    const query = new URLSearchParams()
    if (filters?.credential_id !== undefined) {
      query.set('credential_id', String(filters.credential_id))
    }
    if (filters?.target_model !== undefined) {
      query.set('target_model', filters.target_model)
    }
    if (filters?.enabled !== undefined) query.set('enabled', String(filters.enabled))
    const suffix = query.size > 0 ? `?${query.toString()}` : ''
    return request<ModelScopeLora[]>(`/api/config/modelscope-loras${suffix}`)
  },

  createModelscopeLora: (body: ModelScopeLoraDraft) =>
    request<ModelScopeLora>('/api/config/modelscope-loras', jsonInit('POST', body)),

  updateModelscopeLora: (
    id: number,
    body: Partial<
      Pick<
        ModelScopeLoraDraft,
        'display_name' | 'target_model' | 'default_strength' | 'enabled' | 'note'
      >
    >,
  ) =>
    request<ModelScopeLora>(
      `/api/config/modelscope-loras/${id}`,
      jsonInit('PATCH', body),
    ),

  deleteModelscopeLora: (id: number) =>
    request<{ deleted: number }>(`/api/config/modelscope-loras/${id}`, {
      method: 'DELETE',
    }),

  testCredential: (id: number) =>
    request<CredTestResult>(`/api/config/credentials/${id}/test`, { method: 'POST' }),

  testVolcengineAssets: (id: number) =>
    request<VolcengineAssetDiagnostic>(
      `/api/config/credentials/${id}/volcengine-assets/test`,
      { method: 'POST' },
    ),

  createVolcengineAsset: (
    id: number,
    body: {
      public_url: string
      name: string
      kind: 'image' | 'video' | 'audio'
      group_name?: string
    },
  ) =>
    request<VolcenginePrivateAsset>(
      `/api/config/credentials/${id}/volcengine-assets`,
      jsonInit('POST', body),
    ),

  volcengineAsset: (id: number, assetId: string) =>
    request<VolcenginePrivateAsset>(
      `/api/config/credentials/${id}/volcengine-assets/${encodeURIComponent(assetId)}`,
    ),

  cliStatus: (id: number) =>
    request<CliStatus>(`/api/config/credentials/${id}/cli-status`),

  cliHelp: (id: number, command = '') =>
    request<{ text: string }>(
      `/api/config/credentials/${id}/cli-help`,
      jsonInit('POST', { command }),
    ),

  cliLogin: (id: number) =>
    request<CliLoginStatus>(`/api/config/credentials/${id}/cli-login`, { method: 'POST' }),

  cliLoginStatus: (id: number) =>
    request<CliLoginStatus>(`/api/config/credentials/${id}/cli-login`),

  cliLogout: (id: number) =>
    request<{ logged_in: boolean; text: string }>(
      `/api/config/credentials/${id}/cli-logout`,
      { method: 'POST' },
    ),

  bindings: () => request<Binding[]>('/api/config/bindings'),

  bindingsLegacy: () => request<LegacyBindings>('/api/config/bindings/legacy'),

  putBinding: (capability: string, body: PutBindingBody) =>
    request<Binding>(
      `/api/config/bindings/${encodeURIComponent(capability)}`,
      jsonInit('PUT', body),
    ),

  /** 把一条能力改回「跟随全局默认模型」。PUT 做不到——它要求必填 credential_id 或 deployment_id */
  clearBinding: (capability: string) =>
    request<Binding>(`/api/config/bindings/${encodeURIComponent(capability)}`, { method: 'DELETE' }),

  /** 经插件层真实调一次该能力（绑到哪个部署就测哪个）；指定 deployment_id 时绕过绑定测那条部署 */
  llmTest: (capability: string, deploymentId?: number | null) =>
    request<LlmProbeResult>(
      '/api/llm/test',
      jsonInit('POST', {
        alias: capability,
        ...(deploymentId !== undefined && deploymentId !== null
          ? { deployment_id: deploymentId }
          : {}),
      }),
    ),

  /** 偏好整包：无数据时返回 {}；PUT 为顶层 key 合并 */
  network: () => request<NetworkPolicy>('/api/config/network'),
  saveNetwork: (value: NetworkPolicy) => request<NetworkPolicy>('/api/config/network', jsonInit('PUT', value)),
  probeNetwork: (value: NetworkPolicy) => request<NetworkProbe>('/api/config/network/probe', jsonInit('POST', value)),

  getPrefs: () => request<unknown>('/api/config/prefs'),

  putPrefs: (prefs: unknown) => request<unknown>('/api/config/prefs', jsonInit('PUT', prefs)),

  audit: (limit = 20) => request<AuditEntry[]>(`/api/config/audit?limit=${limit}`),

  storageStats: () => request<StorageStats>('/api/config/storage-stats'),

  clearTtsCache: () =>
    request<ClearCacheResult>('/api/config/clear-tts-cache', { method: 'POST' }),

  clearLocalModels: () =>
    request<ClearCacheResult>('/api/config/clear-local-models', { method: 'POST' }),
}

/* ---- 账本实时帧 ----
   任务事件流每轮附带 `event: invocation` 帧（台账行整快照，不带 id 行，不推进游标）。
   账本页只消费这一类帧、不需要任务游标，所以单独开一条连接，并把 after 设成最大安全整数：
   服务端不会为这条连接回放历史任务事件，也不再推 task 帧。断线按指数退避（1s→30s）重建，
   订阅者归零即关闭。并入 features/studio/taskEvents.ts 的 TaskStreamController 是后续事项。 */

const INVOCATION_STREAM_PATH = '/api/studio/tasks/events/stream'
const INVOCATION_BACKOFF_BASE_MS = 1000
const INVOCATION_BACKOFF_MAX_MS = 30_000

type InvocationListener = (row: ModelInvocation) => void

function isInvocationRow(value: unknown): value is ModelInvocation {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Partial<ModelInvocation>
  return (
    typeof row.id === 'string' && typeof row.status === 'string' && typeof row.plugin_id === 'string'
  )
}

class InvocationStream {
  private readonly listeners = new Set<InvocationListener>()
  private source: EventSource | null = null
  private generation = 0
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  subscribe(listener: InvocationListener): () => void {
    this.listeners.add(listener)
    this.connect()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.close()
    }
  }

  private connect(): void {
    if (this.source !== null || this.listeners.size === 0) return
    if (typeof EventSource === 'undefined') return
    this.clearTimer()
    const generation = ++this.generation
    const source = new EventSource(`${INVOCATION_STREAM_PATH}?after=${Number.MAX_SAFE_INTEGER}`)
    this.source = source
    source.onopen = () => {
      if (generation === this.generation) this.attempt = 0
    }
    source.onerror = () => {
      if (generation !== this.generation) return
      this.drop()
      this.reconnect()
    }
    source.addEventListener('invocation', (raw: Event) => {
      if (generation !== this.generation) return
      let parsed: unknown = null
      try {
        parsed = JSON.parse((raw as MessageEvent<string>).data)
      } catch {
        return
      }
      if (!isInvocationRow(parsed)) return
      for (const listener of this.listeners) {
        try {
          listener(parsed)
        } catch (error) {
          console.error('[invocation-stream] 订阅者处理帧失败', error)
        }
      }
    })
  }

  private drop(): void {
    if (this.source === null) return
    this.source.onopen = null
    this.source.onerror = null
    this.source.close()
    this.source = null
  }

  private reconnect(): void {
    if (this.timer !== null || this.listeners.size === 0) return
    const delay = Math.min(INVOCATION_BACKOFF_MAX_MS, INVOCATION_BACKOFF_BASE_MS * 2 ** this.attempt)
    this.attempt += 1
    this.timer = setTimeout(() => {
      this.timer = null
      this.connect()
    }, delay)
  }

  private clearTimer(): void {
    if (this.timer === null) return
    clearTimeout(this.timer)
    this.timer = null
  }

  private close(): void {
    this.generation += 1
    this.clearTimer()
    this.drop()
    this.attempt = 0
  }
}

const invocationStream = new InvocationStream()

/** 订阅台账行整快照帧：新建（running）与终态各推一次，同一状态不重复 */
export function subscribeInvocationFrames(listener: InvocationListener): () => void {
  return invocationStream.subscribe(listener)
}
