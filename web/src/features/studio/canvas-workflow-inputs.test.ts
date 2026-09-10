import { describe, expect, it } from 'vitest'

import type {
  CanvasItem,
  CanvasNode,
  ExecutableWorkflowDetail,
} from '../../lib/api-studio'
import { prepareCanvasWorkflowRun } from './canvasWorkflowInputs'

function detail(fields: Record<string, unknown>[], title = '测试工作流'): ExecutableWorkflowDetail {
  return {
    id: 1,
    key: 'test',
    title,
    provider: 'runninghub',
    kind: 'workflow',
    source: 'user',
    source_id: 'source-1',
    enabled: true,
    node_count: 1,
    field_count: fields.length,
    has_thumbnail: false,
    content_hash: 'hash',
    version: 1,
    created_at: '',
    updated_at: '',
    payload: {},
    ui_schema: { fields },
  }
}

const node: CanvasNode = {
  id: 'workflow',
  type: 'workflow',
  x: 0,
  y: 0,
  workflow_id: 1,
}

describe('prepareCanvasWorkflowRun · 手动与级联同源字段绑定', () => {
  it('按字段顺序绑定图片/视频，提示词和随机参数也进入快照', () => {
    const media: CanvasItem[] = [
      { kind: 'image', asset_id: 11 },
      { kind: 'video', media_asset_id: 22, url: '/video.mp4' },
    ]
    const prepared = prepareCanvasWorkflowRun(
      detail([
        { id: 'image', type: 'image', required: true },
        { id: 'video', type: 'video', required: true },
        { id: 'prompt', type: 'textarea', bind_prompt: true },
        { id: 'seed', type: 'integer', random_enabled: true, min: 10, max: 20 },
      ]),
      node,
      media,
      '电影感夜景',
      () => 0.5,
    )
    expect(prepared.fields).toEqual({
      image: 'asset:11',
      video: 'media:22',
      prompt: '电影感夜景',
      seed: 15,
    })
    expect(prepared.missingMedia).toEqual([])
  })

  it('显式文件值优先，缺失的必填音频给出字段名', () => {
    const prepared = prepareCanvasWorkflowRun(
      detail([
        { id: 'image', name: '主图', type: 'image', required: true },
        { id: 'audio', name: '配乐', type: 'audio', required: true },
      ]),
      { ...node, workflow_values: { image: 'https://example.test/input.png' } },
      [],
      '',
    )
    expect(prepared.fields.image).toBe('https://example.test/input.png')
    expect(prepared.missingMedia).toEqual(['配乐'])
  })

  it('MiniMax 级联冻结启动时选中的片段', () => {
    const prepared = prepareCanvasWorkflowRun(
      detail([{ id: 'f_prompt', type: 'textarea' }], 'MiniMax H3'),
      {
        ...node,
        workflow_timeline: {
          kind: 'minimax',
          selected_id: 'segment-2',
          segments: [
            { id: 'segment-2', start: 0, length: 6, prompt: '第二段', type: 'text' },
          ],
        },
      },
      [],
      '上游提示词',
      () => 0,
    )
    expect(prepared.sourceContext).toEqual({ workflow_segment_id: 'segment-2' })
    expect(prepared.fields.f_prompt).toBe('第二段')
  })

  it('MiniMax RunningHub 按语义与固定兜底键映射当前片段，不泄漏内部字段', () => {
    const prepared = prepareCanvasWorkflowRun(
      detail([
        { id: '138::value', nodeId: '138', fieldName: 'value', label: 'Prompt', enabled: true },
        { id: '132::value', nodeId: '132', fieldName: 'value', label: '片段时长', enabled: true },
        {
          id: '115::aspect_ratio',
          nodeId: '115',
          fieldName: 'aspect_ratio',
          label: '画面比例',
          options: ['16:9 (Widescreen)', '9:16 (Portrait)'],
          enabled: true,
        },
        { id: '115::megapixels', nodeId: '115', fieldName: 'megapixels', enabled: true },
        { id: '120::seed', nodeId: '120', fieldName: 'seed', enabled: true },
        { id: '20::image', nodeId: '20', fieldName: 'image', fieldType: 'IMAGE', enabled: true },
        { id: '21::video', nodeId: '21', fieldName: 'video', fieldType: 'VIDEO', enabled: true },
        { id: '22::audio', nodeId: '22', fieldName: 'audio', fieldType: 'AUDIO', enabled: true },
      ], 'Minimax-多参视频生成'),
      {
        ...node,
        workflow_timeline: {
          kind: 'minimax',
          selected_id: 'segment-rh',
          segments: [{
            id: 'segment-rh',
            start: 0,
            length: 7.5,
            prompt: 'orbit around the subject',
            type: 'text',
            aspect_ratio: '9:16 (Portrait)',
            megapixels: 0.7,
            seed: 42,
            references: [
              { kind: 'image', asset_id: 11 },
              { kind: 'video', media_asset_id: 22 },
              { kind: 'audio', media_asset_id: 33 },
            ],
          }],
        },
      },
      [{ kind: 'image', asset_id: 99 }],
      'fallback prompt',
    )

    expect(prepared.fields).toEqual({
      '138::value': 'orbit around the subject',
      '132::value': 7.5,
      '115::aspect_ratio': '9:16 (Portrait)',
      '115::megapixels': 0.7,
      '120::seed': 42,
      '20::image': 'asset:11',
      '21::video': 'media:22',
      '22::audio': 'media:33',
    })
    expect(prepared.sourceContext).toEqual({ workflow_segment_id: 'segment-rh' })
    expect(Object.keys(prepared.fields).some((key) => key.startsWith('f_'))).toBe(false)
  })

  it('MiniMax 空参考轨与源项目一致，运行时回退到上游素材', () => {
    const prepared = prepareCanvasWorkflowRun(
      detail([
        { id: '20::image', nodeId: '20', fieldName: 'image', fieldType: 'IMAGE', enabled: true },
        { id: '21::video', nodeId: '21', fieldName: 'video', fieldType: 'VIDEO', enabled: true },
      ], 'Minimax-多参视频生成'),
      {
        ...node,
        workflow_timeline: {
          kind: 'minimax',
          selected_id: 'segment-empty',
          segments: [{
            id: 'segment-empty',
            start: 0,
            length: 6,
            prompt: '',
            type: 'text',
            references: [],
          }],
        },
      },
      [
        { kind: 'image', asset_id: 41 },
        { kind: 'video', media_asset_id: 42 },
      ],
      'upstream prompt',
    )

    expect(prepared.fields).toEqual({
      '20::image': 'asset:41',
      '21::video': 'media:42',
    })
  })
})
