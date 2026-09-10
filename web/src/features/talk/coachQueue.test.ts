import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, type TalkCoachBatch } from '../../lib/api'
import { batchKey, CoachQueue, generateCoach } from './coachQueue'

const batch = (id = 1, index = 0): TalkCoachBatch => ({ id, batch_index: index, status: 'ready',
  error: null, saved_replies: [], created_at: '2026-09-04T00:00:00Z', model: 'test',
  result: { translation: '你好', intent: '问候', replies: [] } })
const deferred = () => {
  let resolve!: (value: TalkCoachBatch) => void
  const promise = new Promise<TalkCoachBatch>((yes) => { resolve = yes })
  return { promise, resolve }
}

afterEach(() => vi.restoreAllMocks())
describe('persistent coach queue', () => {
  it('shares duplicate requests and runs manual jobs before queued automatic jobs', async () => {
    const queue = new CoachQueue()
    const first = deferred()
    const order: string[] = []
    const pending = queue.enqueue('1:0', true, () => first.promise)
    expect(queue.enqueue('1:0', false, () => { throw new Error('duplicate') })).toBe(pending)
    const automatic = queue.enqueue('2:0', true, async () => { order.push('auto'); return batch(2) })
    const manual = queue.enqueue('3:0', false, async () => { order.push('manual'); return batch(3) })
    expect(queue.status(1)).toBe('running')
    expect(queue.status(2)).toBe('queued')
    first.resolve(batch())
    await Promise.all([pending, automatic, manual])
    expect(order).toEqual(['manual', 'auto'])
    expect(queue.status(1)).toBe('idle')
  })

  it('cancels only automatic jobs that have not started', async () => {
    const queue = new CoachQueue()
    const first = deferred()
    const pending = queue.enqueue('1:0', true, () => first.promise)
    const skipped = vi.fn(async () => batch(2))
    const automatic = queue.enqueue('2:0', true, skipped)
    const manual = queue.enqueue('3:0', false, async () => batch(3))
    queue.cancelAutomatic()
    expect(await automatic).toBeNull()
    first.resolve(batch())
    expect((await pending)?.id).toBe(1)
    expect((await manual)?.id).toBe(3)
    expect(skipped).not.toHaveBeenCalled()
  })

  it('continues after failures without retrying a paid request', async () => {
    const queue = new CoachQueue()
    const fail = vi.fn(async () => { throw new Error('offline') })
    await expect(queue.enqueue('1:0', true, fail)).rejects.toThrow('offline')
    expect((await queue.enqueue('2:0', true, async () => batch(2)))?.id).toBe(2)
    expect(fail).toHaveBeenCalledTimes(1)
  })

  it('keeps late results with their message and retains prior batches on failure', async () => {
    const client = new QueryClient()
    vi.spyOn(api, 'generateTalkBatch').mockResolvedValueOnce(batch()).mockResolvedValueOnce(batch(2))
      .mockRejectedValueOnce(new Error('offline'))
    await generateCoach(client, 9876, 1, 0)
    await generateCoach(client, 9876, 2, 0)
    await expect(generateCoach(client, 9876, 1, 1)).rejects.toThrow('offline')
    expect(client.getQueryData(batchKey(9876, 1))).toEqual([batch()])
    expect(client.getQueryData(batchKey(9876, 2))).toEqual([batch(2)])
    client.clear()
  })
})
