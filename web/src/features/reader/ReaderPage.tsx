import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'

import {
  IconAlert,
  IconChart,
  IconDownload,
  IconSearch,
  IconSidebar,
  IconSparkle,
  IconSpeaker,
} from '../../components/icons'
import { VoicePicker } from '../../components/VoicePicker'
import { api } from '../../lib/api'
import { readerApi, articleProgressOf } from '../../lib/api-reader-m5'
import type { Annotation, AnnotationColor } from '../../lib/api-reader-m5'
import { stopTts } from '../../lib/audio'
import { IconMascot, MascotWidget } from '../mascot/MascotWidget'
import { useMascotStore } from '../mascot/mascotStore'
import { useInlineVoiceCompanion } from '../mascot/useInlineVoiceCompanion'
import { CompanionPanel } from './CompanionPanel'
import { PhrasePanel } from './PhrasePanel'
import { PlayerBar } from './PlayerBar'
import { ProseView } from './ProseView'
import { SelectionBar } from '../companion/SelectionBar'
import { useCompanionContext } from '../companion/contextStore'
import { SentencePanel } from './SentencePanel'
import { Toc } from './Toc'
import { WordCard } from './WordCard'
import { WordModal } from './WordModal'
import { useWordModalStore } from './wordModalStore'
import {
  AnnotationPopover,
  AnnotationsPanel,
  SelectionToolbar,
  readParagraphSelection,
  trimSelectionRange,
} from './annotations'
import { IconHighlighter } from './local-icons'
import { usePrefStore } from '../../lib/prefStore'
import { usePlayerStore } from './playerStore'
import type { PlayableSentence } from './playerStore'
import { useReaderStore } from './readerStore'
import type { PanelTab, ViewMode } from './readerStore'
import { useVocabCollectionStore } from '../../lib/vocabCollectionStore'
import { useReadingProgress } from './useReadingProgress'
import './reader-m5.css'
import './reader-tools.css'
import { Topbar } from '../../components/Topbar'
import { ContextMenu } from './ContextMenu'
import type { ContextMenuActions, MenuTarget } from './ContextMenu'
import { BookmarksPanel, ShortcutsDialog, StatsPanel } from './ReaderPanels'
import { SearchBar } from './SearchBar'
import type { SearchHit } from './SearchBar'
import { TypographyPanel } from './TypographyPanel'
import {
  IconAutoScroll,
  IconBookmark,
  IconExpand,
  IconFocus,
  IconKeyboard,
  IconMore,
  IconShrink,
  IconTranslate,
  IconTypography,
} from './readerIcons'
import { useReaderTools, useSearchHighlight, useVisibleParagraph } from './useReaderTools'
import { saveFile } from '@/lib/shell'

const VIEW_MODES: Array<{ value: ViewMode; label: string }> = [
  { value: 'orig', label: '原文' },
  { value: 'both', label: '双语' },
  { value: 'trans', label: '译文' },
]

const PANEL_TABS: Array<{ value: PanelTab; label: string }> = [
  { value: 'learn', label: '学习卡' },
  { value: 'sentence', label: '句子' },
  { value: 'companion', label: 'AI 陪读' },
]

const EMPTY_TRANSLATIONS: Record<string, string> = {}

function ProseSkeleton() {
  return (
    <div>
      <div className="skeleton skeleton-line" style={{ width: '45%', height: 26 }} />
      <div className="skeleton skeleton-line" style={{ width: '30%', marginTop: 14 }} />
      <div style={{ marginTop: 36, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {Array.from({ length: 10 }, (_, i) => (
          <div
            key={i}
            className="skeleton skeleton-line"
            style={{ width: `${100 - (i % 4) * 8}%`, height: 16 }}
          />
        ))}
      </div>
    </div>
  )
}

function EmptyPanel() {
  return (
    <div className="panel-empty">
      <IconSparkle />
      <div>
        点击正文中的词查看学习卡
        <br />
        拖选相邻词元可解释词组
      </div>
    </div>
  )
}

/** 选区浮动工具条状态 */
interface SelToolbarState {
  paragraphId: number
  start: number
  end: number
  text: string
  x: number
  y: number
}

/** 批注编辑浮层状态 */
interface AnnPopState {
  ann: Annotation
  x: number
  y: number
}

function popPosition(cx: number, bottom: number): { x: number; y: number } {
  const x = Math.min(Math.max(cx - 130, 8), Math.max(8, window.innerWidth - 270))
  const y = Math.min(bottom + 8, window.innerHeight - 220)
  return { x, y }
}

export function ReaderPage() {
  const { articleId = '' } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  // 词库出处跳转：?sid= 指定句子，加载后定位并短暂高亮
  const [searchParams] = useSearchParams()
  const jumpSid = searchParams.get('sid')

  const selection = useReaderStore((s) => s.selection)
  const tocOpen = useReaderStore((s) => s.tocOpen)
  const toggleToc = useReaderStore((s) => s.toggleToc)
  const clearSelection = useReaderStore((s) => s.clearSelection)
  const setCollected = useVocabCollectionStore((state) => state.setCollected)
  const viewMode = useReaderStore((s) => s.viewMode)
  const setViewMode = useReaderStore((s) => s.setViewMode)
  const panelTab = useReaderStore((s) => s.panelTab)
  const setPanelTab = useReaderStore((s) => s.setPanelTab)
  const selectPhrase = useReaderStore((s) => s.selectPhrase)
  const clickableWords = useReaderStore((s) => s.clickableWords)
  const openPhraseModal = useWordModalStore((s) => s.openPhrase)
  const setClickableWords = useReaderStore((s) => s.setClickableWords)

  const playerVisible = usePlayerStore((s) => s.visible)
  const togglePlayer = usePlayerStore((s) => s.toggleVisible)

  // 看板娘开关 + 驻页语音陪读生命周期（切章/离开阅读页时自动结束会话）
  const mascotOn = useMascotStore((s) => s.enabled)
  const setMascotOn = useMascotStore((s) => s.setEnabled)
  useInlineVoiceCompanion(articleId)

  const articleQuery = useQuery({
    queryKey: ['article', articleId],
    queryFn: () => api.article(articleId),
    enabled: articleId !== '',
  })
  const article = articleQuery.data
  // 独立文章（URL/粘贴导入）book_id 为 null：无章节目录，面包屑直接"书架›文章名"
  const standalone = article !== undefined && article.book_id === null
  const bookId = article?.book_id ?? undefined

  const booksQuery = useQuery({ queryKey: ['books'], queryFn: api.books })
  const book = useMemo(
    () => booksQuery.data?.find((b) => b.id === bookId),
    [booksQuery.data, bookId],
  )

  const chaptersQuery = useQuery({
    queryKey: ['chapters', bookId],
    queryFn: () => api.chapters(bookId!),
    enabled: bookId !== undefined,
  })

  // 切章：清选择、停朗读
  useEffect(() => {
    clearSelection()
    stopTts()
  }, [articleId, clearSelection])

  // 离开阅读页时停止整章连读
  useEffect(() => () => usePlayerStore.getState().stop(), [])

  // 记住本书最近打开的章节（独立文章无书，不记）
  useEffect(() => {
    if (article && article.book_id !== null) {
      localStorage.setItem(`ln-last-article-${article.book_id}`, String(article.id))
    }
  }, [article])

  // 全文可学词元（去重小写）
  const words = useMemo(() => {
    if (!article) return []
    const set = new Set<string>()
    for (const p of article.paragraphs) {
      for (const t of p.tokens) if (t[3]) set.add(t[2])
    }
    return [...set]
  }, [article])

  const totalTokens = useMemo(() => {
    if (!article) return 0
    let n = 0
    for (const p of article.paragraphs) for (const t of p.tokens) if (t[3]) n++
    return n
  }, [article])

  /* 实际渲染出来的段落：ProseView 会跳过与标题重复的首段 heading。
     搜索、书签、统计都必须用这一份，否则会指向页面上不存在的锚点
     （首版搜索计数 2 而页面只有 1 处高亮，根因就是这个）。 */
  const visibleParagraphs = useMemo(() => {
    if (!article) return []
    const first = article.paragraphs[0]
    const skipFirst =
      first !== undefined &&
      first.kind === 'heading' &&
      first.text.trim() === article.title.trim()
    return skipFirst ? article.paragraphs.slice(1) : article.paragraphs
  }, [article])

  // 章节句子队列：与 ProseView 一致地跳过重复标题首段，供整章连读与翻译进度使用
  const flatSentences = useMemo<PlayableSentence[]>(() => {
    if (!article) return []
    const first = article.paragraphs[0]
    const skipFirst =
      first !== undefined &&
      first.kind === 'heading' &&
      first.text.trim() === article.title.trim()
    const out: PlayableSentence[] = []
    article.paragraphs.forEach((p, i) => {
      if (i === 0 && skipFirst) return
      const sents = [...p.sentences].sort((a, b) => a[1] - b[1])
      for (const [sid, cs, ce] of sents) {
        const text = p.text.slice(cs, ce).trim()
        if (text) out.push({ sentenceId: sid, paragraphId: p.id, text })
      }
    })
    return out
  }, [article])

  // 章节数据就绪后灌入播放队列
  useEffect(() => {
    if (article) {
      usePlayerStore.getState().setChapter(String(article.id), flatSentences)
    }
  }, [article, flatSentences])

  // 音色默认值不再由前端注入：/api/tts 按 scene 取配置中心的场景绑定，
  // 用户在朗读条临时选过的音色仅本会话生效（audio.ts sessionVoice）


  // 生词状态批量查询 → 写入 store 驱动 .vocab 标记
  const vocabQuery = useQuery({
    queryKey: ['vocab-status', articleId],
    queryFn: () => api.vocabStatus(words),
    enabled: words.length > 0,
    retry: false,
  })
  useEffect(() => {
    if (vocabQuery.data) setCollected(vocabQuery.data.collected)
  }, [vocabQuery.data, setCollected])

  const collected = useVocabCollectionStore((state) => state.collected)
  const vocabCount = useMemo(
    () => words.reduce((n, w) => (collected.has(w) ? n + 1 : n), 0),
    [words, collected],
  )

  // 整篇译文：进入双语/译文模式后拉取；未覆盖时触发后台翻译并每 3s 轮询回填
  // 停滞判定按时间而非调用次数：refetchInterval 回调会随每次渲染重复求值
  const pollRef = useRef({ last: -1, since: Date.now() })
  // 已触发过整篇翻译的章节；显式化后它同时决定"要不要轮询"
  const enqueuedRef = useRef(new Set<string>())
  const [translating, setTranslating] = useState(false)
  const autoTranslate = usePrefStore((s) => s.prefs.reader.autoTranslate)
  useEffect(() => {
    pollRef.current = { last: -1, since: Date.now() }
  }, [articleId, viewMode])

  const translationsQuery = useQuery({
    queryKey: ['translations', articleId],
    queryFn: () => api.articleTranslations(articleId),
    enabled: articleId !== '' && viewMode !== 'orig',
    refetchInterval: (query) => {
      // 没触发过翻译就不轮询：显式化之后干等没有意义
      if (!enqueuedRef.current.has(articleId)) return false
      const data = query.state.data
      if (!data) return 3000
      const n = Object.keys(data.translations).length
      const total = flatSentences.length
      if (total > 0 && n >= total) return false
      // 超过 90s 无增长视为队列停滞，停止轮询（arq worker 冷启动可能有十几秒延迟）
      const ps = pollRef.current
      if (n > ps.last) {
        ps.last = n
        ps.since = Date.now()
      }
      return Date.now() - ps.since > 90_000 ? false : 3000
    },
  })
  const translations = translationsQuery.data?.translations ?? EMPTY_TRANSLATIONS

  /* 整篇翻译改为显式触发（FR-374）：进双语只看已有译文，翻不翻由用户决定。
     自动翻译开关打开时才恢复"进来即翻"的老行为。
     翻译要等模型返回，默认替用户发起是反模式——业内阅读器一律给按钮。 */

  const runTranslate = useCallback(() => {
    if (articleId === '' || flatSentences.length === 0) return
    enqueuedRef.current.add(articleId)
    pollRef.current = { last: -1, since: Date.now() }
    setTranslating(true)
    api
      .enqueueTranslate(articleId)
      .then(() => void translationsQuery.refetch())
      .catch(() => {
        enqueuedRef.current.delete(articleId)
        setTranslating(false)
      })
  }, [articleId, flatSentences.length, translationsQuery])

  useEffect(() => {
    if (!autoTranslate) return
    const data = translationsQuery.data
    if (viewMode === 'orig' || articleId === '' || !data || flatSentences.length === 0) return
    if (Object.keys(data.translations).length >= flatSentences.length) return
    if (enqueuedRef.current.has(articleId)) return
    runTranslate()
  }, [autoTranslate, viewMode, articleId, translationsQuery.data, flatSentences, runTranslate])

  const translatedCount = useMemo(() => {
    let n = 0
    for (const s of flatSentences) if (translations[String(s.sentenceId)] !== undefined) n++
    return n
  }, [flatSentences, translations])

  // 覆盖满即收进度态；轮询自身也会在此条件下停
  useEffect(() => {
    if (translating && flatSentences.length > 0 && translatedCount >= flatSentences.length) {
      setTranslating(false)
    }
  }, [translating, translatedCount, flatSentences.length])

  const scrollRef = useRef<HTMLDivElement>(null)

  /* ═══════════ 工具箱（FR-375~385）═══════════ */
  const {
    proseStyle,
    paperTheme,
    focusMode,
    setFocusMode,
    isFullscreen,
    toggleFullscreen,
    autoScroll,
    setAutoScroll,
  } = useReaderTools(scrollRef)
  const visiblePara = useVisibleParagraph(scrollRef)

  const [searchOpen, setSearchOpen] = useState(false)
  const [searchHits, setSearchHits] = useState<SearchHit[]>([])
  const [transMenu, setTransMenu] = useState(false)
  const [typoOpen, setTypoOpen] = useState(false)
  const [moreMenu, setMoreMenu] = useState(false)
  const [shortcuts, setShortcuts] = useState(false)
  const [voiceOpen, setVoiceOpen] = useState(false)
  const [menu, setMenu] = useState<MenuTarget | null>(null)

  const readerVoice = usePrefStore((st) => st.prefs.reader.voice)
  const updatePrefs = usePrefStore((st) => st.update)
  const fullyTranslated =
    flatSentences.length > 0 && translatedCount >= flatSentences.length

  /* 顶栏下拉：点到 .tb-wrap 之外才关。
     不能简单监听 window click——打开下拉的那次 click 还在冒泡，
     effect 注册的 listener 会立刻收到它并把刚打开的面板关掉（开不出来）。
     按落点归属判定既避开这个时序，又让按钮自身的 toggle 正常工作。 */
  useEffect(() => {
    if (!transMenu && !typoOpen && !moreMenu) return
    const onDown = (e: MouseEvent) => {
      const t = e.target
      if (t instanceof Element && t.closest('.tb-wrap') !== null) return
      setTransMenu(false)
      setTypoOpen(false)
      setMoreMenu(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [transMenu, typoOpen, moreMenu])

  const searchMarks = useSearchHighlight(searchHits)

  /* 生词小译（FR-381）：只查本章已收藏的生词，整章一次取回。
     关着的时候不发请求——这项是可选装饰，不该让所有人替它买单。 */
  const wordLens = usePrefStore((st) => st.prefs.reader.wordLens)
  const lensWords = useMemo(
    () => (wordLens ? words.filter((w) => collected.has(w)) : []),
    [wordLens, words, collected],
  )
  const glossQuery = useQuery({
    queryKey: ['gloss', articleId, lensWords.length],
    queryFn: () => readerApi.gloss(lensWords),
    enabled: lensWords.length > 0,
    staleTime: 10 * 60_000,
  })
  const gloss = wordLens ? glossQuery.data?.gloss : undefined


  /* ── 书签 */
  const bookmarksQuery = useQuery({
    queryKey: ['bookmarks', articleId],
    queryFn: () => readerApi.bookmarks(articleId),
    enabled: articleId !== '' && article !== undefined,
  })
  const bookmarks = bookmarksQuery.data

  const createBookmark = useMutation({
    mutationFn: (paragraphId: number) =>
      readerApi.createBookmark({ article_id: article!.id, paragraph_id: paragraphId }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['bookmarks', articleId] }),
  })
  const removeBookmark = useMutation({
    mutationFn: (id: number) => readerApi.deleteBookmark(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['bookmarks', articleId] }),
  })

  const addBookmarkHere = useCallback(
    (paragraphId?: number) => {
      if (!article) return
      const pid = paragraphId ?? visiblePara.current()
      if (pid === null) return
      createBookmark.mutate(pid)
    },
    [article, visiblePara, createBookmark],
  )

  /* J/K 按段跳：以视口首段为基准前后挪一段。
     用可见段落序列而非固定像素滚动——快捷键表写的是"跳到下一段"，行为要对得上文案。 */
  const stepParagraph = useCallback(
    (delta: number) => {
      const el = scrollRef.current
      if (!el || visibleParagraphs.length === 0) return
      const cur = visiblePara.current()
      const i = visibleParagraphs.findIndex((p) => p.id === cur)
      const next = visibleParagraphs[Math.min(visibleParagraphs.length - 1, Math.max(0, (i < 0 ? 0 : i) + delta))]
      if (next === undefined) return
      el.querySelector(`[data-pid="${next.id}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    },
    [visibleParagraphs, visiblePara],
  )

  const jumpToParagraph = useCallback((paragraphId: number, flash = true) => {
    const node = scrollRef.current?.querySelector<HTMLElement>(`[data-pid="${paragraphId}"]`)
    if (!node) return
    node.scrollIntoView({ block: 'center', behavior: 'smooth' })
    if (flash) {
      node.classList.add('ann-flash')
      window.setTimeout(() => node.classList.remove('ann-flash'), 1700)
    }
  }, [])


  /* ================= M5：阅读进度上报 ================= */
  useReadingProgress({ articleId, article, scrollRef, viewMode })

  /* ================= M5：批注 ================= */
  const annotationsQuery = useQuery({
    queryKey: ['annotations', articleId],
    queryFn: () => readerApi.annotations(articleId),
    enabled: articleId !== '' && article !== undefined,
  })
  const annotations = annotationsQuery.data

  const [selTool, setSelTool] = useState<SelToolbarState | null>(null)
  const [annPop, setAnnPop] = useState<AnnPopState | null>(null)

  const paraById = useMemo(
    () => new Map((article?.paragraphs ?? []).map((p) => [p.id, p])),
    [article],
  )

  const invalidateAnnotations = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['annotations', articleId] }),
    [queryClient, articleId],
  )

  const createAnn = useMutation({
    mutationFn: (input: { color: AnnotationColor; openNote: boolean }) =>
      readerApi.createAnnotation({
        article_id: article!.id,
        paragraph_id: selTool!.paragraphId,
        char_start: selTool!.start,
        char_end: selTool!.end,
        color: input.color,
      }),
    onSuccess: (created, input) => {
      void invalidateAnnotations()
      if (input.openNote && selTool !== null) {
        setAnnPop({ ann: created, ...popPosition(selTool.x, selTool.y + 8) })
      }
      window.getSelection()?.removeAllRanges()
      setSelTool(null)
    },
  })

  /* 右键菜单建批注：不能复用 createAnn——那个读的是选区工具条状态 selTool，
     而右键不走 mouseup，selTool 为空，点了颜色什么也不会发生（首版就是这样静默失败的）。 */
  const createAnnAt = useMutation({
    mutationFn: (input: {
      paragraphId: number
      start: number
      end: number
      color: AnnotationColor
      openNote: boolean
    }) =>
      readerApi.createAnnotation({
        article_id: article!.id,
        paragraph_id: input.paragraphId,
        char_start: input.start,
        char_end: input.end,
        color: input.color,
      }),
    onSuccess: (created, input) => {
      void invalidateAnnotations()
      if (input.openNote) {
        const node = scrollRef.current?.querySelector<HTMLElement>(`[data-ann="${created.id}"]`)
        const rect = node?.getBoundingClientRect()
        setAnnPop({
          ann: created,
          ...popPosition(
            rect ? rect.left + rect.width / 2 : window.innerWidth / 2,
            rect ? rect.bottom : 200,
          ),
        })
      }
      window.getSelection()?.removeAllRanges()
    },
  })

  const patchAnn = useMutation({
    mutationFn: (input: { id: number; color?: AnnotationColor; note?: string }) =>
      readerApi.updateAnnotation(input.id, {
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
      }),
    onSuccess: (updated) => {
      void invalidateAnnotations()
      setAnnPop((p) => (p !== null && p.ann.id === updated.id ? { ...p, ann: updated } : p))
    },
  })

  const deleteAnn = useMutation({
    mutationFn: (id: number) => readerApi.deleteAnnotation(id),
    onSuccess: () => {
      void invalidateAnnotations()
      setAnnPop(null)
    },
  })

  // 正文选区松开：单段落内出浮动工具条（译文模式无原文偏移，不出）
  const handleProseMouseUp = useCallback(() => {
    window.setTimeout(() => {
      const container = scrollRef.current
      if (!container || !article || viewMode === 'trans') {
        setSelTool(null)
        return
      }
      const raw = readParagraphSelection(container)
      if (raw === null) {
        setSelTool(null)
        return
      }
      const para = paraById.get(raw.paragraphId)
      if (!para) {
        setSelTool(null)
        return
      }
      const trimmed = trimSelectionRange(para.text, raw.start, raw.end)
      if (trimmed === null) {
        setSelTool(null)
        return
      }
      setSelTool({
        paragraphId: raw.paragraphId,
        start: trimmed.start,
        end: trimmed.end,
        text: trimmed.text,
        x: raw.rect.left + raw.rect.width / 2,
        y: Math.max(raw.rect.top - 10, 60),
      })
    }, 0)
  }, [article, paraById, viewMode])

  // Escape 关工具条/浮层
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelTool(null)
        window.getSelection()?.removeAllRanges()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 词组解释：≤6 词的选区 → phrase 分析（语境取覆盖选区的句子）
  const phraseFromSelection = useCallback(() => {
    if (selTool === null) return
    const para = paraById.get(selTool.paragraphId)
    if (!para) return
    let context = para.text
    const covering = [...para.sentences]
      .filter(([, cs, ce]) => cs < selTool.end && ce > selTool.start)
      .sort((a, b) => a[1] - b[1])
    if (covering.length > 0) {
      context = para.text.slice(covering[0][1], covering[covering.length - 1][2])
    }
    if (context.length > 400) context = context.slice(0, 400)
    selectPhrase({ text: selTool.text, context, paragraphId: selTool.paragraphId })
    window.getSelection()?.removeAllRanges()
    setSelTool(null)
  }, [selTool, paraById, selectPhrase])

  const selWordCount = selTool === null ? 0 : selTool.text.split(/\s+/).filter(Boolean).length

  const bookmarkedParas = useMemo(
    () => new Set((bookmarks ?? []).map((b) => b.paragraph_id)),
    [bookmarks],
  )

  /* ── 右键菜单（FR-378）：从落点 DOM 反推段落/词/句，菜单项按可用性裁剪 */
  const openContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!article) return
      const el = e.target instanceof HTMLElement ? e.target : null
      const paraEl = el?.closest<HTMLElement>('[data-pid]')
      if (paraEl === null || paraEl === undefined) return
      const paragraphId = Number(paraEl.dataset.pid)
      const para = paraById.get(paragraphId)
      if (!para) return
      e.preventDefault()

      // 落在词上：ProseView 的词元 span 带 data-ws/data-we 偏移
      const wordEl = el?.closest<HTMLElement>('[data-ws]')
      const wordStart = wordEl ? Number(wordEl.dataset.ws) : NaN
      const wordEnd = wordEl ? Number(wordEl.dataset.we) : NaN
      const word =
        wordEl && Number.isFinite(wordStart) && Number.isFinite(wordEnd)
          ? {
              word: (wordEl.dataset.w ?? wordEl.textContent ?? '').toLowerCase(),
              surface: wordEl.textContent ?? '',
              start: wordStart,
              end: wordEnd,
            }
          : null

      // 覆盖落点的句子：优先词的位置，其次段首
      const probe = word?.start ?? 0
      const hit = [...para.sentences]
        .sort((a, b) => a[1] - b[1])
        .find(([, cs, ce]) => cs <= probe && ce > probe)
      const sentence =
        hit !== undefined
          ? { id: hit[0], text: para.text.slice(hit[1], hit[2]).trim(), start: hit[1], end: hit[2] }
          : null

      const container = scrollRef.current
      const raw = container === null ? null : readParagraphSelection(container)
      const selection =
        raw !== null && raw.paragraphId === paragraphId
          ? (() => {
              const t = trimSelectionRange(para.text, raw.start, raw.end)
              return t === null ? null : { text: t.text, start: t.start, end: t.end }
            })()
          : null

      setMenu({ x: e.clientX, y: e.clientY, paragraphId, word, sentence, selection })
    },
    [article, paraById],
  )

  const menuActions = useMemo<ContextMenuActions>(() => {
    const para = menu === null ? undefined : paraById.get(menu.paragraphId)
    const sentenceOf = () =>
      menu?.sentence === null || menu === null
        ? null
        : {
            sentenceId: menu.sentence.id,
            paragraphId: menu.paragraphId,
            text: menu.sentence.text,
          }
    return {
      onLookup: () => {
        if (menu?.word == null || menu.sentence === null) return
        useReaderStore.getState().selectWord({
          word: menu.word.word,
          surface: menu.word.surface,
          paragraphId: menu.paragraphId,
          start: menu.word.start,
          end: menu.word.end,
          sentenceId: menu.sentence.id,
          sentenceHash: null,
          sentenceText: menu.sentence.text,
        })
      },
      onCollect: () => {
        if (menu?.word == null) return
        const w = menu.word.word
        void api
          .collectVocab({
            word: w,
            ...(article !== undefined ? { article_id: article.id } : {}),
            ...(menu.sentence !== null ? { sentence_id: menu.sentence.id } : {}),
            context_text: menu.sentence?.text ?? '',
          })
          .then(() => useVocabCollectionStore.getState().addCollected(w))
          .catch(() => undefined)
      },
      onSpeak: () => {
        const s = sentenceOf()
        if (s !== null) usePlayerStore.getState().playSentence(s.sentenceId)
      },
      onSpeakOn: () => {
        const s = sentenceOf()
        if (s === null) return
        // 先把游标挪到该句，再走 play()——play 自己会置 chapter 模式并从当前句读下去
        const idx = flatSentences.findIndex((x) => x.sentenceId === s.sentenceId)
        if (idx < 0) return
        usePlayerStore.setState({ index: idx })
        usePlayerStore.getState().play()
      },
      onTranslate: () => {
        const s = sentenceOf()
        if (s === null) return
        useReaderStore.getState().selectSentence({
          sentenceId: s.sentenceId,
          hash: '',
          paragraphId: s.paragraphId,
          text: s.text,
        })
        setPanelTab('sentence')
      },
      onGrammar: () => {
        const s = sentenceOf()
        if (s === null) return
        useReaderStore.getState().selectSentence({
          sentenceId: s.sentenceId,
          hash: '',
          paragraphId: s.paragraphId,
          text: s.text,
        })
        setPanelTab('sentence')
      },
      onAskAi: () => {
        const text = menu?.selection?.text ?? menu?.sentence?.text ?? ''
        if (text !== '') {
          useCompanionContext.getState().addRef({
            key: `read-${menu?.paragraphId ?? 0}-${text.slice(0, 24)}`,
            kind: menu?.selection != null ? 'selection' : 'sentence',
            text,
            source: article?.title?.slice(0, 12) ?? '正文',
          })
        }
        setPanelTab('companion')
      },
      onHighlight: (color) => {
        if (menu?.selection == null || article === undefined) return
        createAnnAt.mutate({
          paragraphId: menu.paragraphId,
          start: menu.selection.start,
          end: menu.selection.end,
          color,
          openNote: false,
        })
      },
      onNote: () => {
        if (menu?.selection == null || article === undefined) return
        createAnnAt.mutate({
          paragraphId: menu.paragraphId,
          start: menu.selection.start,
          end: menu.selection.end,
          color: 'yellow',
          openNote: true,
        })
      },
      onBookmark: () => menu !== null && addBookmarkHere(menu.paragraphId),
      onCopy: () => {
        const text = menu?.selection?.text ?? para?.text ?? ''
        if (text !== '') void navigator.clipboard?.writeText(text).catch(() => undefined)
      },
      onPhrase: () => {
        if (menu?.selection == null || para === undefined) return
        selectPhrase({
          text: menu.selection.text,
          context: para.text.slice(0, 400),
          paragraphId: menu.paragraphId,
        })
      },
    }
  }, [menu, paraById, article, addBookmarkHere, createAnnAt, selectPhrase, setPanelTab, flatSentences])

  // 批注点击 → 编辑浮层
  const openAnnotation = useCallback((ann: Annotation, el: HTMLElement) => {
    const rect = el.getBoundingClientRect()
    setAnnPop({ ann, ...popPosition(rect.left + rect.width / 2, rect.bottom) })
  }, [])

  // 批注列表跳转定位：滚到原文并闪烁
  const jumpToAnnotation = useCallback((ann: Annotation) => {
    const nodes = scrollRef.current?.querySelectorAll<HTMLElement>(`[data-ann="${ann.id}"]`)
    if (!nodes || nodes.length === 0) return
    nodes[0].scrollIntoView({ block: 'center', behavior: 'smooth' })
    for (const n of Array.from(nodes)) {
      n.classList.add('ann-flash')
      window.setTimeout(() => n.classList.remove('ann-flash'), 1700)
    }
  }, [])

  /* ================= 滚动位置：服务端进度优先，localStorage 兜底 ================= */
  const restoredFor = useRef<string | null>(null)
  const saveTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (!article || restoredFor.current === articleId) return
    // 带 ?sid= 进入时定位交给出处跳转，不恢复上次滚动位置
    if (jumpSid !== null) {
      restoredFor.current = articleId
      return
    }
    const el = scrollRef.current
    if (!el) return
    restoredFor.current = articleId
    const progress = articleProgressOf(article)
    // setTimeout 而非 rAF：后台标签页会挂起 rAF，导致恢复迟迟不执行
    window.setTimeout(() => {
      if (progress !== null && progress.last_paragraph_ordinal > 0) {
        const para = article.paragraphs.find(
          (p) => p.ordinal === progress.last_paragraph_ordinal,
        )
        const node =
          para !== undefined
            ? el.querySelector<HTMLElement>(`[data-pid="${para.id}"]`)
            : null
        if (node !== null) {
          node.scrollIntoView({ block: 'start' })
          return
        }
      }
      // 离线兜底：本地滚动位置
      el.scrollTop = Number(localStorage.getItem(`ln-scroll-${articleId}`) ?? 0)
    }, 0)
  }, [article, articleId, jumpSid])

  // 出处跳转：滚动到目标句并加 .s-reading 高亮，3 秒后移除
  useEffect(() => {
    if (!article || jumpSid === null) return
    let node: HTMLElement | null = null
    let timer: number | undefined
    const raf = requestAnimationFrame(() => {
      node = scrollRef.current?.querySelector<HTMLElement>(`[data-sid="${jumpSid}"]`) ?? null
      if (!node) return
      node.scrollIntoView({ block: 'center' })
      node.classList.add('s-reading')
      timer = window.setTimeout(() => node?.classList.remove('s-reading'), 3000)
    })
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(timer)
      node?.classList.remove('s-reading')
    }
  }, [article, jumpSid])

  const handleScroll = () => {
    // 滚动时收起选区工具条与批注浮层（锚点已经移位）
    setSelTool(null)
    setAnnPop(null)
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      const el = scrollRef.current
      if (el) {
        localStorage.setItem(`ln-scroll-${articleId}`, String(Math.round(el.scrollTop)))
      }
    }, 250)
  }
  useEffect(() => () => window.clearTimeout(saveTimer.current), [])

  // 用户手动滚动（wheel/touchmove）临时打断跟随；下一句开播时自动恢复
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const cancelFollow = () => usePlayerStore.getState().suspendFollow()
    el.addEventListener('wheel', cancelFollow, { passive: true })
    el.addEventListener('touchmove', cancelFollow, { passive: true })
    return () => {
      el.removeEventListener('wheel', cancelFollow)
      el.removeEventListener('touchmove', cancelFollow)
    }
  }, [])

  // 切换三态时保持滚动位置：记录视口内第一个段落，切换后滚回
  const changeViewMode = (mode: ViewMode) => {
    if (mode === viewMode) return
    const el = scrollRef.current
    let anchor: string | null = null
    if (el) {
      const top = el.getBoundingClientRect().top
      for (const node of Array.from(el.querySelectorAll<HTMLElement>('[data-pid]'))) {
        if (node.getBoundingClientRect().bottom > top + 8) {
          anchor = node.dataset.pid ?? null
          break
        }
      }
    }
    setViewMode(mode)
    if (anchor !== null) {
      requestAnimationFrame(() => {
        scrollRef.current
          ?.querySelector(`[data-pid="${anchor}"]`)
          ?.scrollIntoView({ block: 'start' })
      })
    }
  }

  /* 快捷键总表见 ReaderPanels.ShortcutsDialog（FR-384）。
     朗读类只在控制条打开时生效；导航与工具类全局生效，输入框内一律不拦。 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target instanceof HTMLElement ? e.target : null
      if (
        t &&
        (t.isContentEditable ||
          (typeof t.closest === 'function' && t.closest('input, textarea, select') !== null))
      )
        return
      if (e.metaKey || e.altKey) return

      // Ctrl+F 交给章内搜索（浏览器查找搜不到虚拟化之外的内容，且不认偏移）
      if (e.ctrlKey) {
        if (e.key === 'f') {
          e.preventDefault()
          setSearchOpen(true)
        }
        return
      }

      const player = usePlayerStore.getState()
      if (player.visible) {
        if (e.code === 'Space') {
          // 焦点在按钮上时空格由按钮自身响应，避免双重触发
          if (typeof t?.closest === 'function' && t.closest('button')) return
          e.preventDefault()
          player.toggle()
          return
        }
        if (e.key === 'ArrowLeft') {
          e.preventDefault()
          player.prev()
          return
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault()
          player.next()
          return
        }
        if (e.key === 'r' || e.key === 'R') {
          e.preventDefault()
          const cur = usePlayerStore.getState().sentences[usePlayerStore.getState().index]
          if (cur !== undefined) player.playSentence(cur.sentenceId)
          return
        }
      }

      const el = scrollRef.current
      switch (e.key) {
        case '/':
          e.preventDefault()
          setSearchOpen(true)
          break
        case '?':
          e.preventDefault()
          setShortcuts(true)
          break
        case 'b':
          e.preventDefault()
          addBookmarkHere()
          break
        case 't':
          e.preventDefault()
          setTypoOpen((v) => !v)
          break
        case 'v':
          e.preventDefault()
          changeViewMode(
            viewMode === 'orig' ? 'both' : viewMode === 'both' ? 'trans' : 'orig',
          )
          break
        case 'e':
          e.preventDefault()
          if (!fullyTranslated) runTranslate()
          break
        case 'c':
          e.preventDefault()
          setPanelTab(panelTab === 'companion' ? 'learn' : 'companion')
          break
        case 'f':
          e.preventDefault()
          if (e.shiftKey) void toggleFullscreen()
          else setFocusMode(!focusMode)
          break
        case 'F':
          e.preventDefault()
          void toggleFullscreen()
          break
        case 'a':
          e.preventDefault()
          setAutoScroll(!autoScroll)
          break
        case 'j':
          e.preventDefault()
          stepParagraph(1)
          break
        case 'k':
          e.preventDefault()
          stepParagraph(-1)
          break
        case 'g':
          e.preventDefault()
          el?.scrollTo({ top: e.shiftKey ? el.scrollHeight : 0, behavior: 'smooth' })
          break
        case 'G':
          e.preventDefault()
          el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
          break
        case '[':
        case ']':
          e.preventDefault()
          usePlayerStore.getState().stepRate(e.key === ']' ? 1 : -1)
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    addBookmarkHere,
    autoScroll,
    changeViewMode,
    focusMode,
    fullyTranslated,
    panelTab,
    runTranslate,
    setAutoScroll,
    setFocusMode,
    setPanelTab,
    stepParagraph,
    toggleFullscreen,
    viewMode,
  ])

  const panelContent = () => {
    if (panelTab === 'bookmarks') {
      return (
        <BookmarksPanel
          bookmarks={bookmarks}
          loading={bookmarksQuery.isPending}
          onJump={(b) => jumpToParagraph(b.paragraph_id)}
          onDelete={(id) => removeBookmark.mutate(id)}
        />
      )
    }
    if (panelTab === 'stats') {
      return (
        <StatsPanel
          stats={{
            totalWords: totalTokens,
            readParagraphs: article ? articleProgressOf(article)?.read_paragraph_ordinals.length ?? 0 : 0,
            totalParagraphs: article?.paragraphs.length ?? 0,
            durationS: article ? articleProgressOf(article)?.duration_s ?? 0 : 0,
            vocabCount,
            translatedCount,
            totalSentences: flatSentences.length,
            bookmarks: bookmarks?.length ?? 0,
            annotations: annotations?.length ?? 0,
          }}
        />
      )
    }
    if (panelTab === 'annotations') {
      if (!article) return <EmptyPanel />
      return (
        <AnnotationsPanel
          article={article}
          annotations={annotations}
          loading={annotationsQuery.isPending}
          error={annotationsQuery.isError}
          onJump={jumpToAnnotation}
        />
      )
    }
    if (panelTab === 'companion') {
      if (!article) return <div className="panel-hint" style={{ padding: 16 }}>章节加载后可用</div>
      return <CompanionPanel article={article} />
    }
    if (panelTab === 'sentence') {
      if (selection?.kind === 'sentence') {
        return (
          <SentencePanel
            key={selection.sentence.hash}
            sel={selection.sentence}
            onAskAi={() => setPanelTab('companion')}
            transContext={
              [book?.title ? `书《${book.title}》` : '', article?.title ? `篇名《${article.title}》` : '']
                .filter(Boolean)
                .join('；') || undefined
            }
          />
        )
      }
      return (
        <div className="panel-empty">
          <IconSparkle />
          <div>点击正文中的句子查看翻译、语法与精讲</div>
        </div>
      )
    }
    // learn
    if (selection?.kind === 'word' && article) {
      return (
        <WordCard
          key={`${selection.word.paragraphId}-${selection.word.start}`}
          sel={selection.word}
          articleId={article.id}
          clickable="store"
        />
      )
    }
    if (selection?.kind === 'phrase') {
      return (
        <PhrasePanel
          key={`${selection.phrase.paragraphId}-${selection.phrase.text}`}
          sel={selection.phrase}
        />
      )
    }
    return <EmptyPanel />
  }

  return (
    <div className={`main reader-main${focusMode ? ' focus' : ''}${autoScroll ? ' autoscroll' : ''}`}>
      <Topbar
        back={{ to: '/', label: '书架' }}
        crumbs={[
          { label: '书架', to: '/' },
          ...(standalone ? [] : [{ label: book?.title ?? '…' }]),
        ]}
        title={article?.title ?? '…'}
        actions={
          <>
            {!standalone && (
              <button
                className={`icon-btn${tocOpen ? ' active' : ''}`}
                title="章节目录"
                onClick={toggleToc}
              >
                <IconSidebar />
              </button>
            )}
            <button
              className={`icon-btn${searchOpen ? ' active' : ''}`}
              title="章内搜索（/）"
              onClick={() => setSearchOpen((v) => !v)}
            >
              <IconSearch />
            </button>

            <div className="seg">
              {VIEW_MODES.map((m) => (
                <button
                  key={m.value}
                  className={viewMode === m.value ? 'active' : undefined}
                  onClick={() => changeViewMode(m.value)}
                >
                  {m.label}
                </button>
              ))}
            </div>

            {/* 翻译改为显式动作（FR-374）：按钮点了才翻，旁边挂自动开关 */}
            <div className="tb-wrap">
              <button
                className={`icon-btn${transMenu ? ' active' : ''}${translating ? ' busy' : ''}`}
                title={
                  fullyTranslated
                    ? '本章已全部翻译'
                    : translating
                      ? `翻译中 ${translatedCount}/${flatSentences.length}`
                      : '翻译本章（E）'
                }
                onClick={() => setTransMenu((v) => !v)}
              >
                <IconTranslate />
                {!fullyTranslated && translatedCount > 0 && <span className="tb-dot" />}
              </button>
              {transMenu && (
                <div className="tb-menu" onClick={(e) => e.stopPropagation()}>
                  <div className="tb-menu-h">
                    整篇翻译
                    <b>
                      {translatedCount}/{flatSentences.length} 句
                    </b>
                  </div>
                  <button
                    className="tb-item"
                    disabled={translating || fullyTranslated || flatSentences.length === 0}
                    onClick={() => {
                      runTranslate()
                      setTransMenu(false)
                    }}
                  >
                    <IconTranslate />
                    {fullyTranslated ? '已全部翻译' : translating ? '翻译进行中…' : '翻译本章'}
                  </button>
                  <label className="tb-sw">
                    <input
                      type="checkbox"
                      checked={autoTranslate}
                      onChange={(e) => updatePrefs({ reader: { autoTranslate: e.target.checked } })}
                    />
                    <span>
                      进入双语自动翻译
                      <em>关掉后只显示已有译文，要翻再点上面那颗按钮</em>
                    </span>
                  </label>
                </div>
              )}
            </div>

            {/* 排版 */}
            <div className="tb-wrap">
              <button
                className={`icon-btn${typoOpen ? ' active' : ''}`}
                title="阅读排版（T）"
                onClick={() => setTypoOpen((v) => !v)}
              >
                <IconTypography />
              </button>
              {typoOpen && <TypographyPanel onClose={() => setTypoOpen(false)} />}
            </div>

            <button
              className={`icon-btn${playerVisible ? ' active' : ''}`}
              title="朗读控制"
              onClick={togglePlayer}
            >
              <IconSpeaker />
            </button>

            <button
              className={`icon-btn${panelTab === 'annotations' ? ' active' : ''}`}
              title="批注列表"
              onClick={() => setPanelTab(panelTab === 'annotations' ? 'learn' : 'annotations')}
            >
              <IconHighlighter />
            </button>

            <button
              className={`btn btn-soft btn-sm companion-entry${panelTab === 'companion' ? ' active' : ''}`}
              title="基于本章内容的 AI 问答（C）"
              onClick={() => setPanelTab(panelTab === 'companion' ? 'learn' : 'companion')}
            >
              <IconSparkle />
              AI 陪读
            </button>

            {/* 更多：低频但必须有的那批（FR-379~385） */}
            <div className="tb-wrap">
              <button
                className={`icon-btn${moreMenu ? ' active' : ''}`}
                title="更多工具"
                onClick={() => setMoreMenu((v) => !v)}
              >
                <IconMore />
              </button>
              {moreMenu && (
                <div className="tb-menu wide" onClick={(e) => e.stopPropagation()}>
                  <button
                    className={`tb-item${panelTab === 'bookmarks' ? ' on' : ''}`}
                    onClick={() => {
                      setPanelTab(panelTab === 'bookmarks' ? 'learn' : 'bookmarks')
                      setMoreMenu(false)
                    }}
                  >
                    <IconBookmark />
                    书签列表
                    <b>{bookmarks?.length ?? 0}</b>
                  </button>
                  <button
                    className="tb-item"
                    onClick={() => {
                      addBookmarkHere()
                      setMoreMenu(false)
                    }}
                  >
                    <IconBookmark filled />
                    在当前位置插书签
                    <kbd>B</kbd>
                  </button>
                  <button
                    className={`tb-item${panelTab === 'stats' ? ' on' : ''}`}
                    onClick={() => {
                      setPanelTab(panelTab === 'stats' ? 'learn' : 'stats')
                      setMoreMenu(false)
                    }}
                  >
                    <IconChart />
                    阅读统计
                  </button>
                  <div className="tb-sep" />
                  <button
                    className={`tb-item${focusMode ? ' on' : ''}`}
                    onClick={() => {
                      setFocusMode(!focusMode)
                      setMoreMenu(false)
                    }}
                  >
                    <IconFocus />
                    专注模式
                    <kbd>F</kbd>
                  </button>
                  <button
                    className="tb-item"
                    onClick={() => {
                      void toggleFullscreen()
                      setMoreMenu(false)
                    }}
                  >
                    {isFullscreen ? <IconShrink /> : <IconExpand />}
                    {isFullscreen ? '退出全屏' : '全屏阅读'}
                    <kbd>⇧F</kbd>
                  </button>
                  <button
                    className={`tb-item${autoScroll ? ' on' : ''}`}
                    onClick={() => {
                      setAutoScroll(!autoScroll)
                      setMoreMenu(false)
                    }}
                  >
                    <IconAutoScroll />
                    {autoScroll ? '停止自动滚动' : '自动滚动'}
                    <kbd>A</kbd>
                  </button>
                  <div className="tb-sep" />
                  <button
                    className="tb-item"
                    onClick={() => {
                      setVoiceOpen(true)
                      setMoreMenu(false)
                    }}
                  >
                    <IconSpeaker />
                    朗读音色
                    <b>{readerVoice === null ? '跟随设置' : '已指定'}</b>
                  </button>
                  <button
                    className="tb-item"
                    onClick={() => {
                      saveFile(`/api/annotations/export?article_id=${articleId}`, `annotations-${articleId}.md`)
                      setMoreMenu(false)
                    }}
                  >
                    <IconDownload />
                    导出批注
                  </button>
                  <button
                    className="tb-item"
                    onClick={() => {
                      setShortcuts(true)
                      setMoreMenu(false)
                    }}
                  >
                    <IconKeyboard />
                    快捷键
                    <kbd>?</kbd>
                  </button>
                </div>
              )}
            </div>

            <button
              className={`icon-btn${mascotOn ? ' active' : ''}`}
              title={mascotOn ? '隐藏看板娘' : '显示看板娘'}
              onClick={() => setMascotOn(!mascotOn)}
            >
              <IconMascot />
            </button>
          </>
        }
      />

      <div className="body-row">
        {tocOpen && !standalone && (
          <Toc
            bookTitle={book?.title}
            chapters={chaptersQuery.data}
            loading={chaptersQuery.isPending}
            currentId={article?.id}
            onSelect={(id) => navigate(`/read/${id}`)}
          />
        )}

        <div className="canvas-col">
          {searchOpen && article && (
            <SearchBar
              paragraphs={visibleParagraphs}
              onJump={(h) => jumpToParagraph(h.paragraphId, false)}
              onClose={() => {
                setSearchOpen(false)
                setSearchHits([])
              }}
              onHits={setSearchHits}
            />
          )}
          <div
            className="canvas-wrap"
            ref={scrollRef}
            onScroll={handleScroll}
            onMouseUp={handleProseMouseUp}
            onContextMenu={openContextMenu}
            data-paper={paperTheme}
            style={proseStyle}
          >
            <div className="canvas">
              {articleQuery.isPending && <ProseSkeleton />}

              {articleQuery.isError && (
                <div className="state-block">
                  <IconAlert />
                  <div>章节加载失败，请确认服务端已启动</div>
                  <button className="btn btn-outline" onClick={() => void articleQuery.refetch()}>
                    重试
                  </button>
                </div>
              )}

              {article && (
                <>
                  <h1 className="ch-title">{article.title}</h1>
                  <div className="ch-sub">
                    <span>
                      {standalone
                        ? '独立文章'
                        : book
                          ? `${book.author ? `${book.author} · ` : ''}${book.title}`
                          : ''}
                    </span>
                    <span className="chip">{totalTokens.toLocaleString()} 词</span>
                    {vocabCount > 0 && <span className="chip warn">生词 {vocabCount}</span>}
                    {viewMode !== 'orig' &&
                      flatSentences.length > 0 &&
                      translatedCount < flatSentences.length && (
                        <span className="chip accent">
                          已翻译 {translatedCount}/{flatSentences.length} 句
                        </span>
                      )}
                  </div>
                  <ProseView
                    article={article}
                    mode={viewMode}
                    translations={translations}
                    annotations={annotations}
                    onAnnotationClick={openAnnotation}
                    searchMarks={searchMarks}
                    bookmarked={bookmarkedParas}
                    gloss={gloss}
                  />
                </>
              )}
            </div>
          </div>

          {playerVisible && <PlayerBar />}
        </div>

        <aside className="panel">
          <div className="panel-tabs">
            {PANEL_TABS.map((t) => (
              <button
                key={t.value}
                className={panelTab === t.value ? 'active' : undefined}
                onClick={() => setPanelTab(t.value)}
              >
                {t.label}
              </button>
            ))}
            <button
              className={`panel-tog${clickableWords ? ' on' : ''}`}
              title={clickableWords ? '右栏英文可点词：开' : '右栏英文可点词：关'}
              role="switch"
              aria-checked={clickableWords}
              onClick={() => setClickableWords(!clickableWords)}
            >
              点词
              <span className="tog-track">
                <span className="tog-knob" />
              </span>
            </button>
          </div>
          <div className="panel-scroll">{panelContent()}</div>
        </aside>
      </div>

      {/* 拖选正文任意片段 → 问 AI / 查词组（07 v2 FR-14） */}
      <SelectionBar
        containerRef={scrollRef}
        source={article?.title?.slice(0, 12) ?? '正文'}
        onPhrase={(text) => openPhraseModal(text, text)}
      />

      {menu !== null && (
        <ContextMenu target={menu} actions={menuActions} onClose={() => setMenu(null)} />
      )}

      {voiceOpen && (
        <VoicePicker
          title="阅读器朗读音色"
          hint="只作用于本阅读器；不选则跟随「设置 · 语音服务」里的场景绑定。"
          current={readerVoice}
          rate={usePlayerStore.getState().rate}
          sample={flatSentences[0]?.text.slice(0, 120) ?? undefined}
          onClear={() => {
            updatePrefs({ reader: { voice: null } })
            usePlayerStore.getState().setVoice(null)
            setVoiceOpen(false)
          }}
          onClose={() => setVoiceOpen(false)}
          onChoose={(choice, rate) => {
            updatePrefs({ reader: { voice: choice.value } })
            usePlayerStore.getState().setRate(rate)
          }}
        />
      )}

      {shortcuts && <ShortcutsDialog onClose={() => setShortcuts(false)} />}

      <WordModal articleId={article?.id} />

      <MascotWidget />

      {selTool !== null && (
        <SelectionToolbar
          x={selTool.x}
          y={selTool.y}
          showPhrase={selWordCount >= 2 && selWordCount <= 6}
          busy={createAnn.isPending}
          onPickColor={(color) => createAnn.mutate({ color, openNote: false })}
          onNote={() => createAnn.mutate({ color: 'yellow', openNote: true })}
          onPhrase={phraseFromSelection}
        />
      )}

      {annPop !== null && (
        <AnnotationPopover
          key={annPop.ann.id}
          annotation={annPop.ann}
          x={annPop.x}
          y={annPop.y}
          busy={patchAnn.isPending || deleteAnn.isPending}
          onChangeColor={(color) => patchAnn.mutate({ id: annPop.ann.id, color })}
          onSaveNote={(note) => patchAnn.mutate({ id: annPop.ann.id, note })}
          onDelete={() => deleteAnn.mutate(annPop.ann.id)}
          onClose={() => setAnnPop(null)}
        />
      )}
    </div>
  )
}
