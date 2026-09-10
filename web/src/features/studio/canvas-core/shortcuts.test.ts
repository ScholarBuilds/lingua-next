/* 快捷键表的守卫（需求 §6.3）。
 *
   守的是三件靠肉眼很难回归的事：

   1. **帮助面板和真实绑定是同一份数据**——蓝本两边各写一遍，
      改了绑定忘了改面板，用户照着面板按没反应；
   2. **不会两条键位撞在一起**——撞了之后先声明的赢，后一条永远不触发，
      而且完全不报错；
   3. **输入框里不误伤**——在提示词框里按 Delete 应该删字符，不是删节点。 */

import { describe, expect, it } from 'vitest'

import { GESTURES, MOD_LABEL, SHORTCUTS, isEditable, shortcutGroups, shortcutLabel } from './shortcuts'

function fingerprint(s: { key: string; mod?: boolean; shift?: boolean; alt?: boolean }): string {
  return [s.key.toLowerCase(), s.mod === true ? 'mod' : '', s.shift === true ? 'shift' : '', s.alt === true ? 'alt' : '']
    .filter(Boolean)
    .join('+')
}

describe('键位表', () => {
  it('没有两条键位撞在一起', () => {
    const seen = new Map<string, string>()
    const clashes: string[] = []
    for (const s of SHORTCUTS) {
      const fp = fingerprint(s)
      const prev = seen.get(fp)
      // 同一个 action 用两个键是允许的（Delete / Backspace 都删）
      if (prev !== undefined && prev !== s.action) clashes.push(`${fp}: ${prev} vs ${s.action}`)
      seen.set(fp, s.action)
    }
    expect(clashes).toEqual([])
  })

  it('每条都有 label 和一句话说明', () => {
    const bad = SHORTCUTS.filter((s) => s.label.trim() === '' || s.hint.trim() === '')
    expect(bad.map((s) => s.action)).toEqual([])
  })

  it('四种删除手势都收，且都不在输入框生效', () => {
    const dels = SHORTCUTS.filter((s) => s.action === 'delete')
    /* 裸 Delete / 裸 Backspace / ⌘+Backspace / ⌘+Delete 四条都要在。
       **mac 笔记本键盘没有 Delete 键**，右上角那个是 Backspace，
       而系统级的删除手势是 ⌘+Delete（Finder 删文件就是它）。
       只认裸键的话 mac 用户按惯用手势删不掉节点，且按下去毫无反应。 */
    expect(dels.map((s) => `${s.mod === true ? 'mod+' : ''}${s.key}`).sort()).toEqual([
      'Backspace',
      'Delete',
      'mod+Backspace',
      'mod+Delete',
    ])
    expect(dels.every((s) => s.allowInInput !== true)).toBe(true)
  })

  it('每个 action 至少留一条可见的键位，面板不会出现空组', () => {
    const actions = new Set(SHORTCUTS.map((s) => s.action))
    for (const a of actions) {
      const visible = SHORTCUTS.filter((s) => s.action === a && s.hidden !== true)
      expect(visible.length, `${a} 的键位全被标 hidden 了，帮助面板里会看不到它`).toBeGreaterThan(0)
    }
  })

  it('只有 Escape 允许在输入框里生效', () => {
    const allowed = SHORTCUTS.filter((s) => s.allowInInput === true).map((s) => s.action)
    expect(allowed).toEqual(['escape'])
  })

  it('撤销与重做是同一个键差一个 Shift', () => {
    const undo = SHORTCUTS.find((s) => s.action === 'undo')
    const redo = SHORTCUTS.find((s) => s.action === 'redo')
    expect(undo?.key).toBe('z')
    expect(redo?.key).toBe('z')
    expect(undo?.shift).toBeUndefined()
    expect(redo?.shift).toBe(true)
  })

  it('成组与解组同理', () => {
    expect(SHORTCUTS.find((s) => s.action === 'group')?.mod).toBe(true)
    expect(SHORTCUTS.find((s) => s.action === 'ungroup')?.shift).toBe(true)
  })

  it('适应画布与放大到选区也是同一个键差一个 Shift', () => {
    const all = SHORTCUTS.find((s) => s.action === 'fitView')
    const some = SHORTCUTS.find((s) => s.action === 'fitSelection')
    expect(all?.key).toBe('f')
    expect(some?.key).toBe('f')
    expect(all?.shift).toBeUndefined()
    expect(some?.shift).toBe(true)
    /* 两条都不带 mod：带了就和浏览器的 ⌘F 查找撞上，
       而浏览器原生行为拦不住，用户会看到查找框弹出来 */
    expect(all?.mod).toBeUndefined()
    expect(some?.mod).toBeUndefined()
  })
})

describe('显示名', () => {
  it('带修饰键时按 mac/其它给出对应符号', () => {
    const undo = SHORTCUTS.find((s) => s.action === 'undo')
    expect(undo).toBeDefined()
    expect(shortcutLabel(undo!)).toBe(`${MOD_LABEL} + Z`)
  })

  it('单字母大写，特殊键保留原名', () => {
    expect(shortcutLabel({ action: 'delete', key: 'Delete', label: '', hint: '' })).toBe('Delete')
    expect(shortcutLabel({ action: 'fitView', key: 'f', label: '', hint: '' })).toBe('F')
  })

  it('多个修饰键按 mod → Shift → Alt 排', () => {
    const redo = SHORTCUTS.find((s) => s.action === 'redo')
    expect(shortcutLabel(redo!)).toBe(`${MOD_LABEL} + Shift + Z`)
  })
})

describe('帮助面板分组', () => {
  it('分组覆盖表里的每一条，一条都不落', () => {
    const grouped = new Set(shortcutGroups().flatMap((g) => g.items.map((s) => s.action)))
    const all = new Set(SHORTCUTS.map((s) => s.action))
    const missing = [...all].filter((a) => !grouped.has(a))
    expect(missing).toEqual([])
  })

  it('隐藏的兼容别名不进面板，但仍在绑定表里', () => {
    const hidden = SHORTCUTS.filter((s) => s.hidden === true)
    expect(hidden.length).toBeGreaterThan(0)
    const shown = shortcutGroups().flatMap((g) => g.items)
    /* 身份要连修饰键一起比。只按 (key, action) 认的话，
       「⌘+Backspace 可见」与「裸 Backspace 隐藏」会被判成同一条——
       加了 ⌘ 删除手势之后这个判据就不再唯一了。 */
    const idOf = (s: (typeof SHORTCUTS)[number]): string =>
      `${s.action}|${s.key}|${s.mod === true}|${s.shift === true}|${s.alt === true}`
    const shownIds = new Set(shown.map(idOf))
    for (const h of hidden) {
      expect(shownIds.has(idOf(h)), `${idOf(h)} 标了 hidden 却出现在面板里`).toBe(false)
    }
  })

  it('每组都有标题和至少一项', () => {
    for (const g of shortcutGroups()) {
      expect(g.title).not.toBe('')
      expect(g.items.length).toBeGreaterThan(0)
    }
  })

  it('手势也各带一句说明——它们不是键盘事件但要在同一张表里', () => {
    expect(GESTURES.length).toBeGreaterThan(6)
    expect(GESTURES.every((g) => g.label !== '' && g.hint !== '')).toBe(true)
  })
})

/** 假一个事件目标。`isEditable` 只碰 tagName / isContentEditable /
    getAttribute / closest 四样，够用了——本仓 vitest 跑在 node 里没有 jsdom。 */
function target(opts: { tag?: string; role?: string; ancestorRole?: string } = {}): EventTarget {
  const { tag = 'DIV', role = '', ancestorRole = '' } = opts
  return {
    tagName: tag,
    isContentEditable: false,
    getAttribute: (name: string) => (name === 'role' ? role : null),
    closest: (selector: string) =>
      ancestorRole !== '' && selector.includes(`[role="${ancestorRole}"]`) ? {} : null,
  } as unknown as EventTarget
}

describe('让路判据只有一份', () => {
  /* 空格平移（useSpaceHeld）自己挂 window 监听、不走这张键位表，
     但用的必须是同一个 isEditable。它原来自己写了一串选择器且漏了下拉的
     几个 role——尺寸/质量下拉开着按空格，选项没被选中，画布反而进了平移待命态。
     两边都不报错，只能靠这条钉住。 */
  it.each([
    ['输入框', target({ tag: 'INPUT' })],
    ['多行输入', target({ tag: 'TEXTAREA' })],
    ['原生下拉', target({ tag: 'SELECT' })],
    ['Radix 下拉触发器', target({ role: 'combobox' })],
    ['下拉选项', target({ role: 'option' })],
    ['选项列表', target({ role: 'listbox' })],
    ['菜单项', target({ role: 'menuitem' })],
    ['portal 出去的菜单里的任意一层', target({ ancestorRole: 'menu' })],
  ])('%s 上按键，画布让路', (_name, el) => {
    expect(isEditable(el)).toBe(true)
  })

  it('画布上的普通元素不让路，否则快捷键整套失灵', () => {
    expect(isEditable(target())).toBe(false)
    expect(isEditable(null)).toBe(false)
  })
})
