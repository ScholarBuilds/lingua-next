/* 选图弹层：资产库点选 / 本地上传。工坊所有需要「先挑一张图」的工具共用这一个
   （画布 FR-461、细节增强 FR-474、角度控制 FR-475）。

   上传走 /images/local（op=upload，source=local），与纯前端修图共用
   一条入库通路——工坊不另建文件存储（BR-140）。 */

import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'

import { Overlay } from '../../components/Overlay'
import { IconClose, IconUpload } from '../../components/icons'
import { apiImage } from '../../lib/api-image'
import type { ImageAsset } from '../../lib/api-image'

type Tab = 'assets' | 'upload'

export function AssetPicker({
  onClose,
  onPick,
}: {
  onClose: () => void
  onPick: (asset: ImageAsset) => void
}) {
  const [tab, setTab] = useState<Tab>('assets')
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const assets = useQuery({
    queryKey: ['studio-picker-assets'],
    queryFn: () => apiImage.assets({ limit: 120 }),
    enabled: tab === 'assets',
  })

  const upload = async (files: FileList) => {
    setUploading(true)
    try {
      for (const file of Array.from(files)) {
        const form = new FormData()
        form.set('image', file)
        form.set('op', 'upload')
        const row = await apiImage.saveLocal(form)
        onPick(row)
      }
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '上传失败')
    } finally {
      setUploading(false)
    }
  }

  return (
    <Overlay onClose={onClose} card="scv-picker" labelledBy="scv-picker-title">
      <header className="scv-picker-head">
        <h3 id="scv-picker-title">添加图片</h3>
        <div className="scv-tabs">
          <button className={tab === 'assets' ? 'scv-tab scv-tab-on' : 'scv-tab'} onClick={() => setTab('assets')}>
            资产库
          </button>
          <button className={tab === 'upload' ? 'scv-tab scv-tab-on' : 'scv-tab'} onClick={() => setTab('upload')}>
            本地上传
          </button>
        </div>
        <button className="btn-ghost-sm" aria-label="关闭" onClick={onClose}>
          <IconClose />
        </button>
      </header>

      {tab === 'assets' && (
        <div className="scv-picker-body">
          {assets.isLoading && <p className="scv-picker-note">载入资产…</p>}
          {assets.isError && (
            <p className="scv-picker-note">
              资产列表加载失败：{assets.error instanceof Error ? assets.error.message : '未知错误'}
            </p>
          )}
          {assets.data !== undefined && assets.data.items.length === 0 && (
            <p className="scv-picker-note">资产库还是空的，先去生图或本地上传一张</p>
          )}
          {assets.data !== undefined && assets.data.items.length > 0 && (
            <div className="scv-picker-grid">
              {assets.data.items.map((a) => (
                <button
                  key={a.id}
                  className="scv-picker-cell"
                  title={a.prompt}
                  onClick={() => {
                    onPick(a)
                    onClose()
                  }}
                >
                  <img src={a.thumb_url} alt="" loading="lazy" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'upload' && (
        <div className="scv-picker-body scv-picker-upload">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files !== null && e.target.files.length > 0) void upload(e.target.files)
              e.target.value = ''
            }}
          />
          <button
            className="btn btn-primary"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
          >
            <IconUpload />
            {uploading ? '上传中…' : '选择图片（可多选）'}
          </button>
          <p className="scv-picker-note">上传即入资产库（source=local，不计生成用量），随后落为画布节点</p>
        </div>
      )}
    </Overlay>
  )
}
