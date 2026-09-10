/* 素材详情侧栏：大图 + 元信息 + 打标结果 + 归属/收藏/下载。

   侧栏不是 <Overlay> 结构，但必须与它共用同一个浮层栈，否则 Esc 会把详情和
   底下的弹层一起关掉（Overlay.tsx 里记的坑）。 */

import { useState } from 'react'
import { Pencil } from '@/components/NexusIcon'
import { toast } from 'sonner'

import { useEscapeClose } from '../../components/Overlay'
import { IconAlert, IconClose, IconDownload, IconSparkle, IconStar } from '../../components/icons'
import { Picker } from '@/components/ui/picker'
import { apiImage } from '../../lib/api-image'
import type { ImageAsset } from '../../lib/api-image'
import type { AssetGroup } from '../../lib/api-studio'

function fmtBytes(n: number): string {
  if (n <= 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function fmtTime(iso: string | null): string {
  if (iso === null) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** 库 → 文件夹两级，下拉里用缩进表示层级 */
function groupOptions(groups: AssetGroup[]): { id: number; label: string }[] {
  const out: { id: number; label: string }[] = []
  for (const lib of groups.filter((g) => g.parent_id === null)) {
    out.push({ id: lib.id, label: lib.name })
    for (const sub of groups.filter((g) => g.parent_id === lib.id)) {
      out.push({ id: sub.id, label: `　└ ${sub.name}` })
    }
  }
  return out
}

export function AssetDetailPanel({
  asset,
  groups,
  groupsError,
  tagging,
  tagFailReason,
  onClose,
  onTag,
  onMove,
  onPatched,
  onArchive,
}: {
  asset: ImageAsset
  groups: AssetGroup[]
  /** 分组接口没通时的原文，用来说明「归属改不了」的具体原因 */
  groupsError: string | null
  tagging: boolean
  tagFailReason: string | undefined
  onClose: () => void
  onTag: (ids: number[]) => void
  onMove: (ids: number[], groupId: number | null) => void
  onPatched: (next: ImageAsset) => void
  onArchive: (id: number, archived: boolean) => void
}) {
  const [favBusy, setFavBusy] = useState(false)
  const [renameBusy, setRenameBusy] = useState(false)
  useEscapeClose(onClose)

  const toggleFav = async () => {
    if (favBusy) return
    setFavBusy(true)
    try {
      const next = await apiImage.patchAsset(asset.id, { favorite: !asset.favorite })
      onPatched(next)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '收藏失败')
    } finally {
      setFavBusy(false)
    }
  }

  const rename = async () => {
    const name = window.prompt('素材名称', asset.display_name ?? `素材 ${asset.id}`)?.trim()
    if (name === undefined || name === (asset.display_name ?? '') || renameBusy) return
    setRenameBusy(true)
    try {
      const next = await apiImage.patchAsset(asset.id, { display_name: name || null })
      onPatched(next)
      toast.success(name ? `已重命名为「${name}」` : '已清除素材名称')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '重命名失败')
    } finally {
      setRenameBusy(false)
    }
  }

  const options = groupOptions(groups)

  return (
    <aside className="sal-detail" aria-label="素材详情">
      <header className="sal-detail-head">
        <h2>{asset.display_name || `素材 #${asset.id}`}</h2>
        <button className="icon-btn" disabled={renameBusy} aria-label="重命名素材" onClick={() => void rename()}>
          <Pencil />
        </button>
        <button className="icon-btn" aria-label="关闭详情" onClick={onClose}>
          <IconClose />
        </button>
      </header>

      <div className="sal-detail-body">
        <img className="sal-detail-img" src={asset.url} alt={asset.caption ?? ''} />

        <dl className="sal-meta">
          <dt>尺寸</dt>
          <dd>
            {asset.width} × {asset.height}
          </dd>
          <dt>体积</dt>
          <dd>
            {fmtBytes(asset.bytes)} · {asset.mime}
          </dd>
          <dt>来源</dt>
          <dd>
            {asset.source}
            {asset.op !== null && ` · ${asset.op}`}
          </dd>
          <dt>模型</dt>
          <dd>{asset.model ?? '未记录'}</dd>
          <dt>加入</dt>
          <dd>{fmtTime(asset.created_at)}</dd>
          {asset.prompt !== '' && (
            <>
              <dt>提示词</dt>
              <dd title={asset.prompt}>{asset.prompt}</dd>
            </>
          )}
        </dl>

        <div>
          <div className="sal-sec-title">所属分组</div>
          <Picker
            size="sm"
            className="sal-sel"
            value={asset.group_id === null ? 'none' : String(asset.group_id)}
            disabled={groupsError !== null}
            /* 'none' 而不是空串：Radix Select 拿空串表示"清空"，
               当选项值会被它当成没选中，界面上显示 placeholder */
            onChange={(v) => onMove([asset.id], v === 'none' ? null : Number(v))}
            options={[
              { value: 'none', label: '未归组' },
              ...options.map((o) => ({ value: String(o.id), label: o.label })),
            ]}
          />
          {groupsError !== null && (
            <p className="sal-fail">分组接口没通，归属改不了：{groupsError}</p>
          )}
          {groupsError === null && options.length === 0 && (
            <p className="sal-untagged">还没有建过分组，先在左栏「新建库」。</p>
          )}
        </div>

        <div>
          <div className="sal-sec-title">AI 打标</div>
          {tagFailReason !== undefined && (
            <p className="sal-fail">
              <IconAlert /> 上次打标失败：{tagFailReason}
            </p>
          )}
          {asset.tagged_at === null && asset.tags.length === 0 ? (
            <p className="sal-untagged">还没打标。打标会让这张图能按中文标签检索。</p>
          ) : (
            <>
              {asset.caption !== null && asset.caption !== '' && (
                <p className="sal-cap">{asset.caption}</p>
              )}
              {asset.tags.length > 0 && (
                <div className="sal-taglist">
                  {asset.tags.map((t) => (
                    <span key={t} className="sal-chip">
                      {t}
                    </span>
                  ))}
                </div>
              )}
              {asset.caption === null && asset.tags.length === 0 && (
                <p className="sal-untagged">打过标，但这张没产出摘要与标签。</p>
              )}
            </>
          )}
        </div>
      </div>

      <div className="sal-detail-acts">
        <button
          className={tagging ? 'btn btn-soft loading' : 'btn btn-soft'}
          onClick={() => onTag([asset.id])}
        >
          {tagging ? <span className="spinner" /> : <IconSparkle />}
          {tagging ? '打标中…' : tagFailReason !== undefined ? '重试打标' : 'AI 打标'}
        </button>
        <button className="btn" disabled={favBusy} onClick={() => void toggleFav()}>
          <IconStar filled={asset.favorite} />
          {asset.favorite ? '取消收藏' : '收藏'}
        </button>
        <a className="btn" href={asset.full_url} download={`asset-${asset.id}`}>
          <IconDownload />
          下载原图
        </a>
        <button className="btn" onClick={() => onArchive(asset.id, asset.status !== 'archived')}>
          {asset.status === 'archived' ? '恢复' : '归档'}
        </button>
      </div>
    </aside>
  )
}
