import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Save, Workflow } from '@/components/NexusIcon'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

import { Picker } from '@/components/ui/picker'
import { apiStudio } from '../../lib/api-studio'
import type { ExecutableWorkflowDetail } from '../../lib/api-studio'

type JsonRecord = Record<string, unknown>

interface ComfyNode {
  id: string
  classType: string
  title: string
  inputs: JsonRecord
}

interface GraphNode extends ComfyNode {
  x: number
  y: number
  exposed: number
}

interface GraphEdge {
  from: string
  to: string
}

const FIELD_TYPES = [
  ['text', '单行文本'],
  ['textarea', '多行文本'],
  ['number', '数字'],
  ['slider', '滑杆'],
  ['boolean', '开关'],
  ['dropdown', '下拉选项'],
  ['image', '图片'],
  ['video', '视频'],
  ['audio', '音频'],
  ['file', '文件'],
  ['json', 'JSON'],
] as const

function nodeList(payload: JsonRecord): ComfyNode[] {
  return Object.entries(payload).flatMap(([id, raw]) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return []
    const node = raw as JsonRecord
    if (typeof node.class_type !== 'string') return []
    const meta = typeof node._meta === 'object' && node._meta !== null
      ? node._meta as JsonRecord
      : {}
    return [{
      id,
      classType: node.class_type,
      title: typeof meta.title === 'string' && meta.title.trim() !== ''
        ? meta.title
        : node.class_type,
      inputs: typeof node.inputs === 'object' && node.inputs !== null && !Array.isArray(node.inputs)
        ? node.inputs as JsonRecord
        : {},
    }]
  }).sort((left, right) => Number(left.id) - Number(right.id))
}

function linkedNode(value: unknown, ids: Set<string>): string | null {
  if (!Array.isArray(value) || value.length < 2) return null
  const candidate = String(value[0] ?? '')
  return ids.has(candidate) ? candidate : null
}

function graphLayout(nodes: ComfyNode[], fields: JsonRecord[]) {
  const ids = new Set(nodes.map((node) => node.id))
  const edges: GraphEdge[] = []
  const parents = new Map(nodes.map((node) => [node.id, new Set<string>()]))
  for (const node of nodes) {
    for (const value of Object.values(node.inputs)) {
      const from = linkedNode(value, ids)
      if (from === null) continue
      edges.push({ from, to: node.id })
      parents.get(node.id)?.add(from)
    }
  }
  const layer = new Map<string, number>()
  const visiting = new Set<string>()
  const depth = (id: string): number => {
    if (layer.has(id)) return layer.get(id) ?? 0
    if (visiting.has(id)) return 0
    visiting.add(id)
    const upstream = [...(parents.get(id) ?? [])]
    const value = upstream.length === 0 ? 0 : Math.max(...upstream.map(depth)) + 1
    visiting.delete(id)
    layer.set(id, value)
    return value
  }
  nodes.forEach((node) => depth(node.id))
  const buckets = new Map<number, ComfyNode[]>()
  for (const node of nodes) {
    const index = layer.get(node.id) ?? 0
    buckets.set(index, [...(buckets.get(index) ?? []), node])
  }
  const graphNodes: GraphNode[] = []
  for (const [column, rows] of [...buckets.entries()].sort(([a], [b]) => a - b)) {
    rows.forEach((node, row) => {
      graphNodes.push({
        ...node,
        x: 24 + column * 230,
        y: 24 + row * 94,
        exposed: fields.filter((field) => String(field.node ?? field.nodeId ?? '') === node.id).length,
      })
    })
  }
  const maxColumn = Math.max(0, ...graphNodes.map((node) => Math.round((node.x - 24) / 230)))
  const maxRows = Math.max(1, ...[...buckets.values()].map((rows) => rows.length))
  return {
    nodes: graphNodes,
    edges,
    width: Math.max(620, 24 + (maxColumn + 1) * 230),
    height: Math.max(260, 24 + maxRows * 94),
  }
}

function fieldId(field: JsonRecord): string {
  return String(field.id ?? '')
}

function fieldFor(fields: JsonRecord[], nodeId: string, input: string) {
  return fields.find((field) =>
    String(field.node ?? field.nodeId ?? '') === nodeId &&
    String(field.input ?? field.fieldName ?? '') === input,
  )
}

function inputLabel(input: string): string {
  return input.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function guessType(input: string, value: unknown): string {
  const name = input.toLowerCase()
  if (/image|图片|图像/.test(name)) return 'image'
  if (/video|视频/.test(name)) return 'video'
  if (/audio|音频/.test(name)) return 'audio'
  if (/prompt|text|caption|提示词|文本/.test(name)) return 'textarea'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'object' && value !== null) return 'json'
  return 'text'
}

function defaultValue(value: unknown): unknown {
  return typeof value === 'object' && value !== null ? null : value
}

function preview(value: unknown): string {
  if (typeof value === 'string') return value.length > 64 ? `${value.slice(0, 64)}…` : value
  try {
    const text = JSON.stringify(value)
    return text.length > 64 ? `${text.slice(0, 64)}…` : text
  } catch {
    return String(value)
  }
}

export function ComfyWorkflowEditor({ detail }: { detail: ExecutableWorkflowDetail }) {
  const queryClient = useQueryClient()
  const [title, setTitle] = useState(detail.title)
  const [schema, setSchema] = useState<JsonRecord>(() => ({ ...(detail.ui_schema ?? {}) }))
  const [fields, setFields] = useState<JsonRecord[]>(() => {
    const raw = detail.ui_schema?.fields
    return Array.isArray(raw) ? raw.map((field) => ({ ...(field as JsonRecord) })) : []
  })
  const nodes = useMemo(() => nodeList(detail.payload), [detail.payload])
  const [selectedNodeId, setSelectedNodeId] = useState(nodes[0]?.id ?? '')

  useEffect(() => {
    setTitle(detail.title)
    setSchema({ ...(detail.ui_schema ?? {}) })
    const raw = detail.ui_schema?.fields
    setFields(Array.isArray(raw) ? raw.map((field) => ({ ...(field as JsonRecord) })) : [])
    const nextNodes = nodeList(detail.payload)
    setSelectedNodeId(nextNodes[0]?.id ?? '')
  }, [detail])

  const layout = useMemo(() => graphLayout(nodes, fields), [fields, nodes])
  const positions = new Map(layout.nodes.map((node) => [node.id, node]))
  const selected = nodes.find((node) => node.id === selectedNodeId) ?? nodes[0]
  const editable = detail.source === 'user'

  const save = useMutation({
    mutationFn: () => apiStudio.patchWorkflow(detail.id, {
      title: title.trim(),
      ui_schema: { ...schema, title: title.trim(), fields },
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['studio-workflows'] })
      void queryClient.invalidateQueries({ queryKey: ['studio-workflow', detail.id] })
      toast.success('工作流名称与输入映射已保存')
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const toggleField = (node: ComfyNode, input: string, value: unknown) => {
    if (!editable) return
    const current = fieldFor(fields, node.id, input)
    if (current !== undefined) {
      setFields((items) => items.filter((field) => fieldId(field) !== fieldId(current)))
      return
    }
    const base = `f_${node.id}_${input}`.replace(/[^a-zA-Z0-9_-]/g, '_')
    let nextId = base
    let suffix = 2
    while (fields.some((field) => fieldId(field) === nextId)) nextId = `${base}_${suffix++}`
    setFields((items) => [...items, {
      id: nextId,
      node: node.id,
      input,
      name: inputLabel(input),
      type: guessType(input, value),
      default: defaultValue(value),
      options: [],
    }])
  }

  const updateField = (id: string, patch: JsonRecord) => {
    setFields((items) => items.map((field) => fieldId(field) === id ? { ...field, ...patch } : field))
  }

  return (
    <section className="wfc-comfy-editor">
      <div className="wfc-section-title">
        <Workflow aria-hidden />
        <div>
          <h2>ComfyUI 节点图与输入映射</h2>
          <p>点击节点查看输入；勾选后，该输入会出现在运行面板和画布工作流节点中。</p>
        </div>
        {editable && (
          <button className="btn btn-primary" disabled={save.isPending || title.trim() === ''} onClick={() => save.mutate()}>
            <Save aria-hidden />{save.isPending ? '保存中…' : '保存配置'}
          </button>
        )}
      </div>
      <div className="wfc-comfy-title">
        <label>
          工作流名称
          <input value={title} disabled={!editable} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <span>{nodes.length} 个节点 · {fields.length} 个已暴露输入</span>
        {!editable && <em>内置工作流只读；可运行、停用，但不会被本地编辑覆盖。</em>}
      </div>
      <div className="wfc-comfy-workspace">
        <div className="wfc-comfy-graph" role="region" aria-label="ComfyUI 工作流节点图">
          <svg viewBox={`0 0 ${layout.width} ${layout.height}`} width={layout.width} height={layout.height}>
            <defs>
              <marker id="wfc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" />
              </marker>
            </defs>
            {layout.edges.map((edge, index) => {
              const from = positions.get(edge.from)
              const to = positions.get(edge.to)
              if (!from || !to) return null
              const x1 = from.x + 184
              const y1 = from.y + 32
              const x2 = to.x
              const y2 = to.y + 32
              const middle = (x1 + x2) / 2
              return <path className="wfc-graph-edge" key={`${edge.from}-${edge.to}-${index}`} d={`M ${x1} ${y1} C ${middle} ${y1}, ${middle} ${y2}, ${x2} ${y2}`} />
            })}
            {layout.nodes.map((node) => (
              <g
                className={['wfc-graph-node', node.id === selected?.id ? 'is-selected' : '', node.exposed > 0 ? 'has-fields' : ''].filter(Boolean).join(' ')}
                key={node.id}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedNodeId(node.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') setSelectedNodeId(node.id)
                }}
              >
                <rect x={node.x} y={node.y} width="184" height="64" rx="10" />
                <text className="wfc-node-title" x={node.x + 12} y={node.y + 24}>{node.title.slice(0, 23)}</text>
                <text className="wfc-node-type" x={node.x + 12} y={node.y + 45}>#{node.id} · {node.classType.slice(0, 24)}</text>
                {node.exposed > 0 && <text className="wfc-node-count" x={node.x + 168} y={node.y + 20}>{node.exposed}</text>}
              </g>
            ))}
          </svg>
        </div>
        <aside className="wfc-comfy-inputs">
          {selected === undefined ? <p className="wfc-empty">节点图为空。</p> : (
            <>
              <header><strong>{selected.title}</strong><code>#{selected.id} · {selected.classType}</code></header>
              {Object.entries(selected.inputs).map(([input, value]) => {
                if (linkedNode(value, new Set(nodes.map((node) => node.id))) !== null) return null
                const field = fieldFor(fields, selected.id, input)
                const enabled = field !== undefined
                const id = field ? fieldId(field) : ''
                return (
                  <article className={enabled ? 'wfc-input-row is-enabled' : 'wfc-input-row'} key={input}>
                    <label className="wfc-input-toggle">
                      <input type="checkbox" checked={enabled} disabled={!editable} onChange={() => toggleField(selected, input, value)} />
                      <span><strong>{inputLabel(input)}</strong><code>{input}</code></span>
                    </label>
                    <small title={preview(value)}>原值：{preview(value)}</small>
                    {field && (
                      <div className="wfc-input-config">
                        <label>显示名称<input disabled={!editable} value={String(field.name ?? '')} onChange={(event) => updateField(id, { name: event.target.value })} /></label>
                        <label>控件类型<Picker size="sm" value={String(field.type ?? 'text')} disabled={!editable} onChange={(value) => updateField(id, { type: value })} options={FIELD_TYPES.map(([value, label]) => ({ value, label }))} /></label>
                        {['number', 'slider'].includes(String(field.type ?? '')) && (
                          <div className="wfc-number-options">
                            {(['min', 'max', 'step'] as const).map((key) => (
                              <label key={key}>{key}<input disabled={!editable} type="number" value={String(field[key] ?? (key === 'step' ? 1 : ''))} onChange={(event) => updateField(id, { [key]: event.target.value === '' ? null : Number(event.target.value) })} /></label>
                            ))}
                            <label className="wfc-check"><input disabled={!editable} type="checkbox" checked={field.random_enabled === true} onChange={(event) => updateField(id, { random_enabled: event.target.checked })} />随机</label>
                          </div>
                        )}
                        {String(field.type ?? '') === 'dropdown' && (
                          <label>选项（逗号分隔）<input disabled={!editable} value={Array.isArray(field.options) ? field.options.join(', ') : ''} onChange={(event) => updateField(id, { options: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} /></label>
                        )}
                      </div>
                    )}
                  </article>
                )
              })}
            </>
          )}
        </aside>
      </div>
    </section>
  )
}
