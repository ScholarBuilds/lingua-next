/* 完成提示音的守卫。
 *
   守两条：
   1. **出不来声不能打断任何流程**——AudioContext 会因为自动播放策略、隐私模式、
      老浏览器而失败，让出图流程跟着抛异常是完全不成比例的；
   2. **读不到设置时默认开着**，而不是哑掉。

   测试跑在 node 里（本仓 vitest 没配 jsdom），所以 window / localStorage 都要自己搭桩。
   模块本身也必须能在没有这些全局的环境里活下来——它就是这么写的，这里顺带把它钉住。 */

import { afterEach, describe, expect, it } from 'vitest'

import { chime, chimeEnabled, setChimeEnabled } from '../../lib/chime'

const g = globalThis as Record<string, unknown>

function fakeStorage(): void {
  const map = new Map<string, string>()
  g.localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  }
}

function throwingStorage(): void {
  g.localStorage = {
    getItem: () => {
      throw new Error('隐私模式')
    },
    setItem: () => {
      throw new Error('配额满了')
    },
  }
}

afterEach(() => {
  delete g.localStorage
  delete g.window
})

describe('chimeEnabled · 开关', () => {
  it('默认开着——用户没表态时该出声', () => {
    fakeStorage()
    expect(chimeEnabled()).toBe(true)
  })

  it('关掉之后记得住', () => {
    fakeStorage()
    setChimeEnabled(false)
    expect(chimeEnabled()).toBe(false)
    setChimeEnabled(true)
    expect(chimeEnabled()).toBe(true)
  })

  it('storage 读不到时默认开着，而不是哑掉', () => {
    throwingStorage()
    expect(chimeEnabled()).toBe(true)
  })

  it('storage 写不进也不抛', () => {
    throwingStorage()
    expect(() => setChimeEnabled(false)).not.toThrow()
  })

  it('压根没有 localStorage（node / SSR）时也不抛', () => {
    expect(() => chimeEnabled()).not.toThrow()
    expect(chimeEnabled()).toBe(true)
  })
})

describe('chime · 失败一律静默', () => {
  it('没有 window 时不抛——出图流程不该因为一声提示音崩掉', () => {
    fakeStorage()
    expect(() => chime('done')).not.toThrow()
  })

  it('有 window 但没有 AudioContext（老浏览器）时不抛', () => {
    fakeStorage()
    g.window = {}
    expect(() => chime('done')).not.toThrow()
  })

  it('AudioContext 构造抛异常时不抛——自动播放策略拦住的典型形态', () => {
    fakeStorage()
    g.window = {
      AudioContext: function () {
        throw new Error('not allowed')
      },
    }
    expect(() => chime('done')).not.toThrow()
    expect(() => chime('fail')).not.toThrow()
  })

  it('关掉开关时直接返回，**不去碰 AudioContext**', () => {
    fakeStorage()
    setChimeEnabled(false)
    let touched = false
    g.window = {
      AudioContext: function () {
        touched = true
        throw new Error('不该走到这里')
      },
    }
    chime('done')
    expect(touched).toBe(false)
  })
})
