/* 画布输入框的渲染冒烟（E1）。
 *
   纯函数测试全绿而浏览器整页白屏，本仓吃过一次（节点定义的 `View` 写成非 getter
   触发 TDZ，492 条测试全绿、一开浏览器就死）——vitest 与 vite dev 解析模块图的
   顺序不同，单测不覆盖模块初始化顺序。这里把三个输入框组件真渲染一遍：
   导入环、初始化顺序、缺 provider 都会当场炸。

   本仓 vitest 跑在 node 环境（没有 jsdom），所以走 renderToStaticMarkup，
   只验结构与文案，验不了点击。 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/* MentionInput 在渲染期直接读 `window.innerWidth`（候选层要夹在视口内）。
   node 环境里没有 window，补一个只够它算数的桩——这是测试环境的缺口，
   不是产品缺陷：那个框只在浏览器里活着。 */
Object.assign(globalThis, {
  window: { innerWidth: 1280, innerHeight: 800 },
})

vi.mock('../../components/Overlay', () => ({
  Overlay: ({ children }: { children: ReactNode }) =>
    createElement('div', { className: 'overlay' }, children),
  useEscapeClose: () => undefined,
  useOverlayOpen: () => false,
  overlayDepth: () => 0,
}))

const { BulkComposer, ComposerAssist, GenerateBar } = await import('./CanvasPage')
import { EMPTY_MENTION } from './MentionInput'
import { historyTitle } from './output-node-view'
import { useCanvasStore } from './canvasStore'
import type { ScvNode } from './canvasStore'

function render(node: JSX.Element): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, node))
}

const imageNode = (id: string, over: Partial<ScvNode> = {}): ScvNode => ({
  id,
  type: 'image',
  x: 0,
  y: 0,
  prompt_draft: '一只猫',
  ...over,
})

/** 灌一份画布状态。
 *
 *  **初始状态那份也得一起灌**：zustand 的 `useStore` 把 `api.getInitialState()`
 *  当 `getServerSnapshot` 传给 `useSyncExternalStore`，而 renderToStaticMarkup
 *  读的就是这一个——只 `setState` 的话组件在这里看到的永远是那份空的初始状态，
 *  表现为「灌了三个节点，渲染出来却是空字符串」，且一声不吭。
 *
 *  改的办法只能是**原地改那个对象**：`create()` 把 api 的方法 `Object.assign`
 *  复制到 hook 函数上，但 `useStore` 内部用的是原始 api，所以 spy 打在
 *  `useCanvasStore.getInitialState` 上根本拦不到（试过，白试）。 */
function seed(nodes: ScvNode[]): void {
  const patch = {
    nodes,
    connections: [],
    running: {},
    cascade: null,
    selectedNodeIds: nodes.map((n) => n.id),
    selectedEdgeIds: [],
  }
  useCanvasStore.setState(patch)
  Object.assign(useCanvasStore.getInitialState(), patch)
}

beforeEach(() => {
  vi.restoreAllMocks()
  seed([])
})

describe('单节点输入框', () => {
  it('渲染出正文框、助手行与出图按钮', () => {
    const node = imageNode('a')
    seed([node])
    const html = render(
      createElement(GenerateBar, {
        node,
        running: false,
        cascading: false,
        onSetPlan: () => undefined,
      }),
    )
    expect(html).toContain('smi-editor')
    expect(html).toContain('词库')
    expect(html).toContain('AI 写词')
    expect(html).toContain('最近')
    expect(html).toContain('出图')
    // 收起是新加的，收起之后画布底部让出来，Esc 同效
    expect(html).toContain('收起')
  })

  it('已有图的节点主按钮说清是分支出新节点', () => {
    const node = imageNode('a', { items: [{ kind: 'image', asset_id: 1 }] })
    seed([node])
    const html = render(
      createElement(GenerateBar, {
        node,
        running: false,
        cascading: false,
        onSetPlan: () => undefined,
      }),
    )
    expect(html).toContain('出图（分支）')
    expect(html).toContain('重生成本节点')
  })

  it('按钮说的旧图节点名与画布上真画出来的那个一致', () => {
    const node = imageNode('a', { items: [{ kind: 'image', asset_id: 1, name: '登录页.png' }] })
    seed([node])
    const html = render(
      createElement(GenerateBar, {
        node,
        running: false,
        cascading: false,
        onSetPlan: () => undefined,
      }),
    )
    /* 画布上历史节点的标题是派生的（historyTitle），存的那个「历史」已经不再露出。
       按钮这边要是还说「移入『历史』节点」，用户按完就得去画布上找一个
       根本不存在的名字——两边说的必须是同一件事。 */
    expect(historyTitle({ id: 'h', title: '历史', history_for: 'a' }, [node], [])).toBe(
      '登录页.png 的旧图',
    )
    expect(html).toContain('的旧图')
    expect(html).not.toContain('「历史」节点')
  })
})

describe('助手行', () => {
  it('没扩写过就不摆对比条', () => {
    const html = render(
      createElement(ComposerAssist, {
        value: EMPTY_MENTION,
        onChange: () => undefined,
        disabled: false,
      }),
    )
    expect(html).not.toContain('scv-ai-strip')
    expect(html).toContain('AI 写词')
  })
})

describe('批量输入框', () => {
  it('说清这一批有几个能跑，而不是只给排版按钮', () => {
    seed([imageNode('a'), imageNode('b'), imageNode('c')])
    const html = render(createElement(BulkComposer, { ids: ['a', 'b', 'c'] }))
    expect(html).toContain('3 个节点准备好了')
    expect(html).toContain('出图 · 3 个')
  })

  /* 并发上限只在真会排队时才说。三个节点上限也是三个，一个都不用排——
     这时候还挂着「同时最多跑 3 个」就是常驻噪音。 */
  it('不会排队时不提并发上限', () => {
    seed([imageNode('a'), imageNode('b'), imageNode('c')])
    const html = render(createElement(BulkComposer, { ids: ['a', 'b', 'c'] }))
    expect(html).not.toContain('同时最多跑')
  })

  it('超过并发上限时才提排队', () => {
    const ids = ['a', 'b', 'c', 'd']
    seed(ids.map((id) => imageNode(id)))
    const html = render(createElement(BulkComposer, { ids }))
    expect(html).toContain('同时最多跑 3 个')
  })

  /* 不能出图的那几个连同原因摆在条上，不静默过滤。
     但「差一句词」与「类型不对」要分开说——前者的修法就在正下方的输入框里，
     并列成「跳过 2 个」会把差一步说成失败。 */
  it('差一句词与真跳过分开说', () => {
    seed([
      imageNode('a'),
      imageNode('b', { prompt_draft: '' }),
      { id: 'c', type: 'prompt', x: 0, y: 0 } as ScvNode,
    ])
    const html = render(createElement(BulkComposer, { ids: ['a', 'b', 'c'] }))
    expect(html).toContain('1 个节点准备好了')
    expect(html).toContain('1 个还没有词')
    expect(html).toContain('跳过 1 个不是出图节点')
    expect(html).not.toContain('跳过 2 个')
  })

  /* 一个能跑的都没有、差的只是词时，主按钮不能是一个死掉的「出图 · 0 个」——
     那看起来像坏了，而修法就在光标已经停着的地方。 */
  it('全都只差词时主按钮指向补救动作', () => {
    const ids = ['a', 'b']
    seed(ids.map((id) => imageNode(id, { prompt_draft: '' })))
    const html = render(createElement(BulkComposer, { ids }))
    expect(html).toContain('2 个节点还没有词')
    expect(html).toContain('写一句词，出 2 个')
    expect(html).not.toContain('出图 · 0 个')
  })

  it('选中的一批里一个图节点都没有时整条不出现', () => {
    seed([
      { id: 'a', type: 'prompt', x: 0, y: 0 } as ScvNode,
      { id: 'b', type: 'prompt', x: 0, y: 0 } as ScvNode,
    ])
    expect(render(createElement(BulkComposer, { ids: ['a', 'b'] }))).toBe('')
  })
})

/* ==================== 生成模式：出几张 × 怎么跑 ==================== */

function genbar(node: ScvNode): string {
  seed([node])
  return render(
    createElement(GenerateBar, {
      node,
      running: false,
      cascading: false,
      onSetPlan: () => undefined,
    }),
  )
}

describe('输入框的生成模式收口', () => {
  it('只出一张时「怎么跑」整个不出现——不是禁用，是不占位置', () => {
    const html = genbar(imageNode('a'))
    expect(html).toContain('出几张')
    expect(html).toContain('1 张')
    expect(html).not.toContain('怎么跑')
  })

  it('旧画布只写过 n：n=4 直接读成「多张·并发」，跑法跟着露出来', () => {
    const html = genbar(imageNode('a', { run_settings: { n: 4 } }))
    expect(html).toContain('怎么跑')
    expect(html).toContain('并发')
    expect(html).toContain('出 4 张')
  })

  it('串行多张：主按钮说清跑几轮，「落回本节点」那条路不再提供', () => {
    const html = genbar(
      imageNode('a', {
        items: [{ kind: 'image', asset_id: 1 }],
        run_settings: { count_mode: 'fixed', run_mode: 'serial', n: 3 },
      }),
    )
    expect(html).toContain('串行出 3 张')
    expect(html).toContain('本节点下方排 3 个新节点')
    expect(html).not.toContain('重生成本节点')
  })

  it('自动张数：主按钮就是成套，不再另摆一个同样作用的按钮', () => {
    const html = genbar(imageNode('a', { run_settings: { count_mode: 'auto' } }))
    expect(html).toContain('规划并出图')
    expect(html).toContain('张数由 AI 从提示词判断')
    // 按那个按钮独有的 title 判，别拿「成套」两个字判——说明文案里也有这两个字
    expect(html).not.toContain('规划出一整套风格统一的图')
  })

  it('不是自动张数时，成套仍然是一条独立的入口（它不要求先写提示词）', () => {
    const html = genbar(imageNode('a'))
    expect(html).toContain('规划出一整套风格统一的图')
  })

  it('出图前把将要发生什么摆出来：落点与参考状态都在条上', () => {
    const html = genbar(imageNode('a'))
    expect(html).toContain('落进本节点')
    expect(html).toContain('文生图')
  })

  it('出图中主按钮变成「排下一条」，输入框照旧可编辑', () => {
    const node = imageNode('a')
    seed([node])
    const html = render(
      createElement(GenerateBar, {
        node,
        running: true,
        cascading: false,
        onSetPlan: () => undefined,
      }),
    )
    expect(html).toContain('排下一条')
    // 正文框不带 disabled——跑着的这一次已经把词发出去了，此刻改的是下一条
    expect(html).toContain('contenteditable="true"')
  })

  it('草稿是空的时候排不了队，按钮照旧点不动', () => {
    const node = imageNode('a', { prompt_draft: '' })
    seed([node])
    const html = render(
      createElement(GenerateBar, {
        node,
        running: true,
        cascading: false,
        onSetPlan: () => undefined,
      }),
    )
    // 判主按钮本身，别只判页面上有没有 disabled——模型下拉在测试环境里也是禁用的
    expect(html).toContain('class="btn btn-primary btn-sm" disabled=""')
  })
})
