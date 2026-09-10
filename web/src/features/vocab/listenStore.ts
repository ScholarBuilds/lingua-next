/* 听读连播（FR-485~494、FR-500、FR-504、FR-506）：词汇本的播放器，照 reader/playerStore 的写法。

   一个词 = 一串段：`word × repeat` →（可选，中间可留回想停顿）释义 →（可选）例句，段与段
   之间按类型留空档，词末留 `gapS`。身份是词不是索引——`mark` 之后 `filter=new`
   会让词从列表里消失、索引整体前移，靠索引的话高亮会跳到别的词上。

   打断规则（BR-186）：别处任何 `playUrl`（点例句、开词卡、试听）都先把这里置
   paused；被外部 `stopTts()` 停掉的段以 `error && src==''` 识别，同样转 paused，
   而不是当「播完了」推进下一词——那样会把用户刚点的朗读踩掉。

   单词循环（BR-183）是播放模式：切词后对新词继续，再按一次才关。
   跨页常驻（BR-184）：store 全局，离开词汇本照常念，页面回来重新挂上；
   队列只在范围变化或换本时重建，部分装载的列表不能把正在念的队列缩短。 */

import { create } from 'zustand'
import { toast } from 'sonner'

import type { DeckItem } from '../../lib/api-deck'
import { beforeAudioPlay, playUrl, prefetchTts, stopTts, ttsUrl, type TtsScene } from '../../lib/audio'
import { usePrefStore } from '../../lib/prefStore'
import { useListenResume } from './listenResume'
import { spokenMeaning } from './spokenMeaning'

export type ListenStatus = 'idle' | 'playing' | 'paused'
export type ListenStep = 'word' | 'meaning' | 'example'

interface Segment {
  step: ListenStep
  text: string
  scene: TtsScene
}

/** 同一个词连读两遍之间的空档；释义 / 例句紧跟不留空（回想停顿另算） */
const REPEAT_GAP_MS = 400

interface ListenState {
  visible: boolean
  deckKey: string
  deckName: string
  /** 本 + 筛选 + 排序 + 搜索 + 场景拼成的键：范围一变就停（BR-182） */
  scopeKey: string
  /** 打开听读时所在的页面地址，迷你条「回到单词本」用它 */
  route: string
  /** 停靠条是否挂在页面上；不在时由 App 级迷你条接管 */
  barMounted: boolean
  items: DeckItem[]
  /** 播放顺序：items 的索引置换。洗牌只动它，网格顺序不变（BR-185） */
  order: number[]
  /** 在 order 里的位置 */
  pos: number
  /** 当前词内的段序号 */
  seg: number
  currentWord: string | null
  status: ListenStatus
  step: ListenStep
  loopOne: boolean
  /** 队列装满（分页拉完）才允许开播 */
  loaded: boolean
  /** 一个词的第一段开播就记一次（同词循环不重复）：曝光计数与「念满 N 个停」都靠它 */
  played: { word: string; seq: number } | null
  /** 本轮已念的不同词数（念满 N 个停用） */
  playedCount: number
  /** 「念满 N 个停」触发过：条上说明为什么停了 */
  quotaHit: boolean
  /** 装载时从断点定位到的词：条上提示「从这里继续」 */
  resumeWord: string | null
  open: (deckKey: string, deckName: string, scopeKey: string, route: string) => void
  close: () => void
  setItems: (items: DeckItem[], loaded: boolean) => void
  setScope: (scopeKey: string) => void
  setBarMounted: (mounted: boolean) => void
  play: () => void
  pause: () => void
  toggle: () => void
  stop: () => void
  /** 回到第一个词并清掉断点 */
  restart: () => void
  next: () => void
  prev: () => void
  /** 点卡片 / 媒体键跳到某个词：不管之前是不是在播，跳过去就播 */
  jumpTo: (word: string) => void
  readAgain: () => void
  toggleLoopOne: () => void
  /** 洗牌开关变化后重排，当前词留在原位 */
  reorder: () => void
}

/* 代际计数：pause / stop / 切词 / 被打断后使旧音频的 ended / error 回调失效 */
let generation = 0
let gapTimer: number | undefined
/* 自己发起的 playUrl 也会触发 beforeAudioPlay，用它把自己排除 */
let selfPlay = false
/* 上一次计过数的词：同一个词循环念不重复计 */
let lastCounted: string | null = null
let random: () => number = Math.random

/** 测试注入确定性随机源 */
export function configureListenRandom(fn: () => number): void {
  random = fn
}

function clearGap(): void {
  window.clearTimeout(gapTimer)
}

function sequential(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i)
}

function shuffled(indices: number[]): number[] {
  const out = [...indices]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export function segmentsOf(
  item: DeckItem,
  prefs: { content: string; repeat: number; meaningScope?: 'first' | 'all' },
): Segment[] {
  const segs: Segment[] = []
  for (let i = 0; i < Math.max(1, prefs.repeat); i++) {
    segs.push({ step: 'word', text: item.word, scene: 'word' })
  }
  if (prefs.content !== 'word') {
    const meaning = spokenMeaning(item.translation, { scope: prefs.meaningScope ?? 'first' })
    if (meaning !== '') segs.push({ step: 'meaning', text: meaning, scene: 'meaning' })
  }
  if (prefs.content === 'word_meaning_example' && item.example_en) {
    segs.push({ step: 'example', text: item.example_en, scene: 'sentence' })
  }
  return segs
}

function listenPrefs() {
  return usePrefStore.getState().prefs.listen
}

const EMPTY_QUEUE = {
  items: [] as DeckItem[],
  order: [] as number[],
  pos: 0,
  seg: 0,
  currentWord: null as string | null,
  status: 'idle' as ListenStatus,
  loaded: false,
  played: null as { word: string; seq: number } | null,
  playedCount: 0,
  quotaHit: false,
  resumeWord: null as string | null,
}

export const useListenStore = create<ListenState>((set, get) => {
  const itemAt = (pos: number): DeckItem | undefined => {
    const { items, order } = get()
    const idx = order[pos]
    return idx === undefined ? undefined : items[idx]
  }

  const halt = (): void => {
    generation++
    clearGap()
    stopTts()
  }

  const resetCounting = (): void => {
    lastCounted = null
  }

  const advanceWord = (): void => {
    const { loopOne, pos, order } = get()
    const prefs = listenPrefs()
    if (prefs.stopAfter > 0 && get().playedCount >= prefs.stopAfter && !loopOne) {
      // 念满了：停在当前词，条上说明；再按播放接着数
      generation++
      clearGap()
      set({ status: 'paused', quotaHit: true, playedCount: 0 })
      return
    }
    if (loopOne) {
      set({ seg: 0 })
      playSegment()
      return
    }
    if (pos + 1 < order.length) {
      set({ pos: pos + 1, seg: 0 })
      playSegment()
      return
    }
    if (!prefs.loopAll || order.length === 0) {
      get().stop()
      return
    }
    // 从头再来：洗牌时重洗，且别让新一轮的第一个词就是刚念完的那个
    let nextOrder = prefs.shuffle ? shuffled(order) : sequential(order.length)
    if (prefs.shuffle && nextOrder.length > 1 && nextOrder[0] === order[order.length - 1]) {
      nextOrder = [nextOrder[1], nextOrder[0], ...nextOrder.slice(2)]
    }
    set({ order: nextOrder, pos: 0, seg: 0 })
    playSegment()
  }

  const playSegment = (): void => {
    const s = get()
    const item = itemAt(s.pos)
    if (item === undefined) {
      get().stop()
      return
    }
    const prefs = listenPrefs()
    const segs = segmentsOf(item, prefs)
    const seg = segs[s.seg]
    if (seg === undefined) {
      advanceWord()
      return
    }
    const gen = ++generation
    clearGap()
    const patch: Partial<ListenState> = {
      status: 'playing',
      step: seg.step,
      currentWord: item.word,
      quotaHit: false,
    }
    if (s.seg === 0 && item.word !== lastCounted) {
      lastCounted = item.word
      patch.played = { word: item.word, seq: (s.played?.seq ?? 0) + 1 }
      patch.playedCount = s.playedCount + 1
      useListenResume.getState().remember(s.scopeKey, item.word, {
        deckName: s.deckName, route: s.route, position: s.pos, total: s.order.length,
      })
    }
    set(patch)
    selfPlay = true
    const audio = playUrl(ttsUrl(seg.text, seg.scene), prefs.rate)
    selfPlay = false

    const following = segs[s.seg + 1]
    if (following !== undefined) prefetchTts(ttsUrl(following.text, following.scene))
    else {
      const upcoming = itemAt(s.pos + 1)
      if (upcoming !== undefined) prefetchTts(ttsUrl(upcoming.word, 'word'))
    }

    const stale = () => gen !== generation || get().status !== 'playing'
    const onEnded = (): void => {
      if (stale()) return
      let delay: number
      if (following === undefined) delay = prefs.gapS * 1000
      else if (following.step === 'word') delay = REPEAT_GAP_MS
      else if (following.step === 'meaning') delay = prefs.recallGapS * 1000
      else delay = 0
      gapTimer = window.setTimeout(() => {
        if (stale()) return
        if (following === undefined) {
          advanceWord()
          return
        }
        set({ seg: s.seg + 1 })
        playSegment()
      }, delay)
    }
    audio.addEventListener('ended', onEnded, { once: true })
    audio.addEventListener(
      'error',
      () => {
        if (stale()) return
        // src 被清空 = 别处 stopTts() 停的，不是这段坏了：停在这里等用户
        if (audio.getAttribute('src') === '') {
          generation++
          clearGap()
          set({ status: 'paused' })
          return
        }
        onEnded()
      },
      { once: true },
    )
  }

  const moveTo = (pos: number): void => {
    const item = itemAt(pos)
    if (item === undefined) return
    set({ pos, seg: 0, currentWord: item.word, resumeWord: null })
    if (get().status === 'playing') playSegment()
  }

  return {
    visible: false,
    deckKey: '',
    deckName: '',
    scopeKey: '',
    route: '',
    barMounted: false,
    loopOne: false,
    step: 'word',
    ...EMPTY_QUEUE,

    open: (deckKey, deckName, scopeKey, route) => {
      const s = get()
      if (s.visible && s.deckKey === deckKey && s.scopeKey === scopeKey) return
      halt()
      resetCounting()
      set({ visible: true, deckKey, deckName, scopeKey, route, ...EMPTY_QUEUE })
    },

    close: () => {
      halt()
      resetCounting()
      set({ visible: false, status: 'idle', currentWord: null, loopOne: false, played: null })
    },

    setItems: (items, loaded) => {
      const s = get()
      // 播放中拿到的部分列表（回来时缓存被回收、重拉第一页）不能把队列缩短
      if (s.status !== 'idle' && !loaded) return
      const prefs = listenPrefs()
      /* 正在念的词不在新列表里（`filter=new` 下它刚变学习中、列表重拉了）：把旧项接在末尾当幻影，
         按原位置留在队列里念完再走，不让它被挤出、也不跳词。网格上不显示它，播放条照常 */
      let list = items
      const byWord = new Map(items.map((it, i) => [it.word, i]))
      if (s.status !== 'idle' && s.currentWord !== null && !byWord.has(s.currentWord)) {
        const ghost = s.items.find((it) => it.word === s.currentWord)
        if (ghost !== undefined) {
          list = [...items, ghost]
          byWord.set(ghost.word, list.length - 1)
        }
      }
      items = list
      let order: number[]
      if (s.status === 'idle') {
        order = prefs.shuffle ? shuffled(sequential(items.length)) : sequential(items.length)
      } else {
        // 播放中列表变了（标记后从筛选里消失、续拉了一页）：保住已有顺序，新词接在后面
        const kept: number[] = []
        for (const idx of s.order) {
          const word = s.items[idx]?.word
          const at = word === undefined ? undefined : byWord.get(word)
          if (at !== undefined) kept.push(at)
        }
        const seen = new Set(kept)
        const added = sequential(items.length).filter((i) => !seen.has(i))
        order = [...kept, ...(prefs.shuffle ? shuffled(added) : added)]
      }
      let current = s.currentWord
      let resumeWord = s.resumeWord
      if (current === null && s.status === 'idle' && loaded) {
        // 装满后按断点定位：只高亮不自动播，让用户决定接着来还是从头
        const remembered = useListenResume.getState().lookup(s.scopeKey)
        if (remembered !== null && byWord.has(remembered)) {
          current = remembered
          resumeWord = remembered
        } else if (remembered !== null && !s.loaded) {
          toast.info('上次听读的词已不在当前范围，可从第一词开始。')
        }
      }
      let pos = current === null ? 0 : order.findIndex((i) => items[i]?.word === current)
      if (pos < 0) pos = Math.min(s.pos, Math.max(0, order.length - 1))
      const currentWord = current === null ? null : (items[order[pos]]?.word ?? null)
      set({ items, order, pos, loaded, currentWord, resumeWord })
    },

    setScope: (scopeKey) => {
      if (get().scopeKey === scopeKey) return
      halt()
      resetCounting()
      set({ scopeKey, ...EMPTY_QUEUE })
    },

    setBarMounted: (mounted) => {
      if (get().barMounted !== mounted) set({ barMounted: mounted })
    },

    play: () => {
      const s = get()
      if (!s.loaded || s.order.length === 0) return
      playSegment()
    },

    pause: () => {
      halt()
      set({ status: 'paused' })
    },

    toggle: () => {
      if (get().status === 'playing') get().pause()
      else get().play()
    },

    stop: () => {
      halt()
      resetCounting()
      useListenResume.getState().forget(get().scopeKey)
      set({ status: 'idle', pos: 0, seg: 0, currentWord: null, playedCount: 0, resumeWord: null })
    },

    restart: () => {
      const { status, scopeKey } = get()
      useListenResume.getState().forget(scopeKey)
      resetCounting()
      const first = itemAt(0)
      set({
        pos: 0,
        seg: 0,
        currentWord: first?.word ?? null,
        resumeWord: null,
        playedCount: 0,
        quotaHit: false,
      })
      if (status === 'playing') playSegment()
    },

    next: () => {
      const { pos, order } = get()
      if (pos + 1 < order.length) moveTo(pos + 1)
      else if (listenPrefs().loopAll && order.length > 0) moveTo(0)
    },

    prev: () => {
      const { pos } = get()
      if (pos > 0) moveTo(pos - 1)
      else moveTo(0)
    },

    jumpTo: (word) => {
      const { order, items, loaded } = get()
      if (!loaded) return
      const pos = order.findIndex((i) => items[i]?.word === word)
      if (pos < 0) return
      set({ pos, seg: 0, currentWord: word, resumeWord: null })
      playSegment()
    },

    readAgain: () => {
      if (!get().loaded) return
      set({ seg: 0 })
      playSegment()
    },

    toggleLoopOne: () => set({ loopOne: !get().loopOne }),

    reorder: () => {
      const s = get()
      const currentIdx = s.order[s.pos]
      const prefs = listenPrefs()
      let order = prefs.shuffle ? shuffled(sequential(s.items.length)) : sequential(s.items.length)
      let pos = s.pos
      if (currentIdx !== undefined) {
        const at = order.indexOf(currentIdx)
        if (prefs.shuffle) {
          // 当前词留在原位：把它换到 pos 上，进度数字不跳
          const target = Math.min(pos, order.length - 1)
          ;[order[at], order[target]] = [order[target], order[at]]
          pos = target
        } else {
          pos = at
        }
      }
      set({ order, pos })
    },
  }
})

/* 别处开播（点例句、开词卡、试听）时先停在这里；不 stopTts——紧接着的 playUrl 会停 */
beforeAudioPlay(() => {
  if (selfPlay) return
  if (useListenStore.getState().status === 'playing') {
    generation++
    clearGap()
    useListenStore.setState({ status: 'paused' })
  }
})
