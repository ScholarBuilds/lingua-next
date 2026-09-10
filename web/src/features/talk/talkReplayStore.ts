import { create } from 'zustand'
import { playTts, setPlaybackRate } from '../../lib/audio'

export const useTalkReplayStore = create<{ rate: number; setRate: (value: number) => void }>((set) => ({
  rate: 1,
  setRate: (rate) => set({ rate }),
}))

export function replaySentence(text: string, slow = false): void {
  playTts(text)
  setPlaybackRate(slow ? 0.8 : useTalkReplayStore.getState().rate)
}

export function sentences(text: string): string[] {
  return [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)]
    .map((part) => part.segment.trim()).filter(Boolean)
}
