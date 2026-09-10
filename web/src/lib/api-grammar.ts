import { requestJson } from './http'

/* 语法学习与写作纠错接口封装（模块 14）。 */

export class ApiGrammarError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiGrammarError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return requestJson<T>(`/api${path}`, init, (status, message) => new ApiGrammarError(status, message))
}

function jsonBody(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

/* ---- 语法点目录 ---- */

export interface GrammarPointBrief {
  id: number
  ext_id: string
  code: string
  item: string
  item_zh: string | null
  sentence_type: string | null
  cefr_level: string | null
  cefrj_level: string | null
  category: string
  note_zh: string | null
  occurrences?: number
  cards?: number
}

export interface PointList {
  items: GrammarPointBrief[]
  categories: { name: string; count: number }[]
  levels: string[]
  total: number
  credit: string
}

export interface PointDetail extends Omit<GrammarPointBrief, 'cards' | 'occurrences'> {
  explanation: string | null
  examples: { en: string; zh: string }[]
  constructions: { key: string; description: string }[]
  /** 目录里 occurrences 是计数，详情里同名字段也是计数——但 cards 在详情里是明细 */
  occurrences: number
  cards: { id: number; kind: string; widget: string; schedulable: boolean }[]
}

export interface OccurrenceItem {
  id: number
  construction: string
  paragraph_id: number | null
  sentence_id: number | null
  char_start: number
  char_end: number
  snippet: string
}

export interface OccurrenceSource {
  label: string
  kind: 'article' | 'subtitle'
  href?: string
  article_id?: number
  book_id?: number
  video_id?: number
  items: OccurrenceItem[]
}

/* ---- 句法可视化 ---- */

export interface DepWord {
  i: number
  text: string
  lemma: string
  pos: string
  pos_zh: string
  tag: string
  tag_zh: string
  dep: string
  dep_zh: string
  head: number
  morph: string | null
  start: number
  end: number
  is_punct: boolean
}

export interface DepArc {
  start: number
  end: number
  label: string
  label_zh: string
  dir: 'left' | 'right'
}

export interface ConstituentSpan {
  role: 'subject' | 'predicate' | 'object' | 'adverbial' | 'clause'
  role_zh: string
  head: number
  token_start: number
  token_end: number
  tokens: number[]
}

export interface SentenceAnalysis {
  text: string
  words: DepWord[]
  spans: ConstituentSpan[]
  legend: Record<string, string>
  arcs: DepArc[]
  dep_labels: Record<string, string>
  note: string
}

/* ---- 写作纠错 ---- */

export interface WritingEditItem {
  id: number
  errant_type: string
  o_str: string
  c_str: string
  char_start: number | null
  char_end: number | null
  explanation: string | null
  misconception: string | null
  grammar_point_id: number | null
  ordinal: number
}

export interface WritingAttempt {
  id: number
  original: string
  corrected: string | null
  status: string
  error: string | null
  summary: string | null
  origin: string
  card_id: number | null
  created_at: string | null
  edits: WritingEditItem[]
}

export interface ErrorBook {
  by_errant_type: { type: string; count: number }[]
  misconceptions: {
    code: string
    name: string
    description: string
    feedback: string
    count: number
    remedial: GrammarPointBrief | null
  }[]
  catalog_size: number
}

/* ---- 练习卡 ---- */

export interface CardQuestion {
  id: string
  widget: string
  prompt?: string
  sentence?: string
  choices?: string[]
  tokens?: string[]
  answer?: unknown
  audio?: { text: string; voice?: string }
  occurrences?: { id: number; text: string; snippet: string }[]
  misconceptions?: { id: string; value: string; feedback: string }[]
  meta?: Record<string, unknown>
}

export interface DueCard {
  card_id: number
  kind: string
  question: CardQuestion
  point: GrammarPointBrief | null
  state: string
}

export interface GrammarScore {
  correct: boolean
  score: number
  misconception: string | null
  feedback: string | null
  detail: Record<string, unknown>
  remedial_point_id?: number | null
}

export interface GrammarStats {
  new_count: number
  due_count: number
  points: number
  occurrences: number
  points_with_corpus: number
  cards: number
  due: number
  attempts: number
  writing_attempts: number
  widgets: Record<string, { required: string[]; schedulable: boolean; zh: string }>
}

export const grammarApi = {
  practiceHistory: () => request<{ items: GrammarPractice[] }>('/grammar/practice'),
  sectionPoints: (path: string) => request<{ point_ids: number[]; count: number }>(`/grammar/section-points?path=${encodeURIComponent(path)}`),
  createPractice: (mode: 'review' | 'section' | 'errors', point_ids: number[] = [], count = 5) =>
    request<GrammarPractice>('/grammar/practice', jsonBody('POST', { mode, point_ids, count })),
  practice: (id: string) => request<GrammarPractice>(`/grammar/practice/${id}`),
  submitPractice: (id: string, body: { submission_id: string; response: unknown; rating?: number; hints?: number }) =>
    request<{ result: GrammarScore; practice: GrammarPractice }>(`/grammar/practice/${id}/answer`, jsonBody('POST', body)),
  points: (params: { category?: string; level?: string; q?: string } = {}) => {
    const qs = new URLSearchParams()
    if (params.category) qs.set('category', params.category)
    if (params.level) qs.set('level', params.level)
    if (params.q) qs.set('q', params.q)
    const suffix = qs.toString() ? `?${qs.toString()}` : ''
    return request<PointList>(`/grammar/points${suffix}`)
  },
  point: (id: number) => request<PointDetail>(`/grammar/points/${id}`),
  occurrences: (id: number, limit = 40) =>
    request<{ sources: OccurrenceSource[]; total: number }>(
      `/grammar/points/${id}/occurrences?limit=${limit}`,
    ),
  submitWriting: (text: string, cardId?: number) =>
    request<WritingAttempt>('/grammar/writing', jsonBody('POST', { text, card_id: cardId ?? null })),
  writingHistory: (limit = 20) =>
    request<{ items: WritingAttempt[] }>(`/grammar/writing?limit=${limit}`),
  errorBook: () => request<ErrorBook>('/grammar/errors'),
  dueCards: (limit = 20) => request<{ items: DueCard[]; total: number }>(`/grammar/cards/due?limit=${limit}`),
  pointCards: (id: number) =>
    request<{ items: { card_id: number; kind: string; question: CardQuestion }[] }>(
      `/grammar/points/${id}/cards`,
    ),
  locate: (id: number) => request<{ question: CardQuestion }>(`/grammar/points/${id}/locate`),
  answer: (body: { card_id: number; response: unknown; elapsed_ms?: number }) =>
    request<GrammarScore>('/grammar/answer', jsonBody('POST', body)),
  grade: (body: { card_id: number; rating: number }) =>
    request<{ state: string; due: string; intervals: Record<string, string> }>(
      '/grammar/grade',
      jsonBody('POST', body),
    ),
  stats: () => request<GrammarStats>('/grammar/stats'),

  /* ---- 概念专栏（模块 15） ---- */
  concepts: (layer?: 'active' | 'reference') =>
    request<ConceptTree>(`/grammar/concepts${layer ? `?layer=${layer}` : ''}`),
  concept: (slug: string) => request<ConceptDetail>(`/grammar/concepts/${encodeURI(slug)}`),
  conceptStats: () => request<ConceptStats>('/grammar/concepts/stats'),
  deconstruct: (text: string) =>
    request<Deconstruction>('/grammar/concepts/deconstruct', jsonBody('POST', { text })),
  sentenceHistory: () => request<{ items: { id: number; text: string; created_at: string }[] }>('/grammar/sentence-history'),
  sentenceResult: (id: string) => request<Deconstruction>(`/grammar/sentence-history/${id}`),
  dueConcepts: (limit = 20) =>
    request<{ items: DueConcept[]; total: number }>(`/grammar/concepts/due?limit=${limit}`),
  gradeConcept: (slug: string, rating: number) =>
    request<{ state: string; due: string; intervals: Record<string, string> }>(
      `/grammar/concepts/${encodeURI(slug)}/grade`,
      jsonBody('POST', { rating }),
    ),
}

export interface GrammarPractice {
  id: string
  mode: 'review' | 'section' | 'errors'
  status: 'active' | 'finished'
  questions: (DueCard & { submission_id: string; draft_response?: unknown; verdict?: GrammarScore; first_verdict?: GrammarScore; hints?: number })[]
  answers: Record<string, GrammarScore & { first_correct?: boolean; hints: number; response: unknown }>
  cursor: number
  version: number
  updated_at: string
}

/* ---- 概念专栏类型 ---- */

export interface ConceptBrief {
  slug: string
  title: string
  chapter: string
  doc_title: string
  /** active=主动层，必须练到会用；reference=参考层，查得到即可 */
  layer: 'active' | 'reference'
  /** 主动层的判据：不会它会读错什么句子。BR-95 要求写下来才可复核 */
  why_active: string | null
  /** notes=从讲义导入 / platform=平台补写，界面要能区分（BR-94） */
  authored_by: string
  order_index: number
}

/** 复习队列项：概念简介 + FSRS 状态名 */
export interface DueConcept extends ConceptBrief {
  state: string
}

export interface ConceptTree {
  chapters: { chapter: string; docs: { doc_title: string; source_path: string; concepts: ConceptBrief[] }[] }[]
  total: number
  active: number
}

export interface ConceptDetail extends ConceptBrief {
  body_md: string
  source_path: string
  points: { id: number; item: string; item_zh: string | null; cefr_level: string | null }[]
  construction_keys: string[]
  examples: { snippet: string; construction_key: string; source_kind: string; source_id: number }[]
  cards: { card_id: number; kind: string; question: CardQuestion }[]
  state: { name: string; reps: number; due: string | null; marked_known: boolean }
}

export interface ConceptStats {
  total: number
  active: number
  reference: number
  started: number
  due: number
  progress: number
}


/** 命中的构式 + 它指回的讲义概念。
 *  `easy_parse` 只表示「这句好不好解析」，**不表示这条命中对不对**——
 *  两者不是同一个量，实测唯一的误命中置信度是满分（见服务端 WEAK_PARSE_BELOW） */
export interface ConstructionHit {
  key: string
  description: string
  snippet: string
  char_start: number
  char_end: number
  confidence: number
  easy_parse: boolean
  concepts: { slug: string; title: string; doc_title: string; chapter: string; layer: string }[]
}

export interface Deconstruction extends SentenceAnalysis {
  analysis_id?: number
  constructions: ConstructionHit[]
}
