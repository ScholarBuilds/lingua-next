/* 失败重试与工作流产物的服务端收口（调研 §2.6 · 合同 T1）。

   钉两件事：
   - retryCascadeFrom 在失败节点没有 cascade_run_id 时，不再走浏览器串行执行器，
     而是把失败节点起的子链按失败轮重新编译成服务端 DAG 提交；提交失败提示重新发起级联。
   - landWorkflowTask 对带 canvas_id 的工作流任务只记完成态与时间线结果，
     产物 output 节点交给服务端 projector（定值 id），本地不再新建；旧任务保持旧行为。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { apiConfig } from '../../lib/api-config'
import { apiStudio, asFlowToolNode } from '../../lib/api-studio'
import type { CanvasConnection, StudioFlowRun, StudioTask } from '../../lib/api-studio'
import {
  landWorkflowTask,
  retryCascadeFrom,
  useCanvasStore,
  type ScvNode,
} from './canvasStore'

const { toastError, toastInfo, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: { error: toastError, info: toastInfo, success: toastSuccess },
}))

vi.mock('./taskEvents', () => ({
  subscribeTaskEvents: () => () => {},
  subscribeFlowEvents: () => () => {},
  subscribeCanvasEvents: () => () => {},
  onTaskStreamConnected: () => () => {},
}))

vi.mock('../../lib/chime', () => ({
  chime: vi.fn(),
  chimeEnabled: () => false,
  setChimeEnabled: () => {},
}))

function runOf(
  body: Parameters<typeof apiStudio.runInlineFlow>[0],
  status: StudioFlowRun['status'],
): StudioFlowRun {
  return {
    id: 'retry-run',
    flow_id: null,
    parent_run_id: null,
    flow_version: 1,
    status,
    error: status === 'failed' ? '第一节点失败' : null,
    inputs: body.inputs ?? {},
    source_context: body.source_context ?? {},
    checkpoint: {
      version: 1,
      nodes: Object.fromEntries(body.definition.nodes.map((node, index) => [node.id, {
        status: status === 'failed' && index === 0 ? 'failed' : 'pending',
        task_id: null,
        attempt: 0,
        result: null,
        error: status === 'failed' && index === 0 ? '第一节点失败' : null,
      }])),
    },
    progress: 0,
    created_at: null,
    started_at: null,
    heartbeat_at: null,
    finished_at: null,
    updated_at: null,
  }
}

/** 失败链画布：source →(input) mid →(input) tail，mid 挂着旧执行器留下的失败态 */
function seedRetryCanvas(midExtra: Partial<ScvNode> = {}): void {
  const nodes: ScvNode[] = [
    { id: 'source', type: 'image', x: 0, y: 0, items: [{ kind: 'image', asset_id: 31 }] },
    {
      id: 'mid',
      type: 'image',
      x: 400,
      y: 0,
      prompt_draft: '中间修饰',
      cascade_status: 'failed',
      cascade_error: 'boom',
      cascade_failed_round: 2,
      cascade_total: 3,
      cascade_loop_id: null,
      cascade_retry_order: ['mid', 'tail'],
      cascade_retry_ref_ids: [31],
      ...midExtra,
    },
    { id: 'tail', type: 'image', x: 800, y: 0, prompt_draft: '末端出图' },
  ]
  const connections: CanvasConnection[] = [
    { from: 'source', to: 'mid', kind: 'input' },
    { from: 'mid', to: 'tail', kind: 'input' },
  ]
  useCanvasStore.setState({
    canvasId: 77,
    loaded: true,
    version: 4,
    nodes,
    connections,
    cascade: null,
    running: {},
    edgeStates: {},
  })
}

function workflowTask(canvasId: number | null): StudioTask {
  return {
    id: 'wf-task-1',
    domain: 'studio',
    tool_id: 'infinite-canvas',
    task_type: 'workflow.run',
    parent_task_id: null,
    batch_id: null,
    source_route: null,
    source_context: { canvas_id: 77, node_id: 'wf', workflow_segment_id: 'seg-1' },
    capability: null,
    deployment_id: null,
    invocation: null,
    provider_task_id: null,
    canvas_id: canvasId,
    node_id: 'wf',
    execution_group_id: null,
    status: 'succeeded',
    stage: null,
    progress: 100,
    result: {
      items: [
        { kind: 'video', media_asset_id: 5, url: '/api/studio/media-assets/5/content' },
        { kind: 'image', asset_id: 9 },
      ],
    },
    error: null,
    retryable: false,
    created_at: null,
    started_at: null,
    heartbeat_at: null,
    finished_at: null,
    event_seq: 1,
    updated_at: null,
  }
}

function seedWorkflowCanvas(): void {
  const workflow: ScvNode = {
    id: 'wf',
    type: 'workflow',
    x: 0,
    y: 0,
    w: 300,
    title: '测试工作流',
    workflow_id: 1,
    workflow_timeline: {
      kind: 'minimax',
      selected_id: 'seg-1',
      segments: [
        { id: 'seg-1', start: 0, length: 6, prompt: '片段词', type: 'text', references: [] },
      ],
    },
  }
  useCanvasStore.setState({
    canvasId: 77,
    loaded: false,
    nodes: [workflow],
    connections: [],
    cascade: null,
    running: {},
    edgeStates: {},
  })
}

beforeEach(() => {
  vi.stubGlobal('window', { setTimeout, clearTimeout })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  useCanvasStore.getState().reset()
})

describe('retryCascadeFrom · 无 cascade_run_id 走服务端 DAG', () => {
  it('把失败节点起的子链按失败轮编译提交 runInlineFlow，不再本地逐节点执行', async () => {
    seedRetryCanvas()
    vi.spyOn(apiConfig, 'credentials').mockResolvedValue([])
    const save = vi.spyOn(apiStudio, 'saveCanvas').mockResolvedValue({ version: 5, updated_at: '' })
    const resume = vi.spyOn(apiStudio, 'resumeFlowRun')
    let submitted: Parameters<typeof apiStudio.runInlineFlow>[0] | undefined
    const submit = vi.spyOn(apiStudio, 'runInlineFlow').mockImplementation(async (body) => {
      submitted = body
      return runOf(body, 'queued')
    })
    vi.spyOn(apiStudio, 'flowRun').mockImplementation(async () => {
      if (submitted === undefined) throw new Error('flow was not submitted')
      return runOf(submitted, 'failed')
    })
    vi.spyOn(apiStudio, 'tasks').mockResolvedValue({ items: [] })

    await retryCascadeFrom('mid')

    expect(resume).not.toHaveBeenCalled()
    expect(submit).toHaveBeenCalledTimes(1)
    // 槽位先落库再提交，刷新后产物仍有稳定落点
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(submit.mock.invocationCallOrder[0])
    expect(submitted?.source_context).toMatchObject({
      kind: 'canvas_cascade',
      canvas_id: 77,
      start_id: 'mid',
      mode: 'serial',
      total: 3,
    })
    // 只编失败那一轮，轮号保持原值
    expect(Object.keys((submitted?.source_context?.round_nodes ?? {}) as Record<string, unknown>)).toEqual(['2'])
    expect(submitted?.definition.nodes.map((node) => node.id)).toEqual(['r2_n0', 'r2_n1'])
    expect(submitted?.definition.edges).toEqual([{ from: 'r2_n0', to: 'r2_n1' }])
    // 失败节点沿用冻结的原轮次参考
    const refs = asFlowToolNode(submitted?.definition.nodes[0]).input.ref_asset_ids as
      Record<string, unknown>
    expect(refs.fallback).toEqual([{ kind: 'image', asset_id: 31 }])
    // 第 2 轮的输出槽按 slot_of/slot_round 持久化
    const slots = useCanvasStore.getState().nodes.filter((node) => node.slot_round === 2)
    expect(slots.map((node) => node.slot_of).sort()).toEqual(['mid', 'tail'])

    // DAG 终态失败后：投影回失败态并带上 run id，下一次重试走服务端续跑
    await vi.waitFor(() => expect(useCanvasStore.getState().cascade).toBeNull())
    const mid = useCanvasStore.getState().nodes.find((node) => node.id === 'mid')
    expect(mid?.cascade_status).toBe('failed')
    expect(mid?.cascade_run_id).toBe('retry-run')
  })

  it('提交失败：清掉空槽位与级联投影，并提示重新发起级联', async () => {
    seedRetryCanvas()
    vi.spyOn(apiConfig, 'credentials').mockResolvedValue([])
    vi.spyOn(apiStudio, 'saveCanvas').mockResolvedValue({ version: 5, updated_at: '' })
    vi.spyOn(apiStudio, 'runInlineFlow').mockRejectedValue(new Error('网关 503'))

    await retryCascadeFrom('mid')

    expect(toastError).toHaveBeenCalledWith('级联重试提交失败：网关 503，请重新发起级联')
    const state = useCanvasStore.getState()
    expect(state.cascade).toBeNull()
    expect(state.edgeStates).toEqual({})
    expect(state.nodes.map((node) => node.id).sort()).toEqual(['mid', 'source', 'tail'])
    expect(state.nodes.find((node) => node.id === 'mid')?.cascade_status).toBeUndefined()
  })

  it('有 cascade_run_id 时仍走服务端 checkpoint 续跑', async () => {
    seedRetryCanvas({ cascade_run_id: 'old-run' })
    const body = {
      definition: {
        nodes: [{ id: 'r2_n0', tool_id: 'infinite-canvas', operation: 'image.auto', input: {} }],
        edges: [],
      },
      inputs: {},
      source_context: {
        kind: 'canvas_cascade',
        canvas_id: 77,
        total: 3,
        node_map: { r2_n0: { canvas_node_id: 'mid', target_node_id: 'mid', round: 2, label: '图片节点' } },
        round_nodes: { '2': ['r2_n0'] },
        edge_keys: [],
      },
    }
    const resume = vi.spyOn(apiStudio, 'resumeFlowRun').mockResolvedValue(runOf(body, 'failed'))
    const submit = vi.spyOn(apiStudio, 'runInlineFlow')
    vi.spyOn(apiStudio, 'flowRun').mockResolvedValue(runOf(body, 'failed'))
    vi.spyOn(apiStudio, 'tasks').mockResolvedValue({ items: [] })

    await retryCascadeFrom('mid')

    expect(resume).toHaveBeenCalledWith('old-run')
    expect(submit).not.toHaveBeenCalled()
    expect(toastInfo).toHaveBeenCalledWith('已从服务端 checkpoint 继续，已成功节点不会重复调用')
  })
})

describe('landWorkflowTask · 产物节点归服务端 projector', () => {
  it('带 canvas_id 的任务只记完成态与时间线结果，不本地新建 output 节点', () => {
    seedWorkflowCanvas()

    expect(landWorkflowTask(workflowTask(77), 77, 'wf')).toBe(true)

    const state = useCanvasStore.getState()
    expect(state.nodes).toHaveLength(1)
    expect(state.connections).toHaveLength(0)
    const workflow = state.nodes[0]
    expect(workflow.completed_task_ids).toEqual(['wf-task-1'])
    expect(workflow.workflow_timeline?.segments[0].result).toMatchObject({
      kind: 'video',
      media_asset_id: 5,
    })

    // 幂等：同一任务再收一次不重复记账
    expect(landWorkflowTask(workflowTask(77), 77, 'wf')).toBe(true)
    expect(useCanvasStore.getState().nodes[0].completed_task_ids).toEqual(['wf-task-1'])
  })

  it('无 canvas_id 的旧任务保持旧行为：本地按产物类型建 output 节点并连线', () => {
    seedWorkflowCanvas()

    expect(landWorkflowTask(workflowTask(null), 77, 'wf')).toBe(true)

    const state = useCanvasStore.getState()
    const outputs = state.nodes.filter((node) => node.type === 'output')
    expect(outputs).toHaveLength(2)
    expect(outputs.map((node) => node.title).sort()).toEqual(['测试工作流 · 图片', '测试工作流 · 视频'])
    expect(state.connections).toEqual(outputs.map((node) => ({
      from: 'wf',
      to: node.id,
      kind: 'flow',
    })))
    expect(state.nodes.find((node) => node.id === 'wf')?.completed_task_ids).toEqual(['wf-task-1'])
  })

  /* 落点原来是 `index * 26` 硬错开，而产出节点高好几百——图片+视频两类落下来
     几乎完全重叠，只露出后一个的标题条，看着像"凭空多了个空节点"。
     分支出图那条早就走统一避让，这条一直漏着。 */
  it('多类产物落点互不重叠', () => {
    seedWorkflowCanvas()
    landWorkflowTask(workflowTask(null), 77, 'wf')

    const outputs = useCanvasStore.getState().nodes.filter((n) => n.type === 'output')
    expect(outputs).toHaveLength(2)
    const [a, b] = outputs
    const boxA = { x: a.x, y: a.y, w: a.w ?? 316, h: 220 }
    const boxB = { x: b.x, y: b.y, w: b.w ?? 316, h: 220 }
    const overlapX = Math.min(boxA.x + boxA.w, boxB.x + boxB.w) - Math.max(boxA.x, boxB.x)
    const overlapY = Math.min(boxA.y + boxA.h, boxB.y + boxB.h) - Math.max(boxA.y, boxB.y)
    expect(overlapX > 0 && overlapY > 0).toBe(false)
  })

  it('产物落在源节点右侧，不会盖住源节点', () => {
    seedWorkflowCanvas()
    landWorkflowTask(workflowTask(null), 77, 'wf')

    const source = useCanvasStore.getState().nodes.find((n) => n.id === 'wf')
    const outputs = useCanvasStore.getState().nodes.filter((n) => n.type === 'output')
    for (const o of outputs) expect(o.x).toBeGreaterThanOrEqual((source?.x ?? 0) + (source?.w ?? 300))
  })
})
