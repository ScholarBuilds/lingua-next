import { create } from 'zustand'

interface VocabCollectionState {
  collected: Set<string>
  setCollected: (words: string[]) => void
  addCollected: (word: string) => void
  removeCollected: (word: string) => void
  setCollectedStatus: (word: string, collected: boolean) => void
}

export const useVocabCollectionStore = create<VocabCollectionState>((set) => ({
  collected: new Set<string>(),
  setCollected: (words) => set({ collected: new Set(words.map((word) => word.toLowerCase())) }),
  addCollected: (word) =>
    set((state) => ({ collected: new Set(state.collected).add(word.toLowerCase()) })),
  removeCollected: (word) =>
    set((state) => {
      const collected = new Set(state.collected)
      collected.delete(word.toLowerCase())
      return { collected }
    }),
  setCollectedStatus: (word, isCollected) =>
    set((state) => {
      const collected = new Set(state.collected)
      const normalized = word.toLowerCase()
      if (isCollected) collected.add(normalized)
      else collected.delete(normalized)
      return { collected }
    }),
}))
