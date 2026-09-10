/* 画布上的图按真实比例完整显示（模块 17 · D1）。
 *
   用户报「每一张图都该完整显示出来，不该点进弹窗才看得到全图」「生成的是什么
   比例，画布上就该是什么比例」。根因是单图节点在 item 缺 w/h 时把比例回落成
   1:1，多图网格更是把每一格钉死方块 + `object-fit: cover`——竖图先被压成方的
   再裁掉头尾。而建 item 的若干条路径（`{asset_id, kind:'image'}`）本来就不带尺寸。

   这里锁三件事：比例取值的四种情形、量到的比例只当比例用（不能当像素尺寸）、
   网格列数与 `mediaGridBox` 同源。 */

import { beforeEach, describe, expect, it } from 'vitest'

import { mediaGridBox } from './canvasStore'
import {
  UNKNOWN_ASPECT,
  aspectStyle,
  clearMeasuredAspects,
  gridCellAspect,
  gridColumns,
  itemAspect,
  rememberAspect,
} from './image-variants'
import type { CanvasItem } from '../../lib/api-studio'

const img = (asset_id: number, w?: number, h?: number): CanvasItem =>
  ({ kind: 'image', asset_id, w, h })

beforeEach(() => {
  clearMeasuredAspects()
})

describe('单图的显示比例', () => {
  it('竖图就是竖的', () => {
    expect(itemAspect(img(1, 1024, 1536))).toBeCloseTo(1024 / 1536)
  })

  it('横图就是横的', () => {
    expect(itemAspect(img(1, 1920, 1080))).toBeCloseTo(1920 / 1080)
  })

  it('方图是 1', () => {
    expect(itemAspect(img(1, 1024, 1024))).toBe(1)
  })

  it('缺尺寸时返回 undefined，而不是替调用方猜一个 1', () => {
    /* 「它是方的」和「还不知道」必须是两个值：前者可以定型，
       后者只是暂时占个位，图一落地就要换成真比例 */
    expect(itemAspect(img(1))).toBeUndefined()
    expect(itemAspect({ kind: 'image', asset_id: 1, w: 1024 })).toBeUndefined()
    expect(itemAspect({ kind: 'image', asset_id: 1, w: 0, h: 0 })).toBeUndefined()
    expect(itemAspect({ kind: 'image', asset_id: 1, w: Number.NaN, h: 100 })).toBeUndefined()
  })

  it('不知道比例时先摆成方的——猜横的正是这个 bug 的成因', () => {
    expect(aspectStyle(undefined)).toBe(String(UNKNOWN_ASPECT))
    expect(UNKNOWN_ASPECT).toBe(1)
    expect(aspectStyle(0.75)).toBe('0.75')
  })
})

describe('onLoad 量到的比例', () => {
  it('老画布里没存 w/h 的，量一次就能定型', () => {
    const it = img(7)
    expect(itemAspect(it)).toBeUndefined()
    expect(rememberAspect(it, 768, 1344)).toBe(true)
    expect(itemAspect(it)).toBeCloseTo(768 / 1344)
  })

  it('同一张图第二次量不再要求重渲染', () => {
    const it = img(7)
    expect(rememberAspect(it, 768, 1344)).toBe(true)
    expect(rememberAspect(it, 768, 1344)).toBe(false)
  })

  it('换了变体量到的舍入差不算新信息', () => {
    /* 缩远缩近会在 thumb 与 display 之间换 src，两档量到的比例只差舍入的
       那一点点。当成新信息的话，每越过一次远近阈值都要白重渲染一遍。 */
    const it = img(7)
    expect(rememberAspect(it, 768, 1349)).toBe(true)
    expect(rememberAspect(it, 192, 337)).toBe(false)
  })

  it('缓存跨节点共享：同一个资产在别的节点里不用再量', () => {
    rememberAspect(img(7), 900, 1600)
    expect(itemAspect(img(7))).toBeCloseTo(900 / 1600)
  })

  it('文档里已经有 w/h 的不覆盖——那才是原图的真实像素', () => {
    /* 挂在画布上的 <img> 带 srcset，naturalWidth 是**密度校正后的 CSS 尺寸**
       （768w 的图铺在 420px 的位置上读到 420），不是原图宽度 */
    const it = img(7, 2048, 1024)
    expect(rememberAspect(it, 420, 210)).toBe(false)
    expect(itemAspect(it)).toBe(2)
  })

  it('量到 0 或非有限值时当没量到，不写进缓存', () => {
    const it = img(7)
    expect(rememberAspect(it, 0, 0)).toBe(false)
    expect(rememberAspect(it, Number.NaN, 100)).toBe(false)
    expect(itemAspect(it)).toBeUndefined()
  })

  it('既没有资产号也没有 URL 的条目量了也没处存', () => {
    expect(rememberAspect({ kind: 'image' }, 800, 600)).toBe(false)
  })

  it('外部图按 URL 认', () => {
    const external: CanvasItem = { kind: 'image', url: 'https://x/y.png' }
    expect(rememberAspect(external, 1600, 900)).toBe(true)
    expect(itemAspect({ kind: 'image', url: 'https://x/y.png' })).toBeCloseTo(16 / 9)
    expect(itemAspect({ kind: 'image', url: 'https://x/other.png' })).toBeUndefined()
  })
})

describe('多图网格的列数', () => {
  it('一张图不成网格', () => {
    expect(gridColumns(1)).toBe(1)
    expect(gridColumns(0)).toBe(1)
  })

  it('张数越多列越多，封顶 4', () => {
    expect(gridColumns(2)).toBe(2)
    expect(gridColumns(4)).toBe(2)
    expect(gridColumns(5)).toBe(3)
    expect(gridColumns(9)).toBe(3)
    expect(gridColumns(10)).toBe(4)
    expect(gridColumns(25)).toBe(4)
  })

  it('与 mediaGridBox 同源：宽度算的是几列，就摆几列', () => {
    /* 节点宽度按 mediaGridBox 的列数给预算，这里少摆一列会被撑宽、
       多摆一列会挤扁。两处各写一份公式迟早分叉，用行为对账。 */
    const width = (n: number): number => mediaGridBox(n, 1024, 1024).w
    for (let a = 2; a <= 30; a += 1) {
      for (let b = 2; b <= 30; b += 1) {
        expect(width(a) === width(b)).toBe(gridColumns(a) === gridColumns(b))
      }
    }
  })
})

describe('多图网格里每一格的比例', () => {
  it('同一次出图的几张比例一致，格子就跟着竖起来', () => {
    const items = [img(1, 1024, 1536), img(2, 1024, 1536), img(3, 1024, 1536)]
    expect(gridCellAspect(items)).toBeCloseTo(1024 / 1536)
  })

  it('舍入带来的细微差别仍算同一个画幅', () => {
    expect(gridCellAspect([img(1, 1024, 1536), img(2, 1000, 1500)])).toBeCloseTo(1024 / 1536)
  })

  it('比例混排就回落方格，由 contain 保证每张仍然完整可见', () => {
    expect(gridCellAspect([img(1, 1024, 1536), img(2, 1920, 1080)])).toBe(UNKNOWN_ASPECT)
  })

  it('全都缺尺寸时回落方格，等 onLoad 量到再定型', () => {
    const items = [img(1), img(2)]
    expect(gridCellAspect(items)).toBe(UNKNOWN_ASPECT)
    rememberAspect(items[0], 900, 1600)
    rememberAspect(items[1], 900, 1600)
    expect(gridCellAspect(items)).toBeCloseTo(900 / 1600)
  })

  it('只有一张量得到时就按它摆，不因为另一张没量到而退回方格', () => {
    expect(gridCellAspect([img(1), img(2, 1536, 1024)])).toBeCloseTo(1.5)
  })

  it('空列表也给得出一个能画的比例', () => {
    expect(gridCellAspect([])).toBe(UNKNOWN_ASPECT)
  })
})
