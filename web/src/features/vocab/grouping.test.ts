/* 速记的过关判据与选项生成。

   这个文件存在的理由是三个**沉默**的 bug：判过关时自评直接顶替测验、
   四个选项每次一模一样、以及「答对几次算过」没有出处。
   全都不会报错，只会让练习失去意义。 */

import { describe, expect, it } from 'vitest'

import {
  distractors,
  emptyProgress,
  optionsFor,
  pickNext,
  shuffled,
  targetStreak,
  wordPassed,
} from './grouping'
import type { GroupItem, WordProgress } from './grouping'

function item(word: string, translation = `${word}的意思`): GroupItem {
  return { word, translation, phonetic: null, vocabId: null }
}

const GROUP = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf'].map((w) =>
  item(w),
)

function progressOf(p: Partial<WordProgress>): WordProgress {
  return { ...emptyProgress(), ...p }
}

describe('wordPassed', () => {
  it('自评「认识」不再直接判过关', () => {
    // 老判据是 `p.known || (...)`：按一下「这个我认识」就过关，
    // 于是 pickNext 永久过滤掉它，这个词一道题都不考——
    // 速记可以一路点过去、零测验、零 FSRS 写入，结束还报「本组通过」
    expect(wordPassed(progressOf({ known: true }))).toBe(false)
  })

  it('自评认识的词答对一次就算过', () => {
    const p = progressOf({ known: true, streak: 1, lastProductive: true })
    expect(targetStreak(p)).toBe(1)
    expect(wordPassed(p)).toBe(true)
  })

  it('自评「不会」的要连对两次', () => {
    const weak = progressOf({ known: true, weak: true, streak: 1, lastProductive: true })
    expect(targetStreak(weak)).toBe(2)
    expect(wordPassed(weak)).toBe(false)
    expect(wordPassed({ ...weak, streak: 2 })).toBe(true)
  })

  it('最后一次不是产出类就不算过', () => {
    // 连对两次但最后一次是选择题：认得出来不等于写得出来
    expect(wordPassed(progressOf({ streak: 5, lastProductive: false }))).toBe(false)
  })
})

describe('选项', () => {
  it('干扰项不再是固定的前三个', () => {
    // 老写法 `slice(0, 3)` 再 localeCompare 排序：同一个词每次出现，
    // 四个选项与顺序完全一样，第二遍记住的是位置不是词
    const answer = GROUP[0]
    const got = distractors(GROUP, answer).map((d) => d.word)
    const naive = GROUP.filter((g) => g.word !== answer.word)
      .slice(0, 3)
      .map((g) => g.word)
    expect(got).toHaveLength(3)
    expect(got).not.toEqual(naive)
  })

  it('干扰项不含答案本身', () => {
    for (const answer of GROUP) {
      expect(distractors(GROUP, answer).map((d) => d.word)).not.toContain(answer.word)
    }
  })

  it('同一道题的选项顺序稳定（渲染多次不会跳）', () => {
    const a = optionsFor(GROUP, GROUP[2], 'en2zh').map((o) => o.word)
    const b = optionsFor(GROUP, GROUP[2], 'en2zh').map((o) => o.word)
    expect(a).toEqual(b)
  })

  it('不同词的选项顺序不同，答案不会总在同一位', () => {
    const positions = GROUP.map((w) =>
      optionsFor(GROUP, w, 'en2zh').findIndex((o) => o.word === w.word),
    )
    expect(new Set(positions).size).toBeGreaterThan(1)
  })

  it('同一个词的两种题型排列不同', () => {
    const en = optionsFor(GROUP, GROUP[0], 'en2zh').map((o) => o.word)
    const zh = optionsFor(GROUP, GROUP[0], 'zh2en').map((o) => o.word)
    expect(en).not.toEqual(zh)
  })

  it('每道题都恰好四个选项且含正确答案', () => {
    for (const w of GROUP) {
      const opts = optionsFor(GROUP, w, 'en2zh')
      expect(opts).toHaveLength(4)
      expect(opts.map((o) => o.word)).toContain(w.word)
    }
  })

  it('组内词不足时不会造出空选项', () => {
    const tiny = GROUP.slice(0, 2)
    const opts = optionsFor(tiny, tiny[0], 'en2zh')
    expect(opts).toHaveLength(2)
    expect(opts.every((o) => o.translation !== null)).toBe(true)
  })

  it('没有释义的词不当干扰项（选项会是空白）', () => {
    const withBlank = [...GROUP, { ...item('hotel'), translation: null }]
    const opts = optionsFor(withBlank, GROUP[0], 'en2zh')
    expect(opts.map((o) => o.word)).not.toContain('hotel')
  })
})

describe('shuffled', () => {
  it('同种子同结果，异种子异结果', () => {
    const list = [1, 2, 3, 4, 5, 6, 7, 8]
    expect(shuffled(list, 42)).toEqual(shuffled(list, 42))
    expect(shuffled(list, 42)).not.toEqual(shuffled(list, 43))
  })

  it('不改原数组，元素一个不丢', () => {
    const list = [1, 2, 3, 4, 5]
    const out = shuffled(list, 7)
    expect(list).toEqual([1, 2, 3, 4, 5])
    expect([...out].sort()).toEqual([1, 2, 3, 4, 5])
  })
})

describe('pickNext', () => {
  it('全过关了返回 null（这是进结算的唯一信号）', () => {
    const done = new Map(
      GROUP.map((g) => [g.word, progressOf({ streak: 2, lastProductive: true })]),
    )
    expect(pickNext(GROUP, done, [])).toBeNull()
  })

  it('自评「不会」的排在同样错次数的前面', () => {
    const progress = new Map(GROUP.map((g) => [g.word, emptyProgress()]))
    progress.set('golf', progressOf({ weak: true }))
    expect(pickNext(GROUP, progress, [])?.word).toBe('golf')
  })

  it('错得多的优先于只是自评不会的', () => {
    const progress = new Map(GROUP.map((g) => [g.word, emptyProgress()]))
    progress.set('golf', progressOf({ weak: true }))
    progress.set('echo', progressOf({ wrong: 3 }))
    expect(pickNext(GROUP, progress, [])?.word).toBe('echo')
  })

  it('刚考过的词不连着再考', () => {
    const progress = new Map(GROUP.map((g) => [g.word, emptyProgress()]))
    progress.set('alpha', progressOf({ wrong: 9 }))
    // alpha 错得最多，但刚出现过 → 让位
    expect(pickNext(GROUP, progress, ['alpha'])?.word).not.toBe('alpha')
  })
})
