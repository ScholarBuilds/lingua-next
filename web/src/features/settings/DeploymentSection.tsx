/* 模型部署（配置三层里的第二层）：真实模型名 + 调用适配器 + 媒体能力。

   这一层从工坊「模型实验台」搬过来。它回答的是「这家供应商下我要登记哪些真实模型」，
   上承供应商凭据、下接能力绑定——能力绑定只能从这里登记过的部署里挑，
   所以列表按凭据归堆，与上一层的凭据卡片一一对应。

   凭据「刷新模型」会把供应商返回的模型自动登记成部署，手工登记只用于
   接口列表里查不到的模型（部分中转站不返回生图模型）。 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Picker } from '@/components/ui/picker'

import { ApiConfigError, apiConfig } from '../../lib/api-config'
import type {
  Credential,
  ModelDeployment,
  ModelPlugin,
} from '../../lib/api-config'
import { SIconEdit, SIconPlus } from './icons'
import {
  IMAGE_REQUEST_MODES,
  MEDIA_OPTIONS,
  adapterForProviderType,
  buildProtocolOptions,
  deploymentStats,
  effectiveImageMode,
  filterDeployments,
  groupDeployments,
  mediaLabel,
  protocolFieldValues,
  readyMediaOf,
  supportsImageProtocol,
  unsupportedMediaOf,
  validateDeploymentDraft,
} from './deployments'
import { CGroup, ErrorBlock, LoadingCards, Switch } from './shared'

/** 部署可以挂在任何一类凭据下：对话与生图常常共用同一个 OpenAI 兼容端点，
    所以四类凭据都要拉，按 id 去重（同一条会同时出现在 llm 与 image 列表里） */
function useDeploymentCredentials(): Credential[] {
  const llm = useQuery({ queryKey: ['cfg-creds', 'llm'], queryFn: () => apiConfig.credentials('llm') })
  const image = useQuery({
    queryKey: ['cfg-creds', 'image'],
    queryFn: () => apiConfig.credentials('image'),
  })
  const video = useQuery({
    queryKey: ['cfg-creds', 'video'],
    queryFn: () => apiConfig.credentials('video'),
  })
  const workflow = useQuery({
    queryKey: ['cfg-creds', 'workflow'],
    queryFn: () => apiConfig.credentials('workflow'),
  })
  return useMemo(() => {
    const seen = new Map<number, Credential>()
    for (const row of [
      ...(llm.data ?? []),
      ...(image.data ?? []),
      ...(video.data ?? []),
      ...(workflow.data ?? []),
    ]) {
      // 同一条凭据会同时出现在 llm 与 image 列表里（compatible_kinds）
      if (!seen.has(row.id)) seen.set(row.id, row)
    }
    return [...seen.values()].sort((a, b) => a.id - b.id)
  }, [llm.data, image.data, video.data, workflow.data])
}

/* ---- 登记 / 编辑一条部署 ---- */

function DeploymentDialog({
  existing,
  credentials,
  plugins,
  onClose,
}: {
  existing?: ModelDeployment
  credentials: Credential[]
  plugins: ModelPlugin[]
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const enabledCreds = credentials.filter((cred) => cred.enabled)
  const [credentialId, setCredentialId] = useState<number | null>(
    existing?.credential_id ?? enabledCreds[0]?.id ?? null,
  )
  const [model, setModel] = useState(existing?.upstream_model_id ?? '')
  const [displayName, setDisplayName] = useState(existing?.display_name ?? '')
  const [adapter, setAdapter] = useState(existing?.adapter_type ?? 'openai')
  const [mediaTypes, setMediaTypes] = useState<string[]>(existing?.media_types ?? ['chat'])
  const [requestMode, setRequestMode] = useState(
    typeof existing?.protocol_options?.image_request_mode === 'string'
      ? existing.protocol_options.image_request_mode
      : 'openai',
  )
  const [protocolFields, setProtocolFields] = useState(() =>
    protocolFieldValues(existing?.protocol_options),
  )
  const [error, setError] = useState<string | null>(null)
  /* 已经为哪条凭据自动挑过适配器。StrictMode 下用 useRef 当「首帧」守卫会失效，
     判据一律是「这个依赖真的变过没有」——否则用户手动换的适配器会被后续渲染冲掉 */
  const [autoPickedFor, setAutoPickedFor] = useState<number | null>(null)

  /* 新建时跟着凭据换默认适配器；编辑既有部署不动用户已经选好的 */
  useEffect(() => {
    if (existing !== undefined || credentialId === null) return
    if (credentialId === autoPickedFor || plugins.length === 0) return
    const cred = credentials.find((item) => item.id === credentialId)
    if (cred === undefined) return
    setAdapter(adapterForProviderType(plugins, cred.provider_type))
    setAutoPickedFor(credentialId)
  }, [autoPickedFor, credentialId, credentials, existing, plugins])

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['cfg-model-deployments'] })
    void queryClient.invalidateQueries({ queryKey: ['cfg-bindings'] })
  }

  const save = useMutation({
    mutationFn: () => {
      const options = buildProtocolOptions(
        existing?.protocol_options ?? null,
        adapter,
        requestMode,
        supportsImageProtocol(adapter, mediaTypes) ? protocolFields : {},
      )
      if (existing !== undefined) {
        return apiConfig.updateModelDeployment(existing.id, {
          display_name: displayName.trim() || null,
          adapter_type: adapter,
          media_types: mediaTypes,
          protocol_options: options,
        })
      }
      return apiConfig.createModelDeployment({
        credential_id: credentialId!,
        upstream_model_id: model.trim(),
        display_name: displayName.trim() || null,
        adapter_type: adapter,
        media_types: mediaTypes,
        protocol_options: options,
      })
    },
    onSuccess: () => {
      invalidate()
      toast.success(existing !== undefined ? '部署已更新' : '模型已登记')
      onClose()
    },
    onError: (err: Error) => setError(err.message),
  })

  const submit = () => {
    setError(null)
    const problem = validateDeploymentDraft({ credentialId, model, adapter, mediaTypes }, plugins)
    if (problem !== null) {
      setError(problem)
      return
    }
    save.mutate()
  }

  const unsupported = unsupportedMediaOf(plugins, adapter, mediaTypes)
  const effectiveMode = effectiveImageMode(adapter, requestMode)
  const showProtocol = supportsImageProtocol(adapter, mediaTypes)
  const setProtocolField = (key: string, value: string) =>
    setProtocolFields((current) => ({ ...current, [key]: value }))

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[86vh] gap-3.5 overflow-y-auto bg-card p-5 sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="text-[15px]">
            {existing !== undefined
              ? `编辑部署「${existing.display_name || existing.upstream_model_id}」`
              : '登记模型部署'}
          </DialogTitle>
        </DialogHeader>

        <div className="cred-form">
          <section className="cred-group">
            <div className="cred-group-head">
              <span className="cred-group-label">挂在哪条凭据下</span>
              <span className="cred-group-desc">密钥留在凭据里，这里不接收任何 Secret。</span>
            </div>
            <div className="field">
              <span className="dep-legend">供应商凭据</span>
              {existing !== undefined ? (
                <div className="dep-static">
                  {existing.credential_name ?? `凭据 #${existing.credential_id}`}
                  <span className="dep-static-note">部署建好后不能换供应商，换请新建一条</span>
                </div>
              ) : (
                <Picker
                  size="sm"
                  aria-label="供应商凭据"
                  value={credentialId === null ? '' : String(credentialId)}
                  placeholder="选择凭据"
                  onChange={(v) => setCredentialId(Number(v))}
                  options={enabledCreds.map((cred) => ({
                    value: String(cred.id),
                    label: cred.name,
                    hint: cred.provider_type,
                  }))}
                />
              )}
              {enabledCreds.length === 0 && existing === undefined && (
                <div className="field-hint">上面还没有启用的凭据，先接一个供应商。</div>
              )}
            </div>
          </section>

          <section className="cred-group">
            <div className="cred-group-head">
              <span className="cred-group-label">模型标识</span>
              <span className="cred-group-desc">
                真实模型名要与供应商文档一字不差，显示名只是列表里好认。
              </span>
            </div>
            <div className="field">
              <label htmlFor="dep-model">真实模型名</label>
              <input
                id="dep-model"
                className="field-input"
                value={model}
                readOnly={existing !== undefined}
                placeholder="gpt-image-2"
                onChange={(e) => setModel(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="dep-display">显示名称</label>
              <input
                id="dep-display"
                className="field-input"
                value={displayName}
                placeholder="GPT Image 2"
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>
          </section>

          <section className="cred-group">
            <div className="cred-group-head">
              <span className="cred-group-label">怎么调用</span>
              <span className="cred-group-desc">
                适配器决定走哪套线协议，媒体能力决定它能被哪些能力绑定选到。
              </span>
            </div>
            <div className="field">
              <span className="dep-legend">调用适配器</span>
              <Picker
                size="sm"
                aria-label="调用适配器"
                value={adapter}
                onChange={setAdapter}
                title={plugins.find((item) => item.id === adapter)?.name}
                options={plugins.map((item) => ({
                  value: item.id,
                  label: item.name,
                  hint:
                    item.ready_media_types.length > 0
                      ? item.ready_media_types.map(mediaLabel).join(' · ')
                      : '执行适配待接入',
                }))}
              />
            </div>
            <div className="field">
              <span className="dep-legend">媒体能力</span>
              <div className="dep-checks">
                {MEDIA_OPTIONS.map(([value, label]) => (
                  <label key={value} className="dep-check">
                    <input
                      type="checkbox"
                      checked={mediaTypes.includes(value)}
                      onChange={(event) =>
                        setMediaTypes((current) =>
                          event.target.checked
                            ? [...current, value]
                            : current.filter((item) => item !== value),
                        )
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
              {unsupported.length > 0 && (
                <div className="field-hint dep-hint-warn">
                  当前适配器不支持{unsupported.map(mediaLabel).join('、')}
                </div>
              )}
            </div>
          </section>

          {showProtocol && (
            <details className="dep-protocol">
              <summary>调用协议（图片线才需要）</summary>
              <div className="field">
                <span className="dep-legend">图片请求模式</span>
                {adapter === 'openai' ? (
                  <Picker
                    size="sm"
                    aria-label="图片请求模式"
                    value={requestMode}
                    onChange={setRequestMode}
                    title={IMAGE_REQUEST_MODES.find((item) => item.value === requestMode)?.label}
                    options={[...IMAGE_REQUEST_MODES]}
                  />
                ) : (
                  <input
                    className="field-input"
                    aria-label="图片请求模式"
                    value={effectiveMode}
                    readOnly
                  />
                )}
              </div>
              {['openai-json', 'apimart', 'tudou-async'].includes(effectiveMode) && (
                <div className="field">
                  <label htmlFor="dep-gen-path">生成路径</label>
                  <input
                    id="dep-gen-path"
                    className="field-input"
                    value={protocolFields.generation_path ?? ''}
                    placeholder={
                      effectiveMode === 'tudou-async'
                        ? '/images/generations/async'
                        : '/images/generations'
                    }
                    onChange={(e) => setProtocolField('generation_path', e.target.value)}
                  />
                </div>
              )}
              {effectiveMode === 'openai-responses' && (
                <div className="field">
                  <label htmlFor="dep-resp-path">Responses 路径</label>
                  <input
                    id="dep-resp-path"
                    className="field-input"
                    value={protocolFields.responses_path ?? ''}
                    placeholder="/responses"
                    onChange={(e) => setProtocolField('responses_path', e.target.value)}
                  />
                </div>
              )}
              {effectiveMode === 'openai-video-proxy' && (
                <div className="field">
                  <label htmlFor="dep-video-path">Videos 路径</label>
                  <input
                    id="dep-video-path"
                    className="field-input"
                    value={protocolFields.video_proxy_path ?? ''}
                    placeholder="/videos"
                    onChange={(e) => setProtocolField('video_proxy_path', e.target.value)}
                  />
                </div>
              )}
              {['apimart', 'openai-video-proxy', 'openai-responses', 'tudou-async'].includes(
                effectiveMode,
              ) && (
                <>
                  <div className="field">
                    <label htmlFor="dep-task-path">任务查询路径</label>
                    <input
                      id="dep-task-path"
                      className="field-input"
                      value={protocolFields.task_path_template ?? ''}
                      placeholder="/tasks/{task_id}"
                      onChange={(e) => setProtocolField('task_path_template', e.target.value)}
                    />
                  </div>
                  <div className="dep-num-row">
                    <div className="field">
                      <label htmlFor="dep-poll">轮询间隔（秒）</label>
                      <input
                        id="dep-poll"
                        className="field-input"
                        inputMode="decimal"
                        value={protocolFields.poll_interval ?? ''}
                        placeholder="4"
                        onChange={(e) => setProtocolField('poll_interval', e.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="dep-delay">首轮等待（秒）</label>
                      <input
                        id="dep-delay"
                        className="field-input"
                        inputMode="decimal"
                        value={protocolFields.initial_poll_delay ?? ''}
                        placeholder="0"
                        onChange={(e) => setProtocolField('initial_poll_delay', e.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="dep-timeout">任务超时（秒）</label>
                      <input
                        id="dep-timeout"
                        className="field-input"
                        inputMode="numeric"
                        value={protocolFields.task_timeout ?? ''}
                        placeholder="1800"
                        onChange={(e) => setProtocolField('task_timeout', e.target.value)}
                      />
                    </div>
                  </div>
                </>
              )}
            </details>
          )}

          {error !== null && <div className="form-err">{error}</div>}

          <div className="overlay-foot foot-split">
            <span className="spacer" />
            <button type="button" className="btn" onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className={`btn btn-primary${save.isPending ? ' loading' : ''}`}
              disabled={save.isPending}
              onClick={submit}
            >
              {save.isPending && <span className="spinner" />}
              {existing !== undefined ? '保存' : '登记'}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/* ---- 一行部署 ---- */

function DeploymentRow({
  row,
  plugins,
  onEdit,
  onDelete,
}: {
  row: ModelDeployment
  plugins: ModelPlugin[]
  onEdit: () => void
  onDelete: () => void
}) {
  const queryClient = useQueryClient()
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['cfg-model-deployments'] })
    void queryClient.invalidateQueries({ queryKey: ['cfg-bindings'] })
  }
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => apiConfig.updateModelDeployment(row.id, { enabled }),
    onSuccess: invalidate,
    onError: (error: Error) => toast.error(error.message),
  })
  const ready = readyMediaOf(plugins, row.adapter_type, row.media_types)
  const adapterName = plugins.find((item) => item.id === row.adapter_type)?.name ?? row.adapter_type

  return (
    <div className={`dep-row${row.enabled ? '' : ' dep-off'}`}>
      <div className="dep-main">
        <span className="dep-name">{row.display_name || row.upstream_model_id}</span>
        {row.display_name !== null && row.display_name !== '' && (
          <code className="dep-code">{row.upstream_model_id}</code>
        )}
      </div>
      <div className="dep-tags">
        <span className="dep-adapter">{adapterName}</span>
        {row.media_types.map((media) => (
          <span className="chip" key={media}>
            {mediaLabel(media)}
          </span>
        ))}
        {ready.length === 0 && (
          <span className="chip warn" title="这个适配器还没为该媒体类型接线，能力绑定里选不到它">
            待接入
          </span>
        )}
      </div>
      <div className="dep-actions">
        <button className="icon-btn" title="编辑部署" onClick={onEdit}>
          <SIconEdit />
        </button>
        <button className="icon-btn dep-del" title="删除部署" onClick={onDelete}>
          ×
        </button>
        <Switch
          on={row.enabled}
          disabled={toggle.isPending}
          title={row.enabled ? '停用' : '启用'}
          onChange={(next) => toggle.mutate(next)}
        />
      </div>
    </div>
  )
}

/* ---- 区块主体 ---- */

export function DeploymentSection() {
  const queryClient = useQueryClient()
  const credentials = useDeploymentCredentials()
  const deploymentsQuery = useQuery({
    queryKey: ['cfg-model-deployments'],
    queryFn: () => apiConfig.modelDeployments(),
  })
  const pluginsQuery = useQuery({
    queryKey: ['cfg-model-plugins'],
    queryFn: apiConfig.modelPlugins,
    staleTime: Infinity,
  })
  const [keyword, setKeyword] = useState('')
  const [media, setMedia] = useState('all')
  /* 停用的部署默认收起：网关退役那次一口气停了 28 条，全列出来这张表一半是死行，
     用户要在里面找自己在用的那 26 条。想看仍然点得开，只是不再挡在前面 */
  const [showDisabled, setShowDisabled] = useState(false)
  const [dialog, setDialog] = useState<'closed' | 'create' | ModelDeployment>('closed')

  const plugins = pluginsQuery.data ?? []
  const all = deploymentsQuery.data ?? []
  const stats = deploymentStats(all, plugins)
  const disabledCount = stats.total - stats.enabled
  const listed = showDisabled ? all : all.filter((row) => row.enabled)
  const visible = filterDeployments(
    media === 'all' ? listed : listed.filter((row) => row.media_types.includes(media)),
    keyword,
  )
  const groups = groupDeployments(visible, credentials)

  const remove = async (row: ModelDeployment) => {
    const name = row.display_name || row.upstream_model_id
    if (!window.confirm(`删除部署「${name}」？供应商凭据与模型本身不受影响。`)) return
    try {
      await apiConfig.deleteModelDeployment(row.id)
    } catch (error) {
      if (!(error instanceof ApiConfigError) || error.status !== 409) {
        toast.error(error instanceof Error ? error.message : '删除失败')
        return
      }
      if (!window.confirm(`${error.message}。同时清空这些能力绑定？`)) return
      await apiConfig.deleteModelDeployment(row.id, true)
    }
    void queryClient.invalidateQueries({ queryKey: ['cfg-model-deployments'] })
    void queryClient.invalidateQueries({ queryKey: ['cfg-bindings'] })
    toast.success('部署已删除')
  }

  return (
    <>
      <CGroup
        extra={
          <button className="btn-ghost-sm" onClick={() => setDialog('create')}>
            <SIconPlus />
            登记模型
          </button>
        }
      >
        ② 模型部署
      </CGroup>
      <div className="tier-lead">
        供应商那边真实存在的模型名，以及用哪套线协议去调它。凭据卡上的「刷新模型」会把接口
        返回的模型自动登记进来，接口查不到的（不少中转站不返回生图模型）在这里手工补。
      </div>

      {deploymentsQuery.isPending && <LoadingCards count={2} height={72} />}
      {deploymentsQuery.isError && (
        <ErrorBlock
          message={`模型目录加载失败：${deploymentsQuery.error.message}`}
          onRetry={() => void deploymentsQuery.refetch()}
        />
      )}

      {deploymentsQuery.data !== undefined && (
        <>
          <div className="dep-bar">
            <input
              className="field-input dep-search"
              value={keyword}
              placeholder="搜模型名 / 适配器 / 凭据"
              onChange={(e) => setKeyword(e.target.value)}
            />
            <Picker
              size="sm"
              aria-label="按媒体能力筛选"
              value={media}
              onChange={setMedia}
              options={[
                { value: 'all', label: '全部能力' },
                ...MEDIA_OPTIONS.map(([value, label]) => ({ value, label })),
              ]}
            />
            <span className="dep-stats">
              {stats.enabled}/{stats.total} 条启用 · {stats.credentials} 家供应商
              {stats.unwired > 0 && ` · ${stats.unwired} 条待接入`}
            </span>
            {disabledCount > 0 && (
              <button
                className="btn-ghost-sm"
                aria-pressed={showDisabled}
                onClick={() => setShowDisabled((on) => !on)}
              >
                {showDisabled ? '收起已停用' : `显示已停用 ${disabledCount} 条`}
              </button>
            )}
          </div>

          {all.length === 0 && (
            <div className="st-note">
              还没有登记任何模型。到上一层的凭据卡片点「刷新模型」，或在这里手工登记一条。
            </div>
          )}
          {all.length > 0 && visible.length === 0 && (
            <div className="st-note">
              没有符合筛选条件的部署。
              {!showDisabled && disabledCount > 0 && `还有 ${disabledCount} 条已停用的没显示。`}
            </div>
          )}

          {groups.map((group) => (
            <div className="dep-group" key={group.credentialId}>
              <div className="dep-group-head">
                <span className="dep-group-name">{group.credentialName}</span>
                <span className="dep-group-count">
                  {group.enabledCount}/{group.rows.length} 条启用
                </span>
              </div>
              {group.rows.map((row) => (
                <DeploymentRow
                  key={row.id}
                  row={row}
                  plugins={plugins}
                  onEdit={() => setDialog(row)}
                  onDelete={() => void remove(row)}
                />
              ))}
            </div>
          ))}
        </>
      )}

      {dialog !== 'closed' && (
        <DeploymentDialog
          key={dialog === 'create' ? 'create' : dialog.id}
          existing={dialog === 'create' ? undefined : dialog}
          credentials={credentials}
          plugins={plugins}
          onClose={() => setDialog('closed')}
        />
      )}
    </>
  )
}
