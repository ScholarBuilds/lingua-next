import { useEffect, useRef, useState } from 'react'
import { useEscapeClose } from '../../components/Overlay'
import { Dialog, DialogContent, DialogTitle } from '../../components/ui/dialog'
import { stopTts } from '../../lib/audio'
import {
  destroyVoiceCompanion, resumeVoiceAudio, sendCompanionText, startVoiceCompanion,
  stopVoiceCompanion, useVoiceCompanionStore, VOICE_STATUS_TEXT,
} from '../mascot/useInlineVoiceCompanion'
import { useListenStore } from '../vocab/listenStore'
import { usePlayerStore } from '../reader/playerStore'
import './grammarVoice.css'

export interface GrammarVoiceSnapshot {
  sentence: string
  analysis: string
  source: string
}

export function GrammarVoiceButton({ sentence, analysis, source, onOpen }: {
  sentence: string
  analysis?: unknown
  source: string
  onOpen?: () => void
}) {
  const [snapshot, setSnapshot] = useState<GrammarVoiceSnapshot | null>(null)
  return <>
    <button className="btn btn-soft btn-sm" disabled={!sentence.trim()} onClick={() => { onOpen?.(); setSnapshot({
      sentence, analysis: analysis == null ? '当前尚无完整分析结果，请根据原句解答学习者的疑问，不要声称已经看过分析。'
        : typeof analysis === 'string' ? analysis : JSON.stringify(analysis, null, 2), source,
    }) }}>AI 语音助手</button>
    {snapshot && <GrammarVoiceDialog snapshot={snapshot} onClose={() => setSnapshot(null)} />}
  </>
}

function GrammarVoiceDialog({ snapshot, onClose }: {
  snapshot: GrammarVoiceSnapshot
  onClose: () => void
}) {
  const voice = useVoiceCompanionStore()
  const key = JSON.stringify(snapshot)
  const mine = voice.sourceKind === 'grammar' && voice.grammarKey === key
  const active = ['connecting', 'listening', 'speaking'].includes(voice.status)
  const ready = mine && ['listening', 'speaking'].includes(voice.status)
  const [draft, setDraft] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)
  const transcript = useRef<HTMLDivElement>(null)
  const tooLong = snapshot.sentence.length > 6000 || snapshot.analysis.length > 30000 || snapshot.source.length > 300
  const escape = () => {
    if (draft.trim() && document.activeElement === input.current) input.current?.blur()
    else onClose()
  }
  useEscapeClose(escape)
  useEffect(() => () => {
    if (useVoiceCompanionStore.getState().grammarKey === key) destroyVoiceCompanion()
  }, [key])
  useEffect(() => {
    transcript.current?.scrollTo({ top: transcript.current.scrollHeight })
  }, [voice.lines])
  const start = () => {
    useListenStore.getState().pause()
    usePlayerStore.getState().pause()
    stopTts()
    document.querySelectorAll('video, audio').forEach((media) => {
      if (media instanceof HTMLMediaElement) media.pause()
    })
    startVoiceCompanion({ grammar: snapshot })
  }
  const send = () => {
    if (ready && sendCompanionText(draft)) setDraft('')
  }
  return <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
    <DialogContent className="grammar-voice-dialog" overlayClassName="grammar-voice-overlay"
      portalContainer={document.fullscreenElement instanceof HTMLElement ? document.fullscreenElement : null}
      aria-describedby="grammar-voice-description" onEscapeKeyDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
        escape()
      }}>
      <DialogTitle>语法语音答疑</DialogTitle>
      <p id="grammar-voice-description">围绕当前原句和分析继续提问。开始后使用已配置的实时语音服务；关闭会结束收音。</p>
      <section className="grammar-voice-context">
        <small>{snapshot.source}</small>
        <p>{snapshot.sentence}</p>
        <details><summary>查看本次分析上下文</summary><pre>{snapshot.analysis}</pre></details>
      </section>
      {tooLong && <p role="alert">分析内容超过语音上下文上限，请选取较短的句子后再追问。</p>}
      <div className="grammar-voice-actions">
        {mine && active ? <>
          <span role="status">{VOICE_STATUS_TEXT[voice.status]} · {Math.floor(voice.elapsed / 60)}:{String(voice.elapsed % 60).padStart(2, '0')}</span>
          <button className="btn-ghost-sm" onClick={stopVoiceCompanion}>结束语音</button>
        </> : <button className="btn btn-primary" disabled={tooLong} onClick={start}>
          {!mine && active ? '结束当前语音并开始答疑' : mine ? '重新开始语音' : '开始语音'}
        </button>}
      </div>
      {mine && voice.error && <p role="alert">{voice.error}</p>}
      {mine && voice.micError && <p role="alert">麦克风不可用：{voice.micError}。可在下方输入问题，或检查麦克风权限后重新开始。</p>}
      {mine && voice.fakeMic && <p role="status">当前使用模拟麦克风，不能识别真实语音。</p>}
      {mine && voice.audioBlocked && <button className="btn" onClick={resumeVoiceAudio}>启用声音播放</button>}
      <div className="grammar-voice-transcript" ref={transcript} role="log" aria-label="答疑记录">
        {mine && voice.lines.map((line) => <p key={line.id}><b>{line.role === 'user' ? '我' : '语音老师'}：</b>{line.text}{line.interim ? '…' : ''}</p>)}
        {mine && voice.status === 'ended' && <p>本次答疑已结束，可查看记录或重新开始。</p>}
      </div>
      <form onSubmit={(event) => { event.preventDefault(); send() }} className="grammar-voice-compose">
        <textarea className="field-textarea" ref={input} aria-label="输入语法问题" placeholder="也可以输入具体疑问" maxLength={1200}
          value={draft} onChange={(event) => setDraft(event.target.value)} />
        <button className="btn btn-primary" disabled={!ready || !draft.trim()} type="submit">发送</button>
      </form>
    </DialogContent>
  </Dialog>
}
