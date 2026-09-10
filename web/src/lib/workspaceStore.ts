import { useCallback } from 'react'
import { create } from 'zustand'

export const MODULES = ['today', 'read', 'video', 'vocab', 'dict', 'grammar', 'talk', 'studio', 'mail', 'accounts', 'extensions', 'tasks', 'settings'] as const
export type WorkspaceModule = typeof MODULES[number]
export interface PageSnapshot {
  route?: string
  scroll?: Record<string, number>
  anchor?: string
  offset?: number
  text?: string
  selected?: string
  expanded?: string[]
  width?: number
}
interface SnapshotRecord { module: WorkspaceModule; key: string; version: 1; value: PageSnapshot }
const recordKey = (module: WorkspaceModule, key: string) => `${module}:${key}`

export function moduleForPath(path: string): WorkspaceModule | null {
  const root = path.split(/[/?#]/)[1]
  if (!root) return 'today'
  if (root === 'pipeline') return 'tasks'
  return MODULES.includes(root as WorkspaceModule) ? root as WorkspaceModule : null
}

export function rememberedRoute(value: string): string | null {
  if (!value.startsWith('/') || value.startsWith('//') || /[\\\x00-\x1f]/.test(value)) return null
  const url = new URL(value, window.location.origin)
  if (!moduleForPath(url.pathname)) return null
  // 浮层和认证参数不属于可恢复的工作位置。
  for (const key of [...url.searchParams.keys()]) {
    if (/settings|token|secret|key|password|code|auth/i.test(key)) url.searchParams.delete(key)
  }
  if (url.pathname === '/talk/session' && !url.searchParams.has('id') && !url.searchParams.has('live')) return '/talk'
  return `${url.pathname}${url.search}${url.hash}`
}

const pending = new Map<string, SnapshotRecord>()
let timer: ReturnType<typeof setTimeout> | undefined
let saving: Promise<void> | null = null

async function responseOk(response: Response) {
  if (!response.ok) throw new Error(`工作位置保存失败 (${response.status})`)
}

export const useWorkspaceStore = create<{
  ready: boolean
  error: string | null
  records: Record<string, PageSnapshot>
  hydrate: () => Promise<void>
  put: (module: WorkspaceModule, key: string, value: PageSnapshot) => void
  flush: () => Promise<void>
  clear: () => Promise<void>
}>((set, get) => ({
  ready: false, error: null, records: {},
  hydrate: async () => {
    try {
      const rows: SnapshotRecord[] = []
      for (let offset = 0; ; offset += 500) {
        const response = await fetch(`/api/workspace/snapshots${offset ? `?offset=${offset}` : ''}`)
        await responseOk(response)
        const page = await response.json() as SnapshotRecord[]
        rows.push(...page)
        if (page.length < 500) break
      }
      const records = Object.fromEntries(rows.filter(r => r.version === 1).map(r => [recordKey(r.module, r.key), r.value]))
      set(state => ({ ready: true, records: { ...records, ...state.records }, error: null }))
    } catch (error) {
      set({ ready: true, error: error instanceof Error ? error.message : '无法读取工作位置' })
    }
  },
  put: (module, key, value) => {
    const id = recordKey(module, key)
    if (JSON.stringify(get().records[id]) === JSON.stringify(value)) return
    set(state => ({ records: { ...state.records, [id]: value } }))
    pending.set(id, { module, key, version: 1, value })
    clearTimeout(timer)
    timer = setTimeout(() => { void get().flush() }, 500)
  },
  flush: async () => {
    if (saving) return saving
    if (!pending.size) return
    saving = (async () => {
      try {
        while (pending.size) {
          const [id, record] = pending.entries().next().value!
          await responseOk(await fetch('/api/workspace/snapshots', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(record), keepalive: JSON.stringify(record).length < 60000,
          }))
          if (pending.get(id) === record) pending.delete(id)
        }
        set({ error: null })
      } catch (error) {
        set({ error: error instanceof Error ? error.message : '工作位置保存失败' })
      } finally { saving = null }
    })()
    return saving
  },
  clear: async () => {
    clearTimeout(timer)
    await get().flush()
    await responseOk(await fetch('/api/workspace/snapshots', { method: 'DELETE' }))
    pending.clear()
    set({ records: {}, error: null })
  },
}))

export function useWorkspaceText(module: WorkspaceModule, key: string, initial = '') {
  const text = useWorkspaceStore(s => s.records[recordKey(module, key)]?.text ?? initial)
  const setText = useCallback((value: string) => {
    useWorkspaceStore.getState().put(module, key, { text: value })
  }, [module, key])
  return [text, setText] as const
}

export function workspaceSnapshot(module: WorkspaceModule, key: string): PageSnapshot {
  return useWorkspaceStore.getState().records[recordKey(module, key)] ?? {}
}
