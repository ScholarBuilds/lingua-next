/* 生成日志弹窗的渲染冒烟。

   纯函数全绿而浏览器白屏，本仓吃过（节点定义的 `View` 写成非 getter 触发 TDZ）。
   这里把弹窗按四种态各真渲染一遍：空、加载、有数据、读取失败——
   导入环、初始化顺序、缺 provider 都会当场炸。

   本仓 vitest 跑在 node 环境（没有 jsdom），走 `renderToStaticMarkup`，
   只验结构与文案，验不了点击与滚动。`Overlay` 内部是 `createPortal`，
   服务端渲染跑不了，按仓里既有做法换成一层普通 div。 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import type { Binding, ModelDeployment, ModelInvocation } from '@/lib/api-config'
import type { StudioTask, StudioTaskStatus } from '@/lib/api-studio'

import { buildRunLog } from './run-log-model'

vi.mock('@/components/Overlay', () => ({
  Overlay: ({ children }: { children: ReactNode }) =>
    createElement('div', { className: 'overlay' }, children),
  useEscapeClose: () => undefined,
  useOverlayOpen: () => false,
  overlayDepth: () => 0,
}))

const { CanvasRunLog, DetailPanel } = await import('./CanvasRunLog')

const T0 = Date.parse('2026-08-23T10:00:00.000Z')
const CANVAS = 42

function task(over: Partial<StudioTask> = {}): StudioTask {
  return {
    id: 'task-1',
    domain: 'studio',
    tool_id: 'image-console',
    task_type: 'image.generate',
    parent_task_id: null,
    batch_id: null,
    source_route: '/studio/canvas/42',
    source_context: null,
    capability: 'image-free',
    deployment_id: 7,
    invocation: { prompt: '一只戴帽子的猫' },
    provider_task_id: null,
    canvas_id: CANVAS,
    node_id: 'n-1',
    execution_group_id: null,
    status: 'succeeded' as StudioTaskStatus,
    stage: null,
    progress: 1,
    result: { asset_ids: [11] },
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
    plugin_version: null,
    plugin_generation: null,
    runtime_generation: null,
    operation: 'image.generate',
    capability: 'image-free',
    deployment_id: 7,
    task_id: 'task-1',
    source: 'canvas',
    canvas_id: CANVAS,
    node_id: 'n-1',
    flow_run_id: null,
    tool_id: 'image-console',
    request: { prompt: 'a cat wearing a hat, cinematic' },
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
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    reasoning_tokens: null,
    context: null,
    created_at: new Date(T0).toISOString(),
    finished_at: new Date(T0 + 3900).toISOString(),
    ...over,
  }
}

const deployment: ModelDeployment = {
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
}

const bindings: Binding[] = [
  {
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
    deployment,
    ready_plugins: [],
    deployment_options: [],
  },
]

function render(seed: (client: QueryClient) => void): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['cfg-bindings'], bindings)
  client.setQueryData(['cfg-model-deployments'], [deployment])
  seed(client)
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(CanvasRunLog, { canvasId: CANVAS, onClose: () => undefined }),
    ),
  )
}

function withTasks(tasks: StudioTask[], invocations: ModelInvocation[] = []): string {
  return render((client) => {
    client.setQueryData(['canvas-run-log', CANVAS], { items: tasks })
    client.setQueryData(['canvas-run-log-invocations', CANVAS], {
      items: invocations,
      next_cursor: null,
    })
  })
}

describe('生成日志弹窗', () => {
  it('有记录时一行一条，能力显中文标签、模型位显上游真名', () => {
    const html = withTasks([task()], [invocation()])
    expect(html).toContain('生成日志')
    expect(html).toContain('免费插图')
    expect(html).toContain('gpt-image-2')
    // 能力 slug 不许出现在界面上（核心原则 6）
    expect(html).not.toContain('image-free')
    expect(html).toContain('4.2s')
  })

  it('还没跑过时给出空态而不是空白', () => {
    const html = withTasks([])
    expect(html).toContain('当前画布还没有生成日志')
    expect(html).not.toContain('<table')
  })

  it('筛选条与检索框始终在，空态下也在', () => {
    const html = withTasks([])
    expect(html).toContain('搜提示词、报错、模型、节点、任务 id')
    expect(html).toContain('按状态筛选')
    expect(html).toContain('按能力筛选')
    expect(html).toContain('按节点筛选')
    expect(html).toContain('按时间窗筛选')
  })

  it('失败态：行上直接露出报错，不用展开', () => {
    const html = withTasks([
      task({
        id: 'bad',
        status: 'failed',
        retryable: true,
        error: 'Upstream 429 Too Many Requests',
        result: null,
      }),
    ])
    expect(html).toContain('失败')
    expect(html).toContain('Upstream 429 Too Many Requests')
    expect(html).toContain('rlg-row-bad')
  })

  it('进行中的行标成进行中并给转圈样式', () => {
    const html = withTasks([task({ id: 'busy', status: 'running', result: null })])
    expect(html).toContain('rlg-status-active')
    expect(html).toContain('进行中')
  })

  it('首屏还在拉时给出读取中，不静默留白', () => {
    const html = render((client) => {
      client.setQueryData(['canvas-run-log-invocations', CANVAS], { items: [], next_cursor: null })
    })
    expect(html).toContain('正在读取日志…')
  })

  it('读取失败时说清是读取失败，不装成空态', async () => {
    /* 静态渲染跑不了副作用，失败态得先落进缓存再渲染。
       `prefetchQuery` 会吞掉 reject 并把 error 写进这一行。
       `retryOnMount: false` 是必须的：默认挂载即重试，react-query 会把这一帧
       乐观地压回 pending，静态渲染永远看不到错误分支。 */
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, retryOnMount: false } },
    })
    client.setQueryData(['cfg-bindings'], bindings)
    client.setQueryData(['cfg-model-deployments'], [deployment])
    client.setQueryData(['canvas-run-log-invocations', CANVAS], { items: [], next_cursor: null })
    await client.prefetchQuery({
      queryKey: ['canvas-run-log', CANVAS],
      queryFn: () => Promise.reject(new Error('连不上服务')),
      retry: false,
    })
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(CanvasRunLog, { canvasId: CANVAS, onClose: () => undefined }),
      ),
    )
    expect(html).toContain('读取失败：连不上服务')
    expect(html).not.toContain('当前画布还没有生成日志')
  })

  it('汇总条统计的是筛选后眼前这批', () => {
    const html = withTasks([
      task({ id: 'a' }),
      task({ id: 'b', status: 'failed', error: 'x', result: null }),
      task({ id: 'c', status: 'running', result: null }),
    ])
    expect(html).toContain('产物')
    expect(html).toContain('耗时中位')
  })

  it('未选中任何一行时不渲染详情面板', () => {
    const html = withTasks([task()], [invocation()])
    expect(html).not.toContain('rlg-detail')
    expect(html).toContain('rlg-body')
    expect(html).not.toContain('rlg-body-split')
  })

  it('长内容都关在自带滚动的容器里，表格自己横向滚', () => {
    const html = withTasks([task()], [invocation()])
    expect(html).toContain('rlg-table-wrap')
  })
})

/* 详情面板只有点中某一行才挂载，静态渲染点不了，所以单独渲染它。
   这一块是排查失败时信息最密集的地方，不能只靠「整体渲染没炸」兜底。 */
describe('详情面板', () => {
  function panel(tasks: StudioTask[], invocations: ModelInvocation[] = []): string {
    const rows = buildRunLog({ tasks, invocations, bindings, deployments: [deployment] })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(DetailPanel, {
          row: rows[0],
          onClose: () => undefined,
          onPick: () => undefined,
          onRefresh: () => undefined,
        }),
      ),
    )
  }

  it('头部的模型位是上游真名，能力只以中文标签露出', () => {
    const html = panel([task()], [invocation()])
    expect(html).toContain('gpt-image-2')
    expect(html).toContain('免费插图')
    expect(html).not.toContain('image-free')
  })

  it('六个页签都在，默认停在概览', () => {
    const html = panel([task()], [invocation()])
    for (const label of ['概览', '提示词', '请求', '产物', '时序', '原始']) {
      expect(html).toContain(label)
    }
    expect(html).toContain('rlg-tab-on')
  })

  it('失败任务：报错全文原样摆在概览第一屏，不截断也不折叠', () => {
    const stack = 'RunningHub 返回 500：'.concat('堆栈'.repeat(400))
    const html = panel([
      task({ status: 'failed', retryable: true, error: stack, result: null }),
    ])
    expect(html).toContain('失败原因')
    expect(html).toContain(stack)
    expect(html).toContain('rlg-pre-bad')
    expect(html).toContain('重试')
  })

  it('有重试族时列出每一次尝试', () => {
    const html = panel([
      task({ id: 'c', parent_task_id: 'b', created_at: new Date(T0 + 2000).toISOString() }),
      task({ id: 'b', parent_task_id: 'a', created_at: new Date(T0 + 1000).toISOString() }),
      task({ id: 'a', created_at: new Date(T0).toISOString(), status: 'failed', error: '超时' }),
    ])
    expect(html).toContain('重试历史')
    expect(html).toContain('共 3 次')
    expect(html).toContain('rlg-attempt-on')
  })

  it('单次任务不摆重试历史那一节', () => {
    expect(panel([task()])).not.toContain('重试历史')
  })

  it('概览把排查要用的标识一次给全', () => {
    const html = panel([task({ provider_task_id: 'mj-777', stage: 'submitting' })])
    expect(html).toContain('mj-777')
    expect(html).toContain('n-1')
    expect(html).toContain('image.generate')
  })
})
