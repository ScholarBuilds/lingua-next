/* 任务中心统一行模型的纯函数：task / flow / pipeline 三类主体折叠成 TaskCenterRow，
   以及 SSE 帧并进列表 / 全量快照的折叠规则。全部纯函数，node 环境直接测。 */

import { describe, expect, it } from 'vitest'

import type { ActiveItem, ActivePayload, PipelineEventFrame, RunListItem } from '@/lib/api-pipeline'
import type { StudioFlowRun, StudioTask } from '@/lib/api-studio'

import {
  dockRows,
  flowRow,
  foldActivePayload,
  mergeFlowRun,
  pipelineRoute,
  pipelineRow,
  pipelineRows,
  rowInScope,
  taskRow,
  upsertPipelineFrame,
} from './taskQueries'
import type { TaskCenterRow } from './taskQueries'

function makeTask(patch: Partial<StudioTask> = {}): StudioTask {
  return {
    id: 't1',
    domain: 'studio',
    tool_id: 'online-image',
    task_type: 'image.generate',
    parent_task_id: null,
    batch_id: null,
    source_route: '/studio/online',
    source_context: null,
    capability: 'image.generate',
    deployment_id: null,
    invocation: null,
    provider_task_id: null,
    canvas_id: null,
    node_id: null,
    execution_group_id: null,
    status: 'running',
    stage: '出图中',
    progress: 40,
    result: null,
    error: null,
    retryable: false,
    created_at: '2026-08-22T10:00:00+00:00',
    started_at: null,
    heartbeat_at: null,
    finished_at: null,
    event_seq: 1,
    updated_at: null,
    ...patch,
  }
}

function makeFlowRun(patch: Partial<StudioFlowRun> = {}): StudioFlowRun {
  return {
    id: 'run-1',
    flow_id: null,
    parent_run_id: null,
    flow_version: 1,
    status: 'running',
    error: null,
    inputs: {},
    source_context: null,
    checkpoint: { version: 1, nodes: {} },
    progress: 50,
    created_at: '2026-08-22T09:00:00+00:00',
    started_at: null,
    heartbeat_at: null,
    finished_at: null,
    updated_at: '2026-08-22T09:00:10+00:00',
    ...patch,
  }
}

function makeRunItem(patch: Partial<RunListItem> = {}): RunListItem {
  return {
    id: 5,
    video_id: 12,
    kind: 'ingest',
    trigger: 'user',
    status: 'success',
    from_step: null,
    scope: null,
    config_override: {},
    code_version: null,
    parent_run_id: null,
    started_at: '2026-08-22T08:00:00+00:00',
    finished_at: '2026-08-22T08:10:00+00:00',
    error: null,
    video_title: '演示视频',
    failed_steps: [],
    duration_ms: 600_000,
    open_issues: 0,
    ...patch,
  }
}

function makeFrame(patch: Partial<PipelineEventFrame> = {}): PipelineEventFrame {
  return {
    run_id: 5,
    domain: 'video',
    subject_id: 12,
    title: '演示视频',
    kind: 'ingest',
    status: 'running',
    progress: 40,
    error: null,
    current_step: 'transcribe',
    current_label: '转写中',
    failed_steps: [],
    done_steps: 2,
    total_steps: 8,
    started_at: '2026-08-22T08:00:00+00:00',
    finished_at: null,
    updated_at: '2026-08-22T08:05:00+00:00',
    ...patch,
  }
}

function makeActiveItem(patch: Partial<ActiveItem> = {}): ActiveItem {
  return {
    video_id: 12,
    domain: 'video',
    title: '演示视频',
    status: 'processing',
    live: true,
    progress: 30,
    error: null,
    error_kind: null,
    run_id: 5,
    current_step: 'transcribe',
    current_label: '转写中',
    failed_steps: [],
    done_steps: 2,
    total_steps: 8,
    ...patch,
  }
}

describe('taskRow', () => {
  it('活跃任务：active 语气、带进度、回到来源取 source_route', () => {
    const row = taskRow(makeTask(), '在线生图')
    expect(row).toMatchObject({
      key: 'task:t1',
      subject: 'task',
      title: '在线生图',
      kind: 'image.generate',
      statusLabel: '运行中',
      tone: 'active',
      active: true,
      progress: 40,
      stage: '出图中',
      sourceRoute: '/studio/online',
    })
  })

  it('终态任务不带进度；非站内 source_route 不当来源；语气按状态分档', () => {
    const failed = taskRow(makeTask({ status: 'failed', source_route: 'https://x.dev', error: '超时' }))
    expect(failed).toMatchObject({ tone: 'err', active: false, progress: null, sourceRoute: null, error: '超时' })
    expect(taskRow(makeTask({ status: 'partial' })).tone).toBe('warn')
    expect(taskRow(makeTask({ status: 'succeeded' })).tone).toBe('ok')
    expect(taskRow(makeTask({ status: 'cancelled' })).tone).toBe('muted')
    // 没传工具目录时退回 tool_id
    expect(failed.title).toBe('online-image')
  })

  it('来源上下文压成人话标签', () => {
    expect(taskRow(makeTask({ source_context: { canvas_id: 7 } })).context).toBe('画布 #7')
    expect(taskRow(makeTask({ source_context: { node_id: 'n1', canvas_id: 7 } })).context).toBe('节点 n1')
  })
})

describe('flowRow', () => {
  it('画布级联：按来源 kind 取名、回到画布、节点计数当阶段', () => {
    const row = flowRow(
      makeFlowRun({
        source_context: { kind: 'canvas_set', canvas_id: 7 },
        checkpoint: {
          version: 1,
          nodes: {
            a: { status: 'succeeded', task_id: null, attempt: 1, result: null, error: null },
            b: { status: 'running', task_id: null, attempt: 1, result: null, error: null },
          },
        },
      }),
    )
    expect(row).toMatchObject({
      key: 'flow:run-1',
      subject: 'flow',
      title: '成套出图',
      kind: 'canvas_set',
      tone: 'active',
      active: true,
      progress: 50,
      stage: '1/2 节点',
      context: '画布 #7',
      sourceRoute: '/studio/canvas/7',
    })
  })

  it('DAG 编排的失败 run：回编排页；内联 run 没有来源', () => {
    const dag = flowRow(makeFlowRun({ id: 'run-2', flow_id: 3, status: 'failed', error: '节点超时' }))
    expect(dag).toMatchObject({
      title: '工作流 #3',
      kind: 'flow',
      tone: 'err',
      active: false,
      progress: null,
      context: 'DAG #3 · v1',
      sourceRoute: '/studio/flows',
      error: '节点超时',
    })
    expect(flowRow(makeFlowRun({ id: 'run-3', status: 'succeeded' })).sourceRoute).toBeNull()
    expect(flowRow(makeFlowRun({ id: 'run-3', status: 'succeeded' })).kind).toBe('inline')
  })
})

describe('pipelineRoute', () => {
  it('视频域走视频管线页，其余域走通用主体页，主体缺失给 null', () => {
    expect(pipelineRoute('video', 12)).toBe('/video/12/pipeline')
    expect(pipelineRoute('scenario_deck', 9)).toBe('/pipeline/scenario_deck/9')
    expect(pipelineRoute('video', 0)).toBeNull()
  })
})

describe('pipelineRow', () => {
  it('只有帧（基线之后才开始的 run）：活跃、当前节点当阶段、能跳管线页', () => {
    const row = pipelineRow(null, makeFrame())
    expect(row).toMatchObject({
      key: 'pipeline:5',
      subject: 'pipeline',
      title: '演示视频',
      kind: 'ingest',
      statusLabel: '运行中',
      tone: 'active',
      active: true,
      progress: 40,
      stage: '转写中',
      sourceRoute: '/video/12/pipeline',
    })
  })

  it('只有列表项：终态、不带进度；失败节点列进阶段', () => {
    const ok = pipelineRow(makeRunItem(), null)
    expect(ok).toMatchObject({ tone: 'ok', active: false, progress: null, title: '演示视频' })
    const failed = pipelineRow(
      makeRunItem({ id: 6, status: 'failed', error: '磁盘满', failed_steps: ['transcribe'] }),
      null,
    )
    expect(failed).toMatchObject({ tone: 'err', stage: '失败节点：transcribe', error: '磁盘满' })
  })

  it('run 只会往前走：终态一侧压过活跃一侧，无论它来自帧还是列表', () => {
    // 帧比列表新：running → success
    const frameWins = pipelineRow(makeRunItem({ status: 'running' }), makeFrame({ status: 'success' }))
    expect(frameWins).toMatchObject({ status: 'success', tone: 'ok', active: false })
    // 列表比帧新（重连后先收到旧帧）：success 不能被 running 帧拉回去
    const itemWins = pipelineRow(makeRunItem({ status: 'success' }), makeFrame({ status: 'running' }))
    expect(itemWins).toMatchObject({ status: 'success', tone: 'ok', active: false, progress: null })
  })

  it('非视频域的帧：域名当上下文，跳通用主体页', () => {
    const row = pipelineRow(null, makeFrame({ run_id: 9, domain: 'scenario_deck', subject_id: 3, title: '' }))
    expect(row).toMatchObject({ title: '#3', context: 'scenario_deck', sourceRoute: '/pipeline/scenario_deck/3' })
  })
})

describe('pipelineRows', () => {
  it('列表与帧按 run id 合并，只在帧里出现的 run 也进来，按 id 倒序', () => {
    const rows = pipelineRows(
      [makeRunItem({ id: 5, status: 'running' }), makeRunItem({ id: 4, status: 'success' })],
      { '7': makeFrame({ run_id: 7 }), '5': makeFrame({ run_id: 5, status: 'success' }) },
    )
    expect(rows.map((row) => row.id)).toEqual(['7', '5', '4'])
    expect(rows[1].status).toBe('success')
  })
})

describe('mergeFlowRun', () => {
  it('已有的按 id 替换，新 run 插到最前，更旧的快照不回退', () => {
    const base = [makeFlowRun({ id: 'a', updated_at: '2026-08-22T09:00:10+00:00' })]
    const newer = makeFlowRun({ id: 'a', status: 'succeeded', updated_at: '2026-08-22T09:00:20+00:00' })
    expect(mergeFlowRun(base, newer)[0].status).toBe('succeeded')
    const stale = makeFlowRun({ id: 'a', status: 'queued', updated_at: '2026-08-22T09:00:00+00:00' })
    expect(mergeFlowRun([newer], stale)[0].status).toBe('succeeded')
    const merged = mergeFlowRun(base, makeFlowRun({ id: 'b' }))
    expect(merged.map((run) => run.id)).toEqual(['b', 'a'])
  })
})

describe('upsertPipelineFrame', () => {
  it('按 run_id 覆盖，迟到的旧帧丢弃', () => {
    const first = makeFrame({ progress: 20, updated_at: '2026-08-22T08:01:00+00:00' })
    const second = makeFrame({ progress: 60, updated_at: '2026-08-22T08:02:00+00:00' })
    let frames = upsertPipelineFrame({}, first)
    frames = upsertPipelineFrame(frames, second)
    expect(frames['5'].progress).toBe(60)
    expect(upsertPipelineFrame(frames, first)['5'].progress).toBe(60)
    expect(Object.keys(upsertPipelineFrame(frames, makeFrame({ run_id: 6 })))).toHaveLength(2)
  })
})

describe('foldActivePayload', () => {
  const empty: ActivePayload = { items: [], active: 0 }

  it('活跃帧插入或覆盖同主体的项，active 按活跃 run 数算', () => {
    const one = foldActivePayload(empty, makeFrame({ progress: 20 }))
    expect(one.items).toHaveLength(1)
    expect(one.items[0]).toMatchObject({
      video_id: 12,
      domain: 'video',
      status: 'processing',
      live: true,
      progress: 20,
      run_id: 5,
      current_label: '转写中',
    })
    expect(one.active).toBe(1)
    const two = foldActivePayload(one, makeFrame({ progress: 80 }))
    expect(two.items).toHaveLength(1)
    expect(two.items[0].progress).toBe(80)
  })

  it('帧没带标题时保住基线里的标题', () => {
    const base: ActivePayload = { items: [makeActiveItem()], active: 1 }
    const next = foldActivePayload(base, makeFrame({ title: '' }))
    expect(next.items[0].title).toBe('演示视频')
  })

  it('失败帧把项留成「需要关注」；成功 / 取消帧把项移走', () => {
    const base: ActivePayload = { items: [makeActiveItem()], active: 1 }
    const failed = foldActivePayload(base, makeFrame({ status: 'failed', error: '磁盘满' }))
    expect(failed.items[0]).toMatchObject({ status: 'failed', live: false, error: '磁盘满' })
    expect(failed.active).toBe(0)
    expect(foldActivePayload(base, makeFrame({ status: 'success' })).items).toHaveLength(0)
    expect(foldActivePayload(empty, makeFrame({ status: 'success' }))).toBe(empty)
  })

  it('同主体更旧 run 的迟到帧不能盖掉新 run 的状态', () => {
    const base: ActivePayload = { items: [makeActiveItem({ run_id: 9 })], active: 1 }
    expect(foldActivePayload(base, makeFrame({ run_id: 5, status: 'failed' }))).toBe(base)
  })
})

describe('dockRows', () => {
  it('管线活跃项在前、工坊活跃任务在后；非活跃项不进浮层', () => {
    const rows = dockRows(
      [makeActiveItem(), makeActiveItem({ video_id: 3, live: false, status: 'failed' })],
      [makeTask(), makeTask({ id: 't2', status: 'failed' })],
      () => '在线生图',
    )
    expect(rows.map((row) => row.key)).toEqual(['pipeline:video:12', 'task:t1'])
    expect(rows[0]).toMatchObject({ title: '演示视频', step: '转写中', route: '/video/12/pipeline' })
    expect(rows[1]).toMatchObject({ title: '在线生图', step: '出图中', progress: 40, route: '/studio/online' })
  })

  it('没有 source_route 的任务兜底跳任务中心', () => {
    const rows = dockRows([], [makeTask({ source_route: null, stage: null, capability: null })])
    expect(rows[0]).toMatchObject({ route: '/tasks', step: '运行中' })
  })

  /* image_gen 域的管线 run 是工坊任务的执行细节（同一个 ImageJob）。
     两边都列的话，画布上出 2 张图会显示成「4 个任务执行中」——同一份活占两行、
     进度还各说各的（实测一边报 0% 另一边报 1%）。 */
  it('被工坊任务覆盖的 image_gen 管线行不再重复列出', () => {
    const rows = dockRows(
      [makeActiveItem({ domain: 'image_gen', subject_id: 61, video_id: 61 })],
      [makeTask({ invocation: { image_job_id: 61 } })],
    )
    expect(rows.map((r) => r.key)).toEqual(['task:t1'])
  })

  it('没有对应工坊任务的 image_gen 管线行照常列出', () => {
    const rows = dockRows(
      [makeActiveItem({ domain: 'image_gen', subject_id: 99, video_id: 99 })],
      [makeTask({ invocation: { image_job_id: 61 } })],
    )
    expect(rows).toHaveLength(2)
  })

  /* 只有 image_gen 域走这条折叠：视频域的管线 run 不是任何工坊任务的执行细节，
     按 subject_id 撞号折掉就等于把正在跑的视频任务从浮层里抹掉。 */
  it('视频域不受折叠影响，即使 subject_id 撞号', () => {
    const rows = dockRows(
      [makeActiveItem({ domain: 'video', subject_id: 61, video_id: 61 })],
      [makeTask({ invocation: { image_job_id: 61 } })],
    )
    expect(rows).toHaveLength(2)
  })
})

describe('rowInScope', () => {
  const row = (tone: TaskCenterRow['tone'], active: boolean): TaskCenterRow => ({
    key: 'task:x',
    subject: 'task',
    id: 'x',
    title: 'x',
    kind: '',
    status: 'running',
    statusLabel: '',
    tone,
    active,
    progress: null,
    stage: null,
    context: null,
    error: null,
    createdAt: null,
    sourceRoute: null,
  })

  it('active 看在跑，failed 收错误与部分完成，finished 收成功与取消', () => {
    expect(rowInScope(row('active', true), 'active')).toBe(true)
    expect(rowInScope(row('ok', false), 'active')).toBe(false)
    expect(rowInScope(row('err', false), 'failed')).toBe(true)
    expect(rowInScope(row('warn', false), 'failed')).toBe(true)
    expect(rowInScope(row('ok', false), 'failed')).toBe(false)
    expect(rowInScope(row('ok', false), 'finished')).toBe(true)
    expect(rowInScope(row('muted', false), 'finished')).toBe(true)
    expect(rowInScope(row('err', false), 'finished')).toBe(false)
    expect(rowInScope(row('err', false), 'all')).toBe(true)
  })
})
