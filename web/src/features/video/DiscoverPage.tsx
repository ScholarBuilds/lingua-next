import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useUrlValue } from '@/lib/urlState'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PillPicker } from '@/components/ui/picker'

import { IconClose, IconPlus, IconSparkle } from '../../components/icons'
import { apiVideo } from '../../lib/api-video'
import type { FeedItemDetail, FeedItemV1, SubscriptionV1 } from '../../lib/api-video'
import { Stars } from './VideoCard'
import { formatClock, formatRelative } from './videoUtils'
import { VIconPlaySolid, VIconRefresh } from './icons'

/** 时长档：与视频库筛选同口径 */
const DURATIONS = [
  { key: 'all', label: '全部', min: undefined, max: undefined },
  { key: 's', label: '<5 分钟', min: undefined, max: 300 },
  { key: 'm', label: '5-15 分钟', min: 300, max: 900 },
  { key: 'l', label: '>15 分钟', min: 900, max: undefined },
] as const

/** 队列非空才轮询，处理完自动停 */
const QUEUE_POLL_MS = 3000

/** 语速档：英语对话均速约 150 wpm（Tauroza & Allison 1990） */
function paceLabel(wpm: number | null): string | null {
  if (wpm === null || wpm <= 0) return null
  const tag = wpm >= 180 ? '偏快' : wpm <= 110 ? '偏慢' : '适中'
  return `${Math.round(wpm)} wpm · ${tag}`
}

export function DiscoverPage() {
  const qc = useQueryClient()
  const [sub, setSub] = useUrlValue<string>('subscription', '')
  const subId = sub ? Number(sub) : null
  const setSubId = (id: number | null) => setSub(id === null ? '' : String(id))
  const [dur, setDur] = useUrlValue<(typeof DURATIONS)[number]['key']>('duration', 'all', ['all', 's', 'm', 'l'])
  const [keyword, setKeyword] = useUrlValue<string>('q', '')
  const [ignoredValue, setIgnoredValue] = useUrlValue<string>('ignored', '')
  const showIgnored = ignoredValue === '1'
  const [captionValue, setCaptionValue] = useUrlValue<string>('captions', 'all')
  const onlyCaptioned = captionValue === 'english'
  const [feedStatus, setFeedStatus] = useUrlValue<string>('feedStatus', 'pending', ['pending', 'saved', 'ignored', 'all'])
  const [view, setView] = useUrlValue<string>('feedView', 'cards', ['cards', 'list'])
  const [unknown, setUnknown] = useUrlValue<string>('unknown', '')
  const [addOpen, setAddOpen] = useState(false)
  const [addUrl, setAddUrl] = useState('')
  const [preview, setPreview] = useState<FeedItemV1 | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())

  const subsQuery = useQuery({
    queryKey: ['subscriptions'],
    queryFn: () => apiVideo.subscriptions(),
  })
  const recQuery = useQuery({
    queryKey: ['recommended-channels'],
    queryFn: () => apiVideo.recommendedChannels(),
    enabled: addOpen,
  })

  const durRange = useMemo(() => DURATIONS.find((d) => d.key === dur)!, [dur])
  const feedQuery = useInfiniteQuery({
    queryKey: ['feed', subId, dur, keyword, showIgnored, onlyCaptioned, feedStatus, unknown],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) =>
      apiVideo.feedPage({
        ...(subId !== null ? { subscription_id: subId } : {}),
        ...(durRange.min !== undefined ? { min_duration: durRange.min } : {}),
        ...(durRange.max !== undefined ? { max_duration: durRange.max } : {}),
        ...(keyword.trim() ? { q: keyword.trim() } : {}),
        include_ignored: showIgnored,
        only_captioned: onlyCaptioned,
        include_unknown: unknown === '1',
        status: feedStatus,
      }, pageParam),
    getNextPageParam: (page) => page.next_cursor,
  })

  const queueQuery = useQuery({
    queryKey: ['feed-queue'],
    queryFn: () => apiVideo.feedQueue(),
    refetchInterval: (q) => ((q.state.data?.length ?? 0) > 0 ? QUEUE_POLL_MS : false),
  })
  const queue = queueQuery.data ?? []
  const queueLen = queue.length
  // 队列清空 = 有视频加工完成，顺带刷新候选与视频库
  const prevQueueLen = useRef(queueLen)
  useEffect(() => {
    if (prevQueueLen.current > 0 && queueLen === 0) {
      void qc.invalidateQueries({ queryKey: ['feed'] })
      void qc.invalidateQueries({ queryKey: ['videos'] })
    }
    prevQueueLen.current = queueLen
  }, [queueLen, qc])

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['feed'] })
    void qc.invalidateQueries({ queryKey: ['subscriptions'] })
  }
  const invalidateWithQueue = () => {
    invalidate()
    void qc.invalidateQueries({ queryKey: ['feed-queue'] })
  }

  const subscribe = useMutation({
    mutationFn: (url: string) => apiVideo.subscribe(url),
    onSuccess: (d) => {
      toast.success(`已订阅《${d.title}》，正在拉取列表`)
      setAddUrl('')
      setAddOpen(false)
      invalidate()
      void qc.invalidateQueries({ queryKey: ['recommended-channels'] })
    },
    onError: (e: Error) => toast.error(e.message || '订阅失败'),
  })

  const refresh = useMutation({
    mutationFn: async () => {
      await apiVideo.refreshSubscriptions(subId ?? undefined)
      // 轮询是异步任务；这里再补一次元数据回填，让已在库的候选立刻拿到时长与字幕标志
      return apiVideo.refreshFeedMeta(subId ?? undefined)
    },
    onSuccess: (d) => {
      if (d.error) { toast.error(`列表更新已请求，但元数据更新失败：${d.error}`); invalidate(); return }
      toast.success(
        d.filled > 0 ? `已触发轮询，补齐 ${d.filled} 条元数据` : '已触发轮询，稍后刷新查看新片',
      )
      invalidate()
    },
    onError: (e: Error) => toast.error(`更新未完成：${e.message}`),
  })

  const unsubscribe = useMutation({
    mutationFn: (id: number) => apiVideo.unsubscribe(id),
    onSuccess: () => {
      toast.success('已取消订阅')
      setSubId(null)
      invalidate()
      void qc.invalidateQueries({ queryKey: ['recommended-channels'] })
    },
  })

  const importItem = useMutation({
    mutationFn: (item: FeedItemV1) => apiVideo.collectOnline(item.watch_url, item.title),
    onSuccess: () => {
      toast.success('已收藏在线引用，不会下载视频')
      setPreview(null)
      invalidateWithQueue()
    },
    onError: (e: Error) => toast.error(e.message || '入库失败'),
  })

  const importBatch = useMutation({
    mutationFn: async (ids: number[]) => {
      const chosen = items.filter(i => ids.includes(i.id))
      const results = await Promise.allSettled(chosen.map(i => apiVideo.collectOnline(i.watch_url, i.title)))
      return { queued: results.filter(r => r.status === 'fulfilled'), failedIds: chosen.filter((_, index) => results[index].status === 'rejected').map(i => i.id) }
    },
    onSuccess: (d) => {
      const skipped = d.failedIds.length > 0 ? `，${d.failedIds.length} 条失败，已保留选择可重试` : ''
      toast.message(`已收藏 ${d.queued.length} 条${skipped}`)
      setSelected(new Set(d.failedIds))
      invalidateWithQueue()
    },
    onError: (e: Error) => toast.error(e.message || '批量入库失败'),
  })

  const cancelImport = useMutation({
    mutationFn: (videoId: number) => apiVideo.cancelImport(videoId),
    onSuccess: () => {
      toast.success('已取消，候选恢复为待入库')
      invalidateWithQueue()
    },
    onError: (e: Error) => toast.error(e.message || '取消失败'),
  })

  const ignore = useMutation({
    mutationFn: ({ id, on }: { id: number; on: boolean }) => apiVideo.ignoreFeedItem(id, on),
    onSuccess: (_, variables) => {
      invalidate()
      if (variables.on) toast.message('已忽略', { action: { label: '撤销', onClick: () => ignore.mutate({ id: variables.id, on: false }) } })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const subs = subsQuery.data ?? []
  const items = feedQuery.data?.pages.flatMap(page => page.items) ?? []
  const totalPending = subs.reduce((n, s) => n + s.pending, 0)
  const selectable = items.filter((i) => i.video_id === null && !i.ignored)

  const toggleSelect = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })

  return (
    <div className="vm-discover">
      <aside className="vm-subs">
        <div className="vm-subs-head">
          <span>订阅源</span>
          <div style={{ flex: 1 }} />
          <button
            className="icon-btn"
            title="立即检查更新（只拉列表，不下载）"
            disabled={refresh.isPending}
            onClick={() => refresh.mutate()}
          >
            <VIconRefresh />
          </button>
          <button className="icon-btn" title="添加订阅" onClick={() => setAddOpen(true)}>
            <IconPlus />
          </button>
        </div>

        <button
          className={`vm-sub-item${subId === null ? ' active' : ''}`}
          onClick={() => setSubId(null)}
        >
          <span className="vm-sub-title">全部订阅</span>
          {totalPending > 0 && <span className="vm-sub-badge">{totalPending}</span>}
        </button>

        {subs.map((s) => (
          <SubRow
            key={s.id}
            sub={s}
            active={subId === s.id}
            onSelect={() => setSubId(s.id)}
            onRemove={() => unsubscribe.mutate(s.id)}
          />
        ))}

        {subs.length === 0 && !subsQuery.isPending && (
          <div className="vm-subs-empty">
            还没有订阅
            <button className="btn btn-primary btn-sm" onClick={() => setAddOpen(true)}>
              添加频道
            </button>
          </div>
        )}

        {queue.length > 0 && (
          <div className="vm-queue">
            <div className="vm-queue-head">处理队列 · {queue.length}</div>
            {queue.map((job) => (
              <div key={job.video_id} className="vm-queue-row">
                <div className="vm-queue-main">
                  <div className="vm-queue-title" title={job.title}>
                    {job.title}
                  </div>
                  {job.error !== null ? (
                    <div className="vm-queue-err">失败：{job.error.slice(0, 48)}</div>
                  ) : (
                    <div className="vm-queue-meta">
                      <span>{job.status}</span>
                      <span className="vm-queue-bar">
                        <i style={{ width: `${Math.min(100, job.progress)}%` }} />
                      </span>
                    </div>
                  )}
                </div>
                <button
                  className="icon-btn"
                  title="取消并从库中移除"
                  disabled={cancelImport.isPending}
                  onClick={() => cancelImport.mutate(job.video_id)}
                >
                  <IconClose />
                </button>
              </div>
            ))}
          </div>
        )}
      </aside>

      <section className="vm-feed">
        <div className="vm-feed-bar">
          <PillPicker label="状态" value={feedStatus} onChange={setFeedStatus} options={[
            { value: 'pending', label: '待看' }, { value: 'saved', label: '已收藏' },
            { value: 'ignored', label: '已忽略' }, { value: 'all', label: '全部' },
          ]} />
          <PillPicker label="视图" value={view} onChange={setView} options={[
            { value: 'cards', label: '卡片' }, { value: 'list', label: '列表' },
          ]} />
          <div className="seg">
            {DURATIONS.map((d) => (
              <button
                key={d.key}
                className={dur === d.key ? 'active' : ''}
                onClick={() => setDur(d.key)}
              >
                {d.label}
              </button>
            ))}
          </div>
          <input
            className="input vm-feed-search"
            placeholder="按标题筛选"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <button
            className={`vm-fchip${onlyCaptioned ? ' active' : ''}`}
            title="仅显示已确认有英文字幕的视频，不自动转写或下载"
            onClick={() => setCaptionValue(onlyCaptioned ? 'all' : 'english')}
          >
            仅有英文字幕
          </button>
          {onlyCaptioned && <label><input type="checkbox" checked={unknown === '1'} onChange={e => setUnknown(e.target.checked ? '1' : '')} />包含待检测</label>}
          <button
            className={`vm-fchip${showIgnored ? ' active' : ''}`}
            onClick={() => setIgnoredValue(showIgnored ? '' : '1')}
          >
            {showIgnored ? '含已忽略' : '隐藏已忽略'}
          </button>
          <div style={{ flex: 1 }} />
          {selectable.length > 0 && (
            <button
              className="btn-ghost-sm"
              onClick={() =>
                setSelected(
                  selected.size === selectable.length
                    ? new Set()
                    : new Set(selectable.map((i) => i.id)),
                )
              }
            >
              {selected.size === selectable.length ? '取消选择' : '选择已加载项'}
            </button>
          )}
          <span className="vm-count">已显示 {items.length} / {feedQuery.data?.pages[0]?.total ?? 0}</span>
        </div>

        {feedQuery.isPending && <div className="panel-hint">载入中…</div>}
        {!feedQuery.isPending && items.length === 0 && (
          <div className="panel-empty">
            <IconSparkle />
            <div>
              {subs.length === 0
                ? '订阅频道后，新视频会出现在这里'
                : onlyCaptioned
                  ? '没有已确认英文字幕的候选，切换全部可查看待检测的视频'
                  : '暂无待看视频，点右上刷新检查更新'}
            </div>
          </div>
        )}

        <div className={`vm-grid${view === 'list' ? ' vm-feed-list' : ''}`}>
          {items.map((item) => (
            <FeedCard
              key={item.id}
              item={item}
              checked={selected.has(item.id)}
              onToggle={() => toggleSelect(item.id)}
              onPreview={() => setPreview(item)}
              onImport={() => importItem.mutate(item)}
              onIgnore={() => ignore.mutate({ id: item.id, on: !item.ignored })}
              importing={importItem.isPending && importItem.variables?.id === item.id}
            />
          ))}
        </div>
        {feedQuery.isError && <p role="alert">加载失败：{feedQuery.error.message}<button onClick={() => void feedQuery.refetch()}>重试</button></p>}
        {feedQuery.hasNextPage && <button className="btn btn-outline" disabled={feedQuery.isFetchingNextPage} onClick={() => void feedQuery.fetchNextPage()}>{feedQuery.isFetchingNextPage ? '加载中…' : '继续加载 30 条'}</button>}
      </section>

      {/* 批量操作条：选中即浮出（FR-61） */}
      {selected.size > 0 && (
        <div className="vm-batchbar">
          <span>已选 {selected.size} 条</span>
          <div style={{ flex: 1 }} />
          <button className="btn-ghost-sm" onClick={() => setSelected(new Set())}>
            取消选择
          </button>
          <button
            className="btn btn-primary btn-sm"
            disabled={importBatch.isPending}
            onClick={() => importBatch.mutate([...selected])}
          >
            {importBatch.isPending ? '入队中…' : `批量入库 ${selected.size} 条`}
          </button>
        </div>
      )}

      {/* 添加订阅：粘贴链接或从内置推荐一键订阅 */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="w-[560px] max-w-[92vw]">
          <DialogHeader>
            <DialogTitle>添加订阅</DialogTitle>
          </DialogHeader>
          <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
            <input
              className="input"
              style={{ flex: 1 }}
              placeholder="频道 / @handle / 播放列表链接"
              value={addUrl}
              onChange={(e) => setAddUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && addUrl.trim()) subscribe.mutate(addUrl.trim())
              }}
            />
            <button
              className="btn btn-primary"
              disabled={addUrl.trim() === '' || subscribe.isPending}
              onClick={() => subscribe.mutate(addUrl.trim())}
            >
              {subscribe.isPending ? '解析中…' : '订阅'}
            </button>
          </div>
          <div className="wc-label" style={{ marginBottom: 8 }}>
            推荐频道
          </div>
          <div className="vm-rec-list">
            {(recQuery.data ?? []).map((c) => (
              <div key={c.handle} className="vm-rec">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b>{c.title}</b>
                  <div className="vm-rec-note">{c.note}</div>
                </div>
                <button
                  className="btn btn-sm"
                  disabled={c.subscribed || subscribe.isPending}
                  onClick={() => subscribe.mutate(c.url)}
                >
                  {c.subscribed ? '已订阅' : '订阅'}
                </button>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <PreviewDialog
        item={preview}
        onClose={() => setPreview(null)}
        onImport={() => preview !== null && importItem.mutate(preview)}
        importing={importItem.isPending}
      />
    </div>
  )
}

/* ---- 预览弹窗（FR-63 重排版 + FR-53/55 片段播放） ---- */

function PreviewDialog({ item, onClose, onImport, importing }: {
  item: FeedItemV1 | null; onClose: () => void; onImport: () => void; importing: boolean
}) {
  const navigate = useNavigate()
  return <Dialog open={item !== null} onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent className="vm-pv">
      <DialogHeader><DialogTitle>{item?.title}</DialogTitle></DialogHeader>
      {item && <>
        <div className="vm-pv-stage"><iframe className="vm-pv-media" src={item.embed_url}
          title={item.title} allow="encrypted-media; picture-in-picture" allowFullScreen /></div>
        <p>在线预览不会下载视频。若播放受限，可在桌面内置 YouTube 查看；平台限制仍然适用。</p>
        <div className="vm-pv-foot">
          <button className="btn" onClick={() => { onClose(); navigate(`/video?tab=youtube&youtube=${encodeURIComponent(item.watch_url)}`) }}>内置 YouTube</button>
          <button className="btn btn-primary" disabled={importing || item.video_id !== null} onClick={onImport}>
            {item.video_id !== null ? '已收藏' : '收藏到学习库'}
          </button>
        </div>
      </>}
    </DialogContent>
  </Dialog>
}

function CaptionChip({ item }: { item: FeedItemV1 | FeedItemDetail }) {
  if (item.caption_kind === 'manual') return <span className="chip ok">人工英文字幕</span>
  if (item.caption_kind === 'auto') return <span className="chip">自动英文字幕</span>
  if (item.caption_kind === 'none') return <span className="chip warn">未发现英文字幕</span>
  // 尚未逐条探测：Data API 只给"有没有字幕"这一个布尔，语言明细要 yt-dlp 才知道
  if (item.has_captions === true) return <span className="chip">字幕语言待检测</span>
  if (item.has_captions === false) return <span className="chip warn">无字幕</span>
  return <span className="chip">字幕待检测</span>
}

function SubRow({
  sub,
  active,
  onSelect,
  onRemove,
}: {
  sub: SubscriptionV1
  active: boolean
  onSelect: () => void
  onRemove: () => void
}) {
  return (
    <div className={`vm-sub-item${active ? ' active' : ''}`} onClick={onSelect}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="vm-sub-title">{sub.title}</div>
        <div className="vm-sub-meta">
          已入库 {sub.imported}
          {sub.learned_videos > 0 && ` · 学过 ${sub.learned_videos}`}
          {sub.avg_difficulty !== null && ` · 难度 ${sub.avg_difficulty}`}
        </div>
        {sub.last_error !== null && <div className="vm-sub-err">{sub.last_error}</div>}
      </div>
      {sub.pending > 0 && <span className="vm-sub-badge">{sub.pending}</span>}
      <button
        className="icon-btn"
        title="取消订阅"
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
      >
        <IconClose />
      </button>
    </div>
  )
}

function FeedCard({
  item,
  checked,
  onToggle,
  onPreview,
  onImport,
  onIgnore,
  importing,
}: {
  item: FeedItemV1
  checked: boolean
  onToggle: () => void
  onPreview: () => void
  onImport: () => void
  onIgnore: () => void
  importing: boolean
}) {
  const selectable = item.video_id === null && !item.ignored
  const [thumbFailed, setThumbFailed] = useState(false)
  return (
    <div className={`card vm-vcard${item.ignored ? ' finished' : ''}${checked ? ' picked' : ''}`}>
      <div className="vm-cover" onClick={onPreview}>
        {item.thumb_url !== null && !thumbFailed ? <img src={item.thumb_url} alt="" loading="lazy" onError={() => setThumbFailed(true)} /> : <div className="vm-thumb-fallback">
          <span>缩略图暂不可用</span>{item.thumb_url && <button onClick={e => { e.stopPropagation(); setThumbFailed(false) }}>重试图片</button>}
        </div>}
        <div className="vm-play">
          <VIconPlaySolid />
        </div>
        {item.duration_s !== null && <span className="vm-dur">{formatClock(item.duration_s)}</span>}
        {item.video_id !== null && <span className="vm-vbadge">已在学习库</span>}
        {selectable && (
          <label className="vm-pick" onClick={(e) => e.stopPropagation()}>
            <input type="checkbox" checked={checked} onChange={onToggle} />
          </label>
        )}
      </div>
      <div className="vm-vbody">
        <div className="vm-vtitle" title={item.title}>
          {item.title}
        </div>
        <div className="vm-vmeta">
          <span className="vm-vsrc">{item.channel}</span>
          {item.published_at !== null && (
            <span className="vm-vsrc">
              · {formatRelative(new Date(item.published_at).getTime())}
            </span>
          )}
        </div>
        {/* Data API 批量回填后这行直接可见，不必逐条点详情（FR-58） */}
        <div className="vm-vchips">
          <CaptionChip item={item} />
          {item.difficulty !== null && (
            <span className="chip ghost">
              <Stars n={item.difficulty} />
            </span>
          )}
          {paceLabel(item.wpm) !== null && <span className="chip ghost">{paceLabel(item.wpm)}</span>}
        </div>
        <div className="vm-vfoot">
          <button className="btn-ghost-sm" onClick={onPreview}>
            预览
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn-ghost-sm" onClick={onIgnore}>
            {item.ignored ? '恢复' : '忽略'}
          </button>
          {item.video_id === null && (
            <button className="btn btn-sm" disabled={importing} onClick={onImport}>
              {importing ? '收藏中…' : '加入学习库'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
