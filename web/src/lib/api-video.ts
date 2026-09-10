import { requestJson } from './http'

/* 视频学习 v2 接口封装（独立文件，不动共享 lib/api.ts）：
   /videos 列表卡片含 AI 加工产物；/tracks/{id}/cues 带词组区间与词级时间戳；
   批量导入 / 单项重跑加工 / 词汇表 / 删除。 */

export type VideoStatus =
  | 'online'
  | 'pending'
  | 'downloading'
  | 'transcribing'
  | 'translating'
  | 'ready'
  /** 流程跑完但产物不达标（句层为空 / 译文不全）：能看但显式标黄（v6 FR-79） */
  | 'degraded'
  | 'failed'

export type EnrichStatus =
  | 'pending'
  | 'summary'
  | 'difficulty'
  | 'phrases'
  | 'vocab'
  | 'done'
  | 'failed'

export type VideoErrorKind = 'bot_check' | 'network' | 'other'

export type VideoAccent =
  | 'american'
  | 'british'
  | 'australian'
  | 'canadian'
  | 'indian'
  | 'non_native'
  | 'mixed'

export interface VideoCardV2 {
  source_url?: string | null
  media_kind?: 'local' | 'online'
  id: number
  title: string
  title_zh: string | null
  channel: string | null
  duration_s: number | null
  status: VideoStatus
  progress: number
  error: string | null
  error_kind: VideoErrorKind | null
  summary_zh: string | null
  /** 难度星级 1-5，AI 加工产出 */
  difficulty: number | null
  accent: VideoAccent | null
  topics: string[]
  vocab_count: number | null
  enrich_status: EnrichStatus | null
  enriched_at: string | null
  created_at: string | null
  /** 后端相对路径（/videos/{id}/thumb），使用时加 /api 前缀 */
  thumb_url: string | null
}

export type TrackKind = 'official' | 'auto' | 'whisper' | 'translation'

export interface VideoTrackV2 {
  id: number
  kind: TrackKind
  lang: string
  label: string
  is_default: boolean
  /** 词级时间戳为插值近似时 {approximate: true} */
  meta: { approximate?: boolean } | null
  cue_count: number
}

export interface VideoDetailV2 extends VideoCardV2 {
  difficulty_detail: { wpm: number; cefr_dist: Record<string, number> } | null
  source_url: string | null
  tracks: VideoTrackV2[]
}

export type PhraseType = 'phrasal' | 'collocation' | 'idiom'

/** [start, end, type, meaning_zh]，偏移为 UTF-16 码元 */
export type CuePhrase = [number, number, string, string]

/** [start_ms, end_ms, word] */
export type CueWord = [number, number, string]

export interface CueV2 {
  id: number
  ordinal: number
  start_ms: number
  end_ms: number
  text: string
  phrases: CuePhrase[] | null
  words: CueWord[] | null
}

/** 语法句内的词：比 cue 的 CueWord 多出句内字符区间（卡拉OK与词组归属都要用） */
export type SentenceWord = [startMs: number, endMs: number, surface: string, charStart: number, charEnd: number]

/** 学习句：听写/跟读/中译英/收藏/已学的单位（ADR-007 三级模型最内层） */
export interface StudyUnitV1 {
  id: number
  ordinal: number
  start_ms: number
  end_ms: number
  text: string
  /** 在所属语法句 text 内的 UTF-16 区间：词组高亮据此裁剪平移 */
  char_start: number
  char_end: number
  learned: boolean
  starred: boolean
  flagged: boolean
  text_override: string | null
  dictation_accuracy: number | null
}

/** 语法句：翻译语境 / AI 陪读引用 / 词组区间定位的单位 */
export interface SentenceV1 {
  id: number
  ordinal: number
  start_ms: number
  end_ms: number
  text: string
  text_zh: string | null
  phrases: CuePhrase[] | null
  words: SentenceWord[] | null
  /** 非语音标记（[Music] 等）：不计入进度、听写跟读跳过、视觉弱化 */
  is_noise: boolean
  src_cue_ids: number[] | null
  units: StudyUnitV1[]
}

export interface UnitStatePatch {
  learned?: boolean
  starred?: boolean
  flagged?: boolean
  text_override?: string | null
  dictation_accuracy?: number
}

/** 跟读逐词比对结果（FR-33） */
export interface ShadowResult {
  unit_id: number
  reference: string
  transcript: string
  items: Array<{ word: string; status: 'ok' | 'wrong' | 'miss'; got?: string }>
  correct: number
  total: number
  extra: number
  accuracy: number
}

/** 一条已落库的跟读录音及其比对/点评结果（FR-340~344） */
export interface ShadowRecordingV1 {
  id: number
  video_id: number
  sentence_id: number
  unit_id: number | null
  audio_url: string
  duration_ms: number | null
  transcript: string | null
  accuracy: number | null
  items: Array<{ word: string; status: 'ok' | 'wrong' | 'miss'; got?: string }>
  correct: number | null
  total: number | null
  extra: number | null
  reference: string | null
  review: string | null
  score: number | null
  /** 结构化发音诊断（FR-398）；未评测为 null */
  assessment: ShadowAssessmentV1 | null
  created_at: string | null
}

/** 发音诊断（FR-398）。音素层已于 2026-08-30 随本地音素模型下线，只剩这三个指标 */
export interface ShadowAssessmentV1 {
  completeness: number
  fluency: number
  accuracy: number
  words: {
    word: string
    start: number
    end: number
    raw_score: number
    norm_score: number
    confidence: number
    status: string
  }[]
  breaks: { kind: 'UnexpectedBreak' | 'MissingBreak'; index: number; ms: number; word: string }[]
  notes?: string[]
}

/** 订阅源（频道 / 播放列表），含频道维度学习统计（09 v4 FR-44/50） */
export interface SubscriptionV1 {
  id: number
  kind: 'channel' | 'playlist'
  source_id: string
  title: string
  url: string | null
  thumb_url: string | null
  enabled: boolean
  last_checked_at: string | null
  last_error: string | null
  total_items: number
  imported: number
  pending: number
  learned_videos: number
  avg_difficulty: number | null
}

/** 字幕来源：官方轨 / 自动生成 / 无英文字幕（none 需 whisper 全片转写） */
export type CaptionKind = 'manual' | 'auto' | 'none'

/** 发现页候选视频：轮询只写这张表，不下载（BR-16） */
export interface FeedItemV1 {
  id: number
  video_key: string
  title: string
  thumb_url: string | null
  duration_s: number | null
  published_at: string | null
  video_id: number | null
  ignored: boolean
  channel: string | null
  /** 以下四项由 Data API 批量回填（FR-58），未配 key 时点详情才补 */
  view_count: number | null
  has_captions: boolean | null
  caption_kind: CaptionKind | null
  wpm: number | null
  /** 入库前难度预估 1-5 星（FR-59），无英文字幕则为 null */
  difficulty: number | null
  /** youtube-nocookie 内嵌预览地址（快通道，机房 IP 下常被 bot 校验拦） */
  embed_url: string
  watch_url: string
  /** 本地片段地址（FR-53），preview_ready=false 时需先 POST 生成 */
  preview_url: string
  preview_ready: boolean
}

export interface RecommendedChannel {
  title: string
  /** @handle：channel_id 由订阅时 yt-dlp 现场解析，不写死 */
  handle: string
  url: string
  note: string
  subscribed: boolean
}

/** 候选视频详情：走服务端凭证拉取，iframe 被 bot 校验拦住时的可靠信息源 */
export interface FeedItemDetail extends FeedItemV1 {
  description: string
  /** CEFR 档位占比，与入库后的正式加工同口径（BR-21） */
  cefr_dist: Record<string, number>
  vocab_count: number | null
  word_count: number | null
  caption_lang: string | null
  subtitle_langs: string[]
  audio_language: string | null
  probed_at: string | null
  /** 无任何英文字幕：仍可下载但要走 whisper 转写 */
  needs_whisper: boolean
  has_manual_en: boolean
  has_auto_en: boolean
}

/** 发现页可见的处理队列（FR-61） */
export interface FeedQueueItem {
  video_id: number
  feed_item_id: number
  title: string
  status: string
  progress: number
  error: string | null
  error_kind: string | null
}

export interface FeedQuery {
  subscription_id?: number
  include_imported?: boolean
  include_ignored?: boolean
  include_unknown?: boolean
  status?: string
  min_duration?: number
  max_duration?: number
  /** 仅看有英文字幕的（FR-62）：无字幕要走 whisper 全片转写，耗时以十分钟计 */
  only_captioned?: boolean
  q?: string
  limit?: number
}

export interface VideoProgressV1 {
  video_id: number
  last_pos_s: number
  mode_idx: Record<string, number>
  dict_stats: { done?: number; correctWords?: number; totalWords?: number }
  starred: boolean
  learned: number
  total: number
}

export interface VideoVocabItem {
  word: string
  meaning_zh: string
  level: string | null
  /** 首次出现的字幕句序号，回链出处 */
  cue_ordinal: number | null
}

export interface VideoVocabResponse {
  video_id: number
  track_id: number
  items: VideoVocabItem[]
  model: string | null
  generated_at: string | null
}

export interface BatchAddResult {
  url: string
  id?: number
  existed?: boolean
  error?: string
}

export type EnrichStep = 'summary' | 'difficulty' | 'phrases' | 'vocab'

export class VideoApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'VideoApiError'
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  return requestJson<T>(path, init, (status, message) => new VideoApiError(status, message))
}

function jsonPost(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

export function videoStreamUrl(videoId: number | string): string {
  return `/api/videos/${videoId}/stream`
}

export function videoThumbUrl(thumbPath: string): string {
  return `/api${thumbPath}`
}

export const apiVideo = {
  videos: () => req<VideoCardV2[]>('/api/videos'),

  video: (videoId: number | string) => req<VideoDetailV2>(`/api/videos/${videoId}`),

  /** 批量导入：每行一个 URL，后端逐条建卡入队（并发 2，BR-06） */
  batchAdd: (urls: string[]) => req<BatchAddResult[]>('/api/videos/batch', jsonPost({ urls })),

  uploadVideo: (file: File, targetVideoId?: number) => {
    const fd = new FormData()
    fd.append('file', file)
    return req<{ id: number; status: VideoStatus }>(`/api/videos/upload${targetVideoId ? `?target_video_id=${targetVideoId}` : ''}`, {
      method: 'POST',
      body: fd,
    })
  },

  retry: (videoId: number | string) =>
    req<{ id: number; status: VideoStatus }>(`/api/videos/${videoId}/retry`, { method: 'POST' }),

  deleteVideo: (videoId: number | string) =>
    req<{ deleted: number }>(`/api/videos/${videoId}`, { method: 'DELETE' }),

  /** 触发/重跑 AI 加工；only 传 summary|difficulty|phrases|vocab 单项重跑 */
  enrich: (videoId: number | string, only?: EnrichStep) =>
    req<{ id: number; enrich_status: string }>(
      `/api/videos/${videoId}/enrich${only !== undefined ? `?only=${only}` : ''}`,
      { method: 'POST' },
    ),

  cues: (trackId: number | string) => req<CueV2[]>(`/api/tracks/${trackId}/cues`),

  /** 三级结构：语法句 + 其下学习句（右栏与八模式的数据源） */
  sentences: (trackId: number | string) =>
    req<SentenceV1[]>(`/api/tracks/${trackId}/sentences`),

  patchUnitState: (unitId: number, patch: UnitStatePatch) =>
    req<StudyUnitV1>(`/api/study-units/${unitId}/state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),

  shadowCompare: (unitId: number, file: File, sentenceId?: number) => {
    const form = new FormData()
    form.append('file', file)
    return req<ShadowResult>(
      `/api/study-units/${unitId}/shadow${sentenceId !== undefined ? `?sentence_id=${sentenceId}` : ''}`,
      { method: 'POST', body: form },
    )
  },

  /* ---- 订阅与发现（09 v4）---- */

  subscriptions: () => req<SubscriptionV1[]>('/api/subscriptions'),

  recommendedChannels: () => req<RecommendedChannel[]>('/api/subscriptions/recommended'),

  subscribe: (url: string) =>
    req<{ id: number; title: string; kind: string; queued: boolean }>('/api/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }),

  unsubscribe: (id: number) =>
    req<void>(`/api/subscriptions/${id}`, { method: 'DELETE' }),

  refreshSubscriptions: (id?: number) =>
    req<{ queued: boolean }>(
      `/api/subscriptions/refresh${id !== undefined ? `?sub_id=${id}` : ''}`,
      { method: 'POST' },
    ),

  feed: (query: FeedQuery = {}) => {
    const q = new URLSearchParams(
      Object.entries(query)
        .filter(([, v]) => v !== undefined && v !== '')
        .map(([k, v]) => [k, String(v)]),
    )
    return req<FeedItemV1[]>(`/api/feed${q.toString() ? `?${q}` : ''}`)
  },
  feedPage: (query: FeedQuery, cursor: number | null = null) => {
    const params = new URLSearchParams(Object.entries({ ...query, paginated: true, cursor })
      .filter(([, value]) => value != null).map(([key, value]) => [key, String(value)]))
    return req<{ items: FeedItemV1[]; total: number; next_cursor: number | null }>(`/api/feed?${params}`)
  },
  collectOnline: (url: string, title: string) => req<{ id: number; existed: boolean }>('/api/videos/online', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, title }),
  }),

  feedItemDetail: (itemId: number, refresh = false) =>
    req<FeedItemDetail>(`/api/feed/${itemId}/detail${refresh ? '?refresh=true' : ''}`),

  /** 批量回填候选元数据（Data API，1 unit / 50 条） */
  refreshFeedMeta: (subscriptionId?: number) =>
    req<{ filled: number; source: string; error?: string }>(
      `/api/feed/refresh-meta${subscriptionId !== undefined ? `?subscription_id=${subscriptionId}` : ''}`,
      { method: 'POST' },
    ),

  /** 生成可播预览片段：带凭证下前 60 秒 ≤360p，缓存复用（FR-53/54） */
  buildPreview: (itemId: number) =>
    req<{ ready: boolean; cached: boolean; url: string; bytes?: number }>(
      `/api/feed/${itemId}/preview`,
      { method: 'POST' },
    ),

  importFeedItem: (itemId: number) =>
    req<{ video_id: number; queued: boolean }>(`/api/feed/${itemId}/import`, { method: 'POST' }),

  importFeedBatch: (ids: number[]) =>
    req<{ queued: { feed_item_id: number; video_id: number; title: string }[]; skipped: number[] }>(
      '/api/feed/import-batch',
      jsonPost({ ids }),
    ),

  feedQueue: () => req<FeedQueueItem[]>('/api/feed/queue'),

  cancelImport: (videoId: number) =>
    req<{ deleted: number }>(`/api/videos/${videoId}`, { method: 'DELETE' }),

  ignoreFeedItem: (itemId: number, ignored: boolean) =>
    req<{ id: number; ignored: boolean }>(
      `/api/feed/${itemId}/ignore?ignored=${ignored}`,
      { method: 'PATCH' },
    ),

  progress: (videoId: number | string) =>
    req<VideoProgressV1>(`/api/videos/${videoId}/progress`),

  patchProgress: (
    videoId: number | string,
    patch: Partial<Pick<VideoProgressV1, 'last_pos_s' | 'mode_idx' | 'dict_stats' | 'starred'>>,
  ) =>
    req<VideoProgressV1>(`/api/videos/${videoId}/progress`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),

  translateTrack: (trackId: number | string) =>
    req<{ queued: boolean; track_id: number }>(`/api/tracks/${trackId}/translate`, {
      method: 'POST',
    }),

  videoVocab: (videoId: number | string) =>
    req<VideoVocabResponse>(`/api/videos/${videoId}/vocab`),

  /* ---- 跟读工作台（FR-335~345） ---- */

  /** 录音落库 + 逐词比对。用户点了「比对/点评/保存」才走这里（BR-12 的"明确保存"） */
  createShadow: (body: {
    file: File
    sentenceId: number
    unitId?: number
    durationMs?: number
    compare?: boolean
  }) => {
    const form = new FormData()
    form.append('file', body.file)
    form.append('sentence_id', String(body.sentenceId))
    if (body.unitId !== undefined) form.append('unit_id', String(body.unitId))
    if (body.durationMs !== undefined) form.append('duration_ms', String(body.durationMs))
    form.append('compare', String(body.compare ?? true))
    return req<ShadowRecordingV1>('/api/videos/shadow', { method: 'POST', body: form })
  },

  listShadow: (videoId: number | string, sentenceId?: number) =>
    req<ShadowRecordingV1[]>(
      `/api/videos/${videoId}/shadow${sentenceId !== undefined ? `?sentence_id=${sentenceId}` : ''}`,
    ),

  deleteShadow: (recId: number) =>
    req<{ deleted: number }>(`/api/videos/shadow/${recId}`, { method: 'DELETE' }),

  /** AI 点评：SSE 流式，onDelta 逐段回吐，onDone 带全文与评分 */
  assessShadow: (recId: number, refresh = false) =>
    req<ShadowAssessmentV1>(
      `/api/videos/shadow/${recId}/assess${refresh ? '?refresh=true' : ''}`,
      { method: 'POST' },
    ),

  /** 发音诊断的中文讲解：SSE 流式。**LLM 只叙述不打分**（FR-398j） */
  async narrateShadow(
    recId: number,
    onDelta: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await fetch(`/api/videos/shadow/${recId}/narrate`, { method: 'POST', signal })
    if (!res.ok || res.body === null) throw new Error(`讲解失败（${res.status}）`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const blocks = buf.split('\n\n')
      buf = blocks.pop() ?? ''
      for (const block of blocks) {
        const ev = /^event:\s*(.+)$/m.exec(block)?.[1]?.trim()
        const raw = /^data:\s*(.+)$/m.exec(block)?.[1]
        if (ev === undefined || raw === undefined) continue
        const data = JSON.parse(raw) as Record<string, unknown>
        if (ev === 'delta') onDelta(String(data.text ?? ''))
        else if (ev === 'error') throw new Error(String(data.message ?? '讲解不可用'))
      }
    }
  },

  async reviewShadow(
    recId: number,
    handlers: {
      onDelta: (text: string) => void
      onDone: (data: { text: string; score: number | null; cached: boolean }) => void
      onError: (message: string) => void
    },
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await fetch(`/api/videos/shadow/${recId}/review`, { method: 'POST', signal })
    if (!res.ok || res.body === null) {
      handlers.onError(`点评失败（${res.status}）`)
      return
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      // SSE 事件以空行分隔，最后一段可能不完整，留在缓冲里等下一片
      const blocks = buf.split('\n\n')
      buf = blocks.pop() ?? ''
      for (const block of blocks) {
        const ev = /^event:\s*(.+)$/m.exec(block)?.[1]?.trim()
        const raw = /^data:\s*(.+)$/m.exec(block)?.[1]
        if (ev === undefined || raw === undefined) continue
        const data = JSON.parse(raw) as Record<string, unknown>
        if (ev === 'delta') handlers.onDelta(String(data.text ?? ''))
        else if (ev === 'done')
          handlers.onDone({
            text: String(data.text ?? ''),
            score: typeof data.score === 'number' ? data.score : null,
            cached: data.cached === true,
          })
        else if (ev === 'error') handlers.onError(String(data.message ?? '点评失败'))
      }
    }
  },

  /** 收藏生词（带视频出处：video_id + cue_id，复习卡可回跳时间点） */
  collectVocab: (body: {
    word: string
    video_id?: number
    cue_id?: number
    context_text: string
  }) => req<unknown>('/api/vocab', jsonPost(body)),
}
