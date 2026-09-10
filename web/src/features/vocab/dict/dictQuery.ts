/* 查词页与 ⌘K 共用的纯函数：门槛判定、分组、扁平化（FR-507~511）。 */

import type { DictSearchEntry, DictSearchReady } from '../../../lib/api'

export const CJK_RE = /[㐀-䶿一-鿿]/
const MAX_QUERY_LEN = 64

/** 什么样的输入值得发请求：中文一个字就查，英文至少两个字母，通配符至少带一个字母 */
export function isSuggestable(raw: string): boolean {
  const q = raw.trim()
  if (q === '' || q.length > MAX_QUERY_LEN) return false
  if (CJK_RE.test(q)) return true
  if (/[*?]/.test(q)) return /^[a-z*?][a-z'*? -]*$/i.test(q) && /[a-z]/i.test(q)
  return /^[a-z][a-z' -]{1,63}$/i.test(q)
}

export type SectionKind =
  | 'exact'
  | 'forms'
  | 'matches'
  | 'phrases'
  | 'syn'
  | 'ant'
  | 'deriv'
  | 'reverse-exact'
  | 'reverse-prefix'
  | 'reverse-contains'
  | 'glob'
  | 'suggestions'

export interface DictRow extends DictSearchEntry {
  /** 变形行的形态名（过去式 / 复数…） */
  label?: string
}

export interface Section {
  kind: SectionKind
  title: string
  entries: DictRow[]
}

const TITLES: Record<SectionKind, string> = {
  exact: '精确',
  forms: '变形',
  matches: '联想',
  phrases: '词组',
  syn: '近义词',
  ant: '反义词',
  deriv: '派生词',
  'reverse-exact': '精确',
  'reverse-prefix': '前缀',
  'reverse-contains': '包含',
  glob: '通配匹配',
  suggestions: '你是不是想找',
}

/** 分组：空组不出现；同一个词跨组只留首次出现（变形组例外，它本来就是精确组的展开） */
export function groupSearch(resp: DictSearchReady): Section[] {
  const sections: Section[] = []
  const seen = new Set<string>()
  const push = (kind: SectionKind, rows: DictRow[], dedupe = true) => {
    const kept: DictRow[] = []
    for (const row of rows) {
      const key = row.lc
      if (dedupe && seen.has(key)) continue
      seen.add(key)
      kept.push(row)
    }
    if (kept.length > 0) sections.push({ kind, title: TITLES[kind], entries: kept })
  }
  if (resp.kind === 'zh') {
    const by = (level: string) => resp.reverse.filter((r) => r.match === level)
    push('reverse-exact', by('exact'))
    push('reverse-prefix', by('prefix'))
    push('reverse-contains', by('contains'))
    return sections
  }
  if (resp.kind === 'glob') {
    push('glob', resp.matches)
    return sections
  }
  push('exact', [...resp.exact, ...resp.lemmas])
  push(
    'forms',
    resp.forms.flatMap((group) => group.forms),
    false,
  )
  push('matches', resp.matches)
  push('phrases', resp.phrases)
  push('syn', resp.related.syn)
  push('ant', resp.related.ant)
  push('deriv', resp.related.deriv)
  push('suggestions', resp.suggestions)
  return sections
}

export interface FlatRow {
  section: SectionKind
  entry: DictRow
}

export function flattenRows(sections: Section[]): FlatRow[] {
  return sections.flatMap((section) =>
    section.entries.map((entry) => ({ section: section.kind, entry })),
  )
}

/** 结果页与 ⌘K 行上那一小段中文：反查时优先给命中的义项 */
export function briefOf(entry: DictSearchEntry): string {
  return entry.gloss ?? entry.brief ?? ''
}

/** 右栏默认看哪个词：英文精确命中优先（输入是变形时退到原形），反查与通配取第一条 */
export function primaryWord(resp: DictSearchReady): string | null {
  if (resp.kind === 'zh') return resp.reverse[0]?.word ?? null
  if (resp.kind === 'glob') return resp.matches[0]?.word ?? null
  return resp.exact[0]?.word ?? resp.lemmas[0]?.word ?? null
}

/** 近义词辨析的目标词：一律用原形（变形的近义词表本来就是按原形查的） */
export function nuanceWord(resp: DictSearchReady): string | null {
  return resp.lemmas[0]?.word ?? resp.exact.find((e) => e.lemma === null)?.word ?? null
}
