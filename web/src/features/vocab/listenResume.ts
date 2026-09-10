/* 听读断点（FR-506）：这台设备在每个范围念到哪个词。

   设备级，照 video/playerPrefs 的划分：「怎么念」（遍数、停顿、念什么）跨设备同步在
   prefStore，「念到哪」只关这台设备，落 localStorage。键是范围键（本 + 筛选 + 排序 +
   搜索 + 场景），同一本换了筛选就是另一条队列，断点不能串。 */

import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

import { safeStorage } from '../../lib/safeStorage'

export interface ResumeEntry {
  word: string
  at: number
  deckName?: string
  route?: string
  position?: number
  total?: number
}

interface ListenResumeState {
  entries: Record<string, ResumeEntry>
  remember: (scopeKey: string, word: string, details?: Omit<ResumeEntry, 'word' | 'at'>) => void
  forget: (scopeKey: string) => void
  lookup: (scopeKey: string) => string | null
}

const MAX_ENTRIES = 50

export const useListenResume = create<ListenResumeState>()(
  persist(
    (set, get) => ({
      entries: {},
      remember: (scopeKey, word, details) =>
        set((s) => {
          if (s.entries[scopeKey]?.word === word) return s
          const next = { ...s.entries, [scopeKey]: { word, at: Date.now(), ...details } }
          const keys = Object.keys(next)
          if (keys.length > MAX_ENTRIES) {
            keys.sort((a, b) => next[a].at - next[b].at)
            for (const key of keys.slice(0, keys.length - MAX_ENTRIES)) delete next[key]
          }
          return { entries: next }
        }),
      forget: (scopeKey) =>
        set((s) => {
          if (!(scopeKey in s.entries)) return s
          const next = { ...s.entries }
          delete next[scopeKey]
          return { entries: next }
        }),
      lookup: (scopeKey) => get().entries[scopeKey]?.word ?? null,
    }),
    {
      name: 'lingua-listen-resume',
      version: 1,
      storage: createJSONStorage(safeStorage),
      partialize: (s) => ({ entries: s.entries }),
    },
  ),
)
