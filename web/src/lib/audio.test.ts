import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { beforeAudioPlay, createSpeechQueue, playUrl, prefetchTts, setSessionVoice, setTtsEpoch, setWordVoices, stopTts, ttsUrl } from './audio'

const instances: FakeAudio[] = []
class FakeAudio extends EventTarget {
  src: string
  preload = ''
  playbackRate = 1
  load = vi.fn()
  pause = vi.fn()
  play = vi.fn(async () => {})
  constructor(url: string) { super(); this.src = url; instances.push(this) }
  getAttribute(name: string) { return name === 'src' ? this.src : null }
}

beforeEach(() => {
  vi.stubGlobal('Audio', FakeAudio)
  instances.length = 0
  setSessionVoice(null)
  setWordVoices(new Map())
  setTtsEpoch(0)
})
afterEach(() => { stopTts(); setSessionVoice(null); setWordVoices(new Map()); setTtsEpoch(0); vi.unstubAllGlobals() })

it('appends the cache epoch to every scene once it is non-zero, and drops prefetches when it changes', () => {
  expect(ttsUrl('apple', 'word')).toBe('/api/tts?text=apple&scene=word')
  prefetchTts('one')
  setTtsEpoch(3)
  expect(instances[0].src).toBe('')
  expect(ttsUrl('apple', 'word')).toBe('/api/tts?text=apple&scene=word&e=3')
  expect(ttsUrl('A sentence.', 'sentence')).toBe('/api/tts?text=A+sentence.&scene=sentence&e=3')
})

it('pins a per-word voice for word scenes only and keeps it out of sentence reads', () => {
  setWordVoices(new Map([['apple', { voice: 'edge:en-GB-SoniaNeural', rate: -10 }]]))
  expect(ttsUrl('Apple ', 'word')).toBe('/api/tts?text=Apple+&scene=word&voice=edge%3Aen-GB-SoniaNeural&rate=-10')
  expect(ttsUrl('apple', 'vocab')).toContain('voice=edge%3Aen-GB-SoniaNeural')
  expect(ttsUrl('apple', 'sentence')).toBe('/api/tts?text=apple&scene=sentence')
  expect(ttsUrl('pear', 'word')).toBe('/api/tts?text=pear&scene=word')
})

it('lets an explicit voice beat the pinned one, and the pinned one beat the session voice', () => {
  setWordVoices(new Map([['apple', { voice: 'edge:en-GB-SoniaNeural', rate: 0 }]]))
  setSessionVoice('volc:session')
  expect(ttsUrl('apple', 'word')).toContain('voice=edge%3Aen-GB-SoniaNeural')
  expect(ttsUrl('apple', 'word', 'edge:en-US-AriaNeural')).toContain('voice=edge%3Aen-US-AriaNeural')
  expect(ttsUrl('apple', 'word', null)).toBe('/api/tts?text=apple&scene=word')
  expect(ttsUrl('pear', 'word')).toContain('voice=volc%3Asession')
})

it('drops speculative loads when the per-word voice table changes', () => {
  prefetchTts('one')
  setWordVoices(new Map([['one', { voice: 'edge:x', rate: 0 }]]))
  expect(instances[0].src).toBe('')
})

it('pauses live playback before starting a reread and releases the page listener', () => {
  const pauseLive = vi.fn(() => expect(instances.every((audio) => audio.play.mock.calls.length === 0)).toBe(true))
  const release = beforeAudioPlay(pauseLive)
  playUrl('first')
  expect(pauseLive).toHaveBeenCalledOnce()
  release()
  playUrl('second')
  expect(pauseLive).toHaveBeenCalledOnce()
  expect(instances[0].pause).toHaveBeenCalled()
})

it('reuses a pending next-sentence load instead of fetching it twice', () => {
  const url = ttsUrl('Next sentence.', 'chapter')
  prefetchTts(url)
  prefetchTts(url)
  const prepared = instances[0]
  expect(instances).toHaveLength(1)
  expect(prepared.load).toHaveBeenCalledOnce()
  expect(prepared.play).not.toHaveBeenCalled()
  expect(playUrl(url)).toBe(prepared)
  expect(prepared.play).toHaveBeenCalledOnce()
})

it('bounds speculative loads and invalidates them on voice changes', () => {
  prefetchTts('one'); prefetchTts('two'); prefetchTts('three')
  expect(instances[0].src).toBe('')
  setSessionVoice('edge:other')
  expect(instances.every((audio) => audio.src === '')).toBe(true)
})

it('plays sentences in order and stops old queues on interruption', () => {
  const queue = createSpeechQueue(vi.fn())
  queue.enqueue('First sentence.')
  queue.enqueue('Second sentence.')
  expect(instances[0].play).toHaveBeenCalledOnce()
  expect(instances[1].play).not.toHaveBeenCalled()
  instances[0].dispatchEvent(new Event('ended'))
  expect(instances[1].play).toHaveBeenCalledOnce()
  stopTts()
  queue.enqueue('Must not play.')
  instances[1].dispatchEvent(new Event('ended'))
  expect(instances).toHaveLength(2)
})

it('reports a playback error without advancing to the next sentence', () => {
  const failed = vi.fn()
  const queue = createSpeechQueue(failed)
  queue.enqueue('First.'); queue.enqueue('Second.')
  instances[0].dispatchEvent(new Event('error'))
  expect(failed).toHaveBeenCalledOnce()
  expect(instances[1].play).not.toHaveBeenCalled()
})

it('prefetches only the next sentence as the queue advances', () => {
  const queue = createSpeechQueue(vi.fn())
  queue.enqueue('First.'); queue.enqueue('Second.'); queue.enqueue('Third.')
  expect(instances).toHaveLength(2)
  instances[0].dispatchEvent(new Event('ended'))
  expect(instances).toHaveLength(3)
  expect(instances[2].load).toHaveBeenCalledOnce()
  expect(instances[2].play).not.toHaveBeenCalled()
})

it('ignores a late playback error after cancellation', () => {
  const failed = vi.fn()
  const queue = createSpeechQueue(failed)
  queue.enqueue('First.')
  queue.stop()
  instances[0].dispatchEvent(new Event('error'))
  expect(failed).not.toHaveBeenCalled()
})
