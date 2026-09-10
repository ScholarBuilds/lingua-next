import { afterEach, expect, it, vi } from 'vitest'
import { streamTalkTurn } from './talkStream'

afterEach(() => vi.unstubAllGlobals())

it('delivers sentences before the committed turn and passes cancellation', async () => {
  const frames = [
    { type: 'sentence', text: 'Welcome.' }, { type: 'reset' },
    { type: 'sentence', text: 'Hello.' },
    { type: 'done', user_turn: { id: 1 }, assistant_turn: { id: 2 } },
  ]
  const encoded = frames.map((frame) => JSON.stringify(frame) + '\n').join('')
  const body = new ReadableStream({ start(controller) {
    for (let i = 0; i < encoded.length; i += 7) controller.enqueue(new TextEncoder().encode(encoded.slice(i, i + 7)))
    controller.close()
  } })
  const fetcher = vi.fn(async () => new Response(body))
  vi.stubGlobal('fetch', fetcher)
  const sentence = vi.fn(), reset = vi.fn(), abort = new AbortController()
  const result = await streamTalkTurn(4, 'Hi', abort.signal, sentence, reset)
  expect(sentence.mock.calls).toEqual([['Welcome.'], ['Hello.']])
  expect(reset).toHaveBeenCalledOnce()
  expect(result.assistant_turn.id).toBe(2)
  expect(fetcher.mock.calls[0]).toEqual([expect.stringContaining('stream=true'), expect.objectContaining({ signal: abort.signal })])
})

it('does not treat a truncated reply as saved', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"type":"sentence","text":"Hello"}\n')))
  await expect(streamTalkTurn(1, 'Hi', new AbortController().signal, vi.fn(), vi.fn())).rejects.toThrow('尚未保存')
})
