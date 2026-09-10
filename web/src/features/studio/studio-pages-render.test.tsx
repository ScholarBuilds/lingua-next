/* 两个页面的渲染冒烟。
 *
 * 纯函数测试全绿但页面白屏，本仓已经吃过一次（节点定义里的 View 写成非 getter 触发 TDZ）。
 * 这里把工坊首页和账本页真渲染一遍：导入环、初始化顺序、必需的 provider 缺失都会当场炸。
 * 本仓 vitest 跑在 node 环境（没有 jsdom），所以走 renderToStaticMarkup。 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import ModelLabPage from './ModelLabPage'
import StudioHomePage from './StudioHomePage'

function plugin(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    label: id,
    hint: `${id} 的说明`,
    category: 'create',
    status: 'partial',
    route: `/studio/${id}`,
    blueprint: 'ST-01',
    runtime_kind: 'page',
    capabilities: ['image.generate'],
    operation_contracts: {},
    surfaces: ['studio.home'],
    input_schema: {},
    output_schema: {},
    resume_policy: 'none',
    version: '1.0.0',
    generation: 1,
    ...over,
  }
}

function render(node: JSX.Element, seed?: (client: QueryClient) => void): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  seed?.(client)
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(MemoryRouter, null, node)),
  )
}

describe('工坊首页', () => {
  const html = render(createElement(StudioHomePage), (client) => {
    client.setQueryData(['studio-catalog'], {
      enhance_presets: [],
      enhance_note: '',
      tool_categories: [{ id: 'create', label: '创作工具', hint: '' }],
      tools: [
        // beta 走服务端新字段，partial 是迁移期旧值，两种都要能渲染
        plugin('infinite-canvas', { status: 'beta', gap: '组节点还不能嵌套' }),
        plugin('image-console', { status: 'ready' }),
        plugin('enhance', { status: 'partial' }),
        plugin('update-backup', { category: 'connect', status: 'planned', route: null }),
      ],
    })
    client.setQueryData(['studio-tasks'], {
      items: [{ id: 't1', status: 'running', finished_at: null }],
    })
    client.setQueryData(['image-stats'], { count: 128, mb: 12, candidates: 0 })
  })

  it('主力入口用大卡，未做的卡片降调', () => {
    expect(html).toContain('tb-title')
    expect(html).toContain('工坊')
    expect(html).toContain('sth-card-lead')
    expect(html).toContain('sth-card-planned')
  })

  it('有缺口的工具只落一个小圆点，缺口原文进 aria-label', () => {
    expect(html).toContain('sth-dot')
    expect(html).toContain('组节点还不能嵌套')
  })

  it('顶部换成真实近况，不再是迁移进度', () => {
    expect(html).toContain('今天完成')
    expect(html).toContain('128')
    expect(html).not.toContain('蓝本能力')
    expect(html).not.toContain('继续补齐')
  })

  it('迁移期的自曝其短文案与蓝本编号都不上卡面', () => {
    expect(html).not.toContain('基础版')
    expect(html).not.toContain('>ST-01<')
  })
})

describe('模型调用账本', () => {
  it('渲染出标题与试调入口，且不再有任何配置表单', () => {
    const html = render(createElement(ModelLabPage))
    expect(html).toContain('模型调用账本')
    expect(html).toContain('测一下')
    expect(html).not.toContain('添加模型部署')
    expect(html).not.toContain('LoRA')
  })
})
