import { requestJson } from './http'

/* AI 修复工作台 API（需求 09 v7 FR-85~92）。 */

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  return requestJson<T>(url, init)
}

function jsonPost(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

export interface RepairSessionV1 {
  id: number
  video_id: number
  step_name: string | null
  step_label: string | null
  /** open 可对话 | working 代理执行中 | confirmed 已放行待续跑 */
  status: string
  model_alias: string
  model_deployment_id: number | null
  pending_action: { tool: string; args: Record<string, unknown>; reason: string } | null
  parent_session_id: number | null
  created_at: string | null
  updated_at: string | null
}

export interface RepairMessageV1 {
  id: number
  role: 'user' | 'assistant' | 'system'
  content: string
  created_at: string | null
}

export interface RepairActionV1 {
  id: number
  tool: string
  label: string
  args: Record<string, unknown>
  status: 'running' | 'success' | 'failed' | 'pending_confirm'
  result: Record<string, unknown>
  error: string | null
  duration_ms: number | null
  created_at: string | null
}

export interface RepairDetail extends RepairSessionV1 {
  messages: RepairMessageV1[]
  actions: RepairActionV1[]
}

/** 修复代理的能力别名（FR-89）；每个别名可绑到任意可用 Chat 部署。 */
export const REPAIR_ALIASES = [
  'repair-agent',
  'explain-standard',
  'grammar-deep',
  'summary',
  'companion',
] as const

export const apiRepair = {
  createSession: (body: {
    video_id: number
    step_name?: string | null
    model_alias?: string
    model_deployment_id?: number | null
    parent_session_id?: number
  }) => req<RepairSessionV1>('/api/repair/sessions', jsonPost(body)),

  sessions: (videoId: number) =>
    req<RepairSessionV1[]>(`/api/repair/sessions?video_id=${videoId}`),

  detail: (sessionId: number) => req<RepairDetail>(`/api/repair/sessions/${sessionId}`),

  send: (sessionId: number, content: string) =>
    req<{ queued: boolean }>(`/api/repair/sessions/${sessionId}/messages`, jsonPost({ content })),

  confirm: (sessionId: number) =>
    req<{ queued: boolean }>(`/api/repair/sessions/${sessionId}/confirm`, { method: 'POST' }),

  reject: (sessionId: number) =>
    req<{ ok: boolean }>(`/api/repair/sessions/${sessionId}/reject`, { method: 'POST' }),

  voice: async (sessionId: number, blob: Blob): Promise<{ text: string }> => {
    const form = new FormData()
    form.append('file', blob, 'voice.webm')
    return req<{ text: string }>(`/api/repair/sessions/${sessionId}/voice`, {
      method: 'POST',
      body: form,
    })
  },
}

/** 会话 SSE：消息 / 动作 / 状态有变即推整包；返回取消函数 */
export function subscribeRepair(
  sessionId: number,
  onData: (detail: RepairDetail) => void,
): () => void {
  const source = new EventSource(`/api/repair/sessions/${sessionId}/stream`)
  source.onmessage = (ev) => {
    try {
      onData(JSON.parse(ev.data) as RepairDetail)
    } catch {
      /* keep-alive */
    }
  }
  return () => source.close()
}
