/* 视频学习通用工具：字幕词元切分、时间格式化、当前 cue/词定位、
   词组区间分段、听写逐词批改（LCS 对齐）、语音包络（波形示意）。 */

import type { CuePhrase, CueV2, CueWord, SentenceWord } from '../../lib/api-video'

const WORD_RE = /[A-Za-z][A-Za-z'-]*/g

export interface CueToken {
  start: number
  end: number
  surface: string
  /** 小写词元，用于词典/收藏 */
  word: string
}

export function tokenizeCue(text: string): CueToken[] {
  const out: CueToken[] = []
  WORD_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = WORD_RE.exec(text)) !== null) {
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      surface: m[0],
      word: m[0].toLowerCase(),
    })
  }
  return out
}

/** 秒 → m:ss 或 h:mm:ss */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** ms → mm:ss.d（字幕句时间戳，对照设计稿 03:21.5） */
export function formatCueTs(ms: number): string {
  const total = Math.max(0, ms) / 1000
  const m = Math.floor(total / 60)
  const s = total - m * 60
  const sInt = Math.floor(s)
  const dec = Math.floor((s - sInt) * 10)
  return `${String(m).padStart(2, '0')}:${String(sInt).padStart(2, '0')}.${dec}`
}

/** ISO 日期 → 8月10日（今年）/ 2025年8月10日（往年） */
export function formatDate(iso: string | null): string {
  if (iso === null || iso === '') return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const md = `${d.getMonth() + 1}月${d.getDate()}日`
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}年${md}`
}

/** 时间戳 → 相对时间：刚刚 / n 分钟前 / 今天 21:34 / 昨天 21:34 / 8月10日 */
export function formatRelative(at: number): string {
  const diff = Date.now() - at
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  const d = new Date(at)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const today = new Date()
  const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  if (at >= dayStart) return `今天 ${hm}`
  if (at >= dayStart - 86_400_000) return `昨天 ${hm}`
  return formatDate(d.toISOString())
}

interface TimedSpan {
  start_ms: number
  end_ms: number
}

/** ms 落在某条区间内则返回其下标，否则 -1（按时间升序，二分） */
export function findActiveSpan(spans: TimedSpan[], ms: number): number {
  let lo = 0
  let hi = spans.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const c = spans[mid]
    if (ms < c.start_ms) hi = mid - 1
    else if (ms >= c.end_ms) lo = mid + 1
    else return mid
  }
  return -1
}

export function findActiveCue(cues: CueV2[], ms: number): number {
  return findActiveSpan(cues, ms)
}

/** 词级卡拉OK：ms 命中的词下标；落在词间隙时归属前一个词（保持高亮连续），全在其前 -1 */
export function findActiveWord(
  words: readonly (CueWord | SentenceWord)[],
  ms: number,
): number {
  let lo = 0
  let hi = words.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (words[mid][0] <= ms) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

/** 最后一条 start_ms <= ms 的 cue 下标（供上一句/下一句定位），全在其后则 -1 */
export function findRefCue(cues: CueV2[], ms: number): number {
  let lo = 0
  let hi = cues.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (cues[mid].start_ms <= ms) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

/** 中文轨按时间重叠配对：取英文句中点落入的中文句（翻译轨同 start 与官方 zh 轨都兼容） */
export function zhOfCue(zhCues: CueV2[], cue: CueV2): string | undefined {
  if (zhCues.length === 0) return undefined
  const mid = (cue.start_ms + cue.end_ms) / 2
  const exact = findActiveSpan(zhCues, mid)
  if (exact >= 0) return zhCues[exact].text
  const ref = findRefCue(zhCues, mid)
  if (ref < 0) return undefined
  const c = zhCues[ref]
  // 相邻但无覆盖：与英文句时间区间有交集才算配对
  return c.end_ms > cue.start_ms - 500 && c.start_ms < cue.end_ms + 500 ? c.text : undefined
}

/* ---- 词组区间 → 渲染分段 ---- */

export interface CueSegment {
  start: number
  end: number
  /** 命中的词组（取首个覆盖该分段的区间） */
  phrase: CuePhrase | null
  phraseIndex: number
}

/** 把 cue 文本按词组区间切成分段（区间按 start 排序、忽略越界与互相重叠的后者） */
export function segmentCue(text: string, phrases: CuePhrase[] | null): CueSegment[] {
  const len = text.length
  const valid = (phrases ?? [])
    .filter((p) => p[0] >= 0 && p[1] > p[0] && p[1] <= len)
    .sort((a, b) => a[0] - b[0])
  const out: CueSegment[] = []
  let pos = 0
  valid.forEach((p, i) => {
    if (p[0] < pos) return // 与前一区间重叠，丢弃
    if (p[0] > pos) out.push({ start: pos, end: p[0], phrase: null, phraseIndex: -1 })
    out.push({ start: p[0], end: p[1], phrase: p, phraseIndex: i })
    pos = p[1]
  })
  if (pos < len) out.push({ start: pos, end: len, phrase: null, phraseIndex: -1 })
  return out
}

/** 把语法句的词组区间裁剪并平移到学习句的局部坐标。

    切分点优先落在标点与停顿处，极少切断词组；跨边界的直接丢弃而非截断——
    半个词组高亮出来会误导，完整词组在阅读模式与语法句视图里仍然可见。 */
export function slicePhrases(
  phrases: CuePhrase[] | null,
  start: number,
  end: number,
): CuePhrase[] {
  if (phrases === null) return []
  const out: CuePhrase[] = []
  for (const p of phrases) {
    if (p[0] >= start && p[1] <= end) out.push([p[0] - start, p[1] - start, p[2], p[3]])
  }
  return out
}

/** 语法句的词级时间戳 → 落在学习句字符区间内的词（跟读波形与卡拉OK都要用）。 */
export function unitWords(
  sentenceWords: SentenceWord[] | null,
  charStart: number,
  charEnd: number,
): CueWord[] {
  if (sentenceWords === null) return []
  const out: CueWord[] = []
  for (const w of sentenceWords) {
    if (w[3] >= charStart && w[4] <= charEnd) out.push([w[0], w[1], w[2]])
  }
  return out
}

/** 词组类型 → 高亮色类名（蓝=短语动词 绿=搭配 粉=习语） */
export function phraseColorClass(type: string): string {
  if (type === 'phrasal') return 'pv'
  if (type === 'collocation') return 'co'
  return 'sl'
}

/* ---- 听写 / 中译英：逐词批改（LCS 对齐） ---- */

export interface DiffWord {
  /** 参考句原词（保留原样式） */
  word: string
  status: 'ok' | 'wrong' | 'miss'
  /** wrong 时用户实际写的词 */
  got?: string
}

export interface DiffResult {
  items: DiffWord[]
  /** 用户多写、参考句没有的词数 */
  extra: number
  correct: number
  total: number
  /** 0-100 */
  accuracy: number
}

function norm(word: string): string {
  return word.toLowerCase().replace(/^['-]+|['-]+$/g, '')
}

/** 参考句 vs 用户输入的逐词对齐批改：LCS 锚定，参考侧未匹配词与用户侧未匹配词
    一一配对记 wrong（写错），配不上的记 miss（漏写），用户多余的计 extra。 */
export function diffWords(refText: string, userText: string): DiffResult {
  const ref = tokenizeCue(refText)
  const user = tokenizeCue(userText).map((t) => t.surface)
  const a = ref.map((t) => norm(t.word))
  const b = user.map((w) => norm(w.toLowerCase()))
  const n = a.length
  const m = b.length
  // LCS 动态规划
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const items: DiffWord[] = []
  let i = 0
  let j = 0
  let extra = 0
  let pendingUser: string[] = []
  const flushGap = (refWords: CueToken[]) => {
    // 参考侧缺口与用户侧缺口逐一配对：配上的算写错，配不上算漏写/多写
    for (let k = 0; k < refWords.length; k++) {
      const got = pendingUser[k]
      items.push(
        got !== undefined
          ? { word: refWords[k].surface, status: 'wrong', got }
          : { word: refWords[k].surface, status: 'miss' },
      )
    }
    if (pendingUser.length > refWords.length) extra += pendingUser.length - refWords.length
    pendingUser = []
  }
  let refGap: CueToken[] = []
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      flushGap(refGap)
      refGap = []
      items.push({ word: ref[i].surface, status: 'ok' })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      refGap.push(ref[i])
      i++
    } else {
      pendingUser.push(user[j])
      j++
    }
  }
  while (i < n) refGap.push(ref[i++])
  while (j < m) pendingUser.push(user[j++])
  flushGap(refGap)

  const correct = items.reduce((s, it) => s + (it.status === 'ok' ? 1 : 0), 0)
  const total = items.length
  const accuracy = total === 0 ? 0 : Math.round((correct / Math.max(total, correct + extra)) * 100)
  return { items, extra, correct, total, accuracy }
}

/* ---- 语音包络（跟读对比的原句波形示意，按词级时间戳真实节奏生成） ---- */

/** 词级时间戳 → n 桶覆盖率包络（0-1）：词覆盖的时间桶高、词间停顿低 */
/** 波形包络的数据源：cue 与学习句都满足（只需时间区间与词级时间戳） */
export interface EnvelopeSource {
  start_ms: number
  end_ms: number
  words: readonly (CueWord | SentenceWord)[] | null
}

export function speechEnvelope(cue: EnvelopeSource, buckets = 34): number[] {
  const span = cue.end_ms - cue.start_ms
  const out = new Array<number>(buckets).fill(0.12)
  if (span <= 0) return out
  const words = cue.words ?? []
  if (words.length === 0) {
    // 无词级数据：正弦包络兜底
    for (let i = 0; i < buckets; i++) out[i] = 0.3 + Math.sin((i / buckets) * Math.PI) * 0.55
    return out
  }
  for (const [ws, we, w] of words) {
    const b0 = Math.max(0, Math.floor(((ws - cue.start_ms) / span) * buckets))
    const b1 = Math.min(buckets - 1, Math.ceil(((we - cue.start_ms) / span) * buckets))
    // 词长驱动幅度差异，视觉上更接近真实语音
    const amp = 0.55 + Math.min(0.4, w.length * 0.05)
    for (let b = b0; b <= b1; b++) {
      const mid = (b0 + b1) / 2
      const fall = b1 > b0 ? 1 - Math.abs(b - mid) / (b1 - b0 + 1) : 1
      out[b] = Math.max(out[b], amp * (0.6 + fall * 0.4))
    }
  }
  return out
}

/** 数组重采样到 n 桶（录音波形归一化展示用） */
export function resample(data: number[], buckets: number): number[] {
  if (data.length === 0) return new Array<number>(buckets).fill(0)
  const out = new Array<number>(buckets).fill(0)
  for (let i = 0; i < buckets; i++) {
    const s = Math.floor((i / buckets) * data.length)
    const e = Math.max(s + 1, Math.floor(((i + 1) / buckets) * data.length))
    let max = 0
    for (let k = s; k < e; k++) max = Math.max(max, data[k])
    out[i] = max
  }
  const peak = Math.max(...out, 0.001)
  return out.map((v) => v / peak)
}
