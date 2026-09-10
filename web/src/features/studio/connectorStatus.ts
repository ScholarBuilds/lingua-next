/* 连接器状态的取数与判读。

   两个连接器都装不进商店：Chrome 未上架就只能开发者模式加载未打包目录，
   UXP 面板不走 Creative Cloud 分发就只能用 UXP Developer Tool 加载。这一步消不掉，
   页面能做的是把它变成「照着三步装完，装没装看得见」。 */

import { useQuery } from '@tanstack/react-query'

import { request } from '@/lib/api-image'

/** 服务端判定的三种态。没有真实信号一律是 unknown，不拿「没消息」冒充「没安装」。 */
export type ConnectorState = 'connected' | 'disconnected' | 'unknown'

export interface ConnectorStatus {
  id: string
  tool_id: string
  label: string
  host_hint: string
  state: string
  state_note: string
  last_seen_at: string | null
  seen_seconds_ago: number | null
  version: string
  channel: string
  source_dir: string
  source_dir_exists: boolean
  entry_path: string
  entry_exists: boolean
  package_path: string
  package_exists: boolean
  package_built_at: string | null
}

export interface ConnectorStatusPayload {
  checked_at: string
  online_window_s: number
  package_command: string
  connectors: ConnectorStatus[]
}

/** 未知档位兜底成 unknown：服务端将来加档位时，宁可说「判不了」也不要假装连上了。 */
export function connectorState(value: string): ConnectorState {
  const text = value.trim().toLowerCase()
  if (text === 'connected') return 'connected'
  if (text === 'disconnected') return 'disconnected'
  return 'unknown'
}

export interface ConnectorBadge {
  tone: ConnectorState
  text: string
}

export function connectorBadge(status: ConnectorStatus): ConnectorBadge {
  const tone = connectorState(status.state)
  if (tone === 'connected') return { tone, text: '已连接' }
  if (tone === 'disconnected') return { tone, text: '未连接' }
  return { tone, text: '判不了' }
}

/** 引导只在没连上时展开：连着的时候它是噪音，没连上的时候它是唯一出路。 */
export function shouldExpandGuide(status: ConnectorStatus): boolean {
  return connectorState(status.state) !== 'connected'
}

/** 一步安装指引。``copy`` 是要照抄的东西，没有就不给复制按钮。 */
export interface ConnectorStep {
  text: string
  copy?: string
  copyHint?: string
}

export function connectorSteps(status: ConnectorStatus): ConnectorStep[] {
  if (status.id === 'chrome') {
    return [
      { text: '地址栏打开 chrome://extensions', copy: 'chrome://extensions', copyHint: '复制地址' },
      { text: '打开右上角的「开发者模式」开关' },
      {
        text: '点「加载已解压的扩展程序」，选这个目录',
        copy: status.source_dir_exists ? status.source_dir : undefined,
        copyHint: '复制目录路径',
      },
    ]
  }
  return [
    { text: '装 Adobe UXP Developer Tool，打开 Photoshop 24.0 或更高版本' },
    {
      text: '在 UDT 点 Add Plugin，选这个 manifest.json',
      copy: status.entry_exists ? status.entry_path : undefined,
      copyHint: '复制 manifest.json 路径',
    },
    { text: '点 Load，从 Photoshop 的「增效工具」菜单打开「Lingua 画布工具」' },
  ]
}

/** 装完怎么确认。三步之外的第四句不进编号，免得和「三步装完」自相矛盾。 */
export function connectorVerifyHint(status: ConnectorStatus): string {
  const where = status.id === 'chrome' ? '点扩展图标' : '在面板设置里'
  return `装好后${where}填 Lingua 地址点「连接」，这里就会变成「已连接」。`
}

/** 最后一次通信的说明。没连上就把服务端给的原因原样带出来，不改写成好听的。 */
export function lastSeenText(status: ConnectorStatus): string {
  return status.state_note
}

/** 打包产物的一句话。没打过包就给出该跑什么，不留空白。 */
export function packageLine(status: ConnectorStatus, command: string): string {
  if (!status.package_exists) return `还没打过分发包，要发给别人先跑 ${command}`
  const built = status.package_built_at === null ? '' : `（${status.package_built_at.slice(0, 10)} 打的）`
  return `分发包${built}：${status.package_path}`
}

export function useConnectorStatus() {
  return useQuery({
    queryKey: ['studio-connector-status'],
    queryFn: () => request<ConnectorStatusPayload>('/studio/connectors/status'),
    // 心跳窗口 120 秒，页面开着就按半个窗口刷新，装完不用手动刷页面
    refetchInterval: 20_000,
    staleTime: 10_000,
  })
}
