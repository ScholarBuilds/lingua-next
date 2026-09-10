/* 节点注册表的门禁测试（模块 17 · 调研 §2.7）。
 *
   守的是"加一种节点要改九个文件、漏一处不报错"这件事：
   注册表完整、默认值只有一份、端口菜单按来源过滤、运行态字段真的没进保存报文。
   前四组是纯函数；最后一组走一次真实保存链路——BR-143 只在报文上才看得出来。 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CanvasDetail, CanvasNode } from '@/lib/api-studio'

import {
  CASCADE_RUNTIME_FIELDS,
  EMPTY_NODE_W,
  NODE_DEFINITIONS,
  NODE_TYPE_ORDER,
  createMenuTypes,
  defaultNodeWidth,
  findNodeDefinition,
  isCascadeExecutableType,
  nodeDefaults,
  nodeDefinition,
  nodeTypeForEngine,
  portMenuTypes,
  runtimeFieldsFor,
  taskTargetNodeType,
} from './index'

const { canvasFetch, saveCanvas } = vi.hoisted(() => ({
  canvasFetch: vi.fn<(id: number) => Promise<CanvasDetail>>(),
  saveCanvas: vi.fn<(id: number, body: unknown) => Promise<{ version: number; updated_at: string }>>(),
}))

vi.mock('../taskEvents', () => ({
  subscribeTaskEvents: () => () => {},
  subscribeFlowEvents: () => () => {},
  subscribeCanvasEvents: () => () => {},
  onTaskStreamConnected: () => () => {},
}))

vi.mock('../../../lib/api-studio', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/api-studio')>()
  return {
    ...actual,
    apiStudio: {
      ...actual.apiStudio,
      canvas: (id: number) => canvasFetch(id),
      saveCanvas: (id: number, body: unknown) => saveCanvas(id, body),
      tasks: () => Promise.resolve({ items: [] }),
      flowRuns: () => Promise.resolve({ items: [] }),
    },
  }
})

describe('注册表完整性', () => {
  it('每个节点类型都登记了，且键与 definition.type 一致', () => {
    for (const type of NODE_TYPE_ORDER) {
      expect(NODE_DEFINITIONS[type].type).toBe(type)
    }
    // 画布契约里的 12 种类型一个不少（漏注册会先在 satisfies 处编译失败，这里守运行时）
    expect(NODE_TYPE_ORDER).toHaveLength(12)
    expect(findNodeDefinition('不存在的类型')).toBeUndefined()
    // 老画布可能存着已删掉的类型，按图片节点兜底而不是整块空白
    expect(nodeDefinition('不存在的类型').type).toBe('image')
  })

  it('defaults 不带落点与尺寸，每次调用互不共享引用', () => {
    for (const type of NODE_TYPE_ORDER) {
      const patch = nodeDefaults(type)
      expect(patch.type).toBe(type)
      expect(patch).not.toHaveProperty('id')
      expect(patch).not.toHaveProperty('x')
      expect(patch).not.toHaveProperty('y')
      expect(patch).not.toHaveProperty('w')
    }
    const first = nodeDefaults('group')
    const second = nodeDefaults('group')
    first.items?.push({ kind: 'image', asset_id: 1 })
    expect(second.items).toEqual([])
  })

  it('循环节点的默认轮数只有一份，取蓝本口径 3', () => {
    // 曾经三处各写一遍：智能画布建出来是 1 轮，经典画布和端口菜单是 3 轮
    expect(nodeDefaults('loop').count).toBe(3)
    expect(nodeDefaults('loop').mode).toBe('serial')
  })

  it('宽度：内容驱动的返回 undefined，其余给类型默认宽', () => {
    expect(NODE_DEFINITIONS.image.width).toBe(EMPTY_NODE_W)
    expect(NODE_DEFINITIONS.video.width).toBe(EMPTY_NODE_W)
    expect(defaultNodeWidth('image')).toBeUndefined()
    expect(defaultNodeWidth('video')).toBeUndefined()
    expect(defaultNodeWidth('output')).toBeUndefined()
    expect(defaultNodeWidth('loop')).toBe(360)
    expect(defaultNodeWidth('midjourney')).toBe(440)
    expect(defaultNodeWidth('prompt')).toBe(316)
    expect(defaultNodeWidth('不存在的类型')).toBeUndefined()
  })

  it('级联可执行集合与卡片外观集合与实现口径一致', () => {
    expect(NODE_TYPE_ORDER.filter(isCascadeExecutableType)).toEqual([
      'image', 'video', 'llm', 'modelscope', 'midjourney', 'workflow',
    ])
    /* output 不在卡片集合里：它装的是图/视频，与 image/video/audio/file 同族，
       套白卡片会让同一张图在输出节点里比在图片节点里重一大截 */
    expect(NODE_TYPE_ORDER.filter((type) => NODE_DEFINITIONS[type].cardLike)).toEqual([
      'prompt', 'llm', 'modelscope', 'midjourney', 'loop', 'group', 'workflow',
    ])
  })

  it('引擎与节点类型一一对应', () => {
    expect(nodeTypeForEngine('api-image')).toBe('image')
    expect(nodeTypeForEngine('api-video')).toBe('video')
    expect(nodeTypeForEngine('modelscope')).toBe('modelscope')
    expect(nodeTypeForEngine('workflow')).toBe('workflow')
  })
})

describe('任务落点', () => {
  it('按 taskTypes 判定任务落在哪种节点上，workflow.* 走前缀', () => {
    expect(taskTargetNodeType('image.generate')).toBe('image')
    expect(taskTargetNodeType('image.edit')).toBe('image')
    expect(taskTargetNodeType('image.upscale')).toBe('image')
    // Midjourney 任务的落点是图片节点，发起方才是 midjourney 节点
    expect(taskTargetNodeType('midjourney.generate')).toBe('image')
    expect(taskTargetNodeType('midjourney.action')).toBe('image')
    expect(taskTargetNodeType('video.generate')).toBe('video')
    expect(taskTargetNodeType('workflow.run')).toBe('workflow')
    expect(taskTargetNodeType('workflow.anything.else')).toBe('workflow')
    expect(taskTargetNodeType('chat.general')).toBeNull()
  })

  it('声明了 taskTypes 的类型就是 TaskTargetNodeType 的三支', () => {
    // 类型系统算不出这个交集，只能在这里钉住：多声明一种落点却没改 ensureTaskNode 会漏
    expect(NODE_TYPE_ORDER.filter((type) => NODE_DEFINITIONS[type].taskTypes.length > 0)).toEqual([
      'image', 'video', 'workflow',
    ])
  })
})

describe('创建菜单按 kind 分流', () => {
  it('两套菜单成员不同，都不含建不出来的类型', () => {
    expect(createMenuTypes('classic')).toEqual([
      'image', 'video', 'prompt', 'llm', 'modelscope', 'midjourney', 'loop', 'group',
    ])
    expect(createMenuTypes('smart')).toEqual(['image', 'prompt', 'loop', 'group'])
    for (const kind of ['classic', 'smart'] as const) {
      // 工作流要先选一份定义，输出/音频/文件是产物落点，都不能靠默认值凭空建
      expect(createMenuTypes(kind)).not.toContain('workflow')
      expect(createMenuTypes(kind)).not.toContain('output')
      expect(createMenuTypes(kind)).not.toContain('audio')
      expect(createMenuTypes(kind)).not.toContain('file')
    }
  })

  it('智能画布换措辞不换默认值', () => {
    expect(NODE_DEFINITIONS.image.smartLabel).toBe('上传')
    expect(nodeDefaults('image')).toEqual({ type: 'image', items: [] })
  })
})

describe('端口菜单按来源过滤', () => {
  it('下游候选要吃得下来源的产出', () => {
    const fromImage = portMenuTypes('image', 'out')
    expect(fromImage).toContain('image')
    expect(fromImage).toContain('llm')
    expect(fromImage).toContain('midjourney')
    // 提示词没有输入端口，接不到任何东西的下游
    expect(fromImage).not.toContain('prompt')

    // 循环产出的是轮次控制：执行节点吃得下，提示词吃不下
    const fromLoop = portMenuTypes('loop', 'out')
    expect(fromLoop).toContain('image')
    expect(fromLoop).toContain('modelscope')
    expect(fromLoop).not.toContain('prompt')
    // 工作流不在候选里：它得先选一份定义，端口菜单给不出默认值
    expect(fromLoop).not.toContain('workflow')
  })

  it('上游候选的产出要能被来源吃下', () => {
    const intoImage = portMenuTypes('image', 'in')
    expect(intoImage).toContain('prompt')
    expect(intoImage).toContain('llm')
    expect(intoImage).toContain('image')
    // 图片节点不吃视频
    expect(intoImage).not.toContain('video')

    // 提示词没有输入端口，什么都接不进来（菜单那边据此换成一条说明，不留空白）
    expect(portMenuTypes('prompt', 'in')).toEqual([])
    // 音频只能往视频节点接，接不到图片生成节点上
    expect(portMenuTypes('audio', 'out')).toEqual(['video'])
  })
})

describe('运行态字段（BR-143）', () => {
  it('按节点类型声明要剥的字段', () => {
    expect(runtimeFieldsFor('image')).toEqual(CASCADE_RUNTIME_FIELDS)
    expect(runtimeFieldsFor('midjourney')).toContain('mj_last_buttons')
    expect(runtimeFieldsFor('midjourney')).toContain('mj_last_task_id')
    // 用户自己打的字属于文档态
    expect(runtimeFieldsFor('midjourney')).not.toContain('mj_modal_prompt')
    expect(runtimeFieldsFor('workflow')).toContain('completed_task_ids')
    expect(runtimeFieldsFor('image')).not.toContain('completed_task_ids')
    expect(runtimeFieldsFor('不存在的类型')).toEqual([])
  })

  it('stripRuntimeFields 只剥声明过的键，其余原样留下', async () => {
    const { stripRuntimeFields } = await import('../canvasStore')
    const stripped = stripRuntimeFields({
      id: 'mj',
      type: 'midjourney',
      x: 0,
      y: 0,
      title: 'Midjourney',
      mj_mode: 'imagine',
      mj_modal_prompt: '手打的重绘提示词',
      mj_last_task_id: 'prov-1',
      mj_last_buttons: [{ custom_id: 'U1', label: 'U1' }],
      cascade_status: 'failed',
      cascade_run_id: 'run-1',
      slot_of: 'src',
      slot_round: 2,
    })
    expect(stripped).toEqual({
      id: 'mj',
      type: 'midjourney',
      x: 0,
      y: 0,
      title: 'Midjourney',
      mj_mode: 'imagine',
      mj_modal_prompt: '手打的重绘提示词',
      slot_of: 'src',
      slot_round: 2,
    })
  })

  it('没有运行态字段的节点原样返回，不白复制一份', async () => {
    const { stripRuntimeFields } = await import('../canvasStore')
    const node = { id: 'p', type: 'prompt' as const, x: 0, y: 0, text: '词' }
    expect(stripRuntimeFields(node)).toBe(node)
  })
})

describe('保存报文不带运行态（BR-143）', () => {
  const CANVAS_ID = 11

  const detail = (nodes: CanvasNode[]): CanvasDetail => ({
    id: CANVAS_ID,
    title: '画布',
    icon: '',
    kind: 'smart',
    owner: '',
    color: '',
    pinned: false,
    project: '',
    board_x: null,
    board_y: null,
    nodes,
    connections: [],
    viewport: null,
    settings: {},
    version: 1,
    updated_at: '2026-08-22T10:00:00+00:00',
  })

  const flush = async (): Promise<void> => {
    for (let index = 0; index < 24; index += 1) await Promise.resolve()
  }

  beforeEach(() => {
    const globals = globalThis as Record<string, unknown>
    globals.window = {
      setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
      clearTimeout: (id: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(id),
      addEventListener: () => {},
      removeEventListener: () => {},
    }
    canvasFetch.mockReset()
    saveCanvas.mockReset()
    saveCanvas.mockResolvedValue({ version: 2, updated_at: '2026-08-22T10:00:01+00:00' })
  })

  afterEach(async () => {
    const { useCanvasStore } = await import('../canvasStore')
    useCanvasStore.getState().reset()
    delete (globalThis as Record<string, unknown>).window
  })

  it('cascade_* / mj_last_* / completed_task_ids 都不上送', async () => {
    const { flushSave, useCanvasStore } = await import('../canvasStore')
    canvasFetch.mockResolvedValueOnce(detail([]))
    await useCanvasStore.getState().load(CANVAS_ID)
    await flush()

    useCanvasStore.getState().addNode({
      id: 'mj',
      type: 'midjourney',
      x: 0,
      y: 0,
      mj_last_task_id: 'prov-1',
      mj_last_task_status: 'succeeded',
      cascade_status: 'failed',
      cascade_run_id: 'run-1',
    })
    useCanvasStore.getState().addNode({
      id: 'wf',
      type: 'workflow',
      x: 400,
      y: 0,
      workflow_id: 3,
      completed_task_ids: ['t-1'],
    })
    await flushSave()
    await flush()

    expect(saveCanvas).toHaveBeenCalled()
    const body = saveCanvas.mock.calls.at(-1)?.[1] as { nodes: Record<string, unknown>[] }
    const sent = Object.fromEntries(body.nodes.map((node) => [node.id as string, node]))
    expect(sent.mj).not.toHaveProperty('mj_last_task_id')
    expect(sent.mj).not.toHaveProperty('mj_last_task_status')
    expect(sent.mj).not.toHaveProperty('cascade_status')
    expect(sent.mj).not.toHaveProperty('cascade_run_id')
    expect(sent.wf).not.toHaveProperty('completed_task_ids')
    // 文档态照旧上送
    expect(sent.wf.workflow_id).toBe(3)
    // store 里的运行态不受影响，界面照常显示失败横幅
    expect(useCanvasStore.getState().nodes.find((node) => node.id === 'mj')?.cascade_status).toBe('failed')
  })
})
