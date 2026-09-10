/* 工作流模板（模块 17 FR-482 · M4）：把画布上选中的子图存成模板，以后一键追加回来。

   两个浮层，都由画布顶栏调起：
   - `SaveTemplateDialog` 打包当前选中的节点与连线
   - `TemplatePicker` 列模板、应用、删除

   应用回来时最要紧的一件事是**如实交代图去哪了**。模板按 sha256 引资产，
   库里还在的直接复用，不在的服务端也变不出来——差多少张就说差多少张，
   绝不把「跳过了 3 张」画成「全部成功」（BR-110）。

   样式挂在 studio-tools.css：这两个浮层是工坊的工具件，不是画布本身的一部分，
   放进 canvas.css 会让画布样式表继续膨胀。 */

import { useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { AlertTriangle, Check, Download, Layers, Pencil, Trash2, Upload, X } from '@/components/NexusIcon'

import { Overlay } from '../../components/Overlay'
import { apiStudio } from '../../lib/api-studio'
import type {
  CanvasConnection,
  CanvasNode,
  TemplateImportResult,
  WorkflowTemplate,
} from '../../lib/api-studio'

import './studio-tools.css'
import { saveFile } from '@/lib/shell'

function errText(e: unknown): string {
  return e instanceof Error ? e.message : '未知错误'
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function downloadResult(result: { blob: Blob; filename: string }): void {
  saveFile(result.blob, result.filename)
}

/* ==================== 存模板 ==================== */

export function SaveTemplateDialog({
  nodes,
  connections,
  onDone,
  onClose,
}: {
  nodes: CanvasNode[]
  connections: CanvasConnection[]
  onDone: (template: WorkflowTemplate) => void
  onClose: () => void
}): JSX.Element {
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement | null>(null)
  const noteRef = useRef<HTMLTextAreaElement | null>(null)

  // 图分两种：已入库的有 asset_id，能按 sha 引；外链只有 url，没进过资产库
  const shot = useMemo(() => {
    const items = nodes.flatMap((n) => n.items ?? [])
    return {
      stored: items.filter((i) => i.asset_id !== undefined).length,
      external: items.filter((i) => i.asset_id === undefined).length,
    }
  }, [nodes])

  const dirty = name !== '' || note !== ''

  // 带输入框的两段式 Esc（STD-UI-002b）：正在打字的第一下只失焦，不关窗
  const requestClose = (): void => {
    const active = document.activeElement
    if (dirty && (active === nameRef.current || active === noteRef.current)) {
      ;(active as HTMLElement).blur()
      return
    }
    onClose()
  }

  const submit = async (): Promise<void> => {
    const title = name.trim()
    if (title === '' || saving) return
    setSaving(true)
    setFailed(null)
    try {
      const tpl = await apiStudio.saveTemplate({
        name: title,
        note: note.trim(),
        nodes,
        connections,
      })
      toast.success(`模板「${tpl.name}」已存：${tpl.node_count} 个节点、${tpl.asset_count} 张图`)
      onDone(tpl)
    } catch (e) {
      // 原文照抄，不换成「保存失败，请重试」这种什么也没说的话
      setFailed(errText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Overlay onClose={requestClose} card="swt-dialog" labelledBy="swt-save-title">
      <div className="overlay-head">
        <span className="overlay-title" id="swt-save-title">
          存成工作流模板
        </span>
        <button className="btn-ghost-sm" title="关闭" onClick={onClose}>
          <X />
        </button>
      </div>

      <p className="swt-sum">
        这次打包 <strong>{nodes.length}</strong> 个节点、<strong>{connections.length}</strong>{' '}
        条连线，其中引用资产的图 <strong>{shot.stored}</strong> 张
        {shot.external > 0 && <>，另有 {shot.external} 张外链图（没有资产 id）</>}。
      </p>

      <label className="swt-label" htmlFor="swt-name">
        模板名
      </label>
      <input
        id="swt-name"
        ref={nameRef}
        className="swt-input"
        value={name}
        autoFocus
        placeholder="比如：三视图出图链"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) void submit()
        }}
      />

      <label className="swt-label" htmlFor="swt-note">
        说明（可留空）
      </label>
      <textarea
        id="swt-note"
        ref={noteRef}
        className="swt-area"
        rows={3}
        placeholder="这套链子是干什么的、怎么用"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />

      {failed !== null && (
        <p className="swt-fail">
          <AlertTriangle />
          <span>存模板失败：{failed}</span>
        </p>
      )}

      <div className="swt-foot">
        <span className="swt-hint">模板按资产 sha256 引图，不复制文件字节</span>
        <button className="btn btn-outline" onClick={onClose}>
          取消
        </button>
        <button
          className="btn btn-primary"
          disabled={name.trim() === '' || saving}
          onClick={() => void submit()}
        >
          {saving ? '正在存…' : '存模板'}
        </button>
      </div>
    </Overlay>
  )
}

/* ==================== 取模板 ==================== */

/** 一次应用的结果 */
interface ApplyOutcome {
  templateName: string
  result: TemplateImportResult
}

/** 数「库里找不到、这次没落回来」的图。
 *
 *  别拿 `asset_count - reused - rebuilt` 去减：实测（2026-08-20，探针模板存一张真图 +
 *  一张不存在的 id）服务端**存模板时就只登记解析得到的资产**（asset_count=1 而不是 2），
 *  减出来恒为 0，缺图会被算没了。服务端是把落不回来的那一项原样带回来并打上
 *  `missing`，所以照着数它——契约里 CanvasItem 没声明这个可选键，这里按未知键读。 */
function countMissing(result: TemplateImportResult): number {
  return result.nodes
    .flatMap((n) => n.items ?? [])
    .filter((item) => (item as { missing?: boolean }).missing === true).length
}

export function TemplatePicker({
  onApply,
  onClose,
}: {
  onApply: (result: TemplateImportResult) => void
  onClose: () => void
}): JSX.Element {
  const list = useQuery({ queryKey: ['swt-templates'], queryFn: () => apiStudio.templates() })
  const [busyId, setBusyId] = useState<number | null>(null)
  const [confirmId, setConfirmId] = useState<number | null>(null)
  const [outcome, setOutcome] = useState<ApplyOutcome | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<number>>(() => new Set())
  const [libraryBusy, setLibraryBusy] = useState(false)
  const uploadRef = useRef<HTMLInputElement | null>(null)

  const items = list.data?.items ?? []

  const apply = async (tpl: WorkflowTemplate): Promise<void> => {
    if (busyId !== null) return
    setBusyId(tpl.id)
    setFailed(null)
    try {
      const result = await apiStudio.applyTemplate(tpl.id)
      onApply(result)
      setOutcome({ templateName: tpl.name, result })
    } catch (e) {
      setFailed(errText(e))
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (tpl: WorkflowTemplate): Promise<void> => {
    if (busyId !== null) return
    setBusyId(tpl.id)
    setFailed(null)
    try {
      await apiStudio.deleteTemplate(tpl.id)
      setSelected((current) => {
        const next = new Set(current)
        next.delete(tpl.id)
        return next
      })
      setConfirmId(null)
      await list.refetch()
      toast.success(`模板「${tpl.name}」已删。画布上已经应用过的节点不受影响`)
    } catch (e) {
      setFailed(errText(e))
    } finally {
      setBusyId(null)
    }
  }

  const rename = async (tpl: WorkflowTemplate): Promise<void> => {
    const name = window.prompt('工作流名称', tpl.name)?.trim()
    if (name === undefined || name === '' || name === tpl.name || busyId !== null) return
    setBusyId(tpl.id)
    setFailed(null)
    try {
      await apiStudio.renameTemplate(tpl.id, name)
      await list.refetch()
      toast.success(`已重命名为「${name}」`)
    } catch (e) {
      setFailed(errText(e))
    } finally {
      setBusyId(null)
    }
  }

  const download = async (ids: number[]): Promise<void> => {
    if (ids.length === 0 || libraryBusy) return
    setLibraryBusy(true)
    setFailed(null)
    try {
      downloadResult(
        ids.length === 1
          ? await apiStudio.downloadTemplate(ids[0])
          : await apiStudio.downloadTemplates(ids),
      )
    } catch (e) {
      setFailed(errText(e))
    } finally {
      setLibraryBusy(false)
    }
  }

  const upload = async (files: FileList): Promise<void> => {
    if (files.length === 0 || libraryBusy) return
    setLibraryBusy(true)
    setFailed(null)
    let added = 0
    try {
      for (const file of Array.from(files).slice(0, 100)) {
        await apiStudio.importTemplate(file)
        added += 1
      }
      await list.refetch()
      toast.success(`已导入 ${added} 个工作流资产`)
    } catch (e) {
      setFailed(`${added > 0 ? `已导入 ${added} 个；` : ''}${errText(e)}`)
      await list.refetch()
    } finally {
      setLibraryBusy(false)
    }
  }

  const removeSelected = async (): Promise<void> => {
    const ids = [...selected]
    if (ids.length === 0 || libraryBusy) return
    if (!window.confirm(`删除所选 ${ids.length} 个工作流资产？画布中已应用的节点不受影响。`)) return
    setLibraryBusy(true)
    setFailed(null)
    try {
      for (const id of ids) await apiStudio.deleteTemplate(id)
      setSelected(new Set())
      await list.refetch()
      toast.success(`已删除 ${ids.length} 个工作流资产`)
    } catch (e) {
      setFailed(errText(e))
      await list.refetch()
    } finally {
      setLibraryBusy(false)
    }
  }

  const missing = outcome === null ? 0 : countMissing(outcome.result)

  return (
    <Overlay onClose={onClose} card="swt-picker" labelledBy="swt-pick-title">
      <div className="overlay-head">
        <span className="overlay-title" id="swt-pick-title">
          工作流资产库
        </span>
        <button className="btn-ghost-sm" title="关闭" onClick={onClose}>
          <X />
        </button>
      </div>

      <div className="swt-library-tools">
        <input
          ref={uploadRef}
          type="file"
          accept=".json,.zip,application/json,application/zip"
          multiple
          hidden
          onChange={(event) => {
            const files = event.target.files
            if (files !== null) void upload(files)
            event.target.value = ''
          }}
        />
        <button
          className="btn btn-outline btn-sm"
          disabled={libraryBusy || busyId !== null}
          onClick={() => uploadRef.current?.click()}
        >
          <Upload /> 上传工作流
        </button>
        <button
          className="btn btn-outline btn-sm"
          disabled={selected.size === 0 || libraryBusy || busyId !== null}
          onClick={() => void download([...selected])}
        >
          <Download /> 导出所选{selected.size > 0 ? ` ${selected.size}` : ''}
        </button>
        <button
          className="btn btn-outline btn-sm swt-danger"
          disabled={selected.size === 0 || libraryBusy || busyId !== null}
          onClick={() => void removeSelected()}
        >
          <Trash2 /> 删除所选
        </button>
        <span>双击工作流即可追加到当前画布</span>
      </div>

      {outcome !== null && (
        <div className={missing > 0 ? 'swt-outcome swt-outcome-warn' : 'swt-outcome'}>
          <span className="swt-outcome-head">
            {missing > 0 ? <AlertTriangle /> : <Check />}
            「{outcome.templateName}」已追加到画布
          </span>
          <ul className="swt-outcome-list">
            <li>
              {outcome.result.nodes.length} 个节点、{outcome.result.connections.length} 条连线
              （id 已重映射，不会和现有节点撞）
            </li>
            <li>复用了 {outcome.result.reused} 张既有图</li>
            {outcome.result.rebuilt > 0 && <li>重建了 {outcome.result.rebuilt} 张</li>}
            {missing > 0 && (
              <li>
                <strong>{missing} 张在库里找不到，已跳过</strong>
                ——那几个位置留着空位，不会拿别的图顶上
              </li>
            )}
          </ul>
        </div>
      )}

      {failed !== null && (
        <p className="swt-fail">
          <AlertTriangle />
          <span>{failed}</span>
        </p>
      )}

      <div className="swt-list">
        {list.isPending && <p className="swt-empty">读取模板…</p>}
        {list.isError && <p className="swt-empty swt-empty-err">模板列表读不出来：{errText(list.error)}</p>}
        {list.data !== undefined && items.length === 0 && (
          <p className="swt-empty">
            还没有工作流资产。可上传 JSON/ZIP，或在画布上选中一段链子后保存到工作流库。
          </p>
        )}

        {items.map((tpl) => (
          <div className="swt-row" key={tpl.id} onDoubleClick={() => void apply(tpl)}>
            <input
              type="checkbox"
              checked={selected.has(tpl.id)}
              aria-label={`选择 ${tpl.name}`}
              onDoubleClick={(event) => event.stopPropagation()}
              onChange={(event) => {
                setSelected((current) => {
                  const next = new Set(current)
                  if (event.target.checked) next.add(tpl.id)
                  else next.delete(tpl.id)
                  return next
                })
              }}
            />
            <span className="swt-row-icon">
              <Layers />
            </span>
            <div className="swt-row-text">
              <span className="swt-row-name">{tpl.name}</span>
              <span className="swt-row-sub">
                {tpl.node_count} 个节点 · {tpl.packaged ? `${tpl.resource_count} 个随包资源` : `${tpl.asset_count} 个指纹资源`} · {fmtTime(tpl.created_at)}
              </span>
              {tpl.note !== '' && <span className="swt-row-note">{tpl.note}</span>}
            </div>
            {confirmId === tpl.id ? (
              <span className="swt-row-acts">
                <span className="swt-confirm">删掉这条模板？画布上的节点不动</span>
                <button
                  className="btn btn-outline btn-sm"
                  onDoubleClick={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation()
                    setConfirmId(null)
                  }}
                >
                  算了
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  disabled={busyId !== null}
                  onDoubleClick={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation()
                    void remove(tpl)
                  }}
                >
                  删除
                </button>
              </span>
            ) : (
              <span className="swt-row-acts">
                <button
                  className="btn btn-primary btn-sm"
                  disabled={busyId !== null || libraryBusy}
                  onDoubleClick={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation()
                    void apply(tpl)
                  }}
                >
                  {busyId === tpl.id ? '应用中…' : '应用到画布'}
                </button>
                <button
                  className="btn-ghost-sm"
                  title="下载工作流 ZIP"
                  disabled={busyId !== null || libraryBusy}
                  onDoubleClick={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation()
                    void download([tpl.id])
                  }}
                >
                  <Download />
                </button>
                <button
                  className="btn-ghost-sm"
                  title="重命名工作流"
                  disabled={busyId !== null || libraryBusy}
                  onDoubleClick={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation()
                    void rename(tpl)
                  }}
                >
                  <Pencil />
                </button>
                <button
                  className="btn-ghost-sm"
                  title="删除模板"
                  disabled={busyId !== null || libraryBusy}
                  onDoubleClick={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation()
                    setConfirmId(tpl.id)
                  }}
                >
                  <Trash2 />
                </button>
              </span>
            )}
          </div>
        ))}
      </div>

      <div className="swt-foot">
        <span className="swt-hint">应用是「追加」，画布上原有的节点一个都不动</span>
        <button className="btn btn-outline" onClick={onClose}>
          关闭
        </button>
      </div>
    </Overlay>
  )
}
