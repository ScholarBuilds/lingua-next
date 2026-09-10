import type {
  CanvasItem,
  CanvasNode,
  ExecutableWorkflowDetail,
} from '../../lib/api-studio'
import {
  workflowTimelineMode,
  workflowTimelineRunValues,
} from './WorkflowTimelineEditor'

export type WorkflowMediaKind = 'image' | 'video' | 'audio'

export function workflowFields(
  detail: Pick<ExecutableWorkflowDetail, 'ui_schema'> | undefined,
): Record<string, unknown>[] {
  const fields = detail?.ui_schema?.fields
  return Array.isArray(fields)
    ? fields.filter(
        (field): field is Record<string, unknown> => typeof field === 'object' && field !== null,
      )
    : []
}

export function workflowFieldId(field: Record<string, unknown>, index: number): string {
  if (typeof field.id === 'string' && field.id !== '') return field.id
  return `${String(field.node ?? field.nodeId ?? index)}::${String(field.input ?? field.fieldName ?? index)}`
}

export function workflowFieldLabel(field: Record<string, unknown>, index: number): string {
  return String(field.name ?? field.label ?? field.input ?? field.fieldName ?? `参数 ${index + 1}`)
}

export function workflowFieldType(field: Record<string, unknown>): string {
  return String(field.type ?? field.fieldType ?? 'text').toLowerCase()
}

export function workflowFieldDefault(field: Record<string, unknown>): unknown {
  return field.default ?? field.fieldValue ?? ''
}

export function workflowFieldMediaKind(field: Record<string, unknown>): WorkflowMediaKind | null {
  const type = workflowFieldType(field)
  if (type.includes('image')) return 'image'
  if (type.includes('video')) return 'video'
  if (type.includes('audio')) return 'audio'
  return null
}

export type MiniMaxRunningHubFieldRole =
  | 'prompt'
  | 'duration'
  | 'aspect_ratio'
  | 'megapixels'
  | 'seed'

function runningHubFieldText(field: Record<string, unknown>): string {
  return [
    field.id,
    field.node,
    field.nodeId,
    field.input,
    field.fieldName,
    field.name,
    field.label,
    field.group,
    field.title,
    field.description,
    field.note,
    field.source,
  ].filter((value) => value !== undefined && value !== null).join(' ').toLowerCase()
}

/** 对齐 Infinite-Canvas 的 MiniMax RunningHub 语义匹配和固定工作流兜底键。 */
export function minimaxRunningHubFieldRole(
  field: Record<string, unknown>,
): MiniMaxRunningHubFieldRole | null {
  const id = workflowFieldId(field, 0)
  const text = runningHubFieldText(field)
  if (id === '138::value' || /prompt|positive|caption|description|关键词|提示词|正向/.test(text)) {
    return 'prompt'
  }
  if (id === '132::value' || /duration|seconds|时长|秒/.test(text)) return 'duration'
  if (id === '115::aspect_ratio' || /aspect[_\s-]?ratio|\bratio\b|画面比例|比例/.test(text)) {
    return 'aspect_ratio'
  }
  if (id === '115::megapixels' || /megapixels?|百万像素/.test(text)) return 'megapixels'
  if (/\bseed\b|随机种子|种子/.test(text)) return 'seed'
  return null
}

function minimaxRunningHubValue(
  field: Record<string, unknown>,
  role: MiniMaxRunningHubFieldRole,
  value: unknown,
): unknown {
  if (role === 'duration') return Math.max(1, Math.min(60, Number(value) || 8))
  if (role === 'megapixels') return Math.max(0.1, Math.min(2, Number(value) || 0.4))
  if (role === 'seed') return Math.max(0, Math.round(Number(value) || 0))
  if (role !== 'aspect_ratio') return value
  const desired = String(value ?? '16:9 (Widescreen)')
  const ratio = desired.match(/\d+\s*:\s*\d+/)?.[0]?.replaceAll(' ', '') ?? desired
  const options = Array.isArray(field.options) ? field.options.map(String) : []
  const normalized = ratio.replaceAll(' ', '')
  const option = options.find((item) => item.replaceAll(' ', '') === normalized)
    ?? options.find((item) => item.replaceAll(' ', '').startsWith(normalized))
  if (option !== undefined) return option
  const defaultValue = String(workflowFieldDefault(field) ?? '')
  return defaultValue.includes('(') ? desired : ratio
}

export function randomWorkflowValue(
  field: Record<string, unknown>,
  random: () => number = Math.random,
): number {
  const min = Number(field.min ?? 0)
  const max = Math.min(Number(field.max ?? 4_294_967_295), Number.MAX_SAFE_INTEGER)
  const low = Number.isFinite(min) ? min : 0
  const high = Number.isFinite(max) && max >= low ? max : 4_294_967_295
  return Math.floor(low + random() * (high - low + 1))
}

export function timelineControlledField(
  mode: 'ltx' | 'minimax' | null,
  id: string,
  field?: Record<string, unknown>,
  provider?: string,
): boolean {
  if (mode === 'minimax') {
    if (new Set([
      'f_reference_image',
      'f_minimax_references',
      'f_prompt',
      'f_duration_seconds',
      'f_aspect_ratio',
      'f_megapixels',
      'f_seed',
    ]).has(id)) return true
    return provider === 'runninghub'
      && field !== undefined
      && (workflowFieldMediaKind(field) !== null || minimaxRunningHubFieldRole(field) !== null)
  }
  if (mode === 'ltx') {
    return new Set([
      'f_timeline_data',
      'f_local_prompts',
      'f_segment_lengths',
      'f_guide_strength',
      'f_duration_frames',
      'f_duration_seconds',
      'f_frame_rate',
    ]).has(id)
  }
  return false
}

export function workflowMediaByKind(
  mediaRefs: CanvasItem[],
): Record<WorkflowMediaKind, CanvasItem[]> {
  return {
    image: mediaRefs.filter((item) => item.kind === 'image'),
    video: mediaRefs.filter((item) => item.kind === 'video'),
    audio: mediaRefs.filter((item) => item.kind === 'audio'),
  }
}

export interface PreparedCanvasWorkflowRun {
  fields: Record<string, unknown>
  missingMedia: string[]
  sourceContext: Record<string, unknown>
}

/** 手动运行与画布级联共用同一份字段绑定，避免两条入口得到不同任务。 */
export function prepareCanvasWorkflowRun(
  detail: ExecutableWorkflowDetail,
  node: CanvasNode,
  mediaRefs: CanvasItem[],
  linkedPrompt: string,
  random: () => number = Math.random,
): PreparedCanvasWorkflowRun {
  const allFields = workflowFields(detail).filter(
    (field) => detail.provider === 'comfyui' || field.enabled !== false,
  )
  const refs = workflowMediaByKind(mediaRefs).image.flatMap((item) =>
    item.asset_id === undefined ? [] : [item.asset_id],
  )
  const mode = workflowTimelineMode(detail.title ?? node.title)
  const activeMiniMaxSegment = mode === 'minimax'
    ? node.workflow_timeline?.segments.find(
        (segment) => segment.id === node.workflow_timeline?.selected_id,
      ) ?? node.workflow_timeline?.segments[0]
    : undefined
  const miniMaxReferences = (activeMiniMaxSegment?.references?.length ?? 0) > 0
    ? activeMiniMaxSegment?.references ?? []
    : activeMiniMaxSegment?.asset_id !== undefined
      ? [{ asset_id: activeMiniMaxSegment.asset_id, kind: 'image' as const }]
      : mediaRefs
  const mediaByKind = workflowMediaByKind(
    mode === 'minimax' ? miniMaxReferences : mediaRefs,
  )
  const values = node.workflow_values ?? {}
  const preparedValues = mode === null
    ? values
    : {
        ...values,
        ...workflowTimelineRunValues(mode, node, refs, linkedPrompt, mediaRefs),
      }
  const runValues: Record<string, unknown> = {}
  const missingMedia: string[] = []
  const mediaIndexes: Record<WorkflowMediaKind, number> = { image: 0, video: 0, audio: 0 }
  const randomFields = node.workflow_random_fields ?? {}
  allFields.forEach((field, index) => {
    const id = workflowFieldId(field, index)
    const mediaKind = workflowFieldMediaKind(field)
    if (mediaKind !== null) {
      const item = mediaByKind[mediaKind][mediaIndexes[mediaKind]]
      mediaIndexes[mediaKind] += 1
      const explicit = preparedValues[id]
      if (explicit !== undefined && String(explicit).trim() !== '') {
        runValues[id] = explicit
      } else if (mediaKind === 'image' && item?.asset_id !== undefined) {
        runValues[id] = `asset:${item.asset_id}`
      } else if (mediaKind !== 'image' && item?.media_asset_id !== undefined) {
        runValues[id] = `media:${item.media_asset_id}`
      } else if (field.required === true) {
        missingMedia.push(workflowFieldLabel(field, index))
      }
      return
    }
    let value = preparedValues[id]
    if (value === undefined && mode === 'minimax' && detail.provider === 'runninghub') {
      const role = minimaxRunningHubFieldRole(field)
      if (role !== null) {
        const semanticId = role === 'duration'
          ? 'f_duration_seconds'
          : role === 'aspect_ratio'
            ? 'f_aspect_ratio'
            : `f_${role}`
        value = minimaxRunningHubValue(field, role, preparedValues[semanticId])
      }
    }
    if (value === undefined && field.bind_prompt === true && linkedPrompt !== '') value = linkedPrompt
    if (value === undefined) value = workflowFieldDefault(field)
    if (field.random_enabled === true && randomFields[id] !== false) {
      value = randomWorkflowValue(field, random)
    }
    if (value !== undefined) runValues[id] = value
  })
  return {
    fields: runValues,
    missingMedia,
    sourceContext: mode === 'minimax' && node.workflow_timeline?.selected_id !== undefined
      ? { workflow_segment_id: node.workflow_timeline.selected_id }
      : {},
  }
}
