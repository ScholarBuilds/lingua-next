import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, ExternalLink, Layers3, Pencil, Trash2, Upload } from '@/components/NexusIcon'
import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

import { apiStudio } from '../../lib/api-studio'
import { saveFile } from '@/lib/shell'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误'
}

function downloadResult(result: { blob: Blob; filename: string }): void {
  saveFile(result.blob, result.filename)
}

export function WorkflowAssetLibrary() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [selected, setSelected] = useState<Set<number>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const list = useQuery({ queryKey: ['swt-templates'], queryFn: () => apiStudio.templates() })
  const items = list.data?.items ?? []

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['swt-templates'] })
  }

  const upload = async (files: FileList) => {
    if (busy || files.length === 0) return
    setBusy(true)
    let added = 0
    try {
      for (const file of Array.from(files).slice(0, 100)) {
        await apiStudio.importTemplate(file)
        added += 1
      }
      await refresh()
      toast.success(`已导入 ${added} 个工作流资产`)
    } catch (error) {
      await refresh()
      toast.error(`${added > 0 ? `已导入 ${added} 个；` : ''}${errorText(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const download = async (ids: number[]) => {
    if (busy || ids.length === 0) return
    setBusy(true)
    try {
      downloadResult(
        ids.length === 1
          ? await apiStudio.downloadTemplate(ids[0])
          : await apiStudio.downloadTemplates(ids),
      )
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  const rename = async (id: number, current: string) => {
    const name = window.prompt('工作流资产名称', current)?.trim()
    if (!name || name === current || busy) return
    setBusy(true)
    try {
      await apiStudio.renameTemplate(id, name)
      await refresh()
      toast.success(`已重命名为「${name}」`)
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (ids: number[]) => {
    if (busy || ids.length === 0) return
    if (!window.confirm(`删除所选 ${ids.length} 个工作流资产？已应用到画布的节点不受影响。`)) {
      return
    }
    setBusy(true)
    try {
      for (const id of ids) await apiStudio.deleteTemplate(id)
      setSelected(new Set())
      await refresh()
      toast.success(`已删除 ${ids.length} 个工作流资产`)
    } catch (error) {
      await refresh()
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="wfc-assets" aria-labelledby="wfc-assets-title">
      <header>
        <div className="wfc-section-title">
          <Layers3 aria-hidden />
          <div>
            <h2 id="wfc-assets-title">可携带工作流资产</h2>
            <p>管理画布子图 JSON/ZIP；ZIP 可随包保存图片、视频、音频和文件。</p>
          </div>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".json,.zip,application/json,application/zip"
          multiple
          hidden
          onChange={(event) => {
            if (event.target.files) void upload(event.target.files)
            event.target.value = ''
          }}
        />
        <button className="btn btn-outline" disabled={busy} onClick={() => inputRef.current?.click()}>
          <Upload />导入 JSON/ZIP
        </button>
        <button
          className="btn btn-outline"
          disabled={busy || selected.size === 0}
          onClick={() => void download([...selected])}
        >
          <Download />导出所选{selected.size > 0 ? ` ${selected.size}` : ''}
        </button>
        <button
          className="btn btn-outline wfc-assets-danger"
          disabled={busy || selected.size === 0}
          onClick={() => void remove([...selected])}
        >
          <Trash2 />删除所选
        </button>
        <button className="btn btn-soft" onClick={() => navigate('/studio/canvas')}>
          <ExternalLink />到画布应用
        </button>
      </header>

      {list.isPending && <p className="wfc-empty">正在读取工作流资产…</p>}
      {list.isError && <p className="wfc-error">读取失败：{list.error.message}</p>}
      {!list.isPending && !list.isError && items.length === 0 && (
        <p className="wfc-empty">还没有工作流资产。可导入 JSON/ZIP，或在画布中选中子图后保存。</p>
      )}
      {items.length > 0 && (
        <div className="wfc-assets-grid">
          {items.map((item) => (
            <article key={item.id} className={selected.has(item.id) ? 'is-selected' : ''}>
              <label>
                <input
                  type="checkbox"
                  checked={selected.has(item.id)}
                  onChange={(event) => {
                    setSelected((current) => {
                      const next = new Set(current)
                      if (event.target.checked) next.add(item.id)
                      else next.delete(item.id)
                      return next
                    })
                  }}
                />
                <Layers3 aria-hidden />
                <span>
                  <strong>{item.name}</strong>
                  <small>
                    {item.node_count} 节点 · {item.packaged
                      ? `${item.resource_count} 个随包资源`
                      : `${item.asset_count} 个指纹资源`}
                  </small>
                </span>
              </label>
              <div>
                <button title="下载工作流资产" disabled={busy} onClick={() => void download([item.id])}>
                  <Download />
                </button>
                <button title="重命名工作流资产" disabled={busy} onClick={() => void rename(item.id, item.name)}>
                  <Pencil />
                </button>
                <button title="删除工作流资产" disabled={busy} onClick={() => void remove([item.id])}>
                  <Trash2 />
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
