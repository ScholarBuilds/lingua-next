import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { blinkAmount, mouthOpening } from './avatarMotion'

describe('数字人口型', () => {
  it('非播放状态立即闭嘴，不因收音或思考张嘴', () => {
    for (const state of ['connecting', 'listening', 'thinking', 'error', 'ended'] as const) {
      expect(mouthOpening(0.7, 1, state, 1 / 30)).toBe(0)
    }
  })
  it('播放时平滑跟随音量，静音快速收口', () => {
    const opening = mouthOpening(0, 0.7, 'speaking', 1 / 30)
    expect(opening).toBeGreaterThan(0)
    expect(opening).toBeLessThan(0.56)
    let silence = opening
    for (let i = 0; i < 8; i++) silence = mouthOpening(silence, 0, 'speaking', 1 / 30)
    expect(silence).toBeLessThan(0.01)
    expect(mouthOpening(0, 10, 'speaking', 1)).toBeLessThanOrEqual(0.8)
    expect(mouthOpening(0.5, NaN, 'speaking', 1 / 30)).toBe(0)
  })
  it('眨眼有闭合与睁开阶段，不长期遮住眼睛', () => {
    expect(blinkAmount(0.09)).toBeCloseTo(1)
    expect(blinkAmount(0.3)).toBe(0)
    expect(blinkAmount(4.79)).toBeCloseTo(1)
  })
})

describe('数字人打包资源', () => {
  const bytes = readFileSync(new URL('../../../public/avatars/partner.vrm', import.meta.url))
  const length = bytes.readUInt32LE(12)
  const gltf = JSON.parse(bytes.subarray(20, 20 + length).toString())
  it('模型内嵌纹理和骨骼，运行时不从外部站点下载', () => {
    expect(bytes.readUInt32LE(0)).toBe(0x46546c67)
    expect(bytes.readUInt32LE(8)).toBe(bytes.length)
    expect(bytes.length).toBeLessThan(16 * 1024 * 1024)
    expect(gltf.buffers).toHaveLength(1)
    expect(gltf.buffers[0].uri).toBeUndefined()
    expect(gltf.images.every((image: { uri?: string; bufferView?: number }) => !image.uri && image.bufferView !== undefined)).toBe(true)
    expect(gltf.extensions.VRM.humanoid.humanBones.some((bone: { bone: string }) => bone.bone === 'head')).toBe(true)
  })
  it('包含完整口型、表情与头发物理，不把人物许可误标为 CC0', () => {
    const vrm = gltf.extensions.VRM
    expect(vrm.blendShapeMaster.blendShapeGroups.map((shape: { presetName: string }) => shape.presetName))
      .toEqual(expect.arrayContaining(['a', 'i', 'u', 'e', 'o', 'blink', 'joy', 'fun']))
    expect(vrm.secondaryAnimation.boneGroups.length).toBeGreaterThan(0)
    expect(vrm.meta.author).toBe('VRoid')
    expect(vrm.meta.licenseName).toBe('Other')
    for (const view of gltf.bufferViews) {
      expect(view.byteOffset + view.byteLength).toBeLessThanOrEqual(gltf.buffers[0].byteLength)
    }
    const componentBytes: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }
    for (const accessor of gltf.accessors) {
      const offset = gltf.bufferViews[accessor.bufferView].byteOffset + (accessor.byteOffset ?? 0)
      expect(offset % componentBytes[accessor.componentType]).toBe(0)
    }
  })
})
