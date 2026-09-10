import { describe, expect, it } from 'vitest'

import { actionCommands, filterPalette, pageCommands, PAGES } from './commandItems'

const ctx = {
  navigate: () => {},
  openSettings: () => {},
  toggleTheme: () => {},
  toggleNav: () => {},
}

describe('⌘K 条目', () => {
  it('页面目的地都是站内绝对路径，且不重复', () => {
    const targets = PAGES.map((p) => p.to)
    expect(targets.every((t) => t.startsWith('/'))).toBe(true)
    expect(new Set(targets).size).toBe(targets.length)
  })

  it('id 与标签在页面与命令之间不撞', () => {
    const all = [...pageCommands(ctx), ...actionCommands(ctx)]
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length)
    expect(new Set(all.map((c) => c.label)).size).toBe(all.length)
  })

  it('每条命令都接了处理器', () => {
    const calls: string[] = []
    const spy = {
      navigate: (to: string) => calls.push(`nav:${to}`),
      openSettings: (s?: string) => calls.push(`settings:${s ?? ''}`),
      toggleTheme: () => calls.push('theme'),
      toggleNav: () => calls.push('nav-toggle'),
    }
    const all = [...pageCommands(spy), ...actionCommands(spy)]
    all.forEach((c) => c.run())
    expect(calls.length).toBe(all.length)
  })
})

describe('filterPalette', () => {
  const items = pageCommands(ctx)
  it('空串保持登记顺序', () => {
    expect(filterPalette(items, '  ')).toEqual(items)
  })
  it('按标签或关键词命中', () => {
    expect(filterPalette(items, '查词').map((c) => c.label)).toEqual(['查词'])
    expect(filterPalette(items, 'gmail').map((c) => c.label)).toEqual(['邮件'])
  })
  it('没命中就是空', () => {
    expect(filterPalette(items, 'zzzz')).toEqual([])
  })
})
