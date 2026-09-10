/* 画布图片清晰度的守卫（模块 17 · FR-468）。
 *
   用户报「画布上的图都是模糊的，只有点击进去才看得清」。根因是 `src` 钉死
   `display` 变体，而 display 只有 768px 宽：Retina 屏上一个 637px 宽的节点
   需要 1274 物理像素，放大 1.66 倍就是肉眼可见的糊；把画布放大更糊。
   蓝本读本地原图，所以它任何缩放下都清楚。

   这两个函数是纯的，单独放一个文件测——不从 CanvasNodes 里导，
   那个模块会拉起整棵渲染依赖（本仓 vitest 跑在 node，没有 jsdom）。 */

import { describe, expect, it } from 'vitest'

import { itemSizes, itemSrcSet } from './image-variants'
import type { CanvasItem } from '../../lib/api-studio'

const img = (w: number, asset_id = 7): CanvasItem => ({ kind: 'image', asset_id, w, h: 1024 })

describe('srcset 三档', () => {
  it('列出 thumb / display / full，让浏览器按 DPR 自己挑', () => {
    const got = itemSrcSet(img(2048))
    expect(got).toContain('/api/images/assets/7/thumb 192w')
    expect(got).toContain('/api/images/assets/7/display 768w')
    expect(got).toContain('/api/images/assets/7/full 2048w')
  })

  it('原图不比 display 大时不列 full', () => {
    // 两条 URL 返回同一张图；列上去只会让浏览器在同宽的两档里挑那张未压缩 PNG
    expect(itemSrcSet(img(512))).not.toContain('/full')
    expect(itemSrcSet(img(768))).not.toContain('/full')
  })

  it('描述符是那个 URL 真正返回的宽度，不是我们希望它多宽', () => {
    /* 服务端 `_resize_webp` 在原图更窄时不放大、直接回原图。
       一张 420 宽的图 `/display` 拿到的就是 420；标成 768w 的话浏览器
       会以为它够铺 700px 的位置——还是糊，且比原来更难查 */
    const got = itemSrcSet(img(420))
    expect(got).toContain('/display 420w')
    expect(got).toContain('/thumb 192w')
  })

  it('比 thumb 还小的图，thumb 档也按真实宽度标', () => {
    expect(itemSrcSet(img(120))).toContain('/thumb 120w')
  })

  it('不知道原图多大时也不列 full——猜一个宽度会让浏览器挑错档', () => {
    expect(itemSrcSet({ kind: 'image', asset_id: 7 })).not.toContain('/full')
  })

  it('外部图没有变体，整个不给 srcset', () => {
    expect(itemSrcSet({ kind: 'image', url: 'https://x/y.png' })).toBeUndefined()
  })
})

describe('sizes 要把画布缩放乘进去', () => {
  it('放大时按放大后的尺寸挑图', () => {
    /* transform: scale() 不改变布局尺寸，浏览器算 srcset 时看不见它。
       不乘的话放大到 2× 仍按原尺寸挑图——越放大越糊，而那正是想看清的时候 */
    expect(itemSizes(500, 1)).toBe('500px')
    expect(itemSizes(500, 2)).toBe('1000px')
  })

  it('缩小时不降级', () => {
    // srcset 只升不降；这里再压一道，免得缩一下就去拉小图
    expect(itemSizes(500, 0.25)).toBe('500px')
  })
})
