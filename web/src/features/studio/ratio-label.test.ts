/* 扩图侧栏里「出图也按这个尺寸（16:9）」那个比例名的守卫。
 *
   写错不报错，只是标签显示成怪数——用户拖出 16:9 的外框，
   侧栏却写着 1.78:1，会以为自己拖歪了。 */

import { describe, expect, it } from 'vitest'

import { ratioLabel } from './image-math'

describe('ratioLabel', () => {
  it('常见比例给出名字而不是小数', () => {
    expect(ratioLabel(1024, 1024)).toBe('1:1')
    expect(ratioLabel(1536, 864)).toBe('16:9')
    expect(ratioLabel(864, 1536)).toBe('9:16')
    expect(ratioLabel(1536, 1024)).toBe('3:2')
    expect(ratioLabel(1024, 1536)).toBe('2:3')
    expect(ratioLabel(1152, 864)).toBe('4:3')
  })

  it('拖出来的尺寸有零头也认得出——用户不可能拖到像素级精确', () => {
    expect(ratioLabel(1537, 863)).toBe('16:9')
    expect(ratioLabel(1020, 1024)).toBe('1:1')
  })

  it('差得远就不硬套名字，报小数比', () => {
    expect(ratioLabel(3000, 500)).toBe('6.00:1')
    expect(ratioLabel(1000, 700)).toMatch(/^1\.4\d:1$/)
  })

  it('高为 0 时不除零崩掉', () => {
    expect(() => ratioLabel(100, 0)).not.toThrow()
  })
})
