/* 用**线上真实缓存**跑成分树，守住唯一那条不变量：渲染出来的就是原句，一字不多一字不少。

   构造用例只能覆盖我想得到的形态；这 6 条是模型在真实句子上实际吐出来的，
   里面有构造用例想不到的东西——紧贴逗号的子成分、乱序追加的回指片段、
   句中重复出现的 `and`。fixture 从 analysis_result（kind='grammar'）导出，
   原句按 content_hash 关联 sentence + paragraph 还原。

   第一版按字符串包含关系判父子，就是被这批数据打穿的（id 1096 重复了三处）。 */

import { describe, expect, it } from 'vitest'

import fixture from './__fixtures__/grammar-cache.json'
import { layoutComponents, sliceRange, topParts, walkRoles } from './grammarTree'

interface Row {
  id: number
  sentence: string
  components: Array<{ text: string; role: string }>
}

const rows = fixture as Row[]

/** 按渲染顺序把整棵树铺成文字，与页面上看到的一致 */
function render(sentence: string, roots: ReturnType<typeof layoutComponents>): string {
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

describe('真实缓存回归', () => {
  it('fixture 不是空的（导出脚本坏了要能发现）', () => {
    expect(rows.length).toBeGreaterThanOrEqual(6)
    expect(rows.every((r) => r.sentence !== '' && r.components.length > 0)).toBe(true)
  })

  it.each(rows.map((r) => [r.id, r] as const))(
    'id %i：渲染出来逐字符等于原句',
    (_id, row) => {
      const roots = layoutComponents(row.sentence, row.components)
      expect(render(row.sentence, roots)).toBe(row.sentence)
    },
  )

  it.each(rows.map((r) => [r.id, r] as const))('id %i：区间不重叠、不越界', (_id, row) => {
    const roots = layoutComponents(row.sentence, row.components)
    const check = (nodes: ReturnType<typeof layoutComponents>, lo: number, hi: number): void => {
      let prev = lo
      for (const n of nodes) {
        expect(n.start).toBeGreaterThanOrEqual(prev)
        expect(n.end).toBeLessThanOrEqual(hi)
        expect(n.text).toBe(row.sentence.slice(n.start, n.end))
        check(n.children, n.start, n.end)
        prev = n.end
      }
    }
    check(roots, 0, row.sentence.length)
  })

  it('id 12675（截图那条）：并列句还原成两个分句，各带内部成分', () => {
    const row = rows.find((r) => r.id === 12675)
    expect(row).toBeDefined()
    const roots = layoutComponents(row!.sentence, row!.components)
    expect(roots.map((r) => r.role)).toEqual(['并列分句1', '并列连词', '并列分句2'])
    expect(roots[0].children.map((c) => c.text)).toEqual(['I’m', 'from Hangzhou'])
    expect(roots[2].children.map((c) => c.role)).toEqual(['主语', '谓语', '地点状语', '时间状语'])
    // 原先重复的两个地名，现在各只出现一次
    const out = render(row!.sentence, roots)
    expect(out.match(/Hangzhou/g)).toHaveLength(1)
    expect(out.match(/Shanghai/g)).toHaveLength(1)
  })

  it('id 1096（乱序 + 重复 and 那条）：每个成分只出现一次', () => {
    const row = rows.find((r) => r.id === 1096)
    expect(row).toBeDefined()
    const roots = layoutComponents(row!.sentence, row!.components)
    const all = walkRoles(roots)
    const spans = all.map((n) => `${n.start}-${n.end}`)
    expect(new Set(spans).size).toBe(spans.length) // 同一区间不会被两个成分占住
    expect(render(row!.sentence, roots)).toBe(row!.sentence)
  })
})
