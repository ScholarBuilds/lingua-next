import { describe, expect, it } from 'vitest'

import { applyAngleInstruction, buildAngleInstruction } from './angleInstruction'

describe('source-compatible angle command', () => {
  it('uses degree-one camera moves and the source distance threshold', () => {
    expect(buildAngleInstruction({ yaw: 35, pitch: -12, distance: 4 }))
      .toBe('将相机向右旋转35度，仰视12度')
    expect(buildAngleInstruction({ yaw: 0, pitch: 0, distance: 3.9 }))
      .toBe('将相机使用特写镜头')
    expect(buildAngleInstruction({ yaw: -1, pitch: 1, distance: 4.1 }))
      .toBe('将相机向左旋转1度，俯视1度，使用广角镜头')
    expect(buildAngleInstruction({ yaw: 0, pitch: 0, distance: 4 })).toBe('')
  })

  it('replaces only the camera command and removes it at neutral', () => {
    expect(applyAngleInstruction('保留人物\n将相机向左旋转5度\n背景不变', '将相机俯视20度'))
      .toBe('保留人物\n将相机俯视20度\n背景不变')
    expect(applyAngleInstruction('保留人物\n将相机俯视20度', '')).toBe('保留人物')
    expect(applyAngleInstruction('保留人物', '')).toBe('保留人物')
  })
})
