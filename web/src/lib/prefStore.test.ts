import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getPrefs: vi.fn(), putPrefs: vi.fn() }))
vi.mock('./api-config', () => ({ apiConfig: api }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), dismiss: vi.fn() } }))
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.stubGlobal('window', { clearTimeout, setTimeout })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() })
  api.getPrefs.mockResolvedValue({ theme: 'light' })
  api.putPrefs.mockResolvedValue(undefined)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('merges late hydration without overwriting locally edited fields', async () => {
  let resolve!: (data: unknown) => void
  api.getPrefs.mockReturnValue(new Promise(done => { resolve = done }))
  const { usePrefStore: store } = await import('./prefStore')
  const reading = store.getState().hydrate()
  store.getState().update({ reader: { voice: 'local' } })
  resolve({ reader: { voice: 'remote', fontSize: 25 } })
  await reading
  expect(store.getState().prefs.reader.voice).toBe('local')
  expect(store.getState().prefs.reader.fontSize).toBe(25)
  expect(api.putPrefs.mock.calls.at(-1)?.[0].reader.voice).toBe('local')
})

it('serializes in-flight writes and retains failed edits for retry', async () => {
  const { usePrefStore: store } = await import('./prefStore')
  await store.getState().hydrate()
  let resolve!: () => void
  api.putPrefs.mockImplementationOnce(() => new Promise<void>(done => { resolve = done }))
  store.getState().update({ reader: { voice: 'one' } })
  const writing = store.getState().retry()
  store.getState().update({ reader: { voice: 'two' } })
  expect(api.putPrefs).toHaveBeenCalledTimes(1)
  api.putPrefs.mockRejectedValueOnce(new Error('offline'))
  resolve()
  await writing
  expect(store.getState().prefs.reader.voice).toBe('two')
  expect(store.getState().error).toBe('offline')
  await store.getState().retry()
  expect(api.putPrefs.mock.calls.at(-1)?.[0].reader.voice).toBe('two')
  expect(store.getState().synced).toBe(true)
})

it('keeps memory and server updates when local storage is full', async () => {
  const { usePrefStore: store } = await import('./prefStore')
  await store.getState().hydrate()
  vi.mocked(localStorage.setItem).mockImplementation(() => { throw new Error('quota') })
  store.getState().update({ reader: { voice: 'retained' } })
  await store.getState().retry()
  expect(store.getState().prefs.reader.voice).toBe('retained')
  expect(api.putPrefs.mock.calls.at(-1)?.[0].reader.voice).toBe('retained')
})
