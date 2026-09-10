import { request } from './api-deck'

export type PracticeMode = 'review' | 'learn' | 'spelling' | 'dictation' | 'listening' | 'cloze'
export type Verdict = 'correct' | 'assisted' | 'incorrect' | 'skipped' | 'unavailable'
export interface PracticeScope {
  decks: string[]
  count: 5 | 10 | 20 | 40
  filter: 'all' | 'new' | 'learning' | 'difficult'
  group: string
  silent: boolean
  return_url: string
  draft?: { answer?: string; hints?: number; replays?: number }
}
export interface PracticeQuestion {
  id: string
  word: string
  phonetic: string | null
  pos: string | null
  translation: string
  definition: string | null
  example: string
  example_zh: string | null
  prompt: string
  options: string[]
  hint_steps: Array<{
    label: string
    text: string
    reveals_answer?: boolean
    eliminate?: string
  }>
  intervals: Record<string, string> | null
}
export interface PracticeAnswer {
  id: string
  question_id: string
  answer: string
  hints: number
  replays: number
  verdict: Verdict
  rating: number | null
  scheduled: boolean
}
export interface PracticeRecord {
  id: string
  mode: PracticeMode
  status: 'active' | 'paused' | 'finished'
  scope: PracticeScope
  questions: PracticeQuestion[]
  cursor: number
  version: number
  answers: PracticeAnswer[]
  counts: Record<Verdict, number>
  updated_at: string
}
export interface PracticeSummary extends Pick<PracticeRecord, 'id' | 'mode' | 'status' | 'scope' | 'cursor' | 'updated_at'> {
  total: number
  completed: number
  hints: number
  incorrect: number
}
export interface AnswerRequest {
  id: string
  question_id: string
  version: number
  answer: string
  hints: number
  replays: number
  rating?: number
  action: 'answer' | 'skip' | 'unavailable'
}
export interface PracticeProfile {
  daily_new: number; timezone: string; auto_enabled: boolean; auto_limit: number; auto_used: number
}
export interface PracticePack {
  id: number; status: string; error: string | null; automatic: boolean
  result: { en: string; zh: string; advice: string; questions: { word: string; prompt: string; answers: string[]; explanation: string }[] } | null
}
const body = (method: string, value: unknown): RequestInit => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
})
export const apiPractice = {
  profile: () => request<PracticeProfile>('/api/practice/settings/profile'),
  saveProfile: (profile: Omit<PracticeProfile, 'auto_used'>) => request<PracticeProfile>('/api/practice/settings/profile', body('PUT', profile)),
  pack: (id: string) => request<{ pack: PracticePack | null }>(`/api/practice/${id}/pack`),
  generatePack: (id: string) => request<{ pack: PracticePack | null }>(`/api/practice/${id}/pack`, body('POST', { confirm_cost: true })),
  create: (mode: PracticeMode, scope: PracticeScope) => request<PracticeRecord>('/api/practice', body('POST', { mode, ...scope })),
  read: (id: string) => request<PracticeRecord>(`/api/practice/${id}`),
  retry: (id: string) => request<PracticeRecord>(`/api/practice/${id}/retry`, body('POST', {})),
  history: (offset = 0, status = 'all') => request<{ items: PracticeSummary[]; total: number }>(`/api/practice?offset=${offset}&status=${status}`),
  answer: (id: string, answer: AnswerRequest) => request<PracticeRecord>(`/api/practice/${id}/answers`, body('POST', answer)),
  progress: (record: PracticeRecord, status: PracticeRecord['status'], draft: PracticeScope['draft']) =>
    request<PracticeRecord>(`/api/practice/${record.id}`, body('PATCH', { version: record.version, status, draft })),
}

export const PRACTICE_MODES: Record<PracticeMode, { name: string; description: string }> = {
  review: { name: '到期复习', description: '按记忆情况评分，更新下一次复习时间' },
  learn: { name: '学新词', description: '逐词认识与自测，完成的词才进入调度' },
  spelling: { name: '拼写练习', description: '根据意思回忆拼写，不改变复习间隔' },
  dictation: { name: '听写', description: '听发音写单词，保留提示和重播记录' },
  listening: { name: '听音辨义', description: '听发音，选择对应的中文意思' },
  cloze: { name: '例句挖空', description: '结合已有语境，补全句子中的词' },
}
