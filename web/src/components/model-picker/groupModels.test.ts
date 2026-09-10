import { describe, expect, it } from 'vitest'

import type { DeploymentOption } from '@/lib/api-config'

import {
  filterGroups,
  flatten,
  groupByVendor,
  isNoiseGroup,
  matchRow,
  moveHighlight,
  toRows,
} from './groupModels'

let nextId = 1

function dep(model: string, account = 'gpt 中转', extra: Partial<DeploymentOption> = {}): DeploymentOption {
  return {
    id: nextId++,
    credential_id: 1,
    credential_name: account,
    provider_type: 'openai_compatible',
    upstream_model_id: model,
    display_name: null,
    adapter_type: 'openai',
    media_types: ['chat'],
    protocol_options: null,
    discovered: true,
    enabled: true,
    sort: 0,
    created_at: '',
    updated_at: '',
    ready: true,
    ...extra,
  } as DeploymentOption
}

describe('groupByVendor', () => {
  it('按厂商分组，不按凭据名——同一个中转下的六家模型要分开', () => {
    const groups = groupByVendor(
      toRows([dep('gpt-5.4'), dep('deepseek-v4-pro', '智谱中转'), dep('glm-5.2', '智谱中转')]),
    )
    expect(groups.map((g) => g.vendor.key)).toEqual(['openai', 'deepseek', 'zhipu'])
  })

  it('同一个模型在两个账号下各占一行，账号名分得开', () => {
    const groups = groupByVendor(
      toRows([dep('deepseek-v4-pro', 'DeepSeek 官方'), dep('deepseek-v4-pro', '智谱中转')]),
    )
    expect(groups).toHaveLength(1)
    expect(groups[0].rows.map((r) => r.account)).toEqual(['DeepSeek 官方', '智谱中转'])
  })

  it('组内新版本在前', () => {
    const groups = groupByVendor(toRows([dep('glm-4'), dep('glm-5.2'), dep('glm-4.7')]))
    expect(groups[0].rows.map((r) => r.deployment.upstream_model_id)).toEqual([
      'glm-5.2',
      'glm-4.7',
      'glm-4',
    ])
  })

  it('嵌入模型不再霸占第一屏——这正是现在这个弹窗的毛病', () => {
    const groups = groupByVendor(toRows([dep('embedding-3', '个人中转'), dep('gpt-5.4')]))
    expect(groups[0].vendor.key).toBe('openai')
    expect(isNoiseGroup(groups[groups.length - 1])).toBe(true)
  })

  it('认不出的厂商排在真厂商之后、非对话之前，且不被吞掉', () => {
    const groups = groupByVendor(toRows([dep('auto', 'gemini'), dep('embedding-3'), dep('gpt-5.4')]))
    expect(groups.map((g) => g.vendor.key)).toEqual(['openai', 'unknown', 'non-chat'])
  })
})

describe('matchRow', () => {
  const row = toRows([dep('deepseek-v4-pro', '智谱中转')])[0]

  it('空查询全通过', () => {
    expect(matchRow(row, '')).toBe(true)
    expect(matchRow(row, '   ')).toBe(true)
  })

  it('模型名、厂商中文名、厂商 key、账号名都能命中', () => {
    for (const q of ['deepseek', 'DeepSeek', 'v4-pro', '智谱']) {
      expect(matchRow(row, q)).toBe(true)
    }
  })

  it('空格分词要全部命中', () => {
    expect(matchRow(row, 'deepseek 智谱')).toBe(true)
    expect(matchRow(row, 'deepseek openai')).toBe(false)
  })

  it('不拿部署 id 做匹配——输数字命中一条无关模型是现在下拉的实际行为', () => {
    expect(matchRow(row, String(row.deployment.id))).toBe(false)
  })
})

describe('filterGroups', () => {
  it('过滤后空组整组消失，不留一个空标题', () => {
    const groups = groupByVendor(toRows([dep('gpt-5.4'), dep('glm-5.2', '智谱中转')]))
    const filtered = filterGroups(groups, 'glm')
    expect(filtered).toHaveLength(1)
    expect(filtered[0].vendor.key).toBe('zhipu')
  })

  it('空查询原样返回同一批组', () => {
    const groups = groupByVendor(toRows([dep('gpt-5.4')]))
    expect(filterGroups(groups, '')).toEqual(groups)
  })
})

describe('flatten', () => {
  it('扁平序列与渲染顺序一致，键盘才不会跳来跳去', () => {
    const groups = groupByVendor(toRows([dep('glm-4', '智谱中转'), dep('gpt-5.4'), dep('glm-5.2', '智谱中转')]))
    expect(flatten(groups).map((r) => r.deployment.upstream_model_id)).toEqual([
      'gpt-5.4',
      'glm-5.2',
      'glm-4',
    ])
  })
})

describe('moveHighlight', () => {
  it('没有候选时返回 -1', () => {
    expect(moveHighlight(-1, 1, 0)).toBe(-1)
  })

  it('未选中时按方向从两头进入', () => {
    expect(moveHighlight(-1, 1, 3)).toBe(0)
    expect(moveHighlight(-1, -1, 3)).toBe(2)
  })

  it('到头停住不绕回——长列表里绕回会让人以为列表没动', () => {
    expect(moveHighlight(2, 1, 3)).toBe(2)
    expect(moveHighlight(0, -1, 3)).toBe(0)
  })
})
