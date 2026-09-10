import { describe, expect, it } from 'vitest'

import type { ImageAsset } from '@/lib/api-image'
import type { StudioTask } from '@/lib/api-studio'

import { angleHistoryItems, angleResultAssetIds, angleSourceAssetId } from './angle-history'

function task(patch: Partial<StudioTask> = {}): StudioTask {
  return {
    id: 'angle-1', domain: 'studio', tool_id: 'angle-control', task_type: 'image.edit',
    parent_task_id: null, batch_id: null, source_route: '/studio/angle', source_context: null,
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
    full_url: `/full/${id}`, width: 1024, height: 1024, bytes: 10, mime: 'image/png',
    target_key: 'free', style_key: null, prompt: '', prompt_structure: null, brief: null,
    alias: null, model: null, size_req: null, quality: null, usage: null,
    subject_domain: null, subject_id: null, run_id: null, step: null, source: 'pipeline',
    group_id: null, caption: null, tags: [], tagged_at: null, parent_id: null, op: null,
    status, favorite: false, created_at: null,
  }
}

describe('angle history projection', () => {
  it('reads both result shapes and source provenance', () => {
    expect(angleResultAssetIds(task({
      result: { asset_ids: [2, 2], items: [{ asset_id: '3' }] },
    }))).toEqual([2, 3])
    expect(angleSourceAssetId(task({ source_context: { source_asset_id: '7' } }))).toBe(7)
  })

  it('preserves engine, command and pose for history cards', () => {
    const current = task({
      result: { items: [{ asset_id: 9 }] },
      source_context: {
        angle_engine: 'modelscope', source_asset_id: 1, prompt: 'keep subject',
        instruction: '将相机俯视20度', pose: { yaw: 0, pitch: 20, distance: 4 },
      },
    })
    expect(angleHistoryItems(current, [asset(1), asset(9)]))
      .toEqual([expect.objectContaining({
        engine: 'modelscope', prompt: 'keep subject', instruction: '将相机俯视20度',
        pose: { yaw: 0, pitch: 20, distance: 4 }, source: expect.objectContaining({ id: 1 }),
      })])
  })

  it('ignores legacy tasks without provenance and archived outputs', () => {
    expect(angleHistoryItems(task({ result: { asset_ids: [4] } }), [asset(4)])).toEqual([])
    expect(angleHistoryItems(task({
      result: { asset_ids: [4] }, source_context: { angle_engine: 'local' },
    }), [asset(4, 'archived')])).toEqual([])
  })
})
