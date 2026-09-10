/* 批注锚定（annotate）。

   锚点错了不会报错，只会把高亮标在别的句子上——比不标更坏，
   因为读者会以为自己当时批的就是这里。三档定位逐个钉死。 */

import { describe, expect, it } from 'vitest'

import type { AnnotationMark, HastChild } from './annotate'
import { flattenText, locateQuote, rehypeAnnotations } from './annotate'

const el = (tagName: string, children: HastChild[]): HastChild => ({
  type: 'element',
  tagName,
  properties: {},
  children,
})
const text = (value: string): HastChild => ({ type: 'text', value })

describe('locateQuote', () => {
  const body = 'There is a book. I have lost my keys. There is a book on the desk.'

  it('前后文精确命中，能分辨重复出现的哪一处', () => {
    const at = locateQuote(body, {
      quote: 'There is a book',
      prefix: 'my keys. ',
      suffix: ' on the desk',
      startHint: 0,
    })
    expect(at).toEqual({ start: 38, end: 53 })
  })

  it('前后文对不上时退到引文，取离原偏移最近的一处', () => {
    const at = locateQuote(body, {
      quote: 'There is a book',
      prefix: '不存在的前文',
      suffix: '不存在的后文',
      startHint: 40,
    })
    expect(at?.start).toBe(38)
  })

  it('原偏移在前面时选前面那一处', () => {
    const at = locateQuote(body, { quote: 'There is a book', prefix: '', suffix: '', startHint: 2 })
    expect(at?.start).toBe(0)
  })

  it('引文彻底找不到就认输（宁可不标，不能标错）', () => {
    expect(locateQuote(body, { quote: '这句原文已经被改掉了', prefix: '', suffix: '', startHint: 0 }))
      .toBeNull()
  })

  it('空引文不定位', () => {
    expect(locateQuote(body, { quote: '', prefix: '', suffix: '', startHint: 0 })).toBeNull()
  })
})

describe('flattenText', () => {
  it('按文档顺序摊平，偏移连续', () => {
    const tree = el('div', [el('p', [text('abc'), el('b', [text('de')]), text('f')])])
    const { text: full, pieces } = flattenText(tree)
    expect(full).toBe('abcdef')
    expect(pieces.map((p) => p.start)).toEqual([0, 3, 5])
  })

  it('svg 里的文字不算正文——算进去整篇偏移会全体错开', () => {
    const tree = el('div', [el('svg', [text('图里的字')]), el('p', [text('正文')])])
    expect(flattenText(tree).text).toBe('正文')
  })
})

function marks(node: HastChild): { text: string; id: string }[] {
  const out: { text: string; id: string }[] = []
  const walk = (n: HastChild) => {
    if (n.type === 'element' && (n as { tagName: string }).tagName === 'mark') {
      const e = n as { properties?: Record<string, unknown>; children: HastChild[] }
      out.push({
        text: (e.children[0] as { value: string }).value,
        id: String(e.properties?.['data-ann']),
      })
      return
    }
    if ('children' in n && n.children !== undefined) n.children.forEach(walk)
  }
  walk(node)
  return out
}

const ann = (id: number, quote: string, extra: Partial<AnnotationMark> = {}): AnnotationMark => ({
  id,
  quote,
  prefix: '',
  suffix: '',
  startHint: 0,
  color: 'yellow',
  ...extra,
})

describe('rehypeAnnotations', () => {
  it('把引文包成 mark，前后文本原样保留', () => {
    const tree = el('p', [text('I have lost my keys today.')])
    rehypeAnnotations([ann(7, 'lost my keys')])(tree)
    expect(marks(tree)).toEqual([{ text: 'lost my keys', id: '7' }])
    expect(flattenText(tree).text).toBe('I have lost my keys today.')
  })

  it('跨行内元素的引文分段标注，文字一个不丢', () => {
    const tree = el('p', [text('have '), el('b', [text('lost')]), text(' my keys')])
    rehypeAnnotations([ann(1, 'lost my')])(tree)
    expect(marks(tree).map((m) => m.text)).toEqual(['lost', ' my'])
    expect(flattenText(tree).text).toBe('have lost my keys')
  })

  it('多条批注互不干扰', () => {
    const tree = el('p', [text('There is a book and there is a pen.')])
    rehypeAnnotations([ann(1, 'a book'), ann(2, 'a pen')])(tree)
    expect(marks(tree).map((m) => m.id).sort()).toEqual(['1', '2'])
    expect(flattenText(tree).text).toBe('There is a book and there is a pen.')
  })

  it('锚不上的批注被跳过，正文不变', () => {
    const tree = el('p', [text('原文已经改了')])
    rehypeAnnotations([ann(9, '这段不存在')])(tree)
    expect(marks(tree)).toEqual([])
    expect(flattenText(tree).text).toBe('原文已经改了')
  })

  it('空列表不动树', () => {
    const tree = el('p', [text('abc')])
    rehypeAnnotations([])(tree)
    expect(marks(tree)).toEqual([])
  })
})
