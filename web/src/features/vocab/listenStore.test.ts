import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'

import type { DeckItem } from '../../lib/api-deck'

/* vitest 跑在 node 里：prefStore 模块求值就碰 localStorage，store 用 window.setTimeout，
   两者都要在动态 import 之前搭好桩 */
const instances: FakeAudio[] = []
/* 预取也会 new Audio，且预取过的实例会被 playUrl 复用：按 play 的先后记，不按创建顺序 */
const played: FakeAudio[] = []
class FakeAudio extends EventTarget {
  src: string
  /** stopTts 会把 src 清空，断言用构造时的地址 */
  readonly url: string
  preload = ''
  playbackRate = 1
  load = vi.fn()
  pause = vi.fn()
  play = vi.fn(async () => {
    played.push(this)
  })
  constructor(url: string) {
    super()
    this.src = url
    this.url = url
    instances.push(this)
  }
  getAttribute(name: string) {
    return name === 'src' ? this.src : null
  }
}

let listen: typeof import('./listenStore')
let audio: typeof import('../../lib/audio')
let prefs: typeof import('../../lib/prefStore')
let resume: typeof import('./listenResume')

beforeAll(async () => {
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  })
  vi.stubGlobal('window', {
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id?: number) => clearTimeout(id),
  })
  vi.stubGlobal('Audio', FakeAudio)
  listen = await import('./listenStore')
  audio = await import('../../lib/audio')
  prefs = await import('../../lib/prefStore')
  resume = await import('./listenResume')
})

function item(word: string, translation = `${word}的意思`, example: string | null = null): DeckItem {
  return {
    word,
    phonetic: null,
    translation,
    definition: null,
    frq: null,
    freq_band: null,
    tags: [],
    collins: null,
    exchange: null,
    status: 'new',
    bucket: 'new',
    difficult: false,
    mark: null,
    vocab_id: null,
    due_at: null,
    group_key: null,
    example_en: example,
    example_zh: null,
    dict_miss: false,
  } as DeckItem
}

const WORDS = [item('apple'), item('pear'), item('plum', 'plum的意思', 'A plum fell.')]

function setListenPrefs(patch: Partial<ReturnType<typeof prefs.usePrefStore.getState>['prefs']['listen']>) {
  const state = prefs.usePrefStore.getState()
  prefs.usePrefStore.setState({ prefs: { ...state.prefs, listen: { ...state.prefs.listen, ...patch } } })
}

function urls(): string[] {
  return played.map((a) => decodeURIComponent(a.url.replace(/\+/g, ' ')))
}

function finish(i: number) {
  played[i].dispatchEvent(new Event('ended'))
}

beforeEach(() => {
  vi.useFakeTimers()
  instances.length = 0
  played.length = 0
  setListenPrefs({
    content: 'word_meaning',
    repeat: 2,
    gapS: 1,
    rate: 1,
    shuffle: false,
    loopAll: false,
    meaningScope: 'first',
    recallGapS: 0,
    stopAfter: 0,
  })
  resume.useListenResume.setState({ entries: {} })
  listen.configureListenRandom(() => 0)
  const s = listen.useListenStore.getState()
  s.open('cet4', '四级', 'cet4|all', '/vocab?v=deck&k=cet4')
  s.setItems(WORDS, true)
})
afterEach(() => {
  listen.useListenStore.getState().close()
  audio.stopTts()
  vi.useRealTimers()
})

it('reads each word repeat times, then the meaning, then moves on after the gap', () => {
  const s = listen.useListenStore.getState()
  s.play()
  expect(urls()).toEqual(['/api/tts?text=apple&scene=word'])
  finish(0)
  vi.advanceTimersByTime(400)
  expect(urls()[1]).toBe('/api/tts?text=apple&scene=word')
  finish(1)
  vi.advanceTimersByTime(0)
  expect(urls()[2]).toBe('/api/tts?text=apple的意思&scene=meaning')
  expect(listen.useListenStore.getState().step).toBe('meaning')
  finish(2)
  vi.advanceTimersByTime(999)
  expect(urls()).toHaveLength(3)
  vi.advanceTimersByTime(1)
  expect(urls()[3]).toBe('/api/tts?text=pear&scene=word')
  expect(listen.useListenStore.getState().currentWord).toBe('pear')
})

it('skips the meaning segment when there is nothing to say, and reads the example only when asked', () => {
  setListenPrefs({ content: 'word_meaning_example', repeat: 1 })
  const s = listen.useListenStore.getState()
  s.setItems([item('bare', 'n. [计]'), item('plum', 'plum的意思', 'A plum fell.')], true)
  s.play()
  finish(0)
  vi.advanceTimersByTime(1000)
  expect(urls()[1]).toBe('/api/tts?text=plum&scene=word')
  finish(1)
  vi.advanceTimersByTime(0)
  expect(urls()[2]).toBe('/api/tts?text=plum的意思&scene=meaning')
  finish(2)
  vi.advanceTimersByTime(0)
  expect(urls()[3]).toBe('/api/tts?text=A plum fell.&scene=sentence')
})

it('loops the current word until told otherwise, and keeps looping after a manual skip', () => {
  setListenPrefs({ repeat: 1, content: 'word' })
  const s = listen.useListenStore.getState()
  s.play()
  s.toggleLoopOne()
  finish(0)
  vi.advanceTimersByTime(1000)
  expect(urls()).toEqual(['/api/tts?text=apple&scene=word', '/api/tts?text=apple&scene=word'])
  s.next()
  expect(listen.useListenStore.getState().currentWord).toBe('pear')
  expect(listen.useListenStore.getState().loopOne).toBe(true)
  finish(2)
  vi.advanceTimersByTime(1000)
  expect(urls()[3]).toBe('/api/tts?text=pear&scene=word')
})

it('jumping to a word restarts its repeats from the first one and starts playback even when paused', () => {
  const s = listen.useListenStore.getState()
  s.play()
  finish(0)
  vi.advanceTimersByTime(400)
  s.pause()
  expect(listen.useListenStore.getState().status).toBe('paused')
  s.jumpTo('plum')
  expect(listen.useListenStore.getState().status).toBe('playing')
  expect(urls().at(-1)).toBe('/api/tts?text=plum&scene=word')
  finish(played.length - 1)
  vi.advanceTimersByTime(400)
  expect(urls().at(-1)).toBe('/api/tts?text=plum&scene=word')
  expect(listen.useListenStore.getState().seg).toBe(1)
})

it('stops at the end unless loopAll is on, in which case it wraps around', () => {
  setListenPrefs({ repeat: 1, content: 'word' })
  const s = listen.useListenStore.getState()
  s.setItems([item('apple'), item('pear')], true)
  s.play()
  finish(0)
  vi.advanceTimersByTime(1000)
  finish(1)
  vi.advanceTimersByTime(1000)
  expect(listen.useListenStore.getState().status).toBe('idle')
  expect(urls()).toHaveLength(2)

  setListenPrefs({ loopAll: true })
  s.play()
  finish(2)
  vi.advanceTimersByTime(1000)
  finish(3)
  vi.advanceTimersByTime(1000)
  expect(urls()[4]).toBe('/api/tts?text=apple&scene=word')
  expect(listen.useListenStore.getState().status).toBe('playing')
})

it('shuffles the play order without touching the items, and keeps the current word in place on reorder', () => {
  // random() 恒为 0：Fisher-Yates 每次都和第 0 位交换，结果确定且不是原顺序
  setListenPrefs({ shuffle: true, repeat: 1, content: 'word' })
  const s = listen.useListenStore.getState()
  s.setItems(WORDS, true)
  const shuffledOrder = listen.useListenStore.getState().order
  expect(shuffledOrder).not.toEqual([0, 1, 2])
  expect(listen.useListenStore.getState().items.map((i) => i.word)).toEqual(['apple', 'pear', 'plum'])
  s.play()
  const playing = listen.useListenStore.getState().currentWord
  setListenPrefs({ shuffle: false })
  s.reorder()
  const after = listen.useListenStore.getState()
  expect(after.order).toEqual([0, 1, 2])
  expect(after.items[after.order[after.pos]].word).toBe(playing)
})

it('pauses when something else starts playing, instead of talking over it', () => {
  const s = listen.useListenStore.getState()
  s.play()
  audio.playTts('The teacher opened the window.', 'sentence')
  expect(listen.useListenStore.getState().status).toBe('paused')
  // 旧段被 stopTts 清空 src 后的 error 不能再推进
  played[0].dispatchEvent(new Event('error'))
  played[0].dispatchEvent(new Event('ended'))
  vi.advanceTimersByTime(5000)
  expect(urls()).toEqual([
    '/api/tts?text=apple&scene=word',
    '/api/tts?text=The teacher opened the window.&scene=sentence',
  ])
})

it('treats an external stopTts as a pause, not as the end of the segment', () => {
  const s = listen.useListenStore.getState()
  s.play()
  audio.stopTts()
  played[0].dispatchEvent(new Event('error'))
  vi.advanceTimersByTime(5000)
  expect(listen.useListenStore.getState().status).toBe('paused')
  expect(urls()).toHaveLength(1)
})

it('skips a segment that fails to load instead of hanging', () => {
  setListenPrefs({ repeat: 1, content: 'word' })
  const s = listen.useListenStore.getState()
  s.play()
  played[0].dispatchEvent(new Event('error'))
  vi.advanceTimersByTime(1000)
  expect(urls()[1]).toBe('/api/tts?text=pear&scene=word')
})

it('re-anchors on the current word when the item list changes underneath it', () => {
  setListenPrefs({ repeat: 1, content: 'word' })
  const s = listen.useListenStore.getState()
  s.play()
  finish(0)
  vi.advanceTimersByTime(1000)
  expect(listen.useListenStore.getState().currentWord).toBe('pear')
  // apple 被标成已掌握、从「未学」筛选里消失
  s.setItems([item('pear'), item('plum')], true)
  const after = listen.useListenStore.getState()
  expect(after.currentWord).toBe('pear')
  expect(after.pos).toBe(0)
  // 正在念的 pear 也从列表里消失（听读曝光后重拉了 filter=new）：当幻影留下念完，不跳到 plum
  s.setItems([item('plum')], true)
  const ghosted = listen.useListenStore.getState()
  expect(ghosted.currentWord).toBe('pear')
  expect(ghosted.items.map((it) => it.word)).toEqual(['plum', 'pear'])
  expect(ghosted.order.map((i) => ghosted.items[i].word)).toEqual(['pear', 'plum'])
  finish(played.length - 1)
  vi.advanceTimersByTime(1000)
  expect(listen.useListenStore.getState().currentWord).toBe('plum')
  // 已经念过去了，再来一份没有 pear 的列表就真的不要它了
  s.setItems([item('plum')], true)
  expect(listen.useListenStore.getState().items.map((it) => it.word)).toEqual(['plum'])
  // 停下来时列表少了当前词，照旧重新定位
  s.stop()
  s.setItems([item('kiwi')], true)
  s.play()
  expect(listen.useListenStore.getState().currentWord).toBe('kiwi')
})

it('resets the queue when the scope changes and refuses to play before it is loaded', () => {
  const s = listen.useListenStore.getState()
  s.play()
  s.setScope('cet4|new')
  expect(listen.useListenStore.getState().status).toBe('idle')
  expect(listen.useListenStore.getState().items).toEqual([])
  s.setItems([item('kiwi')], false)
  s.play()
  expect(listen.useListenStore.getState().status).toBe('idle')
  s.setItems([item('kiwi')], true)
  s.play()
  expect(listen.useListenStore.getState().status).toBe('playing')
})


it('counts a word once when its first segment starts, not on loops or rereads', () => {
  setListenPrefs({ repeat: 1, content: 'word' })
  const s = listen.useListenStore.getState()
  s.play()
  expect(listen.useListenStore.getState().played).toEqual({ word: 'apple', seq: 1 })
  s.readAgain()
  expect(listen.useListenStore.getState().played?.seq).toBe(1)
  s.toggleLoopOne()
  finish(played.length - 1)
  vi.advanceTimersByTime(1000)
  expect(listen.useListenStore.getState().played?.seq).toBe(1)
  s.toggleLoopOne()
  s.next()
  expect(listen.useListenStore.getState().played).toEqual({ word: 'pear', seq: 2 })
  // 暂停再播不算新的一次
  s.pause()
  s.play()
  expect(listen.useListenStore.getState().played?.seq).toBe(2)
})

it('stops after the configured number of distinct words and says why', () => {
  setListenPrefs({ repeat: 1, content: 'word', stopAfter: 2 })
  const s = listen.useListenStore.getState()
  s.play()
  finish(0)
  vi.advanceTimersByTime(1000)
  expect(listen.useListenStore.getState().currentWord).toBe('pear')
  finish(1)
  vi.advanceTimersByTime(1000)
  const st = listen.useListenStore.getState()
  expect(st.status).toBe('paused')
  expect(st.quotaHit).toBe(true)
  expect(st.currentWord).toBe('pear')
  expect(urls()).toHaveLength(2)
})

it('leaves a recall gap between the last word repeat and the meaning', () => {
  setListenPrefs({ repeat: 1, content: 'word_meaning', recallGapS: 2 })
  const s = listen.useListenStore.getState()
  s.play()
  finish(0)
  vi.advanceTimersByTime(1999)
  expect(urls()).toHaveLength(1)
  vi.advanceTimersByTime(1)
  expect(urls()[1]).toBe('/api/tts?text=apple的意思&scene=meaning')
})

it('ignores a partial list while active and re-anchors from the resume point when idle', () => {
  setListenPrefs({ repeat: 1, content: 'word' })
  const s = listen.useListenStore.getState()
  s.play()
  finish(0)
  vi.advanceTimersByTime(1000)
  expect(listen.useListenStore.getState().currentWord).toBe('pear')
  // 回到页面时缓存被回收、先拉到第一页：不能把 3 个词的队列缩成 1 个
  s.setItems([item('apple')], false)
  expect(listen.useListenStore.getState().order).toHaveLength(3)

  // 关掉再开同一范围：装满后停在断点上，不自动播
  s.close()
  s.open('cet4', '四级', 'cet4|all', '/vocab?v=deck&k=cet4')
  s.setItems(WORDS, true)
  const reopened = listen.useListenStore.getState()
  expect(reopened.status).toBe('idle')
  expect(reopened.currentWord).toBe('pear')
  expect(reopened.resumeWord).toBe('pear')
  s.play()
  expect(urls().at(-1)).toBe('/api/tts?text=pear&scene=word')

  s.restart()
  expect(listen.useListenStore.getState().currentWord).toBe('apple')
  expect(resume.useListenResume.getState().lookup('cet4|all')).toBe('apple')
})
