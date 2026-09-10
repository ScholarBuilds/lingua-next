/* 抽样纯函数与 worklet 源码的对账。
   worklet 代码在浏览器里是另一个线程上的一段字符串，这里用 new Function 把拼出来的模块
   在 node 里跑起来，喂同一段输入，要求与纯函数逐样本一致——算法只允许有一份。 */

import { describe, expect, it } from 'vitest'

import { WORKLET_PROCESSOR_NAME, buildWorkletSource, createDownsampler, frameRms } from './pcmCapture'

function sine(rate: number, hz: number, seconds: number, amp = 0.5): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds))
  for (let i = 0; i < out.length; i += 1) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / rate)
  return out
}

function chunks(block: Float32Array, size: number): Float32Array[] {
  const parts: Float32Array[] = []
  for (let i = 0; i < block.length; i += size) parts.push(block.subarray(i, Math.min(block.length, i + size)))
  return parts
}

describe('createDownsampler', () => {
  it('48k → 16k：一秒正弦出 16000 样本，幅度保持', () => {
    const ds = createDownsampler(48_000, 16_000, 640)
    const frames = chunks(sine(48_000, 440, 1), 128).flatMap((c) => ds.push(c))
    expect(frames.length).toBe(25)
    const all = new Int16Array(frames.length * 640)
    frames.forEach((f, i) => all.set(f, i * 640))
    let peak = 0
    for (const v of all) peak = Math.max(peak, Math.abs(v))
    expect(peak).toBeGreaterThan(0.5 * 0x7fff * 0.98)
    expect(peak).toBeLessThanOrEqual(0.5 * 0x7fff + 1)
    // 幅度对了还得频率对：440 Hz 一秒过零 880 次
    let crossings = 0
    for (let i = 1; i < all.length; i += 1) if ((all[i - 1] < 0) !== (all[i] < 0)) crossings += 1
    expect(Math.abs(crossings - 880)).toBeLessThanOrEqual(2)
  })

  it('跨块累积：正好凑满整帧的那一块才吐帧，余量留到下一块', () => {
    const ds = createDownsampler(16_000, 16_000, 100)
    expect(ds.push(new Float32Array(60))).toEqual([])
    const frames = ds.push(new Float32Array(40))
    expect(frames.length).toBe(1)
    expect(frames[0].length).toBe(100)
    expect(ds.push(new Float32Array(250)).length).toBe(2)
    expect(ds.push(new Float32Array(50)).length).toBe(1)
  })

  it('44.1k 非整数比率不丢样本：十秒输入抽出 160000 ± 1 个', () => {
    // 帧长 1 让每个抽出的样本都立刻吐出来，数出来的就是抽样总数
    const ds = createDownsampler(44_100, 16_000, 1)
    let total = 0
    for (const c of chunks(sine(44_100, 300, 10), 128)) total += ds.push(c).length
    expect(Math.abs(total - 160_000)).toBeLessThanOrEqual(1)
  })

  it('每帧都是新分配的缓冲区，可以整块 transfer 出去', () => {
    const ds = createDownsampler(16_000, 16_000, 10)
    const [a, b] = ds.push(new Float32Array(20))
    expect(a.buffer).not.toBe(b.buffer)
    expect(a.byteLength).toBe(20)
  })

  it('削波：超出 ±1 的输入压到 Int16 边界', () => {
    const ds = createDownsampler(16_000, 16_000, 2)
    const [f] = ds.push(new Float32Array([2, -2]))
    expect(f[0]).toBe(0x7fff)
    expect(f[1]).toBe(-0x8000)
  })
})

describe('frameRms', () => {
  it('静音帧 RMS 为 0', () => {
    expect(frameRms(new Int16Array(1280))).toBe(0)
    expect(frameRms(new Int16Array(0))).toBe(0)
  })

  it('满幅方波 RMS 为 1，半幅正弦约 0.35', () => {
    const square = new Int16Array(100).fill(-0x8000)
    expect(frameRms(square)).toBe(1)
    const ds = createDownsampler(16_000, 16_000, 16_000)
    const [f] = ds.push(sine(16_000, 440, 1))
    expect(frameRms(f)).toBeCloseTo(0.5 / Math.SQRT2, 2)
  })
})

describe('worklet 源码与纯函数同一算法', () => {
  interface FakePort {
    posted: Int16Array[]
    postMessage(frame: Int16Array): void
  }
  interface Processor {
    process(inputs: Float32Array[][]): boolean
    port: FakePort
  }
  type ProcessorCtor = new (options: { processorOptions: { outRate: number; frameSamples: number } }) => Processor

  function loadWorklet(sampleRate: number): ProcessorCtor {
    class AudioWorkletProcessor {
      port: FakePort = {
        posted: [],
        postMessage(frame: Int16Array) {
          this.posted.push(frame)
        },
      }
    }
    const registered: { name: string; ctor: ProcessorCtor }[] = []
    const run = new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', buildWorkletSource()) as (
      base: typeof AudioWorkletProcessor,
      register: (name: string, ctor: ProcessorCtor) => void,
      rate: number,
    ) => void
    run(AudioWorkletProcessor, (name, ctor) => registered.push({ name, ctor }), sampleRate)
    expect(registered.map((r) => r.name)).toEqual([WORKLET_PROCESSOR_NAME])
    return registered[0].ctor
  }

  it('48k 与 44.1k 下 worklet 吐出的帧与纯函数逐样本一致', () => {
    for (const rate of [48_000, 44_100]) {
      const Ctor = loadWorklet(rate)
      const proc = new Ctor({ processorOptions: { outRate: 16_000, frameSamples: 640 } })
      const ds = createDownsampler(rate, 16_000, 640)
      const expected: Int16Array[] = []
      for (const c of chunks(sine(rate, 523, 0.5, 0.8), 128)) {
        expected.push(...ds.push(c))
        expect(proc.process([[c]])).toBe(true)
      }
      expect(expected.length).toBeGreaterThan(5)
      expect(proc.port.posted.length).toBe(expected.length)
      proc.port.posted.forEach((f, i) => expect(Array.from(f)).toEqual(Array.from(expected[i])))
    }
  })

  it('没有输入通道时不吐帧也不报错', () => {
    const Ctor = loadWorklet(48_000)
    const proc = new Ctor({ processorOptions: { outRate: 16_000, frameSamples: 640 } })
    expect(proc.process([[]])).toBe(true)
    expect(proc.port.posted).toEqual([])
  })
})
