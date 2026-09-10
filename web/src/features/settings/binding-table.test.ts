/* 绑定表的纯逻辑：部署筛选（媒体类型 / 接线 / 直连优先 / 网关标注）、
   降级链顺序编辑、测一下结果文案、翻译链解析。 */

import { describe, expect, it } from 'vitest'

import type {
  Binding,
  FallbackEntry,
  LlmProbeResult,
  ModelDeployment,
  ModelPlugin,
} from '@/lib/api-config'

import {
  adapterOf,
  appendFallback,
  choiceOfFallback,
  deploymentChoices,
  describeProbe,
  fallbackOf,
  moveEntry,
  parseChain,
  preferredChoice,
  removeEntry,
  rowsForGroups,
} from './BindingTable'

function plugin(
  id: string,
  ready: string[],
  execution: ModelPlugin['execution'] = 'direct',
): ModelPlugin {
  return {
    id,
    name: `${id} 插件`,
    version: '1.0.0',
    description: '',
    media_types: ['chat', 'image'],
    operations: ready,
    ready_operations: ready,
    ready_media_types: [...new Set(ready.map((op) => op.split('.')[0]))],
    provider_types: [],
    execution,
    priority: 0,
  }
}

function deployment(
  id: number,
  model: string,
  adapter: string,
  media: string[],
  overrides: Partial<ModelDeployment> = {},
): ModelDeployment {
  return {
    id,
    credential_id: 3,
    credential_name: 'gpt 中转',
    provider_type: 'openai_compatible',
    upstream_model_id: model,
    display_name: null,
    adapter_type: adapter,
    media_types: media,
    protocol_options: null,
    discovered: true,
    enabled: true,
    sort: 0,
    created_at: null,
    updated_at: null,
    ...overrides,
  }
}

const PLUGINS = [
  plugin('openai', ['chat.complete', 'chat.stream', 'image.generate']),
  plugin('codex', []), // 声明了但没接线
]

// 真库里还留着一批 adapter 已退役的孤儿部署（插件清单里查无此 adapter），
// 它们与正常部署同名、id 更小，一条都不该出现在可选列表里
const DEPLOYMENTS = [
  deployment(20, 'gpt-5.4-mini', 'litellm', ['chat']),
  deployment(28, 'gpt-image-2', 'litellm', ['image']),
  deployment(35, 'gpt-5.4-mini', 'openai', ['chat']),
  deployment(43, 'gpt-image-2', 'openai', ['image']),
  deployment(50, 'gpt-5.4', 'openai', ['chat'], { enabled: false }),
  deployment(51, 'gpt-5.5', 'codex', ['chat']),
  deployment(61, 'deepseek-chat', 'openai', ['chat'], {
    credential_id: 1,
    credential_name: 'DeepSeek 官方',
    provider_type: 'deepseek',
  }),
]

const CHAT_ROW = { media_type: 'chat', operation: 'chat.complete' }
const IMAGE_ROW = { media_type: 'image', operation: 'image.generate' }

describe('deploymentChoices', () => {
  it('只留该能力媒体类型、已启用、adapter 已接线的部署', () => {
    const ids = deploymentChoices(CHAT_ROW, DEPLOYMENTS, PLUGINS).map((c) => c.deployment.id)
    expect(ids).not.toContain(28) // image 媒体
    expect(ids).not.toContain(43)
    expect(ids).not.toContain(50) // 已停用
    expect(ids).not.toContain(51) // codex 未接线
    // 按凭据名排序：DeepSeek 官方在 gpt 中转前面
    expect(ids).toEqual([61, 35])
    expect(deploymentChoices(IMAGE_ROW, DEPLOYMENTS, PLUGINS).map((c) => c.deployment.id)).toEqual(
      [43],
    )
  })

  it('adapter 已退役（插件清单里没有）的部署一条都不出现', () => {
    const choices = deploymentChoices(CHAT_ROW, DEPLOYMENTS, PLUGINS)
    expect(choices.map((c) => c.deployment.adapter_type)).not.toContain('litellm')
    const mini = choices.filter((c) => c.deployment.upstream_model_id === 'gpt-5.4-mini')
    expect(mini.map((c) => c.deployment.id)).toEqual([35])
  })

  it('排序稳定：先凭据、再模型名，同一批数据每次顺序一样', () => {
    const once = deploymentChoices(CHAT_ROW, DEPLOYMENTS, PLUGINS).map((c) => c.deployment.id)
    const twice = deploymentChoices(CHAT_ROW, [...DEPLOYMENTS].reverse(), PLUGINS).map(
      (c) => c.deployment.id,
    )
    expect(twice).toEqual(once)
  })

  it('翻译链这种没有媒体类型的能力没有部署可选', () => {
    expect(deploymentChoices({ media_type: null, operation: null }, DEPLOYMENTS, PLUGINS)).toEqual(
      [],
    )
  })

  it('手输模型名按凭据 + 模型名命中已登记部署，不会撞上退役 adapter 的同名行（V1 回归）', () => {
    const choices = deploymentChoices(CHAT_ROW, DEPLOYMENTS, PLUGINS)
    expect(preferredChoice(choices, 3, 'gpt-5.4-mini')?.deployment.id).toBe(35)
    expect(preferredChoice(choices, 1, 'deepseek-chat')?.deployment.id).toBe(61)
    expect(preferredChoice(choices, null, 'gpt-5.4-mini')).toBeUndefined()
    expect(preferredChoice(choices, 3, 'nope')).toBeUndefined()
  })

  it('adapterOf 认得的用插件名，不认得的原样透出 adapter 键', () => {
    expect(adapterOf('openai', PLUGINS)).toEqual({ adapterName: 'openai 插件' })
    expect(adapterOf('litellm', PLUGINS)).toEqual({ adapterName: 'litellm' })
    expect(adapterOf('mystery', PLUGINS)).toEqual({ adapterName: 'mystery' })
  })
})

describe('降级链编辑', () => {
  const a: FallbackEntry = { deployment_id: 35, credential_id: 3, target: 'gpt-5.4-mini' }
  const b: FallbackEntry = { deployment_id: 61, credential_id: 1, target: 'deepseek-chat' }
  const legacy: FallbackEntry = { credential_id: 3, target: 'gpt-5.4-mini' }

  it('上移 / 下移交换相邻项，越界原样返回且不改原数组', () => {
    const list = [a, b]
    expect(moveEntry(list, 1, -1)).toEqual([b, a])
    expect(moveEntry(list, 0, 1)).toEqual([b, a])
    expect(moveEntry(list, 0, -1)).toBe(list)
    expect(moveEntry(list, 1, 1)).toBe(list)
    expect(list).toEqual([a, b])
  })

  it('移除按下标，追加按部署去重，旧式项按凭据 + 模型名去重', () => {
    expect(removeEntry([a, b], 0)).toEqual([b])
    expect(appendFallback([a], b)).toEqual([a, b])
    expect(appendFallback([a, b], a)).toEqual([a, b])
    expect(appendFallback([legacy], { credential_id: 3, target: 'gpt-5.4-mini' })).toEqual([legacy])
    expect(appendFallback([legacy], { credential_id: 3, target: 'gpt-5.4' })).toHaveLength(2)
  })

  it('从选择生成的降级项同时带 deployment_id 与凭据 + 模型名，旧式项也能回查到直连部署', () => {
    const choices = deploymentChoices(CHAT_ROW, DEPLOYMENTS, PLUGINS)
    const direct = choices.find((c) => c.deployment.id === 35)!
    expect(fallbackOf(direct)).toEqual(a)
    expect(choiceOfFallback(a, choices)?.deployment.id).toBe(35)
    expect(choiceOfFallback(legacy, choices)?.deployment.id).toBe(35)
    expect(choiceOfFallback({ credential_id: 9, target: 'x' }, choices)).toBeUndefined()
  })
})

describe('describeProbe', () => {
  const base: LlmProbeResult = {
    ok: true,
    capability: 'explain-standard',
    model: 'gpt-5.4-mini',
    plugin_id: 'openai',
    selection_source: 'binding',
    deployment_id: 35,
    transport: 'openai-chat',
    latency_ms: 1420,
    sample: 'pong — the quick brown fox jumps',
    usage: null,
    error_type: null,
    error: null,
  }

  it('成功：耗时、插件/模型、截断样例，完整样例挂 title', () => {
    const view = describeProbe(base)
    expect(view.tone).toBe('ok')
    expect(view.text).toContain('1.4s')
    expect(view.text).toContain('openai / gpt-5.4-mini')
    expect(view.text).toContain('“pong — the qui…”')
    expect(view.title).toBe(base.sample)
  })

  it('失败：错误分类 + 路由；路由都没解析出来时说明', () => {
    const failed = describeProbe({ ...base, ok: false, error_type: 'auth', error: 'HTTP 401' })
    expect(failed.tone).toBe('warn')
    expect(failed.text).toBe('鉴权失败 · openai / gpt-5.4-mini')
    expect(failed.title).toBe('HTTP 401')
    const unresolved = describeProbe({
      ...base,
      ok: false,
      plugin_id: null,
      model: null,
      error_type: 'route',
      error: '能力未绑定',
    })
    expect(unresolved.text).toBe('路由未解析')
    expect(unresolved.title).toBe('能力未绑定')
  })

  it('没测过不显示，请求本身失败给提示', () => {
    expect(describeProbe(undefined).tone).toBe('none')
    expect(describeProbe(undefined, true)).toEqual({ tone: 'warn', text: '测试请求失败' })
  })
})

describe('rowsForGroups / parseChain', () => {
  it('按给定分组顺序切分，分组内保持服务端顺序', () => {
    const row = (capability: string, group: Binding['group']) =>
      ({ capability, group }) as unknown as Binding
    const rows = [
      row('translate-fast', 'llm'),
      row('tts-word', 'voice'),
      row('image-free', 'image'),
      row('explain-standard', 'llm'),
    ]
    const sections = rowsForGroups(rows, ['image', 'llm'])
    expect(sections.map((s) => s.group)).toEqual(['image', 'llm'])
    expect(sections[1].rows.map((r) => r.capability)).toEqual(['translate-fast', 'explain-standard'])
    expect(rowsForGroups(rows, ['realtime'])[0].rows).toEqual([])
  })

  it('翻译链兼容两种形状，缺的引擎补成停用，空值回默认', () => {
    expect(parseChain({ chain: ['google', 'llm'] })).toEqual([
      { engine: 'google', enabled: true },
      { engine: 'llm', enabled: true },
      { engine: 'bing', enabled: false },
    ])
    expect(parseChain({ chain: [{ engine: 'bing', enabled: false }, { engine: 'llm' }] })).toEqual([
      { engine: 'bing', enabled: false },
      { engine: 'llm', enabled: true },
      { engine: 'google', enabled: false },
    ])
    expect(parseChain(null).map((r) => r.engine)).toEqual(['llm', 'google', 'bing'])
  })
})
