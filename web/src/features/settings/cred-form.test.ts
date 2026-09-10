/* 凭据表单纯逻辑：探测结果 → 字段展示态、分组、摘要文案。 */

import { describe, expect, it } from 'vitest'

import type { CredentialProbeReport, ProviderField } from '@/lib/api-config'

import type { CredFieldView } from './cred-form'

import {
  assignRemedies,
  cleanFieldLabel,
  credCardState,
  groupCredFields,
  isProbeableType,
  matchRemedy,
  mergeProbeFields,
  probeSummary,
  sourceLabel,
  unmatchedRemedies,
} from './cred-form'

function field(name: string, label: string, required = false, type = 'text'): ProviderField {
  return { name, label, type, required, placeholder: null }
}

function blankView(name: string, label: string): CredFieldView {
  return {
    name,
    label,
    type: 'text',
    required: false,
    placeholder: '',
    mode: 'manual',
    detected: null,
    sourceLabel: null,
    missing: false,
    remedy: null,
  }
}

/* 真库 codex_cli 的 schema（server/domain/credentials.py） */
const CODEX_FIELDS: ProviderField[] = [
  field('executable', 'Codex 路径（可选）'),
  field('helper_executable', 'GPT Image 2 helper 路径（可选）'),
  field('auth_file', 'Codex auth.json（可选）'),
  field('timeout', '超时秒数'),
]

const CODEX_REPORT: CredentialProbeReport = {
  provider_type: 'codex_cli',
  found: true,
  fields: [
    {
      key: 'executable',
      label: 'Codex 路径',
      detected: '/opt/homebrew/bin/codex',
      source: 'which',
    },
    {
      key: 'auth_file',
      label: 'Codex auth.json',
      detected: '/Users/x/.codex/auth.json',
      source: 'default_path',
    },
    { key: 'helper_executable', label: 'GPT Image 2 helper', detected: null, source: null },
  ],
  logged_in: true,
  // 实测文案：problem 里既没有字段键也没有完整字段名
  remediation: [{ problem: '未找到 gpt-image-2-skill', howto: 'npm i -g gpt-image-2-skill' }],
}

describe('cleanFieldLabel', () => {
  it('剥掉尾巴上的「（可选）」，必填与否不靠它表达', () => {
    expect(cleanFieldLabel('Codex 路径（可选）')).toBe('Codex 路径')
    expect(cleanFieldLabel('API Key (可选)')).toBe('API Key')
    expect(cleanFieldLabel('超时秒数')).toBe('超时秒数')
    // 「可选」出现在中间不动它
    expect(cleanFieldLabel('可选模型（默认 gpt-4）')).toBe('可选模型（默认 gpt-4）')
  })
})

describe('isProbeableType', () => {
  it('只认服务端标了 probeable 的类型，不按名字猜', () => {
    expect(isProbeableType({ probeable: true })).toBe(true)
    expect(isProbeableType({ probeable: false })).toBe(false)
    // 旧后端不带这个字段：不探测，退回手填
    expect(isProbeableType({})).toBe(false)
    expect(isProbeableType(undefined)).toBe(false)
  })
})

describe('mergeProbeFields', () => {
  it('探测到的字段不露输入框，带出路径与来源说明', () => {
    const views = mergeProbeFields(CODEX_FIELDS, CODEX_REPORT, new Set(), {})
    const exe = views.find((v) => v.name === 'executable')!
    expect(exe.mode).toBe('detected')
    expect(exe.detected).toBe('/opt/homebrew/bin/codex')
    expect(exe.sourceLabel).toBe('在 PATH 里找到')
    expect(exe.label).toBe('Codex 路径')
  })

  it('探测不到的字段回到手填，并认领对得上的补救办法', () => {
    const views = mergeProbeFields(CODEX_FIELDS, CODEX_REPORT, new Set(), {})
    const helper = views.find((v) => v.name === 'helper_executable')!
    expect(helper.mode).toBe('manual')
    expect(helper.missing).toBe(true)
    expect(helper.remedy?.howto).toBe('npm i -g gpt-image-2-skill')
  })

  it('探测结果里没有的字段（超时秒数）照常手填，且不标「未找到」', () => {
    const views = mergeProbeFields(CODEX_FIELDS, CODEX_REPORT, new Set(), {})
    const timeout = views.find((v) => v.name === 'timeout')!
    expect(timeout.mode).toBe('manual')
    expect(timeout.missing).toBe(false)
  })

  it('用户点了「手动指定」或已经输入内容时，探测值让位', () => {
    const manual = mergeProbeFields(CODEX_FIELDS, CODEX_REPORT, new Set(['executable']), {})
    expect(manual.find((v) => v.name === 'executable')!.mode).toBe('manual')
    // 输入框里已经有值同样以用户为准
    const typed = mergeProbeFields(CODEX_FIELDS, CODEX_REPORT, new Set(), {
      executable: '/usr/local/bin/codex',
    })
    expect(typed.find((v) => v.name === 'executable')!.mode).toBe('manual')
    // 但探测到的值仍要留着，界面上给「恢复自动」用
    expect(typed.find((v) => v.name === 'executable')!.detected).toBe('/opt/homebrew/bin/codex')
  })

  it('端点 404（report=null）时整体降级回手填，不出现任何探测态', () => {
    const views = mergeProbeFields(CODEX_FIELDS, null, new Set(), {})
    expect(views.every((v) => v.mode === 'manual')).toBe(true)
    expect(views.every((v) => !v.missing && v.remedy === null)).toBe(true)
    expect(views).toHaveLength(CODEX_FIELDS.length)
  })

  it('detected 是空串按没探测到处理（别显示「已找到 」这种空路径）', () => {
    const report: CredentialProbeReport = {
      ...CODEX_REPORT,
      fields: [{ key: 'executable', label: 'Codex 路径', detected: '', source: 'which' }],
    }
    const views = mergeProbeFields(CODEX_FIELDS, report, new Set(), {})
    const exe = views.find((v) => v.name === 'executable')!
    expect(exe.mode).toBe('manual')
    expect(exe.missing).toBe(true)
  })
})

describe('assignRemedies', () => {
  it('字段名与补救文案两头不沾时，仍按「就剩这一对」配上（codex 实测）', () => {
    const views = mergeProbeFields(CODEX_FIELDS, CODEX_REPORT, new Set(), {})
    const helper = views.find((v) => v.name === 'helper_executable')!
    expect(helper.remedy?.howto).toBe('npm i -g gpt-image-2-skill')
    // 探测到的字段不该分到补救项
    expect(views.find((v) => v.name === 'executable')!.remedy).toBeNull()
  })

  it('字段名首词命中优先于顺序配对（jimeng 实测：dreamina 路径 ← 未找到 dreamina）', () => {
    const views = mergeProbeFields(
      [field('executable', 'dreamina 路径（可选）'), field('timeout', '单次 CLI 超时秒数')],
      {
        provider_type: 'jimeng_cli',
        found: false,
        fields: [{ key: 'executable', label: 'dreamina 路径', detected: null, source: null }],
        logged_in: null,
        remediation: [
          { problem: '本机没装 Node', howto: 'brew install node' },
          { problem: '未找到 dreamina', howto: '装好后把它所在目录加进 PATH' },
        ],
      },
      new Set(),
      {},
    )
    expect(views.find((v) => v.name === 'executable')!.remedy?.problem).toBe('未找到 dreamina')
  })

  it('一条补救项只能被一个字段认领', () => {
    const views = assignRemedies(
      [
        { ...blankView('a', 'alpha 路径'), missing: true },
        { ...blankView('b', 'beta 路径'), missing: true },
      ],
      [{ problem: '未找到 alpha', howto: 'brew install alpha' }],
    )
    expect(views[0].remedy?.problem).toBe('未找到 alpha')
    expect(views[1].remedy).toBeNull()
  })

  it('没有探测缺口时谁也不分（remediation 原样留给面板）', () => {
    const views = assignRemedies([blankView('a', 'alpha 路径')], [
      { problem: '本机没装 Node', howto: 'brew install node' },
    ])
    expect(views[0].remedy).toBeNull()
  })
})

describe('matchRemedy / unmatchedRemedies', () => {
  it('按字段键或中文字段名认领补救项', () => {
    const remedies = [
      { problem: '未找到 gpt-image-2-skill', howto: 'npm i -g gpt-image-2-skill' },
      { problem: 'Codex auth.json 不存在', howto: 'codex login' },
    ]
    expect(matchRemedy(field('auth_file', 'Codex auth.json（可选）'), remedies)?.howto).toBe(
      'codex login',
    )
    expect(matchRemedy(field('executable', 'Codex 路径（可选）'), remedies)).toBeNull()
  })

  it('没人认领的补救项留给面板底部列出来', () => {
    const views = mergeProbeFields(CODEX_FIELDS, CODEX_REPORT, new Set(), {})
    expect(unmatchedRemedies(views, CODEX_REPORT.remediation)).toHaveLength(0)
    const extra = [
      ...CODEX_REPORT.remediation,
      { problem: '本机没装 Node', howto: 'brew install node' },
    ]
    expect(unmatchedRemedies(views, extra).map((r) => r.problem)).toEqual(['本机没装 Node'])
  })
})

describe('probeSummary', () => {
  it('探测中 / 端点不可用都是中性态，不吓唬用户', () => {
    expect(probeSummary(null, { loading: true, failed: false }).tone).toBe('idle')
    expect(probeSummary(null, { loading: false, failed: true })).toEqual({
      tone: 'idle',
      text: '本机探测不可用，请手动填写下面的字段',
    })
  })

  it('全部就绪且已登录报 ok', () => {
    const report: CredentialProbeReport = {
      ...CODEX_REPORT,
      fields: CODEX_REPORT.fields.filter((f) => f.detected !== null),
    }
    expect(probeSummary(report, { loading: false, failed: false })).toEqual({
      tone: 'ok',
      text: '本机环境已就绪，登录态有效',
    })
  })

  it('没找到主程序时直接把第一条补救问题当摘要', () => {
    const report: CredentialProbeReport = {
      ...CODEX_REPORT,
      found: false,
      remediation: [{ problem: '未找到 codex 可执行文件', howto: 'brew install codex' }],
    }
    expect(probeSummary(report, { loading: false, failed: false })).toEqual({
      tone: 'warn',
      text: '未找到 codex 可执行文件',
    })
  })

  it('装好了没登录，与「缺几项」分开说', () => {
    expect(
      probeSummary(
        { ...CODEX_REPORT, logged_in: false },
        { loading: false, failed: false },
      ),
    ).toEqual({ tone: 'warn', text: '命令行工具已装好，但还没登录' })
    expect(probeSummary(CODEX_REPORT, { loading: false, failed: false })).toEqual({
      tone: 'warn',
      text: '已找到主程序，还有 1 项没探测到',
    })
  })
})

describe('groupCredFields', () => {
  it('按用途分组，每组都有一句说明，未登记字段落到「其他参数」', () => {
    const views = mergeProbeFields(
      [
        field('api_key', 'API Key', true, 'password'),
        field('api_base', '接口地址'),
        field('executable', 'Codex 路径（可选）'),
        field('timeout', '超时秒数'),
        field('mystery_knob', '神秘旋钮'),
      ],
      null,
      new Set(),
      {},
    )
    const groups = groupCredFields(views)
    expect(groups.map((g) => g.key)).toEqual(['auth', 'endpoint', 'local', 'tuning', 'other'])
    expect(groups.every((g) => g.desc !== '')).toBe(true)
    expect(groups.at(-1)!.fields.map((f) => f.name)).toEqual(['mystery_knob'])
  })

  it('空组不出现（只有密钥的供应商就只有一组）', () => {
    const views = mergeProbeFields([field('api_key', 'API Key', true, 'password')], null, new Set(), {})
    expect(groupCredFields(views).map((g) => g.key)).toEqual(['auth'])
  })

  it('没有字段的供应商（edge_tts）分组为空数组', () => {
    expect(groupCredFields([])).toEqual([])
  })
})

describe('credCardState', () => {
  it('一种卡片语言用状态区分：停用优先于测试结论', () => {
    expect(credCardState({ enabled: false, status: 'ok' })).toEqual({ tone: 'off', label: '已停用' })
    expect(credCardState({ enabled: true, status: 'ok' }).tone).toBe('ok')
    expect(credCardState({ enabled: true, status: 'failed' }).tone).toBe('bad')
    expect(credCardState({ enabled: true, status: 'untested' })).toEqual({
      tone: 'idle',
      label: '未测试',
    })
  })
})

describe('sourceLabel', () => {
  it('已知来源翻成人话，未知来源原样透出', () => {
    expect(sourceLabel('default_path')).toBe('默认安装位置')
    expect(sourceLabel('some_new_source')).toBe('some_new_source')
    expect(sourceLabel(null)).toBeNull()
  })
})
