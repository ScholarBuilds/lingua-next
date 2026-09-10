/* 下行 PCM 播放器（带音量分析）。
   来源：复制自 ../talk/realtimeAudio.ts 的 PcmPlayer 并加装 AnalyserNode —
   原版 source 直连 destination 取不到实时音量，而 talk 模块约定只读不改，
   故在 mascot 内维护 source → analyser → destination 的精简版，
   level() 输出 0~1 音量包络用于驱动看板娘嘴型。 */

const PLAYBACK_RATE = 24000

export class AnalyserPcmPlayer {
  private ctx: AudioContext
  private analyser: AnalyserNode
  private timeData: Uint8Array<ArrayBuffer>
  private scheduled = 0
  private sources = new Set<AudioBufferSourceNode>()

  constructor() {
    this.ctx = new AudioContext({ sampleRate: PLAYBACK_RATE })
    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = 512
    this.analyser.smoothingTimeConstant = 0.6
    this.analyser.connect(this.ctx.destination)
    this.timeData = new Uint8Array(this.analyser.fftSize)
  }

  /** 浏览器自动播放策略下 AudioContext 可能挂起，需要用户手势后 resume */
  get blocked(): boolean {
    return this.ctx.state === 'suspended'
  }

  async resume(): Promise<void> {
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {})
  }

  enqueue(data: ArrayBuffer): void {
    const usable = data.byteLength - (data.byteLength % 4)
    if (usable <= 0) return
    const f32 = new Float32Array(data, 0, usable / 4)
    const buf = this.ctx.createBuffer(1, f32.length, PLAYBACK_RATE)
    buf.copyToChannel(f32, 0)
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    src.connect(this.analyser)
    const at = Math.max(this.ctx.currentTime + 0.06, this.scheduled)
    src.start(at)
    this.scheduled = at + buf.duration
    this.sources.add(src)
    src.onended = () => this.sources.delete(src)
  }

  /** 距队列播完的剩余秒数 */
  remaining(): number {
    return Math.max(0, this.scheduled - this.ctx.currentTime)
  }

  /** 当前播放音量 0~1（RMS 归一化），无声约等于 0 */
  level(): number {
    if (this.ctx.state !== 'running') return 0
    this.analyser.getByteTimeDomainData(this.timeData)
    let sum = 0
    for (let i = 0; i < this.timeData.length; i += 1) {
      const d = (this.timeData[i] - 128) / 128
      sum += d * d
    }
    // 语音 RMS 通常 <0.3，放大后截断到 0~1
    return Math.min(1, Math.sqrt(sum / this.timeData.length) * 4)
  }

  /** 用户开口打断：立即停止并清空播放队列 */
  flush(): void {
    for (const src of this.sources) {
      try {
        src.onended = null
        src.stop()
      } catch {
        /* 已停止的节点重复 stop 会抛错，忽略 */
      }
    }
    this.sources.clear()
    this.scheduled = 0
  }

  close(): void {
    this.flush()
    void this.ctx.close().catch(() => {})
  }
}
