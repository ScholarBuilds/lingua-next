/* 场景速记的分组与过关判定（需求 01 v2 FR-230~232）。

   成组学习最大的坑是干扰效应：近义词、近形词放进同一组会互相干扰，记混的概率
   高于分开学。所以分组不是简单切片，必须把冲突词对推开。 */

import { editDistance } from './dictation'

export const DEFAULT_GROUP_SIZE = 7

/** 编辑距离 ≤2 视为近形词，同组会互相干扰（affect/effect、adapt/adopt） */
const CONFUSABLE_DISTANCE = 2

export interface GroupItem {
  word: string
  translation: string | null
  phonetic: string | null
  vocabId: number | null
  /** 例句在预习阶段展示：光记词义记不住用法，考纲本的例句还落在本词的场景里 */
  exampleEn?: string | null
  exampleZh?: string | null
}

/** 两个词是否会互相干扰：近形（编辑距离小）或首尾相同的近音 */
export function confusable(a: string, b: string): boolean {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > CONFUSABLE_DISTANCE) return false
  return editDistance(a.toLowerCase(), b.toLowerCase()) <= CONFUSABLE_DISTANCE
}

/** 切分成组，冲突词对推到后面的组（FR-231） */
export function splitGroups(items: GroupItem[], size: number): GroupItem[][] {
  const groups: GroupItem[][] = []
  if (!Number.isInteger(size) || size < 1) throw new Error('分组大小必须为正整数')
  let pending = [...items]
  while (pending.length > 0) {
    const current: GroupItem[] = []
    const deferred: GroupItem[] = []
    for (const item of pending) {
      if (current.length < size && !current.some(x => confusable(x.word, item.word))) current.push(item)
      else deferred.push(item)
    }
    groups.push(current)
    pending = deferred
  }
  return groups
}

/* ---- 阶段机 ---- */

export type Phase = 'recall' | 'drill' | 'recap' | 'gate'
export type QuizKind = 'zh2en' | 'en2zh' | 'spell'

/** 难度递进：识别 → 再认 → 产出。产出类是过关的必要条件 */
export const QUIZ_ORDER: QuizKind[] = ['zh2en', 'en2zh', 'spell']
export const PRODUCTIVE: QuizKind[] = ['spell']

export interface WordProgress {
  /** 组内连续答对次数 */
  streak: number
  /** 组内出现次数 */
  seen: number
  /** 已用过的题型 */
  kinds: QuizKind[]
  /** 最后一次是不是产出类题型 */
  lastProductive: boolean
  /** 认词阶段自评「认识」。它**不再等于过关**——自评只是自评，
      还要在测验里答对才算数（老版本按下「这个我认识」直接判过，
      那个词后面一道题都不考，等于给了一个跳过按钮） */
  known: boolean
  /** 认词阶段自评「不会」：进重来队列，且优先安排 */
  weak: boolean
  wrong: number
  firstCorrect?: boolean
}

export function emptyProgress(): WordProgress {
  return {
    streak: 0,
    seen: 0,
    kinds: [],
    lastProductive: false,
    known: false,
    weak: false,
    wrong: 0,
  }
}

/**
 * 单词过关：连续答对 ≥2 且最后一次是产出类（FR-230）。
 *
 * > [!danger] 自评「认识」不再直接判过
 * >
 * > 老判据是 `p.known || (...)`，而 `known` 来自认词阶段那个「这个我认识」按钮。
 * > 后果是：按一下就过关 → `pickNext` 永久过滤掉它 → 这个词一道题都不考。
 * > 于是「速记」可以一路点过去、零测验、零 FSRS 写入，结束时还报「本组通过」。
 * >
 * > 现在自评只影响**考几次**（见 `targetStreak`），不影响过不过。
 */
export function wordPassed(p: WordProgress): boolean {
  return p.streak >= targetStreak(p) && p.lastProductive
}

/** 自评认识的词考一轮就够，模糊/不会的要连对两次才算过 */
export function targetStreak(p: WordProgress): number {
  return p.known && !p.weak ? 1 : 2
}

/** 整组过关：每个词都过。

    > [!info] 取消了原先的「首答正确率 ≥80%」这道门
    >
    > 三条理由：
    > 1. **冗余**——词过关本身要求「连对 ≥2 次且最后一次是拼写」，
    >    没过的词会被 `pickNext` 一直抓回来重考，蒙混不过去。
    > 2. **难度不可比**——80% 在 7 词组里错 2 个就掉到 71%，
    >    在 95 词场景里可以错 19 个。同一个比例在两种规模上是两回事，
    >    重新标定没有正确答案。
    > 3. 它是 `groupPassed` 唯一可能失败的条件，取消后连带修掉了
    >    Gate/Recap 那个死循环（Recap 从来没真正跑过一轮）。
    >
    > 首答正确率仍然记录并上报，但只用来展示与「建议再刷一遍」的软提示。 */
export function groupPassed(progress: Map<string, WordProgress>): boolean {
  return [...progress.values()].every(wordPassed)
}

/** 首答正确率：只做展示，不当门槛。 */
export function firstTryStats(progress: Map<string, WordProgress>): {
  ok: number
  total: number
} {
  const attempted = [...progress.values()].filter((p) => p.seen > 0)
  return { ok: attempted.filter((p) => p.firstCorrect ?? p.wrong === 0).length, total: attempted.length }
}

/** 下一题的题型：优先没用过的，且同一词至少覆盖 2 种题型 */
export function nextKind(p: WordProgress): QuizKind {
  const unused = QUIZ_ORDER.filter((k) => !p.kinds.includes(k))
  if (unused.length > 0) return unused[0]
  return QUIZ_ORDER[p.seen % QUIZ_ORDER.length]
}

/**
 * 排下一题：满足 lag 约束（同一词两次出现间隔 ≥2 个其他词），
 * 连续重复会造成假性掌握。
 */
export function pickNext(
  items: GroupItem[],
  progress: Map<string, WordProgress>,
  recent: string[],
): GroupItem | null {
  const pending = items.filter((i) => !wordPassed(progress.get(i.word) ?? emptyProgress()))
  if (pending.length === 0) return null
  const lagged = pending.filter((i) => !recent.slice(-2).includes(i.word))
  const pool = lagged.length > 0 ? lagged : pending
  // 错得多的优先再练；同样错得多时，认词阶段自评「不会」的排前面
  const score = (w: string) => {
    const pr = progress.get(w)
    return (pr?.wrong ?? 0) * 2 + (pr?.weak === true ? 1 : 0)
  }
  return [...pool].sort((a, b) => score(b.word) - score(a.word))[0]
}

/* ---- 选项 ---- */

/** 字符串 → 32 位种子。同一个词每次算出同一个数，跨会话也一样 */
function seedOf(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** mulberry32：小而够用的确定性 PRNG */
function rng(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 按种子洗牌（Fisher–Yates）。
 *
 * > [!danger] 不能用 `Math.random()`
 * >
 * > 选项是在渲染里算的，用真随机的话每次重渲染顺序都变——
 * > 手指正要点第二个，选项自己换了位置。种子取自词本身，
 * > 于是「同一道题顺序固定、不同题顺序不同」。
 */
export function shuffled<T>(list: T[], seed: number): T[] {
  const out = [...list]
  const rand = rng(seed)
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * 生成选择题干扰项。
 *
 * > [!warning] 原来是 `slice(0, 3)` 再按字母排序
 * >
 * > 取同组的**前三个**词、再 `localeCompare` 排一遍，于是同一个词
 * > 每一次出现，四个选项和它们的顺序都完全一样——第二次见到这道题，
 * > 记住的是「答案在第几个」而不是这个词。选项既不随机也不打乱，
 * > 测出来的东西和要测的东西没关系。
 * >
 * > 现在从同组其余词里按种子随机取，答案位置也随题变。
 */
export function distractors(
  items: GroupItem[],
  answer: GroupItem,
  count = 3,
): GroupItem[] {
  const pool = items.filter((i) => i.word !== answer.word && i.translation !== null)
  return shuffled(pool, seedOf(answer.word)).slice(0, count)
}

/** 一道选择题的四个选项，答案位置随题而变 */
export function optionsFor(
  items: GroupItem[],
  answer: GroupItem,
  kind: QuizKind,
): GroupItem[] {
  const candidates = kind === 'en2zh'
    ? items.filter((item, index) => item.word === answer.word || (item.translation !== answer.translation && items.findIndex(other => other.translation === item.translation) === index))
    : items
  const opts = [answer, ...distractors(candidates, answer)]
  // 种子掺进题型：同一个词的 en2zh 与 zh2en 不该是同一个排列
  return shuffled(opts, seedOf(`${answer.word}:${kind}`))
}
