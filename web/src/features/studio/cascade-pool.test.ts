/* 级联并发池的守卫（CR-005 §3.3 · 需求 17 §6.5.2）。
 *
   蓝本 `smartCascadeParallelLimit()` 把并发硬编码成 6，用户明确要求「不限制」。
   这里守的是「产品级限制真的没了」和「防手滑的物理上限还在」这两件事同时成立——
   两边都是改一个数字就悄悄失效、要跑一次真实级联才看得出来的那类。 */

import { describe, expect, it } from 'vitest'

import { CASCADE_POOL_DEFAULT, CASCADE_POOL_MAX, LOOP_MAX, cascadePoolSize } from './canvasStore'

describe('并发池大小', () => {
  it('不配就用默认 8（蓝本是硬编码 6，且不可配）', () => {
    expect(CASCADE_POOL_DEFAULT).toBe(8)
    expect(cascadePoolSize(undefined, 100)).toBe(8)
  })

  it('节点上配了就听节点的——这是「可配」的全部意思', () => {
    expect(cascadePoolSize(1, 100)).toBe(1)
    expect(cascadePoolSize(16, 100)).toBe(16)
    expect(cascadePoolSize(32, 100)).toBe(32)
  })

  it('远超蓝本的 6：配 20 就真的开 20 个槽', () => {
    expect(cascadePoolSize(20, 50)).toBe(20)
  })

  it('物理上限 64 仍在，防的是输入框多打一个零', () => {
    expect(CASCADE_POOL_MAX).toBe(64)
    expect(cascadePoolSize(999, 5000)).toBe(64)
  })

  it('槽不会开得比轮数多——多出来的槽建出来立刻就退出，白占内存', () => {
    expect(cascadePoolSize(16, 3)).toBe(3)
    expect(cascadePoolSize(8, 1)).toBe(1)
  })

  it('非法配置回落默认而不是崩掉（旧画布可能存着脏值）', () => {
    expect(cascadePoolSize(0, 10)).toBe(CASCADE_POOL_DEFAULT)
    expect(cascadePoolSize(-5, 10)).toBe(CASCADE_POOL_DEFAULT)
    expect(cascadePoolSize(NaN, 10)).toBe(CASCADE_POOL_DEFAULT)
  })

  it('小数向下取整，不会出现 3.7 个槽', () => {
    expect(cascadePoolSize(3.7, 10)).toBe(3)
  })

  it('轮数为 0 或负数时至少给一个槽', () => {
    expect(cascadePoolSize(8, 0)).toBe(1)
    expect(cascadePoolSize(8, -3)).toBe(1)
  })
})

describe('轮数上限', () => {
  it('不再是 20：产品级限制已按 CR-005 去掉', () => {
    expect(LOOP_MAX).toBeGreaterThan(20)
  })

  it('仍留一个物理上限，防止输入框里多打一个零', () => {
    expect(LOOP_MAX).toBe(999)
  })
})
