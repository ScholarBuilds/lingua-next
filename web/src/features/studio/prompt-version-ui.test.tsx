/* 提示词库与工作流中心的渲染冒烟：变量徽标、版本入口、导出入口。

   纯函数全绿而页面白屏，本仓吃过一次（节点定义的 View 写成非 getter 触发 TDZ）。
   这两个页面这一轮都新接了组件（RevisionPanel / SchemaForm），导入环最容易在这里出。
   本仓 vitest 跑在 node 环境（没有 jsdom），所以走 renderToStaticMarkup——
   够验证「该出的入口出没出、文案对不对」，不涉及交互。 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import PromptLibraryPage, { PromptEditor } from './PromptLibraryPage'
import type { PromptEntry } from './PromptPicker'
import { WorkflowCenterPage } from './WorkflowCenterPage'

const CSS = readFileSync(
  fileURLToPath(new URL('./prompt-library.css', import.meta.url)),
  'utf8',
)

/** 取一条顶层单类规则的声明块。窄屏那几档在 @media 里，用 mediaRule 取 */
function rule(name: string): string {
  const match = CSS.match(new RegExp(`\n\.${name} \{([^}]*)\}`))
  return match === null ? '' : match[1]
}

/** 取某个 max-width 档里的整块声明 */
function mediaBlock(maxWidth: number): string {
  const start = CSS.indexOf(`@media (max-width: ${maxWidth}px) {`)
  if (start < 0) return ''
  let depth = 0
  for (let i = CSS.indexOf('{', start); i < CSS.length; i += 1) {
    if (CSS[i] === '{') depth += 1
    if (CSS[i] === '}') {
      depth -= 1
      if (depth === 0) return CSS.slice(start, i)
    }
  }
  return ''
}

function render(
  node: JSX.Element,
  seed?: (client: QueryClient) => void,
  route = '/',
): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  seed?.(client)
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(MemoryRouter, { initialEntries: [route] }, node),
    ),
  )
}

const WITH_VARS: PromptEntry = {
  id: 7,
  group_id: null,
  title: '带变量的模板',
  body: 'a photo of {{subject}}',
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
  variables: [
    { name: 'subject', label: '主体', description: '拍什么', default: '', required: true },
  ],
  version: 3,
  updated_at: '2026-08-23T02:00:00+00:00',
}

const BUILTIN: PromptEntry = {
  ...WITH_VARS,
  id: -1,
  title: '多机位九宫格',
  body: 'a 3x3 grid of {{主体}}',
  negative: 'numbers, text, letters, watermark',
  source: 'Infinite-Canvas',
  source_ref: 'static/system-prompts/infinite-canvas-prompt-templates.md@v2.1',
  builtin: true,
  category: 'view',
  category_name: '视角',
  category_sort: 0,
  variables: [{ name: '主体', label: '主体', description: '拍谁', default: '', required: true }],
  version: null,
  updated_at: null,
}

const HIDDEN_BUILTIN: PromptEntry = {
  ...BUILTIN,
  id: -2,
  title: '被收起来的模板',
  hidden: true,
}

const CATEGORIES = [
  { id: 'view', name: '视角' },
  { id: 'storyboard', name: '分镜' },
]

function libraryHtml(items: PromptEntry[], route = '/'): string {
  return render(
    createElement(PromptLibraryPage),
    (client) => {
      client.setQueryData(['spl-groups'], { items: [] })
      client.setQueryData(['spl-prompts', 'library'], { items, categories: CATEGORIES })
    },
    route,
  )
}

describe('提示词库', () => {
  const html = libraryHtml([WITH_VARS, BUILTIN, HIDDEN_BUILTIN])

  it('左栏给出库切换与内置分类，每类带数量', () => {
    expect(html).toContain('系统模板分类')
    expect(html).toContain('视角')
    expect(html).toContain('分镜')
    // 「系统」这一档只数没被隐藏的那条
    expect(html).toContain('spl-lib-btn')
  })

  it('被隐藏的内置模板只出现在「已隐藏」里，不进列表也不进计数', () => {
    expect(html).toContain('已隐藏')
    // 列表行里不该有它；「已隐藏」入口本身带的是计数，不是标题
    expect(html).not.toContain('被收起来的模板')
  })

  it('详情栏把正文与负向全文摊开，不截断', () => {
    // 卡片摘要截三行看不出两条九宫格差在哪，详情栏存在的理由就是这个
    expect(html).toContain('spl-full')
    expect(html).toContain('a photo of {{subject}}')
  })

  it('详情栏给出两种取用方式，与套用浮层同一套语义', () => {
    expect(html).toContain('完整复制')
    expect(html).toContain('填变量')
  })

  it('带变量的条目不给「完整复制」一条能直接交出去的路', () => {
    // 带 {{占位}} 的正文复制走再贴给模型，模型不报错，只会照着乱出图——
    // 这是整条链路唯一真正会出事的失败模式，复制入口也得堵上
    const withVars = libraryHtml([{ ...WITH_VARS, negative: 'blurry' }])
    expect(withVars).toContain('复制原文')
    expect(withVars).toMatch(/完整复制/)
    expect(withVars).toContain('disabled')
  })

  it('有变量的条目把占位与说明摆出来', () => {
    expect(html).toContain('spl-vartag')
    expect(html).toContain('{{subject}}')
  })

  it('自建条目给出版本入口，版本号照实显示', () => {
    expect(html).toContain('v3')
  })

  it('内置模板不给版本入口，改用复制为自建 + 可逆的隐藏', () => {
    const builtinHtml = libraryHtml([BUILTIN])
    // 内置模板不落库，历史无处可存——给个点不出东西的按钮比没有更糟
    expect(builtinHtml).not.toContain('>v1<')
    expect(builtinHtml).toContain('复制为自建')
    expect(builtinHtml).toContain('隐藏')
    expect(builtinHtml).toContain('源自 Infinite-Canvas')
  })

  it('切到「已隐藏」才看得到被收起来的那条，详情栏给的是「恢复」', () => {
    // 隐藏之后左栏那句提示就指着这个地址，所以选中项要能从 URL 进来
    const hiddenHtml = libraryHtml([BUILTIN, HIDDEN_BUILTIN], '/?scope=hidden')
    expect(hiddenHtml).toContain('被收起来的模板')
    expect(hiddenHtml).toContain('spl-badge-hidden')
    expect(hiddenHtml).toContain('恢复')
    // 没被隐藏的那条这会儿不该出现
    expect(hiddenHtml).not.toContain('多机位九宫格')
  })

  it('按分类筛只留这一类，左栏与列表同源算不会对不上', () => {
    const viewHtml = libraryHtml([WITH_VARS, BUILTIN], '/?scope=cat:view')
    expect(viewHtml).toContain('多机位九宫格')
    expect(viewHtml).not.toContain('带变量的模板')
    expect(viewHtml).toContain('系统模板 · 视角')
  })

  it('「我的」这一档把内置模板挡在外面', () => {
    const mineHtml = libraryHtml([WITH_VARS, BUILTIN], '/?scope=mine')
    expect(mineHtml).toContain('带变量的模板')
    expect(mineHtml).not.toContain('多机位九宫格')
  })
})

describe('列表挑得出东西', () => {
  it('写过「适用场景」就显示它', () => {
    const html = libraryHtml([{ ...WITH_VARS, scene: '拍朋友时用' }])
    expect(html).toContain('拍朋友时用')
    expect(html).not.toContain('spl-row-mark')
  })

  it('没写场景才摘正文，并标明这是摘的', () => {
    // 不标的话用户会以为自己给这条写过用途说明
    const html = libraryHtml([{ ...WITH_VARS, scene: '', body: 'a photo of a cat, soft light' }])
    expect(html).toContain('spl-row-excerpt')
    expect(html).toContain('a photo of a cat, soft light')
  })

  it('行尾把「多长、带不带负向、几个变量」摆出来', () => {
    // 三百词和三十词是两种东西，挑的时候要看得见
    const html = libraryHtml([{ ...WITH_VARS, negative: 'blurry' }])
    expect(html).toContain('带负向')
    expect(html).toContain('1 个变量')
    expect(html).toMatch(/\d+ 词/)
  })
})

describe('AI 写一条', () => {
  it('库顶栏给出入口', () => {
    expect(libraryHtml([WITH_VARS])).toContain('AI 写一条')
  })

  it('AI 面板写明产出没有入库', () => {
    // 这一路唯一真正会出事的是「产出直接入库」：模型写的东西质量参差，
    // 库里混进没人看过的条目之后，整个库就不敢直接套用了
    const html = renderToStaticMarkup(
      createElement(PromptEditor, {
        init: {
          id: null,
          title: '',
          scene: '',
          body: '',
          negative: '',
          group_id: null,
          variables: [],
        },
        groups: [],
        groupsError: null,
        onClose: () => undefined,
        onSaved: () => undefined,
      }),
    )
    expect(html).toContain('让 AI 写一条')
    expect(html).toContain('没有入库')
    expect(html).toContain('写一条')
    expect(html).toContain('扩写现有正文')
  })

  it('编辑器把正向正文放在最宽的一栏，标题场景挪到窄栏', () => {
    const html = renderToStaticMarkup(
      createElement(PromptEditor, {
        init: {
          id: 7,
          title: '带变量的模板',
          scene: '',
          body: 'a photo of {{subject}}',
          negative: '',
          group_id: null,
          variables: [],
        },
        groups: [],
        groupsError: null,
        onClose: () => undefined,
        onSaved: () => undefined,
      }),
    )
    expect(html).toContain('spl-ed-main')
    expect(html).toContain('spl-ed-side')
    expect(html).toContain('spl-body-input')
    // 存一次进一版历史，这句得写在界面上，不能靠用户自己记得
    expect(html).toContain('存一次进一版历史')
  })
})

describe('长正文不撑破容器', () => {
  it('详情栏正文等宽、折行、长串也能断开', () => {
    // `--no-text--no-letters--no-watermark` 这种不带空格的长串只有
    // word-break 时会把整栏顶宽，横向滚动条一出，右边的按钮就被推出可视区
    const full = rule('spl-full')
    expect(full).toContain('white-space: pre-wrap')
    expect(full).toContain('overflow-wrap: anywhere')
    expect(full).toContain('var(--font-mono)')
  })

  it('全屏读正文那一层强制折行', () => {
    // `<pre>` 默认 white-space: pre，一行不折就是一条横向滚动条到天边
    const reader = rule('spl-reader-text')
    expect(reader).toContain('white-space: pre-wrap')
    expect(reader).toContain('overflow-wrap: anywhere')
  })

  it('列表那一行照旧截断——它只负责认出是哪一条', () => {
    const scene = rule('spl-row-scene')
    expect(scene).toContain('text-overflow: ellipsis')
    expect(scene).toContain('white-space: nowrap')
  })

  it('详情栏给了全屏与复制两条取用长文的路', () => {
    const html = libraryHtml([WITH_VARS])
    expect(html).toContain('全屏')
    expect(html).toMatch(/\d+ 词 · \d+ 字符/)
  })
})

describe('窄屏退化', () => {
  const narrow = mediaBlock(960)

  it('左栏收成抽屉，顶栏给出唯一入口', () => {
    expect(rule('spl-rail-toggle')).toContain('display: none')
    expect(narrow).toContain('.spl-rail-toggle { display: inline-flex; }')
    expect(narrow).toContain('.spl-side-open')
    expect(libraryHtml([WITH_VARS])).toContain('spl-rail-toggle')
  })

  it('详情栏盖在列表上，且只在主动点过一条时才盖', () => {
    // 一进页面就被详情糊住的话，用户连自己在哪个分类里都看不见
    expect(narrow).toContain('.spl-detail-open { display: flex; }')
    expect(narrow).toMatch(/\.spl-detail \{[^}]*display: none/)
    const plain = libraryHtml([WITH_VARS])
    expect(plain).toContain('spl-detail')
    expect(plain).not.toContain('spl-detail-open')
  })

  it('地址里点名了某一条，详情栏就是打开的', () => {
    // `?item=` 是「现在在看这条」。窄屏下详情盖在列表上，开没开属于地址的一部分——
    // 刷新之后还停在同一条，链接发出去别人点开看到的也是同一条
    const html = libraryHtml([WITH_VARS, BUILTIN], '/?item=7')
    expect(html).toContain('spl-detail-open')
    expect(html).toContain('a photo of {{subject}}')
  })

  it('搜索把选中项筛掉之后详情自己让开', () => {
    // 详情栏这时回落到第一条。窄屏下它要是还盖着，用户看的是一条自己没点过的条目，
    // 而且找不回列表
    const html = libraryHtml([BUILTIN], '/?item=7')
    expect(html).toContain('多机位九宫格')
    expect(html).not.toContain('spl-detail-open')
  })

  it('认不出的 item 不会让详情空着盖上来', () => {
    expect(libraryHtml([WITH_VARS], '/?item=abc')).not.toContain('spl-detail-open')
  })

  it('窄屏下详情栏给一条回列表的路', () => {
    expect(rule('spl-detail-close')).toContain('display: none')
    expect(narrow).toContain('.spl-detail-close { display: inline-flex; }')
    expect(libraryHtml([WITH_VARS])).toContain('返回列表')
  })

  it('编辑器上下摞，正向仍排最上面', () => {
    expect(narrow).toMatch(/\.spl-ed-grid \{[^}]*flex-direction: column/)
    // 自动高度的容器里 flex:1 会塌成 0，各段必须回到内容高度
    expect(narrow).toContain('.spl-ed-grow { flex: none; }')
  })

  it('手机竖屏再压一档，抽屉按视口宽给', () => {
    expect(mediaBlock(560)).toContain('.spl-side { width: min(280px, 84vw); }')
  })
})

describe('工作流中心', () => {
  const detail = {
    id: 4,
    key: 'user:abc',
    title: '我的放大流',
    provider: 'comfyui' as const,
    kind: 'upscale',
    source: 'user' as const,
    source_id: null,
    enabled: true,
    node_count: 2,
    field_count: 1,
    has_thumbnail: false,
    content_hash: 'hash',
    version: 5,
    created_at: '2026-08-23T02:00:00+00:00',
    updated_at: '2026-08-23T02:00:00+00:00',
    payload: {},
    ui_schema: { fields: [] },
  }

  const html = render(
    createElement(WorkflowCenterPage),
    (client) => {
      client.setQueryData(['studio-workflows'], { items: [detail] })
      client.setQueryData(['studio-workflow', 4], detail)
      client.setQueryData(['cfg-creds', 'workflow'], [])
      client.setQueryData(['cfg-provider-types'], [])
    },
    '/studio/workflows?workflow=4',
  )

  it('导入区说明裸节点图与导出物走同一个口', () => {
    expect(html).toContain('导出的 JSON 都从这里进')
  })

  it('详情面板给出导出与版本历史入口，版本号照实显示', () => {
    expect(html).toContain('导出 JSON')
    expect(html).toContain('版本历史')
    expect(html).toContain('v5')
  })

  it('导出脱敏的口径写在界面上，用户不用自己记得先检查一遍', () => {
    expect(html).toContain('redacted')
    expect(html).toContain('本机绝对路径')
  })
})
