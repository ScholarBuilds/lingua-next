import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  create: vi.fn(), end: vi.fn().mockResolvedValue({}), pending: vi.fn(() => [{ text: '另一篇文章' }]),
  markSent: vi.fn(), stop: vi.fn(), close: vi.fn(),
}))
vi.mock('../../lib/api', () => ({ api: { endTalkSession: mocks.end }, talkRealtimeWsUrl: (path: string) => path }))
vi.mock('../../lib/api-m5', () => ({ apiM5: { createRealtimeSession: mocks.create } }))
vi.mock('../companion/contextStore', () => ({ pendingRefs: mocks.pending, refToPrompt: () => '另一篇文章', useCompanionContext: { getState: () => ({ markSent: mocks.markSent }) } }))
vi.mock('../talk/realtimeAudio', () => ({ MicCapture: class { stop = mocks.stop; start = vi.fn().mockResolvedValue(undefined) } }))
vi.mock('./analyserPlayer', () => ({ AnalyserPcmPlayer: class { close = mocks.close; flush = vi.fn() } }))

import { destroyVoiceCompanion, sendCompanionText, startVoiceCompanion, stopVoiceCompanion, useVoiceCompanionStore } from './useInlineVoiceCompanion'

class Socket {
  static OPEN = 1
  readyState = 1
  send = vi.fn()
  close = vi.fn()
  constructor() { sockets.push(this) }
}
const sockets: Socket[] = []
const grammar = { sentence: 'She has left.', analysis: '现在完成时', source: '单词例句' }

beforeEach(() => {
  vi.clearAllMocks()
  sockets.length = 0
  vi.stubGlobal('WebSocket', Socket)
  mocks.create.mockResolvedValue({ session_id: 1, ws_path: '/ws/1' })
})
afterEach(() => { destroyVoiceCompanion(); vi.unstubAllGlobals() })

it('语法会话注入分析且不带入阅读陪读的待发引用', async () => {
  startVoiceCompanion({ grammar })
  await Promise.resolve()
  expect(mocks.create).toHaveBeenCalledWith({ grammar_context: grammar })
  expect(sendCompanionText('为什么用 has？')).toBe(true)
  expect(sockets[0].send).toHaveBeenCalledWith(JSON.stringify({ type: 'ask', text: '为什么用 has？' }))
  expect(mocks.pending).not.toHaveBeenCalled()
  expect(mocks.markSent).not.toHaveBeenCalled()
  expect(useVoiceCompanionStore.getState().lines).toEqual([
    expect.objectContaining({ role: 'user', text: '为什么用 has？', interim: false }),
  ])
})

it('重复开始同一分析不会重连，更换分析会关闭旧连接', async () => {
  startVoiceCompanion({ grammar })
  await Promise.resolve()
  startVoiceCompanion({ grammar })
  expect(mocks.create).toHaveBeenCalledTimes(1)
  startVoiceCompanion({ grammar: { ...grammar, analysis: '新的解释' } })
  await Promise.resolve()
  expect(sockets[0].close).toHaveBeenCalled()
  expect(mocks.create).toHaveBeenCalledTimes(2)
  expect(useVoiceCompanionStore.getState().grammarKey).toContain('新的解释')
})

it('创建请求尚未返回就关闭时补发结束请求，不启动麦克风连接', async () => {
  let finish!: (value: { session_id: number; ws_path: string }) => void
  mocks.create.mockReturnValue(new Promise(resolve => { finish = resolve }))
  startVoiceCompanion({ grammar })
  destroyVoiceCompanion()
  finish({ session_id: 9, ws_path: '/ws/9' })
  await Promise.resolve()
  expect(mocks.end).toHaveBeenCalledWith(9)
  expect(sockets).toHaveLength(0)
})

it('结束会话释放采集播放资源并拒绝继续发送', async () => {
  startVoiceCompanion({ grammar })
  await Promise.resolve()
  stopVoiceCompanion()
  expect(mocks.stop).toHaveBeenCalled()
  expect(mocks.close).toHaveBeenCalled()
  expect(sendCompanionText('继续')).toBe(false)
  expect(useVoiceCompanionStore.getState().status).toBe('ended')
})
