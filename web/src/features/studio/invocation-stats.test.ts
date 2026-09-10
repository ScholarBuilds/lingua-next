/* 账本 Timing 折叠：TTFT、解码速率、工具片段跨度全从事件的 elapsed_ms 派生；
   输出拼接按 seq 而不是数组顺序。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ModelInvocation, ModelInvocationEvent } from '@/lib/api-config'

import {
  assembleOutput,
  foldInvocationTiming,
  formatMs,
  formatTokens,
  requestHeader,
} from './invocation-stats'

function event(
  seq: number,
  type: string,
  data: Record<string, unknown>,
): ModelInvocationEvent {
  return { id: seq, invocation_id: 'inv', seq, type, time: null, data }
}

const ROW = {
  id: 'inv',
  status: 'succeeded',
  latency_ms: 1300,
  output_tokens: 80,
} as unknown as ModelInvocation

describe('foldInvocationTiming', () => {
  it('从 finish 与分块事件折出 TTFT、总耗时与解码速率', () => {
    const events = [
      event(1, 'request.header', { elapsed_ms: 0 }),
      event(2, 'chunk.reasoning', { text: 'mull', chars: 4, elapsed_ms: 120, end_ms: 180 }),
      event(3, 'chunk.text', { text: 'Hello, ', chars: 7, elapsed_ms: 200, end_ms: 500 }),
      event(4, 'chunk.text', { text: 'world', chars: 5, elapsed_ms: 500, end_ms: 900 }),
      event(5, 'chunk.usage', { usage: { input_tokens: 10, output_tokens: 50 }, elapsed_ms: 905 }),
      event(6, 'finish', { elapsed_ms: 950, first_token_ms: 120, usage: { output_tokens: 52 } }),
    ]
    const timing = foldInvocationTiming(events, ROW)
    expect(timing.ttftMs).toBe(120)
    expect(timing.totalMs).toBe(950)
    expect(timing.lastChunkMs).toBe(900)
    expect(timing.outputChars).toBe(12)
    expect(timing.reasoningChars).toBe(4)
    expect(timing.chunkCount).toBe(3)
    // finish 里的用量优先于 chunk.usage
    expect(timing.outputTokens).toBe(52)
    // 52 tok / 0.78 s
    expect(timing.decodeTokPerSec).toBeCloseTo(66.7, 1)
    expect(timing.decodeCharsPerSec).toBeCloseTo(15.4, 1)
    expect(timing.toolCalls).toBe(0)
    expect(timing.toolSpanMs).toBeNull()
    expect(timing.phases.map((p) => p.key)).toEqual(['ttft', 'decode', 'tail'])
    expect(timing.phases[2]).toMatchObject({ startMs: 900, endMs: 950 })
  })

  it('没有 finish 时退回首个分块与台账行', () => {
    const events = [
      event(1, 'request.header', { elapsed_ms: 0 }),
      event(2, 'chunk.text', { text: 'partial', chars: 7, elapsed_ms: 300, end_ms: 300 }),
    ]
    const timing = foldInvocationTiming(events, ROW)
    expect(timing.ttftMs).toBe(300)
    expect(timing.totalMs).toBe(1300)
    expect(timing.outputTokens).toBe(80)
    // 解码跨度为 0：速率不可算
    expect(timing.decodeTokPerSec).toBeNull()
    expect(timing.decodeCharsPerSec).toBeNull()
    expect(timing.phases.map((p) => p.key)).toEqual(['ttft', 'tail'])
  })

  it('工具片段按首末 tool_delta 计跨度，同一调用的多段只算一次', () => {
    const events = [
      event(1, 'chunk.tool_delta', { index: 0, id: 'call-1', name: 'generate_image', arguments_delta: '{"p', elapsed_ms: 400 }),
      event(2, 'chunk.tool_delta', { index: 0, arguments_delta: 'rompt":1}', elapsed_ms: 640 }),
      event(3, 'chunk.tool_delta', { index: 1, id: 'call-2', name: 'search', arguments_delta: '{}', elapsed_ms: 700 }),
      event(4, 'error', { elapsed_ms: 800, first_token_ms: 400, error_code: 'TIMEOUT' }),
    ]
    const timing = foldInvocationTiming(events, null)
    expect(timing.toolCalls).toBe(2)
    expect(timing.toolSpanMs).toBe(300)
    expect(timing.ttftMs).toBe(400)
    expect(timing.totalMs).toBe(800)
    expect(timing.phases.map((p) => p.key)).toEqual(['ttft', 'decode', 'tool', 'tail'])
  })

  it('空事件串只剩台账行的数字', () => {
    const timing = foldInvocationTiming([], ROW)
    expect(timing.ttftMs).toBeNull()
    expect(timing.totalMs).toBe(1300)
    expect(timing.outputTokens).toBe(80)
    expect(timing.phases).toEqual([])
  })
})

describe('assembleOutput / requestHeader', () => {
  it('按 seq 拼回正文、推理与工具参数', () => {
    const events = [
      event(4, 'chunk.tool_delta', { index: 0, arguments_delta: 'rompt":1}' }),
      event(2, 'chunk.text', { text: 'Hel' }),
      event(3, 'chunk.tool_delta', { index: 0, id: 'call-1', name: 'generate_image', arguments_delta: '{"p' }),
      event(1, 'request.header', { messages: [{ role: 'user', content: 'hi' }] }),
      event(5, 'chunk.text', { text: 'lo' }),
      event(6, 'chunk.reasoning', { text: 'think' }),
    ]
    const output = assembleOutput(events)
    expect(output.text).toBe('Hello')
    expect(output.reasoning).toBe('think')
    expect(output.toolCalls).toEqual([
      { index: 0, id: 'call-1', name: 'generate_image', arguments: '{"prompt":1}' },
    ])
    expect(requestHeader(events)).toEqual({ messages: [{ role: 'user', content: 'hi' }] })
    expect(requestHeader([])).toBeNull()
  })
})

describe('格式化', () => {
  it('毫秒与 token 的短格式', () => {
    expect(formatMs(null)).toBe('—')
    expect(formatMs(420)).toBe('420 ms')
    expect(formatMs(1234)).toBe('1.23 s')
    expect(formatMs(12_345)).toBe('12.3 s')
    expect(formatTokens(null)).toBe('—')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1234)).toBe('1.2k')
    expect(formatTokens(12_345)).toBe('12k')
  })
})

/* 账本实时帧订阅：只听 `invocation` 帧，after 取最大安全整数让服务端不回放任务事件；
   订阅者归零关闭连接。测试跑在 node 里，EventSource 自己搭桩。 */

type Handler = (event: { data: string }) => void

class FakeEventSource {
  static instances: FakeEventSource[] = []
  closed = false
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  private readonly handlers = new Map<string, Set<Handler>>()

  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, handler: Handler): void {
    const set = this.handlers.get(type) ?? new Set<Handler>()
    set.add(handler)
    this.handlers.set(type, set)
  }

  close(): void {
    this.closed = true
  }

  emit(type: string, data: string): void {
    for (const handler of this.handlers.get(type) ?? []) handler({ data })
  }
}

describe('subscribeInvocationFrames', () => {
  const g = globalThis as Record<string, unknown>

  beforeEach(() => {
    FakeEventSource.instances = []
    g.EventSource = FakeEventSource
    vi.resetModules()
  })

  afterEach(() => {
    delete g.EventSource
  })

  it('只分发合法的 invocation 帧，退订后关闭连接', async () => {
    const { subscribeInvocationFrames } = await import('@/lib/api-config')
    const seen: string[] = []
    const unsubscribe = subscribeInvocationFrames((row) => seen.push(`${row.id}:${row.status}`))
    expect(FakeEventSource.instances).toHaveLength(1)
    const source = FakeEventSource.instances[0]
    expect(source.url).toBe(`/api/studio/tasks/events/stream?after=${Number.MAX_SAFE_INTEGER}`)

    source.emit('invocation', JSON.stringify({ id: 'inv-1', status: 'running', plugin_id: 'openai' }))
    source.emit('invocation', JSON.stringify({ id: 'inv-1', status: 'succeeded', plugin_id: 'openai' }))
    // 畸形帧与别的帧类型都不该打断后续分发
    source.emit('invocation', '{not json')
    source.emit('invocation', JSON.stringify({ cursor: 3, task_id: 't' }))
    source.emit('task', JSON.stringify({ cursor: 3, task_id: 't' }))
    expect(seen).toEqual(['inv-1:running', 'inv-1:succeeded'])

    // 第二个订阅者复用同一条连接
    const unsubscribeOther = subscribeInvocationFrames(() => undefined)
    expect(FakeEventSource.instances).toHaveLength(1)
    unsubscribeOther()
    expect(source.closed).toBe(false)
    unsubscribe()
    expect(source.closed).toBe(true)
  })

  it('断线后按退避重建', async () => {
    vi.useFakeTimers()
    try {
      const { subscribeInvocationFrames } = await import('@/lib/api-config')
      const unsubscribe = subscribeInvocationFrames(() => undefined)
      const first = FakeEventSource.instances[0]
      first.onerror?.()
      expect(first.closed).toBe(true)
      expect(FakeEventSource.instances).toHaveLength(1)
      vi.advanceTimersByTime(1000)
      expect(FakeEventSource.instances).toHaveLength(2)
      FakeEventSource.instances[1].onerror?.()
      vi.advanceTimersByTime(1999)
      expect(FakeEventSource.instances).toHaveLength(2)
      vi.advanceTimersByTime(1)
      expect(FakeEventSource.instances).toHaveLength(3)
      unsubscribe()
      expect(FakeEventSource.instances[2].closed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
