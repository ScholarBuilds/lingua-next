/* 流式分析公共件：SSE 增量文本的部分 JSON 解析 + 分析流 hook（M5-FA）。
   后端 delta 吐的是结果 JSON 的原始片段，打字机效果按"能解析多少渲染多少"来做：
   把不完整的 JSON 修复闭合后解析出已就绪的字段，done 后用完整结果重渲。 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { readerApi } from '../../lib/api-reader-m5'
import type { AnalyzeDone, StreamAnalyzeKind, TranslateStreamDone } from '../../lib/api-reader-m5'

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** 从流式累积文本中解析部分 JSON 对象。
    策略：扫描记录括号栈与字符串状态 → 先尝试"闭合未完字符串+补右括号"，
    失败则回退到最近一个安全截断点（逗号/左括号/完整值结尾）再补括号。 */
export function parsePartialJson<T>(raw: string): Partial<T> | null {
  const start = raw.indexOf('{')
  if (start < 0) return null
  const text = raw.slice(start)

  const stack: string[] = []
  let inStr = false
  let esc = false
  // 最近安全截断点：截到 end（不含）后追加 closers 可得合法 JSON
  let cut: { end: number; closers: string } | null = null
  const closersOf = (): string =>
    [...stack]
      .reverse()
      .map((c) => (c === '{' ? '}' : ']'))
      .join('')

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
    } else if (ch === '{' || ch === '[') {
      stack.push(ch)
      cut = { end: i + 1, closers: closersOf() }
    } else if (ch === '}' || ch === ']') {
      if (stack.length === 0) break
      stack.pop()
      cut = { end: i + 1, closers: closersOf() }
    } else if (ch === ',') {
      cut = { end: i, closers: closersOf() }
    }
  }

  // 尝试一：整段收尾（适合"字符串值写到一半"的常见情形）
  let head = text.replace(/[\s,]+$/, '')
  if (inStr) head = `${text}"`
  const full = tryParse(head + closersOf())
  if (full !== undefined && typeof full === 'object' && full !== null) return full as Partial<T>

  // 尝试二：回退到安全截断点（键写到一半 / 冒号后无值 / 字面量截断）
  if (cut !== null) {
    const sliced = text.slice(0, cut.end).replace(/[\s,]+$/, '')
    const partial = tryParse(sliced + cut.closers)
    if (partial !== undefined && typeof partial === 'object' && partial !== null)
      return partial as Partial<T>
  }
  return null
}

export type StreamStatus = 'idle' | 'streaming' | 'done' | 'error'

export interface AnalyzeStreamState<T> {
  status: StreamStatus
  /** 流中已能解析出的部分结果 */
  partial: Partial<T> | null
  data: AnalyzeDone<T> | null
  error: string | null
  /** 503：LLM 网关未配置 */
  gateway: boolean
}

const IDLE_STATE = {
  status: 'idle' as const,
  partial: null,
  data: null,
  error: null,
  gateway: false,
}

/** 流式分析 hook：start 发起 SSE，delta 累积成 partial，done 落 data。
    组件卸载或重新 start 时中止上一条流。 */
export function useStreamAnalyze<T>(
  kind: StreamAnalyzeKind,
  onDone?: (data: AnalyzeDone<T>) => void,
) {
  const [state, setState] = useState<AnalyzeStreamState<T>>(IDLE_STATE)
  const acRef = useRef<AbortController | null>(null)
  const rawRef = useRef('')
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  useEffect(() => () => acRef.current?.abort(), [])

  const start = useCallback(
    (body: Record<string, unknown>) => {
      acRef.current?.abort()
      const ac = new AbortController()
      acRef.current = ac
      rawRef.current = ''
      setState({ status: 'streaming', partial: null, data: null, error: null, gateway: false })
      void readerApi.streamAnalyze<T>(
        kind,
        body,
        {
          onDelta: (text) => {
            if (ac.signal.aborted) return
            rawRef.current += text
            const partial = parsePartialJson<T>(rawRef.current)
            if (partial !== null)
              setState((s) => (s.status === 'streaming' ? { ...s, partial } : s))
          },
          onDone: (data) => {
            if (ac.signal.aborted) return
            setState({ status: 'done', partial: null, data, error: null, gateway: false })
            onDoneRef.current?.(data)
          },
          onError: (status, message) => {
            if (ac.signal.aborted) return
            setState({
              status: 'error',
              partial: null,
              data: null,
              error: message,
              gateway: status === 503,
            })
          },
        },
        ac.signal,
      )
    },
    [kind],
  )

  /** 外部命中缓存 / 版本切换后直接落定结果 */
  const settle = useCallback((data: AnalyzeDone<T>) => {
    acRef.current?.abort()
    setState({ status: 'done', partial: null, data, error: null, gateway: false })
  }, [])

  return { state, start, settle }
}

/* ---- 翻译流：delta 为纯译文文本，直接累积成打字机 ---- */

export interface TranslateStreamState {
  status: StreamStatus
  /** 流中已累积的译文文本 */
  text: string
  data: TranslateStreamDone | null
  error: string | null
  gateway: boolean
}

const TRANSLATE_IDLE: TranslateStreamState = {
  status: 'idle',
  text: '',
  data: null,
  error: null,
  gateway: false,
}

export function useTranslateStream(onDone?: (data: TranslateStreamDone) => void) {
  const [state, setState] = useState<TranslateStreamState>(TRANSLATE_IDLE)
  const acRef = useRef<AbortController | null>(null)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  useEffect(() => () => acRef.current?.abort(), [])

  const start = useCallback(
    (body: { text: string; engine: string; refresh?: boolean; context?: string }) => {
    acRef.current?.abort()
    const ac = new AbortController()
    acRef.current = ac
    setState({ status: 'streaming', text: '', data: null, error: null, gateway: false })
    void readerApi.streamTranslate(
      body,
      {
        onDelta: (t) => {
          if (ac.signal.aborted) return
          setState((s) => (s.status === 'streaming' ? { ...s, text: s.text + t } : s))
        },
        onDone: (data) => {
          if (ac.signal.aborted) return
          setState({ status: 'done', text: data.result.text, data, error: null, gateway: false })
          onDoneRef.current?.(data)
        },
        onError: (status, message) => {
          if (ac.signal.aborted) return
          setState({ status: 'error', text: '', data: null, error: message, gateway: status === 503 })
        },
      },
      ac.signal,
    )
  }, [])

  return { state, start }
}
