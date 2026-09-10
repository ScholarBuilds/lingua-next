/* 提示词面板的纯逻辑：宽度钳制与记忆、筛选排序、套用前的关口、草稿形状。

   这几样都是「不报错但结果是错的」那一类：
   - 宽度钳制写松了，面板能把画布和输入框一起盖掉——那就退回成居中弹窗了，
     而界面上看不出任何异常。
   - 隐藏的内置模板默认漏进列表，「隐藏」这个动作就没有可观察的效果。
   - `needsFill` 判漏，带 `{{占位}}` 的正文原样发给模型，模型不报错，
     只会照着乱出图。这是整条链路上唯一真正会出事的失败模式。 */

import { describe, expect, it } from 'vitest'

import type { PromptVariable } from '../../lib/api-studio'
import {
  CANVAS_KEEP_W,
  PANEL_DEFAULT_W,
  PANEL_MAX_W,
  PANEL_MIN_W,
  PANEL_QUERY_DEFAULTS,
  PANEL_WIDTH_KEY,
  blankDraft,
  clampPanelWidth,
  editDraft,
  filterPrompts,
  loadPanelWidth,
  needsFill,
  savePanelWidth,
  scopeCounts,
} from './prompt-panel'
import type { PanelQuery, PromptEntryLike } from './prompt-panel'

/** 假的 localStorage。真的那个在 node 环境里不存在 */
function fakeStore(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed))
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  }
}

function entry(over: Partial<PromptEntryLike> & { id: number }): PromptEntryLike {
  return {
    title: '',
    scene: '',
    body: '',
    negative: '',
    group_id: null,
    builtin: false,
    hidden: false,
    favorite: false,
    used_count: 0,
    category: null,
    category_name: '',
    category_sort: 99,
    updated_at: null,
    variables: [],
    ...over,
  }
}

const VAR: PromptVariable = {
  name: '主体',
  label: '主体',
  description: '拍谁',
  default: '',
  required: true,
}

describe('面板宽度', () => {
  it('给画布留够地方：上限跟着视口走，不是一个常量', () => {
    // 1280 的窗口拖到头也只能到 760，还剩 520 给画布
    expect(clampPanelWidth(9999, 1280)).toBe(PANEL_MAX_W)
    // 900 的窗口只剩 900-480=420 可给，再拖也停在这
    expect(clampPanelWidth(9999, 900)).toBe(900 - CANVAS_KEEP_W)
    // 拖到的宽度必须让画布至少剩 CANVAS_KEEP_W，否则右侧面板就退化成居中弹窗了
    expect(clampPanelWidth(9999, 1100) + CANVAS_KEEP_W).toBeLessThanOrEqual(1100)
  })

  it('视口窄到放不下时以最小宽为准，不返回负数', () => {
    expect(clampPanelWidth(500, 600)).toBe(PANEL_MIN_W)
    expect(clampPanelWidth(100, 360)).toBe(PANEL_MIN_W)
  })

  it('往下不小于最小宽', () => {
    expect(clampPanelWidth(10, 1440)).toBe(PANEL_MIN_W)
  })

  it('NaN 之类的脏值回落到默认宽', () => {
    expect(clampPanelWidth(Number.NaN, 1440)).toBe(PANEL_DEFAULT_W)
  })

  it('记得住上次的宽度', () => {
    const store = fakeStore()
    savePanelWidth(612, store)
    expect(store.data.get(PANEL_WIDTH_KEY)).toBe('612')
    expect(loadPanelWidth(1440, store)).toBe(612)
  })

  it('上次在大屏拖到的宽度，换小窗口打开时收回来', () => {
    const store = fakeStore({ [PANEL_WIDTH_KEY]: '760' })
    // 2560 外接屏上拖到 760，今天在 900 宽的窗口里打开
    expect(loadPanelWidth(900, store)).toBe(900 - CANVAS_KEEP_W)
  })

  it('没存过 / 存的是脏数据都回落到默认宽，不抛', () => {
    expect(loadPanelWidth(1440, fakeStore())).toBe(PANEL_DEFAULT_W)
    expect(loadPanelWidth(1440, fakeStore({ [PANEL_WIDTH_KEY]: '  ' }))).toBe(PANEL_DEFAULT_W)
    expect(loadPanelWidth(1440, fakeStore({ [PANEL_WIDTH_KEY]: 'abc' }))).toBe(PANEL_DEFAULT_W)
  })

  it('拿不到存储（node / 无痕模式）时也给得出宽度', () => {
    // 不传 storage，node 里没有全局 localStorage，走的是回落分支
    expect(loadPanelWidth(1440)).toBe(PANEL_DEFAULT_W)
    expect(() => savePanelWidth(500)).not.toThrow()
  })
})

describe('筛选与排序', () => {
  const MINE = entry({
    id: 1,
    title: '写实产品图',
    scene: '白底电商图',
    body: 'studio product shot',
    used_count: 3,
    updated_at: '2026-08-20T10:00:00Z',
  })
  const FAV = entry({
    id: 2,
    title: '黄昏街拍',
    body: 'golden hour street portrait',
    favorite: true,
    used_count: 1,
    updated_at: '2026-08-01T10:00:00Z',
  })
  const BUILTIN = entry({
    id: -1,
    title: '多机位九宫格',
    body: 'a 3x3 grid',
    builtin: true,
    category: 'view',
    category_name: '视角',
    category_sort: 0,
    used_count: 9,
  })
  const HIDDEN = entry({
    id: -2,
    title: '被收起来的模板',
    body: 'hidden template',
    builtin: true,
    hidden: true,
    category: 'view',
    category_name: '视角',
    category_sort: 0,
  })
  const GROUPED = entry({ id: 3, title: '分组里的一条', body: 'grouped', group_id: 7 })
  const ALL = [MINE, FAV, BUILTIN, HIDDEN, GROUPED]

  const q = (over: Partial<PanelQuery> = {}): PanelQuery => ({ ...PANEL_QUERY_DEFAULTS, ...over })

  it('隐藏的内置模板默认不出现', () => {
    const ids = filterPrompts(ALL, q()).map((it) => it.id)
    expect(ids).not.toContain(-2)
  })

  it('开了「含已隐藏」才列出来——那是恢复它们的唯一入口', () => {
    const ids = filterPrompts(ALL, q({ showHidden: true })).map((it) => it.id)
    expect(ids).toContain(-2)
  })

  it('四个档各管各的那一批', () => {
    expect(filterPrompts(ALL, q({ scope: 'system' })).map((it) => it.id)).toEqual([-1])
    expect(filterPrompts(ALL, q({ scope: 'mine' })).map((it) => it.id).sort()).toEqual([1, 2, 3])
    expect(filterPrompts(ALL, q({ scope: 'favorite' })).map((it) => it.id)).toEqual([2])
  })

  it('分类只筛内置、分组只筛自建，互不覆盖', () => {
    // 切到一个自建分组，内置模板不该被一起筛掉
    const byGroup = filterPrompts(ALL, q({ group: 7 })).map((it) => it.id)
    expect(byGroup).toContain(3)
    expect(byGroup).toContain(-1)
    expect(byGroup).not.toContain(1)

    // 反过来，切到一个内置分类，自建条目照常在
    const byCat = filterPrompts(ALL, q({ category: 'view' })).map((it) => it.id)
    expect(byCat).toContain(-1)
    expect(byCat).toContain(1)
  })

  it('未归组这一档只认自建里 group_id 为空的', () => {
    const ids = filterPrompts(ALL, q({ scope: 'mine', group: 'none' })).map((it) => it.id)
    expect(ids.sort()).toEqual([1, 2])
  })

  it('搜索扫标题、场景、正文、负向与分类名', () => {
    expect(filterPrompts(ALL, q({ text: '白底' })).map((it) => it.id)).toEqual([1])
    expect(filterPrompts(ALL, q({ text: 'golden' })).map((it) => it.id)).toEqual([2])
    expect(filterPrompts(ALL, q({ text: '视角' })).map((it) => it.id)).toEqual([-1])
    // 大小写不该影响命中：提示词正文绝大多数是英文
    expect(filterPrompts(ALL, q({ text: 'GOLDEN' })).map((it) => it.id)).toEqual([2])
  })

  it('默认排序把收藏顶到最前，其次最常用', () => {
    const ids = filterPrompts(ALL, q()).map((it) => it.id)
    expect(ids[0]).toBe(2)
    // 收藏之后按套用次数：内置那条 9 次排在自建的 3 次前面
    expect(ids[1]).toBe(-1)
  })

  it('切到「套用最多」就纯看次数，收藏不再插队', () => {
    const ids = filterPrompts(ALL, q({ sort: 'used' })).map((it) => it.id)
    expect(ids[0]).toBe(-1)
  })

  it('切到「最近更新」按 updated_at 倒序，没时间戳的内置模板沉到有时间戳的下面', () => {
    const ids = filterPrompts(ALL, q({ sort: 'updated' })).map((it) => it.id)
    expect(ids.slice(0, 2)).toEqual([1, 2])
    // 内置模板没有 updated_at，排在两条改过的自建条目之后
    expect(ids.indexOf(-1)).toBeGreaterThan(ids.indexOf(2))
  })

  it('档位计数与列表同源，标签上的数字和点进去的条数对得上', () => {
    const counts = scopeCounts(ALL, false)
    expect(counts.all).toBe(filterPrompts(ALL, q()).length)
    expect(counts.system).toBe(filterPrompts(ALL, q({ scope: 'system' })).length)
    expect(counts.mine).toBe(filterPrompts(ALL, q({ scope: 'mine' })).length)
    expect(counts.favorite).toBe(filterPrompts(ALL, q({ scope: 'favorite' })).length)
    // 默认不含隐藏，所以隐藏那条不进任何一个数
    expect(counts.system).toBe(1)
  })
})

describe('套用前的关口', () => {
  it('声明了变量的必须先填', () => {
    expect(needsFill(entry({ id: 1, body: 'a photo of {{主体}}', variables: [VAR] }))).toBe(true)
  })

  it('声明为空但正文里还有占位的也要填', () => {
    // 缓存里的旧条目、手改过的库都会出现这种情况；只看 variables 一个信号不够
    expect(needsFill(entry({ id: 1, body: 'a photo of {{主体}}' }))).toBe(true)
  })

  it('占位在负向里同样拦下', () => {
    expect(needsFill(entry({ id: 1, body: 'ok', negative: 'no {{avoid}}' }))).toBe(true)
  })

  it('没有占位的直接放行，不多问一步', () => {
    expect(needsFill(entry({ id: 1, body: 'a plain prompt', negative: 'blurry' }))).toBe(false)
  })
})

describe('编辑器草稿', () => {
  it('新建时 id 为 null——这一步不写任何接口', () => {
    const draft = blankDraft('all', false)
    expect(draft.id).toBeNull()
    expect(draft.body).toBe('')
    expect(draft.focusAi).toBe(false)
  })

  it('「AI 写一条」进来的草稿把焦点标在 AI 那格，且仍然是一份空草稿', () => {
    const draft = blankDraft('all', true)
    expect(draft.focusAi).toBe(true)
    // 产出落编辑器不入库：这一步只是开了个空表单，id 还是 null
    expect(draft.id).toBeNull()
  })

  it('正筛着某个分组时，新建的默认落进那个分组', () => {
    expect(blankDraft(7, false).group_id).toBe(7)
    expect(blankDraft('none', false).group_id).toBeNull()
  })

  it('改一条已有的，草稿原样带上它的全部内容与变量声明', () => {
    const item = entry({
      id: 12,
      title: '写实产品图',
      scene: '白底',
      body: 'a photo of {{主体}}',
      negative: 'blurry',
      group_id: 3,
      variables: [VAR],
    })
    expect(editDraft(item)).toEqual({
      id: 12,
      title: '写实产品图',
      scene: '白底',
      body: 'a photo of {{主体}}',
      negative: 'blurry',
      group_id: 3,
      variables: [VAR],
    })
  })
})
