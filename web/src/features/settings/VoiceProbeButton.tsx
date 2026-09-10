import { useEffect, useRef, useState } from 'react'
import { playUrl } from '../../lib/audio'

interface Timings {
  connection_ms?: number
  first_audio_ms?: number
  playback_ms?: number
  latency_ms?: number
}

export function VoiceProbeButton({ credentialId, voice, capability, disabled = false, rate = 0, sample, separateActions = false }: {
  credentialId?: number; voice?: string; capability?: string; disabled?: boolean
  rate?: number; sample?: string; separateActions?: boolean
}) {
  const [pending, setPending] = useState(false)
  const [timings, setTimings] = useState<Timings>({})
  const [detail, setDetail] = useState('')
  const [error, setError] = useState('')
  const [sampleUrl, setSampleUrl] = useState('')
  const [measuring, setMeasuring] = useState(false)
  const replay = useRef<HTMLAudioElement>()
  const cleanup = useRef<() => void>(() => {})
  useEffect(() => () => { cleanup.current(); replay.current?.pause() }, [])

  const run = async (measure = true) => {
    cleanup.current()
    replay.current?.pause()
    setPending(true); setTimings({}); setError(''); setDetail(''); setSampleUrl('')
    setMeasuring(measure)
    const abort = new AbortController()
    const urls: string[] = []
    let audio: HTMLAudioElement | undefined
    cleanup.current = () => {
      abort.abort()
      if (audio) { audio.pause(); audio.src = '' }
      urls.forEach((url) => URL.revokeObjectURL(url))
    }
    const started = performance.now()
    const chunks: Uint8Array<ArrayBuffer>[] = []
    let source: MediaSource | undefined
    let buffer: SourceBuffer | undefined
    try {
      if (typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('audio/mpeg')) {
        source = new MediaSource()
        const opened = new Promise<void>((resolve, reject) => {
          source?.addEventListener('sourceopen', () => resolve(), { once: true })
          abort.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true })
        })
        const url = URL.createObjectURL(source); urls.push(url)
        audio = playUrl(url)
        audio.addEventListener('error', () => {
          if (abort.signal.aborted) return
          setError('浏览器无法播放这段音频，请重新试听')
          setPending(false)
          abort.abort()
        }, { once: true })
        audio.addEventListener('playing', () => {
          if (!abort.signal.aborted) setTimings((value) => ({ ...value, playback_ms: Math.round(performance.now() - started) }))
        }, { once: true })
        await opened
        buffer = source.addSourceBuffer('audio/mpeg')
      }
      const response = await fetch('/api/config/voice-probe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: abort.signal,
        body: JSON.stringify({ credential_id: credentialId, voice, capability, stream: true, rate, sample }),
      })
      if (!response.ok || !response.body) throw new Error(`试听请求失败 (${response.status})`)
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
      let partial = '', finished = false
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        partial += value
        const lines = partial.split('\n'); partial = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          const event = JSON.parse(line)
          if (event.type === 'ready') {
            setDetail(event.sample)
            setTimings((value) => ({ ...value, connection_ms: event.connection_ms }))
          } else if (event.type === 'audio') {
            setTimings((value) => ({ ...value, first_audio_ms: event.first_audio_ms }))
            const chunk = Uint8Array.from(atob(event.audio), (c) => c.charCodeAt(0))
            chunks.push(chunk)
            if (buffer) {
              const target = buffer
              abort.signal.throwIfAborted()
              await new Promise<void>((resolve, reject) => {
                const clear = () => { target.removeEventListener('updateend', end); target.removeEventListener('error', fail); abort.signal.removeEventListener('abort', fail) }
                const end = () => { clear(); resolve() }
                const fail = () => { clear(); reject(new Error('音频解码已中断')) }
                target.addEventListener('updateend', end, { once: true })
                target.addEventListener('error', fail, { once: true })
                abort.signal.addEventListener('abort', fail, { once: true })
                try { target.appendBuffer(chunk) } catch (error) { clear(); reject(error) }
              })
            }
          } else if (event.type === 'done') {
            if (!event.ok) throw new Error(event.detail)
            finished = true
            setTimings((value) => ({ ...value, latency_ms: event.latency_ms }))
          }
        }
      }
      if (!finished) throw new Error('试听流未正常结束，请重试')
      if (source?.readyState === 'open') source.endOfStream()
      const url = URL.createObjectURL(new Blob(chunks, { type: 'audio/mpeg' })); urls.push(url)
      setSampleUrl(url)
      if (!audio) {
        setDetail((value) => `${value} · 此浏览器不支持 MP3 流式解码，已使用整句播放`)
        audio = playUrl(url)
        audio.addEventListener('playing', () => {
          if (!abort.signal.aborted) setTimings((value) => ({ ...value, playback_ms: Math.round(performance.now() - started) }))
        }, { once: true })
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        audio?.pause()
        setError(error instanceof Error ? error.message : '试听失败')
      }
    } finally {
      if (!abort.signal.aborted) setPending(false)
    }
  }
  return <div className="service-probe" onClick={(event) => event.stopPropagation()}>
    <button className="btn-ghost-sm" disabled={disabled || pending} onClick={() => void run(!separateActions)}>{pending ? '试听中…' : separateActions ? '试听' : '试听并测速'}</button>
    {separateActions && <button className="btn-ghost-sm" disabled={disabled || pending} onClick={() => void run(true)}>测延迟</button>}
    {pending && <button className="btn-ghost-sm" onClick={() => { cleanup.current(); setPending(false); setError('已取消') }}>取消</button>}
    {error && <span role="alert">{error}</span>}
    {sampleUrl && !separateActions && <button className="btn-ghost-sm" onClick={() => { replay.current = playUrl(sampleUrl) }}>重播</button>}
    {measuring && timings.playback_ms !== undefined && <span className="voice-latency" role="status"
      title={`连接就绪 ${timings.connection_ms ?? '未提供'} ms；首块 ${timings.first_audio_ms ?? '未提供'} ms；合成完成 ${timings.latency_ms ?? '等待中'} ms。播放从点击起算，其余从服务端请求起算。${detail}`}>
      首播 {timings.playback_ms} ms
    </span>}
  </div>
}
