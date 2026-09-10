import { requestJson } from './http'
import type { VocabSource } from './api'

/* 单词本 v2 接口封装（需求 01 v2 FR-149 ~ FR-187）。
   四类本同构：system 生词本 / exam 考纲 / scenario AI 场景本 / custom 导入本。
   词表契约独立于 lib/api.ts 的旧接口。 */

export class ApiDeckError extends Error {
  constructor(
    public status: number,
    message: string,
    public detail: unknown = null,
  ) {
    super(message)
    this.name = 'ApiDeckError'
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return requestJson<T>(path, init, (status, message, detail) => new ApiDeckError(status, message, detail))
}

function jsonBody(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

export type DeckKind = 'system' | 'exam' | 'scenario' | 'custom'

/** 浏览状态互斥；young 保留为旧接口兼容字段。 */
export interface DeckMastery {
  new: number
  learning: number
  young: number
  mature: number
  hard?: number
}

export interface Deck {
  key: string
  name: string
  kind: DeckKind
  emoji: string | null
  /** 前端据此算封面渐变，0-359 的色相种子，不产生图片请求 */
  color_seed: number
  /** AI 生成封面（模块 16）。为空则回落 emoji + 渐变，那套兜底零请求、离线可用 */
  cover_url: string | null
  description: string | null
  category: string | null
  cefr: string | null
  source: string
  status: 'draft' | 'ready'
  total: number
  learned: number
  due_now?: number
  mastery: DeckMastery
  last_studied_at: string | null
  pinned: boolean
  archived: boolean
  daily_new_limit: number
  deletable: boolean
  editable: boolean
}

export interface VocabOverview {
  decks: Deck[]
  stats: {
    due_now: number
    pending_learning: number
    reviewed_today: number
    new_today: number
    streak_days: number
    total_vocab: number
  }
  profile: {
    daily_new: number
    timezone: string
    auto_enabled: boolean
    auto_limit: number
    auto_used: number
  }
  resume: Array<{
    id: string
    mode: import('./api-practice').PracticeMode
    status: 'active' | 'paused' | 'finished'
    cursor: number
    total: number
    updated_at: string
  }>
  weak_modes: Array<{ mode: import('./api-practice').PracticeMode; count: number }>
}

export interface DeckRecommendation {
  key: string
  name: string
  emoji: string | null
  matched: number
  total: number
  coverage: number
  /** 命中的特征词，作为推荐理由展示 */
  sample: string[]
}

export interface DeckPatch {
  name?: string
  emoji?: string
  description?: string
  color_seed?: number
  daily_new_limit?: number
  pinned?: boolean
  archived?: boolean
}

export type DeckFilter = 'all' | 'new' | 'learning' | 'mastered' | 'difficult'
export type DeckSort = 'default' | 'alpha' | 'freq' | 'recent'

/** 掌握档位，与 DeckMastery 的键同名 */
export type MasteryBucket = 'new' | 'learning' | 'young' | 'mature' | 'hard'

export interface DeckItem {
  source?: VocabSource
  word: string
  phonetic: string | null
  translation: string | null
  definition: string | null
  frq: number | null
  freq_band: string | null
  tags: string[]
  collins: number | null
  exchange: string | null
  status: string
  bucket: MasteryBucket
  difficult: boolean
  /** 用户自己按的标记，空=没标过（此时 bucket 是算法推断的） */
  mark: WordMark | null
  vocab_id: number | null
  due_at: string | null
  /** 分组：场景本是语法分组（core_noun…），考纲本是场景名 */
  group_key: string | null
  example_en: string | null
  example_zh: string | null
  /** 考纲本专用：该分组是具象场景 / 词根词族 / 抽象主题 */
  scene_track?: 'scene' | 'family' | 'theme' | null
  scene_root?: string | null
  /** 词典未命中的 AI 生成词条（BR-30） */
  dict_miss: boolean
}

export interface DeckGroup {
  key: string
  label: string
  count: number
  /** 该分组里已**入册**（进生词本）的词数，考纲本才有。不是「学会」 */
  learned?: number
  /** 该分组里**通过自测**的词数——这才是「学会」的口径 */
  passed?: number
  /** 考纲本的场景轨：具象场景 / 词根词族 / 抽象主题；场景本为 null */
  track?: 'scene' | 'family' | 'theme' | null
  /** family 轨的共同词根（-duce / bene-），其余为 null */
  root?: string | null
}

export interface DeckWordsPage {
  items: DeckItem[]
  total: number
  groups: DeckGroup[]
}

export interface DeckWordsQuery {
  offset?: number
  limit?: number
  filter?: DeckFilter
  sort?: DeckSort
  q?: string
  group?: string
}

export const DECK_FILTERS: Array<{ value: DeckFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'new', label: '未学' },
  { value: 'learning', label: '学习中' },
  { value: 'mastered', label: '已掌握' },
  { value: 'difficult', label: '困难词' },
]

export const DECK_SORTS: Array<{ value: DeckSort; label: string }> = [
  { value: 'default', label: '默认序' },
  { value: 'alpha', label: '字母' },
  { value: 'freq', label: '词频' },
  { value: 'recent', label: '最近学习' },
]

export const BUCKET_LABELS: Record<MasteryBucket, string> = {
  new: '未学',
  learning: '学习中',
  young: '学习中',
  mature: '已掌握',
  hard: '困难词',
}

export const apiDeck = {
  list: () => request<Deck[]>('/api/wordlists'),
  overview: () => request<VocabOverview>('/api/vocab/overview'),
  membership: (word: string) =>
    request<{ word: string; decks: string[] }>(
      `/api/vocab/membership?word=${encodeURIComponent(word)}`,
    ),
  words: (key: string, query: DeckWordsQuery = {}) => {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== '') params.set(k, String(v))
    }
    const qs = params.toString()
    return request<DeckWordsPage>(
      `/api/wordlists/${encodeURIComponent(key)}/words${qs ? `?${qs}` : ''}`,
    )
  },
  /** 按当前学习内容推荐场景本，理由可解释（FR-233、FR-234） */
  recommend: (params: { videoId?: number; articleId?: number }) => {
    const q = new URLSearchParams()
    if (params.videoId !== undefined) q.set('video_id', String(params.videoId))
    if (params.articleId !== undefined) q.set('article_id', String(params.articleId))
    return request<DeckRecommendation[]>(`/api/wordlists/recommend?${q.toString()}`)
  },
  batch: (key: string, action: 'collect' | 'master' | 'remove', words: string[]) =>
    request<{ action: string; created?: number; updated?: number; affected?: number }>(
      `/api/wordlists/${encodeURIComponent(key)}/batch`,
      jsonBody('POST', { action, words }),
    ),
  patch: (key: string, body: DeckPatch) =>
    request<Deck>(`/api/wordlists/${encodeURIComponent(key)}`, jsonBody('PATCH', body)),
  remove: (key: string) =>
    request<{ ok: boolean }>(`/api/wordlists/${encodeURIComponent(key)}`, { method: 'DELETE' }),
}

/* ---- AI 场景本（FR-167 ~ FR-177） ---- */

export type CefrLevel = 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2'

export const CEFR_LEVELS: CefrLevel[] = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']

export interface ScenarioSeed {
  key: string
  title_zh: string
  title_en: string
  emoji: string
  category: string
  cefr: CefrLevel
  description: string
  keywords: string[]
  /** 同名场景本已存在，批量生成时跳过 */
  exists: boolean
}

export interface ScenarioJob {
  job_id: string
  status: 'running' | 'done' | 'failed'
  stage: string
  stage_label: string
  detail: string
  idea: string
  counts: {
    candidates?: number
    kept?: number
    dropped?: number
    rounds?: number
    examples?: number
  }
  scene?: { title_zh: string; emoji: string; cefr: string; description: string | null }
  wordlist_id?: number
  error?: string
}

export interface PassageCoverage {
  covered: string[]
  missing: string[]
  rate: number
}

export interface PassageParagraph {
  role: string
  en: string
  zh: string
}

export interface ScenarioPassage {
  article_id: number
  title: string
  /** dialogue 有角色互动，prose 是叙述短文 */
  form: 'dialogue' | 'prose'
  roles: string[]
  paragraphs: PassageParagraph[]
  coverage: PassageCoverage
  /** 用户为各角色挑的嗓音；未设置的由前端按顺序分配默认音色 */
  role_voices: Record<string, string>
}

export interface DraftItem {
  word: string
  translation: string | null
  group_key: string | null
  group_label: string | null
  example_en: string | null
  example_zh: string | null
  dict_miss: boolean
}

export interface ScenarioDraft {
  id: number
  key: string
  name: string
  emoji: string | null
  color_seed: number
  description: string | null
  category: string | null
  cefr: string | null
  status: 'draft' | 'ready'
  source: string
  total: number
  items: DraftItem[]
}

/** 生成阶段展示序：与后端 STAGES 一一对应，用于进度条推进（FR-172） */
export const SCENARIO_STAGES = [
  'normalize',
  'generate',
  'verify',
  'refill',
  'examples',
  'persist',
  'done',
]

export const apiScenario = {
  generate: (body: {
    idea: string
    level?: CefrLevel
    with_examples?: boolean
    need_confirm?: boolean
  }) =>
    request<{ job_id: string }>('/api/scenario-decks/generate', jsonBody('POST', body)),
  job: (jobId: string) =>
    request<ScenarioJob>(`/api/scenario-decks/jobs/${encodeURIComponent(jobId)}`),
  seeds: () => request<ScenarioSeed[]>('/api/scenario-decks/seeds'),
  generateSeeds: (keys: string[], withExamples = true, needConfirm = false) =>
    request<{ jobs: Array<{ key: string; title: string; job_id: string }>; skipped: string[] }>(
      '/api/scenario-decks/seeds/generate',
      jsonBody('POST', { keys, with_examples: withExamples, need_confirm: needConfirm }),
    ),
  draft: (id: number) => request<ScenarioDraft>(`/api/scenario-decks/${id}/draft`),
  editDraft: (
    id: number,
    body: { name?: string; emoji?: string; description?: string; remove_words?: string[] },
  ) => request<ScenarioDraft>(`/api/scenario-decks/${id}/draft`, jsonBody('PATCH', body)),
  /** config 是节点参数覆盖，形如 {cover: {prompt: '…'}}（模块 16 FR-413）。
      首版没有它，于是「在节点里改提示词重跑」在场景本这条链路上落不了地 */
  rerun: (
    id: number,
    from_step: string,
    scope: 'single' | 'downstream' = 'downstream',
    config?: Record<string, unknown>,
  ) =>
    request<{ job_id: string; steps: string[] }>(
      `/api/scenario-decks/${id}/rerun`,
      jsonBody('POST', { from_step, scope, config }),
    ),
  passage: (id: number) => request<ScenarioPassage>(`/api/scenario-decks/${id}/passage`),
  setRoleVoices: (id: number, voices: Record<string, string>) =>
    request<{ ok: boolean; voices: Record<string, string> }>(
      `/api/scenario-decks/${id}/roles`,
      jsonBody('PUT', { voices }),
    ),
  extendPassage: (id: number, words: string[] = []) =>
    request<{ article_id: number; form: string; coverage: PassageCoverage }>(
      `/api/scenario-decks/${id}/passage/extend`,
      jsonBody('POST', { words }),
    ),
  toTalk: (id: number) =>
    request<{ scenario_key: string; created: boolean }>(
      `/api/scenario-decks/${id}/talk`,
      { method: 'POST' },
    ),
  confirm: (id: number) =>
    request<{ ok: boolean; key: string; total: number }>(
      `/api/scenario-decks/${id}/confirm`,
      { method: 'POST' },
    ),
}

/* ---- 封面：确定性渐变 + emoji，零网络请求（FR-151） ---- */

/** 色种转双色渐变；同一 seed 永远同一配色，卡片不会因刷新换脸 */
export function deckGradient(seed: number): string {
  const hue = seed % 360
  const hue2 = (hue + 42) % 360
  return `linear-gradient(135deg, hsl(${hue} 62% 58%), hsl(${hue2} 58% 46%))`
}

/** 本名兜底首字母，无 emoji 时用它占封面中心 */
export function deckInitial(name: string): string {
  return name.trim().slice(0, 2) || '?'
}

export const MASTERY_META: Array<{ key: keyof DeckMastery; label: string; color: string }> = [
  { key: 'mature', label: '已掌握', color: 'var(--deck-mature)' },
  { key: 'hard', label: '困难词', color: 'var(--err)' },
  { key: 'learning', label: '学习中', color: 'var(--deck-learning)' },
  { key: 'new', label: '未学', color: 'var(--deck-new)' },
]

/** 相对时间文案：卡片上只需要粒度，不需要精确到分钟 */
export function relativeDay(iso: string | null): string | null {
  if (iso === null) return null
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return null
  const days = Math.floor((Date.now() - then) / 86_400_000)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 30) return `${days} 天前`
  if (days < 365) return `${Math.floor(days / 30)} 个月前`
  return `${Math.floor(days / 365)} 年前`
}

/* ---- 场景学习（考纲本按场景学）---- */

export interface SceneQuizState {
  version: number
  run_id: string | null
  scene: string
  total: number
  passed: number
  all_passed: boolean
  cursor: number
  attempts: number
  first_try_ok: number
  first_try_total: number
}

/** 用户自己在词卡上按的标记。与算法判出来的 `bucket` 是两件事 */
export type WordMark = 'learning' | 'mastered' | 'hard'

export const MARK_LABELS: Record<WordMark, string> = {
  learning: '学习中',
  mastered: '已掌握',
  hard: '困难词',
}

export const apiScene = {
  /** 场景入册：把该场景的词收进生词本，**不排进复习队列** */
  enroll: (deckKey: string, scene: string) =>
    request<{ scene: string; enrolled: number }>(
      `/api/wordlists/${encodeURIComponent(deckKey)}/scenes/${encodeURIComponent(scene)}/enroll`,
      { method: 'POST' },
    ),
  /** 记一次「看过」。只写曝光计数，一个字节都不碰 FSRS 调度 */
  expose: (words: string[]) =>
    request<{ counted: number; stages: Record<string, string> }>(
      '/api/wordlists/expose',
      jsonBody('POST', { words }),
    ),
  /** 人工标记。传 null 清除，清除后阶段回到推断值 */
  mark: async (words: string[], mark: WordMark | null) => {
    const result = await request<{ mark: WordMark | null; stages: Record<string, string> }>(
      '/api/wordlists/mark',
      jsonBody('POST', { words, mark }),
    )
    return result
  },
  quizState: (deckKey: string, scene: string) =>
    request<SceneQuizState>(
      `/api/wordlists/${encodeURIComponent(deckKey)}/scenes/${encodeURIComponent(scene)}/quiz`,
    ),
  submitQuiz: (
    deckKey: string,
    scene: string,
    body: { passed: string[]; first_try_ok: number; first_try_total: number; cursor: number; submission_id: string; run_id: string; version: number },
  ) =>
    request<SceneQuizState>(
      `/api/wordlists/${encodeURIComponent(deckKey)}/scenes/${encodeURIComponent(scene)}/quiz`,
      jsonBody('POST', body),
    ),
}

/* ---- 本级维护：清发音缓存 / 清学习进度 / AI 补全（FR-499~502） ---- */

export type DeckAiKind = 'explain' | 'breakdown' | 'tts'
export type DeckAiStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface DeckAiRun {
  id: number
  deck_key: string
  kinds: DeckAiKind[]
  refresh: boolean
  status: DeckAiStatus
  total: number
  done: number
  cached: number
  generated: number
  failed: number
  current_word: string | null
  error: string | null
  cancel_requested: boolean
  created_at: string | null
  started_at: string | null
  finished_at: string | null
}

export const AI_RUN_ACTIVE: DeckAiStatus[] = ['queued', 'running']

export const apiDeckOps = {
  clearAudioCache: (key: string) =>
    request<{ words: number; files: number; cleared_mb: number; epoch: number }>(
      `/api/wordlists/${encodeURIComponent(key)}/clear-audio-cache`,
      { method: 'POST' },
    ),
  resetProgress: (key: string) =>
    request<{ words: number; reset: number; deleted: number; review_logs: number; scene_states: number }>(
      `/api/wordlists/${encodeURIComponent(key)}/reset-progress`,
      { method: 'POST' },
    ),
  startAiRun: (key: string, body: { kinds: DeckAiKind[]; refresh: boolean }) =>
    request<DeckAiRun>(`/api/wordlists/${encodeURIComponent(key)}/ai-runs`, jsonBody('POST', body)),
  latestAiRun: (key: string) =>
    request<{ run: DeckAiRun | null }>(`/api/wordlists/${encodeURIComponent(key)}/ai-runs/latest`),
  cancelAiRun: (key: string, id: number) =>
    request<DeckAiRun>(`/api/wordlists/${encodeURIComponent(key)}/ai-runs/${id}/cancel`, {
      method: 'POST',
    }),
}
