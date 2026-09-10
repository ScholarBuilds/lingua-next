import { describe, expect, it } from 'vitest'

import type { ImageAsset } from '@/lib/api-image'
import type { StudioTask } from '@/lib/api-studio'

import {
  deploymentPage,
  onlineAspectFromSize,
  onlineHistoryItems,
  onlineImageSize,
  onlineReferenceAssetIds,
  onlineResolutionFromSize,
  onlineResultAssetIds,
  onlineWorkflowFields,
  preferredOnlineWorkflowValue,
} from './online-image-history'

function asset(id: number, status: ImageAsset['status'] = 'candidate'): ImageAsset {
  return {
    id, display_name: null, sha: String(id), url: `/display/${id}`, thumb_url: `/thumb/${id}`,
    full_url: `/full/${id}`, width: 1024, height: 1024, bytes: 10, mime: 'image/png',
    target_key: 'free', style_key: null, prompt: `asset-${id}`, prompt_structure: null,
    brief: null, alias: null, model: 'test', size_req: '1024x1024', quality: 'auto',
    usage: null, subject_domain: null, subject_id: null, run_id: null, step: null,
    source: 'pipeline', group_id: null, caption: null, tags: [], tagged_at: null,
    parent_id: null, op: null, status, favorite: false, created_at: null,
  }
}

function task(patch: Partial<StudioTask> = {}): StudioTask {
  return {
    id: 'online-1', domain: 'studio', tool_id: 'online-image', task_type: 'image.generate',
    parent_task_id: null, batch_id: null, source_route: '/studio/online',
    source_context: {
      provider_name: 'ModelScope', adapter_type: 'modelscope', model: 'Org/Model',
      prompt: 'paper city', size: '1024x1536', quality: 'auto', reference_asset_ids: [3],
    },
    capability: 'image-free', deployment_id: 7, invocation: { options: { ref_asset_ids: [3] } },
    provider_task_id: null, canvas_id: null, node_id: null, execution_group_id: null,
    status: 'succeeded', stage: 'completed', progress: 100, retryable: false, result: { asset_ids: [4, 5] }, error: null,
    created_at: '2026-08-22T00:00:00Z', started_at: null, heartbeat_at: null,
    finished_at: null, event_seq: 2, updated_at: null, ...patch,
  }
}

describe('online multi-provider history', () => {
  it('normalizes result and reference ids from both execution contracts', () => {
    expect(onlineResultAssetIds(task({ result: { asset_ids: [4, '5'], items: [{ asset_id: 4 }, { asset_id: 6 }] } }))).toEqual([4, 5, 6])
    expect(onlineReferenceAssetIds(task({ invocation: { ref_asset_ids: [1], options: { ref_asset_ids: [2] } } }))).toEqual([3, 1, 2])
  })

  it('preserves provider, model, prompt and references while excluding archived output', () => {
    expect(onlineHistoryItems(task(), [asset(3), asset(4), asset(5, 'archived')])).toEqual([expect.objectContaining({
      provider: 'ModelScope', model: 'Org/Model', prompt: 'paper city', size: '1024x1536',
      asset: expect.objectContaining({ id: 4 }), references: [expect.objectContaining({ id: 3 })],
    })])
  })

  it('matches source presets and validates custom dimensions', () => {
    expect(onlineImageSize('story', '2k', {})).toBe('1152x2048')
    expect(onlineImageSize('custom', '1k', { ratioWidth: 5, ratioHeight: 4 })).toBe('1536x1120')
    expect(onlineImageSize('square', 'custom', { width: 1088, height: 1920 })).toBe('1088x1920')
    expect(onlineImageSize('square', 'custom', { width: 1080, height: 1920 })).toBeNull()
  })

  it('paginates large deployment catalogs without losing the total page count', () => {
    expect(deploymentPage([...Array(19).keys()], 1)).toEqual({ items: [8, 9, 10, 11, 12, 13, 14, 15], page: 1, pages: 3 })
    expect(deploymentPage([1, 2], 9)).toEqual({ items: [1, 2], page: 0, pages: 1 })
  })

  it('maps imported RunningHub fields in image order and binds source output controls', () => {
    const fields = onlineWorkflowFields({ fields: [
      { id: '4::image', label: 'image', fieldName: 'image', fieldType: 'IMAGE', enabled: true, imageOrder: 4 },
      { id: '1::prompt', label: 'prompt', fieldName: 'prompt', fieldType: 'TEXT', enabled: true },
      { id: '2::image', label: 'image', fieldName: 'image', fieldType: 'IMAGE', enabled: true, imageOrder: 1, required: true },
      { id: '1::aspectRatio', label: 'aspectRatio', fieldName: 'aspectRatio', fieldType: 'SELECT', enabled: true, options: ['1:1', '9:16'], fieldValue: '9:16' },
      { id: '1::seed', label: 'seed', fieldName: 'seed', fieldType: 'NUMBER', enabled: true, random_enabled: true, min: '1', max: '4294967295', step: '1' },
      { id: 'hidden', fieldType: 'TEXT', enabled: false },
    ] })
    expect(fields.map((field) => field.id)).toEqual(['2::image', '4::image', '1::prompt', '1::aspectRatio', '1::seed'])
    expect(fields.find((field) => field.id === '1::prompt')?.bindPrompt).toBe(true)
    expect(fields.find((field) => field.id === '2::image')).toMatchObject({ type: 'image', required: true })
    expect(onlineAspectFromSize('720x1280')).toBe('9:16')
    expect(onlineResolutionFromSize('1024x1536')).toBe('2k')
    expect(preferredOnlineWorkflowValue(fields[3]!, '2:3')).toBe('9:16')
  })
})
