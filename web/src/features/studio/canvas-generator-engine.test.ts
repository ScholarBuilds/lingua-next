import { describe, expect, it } from 'vitest'

import type { ExecutableWorkflow } from '../../lib/api-studio'
import type { ScvNode } from './canvasStore'
import {
  canvasGeneratorEngine,
  generatorEnginePatch,
  workflowNodePatch,
} from './CanvasGeneratorEngine'

const node = (over: Partial<ScvNode> = {}): ScvNode => ({
  id: 'generator',
  type: 'image',
  x: 10,
  y: 20,
  ...over,
})

describe('智能画布统一引擎', () => {
  it('按专用节点类型还原源项目的五档引擎值', () => {
    expect(canvasGeneratorEngine(node())).toBe('api-image')
    expect(canvasGeneratorEngine(node({ type: 'video' }))).toBe('api-video')
    expect(canvasGeneratorEngine(node({ type: 'modelscope' }))).toBe('modelscope')
    expect(canvasGeneratorEngine(node({ type: 'workflow', workflow_provider: 'comfyui' }))).toBe('comfyui')
    expect(canvasGeneratorEngine(node({ type: 'workflow', workflow_provider: 'runninghub' }))).toBe('runninghub')
  })

  it('切换引擎只覆盖目标缺省值，旧引擎参数可在切回时恢复', () => {
    const source = node({
      run_settings: { quality: 'high', size: '1024x1024' },
      video_settings: { duration: 12, resolution: '1080p' },
      ms_size: '1536x1024',
      ms_count: 4,
      workflow_id: 7,
      workflow_values: { seed: 42 },
    })
    const video = { ...source, ...generatorEnginePatch(source, 'api-video') }
    expect(video.video_settings).toMatchObject({ duration: 12, resolution: '1080p' })
    const modelscope = { ...video, ...generatorEnginePatch(video, 'modelscope') }
    expect(modelscope).toMatchObject({ type: 'modelscope', ms_size: '1536x1024', ms_count: 4 })
    expect(modelscope.run_settings).toEqual(source.run_settings)
    expect(modelscope.workflow_values).toEqual({ seed: 42 })
  })

  it('选工作流时生成可直接覆盖原节点的类型化配置', () => {
    const workflow: ExecutableWorkflow = {
      id: 9,
      key: 'demo',
      title: '演示工作流',
      provider: 'runninghub',
      kind: 'app',
      source: 'user',
      source_id: 'rh-9',
      enabled: true,
      node_count: 3,
      field_count: 4,
      has_thumbnail: true,
      content_hash: 'sha',
      version: 1,
      created_at: '',
      updated_at: '',
    }
    expect(workflowNodePatch(workflow)).toMatchObject({
      type: 'workflow',
      workflow_id: 9,
      workflow_provider: 'runninghub',
      workflow_kind: 'app',
      workflow_values: {},
    })
  })
})
