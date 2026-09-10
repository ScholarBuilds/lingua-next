/* 视频库进度链路的守卫测试。
 *
   守的是一个整整齐齐、看不出坏的 bug：syncLibEntry 曾经自己去数本地那个已学句集合，
   而「听懂了 ✓」早就迁到服务端了，集合永远是空 —— 进度环、「已学完」筛选、
   「按进度」排序、卡片降透明度四处一起显示 0，界面完全正常，只是全库永远像没学过。

   所以这里钉三件事：learned 是调用方（学习页）从服务端拿来传进来的、pct 按它算、
   done 的判据只有 isFinished 一处。

   测试跑在 node 里（本仓 vitest 没配 jsdom），localStorage 自己搭桩。 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  isFinished,
  isStarted,
  libPct,
  readLibIndex,
  removeLibEntry,
  syncLibEntry,
} from './videoStudyStore'
import type { LibEntry } from './videoStudyStore'

const g = globalThis as Record<string, unknown>

function fakeStorage(): Map<string, string> {
  const map = new Map<string, string>()
  g.localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  }
  return map
}

const entryOf = (videoId: string): LibEntry | undefined => readLibIndex()[videoId]

beforeEach(() => {
  fakeStorage()
})

afterEach(() => {
  delete g.localStorage
})

describe('服务端已学数进库级索引', () => {
  it('learned 传进来后 pct 按它算，不再是恒 0', () => {
    syncLibEntry('7', 40, 10, 12.5)
    expect(entryOf('7')).toMatchObject({ learned: 10, total: 40, pct: 25, lastPosS: 12.5 })
  })

  it('学满即 100，isFinished 认它', () => {
    syncLibEntry('7', 40, 40, 300)
    const e = entryOf('7')
    expect(e?.pct).toBe(100)
    expect(isFinished(e)).toBe(true)
  })

  it('差一句不许凑成 100', () => {
    /* 四舍五入会把 999/1000 抬到 100，卡片当场打勾说已学完，
       用户翻遍全片也找不出还差哪一句 */
    syncLibEntry('7', 1000, 999, 0)
    expect(entryOf('7')?.pct).toBe(99)
    expect(isFinished(entryOf('7'))).toBe(false)
  })

  it('已学数超过总句数（换轨/重切句）时截到总数，不出 120%', () => {
    syncLibEntry('7', 10, 33, 0)
    expect(entryOf('7')).toMatchObject({ learned: 10, total: 10, pct: 100 })
  })

  it('总句数为 0（字幕还没切句）时不猜进度', () => {
    syncLibEntry('7', 0, 0, 4)
    const e = entryOf('7')
    expect(e?.pct).toBe(0)
    expect(isFinished(e)).toBe(false)
    expect(isStarted(e)).toBe(true) // 有播放位置，算学过
  })

  it('位置未知（传 undefined）时保留上次记的位置', () => {
    /* 只是已学数变了就把 lastPosS 抹成 0 的话，「回到 3:20」会变成「回到 0:00」 */
    syncLibEntry('7', 40, 3, 200)
    syncLibEntry('7', 40, 4, undefined)
    expect(entryOf('7')).toMatchObject({ learned: 4, lastPosS: 200 })
  })

  it('删条目连带清掉库级索引', () => {
    syncLibEntry('7', 40, 4, 12)
    removeLibEntry('7')
    expect(entryOf('7')).toBeUndefined()
  })
})

describe('已学完 / 已开始判据', () => {
  const e = (over: Partial<LibEntry>): LibEntry => ({
    learned: 0,
    total: 0,
    pct: 0,
    lastAt: 1,
    lastPosS: 0,
    ...over,
  })

  it('pct 100 且有句数才算学完', () => {
    expect(isFinished(e({ total: 40, pct: 100 }))).toBe(true)
    expect(isFinished(e({ total: 40, pct: 99 }))).toBe(false)
    // total 0 的空壳条目 pct 也是 0，但别让它被判成学完
    expect(isFinished(e({ total: 0, pct: 100 }))).toBe(false)
    expect(isFinished(undefined)).toBe(false)
  })

  it('学过一句或播过一秒都算开始', () => {
    expect(isStarted(e({ learned: 1 }))).toBe(true)
    expect(isStarted(e({ lastPosS: 0.5 }))).toBe(true)
    expect(isStarted(e({}))).toBe(false)
    expect(isStarted(undefined)).toBe(false)
  })
})

describe('libPct', () => {
  it('边界', () => {
    expect(libPct(0, 0)).toBe(0)
    expect(libPct(5, 0)).toBe(0)
    expect(libPct(0, 10)).toBe(0)
    expect(libPct(1, 3)).toBe(33)
    expect(libPct(10, 10)).toBe(100)
    expect(libPct(11, 10)).toBe(100)
  })
})
