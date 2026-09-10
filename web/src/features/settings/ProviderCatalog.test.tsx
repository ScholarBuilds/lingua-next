import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PropsWithChildren } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { Credential } from '../../lib/api-config'
import { ProviderCatalog } from './ProviderCatalog'

vi.mock('@/components/ui/dialog', () => {
  const Container = ({ children }: PropsWithChildren) => <div>{children}</div>
  return { Dialog: Container, DialogContent: Container, DialogHeader: Container, DialogTitle: Container }
})

const credential: Credential = {
  id: 1, name: 'Speech', kind: 'tts', provider_type: 'azure_speech', enabled: true,
  status: 'untested', status_detail: null, last_tested_at: null, masked: {},
  models: [], models_count: 0, models_refreshed_at: null,
}

function render(models: unknown[]) {
  return renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>
    <ProviderCatalog credential={{ ...credential, models }} onClose={() => {}} />
  </QueryClientProvider>)
}

it('keeps a bounded first page for a multilingual voice directory', () => {
  const models = Array.from({ length: 45 }, (_, index) => ({
    id: `voice-${index}`, label: `Voice ${index}`, locale: index % 2 ? 'ja-JP' : 'en-US', gender: 'Female',
  }))
  const html = render(models)
  expect(html.match(/>测延迟</g)).toHaveLength(20)
  expect(html).toContain('voice-19')
  expect(html).not.toContain('voice-20')
  expect(html).toContain('ja-JP')
  expect(html).toContain('下一页')
  expect(html).toContain('搜索目录')
})

it('offers directory refresh when a provider has no cached voices', () => {
  const html = render([])
  expect(html).toContain('从供应商刷新')
  expect(html).toContain('目录尚未拉取')
  expect(html).not.toContain('试听并测延迟')
})
