/* TTS 播放：全局单例，新播放自动停掉上一段。
   整章连读与点词/点句朗读互斥：一次性朗读开始前先触发 chapterInterrupt
   暂停整章连读，播完不自动恢复（由用户点播放继续）。

   场景化：请求带 scene 不带 voice，默认音色由服务端按配置中心的
   场景绑定决定；仅当用户在朗读条临时选过音色时本会话携带 voice
   覆盖（不持久化，刷新即回到场景默认）。

   按词钉死的音色（FR-495）优先级高于会话音色、低于调用方显式传的 voice：
   它必须体现在 URL 上——TTS 文件响应带 7 天浏览器缓存，服务端在同一个
   URL 上悄悄换音色，用户换完听到的还是旧声。 */

export type TtsScene = 'word' | 'sentence' | 'chapter' | 'vocab' | 'video' | 'assistant' | 'meaning'

export interface WordVoice {
  /** 带前缀、可直接回填 `?voice=` 的音色标识 */
  voice: string
  /** 百分比语速，0 = 不传 */
  rate: number
}

/** 只有「单词本身」的两个场景吃按词覆盖；例句、释义各走各的场景绑定 */
const WORD_SCENES: ReadonlySet<TtsScene> = new Set(['word', 'vocab'])

let sessionVoice: string | null = null
let wordVoices: ReadonlyMap<string, WordVoice> = new Map()
/* 清过缓存的代号（FR-499）：>0 时每个 TTS URL 带 e=，浏览器 7 天缓存才会失效；
   0 不加参数，既有 URL 形状不变 */
let ttsEpoch = 0
let current: HTMLAudioElement | null = null
let chapterInterrupt: (() => void) | null = null
const preloaded = new Map<string, HTMLAudioElement>()
let speechInterrupt: (() => void) | null = null
const playbackListeners = new Set<() => void>()

export function beforeAudioPlay(listener: () => void): () => void {
  playbackListeners.add(listener)
  return () => { playbackListeners.delete(listener) }
}

export function prefetchTts(url: string): void {
  if (preloaded.has(url) || current?.getAttribute('src') === url) return
  const audio = new Audio(url)
  audio.preload = 'auto'
  preloaded.set(url, audio)
  audio.addEventListener('error', () => preloaded.delete(url), { once: true })
  audio.load()
  while (preloaded.size > 2) {
    const entry = preloaded.entries().next().value
    if (!entry) break
    preloaded.delete(entry[0])
    entry[1].src = ''
  }
}

export function getSessionVoice(): string | null {
  return sessionVoice
}

/** 朗读条临时换音色；null = 回到场景默认 */
export function setSessionVoice(voice: string | null): void {
  sessionVoice = voice
  clearTtsPrefetch()
}

export function clearTtsPrefetch(): void {
  preloaded.forEach((audio) => { audio.src = '' })
  preloaded.clear()
}

/** 整张按词音色表由 App 桥接从服务端灌入；换表即作废预取（URL 变了） */
export function setWordVoices(map: ReadonlyMap<string, WordVoice>): void {
  wordVoices = map
  clearTtsPrefetch()
}

export function setTtsEpoch(n: number): void {
  if (n === ttsEpoch) return
  ttsEpoch = n
  clearTtsPrefetch()
}

export function wordVoiceFor(text: string): WordVoice | null {
  return wordVoices.get(text.trim().toLowerCase()) ?? null
}

/** voice 三态：undefined = 按词覆盖 → 会话音色 → 场景默认；null = 场景默认；串 = 显式指定 */
export function ttsUrl(
  text: string,
  scene: TtsScene = 'sentence',
  voice?: string | null,
  rate = 0,
): string {
  let chosen = voice
  let chosenRate = rate
  if (voice === undefined) {
    const pinned = WORD_SCENES.has(scene) ? wordVoiceFor(text) : null
    if (pinned !== null) {
      chosen = pinned.voice
      chosenRate = pinned.rate
    } else {
      chosen = sessionVoice
    }
  }
  const q = new URLSearchParams({ text, scene })
  if (chosen !== null && chosen !== undefined && chosen !== '') q.set('voice', chosen)
  if (chosenRate !== 0) q.set('rate', String(chosenRate))
  if (ttsEpoch > 0) q.set('e', String(ttsEpoch))
  return `/api/tts?${q.toString()}`
}

/** 整章连读注册打断回调；卸载时传 null 注销 */
export function setChapterInterrupt(fn: (() => void) | null): void {
  chapterInterrupt = fn
}

/** 点词/点句一次性朗读 */
export function playTts(text: string, scene: TtsScene = 'sentence'): void {
  chapterInterrupt?.()
  playUrl(ttsUrl(text, scene))
}

/** 口音音色（FR-131）：edge 免费档，任何词都能出声。
    真人录音（Wiktionary）覆盖不齐，且实测 dictionaryapi.dev 的媒体站整体 502，
    所以录音只做增强、TTS 才是可靠主档。 */
export const ACCENT_VOICES = { uk: 'edge:en-GB-SoniaNeural', us: 'edge:en-US-AriaNeural' } as const
export type Accent = keyof typeof ACCENT_VOICES

/** 按口音朗读单词：有真人录音先试录音，失败静默落回 TTS */
export function playWordAccent(word: string, accent: Accent, hasAudio: boolean): void {
  chapterInterrupt?.()
  const fallback = () => playUrl(ttsUrl(word, 'word', ACCENT_VOICES[accent]))
  if (!hasAudio) {
    fallback()
    return
  }
  const el = playUrl(`/api/dict/${encodeURIComponent(word)}/audio?accent=${accent}`)
  el.addEventListener('error', fallback, { once: true })
}

/** 底层播放：停掉上一段后播放指定地址，返回元素供调用方挂事件 */
export function playUrl(url: string, rate = 1): HTMLAudioElement {
  playbackListeners.forEach((listener) => listener())
  stopTts()
  const audio = preloaded.get(url) ?? new Audio(url)
  preloaded.delete(url)
  audio.playbackRate = rate
  current = audio
  void audio.play().catch(() => {
    audio.dispatchEvent(new Event('error'))
  })
  return audio
}

/** 倍速切换时对正在播放的音频即时生效 */
export function setPlaybackRate(rate: number): void {
  if (current) current.playbackRate = rate
}

export function stopTts(): void {
  const interrupt = speechInterrupt
  speechInterrupt = null
  interrupt?.()
  if (current) {
    current.pause()
    current.src = ''
    current = null
  }
}

export function createSpeechQueue(onError: () => void) {
  stopTts()
  const pending: string[] = []
  let active: HTMLAudioElement | null = null
  let cancelled = false
  const cancel = () => { cancelled = true; pending.length = 0 }
  speechInterrupt = cancel
  const next = () => {
    if (cancelled || active || !pending.length) return
    const url = pending.shift()!
    speechInterrupt = null
    active = playUrl(url)
    speechInterrupt = cancel
    if (pending[0]) prefetchTts(pending[0])
    active.addEventListener('ended', () => { active = null; next() }, { once: true })
    active.addEventListener('error', () => { if (!cancelled) { cancel(); onError() } }, { once: true })
  }
  return {
    enqueue(text: string) {
      if (cancelled) return
      const url = ttsUrl(text)
      pending.push(url)
      if (active && pending.length === 1) prefetchTts(url)
      next()
    },
    stop() {
      cancel()
      if (speechInterrupt === cancel) stopTts()
    },
  }
}

/** 助理场景的一句话朗读（早报「念一遍」、例程产出）：走场景 assistant 的音色绑定 */
export function speakAssistant(text: string): void {
  stopTts()
  if (!text) return
  playUrl(ttsUrl(text, 'assistant'))
}
