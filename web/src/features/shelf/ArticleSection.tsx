import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { Overlay } from '../../components/Overlay'
import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ChangeEvent, FormEvent, MouseEvent } from 'react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

import {
  IconAlert,
  IconClose,
  IconFileText,
  IconLink,
  IconPlus,
  IconTrash,
} from '../../components/icons'
import { api } from '../../lib/api'
import type { ImportArticleBody } from '../../lib/api'
import { apiM5 } from '../../lib/api-m5'
import type { ArticleWithProgress } from '../../lib/api-m5'
import { fmtPct } from './BookCard'

const KIND_LABELS: Record<ArticleWithProgress['source_kind'], string> = {
  url: '网页',
  paste: '粘贴',
  file: '文件',
}

const FILE_EXTS = ['.txt', '.md', '.pdf']

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

interface ArticleRowProps {
  article: ArticleWithProgress
  deleting: boolean
  onOpen: () => void
  onDelete: () => void
}

function ArticleRow({ article, deleting, onOpen, onDelete }: ArticleRowProps) {
  const [showError, setShowError] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const ready = article.status === 'ready'
  const processing = article.status === 'pending' || article.status === 'parsing'
  const failed = article.status === 'failed'

  const handleClick = () => {
    if (ready) onOpen()
    else if (failed) setShowError((v) => !v)
  }

  const handleDelete = (e: MouseEvent) => {
    e.stopPropagation()
    setConfirmOpen(true)
  }

  return (
    <div
      className={`art-row${ready || failed ? '' : ' disabled'}`}
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') handleClick()
      }}
    >
      <span className="art-icon">
        {article.source_kind === 'url' ? <IconLink /> : <IconFileText />}
      </span>
      <div className="art-main">
        <div className="art-title">{article.title}</div>
        <div className="art-meta">
          <span className="chip">{KIND_LABELS[article.source_kind] ?? article.source_kind}</span>
          {typeof article.word_count === 'number' && article.word_count > 0 && (
            <span>{article.word_count.toLocaleString()} 词</span>
          )}
          {article.state === 'reading' && (
            <span className="art-progress">读到 {fmtPct(article.progress_pct)}</span>
          )}
          {article.state === 'finished' && <span className="chip ok">已读完</span>}
          <span>{formatTime(article.created_at)}</span>
          {failed && <span>点击查看失败原因</span>}
        </div>
        {failed && showError && (
          <div className="art-error">{article.error ?? '解析失败，未返回具体原因'}</div>
        )}
      </div>
      {processing && (
        <span className="chip">
          <span className="spinner" />
          {article.status === 'pending' ? '排队中' : '解析中'}
        </span>
      )}
      {failed && <span className="chip err">失败</span>}
      <button
        className="icon-btn art-del"
        title="删除文章"
        disabled={deleting}
        onClick={handleDelete}
      >
        <IconTrash />
      </button>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent
          className="gap-3.5 bg-card p-5 sm:max-w-[400px]"
          onClick={(e) => e.stopPropagation()}
        >
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[15px]">删除文章</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="confirm-text">
                删除文章《<b>{article.title}</b>》？相关生词收藏不受影响。
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onDelete}>
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

interface ImportArticlePanelProps {
  onClose: () => void
  /** 提交成功（已入队解析） */
  onDone: () => void
}

type ImportTab = 'url' | 'paste' | 'file'

function ImportArticlePanel({ onClose, onDone }: ImportArticlePanelProps) {
  const [tab, setTab] = useState<ImportTab>('url')
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [invalid, setInvalid] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const importMutation = useMutation({
    mutationFn: (body: ImportArticleBody) => api.importArticle(body),
    onSuccess: onDone,
  })

  const uploadMutation = useMutation({
    mutationFn: (f: File) => apiM5.uploadArticleFile(f),
    onSuccess: onDone,
  })

  const pending = importMutation.isPending || uploadMutation.isPending
  const submitError = importMutation.isError
    ? importMutation.error.message
    : uploadMutation.isError
      ? uploadMutation.error.message
      : null

  const handleFilePick = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null
    setInvalid(null)
    if (f && !FILE_EXTS.some((ext) => f.name.toLowerCase().endsWith(ext))) {
      setInvalid('仅支持 .txt / .md / .pdf 文件')
      setFile(null)
    } else {
      setFile(f)
    }
    e.target.value = ''
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setInvalid(null)
    if (tab === 'url') {
      const u = url.trim()
      if (!/^https?:\/\/\S+/i.test(u)) {
        setInvalid('请输入以 http(s):// 开头的网页地址')
        return
      }
      importMutation.mutate({ kind: 'url', url: u })
    } else if (tab === 'paste') {
      const t = text.trim()
      if (t === '') {
        setInvalid('正文内容不能为空')
        return
      }
      const body: ImportArticleBody = { kind: 'paste', text: t }
      if (title.trim() !== '') body.title = title.trim()
      importMutation.mutate(body)
    } else {
      if (!file) {
        setInvalid('请选择一个 txt / md / pdf 文件')
        return
      }
      uploadMutation.mutate(file)
    }
  }

  return (
    <Overlay onClose={onClose}>
        <div className="overlay-head">
          <div className="overlay-title">导入文章</div>
          <div className="seg">
            <button
              type="button"
              className={tab === 'url' ? 'active' : undefined}
              onClick={() => setTab('url')}
            >
              粘贴 URL
            </button>
            <button
              type="button"
              className={tab === 'paste' ? 'active' : undefined}
              onClick={() => setTab('paste')}
            >
              粘贴文本
            </button>
            <button
              type="button"
              className={tab === 'file' ? 'active' : undefined}
              onClick={() => setTab('file')}
            >
              上传文件
            </button>
          </div>
          <button className="icon-btn" title="关闭 (Esc)" onClick={onClose}>
            <IconClose />
          </button>
        </div>

        <form className="sce-form" onSubmit={submit}>
          {tab === 'url' && (
            <div className="field">
              <label htmlFor="art-url">网页地址</label>
              <input
                id="art-url"
                className="field-input"
                type="text"
                placeholder="https://example.com/article"
                value={url}
                autoFocus
                onChange={(e) => setUrl(e.target.value)}
              />
              <div className="field-hint">抓取正文并解析为可精读的文章，标题自动提取</div>
            </div>
          )}
          {tab === 'paste' && (
            <>
              <div className="field">
                <label htmlFor="art-title">标题（选填）</label>
                <input
                  id="art-title"
                  className="field-input"
                  type="text"
                  placeholder="留空则取正文首行"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="art-text">正文</label>
                <textarea
                  id="art-text"
                  className="field-textarea"
                  placeholder="粘贴英文文章正文…"
                  value={text}
                  autoFocus
                  onChange={(e) => setText(e.target.value)}
                />
              </div>
            </>
          )}
          {tab === 'file' && (
            <div className="field">
              <label>文档文件</label>
              <button
                type="button"
                className="art-add"
                onClick={() => fileRef.current?.click()}
              >
                <IconFileText />
                {file ? file.name : '选择 txt / md / pdf 文件'}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".txt,.md,.pdf"
                hidden
                onChange={handleFilePick}
              />
              <div className="field-hint">单文件上传，标题取文件名，解析完成后可精读</div>
            </div>
          )}

          {invalid && <div className="form-err">{invalid}</div>}
          {submitError && <div className="form-err">导入失败：{submitError}</div>}

          <div className="overlay-foot">
            <button type="button" className="btn" onClick={onClose}>
              取消
            </button>
            <button
              type="submit"
              className={`btn btn-primary${pending ? ' loading' : ''}`}
              disabled={pending}
            >
              {pending && <span className="spinner" />}
              {pending ? '提交中…' : '导入'}
            </button>
          </div>
        </form>
      </Overlay>
  )
}

/** 书架"我的文章"分段：URL / 粘贴 / 文件导入的独立文章列表 */
export function ArticleSection() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [importOpen, setImportOpen] = useState(false)

  const articlesQuery = useQuery({
    queryKey: ['standalone-articles'],
    queryFn: apiM5.standaloneArticles,
    // 有解析中的文章时 3s 轮询至就绪
    refetchInterval: (query) => {
      const data = query.state.data
      return data?.some((a) => a.status === 'pending' || a.status === 'parsing') ? 3000 : false
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteArticle(id),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['standalone-articles'] })
    },
  })

  const articles = articlesQuery.data

  return (
    <section className="sec">
      <div className="sec-head">
        我的文章
        {articles && articles.length > 0 && <span className="chip">{articles.length}</span>}
      </div>

      {articlesQuery.isPending && (
        <div className="art-list">
          {[0, 1].map((i) => (
            <div key={i} className="skeleton" style={{ height: 58 }} />
          ))}
        </div>
      )}

      {articlesQuery.isError && (
        <div className="state-block">
          <IconAlert />
          <div>文章列表加载失败：{articlesQuery.error.message}</div>
          <button className="btn btn-outline" onClick={() => void articlesQuery.refetch()}>
            重试
          </button>
        </div>
      )}

      {articles && (
        <div className="art-list">
          {articles.map((a) => (
            <ArticleRow
              key={a.id}
              article={a}
              deleting={deleteMutation.isPending && deleteMutation.variables === a.id}
              onOpen={() => navigate(`/read/${a.id}`)}
              onDelete={() => deleteMutation.mutate(a.id)}
            />
          ))}
          <button className="art-add" onClick={() => setImportOpen(true)}>
            <IconPlus />
            导入文章
            <span style={{ fontSize: 11, color: 'var(--ink-faint)', fontWeight: 400 }}>
              网页 URL、粘贴文本或上传 txt / md / pdf
            </span>
          </button>
          {deleteMutation.isError && (
            <div className="form-err">删除失败：{deleteMutation.error.message}</div>
          )}
        </div>
      )}

      {importOpen && (
        <ImportArticlePanel
          onClose={() => setImportOpen(false)}
          onDone={() => {
            setImportOpen(false)
            void queryClient.invalidateQueries({ queryKey: ['standalone-articles'] })
          }}
        />
      )}
    </section>
  )
}
