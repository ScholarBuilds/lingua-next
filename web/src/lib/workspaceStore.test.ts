import { afterEach, describe, expect, it, vi } from 'vitest'
import { moduleForPath, rememberedRoute, useWorkspaceStore } from './workspaceStore'

afterEach(async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
  await useWorkspaceStore.getState().clear()
  useWorkspaceStore.setState({ ready: false })
  vi.unstubAllGlobals()
})

describe('workspace navigation', () => {
  it('restores internal pages without authentication or live session startup', () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost:5173' } })
    expect(rememberedRoute('/grammar?tab=points&point=42')).toBe('/grammar?tab=points&point=42')
    expect(rememberedRoute('/talk/session?mode=realtime')).toBe('/talk')
    expect(rememberedRoute('/read/12?token=private&settings=voice')).toBe('/read/12')
    expect(rememberedRoute('//other.test/read')).toBeNull()
    expect(rememberedRoute('/unknown')).toBeNull()
    expect(moduleForPath('/pipeline/12')).toBe('tasks')
  })

  it('does not overwrite typing with a late hydration result', async () => {
    let resolve!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(done => { resolve = done })))
    const hydration = useWorkspaceStore.getState().hydrate()
    useWorkspaceStore.getState().put('grammar', 'draft', { text: 'new draft' })
    resolve(Response.json([{ module: 'grammar', key: 'draft', version: 1, value: { text: 'old draft' } }]))
    await hydration
    expect(useWorkspaceStore.getState().records['grammar:draft'].text).toBe('new draft')
  })

  it('reads additional snapshot pages instead of dropping older drafts', async () => {
    const first = Array.from({ length: 500 }, (_, index) => ({
      module: 'grammar', key: `page-${index}`, version: 1, value: { offset: index },
    }))
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(first))
      .mockResolvedValueOnce(Response.json([{ module: 'mail', key: 'reply:1', version: 1, value: { text: 'saved reply' } }]))
    vi.stubGlobal('fetch', fetch)
    await useWorkspaceStore.getState().hydrate()
    expect(fetch.mock.calls[1][0]).toBe('/api/workspace/snapshots?offset=500')
    expect(useWorkspaceStore.getState().records['mail:reply:1'].text).toBe('saved reply')
  })

  it('retains unsaved data after failure and retries the same record', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetch)
    useWorkspaceStore.getState().put('talk', 'draft', { text: 'hello' })
    await useWorkspaceStore.getState().flush()
    expect(useWorkspaceStore.getState().error).toContain('503')
    expect(useWorkspaceStore.getState().records['talk:draft'].text).toBe('hello')
    await useWorkspaceStore.getState().flush()
    expect(useWorkspaceStore.getState().error).toBeNull()
    expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body)
  })

  it('saves edits queued while an earlier write is in flight', async () => {
    let resolve!: (value: Response) => void
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>(done => { resolve = done }))
      .mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetch)
    useWorkspaceStore.getState().put('grammar', 'draft', { text: 'one' })
    const saving = useWorkspaceStore.getState().flush()
    useWorkspaceStore.getState().put('grammar', 'draft', { text: 'two' })
    resolve(new Response(null, { status: 204 }))
    await saving
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetch.mock.calls[1][1].body).value.text).toBe('two')
  })
})
