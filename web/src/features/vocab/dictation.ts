/* 听写判定（需求 01 v2 FR-224~227）：规范化 → 精确 → 近似 → 字符级 diff。

   判定档位只控制规范化流水线的后半段开关，前半段（trim/NFKC/折叠空白/智能标点）
   三档共用。近似阈值按词长分段，来自 Anki / Quizlet / qwerty-learner 的横向对照。 */

export type Strictness = 'strict' | 'normal' | 'loose'
export type Verdict = 'correct' | 'almost' | 'wrong'

/** 英美拼写互通表：只收高频且规则化的部分，不做全量映射 */
const SPELLING_PAIRS: Array<[RegExp, string]> = [
  [/our\b/g, 'or'], // colour → color
  [/ise\b/g, 'ize'], // realise → realize
  [/isation\b/g, 'ization'],
  [/yse\b/g, 'yze'], // analyse → analyze
  [/re\b/g, 'er'], // centre → center
  [/ll(ed|ing|er)\b/g, 'l$1'], // travelled → traveled
  [/ogue\b/g, 'og'], // catalogue → catalog
  [/ae|oe/g, 'e'], // encyclopaedia → encyclopedia
]

/** 统一规范化：前半段三档共用，后半段按档位开关 */
export function normalize(raw: string, level: Strictness): string {
  let s = raw.trim().normalize('NFKC').replace(/<[^>]*>/g, '')
  s = s.replace(/\s+/g, ' ')
  // 智能标点归一：手机输入法常给弯引号与长破折号
  s = s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
  if (level === 'strict') return s

  s = s.toLowerCase()
  // 去变音符：café → cafe
  s = s.normalize('NFD').replace(/[̀-ͯ]/g, '')
  // 连字符与空格互通：ice-cream = ice cream
  s = s.replace(/[-\s]+/g, ' ')
  for (const [pattern, to] of SPELLING_PAIRS) s = s.replace(pattern, to)
  if (level === 'loose') s = s.replace(/[^\w ]/g, '')
  else s = s.replace(/^[^\w]+|[^\w]+$/g, '') // normal 只忽略首尾标点
  return s.trim()
}

/** Damerau-Levenshtein（含相邻换位）：teh → the 只算一次编辑 */
export function editDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost)
      }
    }
  }
  return d[m][n]
}

/** 容忍阈值按目标词长分段（FR-224）：短词一个字母就是另一个词，不能容忍 */
export function tolerance(length: number, level: Strictness): number {
  if (level === 'strict') return 0
  const base = length <= 4 ? 0 : length <= 11 ? 1 : 2
  return level === 'loose' ? base + 1 : base
}

export interface JudgeOptions {
  level?: Strictness
  /** 专有名词强制区分大小写，即使处于 normal 档 */
  properNoun?: boolean
  /** 同义拼写、缩写、变体，任一命中即算对 */
  alternatives?: string[]
}

export interface JudgeResult {
  verdict: Verdict
  distance: number
  /** almost 时给出具体差异描述，如「差一个字母」 */
  hint: string | null
}

export function judge(typed: string, answer: string, opts: JudgeOptions = {}): JudgeResult {
  const level: Strictness = opts.properNoun ? 'strict' : (opts.level ?? 'normal')
  const candidates = [answer, ...(opts.alternatives ?? [])]
  const got = normalize(typed, level)
  if (got === '') return { verdict: 'wrong', distance: answer.length, hint: null }

  // 判定顺序：主答案精确 → 备选精确 → 主答案近似 → 备选近似
  for (const cand of candidates) {
    if (got === normalize(cand, level)) return { verdict: 'correct', distance: 0, hint: null }
  }
  let best = Number.MAX_SAFE_INTEGER
  let bestCand = answer
  for (const cand of candidates) {
    const d = editDistance(got, normalize(cand, level))
    if (d < best) {
      best = d
      bestCand = cand
    }
  }
  const limit = tolerance(normalize(bestCand, level).length, level)
  if (best <= limit) {
    return {
      verdict: 'almost',
      distance: best,
      hint: best === 1 ? `差一个字母：${bestCand}` : `差 ${best} 处：${bestCand}`,
    }
  }
  return { verdict: 'wrong', distance: best, hint: null }
}

/* ---- 字符级 diff（FR-227）：对齐 Anki 的 typeGood/typeBad/typeMissed ---- */

export type DiffKind = 'good' | 'bad' | 'missed'
export interface DiffPart {
  kind: DiffKind
  text: string
}

/** 最长公共子序列回溯，给出三色 diff */
export function diffChars(typed: string, answer: string): DiffPart[] {
  const a = [...typed]
  const b = [...answer]
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  )
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i].toLowerCase() === b[j].toLowerCase()
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const out: DiffPart[] = []
  const push = (kind: DiffKind, text: string) => {
    const last = out[out.length - 1]
    if (last && last.kind === kind) last.text += text
    else out.push({ kind, text })
  }
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i].toLowerCase() === b[j].toLowerCase()) {
      push('good', b[j])
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      push('bad', a[i]) // 多打或打错
      i++
    } else {
      push('missed', b[j]) // 漏打
      j++
    }
  }
  while (i < a.length) push('bad', a[i++])
  while (j < b.length) push('missed', b[j++])
  return out
}

/* ---- 提示梯度（FR-223） ---- */

export const HINT_LEVELS = [
  { level: 1, label: '慢速重播 + 音节数', factor: 1.0 },
  { level: 2, label: '长度骨架', factor: 0.8 },
  { level: 3, label: '首字母 + 音标', factor: 0.6 },
  { level: 4, label: '中文释义', factor: 0.4 },
  { level: 5, label: '元音遮罩', factor: 0.3 },
  { level: 6, label: '显示答案', factor: 0 },
] as const

/** 粗略音节数：元音组计数，够用于「● ● ●」提示，不追求语言学精确 */
export function syllables(word: string): number {
  const groups = word.toLowerCase().replace(/e\b/, '').match(/[aeiouy]+/g)
  return Math.max(1, groups?.length ?? 1)
}

/** 元音遮罩（qwerty-learner 的 hideVowel）：negligible → n_gl_g_bl */
export function maskVowels(word: string): string {
  return word.replace(/[aeiouAEIOU]/g, '_')
}

/** 长度骨架：_ _ _ _ (4)，空格原样保留以暗示是词组 */
export function skeleton(word: string): string {
  return `${[...word].map((c) => (c === ' ' ? ' ' : '_')).join(' ')} (${word.length})`
}

/** 提示等级 → 该题得分系数 */
export function hintFactor(level: number): number {
  return HINT_LEVELS.find((h) => h.level === level)?.factor ?? 1
}

/** 得分系数 + 重播次数 → FSRS 评分（FR-222：重播 ≥3 次封顶 Good） */
export function ratingFor(verdict: Verdict, factor: number, replays: number): 1 | 2 | 3 | 4 {
  if (verdict === 'wrong') return 1
  if (verdict === 'almost') return 2
  if (factor < 0.6 || replays >= 3) return 3
  return factor >= 1 ? 4 : 3
}
