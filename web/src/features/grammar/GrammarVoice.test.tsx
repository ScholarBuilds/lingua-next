import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { expect, it, vi } from 'vitest'

vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null }) })

import { SentencePanel } from '../reader/SentencePanel'
import { GrammarVoiceButton } from './GrammarVoice'

it('没有缓存的词本例句仍在面板顶部显示语音入口', () => {
  const query = new QueryClient()
  const html = renderToStaticMarkup(<QueryClientProvider client={query}><MemoryRouter>
    <SentencePanel sel={{ text: 'I wanted coffee, but there was none left in the kitchen.', hash: 'uncached-grammar-voice', sentenceId: 0, paragraphId: 0 }} />
  </MemoryRouter></QueryClientProvider>)
  expect(html).toContain('AI 语音助手')
  expect(html.indexOf('AI 语音助手')).toBeLessThan(html.indexOf('panel-body'))
  expect(html).not.toContain('把这句交给 AI 陪读讲解')
  query.clear()
})

it('有无分析结果都使用相同的明确入口', () => {
  for (const analysis of [undefined, null, { quick: '并列句' }]) {
    const html = renderToStaticMarkup(<GrammarVoiceButton sentence="I wanted coffee." analysis={analysis} source="例句" />)
    expect(html).toContain('AI 语音助手')
    expect(html).not.toContain('disabled')
    expect(html).not.toContain('role="dialog"')
  }
})

it('尚未输入原句时保留入口但禁止创建空上下文', () => {
  const html = renderToStaticMarkup(<GrammarVoiceButton sentence=" " source="句法实验室" />)
  expect(html).toContain('AI 语音助手')
  expect(html).toContain('disabled')
})
