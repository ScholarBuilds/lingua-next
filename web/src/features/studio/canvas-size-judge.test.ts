/* 「这个节点在画布上多大」的唯一判据（门禁接线：D1 定型 ↔ D2 排版）。

   D1 让图按真实比例定型（`mediaNodeBox`，最高 520×440），排版这边却还留着
   `h: 200` 这类写死的数——两边单看都对，排完节点照样叠在一起。这里锁三条：
   兜底高度跟着真实比例走、实测值优先、分组整理用的是同一个判据。 */

import { afterEach, describe, expect, it } from 'vitest'

import { registerCanvas, resetCanvasRegistry } from './canvas-core'
import {
  arrangeGroupMembers,
  fallbackBox,
  groupToolbarActions,
  imageAssetIds,
  nodeBox,
  useCanvasStore,
} from './canvasStore'
import type { CanvasItem } from '../../lib/api-studio'
import type { ScvNode } from './canvasStore'

afterEach(() => {
  resetCanvasRegistry()
  useCanvasStore.getState().reset()
})

const imageNode = (id: string, w: number, h: number, extra: Partial<ScvNode> = {}): ScvNode =>
  ({ id, type: 'image', x: 0, y: 0, items: [{ kind: 'image', asset_id: 1, w, h }], ...extra }) as ScvNode

describe('兜底尺寸跟着真实比例走', () => {
  it('竖图节点的兜底高度大于宽度', () => {
    const box = fallbackBox(imageNode('a', 1024, 1536))
    expect(box.h).toBeGreaterThan(box.w)
    // 写死的 200 会让竖图节点只占实际高度的四成
    expect(box.h).toBeGreaterThan(200)
  })

  it('横图节点的兜底宽度大于高度', () => {
    const box = fallbackBox(imageNode('a', 1920, 1080))
    expect(box.w).toBeGreaterThan(box.h)
  })

  it('用户拖过缩放手柄的节点仍然照它存的宽度算', () => {
    expect(fallbackBox(imageNode('a', 1024, 1536, { w: 700 })).w).toBe(700)
  })
})

describe('实测值优先', () => {
  it('量过的节点用实测值，没量过的用兜底', () => {
    const node = imageNode('a', 1024, 1536)
    const fallback = fallbackBox(node)
    registerCanvas({ boxes: new Map([['a', { w: 333, h: 444 }]]) })
    expect(nodeBox(node)).toEqual({ w: 333, h: 444 })
    expect(nodeBox(imageNode('b', 1024, 1536))).toEqual(fallback)
  })

  it('量到 0 不算量到——面板 hidden 时几何量全是 0', () => {
    const node = imageNode('a', 1024, 1536)
    registerCanvas({ boxes: new Map([['a', { w: 0, h: 0 }]]) })
    expect(nodeBox(node)).toEqual(fallbackBox(node))
  })
})

describe('分组整理用同一个判据', () => {
  /** 两个成员时 `cols = round(√2) = 1`，所以它们是上下排的：
   *  第二个的顶边必须落在第一个的底边之下，否则整理完还是叠着。 */
  function stackedGap(): number {
    arrangeGroupMembers('g')
    const nodes = useCanvasStore.getState().nodes
    const first = nodes.find((n) => n.id === 'm1')
    const second = nodes.find((n) => n.id === 'm2')
    if (first === undefined || second === undefined) throw new Error('成员丢了')
    return second.y - first.y
  }

  function seed(): void {
    useCanvasStore.setState({
      canvasId: null,
      nodes: [
        { id: 'g', type: 'group', x: 0, y: 0, title: '组', items: [], member_ids: ['m1', 'm2'] },
        imageNode('m1', 1024, 1536),
        imageNode('m2', 1024, 1536),
      ],
      connections: [],
      selectedNodeIds: [],
      selectedEdgeIds: [],
    })
  }

  it('成员按实测高度让位，不按写死的高度', () => {
    seed()
    registerCanvas({
      boxes: new Map([
        ['m1', { w: 300, h: 620 }],
        ['m2', { w: 300, h: 620 }],
      ]),
    })
    expect(stackedGap()).toBeGreaterThanOrEqual(620)
  })

  it('没量过的成员按真实比例的兜底高度让位', () => {
    seed()
    const h = fallbackBox(imageNode('m1', 1024, 1536)).h
    expect(stackedGap()).toBeGreaterThanOrEqual(h)
  })
})

/* ==================== 「有没有图可用」的唯一判据 ====================

   分组小菜单说预览可用，编辑器就必须打得开。两边各写一遍的话，
   组里第一个 item 是提示词占位或还没入库的图时，按钮亮着点下去什么都不发生。 */

describe('分组小菜单的可用性与编辑器打不打得开是同一件事', () => {
  const group = (items: CanvasItem[]): ScvNode =>
    ({ id: 'g', type: 'group', x: 0, y: 0, items, member_ids: [] }) as ScvNode

  const previewEnabled = (n: ScvNode): boolean =>
    groupToolbarActions(n).find((a) => a.key === 'preview')?.enabled === true

  it('首个 item 没入库时，预览仍然可用且编辑器有起始张', () => {
    const n = group([
      { kind: 'image' } as CanvasItem,
      { kind: 'image', asset_id: 7 } as CanvasItem,
    ])
    expect(previewEnabled(n)).toBe(true)
    expect(imageAssetIds(n)[0]).toBe(7)
  })

  it('一张已入库的图都没有时两边都说不行', () => {
    const n = group([{ kind: 'image' } as CanvasItem])
    expect(previewEnabled(n)).toBe(false)
    expect(imageAssetIds(n)).toEqual([])
  })

  it('带资产号的非图片素材不算「可预览的图」', () => {
    // 挑到视频的资产号当起始张，弹窗会去取一张根本不是图的资产
    const n = group([{ kind: 'video', asset_id: 9 } as unknown as CanvasItem])
    expect(previewEnabled(n)).toBe(false)
    expect(imageAssetIds(n)).toEqual([])
  })
})
