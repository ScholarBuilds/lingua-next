/* AI 主动检验（需求 07 v2 FR-21/BR-08）。

   陪读的价值不止于答疑：连续学完若干句后由 AI 主动发问，把被动理解变主动巩固。
   只在用户空闲（AI 不在说话、没有正在进行的提问）时发起，不打断当前对话。 */

import { sendCompanionText } from '../mascot/useInlineVoiceCompanion'

/** 攒够这么多句才发起一次检验 */
const QUIZ_EVERY = 5
/** 两次检验的最小间隔，避免连着考 */
const MIN_GAP_MS = 90_000

interface QuizState {
  enabled: boolean
  learned: string[]
  lastAt: number
}

const state: QuizState = { enabled: true, learned: [], lastAt: 0 }

export function setQuizEnabled(on: boolean): void {
  state.enabled = on
  if (!on) state.learned = []
}

export function isQuizEnabled(): boolean {
  return state.enabled
}

/** 标记一句已学；攒够数量且时机合适时让 AI 发起检验。返回是否真的发起了。 */
export function noteLearned(text: string, idle: boolean): boolean {
  if (!state.enabled) return false
  const t = text.trim()
  if (t !== '') state.learned.push(t)
  if (state.learned.length < QUIZ_EVERY) return false
  if (!idle || Date.now() - state.lastAt < MIN_GAP_MS) return false

  const batch = state.learned.slice(-QUIZ_EVERY)
  const ok = sendCompanionText(
    '[主动检验] 学习者刚学完下面这几句，请从中挑一个词组或表达，' +
      '用一句话考一考他（可以问含义，或让他用这个说法造句）。只问一个问题，简短口语化。\n' +
      batch.map((s, i) => `${i + 1}. ${s}`).join('\n'),
  )
  if (ok) {
    state.learned = []
    state.lastAt = Date.now()
  }
  return ok
}

export function resetQuiz(): void {
  state.learned = []
  state.lastAt = 0
}
