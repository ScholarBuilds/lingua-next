/* 工坊单图工具页的公共外壳：页头 + 下载助手。

   原先这两件东西从 EnhancePage 导出、被 AnglePage import，代价是角度控制页的 chunk
   会把整个增强页（对比滑块、尺寸自证、catalog 查询）一并拖进来——两页各自独立路由，
   谁也不该为对方的代码买单。搬到这个只放公共件的文件里，两边各取所需。

   行为与搬家前逐字一致，没有顺手改动。 */

import type { ReactNode } from 'react'
import { ImagePlus } from '@/components/NexusIcon'

import type { ImageAsset } from '../../lib/api-image'

import './studio-tools.css'
import { saveFile } from '@/lib/shell'

/** 两个工具页共用的薄页头 */
export function ToolHeader({
  icon,
  title,
  sub,
  hasImage = false,
  onPickImage,
}: {
  icon: ReactNode
  title: string
  sub: string
  hasImage?: boolean
  onPickImage?: () => void
}): JSX.Element {
  return (
    <header className="stl-head">
      <span className="stl-head-icon">{icon}</span>
      <div className="stl-head-text">
        <h1>{title}</h1>
        <p className="stl-head-sub">{sub}</p>
      </div>
      <div className="stl-head-acts">
        {onPickImage !== undefined ? (
          <button className="btn btn-outline" onClick={onPickImage}>
            <ImagePlus />
            {hasImage ? '换一张图' : '选一张图'}
          </button>
        ) : null}
      </div>
    </header>
  )
}

/** 下载原图。走 blob 而不是 `<a download>`，失败时才拿得到具体状态码 */
export async function downloadAsset(asset: ImageAsset): Promise<void> {
  const resp = await fetch(asset.full_url)
  if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}`)
  saveFile(await resp.blob(), `image-${asset.id}.${asset.mime.split('/')[1] ?? 'png'}`)
  // 立刻 revoke 会掐断还没落盘的下载
}
