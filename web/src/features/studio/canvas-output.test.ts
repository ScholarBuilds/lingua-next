import { afterEach, describe, expect, it } from 'vitest'

import { createAutoOutput, outputToInputGroup, useCanvasStore } from './canvasStore'
import type { ScvNode } from './canvasStore'
import type { CanvasConnection, CanvasItem } from '../../lib/api-studio'

const image = (asset_id: number): CanvasItem => ({ kind: 'image', asset_id })

const outputNode = (): ScvNode => ({
  id: 'out',
  type: 'output',
  x: 100,
  y: 200,
  items: [
    image(11),
    { kind: 'video', media_asset_id: 4, url: '/api/studio/media-assets/4/content' },
    image(12),
  ],
})

const connections: CanvasConnection[] = [
  { from: 'source', to: 'out', kind: 'flow' },
  { from: 'out', to: 'tail', kind: 'input' },
  { from: 'keep', to: 'tail', kind: 'history' },
]

function seed(): void {
  useCanvasStore.setState({
    canvasId: null,
    nodes: [
      { id: 'source', type: 'modelscope', x: 0, y: 0 },
      outputNode(),
      { id: 'tail', type: 'image', x: 700, y: 0 },
      { id: 'keep', type: 'prompt', x: 0, y: 600 },
    ],
    connections,
    selectedNodeIds: ['out'],
    selectedEdgeIds: [],
    selectedItem: { nodeId: 'out', assetId: 11 },
  })
}

afterEach(() => useCanvasStore.getState().reset())

describe('Output 转输入组', () => {
  it('复制时保留 Output 和全部连线，只拷贝图片项并错开 36px', () => {
    seed()
    const groupId = outputToInputGroup('out', 'copy')
    const state = useCanvasStore.getState()
    const group = state.nodes.find((node) => node.id === groupId)

    expect(state.nodes.some((node) => node.id === 'out')).toBe(true)
    expect(state.connections).toEqual(connections)
    expect(group).toMatchObject({ type: 'group', x: 136, y: 236, title: '输入组' })
    expect(group?.items).toEqual([image(11), image(12)])
    expect(state.selectedNodeIds).toEqual([groupId])
  })

  it('转换时删掉 Output 及上游连线，下游连线按原语义改接到新组', () => {
    seed()
    const groupId = outputToInputGroup('out', 'convert')
    const state = useCanvasStore.getState()

    expect(state.nodes.some((node) => node.id === 'out')).toBe(false)
    expect(state.nodes.find((node) => node.id === groupId)).toMatchObject({
      type: 'group',
      x: 100,
      y: 200,
      items: [image(11), image(12)],
    })
    expect(state.connections).toEqual([
      { from: 'keep', to: 'tail', kind: 'history' },
      { from: groupId, to: 'tail', kind: 'input' },
    ])
    expect(state.selectedItem).toBeNull()
  })

  it('空 Output 不创建空组', () => {
    seed()
    useCanvasStore.getState().updateNode('out', { items: [] })
    expect(outputToInputGroup('out', 'convert')).toBeNull()
    expect(useCanvasStore.getState().nodes.some((node) => node.id === 'out')).toBe(true)
  })
})

describe('端口拖空白自动输出', () => {
  it('生成节点直接创建 Output 并以 flow 连线保留血缘', () => {
    useCanvasStore.setState({
      canvasId: null,
      nodes: [{ id: 'video', type: 'video', title: '视频', x: 10, y: 20, items: [] }],
      connections: [],
      selectedNodeIds: ['video'],
      selectedEdgeIds: [],
    })

    const outputId = createAutoOutput('video', { x: 600, y: 400 })
    const state = useCanvasStore.getState()
    expect(outputId).not.toBeNull()
    expect(state.nodes.find((node) => node.id === outputId)).toMatchObject({
      type: 'output',
      x: 560,
      y: 337,
      title: '视频输出',
      items: [],
    })
    expect(state.connections).toEqual([{ from: 'video', to: outputId, kind: 'flow' }])
    expect(state.selectedNodeIds).toEqual([outputId])
  })

  it('非媒体生成节点仍保留端口菜单路径', () => {
    useCanvasStore.setState({
      canvasId: null,
      nodes: [{ id: 'llm', type: 'llm', x: 10, y: 20 }],
      connections: [],
    })

    expect(createAutoOutput('llm', { x: 600, y: 400 })).toBeNull()
    expect(useCanvasStore.getState().nodes).toHaveLength(1)
    expect(useCanvasStore.getState().connections).toEqual([])
  })
})
