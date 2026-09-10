import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePrefStore } from '../../lib/prefStore'
import { useWorkspaceStore } from '../../lib/workspaceStore'
import { TalkCoachPanel } from './TalkCoachPanel'
import { TalkScenariosPage } from './TalkScenariosPage'

vi.hoisted(() => {
  vi.stubGlobal('localStorage', { getItem: () => null })
})
vi.mock('./coachQueue', async importOriginal => ({
  ...await importOriginal<typeof import('./coachQueue')>(),
  useCoachStatus: () => 'idle',
}))
vi.mock('../../lib/workspaceStore', async importOriginal => {
  const actual = await importOriginal<typeof import('../../lib/workspaceStore')>()
  return { ...actual, useWorkspaceStore: Object.assign(
    <T,>(selector: (state: ReturnType<typeof actual.useWorkspaceStore.getState>) => T) => selector(actual.useWorkspaceStore.getState()),
    actual.useWorkspaceStore,
  ) }
})
vi.mock('../../lib/prefStore', async importOriginal => {
  const actual = await importOriginal<typeof import('../../lib/prefStore')>()
  return { ...actual, usePrefStore: Object.assign(
    <T,>(selector: (state: ReturnType<typeof actual.usePrefStore.getState>) => T) => selector(actual.usePrefStore.getState()),
    actual.usePrefStore,
  ) }
})

const scenarios = [
  { key: 'airport', title: '机场值机', title_en: 'Airport Check-in', level: 'B1', goal: '办理值机', role_ai: '柜台职员', role_user: '旅客', is_builtin: true },
  { key: 'directions', title: '问路', title_en: 'Directions', level: 'A2', goal: '找到车站', role_ai: '本地人', role_user: '游客', is_builtin: true },
]

function renderLibrary(route: string) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
  client.setQueryData(['talk-scenarios'], scenarios)
  client.setQueryData(['talk-sessions'], [])
  client.setQueryData(['cfg-model-deployments', 'talk-realtime'], [])
  return renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter initialEntries={[route]}><TalkScenariosPage /></MemoryRouter></QueryClientProvider>)
}

describe('对话入口与助手可见性', () => {
  const originalTalk = usePrefStore.getState().prefs.talk
  beforeEach(() => {
    vi.stubGlobal('localStorage', { getItem: () => null })
    useWorkspaceStore.setState({ records: { 'talk:favorite-scenes': { expanded: ['airport'] }, 'talk:recent-scenes': { expanded: ['directions', 'airport'] } } })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    usePrefStore.setState(s => ({ prefs: { ...s.prefs, talk: originalTalk } }))
  })

  it('只列出同时匹配关键词、等级和收藏的场景', () => {
    const html = renderLibrary('/talk?q=%20旅客%20&level=B1&filter=favorite')
    expect(html).toContain('预览机场值机')
    expect(html).not.toContain('预览问路')
    expect(html).toContain('清除筛选')
  })

  it('没有结果时仍提供清除条件与新建入口', () => {
    const html = renderLibrary('/talk?q=missing&filter=favorite')
    expect(html).not.toContain('aria-label="预览')
    expect(html).toContain('没有匹配的场景')
    expect(html).toContain('查看全部场景')
    expect(html).toContain('新建场景')
  })

  it('最近使用按实际顺序排列，不混入未使用的自由话题卡', () => {
    const html = renderLibrary('/talk?filter=recent')
    expect(html.indexOf('预览问路')).toBeLessThan(html.indexOf('预览机场值机'))
    expect(html).not.toContain('预览自由话题')
  })

  it('空记录页可返回场景，不显示无关练习设置', () => {
    const html = renderLibrary('/talk?tab=history')
    expect(html).toContain('选择场景')
    expect(html).not.toContain('aria-label="练习设置"')
  })

  it('实时助手默认展开两个学习区，文字模式尊重已有折叠偏好', () => {
    usePrefStore.setState(s => ({ prefs: { ...s.prefs, talk: { ...s.prefs.talk, translationOpen: false, repliesOpen: false } } }))
    const client = new QueryClient()
    const render = (realtime: boolean) => renderToStaticMarkup(<QueryClientProvider client={client}><TalkCoachPanel sessionId={null} assistantText="Hello there." realtime={realtime} /></QueryClientProvider>)
    expect(render(true).match(/class="coach-section" open=""/g)).toHaveLength(2)
    expect(render(false)).not.toContain('class="coach-section" open=""')
    expect(render(true)).toContain('对方原句')
  })
})
