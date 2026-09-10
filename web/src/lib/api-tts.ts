/* 按词钉死的发音音色（FR-495）。
   整张表一次拉下来灌进 lib/audio 的内存表，所有 `playTts(word, 'word')` 调用点
   零改动就吃到覆盖；改一条就地改缓存并重灌，不等接口回来。 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { request } from './api'
import { setTtsEpoch, setWordVoices, type WordVoice } from './audio'

export type WordVoiceMap = ReadonlyMap<string, WordVoice>

export const WORD_VOICES_KEY = ['word-voices'] as const

export const apiTts = {
  wordVoices: async (): Promise<WordVoiceMap> => {
    const body = await request<{ voices: Record<string, WordVoice>; epoch?: number }>(
      '/api/tts/word-voices',
    )
    // 缓存代号顺路灌进 lib/audio：三处消费者只认这张 Map，这里是它唯一的落点
    setTtsEpoch(body.epoch ?? 0)
    return new Map(Object.entries(body.voices))
  },
  setWordVoice: (word: string, voice: string, rate: number) =>
    request<{ word: string; voice: string; rate: number }>(
      `/api/tts/word-voices/${encodeURIComponent(word)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice, rate }),
      },
    ),
  deleteWordVoice: (word: string) =>
    request<{ ok: boolean; word: string }>(`/api/tts/word-voices/${encodeURIComponent(word)}`, {
      method: 'DELETE',
    }),
}

export function normalizeWord(word: string): string {
  return word.trim().toLowerCase()
}

export function useWordVoices() {
  return useQuery({ queryKey: WORD_VOICES_KEY, queryFn: apiTts.wordVoices, staleTime: Infinity })
}

export function useWordVoiceMutations() {
  const qc = useQueryClient()
  const apply = (fix: (prev: WordVoiceMap) => WordVoiceMap) => {
    const next = fix(qc.getQueryData<WordVoiceMap>(WORD_VOICES_KEY) ?? new Map())
    qc.setQueryData(WORD_VOICES_KEY, next)
    setWordVoices(next)
  }
  const pin = useMutation({
    mutationFn: ({ word, voice, rate }: { word: string; voice: string; rate: number }) =>
      apiTts.setWordVoice(word, voice, rate),
    onSuccess: (row) =>
      apply((prev) => new Map(prev).set(row.word, { voice: row.voice, rate: row.rate })),
  })
  const clear = useMutation({
    mutationFn: (word: string) => apiTts.deleteWordVoice(word),
    onSuccess: (row) =>
      apply((prev) => {
        const next = new Map(prev)
        next.delete(row.word)
        return next
      }),
  })
  return { pin, clear }
}
