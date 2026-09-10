import { describe, expect, it } from 'vitest'

import type { ModelInvocation } from '@/lib/api-config'

import { formatRate, percentile, summarizeInvocations } from './ledger-summary'

function row(over: Partial<ModelInvocation> = {}): ModelInvocation {
  return {
    id: over.id ?? 'inv-1',
    plugin_id: 'openai',
    plugin_version: null,
    plugin_generation: null,
    runtime_generation: null,
    operation: 'chat.complete',
    capability: null,
    deployment_id: null,
    task_id: null,
    source: null,
    canvas_id: null,
    node_id: null,
    flow_run_id: null,
    tool_id: null,
    request: null,
    response: null,
    provider_request_id: null,
    model: null,
    status: 'succeeded',
    usage: null,
    latency_ms: null,
    first_token_ms: null,
    error_type: null,
    error_message: null,
    error_code: null,
    parent_invocation_id: null,
    attempt: 1,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    reasoning_tokens: null,
    context: null,
    created_at: null,
    finished_at: null,
    ...over,
  }
}

describe('账本汇总', () => {
  it('空账本不编造成功率与 P95', () => {
    const summary = summarizeInvocations([])
    expect(summary).toMatchObject({
      total: 0,
      running: 0,
      successRate: null,
      p95FirstTokenMs: null,
      p95LatencyMs: null,
    })
    expect(summary.byCapability).toEqual([])
    expect(formatRate(summary.successRate)).toBe('—')
  })

  it('成功率只按终态算，进行中的行不进分母', () => {
    const summary = summarizeInvocations([
      row({ id: 'a', status: 'succeeded' }),
      row({ id: 'b', status: 'succeeded' }),
      row({ id: 'c', status: 'failed' }),
      row({ id: 'd', status: 'cancelled' }),
      // 还在跑的两行：分子分母都不算，否则一开新调用成功率就往下掉
      row({ id: 'e', status: 'running' }),
      row({ id: 'f', status: 'running' }),
    ])
    expect(summary.total).toBe(6)
    expect(summary.running).toBe(2)
    expect(summary.succeeded).toBe(2)
    expect(summary.failed).toBe(1)
    expect(summary.successRate).toBeCloseTo(0.5)
    expect(formatRate(summary.successRate)).toBe('50%')
  })

  it('P95 走最近秩，只统计有数的行', () => {
    // 1..20 共 20 个观测：ceil(0.95 × 20) = 19，取第 19 小 = 19
    const values = Array.from({ length: 20 }, (_, index) => index + 1)
    expect(percentile(values, 0.95)).toBe(19)
    // 单个观测时上下界都是它自己
    expect(percentile([42], 0.95)).toBe(42)
    expect(percentile([], 0.95)).toBeNull()

    const summary = summarizeInvocations([
      row({ id: 'a', latency_ms: 900, first_token_ms: 120 }),
      row({ id: 'b', latency_ms: 300, first_token_ms: null }),
      row({ id: 'c', latency_ms: null, first_token_ms: null }),
    ])
    expect(summary.p95LatencyMs).toBe(900)
    // 只有一行记了首 token，P95 就是那一行
    expect(summary.p95FirstTokenMs).toBe(120)
  })

  it('能力缺省回落到 operation，分布按调用量降序且同量按名字定序', () => {
    const summary = summarizeInvocations([
      row({ id: 'a', capability: 'chat-general', model: 'gpt-5' }),
      row({ id: 'b', capability: 'chat-general', model: 'gpt-5' }),
      row({ id: 'c', capability: 'image-free', model: 'nano-banana' }),
      row({ id: 'd', capability: null, operation: 'image.generate', model: null }),
      row({ id: 'e', capability: 'a-first', model: 'zzz' }),
    ])
    expect(summary.byCapability).toEqual([
      { key: 'chat-general', count: 2 },
      { key: 'a-first', count: 1 },
      { key: 'image-free', count: 1 },
      { key: 'image.generate', count: 1 },
    ])
    // model 为 null 的行不进分布，不能渲染成一条叫「null」的模型
    expect(summary.byModel).toEqual([
      { key: 'gpt-5', count: 2 },
      { key: 'nano-banana', count: 1 },
      { key: 'zzz', count: 1 },
    ])
  })

  it('分布按 limit 截断', () => {
    const rows = ['a', 'b', 'c', 'd', 'e', 'f'].map((key, index) =>
      row({ id: key, capability: key, model: key, latency_ms: index }),
    )
    expect(summarizeInvocations(rows, 2).byCapability).toHaveLength(2)
    expect(summarizeInvocations(rows, 6).byModel).toHaveLength(6)
  })
})
