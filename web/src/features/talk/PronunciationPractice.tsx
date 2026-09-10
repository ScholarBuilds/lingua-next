import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { pronunciation } from '../../lib/pronunciation'
import { useRecorder } from '../../lib/recorder'
import { beforeAudioPlay, stopTts } from '../../lib/audio'
import { TalkWordText } from './TalkWordText'

const labels: Record<string, string> = { PronScore: '综合', AccuracyScore: '准确度', FluencyScore: '流利度', CompletenessScore: '完整度', ProsodyScore: '韵律' }

export function PronunciationPractice({ text, onPracticeChange, suspended = false }: { text: string; onPracticeChange?: (active: boolean) => void; suspended?: boolean }) {
  const settings = useQuery({ queryKey: ['pronunciation-settings'], queryFn: pronunciation.settings, staleTime: 30000 })
  const [recorded, setRecorded] = useState<Blob | null>(null)
  const [error, setError] = useState('')
  const active = useRef(true)
  const request = useRef<AbortController>()
  const evaluate = useMutation({ mutationFn: (blob: Blob) => {
    request.current = new AbortController()
    return pronunciation.assess(blob, text, request.current.signal)
  } })
  const recorder = useRecorder((blob) => { if (active.current) setRecorded(blob) }, setError)
  const stop = useRef(recorder.stop); stop.current = recorder.stop
  const change = useRef(onPracticeChange); change.current = onPracticeChange
  useEffect(() => beforeAudioPlay(() => stop.current()), [])
  useEffect(() => { if (suspended) stop.current() }, [suspended])
  useEffect(() => {
    active.current = true
    return () => { active.current = false; request.current?.abort(); stop.current(); change.current?.(false) }
  }, [])
  useEffect(() => {
    if (!recorder.recording) return
    const timer = setTimeout(recorder.stop, 29000)
    return () => clearTimeout(timer)
  }, [recorder.recording, recorder.stop])
  if (!settings.data?.enabled) return null
  return <details className="talk-pronunciation" onToggle={(event) => {
    change.current?.(event.currentTarget.open)
    if (!event.currentTarget.open) recorder.stop()
  }}><summary>跟读与发音评测</summary>
    <p><TalkWordText text={text} /></p>
    <button className="btn" disabled={suspended || evaluate.isPending || text.length > 500} onClick={() => {
      setError('')
      if (recorder.recording) recorder.stop()
      else { stopTts(); setRecorded(null); evaluate.reset(); void recorder.start() }
    }}>{recorder.recording ? '结束录音' : '录制跟读'}</button>
    {recorded && <button className="btn" disabled={evaluate.isPending || recorder.recording} onClick={() => evaluate.mutate(recorded)}>{evaluate.isPending ? '评测中…' : '发送本次录音给 Azure 评测'}</button>}
    <p className="muted">限 30 秒、500 字符，当前评测美式英语。仅点击发送才上传；展开期间实时对话收音暂停，收起后点击“继续对话”恢复。评分用于练习参考。</p>
    {text.length > 500 && <p role="status">这条回复较长，请选择较短的一轮进行跟读。</p>}
    {(error || evaluate.error) && <p role="alert">{error || evaluate.error?.message}</p>}
    {evaluate.data && <div aria-label="发音评测结果">
      <dl>{Object.entries(evaluate.data.scores).map(([key, score]) => <div key={key}><dt>{labels[key] ?? key}</dt><dd>{score === null ? '未提供' : score.toFixed(1)}</dd></div>)}</dl>
      {evaluate.data.words.map((word, i) => <p key={i}><TalkWordText text={word.word} /> · {word.accuracy ?? '—'}{word.error && word.error !== 'None' ? ` · ${word.error}` : ''}</p>)}
    </div>}
  </details>
}
