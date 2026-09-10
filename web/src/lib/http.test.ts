import { afterEach, expect, it, vi } from 'vitest'
import { HttpError, requestJson } from './http'
import { ApiDeckError, request } from './api-deck'

afterEach(() => vi.unstubAllGlobals())
it('写请求响应丢失只发送一次，由业务层决定幂等重试', async () => {
  const fetch = vi.fn().mockRejectedValue(new TypeError('offline'))
  vi.stubGlobal('fetch', fetch)
  await expect(requestJson('/api/score', { method: 'POST', body: '{}' })).rejects.toMatchObject({ status: 0 })
  expect(fetch).toHaveBeenCalledTimes(1)
})
it('保留领域错误类型与结构化冲突详情', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ detail: { message: '版本冲突', version: 3 } }, { status: 409 })))
  const error = await request('/api/wordlists/test').catch(error => error)
  expect(error).toBeInstanceOf(ApiDeckError)
  expect(error).toMatchObject({ status: 409, message: '版本冲突', detail: { version: 3 } })
})
it('参数错误提取解释，空响应和坏 JSON 明确区分', async () => {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(Response.json({ detail: [{ msg: '字段不能为空', input: 'private' }] }, { status: 422 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(new Response('<html>unavailable</html>')))
  await expect(requestJson('/api/a')).rejects.toMatchObject({ message: '字段不能为空' })
  await expect(requestJson('/api/a')).resolves.toBeUndefined()
  await expect(requestJson('/api/a')).rejects.toBeInstanceOf(HttpError)
})
it('取消请求不改写为网络故障', async () => {
  const error = new DOMException('cancelled', 'AbortError')
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error))
  await expect(requestJson('/api/a')).rejects.toBe(error)
})
