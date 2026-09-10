/* 提示词列表项的边界归一与「完整」的定义。

   两处都是「不报错但结果是错的」：
   - 服务端新加的 category / hidden 三个字段，缓存里的旧条目没有；判据写成 `!== false`
     之类的话，一条普通条目会被当成「已隐藏」而从列表里消失。
   - 「完整」= 正文 + 分隔行 + 负向。套用浮层与提示词库各拼一遍的话，用户在库里复制走的
     那段和插进提示词框的那段会长得不一样。 */

import { describe, expect, it } from 'vitest'

import type { PromptItem } from '../../lib/api-studio'
import { fullPromptText, normalizePrompt } from './PromptPicker'

const RAW = {
  id: -1,
  group_id: null,
  title: '多机位九宫格',
  body: 'a 3x3 grid of {{主体}}',
  negative: 'numbers, text, watermark',
  scene: '同一主体的 9 个机位',
  source: 'Infinite-Canvas',
  source_ref: 'static/system-prompts/infinite-canvas-prompt-templates.md@v2.1',
  builtin: true,
  hidden: true,
  category: 'view',
  category_name: '视角',
  category_sort: 0,
  favorite: false,
  used_count: 0,
  variables: [{ name: '主体', label: '主体', description: '拍谁', default: '', required: true }],
  version: null,
  updated_at: null,
} as unknown as PromptItem

describe('列表项归一', () => {
  it('照抄服务端给的分类与隐藏状态', () => {
    const item = normalizePrompt(RAW)
    expect(item.category).toBe('view')
    expect(item.category_name).toBe('视角')
    expect(item.category_sort).toBe(0)
    expect(item.hidden).toBe(true)
  })

  it('字段缺失时按「没隐藏、没分类」算', () => {
    // 旧缓存里整个键都没有。默认站在「照常显示」那一边：
    // 判反了的话，一条普通条目会凭空从列表里消失，而用户什么都没做
    const item = normalizePrompt({ id: 3, title: 'x', body: 'y' } as unknown as PromptItem)
    expect(item.hidden).toBe(false)
    expect(item.category).toBeNull()
    expect(item.category_name).toBe('')
    // 认不出分类的沉底，不抢在「视角」前面
    expect(item.category_sort).toBe(99)
  })

  it('空字符串的分类当没有分类', () => {
    const item = normalizePrompt({ ...RAW, category: '' } as unknown as PromptItem)
    expect(item.category).toBeNull()
  })
})

describe('完整提示词', () => {
  it('正文之后另起一行写明分隔，再接负向', () => {
    const text = fullPromptText('a cat', 'blurry, watermark')
    expect(text.startsWith('a cat\n\n')).toBe(true)
    expect(text).toContain('负向提示词')
    expect(text.endsWith('blurry, watermark')).toBe(true)
  })

  it('没写负向就等于只有正文', () => {
    expect(fullPromptText('a cat', '')).toBe('a cat')
    expect(fullPromptText('a cat', '   \n ')).toBe('a cat')
  })
})
