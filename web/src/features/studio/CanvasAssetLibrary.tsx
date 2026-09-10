import type { ReactNode } from 'react'
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, Download, FileText, Film, Image, Music, RefreshCw } from '@/components/NexusIcon'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

import { IconClose, IconSearch } from '../../components/icons'
import { apiStudio } from '../../lib/api-studio'
import type { CanvasAssetItem } from '../../lib/api-studio'
import { saveFile } from '@/lib/shell'

function errText(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误'
}

function kindLabel(kind: CanvasAssetItem['kind']): string {
  return kind === 'image' ? '图片' : kind === 'video' ? '视频' : kind === 'audio' ? '音频' : '文件'
}

function saveBlob(blob: Blob, filename: string): void {
  saveFile(blob, filename)
}

export function CanvasAssetLibrary({ tabs }: { tabs: ReactNode }) {
  const navigate = useNavigate()
  const [category, setCategory] = useState<'all' | 'smart' | 'classic'>('all')
  const [canvasId, setCanvasId] = useState<number | null>(null)
  const [text, setText] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [detailId, setDetailId] = useState<string | null>(null)
  const [downloading, setDownloading] = useState(false)
  const catalog = useQuery({ queryKey: ['sal-canvas-assets'], queryFn: () => apiStudio.canvasAssets() })
  const items = useMemo(() => {
    const query = text.trim().toLowerCase()
    return (catalog.data?.items ?? []).filter((item) => {
      if (category !== 'all' && item.canvas_kind !== category) return false
      if (canvasId !== null && item.canvas_id !== canvasId) return false
      if (query === '') return true
      return `${item.name} ${item.canvas_title} ${item.node_title} ${item.source_path}`
        .toLowerCase()
        .includes(query)
    })
  }, [canvasId, catalog.data, category, text])
  const detail = (catalog.data?.items ?? []).find((item) => item.id === detailId) ?? null
  const canvases = (catalog.data?.canvases ?? []).filter(
    (canvas) => category === 'all' || canvas.kind === category,
  )

  const chooseCategory = (value: 'all' | 'smart' | 'classic') => {
    setCategory(value)
    setCanvasId(null)
    setSelected(new Set())
    setDetailId(null)
  }

  const toggle = (item: CanvasAssetItem) => {
    setDetailId(item.id)
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(item.id)) next.delete(item.id)
      else next.add(item.id)
      return next
    })
  }

  const download = async () => {
    if (selected.size === 0 || downloading) return
    setDownloading(true)
    try {
      const result = await apiStudio.downloadCanvasAssets({
        item_ids: [...selected],
        filename: '画布素材.zip',
      })
      saveBlob(result.blob, result.filename)
      toast.success('已打包下载所选本地画布素材')
    } catch (error) {
      toast.error(`下载失败：${errText(error)}`)
    } finally {
      setDownloading(false)
    }
  }

  return (
    <main className="page sal-page">
      <aside className="sal-side sal-canvas-side">
        <div className="sal-side-sec"><span>画布类型</span></div>
        {(catalog.data?.categories ?? []).map((item) => (
          <button
            key={item.id}
            className={category === item.id && canvasId === null ? 'sal-item sal-item-on' : 'sal-item'}
            onClick={() => chooseCategory(item.id)}
          >
            <Image /><span className="sal-item-name">{item.name}</span><span className="sal-item-count">{item.count}</span>
          </button>
        ))}
        <div className="sal-side-sec"><span>画布</span></div>
        {canvases.map((canvas) => (
          <button
            key={canvas.id}
            className={canvasId === canvas.id ? 'sal-item sal-item-on' : 'sal-item'}
            onClick={() => {
              setCanvasId(canvas.id)
              setSelected(new Set())
              setDetailId(null)
            }}
            title={canvas.title}
          >
            <span>{canvas.icon || '◇'}</span>
            <span className="sal-item-name">{canvas.title}</span>
            <span className="sal-item-count">{canvas.asset_count}</span>
          </button>
        ))}
      </aside>
      <section className="sal-main">
        {tabs}
        <header className="sal-head">
          <div><h1>画布资产</h1><p>按画布类型与画布聚合节点引用；同一画布内相同资产只显示一次</p></div>
          <span className="sal-flex" />
          <button className="btn btn-outline" onClick={() => void catalog.refetch()}><RefreshCw />刷新</button>
        </header>
        <div className="sal-bar">
          <span className="sal-search"><IconSearch /><input value={text} placeholder="搜索画布、节点或素材名称…" onChange={(event) => setText(event.target.value)} /></span>
          <button className="btn btn-soft" disabled={selected.size === 0 || downloading} onClick={() => void download()}>
            <Download />{downloading ? '打包中…' : `下载所选（${selected.size}）`}
          </button>
        </div>
        {catalog.isError && <p className="sal-note sal-note-err">画布资产加载失败：{errText(catalog.error)}</p>}
        <div className="sal-body">
          {catalog.isPending && <p className="sal-empty">正在建立画布资产索引…</p>}
          {!catalog.isPending && items.length === 0 && <p className="sal-empty">当前条件下没有画布资产。</p>}
          {items.length > 0 && (
            <div className="sal-grid sal-shared-grid">
              {items.map((item) => (
                <button
                  key={item.id}
                  className={selected.has(item.id) ? 'sal-cell sal-cell-on sal-shared-cell' : 'sal-cell sal-shared-cell'}
                  onClick={() => toggle(item)}
                  title={`${item.canvas_title} / ${item.node_title}`}
                >
                  {item.kind === 'image' && item.url !== '' ? (
                    <img src={item.url} alt="" loading="lazy" />
                  ) : (
                    <span className="sal-media-icon">
                      {item.kind === 'video' ? <Film /> : item.kind === 'audio' ? <Music /> : <FileText />}
                    </span>
                  )}
                  <span className="sal-media-name">{item.name}</span>
                  <span className="sal-media-meta">{item.canvas_title} · {kindLabel(item.kind)}</span>
                  {item.missing && <span className="sal-badge">资源缺失</span>}
                  {selected.has(item.id) && <span className="sal-tick"><Check /></span>}
                </button>
              ))}
            </div>
          )}
        </div>
      </section>
      {detail !== null && (
        <aside className="sal-media-detail" aria-label="画布资产详情">
          <header><strong>{detail.name}</strong><button className="btn-ghost-sm" onClick={() => setDetailId(null)}><IconClose /></button></header>
          {detail.kind === 'image' && detail.url !== '' && <img className="sal-shared-preview" src={detail.url} alt="" />}
          {detail.kind === 'video' && detail.url !== '' && <video src={detail.url} controls playsInline preload="metadata" />}
          {detail.kind === 'audio' && detail.url !== '' && <audio src={detail.url} controls preload="metadata" />}
          <dl>
            <div><dt>画布</dt><dd>{detail.canvas_title}</dd></div>
            <div><dt>节点</dt><dd>{detail.node_title}</dd></div>
            <div><dt>字段位置</dt><dd>{detail.source_path || '节点资源'}</dd></div>
            <div><dt>类型</dt><dd>{kindLabel(detail.kind)}</dd></div>
          </dl>
          <button className="btn btn-soft" onClick={() => navigate(`/studio/canvas/${detail.canvas_id}`)}>打开所属画布</button>
          {detail.url !== '' && <a className="btn btn-outline" href={detail.url} target="_blank" rel="noreferrer">打开原素材</a>}
        </aside>
      )}
    </main>
  )
}
