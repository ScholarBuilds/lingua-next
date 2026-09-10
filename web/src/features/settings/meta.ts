/* 配置中心静态元数据：品牌映射 / 文案与格式化 / 试听样例。
   能力清单（键、名称、说明、分组）不再有前端副本：全部由 GET /config/bindings 随行返回，
   这里只留纯 UI 的东西。capName 读的是最近一次绑定响应缓存下来的名称。 */

import type { TtsScene } from '../../lib/audio'

/* ---- 能力名称缓存：凭据删除冲突提示等处要把 capability 键翻成中文 ---- */

const CAP_LABELS = new Map<string, string>()

/** 绑定响应到达时记下 capability → label，后续 capName 直接查 */
export function rememberCapLabels(rows: Array<{ capability: string; label?: string }>): void {
  for (const row of rows) {
    if (typeof row.label === 'string' && row.label !== '') CAP_LABELS.set(row.capability, row.label)
  }
}

/** capability 键 → 中文名；没缓存过就原样返回键名 */
export function capName(key: string): string {
  return CAP_LABELS.get(key) ?? key
}

/* ---- 朗读试听样例：按场景给一句示例文本（纯 UI，不是能力清单） ---- */

const TTS_SCENE_KEYS = new Set<TtsScene>(['word', 'sentence', 'chapter', 'vocab', 'video', 'assistant', 'meaning'])

const TTS_SAMPLES: Record<TtsScene, string> = {
  word: 'serendipity',
  sentence: 'Mr. Darcy soon drew the attention of the room.',
  chapter:
    'It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.',
  vocab: 'vocabulary',
  video: 'Welcome back to the channel.',
  // 助理回复中英混说，试听样例也得混：单读英文听不出这档音色念不念得了中文
  assistant: '找到了 Sherlock Holmes，要打开吗？',
  // 释义是纯中文，试听就该念中文
  meaning: '苹果，苹果树，苹果公司',
}

/** tts-word → word；不是朗读能力返回 null */
export function ttsSceneOf(capability: string): TtsScene | null {
  if (!capability.startsWith('tts-')) return null
  const scene = capability.slice(4) as TtsScene
  return TTS_SCENE_KEYS.has(scene) ? scene : null
}

export function ttsSampleOf(capability: string): { scene: TtsScene; sample: string } | null {
  const scene = ttsSceneOf(capability)
  return scene === null ? null : { scene, sample: TTS_SAMPLES[scene] }
}

/* ---- 品牌映射：provider_type → 圆标颜色 / 缩写 ---- */

interface Brand {
  bg: string
  abbr: string
  /** 场景绑定里的短名（如 火山 · Skye） */
  short?: string
}

const BRANDS: Record<string, Brand> = {
  deepseek: { bg: '#4D6BFE', abbr: 'DS', short: 'DeepSeek' },
  openai: { bg: '#10A37F', abbr: 'AI', short: 'OpenAI' },
  openai_compatible: { bg: '#8B8378', abbr: '兼', short: '中转' },
  apimart: { bg: '#111827', abbr: 'MJ', short: 'APIMart' },
  openai_tts: { bg: '#10A37F', abbr: 'AI', short: 'OpenAI' },
  volc_speech: { bg: '#1664FF', abbr: '火', short: '火山' },
  edge_tts: { bg: '#6B7280', abbr: 'E', short: 'Edge' },
  azure_speech: { bg: '#0078D4', abbr: 'Az', short: 'Azure' },
  zhipu: { bg: '#0F6FDE', abbr: '智', short: '智谱' },
  glm: { bg: '#0F6FDE', abbr: '智', short: '智谱' },
  ollama: { bg: '#1F1D1A', abbr: 'OL', short: 'Ollama' },
  anthropic: { bg: '#D97757', abbr: 'CL', short: 'Claude' },
  volc: { bg: '#1664FF', abbr: '火', short: '火山' },
  volcano: { bg: '#1664FF', abbr: '火', short: '火山' },
  edge: { bg: '#6B7280', abbr: 'E', short: 'Edge' },
  azure: { bg: '#0078D4', abbr: 'Az', short: 'Azure' },
  google: { bg: '#4285F4', abbr: 'G', short: 'Google' },
  kokoro: { bg: '#7C3AED', abbr: 'K', short: 'Kokoro' },
}

/** 未知类型的兜底：类型名哈希取色 + 前两位缩写 */
const FALLBACK_COLORS = ['#4F46E5', '#0E7490', '#B45309', '#15803D', '#9333EA', '#B91C1C']

export function brandOf(providerType: string): Brand {
  const key = providerType.toLowerCase()
  const hit = BRANDS[key]
  if (hit) return hit
  const sub = Object.keys(BRANDS).find((k) => key.includes(k))
  if (sub) return BRANDS[sub]
  let hash = 0
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return {
    bg: FALLBACK_COLORS[hash % FALLBACK_COLORS.length],
    abbr: providerType.slice(0, 2).toUpperCase() || '?',
    short: providerType,
  }
}

/* ---- 文案 ---- */

/** 两套探针口径合在一张表：插件层 connect/timeout/auth/status/empty/route/error，
    旧网关 connect/timeout/schema/api */
export const TEST_ERROR_LABELS: Record<string, string> = {
  connect: '连接失败',
  timeout: '请求超时',
  auth: '鉴权失败',
  status: '上游返回错误状态',
  empty: '模型返回为空',
  route: '路由未解析',
  error: '调用异常',
  schema: 'schema 未通过',
  api: '上游 API 报错',
}

export function testErrorLabel(type: string | null | undefined): string {
  return TEST_ERROR_LABELS[type ?? ''] ?? '测试未通过'
}

/* ---- 语速：绑定 params.rate 为整数百分比（0=原速，25≈1.25×） ---- */

export const RATE_STEPS = [-25, -10, 0, 10, 25, 50]

export function ratePctToLabel(pct: number): string {
  const hundredths = Math.round(pct) + 100
  return `${(hundredths / 100).toFixed(hundredths % 10 === 0 ? 1 : 2)}×`
}

export function nextRatePct(cur: number): number {
  const idx = RATE_STEPS.indexOf(cur)
  if (idx === -1) return 0
  return RATE_STEPS[(idx + 1) % RATE_STEPS.length]
}

/* ---- 格式化 ---- */

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}

export function fmtUsd(v: number | null | undefined, digits = 4): string {
  if (v === null || v === undefined) return '—'
  return `$${v.toFixed(digits)}`
}

export function relTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return '未刷新'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '未刷新'
  const diff = Date.now() - t
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 172_800_000) return '昨天'
  return `${Math.floor(diff / 86_400_000)} 天前`
}

export function hhmm(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '--:--'
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
