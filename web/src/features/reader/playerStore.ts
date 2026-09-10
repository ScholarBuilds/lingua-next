import { create } from 'zustand'

import {
  getSessionVoice,
  playUrl,
  prefetchTts,
  setChapterInterrupt,
  setPlaybackRate,
  setSessionVoice,
  stopTts,
  ttsUrl,
} from '../../lib/audio'
import { usePrefStore } from '../../lib/prefStore'

export interface PlayableSentence {
  sentenceId: number
  paragraphId: number
  text: string
}

export const PLAY_RATES = [0.75, 1, 1.25, 1.5] as const

const GAP_MS = 300

type PlayerStatus = 'idle' | 'playing' | 'paused'

/** chapter：整章连读逐句推进；single：句按钮单句播放，播完即停（保位待续） */
type PlayMode = 'chapter' | 'single'

/** 当前朗读句滚到视口中央（正文 [data-sid] 节点）。
    smooth 的 scrollIntoView 在容器滚动场景会被静默丢弃（Chromium 实测），
    改为手动计算容器目标位置走 scrollTo；跨度超过约 1.5 屏的远距离跳转
    直接瞬移（远跳无平滑价值，且超长 smooth 动画同样可能被丢弃）。 */
export function scrollToReadingSentence(sentenceId: number): void {
  const el = document.querySelector<HTMLElement>(`[data-sid="${sentenceId}"]`)
  if (!el) return
  const scroller = el.closest<HTMLElement>('.canvas-wrap')
  if (scroller) {
    const er = el.getBoundingClientRect()
    const sr = scroller.getBoundingClientRect()
    const delta = er.top + er.height / 2 - (sr.top + sr.height / 2)
    const behavior: ScrollBehavior =
      Math.abs(delta) > scroller.clientHeight * 1.5 ? 'auto' : 'smooth'
    scroller.scrollTo({ top: scroller.scrollTop + delta, behavior })
  } else {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
}

interface PlayerState {
  /** 控制条显隐（顶栏喇叭开关） */
  visible: boolean
  status: PlayerStatus
  mode: PlayMode
  articleId: string
  sentences: PlayableSentence[]
  index: number
  /** 本会话临时音色；null = 跟随场景默认（服务端配置中心决定） */
  voice: string | null
  rate: number
  /** 跟随滚动总开关（经 prefStore 持久化，默认开） */
  follow: boolean
  /** 手动滚轮临时打断；下一句开播时自动恢复 */
  followSuspended: boolean
  toggleVisible: () => void
  setChapter: (articleId: string, sentences: PlayableSentence[]) => void
  play: () => void
  pause: () => void
  toggle: () => void
  next: () => void
  prev: () => void
  stop: () => void
  cycleRate: () => void
  setRate: (rate: number) => void
  setVoice: (voice: string | null) => void
  setFollow: (follow: boolean) => void
  suspendFollow: () => void
  resumeFollow: () => void
  /** 句末播放按钮：播放指定句；该句正在播则暂停 */
  playSentence: (sentenceId: number) => void
  stepRate: (delta: number) => void
}

/* 代际计数：pause/stop/切句后使旧音频的 ended/error 回调失效 */
let generation = 0
let gapTimer: number | undefined

function clearGap(): void {
  window.clearTimeout(gapTimer)
}

export const usePlayerStore = create<PlayerState>((set, get) => {
  const followScroll = (): void => {
    const { follow, followSuspended, sentences, index } = get()
    const sent = sentences[index]
    if (follow && !followSuspended && sent !== undefined) {
      scrollToReadingSentence(sent.sentenceId)
    }
  }

  const playCurrent = (): void => {
    const { sentences, index, voice, rate, mode } = get()
    const sent = sentences[index]
    if (!sent) {
      get().stop()
      return
    }
    const gen = ++generation
    clearGap()
    // 新句开播时恢复被滚轮临时打断的跟随，并定位当前句
    set({ status: 'playing', followSuspended: false })
    followScroll()
    // 整章连读走 chapter 场景，句按钮单句走 sentence 场景（服务端按场景取默认音色）
    const scene = mode === 'single' ? 'sentence' : 'chapter'
    const audio = playUrl(ttsUrl(sent.text, scene, voice), rate)
    // 连读预取下一句，服务端文件缓存/浏览器 HTTP 缓存接住
    if (mode === 'chapter') {
      const nextSent = sentences[index + 1]
      if (nextSent) prefetchTts(ttsUrl(nextSent.text, scene, voice))
    }
    const advance = (): void => {
      if (gen !== generation || get().status !== 'playing') return
      // 单句模式播完即停，保留位置供整章续播
      if (get().mode === 'single') {
        set({ status: 'paused' })
        return
      }
      if (get().index + 1 >= get().sentences.length) {
        get().stop()
        return
      }
      gapTimer = window.setTimeout(() => {
        if (gen !== generation || get().status !== 'playing') return
        set({ index: get().index + 1 })
        playCurrent()
      }, GAP_MS)
    }
    audio.addEventListener('ended', advance)
    audio.addEventListener('error', advance)
  }

  return {
    visible: false,
    status: 'idle',
    mode: 'chapter',
    articleId: '',
    sentences: [],
    index: 0,
    voice: getSessionVoice(),
    rate: 1,
    follow: usePrefStore.getState().prefs.reader.follow,
    followSuspended: false,

    toggleVisible: () => {
      const visible = !get().visible
      if (!visible) get().stop()
      set({ visible })
    },

    setChapter: (articleId, sentences) => {
      if (get().articleId === articleId) {
        set({ sentences })
        return
      }
      generation++
      clearGap()
      stopTts()
      set({
        articleId,
        sentences,
        index: 0,
        status: 'idle',
        mode: 'chapter',
        followSuspended: false,
      })
    },

    play: () => {
      if (get().sentences.length === 0) return
      set({ mode: 'chapter' })
      playCurrent()
    },

    pause: () => {
      generation++
      clearGap()
      stopTts()
      set({ status: 'paused' })
    },

    toggle: () => {
      if (get().status === 'playing') get().pause()
      else get().play()
    },

    next: () => {
      const { index, sentences, status } = get()
      if (index + 1 >= sentences.length) return
      set({ index: index + 1, mode: 'chapter' })
      if (status === 'playing') playCurrent()
      else followScroll()
    },

    prev: () => {
      const { index, status } = get()
      if (index <= 0) return
      set({ index: index - 1, mode: 'chapter' })
      if (status === 'playing') playCurrent()
      else followScroll()
    },

    stop: () => {
      generation++
      clearGap()
      stopTts()
      set({ status: 'idle', index: 0, mode: 'chapter' })
    },

    /** 双向调速（快捷键 [ / ]）：夹在两端不回绕，避免"最快再按一下变最慢" */
    stepRate: (delta) => {
      const rates: readonly number[] = PLAY_RATES
      const i = rates.indexOf(get().rate)
      const next = rates[Math.min(rates.length - 1, Math.max(0, (i < 0 ? 1 : i) + delta))]
      if (next === get().rate) return
      set({ rate: next })
      setPlaybackRate(next)
    },

    cycleRate: () => {
      const rates: readonly number[] = PLAY_RATES
      const next = rates[(rates.indexOf(get().rate) + 1) % rates.length]
      set({ rate: next })
      setPlaybackRate(next)
    },

    setRate: (rate) => {
      set({ rate })
      setPlaybackRate(rate)
    },

    setVoice: (voice) => {
      // 仅记为会话覆盖，不落盘：默认音色由设置页的场景绑定决定
      setSessionVoice(voice)
      set({ voice })
      if (get().status === 'playing') playCurrent()
    },

    setFollow: (follow) => {
      usePrefStore.getState().update({ reader: { follow } })
      set({ follow, followSuspended: false })
      if (follow && get().status !== 'idle') followScroll()
    },

    suspendFollow: () => {
      const s = get()
      if (s.status !== 'idle' && s.follow && !s.followSuspended) {
        set({ followSuspended: true })
      }
    },

    resumeFollow: () => set({ followSuspended: false }),

    playSentence: (sentenceId) => {
      const { sentences, index, status } = get()
      const idx = sentences.findIndex((s) => s.sentenceId === sentenceId)
      if (idx < 0) return
      // 该句正在播 → 暂停（再点=暂停）
      if (idx === index && status === 'playing') {
        get().pause()
        return
      }
      set({ index: idx, mode: 'single' })
      playCurrent()
    },
  }
})

/* 点词/点句朗读时暂停整章连读（不自动恢复） */
setChapterInterrupt(() => {
  const s = usePlayerStore.getState()
  if (s.status === 'playing') {
    generation++
    clearGap()
    usePlayerStore.setState({ status: 'paused' })
  }
})
