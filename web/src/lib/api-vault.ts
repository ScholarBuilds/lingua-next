/* 凭据保险箱（CR-007 模块 19）：/vault/* 的契约封装。
   表还是供应商凭据那张，这里多的是通用秘密的增删改、带台账的读出、带口令的导出导入。 */

import { request } from './api'

export type SecretKind = 'api_key' | 'oauth' | 'password' | 'cookies' | 'bearer' | 'totp' | 'login' | 'none'
export type AccessMode = 'read' | 'fill' | 'export' | 'import'

export interface VaultCredential {
  id: number
  name: string
  /** 供应商凭据的媒体种类：llm / tts / video_source…；通用秘密是 secret */
  kind: string
  provider_type: string
  provider_label: string
  secret_kind: SecretKind
  secret_label: string
  /** 可读出 / 可填充的字段名 */
  secret_fields: string[]
  enabled: boolean
  status: 'untested' | 'ok' | 'failed'
  status_detail: string | null
  last_tested_at: string | null
  masked: Record<string, string>
  used_by: string[]
  last_access: { mode: AccessMode; at: string | null } | null
  /** vault = 在保险箱页增删改；settings = 在设置 · 模型服务里管 */
  managed_in: 'vault' | 'settings'
  created_at: string | null
}

export interface SecretField {
  name: string
  label: string
  type: string
  required: boolean
  placeholder?: string | null
}

export interface SecretType {
  provider_type: string
  label: string
  fields: SecretField[]
  notes: string
  secret_kind: SecretKind
}

export interface AccessEntry {
  id: number
  mode: AccessMode
  field: string | null
  purpose: string
  at: string | null
}

export interface VaultStatus {
  key_source: 'env' | 'keychain' | 'file'
  count: number
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

export const apiVault = {
  status: () => request<VaultStatus>('/api/vault/status'),
  secretTypes: () => request<SecretType[]>('/api/vault/secret-types'),
  list: () => request<VaultCredential[]>('/api/vault/credentials'),
  create: (body: { name: string; provider_type: string; config: Record<string, string> }) =>
    request<VaultCredential>('/api/vault/credentials', jsonInit('POST', body)),
  patch: (id: number, body: { name?: string; enabled?: boolean; config?: Record<string, string> }) =>
    request<VaultCredential>(`/api/vault/credentials/${id}`, jsonInit('PATCH', body)),
  remove: (id: number) => request<{ deleted: number }>(`/api/vault/credentials/${id}`, { method: 'DELETE' }),
  reveal: (id: number, field: string) =>
    request<{ field: string; value: string }>(`/api/vault/credentials/${id}/reveal`, jsonInit('POST', { field })),
  access: (id: number) => request<AccessEntry[]>(`/api/vault/credentials/${id}/access`),
  /** 导出走 fetch 拿 Blob：request() 会按 JSON 解析响应 */
  export: async (passphrase: string): Promise<Blob> => {
    const resp = await fetch('/api/vault/export', jsonInit('POST', { passphrase }))
    if (!resp.ok) {
      const body = (await resp.json().catch(() => ({}))) as { detail?: unknown }
      throw new Error(typeof body.detail === 'string' ? body.detail : `导出失败（${resp.status}）`)
    }
    return resp.blob()
  },
  import: async (file: File, passphrase: string): Promise<{ imported: number; skipped: number }> => {
    const form = new FormData()
    form.set('file', file)
    form.set('passphrase', passphrase)
    return request<{ imported: number; skipped: number }>('/api/vault/import', { method: 'POST', body: form })
  },
}
