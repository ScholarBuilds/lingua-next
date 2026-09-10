import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

import { TalkAvatar } from '../../src/features/talk/TalkAvatar'
import type { PartnerStatus } from '../../src/features/talk/avatarMotion'
import { PcmPlayer } from '../../src/features/talk/realtimeAudio'
import { RealtimeSessionPage } from '../../src/features/talk/RealtimeSessionPage'
import '../../src/styles/tokens.css'
import '../../src/styles/app.css'

function Preview() {
  const [status, setStatus] = useState<PartnerStatus>('listening')
  const [visible, setVisible] = useState(true)
  const [peak, setPeak] = useState(0)
  const player = useRef<PcmPlayer | null>(null)
  useEffect(() => {
    const timer = setInterval(() => setPeak((value) => Math.max(value, player.current?.audioLevel() ?? 0)), 50)
    return () => { clearInterval(timer); player.current?.close() }
  }, [])
  const speak = async () => {
    player.current ??= new PcmPlayer()
    await player.current.resume()
    player.current.flush()
    setPeak(0)
    const pcm = new Float32Array(24000 * 4)
    for (let i = 0; i < pcm.length; i++) {
      const t = i / 24000
      const envelope = Math.max(0, Math.sin(t * 15)) * 0.12
      pcm[i] = Math.sin(t * 220 * Math.PI * 2) * envelope
    }
    player.current.enqueue(pcm.buffer)
    setStatus('speaking')
  }
  return (
    <main style={{ height: '100dvh', display: 'flex', flexDirection: 'column', background: 'var(--paper)', color: 'var(--ink)' }}>
      <div style={{ padding: 16, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <button onClick={() => void speak()}>播放测试音频</button>
        <button onClick={() => { player.current?.flush(); setStatus('listening') }}>打断</button>
        <button onClick={() => { player.current?.flush(); setStatus('thinking') }}>思考</button>
        <button onClick={() => setVisible((value) => !value)}>切换数字人</button>
        <button onClick={() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark' }}>切换深色</button>
        <span>{status} · 合成音频验收，不连接模型或麦克风</span>
        <output>输出峰值：{peak.toFixed(3)}</output>
      </div>
      {visible && <TalkAvatar status={status} readLevel={() => player.current?.audioLevel() ?? 0} readBrightness={() => player.current?.audioBrightness() ?? 0.5} />}
    </main>
  )
}
const root = createRoot(document.getElementById('root')!)
if (new URLSearchParams(location.search).has('dark')) document.documentElement.dataset.theme = 'dark'
if (new URLSearchParams(location.search).has('session')) {
  const nativeFetch = window.fetch
  let failedVariant = false
  window.fetch = async (input, init) => {
    if (String(input) === '/api/talk/realtime/sessions') {
      return Response.json({ session_id: -1, scenario: null, ws_path: '/avatar-test' })
    }
    if (String(input) === '/avatars/partner.vrm' && new URLSearchParams(location.search).has('fail')) {
      return new Response('', { status: 503 })
    }
    if (String(input) === '/api/talk/sessions/-1/coach') {
      const body = JSON.parse(String(init?.body)) as { variant: number }
      if (body.variant === 2 && !failedVariant) {
        failedVariant = true
        return Response.json({ detail: '测试生成失败' }, { status: 503 })
      }
      const topics = ['travel', 'music', 'cooking']
      const topic = topics[body.variant % topics.length]
      return Response.json({
        translation: '你好，我是你的英语口语伙伴。你想聊些什么？',
        intent: '对方正在邀请你选择话题。',
        replies: [
          { en: `Can we talk about ${topic}?`, zh: `我们可以聊聊${['旅行', '音乐', '烹饪'][body.variant % topics.length]}吗？`, tone: '直接简短' },
          { en: `I'd like to learn more about ${topic}.`, zh: '我想多了解一下这个话题。', tone: '自然展开' },
          { en: `Let's start with ${topic}. What do you think?`, zh: '我们从这个话题开始吧，你觉得呢？', tone: '邀请交流' },
        ],
      })
    }
    return nativeFetch(input, init)
  }
  const NativeSocket = window.WebSocket
  class TestSocket {
    static OPEN = 1
    readyState = 1
    onopen: (() => void) | null = null
    onmessage: ((event: MessageEvent) => void) | null = null
    onclose: (() => void) | null = null
    constructor() {
      setTimeout(() => {
        if (this.readyState !== 1) return
        this.onopen?.()
        this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'started' }) }))
        this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'opening', text: "Hi! I'm your English speaking partner. What would you like to talk about?" }) }))
      }, 30)
    }
    send(): void {}
    close(): void { this.readyState = 3; this.onclose?.() }
  }
  window.WebSocket = new Proxy(NativeSocket, {
    construct(target, args) {
      return String(args[0]).includes('/avatar-test') ? new TestSocket() : Reflect.construct(target, args)
    },
  })
  navigator.mediaDevices.getUserMedia = async () => { throw new Error('验收模式：未采集麦克风') }
  root.render(<StrictMode><QueryClientProvider client={new QueryClient()}><MemoryRouter>
    <div style={{ display: 'flex', height: '100dvh', minHeight: 0 }}><RealtimeSessionPage difficulty="medium" /></div>
  </MemoryRouter></QueryClientProvider></StrictMode>)
} else {
  root.render(<StrictMode><Preview /></StrictMode>)
}
