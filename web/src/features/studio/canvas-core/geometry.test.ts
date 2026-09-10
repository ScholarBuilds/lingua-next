/* 画布内核几何层的守卫测试。
 *
   这里锁的不是「代码没崩」，是**手感常数**：控制点的 0.45、最小 50/36、
   缩放的 exp(-dy*0.001)、采样步长 8px。这些数字改了不会报错，
   只会让线的弧度变僵、缩放变钝、快速划线切不断——正是最难靠肉眼回归的一类。 */

import { describe, expect, it } from 'vitest'

import {
  RESIZE_HANDLES,
  WIDTH_RESIZE_HANDLES,
  arrangeGrid,
  growRectAnchored,
  resizeCursor,
  resizeRectBy,
  connectionEndpoints,
  connectionMidpoint,
  connectionPath,
  fitRects,
  rectContains,
  rectFromPoints,
  rectsIntersect,
  safeScale,
  samplePointerPath,
  screenToWorld,
  viewportCenter,
  wheelZoomFactor,
  worldToScreen,
  zoomAtPoint,
} from './geometry'

const A = { x: 0, y: 0, width: 200, height: 100 }
const B = { x: 400, y: 300, width: 200, height: 100 }

describe('safeScale', () => {
  it('挡住 NaN / 0 / 负数，回落 1', () => {
    expect(safeScale(NaN)).toBe(1)
    expect(safeScale(0)).toBe(1)
    expect(safeScale(-2)).toBe(1)
    expect(safeScale('abc')).toBe(1)
  })

  it('不设上下限：极端值原样通过（上下限归交互层管）', () => {
    expect(safeScale(0.001)).toBe(0.001)
    expect(safeScale(500)).toBe(500)
  })
})

describe('视口变换', () => {
  const vp = { x: 100, y: 50, scale: 2 }
  const origin = { x: 10, y: 20 }

  it('screenToWorld 与 worldToScreen 互逆', () => {
    const world = screenToWorld(310, 270, origin, vp)
    expect(world).toEqual({ x: 100, y: 100 })
    const back = worldToScreen(world, vp)
    expect(back.x + origin.x).toBeCloseTo(310)
    expect(back.y + origin.y).toBeCloseTo(270)
  })

  it('viewportCenter 给出视口正中的世界坐标', () => {
    expect(viewportCenter(400, 200, vp)).toEqual({ x: 50, y: 25 })
  })
})

describe('滚轮缩放', () => {
  it('因子是 exp(-deltaY*0.001)，正反向严格互逆', () => {
    expect(wheelZoomFactor(-100)).toBeCloseTo(Math.exp(0.1), 10)
    expect(wheelZoomFactor(100) * wheelZoomFactor(-100)).toBeCloseTo(1, 12)
  })

  it('deltaY=0 不缩放', () => {
    expect(wheelZoomFactor(0)).toBe(1)
  })

  it('以光标为锚：锚点底下的世界坐标缩放前后不变', () => {
    const vp = { x: 30, y: 40, scale: 1 }
    const anchor = { x: 250, y: 180 }
    const beforeWorld = { x: (anchor.x - vp.x) / vp.scale, y: (anchor.y - vp.y) / vp.scale }
    const next = zoomAtPoint(vp, anchor, wheelZoomFactor(-120))
    const afterWorld = { x: (anchor.x - next.x) / next.scale, y: (anchor.y - next.y) / next.scale }
    expect(afterWorld.x).toBeCloseTo(beforeWorld.x, 10)
    expect(afterWorld.y).toBeCloseTo(beforeWorld.y, 10)
  })

  it('给了 bounds 就夹住，且夹住后锚点仍按夹后的 scale 算', () => {
    const vp = { x: 0, y: 0, scale: 1 }
    const next = zoomAtPoint(vp, { x: 100, y: 100 }, 100, { min: 0.5, max: 3 })
    expect(next.scale).toBe(3)
    expect((100 - next.x) / next.scale).toBeCloseTo(100, 10)
  })
})

describe('连线端点', () => {
  it('flow/input 走水平：源右边中点 → 目标左边中点', () => {
    expect(connectionEndpoints(A, B, 'flow')).toEqual({ fx: 200, fy: 50, tx: 400, ty: 350 })
    expect(connectionEndpoints(A, B, 'input')).toEqual(connectionEndpoints(A, B, 'flow'))
  })

  it('history 走垂直：源下边中点 → 目标上边中点', () => {
    expect(connectionEndpoints(A, B, 'history')).toEqual({ fx: 100, fy: 100, tx: 500, ty: 300 })
  })
})

describe('连线路径', () => {
  it('水平线的控制点偏移是两端水平距离的 45%', () => {
    // |tx-fx| = 200 → dx = 90
    expect(connectionPath(A, B, 'flow')).toBe('M200 50 C 290 50, 310 350, 400 350')
  })

  it('近距离兜最小 50，不退化成直棍', () => {
    const near = { x: 210, y: 0, width: 100, height: 100 }
    // |tx-fx| = 10 → 0.45*10=4.5，被 50 兜住
    expect(connectionPath(A, near, 'flow')).toBe('M200 50 C 250 50, 160 50, 210 50')
  })

  it('history 用竖直控制点，最小 36', () => {
    const below = { x: 0, y: 110, width: 200, height: 100 }
    // |ty-fy| = 10 → 4.5，被 36 兜住
    expect(connectionPath(A, below, 'history')).toBe('M100 100 C 100 136, 100 74, 100 110')
  })

  it('中点就是两端连线的中点，删除按钮挂这儿', () => {
    expect(connectionMidpoint(A, B, 'flow')).toEqual({ x: 300, y: 200 })
  })
})

describe('框选', () => {
  it('反向拖也得到规范矩形', () => {
    expect(rectFromPoints({ x: 100, y: 80 }, { x: 20, y: 10 })).toEqual({ x: 20, y: 10, width: 80, height: 70 })
  })

  it('相交就算选中，不要求完全包住', () => {
    expect(rectsIntersect(A, { x: 150, y: 50, width: 100, height: 100 })).toBe(true)
    expect(rectsIntersect(A, { x: 201, y: 0, width: 10, height: 10 })).toBe(false)
  })

  it('边缘相接不算相交', () => {
    expect(rectsIntersect(A, { x: 200, y: 0, width: 10, height: 10 })).toBe(false)
  })
})

describe('完整框住（框选按住 Alt 的判据）', () => {
  it('整个装进去才算，露出一角就不算', () => {
    const frame = { x: 0, y: 0, width: 300, height: 300 }
    expect(rectContains(frame, { x: 10, y: 10, width: 100, height: 100 })).toBe(true)
    expect(rectContains(frame, { x: 250, y: 10, width: 100, height: 100 })).toBe(false)
  })

  it('边界重合算装得下（差一像素就选不上会让人以为坏了）', () => {
    expect(rectContains({ x: 0, y: 0, width: 200, height: 100 }, A)).toBe(true)
  })

  it('与相交判定的差别正是 Alt 这一档的全部意义', () => {
    const frame = { x: 0, y: 0, width: 100, height: 100 }
    const half = { x: 50, y: 50, width: 100, height: 100 }
    expect(rectsIntersect(frame, half)).toBe(true)
    expect(rectContains(frame, half)).toBe(false)
  })
})

describe('切线采样', () => {
  it('按每 8px 一个点取样，短距离至少给 1 个', () => {
    expect(samplePointerPath({ x: 0, y: 0 }, { x: 0, y: 0 })).toHaveLength(1)
    expect(samplePointerPath({ x: 0, y: 0 }, { x: 80, y: 0 })).toHaveLength(10)
  })

  it('封顶 12 个点，快速甩动不会拖垮命中测试', () => {
    expect(samplePointerPath({ x: 0, y: 0 }, { x: 4000, y: 0 })).toHaveLength(12)
  })

  it('最后一个采样点落在终点上', () => {
    const pts = samplePointerPath({ x: 0, y: 0 }, { x: 40, y: 30 })
    expect(pts[pts.length - 1]).toEqual({ x: 40, y: 30 })
  })
})

describe('fitRects', () => {
  it('空集合回落到中心 scale=1', () => {
    expect(fitRects([], 800, 600)).toEqual({ x: 400, y: 300, scale: 1 })
  })

  it('装得下时不放大（maxScale 封顶 1）', () => {
    expect(fitRects([A], 4000, 4000, 0).scale).toBe(1)
  })

  it('装不下时缩小到刚好放进去', () => {
    const vp = fitRects([{ x: 0, y: 0, width: 2000, height: 1000 }], 800, 600, 0)
    expect(vp.scale).toBeCloseTo(0.4, 10)
  })

  /* 「放大到选区」传的是 maxScale=2。封顶留在 1 的话，选一个小节点按下去还停在
     100%，等于什么也没发生——而这个命令的字面意思就是要把它看清楚。 */
  it('maxScale 放开时会真的放大（缩放到选区靠的就是这个）', () => {
    const vp = fitRects([{ x: 0, y: 0, width: 100, height: 100 }], 800, 600, 0, 2)
    expect(vp.scale).toBe(2)
  })

  it('放大之后选区仍然居中', () => {
    const vp = fitRects([{ x: 100, y: 100, width: 100, height: 100 }], 800, 600, 0, 2)
    // 选区中心 (150,150) 经过视口变换后应落在容器中心 (400,300)
    expect(150 * vp.scale + vp.x).toBeCloseTo(400, 10)
    expect(150 * vp.scale + vp.y).toBeCloseTo(300, 10)
  })
})

describe('网格整理', () => {
  it('按列数换行，列宽取最大节点宽', () => {
    const out = arrangeGrid(
      [
        { id: 'a', width: 100, height: 60 },
        { id: 'b', width: 200, height: 60 },
        { id: 'c', width: 100, height: 60 },
      ],
      { x: 0, y: 0 },
      20,
      2,
    )
    expect(out[0]).toEqual({ id: 'a', x: 0, y: 0 })
    expect(out[1]).toEqual({ id: 'b', x: 220, y: 0 })
    // 第二行顶边 = 上一行最高 60 + 间隔 20
    expect(out[2]).toEqual({ id: 'c', x: 0, y: 80 })
  })

  it('不给列数时按开方取近似正方形', () => {
    const sizes = Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, width: 50, height: 50 }))
    const out = arrangeGrid(sizes, { x: 0, y: 0 }, 10)
    // 3 列：第 4 个应该换行
    expect(out[3].x).toBe(0)
    expect(out[3].y).toBe(60)
  })

  it('空输入不炸', () => {
    expect(arrangeGrid([], { x: 0, y: 0 })).toEqual([])
  })
})

describe('八向缩放', () => {
  /** 100,100 起、200×100 的框，四条边分别在 x=100/300、y=100/200 */
  const box = { x: 100, y: 100, width: 200, height: 100 }
  const loose = { w: 1, h: 1 }

  it('八个方位都在，`se` 与改造前的右下角一致', () => {
    expect([...RESIZE_HANDLES].sort()).toEqual(['e', 'n', 'ne', 'nw', 's', 'se', 'sw', 'w'])
    expect(RESIZE_HANDLES).toContain('se')
    // 只改宽度那一组不含任何带 n/s 的纯竖向手柄
    expect(WIDTH_RESIZE_HANDLES.every((h) => h.includes('e') || h.includes('w'))).toBe(true)
  })

  it('e：只有右边界动，x 和宽度以外的一切不变', () => {
    expect(resizeRectBy(box, 'e', 60, 999, loose)).toEqual({ x: 100, y: 100, width: 260, height: 100 })
  })

  it('s：只有下边界动', () => {
    expect(resizeRectBy(box, 's', 999, 40, loose)).toEqual({ x: 100, y: 100, width: 200, height: 140 })
  })

  /* 这一条是八向里最容易写错的地方：往左拖 w 是「左边界外移」，
     x 变小的同时宽度变大，右边界原地不动。写成整体平移的话
     宽度不变、整个节点跟着指针跑。 */
  it('w：往左拖时 x 跟着变小、宽度变大，右边界钉死', () => {
    const out = resizeRectBy(box, 'w', -60, 0, loose)
    expect(out).toEqual({ x: 40, y: 100, width: 260, height: 100 })
    expect(out.x + out.width).toBe(box.x + box.width)
  })

  it('w：往右拖是缩窄，右边界仍然钉死', () => {
    const out = resizeRectBy(box, 'w', 50, 0, loose)
    expect(out).toEqual({ x: 150, y: 100, width: 150, height: 100 })
    expect(out.x + out.width).toBe(300)
  })

  it('n：往上拖时 y 变小、高度变大，下边界钉死', () => {
    const out = resizeRectBy(box, 'n', 0, -30, loose)
    expect(out).toEqual({ x: 100, y: 70, width: 200, height: 130 })
    expect(out.y + out.height).toBe(box.y + box.height)
  })

  it('nw：两条边一起动，右下角原地不动', () => {
    const out = resizeRectBy(box, 'nw', -40, -20, loose)
    expect(out).toEqual({ x: 60, y: 80, width: 240, height: 120 })
    expect(out.x + out.width).toBe(300)
    expect(out.y + out.height).toBe(200)
  })

  it('ne：右边和上边动，左下角原地不动', () => {
    const out = resizeRectBy(box, 'ne', 40, -20, loose)
    expect(out).toEqual({ x: 100, y: 80, width: 240, height: 120 })
    expect(out.x).toBe(100)
    expect(out.y + out.height).toBe(200)
  })

  it('sw：左边和下边动，右上角原地不动', () => {
    const out = resizeRectBy(box, 'sw', -40, 20, loose)
    expect(out).toEqual({ x: 60, y: 100, width: 240, height: 120 })
    expect(out.x + out.width).toBe(300)
    expect(out.y).toBe(100)
  })

  it('se：等价于改造前那个右下角手柄——左上角不动', () => {
    const out = resizeRectBy(box, 'se', 40, 20, loose)
    expect(out).toEqual({ x: 100, y: 100, width: 240, height: 120 })
  })

  /* 顶到下限之后继续拖，钉住的必须还是那条静止的边。
     写错的表现很具体：宽度不再变，整个矩形却跟着指针横移。 */
  it('w 顶到下限：宽度停住，右边界仍然钉死，x 不再跟着指针跑', () => {
    const min = { w: 150, h: 1 }
    const a = resizeRectBy(box, 'w', 120, 0, min)
    const b = resizeRectBy(box, 'w', 400, 0, min)
    expect(a).toEqual({ x: 150, y: 100, width: 150, height: 100 })
    expect(b).toEqual(a)
    expect(b.x + b.width).toBe(300)
  })

  it('e 顶到下限：左边界钉死，右边界被推出去', () => {
    const out = resizeRectBy(box, 'e', -400, 0, { w: 150, h: 1 })
    expect(out).toEqual({ x: 100, y: 100, width: 150, height: 100 })
  })

  it('n 顶到下限：下边界钉死', () => {
    const out = resizeRectBy(box, 'n', 0, 400, { w: 1, h: 60 })
    expect(out).toEqual({ x: 100, y: 140, width: 200, height: 60 })
    expect(out.y + out.height).toBe(200)
  })

  it('s 顶到下限：上边界钉死', () => {
    const out = resizeRectBy(box, 's', 0, -400, { w: 1, h: 60 })
    expect(out).toEqual({ x: 100, y: 100, width: 200, height: 60 })
  })

  it('growRectAnchored 只放大不缩小：已经够大就原样返回', () => {
    expect(growRectAnchored(box, 'nw', { w: 50, h: 50 })).toEqual(box)
  })

  it('growRectAnchored 撑高时按手柄决定往哪边长', () => {
    // 拖上边：下边界钉死，往上长
    expect(growRectAnchored({ x: 0, y: 100, width: 10, height: 10 }, 'n', { w: 10, h: 40 })).toEqual({
      x: 0,
      y: 70,
      width: 10,
      height: 40,
    })
    // 拖下边：上边界钉死，往下长
    expect(growRectAnchored({ x: 0, y: 100, width: 10, height: 10 }, 's', { w: 10, h: 40 })).toEqual({
      x: 0,
      y: 100,
      width: 10,
      height: 40,
    })
  })

  it('指针形状与方位一一对应（CSS 与 JS 同一张表）', () => {
    expect(resizeCursor('n')).toBe('ns-resize')
    expect(resizeCursor('s')).toBe('ns-resize')
    expect(resizeCursor('e')).toBe('ew-resize')
    expect(resizeCursor('w')).toBe('ew-resize')
    expect(resizeCursor('ne')).toBe('nesw-resize')
    expect(resizeCursor('sw')).toBe('nesw-resize')
    expect(resizeCursor('nw')).toBe('nwse-resize')
    expect(resizeCursor('se')).toBe('nwse-resize')
  })
})
