import { afterEach, describe, expect, it, vi } from 'vitest'

import { apiConfig } from '../../lib/api-config'
import { apiStudio, asFlowToolNode } from '../../lib/api-studio'
import type {
  CanvasConnection,
  CanvasDetail,
  ExecutableWorkflowDetail,
  SetPlan,
  StudioFlowDefinition,
  StudioFlowRun,
  StudioFlowToolNode,
} from '../../lib/api-studio'
import {
  cascadeChain,
  compileCascadeRun,
  compileSetPlanRun,
  landCascadeCheckpointOutputs,
  loopSchedule,
  runSetPlan,
  type RunCtx,
  type ScvNode,
  useCanvasStore,
} from './canvasStore'

/** 画布编译出来的全是工具节点。节点类型是按 kind 判别的联合，
 *  读 operation / input 之前先整体收窄，读不到就是编译器出错了，直接抛 */
function toolNodes(definition: StudioFlowDefinition): StudioFlowToolNode[] {
  return definition.nodes.map(asFlowToolNode)
}

function setCanvas(nodes: ScvNode[], connections: CanvasConnection[]): void {
  useCanvasStore.setState({
    canvasId: 77,
    nodes,
    connections,
    cascade: null,
    running: {},
    edgeStates: {},
  })
}

function context(order: string[], total = 1, loopId: string | null = null): RunCtx {
  const schedule = loopSchedule({ count: total })
  return {
    canvasId: 77,
    order,
    total,
    vars: [],
    schedule: schedule.rounds,
    endIndex: schedule.end,
    loopId,
    commitUndo: () => undefined,
  }
}

function setPlan(intent: SetPlan['intent']): SetPlan {
  return {
    goal: '一组三联画',
    intent,
    variables: [],
    steps: [
      { id: 'cover', title: '封面', prompt: '画封面', dependsOn: [] },
      { id: 'detail', title: '细节', prompt: '画细节', dependsOn: ['cover'] },
      { id: 'ending', title: '收束', prompt: '画结尾', dependsOn: ['detail'] },
    ],
    rationale: '验证服务端成套执行拓扑',
  }
}

function setRun(
  body: Parameters<typeof apiStudio.runInlineFlow>[0],
  status: StudioFlowRun['status'],
): StudioFlowRun {
  return {
    id: 'set-run',
    flow_id: null,
    parent_run_id: null,
    flow_version: 1,
    status,
    error: status === 'failed' ? 'simulated terminal failure' : null,
    inputs: body.inputs ?? {},
    source_context: body.source_context ?? {},
    checkpoint: {
      version: 1,
      nodes: Object.fromEntries(body.definition.nodes.map((node, index) => [node.id, {
        status: status === 'failed' && index === 0 ? 'failed' : 'pending',
        task_id: null,
        attempt: 0,
        result: null,
        error: status === 'failed' && index === 0 ? 'simulated terminal failure' : null,
      }])),
    },
    progress: status === 'failed' ? 0 : 1,
    created_at: null,
    started_at: null,
    heartbeat_at: null,
    finished_at: null,
    updated_at: null,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useCanvasStore.getState().reset()
})

describe('canvas cascade compiler', () => {
  it('将 MiniMax RunningHub 的动态素材投影到真实字段键', async () => {
    const nodes: ScvNode[] = [
      {
        id: 'source',
        type: 'image',
        x: 0,
        y: 0,
        items: [{ kind: 'image', asset_id: 31 }],
      },
      {
        id: 'workflow',
        type: 'workflow',
        x: 500,
        y: 0,
        title: 'Minimax-多参视频生成',
        workflow_id: 15,
        workflow_provider: 'runninghub',
        workflow_kind: 'workflow',
        workflow_credential_id: 5,
        workflow_timeline: {
          kind: 'minimax',
          selected_id: 'clip-1',
          segments: [{
            id: 'clip-1',
            start: 0,
            length: 6,
            prompt: 'clip-specific prompt',
            type: 'text',
            references: [],
          }],
        },
      },
    ]
    setCanvas(nodes, [{ from: 'source', to: 'workflow', kind: 'input' }])
    vi.spyOn(apiConfig, 'credentials').mockResolvedValue([{
      id: 5,
      name: 'RunningHub test',
      kind: 'workflow',
      provider_type: 'runninghub',
      enabled: true,
      status: 'ok',
      status_detail: null,
      last_tested_at: null,
      masked: {},
      models: [],
      models_count: 0,
      models_refreshed_at: null,
    }])
    const workflow: ExecutableWorkflowDetail = {
      id: 15,
      key: 'runninghub:2084608321469898754',
      title: 'Minimax-多参视频生成',
      provider: 'runninghub',
      kind: 'workflow',
      source: 'user',
      source_id: '2084608321469898754',
      enabled: true,
      node_count: 4,
      field_count: 3,
      has_thumbnail: false,
      content_hash: 'hash',
      version: 1,
      created_at: '',
      updated_at: '',
      payload: {},
      ui_schema: { fields: [
        { id: '138::value', nodeId: '138', fieldName: 'value', label: 'Prompt', enabled: true },
        { id: '132::value', nodeId: '132', fieldName: 'value', label: 'Duration', enabled: true },
        { id: '20::image', nodeId: '20', fieldName: 'image', fieldType: 'IMAGE', enabled: true },
      ] },
    }
    vi.spyOn(apiStudio, 'workflow').mockResolvedValue(workflow)

    const compiled = await compileCascadeRun(
      useCanvasStore.getState(),
      { order: ['source', 'workflow'], edgeKeys: ['source\u0000workflow'] },
      context(['source', 'workflow']),
      'serial',
      undefined,
    )
    const workflowNode = toolNodes(compiled.definition)
      .find((item) => item.operation === 'workflow.run')
    const fields = workflowNode?.input.fields as Record<string, unknown>

    expect(fields['138::value']).toBe('clip-specific prompt')
    expect(fields['132::value']).toBe(6)
    expect(fields['20::image']).toMatchObject({
      $artifacts: expect.arrayContaining([{ $node: expect.any(String) }]),
    })
    expect(Object.keys(fields).some((key) => key.startsWith('f_'))).toBe(false)
  })

  it('compiles a consistent set plan into a persisted artifact chain', () => {
    const nodes: ScvNode[] = [
      {
        id: 'source',
        type: 'image',
        x: 0,
        y: 0,
        items: [{ kind: 'image', asset_id: 31 }],
        run_settings: { deployment_id: 9, size: '1024x1536', quality: 'high' },
      },
      { id: 'slot-1', type: 'image', x: 0, y: 500, title: '封面', items: [] },
      { id: 'slot-2', type: 'image', x: 550, y: 500, title: '细节', items: [] },
      { id: 'slot-3', type: 'image', x: 1100, y: 500, title: '收束', items: [] },
    ]
    setCanvas(nodes, [])

    const compiled = compileSetPlanRun(
      useCanvasStore.getState(),
      'source',
      setPlan('consistent'),
      ['slot-1', 'slot-2', 'slot-3'],
    )

    expect(toolNodes(compiled.definition).map((node) => node.operation)).toEqual([
      'image.auto',
      'image.auto',
      'image.auto',
    ])
    expect(compiled.definition.edges).toEqual([
      { from: 'set_1', to: 'set_2' },
      { from: 'set_2', to: 'set_3' },
    ])
    expect(toolNodes(compiled.definition)[0].input.ref_asset_ids).toMatchObject({
      $artifacts: [{ kind: 'image', asset_id: 31 }],
    })
    expect(toolNodes(compiled.definition)[1].input.ref_asset_ids).toMatchObject({
      $artifacts: [{ $node: 'set_1' }, { kind: 'image', asset_id: 31 }],
    })
    expect(compiled.sourceContext).toMatchObject({
      kind: 'canvas_set',
      mode: 'serial',
      total: 3,
      max_parallel_tasks: 1,
      node_map: {
        set_1: { target_node_id: 'slot-1', round: 1 },
        set_2: { target_node_id: 'slot-2', round: 2 },
        set_3: { target_node_id: 'slot-3', round: 3 },
      },
    })
  })

  it('compiles a varied set plan as independent server-side tasks', () => {
    const nodes: ScvNode[] = [
      { id: 'source', type: 'image', x: 0, y: 0, items: [{ kind: 'image', asset_id: 31 }] },
      { id: 'slot-1', type: 'image', x: 0, y: 500, items: [] },
      { id: 'slot-2', type: 'image', x: 550, y: 500, items: [] },
      { id: 'slot-3', type: 'image', x: 1100, y: 500, items: [] },
    ]
    setCanvas(nodes, [])

    const compiled = compileSetPlanRun(
      useCanvasStore.getState(),
      'source',
      setPlan('varied'),
      ['slot-1', 'slot-2', 'slot-3'],
    )

    expect(compiled.definition.edges).toEqual([])
    expect(toolNodes(compiled.definition).map((node) =>
      (node.input.ref_asset_ids as { $artifacts: unknown[] }).$artifacts,
    )).toEqual([
      [{ kind: 'image', asset_id: 31 }],
      [{ kind: 'image', asset_id: 31 }],
      [{ kind: 'image', asset_id: 31 }],
    ])
    expect(compiled.sourceContext).toMatchObject({
      kind: 'canvas_set',
      mode: 'parallel',
      max_parallel_tasks: 3,
    })
  })

  it('persists output slots before submitting a set plan to the flow runtime', async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout })
    const source: ScvNode = {
      id: 'source',
      type: 'image',
      x: 100,
      y: 100,
      h: 400,
      items: [{ kind: 'image', asset_id: 31 }],
    }
    setCanvas([source], [])
    useCanvasStore.setState({ loaded: true, version: 4 })
    const save = vi.spyOn(apiStudio, 'saveCanvas').mockResolvedValue({ version: 5, updated_at: '' })
    let submitted: Parameters<typeof apiStudio.runInlineFlow>[0] | undefined
    const submit = vi.spyOn(apiStudio, 'runInlineFlow').mockImplementation(async (body) => {
      submitted = body
      return setRun(body, 'queued')
    })
    vi.spyOn(apiStudio, 'flowRun').mockImplementation(async () => {
      if (submitted === undefined) throw new Error('flow was not submitted')
      return setRun(submitted, 'failed')
    })
    vi.spyOn(apiStudio, 'tasks').mockResolvedValue({ items: [] })

    await runSetPlan('source', setPlan('consistent'))

    expect(save).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(submit.mock.invocationCallOrder[0])
    expect(submitted?.source_context).toMatchObject({ kind: 'canvas_set', total: 3 })
    expect(submitted?.definition.edges).toEqual([
      { from: 'set_1', to: 'set_2' },
      { from: 'set_2', to: 'set_3' },
    ])
    expect(useCanvasStore.getState().nodes.filter((node) => node.slot_of === 'source')).toHaveLength(3)
    await vi.waitFor(() => expect(useCanvasStore.getState().cascade).toBeNull())
  })

  it('restores completed set-plan outputs from the shared canvas flow query', async () => {
    vi.stubGlobal('window', {
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      localStorage: { getItem: () => null, setItem: () => undefined },
    })
    vi.stubGlobal('EventSource', class {
      addEventListener(): void {}
      close(): void {}
    })
    const detail: CanvasDetail = {
      id: 77,
      title: '恢复成套画布',
      icon: '',
      kind: 'smart',
      owner: 'local',
      color: '',
      pinned: false,
      project: '',
      board_x: null,
      board_y: null,
      nodes: [{ id: 'slot-1', type: 'image', x: 0, y: 0, items: [] }],
      connections: [],
      viewport: { x: 0, y: 0, scale: 1 },
      settings: {},
      version: 1,
      updated_at: '',
    }
    const completed = setRun({
      definition: {
        nodes: [{ id: 'set_1', tool_id: 'infinite-canvas', operation: 'image.auto', input: {} }],
        edges: [],
      },
      inputs: {},
      source_context: {
        kind: 'canvas_set',
        canvas_id: 77,
        total: 1,
        node_map: {
          set_1: { canvas_node_id: 'slot-1', target_node_id: 'slot-1', round: 1, label: '封面' },
        },
      },
    }, 'succeeded')
    completed.checkpoint.nodes.set_1 = {
      status: 'succeeded',
      task_id: 'image-task',
      attempt: 1,
      result: { asset_ids: [91] },
      error: null,
    }
    vi.spyOn(apiStudio, 'canvas').mockResolvedValue(detail)
    vi.spyOn(apiStudio, 'tasks').mockResolvedValue({ items: [] })
    const runs = vi.spyOn(apiStudio, 'flowRuns').mockResolvedValue({ items: [completed] })

    await useCanvasStore.getState().load(77)

    await vi.waitFor(() => expect(useCanvasStore.getState().nodes[0].items).toEqual([
      { kind: 'image', asset_id: 91 },
    ]))
    expect(runs).toHaveBeenCalledWith({ canvas_id: 77, limit: 50 })
  })

  it('freezes LLM output references and image auto routing into one persistent DAG', async () => {
    vi.spyOn(apiConfig, 'credentials').mockResolvedValue([])
    const nodes: ScvNode[] = [
      { id: 'prompt', type: 'prompt', x: 0, y: 0, text: 'portrait' },
      { id: 'writer', type: 'llm', x: 200, y: 0, llm_input: '' },
      { id: 'image', type: 'image', x: 400, y: 0, items: [] },
    ]
    const connections: CanvasConnection[] = [
      { from: 'prompt', to: 'writer', kind: 'input' },
      { from: 'writer', to: 'image', kind: 'input' },
    ]
    setCanvas(nodes, connections)
    const chain = cascadeChain(nodes, connections, 'image')
    const compiled = await compileCascadeRun(
      useCanvasStore.getState(),
      chain,
      context(chain.order),
      'serial',
      undefined,
    )

    expect(toolNodes(compiled.definition).map((node) => node.operation)).toEqual([
      'chat.general',
      'image.auto',
    ])
    expect(compiled.definition.edges).toEqual([{ from: 'r1_n1', to: 'r1_n2' }])
    const imageInput = toolNodes(compiled.definition)[1].input
    expect(JSON.stringify(imageInput.prompt)).toContain('"$node":"r1_n1"')
    expect(JSON.stringify(imageInput.ref_asset_ids)).toContain('"$node":"r1_n1"')
    expect(compiled.sourceContext.max_parallel_tasks).toBe(1)
    expect(compiled.sourceContext.round_nodes).toEqual({ '1': ['r1_n1', 'r1_n2'] })
  })

  it('freezes upstream video media IDs into persisted LLM runs', async () => {
    vi.spyOn(apiConfig, 'credentials').mockResolvedValue([])
    const nodes: ScvNode[] = [
      {
        id: 'video-source',
        type: 'output',
        x: 0,
        y: 0,
        items: [{ kind: 'video', media_asset_id: 77 }],
      },
      { id: 'writer', type: 'llm', x: 220, y: 0, llm_input: '概括镜头变化' },
    ]
    const connections: CanvasConnection[] = [
      { from: 'video-source', to: 'writer', kind: 'input' },
    ]
    setCanvas(nodes, connections)
    const chain = cascadeChain(nodes, connections, 'writer')
    const compiled = await compileCascadeRun(
      useCanvasStore.getState(),
      chain,
      context(chain.order),
      'serial',
      undefined,
    )

    expect(compiled.definition.nodes).toHaveLength(1)
    expect(toolNodes(compiled.definition)[0].operation).toBe('chat.general')
    expect(toolNodes(compiled.definition)[0].input.video_media_asset_ids).toMatchObject({
      field: 'media_asset_id',
      kinds: ['video'],
      limit: 3,
      fallback: [{ kind: 'video', media_asset_id: 77 }],
    })
  })

  it('keeps ModelScope copies parallel inside each persisted loop round', async () => {
    vi.spyOn(apiConfig, 'credentials').mockResolvedValue([])
    const nodes: ScvNode[] = [
      { id: 'prompt', type: 'prompt', x: 0, y: 0, text: 'frame 《计数》' },
      { id: 'loop', type: 'loop', x: 160, y: 0, count: 2, mode: 'parallel' },
      {
        id: 'modelscope',
        type: 'modelscope',
        x: 320,
        y: 0,
        items: [],
        ms_count: 2,
        ms_deployment_id: 9,
      },
    ]
    const connections: CanvasConnection[] = [
      { from: 'prompt', to: 'loop', kind: 'input' },
      { from: 'loop', to: 'modelscope', kind: 'input' },
    ]
    setCanvas(nodes, connections)
    const chain = cascadeChain(nodes, connections, 'loop')
    const ctx = context(chain.order, 2, 'loop')
    const compiled = await compileCascadeRun(
      useCanvasStore.getState(),
      chain,
      ctx,
      'parallel',
      2,
    )

    expect(compiled.definition.nodes).toHaveLength(4)
    expect(toolNodes(compiled.definition).every((node) => node.operation === 'image.generate'))
      .toBe(true)
    expect(compiled.definition.edges).toEqual([])
    expect(compiled.sourceContext.max_parallel_tasks).toBe(4)
    expect(compiled.sourceContext.round_nodes).toEqual({
      '1': ['r1_n0', 'r1_n0_c1'],
      '2': ['r2_n0', 'r2_n0_c1'],
    })
    expect(toolNodes(compiled.definition)[0].input.prompt).toBe('frame 1')
    expect(toolNodes(compiled.definition)[2].input.prompt).toBe('frame 2')
  })

  it('projects one reused task result into every frozen canvas target', () => {
    const nodes: ScvNode[] = [
      { id: 'left', type: 'image', x: 0, y: 0, items: [] },
      { id: 'right', type: 'image', x: 300, y: 0, items: [] },
    ]
    setCanvas(nodes, [])
    const run: StudioFlowRun = {
      id: 'flow-run',
      flow_id: null,
      parent_run_id: null,
      flow_version: 1,
      status: 'succeeded',
      error: null,
      inputs: {},
      source_context: {
        kind: 'canvas_cascade',
        canvas_id: 77,
        node_map: {
          first: { canvas_node_id: 'left', target_node_id: 'left', round: 1, label: '左图' },
          second: { canvas_node_id: 'right', target_node_id: 'right', round: 1, label: '右图' },
        },
      },
      checkpoint: {
        version: 1,
        nodes: {
          first: {
            status: 'succeeded',
            task_id: 'shared-task',
            attempt: 1,
            result: { asset_ids: [91] },
            error: null,
          },
          second: {
            status: 'succeeded',
            task_id: 'shared-task',
            attempt: 0,
            result: { asset_ids: [91] },
            error: null,
          },
        },
      },
      progress: 100,
      created_at: null,
      started_at: null,
      heartbeat_at: null,
      finished_at: null,
      updated_at: null,
    }

    expect(landCascadeCheckpointOutputs(run, 77)).toBe(2)
    expect(useCanvasStore.getState().nodes.map((node) => node.items)).toEqual([
      [{ asset_id: 91, kind: 'image' }],
      [{ asset_id: 91, kind: 'image' }],
    ])
    expect(landCascadeCheckpointOutputs(run, 77)).toBe(0)
  })
})
