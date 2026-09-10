/* 旧主题键的迁移映射。

   这条判据坏掉时不会报错，只会让「在学习端选了浅色」的用户进后台看到深色——
   而他从没选过「跟随系统」。前台（learner-web/AppShell）与学习端（LearningShell）
   写进 `ln-theme` 的字面量就是 'light' / 'dark'，这里必须原样认得。 */

import { describe, expect, it } from 'vitest'

import { themeFromLegacy } from './theme-legacy'

describe('themeFromLegacy', () => {
  it('认得学习端与前台真正写进去的两个值', () => {
    // 两处都是 setItem('ln-theme', dark ? 'dark' : 'light')
    expect(themeFromLegacy('light')).toBe('light')
    expect(themeFromLegacy('dark')).toBe('dark')
  })

  it('没存过就跟随系统', () => {
    expect(themeFromLegacy(null)).toBe('system')
  })

  it('空串与无法识别的值都落到跟随系统', () => {
    // 旧键表达不了「跟随系统」，认不出的一律回默认，别猜
    expect(themeFromLegacy('')).toBe('system')
    expect(themeFromLegacy('auto')).toBe('system')
    expect(themeFromLegacy('Dark')).toBe('system')
  })
})
