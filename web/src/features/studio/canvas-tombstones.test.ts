/* 删除墓碑。这一族用例守的是同一件事：**删掉的东西不许自己回来**。
   现象很难自己发现——删完看着是没了，过一会儿或者刷新一下又在，
   用户会以为是自己没删干净。 */

import { afterEach, describe, expect, it } from 'vitest'

import {
  TOMBSTONE_TTL_MS,
  clearAll,
  clearSettled,
  createTombstones,
  forgetNodes,
  isEdgeBuried,
  isNodeBuried,
  rememberEdges,
  rememberNodes,
  sweepExpired,
} from './canvas-tombstones'

const T0 = 1_000_000

describe('墓碑的记与查', () => {
  it('记过的节点查得到，没记过的查不到', () => {
    const s = createTombstones()
    rememberNodes(s, ['a', 'b'], T0)
    expect(isNodeBuried(s, 'a', T0)).toBe(true)
    expect(isNodeBuried(s, 'b', T0)).toBe(true)
    expect(isNodeBuried(s, 'c', T0)).toBe(false)
  })

  it('连线按 key 单独记，与节点互不干扰', () => {
    const s = createTombstones()
    rememberEdges(s, ['a>b|flow'], T0)
    expect(isEdgeBuried(s, 'a>b|flow', T0)).toBe(true)
    expect(isNodeBuried(s, 'a>b|flow', T0)).toBe(false)
  })

  /* 删了 → ⌘Z 撤销回来 → 再删一次。不刷新时刻的话，第二次删除记的还是第一次的
     时间，TTL 会提前到期，那条删除就白删了。 */
  it('重复记同一个节点会刷新时刻', () => {
    const s = createTombstones()
    rememberNodes(s, ['a'], T0)
    rememberNodes(s, ['a'], T0 + TOMBSTONE_TTL_MS - 1)
    // 按第一次算的话此刻早就过期了；按最后一次算才还在
    expect(isNodeBuried(s, 'a', T0 + TOMBSTONE_TTL_MS + 1)).toBe(true)
  })
})

describe('撤销要让墓碑作废', () => {
  /* 撤销把节点带回来了，墓碑还留着的话下一次合并会再把它抹掉——
     用户会看到「撤销成功了，过一秒又没了」。 */
  it('forgetNodes 之后不再算被删', () => {
    const s = createTombstones()
    rememberNodes(s, ['a', 'b'], T0)
    forgetNodes(s, ['a'])
    expect(isNodeBuried(s, 'a', T0)).toBe(false)
    expect(isNodeBuried(s, 'b', T0)).toBe(true)
  })
})

describe('保存确认后按时间点清除', () => {
  /* 保存落库之后服务端已经同意这些节点没了，远端文档里不会再有它们，墓碑就没用了。
     用「保存取快照的时刻」而不是「收到响应的时刻」当界限。 */
  it('清掉这次载荷已经包含的，留下保存期间新删的', () => {
    const s = createTombstones()
    rememberNodes(s, ['早删的'], T0)
    const snapshotAt = T0 + 10
    rememberNodes(s, ['保存在飞时删的'], T0 + 20)
    clearSettled(s, snapshotAt)
    expect(isNodeBuried(s, '早删的', T0 + 30)).toBe(false)
    expect(isNodeBuried(s, '保存在飞时删的', T0 + 30)).toBe(true)
  })

  it('恰好等于快照时刻的算已提交', () => {
    const s = createTombstones()
    rememberNodes(s, ['a'], T0)
    clearSettled(s, T0)
    expect(isNodeBuried(s, 'a', T0)).toBe(false)
  })

  it('连线墓碑同样按时间点清', () => {
    const s = createTombstones()
    rememberEdges(s, ['旧'], T0)
    rememberEdges(s, ['新'], T0 + 20)
    clearSettled(s, T0 + 10)
    expect(isEdgeBuried(s, '旧', T0 + 30)).toBe(false)
    expect(isEdgeBuried(s, '新', T0 + 30)).toBe(true)
  })
})

describe('TTL 兜底', () => {
  /* TTL 只在保存一直失败（离线、鉴权过期）时起作用，防止墓碑无限攒着。
     正常路径靠保存确认来清，所以 TTL 可以定得比较宽松。 */
  it('超过 TTL 就不再算被删', () => {
    const s = createTombstones()
    rememberNodes(s, ['a'], T0)
    expect(isNodeBuried(s, 'a', T0 + TOMBSTONE_TTL_MS)).toBe(true)
    expect(isNodeBuried(s, 'a', T0 + TOMBSTONE_TTL_MS + 1)).toBe(false)
  })

  it('查到过期项时顺手删掉，不留垃圾', () => {
    const s = createTombstones()
    rememberNodes(s, ['a'], T0)
    isNodeBuried(s, 'a', T0 + TOMBSTONE_TTL_MS + 1)
    expect(s.nodes.has('a')).toBe(false)
  })

  it('sweepExpired 只清过期的并回报清了几条', () => {
    const s = createTombstones()
    rememberNodes(s, ['旧'], T0)
    rememberNodes(s, ['新'], T0 + TOMBSTONE_TTL_MS)
    rememberEdges(s, ['旧边'], T0)
    expect(sweepExpired(s, T0 + TOMBSTONE_TTL_MS + 1)).toBe(2)
    expect(s.nodes.has('新')).toBe(true)
    expect(s.edges.size).toBe(0)
  })
})

describe('换画布', () => {
  it('clearAll 之后什么都不剩', () => {
    const s = createTombstones()
    rememberNodes(s, ['a'], T0)
    rememberEdges(s, ['e'], T0)
    clearAll(s)
    expect(s.nodes.size).toBe(0)
    expect(s.edges.size).toBe(0)
  })
})

/* ==================== 接线：合并时真的挡住了吗 ====================

   上面那些用例只证明墓碑模块自己没写错。真正要守的是**它被接进合并路径**——
   把 `mergeDocs` 里那行判断删掉，上面 11 条照样全绿，而删掉的节点会当场复活。
   所以这一族从 store 外面驱动真实的 mergeDocs。 */

import { connKey, mergeDocs, useCanvasStore } from './canvasStore'
import type { ScvNode } from './canvasStore'

const node = (id: string): ScvNode => ({ id, type: 'image', x: 0, y: 0, items: [] }) as ScvNode

describe('合并时挡住复活（接线）', () => {
  afterEach(() => useCanvasStore.getState().reset())

  function 远端(nodes: ScvNode[], connections: { from: string; to: string; kind?: 'flow' }[] = []) {
    return { id: 1, version: 2, nodes, connections, viewport: null } as never
  }

  it('删掉的节点不会被远端带回来', () => {
    useCanvasStore.setState({ canvasId: 1, nodes: [node('a'), node('b')], connections: [] })
    useCanvasStore.getState().removeNodes(['b'])
    const merged = mergeDocs(
      { nodes: useCanvasStore.getState().nodes, connections: [] },
      远端([node('a'), node('b')]),
      new Set(),
    )
    expect(merged.nodes.map((n) => n.id)).toEqual(['a'])
  })

  /* 这条是上一条的对照：远端**新建**的节点必须留下，否则就成了「另一个标签页
     建的东西全丢」——那比复活更糟。 */
  it('远端新建的节点照常留下', () => {
    useCanvasStore.setState({ canvasId: 1, nodes: [node('a')], connections: [] })
    const merged = mergeDocs(
      { nodes: useCanvasStore.getState().nodes, connections: [] },
      远端([node('a'), node('新的')]),
      new Set(),
    )
    expect(merged.nodes.map((n) => n.id).sort()).toEqual(['a', '新的'])
  })

  it('删掉的连线不会被并集带回来', () => {
    useCanvasStore.setState({
      canvasId: 1,
      nodes: [node('a'), node('b')],
      connections: [{ from: 'a', to: 'b', kind: 'flow' }],
    })
    useCanvasStore.getState().removeConnectionsByKey([connKey({ from: 'a', to: 'b', kind: 'flow' })])
    const merged = mergeDocs(
      { nodes: useCanvasStore.getState().nodes, connections: [] },
      远端([node('a'), node('b')], [{ from: 'a', to: 'b', kind: 'flow' }]),
      new Set(),
    )
    expect(merged.connections).toEqual([])
  })

  it('撤销之后节点可以正常回来', () => {
    useCanvasStore.setState({ canvasId: 1, nodes: [node('a'), node('b')], connections: [] })
    useCanvasStore.getState().snapshot()
    useCanvasStore.getState().removeNodes(['b'])
    useCanvasStore.getState().undoOnce()
    const merged = mergeDocs(
      { nodes: useCanvasStore.getState().nodes, connections: [] },
      远端([node('a'), node('b')]),
      new Set(),
    )
    expect(merged.nodes.map((n) => n.id).sort()).toEqual(['a', 'b'])
  })
})

/* ==================== 跨标签页：旧副本在本地这一边 ====================

   实测复现过的链路：标签页 A 删掉 ntest0 → 服务端确实少了它、稳定 20 秒不反弹；
   标签页 B 是陈旧的（还握着 ntest0），在 B 里**只拖动另一个不相干的节点** →
   ntest0 立刻回到服务端。

   原来的墓碑只挡「远端有、本地没有」那一支，挡的是「我删了、远端还留着」。
   而另一个标签页删掉的节点，在 B 这里是「我有、远端没有」——走的是另一支，
   一路畅通地被写回去。 */

import { buriedSince } from './canvasStore'

describe('服务端删除记录切给本地', () => {
  it('只认「我读到画布之后」发生的删除', () => {
    // 我手里是 v5：v3 那次删除我早同步过了，v7 那次才是我不知道的
    expect(buriedSince({ old: 3, fresh: 7 }, 5)).toEqual(['fresh'])
  })

  /* 等于我手里版本的那次删除就是我自己刚做的。算进去的话，
     ⌘Z 撤销重建同一个节点会被自己的墓碑当场挡掉。 */
  it('等于我手里版本的不算', () => {
    expect(buriedSince({ mine: 5 }, 5)).toEqual([])
  })

  it('没有记录时返回空，不炸', () => {
    expect(buriedSince(undefined, 5)).toEqual([])
    expect(buriedSince({}, 5)).toEqual([])
  })

  /* 迁移前的老画布、脏值：静默跳过，一条坏记录不该把整次合并搞挂 */
  it('非数字的版本值跳过', () => {
    expect(buriedSince({ bad: null as unknown as number, ok: 9 }, 1)).toEqual(['ok'])
  })
})

describe('本地旧副本也要挡住（接线）', () => {
  afterEach(() => useCanvasStore.getState().reset())

  // 上一个 describe 里那个同名助手是块内局部的，这里自备一个
  const 远端文档 = (nodes: ScvNode[], connections: { from: string; to: string; kind?: 'flow' }[] = []) =>
    ({ id: 1, version: 2, nodes, connections, viewport: null }) as never

  /** 造出跨标签页那个状态：墓碑已记下，但节点**仍然留在本地文档里**。
      删一次记下墓碑，再把节点放回 nodes（不走 undoOnce，那会把墓碑一起撤销）。 */
  function 陈旧副本(id: string, others: string[]) {
    const all = [...others.map(node), node(id)]
    useCanvasStore.setState({ canvasId: 1, nodes: all, connections: [] })
    useCanvasStore.getState().removeNodes([id])
    useCanvasStore.setState({ nodes: all })
  }

  it('别人删掉的节点，即使还留在我本地，也不会被我写回去', () => {
    陈旧副本('别人删的', ['keep'])
    const merged = mergeDocs(
      { nodes: useCanvasStore.getState().nodes, connections: [] },
      远端文档([node('keep')]),
      new Set(),
    )
    expect(merged.nodes.map((n) => n.id)).toEqual(['keep'])
  })

  /* 对照：我自己新建的节点也是「我有、远端没有」，长得一模一样，
     但它没有墓碑——必须留下，否则另一个标签页建的东西全丢，比复活更糟。 */
  it('我自己新建的节点照常留下', () => {
    useCanvasStore.setState({ canvasId: 1, nodes: [node('keep'), node('我新建的')], connections: [] })
    const merged = mergeDocs(
      { nodes: useCanvasStore.getState().nodes, connections: [] },
      远端文档([node('keep')]),
      new Set(),
    )
    expect(merged.nodes.map((n) => n.id).sort()).toEqual(['keep', '我新建的'])
  })

  /* 正在生成的节点不能被挡：它的产物还没落到远端，挡掉就是把跑了一半的结果扔了 */
  it('在跑的节点不受影响', () => {
    陈旧副本('在跑的', ['keep'])
    const merged = mergeDocs(
      { nodes: useCanvasStore.getState().nodes, connections: [] },
      远端文档([node('keep')]),
      new Set(['在跑的']),
    )
    expect(merged.nodes.map((n) => n.id)).toContain('在跑的')
  })

  it('指向被挡节点的连线跟着消失，不留悬空边', () => {
    陈旧副本('别人删的', ['keep'])
    const merged = mergeDocs(
      {
        nodes: useCanvasStore.getState().nodes,
        connections: [{ from: 'keep', to: '别人删的', kind: 'flow' }],
      },
      远端文档([node('keep')]),
      new Set(),
    )
    expect(merged.nodes.map((n) => n.id)).toEqual(['keep'])
    expect(merged.connections).toEqual([])
  })
})
