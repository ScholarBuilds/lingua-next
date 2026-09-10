/* 输入框上的附件（模块 17 · FR-463）。
 *
 * 与节点的 `items` 是两回事：`items` 是这个节点的**产出**，附件是喂给它的**输入**。
 * 混在一起的话，用户带一份设计规范 pdf 进来，它就变成节点的一张"图"了。
 *
 * 三种归宿，按类型分：
 * - 图片 → 进 `refAssetIds`，出图时真作为参考图上送；
 * - 文档 → 规划时由服务端按 id 抽正文（前端不读、不缓存，见 ScvNode.attachments 注释）；
 * - 音视频 → 目前只作为"带着的东西"展示，模型侧还消费不了。
 *
 * 这个文件同时被生成条和成套弹窗引用——两边显示的必须是同一份东西，
 * 各写一套的话「输入框里带了三样、成套框里显示两样」这种错没人查得出来。 */

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { FileText, Music, Paperclip, Video, X } from '@/components/NexusIcon'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { toast } from 'sonner'

import { Overlay } from '../../components/Overlay'
import { apiImage } from '../../lib/api-image'
import { apiStudio } from '../../lib/api-studio'
import type { CanvasItem } from '../../lib/api-studio'
import { itemSrc } from './CanvasNodes'

import './attachments.css'

/** 一次最多挂几个。不是产品限制，是防手滑把整个下载目录拖进来 */
export const MAX_ATTACHMENTS = 20

const IMAGE_FILE_RE = /\.(png|jpe?g|webp|gif|bmp|avif|tiff?)$/i

function isImageFile(file: File): boolean {
  return file.type.toLowerCase().startsWith('image/') || IMAGE_FILE_RE.test(file.name)
}

/** 上传一批文件，返回可以直接挂到节点上的 items。
 *
 *  图片走 `/images` 那条线（有缩略图变体、有编辑血缘），其余走媒体资产库。
 *  两条线都**先入库再挂**：附件只存 id，画布文档里不进字节。 */
export async function uploadAttachments(files: File[]): Promise<CanvasItem[]> {
  const out: CanvasItem[] = []
  const failures: string[] = []
  for (const file of files) {
    if (file.size === 0) continue
    try {
      if (isImageFile(file)) {
        const form = new FormData()
        form.set('image', file)
        form.set('op', 'upload')
        const asset = await apiImage.saveLocal(form)
        out.push({
          kind: 'image',
          asset_id: asset.id,
          name: file.name,
          mime: file.type,
          w: asset.width,
          h: asset.height,
        })
      } else {
        const asset = await apiStudio.uploadMediaAsset(file)
        out.push({
          kind: asset.kind,
          media_asset_id: asset.id,
          url: asset.url,
          poster_url: asset.poster_url,
          name: asset.name,
          mime: asset.mime,
          duration_ms: asset.duration_ms,
          w: asset.width ?? undefined,
          h: asset.height ?? undefined,
        })
      }
    } catch (error) {
      failures.push(`${file.name}：${error instanceof Error ? error.message : '上传失败'}`)
    }
  }
  if (failures.length > 0) toast.error(failures.slice(0, 3).join('\n'))
  return out
}

function KindIcon({ kind }: { kind: CanvasItem['kind'] }): JSX.Element {
  if (kind === 'video') return <Video />
  if (kind === 'audio') return <Music />
  return <FileText />
}

/** 一枚附件的展示单元。图片给缩略图，其余给类型图标 + 文件名 */
export function AttachChip({
  item,
  onRemove,
  onOpen,
}: {
  item: CanvasItem
  onRemove?: () => void
  onOpen?: () => void
}): JSX.Element {
  const name = item.name ?? (item.kind === 'image' ? '图片' : '文件')
  return (
    <span className={item.kind === 'image' ? 'atc-chip atc-chip-img' : 'atc-chip'}>
      <button className="atc-chip-open" title={`预览 ${name}`} onClick={onOpen}>
        {item.kind === 'image' ? (
          <img src={itemSrc(item, 'thumb')} alt="" draggable={false} />
        ) : (
          <KindIcon kind={item.kind} />
        )}
        <b>{name}</b>
      </button>
      {onRemove !== undefined && (
        <button className="atc-chip-x" aria-label={`移除 ${name}`} title="移除" onClick={onRemove}>
          <X />
        </button>
      )}
    </span>
  )
}

/** 文档类附件的正文预览。
 *
 *  分工是有意的，不是随手：
 *
 *  | 类型 | 谁渲染 | 为什么 |
 *  | --- | --- | --- |
 *  | pdf | 浏览器内置阅读器（`<iframe>` 指向原文件） | 版式忠实，且不用引 pdf.js |
 *  | md | react-markdown（本仓已有依赖） | 表格、代码块、链接都在 |
 *  | xlsx / csv | 服务端 openpyxl 解析成二维表，这里画 `<table>` | 前端不背几百 KB 的解析库 |
 *  | 其余文本 | 等宽 `<pre>` | 不猜格式 |
 *  | 二进制 | 一句"看不了" | 不伪造——抽不出就说抽不出 |
 */
function DocBody({ item }: { item: CanvasItem }): JSX.Element {
  const id = item.media_asset_id
  const isPdf = /\.pdf$/i.test(item.name ?? '') || item.mime === 'application/pdf'
  const preview = useQuery({
    queryKey: ['media-preview', id],
    queryFn: () => apiStudio.mediaAssetPreview(id as number),
    enabled: id !== undefined && !isPdf,
  })

  // pdf 交给浏览器。它的阅读器带搜索、翻页、缩放，重造一个不值当
  if (isPdf && item.url !== undefined) {
    return <iframe className="atc-pdf" src={item.url} title={item.name ?? 'PDF'} />
  }
  if (id === undefined) return <p className="atc-note">这个附件没有可预览的正文。</p>
  if (preview.isPending) return <p className="atc-note">正在读…</p>
  if (preview.isError) {
    return <p className="atc-note">读不出来：{preview.error.message}</p>
  }

  const data = preview.data
  if (data.kind === 'table') {
    const rows = data.rows ?? []
    if (rows.length === 0) return <p className="atc-note">这张表是空的。</p>
    const [head, ...body] = rows
    return (
      <div className="atc-doc">
        {data.sheet !== undefined && data.sheet !== '' && (
          <div className="atc-sheet">工作表：{data.sheet}</div>
        )}
        <div className="atc-table-wrap">
          <table className="atc-table">
            <thead>
              <tr>
                {head.map((c, i) => (
                  <th key={i}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, ri) => (
                <tr key={ri}>
                  {head.map((_, ci) => (
                    <td key={ci}>{row[ci] ?? ''}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )
  }
  if (data.kind === 'markdown') {
    return (
      <div className="atc-doc atc-md">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{data.text ?? ''}</ReactMarkdown>
      </div>
    )
  }
  if (data.kind === 'text') {
    return (
      <div className="atc-doc">
        <pre className="atc-pre">{data.text}</pre>
      </div>
    )
  }
  return (
    <div className="atc-preview-file">
      <FileText />
      <strong>{item.name ?? '附件'}</strong>
      <p className="atc-note">
        这个格式读不出正文（Office 的 doc/ppt、设计稿这类是打包格式）。
        规划时它只会以文件名的形式告诉模型"用户带了这个"。
      </p>
      {item.url !== undefined && (
        <a className="btn btn-primary btn-sm" href={item.url} download={item.name}>
          下载文件
        </a>
      )}
    </div>
  )
}

/** 附件预览。图片放大看，音视频能播，文档渲染正文。 */
export function AttachPreview({
  item,
  onClose,
}: {
  item: CanvasItem
  onClose: () => void
}): JSX.Element {
  const name = item.name ?? '附件'
  const src = itemSrc(item, 'full')
  return (
    <Overlay onClose={onClose} card="atc-preview" labelledBy="atc-preview-title">
      <header className="atc-preview-head">
        <div>
          <h3 id="atc-preview-title">{name}</h3>
          <span className="atc-preview-sub">{item.mime ?? item.kind}</span>
        </div>
        <span className="atc-preview-act">
          {item.url !== undefined && (
            <a className="btn btn-outline btn-sm" href={item.url} download={name}>
              下载
            </a>
          )}
          <button className="btn btn-ghost-sm" aria-label="关闭" onClick={onClose}>
            <X />
          </button>
        </span>
      </header>
      <div className="atc-preview-body">
        {item.kind === 'image' ? (
          <img src={src} alt={name} />
        ) : item.kind === 'video' ? (
          <video src={item.url} poster={item.poster_url ?? undefined} controls autoPlay playsInline />
        ) : item.kind === 'audio' ? (
          <audio src={item.url} controls autoPlay />
        ) : (
          <DocBody item={item} />
        )}
      </div>
    </Overlay>
  )
}

/** 附件条。`onChange` 为空 = 只读（成套弹窗里就是只读的：那边是"带了什么"的清单，
 *  要增删回输入框改，两个地方都能改的话用户不知道哪边是准的） */
export function AttachStrip({
  items,
  onChange,
  compact,
}: {
  items: CanvasItem[]
  onChange?: (next: CanvasItem[]) => void
  compact?: boolean
}): JSX.Element | null {
  const [preview, setPreview] = useState<CanvasItem | null>(null)
  if (items.length === 0) return null
  return (
    <>
      <div className={compact === true ? 'atc-strip atc-strip-compact' : 'atc-strip'}>
        {items.map((item, i) => (
          <AttachChip
            key={`${item.asset_id ?? item.media_asset_id ?? item.url ?? ''}-${i}`}
            item={item}
            onOpen={() => setPreview(item)}
            onRemove={
              onChange === undefined
                ? undefined
                : () => onChange(items.filter((_, at) => at !== i))
            }
          />
        ))}
      </div>
      {preview !== null && <AttachPreview item={preview} onClose={() => setPreview(null)} />}
    </>
  )
}

/** 回形针按钮。`accept` 不设限——用户说"gpt 那种支持上传的都可以带着" */
export function AttachButton({
  onPick,
  busy,
  disabled,
}: {
  onPick: (files: File[]) => void
  busy?: boolean
  disabled?: boolean
}): JSX.Element {
  const [key, setKey] = useState(0)
  return (
    <label className="atc-btn nodrag" title="带上图片、文档或其它文件">
      <input
        key={key}
        type="file"
        multiple
        hidden
        disabled={disabled === true || busy === true}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          // 换 key 重建 input：不换的话选同一个文件第二次不触发 change
          setKey((n) => n + 1)
          if (files.length > 0) onPick(files)
        }}
      />
      <Paperclip />
      {busy === true ? '上传中…' : '附件'}
    </label>
  )
}
