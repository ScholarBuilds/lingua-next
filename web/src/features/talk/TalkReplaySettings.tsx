import { useState } from 'react'
import { VoicePicker } from '../../components/VoicePicker'
import { RatePicker } from '../../components/RatePicker'
import { getSessionVoice, setSessionVoice, stopTts } from '../../lib/audio'
import { useTalkReplayStore } from './talkReplayStore'

export function TalkReplaySettings({ onOpen }: { onOpen?: () => void }) {
  const [open, setOpen] = useState(false)
  const rate = useTalkReplayStore((s) => s.rate)
  const setRate = useTalkReplayStore((s) => s.setRate)
  return <>
    <button className="btn btn-outline" onClick={() => { onOpen?.(); stopTts(); setOpen(true) }}>朗读设置</button>
    <RatePicker value={rate} onChange={(value) => { stopTts(); setRate(value) }} />
    {open && <VoicePicker title="记录与点读音色" current={getSessionVoice()} rate={rate}
      hint="只影响记录重读与点读，不改变实时对话音色。" onClose={() => setOpen(false)}
      onChoose={(voice, speed) => { stopTts(); setSessionVoice(voice.value); setRate(speed) }}
      onClear={() => { stopTts(); setSessionVoice(null); setOpen(false) }} />}
  </>
}
