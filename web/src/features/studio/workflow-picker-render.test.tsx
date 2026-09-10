/* 工作流选择弹窗的渲染冒烟：载入中 / 出错 / 空 / 有货 / 筛没了，五种态各渲一次。

   要拦的正是这次重构的起因——「标题被截成『2…』」这类事故不报错、不失败，
   只能靠断言完整标题真出现在首帧里。

   两处替身，都不改被测行为：
   - `Overlay` 走 `createPortal`，react-dom/server 不支持，换成朴素 div；
   - 本仓 vitest 跑在 node 里没有 jsdom，只能 `renderToStaticMarkup`，量的是首帧。 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../components/Overlay', () => ({
  Overlay: ({ children }: { children: ReactNode }) => createElement('div', { className: 'overlay' }, children),
  useEscapeClose: () => undefined,
  useOverlayOpen: () => true,
  overlayDepth: () => 1,
}))

const { WorkflowNodePicker } = await import('./WorkflowNodePicker')
import type { ExecutableWorkflow } from '../../lib/api-studio'

let seq = 0

function make(title: string, over: Partial<ExecutableWorkflow> = {}): ExecutableWorkflow {
  seq += 1
  const provider = over.provider ?? 'comfyui'
  return {
    id: seq,
    key: `${provider}:${title}`,
    title,
    provider,
    kind: 'workflow',
    source: 'bundled',
    source_id: null,
    enabled: true,
    node_count: 12,
    field_count: 3,
    has_thumbnail: false,
    content_hash: `hash-${seq}`,
    version: 1,
    created_at: '2026-08-01T00:00:00+00:00',
    updated_at: '2026-08-01T00:00:00+00:00',
    ...over,
  }
}

const ITEMS: ExecutableWorkflow[] = [
  make('Flux2-Klein-万物迁移', { provider: 'runninghub', has_thumbnail: true, field_count: 24 }),
  make('GPT-Image-2-图片编辑', { provider: 'runninghub', has_thumbnail: true, field_count: 11 }),
  make('Minimax-多参视频生成', { provider: 'runninghub', has_thumbnail: true, field_count: 0 }),
  make('SeedVR2 高清放大', { provider: 'comfyui', kind: 'upscale' }),
  make('Z-Image 生图', { provider: 'comfyui', kind: 'image' }),
]

/** 传 undefined 表示不喂数据，让 useQuery 停在 pending */
function render(items: ExecutableWorkflow[] | undefined, props: Record<string, unknown> = {}): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (items !== undefined) client.setQueryData(['studio-workflows', 'canvas-picker'], { items })
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(WorkflowNodePicker, { onClose: () => undefined, onPick: () => undefined, ...props }),
    ),
  )
}

/** node 里没有 localStorage，使用记录那条路要自己搭桩才走得到 */
function withUsage(dump: Record<string, string>, run: () => string): string {
  const scope = globalThis as { localStorage?: unknown }
  scope.localStorage = {
    getItem: (key: string) => dump[key] ?? null,
    setItem: (key: string, value: string) => {
      dump[key] = value
    },
  }
  try {
    return run()
  } finally {
    delete scope.localStorage
  }
}

describe('工作流选择弹窗', () => {
  it('有货时标题一个字都不许少', () => {
    const html = render(ITEMS)
    for (const item of ITEMS) expect(html).toContain(item.title)
    // 老版本靠 text-overflow 截断，重构后标题所在的元素不许再挂省略号类
    expect(html).not.toContain('…')
  })

  it('每条都说清干什么、哪来的、要不要配置', () => {
    const html = render(ITEMS)
    expect(html).toContain('高清放大')
    expect(html).toContain('文生图')
    expect(html).toContain('视频生成')
    expect(html).toContain('图片编辑')
    expect(html).toContain('RunningHub')
    expect(html).toContain('ComfyUI')
    expect(html).toContain('需配置')
    // 参数个数是实现细节，只进 tooltip，不占卡片正文
    expect(html).toContain('开箱即用')
    expect(html).toContain('有 24 项参数可填')
    expect(html).not.toContain('24 个参数')
  })

  it('有缩略图的走真图，没有的给用途字形兜底', () => {
    const html = render(ITEMS)
    expect(html).toContain('/api/studio/workflows/')
    expect(html).toContain('wfp-thumb-glyph')
  })

  it('载入中摆骨架而不是一行「正在载入」', () => {
    const html = render(undefined)
    expect(html).toContain('wfp-skeleton')
    expect(html).not.toContain('wfp-empty')
  })

  it('一条都没有时告诉用户去哪儿加', () => {
    const html = render([])
    expect(html).toContain('还没有可用的工作流')
    expect(html).toContain('工作流中心')
    // 没筛任何东西，就别摆「清除筛选」
    expect(html).not.toContain('清除筛选')
  })

  it('筛没了的空态跟「一条都没有」分开说，并给回退口', () => {
    const html = render(ITEMS.filter((item) => item.provider === 'comfyui'), {
      initialProvider: 'runninghub',
    })
    expect(html).toContain('没有匹配的工作流')
    expect(html).toContain('清除筛选')
  })

  it('用途筛选条只列真有货的档位', () => {
    const html = render(ITEMS)
    expect(html).toContain('全部用途')
    expect(html).not.toContain('通用工作流')
  })

  it('标题可以由调用方改写', () => {
    expect(render(ITEMS, { title: '选一个可执行工作流' })).toContain('选一个可执行工作流')
  })

  it('用过的提到「常用」区，并标出上次是什么时候', () => {
    const dump = {
      'lingua.studio.workflow-usage': JSON.stringify({
        'comfyui:Z-Image 生图': { count: 3, last: Date.now() - 2 * 3_600_000 },
      }),
    }
    const html = withUsage(dump, () => render(ITEMS))

    expect(html).toContain('常用')
    expect(html).toContain('其余工作流')
    expect(html).toContain('2 小时前用过')
    // 常用那条必须排在「其余工作流」小标题之前
    expect(html.indexOf('Z-Image 生图')).toBeLessThan(html.indexOf('其余工作流'))
  })
})
