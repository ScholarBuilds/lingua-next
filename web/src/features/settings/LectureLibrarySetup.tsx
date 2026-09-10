import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'

import { docsApi } from '../../lib/api-grammar-docs'
import type { DocCollection } from '../../lib/api-grammar-docs'
import { hasShell, selectDirectory } from '../../lib/shell'

export function LectureLibrarySetup({ compact = false, collection = 'grammar' }: { compact?: boolean; collection?: DocCollection }) {
  const queryClient = useQueryClient()
  const [sourcePath, setSourcePath] = useState('')
  const status = useQuery({ queryKey: ['grammar-library', collection], queryFn: () => docsApi.library(collection) })
  const importMutation = useMutation({
    mutationFn: (source: string) => docsApi.importLibrary(source, collection),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['grammar-library'] })
      void queryClient.invalidateQueries({ queryKey: ['glib-tree'] })
      if (result.conflicts.length > 0) {
        toast.warning(`已导入 ${result.copied} 篇，${result.conflicts.length} 篇同名讲义未覆盖`)
      } else {
        toast.success(`已导入 ${result.copied} 篇讲义`)
      }
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const choose = async () => {
    const selected = await selectDirectory()
    if (selected !== null) setSourcePath(selected)
  }

  return (
    <div className={compact ? 'lecture-setup lecture-setup-compact' : 'card pref-card lecture-setup'}>
      <div className="pref-row lecture-setup-status">
        <div className="pref-info">
          <div className="pref-name">
            {status.data?.documents ? `${status.data.documents} 篇讲义` : '尚未导入讲义'}
          </div>
          <div className="pref-desc">
            {status.data?.root ?? '正在读取 NEXUS 讲义目录…'}
          </div>
        </div>
      </div>
      <div className="lecture-setup-controls">
        <label className="form-field lecture-source-field">
          <span>旧讲义目录</span>
          <input
            value={sourcePath}
            placeholder="选择包含 Markdown 讲义的目录"
            onChange={(event) => setSourcePath(event.target.value)}
          />
        </label>
        <div className="form-actions">
          {hasShell() && (
            <button type="button" className="btn btn-outline" onClick={() => void choose()}>
              选择目录
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={sourcePath.trim() === '' || importMutation.isPending}
            onClick={() => importMutation.mutate(sourcePath.trim())}
          >
            {importMutation.isPending ? '导入中…' : '导入副本'}
          </button>
        </div>
      </div>
      <div className="pref-desc lecture-setup-note">
        只复制可用的 Markdown 文件，不删除旧目录；归档、隐藏目录和已有同名讲义不会被覆盖。
      </div>
    </div>
  )
}
