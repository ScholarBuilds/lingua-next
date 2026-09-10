import { requestJson } from './http'

/* 音标与发音训练接口封装（模块 13）。
   领域错误与业务接口保持在本模块。 */

export class ApiPhoneticsError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiPhoneticsError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return requestJson<T>(`/api${path}`, init, (status, message) => new ApiPhoneticsError(status, message))
}

function jsonBody(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

/* ---- 音位卡片 ---- */

export interface SvgFrame {
  key: string
  label: string
}

export interface PhonemeDifficulty {
  low_score_rate: number
  mean_score: number
  sample_n: number
}

/** 示范音出处。BR-93 的来源可见原则同样适用于音频：
    「语音学家录的独立音位」与「从合成词里切的一段」是两回事，UI 要能区分。 */
export interface PhonemeAudio {
  url: string
  /** commons=独立音位录音；word-clip=从示范词里切 */
  strategy: 'commons' | 'word-clip'
  license: string
  /** CC BY-SA 3.0 要求署名，这行必须显示出来 */
  credit: string
  clip_word: string
}

export interface Phoneme {
  symbol: string
  symbol_us: string | null
  arpabet: string
  kind: 'vowel' | 'consonant'
  manner: string
  place: string
  voiced: boolean
  zh_name: string
  /** 按音素在词中的位置分组（FR-392g）：词首 / 词中 / 词尾 */
  examples: { initial?: string[]; medial?: string[]; final?: string[] }
  common_errors: string[]
  tips: string | null
  svg_frames: SvgFrame[]
  svg_note: string | null
  /** 元音四边形定位；辅音为 null */
  chart: { x: number; y: number } | null
  /** 双元音的滑动终点 */
  chart_to: { x: number; y: number } | null
  highlight: string[]
  contrast_with: string[]
  /** 来自 speechocean762 的普通话母语者标注；null 表示无数据，不等于「简单」 */
  difficulty: PhonemeDifficulty | null
  /** 音位本身的示范音。null 表示这个音位没有配音源 */
  audio: PhonemeAudio | null
}

export interface PhonemeOverview {
  items: Phoneme[]
  vowels: Phoneme[]
  consonants: Phoneme[]
  chart_credit: string
  svg_credit: string
}

export interface ContrastGroupRef {
  key: string
  a: string
  b: string
  title: string
  note: string
  scarce?: boolean
}

export interface PhonemeDetail extends Phoneme {
  example_details?: Record<
    string,
    { ipa_us: string | null; ipa_uk: string | null; source: string; gloss: string | null }
  >
  contrast_groups: ContrastGroupRef[]
}

/* ---- 听辨训练 ---- */

export interface ContrastGroup extends ContrastGroupRef {
  pairs: number
  state: string
  due: string | null
  due_now: boolean
  reps: number
  lapses: number
  trained_seconds: number
  hardness: number | null
}

export interface DrillQuestion {
  id: string
  widget: string
  prompt: string
  choices: string[]
  answer: number
  audio: { text: string; voice: string }
  meta: {
    pair_id: number
    group: string
    target: string
    target_ipa: string
    other: string
    other_ipa: string
    diff_index: number
    phone_a: string
    phone_b: string
    note?: string
  }
  misconceptions: { id: string; match: string; value: string; feedback: string }[]
}

export interface Drill {
  group: ContrastGroupRef
  questions: DrillQuestion[]
  voice_count: number
  pool: number
  freq_band: number
}

export interface DecodeQuestion {
  id: string
  widget: string
  prompt: string
  choices: string[]
  answer: number
  meta: { word: string; ipa: string; mode: string }
}

export interface ScoreResult {
  correct: boolean
  score: number
  misconception: string | null
  feedback: string | null
  detail: Record<string, unknown>
}

export interface Progress {
  target_seconds: number
  /** 只统计听辨训练：400 分钟那条线的依据只针对 identification */
  trained_seconds: number
  /** 认读题时长单列，不计入 HVPT 进度 */
  decode_seconds: number
  ratio: number
  groups: (ContrastGroupRef & {
    trained_seconds: number
    accuracy: { n: number; correct: number; rate: number } | null
  })[]
}

export interface WordPhonemes {
  word: string
  ipa_us: string | null
  ipa_uk: string | null
  arpabet: string | null
  syllables: number | null
  stress: string | null
  source: string
  symbols: string[]
  phones: { arpabet: string; symbol: string | null }[]
}

export const phoneticsApi = {
  overview: () => request<PhonemeOverview>('/phonetics/phonemes'),
  phoneme: (symbol: string) =>
    request<PhonemeDetail>(`/phonetics/phonemes/${encodeURIComponent(symbol)}`),
  word: (word: string) => request<WordPhonemes>(`/phonetics/word/${encodeURIComponent(word)}`),
  contrasts: () => request<{ items: ContrastGroup[]; voices: number }>('/phonetics/contrasts'),
  drill: (group: string, n = 10) =>
    request<Drill>(`/phonetics/drill?group=${encodeURIComponent(group)}&n=${n}`),
  decode: (mode: 'ipa2word' | 'word2ipa', n = 10) =>
    request<{ mode: string; questions: DecodeQuestion[] }>(
      `/phonetics/decode?mode=${mode}&n=${n}`,
    ),
  answer: (body: {
    kind: string
    card_key: string
    question: unknown
    response: unknown
    elapsed_ms?: number
  }) => request<ScoreResult>('/phonetics/answer', jsonBody('POST', body)),
  grade: (body: { kind: string; card_key: string; rating: number; items: number }) =>
    request<{ state: string; due: string; intervals: Record<string, string>; trained_seconds: number }>(
      '/phonetics/grade',
      jsonBody('POST', body),
    ),
  progress: () => request<Progress>('/phonetics/progress'),
}

/** 音位剖面图静态资源路径。CC0-1.0，可直接引用 */
export function svgUrl(key: string): string {
  return `/phonetics/${key}.svg`
}

/** TTS 播放地址：voice 带 `edge:` / `volc:` 前缀由服务端路由 */
export function ttsUrl(text: string, voice?: string): string {
  const q = new URLSearchParams({ text, scene: 'word' })
  if (voice) q.set('voice', voice)
  return `/api/tts?${q.toString()}`
}
