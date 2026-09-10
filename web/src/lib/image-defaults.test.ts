/* 前端生图默认值的守卫（需求 17 §6.4.1 · CR-005 §3.5）。
 *
   与 `server/tests/test_image_defaults.py` 对称。守两件事：出厂默认真的是 high；
   源码里没人再写 `?? 'medium'` 这种字面量默认——它不报错，只会让那条链路
   继续出中等质量的图，而界面上完全看不出来。 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { FALLBACK_QUALITY, QUALITIES, defaultQuality, normalizeQuality, resetDefaultQuality, setDefaultQuality } from './image-defaults'

const SRC = join(import.meta.dirname, '..')

describe('出厂默认', () => {
  it('是 high', () => {
    expect(FALLBACK_QUALITY).toBe('high')
    resetDefaultQuality()
    expect(defaultQuality()).toBe('high')
  })

  it('三档齐全', () => {
    expect([...QUALITIES]).toEqual(['low', 'medium', 'high'])
  })
})

describe('全局默认灌入', () => {
  it('接受合法值并生效', () => {
    resetDefaultQuality()
    setDefaultQuality('low')
    expect(defaultQuality()).toBe('low')
    resetDefaultQuality()
  })

  it('大小写与空白都容忍', () => {
    resetDefaultQuality()
    setDefaultQuality('  MEDIUM ')
    expect(defaultQuality()).toBe('medium')
    resetDefaultQuality()
  })

  it('非法值忽略，不把现状改坏', () => {
    resetDefaultQuality()
    setDefaultQuality('ultra')
    setDefaultQuality(undefined)
    setDefaultQuality(null)
    expect(defaultQuality()).toBe('high')
  })
})

describe('规整', () => {
  it('合法值原样通过', () => {
    resetDefaultQuality()
    expect(normalizeQuality('low')).toBe('low')
    expect(normalizeQuality('HIGH')).toBe('high')
  })

  it('空值与废弃档名回落全局默认，不抛错', () => {
    resetDefaultQuality()
    for (const raw of [undefined, null, '', 'ultra', 42, {}]) {
      expect(normalizeQuality(raw)).toBe('high')
    }
  })

  it('回落跟着全局默认走，不是写死 high', () => {
    resetDefaultQuality()
    setDefaultQuality('low')
    expect(normalizeQuality('ultra')).toBe('low')
    resetDefaultQuality()
  })
})

describe('源码里不许再有字面量默认', () => {
  /** `?? 'medium'` / `= 'medium'` / `|| "low"` 这类「默认值」形态。
   *  显式传值不算（`quality: 'low'` 作为实参是合法的，探测类调用就该显式要低质量）。 */
  const PATTERN = /(?:\?\?|\|\|)\s*['"](?:low|medium|high)['"]/

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        if (name === 'node_modules' || name === 'dist') continue
        walk(full, out)
      } else if (/\.tsx?$/.test(name) && !name.endsWith('.test.ts') && !name.endsWith('.test.tsx')) {
        out.push(full)
      }
    }
    return out
  }

  it('全仓扫不到 quality 的字面量兜底', () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      const lines = readFileSync(file, 'utf-8').split('\n')
      lines.forEach((line, i) => {
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) return
        if (!/\bquality\b/i.test(line)) return
        if (PATTERN.test(line)) offenders.push(`${file.slice(SRC.length + 1)}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
