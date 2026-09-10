/* 画幅「自动」与骨架比例的守卫（模块 17）。
 *
   实测抓到的坑：画布上选着「画幅自动」写「出一个移动端 app 的登录页面」，
   发出去的提示词末尾是 `Canvas: 1536x608, aspect ratio 2.53:1.`——
   模型只能把三个手机屏并排塞进超宽 banner。它没有不听话，是我们让它这么画的。

   根因是空值被 `size or 默认` 一路吞掉，回落到给单词卡横幅调的 Tunable 默认。
   与画风那个 `NO_STYLE` 的坑完全同构：**"没说"和"明确不要"必须是两个值**。 */

import { describe, expect, it } from 'vitest'

import { pendingAspect } from './canvasStore'
import type { ScvNode } from './canvasStore'
import type { CanvasConnection, CanvasItem } from '../../lib/api-studio'

const node = (id: string, over: Partial<ScvNode> = {}): ScvNode =>
  ({ id, type: 'image', x: 0, y: 0, ...over }) as ScvNode

const img = (w: number, h: number, asset_id = 1): CanvasItem => ({ kind: 'image', asset_id, w, h })

const link = (from: string, to: string): CanvasConnection =>
  ({ from, to, kind: 'input' }) as CanvasConnection

describe('骨架的预期比例', () => {
  it('钉了画幅就用它', () => {
    const n = node('a', { run_settings: { size: '1024x1536' } })
    expect(pendingAspect([n], [], 'a')).toBeCloseTo(1024 / 1536)
  })

  it('画幅是 auto 时不当成尺寸去解析', () => {
    // "auto".split('x') 会得到 NaN，必须落回下一级判据而不是产出一个坏比例
    const n = node('a', { run_settings: { size: 'auto' }, items: [img(900, 1600)] })
    expect(pendingAspect([n], [], 'a')).toBeCloseTo(900 / 1600)
  })

  it('没钉画幅时跟随自身的图（重生成场景）', () => {
    expect(pendingAspect([node('a', { items: [img(900, 1600)] })], [], 'a')).toBeCloseTo(0.5625)
  })

  it('自身没图时沿上游找', () => {
    const nodes = [node('up', { items: [img(768, 1344)] }), node('a')]
    expect(pendingAspect(nodes, [link('up', 'a')], 'a')).toBeCloseTo(768 / 1344)
  })

  it('附件里的图也算', () => {
    expect(pendingAspect([node('a', { attachments: [img(1024, 1536)] })], [], 'a')).toBeCloseTo(
      1024 / 1536,
    )
  })

  it('什么都没有时是方的，不猜横的', () => {
    /* 猜横的正是这个 bug 的成因：固定 150px 高 + 节点宽 420 = 2.8:1 的横杠 */
    expect(pendingAspect([node('a')], [], 'a')).toBe(1)
  })

  it('history 边不参与——它是旧图，不代表接下来要出什么', () => {
    const nodes = [node('old', { items: [img(1600, 900)] }), node('a')]
    const hist = { from: 'old', to: 'a', kind: 'history' } as CanvasConnection
    expect(pendingAspect(nodes, [hist], 'a')).toBe(1)
  })
})
