/* 扩展与例程（CR-007 模块 22）：/extensions/* 与 /routines/* 的契约封装 */

import { request } from './api'

export type ExtensionKind = 'builtin' | 'local' | 'mcp' | 'routine'
export type ExtensionStatus = 'ready' | 'disabled' | 'needs_permission' | 'invalid'
export type PermissionKey = 'network' | 'credentials' | 'screen_input' | 'files'

export interface ExtensionRow {
  id: string
  name: string
  kind: ExtensionKind
  version: string
  description: string
  source: string
  status: ExtensionStatus
  error: string | null
  enabled: boolean
  permissions: PermissionKey[]
  granted: PermissionKey[]
  missing_permissions: PermissionKey[]
  contributions: Record<string, number>
  pages: Array<{ label: string; to: string | null; url: string | null }>
  commands: Array<{ label: string; to: string | null; url: string | null; keywords: string }>
  tools: string[]
  routines: string[]
  mcp: { transport: 'stdio' | 'http'; target: string | null } | null
}

export interface ExtensionCatalog {
  items: ExtensionRow[]
  points: Array<{ key: string; label: string }>
  permissions: Array<{ key: PermissionKey; label: string }>
  dir: string
}

export interface RoutineRow {
  key: string
  label: string
  kind: 'brief' | 'prompt'
  schedule: string
  schedule_label: string
  prompt: string | null
  detail: string | null
  speak: boolean
  enabled: boolean
  source: string
  last_run_at: string | null
  last_status: 'ok' | 'failed' | null
  last: { text: string; at: string | null; payload: Record<string, unknown> | null } | null
}

export interface RoutineRunRow {
  id: number
  text: string
  at: string | null
  payload: Record<string, unknown> | null
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export const apiExtensions = {
  list: () => request<ExtensionCatalog>('/api/extensions'),
  rescan: () => request<ExtensionCatalog>('/api/extensions/rescan', { method: 'POST' }),
  patch: (id: string, body: { enabled?: boolean; granted?: PermissionKey[] }) =>
    request<ExtensionRow>(`/api/extensions/${id}`, json('PATCH', body)),
  test: (id: string) =>
    request<{ ok: boolean; tools?: string[]; error?: string; note?: string }>(`/api/extensions/${id}/test`, { method: 'POST' }),
  routines: () => request<RoutineRow[]>('/api/routines'),
  patchRoutine: (key: string, body: { enabled?: boolean; schedule?: string; speak?: boolean }) =>
    request<RoutineRow>(`/api/routines/${key}`, json('PATCH', body)),
  runRoutine: (key: string) => request<RoutineRow>(`/api/routines/${key}/run`, { method: 'POST' }),
  routineRuns: (key: string, limit = 20) => request<RoutineRunRow[]>(`/api/routines/${key}/runs?limit=${limit}`),
}
