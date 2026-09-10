import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ChangeEvent } from 'react'

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

import { IconAlert, IconBook, IconPlus, IconSearch } from '../../components/icons'
import { Topbar } from '../../components/Topbar'
import { api, ApiError } from '../../lib/api'
import { apiM5, parseDeleteConflict } from '../../lib/api-m5'
import type { BookDeleteConflict, BookWithProgress, ShelfState } from '../../lib/api-m5'
import { ArticleSection } from './ArticleSection'
import { BookCard, fmtPct } from './BookCard'
import { ImportCard } from './ImportCard'
import './shelf-m5.css'

const BOOK_EXTS = ['.epub', '.pdf', '.txt', '.md']

/** 难度档位：与 server/domain/builtin_books.py 的分档一致 */
const LEVELS: Array<['all' | 'starter' | 'core' | 'deep', string, string]> = [
  ['all', '全部', '不限难度'],
  ['starter', '入门', 'CEFR A2-B1：童书与寓言，句子短、从句浅'],
  ['core', '进阶', 'CEFR B1-B2：通俗小说与冒险科幻，叙事线性'],
  ['deep', '精读', 'CEFR B2-C1：文学经典与思想著作，长句与古体词多'],
]

const STATE_ORDER: ShelfState[] = ['reading', 'unstarted', 'finished']
const STATE_LABELS: Record<ShelfState, string> = {
  reading: '在读',
  unstarted: '未开始',
  finished: '已读完',
}

function ShelfSkeleton() {
  return (
    <div className="book-grid">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} style={{ width: 150 }}>
          <div className="skeleton" style={{ aspectRatio: '2/3' }} />
          <div className="skeleton skeleton-line" style={{ marginTop: 10, width: '80%' }} />
          <div className="skeleton skeleton-line" style={{ marginTop: 6, width: '55%' }} />
        </div>
      ))}
    </div>
  )
}

/** 最近打开的在读书：继续阅读横幅数据源 */
function pickResume(books: BookWithProgress[]): BookWithProgress | null {
  const candidates = books.filter(
    (b) => b.state === 'reading' && b.last_article_id !== null && b.last_opened_at !== null,
  )
  if (candidates.length === 0) return null
  return candidates.reduce((best, b) =>
    (b.last_opened_at ?? '') > (best.last_opened_at ?? '') ? b : best,
  )
}

interface DeleteDialogProps {
  book: BookWithProgress
  conflict: BookDeleteConflict | null
  pending: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}

/** 删除确认（shadcn AlertDialog）：初次普通确认；409 后展示批注/生词计数，确认即强删 */
function DeleteDialog({ book, conflict, pending, error, onCancel, onConfirm }: DeleteDialogProps) {
  return (
    <AlertDialog open onOpenChange={(o) => !o && !pending && onCancel()}>
      <AlertDialogContent className="gap-3.5 bg-card p-5 sm:max-w-[400px]">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-[15px]">删除书籍</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="confirm-text">
              确定删除《<b>{book.title}</b>》？书籍与阅读进度将一并移除。
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {conflict && (
          <div className="confirm-conflict">
            这本书里还有 <b>{conflict.annotations}</b> 条批注、
            <b>{conflict.vocab_occurrences}</b> 条生词记录，删除后将一并清除。
          </div>
        )}
        {error && <div className="form-err">{error}</div>}
        <div className="overlay-foot">
          <button className="btn" onClick={onCancel} disabled={pending}>
            取消
          </button>
          <button
            className={`btn ${conflict ? 'btn-danger-solid' : 'btn-danger'}${pending ? ' loading' : ''}`}
            disabled={pending}
            onClick={onConfirm}
          >
            {pending && <span className="spinner" />}
            {conflict ? '仍要删除' : '删除'}
          </button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function ShelfPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [keyword, setKeyword] = useState('')
  const [level, setLevel] = useState<'all' | 'starter' | 'core' | 'deep'>('all')
  const [openingId, setOpeningId] = useState<number | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<BookWithProgress | null>(null)
  const [deleteConflict, setDeleteConflict] = useState<BookDeleteConflict | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const booksQuery = useQuery({
    queryKey: ['books'],
    queryFn: apiM5.books,
    // 有解析中的书时 3s 轮询，直到全部就绪
    refetchInterval: (query) => {
      const data = query.state.data
      return data?.some((b) => b.status === 'pending' || b.status === 'parsing') ? 3000 : false
    },
  })

  const upload = useMutation({
    mutationFn: api.uploadBook,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['books'] })
    },
  })

  const deleteBook = useMutation({
    mutationFn: ({ id, force }: { id: number; force: boolean }) => apiM5.deleteBook(id, force),
    onSuccess: () => {
      setDeleteTarget(null)
      setDeleteConflict(null)
      setDeleteError(null)
      void queryClient.invalidateQueries({ queryKey: ['books'] })
    },
    onError: (err) => {
      const conflict = parseDeleteConflict(err)
      if (conflict) {
        // 409：升级为强删确认，展示将被清除的数据量
        setDeleteConflict(conflict)
        setDeleteError(null)
      } else {
        setDeleteError(err instanceof Error ? err.message : '删除失败')
      }
    },
  })

  const handleFiles = async (files: File[]) => {
    setNotice(null)
    const accepted = files.filter((f) =>
      BOOK_EXTS.some((ext) => f.name.toLowerCase().endsWith(ext)),
    )
    if (accepted.length === 0) {
      setNotice('仅支持 .epub / .pdf / .txt / .md 文件')
      return
    }
    for (const file of accepted) {
      try {
        await upload.mutateAsync(file)
      } catch (err) {
        setNotice(`《${file.name}》上传失败：${err instanceof Error ? err.message : '未知错误'}`)
      }
    }
  }

  const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) void handleFiles(Array.from(e.target.files))
    e.target.value = ''
  }

  const openBook = async (book: BookWithProgress) => {
    setOpeningId(book.id)
    setNotice(null)
    // 后端记录的最近阅读位置优先，其次本地记忆，最后第一章
    if (book.last_article_id !== null) {
      navigate(`/read/${book.last_article_id}`)
      setOpeningId(null)
      return
    }
    try {
      const chapters = await queryClient.fetchQuery({
        queryKey: ['chapters', book.id],
        queryFn: () => api.chapters(book.id),
      })
      if (chapters.length === 0) {
        setNotice(`《${book.title}》暂无章节内容`)
        return
      }
      const saved = localStorage.getItem(`ln-last-article-${book.id}`)
      const target = chapters.find((c) => String(c.id) === saved) ?? chapters[0]
      navigate(`/read/${target.id}`)
    } catch (err) {
      setNotice(
        `打开《${book.title}》失败：${err instanceof ApiError ? err.message : '网络错误'}`,
      )
    } finally {
      setOpeningId(null)
    }
  }

  const requestDelete = (book: BookWithProgress) => {
    setDeleteTarget(book)
    setDeleteConflict(null)
    setDeleteError(null)
  }

  const books = booksQuery.data
  /* 关键词同时搜标题/作者/题材标签；难度筛选与关键词是与关系。
     40 本内置书不给筛选就是一堵墙，找书全靠翻（FR-386）。 */
  const filtered = useMemo(() => {
    if (!books) return []
    const kw = keyword.trim().toLowerCase()
    return books.filter((b) => {
      if (level !== 'all' && b.difficulty !== level) return false
      if (kw === '') return true
      return (
        b.title.toLowerCase().includes(kw) ||
        (b.author ?? '').toLowerCase().includes(kw) ||
        (b.tags ?? []).some((t) => t.toLowerCase().includes(kw)) ||
        (b.blurb ?? '').toLowerCase().includes(kw)
      )
    })
  }, [books, keyword, level])

  // 各档数量：筛选条上直接标出来，点之前就知道有多少本
  const levelCounts = useMemo(() => {
    const out: Record<string, number> = { all: books?.length ?? 0 }
    for (const b of books ?? []) {
      if (b.difficulty !== null) out[b.difficulty] = (out[b.difficulty] ?? 0) + 1
    }
    return out
  }, [books])

  // 按阅读状态三段分组：在读 / 未开始 / 已读完，空段不渲染
  const groups = useMemo(
    () =>
      STATE_ORDER.map((state) => ({
        state,
        items: filtered.filter((b) => b.state === state),
      })).filter((g) => g.items.length > 0),
    [filtered],
  )

  const resume = useMemo(() => (books ? pickResume(books) : null), [books])

  const renderCard = (book: BookWithProgress) => (
    <BookCard
      key={book.id}
      book={book}
      opening={openingId === book.id}
      onOpen={(b) => void openBook(b)}
      onDelete={requestDelete}
    />
  )

  return (
    <div className="main">
      <Topbar
        title="阅读"
        actions={
          <>
            <div className="search">
              <IconSearch />
              <input
                type="text"
                placeholder="搜索书名、作者…"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
              />
            </div>
            <button
              className="btn btn-primary"
              onClick={() => fileRef.current?.click()}
              disabled={upload.isPending}
            >
              <IconPlus />
              导入
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".epub,.pdf,.txt,.md"
              multiple
              hidden
              onChange={handleInputChange}
            />
          </>
        }
      />

      <div className="content">
        <div className="content-inner">
          {notice && (
            <div
              className="card"
              style={{
                padding: '10px 14px',
                marginBottom: 20,
                color: 'var(--err)',
                fontSize: 'var(--text-sm)',
              }}
            >
              {notice}
            </div>
          )}

          {resume && (
            <div className="resume-banner">
              <div className="rb-icon">
                <IconBook />
              </div>
              <div className="rb-main">
                <div className="rb-title">继续阅读《{resume.title}》</div>
                <div className="rb-meta">读到 {fmtPct(resume.progress_pct)}</div>
                <div className="rb-bar">
                  <i style={{ width: `${Math.min(resume.progress_pct, 100)}%` }} />
                </div>
              </div>
              <button
                className="btn btn-primary"
                onClick={() => navigate(`/read/${resume.last_article_id}`)}
              >
                继续阅读
              </button>
            </div>
          )}

          <section className="sec">
            <div className="sec-head sh-sec-head">
              我的书籍
              {books && <span className="chip">{filtered.length}</span>}
              <div style={{ flex: 1 }} />
              {/* 难度筛选（FR-386）：内置馆藏按 CEFR 梯度分档，进门先挑难度 */}
              {books !== undefined && (levelCounts.starter ?? 0) > 0 && (
                <div className="seg sh-levels">
                  {LEVELS.map(([key, label, hint]) => (
                    <button
                      key={key}
                      className={level === key ? 'active' : undefined}
                      title={hint}
                      onClick={() => setLevel(key)}
                    >
                      {label}
                      <em>{levelCounts[key] ?? 0}</em>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {booksQuery.isPending && <ShelfSkeleton />}

            {booksQuery.isError && (
              <div className="state-block">
                <IconAlert />
                <div>书架加载失败，请确认服务端已启动</div>
                <button className="btn btn-outline" onClick={() => void booksQuery.refetch()}>
                  重试
                </button>
              </div>
            )}

            {books && groups.length > 0 && (
              <>
                {groups.map((group, gi) => (
                  <div key={group.state}>
                    <div className="shelf-sub">
                      <span className={`dot-state ${group.state}`} />
                      {STATE_LABELS[group.state]}
                      <span className="chip">{group.items.length}</span>
                    </div>
                    <div className="book-grid">
                      {group.items.map(renderCard)}
                      {gi === groups.length - 1 && (
                        <ImportCard
                          uploading={upload.isPending}
                          onPick={() => fileRef.current?.click()}
                          onDropFiles={(files) => void handleFiles(files)}
                        />
                      )}
                    </div>
                  </div>
                ))}
              </>
            )}

            {books && groups.length === 0 && (
              <div className="book-grid">
                <ImportCard
                  uploading={upload.isPending}
                  onPick={() => fileRef.current?.click()}
                  onDropFiles={(files) => void handleFiles(files)}
                />
              </div>
            )}

            {books && books.length === 0 && (
              <div className="bk-meta" style={{ marginTop: 16 }}>
                书架空空如也，导入一本书开始精读吧（支持 epub / pdf / txt / md）。
              </div>
            )}
          </section>

          <ArticleSection />
        </div>
      </div>

      {deleteTarget && (
        <DeleteDialog
          book={deleteTarget}
          conflict={deleteConflict}
          pending={deleteBook.isPending}
          error={deleteError}
          onCancel={() => {
            setDeleteTarget(null)
            setDeleteConflict(null)
            setDeleteError(null)
          }}
          onConfirm={() =>
            deleteBook.mutate({ id: deleteTarget.id, force: deleteConflict !== null })
          }
        />
      )}
    </div>
  )
}
