/* 视频库页（对照 design/mockups/video-library.html）：继续学习横幅、五组筛选、
   排序、视频卡网格（六状态）、批量导入、处理中 3s 轮询、失败卡凭证引导。 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

import { IconAlert, IconChevronDown, IconPlay, IconPlus, IconSearch, IconVideo } from '../../components/icons'
import { Topbar } from '../../components/Topbar'
import { apiVideo, videoThumbUrl } from '../../lib/api-video'
import type { VideoCardV2 } from '../../lib/api-video'
import { DiscoverPage } from './DiscoverPage'
import { ImportDialog } from './ImportDialog'
import { ACCENT_LABELS, ProgressRing, VideoCard, coverGradient } from './VideoCard'
import { useUrlParams, useUrlSet, useUrlValue } from '../../lib/urlState'
import './video-m5.css'
import { isFinished, isStarted, readFavs, readLibIndex, removeLibEntry, toggleFav } from './videoStudyStore'
import type { LibEntry } from './videoStudyStore'
import { formatClock, formatRelative } from './videoUtils'

const BUSY = new Set(['pending', 'downloading', 'transcribing', 'translating'])

type DurSeg = 'all' | 'lt3' | '3-10' | '10-30' | 'gt30'
type StateSeg = 'all' | 'learning' | 'done' | 'fav'
type SortKey = 'latest' | 'recent' | 'difficulty' | 'duration' | 'progress'

const SORT_LABELS: Record<SortKey, string> = {
  latest: '最新导入',
  /* 半途而废的片子最难找回来：顶部「继续学习」只显示最近一条，
     同时开着三四个的时候，剩下那几条在「最新导入」里早被冲到后面去了 */
  recent: '最近学过',
  difficulty: '难度',
  duration: '时长',
  progress: '进度',
}

const SORT_KEYS: readonly SortKey[] = ['latest', 'recent', 'difficulty', 'duration', 'progress']

const DUR_KEYS: readonly DurSeg[] = ['all', 'lt3', '3-10', '10-30', 'gt30']
const STATE_KEYS: readonly StateSeg[] = ['all', 'learning', 'done', 'fav']

const DUR_SEGS: Array<{ key: DurSeg; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'lt3', label: '<3分' },
  { key: '3-10', label: '3-10' },
  { key: '10-30', label: '10-30' },
  { key: 'gt30', label: '>30' },
]

const STATE_SEGS: Array<{ key: StateSeg; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'learning', label: '学习中' },
  { key: 'done', label: '已学完' },
  { key: 'fav', label: '已收藏' },
]

function durMatch(seg: DurSeg, s: number | null): boolean {
  if (seg === 'all') return true
  if (s === null) return false
  const m = s / 60
  if (seg === 'lt3') return m < 3
  if (seg === '3-10') return m >= 3 && m < 10
  if (seg === '10-30') return m >= 10 && m < 30
  return m >= 30
}

function GridSkeleton() {
  return (
    <div className="vm-grid">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="card vm-vcard" style={{ cursor: 'default' }}>
          <div className="skeleton" style={{ aspectRatio: '16/10', borderRadius: 0 }} />
          <div className="vm-vbody">
            <div className="skeleton skeleton-line" style={{ width: '80%' }} />
            <div className="skeleton skeleton-line" style={{ width: '95%' }} />
            <div className="skeleton skeleton-line" style={{ width: '50%' }} />
          </div>
        </div>
      ))}
    </div>
  )
}

export function VideoLibraryPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const searchRef = useRef<HTMLInputElement>(null)

  const [, patchUrl] = useUrlParams()
  const [tab, setTab] = useUrlValue<'mine' | 'discover'>('tab', 'mine', ['mine', 'discover'])
  const [importOpen, setImportOpen] = useState(false)

  /* 发现页待看数：页签红点数据源，轮询只拉列表不下载（BR-16） */
  const subsQuery = useQuery({
    queryKey: ['subscriptions'],
    queryFn: () => apiVideo.subscriptions(),
    staleTime: 60_000,
  })
  const pendingCount = (subsQuery.data ?? []).reduce((n, s) => n + s.pending, 0)
  /* 筛选条件进 URL：刷新、前进后退、把某个筛选视图收藏成书签都能保住。
     以前只有 tab 进了 URL，筛半天一刷新全没了——而 useUrlValue 是现成的
     （词库页早就在用），不是要新造的能力。 */
  const [query, setQuery] = useUrlValue<string>('q', '')
  const [diffs, setDiffs] = useUrlSet<number>('diff', Number)
  const [accents, setAccents] = useUrlSet<string>('accent', String)
  const [topics, setTopics] = useUrlSet<string>('topic', String)
  const [topicsExpanded, setTopicsExpanded] = useState(false)
  const [durSeg, setDurSeg] = useUrlValue<DurSeg>('dur', 'all', DUR_KEYS)
  const [stateSeg, setStateSeg] = useUrlValue<StateSeg>('state', 'all', STATE_KEYS)
  const [sort, setSort] = useUrlValue<SortKey>('sort', 'latest', SORT_KEYS)
  const [favs, setFavs] = useState<Set<number>>(() => readFavs())
  const [deleting, setDeleting] = useState<VideoCardV2 | null>(null)
  const [errorLog, setErrorLog] = useState<VideoCardV2 | null>(null)

  const listQuery = useQuery({
    queryKey: ['videos'],
    queryFn: apiVideo.videos,
    // 处理中 / AI 加工中 3s 轮询，直到全部结束
    refetchInterval: (q) =>
      q.state.data?.some(
        (v) =>
          BUSY.has(v.status) ||
          (v.enrich_status !== null && v.enrich_status !== 'done' && v.enrich_status !== 'failed'),
      )
        ? 3000
        : false,
  })
  const videos = listQuery.data

  // 学习进度索引（进度环/横幅），随列表刷新重读
  const libIndex = useMemo<Record<string, LibEntry>>(() => readLibIndex(), [videos])

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['videos'] })

  const retry = useMutation({
    mutationFn: (id: number) => apiVideo.retry(id),
    onSuccess: invalidate,
    onError: (err) => toast.error(`重试失败：${err instanceof Error ? err.message : '未知错误'}`),
  })

  const enrich = useMutation({
    mutationFn: (id: number) => apiVideo.enrich(id),
    onSuccess: () => {
      toast.success('已重新入队 AI 加工')
      invalidate()
    },
    onError: (err) => toast.error(`加工请求失败：${err instanceof Error ? err.message : '未知错误'}`),
  })

  const del = useMutation({
    mutationFn: (id: number) => apiVideo.deleteVideo(id),
    onSuccess: (_, id) => {
      removeLibEntry(String(id))
      toast.success('已删除')
      invalidate()
    },
    onError: (err) => toast.error(`删除失败：${err instanceof Error ? err.message : '未知错误'}`),
  })

  /* ⌘K / Ctrl+K 聚焦搜索 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /* ---- 数据派生 ---- */

  const presentAccents = useMemo(() => {
    const set = new Set<string>()
    for (const v of videos ?? []) if (v.accent !== null) set.add(v.accent)
    return [...set]
  }, [videos])

  const presentTopics = useMemo(() => {
    const count = new Map<string, number>()
    for (const v of videos ?? [])
      for (const t of v.topics) count.set(t, (count.get(t) ?? 0) + 1)
    return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t)
  }, [videos])
  const shownTopics = topicsExpanded ? presentTopics : presentTopics.slice(0, 3)
  const hiddenTopicCount = presentTopics.length - shownTopics.length

  const hasFilter =
    query.trim() !== '' ||
    diffs.size > 0 ||
    accents.size > 0 ||
    topics.size > 0 ||
    durSeg !== 'all' ||
    stateSeg !== 'all'

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = (videos ?? []).filter((v) => {
      if (q !== '') {
        const hay = [v.title, v.title_zh, v.channel, v.summary_zh, ...v.topics]
          .filter((s): s is string => s !== null)
          .join('\n')
          .toLowerCase()
        if (!hay.includes(q)) return false
      }
      const busy = BUSY.has(v.status) || v.status === 'failed'
      if (busy) return stateSeg === 'all' // 处理中/失败卡只在"全部"下展示
      if (diffs.size > 0 && (v.difficulty === null || !diffs.has(v.difficulty))) return false
      if (accents.size > 0 && (v.accent === null || !accents.has(v.accent))) return false
      if (topics.size > 0 && !v.topics.some((t) => topics.has(t))) return false
      if (!durMatch(durSeg, v.duration_s)) return false
      const entry = libIndex[String(v.id)]
      const started = isStarted(entry)
      const done = isFinished(entry)
      if (stateSeg === 'learning' && (!started || done)) return false
      if (stateSeg === 'done' && !done) return false
      if (stateSeg === 'fav' && !favs.has(v.id)) return false
      return true
    })
    const entryOf = (v: VideoCardV2) => libIndex[String(v.id)]
    return list.sort((a, b) => {
      if (sort === 'difficulty') return (b.difficulty ?? 0) - (a.difficulty ?? 0)
      if (sort === 'duration') return (b.duration_s ?? 0) - (a.duration_s ?? 0)
      if (sort === 'progress') return (entryOf(b)?.pct ?? 0) - (entryOf(a)?.pct ?? 0)
      // 没学过的排最后，而不是当成「很久以前学的」混在中间
      if (sort === 'recent') return (entryOf(b)?.lastAt ?? 0) - (entryOf(a)?.lastAt ?? 0)
      return (b.created_at ?? '').localeCompare(a.created_at ?? '')
    })
  }, [videos, query, diffs, accents, topics, durSeg, stateSeg, favs, libIndex, sort])

  /* 继续学习横幅：最近学过且未学完的就绪视频 */
  const resume = useMemo(() => {
    if (videos === undefined) return null
    let best: { video: VideoCardV2; entry: LibEntry } | null = null
    for (const v of videos) {
      if (v.status !== 'ready') continue
      const entry = libIndex[String(v.id)]
      if (entry === undefined || entry.lastAt === 0) continue
      if (isFinished(entry)) continue
      if (!isStarted(entry)) continue
      if (best === null || entry.lastAt > best.entry.lastAt) best = { video: v, entry }
    }
    return best
  }, [videos, libIndex])

  const existingUrls = useMemo(() => {
    // 列表接口不带 source_url，导入侧仅做本批内去重 + 服务端查重兜底
    return new Set<string>()
  }, [])

  /* **一次 patch 清完**，不能连调六个 setter：setSearchParams 触发的是导航，
     同一事件里连调只有最后一次生效——实测「清除筛选」只清掉了 state，
     accent 与 diff 原样留在 URL 上。排序不算筛选，不清。 */
  const clearFilters = () => {
    patchUrl({ q: null, diff: null, accent: null, topic: null, dur: null, state: null })
  }

  const toggleSet = <T,>(set: Set<T>, v: T, apply: (s: Set<T>) => void) => {
    const next = new Set(set)
    if (next.has(v)) next.delete(v)
    else next.add(v)
    apply(next)
  }

  const goCredentials = () => navigate('/settings')
  const openVideo = (id: number) => navigate(`/video/${id}`)

  return (
    <div className="main">
      <Topbar
        title="视频"
        meta={videos !== undefined ? <span className="chip">{videos.length} 个视频</span> : undefined}
        actions={
          <>
            <div className="search vm-search">
              <IconSearch />
              <input
                ref={searchRef}
                type="text"
                placeholder="搜索标题、作者、摘要…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <kbd>⌘K</kbd>
            </div>
            <button className="btn btn-primary" onClick={() => setImportOpen(true)}>
              <IconPlus />
              批量导入
            </button>
          </>
        }
      />

      <div className="content">
        <div className="vm-lib-inner">
          {/* 我的库 / 发现 两页签：订阅新片在发现页，入库后进我的库 */}
          <div className="seg vm-lib-tabs">
            <button className={tab === 'mine' ? 'active' : ''} onClick={() => setTab('mine')}>
              我的库
            </button>
            <button className={tab === 'discover' ? 'active' : ''} onClick={() => setTab('discover')}>
              发现
              {pendingCount > 0 && <span className="vm-tab-dot">{pendingCount}</span>}
            </button>
          </div>
          {tab === 'discover' && <DiscoverPage />}
          {tab === 'mine' && (
          <>
          {/* 继续学习横幅 */}
          {resume !== null && (
            <div className="card vm-resume">
              <div
                className="vm-resume-thumb"
                style={{ background: coverGradient(resume.video.id) }}
              >
                {resume.video.thumb_url !== null && (
                  <img src={videoThumbUrl(resume.video.thumb_url)} alt="" />
                )}
                <IconPlay />
              </div>
              <div className="vm-resume-info">
                <b>{resume.video.title_zh ?? resume.video.title}</b>
                <span>
                  {resume.video.channel ?? '本地视频'} · 上次学到{' '}
                  {formatClock(resume.entry.lastPosS)} · {formatRelative(resume.entry.lastAt)}
                </span>
              </div>
              <ProgressRing pct={resume.entry.pct} />
              <button className="btn btn-primary" onClick={() => openVideo(resume.video.id)}>
                <IconPlay />
                回到 {formatClock(resume.entry.lastPosS)}
              </button>
            </div>
          )}

          {/* 筛选栏 */}
          {videos !== undefined && videos.length > 0 && (
            <div className="vm-filters">
              <span className="vm-flabel">难度</span>
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  className={`vm-fchip${diffs.has(n) ? ' active' : ''}`}
                  onClick={() => toggleSet(diffs, n, setDiffs)}
                >
                  <span className="st">★</span>
                  {n}
                </button>
              ))}
              {presentAccents.length > 0 && (
                <>
                  <i className="vm-fsep" />
                  <span className="vm-flabel">口音</span>
                  {presentAccents.map((a) => (
                    <button
                      key={a}
                      className={`vm-fchip${accents.has(a) ? ' active' : ''}`}
                      onClick={() => toggleSet(accents, a, setAccents)}
                    >
                      {ACCENT_LABELS[a] ?? a}
                    </button>
                  ))}
                </>
              )}
              {presentTopics.length > 0 && (
                <>
                  <i className="vm-fsep" />
                  <span className="vm-flabel">主题</span>
                  {shownTopics.map((t) => (
                    <button
                      key={t}
                      className={`vm-fchip${topics.has(t) ? ' active' : ''}`}
                      onClick={() => toggleSet(topics, t, setTopics)}
                    >
                      {t}
                    </button>
                  ))}
                  {hiddenTopicCount > 0 && (
                    <button className="vm-fchip" onClick={() => setTopicsExpanded(true)}>
                      +{hiddenTopicCount}
                    </button>
                  )}
                  {topicsExpanded && presentTopics.length > 3 && (
                    <button className="vm-fchip" onClick={() => setTopicsExpanded(false)}>
                      收起
                    </button>
                  )}
                </>
              )}
              <i className="vm-fsep" />
              <span className="vm-flabel">时长</span>
              <div className="seg">
                {DUR_SEGS.map((s) => (
                  <button
                    key={s.key}
                    className={durSeg === s.key ? 'active' : ''}
                    onClick={() => setDurSeg(s.key)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <i className="vm-fsep" />
              <div className="seg">
                {STATE_SEGS.map((s) => (
                  <button
                    key={s.key}
                    className={stateSeg === s.key ? 'active' : ''}
                    onClick={() => setStateSeg(s.key)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 工具行 */}
          {videos !== undefined && videos.length > 0 && (
            <div className="vm-toolbar">
              <span className="vm-count">
                {/* 筛剩几个要连总数一起说：只报「3 个视频」时，
                    用户分不清是自己筛太狠还是库里真就这么点 */}
                {hasFilter
                  ? `筛选结果 · ${filtered.length} / ${videos.length} 个视频`
                  : `${filtered.length} 个视频`}
              </span>
              {hasFilter && (
                <button className="btn-ghost-sm" onClick={clearFilters}>
                  清除筛选
                </button>
              )}
              <div style={{ flex: 1 }} />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="vm-sel">
                    排序 <b>{SORT_LABELS[sort]}</b>
                    <IconChevronDown />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
                    <DropdownMenuItem key={k} onSelect={() => setSort(k)}>
                      {SORT_LABELS[k]}
                      {sort === k && <span style={{ marginLeft: 'auto' }}>✓</span>}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}

          {/* 网格 */}
          {listQuery.isPending && <GridSkeleton />}

          {listQuery.isError && (
            <div className="state-block">
              <IconAlert />
              <div>视频库加载失败，请确认服务端已启动</div>
              <button className="btn btn-outline" onClick={() => void listQuery.refetch()}>
                重试
              </button>
            </div>
          )}

          {videos !== undefined && videos.length === 0 && (
            <div className="state-block">
              <IconVideo />
              <div>
                视频库空空如也
                <br />
                批量导入 YouTube 链接或上传本地视频开始学习
              </div>
              <button className="btn btn-primary" onClick={() => setImportOpen(true)}>
                <IconPlus />
                批量导入
              </button>
            </div>
          )}

          {videos !== undefined && videos.length > 0 && filtered.length === 0 && (
            <div className="state-block">
              <IconSearch />
              <div>没有符合筛选条件的视频</div>
              <button className="btn btn-outline" onClick={clearFilters}>
                清除筛选
              </button>
            </div>
          )}

          {filtered.length > 0 && (
            <div className="vm-grid">
              {filtered.map((v) => (
                <VideoCard
                  key={v.id}
                  video={v}
                  entry={libIndex[String(v.id)]}
                  faved={favs.has(v.id)}
                  isResume={resume?.video.id === v.id}
                  onOpen={() => openVideo(v.id)}
                  onToggleFav={() => setFavs(toggleFav(v.id))}
                  onRetry={() => retry.mutate(v.id)}
                  onDelete={() => setDeleting(v)}
                  onEnrich={() => enrich.mutate(v.id)}
                  onTrace={() => navigate(`/video/${v.id}/pipeline`)}
                  onGoCredentials={goCredentials}
                />
              ))}
            </div>
          )}
          </>
          )}
        </div>
      </div>

      {/* 批量导入 */}
      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        existingUrls={existingUrls}
        onImported={invalidate}
        onGoCredentials={() => {
          setImportOpen(false)
          goCredentials()
        }}
      />

      {/* 删除确认 */}
      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleting !== null && BUSY.has(deleting.status) ? '取消并删除该任务？' : '删除该视频？'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              「{deleting?.title_zh ?? deleting?.title}」的视频文件与全部字幕轨将被删除，学习进度一并清除，不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>再想想</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleting !== null) del.mutate(deleting.id)
                setDeleting(null)
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 失败日志 */}
      <AlertDialog open={errorLog !== null} onOpenChange={(o) => !o && setErrorLog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>失败原因</AlertDialogTitle>
            <AlertDialogDescription className="max-h-[40vh] overflow-y-auto whitespace-pre-wrap break-all text-left font-mono text-xs">
              {errorLog?.error ?? '无更多日志'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            {errorLog?.error_kind === 'bot_check' && (
              <AlertDialogAction
                onClick={() => {
                  setErrorLog(null)
                  goCredentials()
                }}
              >
                去配置凭证
              </AlertDialogAction>
            )}
            <AlertDialogCancel>关闭</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
