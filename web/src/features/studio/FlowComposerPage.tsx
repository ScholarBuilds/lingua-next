/* 工具 DAG 编排页。
 *
 * 节点输入原来是一个裸 JSON textarea——能力的 `input_schema` 明明在目录里躺着，
 * 却要人对着它默写字段名。现在按 schema 渲染表单（SchemaForm），要写表达式再切「引用」。
 *
 * 节点形态从「一个工具一次调用」扩到五类：tool / map / subflow / input / output。
 * 序列化保持向后兼容：`kind` 是 tool 时不写这个字段，旧定义读进来也还是 tool，
 * 历史 run 的 checkpoint 形状一点没动。 */

import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  Bookmark,
  GitBranch,
  LoaderCircle,
  Play,
  Plus,
  RefreshCw,
  Save,
  Square,
  Trash2,
  Workflow,
  X,
} from '@/components/NexusIcon'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

import { Picker } from '@/components/ui/picker'
import { apiStudio } from '../../lib/api-studio'
import type {
  StudioFlowDefinition,
  StudioFlowEdge,
  StudioFlowFailurePolicy,
  StudioFlowNode,
  StudioFlowNodeBase,
  StudioFlowNodeKind,
  StudioFlowRun,
  StudioFlowToolNode,
  StudioToolPlugin,
} from '../../lib/api-studio'
import { ToolHeader } from './StudioToolShell'
import { FlowTemplatesPanel, flowStatusLabel } from './FlowTemplatesPanel'
import { SchemaForm, describeSchema, schemaDefaults, toJsonText, validateFields } from './SchemaForm'
import type { JsonSchema } from './SchemaForm'
import { WorkflowNodePicker } from './WorkflowNodePicker'
import './flow-composer.css'

/** 运行到这些状态就不必再轮询。waiting_input 不在里面——它还等着人填 */
const TERMINAL = new Set(['succeeded', 'partial', 'failed', 'cancelled'])

const KIND_OPTIONS: { value: StudioFlowNodeKind; label: string; hint: string }[] = [
  { value: 'tool', label: '工具调用', hint: '一次真实 StudioTask' },
  { value: 'map', label: '批量展开', hint: '按列表逐项实例化模板' },
  { value: 'subflow', label: '子工作流', hint: '整条 DAG 当一个节点' },
  { value: 'input', label: '运行参数', hint: '沉淀成模板的输入表单字段' },
  { value: 'output', label: '运行产出', hint: '汇出 run.outputs' },
]

const FAILURE_OPTIONS: { value: StudioFlowFailurePolicy; label: string }[] = [
  { value: 'fail_run', label: '整条失败' },
  { value: 'skip_downstream', label: '跳过下游' },
  { value: 'continue', label: '继续执行' },
]

export interface DraftNode {
  /** React key，节点 id 可以随便改，key 不跟着变 */
  key: string
  id: string
  kind: StudioFlowNodeKind
  /** tool 与 map 的模板共用这三个字段 */
  toolId: string
  operation: string
  input: Record<string, unknown>
  /** 表单表达不了时切到裸 JSON */
  rawInput: boolean
  inputText: string
  when: string
  onFailure: StudioFlowFailurePolicy
  retryMax: string
  retryBackoff: string
  timeoutS: string
  /** map：求值出列表的表达式 */
  over: string
  /** subflow */
  flowId: string
  inputsText: string
  /** input / output 的字段名 */
  name: string
  schemaText: string
  valueText: string
  sourceContext?: Record<string, unknown>
}

let keySeed = 0

function nextKey(): string {
  keySeed += 1
  return `draft-${keySeed}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(text: string, label: string): unknown {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  try {
    return JSON.parse(trimmed)
  } catch (error) {
    throw new Error(`${label} JSON 无法解析：${error instanceof Error ? error.message : String(error)}`)
  }
}

function parseObject(text: string, label: string): Record<string, unknown> {
  const value = parseJson(text, label)
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error(`${label} 必须是 JSON 对象`)
  return value
}

/** 表达式框：能当 JSON 读就按 JSON 读，读不动且不是对象/数组开头就当裸字符串
 *  （`$input.items` 这种写法不带引号也要认） */
function parseExpression(text: string, label: string): unknown {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  try {
    return JSON.parse(trimmed)
  } catch (error) {
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      throw new Error(`${label} JSON 无法解析：${error instanceof Error ? error.message : String(error)}`)
    }
    return trimmed
  }
}

/** parseExpression 的逆运算。会被重新解析成别的类型的字符串要补引号，否则读回来类型就变了 */
export function expressionText(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') {
    let ambiguous = false
    try {
      ambiguous = typeof JSON.parse(value) !== 'string'
    } catch {
      ambiguous = false
    }
    return ambiguous ? JSON.stringify(value) : value
  }
  return toJsonText(value)
}

export function blankDraft(index: number): DraftNode {
  return {
    key: nextKey(),
    id: `step-${index}`,
    kind: 'tool',
    toolId: 'infinite-canvas',
    operation: 'image.generate',
    input: { prompt: { $input: 'prompt' } },
    rawInput: false,
    inputText: toJsonText({ prompt: { $input: 'prompt' } }),
    when: '',
    onFailure: 'fail_run',
    retryMax: '',
    retryBackoff: '',
    timeoutS: '',
    over: '',
    flowId: '',
    inputsText: '{}',
    name: '',
    schemaText: toJsonText({ type: 'string', title: '文本参数' }),
    valueText: '',
  }
}

function draftInput(draft: DraftNode): Record<string, unknown> {
  return draft.rawInput ? parseObject(draft.inputText, `节点 ${draft.id || '未命名'} 的输入`) : draft.input
}

/** 草稿 → 定义。缺省值一律不写进 JSON：旧定义读进来再存回去不会凭空长出字段，
 *  工具节点也照旧不写 `kind`（历史定义没这个字段，服务端按缺省读成 tool） */
export function draftToNode(draft: DraftNode): StudioFlowNode {
  const id = draft.id.trim()
  if (id === '') throw new Error('节点 id 不能为空')
  const label = `节点 ${id}`
  const base: StudioFlowNodeBase = { id }

  const when = draft.when.trim()
  if (when !== '') base.when = when
  if (draft.onFailure !== 'fail_run') base.on_failure = draft.onFailure
  const retryMax = Number(draft.retryMax.trim())
  if (draft.retryMax.trim() !== '' && Number.isFinite(retryMax) && retryMax > 0) {
    const backoff = Number(draft.retryBackoff.trim())
    base.retry = {
      max: Math.trunc(retryMax),
      backoff_ms: Number.isFinite(backoff) && backoff > 0 ? Math.trunc(backoff) : 0,
    }
  }
  const timeout = Number(draft.timeoutS.trim())
  if (draft.timeoutS.trim() !== '' && Number.isFinite(timeout) && timeout > 0) {
    base.timeout_s = Math.trunc(timeout)
  }
  if (draft.sourceContext !== undefined) base.source_context = draft.sourceContext

  if (draft.kind === 'tool') {
    return { ...base, tool_id: draft.toolId, operation: draft.operation, input: draftInput(draft) }
  }
  if (draft.kind === 'map') {
    const over = parseExpression(draft.over, `${label} 的展开来源`)
    if (over === undefined) throw new Error(`${label} 的展开来源不能为空`)
    return {
      ...base,
      kind: 'map',
      over,
      template: {
        id,
        tool_id: draft.toolId,
        operation: draft.operation,
        input: draftInput(draft),
      },
    }
  }
  if (draft.kind === 'subflow') {
    const flowId = Number(draft.flowId.trim())
    if (!Number.isInteger(flowId) || flowId <= 0) {
      throw new Error(`${label} 的子工作流 id 必须是正整数`)
    }
    return {
      ...base,
      kind: 'subflow',
      flow_id: flowId,
      inputs: parseObject(draft.inputsText, `${label} 的子工作流入参`),
    }
  }
  const name = draft.name.trim()
  if (name === '') throw new Error(`${label} 的字段名不能为空`)
  if (draft.kind === 'input') {
    return {
      ...base,
      kind: 'input',
      name,
      schema: parseObject(draft.schemaText, `${label} 的参数 schema`),
    }
  }
  const value = parseExpression(draft.valueText, `${label} 的产出取值`)
  if (value === undefined) throw new Error(`${label} 的产出取值不能为空`)
  return { ...base, kind: 'output', name, value }
}

/** 工具字段的载体：tool 节点是自己，map 节点是它的模板 */
type ToolCarrier = Pick<StudioFlowToolNode, 'tool_id' | 'operation' | 'input'>

function toolCarrier(node: StudioFlowNode): ToolCarrier | null {
  if (node.kind === undefined || node.kind === 'tool') return node
  if (node.kind === 'map') return node.template
  return null
}

/** 定义 → 草稿。`kind` 缺省按 tool 读，map 的工具字段从 template 上取。
 *  服务端 dump 会把没设的字段写成 null，一律当作没有——直接 String(null) 会写出 "null" */
export function nodeToDraft(node: StudioFlowNode): DraftNode {
  const kind: StudioFlowNodeKind = node.kind ?? 'tool'
  const carrier = toolCarrier(node)
  const input = carrier?.input ?? {}
  const named = node.kind === 'input' || node.kind === 'output' ? (node.name ?? '') : ''
  return {
    key: nextKey(),
    id: node.id,
    kind,
    toolId: carrier?.tool_id ?? 'infinite-canvas',
    operation: carrier?.operation ?? '',
    input,
    rawInput: false,
    inputText: toJsonText(input),
    when: node.when ?? '',
    onFailure: node.on_failure ?? 'fail_run',
    retryMax: node.retry === undefined || node.retry === null ? '' : String(node.retry.max),
    retryBackoff:
      node.retry === undefined || node.retry === null ? '' : String(node.retry.backoff_ms),
    timeoutS: typeof node.timeout_s === 'number' ? String(node.timeout_s) : '',
    over: node.kind === 'map' ? expressionText(node.over) : '',
    flowId: node.kind === 'subflow' ? String(node.flow_id) : '',
    inputsText: toJsonText((node.kind === 'subflow' ? node.inputs : null) ?? {}),
    name: named,
    schemaText: toJsonText(
      (node.kind === 'input' ? node.schema : null) ?? { type: 'string', title: '文本参数' },
    ),
    valueText: node.kind === 'output' ? expressionText(node.value) : '',
    sourceContext: node.source_context ?? undefined,
  }
}

export function definitionOf(nodes: DraftNode[], edges: StudioFlowEdge[]): StudioFlowDefinition {
  return { nodes: nodes.map(draftToNode), edges }
}

/** 人工输入节点的 schema 可能直接是一个对象契约，也可能只描述单个值。
 *  后者包一层，表单统一按对象渲染，提交前再拆回来 */
export function resumeShape(schema: JsonSchema, name: string): { schema: JsonSchema; unwrap: string | null } {
  const properties = schema.properties
  if (isRecord(properties) && Object.keys(properties).length > 0) return { schema, unwrap: null }
  const key = name === '' ? 'value' : name
  return {
    schema: { type: 'object', properties: { [key]: schema }, required: [key] },
    unwrap: key,
  }
}

function operationSchema(
  tools: StudioToolPlugin[],
  toolId: string,
  operation: string,
): JsonSchema | undefined {
  const contract = tools.find((tool) => tool.id === toolId)?.operation_contracts[operation]
  return contract?.input_schema
}

function NodeCard({
  draft,
  index,
  tools,
  onPatch,
  onRemove,
}: {
  draft: DraftNode
  index: number
  tools: StudioToolPlugin[]
  onPatch: (patch: Partial<DraftNode>) => void
  onRemove: () => void
}): JSX.Element {
  const [pickingWorkflow, setPickingWorkflow] = useState(false)
  const tool = tools.find((item) => item.id === draft.toolId)
  const operations = Object.keys(tool?.operation_contracts ?? {})
  const schema = operationSchema(tools, draft.toolId, draft.operation)
  const withTool = draft.kind === 'tool' || draft.kind === 'map'

  const switchOperation = (toolId: string, operation: string): void => {
    const next = operationSchema(tools, toolId, operation)
    const seeded = schemaDefaults(describeSchema(next))
    onPatch({ toolId, operation, input: seeded, inputText: toJsonText(seeded) })
  }

  return (
    <article className="flc-node">
      <header>
        <b>{index + 1}</b>
        <span>{draft.id || '未命名'}</span>
        <em>{KIND_OPTIONS.find((item) => item.value === draft.kind)?.label}</em>
        <button type="button" aria-label="删除节点" onClick={onRemove}><X /></button>
      </header>

      <div className="flc-node-grid">
        <label>节点 id
          <input value={draft.id} onChange={(event) => onPatch({ id: event.target.value })} />
        </label>
        <label>形态
          <Picker
            className="flc-picker"
            aria-label="节点形态"
            value={draft.kind}
            options={KIND_OPTIONS.map((item) => ({ value: item.value, label: item.label, hint: item.hint }))}
            onChange={(value) => onPatch({ kind: value as StudioFlowNodeKind })}
          />
        </label>
        {withTool ? (
          <>
            <label>工具
              <Picker
                className="flc-picker"
                aria-label="工具"
                value={draft.toolId}
                options={tools.map((item) => ({ value: item.id, label: item.label }))}
                onChange={(value) => {
                  const next = tools.find((item) => item.id === value)
                  switchOperation(value, Object.keys(next?.operation_contracts ?? {})[0] ?? '')
                }}
              />
            </label>
            <label>能力
              <Picker
                className="flc-picker"
                aria-label="能力"
                value={draft.operation}
                options={operations.map((operation) => ({ value: operation, label: operation }))}
                onChange={(value) => switchOperation(draft.toolId, value)}
              />
            </label>
          </>
        ) : null}
      </div>

      {draft.kind === 'map' ? (
        <label className="flc-json">展开来源（求值出一个列表，实例 id 为 <code>{draft.id || 'node'}.0</code>）
          <textarea
            value={draft.over}
            spellCheck={false}
            placeholder='{"$input":"items"}'
            onChange={(event) => onPatch({ over: event.target.value })}
          />
        </label>
      ) : null}

      {draft.kind === 'subflow' ? (
        <div className="flc-node-grid">
          <label>子工作流 id
            <input
              value={draft.flowId}
              inputMode="numeric"
              onChange={(event) => onPatch({ flowId: event.target.value })}
            />
          </label>
          <label className="flc-json flc-span">子工作流入参
            <textarea
              value={draft.inputsText}
              spellCheck={false}
              onChange={(event) => onPatch({ inputsText: event.target.value })}
            />
          </label>
        </div>
      ) : null}

      {draft.kind === 'input' || draft.kind === 'output' ? (
        <div className="flc-node-grid">
          <label>{draft.kind === 'input' ? '参数名' : '产出名'}
            <input value={draft.name} onChange={(event) => onPatch({ name: event.target.value })} />
          </label>
          <label className="flc-json flc-span">
            {draft.kind === 'input' ? '参数 schema（模板运行表单按它渲染）' : '取值表达式'}
            <textarea
              value={draft.kind === 'input' ? draft.schemaText : draft.valueText}
              spellCheck={false}
              placeholder={draft.kind === 'input' ? '{"type":"string"}' : '{"$node":"draft","path":"asset_ids"}'}
              onChange={(event) => onPatch(
                draft.kind === 'input'
                  ? { schemaText: event.target.value }
                  : { valueText: event.target.value },
              )}
            />
          </label>
        </div>
      ) : null}

      {withTool ? (
        <section className="flc-node-input">
          <div className="flc-node-input-head">
            <span>{draft.kind === 'map' ? '模板输入' : '节点输入'}</span>
            {draft.operation === 'workflow.run' ? (
              <button type="button" className="btn-ghost-sm" onClick={() => setPickingWorkflow(true)}>
                <Workflow />选工作流
              </button>
            ) : null}
            <button
              type="button"
              className="btn-ghost-sm"
              onClick={() => {
                if (draft.rawInput) {
                  onPatch({
                    rawInput: false,
                    input: parseObject(draft.inputText, `节点 ${draft.id || '未命名'} 的输入`),
                  })
                } else {
                  onPatch({ rawInput: true, inputText: toJsonText(draft.input) })
                }
              }}
            >
              {draft.rawInput ? '回到表单' : '改写 JSON'}
            </button>
          </div>
          {draft.rawInput ? (
            <label className="flc-json">
              <textarea
                value={draft.inputText}
                spellCheck={false}
                onChange={(event) => onPatch({ inputText: event.target.value })}
              />
            </label>
          ) : (
            <SchemaForm
              schema={schema}
              value={draft.input}
              onChange={(next) => onPatch({ input: next })}
              emptyHint="这个能力没有导出字段契约，直接写输入 JSON"
            />
          )}
        </section>
      ) : null}

      <details className="flc-adv">
        <summary>执行策略</summary>
        <div className="flc-adv-grid">
          <label>条件 when
            <input
              value={draft.when}
              placeholder='$input.retouch'
              onChange={(event) => onPatch({ when: event.target.value })}
            />
          </label>
          <label>失败后
            <Picker
              className="flc-picker"
              aria-label="失败策略"
              value={draft.onFailure}
              options={FAILURE_OPTIONS}
              onChange={(value) => onPatch({ onFailure: value as StudioFlowFailurePolicy })}
            />
          </label>
          <label>重试次数
            <input
              value={draft.retryMax}
              inputMode="numeric"
              placeholder="0"
              onChange={(event) => onPatch({ retryMax: event.target.value })}
            />
          </label>
          <label>退避 ms
            <input
              value={draft.retryBackoff}
              inputMode="numeric"
              placeholder="0"
              onChange={(event) => onPatch({ retryBackoff: event.target.value })}
            />
          </label>
          <label>超时秒
            <input
              value={draft.timeoutS}
              inputMode="numeric"
              placeholder="不限"
              onChange={(event) => onPatch({ timeoutS: event.target.value })}
            />
          </label>
        </div>
      </details>

      {pickingWorkflow ? (
        <WorkflowNodePicker
          title="选一个可执行工作流"
          onClose={() => setPickingWorkflow(false)}
          onPick={(workflow) => onPatch({ input: { ...draft.input, workflow_id: workflow.id } })}
        />
      ) : null}
    </article>
  )
}

function WaitingNode({
  nodeId,
  schema,
  unwrap,
  onSubmit,
  pending,
}: {
  nodeId: string
  schema: JsonSchema
  unwrap: string | null
  onSubmit: (value: unknown) => void
  pending: boolean
}): JSX.Element {
  const fields = useMemo(() => describeSchema(schema), [schema])
  const [value, setValue] = useState<Record<string, unknown>>(() => schemaDefaults(fields))
  // 不合法就别发：run 还停在这个节点上，服务端拒了只会多一次往返
  const issues = useMemo(() => validateFields(fields, value), [fields, value])
  return (
    <div className="flc-waiting">
      <header>
        <strong>{nodeId}</strong>
        <span>等待人工输入</span>
      </header>
      <SchemaForm schema={schema} value={value} onChange={setValue} issues={issues} />
      <button
        type="button"
        className="btn btn-primary"
        disabled={pending || issues.length > 0}
        title={issues.length === 0 ? undefined : `${issues[0].label}：${issues[0].message}`}
        onClick={() => onSubmit(unwrap === null ? value : value[unwrap])}
      >
        {pending ? <LoaderCircle className="spin" /> : <Play />}填写并继续
      </button>
    </div>
  )
}

export default function FlowComposerPage(): JSX.Element {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<'compose' | 'templates'>('compose')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [templateId, setTemplateId] = useState<number | null>(null)
  const [title, setTitle] = useState('未命名 DAG')
  const [description, setDescription] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [nodes, setNodes] = useState<DraftNode[]>([blankDraft(1)])
  const [edges, setEdges] = useState<StudioFlowEdge[]>([])
  const [inputsText, setInputsText] = useState(toJsonText({ prompt: '' }))
  const [activeRunId, setActiveRunId] = useState<string | null>(null)

  const flows = useQuery({ queryKey: ['studio-flows'], queryFn: apiStudio.flows })
  const detail = useQuery({
    queryKey: ['studio-flow', selectedId],
    queryFn: () => apiStudio.flow(selectedId as number),
    enabled: selectedId !== null,
  })
  const catalog = useQuery({ queryKey: ['studio-catalog'], queryFn: apiStudio.catalog })
  const activeRun = useQuery({
    queryKey: ['studio-flow-run', activeRunId],
    queryFn: () => apiStudio.flowRun(activeRunId as string),
    enabled: activeRunId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return status !== undefined && TERMINAL.has(status) ? false : 1500
    },
  })

  useEffect(() => {
    const flow = detail.data
    if (!flow) return
    setTitle(flow.title)
    setDescription(flow.description ?? '')
    setEnabled(flow.enabled)
    setNodes(flow.definition.nodes.map(nodeToDraft))
    setEdges(flow.definition.edges)
    setActiveRunId(null)
  }, [detail.data])

  const executableTools = useMemo(
    () => (catalog.data?.tools ?? []).filter(
      (tool) => Object.keys(tool.operation_contracts).length > 0,
    ),
    [catalog.data],
  )

  const reset = (): void => {
    setSelectedId(null)
    setTitle('未命名 DAG')
    setDescription('')
    setEnabled(true)
    setNodes([blankDraft(1)])
    setEdges([])
    setInputsText(toJsonText({ prompt: '' }))
    setActiveRunId(null)
  }

  const save = useMutation({
    mutationFn: async () => {
      const definition = definitionOf(nodes, edges)
      if (selectedId === null) {
        return apiStudio.createFlow({ title, description, definition })
      }
      if (!detail.data) throw new Error('工作流详情尚未加载')
      return apiStudio.updateFlow(selectedId, {
        title,
        description,
        definition,
        base_version: detail.data.version,
        enabled,
      })
    },
    onSuccess: (flow) => {
      setSelectedId(flow.id)
      void queryClient.invalidateQueries({ queryKey: ['studio-flows'] })
      queryClient.setQueryData(['studio-flow', flow.id], flow)
      toast.success('已保存 DAG 定义与版本快照')
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const remove = useMutation({
    mutationFn: () => {
      if (selectedId === null) throw new Error('尚未保存')
      return apiStudio.deleteFlow(selectedId)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['studio-flows'] })
      reset()
      toast.success('DAG 定义已删除，历史运行快照仍保留')
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const run = useMutation({
    mutationFn: () => {
      if (selectedId === null) throw new Error('先保存 DAG 再运行')
      return apiStudio.runFlow(selectedId, { inputs: parseObject(inputsText, '运行输入') })
    },
    onSuccess: (value) => {
      setActiveRunId(value.id)
      queryClient.setQueryData(['studio-flow-run', value.id], value)
      toast.success('DAG 已交给 worker 持久执行')
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const retry = useMutation({
    mutationFn: (id: string) => apiStudio.retryFlowRun(id),
    onSuccess: (value) => {
      setActiveRunId(value.id)
      queryClient.setQueryData(['studio-flow-run', value.id], value)
      toast.success('已从原始快照新建一次重试')
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const cancel = useMutation({
    mutationFn: (id: string) => apiStudio.cancelFlowRun(id),
    onSuccess: (value) => queryClient.setQueryData(['studio-flow-run', value.id], value),
    onError: (error: Error) => toast.error(error.message),
  })

  const resume = useMutation({
    mutationFn: (body: { runId: string; nodeId: string; value: unknown }) =>
      apiStudio.resumeFlowRun(body.runId, { node_id: body.nodeId, resume_value: body.value }),
    onSuccess: (value) => {
      queryClient.setQueryData(['studio-flow-run', value.id], value)
      toast.success('输入已提交，run 继续往下走')
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const promote = useMutation({
    mutationFn: (id: string) => apiStudio.promoteFlowRun(id, { title, description }),
    onSuccess: (flow) => {
      void queryClient.invalidateQueries({ queryKey: ['studio-flows'] })
      queryClient.setQueryData(['studio-flow', flow.id], flow)
      setTemplateId(flow.id)
      setTab('templates')
      toast.success('已沉淀为模板：字面输入抽成了运行参数')
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const patchNode = (index: number, patch: Partial<DraftNode>): void => {
    setNodes((old) => old.map((node, current) => (current === index ? { ...node, ...patch } : node)))
  }

  const addEdge = (): void => {
    if (nodes.length < 2) {
      toast.error('至少需要两个节点')
      return
    }
    setEdges((old) => [...old, { from: nodes[0].id, to: nodes[1].id }])
  }

  const runState: StudioFlowRun | undefined = activeRun.data
  const outputs = runState?.outputs
  // 编辑区里这份草稿是不是这次 run 的定义。从模板页点开别人的 run 时不是，
  // 拿草稿的 schema 去猜等待形状会给出一张张冠李戴的表单
  const draftMatchesRun = runState !== undefined
    && runState.flow_id !== null
    && runState.flow_id === selectedId

  /** waiting_input 节点等的形状：服务端给了就用服务端的，
   *  没给才回落到当前草稿里同 id 的 input 节点（map 实例 id 形如 `<node>.<index>`） */
  const waitingShape = (nodeId: string, served: JsonSchema | null | undefined): {
    schema: JsonSchema
    unwrap: string | null
  } => {
    if (served !== null && served !== undefined) return resumeShape(served, nodeId)
    if (!draftMatchesRun) return resumeShape({ type: 'string' }, nodeId)
    const base = nodeId.includes('.') ? nodeId.slice(0, nodeId.lastIndexOf('.')) : nodeId
    const draft = nodes.find((node) => node.id === base)
    if (draft === undefined) return resumeShape({ type: 'string' }, nodeId)
    let parsed: unknown
    try {
      parsed = JSON.parse(draft.schemaText)
    } catch {
      parsed = { type: 'string' }
    }
    return resumeShape(isRecord(parsed) ? parsed : { type: 'string' }, draft.name || nodeId)
  }

  return (
    <main className="page flc-page">
      <ToolHeader
        icon={<GitBranch />}
        title="工具 DAG 编排"
        sub="把 LLM、图片、视频和 ComfyUI / RunningHub 工作流组成可恢复的有向无环图。每个节点都是真实 StudioTask，离开页面或 worker 重启不会丢状态。"
      />
      <button className="flc-back" onClick={() => navigate('/studio/workflows')}>
        <ArrowLeft />返回工作流中心
      </button>

      <div className="flc-tabs">
        <button
          type="button"
          className={tab === 'compose' ? 'flc-tab flc-tab-on' : 'flc-tab'}
          onClick={() => setTab('compose')}
        >
          编排
        </button>
        <button
          type="button"
          className={tab === 'templates' ? 'flc-tab flc-tab-on' : 'flc-tab'}
          onClick={() => setTab('templates')}
        >
          模板与触发器
        </button>
      </div>

      {tab === 'templates' ? (
        <FlowTemplatesPanel
          selectedId={templateId}
          onSelect={setTemplateId}
          onOpenRun={(runId) => {
            setActiveRunId(runId)
            setTab('compose')
          }}
        />
      ) : (
      <div className="flc-layout">
        <aside className="flc-sidebar">
          <button className="btn btn-primary" onClick={reset}><Plus />新建 DAG</button>
          <div className="flc-flow-list">
            {flows.isPending ? <span><LoaderCircle className="spin" />读取中…</span> : null}
            {flows.isError ? <span>列表读取失败：{flows.error.message}</span> : null}
            {(flows.data?.items ?? []).map((flow) => (
              <button
                key={flow.id}
                className={selectedId === flow.id ? 'is-active' : ''}
                onClick={() => setSelectedId(flow.id)}
              >
                <strong>{flow.title}</strong>
                <span>{flow.node_count} 节点 · v{flow.version} · {flow.enabled ? '启用' : '停用'}</span>
              </button>
            ))}
          </div>
        </aside>

        <section className="flc-editor">
          <div className="flc-meta">
            <label>名称<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
            <label>说明<input value={description} onChange={(event) => setDescription(event.target.value)} /></label>
            <label className="flc-check">
              <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
              允许新运行
            </label>
            <div className="flc-meta-actions">
              {selectedId !== null ? (
                <button className="btn btn-ghost" onClick={() => remove.mutate()} disabled={remove.isPending}>
                  <Trash2 />删除
                </button>
              ) : null}
              <button className="btn btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>
                {save.isPending ? <LoaderCircle className="spin" /> : <Save />}保存
              </button>
            </div>
          </div>

          <div className="flc-reference">
            运行输入：<code>{'{"$input":"prompt"}'}</code>
            节点结果：<code>{'{"$node":"draft","path":"asset_ids"}'}</code>
            合并全部直接上游：<code>{'{"$incoming":"asset_ids"}'}</code>
            <span>引用上游结果时必须建立直接连线。</span>
          </div>

          <div className="flc-section-head">
            <div><h2>执行节点</h2><p>工具节点按能力契约出表单；参数与产出节点决定这条 DAG 沉淀成模板后长什么样。</p></div>
            <button className="btn btn-outline" onClick={() => setNodes((old) => [...old, blankDraft(old.length + 1)])}>
              <Plus />添加节点
            </button>
          </div>
          <div className="flc-nodes">
            {nodes.map((draft, index) => (
              <NodeCard
                key={draft.key}
                draft={draft}
                index={index}
                tools={executableTools}
                onPatch={(patch) => patchNode(index, patch)}
                onRemove={() => {
                  setNodes((old) => old.filter((_, current) => current !== index))
                  setEdges((old) => old.filter((edge) => edge.from !== draft.id && edge.to !== draft.id))
                }}
              />
            ))}
          </div>

          <div className="flc-section-head">
            <div><h2>依赖连线</h2><p>无依赖的节点会并行启动。</p></div>
            <button className="btn btn-outline" onClick={addEdge}><Plus />添加连线</button>
          </div>
          <div className="flc-edges">
            {edges.length === 0 ? <span>暂无连线，所有节点将并行运行</span> : null}
            {edges.map((edge, index) => (
              <div key={`${index}-${edge.from}-${edge.to}`}>
                <Picker
                  className="flc-picker"
                  aria-label="上游节点"
                  value={edge.from}
                  onChange={(value) => setEdges((old) => old.map((item, current) => current === index ? { ...item, from: value } : item))}
                  options={nodes.map((node) => ({ value: node.id, label: node.id }))}
                />
                <GitBranch />
                <Picker
                  className="flc-picker"
                  aria-label="下游节点"
                  value={edge.to}
                  onChange={(value) => setEdges((old) => old.map((item, current) => current === index ? { ...item, to: value } : item))}
                  options={nodes.map((node) => ({ value: node.id, label: node.id }))}
                />
                <button onClick={() => setEdges((old) => old.filter((_, current) => current !== index))}><X /></button>
              </div>
            ))}
          </div>

          <section className="flc-run">
            <div className="flc-section-head">
              <div><h2>运行与 checkpoint</h2><p>每次运行冻结当前版本，编辑 DAG 不会改掉历史。</p></div>
              <button className="btn btn-primary" onClick={() => run.mutate()} disabled={run.isPending || selectedId === null}>
                {run.isPending ? <LoaderCircle className="spin" /> : <Play />}运行 DAG
              </button>
            </div>
            <label className="flc-json">运行输入 JSON
              <textarea value={inputsText} onChange={(event) => setInputsText(event.target.value)} spellCheck={false} />
            </label>
            {runState ? (
              <div className="flc-run-state">
                <header>
                  <div><strong>{flowStatusLabel(runState.status)}</strong><span>{Math.round(runState.progress)}% · v{runState.flow_version} · {runState.id}</span></div>
                  <div>
                    <button
                      className="btn btn-ghost"
                      disabled={promote.isPending}
                      onClick={() => promote.mutate(runState.id)}
                    >
                      <Bookmark />保存为模板
                    </button>
                    {TERMINAL.has(runState.status) && runState.status !== 'succeeded' ? (
                      <button className="btn btn-outline" onClick={() => retry.mutate(runState.id)}><RefreshCw />重试快照</button>
                    ) : null}
                    {!TERMINAL.has(runState.status) ? (
                      <button className="btn btn-ghost" onClick={() => cancel.mutate(runState.id)}><Square />取消后续</button>
                    ) : null}
                  </div>
                </header>
                {runState.error ? <p className="flc-error">{runState.error}</p> : null}

                {Object.entries(runState.checkpoint.nodes)
                  .filter(([, state]) => state.status === 'waiting_input')
                  .map(([nodeId, state]) => {
                    const shape = waitingShape(nodeId, state.input_schema)
                    return (
                      <WaitingNode
                        key={nodeId}
                        nodeId={nodeId}
                        schema={shape.schema}
                        unwrap={shape.unwrap}
                        pending={resume.isPending}
                        onSubmit={(value) => resume.mutate({ runId: runState.id, nodeId, value })}
                      />
                    )
                  })}

                <div className="flc-checkpoints">
                  {Object.entries(runState.checkpoint.nodes).map(([nodeId, state]) => (
                    <article key={nodeId} className={`is-${state.status}`}>
                      <b>{nodeId}</b><span>{flowStatusLabel(state.status)}</span>
                      {state.task_id ? <code>{state.task_id}</code> : null}
                      {state.error ? <p>{state.error}</p> : null}
                      {state.result ? <pre>{JSON.stringify(state.result, null, 2)}</pre> : null}
                    </article>
                  ))}
                </div>

                {outputs !== undefined && outputs !== null && Object.keys(outputs).length > 0 ? (
                  <div className="flc-outputs">
                    <h3>运行产出</h3>
                    <pre>{JSON.stringify(outputs, null, 2)}</pre>
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>
        </section>
      </div>
      )}
    </main>
  )
}
