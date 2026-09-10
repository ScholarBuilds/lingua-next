/* 提示词面板的渲染冒烟与接口契约。

   两类东西在这里守：

   1. **面板是不是还是面板**。它从居中弹窗改过来，靠的是几条 CSS：贴右侧、
      不铺遮罩、给画布留出宽度。这几条一旦被后来的改动抹掉，界面「看着还行」，
      但用户又回到了「挑一条词就看不见画布」的老问题上，没有任何报错。
      纯函数全绿而页面白屏本仓也吃过（节点定义的 View 写成非 getter 触发 TDZ），
      所以整个面板要真渲染一遍。本仓 vitest 跑在 node（没有 jsdom），
      走 renderToStaticMarkup——够验证「该出的入口出没出、文案对不对」。

   2. **增删查改打的是哪个端点**。面板是搬能力过来，不是重新实现：
      写库走 `apiStudio` 那几个既有端点，内置模板只有 fork / hidden 两条路，
      AI 只有 `POST /studio/prompts/compose` 一个端点且不写库。 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { apiStudio } from '../../lib/api-studio'
import { PromptPicker, fetchPromptLibrary, setPromptHidden } from './PromptPicker'
import type { PromptEntry } from './PromptPicker'
import { composePrompt } from './prompt-compose'
import { PANEL_DEFAULT_W } from './prompt-panel'

const CSS = readFileSync(fileURLToPath(new URL('./prompt-library.css', import.meta.url)), 'utf8')

/** 取一条顶层单类规则的声明块 */
function rule(name: string): string {
  const match = CSS.match(new RegExp(`\\n\\.${name} \\{([^}]*)\\}`))
  return match === null ? '' : match[1]
}

function item(over: Partial<PromptEntry> & { id: number }): PromptEntry {
  return {
    group_id: null,
    title: '',
    body: '',
    negative: '',
    scene: '',
    source: null,
    source_ref: null,
    builtin: false,
    hidden: false,
    category: null,
    category_name: '',
    category_sort: 99,
    favorite: false,
    used_count: 0,
    variables: [],
    version: 1,
    updated_at: '2026-08-20T10:00:00Z',
    ...over,
  }
}

/* 两条同类模板：正文开头几乎一模一样，只有「适用场景」分得出谁是谁。
   这正是列表里必须显示场景而不是截断正文的理由。 */
const MINE = item({
  id: 11,
  title: '写实产品图',
  scene: '白底电商主图，要能直接上架的那种',
  body: 'a photorealistic studio product shot, seamless white background, softbox lighting',
  negative: 'blurry, watermark',
  used_count: 4,
})

const BUILTIN = item({
  id: -1,
  title: '多机位九宫格',
  body: 'a 3x3 grid of {{主体}} shot from nine camera angles',
  builtin: true,
  category: 'view',
  category_name: '视角',
  category_sort: 0,
  updated_at: null,
  version: null,
  variables: [{ name: '主体', label: '主体', description: '拍谁', default: '', required: true }],
})

const HIDDEN = item({
  id: -2,
  title: '收起来的模板',
  body: 'hidden template',
  builtin: true,
  hidden: true,
  category: 'view',
  category_name: '视角',
  category_sort: 0,
  updated_at: null,
  version: null,
})

function render(items: PromptEntry[]): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['spl-groups'], { items: [{ id: 7, name: '我的库', parent_id: null }] })
  client.setQueryData(['spl-prompts', 'panel'], {
    items,
    categories: [{ id: 'view', name: '视角' }],
  })
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(PromptPicker, { onPick: () => undefined, onClose: () => undefined }),
    ),
  )
}

describe('面板形态', () => {
  it('贴右侧、不铺遮罩，宽度是内联给的', () => {
    const html = render([MINE, BUILTIN])
    expect(html).toContain('spl-panel')
    expect(html).toContain(`width:${PANEL_DEFAULT_W}px`)
    // 有遮罩就等于又把画布盖住了，那是改这一版之前的样子
    expect(html).not.toContain('class="overlay"')
  })

  it('CSS 把它钉在视口右侧，并让开删除确认那一层', () => {
    const panel = rule('spl-panel')
    expect(panel).toContain('position: fixed')
    expect(panel).toMatch(/right:\s*0/)
    expect(panel).toMatch(/bottom:\s*0/)
    // .overlay 是 100：删除确认、编辑器都要能盖在面板上
    const z = Number(/z-index:\s*(\d+)/.exec(panel)?.[1])
    expect(z).toBeLessThan(100)
    expect(z).toBeGreaterThan(90)
  })

  it('编辑器那层壳铺满视口，不缩进面板里', () => {
    // .spl-editor 是 absolute inset:0，铺的是最近的定位祖先。壳不是 fixed 的话
    // 编辑器会缩成 420 宽的一条缝——而「长提示词在窄缝里改不动」正是要解决的问题
    const layer = rule('spl-ed-layer')
    expect(layer).toContain('position: fixed')
    expect(layer).toContain('inset: 0')
    expect(Number(/z-index:\s*(\d+)/.exec(layer)?.[1])).toBeGreaterThan(100)
  })

  it('给一条可拖的边，键盘也够得着', () => {
    expect(rule('spl-panel-grip')).toContain('cursor: col-resize')
    const html = render([MINE])
    expect(html).toContain('role="separator"')
    expect(html).toContain('tabindex="0"')
  })
})

describe('列表一眼看得出这条是干什么的', () => {
  it('有「适用场景」就显示它，而不是一串截断的英文', () => {
    const html = render([MINE])
    expect(html).toContain('白底电商主图，要能直接上架的那种')
  })

  it('没写场景才摘正文，并标明这是摘的', () => {
    const html = render([BUILTIN])
    expect(html).toContain('spl-row-mark')
  })

  it('篇幅、变量数、带不带负向、套用次数都摆在行里', () => {
    const html = render([MINE, BUILTIN])
    expect(html).toContain('词')
    expect(html).toContain('1 个变量')
    expect(html).toContain('带负向')
    expect(html).toContain('套用 4 次')
  })
})

describe('增删查改的入口', () => {
  it('新建与「AI 写一条」都在头部', () => {
    const html = render([MINE])
    expect(html).toContain('AI 写一条')
    expect(html).toContain('新建')
  })

  it('自建条目给编辑、复制、删除、收藏四条路', () => {
    const html = render([MINE])
    expect(html).toContain('aria-label="编辑"')
    expect(html).toContain('aria-label="复制一份"')
    expect(html).toContain('aria-label="删除"')
    expect(html).toContain('aria-label="收藏"')
  })

  it('内置模板不给改也不给删，只给「复制为自建」与「隐藏」', () => {
    const html = render([BUILTIN])
    expect(html).toContain('aria-label="复制为自建"')
    expect(html).toContain('aria-label="隐藏这条内置模板"')
    // 直接改内置模板后端一律 400（它随版本发布，不是一行数据）
    expect(html).not.toContain('aria-label="编辑"')
    expect(html).not.toContain('aria-label="删除"')
  })

  it('隐藏掉的内置模板默认不列出，但给得出恢复它的入口', () => {
    const html = render([MINE, BUILTIN, HIDDEN])
    expect(html).not.toContain('收起来的模板')
    expect(html).toContain('含已隐藏 1')
  })

  it('库里空着时说清下一步该干什么', () => {
    const html = render([])
    expect(html).toContain('提示词库还是空的')
  })
})

/* ==================== 接口契约 ==================== */

function stubFetch(payload: unknown): { calls: [string, string][] } {
  const calls: [string, string][] = []
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    calls.push([url, init?.method ?? 'GET'])
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  })
  return { calls }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('面板打的端点', () => {
  it('列表带 include_hidden——看不见的模板恢复不了', () => {
    const { calls } = stubFetch({ items: [], categories: [] })
    void fetchPromptLibrary(true)
    expect(calls[0][0]).toBe('/api/studio/prompts?include_hidden=true')
  })

  it('新建 / 改 / 删走既有的三个端点', async () => {
    const { calls } = stubFetch({ id: 5 })
    await apiStudio.createPrompt({ title: 'a', body: 'b' })
    await apiStudio.patchPrompt(5, { title: 'c' })
    await apiStudio.deletePrompt(5)
    expect(calls).toEqual([
      ['/api/studio/prompts', 'POST'],
      ['/api/studio/prompts/5', 'PATCH'],
      ['/api/studio/prompts/5', 'DELETE'],
    ])
  })

  it('内置模板 override 走 fork，还原走 hidden——两条都不改模板本身', async () => {
    const { calls } = stubFetch({ id: 9, title: '多机位九宫格 副本' })
    await apiStudio.forkPrompt(-1)
    await setPromptHidden(-1, true)
    await setPromptHidden(-1, false)
    expect(calls[0]).toEqual(['/api/studio/prompts/-1/fork', 'POST'])
    expect(calls[1]).toEqual(['/api/studio/prompts/-1', 'PATCH'])
    expect(calls[2]).toEqual(['/api/studio/prompts/-1', 'PATCH'])
  })

  it('隐藏与恢复只传 hidden 这一个字段，正文一个字不动', async () => {
    const bodies: string[] = []
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''))
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    await setPromptHidden(-1, true)
    expect(JSON.parse(bodies[0])).toEqual({ hidden: true })
  })

  it('AI 只打 compose 这一个端点，产出不入库', async () => {
    const { calls } = stubFetch({
      title: '黄昏街拍',
      scene: '',
      body: 'a candid street portrait at golden hour',
      negative: 'blurry',
      variables: [],
      mode: 'create',
      model: 'deepseek-chat',
      latency_ms: 900,
    })
    const out = await composePrompt({ intent: '黄昏街拍', mode: 'create' })
    expect(calls).toEqual([['/api/studio/prompts/compose', 'POST']])
    // 产出只是一段文本，落编辑器给人改；没有任何一次写库调用
    expect(out.body).toContain('golden hour')
    expect(calls.some(([url]) => url === '/api/studio/prompts')).toBe(false)
  })

  it('变量填充由服务端渲染，前端不自己替换字符串', async () => {
    const { calls } = stubFetch({ body: 'a 3x3 grid of 运动鞋', negative: '' })
    await apiStudio.renderPrompt(-1, { 主体: '运动鞋' })
    expect(calls).toEqual([['/api/studio/prompts/-1/render', 'POST']])
  })
})
