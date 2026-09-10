/* 画布右侧的资产库：把已有的图片 / 媒体 / 工作流 / 提示词拖进画布。

   重建前这个面板有三处是真坏的，不是审美问题：

   1. **卡片塌成 2px 高。** 卡片是 `<button>` 且带 `overflow: hidden`，
      而带滚动溢出的 grid item 其 `min-height: auto` 按规范解析成 **0**——
      外层的 auto 行于是被压平，120 张图铺成 120 条空白细线。
      修法是给卡片一个 `min-height: min-content`，不是去调行高。
   2. **搜索图标 139×139。** 图标 SVG 没有尺寸约束，在 flex 里撑满整格，
      搜索框被顶到 155px 高，像一个巨大的放大镜贴纸。
   3. **六个页签只给了五列。** `repeat(5, 1fr)` 配六个 tab，「提示词」被挤到第二行。

   重建时的两条取舍：

   - **图片卡以缩略图为主体，不写「图片 212」。** id 对人没有意义，
     挑图靠的是看；名字只在悬停时压在图上，不占常驻版面。
   - **提示词单独用整行卡片。** 它的身份是正文不是标题，两列小格子里
     只放得下一个标题，等于把最要紧的信息藏进 tooltip。
   - **缩略图 contain 不裁切。** 原来是 cover，一张 1536×1024 的横图在方格里
     被切掉三分之一——而这个面板的唯一用途就是**认出哪张是哪张**，
     裁掉的部分恰恰可能是区分两张图的地方。留白比裁切诚实。
   - **悬停给「看大图」与「删除」两个动作。** 拖拽与双击是加到画布，
     这两件事此前在面板里根本做不到：想看清楚只能先拖进画布，
     想删掉得跑去素材库找。 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Boxes, Cloud, Maximize2, Trash2 } from '@/components/NexusIcon'
import { useMemo, useState } from 'react'
import type { DragEvent } from 'react'
import { toast } from 'sonner'

import {
  IconClose,
  IconFileText,
  IconImage,
  IconSearch,
  IconSpeaker,
  IconVideo,
} from '../../components/icons'
import { ImageViewer } from '../../components/ImageViewer'
import { apiImage } from '../../lib/api-image'
import type { ImageAsset } from '../../lib/api-image'
import { apiStudio } from '../../lib/api-studio'
import type { ExecutableWorkflow, PromptItem, StudioMediaAsset } from '../../lib/api-studio'

export const CANVAS_ASSET_MIME = 'application/x-lingua-canvas-asset'

export type CanvasPanelAsset =
  | { type: 'image'; asset: ImageAsset }
  | { type: 'media'; asset: StudioMediaAsset }
  | { type: 'workflow'; workflow: ExecutableWorkflow }
  | { type: 'prompt'; prompt: PromptItem }

type PanelTab = 'image' | 'video' | 'audio' | 'file' | 'workflow' | 'prompt'

const TABS: { key: PanelTab; label: string }[] = [
  { key: 'image', label: '图片' },
  { key: 'video', label: '视频' },
  { key: 'audio', label: '音频' },
  { key: 'file', label: '文件' },
  { key: 'workflow', label: '工作流' },
  { key: 'prompt', label: '提示词' },
]

const EMPTY_HINT: Record<PanelTab, string> = {
  image: '生成或导入的图片会出现在这里',
  video: '导入视频后可以直接拖进画布',
  audio: '导入音频后可以直接拖进画布',
  file: '导入的文件会出现在这里',
  workflow: '在「工作流」里启用后才会出现在这里',
  prompt: '在提示词库里存下的词会出现在这里',
}

/** 一行摘要：多行提示词压成一行，太长再截。卡片上留三行的量就够看出是什么词了 */
function excerpt(raw: string, max = 110): string {
  const flat = raw.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

export function CanvasAssetPanel({
  onAdd,
  onClose,
}: {
  onAdd: (payload: CanvasPanelAsset) => void
  onClose: () => void
}) {
  const [tab, setTab] = useState<PanelTab>('image')
  const [query, setQuery] = useState('')
  /** 看大图时停在第几张。null = 没开 */
  const [viewing, setViewing] = useState<number | null>(null)
  const qc = useQueryClient()
  const images = useQuery({
    queryKey: ['canvas-asset-panel', 'image'],
    queryFn: () => apiImage.assets({ limit: 120 }),
    enabled: tab === 'image',
  })
  const media = useQuery({
    queryKey: ['canvas-asset-panel', tab],
    queryFn: () => apiStudio.mediaAssets({ kind: tab as StudioMediaAsset['kind'], limit: 120 }),
    enabled: tab === 'video' || tab === 'audio' || tab === 'file',
  })
  const workflows = useQuery({
    queryKey: ['studio-workflows', 'canvas-asset-panel'],
    queryFn: () => apiStudio.workflows('?enabled=true'),
    enabled: tab === 'workflow',
  })
  const prompts = useQuery({
    queryKey: ['spl-prompts', 'canvas-asset-panel'],
    queryFn: () => apiStudio.prompts(),
    enabled: tab === 'prompt',
  })
  const needle = query.trim().toLowerCase()
  const imageItems = useMemo(
    () =>
      (images.data?.items ?? []).filter(
        (item) => needle === '' || item.prompt.toLowerCase().includes(needle),
      ),
    [images.data, needle],
  )
  const mediaItems = useMemo(
    () =>
      (media.data?.items ?? []).filter(
        (item) => needle === '' || item.name.toLowerCase().includes(needle),
      ),
    [media.data, needle],
  )
  const workflowItems = useMemo(
    () =>
      (workflows.data?.items ?? []).filter(
        (item) => needle === '' || `${item.title} ${item.kind}`.toLowerCase().includes(needle),
      ),
    [needle, workflows.data],
  )
  const promptItems = useMemo(
    () =>
      (prompts.data?.items ?? []).filter(
        (item) =>
          needle === '' || `${item.title} ${item.scene} ${item.body}`.toLowerCase().includes(needle),
      ),
    [needle, prompts.data],
  )

  /* 删除走两步：先问服务端「谁在用它」，把它给的那句话原样摆出来再让用户确认。

     **不自己拼那句话**：服务端的 `summary` 已经把画布引用、编辑链子代、
     应用目标都算进去了，前端再拼一份只会与它的判据慢慢分叉。
     `deletable=false`（有编辑链子代）时才需要 force——那意味着链会断。 */
  const del = useMutation({
    mutationFn: async (asset: ImageAsset) => {
      const usage = await apiImage.assetUsage(asset.id).catch(() => null)
      const tail = usage === null ? '' : `\n\n${usage.summary}`
      if (!window.confirm(`彻底删除这张图？归档还能翻出来，这个删了就没了。${tail}`)) return null
      return apiImage.deleteAsset(asset.id, usage !== null && !usage.deletable)
    },
    onSuccess: (result) => {
      if (result === null) return
      void qc.invalidateQueries({ queryKey: ['canvas-asset-panel', 'image'] })
      const failed = result.failed_objects ?? []
      const kept = result.kept_objects ?? []
      if (failed.length > 0) toast.warning(`已删除，但有 ${failed.length} 个文件没清掉`)
      else if (kept.length > 0) {
        // 原图被别处占着（如单词本封面直接引用 storage_key），保留是对的，但要说
        toast.success(`已删除，原图仍被${kept[0].held_by[0] ?? '别处'}占用，文件保留`)
      } else toast.success('已删除')
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : '删除失败'),
  })

  const drag = (event: DragEvent, payload: CanvasPanelAsset) => {
    event.dataTransfer.effectAllowed = 'copy'
    event.dataTransfer.setData(CANVAS_ASSET_MIME, JSON.stringify(payload))
    const label =
      payload.type === 'workflow'
        ? payload.workflow.title
        : payload.type === 'prompt'
          ? payload.prompt.title
          : payload.type === 'media'
            ? payload.asset.name
            : `图片 ${payload.asset.id}`
    event.dataTransfer.setData('text/plain', label)
  }

  const activeQuery =
    tab === 'image' ? images : tab === 'workflow' ? workflows : tab === 'prompt' ? prompts : media
  const pending = activeQuery.isPending
  const error = activeQuery.error
  const count =
    tab === 'image'
      ? imageItems.length
      : tab === 'workflow'
        ? workflowItems.length
        : tab === 'prompt'
          ? promptItems.length
          : mediaItems.length
  const empty = count === 0
  const filtered = needle !== ''

  return (
    <aside className="scv-asset-panel" aria-label="画布资产库">
      <header>
        <div>
          <strong>资产库</strong>
          <span>拖到画布，或双击添加</span>
        </div>
        <button className="btn-ghost-sm" aria-label="关闭资产库" onClick={onClose}>
          <IconClose />
        </button>
      </header>

      <div className="scv-asset-panel-tabs" role="tablist" aria-label="资产类型">
        {TABS.map((item) => (
          <button
            key={item.key}
            role="tab"
            aria-selected={tab === item.key}
            className={tab === item.key ? 'is-active' : ''}
            onClick={() => setTab(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <label className="scv-asset-panel-search">
        <IconSearch />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`在${TABS.find((t) => t.key === tab)?.label}里搜…`}
        />
        {query !== '' && (
          <button type="button" aria-label="清空搜索" onClick={() => setQuery('')}>
            ×
          </button>
        )}
      </label>

      <div className={`scv-asset-panel-grid${tab === 'prompt' ? ' is-list' : ''}`}>
        {/* 骨架而不是「载入资产…」一行字：占住位置，切页签时版面不跳 */}
        {pending &&
          Array.from({ length: 6 }, (_, i) => (
            <div key={`sk-${i}`} className="scv-asset-skeleton" aria-hidden />
          ))}

        {error !== null && (
          <p className="scv-asset-panel-msg">
            {error instanceof Error ? error.message : '资产加载失败'}
          </p>
        )}

        {!pending && error === null && empty && (
          <p className="scv-asset-panel-msg">
            {filtered ? `没有匹配「${query.trim()}」的资产` : EMPTY_HINT[tab]}
          </p>
        )}

        {tab === 'image' &&
          imageItems.map((asset) => {
            const payload = { type: 'image' as const, asset }
            return (
              <div
                key={asset.id}
                className="scv-asset-card is-media"
                draggable
                onDragStart={(event) => drag(event, payload)}
                onDoubleClick={() => onAdd(payload)}
                title={asset.prompt || `图片 ${asset.id}`}
              >
                <img src={asset.thumb_url} alt="" loading="lazy" />
                {/* 名字只在悬停时压在图上：挑图靠看，「图片 212」常驻只是占地方 */}
                <span className="scv-asset-cap">
                  <IconImage /> {asset.id}
                </span>
                {/* 悬停动作。拖拽/双击是加到画布，这两件此前在面板里做不到：
                    想看清楚只能先拖进画布，想删掉得跑去素材库 */}
                <span className="scv-asset-ops">
                  <button
                    aria-label="看大图"
                    title="看大图"
                    onClick={() => setViewing(imageItems.indexOf(asset))}
                  >
                    <Maximize2 />
                  </button>
                  <button
                    className="is-danger"
                    aria-label="删除这张图"
                    title="删除这张图"
                    disabled={del.isPending}
                    onClick={() => del.mutate(asset)}
                  >
                    <Trash2 />
                  </button>
                </span>
              </div>
            )
          })}

        {(tab === 'video' || tab === 'audio' || tab === 'file') &&
          mediaItems.map((asset) => {
            const payload = { type: 'media' as const, asset }
            return (
              <button
                key={asset.id}
                className="scv-asset-card is-media"
                draggable
                onDragStart={(event) => drag(event, payload)}
                onDoubleClick={() => onAdd(payload)}
                title={asset.name}
              >
                {asset.poster_url !== null ? (
                  <img src={asset.poster_url} alt="" loading="lazy" />
                ) : (
                  <i>
                    {asset.kind === 'video' ? (
                      <IconVideo />
                    ) : asset.kind === 'audio' ? (
                      <IconSpeaker />
                    ) : (
                      <IconFileText />
                    )}
                  </i>
                )}
                <span className="scv-asset-cap is-always">{asset.name}</span>
              </button>
            )
          })}

        {tab === 'workflow' &&
          workflowItems.map((workflow) => {
            const payload = { type: 'workflow' as const, workflow }
            return (
              <button
                key={workflow.id}
                className="scv-asset-card is-media"
                draggable
                onDragStart={(event) => drag(event, payload)}
                onDoubleClick={() => onAdd(payload)}
                title={workflow.title}
              >
                {workflow.has_thumbnail ? (
                  <img src={`/api/studio/workflows/${workflow.id}/thumbnail`} alt="" loading="lazy" />
                ) : (
                  <i>{workflow.provider === 'comfyui' ? <Boxes /> : <Cloud />}</i>
                )}
                <span className="scv-asset-cap is-always">{workflow.title}</span>
              </button>
            )
          })}

        {/* 提示词整行铺：它的身份是正文不是标题，塞进两列小格子等于把
            最要紧的信息藏进 tooltip */}
        {tab === 'prompt' &&
          promptItems.map((prompt) => {
            const payload = { type: 'prompt' as const, prompt }
            return (
              <button
                key={prompt.id}
                className="scv-asset-card is-prompt"
                draggable
                onDragStart={(event) => drag(event, payload)}
                onDoubleClick={() => onAdd(payload)}
                title={prompt.body}
              >
                <b>
                  <IconFileText />
                  {prompt.title}
                </b>
                {/* scene 装的是「什么时候用这条」的中文说明，不是短分类标签。
                    做成右侧胶囊会把标题挤到换行，而且它对中文用户比下面那段
                    英文正文更有用——所以给它整整一行，排在正文前面。 */}
                {prompt.scene !== '' && <span className="scv-prompt-scene">{prompt.scene}</span>}
                <p>{excerpt(prompt.body, 90)}</p>
              </button>
            )
          })}
      </div>

      {!pending && error === null && !empty && (
        <footer className="scv-asset-panel-foot">
          {filtered ? `匹配 ${count} 个` : `共 ${count} 个`}
        </footer>
      )}

      {/* 看大图看的是**原图**（full_url），不是列表里那张 192px 缩略图——
          点开大图的唯一目的就是看清楚 */}
      {viewing !== null && imageItems[viewing] !== undefined && (
        <ImageViewer
          images={imageItems.map((a) => ({
            id: a.id,
            url: a.full_url,
            caption: a.prompt || `图片 ${a.id}`,
          }))}
          index={viewing}
          onIndex={setViewing}
          onClose={() => setViewing(null)}
          actions={
            <>
              <button
                className="btn btn-outline btn-sm"
                onClick={() => {
                  onAdd({ type: 'image', asset: imageItems[viewing] })
                  setViewing(null)
                }}
              >
                加到画布
              </button>
              <button
                className="btn btn-danger btn-sm"
                disabled={del.isPending}
                onClick={() => {
                  const asset = imageItems[viewing]
                  del.mutate(asset, {
                    onSuccess: (r) => {
                      if (r === null) return
                      // 删完停在同一位置看下一张；删的是最后一张就退回上一张
                      setViewing((i) => (i === null ? null : Math.min(i, imageItems.length - 2)))
                    },
                  })
                }}
              >
                删除
              </button>
            </>
          }
        />
      )}
    </aside>
  )
}
