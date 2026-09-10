import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FileWarning, ImageOff, RefreshCw, ShieldCheck } from '@/components/NexusIcon'
import { useState } from 'react'
import { toast } from 'sonner'

import { Overlay } from '../../components/Overlay'
import type { ImageAsset } from '../../lib/api-image'
import { apiStudio } from '../../lib/api-studio'
import type { CanvasAssetItem, StudioMediaAsset } from '../../lib/api-studio'
import { AssetPicker } from './AssetPicker'
import { MediaAssetPicker } from './MediaAssetPicker'
import { flushSave, useCanvasStore } from './canvasStore'

type Replacement =
  | { type: 'image'; asset: ImageAsset }
  | { type: 'media'; asset: StudioMediaAsset }

export function replaceCanvasReference(value: unknown, missing: CanvasAssetItem, replacement: Replacement): unknown {
  if (Array.isArray(value)) return value.map((item) => replaceCanvasReference(item, missing, replacement))
  if (typeof value !== 'object' || value === null) return value
  const original = value as Record<string, unknown>
  const next: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(original)) {
    next[key] = replaceCanvasReference(child, missing, replacement)
  }
  const refKey = missing.asset_type === 'image' ? 'asset_id' : 'media_asset_id'
  if (missing.asset_id === null || Number(original[refKey]) !== missing.asset_id) return next

  next[refKey] = replacement.asset.id
  delete next.missing
  const itemLike = 'kind' in original || 'url' in original || 'name' in original || 'mime' in original
  if (replacement.type === 'image') {
    if (itemLike) {
      next.kind = 'image'
      next.name = replacement.asset.display_name || original.name || `图片 #${replacement.asset.id}`
      next.w = replacement.asset.width
      next.h = replacement.asset.height
      delete next.url
      delete next.poster_url
    }
  } else if (itemLike) {
    next.kind = replacement.asset.kind
    next.name = replacement.asset.name
    next.mime = replacement.asset.mime
    next.url = replacement.asset.url
    next.poster_url = replacement.asset.poster_url
    next.duration_ms = replacement.asset.duration_ms
    next.w = replacement.asset.width ?? undefined
    next.h = replacement.asset.height ?? undefined
  }
  return next
}

export function CanvasResourceRepair({ canvasId, onClose }: { canvasId: number; onClose: () => void }) {
  const queryClient = useQueryClient()
  const nodes = useCanvasStore((state) => state.nodes)
  const [replacing, setReplacing] = useState<CanvasAssetItem | null>(null)
  const index = useQuery({
    queryKey: ['canvas-resource-repair', canvasId],
    queryFn: apiStudio.canvasAssets,
  })
  const missing = (index.data?.items ?? []).filter(
    (item) => item.canvas_id === canvasId && item.missing,
  )

  const apply = async (replacement: Replacement) => {
    if (replacing === null) return
    const store = useCanvasStore.getState()
    store.snapshot()
    let changed = 0
    for (const node of nodes) {
      const next = replaceCanvasReference(node, replacing, replacement) as typeof node
      if (JSON.stringify(next) === JSON.stringify(node)) continue
      store.updateNode(node.id, next)
      changed += 1
    }
    setReplacing(null)
    if (changed === 0) {
      toast.error('当前画布状态里没有找到这条缺失引用，请重新载入画布后再试')
      return
    }
    await flushSave()
    await Promise.all([
      index.refetch(),
      queryClient.invalidateQueries({ queryKey: ['sal-canvas-assets'] }),
    ])
    toast.success(`已替换 ${changed} 个节点中的缺失引用`)
  }

  return (
    <Overlay onClose={onClose} card="scv-repair-dialog" labelledBy="scv-repair-title">
      <header>
        <div>
          <h2 id="scv-repair-title">资源同步与缺失修复</h2>
          <p>按当前资产库重新核对画布引用；替换会更新所有引用同一资产 ID 的位置。</p>
        </div>
        <button className="btn btn-ghost-sm" onClick={onClose}>关闭</button>
      </header>

      <aside>
        <ShieldCheck />
        <span>JSON/ZIP 跨端导入会按 SHA-256 复用或重建随包资源；外部 URL 不由服务端代抓，避免把画布链接变成内网探测入口。</span>
      </aside>

      {index.isPending && <p className="scv-repair-empty">正在核对资源…</p>}
      {index.isError && <p className="scv-repair-empty is-error">核对失败：{index.error.message}</p>}
      {!index.isPending && !index.isError && missing.length === 0 && (
        <p className="scv-repair-ok"><ShieldCheck />当前画布的本地资产引用完整，没有缺失项。</p>
      )}
      <div className="scv-repair-list">
        {missing.map((item) => (
          <article key={item.id}>
            {item.kind === 'image' ? <ImageOff /> : <FileWarning />}
            <div>
              <strong>{item.name}</strong>
              <span>{item.node_title} · {item.source_path}</span>
              <code>{item.asset_type}:{item.asset_id}</code>
            </div>
            <button className="btn btn-outline btn-sm" onClick={() => setReplacing(item)}>
              <RefreshCw />选择替换
            </button>
          </article>
        ))}
      </div>

      {replacing?.asset_type === 'image' && (
        <AssetPicker
          onClose={() => setReplacing(null)}
          onPick={(asset) => void apply({ type: 'image', asset })}
        />
      )}
      {replacing?.asset_type === 'media' && (
        <MediaAssetPicker
          kind={replacing.kind === 'image' ? undefined : replacing.kind}
          onClose={() => setReplacing(null)}
          onPick={(asset) => void apply({ type: 'media', asset })}
        />
      )}
    </Overlay>
  )
}
