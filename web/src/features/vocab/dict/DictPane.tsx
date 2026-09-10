/* 查词页（FR-507~511）：左结果列表，右内嵌词卡。

   可见状态全在 URL（BR-G-011）：`q` 是输入、`w` 是右栏正在看的词；store 只记「上次查的」
   与「最近查过」（STD-UI-007）。↑↓ 只动高亮不换卡——每换一次卡要发词典 / 收藏状态 /
   拆开记三个请求，Enter 才提交。 */

import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'

import { IconSearch } from '../../../components/icons'
import { useOverlayOpen } from '../../../components/Overlay'
import { FORM_FOCUS_SELECTOR } from '@/components/ui/picker'
import { api } from '../../../lib/api'
import type { DictSearchNotReady, DictSearchReady, DictSearchResponse } from '../../../lib/api'
import { playTts } from '../../../lib/audio'
import { usePrefStore } from '../../../lib/prefStore'
import { useUrlParams } from '../../../lib/urlState'
import { useDebouncedValue } from '../../../lib/useDebouncedValue'
import { WordCard } from '../../reader/WordCard'
import type { WordSelection } from '../../reader/readerStore'
import { useWordModalStore } from '../../reader/wordModalStore'
import { DictResults, RecentList } from './DictResults'
import { briefOf, flattenRows, groupSearch, isSuggestable, nuanceWord, primaryWord } from './dictQuery'
import { useDictStore } from './dictStore'
import './dict.css'

const DEBOUNCE_MS = 120
/** 收藏出处：用户自己输入的词，没有文章 / 视频语境 */
const SOURCE = { kind: 'manual' as const, label: '查词' }

function isReady(data: DictSearchResponse | undefined): data is DictSearchReady {
  return data !== undefined && data.ready
}

function isNotReady(data: DictSearchResponse | undefined): data is DictSearchNotReady {
  return data !== undefined && !data.ready
}

function contextOf(word: string): string {
  return `查词：${word}`
}

export function DictPane() {
  const [params, patchParams] = useUrlParams()
  const urlQ = params.get('q') ?? ''
  const urlW = params.get('w') ?? ''
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const [keyword, setKeyword] = useState(urlQ)
  const [composing, setComposing] = useState(false)
  const debounced = useDebouncedValue(keyword, DEBOUNCE_MS)
  /* 上一次与 URL 对齐的关键词：URL 被 ⌘K 改了要同步进输入框，输入框停手了要写回 URL，
     两个方向靠它分辨，免得防抖里的旧值把新 URL 又改回去 */
  const synced = useRef(urlQ)
  useEffect(() => {
    if (urlQ !== synced.current) {
      synced.current = urlQ
      setKeyword(urlQ)
    }
  }, [urlQ])
  useEffect(() => {
    if (composing || debounced !== keyword) return
    const next = debounced.trim()
    if (next === synced.current) return
    synced.current = next
    patchParams({ q: next || null, w: null })
  }, [debounced, keyword, patchParams, composing])

  // 常驻状态：首次挂载且 URL 空时回到上次查的词；之后每次变化写回
  const restored = useRef(false)
  const setLookup = useDictStore((s) => s.setLookup)
  useEffect(() => {
    if (restored.current) return
    restored.current = true
    const { query, word } = useDictStore.getState()
    if (urlQ === '' && query !== '') {
      synced.current = query
      setKeyword(query)
      patchParams({ q: query, w: word || null })
    }
    // 只在首次挂载做一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    setLookup(urlQ, urlW)
  }, [urlQ, urlW, setLookup])

  const search = useQuery({
    queryKey: ['dict-search', urlQ],
    queryFn: ({ signal }) => api.dictSearch(urlQ, signal),
    enabled: isSuggestable(urlQ),
    staleTime: 5 * 60_000,
  })
  const waitingForInput = composing || keyword.trim() !== urlQ
  const data = waitingForInput ? undefined : search.data
  const ready = isReady(data) ? data : null
  const sections = useMemo(() => (ready === null ? [] : groupSearch(ready)), [ready])
  const rows = useMemo(() => flattenRows(sections), [sections])
  const showResults = isSuggestable(urlQ)

  // 结果到了：没选词就选精确命中；选着的词不在结果里就清掉。两种修正合成一次 patch
  useEffect(() => {
    if (ready === null || ready.q !== urlQ) return
    const first = primaryWord(ready)
    if (urlW === '' && first !== null) patchParams({ w: first })
    else if (urlW !== '' && !rows.some((r) => r.entry.word === urlW)) patchParams({ w: null })
  }, [ready, rows, urlQ, urlW, patchParams])

  const remember = useDictStore((s) => s.remember)
  useEffect(() => {
    if (urlW === '') return
    const hit = rows.find((r) => r.entry.word === urlW)
    if (hit !== undefined) remember(urlW, briefOf(hit.entry))
  }, [urlW, rows, remember])

  const [activeIndex, setActiveIndex] = useState(-1)
  useEffect(() => {
    setActiveIndex(rows.findIndex((r) => r.entry.word === urlW))
  }, [rows, urlW])
  useEffect(() => {
    if (activeIndex < 0) return
    listRef.current
      ?.querySelector(`#dq-opt-${activeIndex}`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'auto' })
  }, [activeIndex])

  const autoplay = usePrefStore((s) => s.prefs.vocab.autoplay)
  const openWord = useWordModalStore((s) => s.openWord)
  const select = (word: string) => {
    if (word !== urlW) patchParams({ w: word })
    if (autoplay) playTts(word, 'word')
  }
  const openCard = (word: string) => openWord(word, contextOf(word), undefined, SOURCE)
  const lookup = (word: string) => {
    synced.current = word
    setKeyword(word)
    patchParams({ q: word, w: null })
  }

  const overlayOpen = useOverlayOpen()
  const modalOpen = useWordModalStore((s) => s.stack.length > 0)
  useHotkeys(
    'slash',
    (e) => {
      e.preventDefault()
      inputRef.current?.focus()
    },
    {
      enabled: !overlayOpen && !modalOpen,
      ignoreEventWhen: (e) => e.target instanceof Element && e.target.closest(FORM_FOCUS_SELECTOR) !== null,
    },
    [overlayOpen, modalOpen],
  )

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (rows.length === 0) return
      e.preventDefault()
      const delta = e.key === 'ArrowDown' ? 1 : -1
      setActiveIndex((i) => Math.min(rows.length - 1, Math.max(0, i + delta)))
    } else if (e.key === 'Enter') {
      if (waitingForInput) {
        e.preventDefault()
        lookup(keyword.trim())
        return
      }
      const row = rows[activeIndex] ?? rows[0]
      if (row !== undefined) {
        e.preventDefault()
        if (e.metaKey || e.ctrlKey) openCard(row.entry.word)
        else select(row.entry.word)
      }
    } else if (e.key === 'Escape') {
      // 两段式（STD-UI-002b）：有字先清字，再失焦
      if (keyword !== '') setKeyword('')
      else inputRef.current?.blur()
    }
  }

  const sel = useMemo<WordSelection | null>(
    () =>
      urlW === ''
        ? null
        : {
            word: urlW.toLowerCase(),
            surface: urlW,
            paragraphId: -1,
            start: 0,
            end: 0,
            sentenceId: null,
            sentenceHash: null,
            sentenceText: contextOf(urlW),
          },
    [urlW],
  )

  const recent = useDictStore((s) => s.recent)
  const clearRecent = useDictStore((s) => s.clearRecent)
  const notReady = isNotReady(data) ? data : null

  return (
    <div className="dq">
      <div className="dq-head">
        <label className="dq-search">
          <IconSearch />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded={rows.length > 0}
            aria-controls="dq-list"
            aria-activedescendant={activeIndex >= 0 ? `dq-opt-${activeIndex}` : undefined}
            aria-autocomplete="list"
            placeholder="输入英文或中文：went、放弃、ab*don"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onKeyDown={onKeyDown}
            autoFocus
          />
          <kbd>/</kbd>
        </label>
        {ready !== null && (
          <span className="dq-source">
            {ready.source.dict}
            {ready.source.related !== null && ` · ${ready.source.related}`}
          </span>
        )}
      </div>
      <div className="dq-body">
        <div
          id="dq-list"
          ref={listRef}
          role="listbox"
          className="dq-list"
          aria-busy={waitingForInput || search.isFetching}
        >
          {waitingForInput && keyword.trim() ? (
            <div className="dq-state" role="status">正在查询…</div>
          ) : !showResults ? (
            <RecentList recent={recent} onPick={lookup} onClear={clearRecent} />
          ) : notReady !== null ? (
            <div className="dq-state">
              查词索引还没建，现在只能整词精确查。
              <br />
              <code>{notReady.hint}</code>
            </div>
          ) : search.isError ? (
            <div className="dq-state">
              <span className="panel-error">查询失败：{search.error.message}</span>{' '}
              <button className="btn-ghost-sm" onClick={() => void search.refetch()}>
                重试
              </button>
            </div>
          ) : search.isLoading ? (
            <div className="dq-skeleton">
              <div className="skeleton skeleton-line" style={{ width: '40%' }} />
              <div className="skeleton skeleton-line" style={{ width: '70%' }} />
              <div className="skeleton skeleton-line" style={{ width: '55%' }} />
            </div>
          ) : ready !== null && rows.length === 0 && sections.length === 0 ? (
            <div className="dq-state">没有找到「{urlQ}」</div>
          ) : ready !== null ? (
            <DictResults
              sections={sections}
              kind={ready.kind}
              query={urlQ}
              activeIndex={activeIndex}
              selectedWord={urlW}
              nuanceWord={nuanceWord(ready)}
              onSelect={select}
              onOpen={openCard}
              onSuggest={lookup}
            />
          ) : null}
        </div>
        <div className="dq-card">
          {sel === null ? (
            <div className="dq-card-empty">选一个词看词卡</div>
          ) : (
            <WordCard
              key={`w:${urlW}`}
              sel={sel}
              source={SOURCE}
              onClose={() => patchParams({ w: null })}
              clickable="force"
            />
          )}
        </div>
      </div>
    </div>
  )
}
