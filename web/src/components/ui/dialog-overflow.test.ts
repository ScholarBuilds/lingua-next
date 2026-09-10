/* 弹窗与外壳的高度上限守卫。

   起因：`DialogContent` / `AlertDialogContent` 的基础类里一直没有 max-height。
   它们是 `fixed` + `translate-y-[-50%]` 自居中的，内容一长就往上下两头顶出视口，
   **顶出去的部分滚不回来**——页面滚动条动不了 fixed 元素，用户看不到底部按钮。
   全仓 19 个调用点只有 3 个自己写了 max-h，其余全靠基础类兜。
   这条一旦被谁「清理」掉，界面不会报错，只会在长内容时悄悄不可用，所以拿单测钉住。 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { cn } from '@/lib/utils'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

/** 取组件里那一长串基础类（`cn(` 后面第一个字符串字面量）。 */
function baseClassesOf(source: string, slot: string): string {
  const at = source.indexOf(`data-slot="${slot}"`)
  expect(at, `找不到 data-slot="${slot}"`).toBeGreaterThan(-1)
  const literal = /"((?:[^"\\]|\\.)*)"/.exec(source.slice(source.indexOf('cn(', at)))
  expect(literal, `${slot} 的 cn() 里没有基础类字符串`).not.toBeNull()
  return literal![1]
}

describe('弹窗高度上限', () => {
  const dialog = read('./dialog.tsx')
  const alert = read('./alert-dialog.tsx')

  it.each([
    ['dialog-content', () => baseClassesOf(dialog, 'dialog-content')],
    ['alert-dialog-content', () => baseClassesOf(alert, 'alert-dialog-content')],
  ])('%s 基础类自带 max-h 与 overflow-y-auto', (_slot, get) => {
    const base = get()
    expect(base).toMatch(/\bmax-h-\[/)
    expect(base).toContain('overflow-y-auto')
  })

  it('上限用 dvh，不用 vh（窄屏地址栏会吃掉 vh 那一截）', () => {
    for (const base of [
      baseClassesOf(dialog, 'dialog-content'),
      baseClassesOf(alert, 'alert-dialog-content'),
    ]) {
      const maxH = /max-h-\[([^\]]+)\]/.exec(base)![1]
      expect(maxH).toContain('dvh')
    }
  })

  it('调用点写自己的 max-h 时照样赢（cn 是 twMerge，不是字符串拼接）', () => {
    // 设置页那几个弹窗写的是 max-h-[86vh]，基础类不能把它挤掉
    const merged = cn(baseClassesOf(dialog, 'dialog-content'), 'max-h-[86vh]')
    expect(merged).toContain('max-h-[86vh]')
    expect(merged).not.toContain('100dvh')
  })
})

describe('应用外壳高度', () => {
  const tokens = read('../../styles/tokens.css')
  const appRule = /^\.app\s*\{[^}]*\}/m.exec(tokens)?.[0] ?? ''

  it('.app 用 100dvh，并保留 100vh 兜底', () => {
    expect(appRule, '找不到 .app 规则').not.toBe('')
    expect(appRule).toContain('height: 100dvh')
    // 兜底那行必须在 dvh 之前，否则老浏览器拿不到值、新浏览器又被盖回去
    expect(appRule.indexOf('height: 100vh')).toBeLessThan(appRule.indexOf('height: 100dvh'))
  })

  it('.app 仍然是 overflow:hidden 的定高外壳（页面自己开滚动条的前提）', () => {
    expect(appRule).toContain('overflow: hidden')
  })
})
