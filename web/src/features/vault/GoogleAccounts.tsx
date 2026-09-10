/* 账号与凭据页上半：Google 账号（模块 18）。

   一个 OAuth 客户端服务全部账号：没配客户端时先摆引导卡 + 表单；配好了就列账号、能同步、
   能重新授权、能移除。授权在系统浏览器里完成，回调落在 API 上，这里轮询账号列表等它出现。 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { toast } from 'sonner'

import { apiConfig } from '../../lib/api-config'
import { apiGoogle } from '../../lib/api-google'
import type { GoogleAccount } from '../../lib/api-google'
import { apiVault } from '../../lib/api-vault'
import { openExternal } from '../../lib/shell'
import { OnboardingCard } from '../settings/OnboardingCard'

function whenLabel(iso: string | null): string {
  if (iso === null) return '还没同步'
  const t = new Date(iso)
  return Number.isNaN(t.getTime())
    ? ''
    : t.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

const SCOPE_LABEL: Record<string, string> = {
  'https://www.googleapis.com/auth/gmail.modify': 'Gmail 读写',
  'https://www.googleapis.com/auth/gmail.send': 'Gmail 发信',
  'https://www.googleapis.com/auth/calendar.readonly': '日历 只读',
}

export function GoogleAccounts() {
  const queryClient = useQueryClient()
  const client = useQuery({ queryKey: ['google-oauth-client'], queryFn: apiGoogle.oauthClient })
  const accounts = useQuery({ queryKey: ['google-accounts'], queryFn: apiGoogle.accounts })
  const [waiting, setWaiting] = useState(false)
  const seen = useRef(0)

  // 授权在系统浏览器里做，这边每 3 秒看一眼账号列表；两分钟没回来就不等了
  useEffect(() => {
    if (!waiting) return
    const started = Date.now()
    const timer = window.setInterval(async () => {
      const list = await queryClient.fetchQuery({ queryKey: ['google-accounts'], queryFn: apiGoogle.accounts, staleTime: 0 })
      if (list.length > seen.current || Date.now() - started > 120_000) {
        setWaiting(false)
        void queryClient.invalidateQueries({ queryKey: ['vault-credentials'] })
        if (list.length > seen.current) toast.success(`已连接 ${list[list.length - 1]?.email ?? ''}`)
      }
    }, 3000)
    return () => window.clearInterval(timer)
  }, [waiting, queryClient])

  const start = useMutation({
    mutationFn: apiGoogle.oauthStart,
    onSuccess: (r) => {
      seen.current = accounts.data?.length ?? 0
      setWaiting(true)
      openExternal(r.url)
    },
    onError: (e: Error) => toast.error(e.message),
  })
  const sync = useMutation({
    mutationFn: (id: number) => apiGoogle.sync(id),
    onSuccess: (r) => {
      toast.success(`同步了 ${r.synced} 封`)
      void queryClient.invalidateQueries({ queryKey: ['google-accounts'] })
      void queryClient.invalidateQueries({ queryKey: ['mail-inbox'] })
    },
    onError: (e: Error) => {
      toast.error(e.message)
      void queryClient.invalidateQueries({ queryKey: ['google-accounts'] })
    },
  })
  const remove = useMutation({
    mutationFn: (id: number) => apiGoogle.removeAccount(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['google-accounts'] })
      void queryClient.invalidateQueries({ queryKey: ['vault-credentials'] })
      void queryClient.invalidateQueries({ queryKey: ['mail-inbox'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const configured = client.data?.configured === true
  const rows = accounts.data ?? []

  return (
    <section className="vt-sec">
      <div className="vt-sec-head">
        <h2>Google 账号</h2>
        {rows.length > 0 && <span className="vt-count">{rows.length}</span>}
        <span className="vt-sec-more">
          {configured && (
            <button className="btn btn-outline btn-sm" onClick={() => start.mutate()} disabled={start.isPending || waiting}>
              {waiting ? '等你在浏览器里授权…' : '添加账号'}
            </button>
          )}
        </span>
      </div>
      {client.isSuccess && !configured && <ClientSetup onSaved={() => void client.refetch()} />}
      {configured && rows.length === 0 && (
        <div className="vt-empty">
          <b>还没有连接账号</b>
          <span>点「添加账号」会打开系统浏览器完成 Google 授权，回来这里就会出现。</span>
        </div>
      )}
      {rows.length > 0 && (
        <div className="card vt-table-wrap">
          <table className="vt-table">
            <thead>
              <tr><th>账号</th><th>已授权</th><th>令牌</th><th>上次同步</th><th aria-label="操作" /></tr>
            </thead>
            <tbody>
              {rows.map((a: GoogleAccount) => (
                <tr key={a.id}>
                  <td>
                    <b className="vt-name">{a.email}</b>
                    {a.display_name !== null && <small className="vt-sub">{a.display_name}</small>}
                  </td>
                  <td>
                    <span className="vt-chips">
                      {a.scopes.filter((s) => SCOPE_LABEL[s] !== undefined).map((s) => <span key={s} className="chip ok">{SCOPE_LABEL[s]}</span>)}
                    </span>
                  </td>
                  <td>
                    {a.status === 'ok' ? <span className="chip ok">有效</span> : <span className="chip warn" title={a.status_detail ?? ''}>要重新授权</span>}
                  </td>
                  <td className="vt-when">{whenLabel(a.last_sync_at)}</td>
                  <td className="vt-actions">
                    <button className="btn-ghost-sm" onClick={() => sync.mutate(a.id)} disabled={sync.isPending}>同步</button>
                    <button className="btn-ghost-sm" onClick={() => start.mutate()} disabled={start.isPending || waiting}>重新授权</button>
                    <button
                      className="btn-ghost-sm vt-danger"
                      onClick={() => {
                        if (window.confirm(`移除 ${a.email}？本地缓存的邮件一起删，Google 那边不受影响。`)) remove.mutate(a.id)
                      }}
                    >
                      移除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/* 没配客户端时：引导卡（步骤与链接来自服务端）+ 两个字段 */
function ClientSetup({ onSaved }: { onSaved: () => void }) {
  const types = useQuery({ queryKey: ['cfg-provider-types'], queryFn: apiConfig.providerTypes })
  const guide = types.data?.find((t) => t.provider_type === 'google_oauth_client')?.onboarding ?? null
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const save = useMutation({
    mutationFn: () =>
      apiVault.create({ name: 'Google OAuth 客户端', provider_type: 'google_oauth_client', config: { client_id: clientId, client_secret: clientSecret } }),
    onSuccess: () => {
      toast.success('客户端已存进保险箱，现在可以添加账号')
      onSaved()
    },
    onError: (e: Error) => toast.error(e.message),
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (clientId.trim() === '' || clientSecret.trim() === '') {
      toast.error('两个都要填')
      return
    }
    save.mutate()
  }
  return (
    <div className="vt-setup">
      {guide !== null && <OnboardingCard guide={guide} fieldNames={['client_id', 'client_secret']} />}
      <form className="vt-form vt-form-inline" onSubmit={submit}>
        <label className="vt-field">
          <span>Client ID</span>
          <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="xxxx.apps.googleusercontent.com" autoComplete="off" />
        </label>
        <label className="vt-field">
          <span>Client Secret</span>
          <input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="GOCSPX-…" autoComplete="new-password" />
        </label>
        <div className="vt-form-foot">
          <button type="submit" className="btn btn-primary" disabled={save.isPending}>{save.isPending ? '保存中…' : '保存客户端'}</button>
        </div>
      </form>
    </div>
  )
}
