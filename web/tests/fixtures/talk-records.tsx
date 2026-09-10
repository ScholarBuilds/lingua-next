import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route, Link } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RealtimeSessionHost, RealtimeSessionPage } from '../../src/features/talk/RealtimeSessionPage'
import type { TalkCoachBatch, TalkRecord } from '../../src/lib/api'
import { usePrefStore } from '../../src/lib/prefStore'
import '../../src/styles/tokens.css'
import '../../src/styles/app.css'
import '../../src/styles/workspace.css'

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.has('dark') ? 'dark' : 'light'
const records: TalkRecord[] = Array.from({ length: 123 }, (_, i) => ({
  id: i + 1, ordinal: i, message_id: `fixture-${i + 1}`, role: i % 2 ? 'user' : 'assistant',
  text: i % 2 ? 'I would like to talk about travel.' : "Hi! I'm your English speaking partner. What would you like to talk about?",
  complete: true, saved: false, saved_texts: [], created_at: new Date(1788508800000 + i * 10000).toISOString(), batches: [],
}))
let ended = false
let calls = 0
let failed = false
usePrefStore.setState((state) => ({ prefs: { ...state.prefs, talk: { autoCoach: true, translationOpen: true, repliesOpen: true } } }))
const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const url = new URL(String(input), location.href)
  if (url.pathname === '/api/talk/realtime/sessions') return Response.json({ session_id: -1, scenario: null, ws_path: '/records-fixture' })
  if (url.pathname === '/api/config/pronunciation') return Response.json({ enabled: false })
  if (url.pathname === '/api/talk/sessions/-1/records') {
    const q = url.searchParams.get('q') ?? ''
    const all = records.filter((r) => (!url.searchParams.get('role') || r.role === url.searchParams.get('role'))
      && (url.searchParams.get('saved') !== 'true' || r.saved || r.saved_texts.length || r.batches.some((b) => b.saved_replies.length))
      && JSON.stringify(r).includes(q))
    const items = all.filter((r) => !url.searchParams.has('before') || r.ordinal < Number(url.searchParams.get('before'))).slice(-50)
    return Response.json({ items, total: all.length, ended_at: ended ? new Date().toISOString() : null,
      next_cursor: all.some((r) => r.ordinal < (items[0]?.ordinal ?? 0)) ? items[0]?.ordinal : null })
  }
  const coachMatch = url.pathname.match(/\/turns\/(\d+)\/coach$/)
  if (coachMatch) {
    const record = records.find((r) => r.id === Number(coachMatch[1]))!
    if (!init?.method || init.method === 'GET') return Response.json(record.batches)
    const body = JSON.parse(String(init.body))
    const existing = record.batches.find((b) => b.batch_index === body.batch_index)
    if (existing?.status === 'ready' || existing?.status === 'running') return Response.json(existing)
    calls++
    const batch: TalkCoachBatch = { id: calls, batch_index: body.batch_index, status: 'running', error: null,
      saved_replies: [], created_at: new Date().toISOString(), model: 'fixture', result: null }
    record.batches = [...record.batches.filter((b) => b.batch_index !== batch.batch_index), batch]
    await new Promise((resolve) => setTimeout(resolve, 500))
    if (body.batch_index === 2 && !failed) { failed = true; batch.status = 'failed'; batch.error = '验收用生成失败，请重试' }
    else {
      const topic = ['travel', 'music', 'cooking'][body.batch_index % 3]
      batch.status = 'ready'
      batch.result = { translation: '你好，我是你的英语口语伙伴。你想聊些什么？', intent: '对方正在邀请你选择话题。',
        replies: ['直接简短', '自然展开', '更丰富表达'].map((tone, i) => ({ tone,
          en: [ `Can we talk about ${topic}?`, `I'd like to learn more about ${topic}.`, `Let's start with ${topic}. What do you think?` ][i], zh: '我们可以聊聊这个话题。' })) }
    }
    return Response.json(batch)
  }
  const saveMatch = url.pathname.match(/\/turns\/(\d+)\/saved$/)
  if (saveMatch) {
    const record = records.find((r) => r.id === Number(saveMatch[1]))!
    const body = JSON.parse(String(init?.body))
    if (body.batch_index != null) {
      const batch = record.batches.find((b) => b.batch_index === body.batch_index)!
      batch.saved_replies = body.saved ? [...batch.saved_replies, body.reply_index] : batch.saved_replies.filter((i) => i !== body.reply_index)
    } else if (body.text) record.saved_texts = body.saved ? [...record.saved_texts, body.text] : record.saved_texts.filter((s) => s !== body.text)
    else record.saved = body.saved
    return Response.json({ saved: body.saved })
  }
  if (/^\/api\/dict\/[^/]+$/.test(url.pathname)) return Response.json({ word: decodeURIComponent(url.pathname.split('/').at(-1)!), phonetic: '/test/', translation: '测试词义', definition: 'a word used in a conversation', pos: 'n.', collins: 1, tags: [], freq_band: 1, frq: 1, exchange: null, source: 'fixture' })
  if (url.pathname.startsWith('/api/')) return Response.json({ detail: '验收页面不调用外部服务' }, { status: 503 })
  return nativeFetch(input, init)
}
let socket: TestSocket
class TestSocket {
  readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  constructor() {
    socket = this
    setTimeout(() => { this.onopen?.(); this.emit({ type: 'started' }); this.turn(records.at(-1)!) }, 30)
  }
  emit(data: object) { this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) })) }
  turn(record: TalkRecord) {
    this.emit({ type: 'opening', text: record.text, message_id: record.message_id })
    this.emit({ type: 'turn_saved', ...record, turn_id: record.id })
  }
  send(data: unknown) { if (typeof data === 'string' && JSON.parse(data).type === 'end') { ended = true; this.close() } }
  close() { this.readyState = 3; this.onclose?.() }
}
const NativeSocket = window.WebSocket
window.WebSocket = new Proxy(NativeSocket, { construct(target, args) {
  return String(args[0]).includes('/records-fixture') ? new TestSocket() : Reflect.construct(target, args)
} })
const nativeCapture = navigator.mediaDevices.getUserMedia
navigator.mediaDevices.getUserMedia = async () => new MediaStream()
function Fixture() {
  const [count, setCount] = useState(records.length)
  return <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}>
    <div style={{ padding: 8, display: 'flex', gap: 16 }}><span>隔离验收：不连接语音或模型服务</span>
      <button onClick={() => { const last = records.at(-1)!; const next = { ...last, id: last.id + 1, ordinal: last.ordinal + 1, message_id: `fixture-${last.id + 1}`, batches: [] }; records.push(next); socket.turn(next); setCount(records.length) }}>模拟下一轮（相同文本）</button>
      <button onClick={() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark' }}>切换主题</button>
      <button onClick={() => { void document.getElementById('root')!.requestFullscreen() }}>全屏验收</button>
      <output>{count} 条</output>
    </div><div className="app-main workspace-column">
      <RealtimeSessionHost />
      <div className="workspace-route"><Routes>
        <Route path="/talk/session" element={<RealtimeSessionPage difficulty="medium" />} />
        <Route path="/talk" element={<div className="main"><h1>场景首页</h1><p>会话状态横条位于内容上方，首页保持工作区全宽。</p><Link to="/talk/session">打开对话</Link></div>} />
      </Routes></div>
    </div>
  </div>
}
const root = createRoot(document.getElementById('root')!)
root.render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={['/talk/session']}><Fixture /></MemoryRouter></QueryClientProvider>)
import.meta.hot?.dispose(() => {
  root.unmount()
  window.fetch = nativeFetch
  window.WebSocket = NativeSocket
  navigator.mediaDevices.getUserMedia = nativeCapture
})
