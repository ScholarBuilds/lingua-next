import { requestJson } from './http'

/* M5-FA 阅读器新增接口：阅读进度 / 批注 / 流式分析（SSE）/ 分析版本 / AI 陪读。
   JSON 请求共用传输层，流式响应与下载单独处理。 */

export class ReaderApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ReaderApiError'
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  return requestJson<T>(path, init, (status, message) => new ReaderApiError(status, message))
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

/* ---- 阅读进度 ---- */

export interface ReadingProgress {
  article_id: number
  last_paragraph_ordinal: number
  read_paragraph_ordinals: number[]
  duration_s: number
  updated_at?: string | null
}

export interface ProgressBody {
  article_id: number
  last_paragraph_ordinal: number
  read_paragraph_ordinals: number[]
  duration_s_delta: number
}

/** GET /articles/{id} 已带 progress 字段，但 lib/api.ts 的 Article 类型未声明（不改共享文件），
    用类型守卫从文章响应中取出。 */
export function articleProgressOf(article: unknown): ReadingProgress | null {
  if (article === null || typeof article !== 'object') return null
  const p = (article as { progress?: unknown }).progress
  if (p === null || p === undefined || typeof p !== 'object') return null
  const prog = p as Record<string, unknown>
  if (typeof prog.last_paragraph_ordinal !== 'number') return null
  return {
    article_id: typeof prog.article_id === 'number' ? prog.article_id : 0,
    last_paragraph_ordinal: prog.last_paragraph_ordinal,
    read_paragraph_ordinals: Array.isArray(prog.read_paragraph_ordinals)
      ? (prog.read_paragraph_ordinals as number[])
      : [],
    duration_s: typeof prog.duration_s === 'number' ? prog.duration_s : 0,
  }
}

/* ---- 批注 ---- */

export type AnnotationColor = 'yellow' | 'green' | 'pink' | 'blue'

/** 书签（FR-377）：段落级位置锚点，与批注的区间锚定分开 */
export interface Bookmark {
  id: number
  article_id: number
  paragraph_id: number
  paragraph_ordinal: number | null
  preview: string
  label: string | null
  created_at: string | null
}

export interface Annotation {
  id: number
  article_id: number
  paragraph_id: number
  char_start: number
  char_end: number
  color: AnnotationColor
  note: string | null
  created_at: string
  updated_at: string
  /** 列表 / 创建响应附带，PATCH 响应可能缺失 */
  paragraph_ordinal?: number
}

export interface CreateAnnotationBody {
  article_id: number
  paragraph_id: number
  char_start: number
  char_end: number
  color: AnnotationColor
  note?: string
}

/* ---- 流式 SSE（POST 无法用 EventSource，fetch + ReadableStream 手解） ---- */

export interface SseCallbacks {
  onDelta: (text: string) => void
  /** done 事件的 data 原样回传，由调用方按端点类型解释 */
  onDone: (data: unknown) => void
  onError: (status: number, message: string) => void
}

async function postSse(
  path: string,
  body: unknown,
  cb: SseCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  let resp: Response
  try {
    resp = await fetch(path, { ...jsonInit('POST', body), signal })
  } catch {
    if (!signal?.aborted) cb.onError(0, '网络连接失败')
    return
  }
  if (!resp.ok) {
    let detail = `请求失败 (${resp.status})`
    try {
      const data = (await resp.json()) as { detail?: unknown }
      if (typeof data.detail === 'string') detail = data.detail
    } catch {
      /* 保留默认信息 */
    }
    cb.onError(resp.status, detail)
    return
  }
  const ct = resp.headers.get('content-type') ?? ''
  if (!ct.includes('text/event-stream') || resp.body === null) {
    // 服务端未走流式时兜底：整体当一条 done
    try {
      cb.onDone(await resp.json())
    } catch {
      cb.onError(0, '响应解析失败')
    }
    return
  }

  const handleEvent = (raw: string): void => {
    let event = 'message'
    const dataLines: string[] = []
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
    }
    if (dataLines.length === 0) return
    let data: unknown
    try {
      data = JSON.parse(dataLines.join('\n'))
    } catch {
      return
    }
    const rec = data as Record<string, unknown>
    if (event === 'delta') cb.onDelta(typeof rec.text === 'string' ? rec.text : '')
    else if (event === 'done') cb.onDone(data)
    else if (event === 'error')
      cb.onError(200, typeof rec.message === 'string' ? rec.message : '生成失败')
  }

  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx = buf.indexOf('\n\n')
      while (idx >= 0) {
        handleEvent(buf.slice(0, idx))
        buf = buf.slice(idx + 2)
        idx = buf.indexOf('\n\n')
      }
    }
  } catch {
    if (!signal?.aborted) cb.onError(0, '连接中断')
  }
}

/* ---- TTS 音色（新契约：{voices, default_voice} + provider 分组；旧后端仍返回裸数组，做归一化兜底） ---- */

export type TtsProvider = 'volc' | 'edge'

export interface ReaderTtsVoice {
  /** 直接作为 /tts?voice= 参数（含 "volc:{id}" / "edge:{id}" 前缀或旧无前缀名） */
  name: string
  label: string
  provider: TtsProvider
  gender: string
  locale: string
}

export interface TtsVoicesResponse {
  voices: ReaderTtsVoice[]
  /** 服务端推荐默认音色；旧契约无此字段时为空串 */
  default_voice: string
}

/** en-US-AriaNeural → Aria · en-US（旧契约无 label 时兜底展示） */
function fallbackVoiceLabel(name: string): string {
  const bare = name.replace(/^(?:volc|edge):/, '')
  const m = /^([a-z]{2}-[A-Z]{2})-(.+?)(?:Multilingual)?Neural$/.exec(bare)
  return m ? `${m[2]} · ${m[1]}` : bare
}

function normalizeVoice(v: Record<string, unknown>): ReaderTtsVoice {
  const name = typeof v.name === 'string' ? v.name : ''
  const rawLabel = typeof v.label === 'string' ? v.label : ''
  return {
    name,
    // 后端 edge 音色的 label 可能就是原始名，一并走兜底美化
    label: rawLabel !== '' && rawLabel !== name ? rawLabel : fallbackVoiceLabel(name),
    // 服务端给的是 volc_speech / edge_tts，直接等值比较会把火山音色全判成 edge。
    // 音色名自带 "volc:" / "edge:" 前缀，按前缀认最稳
    provider:
      String(v.name ?? '').startsWith('volc:') || String(v.provider ?? '').startsWith('volc')
        ? 'volc'
        : 'edge',
    gender: typeof v.gender === 'string' ? v.gender : '',
    locale: typeof v.locale === 'string' ? v.locale : '',
  }
}

/* ---- 流式翻译 ---- */

export interface TranslateStreamDone {
  result: { text: string; engine: string }
  cached: boolean
}

export interface TranslateStreamCallbacks {
  onDelta: (text: string) => void
  onDone: (data: TranslateStreamDone) => void
  onError: (status: number, message: string) => void
}

/* ---- 流式分析 ---- */

export type StreamAnalyzeKind = 'word' | 'grammar' | 'sentence_deep' | 'phrase'

export interface AnalyzeDone<T> {
  result: T
  cached: boolean
  provider: string
  model: string
  version: string | number | null
}

export interface SentenceDeepResult {
  translation: string
  chunks: Array<{ en: string; zh: string }>
  collocations: Array<{ phrase: string; meaning: string }>
  structure_note: string
  culture_note?: string
}

export interface PhraseResult {
  meaning: string
  literal_vs_idiomatic: string
  usage_scenes: string[]
  example: { en: string; zh: string }
}

export interface AnalyzeStreamCallbacks<T> {
  onDelta: (text: string) => void
  onDone: (data: AnalyzeDone<T>) => void
  onError: (status: number, message: string) => void
}

/* ---- 分析版本 ---- */

export interface AnalysisVersion {
  id: number
  version: string | number | null
  provider: string
  model: string
  is_active: boolean
  created_at: string | null
}

export interface VersionQuery {
  scope: 'word' | 'sentence' | 'phrase'
  kind: 'word_explain' | 'grammar' | 'sentence_deep' | 'phrase'
  content_hash: string
  context_hash?: string
}

const WS_RE = /\s+/g

/** 与服务端 domain/analysis.content_key 一致：NFC → strip → 空白折叠 → sha256 hex */
export async function contentKey(text: string): Promise<string> {
  const normalized = text.normalize('NFC').trim().replace(WS_RE, ' ')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/* ---- AI 陪读 ---- */

export interface CompanionSession {
  id: number
  article_id: number | null
  mode: string
  started_at: string | null
  ended_at: string | null
  article_title?: string
  reused?: boolean
}

export interface CompanionTurn {
  id: number
  ordinal: number
  role: 'user' | 'assistant'
  text: string
  created_at: string | null
}

export interface CompanionHistory extends CompanionSession {
  turns: CompanionTurn[]
}

export interface CompanionAskDone {
  text: string
  model: string
  user_turn: CompanionTurn
  assistant_turn: CompanionTurn
}

export interface CompanionAskCallbacks {
  onDelta: (text: string) => void
  onDone: (data: CompanionAskDone) => void
  onError: (status: number, message: string) => void
}

/* ---- 出口 ---- */

/** 往次语音陪读记录（07 v2 FR-19） */
export interface CompanionHistoryItem {
  session_id: number
  started_at: string | null
  ended_at: string | null
  turns: Array<{ role: string; text: string }>
}

export const readerApi = {
  companionHistory: (params: { article_id?: number; video_id?: number; limit?: number }) => {
    const q = new URLSearchParams(
      Object.entries(params)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)]),
    )
    return req<CompanionHistoryItem[]>(`/api/talk/realtime/history?${q.toString()}`)
  },
  /* 进度 */
  postProgress: (body: ProgressBody) => req<ReadingProgress>('/api/progress', jsonInit('POST', body)),

  /** 页面卸载时的最后一发：sendBeacon 不阻塞卸载，失败静默 */
  sendProgressBeacon(body: ProgressBody): boolean {
    try {
      return navigator.sendBeacon(
        '/api/progress',
        new Blob([JSON.stringify(body)], { type: 'application/json' }),
      )
    } catch {
      return false
    }
  },

  /* 批注 */
  annotations: (articleId: number | string) =>
    req<Annotation[]>(`/api/articles/${articleId}/annotations`),

  /** 批量小译（FR-381）：一章的生词一次取回，不逐词请求 */
  gloss: (words: string[]) =>
    req<{ gloss: Record<string, string> }>('/api/dict/gloss', jsonInit('POST', { words })),

  /* 书签 */
  bookmarks: (articleId: number | string) =>
    req<Bookmark[]>(`/api/articles/${articleId}/bookmarks`),

  createBookmark: (body: { article_id: number; paragraph_id: number; label?: string }) =>
    req<Bookmark>('/api/bookmarks', jsonInit('POST', body)),

  deleteBookmark: (id: number) =>
    req<{ ok: boolean }>(`/api/bookmarks/${id}`, { method: 'DELETE' }),

  createAnnotation: (body: CreateAnnotationBody) =>
    req<Annotation>('/api/annotations', jsonInit('POST', body)),

  updateAnnotation: (id: number, patch: { color?: AnnotationColor; note?: string }) =>
    req<Annotation>(`/api/annotations/${id}`, jsonInit('PATCH', patch)),

  deleteAnnotation: (id: number) => req<unknown>(`/api/annotations/${id}`, { method: 'DELETE' }),

  async exportAnnotationsMarkdown(articleId: number | string): Promise<string> {
    let resp: Response
    try {
      resp = await fetch(`/api/annotations/export?article_id=${articleId}`)
    } catch {
      throw new ReaderApiError(0, '网络连接失败')
    }
    if (!resp.ok) throw new ReaderApiError(resp.status, `导出失败 (${resp.status})`)
    return resp.text()
  },

  /* TTS 音色（新契约 + 旧裸数组兼容） */
  async ttsVoices(): Promise<TtsVoicesResponse> {
    const raw = await req<unknown>('/api/tts/voices')
    const rec = (raw ?? {}) as { voices?: unknown; default_voice?: unknown }
    const list = Array.isArray(raw) ? raw : Array.isArray(rec.voices) ? rec.voices : []
    return {
      voices: (list as unknown[])
        .filter((v): v is Record<string, unknown> => v !== null && typeof v === 'object')
        .map(normalizeVoice)
        .filter((v) => v.name !== ''),
      default_voice: typeof rec.default_voice === 'string' ? rec.default_voice : '',
    }
  },

  /* 流式翻译：delta 为纯译文文本片段，done 带 engine 与缓存标记 */
  streamTranslate(
    /** context：素材背景（书名/篇名/视频标题），供 LLM 消解领域词歧义 */
    body: { text: string; engine: string; refresh?: boolean; context?: string },
    cb: TranslateStreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    return postSse(
      '/api/analyze/translate?stream=1',
      body,
      {
        onDelta: cb.onDelta,
        onDone: (data) => cb.onDone(data as TranslateStreamDone),
        onError: cb.onError,
      },
      signal,
    )
  },

  /* 流式分析 */
  streamAnalyze<T>(
    kind: StreamAnalyzeKind,
    body: Record<string, unknown>,
    cb: AnalyzeStreamCallbacks<T>,
    signal?: AbortSignal,
  ): Promise<void> {
    return postSse(
      `/api/analyze/${kind}?stream=1`,
      body,
      {
        onDelta: cb.onDelta,
        onDone: (data) => cb.onDone(data as AnalyzeDone<T>),
        onError: cb.onError,
      },
      signal,
    )
  },

  /* 版本管理 */
  analyzeVersions: (q: VersionQuery) =>
    req<AnalysisVersion[]>(
      `/api/analyze/versions?scope=${q.scope}&kind=${q.kind}` +
        `&content_hash=${q.content_hash}&context_hash=${q.context_hash ?? ''}`,
    ),

  activateAnalysis: <T>(id: number) =>
    req<AnalyzeDone<T> & { activated: number }>('/api/analyze/activate', jsonInit('POST', { id })),

  /* AI 陪读 */
  createCompanionSession: (articleId: number) =>
    req<CompanionSession>('/api/companion/sessions', jsonInit('POST', { article_id: articleId })),

  companionSession: (sessionId: number | string) =>
    req<CompanionHistory>(`/api/companion/sessions/${sessionId}`),

  askCompanion(
    sessionId: number | string,
    body: { question: string; paragraph_ordinal?: number },
    cb: CompanionAskCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    return postSse(
      `/api/companion/sessions/${sessionId}/ask`,
      body,
      {
        onDelta: cb.onDelta,
        onDone: (data) => cb.onDone(data as CompanionAskDone),
        onError: cb.onError,
      },
      signal,
    )
  },
}
