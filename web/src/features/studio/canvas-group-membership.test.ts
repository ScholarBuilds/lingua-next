import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  dissolveGroup,
  groupBatchOutputs,
  groupMinSize,
  groupSize,
  groupSelection,
  groupToolbarActions,
  mergeGroupIntoGroup,
  placeNodeInGroup,
  resizeGroup,
  syncGroupMembership,
  useCanvasStore,
} from './canvasStore'
import type { GroupToolbarAction, ScvNode } from './canvasStore'

afterEach(() => useCanvasStore.getState().reset())

function seed(): void {
  useCanvasStore.setState({
    canvasId: null,
    nodes: [
      { id: 'group', type: 'group', x: 100, y: 100, title: '分组', items: [], member_ids: [] },
      { id: 'prompt', type: 'prompt', x: 700, y: 100, text: '' },
      { id: 'loop', type: 'loop', x: 180, y: 120, count: 1, mode: 'serial' },
      { id: 'image', type: 'image', x: 180, y: 120, items: [] },
    ],
    connections: [],
    selectedNodeIds: [],
    selectedEdgeIds: [],
  })
}

describe('智能分组成员', () => {
  it('从分组菜单创建提示词时直接入组，并扩展容器高度', () => {
    seed()
    const before = groupSize(useCanvasStore.getState().nodes[0]).h

    expect(placeNodeInGroup('group', 'prompt')).toBe(true)

    const state = useCanvasStore.getState()
    const group = state.nodes.find((node) => node.id === 'group')
    const prompt = state.nodes.find((node) => node.id === 'prompt')
    if (group === undefined) throw new Error('分组未创建')
    expect(group?.member_ids).toEqual(['prompt'])
    expect(groupSize(group).h).toBeGreaterThan(before)
    expect(prompt).toMatchObject({ x: 118, y: 228 })
    expect(state.selectedNodeIds).toEqual(['prompt'])
  })

  it('循环拖入分组也登记为成员', () => {
    seed()
    syncGroupMembership('loop')
    expect(useCanvasStore.getState().nodes.find((node) => node.id === 'group')?.member_ids).toContain('loop')
  })

  it('空上传节点没有可吸收的素材时保留在画布', () => {
    seed()
    expect(placeNodeInGroup('group', 'image')).toBe(false)
    expect(useCanvasStore.getState().nodes.some((node) => node.id === 'image')).toBe(true)
  })

  it('单个循环也能成组，不再被「至少两个图片或提示词」拦住', () => {
    seed()
    groupSelection(['loop'])
    const state = useCanvasStore.getState()
    const group = state.nodes.find((node) => node.type === 'group' && node.id !== 'group')
    expect(group?.member_ids).toEqual(['loop'])
    expect(state.selectedNodeIds).toEqual([group?.id])
  })

  it('缩放分组时成员重排填充新宽度，尺寸一个都不动', () => {
    seed()
    placeNodeInGroup('group', 'prompt')
    const before = useCanvasStore.getState().nodes.find((node) => node.id === 'prompt')
    if (before === undefined) throw new Error('提示词未创建')

    resizeGroup('group', { x: 100, y: 100, width: 900, height: 600 }, 'se')

    const state = useCanvasStore.getState()
    const group = state.nodes.find((node) => node.id === 'group')
    const prompt = state.nodes.find((node) => node.id === 'prompt')
    expect(group).toMatchObject({ x: 100, y: 100, w: 900, h: 600 })
    /* 关键断言：成员尺寸原样不动。蓝本 smart-canvas.js:1615 记着等比缩放的后果——
       缩放后的 w/h 写回成员，拖出再拖入就越缩越小，"整理"也救不回来。 */
    expect(prompt?.w).toBe(before.w)
    expect(prompt?.h).toBe(before.h)
    // 位置回到内容区左上角（组左上 + 18 内边距 / 图片网格下方）
    expect(prompt).toMatchObject({ x: 118, y: 228 })
  })

  it('分组拖入分组合并图片、成员并改接连线', () => {
    useCanvasStore.setState({
      canvasId: null,
      nodes: [
        { id: 'source', type: 'group', x: 0, y: 0, items: [{ kind: 'image', asset_id: 1 }], member_ids: ['loop'] },
        { id: 'target', type: 'group', x: 500, y: 0, items: [{ kind: 'image', asset_id: 2 }], member_ids: ['prompt'] },
        { id: 'loop', type: 'loop', x: 20, y: 180, count: 1, mode: 'serial' },
        { id: 'prompt', type: 'prompt', x: 520, y: 180, text: '' },
        { id: 'tail', type: 'image', x: 900, y: 0, items: [] },
      ],
      connections: [{ from: 'source', to: 'tail', kind: 'input' }],
      selectedNodeIds: ['source'],
      selectedEdgeIds: [],
    })

    expect(mergeGroupIntoGroup('source', 'target')).toBe(true)

    const state = useCanvasStore.getState()
    const target = state.nodes.find((node) => node.id === 'target')
    expect(state.nodes.some((node) => node.id === 'source')).toBe(false)
    expect(target?.items?.map((item) => item.asset_id)).toEqual([2, 1])
    expect(target?.member_ids).toEqual(['prompt', 'loop'])
    expect(state.connections).toEqual([{ from: 'target', to: 'tail', kind: 'input' }])
    expect(state.selectedNodeIds).toEqual(['target'])
  })
})

/* ==================== 分组顶部小菜单 ====================

   五条可用判据直译自蓝本 `smart-canvas.js:8289` smartGroupToolbarHtml。
   判据写错不会报错，只会变成一个点了没反应、或者点了报错的按钮，
   而那要真的建一个分组、往里放到刚好那么多张图才看得出来。 */

function group(extra: Partial<ScvNode> = {}): ScvNode {
  return { id: 'g', type: 'group', x: 0, y: 0, title: '分组', items: [], member_ids: [], ...extra }
}

function enabled(node: ScvNode | undefined, key: GroupToolbarAction): boolean {
  const hit = groupToolbarActions(node).find((action) => action.key === key)
  if (hit === undefined) throw new Error(`菜单里没有 ${key}`)
  return hit.enabled
}

describe('分组小菜单的可用判据', () => {
  it('五个动作，顺序与蓝本一致', () => {
    expect(groupToolbarActions(group()).map((a) => a.key)).toEqual([
      'arrange',
      'preview',
      'grid',
      'download',
      'ungroup',
    ])
  })

  it('空分组：只有解散可用——空组也得能拆掉', () => {
    const empty = group()
    expect(enabled(empty, 'arrange')).toBe(false)
    expect(enabled(empty, 'preview')).toBe(false)
    expect(enabled(empty, 'grid')).toBe(false)
    expect(enabled(empty, 'download')).toBe(false)
    expect(enabled(empty, 'ungroup')).toBe(true)
  })

  it('只有成员没有图：整理可用，其余与图有关的都不可用', () => {
    const onlyMembers = group({ member_ids: ['prompt'] })
    expect(enabled(onlyMembers, 'arrange')).toBe(true)
    expect(enabled(onlyMembers, 'preview')).toBe(false)
    expect(enabled(onlyMembers, 'download')).toBe(false)
  })

  it('一张图：预览与批量下载可用，宫格拼接要两张才谈得上「拼」', () => {
    const one = group({ items: [{ kind: 'image', asset_id: 1 }] })
    expect(enabled(one, 'preview')).toBe(true)
    expect(enabled(one, 'download')).toBe(true)
    expect(enabled(one, 'grid')).toBe(false)
  })

  it('两张图：五个全可用', () => {
    const two = group({ items: [{ kind: 'image', asset_id: 1 }, { kind: 'image', asset_id: 2 }] })
    for (const action of groupToolbarActions(two)) expect(action.enabled).toBe(true)
  })

  /* 判据要和批量下载真正取到的是同一批图（都要求 kind=image 且已入库），
     否则按钮亮着而点下去提示「分组内还没有已入库图片」 */
  it('没入库的外链图不算数：按钮该是灰的', () => {
    const external = group({ items: [{ kind: 'image', url: 'https://x/y.png' }] })
    expect(enabled(external, 'preview')).toBe(false)
    expect(enabled(external, 'download')).toBe(false)
  })

  it('停用的动作都给了理由，不留没头没脑的灰按钮', () => {
    for (const action of groupToolbarActions(group())) {
      if (!action.enabled) expect(action.disabledReason).toBeTruthy()
    }
  })
})

/* ==================== 解散分组 ==================== */

describe('解散分组', () => {
  afterEach(() => useCanvasStore.getState().reset())

  it('图拆回独立节点，从分组原位置铺开，两两不重叠', () => {
    useCanvasStore.setState({
      canvasId: null,
      nodes: [
        {
          id: 'g',
          type: 'group',
          x: 300,
          y: 200,
          title: '分组',
          items: [
            { kind: 'image', asset_id: 1, w: 512, h: 512 },
            { kind: 'image', asset_id: 2, w: 512, h: 512 },
          ],
          member_ids: [],
        },
      ],
      connections: [],
      selectedNodeIds: ['g'],
      selectedEdgeIds: [],
    })

    dissolveGroup('g')

    const born = useCanvasStore.getState().nodes.filter((n) => n.type === 'image')
    expect(born).toHaveLength(2)
    expect(useCanvasStore.getState().nodes.some((n) => n.id === 'g')).toBe(false)
    // 从分组原位置起铺：第一张就落在组的左上角
    expect(born[0]).toMatchObject({ x: 300, y: 200 })
    // 第二张不压在第一张身上
    const [a, b] = born
    const overlap =
      a.x < b.x + (b.w ?? 0) && a.x + (a.w ?? 0) > b.x && a.y < b.y + 400 && a.y + 400 > b.y
    expect(overlap).toBe(false)
  })

  it('拆出来的图和释放的成员一起选中，接着就能整理或再成组', () => {
    useCanvasStore.setState({
      canvasId: null,
      nodes: [
        {
          id: 'g',
          type: 'group',
          x: 0,
          y: 0,
          title: '分组',
          items: [{ kind: 'image', asset_id: 1 }],
          member_ids: ['prompt'],
        },
        { id: 'prompt', type: 'prompt', x: 20, y: 200, text: '' },
      ],
      connections: [],
      selectedNodeIds: ['g'],
      selectedEdgeIds: [],
    })

    dissolveGroup('g')

    const state = useCanvasStore.getState()
    const born = state.nodes.find((n) => n.type === 'image')
    expect(state.selectedNodeIds.sort()).toEqual([born?.id, 'prompt'].sort())
    // 成员本体留在画布上，位置不动
    expect(state.nodes.find((n) => n.id === 'prompt')).toMatchObject({ x: 20, y: 200 })
  })

  it('连到分组的边改接到拆出来的第一张图，不会留下悬空边', () => {
    useCanvasStore.setState({
      canvasId: null,
      nodes: [
        { id: 'g', type: 'group', x: 0, y: 0, title: '分组', items: [{ kind: 'image', asset_id: 1 }], member_ids: [] },
        { id: 'tail', type: 'image', x: 900, y: 0, items: [] },
      ],
      connections: [{ from: 'g', to: 'tail', kind: 'input' }],
      selectedNodeIds: [],
      selectedEdgeIds: [],
    })

    dissolveGroup('g')

    const state = useCanvasStore.getState()
    const born = state.nodes.find((n) => n.type === 'image' && n.id !== 'tail')
    expect(state.connections).toEqual([{ from: born?.id, to: 'tail', kind: 'input' }])
  })
})

/* ==================== 出图产物收进分组 ==================== */

function outputNode(id: string, x: number, assetId: number): ScvNode {
  return { id, type: 'output', x, y: 0, items: [{ kind: 'image', asset_id: assetId }] }
}

describe('出图产物收进分组', () => {
  afterEach(() => useCanvasStore.getState().reset())

  function seedOutputs(nodes: ScvNode[], extra: Partial<Record<string, unknown>> = {}): void {
    useCanvasStore.setState({
      canvasId: null,
      nodes: [{ id: 'src', type: 'image', x: 0, y: 0, items: [{ kind: 'image', asset_id: 9 }] }, ...nodes],
      connections: nodes.map((n) => ({ from: 'src', to: n.id, kind: 'flow' as const })),
      selectedNodeIds: [],
      selectedEdgeIds: [],
      ...extra,
    })
  }

  it('两个以上产出收进一个分组，图并进组内网格，连线改接分组', () => {
    seedOutputs([outputNode('o1', 600, 1), outputNode('o2', 1000, 2)])

    const gid = groupBatchOutputs('src')

    const state = useCanvasStore.getState()
    expect(gid).not.toBeNull()
    expect(state.nodes.some((n) => n.id === 'o1' || n.id === 'o2')).toBe(false)
    const created = state.nodes.find((n) => n.id === gid)
    expect(created?.items?.map((it) => it.asset_id)).toEqual([1, 2])
    expect(state.connections).toEqual([{ from: 'src', to: gid, kind: 'flow' }])
  })

  it('只有一个产出时不成组：给一张图套个更小的框没有意义', () => {
    seedOutputs([outputNode('o1', 600, 1)])
    expect(groupBatchOutputs('src')).toBeNull()
    expect(useCanvasStore.getState().nodes.some((n) => n.id === 'o1')).toBe(true)
  })

  /* 级联槽位靠 slot_of / slot_round 跨会话认领，吸收进分组等于把槽位删了，
     下次重跑会在旁边重建一整排新节点——用户得自己一个个删。 */
  it('级联槽位不收', () => {
    seedOutputs([
      { ...outputNode('o1', 600, 1), slot_of: 'src', slot_round: 1 },
      { ...outputNode('o2', 1000, 2), slot_of: 'src', slot_round: 2 },
    ])
    expect(groupBatchOutputs('src')).toBeNull()
  })

  it('还在跑的产出不收：图还没落地就把节点吸收掉，落点就没了', () => {
    seedOutputs([outputNode('o1', 600, 1), outputNode('o2', 1000, 2)], {
      running: { o2: { label: '生成中', pending: false } },
    })
    expect(groupBatchOutputs('src')).toBeNull()
  })

  it('空产出节点不收：没有图可吸收，收进去只会多一个空框', () => {
    seedOutputs([outputNode('o1', 600, 1), { id: 'o2', type: 'output', x: 1000, y: 0, items: [] }])
    expect(groupBatchOutputs('src')).toBeNull()
  })
})

/* 八向缩放 + 成员自适应重排。几何变换本身在 canvas-core/geometry.test.ts 里验过，
   这里只守 store 侧：重排真的按新宽度走、成员尺寸不被写坏、最小尺寸由内容定、
   以及一次拖动只占一格撤销栈。

   分组固定 x=100 y=100、无图片：
   - 外框固有尺寸 340×144（GROUP_W / 34 头 + 76 空体 + 34 脚）
   - 成员区顶边 = y + 144 - 34 + 18 = 228，左边 = x + 18 = 118
   - 提示词成员默认 316×150（nodes/prompt.definition.ts） */
describe('八向缩放与成员重排', () => {
  const PROMPT_W = 316
  const PROMPT_H = 150

  /** 三个提示词成员，按 member_ids 顺序摆成一列 */
  function seedMembers(): void {
    useCanvasStore.setState({
      canvasId: null,
      nodes: [
        { id: 'group', type: 'group', x: 100, y: 100, items: [], member_ids: ['m1', 'm2', 'm3'] },
        { id: 'm1', type: 'prompt', x: 118, y: 228, text: '' },
        { id: 'm2', type: 'prompt', x: 118, y: 394, text: '' },
        { id: 'm3', type: 'prompt', x: 118, y: 560, text: '' },
      ],
      connections: [],
      selectedNodeIds: [],
      selectedEdgeIds: [],
      undoStack: [],
      redoStack: [],
    })
  }

  function at(id: string): { x: number; y: number } {
    const n = useCanvasStore.getState().nodes.find((node) => node.id === id)
    return { x: n?.x ?? NaN, y: n?.y ?? NaN }
  }

  function groupOf(): { x: number; y: number; w?: number; h?: number } {
    const g = useCanvasStore.getState().nodes.find((node) => node.id === 'group')
    if (g === undefined) throw new Error('分组没了')
    return { x: g.x, y: g.y, w: g.w, h: g.h }
  }

  it('拉宽到放得下三个：一行排完，间距 16', () => {
    seedMembers()
    resizeGroup('group', { x: 100, y: 100, width: 1050, height: 700 }, 'se')
    expect(at('m1')).toEqual({ x: 118, y: 228 })
    expect(at('m2')).toEqual({ x: 118 + PROMPT_W + 16, y: 228 })
    expect(at('m3')).toEqual({ x: 118 + (PROMPT_W + 16) * 2, y: 228 })
  })

  it('收窄到只放得下两个：第三个折到下一行', () => {
    seedMembers()
    resizeGroup('group', { x: 100, y: 100, width: 700, height: 700 }, 'se')
    expect(at('m1').y).toBe(228)
    expect(at('m2').y).toBe(228)
    expect(at('m3')).toEqual({ x: 118, y: 228 + PROMPT_H + 16 })
  })

  it('同一批成员，框越宽每行放得越多——这就是「自适应填充」', () => {
    const rowsAt = (width: number): number => {
      seedMembers()
      resizeGroup('group', { x: 100, y: 100, width, height: 900 }, 'se')
      return new Set(['m1', 'm2', 'm3'].map((id) => at(id).y)).size
    }
    expect(rowsAt(1050)).toBe(1)
    expect(rowsAt(700)).toBe(2)
    expect(rowsAt(360)).toBe(3)
  })

  it('成员的 w/h 一个都不写——蓝本那个「拖出再拖入图片变小」的坑就在这', () => {
    seedMembers()
    resizeGroup('group', { x: 100, y: 100, width: 1050, height: 700 }, 'se')
    resizeGroup('group', { x: 100, y: 100, width: 360, height: 900 }, 'se')
    for (const id of ['m1', 'm2', 'm3']) {
      const node = useCanvasStore.getState().nodes.find((n) => n.id === id)
      expect(node?.w).toBeUndefined()
      expect(node?.h).toBeUndefined()
    }
  })

  /* 反复缩放不该让内容漂移：等比缩放那版每次都把上一次的结果再乘一遍，
     来回拖十次成员就飞出框外了。 */
  it('来回缩放十次后回到同一个宽度，成员位置与第一次完全一致', () => {
    seedMembers()
    resizeGroup('group', { x: 100, y: 100, width: 700, height: 700 }, 'se')
    const first = ['m1', 'm2', 'm3'].map((id) => at(id))
    for (let i = 0; i < 10; i += 1) {
      resizeGroup('group', { x: 100, y: 100, width: 400 + i * 60, height: 700 }, 'se')
    }
    resizeGroup('group', { x: 100, y: 100, width: 700, height: 700 }, 'se')
    expect(['m1', 'm2', 'm3'].map((id) => at(id))).toEqual(first)
  })

  it('用户手摆的位置被重排覆盖，但他排的先后顺序留着', () => {
    seedMembers()
    // 把 m3 挪到最上面：顺序应该变成 m3 → m1 → m2
    useCanvasStore.setState({
      nodes: useCanvasStore.getState().nodes.map((n) => (n.id === 'm3' ? { ...n, y: 0 } : n)),
    })
    resizeGroup('group', { x: 100, y: 100, width: 1050, height: 700 }, 'se')
    const xs = ['m3', 'm1', 'm2'].map((id) => at(id).x)
    expect(xs).toEqual([118, 118 + PROMPT_W + 16, 118 + (PROMPT_W + 16) * 2])
  })

  it('拖左边缘：分组 x 跟着走，成员整体左移，右边界钉死', () => {
    seedMembers()
    resizeGroup('group', { x: -260, y: 100, width: 1050, height: 700 }, 'w')
    const group = groupOf()
    expect(group.x).toBe(-260)
    expect(group.x + (group.w ?? 0)).toBe(790)
    expect(at('m1')).toEqual({ x: -260 + 18, y: 228 })
  })

  it('拖上边缘：分组 y 跟着走，成员区顶边整体上移', () => {
    seedMembers()
    resizeGroup('group', { x: 100, y: -100, width: 1050, height: 900 }, 'n')
    expect(groupOf().y).toBe(-100)
    expect(at('m1')).toEqual({ x: 118, y: -100 + 128 })
  })

  it('最小宽度由「放得下最宽的成员」定，不是常量 GROUP_W', () => {
    seedMembers()
    // 提示词 316 + 两边各 18 = 352，比外框固有的 340 宽
    const min = groupMinSize(useCanvasStore.getState().nodes[0])
    expect(min.w).toBe(PROMPT_W + 18 * 2)

    resizeGroup('group', { x: 100, y: 100, width: 40, height: 900 }, 'se')
    expect(groupOf().w).toBe(min.w)
  })

  it('顶到最小宽度后继续往左拖：宽度停住，右边界仍然钉死', () => {
    seedMembers()
    const min = groupMinSize(useCanvasStore.getState().nodes[0]).w
    resizeGroup('group', { x: 700, y: 100, width: 40, height: 900 }, 'w')
    const group = groupOf()
    expect(group.w).toBe(min)
    // 右边界 = 请求矩形的右边界 740，x 被推回去而不是跟着指针继续左移
    expect(group.x + (group.w ?? 0)).toBe(740)
    expect(group.x).toBe(740 - min)
  })

  it('高度不够放下重排后的内容时自动撑开，成员不会掉到框外', () => {
    seedMembers()
    // 窄到一行一个 → 三行；请求一个明显不够的高度
    resizeGroup('group', { x: 100, y: 100, width: 360, height: 200 }, 'se')
    const group = groupOf()
    // 顶边偏移 128 + 三行内容（150×3 + 16×2）+ 下内边距 18 + 脚 34
    expect(group.h).toBe(128 + (PROMPT_H * 3 + 16 * 2) + 18 + 34)
    const bottom = at('m3').y + PROMPT_H
    expect(bottom).toBeLessThanOrEqual(group.y + (group.h ?? 0))
  })

  it('撑高时钉住这次拖动没在动的那条边：拖上边缘就往上长', () => {
    seedMembers()
    resizeGroup('group', { x: 100, y: 600, width: 360, height: 200 }, 'n')
    const group = groupOf()
    // 请求矩形的下边界 800 不动，高度往上撑
    expect(group.y + (group.h ?? 0)).toBe(800)
    expect(group.y).toBeLessThan(600)
  })

  it('空分组也能缩放，下限退回外框固有尺寸', () => {
    useCanvasStore.setState({
      canvasId: null,
      nodes: [{ id: 'group', type: 'group', x: 0, y: 0, items: [], member_ids: [] }],
      connections: [],
      selectedNodeIds: [],
      selectedEdgeIds: [],
    })
    resizeGroup('group', { x: 0, y: 0, width: 10, height: 10 }, 'se')
    expect(groupOf()).toMatchObject({ w: 340, h: 144 })
  })

  /* 撤销的口径：`resizeGroup` 自己**不打快照**，快照由调用方在第一帧打一次
     （CanvasBoard 的 `first` 参数）。整条拖动因此只占一格。 */
  it('一次拖动只入一格撤销栈：撤销一步回到拖之前', () => {
    seedMembers()
    /* 快照有 80ms 的合并窗口（接住「一个动作被拆成两批派发」），
       同文件前面的用例刚打过快照，不把时钟推过去这一格会被合并掉 */
    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 1000)
      const before = { group: groupOf(), m1: at('m1'), m3: at('m3') }
      // 第一帧打快照，之后每帧只改数据——模拟 NodeShell 逐帧回调
      useCanvasStore.getState().snapshot()
      expect(useCanvasStore.getState().undoStack.length).toBe(1)
      for (let i = 0; i < 12; i += 1) {
        resizeGroup('group', { x: 100, y: 100, width: 400 + i * 50, height: 700 }, 'se')
      }
      // 十二帧一格都没加：撤销栈里仍然只有起手那一格
      expect(useCanvasStore.getState().undoStack.length).toBe(1)

      useCanvasStore.getState().undoOnce()
      expect(groupOf()).toEqual(before.group)
      expect(at('m1')).toEqual(before.m1)
      expect(at('m3')).toEqual(before.m3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('位置没变的成员保持同一个对象引用，拖动中不做无谓的重渲染', () => {
    seedMembers()
    resizeGroup('group', { x: 100, y: 100, width: 1050, height: 700 }, 'se')
    const first = useCanvasStore.getState().nodes.find((n) => n.id === 'm1')
    resizeGroup('group', { x: 100, y: 100, width: 1050, height: 700 }, 'se')
    expect(useCanvasStore.getState().nodes.find((n) => n.id === 'm1')).toBe(first)
  })

  /* 旧画布只存了 w/h（甚至什么都没存），打开后第一次缩放不能崩、
     也不能把成员甩到别处去。 */
  it('旧画布：分组没存 w/h 也能正常缩放', () => {
    useCanvasStore.setState({
      canvasId: null,
      nodes: [
        { id: 'group', type: 'group', x: 0, y: 0, items: [], member_ids: ['m1'] },
        { id: 'm1', type: 'prompt', x: 999, y: 999, text: '' },
      ],
      connections: [],
      selectedNodeIds: [],
      selectedEdgeIds: [],
    })
    resizeGroup('group', { x: 0, y: 0, width: 800, height: 500 }, 'se')
    expect(groupOf()).toMatchObject({ w: 800, h: 500 })
    expect(at('m1')).toEqual({ x: 18, y: 128 })
  })
})
