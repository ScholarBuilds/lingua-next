/* 给一个词换声音（FR-495）：包一层 VoicePicker，选完落库并立刻用新声重读。

   合成错的词换个供应商往往就对了，但场景绑定是全局一把音色。这里只钉这一个词；
   例句与释义仍走各自场景。词卡、词汇本卡片、听读条三处共用。 */

import { useRef } from 'react'

import { normalizeWord, useWordVoiceMutations, useWordVoices } from '../lib/api-tts'
import { playTts } from '../lib/audio'
import { VoicePicker } from './VoicePicker'

interface WordVoicePickerProps {
  word: string
  onClose: () => void
}

export function WordVoicePicker({ word, onClose }: WordVoicePickerProps) {
  const key = normalizeWord(word)
  const { data } = useWordVoices()
  const current = data?.get(key) ?? null
  const { pin, clear } = useWordVoiceMutations()
  const replay = useRef(false)

  /* VoicePicker 关闭时会 stopTts（useStopTtsOnClose 的清理），所以重读要排在
     它卸载之后——同步调的话刚出声就被停掉 */
  const close = () => {
    onClose()
    if (replay.current) {
      replay.current = false
      window.setTimeout(() => playTts(word, 'word'), 0)
    }
  }

  return (
    <VoicePicker
      title={`「${word}」的声音`}
      sample={word}
      hint="只换这一个词的发音，例句与释义照旧走场景音色。先试听再选。"
      current={current?.voice ?? null}
      rate={1 + (current?.rate ?? 0) / 100}
      onClear={
        current === null
          ? undefined
          : async () => {
              await clear.mutateAsync(key)
              replay.current = true
              close()
            }
      }
      onClose={close}
      onChoose={async (choice, rate) => {
        await pin.mutateAsync({ word: key, voice: choice.value, rate: Math.round((rate - 1) * 100) })
        replay.current = true
      }}
    />
  )
}
