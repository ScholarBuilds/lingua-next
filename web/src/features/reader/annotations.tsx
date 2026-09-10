/* 批注（M5-FA）：正文选区工具条、批注编辑浮层、右栏批注列表。
   选区偏移按段落纯文本计算（跳过 .trans 译文行），与后端 char_start/char_end 对齐。 */

import { useEffect, useRef, useState } from 'react'

import { IconClose, IconDownload, IconSparkle, IconTrash } from '../../components/icons'
import type { Article } from '../../lib/api'
import { readerApi } from '../../lib/api-reader-m5'
import type { Annotation, AnnotationColor } from '../../lib/api-reader-m5'
import { IconNote } from './local-icons'
import { saveFile } from '@/lib/shell'

export const ANNOTATION_COLORS: AnnotationColor[] = ['yellow', 'green', 'pink', 'blue']

const COLOR_LABEL: Record<AnnotationColor, string> = {
  yellow: '黄色高亮',
  green: '绿色高亮',
  pink: '粉色高亮',
  blue: '蓝色高亮',
}

/* ---------------- 选区 → 段落字符区间 ---------------- */

export interface ParagraphSelection {
  paragraphId: number
  start: number
  end: number
  text: string
  /** 选区包围盒（viewport 坐标），工具条定位用 */
  rect: DOMRect
}

/** 段落根内某个 DOM 边界点 → 段落纯文本偏移（跳过 .trans 译文行文本） */
function prefixLength(root: HTMLElement, node: Node, offset: number): number | null {
  const range = document.createRange()
  range.selectNodeContents(root)
  try {
    range.setEnd(node, offset)
  } catch {
    return null
  }
  const frag = range.cloneContents()
  let acc = 0
  const walker = document.createTreeWalker(frag, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const t = walker.currentNode as Text
    if (t.parentElement?.closest('.trans') == null) acc += t.data.length
  }
  return acc
}

/** 读取当前 window 选区：落在单个 [data-pid] 段落内才返回，跨段返回 null */
export function readParagraphSelection(container: HTMLElement): ParagraphSelection | null {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  const paraOf = (node: Node): HTMLElement | null => {
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement
    return el?.closest<HTMLElement>('[data-pid]') ?? null
  }
  const startPara = paraOf(range.startContainer)
  const endPara = paraOf(range.endContainer)
  if (!startPara || startPara !== endPara || !container.contains(startPara)) return null
  const pid = Number(startPara.dataset.pid)
  if (!Number.isFinite(pid)) return null
  const a = prefixLength(startPara, range.startContainer, range.startOffset)
  const b = prefixLength(startPara, range.endContainer, range.endOffset)
  if (a === null || b === null) return null
  const start = Math.min(a, b)
  const end = Math.max(a, b)
  if (start === end) return null
  return { paragraphId: pid, start, end, text: '', rect: range.getBoundingClientRect() }
}

/** 去掉区间两端空白，返回修剪后的区间与文本 */
export function trimSelectionRange(
  paraText: string,
  start: number,
  end: number,
): { start: number; end: number; text: string } | null {
  let s = Math.max(0, start)
  let e = Math.min(paraText.length, end)
  while (s < e && /\s/.test(paraText[s])) s++
  while (e > s && /\s/.test(paraText[e - 1])) e--
  if (s >= e) return null
  return { start: s, end: e, text: paraText.slice(s, e) }
}

/* ---------------- 选区浮动工具条 ---------------- */

interface SelectionToolbarProps {
  x: number
  y: number
  /** ≤6 词的选区显示"词组解释" */
  showPhrase: boolean
  busy: boolean
  onPickColor: (color: AnnotationColor) => void
  onNote: () => void
  onPhrase: () => void
}

export function SelectionToolbar({
  x,
  y,
  showPhrase,
  busy,
  onPickColor,
  onNote,
  onPhrase,
}: SelectionToolbarProps) {
  return (
    <div
      className="sel-toolbar"
      style={{ left: x, top: y }}
      onMouseDown={(e) => e.preventDefault() /* 防止点击工具条塌掉选区 */}
    >
      {ANNOTATION_COLORS.map((c) => (
        <button
          key={c}
          className={`ann-dot ann-dot-${c}`}
          title={COLOR_LABEL[c]}
          disabled={busy}
          onClick={() => onPickColor(c)}
        />
      ))}
      <button className="sel-tool-btn" title="批注并写笔记" disabled={busy} onClick={onNote}>
        <IconNote />
        笔记
      </button>
      {showPhrase && (
        <>
          <span className="sel-tool-sep" />
          <button className="sel-tool-btn" title="AI 词组解释" disabled={busy} onClick={onPhrase}>
            <IconSparkle />
            词组解释
          </button>
        </>
      )}
    </div>
  )
}

/* ---------------- 批注编辑浮层 ---------------- */

interface AnnotationPopoverProps {
  annotation: Annotation
  x: number
  y: number
  busy: boolean
  onChangeColor: (color: AnnotationColor) => void
  onSaveNote: (note: string) => void
  onDelete: () => void
  onClose: () => void
}

export function AnnotationPopover({
  annotation,
  x,
  y,
  busy,
  onChangeColor,
  onSaveNote,
  onDelete,
  onClose,
}: AnnotationPopoverProps) {
  const [note, setNote] = useState(annotation.note ?? '')
  const rootRef = useRef<HTMLDivElement>(null)

  // 点浮层外关闭
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const dirty = note.trim() !== (annotation.note ?? '').trim()

  return (
    <div className="ann-pop" style={{ left: x, top: y }} ref={rootRef}>
      <div className="ann-pop-row">
        {ANNOTATION_COLORS.map((c) => (
          <button
            key={c}
            className={`ann-dot ann-dot-${c}${annotation.color === c ? ' active' : ''}`}
            title={COLOR_LABEL[c]}
            disabled={busy}
            onClick={() => onChangeColor(c)}
          />
        ))}
        <div style={{ flex: 1 }} />
        <button className="icon-btn" title="删除批注" disabled={busy} onClick={onDelete}>
          <IconTrash />
        </button>
        <button className="icon-btn" title="关闭" onClick={onClose}>
          <IconClose />
        </button>
      </div>
      <textarea
        className="ann-pop-note"
        placeholder="写点笔记…"
        value={note}
        disabled={busy}
        onChange={(e) => setNote(e.target.value)}
      />
      {dirty && (
        <div className="ann-pop-foot">
          <button
            className="btn btn-primary btn-sm"
            disabled={busy}
            onClick={() => onSaveNote(note.trim())}
          >
            保存笔记
          </button>
        </div>
      )}
    </div>
  )
}

/* ---------------- 右栏批注列表 ---------------- */

interface AnnotationsPanelProps {
  article: Article
  annotations: Annotation[] | undefined
  loading: boolean
  error: boolean
  onJump: (annotation: Annotation) => void
}

export function AnnotationsPanel({
  article,
  annotations,
  loading,
  error,
  onJump,
}: AnnotationsPanelProps) {
  const [exporting, setExporting] = useState(false)
  const paraById = new Map(article.paragraphs.map((p) => [p.id, p]))

  const exportMarkdown = async () => {
    setExporting(true)
    try {
      const md = await readerApi.exportAnnotationsMarkdown(article.id)
      saveFile(new Blob([md], { type: 'text/markdown;charset=utf-8' }), `annotations-${article.id}.md`)
    } catch {
      /* 导出失败静默：列表仍可用 */
    } finally {
      setExporting(false)
    }
  }

  const rows = [...(annotations ?? [])].sort((a, b) => {
    const pa = paraById.get(a.paragraph_id)?.ordinal ?? 0
    const pb = paraById.get(b.paragraph_id)?.ordinal ?? 0
    return pa - pb || a.char_start - b.char_start
  })

  return (
    <>
      <div className="panel-head">
        <h3>批注</h3>
        {rows.length > 0 && <span className="chip">{rows.length}</span>}
        <div style={{ flex: 1 }} />
        <button
          className="btn-ghost-sm"
          disabled={exporting || rows.length === 0}
          onClick={() => void exportMarkdown()}
          title="导出 Markdown"
        >
          <IconDownload style={{ width: 13, height: 13, marginRight: 4, verticalAlign: -2 }} />
          {exporting ? '导出中…' : '导出'}
        </button>
      </div>
      <div className="panel-body anl-body">
        {loading && <div className="panel-hint">加载批注…</div>}
        {error && <div className="panel-error">批注加载失败</div>}
        {!loading && !error && rows.length === 0 && (
          <div className="anl-empty">
            正文划选文字即可添加高亮批注
            <br />
            批注支持四色与笔记
          </div>
        )}
        {rows.map((a) => {
          const para = paraById.get(a.paragraph_id)
          const quote = para ? para.text.slice(a.char_start, a.char_end) : ''
          return (
            <button key={a.id} className="anl-row" title="跳转到原文" onClick={() => onJump(a)}>
              <span className={`anl-bar anl-bar-${a.color}`} />
              <span className="anl-main">
                <span className="anl-quote">{quote || '（原文已变更）'}</span>
                {a.note && <span className="anl-note">{a.note}</span>}
                <span className="anl-meta">
                  第 {(para?.ordinal ?? a.paragraph_ordinal ?? 0) + 1} 段
                </span>
              </span>
            </button>
          )
        })}
      </div>
    </>
  )
}
