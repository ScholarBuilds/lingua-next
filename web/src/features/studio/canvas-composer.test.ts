/* 画布输入框的纯逻辑（E1）。
 *
   要拦的四件事，每一件都真在这个仓里发生过或差一点发生：
   - 批量出图不限并发 → 选 20 个节点各 4 张，80 个请求同时出门，上游限流一挡整批全红；
   - 一个节点炸了把整批 reject 掉，后面排队的那几个一张都没发出去；
   - AI 扩写另存一个「现在显示哪一版」的状态，用户手改一个字之后状态还说
     「显示的是扩写后」，再点一次就把他的修改盖掉；
   - 套词库/AI 写词走 `mentionFromText(旧正文 + 新内容)`，正文里的 @ 芯片被碾平成
     「图1」三个字而映射表清空，下一次出图那个「图1」指向的是另一张图。 */

import { describe, expect, it } from 'vitest'

import {
  BULK_CONCURRENCY,
  RECENT_ITEM_MAX,
  RECENT_KEY,
  RECENT_MAX,
  appendDraft,
  bulkCountPatch,
  bulkPlan,
  composeShown,
  countModePatch,
  countPatch,
  durationText,
  effectiveDraft,
  etaSeconds,
  genModeOf,
  genPlanLine,
  genRoute,
  lastBatchFailures,
  recentClear,
  recentLabel,
  recentLoad,
  recentPush,
  runBulk,
  serialSetPlan,
  showRunPicker,
  skipSummary,
  taskDurations,
} from './canvas-composer'
import type { CanvasRunSettings, StudioTask } from '../../lib/api-studio'
import { isSubmitChord, mentionAppendText, mentionFromText } from './MentionInput'

/** 假的 localStorage。真的那个在 node 环境里不存在 */
function fakeStore(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed))
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v)
    },
    removeItem: (k: string) => {
      data.delete(k)
    },
  }
}

const candidate = (id: string, over: Partial<{ type: string; prompt: string; running: boolean }> = {}) => ({
  id,
  type: 'image',
  prompt: '一只猫',
  running: false,
  ...over,
})

describe('bulkPlan · 谁能出图、谁不能以及为什么', () => {
  it('只收图片节点，其余按原因分开而不是静默丢掉', () => {
    const plan = bulkPlan([
      candidate('a'),
      candidate('b', { type: 'prompt' }),
      candidate('c', { prompt: '   ' }),
      candidate('d', { running: true }),
      candidate('e'),
    ])
    expect(plan.targets).toEqual(['a', 'e'])
    expect(plan.skipped).toEqual([
      { id: 'b', reason: '不是出图节点' },
      { id: 'c', reason: '没有提示词' },
      { id: 'd', reason: '正在生成中' },
    ])
  })

  it('跳过原因按类归并成一句人话，不逐个念随机 id', () => {
    const plan = bulkPlan([
      candidate('a', { type: 'group' }),
      candidate('b', { type: 'loop' }),
      candidate('c', { prompt: '' }),
      candidate('d'),
    ])
    expect(skipSummary(plan.skipped)).toBe('跳过 3 个：2 个不是出图节点、1 个没有提示词')
    expect(skipSummary([])).toBe('')
  })
})

describe('effectiveDraft · 批量草稿怎么落到每个节点', () => {
  it('追加接在各自的词后面，替换整段换掉', () => {
    expect(effectiveDraft('原来的词', '统一加这句', 'append')).toBe('原来的词\n统一加这句')
    expect(effectiveDraft('原来的词', '统一加这句', 'replace')).toBe('统一加这句')
  })

  it('批量草稿为空时一律退回各自的词，replace 也不例外', () => {
    // 空输入框 + 替换 = 一次清空十几个节点的草稿，那是个没人想要的操作
    expect(effectiveDraft('原来的词', '', 'replace')).toBe('原来的词')
    expect(effectiveDraft('原来的词', '   ', 'replace')).toBe('原来的词')
    expect(effectiveDraft('原来的词', '  ', 'append')).toBe('原来的词')
  })

  it('自己没写词时追加就等于只有这一句', () => {
    expect(appendDraft('', '统一加这句')).toBe('统一加这句')
    expect(effectiveDraft('', '统一加这句', 'append')).toBe('统一加这句')
  })
})

describe('runBulk · 分片与失败隔离', () => {
  it('同时在跑的数量不超过上限，全部节点都会跑到', async () => {
    const ids = Array.from({ length: 9 }, (_, i) => `n${i}`)
    let live = 0
    let peak = 0
    const seen: string[] = []
    await runBulk(
      ids,
      async (id) => {
        live += 1
        peak = Math.max(peak, live)
        seen.push(id)
        await Promise.resolve()
        await Promise.resolve()
        live -= 1
      },
      { limit: 3 },
    )
    expect(peak).toBe(3)
    expect(seen.sort()).toEqual(ids.slice().sort())
  })

  it('一个节点抛错不拖垮其余，结果按入参顺序回', async () => {
    const outcomes = await runBulk(
      ['a', 'b', 'c', 'd'],
      async (id) => {
        if (id === 'b') throw new Error('上游 429')
        await Promise.resolve()
      },
      { limit: 2 },
    )
    expect(outcomes.map((o) => o.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(outcomes.map((o) => o.ok)).toEqual([true, false, true, true])
    expect(outcomes[1].error).toBe('上游 429')
  })

  it('进度按完成条数逐一上报，最后一条等于总数', async () => {
    const ticks: string[] = []
    await runBulk(['a', 'b', 'c'], async () => undefined, {
      limit: 2,
      onProgress: (done, total) => ticks.push(`${done}/${total}`),
    })
    expect(ticks).toEqual(['1/3', '2/3', '3/3'])
  })

  it('空选区不发任何请求', async () => {
    let calls = 0
    const outcomes = await runBulk([], async () => {
      calls += 1
    })
    expect(calls).toBe(0)
    expect(outcomes).toHaveLength(0)
  })

  it('默认并发是画布上那个常量，不是每节点张数上限 GEN_N_MAX', async () => {
    // 两个数是相乘的关系：20 个节点各 4 张 = 80 个请求。拿 50 当并发用等于没有上限
    expect(BULK_CONCURRENCY).toBeLessThanOrEqual(8)
    let peak = 0
    let live = 0
    await runBulk(
      Array.from({ length: 12 }, (_, i) => `n${i}`),
      async () => {
        live += 1
        peak = Math.max(peak, live)
        await Promise.resolve()
        live -= 1
      },
    )
    expect(peak).toBe(BULK_CONCURRENCY)
  })
})

describe('composeShown · AI 扩写的原文/结果切换', () => {
  const trace = { before: '一只猫', after: 'a cat sitting on a windowsill, soft morning light' }

  it('框里是哪一版就点亮哪一个', () => {
    expect(composeShown(trace.before, trace)).toBe('before')
    expect(composeShown(trace.after, trace)).toBe('after')
  })

  it('用户在扩写结果上手改过之后两版都不认，对比条该收起来', () => {
    // 留着切换按钮的话，再点一次「扩写后」就把他刚改的字盖掉了
    expect(composeShown(`${trace.after} 加一句`, trace)).toBeNull()
  })

  it('没扩写过就没有对比', () => {
    expect(composeShown('随便什么', null)).toBeNull()
  })
})

describe('最近用过的提示词', () => {
  it('新的排最前，同内容顶上去而不是留两份', () => {
    const store = fakeStore()
    recentPush('画只猫', store)
    recentPush('画只狗', store)
    const list = recentPush('画只猫', store)
    expect(list).toEqual(['画只猫', '画只狗'])
    expect(recentLoad(store)).toEqual(['画只猫', '画只狗'])
  })

  it('只留最近 RECENT_MAX 条，超出的从尾部掉', () => {
    const store = fakeStore()
    for (let i = 0; i < RECENT_MAX + 5; i += 1) recentPush(`第 ${i} 句`, store)
    const list = recentLoad(store)
    expect(list).toHaveLength(RECENT_MAX)
    expect(list[0]).toBe(`第 ${RECENT_MAX + 4} 句`)
    expect(list.at(-1)).toBe(`第 ${5} 句`)
  })

  it('空白不记，超长的截断存', () => {
    const store = fakeStore()
    expect(recentPush('   ', store)).toEqual([])
    const long = 'x'.repeat(RECENT_ITEM_MAX + 200)
    expect(recentPush(long, store)[0]).toHaveLength(RECENT_ITEM_MAX)
  })

  it('存的东西坏了就当空，不把输入框带崩', () => {
    expect(recentLoad(fakeStore({ [RECENT_KEY]: '{不是 JSON' }))).toEqual([])
    expect(recentLoad(fakeStore({ [RECENT_KEY]: '"不是数组"' }))).toEqual([])
    expect(recentLoad(fakeStore({ [RECENT_KEY]: '[1, null, "有效"]' }))).toEqual(['有效'])
  })

  it('写入抛异常（配额满 / 无痕模式）不影响返回值', () => {
    const broken = {
      getItem: () => '[]',
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: () => undefined,
    }
    expect(recentPush('画只猫', broken)).toEqual(['画只猫'])
    expect(() => recentClear(broken)).not.toThrow()
  })

  it('清空之后真的没了', () => {
    const store = fakeStore()
    recentPush('画只猫', store)
    recentClear(store)
    expect(recentLoad(store)).toEqual([])
  })

  it('列表里只显示一行，换行折成空格', () => {
    expect(recentLabel('第一行\n第二行', 40)).toBe('第一行 第二行')
    expect(recentLabel('x'.repeat(50), 10)).toBe(`${'x'.repeat(10)}…`)
  })
})

describe('提交快捷键分派', () => {
  it('⌘/Ctrl + Enter 才算提交', () => {
    expect(isSubmitChord({ key: 'Enter', metaKey: true, ctrlKey: false })).toBe(true)
    expect(isSubmitChord({ key: 'Enter', metaKey: false, ctrlKey: true })).toBe(true)
  })

  it('裸 Enter 不是提交——提示词经常要分段写', () => {
    expect(isSubmitChord({ key: 'Enter', metaKey: false, ctrlKey: false })).toBe(false)
  })

  it('带 Shift / Alt 的组合让给输入法与换行，别的键一律不认', () => {
    expect(isSubmitChord({ key: 'Enter', metaKey: true, ctrlKey: false, shiftKey: true })).toBe(false)
    expect(isSubmitChord({ key: 'Enter', metaKey: true, ctrlKey: false, altKey: true })).toBe(false)
    expect(isSubmitChord({ key: 'a', metaKey: true, ctrlKey: false })).toBe(false)
  })
})

describe('mentionAppendText · 套词库与 AI 写词不许碾平 @ 芯片', () => {
  const withChip = {
    html: '看<span class="smi-token" contenteditable="false" data-asset-id="7" data-label="猫" data-thumb="/t/7">@猫</span>这张',
    text: '看图1这张',
    refs: [{ asset_id: 7, label: '猫', thumb_url: '/t/7' }],
  }

  it('追加之后引用清单原样还在', () => {
    const next = mentionAppendText(withChip, '改成水彩风')
    expect(next.refs).toEqual(withChip.refs)
    expect(next.text).toBe('看图1这张\n改成水彩风')
    expect(next.html).toContain('smi-token')
    expect(next.html.endsWith('改成水彩风')).toBe(true)
  })

  it('旧写法会把芯片碾平——这条守着别再走回去', () => {
    const wrong = mentionFromText(`${withChip.text}\n改成水彩风`)
    expect(wrong.refs).toEqual([])
    expect(wrong.html).not.toContain('smi-token')
  })

  it('空草稿不先空出一行，空内容原样返回', () => {
    const empty = { html: '', text: '', refs: [] }
    expect(mentionAppendText(empty, '第一句').text).toBe('第一句')
    expect(mentionAppendText(empty, '第一句').html).toBe('第一句')
    expect(mentionAppendText(withChip, '   ')).toBe(withChip)
  })

  it('追加的内容照样转义，词库条目里的标签不会被执行', () => {
    const next = mentionAppendText({ html: '', text: '', refs: [] }, '<img onerror=alert(1)>')
    expect(next.html).toBe('&lt;img onerror=alert(1)&gt;')
  })

  it('html 与 text 两边同步：多行追加两边都是同一份内容', () => {
    const next = mentionAppendText({ html: '第一段', text: '第一段', refs: [] }, '第二段\n第三段')
    expect(next.text).toBe('第一段\n第二段\n第三段')
    expect(next.html).toBe('第一段<br>第二段<br>第三段')
  })
})

/* ==================== 生成模式：出几张 × 怎么跑 ==================== */

const rsOf = (over: Partial<CanvasRunSettings> = {}): CanvasRunSettings => ({ ...over })

const taskOf = (over: Partial<StudioTask> = {}): StudioTask =>
  ({
    id: 't1',
    status: 'succeeded',
    retryable: true,
    execution_group_id: 'g1',
    created_at: '2026-08-23T00:00:00Z',
    started_at: '2026-08-23T00:00:00Z',
    finished_at: '2026-08-23T00:00:10Z',
    error: null,
    ...over,
  }) as StudioTask

describe('genModeOf · 旧画布只有 n，模式得从它反推', () => {
  it('没写过模式的老画布：n>1 当作「多张·并发」，n=1 当作「1 张」', () => {
    expect(genModeOf(rsOf({ n: 4 }), 50)).toEqual({ count: 'fixed', run: 'parallel', n: 4 })
    expect(genModeOf(rsOf({ n: 1 }), 50)).toEqual({ count: 'one', run: 'parallel', n: 1 })
    expect(genModeOf(undefined, 50)).toEqual({ count: 'one', run: 'parallel', n: 1 })
  })

  it('自动张数下 n 是 null，不拿占位数字冒充「会出几张」', () => {
    expect(genModeOf(rsOf({ count_mode: 'auto', n: 4 }), 50).n).toBeNull()
  })

  it('张数夹在上限内，脏值退回 1', () => {
    expect(genModeOf(rsOf({ count_mode: 'fixed', n: 999 }), 50).n).toBe(50)
    expect(genModeOf(rsOf({ count_mode: 'fixed', n: Number.NaN }), 50).n).toBe(1)
  })
})

describe('countModePatch · 模式与运行时读的那个 n 必须一起改', () => {
  it('选「1 张」把 n 一起写成 1——运行时只读 n，光改模式等于没改', () => {
    const patch = countModePatch('one', { count: 'fixed', run: 'parallel', n: 8 }, 50)
    expect(patch).toEqual({ count_mode: 'one', n: 1 })
  })

  it('从 1 张切到多张给一个大于 1 的默认值，不留个点不动的 1', () => {
    expect(countModePatch('fixed', { count: 'one', run: 'parallel', n: 1 }, 50).n).toBe(4)
  })

  it('本来就填了多张，切回来保留原来的数字', () => {
    expect(countModePatch('fixed', { count: 'auto', run: 'serial', n: null }, 50).n).toBe(4)
    expect(countModePatch('fixed', { count: 'one', run: 'parallel', n: 6 }, 50).n).toBe(6)
  })

  it('自动张数不经 rs.n，写 1 免得别处回落时闷声出一堆图', () => {
    expect(countModePatch('auto', { count: 'fixed', run: 'serial', n: 9 }, 50)).toEqual({
      count_mode: 'auto',
      n: 1,
    })
  })

  it('手填张数夹在 [1, 上限] 内', () => {
    expect(countPatch('7', 50)).toEqual({ count_mode: 'fixed', n: 7 })
    expect(countPatch('0', 50).n).toBe(1)
    expect(countPatch('80', 50).n).toBe(50)
    expect(countPatch('abc', 50).n).toBe(1)
  })

  it('数字框敲到 1 不跳回「1 张」档——清空重打的中途会让输入框当场消失', () => {
    expect(countPatch('', 50).count_mode).toBe('fixed')
    expect(countPatch('1', 50).count_mode).toBe('fixed')
  })

  it('批量条选 1 张是选定的，该落到「1 张」档并把跑法收起来', () => {
    expect(bulkCountPatch('1', 50)).toEqual({ count_mode: 'one', n: 1 })
    expect(bulkCountPatch('4', 50)).toEqual({ count_mode: 'fixed', n: 4 })
  })
})

describe('showRunPicker · 只出一张时「怎么跑」没有意义', () => {
  it('1 张不显示——两种跑法出来的东西一模一样', () => {
    expect(showRunPicker({ count: 'one', run: 'parallel', n: 1 })).toBe(false)
    expect(showRunPicker({ count: 'fixed', run: 'serial', n: 1 })).toBe(false)
  })

  it('多张才显示', () => {
    expect(showRunPicker({ count: 'fixed', run: 'parallel', n: 2 })).toBe(true)
  })

  it('自动张数不显示：几步都还不知道，跑法由成套方案定', () => {
    expect(showRunPicker({ count: 'auto', run: 'serial', n: null })).toBe(false)
  })
})

describe('genRoute · 两个选择分派到三条既有链路', () => {
  it('自动张数走成套', () => {
    expect(genRoute({ count: 'auto', run: 'parallel', n: null })).toBe('plan')
  })

  it('串行多张走成套方案的 consistent 语义，不必先建循环节点', () => {
    expect(genRoute({ count: 'fixed', run: 'serial', n: 4 })).toBe('serial-set')
  })

  it('一张、以及并发多张，都走单节点生成', () => {
    expect(genRoute({ count: 'one', run: 'serial', n: 1 })).toBe('single')
    expect(genRoute({ count: 'fixed', run: 'parallel', n: 4 })).toBe('single')
    // 选了串行却只要 1 张：串行没有意义，退回单张，不去建一排槽位
    expect(genRoute({ count: 'fixed', run: 'serial', n: 1 })).toBe('single')
  })
})

describe('serialSetPlan · 串行多图复用成套的串行链路', () => {
  it('N 步同一句词，intent 必须是 consistent——串行的全部意义在这', () => {
    const plan = serialSetPlan('  一个登录页  ', 3, 50)
    expect(plan.intent).toBe('consistent')
    expect(plan.steps).toHaveLength(3)
    expect(plan.steps.map((step) => step.prompt)).toEqual(['一个登录页', '一个登录页', '一个登录页'])
    expect(plan.steps.map((step) => step.id)).toEqual(['serial-1', 'serial-2', 'serial-3'])
    expect(plan.steps[0].dependsOn).toEqual([])
    expect(plan.steps[2].dependsOn).toEqual(['serial-2'])
  })

  it('张数夹在 [2, 上限]：1 步的「串行」是自相矛盾的输入', () => {
    expect(serialSetPlan('词', 1, 50).steps).toHaveLength(2)
    expect(serialSetPlan('词', 400, 50).steps).toHaveLength(50)
  })
})

describe('etaSeconds · 样本不够就不猜', () => {
  it('少于两次实测直接返回 null，不编一个数出来', () => {
    expect(etaSeconds([], { count: 'fixed', run: 'parallel', n: 4 })).toBeNull()
    expect(etaSeconds([12], { count: 'fixed', run: 'parallel', n: 4 })).toBeNull()
  })

  it('取中位数不取均值：卡上游一次两分钟会把均值拖到毫无参考价值', () => {
    expect(etaSeconds([10, 11, 240], { count: 'one', run: 'parallel', n: 1 })).toBe(11)
  })

  it('并发按一起出门估，串行按 N 倍估', () => {
    const samples = [10, 12, 14]
    expect(etaSeconds(samples, { count: 'fixed', run: 'parallel', n: 4 })).toBe(12)
    expect(etaSeconds(samples, { count: 'fixed', run: 'serial', n: 4 })).toBe(48)
  })

  it('自动张数下张数未知，估不出来就不估', () => {
    expect(etaSeconds([10, 12], { count: 'auto', run: 'serial', n: null })).toBeNull()
  })

  it('脏样本（0 秒、NaN）不参与', () => {
    expect(etaSeconds([0, Number.NaN, 9], { count: 'one', run: 'parallel', n: 1 })).toBeNull()
  })

  it('用时读起来是人话', () => {
    expect(durationText(45)).toBe('45 秒')
    expect(durationText(120)).toBe('2 分')
    expect(durationText(135)).toBe('2 分 15 秒')
  })
})

describe('genPlanLine · 点下去之前说清将要发生什么', () => {
  it('并发多张：几张、怎么跑、落在哪、带几张参考，四件事都在', () => {
    const line = genPlanLine({
      mode: { count: 'fixed', run: 'parallel', n: 4 },
      hasItems: true,
      refs: 2,
      samples: [],
    })
    expect(line[0]).toBe('出 4 张')
    expect(line[1]).toContain('并发')
    expect(line[2]).toContain('右侧')
    expect(line[3]).toContain('图1…图2')
  })

  it('串行多张说清落点是下方一排新节点，而不是堆进本节点', () => {
    const line = genPlanLine({
      mode: { count: 'fixed', run: 'serial', n: 3 },
      hasItems: false,
      refs: 0,
      samples: [],
    })
    expect(line[1]).toContain('串行')
    expect(line[2]).toBe('本节点下方排 3 个新节点')
    expect(line[3]).toContain('文生图')
  })

  it('只出一张时不提跑法——那一档控件本来就藏起来了，说明里也不该冒出来', () => {
    const line = genPlanLine({
      mode: { count: 'one', run: 'serial', n: 1 },
      hasItems: false,
      refs: 0,
      samples: [],
    })
    expect(line.some((part) => part.includes('串行') || part.includes('并发'))).toBe(false)
    expect(line[1]).toBe('落进本节点')
  })

  it('自动张数如实说「由 AI 判断」，不摆一个假数字', () => {
    const line = genPlanLine({
      mode: { count: 'auto', run: 'parallel', n: null },
      hasItems: true,
      refs: 0,
      samples: [12, 13],
    })
    expect(line[0]).toContain('AI')
    expect(line.some((part) => part.includes('约'))).toBe(false)
  })

  it('有实测样本才写预计用时，并且写明依据几次', () => {
    const line = genPlanLine({
      mode: { count: 'fixed', run: 'serial', n: 3 },
      hasItems: false,
      refs: 0,
      samples: [10, 10, 10],
    })
    expect(line[line.length - 1]).toBe('按最近 3 次估约 30 秒')
  })
})

describe('lastBatchFailures · 只补上一批，不把陈年失败一直挂着', () => {
  it('同一个执行组里失败且可重试的才列出来', () => {
    const items = [
      taskOf({ id: 'a', status: 'failed', error: '上游 429', created_at: '2026-08-23T02:00:00Z' }),
      taskOf({ id: 'b', status: 'succeeded', created_at: '2026-08-23T01:59:00Z' }),
      taskOf({ id: 'c', status: 'failed', retryable: false, created_at: '2026-08-23T01:58:00Z' }),
    ]
    expect(lastBatchFailures(items).map((task) => task.id)).toEqual(['a'])
  })

  it('上一批之前的失败不算——那批是另一个执行组', () => {
    const items = [
      taskOf({ id: 'new', status: 'succeeded', created_at: '2026-08-23T03:00:00Z' }),
      taskOf({
        id: 'old',
        status: 'failed',
        execution_group_id: 'g0',
        created_at: '2026-08-22T03:00:00Z',
      }),
    ]
    expect(lastBatchFailures(items)).toEqual([])
  })

  it('没有执行组（老任务）时只看最新那一条', () => {
    const items = [
      taskOf({ id: 'x', status: 'failed', execution_group_id: null, created_at: '2026-08-23T03:00:00Z' }),
      taskOf({ id: 'y', status: 'failed', execution_group_id: null, created_at: '2026-08-22T03:00:00Z' }),
    ]
    expect(lastBatchFailures(items).map((task) => task.id)).toEqual(['x'])
  })

  it('一条都没有时返回空数组而不是炸', () => {
    expect(lastBatchFailures([])).toEqual([])
  })
})

describe('taskDurations · 估时只认成功那几次', () => {
  it('失败的那次几百毫秒就 4xx 回来了，掺进去会把估算压得离谱地低', () => {
    const items = [
      taskOf({ id: 'ok', created_at: '2026-08-23T02:00:00Z' }),
      taskOf({
        id: 'bad',
        status: 'failed',
        created_at: '2026-08-23T01:00:00Z',
        started_at: '2026-08-23T01:00:00Z',
        finished_at: '2026-08-23T01:00:00.400Z',
      }),
    ]
    expect(taskDurations(items)).toEqual([10])
  })

  it('缺时间戳的跳过，新的在前', () => {
    const items = [
      taskOf({ id: '1', created_at: '2026-08-23T02:00:00Z', finished_at: null }),
      taskOf({
        id: '2',
        created_at: '2026-08-23T01:00:00Z',
        started_at: '2026-08-23T01:00:00Z',
        finished_at: '2026-08-23T01:00:20Z',
      }),
    ]
    expect(taskDurations(items)).toEqual([20])
  })
})


/* ==================== 自动档要直接开跑规划 ====================

   项目主人的原话：「直接在提示词中输入生成一套这个登录模块，ai 就能自动生成一套」。
   收口前他得点四次：写词 → 选自动 → 点「规划并出图」→ **在弹窗里再点一次「开始」**。
   第四下是纯多余的——需求那句话已经写在输入框里、弹窗里也原样显示着它。
   但只自动到出方案为止：一套十张是真金白银，方案要摆出来让人看一眼再执行。 */

describe('自动档的路由与开跑', () => {
  it('自动档走规划链路，跟张数无关', () => {
    expect(genRoute({ count: 'auto', n: null, run: 'parallel' })).toBe('plan')
    expect(genRoute({ count: 'auto', n: null, run: 'serial' })).toBe('plan')
  })

  /* 这条守的是「串行不是一套」这个语义。它把同一句词铺成 N 步，
     所以拿它去出十个不同的登录界面会得到十次同一句话的尝试。 */
  it('串行的 N 步用的是同一句词——它不负责让每张不同', () => {
    const plan = serialSetPlan('生成一套登录界面', 4, 50)
    const words = new Set(plan.steps.map((s) => s.prompt))
    expect(words.size).toBe(1)
    expect(plan.steps).toHaveLength(4)
  })

  it('串行的每一步都依赖前一步——这才是它存在的理由', () => {
    const plan = serialSetPlan('改一下配色', 3, 50)
    expect(plan.steps[0].dependsOn).toEqual([])
    expect(plan.steps[1].dependsOn).toEqual([plan.steps[0].id])
    expect(plan.steps[2].dependsOn).toEqual([plan.steps[1].id])
  })
})

/* ==================== 批量出图的状态判据 ====================

   守的是一次实测到的误导：框选 11 个节点，界面说「对选中的 0 个节点出图 ·
   跳过 11 个：10 个没有提示词、1 个不是出图节点」，主按钮灰着——看起来像坏了。
   而在正下方那个空输入框里打一句话，立刻变成 10 个、按钮亮起。
   把「差一句词」和「类型不对」并列成「跳过」，就是把差一步说成了失败。 */

import { bulkStatus, NO_PROMPT_REASON } from './canvas-composer'

const planOf = (ready: number, reasons: string[]) => ({
  targets: Array.from({ length: ready }, (_, i) => `t${i}`),
  skipped: reasons.map((reason, i) => ({ id: `s${i}`, reason })),
})

describe('批量出图的状态判据', () => {
  it('只差词的时候不说「跳过」，说还差什么、去哪补', () => {
    const s = bulkStatus(planOf(0, Array(10).fill(NO_PROMPT_REASON)))
    expect(s.headline).toContain('10 个')
    expect(s.headline).not.toContain('跳过')
    expect(s.note).toContain('写一句')
    expect(s.canRun).toBe(false)
  })

  /* 主按钮是用户唯一会读的那行字。「出图 · 0 个」把「差一句词」说成了
     「没得出」，而修法就在光标已经停着的地方。 */
  it('主按钮指向补救动作，不是一个死掉的 0', () => {
    const s = bulkStatus(planOf(0, Array(10).fill(NO_PROMPT_REASON)))
    expect(s.action).not.toBe('出图 · 0 个')
    expect(s.action).toContain('写一句词')
  })

  it('差词与真跳过混在一起时分开说', () => {
    const s = bulkStatus(planOf(0, [...Array(10).fill(NO_PROMPT_REASON), '不是出图节点']))
    expect(s.needWord).toBe(10)
    expect(s.excluded).toEqual([{ reason: '不是出图节点', count: 1 }])
    expect(s.note).toContain('1 个不是出图节点')
  })

  it('写了词之后就是准备好，剩下的才叫跳过', () => {
    const s = bulkStatus(planOf(10, ['不是出图节点']))
    expect(s.headline).toBe('10 个节点准备好了')
    expect(s.action).toBe('出图 · 10 个')
    expect(s.canRun).toBe(true)
    expect(s.note).toContain('跳过 1 个不是出图节点')
  })

  /* 部分有词部分没词：能跑的先跑，没词的提一句「写了就一起带上」，
     不能让它变成「要么全跑要么不跑」。 */
  it('一部分有词一部分没词，两件事都说', () => {
    const s = bulkStatus(planOf(3, Array(5).fill(NO_PROMPT_REASON)))
    expect(s.canRun).toBe(true)
    expect(s.action).toBe('出图 · 3 个')
    expect(s.note).toContain('5 个还没有词')
  })

  it('真的一个都不能出时才说不能出', () => {
    const s = bulkStatus(planOf(0, ['不是出图节点', '正在生成中']))
    expect(s.headline).toBe('选中的节点都不能出图')
    expect(s.canRun).toBe(false)
    expect(s.needWord).toBe(0)
  })

  it('全都能跑时不留多余的说明，界面上不出空行', () => {
    const s = bulkStatus(planOf(4, []))
    expect(s.headline).toBe('4 个节点准备好了')
    expect(s.note).toBe('')
  })

  it('同一原因归并计数，不逐个列 id', () => {
    const s = bulkStatus(planOf(1, ['正在生成中', '正在生成中', '正在生成中']))
    expect(s.excluded).toEqual([{ reason: '正在生成中', count: 3 }])
  })
})
