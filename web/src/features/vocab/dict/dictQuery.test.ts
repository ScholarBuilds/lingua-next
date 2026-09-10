import { describe, expect, it } from 'vitest'

import type { DictSearchEntry, DictSearchReady } from '../../../lib/api'
import { briefOf, flattenRows, groupSearch, isSuggestable, nuanceWord, primaryWord } from './dictQuery'

function entry(word: string, extra: Partial<DictSearchEntry> = {}): DictSearchEntry {
  return {
    word,
    lc: word.toLowerCase(),
    brief: null,
    phonetic: null,
    tags: [],
    frq_rank: null,
    freq_band: null,
    tier: 1,
    lemma: null,
    proper: false,
    match: 'prefix',
    stage: 'unseen',
    in_vocab: false,
    vocab_id: null,
    mark: null,
    ...extra,
  }
}

function ready(partial: Partial<DictSearchReady>): DictSearchReady {
  return {
    ready: true,
    q: 'x',
    kind: 'en',
    exact: [],
    lemmas: [],
    forms: [],
    matches: [],
    phrases: [],
    related: { syn: [], ant: [], deriv: [] },
    reverse: [],
    suggestions: [],
    source: { dict: 'ECDICT', forms: 'x', related: null, fuzzy: 'x', index_built_at: null },
    ...partial,
  }
}

describe('isSuggestable', () => {
  it('中文一个字就查，英文至少两个字母', () => {
    expect(isSuggestable('a')).toBe(false)
    expect(isSuggestable('ab')).toBe(true)
    expect(isSuggestable('苹')).toBe(true)
    expect(isSuggestable(' go ')).toBe(true)
    expect(isSuggestable('12')).toBe(false)
    expect(isSuggestable('ab*')).toBe(true)
    expect(isSuggestable('*')).toBe(false)
    expect(isSuggestable('a'.repeat(65))).toBe(false)
  })
})

describe('groupSearch', () => {
  it('英文按组序排、跨组去重、空组不出现', () => {
    const resp = ready({
      exact: [entry('went', { lemma: 'go', match: 'exact' })],
      lemmas: [entry('go', { match: 'lemma' })],
      forms: [{ lemma: 'go', forms: [{ ...entry('went', { match: 'form' }), code: 'p', codes: ['p'], label: '过去式' }] }],
      matches: [entry('went'), entry('wentletrap')],
      related: { syn: [entry('go')], ant: [], deriv: [entry('going')] },
    })
    const sections = groupSearch(resp)
    expect(sections.map((s) => s.kind)).toEqual(['exact', 'forms', 'matches', 'deriv'])
    expect(sections[0].entries.map((e) => e.word)).toEqual(['went', 'go'])
    expect(sections[1].entries[0].label).toBe('过去式')
    // went 已在精确组，联想组里去掉；go 已出现，近义词组整组消失
    expect(sections[2].entries.map((e) => e.word)).toEqual(['wentletrap'])
    expect(flattenRows(sections).map((r) => r.entry.word)).toEqual(['went', 'go', 'went', 'wentletrap', 'going'])
    expect(primaryWord(resp)).toBe('went')
    expect(nuanceWord(resp)).toBe('go')
  })

  it('拼写建议只在后端给了才成组', () => {
    const resp = ready({ suggestions: [entry('abandon', { match: 'fuzzy' })] })
    expect(groupSearch(resp).map((s) => s.kind)).toEqual(['suggestions'])
    expect(primaryWord(resp)).toBeNull()
  })

  it('中文按三档分组，义项当简释', () => {
    const resp = ready({
      kind: 'zh',
      reverse: [
        entry('abandon', { match: 'exact', gloss: '放弃', brief: '放弃' }),
        entry('waiver', { match: 'prefix', gloss: '放弃权利', brief: '弃权' }),
        entry('abandon', { match: 'contains', gloss: '完全放弃' }),
      ],
    })
    const sections = groupSearch(resp)
    expect(sections.map((s) => s.title)).toEqual(['精确', '前缀'])
    expect(briefOf(sections[1].entries[0])).toBe('放弃权利')
    expect(primaryWord(resp)).toBe('abandon')
  })

  it('通配一组', () => {
    expect(groupSearch(ready({ kind: 'glob', matches: [entry('abandon', { match: 'glob' })] })).map((s) => s.kind)).toEqual(['glob'])
  })
})
