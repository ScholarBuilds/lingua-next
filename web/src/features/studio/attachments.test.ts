/* 输入框附件的守卫测试（模块 17）。
 *
   守两条会静默失效的路：

   一是**附件里的图必须算参考图**。不收的话用户拖了张参考图进输入框，
   出图照跑、结果不带这张图，界面上一切正常——他只会觉得"模型没听话"。

   二是**空节点的宽度只有一个出口**。它同时被前端 addNode 和服务端建新画布用，
   两处各写一个数的话，新画布自带的节点比右键建出来的窄一截，没人会去查。 */

import { describe, expect, it } from 'vitest'

import { EMPTY_NODE_W, MAX_REFS, boxForItems, fallbackBox, refAssetIds } from './canvasStore'
import type { ScvNode } from './canvasStore'
import type { CanvasConnection, CanvasItem } from '../../lib/api-studio'

const node = (id: string, over: Partial<ScvNode> = {}): ScvNode =>
  ({ id, type: 'image', x: 0, y: 0, ...over }) as ScvNode

const img = (asset_id: number): CanvasItem => ({ kind: 'image', asset_id })
const doc = (name: string): CanvasItem => ({ kind: 'file', media_asset_id: 1, name })
const link = (from: string, to: string): CanvasConnection =>
  ({ from, to, kind: 'input' }) as CanvasConnection

describe('附件里的图进参考', () => {
  it('挂在输入框上的图会被当参考图送出去', () => {
    const nodes = [node('a', { attachments: [img(7)] })]
    expect(refAssetIds(nodes, [], 'a')).toEqual([7])
  })

  it('排在节点自身产出之前', () => {
    /* 刚拖进输入框的那张，意图比节点上早就躺着的产出更明确。
       顺序还决定正文里「图1/图2」编到谁头上，错位了模型看的就是另一张 */
    const nodes = [node('a', { attachments: [img(7)], items: [img(3)] })]
    expect(refAssetIds(nodes, [], 'a')).toEqual([7, 3])
  })

  it('@ 引用仍然排在最前', () => {
    const nodes = [
      node('a', {
        prompt_draft_refs: [{ asset_id: 9, label: '图9' }],
        attachments: [img(7)],
        items: [img(3)],
      }),
    ]
    expect(refAssetIds(nodes, [], 'a')).toEqual([9, 7, 3])
  })

  it('文档附件不进参考图', () => {
    // 文档没有 asset_id，走的是"服务端按 id 抽正文"那条路
    const nodes = [node('a', { attachments: [doc('规范.md')] })]
    expect(refAssetIds(nodes, [], 'a')).toEqual([])
  })

  it('和上游图一起时不重复、不越上限', () => {
    const nodes = [
      node('up', { items: [img(7), img(8)] }),
      node('a', { attachments: [img(7)] }),
    ]
    const got = refAssetIds(nodes, [link('up', 'a')], 'a')
    expect(got).toEqual([7, 8])
    expect(got.length).toBeLessThanOrEqual(MAX_REFS)
  })
})

describe('空节点的尺寸', () => {
  it('没有图时用 EMPTY_NODE_W，而不是媒体节点那个 520 的兜底', () => {
    /* 520 配上空态的高度是一条 2.2:1 的横杠，读起来像出错了 */
    expect(EMPTY_NODE_W).toBe(420)
    expect(boxForItems([]).w).toBe(520)
    expect(fallbackBox(node('a')).w).toBe(EMPTY_NODE_W)
  })

  it('有图之后回到按图算的框', () => {
    expect(fallbackBox(node('a', { items: [img(1)] })).w).not.toBe(EMPTY_NODE_W)
  })

  it('用户拖过手柄的宽度压过默认值', () => {
    expect(fallbackBox(node('a', { w: 700 })).w).toBe(700)
  })
})
