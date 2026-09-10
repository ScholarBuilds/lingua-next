/* 排布与连线规则的守卫测试。
 *
   锁三样东西：
   1. **自动排列的层深**——菱形结构里汇合点必须落在最右一列。蓝本按「先算到就定死」
      的走法会把它和自己的上游挤在同一列，线倒着往回画，肉眼一时看不出是布局的锅；
   2. **分组是原子**——组本体挪多少，成员就挪多少。少一步就是「组被拆了」；
   3. **端口矩阵与环检测**——这两条只在用户连线时生效，回归了不会报错，
      只会在某天变成一条连到分组里去的线，或者一条永远跑不完的级联。 */

import { describe, expect, it } from 'vitest'

import {
  ARRANGE_COL_GAP,
  ARRANGE_ROW_GAP,
  LOOP_INSERT_RADIUS,
  MEMBER_ROW_TOLERANCE,
  PLACE_GAP,
  flowMembers,
  readingOrder,
  widestMember,
  arrangeByConnections,
  atomicIds,
  bucketConnections,
  canConnect,
  connectedClusterIds,
  derivePortMatrix,
  freeSpotFor,
  freeSpotsFor,
  groupScopeMap,
  sanitizeConnections,
  wouldCreateCycle,
} from './layout'
import type { LayoutEdge, LayoutNode } from './layout'
import { nearestPointHit, rectCenter, rectContainsPoint, rectOverlapAt, rectsIntersect } from './geometry'
import type { Rect } from './geometry'
import { NODE_PORT_MATRIX } from '../nodes'

/* 连线判定一律拿注册表派生的真矩阵测：内核只认矩阵，而「有哪些节点、各自收发什么」
   的唯一出处是 nodes/*.definition.ts。拿手搓的假矩阵测，测的就不是线上那套规则了。 */
const M = NODE_PORT_MATRIX

function node(id: string, type: string, x: number, y: number, width = 200, height = 100, extra: Partial<LayoutNode> = {}): LayoutNode {
  return { id, type, rect: { x, y, width, height }, ...extra }
}

function placementOf(list: { id: string; x: number; y: number }[], id: string): { x: number; y: number } {
  const hit = list.find((p) => p.id === id)
  if (hit === undefined) throw new Error(`没有 ${id} 的落位`)
  return { x: hit.x, y: hit.y }
}

describe('分组作用域', () => {
  const nodes = [
    node('g', 'group', 0, 0, 300, 200, { memberIds: ['p1', 'p2'] }),
    node('p1', 'prompt', 10, 10),
    node('p2', 'prompt', 10, 120),
    node('img', 'image', 800, 0),
  ]

  it('成员指向分组本体，分组本体指向自己，组外节点不收录', () => {
    const scope = groupScopeMap(nodes)
    expect(scope.get('p1')).toBe('g')
    expect(scope.get('g')).toBe('g')
    expect(scope.get('img')).toBeUndefined()
  })

  it('atomicIds 把成员折叠成分组，重复只留一份', () => {
    expect(atomicIds(['p1', 'p2', 'img'], nodes).sort()).toEqual(['g', 'img'])
  })

  it('atomicIds 丢掉画布上不存在的 id', () => {
    expect(atomicIds(['p1', '不存在'], nodes)).toEqual(['g'])
  })
})

describe('连通簇', () => {
  const nodes = [node('a', 'image', 0, 0), node('b', 'image', 0, 0), node('c', 'image', 0, 0), node('d', 'image', 0, 0)]
  const edges: LayoutEdge[] = [
    { from: 'a', to: 'b', kind: 'input' },
    { from: 'c', to: 'b', kind: 'flow' },
  ]

  it('不分方向地走，把整条链都收进来', () => {
    expect(connectedClusterIds('a', nodes, edges).sort()).toEqual(['a', 'b', 'c'])
  })

  it('孤立节点只有自己；画布上没有的种子给空数组', () => {
    expect(connectedClusterIds('d', nodes, edges)).toEqual(['d'])
    expect(connectedClusterIds('x', nodes, edges)).toEqual([])
  })
})

describe('按连线深度分层排列', () => {
  it('一条链摆成三列，列距 = 列宽 + ARRANGE_COL_GAP', () => {
    const nodes = [node('a', 'image', 0, 0), node('b', 'image', 500, 400), node('c', 'image', 1000, 0)]
    const edges: LayoutEdge[] = [
      { from: 'a', to: 'b', kind: 'input' },
      { from: 'b', to: 'c', kind: 'input' },
    ]
    const out = arrangeByConnections(['a', 'b', 'c'], nodes, edges)
    expect(placementOf(out, 'a')).toEqual({ x: 0, y: 0 })
    expect(placementOf(out, 'b')).toEqual({ x: 200 + ARRANGE_COL_GAP, y: 0 })
    expect(placementOf(out, 'c')).toEqual({ x: (200 + ARRANGE_COL_GAP) * 2, y: 0 })
  })

  it('同一列里按原来的上下顺序排，行距 = 行高 + ARRANGE_ROW_GAP', () => {
    const nodes = [node('a', 'image', 0, 0), node('b', 'image', 10, 0), node('c', 'image', 20, 200)]
    const edges: LayoutEdge[] = [
      { from: 'a', to: 'b', kind: 'input' },
      { from: 'a', to: 'c', kind: 'input' },
    ]
    const out = arrangeByConnections(['a', 'b', 'c'], nodes, edges)
    expect(placementOf(out, 'b')).toEqual({ x: 380, y: 0 })
    // 行高不足 ARRANGE_MIN_ROW_H（110）时按 110 算
    expect(placementOf(out, 'c')).toEqual({ x: 380, y: 110 + ARRANGE_ROW_GAP })
  })

  it('菱形结构的汇合点落在最右一列，而不是跟自己的上游挤一起', () => {
    const nodes = [
      node('a', 'image', 0, 0),
      node('b', 'image', 10, 0),
      node('c', 'image', 20, 200),
      node('d', 'image', 30, 400),
    ]
    const edges: LayoutEdge[] = [
      { from: 'a', to: 'b', kind: 'input' },
      { from: 'a', to: 'c', kind: 'input' },
      { from: 'b', to: 'd', kind: 'input' },
      { from: 'c', to: 'd', kind: 'input' },
    ]
    const out = arrangeByConnections(['a', 'b', 'c', 'd'], nodes, edges)
    expect(placementOf(out, 'd').x).toBe(760)
    expect(placementOf(out, 'b').x).toBe(380)
  })

  it('分组是原子：成员跟着组本体走同样的位移', () => {
    const nodes = [
      node('g', 'group', 400, 300, 300, 200, { memberIds: ['m1'] }),
      node('m1', 'prompt', 420, 360, 100, 60),
      node('p', 'image', 600, 100),
    ]
    const edges: LayoutEdge[] = [{ from: 'g', to: 'p', kind: 'input' }]
    const out = arrangeByConnections(['m1', 'p'], nodes, edges)
    expect(placementOf(out, 'g')).toEqual({ x: 400, y: 100 })
    // 组本体 y 从 300 挪到 100，成员同样 -200
    expect(placementOf(out, 'm1')).toEqual({ x: 420, y: 160 })
    expect(placementOf(out, 'p')).toEqual({ x: 400 + 300 + ARRANGE_COL_GAP, y: 100 })
  })

  it('可排的原子少于两个时什么都不做', () => {
    const nodes = [node('g', 'group', 0, 0, 300, 200, { memberIds: ['m1'] }), node('m1', 'prompt', 10, 10)]
    expect(arrangeByConnections(['g', 'm1'], nodes, [])).toEqual([])
  })

  it('用户连出环也照样排完，不会卡在拓扑排序里', () => {
    const nodes = [node('a', 'image', 0, 0), node('b', 'image', 300, 0)]
    const edges: LayoutEdge[] = [
      { from: 'a', to: 'b', kind: 'input' },
      { from: 'b', to: 'a', kind: 'input' },
    ]
    const out = arrangeByConnections(['a', 'b'], nodes, edges)
    expect(out).toHaveLength(2)
  })
})

describe('端口矩阵', () => {
  const img = { id: 'i', type: 'image' }
  const prompt = { id: 'p', type: 'prompt' }
  const audio = { id: 'a', type: 'audio' }

  it('送得出的通道里有一条对方收得下就算合法', () => {
    expect(canConnect(prompt, img, 'input', M)).toBe(true)
    expect(canConnect(img, { id: 'i2', type: 'image' }, 'input', M)).toBe(true)
    expect(canConnect({ id: 'l', type: 'loop' }, img, 'input', M)).toBe(true)
  })

  it('只出不进的类型收不了东西：提示词只往外送文本，音频/文件是素材', () => {
    expect(canConnect(img, prompt, 'input', M)).toBe(false)
    expect(canConnect(prompt, { id: 'p2', type: 'prompt' }, 'input', M)).toBe(false)
    expect(canConnect(img, audio, 'input', M)).toBe(false)
  })

  it('通道对不上就连不了：音频进不了图片节点', () => {
    expect(canConnect(audio, img, 'input', M)).toBe(false)
    expect(canConnect(audio, { id: 'v', type: 'video' }, 'input', M)).toBe(true)
  })

  it('自环、未知类型、历史分组一律不合法', () => {
    expect(canConnect(img, img, 'input', M)).toBe(false)
    expect(canConnect(img, { id: 'x', type: '还没注册的类型' }, 'input', M)).toBe(false)
    expect(canConnect(img, { id: 'h', type: 'group', history: true }, 'input', M)).toBe(false)
  })

  it('history 边不过矩阵：归档指向的是一个历史分组，另一套语义', () => {
    expect(canConnect(img, { id: 'h', type: 'group' }, 'history', M)).toBe(true)
    expect(canConnect(img, img, 'history', M)).toBe(false)
  })

  it('生成器链上的机器边（flow）走同一张表', () => {
    expect(canConnect({ id: 'w', type: 'workflow' }, { id: 'o', type: 'output' }, 'flow', M)).toBe(true)
    expect(canConnect({ id: 'v', type: 'video' }, { id: 'v2', type: 'video' }, 'flow', M)).toBe(true)
    expect(canConnect(img, { id: 'o', type: 'output' }, 'flow', M)).toBe(true)
    expect(canConnect({ id: 'm', type: 'modelscope' }, { id: 'o', type: 'output' }, 'flow', M)).toBe(true)
  })

  it('derivePortMatrix 把注册表的 ports 直译成矩阵', () => {
    const derived = derivePortMatrix({ image: { ports: { in: ['image', 'text'], out: ['image'] } }, note: {} })
    expect(derived.image).toEqual({ emits: ['image'], accepts: ['image', 'text'] })
    expect(derived.note).toEqual({ emits: [], accepts: [] })
    /* 派生出来的矩阵要覆盖全部节点类型：漏一个，那个类型在画布上永远连不上线 */
    expect(Object.keys(NODE_PORT_MATRIX).sort()).toEqual([
      'audio',
      'file',
      'group',
      'image',
      'llm',
      'loop',
      'midjourney',
      'modelscope',
      'output',
      'prompt',
      'video',
      'workflow',
    ])
  })
})

describe('环检测', () => {
  const edges: LayoutEdge[] = [
    { from: 'a', to: 'b', kind: 'input' },
    { from: 'b', to: 'c', kind: 'flow' },
  ]

  it('下游能走回上游就是环', () => {
    expect(wouldCreateCycle('a', 'c', edges)).toBe(false)
    expect(wouldCreateCycle('c', 'a', edges)).toBe(true)
    expect(wouldCreateCycle('b', 'b', edges)).toBe(true)
  })

  it('归档边不算进可达性：重跑一次不该被当成环', () => {
    const withHistory: LayoutEdge[] = [...edges, { from: 'c', to: 'a', kind: 'history' }]
    expect(wouldCreateCycle('c', 'a', withHistory)).toBe(true)
    expect(wouldCreateCycle('a', 'c', withHistory)).toBe(false)
  })
})

describe('悬空边清理', () => {
  const nodes = [
    node('img', 'image', 0, 0),
    node('out', 'output', 400, 0),
    node('aud', 'audio', 800, 0),
    node('hist', 'group', 1200, 0, 300, 200, { history: true }),
  ]

  it('丢掉指向不存在节点的边、自环、重复边和矩阵不允许的边', () => {
    const edges: LayoutEdge[] = [
      { from: 'img', to: 'out', kind: 'flow' },
      { from: 'img', to: 'out', kind: 'flow' },
      { from: 'img', to: '已删除', kind: 'input' },
      { from: 'img', to: 'img', kind: 'input' },
      { from: 'img', to: 'aud', kind: 'input' },
      { from: 'img', to: 'hist', kind: 'history' },
    ]
    expect(sanitizeConnections(edges, nodes, M)).toEqual([
      { from: 'img', to: 'out', kind: 'flow' },
      { from: 'img', to: 'hist', kind: 'history' },
    ])
  })
})

describe('连线分桶合并', () => {
  const nodes = [
    node('g', 'group', 0, 0, 300, 200, { memberIds: ['m1', 'm2'] }),
    node('m1', 'image', 10, 10),
    node('m2', 'image', 10, 120),
    node('src', 'prompt', 800, 0),
  ]
  const scopeOf = (id: string): string => groupScopeMap(nodes).get(id) ?? ''

  it('同一来源连到同一分组的多个成员合成一条，下标全收进来', () => {
    const out = bucketConnections(
      [
        { index: 0, from: 'src', to: 'm1', kind: 'input' },
        { index: 1, from: 'src', to: 'm2', kind: 'input' },
      ],
      scopeOf,
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ from: 'src', to: 'g', merged: true, indices: [0, 1], targets: ['m1', 'm2'] })
  })

  it('组内部的边（成员↔成员、成员↔分组本体）隐藏', () => {
    const out = bucketConnections(
      [
        { index: 0, from: 'm1', to: 'm2', kind: 'input' },
        { index: 1, from: 'g', to: 'm1', kind: 'input' },
      ],
      scopeOf,
    )
    expect(out).toEqual([])
  })

  it('语义不同的边分开成桶，组外的边原样保留', () => {
    const out = bucketConnections(
      [
        { index: 0, from: 'src', to: 'm1', kind: 'input' },
        { index: 1, from: 'src', to: 'm1', kind: 'flow' },
        { index: 2, from: 'src', to: 'g', kind: 'input' },
      ],
      scopeOf,
    )
    expect(out.map((b) => [b.kind, b.merged, b.indices])).toEqual([
      ['input', true, [0]],
      ['flow', true, [1]],
      ['input', false, [2]],
    ])
  })

  it('history 边不参与合并也不被隐藏：归档关系要一条条看清楚', () => {
    const out = bucketConnections(
      [
        { index: 0, from: 'm1', to: 'm2', kind: 'history' },
        { index: 1, from: 'src', to: 'm1', kind: 'history' },
      ],
      scopeOf,
    )
    expect(out.map((b) => b.indices)).toEqual([[0], [1]])
    expect(out.every((b) => !b.merged)).toBe(true)
  })
})

describe('几何命中', () => {
  const box = { x: 100, y: 100, width: 200, height: 100 }

  it('中心与包含判定', () => {
    expect(rectCenter(box)).toEqual({ x: 200, y: 150 })
    expect(rectContainsPoint(box, { x: 100, y: 100 })).toBe(true)
    expect(rectContainsPoint(box, { x: 301, y: 150 })).toBe(false)
  })

  it('叠放取最上层：后画的盖在前面的上面', () => {
    const candidates = [
      { id: '底下的分组框', rect: { x: 0, y: 0, width: 500, height: 400 } },
      { id: '上面的成员', rect: box },
    ]
    expect(rectOverlapAt({ x: 200, y: 150 }, candidates)).toBe('上面的成员')
    expect(rectOverlapAt({ x: 20, y: 20 }, candidates)).toBe('底下的分组框')
    expect(rectOverlapAt({ x: 200, y: 150 }, candidates, new Set(['上面的成员']))).toBe('底下的分组框')
    expect(rectOverlapAt({ x: 900, y: 900 }, candidates)).toBeNull()
  })

  it('半径内取最近；同距离取先来的，预览不会在两条线之间来回跳', () => {
    const near = nearestPointHit({ x: 0, y: 0 }, [{ point: { x: 30, y: 0 } }, { point: { x: 10, y: 0 } }], 50)
    expect(near?.point).toEqual({ x: 10, y: 0 })
    expect(near?.distance).toBe(10)
    expect(nearestPointHit({ x: 0, y: 0 }, [{ point: { x: 60, y: 0 } }], 50)).toBeNull()
    const tie = nearestPointHit({ x: 0, y: 0 }, [{ id: 'a', point: { x: 10, y: 0 } }, { id: 'b', point: { x: 0, y: 10 } }], 50)
    expect(tie?.id).toBe('a')
    // 边界值算命中：96px 是「拖到线上」的判定半径本身
    expect(nearestPointHit({ x: 0, y: 0 }, [{ point: { x: LOOP_INSERT_RADIUS, y: 0 } }], LOOP_INSERT_RADIUS)).not.toBeNull()
  })
})

/* ==================== 新节点落点避让 ====================

   守的是「出图时新节点不会盖住已有节点」这一条。蓝本没有这层，
   它建产出节点一律 `rect.x + rect.width + 240`：同一个源节点连点两次出图，
   两个产出节点坐标完全相同，后一张把前一张整个盖死。 */

function rect(x: number, y: number, width = 200, height = 100): Rect {
  return { x, y, width, height }
}

/** 落点 + 尺寸 → 矩形，方便直接拿去判相交 */
function landed(spot: { x: number; y: number }, size: Rect): Rect {
  return { x: spot.x, y: spot.y, width: size.width, height: size.height }
}

describe('新节点落点避让', () => {
  it('空地上原样落下，不做任何多余位移', () => {
    expect(freeSpotFor(rect(500, 300), [])).toEqual({ x: 500, y: 300 })
    expect(freeSpotFor(rect(500, 300), [rect(2000, 2000)])).toEqual({ x: 500, y: 300 })
  })

  it('压在已有节点上时就近让开，并与它留出 PLACE_GAP 的空隙', () => {
    const there = rect(500, 300)
    const spot = freeSpotFor(rect(500, 300), [there])
    expect(rectsIntersect(landed(spot, there), there)).toBe(false)
    /* 200 宽 100 高：往下只要让开 100，往右要让开 200，取近的那边。
       重复出图时这条规则表现为「产出在源节点右边往下叠成一列」，正是想要的 */
    expect(spot).toEqual({ x: 500, y: there.y + there.height + PLACE_GAP })
  })

  it('四边等距时往右让，不往左也不往上', () => {
    const square = rect(0, 0, 120, 120)
    expect(freeSpotFor(rect(0, 0, 120, 120), [square])).toEqual({ x: 120 + PLACE_GAP, y: 0 })
  })

  it('同一处连落两个新节点，第二个会避开第一个', () => {
    const source = rect(0, 0, 300, 200)
    const want = rect(source.width + 80, 0, 200, 100)
    const spots = freeSpotsFor([want, want], [source])
    expect(spots[0]).toEqual({ x: want.x, y: want.y })
    const a = landed(spots[0], want)
    const b = landed(spots[1], want)
    expect(rectsIntersect(a, b)).toBe(false)
    expect(rectsIntersect(b, source)).toBe(false)
  })

  it('并发出的一批（8 个）两两不重叠，也不压到已有节点', () => {
    const existing = [rect(0, 0, 400, 300), rect(500, 0, 400, 300), rect(0, 400, 400, 300)]
    const want = Array.from({ length: 8 }, () => rect(120, 120, 240, 180))
    const spots = freeSpotsFor(want, existing)
    const boxes = spots.map((spot, i) => landed(spot, want[i]))
    for (const box of boxes) {
      for (const old of existing) expect(rectsIntersect(box, old)).toBe(false)
    }
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        expect(rectsIntersect(boxes[i], boxes[j])).toBe(false)
      }
    }
  })

  /* 「周围全满」是真实场景：一条链跑了几十轮之后源节点右边那片全是产出。
     算法必须永远给得出一个能用的落点，而不是退化成「就摆在原地压着」。 */
  it('周围一格空隙都没有时挪到这片区域外面，绝不叠着放', () => {
    const wall: Rect[] = []
    for (let row = 0; row < 6; row += 1) {
      for (let col = 0; col < 6; col += 1) wall.push(rect(col * 210, row * 110, 200, 100))
    }
    const want = rect(300, 200, 200, 100)
    const spot = freeSpotFor(want, wall)
    const got = landed(spot, want)
    for (const box of wall) expect(rectsIntersect(got, box)).toBe(false)
    // 出了这片密排区域：要么在它右边，要么在它下边，不会挤在缝里
    const right = Math.max(...wall.map((b) => b.x + b.width))
    const bottom = Math.max(...wall.map((b) => b.y + b.height))
    expect(spot.x >= right || spot.y >= bottom).toBe(true)
  })

  it('被一整块巨大区域盖住时照样有解，不会返回原地', () => {
    const huge = rect(-5000, -5000, 10000, 10000)
    const want = rect(0, 0, 300, 200)
    const spot = freeSpotFor(want, [huge])
    expect(rectsIntersect(landed(spot, want), huge)).toBe(false)
  })

  it('同一张画布上算两次落点结果一致，出图不会随机跳位置', () => {
    const obstacles = [rect(0, 0), rect(240, 0), rect(0, 140), rect(240, 140)]
    const first = freeSpotFor(rect(100, 50), obstacles)
    const second = freeSpotFor(rect(100, 50), obstacles)
    expect(first).toEqual(second)
  })
})

describe('分组成员的阅读顺序', () => {
  it('先行后列：上面那行整行读完再读下一行', () => {
    const out = readingOrder([
      { id: 'd', x: 200, y: 300 },
      { id: 'b', x: 200, y: 0 },
      { id: 'c', x: 0, y: 300 },
      { id: 'a', x: 0, y: 0 },
    ])
    expect(out.map((n) => n.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  /* 没有容差的话，两个肉眼并排、y 差几像素的成员会被判成上下两行，
     重排完顺序就和用户看到的对不上（蓝本 smart-canvas.js:1590 的 24）。 */
  it('容差内的纵向差异当作同一行，按 x 读', () => {
    const out = readingOrder([
      { id: 'right', x: 500, y: 0 },
      { id: 'left', x: 0, y: MEMBER_ROW_TOLERANCE - 1 },
    ])
    expect(out.map((n) => n.id)).toEqual(['left', 'right'])
  })

  it('超过容差就按行分：低的那个排后面，哪怕它更靠左', () => {
    const out = readingOrder([
      { id: 'low', x: 0, y: MEMBER_ROW_TOLERANCE + 1 },
      { id: 'high', x: 500, y: 0 },
    ])
    expect(out.map((n) => n.id)).toEqual(['high', 'low'])
  })
})

describe('分组成员按宽度流式排布', () => {
  const three = [
    { id: 'a', w: 100, h: 40 },
    { id: 'b', w: 100, h: 40 },
    { id: 'c', w: 100, h: 40 },
  ]

  it('宽度够就一行排完', () => {
    const out = flowMembers(three, 400, 20)
    expect(out.rows).toBe(1)
    expect(out.cells).toEqual([
      { id: 'a', dx: 0, dy: 0 },
      { id: 'b', dx: 120, dy: 0 },
      { id: 'c', dx: 240, dy: 0 },
    ])
    // 三个 100 加两个 20 的间隔
    expect(out.contentW).toBe(340)
    expect(out.contentH).toBe(40)
  })

  it('拉窄就折行，多出来的掉到下一行', () => {
    const out = flowMembers(three, 220, 20)
    expect(out.rows).toBe(2)
    expect(out.cells).toEqual([
      { id: 'a', dx: 0, dy: 0 },
      { id: 'b', dx: 120, dy: 0 },
      { id: 'c', dx: 0, dy: 60 },
    ])
    expect(out.contentW).toBe(220)
    expect(out.contentH).toBe(100)
  })

  it('再拉窄就一行一个', () => {
    expect(flowMembers(three, 110, 20).rows).toBe(3)
  })

  /* 「自适应填充」的本体：同一批成员，框拉宽了列数就变多，
     而每个成员的尺寸一个都不变。 */
  it('同一批成员，框越宽每行放得越多', () => {
    expect(flowMembers(three, 110, 20).rows).toBe(3)
    expect(flowMembers(three, 220, 20).rows).toBe(2)
    expect(flowMembers(three, 400, 20).rows).toBe(1)
  })

  it('比一行还宽的成员独占一行，不会排出空行', () => {
    const out = flowMembers(
      [
        { id: 'wide', w: 900, h: 40 },
        { id: 'small', w: 100, h: 40 },
      ],
      300,
      20,
    )
    expect(out.rows).toBe(2)
    expect(out.cells).toEqual([
      { id: 'wide', dx: 0, dy: 0 },
      { id: 'small', dx: 0, dy: 60 },
    ])
    expect(out.contentW).toBe(900)
  })

  it('行高取本行最高的那个，矮的在行内居中', () => {
    const out = flowMembers(
      [
        { id: 'tall', w: 100, h: 200 },
        { id: 'short', w: 100, h: 100 },
      ],
      400,
      20,
    )
    expect(out.rows).toBe(1)
    expect(out.cells).toEqual([
      { id: 'tall', dx: 0, dy: 0 },
      { id: 'short', dx: 120, dy: 50 },
    ])
    expect(out.contentH).toBe(200)
  })

  it('没有成员时给出空结果，调用方不用另写分支', () => {
    expect(flowMembers([], 400, 20)).toEqual({ cells: [], rows: 0, contentW: 0, contentH: 0 })
  })

  it('最小宽度由最宽的成员定，不是写死的数字', () => {
    expect(widestMember([{ w: 316 }, { w: 440 }, { w: 120 }])).toBe(440)
    expect(widestMember([])).toBe(0)
  })
})
