import { describe, expect, it } from 'vitest'

import {
  branchOriginId,
  historyOwnerId,
  historyTitle,
  isHistoryNode,
  nodeDisplayName,
  outputCaption,
  outputSummary,
} from './output-node-view'
import type { NodeBrief } from './output-node-view'
import type { CanvasConnection, CanvasItem } from '../../lib/api-studio'

const image = (asset_id: number, name?: string): CanvasItem => ({ kind: 'image', asset_id, name })
const video = (): CanvasItem => ({ kind: 'video', media_asset_id: 1 })
const audio = (): CanvasItem => ({ kind: 'audio', media_asset_id: 2 })
const file = (): CanvasItem => ({ kind: 'file', url: '/x.zip', name: 'x.zip' })

describe('产物摘要：重复的事实不写', () => {
  it('一张图什么都不写——图就在下面摆着，「1 项结果」是把一整条标题栏花在废话上', () => {
    expect(outputSummary([image(1)])).toBeNull()
  })

  it('没有产物也不写：空态那一层已经说了「还没有产物」', () => {
    expect(outputSummary([])).toBeNull()
    expect(outputSummary(undefined)).toBeNull()
  })

  it('单个非图片产物要说是什么：折叠成播放器/一行链接后看不出来', () => {
    expect(outputSummary([video()])).toBe('视频')
    expect(outputSummary([audio()])).toBe('音频')
    expect(outputSummary([file()])).toBe('文件')
  })

  it('多个同类按类型给量词', () => {
    expect(outputSummary([image(1), image(2)])).toBe('2 张图')
    expect(outputSummary([video(), video(), video()])).toBe('3 条视频')
    expect(outputSummary([audio(), audio()])).toBe('2 条音频')
    expect(outputSummary([file(), file()])).toBe('2 个文件')
  })

  it('混排产物退回中性量词', () => {
    expect(outputSummary([image(1), video()])).toBe('2 项产物')
  })
})

describe('节点显示名', () => {
  it('标题优先，其次首个带文件名的产物，都没有就叫不出名字', () => {
    expect(nodeDisplayName({ id: 'a', title: '登录页' })).toBe('登录页')
    expect(nodeDisplayName({ id: 'a', items: [image(1), image(2, '手机页.png')] })).toBe('手机页.png')
    expect(nodeDisplayName({ id: 'a', items: [image(1)] })).toBeNull()
    expect(nodeDisplayName({ id: 'a', title: '   ' })).toBeNull()
    expect(nodeDisplayName(undefined)).toBeNull()
  })
})

describe('分支血缘：只认 flow 入边', () => {
  const connections: CanvasConnection[] = [
    { from: 'ref', to: 'out', kind: 'input' },
    { from: 'src', to: 'out', kind: 'flow' },
    { from: 'old', to: 'out', kind: 'history' },
  ]

  it('参考图（input）和旧图（history）都不是生成血缘', () => {
    expect(branchOriginId(connections, 'out')).toBe('src')
  })

  it('缺省 kind 当 flow：老画布里的边没存 kind', () => {
    expect(branchOriginId([{ from: 'src', to: 'out' }], 'out')).toBe('src')
  })

  it('没有入边就是孤立节点', () => {
    expect(branchOriginId(connections, 'other')).toBeNull()
  })
})

describe('输出节点标题条：陌生就命名，重复就不写', () => {
  const nodes: NodeBrief[] = [
    { id: 'src', type: 'image', items: [image(9, '登录页.png')] },
    { id: 'named', type: 'image', title: '主视觉' },
  ]
  const flow = (from: string): CanvasConnection[] => [{ from, to: 'out', kind: 'flow' }]

  it('用户点「出图（分支）」后冒出来的那个框，写清它是从哪分出来的', () => {
    const node: NodeBrief = { id: 'out', type: 'output', items: [image(1)] }
    expect(outputCaption(node, nodes, flow('src'))).toEqual({
      text: '分支自 登录页.png',
      detail: null,
    })
  })

  it('源节点有标题就用标题', () => {
    const node: NodeBrief = { id: 'out', type: 'output', items: [image(1)] }
    expect(outputCaption(node, nodes, flow('named'))?.text).toBe('分支自 主视觉')
  })

  it('源节点叫不出名字时仍表明这是分支，不是凭空多出来的框', () => {
    const node: NodeBrief = { id: 'out', type: 'output', items: [image(1)] }
    expect(outputCaption(node, [{ id: 'bare' }], flow('bare'))?.text).toBe('分支输出')
  })

  it('节点自己存了标题（级联槽位 / ModelScope 输出）以它为准', () => {
    const node: NodeBrief = { id: 'out', type: 'output', title: '第 2 轮', items: [image(1)] }
    expect(outputCaption(node, nodes, flow('src'))).toEqual({ text: '第 2 轮', detail: null })
  })

  it('多张产物时摘要才出现', () => {
    const node: NodeBrief = { id: 'out', type: 'output', items: [image(1), image(2)] }
    expect(outputCaption(node, nodes, flow('src'))).toEqual({
      text: '分支自 登录页.png',
      detail: '2 张图',
    })
  })

  it('孤立 + 一张图 = 整条标题栏不该存在', () => {
    const node: NodeBrief = { id: 'out', type: 'output', items: [image(1)] }
    expect(outputCaption(node, nodes, [])).toBeNull()
  })

  it('孤立但产物需要说明时，退回中性的「输出」', () => {
    const node: NodeBrief = { id: 'out', type: 'output', items: [video()] }
    expect(outputCaption(node, nodes, [])).toEqual({ text: '输出', detail: '视频' })
  })

  it('还没出结果的分支节点也要写血缘：空框上什么都不写才是最费解的', () => {
    const node: NodeBrief = { id: 'out', type: 'output', items: [] }
    expect(outputCaption(node, nodes, flow('src'))).toEqual({
      text: '分支自 登录页.png',
      detail: null,
    })
  })
})

describe('历史节点的关联判定', () => {
  const source: NodeBrief = { id: 'src', type: 'image', items: [image(9, '登录页.png')] }

  it('history_for 字段是主判据', () => {
    const hist: NodeBrief = { id: 'h', title: '历史', history_for: 'src' }
    expect(historyOwnerId(hist, [])).toBe('src')
    expect(isHistoryNode(hist, [])).toBe(true)
  })

  it('字段缺了认 history 入边：早期画布只有那条边', () => {
    const hist: NodeBrief = { id: 'h', title: '历史' }
    const edges: CanvasConnection[] = [{ from: 'src', to: 'h', kind: 'history' }]
    expect(historyOwnerId(hist, edges)).toBe('src')
    expect(isHistoryNode(hist, edges)).toBe(true)
  })

  it('普通图片节点不会被误判成历史节点', () => {
    const plain: NodeBrief = { id: 'p', items: [image(1)] }
    const edges: CanvasConnection[] = [{ from: 'src', to: 'p', kind: 'flow' }]
    expect(historyOwnerId(plain, edges)).toBeNull()
    expect(isHistoryNode(plain, edges)).toBe(false)
  })

  it('标题写清是谁的旧图，写死的「历史」两个字让位给派生文案', () => {
    const hist: NodeBrief = { id: 'h', title: '历史', history_for: 'src', items: [image(3)] }
    expect(historyTitle(hist, [source, hist], [])).toBe('登录页.png 的旧图')
  })

  it('源节点已被删掉时不硬编一个名字', () => {
    const hist: NodeBrief = { id: 'h', title: '历史', history_for: 'gone' }
    expect(historyTitle(hist, [hist], [])).toBe('旧图存档')
  })

  it('用户手动改过名的以用户为准', () => {
    const hist: NodeBrief = { id: 'h', title: '废案', history_for: 'src' }
    expect(historyTitle(hist, [source, hist], [])).toBe('废案')
  })
})
