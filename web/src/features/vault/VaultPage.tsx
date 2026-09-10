/* 账号与凭据（CR-007 模块 19 · 凭据保险箱）。

   一张表列出全部凭据：模型供应商的（在设置 · 模型服务里加与测）和通用秘密（站点密码 /
   令牌 / cookies，在这里加）。两种拿法：读出给人看，填充给执行器用，都记台账。
   导出带口令，主密钥不出本机。 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { toast } from 'sonner'

import { IconCheck, IconKey, IconPlus } from '../../components/icons'
import { Overlay } from '../../components/Overlay'
import { Topbar } from '../../components/Topbar'
import { apiVault } from '../../lib/api-vault'
import type { AccessMode, SecretType, VaultCredential } from '../../lib/api-vault'
import { saveFile } from '../../lib/shell'
import { useOpenSettings } from '../settings/SettingsModal'
import { GoogleAccounts } from './GoogleAccounts'
import './vault.css'

const KEY_SOURCE_LABEL = { env: '环境变量', keychain: 'macOS 钥匙串', file: '本地文件' } as const
const MODE_LABEL: Record<AccessMode, string> = { read: '读出', fill: '填充', export: '导出', import: '导入' }

function whenLabel(iso: string | null): string {
  if (iso === null) return ''
  const t = new Date(iso)
  return Number.isNaN(t.getTime())
    ? ''
    : t.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function VaultPage() {
  const queryClient = useQueryClient()
  const openSettings = useOpenSettings()
  const list = useQuery({ queryKey: ['vault-credentials'], queryFn: apiVault.list })
  const status = useQuery({ queryKey: ['vault-status'], queryFn: apiVault.status })
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<VaultCredential | null>(null)
  const [revealing, setRevealing] = useState<VaultCredential | null>(null)
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['vault-credentials'] })
    void queryClient.invalidateQueries({ queryKey: ['vault-status'] })
  }
  const toggle = useMutation({
    mutationFn: (cred: VaultCredential) => apiVault.patch(cred.id, { enabled: !cred.enabled }),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  })
  const remove = useMutation({
    mutationFn: (id: number) => apiVault.remove(id),
    onSuccess: () => {
      invalidate()
      toast.success('已删除')
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const rows = list.data ?? []
  const keySource = status.data?.key_source

  return (
    <div className="main">
      <Topbar
        title="账号与凭据"
        meta={
          <>
            <span className="chip">{rows.length} 条凭据</span>
            {keySource !== undefined && <span className="chip">主密钥 · {KEY_SOURCE_LABEL[keySource]}</span>}
          </>
        }
        actions={
          <>
            <button className="btn btn-outline" onClick={() => setImporting(true)}>导入</button>
            <button className="btn btn-outline" onClick={() => setExporting(true)} disabled={rows.length === 0}>导出保险箱</button>
            <button className="btn btn-primary" onClick={() => setAdding(true)}>
              <IconPlus />
              添加凭据
            </button>
          </>
        }
      />

      <div className="content">
        <div className="vt-inner">
          <div>
            <GoogleAccounts />
            <section className="vt-sec">
            <div className="vt-sec-head"><h2>凭据保险箱</h2>{rows.length > 0 && <span className="vt-count">{rows.length}</span>}</div>
            {list.isPending && <div className="state-block"><div className="spinner" /></div>}
            {list.isError && <div className="state-block">加载失败：{list.error.message}</div>}
            {list.isSuccess && rows.length === 0 && (
              <div className="vt-empty">
                <IconKey />
                <b>保险箱是空的</b>
                <span>模型供应商的 key 在设置 · 模型服务里录；站点密码、令牌、cookies 在这里加。</span>
              </div>
            )}
            {rows.length > 0 && (
              <div className="card vt-table-wrap">
                <table className="vt-table">
                  <thead>
                    <tr>
                      <th>名称</th>
                      <th>类型</th>
                      <th>谁在用</th>
                      <th>状态</th>
                      <th>上次访问</th>
                      <th aria-label="操作" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((cred) => (
                      <tr key={cred.id} className={cred.enabled ? '' : 'vt-off'}>
                        <td>
                          <b className="vt-name">{cred.name}</b>
                          <small className="vt-sub">{cred.provider_label}</small>
                        </td>
                        <td><span className="chip">{cred.secret_label}</span></td>
                        <td>
                          <span className="vt-chips">
                            {cred.used_by.map((label) => <span key={label} className="chip">{label}</span>)}
                          </span>
                        </td>
                        <td>
                          {!cred.enabled ? (
                            <span className="chip">已停用</span>
                          ) : cred.managed_in === 'settings' ? (
                            <span className={`chip${cred.status === 'ok' ? ' ok' : cred.status === 'failed' ? ' err' : ''}`}>
                              {cred.status === 'ok' ? '连通' : cred.status === 'failed' ? '失败' : '未测'}
                            </span>
                          ) : (
                            <span className="chip ok">在用</span>
                          )}
                        </td>
                        <td className="vt-when">
                          {cred.last_access === null ? '—' : `${MODE_LABEL[cred.last_access.mode]} · ${whenLabel(cred.last_access.at)}`}
                        </td>
                        <td className="vt-actions">
                          {cred.secret_fields.length > 0 && (
                            <button className="btn-ghost-sm" onClick={() => setRevealing(cred)}>读出</button>
                          )}
                          {cred.managed_in === 'vault' ? (
                            <>
                              <button className="btn-ghost-sm" onClick={() => setEditing(cred)}>编辑</button>
                              <button className="btn-ghost-sm" onClick={() => toggle.mutate(cred)}>
                                {cred.enabled ? '停用' : '启用'}
                              </button>
                              <button
                                className="btn-ghost-sm vt-danger"
                                onClick={() => {
                                  if (window.confirm(`删除「${cred.name}」？访问记录会保留，凭据本身不可恢复。`)) remove.mutate(cred.id)
                                }}
                              >
                                删除
                              </button>
                            </>
                          ) : (
                            <button className="btn-ghost-sm" onClick={() => openSettings('models')}>在设置里管</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            </section>
          </div>

          <aside className="vt-aside">
            <div className="vt-note">
              <b>主密钥在{keySource !== undefined ? KEY_SOURCE_LABEL[keySource] : '…'}</b>
              库里只有密文。
              {keySource === 'env' && (
                <>
                  要迁进钥匙串：<code>uv run python scripts/vault_key_to_keychain.py</code>，然后从 .env 删掉那一行。
                </>
              )}
              换机器不要拷密钥，用「导出保险箱」带口令导出再导入。
            </div>
            <div className="vt-note">
              <b>读出与填充是两种授权。</b>
              读出是给人看，值回到你眼前；填充是给电脑操控用，值直接打进输入框、不经模型。两种都记台账，
              表里「上次访问」就是台账的最后一行。
            </div>
            <div className="vt-note">
              <b>模型供应商的 key 也在这张表里。</b>
              它们的探测、试连、拉模型仍在设置 · 模型服务，这里只列出、可读出、可看记录。
            </div>
          </aside>
        </div>
      </div>

      {adding && <SecretForm onClose={() => setAdding(false)} onSaved={invalidate} />}
      {editing !== null && <SecretForm existing={editing} onClose={() => setEditing(null)} onSaved={invalidate} />}
      {revealing !== null && <RevealDialog cred={revealing} onClose={() => setRevealing(null)} onDone={invalidate} />}
      {exporting && <ExportDialog onClose={() => setExporting(false)} onDone={invalidate} />}
      {importing && <ImportDialog onClose={() => setImporting(false)} onDone={invalidate} />}
    </div>
  )
}

/* ---- 新建 / 编辑通用秘密：字段由 /vault/secret-types 驱动 ---- */
function SecretForm({
  existing,
  onClose,
  onSaved,
}: {
  existing?: VaultCredential
  onClose: () => void
  onSaved: () => void
}) {
  const types = useQuery({ queryKey: ['vault-secret-types'], queryFn: apiVault.secretTypes })
  const [providerType, setProviderType] = useState(existing?.provider_type ?? 'password')
  const [name, setName] = useState(existing?.name ?? '')
  const [values, setValues] = useState<Record<string, string>>({})
  const spec: SecretType | undefined = types.data?.find((t) => t.provider_type === providerType)

  const save = useMutation({
    mutationFn: () =>
      existing !== undefined
        ? apiVault.patch(existing.id, { name, config: values })
        : apiVault.create({ name, provider_type: providerType, config: values }),
    onSuccess: () => {
      toast.success(existing !== undefined ? '已保存' : '已加入保险箱')
      onSaved()
      onClose()
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (name.trim() === '') {
      toast.error('给它起个名字')
      return
    }
    save.mutate()
  }

  return (
    <Overlay onClose={onClose} card="vt-card" labelledBy="vt-form-title">
      <form className="vt-form" onSubmit={submit}>
        <h2 id="vt-form-title">{existing !== undefined ? `编辑 · ${existing.name}` : '添加凭据'}</h2>
        {existing === undefined && types.data !== undefined && (
          <div className="seg vt-seg" role="tablist">
            {types.data.map((t) => (
              <button
                key={t.provider_type}
                type="button"
                className={providerType === t.provider_type ? 'active' : ''}
                onClick={() => {
                  setProviderType(t.provider_type)
                  setValues({})
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
        {spec !== undefined && <p className="vt-form-note">{spec.notes}</p>}
        <label className="vt-field">
          <span>名称</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="比如 Coursera" autoFocus />
        </label>
        {(spec?.fields ?? []).map((field) => (
          <label key={field.name} className="vt-field">
            <span>
              {field.label}
              {field.required && existing === undefined && <i aria-hidden> *</i>}
            </span>
            {field.name === 'cookies_text' ? (
              <textarea
                rows={4}
                value={values[field.name] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [field.name]: e.target.value }))}
                placeholder={existing !== undefined && field.type === 'password' ? '留空则不改' : field.placeholder ?? ''}
              />
            ) : (
              <input
                type={field.type === 'password' ? 'password' : 'text'}
                autoComplete="off"
                value={values[field.name] ?? (existing !== undefined && field.type !== 'password' ? '' : '')}
                onChange={(e) => setValues((v) => ({ ...v, [field.name]: e.target.value }))}
                placeholder={
                  existing !== undefined && field.type === 'password'
                    ? `留空则不改（当前 ${existing.masked[field.name] ?? '未填'}）`
                    : field.placeholder ?? ''
                }
              />
            )}
          </label>
        ))}
        <div className="vt-form-foot">
          <button type="button" className="btn" onClick={onClose}>取消</button>
          <button type="submit" className="btn btn-primary" disabled={save.isPending}>
            {save.isPending ? '保存中…' : '保存'}
          </button>
        </div>
      </form>
    </Overlay>
  )
}

/* ---- 读出：选一个秘密字段，明文只在这个框里出现，关掉就没了；每次都记台账 ---- */
function RevealDialog({ cred, onClose, onDone }: { cred: VaultCredential; onClose: () => void; onDone: () => void }) {
  const [field, setField] = useState(cred.secret_fields[0] ?? '')
  const [value, setValue] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const reveal = useMutation({
    mutationFn: () => apiVault.reveal(cred.id, field),
    onSuccess: (r) => {
      setValue(r.value)
      onDone()
    },
    onError: (e: Error) => toast.error(e.message),
  })
  return (
    <Overlay onClose={onClose} card="vt-card" labelledBy="vt-reveal-title">
      <div className="vt-form">
        <h2 id="vt-reveal-title">读出 · {cred.name}</h2>
        <p className="vt-form-note">读出会记一行访问台账。值只显示在这里，关掉即消失。</p>
        {cred.secret_fields.length > 1 && (
          <div className="seg vt-seg">
            {cred.secret_fields.map((f) => (
              <button key={f} type="button" className={field === f ? 'active' : ''} onClick={() => { setField(f); setValue(null) }}>
                {f}
              </button>
            ))}
          </div>
        )}
        {value === null ? (
          <button className="btn btn-primary" onClick={() => reveal.mutate()} disabled={reveal.isPending}>
            {reveal.isPending ? '解密中…' : `读出 ${field}`}
          </button>
        ) : (
          <div className="vt-secret">
            <code>{value}</code>
            <button
              className="btn btn-outline btn-sm"
              onClick={() => {
                void navigator.clipboard.writeText(value)
                setCopied(true)
              }}
            >
              {copied ? <><IconCheck />已复制</> : '复制'}
            </button>
          </div>
        )}
        <div className="vt-form-foot">
          <button className="btn" onClick={onClose}>关闭</button>
        </div>
      </div>
    </Overlay>
  )
}

function ExportDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [passphrase, setPassphrase] = useState('')
  const run = useMutation({
    mutationFn: async () => {
      const blob = await apiVault.export(passphrase)
      const stamp = new Date().toISOString().slice(0, 10)
      saveFile(blob, `lingua-vault-${stamp}.json`)
    },
    onSuccess: () => {
      toast.success('已导出，文件用口令加密')
      onDone()
      onClose()
    },
    onError: (e: Error) => toast.error(e.message),
  })
  return (
    <Overlay onClose={onClose} card="vt-card" labelledBy="vt-export-title">
      <form
        className="vt-form"
        onSubmit={(e) => {
          e.preventDefault()
          run.mutate()
        }}
      >
        <h2 id="vt-export-title">导出保险箱</h2>
        <p className="vt-form-note">全部凭据明文打包，再用这个口令加密。口令不存任何地方，忘了文件就作废；至少 8 位。</p>
        <label className="vt-field">
          <span>口令</span>
          <input type="password" autoComplete="new-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoFocus />
        </label>
        <div className="vt-form-foot">
          <button type="button" className="btn" onClick={onClose}>取消</button>
          <button type="submit" className="btn btn-primary" disabled={passphrase.length < 8 || run.isPending}>导出</button>
        </div>
      </form>
    </Overlay>
  )
}

function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [passphrase, setPassphrase] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const run = useMutation({
    mutationFn: () => {
      if (file === null) throw new Error('先选文件')
      return apiVault.import(file, passphrase)
    },
    onSuccess: (r) => {
      toast.success(`导入 ${r.imported} 条，跳过 ${r.skipped} 条同名的`)
      onDone()
      onClose()
    },
    onError: (e: Error) => toast.error(e.message),
  })
  return (
    <Overlay onClose={onClose} card="vt-card" labelledBy="vt-import-title">
      <form
        className="vt-form"
        onSubmit={(e) => {
          e.preventDefault()
          run.mutate()
        }}
      >
        <h2 id="vt-import-title">导入保险箱</h2>
        <p className="vt-form-note">同名同类型的凭据会跳过，不会覆盖现有的。</p>
        <label className="vt-field">
          <span>文件</span>
          <input type="file" accept="application/json,.json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <label className="vt-field">
          <span>口令</span>
          <input type="password" autoComplete="off" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
        </label>
        <div className="vt-form-foot">
          <button type="button" className="btn" onClick={onClose}>取消</button>
          <button type="submit" className="btn btn-primary" disabled={file === null || passphrase === '' || run.isPending}>导入</button>
        </div>
      </form>
    </Overlay>
  )
}
