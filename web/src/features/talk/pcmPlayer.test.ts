/* PcmPlayer 的 item 记账。测试跑在 node 里（本仓 vitest 没配 jsdom），AudioContext 自己搭桩：
   currentTime 可推进、source 记下 start 时刻、onended 手动触发。 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PcmPlayer } from './realtimeAudio'

const g = globalThis as Record<string, unknown>

class FakeSource {
  buffer: { duration: number } | null = null
  onended: (() => void) | null = null
  startedAt = -1
  stopped = false
  connections: unknown[] = []
  connect(node: unknown): void { this.connections.push(node) }
  start(at: number): void {
    this.startedAt = at
  }
  stop(): void {
    this.stopped = true
  }
}

class FakeAudioContext {
  currentTime = 0
  state = 'running'
  destination = {}
  sources: FakeSource[] = []
  level = 0
  sampleRate = 24_000
  spectrum = new Uint8Array(256)
  analyserCount = 0
  createAnalyser() {
    this.analyserCount += 1
    return {
      fftSize: 0,
      getFloatTimeDomainData: (samples: Float32Array) => samples.fill(this.level),
      getByteFrequencyData: (samples: Uint8Array) => samples.set(this.spectrum),
      disconnect(): void {},
    }
  }
  createBuffer(_channels: number, length: number, rate: number) {
    return { duration: length / rate, copyToChannel(): void {} }
  }
  createBufferSource(): FakeSource {
    const src = new FakeSource()
    this.sources.push(src)
    return src
  }
  resume(): Promise<void> {
    return Promise.resolve()
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
}

let ctx: FakeAudioContext

beforeEach(() => {
  g.AudioContext = class extends FakeAudioContext {
    constructor() {
      super()
      ctx = this
    }
  }
})

afterEach(() => {
  delete g.AudioContext
})

/** 24k float32，ms 毫秒 */
function pcm(ms: number): ArrayBuffer {
  return new ArrayBuffer((24_000 * ms) / 1000 * 4)
}

describe('PcmPlayer · item 记账', () => {
  it('频谱驱动区分低高频，静音和打断回到中性值', () => {
    const player = new PcmPlayer()
    expect(player.audioBrightness()).toBe(0.5)
    player.enqueue(pcm(500))
    player.audioLevel()
    expect(player.audioBrightness()).toBe(0.5)
    ctx.spectrum[10] = 200
    const low = player.audioBrightness()
    ctx.spectrum.fill(0)
    ctx.spectrum[50] = 200
    expect(player.audioBrightness()).toBeGreaterThan(low)
    expect(ctx.analyserCount).toBe(1)
    ctx.state = 'suspended'
    expect(player.audioBrightness()).toBe(0.5)
    ctx.state = 'running'
    player.flush()
    expect(player.audioBrightness()).toBe(0.5)
    player.close()
  })

  it('音量分析只旁路连接，未使用数字人时不分配 analyser', () => {
    const player = new PcmPlayer()
    expect(player.audioLevel()).toBe(0)
    player.enqueue(pcm(500))
    expect(ctx.analyserCount).toBe(0)
    expect(ctx.sources[0].connections).toEqual([ctx.destination])
    ctx.level = 0.1
    expect(player.audioLevel()).toBeCloseTo(0.736)
    expect(ctx.sources[0].connections).toHaveLength(2)
    player.audioLevel()
    expect(ctx.analyserCount).toBe(1)
    player.enqueue(pcm(500))
    expect(ctx.sources[1].connections).toEqual(ctx.sources[0].connections)
  })

  it('静音、挂起和打断之后不保留嘴部驱动音量', () => {
    const player = new PcmPlayer()
    player.enqueue(pcm(500))
    ctx.level = 0.004
    expect(player.audioLevel()).toBe(0)
    ctx.level = 0.5
    expect(player.audioLevel()).toBe(1)
    ctx.state = 'suspended'
    expect(player.audioLevel()).toBe(0)
    ctx.state = 'running'
    ctx.level = NaN
    expect(player.audioLevel()).toBe(0)
    ctx.level = 0.5
    player.flush()
    expect(player.audioLevel()).toBe(0)
    player.close()
    expect(player.audioLevel()).toBe(0)
  })

  it('position() 报正在播的 item 与已播毫秒，按各 source 的 start 时刻算', () => {
    const player = new PcmPlayer()
    player.beginItem('a')
    player.enqueue('a', pcm(100))
    player.enqueue('a', pcm(100))
    player.endItem('a')
    player.beginItem('b')
    player.enqueue('b', pcm(100))
    // 第一块先留出抖动缓冲，后面紧接着排
    expect(ctx.sources.map((s) => Math.round(s.startedAt * 1000))).toEqual([120, 220, 320])

    expect(player.position()).toEqual({ itemId: 'a', playedMs: 0 })
    ctx.currentTime = 0.11
    expect(player.position()).toEqual({ itemId: 'a', playedMs: 0 })
    ctx.currentTime = 0.2
    expect(player.position()).toEqual({ itemId: 'a', playedMs: 80 })
    ctx.currentTime = 0.3
    expect(player.position()).toEqual({ itemId: 'a', playedMs: 180 })
  })

  it('网络卡顿留下的空档不算播了', () => {
    const player = new PcmPlayer()
    player.enqueue('a', pcm(100))
    ctx.currentTime = 0.5
    player.enqueue('a', pcm(100))
    expect(ctx.sources[1].startedAt).toBeCloseTo(0.68, 9)
    ctx.currentTime = 0.72
    expect(player.position()).toEqual({ itemId: 'a', playedMs: 140 })
  })

  it('flush() 返回停在哪，然后停掉全部 source 并清空', () => {
    const player = new PcmPlayer()
    player.enqueue('a', pcm(100))
    player.enqueue('a', pcm(100))
    ctx.currentTime = 0.1
    expect(player.flush()).toEqual({ itemId: 'a', playedMs: 0 })
    expect(ctx.sources.every((s) => s.stopped)).toBe(true)
    expect(ctx.sources.every((s) => s.onended === null)).toBe(true)
    expect(player.position()).toEqual({ itemId: null, playedMs: 0 })
    expect(player.remaining()).toBe(0)
    // 清空后再排从头算
    player.enqueue('b', pcm(100))
    expect(ctx.sources[2].startedAt).toBeCloseTo(0.22, 9)
  })

  it('onItemEnded 要等最后一个 source ended 且 endItem 已调用', () => {
    const player = new PcmPlayer()
    const ended: string[] = []
    player.onItemEnded((id) => ended.push(id))
    player.beginItem('a')
    player.enqueue('a', pcm(100))
    player.enqueue('a', pcm(100))
    ctx.sources[0].onended?.()
    expect(ended).toEqual([])
    player.endItem('a')
    expect(ended).toEqual([])
    ctx.sources[1].onended?.()
    expect(ended).toEqual(['a'])
    expect(player.position()).toEqual({ itemId: null, playedMs: 0 })
  })

  it('音频先播完、endItem 后到：endItem 那一刻触发', () => {
    const player = new PcmPlayer()
    const ended: string[] = []
    player.onItemEnded((id) => ended.push(id))
    player.enqueue('a', pcm(100))
    ctx.sources[0].onended?.()
    expect(ended).toEqual([])
    player.endItem('a')
    expect(ended).toEqual(['a'])
  })

  it('旧式 enqueue(data) 归到当前 item', () => {
    const player = new PcmPlayer()
    player.beginItem('a')
    player.enqueue(pcm(100))
    ctx.currentTime = 0.1
    expect(player.position()).toEqual({ itemId: 'a', playedMs: 0 })
  })

  it('从没 beginItem 的陪练页：不记账但照常播', () => {
    const player = new PcmPlayer()
    player.enqueue(pcm(100))
    expect(ctx.sources[0].startedAt).toBe(0.12)
    expect(player.position()).toEqual({ itemId: null, playedMs: 0 })
    expect(player.remaining()).toBeCloseTo(0.22, 5)
  })

  it('enqueueDecoded 按 AudioBuffer 的时长记账', () => {
    const player = new PcmPlayer()
    const ended: string[] = []
    player.onItemEnded((id) => ended.push(id))
    player.enqueueDecoded('mp3', { duration: 1.5 } as unknown as AudioBuffer)
    player.endItem('mp3')
    ctx.currentTime = 1
    expect(player.position()).toEqual({ itemId: 'mp3', playedMs: 880 })
    ctx.sources[0].onended?.()
    expect(ended).toEqual(['mp3'])
  })

  it('不足 4 字节的尾巴丢掉，空块不排', () => {
    const player = new PcmPlayer()
    player.enqueue('a', new ArrayBuffer(3))
    expect(ctx.sources).toEqual([])
    player.enqueue('a', new ArrayBuffer(7))
    expect(ctx.sources.length).toBe(1)
    expect(ctx.sources[0].buffer?.duration).toBeCloseTo(1 / 24_000, 9)
  })
})
