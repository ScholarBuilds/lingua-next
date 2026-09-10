/* 列表项那一行说明。

   起因是列表里挑不出东西：两条「人像」模板的正文开头都是
   `a cinematic portrait of …, shot on 85mm, shallow depth of field`，
   卡片上截三行看到的几乎一模一样。摘要按分句切而不是按字数硬截，
   就是为了别把 `85mm, shallow depth of` 这种半截短语摆到列表上。 */

import { describe, expect, it } from 'vitest'

import { promptDigest, promptStats, promptSummary } from './prompt-digest'

describe('篇幅', () => {
  it('词数按空白切，字符数照实数', () => {
    const stats = promptStats('a photo of a cat')
    expect(stats.words).toBe(5)
    expect(stats.chars).toBe(16)
    expect(stats.lines).toBe(1)
  })

  it('换行与连续空白不会把词数灌水', () => {
    expect(promptStats('a   photo\n\nof  a cat').words).toBe(5)
    expect(promptStats('a\nb\nc').lines).toBe(3)
  })

  it('空串是 0 词不是 1 词', () => {
    // 直接 split(/\s+/) 会给出 ['']，长度 1——列表上就成了「0 字符 · 1 词」
    expect(promptStats('').words).toBe(0)
    expect(promptStats('   ').words).toBe(0)
  })
})

describe('正文摘要', () => {
  it('按分句攒，不在词中间切断', () => {
    const text = promptSummary(
      'a cinematic portrait of a woman, shot on 85mm, shallow depth of field, golden hour light',
      50,
    )
    expect(text.endsWith('…')).toBe(true)
    // 攒到放不下的那一句就停，不会留下半截短语
    expect(text).not.toMatch(/shallow depth of$/)
    expect(text.replace('…', '').split(', ').every((part) => part.trim() !== '')).toBe(true)
  })

  it('攒得下就不加省略号', () => {
    expect(promptSummary('a cat, soft light', 60)).toBe('a cat, soft light')
  })

  it('单句就超长时硬截兜底', () => {
    // 这种正文本来就没有可读的切点，给个带省略号的开头比什么都不显示强
    const text = promptSummary('x'.repeat(200), 30)
    expect(text).toHaveLength(31)
    expect(text.endsWith('…')).toBe(true)
  })

  it('换行与中文标点也算分句', () => {
    expect(promptSummary('第一段。第二段。', 40)).toBe('第一段, 第二段')
    expect(promptSummary('a cat\nsoft light', 40)).toBe('a cat, soft light')
  })

  it('占位原样留着', () => {
    // `{{主体}}` 恰恰是这条模板要人填什么的最强信号，摘要里不该被抹掉
    expect(promptSummary('a photo of {{主体}}, soft light', 40)).toContain('{{主体}}')
  })

  it('空正文给空串，不给省略号', () => {
    expect(promptSummary('')).toBe('')
    expect(promptSummary('  \n ')).toBe('')
  })
})

describe('列表显示哪一行', () => {
  it('写过「适用场景」就用它', () => {
    const digest = promptDigest({ scene: '电商主图要的干净白底', body: 'a product on white' })
    expect(digest).toEqual({ text: '电商主图要的干净白底', fromScene: true })
  })

  it('没写场景才摘正文，并且标明这是摘的', () => {
    // 不标的话用户会以为自己给这条写过用途说明
    const digest = promptDigest({ scene: '', body: 'a product on white, soft shadow' })
    expect(digest.fromScene).toBe(false)
    expect(digest.text).toBe('a product on white, soft shadow')
  })

  it('场景只有空白等于没写', () => {
    expect(promptDigest({ scene: '   ', body: 'a cat' }).fromScene).toBe(false)
  })
})
