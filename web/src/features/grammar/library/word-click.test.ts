/* 词切分 rehype 插件（word-click）。

   切在树上而不是 DOM 上的换法就是被一次白屏逼出来的（React 协调撞上被
   TreeWalker 替换的文本节点）；树变换是纯函数，这里把跳过规则钉死。 */

import { describe, expect, it } from 'vitest'

import type { HastChild, HastElement } from './word-click'
import { splitWords, transformTree, WORD_CLASS } from './word-click'

function el(tagName: string, children: HastChild[], className?: string[]): HastElement {
  return {
    type: 'element',
    tagName,
    properties: className === undefined ? {} : { className },
    children,
  }
}

const text = (value: string): HastChild => ({ type: 'text', value })

function wordSpans(node: HastChild): string[] {
  const out: string[] = []
  const walk = (n: HastChild) => {
    if (n.type === 'element') {
      const e = n as HastElement
      if (Array.isArray(e.properties?.className) && e.properties.className.includes(WORD_CLASS)) {
        out.push((e.children[0] as { value: string }).value)
      }
    }
    if ('children' in n && n.children !== undefined) n.children.forEach(walk)
  }
  walk(node)
  return out
}

describe('splitWords', () => {
  it('英文词切出 span，中文与标点原样保留', () => {
    const parts = splitWords('用 have + 过去分词，如 I have done.')
    expect(parts).not.toBeNull()
    const words = parts?.filter((p) => p.type === 'element').length
    expect(words).toBe(4) // have / I / have / done
    // 拼回去等于原文
    const joined = parts
      ?.map((p) =>
        p.type === 'text'
          ? (p as { value: string }).value
          : ((p as HastElement).children[0] as { value: string }).value,
      )
      .join('')
    expect(joined).toBe('用 have + 过去分词，如 I have done.')
  })

  it("撇号与连字符算词的一部分：don't / well-known", () => {
    const parts = splitWords("don't stop, it's well-known")
    const words = parts
      ?.filter((p): p is HastElement => p.type === 'element')
      .map((p) => (p.children[0] as { value: string }).value)
    expect(words).toEqual(["don't", 'stop', "it's", 'well-known'])
  })

  it('纯中文返回 null（不动原节点）', () => {
    expect(splitWords('完成时态的本质')).toBeNull()
  })
})

describe('transformTree', () => {
  it('普通段落里的词被包成可点 span', () => {
    const tree = el('p', [text('I have lost my keys.')])
    transformTree(tree)
    expect(wordSpans(tree)).toEqual(['I', 'have', 'lost', 'my', 'keys'])
  })

  it('代码块默认照切——讲义的例句大量住在 ```text 块里', () => {
    const tree = el('pre', [el('code', [text('There is a book')])])
    transformTree(tree)
    expect(wordSpans(tree)).toEqual(['There', 'is', 'a', 'book'])
  })

  it("scope='prose' 时代码块跳过", () => {
    const tree = el('pre', [el('code', [text('There is a book')])])
    transformTree(tree, 'prose')
    expect(wordSpans(tree)).toEqual([])
  })

  it('mermaid 源码任何档都不切——切了图就画不出来', () => {
    const tree = el('pre', [el('code', [text('flowchart TB')], ['language-mermaid'])])
    transformTree(tree)
    expect(wordSpans(tree)).toEqual([])
  })

  it('引用块（callout）里的英文照切', () => {
    const tree = el('blockquote', [el('p', [text('I have lost my keys')])])
    transformTree(tree)
    expect(wordSpans(tree)).toEqual(['I', 'have', 'lost', 'my', 'keys'])
  })

  it('svg（mermaid 图）里不切词', () => {
    const tree = el('div', [el('svg', [el('text', [text('Past Perfect')])])])
    transformTree(tree)
    expect(wordSpans(tree)).toEqual([])
  })

  it('glib-nowords 容器整棵跳过', () => {
    const tree = el('div', [el('div', [el('p', [text('skip these words')])], ['glib-nowords'])])
    transformTree(tree)
    expect(wordSpans(tree)).toEqual([])
  })

  it('嵌套元素（callout 里的粗体）照常切', () => {
    const tree = el('blockquote', [el('p', [el('strong', [text('five patterns')]), text(' matter')])])
    transformTree(tree)
    expect(wordSpans(tree)).toEqual(['five', 'patterns', 'matter'])
  })
})
