/* 统一麦克风采集器（CR-010 M2）：
   getUserMedia → AudioContext（浏览器默认采样率）→ AudioWorklet 里线性抽样到 16 kHz、
   Float→Int16、攒帧 → 回调一帧 Int16Array。陪练等实时语音入口
   共用这一套；不支持 AudioWorklet 时退回 ScriptProcessor，在主线程跑同一个抽样函数。

   抽样算法只写一份（createDownsampler）：主线程直接调用，worklet 线程把它的源码
   （Function.prototype.toString）拼进模块字符串——两边跑的是同一段代码，单测既覆盖
   纯函数，也把拼出来的 worklet 源码在 node 里执行一遍与纯函数对账。 */

import { requireMic } from './mic'

export const TARGET_RATE = 16_000

export interface Downsampler {
  /** 喂一块浮点采样，返回攒满的整帧（可能零帧或多帧），不足一帧的余量留到下次 */
  push(block: Float32Array): Int16Array[]
}

/* 这个函数会被 toString 后塞进 AudioWorklet 全局作用域执行：
   只能用 Math / TypedArray 这类两边都有的全局，不能引用模块里任何别的东西。 */
export function createDownsampler(inRate: number, outRate: number, frameSamples: number): Downsampler {
  const ratio = inRate / outRate
  let buf = new Int16Array(frameSamples)
  let fill = 0
  // 跨块累积的读位置：一块没走完的小数步长要带到下一块，否则非整数比率会丢样本
  let pos = 0
  return {
    push(block: Float32Array): Int16Array[] {
      const frames: Int16Array[] = []
      while (pos < block.length) {
        const s = Math.max(-1, Math.min(1, block[Math.floor(pos)]))
        buf[fill] = s < 0 ? s * 0x8000 : s * 0x7fff
        fill += 1
        pos += ratio
        if (fill === frameSamples) {
          frames.push(buf)
          buf = new Int16Array(frameSamples)
          fill = 0
        }
      }
      pos -= block.length
      return frames
    },
  }
}

/** 一帧的 RMS，0..1 */
export function frameRms(pcm: Int16Array): number {
  if (pcm.length === 0) return 0
  let sum = 0
  for (let i = 0; i < pcm.length; i += 1) {
    const v = pcm[i] / 0x8000
    sum += v * v
  }
  return Math.sqrt(sum / pcm.length)
}

export const WORKLET_PROCESSOR_NAME = 'pcm-capture'

/** worklet 模块源码。processorOptions 带 outRate 与 frameSamples，sampleRate 是 worklet 全局 */
export function buildWorkletSource(): string {
  return `
const createDownsampler = ${createDownsampler.toString()}
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const { outRate, frameSamples } = options.processorOptions
    this.downsampler = createDownsampler(sampleRate, outRate, frameSamples)
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    for (const frame of this.downsampler.push(ch)) this.port.postMessage(frame, [frame.buffer])
    return true
  }
}
registerProcessor('${WORKLET_PROCESSOR_NAME}', PcmCaptureProcessor)
`
}

export interface PcmCaptureOptions {
  /** 每帧毫秒数，默认 40 */
  frameMs?: number
  /** 默认 true；跟读比对这类要保留原始动态的场景关掉 */
  autoGainControl?: boolean
}

export class PcmCapture {
  private readonly frameSamples: number
  private readonly autoGainControl: boolean
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private node: AudioWorkletNode | ScriptProcessorNode | null = null
  private silentGain: GainNode | null = null
  private onFrame: ((pcm: Int16Array) => void) | null = null
  private muted = false
  private lastRms = 0
  // stop() 在 start() 的 await 中途被调时（权限弹窗还开着就关了面板），起完不能再把流留着
  private generation = 0

  constructor(options: PcmCaptureOptions = {}) {
    this.frameSamples = Math.round((TARGET_RATE * (options.frameMs ?? 40)) / 1000)
    this.autoGainControl = options.autoGainControl ?? true
  }

  /** 抛出的错误 message 已是可展示的中文提示 */
  async start(onFrame: (pcm: Int16Array) => void): Promise<void> {
    const gen = this.generation
    this.onFrame = onFrame
    let stream: MediaStream
    try {
      stream = await requireMic({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: this.autoGainControl,
        },
      })
    } catch (err) {
      // requireMic 自己抛的安全上下文提示已经是中文，原样上抛；DOMException 才按权限/设备翻译
      if (!(err instanceof DOMException)) throw err
      if (err.name === 'NotAllowedError' || err.name === 'SecurityError')
        throw new Error('麦克风权限被拒绝，请在浏览器地址栏允许麦克风后重试')
      if (err.name === 'NotFoundError') throw new Error('未检测到麦克风设备')
      throw new Error('麦克风启动失败，请检查设备与浏览器设置')
    }
    if (gen !== this.generation) {
      stream.getTracks().forEach((t) => t.stop())
      return
    }
    this.stream = stream

    // 从这里起流与上下文都挂在实例上，中途 stop() 会替下面的 await 收尾
    const ctx = new AudioContext()
    this.ctx = ctx
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {})
    if (gen !== this.generation) return
    this.source = ctx.createMediaStreamSource(stream)
    // 采集节点必须接到 destination 才会被驱动，用 0 增益避免回放自己的声音
    this.silentGain = ctx.createGain()
    this.silentGain.gain.value = 0
    this.silentGain.connect(ctx.destination)

    if (ctx.audioWorklet) {
      const url = URL.createObjectURL(new Blob([buildWorkletSource()], { type: 'text/javascript' }))
      try {
        await ctx.audioWorklet.addModule(url)
      } finally {
        URL.revokeObjectURL(url)
      }
      if (gen !== this.generation) return
      const node = new AudioWorkletNode(ctx, WORKLET_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        processorOptions: { outRate: TARGET_RATE, frameSamples: this.frameSamples },
      })
      node.port.onmessage = (ev: MessageEvent<Int16Array>) => this.deliver(ev.data)
      this.source.connect(node)
      node.connect(this.silentGain)
      this.node = node
    } else {
      const downsampler = createDownsampler(ctx.sampleRate, TARGET_RATE, this.frameSamples)
      const node = ctx.createScriptProcessor(4096, 1, 1)
      node.onaudioprocess = (ev) => {
        for (const frame of downsampler.push(ev.inputBuffer.getChannelData(0))) this.deliver(frame)
      }
      this.source.connect(node)
      node.connect(this.silentGain)
      this.node = node
    }
  }

  private deliver(frame: Int16Array): void {
    if (this.muted || !this.onFrame) return
    this.lastRms = frameRms(frame)
    this.onFrame(frame)
  }

  /** 静音只拦回调，流与 AudioContext 都留着，恢复时不用再要一次权限 */
  setMuted(on: boolean): void {
    this.muted = on
    if (on) this.lastRms = 0
  }

  /** 最近一帧的 RMS（0..1），给 HUD 画波形 */
  level(): number {
    return this.lastRms
  }

  stop(): void {
    this.generation += 1
    this.onFrame = null
    this.lastRms = 0
    if (this.node) {
      if ('port' in this.node) this.node.port.onmessage = null
      else this.node.onaudioprocess = null
      this.node.disconnect()
      this.node = null
    }
    this.source?.disconnect()
    this.source = null
    this.silentGain?.disconnect()
    this.silentGain = null
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    void this.ctx?.close().catch(() => {})
    this.ctx = null
  }
}
