/* 工作流模板面板：已沉淀的 DAG 按输入表单跑，配定时 / 终态触发器，看最近的运行。
 *
 * 与编排页的分工：编排页管「这条 DAG 长什么样」，这里管「拿它干活」。
 * 一次运行 promote 出来的 StudioFlow 就落在这个列表里——字面输入已经被抽成 input 节点，
 * 所以这里能直接按 `input_schema` 渲染表单，不用再让人对着 JSON 猜字段。 */

import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Clock, LoaderCircle, Play, Plus, Radio, Trash2 } from '@/components/NexusIcon'
import { toast } from 'sonner'

import { Picker } from '@/components/ui/picker'
import { apiStudio } from '../../lib/api-studio'
import type { StudioFlowTriggerBody } from '../../lib/api-studio'
import { SchemaForm, describeSchema, schemaDefaults, validateFields } from './SchemaForm'

/** run 与节点共用一套状态词。节点独有的 pending/skipped/waiting_input 也在里面 */
export function flowStatusLabel(status: string): string {
  return {
    pending: '等待上游',
    queued: '已入队',
    submitting: '正在提交',
    running: '运行中',
    recovering: '恢复中',
    waiting_input: '等待输入',
    skipped: '已跳过',
    succeeded: '成功',
    partial: '部分成功',
    failed: '失败',
    cancelled: '已取消',
  }[status] ?? status
}

/** 终态任务能触发下游工作流的状态集合 */
const TERMINAL_STATUSES = ['succeeded', 'partial', 'failed', 'cancelled'] as const

function TriggerForm({ flowId }: { flowId: number }): JSX.Element {
  const queryClient = useQueryClient()
  const [kind, setKind] = useState<'cron' | 'task_terminal'>('cron')
  const [cron, setCron] = useState('0 9 * * *')
  const [taskType, setTaskType] = useState('image.generate')
  const [statuses, setStatuses] = useState<string[]>(['succeeded'])

  const triggers = useQuery({
    queryKey: ['studio-flow-triggers', flowId],
    queryFn: () => apiStudio.flowTriggers(flowId),
  })

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['studio-flow-triggers', flowId] })
  }

  const create = useMutation({
    mutationFn: () => {
      const body: StudioFlowTriggerBody = kind === 'cron'
        ? { kind: 'cron', cron: cron.trim() }
        : { kind: 'task_terminal', task_type: taskType.trim(), statuses }
      if (body.kind === 'cron' && body.cron === '') throw new Error('cron 表达式不能为空')
      if (body.kind === 'task_terminal' && body.task_type === '') throw new Error('任务类型不能为空')
      if (body.kind === 'task_terminal' && body.statuses.length === 0) {
        throw new Error('至少选一个终态')
      }
      return apiStudio.createFlowTrigger(flowId, body)
    },
    onSuccess: () => {
      invalidate()
      toast.success('触发器已生效')
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const remove = useMutation({
    mutationFn: (triggerId: number) => apiStudio.deleteFlowTrigger(flowId, triggerId),
    onSuccess: () => {
      invalidate()
      toast.success('触发器已删除')
    },
    onError: (error: Error) => toast.error(error.message),
  })

  return (
    <div className="flt-triggers">
      {triggers.isPending ? <span className="flt-empty"><LoaderCircle className="spin" />读取触发器…</span> : null}
      {triggers.isError ? (
        <span className="flt-empty">触发器读取失败：{triggers.error.message}</span>
      ) : null}
      {triggers.data !== undefined && triggers.data.items.length === 0 ? (
        <span className="flt-empty">还没有触发器，这条工作流只会被手动运行</span>
      ) : null}
      {(triggers.data?.items ?? []).map((trigger) => (
        <div className="flt-trigger" key={trigger.id}>
          {trigger.kind === 'cron' ? <Clock /> : <Radio />}
          <span>
            {trigger.kind === 'cron'
              ? `定时 ${trigger.cron ?? ''}`
              : `${trigger.task_type ?? ''} → ${(trigger.statuses ?? []).map(flowStatusLabel).join(' / ')}`}
          </span>
          <small>
            {trigger.enabled === false ? '已停用' : null}
            {trigger.last_fired_at === null || trigger.last_fired_at === undefined
              ? ' 尚未触发过'
              : ` 上次 ${trigger.last_fired_at.slice(0, 16).replace('T', ' ')}`}
          </small>
          <button
            type="button"
            aria-label="删除触发器"
            disabled={remove.isPending}
            onClick={() => remove.mutate(trigger.id)}
          >
            <Trash2 />
          </button>
        </div>
      ))}

      <div className="flt-trigger-form">
        <Picker
          className="flt-picker"
          aria-label="触发方式"
          value={kind}
          options={[
            { value: 'cron', label: '定时 cron' },
            { value: 'task_terminal', label: '任务终态' },
          ]}
          onChange={(value) => setKind(value === 'task_terminal' ? 'task_terminal' : 'cron')}
        />
        {kind === 'cron' ? (
          <label>
            cron 表达式
            <input value={cron} onChange={(event) => setCron(event.target.value)} placeholder="0 9 * * *" />
          </label>
        ) : (
          <>
            <label>
              任务类型
              <input
                value={taskType}
                onChange={(event) => setTaskType(event.target.value)}
                placeholder="image.generate"
              />
            </label>
            <div className="flt-statuses">
              {TERMINAL_STATUSES.map((status) => (
                <button
                  type="button"
                  key={status}
                  className={statuses.includes(status) ? 'flt-status flt-status-on' : 'flt-status'}
                  onClick={() => setStatuses((old) => (
                    old.includes(status) ? old.filter((item) => item !== status) : [...old, status]
                  ))}
                >
                  {flowStatusLabel(status)}
                </button>
              ))}
            </div>
          </>
        )}
        <button
          type="button"
          className="btn btn-outline"
          disabled={create.isPending}
          onClick={() => create.mutate()}
        >
          <Plus />添加触发器
        </button>
      </div>
    </div>
  )
}

export function FlowTemplatesPanel({
  selectedId,
  onSelect,
  onOpenRun,
}: {
  selectedId: number | null
  onSelect: (flowId: number) => void
  onOpenRun: (runId: string) => void
}): JSX.Element {
  const queryClient = useQueryClient()
  const [inputs, setInputs] = useState<Record<string, unknown>>({})

  const flows = useQuery({ queryKey: ['studio-flows'], queryFn: apiStudio.flows })
  const schema = useQuery({
    queryKey: ['studio-flow-schema', selectedId],
    queryFn: () => apiStudio.flowSchema(selectedId as number),
    enabled: selectedId !== null,
  })
  const runs = useQuery({
    queryKey: ['studio-flow-runs', selectedId],
    queryFn: () => apiStudio.flowRuns({ flow_id: selectedId as number, limit: 20 }),
    enabled: selectedId !== null,
    refetchInterval: 4000,
  })

  const fields = useMemo(() => describeSchema(schema.data?.input_schema), [schema.data])

  // 换工作流或换 schema 时按 default 重铺一次，避免上一条的字段串到下一条
  useEffect(() => {
    setInputs(schemaDefaults(fields))
  }, [fields])

  const issues = useMemo(() => validateFields(fields, inputs), [fields, inputs])

  const run = useMutation({
    mutationFn: () => {
      if (selectedId === null) throw new Error('先选一条工作流')
      if (issues.length > 0) throw new Error(`${issues[0].label}：${issues[0].message}`)
      return apiStudio.runFlow(selectedId, { inputs })
    },
    onSuccess: (value) => {
      queryClient.setQueryData(['studio-flow-run', value.id], value)
      void queryClient.invalidateQueries({ queryKey: ['studio-flow-runs', selectedId] })
      onOpenRun(value.id)
      toast.success('已按输入表单发起运行')
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const selected = (flows.data?.items ?? []).find((flow) => flow.id === selectedId)

  return (
    <div className="flt-panel">
      <aside className="flt-list">
        <h3>工作流模板</h3>
        {flows.isPending ? <span className="flt-empty"><LoaderCircle className="spin" />读取中…</span> : null}
        {flows.isError ? <span className="flt-empty">列表读取失败：{flows.error.message}</span> : null}
        {flows.data !== undefined && flows.data.items.length === 0 ? (
          <span className="flt-empty">还没有模板。在编排页跑一次，再点「保存为模板」</span>
        ) : null}
        {(flows.data?.items ?? []).map((flow) => (
          <button
            type="button"
            key={flow.id}
            className={flow.id === selectedId ? 'is-active' : ''}
            onClick={() => onSelect(flow.id)}
          >
            <strong>{flow.title}</strong>
            <span>{flow.node_count} 节点 · v{flow.version} · {flow.enabled ? '启用' : '停用'}</span>
          </button>
        ))}
      </aside>

      <section className="flt-detail">
        {selected === undefined ? (
          <p className="flt-empty">左边选一条工作流，这里出运行表单、触发器与最近运行</p>
        ) : (
          <>
            <header className="flt-detail-head">
              <div>
                <h3>{selected.title}</h3>
                <p>{selected.description ?? '没有说明'}</p>
              </div>
              <button
                type="button"
                className="btn btn-primary"
                disabled={run.isPending || !selected.enabled}
                title={selected.enabled ? undefined : '这条工作流已停用，先在编排页勾上「允许新运行」'}
                onClick={() => run.mutate()}
              >
                {run.isPending ? <LoaderCircle className="spin" /> : <Play />}运行
              </button>
            </header>

            <h4>运行输入</h4>
            {schema.isPending ? <p className="flt-empty">读取输入契约…</p> : null}
            {schema.isError ? <p className="flt-empty">输入契约读取失败：{schema.error.message}</p> : null}
            <SchemaForm
              schema={schema.data?.input_schema}
              value={inputs}
              onChange={setInputs}
              issues={issues}
              emptyHint="这条工作流没有声明 input 节点，直接写运行输入 JSON"
            />

            <h4>触发器</h4>
            <TriggerForm flowId={selected.id} />

            <h4>最近运行</h4>
            <div className="flt-runs">
              {runs.isError ? (
                <span className="flt-empty">运行记录读取失败：{runs.error.message}</span>
              ) : null}
              {runs.data !== undefined && runs.data.items.length === 0 ? (
                <span className="flt-empty">还没有运行记录</span>
              ) : null}
              {(runs.data?.items ?? []).map((item) => (
                <button type="button" className="flt-run" key={item.id} onClick={() => onOpenRun(item.id)}>
                  <span className={`flt-chip is-${item.status}`}>{flowStatusLabel(item.status)}</span>
                  <code>{item.id}</code>
                  <small>{Math.round(item.progress)}% · v{item.flow_version}</small>
                </button>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  )
}
