import { requestJson } from './http'

/* 书架进度、多格式导入、词表导入、LLM 管理与用量。
   领域错误保留结构化 detail，供 409 冲突等场景读取。 */

import type {
  Book,
  BookStatus,
  RealtimeSessionCreated,
  StandaloneArticle,
  TalkDifficulty,
  WordlistInfo,
} from './api'

export class ApiM5Error extends Error {
  constructor(
    public status: number,
    message: string,
    /** 后端 detail 原样保留：可能是字符串，也可能是结构化对象（如删除书籍 409） */
    public detail: unknown = null,
  ) {
    super(message)
    this.name = 'ApiM5Error'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return requestJson<T>(path, init, (status, message, detail) => new ApiM5Error(status, message, detail))
}

function jsonPost(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

/* ---- 书架进度化 ---- */

export type ShelfState = 'reading' | 'unstarted' | 'finished'

export interface ShelfProgress {
  /** 0-100，一位小数 */
  progress_pct: number
  state: ShelfState
}

export type BookWithProgress = Book &
  ShelfProgress & {
    last_article_id: number | null
    last_opened_at: string | null
  }

/** M5 起 source_kind 增加 file（上传 txt/md/pdf） */
export type ArticleWithProgress = Omit<StandaloneArticle, 'source_kind'> &
  ShelfProgress & { source_kind: 'url' | 'paste' | 'file' }

export interface BookDeleteConflict {
  annotations: number
  vocab_occurrences: number
}

/** 409 的 detail 解析为冲突计数；其他错误返回 null */
export function parseDeleteConflict(err: unknown): BookDeleteConflict | null {
  if (!(err instanceof ApiM5Error) || err.status !== 409) return null
  const d = err.detail as { annotations?: unknown; vocab_occurrences?: unknown } | null
  if (d === null || typeof d !== 'object') return null
  return {
    annotations: typeof d.annotations === 'number' ? d.annotations : 0,
    vocab_occurrences: typeof d.vocab_occurrences === 'number' ? d.vocab_occurrences : 0,
  }
}

/* ---- 词表导入 ---- */

export type WordlistFormat = 'csv' | 'tsv' | 'json'

export interface WordlistImportPreview {
  token: string
  new: number
  dup: number
  invalid: Array<{ line: number; reason: string }>
  sample: Array<{ word: string; translation: string | null }>
}

export interface WordlistImportResult {
  wordlist_id: number
  key: string
  imported: number
  skipped: number
}

export type WordlistKind = 'builtin' | 'custom'

export type WordlistWithKind = WordlistInfo & { kind: WordlistKind }

/* ---- 用量 ---- */

export interface UsageKindRow {
  kind: string
  provider: string
  count: number
  latency_p50_ms: number | null
  latency_p95_ms: number | null
  cost_micros: number | null
}

/** model_invocation 台账一行聚合：能力 × 插件 × 模型 */
export interface UsageRouteRow {
  capability: string | null
  plugin_id: string
  model: string | null
  count: number
  succeeded: number
  failed: number
  input_tokens: number
  output_tokens: number
  latency_p50_ms: number | null
  latency_p95_ms: number | null
}

export interface UsageInvocationTotal {
  count: number
  succeeded: number
  failed: number
  input_tokens: number
  output_tokens: number
}

export interface UsageSummary {
  days: number
  analysis: { by_kind: UsageKindRow[]; notice?: string | null }
  invocations: {
    by_route: UsageRouteRow[]
    total: UsageInvocationTotal
    notice?: string | null
  }
}

export const apiM5 = {
  /* 书架：每本书带 progress_pct/state/last_article_id/last_opened_at */
  books: () => request<BookWithProgress[]>('/api/books'),

  standaloneArticles: () => request<ArticleWithProgress[]>('/api/articles?standalone=1'),

  /** 删除书籍：残留批注/生词语境时返回 409（用 parseDeleteConflict 解析），force 强删 */
  deleteBook: (bookId: number, force = false) =>
    request<{ ok: boolean }>(`/api/books/${bookId}${force ? '?force=true' : ''}`, {
      method: 'DELETE',
    }),

  /** 单文件文章导入（txt/md/pdf），multipart kind=file */
  uploadArticleFile: (file: File) => {
    const fd = new FormData()
    fd.append('kind', 'file')
    fd.append('file', file)
    return request<{ id: number; status: BookStatus }>('/api/articles', {
      method: 'POST',
      body: fd,
    })
  },

  /* 词表 */

  wordlists: () => request<WordlistWithKind[]>('/api/wordlists'),

  previewWordlistImport: (body: { name: string; format: WordlistFormat; content: string }) =>
    request<WordlistImportPreview>('/api/wordlists/import', jsonPost(body)),

  confirmWordlistImport: (token: string) =>
    request<WordlistImportResult>('/api/wordlists/import/confirm', jsonPost({ token })),

  deleteWordlist: (key: string) =>
    request<{ ok?: boolean }>(`/api/wordlists/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    }),

  /* 用量 */

  usageSummary: (days = 30) => request<UsageSummary>(`/api/usage/summary?days=${days}`),

  /* 实时语音陪读：透传 article_id 或 video_id，注入对应上下文（07 v2 FR-17） */
  createRealtimeSession: (body: {
    grammar_context?: { sentence: string; analysis: string; source: string }
    scenario_key?: string
    difficulty?: TalkDifficulty
    article_id?: number
    video_id?: number
    unit_ordinal?: number
    deployment_id?: number | null
  }) => request<RealtimeSessionCreated>('/api/talk/realtime/sessions', jsonPost(body)),
}
