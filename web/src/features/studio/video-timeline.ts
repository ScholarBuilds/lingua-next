/* 视频页的分镜时间线：把画布上的 MiniMax 时间线编辑器接到视频任务上。

   时间线编辑器（`WorkflowTimelineEditor`）本身不碰画布 store，只吃 props 吐
   patch，所以视频页原样复用，不抽公共层——真去抽一层反而要把两边的 `CanvasNode`
   收敛成第三种类型，改动比复用大得多。

   这里只补编辑器不管的那半件事：**片段怎么变成一次视频任务**。
   每段自己的提示词、长度与参考图各跑一条 `/studio/videos/runs`，产物写回
   `segment.result`；导出拼接由编辑器已有的 `/studio/minimax/timeline-export`
   负责（它按 `result.media_asset_id` 取素材，所以结果必须带这一项）。 */

import type {
  CanvasItem,
  CanvasNode,
  CanvasWorkflowSegment,
  CanvasWorkflowTimeline,
  StudioTask,
  VideoReferenceInput,
} from '@/lib/api-studio'

/** 视频页固定用 MiniMax 那套「按秒排布的分镜列表」。
 *  LTX 是按帧的关键帧轨，对应的是工作流节点，不是这里的逐段生成 */
export const VIDEO_TIMELINE_MODE = 'minimax' as const

/** 时间线草稿存本地：编一半刷新页面不该白编。
 *  只存时间线本身，模型与画幅跟着表单走 */
export const VIDEO_TIMELINE_STORAGE_KEY = 'lingua.studio.video-timeline'

export function timelineSegments(node: CanvasNode): CanvasWorkflowSegment[] {
  return node.workflow_timeline?.segments ?? []
}

/** 片段自己的提示词优先；没填就用整体描述，别让空提示词发出去 */
export function segmentPrompt(segment: CanvasWorkflowSegment, fallback: string): string {
  const own = segment.prompt.trim()
  return own === '' ? fallback.trim() : own
}

/** 片段长度贴到模型真支持的档位。
 *  时间线是连续可拖的，模型只收固定几档——不贴档就是提交后被上游拒 */
export function snapDuration(seconds: number, options: number[]): number {
  if (options.length === 0) return Math.max(1, Math.round(seconds))
  return options.reduce((best, option) =>
    Math.abs(option - seconds) < Math.abs(best - seconds) ? option : best,
  )
}

/** 片段的参考图。段上没挂就退回整体选的那几张 */
export function segmentReferenceIds(
  segment: CanvasWorkflowSegment,
  fallback: number[],
): number[] {
  const own = (segment.references ?? []).flatMap((item) =>
    item.kind === 'image' && item.asset_id !== undefined ? [item.asset_id] : [],
  )
  if (own.length > 0) return own
  if (segment.asset_id !== undefined) return [segment.asset_id]
  return fallback
}

/** 逐段生成一律按首帧引导：分镜的语义就是「从这张图开始动起来」 */
export function segmentReferences(
  segment: CanvasWorkflowSegment,
  fallback: number[],
  limit: number,
): VideoReferenceInput[] {
  return segmentReferenceIds(segment, fallback)
    .slice(0, Math.max(0, limit))
    .map((asset_id, index) => ({
      asset_id,
      role: index === 0 ? 'first_frame' : 'reference_image',
    }))
}

/** 任务产物里的视频。拿不到就返回 null——没有 media_asset_id 的结果拼不了片 */
export function videoResultItem(task: StudioTask | undefined): CanvasItem | null {
  const raw = task?.result?.items
  if (!Array.isArray(raw)) return null
  for (const value of raw) {
    if (typeof value !== 'object' || value === null) continue
    const item = value as Record<string, unknown>
    if (item.kind !== 'video' || typeof item.url !== 'string') continue
    const mediaId = Number(item.media_asset_id ?? item.id)
    return {
      kind: 'video',
      media_asset_id: Number.isInteger(mediaId) && mediaId > 0 ? mediaId : undefined,
      url: item.url,
      poster_url: typeof item.poster_url === 'string' ? item.poster_url : null,
      name: typeof item.name === 'string' ? item.name : undefined,
      mime: typeof item.mime === 'string' ? item.mime : undefined,
      duration_ms: typeof item.duration_ms === 'number' ? item.duration_ms : null,
    }
  }
  return null
}

/** 结果写回它自己那一段，别的段一个字节都不动 */
export function withSegmentResult(
  timeline: CanvasWorkflowTimeline | undefined,
  segmentId: string,
  result: CanvasItem,
): CanvasWorkflowTimeline | undefined {
  if (timeline === undefined) return undefined
  if (!timeline.segments.some((segment) => segment.id === segmentId)) return timeline
  return {
    ...timeline,
    segments: timeline.segments.map((segment) =>
      segment.id === segmentId ? { ...segment, result } : segment,
    ),
  }
}

/** 还没出片的段。「生成全部」只跑这些，已经出片的重跑要显式点那一段 */
export function pendingSegments(node: CanvasNode): CanvasWorkflowSegment[] {
  return timelineSegments(node).filter((segment) => segment.result === undefined)
}
