import { beforeEach, expect, it } from 'vitest'

import { MAX_RECENT, useDictStore } from './dictStore'

beforeEach(() => useDictStore.setState({ query: '', word: '', recent: [] }))

it('同词前移、超过上限淘汰最旧', () => {
  const { remember } = useDictStore.getState()
  for (let i = 0; i < MAX_RECENT + 5; i += 1) remember(`w${i}`, `义${i}`)
  let recent = useDictStore.getState().recent
  expect(recent.length).toBe(MAX_RECENT)
  expect(recent[0].word).toBe(`w${MAX_RECENT + 4}`)
  expect(recent.some((r) => r.word === 'w0')).toBe(false)
  remember('w10', '新义')
  recent = useDictStore.getState().recent
  expect(recent[0]).toMatchObject({ word: 'w10', brief: '新义' })
  expect(recent.filter((r) => r.word === 'w10').length).toBe(1)
})

it('setLookup 相同值不产生新状态，clearRecent 清空', () => {
  const before = useDictStore.getState()
  before.setLookup('', '')
  expect(useDictStore.getState()).toBe(before)
  before.setLookup('go', 'went')
  expect(useDictStore.getState()).toMatchObject({ query: 'go', word: 'went' })
  before.remember('went', 'go的过去式')
  before.clearRecent()
  expect(useDictStore.getState().recent).toEqual([])
})
