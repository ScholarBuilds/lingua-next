/* 参考图增删排序（F056）。
 *
 * 排序必须落到真实文档源：手动参考改 manual_references，同节点多图改 items，
 * 跨直接上游改 connections。只换缩略图 DOM 会让下一次请求仍按旧顺序发送。 */

import { beforeEach, describe, expect, it } from 'vitest'

import type { CanvasConnection, CanvasItem } from '../../lib/api-studio'
import {
  referenceAssetEntries,
  refAssetIds,
  refMediaItems,
  reorderReferenceAssets,
  useCanvasStore,
  videoMediaReferenceInputs,
  videoReferenceInputs,
  videoRequestOptions,
  normalizedVideoResolution,
} from './canvasStore'
import type { ScvNode } from './canvasStore'

const image = (asset_id: number): CanvasItem => ({ kind: 'image', asset_id })
const node = (id: string, over: Partial<ScvNode> = {}): ScvNode => ({
  id,
  type: 'image',
  x: 0,
  y: 0,
  ...over,
})
const input = (from: string, to: string): CanvasConnection => ({ from, to, kind: 'input' })

beforeEach(() => {
  useCanvasStore.setState({
    canvasId: null,
    nodes: [],
    connections: [],
    selectedNodeIds: [],
    selectedEdgeIds: [],
    undoStack: [],
    redoStack: [],
  })
})

describe('referenceAssetEntries', () => {
  it('按 @、附件、自身、上游、手动参考的真实请求顺序汇总并标记手动项', () => {
    const nodes = [
      node('up', { items: [image(4)] }),
      node('target', {
        prompt_draft_refs: [{ asset_id: 1, label: '正文图' }],
        attachments: [image(2)],
        items: [image(3)],
        manual_references: [image(5)],
      }),
    ]
    const entries = referenceAssetEntries(nodes, [input('up', 'target')], 'target')
    expect(entries.map((entry) => entry.asset_id)).toEqual([1, 2, 3, 4, 5])
    expect(entries.map((entry) => entry.source)).toEqual([
      'mention',
      'attachment',
      'self',
      'upstream',
      'manual',
    ])
    expect(entries.at(-1)?.manual).toBe(true)
  })
})

describe('reorderReferenceAssets', () => {
  it('重排手动参考后实际 refAssetIds 顺序同步变化', () => {
    useCanvasStore.setState({
      nodes: [node('target', { manual_references: [image(7), image(8), image(9)] })],
      connections: [],
    })
    expect(reorderReferenceAssets('target', 9, 7, 'before')).toBe(true)
    expect(refAssetIds(useCanvasStore.getState().nodes, [], 'target')).toEqual([9, 7, 8])
  })

  it('重排同一上游节点的图片会改上游 items', () => {
    useCanvasStore.setState({
      nodes: [node('up', { items: [image(11), image(12)] }), node('target')],
      connections: [input('up', 'target')],
    })
    expect(reorderReferenceAssets('target', 12, 11, 'before')).toBe(true)
    expect(useCanvasStore.getState().nodes.find((item) => item.id === 'up')?.items).toEqual([
      image(12),
      image(11),
    ])
    expect(refAssetIds(useCanvasStore.getState().nodes, useCanvasStore.getState().connections, 'target'))
      .toEqual([12, 11])
  })

  it('跨两个直接上游拖动会改输入连线顺序', () => {
    useCanvasStore.setState({
      nodes: [node('left', { items: [image(21)] }), node('right', { items: [image(22)] }), node('target')],
      connections: [input('left', 'target'), input('right', 'target')],
    })
    expect(reorderReferenceAssets('target', 22, 21, 'before')).toBe(true)
    expect(useCanvasStore.getState().connections.map((connection) => connection.from)).toEqual([
      'right',
      'left',
    ])
    expect(refAssetIds(useCanvasStore.getState().nodes, useCanvasStore.getState().connections, 'target'))
      .toEqual([22, 21])
  })
})

describe('即梦视频全能参考', () => {
  it('保留上游视频/音频顺序，并限制每类最多 3 个', () => {
    const media: CanvasItem[] = [
      { kind: 'video', media_asset_id: 1 },
      { kind: 'audio', media_asset_id: 2 },
      { kind: 'video', media_asset_id: 3 },
      { kind: 'video', media_asset_id: 4 },
      { kind: 'video', media_asset_id: 5 },
    ]
    const nodes = [
      node('up', { type: 'video', items: media }),
      node('target', { type: 'video' }),
    ]
    const collected = refMediaItems(nodes, [input('up', 'target')], 'target')
    expect(videoMediaReferenceInputs(collected, 'jimeng')).toEqual([
      { media_asset_id: 1, kind: 'video' },
      { media_asset_id: 2, kind: 'audio' },
      { media_asset_id: 3, kind: 'video' },
      { media_asset_id: 4, kind: 'video' },
    ])
    expect(videoMediaReferenceInputs(collected, 'volcengine')).toEqual([
      { media_asset_id: 1, kind: 'video' },
      { media_asset_id: 2, kind: 'audio' },
      { media_asset_id: 3, kind: 'video' },
      { media_asset_id: 4, kind: 'video' },
    ])
    expect(videoMediaReferenceInputs(collected, 'openai')).toEqual([])
    expect(videoRequestOptions({ reference_mode: 'multimodal' }, 'jimeng', true))
      .toEqual({ multimodal: true })
  })

  it('区分 9 图全能参考和 20 图多帧转场，并归一分辨率', () => {
    const ids = Array.from({ length: 24 }, (_, index) => index + 1)
    expect(videoReferenceInputs(ids, { reference_mode: 'multimodal' }, 'jimeng')).toHaveLength(9)
    expect(videoReferenceInputs(ids, { reference_mode: 'multi_frame' }, 'jimeng')).toHaveLength(20)
    expect(videoReferenceInputs(ids, { reference_mode: 'multi_frame' }, 'volcengine')).toHaveLength(1)
    expect(normalizedVideoResolution('1080p', 'jimeng', 'seedance2.0', 'multi_frame'))
      .toBe('1080p')
    expect(normalizedVideoResolution('4k', 'jimeng', 'seedance2.0', 'multi_frame'))
      .toBe('720p')
    expect(normalizedVideoResolution('1080p', 'jimeng', 'seedance2.0'))
      .toBe('720p')
    expect(normalizedVideoResolution('4k', 'jimeng', 'seedance2.0_vip'))
      .toBe('4k')
  })
})
