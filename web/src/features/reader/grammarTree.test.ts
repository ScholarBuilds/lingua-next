/* AI 语法分析成分树（grammarTree）。

   不变量只有一条：**渲染出来的就是原句本身，一字不多一字不少**。
   破了它用户就会看到同一句话重复两遍——线上真出过，17 条缓存里 11 条带嵌套。

   真实数据的回归在 grammarTree.real.test.ts，这里守构造出来的边界形态。 */

import { describe, expect, it } from 'vitest'

import { layoutComponents, sliceRange, topParts, walkRoles } from './grammarTree'

function render(sentence: string, comps: Array<{ text: string; role: string }>): string {
  const roots = layoutComponents(sentence, comps)
  const emit = (parts: ReturnType<typeof topParts>): string =>
    parts
      .map((p) =>
        p.node === null || p.node.children.length === 0
          ? p.text
          : emit(sliceRange(sentence, p.node.start, p.node.end, p.node.children)),
      )
      .join('')
  return emit(topParts(sentence, roots))
}

describe('layoutComponents', () => {
  it('平铺输入全是根节点', () => {
    const roots = layoutComponents('He rode a horse.', [
      { text: 'He', role: '主语' },
      { text: 'rode', role: '谓语' },
      { text: 'a horse', role: '宾语' },
    ])
    expect(roots.map((r) => r.role)).toEqual(['主语', '谓语', '宾语'])
    expect(roots.every((r) => r.children.length === 0)).toBe(true)
  })

  it('修饰语嵌在宾语里，按区间挂上去', () => {
    const roots = layoutComponents('He rode a black horse.', [
      { text: 'He', role: '主语' },
      { text: 'rode', role: '谓语' },
      { text: 'a black horse', role: '宾语' },
      { text: 'black', role: '定语' },
    ])
    expect(roots).toHaveLength(3)
    expect(roots[2].children.map((c) => c.role)).toEqual(['定语'])
  })

  it('子成分紧贴标点也能归位（第一版按词边界比对在这里失手）', () => {
    const roots = layoutComponents('that a man in possession of a fortune, must be in want of a wife', [
      { text: 'that a man in possession of a fortune, must be in want of a wife', role: '从句' },
      { text: 'in possession of a fortune', role: '后置定语' },
      { text: 'must be', role: '谓语' },
    ])
    expect(roots).toHaveLength(1)
    expect(roots[0].children.map((c) => c.role)).toEqual(['后置定语', '谓语'])
  })

  it('乱序追加的回指片段也能归位（第一版单调栈在这里失手）', () => {
    const roots = layoutComponents('they were at last obliged to accept it', [
      { text: 'they', role: '主语' },
      { text: 'were at last obliged', role: '系表结构' },
      { text: 'to accept it', role: '补足语' },
      { text: 'at last', role: '时间状语' }, // 乱序：父已经不在栈顶了
    ])
    expect(roots.map((r) => r.role)).toEqual(['主语', '系表结构', '补足语'])
    expect(roots[1].children.map((c) => c.role)).toEqual(['时间状语'])
  })

  it('句中重复出现的短词按位置区分，不会认错', () => {
    const s = 'a, b, and c; and they left'
    const roots = layoutComponents(s, [
      { text: 'a, b, and c', role: '并列宾语' },
      { text: 'and', role: '并列连词' }, // 应该是第二个 and（分句层那个）
      { text: 'they left', role: '并列分句' },
    ])
    expect(roots.map((r) => r.role)).toEqual(['并列宾语', '并列连词', '并列分句'])
    expect(roots[1].start).toBe(s.lastIndexOf('and'))
  })

  it('原句里找不到的成分直接丢弃，绝不凭空造字', () => {
    const roots = layoutComponents('He rode a horse.', [
      { text: 'He', role: '主语' },
      { text: 'flew a kite', role: '瞎编的' },
    ])
    expect(roots.map((r) => r.text)).toEqual(['He'])
  })

  it('空 text / undefined 输入不炸', () => {
    expect(layoutComponents('He rode.', [{ text: '  ', role: '主语' }])).toEqual([])
    expect(layoutComponents('He rode.', undefined)).toEqual([])
  })

  it('三层嵌套逐级挂上', () => {
    const roots = layoutComponents('the man in the red coat left', [
      { text: 'the man in the red coat', role: '主语' },
      { text: 'in the red coat', role: '后置定语' },
      { text: 'red', role: '定语' },
    ])
    expect(roots[0].children[0].children.map((c) => c.role)).toEqual(['定语'])
  })

  it('弯直引号不一致也能定位（模型父子两处写法常常不同）', () => {
    const roots = layoutComponents('I’m from Hangzhou', [
      { text: 'I’m from Hangzhou', role: '分句' },
      { text: "I'm", role: '主系' }, // 直引号
    ])
    expect(roots[0].children.map((c) => c.text)).toEqual(['I’m'])
  })
})

describe('sliceRange / topParts', () => {
  it('缝隙（标点、连接词）原样保留', () => {
    const s = 'He rode a black horse.'
    const roots = layoutComponents(s, [
      { text: 'a black horse', role: '宾语' },
      { text: 'black', role: '定语' },
    ])
    expect(topParts(s, roots).map((p) => p.text)).toEqual(['He rode ', 'a black horse', '.'])
    const inner = sliceRange(s, roots[0].start, roots[0].end, roots[0].children)
    expect(inner.map((p) => p.text)).toEqual(['a ', 'black', ' horse'])
    expect(inner[1].node?.role).toBe('定语')
  })
})

describe('不变量：渲染文字逐字符等于原句', () => {
  it.each([
    ['I’m from Hangzhou, and I live in Shanghai now.', [
      { text: 'I’m from Hangzhou', role: '并列分句1' },
      { text: 'I’m', role: '主语 + 系动词' },
      { text: 'from Hangzhou', role: '表语' },
      { text: 'and', role: '并列连词' },
      { text: 'I live in Shanghai now', role: '并列分句2' },
      { text: 'I', role: '主语' },
      { text: 'live', role: '谓语' },
      { text: 'in Shanghai', role: '地点状语' },
      { text: 'now', role: '时间状语' },
    ]],
    ['He rode a black horse.', [
      { text: 'He', role: '主语' },
      { text: 'rode', role: '谓语' },
      { text: 'a black horse', role: '宾语' },
      { text: 'black', role: '定语' },
    ]],
    ['Mr. Bennet made no answer.', [
      { text: 'Mr. Bennet', role: '主语' },
      { text: 'made', role: '谓语' },
      { text: 'no answer', role: '宾语' },
    ]],
  ] as const)('%s', (sentence, comps) => {
    expect(render(sentence, [...comps])).toBe(sentence)
  })
})

describe('walkRoles', () => {
  it('先序摊平，父在子前', () => {
    const roots = layoutComponents('a black horse', [
      { text: 'a black horse', role: '宾语' },
      { text: 'black', role: '定语' },
    ])
    expect(walkRoles(roots).map((n) => n.role)).toEqual(['宾语', '定语'])
  })
})
