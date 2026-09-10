/* 查词页的常驻状态（STD-UI-007）：上次查的词与「最近查过」。

   设备级落 localStorage：最近查过是这台机器上的手感，不是学习进度。 */

import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

import { safeStorage } from '../../../lib/safeStorage'

export interface RecentLookup {
  word: string
  brief: string
  at: number
}

interface DictState {
  query: string
  word: string
  recent: RecentLookup[]
  setLookup: (query: string, word: string) => void
  remember: (word: string, brief: string) => void
  clearRecent: () => void
}

export const MAX_RECENT = 30

export const useDictStore = create<DictState>()(
  persist(
    (set) => ({
      query: '',
      word: '',
      recent: [],
      setLookup: (query, word) =>
        set((s) => (s.query === query && s.word === word ? s : { query, word })),
      remember: (word, brief) =>
        set((s) => {
          const rest = s.recent.filter((r) => r.word !== word)
          return { recent: [{ word, brief, at: Date.now() }, ...rest].slice(0, MAX_RECENT) }
        }),
      clearRecent: () => set({ recent: [] }),
    }),
    {
      name: 'lingua-dict',
      version: 1,
      storage: createJSONStorage(safeStorage),
      partialize: (s) => ({ query: s.query, word: s.word, recent: s.recent }),
    },
  ),
)
