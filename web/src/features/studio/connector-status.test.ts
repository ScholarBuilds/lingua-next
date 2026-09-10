import { describe, expect, it } from 'vitest'

import {
  connectorBadge,
  connectorState,
  connectorSteps,
  connectorVerifyHint,
  packageLine,
  shouldExpandGuide,
} from './connectorStatus'
import type { ConnectorStatus } from './connectorStatus'

function status(over: Partial<ConnectorStatus> = {}): ConnectorStatus {
  return {
    id: 'chrome',
    tool_id: 'chrome-collector',
    label: '浏览器素材采集扩展',
    host_hint: 'Chrome / Edge 开发者模式加载已解压目录',
    state: 'unknown',
    state_note: '本次服务启动后没收到过它的信号',
    last_seen_at: null,
    seen_seconds_ago: null,
    version: '',
    channel: '',
    source_dir: '/srv/lingua/tools/chrome-local-asset-importer',
    source_dir_exists: true,
    entry_path: '/srv/lingua/tools/chrome-local-asset-importer/manifest.json',
    entry_exists: true,
    package_path: '/srv/lingua/tools/dist/lingua-chrome-collector.zip',
    package_exists: false,
    package_built_at: null,
    ...over,
  }
}

describe('连接状态归一', () => {
  it('三种态各归各位', () => {
    expect(connectorState('connected')).toBe('connected')
    expect(connectorState('disconnected')).toBe('disconnected')
    expect(connectorState('unknown')).toBe('unknown')
  })

  it('服务端将来加档位时兜成判不了，不许假装连上', () => {
    expect(connectorState('degraded')).toBe('unknown')
    expect(connectorState('')).toBe('unknown')
  })

  it('判不了的文案不写成未连接：没装和没开是两回事', () => {
    expect(connectorBadge(status()).text).toBe('判不了')
    expect(connectorBadge(status({ state: 'disconnected' })).text).toBe('未连接')
    expect(connectorBadge(status({ state: 'connected' })).text).toBe('已连接')
  })
})

describe('引导展开时机', () => {
  it('连上了就收起来，其余两种态都展开', () => {
    expect(shouldExpandGuide(status({ state: 'connected' }))).toBe(false)
    expect(shouldExpandGuide(status({ state: 'disconnected' }))).toBe(true)
    expect(shouldExpandGuide(status())).toBe(true)
  })
})

describe('安装步骤', () => {
  it('Chrome 三步逐条写明点哪里，目录用后端给的绝对路径', () => {
    const steps = connectorSteps(status())

    expect(steps).toHaveLength(3)
    expect(steps[0].text).toContain('chrome://extensions')
    expect(steps[0].copy).toBe('chrome://extensions')
    expect(steps[1].text).toContain('开发者模式')
    expect(steps[2].text).toContain('加载已解压的扩展程序')
    expect(steps[2].copy).toBe('/srv/lingua/tools/chrome-local-asset-importer')
  })

  it('Photoshop 指到 UXP Developer Tool 和真实 manifest.json', () => {
    const steps = connectorSteps(status({ id: 'photoshop' }))

    expect(steps).toHaveLength(3)
    expect(steps[0].text).toContain('UXP Developer Tool')
    expect(steps[1].text).toContain('Add Plugin')
    expect(steps[1].copy).toBe('/srv/lingua/tools/chrome-local-asset-importer/manifest.json')
    expect(steps[2].text).toContain('Load')
  })

  it('目录不存在就不给复制按钮，也不假装路径可用', () => {
    const steps = connectorSteps(status({ source_dir_exists: false, entry_exists: false }))

    expect(steps[2].copy).toBeUndefined()
    expect(connectorSteps(status({ id: 'photoshop', entry_exists: false }))[1].copy).toBeUndefined()
  })

  it('第四句是验收提示，不占编号，免得和「三步装完」打架', () => {
    expect(connectorVerifyHint(status())).toContain('点扩展图标')
    expect(connectorVerifyHint(status({ id: 'photoshop' }))).toContain('面板设置')
  })
})

describe('分发包提示', () => {
  it('没打过包就直接给命令', () => {
    expect(packageLine(status(), 'python3 tools/package_connectors.py')).toContain(
      'python3 tools/package_connectors.py',
    )
  })

  it('打过包就给绝对路径和日期', () => {
    const line = packageLine(
      status({ package_exists: true, package_built_at: '2026-08-23T08:57:49+00:00' }),
      'python3 tools/package_connectors.py',
    )

    expect(line).toContain('/srv/lingua/tools/dist/lingua-chrome-collector.zip')
    expect(line).toContain('2026-08-23')
  })
})
