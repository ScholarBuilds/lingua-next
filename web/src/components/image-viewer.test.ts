/* 看大图的纯逻辑。这几件事错了都不报错，只是手感不对——
   图拖出视野再也找不回来、放大总是从中心跑偏、翻到头突然跳回第一张。 */

import { describe, expect, it } from 'vitest'

import {
  clampPan,
  clampScale,
  fitSize,
  MAX_SCALE,
  MIN_SCALE,
  oneToOneScale,
  panBound,
  stepIndex,
  zoomAt,
} from './image-viewer'

describe('缩放钳制', () => {
  it('不许缩到比适应窗口还小', () => {
    expect(clampScale(0.2)).toBe(MIN_SCALE)
    expect(clampScale(-3)).toBe(MIN_SCALE)
  })

  it('有上限，不许无限放大', () => {
    expect(clampScale(999)).toBe(MAX_SCALE)
  })

  it('NaN 回到 1 而不是把图弄没', () => {
    expect(clampScale(Number.NaN)).toBe(MIN_SCALE)
  })
})

describe('平移边界', () => {
  /* 没放大时图正好铺满，可动范围是 0。不钉死的话轻轻一拖图就飘走，
     而用户不知道该往回拖多远才能找回来。 */
  it('没放大时完全不能拖', () => {
    expect(panBound(800, 800, 1)).toBe(0)
    const p = clampPan({ x: 300, y: -200 }, { w: 800, h: 600 }, { w: 800, h: 600 }, 1)
    expect(p).toEqual({ x: 0, y: 0 })
  })

  it('放大后能拖的范围是溢出的一半', () => {
    // 800 宽的图放大到 2 倍 = 1600，超出 800，两边各能拖 400
    expect(panBound(800, 800, 2)).toBe(400)
  })

  it('拖过头会被夹回边界', () => {
    // 往右下拖过头夹到 +400，往上拖过头夹到 -300（负方向的边界是负的）
    const p = clampPan({ x: 9999, y: -9999 }, { w: 800, h: 600 }, { w: 800, h: 600 }, 2)
    expect(p).toEqual({ x: 400, y: -300 })
  })

  it('内容比视口小时那个轴不能拖', () => {
    // 图只有 400 宽、视口 800，放大 1.5 倍还是 600 < 800
    expect(panBound(800, 400, 1.5)).toBe(0)
  })
})

describe('以光标为锚缩放', () => {
  /* 直接改 scale 不动 pan 的话画面是从中心放大的：用户想看右上角那块，
     放大后它跑出视野还得再拖回来。 */
  it('光标在正中时等于从中心放大，pan 不变', () => {
    const box = { w: 800, h: 600 }
    expect(zoomAt({ x: 0, y: 0 }, 1, 2, { x: 400, y: 300 }, box)).toEqual({ x: 0, y: 0 })
  })

  it('光标偏右时画面朝左移，把右边那块带进视野', () => {
    const box = { w: 800, h: 600 }
    const next = zoomAt({ x: 0, y: 0 }, 1, 2, { x: 700, y: 300 }, box)
    expect(next.x).toBeLessThan(0)
  })

  /* 放大再按同样的锚点缩回去，应该回到原处——不然反复滚轮会把画面越搓越偏。 */
  it('同一锚点放大再缩回，回到原位', () => {
    const box = { w: 800, h: 600 }
    const cursor = { x: 620, y: 180 }
    const up = zoomAt({ x: 0, y: 0 }, 1, 2.5, cursor, box)
    const back = zoomAt(up, 2.5, 1, cursor, box)
    expect(back.x).toBeCloseTo(0, 6)
    expect(back.y).toBeCloseTo(0, 6)
  })
})

describe('适应窗口', () => {
  it('横图按宽度贴合，完整显示不裁切', () => {
    const fit = fitSize({ w: 1536, h: 1024 }, { w: 768, h: 768 })
    expect(fit).toEqual({ w: 768, h: 512 })
    expect(fit.w / fit.h).toBeCloseTo(1536 / 1024, 6)
  })

  it('竖图按高度贴合', () => {
    const fit = fitSize({ w: 1024, h: 1536 }, { w: 768, h: 768 })
    expect(fit).toEqual({ w: 512, h: 768 })
  })

  /* 小图不放大：192×128 的缩略图铺满 1600px 只会糊成一片，
     不如按原始大小摆在中间。 */
  it('比视口小的图保持原始大小，不硬撑', () => {
    expect(fitSize({ w: 192, h: 128 }, { w: 1600, h: 900 })).toEqual({ w: 192, h: 128 })
  })

  it('尺寸缺失时返回 0，不产出 NaN 尺寸', () => {
    expect(fitSize({ w: 0, h: 0 }, { w: 800, h: 600 })).toEqual({ w: 0, h: 0 })
  })
})

describe('1:1', () => {
  it('把缩到一半的大图还原成原始像素', () => {
    // 1536 宽的图在 768 视口里 fit 成 768，1:1 就是 2 倍
    expect(oneToOneScale({ w: 1536, h: 1024 }, { w: 768, h: 768 })).toBeCloseTo(2, 6)
  })

  it('本来就没缩小的小图，1:1 等于不缩放', () => {
    expect(oneToOneScale({ w: 192, h: 128 }, { w: 1600, h: 900 })).toBe(1)
  })
})

describe('翻页', () => {
  it('正常前后翻', () => {
    expect(stepIndex(3, 10, 1)).toBe(4)
    expect(stepIndex(3, 10, -1)).toBe(2)
  })

  /* 到头停住不环绕：一百二十张图里从第一张跳到最后一张，
     用户只会以为自己点错了。 */
  it('到头返回 null，不环绕', () => {
    expect(stepIndex(0, 10, -1)).toBeNull()
    expect(stepIndex(9, 10, 1)).toBeNull()
  })

  it('空集不炸', () => {
    expect(stepIndex(0, 0, 1)).toBeNull()
  })
})
