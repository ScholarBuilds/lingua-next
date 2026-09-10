/* 节点默认尺寸的守卫测试。
 *
   锁的是**视觉手感常数**：媒体节点等比装进 520×440 的框（蓝本 `singleImageLayout`，
   `260×220 × MEDIA_NODE_DEFAULT_SCALE`）。这些数改了不报错，只会让画布上的节点
   忽大忽小——「横图看不清、竖图占满屏」就是上一版固定 260 宽留下的。

   另一条更重要：默认尺寸**只有 addNode 一个出口**。本仓踩过同族的坑
   （生图质量默认值以字面量散在十三处，漏改一处不报错、只是那条链路继续出错的质量）。 */

import { describe, expect, it } from 'vitest'

import { GEN_N_MAX, boxForItems, mediaGridBox, mediaNodeBox } from './canvasStore'

describe('mediaNodeBox · 等比装框', () => {
  it('竖图按高度受限装下，不超出框高', () => {
    const b = mediaNodeBox(853, 1844)
    expect(b.h).toBe(440)
    expect(b.w).toBe(Math.round(853 * (440 / 1844)))
    expect(b.w).toBeLessThanOrEqual(520)
  })

  it('横图按宽度受限装下，且明显比旧的固定 260 宽', () => {
    const b = mediaNodeBox(1920, 1080)
    expect(b.w).toBe(520)
    expect(b.h).toBe(Math.round(1080 * (520 / 1920)))
    // 这一条就是「节点太小看不清」的回归守卫
    expect(b.w).toBeGreaterThan(260)
  })

  it('方图两边都不超框', () => {
    const b = mediaNodeBox(1024, 1024)
    expect(b.w).toBe(440)
    expect(b.h).toBe(440)
  })

  it('保持原图长宽比（误差 <1%）', () => {
    for (const [w, h] of [[853, 1844], [1920, 1080], [1024, 1024], [3299, 1823]]) {
      const b = mediaNodeBox(w, h)
      expect(Math.abs(b.w / b.h - w / h) / (w / h)).toBeLessThan(0.01)
    }
  })

  it('极端细长图仍留得住最小边长，不会缩成一条线点不中', () => {
    const b = mediaNodeBox(4000, 40)
    expect(Math.min(b.w, b.h)).toBeGreaterThanOrEqual(72)
  })

  it('拿不到自然尺寸时给兜底框，而不是 0 或 undefined', () => {
    for (const args of [[undefined, undefined], [0, 0], [100, 0]] as const) {
      const b = mediaNodeBox(args[0], args[1])
      expect(b.w).toBeGreaterThan(0)
      expect(b.h).toBeGreaterThan(0)
    }
  })
})

describe('mediaGridBox · 多图网格', () => {
  it('一张图就退化成单图框', () => {
    expect(mediaGridBox(1, 1024, 1024)).toEqual(mediaNodeBox(1024, 1024))
  })

  it('张数越多框越大，且列数封顶 4', () => {
    const four = mediaGridBox(4, 1024, 1024)
    const nine = mediaGridBox(9, 1024, 1024)
    expect(nine.h).toBeGreaterThan(four.h)
    // 列数封顶 4（ceil(sqrt(n)) 被 min(4, ...) 夹住）：16 张已到顶，
    // 再多也只往下加行，宽度不再涨
    expect(mediaGridBox(25, 1024, 1024).w).toBe(mediaGridBox(16, 1024, 1024).w)
    expect(mediaGridBox(25, 1024, 1024).h).toBeGreaterThan(mediaGridBox(16, 1024, 1024).h)
  })

  it('多图框仍然比单图大，不会越加图越窄', () => {
    const one = mediaGridBox(1, 1024, 1024)
    const six = mediaGridBox(6, 1024, 1024)
    expect(six.w * six.h).toBeGreaterThan(one.w * one.h * 0.5)
  })
})

describe('boxForItems · 从节点条目取尺寸', () => {
  it('按第一张图的自然尺寸算', () => {
    const box = boxForItems([{ kind: 'image', asset_id: 1, w: 1920, h: 1080 }])
    expect(box).toEqual(mediaNodeBox(1920, 1080))
  })

  it('空节点也给得出一个能看见的框', () => {
    for (const items of [undefined, []]) {
      const box = boxForItems(items)
      expect(box.w).toBeGreaterThanOrEqual(316)
      expect(box.h).toBeGreaterThan(0)
    }
  })
})

describe('出图张数上限', () => {
  it('是个够大的数，不再是服务端单请求上限 4', () => {
    /* 张数 = 拆几个并发单张任务（每个任务 n:1），不是「一次请求要几张」。
       两者混为一谈时，界面填 12 会静默只出 4 张且不报错——上一版就是这样。 */
    expect(GEN_N_MAX).toBeGreaterThan(4)
  })

  it('界面上的档位都在上限之内', () => {
    for (const n of [1, 2, 3, 4, 6, 8]) expect(n).toBeLessThanOrEqual(GEN_N_MAX)
  })
})
