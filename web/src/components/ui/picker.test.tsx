/* 下拉里带分组标题的那条路径。
 *
   守的是一次真实事故：`SelectLabel` 被渲染在 `React.Fragment` 里而不是 `SelectGroup` 里，
   Radix 当场抛「`SelectLabel` must be used within `SelectGroup`」，被 RouterErrorBoundary
   一吞就是**整页白掉**——生图控制台就是这么挂的，而 tsc 与既有测试全绿。

   **为什么不渲染 HTML 来测**：Radix Select 的内容挂在 Portal 里、要客户端量位置才画，
   `renderToStaticMarkup` 无论开不开 `open` 都只吐一个隐藏的原生 select（实测 1585 字符、
   不含任何组名）。本仓 vitest 又跑在 node 环境没有 jsdom。所以改成直接遍历
   `Items` 返回的 React 元素树，验结构不变量：**每个 SelectLabel 头上必须有 SelectGroup**。
   这条判据与 Radix 抛错的判据是同一个，不需要 DOM。 */

import { isValidElement } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import { Items } from './picker'
import type { PickerOption } from './picker'
import { SelectGroup, SelectLabel } from './select'

const 带分组: PickerOption[] = [
  { value: 'a', label: '甲', group: '第一组' },
  { value: 'b', label: '乙', group: '第一组' },
  { value: 'c', label: '丙', group: '第二组' },
]

const 无分组: PickerOption[] = [
  { value: 'x', label: '子' },
  { value: 'y', label: '丑' },
]

/** 走一遍元素树，收集每个 SelectLabel 头上有没有 SelectGroup。 */
function labelsWithGroupFlag(root: ReactNode): boolean[] {
  const out: boolean[] = []
  const walk = (node: ReactNode, inGroup: boolean): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child, inGroup)
      return
    }
    if (!isValidElement(node)) return
    const el = node as ReactElement<{ children?: ReactNode }>
    if (el.type === SelectLabel) out.push(inGroup)
    const nextInGroup = inGroup || el.type === SelectGroup
    walk(el.props.children, nextInGroup)
  }
  walk(root, false)
  return out
}

describe('Picker 的分组渲染', () => {
  it('每个分组标题都在 SelectGroup 里', () => {
    const flags = labelsWithGroupFlag(Items({ options: 带分组 }))
    expect(flags).toHaveLength(2) // 第一组、第二组
    expect(flags.every(Boolean)).toBe(true)
  })

  it('没有分组名时不产出任何标题', () => {
    expect(labelsWithGroupFlag(Items({ options: 无分组 }))).toEqual([])
  })

  it('分组与不分组混在一起，标题仍然都在 SelectGroup 里', () => {
    const flags = labelsWithGroupFlag(Items({ options: [...无分组, ...带分组] }))
    expect(flags).toHaveLength(2)
    expect(flags.every(Boolean)).toBe(true)
  })

  /* 这条防的是「把标题整个删掉」式的假修复：结构对了，但选项也没了。 */
  it('两种分组的选项都还在', () => {
    const html = JSON.stringify(Items({ options: [...无分组, ...带分组] }))
    for (const v of ['x', 'y', 'a', 'b', 'c']) expect(html).toContain(`"${v}"`)
  })
})
