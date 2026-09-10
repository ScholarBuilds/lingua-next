import { describe, expect, it } from 'vitest'

import { railTarget } from './railTarget'

/* 侧栏菜单项是「用户出不去时的最后一个出口」。
   深链直开 `/talk/session?id=258` 时页面自己没有返回键、面包屑也不可点（两处都已补），
   而菜单项曾经指向当前 URL——点了什么都不会发生。这组用例守着那条兜底。 */

describe('railTarget', () => {
  it('词汇入口忽略已退役的场景页面记忆', () => {
    expect(railTarget({ to: '/vocab', active: false, here: '/', pathname: '/', lastRoute: '/vocab/scenes?study=book' })).toBe('/vocab')
  })
  it('工坊入口始终进入应用首页，保留创作子页自身的记录', () => {
    expect(railTarget({ to: '/studio', active: false, here: '/vocab', pathname: '/vocab', lastRoute: '/studio/gpt/5' })).toBe('/studio')
  })
  it('已在这个模块的子页：回模块首页，而不是指向当前 URL', () => {
    expect(
      railTarget({
        to: '/talk',
        active: true,
        here: '/talk/session?id=258&review=1',
        pathname: '/talk/session',
        lastRoute: '/talk/session?id=258&review=1',
      }),
    ).toBe('/talk')
  })

  it('词汇菜单不再恢复迁移到独立页面的查词标签', () => {
    expect(
      railTarget({
        to: '/vocab',
        active: true,
        here: '/vocab?v=dict&q=go',
        pathname: '/vocab',
        lastRoute: '/vocab?v=dict&q=go',
      }),
    ).toBe('/vocab')
  })

  it('已在模块首页：保持原地，不留一条没用的历史', () => {
    expect(
      railTarget({ to: '/talk', active: true, here: '/talk?tab=scenes', pathname: '/talk' }),
    ).toBe('/talk?tab=scenes')
  })

  it('不在这个模块：走上次待的地方', () => {
    expect(
      railTarget({
        to: '/read',
        active: false,
        here: '/talk',
        pathname: '/talk',
        lastRoute: '/read/48',
      }),
    ).toBe('/read/48')
  })

  it('不在这个模块且关了页面记忆：走模块首页', () => {
    expect(railTarget({ to: '/read', active: false, here: '/talk', pathname: '/talk' })).toBe('/read')
  })

  it('记忆是空串时不当成有效去向——空 href 会让链接指向当前页', () => {
    expect(
      railTarget({ to: '/read', active: false, here: '/talk', pathname: '/talk', lastRoute: '' }),
    ).toBe('/read')
  })

  it('今天页的 to 是 /，在首页点它保持原地', () => {
    expect(railTarget({ to: '/', active: true, here: '/', pathname: '/' })).toBe('/')
  })
})
