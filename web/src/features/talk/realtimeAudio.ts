/* 实时语音音频管线
   上行：lib/pcmCapture 的 PcmCapture（100ms 块，16k Int16），MicCapture 只是它的薄封装
   下行：PCM 24k float32 小端块（或 decodeAudioData 出来的 AudioBuffer）→ 按 scheduledTime
        顺序排队播放；按 item 记账，打断时 flush() 报出播到哪一句、播了多少毫秒 */

import { PcmCapture } from '../../lib/pcmCapture'

const PLAYBACK_RATE = 24000
const START_BUFFER_S = 0.12
const RECOVERY_BUFFER_S = 0.18

export class MicCapture extends PcmCapture {
  constructor() {
    super({ frameMs: 100 })
  }
}

interface PlayItem {
  id: string
  /** 每个 source 的起播时刻与时长（AudioContext 时钟），播了多少毫秒按它们逐段算 */
  segments: { at: number; dur: number }[]
  /** 已排上、还没 ended 的 source 数 */
  pending: number
  /** endItem 已调用：最后一个 source ended 就算这句播完 */
  closed: boolean
}

export interface PlayPosition {
  itemId: string | null
  playedMs: number
}

export interface PlaybackTelemetry {
  event: 'first_frame' | 'underrun'
  itemId: string | null
  delayMs?: number
  durationMs?: number
}

export interface PcmPlayerOptions {
  /* Chromium 的回声消除只拿「经 WebRTC 收到的 MediaStream 在 <audio> 里播出的声音」当参考信号，
     AudioContext 直接出的声音它听不见——念回复时麦克风会把回复原样录回去。开了之后输出改接
     MediaStreamDestination，经一对本机 RTCPeerConnection 环回到 <audio> 播放。 */
  viaLoopback?: boolean
}

export class PcmPlayer {
  private ctx: AudioContext
  private output: AudioNode
  private analyser: AnalyserNode | null = null
  private samples = new Float32Array(512)
  private spectrum = new Uint8Array(256)
  private scheduled = 0
  private sources = new Map<AudioBufferSourceNode, PlayItem | null>()
  private items: PlayItem[] = []
  private current: PlayItem | null = null
  private itemEndedCb: ((itemId: string) => void) | null = null
  private telemetryCb: ((event: PlaybackTelemetry) => void) | null = null
  private loopback: { peers: RTCPeerConnection[]; el: HTMLAudioElement } | null = null
  private loopbackReady: Promise<'ready' | 'unavailable'> | null = null
  private loopbackState: 'not_requested' | 'pending' | 'ready' | 'unavailable' = 'not_requested'

  constructor(options: PcmPlayerOptions = {}) {
    this.ctx = new AudioContext({ sampleRate: PLAYBACK_RATE })
    this.output = this.ctx.destination
    if (options.viaLoopback) this.loopbackReady = this.setupLoopback()
  }

  private setupLoopback(): Promise<'ready' | 'unavailable'> {
    this.loopbackState = 'pending'
    const dest = this.ctx.createMediaStreamDestination()
    this.output = dest
    const el = new Audio()
    el.autoplay = true
    const sender = new RTCPeerConnection()
    const receiver = new RTCPeerConnection()
    sender.onicecandidate = (e) => {
      if (e.candidate) void receiver.addIceCandidate(e.candidate).catch(() => {})
    }
    receiver.onicecandidate = (e) => {
      if (e.candidate) void sender.addIceCandidate(e.candidate).catch(() => {})
    }
    for (const track of dest.stream.getTracks()) sender.addTrack(track, dest.stream)
    this.loopback = { peers: [sender, receiver], el }
    return new Promise((resolve) => {
      let settled = false
      const finish = (status: 'ready' | 'unavailable') => {
        if (settled) return
        settled = true
        this.loopbackState = status
        if (status === 'unavailable') this.output = this.ctx.destination
        resolve(status)
      }
      const timer = setTimeout(() => finish('unavailable'), 2000)
      receiver.ontrack = (e) => {
        el.srcObject = e.streams[0]
        void el.play().catch(() => {})
        clearTimeout(timer)
        finish('ready')
      }
      receiver.onconnectionstatechange = () => {
        if (receiver.connectionState === 'failed' || receiver.connectionState === 'closed') {
          clearTimeout(timer)
          finish('unavailable')
        }
      }
      void (async () => {
        const offer = await sender.createOffer()
        await sender.setLocalDescription(offer)
        await receiver.setRemoteDescription(offer)
        const answer = await receiver.createAnswer()
        await receiver.setLocalDescription(answer)
        await sender.setRemoteDescription(answer)
      })().catch(() => {
        clearTimeout(timer)
        finish('unavailable')
      })
    })
  }

  get aecStatus(): 'not_requested' | 'pending' | 'ready' | 'unavailable' {
    return this.loopbackState
  }

  async prepare(): Promise<'not_requested' | 'ready' | 'unavailable'> {
    return this.loopbackReady ?? 'not_requested'
  }

  /** 浏览器自动播放策略下 AudioContext 可能挂起，需要用户手势后 resume */
  get blocked(): boolean {
    return this.ctx.state === 'suspended'
  }

  /** 只旁路分析播放输出，不改变扬声器或 AEC 的连接。 */
  audioLevel(): number {
    if (this.ctx.state !== 'running' || this.sources.size === 0) return 0
    if (!this.analyser) {
      this.analyser = this.ctx.createAnalyser()
      this.analyser.fftSize = this.samples.length
      for (const source of this.sources.keys()) source.connect(this.analyser)
    }
    this.analyser.getFloatTimeDomainData(this.samples)
    let energy = 0
    for (const sample of this.samples) energy += sample * sample
    const rms = Math.sqrt(energy / this.samples.length)
    return Number.isFinite(rms) ? Math.min(1, Math.max(0, (rms - 0.008) * 8)) : 0
  }

  audioBrightness(): number {
    if (!this.analyser || this.ctx.state !== 'running' || this.sources.size === 0) return 0.5
    this.analyser.getByteFrequencyData(this.spectrum)
    let weight = 0
    let frequency = 0
    const step = this.ctx.sampleRate / this.samples.length
    for (let i = 1; i < this.spectrum.length && i * step < 4000; i++) {
      const power = this.spectrum[i] ** 2
      weight += power
      frequency += power * i * step
    }
    return weight ? Math.min(1, Math.max(0, (frequency / weight - 400) / 2200)) : 0.5
  }

  async resume(): Promise<void> {
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {})
    if (this.loopback) await this.loopback.el.play().catch(() => {})
  }

  /** mp3 这类压缩音频先解码再走 enqueueDecoded */
  decode(data: ArrayBuffer): Promise<AudioBuffer> {
    return this.ctx.decodeAudioData(data)
  }

  beginItem(itemId: string): void {
    this.current = this.itemFor(itemId)
  }

  private itemFor(itemId: string): PlayItem {
    const found = this.items.find((it) => it.id === itemId)
    if (found) return found
    const item: PlayItem = { id: itemId, segments: [], pending: 0, closed: false }
    this.items.push(item)
    return item
  }

  enqueue(data: ArrayBuffer): void
  enqueue(itemId: string, data: ArrayBuffer): void
  enqueue(first: string | ArrayBuffer, second?: ArrayBuffer): void {
    const data = typeof first === 'string' ? second : first
    if (!data) return
    const usable = data.byteLength - (data.byteLength % 4)
    if (usable <= 0) return
    const f32 = new Float32Array(data, 0, usable / 4)
    const buf = this.ctx.createBuffer(1, f32.length, PLAYBACK_RATE)
    buf.copyToChannel(f32, 0)
    // 旧签名不带 itemId：归到当前 item（陪练页从不 beginItem，那就不记账）
    this.schedule(buf, typeof first === 'string' ? this.itemFor(first) : this.current)
  }

  enqueueDecoded(itemId: string, buffer: AudioBuffer): void {
    this.schedule(buffer, this.itemFor(itemId))
  }

  private schedule(buf: AudioBuffer, item: PlayItem | null): void {
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    src.connect(this.output)
    if (this.analyser) src.connect(this.analyser)
    const now = this.ctx.currentTime
    const underrun = this.scheduled > 0 && this.scheduled < now
    if (underrun) {
      this.telemetryCb?.({
        event: 'underrun',
        itemId: item?.id ?? null,
        durationMs: Math.round((now - this.scheduled) * 1000),
      })
    }
    const firstFrame = item !== null && item.segments.length === 0
    const at = Math.max(now + (underrun ? RECOVERY_BUFFER_S : START_BUFFER_S), this.scheduled)
    src.start(at)
    this.scheduled = at + buf.duration
    this.sources.set(src, item)
    if (item) {
      item.segments.push({ at, dur: buf.duration })
      item.pending += 1
    }
    if (firstFrame) {
      this.telemetryCb?.({
        event: 'first_frame',
        itemId: item.id,
        delayMs: Math.round((at - now) * 1000),
      })
    }
    src.onended = () => {
      this.sources.delete(src)
      if (item) {
        item.pending -= 1
        this.settle(item)
      }
    }
  }

  endItem(itemId: string): void {
    const item = this.items.find((it) => it.id === itemId)
    if (!item) return
    item.closed = true
    this.settle(item)
  }

  private settle(item: PlayItem): void {
    if (!item.closed || item.pending > 0) return
    this.items = this.items.filter((it) => it !== item)
    if (this.current === item) this.current = null
    this.itemEndedCb?.(item.id)
  }

  onItemEnded(cb: ((itemId: string) => void) | null): void {
    this.itemEndedCb = cb
  }

  onTelemetry(cb: ((event: PlaybackTelemetry) => void) | null): void {
    this.telemetryCb = cb
  }

  /** 正在播的 item 与它已播的毫秒数；还没起播时报第一个排队的、0 毫秒 */
  position(): PlayPosition {
    if (this.items.length === 0) return { itemId: null, playedMs: 0 }
    const now = this.ctx.currentTime
    let playing = this.items[0]
    for (const item of this.items) {
      if (item.segments.length > 0 && item.segments[0].at <= now) playing = item
    }
    let played = 0
    for (const seg of playing.segments) played += Math.min(seg.dur, Math.max(0, now - seg.at))
    return { itemId: playing.id, playedMs: Math.round(played * 1000) }
  }

  /** 距队列播完的剩余秒数 */
  remaining(): number {
    return Math.max(0, this.scheduled - this.ctx.currentTime)
  }

  /** 用户开口打断：立即停止并清空播放队列，返回停在哪（前端要把 playedMs 报给服务端） */
  flush(): PlayPosition {
    const pos = this.position()
    for (const src of this.sources.keys()) {
      try {
        src.onended = null
        src.stop()
      } catch {
        /* 已停止的节点重复 stop 会抛错，忽略 */
      }
    }
    this.sources.clear()
    this.items = []
    this.current = null
    this.scheduled = 0
    return pos
  }

  close(): void {
    this.flush()
    this.analyser?.disconnect()
    this.analyser = null
    if (this.loopback) {
      for (const pc of this.loopback.peers) pc.close()
      this.loopback.el.pause()
      this.loopback.el.srcObject = null
      this.loopback = null
    }
    void this.ctx.close().catch(() => {})
  }
}
