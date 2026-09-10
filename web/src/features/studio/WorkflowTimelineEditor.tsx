import { Picker } from '@/components/ui/picker'
import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { toast } from 'sonner'

import type {
  CanvasItem,
  CanvasNode,
  CanvasWorkflowAudioSegment,
  CanvasWorkflowSegment,
  CanvasWorkflowTimeline,
} from '../../lib/api-studio'
import { apiStudio } from '../../lib/api-studio'
import { saveFile } from '@/lib/shell'

export type WorkflowTimelineMode = CanvasWorkflowTimeline['kind']

const MINIMAX_ASPECTS = [
  '16:9 (Widescreen)',
  '9:16 (Portrait)',
  '1:1 (Square)',
  '4:3 (Standard)',
  '3:4 (Portrait)',
  '21:9 (Ultrawide)',
]
const MINIMAX_PREVIEW_MIN = 130
const MINIMAX_PREVIEW_MAX = 420
const MINIMAX_ASSET_MIN = 150
const MINIMAX_ASSET_MAX = 360
const MINIMAX_VIDEO_TRACK_MIN = 52
const MINIMAX_VIDEO_TRACK_MAX = 150
const MINIMAX_REF_TRACK_MIN = 32
const MINIMAX_REF_TRACK_MAX = 92
const LTX_MIN_SEGMENT_FRAMES = 6
const LTX_IMAGE_TRACK_MIN = 80
const LTX_IMAGE_TRACK_MAX = 320
const LTX_AUDIO_TRACK_MIN = 50
const LTX_AUDIO_TRACK_MAX = 180

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

export function minimaxPlayheadFromPointer(
  total: number,
  clientX: number,
  left: number,
  width: number,
): number {
  if (total <= 0 || width <= 0) return 0
  return Math.round(clamp((clientX - left) / width, 0, 1) * total * 1000) / 1000
}

export function ltxFrameFromPointer(
  totalFrames: number,
  clientX: number,
  left: number,
  width: number,
): number {
  if (totalFrames <= 0 || width <= 0) return 0
  return Math.round(clamp((clientX - left) / width, 0, 1) * totalFrames)
}

export function ltxVisualDuration(
  durationFrames: number,
  segments: Array<{ start: number; length: number }>,
  audioSegments: Array<{ start: number; length: number }>,
): number {
  const furthest = [...segments, ...audioSegments].reduce(
    (maximum, segment) => Math.max(maximum, segment.start + segment.length),
    0,
  )
  return Math.max(1, Math.round(durationFrames), Math.ceil(furthest * 1.3))
}

/**
 * Prompt Relay 的中心拖动规则：按指针越过的片段中心决定插入位置，随后向两侧
 * 推挤冲突片段，同时保持整条轨道不越过可视时间线。
 */
export function ltxMoveSegments<T extends { id: string; start: number; length: number }>(
  segments: T[],
  draggedId: string,
  proposedStart: number,
  pointerFrame: number,
  totalFrames: number,
): T[] {
  const timeline = segments.map((segment) => ({ ...segment }))
  const draggedIndex = timeline.findIndex((segment) => segment.id === draggedId)
  if (draggedIndex < 0) return timeline
  const dragged = timeline[draggedIndex]
  const remaining = timeline.filter((segment) => segment.id !== draggedId)
  let insertIndex = remaining.length
  for (let index = 0; index < remaining.length; index += 1) {
    if (pointerFrame < remaining[index].start + remaining[index].length / 2) {
      insertIndex = index
      break
    }
  }

  const leftBound = insertIndex > 0
    ? remaining[insertIndex - 1].start + remaining[insertIndex - 1].length
    : 0
  const rightBound = insertIndex < remaining.length ? remaining[insertIndex].start : totalFrames
  let start = clamp(proposedStart, 0, Math.max(0, totalFrames - dragged.length))
  start = rightBound - leftBound >= dragged.length
    ? clamp(start, leftBound, rightBound - dragged.length)
    : (leftBound + rightBound - dragged.length) / 2

  const arranged = [
    ...remaining.slice(0, insertIndex).map((segment) => ({
      segment: { ...segment },
      originalStart: segment.start,
    })),
    { segment: { ...dragged, start }, originalStart: start },
    ...remaining.slice(insertIndex).map((segment) => ({
      segment: { ...segment },
      originalStart: segment.start,
    })),
  ]
  for (let index = insertIndex + 1; index < arranged.length; index += 1) {
    const previous = arranged[index - 1].segment
    arranged[index].segment.start = Math.max(
      arranged[index].originalStart,
      previous.start + previous.length,
    )
  }
  for (let index = insertIndex - 1; index >= 0; index -= 1) {
    const next = arranged[index + 1].segment
    arranged[index].segment.start = Math.min(
      arranged[index].originalStart,
      next.start - arranged[index].segment.length,
    )
  }
  let rightCursor = totalFrames
  for (let index = arranged.length - 1; index >= 0; index -= 1) {
    const segment = arranged[index].segment
    if (segment.start + segment.length > rightCursor) segment.start = rightCursor - segment.length
    rightCursor = segment.start
  }
  let leftCursor = 0
  for (const item of arranged) {
    if (item.segment.start < leftCursor) item.segment.start = leftCursor
    leftCursor = item.segment.start + item.segment.length
  }
  return arranged.map((item) => item.segment as T)
}

type LtxResizeOperation =
  | { type: 'left' | 'right'; id: string }
  | { type: 'joint'; id: string; rightId: string }

function isAudioSegment(
  segment: CanvasWorkflowSegment | CanvasWorkflowAudioSegment,
): segment is CanvasWorkflowAudioSegment {
  return 'trim_start' in segment
}

/** 单边裁剪与相邻片段滚动编辑，和源 Prompt Relay 的六帧最短片段规则一致。 */
export function ltxResizeSegments<
  T extends CanvasWorkflowSegment | CanvasWorkflowAudioSegment,
>(
  segments: T[],
  operation: LtxResizeOperation,
  deltaFrames: number,
  totalFrames: number,
): T[] {
  const timeline = segments.map((segment) => ({ ...segment })) as T[]
  const index = timeline.findIndex((segment) => segment.id === operation.id)
  if (index < 0) return timeline
  const original = segments.find((segment) => segment.id === operation.id)
  if (original === undefined) return timeline

  if (operation.type === 'joint') {
    const rightIndex = timeline.findIndex((segment) => segment.id === operation.rightId)
    const originalRight = segments.find((segment) => segment.id === operation.rightId)
    if (rightIndex < 0 || originalRight === undefined) return timeline
    let maximumRight = originalRight.length - LTX_MIN_SEGMENT_FRAMES
    let maximumLeft = original.length - LTX_MIN_SEGMENT_FRAMES
    if (isAudioSegment(original) && isAudioSegment(originalRight)) {
      maximumLeft = Math.min(maximumLeft, originalRight.trim_start)
      const remainingTail = (original.audio_duration_frames ?? original.length)
        - (original.trim_start + original.length)
      maximumRight = Math.min(maximumRight, remainingTail)
    }
    const safeDelta = clamp(deltaFrames, -maximumLeft, maximumRight)
    timeline[index].length = original.length + safeDelta
    timeline[rightIndex].start = originalRight.start + safeDelta
    timeline[rightIndex].length = originalRight.length - safeDelta
    if (isAudioSegment(timeline[rightIndex]) && isAudioSegment(originalRight)) {
      timeline[rightIndex].trim_start = originalRight.trim_start + safeDelta
    }
    return timeline
  }

  if (operation.type === 'right') {
    const next = [...segments]
      .filter((segment) => segment.id !== original.id && segment.start >= original.start + original.length)
      .sort((left, right) => left.start - right.start)[0]
    let maximumLength = (next?.start ?? totalFrames) - original.start
    if (isAudioSegment(original)) {
      maximumLength = Math.min(
        maximumLength,
        (original.audio_duration_frames ?? original.length) - original.trim_start,
      )
    }
    timeline[index].length = Math.max(
      LTX_MIN_SEGMENT_FRAMES,
      Math.min(original.length + deltaFrames, maximumLength),
    )
    return timeline
  }

  const previous = [...segments]
    .filter((segment) => segment.id !== original.id && segment.start + segment.length <= original.start)
    .sort((left, right) => right.start - left.start)[0]
  let minimumStart = previous === undefined ? 0 : previous.start + previous.length
  if (isAudioSegment(original)) {
    minimumStart = Math.max(minimumStart, original.start - original.trim_start)
  }
  const maximumStart = original.start + original.length - LTX_MIN_SEGMENT_FRAMES
  const start = clamp(original.start + deltaFrames, minimumStart, maximumStart)
  const applied = start - original.start
  timeline[index].start = start
  timeline[index].length = original.length - applied
  if (isAudioSegment(timeline[index]) && isAudioSegment(original)) {
    timeline[index].trim_start = original.trim_start + applied
  }
  return timeline
}

function ltxGapRegions(
  segments: Array<{ start: number; length: number }>,
  endFrame: number,
): Array<{ start: number; end: number }> {
  const gaps: Array<{ start: number; end: number }> = []
  let cursor = 0
  for (const segment of [...segments].sort((left, right) => left.start - right.start)) {
    if (segment.start > cursor) gaps.push({ start: cursor, end: segment.start })
    cursor = Math.max(cursor, segment.start + segment.length)
  }
  if (cursor < endFrame) gaps.push({ start: cursor, end: endFrame })
  return gaps
}

function ltxVisibleWaveform(
  peaks: number[] | undefined,
  segment: CanvasWorkflowAudioSegment,
  count = 96,
): number[] {
  if (peaks === undefined || peaks.length === 0) return []
  const duration = Math.max(segment.length, segment.audio_duration_frames ?? segment.length)
  const startRatio = clamp(segment.trim_start / duration, 0, 1)
  const endRatio = clamp((segment.trim_start + segment.length) / duration, startRatio, 1)
  return Array.from({ length: count }, (_, index) => {
    const ratio = startRatio + (index / Math.max(1, count - 1)) * (endRatio - startRatio)
    return peaks[Math.min(peaks.length - 1, Math.floor(ratio * peaks.length))] ?? 0
  })
}

function referenceKey(item: CanvasItem): string {
  return item.asset_id !== undefined
    ? `image:${item.asset_id}`
    : `${item.kind}:${item.media_asset_id ?? item.url ?? ''}`
}

export function minimaxAddReference(
  references: CanvasItem[],
  item: CanvasItem,
): CanvasItem[] {
  const key = referenceKey(item)
  if (references.some((reference) => referenceKey(reference) === key)) return references
  const limit = item.kind === 'image' ? 9 : 3
  if (references.filter((reference) => reference.kind === item.kind).length >= limit) {
    return references
  }
  return [...references, { ...item }]
}

export function workflowTimelineMode(title: string | undefined): WorkflowTimelineMode | null {
  const normalized = (title ?? '').toLowerCase()
  if (normalized.includes('ltx director')) return 'ltx'
  if (normalized.includes('minimax')) return 'minimax'
  return null
}

function finite(value: unknown, fallback: number, minimum = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback
}

function reflow(segments: CanvasWorkflowSegment[]): CanvasWorkflowSegment[] {
  let cursor = 0
  return segments.map((segment) => {
    const next = { ...segment, start: cursor, length: finite(segment.length, 1, 0.1) }
    cursor += next.length
    return next
  })
}

function orderedLtxSegments(segments: CanvasWorkflowSegment[]): CanvasWorkflowSegment[] {
  return segments
    .map((segment) => ({
      ...segment,
      start: Math.round(finite(segment.start, 0)),
      length: Math.max(1, Math.round(finite(segment.length, 1, 1))),
    }))
    .sort((left, right) => left.start - right.start || left.id.localeCompare(right.id))
}

function orderedAudioSegments(segments: CanvasWorkflowAudioSegment[]): CanvasWorkflowAudioSegment[] {
  return segments
    .map((segment) => ({
      ...segment,
      start: Math.round(finite(segment.start, 0)),
      length: Math.max(1, Math.round(finite(segment.length, 1, 1))),
      trim_start: Math.round(finite(segment.trim_start, 0)),
    }))
    .sort((left, right) => left.start - right.start || left.id.localeCompare(right.id))
}

function initialSegment(
  mode: WorkflowTimelineMode,
  node: CanvasNode,
  assetId: number | undefined,
  index: number,
  linkedPrompt: string,
): CanvasWorkflowSegment {
  const values = node.workflow_values ?? {}
  if (mode === 'ltx') {
    const frameRate = finite(node.workflow_timeline?.frame_rate ?? values.f_frame_rate, 24, 1)
    return {
      id: assetId === undefined ? `initial-${node.id}` : `ref-${assetId}-${index}`,
      start: 0,
      length: frameRate,
      prompt: linkedPrompt,
      type: assetId === undefined ? 'text' : 'image',
      asset_id: assetId,
      guideStrength: 1,
    }
  }
  return {
    id: assetId === undefined ? `initial-${node.id}` : `ref-${assetId}-${index}`,
    start: 0,
    length: finite(values.f_duration_seconds, 8, 0.5),
    prompt: String(values.f_prompt ?? linkedPrompt),
    type: assetId === undefined ? 'text' : 'image',
    asset_id: assetId,
    aspect_ratio: String(values.f_aspect_ratio ?? MINIMAX_ASPECTS[0]),
    megapixels: finite(values.f_megapixels, 0.4, 0.1),
    seed: finite(values.f_seed, Math.floor(Math.random() * 4_294_967_296), 0),
  }
}

export function workflowTimelineNewSegment(
  mode: WorkflowTimelineMode,
  node: CanvasNode,
  type: CanvasWorkflowSegment['type'],
  assetId: number | undefined,
  index: number,
  linkedPrompt: string,
  current?: CanvasWorkflowSegment,
): CanvasWorkflowSegment {
  const segment = initialSegment(mode, node, assetId, index, linkedPrompt)
  if (mode === 'ltx') return { ...segment, type, prompt: '' }
  if (mode !== 'minimax') return { ...segment, type }

  const length = finite(current?.length ?? segment.length, 8, 0.5)
  return {
    ...segment,
    length,
    prompt: '',
    type,
    asset_id: type === 'image' ? assetId : undefined,
    references: type === 'image' && assetId !== undefined
      ? [{ asset_id: assetId, kind: 'image' }]
      : [],
    result: undefined,
    aspect_ratio: current?.aspect_ratio ?? segment.aspect_ratio,
    megapixels: finite(current?.megapixels ?? segment.megapixels, 0.4, 0.1),
    seed: undefined,
    trim_in: 0,
    trim_out: length,
  }
}

function readTimeline(
  mode: WorkflowTimelineMode,
  node: CanvasNode,
  refs: number[],
  linkedPrompt: string,
): CanvasWorkflowTimeline {
  const stored = node.workflow_timeline
  const storedSegments = stored?.kind === mode && Array.isArray(stored.segments)
    ? stored.segments.filter((segment) => segment && typeof segment.id === 'string')
    : []
  let segments = storedSegments.length > 0
    ? storedSegments.map((segment) => ({ ...segment }))
    : (refs.length > 0 ? refs : [undefined]).map(
        (assetId, index) => initialSegment(mode, node, assetId, index, linkedPrompt),
      )
  if (storedSegments.length > 0) {
    const claimed = new Set(segments.map((segment) => segment.asset_id))
    const unclaimed = refs.filter((assetId) => !claimed.has(assetId))
    if (mode === 'minimax') {
      let cursor = 0
      segments = segments.map((segment) => {
        const assetId = unclaimed[cursor]
        if (segment.asset_id !== undefined || assetId === undefined) return segment
        cursor += 1
        return { ...segment, type: 'image', asset_id: assetId }
      })
      segments.push(...unclaimed.slice(cursor).map(
        (assetId, index) => initialSegment(mode, node, assetId, segments.length + index, linkedPrompt),
      ))
    } else {
      segments.push(...unclaimed.map(
        (assetId, index) => initialSegment(mode, node, assetId, segments.length + index, linkedPrompt),
      ))
    }
  }
  const normalized = mode === 'ltx' ? orderedLtxSegments(segments) : reflow(segments)
  const selectedId = normalized.some((segment) => segment.id === stored?.selected_id)
    ? stored?.selected_id
    : normalized[0]?.id
  const audioSegments = mode === 'ltx'
    ? orderedAudioSegments(stored?.audio_segments ?? [])
    : undefined
  const durationFrames = mode === 'ltx'
    ? Math.round(finite(
        stored?.duration_frames ?? node.workflow_values?.f_duration_frames,
        Math.max(120, ...normalized.map((segment) => segment.start + segment.length)),
        1,
      ))
    : undefined
  const visualFrames = mode === 'ltx'
    ? ltxVisualDuration(durationFrames ?? 120, normalized, audioSegments ?? [])
    : undefined
  return {
    kind: mode,
    segments: normalized,
    selected_id: selectedId,
    playhead: mode === 'minimax'
      ? finite(stored?.playhead, 0)
      : clamp(
          Math.round(finite(stored?.playhead, 0)),
          0,
          visualFrames ?? 120,
        ),
    timeline_zoom: mode === 'ltx'
      ? clamp(finite(stored?.timeline_zoom, 1, 1), 1, 32)
      : undefined,
    image_track_height: mode === 'ltx'
      ? clamp(
          finite(stored?.image_track_height, 160),
          LTX_IMAGE_TRACK_MIN,
          LTX_IMAGE_TRACK_MAX,
        )
      : undefined,
    audio_track_height: mode === 'ltx'
      ? clamp(
          finite(stored?.audio_track_height, 80),
          LTX_AUDIO_TRACK_MIN,
          LTX_AUDIO_TRACK_MAX,
        )
      : undefined,
    display_mode: mode === 'ltx' && stored?.display_mode === 'frames' ? 'frames' : 'seconds',
    loop: mode === 'ltx' ? Boolean(stored?.loop) : undefined,
    preview_height: mode === 'minimax'
      ? clamp(finite(stored?.preview_height, 180), MINIMAX_PREVIEW_MIN, MINIMAX_PREVIEW_MAX)
      : undefined,
    asset_pane_width: mode === 'minimax'
      ? clamp(finite(stored?.asset_pane_width, 180), MINIMAX_ASSET_MIN, MINIMAX_ASSET_MAX)
      : undefined,
    video_track_height: mode === 'minimax'
      ? clamp(
          finite(stored?.video_track_height, 68),
          MINIMAX_VIDEO_TRACK_MIN,
          MINIMAX_VIDEO_TRACK_MAX,
        )
      : undefined,
    reference_track_height: mode === 'minimax'
      ? clamp(
          finite(stored?.reference_track_height, 38),
          MINIMAX_REF_TRACK_MIN,
          MINIMAX_REF_TRACK_MAX,
        )
      : undefined,
    frame_rate: mode === 'ltx'
      ? finite(stored?.frame_rate ?? node.workflow_values?.f_frame_rate, 24, 1)
      : undefined,
    duration_frames: durationFrames,
    audio_segments: audioSegments,
    selected_audio_id: audioSegments?.some((segment) => segment.id === stored?.selected_audio_id)
      ? stored?.selected_audio_id
      : audioSegments?.[0]?.id,
    selected_track: mode === 'ltx' && stored?.selected_track === 'audio' ? 'audio' : 'image',
  }
}

export function workflowTimelineRunValues(
  mode: WorkflowTimelineMode,
  node: CanvasNode,
  refs: number[],
  linkedPrompt: string,
  mediaRefs: CanvasItem[] = refs.map((asset_id) => ({ asset_id, kind: 'image' as const })),
): Record<string, unknown> {
  const timeline = readTimeline(mode, node, refs, linkedPrompt)
  if (mode === 'minimax') {
    const active = timeline.segments.find((segment) => segment.id === timeline.selected_id)
      ?? timeline.segments[0]
    if (active === undefined) return {}
    const references = (active.references?.length ?? 0) > 0
      ? active.references ?? []
      : active.asset_id !== undefined
        ? [{ asset_id: active.asset_id, kind: 'image' as const }]
        : mediaRefs
    const counts = { image: 0, video: 0, audio: 0 }
    const typedReferences = references.flatMap((item) => {
      if (!(item.kind in counts)) return []
      const kind = item.kind as keyof typeof counts
      const limit = kind === 'image' ? 9 : 3
      if (counts[kind] >= limit) return []
      const ref = kind === 'image' && item.asset_id !== undefined
        ? `asset:${item.asset_id}`
        : kind !== 'image' && item.media_asset_id !== undefined
          ? `media:${item.media_asset_id}`
          : ''
      if (ref === '') return []
      counts[kind] += 1
      return [{ kind, ref }]
    })
    const firstImage = typedReferences.find((reference) => reference.kind === 'image')
    return {
      f_reference_image: firstImage?.ref ?? '',
      f_minimax_references: typedReferences,
      f_prompt: active.prompt || linkedPrompt,
      f_duration_seconds: finite(active.length, 8, 0.5),
      f_aspect_ratio: active.aspect_ratio ?? MINIMAX_ASPECTS[0],
      f_megapixels: finite(active.megapixels, 0.4, 0.1),
      f_seed: Math.round(finite(active.seed, 0, 0)),
    }
  }

  const frameRate = finite(timeline.frame_rate, 24, 1)
  const fallbackPrompt = linkedPrompt.trim()
    || String(node.workflow_values?.f_global_prompt ?? '').trim()
    || '.'
  const durationFrames = Math.round(finite(
    timeline.duration_frames ?? node.workflow_values?.f_duration_frames,
    120,
    1,
  ))
  const segments = orderedLtxSegments(timeline.segments).map((segment) => ({
    id: segment.id,
    start: Math.round(segment.start),
    length: Math.max(1, Math.round(segment.length)),
    prompt: segment.prompt.trim() || fallbackPrompt,
    type: segment.type,
    ...(segment.asset_id === undefined ? {} : { asset_id: segment.asset_id }),
    ...(segment.type === 'image'
      ? { guideStrength: finite(segment.guideStrength, 1, 0).toFixed(2) }
      : {}),
  }))
  const relayLengths: number[] = []
  const relayPrompts: string[] = []
  let currentCursor = 0
  let pendingGap = 0
  for (const segment of segments) {
    if (segment.start >= durationFrames) break
    if (segment.start > currentCursor) {
      const gap = Math.min(segment.start, durationFrames) - currentCursor
      if (relayLengths.length > 0) relayLengths[relayLengths.length - 1] += gap
      else pendingGap += gap
    }
    const clippedLength = Math.min(segment.start + segment.length, durationFrames) - segment.start
    relayLengths.push(clippedLength + pendingGap)
    relayPrompts.push(segment.prompt)
    pendingGap = 0
    currentCursor = segment.start + segment.length
  }
  if (relayLengths.length > 0 && Math.min(currentCursor, durationFrames) < durationFrames) {
    relayLengths[relayLengths.length - 1] += durationFrames - Math.min(currentCursor, durationFrames)
  }
  if (relayLengths.length === 0) {
    relayLengths.push(durationFrames)
    relayPrompts.push(fallbackPrompt)
  }
  const audioSegments = orderedAudioSegments(timeline.audio_segments ?? []).map((segment) => ({
    id: segment.id,
    type: 'audio',
    start: segment.start,
    length: segment.length,
    trimStart: segment.trim_start,
    audioDurationFrames: Math.max(
      segment.length,
      Math.round(finite(segment.audio_duration_frames, segment.length, 1)),
    ),
    ...(segment.media_asset_id === undefined ? {} : { media_asset_id: segment.media_asset_id }),
    ...(segment.url === undefined ? {} : { url: segment.url }),
    ...(segment.name === undefined ? {} : { fileName: segment.name }),
  }))
  return {
    f_timeline_data: JSON.stringify({ segments, audioSegments }),
    f_local_prompts: relayPrompts.join(' | '),
    f_segment_lengths: relayLengths.join(','),
    f_guide_strength: segments
      .filter((segment) => segment.type === 'image')
      .map((segment) => segment.guideStrength)
      .join(','),
    f_duration_frames: durationFrames,
    f_duration_seconds: Math.round(durationFrames / frameRate * 1000) / 1000,
    f_frame_rate: frameRate,
  }
}

export function WorkflowTimelineEditor({
  mode,
  node,
  refs,
  mediaRefs,
  linkedPrompt,
  onSnapshot,
  onPatch,
}: {
  mode: WorkflowTimelineMode
  node: CanvasNode
  refs: number[]
  mediaRefs: CanvasItem[]
  linkedPrompt: string
  onSnapshot: () => void
  onPatch: (patch: Partial<CanvasNode>) => void
}) {
  const [exporting, setExporting] = useState(false)
  const [dragged, setDragged] = useState<{
    mode: 'reference' | 'result'
    item: CanvasItem
  } | null>(null)
  const [livePlayhead, setLivePlayhead] = useState<number | null>(null)
  const [liveLtxPlayhead, setLiveLtxPlayhead] = useState<number | null>(null)
  const [ltxPlaying, setLtxPlaying] = useState(false)
  const [ltxWaveforms, setLtxWaveforms] = useState<Record<string, number[]>>({})
  const [ltxDragPreview, setLtxDragPreview] = useState<{
    track: 'image' | 'audio'
    selectedId: string
    segments: CanvasWorkflowSegment[]
    audioSegments: CanvasWorkflowAudioSegment[]
  } | null>(null)
  const previewMedia = useRef<HTMLVideoElement | HTMLAudioElement | null>(null)
  const ltxViewport = useRef<HTMLDivElement | null>(null)
  const ltxTrackContent = useRef<HTMLDivElement | null>(null)
  const ltxAudioElements = useRef(new Map<string, HTMLAudioElement>())
  const ltxPlayback = useRef<{
    animation: number | null
    timers: number[]
    startFrame: number
    startTime: number
  }>({ animation: null, timers: [], startFrame: 0, startTime: 0 })
  const ltxPlayheadRef = useRef(0)
  const ltxDragLatest = useRef<typeof ltxDragPreview>(null)
  const timeline = readTimeline(mode, node, refs, linkedPrompt)
  const selectedIndex = Math.max(
    0,
    timeline.segments.findIndex((segment) => segment.id === timeline.selected_id),
  )
  const selected = timeline.segments[selectedIndex]
  const audioSegments = timeline.audio_segments ?? []
  const selectedAudio = audioSegments.find((segment) => segment.id === timeline.selected_audio_id)
  const ltxAudioSignature = audioSegments
    .map((segment) => `${segment.id}:${segment.url ?? ''}:${segment.length}:${segment.trim_start}`)
    .join('|')

  useEffect(() => {
    if (mode !== 'ltx' || audioSegments.length === 0 || typeof window.AudioContext !== 'function') {
      return undefined
    }
    let cancelled = false
    const context = new window.AudioContext()
    for (const segment of audioSegments) {
      if (!segment.url || ltxWaveforms[segment.id] !== undefined) continue
      void fetch(segment.url)
        .then((response) => {
          if (!response.ok) throw new Error(`audio ${response.status}`)
          return response.arrayBuffer()
        })
        .then((buffer) => context.decodeAudioData(buffer))
        .then((decoded) => {
          if (cancelled) return
          const source = decoded.getChannelData(0)
          const peakCount = 192
          const block = Math.max(1, Math.floor(source.length / peakCount))
          const peaks = Array.from({ length: peakCount }, (_, index) => {
            const start = index * block
            const end = Math.min(source.length, start + block)
            let peak = 0
            for (let cursor = start; cursor < end; cursor += 1) {
              peak = Math.max(peak, Math.abs(source[cursor]))
            }
            return Math.round(peak * 1000) / 1000
          })
          setLtxWaveforms((current) => current[segment.id] !== undefined
            ? current
            : { ...current, [segment.id]: peaks })
        })
        .catch(() => undefined)
    }
    return () => {
      cancelled = true
      void context.close().catch(() => undefined)
    }
    // ltxAudioSignature makes URL and trim changes observable without retriggering on cloned arrays.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, ltxAudioSignature])

  useEffect(() => () => {
    if (ltxPlayback.current.animation !== null) {
      cancelAnimationFrame(ltxPlayback.current.animation)
    }
    for (const timer of ltxPlayback.current.timers) window.clearTimeout(timer)
    for (const element of ltxAudioElements.current.values()) element.pause()
  }, [])

  const firstFreeStart = (length: number, segments: Array<{ start: number; length: number }>) => {
    let cursor = 0
    for (const segment of [...segments].sort((left, right) => left.start - right.start)) {
      if (cursor + length <= segment.start) return cursor
      cursor = Math.max(cursor, segment.start + segment.length)
    }
    return cursor
  }

  const commit = (
    segments: CanvasWorkflowSegment[],
    selectedId = timeline.selected_id,
    frameRate = timeline.frame_rate,
    durationFrames = timeline.duration_frames,
    nextAudioSegments = audioSegments,
    selectedAudioId = timeline.selected_audio_id,
    timelinePatch: Partial<CanvasWorkflowTimeline> = {},
  ) => {
    const normalizedSegments = mode === 'ltx' ? orderedLtxSegments(segments) : reflow(segments)
    const normalizedAudioSegments = mode === 'ltx'
      ? orderedAudioSegments(nextAudioSegments)
      : undefined
    const minimaxTotal = normalizedSegments.reduce((sum, segment) => sum + segment.length, 0)
    const ltxDuration = Math.round(finite(durationFrames, 120, 1))
    const ltxVisualFrames = ltxVisualDuration(
      ltxDuration,
      normalizedSegments,
      normalizedAudioSegments ?? [],
    )
    const next: CanvasWorkflowTimeline = {
      kind: mode,
      segments: normalizedSegments,
      selected_id: selectedId,
      playhead: mode === 'minimax'
        ? clamp(finite(timelinePatch.playhead ?? timeline.playhead, 0), 0, minimaxTotal)
        : clamp(
            Math.round(finite(timelinePatch.playhead ?? timeline.playhead, 0)),
            0,
            ltxVisualFrames,
          ),
      timeline_zoom: mode === 'ltx'
        ? clamp(finite(timelinePatch.timeline_zoom ?? timeline.timeline_zoom, 1, 1), 1, 32)
        : undefined,
      image_track_height: mode === 'ltx'
        ? clamp(
            finite(timelinePatch.image_track_height ?? timeline.image_track_height, 160),
            LTX_IMAGE_TRACK_MIN,
            LTX_IMAGE_TRACK_MAX,
          )
        : undefined,
      audio_track_height: mode === 'ltx'
        ? clamp(
            finite(timelinePatch.audio_track_height ?? timeline.audio_track_height, 80),
            LTX_AUDIO_TRACK_MIN,
            LTX_AUDIO_TRACK_MAX,
          )
        : undefined,
      display_mode: mode === 'ltx'
        ? (timelinePatch.display_mode ?? timeline.display_mode ?? 'seconds')
        : undefined,
      loop: mode === 'ltx' ? Boolean(timelinePatch.loop ?? timeline.loop) : undefined,
      preview_height: mode === 'minimax'
        ? clamp(
            finite(timelinePatch.preview_height ?? timeline.preview_height, 180),
            MINIMAX_PREVIEW_MIN,
            MINIMAX_PREVIEW_MAX,
          )
        : undefined,
      asset_pane_width: mode === 'minimax'
        ? clamp(
            finite(timelinePatch.asset_pane_width ?? timeline.asset_pane_width, 180),
            MINIMAX_ASSET_MIN,
            MINIMAX_ASSET_MAX,
          )
        : undefined,
      video_track_height: mode === 'minimax'
        ? clamp(
            finite(timelinePatch.video_track_height ?? timeline.video_track_height, 68),
            MINIMAX_VIDEO_TRACK_MIN,
            MINIMAX_VIDEO_TRACK_MAX,
          )
        : undefined,
      reference_track_height: mode === 'minimax'
        ? clamp(
            finite(
              timelinePatch.reference_track_height ?? timeline.reference_track_height,
              38,
            ),
            MINIMAX_REF_TRACK_MIN,
            MINIMAX_REF_TRACK_MAX,
          )
        : undefined,
      frame_rate: mode === 'ltx' ? finite(frameRate, 24, 1) : undefined,
      duration_frames: mode === 'ltx' ? ltxDuration : undefined,
      audio_segments: normalizedAudioSegments,
      selected_audio_id: mode === 'ltx' ? selectedAudioId : undefined,
      selected_track: mode === 'ltx'
        ? (timelinePatch.selected_track ?? timeline.selected_track ?? 'image')
        : undefined,
    }
    const values = workflowTimelineRunValues(
      mode,
      { ...node, workflow_timeline: next },
      refs,
      linkedPrompt,
      mediaRefs,
    )
    onPatch({
      workflow_timeline: next,
      workflow_values: { ...node.workflow_values, ...values },
    })
  }

  const updateSelected = (patch: Partial<CanvasWorkflowSegment>) => {
    commit(timeline.segments.map((segment, index) => (
      index === selectedIndex ? { ...segment, ...patch } : segment
    )))
  }

  const add = (type: CanvasWorkflowSegment['type']) => {
    onSnapshot()
    const assetId = type === 'image'
      ? refs.find((id) => !timeline.segments.some((segment) => segment.asset_id === id)) ?? refs[0]
      : undefined
    const segment = workflowTimelineNewSegment(
      mode,
      node,
      type,
      assetId,
      timeline.segments.length,
      linkedPrompt,
      selected,
    )
    segment.id = `segment-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    if (mode === 'ltx') {
      segment.start = firstFreeStart(segment.length, timeline.segments)
    }
    commit([...timeline.segments, segment], segment.id)
  }

  const addAudio = () => {
    const available = mediaRefs.filter(
      (item) => item.kind === 'audio' && item.media_asset_id !== undefined,
    )
    const item = available.find(
      (candidate) => !audioSegments.some(
        (segment) => segment.media_asset_id === candidate.media_asset_id,
      ),
    ) ?? available[0]
    if (item?.media_asset_id === undefined) return
    onSnapshot()
    const frameRate = finite(timeline.frame_rate, 24, 1)
    const length = Math.max(1, Math.ceil(finite(item.duration_ms, 1000, 1) / 1000 * frameRate))
    const segment: CanvasWorkflowAudioSegment = {
      id: `audio-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      start: firstFreeStart(length, audioSegments),
      length,
      trim_start: 0,
      audio_duration_frames: length,
      media_asset_id: item.media_asset_id,
      name: item.name,
      url: item.url,
    }
    commit(
      timeline.segments,
      timeline.selected_id,
      timeline.frame_rate,
      timeline.duration_frames,
      [...audioSegments, segment],
      segment.id,
    )
  }

  const addLtxTextInGap = (start: number, end: number) => {
    if (end - start < 1) return
    onSnapshot()
    const segment = workflowTimelineNewSegment(
      'ltx',
      node,
      'text',
      undefined,
      timeline.segments.length,
      linkedPrompt,
      selected,
    )
    segment.id = `segment-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    segment.start = start
    segment.length = end - start
    commit([...timeline.segments, segment], segment.id)
  }

  const addLtxAudioInGap = (start: number, end: number) => {
    const available = mediaRefs.filter(
      (item) => item.kind === 'audio' && item.media_asset_id !== undefined,
    )
    const item = available.find(
      (candidate) => !audioSegments.some(
        (segment) => segment.media_asset_id === candidate.media_asset_id,
      ),
    ) ?? available[0]
    if (item?.media_asset_id === undefined || end - start < 1) return
    onSnapshot()
    const frameRate = finite(timeline.frame_rate, 24, 1)
    const sourceLength = Math.max(
      1,
      Math.ceil(finite(item.duration_ms, 1000, 1) / 1000 * frameRate),
    )
    const segment: CanvasWorkflowAudioSegment = {
      id: `audio-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      start,
      length: Math.min(sourceLength, end - start),
      trim_start: 0,
      audio_duration_frames: sourceLength,
      media_asset_id: item.media_asset_id,
      name: item.name,
      url: item.url,
    }
    commit(
      timeline.segments,
      timeline.selected_id,
      timeline.frame_rate,
      timeline.duration_frames,
      [...audioSegments, segment],
      segment.id,
    )
  }

  const updateSelectedAudio = (patch: Partial<CanvasWorkflowAudioSegment>) => {
    if (selectedAudio === undefined) return
    commit(
      timeline.segments,
      timeline.selected_id,
      timeline.frame_rate,
      timeline.duration_frames,
      audioSegments.map((segment) => segment.id === selectedAudio.id
        ? { ...segment, ...patch }
        : segment),
      selectedAudio.id,
    )
  }

  const removeSelectedAudio = () => {
    if (selectedAudio === undefined) return
    onSnapshot()
    const next = audioSegments.filter((segment) => segment.id !== selectedAudio.id)
    commit(
      timeline.segments,
      timeline.selected_id,
      timeline.frame_rate,
      timeline.duration_frames,
      next,
      next[0]?.id,
    )
  }

  const remove = () => {
    if (selected === undefined || timeline.segments.length <= 1) return
    onSnapshot()
    const next = timeline.segments.filter((segment) => segment.id !== selected.id)
    commit(next, next[Math.min(selectedIndex, next.length - 1)]?.id)
  }

  const move = (direction: -1 | 1) => {
    const target = selectedIndex + direction
    if (selected === undefined || target < 0 || target >= timeline.segments.length) return
    onSnapshot()
    const next = [...timeline.segments]
    if (mode === 'ltx') {
      const targetStart = next[target].start
      next[target] = { ...next[target], start: next[selectedIndex].start }
      next[selectedIndex] = { ...next[selectedIndex], start: targetStart }
    } else {
      ;[next[selectedIndex], next[target]] = [next[target], next[selectedIndex]]
    }
    commit(next, selected.id)
  }

  if (selected === undefined) return null
  const total = mode === 'ltx'
    ? finite(timeline.duration_frames, 120, 1)
    : timeline.segments.reduce((sum, segment) => sum + segment.length, 0)
  const ltxDisplaySegments = ltxDragPreview?.segments ?? timeline.segments
  const ltxDisplayAudioSegments = ltxDragPreview?.audioSegments ?? audioSegments
  const ltxVisualTotal = ltxVisualDuration(total, ltxDisplaySegments, ltxDisplayAudioSegments)
  const ltxMaxZoom = Math.min(
    32,
    Math.max(1, ltxVisualTotal / finite(timeline.frame_rate, 24, 1) / 4),
  )
  const ltxZoom = clamp(finite(timeline.timeline_zoom, 1, 1), 1, ltxMaxZoom)
  const ltxCurrentFrame = clamp(
    finite(liveLtxPlayhead ?? timeline.playhead, 0),
    0,
    ltxVisualTotal,
  )
  ltxPlayheadRef.current = ltxCurrentFrame
  const selectedReferences = (selected.references?.length ?? 0) > 0
    ? selected.references ?? []
    : selected.asset_id !== undefined
      ? [{ asset_id: selected.asset_id, kind: 'image' as const }]
      : []
  const toggleReference = (item: CanvasItem) => {
    const key = referenceKey(item)
    const has = selectedReferences.some((reference) => referenceKey(reference) === key)
    const next = has
      ? selectedReferences.filter((reference) => referenceKey(reference) !== key)
      : minimaxAddReference(selectedReferences, item)
    if (!has && next === selectedReferences) return
    onSnapshot()
    updateSelected({ references: next })
  }
  const patchTimelineUi = (patch: Partial<CanvasWorkflowTimeline>) => {
    onPatch({ workflow_timeline: { ...timeline, ...patch } })
  }
  const clearLtxPlayback = () => {
    if (ltxPlayback.current.animation !== null) {
      cancelAnimationFrame(ltxPlayback.current.animation)
      ltxPlayback.current.animation = null
    }
    for (const timer of ltxPlayback.current.timers) window.clearTimeout(timer)
    ltxPlayback.current.timers = []
    for (const element of ltxAudioElements.current.values()) element.pause()
  }
  const pauseLtxPlayback = (persist = true) => {
    clearLtxPlayback()
    setLtxPlaying(false)
    setLiveLtxPlayhead(null)
    if (persist) patchTimelineUi({ playhead: ltxPlayheadRef.current })
  }
  const startLtxPlayback = (at = ltxCurrentFrame): void => {
    clearLtxPlayback()
    const frameRate = finite(timeline.frame_rate, 24, 1)
    const startFrame = clamp(at, 0, ltxVisualTotal)
    const startTime = performance.now()
    ltxPlayback.current.startFrame = startFrame
    ltxPlayback.current.startTime = startTime
    setLiveLtxPlayhead(startFrame)
    setLtxPlaying(true)

    for (const segment of audioSegments) {
      const element = ltxAudioElements.current.get(segment.id)
      if (element === undefined || segment.start + segment.length <= startFrame) continue
      const skippedFrames = Math.max(0, startFrame - segment.start)
      const waitFrames = Math.max(0, segment.start - startFrame)
      const play = () => {
        element.currentTime = (segment.trim_start + skippedFrames) / frameRate
        void element.play().catch(() => undefined)
      }
      if (waitFrames === 0) play()
      else ltxPlayback.current.timers.push(window.setTimeout(play, waitFrames / frameRate * 1000))
      const remainingFrames = segment.length - skippedFrames + waitFrames
      ltxPlayback.current.timers.push(window.setTimeout(
        () => element.pause(),
        Math.max(0, remainingFrames / frameRate * 1000),
      ))
    }

    const step = (now: number) => {
      const frame = startFrame + (now - startTime) / 1000 * frameRate
      const loopBound = startFrame >= total ? ltxVisualTotal : total
      if (timeline.loop && frame >= loopBound) {
        startLtxPlayback(0)
        return
      }
      if (!timeline.loop && frame >= ltxVisualTotal) {
        ltxPlayheadRef.current = ltxVisualTotal
        setLiveLtxPlayhead(ltxVisualTotal)
        clearLtxPlayback()
        setLtxPlaying(false)
        patchTimelineUi({ playhead: ltxVisualTotal })
        return
      }
      ltxPlayheadRef.current = frame
      setLiveLtxPlayhead(frame)
      ltxPlayback.current.animation = requestAnimationFrame(step)
    }
    ltxPlayback.current.animation = requestAnimationFrame(step)
  }
  const scrubLtx = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    onSnapshot()
    const rect = ltxTrackContent.current?.getBoundingClientRect()
    if (rect === undefined) return
    const apply = (clientX: number) => {
      const frame = ltxFrameFromPointer(ltxVisualTotal, clientX, rect.left, rect.width)
      ltxPlayheadRef.current = frame
      setLiveLtxPlayhead(frame)
      if (ltxPlaying) startLtxPlayback(frame)
    }
    const move = (next: PointerEvent) => apply(next.clientX)
    const finish = () => {
      patchTimelineUi({ playhead: ltxPlayheadRef.current })
      setLiveLtxPlayhead(null)
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', finish, true)
      window.removeEventListener('blur', finish, true)
    }
    apply(event.clientX)
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', finish, true)
    window.addEventListener('blur', finish, true)
  }
  const startLtxSegmentDrag = (
    event: ReactPointerEvent<HTMLElement>,
    track: 'image' | 'audio',
    operation: LtxResizeOperation | { type: 'center'; id: string },
  ) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const rect = ltxTrackContent.current?.getBoundingClientRect()
    if (rect === undefined) return
    onSnapshot()
    const initialSegments = orderedLtxSegments(timeline.segments)
    const initialAudioSegments = orderedAudioSegments(audioSegments)
    const origin = event.clientX
    const source = track === 'image' ? initialSegments : initialAudioSegments
    const target = source.find((segment) => segment.id === operation.id)
    if (target === undefined) return
    const initialPreview = {
      track,
      selectedId: operation.id,
      segments: initialSegments,
      audioSegments: initialAudioSegments,
    }
    ltxDragLatest.current = initialPreview
    setLtxDragPreview(initialPreview)

    const apply = (clientX: number) => {
      const delta = Math.round((clientX - origin) / rect.width * ltxVisualTotal)
      const pointerFrame = ltxFrameFromPointer(
        ltxVisualTotal,
        clientX,
        rect.left,
        rect.width,
      )
      let nextSegments = initialSegments
      let nextAudioSegments = initialAudioSegments
      if (track === 'image') {
        nextSegments = operation.type === 'center'
          ? ltxMoveSegments(
              initialSegments,
              operation.id,
              target.start + delta,
              pointerFrame,
              ltxVisualTotal,
            )
          : ltxResizeSegments(initialSegments, operation, delta, ltxVisualTotal)
      } else {
        nextAudioSegments = operation.type === 'center'
          ? ltxMoveSegments(
              initialAudioSegments,
              operation.id,
              target.start + delta,
              pointerFrame,
              ltxVisualTotal,
            )
          : ltxResizeSegments(initialAudioSegments, operation, delta, ltxVisualTotal)
      }
      const preview = {
        track,
        selectedId: operation.id,
        segments: nextSegments,
        audioSegments: nextAudioSegments,
      }
      ltxDragLatest.current = preview
      setLtxDragPreview(preview)
    }
    const move = (next: PointerEvent) => apply(next.clientX)
    const finish = () => {
      const preview = ltxDragLatest.current ?? initialPreview
      commit(
        preview.segments,
        track === 'image' ? operation.id : timeline.selected_id,
        timeline.frame_rate,
        timeline.duration_frames,
        preview.audioSegments,
        track === 'audio' ? operation.id : timeline.selected_audio_id,
        { selected_track: track },
      )
      ltxDragLatest.current = null
      setLtxDragPreview(null)
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', finish, true)
      window.removeEventListener('blur', finish, true)
    }
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', finish, true)
    window.addEventListener('blur', finish, true)
  }
  const commitMiniMax = (
    segments: CanvasWorkflowSegment[],
    selectedId: string,
    patch: Partial<CanvasWorkflowTimeline> = {},
  ) => commit(
    segments,
    selectedId,
    timeline.frame_rate,
    timeline.duration_frames,
    audioSegments,
    timeline.selected_audio_id,
    patch,
  )
  const selectMiniMaxSegment = (segment: CanvasWorkflowSegment) => {
    setLivePlayhead(null)
    commitMiniMax(timeline.segments, segment.id, { playhead: segment.start })
  }
  const addReferenceToSegment = (segmentId: string, item: CanvasItem) => {
    const segment = timeline.segments.find((candidate) => candidate.id === segmentId)
    if (segment === undefined) return
    const current = segment.references ?? []
    const nextReferences = minimaxAddReference(current, item)
    if (nextReferences === current) return
    onSnapshot()
    commitMiniMax(
      timeline.segments.map((candidate) => candidate.id === segmentId
        ? { ...candidate, references: nextReferences }
        : candidate),
      segmentId,
      { playhead: segment.start },
    )
  }
  const assignResultToSegment = (segmentId: string, item: CanvasItem) => {
    const segment = timeline.segments.find((candidate) => candidate.id === segmentId)
    if (segment === undefined) return
    onSnapshot()
    commitMiniMax(
      timeline.segments.map((candidate) => candidate.id === segmentId
        ? { ...candidate, result: { ...item } }
        : candidate),
      segmentId,
      { playhead: segment.start },
    )
  }
  const dropOnSegment = (segmentId: string, lane: 'video' | 'reference') => {
    if (dragged === null) return
    if (lane === 'video' && dragged.mode === 'result') {
      assignResultToSegment(segmentId, dragged.item)
    } else {
      addReferenceToSegment(segmentId, dragged.item)
    }
    setDragged(null)
  }
  const resizeTimelinePane = (
    event: ReactPointerEvent<HTMLSpanElement>,
    key:
      | 'preview_height'
      | 'asset_pane_width'
      | 'video_track_height'
      | 'reference_track_height'
      | 'image_track_height'
      | 'audio_track_height',
    axis: 'x' | 'y',
    minimum: number,
    maximum: number,
  ) => {
    event.preventDefault()
    event.stopPropagation()
    onSnapshot()
    const origin = axis === 'x' ? event.clientX : event.clientY
    const initial = finite(timeline[key], minimum)
    const move = (next: PointerEvent) => {
      const point = axis === 'x' ? next.clientX : next.clientY
      patchTimelineUi({ [key]: clamp(initial + point - origin, minimum, maximum) })
    }
    const finish = () => {
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', finish, true)
      window.removeEventListener('blur', finish, true)
    }
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', finish, true)
    window.addEventListener('blur', finish, true)
  }
  const resizeLtxTrackDivider = (event: ReactPointerEvent<HTMLSpanElement>) => {
    event.preventDefault()
    event.stopPropagation()
    onSnapshot()
    const origin = event.clientY
    const initialImage = finite(timeline.image_track_height, 160)
    const initialAudio = finite(timeline.audio_track_height, 80)
    const combined = initialImage + initialAudio
    const move = (next: PointerEvent) => {
      const image = clamp(
        initialImage + next.clientY - origin,
        LTX_IMAGE_TRACK_MIN,
        combined - LTX_AUDIO_TRACK_MIN,
      )
      patchTimelineUi({
        image_track_height: image,
        audio_track_height: combined - image,
      })
    }
    const finish = () => {
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', finish, true)
      window.removeEventListener('blur', finish, true)
    }
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', finish, true)
    window.addEventListener('blur', finish, true)
  }
  const scrubMiniMax = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    onSnapshot()
    const rect = event.currentTarget.getBoundingClientRect()
    const apply = (clientX: number) => {
      const at = minimaxPlayheadFromPointer(total, clientX, rect.left, rect.width)
      setLivePlayhead(null)
      const active = timeline.segments.find(
        (segment) => at >= segment.start && at <= segment.start + segment.length,
      ) ?? selected
      commitMiniMax(timeline.segments, active.id, { playhead: at })
      if (active.id === selected.id && previewMedia.current !== null) {
        previewMedia.current.currentTime = clamp(at - active.start, 0, active.length)
      }
    }
    const move = (next: PointerEvent) => apply(next.clientX)
    const finish = () => {
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', finish, true)
      window.removeEventListener('blur', finish, true)
    }
    apply(event.clientX)
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', finish, true)
    window.addEventListener('blur', finish, true)
  }
  const playhead = clamp(finite(livePlayhead ?? timeline.playhead, 0), 0, total)
  const referenceLaneCount = Math.max(
    1,
    ...timeline.segments.map((segment) => segment.references?.length ?? 0),
  )
  const outputMaterials = timeline.segments.flatMap((segment) => (
    segment.result === undefined ? [] : [segment.result]
  )).filter((item, index, items) => (
    items.findIndex((candidate) => referenceKey(candidate) === referenceKey(item)) === index
  ))
  const resultUrl = selected.result?.kind === 'image' && selected.result.asset_id !== undefined
    ? `/api/images/assets/${selected.result.asset_id}/display`
    : selected.result?.url
  const exportableClips = timeline.segments.flatMap((segment) => {
    const mediaId = segment.result?.kind === 'video' ? segment.result.media_asset_id : undefined
    if (mediaId === undefined) return []
    return [{
      media_asset_id: mediaId,
      start: segment.trim_in ?? 0,
      end: segment.trim_out ?? segment.length,
      duration: segment.length,
    }]
  })
  const download = (url: string, name: string) => saveFile(url, name)
  const exportTimeline = async () => {
    if (exportableClips.length === 0 || exporting) return
    setExporting(true)
    try {
      const asset = await apiStudio.exportMiniMaxTimeline({
        clips: exportableClips,
        filename: `minimax-timeline-${Date.now()}.mp4`,
      })
      download(asset.url, asset.name)
      toast.success('MiniMax 时间线已导出并存入素材库')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'MiniMax 时间线导出失败')
    } finally {
      setExporting(false)
    }
  }
  const formatLtxFrame = (frame: number, suffix = true) => {
    if (timeline.display_mode === 'frames') {
      return `${Math.round(frame)}${suffix ? 'f' : ''}`
    }
    const seconds = frame / finite(timeline.frame_rate, 24, 1)
    return `${seconds.toFixed(2)}${suffix ? 's' : ''}`
  }
  const ltxImageGaps = ltxGapRegions(ltxDisplaySegments, total)
  const ltxAudioGaps = ltxGapRegions(ltxDisplayAudioSegments, total)

  return (
    <section className="scv-workflow-timeline" aria-label={mode === 'ltx' ? 'LTX 时间轴' : 'MiniMax 分镜'}>
      <div className="scv-workflow-timeline-head">
        <div>
          <strong>{mode === 'ltx' ? 'LTX 分镜时间轴' : 'MiniMax 分镜列表'}</strong>
          <span>
            {timeline.segments.length} 段 · {mode === 'ltx'
              ? `${Math.round(total)} 帧 / ${(total / finite(timeline.frame_rate, 24, 1)).toFixed(2)} 秒`
              : `${total.toFixed(1)} 秒`}
          </span>
        </div>
        {mode === 'ltx' && (
          <>
            <label>总帧数
              <input
                type="number"
                min={1}
                max={10000}
                value={timeline.duration_frames ?? 120}
                onFocus={onSnapshot}
                onChange={(event) => commit(
                  timeline.segments,
                  timeline.selected_id,
                  timeline.frame_rate,
                  Number(event.target.value),
                )}
              />
            </label>
            <label>总秒数
              <input
                type="number"
                min={0.1}
                max={1000}
                step={0.01}
                value={(finite(timeline.duration_frames, 120, 1) / finite(timeline.frame_rate, 24, 1)).toFixed(3)}
                onFocus={onSnapshot}
                onChange={(event) => commit(
                  timeline.segments,
                  timeline.selected_id,
                  timeline.frame_rate,
                  Math.max(1, Math.round(Number(event.target.value) * finite(timeline.frame_rate, 24, 1))),
                )}
              />
            </label>
            <label>帧率
              <input
                type="number"
                min={1}
                max={240}
                value={timeline.frame_rate ?? 24}
                onFocus={onSnapshot}
                onChange={(event) => commit(timeline.segments, timeline.selected_id, Number(event.target.value))}
              />
            </label>
          </>
        )}
        <button type="button" onClick={() => add('text')}>+ 文本段</button>
        <button type="button" onClick={() => add('image')} disabled={refs.length === 0}>+ 参考图段</button>
        {mode === 'ltx' && (
          <button
            type="button"
            onClick={addAudio}
            disabled={!mediaRefs.some((item) => item.kind === 'audio' && item.media_asset_id !== undefined)}
          >+ 音频段</button>
        )}
        {mode === 'minimax' && (
          <button
            type="button"
            disabled={exportableClips.length === 0 || exporting}
            onClick={() => void exportTimeline()}
          >
            {exporting ? '导出中…' : `导出时间线（${exportableClips.length} 段）`}
          </button>
        )}
      </div>

      {mode === 'minimax' ? (
        <div className="scv-minimax-workbench">
          <div className="scv-minimax-toolbar">
            <strong>MiniMax Canvas Workbench</strong>
            <span>{playhead.toFixed(1)}s / {total.toFixed(1)}s</span>
            <button
              type="button"
              disabled={resultUrl === undefined || selected.result?.kind === 'image'}
              onClick={() => {
                const media = previewMedia.current
                if (media === null) return
                if (media.paused) {
                  void media.play().catch(() => toast.error('当前媒体无法播放'))
                } else {
                  media.pause()
                }
              }}
            >播放 / 暂停</button>
            {resultUrl !== undefined && resultUrl !== '' && (
              <button
                type="button"
                onClick={() => download(resultUrl, selected.result?.name ?? 'minimax-result')}
              >下载当前</button>
            )}
          </div>
          <div
            className="scv-minimax-workbench-body"
            style={{ gridTemplateColumns: `${timeline.asset_pane_width ?? 180}px minmax(560px, 1fr)` }}
          >
            <aside className="scv-minimax-library">
              <section>
                <strong>Assets</strong>
                <small>拖到 Refs 轨或片段</small>
                <div>
                  {mediaRefs.length === 0 && <em>连接图片、视频或音频节点后显示</em>}
                  {mediaRefs.map((item, index) => (
                    <button
                      type="button"
                      key={referenceKey(item)}
                      draggable
                      onDragStart={() => setDragged({ mode: 'reference', item })}
                      onDragEnd={() => setDragged(null)}
                      onClick={() => toggleReference(item)}
                    >
                      {item.kind === 'image' && item.asset_id !== undefined
                        ? <img src={`/api/images/assets/${item.asset_id}/thumb`} alt="" />
                        : <b>{item.kind === 'video' ? '视' : '音'}</b>}
                      <span>{item.name ?? `${item.kind} ${index + 1}`}</span>
                    </button>
                  ))}
                </div>
              </section>
              <section>
                <strong>Output</strong>
                <small>拖到 Video 轨替换片段结果</small>
                <div>
                  {outputMaterials.length === 0 && <em>生成完成后出现在这里</em>}
                  {outputMaterials.map((item, index) => (
                    <button
                      type="button"
                      key={referenceKey(item)}
                      draggable
                      onDragStart={() => setDragged({ mode: 'result', item })}
                      onDragEnd={() => setDragged(null)}
                    >
                      {item.kind === 'image' && item.asset_id !== undefined
                        ? <img src={`/api/images/assets/${item.asset_id}/thumb`} alt="" />
                        : <b>{item.kind === 'video' ? '视' : '音'}</b>}
                      <span>{item.name ?? `输出 ${index + 1}`}</span>
                    </button>
                  ))}
                </div>
              </section>
              <span
                className="scv-minimax-resize is-vertical"
                role="separator"
                aria-label="调整素材栏宽度"
                aria-orientation="vertical"
                onPointerDown={(event) => resizeTimelinePane(
                  event,
                  'asset_pane_width',
                  'x',
                  MINIMAX_ASSET_MIN,
                  MINIMAX_ASSET_MAX,
                )}
              />
            </aside>
            <div className="scv-minimax-stage">
              <div
                className="scv-minimax-player"
                style={{ height: `${timeline.preview_height ?? 180}px` }}
              >
                {resultUrl === undefined || resultUrl === '' ? (
                  <em>选择片段并生成结果后在此预览</em>
                ) : selected.result?.kind === 'video' ? (
                  <video
                    ref={(element) => { previewMedia.current = element }}
                    src={resultUrl}
                    controls
                    preload="metadata"
                    onTimeUpdate={(event) => setLivePlayhead(
                      clamp(selected.start + event.currentTarget.currentTime, 0, total),
                    )}
                    onPause={(event) => patchTimelineUi({
                      playhead: clamp(selected.start + event.currentTarget.currentTime, 0, total),
                    })}
                  />
                ) : selected.result?.kind === 'audio' ? (
                  <audio
                    ref={(element) => { previewMedia.current = element }}
                    src={resultUrl}
                    controls
                    preload="metadata"
                    onTimeUpdate={(event) => setLivePlayhead(
                      clamp(selected.start + event.currentTarget.currentTime, 0, total),
                    )}
                    onPause={(event) => patchTimelineUi({
                      playhead: clamp(selected.start + event.currentTarget.currentTime, 0, total),
                    })}
                  />
                ) : (
                  <img src={resultUrl} alt="当前片段结果" />
                )}
                <span>片段 {selectedIndex + 1} · {selected.prompt || '未填写提示词'}</span>
                {selected.result !== undefined && (
                  <button
                    type="button"
                    onClick={() => {
                      onSnapshot()
                      updateSelected({ result: undefined })
                    }}
                  >清除结果</button>
                )}
              </div>
              <span
                className="scv-minimax-resize is-horizontal"
                style={{ top: `${(timeline.preview_height ?? 180) - 5}px` }}
                role="separator"
                aria-label="调整预览区高度"
                aria-orientation="horizontal"
                onPointerDown={(event) => resizeTimelinePane(
                  event,
                  'preview_height',
                  'y',
                  MINIMAX_PREVIEW_MIN,
                  MINIMAX_PREVIEW_MAX,
                )}
              />
              <div className="scv-minimax-tracks">
                <div className="scv-minimax-ruler-row">
                  <b>Time</b>
                  <div onPointerDown={scrubMiniMax}>
                    {Array.from({ length: 6 }, (_, index) => (
                      <span key={index} style={{ left: `${index * 20}%` }}>
                        {(total * index / 5).toFixed(1)}s
                      </span>
                    ))}
                    <i style={{ left: `${total <= 0 ? 0 : playhead / total * 100}%` }} />
                  </div>
                </div>
                <div className="scv-minimax-track-row">
                  <b>Video</b>
                  <div
                    className="scv-minimax-video-track"
                    style={{ height: `${timeline.video_track_height ?? 68}px` }}
                  >
                    {timeline.segments.map((segment, index) => (
                      <button
                        type="button"
                        key={segment.id}
                        className={segment.id === selected.id ? 'is-active' : ''}
                        style={{
                          left: `${total <= 0 ? 0 : segment.start / total * 100}%`,
                          width: `${total <= 0 ? 100 : segment.length / total * 100}%`,
                        }}
                        onClick={() => selectMiniMaxSegment(segment)}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={() => dropOnSegment(segment.id, 'video')}
                      >
                        <b>{index + 1}</b>
                        <span>{segment.result?.name ?? (segment.prompt || '未填写提示词')}</span>
                        <small>{segment.start.toFixed(1)}–{(segment.start + segment.length).toFixed(1)}s</small>
                      </button>
                    ))}
                    <i style={{ left: `${total <= 0 ? 0 : playhead / total * 100}%` }} />
                    <span
                      className="scv-minimax-resize is-track"
                      role="separator"
                      aria-label="调整视频轨高度"
                      aria-orientation="horizontal"
                      onPointerDown={(event) => resizeTimelinePane(
                        event,
                        'video_track_height',
                        'y',
                        MINIMAX_VIDEO_TRACK_MIN,
                        MINIMAX_VIDEO_TRACK_MAX,
                      )}
                    />
                  </div>
                </div>
                <div className="scv-minimax-reference-tracks">
                  <b>Refs</b>
                  <div>
                    {Array.from({ length: referenceLaneCount }, (_, laneIndex) => (
                      <div
                        className="scv-minimax-reference-lane"
                        key={laneIndex}
                        style={{ height: `${timeline.reference_track_height ?? 38}px` }}
                      >
                        {timeline.segments.map((segment) => {
                          const reference = segment.references?.[laneIndex]
                          return (
                            <div
                              key={segment.id}
                              className={segment.id === selected.id ? 'is-active' : ''}
                              style={{
                                left: `${total <= 0 ? 0 : segment.start / total * 100}%`,
                                width: `${total <= 0 ? 100 : segment.length / total * 100}%`,
                              }}
                              onClick={() => selectMiniMaxSegment(segment)}
                              onDragOver={(event) => event.preventDefault()}
                              onDrop={() => dropOnSegment(segment.id, 'reference')}
                            >
                              {reference === undefined ? (
                                <span>拖入参考</span>
                              ) : (
                                <>
                                  <span>{reference.name ?? reference.kind}</span>
                                  <button
                                    type="button"
                                    aria-label={`移除片段 ${segment.id} 的参考 ${laneIndex + 1}`}
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      onSnapshot()
                                      commitMiniMax(
                                        timeline.segments.map((candidate) => candidate.id === segment.id
                                          ? {
                                              ...candidate,
                                              references: (candidate.references ?? []).filter(
                                                (_, index) => index !== laneIndex,
                                              ),
                                            }
                                          : candidate),
                                        segment.id,
                                        { playhead: segment.start },
                                      )
                                    }}
                                  >×</button>
                                </>
                              )}
                            </div>
                          )
                        })}
                        <i style={{ left: `${total <= 0 ? 0 : playhead / total * 100}%` }} />
                        <span
                          className="scv-minimax-resize is-track"
                          role="separator"
                          aria-label={`调整参考轨 ${laneIndex + 1} 高度`}
                          aria-orientation="horizontal"
                          onPointerDown={(event) => resizeTimelinePane(
                            event,
                            'reference_track_height',
                            'y',
                            MINIMAX_REF_TRACK_MIN,
                            MINIMAX_REF_TRACK_MAX,
                          )}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div
          className="scv-ltx-workbench"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === ' ') {
              event.preventDefault()
              if (ltxPlaying) pauseLtxPlayback()
              else startLtxPlayback()
            } else if ((event.key === 'Delete' || event.key === 'Backspace')
              && timeline.selected_track === 'audio') {
              event.preventDefault()
              removeSelectedAudio()
            }
          }}
        >
          <div className="scv-ltx-toolbar">
            <strong>Prompt Relay</strong>
            <span>{formatLtxFrame(ltxCurrentFrame)} / {formatLtxFrame(ltxVisualTotal)}</span>
            <button
              type="button"
              aria-label={ltxPlaying ? '暂停 LTX 时间线' : '播放 LTX 时间线'}
              onClick={() => {
                if (ltxPlaying) pauseLtxPlayback()
                else startLtxPlayback()
              }}
            >{ltxPlaying ? 'Ⅱ' : '▶'}</button>
            <button
              type="button"
              className={timeline.loop ? 'is-active' : ''}
              aria-pressed={Boolean(timeline.loop)}
              onClick={() => {
                onSnapshot()
                patchTimelineUi({ loop: !timeline.loop })
              }}
            >循环</button>
            <button
              type="button"
              onClick={() => {
                onSnapshot()
                patchTimelineUi({
                  display_mode: timeline.display_mode === 'frames' ? 'seconds' : 'frames',
                })
              }}
            >{timeline.display_mode === 'frames' ? '帧' : '秒'}</button>
            <button
              type="button"
              className={node.workflow_values?.f_use_custom_audio ? 'is-active' : ''}
              aria-pressed={Boolean(node.workflow_values?.f_use_custom_audio)}
              onClick={() => {
                onSnapshot()
                onPatch({
                  workflow_values: {
                    ...node.workflow_values,
                    f_use_custom_audio: !node.workflow_values?.f_use_custom_audio,
                  },
                })
              }}
            >自定义音频 {node.workflow_values?.f_use_custom_audio ? 'ON' : 'OFF'}</button>
            <div className="scv-ltx-zoom">
              <button
                type="button"
                aria-label="缩小时间线"
                onClick={() => patchTimelineUi({ timeline_zoom: Math.max(1, ltxZoom - 0.5) })}
              >−</button>
              <input
                type="range"
                min={1}
                max={ltxMaxZoom}
                step={0.1}
                value={ltxZoom}
                aria-label="LTX 时间线缩放"
                onFocus={onSnapshot}
                onChange={(event) => patchTimelineUi({ timeline_zoom: Number(event.target.value) })}
              />
              <button
                type="button"
                aria-label="放大时间线"
                onClick={() => patchTimelineUi({
                  timeline_zoom: Math.min(ltxMaxZoom, ltxZoom + 0.5),
                })}
              >＋</button>
              <button type="button" onClick={() => patchTimelineUi({ timeline_zoom: 1 })}>适配</button>
            </div>
          </div>
          <div
            className="scv-ltx-viewport"
            ref={ltxViewport}
            onWheel={(event) => {
              if (!event.ctrlKey && !event.metaKey) return
              event.preventDefault()
              const viewport = event.currentTarget
              const contentWidth = ltxTrackContent.current?.getBoundingClientRect().width
                ?? viewport.clientWidth
              const mouseX = event.clientX - viewport.getBoundingClientRect().left
              const ratio = (viewport.scrollLeft + mouseX) / Math.max(1, contentWidth)
              const nextZoom = clamp(
                ltxZoom + (event.deltaY > 0 ? -0.5 : 0.5),
                1,
                ltxMaxZoom,
              )
              patchTimelineUi({ timeline_zoom: nextZoom })
              requestAnimationFrame(() => {
                const nextWidth = viewport.clientWidth * nextZoom
                viewport.scrollLeft = ratio * nextWidth - mouseX
              })
            }}
          >
            <div
              className="scv-ltx-track-content"
              ref={ltxTrackContent}
              style={{ width: `${ltxZoom * 100}%` }}
            >
              <div className="scv-ltx-ruler" onPointerDown={scrubLtx}>
                {Array.from({ length: 11 }, (_, index) => {
                  const frame = ltxVisualTotal * index / 10
                  return (
                    <span key={index} style={{ left: `${index * 10}%` }}>
                      {formatLtxFrame(frame, false)}
                    </span>
                  )
                })}
              </div>
              <div
                className="scv-ltx-image-track"
                style={{ height: `${timeline.image_track_height ?? 160}px` }}
                onPointerDown={(event) => {
                  if (event.target === event.currentTarget) scrubLtx(event)
                }}
              >
                <b className="scv-ltx-track-label">Visual</b>
                {ltxImageGaps.map((gap) => (
                  <button
                    type="button"
                    className="scv-ltx-gap-add"
                    key={`${gap.start}-${gap.end}`}
                    title="在空隙中添加文本段"
                    style={{ left: `${(gap.start + gap.end) / 2 / ltxVisualTotal * 100}%` }}
                    onClick={() => addLtxTextInGap(gap.start, gap.end)}
                  >＋</button>
                ))}
                {ltxDisplaySegments.map((segment, index) => {
                  const next = ltxDisplaySegments.find(
                    (candidate) => candidate.id !== segment.id
                      && candidate.start === segment.start + segment.length,
                  )
                  const active = ltxDragPreview?.track === 'image'
                    ? ltxDragPreview.selectedId === segment.id
                    : timeline.selected_track === 'image' && selected.id === segment.id
                  return (
                    <article
                      key={segment.id}
                      className={`${active ? 'is-active' : ''} ${segment.type === 'text' ? 'is-text' : 'is-image'}`}
                      style={{
                        left: `${segment.start / ltxVisualTotal * 100}%`,
                        width: `${segment.length / ltxVisualTotal * 100}%`,
                      }}
                      role="button"
                      tabIndex={0}
                      aria-label={`画面片段 ${index + 1}，${segment.start} 到 ${segment.start + segment.length} 帧`}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') commit(
                          timeline.segments,
                          segment.id,
                          timeline.frame_rate,
                          timeline.duration_frames,
                          audioSegments,
                          timeline.selected_audio_id,
                          { selected_track: 'image' },
                        )
                      }}
                    >
                      <div
                        className="scv-ltx-segment-body"
                        onPointerDown={(event) => startLtxSegmentDrag(
                          event,
                          'image',
                          { type: 'center', id: segment.id },
                        )}
                      >
                        {segment.type === 'image' && segment.asset_id !== undefined && (
                          <img
                            src={`/api/images/assets/${segment.asset_id}/display`}
                            alt=""
                            draggable={false}
                          />
                        )}
                        <span>{segment.prompt || (segment.type === 'text' ? '(no prompt)' : `图 ${index + 1}`)}</span>
                        <small>{formatLtxFrame(segment.start, false)}–{formatLtxFrame(segment.start + segment.length, false)}</small>
                      </div>
                      <button
                        type="button"
                        className="scv-ltx-edge is-left"
                        aria-label={`调整片段 ${index + 1} 左边界`}
                        onPointerDown={(event) => startLtxSegmentDrag(
                          event,
                          'image',
                          { type: 'left', id: segment.id },
                        )}
                      />
                      <button
                        type="button"
                        className={`scv-ltx-edge is-right ${next === undefined ? '' : 'is-joint'}`}
                        aria-label={next === undefined
                          ? `调整片段 ${index + 1} 右边界`
                          : `联动调整片段 ${index + 1} 和相邻片段`}
                        onPointerDown={(event) => startLtxSegmentDrag(
                          event,
                          'image',
                          next === undefined
                            ? { type: 'right', id: segment.id }
                            : { type: 'joint', id: segment.id, rightId: next.id },
                        )}
                      />
                    </article>
                  )
                })}
              </div>
              <span
                className="scv-ltx-track-divider"
                role="separator"
                aria-label="调整画面轨与音频轨高度"
                aria-orientation="horizontal"
                onPointerDown={resizeLtxTrackDivider}
              />
              <div
                className="scv-ltx-audio-lane"
                style={{ height: `${timeline.audio_track_height ?? 80}px` }}
                onPointerDown={(event) => {
                  if (event.target === event.currentTarget) scrubLtx(event)
                }}
              >
                <b className="scv-ltx-track-label">Audio</b>
                {audioSegments.length === 0 && <em>连接音频节点后可添加自定义音轨</em>}
                {ltxAudioGaps.map((gap) => (
                  <button
                    type="button"
                    className="scv-ltx-gap-add"
                    key={`${gap.start}-${gap.end}`}
                    title="在空隙中添加音频段"
                    disabled={!mediaRefs.some((item) => item.kind === 'audio')}
                    style={{ left: `${(gap.start + gap.end) / 2 / ltxVisualTotal * 100}%` }}
                    onClick={() => addLtxAudioInGap(gap.start, gap.end)}
                  >＋</button>
                ))}
                {ltxDisplayAudioSegments.map((segment, index) => {
                  const next = ltxDisplayAudioSegments.find(
                    (candidate) => candidate.id !== segment.id
                      && candidate.start === segment.start + segment.length,
                  )
                  const active = ltxDragPreview?.track === 'audio'
                    ? ltxDragPreview.selectedId === segment.id
                    : timeline.selected_track === 'audio' && selectedAudio?.id === segment.id
                  const waveform = ltxVisibleWaveform(ltxWaveforms[segment.id], segment)
                  return (
                    <article
                      key={segment.id}
                      className={active ? 'is-active' : ''}
                      style={{
                        left: `${segment.start / ltxVisualTotal * 100}%`,
                        width: `${segment.length / ltxVisualTotal * 100}%`,
                      }}
                      role="button"
                      tabIndex={0}
                      aria-label={`音频片段 ${index + 1}，${segment.start} 到 ${segment.start + segment.length} 帧`}
                    >
                      <div
                        className="scv-ltx-segment-body"
                        onPointerDown={(event) => startLtxSegmentDrag(
                          event,
                          'audio',
                          { type: 'center', id: segment.id },
                        )}
                      >
                        <div className="scv-ltx-waveform" aria-hidden="true">
                          {waveform.map((peak, peakIndex) => (
                            <i key={peakIndex} style={{ height: `${Math.max(4, peak * 92)}%` }} />
                          ))}
                        </div>
                        <span>{segment.name || `音频 #${segment.media_asset_id ?? index + 1}`}</span>
                        <small>{formatLtxFrame(segment.start, false)}–{formatLtxFrame(segment.start + segment.length, false)}</small>
                      </div>
                      <button
                        type="button"
                        className="scv-ltx-edge is-left"
                        aria-label={`调整音频片段 ${index + 1} 入点`}
                        onPointerDown={(event) => startLtxSegmentDrag(
                          event,
                          'audio',
                          { type: 'left', id: segment.id },
                        )}
                      />
                      <button
                        type="button"
                        className={`scv-ltx-edge is-right ${next === undefined ? '' : 'is-joint'}`}
                        aria-label={next === undefined
                          ? `调整音频片段 ${index + 1} 出点`
                          : `联动调整音频片段 ${index + 1} 和相邻片段`}
                        onPointerDown={(event) => startLtxSegmentDrag(
                          event,
                          'audio',
                          next === undefined
                            ? { type: 'right', id: segment.id }
                            : { type: 'joint', id: segment.id, rightId: next.id },
                        )}
                      />
                    </article>
                  )
                })}
              </div>
              {total < ltxVisualTotal && (
                <i
                  className="scv-ltx-outside-duration"
                  style={{ left: `${total / ltxVisualTotal * 100}%` }}
                />
              )}
              <i
                className="scv-ltx-playhead"
                style={{ left: `${ltxCurrentFrame / ltxVisualTotal * 100}%` }}
              />
            </div>
          </div>
          <span
            className="scv-ltx-bottom-resizer"
            role="separator"
            aria-label="调整音频轨高度"
            aria-orientation="horizontal"
            onPointerDown={(event) => resizeTimelinePane(
              event,
              'audio_track_height',
              'y',
              LTX_AUDIO_TRACK_MIN,
              LTX_AUDIO_TRACK_MAX,
            )}
          />
          {audioSegments.map((segment) => segment.url && (
            <audio
              key={segment.id}
              ref={(element) => {
                if (element === null) ltxAudioElements.current.delete(segment.id)
                else ltxAudioElements.current.set(segment.id, element)
              }}
              src={segment.url}
              preload="auto"
              aria-hidden="true"
            />
          ))}
          {selectedAudio !== undefined && timeline.selected_track === 'audio' && (
            <div className="scv-ltx-audio-editor">
              <span>
                {selectedAudio.name || 'Audio Track'} · 素材
                {formatLtxFrame(selectedAudio.audio_duration_frames ?? selectedAudio.length)} ·
                入点 {formatLtxFrame(selectedAudio.trim_start)} ·
                出点 {formatLtxFrame(
                  Math.max(
                    0,
                    (selectedAudio.audio_duration_frames ?? selectedAudio.length)
                      - selectedAudio.trim_start - selectedAudio.length,
                  ),
                )}
              </span>
              <label>开始帧
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={selectedAudio.start}
                  onFocus={onSnapshot}
                  onChange={(event) => updateSelectedAudio({ start: Number(event.target.value) })}
                />
              </label>
              <label>片段帧数
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={selectedAudio.length}
                  onFocus={onSnapshot}
                  onChange={(event) => updateSelectedAudio({ length: Number(event.target.value) })}
                />
              </label>
              <label>素材入点
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={selectedAudio.trim_start}
                  onFocus={onSnapshot}
                  onChange={(event) => updateSelectedAudio({ trim_start: Number(event.target.value) })}
                />
              </label>
              <button type="button" onClick={removeSelectedAudio}>删除音频段</button>
            </div>
          )}
        </div>
      )}

      {(mode !== 'ltx' || timeline.selected_track !== 'audio') && (
        <div className="scv-workflow-segment-editor">
        <label>片段类型
          <Picker
            size="sm"
            value={selected.type}
            onChange={(v) => {
              onSnapshot()
              updateSelected({
                type: v as CanvasWorkflowSegment['type'],
                asset_id: v === 'image' ? (selected.asset_id ?? refs[0]) : undefined,
              })
            }}
            options={[
              { value: 'text', label: '纯文本' },
              { value: 'image', label: '参考图', disabled: refs.length === 0 },
            ]}
          />
        </label>
        {selected.type === 'image' && (
          <label>上游参考图
            <Picker
              size="sm"
              value={selected.asset_id === undefined ? '' : String(selected.asset_id)}
              onChange={(v) => {
                onSnapshot()
                updateSelected({ asset_id: Number(v) })
              }}
              options={refs.map((assetId, index) => ({
                value: String(assetId),
                label: `图 ${index + 1}`,
                hint: `#${assetId}`,
              }))}
            />
          </label>
        )}
        {mode === 'ltx' && (
          <label>开始帧
            <input
              type="number"
              min={0}
              step={1}
              value={selected.start}
              onFocus={onSnapshot}
              onChange={(event) => updateSelected({ start: Number(event.target.value) })}
            />
          </label>
        )}
        <label>{mode === 'ltx' ? '帧数' : '时长（秒）'}
          <input
            type="number"
            min={mode === 'ltx' ? 1 : 0.5}
            step={mode === 'ltx' ? 1 : 0.1}
            value={selected.length}
            onFocus={onSnapshot}
            onChange={(event) => updateSelected({ length: Number(event.target.value) })}
          />
        </label>
        {mode === 'ltx' && selected.type === 'image' && (
          <label>参考强度
            <input
              type="number"
              min={0}
              max={2}
              step={0.05}
              value={selected.guideStrength ?? 1}
              onFocus={onSnapshot}
              onChange={(event) => updateSelected({ guideStrength: Number(event.target.value) })}
            />
          </label>
        )}
        {mode === 'minimax' && (
          <>
            <label>画面比例
              <Picker
                size="sm"
                value={selected.aspect_ratio ?? MINIMAX_ASPECTS[0]}
                onChange={(v) => {
                  onSnapshot()
                  updateSelected({ aspect_ratio: v })
                }}
                options={MINIMAX_ASPECTS.map((a) => ({ value: a, label: a }))}
              />
            </label>
            <label>百万像素
              <input
                type="number"
                min={0.1}
                max={2}
                step={0.1}
                value={selected.megapixels ?? 0.4}
                onFocus={onSnapshot}
                onChange={(event) => updateSelected({ megapixels: Number(event.target.value) })}
              />
            </label>
            <label>随机种子
              <input
                type="number"
                min={0}
                value={selected.seed ?? 0}
                onFocus={onSnapshot}
                onChange={(event) => updateSelected({ seed: Number(event.target.value) })}
              />
            </label>
            <label>入点（秒）
              <input
                type="number"
                min={0}
                max={Math.max(0, selected.length - 0.1)}
                step={0.1}
                value={selected.trim_in ?? 0}
                onFocus={onSnapshot}
                onChange={(event) => {
                  const trimIn = Math.max(
                    0,
                    Math.min(Number(event.target.value), (selected.trim_out ?? selected.length) - 0.1),
                  )
                  updateSelected({ trim_in: trimIn })
                }}
              />
            </label>
            <label>出点（秒）
              <input
                type="number"
                min={(selected.trim_in ?? 0) + 0.1}
                max={selected.length}
                step={0.1}
                value={selected.trim_out ?? selected.length}
                onFocus={onSnapshot}
                onChange={(event) => {
                  const trimOut = Math.min(
                    selected.length,
                    Math.max(Number(event.target.value), (selected.trim_in ?? 0) + 0.1),
                  )
                  updateSelected({ trim_out: trimOut })
                }}
              />
            </label>
            <div className="scv-minimax-references">
              <span>当前片段参考 · 图 9 / 视频 3 / 音频 3</span>
              <div>
                {mediaRefs.length === 0 && <em>连接图片、视频或音频节点后可选</em>}
                {mediaRefs.map((item, index) => {
                  const active = selectedReferences.some(
                    (reference) => referenceKey(reference) === referenceKey(item),
                  )
                  return (
                    <button
                      type="button"
                      key={referenceKey(item)}
                      className={active ? 'is-active' : ''}
                      onClick={() => toggleReference(item)}
                    >
                      {item.kind === 'image' && item.asset_id !== undefined
                        ? <img src={`/api/images/assets/${item.asset_id}/thumb`} alt="" />
                        : <b>{item.kind === 'video' ? '视' : '音'}</b>}
                      <small>{item.name ?? `${item.kind} ${index + 1}`}</small>
                    </button>
                  )
                })}
              </div>
            </div>
          </>
        )}
        <label className="scv-workflow-segment-prompt">片段提示词
          <textarea
            value={selected.prompt}
            placeholder={linkedPrompt === '' ? '描述这一段的画面和动作' : '留空时使用上游提示词'}
            onFocus={onSnapshot}
            onChange={(event) => updateSelected({ prompt: event.target.value })}
          />
        </label>
        <div className="scv-workflow-segment-actions">
          <button type="button" onClick={() => move(-1)} disabled={selectedIndex === 0}>前移</button>
          <button type="button" onClick={() => move(1)} disabled={selectedIndex === timeline.segments.length - 1}>后移</button>
          <button type="button" onClick={remove} disabled={timeline.segments.length <= 1}>删除段</button>
        </div>
        </div>
      )}
    </section>
  )
}
