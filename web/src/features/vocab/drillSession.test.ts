import { describe, expect, it } from 'vitest'
import type { DeckItem, DeckWordsPage } from '../../lib/api-deck'
import { emptyProgress, firstTryStats, splitGroups, wordPassed } from './grouping'
import type { GroupItem } from './grouping'
import { loadDrillWords, recordAnswer, restoreDrill, restoreDrillSubmission, startGroup } from './drillSession'

const item = (word: string): GroupItem => ({ word, translation: '释义', phonetic: null, vocabId: null })
describe('完整词表与分组', () => {
  it('延后的近形词与末尾词不丢失、不重复', () => {
    const words = ['cat', 'bat', 'hat', 'pat', 'elephant', 'dictionary', 'telephone', 'adapt', 'adopt', 'affect', 'effect']
    const result = splitGroups(words.map(item), 3)
    expect(result.flat().map(w => w.word).sort()).toEqual([...words].sort())
    expect(result.every(g => g.length > 0 && g.length <= 3)).toBe(true)
    expect(() => splitGroups(words.map(item), 0)).toThrow()
  })
  it('分页加载超过 500 词的词本', async () => {
    const items = Array.from({ length: 1603 }, (_, i) => ({ word: String(i) } as DeckItem))
    const offsets: number[] = []
    const result = await loadDrillWords(async offset => {
      offsets.push(offset)
      return { items: items.slice(offset, offset + 500), total: items.length, groups: [] }
    })
    expect(result.items).toHaveLength(1603)
    expect(offsets).toEqual([0, 500, 1000, 1500])
  })
  it('中途空页报错，不把残缺词表作为整本', async () => {
    const page: DeckWordsPage = { items: [], total: 9, groups: [] }
    await expect(loadDrillWords(async () => page)).rejects.toThrow('词表读取不完整')
  })
})
describe('专项练习记录', () => {
  it('响应丢失后刷新保留原提交版本和成绩，拒绝跨轮次和跨组回执', () => {
    const pending = { run_id: 'run', submission_id: 'run:0', version: 2, cursor: 1, passed: ['apple'], first_try_ok: 1, first_try_total: 1 }
    const restored = restoreDrillSubmission(JSON.parse(JSON.stringify(pending)), 'run', 0, ['apple'])
    expect(restored).toEqual(pending)
    expect(() => restoreDrillSubmission(pending, 'other', 0, ['apple'])).toThrow()
    expect(() => restoreDrillSubmission(pending, 'run', 1, ['apple'])).toThrow()
    expect(() => restoreDrillSubmission(pending, 'run', 0, ['banana'])).toThrow()
    expect(restoreDrillSubmission(null, 'run', 0, ['apple'])).toBeNull()
  })
  it('非独立完成重置连对，不获得拼写通过', () => {
    const p = recordAnswer({ ...emptyProgress(), known: true, streak: 2 }, 'spell', false)
    expect(p.streak).toBe(0)
    expect(wordPassed(p)).toBe(false)
  })
  it('后续错误不改变实际首答记录', () => {
    const first = recordAnswer(emptyProgress(), 'zh2en', true)
    const second = recordAnswer(first, 'en2zh', false)
    expect(firstTryStats(new Map([['apple', second]]))).toEqual({ ok: 1, total: 1 })
  })
  it('只恢复词表匹配且字段有效的断点', () => {
    const groups = [[item('apple')]]
    const state = { ...startGroup(), progress: { apple: recordAnswer(emptyProgress(), 'spell', true) } }
    const raw = JSON.stringify({ version: 2, signature: 'apple', state })
    expect(restoreDrill(raw, 'apple', groups)).toEqual(state)
    expect(restoreDrill(raw, 'different', groups)).toBeNull()
    expect(restoreDrill(JSON.stringify({ version: 2, signature: 'apple', state: { ...state, groupIdx: -1 } }), 'apple', groups)).toBeNull()
    expect(restoreDrill(JSON.stringify({ version: 2, signature: 'apple', state: { ...state, progress: { apple: { ...state.progress.apple, seen: '3' } } } }), 'apple', groups)).toBeNull()
  })
})
