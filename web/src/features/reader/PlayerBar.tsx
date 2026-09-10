import { useQuery } from '@tanstack/react-query'
import { LearningIcon } from '@/components/LearningIcon'
import { useMemo, useState } from 'react'
import { VoicePicker } from '../../components/VoicePicker'
import { RatePicker } from '../../components/RatePicker'


import { readerApi } from '../../lib/api-reader-m5'
import { scrollToReadingSentence, usePlayerStore } from './playerStore'

/** 音色列表未命中时的兜底展示：en-US-AriaNeural → Aria · en-US */
function fallbackLabel(name: string): string {
  const bare = name.replace(/^(?:volc|edge):/, '')
  const m = /^([a-z]{2}-[A-Z]{2})-(.+?)(?:Multilingual)?Neural$/.exec(bare)
  return m ? `${m[2]} · ${m[1]}` : bare
}

export function PlayerBar() {
  const status = usePlayerStore((s) => s.status)
  const index = usePlayerStore((s) => s.index)
  const total = usePlayerStore((s) => s.sentences.length)
  const currentSid = usePlayerStore((s) => s.sentences[s.index]?.sentenceId ?? null)
  const voice = usePlayerStore((s) => s.voice)
  const rate = usePlayerStore((s) => s.rate)
  const follow = usePlayerStore((s) => s.follow)
  const toggle = usePlayerStore((s) => s.toggle)
  const next = usePlayerStore((s) => s.next)
  const prev = usePlayerStore((s) => s.prev)
  const setRate = usePlayerStore((s) => s.setRate)
  const [voiceOpen, setVoiceOpen] = useState(false)
  const setVoice = usePlayerStore((s) => s.setVoice)
  const setFollow = usePlayerStore((s) => s.setFollow)

  // 新契约 /tts/voices：{voices(provider 分组), default_voice}，旧裸数组已在 api 层归一化
  const voicesQuery = useQuery({
    queryKey: ['tts-voices-v2'],
    queryFn: readerApi.ttsVoices,
    staleTime: Infinity,
    retry: false,
  })


  // voice=null 表示跟随设置页的场景默认音色（本会话未临时换过）
  const voiceLabel = useMemo(() => {
    if (voice === null) return '默认音色'
    const hit = voicesQuery.data?.voices.find((v) => v.name === voice)
    return hit?.label ?? fallbackLabel(voice)
  }, [voicesQuery.data, voice])

  const statusText =
    status === 'playing'
      ? `正在朗读第 ${index + 1}/${total} 句`
      : status === 'paused'
        ? `已暂停 · 第 ${index + 1}/${total} 句`
        : total > 0
          ? `共 ${total} 句`
          : '本章无可朗读内容'

  // 回到朗读位置：清除滚轮临时打断并定位当前句（不改动跟随开关）
  const locate = () => {
    usePlayerStore.getState().resumeFollow()
    if (currentSid !== null) scrollToReadingSentence(currentSid)
  }

  return (
    <div className="player">
      <button className="icon-btn" title="上一句" onClick={prev} disabled={index <= 0}>
        <LearningIcon name="previous-sentence" />
      </button>
      <button
        className="play"
        title={status === 'playing' ? '暂停' : '播放'}
        onClick={toggle}
        disabled={total === 0}
      >
        {status === 'playing' ? <LearningIcon name="pause" /> : <LearningIcon name="play" />}
      </button>
      <button
        className="icon-btn"
        title="下一句"
        onClick={next}
        disabled={index >= total - 1}
      >
        <LearningIcon name="next-sentence" />
      </button>

      <div className="sep" />

      <button className="voice-btn" title="选择音色" onClick={() => setVoiceOpen(true)}>
        <b>{voiceLabel}</b><span>{statusText}</span>
      </button>
      {voiceOpen && <VoicePicker title="阅读器朗读音色" current={voice} rate={rate}
        onClose={() => setVoiceOpen(false)} onClear={() => { setVoice(null); setVoiceOpen(false) }}
        onChoose={(choice, speed) => { setVoice(choice.value); setRate(speed) }} />}

      <div className="sep" />

      <RatePicker value={rate} onChange={setRate} label="播放倍速" />
      <button
        className={`btn-ghost-sm fol-btn${follow ? ' on' : ''}`}
        title={follow ? '自动跟随当前句：开' : '自动跟随当前句：关'}
        role="switch"
        aria-checked={follow}
        onClick={() => setFollow(!follow)}
      >
        跟随
      </button>
      <button className="icon-btn" title="回到朗读位置" onClick={locate}>
        <LearningIcon name="focus-sentence" />
      </button>
    </div>
  )
}
