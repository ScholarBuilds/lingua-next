import { beforeEach, expect, it } from 'vitest'

import { previousVisit, previousVisitInModule, recordVisit, resetVisitsForTests } from './navHistory'

beforeEach(() => resetVisitsForTests())

it('answers whether one step back stays inside the current module', () => {
  recordVisit(0, 'read', '/read/5')
  recordVisit(1, 'vocab', '/vocab?v=deck&k=zk')
  recordVisit(2, 'vocab', '/vocab?v=drill&k=zk')
  // 速记 → 上一页是单词本：退一步
  expect(previousVisitInModule(2, 'vocab')).toBe(true)
  // 单词本是从阅读切菜单进来的：不退，去本模块父级
  expect(previousVisitInModule(1, 'vocab')).toBe(false)
  expect(previousVisitInModule(0, 'read')).toBe(false)
  expect(previousVisitInModule(undefined, 'vocab')).toBe(false)
})

it('overwrites a history slot when a new navigation replaces a forward branch', () => {
  recordVisit(0, 'vocab', '/vocab')
  recordVisit(1, 'read', '/read/1')
  recordVisit(1, 'vocab', '/vocab?v=deck&k=zk')
  expect(previousVisit(2)).toEqual({ module: 'vocab', route: '/vocab?v=deck&k=zk' })
  expect(previousVisitInModule(2, 'vocab')).toBe(true)
})
