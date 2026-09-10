/* BulkBar「自动排列」接到 store 上的那一层。
 *
   排布算法本身在 canvas-core/layout.test.ts 里验过，这里只守 store 侧的三件事：
   真尺寸有没有喂进去（喂 0×0 会让所有节点叠在一起）、分组有没有当原子整体平移、
   以及互不相连的选区要原样不动——算法对这种输入会摊成一列，看着像"把画布搞乱了"。 */

import { afterEach, describe, expect, it } from 'vitest'

import { arrangeCluster, arrangeSelection, clusterOf, freeSpotForNode, useCanvasStore } from './canvasStore'
import type { ScvNode } from './canvasStore'

/** 固定 200×100，把尺寸这个变量摘掉，断言只看排布本身 */
const boxOf = (_n: ScvNode) => ({ w: 200, h: 100 })

function seed(nodes: ScvNode[], connections: { from: string; to: string; kind?: 'input' | 'flow' | 'history' }[]): void {
  useCanvasStore.setState({
    canvasId: null,
    nodes,
    connections,
    selectedNodeIds: [],
    selectedEdgeIds: [],
  })
}

function node(id: string, x: number, y: number, extra: Partial<ScvNode> = {}): ScvNode {
  return { id, type: 'image', x, y, items: [], ...extra } as ScvNode
}

function posOf(id: string): { x: number; y: number } {
  const n = useCanvasStore.getState().nodes.find((m) => m.id === id)
  return { x: n?.x ?? NaN, y: n?.y ?? NaN }
}

describe('自动排列（store 层）', () => {
  afterEach(() => useCanvasStore.getState().reset())

  it('有连线的链摊成从左到右：下游一定在上游右边', () => {
    seed(
      [node('a', 500, 300), node('b', 100, 700), node('c', 900, 50)],
      [
        { from: 'a', to: 'b', kind: 'flow' },
        { from: 'b', to: 'c', kind: 'flow' },
      ],
    )
    arrangeSelection(['a', 'b', 'c'], boxOf)
    expect(posOf('a').x).toBeLessThan(posOf('b').x)
    expect(posOf('b').x).toBeLessThan(posOf('c').x)
  })

  /* 互不相连的选区会被算法判成同一层，全摊进一列——看着就是"把画布搞乱了"。
     算法层不拦（它没有"该不该排"的信息），守卫在 BulkBar：选区内没有任一条
     两端都被选中的边时，「自动排列」按钮是禁用的。这条用例把该行为钉住，
     免得哪天有人以为算法自己会兜底而把 UI 守卫删掉。 */
  it('互不相连的选区会被摊成一列——所以 UI 必须先拦', () => {
    seed([node('a', 500, 300), node('b', 100, 700)], [])
    arrangeSelection(['a', 'b'], boxOf)
    expect(posOf('a').x).toBe(posOf('b').x)
  })

  it('分组与成员一起平移，成员不会被拆到别的列去', () => {
    seed(
      [
        node('g', 400, 0, { type: 'group', member_ids: ['m'] }),
        node('m', 420, 20),
        node('src', 0, 0),
      ],
      [{ from: 'src', to: 'g', kind: 'flow' }],
    )
    const before = { gx: posOf('g').x, gy: posOf('g').y, mx: posOf('m').x, my: posOf('m').y }
    arrangeSelection(['src', 'g'], boxOf)
    const after = { gx: posOf('g').x, gy: posOf('g').y, mx: posOf('m').x, my: posOf('m').y }
    // 分组动了多少，成员就跟着动多少——相对位置不变
    expect(after.mx - after.gx).toBe(before.mx - before.gx)
    expect(after.my - after.gy).toBe(before.my - before.gy)
  })

  it('单个节点不触发排布', () => {
    seed([node('a', 500, 300)], [])
    arrangeSelection(['a'], boxOf)
    expect(posOf('a')).toEqual({ x: 500, y: 300 })
  })
})

/* ==================== 一键整理（整条链路） ====================

   与上面的「自动排列」共用同一套排布算法，区别只在**排谁**：
   那边排的正好是选中的那几个，这边先沿连线把选区扩成整条链。 */

describe('一键整理（链路）', () => {
  afterEach(() => useCanvasStore.getState().reset())

  it('只选中链上一个节点，整条链都被排好，链外的节点一动不动', () => {
    seed(
      [node('a', 500, 300), node('b', 100, 700), node('c', 900, 50), node('outside', 2000, 2000)],
      [
        { from: 'a', to: 'b', kind: 'flow' },
        { from: 'b', to: 'c', kind: 'flow' },
      ],
    )
    expect(arrangeCluster(['a'], boxOf)).toBe(3)
    expect(posOf('a').x).toBeLessThan(posOf('b').x)
    expect(posOf('b').x).toBeLessThan(posOf('c').x)
    expect(posOf('outside')).toEqual({ x: 2000, y: 2000 })
  })

  it('孤立节点没有链路可整理，返回 0 且什么都不动', () => {
    seed([node('a', 500, 300)], [])
    expect(arrangeCluster(['a'], boxOf)).toBe(0)
    expect(posOf('a')).toEqual({ x: 500, y: 300 })
  })

  /* 归档边是「这张图之前长什么样」的记录关系。把它算进链路的话，
     整理一条跑过十几轮的链会顺手把十几个历史节点也摊到链上，画布反而更乱。 */
  it('历史归档不算链路的一部分', () => {
    seed(
      [node('a', 0, 0), node('b', 400, 0), node('h', 0, 900, { history_for: 'a' })],
      [
        { from: 'a', to: 'b', kind: 'flow' },
        { from: 'a', to: 'h', kind: 'history' },
      ],
    )
    expect([...clusterOf(['a'], boxOf)].sort()).toEqual(['a', 'b'])
    arrangeCluster(['a'], boxOf)
    expect(posOf('h')).toEqual({ x: 0, y: 900 })
  })

  it('选中链上多个节点也只整理这一条链，不会重复算', () => {
    seed(
      [node('a', 0, 0), node('b', 400, 0), node('c', 800, 0)],
      [
        { from: 'a', to: 'b', kind: 'flow' },
        { from: 'b', to: 'c', kind: 'flow' },
      ],
    )
    expect(arrangeCluster(['a', 'c'], boxOf)).toBe(3)
  })
})

/* ==================== 生成时的落点避让 ==================== */

describe('新节点落点（store 层）', () => {
  afterEach(() => useCanvasStore.getState().reset())

  it('想落的位置被占了就避开，落点与已有节点不相交', () => {
    seed([node('a', 0, 0, { w: 200 })], [])
    const spot = freeSpotForNode({ type: 'output', w: 200, items: [] }, { x: 0, y: 0 })
    // 已有节点是 200×280（空图片节点的兜底框），新节点不能压在它身上
    expect(spot.x >= 200 || spot.y >= 280).toBe(true)
  })

  it('空地上原样落下：没人挡着就不该无端挪动', () => {
    seed([node('a', 0, 0, { w: 200 })], [])
    expect(freeSpotForNode({ type: 'output', w: 200, items: [] }, { x: 900, y: 0 })).toEqual({
      x: 900,
      y: 0,
    })
  })

  it('忽略名单里的节点不算障碍：解散分组时组框自己不该把拆出的图推开', () => {
    seed([node('a', 0, 0, { w: 200 })], [])
    const spot = freeSpotForNode({ type: 'output', w: 200, items: [] }, { x: 0, y: 0 }, new Set(['a']))
    expect(spot).toEqual({ x: 0, y: 0 })
  })
})


/* ==================== 图落地时的节点宽度 ====================

   空建的图片节点宽度是 EMPTY_NODE_W(420)。不重算的话一张 9:16 的图撑成 420×747，
   比例是对的但节点过分高大，更容易压到邻居。判据必须是「宽度还等于空态默认」——
   用户拖过缩放手柄的宽度是他自己定的，重算会把他的调整冲掉。 */

import { EMPTY_NODE_W, boxForItems } from './canvasStore'

describe('图落地时的节点宽度', () => {
  const tall = [{ asset_id: 1, kind: 'image' as const, w: 1024, h: 1536 }]

  it('竖图落进空节点后，宽度收成有界框而不是留在 420', () => {
    const fitted = boxForItems(tall).w
    expect(fitted).toBeLessThan(EMPTY_NODE_W)
    expect(fitted).toBeGreaterThan(0)
  })

  it('横图与竖图收出来的宽度不同——说明确实按比例算而不是给了个常数', () => {
    const wide = [{ asset_id: 2, kind: 'image' as const, w: 1920, h: 1080 }]
    expect(boxForItems(wide).w).not.toBe(boxForItems(tall).w)
  })

  it('缺自然尺寸时仍给得出一个宽度，不会是 0 或 NaN', () => {
    const w = boxForItems([{ asset_id: 3, kind: 'image' as const }]).w
    expect(Number.isFinite(w)).toBe(true)
    expect(w).toBeGreaterThan(0)
  })
})
