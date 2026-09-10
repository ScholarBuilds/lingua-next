/* 邮件（CR-007 模块 18）：三栏——账号 / 列表 / 正文。

   列表读本地缓存（同步时落的元数据），搜索走 Gmail 自己的查询语法、不落库；
   正文点开时才取。发送前必问：回复框里的「发送」就是那一下点头（服务端要求 confirm）。
   「当阅读材料看」把正文切段进阅读器，点词可查——这是本产品独有的邮件用法。 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

import { IconBook, IconMail, IconSearch } from '../../components/icons'
import { Topbar } from '../../components/Topbar'
import { apiGoogle } from '../../lib/api-google'
import type { GoogleAccount, MailItem, MailSearchHit } from '../../lib/api-google'
import { ApiError } from '../../lib/api'
import './mail.css'
import { useUrlValue } from '@/lib/urlState'
import { useWorkspaceText } from '@/lib/workspaceStore'

function whenLabel(iso: string | null): string {
  if (iso === null) return ''
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return ''
  const now = new Date()
  const sameDay = t.toDateString() === now.toDateString()
  if (sameDay) return t.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  const days = Math.floor((now.getTime() - t.getTime()) / 86_400_000)
  if (days === 1) return '昨天'
  if (days < 7) return `周${'一二三四五六日'[(t.getDay() + 6) % 7]}`
  return `${t.getMonth() + 1} 月 ${t.getDate()} 日`
}

function initial(email: string | null): string {
  return (email ?? '?').slice(0, 1).toUpperCase()
}

export function MailPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [account, setAccount] = useUrlValue<string>('account', '')
  const accountId = account ? Number(account) : undefined
  const setAccountId = (value: number | undefined) => setAccount(value === undefined ? '' : String(value))
  const [query, setQuery] = useWorkspaceText('mail', 'search')
  const [submitted, setSubmitted] = useUrlValue<string>('q', '')
  const [message, setMessage] = useUrlValue<string>('message', '')
  const selected = message ? Number(message) : null
  const setSelected = (value: number | null) => setMessage(value === null ? '' : String(value))

  const inbox = useQuery({ queryKey: ['mail-inbox', accountId ?? 'all'], queryFn: () => apiGoogle.inbox(accountId) })
  const search = useQuery({
    queryKey: ['mail-search', submitted, accountId ?? 'all'],
    queryFn: () => apiGoogle.search(submitted, accountId),
    enabled: submitted !== '',
  })
  const detail = useQuery({
    queryKey: ['mail-message', selected],
    queryFn: () => apiGoogle.message(selected as number),
    enabled: selected !== null,
  })
  const invalidateInbox = () => void queryClient.invalidateQueries({ queryKey: ['mail-inbox'] })

  const sync = useMutation({
    mutationFn: async (accounts: GoogleAccount[]) => {
      let total = 0
      for (const a of accounts) total += (await apiGoogle.sync(a.id)).synced
      return total
    },
    onSuccess: (n) => {
      toast.success(`同步了 ${n} 封`)
      invalidateInbox()
    },
    onError: (e: Error) => toast.error(e.message),
  })
  const archive = useMutation({
    mutationFn: (id: number) => apiGoogle.archive(id),
    onSuccess: () => {
      invalidateInbox()
      setSelected(null)
    },
    onError: (e: Error) => toast.error(e.message),
  })
  const markRead = useMutation({
    mutationFn: (id: number) => apiGoogle.markRead(id),
    onSuccess: invalidateInbox,
    onError: (e: Error) => toast.error(e.message),
  })
  const importArticle = useMutation({
    mutationFn: (id: number) => apiGoogle.importAsArticle(id),
    onSuccess: (r) => {
      invalidateInbox()
      navigate(`/read/${r.article_id}`)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const accounts = inbox.data?.accounts ?? []
  const items = inbox.data?.items ?? []
  const unreadTotal = accounts.reduce((n, a) => n + a.unread, 0)
  const noAccounts = inbox.isSuccess && accounts.length === 0
  const searching = submitted !== ''

  return (
    <div className="main">
      <Topbar
        title="邮件"
        meta={
          <>
            {accounts.length > 0 && <span className="chip">{accounts.length} 个账号</span>}
            {unreadTotal > 0 && <span className="chip accent">{unreadTotal} 未读</span>}
          </>
        }
        actions={
          <button className="btn btn-outline" disabled={accounts.length === 0 || sync.isPending} onClick={() => sync.mutate(accounts)}>
            {sync.isPending ? '同步中…' : '同步'}
          </button>
        }
      />

      {noAccounts ? (
        <div className="content">
          <div className="ml-empty">
            <IconMail />
            <b>还没有连接 Google 账号</b>
            <span>到「账号与凭据」配置 OAuth 客户端并授权账号，收件箱就会出现在这里。</span>
            <button className="btn btn-primary" onClick={() => navigate('/accounts')}>去账号与凭据</button>
          </div>
        </div>
      ) : (
        <div className="ml">
          <aside className="ml-side">
            <div className="ml-group">账号</div>
            <button className={`ml-acct${accountId === undefined ? ' on' : ''}`} onClick={() => setAccountId(undefined)}>
              <IconMail />
              <span className="ml-acct-name">全部收件箱</span>
              {unreadTotal > 0 && <span className="ml-n">{unreadTotal}</span>}
            </button>
            {accounts.map((a) => (
              <button key={a.id} className={`ml-acct${accountId === a.id ? ' on' : ''}`} onClick={() => setAccountId(a.id)} title={a.email}>
                <span className={`ml-av${a.status === 'reauth' ? ' bad' : ''}`}>{initial(a.email)}</span>
                <span className="ml-acct-name">{a.email}</span>
                {a.status === 'reauth' ? <span className="chip warn">要重新授权</span> : a.unread > 0 && <span className="ml-n">{a.unread}</span>}
              </button>
            ))}
            <div className="ml-group">同步</div>
            <div className="ml-side-note">
              Gmail API · 上次 {whenLabel(accounts.reduce<string | null>((latest, a) => (a.last_sync_at !== null && (latest === null || a.last_sync_at > latest) ? a.last_sync_at : latest), null)) || '还没同步'}
              <br />
              令牌与授权在 <button className="ml-link" onClick={() => navigate('/accounts')}>账号与凭据</button>
            </div>
          </aside>

          <section className="ml-list">
            <form
              className="ml-tools"
              onSubmit={(e: FormEvent) => {
                e.preventDefault()
                setSubmitted(query.trim())
              }}
            >
              <label className="ml-search">
                <IconSearch />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜 Gmail：from: has:attachment newer_than:7d" />
                {searching && (
                  <button type="button" className="btn-ghost-sm" onClick={() => { setQuery(''); setSubmitted('') }}>清除</button>
                )}
              </label>
            </form>
            {searching ? (
              <SearchResults hits={search.data?.items ?? []} loading={search.isPending} errors={search.data?.errors ?? []} />
            ) : (
              <>
                {inbox.isPending && <div className="state-block"><div className="spinner" /></div>}
                {inbox.isSuccess && items.length === 0 && <p className="ml-quiet">收件箱是空的，或还没同步。</p>}
                {items.map((m) => (
                  <MailRow key={m.id} item={m} active={selected === m.id} showAccount={accountId === undefined && accounts.length > 1} onOpen={() => { setSelected(m.id); if (m.unread) markRead.mutate(m.id) }} />
                ))}
              </>
            )}
          </section>

          <section className="ml-read">
            {selected === null && <p className="ml-quiet ml-read-empty">选一封邮件。</p>}
            {selected !== null && detail.isPending && <div className="state-block"><div className="spinner" /></div>}
            {selected !== null && detail.isError && (
              <div className="state-block">{detail.error instanceof ApiError ? detail.error.message : '读取失败'}</div>
            )}
            {detail.data !== undefined && selected !== null && (
              <ReadingPane
                message={detail.data}
                onArchive={() => archive.mutate(detail.data.id)}
                onImport={() => importArticle.mutate(detail.data.id)}
                importing={importArticle.isPending}
              />
            )}
          </section>
        </div>
      )}
    </div>
  )
}

function MailRow({ item, active, showAccount, onOpen }: { item: MailItem; active: boolean; showAccount: boolean; onOpen: () => void }) {
  return (
    <button className={`ml-row${active ? ' on' : ''}${item.unread ? ' unread' : ''}`} onClick={onOpen}>
      <span className="ml-av">{initial(item.account_email)}</span>
      <span className="ml-from">{item.from_name ?? item.from_addr ?? '—'}</span>
      <span className="ml-t">{whenLabel(item.sent_at)}</span>
      <span className="ml-subj">{item.subject || '（无主题）'}</span>
      <span className="ml-snip">{item.snippet}</span>
      {(showAccount || item.has_attachments || item.article_id !== null) && (
        <span className="ml-flags">
          {showAccount && item.account_email !== null && <span className="chip">{item.account_email.split('@')[0]}</span>}
          {item.has_attachments && <span className="chip">附件</span>}
          {item.article_id !== null && <span className="chip accent">已收入阅读</span>}
        </span>
      )}
    </button>
  )
}

function SearchResults({ hits, loading, errors }: { hits: MailSearchHit[]; loading: boolean; errors: { email: string; detail: string }[] }) {
  if (loading) return <div className="state-block"><div className="spinner" /></div>
  return (
    <>
      {errors.map((e) => <p key={e.email} className="ml-quiet">{e.email}：{e.detail}</p>)}
      {hits.length === 0 && errors.length === 0 && <p className="ml-quiet">没有匹配的邮件。</p>}
      {hits.map((h) => (
        <div key={`${h.account_id}:${h.gmail_id}`} className={`ml-row static${h.unread ? ' unread' : ''}`}>
          <span className="ml-av">{initial(h.account_email)}</span>
          <span className="ml-from">{h.from_name ?? h.from_addr ?? '—'}</span>
          <span className="ml-t">{whenLabel(h.sent_at)}</span>
          <span className="ml-subj">{h.subject || '（无主题）'}</span>
          <span className="ml-snip">{h.snippet}</span>
        </div>
      ))}
      {hits.length > 0 && <p className="ml-quiet">搜索结果来自 Gmail，不在本地缓存里；要读正文先同步到收件箱。</p>}
    </>
  )
}

function ReadingPane({
  message,
  onArchive,
  onImport,
  importing,
}: {
  message: MailItem & { body_text: string }
  onArchive: () => void
  onImport: () => void
  importing: boolean
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [replying, setReplying] = useState(false)
  const [reply, setReply] = useWorkspaceText('mail', `reply:${message.id}`)
  const [reading, setReading] = useState(false)
  const send = useMutation({
    mutationFn: () =>
      apiGoogle.send({
        account_id: message.account_id,
        to: message.from_addr ?? '',
        subject: message.subject.startsWith('Re:') ? message.subject : `Re: ${message.subject}`,
        body: reply,
        reply_to_message_id: message.id,
      }),
    onSuccess: () => {
      toast.success('已发送')
      setReplying(false)
      setReply('')
      void queryClient.invalidateQueries({ queryKey: ['mail-inbox'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  return (
    <div className="ml-read-inner">
      <h2>{message.subject || '（无主题）'}</h2>
      <div className="ml-meta">
        <span className="ml-av big">{initial(message.account_email)}</span>
        <div>
          <b>{message.from_name ?? message.from_addr}</b>
          {message.from_name !== null && message.from_addr !== null && <span className="ml-addr"> &lt;{message.from_addr}&gt;</span>}
          <br />
          <small>收于 {message.account_email ?? '—'}</small>
        </div>
        <span className="ml-t">{whenLabel(message.sent_at)}</span>
      </div>
      <div className="ml-actions">
        <button className="btn btn-outline" onClick={() => setReplying((v) => !v)} disabled={message.from_addr === null}>回复</button>
        {message.in_inbox && <button className="btn btn-outline" onClick={onArchive}>归档</button>}
        {message.article_id !== null ? (
          <button className="btn btn-soft" onClick={() => navigate(`/read/${message.article_id}`)}><IconBook />在阅读器里打开</button>
        ) : (
          <button className="btn btn-soft" onClick={onImport} disabled={importing}><IconBook />{importing ? '收入中…' : '收入阅读（点词可查）'}</button>
        )}
        <button className={`btn${reading ? ' active' : ''}`} onClick={() => setReading((v) => !v)}>{reading ? '界面字体' : '阅读字体'}</button>
      </div>
      {replying && (
        <form
          className="ml-reply"
          onSubmit={(e) => {
            e.preventDefault()
            if (reply.trim() === '') return
            if (window.confirm(`发给 ${message.from_addr}？`)) send.mutate()
          }}
        >
          <textarea rows={5} value={reply} onChange={(e) => setReply(e.target.value)} placeholder={`回复 ${message.from_name ?? message.from_addr ?? ''}`} autoFocus />
          <div className="ml-reply-foot">
            <span className="ml-quiet">发送前会再问一次；发出的邮件从 {message.account_email} 走。</span>
            <button type="button" className="btn" onClick={() => setReplying(false)}>取消</button>
            <button type="submit" className="btn btn-primary" disabled={send.isPending || reply.trim() === ''}>{send.isPending ? '发送中…' : '发送'}</button>
          </div>
        </form>
      )}
      <div className={`ml-body${reading ? ' reading' : ''}`}>
        {message.body_text.split(/\n{2,}/).map((para, i) => <p key={i}>{para}</p>)}
      </div>
    </div>
  )
}
