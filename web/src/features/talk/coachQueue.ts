import type { QueryClient } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { api, type TalkCoachBatch } from '../../lib/api'

interface Job {
  key: string
  auto: boolean
  run: () => Promise<TalkCoachBatch>
  resolve: (batch: TalkCoachBatch | null) => void
  reject: (error: unknown) => void
  promise: Promise<TalkCoachBatch | null>
}

export class CoachQueue {
  private pending: Job[] = []
  private active: Job | null = null
  private listeners = new Set<() => void>()

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  status(turn: number): 'running' | 'queued' | 'idle' {
    const prefix = `${turn}:`
    if (this.active?.key.startsWith(prefix)) return 'running'
    return this.pending.some((job) => job.key.startsWith(prefix)) ? 'queued' : 'idle'
  }

  private notify(): void { this.listeners.forEach((listener) => listener()) }

  enqueue(key: string, auto: boolean, run: Job['run']): Promise<TalkCoachBatch | null> {
    const existing = [this.active, ...this.pending].find((job) => job?.key === key)
    if (existing) {
      if (!auto) existing.auto = false
      return existing.promise
    }
    let resolve!: Job['resolve']
    let reject!: Job['reject']
    const promise = new Promise<TalkCoachBatch | null>((yes, no) => { resolve = yes; reject = no })
    const job = { key, auto, run, resolve, reject, promise }
    this.pending.push(job)
    this.notify()
    void this.drain()
    return promise
  }

  cancelAutomatic(): void {
    this.pending.filter((job) => job.auto).forEach((job) => job.resolve(null))
    this.pending = this.pending.filter((job) => !job.auto)
    this.notify()
  }

  private async drain(): Promise<void> {
    if (this.active) return
    const index = this.pending.findIndex((job) => !job.auto)
    const job = this.pending.splice(index < 0 ? 0 : index, 1)[0]
    if (!job) return
    this.active = job
    this.notify()
    try { job.resolve(await job.run()) } catch (error) { job.reject(error) }
    finally { this.active = null; this.notify(); void this.drain() }
  }
}

const queues = new Map<string, CoachQueue>()
export const batchKey = (session: number | string, turn: number) => ['talk-batches', String(session), turn]
export function sessionCoachQueue(session: number | string): CoachQueue {
  const key = String(session)
  let queue = queues.get(key)
  if (!queue) { queue = new CoachQueue(); queues.set(key, queue) }
  return queue
}

export function useCoachStatus(session: number | string | null, turn: number | null | undefined) {
  const queue = sessionCoachQueue(session ?? '')
  return useSyncExternalStore(queue.subscribe, () => turn == null ? 'idle' : queue.status(turn))
}

export function generateCoach(client: QueryClient, session: number | string, turn: number,
  index: number, auto = false, retry = false): Promise<TalkCoachBatch | null> {
  return sessionCoachQueue(session).enqueue(`${turn}:${index}`, auto, async () => {
    const batch = await api.generateTalkBatch(session, turn, index, retry)
    client.setQueryData<TalkCoachBatch[]>(batchKey(session, turn), (old = []) =>
      [...old.filter((item) => item.batch_index !== index), batch].sort((a, b) => a.batch_index - b.batch_index))
    void client.invalidateQueries({ queryKey: ['talk-records', String(session)] })
    return batch
  })
}
