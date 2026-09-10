import { describe, expect, it } from 'vitest'

import type { ImageAsset } from '@/lib/api-image'
import type { StudioTask } from '@/lib/api-studio'

import {
  kleinCloudSize,
  kleinHistoryItems,
  kleinReferenceAssetIds,
  kleinResultAssetIds,
  kleinTaskPrompt,
} from './klein-history'

function task(patch: Partial<StudioTask> = {}): StudioTask {
  return {
    id: 'klein-1', domain: 'studio', tool_id: 'klein-editor', task_type: 'workflow.comfyui',
    parent_task_id: null, batch_id: null, source_route: '/studio/klein', source_context: null,
    capability: null, deployment_id: null, invocation: null, provider_task_id: null,
    canvas_id: null, node_id: null, execution_group_id: null, status: 'succeeded',
    stage: 'completed', progress: 100, result: null, error: null, retryable: false,
    created_at: '2026-08-21T10:00:00Z', started_at: null, heartbeat_at: null,
    finished_at: null, event_seq: 2, updated_at: null, ...patch,
  }
}

function asset(id: number, status: ImageAsset['status'] = 'candidate'): ImageAsset {
  return {
    id, display_name: null, sha: String(id), url: `/display/${id}`, thumb_url: `/thumb/${id}`,
    full_url: `/full/${id}`, width: 1200, height: 800, bytes: 10, mime: 'image/png',
    target_key: 'free', style_key: null, prompt: 'asset prompt', prompt_structure: null,
    brief: null, alias: null, model: null, size_req: null, quality: null, usage: null,
    subject_domain: null, subject_id: null, run_id: null, step: null, source: 'pipeline',
    group_id: null, caption: null, tags: [], tagged_at: null, parent_id: null, op: null,
    status, favorite: false, created_at: null,
  }
}

describe('Flux Klein history projection', () => {
  it('reads output and reference ids from both execution shapes', () => {
    expect(kleinResultAssetIds(task({
      result: { asset_ids: [7, 7], items: [{ asset_id: '8' }] },
    }))).toEqual([7, 8])
    expect(kleinReferenceAssetIds(task({
      invocation: { options: { ref_asset_ids: [1, 2] } },
      source_context: { reference_asset_ids: [2, 3] },
    }))).toEqual([2, 3, 1])
  })

  it('preserves prompt, engine, LoRA and references for replicate', () => {
    const current = task({
      invocation: { fields: { f_prompt: '  moonlight  ' } },
      result: { items: [{ asset_id: 9 }] },
      source_context: {
        klein_engine: 'modelscope', reference_asset_ids: [1, 2], lora_strength: 0.8,
      },
    })
    expect(kleinTaskPrompt(current)).toBe('moonlight')
    expect(kleinHistoryItems(current, [asset(1), asset(2), asset(9)]))
      .toEqual([expect.objectContaining({
        engine: 'modelscope', loraStrength: 0.8,
        references: [expect.objectContaining({ id: 1 }), expect.objectContaining({ id: 2 })],
      })])
  })

  it('drops archived outputs and matches the source 64-pixel cloud sizing rule', () => {
    expect(kleinHistoryItems(task({ result: { asset_ids: [4] } }), [asset(4, 'archived')]))
      .toEqual([])
    expect(kleinCloudSize(3000, 1500)).toEqual({ width: 2048, height: 1024 })
    expect(kleinCloudSize(1000, 1500)).toEqual({ width: 1024, height: 1472 })
    expect(kleinCloudSize(0, 0)).toEqual({ width: 1024, height: 1024 })
  })
})
