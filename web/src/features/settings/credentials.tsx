/* 供应商凭据：卡片（已接入 / 可接入共用一种卡片语言）+ 添加/编辑 Dialog + 删除冲突流。

   两件事与旧版不同：
   - 「可接入的供应商」与「已配置的凭据」不再是两套视觉，同一张卡片用状态区分
     （未接入 / 正常 / 异常 / 已停用）。
   - 本机 CLI 类供应商的路径字段先探测再决定要不要露输入框，探测端点不可用时降级回手填。

   编辑时密码字段留空 = 不修改（PATCH 只发非空字段）；保存成功后自动跑一次连接测试，
   结果落在凭据卡片上，用户不必再自己判断该点「测试」还是「保存」。 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckIcon, CopyIcon } from '@/components/NexusIcon'
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { toast } from 'sonner'

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

import { apiConfig, parseCredDeleteConflict } from '../../lib/api-config'
import type {
  CredKind,
  Credential,
  CredTestResult,
  CredentialProbeRemedy,
  ProviderType,
} from '../../lib/api-config'
import {
  credCardState,
  groupCredFields,
  isProbeableType,
  mergeProbeFields,
  probeSummary,
  unmatchedRemedies,
} from './cred-form'
import type { CredFieldView } from './cred-form'
import { ProviderCatalog } from './ProviderCatalog'
import { clearTtsPrefetch } from '../../lib/audio'
import { OnboardingCard } from './OnboardingCard'
import { SIconEdit, SIconPlus } from './icons'
import { brandOf, capName, relTime, testErrorLabel } from './meta'
import { Switch } from './shared'

/** 三份凭据列表 + 绑定 + 部署 + 审计一起失效（跨区共享缓存键） */
export function useInvalidateConfig() {
  const qc = useQueryClient()
  return () => {
    clearTtsPrefetch()
    void qc.invalidateQueries({ queryKey: ['cfg-creds'] })
    void qc.invalidateQueries({ queryKey: ['cfg-bindings'] })
    void qc.invalidateQueries({ queryKey: ['cfg-model-deployments'] })
    void qc.invalidateQueries({ queryKey: ['cfg-audit'] })
    void qc.invalidateQueries({ queryKey: ['tts-voices'] })
    void qc.invalidateQueries({ queryKey: ['tts-voices-v2'] })
  }
}

/* ---- 一种卡片语言：已接入与可接入共用，状态只体现在色点与状态词上 ---- */

export function ProviderCard({
  brandKey,
  title,
  tone,
  state,
  meta,
  body,
  actions,
  muted = false,
  logoText,
}: {
  brandKey: string
  title: ReactNode
  tone: 'idle' | 'ok' | 'bad' | 'off' | 'new'
  state: string
  meta?: ReactNode
  body?: ReactNode
  actions?: ReactNode
  /** 停用态整卡压暗 */
  muted?: boolean
  /** 覆盖圆标里的缩写（实时语音卡用「实」） */
  logoText?: string
}) {
  const brand = brandOf(brandKey)
  return (
    <div className={`pcard pcard-${tone}${muted ? ' pcard-muted' : ''}`}>
      <span className="pcard-logo" style={{ background: brand.bg }}>
        {logoText ?? brand.abbr}
      </span>
      <div className="pcard-body">
        <div className="pcard-title">
          <span className="pcard-name">{title}</span>
          <span className="pcard-state">
            <span className="pcard-dot" />
            {state}
          </span>
        </div>
        {meta !== undefined && <div className="pcard-meta">{meta}</div>}
        {body}
      </div>
      {actions !== undefined && <div className="pcard-actions">{actions}</div>}
    </div>
  )
}

function ProbeResult({ result }: { result: CredTestResult }) {
  const diagnostics = [
    result.protocol !== null && result.protocol !== undefined
      ? `协议 ${result.protocol}`
      : null,
    result.detected_adapter_type !== null && result.detected_adapter_type !== undefined
      ? `Adapter ${result.detected_adapter_type}`
      : null,
    result.image_request_mode !== null && result.image_request_mode !== undefined
      ? `图片模式 ${result.image_request_mode}`
      : null,
    result.status_code !== null && result.status_code !== undefined
      ? `HTTP ${result.status_code}`
      : null,
    result.model_count !== null && result.model_count !== undefined
      ? `${result.model_count} 个模型`
      : null,
  ].filter((item): item is string => item !== null)
  return (
    <div className={`cred-probe-result ${result.ok ? 'ok' : 'err'}`}>
      <div className="cred-probe-summary">
        {result.ok
          ? `连接正常 · ${result.latency_ms ?? 0} ms · ${result.detail ?? ''}`
          : `${testErrorLabel(result.error_type)} · ${result.detail ?? ''}`}
      </div>
      {diagnostics.length > 0 && (
        <div className="cred-probe-diagnostics">
          {diagnostics.map((item) => <span key={item}>{item}</span>)}
        </div>
      )}
      {result.raw_preview !== null &&
        result.raw_preview !== undefined &&
        result.raw_preview !== '' && (
          <details className="cred-probe-raw">
            <summary>查看脱敏原始响应</summary>
            <pre>{result.raw_preview}</pre>
          </details>
        )}
    </div>
  )
}

const CLI_MANAGED_TYPES = new Set(['codex_cli', 'gemini_cli', 'jimeng_cli'])

function CliDialog({
  cred,
  open,
  onOpenChange,
}: {
  cred: Credential
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [helpCommand, setHelpCommand] = useState('')
  const statusMut = useMutation({ mutationFn: () => apiConfig.cliStatus(cred.id) })
  const helpMut = useMutation({ mutationFn: () => apiConfig.cliHelp(cred.id, helpCommand) })
  const loginMut = useMutation({ mutationFn: () => apiConfig.cliLogin(cred.id) })
  const loginStatusMut = useMutation({ mutationFn: () => apiConfig.cliLoginStatus(cred.id) })
  const logoutMut = useMutation({
    mutationFn: () => apiConfig.cliLogout(cred.id),
    onSuccess: () => {
      toast.success('已退出即梦 CLI')
      statusMut.reset()
      loginMut.reset()
      loginStatusMut.reset()
    },
  })
  const login = loginStatusMut.data ?? loginMut.data
  const error =
    statusMut.error ?? helpMut.error ?? loginMut.error ?? loginStatusMut.error ?? logoutMut.error

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{cred.name} · CLI 管理</DialogTitle></DialogHeader>
        <div className="form-stack">
          <div className="form-actions">
            <button
              className="btn btn-primary btn-sm"
              disabled={statusMut.isPending}
              onClick={() => statusMut.mutate()}
            >
              {statusMut.isPending ? '检测中…' : '检测版本/状态'}
            </button>
          </div>
          {statusMut.data !== undefined && (
            <pre className="cred-cli-output">
              {JSON.stringify(statusMut.data, null, 2)}
            </pre>
          )}
          <label className="form-field">
            <span>安全帮助命令（留空表示根帮助）</span>
            <input
              value={helpCommand}
              maxLength={64}
              placeholder="text2image / exec / models"
              onChange={(event) => setHelpCommand(event.target.value)}
            />
          </label>
          <button
            className="btn-ghost-sm"
            disabled={helpMut.isPending}
            onClick={() => helpMut.mutate()}
          >
            {helpMut.isPending ? '读取中…' : '读取 --help'}
          </button>
          {helpMut.data !== undefined && <pre className="cred-cli-output">{helpMut.data.text}</pre>}
          {cred.provider_type === 'jimeng_cli' && (
            <>
              <div className="form-actions">
                <button
                  className="btn btn-primary btn-sm"
                  disabled={loginMut.isPending}
                  onClick={() => loginMut.mutate()}
                >
                  {loginMut.isPending ? '启动中…' : '启动扫码登录'}
                </button>
                <button
                  className="btn-ghost-sm"
                  disabled={loginStatusMut.isPending}
                  onClick={() => loginStatusMut.mutate()}
                >
                  {loginStatusMut.isPending ? '检查中…' : '刷新登录状态'}
                </button>
                <button
                  className="btn-ghost-sm"
                  disabled={logoutMut.isPending}
                  onClick={() => logoutMut.mutate()}
                >
                  {logoutMut.isPending ? '退出中…' : '退出登录'}
                </button>
              </div>
              {login?.qr_url.startsWith('data:image/') && (
                <img className="cred-cli-qr" src={login.qr_url} alt="即梦登录二维码" />
              )}
              {login?.qr_url !== undefined &&
                login.qr_url !== '' &&
                !login.qr_url.startsWith('data:image/') && (
                  <a href={login.qr_url} target="_blank" rel="noreferrer">打开即梦登录链接</a>
                )}
              {login !== undefined && <pre className="cred-cli-output">{login.text}</pre>}
            </>
          )}
          {error !== null && <div className="cred-err">{error.message}</div>}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function CredCard({
  cred,
  unitLabel,
  refreshLabel,
  showTest = true,
  onEdit,
}: {
  cred: Credential
  /** 缓存计数单位：模型 / 音色 */
  unitLabel: string
  refreshLabel: string
  showTest?: boolean
  onEdit: () => void
}) {
  const invalidate = useInvalidateConfig()
  const [cliOpen, setCliOpen] = useState(false)
  const [catalogOpen, setCatalogOpen] = useState(false)

  const testMut = useMutation({
    mutationFn: () => apiConfig.testCredential(cred.id),
    onSuccess: (result) => {
      invalidate()
      if (result.ok) toast.success(result.detail || `「${cred.name}」测试通过`)
    },
  })
  const toggleMut = useMutation({
    mutationFn: (enabled: boolean) => apiConfig.updateCredential(cred.id, { enabled }),
    onSuccess: invalidate,
  })
  const assetTestMut = useMutation({
    mutationFn: () => apiConfig.testVolcengineAssets(cred.id),
    onSuccess: (result) => toast.success(result.detail),
  })

  const state = credCardState(cred)
  const maskedParts = Object.values(cred.masked ?? {}).filter((v) => v !== '')
  const detail = cred.status_detail ?? ''

  return (
    <>
      <ProviderCard
        brandKey={cred.provider_type}
        title={cred.name}
        tone={state.tone}
        muted={!cred.enabled}
        state={
          state.tone === 'ok' && detail !== '' ? `${state.label} · ${detail}` : state.label
        }
        meta={
          <>
            {maskedParts.length > 0 && <code>{maskedParts.join(' · ')}</code>}
            <span>
              {cred.models_count} 个{unitLabel}
            </span>
            <span>{relTime(cred.models_refreshed_at)}</span>
          </>
        }
        body={
          <>
            {state.tone === 'bad' && detail !== '' && <div className="cred-err">{detail}</div>}
            {testMut.isError && (
              <div className="cred-err">测试请求失败：{testMut.error.message}</div>
            )}
            {testMut.data !== undefined && <ProbeResult result={testMut.data} />}
            {assetTestMut.isError && (
              <div className="cred-err">素材库测试失败：{assetTestMut.error.message}</div>
            )}
            {assetTestMut.data !== undefined && (
              <div className="cred-probe-result ok">
                <div className="cred-probe-summary">Ark 素材库签名可用</div>
                <div className="cred-probe-diagnostics">
                  <span>{assetTestMut.data.project_name}</span>
                  <span>{assetTestMut.data.region}</span>
                  <span>{assetTestMut.data.group_count} 个素材组</span>
                </div>
              </div>
            )}
          </>
        }
        actions={
          <>
            {CLI_MANAGED_TYPES.has(cred.provider_type) && (
              <button className="btn-ghost-sm" onClick={() => setCliOpen(true)}>
                CLI
              </button>
            )}
            <button
              className="btn-ghost-sm"
              onClick={() => setCatalogOpen(true)}
            >
              {refreshLabel.includes('音色') ? '浏览音色' : '浏览模型'}
            </button>
            {showTest && (
              <button
                className="btn-ghost-sm"
                disabled={testMut.isPending}
                onClick={() => testMut.mutate()}
              >
                {testMut.isPending ? '测试中…' : '测试'}
              </button>
            )}
            {cred.provider_type === 'volcengine_video' && (
              <button
                className="btn-ghost-sm"
                disabled={assetTestMut.isPending}
                onClick={() => assetTestMut.mutate()}
              >
                {assetTestMut.isPending ? '签名中…' : '测试素材库'}
              </button>
            )}
            <button className="icon-btn" title="编辑" onClick={onEdit}>
              <SIconEdit />
            </button>
            <Switch
              on={cred.enabled}
              disabled={toggleMut.isPending}
              title={cred.enabled ? '停用' : '启用'}
              onChange={(next) => toggleMut.mutate(next)}
            />
          </>
        }
      />
      {CLI_MANAGED_TYPES.has(cred.provider_type) && (
        <CliDialog cred={cred} open={cliOpen} onOpenChange={setCliOpen} />
      )}
      {catalogOpen && <ProviderCatalog credential={cred} onClose={() => setCatalogOpen(false)} />}
    </>
  )
}

export function AddCredButton({ text, onClick }: { text: string; onClick: () => void }) {
  return (
    <button className="add-cred" onClick={onClick}>
      <SIconPlus />
      {text}
    </button>
  )
}

/** 还没接入的供应商：与已接入凭据同一种卡片，状态是「未接入」 */
export function RecommendedProviderCards({
  types,
  onSelect,
  /** 已经接过的类型不再重复推荐 */
  configuredTypes,
}: {
  types: ProviderType[]
  onSelect: (providerType: string) => void
  configuredTypes?: ReadonlySet<string>
}) {
  const recommended = types.filter(
    (type) =>
      type.recommendation != null && configuredTypes?.has(type.provider_type) !== true,
  )
  if (recommended.length === 0) return null
  return (
    <div className="pcard-list">
      {recommended.map((type) => {
        const recommendation = type.recommendation!
        return (
          <ProviderCard
            key={type.provider_type}
            brandKey={type.provider_type}
            tone="new"
            state="未接入"
            title={
              <>
                {type.label}
                <span className="pcard-badge">{recommendation.badge}</span>
              </>
            }
            meta={<span>{recommendation.summary}</span>}
            actions={
              <>
                {type.onboarding?.home !== undefined && type.onboarding.home !== '' && (
                  <a
                    className="btn-ghost-sm"
                    href={type.onboarding.home}
                    target="_blank"
                    rel="noreferrer"
                  >
                    官方页面
                  </a>
                )}
                <button
                  className="btn btn-outline btn-sm"
                  onClick={() => onSelect(type.provider_type)}
                >
                  接入
                </button>
              </>
            }
          />
        )
      })}
    </div>
  )
}

/* ---- 本机探测面板与字段渲染 ---- */

function CopyableCommand({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="cli-copy"
      title="复制命令"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1600)
          })
          .catch(() => toast.error('复制失败，请手动选中'))
      }}
    >
      <code>{text}</code>
      {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
    </button>
  )
}

function RemedyLine({ remedy }: { remedy: CredentialProbeRemedy }) {
  return (
    <div className="cli-remedy">
      <span className="cli-remedy-problem">{remedy.problem}</span>
      <CopyableCommand text={remedy.howto} />
    </div>
  )
}

function CredFieldRow({
  view,
  value,
  masked,
  onChange,
  onManual,
  onAuto,
}: {
  view: CredFieldView
  value: string
  /** 编辑既有凭据时密文字段的掩码，占位显示 */
  masked: string | null
  onChange: (next: string) => void
  onManual: () => void
  onAuto: () => void
}) {
  const inputId = `cred-f-${view.name}`
  if (view.mode === 'detected' && view.detected !== null) {
    return (
      <div className="field cli-field">
        <span className="cli-field-label">{view.label}</span>
        <div className="cli-found">
          <span className="cli-ok">✓ 已找到</span>
          <code>{view.detected}</code>
          {view.sourceLabel !== null && <span className="cli-src">{view.sourceLabel}</span>}
          <button type="button" className="btn-ghost-sm" onClick={onManual}>
            手动指定
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className="field">
      <label htmlFor={inputId}>
        {view.label}
        {!view.required && view.detected === null && !view.missing && (
          <span className="field-note">（留空用默认）</span>
        )}
        {masked !== null && <span className="field-note">（留空不修改）</span>}
      </label>
      {view.missing && (
        <div className="cli-missing">
          <span className="cli-bad">✗ 本机没找到</span>
          {view.remedy !== null ? (
            <CopyableCommand text={view.remedy.howto} />
          ) : (
            <span className="cli-src">装好后重开这个窗口会自动认出来，也可以在下面写死路径</span>
          )}
        </div>
      )}
      <input
        id={inputId}
        className="field-input"
        type={view.type === 'password' ? 'password' : 'text'}
        autoComplete="off"
        placeholder={masked ?? view.detected ?? view.placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {view.detected !== null && (
        <button type="button" className="btn-ghost-sm cli-restore" onClick={onAuto}>
          恢复自动（{view.detected}）
        </button>
      )}
    </div>
  )
}

/* ---- 添加 / 编辑覆盖层 ---- */

export function CredOverlay({
  kind,
  types,
  existing,
  initialProviderType,
  onClose,
}: {
  kind: CredKind
  /** 已按 kind 过滤的类型 schema（provider-types 加载失败时为空数组） */
  types: ProviderType[]
  existing?: Credential
  initialProviderType?: string
  onClose: () => void
}) {
  const invalidate = useInvalidateConfig()
  const initialType = types.find((type) => type.provider_type === initialProviderType)
  const [typeKey, setTypeKey] = useState<string | null>(
    existing?.provider_type ?? initialType?.provider_type ?? null,
  )
  const [name, setName] = useState(existing?.name ?? initialType?.label ?? '')
  const [values, setValues] = useState<Record<string, string>>({})
  const [manualKeys, setManualKeys] = useState<ReadonlySet<string>>(new Set())
  const [formError, setFormError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [conflictCaps, setConflictCaps] = useState<string[] | null>(null)

  const pt = types.find((t) => t.provider_type === typeKey)
  const cliType = isProbeableType(pt)

  /* 表单一打开就探测；端点未就绪（404）不重试，直接降级回手填 */
  const probeQuery = useQuery({
    queryKey: ['cfg-cred-probe', pt?.provider_type ?? ''],
    queryFn: () => apiConfig.credentialProbeReport(pt!.provider_type),
    enabled: cliType,
    retry: false,
    staleTime: 30_000,
  })
  const report = cliType ? probeQuery.data ?? null : null
  const summary = probeSummary(report, {
    loading: cliType && probeQuery.isPending,
    failed: cliType && probeQuery.isError,
  })

  const fieldViews = mergeProbeFields(pt?.fields ?? [], report, manualKeys, values)
  const groups = groupCredFields(fieldViews)
  const leftoverRemedies = unmatchedRemedies(fieldViews, report?.remediation)

  /* 探测到并被采纳的字段不必再提交：服务端自己也能探到，写死反而会在换机器后失效 */
  const draftConfig = () => {
    const config: Record<string, string> = {}
    for (const view of fieldViews) {
      if (view.mode === 'detected') continue
      const value = (values[view.name] ?? '').trim()
      if (existing === undefined || value !== '') config[view.name] = value
    }
    return config
  }

  /** 保存成功后自动跑一次连接测试，结果落到凭据卡片上 */
  const autoTest = (id: number, label: string) => {
    apiConfig
      .testCredential(id)
      .then((result) => {
        invalidate()
        if (result.ok) toast.success(`「${label}」连接正常${result.detail ? ` · ${result.detail}` : ''}`)
        else toast.warning(`「${label}」已保存，但连接没通过：${testErrorLabel(result.error_type)}`)
      })
      .catch(() => invalidate())
  }

  const saveMut = useMutation({
    mutationFn: () => {
      const config = draftConfig()
      if (existing !== undefined) {
        return apiConfig.updateCredential(existing.id, { name: name.trim(), config })
      }
      if (pt === undefined) throw new Error('请先选择供应商类型')
      if (pt.kind !== kind && !pt.compatible_kinds?.includes(kind)) {
        throw new Error(`当前供应商不支持 ${kind} 能力`)
      }
      return apiConfig.createCredential({
        name: name.trim(),
        kind: pt.kind,
        provider_type: pt.provider_type,
        config,
      })
    },
    onSuccess: (saved) => {
      invalidate()
      toast.success(existing !== undefined ? '凭据已更新，正在测试连接…' : '凭据已添加，正在测试连接…')
      autoTest(saved.id, saved.name)
      onClose()
    },
    onError: (err) => setFormError(err instanceof Error ? err.message : '保存失败'),
  })

  const probeMut = useMutation({
    mutationFn: () => {
      if (pt === undefined) throw new Error('请先选择供应商类型')
      return apiConfig.probeCredential({
        provider_type: pt.provider_type,
        credential_id: existing?.id,
        config: draftConfig(),
      })
    },
  })

  const delMut = useMutation({
    mutationFn: (force: boolean) => apiConfig.deleteCredential(existing!.id, force),
    onSuccess: () => {
      invalidate()
      toast.success('凭据已删除')
      onClose()
    },
    onError: (err) => {
      const caps = parseCredDeleteConflict(err)
      if (caps !== null) setConflictCaps(caps)
      else setFormError(err instanceof Error ? err.message : '删除失败')
    },
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setFormError(null)
    if (name.trim() === '') {
      setFormError('请填写凭据名称')
      return
    }
    if (existing === undefined) {
      for (const view of fieldViews) {
        if (view.mode === 'detected') continue
        if (view.required && (values[view.name] ?? '').trim() === '') {
          setFormError(`请填写 ${view.label}`)
          return
        }
      }
    }
    saveMut.mutate()
  }

  const title = existing !== undefined ? `编辑「${existing.name}」` : '接入供应商'

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[86vh] gap-3.5 overflow-y-auto bg-card p-5 sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="text-[15px]">{title}</DialogTitle>
        </DialogHeader>

        {/* 第一步：类型选择（provider-types 驱动） */}
        {existing === undefined && pt === undefined && (
          <div className="ptype-list">
            {types.length === 0 && (
              <div className="st-note">供应商类型列表不可用（后端未就绪或加载失败）</div>
            )}
            {types.map((t) => {
              const brand = brandOf(t.provider_type)
              return (
                <button
                  key={t.provider_type}
                  className="ptype"
                  onClick={() => setTypeKey(t.provider_type)}
                >
                  <span className="pcard-logo" style={{ background: brand.bg }}>
                    {brand.abbr}
                  </span>
                  <span className="ptype-info">
                    <b>
                      {t.label}
                      {isProbeableType(t) && (
                        <span className="ptype-guided" title="用本机已装的命令行工具与登录态，打开表单会自动探测">
                          本机自动探测
                        </span>
                      )}
                      {t.onboarding !== null && t.onboarding !== undefined && (
                        <span className="ptype-guided" title="选中后有分步授权引导，每步都能直接跳官方页面">
                          有引导
                        </span>
                      )}
                    </b>
                    {t.notes !== null && t.notes !== undefined && t.notes !== '' && (
                      <span className="ptype-notes">{t.notes}</span>
                    )}
                  </span>
                </button>
              )
            })}
          </div>
        )}

        {/* 第二步：schema 动态表单 */}
        {(existing !== undefined || pt !== undefined) && (
          <form className="cred-form" onSubmit={submit}>
            {existing === undefined && pt !== undefined && (
              <div className="cred-form-type">
                <span className="chip accent">{pt.label}</span>
                <button
                  type="button"
                  className="btn-ghost-sm"
                  onClick={() => {
                    probeMut.reset()
                    setTypeKey(null)
                  }}
                >
                  换类型
                </button>
              </div>
            )}

            {cliType && (
              <div className={`cli-probe cli-probe-${summary.tone}`}>
                <div className="cli-probe-head">
                  <span className="cli-probe-title">本机环境</span>
                  <span className="cli-probe-summary">{summary.text}</span>
                  <button
                    type="button"
                    className="btn-ghost-sm"
                    disabled={probeQuery.isFetching}
                    onClick={() => void probeQuery.refetch()}
                  >
                    {probeQuery.isFetching ? '探测中…' : '重新探测'}
                  </button>
                </div>
                {leftoverRemedies.map((remedy) => (
                  <RemedyLine key={remedy.problem} remedy={remedy} />
                ))}
              </div>
            )}

            <div className="field">
              <label htmlFor="cred-name">凭据名称</label>
              <input
                id="cred-name"
                className="field-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={pt?.label ?? ''}
              />
              <div className="field-hint">自定义，只用来在列表里区分同一家的多套凭据。</div>
            </div>

            {groups.map((group) => (
              <section className="cred-group" key={group.key}>
                <div className="cred-group-head">
                  <span className="cred-group-label">{group.label}</span>
                  <span className="cred-group-desc">{group.desc}</span>
                </div>
                {group.fields.map((view) => (
                  <CredFieldRow
                    key={view.name}
                    view={view}
                    value={values[view.name] ?? ''}
                    masked={
                      existing !== undefined && view.type === 'password'
                        ? credMasked(existing, view.name)
                        : null
                    }
                    onChange={(next) => setValues((v) => ({ ...v, [view.name]: next }))}
                    onManual={() =>
                      setManualKeys((keys) => new Set(keys).add(view.name))
                    }
                    onAuto={() => {
                      setManualKeys((keys) => {
                        const next = new Set(keys)
                        next.delete(view.name)
                        return next
                      })
                      setValues((v) => ({ ...v, [view.name]: '' }))
                    }}
                  />
                ))}
              </section>
            ))}

            {existing !== undefined && pt === undefined && (
              <div className="st-note">
                类型 schema 不可用，仅支持改名与启停；密钥修改请等后端就绪后重试
              </div>
            )}
            {pt?.notes !== null && pt?.notes !== undefined && pt.notes !== '' && (
              <div className="field-hint">{pt.notes}</div>
            )}
            {pt?.onboarding !== null && pt?.onboarding !== undefined && (
              <OnboardingCard
                guide={pt.onboarding}
                fieldNames={(pt.fields ?? []).map((f) => f.name)}
              />
            )}

            {probeMut.isError && (
              <div className="form-err">测试失败：{probeMut.error.message}</div>
            )}
            {probeMut.data !== undefined && <ProbeResult result={probeMut.data} />}

            {formError !== null && <div className="form-err">{formError}</div>}

            {/* 删除流：确认 → 409 冲突展示受影响能力 → 强删 */}
            {conflictCaps !== null && (
              <div className="del-conflict">
                <b>该凭据仍被以下能力绑定引用：</b>
                <div className="del-caps">
                  {conflictCaps.length === 0 && <span className="chip warn">存在绑定引用</span>}
                  {conflictCaps.map((c) => (
                    <span key={c} className="chip warn">
                      {capName(c)}
                    </span>
                  ))}
                </div>
                <span>强制删除会把这些绑定置为未绑定，相应功能将不可用。</span>
              </div>
            )}

            {/* 主次分明：保存是主动作，测试是保存后自动跑的，这里只留一个"先看看"的次要入口 */}
            <div className="overlay-foot foot-split">
              {existing !== undefined && !deleting && conflictCaps === null && (
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => setDeleting(true)}
                >
                  删除凭据
                </button>
              )}
              {existing !== undefined && deleting && conflictCaps === null && (
                <>
                  <button
                    type="button"
                    className={`btn btn-danger-solid${delMut.isPending ? ' loading' : ''}`}
                    disabled={delMut.isPending}
                    onClick={() => delMut.mutate(false)}
                  >
                    {delMut.isPending && <span className="spinner" />}
                    确认删除
                  </button>
                  <button type="button" className="btn" onClick={() => setDeleting(false)}>
                    再想想
                  </button>
                </>
              )}
              {conflictCaps !== null && (
                <button
                  type="button"
                  className={`btn btn-danger-solid${delMut.isPending ? ' loading' : ''}`}
                  disabled={delMut.isPending}
                  onClick={() => delMut.mutate(true)}
                >
                  {delMut.isPending && <span className="spinner" />}
                  仍要强制删除
                </button>
              )}
              <span className="spacer" />
              {pt !== undefined && (
                <button
                  type="button"
                  className="btn-ghost-sm"
                  disabled={probeMut.isPending}
                  onClick={() => probeMut.mutate()}
                >
                  {probeMut.isPending ? '测试中…' : '先测一下'}
                </button>
              )}
              <button type="button" className="btn" onClick={onClose}>
                取消
              </button>
              <button
                type="submit"
                className={`btn btn-primary${saveMut.isPending ? ' loading' : ''}`}
                disabled={saveMut.isPending}
              >
                {saveMut.isPending && <span className="spinner" />}
                保存并测试
              </button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

function credMasked(cred: Credential, field: string): string | null {
  const v = cred.masked?.[field]
  return typeof v === 'string' && v !== '' ? v : null
}
