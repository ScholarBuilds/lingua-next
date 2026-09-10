import { expect, it } from 'vitest'

import { MAX_SPOKEN_LEN, spokenMeaning } from './spokenMeaning'

it('strips ECDICT part-of-speech abbreviations and domain tags', () => {
  expect(spokenMeaning('n. 苹果, 苹果树 [计] 苹果公司')).toBe('苹果，苹果树，苹果公司')
  expect(spokenMeaning('a. 大的 ad. 非常')).toBe('大的，非常')
  expect(spokenMeaning('art. 那')).toBe('那')
  expect(spokenMeaning('v. 是, 表示, 在 [计] 后端, 总线允许')).toBe('是，表示，在')
})

it('splits on newlines and semicolons and keeps at most three senses', () => {
  expect(spokenMeaning('vt. 说, 讲, 念, 说明\nvi. 说, 讲\nn. 意见, 发言权')).toBe('说，讲，念')
  expect(spokenMeaning('prep. 除了; conj. 但是; adv. 仅仅')).toBe('除了，但是，仅仅')
})

it('caps the spoken length without starting a sense it cannot finish', () => {
  const out = spokenMeaning('n. 一个非常非常非常长的第一条义项释义, 第二条, 第三条')
  expect(out.length).toBeLessThanOrEqual(MAX_SPOKEN_LEN)
  expect(out.startsWith('一个非常非常非常长的第一条义项释义')).toBe(true)
})

it('returns an empty string when nothing is left to say', () => {
  expect(spokenMeaning(null)).toBe('')
  expect(spokenMeaning('')).toBe('')
  expect(spokenMeaning('n. [计]')).toBe('')
})

it('reads every part of speech with its Chinese name when scope is all', () => {
  expect(
    spokenMeaning('vt. 想, 考虑, 想起, 想像, 打算, 认为\nvi. 思考, 料想\nn. 想法\na. 思想的', {
      scope: 'all',
    }),
  ).toBe('及物动词，想、考虑、想起；不及物动词，思考、料想；名词，想法；形容词，思想的')
  expect(spokenMeaning('n. 苹果, 苹果树 [计] 苹果公司', { scope: 'all' })).toBe('名词，苹果、苹果树、苹果公司')
  // 没有词性标记的释义照念，不硬套词性名
  expect(spokenMeaning('那', { scope: 'all' })).toBe('那')
})

it('keeps the all scope within its own length budget', () => {
  const out = spokenMeaning('n. ' + '很长的义项'.repeat(10) + '\nv. 再来一条', { scope: 'all' })
  expect(out.length).toBeLessThanOrEqual(80)
})
