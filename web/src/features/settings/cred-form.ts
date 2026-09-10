/* 凭据表单的纯逻辑：探测结果 → 字段展示态、字段分组、探测摘要。

   本机 CLI 供应商的路径字段过去是一排「（可选）」空输入框，用户既不知道该填什么、
   也不知道填了有没有用。改成：服务端现场探测（which / 默认路径），探测到就只显示
   「✓ 已找到 <路径>」，探测不到才露出输入框并附上安装办法。
   探测端点不可用（后端未就绪 → 404）时整体降级回手填，行为与改造前一致。 */

import type {
  CredentialProbeField,
  CredentialProbeRemedy,
  CredentialProbeReport,
  ProviderField,
  ProviderType,
} from '../../lib/api-config'

/** 这个类型能不能现场探测本机命令行工具与登录态。
    判据由服务端的 `probeable` 给（`cli_bridge.PROBE_PROVIDER_TYPES`）——前端按
    `_cli` 后缀猜过一版，多一个能探测的类型就要改两处，不如只读服务端这一个字段。 */
export function isProbeableType(type: Pick<ProviderType, 'probeable'> | undefined | null): boolean {
  return type?.probeable === true
}

/** 字段名尾巴上的「（可选）」由探测结果承担，别再让它出现在界面上 */
export function cleanFieldLabel(label: string): string {
  return label.replace(/[（(]\s*可选\s*[）)]\s*$/u, '').trim()
}

/** 探测来源 → 一句人话，解释这个值是怎么找到的 */
const SOURCE_LABELS: Record<string, string> = {
  which: '在 PATH 里找到',
  path: '在 PATH 里找到',
  default_path: '默认安装位置',
  env: '来自环境变量',
  config: '已保存的配置',
  bundled: '随程序附带',
  homebrew: 'Homebrew 安装位置',
}

export function sourceLabel(source: string | null | undefined): string | null {
  if (typeof source !== 'string' || source === '') return null
  return SOURCE_LABELS[source] ?? source
}

/** detected 与 manual 决定这一格是「一行绿字」还是「一个输入框」 */
export type FieldMode = 'detected' | 'manual'

export interface CredFieldView {
  name: string
  label: string
  type: string
  required: boolean
  placeholder: string
  mode: FieldMode
  detected: string | null
  sourceLabel: string | null
  /** 探测跑过且这个字段没找到：界面上要给「✗ 未找到」而不是留白 */
  missing: boolean
  /** 与该字段对得上的补救办法（安装 / 登录命令） */
  remedy: CredentialProbeRemedy | null
}

function probeFieldOf(
  report: CredentialProbeReport | null,
  name: string,
): CredentialProbeField | undefined {
  return report?.fields.find((item) => item.key === name)
}

/** 补救项与字段对账：problem 里提到字段键或完整字段名就算这一条是给它的。
    真实文案常常两头都不沾（字段是 helper_executable，问题写「未找到 gpt-image-2-skill」），
    所以这只是第一遍，剩下的交给 assignRemedies 的后两遍。 */
export function matchRemedy(
  field: Pick<ProviderField, 'name' | 'label'>,
  remediation: CredentialProbeRemedy[] | undefined,
): CredentialProbeRemedy | null {
  const label = cleanFieldLabel(field.label)
  for (const item of remediation ?? []) {
    if (item.problem.includes(field.name)) return item
    if (label !== '' && item.problem.includes(label)) return item
  }
  return null
}

/** 字段名的第一个词：「dreamina 路径」→ dreamina，「Codex auth.json」→ Codex。
    太短的词（2 字以内）当噪音丢掉，免得「路径」这种词到处乱认。 */
function leadToken(label: string): string {
  const token = cleanFieldLabel(label).split(/\s+/u)[0] ?? ''
  return token.length >= 3 ? token.toLowerCase() : ''
}

/** 把补救项发给探测不到的字段，一条只能被认领一次：
    ① 字段键 / 完整字段名命中 ② 字段名首词命中 ③ 剩下的按出场顺序配对。
    三遍都没人要的留给面板底部（unmatchedRemedies）。 */
export function assignRemedies(
  views: CredFieldView[],
  remediation: CredentialProbeRemedy[] | undefined,
): CredFieldView[] {
  const pool = [...(remediation ?? [])]
  const claim = (predicate: (remedy: CredentialProbeRemedy) => boolean) => {
    const index = pool.findIndex(predicate)
    return index === -1 ? null : pool.splice(index, 1)[0]
  }
  const out = views.map((view) => ({ ...view }))
  const pending = out.filter((view) => view.missing)

  for (const view of pending) {
    view.remedy = claim(
      (remedy) => remedy.problem.includes(view.name) || remedy.problem.includes(view.label),
    )
  }
  for (const view of pending) {
    if (view.remedy !== null) continue
    const lead = leadToken(view.label)
    if (lead === '') continue
    view.remedy = claim((remedy) => remedy.problem.toLowerCase().includes(lead))
  }
  for (const view of pending) {
    if (view.remedy !== null) continue
    view.remedy = claim(() => true)
  }
  return out
}

/** 已被某个字段认领的补救项不再重复列在面板底部 */
export function unmatchedRemedies(
  views: CredFieldView[],
  remediation: CredentialProbeRemedy[] | undefined,
): CredentialProbeRemedy[] {
  const claimed = new Set(
    views.map((view) => view.remedy?.problem).filter((p): p is string => p !== undefined),
  )
  return (remediation ?? []).filter((item) => !claimed.has(item.problem))
}

/** 供应商 schema 字段 × 探测结果 → 每个字段怎么显示。
    report 为 null（没探测 / 端点 404）时全部退回手填。 */
export function mergeProbeFields(
  fields: ProviderField[],
  report: CredentialProbeReport | null,
  /** 用户点过「手动指定」的字段：即使探测到也要露出输入框 */
  manual: ReadonlySet<string>,
  /** 用户已经输入的值：有输入就以输入为准 */
  typed: Record<string, string>,
): CredFieldView[] {
  const views: CredFieldView[] = fields.map((field) => {
    const probed = probeFieldOf(report, field.name)
    const detected = probed?.detected ?? null
    const hasDetected = typeof detected === 'string' && detected !== ''
    const overridden = manual.has(field.name) || (typed[field.name] ?? '').trim() !== ''
    return {
      name: field.name,
      label: cleanFieldLabel(probed?.label ?? field.label),
      type: field.type,
      required: field.required,
      placeholder: field.placeholder ?? '',
      mode: hasDetected && !overridden ? 'detected' : 'manual',
      detected: hasDetected ? detected : null,
      sourceLabel: hasDetected ? sourceLabel(probed?.source) : null,
      missing: report !== null && probed !== undefined && !hasDetected,
      remedy: null as CredentialProbeRemedy | null,
    }
  })
  return report === null ? views : assignRemedies(views, report.remediation)
}

export interface ProbeSummary {
  tone: 'ok' | 'warn' | 'idle'
  text: string
}

/** 探测面板顶部那一行：正在探测 / 已就绪 / 缺什么 */
export function probeSummary(
  report: CredentialProbeReport | null,
  state: { loading: boolean; failed: boolean },
): ProbeSummary {
  if (state.loading) return { tone: 'idle', text: '正在探测本机环境…' }
  if (state.failed) return { tone: 'idle', text: '本机探测不可用，请手动填写下面的字段' }
  if (report === null) return { tone: 'idle', text: '未探测' }
  if (!report.found) {
    const first = report.remediation[0]
    return { tone: 'warn', text: first !== undefined ? first.problem : '没在本机找到这个命令行工具' }
  }
  const missing = report.fields.filter(
    (field) => field.detected === null || field.detected === '',
  ).length
  if (report.logged_in === false) {
    return { tone: 'warn', text: '命令行工具已装好，但还没登录' }
  }
  if (missing > 0) return { tone: 'warn', text: `已找到主程序，还有 ${missing} 项没探测到` }
  return {
    tone: 'ok',
    text: report.logged_in === true ? '本机环境已就绪，登录态有效' : '本机环境已就绪',
  }
}

/* ---- 长表单分组：每组一句话说明它是干什么的 ---- */

export interface CredFieldGroup {
  key: string
  label: string
  desc: string
  fields: CredFieldView[]
}

const GROUP_SPECS: Array<{ key: string; label: string; desc: string; names: string[] }> = [
  {
    key: 'auth',
    label: '身份与密钥',
    desc: '加密保存，保存后只回显掩码，永不明文回传。',
    names: [
      'api_key',
      'access_key',
      'app_id',
      'access_key_id',
      'secret_access_key',
      'wallet_api_key',
      'data_api_key',
      'cookies_text',
      'cookies_browser',
    ],
  },
  {
    key: 'endpoint',
    label: '连接地址',
    desc: '请求发到哪里。留空走供应商默认端点，中转站才需要自己填。',
    names: ['api_base', 'region', 'project_name'],
  },
  {
    key: 'local',
    label: '本机程序',
    desc: '本机命令行工具的位置，能自动探测到就不用管。',
    names: ['executable', 'helper_executable', 'auth_file'],
  },
  {
    key: 'tuning',
    label: '超时与轮询',
    desc: '慢供应商可以调大，其余保持默认。',
    names: ['timeout', 'submit_poll_seconds', 'poll_interval', 'quality', 'proxy'],
  },
]

/** 字段按用途分组；没登记过的字段收在「其他」里，顺序保持 schema 原样 */
export function groupCredFields(views: CredFieldView[]): CredFieldGroup[] {
  const taken = new Set<string>()
  const groups: CredFieldGroup[] = []
  for (const spec of GROUP_SPECS) {
    const fields = views.filter((view) => spec.names.includes(view.name))
    for (const field of fields) taken.add(field.name)
    if (fields.length > 0) {
      groups.push({ key: spec.key, label: spec.label, desc: spec.desc, fields })
    }
  }
  const rest = views.filter((view) => !taken.has(view.name))
  if (rest.length > 0) {
    groups.push({ key: 'other', label: '其他参数', desc: '这家供应商特有的选项。', fields: rest })
  }
  return groups
}

/* ---- 凭据卡片状态：未接入 / 正常 / 异常 / 已停用，一种卡片语言用状态区分 ---- */

export type ProviderCardTone = 'idle' | 'ok' | 'bad' | 'off'

export interface ProviderCardState {
  tone: ProviderCardTone
  label: string
}

export function credCardState(cred: {
  enabled: boolean
  status: string
  status_detail?: string | null
}): ProviderCardState {
  if (!cred.enabled) return { tone: 'off', label: '已停用' }
  if (cred.status === 'ok') return { tone: 'ok', label: '正常' }
  if (cred.status === 'failed') return { tone: 'bad', label: '异常' }
  return { tone: 'idle', label: '未测试' }
}
