import { create } from 'zustand'

import { usePrefStore } from '../../lib/prefStore'

export interface WordSelection {
  /** 词元小写形式，用于词典/收藏 */
  word: string
  /** 正文中的原样文本 */
  surface: string
  paragraphId: number
  start: number
  end: number
  sentenceId: number | null
  sentenceHash: string | null
  sentenceText: string
}

export interface SentenceSelection {
  sentenceId: number
  hash: string
  paragraphId: number
  text: string
}

/** 拖选相邻词元形成的词组（M5） */
export interface PhraseSelection {
  text: string
  /** 所在句（无句包裹时取段落节选）作为语境 */
  context: string
  paragraphId: number
}

export type ReaderSelection =
  | { kind: 'word'; word: WordSelection }
  | { kind: 'sentence'; sentence: SentenceSelection }
  | { kind: 'phrase'; phrase: PhraseSelection }
  | null

/** 三态显示：原文 / 双语对照 / 仅译文 */
export type ViewMode = 'orig' | 'both' | 'trans'

/** 右栏面板：学习卡 / 句子 / 陪读 / 批注 / 书签 / 统计（v11 扩展） */
export type PanelTab =
  | 'learn'
  | 'sentence'
  | 'companion'
  | 'annotations'
  | 'bookmarks'
  | 'stats'

const VIEW_MODE_KEY = 'ln-view-mode'

function initViewMode(): ViewMode {
  const v = localStorage.getItem(VIEW_MODE_KEY)
  return v === 'both' || v === 'trans' ? v : 'orig'
}

interface ReaderState {
  selection: ReaderSelection
  tocOpen: boolean
  viewMode: ViewMode
  panelTab: PanelTab
  /** 右栏英文可点词开关（经 prefStore 持久化，默认开） */
  clickableWords: boolean
  setClickableWords: (on: boolean) => void
  selectWord: (word: WordSelection) => void
  selectSentence: (sentence: SentenceSelection) => void
  selectPhrase: (phrase: PhraseSelection) => void
  clearSelection: () => void
  toggleToc: () => void
  setViewMode: (mode: ViewMode) => void
  setPanelTab: (tab: PanelTab) => void
}

export const useReaderStore = create<ReaderState>((set) => ({
  selection: null,
  tocOpen: true,
  panelTab: 'learn',
  // 点词/点句/选词组时联动切到对应 tab
  selectWord: (word) => set({ selection: { kind: 'word', word }, panelTab: 'learn' }),
  selectSentence: (sentence) =>
    set({ selection: { kind: 'sentence', sentence }, panelTab: 'sentence' }),
  selectPhrase: (phrase) => set({ selection: { kind: 'phrase', phrase }, panelTab: 'learn' }),
  clearSelection: () => set({ selection: null }),
  toggleToc: () => set((state) => ({ tocOpen: !state.tocOpen })),
  clickableWords: usePrefStore.getState().prefs.reader.clickableWords,
  setClickableWords: (on) => {
    usePrefStore.getState().update({ reader: { clickableWords: on } })
    set({ clickableWords: on })
  },
  viewMode: initViewMode(),
  setViewMode: (mode) => {
    localStorage.setItem(VIEW_MODE_KEY, mode)
    set({ viewMode: mode })
  },
  setPanelTab: (tab) => set({ panelTab: tab }),
}))
