/* 选择语义的守卫测试。
 *
   修饰键分派错了不会报错，只会「点着点着选区就不对了」——
   ⌘ 点该减选却在加选、合并线只选中一半、⇧ 连点把刚加进来的又摘掉。
   这些都是靠肉眼很难自证的一类，只能锁在这里。 */

import { describe, expect, it } from 'vitest'

import { applySelection, selectModeOf } from './selection'

const evt = (mods: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }>) => ({
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  ...mods,
})

describe('修饰键分档', () => {
  it('裸点是替换，⇧ 是加选，⌘/Ctrl 是反选', () => {
    expect(selectModeOf(evt({}))).toBe('replace')
    expect(selectModeOf(evt({ shiftKey: true }))).toBe('append')
    expect(selectModeOf(evt({ metaKey: true }))).toBe('toggle')
    expect(selectModeOf(evt({ ctrlKey: true }))).toBe('toggle')
  })

  it('⌘ 与 ⇧ 同时按住按反选算（与 Figma 一致）', () => {
    expect(selectModeOf(evt({ shiftKey: true, metaKey: true }))).toBe('toggle')
  })
})

describe('结算选区', () => {
  it('replace 只留这一下点中的', () => {
    expect(applySelection(['a', 'b'], ['c'], 'replace')).toEqual(['c'])
  })

  it('append 加进去，连点两次不会把它摘掉', () => {
    const once = applySelection(['a'], ['b'], 'append')
    expect(once).toEqual(['a', 'b'])
    expect(applySelection(once, ['b'], 'append')).toEqual(['a', 'b'])
  })

  it('toggle 在选区里就摘掉，不在就加进来', () => {
    expect(applySelection(['a', 'b'], ['b'], 'toggle')).toEqual(['a'])
    expect(applySelection(['a'], ['b'], 'toggle')).toEqual(['a', 'b'])
  })

  it('合并线成桶：整桶都选中了才算已选中，缺一条就是补齐而不是摘掉', () => {
    // 桶里 x 已选、y 没选 —— 这一下该把 y 补上，而不是把 x 摘掉
    expect(applySelection(['x'], ['x', 'y'], 'toggle')).toEqual(['x', 'y'])
    // 整桶都在里面了，再点一次才是整桶摘掉
    expect(applySelection(['x', 'y'], ['x', 'y'], 'toggle')).toEqual([])
  })

  it('已选中的保持原有顺序，新加的接在后面', () => {
    expect(applySelection(['b', 'a'], ['c'], 'append')).toEqual(['b', 'a', 'c'])
  })

  it('replace 里的重复 key 去重', () => {
    expect(applySelection([], ['a', 'a', 'b'], 'replace')).toEqual(['a', 'b'])
  })

  it('没点中任何东西时选区原样不动', () => {
    expect(applySelection(['a'], [], 'replace')).toEqual(['a'])
  })

  it('不改传进来的数组（调用方常常直接把 store 里那份递进来）', () => {
    const current = ['a', 'b']
    applySelection(current, ['b'], 'toggle')
    expect(current).toEqual(['a', 'b'])
  })
})
