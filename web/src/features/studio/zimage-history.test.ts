import { describe, expect, it } from 'vitest'

import type { ImageAsset } from '@/lib/api-image'
import type { StudioTask } from '@/lib/api-studio'

import {
  normalizeZImageDimension,
  zImageHistoryItems,
  zImageTaskAssetIds,
  zImageTaskEngine,
  zImageTaskPrompt,
} from './zimage-history'

function task(patch: Partial<StudioTask> = {}): StudioTask {
  return {
    id: 'task-1', domain: 'studio', tool_id: 'zimage-generator', task_type: 'image.generate',
    parent_task_id: null, batch_id: null, source_route: '/studio/zimage',
    source_context: { zimage_engine: 'modelscope' }, capability: 'image-free',
    deployment_id: 1, invocation: null, provider_task_id: null, canvas_id: null,
    node_id: null, execution_group_id: null, status: 'succeeded', stage: 'completed',
    progress: 100, result: null, error: null, retryable: false,
    created_at: '2026-08-21T10:00:00Z', started_at: null, heartbeat_at: null,
    finished_at: null, event_seq: 2, updated_at: null, ...patch,
  }
}

function asset(id: number, status: ImageAsset['status'] = 'candidate'): ImageAsset {
  return {
    id, display_name: null, sha: String(id), url: `/display/${id}`, thumb_url: `/thumb/${id}`,
    full_url: `/full/${id}`, width: 1024, height: 1024, bytes: 10, mime: 'image/png',
    target_key: 'free', style_key: null, prompt: 'asset prompt', prompt_structure: null,
    brief: null, alias: null, model: null, size_req: '1024x1024', quality: null,
    usage: null, subject_domain: null, subject_id: null, run_id: null, step: null,
    source: 'pipeline', group_id: null, caption: null, tags: [], tagged_at: null,
    parent_id: null, op: null, status, favorite: false, created_at: null,
  }
}

describe('Z-Image history projection', () => {
  it('reads both image pipeline and workflow result shapes without duplicates', () => {
    expect(zImageTaskAssetIds(task({
      result: { asset_ids: [3, '4', 3], items: [{ asset_id: 5 }, { media_asset_id: 8 }] },
    }))).toEqual([3, 4, 5])
  })

  it('keeps the original prompt and distinguishes both engines', () => {
    expect(zImageTaskPrompt(task({ invocation: { prompt_override: '  cloud cat  ' } })))
      .toBe('cloud cat')
    expect(zImageTaskPrompt(task({
      task_type: 'workflow.comfyui',
      invocation: { fields: { f_prompt: 'local fox' } },
      source_context: null,
    }))).toBe('local fox')
    expect(zImageTaskEngine(task({ task_type: 'workflow.comfyui', source_context: null })))
      .toBe('local')
  })

  it('drops archived assets while preserving task provenance', () => {
    const current = task({
      result: { items: [{ asset_id: 7 }, { asset_id: 8 }] },
      invocation: { fields: { f_prompt: 'paper sculpture' } },
      task_type: 'workflow.comfyui',
      source_context: { zimage_engine: 'local' },
    })
    expect(zImageHistoryItems(current, [asset(7), asset(8, 'archived')])).toEqual([
      expect.objectContaining({ taskId: 'task-1', engine: 'local', prompt: 'paper sculpture' }),
    ])
  })

  it('accepts only safe ComfyUI dimensions', () => {
    expect(normalizeZImageDimension(1024)).toBe(1024)
    expect(normalizeZImageDimension(1000)).toBeNull()
    expect(normalizeZImageDimension(128)).toBeNull()
    expect(normalizeZImageDimension(4160)).toBeNull()
  })
})
