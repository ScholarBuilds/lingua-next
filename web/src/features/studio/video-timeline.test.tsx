/* 视频页的分镜时间线。
 *
 * 两件事分开守：
 * - 片段怎么变成一次视频任务（纯函数，逐条断言）。
 * - 时间线**真的挂在视频页上**——这条只能靠渲染一遍。组件本身在画布上早就跑通了，
 *   会出事的是接线：忘了传 props、样式没引、视图开关没接上，全都不报错只是不出现。
 *
 * 本仓 vitest 跑在 node 环境（没有 jsdom），所以走 renderToStaticMarkup。 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import type { CanvasNode, CanvasWorkflowSegment, StudioTask } from '@/lib/api-studio'
import { VideoDirectorPage } from './VideoDirectorPage'
import {
  pendingSegments,
  segmentPrompt,
  segmentReferences,
  snapDuration,
  timelineSegments,
  videoResultItem,
  withSegmentResult,
} from './video-timeline'

function segment(over: Partial<CanvasWorkflowSegment> = {}): CanvasWorkflowSegment {
  return { id: 's1', start: 0, length: 8, prompt: '', type: 'text', ...over }
}

function node(segments: CanvasWorkflowSegment[]): CanvasNode {
  return {
    id: 'timeline',
    type: 'workflow',
    x: 0,
    y: 0,
    workflow_timeline: { kind: 'minimax', segments, selected_id: segments[0]?.id },
  }
}

describe('片段 → 视频任务', () => {
  it('片段提示词优先，空了才用整体描述', () => {
    expect(segmentPrompt(segment({ prompt: '  镜头推近  ' }), '整体')).toBe('镜头推近')
    expect(segmentPrompt(segment({ prompt: '   ' }), '  整体  ')).toBe('整体')
  })

  it('时长贴到模型真支持的档位', () => {
    // 时间线可以拖到任意长度，模型只收固定几档；不贴档就是提交后被上游拒
    expect(snapDuration(6.4, [4, 8, 12])).toBe(8)
    expect(snapDuration(5, [4, 8, 12])).toBe(4)
    expect(snapDuration(99, [4, 8, 12])).toBe(12)
  })

  it('参考图取这一段自己的，第一张当首帧', () => {
    const withRefs = segment({
      references: [
        { kind: 'image', asset_id: 7 },
        { kind: 'audio', media_asset_id: 3 },
        { kind: 'image', asset_id: 9 },
      ],
    })
    expect(segmentReferences(withRefs, [99], 4)).toEqual([
      { asset_id: 7, role: 'first_frame' },
      { asset_id: 9, role: 'reference_image' },
    ])
    // 段上没挂就退回整体选的
    expect(segmentReferences(segment(), [99], 4)).toEqual([{ asset_id: 99, role: 'first_frame' }])
    expect(segmentReferences(segment(), [1, 2, 3], 1)).toEqual([
      { asset_id: 1, role: 'first_frame' },
    ])
  })

  it('产物要带 media_asset_id，导出拼接靠它取素材', () => {
    const task = {
      result: { items: [{ kind: 'image', url: '/a.png' }, { kind: 'video', url: '/v.mp4', media_asset_id: 12 }] },
    } as unknown as StudioTask
    expect(videoResultItem(task)).toMatchObject({ kind: 'video', media_asset_id: 12, url: '/v.mp4' })
    expect(videoResultItem({ result: { items: [] } } as unknown as StudioTask)).toBeNull()
    expect(videoResultItem(undefined)).toBeNull()
  })

  it('结果只写回它自己那一段', () => {
    const timeline = node([segment({ id: 'a' }), segment({ id: 'b' })]).workflow_timeline
    const next = withSegmentResult(timeline, 'b', { kind: 'video', media_asset_id: 5, url: '/v.mp4' })
    expect(next?.segments[0].result).toBeUndefined()
    expect(next?.segments[1].result).toMatchObject({ media_asset_id: 5 })
    // 不存在的段名不该悄悄新建一段
    expect(withSegmentResult(timeline, 'ghost', { kind: 'video' })).toBe(timeline)
  })

  it('待出片只算没有结果的段', () => {
    const value = node([
      segment({ id: 'a', result: { kind: 'video', media_asset_id: 1 } }),
      segment({ id: 'b' }),
    ])
    expect(timelineSegments(value)).toHaveLength(2)
    expect(pendingSegments(value).map((item) => item.id)).toEqual(['b'])
  })
})

function render(path: string): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } })
  client.setQueryData(['cfg-creds', 'video'], [])
  client.setQueryData(['cfg-provider-types'], [])
  client.setQueryData(['cfg-model-deployments', 'video'], [])
  client.setQueryData(['video-director-assets'], { items: [] })
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(VideoDirectorPage),
      ),
    ),
  )
}

describe('时间线挂在视频页上', () => {
  it('切到分镜视图就渲染出时间线编辑器', () => {
    const html = render('/studio/video?view=timeline')
    expect(html).toContain('scv-workflow-timeline')
    expect(html).toContain('MiniMax 分镜列表')
    expect(html).toContain('生成全部待出片')
  })

  it('默认还是单条生成，不无端占掉整页', () => {
    const html = render('/studio/video')
    expect(html).toContain('分镜时间线')
    expect(html).not.toContain('scv-workflow-timeline')
  })
})
