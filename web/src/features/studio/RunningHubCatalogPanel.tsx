import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  CloudDownload,
  DatabaseZap,
  RefreshCw,
  Save,
  WalletCards,
} from '@/components/NexusIcon'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

import { Picker } from '@/components/ui/picker'
import type { Credential } from '../../lib/api-config'
import { apiStudio } from '../../lib/api-studio'
import type {
  RunningHubRemoteDefinition,
  RunningHubRemoteKind,
} from '../../lib/api-studio'

type Field = Record<string, unknown>

function fieldId(field: Field, index: number): string {
  return String(field.id ?? `${field.nodeId ?? 'field'}::${field.fieldName ?? index}`)
}

function fieldType(field: Field): string {
  return String(field.fieldType ?? field.type ?? 'TEXT').toUpperCase()
}

function boolValue(value: unknown): boolean {
  return value === true || String(value).toLowerCase() === 'true'
}

export function RunningHubCatalogPanel({
  credentials,
  onSaved,
}: {
  credentials: Credential[]
  onSaved: (workflowId: number) => void
}) {
  const queryClient = useQueryClient()
  const available = credentials.filter(
    (credential) => credential.enabled && credential.provider_type === 'runninghub',
  )
  const [credentialId, setCredentialId] = useState<number | null>(available[0]?.id ?? null)
  const [kind, setKind] = useState<RunningHubRemoteKind>('model')
  const [sourceId, setSourceId] = useState('')
  const [draft, setDraft] = useState<RunningHubRemoteDefinition | null>(null)

  useEffect(() => {
    if (credentialId === null && available[0]) setCredentialId(available[0].id)
    if (credentialId !== null && !available.some((item) => item.id === credentialId)) {
      setCredentialId(available[0]?.id ?? null)
    }
  }, [available, credentialId])

  const diagnostics = useQuery({
    queryKey: ['runninghub-diagnostics', credentialId],
    queryFn: () => apiStudio.runningHubDiagnostics(credentialId as number),
    enabled: credentialId !== null,
    retry: false,
  })
  const models = useQuery({
    queryKey: ['runninghub-remote-models', credentialId],
    queryFn: () => apiStudio.runningHubModels(credentialId as number),
    enabled: credentialId !== null && kind === 'model',
    retry: false,
  })
  const preview = useMutation({
    mutationFn: () => {
      if (credentialId === null) throw new Error('先选择 RunningHub 凭据')
      if (!sourceId.trim()) throw new Error(kind === 'app' ? '请输入 AI App ID' : kind === 'workflow' ? '请输入 Workflow ID' : '请选择模型')
      return apiStudio.previewRunningHubRemote({
        credential_id: credentialId,
        kind,
        source_id: sourceId.trim(),
      })
    },
    onSuccess: (definition) => {
      setDraft(definition)
      toast.success(`已拉取 ${definition.title}`)
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const save = useMutation({
    mutationFn: () => {
      if (credentialId === null || draft === null) throw new Error('先拉取远端定义')
      return apiStudio.syncRunningHubRemote({
        credential_id: credentialId,
        kind: draft.kind,
        source_id: draft.source_id,
        title: draft.title,
        description: draft.description,
        ui_schema: draft.ui_schema,
      })
    },
    onSuccess: (workflow) => {
      void queryClient.invalidateQueries({ queryKey: ['studio-workflows'] })
      onSaved(workflow.id)
      toast.success('RunningHub 配置已保存到可执行目录')
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const fields = useMemo(
    () => (Array.isArray(draft?.ui_schema.fields) ? draft.ui_schema.fields : []),
    [draft],
  )
  const updateField = (index: number, patch: Field) => {
    setDraft((current) => {
      if (!current) return current
      const next = [...current.ui_schema.fields]
      next[index] = { ...next[index], ...patch }
      return { ...current, ui_schema: { ...current.ui_schema, fields: next } }
    })
  }
  const switchKind = (next: RunningHubRemoteKind) => {
    setKind(next)
    setSourceId('')
    setDraft(null)
  }

  return (
    <section className="wfc-rh-catalog">
      <div className="wfc-section-title">
        <DatabaseZap aria-hidden />
        <div>
          <h2>RunningHub 在线目录与 Model API</h2>
          <p>分别校验积分/账户余额 Key，在线拉取 Model、AI App、Workflow 并编辑暴露参数。</p>
        </div>
      </div>
      {available.length === 0 ? (
        <p className="wfc-error">先添加并启用 RunningHub 凭据。</p>
      ) : (
        <>
          <div className="wfc-rh-toolbar">
            <label>
              凭据
              <Picker
                size="sm"
                value={credentialId === null ? '' : String(credentialId)}
                onChange={(value) => {
                  setCredentialId(Number(value))
                  setDraft(null)
                }}
                options={available.map((credential) => ({
                  value: String(credential.id),
                  label: credential.name,
                }))}
              />
            </label>
            <button
              className="btn"
              disabled={diagnostics.isFetching}
              onClick={() => void diagnostics.refetch()}
            >
              <Activity />{diagnostics.isFetching ? '诊断中…' : '重新诊断'}
            </button>
          </div>
          {diagnostics.data && (
            <div className="wfc-rh-diagnostics">
              <article className={diagnostics.data.points.configured ? 'is-neutral' : 'is-bad'}>
                <CloudDownload />
                <div><strong>积分 Key · AI App / Workflow</strong><span>{diagnostics.data.points.detail}</span></div>
              </article>
              <article className={diagnostics.data.wallet.ok ? 'is-ok' : 'is-bad'}>
                <WalletCards />
                <div><strong>账户余额 Key · Model API</strong><span>{diagnostics.data.wallet.detail}</span></div>
              </article>
            </div>
          )}
          {diagnostics.isError && <p className="wfc-error">诊断失败：{diagnostics.error.message}</p>}
          <div className="wfc-rh-kinds" role="tablist" aria-label="RunningHub 在线类型">
            {(['model', 'app', 'workflow'] as const).map((value) => (
              <button
                role="tab"
                aria-selected={kind === value}
                className={kind === value ? 'is-active' : ''}
                key={value}
                onClick={() => switchKind(value)}
              >
                {value === 'model' ? 'Model API' : value === 'app' ? 'AI App' : 'Workflow'}
              </button>
            ))}
          </div>
          <div className="wfc-rh-fetch">
            {kind === 'model' ? (
              <Picker
                size="sm"
                value={sourceId}
                placeholder={models.isPending ? '正在读取在线模型…' : '选择在线模型'}
                onChange={(value) => {
                  setSourceId(value)
                  setDraft(null)
                }}
                options={(models.data?.items ?? []).map((model) => ({
                  value: model.id,
                  label: model.title,
                  hint: `${model.output_type} · ${model.endpoint}`,
                }))}
              />
            ) : (
              <input
                value={sourceId}
                onChange={(event) => {
                  setSourceId(event.target.value)
                  setDraft(null)
                }}
                placeholder={kind === 'app' ? '输入 AI App ID' : '输入 Workflow ID'}
              />
            )}
            <button className="btn btn-primary" disabled={preview.isPending || !sourceId.trim()} onClick={() => preview.mutate()}>
              <RefreshCw />{preview.isPending ? '拉取中…' : '拉取并编辑'}
            </button>
          </div>
          {models.isError && kind === 'model' && <p className="wfc-error">模型目录读取失败：{models.error.message}</p>}
          {draft && (
            <div className="wfc-rh-editor">
              <header>
                <label>名称<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
                <label>备注<input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
                <code>{draft.kind}:{draft.source_id}</code>
              </header>
              <div className="wfc-rh-field-list">
                {fields.length === 0 && <p className="wfc-empty">上游没有返回可编辑参数；仍可保存并使用固定定义运行。</p>}
                {fields.map((field, index) => {
                  const id = fieldId(field, index)
                  const type = fieldType(field)
                  return (
                    <article className={field.enabled === false ? '' : 'is-enabled'} key={id}>
                      <label className="wfc-rh-field-toggle">
                        <input type="checkbox" checked={field.enabled !== false} onChange={(event) => updateField(index, { enabled: event.target.checked })} />
                        <span><strong>{String(field.label ?? field.fieldName ?? id)}</strong><code>{String(field.nodeId ?? '')}.{String(field.fieldName ?? '')}</code></span>
                      </label>
                      <div className="wfc-rh-field-grid">
                        <label>显示名<input value={String(field.label ?? '')} onChange={(event) => updateField(index, { label: event.target.value })} /></label>
                        <label>类型<Picker size="sm" value={type} onChange={(value) => updateField(index, { fieldType: value })} options={['TEXT', 'NUMBER', 'BOOLEAN', 'SELECT', 'IMAGE', 'VIDEO', 'AUDIO'].map((value) => ({ value, label: value }))} /></label>
                        <label className="is-wide">默认值<input value={String(field.fieldValue ?? '')} onChange={(event) => updateField(index, { fieldValue: type === 'BOOLEAN' ? boolValue(event.target.value) : event.target.value })} /></label>
                        <label className="is-wide">说明<input value={String(field.note ?? '')} onChange={(event) => updateField(index, { note: event.target.value })} /></label>
                        {type === 'NUMBER' && <>
                          <label>最小值<input type="number" value={String(field.min ?? '')} onChange={(event) => updateField(index, { min: event.target.value })} /></label>
                          <label>最大值<input type="number" value={String(field.max ?? '')} onChange={(event) => updateField(index, { max: event.target.value })} /></label>
                          <label>步长<input type="number" value={String(field.step ?? '')} onChange={(event) => updateField(index, { step: event.target.value })} /></label>
                          <label className="wfc-check"><input type="checkbox" checked={boolValue(field.random_enabled)} onChange={(event) => updateField(index, { random_enabled: event.target.checked })} />每次随机</label>
                        </>}
                        {['IMAGE', 'VIDEO', 'AUDIO'].includes(type) && <label className="wfc-check"><input type="checkbox" checked={boolValue(field.required)} onChange={(event) => updateField(index, { required: event.target.checked })} />必填素材</label>}
                      </div>
                    </article>
                  )
                })}
              </div>
              <footer>
                <span>{fields.filter((field) => field.enabled !== false).length} / {fields.length} 个参数已暴露</span>
                <button className="btn btn-primary" disabled={save.isPending || !draft.title.trim()} onClick={() => save.mutate()}><Save />{save.isPending ? '保存中…' : '保存到工作流目录'}</button>
              </footer>
            </div>
          )}
        </>
      )}
    </section>
  )
}
