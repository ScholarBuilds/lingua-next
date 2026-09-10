/* 单词本详情（需求 01 v2 FR-157 ~ FR-166）：分组分节 / 筛选排序 / 虚拟滚动 / 点词弹卡。

   渲染策略按数据规模分流：场景本词数在百级且要按 group 分节，直接全量渲染；
   考纲本上万词无分组，走行虚拟化 + 滚动到底续拉，避免 v1 那种点 150 次「加载更多」。 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { useDeckItems } from './useDeckItems'

import {
  IconCheck,
  IconEyeOff,
  IconTarget,
  IconPlus,
  IconSearch,
  IconSpeaker,
  IconStar,
  IconTrash,
  IconVoice,
  IconMore,
} from '../../components/icons'
import { Picker } from '@/components/ui/picker'
import { WordVoicePicker } from '../../components/WordVoicePicker'
import { normalizeWord, useWordVoices, type WordVoiceMap } from '../../lib/api-tts'
import type { Deck, DeckAiRun, DeckFilter, DeckItem, DeckSort, WordMark } from '../../lib/api-deck'
import { useUrlParams } from '../../lib/urlState'
import {
  apiDeck,
  apiScenario,
  apiScene,
  BUCKET_LABELS,
  DECK_FILTERS,
  DECK_SORTS,
  deckInitial,
  MARK_LABELS,
  MASTERY_META,
} from '../../lib/api-deck'
import { playTts, type WordVoice } from '../../lib/audio'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Overlay, overlayDepth } from '../../components/Overlay'
import { SentencePanel } from '../reader/SentencePanel'
import { sentenceSel } from '../reader/sentencePick'
import { SubjectPipelinePane } from '../pipeline/SubjectPipelinePane'
import { PassagePane } from './PassagePane'
import { useCardMask } from './MaskedText'
import { DeckSelfTest, useDeckSelfTest } from './DeckSelfTest'
import type { CardMask, MaskMode } from './MaskedText'
import { SceneRail } from './SceneRail'
import { ListenBar } from './ListenBar'
import { useListenStore } from './listenStore'
import {
  ClearDeckAudioOverlay,
  DeckAiRunOverlay,
  ResetProgressOverlay,
  isAiRunActive,
  useDeckAiRun,
  type MaintenanceKind,
} from './DeckMaintenance'
import { usePrefStore } from '../../lib/prefStore'
import { ClickableEn } from '../reader/ClickableEn'
import { useWordModalStore } from '../reader/wordModalStore'
import { VocabCoverArtwork, vocabCoverCell } from './VocabCover'

const PAGE_SIZE = 120
const NO_VOICES: WordVoiceMap = new Map()
const ROW_HEIGHT = 52
const CARD_HEIGHT = 104
const CARD_MIN_WIDTH = 208
const GRID_GAP = 10

type ViewMode = 'list' | 'grid'

/** 标记在菜单里的排列顺序：按「学得越好越靠后」，困难词单独垫底 */
const MARK_ORDER: WordMark[] = ['learning', 'mastered', 'hard']

interface DeckDetailProps {
  deck: Deck
  showSummary?: boolean
  onLearn?: () => void
  onReview?: () => void
  onDictation?: () => void
  /** 速记：带上当前场景 chip，从「饮食商店」下点进去就是那个场景，不再回到选场景页 */
  onDrill?: (scene: string) => void
}

/** 视图偏好按本记忆，下次进同一本沿用（FR-158） */
function viewPrefKey(deckKey: string): string {
  return `ln-deck-view:${deckKey}`
}

function readViewPref(deckKey: string, fallback: ViewMode): ViewMode {
  const v = localStorage.getItem(viewPrefKey(deckKey))
  return v === 'list' || v === 'grid' ? v : fallback
}

/** 词卡弹层里的翻页键：左 / 上 退一个，右 / 下 进一个 */
const MODAL_STEP: Record<string, number> = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }

export function DeckDetail({ deck, showSummary = true, onLearn, onReview, onDictation, onDrill }: DeckDetailProps) {
  /* 筛选、排序、搜索、页签、列表/卡片全部进 URL（BR-G-011）：
     刷新回到同一屏，链接也能直接分享到"这个本的困难词" */
  const [params, patchParams] = useUrlParams()
  const isScenario = deck.kind === 'scenario'
  const filter = (params.get('f') ?? 'all') as DeckFilter
  const sort = (params.get('sort') ?? 'default') as DeckSort
  const urlQ = params.get('q') ?? ''
  const [keyword, setKeyword] = useState(urlQ)
  const [debounced, setDebounced] = useState(urlQ)
  const gridParam = params.get('grid')
  /* 考纲本的场景筛选。放 URL 里：刷新、分享、前进后退都指向同一屏（BR-G-011） */
  const scene = params.get('g') ?? ''
  const view: ViewMode =
    gridParam === '1' ? 'grid' : gridParam === '0' ? 'list' : readViewPref(deck.key, isScenario ? 'grid' : 'list')
  const setView = (v: ViewMode) => {
    localStorage.setItem(viewPrefKey(deck.key), v)
    patchParams({ grid: v === 'grid' ? '1' : '0' })
  }
  const setFilter = (v: DeckFilter) => patchParams({ f: v === 'all' ? null : v })
  const setSort = (v: DeckSort) => patchParams({ sort: v === 'default' ? null : v })

  // 搜索去抖：考纲本每次查询都要扫 340 万行的 tag，逐字符打请求会打爆
  useEffect(() => {
    const timer = setTimeout(() => {
      const next = keyword.trim()
      setDebounced(next)
      patchParams({ q: next === '' ? null : next })
    }, 260)
    return () => clearTimeout(timer)
  }, [keyword, patchParams])

  const query = { filter, sort, q: debounced, ...(scene ? { group: scene } : {}) }

  // 场景本一次取全（词数在百级），其余走分页续拉
  const groupedQuery = useQuery({
    queryKey: ['deck-words-all', deck.key, filter, sort, debounced],
    queryFn: () => apiDeck.words(deck.key, { ...query, limit: 200 }),
    enabled: isScenario,
  })

  /* 考纲本的场景清单：limit=1 只为拿 groups。
     不能像场景本那样一次取全——GRE 7,504 词，接口 limit 上限 200 */
  const sceneQuery = useQuery({
    queryKey: ['deck-scenes', deck.key],
    queryFn: () => apiDeck.words(deck.key, { limit: 1 }),
    enabled: !isScenario,
  })
  const scenes = sceneQuery.data?.groups ?? []

  const pagedQuery = useInfiniteQuery({
    queryKey: ['deck-words', deck.key, filter, sort, debounced, scene],
    queryFn: ({ pageParam }) =>
      apiDeck.words(deck.key, { ...query, offset: pageParam, limit: PAGE_SIZE }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0)
      return loaded < last.total ? loaded : undefined
    },
    enabled: !isScenario,
  })

  const scopeKey = [deck.key, filter, sort, debounced, scene].join('|')
  const sourceItems = useMemo(() => isScenario
    ? (groupedQuery.data?.items ?? [])
    : (pagedQuery.data?.pages.flatMap((p) => p.items) ?? []), [isScenario, groupedQuery.data, pagedQuery.data])
  const items = useDeckItems(scopeKey, sourceItems, filter)
  const total = isScenario
    ? (groupedQuery.data?.total ?? 0)
    : (pagedQuery.data?.pages[0]?.total ?? 0)
  const groups = groupedQuery.data?.groups ?? []
  const isPending = isScenario ? groupedQuery.isPending : pagedQuery.isPending
  const isError = isScenario ? groupedQuery.isError : pagedQuery.isError
  const errorMsg = isScenario
    ? groupedQuery.error?.message
    : pagedQuery.error?.message

  const queryClient = useQueryClient()

  /* 就地改缓存里的那几个词，不等接口回来。

     > [!danger] 这条链上有两种 query 形状，只改一种等于没改
     >
     > 考纲本走 `useInfiniteQuery`（数据在 `pages[].items`），场景本与生词本走
     > 一次性 query（数据在 `items`）。只处理其中一种的话，另一类本上
     > 「点了没反应，刷新才变」——而这正是用户报的那个现象。 */
  const patchCached = (words: string[], fix: (it: DeckItem) => DeckItem) => {
    const names = new Set(words)
    const apply = (list: DeckItem[]) =>
      list.map((it) => (names.has(it.word) ? fix(it) : it))
    for (const key of [['deck-words', deck.key], ['deck-words-all', deck.key]]) {
      queryClient.setQueriesData<any>({ queryKey: key }, (old: any) => {
        if (old === undefined || old === null) return old
        if (Array.isArray(old.pages)) {
          return { ...old, pages: old.pages.map((pg: any) => ({ ...pg, items: apply(pg.items ?? []) })) }
        }
        if (Array.isArray(old.items)) return { ...old, items: apply(old.items) }
        return old
      })
    }
  }

  const expose = useMutation({
    mutationFn: (words: string[]) => apiScene.expose(words),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['deck-scenes', deck.key] })
    },
  })

  const mark = useMutation({
    mutationFn: ({ words, value }: { words: string[]; value: WordMark | null }) =>
      apiScene.mark(words, value),
    onMutate: ({ words, value }) => {
      patchCached(words, (it) => ({
        ...it,
        mark: value,
        // 困难只是难度不是进度，标它不该把掌握度也改了
        bucket: value === 'mastered' ? 'mature' : value === 'learning' ? 'learning' : it.bucket,
        difficult: value === null ? it.difficult : value === 'hard',
      }))
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['deck-words', deck.key] })
      void queryClient.invalidateQueries({ queryKey: ['deck-words-all', deck.key] })
      void queryClient.invalidateQueries({ queryKey: ['deck-scenes', deck.key] })
      void queryClient.invalidateQueries({ queryKey: ['decks'] })
    },
  })

  /* 例句语法分析：装的是那一句原文，非空即开浮层。
     复用阅读器的 SentencePanel（场景短文的语法侧栏用的也是它），
     不另造一套——判定口径分叉过一次就再也对不齐了。 */
  const [gramSentence, setGramSentence] = useState<string | null>(null)

  const hideZh = usePrefStore((st) => st.prefs.study.hideZh)
  const hideEn = usePrefStore((st) => st.prefs.study.hideEn)
  const setPrefs = usePrefStore((st) => st.update)
  const maskMode: MaskMode = hideZh ? 'zh' : hideEn ? 'en' : 'none'
  const tab = params.get('tab') === 'passage' ? 'passage' : 'words'
  const setTab = (v: 'words' | 'passage') => patchParams({ tab: v === 'words' ? null : v })
  const [showPipeline, setShowPipeline] = useState(false)
  const [picking, setPicking] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())

  const batch = useMutation({
    mutationFn: ({ action }: { action: 'collect' | 'master' | 'remove' }) =>
      apiDeck.batch(deck.key, action, [...picked]),
    onSuccess: () => {
      setPicked(new Set())
      setPicking(false)
      void queryClient.invalidateQueries({ queryKey: ['decks'] })
      void queryClient.invalidateQueries({ queryKey: ['deck-words', deck.key] })
      void queryClient.invalidateQueries({ queryKey: ['deck-words-all', deck.key] })
      void queryClient.invalidateQueries({ queryKey: ['review-stats'] })
    },
  })

  const togglePick = (word: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(word)) next.delete(word)
      else next.add(word)
      return next
    })

  // 按词钉死的音色整表：卡片上标记哪些词换过声音；一次拉整表，不在每张卡里各查各的
  const voices = useWordVoices().data ?? NO_VOICES
  const [voiceFor, setVoiceFor] = useState<string | null>(null)

  const openWord = useWordModalStore((s) => s.openWord)
  const replaceWord = useWordModalStore((s) => s.replaceWord)
  const modalOpen = useWordModalStore((s) => s.stack.length > 0)
  const [cursor, setCursor] = useState<number | null>(null)

  /** 词卡语境：场景例句优先，无例句时退到本名做弱语境（FR-164） */
  const contextOf = (item: DeckItem): string =>
    item.example_en ?? `${deck.name}：${item.word}`
  const sourceOf = (item: DeckItem) => ({
    kind: 'wordlist' as const,
    label: deck.name,
    locator: { deck: deck.key, word: item.word },
  })

  /* ---- 听读连播（FR-485）：范围就是网格此刻的筛选，队列与网格是同一份数据 ----
     听读常驻在 store 里（BR-184）：切走菜单照常念，回来重新挂上；只有正在念的就是
     这一本时，本页才当自己在听——换到别的本，点卡片照常开词卡、不显示停靠条 */
  const listeningHere = useListenStore((s) => s.visible && s.deckKey === deck.key)
  const listeningActive = useListenStore((s) => s.visible)
  const activeWord = useListenStore((s) =>
    s.visible && s.deckKey === deck.key ? s.currentWord : null,
  )
  const played = useListenStore((s) => s.played)
  // 考纲本分页续拉：听读开着就一直拉到底，全装满才允许开播；关掉自然停（BR-56）
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = pagedQuery
  useEffect(() => {
    if (!listeningHere || isScenario || !hasNextPage || isFetchingNextPage) return
    void fetchNextPage()
  }, [listeningHere, isScenario, hasNextPage, isFetchingNextPage, fetchNextPage])
  const loadedAll = isScenario
    ? groupedQuery.data !== undefined
    : pagedQuery.data !== undefined && !hasNextPage
  useEffect(() => {
    if (listeningHere) useListenStore.getState().setScope(scopeKey)
  }, [listeningHere, scopeKey])
  useEffect(() => {
    if (listeningHere) useListenStore.getState().setItems(items, loadedAll)
  }, [listeningHere, items, loadedAll])
  const startListen = () => {
    setPicking(false)
    setPicked(new Set())
    useListenStore
      .getState()
      .open(deck.key, deck.name, scopeKey, `${window.location.pathname}${window.location.search}`)
  }

  /* 听读过的词算学习中（FR-500）：念到哪个词，哪个词当场变「学习中」——每词提交一次，
     乐观补丁先把卡片上的 chip 换掉。`filter=new` 下这个词按理已不在筛选里，但列表不会因此
     重拉；真重拉（切走再回来）时队列由 listenStore.setItems 保住正在念的词，不会被挤出 */
  const exposeMutate = expose.mutate
  useEffect(() => {
    if (played === null || !listeningHere) return
    exposeMutate([played.word])
  }, [played, listeningHere, exposeMutate])

  const [maintain, setMaintain] = useState<MaintenanceKind | null>(null)
  const aiRun = useDeckAiRun(deck.key).data?.run ?? null

  const openCard = (index: number, replace: boolean) => {
    const item = items[index]
    if (item === undefined) return
    setCursor(index)
    if (replace) replaceWord(item.word, contextOf(item), sourceOf(item))
    else openWord(item.word, contextOf(item), undefined, sourceOf(item))
    /* 点开词卡 = 一次「看过」。服务端有冷却窗（默认 6 小时），
       翻来覆去点同一张卡不会重复计数——否则连点三下就判「学习过」，
       这个阈值配成几都没意义。曝光只写计数，不碰 FSRS 调度。 */
    expose.mutate([item.word])
  }

  const openAt = (index: number, replace: boolean) => {
    const item = items[index]
    if (item === undefined) return
    if (picking) {
      togglePick(item.word)
      return
    }
    // 听读开着时点卡片 = 跳到它念（音乐播放器语义）；看词卡走条上的「词卡」按钮。
    // 焦点别留在卡片上：留着的话下一下空格会被卡片自己吃掉
    if (listeningHere) {
      ;(document.activeElement as HTMLElement | null)?.blur?.()
      useListenStore.getState().jumpTo(item.word)
      return
    }
    openCard(index, replace)
  }

  /* 弹层开着时方向键翻词（FR-165）：← ↑ 上一个，→ ↓ 下一个。直接换卡，不经 openAt——
     听读开着时 openAt 是「跳到它念」，翻卡不该把播放也带跑。焦点在输入框（改音色、搜索）里不接 */
  useEffect(() => {
    if (!modalOpen || cursor === null) return
    const onKey = (e: KeyboardEvent) => {
      if (overlayDepth() > 0) return
      const delta = MODAL_STEP[e.key]
      if (delta === undefined) return
      if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable="true"]')) return
      if (useWordModalStore.getState().followListen) {
        e.preventDefault()
        const listen = useListenStore.getState()
        if (delta > 0) listen.next()
        else listen.prev()
        return
      }
      const next = cursor + delta
      if (next < 0 || next >= items.length) return
      e.preventDefault()
      openCard(next, true)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalOpen, cursor, items.length])

  return (
    <div className="dd">
      {expose.error && <div role="alert">学习记录保存失败：{expose.error.message}
        <button className="btn" onClick={() => expose.variables && expose.mutate(expose.variables)}>重试保存</button>
      </div>}
      <DeckHeader
        deck={deck}
        showSummary={showSummary}
        total={total}
        onLearn={onLearn}
        onReview={onReview}
        onShowPipeline={
          deck.kind === 'scenario' && deck.source === 'ai' ? () => setShowPipeline((v) => !v) : undefined
        }
        onDictation={onDictation}
        onDrill={onDrill === undefined ? undefined : () => onDrill(scene)}
        onListen={startListen}
        onMaintain={setMaintain}
        aiRun={aiRun}
      />

      {maintain === 'audio' && <ClearDeckAudioOverlay deck={deck} onClose={() => setMaintain(null)} />}
      {maintain === 'reset' && <ResetProgressOverlay deck={deck} onClose={() => setMaintain(null)} />}
      {maintain === 'ai' && <DeckAiRunOverlay deck={deck} onClose={() => setMaintain(null)} />}

      {deck.kind === 'scenario' && !showPipeline && (
        <div className="dd-tabs">
          <div className="seg">
            <button className={tab === 'words' ? 'active' : undefined} onClick={() => setTab('words')}>
              词条 {total > 0 ? total : ''}
            </button>
            <button
              className={tab === 'passage' ? 'active' : undefined}
              onClick={() => setTab('passage')}
              title="把本内的词织进一段真实语境"
            >
              场景短文
            </button>
          </div>
        </div>
      )}

      {tab === 'passage' && !showPipeline && <PassagePane deck={deck} />}

      {voiceFor !== null && <WordVoicePicker word={voiceFor} onClose={() => setVoiceFor(null)} />}

      {gramSentence !== null && (
        <Overlay card="dd-gram-modal" onClose={() => setGramSentence(null)}>
          <div className="dd-gram-head">
            <b>句子语法</b>
            <button className="btn-ghost-sm" onClick={() => setGramSentence(null)}>
              关闭
            </button>
          </div>
          <p className="dd-gram-sent">{gramSentence}</p>
          <div className="dd-gram-body">
            <SentencePanel sel={sentenceSel(gramSentence)} onClose={() => setGramSentence(null)} />
          </div>
        </Overlay>
      )}

      {showPipeline && (
        <SubjectPipelinePane
          domain="scenario_deck"
          subjectId={Number(deck.key.split(':')[1])}
          onClose={() => setShowPipeline(false)}
          onRerun={(step, scope, config) =>
            apiScenario.rerun(
              Number(deck.key.split(':')[1]),
              step,
              scope === 'failed' ? 'downstream' : scope,
              config,
            )
          }
        />
      )}

      {!showPipeline && tab === 'words' && (
      <div className="dd-tools">
        <div className="seg">
          {DECK_FILTERS.map((f) => (
            <button
              key={f.value}
              className={filter === f.value ? 'active' : undefined}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <Picker
          size="sm"
          className="dd-select"
          value={sort}
          onChange={(v) => setSort(v as DeckSort)}
          options={DECK_SORTS.map((s) => ({ value: s.value, label: s.label }))}
        />
        <div className="dd-search">
          <IconSearch />
          <input
            placeholder="本内搜索"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>
        <div style={{ flex: 1 }} />
        {/* 遮挡开关：藏一边、回想另一边。两个互斥——两边都藏卡片就全空了。
            再点一次取消。点被遮的那块可以临时揭开这一张（`MaskedText`）。 */}
        <div className="seg dd-mask">
          <button
            className={hideZh ? 'active' : undefined}
            title="藏中文：看英文回想意思，点被遮的地方揭开这一张"
            onClick={() => setPrefs({ study: { hideZh: !hideZh, hideEn: false } })}
          >
            <IconEyeOff />
            藏中文
          </button>
          <button
            className={hideEn ? 'active' : undefined}
            title="藏英文：看中文回想单词，点被遮的地方揭开这一张"
            onClick={() => setPrefs({ study: { hideEn: !hideEn, hideZh: false } })}
          >
            <IconEyeOff />
            藏英文
          </button>
        </div>
        <button
          className={`btn btn-soft${picking ? ' active' : ''}`}
          onClick={() => {
            // 底部只容得下一条：进多选就关听读（BR-187）
            if (listeningHere) useListenStore.getState().close()
            setPicking((v) => !v)
            setPicked(new Set())
          }}
        >
          <IconCheck />
          {picking ? '退出多选' : '多选'}
        </button>
        <div className="seg">
          <button className={view === 'list' ? 'active' : undefined} onClick={() => setView('list')}>
            列表
          </button>
          <button className={view === 'grid' ? 'active' : undefined} onClick={() => setView('grid')}>
            卡片
          </button>
        </div>
      </div>
      )}

      {/* 考纲本：场景条常驻，点哪个就只看那个场景的词，再点一次回到全部。
          它是筛选器不是入口——上一版做成整屏卡片网格、点进去把网格换掉，
          读起来像进了另一个页面，而这里要的只是换一下下面看哪批词。
          卡片网格没删，在自测页仍是主入口（那里挑场景确实是导航）。 */}
      {!showPipeline && tab === 'words' && !isScenario && scenes.length > 0 && (
        <SceneRail
          scenes={scenes}
          active={scene}
          total={deck.total}
          onPick={(k) => patchParams({ g: k === '' ? null : k })}
        />
      )}

      {!showPipeline && tab === 'words' && isPending && (
        <div className="state-block">
          <div className="spinner" />
          <div>加载词条…</div>
        </div>
      )}

      {!showPipeline && tab === 'words' && isError && (
        <div className="state-block">
          <div>词条加载失败：{errorMsg}</div>
          <button
            className="btn btn-outline"
            onClick={() =>
              void (isScenario ? groupedQuery.refetch() : pagedQuery.refetch())
            }
          >
            重试
          </button>
        </div>
      )}

      {!showPipeline && tab === 'words' && !isPending && !isError && items.length === 0 && maskMode === 'none' && (
        <div className="state-block">没有匹配的词条</div>
      )}

      {!showPipeline &&
        tab === 'words' &&
        (!isPending || items.length > 0) &&
        <DeckSelfTest key={`${scopeKey}|${maskMode}|${picking}|${listeningActive}`} enabled={maskMode !== 'none' && !picking && !listeningActive} filter={filter} items={items} onLoadMore={!isScenario && hasNextPage && !isFetchingNextPage ? () => { void fetchNextPage() } : undefined} onMark={async (word, value) => {
          await apiScene.mark([word], value)
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: ['deck-words', deck.key] }),
            queryClient.invalidateQueries({ queryKey: ['deck-words-all', deck.key] }),
            queryClient.invalidateQueries({ queryKey: ['deck-scenes', deck.key] }),
            queryClient.invalidateQueries({ queryKey: ['decks'] }),
          ])
        }} onOpenWord={item => {
          setCursor(items.findIndex(current => current.word === item.word))
          openWord(item.word, contextOf(item), undefined, sourceOf(item))
          expose.mutate([item.word])
        }}>{visibleItems => (isScenario && groups.length > 0 ? (
          <GroupedWords
            items={visibleItems}
            mask={maskMode}
            onMark={(word, m) => mark.mutate({ words: [word], value: m })}
            onGrammar={setGramSentence}
            groups={groups}
            view={view}
            picked={picking ? picked : null}
            onPick={(word) => openAt(items.findIndex(item => item.word === word.word), false)}
            voices={voices}
            onVoice={setVoiceFor}
            activeWord={activeWord}
          />
        ) : (
          <VirtualWords
            items={visibleItems}
            mask={maskMode}
            onMark={(word, m) => mark.mutate({ words: [word], value: m })}
            onGrammar={setGramSentence}
            view={view}
            picked={picking ? picked : null}
            hasMore={!isScenario && (pagedQuery.hasNextPage ?? false)}
            loadingMore={pagedQuery.isFetchingNextPage}
            onLoadMore={() => void pagedQuery.fetchNextPage()}
            onPick={(index) => openAt(items.findIndex(item => item.word === visibleItems[index].word), false)}
            voices={voices}
            onVoice={setVoiceFor}
            activeWord={activeWord}
          />
        ))}</DeckSelfTest>}

      {listeningHere && tab === 'words' && (
        <ListenBar
          deckName={deck.name}
          total={total}
          loadedCount={items.length}
          onOpenWord={(word) => {
            const index = items.findIndex((it) => it.word === word)
            if (index >= 0) openCard(index, false)
          }}
          onChangeVoice={setVoiceFor}
        />
      )}

      {picking && !listeningHere && tab === 'words' && (
        <div className="dd-batchbar">
          <span className="dd-batch-count">已选 {picked.size} 个</span>
          <button
            className="btn-ghost-sm"
            onClick={() => setPicked(new Set(items.map((i) => i.word)))}
          >
            全选本页
          </button>
          <button className="btn-ghost-sm" onClick={() => setPicked(new Set())}>
            清空
          </button>
          <div style={{ flex: 1 }} />
          {batch.isError && <span className="dd-batch-err">{batch.error.message}</span>}
          <button
            className="btn btn-soft"
            disabled={picked.size === 0 || batch.isPending}
            onClick={() => batch.mutate({ action: 'collect' })}
          >
            <IconStar />
            加入生词本
          </button>
          <button
            className="btn btn-soft"
            disabled={picked.size === 0 || batch.isPending}
            onClick={() => batch.mutate({ action: 'master' })}
          >
            <IconCheck />
            标记已掌握
          </button>
          {deck.editable && (
            <button
              className="btn btn-danger"
              disabled={picked.size === 0 || batch.isPending}
              onClick={() => batch.mutate({ action: 'remove' })}
            >
              <IconTrash />
              移出本
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/* ---- 页头 ---- */

function DeckHeader({
  deck,
  showSummary,
  total,
  onLearn,
  onShowPipeline,
  onReview,
  onDictation,
  onDrill,
  onListen,
  onMaintain,
  aiRun,
}: {
  deck: Deck
  showSummary: boolean
  total: number
  onLearn?: () => void
  onShowPipeline?: () => void
  onReview?: () => void
  onDictation?: () => void
  onDrill?: () => void
  onListen: () => void
  onMaintain: (kind: MaintenanceKind) => void
  aiRun: DeckAiRun | null
}) {
  const hasImage2Cover = vocabCoverCell(deck) !== null
  return (
    <div className="dd-head vp-deck-head">
      {showSummary && <><div className="vp-deck-thumbnail">
      {hasImage2Cover ? (
        <VocabCoverArtwork deck={deck} />
      ) : (
        deck.cover_url !== null ? <img src={deck.cover_url} alt="" /> : <span>{deckInitial(deck.name)}</span>
      )}
      </div>
      <div className="dd-head-main">
        <div className="dd-head-title">
          {deck.name}
          {deck.source === 'ai' && <span className="deck-badge ai">AI 生成</span>}
          {deck.cefr && <span className="deck-badge">{deck.cefr}</span>}
        </div>
        {deck.description && <div className="dd-head-desc">{deck.description}</div>}
        <div className="dd-head-stats">
          {MASTERY_META.map(({ key, label, color }) => (
            <span key={key}>
              <i style={{ background: color }} />
              {label} {(deck.mastery[key] ?? 0).toLocaleString()}
            </span>
          ))}
          <span className="dd-head-total">全书 {deck.total.toLocaleString()} 词 · 当前筛选 {total.toLocaleString()} 词</span>
        </div>
      </div>
      </>}
      {deck.kind === 'scenario' && onShowPipeline && (
        <button className="btn btn-soft" onClick={onShowPipeline} title="查看 AI 生成的每一步">
          <IconTarget />
          生成过程
        </button>
      )}
      <button
        className="btn btn-soft"
        onClick={onListen}
        title="听读连播：按下面的筛选自动一个个念，念几遍、念不念释义可调"
      >
        <IconSpeaker />
        听读
      </button>
      {onDrill && (
        <button className="btn btn-soft" onClick={onDrill} title="成组过词：浏览→自测→过关">
          <IconCheck />
          速记
        </button>
      )}
      {onDictation && (
        <button className="btn btn-soft" onClick={onDictation}>
          <IconSpeaker />
          选择训练
        </button>
      )}
      {onReview && <button className="btn btn-soft" onClick={onReview}>复习本书</button>}
      {onLearn && (
        <button className="btn btn-primary" onClick={onLearn}>
          <IconPlus />
          学新词
        </button>
      )}
      {aiRun !== null && isAiRunActive(aiRun) && (
        <button
          className="dd-ai-chip"
          title="AI 补全进行中，点开看进度"
          onClick={() => onMaintain('ai')}
        >
          AI 补全 {aiRun.done} / {aiRun.total}
        </button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="icon-btn dd-head-more" title="更多：AI 补全 / 清发音缓存 / 清学习进度">
            <IconMore />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => onMaintain('ai')}>AI 补全本内词条…</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onMaintain('audio')}>清除发音缓存…</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onMaintain('reset')}>清除学习进度…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/* ---- 分组分节（场景本） ---- */

function GroupedWords({
  items,
  mask,
  onMark,
  onGrammar,
  groups,
  view,
  picked,
  onPick,
  voices,
  onVoice,
  activeWord,
}: {
  items: DeckItem[]
  mask: MaskMode
  onMark?: (word: string, m: WordMark | null) => void
  onGrammar: (sentence: string) => void
  groups: Array<{ key: string; label: string; count: number }>
  view: ViewMode
  /** 非 null 即处于多选态，集合内的词显示为已选 */
  picked: Set<string> | null
  onPick: (item: DeckItem) => void
  voices: WordVoiceMap
  onVoice: (word: string) => void
  /** 听读正在念的词：高亮并滚到视口中央 */
  activeWord: string | null
}) {
  const selfTest = useDeckSelfTest()
  const focusWord = selfTest?.selected ?? activeWord
  // 容器滚动场景里 smooth 会被 Chromium 静默丢弃，手算位置走 scrollTo（同 playerStore）
  useEffect(() => {
    if (focusWord === null) return
    const el = document.querySelector<HTMLElement>(`.dd-body [data-word="${CSS.escape(focusWord)}"]`)
    const scroller = el?.closest<HTMLElement>('.dd-body')
    if (!el || !scroller) return
    const er = el.getBoundingClientRect()
    const sr = scroller.getBoundingClientRect()
    if (selfTest && er.top >= sr.top && er.bottom <= sr.bottom) return
    scroller.scrollTo({ top: scroller.scrollTop + er.top + er.height / 2 - (sr.top + sr.height / 2), behavior: 'auto' })
  }, [focusWord])

  const byGroup = useMemo(() => {
    const map = new Map<string, DeckItem[]>()
    for (const item of items) {
      const key = item.group_key ?? 'other'
      const bucket = map.get(key)
      if (bucket) bucket.push(item)
      else map.set(key, [item])
    }
    return map
  }, [items])

  const sections = [
    ...groups.filter((g) => byGroup.has(g.key)),
    ...(byGroup.has('other') ? [{ key: 'other', label: '其他', count: 0 }] : []),
  ]

  return (
    <div className="dd-body">
      {sections.map((g) => (
        <section className="dd-section" key={g.key}>
          <div className="dd-section-head">
            {g.label}
            <span className="shelf-group-count">{byGroup.get(g.key)?.length ?? 0}</span>
          </div>
          <div className={view === 'grid' ? 'dd-grid' : 'dd-list'}>
            {(byGroup.get(g.key) ?? []).map((item) =>
              view === 'grid' ? (
                <WordTile
                  key={item.word}
                  item={item}
                  mask={mask}
                  picked={picked?.has(item.word) ?? null}
                  onPick={() => onPick(item)}
                  onMark={onMark === undefined ? undefined : (m) => onMark(item.word, m)}
                  onGrammar={onGrammar}
                  pinned={voices.get(normalizeWord(item.word)) ?? null}
                  onVoice={() => onVoice(item.word)}
                  active={item.word === activeWord}
                />
              ) : (
                <WordRow
                  key={item.word}
                  item={item}
                  mask={mask}
                  picked={picked?.has(item.word) ?? null}
                  onPick={() => onPick(item)}
                  onMark={onMark === undefined ? undefined : (m) => onMark(item.word, m)}
                  pinned={voices.get(normalizeWord(item.word)) ?? null}
                  onVoice={() => onVoice(item.word)}
                  active={item.word === activeWord}
                />
              ),
            )}
          </div>
        </section>
      ))}
    </div>
  )
}

/* ---- 虚拟滚动（大词表） ---- */

function VirtualWords({
  items,
  mask,
  onMark,
  onGrammar,
  view,
  picked,
  hasMore,
  loadingMore,
  onLoadMore,
  onPick,
  voices,
  onVoice,
  activeWord,
}: {
  items: DeckItem[]
  mask: MaskMode
  onMark?: (word: string, m: WordMark | null) => void
  onGrammar: (sentence: string) => void
  view: ViewMode
  picked: Set<string> | null
  hasMore: boolean
  loadingMore: boolean
  onLoadMore: () => void
  onPick: (index: number) => void
  voices: WordVoiceMap
  onVoice: (word: string) => void
  activeWord: string | null
}) {
  const selfTest = useDeckSelfTest()
  const focusWord = selfTest?.selected ?? activeWord
  // 滚动容器用 state 持有：useRef 在首帧是 null，virtualizer 拿不到就不会订阅滚动，
  // 且不会自动重试（表现为列表渲染出来但滚动时窗口不动）
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null)
  const [columns, setColumns] = useState(1)

  // 卡片视图按可用宽度反推列数，列表视图恒为单列
  useLayoutEffect(() => {
    const el = scrollEl
    if (el === null) return
    if (view === 'list') {
      setColumns(1)
      return
    }
    const measure = () => {
      const width = el.clientWidth - 4
      setColumns(Math.max(1, Math.floor((width + GRID_GAP) / (CARD_MIN_WIDTH + GRID_GAP))))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [view, scrollEl])

  const rows = useMemo(() => {
    if (columns <= 1) return items.map((item) => [item])
    const out: DeckItem[][] = []
    for (let i = 0; i < items.length; i += columns) out.push(items.slice(i, i + columns))
    return out
  }, [items, columns])

  /* 行高只当初值，真实高度由 `measureElement` 实测。

     > [!danger] 写死行高会把卡片内容压没
     >
     > `CARD_HEIGHT = 104` 是按「没有例句」的卡定的（标题 23 + 音标 17 + 释义 38 + 内边距）。
     > 考纲本加上例句后一张卡要 ~199px，而虚拟行仍按 104 给高度——
     > 卡是 `display:flex; column`，装不下就按 flex-shrink 压，**中文释义被压成了 0 高**。
     > 表现是「卡片上没有中文意思」，但数据一直在，元素也在，只是高度为 0。
     > 例句是 2 行还是 3 行还不一定，所以不能换个更大的常数了事，得实测。 */
  const rowHeight = view === 'grid' ? CARD_HEIGHT + GRID_GAP : ROW_HEIGHT
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => rowHeight,
    overscan: 8,
    measureElement: (el) => el.getBoundingClientRect().height,
  })

  // 听读跟随：列数只有这里知道，行号得在这里算；队列与网格同源，索引永远在范围内
  useEffect(() => {
    if (focusWord === null) return
    const idx = items.findIndex((it) => it.word === focusWord)
    if (idx < 0) return
    virtualizer.scrollToIndex(Math.floor(idx / columns), { align: selfTest ? 'auto' : 'center' })
  }, [focusWord, items, columns, virtualizer])

  const virtualRows = virtualizer.getVirtualItems()
  const last = virtualRows[virtualRows.length - 1]

  // 渲染窗口逼近末尾时预拉下一页，滚动过程中不出现空白
  useEffect(() => {
    if (last === undefined || !hasMore || loadingMore) return
    if (last.index >= rows.length - 3) onLoadMore()
  }, [last, hasMore, loadingMore, rows.length, onLoadMore])

  return (
    <div className="dd-scroll" ref={setScrollEl}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualRows.map((vr) => {
          const row = rows[vr.index]
          if (row === undefined) return null
          return (
            <div
              key={vr.key}
              data-index={vr.index}
              ref={virtualizer.measureElement}
              className={view === 'grid' ? 'dd-vrow grid' : 'dd-vrow'}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                // 不写死 height：写死了测出来的永远是这个值，实测就失去意义
                transform: `translateY(${vr.start}px)`,
                gridTemplateColumns: view === 'grid' ? `repeat(${columns}, 1fr)` : undefined,
              }}
            >
              {row.map((item, col) =>
                view === 'grid' ? (
                  <WordTile
                    key={item.word}
                    item={item}
                    mask={mask}
                    picked={picked?.has(item.word) ?? null}
                    onPick={() => onPick(vr.index * columns + col)}
                    onMark={onMark === undefined ? undefined : (m) => onMark(item.word, m)}
                    onGrammar={onGrammar}
                    pinned={voices.get(normalizeWord(item.word)) ?? null}
                    onVoice={() => onVoice(item.word)}
                    active={item.word === activeWord}
                  />
                ) : (
                  <WordRow
                    key={item.word}
                    item={item}
                    mask={mask}
                    picked={picked?.has(item.word) ?? null}
                    onPick={() => onPick(vr.index * columns + col)}
                    onMark={onMark === undefined ? undefined : (m) => onMark(item.word, m)}
                    pinned={voices.get(normalizeWord(item.word)) ?? null}
                    onVoice={() => onVoice(item.word)}
                    active={item.word === activeWord}
                  />
                ),
              )}
            </div>
          )
        })}
      </div>
      {loadingMore && <div className="dd-more">加载中…</div>}
    </div>
  )
}

/* ---- 词条渲染 ---- */

/** 例句块（FR-255~257、FR-291）：中英对照、整块朗读、句中词可点。
    热区是整块（含中文），不是那个小喇叭——看例句时本来就想听它怎么念（同 FR-128）。 */
function ExampleBlock({
  item,
  m,
  onGrammar,
}: {
  item: DeckItem
  m: CardMask
  onGrammar: (sentence: string) => void
}) {
  const sentence = item.example_en as string
  const say = () => playTts(sentence, 'sentence')
  // 听读条在页面上时空格归它（播放 / 暂停），例句块只认 Enter
  const listening = useListenStore((s) => s.visible && s.barMounted)
  return (
    <div
      className="dd-tile-eg"
      role="button"
      tabIndex={0}
      title="点这块任意位置朗读整句；点句中单词查词卡"
      onClick={(e) => {
        // 点句中的单词由 ClickableEn 自己 stopPropagation；拖选复制时不该顺带朗读
        if ((window.getSelection()?.toString() ?? '').trim() !== '') return
        e.stopPropagation()
        say()
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || (e.key === ' ' && !listening)) {
          e.preventDefault()
          e.stopPropagation()
          say()
        }
      }}
    >
      <div className="dd-eg-en">
        <IconSpeaker className="dd-eg-icon" />
        {/* 必须包一层：ClickableEn 吐的是文本节点 + span，直接放进 flex 容器
            会各自成为独立 flex item 排成一行，句子撑出卡片而不换行 */}
        <p className={m.cls('en').trim()} {...m.bind('en')}>
          <ClickableEn text={sentence} context={sentence} force />
        </p>
      </div>
      {item.example_zh && (
        <div className={`dd-eg-zh${m.cls('zh')}`} {...m.bind('zh')}>
          {item.example_zh}
        </div>
      )}
      {/* 语法分析入口：悬停才露出。

          这一栏一屏能铺三四十张卡，常驻一个图标就是三四十个图标在抢注意力——
          与刚定的「安静」方向相反。它又确实值得有：例句是这个词的用法出处，
          「这句为什么这么说」是看着例句时最自然的下一个问题。
          所以按低频动作处理，跟词卡上的编辑/删除同一套（悬停露出）。 */}
      <button
        className="dd-eg-gram"
        title="分析这句的语法结构"
        onClick={(e) => {
          e.stopPropagation()
          onGrammar(sentence)
        }}
      >
        <IconTarget />
        语法
      </button>
    </div>
  )
}

/* 状态徽标：点开就能自己标。

   `bucket` 是算法推断的（打开过=学习中、FSRS 成熟=已掌握），`mark` 是用户自己按的。
   两者都渲染成同一枚徽标，但人工标记的那枚描一圈实边——
   不区分的话，用户按完「已掌握」看到的样子和算法猜的一模一样，
   下次再看根本不知道这是谁定的。 */
function BucketChip({ item, onMark }: { item: DeckItem; onMark?: (m: WordMark | null) => void }) {
  const label = item.mark !== null ? MARK_LABELS[item.mark] : BUCKET_LABELS[item.bucket]
  const tone = item.mark === 'hard' ? 'hard' : item.mark === 'mastered' ? 'mature' : item.bucket
  const cls = `dd-chip ${tone}${item.mark !== null ? ' manual' : ''}`

  if (onMark === undefined) return <span className={cls}>{label}</span>

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* 徽标本身就是按钮：卡片整块可点（打开详情），所以这里要吃掉冒泡，
            否则「想标一下」会顺带弹出词卡详情 */}
        <button
          className={cls}
          title="点一下自己标：学习中 / 已掌握 / 困难词"
          onClick={(e) => e.stopPropagation()}
        >
          {label}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        {MARK_ORDER.map((m) => (
          <DropdownMenuItem key={m} onSelect={() => onMark(m)}>
            <span className={`dd-dot ${m}`} />
            {MARK_LABELS[m]}
            {item.mark === m && <span style={{ marginLeft: 'auto' }}>✓</span>}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem onSelect={() => onMark(null)}>
          <span className="dd-dot auto" />
          交给自动判定
          {item.mark === null && <span style={{ marginLeft: 'auto' }}>✓</span>}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** 卡片 / 行上的喇叭与「换声音」（FR-495）。
    两个按钮的 click 与 keydown 都要拦住冒泡：卡片自己在 Enter 上开词卡，
    不拦的话键盘用户按一下喇叭会同时弹出词卡。 */
function VoiceActions({
  word,
  pinned,
  onVoice,
}: {
  word: string
  pinned: WordVoice | null
  onVoice: () => void
}) {
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation()
  return (
    <span className="dd-tile-acts" onKeyDown={stop}>
      <button
        className={`icon-btn${pinned === null ? '' : ' dd-voice-on'}`}
        title={pinned === null ? '发音' : `发音（已换声音：${pinned.voice}）`}
        onClick={(e) => {
          stop(e)
          playTts(word, 'word')
        }}
      >
        <IconSpeaker />
      </button>
      <button
        className="icon-btn"
        title="换个声音：只换这一个词的发音"
        onClick={(e) => {
          stop(e)
          onVoice()
        }}
      >
        <IconVoice />
      </button>
    </span>
  )
}

function WordRow({
  item,
  picked,
  mask,
  onPick,
  onMark,
  pinned,
  onVoice,
  active,
}: {
  item: DeckItem
  picked: boolean | null
  mask: MaskMode
  onPick: () => void
  onMark?: (m: WordMark | null) => void
  pinned: WordVoice | null
  onVoice: () => void
  active: boolean
}) {
  const selfTest = useDeckSelfTest()
  const m = useCardMask(mask, item.word)
  return (
    <div
      className={`dd-row${picked === null ? '' : picked ? ' picked' : ' pickable'}${active ? ' playing' : ''}`}
      data-word={item.word}
      aria-current={selfTest?.selected === item.word ? true : undefined}
      role="button"
      tabIndex={0}
      onClick={() => selfTest ? selfTest.reveal(item.word) : onPick()}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && e.key === 'Enter') { e.preventDefault(); selfTest ? selfTest.reveal(item.word) : onPick() }
      }}
    >
      {picked !== null && <span className={`dd-tick${picked ? ' on' : ''}`} />}
      <span className={`dd-row-word${m.cls('en')}`} {...m.bind('en')}>
        {item.word}
      </span>
      {item.phonetic && (
        <span className={`dd-row-phon${m.cls('en')}`} {...m.bind('en')}>
          /{item.phonetic}/
        </span>
      )}
      <span className={`dd-row-trans${m.cls('zh')}`} {...m.bind('zh')}>
        {item.translation ?? '—'}
      </span>
      {item.dict_miss && <span className="dd-chip miss">词典外</span>}
      <BucketChip item={item} onMark={selfTest ? value => value ? selfTest.mark(item.word, value) : onMark?.(value) : onMark} />
      <VoiceActions word={item.word} pinned={pinned} onVoice={onVoice} />
    </div>
  )
}

export function WordTile({
  item,
  picked,
  mask,
  onPick,
  onMark,
  onGrammar,
  pinned,
  onVoice,
  active,
  statusKnown = true,
}: {
  item: DeckItem
  picked: boolean | null
  mask: MaskMode
  onPick: () => void
  onMark?: (m: WordMark | null) => void
  onGrammar: (sentence: string) => void
  pinned: WordVoice | null
  onVoice: () => void
  active: boolean
  statusKnown?: boolean
}) {
  const selfTest = useDeckSelfTest()
  const m = useCardMask(mask, item.word)
  return (
    <div
      className={`dd-tile${picked === null ? '' : picked ? ' picked' : ' pickable'}${active ? ' playing' : ''}`}
      data-word={item.word}
      aria-current={selfTest?.selected === item.word ? true : undefined}
      role="button"
      tabIndex={0}
      onClick={() => selfTest ? selfTest.reveal(item.word) : onPick()}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && e.key === 'Enter') { e.preventDefault(); selfTest ? selfTest.reveal(item.word) : onPick() }
      }}
    >
      <div className="dd-tile-head">
        {picked !== null && <span className={`dd-tick${picked ? ' on' : ''}`} />}
        <b className={m.cls('en').trim()} {...m.bind('en')}>
          {item.word}
        </b>
        <VoiceActions word={item.word} pinned={pinned} onVoice={onVoice} />
        {statusKnown && <BucketChip item={item} onMark={selfTest ? value => value ? selfTest.mark(item.word, value) : onMark?.(value) : onMark} />}
      </div>
      {/* 音标跟着英文一起藏：/ˈmʌni/ 摆在那儿，「回想这个词」就没什么可回想的了 */}
      {item.phonetic && (
        <div className={`dd-tile-phon${m.cls('en')}`} {...m.bind('en')}>
          /{item.phonetic}/
        </div>
      )}
      <div className={`dd-tile-trans${m.cls('zh')}`} {...m.bind('zh')}>
        {item.translation ?? '—'}
      </div>
      {item.example_en && <ExampleBlock item={item} m={m} onGrammar={onGrammar} />}
    </div>
  )
}
