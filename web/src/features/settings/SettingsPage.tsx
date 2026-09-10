/* 配置中心壳：左子导航（六分类）+ URL 路由 /settings/:section。
   问题分类红点：凭据 failed 或所辖分组里已绑定的能力 healthy=false 时点亮；
   能力归属哪个分组由 /config/bindings 的 group 字段给出，前端不留能力清单副本 */

import { useQuery } from '@tanstack/react-query'
import { ArrowLeftIcon, Globe } from '@/components/NexusIcon'
import { useEffect } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'

import { apiConfig } from '../../lib/api-config'
import type { Binding, CapabilityGroup, Credential } from '../../lib/api-config'
import { useMediaQuery } from '../../lib/use-media-query'
import { DataSection } from './DataSection'
import { NetworkSection } from './NetworkSection'
import {
  SIconBook,
  SIconChart,
  SIconDb,
  SIconImage,
  SIconSpark,
  SIconTranslate,
  SIconVoice,
} from './icons'
import { rememberCapLabels } from './meta'
import { ModelSection } from './ModelSection'
import { ReaderPrefsSection } from './ReaderPrefsSection'
import { TranslateSection } from './TranslateSection'
import { UsageSection } from './UsageSection'
import { ImageSection } from './ImageSection'
import { VoiceSection } from './VoiceSection'
import './settings.css'

type SectionKey = 'models' | 'voice' | 'image' | 'translate' | 'reading' | 'usage' | 'data' | 'network'

/* 分区栏收成纯图标的断点，取 tokens.css 那张表的 md。
   与 settings.css 里那条 @media 逐字成对，改一处要改两处：
   CSS 负责藏文字，这里负责决定要不要挂 title——文字还在的时候再浮一遍就是噪音。 */
const NAV_COLLAPSE_QUERY = '(width < 48rem)'

interface SectionMeta {
  key: SectionKey
  label: string
  icon: React.ReactNode
}

/** 子导航分组：参考 Linear / GitHub settings 的信息架构 */
const SECTION_GROUPS: Array<{ label: string; items: SectionMeta[] }> = [
  {
    label: '服务配置',
    items: [
      { key: 'models', label: '模型服务', icon: <SIconSpark /> },
      { key: 'voice', label: '语音服务', icon: <SIconVoice /> },
      { key: 'image', label: '生图服务', icon: <SIconImage /> },
      { key: 'translate', label: '翻译引擎', icon: <SIconTranslate /> },
    ],
  },
  {
    label: '个人偏好',
    items: [
      { key: 'reading', label: '阅读与外观', icon: <SIconBook /> },
    ],
  },
  {
    label: '系统',
    items: [
      { key: 'usage', label: '用量与预算', icon: <SIconChart /> },
      { key: 'data', label: '数据管理', icon: <SIconDb /> },
      { key: 'network', label: '网络与代理', icon: <Globe /> },
    ],
  },
]

const SECTION_KEYS = new Set<string>(
  SECTION_GROUPS.flatMap((g) => g.items.map((s) => s.key)),
)

/** 各分区所辖的能力分组 */
const SECTION_BINDING_GROUPS: Partial<Record<SectionKey, CapabilityGroup[]>> = {
  models: ['llm'],
  voice: ['voice', 'realtime'],
  image: ['image'],
  translate: ['translate'],
}

function credBad(creds: Credential[] | undefined): boolean {
  return (creds ?? []).some((c) => c.enabled && c.status === 'failed')
}

/** 已绑定却不健康才算问题：从未绑定过的能力不点红点，与旧行为一致 */
function bindingBad(bindings: Binding[] | undefined, groups: CapabilityGroup[]): boolean {
  return (bindings ?? []).some((b) => groups.includes(b.group) && b.bound && !b.healthy)
}

/** 设置主体（子导航 + 分区内容）：整页路由与模态弹窗共用（FR-93）。 */
export function SettingsShell({
  active,
  onSelect,
  onBack,
}: {
  active: SectionKey
  onSelect: (key: SectionKey) => void
  /** 有值渲染返回键（整页形态用；弹窗形态靠 Dialog 自带关闭） */
  onBack?: () => void
}) {

  // 红点数据：与各分区共用缓存键，后端未就绪时静默无红点
  const llmQuery = useQuery({
    queryKey: ['cfg-creds', 'llm'],
    queryFn: () => apiConfig.credentials('llm'),
  })
  const ttsQuery = useQuery({
    queryKey: ['cfg-creds', 'tts'],
    queryFn: () => apiConfig.credentials('tts'),
  })
  const rtQuery = useQuery({
    queryKey: ['cfg-creds', 'realtime'],
    queryFn: () => apiConfig.credentials('realtime'),
  })
  const imageQuery = useQuery({
    queryKey: ['cfg-creds', 'image'],
    queryFn: () => apiConfig.credentials('image'),
  })
  const bindingsQuery = useQuery({ queryKey: ['cfg-bindings'], queryFn: apiConfig.bindings })
  const bindings = bindingsQuery.data
  const navCollapsed = useMediaQuery(NAV_COLLAPSE_QUERY)

  // 能力中文名随绑定响应缓存，凭据删除冲突提示等处据此翻译 capability 键
  useEffect(() => {
    if (bindings !== undefined) rememberCapLabels(bindings)
  }, [bindings])

  const warnOf: Partial<Record<SectionKey, boolean>> = {
    models: credBad(llmQuery.data) || bindingBad(bindings, SECTION_BINDING_GROUPS.models ?? []),
    voice:
      credBad(ttsQuery.data) ||
      credBad(rtQuery.data) ||
      bindingBad(bindings, SECTION_BINDING_GROUPS.voice ?? []),
    image: credBad(imageQuery.data) || bindingBad(bindings, SECTION_BINDING_GROUPS.image ?? []),
    translate: bindingBad(bindings, SECTION_BINDING_GROUPS.translate ?? []),
  }

  return (
    <div className="body-row">
      <aside className="snav">
        <div className="snav-head">
          {onBack !== undefined && (
            <button className="snav-back" title="返回应用" onClick={onBack}>
              <ArrowLeftIcon />
            </button>
          )}
          <div className="snav-title">设置</div>
        </div>
        {SECTION_GROUPS.map((g) => (
          <div className="snav-group" key={g.label}>
            <div className="snav-group-label">{g.label}</div>
            {g.items.map((s) => (
              <button
                key={s.key}
                className={`snav-item${active === s.key ? ' active' : ''}`}
                /* 收成纯图标时名字只剩 title 与 aria-label 认得出 */
                title={navCollapsed ? s.label : undefined}
                aria-label={s.label}
                onClick={() => onSelect(s.key)}
              >
                {s.icon}
                <span className="snav-label">{s.label}</span>
                {warnOf[s.key] === true && (
                  <span className="warn-dot" title="有能力缺少有效绑定或凭据异常" />
                )}
              </button>
            ))}
          </div>
        ))}
      </aside>

      <div className="cwrap" key={active}>
        <div className="cinner">
          {active === 'models' && <ModelSection />}
          {active === 'voice' && <VoiceSection />}
          {active === 'image' && <ImageSection />}
          {active === 'translate' && <TranslateSection />}
          {active === 'reading' && <ReaderPrefsSection />}
          {active === 'usage' && <UsageSection />}
          {active === 'data' && <DataSection />}
          {active === 'network' && <NetworkSection />}
        </div>
      </div>
    </div>
  )
}

export function normalizeSection(raw: string | null | undefined): SectionKey {
  return raw !== null && raw !== undefined && SECTION_KEYS.has(raw)
    ? (raw as SectionKey)
    : 'models'
}

export type { SectionKey }

/** 整页形态：/settings/:section 直链与刷新仍可用（FR-93 深链保障） */
export function SettingsPage() {
  const navigate = useNavigate()
  const { section } = useParams()
  if (section !== undefined && !SECTION_KEYS.has(section)) {
    return <Navigate to="/settings/models" replace />
  }
  return (
    <div className="main">
      <SettingsShell
        active={normalizeSection(section)}
        onSelect={(k) => navigate(`/settings/${k}`)}
        onBack={() => navigate('/')}
      />
    </div>
  )
}
