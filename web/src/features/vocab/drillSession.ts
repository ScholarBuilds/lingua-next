import type { apiScene, DeckWordsPage } from '../../lib/api-deck'
import { emptyProgress } from './grouping'
import type { GroupItem, Phase, QuizKind, WordProgress } from './grouping'

export async function loadDrillWords(fetchPage: (offset: number) => Promise<DeckWordsPage>): Promise<DeckWordsPage> {
  const first = await fetchPage(0)
  const items = [...first.items]
  while (items.length < first.total) {
    const page = await fetchPage(items.length)
    if (page.items.length === 0) throw new Error('词表读取不完整，请重试')
    items.push(...page.items)
  }
  return { ...first, items }
}

export interface DrillState {
  groupIdx: number
  phase: Phase
  recallIdx: number
  progress: Record<string, WordProgress>
  recent: string[]
  struggling: string[]
  round: number
}
export type DrillSubmission = Parameters<typeof apiScene.submitQuiz>[2]

export function restoreDrillSubmission(value: unknown, runId: string, groupIdx: number, words: string[]): DrillSubmission | null {
  if (value == null) return null
  const p = value as DrillSubmission
  if (p.run_id !== runId || p.submission_id !== `${runId}:${groupIdx}` || p.cursor !== groupIdx + 1 ||
    !Number.isInteger(p.version) || p.version! < 0 || !Array.isArray(p.passed) ||
    !p.passed.every(w => typeof w === 'string' && words.includes(w)) ||
    !Number.isInteger(p.first_try_ok) || !Number.isInteger(p.first_try_total) ||
    p.first_try_ok < 0 || p.first_try_ok > p.first_try_total || p.first_try_total > words.length) {
    throw new Error('待提交记录与当前小组不一致，请返回场景重新读取进度。')
  }
  return p
}
export function startGroup(groupIdx = 0, struggling: string[] = []): DrillState {
  return { groupIdx, phase: 'recall', recallIdx: 0, progress: {}, recent: [], struggling, round: 0 }
}
export function recordAnswer(p: WordProgress, kind: QuizKind, ok: boolean): WordProgress {
  return { ...p, firstCorrect: p.seen === 0 ? ok : p.firstCorrect, seen: p.seen + 1, streak: ok ? p.streak + 1 : 0, wrong: p.wrong + (ok ? 0 : 1),
    kinds: p.kinds.includes(kind) ? p.kinds : [...p.kinds, kind], lastProductive: ok && kind === 'spell' }
}
export function restoreDrill(raw: string | null, signature: string, groups: GroupItem[][]): DrillState | null {
  if (!raw) return null
  const saved = JSON.parse(raw)
  if (saved.version !== 2 || saved.signature !== signature) return null
  const s = saved.state
  if (!s || !Number.isInteger(s.groupIdx) || s.groupIdx < 0 || s.groupIdx > groups.length ||
    !['recall', 'drill', 'recap', 'gate'].includes(s.phase) || !Number.isInteger(s.recallIdx) ||
    s.recallIdx < 0 || s.recallIdx >= (groups[s.groupIdx]?.length ?? 1) ||
    !Number.isInteger(s.round) || s.round < 0 || !Array.isArray(s.recent) || !Array.isArray(s.struggling) ||
    !s.recent.every((w: unknown) => typeof w === 'string') || !s.struggling.every((w: unknown) => typeof w === 'string') ||
    !s.progress || typeof s.progress !== 'object') return null
  const progress: Record<string, WordProgress> = {}
  for (const item of groups[s.groupIdx] ?? []) {
    const p = s.progress[item.word] ?? emptyProgress()
    if (!['seen', 'streak', 'wrong'].every(k => Number.isInteger(p[k]) && p[k] >= 0) ||
      !['known', 'weak', 'lastProductive'].every(k => typeof p[k] === 'boolean') || (p.firstCorrect !== undefined && typeof p.firstCorrect !== 'boolean') ||
      !Array.isArray(p.kinds) || !p.kinds.every((k: unknown) => ['zh2en', 'en2zh', 'spell'].includes(String(k)))) return null
    progress[item.word] = p
  }
  return { ...s, progress }
}
