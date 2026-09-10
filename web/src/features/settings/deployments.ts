/* 模型部署（第二层）的纯逻辑：媒体能力对账、草稿校验、按凭据分组。

   这一层回答的是「这家供应商下我要登记哪些真实模型、用哪个适配器调」。
   能力绑定（第三层）只能从这里登记过的部署里挑，所以校验要在这里就把
   「adapter 不支持该媒体类型」挡住，别让用户存下一条永远选不出来的部署。 */

import type { Credential, ModelDeployment, ModelPlugin } from '../../lib/api-config'

export const MEDIA_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ['chat', '对话'],
  ['image', '图片'],
  ['video', '视频'],
  ['audio', '音频'],
  ['workflow', '工作流'],
]

export const MEDIA_LABELS: Record<string, string> = Object.fromEntries(MEDIA_OPTIONS)

export function mediaLabel(media: string): string {
  return MEDIA_LABELS[media] ?? media
}

/** 按供应商类型挑默认适配器；认不出就按 OpenAI 兼容线协议兜底 */
export function adapterForProviderType(plugins: ModelPlugin[], providerType: string): string {
  const hit = plugins.find((plugin) => plugin.provider_types.includes(providerType))
  return hit?.id ?? 'openai'
}

/** 这个 adapter 已经接线的媒体类型（部署选了但没接线的不算） */
export function readyMediaOf(
  plugins: ModelPlugin[],
  adapterType: string,
  mediaTypes: string[],
): string[] {
  const ready = plugins.find((plugin) => plugin.id === adapterType)?.ready_media_types ?? []
  return mediaTypes.filter((media) => ready.includes(media))
}

/** adapter 声明都不支持的媒体类型：存下去也用不了，保存前要拦 */
export function unsupportedMediaOf(
  plugins: ModelPlugin[],
  adapterType: string,
  mediaTypes: string[],
): string[] {
  const plugin = plugins.find((item) => item.id === adapterType)
  if (plugin === undefined) return []
  return mediaTypes.filter((media) => !plugin.media_types.includes(media))
}

export interface DeploymentDraftInput {
  credentialId: number | null
  model: string
  adapter: string
  mediaTypes: string[]
}

/** 表单草稿校验；通过返回 null，否则返回给用户看的那一句 */
export function validateDeploymentDraft(
  input: DeploymentDraftInput,
  plugins: ModelPlugin[],
): string | null {
  if (input.credentialId === null) return '先选一条供应商凭据'
  if (input.model.trim() === '') return '填写供应商那边的真实模型名'
  if (input.adapter === '') return '选择调用适配器'
  if (input.mediaTypes.length === 0) return '至少勾选一种媒体能力'
  const unsupported = unsupportedMediaOf(plugins, input.adapter, input.mediaTypes)
  if (unsupported.length > 0) {
    const name = plugins.find((item) => item.id === input.adapter)?.name ?? input.adapter
    return `${name} 不支持${unsupported.map(mediaLabel).join('、')}，换适配器或去掉这些能力`
  }
  return null
}

export interface DeploymentGroup {
  credentialId: number
  credentialName: string
  providerType: string | null
  rows: ModelDeployment[]
  enabledCount: number
}

/** 按凭据把部署归堆：「先接供应商 → 再登记这家的哪些模型」这条叙事在列表上也要看得见。
    堆的顺序用 credential_id——与上一层凭据卡片的顺序（服务端按 id 排）逐一对应，
    换成按名字排会让两层的行序对不上。堆内启用的排前面，其次按 sort 与模型名。 */
export function groupDeployments(
  rows: ModelDeployment[],
  credentials: Credential[] = [],
): DeploymentGroup[] {
  const nameOf = new Map(credentials.map((cred) => [cred.id, cred.name]))
  const groups = new Map<number, DeploymentGroup>()
  for (const row of rows) {
    let group = groups.get(row.credential_id)
    if (group === undefined) {
      group = {
        credentialId: row.credential_id,
        credentialName:
          nameOf.get(row.credential_id) ?? row.credential_name ?? `凭据 #${row.credential_id}`,
        providerType: row.provider_type,
        rows: [],
        enabledCount: 0,
      }
      groups.set(row.credential_id, group)
    }
    group.rows.push(row)
    if (row.enabled) group.enabledCount += 1
  }
  const out = [...groups.values()]
  for (const group of out) {
    group.rows.sort(
      (a, b) =>
        Number(b.enabled) - Number(a.enabled) ||
        a.sort - b.sort ||
        a.upstream_model_id.localeCompare(b.upstream_model_id, 'en') ||
        a.id - b.id,
    )
  }
  out.sort((a, b) => a.credentialId - b.credentialId)
  return out
}

/** 模型名 / 显示名 / 适配器上的模糊筛选（大小写不敏感） */
export function filterDeployments(rows: ModelDeployment[], keyword: string): ModelDeployment[] {
  const needle = keyword.trim().toLowerCase()
  if (needle === '') return rows
  return rows.filter((row) =>
    [row.upstream_model_id, row.display_name ?? '', row.adapter_type, row.credential_name ?? '']
      .join(' ')
      .toLowerCase()
      .includes(needle),
  )
}

export interface DeploymentStats {
  total: number
  enabled: number
  credentials: number
  /** 适配器没接线，绑定表里永远选不出来的那些 */
  unwired: number
}

export function deploymentStats(
  rows: ModelDeployment[],
  plugins: ModelPlugin[],
): DeploymentStats {
  let enabled = 0
  let unwired = 0
  const credentials = new Set<number>()
  for (const row of rows) {
    credentials.add(row.credential_id)
    if (row.enabled) enabled += 1
    if (readyMediaOf(plugins, row.adapter_type, row.media_types).length === 0) unwired += 1
  }
  return { total: rows.length, enabled, credentials: credentials.size, unwired }
}

/* ---- 调用协议（protocol_options）：只有图片线需要，其余 adapter 不下发 ---- */

export const IMAGE_REQUEST_MODES: ReadonlyArray<{
  value: string
  label: string
  hint: string
}> = [
  { value: 'openai', label: 'OpenAI 标准', hint: 'images/generations 与 edits' },
  { value: 'openai-json', label: 'OpenAI JSON', hint: 'JSON 参考图兼容' },
  { value: 'openai-video-proxy', label: 'OpenAI 图片中转', hint: 'videos 异步代理' },
  { value: 'openai-responses', label: 'OpenAI Responses', hint: 'background / SSE' },
  { value: 'tudou-async', label: '土豆异步', hint: 'GPT-Image-2 task 轮询' },
]

const PATH_KEYS = ['generation_path', 'responses_path', 'video_proxy_path', 'task_path_template']
const NUMBER_KEYS = ['poll_interval', 'initial_poll_delay', 'task_timeout']

export const PROTOCOL_KEYS = [...PATH_KEYS, ...NUMBER_KEYS]

/** 该 adapter + 媒体组合下实际生效的图片请求模式（apimart / tudou 固定，其余听表单的） */
export function effectiveImageMode(adapter: string, requestMode: string): string {
  if (adapter === 'apimart') return 'apimart'
  if (adapter === 'tudou') return 'tudou-async'
  return requestMode
}

/** 只有图片线的这几个 adapter 需要请求模式与路径 */
export function supportsImageProtocol(adapter: string, mediaTypes: string[]): boolean {
  return mediaTypes.includes('image') && ['openai', 'apimart', 'tudou'].includes(adapter)
}

/** 表单值 → protocol_options；空串一律删键，全空返回 null（别存一个空对象进库） */
export function buildProtocolOptions(
  base: Record<string, unknown> | null,
  adapter: string,
  requestMode: string,
  fields: Record<string, string>,
): Record<string, unknown> | null {
  const next: Record<string, unknown> = { ...(base ?? {}) }
  if (adapter === 'openai') next.image_request_mode = requestMode
  else delete next.image_request_mode
  for (const key of PATH_KEYS) {
    const value = (fields[key] ?? '').trim()
    if (value === '') delete next[key]
    else next[key] = value
  }
  for (const key of NUMBER_KEYS) {
    const value = (fields[key] ?? '').trim()
    if (value === '' || !Number.isFinite(Number(value))) delete next[key]
    else next[key] = Number(value)
  }
  return Object.keys(next).length > 0 ? next : null
}

/** protocol_options → 表单初值（数字也转成字符串，输入框只吃字符串） */
export function protocolFieldValues(
  options: Record<string, unknown> | null | undefined,
): Record<string, string> {
  return Object.fromEntries(
    PROTOCOL_KEYS.map((key) => {
      const value = options?.[key]
      return [key, value === undefined || value === null ? '' : String(value)]
    }),
  )
}
