/* 提示词组装的守卫测试。
 *
   守的是一条**丢数据**的链路：`提示词 → 循环 → 图片`。
   `composePrompt` 的 takeText 原来只认 prompt 与 group，遇到 loop 直接 return，
   于是提示词节点的文字整段消失——图照出、任务 done、界面一切正常，只是词没了。

   还守拼接顺序：循环的贡献必须排在**本节点草稿之前**（蓝本同款）。
   靠后的指令对模型权重更高，把轮次词甩到最后会让每轮的差异被本节点草稿盖住。 */

import { describe, expect, it } from 'vitest'

import {
  MAX_REFS,
  MODELSCOPE_MAX_REFS,
  cascadePlan,
  cascadeRetryOrder,
  composePrompt,
  llmInputText,
  loopPromptItems,
  midjourneyActionLayout,
  modelScopeJobOptions,
  videoReferenceInputs,
  videoRequestOptions,
  workflowTimelineWithResult,
} from './canvasStore'
import type { ScvNode } from './canvasStore'
import type { CanvasConnection, CanvasItem } from '../../lib/api-studio'
import {
  ltxFrameFromPointer,
  ltxMoveSegments,
  ltxResizeSegments,
  ltxVisualDuration,
  minimaxAddReference,
  minimaxPlayheadFromPointer,
  workflowTimelineNewSegment,
  workflowTimelineRunValues,
} from './WorkflowTimelineEditor'

const node = (id: string, over: Partial<ScvNode> = {}): ScvNode =>
  ({ id, type: 'image', x: 0, y: 0, ...over }) as ScvNode

const link = (from: string, to: string, kind: CanvasConnection['kind'] = 'input'): CanvasConnection =>
  ({ from, to, kind }) as CanvasConnection

describe('loopPromptItems · 循环中继上游提示词', () => {
  it('取到直连的提示词节点', () => {
    const nodes = [node('p1', { type: 'prompt', text: '夜色星空' }), node('lp', { type: 'loop' })]
    expect(loopPromptItems(nodes, [link('p1', 'lp')], 'lp')).toEqual(['夜色星空'])
  })

  it('多个上游按连线顺序拉平', () => {
    const nodes = [
      node('p1', { type: 'prompt', text: 'A' }),
      node('p2', { type: 'prompt', text: 'B' }),
      node('lp', { type: 'loop' }),
    ]
    expect(loopPromptItems(nodes, [link('p1', 'lp'), link('p2', 'lp')], 'lp')).toEqual(['A', 'B'])
  })

  it('穿透分组，取组内的提示词成员', () => {
    const nodes = [
      node('pm', { type: 'prompt', text: '组内词' }),
      node('g', { type: 'group', member_ids: ['pm'] }),
      node('lp', { type: 'loop' }),
    ]
    expect(loopPromptItems(nodes, [link('g', 'lp')], 'lp')).toEqual(['组内词'])
  })

  it('循环串循环时递归穿透', () => {
    const nodes = [
      node('p1', { type: 'prompt', text: '最上游' }),
      node('lp1', { type: 'loop' }),
      node('lp2', { type: 'loop' }),
    ]
    expect(loopPromptItems(nodes, [link('p1', 'lp1'), link('lp1', 'lp2')], 'lp2')).toEqual(['最上游'])
  })

  it('两个循环互连时返回空而不是栈溢出', () => {
    const nodes = [node('a', { type: 'loop' }), node('b', { type: 'loop' })]
    expect(loopPromptItems(nodes, [link('a', 'b'), link('b', 'a')], 'a')).toEqual([])
  })

  it('空白提示词被丢掉，不占一个轮次位', () => {
    const nodes = [
      node('p1', { type: 'prompt', text: '   ' }),
      node('p2', { type: 'prompt', text: '有效' }),
      node('lp', { type: 'loop' }),
    ]
    expect(loopPromptItems(nodes, [link('p1', 'lp'), link('p2', 'lp')], 'lp')).toEqual(['有效'])
  })

  it('history 边不参与——归档链不该把旧词带回来', () => {
    const nodes = [node('p1', { type: 'prompt', text: '旧词' }), node('lp', { type: 'loop' })]
    expect(loopPromptItems(nodes, [link('p1', 'lp', 'history')], 'lp')).toEqual([])
  })
})

describe('composePrompt · 循环贡献的位置', () => {
  const nodes = [
    node('p1', { type: 'prompt', text: '上游词' }),
    node('lp', { type: 'loop' }),
    node('img', { type: 'image', prompt_draft: '本节点草稿' }),
  ]
  const conns = [link('p1', 'lp'), link('lp', 'img')]

  it('不传 loopContribution 时跳过循环——单节点出图不该被轮次词污染', () => {
    expect(composePrompt(nodes, conns, 'img')).toBe('本节点草稿')
  })

  it('传了就把循环的贡献拼进来，且**排在本节点草稿之前**', () => {
    const got = composePrompt(nodes, conns, 'img', () => '第3轮的词')
    expect(got).toBe('第3轮的词\n本节点草稿')
    // 顺序是硬要求：靠后的指令权重更高，轮次词甩到最后会被草稿盖住
    expect(got.indexOf('第3轮的词')).toBeLessThan(got.indexOf('本节点草稿'))
  })

  it('循环贡献为空时不留空行', () => {
    expect(composePrompt(nodes, conns, 'img', () => '  ')).toBe('本节点草稿')
  })

  it('本节点没有草稿时只剩循环的贡献', () => {
    const only = [node('lp', { type: 'loop' }), node('img', { type: 'image' })]
    expect(composePrompt(only, [link('lp', 'img')], 'img', () => '只有轮次词')).toBe('只有轮次词')
  })

  it('普通提示词节点直连时照旧工作，没被这次改动影响', () => {
    const plain = [
      node('p', { type: 'prompt', text: '直连词' }),
      node('img', { type: 'image', prompt_draft: '草稿' }),
    ]
    expect(composePrompt(plain, [link('p', 'img')], 'img')).toBe('直连词\n草稿')
  })

  it('重复文本只出现一次——同一条词连了两条边不该拼两遍', () => {
    const dup = [
      node('p', { type: 'prompt', text: '同一句' }),
      node('img', { type: 'image', prompt_draft: '同一句' }),
    ]
    expect(composePrompt(dup, [link('p', 'img')], 'img')).toBe('同一句')
  })
})

describe('cascadeRetryOrder · 从失败节点继续', () => {
  it('只保留失败节点及其下游，并按 input 拓扑排序', () => {
    const nodes = ['source', 'failed', 'left', 'right', 'tail', 'history-only']
      .map((id) => node(id))
    const connections = [
      link('source', 'failed'),
      link('failed', 'left'),
      link('failed', 'right'),
      link('left', 'tail'),
      link('right', 'tail'),
      link('failed', 'history-only', 'history'),
    ]

    const order = cascadeRetryOrder(nodes, connections, 'failed')
    expect(order[0]).toBe('failed')
    expect(new Set(order)).toEqual(new Set(['failed', 'left', 'right', 'tail']))
    expect(order.indexOf('tail')).toBeGreaterThan(order.indexOf('left'))
    expect(order.indexOf('tail')).toBeGreaterThan(order.indexOf('right'))
  })

  it('异常环路不会卡死，且每个下游只返回一次', () => {
    const nodes = ['failed', 'a', 'b'].map((id) => node(id))
    const order = cascadeRetryOrder(
      nodes,
      [link('failed', 'a'), link('a', 'b'), link('b', 'failed')],
      'failed',
    )
    expect(order).toEqual(['failed', 'a', 'b'])
  })

  it('失败节点被删后不构造虚假的重试链', () => {
    expect(cascadeRetryOrder([node('other')], [], 'missing')).toEqual([])
  })
})

describe('cascadePlan · 类型化级联调用数', () => {
  it('图片、LLM 与 ModelScope 都计为执行节点，ModelScope 张数计入调用数', () => {
    const nodes = [
      node('loop', { type: 'loop', count: 2 }),
      node('llm', { type: 'llm' }),
      node('ms', { type: 'modelscope', ms_count: 3 }),
      node('image'),
    ]
    const plan = cascadePlan(
      nodes,
      [link('loop', 'llm'), link('llm', 'ms'), link('ms', 'image')],
      'image',
    )
    expect(plan.imageNodes).toBe(1)
    expect(plan.executableNodes).toBe(3)
    expect(plan.rounds).toBe(2)
    expect(plan.gens).toBe(10)
    expect(plan.hasLoop).toBe(true)
    expect(plan.canRun).toBe(true)
  })

  it('视频与 Midjourney 纳入异步级联调用数', () => {
    const nodes = [
      node('video', { type: 'video' }),
      node('mj', { type: 'midjourney' }),
      node('image'),
    ]
    const plan = cascadePlan(nodes, [link('video', 'mj'), link('mj', 'image')], 'image')
    expect(plan.executableNodes).toBe(3)
    expect(plan.gens).toBe(3)
  })

  it('工作流节点每轮计一次持久任务', () => {
    const nodes = [node('workflow', { type: 'workflow' }), node('image')]
    const plan = cascadePlan(nodes, [link('workflow', 'image')], 'image')
    expect(plan.executableNodes).toBe(2)
    expect(plan.gens).toBe(2)
  })

  it('独立单节点不冒充整条链，入口只出现在末端执行节点', () => {
    const nodes = [node('image'), node('video', { type: 'video' })]
    const connections = [link('image', 'video')]

    expect(cascadePlan(nodes, [], 'image').canRun).toBe(false)
    expect(cascadePlan(nodes, connections, 'image').canRun).toBe(false)
    expect(cascadePlan(nodes, connections, 'video').canRun).toBe(true)
  })

  it('一轮循环也算级联，不能因 rounds 等于 1 隐藏入口', () => {
    const nodes = [
      node('loop', { type: 'loop', count: 1 }),
      node('workflow', { type: 'workflow' }),
    ]
    const connections = [link('loop', 'workflow')]

    const fromLoop = cascadePlan(nodes, connections, 'loop')
    const fromTail = cascadePlan(nodes, connections, 'workflow')
    expect(fromLoop).toMatchObject({ hasLoop: true, rounds: 1, canRun: true })
    expect(fromTail).toMatchObject({ hasLoop: true, rounds: 1, canRun: true })
  })
})

describe('composePrompt · 参考图编号必须指得到真图', () => {
  const withRefs = (n: number): ScvNode =>
    node('img', {
      type: 'image',
      prompt_draft: Array.from({ length: n }, (_, i) => `图${i + 1}`).join('，'),
      prompt_draft_refs: Array.from({ length: n }, (_, i) => ({
        asset_id: 100 + i,
        label: `素材${i + 1}`,
        thumb_url: '',
      })),
    } as Partial<ScvNode>)

  it('没超限时每一张都进映射表', () => {
    const got = composePrompt([withRefs(3)], [], 'img')
    expect(got).toContain('图1：素材1')
    expect(got).toContain('图3：素材3')
  })

  it('超限的那些**不进映射表**——它们不会上送，编号会指向空', () => {
    const got = composePrompt([withRefs(MAX_REFS + 3)], [], 'img')
    expect(got).toContain(`图${MAX_REFS}：素材${MAX_REFS}`)
    expect(got).not.toContain(`图${MAX_REFS + 1}：`)
  })

  it('正文里超限的「图N」降级成「@名字」，而不是留一个指不到的编号', () => {
    const got = composePrompt([withRefs(MAX_REFS + 2)], [], 'img')
    // 映射表那一段本身含 "图N："，所以只在正文段里找
    const body = got.split('用户需求：')[1] ?? ''
    expect(body).not.toContain(`图${MAX_REFS + 1}`)
    expect(body).toContain(`@素材${MAX_REFS + 1}`)
    expect(body).toContain(`@素材${MAX_REFS + 2}`)
  })

  it('没有引用时不摆空映射表', () => {
    const plain = node('img', { type: 'image', prompt_draft: '就一句话' })
    expect(composePrompt([plain], [], 'img')).toBe('就一句话')
  })

  it('上限是个够用的数——10 太小，@ 二十张是常见用法', () => {
    expect(MAX_REFS).toBeGreaterThanOrEqual(20)
  })
})

describe('LLM 节点文字链路', () => {
  it('提示词连到 LLM 时成为它的输入', () => {
    const nodes = [
      node('p', { type: 'prompt', text: '把画面改成夜景' }),
      node('ai', { type: 'llm', llm_input: '这句不该覆盖连线' }),
    ]
    expect(llmInputText(nodes, [link('p', 'ai')], 'ai')).toBe('把画面改成夜景')
  })

  it('LLM 的输出能直接喂给下游生成节点', () => {
    const nodes = [
      node('ai', { type: 'llm', llm_output: 'cinematic night, volumetric light' }),
      node('img', { type: 'image', prompt_draft: '保留人物' }),
    ]
    expect(composePrompt(nodes, [link('ai', 'img')], 'img')).toBe(
      'cinematic night, volumetric light\n保留人物',
    )
  })

  it('循环和分组中的 LLM 输出也不会丢', () => {
    const nodes = [
      node('ai', { type: 'llm', llm_output: '组内改写结果' }),
      node('g', { type: 'group', member_ids: ['ai'] }),
      node('lp', { type: 'loop' }),
      node('target', { type: 'llm' }),
    ]
    const connections = [link('g', 'lp'), link('lp', 'target')]
    expect(loopPromptItems(nodes, connections, 'lp')).toEqual(['组内改写结果'])
    expect(llmInputText(nodes, connections, 'target')).toBe('组内改写结果')
  })

  it('history 边不应该倒灌旧输出', () => {
    const nodes = [
      node('ai1', { type: 'llm', llm_output: '旧结果' }),
      node('ai2', { type: 'llm' }),
    ]
    expect(llmInputText(nodes, [link('ai1', 'ai2', 'history')], 'ai2')).toBe('')
  })
})

describe('Midjourney 二次操作面板', () => {
  it('V8 四图结果给 R/R+ 重塑面板', () => {
    expect(midjourneyActionLayout('8.2', 4)).toBe('remix-grid')
    expect(midjourneyActionLayout('8.1', 4)).toBe('remix-grid')
  })

  it('旧版四图结果保留 U/V 面板', () => {
    expect(midjourneyActionLayout('7', 4)).toBe('legacy-grid')
    expect(midjourneyActionLayout('6.1', 8)).toBe('legacy-grid')
  })

  it('单图开放变体、缩放、平移和重绘，MODAL 阶段关闭其他操作', () => {
    expect(midjourneyActionLayout('8.2', 1)).toBe('single')
    expect(midjourneyActionLayout('8.2', 1, true)).toBe('none')
    expect(midjourneyActionLayout('8.2', 0)).toBe('none')
  })
})

describe('ModelScope 节点请求快照', () => {
  it('只下发已启用且有效的原生参数', () => {
    expect(
      modelScopeJobOptions(
        node('ms', {
          type: 'modelscope',
          ms_negative_prompt: '  text, watermark  ',
          ms_seed: -7,
          ms_steps: 140,
          ms_guidance: 30,
          ms_lora_enabled: true,
          ms_lora_id: ' org/ink-style ',
          ms_lora_strength: 1.4,
        }),
        [11, 12],
      ),
    ).toEqual({
      negative_prompt: 'text, watermark',
      seed: 0,
      steps: 100,
      guidance: 20,
      loras: { 'org/ink-style': 1 },
      ref_asset_ids: [11, 12],
    })
  })

  it('空高级项不混入请求，参考图按服务端上限截断', () => {
    const refs = Array.from({ length: MODELSCOPE_MAX_REFS + 3 }, (_, index) => index + 1)
    expect(
      modelScopeJobOptions(
        node('ms', {
          type: 'modelscope',
          ms_negative_prompt: ' ',
          ms_lora_enabled: true,
          ms_lora_id: ' ',
        }),
        refs,
      ),
    ).toEqual({ ref_asset_ids: refs.slice(0, MODELSCOPE_MAX_REFS) })
  })
})

describe('视频节点请求快照', () => {
  const refs = [11, 12, 13]

  it('OpenAI 只使用一张参考图，不混入火山专有参数', () => {
    const settings = {
      reference_mode: 'multimodal' as const,
      generate_audio: true,
      watermark: true,
      fixed_camera: true,
      seed: 17,
    }
    expect(videoReferenceInputs(refs, settings, 'openai')).toEqual([
      { asset_id: 11, role: 'first_frame' },
    ])
    expect(videoRequestOptions(settings, 'openai', true)).toEqual({})
  })

  it('火山首尾帧模式给前两张标注角色', () => {
    expect(
      videoReferenceInputs(refs, { reference_mode: 'first_last' }, 'volcengine'),
    ).toEqual([
      { asset_id: 11, role: 'first_frame' },
      { asset_id: 12, role: 'last_frame' },
    ])
  })

  it('火山多参考模式保持顺序，并将随机种子限制在协议范围', () => {
    expect(videoReferenceInputs(refs, { reference_mode: 'multimodal' }, 'volcengine')).toEqual([
      { asset_id: 11, role: 'reference_image' },
      { asset_id: 12, role: 'reference_image' },
      { asset_id: 13, role: 'reference_image' },
    ])
    expect(
      videoRequestOptions(
        { generate_audio: true, watermark: true, fixed_camera: true, seed: 2 ** 40 },
        'volcengine',
        true,
      ),
    ).toEqual({
      generate_audio: true,
      watermark: true,
      camera_fixed: false,
      seed: 2 ** 32 - 1,
    })
  })

  it('无参考图时固定机位才会下发', () => {
    expect(videoRequestOptions({ fixed_camera: true, seed: -7 }, 'volcengine', false)).toEqual({
      generate_audio: false,
      watermark: false,
      camera_fixed: true,
      seed: -1,
    })
  })
})

describe('LTX Director 帧级请求快照', () => {
  it('按缩放后的轨道位置换算帧，并为越界素材保留 30% 可视尾区', () => {
    expect(ltxFrameFromPointer(240, 350, 110, 480)).toBe(120)
    expect(ltxFrameFromPointer(240, 20, 110, 480)).toBe(0)
    expect(ltxVisualDuration(
      120,
      [{ start: 120, length: 30 }],
      [{ start: 20, length: 40 }],
    )).toBe(195)
  })

  it('中心拖动按插入点推挤冲突片段且不产生重叠', () => {
    const moved = ltxMoveSegments([
      { id: 'a', start: 0, length: 24 },
      { id: 'b', start: 30, length: 24 },
      { id: 'c', start: 60, length: 24 },
    ], 'c', 6, 10, 120)

    expect(moved.map(({ id, start, length }) => ({ id, start, length }))).toEqual([
      { id: 'c', start: 0, length: 24 },
      { id: 'a', start: 24, length: 24 },
      { id: 'b', start: 48, length: 24 },
    ])
  })

  it('相邻边界执行滚动编辑，音频左裁剪同步素材入点', () => {
    const rolled = ltxResizeSegments([
      { id: 'a', start: 0, length: 24, prompt: '', type: 'text' as const },
      { id: 'b', start: 24, length: 24, prompt: '', type: 'text' as const },
    ], { type: 'joint', id: 'a', rightId: 'b' }, 6, 120)
    expect(rolled.map(({ start, length }) => ({ start, length }))).toEqual([
      { start: 0, length: 30 },
      { start: 30, length: 18 },
    ])

    const trimmed = ltxResizeSegments([{
      id: 'voice',
      start: 20,
      length: 30,
      trim_start: 10,
      audio_duration_frames: 60,
    }], { type: 'left', id: 'voice' }, -8, 120)
    expect(trimmed[0]).toMatchObject({ start: 12, length: 38, trim_start: 2 })
  })

  it('保留空隙并在运行中吸收到相邻片段，同时按总帧数裁切', () => {
    const values = workflowTimelineRunValues(
      'ltx',
      node('ltx', {
        type: 'workflow',
        workflow_values: { f_global_prompt: 'global paper world' },
        workflow_timeline: {
          kind: 'ltx',
          frame_rate: 24,
          duration_frames: 120,
          selected_id: 'shot-1',
          selected_audio_id: 'voice-1',
          segments: [
            {
              id: 'shot-1',
              start: 24,
              length: 24,
              prompt: '',
              type: 'text',
            },
            {
              id: 'shot-2',
              start: 72,
              length: 60,
              prompt: 'camera dives',
              type: 'image',
              asset_id: 8,
              guideStrength: 1.25,
            },
          ],
          audio_segments: [{
            id: 'voice-1',
            start: 12,
            length: 72,
            trim_start: 6,
            audio_duration_frames: 90,
            media_asset_id: 19,
            name: 'voice.mp3',
          }],
        },
      }),
      [8],
      '',
    )

    expect(values).toMatchObject({
      f_local_prompts: 'global paper world | camera dives',
      f_segment_lengths: '72,48',
      f_guide_strength: '1.25',
      f_duration_frames: 120,
      f_duration_seconds: 5,
      f_frame_rate: 24,
    })
    expect(JSON.parse(String(values.f_timeline_data))).toEqual({
      segments: [
        {
          id: 'shot-1',
          start: 24,
          length: 24,
          prompt: 'global paper world',
          type: 'text',
        },
        {
          id: 'shot-2',
          start: 72,
          length: 60,
          prompt: 'camera dives',
          type: 'image',
          asset_id: 8,
          guideStrength: '1.25',
        },
      ],
      audioSegments: [{
        id: 'voice-1',
        type: 'audio',
        start: 12,
        length: 72,
        trimStart: 6,
        audioDurationFrames: 90,
        media_asset_id: 19,
        fileName: 'voice.mp3',
      }],
    })
  })

  it('新增片段使用一秒帧长，不复制已有提示词', () => {
    const segment = workflowTimelineNewSegment(
      'ltx',
      node('ltx', {
        type: 'workflow',
        workflow_values: { f_frame_rate: 30, f_global_prompt: 'do not copy' },
      }),
      'text',
      undefined,
      1,
      'linked prompt',
    )

    expect(segment).toMatchObject({
      start: 0,
      length: 30,
      prompt: '',
      type: 'text',
    })
  })
})

describe('MiniMax H3 分镜请求快照', () => {
  it('刻度尺拖动按轨道宽度换算并夹在时间线范围内', () => {
    expect(minimaxPlayheadFromPointer(20, 150, 100, 200)).toBe(5)
    expect(minimaxPlayheadFromPointer(20, 20, 100, 200)).toBe(0)
    expect(minimaxPlayheadFromPointer(20, 400, 100, 200)).toBe(20)
    expect(minimaxPlayheadFromPointer(20, 150, 100, 0)).toBe(0)
  })

  it('拖入参考时去重，并分别执行图片 9 个、视频和音频 3 个的上限', () => {
    const images: CanvasItem[] = Array.from({ length: 9 }, (_, index) => ({
      asset_id: 100 + index,
      kind: 'image',
    }))
    const videos: CanvasItem[] = Array.from({ length: 3 }, (_, index) => ({
      media_asset_id: 200 + index,
      kind: 'video',
    }))
    const references = [...images, ...videos]

    expect(minimaxAddReference(references, images[0])).toBe(references)
    expect(minimaxAddReference(references, { asset_id: 999, kind: 'image' })).toBe(references)
    expect(minimaxAddReference(references, { media_asset_id: 999, kind: 'video' })).toBe(references)
    expect(minimaxAddReference(references, { media_asset_id: 301, kind: 'audio' })).toEqual([
      ...references,
      { media_asset_id: 301, kind: 'audio' },
    ])
  })

  it('新增片段与源项目一致：内容为空，继承片长与画面参数并重置裁剪', () => {
    const added = workflowTimelineNewSegment(
      'minimax',
      node('minimax', {
        type: 'workflow',
        workflow_values: {
          f_prompt: '不应复制到新片段',
          f_duration_seconds: 12,
          f_aspect_ratio: '1:1 (Square)',
          f_megapixels: 1,
          f_seed: 99,
        },
      }),
      'text',
      undefined,
      2,
      '也不应复制的上游提示词',
      {
        id: 'shot-2',
        start: 8,
        length: 5,
        prompt: '当前片段',
        type: 'text',
        aspect_ratio: '9:16 (Portrait)',
        megapixels: 0.7,
        seed: 42,
        trim_in: 0.5,
        trim_out: 4.2,
        references: [{ media_asset_id: 7, kind: 'video' }],
        result: { media_asset_id: 8, kind: 'video' },
      },
    )

    expect(added).toMatchObject({
      length: 5,
      prompt: '',
      type: 'text',
      references: [],
      aspect_ratio: '9:16 (Portrait)',
      megapixels: 0.7,
      trim_in: 0,
      trim_out: 5,
    })
    expect(added.asset_id).toBeUndefined()
    expect(added.result).toBeUndefined()
    expect(added.seed).toBeUndefined()
  })

  it('使用当前片段自己的多模态参考并按官方节点槽位截断', () => {
    const references = [
      ...Array.from({ length: 10 }, (_, index) => ({
        asset_id: 100 + index,
        kind: 'image' as const,
      })),
      ...Array.from({ length: 4 }, (_, index) => ({
        media_asset_id: 200 + index,
        kind: 'video' as const,
      })),
      ...Array.from({ length: 4 }, (_, index) => ({
        media_asset_id: 300 + index,
        kind: 'audio' as const,
      })),
    ]
    const values = workflowTimelineRunValues(
      'minimax',
      node('minimax', {
        type: 'workflow',
        workflow_timeline: {
          kind: 'minimax',
          selected_id: 'shot-1',
          segments: [{
            id: 'shot-1',
            start: 0,
            length: 7.5,
            prompt: 'camera orbits around the subject',
            type: 'text',
            aspect_ratio: '9:16 (Portrait)',
            megapixels: 0.7,
            seed: 42,
            references,
          }],
        },
      }),
      [],
      'fallback prompt',
      references,
    )

    expect(values).toMatchObject({
      f_reference_image: 'asset:100',
      f_prompt: 'camera orbits around the subject',
      f_duration_seconds: 7.5,
      f_aspect_ratio: '9:16 (Portrait)',
      f_megapixels: 0.7,
      f_seed: 42,
    })
    expect(values.f_minimax_references).toEqual([
      ...Array.from({ length: 9 }, (_, index) => ({
        kind: 'image',
        ref: `asset:${100 + index}`,
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        kind: 'video',
        ref: `media:${200 + index}`,
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        kind: 'audio',
        ref: `media:${300 + index}`,
      })),
    ])
  })

  it('旧分镜没有显式参考时使用连接到节点的多模态素材', () => {
    const values = workflowTimelineRunValues(
      'minimax',
      node('minimax', {
        type: 'workflow',
        workflow_timeline: {
          kind: 'minimax',
          selected_id: 'shot-1',
          segments: [{
            id: 'shot-1',
            start: 0,
            length: 8,
            prompt: '',
            type: 'text',
          }],
        },
      }),
      [],
      'linked prompt',
      [
        { asset_id: 11, kind: 'image' },
        { media_asset_id: 12, kind: 'video' },
        { media_asset_id: 13, kind: 'audio' },
      ],
    )

    expect(values.f_minimax_references).toEqual([
      { kind: 'image', ref: 'asset:11' },
      { kind: 'video', ref: 'media:12' },
      { kind: 'audio', ref: 'media:13' },
    ])
    expect(values.f_prompt).toBe('linked prompt')
  })

  it('后台任务完成时只把结果写回任务启动时选中的片段', () => {
    const first = {
      id: 'shot-1', start: 0, length: 8, prompt: 'one', type: 'text' as const,
    }
    const second = {
      id: 'shot-2', start: 8, length: 8, prompt: 'two', type: 'text' as const,
    }
    const timeline = workflowTimelineWithResult(
      { kind: 'minimax', selected_id: 'shot-2', segments: [first, second] },
      'shot-1',
      { kind: 'video', media_asset_id: 77, url: '/video/77' },
    )

    expect(timeline?.segments[0]?.result).toEqual({
      kind: 'video', media_asset_id: 77, url: '/video/77',
    })
    expect(timeline?.segments[1]?.result).toBeUndefined()
  })
})
