/* 生成日志的纯计算。这块最容易悄悄写错的是两处：
   一是「模型」位退化路径（写错就会把能力 slug 摆到用户眼前，违反核心原则 6），
   二是筛选与检索的组合（写错只表现为「搜不到」，不报错）。两处都单独钉。 */

import { describe, expect, it } from 'vitest'

import type { Binding, ModelDeployment, ModelInvocation } from '@/lib/api-config'
import type { StudioTask, StudioTaskStatus } from '@/lib/api-studio'

import {
  ALL,
  EMPTY_FILTERS,
  UNKNOWN_MODEL_TEXT,
  buildRunLog,
  capabilityOptions,
  filterRunLog,
  formatClock,
  formatDuration,
  isFiltering,
  lineageRoots,
  nodeOptions,
  searchTerms,
  selectedRow,
  sentPromptOf,
  statusBucket,
  statusOptions,
  summarizeRunLog,
  taskFields,
  taskOutputs,
  taskPrompt,
  taskReferences,
  toggleSelection,
  windowOptions,
} from './run-log-model'

const T0 = Date.parse('2026-08-23T10:00:00.000Z')

function task(over: Partial<StudioTask> = {}): StudioTask {
  return {
    id: 'task-1',
    domain: 'studio',
    tool_id: 'image-console',
    task_type: 'image.generate',
    parent_task_id: null,
    batch_id: null,
    source_route: '/studio/canvas/1',
    source_context: null,
    capability: 'image-free',
    deployment_id: 7,
    invocation: null,
    provider_task_id: null,
    canvas_id: 1,
    node_id: 'n-1',
    execution_group_id: null,
    status: 'succeeded' as StudioTaskStatus,
    stage: null,
    progress: 1,
    result: null,
    error: null,
    retryable: false,
    created_at: new Date(T0).toISOString(),
    started_at: new Date(T0).toISOString(),
    heartbeat_at: null,
    finished_at: new Date(T0 + 4200).toISOString(),
    event_seq: 1,
    updated_at: new Date(T0 + 4200).toISOString(),
    ...over,
  }
}

function invocation(over: Partial<ModelInvocation> = {}): ModelInvocation {
  return {
    id: 'inv-1',
    plugin_id: 'openai',
    plugin_version: '1.0.0',
    plugin_generation: 1,
    runtime_generation: 1,
    operation: 'image.generate',
    capability: 'image-free',
    deployment_id: 7,
    task_id: 'task-1',
    source: 'canvas',
    canvas_id: 1,
    node_id: 'n-1',
    flow_run_id: null,
    tool_id: 'image-console',
    request: null,
    response: null,
    provider_request_id: null,
    model: 'gpt-image-2',
    status: 'succeeded',
    usage: null,
    latency_ms: 3900,
    first_token_ms: 620,
    error_type: null,
    error_message: null,
    error_code: null,
    parent_invocation_id: null,
    attempt: 1,
    input_tokens: 120,
    output_tokens: 300,
    cache_read_tokens: null,
    cache_write_tokens: null,
    reasoning_tokens: null,
    context: null,
    created_at: new Date(T0).toISOString(),
    finished_at: new Date(T0 + 3900).toISOString(),
    ...over,
  }
}

function deployment(over: Partial<ModelDeployment> = {}): ModelDeployment {
  return {
    id: 7,
    credential_id: 1,
    credential_name: 'openai',
    provider_type: 'openai',
    upstream_model_id: 'gpt-image-2',
    display_name: null,
    adapter_type: 'openai',
    media_types: ['image'],
    protocol_options: null,
    discovered: false,
    enabled: true,
    sort: 0,
    created_at: null,
    updated_at: null,
    ...over,
  }
}

function binding(over: Partial<Binding> = {}): Binding {
  return {
    capability: 'image-free',
    credential_id: 1,
    deployment_id: 7,
    follows_default: false,
    known: true,
    target: null,
    params: null,
    fallback: null,
    healthy: true,
    bound: true,
    label: '免费插图',
    description: '',
    group: 'image' as Binding['group'],
    media_type: 'image',
    operation: 'image.generate',
    test_kind: null,
    credential_name: 'openai',
    provider_type: 'openai',
    deployment: deployment(),
    ready_plugins: [],
    deployment_options: [],
    ...over,
  }
}

function build(over: {
  tasks?: StudioTask[]
  invocations?: ModelInvocation[]
  bindings?: Binding[]
  deployments?: ModelDeployment[]
} = {}) {
  return buildRunLog({
    tasks: over.tasks ?? [task()],
    invocations: over.invocations ?? [],
    bindings: over.bindings ?? [binding()],
    deployments: over.deployments ?? [deployment()],
  })
}

describe('模型位与能力位', () => {
  it('模型位优先显示台账记下的上游真名', () => {
    const [row] = build({ invocations: [invocation({ model: 'seedream-4.0' })] })
    expect(row.model).toBe('seedream-4.0')
  })

  it('没有台账行时退回任务冻结的部署', () => {
    const [row] = build({ deployments: [deployment({ upstream_model_id: 'doubao-seedream' })] })
    expect(row.model).toBe('doubao-seedream')
  })

  it('部署与绑定都查不到就如实说没有，绝不拿能力 slug 顶替', () => {
    const [row] = build({
      tasks: [task({ deployment_id: null, capability: 'image-free' })],
      bindings: [],
      deployments: [],
    })
    expect(row.model).toBe(UNKNOWN_MODEL_TEXT)
    expect(row.model).not.toContain('image-free')
  })

  it('能力位显示中文标签；绑定里没有就退回任务类型而不是 slug', () => {
    const [labeled] = build()
    expect(labeled.capabilityLabel).toBe('免费插图')

    const [bare] = build({ bindings: [] })
    expect(bare.capabilityLabel).toBe('image.generate')
    expect(bare.capabilityLabel).not.toBe('image-free')
  })
})

describe('提示词', () => {
  it('画布提交的提示词按 source_context → invocation → input → fields 依次取', () => {
    expect(taskPrompt(task({ source_context: { prompt: ' 一只猫 ' } }))).toBe('一只猫')
    expect(taskPrompt(task({ invocation: { idea: '一只狗' } }))).toBe('一只狗')
    expect(taskPrompt(task({ invocation: { fields: { positive_prompt: 'a fox' } } }))).toBe('a fox')
    expect(taskPrompt(task())).toBe('')
  })

  it('实际发出的提示词：Chat 取最后一条 user，生图取扁平 prompt', () => {
    expect(
      sentPromptOf({
        messages: [
          { role: 'system', content: '你是画师' },
          { role: 'user', content: '第一问' },
          { role: 'assistant', content: '答' },
          { role: 'user', content: '  第二问  ' },
        ],
      }),
    ).toBe('第二问')
    expect(sentPromptOf({ prompt: 'a cat on a roof' })).toBe('a cat on a roof')
    expect(sentPromptOf({ input: { positive_prompt: 'a dog' } })).toBe('a dog')
    expect(sentPromptOf(null)).toBe('')
  })

  it('多模态 content 数组只取其中的文字片段', () => {
    expect(
      sentPromptOf({
        messages: [
          { role: 'user', content: [{ type: 'image_url', image_url: {} }, { type: 'text', text: '改成夜景' }] },
        ],
      }),
    ).toBe('改成夜景')
  })

  it('发出去的和画布上填的不一致时标记为已改写', () => {
    const [row] = build({
      tasks: [task({ invocation: { prompt: '一只猫' } })],
      invocations: [invocation({ request: { prompt: 'a photorealistic cat, 8k' } })],
    })
    expect(row.sentPrompts).toHaveLength(1)
    expect(row.sentPrompts[0].rewritten).toBe(true)
    expect(row.sentPrompts[0].model).toBe('gpt-image-2')
  })

  it('一模一样就不标已改写', () => {
    const [row] = build({
      tasks: [task({ invocation: { prompt: '一只猫' } })],
      invocations: [invocation({ request: { prompt: '一只猫' } })],
    })
    expect(row.sentPrompts[0].rewritten).toBe(false)
  })
})

describe('产物、参考图与参数', () => {
  it('产物合并 items / outputs / urls / asset_ids 并按 url 去重', () => {
    const outputs = taskOutputs(
      task({
        result: {
          items: [{ asset_id: 11 }],
          urls: ['/media/a.mp4', '/media/a.mp4'],
          asset_ids: [11, '12'],
        },
      }),
    )
    expect(outputs.map((item) => item.url)).toEqual([
      '/api/images/assets/11/display',
      '/media/a.mp4',
      '/api/images/assets/12/display',
    ])
    expect(outputs.map((item) => item.kind)).toEqual(['image', 'video', 'image'])
  })

  it('参考图覆盖三条链路的键名，并带上中文说明', () => {
    const refs = taskReferences(
      task({
        invocation: {
          ref_asset_ids: [3, 4],
          mask_asset_id: 9,
          media_references: [{ url: '/media/ref.png' }],
        },
      }),
    )
    expect(refs.map((item) => [item.label, item.url])).toEqual([
      ['参考图', '/api/images/assets/3/display'],
      ['参考图', '/api/images/assets/4/display'],
      ['参考素材', '/media/ref.png'],
      ['遮罩', '/api/images/assets/9/display'],
    ])
  })

  it('参数表剔掉已经单独露过的提示词与参考图，也剔掉工具快照', () => {
    const fields = taskFields(
      task({
        invocation: {
          prompt: '一只猫',
          ref_asset_ids: [3],
          _tool_runtime: { plugin: 'x' },
          size: '1024x1024',
          n: 2,
          options: { seed: 1 },
          empty: [],
          nothing: null,
        },
      }),
    )
    expect(fields.map((item) => item.key)).toEqual(['n', 'options', 'size'])
    expect(fields.find((item) => item.key === 'options')?.value).toBe('{"seed":1}')
  })
})

describe('重试族', () => {
  const chain = [
    task({ id: 'a', created_at: new Date(T0).toISOString(), status: 'failed', error: '上游超时' }),
    task({ id: 'b', parent_task_id: 'a', created_at: new Date(T0 + 1000).toISOString(), status: 'failed' }),
    task({ id: 'c', parent_task_id: 'b', created_at: new Date(T0 + 2000).toISOString() }),
    task({ id: 'z', created_at: new Date(T0 + 3000).toISOString() }),
  ]

  it('沿 parent_task_id 归到同一个根', () => {
    const roots = lineageRoots(chain)
    expect(roots.get('c')).toBe('a')
    expect(roots.get('b')).toBe('a')
    expect(roots.get('z')).toBe('z')
  })

  it('父任务不在这批里时以自己为根，不丢行', () => {
    const roots = lineageRoots([task({ id: 'orphan', parent_task_id: 'gone' })])
    expect(roots.get('orphan')).toBe('orphan')
  })

  it('链上有环也不死循环', () => {
    const roots = lineageRoots([
      task({ id: 'x', parent_task_id: 'y' }),
      task({ id: 'y', parent_task_id: 'x' }),
    ])
    expect(roots.size).toBe(2)
  })

  it('行上带出第几次尝试与整条族谱', () => {
    const rows = build({ tasks: chain })
    const third = rows.find((row) => row.id === 'c')
    expect(third?.attempt).toBe(3)
    expect(third?.lineage).toEqual(['a', 'b', 'c'])
    expect(rows.find((row) => row.id === 'z')?.lineage).toEqual(['z'])
  })
})

describe('筛选与检索', () => {
  const rows = build({
    tasks: [
      task({
        id: 'ok',
        node_id: 'n-1',
        invocation: { prompt: '一只戴帽子的猫' },
        created_at: new Date(T0).toISOString(),
      }),
      task({
        id: 'bad',
        node_id: 'n-2',
        capability: 'video-generate',
        status: 'failed',
        error: 'Upstream 429 Too Many Requests',
        created_at: new Date(T0 - 3 * 60 * 60_000).toISOString(),
      }),
      task({
        id: 'busy',
        node_id: 'n-2',
        status: 'running',
        created_at: new Date(T0 - 60_000).toISOString(),
      }),
    ],
    invocations: [invocation({ id: 'i1', task_id: 'ok', model: 'seedream-4.0' })],
  })
  const now = T0 + 1000

  it('状态按桶筛，未收口的都算进行中', () => {
    expect(statusBucket('submitting')).toBe('active')
    const active = filterRunLog(rows, { ...EMPTY_FILTERS, status: 'active' }, now)
    expect(active.map((row) => row.id)).toEqual(['busy'])
    const failed = filterRunLog(rows, { ...EMPTY_FILTERS, status: 'failed' }, now)
    expect(failed.map((row) => row.id)).toEqual(['bad'])
  })

  it('按能力与节点筛', () => {
    expect(
      filterRunLog(rows, { ...EMPTY_FILTERS, capability: 'video-generate' }, now).map((r) => r.id),
    ).toEqual(['bad'])
    expect(filterRunLog(rows, { ...EMPTY_FILTERS, node: 'n-2' }, now).map((r) => r.id)).toEqual([
      'busy',
      'bad',
    ])
  })

  it('时间窗只留最近这一段', () => {
    expect(filterRunLog(rows, { ...EMPTY_FILTERS, window: '15m' }, now).map((r) => r.id)).toEqual([
      'ok',
      'busy',
    ])
    expect(filterRunLog(rows, { ...EMPTY_FILTERS, window: '24h' }, now)).toHaveLength(3)
  })

  it('全文检索覆盖提示词、报错与模型真名，且大小写不敏感', () => {
    expect(filterRunLog(rows, { ...EMPTY_FILTERS, search: '帽子' }, now).map((r) => r.id)).toEqual([
      'ok',
    ])
    expect(filterRunLog(rows, { ...EMPTY_FILTERS, search: '429' }, now).map((r) => r.id)).toEqual([
      'bad',
    ])
    expect(
      filterRunLog(rows, { ...EMPTY_FILTERS, search: 'SEEDREAM' }, now).map((r) => r.id),
    ).toEqual(['ok'])
  })

  it('多个检索词是且的关系', () => {
    expect(searchTerms('  upstream   429 ')).toEqual(['upstream', '429'])
    expect(
      filterRunLog(rows, { ...EMPTY_FILTERS, search: 'upstream 429' }, now).map((r) => r.id),
    ).toEqual(['bad'])
    expect(filterRunLog(rows, { ...EMPTY_FILTERS, search: 'upstream 帽子' }, now)).toHaveLength(0)
  })

  it('筛选条件叠加', () => {
    const hit = filterRunLog(
      rows,
      { ...EMPTY_FILTERS, status: 'failed', node: 'n-2', search: 'requests' },
      now,
    )
    expect(hit.map((row) => row.id)).toEqual(['bad'])
  })

  it('默认条件不算在筛选中，改了任意一项才算', () => {
    expect(isFiltering(EMPTY_FILTERS)).toBe(false)
    expect(isFiltering({ ...EMPTY_FILTERS, search: 'a' })).toBe(true)
    expect(isFiltering({ ...EMPTY_FILTERS, node: 'n-1' })).toBe(true)
  })

  it('列表按时间倒序，最新的在最上面', () => {
    expect(rows.map((row) => row.id)).toEqual(['ok', 'busy', 'bad'])
  })
})

describe('筛选项候选值', () => {
  const rows = build({
    tasks: [task({ id: 'a' }), task({ id: 'b', status: 'failed', node_id: 'n-9' })],
  })

  it('候选值从眼前这批行长出来，并带上条数', () => {
    expect(statusOptions(rows).map((item) => item.value)).toEqual([ALL, 'succeeded', 'failed'])
    expect(statusOptions(rows)[0].label).toBe('全部 2')
    expect(nodeOptions(rows).map((item) => item.value)).toEqual([ALL, 'n-1', 'n-9'])
    expect(capabilityOptions(rows).map((item) => item.label)).toEqual(['全部能力', '免费插图'])
  })

  it('已经选中的值即使数据里没有了也留在候选里，避免触发器变空', () => {
    expect(statusOptions(rows, 'cancelled').map((item) => item.value)).toContain('cancelled')
    expect(nodeOptions(rows, 'n-404').map((item) => item.value)).toContain('n-404')
    expect(capabilityOptions(rows, 'ghost').map((item) => item.value)).toContain('ghost')
  })

  it('时间窗候选是固定的四档加不限', () => {
    expect(windowOptions().map((item) => item.value)).toEqual([ALL, '15m', '1h', '6h', '24h'])
  })
})

describe('行的展开模型', () => {
  const rows = build({ tasks: [task({ id: 'a' }), task({ id: 'b' })] })

  it('点当前行收起，点别的行换过去', () => {
    expect(toggleSelection(null, 'a')).toBe('a')
    expect(toggleSelection('a', 'a')).toBeNull()
    expect(toggleSelection('a', 'b')).toBe('b')
  })

  it('选中的行被筛掉后当作没选中，不留一个孤零零的详情', () => {
    expect(selectedRow(rows, 'a')?.id).toBe('a')
    expect(selectedRow(rows, 'gone')).toBeNull()
    expect(selectedRow(rows, null)).toBeNull()
    const onlyB = filterRunLog(rows, { ...EMPTY_FILTERS, search: 'b' }, T0 + 1)
    expect(selectedRow(onlyB, 'a')).toBeNull()
  })
})

describe('汇总与格式', () => {
  it('计数与耗时中位数只看眼前这批行', () => {
    const rows = build({
      tasks: [
        task({ id: 'a', finished_at: new Date(T0 + 1000).toISOString() }),
        task({ id: 'b', finished_at: new Date(T0 + 5000).toISOString() }),
        task({ id: 'c', status: 'failed', error: 'x', finished_at: new Date(T0 + 9000).toISOString() }),
        task({ id: 'd', status: 'running', finished_at: null, updated_at: null }),
      ],
    })
    const summary = summarizeRunLog(rows)
    expect(summary).toMatchObject({ total: 4, succeeded: 2, failed: 1, active: 1 })
    expect(summary.medianMs).toBe(5000)
  })

  it('一条都没收口时中位数留空而不是 0', () => {
    const rows = build({ tasks: [task({ status: 'running', finished_at: null, updated_at: null })] })
    expect(summarizeRunLog(rows).medianMs).toBeNull()
  })

  it('墙钟耗时按量级换单位', () => {
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(420)).toBe('420ms')
    expect(formatDuration(4200)).toBe('4.2s')
    expect(formatDuration(42_000)).toBe('42s')
    expect(formatDuration(184_000)).toBe('3m 04s')
  })

  it('时间解不动时给横杠，不渲染成 Invalid Date', () => {
    expect(formatClock(null)).toBe('—')
    expect(formatClock(Number.NaN)).toBe('—')
    expect(formatClock(T0, T0)).not.toContain('Invalid')
  })

  it('created_at 缺失的行照样成行，不被时间窗静默吞掉', () => {
    const rows = build({ tasks: [task({ id: 'nodate', created_at: null })] })
    expect(rows[0].createdMs).toBeNull()
    expect(filterRunLog(rows, { ...EMPTY_FILTERS, window: '15m' }, T0)).toHaveLength(1)
  })
})
