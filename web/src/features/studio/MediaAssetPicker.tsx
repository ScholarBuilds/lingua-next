import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { Overlay } from '../../components/Overlay'
import { IconClose, IconFileText, IconSpeaker, IconVideo } from '../../components/icons'
import { apiStudio } from '../../lib/api-studio'
import type { StudioMediaAsset } from '../../lib/api-studio'

export function MediaAssetPicker({
  kind: initialKind = 'video',
  onClose,
  onPick,
}: {
  kind?: StudioMediaAsset['kind']
  onClose: () => void
  onPick: (asset: StudioMediaAsset) => void
}) {
  const [kind, setKind] = useState<StudioMediaAsset['kind']>(initialKind)
  const label = kind === 'video' ? '视频' : kind === 'audio' ? '音频' : '文件'
  const assets = useQuery({
    queryKey: ['studio-picker-media', kind],
    queryFn: () => apiStudio.mediaAssets({ kind, limit: 120 }),
  })

  return (
    <Overlay onClose={onClose} card="scv-picker" labelledBy="scv-media-picker-title">
      <header className="scv-picker-head">
        <h3 id="scv-media-picker-title">添加{label}资产</h3>
        <span className="scv-picker-sub">生成任务、工作流和本地导入的结果都会出现在这里</span>
        <div className="scv-tabs" aria-label="媒体类型">
          {(['video', 'audio', 'file'] as const).map((value) => (
            <button
              key={value}
              className={kind === value ? 'scv-tab scv-tab-on' : 'scv-tab'}
              onClick={() => setKind(value)}
            >
              {value === 'video' ? '视频' : value === 'audio' ? '音频' : '文件'}
            </button>
          ))}
        </div>
        <button className="btn-ghost-sm" aria-label="关闭" onClick={onClose}>
          <IconClose />
        </button>
      </header>
      <div className="scv-picker-body">
        {assets.isPending && <p className="scv-picker-note">载入{label}资产…</p>}
        {assets.isError && (
          <p className="scv-picker-note">
            {label}资产加载失败：{assets.error instanceof Error ? assets.error.message : '未知错误'}
          </p>
        )}
        {assets.data !== undefined && assets.data.items.length === 0 && (
          <p className="scv-picker-note">还没有{label}资产；可以从本机拖入或用顶部“导入素材”</p>
        )}
        {assets.data !== undefined && assets.data.items.length > 0 && (
          <div className="scv-picker-grid">
            {assets.data.items.map((asset) => (
              <button
                key={asset.id}
                className="scv-picker-cell scv-picker-media"
                title={asset.name}
                onClick={() => {
                  onPick(asset)
                  onClose()
                }}
              >
                {kind === 'video' && asset.poster_url !== null ? (
                  <img src={asset.poster_url} alt="" loading="lazy" />
                ) : (
                  <span className="scv-picker-media-icon">
                    {kind === 'video' ? <IconVideo /> : kind === 'audio' ? <IconSpeaker /> : <IconFileText />}
                  </span>
                )}
                <span>{asset.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Overlay>
  )
}
