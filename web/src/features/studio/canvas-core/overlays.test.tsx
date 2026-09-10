/* 世界层两个 SVG 浮层的首帧守卫：连线层与对齐参考线。
 *
   本仓 vitest 跑在 node 里没有 jsdom，点击这类事件测不了，
   但**首帧画出来是什么**测得到——而这两处的坑恰好都在首帧：

   - 选中态只挂在 `<path>` 上、没挂到外层 `<g>` 上的话，
     `.cvc-conn-on .cvc-cut`（选中后常驻的断开按钮）永远匹配不上，
     表现为「线亮了，但还是得把指针悬上去才找得到删除入口」；
   - 参考线漏了 `vector-effect`，放大到 3 倍时会糊成一条粗带子，
     缩到 0.2 倍又细到看不见——它是量具，粗细不该跟着缩放变。 */

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { AlignGuides } from './AlignGuides'
import { ConnectionLayer } from './ConnectionLayer'
import type { RenderedConnection } from './ConnectionLayer'
import type { Rect } from './geometry'
import type { SnapGuide } from './snapping'

const RECTS = new Map<string, Rect>([
  ['a', { x: 0, y: 0, width: 200, height: 100 }],
  ['b', { x: 400, y: 0, width: 200, height: 100 }],
])

function conn(extra: Partial<RenderedConnection> = {}): RenderedConnection {
  return { indices: [0], from: 'a', to: 'b', kind: 'input', ...extra }
}

describe('连线层首帧', () => {
  it('选中的线在外层 g 上挂 cvc-conn-on，断开按钮才会常驻', () => {
    const html = renderToStaticMarkup(<ConnectionLayer connections={[conn({ selected: true })]} rects={RECTS} />)
    expect(html).toContain('class="cvc-conn cvc-conn-on"')
  })

  it('没选中就不挂，免得每条线的断开按钮都亮着', () => {
    const html = renderToStaticMarkup(<ConnectionLayer connections={[conn()]} rects={RECTS} />)
    expect(html).toContain('class="cvc-conn"')
    expect(html).not.toContain('cvc-conn-on')
  })

  it('整桶下标写进 data-conn-index，点中合并线等于点中背后所有边', () => {
    const html = renderToStaticMarkup(
      <ConnectionLayer connections={[conn({ indices: [2, 5, 7], merged: true })]} rects={RECTS} />,
    )
    expect(html).toContain('data-conn-index="2,5,7"')
  })

  it('拿不到矩形的连线整条跳过，不画半截线', () => {
    const html = renderToStaticMarkup(<ConnectionLayer connections={[conn({ to: 'ghost' })]} rects={RECTS} />)
    expect(html).not.toContain('cvc-conn')
  })
})

describe('对齐参考线首帧', () => {
  const guides: SnapGuide[] = [
    { axis: 'x', at: 100, start: 0, end: 500 },
    { axis: 'y', at: 250, start: 10, end: 90 },
  ]

  it('竖线画在 x=at 上沿 y 铺开，横线反过来', () => {
    const html = renderToStaticMarkup(<AlignGuides guides={guides} />)
    expect(html).toContain('x1="100"')
    expect(html).toContain('y1="0"')
    expect(html).toContain('x2="100"')
    expect(html).toContain('y2="500"')
    expect(html).toContain('x1="10"')
    expect(html).toContain('y1="250"')
  })

  it('每条线都带 non-scaling-stroke：参考线是量具，粗细不跟缩放走', () => {
    const html = renderToStaticMarkup(<AlignGuides guides={guides} />)
    expect(html.match(/vector-effect="non-scaling-stroke"/g)).toHaveLength(2)
  })

  it('没有参考线时整层不渲染，画布上不会多一个空 svg 挡住点击', () => {
    expect(renderToStaticMarkup(<AlignGuides guides={[]} />)).toBe('')
  })
})
