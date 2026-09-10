/* 节点外壳首帧：缩放手柄渲染出来几个、是哪几个。
 *
   本仓 vitest 跑在 node 里没有 jsdom，指针拖拽测不了——那部分的数学
   （八向的 x/y/w/h 变换、顶到下限时钉哪条边）已经在 geometry.test.ts 里逐条锁死。
   这里守的是**外壳有没有真的把手柄挂出来**：改造前 `onResize` 一直没传，
   `onResize !== undefined` 恒为 false，手柄写了但从来没渲染出来，
   而这种事在单测里只有数 DOM 才看得见。 */

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { NodeShell } from './NodeShell'
import { RESIZE_HANDLES, WIDTH_RESIZE_HANDLES, resizeCursor } from './geometry'
import type { ResizeHandle } from './geometry'

const VP = { x: 0, y: 0, scale: 1 }

function shell(props: Partial<Parameters<typeof NodeShell>[0]> = {}): string {
  return renderToStaticMarkup(<NodeShell id="n1" x={10} y={20} width={300} height={200} viewport={VP} {...props} />)
}

/** 从首帧 HTML 里把手柄方位捞出来 */
function handlesIn(html: string): string[] {
  return [...html.matchAll(/data-handle="([a-z]+)"/g)].map((m) => m[1])
}

describe('缩放手柄首帧', () => {
  it('不给 onResize 就一个手柄都不画', () => {
    expect(handlesIn(shell())).toEqual([])
  })

  it('给了 onResize 但不指定方位时只有右下角——老调用方接上来行为不变', () => {
    expect(handlesIn(shell({ onResize: () => {} }))).toEqual(['se'])
  })

  it('分组那一档：八个方位全画出来，一个不少', () => {
    const got = handlesIn(shell({ onResize: () => {}, resizeHandles: RESIZE_HANDLES }))
    expect(got).toHaveLength(8)
    expect([...got].sort()).toEqual(['e', 'n', 'ne', 'nw', 's', 'se', 'sw', 'w'])
  })

  /* 高度不落库的节点只给改宽度的那几个：给一个动不了对边的手柄，
     用户拖了发现毫无反应，比不给还糟。 */
  it('只改宽度那一档：四个，且每个都带 e 或 w', () => {
    const got = handlesIn(shell({ onResize: () => {}, resizeHandles: WIDTH_RESIZE_HANDLES }))
    expect([...got].sort()).toEqual(['e', 'se', 'sw', 'w'])
    expect(got.every((h) => h.includes('e') || h.includes('w'))).toBe(true)
  })

  it('每个手柄都带自己的方位类名，CSS 才定得了位', () => {
    const html = shell({ onResize: () => {}, resizeHandles: RESIZE_HANDLES })
    for (const handle of RESIZE_HANDLES) {
      expect(html).toContain(`cvc-resize cvc-resize-${handle}`)
    }
  })

  it('指针形状写在手柄上，与 resizeCursor 同一张表', () => {
    const html = shell({ onResize: () => {}, resizeHandles: RESIZE_HANDLES })
    for (const handle of RESIZE_HANDLES) {
      const mark = new RegExp(`data-handle="${handle}"[^>]*style="cursor:([a-z-]+)"`)
      expect(html.match(mark)?.[1]).toBe(resizeCursor(handle))
    }
  })

  it('手柄挂在 .cvc-resize 上：整块拖动的逃生口按这个类名判', () => {
    const html = shell({ onResize: () => {}, resizeHandles: ['n'] as ResizeHandle[] })
    expect(html).toContain('class="cvc-resize cvc-resize-n"')
  })
})
