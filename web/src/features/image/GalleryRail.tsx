import { Picker } from '@/components/ui/picker'

/* 控制台右栏：资产画廊（模块 16 FR-421 / FR-438）。

   抄 InvokeAI 的 Gallery：结果流常驻侧边，随时点回来看，不用离开当前参数。
   三轮升级四件事：虚拟滚动 + 滚到底续拉、筛选扩到六个维度、多选批量操作、按批次分组。

   分组按 run_id 就近合并：列表本来就按 created_at 倒序，同一次任务出的图天然连在
   一起，走连续段分组既保住了时间顺序，也不会因为翻页边界把一批图拆成两组。
   没有 run_id 的是工作台自由出图，连续段归「单张」。

   类名前缀 glr-，独占；容器 .imgc-rail 的基础样式在 image.css。 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { MouseEvent } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

import type { AssetFilters, ImageApp, ImageAsset } from '@/lib/api-image'
import { apiImage } from '@/lib/api-image'

import './GalleryRail.css'
import { saveFile } from '@/lib/shell'

/** 服务端 `/images/assets` 的 limit 上限是 200，一页取 60 够铺满两列好几屏 */
const PAGE_SIZE = 60
const COLUMNS = 2
/** 行高写死：缩略图定高，不用 measureElement 反复量，滚动时不抖 */
const ROW_HEAD = 30
const ROW_CELLS = 74

/** 来源取值来自服务端的四个写入点（image_assets.ingest_one 的 source 参数） */
const SOURCES: { key: string; label: string }[] = [
  { key: 'pipeline', label: '管线出图' },
  { key: 'workbench', label: '工作台' },
  { key: 'edit', label: '改图' },
  { key: 'local', label: '本地修图' },
]

const NO_APPS: ImageApp[] = []

type Cell = { asset: ImageAsset; index: number }

type Row =
  | { kind: 'head'; key: string; label: string; time: string; count: number; ids: number[] }
  | { kind: 'cells'; key: string; cells: Cell[] }

function stamp(iso: string | null): string {
  if (iso === null) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function extOf(mime: string): string {
  const sub = mime.split('/')[1] ?? 'png'
  return sub === 'jpeg' ? 'jpg' : sub
}

function errText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/** 连续段分组：run_id 相同且相邻的归一组，run_id 为空的连续段归「单张」 */
function buildRows(items: ImageAsset[], labelOfApp: (op: string | null) => string): Row[] {
  const rows: Row[] = []
  let i = 0
  while (i < items.length) {
    const runId = items[i].run_id
    let end = i + 1
    while (end < items.length && items[end].run_id === runId) end += 1
    const group = items.slice(i, end)
    const head = group[0]
    rows.push({
      kind: 'head',
      key: `h-${head.id}`,
      label: runId === null ? '单张' : labelOfApp(head.op),
      time: stamp(head.created_at),
      count: group.length,
      ids: group.map((a) => a.id),
    })
    for (let k = 0; k < group.length; k += COLUMNS) {
      rows.push({
        kind: 'cells',
        key: `c-${group[k].id}`,
        cells: group.slice(k, k + COLUMNS).map((asset, n) => ({ asset, index: i + k + n })),
      })
    }
    i = end
  }
  return rows
}

/** 下载一张原图。走 blob 而不是直接 <a download>，才能在失败时拿到具体状态码 */
async function downloadOne(asset: ImageAsset): Promise<void> {
  const resp = await fetch(asset.full_url)
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  saveFile(await resp.blob(), `image-${asset.id}.${extOf(asset.mime)}`)
  // 立刻 revoke 会掐断还没落盘的下载，留 10 秒
}

export function GalleryRail(props: {
  selectedId: number | null
  onPick: (asset: ImageAsset) => void
  /** 按应用筛选的可选项，由外部传入 */
  apps?: ImageApp[]
  /** 折叠态，折叠后只留一条窄边可点开 */
  collapsed?: boolean
  onToggleCollapse?: () => void
}): JSX.Element {
  if (props.collapsed === true) {
    return (
      <button className="glr-cuff" onClick={props.onToggleCollapse} title="展开画廊">
        画廊
      </button>
    )
  }
  return <Rail {...props} />
}

function Rail({
  selectedId,
  onPick,
  apps = NO_APPS,
  onToggleCollapse,
}: {
  selectedId: number | null
  onPick: (asset: ImageAsset) => void
  apps?: ImageApp[]
  collapsed?: boolean
  onToggleCollapse?: () => void
}): JSX.Element {
  const queryClient = useQueryClient()
  const [filters, setFilters] = useState<AssetFilters>({})
  const [text, setText] = useState('')
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [anchor, setAnchor] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  // 搜提示词是模糊匹配，每敲一下就打一次接口太浪费，停 300ms 再发
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const q = text.trim() === '' ? undefined : text.trim()
      setFilters((prev) => (prev.q === q ? prev : { ...prev, q }))
    }, 300)
    return () => window.clearTimeout(timer)
  }, [text])

  const catalog = useQuery({ queryKey: ['img-catalog'], queryFn: apiImage.catalog })
  const page = useInfiniteQuery({
    queryKey: ['img-assets', filters],
    queryFn: ({ pageParam }) =>
      apiImage.assets({ ...filters, limit: PAGE_SIZE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0)
      return loaded < last.total ? loaded : undefined
    },
  })

  const { fetchNextPage, hasNextPage, isFetchingNextPage } = page
  const items = useMemo(
    () => page.data?.pages.flatMap((p) => p.items) ?? [],
    [page.data],
  )
  const total = page.data?.pages[0]?.total ?? 0

  const appLabels = useMemo(() => {
    const map = new Map<string, string>()
    for (const a of apps) map.set(a.key, a.label)
    return map
  }, [apps])

  const appGroups = useMemo(() => {
    const catLabel = new Map<string, string>(
      (catalog.data?.categories ?? []).map((c): [string, string] => [c.key, c.label]),
    )
    const out = new Map<string, { label: string; apps: ImageApp[] }>()
    for (const a of apps) {
      const bucket = out.get(a.category) ?? {
        label: catLabel.get(a.category) ?? a.category,
        apps: [],
      }
      bucket.apps.push(a)
      out.set(a.category, bucket)
    }
    return [...out.values()]
  }, [apps, catalog.data])

  const rows = useMemo(
    () => buildRows(items, (op) => (op === null ? '一批' : (appLabels.get(op) ?? op))),
    [items, appLabels],
  )

  const virtualizer = useVirtualizer({
    count: rows.length,
    // 首帧拿到 null 就不会重试，所以滚动容器必须用 useState 的 callback ref 持有
    getScrollElement: () => scrollEl,
    estimateSize: (i) => (rows[i]?.kind === 'head' ? ROW_HEAD : ROW_CELLS),
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: 6,
  })

  const virtualRows = virtualizer.getVirtualItems()
  const last = virtualRows[virtualRows.length - 1]

  // 渲染窗口逼近末尾就预拉下一页，滚动中不出现空白
  useEffect(() => {
    if (last === undefined || !hasNextPage || isFetchingNextPage) return
    if (last.index >= rows.length - 3) void fetchNextPage()
  }, [last, hasNextPage, isFetchingNextPage, rows.length, fetchNextPage])

  // 换筛选条件等于换了一份列表，旧的选中项与滚动位置都不该留着
  useEffect(() => {
    setSelected(new Set())
    setAnchor(null)
    scrollEl?.scrollTo({ top: 0 })
  }, [filters, scrollEl])

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: number; body: { favorite?: boolean; status?: string } }) =>
      apiImage.patchAsset(id, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['img-assets'] })
      void queryClient.invalidateQueries({ queryKey: ['img-stats'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const set = (p: AssetFilters) => setFilters((prev) => ({ ...prev, ...p }))

  const chosen = useMemo(() => items.filter((a) => selected.has(a.id)), [items, selected])
  const allFavorite = chosen.length > 0 && chosen.every((a) => a.favorite)
  const allArchived = chosen.length > 0 && chosen.every((a) => a.status === 'archived')

  const clickCell = (asset: ImageAsset, index: number, e: MouseEvent<HTMLButtonElement>) => {
    if (e.shiftKey && anchor !== null) {
      const from = Math.min(anchor, index)
      const to = Math.max(anchor, index)
      const next = new Set(selected)
      // 用 slice 而不是按下标取：两次点击之间列表可能因为归档刷新过，长度会变
      for (const a of items.slice(from, to + 1)) next.add(a.id)
      setSelected(next)
      return
    }
    if (e.metaKey || e.ctrlKey) {
      const next = new Set(selected)
      if (next.has(asset.id)) next.delete(asset.id)
      else next.add(asset.id)
      setSelected(next)
      setAnchor(index)
      return
    }
    setSelected(new Set())
    setAnchor(index)
    onPick(asset)
  }

  const toggleGroup = (ids: number[]) => {
    setSelected((prev) => {
      const next = new Set(prev)
      const already = ids.every((id) => next.has(id))
      for (const id of ids) {
        if (already) next.delete(id)
        else next.add(id)
      }
      return next
    })
  }

  /** 批量执行：一条失败不影响其余，最后如实报成功与失败各多少 */
  const runBatch = async (
    action: string,
    list: ImageAsset[],
    fn: (asset: ImageAsset) => Promise<unknown>,
  ) => {
    setBusy(true)
    const results = await Promise.allSettled(list.map(fn))
    setBusy(false)
    const ok = results.filter((r) => r.status === 'fulfilled').length
    const failed = results.length - ok
    const first = results.find((r) => r.status === 'rejected')
    const reason = first !== undefined && first.status === 'rejected' ? errText(first.reason) : ''
    if (failed === 0) toast.success(`${action} ${ok} 张`)
    else if (ok === 0) toast.error(`${action}失败 ${failed} 张：${reason}`)
    else toast.error(`${action} ${ok} 张，另有 ${failed} 张失败：${reason}`)
  }

  const batchPatch = async (action: string, body: { favorite?: boolean; status?: string }) => {
    await runBatch(action, chosen, (a) => apiImage.patchAsset(a.id, body))
    void queryClient.invalidateQueries({ queryKey: ['img-assets'] })
    void queryClient.invalidateQueries({ queryKey: ['img-stats'] })
  }

  return (
    <aside className="imgc-rail glr">
      <div className="glr-head">
        <b>画廊</b>
        <span>{total} 张</span>
        <span className="glr-gap" />
        {onToggleCollapse !== undefined && (
          <button className="glr-fold" onClick={onToggleCollapse} title="收起画廊">
            »
          </button>
        )}
      </div>

      <div className="glr-filters">
        <input
          className="glr-input"
          value={text}
          placeholder="搜提示词"
          onChange={(e) => setText(e.target.value)}
        />
        <div className="glr-two">
          <Picker
            size="sm"
            className="glr-sel"
            value={filters.target ?? 'all'}
            onChange={(v) => set({ target: v === 'all' ? undefined : v })}
            options={[
              { value: 'all', label: '全部用途' },
              ...(catalog.data?.targets ?? []).map((t) => ({ value: t.key, label: t.label })),
            ]}
          />
          <Picker
            size="sm"
            className="glr-sel"
            value={filters.source ?? 'all'}
            onChange={(v) => set({ source: v === 'all' ? undefined : v })}
            options={[
              { value: 'all', label: '全部来源' },
              ...SOURCES.map((s2) => ({ value: s2.key, label: s2.label })),
            ]}
          />
        </div>
        {appGroups.length > 0 && (
          <Picker
            size="sm"
            className="glr-sel"
            value={filters.app ?? 'all'}
            onChange={(v) => set({ app: v === 'all' ? undefined : v })}
            /* optgroup 换成 PickerOption.group，分组语义不丢 */
            options={[
              { value: 'all', label: '全部应用' },
              ...appGroups.flatMap((g) =>
                g.apps.map((a) => ({ value: a.key, label: a.label, group: g.label })),
              ),
            ]}
          />
        )}
        <div className="glr-toggles">
          <button
            className={`glr-toggle${filters.favorite === true ? ' on' : ''}`}
            title="只看收藏"
            onClick={() => set({ favorite: filters.favorite === true ? undefined : true })}
          >
            ★ 收藏
          </button>
          <button
            className={`glr-toggle${filters.status === 'archived' ? ' on' : ''}`}
            title="看已归档"
            onClick={() =>
              set({ status: filters.status === 'archived' ? undefined : 'archived' })
            }
          >
            归档
          </button>
        </div>
      </div>

      <div className={`glr-scroll${chosen.length > 0 ? ' crowded' : ''}`} ref={setScrollEl}>
        {page.isPending && <p className="glr-tip">读取中…</p>}
        {page.isError && <p className="glr-tip bad">读不到资产：{page.error.message}</p>}
        {!page.isPending && !page.isError && items.length === 0 && (
          <p className="glr-tip">没有符合条件的图</p>
        )}

        <div className="glr-canvas" style={{ height: virtualizer.getTotalSize() }}>
          {virtualRows.map((vr) => {
            const row = rows[vr.index]
            if (row === undefined) return null
            return (
              <div
                key={row.key}
                className="glr-row"
                style={{ height: vr.size, transform: `translateY(${vr.start}px)` }}
              >
                {row.kind === 'head' ? (
                  <div className="glr-group">
                    <b>{row.label}</b>
                    <span className="glr-time">{row.time}</span>
                    <span>{row.count} 张</span>
                    <button
                      className="glr-pick"
                      title="选中或取消整组"
                      onClick={() => toggleGroup(row.ids)}
                    >
                      选组
                    </button>
                  </div>
                ) : (
                  <div className="glr-cells">
                    {row.cells.map(({ asset, index }) => (
                      <div
                        key={asset.id}
                        className={`glr-cell${selectedId === asset.id ? ' on' : ''}${
                          selected.has(asset.id) ? ' sel' : ''
                        }`}
                      >
                        <button
                          className="glr-thumb"
                          onClick={(e) => clickCell(asset, index, e)}
                          title={`${asset.width}×${asset.height}${
                            asset.prompt === '' ? '' : ` · ${asset.prompt.slice(0, 60)}`
                          }`}
                        >
                          <img src={asset.thumb_url} alt="" loading="lazy" />
                        </button>
                        {asset.favorite && <span className="glr-fav">★</span>}
                        <div className="glr-ops">
                          <button
                            title={asset.favorite ? '取消收藏' : '收藏'}
                            onClick={() =>
                              patch.mutate({ id: asset.id, body: { favorite: !asset.favorite } })
                            }
                          >
                            {asset.favorite ? '★' : '☆'}
                          </button>
                          <button
                            title={asset.status === 'archived' ? '恢复' : '归档'}
                            onClick={() =>
                              patch.mutate({
                                id: asset.id,
                                body: {
                                  status: asset.status === 'archived' ? 'candidate' : 'archived',
                                },
                              })
                            }
                          >
                            {asset.status === 'archived' ? '↺' : '⌫'}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {isFetchingNextPage && <p className="glr-tip">再取 {PAGE_SIZE} 张…</p>}
      </div>

      {chosen.length > 0 && (
        <div className="glr-bar">
          <span className="glr-count">选中 {chosen.length} 张</span>
          <button
            disabled={busy}
            onClick={() =>
              void batchPatch(allFavorite ? '取消收藏' : '收藏', { favorite: !allFavorite })
            }
          >
            {allFavorite ? '取消收藏' : '收藏'}
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void batchPatch(allArchived ? '恢复' : '归档', {
                status: allArchived ? 'candidate' : 'archived',
              })
            }
          >
            {allArchived ? '恢复' : '归档'}
          </button>
          <button disabled={busy} onClick={() => void runBatch('下载', chosen, downloadOne)}>
            下载
          </button>
          <button className="glr-clear" onClick={() => setSelected(new Set())}>
            取消选择
          </button>
        </div>
      )}
    </aside>
  )
}
