/* 全局偏好：服务端整包存储（GET/PUT /api/config/prefs），localStorage 缓存兜底。
   首次运行从散落的旧键（ln-theme / ln-tts-follow / ln-panel-click-words /
   ln-vocab-autoplay / ln-mascot-*）迁移，保持既有用户行为不变。
   消费侧（playerStore / readerStore / mascotStore / 主题与译文样式）经
   App 内的 PrefsBridge 单向同步，写路径统一走 update()（写透 PUT，防抖 600ms）。 */

import { create } from 'zustand'
import { toast } from 'sonner'

import { apiConfig } from './api-config'
import { themeFromLegacy } from './theme-legacy'
import type { ThemePref } from './theme-legacy'
export type { ThemePref } from './theme-legacy'


/** 双语译文样式：muted=弱化灰（默认）/ ink=与正文同色 / compact=紧凑 */
export type TransStyle = 'muted' | 'ink' | 'compact'

/** 应用导航布局：side=左侧图标栏（默认）/ top=顶部横条 */
export type NavLayout = 'side' | 'top'

/** 正文字体族：衬线（默认，长文更省力）/ 无衬线 / 等宽 / 阅读障碍友好 */
export type ReaderFont = 'serif' | 'sans' | 'mono' | 'dyslexic'
export const READER_FONTS: ReaderFont[] = ['serif', 'sans', 'mono', 'dyslexic']

/** 纸张主题：跟随全局深浅色 / 纸白 / 米黄 / 护眼绿 / 夜间 / 高对比 */
export type PaperTheme = 'auto' | 'paper' | 'sepia' | 'green' | 'night' | 'contrast'
export const PAPER_THEMES: PaperTheme[] = ['auto', 'paper', 'sepia', 'green', 'night', 'contrast']

/** 拆开记形式：两者 / 只音节 / 只词素 / 关闭 */
export type BreakdownMode = 'both' | 'syllable' | 'morpheme' | 'off'
export const BREAKDOWN_MODES: BreakdownMode[] = ['both', 'syllable', 'morpheme', 'off']

export interface AppPrefs {
  today: { pinned: string[]; deferred: Record<string, string> }
  theme: ThemePref
  talk: { autoCoach: boolean; translationOpen: boolean; repliesOpen: boolean }
  ui: {
    rememberPosition: boolean
    navLayout: NavLayout
    /* 侧栏折叠成纯图标。默认展开：图标分不清「内容库/词汇资产/视频资产」——
       三者的差别在修饰语不在中心词，画出来都是「一堆集合」。
       折叠态能用靠的是位置记忆（在展开态学过第 2 项是什么），
       所以首次访问必须是展开的。 */
    navCollapsed: boolean
  }
  reader: {
    /** 朗读跟随滚动 */
    follow: boolean
    /** 右栏英文可点词 */
    clickableWords: boolean
    transStyle: TransStyle
    /** 进入双语/译文模式是否自动整篇翻译（FR-374：默认关，翻译要用户点） */
    autoTranslate: boolean
    /** ══ 排版（FR-375）══ */
    font: ReaderFont
    fontSize: number
    lineHeight: number
    /** 正文栏宽 px */
    pageWidth: number
    /** 段间距倍数 */
    paragraphGap: number
    letterSpacing: number
    justify: boolean
    paperTheme: PaperTheme
    /** 生词悬浮小译（FR-381） */
    wordLens: boolean
    /** 自动滚动速度 px/s（FR-383） */
    autoScrollSpeed: number
    /** 阅读器朗读音色，null 表示跟随设置里的场景绑定（FR-373） */
    voice: string | null
  }
  vocab: {
    /** 背单词新卡自动发音 */
    autoplay: boolean
    /** 拆开记的呈现形式（FR-328） */
    breakdown: BreakdownMode
  }
  mascot: {
    enabled: boolean
    modelId: string | null
  }
  /* 背单词的显示遮挡。两个开关互斥：一次只能藏一边，
     两边都藏等于卡片全空，那不是自测是空白。纯前端偏好，服务端不读。 */
  study: {
    /** 藏中文（释义与例句译文）：看英文回想意思 */
    hideZh: boolean
    /** 藏英文（单词与例句原文）：看中文回想单词 */
    hideEn: boolean
  }
  /* 场景速记的选项。跟着人走而不是跟着本走：换一本还得重配一遍的话，
     用户第二次就不会再动它了。 */
  drill: {
    /** 认词方向：看英文想中文 / 看中文想英文 / 混着来 */
    dir: 'en2zh' | 'zh2en' | 'mix'
    showPhonetic: boolean
    showExample: boolean
    autoSpeak: boolean
  }
  /* 听读连播（FR-485）。跟着人走同 drill；单词循环是会话态不在这儿 */
  listen: {
    /** 每个词念什么：只念词 / 词+释义 / 词+释义+例句 */
    content: ListenContent
    /** 单词念几遍 */
    repeat: number
    /** 词与词之间空几秒 */
    gapS: number
    rate: number
    shuffle: boolean
    /** 播到末尾从头再来，关着就停 */
    loopAll: boolean
    /** 释义只念第一个词性，还是带着词性名把全部词性念完 */
    meaningScope: ListenMeaningScope
    /** 单词念完留几秒回想再念释义（0 = 不留） */
    recallGapS: number
    /** 念满 N 个不同的词自动停（0 = 不限） */
    stopAfter: number
  }
}

export type ListenContent = 'word' | 'word_meaning' | 'word_meaning_example'
export type ListenMeaningScope = 'first' | 'all'
export const LISTEN_CONTENTS: ListenContent[] = ['word', 'word_meaning', 'word_meaning_example']
export const LISTEN_MEANING_SCOPES: ListenMeaningScope[] = ['first', 'all']
export const LISTEN_REPEATS = [1, 2, 3, 5] as const
export const LISTEN_GAPS = [0.5, 1, 2, 3] as const
export const LISTEN_RECALL_GAPS = [0, 1, 2, 3] as const
export const LISTEN_STOP_AFTER = [0, 10, 20, 50] as const

export interface PrefPatch {
  today?: Partial<AppPrefs['today']>
  theme?: ThemePref
  talk?: Partial<AppPrefs['talk']>
  ui?: Partial<AppPrefs['ui']>
  reader?: Partial<AppPrefs['reader']>
  vocab?: Partial<AppPrefs['vocab']>
  mascot?: Partial<AppPrefs['mascot']>
  study?: Partial<AppPrefs['study']>
  drill?: Partial<AppPrefs['drill']>
  listen?: Partial<AppPrefs['listen']>
}

const CACHE_KEY = 'ln-prefs'
const PENDING_KEY = 'ln-prefs-pending'

function readCache(key: string): string | null {
  try { return localStorage.getItem(key) }
  catch { return null }
}

function migratedDefaults(): AppPrefs {
  const legacyTheme = readCache('ln-theme')
  return {
    theme: themeFromLegacy(legacyTheme),
    today: { pinned: [], deferred: {} },
    talk: { autoCoach: true, translationOpen: true, repliesOpen: true },
    ui: { navLayout: 'side', navCollapsed: false, rememberPosition: true },
    reader: {
      follow: readCache('ln-tts-follow') !== '0',
      clickableWords: readCache('ln-panel-click-words') !== '0',
      transStyle: 'muted',
      autoTranslate: false,
      font: 'serif',
      fontSize: 19,
      lineHeight: 1.9,
      pageWidth: 760,
      paragraphGap: 1,
      letterSpacing: 0,
      justify: false,
      paperTheme: 'auto',
      wordLens: false,
      autoScrollSpeed: 40,
      voice: null,
    },
    vocab: { autoplay: readCache('ln-vocab-autoplay') !== '0', breakdown: 'both' },
    // 默认两边都显示：遮挡是自测时才开的，进来先看得见才正常
    study: { hideZh: false, hideEn: false },
    drill: { dir: 'en2zh', showPhonetic: true, showExample: true, autoSpeak: true },
    listen: {
      content: 'word_meaning',
      repeat: 2,
      gapS: 1,
      rate: 1,
      shuffle: false,
      loopAll: false,
      meaningScope: 'first',
      recallGapS: 0,
      stopAfter: 0,
    },
    mascot: {
      enabled: readCache('ln-mascot-on') !== '0',
      modelId: readCache('ln-mascot-model'),
    },
  }
}

function bool(v: unknown, d: boolean): boolean {
  return typeof v === 'boolean' ? v : d
}

/** 数值型偏好：非数字或越界一律回落基准，避免存进非法值把排版搞崩 */
function num(v: unknown, d: number, min: number, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : d
}

function sub(r: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = r[key]
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

/** 未知来源 JSON 宽松合并进基准（逐字段类型校验，非法值保留基准） */
export function mergePrefs(base: AppPrefs, raw: unknown): AppPrefs {
  const r = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const ui = sub(r, 'ui')
  const reader = sub(r, 'reader')
  const vocab = sub(r, 'vocab')
  const study = sub(r, 'study')
  const drill = sub(r, 'drill')
  const listen = sub(r, 'listen')
  const mascot = sub(r, 'mascot')
  const theme = r.theme
  const talk = sub(r, 'talk')
  const today = sub(r, 'today')
  const trans = reader.transStyle
  const nav = ui.navLayout
  return {
    theme: theme === 'light' || theme === 'dark' || theme === 'system' ? theme : base.theme,
    today: {
      pinned: Array.isArray(today.pinned) && today.pinned.every(v => typeof v === 'string') ? today.pinned : base.today.pinned,
      deferred: today.deferred && typeof today.deferred === 'object' && !Array.isArray(today.deferred)
        ? Object.fromEntries(Object.entries(today.deferred).filter(([, value]) => typeof value === 'string')) as Record<string, string> : base.today.deferred,
    },
    talk: {
      autoCoach: bool(talk.autoCoach, base.talk?.autoCoach ?? true),
      translationOpen: bool(talk.translationOpen, base.talk?.translationOpen ?? true),
      repliesOpen: bool(talk.repliesOpen, base.talk?.repliesOpen ?? true),
    },
    ui: {
      rememberPosition: bool(ui.rememberPosition, base.ui.rememberPosition ?? true),
      navLayout: nav === 'side' || nav === 'top' ? nav : base.ui.navLayout,
      navCollapsed: bool(ui.navCollapsed, base.ui.navCollapsed),
    },
    reader: {
      follow: bool(reader.follow, base.reader.follow),
      clickableWords: bool(reader.clickableWords, base.reader.clickableWords),
      transStyle:
        trans === 'muted' || trans === 'ink' || trans === 'compact'
          ? trans
          : base.reader.transStyle,
      autoTranslate: bool(reader.autoTranslate, base.reader.autoTranslate),
      font: READER_FONTS.includes(reader.font as ReaderFont)
        ? (reader.font as ReaderFont)
        : base.reader.font,
      fontSize: num(reader.fontSize, base.reader.fontSize, 14, 34),
      lineHeight: num(reader.lineHeight, base.reader.lineHeight, 1.2, 2.8),
      pageWidth: num(reader.pageWidth, base.reader.pageWidth, 480, 1400),
      paragraphGap: num(reader.paragraphGap, base.reader.paragraphGap, 0.4, 3),
      letterSpacing: num(reader.letterSpacing, base.reader.letterSpacing, -0.5, 3),
      justify: bool(reader.justify, base.reader.justify),
      paperTheme: PAPER_THEMES.includes(reader.paperTheme as PaperTheme)
        ? (reader.paperTheme as PaperTheme)
        : base.reader.paperTheme,
      wordLens: bool(reader.wordLens, base.reader.wordLens),
      autoScrollSpeed: num(reader.autoScrollSpeed, base.reader.autoScrollSpeed, 10, 240),
      voice:
        typeof reader.voice === 'string'
          ? reader.voice
          : reader.voice === null
            ? null
            : base.reader.voice,
    },
    vocab: {
      autoplay: bool(vocab.autoplay, base.vocab.autoplay),
      breakdown: BREAKDOWN_MODES.includes(vocab.breakdown as BreakdownMode)
        ? (vocab.breakdown as BreakdownMode)
        : base.vocab.breakdown,
    },
    study: {
      // 互斥在读取这一层也要兜住：历史数据或手改可能两个都是 true，
      // 那样卡片上什么都不剩，用户会以为数据丢了
      hideZh: bool(study.hideZh, base.study.hideZh) && !bool(study.hideEn, false),
      hideEn: bool(study.hideEn, base.study.hideEn),
    },
    drill: {
      dir:
        drill.dir === 'zh2en' || drill.dir === 'mix' || drill.dir === 'en2zh'
          ? drill.dir
          : base.drill.dir,
      showPhonetic: bool(drill.showPhonetic, base.drill.showPhonetic),
      showExample: bool(drill.showExample, base.drill.showExample),
      autoSpeak: bool(drill.autoSpeak, base.drill.autoSpeak),
    },
    listen: {
      content: LISTEN_CONTENTS.includes(listen.content as ListenContent)
        ? (listen.content as ListenContent)
        : base.listen.content,
      repeat: num(listen.repeat, base.listen.repeat, 1, 9),
      gapS: num(listen.gapS, base.listen.gapS, 0, 10),
      rate: num(listen.rate, base.listen.rate, 0.5, 2),
      shuffle: bool(listen.shuffle, base.listen.shuffle),
      loopAll: bool(listen.loopAll, base.listen.loopAll),
      meaningScope: LISTEN_MEANING_SCOPES.includes(listen.meaningScope as ListenMeaningScope)
        ? (listen.meaningScope as ListenMeaningScope)
        : base.listen.meaningScope,
      recallGapS: num(listen.recallGapS, base.listen.recallGapS, 0, 10),
      stopAfter: num(listen.stopAfter, base.listen.stopAfter, 0, 500),
    },
    mascot: {
      enabled: bool(mascot.enabled, base.mascot.enabled),
      modelId:
        typeof mascot.modelId === 'string'
          ? mascot.modelId
          : mascot.modelId === null
            ? null
            : base.mascot.modelId,
    },
  }
}

function initialPrefs(): AppPrefs {
  const base = migratedDefaults()
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (raw !== null) return mergePrefs(base, JSON.parse(raw))
  } catch {
    /* 缓存损坏时回到迁移默认 */
  }
  return base
}

function cache(prefs: AppPrefs): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(prefs))
    localStorage.setItem(PENDING_KEY, JSON.stringify(pendingPatch))
  } catch {
    toast.error('本机设置缓存不可用，当前设置仍然生效', { id: 'prefs-cache' })
  }
}

let putTimer: number | undefined
let pendingPatch: PrefPatch = (() => {
  try {
    const value: unknown = JSON.parse(readCache(PENDING_KEY) ?? '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
})()
let writing: Promise<void> | null = null
let hydrating: Promise<void> | null = null
let hydrated = false

function combinePatch(a: PrefPatch, b: PrefPatch): PrefPatch {
  return {
    ...a, ...b,
    ui: { ...a.ui, ...b.ui }, reader: { ...a.reader, ...b.reader },
    vocab: { ...a.vocab, ...b.vocab }, study: { ...a.study, ...b.study },
    drill: { ...a.drill, ...b.drill }, listen: { ...a.listen, ...b.listen },
    mascot: { ...a.mascot, ...b.mascot }, talk: { ...a.talk, ...b.talk },
    today: { ...a.today, ...b.today },
  }
}

function schedulePut(): void {
  window.clearTimeout(putTimer)
  putTimer = window.setTimeout(() => {
    void usePrefStore.getState().retry()
  }, 600)
}

interface PrefState {
  prefs: AppPrefs
  /** 服务端注水是否成功（失败时仅本地生效） */
  synced: boolean
  error: string | null
  hydrate: () => Promise<void>
  retry: () => Promise<void>
  update: (patch: PrefPatch) => void
}

export const usePrefStore = create<PrefState>((set, get) => ({
  prefs: initialPrefs(),
  synced: false,
  error: null,

  hydrate: async () => {
    if (hydrating) return hydrating
    hydrating = (async () => { try {
      const raw = await apiConfig.getPrefs()
      const empty =
        raw === null ||
        raw === undefined ||
        typeof raw !== 'object' ||
        Object.keys(raw as object).length === 0
      if (empty) {
        pendingPatch = combinePatch(get().prefs, pendingPatch)
      } else {
        const merged = mergePrefs(mergePrefs(get().prefs, raw), pendingPatch)
        cache(merged)
        set({ prefs: merged })
      }
      hydrated = true
      set({ synced: Object.keys(pendingPatch).length === 0, error: null })
    } catch (error) {
      set({ synced: false, error: error instanceof Error ? error.message : '设置读取失败' })
      toast.error('设置尚未同步，当前修改保留在本机', {
        id: 'prefs-sync', action: { label: '重试', onClick: () => { void get().retry() } },
      })
    } finally { hydrating = null } })()
    await hydrating
    if (hydrated && Object.keys(pendingPatch).length) await get().retry()
  },

  retry: async () => {
    if (!hydrated) { await get().hydrate(); return }
    if (writing) return writing
    writing = (async () => {
      try {
        while (Object.keys(pendingPatch).length) {
          const patch = pendingPatch
          await apiConfig.putPrefs(get().prefs)
          if (pendingPatch === patch) pendingPatch = {}
        }
        set({ synced: true, error: null })
        cache(get().prefs)
        toast.dismiss('prefs-sync')
      } catch (error) {
        set({ synced: false, error: error instanceof Error ? error.message : '设置保存失败' })
        toast.error('设置同步失败，当前修改仍然生效', {
          id: 'prefs-sync', action: { label: '重试', onClick: () => { void get().retry() } },
        })
      } finally { writing = null }
    })()
    return writing
  },

  update: (patch) => {
    const cur = get().prefs
    const next: AppPrefs = {
      theme: patch.theme ?? cur.theme,
      today: { ...cur.today, ...patch.today },
      ui: { ...cur.ui, ...patch.ui },
      reader: { ...cur.reader, ...patch.reader },
      vocab: { ...cur.vocab, ...patch.vocab },
      study: { ...cur.study, ...patch.study },
      drill: { ...cur.drill, ...patch.drill },
      listen: { ...cur.listen, ...patch.listen },
      mascot: { ...cur.mascot, ...patch.mascot },
      talk: { ...cur.talk, ...patch.talk },
    }
    if (JSON.stringify(next) === JSON.stringify(cur)) return
    pendingPatch = combinePatch(pendingPatch, patch)
    set({ prefs: next, synced: false })
    cache(next)
    schedulePut()
  },
}))
