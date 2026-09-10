/* 连接器页的渲染冒烟：三种态各渲染一次，顺带钉住引导展开与路径展示。
   本仓 vitest 跑在 node 环境（没有 jsdom），所以走 renderToStaticMarkup。 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import ConnectorSetupPage from './ConnectorSetupPage'
import type { ConnectorStatus } from './connectorStatus'

function connector(id: string, over: Partial<ConnectorStatus> = {}): ConnectorStatus {
  const chrome = id === 'chrome'
  const dir = chrome
    ? '/srv/lingua/tools/chrome-local-asset-importer'
    : '/srv/lingua/tools/photoshop-asset-connector'
  return {
    id,
    tool_id: chrome ? 'chrome-collector' : 'photoshop-connector',
    label: chrome ? '浏览器素材采集扩展' : 'Photoshop 画布面板',
    host_hint: chrome ? 'Chrome / Edge 开发者模式加载已解压目录' : 'UXP Developer Tool 加载',
    state: 'unknown',
    state_note: '本次服务启动后没收到过它的信号，装没装、开没开都判不出来',
    last_seen_at: null,
    seen_seconds_ago: null,
    version: '',
    channel: '',
    source_dir: dir,
    source_dir_exists: true,
    entry_path: `${dir}/manifest.json`,
    entry_exists: true,
    package_path: '/srv/lingua/tools/dist/lingua-chrome-collector.zip',
    package_exists: false,
    package_built_at: null,
    ...over,
  }
}

function render(connectors: ConnectorStatus[]): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['studio-connector-status'], {
    checked_at: '2026-08-23T08:00:00+00:00',
    online_window_s: 120,
    package_command: 'python3 tools/package_connectors.py',
    connectors,
  })
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(MemoryRouter, null, createElement(ConnectorSetupPage)),
    ),
  )
}

describe('连接器页', () => {
  it('没收到过信号时说判不了，并把引导展开', () => {
    const html = render([connector('chrome'), connector('photoshop')])

    expect(html).toContain('判不了')
    // 「已连接」在正文里出现过，所以只认状态标记本身
    expect(html).not.toContain('stc-badge-connected')
    expect(html).not.toContain('stc-badge-disconnected')
    expect(html).toContain('<details class="stc-guide" open')
    expect(html).toContain('chrome://extensions')
    // 目录不让用户自己猜，绝对路径直接摆出来
    expect(html).toContain('/srv/lingua/tools/chrome-local-asset-importer')
    expect(html).toContain('/srv/lingua/tools/photoshop-asset-connector/manifest.json')
  })

  it('连上了就收起引导，标记走 connected 档', () => {
    const html = render([
      connector('chrome', { state: 'connected', state_note: '8 秒前刚通过一次消息' }),
    ])

    expect(html).toContain('stc-badge-connected')
    expect(html).toContain('8 秒前刚通过一次消息')
    expect(html).not.toContain('<details class="stc-guide" open')
  })

  it('掉线时展开引导，并把服务端给的原因原样带出来', () => {
    const html = render([
      connector('photoshop', {
        state: 'disconnected',
        state_note: '最后一次通信在 12 分钟前，现在没连着',
      }),
    ])

    expect(html).toContain('stc-badge-disconnected')
    expect(html).toContain('最后一次通信在 12 分钟前，现在没连着')
    expect(html).toContain('<details class="stc-guide" open')
  })

  it('没打过分发包就把打包命令写出来', () => {
    const html = render([connector('chrome')])

    expect(html).toContain('python3 tools/package_connectors.py')
  })
})
