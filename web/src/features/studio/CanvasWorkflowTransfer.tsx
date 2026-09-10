import { useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { toast } from 'sonner'

import { Overlay } from '../../components/Overlay'
import { apiStudio } from '../../lib/api-studio'
import type {
  CanvasConnection,
  CanvasNode,
  CanvasWorkflowImportResult,
} from '../../lib/api-studio'
import { saveFile } from '@/lib/shell'

export function CanvasWorkflowTransfer({
  title,
  nodes,
  connections,
  onImport,
  onClose,
}: {
  title: string
  nodes: CanvasNode[]
  connections: CanvasConnection[]
  onImport: (result: CanvasWorkflowImportResult) => void
  onClose: () => void
}) {
  const [busy, setBusy] = useState<'json' | 'zip' | 'library' | 'import' | null>(null)
  const [targetFormat, setTargetFormat] = useState<
    'lingua-canvas-workflow' | 'infinite-canvas-workflow'
  >('lingua-canvas-workflow')
  const [libraryResult, setLibraryResult] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const download = async (includeResources: boolean) => {
    const kind = includeResources ? 'zip' : 'json'
    setBusy(kind)
    try {
      const result = await apiStudio.exportCanvasWorkflow({
        nodes,
        connections,
        include_resources: includeResources,
        filename: `${title || '未命名画布'}-工作流`,
        target_format: targetFormat,
      })
      saveFile(result.blob, result.filename)
      const formatText = targetFormat === 'infinite-canvas-workflow' ? 'Infinite-Canvas' : 'Lingua'
      toast.success(includeResources ? `已导出 ${formatText} 资源 ZIP` : `已导出 ${formatText} 工作流 JSON`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导出失败')
    } finally {
      setBusy(null)
    }
  }

  const saveToLibrary = async () => {
    if (nodes.length === 0) return
    setBusy('library')
    setLibraryResult(null)
    try {
      const saved = await apiStudio.saveTemplate({
        name: `${title || '未命名画布'}-工作流`,
        note: '从画布选区资产化',
        nodes,
        connections,
        include_resources: true,
      })
      setLibraryResult(saved.name)
      toast.success(`已保存到工作流资产库：${saved.name}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存到工作流资产库失败')
    } finally {
      setBusy(null)
    }
  }

  const importFile = async (file: File) => {
    if (!/\.(?:json|zip)$/i.test(file.name)) {
      toast.error('请选择 JSON 或 ZIP 工作流文件')
      return
    }
    setBusy('import')
    try {
      const result = await apiStudio.importCanvasWorkflow(file)
      onImport(result)
      const resourceText =
        result.rebuilt > 0 || result.reused > 0
          ? `；复用 ${result.reused}、重建 ${result.rebuilt} 个资源`
          : ''
      const missingText = result.missing.length > 0 ? `；${result.missing.length} 个资源缺失` : ''
      toast.success(`已导入 ${result.nodes.length} 个节点${resourceText}${missingText}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导入失败')
    } finally {
      setBusy(null)
    }
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    const file = event.dataTransfer.files[0]
    if (file !== undefined) void importFile(file)
  }

  return (
    <Overlay onClose={onClose} card="scv-transfer" labelledBy="scv-transfer-title">
      <header className="scv-picker-head">
        <div>
          <h3 id="scv-transfer-title">导入 / 导出工作流</h3>
          <span className="scv-picker-sub">只处理当前选中的节点与它们之间的连线</span>
        </div>
        <button className="btn-ghost-sm" aria-label="关闭" onClick={onClose}>×</button>
      </header>

      <section className="scv-transfer-card">
        <div>
          <strong>导出当前子图</strong>
          <span>{nodes.length === 0 ? '还没有选择节点' : `${nodes.length} 个节点 · ${connections.length} 条连线`}</span>
        </div>
        <label className="scv-transfer-format">
          <span>导出格式</span>
          <select
            value={targetFormat}
            disabled={busy !== null}
            onChange={(event) => setTargetFormat(event.target.value as typeof targetFormat)}
          >
            <option value="lingua-canvas-workflow">Lingua 可移植格式</option>
            <option value="infinite-canvas-workflow">Infinite-Canvas 兼容格式</option>
          </select>
        </label>
        <div className="scv-transfer-actions">
          <button
            className="btn btn-outline"
            disabled={nodes.length === 0 || busy !== null}
            onClick={() => void download(false)}
          >
            {busy === 'json' ? '导出中…' : '导出 JSON'}
          </button>
          <button
            className="btn btn-primary"
            disabled={nodes.length === 0 || busy !== null}
            onClick={() => void download(true)}
          >
            {busy === 'zip' ? '打包中…' : '导出并包含资源'}
          </button>
          <button
            className="btn btn-primary"
            disabled={nodes.length === 0 || busy !== null}
            onClick={() => void saveToLibrary()}
          >
            {busy === 'library' ? '保存中…' : libraryResult === null ? '保存到工作流库' : '已保存到工作流库'}
          </button>
        </div>
        <p>
          JSON 适合检查结构；ZIP 会携带图片、视频、音频和文件原始字节。Infinite-Canvas
          格式可直接导入源项目，跨项目迁移素材时请选择 ZIP。
        </p>
      </section>

      <section className="scv-transfer-card">
        <div>
          <strong>导入到当前画布</strong>
          <span>节点会追加到当前视口，原有内容不受影响</span>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".json,.zip,application/json,application/zip"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file !== undefined) void importFile(file)
            event.target.value = ''
          }}
        />
        <div
          className={`scv-transfer-drop${dragging ? ' is-dragging' : ''}`}
          onDragOver={(event) => {
            event.preventDefault()
            event.dataTransfer.dropEffect = 'copy'
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <span>{busy === 'import' ? '正在校验并导入…' : '拖入工作流 JSON / ZIP'}</span>
          <button className="btn btn-outline" disabled={busy !== null} onClick={() => inputRef.current?.click()}>
            选择文件
          </button>
        </div>
      </section>
    </Overlay>
  )
}
