/* 图片编辑器的判据守卫。
 *
   这里锁的四件事改了都**不报错**，只是行为悄悄变坏：
   - 扩图双向：少乘一个 2，用户拖一侧只扩一侧，与项目主人明确要的相反；
   - 蒙版极性：`destination-out` 写成 `source-over`，模型改的正好是没涂的地方，
     而上游照样 200、照样出图，只能靠肉眼发现；
   - 拼接落点：判据松了会抢到不相干的邻居，紧了则松手什么都不发生；
   - 切图边界：回绕与停住是两种手感，选了哪种就得钉住。 */

import { describe, expect, it } from 'vitest'

import {
  MAX_PAD_RATIO,
  NO_PAD,
  applyOutpaintDrag,
  buildJoinLayout,
  clampPad,
  emptyHistory,
  joinAutoDims,
  joinCanvasSize,
  joinCellSize,
  joinDropTarget,
  joinOutputScale,
  maskOps,
  matchEditorKey,
  padForRatio,
  padSize,
  recordHistory,
  redoHistory,
  shouldRecord,
  stepIndex,
  swapInOrder,
  undoHistory,
} from './canvas-editor-math'
import type { JoinSize, Pad } from './canvas-editor-math'

const NAT = { natW: 1000, natH: 800 }

describe('applyOutpaintDrag · 双向对称扩图', () => {
  it('往左拖左边框，左右同时各扩同样多', () => {
    const next = applyOutpaintDrag('w', -120, 0, NO_PAD, { ...NAT, symmetric: true })
    expect(next.left).toBe(120)
    expect(next.right).toBe(120)
    expect(next.top).toBe(0)
    expect(next.bottom).toBe(0)
    // 总宽按 grow*2 长（蓝本 resizeOutpaintFromDrag 的判据）
    expect(padSize(NAT.natW, NAT.natH, next).w).toBe(1000 + 120 * 2)
  })

  it('往上拖上边框，上下同时各扩同样多', () => {
    const next = applyOutpaintDrag('n', 0, -60, NO_PAD, { ...NAT, symmetric: true })
    expect(next.top).toBe(60)
    expect(next.bottom).toBe(60)
    expect(padSize(NAT.natW, NAT.natH, next).h).toBe(800 + 60 * 2)
  })

  it('角手柄两个轴一起走，四条边都动', () => {
    const next = applyOutpaintDrag('se', 40, 30, NO_PAD, { ...NAT, symmetric: true })
    expect(next).toEqual({ top: 30, bottom: 30, left: 40, right: 40 })
  })

  it('反方向拖是收回来，不会变成负数', () => {
    const base: Pad = { top: 50, right: 50, bottom: 50, left: 50 }
    const next = applyOutpaintDrag('w', 200, 0, base, { ...NAT, symmetric: true })
    expect(next.left).toBe(0)
    expect(next.right).toBe(0)
  })

  it('单边模式只动被拖的那条边', () => {
    const next = applyOutpaintDrag('w', -120, 0, NO_PAD, { ...NAT, symmetric: false })
    expect(next.left).toBe(120)
    expect(next.right).toBe(0)
  })

  it('单边模式下角手柄动两条边，不动对面', () => {
    const next = applyOutpaintDrag('ne', 40, -30, NO_PAD, { ...NAT, symmetric: false })
    expect(next).toEqual({ top: 30, right: 40, bottom: 0, left: 0 })
  })

  it('对称扩展只加不重排，已有的不对称留白原样留着', () => {
    /* 蓝本那版是「算出新宽再整体居中」，会把用户手调出来的偏心留白抹平。
       这里改成两侧各加同样多：总宽同样按 grow*2 长，偏心保留。 */
    const base: Pad = { top: 10, right: 200, bottom: 90, left: 0 }
    const next = applyOutpaintDrag('w', -100, 0, base, { natW: 1000, natH: 1000, symmetric: true })
    expect(next.top).toBe(10)
    expect(next.bottom).toBe(90)
    expect(next.left).toBe(100)
    expect(next.right).toBe(300)
    expect(padSize(1000, 1000, next).w).toBe(padSize(1000, 1000, base).w + 200)
  })

  it('单边最多扩到原图边长的 MAX_PAD_RATIO 倍', () => {
    const next = applyOutpaintDrag('w', -99999, 0, NO_PAD, { ...NAT, symmetric: true })
    expect(next.left).toBe(NAT.natW * MAX_PAD_RATIO)
    expect(next.right).toBe(NAT.natW * MAX_PAD_RATIO)
  })
})

describe('padForRatio · 一键外扩', () => {
  it('方图扩成 16:9 只加左右——横向不够就往横向补', () => {
    const pad = padForRatio(1000, 1000, 16, 9)
    expect(pad.left + pad.right).toBeGreaterThan(0)
    expect(pad.top).toBe(0)
    expect(pad.bottom).toBe(0)
    const size = padSize(1000, 1000, pad)
    expect(size.w / size.h).toBeCloseTo(16 / 9, 2)
    expect(size.h).toBe(1000)
  })

  it('已经比目标更宽时往上下补，不裁切', () => {
    const pad = padForRatio(1600, 400, 1, 1)
    expect(pad.left + pad.right).toBe(0)
    const size = padSize(1600, 400, pad)
    expect(size.w).toBe(1600)
    expect(size.h).toBe(1600)
  })
})

describe('clampPad', () => {
  it('负数夹回 0、超限夹回上限、结果取整', () => {
    const pad = clampPad({ top: -5, right: 1e9, bottom: 12.6, left: 0 }, 100, 100)
    expect(pad).toEqual({ top: 0, right: 200, bottom: 13, left: 0 })
  })
})

describe('maskOps · 蒙版极性', () => {
  it('第一步铺满不透明底：不涂就是全部保留', () => {
    expect(maskOps([])).toEqual([{ op: 'fill' }])
  })

  it('笔刷打洞（destination-out），橡皮补回（source-over）', () => {
    const ops = maskOps([
      { points: [0, 0, 10, 10], size: 8, erase: false },
      { points: [5, 5, 6, 6], size: 8, erase: true },
    ])
    expect(ops[0]).toEqual({ op: 'fill' })
    expect(ops[1]).toMatchObject({ composite: 'destination-out' })
    expect(ops[2]).toMatchObject({ composite: 'source-over' })
  })

  it('不足一个点的笔迹丢掉', () => {
    expect(maskOps([{ points: [3], size: 4, erase: false }])).toHaveLength(1)
  })

  it('笔宽最小 1，0 宽的线画不出来', () => {
    const ops = maskOps([{ points: [0, 0, 1, 1], size: 0, erase: false }])
    expect(ops[1]).toMatchObject({ width: 1 })
  })
})

describe('matchEditorKey · 快捷键分派', () => {
  it('mac 上 ⌘Z 撤销、⌘⇧Z 重做', () => {
    expect(matchEditorKey({ key: 'z', metaKey: true }, true)).toBe('undo')
    expect(matchEditorKey({ key: 'z', metaKey: true, shiftKey: true }, true)).toBe('redo')
  })

  it('windows 上认 Ctrl 而不是 Meta', () => {
    expect(matchEditorKey({ key: 'z', ctrlKey: true }, false)).toBe('undo')
    expect(matchEditorKey({ key: 'z', metaKey: true }, false)).toBeNull()
    expect(matchEditorKey({ key: 'y', ctrlKey: true }, false)).toBe('redo')
  })

  it('大写 Z（按住 Shift 时 key 就是大写）照样认', () => {
    expect(matchEditorKey({ key: 'Z', metaKey: true, shiftKey: true }, true)).toBe('redo')
  })

  it('方向键切上一张/下一张，左右与上下等价', () => {
    expect(matchEditorKey({ key: 'ArrowLeft' }, true)).toBe('prev')
    expect(matchEditorKey({ key: 'ArrowUp' }, true)).toBe('prev')
    expect(matchEditorKey({ key: 'ArrowRight' }, true)).toBe('next')
    expect(matchEditorKey({ key: 'ArrowDown' }, true)).toBe('next')
  })

  it('带修饰键的方向键不接管——那多半是别处的手势', () => {
    expect(matchEditorKey({ key: 'ArrowLeft', metaKey: true }, true)).toBeNull()
    expect(matchEditorKey({ key: 'ArrowRight', altKey: true }, true)).toBeNull()
  })

  it('别的键一律不认', () => {
    expect(matchEditorKey({ key: 'a' }, true)).toBeNull()
    expect(matchEditorKey({ key: 'Enter' }, true)).toBeNull()
  })
})

describe('stepIndex · 切图边界', () => {
  it('往后翻', () => {
    expect(stepIndex(0, 1, 5)).toBe(1)
  })

  it('到头停住，不回绕到另一端', () => {
    expect(stepIndex(4, 1, 5)).toBe(4)
    expect(stepIndex(0, -1, 5)).toBe(0)
  })

  it('空集合恒为 0', () => {
    expect(stepIndex(3, 1, 0)).toBe(0)
  })
})

/* ==================== 宫格拼接 ==================== */

function sizes(list: Array<[number, number, number]>): JoinSize[] {
  return list.map(([id, w, h]) => ({ id, w, h }))
}

describe('joinAutoDims · 默认行列', () => {
  it('四张排 2×2', () => {
    expect(joinAutoDims(4)).toEqual({ rows: 2, cols: 2 })
  })

  it('三张排 2 列 2 行（最后一行留白）', () => {
    expect(joinAutoDims(3)).toEqual({ rows: 2, cols: 2 })
  })

  it('九张排 3×3', () => {
    expect(joinAutoDims(9)).toEqual({ rows: 3, cols: 3 })
  })

  it('一张也给一个合法的 1×1', () => {
    expect(joinAutoDims(0)).toEqual({ rows: 1, cols: 1 })
  })
})

describe('joinCellSize · 格子尺寸', () => {
  it('取所有图里最大的宽与最大的高', () => {
    expect(joinCellSize(sizes([[1, 200, 100], [2, 120, 300]]), 1000)).toEqual({ w: 200, h: 300 })
  })

  it('长边超过上限时整体等比缩', () => {
    expect(joinCellSize(sizes([[1, 800, 400]]), 400)).toEqual({ w: 400, h: 200 })
  })
})

describe('buildJoinLayout · 排布', () => {
  const four = sizes([[1, 100, 100], [2, 100, 100], [3, 100, 100], [4, 100, 100]])

  it('按 order 从左到右、从上到下摆', () => {
    const layout = buildJoinLayout([1, 2, 3, 4], four, 2, 10, 100)
    expect(layout.items.map((it) => it.id)).toEqual([1, 2, 3, 4])
    expect(layout.items[0]).toMatchObject({ x: 0, y: 0, row: 1, col: 1 })
    expect(layout.items[1]).toMatchObject({ x: 110, y: 0, row: 1, col: 2 })
    expect(layout.items[2]).toMatchObject({ x: 0, y: 110, row: 2, col: 1 })
    expect(layout.items[3]).toMatchObject({ x: 110, y: 110, row: 2, col: 2 })
  })

  it('换了顺序，位置跟着换（拖拽换位靠这个）', () => {
    const layout = buildJoinLayout([4, 3, 2, 1], four, 2, 0, 100)
    expect(layout.items[0].id).toBe(4)
    expect(layout.items[0]).toMatchObject({ x: 0, y: 0 })
  })

  it('order 里有不存在的 id 就跳过，不留空格', () => {
    const layout = buildJoinLayout([1, 99, 2], four, 2, 0, 100)
    expect(layout.items.map((it) => it.id)).toEqual([1, 2])
  })

  it('列数不会超过张数', () => {
    const layout = buildJoinLayout([1, 2], four, 8, 0, 100)
    expect(layout.cols).toBe(2)
    expect(layout.rows).toBe(1)
  })

  it('间距为负当 0', () => {
    const layout = buildJoinLayout([1, 2], four, 2, -20, 100)
    expect(layout.gap).toBe(0)
    expect(layout.items[1].x).toBe(100)
  })
})

describe('joinCanvasSize', () => {
  it('两列两行、间距 10 的成品尺寸', () => {
    const layout = buildJoinLayout([1, 2, 3, 4], sizes([[1, 100, 100], [2, 100, 100], [3, 100, 100], [4, 100, 100]]), 2, 10, 100)
    expect(joinCanvasSize(layout)).toEqual({ w: 210, h: 210 })
  })

  it('最后一行没排满，高度仍按整行算', () => {
    const layout = buildJoinLayout([1, 2, 3], sizes([[1, 100, 100], [2, 100, 100], [3, 100, 100]]), 2, 0, 100)
    expect(joinCanvasSize(layout)).toEqual({ w: 200, h: 200 })
  })
})

describe('joinDropTarget · 拖拽落点', () => {
  const four = sizes([[1, 100, 100], [2, 100, 100], [3, 100, 100], [4, 100, 100]])
  const layout = buildJoinLayout([1, 2, 3, 4], four, 2, 10, 100)

  it('拖到右邻居头上，落点就是它', () => {
    expect(joinDropTarget(layout, 1, 110, 0)).toBe(2)
  })

  it('拖到下邻居头上', () => {
    expect(joinDropTarget(layout, 1, 0, 110)).toBe(3)
  })

  it('没挪几下就松手，落点为空（不该白白换位）', () => {
    expect(joinDropTarget(layout, 1, 4, 4)).toBeNull()
  })

  it('落在间隙里但离某格够近，仍然认它', () => {
    // 往右挪 78：中心 128 落在两格之间的缝上（第二格从 110 开始）
    expect(joinDropTarget(layout, 1, 78, 0)).toBe(2)
  })

  it('拖到画布外老远，谁都不认', () => {
    expect(joinDropTarget(layout, 1, 5000, 5000)).toBeNull()
  })

  it('id 不在布局里返回 null，不抛异常', () => {
    expect(joinDropTarget(layout, 999, 10, 10)).toBeNull()
  })
})

describe('swapInOrder', () => {
  it('交换两个位置', () => {
    expect(swapInOrder([1, 2, 3, 4], 1, 4)).toEqual([4, 2, 3, 1])
  })

  it('有一个不在里面就原样返回', () => {
    const order = [1, 2, 3]
    expect(swapInOrder(order, 1, 99)).toBe(order)
  })
})

describe('joinOutputScale · 导出倍数', () => {
  it('放大到目标长边', () => {
    expect(joinOutputScale({ w: 512, h: 256 }, 2048, 8192, 1e9)).toBeCloseTo(4, 5)
  })

  it('长边上限压过目标长边', () => {
    expect(joinOutputScale({ w: 1000, h: 500 }, 99999, 4096, 1e9)).toBeCloseTo(4.096, 3)
  })

  it('面积上限再压一次——iOS Safari 超了会整张返回空白且不报错', () => {
    const k = joinOutputScale({ w: 4000, h: 4000 }, 8000, 8192, 16_000_000)
    expect(4000 * k * (4000 * k)).toBeLessThanOrEqual(16_000_000 + 1)
  })
})

describe('撤销栈', () => {
  it('记一步之后能撤回去', () => {
    const h = recordHistory(emptyHistory<string>(), 'a', 40)
    const step = undoHistory(h, 'b', 40)
    expect(step?.value).toBe('a')
    expect(step?.history.past).toEqual([])
    expect(step?.history.future).toEqual(['b'])
  })

  it('撤完再重做，回到撤之前那一版', () => {
    const h = recordHistory(emptyHistory<string>(), 'a', 40)
    const back = undoHistory(h, 'b', 40)
    expect(back).not.toBeNull()
    const forward = redoHistory((back as { history: { past: string[]; future: string[] } }).history, 'a', 40)
    expect(forward?.value).toBe('b')
  })

  it('空栈撤不动，返回 null 而不是抛', () => {
    expect(undoHistory(emptyHistory<string>(), 'a', 40)).toBeNull()
    expect(redoHistory(emptyHistory<string>(), 'a', 40)).toBeNull()
  })

  it('撤到一半又改了新东西，redo 整条作废', () => {
    // 从历史中间分了叉，原来的「后面」就不存在了
    const h = { past: ['a'], future: ['c'] }
    expect(recordHistory(h, 'b', 40).future).toEqual([])
  })

  it('past 有上限，超了丢最老的那格', () => {
    let h = emptyHistory<number>()
    for (let i = 0; i < 10; i += 1) h = recordHistory(h, i, 3)
    expect(h.past).toEqual([7, 8, 9])
  })
})

describe('shouldRecord · 连续改动合成一步', () => {
  it('间隔够长算新的一步', () => {
    expect(shouldRecord(1000, 500, 400)).toBe(true)
  })

  it('拖拽过程中每帧都在改，同一步里不重复记', () => {
    expect(shouldRecord(1000, 900, 400)).toBe(false)
  })

  it('第一次改动（lastAt 还是 0）一定记', () => {
    expect(shouldRecord(16, 0, 400)).toBe(false)
    expect(shouldRecord(500, 0, 400)).toBe(true)
  })
})
