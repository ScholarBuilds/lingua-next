/* 循环预演的守卫测试。
 *
   预演的价值全在「它和运行时是同一套算式」。一旦两边分叉，预演就是一份好看的谎言：
   用户照着预演调好参数，跑出来是另一回事，而且没有任何报错。

   所以这里除了验预演本身，还**把运行时那行取用算式钉住**：
   第 n 轮取 `vars[(n-1) % vars.length]`。改了 canvasStore.roundPrompt 而没改这里，
   或者反过来，都会在这个文件里炸。 */

import { describe, expect, it } from 'vitest'

import { applyRoundVars, loopBatch, loopSchedule, previewRounds } from './canvasStore'

const loop = (over: Record<string, unknown> = {}) => ({
  count: 3,
  loop_start: 1,
  variable_prompts: ['红色', '蓝色', '绿色'],
  image_input: false,
  image_batch_size: 1,
  ...over,
})

describe('previewRounds · 轮次与取用', () => {
  it('一轮一行，条数等于轮数', () => {
    expect(previewRounds(loop()).map((r) => r.round)).toEqual([1, 2, 3])
  })

  it('第 n 轮取第 n 条提示词', () => {
    const rows = previewRounds(loop())
    expect(rows.map((r) => r.text)).toEqual(['红色', '蓝色', '绿色'])
    expect(rows.map((r) => r.fromIndex)).toEqual([1, 2, 3])
  })

  it('轮数多于提示词条数时循环取——和运行时同一行算式', () => {
    const rows = previewRounds(loop({ count: 5 }))
    expect(rows.map((r) => r.text)).toEqual(['红色', '蓝色', '绿色', '红色', '蓝色'])
    expect(rows.map((r) => r.fromIndex)).toEqual([1, 2, 3, 1, 2])
  })

  it('起始计数偏移《计数》，但不改取第几条', () => {
    const rows = previewRounds(loop({ loop_start: 5, variable_prompts: ['第《计数》张'] }))
    expect(rows.map((r) => r.round)).toEqual([5, 6, 7])
    expect(rows.map((r) => r.text)).toEqual(['第5张', '第6张', '第7张'])
    // 只有一条模板，永远取第 1 条
    expect(rows.every((r) => r.fromIndex === 1)).toBe(true)
  })
})

describe('loopSchedule · 蓝本的三条耦合规则', () => {
  it('没开逐张喂图时步长恒为 1，「每轮取几张」不影响《计数》的步进', () => {
    expect(loopBatch({ image_input: false, image_batch_size: 5 })).toBe(1)
    expect(loopBatch({ image_input: true, image_batch_size: 5 })).toBe(5)
    const s = loopSchedule({ count: 3, loop_start: 1, image_input: false, image_batch_size: 5 })
    expect(s.rounds.map((r) => r.index)).toEqual([1, 2, 3])
  })

  it('开了之后轮次编号按 batch 步进（蓝本 loopIndex = start + i×batch）', () => {
    const s = loopSchedule({ count: 4, loop_start: 1, image_input: true, image_batch_size: 3 })
    expect(s.rounds.map((r) => r.index)).toEqual([1, 4, 7, 10])
    expect(s.batch).toBe(3)
  })

  it('《总数》是末轮编号不是轮数——起始计数为 1 时两者相等，所以这条只在改了起始计数时显形', () => {
    expect(loopSchedule({ count: 3, loop_start: 1 }).end).toBe(3)
    expect(loopSchedule({ count: 3, loop_start: 5 }).end).toBe(7)
    expect(loopSchedule({ count: 4, loop_start: 1, image_input: true, image_batch_size: 3 }).end).toBe(10)
  })

  it('生成系列第 5~7 张时《进度》读作 5/7，而不是 1/3', () => {
    const rows = previewRounds(loop({ count: 3, loop_start: 5, variable_prompts: ['《进度》'] }))
    expect(rows.map((r) => r.text)).toEqual(['5/7', '6/7', '7/7'])
  })
})

describe('previewRounds · 占位符', () => {
  it('三个 token 都替换，且与 applyRoundVars 结果一致', () => {
    const rows = previewRounds(loop({ count: 4, variable_prompts: ['《计数》/《总数》 · 《进度》'] }))
    expect(rows[2].text).toBe('3/4 · 3/4')
    expect(rows[2].text).toBe(applyRoundVars('《计数》/《总数》 · 《进度》', 3, 4))
  })

  it('前缀（上游提示词 + 草稿）拼在轮次提示词之前，中间换行', () => {
    const rows = previewRounds(loop({ count: 1 }), { base: '夜色星空' })
    expect(rows[0].text).toBe('夜色星空\n红色')
  })

  it('前缀里的 token 也替换——草稿里写《计数》一样生效', () => {
    const rows = previewRounds(loop({ count: 2, variable_prompts: [] }), { base: '第《计数》张' })
    expect(rows.map((r) => r.text)).toEqual(['第1张', '第2张'])
  })

  it('空的轮次提示词被跳过，不会留下空行', () => {
    const rows = previewRounds(loop({ count: 2, variable_prompts: ['  ', '蓝色'] }), { base: 'X' })
    // 空白条被过滤，只剩「蓝色」一条，两轮都取它
    expect(rows.map((r) => r.text)).toEqual(['X\n蓝色', 'X\n蓝色'])
  })
})

describe('previewRounds · 逐张喂图', () => {
  it('没开逐张喂图时不给图槽', () => {
    expect(previewRounds(loop()).every((r) => r.imageSlots.length === 0)).toBe(true)
  })

  it('开了之后每轮往后取 batch 张', () => {
    const rows = previewRounds(loop({ count: 3, image_input: true, image_batch_size: 2 }), {
      upstreamImages: 6,
    })
    expect(rows.map((r) => r.imageSlots)).toEqual([[1, 2], [3, 4], [5, 6]])
  })

  it('取超了就是取不到，**不回绕**——绕回去会让最后几轮悄悄重复前面的图', () => {
    const rows = previewRounds(loop({ count: 3, image_input: true, image_batch_size: 2 }), {
      upstreamImages: 4,
    })
    expect(rows.map((r) => r.imageSlots)).toEqual([[1, 2], [3, 4], []])
  })

  it('一轮里只够取一半时给一半，不补齐也不清空', () => {
    const rows = previewRounds(loop({ count: 2, image_input: true, image_batch_size: 3 }), {
      upstreamImages: 4,
    })
    expect(rows.map((r) => r.imageSlots)).toEqual([[1, 2, 3], [4]])
  })

  it('起始计数也偏移取图位置', () => {
    const rows = previewRounds(loop({ count: 2, loop_start: 3, image_input: true }), {
      upstreamImages: 5,
    })
    expect(rows.map((r) => r.imageSlots)).toEqual([[3], [4]])
  })

  it('上游没有图时不编造图槽', () => {
    const rows = previewRounds(loop({ image_input: true }), { upstreamImages: 0 })
    expect(rows.every((r) => r.imageSlots.length === 0)).toBe(true)
  })
})

describe('previewRounds · 规模', () => {
  it('默认只演前 12 轮，跑 500 轮不会渲染 500 张卡片', () => {
    expect(previewRounds(loop({ count: 500 })).length).toBe(12)
  })

  it('limit 可调', () => {
    expect(previewRounds(loop({ count: 500 }), { limit: 3 }).length).toBe(3)
  })

  it('轮数小于 limit 时按轮数来', () => {
    expect(previewRounds(loop({ count: 2 })).length).toBe(2)
  })

  it('轮数为 0 或负数时至少演一轮，不会返回空数组让界面空掉', () => {
    expect(previewRounds(loop({ count: 0 })).length).toBe(1)
    expect(previewRounds(loop({ count: -5 })).length).toBe(1)
  })
})
