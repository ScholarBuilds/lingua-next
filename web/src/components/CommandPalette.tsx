/* ⌘K 命令面板（CR-006 D6 · FR-507）：搜书、视频、查单词，跳页面，执行动作。

   遮罩、Esc、浮层栈走 components/Overlay（STD-UI-001），列表与键盘导航走 cmdk。
   「单词」组是服务端联想（中英皆可）：cmdk 内置过滤会按 value 把「放弃」查出来的 abandon
   再筛掉，所以整个面板 `shouldFilter={false}`，静态四组用 `filterPalette` 自己筛。
   书 / 视频两份列表复用各自页面的查询键，面板打开时才拉。 */

import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'

import { useOpenSettings } from '../features/settings/SettingsModal'
import { briefOf, isSuggestable } from '../features/vocab/dict/dictQuery'
import { tagLabel } from '../features/vocab/shared'
import { apiM5 } from '../lib/api-m5'
import { api } from '../lib/api'
import { apiVideo } from '../lib/api-video'
import { usePrefStore } from '../lib/prefStore'
import { useDebouncedValue } from '../lib/useDebouncedValue'
import { actionCommands, filterPalette, pageCommands } from './commandItems'
import { IconBook, IconVideo, IconVocab } from './icons'
import { Overlay } from './Overlay'

const SUGGEST_LIMIT = 8
const SUGGEST_DEBOUNCE_MS = 150

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  // 关着的时候不挂任何东西：列表查询只在打开时才发起
  return open ? <PaletteBody onClose={onClose} /> : null
}

function dictRoute(search: string, word?: string): string {
  const q = `/dict?q=${encodeURIComponent(search)}`
  return word === undefined ? q : `${q}&w=${encodeURIComponent(word)}`
}

const STAGE_LABEL: Record<string, string> = {
  learning: '学习中',
  tested: '短期会了',
  mastered: '已掌握',
  hard: '困难词',
}

function PaletteBody({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const openSettings = useOpenSettings()
  const books = useQuery({ queryKey: ['books'], queryFn: apiM5.books })
  const videos = useQuery({ queryKey: ['videos'], queryFn: apiVideo.videos })

  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState('')
  // 中文输入法组合期间不喂防抖：拼音中间态会打成一串英文联想闪一下
  const composing = useRef(false)
  const [settled, setSettled] = useState('')
  const debounced = useDebouncedValue(settled, SUGGEST_DEBOUNCE_MS)
  const query = debounced.trim()
  const suggestable = isSuggestable(query)
  const suggest = useQuery({
    queryKey: ['dict-suggest', query],
    queryFn: () => api.dictSuggest(query, SUGGEST_LIMIT),
    enabled: suggestable,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  })
  // 渲染门自己判：enabled=false 时旧键的数据还挂着，删到一个字母时联想不能残留
  const showWords = suggestable && isSuggestable(search)
  const words = showWords && suggest.data?.ready === true ? suggest.data.items : []
  const notReady = showWords && suggest.data !== undefined && suggest.data.ready === false

  /* 联想是异步到的，cmdk 只在搜索变化那一刻选首项——那时首项还是静态条目。
     用户没按过方向键的话，联想到了就把高亮挪到第一个词上 */
  const userNav = useRef(false)
  useEffect(() => {
    userNav.current = false
  }, [search])
  useEffect(() => {
    // 已经停在某个词上就不动；停在尾行「在查词页搜索」上的要挪到第一个词
    if (words.length === 0 || userNav.current || /^dict:\d+:/.test(selected)) return
    setSelected(`dict:0:${words[0].lc}`)
  }, [words, selected])

  const go = (run: () => void) => {
    onClose()
    run()
  }
  const ctx = {
    navigate: (to: string) => navigate(to),
    openSettings: (section?: string) => openSettings(section),
    toggleTheme: () => {
      const dark = document.documentElement.getAttribute('data-theme') === 'dark'
      usePrefStore.getState().update({ theme: dark ? 'light' : 'dark' })
    },
    toggleNav: () => {
      const collapsed = usePrefStore.getState().prefs.ui.navCollapsed
      usePrefStore.getState().update({ ui: { navCollapsed: !collapsed } })
    },
  }
  const pages = filterPalette(pageCommands(ctx), search)
  const actions = filterPalette(actionCommands(ctx), search)
  const bookRows = filterPalette(
    (books.data ?? []).map((b) => ({ ...b, label: b.title, keywords: b.author ?? '' })),
    search,
  )
  const videoRows = filterPalette(
    (videos.data ?? []).map((v) => ({
      ...v,
      label: v.title,
      keywords: `${v.title_zh ?? ''} ${v.channel ?? ''}`,
    })),
    search,
  )

  return (
    <Overlay onClose={onClose} card="cmdk-card" labelledBy="cmdk-title">
      <h2 id="cmdk-title" className="sr-only">搜索与命令</h2>
      <Command loop shouldFilter={false} value={selected} onValueChange={setSelected}>
        <CommandInput
          placeholder="搜书、视频、查单词，或输入命令"
          autoFocus
          value={search}
          onValueChange={(v) => {
            setSearch(v)
            if (!composing.current) setSettled(v)
          }}
          onCompositionStart={() => {
            composing.current = true
          }}
          onCompositionEnd={(e) => {
            composing.current = false
            setSettled(e.currentTarget.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') userNav.current = true
          }}
        />
        <CommandList>
          <CommandEmpty>没有匹配的内容</CommandEmpty>
          {showWords && (
            <CommandGroup heading={suggest.isLoading ? '单词 …' : '单词'}>
              {words.map((w, i) => (
                <CommandItem
                  key={`dict:${i}:${w.lc}`}
                  value={`dict:${i}:${w.lc}`}
                  onSelect={() => go(() => navigate(dictRoute(search.trim(), w.word)))}
                >
                  <IconVocab />
                  <span className="cmdk-word">{w.word}</span>
                  {w.phonetic !== null && <span className="cmdk-phon">/{w.phonetic}/</span>}
                  <span className="cmdk-brief">{briefOf(w)}</span>
                  <span className="cmdk-hint">
                    {w.tags[0] !== undefined && <span className="chip">{tagLabel(w.tags[0])}</span>}
                    {(STAGE_LABEL[w.stage] ?? (w.in_vocab ? '已收藏' : '')) || ''}
                  </span>
                </CommandItem>
              ))}
              {notReady ? (
                <CommandItem value="dict:notready" disabled>
                  <IconVocab />
                  查词索引未建，只能整词精确查
                </CommandItem>
              ) : (
                <CommandItem
                  value="dict:all"
                  onSelect={() => go(() => navigate(dictRoute(search.trim())))}
                >
                  <IconVocab />
                  在查词页搜索「{search.trim()}」
                  <span className="cmdk-hint">
                    {words.length >= SUGGEST_LIMIT ? '更多结果 ↵' : '全部结果 ↵'}
                  </span>
                </CommandItem>
              )}
            </CommandGroup>
          )}
          {pages.length > 0 && (
            <CommandGroup heading="页面">
              {pages.map((c) => (
                <CommandItem key={c.id} value={c.id} onSelect={() => go(c.run)}>
                  {c.label}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {actions.length > 0 && (
            <CommandGroup heading="命令">
              {actions.map((c) => (
                <CommandItem key={c.id} value={c.id} onSelect={() => go(c.run)}>
                  {c.label}
                  {c.hint !== undefined && <span className="cmdk-hint">{c.hint}</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {bookRows.length > 0 && (
            <CommandGroup heading="书">
              {bookRows.map((b) => (
                <CommandItem
                  key={`book:${b.id}`}
                  value={`book:${b.id}`}
                  onSelect={() => go(() => navigate(b.last_article_id !== null ? `/read/${b.last_article_id}` : '/read'))}
                >
                  <IconBook />
                  {b.title}
                  <span className="cmdk-hint">{b.author ?? '书'}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {videoRows.length > 0 && (
            <CommandGroup heading="视频">
              {videoRows.map((v) => (
                <CommandItem
                  key={`video:${v.id}`}
                  value={`video:${v.id}`}
                  onSelect={() => go(() => navigate(v.status === 'ready' || v.status === 'degraded' ? `/video/${v.id}` : '/video'))}
                >
                  <IconVideo />
                  {v.title}
                  <span className="cmdk-hint">{v.channel ?? '视频'}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
        <div className="cmdk-foot"><span>↑↓ 选择</span><span>↵ 打开</span><span>Esc 关闭</span></div>
      </Command>
    </Overlay>
  )
}
