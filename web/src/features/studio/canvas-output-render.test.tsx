/* 输出节点 / 历史节点的首帧渲染冒烟。
 *
   纯函数测试只保证"该写什么"算得对，保证不了它真的画到了 DOM 上：
   标题条改成条件渲染之后，最容易出的错是条件写反——一张图的节点照旧顶着标题栏，
   或者该有血缘的分支节点一个字都不写。这两种在纯函数测试里都是绿的。

   与 canvas-editor-render 同一套替身与限制：本仓 vitest 跑在 node 里没有 jsdom，
   只能 `renderToStaticMarkup` 量首帧。 */

import { createElement } from 'react'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../components/Overlay', () => ({
  Overlay: ({ children }: { children: ReactNode }) => createElement('div', { className: 'overlay' }, children),
  useEscapeClose: () => undefined,
  useOverlayOpen: () => false,
  overlayDepth: () => 0,
}))

const { ImageNode, OutputNode } = await import('./CanvasNodes')
import { useCanvasStore } from './canvasStore'
import type { ScvNode } from './canvasStore'
import type { CanvasConnection, CanvasItem } from '../../lib/api-studio'

const image = (asset_id: number, name?: string): CanvasItem => ({ kind: 'image', asset_id, name })

function seed(nodes: ScvNode[], connections: CanvasConnection[]): void {
  useCanvasStore.setState({ canvasId: null, nodes, connections, selectedNodeIds: [], selectedEdgeIds: [] })
}

function draw(node: ScvNode, View: typeof OutputNode): string {
  return renderToStaticMarkup(
    createElement(View, { data: { node, runLabel: null } }),
  )
}

afterEach(() => useCanvasStore.getState().reset())

describe('输出节点首帧', () => {
  const source: ScvNode = { id: 'src', type: 'image', x: 0, y: 0, items: [image(9, '登录页.png')] }

  it('分支出来的单图输出写血缘，不写「1 项结果」', () => {
    const out: ScvNode = { id: 'out', type: 'output', x: 500, y: 0, items: [image(1)] }
    seed([source, out], [{ from: 'src', to: 'out', kind: 'flow' }])
    const html = draw(out, OutputNode)
    expect(html).toContain('分支自 登录页.png')
    expect(html).not.toContain('项结果')
  })

  it('孤立的单图输出整条标题条都不画', () => {
    const out: ScvNode = { id: 'out', type: 'output', x: 500, y: 0, items: [image(1)] }
    seed([out], [])
    expect(draw(out, OutputNode)).not.toContain('scv-node-title')
  })

  it('多张产物才画摘要', () => {
    const out: ScvNode = { id: 'out', type: 'output', x: 500, y: 0, items: [image(1), image(2)] }
    seed([source, out], [{ from: 'src', to: 'out', kind: 'flow' }])
    const html = draw(out, OutputNode)
    expect(html).toContain('scv-node-title')
    expect(html).toContain('2 张图')
  })
})

describe('历史节点首帧', () => {
  it('标题写清是谁的旧图，而不是光秃秃的「历史」', () => {
    const source: ScvNode = { id: 'src', type: 'image', x: 0, y: 0, items: [image(9, '登录页.png')] }
    const hist: ScvNode = {
      id: 'h',
      type: 'image',
      x: 0,
      y: 400,
      title: '历史',
      history_for: 'src',
      items: [image(3)],
    }
    seed([source, hist], [{ from: 'src', to: 'h', kind: 'history' }])
    const html = draw(hist, ImageNode)
    expect(html).toContain('登录页.png 的旧图')
    expect(html).toContain('scv-hist')
  })

  it('普通图片节点不会被写成旧图', () => {
    const plain: ScvNode = { id: 'p', type: 'image', x: 0, y: 0, items: [image(1, '主视觉.png')] }
    seed([plain], [])
    const html = draw(plain, ImageNode)
    expect(html).toContain('主视觉.png')
    expect(html).not.toContain('旧图')
    expect(html).not.toContain('scv-hist')
  })
})
