import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { clientProxyConfig, resolveApiBase, type FetchLike } from './api'

test('客户端代理关闭时显式直连，旧授权不扩大到桌面资源', () => {
  for (const policy of [{ enabled: false, scope: 'all' }, { enabled: true, scope: 'selected' }]) {
    assert.deepEqual(clientProxyConfig({ ...policy, address: 'http://127.0.0.1:7890' }), { mode: 'direct' })
  }
})

test('客户端代理包含回环绕过规则', () => {
  assert.deepEqual(clientProxyConfig({ enabled: true, scope: 'all', address: 'http://127.0.0.1:7890' }), {
    mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:7890', proxyBypassRules: 'localhost;127.0.0.0/8;[::1]',
  })
})

interface Call {
  url: string
  init: RequestInit | undefined
}

/** 按 URL 前缀给答复；没配的地址当成连不上（抛错） */
function fakeFetch(routes: Record<string, () => Response>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init })
    const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix))
    if (hit === undefined) throw new TypeError(`fetch failed: ${url}`)
    return hit[1]()
  }
  return { fetch, calls }
}

describe('resolveApiBase', () => {
  test('首选连不上就退到第二个', async () => {
    const { fetch, calls } = fakeFetch({ 'http://127.0.0.1:8100': () => new Response('ok') })
    const base = await resolveApiBase(['http://localhost:8100/', 'http://127.0.0.1:8100'], fetch)
    assert.equal(base, 'http://127.0.0.1:8100')
    assert.deepEqual(
      calls.map((call) => call.url),
      ['http://localhost:8100/healthz', 'http://127.0.0.1:8100/healthz'],
    )
  })

  test('非 200 也算失败', async () => {
    const { fetch } = fakeFetch({
      'http://a': () => new Response('starting', { status: 503 }),
      'http://b': () => new Response('ok'),
    })
    assert.equal(await resolveApiBase(['http://a', 'http://b'], fetch), 'http://b')
  })

  test('全失败时错误里列出试过的地址', async () => {
    const { fetch } = fakeFetch({})
    await assert.rejects(resolveApiBase(['http://a', 'http://b'], fetch), (error: Error) => {
      assert.match(error.message, /http:\/\/a/)
      assert.match(error.message, /http:\/\/b/)
      return true
    })
  })
})
