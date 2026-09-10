import { requestJson } from './http'

/* 后端接口契约封装：所有请求统一走 /api（vite 代理到 localhost:8100） */

import type { VideoStatus } from './api-video'

export type BookStatus = 'pending' | 'parsing' | 'ready' | 'failed'

export interface Book {
  id: number
  slug: string
  title: string
  author: string | null
  status: BookStatus
  error: string | null
  source: string | null
  cover_url: string | null
  /** 内置馆藏元数据（FR-368）；导入书为空 */
  difficulty: 'starter' | 'core' | 'deep' | null
  tags: string[]
  blurb: string | null
}

export interface UploadResult {
  id: number
  slug: string
  status: BookStatus
}

export interface Chapter {
  id: number
  ordinal: number
  title: string
  paragraphs: number
}

/** [start, end, surfaceLower, learnable]，偏移为 UTF-16 码元，可直接 slice */
export type Token = [number, number, string, boolean]

/** [sentenceId, charStart, charEnd, contentHash] */
export type Sentence = [number, number, number, string]

export interface Paragraph {
  id: number
  ordinal: number
  kind: string
  text: string
  tokens: Token[]
  sentences: Sentence[]
}

export interface Article {
  id: number
  title: string
  /** 独立文章（URL/粘贴导入）为 null */
  book_id: number | null
  ordinal: number
  paragraphs: Paragraph[]
}

/* ---- 独立文章（M4：URL / 粘贴导入） ---- */

export type ArticleSourceKind = 'url' | 'paste'

export interface StandaloneArticle {
  id: number
  title: string
  source_kind: ArticleSourceKind
  source_url: string | null
  status: BookStatus
  error: string | null
  word_count: number | null
  created_at: string
}

export type ImportArticleBody =
  | { kind: 'url'; url: string }
  | { kind: 'paste'; title?: string; text: string }

export interface DictEntry {
  word: string
  phonetic: string | null
  translation: string | null
  definition: string | null
  pos: string | null
  collins: number | null
  tags: string[]
  freq_band: number | null
  frq: number | null
  exchange: string | null
  source: string | null
}

/** 全局查词（FR-507~510）：`/dict/suggest` 与 `/dict/search` 的条目。
    `match` 说明这条是怎么命中的；`stage` 是学习阶段（study_stage 五档），`in_vocab` 是在不在生词本 */
export interface DictSearchEntry {
  word: string
  lc: string
  brief: string | null
  phonetic: string | null
  tags: string[]
  frq_rank: number | null
  freq_band: string | null
  tier: number
  lemma: string | null
  proper: boolean
  match: string
  stage: string
  in_vocab: boolean
  vocab_id: number | null
  mark: string | null
  /** 汉英反查命中的义项原文与序号 */
  gloss?: string
  sense_idx?: number
  pos?: string | null
}

export interface DictFormEntry extends DictSearchEntry {
  code: string
  codes: string[]
  /** 过去式 / 过去分词 … */
  label: string
}

export interface DictSearchSource {
  dict: string
  forms: string
  related: string | null
  fuzzy: string
  index_built_at: string | null
}

export type DictSearchKind = 'en' | 'zh' | 'glob'

export interface DictSearchNotReady {
  ready: false
  hint: string
  q: string
  kind: DictSearchKind
}

export interface DictSearchReady {
  ready: true
  q: string
  kind: DictSearchKind
  exact: DictSearchEntry[]
  lemmas: DictSearchEntry[]
  forms: Array<{ lemma: string; forms: DictFormEntry[] }>
  matches: DictSearchEntry[]
  phrases: DictSearchEntry[]
  related: { syn: DictSearchEntry[]; ant: DictSearchEntry[]; deriv: DictSearchEntry[] }
  reverse: DictSearchEntry[]
  suggestions: DictSearchEntry[]
  source: DictSearchSource
}

export type DictSearchResponse = DictSearchNotReady | DictSearchReady

export type DictSuggestResponse =
  | (DictSearchNotReady & { items: DictSearchEntry[] })
  | { ready: true; q: string; kind: DictSearchKind; items: DictSearchEntry[]; source: DictSearchSource }

/** 近义词辨析（FR-510）：目标词 + WordNet 给的近义词表，一份缓存 */
export interface WordNuance {
  summary: string
  items: Array<{ word: string; difference: string; example_en: string; example_zh: string }>
}

export interface NuanceResponse {
  result: WordNuance | null
  cached: boolean
  provider?: string
  model?: string | null
  version?: number | null
}

/** 词典补全（FR-129~131）：例句 + 带口音的读音，来自 dictionaryapi.dev（Wiktionary/CC BY-SA） */
export interface DictPhonetic {
  text: string
  /** us | uk | au | ''（无标注） */
  accent: string
  has_audio: boolean
}

export interface DictExample {
  pos: string
  definition: string
  example: string
}

export interface DictEnrich {
  word: string
  phonetics: DictPhonetic[]
  examples: DictExample[]
  status: string
  source: string
  license: string
}

/** 拆开记（FR-321~325）：不带语境，一个词一份缓存 */
export interface Morpheme {
  text: string
  type: 'prefix' | 'root' | 'suffix' | 'linking'
  gloss: string
}

export interface WordBreakdown {
  syllables: string[]
  stress: number
  ipa_syllables?: string[]
  morphemes: Morpheme[]
  formation: string
  mnemonic: string
  family: Array<{ word: string; zh: string }>
}

export interface BreakdownResponse {
  /** cached_only 探测未命中时为 null */
  result: WordBreakdown | null
  cached: boolean
}

export interface WordAnalysis {
  /** 该词在本句读法的 IPA（v10.1）：多音词按语境判读音；旧缓存无此字段 */
  phonetic_in_context?: string
  context_meaning: string
  pos_in_context: string
  explanation: string
  memory_hint: string
}

export interface AnalyzeWordResponse {
  result: WordAnalysis
  cached: boolean
  provider: string
  model: string
  version: string | number
}

export type TranslateEngine = 'auto' | 'bing' | 'google' | 'llm'

export interface TranslateResponse {
  result: { text: string; engine: string }
  cached: boolean
}

export interface GrammarComponent {
  text: string
  /** 固定枚举，见 features/reader/grammarRole.ts 的 GRAM_ROLES */
  role: string
  /** 补充说明（「修饰 ladies」「固定搭配，表示来自」）。
      收敛 role 之前模型把这半写在 role 里，历史缓存没有这个字段 */
  note?: string
}

export interface GrammarAnalysis {
  translation: string
  backbone: string
  quick: string
  components: GrammarComponent[]
  tenses: string
  difficulty_note: string
}

export interface GrammarResponse {
  result: GrammarAnalysis
  cached: boolean
}

export interface TtsVoice {
  name: string
  gender: string
  locale: string
}

export interface ArticleTranslations {
  /** sentenceId(字符串键) → 中文译文，随后台任务推进逐步增多 */
  translations: Record<string, string>
}

/* ---- 视频学习 ---- */

/* 视频状态口径唯一在 api-video.ts（含 degraded，v6 FR-79）。这里曾另写一份 6 态的，
   服务端返回 degraded 时它就漏态了；改成转出，两边不可能再漂。 */
export type { VideoStatus }

export interface VideoSummary {
  id: number
  title: string
  channel: string | null
  duration_s: number | null
  status: VideoStatus
  progress: number
  error: string | null
  /** 后端相对路径（如 /videos/2/thumb），使用时需加 /api 前缀 */
  thumb_url: string | null
}

export type TrackKind = 'official' | 'auto' | 'whisper' | 'translation'

export interface VideoTrack {
  id: number
  kind: TrackKind
  lang: string
  label: string
  is_default: boolean
  cue_count: number
}

export interface VideoDetail extends VideoSummary {
  source_url: string | null
  tracks: VideoTrack[]
}

export interface Cue {
  id: number
  ordinal: number
  start_ms: number
  end_ms: number
  text: string
}

/* ---- AI 对话 ---- */

export type TalkDifficulty = 'easy' | 'medium' | 'hard'

export interface KeySentence {
  en: string
  zh: string
}

export interface TalkScenario {
  key: string
  title: string
  title_en: string
  level: string
  role_ai: string
  role_user: string
  goal: string
  opening_line: string
  key_sentences: KeySentence[]
  hints: string[]
  /** false 为用户自建场景（可编辑/删除）；旧后端可能缺失，缺失视作内置 */
  is_builtin?: boolean
}

/** 场景编辑器提交的数据体（不含 is_builtin，由后端判定） */
export type TalkScenarioData = Omit<TalkScenario, 'is_builtin'>

export interface TurnFeedback {
  level: 'ok' | 'improve'
  note: string
  better?: string | null
}

export interface TalkTurn {
  id: number
  ordinal: number
  role: 'user' | 'assistant'
  text: string
  feedback: TurnFeedback | null
  audio_key: string | null
  /** 后端相对路径（/tts?text=...），播放时加 /api 前缀 */
  tts_url: string | null
}

export interface TalkSummary {
  done_well: string[]
  suggestions: string[]
  key_phrases: KeySentence[]
}

export interface TalkCoachReply {
  en: string
  zh: string
  tone: string
}

export interface TalkCoachResponse {
  translation: string
  intent: string
  replies: TalkCoachReply[]
}

export interface TalkCoachBatch {
  id: number
  batch_index: number
  status: 'running' | 'ready' | 'failed' | 'interrupted'
  error: string | null
  saved_replies: number[]
  created_at: string
  model: string | null
  result: TalkCoachResponse | null
}

export interface TalkRecord {
  saved_texts: string[]
  id: number
  message_id: string | null
  ordinal: number
  role: 'user' | 'assistant'
  text: string
  complete: boolean
  saved: boolean
  created_at: string
  batches: TalkCoachBatch[]
}

export interface TalkRecordPage {
  items: TalkRecord[]
  total: number
  next_cursor: number | null
  ended_at: string | null
}

export interface TalkSessionItem {
  id: number
  mode: string
  scenario_key: string | null
  scenario_title: string | null
  difficulty: string
  started_at: string
  ended_at: string | null
  turn_count: number
}

export interface TalkSessionDetail {
  id: number
  mode: string
  scenario_key: string | null
  scenario_title: string | null
  difficulty: string
  started_at: string
  ended_at: string | null
  scenario: TalkScenario | null
  summary: TalkSummary | null
  turns: TalkTurn[]
}

export interface TalkTurnPair {
  user_turn: TalkTurn
  assistant_turn: TalkTurn
}

export interface RealtimeSessionCreated {
  session_id: number
  ws_path: string
  scenario: TalkScenario | null
  deployment_id?: number | null
}

/* ---- 词库 / 复习（M3，后端并行开发中，字段以本契约为准） ---- */

export interface ReviewStats {
  due_now: number
  reviewed_today: number
  new_today: number
  streak_days: number
  total_vocab: number
  upcoming: Array<{ date: string; count: number }>
}

export interface ReviewCardContext {
  text: string
  article_id: number
  sentence_id: number
  source_label: string
}

/** 评分档位 → 间隔文案，如 {"1":"10 分钟","2":"1 天","3":"4 天","4":"7 天"}，随每次评分响应更新 */
export type ReviewIntervals = Record<string, string>

export interface ReviewCard {
  card_version?: string | null
  vocab_id: number
  word: string
  phonetic: string | null
  translation: string | null
  definition: string | null
  tags: string[]
  /** 契约为数字档位；后端实测返回"很常见"等文案，两种都兼容 */
  freq_band: number | string | null
  status: string
  context: ReviewCardContext | null
  /** 后端实测按卡片返回（FSRS 状态不同间隔不同），优先于队列级 intervals */
  intervals?: ReviewIntervals
}

export type ReviewRating = 1 | 2 | 3 | 4

export interface ReviewQueue {
  items: ReviewCard[]
  /** 契约中的队列级间隔文案；后端实测放在每张卡片上，此字段可能缺失 */
  intervals?: ReviewIntervals
}

export interface ReviewResult {
  next_due_at: string
  intervals: ReviewIntervals
}

export interface WordlistInfo {
  key: string
  name: string
  total: number
  learned: number
}

export interface WordlistWord {
  word: string
  phonetic: string | null
  translation: string | null
  frq: number | null
  status: string
}

export interface WordlistWordsPage {
  items: WordlistWord[]
  /** 后端实测直接返回数组，无 total，此时为 null */
  total: number | null
}

export type WordlistFilter = 'all' | 'new' | 'learning'

/* ---- 学习报告（M4） ---- */

export interface ReviewReport {
  /** 近 365 天每日复习次数 */
  heatmap: Array<{ date: string; count: number }>
  /** 近 30 天复习/新学双指标 */
  daily: Array<{ date: string; reviewed: number; learned: number }>
  totals: {
    vocab_total: number
    known: number
    learning: number
    new: number
    reviews_total: number
  }
  by_source: { reading: number; wordlist: number }
  top_articles: Array<{ title: string; vocab_count: number }>
}

/** 导出接口直接 window.open 触发浏览器下载 */
export const EXPORT_VOCAB_CSV_URL = '/api/export/vocab.csv'
export const EXPORT_VOCAB_APKG_URL = '/api/export/vocab.apkg'

/** GET /vocab 收藏生词列表项（现有接口） */
export interface VocabItem {
  id: number
  word: string
  lemma: string | null
  status: string
  created_at: string
  occurrences: number
  latest_context: string | null
}

export type VocabSourceKind =
  | 'software'
  | 'reader'
  | 'video'
  | 'talk'
  | 'grammar'
  | 'wordlist'
  | 'practice'
  | 'manual'

export interface VocabSource {
  kind: VocabSourceKind
  label?: string
  locator?: Record<string, string | number>
}

export interface VocabCollectResult {
  id: number
  word: string
  created: boolean
  occurrence_created: boolean
  scheduled: boolean
}

/** 回合 tts_url（后端相对路径）转为可直接播放的地址 */
export function talkTtsUrl(ttsPath: string): string {
  return `/api${ttsPath}`
}

/** 实时语音 WebSocket 地址：走 vite /api 代理（ws:true） */
export function talkRealtimeWsUrl(wsPath: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/api${wsPath}`
}

export function videoStreamUrl(videoId: number | string): string {
  return `/api/videos/${videoId}/stream`
}

export function videoThumbUrl(thumbPath: string): string {
  return `/api${thumbPath}`
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return requestJson<T>(path, init, (status, message) => new ApiError(status, message))
}

function jsonBody(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

function jsonPost(body: unknown): RequestInit {
  return jsonBody('POST', body)
}

export const api = {
  books: () => request<Book[]>('/api/books'),

  uploadBook: (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return request<UploadResult>('/api/books/upload', { method: 'POST', body: fd })
  },

  chapters: (bookId: number | string) => request<Chapter[]>(`/api/books/${bookId}/chapters`),

  article: (articleId: number | string) => request<Article>(`/api/articles/${articleId}`),

  /* ---- 独立文章 ---- */

  standaloneArticles: () => request<StandaloneArticle[]>('/api/articles?standalone=1'),

  importArticle: (body: ImportArticleBody) =>
    request<{ id: number; status: BookStatus }>('/api/articles', jsonPost(body)),

  deleteArticle: (articleId: number | string) =>
    request<unknown>(`/api/articles/${articleId}`, { method: 'DELETE' }),

  dict: (word: string) => request<DictEntry>(`/api/dict/${encodeURIComponent(word)}`),

  dictEnrich: (word: string) =>
    request<DictEnrich>(`/api/dict/${encodeURIComponent(word)}/enrich`),

  dictSuggest: (q: string, limit = 8) =>
    request<DictSuggestResponse>(`/api/dict/suggest?q=${encodeURIComponent(q)}&limit=${limit}`),

  dictSearch: (q: string, signal?: AbortSignal) => request<DictSearchResponse>(`/api/dict/search?q=${encodeURIComponent(q)}`, { signal }),

  /** cachedOnly=true 只探缓存，不触发 LLM 调用 */
  wordNuance: (
    word: string,
    synonyms: string[],
    opts: { cachedOnly?: boolean; refresh?: boolean } = {},
  ) =>
    request<NuanceResponse>(
      `/api/analyze/nuance${opts.cachedOnly === true ? '?cached_only=1' : ''}`,
      jsonPost({ word, synonyms, refresh: opts.refresh === true }),
    ),

  analyzeWord: (body: { word: string; context: string; refresh?: boolean }) =>
    request<AnalyzeWordResponse>('/api/analyze/word', jsonPost(body)),
  /** cachedOnly=true 只探缓存，不触发 LLM 调用（FR-327） */
  wordBreakdown: (word: string, opts: { cachedOnly?: boolean; refresh?: boolean } = {}) =>
    request<BreakdownResponse>(
      `/api/analyze/breakdown${opts.cachedOnly === true ? '?cached_only=1' : ''}`,
      jsonPost({ word, refresh: opts.refresh === true }),
    ),

  translate: (body: {
    text: string
    engine: TranslateEngine
    refresh?: boolean
    /** 素材背景（书名/篇名/视频标题），供 LLM 消解领域词歧义 */
    context?: string
  }) =>
    request<TranslateResponse>('/api/analyze/translate', jsonPost(body)),

  grammar: (body: { sentence: string; refresh?: boolean }) =>
    request<GrammarResponse>('/api/analyze/grammar', jsonPost(body)),

  collectVocab: (body: {
    word: string
    article_id?: number
    sentence_id?: number
    video_id?: number
    cue_id?: number
    context_text: string
    source?: VocabSource
  }) => request<VocabCollectResult>('/api/vocab', jsonPost(body)),

  enrollVocab: (id: number) =>
    request<VocabCollectResult & { enrolled: boolean }>(`/api/vocab/${id}/enroll`, jsonPost({})),

  vocabStatus: async (words: string[]) => {
    const unique = [...new Set(words.map((word) => word.trim().toLowerCase()).filter(Boolean))]
    if (unique.length === 0) return { collected: [] }

    // 长文章可能包含上千个去重词；单个 GET 会超过 Nginx 的 request-line 上限。
    const batches: string[][] = []
    for (let index = 0; index < unique.length; index += 120) {
      batches.push(unique.slice(index, index + 120))
    }
    const results = await Promise.all(
      batches.map((batch) => request<{ collected: string[] }>(
        `/api/vocab/status?words=${encodeURIComponent(batch.join(','))}`,
      )),
    )
    return { collected: [...new Set(results.flatMap((result) => result.collected))] }
  },

  ttsVoices: () => request<TtsVoice[]>('/api/tts/voices'),

  /** 触发整篇异步翻译（202 入队，按句缓存断点续传） */
  enqueueTranslate: (articleId: number | string, engine = 'auto') =>
    request<{ queued?: unknown }>(
      `/api/articles/${articleId}/translate?engine=${encodeURIComponent(engine)}`,
      { method: 'POST' },
    ),

  articleTranslations: (articleId: number | string) =>
    request<ArticleTranslations>(`/api/articles/${articleId}/translations`),

  /* ---- 视频学习 ---- */

  videos: () => request<VideoSummary[]>('/api/videos'),

  addVideo: (url: string) =>
    request<{ id: number; status: VideoStatus; existed?: boolean }>(
      '/api/videos',
      jsonPost({ url }),
    ),

  uploadVideo: (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return request<{ id: number; status: VideoStatus }>('/api/videos/upload', {
      method: 'POST',
      body: fd,
    })
  },

  retryVideo: (videoId: number | string) =>
    request<{ id: number; status: VideoStatus }>(`/api/videos/${videoId}/retry`, {
      method: 'POST',
    }),

  video: (videoId: number | string) => request<VideoDetail>(`/api/videos/${videoId}`),

  trackCues: (trackId: number | string) => request<Cue[]>(`/api/tracks/${trackId}/cues`),

  translateTrack: (trackId: number | string) =>
    request<{ queued: boolean; track_id: number }>(`/api/tracks/${trackId}/translate`, {
      method: 'POST',
    }),

  /* ---- AI 对话 ---- */

  talkScenarios: () => request<TalkScenario[]>('/api/talk/scenarios'),

  createTalkScenario: (data: TalkScenarioData) =>
    request<TalkScenario>('/api/talk/scenarios', jsonPost({ data })),

  updateTalkScenario: (key: string, data: TalkScenarioData) =>
    request<TalkScenario>(
      `/api/talk/scenarios/${encodeURIComponent(key)}`,
      jsonBody('PUT', { data }),
    ),

  deleteTalkScenario: (key: string) =>
    request<unknown>(`/api/talk/scenarios/${encodeURIComponent(key)}`, { method: 'DELETE' }),

  /** AI 按一句话点子生成完整场景草稿（不落库，落表单由用户确认后保存） */
  draftTalkScenario: (body: { idea: string; level?: string }) =>
    request<TalkScenarioData>('/api/talk/scenarios/draft', jsonPost(body)),

  talkSessions: () => request<TalkSessionItem[]>('/api/talk/sessions'),

  talkRecords: (id: number | string, options: { before?: number; q?: string; role?: string; saved?: boolean } = {}) => {
    const params = new URLSearchParams()
    Object.entries(options).forEach(([key, value]) => { if (value !== undefined && value !== '') params.set(key, String(value)) })
    return request<TalkRecordPage>(`/api/talk/sessions/${id}/records?${params}`)
  },
  talkBatches: (id: number | string, turn: number) =>
    request<TalkCoachBatch[]>(`/api/talk/sessions/${id}/turns/${turn}/coach`),
  generateTalkBatch: (id: number | string, turn: number, batchIndex: number, retry = false) =>
    request<TalkCoachBatch>(`/api/talk/sessions/${id}/turns/${turn}/coach`, jsonPost({ batch_index: batchIndex, retry })),
  saveTalkExpression: (id: number | string, turn: number, saved: boolean, batchIndex?: number, replyIndex?: number, text?: string) =>
    request<{ saved: boolean }>(`/api/talk/sessions/${id}/turns/${turn}/saved`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ saved, batch_index: batchIndex, reply_index: replyIndex, text }),
    }),
  deleteTalkSession: (id: number | string) => request(`/api/talk/sessions/${id}`, { method: 'DELETE' }),

  talkSession: (sessionId: number | string) =>
    request<TalkSessionDetail>(`/api/talk/sessions/${sessionId}`),

  createTalkSession: (body: {
    mode: 'text' | 'voice'
    scenario_key?: string
    difficulty?: TalkDifficulty
  }) => request<TalkSessionDetail>('/api/talk/sessions', jsonPost(body)),

  talkTextTurn: (sessionId: number | string, text: string) =>
    request<TalkTurnPair>(`/api/talk/sessions/${sessionId}/turns/text`, jsonPost({ text })),

  talkCoach: (sessionId: number | string, text: string, variant = 0, previousReplies: string[] = []) =>
    request<TalkCoachResponse>(`/api/talk/sessions/${sessionId}/coach`, jsonPost({ text, variant, previous_replies: previousReplies })),

  talkAudioTurn: (sessionId: number | string, audio: Blob, filename: string) => {
    const fd = new FormData()
    fd.append('file', audio, filename)
    return request<TalkTurnPair>(`/api/talk/sessions/${sessionId}/turns/audio`, {
      method: 'POST',
      body: fd,
    })
  },

  endTalkSession: (sessionId: number | string) =>
    request<{ id: number; ended_at: string; summary: TalkSummary }>(
      `/api/talk/sessions/${sessionId}/end`,
      { method: 'POST' },
    ),

  createRealtimeSession: (body: {
    scenario_key?: string
    difficulty?: TalkDifficulty
    deployment_id?: number | null
  }) =>
    request<RealtimeSessionCreated>('/api/talk/realtime/sessions', jsonPost(body)),

  /* ---- 词库 / 复习 ---- */

  vocabList: () => request<VocabItem[]>('/api/vocab'),

  reviewStats: () => request<ReviewStats>('/api/review/stats'),

  reviewReport: () => request<ReviewReport>('/api/review/report'),

  reviewQueue: (limit = 50) => request<ReviewQueue>(`/api/review/queue?limit=${limit}`),

  submitReview: (vocabId: number, rating: ReviewRating, submissionId: string, cardVersion: string | null) =>
    request<ReviewResult>(`/api/review/${vocabId}`, jsonPost({ rating, submission_id: submissionId, card_version: cardVersion })),

  wordlists: () => request<WordlistInfo[]>('/api/wordlists'),

  /** 契约返回 {items,total}，后端实测返回裸数组，统一归一化为分页结构 */
  wordlistWords: async (
    key: string,
    offset: number,
    limit: number,
    filter: WordlistFilter,
  ): Promise<WordlistWordsPage> => {
    const resp = await request<WordlistWordsPage | WordlistWord[]>(
      `/api/wordlists/${encodeURIComponent(key)}/words?offset=${offset}&limit=${limit}&filter=${filter}`,
    )
    return Array.isArray(resp) ? { items: resp, total: null } : resp
  },

  /** 契约返回 {items}，后端实测返回裸数组，统一归一化 */
  learnNewWords: async (key: string, count: number): Promise<{ items: ReviewCard[] }> => {
    const resp = await request<{ items: ReviewCard[] } | ReviewCard[]>(
      `/api/wordlists/${encodeURIComponent(key)}/learn`,
      jsonPost({ count }),
    )
    return Array.isArray(resp) ? { items: resp } : resp
  },
}
