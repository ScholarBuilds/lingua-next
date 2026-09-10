/* 模型服务：全产品唯一的模型/API 配置处，自上而下三层递进。

   ① 供应商凭据 —— 先把账号接进来（含本机 CLI 的自动探测）
   ② 模型部署   —— 再登记这家供应商下真实存在的模型与调用协议
   ③ 能力绑定   —— 最后把每个 AI 能力指到某一条部署上

   三层是因果关系不是并列关系：没有①就没有②可登记，没有②则③里选不出任何东西。
   工坊那边的「模型调用账本」只看调用记录，不再承担任何配置职责。 */

import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

import { apiConfig } from '../../lib/api-config'
import type { Credential } from '../../lib/api-config'
import { BindingTable } from './BindingTable'
import {
  AddCredButton,
  CredCard,
  CredOverlay,
  RecommendedProviderCards,
} from './credentials'
import { DeploymentSection } from './DeploymentSection'
import { hhmm } from './meta'
import { CGroup, ErrorBlock, LoadingCards, SecHead } from './shared'

/* ---- 审计日志 Dialog ---- */

function AuditOverlay({ onClose }: { onClose: () => void }) {
  const auditQuery = useQuery({ queryKey: ['cfg-audit'], queryFn: () => apiConfig.audit(20) })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[80vh] gap-3.5 overflow-y-auto bg-card p-5 sm:max-w-[660px]">
        <DialogHeader>
          <DialogTitle className="text-[15px]">配置审计日志 · 最近 20 条</DialogTitle>
        </DialogHeader>
        {auditQuery.isPending && <LoadingCards count={4} height={30} />}
        {auditQuery.isError && (
          <div className="st-note">审计日志加载失败:{auditQuery.error.message}</div>
        )}
        {auditQuery.data !== undefined && (
          <div className="audit-list">
            {auditQuery.data.length === 0 && <div className="st-note">暂无配置变更记录</div>}
            {auditQuery.data.map((e) => (
              <div className="audit-row" key={e.id}>
                <time>{new Date(e.created_at).toLocaleString('zh-CN', { hour12: false })}</time>
                <span className="audit-sum">{e.summary}</span>
                <code>{e.action}</code>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/* ---- 区块主体 ---- */

export function ModelSection() {
  const typesQuery = useQuery({
    queryKey: ['cfg-provider-types'],
    queryFn: apiConfig.providerTypes,
    staleTime: 300_000,
  })
  const credsQuery = useQuery({
    queryKey: ['cfg-creds', 'llm'],
    queryFn: () => apiConfig.credentials('llm'),
  })
  const auditQuery = useQuery({ queryKey: ['cfg-audit'], queryFn: () => apiConfig.audit(20) })

  const [overlay, setOverlay] = useState<'closed' | 'add' | Credential>('closed')
  const [presetType, setPresetType] = useState<string | null>(null)
  const [auditOpen, setAuditOpen] = useState(false)

  const llmTypes = (typesQuery.data ?? []).filter(
    (type) => type.kind === 'llm' || type.compatible_kinds?.includes('llm'),
  )
  const creds = credsQuery.data ?? []
  const configuredTypes = new Set(creds.map((cred) => cred.provider_type))
  const latestAudit = (auditQuery.data ?? []).slice(0, 2)

  return (
    <>
      <SecHead
        title="模型服务"
        desc="接入供应商，浏览和测试模型，再为翻译、解释和对话选择默认模型。密钥加密保存。"
      />

      <CGroup
        extra={
          <button className="btn-ghost-sm" onClick={() => setAuditOpen(true)}>
            审计日志
          </button>
        }
      >
        已接入的供应商
      </CGroup>
      <div className="tier-lead">
        点击“浏览模型”打开目录；连接测试只验证供应商，具体模型需要在目录内单独测试。
      </div>

      {credsQuery.isPending && <LoadingCards />}
      {credsQuery.isError && (
        <ErrorBlock
          message={`凭据列表加载失败：${credsQuery.error.message}`}
          onRetry={() => void credsQuery.refetch()}
        />
      )}
      {credsQuery.data !== undefined && (
        <>
          <div className="pcard-list">
            {creds.map((c) => (
              <CredCard
                key={c.id}
                cred={c}
                unitLabel="模型"
                refreshLabel="刷新模型"
                showTest
                onEdit={() => setOverlay(c)}
              />
            ))}
          </div>
          <details className="service-disclosure"><summary>查看其他供应商</summary><RecommendedProviderCards
            types={llmTypes}
            configuredTypes={configuredTypes}
            onSelect={(providerType) => {
              setPresetType(providerType)
              setOverlay('add')
            }}
          /></details>
          <AddCredButton
            text="接入其他供应商（任意 OpenAI 兼容端点 / 本机 Ollama…）"
            onClick={() => {
              setPresetType(null)
              setOverlay('add')
            }}
          />
        </>
      )}

      <details className="service-disclosure"><summary>高级：模型部署与协议</summary><DeploymentSection /></details>

      <CGroup
        extra={
          <Link className="btn-ghost-sm" to="/studio/models">
            模型调用账本
          </Link>
        }
      >
        用途与默认模型
      </CGroup>
      <div className="tier-lead">
        为每个用途选择已测试的模型。测试调用当前配置；异常时检查供应商凭据、协议和网络路径。
      </div>

      <BindingTable groups={['llm']} />

      {latestAudit.length > 0 && (
        <div className="audit">
          {latestAudit.map((e, i) => (
            <span className="audit-item" key={e.id}>
              {i > 0 && <span className="audit-gap" />}
              <time>{hhmm(e.created_at)}</time>
              {e.summary}
            </span>
          ))}
        </div>
      )}

      {overlay !== 'closed' && (
        <CredOverlay
          /* key 保证 添加↔编辑 / 不同凭据间切换时表单状态重置 */
          key={overlay === 'add' ? 'add' : overlay.id}
          kind="llm"
          types={llmTypes}
          existing={overlay === 'add' ? undefined : overlay}
          initialProviderType={overlay === 'add' ? presetType ?? undefined : undefined}
          onClose={() => {
            setOverlay('closed')
            setPresetType(null)
          }}
        />
      )}
      {auditOpen && <AuditOverlay onClose={() => setAuditOpen(false)} />}
    </>
  )
}
