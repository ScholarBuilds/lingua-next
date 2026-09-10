import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { connectLearningSync, notifyLearningChange, updateLearningData } from './learningSync'

describe('学习状态同步', () => {
  it('保存成功后通知当前窗口与其他窗口，读取请求不发布变更', async () => {
    const peers: { onmessage?: (event: { data: unknown }) => void }[] = []
    vi.stubGlobal('window', new EventTarget())
    vi.stubGlobal('BroadcastChannel', class {
      onmessage?: (event: { data: unknown }) => void
      constructor() { peers.push(this) }
      postMessage(data: unknown) { peers.filter(peer => peer !== this).forEach(peer => peer.onmessage?.({ data })) }
      close() {}
    })
    const clients = [new QueryClient(), new QueryClient()]
    clients.forEach(client => client.setQueryData(['word-stage', 'i'], { stages: { i: 'learning' } }))
    const disconnect = clients.map(connectLearningSync)
    try {
      notifyLearningChange('/api/wordlists/mark', 'GET', { stages: { i: 'hard' } })
      expect(clients[0].getQueryData(['word-stage', 'i'])).toEqual({ stages: { i: 'learning' } })
      notifyLearningChange('/api/wordlists/mark', 'POST', { stages: { i: 'mastered' }, mark: 'mastered' })
      await vi.waitFor(() => clients.forEach(client => expect(client.getQueryData(['word-stage', 'i'])).toEqual({ stages: { i: 'mastered' } })))
    } finally {
      disconnect.forEach(close => close())
      clients.forEach(client => client.clear())
      vi.unstubAllGlobals()
    }
  })
  it('按规范词名更新分页卡片并保留成员与位置', () => {
    const data = { pages: [{ items: [{ word: 'I', mark: null, bucket: 'learning' }, { word: 'by', bucket: 'learning' }] }] }
    const updated = updateLearningData(data, { stages: { i: 'mastered' }, mark: 'mastered' })
    expect(updated).toEqual({ pages: [{ items: [{ word: 'I', mark: 'mastered', bucket: 'mature', difficult: false }, { word: 'by', bucket: 'learning' }] }] })
    expect(data.pages[0].items[0].mark).toBeNull()
  })
  it('同步词卡状态与查词结果，支持撤销人工标记', () => {
    expect(updateLearningData({ stages: { i: 'mastered' } }, { stages: { i: 'learning' } })).toEqual({ stages: { i: 'learning' } })
    expect(updateLearningData({ word: 'I', stage: 'mastered' }, { stages: { i: 'hard' } })).toEqual({ word: 'I', stage: 'hard' })
    expect(updateLearningData({ word: 'I', mark: 'mastered', bucket: 'mature' }, { stages: { i: 'learning' }, mark: null })).toEqual({ word: 'I', mark: null, bucket: 'learning', difficult: false })
  })
})
