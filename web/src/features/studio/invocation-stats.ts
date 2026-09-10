/* 账本检视器的纯计算：把一次调用的事件串折成 Timing 指标与可读输出。
   事件里的 elapsed_ms 都相对调用起点，首 token / 解码速率 / 工具片段全从它派生，不另信任列。 */

import type { ModelInvocation, ModelInvocationEvent } from '@/lib/api-config'

export interface TimingPhase {
  key: 'ttft' | 'decode' | 'tool' | 'tail'
  label: string
  startMs: number
  endMs: number
}

export interface InvocationTiming {
  /** 首 token 时延：finish / error 记录的 first_token_ms，缺省取首个输出分块的 elapsed_ms */
  ttftMs: number | null
  /** 总耗时：finish / error 的 elapsed_ms，缺省取台账行 latency_ms */
  totalMs: number | null
  /** 最后一个输出分块（文本 / 推理 / 工具）落下的时刻 */
  lastChunkMs: number | null
  outputChars: number
  reasoningChars: number
  outputTokens: number | null
  /** 解码速率 tok/s = output_tokens ÷ (最后分块 − 首 token)；同一批到齐（跨度为 0）时为 null */
  decodeTokPerSec: number | null
  /** 没有 token 数时的退路：可见字符 ÷ 秒 */
  decodeCharsPerSec: number | null
  toolCalls: number
  /** 工具调用片段跨度：首个 tool_delta → 最后一个 tool_delta */
  toolSpanMs: number | null
  chunkCount: number
  phases: TimingPhase[]
}

export interface AssembledToolCall {
  index: number
  id: string | null
  name: string | null
  arguments: string
}

export interface AssembledOutput {
  text: string
  reasoning: string
  toolCalls: AssembledToolCall[]
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function data(event: ModelInvocationEvent): Record<string, unknown> {
  return event.data ?? {}
}

function usageOutputTokens(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) return null
  return num((value as Record<string, unknown>).output_tokens)
}

const CHUNK_TYPES = new Set(['chunk.text', 'chunk.reasoning', 'chunk.tool_delta'])

export function foldInvocationTiming(
  events: ModelInvocationEvent[],
  row: ModelInvocation | null = null,
): InvocationTiming {
  const ordered = [...events].sort((a, b) => a.seq - b.seq)
  let ttftMs: number | null = null
  let totalMs: number | null = null
  let lastChunkMs: number | null = null
  let firstChunkMs: number | null = null
  let outputChars = 0
  let reasoningChars = 0
  let outputTokens: number | null = null
  let toolCalls = 0
  let toolFirstMs: number | null = null
  let toolLastMs: number | null = null
  let chunkCount = 0
  // 工具调用按 index 归并：只有首个 delta 带 id / name，后续片段只带 index
  const toolIndexes = new Set<number>()

  for (const event of ordered) {
    const d = data(event)
    const at = num(d.elapsed_ms)
    const end = num(d.end_ms) ?? at
    if (CHUNK_TYPES.has(event.type)) {
      chunkCount += 1
      if (at !== null) firstChunkMs = firstChunkMs === null ? at : Math.min(firstChunkMs, at)
      if (end !== null) lastChunkMs = lastChunkMs === null ? end : Math.max(lastChunkMs, end)
    }
    switch (event.type) {
      case 'chunk.text':
        outputChars += num(d.chars) ?? str(d.text).length
        break
      case 'chunk.reasoning':
        reasoningChars += num(d.chars) ?? str(d.text).length
        break
      case 'chunk.tool_delta': {
        const index = num(d.index) ?? 0
        if (!toolIndexes.has(index)) {
          toolIndexes.add(index)
          toolCalls += 1
        }
        if (at !== null) {
          toolFirstMs = toolFirstMs === null ? at : Math.min(toolFirstMs, at)
          toolLastMs = toolLastMs === null ? at : Math.max(toolLastMs, at)
        }
        break
      }
      case 'chunk.usage':
        outputTokens = usageOutputTokens(d.usage) ?? outputTokens
        break
      case 'finish':
      case 'error':
        ttftMs = num(d.first_token_ms) ?? ttftMs
        totalMs = num(d.elapsed_ms) ?? totalMs
        outputTokens = usageOutputTokens(d.usage) ?? outputTokens
        break
      default:
        break
    }
  }

  if (ttftMs === null) ttftMs = firstChunkMs
  if (totalMs === null) totalMs = row?.latency_ms ?? null
  if (outputTokens === null) outputTokens = row?.output_tokens ?? null

  const decodeSpanMs =
    ttftMs !== null && lastChunkMs !== null && lastChunkMs > ttftMs ? lastChunkMs - ttftMs : null
  const decodeTokPerSec =
    decodeSpanMs !== null && outputTokens !== null && outputTokens > 0
      ? Math.round((outputTokens / (decodeSpanMs / 1000)) * 10) / 10
      : null
  const decodeCharsPerSec =
    decodeSpanMs !== null && outputChars > 0
      ? Math.round((outputChars / (decodeSpanMs / 1000)) * 10) / 10
      : null
  const toolSpanMs = toolFirstMs !== null && toolLastMs !== null ? toolLastMs - toolFirstMs : null

  const phases: TimingPhase[] = []
  if (ttftMs !== null && ttftMs > 0) {
    phases.push({ key: 'ttft', label: '等待首 token', startMs: 0, endMs: ttftMs })
  }
  if (decodeSpanMs !== null && ttftMs !== null && lastChunkMs !== null) {
    phases.push({ key: 'decode', label: '解码', startMs: ttftMs, endMs: lastChunkMs })
  }
  if (toolSpanMs !== null && toolSpanMs > 0 && toolFirstMs !== null && toolLastMs !== null) {
    phases.push({ key: 'tool', label: '工具片段', startMs: toolFirstMs, endMs: toolLastMs })
  }
  if (totalMs !== null && lastChunkMs !== null && totalMs > lastChunkMs) {
    phases.push({ key: 'tail', label: '收尾', startMs: lastChunkMs, endMs: totalMs })
  }

  return {
    ttftMs,
    totalMs,
    lastChunkMs,
    outputChars,
    reasoningChars,
    outputTokens,
    decodeTokPerSec,
    decodeCharsPerSec,
    toolCalls,
    toolSpanMs,
    chunkCount,
    phases,
  }
}

/** 把分块事件按 seq 拼回可见正文 / 推理 / 工具调用参数 */
export function assembleOutput(events: ModelInvocationEvent[]): AssembledOutput {
  const ordered = [...events].sort((a, b) => a.seq - b.seq)
  const text: string[] = []
  const reasoning: string[] = []
  const tools = new Map<number, AssembledToolCall>()
  for (const event of ordered) {
    const d = data(event)
    if (event.type === 'chunk.text') text.push(str(d.text))
    else if (event.type === 'chunk.reasoning') reasoning.push(str(d.text))
    else if (event.type === 'chunk.tool_delta') {
      const index = num(d.index) ?? 0
      const call = tools.get(index) ?? { index, id: null, name: null, arguments: '' }
      if (typeof d.id === 'string' && d.id !== '') call.id = d.id
      if (typeof d.name === 'string' && d.name !== '') call.name = d.name
      call.arguments += str(d.arguments_delta)
      tools.set(index, call)
    }
  }
  return {
    text: text.join(''),
    reasoning: reasoning.join(''),
    toolCalls: [...tools.values()].sort((a, b) => a.index - b.index),
  }
}

/** dispatch 前冻结的请求快照；没有事件（旧行、非 Chat 调用）时返回 null */
export function requestHeader(events: ModelInvocationEvent[]): Record<string, unknown> | null {
  const header = events.find((event) => event.type === 'request.header')
  return header?.data ?? null
}

/** 毫秒的短格式：<1s 用 ms，否则保留一位小数的秒 */
export function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  if (value < 1000) return `${Math.round(value)} ms`
  return `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)} s`
}

/** token 数的短格式：千位以上用 k */
export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  if (value < 1000) return String(value)
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
}
