import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Boxes,
  Cloud,
  Download,
  FileJson2,
  GitBranch,
  History,
  Image as ImageIcon,
  KeyRound,
  LoaderCircle,
  Play,
  Power,
  Trash2,
  Upload,
} from '@/components/NexusIcon'
import { useMemo, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'

import { Picker } from '@/components/ui/picker'
import { apiConfig } from '../../lib/api-config'
import type { Credential } from '../../lib/api-config'
import { apiStudio } from '../../lib/api-studio'
import type { ExecutableWorkflowDetail, StudioTask } from '../../lib/api-studio'
import {
  AddCredButton,
  CredCard,
  CredOverlay,
  RecommendedProviderCards,
} from '../settings/credentials'
import { ComfyWorkflowEditor } from './ComfyWorkflowEditor'
import { AssetManagerTabs } from './AssetManagerTabs'
import { RevisionPanel } from './RevisionPanel'
import { WorkflowAssetLibrary } from './WorkflowAssetLibrary'
import { RunningHubCatalogPanel } from './RunningHubCatalogPanel'

import './workflow-center.css'
import { saveFile } from '@/lib/shell'

type ProviderFilter = 'all' | 'comfyui' | 'runninghub'

function fieldsOf(detail: ExecutableWorkflowDetail | undefined): Record<string, unknown>[] {
  const fields = detail?.ui_schema?.fields
  return Array.isArray(fields)
    ? fields.filter((item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null,
      )
    : []
}

function classTypesOf(detail: ExecutableWorkflowDetail | undefined): string[] {
  if (!detail) return []
  const values = Object.values(detail.payload)
  const names = values.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return []
    const classType = (item as Record<string, unknown>).class_type
    return typeof classType === 'string' ? [classType] : []
  })
  return [...new Set(names)].slice(0, 12)
}

function workflowFieldId(field: Record<string, unknown>, index: number): string {
  const direct = field.id
  if (typeof direct === 'string' && direct !== '') return direct
  const node = field.node ?? field.nodeId
  const input = field.input ?? field.fieldName
  return `${String(node ?? index)}::${String(input ?? index)}`
}

function workflowFieldName(field: Record<string, unknown>, index: number): string {
  return String(field.name ?? field.label ?? field.input ?? field.fieldName ?? `参数 ${index + 1}`)
}

function workflowFieldType(field: Record<string, unknown>): string {
  return String(field.type ?? field.fieldType ?? 'text').toLowerCase()
}

function workflowFieldDefault(field: Record<string, unknown>): unknown {
  return field.default ?? field.fieldValue ?? ''
}

/** 导出物的信封标记。与服务端 `domain/studio_workflows.EXPORT_FORMAT` 同一个常量。 */
const EXPORT_FORMAT = 'lingua-studio-workflow'

/** 认出导出物，好在导入表单上把名字、供应商、类型直接填对。
 *  真正的拆包在服务端做（同一个导入口两种输入都吃），这里只是让用户在点「导入」
 *  之前就看得出自己选的是什么，而不是先导进去再发现类型选错了。 */
function readExportBundle(parsed: Record<string, unknown>): {
  title: string
  provider: 'comfyui' | 'runninghub'
  kind: string
} | null {
  if (parsed.format !== EXPORT_FORMAT) return null
  const workflow = parsed.workflow
  if (typeof workflow !== 'object' || workflow === null) return null
  const spec = workflow as Record<string, unknown>
  const provider = spec.provider === 'runninghub' ? 'runninghub' : 'comfyui'
  return {
    title: typeof spec.title === 'string' ? spec.title : '',
    provider,
    kind: typeof spec.kind === 'string' && spec.kind !== '' ? spec.kind : 'workflow',
  }
}

function saveBlob(blob: Blob, filename: string): void {
  saveFile(blob, filename)
}

function resultItems(task: StudioTask | undefined): Record<string, unknown>[] {
  const raw = task?.result?.items
  return Array.isArray(raw)
    ? raw.filter((item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null,
      )
    : []
}

export function WorkflowCenterPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const [provider, setProvider] = useState<ProviderFilter>('all')
  const [selectedId, setSelectedId] = useState<number | null>(() => {
    const value = Number(searchParams.get('workflow'))
    return Number.isInteger(value) && value > 0 ? value : null
  })
  const [title, setTitle] = useState('')
  const [importProvider, setImportProvider] = useState<'comfyui' | 'runninghub'>('comfyui')
  const [kind, setKind] = useState('workflow')
  const [payload, setPayload] = useState<Record<string, unknown> | null>(null)
  const [fileName, setFileName] = useState('')
  const [credentialId, setCredentialId] = useState<number | null>(null)
  const [runValues, setRunValues] = useState<Record<string, unknown>>({})
  const [useWallet, setUseWallet] = useState(false)
  const [activeTaskId, setActiveTaskId] = useState<string | null>(
    () => searchParams.get('task') || null,
  )
  const [credentialOverlay, setCredentialOverlay] = useState<
    'closed' | 'add' | Credential
  >('closed')
  const [credentialPreset, setCredentialPreset] = useState<string | null>(null)
  const [historyId, setHistoryId] = useState<number | null>(null)
  const [exporting, setExporting] = useState(false)
  // 选中的文件是不是一份导出物。是的话表单上的三个字段已经按它填好了
  const [bundled, setBundled] = useState(false)

  const catalog = useQuery({
    queryKey: ['studio-workflows'],
    queryFn: () => apiStudio.workflows(),
  })
  const detail = useQuery({
    queryKey: ['studio-workflow', selectedId],
    queryFn: () => apiStudio.workflow(selectedId as number),
    enabled: selectedId !== null,
  })
  const providerTypes = useQuery({
    queryKey: ['cfg-provider-types'],
    queryFn: apiConfig.providerTypes,
    staleTime: 300_000,
  })
  const credentials = useQuery({
    queryKey: ['cfg-creds', 'workflow'],
    queryFn: () => apiConfig.credentials('workflow'),
  })
  const activeTask = useQuery({
    queryKey: ['studio-task', activeTaskId],
    queryFn: () => apiStudio.task(activeTaskId as string),
    enabled: activeTaskId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return status !== undefined && ['succeeded', 'partial', 'failed', 'cancelled'].includes(status)
        ? false
        : 1500
    },
  })
  const items = useMemo(
    () =>
      (catalog.data?.items ?? []).filter(
        (item) => provider === 'all' || item.provider === provider,
      ),
    [catalog.data, provider],
  )

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['studio-workflows'] })
    if (selectedId !== null) {
      void queryClient.invalidateQueries({ queryKey: ['studio-workflow', selectedId] })
    }
  }
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      apiStudio.patchWorkflow(id, { enabled }),
    onSuccess: invalidate,
    onError: (error: Error) => toast.error(error.message),
  })
  const importMutation = useMutation({
    mutationFn: () => {
      if (!payload) throw new Error('先选择工作流 JSON')
      return apiStudio.importWorkflow({
        // 导出物自带名字：用户没改就留空，让服务端沿用导出时那个，
        // 而不是拿文件名去顶（文件名是清洗过的 ASCII，中文标题会丢）
        title: title.trim() || (bundled ? '' : fileName.replace(/\.json$/i, '')),
        provider: importProvider,
        kind,
        payload,
      })
    },
    onSuccess: (created) => {
      invalidate()
      setSelectedId(created.id)
      setTitle('')
      setPayload(null)
      setFileName('')
      setBundled(false)
      toast.success('工作流已导入')
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const runMutation = useMutation({
    mutationFn: ({ workflowId, selectedCredential }: {
      workflowId: number
      selectedCredential: number
    }) => apiStudio.runWorkflow(workflowId, {
      credential_id: selectedCredential,
      fields: runValues,
      use_wallet: detail.data?.kind === 'model' ? true : useWallet,
      source_route: `/studio/workflows?workflow=${workflowId}`,
      source_context: { workflow_id: workflowId },
    }),
    onSuccess: (task) => {
      setActiveTaskId(task.id)
      setSearchParams(
        { workflow: String(task.source_context?.workflow_id ?? selectedId), task: task.id },
        { replace: true },
      )
      void queryClient.invalidateQueries({ queryKey: ['studio-tasks'] })
      toast.success('工作流已进入后台任务')
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      const parsed: unknown = JSON.parse(await file.text())
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('工作流 JSON 顶层必须是对象')
      }
      const record = parsed as Record<string, unknown>
      const bundle = readExportBundle(record)
      setPayload(record)
      setFileName(file.name)
      setBundled(bundle !== null)
      if (bundle !== null) {
        // 导出物自报家门：供应商、类型按它填，用户不用猜自己当初导的是哪一种
        setImportProvider(bundle.provider)
        setKind(bundle.kind)
        setTitle('')
        toast.success(`认出一份导出物：${bundle.title || '未命名'}（${bundle.provider}）`)
      } else if (!title) {
        setTitle(file.name.replace(/\.json$/i, ''))
      }
    } catch (error) {
      setPayload(null)
      setFileName('')
      setBundled(false)
      toast.error(error instanceof Error ? error.message : 'JSON 解析失败')
    } finally {
      event.target.value = ''
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (payload) importMutation.mutate()
  }

  const exportOne = async (id: number, name: string) => {
    if (exporting) return
    setExporting(true)
    try {
      const result = await apiStudio.exportWorkflow(id)
      saveBlob(result.blob, result.filename)
      toast.success(`已导出「${name}」。凭据字段与本机绝对路径在服务端就抹掉了`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导出失败')
    } finally {
      setExporting(false)
    }
  }

  const remove = async (id: number) => {
    if (!window.confirm('删除这个用户工作流？')) return
    await apiStudio.deleteWorkflow(id)
    if (selectedId === id) setSelectedId(null)
    invalidate()
    toast.success('工作流已删除')
  }

  const fields = fieldsOf(detail.data)
  const classTypes = classTypesOf(detail.data)
  const workflowCredentials = (credentials.data ?? []).filter(
    (credential) =>
      credential.enabled &&
      (detail.data === undefined || credential.provider_type === detail.data.provider),
  )
  const selectedCredential =
    workflowCredentials.find((credential) => credential.id === credentialId)?.id ??
    workflowCredentials[0]?.id ??
    null
  const workflowCredentialTypes = (providerTypes.data ?? []).filter(
    (type) => type.kind === 'workflow',
  )
  const outputs = resultItems(activeTask.data)
  const runnableFields = fields.filter(
    (field) => detail.data?.provider === 'comfyui' || field.enabled !== false,
  )

  return (
    <main className="wfc-page">
      <AssetManagerTabs active="workflows" />
      <header className="wfc-hero">
        <div>
          <span>ST-15 · ComfyUI / RunningHub</span>
          <h1>工作流中心</h1>
          <p>
            已把 Infinite-Canvas 的内置节点图、参数表和 RunningHub 工作流目录迁入
            Lingua。现在可直接运行本机/局域网 ComfyUI 和 RunningHub 云端工作流，
            任务与产物都会持久化。
          </p>
          <small className="wfc-license">
            工作流资产来源：hero8152 / Infinite-Canvas；遵循源项目“非商业、
            二次开发保持开源并注明作者”的条款。
          </small>
        </div>
        <div className="wfc-hero-actions">
          <div className="wfc-count">
            <strong>{catalog.data?.items.length ?? 0}</strong>
            <span>条工作流</span>
          </div>
          <button className="btn btn-primary" onClick={() => navigate('/studio/flows')}>
            <GitBranch />编排工具 DAG
          </button>
        </div>
      </header>

      <section className="wfc-credentials">
        <div className="wfc-section-title">
          <KeyRound aria-hidden />
          <div>
            <h2>执行器凭据</h2>
            <p>密钥加密保存；ComfyUI 可以配本机或局域网地址。</p>
          </div>
        </div>
        {credentials.isPending && <p className="wfc-empty">正在读取执行器凭据…</p>}
        {credentials.isError && (
          <p className="wfc-error">凭据读取失败：{credentials.error.message}</p>
        )}
        <RecommendedProviderCards
          types={workflowCredentialTypes}
          onSelect={(providerType) => {
            setCredentialPreset(providerType)
            setCredentialOverlay('add')
          }}
        />
        {(credentials.data ?? []).map((credential) => (
          <CredCard
            key={credential.id}
            cred={credential}
            unitLabel="能力"
            refreshLabel="读取能力"
            showTest
            onEdit={() => setCredentialOverlay(credential)}
          />
        ))}
        <AddCredButton
          text="添加 ComfyUI / RunningHub"
          onClick={() => {
            setCredentialPreset(null)
            setCredentialOverlay('add')
          }}
        />
      </section>

      <WorkflowAssetLibrary />

      <RunningHubCatalogPanel
        credentials={credentials.data ?? []}
        onSaved={(workflowId) => {
          setProvider('runninghub')
          setSelectedId(workflowId)
          setCredentialId(null)
          setRunValues({})
          setUseWallet(true)
          setActiveTaskId(null)
          setSearchParams({ workflow: String(workflowId) }, { replace: true })
        }}
      />

      <section className="wfc-tabs" aria-label="供应商筛选">
        {(['all', 'comfyui', 'runninghub'] as const).map((value) => (
          <button
            className={provider === value ? 'is-active' : ''}
            key={value}
            onClick={() => setProvider(value)}
          >
            {value === 'all' ? '全部' : value === 'comfyui' ? 'ComfyUI' : 'RunningHub'}
          </button>
        ))}
      </section>

      <section className="wfc-layout">
        <div className="wfc-main">
          {catalog.isPending && <p className="wfc-empty">正在载入工作流目录…</p>}
          {catalog.isError && (
            <p className="wfc-error">读取失败：{catalog.error.message}</p>
          )}
          <div className="wfc-grid">
            {items.map((workflow) => (
              <article
                className={
                  selectedId === workflow.id ? 'wfc-card is-selected' : 'wfc-card'
                }
                key={workflow.id}
              >
                <button
                  className="wfc-card-open"
                  onClick={() => {
                    setSelectedId(workflow.id)
                    setCredentialId(null)
                    setRunValues({})
                    setUseWallet(false)
                    setActiveTaskId(null)
                    setSearchParams({ workflow: String(workflow.id) }, { replace: true })
                  }}
                >
                  <div className="wfc-thumb">
                    {workflow.has_thumbnail ? (
                      <img
                        src={`/api/studio/workflows/${workflow.id}/thumbnail`}
                        alt=""
                      />
                    ) : workflow.provider === 'comfyui' ? (
                      <Boxes aria-hidden />
                    ) : (
                      <Cloud aria-hidden />
                    )}
                  </div>
                  <div className="wfc-card-copy">
                    <strong>{workflow.title}</strong>
                    <span>
                      {workflow.provider} · {workflow.kind}
                    </span>
                    <small>
                      {workflow.node_count > 0 && `${workflow.node_count} 节点 · `}
                      {workflow.field_count} 个参数 ·{' '}
                      {workflow.source === 'bundled' ? 'hero8152 内置迁移' : '用户导入'}
                    </small>
                  </div>
                </button>
                <div className="wfc-card-actions">
                  <button
                    aria-label={workflow.enabled ? '停用工作流' : '启用工作流'}
                    className={workflow.enabled ? 'is-on' : ''}
                    disabled={toggle.isPending}
                    onClick={() =>
                      toggle.mutate({ id: workflow.id, enabled: !workflow.enabled })
                    }
                  >
                    <Power aria-hidden />
                  </button>
                  {workflow.source === 'user' && (
                    <button
                      aria-label="删除工作流"
                      onClick={() =>
                        void remove(workflow.id).catch((error: Error) =>
                          toast.error(error.message),
                        )
                      }
                    >
                      <Trash2 aria-hidden />
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>

          <form className="wfc-import" onSubmit={submit}>
            <div className="wfc-section-title">
              <Upload aria-hidden />
              <div>
                <h2>导入工作流</h2>
                <p>
                  裸节点图和本站导出的 JSON 都从这里进；密钥字段会被服务端拒绝。
                  {bundled && ' 这份是导出物，供应商与类型已按它填好。'}
                </p>
              </div>
            </div>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={bundled ? '留空就沿用导出物里的名字' : '工作流名称'}
            />
            <Picker
              size="sm"
              value={importProvider}
              onChange={(v) => setImportProvider(v as 'comfyui' | 'runninghub')}
              options={[
                { value: 'comfyui', label: 'ComfyUI' },
                { value: 'runninghub', label: 'RunningHub' },
              ]}
            />
            <Picker
              size="sm"
              value={kind}
              onChange={setKind}
              options={[
                { value: 'workflow', label: '通用工作流' },
                { value: 'image', label: '生图' },
                { value: 'edit', label: '图片编辑' },
                { value: 'upscale', label: '高清放大' },
                { value: 'video', label: '视频' },
                { value: 'app', label: 'AI 应用' },
              ]}
            />
            <label className="wfc-file">
              <FileJson2 aria-hidden />
              {fileName || '选择 JSON 文件'}
              <input type="file" accept="application/json,.json" onChange={readFile} />
            </label>
            <button className="btn btn-primary" disabled={!payload || importMutation.isPending}>
              {importMutation.isPending ? '导入中…' : '导入目录'}
            </button>
          </form>
        </div>

        <aside className="wfc-inspector">
          {selectedId === null ? (
            <div className="wfc-inspector-empty">
              <ImageIcon aria-hidden />
              <p>选择一条工作流查看节点和可调参数。</p>
            </div>
          ) : detail.isPending ? (
            <p className="wfc-empty">正在读取配置…</p>
          ) : detail.isError ? (
            <p className="wfc-error">配置读取失败：{detail.error.message}</p>
          ) : detail.data ? (
            <>
              <span className="wfc-provider">{detail.data.provider}</span>
              <h2>{detail.data.title}</h2>
              <code>{detail.data.key}</code>
              <dl>
                <div><dt>类型</dt><dd>{detail.data.kind}</dd></div>
                <div><dt>节点</dt><dd>{detail.data.node_count}</dd></div>
                <div><dt>参数</dt><dd>{detail.data.field_count}</dd></div>
                <div><dt>版本</dt><dd>v{detail.data.version}</dd></div>
                <div><dt>状态</dt><dd>{detail.data.enabled ? '已启用' : '已停用'}</dd></div>
              </dl>
              <div className="wfc-versioning">
                <button
                  className="btn btn-sm btn-outline"
                  disabled={exporting}
                  title="导出一份自包含 JSON，同一个导入口能原样导回来"
                  onClick={() => void exportOne(detail.data.id, detail.data.title)}
                >
                  <Download aria-hidden />
                  {exporting ? '导出中…' : '导出 JSON'}
                </button>
                <button
                  className="btn btn-sm btn-outline"
                  title="看历史版本，或把某一版取回来"
                  onClick={() => setHistoryId(detail.data.id)}
                >
                  <History aria-hidden />版本历史
                </button>
              </div>
              <p className="wfc-export-note">
                导出物不含凭据：密钥字段与本机绝对路径在服务端就被抹掉，
                抹了哪些逐条写在导出文件的 <code>redacted</code> 里。
              </p>
              {fields.length > 0 && (
                <section>
                  <h3>可调参数</h3>
                  <div className="wfc-tags">
                    {fields.slice(0, 18).map((field, index) => (
                      <span key={String(field.id ?? index)}>
                        {String(field.name ?? field.label ?? field.input ?? `参数 ${index + 1}`)}
                      </span>
                    ))}
                  </div>
                </section>
              )}
              {classTypes.length > 0 && (
                <section>
                  <h3>节点类型</h3>
                  <div className="wfc-tags is-code">
                    {classTypes.map((name) => <span key={name}>{name}</span>)}
                  </div>
                </section>
              )}
              <section className="wfc-runner">
                <div className="wfc-runner-title">
                  <Play aria-hidden />
                  <div><h3>运行工作流</h3><p>离开页面后任务仍在后台继续。</p></div>
                </div>
                <label>
                  执行器凭据
                  <Picker
                    size="sm"
                    value={selectedCredential === null ? '' : String(selectedCredential)}
                    placeholder="选择凭据"
                    onChange={(v) => setCredentialId(Number(v))}
                    options={workflowCredentials.map((c) => ({
                      value: String(c.id),
                      label: c.name,
                      hint: c.provider_type,
                    }))}
                  />
                </label>
                {selectedCredential === null && (
                  <p className="wfc-error">先在页面上方添加并启用 {detail.data.provider} 凭据。</p>
                )}
                <div className="wfc-run-fields">
                  {runnableFields.map((field, index) => {
                    const fieldId = workflowFieldId(field, index)
                    const fieldType = workflowFieldType(field)
                    const value = runValues[fieldId] ?? workflowFieldDefault(field)
                    const options = Array.isArray(field.options) ? field.options : []
                    const update = (next: unknown) =>
                      setRunValues((current) => ({ ...current, [fieldId]: next }))
                    if (fieldType === 'boolean') {
                      const checked = typeof value === 'boolean'
                        ? value
                        : String(value).toLowerCase() === 'true'
                      return (
                        <label className="wfc-check" key={fieldId}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(event) => update(event.target.checked)}
                          />
                          {workflowFieldName(field, index)}
                        </label>
                      )
                    }
                    if (options.length > 0 || ['dropdown', 'select'].includes(fieldType)) {
                      return (
                        <label key={fieldId}>
                          {workflowFieldName(field, index)}
                          <Picker
                            size="sm"
                            value={String(value ?? '')}
                            onChange={update}
                            options={options.map((option) => {
                              const v =
                                typeof option === 'object' && option !== null
                                  ? String((option as Record<string, unknown>).value ?? '')
                                  : String(option)
                              return { value: v, label: v }
                            })}
                          />
                        </label>
                      )
                    }
                    if (['textarea', 'json'].includes(fieldType)) {
                      return (
                        <label key={fieldId}>
                          {workflowFieldName(field, index)}
                          <textarea
                            value={String(value ?? '')}
                            onChange={(event) => update(event.target.value)}
                          />
                        </label>
                      )
                    }
                    return (
                      <label key={fieldId}>
                        {workflowFieldName(field, index)}
                        <input
                          type={fieldType === 'number' ? 'number' : 'text'}
                          value={String(value ?? '')}
                          min={typeof field.min === 'number' ? field.min : undefined}
                          max={typeof field.max === 'number' ? field.max : undefined}
                          step={typeof field.step === 'number' ? field.step : undefined}
                          placeholder={
                            fieldType === 'image'
                              ? '已上传文件名，或 asset:67'
                              : ['video', 'audio', 'file'].includes(fieldType)
                                ? '已上传文件名，或 media:67'
                                : undefined
                          }
                          onChange={(event) =>
                            update(
                              fieldType === 'number' && event.target.value !== ''
                                ? Number(event.target.value)
                                : event.target.value,
                            )
                          }
                        />
                      </label>
                    )
                  })}
                </div>
                {detail.data.provider === 'runninghub' && (
                  <label className="wfc-check">
                    <input
                      type="checkbox"
                      checked={detail.data.kind === 'model' ? true : useWallet}
                      disabled={detail.data.kind === 'model'}
                      onChange={(event) => setUseWallet(event.target.checked)}
                    />
                    {detail.data.kind === 'model'
                      ? 'Model API 固定使用账户余额 Key'
                      : '使用账户余额 Key'}
                  </label>
                )}
                <button
                  className="btn btn-primary"
                  disabled={
                    selectedCredential === null ||
                    !detail.data.enabled ||
                    runMutation.isPending ||
                    (activeTask.data !== undefined &&
                      ['queued', 'submitting', 'running', 'recovering'].includes(activeTask.data.status))
                  }
                  onClick={() => {
                    if (selectedCredential !== null) {
                      runMutation.mutate({
                        workflowId: detail.data.id,
                        selectedCredential,
                      })
                    }
                  }}
                >
                  {runMutation.isPending ? '正在入队…' : '运行工作流'}
                </button>
                {activeTask.data && (
                  <div className={`wfc-task is-${activeTask.data.status}`}>
                    {['queued', 'submitting', 'running', 'recovering'].includes(
                      activeTask.data.status,
                    ) && <LoaderCircle aria-hidden />}
                    <div>
                      <strong>{activeTask.data.status} · {activeTask.data.stage ?? '等待执行'}</strong>
                      <span>进度 {Math.round(activeTask.data.progress)}%</span>
                      {activeTask.data.provider_task_id && (
                        <code>{activeTask.data.provider_task_id}</code>
                      )}
                      {activeTask.data.error && <p>{activeTask.data.error}</p>}
                    </div>
                  </div>
                )}
                {outputs.length > 0 && (
                  <div className="wfc-outputs">
                    {outputs.map((item, index) => {
                      const url = typeof item.url === 'string' ? item.url : ''
                      const kind = String(item.kind ?? 'file')
                      const name = String(item.name ?? `产物 ${index + 1}`)
                      if (kind === 'image') return <img key={`${url}-${index}`} src={url} alt={name} />
                      if (kind === 'video') return <video key={`${url}-${index}`} src={url} controls />
                      if (kind === 'audio') return <audio key={`${url}-${index}`} src={url} controls />
                      return <a key={`${url}-${index}`} href={url} download>{name}</a>
                    })}
                  </div>
                )}
              </section>
            </>
          ) : null}
        </aside>
      </section>
      {detail.data?.provider === 'comfyui' && <ComfyWorkflowEditor detail={detail.data} />}
      {historyId !== null && (
        <RevisionPanel
          kind="workflow"
          id={historyId}
          name={detail.data?.title ?? '工作流'}
          currentVersion={detail.data?.version ?? null}
          onRestored={invalidate}
          onClose={() => setHistoryId(null)}
        />
      )}
      {credentialOverlay !== 'closed' && (
        <CredOverlay
          kind="workflow"
          types={workflowCredentialTypes}
          existing={credentialOverlay === 'add' ? undefined : credentialOverlay}
          initialProviderType={
            credentialOverlay === 'add' ? credentialPreset ?? undefined : undefined
          }
          onClose={() => {
            setCredentialOverlay('closed')
            setCredentialPreset(null)
          }}
        />
      )}
    </main>
  )
}

export default WorkflowCenterPage
