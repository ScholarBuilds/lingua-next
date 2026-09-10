/* 连接器安装与连接状态页。

   Chrome 未上架 Web Store 就只能开发者模式加载未打包目录，UXP 面板不走 Creative Cloud
   分发就只能靠 UXP Developer Tool 加载——这一步没法用代码消掉，所以这页不承诺一键安装，
   只负责两件事：把要点的地方逐条写清楚（目录给后端返回的真实绝对路径，可一键复制），
   以及装完之后在应用里看得见连没连上。 */

import { AppWindow, Check, Copy, RefreshCw, ScanSearch } from '@/components/NexusIcon'
import { useState } from 'react'
import { toast } from 'sonner'

import {
  connectorBadge,
  connectorSteps,
  connectorVerifyHint,
  lastSeenText,
  packageLine,
  shouldExpandGuide,
  useConnectorStatus,
} from './connectorStatus'
import type { ConnectorStatus } from './connectorStatus'
import './connectors.css'

const ICONS = { chrome: ScanSearch, photoshop: AppWindow }

function CopyPath({ text, hint }: { text: string; hint: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="stc-copy"
      title={hint}
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
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
    </button>
  )
}

function ConnectorCard({
  status,
  command,
}: {
  status: ConnectorStatus
  command: string
}): JSX.Element {
  const badge = connectorBadge(status)
  const Icon = ICONS[status.id as keyof typeof ICONS] ?? AppWindow
  const steps = connectorSteps(status)
  return (
    <section className="stc-card">
      <header className="stc-card-head">
        <span className="stc-card-icon">
          <Icon aria-hidden />
        </span>
        <div className="stc-card-text">
          <h2>{status.label}</h2>
          <p>{status.host_hint}</p>
        </div>
        <span className={`stc-badge stc-badge-${badge.tone}`}>{badge.text}</span>
      </header>

      <p className="stc-note">{lastSeenText(status)}</p>

      <details className="stc-guide" open={shouldExpandGuide(status)}>
        <summary>安装引导 · {steps.length} 步装完</summary>
        <ol className="stc-steps">
          {steps.map((step, index) => (
            <li key={step.text}>
              <span className="stc-step-no">{index + 1}</span>
              <div className="stc-step-body">
                <span>{step.text}</span>
                {step.copy !== undefined && (
                  <CopyPath text={step.copy} hint={step.copyHint ?? '复制'} />
                )}
              </div>
            </li>
          ))}
        </ol>
        <p className="stc-verify">{connectorVerifyHint(status)}</p>
        {!status.source_dir_exists && (
          <p className="stc-warn">
            后端没在 {status.source_dir} 找到这个目录，先把仓库拉全再照上面装。
          </p>
        )}
        <p className="stc-package">{packageLine(status, command)}</p>
      </details>
    </section>
  )
}

export default function ConnectorSetupPage(): JSX.Element {
  const query = useConnectorStatus()
  const payload = query.data
  return (
    <main className="page stc">
      <header className="stc-head">
        <div className="stc-head-text">
          <h1>连接器</h1>
          <p>
            浏览器扩展和 Photoshop 面板都没上架商店，只能手动加载一次。装完这页会显示已连接。
          </p>
        </div>
        <button
          className="btn btn-outline"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          <RefreshCw aria-hidden />
          {query.isFetching ? '查询中' : '重新检测'}
        </button>
      </header>

      {query.isPending && (
        <div className="state-block">
          <div className="spinner" />
          <div>读取连接状态…</div>
        </div>
      )}
      {query.isError && (
        <div className="state-block">
          <div>连接状态读取失败：{query.error.message}</div>
        </div>
      )}

      {payload !== undefined && (
        <>
          <div className="stc-list">
            {payload.connectors.map((status) => (
              <ConnectorCard key={status.id} status={status} command={payload.package_command} />
            ))}
          </div>
          <p className="stc-foot">
            判据是连接器自己发来的心跳，窗口 {payload.online_window_s} 秒。面板关掉就没有心跳，
            所以「未连接」只说明现在没在通信，不代表卸载了；服务重启后没收到过任何信号会显示
            「判不了」。
          </p>
        </>
      )}
    </main>
  )
}
