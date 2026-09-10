/* 模型部署层纯逻辑：媒体对账、草稿校验、按凭据分组、协议选项读写。 */

import { describe, expect, it } from 'vitest'

import type { ModelDeployment, ModelPlugin } from '@/lib/api-config'

import {
  adapterForProviderType,
  buildProtocolOptions,
  deploymentStats,
  effectiveImageMode,
  filterDeployments,
  groupDeployments,
  protocolFieldValues,
  readyMediaOf,
  supportsImageProtocol,
  unsupportedMediaOf,
  validateDeploymentDraft,
} from './deployments'

function plugin(
  id: string,
  media: string[],
  ready: string[],
  providerTypes: string[] = [],
): ModelPlugin {
  return {
    id,
    name: `${id} 插件`,
    version: '1.0.0',
    description: '',
    media_types: media,
    operations: [],
    ready_operations: [],
    ready_media_types: ready,
    provider_types: providerTypes,
    execution: 'direct',
    priority: 0,
  }
}

const PLUGINS = [
  plugin('openai', ['chat', 'image'], ['chat', 'image'], ['openai', 'openai_compatible']),
  plugin('gemini', ['image'], ['image'], ['gemini_image']),
  // 声明支持视频但执行层还没接线
  plugin('tudou', ['image', 'video'], ['image'], ['tudou']),
]

function deployment(
  id: number,
  model: string,
  overrides: Partial<ModelDeployment> = {},
): ModelDeployment {
  return {
    id,
    credential_id: 3,
    credential_name: 'gpt 中转',
    provider_type: 'openai_compatible',
    upstream_model_id: model,
    display_name: null,
    adapter_type: 'openai',
    media_types: ['chat'],
    protocol_options: null,
    discovered: true,
    enabled: true,
    sort: 0,
    created_at: null,
    updated_at: null,
    ...overrides,
  }
}

describe('adapterForProviderType', () => {
  it('按 provider_types 反查，认不出按 OpenAI 兼容兜底', () => {
    expect(adapterForProviderType(PLUGINS, 'gemini_image')).toBe('gemini')
    expect(adapterForProviderType(PLUGINS, 'openai_compatible')).toBe('openai')
    expect(adapterForProviderType(PLUGINS, '来路不明')).toBe('openai')
  })
})

describe('readyMediaOf / unsupportedMediaOf', () => {
  it('声明支持但没接线的媒体不算已接入', () => {
    expect(readyMediaOf(PLUGINS, 'tudou', ['image', 'video'])).toEqual(['image'])
    expect(unsupportedMediaOf(PLUGINS, 'tudou', ['image', 'video'])).toEqual([])
  })

  it('adapter 压根不支持的媒体要报出来', () => {
    expect(unsupportedMediaOf(PLUGINS, 'gemini', ['chat', 'image'])).toEqual(['chat'])
  })

  it('未知 adapter 不误报（插件清单没加载完时不能把表单锁死）', () => {
    expect(unsupportedMediaOf(PLUGINS, '还没出现的插件', ['chat'])).toEqual([])
    expect(readyMediaOf(PLUGINS, '还没出现的插件', ['chat'])).toEqual([])
  })
})

describe('validateDeploymentDraft', () => {
  const ok = { credentialId: 3, model: 'gpt-image-2', adapter: 'openai', mediaTypes: ['image'] }

  it('三层递进的前提：没凭据就没有部署', () => {
    expect(validateDeploymentDraft({ ...ok, credentialId: null }, PLUGINS)).toBe('先选一条供应商凭据')
  })

  it('模型名与媒体能力必填', () => {
    expect(validateDeploymentDraft({ ...ok, model: '   ' }, PLUGINS)).toBe(
      '填写供应商那边的真实模型名',
    )
    expect(validateDeploymentDraft({ ...ok, mediaTypes: [] }, PLUGINS)).toBe('至少勾选一种媒体能力')
  })

  it('adapter 不支持勾上的媒体类型时保存前就拦住', () => {
    expect(validateDeploymentDraft({ ...ok, adapter: 'gemini', mediaTypes: ['chat'] }, PLUGINS)).toBe(
      'gemini 插件 不支持对话，换适配器或去掉这些能力',
    )
  })

  it('合法草稿返回 null', () => {
    expect(validateDeploymentDraft(ok, PLUGINS)).toBeNull()
  })
})

describe('groupDeployments', () => {
  const rows = [
    deployment(2, 'zzz-model', { credential_id: 9, credential_name: '智谱中转' }),
    deployment(1, 'aaa-model', { enabled: false }),
    deployment(3, 'bbb-model'),
    deployment(4, 'ccc-model', { credential_id: 9, credential_name: '智谱中转', enabled: false }),
  ]

  it('按凭据归堆，堆序与凭据卡片一致（credential_id 升序），堆内启用的排前面', () => {
    const groups = groupDeployments(rows)
    expect(groups.map((g) => g.credentialId)).toEqual([3, 9])
    expect(groups.map((g) => g.credentialName)).toEqual(['gpt 中转', '智谱中转'])
    expect(groups[0].rows.map((r) => r.upstream_model_id)).toEqual(['bbb-model', 'aaa-model'])
    expect(groups[0].enabledCount).toBe(1)
  })

  it('凭据名以凭据列表为准（部署行上的名字可能是旧快照）', () => {
    const groups = groupDeployments(rows, [
      {
        id: 3,
        name: 'gpt 中转（新名）',
        kind: 'llm',
        provider_type: 'openai_compatible',
        enabled: true,
        status: 'ok',
        status_detail: null,
        last_tested_at: null,
        masked: {},
        models: [],
        models_count: 0,
        models_refreshed_at: null,
      },
    ])
    expect(groups[0].credentialName).toBe('gpt 中转（新名）')
  })

  it('空列表不产生空分组', () => {
    expect(groupDeployments([])).toEqual([])
  })
})

describe('filterDeployments', () => {
  const rows = [
    deployment(1, 'gpt-image-2'),
    deployment(2, 'glm-4.6', { display_name: '智谱旗舰', credential_name: '智谱中转' }),
  ]

  it('模型名 / 显示名 / 凭据名都能命中，大小写不敏感', () => {
    expect(filterDeployments(rows, 'IMAGE').map((r) => r.id)).toEqual([1])
    expect(filterDeployments(rows, '智谱').map((r) => r.id)).toEqual([2])
    expect(filterDeployments(rows, '  ')).toHaveLength(2)
    expect(filterDeployments(rows, '查无此模型')).toHaveLength(0)
  })
})

describe('deploymentStats', () => {
  it('数出启用数、凭据数与没接线的孤儿部署', () => {
    const rows = [
      deployment(1, 'a'),
      deployment(2, 'b', { enabled: false }),
      // adapter 不在插件清单里 = 绑定表永远选不出来
      deployment(3, 'c', { credential_id: 9, adapter_type: '退役网关' }),
    ]
    expect(deploymentStats(rows, PLUGINS)).toEqual({
      total: 3,
      enabled: 2,
      credentials: 2,
      unwired: 1,
    })
  })
})

describe('调用协议', () => {
  it('apimart / tudou 的请求模式固定，不听表单的', () => {
    expect(effectiveImageMode('apimart', 'openai')).toBe('apimart')
    expect(effectiveImageMode('tudou', 'openai')).toBe('tudou-async')
    expect(effectiveImageMode('openai', 'openai-responses')).toBe('openai-responses')
  })

  it('只有图片线的这几个 adapter 需要协议表单', () => {
    expect(supportsImageProtocol('openai', ['image'])).toBe(true)
    expect(supportsImageProtocol('openai', ['chat'])).toBe(false)
    expect(supportsImageProtocol('gemini', ['image'])).toBe(false)
  })

  it('空串一律删键，全空返回 null（不往库里塞空对象）', () => {
    expect(
      buildProtocolOptions(null, 'gemini', 'openai', { generation_path: '', poll_interval: '' }),
    ).toBeNull()
    expect(
      buildProtocolOptions({ image_request_mode: 'openai' }, 'gemini', 'openai', {}),
    ).toBeNull()
  })

  it('数字字段转成数字，非数字直接丢弃', () => {
    expect(
      buildProtocolOptions(null, 'openai', 'tudou-async', {
        generation_path: '/images/generations/async',
        poll_interval: '4',
        task_timeout: '不是数字',
      }),
    ).toEqual({
      image_request_mode: 'tudou-async',
      generation_path: '/images/generations/async',
      poll_interval: 4,
    })
  })

  it('库里存的数字读回表单是字符串，缺的键是空串', () => {
    expect(protocolFieldValues({ poll_interval: 4, generation_path: '/x' })).toMatchObject({
      poll_interval: '4',
      generation_path: '/x',
      responses_path: '',
    })
    expect(protocolFieldValues(null).task_timeout).toBe('')
  })

  it('不认识的既有键原样保留（服务端后加的协议参数不能被前端抹掉）', () => {
    expect(
      buildProtocolOptions({ 未来参数: 1 }, 'openai', 'openai', {}),
    ).toEqual({ 未来参数: 1, image_request_mode: 'openai' })
  })
})
