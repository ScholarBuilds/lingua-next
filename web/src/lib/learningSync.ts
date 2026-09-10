import type { QueryClient } from '@tanstack/react-query'

type Change = { stages: Record<string, string>; mark?: string | null }
let send: ((change: Change) => void) | undefined

export function notifyLearningChange(path: string, method: string, body: unknown) {
  if (method === 'GET' || !/\/(vocab|wordlists|review|practice)(\/|$)/.test(path)) return
  const result = body && typeof body === 'object' ? body as Partial<Change> : {}
  send?.({ stages: result.stages ?? {}, mark: result.mark })
}

export function updateLearningData(data: unknown, change: Change): unknown {
  if (Array.isArray(data)) return data.map(item => updateLearningData(item, change))
  if (!data || typeof data !== 'object') return data
  const row = data as Record<string, unknown>
  const next = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, updateLearningData(value, change)]))
  if (row.stages && typeof row.stages === 'object') next.stages = { ...row.stages, ...change.stages }
  const word = typeof row.word === 'string' ? row.word : typeof row.lc === 'string' ? row.lc : ''
  const stage = change.stages[word.trim().toLowerCase()]
  if (!stage) return next
  if ('stage' in row) next.stage = stage
  if ('bucket' in row) {
    next.bucket = stage === 'mastered' ? 'mature' : stage === 'unseen' ? 'new' : stage === 'hard' ? 'hard' : 'learning'
    next.difficult = stage === 'hard'
    if (change.mark !== undefined) next.mark = change.mark
  }
  return next
}

export function connectLearningSync(client: QueryClient) {
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('nexus-learning')
  const filters = { predicate: (query: { queryKey: readonly unknown[] }) => /^(deck-|decks$|vocab|word-stage|dict-search|review|practice|wordlists|scene)/.test(String(query.queryKey[0])) }
  const apply = async (change: Change) => {
    await client.cancelQueries(filters)
    client.setQueriesData(filters, data => updateLearningData(data, change))
    window.dispatchEvent(new CustomEvent('word-stages-changed', { detail: change.stages }))
    await client.invalidateQueries(filters)
  }
  send = change => { void apply(change); channel?.postMessage(change) }
  if (channel) channel.onmessage = event => { void apply(event.data as Change) }
  return () => { send = undefined; channel?.close() }
}
