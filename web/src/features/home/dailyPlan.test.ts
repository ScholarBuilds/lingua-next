import { describe, expect, it } from 'vitest'
import { arrangePlan, localDay, localPracticeItems } from './dailyPlan'
import type { PlanItem } from '@/lib/api-home'

describe('今日安排', () => {
  const item = (key: string, priority: number): PlanItem => ({ key, kind: 'practice', title: key, priority, href: '/vocab', progress: '1 / 3 题', updated_at: null })
  it('置顶优先，当天暂放跨午夜自动恢复且不改动断点', () => {
    const rows = [item('reading', 3), item('review', 0), item('practice', 1)]
    const before = JSON.stringify(rows)
    const today = arrangePlan(rows, ['reading'], { practice: '2026-09-06' }, '2026-09-06')
    expect(today.active.map(row => row.key)).toEqual(['reading', 'review'])
    expect(today.deferred.map(row => row.key)).toEqual(['practice'])
    expect(arrangePlan(rows, ['reading'], { practice: '2026-09-06' }, '2026-09-07').active).toHaveLength(3)
    expect(JSON.stringify(rows)).toBe(before)
  })
  it('使用配置时区而非设备时区计算日期', () => {
    const now = new Date('2026-09-07T02:00:00Z')
    expect(localDay(now, 'America/Los_Angeles')).toBe('2026-09-06')
    expect(localDay(now, 'Asia/Shanghai')).toBe('2026-09-07')
  })
  it('旧速记断点、损坏断点和听读使用原记录，不复制练习数据', () => {
    const records = new Map([
      ['nexus:drill:v2:custom:1:饮食:用餐', JSON.stringify({ version: 2, signature: '[["one"],["two"]]', state: { groupIdx: 1 }, deckName: '测试本' })],
      ['nexus:drill:v2:zk:bad', '{'],
      ['nexus:drill:v2:zk:finished', JSON.stringify({ version: 2, signature: '[["one"]]', state: { groupIdx: 1 } })],
    ])
    const rows = localPracticeItems({ length: records.size, key: index => [...records.keys()][index], getItem: key => records.get(key) ?? null }, {
      'zk|learning|alpha||饮食': { word: 'apple', at: 1000, position: 2, total: 100 },
    })
    expect(rows).toHaveLength(3)
    expect(rows[0].deckKey).toBe('custom:1')
    expect(decodeURIComponent(rows[0].href)).toContain('饮食:用餐')
    expect(rows[0].progress).toContain('1 / 2')
    expect(rows[1].unavailable).toBeTruthy()
    expect(rows[2].href).toContain('f=learning')
    expect(rows[2].word).toBe('apple')
  })
})
