/* 通用能力绑定表（配置三层里的第三层）。数据全部来自服务端：/config/bindings 给每个能力的
   元数据、当前绑定、就绪插件与可选部署，/config/model-plugins 给 adapter 名，
   /config/bindings/legacy 标出还没指到已登记部署的能力。
   设置页四个分区各渲染自己的分组，同一批 Binding 只在这里编辑。

   可选部署只列「适配器已为该操作接线」的那些：没接线的部署选了也调不通，
   与其让用户选完再报错，不如根本不出现在下拉里。 */

import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Picker } from '@/components/ui/picker'
import { VoicePicker } from '@/components/VoicePicker'
import { RatePicker } from '@/components/RatePicker'
import { ModelPicker, defaultModelOf } from '@/components/model-picker/ModelPicker'
import { DEFAULT_LLM_CAPABILITY } from '@/components/model-picker/groupModels'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

import { apiConfig, ttsVoicesOf } from '../../lib/api-config'
import { apiImage } from '../../lib/api-image'
import type {
  Binding,
  CapabilityGroup,
  Credential,
  FallbackEntry,
  LegacyBindingItem,
  LlmProbeResult,
  ModelDeployment,
  ModelPlugin,
  PutBindingBody,
} from '../../lib/api-config'
import { ServiceProbeButton } from './ServiceProbeButton'
import { VoiceProbeButton } from './VoiceProbeButton'
import { useInvalidateConfig } from './credentials'
import { SIconArrowDown, SIconArrowUp, SIconChevronDown } from './icons'
import {
  fmtMs,
  rememberCapLabels,
  testErrorLabel,
} from './meta'
import type { SelGroup } from './shared'
import { CGroup, ErrorBlock, LoadingCards, Sel, Switch } from './shared'

/* ====================== 纯逻辑（单测覆盖） ====================== */

export const GROUP_LABELS: Record<CapabilityGroup, string> = {
  llm: 'LLM 能力',
  image: '生图能力',
  voice: '朗读场景',
  realtime: '实时语音',
  translate: '翻译链',
}

export const LEGACY_REASONS: Record<string, string> = {
  unbound: '还没绑定任何部署',
  no_deployment: '绑定没挂部署，只留了模型名',
  // 判据已泛化成「adapter 没有插件认领」：不只网关，任何掉了插件的历史部署都会标出来
  stale_deployment: '还指着一条 adapter 已无插件的历史部署，调用会失败，改绑一条直连部署',
}

export interface AdapterInfo {
  adapterName: string
}

export interface DeploymentChoice extends AdapterInfo {
  deployment: ModelDeployment
}

export function adapterOf(adapterType: string, plugins: ModelPlugin[]): AdapterInfo {
  const plugin = plugins.find((item) => item.id === adapterType)
  return { adapterName: plugin?.name ?? adapterType }
}

function compareText(a: string | null | undefined, b: string | null | undefined): number {
  return (a ?? '').localeCompare(b ?? '', 'zh-Hans-CN')
}

/** 该能力可选的部署：启用、媒体类型匹配、adapter 对该操作已接线。
    排序按凭据 → 模型名 → 部署自身次序，同一批数据每次渲染顺序都一样 */
export function deploymentChoices(
  row: Pick<Binding, 'media_type' | 'operation'>,
  deployments: ModelDeployment[],
  plugins: ModelPlugin[],
): DeploymentChoice[] {
  const media = row.media_type ?? null
  const operation = row.operation ?? null
  if (media === null || operation === null) return []
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]))
  const out: DeploymentChoice[] = []
  for (const deployment of deployments) {
    if (!deployment.enabled || !deployment.media_types.includes(media)) continue
    const plugin = byId.get(deployment.adapter_type)
    if (plugin === undefined || !plugin.ready_operations.includes(operation)) continue
    out.push({ deployment, adapterName: plugin.name })
  }
  out.sort(
    (a, b) =>
      compareText(a.deployment.credential_name, b.deployment.credential_name) ||
      a.deployment.credential_id - b.deployment.credential_id ||
      compareText(a.deployment.upstream_model_id, b.deployment.upstream_model_id) ||
      a.deployment.sort - b.deployment.sort ||
      a.deployment.id - b.deployment.id,
  )
  return out
}

/** 按凭据 + 模型名找部署（手输模型名时用） */
export function preferredChoice(
  choices: DeploymentChoice[],
  credentialId: number | null,
  model: string,
): DeploymentChoice | undefined {
  if (credentialId === null) return undefined
  return choices.find(
    (choice) =>
      choice.deployment.credential_id === credentialId &&
      choice.deployment.upstream_model_id === model,
  )
}

export function fallbackOf(choice: DeploymentChoice): FallbackEntry {
  return {
    deployment_id: choice.deployment.id,
    credential_id: choice.deployment.credential_id,
    target: choice.deployment.upstream_model_id,
  }
}

export function sameFallback(a: FallbackEntry, b: FallbackEntry): boolean {
  const aId = a.deployment_id ?? null
  const bId = b.deployment_id ?? null
  if (aId !== null && bId !== null) return aId === bId
  return a.credential_id === b.credential_id && a.target === b.target
}

/** 上移 / 下移一项；越界原样返回 */
export function moveEntry<T>(list: T[], index: number, delta: -1 | 1): T[] {
  const to = index + delta
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return list
  const next = [...list]
  ;[next[index], next[to]] = [next[to], next[index]]
  return next
}

export function removeEntry<T>(list: T[], index: number): T[] {
  return list.filter((_, i) => i !== index)
}

/** 追加一条降级；同一部署（或同凭据同模型）已在链里就不重复 */
export function appendFallback(list: FallbackEntry[], entry: FallbackEntry): FallbackEntry[] {
  return list.some((item) => sameFallback(item, entry)) ? list : [...list, entry]
}

/** fallback 项对应的部署选择（先按 deployment_id，再按凭据 + 模型名取直连） */
export function choiceOfFallback(
  entry: FallbackEntry,
  choices: DeploymentChoice[],
): DeploymentChoice | undefined {
  const byId =
    entry.deployment_id !== null && entry.deployment_id !== undefined
      ? choices.find((choice) => choice.deployment.id === entry.deployment_id)
      : undefined
  return byId ?? preferredChoice(choices, entry.credential_id, entry.target)
}

export interface ProbeView {
  tone: 'ok' | 'warn' | 'none'
  text: string
  title?: string
}

function truncSample(s: string): string {
  return s.length > 14 ? `${s.slice(0, 14)}…` : s
}

/** 测一下的结果 → 一枚 chip 的文案：成功带 plugin/model/耗时/样例，失败带分类与路由 */
export function describeProbe(
  result: LlmProbeResult | undefined,
  requestFailed = false,
): ProbeView {
  if (requestFailed) return { tone: 'warn', text: '测试请求失败' }
  if (result === undefined) return { tone: 'none', text: '' }
  const route = [result.plugin_id, result.model]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(' / ')
  if (result.ok) {
    const sample = result.sample ?? ''
    return {
      tone: 'ok',
      text: `✓ ${fmtMs(result.latency_ms)} · ${route}${
        sample !== '' ? ` · “${truncSample(sample)}”` : ''
      }`,
      title: sample !== '' ? sample : undefined,
    }
  }
  return {
    tone: 'warn',
    text: `${testErrorLabel(result.error_type)}${route !== '' ? ` · ${route}` : ''}`,
    title: result.error ?? undefined,
  }
}

export function rowsForGroups(
  bindings: Binding[],
  groups: CapabilityGroup[],
): Array<{ group: CapabilityGroup; rows: Binding[] }> {
  return groups.map((group) => ({
    group,
    rows: bindings.filter((row) => row.group === group),
  }))
}

/* ---- 翻译链：引擎元数据与 params.chain 解析 ---- */

export const ENGINES: Record<string, { name: string; desc: string }> = {
  llm: { name: 'AI 翻译（LLM）', desc: '走「快速翻译」能力绑定的模型，质量高、语气自然' },
  google: { name: 'Google 翻译', desc: '免费机翻，速度快，适合兜底' },
  bing: { name: 'Bing 翻译', desc: 'translators 库该端点当前不稳定，仅作最后兜底' },
}

export interface ChainRow {
  engine: string
  enabled: boolean
}

const DEFAULT_CHAIN: ChainRow[] = [
  { engine: 'llm', enabled: true },
  { engine: 'google', enabled: true },
  { engine: 'bing', enabled: false },
]

/** 后端 params.chain（字符串数组或 {engine,enabled} 数组）解析为完整三行 */
export function parseChain(params: Record<string, unknown> | null | undefined): ChainRow[] {
  const raw = params?.chain
  const rows: ChainRow[] = []
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string') {
        if (ENGINES[item] !== undefined && !rows.some((r) => r.engine === item)) {
          rows.push({ engine: item, enabled: true })
        }
      } else if (item !== null && typeof item === 'object') {
        const r = item as Record<string, unknown>
        if (
          typeof r.engine === 'string' &&
          ENGINES[r.engine] !== undefined &&
          !rows.some((x) => x.engine === r.engine)
        ) {
          rows.push({ engine: r.engine, enabled: r.enabled !== false })
        }
      }
    }
  }
  if (rows.length === 0) return DEFAULT_CHAIN.map((r) => ({ ...r }))
  for (const key of Object.keys(ENGINES)) {
    if (!rows.some((r) => r.engine === key)) rows.push({ engine: key, enabled: false })
  }
  return rows
}

/* ====================== 组件 ====================== */

function AdapterBadge({ info }: { info: AdapterInfo }) {
  return <span className="bt-adapter">{info.adapterName}</span>
}

function choiceLabel(choice: DeploymentChoice): string {
  const d = choice.deployment
  return `${d.display_name || d.upstream_model_id} · ${d.credential_name ?? `凭据 #${d.credential_id}`}`
}

/** 部署下拉：按凭据分组，每行 模型名 + adapter 提示 */
function choiceGroups(
  choices: DeploymentChoice[],
  activeId: number | null,
  onPick: (choice: DeploymentChoice) => void,
  exclude: Set<number> = new Set(),
): SelGroup[] {
  const groups = new Map<string, SelGroup>()
  for (const choice of choices) {
    const d = choice.deployment
    if (exclude.has(d.id)) continue
    const label = d.credential_name ?? `凭据 #${d.credential_id}`
    let group = groups.get(label)
    if (group === undefined) {
      group = { label, items: [] }
      groups.set(label, group)
    }
    group.items.push({
      key: String(d.id),
      label: (
        <>
          {d.display_name || d.upstream_model_id}
          <span className="sel-hint">{choice.adapterName}</span>
        </>
      ),
      text: `${d.upstream_model_id} ${d.display_name ?? ''} ${label} ${choice.adapterName}`,
      active: d.id === activeId,
      onSelect: () => onPick(choice),
    })
  }
  return [...groups.values()]
}

/* ---- 高级参数 Popover：temperature / reasoning_effort / max_tokens ---- */

function AdvParamsForm({
  row,
  onSave,
  onClose,
}: {
  row: Binding
  onSave: (params: Record<string, unknown> | null) => void
  onClose: () => void
}) {
  const p = row.params ?? {}
  const [temperature, setTemperature] = useState(
    typeof p.temperature === 'number' ? String(p.temperature) : '',
  )
  const [effort, setEffort] = useState(
    typeof p.reasoning_effort === 'string' ? p.reasoning_effort : '',
  )
  const [maxTokens, setMaxTokens] = useState(
    typeof p.max_tokens === 'number' ? String(p.max_tokens) : '',
  )
  const [err, setErr] = useState<string | null>(null)

  const save = () => {
    const next: Record<string, unknown> = { ...p }
    if (temperature.trim() === '') {
      delete next.temperature
    } else {
      const t = Number(temperature)
      if (!Number.isFinite(t) || t < 0 || t > 2) {
        setErr('temperature 需为 0-2 的数字')
        return
      }
      next.temperature = t
    }
    if (maxTokens.trim() === '') {
      delete next.max_tokens
    } else {
      const n = Number(maxTokens)
      if (!Number.isInteger(n) || n <= 0) {
        setErr('max_tokens 需为正整数')
        return
      }
      next.max_tokens = n
    }
    if (effort === '') delete next.reasoning_effort
    else next.reasoning_effort = effort
    onSave(Object.keys(next).length === 0 ? null : next)
    onClose()
  }

  return (
    <div className="adv-pop">
      <div className="overlay-title">高级参数 · {row.label}</div>
      <div className="form-row">
        <div className="field">
          <label htmlFor={`adv-temp-${row.capability}`}>temperature（留空用默认）</label>
          <input
            id={`adv-temp-${row.capability}`}
            className="field-input"
            inputMode="decimal"
            placeholder="0.3"
            value={temperature}
            onChange={(e) => setTemperature(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`adv-effort-${row.capability}`}>reasoning_effort</label>
          <Picker
            className="field-select"
            value={effort === '' ? 'default' : effort}
            onChange={(v) => setEffort(v === 'default' ? '' : v)}
            options={[
              /* 'default' 而不是空串：Radix Select 拿空串表示"清空" */
              { value: 'default', label: '默认（不传）' },
              { value: 'low', label: 'low' },
              { value: 'medium', label: 'medium' },
              { value: 'high', label: 'high' },
            ]}
          />
        </div>
      </div>
      <div className="field">
        <label htmlFor={`adv-max-${row.capability}`}>max_tokens（留空用默认）</label>
        <input
          id={`adv-max-${row.capability}`}
          className="field-input"
          inputMode="numeric"
          placeholder="4096"
          value={maxTokens}
          onChange={(e) => setMaxTokens(e.target.value)}
        />
      </div>
      <div className="field-hint">
        按 Provider 白名单注入：模型不支持某个参数时供应商会直接拒绝，留空最稳妥
      </div>
      {err !== null && <div className="form-err">{err}</div>}
      <div className="overlay-foot">
        <button className="btn" onClick={onClose}>
          取消
        </button>
        <button className="btn btn-primary" onClick={save}>
          保存
        </button>
      </div>
    </div>
  )
}

/* ---- 模型能力行（LLM / 生图）：选部署 · 参数 · 测一下 · 降级链 · legacy 标记 ---- */

function useBindingPut(row: Binding, onSaved?: () => void) {
  const invalidate = useInvalidateConfig()
  const mutation = useMutation({
    mutationFn: (body: PutBindingBody) => apiConfig.putBinding(row.capability, body),
    onSuccess: () => {
      invalidate()
      onSaved?.()
    },
  })
  const put = (partial: Partial<PutBindingBody>) =>
    mutation.mutate({
      credential_id: row.credential_id,
      deployment_id: row.deployment_id,
      target: row.target,
      params: row.params,
      fallback: row.fallback,
      ...partial,
    })
  /* 「改回跟随默认」不能走 PUT：它要求 credential_id 或 deployment_id 必填，传 null 会被打成 400，
     而按整包语义把旧值带上等于什么都没清。 */
  const clear = useMutation({
    mutationFn: () => apiConfig.clearBinding(row.capability),
    onSuccess: () => {
      invalidate()
      onSaved?.()
    },
    onError: (e: Error) => toast.error(e.message || '改回跟随默认失败'),
  })
  return { mutation, put, clear }
}

function ModelBindingRow({
  row,
  plugins,
  legacy,
  defaultModel,
}: {
  row: Binding
  plugins: ModelPlugin[]
  legacy: LegacyBindingItem | undefined
  /** 全局默认那条绑的上游真名，用于「跟随默认」这一档显示到底跟的是谁 */
  defaultModel?: string | null
}) {
  const { mutation: putMut, put, clear } = useBindingPut(row)
  const [advOpen, setAdvOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const choices = useMemo(
    () => deploymentChoices(row, row.deployment_options, plugins),
    [row, plugins],
  )
  /* 弹窗只列真的能用的：deploymentChoices 已经按 media_type 与插件接线筛过一遍。
     取的是 deployment_options 的原行而不是 choices 里的 deployment——后者是 ModelDeployment，
     丢了 ready 这一位，弹窗就再也标不出「接线缺失」。 */
  const pickable = useMemo(() => {
    const ids = new Set(choices.map((c) => c.deployment.id))
    return row.deployment_options.filter((d) => ids.has(d.id))
  }, [choices, row.deployment_options])
  const current = row.deployment
  const currentInfo = current !== null ? adapterOf(current.adapter_type, plugins) : null
  const fallback = row.fallback ?? []
  const canProbe = row.operation === 'chat.complete'

  const testMut = useMutation({ mutationFn: () => apiConfig.llmTest(row.capability) })
  const probe = describeProbe(testMut.data, testMut.isError)


  const unhealthy = row.bound && !row.healthy
  const problem =
    !row.bound
      ? null
      : current !== null && !current.enabled
        ? '所绑部署已停用'
        : unhealthy
          ? '所绑凭据已停用或异常'
          : null
  const excluded = new Set<number>(
    [
      current?.id ?? null,
      ...fallback.map((entry) => choiceOfFallback(entry, choices)?.deployment.id ?? null),
    ].filter((id): id is number => id !== null),
  )

  return (
    <div className="card bind">
      <div className="bind-head">
        <span className="bind-name">{row.label}</span>
        <span className="bind-desc">{row.description}</span>
        {legacy !== undefined && (
          <span
            className="chip warn"
            title={LEGACY_REASONS[legacy.reason] ?? legacy.reason}
          >
            待改绑
          </span>
        )}
        {canProbe && (
          <div className="bind-test">
            {probe.tone !== 'none' && (
              <span className={`chip ${probe.tone}`} title={probe.title}>
                {probe.text}
              </span>
            )}
            <button
              className="btn-ghost-sm"
              disabled={!row.bound || testMut.isPending}
              title="经插件层真实调一次，结果记入台账（source=probe）"
              onClick={() => testMut.mutate()}
            >
              {testMut.isPending ? '测试中…' : '测一下'}
            </button>
          </div>
        )}
        {row.operation === 'image.generate' && <ServiceProbeButton
          key={row.deployment_id ?? row.target}
          disabled={!row.bound}
          label="生成测试图（计费）"
          run={async () => {
            const result = await apiImage.test(row.capability)
            return { ok: result.ok, latency_ms: result.latency_ms ?? 0,
              detail: result.ok ? '图片生成完成，已保存到图库' : result.detail ?? '生图失败' }
          }}
        />}
      </div>
      <div className="bind-row">
        <button
          type="button"
          className={`sel${!row.bound && !row.follows_default ? ' warn' : ''}`}
          onClick={() => setPickerOpen(true)}
        >
          <span className="sel-display">
            {current !== null && currentInfo !== null ? (
              <span className="bt-current">
                <b>{current.display_name || current.upstream_model_id}</b>
                <span>· {current.credential_name ?? row.credential_name ?? ''}</span>
                <AdapterBadge info={currentInfo} />
              </span>
            ) : row.follows_default ? (
              <span className="bt-current">
                <span className="bt-follow">跟随默认</span>
                <span>{defaultModel ?? '默认还没设'}</span>
              </span>
            ) : row.bound ? (
              <span className="bt-current">
                <b>{row.target ?? '—'}</b>
                <span>· {row.credential_name ?? ''}</span>
                <span className="bt-adapter bt-adapter-stale">未登记</span>
              </span>
            ) : (
              <span>未绑定 · 选择模型</span>
            )}
          </span>
          <SIconChevronDown />
        </button>
        <ModelPicker
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          options={pickable}
          value={current?.id ?? null}
          onPick={(deployment) => put({ deployment_id: deployment.id })}
          usage={row.capability === DEFAULT_LLM_CAPABILITY ? undefined : row.label}
          followDefault={
            row.capability === DEFAULT_LLM_CAPABILITY
              ? undefined
              : {
                  modelName: defaultModel ?? null,
                  active: row.follows_default,
                  onFollow: () => clear.mutate(),
                }
          }
        />
        {row.group === 'llm' && (
          <Popover open={advOpen} onOpenChange={setAdvOpen}>
            <PopoverTrigger asChild>
              <button className="btn-ghost-sm" disabled={!row.bound}>
                高级参数
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-[360px] bg-card" align="start">
              <AdvParamsForm
                row={row}
                onClose={() => setAdvOpen(false)}
                onSave={(params) => put({ params })}
              />
            </PopoverContent>
          </Popover>
        )}
        {legacy !== undefined && legacy.direct_deployment_id !== null && (
          <button
            className="btn-ghost-sm"
            title="同凭据同模型已经登记过一条可用部署，点此改绑过去"
            disabled={putMut.isPending}
            onClick={() => put({ deployment_id: legacy.direct_deployment_id })}
          >
            改绑到已登记部署
          </button>
        )}
        {putMut.isPending && <span className="chip">保存中…</span>}
        {putMut.isError && <span className="chip warn">保存失败：{putMut.error.message}</span>}
      </div>

      {problem !== null && (
        <div className="fb warn">
          ⚠ {problem}
          {fallback.length > 0 ? '，正在走降级链' : '，且没有可用降级'}
        </div>
      )}

      <div className="fb">
        降级链：
        {fallback.map((entry, i) => {
          const choice = choiceOfFallback(entry, choices)
          return (
            <span
              className="chip"
              key={`${entry.deployment_id ?? 'c'}-${entry.credential_id}-${entry.target}`}
              title={choice !== undefined ? choiceLabel(choice) : undefined}
            >
              {i + 1}. {entry.target}
              {choice !== undefined && <AdapterBadge info={choice} />}
              <button
                className="chip-x"
                title="上移"
                disabled={i === 0}
                onClick={() => put({ fallback: moveEntry(fallback, i, -1) })}
              >
                ↑
              </button>
              <button
                className="chip-x"
                title="下移"
                disabled={i === fallback.length - 1}
                onClick={() => put({ fallback: moveEntry(fallback, i, 1) })}
              >
                ↓
              </button>
              <button
                className="chip-x"
                title="移除"
                onClick={() => put({ fallback: removeEntry(fallback, i) })}
              >
                ×
              </button>
            </span>
          )
        })}
        <Sel
          disabled={!row.bound}
          display={<span>＋ 添加降级</span>}
          groups={choiceGroups(
            choices,
            null,
            (choice) => put({ fallback: appendFallback(fallback, fallbackOf(choice)) }),
            excluded,
          )}
        />
      </div>
    </div>
  )
}

/* ---- 朗读场景行：凭据 × 音色 · 语速 · 试听 ---- */

function VoiceBindingRow({
  row, creds, selected, onSelect,
}: {
  row: Binding; creds: Credential[]; selected: boolean; onSelect?: () => void
}) {
  const { mutation: putMut, put } = useBindingPut(row, () => toast.success(`「${row.label}」绑定已保存`))
  const [pickerOpen, setPickerOpen] = useState(false)
  const cred = creds.find((item) => item.id === row.credential_id)
  const voice = cred ? ttsVoicesOf(cred).find((item) => item.id === row.target) : undefined
  const ratePct = typeof row.params?.rate === 'number' ? row.params.rate : 0
  const bound = cred !== undefined && row.target !== null
  return <div className={`bt-voice${selected ? ' editing' : ''}`} onClick={onSelect}>
    <span className="bt-voice-name" title={row.description}>{row.label}</span>
    <button className="bt-voice-picker" onClick={() => setPickerOpen(true)}>
      {bound ? `${cred.name} · ${voice?.label ?? row.target}` : '未绑定 · 选择音色'}
    </button>
    <RatePicker value={1 + ratePct / 100} disabled={!bound}
      onChange={(value) => put({ params: { ...row.params, rate: Math.round((value - 1) * 100) } })} />
    <VoiceProbeButton key={`${row.credential_id}:${row.target}:${ratePct}`} disabled={!bound} capability={row.capability} />
    {putMut.isError && <span className="chip warn bt-voice-err">保存失败</span>}
    {pickerOpen && <VoicePicker title={`${row.label} · 选择音色`} current={row.target} allowLocal={false}
      currentCredentialId={row.credential_id} rate={1 + ratePct / 100}
      onClose={() => setPickerOpen(false)} onChoose={async (choice, rate) => {
        await putMut.mutateAsync({ credential_id: choice.credentialId, target: choice.id,
          params: { ...row.params, rate: Math.round((rate - 1) * 100) }, fallback: row.fallback })
      }} />}
  </div>
}

/* ---- 实时语音行：凭据 × 音色 · 会话参数（JSON 透传） ---- */

function RealtimeParamsOverlay({
  row,
  onClose,
}: {
  row: Binding
  onClose: () => void
}) {
  const { mutation: putMut, put } = useBindingPut(row, () => {
    toast.success('实时语音会话参数已保存')
    onClose()
  })
  const [text, setText] = useState(() => JSON.stringify(row.params ?? {}, null, 2))
  const [err, setErr] = useState<string | null>(null)

  const save = () => {
    setErr(null)
    let parsed: unknown
    try {
      parsed = text.trim() === '' ? {} : JSON.parse(text)
    } catch {
      setErr('JSON 格式不合法')
      return
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setErr('会话参数需为 JSON 对象')
      return
    }
    const obj = parsed as Record<string, unknown>
    put({ params: Object.keys(obj).length === 0 ? null : obj })
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="gap-3.5 bg-card p-5 sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="text-[15px]">{row.label} · 会话参数</DialogTitle>
        </DialogHeader>
        <div className="field">
          <label htmlFor="rt-params">JSON 参数（随会话创建透传给端到端对话）</label>
          <textarea
            id="rt-params"
            className="field-textarea"
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <div className="field-hint">
          常用键：bot_name（角色名）/ speaking_style（说话风格）/ end_smooth_window_ms（尾音平滑）
        </div>
        {err !== null && <div className="form-err">{err}</div>}
        {putMut.isError && <div className="form-err">{putMut.error.message}</div>}
        <div className="overlay-foot">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className={`btn btn-primary${putMut.isPending ? ' loading' : ''}`}
            disabled={putMut.isPending}
            onClick={save}
          >
            {putMut.isPending && <span className="spinner" />}
            保存
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function RealtimeBindingRow({ row, creds }: { row: Binding; creds: Credential[] }) {
  const { mutation: putMut } = useBindingPut(row)
  const [paramsOpen, setParamsOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const cred = creds.find((item) => item.id === row.credential_id)
  const voice = cred ? ttsVoicesOf(cred).find((item) => item.id === row.target) : undefined
  const paramKeys = Object.keys(row.params ?? {})
  return <div className="card bind">
    <div className="bind-head"><span className="bind-name">{row.label}</span><span className="bind-desc">{row.description}</span></div>
    <div className="bind-row">
      <button className="bt-voice-picker" onClick={() => setPickerOpen(true)}>
        {cred ? `${cred.name} · ${voice?.label ?? row.target ?? '默认音色'}` : '未绑定 · 选择实时音色'}
      </button>
      <button className="btn-ghost-sm" disabled={!cred} onClick={() => setParamsOpen(true)}>
        会话参数{paramKeys.length > 0 ? `（${paramKeys.length}）` : ''}
      </button>
      <ServiceProbeButton key={`${row.credential_id}:${row.target}`} disabled={!cred}
        label="测会话与首段音频" run={() => apiConfig.realtimeProbe(row.capability)} />
      {putMut.isPending && <span>保存中…</span>}
      {putMut.error && <span role="alert">{putMut.error.message}</span>}
    </div>
    {row.bound && !row.healthy && <p>所绑凭据已停用或异常</p>}
    {paramsOpen && <RealtimeParamsOverlay row={row} onClose={() => setParamsOpen(false)} />}
    {pickerOpen && <VoicePicker title="实时对话音色" mode="realtime" current={row.target}
      currentCredentialId={row.credential_id} onClose={() => setPickerOpen(false)}
      onChoose={async (choice) => {
        await putMut.mutateAsync({ credential_id: choice.credentialId, target: choice.id || null,
          params: row.params, fallback: row.fallback })
      }} />}
  </div>
}

/* ---- 翻译链行：引擎顺序与启停 ---- */

function TranslateChainRow({ row }: { row: Binding }) {
  const invalidate = useInvalidateConfig()
  const serverRows = useMemo(() => parseChain(row.params), [row.params])
  const [rows, setRows] = useState<ChainRow[]>(serverRows)
  const [touched, setTouched] = useState(false)
  const [saved, setSaved] = useState(false)

  // 服务端数据到达/变化时，未动过的本地状态跟随刷新
  useEffect(() => {
    if (!touched) setRows(serverRows)
  }, [serverRows, touched])

  const saveMut = useMutation({
    mutationFn: () =>
      apiConfig.putBinding(row.capability, {
        credential_id: null,
        target: null,
        params: { chain: rows.filter((r) => r.enabled).map((r) => r.engine) },
        fallback: null,
      }),
    onSuccess: () => {
      invalidate()
      setTouched(false)
      setSaved(true)
    },
  })

  const move = (idx: number, delta: -1 | 1) => {
    setRows(moveEntry(rows, idx, delta))
    setTouched(true)
    setSaved(false)
  }

  const toggle = (idx: number, enabled: boolean) => {
    setRows(rows.map((r, i) => (i === idx ? { ...r, enabled } : r)))
    setTouched(true)
    setSaved(false)
  }

  const enabledCount = rows.filter((r) => r.enabled).length

  return (
    <>
      {row.bound && !row.healthy && (
        <div className="fb warn chain-warn">⚠ 翻译链当前不健康，检查引擎可用性或调整顺序</div>
      )}
      {rows.map((chainRow, idx) => {
        const meta = ENGINES[chainRow.engine]
        const order = rows.slice(0, idx).filter((r) => r.enabled).length + 1
        return (
          <div
            className={`chain-row${chainRow.enabled ? '' : ' chain-off'}`}
            key={chainRow.engine}
          >
            <div className="chain-order">{chainRow.enabled ? order : '—'}</div>
            <div className="chain-info">
              <div className="chain-name">{meta.name}</div>
              <div className="chain-desc">{meta.desc}</div>
            </div>
            <div className="chain-actions">
              <button
                className="icon-btn"
                title="上移"
                disabled={idx === 0}
                onClick={() => move(idx, -1)}
              >
                <SIconArrowUp />
              </button>
              <button
                className="icon-btn"
                title="下移"
                disabled={idx === rows.length - 1}
                onClick={() => move(idx, 1)}
              >
                <SIconArrowDown />
              </button>
              <Switch on={chainRow.enabled} onChange={(next) => toggle(idx, next)} />
            </div>
          </div>
        )
      })}
      <div className="chain-foot">
        {enabledCount === 0 && <span className="chip warn">至少启用一个引擎</span>}
        {saveMut.isError && <span className="chip warn">保存失败：{saveMut.error.message}</span>}
        {saved && !touched && <span className="chip ok">已保存</span>}
        <span className="spacer" />
        <button
          className={`btn btn-primary${saveMut.isPending ? ' loading' : ''}`}
          disabled={saveMut.isPending || !touched || enabledCount === 0}
          onClick={() => saveMut.mutate()}
        >
          {saveMut.isPending && <span className="spinner" />}
          保存顺序
        </button>
      </div>
    </>
  )
}

/* ---- 表主体 ---- */

/* 「全局默认 + 按用途细调」两层。
 *
 *  收敛前这里是八张一模一样的卡片平铺，而实测 scholar 的库里七条绑的是同一个模型——
 *  平铺让人以为这八件事各不相同、每个都得想一遍，实际只有一两个真的要单独指定。
 *  默认那条摆在最上面单独一张卡，其余收进折叠区，标题上直接写清有几个是单独指定的。 */
function LlmBindings({
  rows,
  plugins,
  legacyMap,
}: {
  rows: Binding[]
  plugins: ModelPlugin[]
  legacyMap: Map<string, LegacyBindingItem>
}) {
  const defaultRow = rows.find((r) => r.capability === DEFAULT_LLM_CAPABILITY)
  const rest = rows.filter((r) => r.capability !== DEFAULT_LLM_CAPABILITY)
  // 目录外的遗留行（库里有、代码里没有消费者）只有 slug 没有中文名，混进用途列表就是
  // 把路由键摆到用户眼前（核心原则 6）。单独一段说清它们是什么，也不偷偷删用户的数据
  const usages = rest.filter((r) => r.known)
  const orphans = rest.filter((r) => !r.known)
  const defaultModel = defaultModelOf(rows, DEFAULT_LLM_CAPABILITY)
  const pinned = usages.filter((r) => !r.follows_default).length

  return (
    <>
      {defaultRow !== undefined && (
        <ModelBindingRow
          key={defaultRow.capability}
          row={defaultRow}
          plugins={plugins}
          legacy={legacyMap.get(defaultRow.capability)}
          defaultModel={defaultModel}
        />
      )}
      {usages.length > 0 && (
        <details className="service-disclosure">
          <summary>
            按用途单独指定（{usages.length} 个用途
            {pinned > 0 ? ` · ${pinned} 个已单独指定` : ' · 全部跟随默认'}）
          </summary>
          {usages.map((row) => (
            <ModelBindingRow
              key={row.capability}
              row={row}
              plugins={plugins}
              legacy={legacyMap.get(row.capability)}
              defaultModel={defaultModel}
            />
          ))}
        </details>
      )}
      {orphans.length > 0 && (
        <details className="service-disclosure">
          <summary>目录外的遗留绑定（{orphans.length} 条）</summary>
          <div className="st-note">
            库里有这些绑定，但当前代码里没有任何功能在用它们。留着不影响使用，也可以不管。
          </div>
          {orphans.map((row) => (
            <ModelBindingRow
              key={row.capability}
              row={row}
              plugins={plugins}
              legacy={legacyMap.get(row.capability)}
              defaultModel={defaultModel}
            />
          ))}
        </details>
      )}
    </>
  )
}

export function BindingTable({
  groups,
  showGroupTitles = groups.length > 1,
  selectedCapability,
  onSelectCapability,
  extra,
}: {
  groups: CapabilityGroup[]
  /** 多分组时默认显示分组标题 */
  showGroupTitles?: boolean
  /** 朗读场景：高亮并回报当前正在编辑的能力（音色目录据此设默认） */
  selectedCapability?: string
  onSelectCapability?: (capability: string) => void
  /** 分组标题右侧的附加控件（多分组时按分组键取） */
  extra?: Partial<Record<CapabilityGroup, ReactNode>>
}) {
  const needModels = groups.includes('llm') || groups.includes('image')
  const needVoice = groups.includes('voice')
  const needRealtime = groups.includes('realtime')

  const bindingsQuery = useQuery({ queryKey: ['cfg-bindings'], queryFn: apiConfig.bindings })
  const pluginsQuery = useQuery({
    queryKey: ['cfg-model-plugins'],
    queryFn: apiConfig.modelPlugins,
    staleTime: Infinity,
    enabled: needModels,
  })
  // 键放在 cfg-bindings 前缀下：任何绑定变更失效时一并刷新
  const legacyQuery = useQuery({
    queryKey: ['cfg-bindings', 'legacy'],
    queryFn: apiConfig.bindingsLegacy,
    enabled: needModels,
  })
  const ttsQuery = useQuery({
    queryKey: ['cfg-creds', 'tts'],
    queryFn: () => apiConfig.credentials('tts'),
    enabled: needVoice,
  })
  const rtQuery = useQuery({
    queryKey: ['cfg-creds', 'realtime'],
    queryFn: () => apiConfig.credentials('realtime'),
    enabled: needRealtime,
  })

  const bindings = bindingsQuery.data
  useEffect(() => {
    if (bindings !== undefined) rememberCapLabels(bindings)
  }, [bindings])

  const legacyMap = useMemo(() => {
    const map = new Map<string, LegacyBindingItem>()
    for (const item of legacyQuery.data?.items ?? []) map.set(item.capability, item)
    return map
  }, [legacyQuery.data])

  const pending =
    bindingsQuery.isPending ||
    (needModels && pluginsQuery.isPending) ||
    (needVoice && ttsQuery.isPending) ||
    (needRealtime && rtQuery.isPending)
  if (pending) return <LoadingCards count={3} height={104} />
  if (bindingsQuery.isError) {
    return (
      <ErrorBlock
        message={`能力绑定加载失败：${bindingsQuery.error.message}`}
        onRetry={() => void bindingsQuery.refetch()}
      />
    )
  }
  if (needModels && pluginsQuery.isError) {
    return (
      <ErrorBlock
        message={`模型插件清单加载失败：${pluginsQuery.error.message}`}
        onRetry={() => void pluginsQuery.refetch()}
      />
    )
  }

  const plugins = pluginsQuery.data ?? []
  const sections = rowsForGroups(bindings ?? [], groups)

  return (
    <>
      {sections.map(({ group, rows }) => (
        <div className="bt-group" key={group}>
          {showGroupTitles && <CGroup extra={extra?.[group]}>{GROUP_LABELS[group]}</CGroup>}
          {rows.length === 0 && (
            <div className="st-note">服务端没有返回「{GROUP_LABELS[group]}」分组的能力</div>
          )}
          {group === 'voice' && rows.length > 0 && (
            <div className="card bt-voice-card">
              {rows.map((row) => (
                <VoiceBindingRow
                  key={row.capability}
                  row={row}
                  creds={ttsQuery.data ?? []}
                  selected={selectedCapability === row.capability}
                  onSelect={
                    onSelectCapability !== undefined
                      ? () => onSelectCapability(row.capability)
                      : undefined
                  }
                />
              ))}
            </div>
          )}
          {group === 'image' &&
            rows.map((row) => (
              <ModelBindingRow
                key={row.capability}
                row={row}
                plugins={plugins}
                legacy={legacyMap.get(row.capability)}
              />
            ))}
          {group === 'llm' && (
            <LlmBindings rows={rows} plugins={plugins} legacyMap={legacyMap} />
          )}
          {group === 'realtime' &&
            rows.map((row) => (
              <RealtimeBindingRow key={row.capability} row={row} creds={rtQuery.data ?? []} />
            ))}
          {group === 'translate' &&
            rows.map((row) => <TranslateChainRow key={row.capability} row={row} />)}
        </div>
      ))}
    </>
  )
}
