import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'

import { IconChart, IconChevronDown, IconSparkle, IconUpload } from '../../components/icons'
import { Picker } from '../../components/ui/picker'
import type { Deck } from '../../lib/api-deck'
import { apiDeck } from '../../lib/api-deck'
import { PRACTICE_MODES } from '../../lib/api-practice'
import { DeckCard } from './DeckCard'
import { PracticePlan } from './PracticePlan'

interface DeckShelfProps {
  onOpenDeck: (deck: Deck) => void
  onStartLearn: (deck: Deck) => void
  onStartReview: () => void
  onResume: (id: string) => void
  onOpenReport: () => void
  onImport: () => void
  onDelete?: (deck: Deck) => void
  onCreateScenario: () => void
}

const GROUPS: Array<{ id: string; title: string; match: (deck: Deck) => boolean }> = [
  { id: 'exam', title: '考纲', match: (deck) => deck.kind === 'exam' },
  { id: 'scenario', title: '场景本', match: (deck) => deck.kind === 'scenario' },
  { id: 'custom', title: '自建词书', match: (deck) => deck.kind === 'custom' },
]

function loadSetting(key: string, fallback: string): string {
  return localStorage.getItem(key) ?? fallback
}

export function DeckShelf({
  onOpenDeck,
  onStartLearn,
  onStartReview,
  onResume,
  onOpenReport,
  onImport,
  onDelete,
  onCreateScenario,
}: DeckShelfProps) {
  const queryClient = useQueryClient()
  const shelfRef = useRef<HTMLDivElement>(null)
  const [keyword, setKeyword] = useState(() => loadSetting('vocab-shelf-query', ''))
  const [density, setDensity] = useState(() => loadSetting('vocab-shelf-density', 'compact'))
  const [sort, setSort] = useState(() => loadSetting('vocab-shelf-sort', 'recent'))
  const [kind, setKind] = useState(() => loadSetting('vocab-shelf-kind', 'all'))
  const [planOpen, setPlanOpen] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('vocab-shelf-collapsed') ?? '["archived"]') as string[])
    } catch {
      return new Set(['archived'])
    }
  })
  const overview = useQuery({
    queryKey: ['vocab-overview'],
    queryFn: apiDeck.overview,
    staleTime: 30_000,
  })
  const membership = useQuery({
    queryKey: ['vocab-membership', keyword.trim().toLowerCase()],
    queryFn: () => apiDeck.membership(keyword.trim()),
    enabled: /^[a-z][a-z' -]{1,127}$/i.test(keyword.trim()),
    staleTime: 5 * 60_000,
  })

  useEffect(() => {
    const node = shelfRef.current
    if (node) node.scrollTop = Number(sessionStorage.getItem('vocab-shelf-scroll') ?? 0)
  }, [])

  const patchMutation = useMutation({
    mutationFn: ({ key, patch }: { key: string; patch: Parameters<typeof apiDeck.patch>[1] }) =>
      apiDeck.patch(key, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['vocab-overview'] })
      void queryClient.invalidateQueries({ queryKey: ['decks'] })
    },
  })

  const allDecks = overview.data?.decks ?? []
  const membershipKeys = new Set(membership.data?.decks ?? [])
  const decks = useMemo(() => {
    const query = keyword.trim().toLowerCase()
    return allDecks
      .filter((deck) => {
        if (kind !== 'all' && deck.kind !== kind) return false
        if (!query) return true
        return (
          deck.name.toLowerCase().includes(query) ||
          (deck.description ?? '').toLowerCase().includes(query) ||
          (deck.category ?? '').toLowerCase().includes(query) ||
          membershipKeys.has(deck.key)
        )
      })
      .sort((left, right) =>
        sort === 'name'
          ? left.name.localeCompare(right.name, 'zh')
          : (right.last_studied_at ?? '').localeCompare(left.last_studied_at ?? ''),
      )
  }, [allDecks, keyword, kind, sort, membership.data])

  const active = allDecks.filter((deck) => !deck.archived)
  const vocab = active.find((deck) => deck.kind === 'system')
  const pinned = active.filter((deck) => deck.pinned)
  const recent = active
    .filter((deck) => deck.last_studied_at)
    .sort((left, right) => (right.last_studied_at ?? '').localeCompare(left.last_studied_at ?? ''))
    .slice(0, 4)
  const stats = overview.data?.stats
  const profile = overview.data?.profile
  const resume = overview.data?.resume[0]

  const persist = (key: string, value: string, apply: (value: string) => void) => {
    localStorage.setItem(key, value)
    apply(value)
  }

  const toggleGroup = (id: string) => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      localStorage.setItem('vocab-shelf-collapsed', JSON.stringify([...next]))
      return next
    })
  }

  const renderCard = (deck: Deck) => (
    <DeckCard
      key={deck.key}
      deck={deck}
      onOpen={() => onOpenDeck(deck)}
      onTogglePin={
        deck.editable
          ? () => patchMutation.mutate({ key: deck.key, patch: { pinned: !deck.pinned } })
          : undefined
      }
      onDelete={deck.deletable && onDelete ? () => onDelete(deck) : undefined}
    />
  )

  const section = (id: string, title: string, items: Deck[], extra?: React.ReactNode) => {
    if (items.length === 0 && extra === undefined) return null
    const hidden = collapsed.has(id)
    return (
      <section className="shelf-group" key={id}>
        <div className="shelf-group-head">
          <button onClick={() => toggleGroup(id)} aria-expanded={!hidden}>
            <IconChevronDown className={`caret${hidden ? ' collapsed' : ''}`} />
            {title}
            <span className="shelf-group-count">{items.length}</span>
          </button>
        </div>
        {!hidden && <div className="shelf-grid">{items.map(renderCard)}{extra}</div>}
      </section>
    )
  }

  return (
    <div
      className="shelf"
      ref={shelfRef}
      onScroll={(event) => sessionStorage.setItem('vocab-shelf-scroll', String(event.currentTarget.scrollTop))}
    >
      <div className={`shelf-inner vp-density-${density}`}>
        <div className="shelf-layout">
          <main className="shelf-main">
            <div className="shelf-today">
              <div className="shelf-today-stat accent"><b>{stats?.due_now ?? '…'}</b><span>待复习</span></div>
              <div className="shelf-today-sep" />
              <div className="shelf-today-stat ok"><b>{profile?.daily_new ?? '…'}</b><span>每日新词</span></div>
              <div className="shelf-today-sep" />
              <div className="shelf-today-stat"><b>{stats?.streak_days ?? '…'}</b><span>连续学习（天）</span></div>
              <div className="shelf-primary-actions">
                <button className="btn" onClick={() => setPlanOpen(true)}>调整计划</button>
                <button className="btn btn-primary" onClick={onStartReview}>开始复习{stats?.due_now ? `（${stats.due_now}）` : ''}</button>
              </div>
            </div>
            <div className="shelf-mobile-shortcuts" aria-label="学习快捷入口">
              {resume && <button className="btn" onClick={() => onResume(resume.id)}>继续 {PRACTICE_MODES[resume.mode].name} · {resume.cursor}/{resume.total}</button>}
              {vocab && <button className="btn" onClick={() => onOpenDeck(vocab)}>生词本 · {vocab.total.toLocaleString()} 词</button>}
              <button className="btn" onClick={onOpenReport}>学习报告</button>
            </div>
            {(stats?.due_now ?? 0) > (profile?.daily_new ?? 10) * 5 && (
              <p className="vp-backlog">到期复习较多，建议先完成复习，再安排今天的新词。</p>
            )}
            <div className="shelf-toolbar">
              <input
                className="shelf-search"
                placeholder="搜索词书或英文单词"
                value={keyword}
                onChange={(event) => {
                  setKeyword(event.target.value)
                  localStorage.setItem('vocab-shelf-query', event.target.value)
                }}
              />
              <Picker value={kind} onChange={(value) => persist('vocab-shelf-kind', value, setKind)} options={[{ value: 'all', label: '全部类型' }, { value: 'exam', label: '考纲' }, { value: 'scenario', label: '场景本' }, { value: 'custom', label: '自建词书' }]} />
              <Picker value={sort} onChange={(value) => persist('vocab-shelf-sort', value, setSort)} options={[{ value: 'recent', label: '最近学习' }, { value: 'name', label: '名称' }]} />
              <Picker value={density} onChange={(value) => persist('vocab-shelf-density', value, setDensity)} options={[{ value: 'compact', label: '紧凑' }, { value: 'comfortable', label: '舒适' }]} />
              {membership.isFetching && <span className="shelf-search-note">正在查找所属词书…</span>}
            </div>
            {keyword.trim() && membership.data && membershipKeys.size > 0 && <div className="shelf-membership-results">
              <span>“{membership.data.word}”所在词书</span>
              {allDecks.filter((deck) => membershipKeys.has(deck.key)).map((deck) => <div key={deck.key}>
                <button onClick={() => onOpenDeck(deck)}>{deck.name}</button>
                {deck.kind !== 'system' && <button onClick={() => onStartLearn(deck)}>从本书学新词</button>}
              </div>)}
            </div>}

            {overview.isPending && <div className="shelf-grid shelf-loading">{[0, 1, 2, 3, 4, 5, 6, 7].map((key) => <div key={key} className="deck-card skeleton" aria-hidden><div className="deck-cover" /><div className="deck-skeleton-body" /></div>)}</div>}
            {overview.isError && <div className="shelf-empty" role="alert">词书加载失败：{overview.error.message}<button className="btn" onClick={() => void overview.refetch()}>重试</button></div>}
            {overview.isSuccess && decks.length === 0 && <div className="shelf-empty">没有找到与「{keyword}」相关的词书</div>}
            {overview.isSuccess && (
              <>
                {GROUPS.map((group) => section(
                  group.id,
                  group.title,
                  decks.filter((deck) => group.match(deck) && !deck.archived),
                  group.id === 'custom' ? <button key="import" className="deck-new" onClick={onImport}><IconUpload />导入词表</button>
                    : group.id === 'scenario' ? <button key="scenario" className="deck-new" onClick={onCreateScenario}><IconSparkle />生成场景本</button>
                      : undefined,
                ))}
                {section('archived', '归档', decks.filter((deck) => deck.archived))}
              </>
            )}
          </main>

          <aside className="shelf-rail" aria-label="学习快捷入口">
            {resume && <section className="shelf-rail-card shelf-resume-card"><span>继续上次</span><strong>{PRACTICE_MODES[resume.mode].name}</strong><small>{resume.cursor} / {resume.total} 题已保存</small><button className="btn btn-primary" onClick={() => onResume(resume.id)}>继续训练</button></section>}
            {vocab && <section className="shelf-rail-card"><span>我的词汇</span><button className="shelf-vocab-link" onClick={() => onOpenDeck(vocab)}><strong>生词本</strong><b>{vocab.total.toLocaleString()} 词</b></button><dl><div><dt>待学习</dt><dd>{stats?.pending_learning ?? 0}</dd></div><div><dt>待复习</dt><dd>{stats?.due_now ?? 0}</dd></div></dl></section>}
            {(pinned.length > 0 || recent.length > 0) && <section className="shelf-rail-card"><span>最近与置顶</span><div className="shelf-shortcuts">{[...new Map([...pinned, ...recent].map((deck) => [deck.key, deck])).values()].slice(0, 6).map((deck) => <button key={deck.key} onClick={() => onOpenDeck(deck)}><strong>{deck.name}</strong><small>{deck.due_now ? `待复习 ${deck.due_now}` : `${deck.total.toLocaleString()} 词`}</small></button>)}</div></section>}
            {(overview.data?.weak_modes.length ?? 0) > 0 && <section className="shelf-rail-card"><span>近期薄弱项</span>{overview.data?.weak_modes.map((item) => <div className="shelf-weak" key={item.mode}><strong>{PRACTICE_MODES[item.mode].name}</strong><small>{item.count} 次需巩固</small></div>)}</section>}
            <button className="btn btn-soft shelf-report" onClick={onOpenReport}><IconChart />查看学习报告</button>
          </aside>
        </div>
        {planOpen && <PracticePlan onClose={() => setPlanOpen(false)} />}
      </div>
    </div>
  )
}
