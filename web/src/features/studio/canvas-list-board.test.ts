import { describe, expect, it } from 'vitest'

import {
  BOARD_CARD_WIDTH,
  BOARD_COLUMNS_MAX,
  BOARD_MAX_SCALE,
  BOARD_MIN_SCALE,
  boardColumns,
  fitBoardCanvases,
  layoutBoardCanvases,
  zoomBoardAt,
} from './canvas-list-board'

describe('画布列表无限桌面', () => {
  it('保留已定位卡片，并按 Infinite-Canvas 网格给旧画布补位', () => {
    const rows = layoutBoardCanvases([
      { id: 1, board_x: 720, board_y: -80 },
      { id: 2, board_x: null, board_y: null },
      { id: 3, board_x: null, board_y: null },
    ])

    expect(rows[0]).toMatchObject({ x: 720, y: -80, generated: false })
    expect(rows[1]).toMatchObject({ x: 316, y: 40, generated: true })
    expect(rows[2]).toMatchObject({ x: 592, y: 40, generated: true })
  })

  it('重置视图会把卡片集合放回视口中心，且不放大超过 1', () => {
    const viewport = fitBoardCanvases([{ x: 40, y: 40 }, { x: 316, y: 40 }], 1000, 600)
    expect(viewport.scale).toBe(1)
    expect(viewport.x).toBeGreaterThan(0)
    expect(viewport.y).toBeGreaterThan(0)
  })

  it('列数跟着桌面宽度回流，宽屏封顶 4 列', () => {
    // 桌面宽度（视口减去左侧导航条与项目栏）→ 期望列数
    expect(boardColumns(480)).toBe(1)   // 768 视口
    expect(boardColumns(736)).toBe(2)   // 1024 视口
    expect(boardColumns(812)).toBe(2)   // 1100 视口，实测崩在这一档
    expect(boardColumns(992)).toBe(3)   // 1280 视口
    expect(boardColumns(1224)).toBe(BOARD_COLUMNS_MAX) // 1512 视口
    expect(boardColumns(4000)).toBe(BOARD_COLUMNS_MAX)
    // 首帧量不到宽度时退回最大列数，量到之后 layout 会重算
    expect(boardColumns(0)).toBe(BOARD_COLUMNS_MAX)
    expect(boardColumns(Number.NaN)).toBe(BOARD_COLUMNS_MAX)
    expect(boardColumns()).toBe(BOARD_COLUMNS_MAX)
  })

  it('窄桌面补位的卡片右边缘不越过桌面宽度', () => {
    const rows = layoutBoardCanvases(
      Array.from({ length: 6 }, (_, i) => ({ id: i + 1, board_x: null, board_y: null })),
      812,
    )
    const right = Math.max(...rows.map((row) => row.x + BOARD_CARD_WIDTH))
    expect(right).toBeLessThanOrEqual(812)
    // 两列铺开，第三张换行
    expect(rows[2].x).toBe(rows[0].x)
    expect(rows[2].y).toBeGreaterThan(rows[0].y)
  })

  it('横向放不下时越过 0.9 的可读性下限，把卡片缩进视口', () => {
    // 旧库里按 4 列写死存下来的坐标，在 812 宽的桌面上原样铺开就是溢出
    const wide = [{ x: 40, y: 40 }, { x: 316, y: 40 }, { x: 592, y: 40 }, { x: 868, y: 40 }]
    const viewport = fitBoardCanvases(wide, 812, 600)
    expect(viewport.scale).toBeLessThan(0.9)
    expect(viewport.scale).toBeGreaterThanOrEqual(BOARD_MIN_SCALE)
    const right = viewport.x + (868 + BOARD_CARD_WIDTH) * viewport.scale
    expect(right).toBeLessThanOrEqual(812)
  })

  it('只有纵向堆不下时不额外缩小，仍停在 0.9', () => {
    const tall = Array.from({ length: 8 }, (_, i) => ({ x: 40, y: 40 + i * 216 }))
    expect(fitBoardCanvases(tall, 812, 600).scale).toBe(0.9)
  })

  it('滚轮缩放以指针为锚，并夹在 0.3 到 2', () => {
    const anchor = { x: 200, y: 150 }
    const current = { x: 20, y: 30, scale: 1 }
    const before = { x: (anchor.x - current.x) / current.scale, y: (anchor.y - current.y) / current.scale }
    const next = zoomBoardAt(current, anchor, true)
    expect((anchor.x - next.x) / next.scale).toBeCloseTo(before.x)
    expect((anchor.y - next.y) / next.scale).toBeCloseTo(before.y)

    expect(zoomBoardAt({ x: 0, y: 0, scale: BOARD_MAX_SCALE }, anchor, true).scale).toBe(BOARD_MAX_SCALE)
    expect(zoomBoardAt({ x: 0, y: 0, scale: BOARD_MIN_SCALE }, anchor, false).scale).toBe(BOARD_MIN_SCALE)
  })
})
