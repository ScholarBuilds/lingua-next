import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from './api'

afterEach(() => vi.unstubAllGlobals())

it('切换查询取消旧网络请求，结果只属于当前关键词', async () => {
  const signals: AbortSignal[] = []
  vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
    const signal = init.signal as AbortSignal
    signals.push(signal)
    if (signals.length === 1) return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')))
    })
    return Promise.resolve(Response.json({ ready: true, q: 'permission' }))
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const options = (q: string) => ({ queryKey: ['dict-search', q], queryFn: ({ signal }: { signal: AbortSignal }) => api.dictSearch(q, signal) })
  const observer = new QueryObserver(client, options('per'))
  const unsubscribe = observer.subscribe(() => {})
  observer.setOptions(options('permission'))
  await vi.waitFor(() => expect(observer.getCurrentResult().data?.q).toBe('permission'))
  expect(signals[0].aborted).toBe(true)
  expect(signals[1].aborted).toBe(false)
  expect(observer.getCurrentResult().error).toBeNull()
  unsubscribe()
  client.clear()
})
