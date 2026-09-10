/* 宫格切分的数学守卫。
 *
   这些数改了不报错，只是切出来的图对不上：gap 算错会让相邻两格重叠或多出黑边，
   切割线没归一化会切出零宽的格子，而零宽的 drawImage **不报错**，只画出一张空白图。 */

import { describe, expect, it } from 'vitest'

import { evenCuts, nextCut, normalizeCuts, splitCount, splitRects } from './image-math'

describe('evenCuts · 等分', () => {
  it('切两份给一条中线', () => {
    expect(evenCuts(2)).toEqual([0.5])
  })

  it('切三份给两条线', () => {
    expect(evenCuts(3)).toEqual([1 / 3, 2 / 3])
  })

  it('切一份没有线', () => {
    expect(evenCuts(1)).toEqual([])
  })

  it('0 与负数当成 1 份', () => {
    expect(evenCuts(0)).toEqual([])
    expect(evenCuts(-3)).toEqual([])
  })
})

describe('normalizeCuts · 归一化', () => {
  it('排序', () => {
    expect(normalizeCuts([0.8, 0.2, 0.5])).toEqual([0.2, 0.5, 0.8])
  })

  it('丢掉 0 与 1——那是外边，不是切割线', () => {
    expect(normalizeCuts([0, 0.5, 1])).toEqual([0.5])
  })

  it('丢掉越界与非数', () => {
    expect(normalizeCuts([-0.2, 1.5, Number.NaN, 0.4])).toEqual([0.4])
  })

  it('挨太近的两条只留一条——否则切出一条零宽的黑边', () => {
    expect(normalizeCuts([0.5, 0.502])).toEqual([0.5])
  })

  it('间距够就都留着', () => {
    expect(normalizeCuts([0.3, 0.7])).toEqual([0.3, 0.7])
  })
})

describe('splitRects · 无间隔时严丝合缝', () => {
  const cuts = { xs: evenCuts(2), ys: evenCuts(2) }

  it('2×2 切出 4 格', () => {
    expect(splitRects(100, 100, cuts)).toHaveLength(4)
  })

  it('四格拼起来正好是整张图，不重叠不留缝', () => {
    const rs = splitRects(100, 80, cuts)
    const area = rs.reduce((n, r) => n + r.w * r.h, 0)
    expect(area).toBe(100 * 80)
  })

  it('行列号从 1 开始，按阅读顺序', () => {
    const rs = splitRects(100, 100, cuts)
    expect(rs.map((r) => `${r.row}-${r.col}`)).toEqual(['1-1', '1-2', '2-1', '2-2'])
  })

  it('除不尽时不丢像素——余数摊到最后一格', () => {
    const rs = splitRects(101, 101, { xs: evenCuts(3), ys: evenCuts(1) })
    expect(rs.reduce((n, r) => n + r.w, 0)).toBe(101)
  })

  it('不切时就是整张图一格', () => {
    const rs = splitRects(100, 100, { xs: [], ys: [] })
    expect(rs).toEqual([{ x: 0, y: 0, w: 100, h: 100, row: 1, col: 1 }])
  })
})

describe('splitRects · 间隔 gap', () => {
  it('gap 从切割线两侧各扣一半，相邻两格之间正好空出 gap', () => {
    const rs = splitRects(100, 10, { xs: [0.5], ys: [] }, 10)
    expect(rs).toHaveLength(2)
    const [a, b] = rs
    expect(b.x - (a.x + a.w)).toBe(10)
  })

  it('**外边不扣**——四周不该凭空少一圈', () => {
    const rs = splitRects(100, 10, { xs: [0.5], ys: [] }, 10)
    expect(rs[0].x).toBe(0)
    expect(rs[1].x + rs[1].w).toBe(100)
  })

  it('gap 越大每格越窄，但总跨度不变', () => {
    const wide = splitRects(100, 10, { xs: [0.5], ys: [] }, 0)
    const narrow = splitRects(100, 10, { xs: [0.5], ys: [] }, 20)
    expect(narrow[0].w).toBeLessThan(wide[0].w)
    expect(narrow[1].x + narrow[1].w).toBe(100)
  })

  it('gap 把某一格挤没时**跳过**那一格，而不是给出负宽', () => {
    // 负宽的 drawImage 不报错，只画出一张空白图
    const rs = splitRects(20, 20, { xs: evenCuts(4), ys: [] }, 40)
    expect(rs.every((r) => r.w >= 1 && r.h >= 1)).toBe(true)
  })

  it('负的 gap 当 0 处理', () => {
    const rs = splitRects(100, 10, { xs: [0.5], ys: [] }, -30)
    expect(rs[1].x - (rs[0].x + rs[0].w)).toBe(0)
  })
})

describe('splitCount · 按钮上的数字', () => {
  it('与真实切出来的格数一致', () => {
    const cuts = { xs: evenCuts(3), ys: evenCuts(2) }
    expect(splitCount(cuts)).toBe(6)
    expect(splitRects(300, 200, cuts)).toHaveLength(6)
  })

  it('自定义线也算得对', () => {
    expect(splitCount({ xs: [0.2, 0.6], ys: [0.5] })).toBe(6)
  })

  it('不切是 1 张', () => {
    expect(splitCount({ xs: [], ys: [] })).toBe(1)
  })
})

describe('nextCut · 加一条线加在哪', () => {
  it('没有线时加在正中', () => {
    expect(nextCut([])).toBe(0.5)
  })

  it('已有中线时加在半边的中点，**不是又一条 0.5**', () => {
    // 固定加 0.5 会被去重丢掉，用户点了毫无反应（实测踩过）
    const got = nextCut([0.5])
    expect(got).not.toBe(0.5)
    expect([0.25, 0.75]).toContain(got)
  })

  it('连点几次会均匀铺开', () => {
    let cuts: number[] = []
    for (let i = 0; i < 3; i += 1) cuts = normalizeCuts([...cuts, nextCut(cuts)])
    expect(cuts).toHaveLength(3)
    // 三条线把整边分成四段，每段都不该小到贴在一起
    const edges = [0, ...cuts, 1]
    const spans = edges.slice(1).map((v, i) => v - edges[i])
    expect(Math.min(...spans)).toBeGreaterThan(0.1)
  })

  it('总是落在最大的那段空隙里', () => {
    // 左边 0~0.8 是最大空隙
    expect(nextCut([0.8, 0.9])).toBeCloseTo(0.4, 5)
  })
})
