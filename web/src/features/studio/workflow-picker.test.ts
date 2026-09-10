/* 工作流选择弹窗的纯逻辑。用例里的标题全是库里真有的那 15 条，
   免得测试通过、真数据一进来就归错档。 */

import { describe, expect, it } from 'vitest'

import type { ExecutableWorkflow } from '../../lib/api-studio'
import {
  filterWorkflows,
  groupWorkflows,
  matchesWorkflowQuery,
  purposeFacets,
  readWorkflowUsage,
  recordWorkflowUsage,
  sortWorkflows,
  usedAtLabel,
  workflowPurpose,
} from './workflow-picker'
import type { UsageStorage, WorkflowUsageMap } from './workflow-picker'

let seq = 0

function make(
  title: string,
  over: Partial<ExecutableWorkflow> = {},
): ExecutableWorkflow {
  seq += 1
  const provider = over.provider ?? 'comfyui'
  return {
    id: seq,
    key: over.key ?? `${provider}:${title}`,
    title,
    provider,
    kind: 'workflow',
    source: 'bundled',
    source_id: null,
    enabled: true,
    node_count: 12,
    field_count: 3,
    has_thumbnail: false,
    content_hash: `hash-${seq}`,
    version: 1,
    created_at: '2026-08-01T00:00:00+00:00',
    updated_at: '2026-08-01T00:00:00+00:00',
    ...over,
  }
}

/** 库里真实的 15 条 */
const REAL: ExecutableWorkflow[] = [
  make('2511 风格迁移', { provider: 'comfyui', kind: 'edit' }),
  make('2511-光线迁移', { provider: 'runninghub', kind: 'app', field_count: 0 }),
  make('2511-风格迁移', { provider: 'runninghub', kind: 'app' }),
  make('Flux.2 Klein 细节增强', { provider: 'runninghub', has_thumbnail: true, field_count: 19 }),
  make('Flux2 Klein 多参考生成', { provider: 'comfyui', kind: 'edit', field_count: 7 }),
  make('Flux2-Klein-万物迁移', { provider: 'runninghub', has_thumbnail: true, field_count: 24 }),
  make('GPT-Image-2-图片编辑', { provider: 'runninghub', has_thumbnail: true, field_count: 11 }),
  make('LTX Director v2', { provider: 'comfyui', kind: 'video', field_count: 18 }),
  make('MiniMax H3', { provider: 'comfyui', kind: 'video', field_count: 7 }),
  make('Minimax-多参视频生成', { provider: 'runninghub', has_thumbnail: true, field_count: 0 }),
  make('NanoBanana-2-图片编辑', { provider: 'runninghub', has_thumbnail: true, field_count: 12 }),
  make('SeedVR2 高清放大', { provider: 'runninghub', has_thumbnail: true, field_count: 32 }),
  make('SeedVR2 高清放大', { provider: 'comfyui', kind: 'upscale', key: 'comfyui:upscale' }),
  make('Z-Image 生图', { provider: 'comfyui', kind: 'image', field_count: 4 }),
  make('Z-Image 细节增强', { provider: 'comfyui', kind: 'edit', field_count: 2 }),
]

function purposeOf(title: string): string {
  const found = REAL.find((item) => item.title === title)
  if (found === undefined) throw new Error(`用例里没有这条：${title}`)
  return workflowPurpose(found).id
}

describe('工作流用途归类', () => {
  it('十五条真数据一条都不落进「通用」兜底', () => {
    expect(REAL.map((item) => workflowPurpose(item).id)).not.toContain('other')
  })

  it('放大先于编辑判，「SeedVR2 高清放大」不会被「增强」类规则抢走', () => {
    expect(purposeOf('SeedVR2 高清放大')).toBe('upscale')
  })

  it('标题带「编辑 / 迁移 / 增强 / 参考」的都算图片编辑', () => {
    expect(purposeOf('GPT-Image-2-图片编辑')).toBe('edit')
    expect(purposeOf('Flux2-Klein-万物迁移')).toBe('edit')
    expect(purposeOf('Flux.2 Klein 细节增强')).toBe('edit')
    expect(purposeOf('Flux2 Klein 多参考生成')).toBe('edit')
  })

  it('视频最先判，「Minimax-多参视频生成」不会被当成生图', () => {
    expect(purposeOf('Minimax-多参视频生成')).toBe('video')
    expect(purposeOf('LTX Director v2')).toBe('video')
  })

  it('标题看不出用途时靠 kind 兜底', () => {
    expect(purposeOf('MiniMax H3')).toBe('video')
    expect(purposeOf('Z-Image 生图')).toBe('image')
  })

  it('实在判不出来才算通用工作流', () => {
    expect(workflowPurpose(make('客户定制 A 线', { kind: 'app' })).id).toBe('other')
  })
})

describe('搜索', () => {
  function titles(query: string): string[] {
    return REAL.filter((item) => matchesWorkflowQuery(item, query)).map((item) => item.title)
  }

  it('搜用途能搜到标题里没这两个字的那些', () => {
    // 「改图」是 edit 档的别名，四条标题里一条都没写过
    const hit = titles('改图')
    expect(hit).toContain('GPT-Image-2-图片编辑')
    expect(hit).toContain('2511 风格迁移')
    expect(hit).not.toContain('Z-Image 生图')
  })

  it('搜「文生图」命中只写了「生图」的那条', () => {
    expect(titles('文生图')).toEqual(['Z-Image 生图'])
  })

  it('搜来源别名：「云端」等于 RunningHub', () => {
    const hit = titles('云端')
    expect(hit).toHaveLength(REAL.filter((item) => item.provider === 'runninghub').length)
    expect(hit).not.toContain('Z-Image 生图')
  })

  it('多个词是「都要命中」，名字与来源别名可以混着搜', () => {
    expect(titles('klein 万物')).toEqual(['Flux2-Klein-万物迁移'])
    expect(titles('klein 云端')).toEqual(['Flux.2 Klein 细节增强', 'Flux2-Klein-万物迁移'])
    expect(titles('klein 放大')).toEqual([])
  })

  it('大小写与前后空格不影响命中', () => {
    expect(titles('  KLEIN  ')).toHaveLength(3)
  })

  it('空串放行全部', () => {
    expect(titles('')).toHaveLength(REAL.length)
    expect(titles('   ')).toHaveLength(REAL.length)
  })
})

describe('筛选', () => {
  it('来源、用途、关键词三者取交集', () => {
    const hit = filterWorkflows(REAL, { provider: 'comfyui', purpose: 'edit', query: 'klein' })
    expect(hit.map((item) => item.title)).toEqual(['Flux2 Klein 多参考生成'])
  })

  it('全选时一条不漏', () => {
    expect(filterWorkflows(REAL, { provider: 'all', purpose: 'all', query: '' })).toHaveLength(15)
  })

  it('用途筛选条只列真有货的档位，且顺序固定', () => {
    expect(purposeFacets(REAL).map((facet) => facet.id)).toEqual([
      'image',
      'edit',
      'upscale',
      'video',
    ])
    const upscale = purposeFacets(REAL).find((facet) => facet.id === 'upscale')
    expect(upscale?.count).toBe(2)
  })

  it('没有任何一条落进「通用」时就不摆这个档', () => {
    expect(purposeFacets(REAL).map((facet) => facet.id)).not.toContain('other')
  })
})

describe('排序', () => {
  const a = make('甲', { key: 'k-a' })
  const b = make('乙', { key: 'k-b' })
  const c = make('丙', { key: 'k-c' })

  it('用得多的排前面', () => {
    const usage: WorkflowUsageMap = {
      'k-a': { count: 1, last: 500 },
      'k-b': { count: 9, last: 100 },
    }
    expect(sortWorkflows([a, b, c], usage).map((item) => item.key)).toEqual(['k-b', 'k-a', 'k-c'])
  })

  it('次数打平就比最近一次用的时间', () => {
    const usage: WorkflowUsageMap = {
      'k-a': { count: 3, last: 100 },
      'k-b': { count: 3, last: 900 },
    }
    expect(sortWorkflows([a, b], usage).map((item) => item.key)).toEqual(['k-b', 'k-a'])
  })

  it('都没用过按名字排，顺序稳定不随数组顺序抖', () => {
    const sorted = sortWorkflows([b, c, a], {}).map((item) => item.title)
    expect(sorted).toEqual(sortWorkflows([a, b, c], {}).map((item) => item.title))
  })

  it('不改传进来的数组', () => {
    const input = [b, a]
    sortWorkflows(input, { 'k-a': { count: 5, last: 1 } })
    expect(input.map((item) => item.key)).toEqual(['k-b', 'k-a'])
  })
})

describe('分区', () => {
  const items = Array.from({ length: 9 }, (_, i) => make(`工作流 ${i}`, { key: `k-${i}` }))

  it('一条都没有时连空壳分区都不给，免得空态下面还挂个空网格', () => {
    expect(groupWorkflows([], {}, false)).toEqual([])
  })

  it('一条都没用过就不分区，也不加小标题', () => {
    const groups = groupWorkflows(items, {}, false)
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('')
    expect(groups[0].items).toHaveLength(9)
  })

  it('用过的单独提到「常用」，其余留在下面且不重复出现', () => {
    const usage: WorkflowUsageMap = { 'k-3': { count: 4, last: 20 }, 'k-7': { count: 1, last: 10 } }
    const groups = groupWorkflows(sortWorkflows(items, usage), usage, false)
    expect(groups.map((group) => group.label)).toEqual(['常用', '其余工作流'])
    expect(groups[0].items.map((item) => item.key)).toEqual(['k-3', 'k-7'])
    expect(groups[1].items.map((item) => item.key)).not.toContain('k-3')
    expect(groups[0].items.length + groups[1].items.length).toBe(9)
  })

  it('常用最多六条，多出来的落回下面那组', () => {
    const usage: WorkflowUsageMap = {}
    items.forEach((item, i) => {
      usage[item.key] = { count: 9 - i, last: i }
    })
    const groups = groupWorkflows(sortWorkflows(items, usage), usage, false)
    expect(groups[0].items).toHaveLength(6)
    expect(groups[1].items).toHaveLength(3)
  })

  it('搜索时不分区', () => {
    const usage: WorkflowUsageMap = { 'k-3': { count: 4, last: 20 } }
    const groups = groupWorkflows(items, usage, true)
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('')
  })

  it('不改传进来的数组', () => {
    const input = [...items]
    groupWorkflows(input, {}, false)
    expect(input).toHaveLength(9)
  })
})

describe('上次用过的说法', () => {
  const now = 1_800_000_000_000

  it('按时间跨度换说法', () => {
    expect(usedAtLabel(now - 60_000, now)).toBe('刚刚用过')
    expect(usedAtLabel(now - 20 * 60_000, now)).toBe('20 分钟前用过')
    expect(usedAtLabel(now - 5 * 3_600_000, now)).toBe('5 小时前用过')
    expect(usedAtLabel(now - 30 * 3_600_000, now)).toBe('昨天用过')
    expect(usedAtLabel(now - 6 * 86_400_000, now)).toBe('6 天前用过')
    expect(usedAtLabel(now - 400 * 86_400_000, now)).toBe('很久以前用过')
  })

  it('时间戳比现在还新时不出现负数', () => {
    expect(usedAtLabel(now + 90_000, now)).toBe('刚刚用过')
  })
})

function fakeStorage(seed: Record<string, string> = {}): UsageStorage & { dump: Record<string, string> } {
  const dump: Record<string, string> = { ...seed }
  return {
    dump,
    getItem: (key) => dump[key] ?? null,
    setItem: (key, value) => {
      dump[key] = value
    },
  }
}

const KEY = 'lingua.studio.workflow-usage'

describe('使用记录', () => {
  it('记一次就 +1，并盖上时间戳', () => {
    const storage = fakeStorage()
    recordWorkflowUsage('comfyui:upscale', { now: 1000, storage })
    const after = recordWorkflowUsage('comfyui:upscale', { now: 2000, storage })
    expect(after['comfyui:upscale']).toEqual({ count: 2, last: 2000 })
    expect(readWorkflowUsage(storage)['comfyui:upscale']).toEqual({ count: 2, last: 2000 })
  })

  it('不同工作流各记各的', () => {
    const storage = fakeStorage()
    recordWorkflowUsage('a', { now: 1, storage })
    const after = recordWorkflowUsage('b', { now: 2, storage })
    expect(Object.keys(after).sort()).toEqual(['a', 'b'])
  })

  it('存的不是 JSON 就当没记过，不抛', () => {
    expect(readWorkflowUsage(fakeStorage({ [KEY]: '{坏了' }))).toEqual({})
    expect(readWorkflowUsage(fakeStorage({ [KEY]: '[1,2,3]' }))).toEqual({})
    expect(readWorkflowUsage(fakeStorage({ [KEY]: '' }))).toEqual({})
  })

  it('混进来的脏条目逐条丢掉，好的照留', () => {
    const raw = JSON.stringify({ ok: { count: 2, last: 9 }, bad: 3, worse: { count: 'x', last: 1 } })
    expect(readWorkflowUsage(fakeStorage({ [KEY]: raw }))).toEqual({ ok: { count: 2, last: 9 } })
  })

  it('没有 localStorage（node / 无痕模式）时读写都不炸', () => {
    expect(readWorkflowUsage(null)).toEqual({})
    expect(recordWorkflowUsage('a', { now: 5, storage: null })).toEqual({ a: { count: 1, last: 5 } })
  })

  it('落盘失败只是丢排序偏好，返回值照常给', () => {
    const storage: UsageStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceeded')
      },
    }
    expect(recordWorkflowUsage('a', { now: 7, storage })).toEqual({ a: { count: 1, last: 7 } })
  })

  it('条目封顶 200，超了先扔最久没用的', () => {
    const seed: Record<string, { count: number; last: number }> = {}
    for (let i = 0; i < 200; i += 1) seed[`old-${i}`] = { count: 1, last: i }
    const storage = fakeStorage({ [KEY]: JSON.stringify(seed) })
    const after = recordWorkflowUsage('fresh', { now: 10_000, storage })
    expect(Object.keys(after)).toHaveLength(200)
    expect(after.fresh).toEqual({ count: 1, last: 10_000 })
    expect(after['old-0']).toBeUndefined()
    expect(after['old-199']).toBeDefined()
  })
})
