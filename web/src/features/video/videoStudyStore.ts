/* 视频学习本地状态：听写记录 + 各模式独立进度（localStorage 持久化）、
   库级索引缓存（进度环 / 继续学习横幅）、视频收藏。

   进度的真相只有一处：服务端 `GET /videos/{id}/progress` 的 learned / total。
   本文件的库级索引是它的**缓存**，不是第二个真相源——库页没有批量口子，24 张卡逐个
   拉 progress 就是 24 个请求，所以由学习页把服务端算好的数写进来，库页读缓存渲染。
   代价是没在本浏览器学过的视频显示「未开始」，可以接受：它本来也没有学习痕迹可展示。

   syncLibEntry 契约（2026-08-24 改）：learned 由调用方从服务端进度取，不再从本地集合数。
   历史上它数的是 store 里的 learned Set，而「听懂了 ✓」早就迁到
   `PATCH /study-units/{id}/state`（FR-31），那个 Set 再没人写过——于是 pct 恒为 0，
   进度环、「已学完」筛选、「按进度」排序、卡片降透明度四处一起废掉。 */

import { create } from 'zustand'

const STUDY_KEY = (videoId: string) => `ln-video-study:${videoId}`
const LIB_KEY = 'ln-video-lib'
const FAVS_KEY = 'ln-video-favs'
export const POS_KEY = (videoId: string) => `ln-video-pos:${videoId}`

/* ---- 库级索引：进度环 / 继续学习横幅 ---- */

export interface LibEntry {
  learned: number
  total: number
  /** 0-100 */
  pct: number
  /** 最近学习时间戳 ms */
  lastAt: number
  /** 上次播放位置（秒） */
  lastPosS: number
}

export function readLibIndex(): Record<string, LibEntry> {
  try {
    const raw = localStorage.getItem(LIB_KEY)
    if (raw !== null) return JSON.parse(raw) as Record<string, LibEntry>
  } catch {
    /* 缓存损坏归零 */
  }
  return {}
}

export function writeLibEntry(videoId: string, entry: LibEntry): void {
  const idx = readLibIndex()
  idx[videoId] = entry
  localStorage.setItem(LIB_KEY, JSON.stringify(idx))
}

export function removeLibEntry(videoId: string): void {
  const idx = readLibIndex()
  if (videoId in idx) {
    delete idx[videoId]
    localStorage.setItem(LIB_KEY, JSON.stringify(idx))
  }
  localStorage.removeItem(STUDY_KEY(videoId))
  localStorage.removeItem(POS_KEY(videoId))
}

/**
 * 学完百分比。差一句也不许显示 100——四舍五入会把 999/1000 抬成 100，
 * 卡片当场打勾说「已学完」，用户找不出还差哪一句。
 */
export function libPct(learned: number, total: number): number {
  if (total <= 0) return 0
  if (learned >= total) return 100
  return Math.max(0, Math.min(99, Math.floor((learned / total) * 100)))
}

/** 已开始：学过句子，或留下过播放位置 */
export function isStarted(entry: LibEntry | undefined): boolean {
  return entry !== undefined && (entry.learned > 0 || entry.lastPosS > 0)
}

/** 已学完。库页筛选、排序、卡片降透明度、继续学习横幅共用这一处判据 */
export function isFinished(entry: LibEntry | undefined): boolean {
  return entry !== undefined && entry.total > 0 && entry.pct >= 100
}

/* ---- 视频收藏 ---- */

export function readFavs(): Set<number> {
  try {
    const raw = localStorage.getItem(FAVS_KEY)
    if (raw !== null) return new Set(JSON.parse(raw) as number[])
  } catch {
    /* 忽略 */
  }
  return new Set()
}

export function toggleFav(videoId: number): Set<number> {
  const favs = readFavs()
  if (favs.has(videoId)) favs.delete(videoId)
  else favs.add(videoId)
  localStorage.setItem(FAVS_KEY, JSON.stringify([...favs]))
  return favs
}

/* ---- per-video 学习状态 ---- */

export interface DictationStats {
  /** 本次会话已听写句数（cueId 集合大小另计），历史累计 */
  done: number
  correctWords: number
  totalWords: number
}

interface PersistShape {
  dictDone: Record<string, number>
  dictStats: DictationStats
  modeIdx: Record<string, number>
}

interface VideoStudyState {
  videoId: string
  /** 听写模式：cueId → 最近一次正确率 0-100 */
  dictDone: Record<string, number>
  dictStats: DictationStats
  /** 各模式独立进度：mode → 当前句下标（FR-15） */
  modeIdx: Record<string, number>

  load: (videoId: string) => void
  recordDictation: (cueId: number, accuracy: number, correct: number, total: number) => void
  setModeIdx: (mode: string, idx: number) => void
}

const EMPTY: PersistShape = {
  dictDone: {},
  dictStats: { done: 0, correctWords: 0, totalWords: 0 },
  modeIdx: {},
}

function readPersist(videoId: string): PersistShape {
  try {
    const raw = localStorage.getItem(STUDY_KEY(videoId))
    if (raw !== null) return { ...EMPTY, ...(JSON.parse(raw) as Partial<PersistShape>) }
  } catch {
    /* 忽略损坏缓存 */
  }
  return EMPTY
}

function persist(state: VideoStudyState): void {
  if (state.videoId === '') return
  const shape: PersistShape = {
    dictDone: state.dictDone,
    dictStats: state.dictStats,
    modeIdx: state.modeIdx,
  }
  localStorage.setItem(STUDY_KEY(state.videoId), JSON.stringify(shape))
}

export const useVideoStudyStore = create<VideoStudyState>((set, get) => ({
  videoId: '',
  dictDone: {},
  dictStats: EMPTY.dictStats,
  modeIdx: {},

  load: (videoId) => {
    const p = readPersist(videoId)
    set({
      videoId,
      dictDone: p.dictDone,
      dictStats: p.dictStats,
      modeIdx: p.modeIdx,
    })
  },

  recordDictation: (cueId, accuracy, correct, total) => {
    const s = get()
    set({
      dictDone: { ...s.dictDone, [String(cueId)]: accuracy },
      dictStats: {
        done: s.dictStats.done + 1,
        correctWords: s.dictStats.correctWords + correct,
        totalWords: s.dictStats.totalWords + total,
      },
    })
    persist(get())
  },

  setModeIdx: (mode, idx) => {
    set({ modeIdx: { ...get().modeIdx, [mode]: idx } })
    persist(get())
  },
}))

/**
 * 学习页把服务端进度同步进库级索引（进度环 / 横幅 / 筛选 / 排序的数据源）。
 *
 * @param learnedCues 服务端 `GET /videos/{id}/progress` 的 learned，不要传本地估算值
 * @param lastPosS 当前播放位置；拿不到时省略（或传 `undefined`）以保留上次记的位置，
 *   别拿 `?? 0` 兜底——那会把「回到 3:20」抹成「回到 0:00」
 *
 * 四个形参全是 number，旧的三参调用（旧签名 `(videoId, total, lastPosS)`）**能过编译**，
 * 只是把秒数灌进 learned 位——短视频当场显示「已学完」。改签名时必须把调用点逐个过一遍，
 * tsc 不会替你兜这一层。
 */
export function syncLibEntry(
  videoId: string,
  totalCues: number,
  learnedCues: number,
  lastPosS?: number,
): void {
  const prev = readLibIndex()[videoId]
  const total = Math.max(0, Math.trunc(totalCues))
  const learned = Math.min(Math.max(0, Math.trunc(learnedCues)), total)
  writeLibEntry(videoId, {
    learned,
    total,
    pct: libPct(learned, total),
    lastAt: Date.now(),
    lastPosS: lastPosS ?? prev?.lastPosS ?? 0,
  })
}
