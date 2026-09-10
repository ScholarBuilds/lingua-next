import type { ModelDeployment, ModelPlugin } from '@/lib/api-config'

export const GPT_ATTACHMENT_MAX = 20

export type GptModelScope = 'chat' | 'image'
export type GptImageSizeMode = 'auto' | 'preset' | 'custom'
export type GptImageRatio =
  | 'square'
  | 'portrait'
  | 'portrait43'
  | 'landscape43'
  | 'landscape'
  | 'story'
  | 'wide'
export type GptImageLevel = '1k' | '2k' | '4k'

export const GPT_RATIO_LABELS: Record<GptImageRatio, string> = {
  square: '1:1',
  portrait: '2:3',
  portrait43: '3:4',
  landscape43: '4:3',
  landscape: '3:2',
  story: '9:16',
  wide: '16:9',
}

/**
 * Infinite-Canvas 原预设中少数尺寸不是 16 的倍数，会被 Lingua 的生图边界直接拒绝。
 * 这里保留同样的 7 种比例和 1K/2K/4K 层级，只把不合法边长就近对齐。
 */
export const GPT_IMAGE_SIZES: Record<GptImageRatio, Record<GptImageLevel, string>> = {
  square: { '1k': '1024x1024', '2k': '1536x1536', '4k': '2048x2048' },
  portrait: { '1k': '720x1072', '2k': '1024x1536', '4k': '1360x2048' },
  portrait43: { '1k': '1008x1344', '2k': '1536x2048', '4k': '2448x3264' },
  landscape43: { '1k': '1344x1008', '2k': '2048x1536', '4k': '3264x2448' },
  landscape: { '1k': '1072x720', '2k': '1536x1024', '4k': '2048x1360' },
  story: { '1k': '720x1280', '2k': '1088x1920', '4k': '1440x2560' },
  wide: { '1k': '1280x720', '2k': '1920x1088', '4k': '2560x1440' },
}

const IMAGE_MODEL = /(?:^|[-_/.])(gpt[-_]?image|dall[-_]?e|imagen|flux|stable[-_ ]?diffusion|sdxl|z[-_]?image|qwen[-_]?image|seedream|hidream|ideogram|recraft|kolors|nano[-_]?banana)(?:$|[-_/.])/i

export function isImageDeployment(deployment: ModelDeployment): boolean {
  if (deployment.media_types.length > 0) return deployment.media_types.includes('image')
  return IMAGE_MODEL.test(deployment.upstream_model_id)
}

export function isChatDeployment(deployment: ModelDeployment): boolean {
  if (deployment.media_types.length > 0) return deployment.media_types.includes('chat')
  return !isImageDeployment(deployment)
}

export function deploymentSupports(
  deployment: ModelDeployment,
  plugins: ModelPlugin[],
  operation: 'chat.stream' | 'image.generate',
): boolean {
  const plugin = plugins.find((item) => item.id === deployment.adapter_type)
  return plugin?.ready_operations.includes(operation) === true
}

export function gptDeploymentsForScope(
  deployments: ModelDeployment[],
  plugins: ModelPlugin[],
  scope: GptModelScope,
): ModelDeployment[] {
  const operation = scope === 'chat' ? 'chat.stream' : 'image.generate'
  return deployments.filter((deployment) =>
    deploymentSupports(deployment, plugins, operation)
    && (scope === 'chat' ? isChatDeployment(deployment) : isImageDeployment(deployment)))
}

export function validateGptCustomSize(width: number, height: number): string | null {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null
  if (width < 256 || height < 256 || width > 3840 || height > 3840) return null
  if (width % 16 !== 0 || height % 16 !== 0) return null
  const ratio = width / height
  if (ratio < 1 / 3 || ratio > 3) return null
  return `${width}x${height}`
}

function ratioFromText(text: string): GptImageRatio | null {
  const normalized = text.replace(/：/g, ':')
  const entries = Object.entries(GPT_RATIO_LABELS) as Array<[GptImageRatio, string]>
  for (const [ratio, label] of entries) {
    const [left, right] = label.split(':')
    if (new RegExp(`(?:^|\\D)${left}\\s*:\\s*${right}(?:\\D|$)`).test(normalized)) return ratio
  }
  if (/竖版|竖屏|人像|portrait/i.test(text)) return 'portrait'
  if (/横版|横屏|风景|landscape|wide/i.test(text)) return 'landscape'
  if (/方形|正方形|square/i.test(text)) return 'square'
  return null
}

function levelFromText(text: string): GptImageLevel {
  if (/(?:^|\D)4\s*k(?:\D|$)|4k|4096/i.test(text)) return '4k'
  if (/(?:^|\D)2\s*k(?:\D|$)|2k|2048/i.test(text)) return '2k'
  return '1k'
}

export function autoGptImageSize(prompt: string): string {
  const exact = prompt.match(/(?:^|\D)(\d{3,4})\s*[x×*]\s*(\d{3,4})(?:\D|$)/i)
  if (exact !== null) {
    const validated = validateGptCustomSize(Number(exact[1]), Number(exact[2]))
    if (validated !== null) return validated
  }
  const ratio = ratioFromText(prompt) ?? 'square'
  return GPT_IMAGE_SIZES[ratio][levelFromText(prompt)]
}

export function resolveGptImageSize(
  mode: GptImageSizeMode,
  prompt: string,
  ratio: GptImageRatio,
  level: GptImageLevel,
  customWidth: number,
  customHeight: number,
): string | null {
  if (mode === 'auto') return autoGptImageSize(prompt)
  if (mode === 'preset') return GPT_IMAGE_SIZES[ratio][level]
  return validateGptCustomSize(customWidth, customHeight)
}


/* ==================== 长任务回执 ==================== */

/** 编辑、视频、工作流这些工具不当场出结果，只回一条回执；产物由任务中心那条事件流补。 */
export interface GptLiveTask {
  taskId: string
  operation: string
  label: string
  status: string
}

/** 把一个 task 事件并进这一轮已有的回执里。
 *
 *  同一个 task_id 只留一条并用后到的状态覆盖：重连后服务端会把这一轮的回执重发一遍，
 *  不去重的话界面上会出现两行一模一样的「已提交」。 */
export function appendLiveTask(tasks: GptLiveTask[], incoming: GptLiveTask): GptLiveTask[] {
  const at = tasks.findIndex((t) => t.taskId === incoming.taskId)
  if (at < 0) return [...tasks, incoming]
  const next = [...tasks]
  next[at] = { ...next[at], ...incoming }
  return next
}
