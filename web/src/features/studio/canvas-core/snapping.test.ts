/* 对齐吸附的守卫测试。
 *
   这一层坏了没有任何报错，只会表现为「拖动手感不对」：
   容差没按缩放换算 → 缩小时吸不上、放大时被硬拽；
   参考线取的是吸附**前**的位置 → 线画在旁边一点点，看着像画歪了；
   吸附结果不确定 → 同一帧算两次给两个答案，节点在两条候选线之间抖。
   这些都得靠数字锁住。 */

import { describe, expect, it } from 'vitest'

import { GUIDE_EPSILON, SNAP_TOLERANCE_PX, alignmentSnap, unionRect } from './snapping'
import type { Rect } from './geometry'

/** 邻居：左边 100、中线 200、右边 300；上边 100、中线 150、下边 200 */
const NEIGHBOR: Rect = { x: 100, y: 100, width: 200, height: 100 }

function moving(x: number, y: number, width = 200, height = 100): Rect {
  return { x, y, width, height }
}

describe('对齐吸附', () => {
  it('容差内的左边对左边被吸过去，容差外原地不动', () => {
    expect(alignmentSnap(moving(104, 400), [NEIGHBOR]).dx).toBe(-4)
    expect(alignmentSnap(moving(96, 400), [NEIGHBOR]).dx).toBe(4)
    expect(alignmentSnap(moving(107, 400), [NEIGHBOR]).dx).toBe(0)
  })

  it('容差按屏幕像素给：缩放 0.5 时世界坐标里的判定范围翻倍', () => {
    // 12 世界像素在 0.5 倍下只有 6 屏幕像素，够得着
    expect(alignmentSnap(moving(112, 400), [NEIGHBOR], { scale: 0.5 }).dx).toBe(-12)
    // 同样 12 世界像素在 2 倍下是 24 屏幕像素，够不着
    expect(alignmentSnap(moving(112, 400), [NEIGHBOR], { scale: 2 }).dx).toBe(0)
  })

  it('缩放取到 0 / NaN 时按 1 处理，不会把容差算成无穷大', () => {
    expect(alignmentSnap(moving(112, 400), [NEIGHBOR], { scale: 0 }).dx).toBe(0)
    expect(alignmentSnap(moving(112, 400), [NEIGHBOR], { scale: Number.NaN }).dx).toBe(0)
    expect(alignmentSnap(moving(104, 400), [NEIGHBOR], { scale: 0 }).dx).toBe(-4)
  })

  it('中线对中线也吸：宽度不同的两个节点能居中对齐', () => {
    // 窄节点中心在 203，邻居中线 200，差 3
    const snap = alignmentSnap(moving(103, 400, 200), [NEIGHBOR])
    expect(snap.dx).toBe(-3)
  })

  it('右边贴左边也算一档：三条线两两组合共九种候选', () => {
    // 被拖节点右边 = 102，邻居左边 = 100
    const snap = alignmentSnap(moving(-98, 400, 200), [NEIGHBOR])
    expect(snap.dx).toBe(-2)
  })

  it('两根轴各自独立结算', () => {
    const snap = alignmentSnap(moving(103, 97), [NEIGHBOR])
    expect(snap.dx).toBe(-3)
    expect(snap.dy).toBe(3)
  })

  it('多个候选取最近的那个', () => {
    const far: Rect = { x: 95, y: 400, width: 200, height: 100 }
    // 被拖节点左边 98：离 far(95) 差 3，离 NEIGHBOR(100) 差 2 → 取后者
    expect(alignmentSnap(moving(98, 800), [far, NEIGHBOR]).dx).toBe(2)
  })

  it('同一份输入永远给同一个答案（吸附必须是确定的）', () => {
    const others = [NEIGHBOR, { x: 100, y: 400, width: 200, height: 100 }]
    const a = alignmentSnap(moving(103, 800), others)
    const b = alignmentSnap(moving(103, 800), others)
    expect(a).toEqual(b)
  })

  it('没有邻居就没有吸附，也没有参考线', () => {
    expect(alignmentSnap(moving(103, 97), [])).toEqual({ dx: 0, dy: 0, guides: [] })
  })

  it('容差常数没被改小到吸不上', () => {
    expect(SNAP_TOLERANCE_PX).toBe(6)
  })
})

describe('参考线', () => {
  it('画在吸附**之后**的位置上，不是拖到的位置', () => {
    const snap = alignmentSnap(moving(104, 400), [NEIGHBOR])
    const vertical = snap.guides.filter((g) => g.axis === 'x')
    expect(vertical.map((g) => g.at)).toContain(100)
    // 104 这个「拖到的位置」不该出现在参考线里
    expect(vertical.map((g) => g.at)).not.toContain(104)
  })

  it('线段沿另一根轴覆盖两个矩形，看得出对齐的是谁', () => {
    const snap = alignmentSnap(moving(104, 400), [NEIGHBOR])
    const guide = snap.guides.find((g) => g.axis === 'x' && g.at === 100)
    expect(guide).toBeDefined()
    // 邻居 y ∈ [100,200]，被拖的 y ∈ [400,500]
    expect(guide?.start).toBe(100)
    expect(guide?.end).toBe(500)
  })

  it('同一个位置上有多个邻居时合并成一条长线，不叠出一条粗带子', () => {
    const others: Rect[] = [NEIGHBOR, { x: 100, y: 600, width: 200, height: 100 }]
    const snap = alignmentSnap(moving(104, 400), others)
    const at100 = snap.guides.filter((g) => g.axis === 'x' && g.at === 100)
    expect(at100).toHaveLength(1)
    expect(at100[0].start).toBe(100)
    expect(at100[0].end).toBe(700)
  })

  it('本来就对齐着（不需要位移）也要亮线', () => {
    const snap = alignmentSnap(moving(100, 400), [NEIGHBOR])
    expect(snap.dx).toBe(0)
    expect(snap.guides.some((g) => g.axis === 'x' && g.at === 100)).toBe(true)
  })

  it('一次拖动同时对上几条就画几条：左边、中线、右边都可能同时亮', () => {
    const snap = alignmentSnap(moving(100, 400), [NEIGHBOR])
    const xs = snap.guides.filter((g) => g.axis === 'x').map((g) => g.at)
    expect(xs).toEqual([100, 200, 300])
  })

  it('浮点误差不该把已经对齐的线判成没对齐', () => {
    const snap = alignmentSnap(moving(100 + GUIDE_EPSILON / 2, 400), [NEIGHBOR], { tolerancePx: 0.0001 })
    expect(snap.dx).toBe(0)
    expect(snap.guides.some((g) => g.axis === 'x' && g.at === 100)).toBe(true)
  })
})

describe('包围盒', () => {
  it('多选拖动按整体框算：包住全部矩形', () => {
    expect(unionRect([{ x: 10, y: 20, width: 30, height: 40 }, { x: 100, y: 0, width: 10, height: 10 }])).toEqual({
      x: 10,
      y: 0,
      width: 100,
      height: 60,
    })
  })

  it('空集合给 null，调用方据此跳过吸附而不是拿 NaN 去算坐标', () => {
    expect(unionRect([])).toBeNull()
  })
})
