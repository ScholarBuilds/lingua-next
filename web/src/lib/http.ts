import { notifyLearningChange } from './learningSync'

export class HttpError extends Error {
  constructor(public status: number, message: string, public detail: unknown = null) {
    super(message)
    this.name = 'HttpError'
  }
}

type ErrorFactory = (status: number, message: string, detail: unknown) => Error

export function errorMessage(body: unknown, fallback: string): { message: string; detail: unknown } {
  if (!body || typeof body !== 'object') return { message: fallback, detail: null }
  const value = body as { detail?: unknown; message?: unknown }
  const detail = value.detail ?? null
  let message = fallback
  if (typeof detail === 'string') message = detail
  else if (Array.isArray(detail)) {
    const errors = detail.flatMap(item => item && typeof item === 'object' && typeof item.msg === 'string' ? [item.msg] : [])
    if (errors.length) message = errors.join('；')
  } else if (detail && typeof detail === 'object' && 'message' in detail && typeof detail.message === 'string') message = detail.message
  else if (typeof value.message === 'string') message = value.message
  return { message, detail }
}

export async function requestJson<T>(path: string, init?: RequestInit, makeError: ErrorFactory = (status, message, detail) => new HttpError(status, message, detail)): Promise<T> {
  let response: Response
  let text: string
  try {
    response = await fetch(path, init)
    text = await response.text()
  } catch (error) {
    if (init?.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
    throw makeError(0, '网络连接失败', null)
  }
  let body: unknown
  try { body = text.trim() ? JSON.parse(text) : undefined }
  catch {
    if (response.ok) throw makeError(response.status, '服务器返回了无法解析的数据，请重试', null)
  }
  if (!response.ok) {
    const { message, detail } = errorMessage(body, `请求失败 (${response.status})`)
    throw makeError(response.status, message, detail)
  }
  notifyLearningChange(path, init?.method?.toUpperCase() ?? 'GET', body)
  return body as T
}
