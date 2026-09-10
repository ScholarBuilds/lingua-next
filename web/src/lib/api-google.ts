/* Google 账号、Gmail 收件箱与日历（CR-007 模块 18）：/google/* 的契约封装 */

import { request } from './api'

export interface GoogleAccount {
  id: number
  email: string
  display_name: string | null
  status: 'ok' | 'reauth'
  status_detail: string | null
  scopes: string[]
  last_sync_at: string | null
  unread: number
  created_at: string | null
}

export interface MailItem {
  id: number
  account_id: number
  account_email: string | null
  gmail_id: string
  thread_id: string | null
  from_name: string | null
  from_addr: string | null
  to_addrs: string[]
  subject: string
  snippet: string
  sent_at: string | null
  labels: string[]
  unread: boolean
  has_attachments: boolean
  article_id: number | null
  in_inbox: boolean
}

export interface MailDetail extends MailItem {
  body_text: string
}

/** 实时搜索的结果不落库，没有本地 id */
export interface MailSearchHit {
  account_id: number
  account_email: string
  gmail_id: string
  thread_id: string | null
  from_name: string | null
  from_addr: string | null
  subject: string
  snippet: string
  sent_at: string | null
  unread: boolean
}

export interface CalendarEvent {
  id: string
  account_id: number
  account_email: string
  summary: string
  start: string | null
  end: string | null
  all_day: boolean
  location: string | null
  link: string | null
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

export const apiGoogle = {
  oauthClient: () =>
    request<{ configured: boolean; credential_id: number | null; redirect_uri: string }>('/api/google/oauth/client'),
  oauthStart: () => request<{ url: string; state: string }>('/api/google/oauth/start', { method: 'POST' }),
  accounts: () => request<GoogleAccount[]>('/api/google/accounts'),
  removeAccount: (id: number) => request<{ deleted: number }>(`/api/google/accounts/${id}`, { method: 'DELETE' }),
  sync: (id: number) =>
    request<{ synced: number; last_sync_at: string | null }>(`/api/google/accounts/${id}/sync`, { method: 'POST' }),
  inbox: (accountId?: number) =>
    request<{ accounts: GoogleAccount[]; items: MailItem[] }>(
      `/api/google/mail/inbox${accountId !== undefined ? `?account_id=${accountId}` : ''}`,
    ),
  search: (q: string, accountId?: number) =>
    request<{ items: MailSearchHit[]; errors: { email: string; detail: string }[] }>(
      `/api/google/mail/search?q=${encodeURIComponent(q)}${accountId !== undefined ? `&account_id=${accountId}` : ''}`,
    ),
  message: (id: number) => request<MailDetail>(`/api/google/mail/messages/${id}`),
  archive: (id: number) => request<MailItem>(`/api/google/mail/messages/${id}/archive`, { method: 'POST' }),
  markRead: (id: number) => request<MailItem>(`/api/google/mail/messages/${id}/read`, { method: 'POST' }),
  importAsArticle: (id: number) =>
    request<{ article_id: number; existed: boolean }>(`/api/google/mail/messages/${id}/import`, { method: 'POST' }),
  send: (body: { account_id: number; to: string; subject: string; body: string; reply_to_message_id?: number }) =>
    request<{ gmail_id: string; thread_id: string }>('/api/google/mail/send', jsonInit('POST', { ...body, confirm: true })),
  calendarToday: () =>
    request<{ accounts: number; events: CalendarEvent[]; errors: { email: string; detail: string }[] }>(
      '/api/google/calendar/today',
    ),
}
