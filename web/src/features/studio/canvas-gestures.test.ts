/* 画布松手手势与连线入口校验的守卫测试。
 *
   这两件事都没有视觉反馈可以自证：插入判定差 10px、叠放判定用了相交而不是中心命中，
   现象都只是「有时候连上有时候连不上」；入口校验漏一条，画布上就多一根
   从空气连到空气的线，级联还会拿它去取图。 */

import { afterEach, describe, expect, it } from 'vitest'

import {
  autoConnectTargetFor,
  canAutoConnect,
  loopInsertionEdges,
  loopInsertionFor,
  LOOP_INSERT_RADIUS,
} from './canvas-core/layout'
import type { LayoutEdge, LayoutNode } from './canvas-core/layout'
import { useCanvasStore } from './canvasStore'
import { NODE_PORT_MATRIX } from './nodes'

function node(id: string, type: string, x: number, y: number, width = 200, height = 100, extra: Partial<LayoutNode> = {}): LayoutNode {
  return { id, type, rect: { x, y, width, height }, ...extra }
}

/* A 的右边中点 (200,50)、B 的左边中点 (400,50)，flow/input 边的中点就是 (300,50) */
const CHAIN: LayoutNode[] = [node('a', 'image', 0, 0), node('b', 'output', 400, 0)]
const CHAIN_EDGES: LayoutEdge[] = [{ from: 'a', to: 'b', kind: 'flow' }]

/** 让 loop 的中心正好落在 (cx, cy) */
function loopAt(cx: number, cy: number): { x: number; y: number; width: number; height: number } {
  return { x: cx - 60, y: cy - 30, width: 120, height: 60 }
}

describe('loop 拖到连线中点上插入', () => {
  const nodes = [...CHAIN, node('loop', 'loop', 0, 0, 120, 60)]

  it('中心落在判定半径内就命中，超出就不命中', () => {
    expect(loopInsertionFor('loop', loopAt(300, 50), CHAIN_EDGES, nodes)?.index).toBe(0)
    expect(loopInsertionFor('loop', loopAt(300 + LOOP_INSERT_RADIUS, 50), CHAIN_EDGES, nodes)?.index).toBe(0)
    expect(loopInsertionFor('loop', loopAt(300 + LOOP_INSERT_RADIUS + 1, 50), CHAIN_EDGES, nodes)).toBeNull()
  })

  it('多条线时取最近的一条', () => {
    const more = [...nodes, node('c', 'image', 0, 400), node('d', 'output', 400, 400)]
    const edges: LayoutEdge[] = [...CHAIN_EDGES, { from: 'c', to: 'd', kind: 'flow' }]
    expect(loopInsertionFor('loop', loopAt(300, 380), edges, more)?.index).toBe(1)
  })

  it('跳过与自己相接的边——插进自己已经在的链上没有意义', () => {
    const edges: LayoutEdge[] = [{ from: 'a', to: 'loop', kind: 'input' }]
    expect(loopInsertionFor('loop', loopAt(100, 50), edges, nodes)).toBeNull()
  })

  it('跳过归档边和挂在历史分组上的边', () => {
    const archived = [CHAIN[0], node('b', 'group', 400, 0, 200, 100, { history: true }), nodes[2]]
    expect(loopInsertionFor('loop', loopAt(300, 50), CHAIN_EDGES, archived)).toBeNull()
    expect(loopInsertionFor('loop', loopAt(300, 50), [{ from: 'a', to: 'b', kind: 'history' }], nodes)).toBeNull()
  })

  it('插入后：上游那半段沿用原语义，loop 到下游一律走 input', () => {
    expect(loopInsertionEdges({ from: 'a', to: 'b', kind: 'flow' }, 'loop')).toEqual([
      { from: 'a', to: 'loop', kind: 'flow' },
      { from: 'loop', to: 'b', kind: 'input' },
    ])
    expect(loopInsertionEdges({ from: 'a', to: 'b', kind: 'input' }, 'loop')).toEqual([
      { from: 'a', to: 'loop', kind: 'input' },
      { from: 'loop', to: 'b', kind: 'input' },
    ])
  })
})

describe('节点叠放自动连线', () => {
  it('图能叠到图 / 循环 / 提示词上，反过来提示词只能叠到出图的节点上', () => {
    const img = { id: 'i', type: 'image' }
    expect(canAutoConnect(img, { id: 'i2', type: 'image' })).toBe(true)
    expect(canAutoConnect(img, { id: 'l', type: 'loop' })).toBe(true)
    expect(canAutoConnect(img, { id: 'p', type: 'prompt' })).toBe(true)
    expect(canAutoConnect({ id: 'p', type: 'prompt' }, { id: 'p2', type: 'prompt' })).toBe(false)
    expect(canAutoConnect({ id: 'p', type: 'prompt' }, img)).toBe(true)
  })

  it('分组永远不是自动连线的目标：拖到框上的意思是放进去', () => {
    expect(canAutoConnect({ id: 'i', type: 'image' }, { id: 'g', type: 'group' })).toBe(false)
  })

  it('历史分组两端都不参与', () => {
    expect(canAutoConnect({ id: 'i', type: 'image' }, { id: 'h', type: 'group', history: true })).toBe(false)
    expect(canAutoConnect({ id: 'h', type: 'group', history: true }, { id: 'i', type: 'image' })).toBe(false)
  })

  it('按中心命中而不是矩形相交：擦到边角不算叠上去', () => {
    const nodes = [node('target', 'image', 300, 0)]
    const dragged = { id: 'src', type: 'image' }
    // 中心 (400,50) 落在 target 里
    expect(autoConnectTargetFor(dragged, { x: 300, y: 0, width: 200, height: 100 }, nodes, NODE_PORT_MATRIX)).toBe('target')
    // 只擦到左边一条缝，中心还在外面
    expect(autoConnectTargetFor(dragged, { x: 110, y: 0, width: 200, height: 100 }, nodes, NODE_PORT_MATRIX)).toBeNull()
  })

  it('一起被拖动的那批节点不算叠放目标', () => {
    const nodes = [node('mate', 'image', 300, 0), node('target', 'image', 300, 0)]
    const dragged = { id: 'src', type: 'image' }
    const rect = { x: 300, y: 0, width: 200, height: 100 }
    expect(autoConnectTargetFor(dragged, rect, nodes, NODE_PORT_MATRIX)).toBe('target')
    expect(autoConnectTargetFor(dragged, rect, nodes, NODE_PORT_MATRIX, new Set(['target']))).toBe('mate')
    expect(autoConnectTargetFor(dragged, rect, nodes, NODE_PORT_MATRIX, new Set(['target', 'mate']))).toBeNull()
  })

  it('意图规则点头、端口矩阵不点头的组合也连不上', () => {
    // 图 → 音频：意图上是「叠到素材上」，但音频节点没有输入端口
    expect(canAutoConnect({ id: 'i', type: 'image' }, { id: 'a', type: 'audio' })).toBe(true)
    expect(autoConnectTargetFor({ id: 'i', type: 'image' }, { x: 0, y: 0, width: 200, height: 100 }, [node('a', 'audio', 0, 0)], NODE_PORT_MATRIX)).toBeNull()
  })
})

describe('连线入口校验', () => {
  afterEach(() => useCanvasStore.getState().reset())

  function seed(): void {
    useCanvasStore.setState({
      canvasId: null,
      nodes: [
        { id: 'img', type: 'image', x: 0, y: 0, items: [] },
        { id: 'img2', type: 'image', x: 400, y: 0, items: [] },
        { id: 'out', type: 'output', x: 800, y: 0, items: [] },
        { id: 'group', type: 'group', x: 0, y: 400, items: [], member_ids: [] },
        { id: 'aud', type: 'audio', x: 800, y: 400, items: [] },
        { id: 'hist', type: 'group', x: 400, y: 400, items: [], member_ids: [], history_for: 'img' },
      ],
      connections: [],
      selectedNodeIds: [],
      selectedEdgeIds: [],
    })
  }

  it('合法的边照常入库', () => {
    seed()
    useCanvasStore.getState().addConnection({ from: 'img', to: 'out', kind: 'flow' })
    expect(useCanvasStore.getState().connections).toEqual([{ from: 'img', to: 'out', kind: 'flow' }])
  })

  it('端点不存在的边挡在门外', () => {
    seed()
    useCanvasStore.getState().addConnection({ from: 'img', to: '已删除', kind: 'input' })
    useCanvasStore.getState().addConnection({ from: '已删除', to: 'img', kind: 'input' })
    expect(useCanvasStore.getState().connections).toEqual([])
  })

  it('端口矩阵不允许的边挡在门外：音频节点没有输入端口', () => {
    seed()
    useCanvasStore.getState().addConnection({ from: 'img', to: 'aud', kind: 'input' })
    expect(useCanvasStore.getState().connections).toEqual([])
  })

  it('历史归档边放行，走的是另一套语义', () => {
    seed()
    useCanvasStore.getState().addConnection({ from: 'img', to: 'hist', kind: 'history' })
    expect(useCanvasStore.getState().connections).toHaveLength(1)
  })

  it('成环的边挡在门外，反向的同一对节点照样能连', () => {
    seed()
    const s = useCanvasStore.getState()
    s.addConnection({ from: 'img', to: 'img2', kind: 'input' })
    s.addConnection({ from: 'img2', to: 'out', kind: 'flow' })
    s.addConnection({ from: 'out', to: 'img', kind: 'input' })
    expect(useCanvasStore.getState().connections.map((c) => `${c.from}→${c.to}`)).toEqual(['img→img2', 'img2→out'])
  })

  it('自环与重复边照旧挡住', () => {
    seed()
    const s = useCanvasStore.getState()
    s.addConnection({ from: 'img', to: 'img', kind: 'input' })
    s.addConnection({ from: 'img', to: 'out', kind: 'flow' })
    s.addConnection({ from: 'img', to: 'out', kind: 'flow' })
    expect(useCanvasStore.getState().connections).toHaveLength(1)
  })
})
