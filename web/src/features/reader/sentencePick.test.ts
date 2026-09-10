/* 切句（sentencePick）。

   切错了不报错，只是把一句话拆成残句喂给语法分析——讲出来的结构不知所云，
   而用户以为是模型不行。缩写与小数点这两类必须钉死。 */

import { describe, expect, it } from 'vitest'

import { sentenceSel, splitSentences } from './sentencePick'

describe('splitSentences', () => {
  it('按句末标点切，且要后跟大写才算', () => {
    expect(splitSentences("That's great. I'm a student too. My classmate Tom is here.")).toEqual([
      "That's great.",
      "I'm a student too.",
      'My classmate Tom is here.',
    ])
  })

  it('问号与感叹号同样是句末', () => {
    expect(splitSentences('Really? That is amazing! Let us go.')).toEqual([
      'Really?',
      'That is amazing!',
      'Let us go.',
    ])
  })

  it('缩写里的句点不切（Mr. / Dr. / etc.）', () => {
    expect(splitSentences('Mr. Smith is here.')).toEqual(['Mr. Smith is here.'])
    expect(splitSentences('Ask Dr. Lee about it.')).toEqual(['Ask Dr. Lee about it.'])
  })

  it('小数点不切', () => {
    expect(splitSentences('It costs 3.5 dollars today.')).toEqual([
      'It costs 3.5 dollars today.',
    ])
  })

  it('句点后跟小写不切——那多半是缩写或省略', () => {
    expect(splitSentences('He works at acme. inc and likes it.')).toEqual([
      'He works at acme. inc and likes it.',
    ])
  })

  it('引号收在句内，不单独成段', () => {
    expect(splitSentences('She said "hello." Then she left.')).toEqual([
      'She said "hello."',
      'Then she left.',
    ])
  })

  it('单句原样返回', () => {
    expect(splitSentences('I like reading.')).toEqual(['I like reading.'])
  })

  it('空文本返回空数组', () => {
    expect(splitSentences('   ')).toEqual([])
  })

  it('没有句末标点的整段算一句', () => {
    expect(splitSentences('just a fragment without punctuation')).toEqual([
      'just a fragment without punctuation',
    ])
  })

  it('切完拼回去不丢词', () => {
    const text = "That's great. I'm a student too, but I study at a school near my home."
    const joined = splitSentences(text).join(' ')
    expect(joined.replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' '))
  })
})

describe('sentenceSel', () => {
  it('同文本同哈希——缓存才命中得上', () => {
    expect(sentenceSel('I like it.').hash).toBe(sentenceSel('I like it.').hash)
  })

  it('不同文本不同哈希', () => {
    expect(sentenceSel('I like it.').hash).not.toBe(sentenceSel('I hate it.').hash)
  })

  it('原文原样带上，面板要拿它去分析', () => {
    expect(sentenceSel('I like it.').text).toBe('I like it.')
  })
})
