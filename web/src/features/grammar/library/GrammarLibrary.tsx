/* 讲义库（模块 15 · Obsidian 式三栏阅读器）。

   左：文档树（按章节目录）· 中：整篇讲义渲染 · 右：本篇大纲 + 概念掌握度。
   取代原「概念专栏」的碎片式阅读——scholar 的讲义本来就是一篇篇完整文档，
   按 H2 切碎再读丢失了上下文；概念（FSRS 打分）保留在右栏，阅读回归整篇。

   词点击 → 词卡（与阅读器同一套 WordModal）；右键 → 查词/句子 AI 解析/
   朗读/AI 完善；工具栏 → 文内搜索/全库搜索/字号/行宽/大纲开关。 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useUrlValue } from '@/lib/urlState'
import { useWorkspaceStore, workspaceSnapshot } from '@/lib/workspaceStore'

import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconClose,
  IconSearch,
  IconSidebar,
  IconSparkle,
} from '../../../components/icons'
import { IconCopy } from '../../reader/readerIcons'
import type { DocCollection, DocSearchItem } from '../../../lib/api-grammar-docs'
import { annApi, docsApi } from '../../../lib/api-grammar-docs'
import { grammarApi } from '../../../lib/api-grammar'
import { playTts } from '../../../lib/audio'
import { WordModal } from '../../reader/WordModal'
import { useWordModalStore } from '../../reader/wordModalStore'
import { LectureLibrarySetup } from '../../settings/LectureLibrarySetup'

import type { AnnotationMark } from './annotate'
import { anchorFromSelection } from './annotate'
import type { WordScope } from './word-click'
import type { DrawerState } from './AiDrawer'
import { AiDrawer } from './AiDrawer'
import { sentenceSel } from '../../reader/sentencePick'
import { AnnotationPane } from './AnnotationPane'
import { activeHeadingAt, searchBlocks, tocFromMarkdown } from './doc-model'
import { FileTree } from './FileTree'
import type { LibMenuTarget } from './LibContextMenu'
import { LibContextMenu } from './LibContextMenu'
import { ObsidianMarkdown } from './ObsidianMarkdown'
import { Outline } from './Outline'
import { scrollWithin } from './reader-scroll'
import '../../reader/reader-m5.css'
import './library.css'

const LAST_DOC_KEY = 'glib:last-doc'
const SIZE_KEY = 'glib:size'
const WIDE_KEY = 'glib:wide'
const SCOPE_KEY = 'glib:word-scope'
const SIZE_MIN = 15
const SIZE_MAX = 22

/** 右键落点算不算「有英文句可解析」：连续 3 个英文词起步 */
const EN_RUN = /([A-Za-z'’-]+[\s,]+){2}[A-Za-z]/

/** 文内搜索能跳到的叶子块 */
const BLOCK_SELECTOR = 'p, pre, li, td, th, h1, h2, h3, h4, h5, h6'

function readPref(key: string, fallback: number): number {
  const v = Number(localStorage.getItem(key))
  return Number.isFinite(v) && v >= SIZE_MIN && v <= SIZE_MAX ? v : fallback
}

/* ---- 全库搜索浮层 ---- */

function SearchOverlay({
  onOpen,
  onClose,
  collection,
  libraryId,
}: {
  collection: DocCollection
  libraryId?: string
  onOpen: (path: string, term: string) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250)
    return () => clearTimeout(t)
  }, [q])
  const results = useQuery({
    queryKey: ['glib-search', collection, libraryId, debounced],
    queryFn: () => docsApi.search(debounced, collection, libraryId),
    enabled: debounced.length >= 2,
  })

  return (
    <div className="glib-search-backdrop" onClick={onClose}>
      <div className="glib-search-modal" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          placeholder="搜遍全部讲义…（至少 2 个字符）"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
          }}
        />
        <div className="glib-search-results">
          {results.isLoading && <p className="glib-search-note">搜索中…</p>}
          {results.data?.items.length === 0 && <p className="glib-search-note">没有命中</p>}
          {(results.data?.items ?? []).map((item: DocSearchItem) => (
            <button
              key={item.path}
              className="glib-search-item"
              onClick={() => {
                onOpen(item.path, debounced)
                onClose()
              }}
            >
              <div className="glib-search-item-head">
                <b>{item.name}</b>
                <span>
                  {item.chapter !== null ? `${item.chapter} · ` : ''}
                  {item.n} 处
                </span>
              </div>
              {item.hits.slice(0, 3).map((h) => (
                <p key={h.line}>{h.text}</p>
              ))}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ---- 主组件 ---- */

export function GrammarLibrary({ openSlug, collection = 'grammar', libraryId, onBackToLibraries }: { openSlug: string | null; collection?: DocCollection; libraryId?: string; onBackToLibraries?: () => void }) {
  const [docPath, setDocPath] = useUrlValue<string>('doc', '')
  const [sourceAnchor] = useUrlValue<string>('anchor', '')
  const path = docPath || null
  const setPath = useCallback((value: string | null) => setDocPath(value ?? ''), [setDocPath])
  const [treeOpen, setTreeOpen] = useState(true)
  const [outlineOpen, setOutlineOpen] = useState(true)
  const panesRef = useRef<HTMLDivElement>(null)
  const compactRef = useRef(false)
  useLayoutEffect(() => {
    const panes = panesRef.current
    if (panes === null) return
    const sync = () => {
      const compact = panes.clientWidth <= 780
      if (compact && !compactRef.current) {
        setTreeOpen(false)
        setOutlineOpen(false)
      }
      compactRef.current = compact
    }
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(panes)
    return () => observer.disconnect()
  }, [])
  const [size, setSize] = useState(() => readPref(SIZE_KEY, 17))
  const [wide, setWide] = useState(() => localStorage.getItem(WIDE_KEY) === '1')
  /* 词点击范围。默认 all——代码块与引用里的例句正是最想查词的地方；
     嫌代码块下划线密的人可以切到「只切散文」 */
  const [wordScope, setWordScope] = useState<WordScope>(() =>
    localStorage.getItem(SCOPE_KEY) === 'prose' ? 'prose' : 'all',
  )
  const [drawer, setDrawer] = useState<DrawerState | null>(null)
  const [menu, setMenu] = useState<LibMenuTarget | null>(null)
  const [globalSearch, setGlobalSearch] = useState(false)
  const [term, setTerm] = useState('')
  const [hitCursor, setHitCursor] = useState(0)
  const [activeHeading, setActiveHeading] = useState(0)
  const [propsOpen, setPropsOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const articleRef = useRef<HTMLDivElement | null>(null)
  // 从概念跳转进来时要滚到对应标题，等正文渲染完再滚
  const pendingHeading = useRef<{ path: string; title: string } | null>(null)
  const displayedPath = useRef<string | null>(null)
  const restoringPosition = useRef(false)
  const memoryReady = useWorkspaceStore(s => s.ready)
  const openWord = useWordModalStore((s) => s.openWord)

  const qc = useQueryClient()
  const [openAnn, setOpenAnn] = useState<number | null>(null)

  const tree = useQuery({ queryKey: ['glib-tree', collection, libraryId], queryFn: () => docsApi.tree(collection, libraryId), staleTime: Infinity })
  const anns = useQuery({
    queryKey: ['glib-anns', path],
    queryFn: () => annApi.list(path ?? ''),
    enabled: path !== null,
  })
  const annMarks = useMemo<AnnotationMark[]>(
    () =>
      (anns.data?.items ?? []).map((a) => ({
        id: a.id,
        quote: a.quote,
        prefix: a.prefix,
        suffix: a.suffix,
        startHint: a.start_hint,
        color: a.color,
      })),
    [anns.data],
  )
  const createAnn = useMutation({
    mutationFn: (body: Parameters<typeof annApi.create>[0]) => annApi.create(body),
    onSuccess: (row) => {
      void qc.invalidateQueries({ queryKey: ['glib-anns', path] })
      setOpenAnn(row.id)
      setDrawer(null)
    },
    onError: (e: Error) => toast.error(e.message),
  })
  const doc = useQuery({
    queryKey: ['glib-doc', path],
    queryFn: () => docsApi.content(path ?? ''),
    staleTime: Infinity,
    enabled: path !== null,
  })

  // 句子解构那边点概念跳过来：概念 → 所在文档 + 标题
  useEffect(() => {
    if (openSlug === null) return
    let stale = false
    void grammarApi.concept(openSlug).then((c) => {
      if (stale) return
      pendingHeading.current = { path: c.source_path, title: c.title }
      setPath(c.source_path)
    })
    return () => {
      stale = true
    }
  }, [openSlug])

  const openDoc = useCallback(
    (p: string) => {
      if (compactRef.current) setTreeOpen(false)
      if (p === path) return
      pendingHeading.current = null
      setPath(p)
      setTerm('')
      setHitCursor(0)
      setActiveHeading(0)
      setMenu(null)
      setDrawer(null)
      setOpenAnn(null)
      localStorage.setItem(`${LAST_DOC_KEY}:${collection}${libraryId ? `:${libraryId}` : ''}`, p)
    },
    [path, collection, libraryId],
  )

  // 首次进入或原目录迁移后缓存路径已失效：打开当前目录的第一篇。
  useEffect(() => {
    if (tree.data === undefined) return
    const available = [
      ...tree.data.loose,
      ...tree.data.chapters.flatMap((chapter) => chapter.docs),
    ]
    if (path !== null && available.some((docRef) => docRef.path === path)) return
    const saved = localStorage.getItem(`${LAST_DOC_KEY}:${collection}${libraryId ? `:${libraryId}` : ''}`)
    const first = available.find(doc => doc.path === saved) ?? available[0]
    if (first !== undefined) openDoc(first.path)
    else setPath(null)
  }, [path, tree.data, openDoc, collection, libraryId])

  /* 内联箭头会击穿 ObsidianMarkdown 的 memo：每次滚动改高亮都重渲染正文，
     而正文重渲染又会重建整棵 DOM（见 ObsidianMarkdown 里那条注释）。 */
  const onAnnotationClick = useCallback((id: number) => {
    setDrawer(null)
    setOpenAnn(id)
  }, [])

  const body = doc.data?.body ?? ''
  const toc = useMemo(() => tocFromMarkdown(body), [body])
  const hasOwnH1 = toc.some((e) => e.level === 1)

  // 引用稳定：ObsidianMarkdown 是 memo 组件，内联函数会让它每次白重渲染
  const onWikiLink = useCallback(
    (target: string) => {
      // [[双链]] 按文件名找目标文档
      const all = [
        ...(tree.data?.loose ?? []),
        ...(tree.data?.chapters.flatMap((c) => c.docs) ?? []),
      ]
      const hit = all.find((x) => x.name === target || target.startsWith(x.name))
      if (hit !== undefined) openDoc(hit.path)
      else toast.info(`讲义库里没有「${target}」`)
    },
    [tree.data, openDoc],
  )

  const headingEls = () =>
    articleRef.current?.querySelector('.glib-md')?.querySelectorAll<HTMLElement>(
      'h1, h2, h3, h4, h5, h6',
    ) ?? []

  const jumpToHeading = useCallback((index: number) => {
    const el = headingEls()[index]
    if (el !== undefined && scrollRef.current !== null) scrollWithin(scrollRef.current, el)
    // 不等滚动事件回来再算：部分环境（内嵌浏览器）程序化滚动不派发
    // scroll 事件，而且点了哪条就该立刻亮哪条
    setActiveHeading(index)
  }, [])

  // 新正文提交后再定位，避免先把旧正文滚回顶部。
  useLayoutEffect(() => {
    if (doc.data === undefined || doc.data.path !== path) return
    const want = pendingHeading.current
    if (want === null || want.path !== path) return
    const hit = toc.find((e) => e.text === want.title || e.text.endsWith(want.title))
    pendingHeading.current = null
    if (hit !== undefined) { displayedPath.current = path; jumpToHeading(hit.index) }
  }, [doc.data, path, toc, jumpToHeading])

  useLayoutEffect(() => {
    if (!sourceAnchor || doc.data?.path !== path || !articleRef.current || !scrollRef.current) return
    const target = articleRef.current.querySelector<HTMLElement>(`#${CSS.escape(sourceAnchor)}`)
    if (target) scrollWithin(scrollRef.current, target)
  }, [doc.data, path, sourceAnchor])

  useLayoutEffect(() => {
    const scroller = scrollRef.current
    const article = articleRef.current
    if (!memoryReady || !path || !scroller || !article || doc.data?.path !== path || displayedPath.current === path) return
    const key = `lecture:${path}`
    const saved = workspaceSnapshot('grammar', key)
    restoringPosition.current = true
    const restore = () => {
      if (pendingHeading.current || !restoringPosition.current) return
      const headings = [...headingEls()]
      const heading = saved.anchor ? headings.find(el => el.textContent === saved.anchor) : undefined
      scroller.scrollTop = heading
        ? heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop + (saved.offset ?? 0)
        : saved.scroll?.body ?? 0
    }
    if (displayedPath.current !== path) restore()
    displayedPath.current = path
    const resize = new ResizeObserver(restore)
    resize.observe(article)
    const stop = () => { restoringPosition.current = false; resize.disconnect() }
    const timer = window.setTimeout(stop, 3500)
    scroller.addEventListener('wheel', stop, { passive: true })
    scroller.addEventListener('pointerdown', stop)
    scroller.addEventListener('keydown', stop)
    return () => {
      stop(); clearTimeout(timer)
      scroller.removeEventListener('wheel', stop)
      scroller.removeEventListener('pointerdown', stop)
      scroller.removeEventListener('keydown', stop)
    }
  }, [memoryReady, doc.data?.path, path])

  /* 读到哪一节：滚动时找最后一个越过视口上沿的标题。

     > [!danger] 不能每个滚动事件都去量每个标题
     >
     > 原来的写法在每次 scroll 事件里跑一遍 `querySelectorAll` 再对**每个标题**
     > 调 `getBoundingClientRect()`。这篇《英语语法的历程与核心概念》有 25 个标题，
     > 而滚动事件一秒能来上百次——等于每秒几千次强制同步重排，
     > 主线程被占住，滚动就是一顿一顿的。
     >
     > 改成：标题位置只量一次存起来（相对文档顶部的 `offsetTop`，不随滚动变），
     > 滚动时只做一次二分查找，零布局读取；再用 rAF 把一帧内的多次事件并成一次。
     >
     > 缓存的失效判据是 `scrollHeight`：7 张 mermaid 是异步渲染的，画完文档会变高，
     > 标题位置随之下移。拿高度当版本号，比挂 ResizeObserver 简单，也不受
     > 「RO 在自动化面板里一次都不回调」那条坑影响。 */
  const offsets = useRef<{ tops: number[]; height: number }>({ tops: [], height: -1 })
  const rafId = useRef<number | null>(null)

  const measure = useCallback(() => {
    const scroller = scrollRef.current
    if (scroller === null) return offsets.current
    if (offsets.current.height !== scroller.scrollHeight) {
      /* 位置要相对**滚动容器的内容**算，不能用 `offsetTop`。
         `offsetTop` 是相对 `offsetParent` 的，而 `.glib-doc` 与 `.glib-article`
         都是 `position: static`，offsetParent 一路上溯到了 `<body>`——
         于是它把滚动容器上方那截（顶栏 + 标签页，实测 83px）也算了进去，
         判定线整体偏移，大纲高亮会静默错一条。这个式子与
         `getBoundingClientRect()` 的口径完全一致，且只在缓存失效时算一次。 */
      const base = scroller.getBoundingClientRect().top - scroller.scrollTop
      offsets.current = {
        tops: [...headingEls()].map((el) => el.getBoundingClientRect().top - base),
        height: scroller.scrollHeight,
      }
    }
    return offsets.current
  }, [])

  const onScroll = useCallback(() => {
    if (rafId.current !== null) return
    rafId.current = requestAnimationFrame(() => {
      rafId.current = null
      const scroller = scrollRef.current
      if (scroller === null) return
      const { tops } = measure()
      if (tops.length === 0) return
      // 视口上沿往下 90px 作为判定线，与原来的口径一致
      const index = activeHeadingAt(tops, scroller.scrollTop + 90)
      setActiveHeading(index)
      if (path && !restoringPosition.current) {
        const key = `lecture:${path}`
        useWorkspaceStore.getState().put('grammar', key, {
          ...workspaceSnapshot('grammar', key),
          anchor: headingEls()[index]?.textContent ?? undefined,
          offset: scroller.scrollTop - (tops[index] ?? 0), scroll: { body: scroller.scrollTop },
        })
      }
    })
  }, [measure, path])

  // 换文档时作废缓存，否则新文档沿用旧标题位置，大纲高亮全错
  useEffect(() => {
    offsets.current = { tops: [], height: -1 }
  }, [body])

  useEffect(
    () => () => {
      if (rafId.current !== null) cancelAnimationFrame(rafId.current)
    },
    [],
  )

  /* ---- 文内搜索：块级命中 + 逐个跳 ---- */
  const [hits, setHits] = useState<HTMLElement[]>([])
  useLayoutEffect(() => {
    articleRef.current?.querySelectorAll('.glib-hit').forEach((el) => el.classList.remove('glib-hit'))
    if (term.trim() === '' || articleRef.current === null || doc.data === undefined) {
      setHits([])
      return
    }
    const els = [...articleRef.current.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)].filter(
      (el) => el.querySelector(BLOCK_SELECTOR) === null,
    )
    const idx = searchBlocks(
      els.map((el) => el.textContent ?? ''),
      term,
    )
    setHits(idx.map((i) => els[i]))
  }, [term, body, doc.data?.path])

  const jumpToHit = useCallback(
    (cursor: number) => {
      const el = hits[cursor]
      if (el === undefined) return
      articleRef.current
        ?.querySelectorAll('.glib-hit')
        .forEach((n) => n.classList.remove('glib-hit'))
      el.classList.add('glib-hit')
      if (scrollRef.current !== null) scrollWithin(scrollRef.current, el, 'center')
    },
    [hits],
  )

  useEffect(() => {
    if (hits.length > 0) {
      setHitCursor(0)
      jumpToHit(0)
    }
  }, [hits, jumpToHit])

  const stepHit = (dir: 1 | -1) => {
    if (hits.length === 0) return
    const next = (hitCursor + dir + hits.length) % hits.length
    setHitCursor(next)
    jumpToHit(next)
  }

  /* ---- 右键菜单 ---- */
  const onContextMenu = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    if (articleRef.current?.contains(target) !== true) return
    e.preventDefault()
    const word = target.classList.contains('glib-w') ? (target.textContent ?? null) : null
    const annEl = target.closest<HTMLElement>('mark.glib-ann')
    const annId = annEl === null ? null : Number(annEl.dataset.ann)
    const rawSel = window.getSelection()?.toString().trim() ?? ''
    const selection = rawSel === '' ? null : rawSel
    const block = target.closest<HTMLElement>(BLOCK_SELECTOR)
    const ctx = (block?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 400)
    const sentence = EN_RUN.test(selection ?? ctx) ? (selection ?? ctx) : null
    setMenu({ x: e.clientX, y: e.clientY, annId, word, sentence, selection })
  }

  const chapter = path?.includes('/') === true ? path.split('/')[0] : null
  const d = doc.data
  const annOpen = (anns.data?.items ?? []).find((a) => a.id === openAnn)

  return (
    <div className="glib">
      <div className="glib-toolbar">
        <button
          className={`icon-btn ${treeOpen ? 'active' : ''}`}
          title="文档树"
          onClick={() => {
            setTreeOpen((v) => !v)
            if (compactRef.current) setOutlineOpen(false)
          }}
        >
          <IconSidebar />
        </button>
        <div className="glib-crumb" title={path ?? ''}>
          {chapter !== null && <span>{chapter}</span>}
          {chapter !== null && <i>/</i>}
          <b>{d?.name ?? '选择讲义'}</b>
        </div>

        <div className="glib-tools">
          {onBackToLibraries && <button className="glib-library-back" onClick={onBackToLibraries}>返回软件库</button>}
          <div className="glib-find">
            <IconSearch />
            <input
              placeholder="文内搜索…"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') stepHit(e.shiftKey ? -1 : 1)
                if (e.key === 'Escape') setTerm('')
              }}
            />
            {term !== '' && (
              <>
                <i>
                  {hits.length === 0 ? '0' : hitCursor + 1}/{hits.length}
                </i>
                <button className="icon-btn" title="上一处" onClick={() => stepHit(-1)}>
                  <IconChevronDown className="glib-flip-y" />
                </button>
                <button className="icon-btn" title="下一处" onClick={() => stepHit(1)}>
                  <IconChevronDown />
                </button>
              </>
            )}
          </div>
          <button className="icon-btn" title="全库搜索" onClick={() => setGlobalSearch(true)}>
            <IconSearch />
          </button>
          <span className="glib-toolbar-sep" />
          <button
            className="icon-btn"
            title="上一篇"
            disabled={d?.prev == null}
            onClick={() => d?.prev != null && openDoc(d.prev.path)}
          >
            <IconChevronLeft />
          </button>
          <button
            className="icon-btn"
            title="下一篇"
            disabled={d?.next == null}
            onClick={() => d?.next != null && openDoc(d.next.path)}
          >
            <IconChevronRight />
          </button>
          <span className="glib-toolbar-sep" />
          <button
            className="glib-size-btn"
            title="缩小字号"
            disabled={size <= SIZE_MIN}
            onClick={() => {
              const v = size - 1
              setSize(v)
              localStorage.setItem(SIZE_KEY, String(v))
            }}
          >
            A-
          </button>
          <button
            className="glib-size-btn"
            title="放大字号"
            disabled={size >= SIZE_MAX}
            onClick={() => {
              const v = size + 1
              setSize(v)
              localStorage.setItem(SIZE_KEY, String(v))
            }}
          >
            A+
          </button>
          <button
            className={`glib-size-btn ${wide ? 'active' : ''}`}
            title="行宽切换"
            onClick={() => {
              setWide((v) => {
                localStorage.setItem(WIDE_KEY, v ? '0' : '1')
                return !v
              })
            }}
          >
            宽
          </button>
          <button
            className={`glib-size-btn ${wordScope === 'all' ? 'active' : ''}`}
            title={
              wordScope === 'all'
                ? '点词范围：全文（含代码块与引用）'
                : '点词范围：仅散文（代码块不可点）'
            }
            onClick={() => {
              setWordScope((v) => {
                const next: WordScope = v === 'all' ? 'prose' : 'all'
                localStorage.setItem(SCOPE_KEY, next)
                return next
              })
            }}
          >
            词
          </button>
          <span className="glib-toolbar-sep" />
          <button
            className="icon-btn"
            title="AI 完善这篇文档"
            disabled={d === undefined}
            onClick={() => setDrawer({ kind: 'improve', selection: null })}
          >
            <IconSparkle />
          </button>
          <button
            className="icon-btn"
            title="复制全文 Markdown"
            disabled={d === undefined}
            onClick={() => {
              void navigator.clipboard.writeText(d?.body ?? '')
              toast.success('已复制全文')
            }}
          >
            <IconCopy />
          </button>
          <button
            className={`icon-btn ${outlineOpen ? 'active' : ''}`}
            title="大纲"
            onClick={() => {
              setOutlineOpen((v) => !v)
              if (compactRef.current) setTreeOpen(false)
            }}
          >
            <IconSidebar className="glib-flip" />
          </button>
        </div>
      </div>

      <div className="glib-panes" ref={panesRef}>
        {treeOpen && tree.data !== undefined && (
          <FileTree tree={tree.data} current={path} onOpen={openDoc} stateKey={`${collection}:${libraryId ?? 'default'}`} />
        )}

        <div className="glib-doc" ref={scrollRef} onScroll={onScroll} aria-busy={doc.isLoading}>
          {doc.isLoading && <p className="glib-note">加载中…</p>}
          {doc.isError && <p className="glib-note err">{(doc.error as Error).message}</p>}
          {!tree.isLoading &&
            tree.data !== undefined &&
            tree.data.loose.length === 0 &&
            tree.data.chapters.length === 0 && (
              <div className="glib-library-empty">
                <h2>选择你的讲义目录</h2>
                <p>讲义正文保存在本机文件中。选择原来的 Markdown 目录即可恢复讲义库。</p>
                <LectureLibrarySetup compact collection={collection} />
              </div>
            )}
          {d !== undefined && (
            <article
              key={d.path}
              className={`glib-article ${wide ? 'wide' : ''}`}
              style={{ '--glib-size': `${size}px` } as React.CSSProperties}
              ref={articleRef}
              onContextMenu={onContextMenu}
            >
              <header className="glib-doc-head glib-nowords">
                {/* 正文自带 `# 标题` 时不再补一个 h1——补了就是同名标题连出两遍。
                    没有 H1 的讲义才由这里兜底，否则整篇没有标题 */}
                {!hasOwnH1 && <h1>{d.props.title ?? d.name}</h1>}
                {/* 属性开关与字数收在同一条细线上：它们是正文之前的元信息，
                    各占一行会把首屏可读高度白白吃掉两行 */}
                <div className="glib-doc-meta">
                  <button className="glib-props-toggle" onClick={() => setPropsOpen((v) => !v)}>
                    {propsOpen ? <IconChevronDown /> : <IconChevronRight />}
                    笔记属性
                  </button>
                  <span>{d.words.toLocaleString('en-US')} 字符</span>
                  <span>更新于 {d.mtime.slice(0, 10)}</span>
                </div>
                {propsOpen && (
                  <dl className="glib-props">
                    {d.props.date != null && (
                      <>
                        <dt>date</dt>
                        <dd>{d.props.date}</dd>
                      </>
                    )}
                    {d.props.tags.length > 0 && (
                      <>
                        <dt>tags</dt>
                        <dd>
                          {d.props.tags.map((t) => (
                            <span key={t} className="glib-tag">
                              {t}
                            </span>
                          ))}
                        </dd>
                      </>
                    )}
                    {d.props.categories != null && (
                      <>
                        <dt>categories</dt>
                        <dd>{d.props.categories}</dd>
                      </>
                    )}
                    {d.props.description != null && (
                      <>
                        <dt>description</dt>
                        <dd>{d.props.description}</dd>
                      </>
                    )}
                  </dl>
                )}
              </header>

              <ObsidianMarkdown
                markdown={d.body}
                documentPath={d.path}
                softwareId={collection === 'software' ? libraryId : undefined}
                onWikiLink={onWikiLink}
                onWordClick={openWord}
                wordScope={wordScope}
                annotations={annMarks}
                onAnnotationClick={onAnnotationClick}
              />

              <footer className="glib-doc-foot glib-nowords">
                {d.prev != null ? (
                  <button onClick={() => d.prev != null && openDoc(d.prev.path)}>
                    <IconChevronLeft /> {d.prev.name}
                  </button>
                ) : (
                  <span />
                )}
                {d.next != null ? (
                  <button onClick={() => d.next != null && openDoc(d.next.path)}>
                    {d.next.name} <IconChevronRight />
                  </button>
                ) : (
                  <span />
                )}
              </footer>
            </article>
          )}
        </div>

        {/* 右栏三选一：大纲 / AI 抽屉 / 批注。批注排在最前——点开一条批注
            时想看的就是它，把大纲盖住是对的 */}
        {annOpen !== undefined && (
          <aside className="glib-ai" aria-label="批注">
            <div className="glib-ai-head">
              <b>批注</b>
              <button className="icon-btn" title="关闭" onClick={() => setOpenAnn(null)}>
                <IconClose />
              </button>
            </div>
            <div className="glib-ai-body">
              <AnnotationPane ann={annOpen} onClose={() => setOpenAnn(null)} />
            </div>
          </aside>
        )}
        {annOpen === undefined && drawer !== null && (
          <AiDrawer
            state={drawer}
            doc={d ?? null}
            toc={toc}
            onClose={() => setDrawer(null)}
            onApplied={() => void doc.refetch()}
            onJumpSection={jumpToHeading}
          />
        )}
        {annOpen === undefined && drawer === null && outlineOpen && (
          <Outline
            toc={toc}
            activeIndex={activeHeading}
            docPath={path}
            onJump={jumpToHeading}
            annotations={anns.data?.items ?? []}
            onOpenAnnotation={setOpenAnn}
          />
        )}
      </div>

      {menu !== null && (
        <LibContextMenu
          target={menu}
          onClose={() => setMenu(null)}
          actions={{
            onLookup: (word, context) => openWord(word, context, undefined, {
              kind: 'grammar',
              label: d?.props.title ?? d?.name ?? '语法讲义',
              locator: { document: path ?? '', section: activeHeading },
            }),
            onAnalyze: (sentence) => setDrawer({ kind: 'sentence', sel: sentenceSel(sentence) }),
            onSpeak: (text) => playTts(text),
            onCopy: (text) => {
              void navigator.clipboard.writeText(text)
              toast.success('已复制')
            },
            onImprove: (selection) => setDrawer({ kind: 'improve', selection }),
            onAnnotate: () => {
              const root = articleRef.current?.querySelector('.glib-md')
              const sel = window.getSelection()
              if (root == null || sel === null || path === null) return
              const anchor = anchorFromSelection(root, sel)
              if (anchor === null) return
              createAnn.mutate({
                path,
                quote: anchor.quote,
                prefix: anchor.prefix,
                suffix: anchor.suffix,
                start_hint: anchor.startHint,
              })
            },
            onOpenAnnotation: (id) => {
              setDrawer(null)
              setOpenAnn(id)
            },
          }}
        />
      )}
      {globalSearch && (
        <SearchOverlay
          collection={collection}
          libraryId={libraryId}
          onOpen={(p, q) => {
            openDoc(p)
            setTerm(q)
          }}
          onClose={() => setGlobalSearch(false)}
        />
      )}
      <WordModal />
    </div>
  )
}
