import { describe, expect, it } from 'vitest'

import type { DeckItem } from '../../lib/api-deck'
import { filterDeckItems, mergeDeckItems, updateDeckStages } from './useDeckItems'

const word = (name: string): DeckItem => ({
  word: name, phonetic: null, translation: null, definition: null,
  frq: null, freq_band: null, tags: [], collins: null, exchange: null,
  status: 'new', bucket: 'new', difficult: false, mark: null,
  vocab_id: null, due_at: null, group_key: null, example_en: null,
  example_zh: null, dict_miss: false,
})

describe('单词本当前分类成员', () => {
  it('切换分类按最新状态排除旧缓存成员', () => {
    const items = updateDeckStages([word('TV'), word('North'), word('American'), word('new')], { tv: 'mastered', north: 'hard', american: 'learning' })
    expect(filterDeckItems(items, 'all')).toHaveLength(4)
    expect(filterDeckItems(items, 'new').map(item => item.word)).toEqual(['new'])
    expect(filterDeckItems(items, 'learning').map(item => item.word)).toEqual(['American'])
    expect(filterDeckItems(items, 'mastered').map(item => item.word)).toEqual(['TV'])
    expect(filterDeckItems(items, 'difficult').map(item => item.word)).toEqual(['North'])
    expect(mergeDeckItems(filterDeckItems(items, 'learning'), items, 'learning').map(item => item.word)).toEqual(['American'])
  })
  it.each(['learning', 'hard', 'mastered', 'unseen'])('状态变为 %s 后，接口不再返回该词仍保留原位和最新标签', stage => {
    const initial = [word('American'), word('North'), word('TV')]
    const changed = updateDeckStages(initial, { north: stage })
    const refreshed = mergeDeckItems(changed, [initial[0], initial[2]])
    expect(refreshed.map(item => item.word)).toEqual(['American', 'North', 'TV'])
    expect(refreshed[1]).toEqual(changed[1])
    expect(refreshed[1].bucket).toBe(stage === 'mastered' ? 'mature' : stage === 'unseen' ? 'new' : stage === 'hard' ? 'hard' : 'learning')
  })

  it('连续改回学习中与清除进度不残留困难或掌握标签', () => {
    const hard = updateDeckStages([word('TV')], { tv: 'hard' })
    const learning = updateDeckStages(hard, { tv: 'learning' })
    expect(learning[0]).toMatchObject({ mark: 'learning', difficult: false, bucket: 'learning' })
    expect(updateDeckStages(learning, { tv: 'unseen' })[0]).toMatchObject({ mark: null, difficult: false, bucket: 'new' })
  })

  it('分页追加去重，重新拉取不改变已有顺序，词条内容仍更新', () => {
    const updated = { ...word('north'), translation: '北方' }
    const merged = mergeDeckItems([word('American'), word('North')], [updated, word('American'), word('TV')])
    expect(merged.map(item => item.word)).toEqual(['American', 'north', 'TV'])
    expect(merged[1].translation).toBe('北方')
    expect(mergeDeckItems(merged, [])).toEqual(merged)
  })
})
