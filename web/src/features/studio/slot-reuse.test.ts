/* 输出槽复用的守卫。
 *
   守的是「重跑不再堆节点」：级联每跑一次就往右建一整排新节点的话，
   跑三次画布上就是三排一模一样的东西，用户得一个个删。

   槽位靠 slot_of + slot_round 认领，这两个字段**必须持久化**——
   只放内存的话刷新之后又认不出来了。 */

import { describe, expect, it } from 'vitest'

import { findSlot } from './canvasStore'
import type { ScvNode } from './canvasStore'

const node = (id: string, over: Partial<ScvNode> = {}): ScvNode =>
  ({ id, type: 'image', x: 0, y: 0, ...over }) as ScvNode

describe('findSlot', () => {
  const nodes = [
    node('src'),
    node('a', { slot_of: 'src', slot_round: 1 }),
    node('b', { slot_of: 'src', slot_round: 2 }),
    node('c', { slot_of: 'other', slot_round: 1 }),
  ]

  it('按源节点与轮次认领', () => {
    expect(findSlot(nodes, 'src', 1)?.id).toBe('a')
    expect(findSlot(nodes, 'src', 2)?.id).toBe('b')
  })

  it('不同源节点的同轮次互不串门', () => {
    expect(findSlot(nodes, 'other', 1)?.id).toBe('c')
  })

  it('没跑过的轮次返回 undefined，由调用方新建', () => {
    expect(findSlot(nodes, 'src', 3)).toBeUndefined()
  })

  it('普通节点不会被误认成槽位', () => {
    expect(findSlot([node('plain')], 'plain', 1)).toBeUndefined()
  })

  it('轮次是数字不是字符串——存进 JSON 再读回来别变成 "1"', () => {
    const loose = [node('x', { slot_of: 'src', slot_round: '1' } as unknown as Partial<ScvNode>)]
    expect(findSlot(loose, 'src', 1)).toBeUndefined()
  })
})
