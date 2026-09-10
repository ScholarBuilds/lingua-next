import { describe, expect, it } from 'vitest'

import type { ImageAsset } from '@/lib/api-image'
import type { CanvasAssetItem, CanvasNode, StudioMediaAsset } from '@/lib/api-studio'

import { replaceCanvasReference } from './CanvasResourceRepair'

function missing(assetType: 'image' | 'media', assetId: number): CanvasAssetItem {
  return {
    id: 'missing', asset_type: assetType, asset_id: assetId, url: '', name: 'missing',
    kind: assetType === 'image' ? 'image' : 'audio', missing: true, canvas_id: 1,
    canvas_title: 'test', canvas_kind: 'smart', canvas_icon: '', canvas_owner: '',
    canvas_color: '', canvas_updated_at: '', node_id: 'node-1', node_title: 'node',
    node_type: 'workflow', source_path: 'nodes[0].items[0]',
  }
}

const image = {
  id: 8, display_name: '替换图', width: 800, height: 600,
} as ImageAsset

const audio = {
  id: 12, kind: 'audio', name: '替换音频.wav', mime: 'audio/wav', url: '/audio/12',
  poster_url: null, duration_ms: 4200, width: null, height: null,
} as StudioMediaAsset

describe('canvas resource repair', () => {
  it('replaces every nested image reference while preserving unrelated ids', () => {
    const node: CanvasNode = {
      id: 'node-1', type: 'workflow', x: 0, y: 0,
      items: [{ asset_id: 3, kind: 'image', name: '旧图', missing: true }],
      manual_references: [{ asset_id: 3, kind: 'image', missing: true }],
      prompt_draft_refs: [{ asset_id: 3, label: '图1' }, { asset_id: 4, label: '图2' }],
      workflow_timeline: {
        kind: 'minimax',
        segments: [{ id: 's1', start: 0, length: 4, prompt: '', type: 'image', asset_id: 3 }],
      },
    }
    const replaced = replaceCanvasReference(node, missing('image', 3), { type: 'image', asset: image }) as CanvasNode
    expect(replaced.items?.[0]).toMatchObject({ asset_id: 8, name: '替换图', w: 800, h: 600 })
    expect(replaced.items?.[0].missing).toBeUndefined()
    expect(replaced.manual_references?.[0].asset_id).toBe(8)
    expect(replaced.prompt_draft_refs).toEqual([{ asset_id: 8, label: '图1' }, { asset_id: 4, label: '图2' }])
    expect(replaced.workflow_timeline?.segments[0].asset_id).toBe(8)
  })

  it('replaces media references with current metadata', () => {
    const node: CanvasNode = {
      id: 'node-2', type: 'workflow', x: 0, y: 0,
      items: [{ media_asset_id: 5, kind: 'audio', name: '旧音频', missing: true }],
      workflow_timeline: {
        kind: 'ltx', segments: [],
        audio_segments: [{ id: 'a1', start: 0, length: 20, trim_start: 0, media_asset_id: 5, missing: true }],
      },
    }
    const replaced = replaceCanvasReference(node, missing('media', 5), { type: 'media', asset: audio }) as CanvasNode
    expect(replaced.items?.[0]).toMatchObject({
      media_asset_id: 12, kind: 'audio', name: '替换音频.wav', url: '/audio/12', duration_ms: 4200,
    })
    expect(replaced.workflow_timeline?.audio_segments?.[0].media_asset_id).toBe(12)
    expect(replaced.workflow_timeline?.audio_segments?.[0].missing).toBeUndefined()
  })
})
