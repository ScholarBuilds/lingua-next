/* 右侧 AI 抽屉：句子解析 / 节段完善。

   句子解析直接复用阅读器的 SentencePanel（翻译+语法+精讲三合一，SSE 流式
   带会话缓存）——同一句在阅读器和讲义库看到的解析永远一致，也不用养两套。

   节段完善的写回安全边界（为什么不做「所选片段一键写回」）：
   右键选区是渲染后 DOM 文本，Markdown 标记已剥掉，拿去替换源文件必然错位。
   只有按大纲节段切出的**精确源码区间**才允许写回；所选片段只出建议供复制。
   写回前先在 backups 目录落一份备份（服务端做），并且按钮两段式确认。 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { IconClose } from '../../../components/icons'
import type { DocContent } from '../../../lib/api-grammar-docs'
import { docsApi, streamImprove } from '../../../lib/api-grammar-docs'
import { Picker } from '@/components/ui/picker'
import type { CanvasItem } from '../../../lib/api-studio'
import {
  AttachButton,
  AttachStrip,
  MAX_ATTACHMENTS,
  uploadAttachments,
} from '../../studio/CanvasAttachments'
import { SentencePanel } from '../../reader/SentencePanel'
import type { SentenceSelection } from '../../reader/readerStore'

import type { SectionSlice, TocEntry } from './doc-model'
import { matchTrailingNewlines, sectionSlice } from './doc-model'
import { ObsidianMarkdown } from './ObsidianMarkdown'
import { saveFile } from '@/lib/shell'

export type DrawerState =
  | { kind: 'sentence'; sel: SentenceSelection }
  | { kind: 'improve'; selection: string | null }

type Phase = 'idle' | 'streaming' | 'done' | 'error'

/** 「整篇文档」在下拉里的取值。用哨兵而不是 null——null already means 未选 */
const WHOLE_DOC = 'whole'

function ImprovePane({
  doc,
  toc,
  selection,
  onApplied,
  onJumpSection,
}: {
  doc: DocContent
  toc: TocEntry[]
  selection: string | null
  onApplied: () => void
  onJumpSection: (index: number) => void
}) {
  // selection 有值 = 从右键「完善所选」进来，锁定为复制模式
  const fromSelection = selection !== null
  const [section, setSection] = useState<string | null>(null)
  const [instruction, setInstruction] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [armed, setArmed] = useState(false)
  const [applying, setApplying] = useState(false)
  /* 写回用的切片在**点生成那一刻**捕获：靠「当前 Picker 值」算的话，
     生成完了再切换节段，旧建议稿会被写进新节段的区间——错位覆盖 */
  const [ran, setRan] = useState<SectionSlice | null>(null)
  /* 输入框上的附件：截图、设计稿、术语表都能直接粘/拖进来。
     复用画布那套（uploadAttachments / AttachStrip / AttachButton）——
     先入库再挂 id，请求体里不进字节 */
  const [attachments, setAttachments] = useState<CanvasItem[]>([])
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const acRef = useRef<AbortController | null>(null)
  useEffect(() => () => acRef.current?.abort(), [])

  /* 层级不设限：原先只列到三级，四级以下的小节根本选不到，
     而讲义的例句与常见错误恰恰住在那一层。缩进把层级关系表出来即可。
     选一个大节 = 连同它下面所有子节一起（sectionSlice 本来就这么切）。 */
  const sectionOptions = useMemo(
    () => [
      { value: WHOLE_DOC, label: '整篇文档' },
      ...toc.map((e) => ({
        value: String(e.index),
        label: `${'　'.repeat(Math.max(0, e.level - 1))}${e.text}`,
      })),
    ],
    [toc],
  )

  /* 整篇：区间就是整个正文，写回照样精确（不必走「截断前 8000 字」那条路） */
  const slice = useMemo<SectionSlice | null>(() => {
    if (section === WHOLE_DOC) return { start: 0, end: doc.body.length, text: doc.body }
    if (section === null) return null
    return sectionSlice(doc.body, toc, Number(section))
  }, [doc.body, toc, section])

  const source = fromSelection ? selection : (slice?.text ?? null)

  /* 换节段 = 换稿：上一稿的文本/完成态/确认态全部作废，否则切换后
     单击「确认写回」会把 A 节的稿子写进 B 节的区间。
     顺带把正文滚到那一节——选了哪段就该看见哪段，否则完全是盲选。 */
  const pickSection = (v: string) => {
    setSection(v === '' ? null : v)
    if (v !== '' && v !== WHOLE_DOC) onJumpSection(Number(v))
    acRef.current?.abort()
    setPhase('idle')
    setText('')
    setArmed(false)
    setRan(null)
  }

  const addFiles = async (files: File[]) => {
    const room = MAX_ATTACHMENTS - attachments.length
    if (room <= 0) {
      toast.info(`最多带 ${MAX_ATTACHMENTS} 个附件`)
      return
    }
    setUploading(true)
    try {
      const added = await uploadAttachments(files.slice(0, room))
      if (added.length > 0) setAttachments((prev) => [...prev, ...added])
    } finally {
      setUploading(false)
    }
  }

  const run = () => {
    if (source === null) return
    acRef.current?.abort()
    const ac = new AbortController()
    acRef.current = ac
    setPhase('streaming')
    setText('')
    setArmed(false)
    setRan(fromSelection ? null : slice)
    void streamImprove(
      {
        path: doc.path,
        selection: source,
        instruction: instruction || undefined,
        ref_asset_ids: attachments
          .filter((a) => a.kind === 'image' && a.asset_id !== undefined)
          .map((a) => a.asset_id as number),
        file_asset_ids: attachments
          .filter((a) => a.kind !== 'image' && a.media_asset_id !== undefined)
          .map((a) => a.media_asset_id as number),
      },
      {
        onDelta: (t) => setText((prev) => prev + t),
        onDone: (full) => {
          setText(full)
          setPhase('done')
        },
        onError: (msg) => {
          setError(msg)
          setPhase('error')
        },
      },
      ac.signal,
    )
  }

  const copy = () => {
    void navigator.clipboard.writeText(text)
    toast.success('Markdown 已复制')
  }

  /** 贴进不认 Markdown 的地方（微信、备忘录）时要的是干净文本 */
  const copyPlain = () => {
    const plain = text
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^>\s?/gm, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    void navigator.clipboard.writeText(plain)
    toast.success('纯文本已复制')
  }

  const download = () => {
    saveFile(new Blob([text], { type: 'text/markdown;charset=utf-8' }), `${doc.name}-改进稿.md`)
  }

  const apply = async () => {
    if (ran === null || applying) return
    // raw 是文件原始全文，body 是它剥掉 front matter 后的后缀；
    // 节段偏移在 body 空间里，写回时补上前缀长度。
    // 尾换行必须对齐原切片：LLM 收尾会 strip 掉换行，不补的话
    // 下一个标题行会被粘进正文
    const improved = matchTrailingNewlines(ran.text, text)
    const prefix = doc.raw.length - doc.body.length
    const next = doc.raw.slice(0, prefix + ran.start) + improved + doc.raw.slice(prefix + ran.end)
    setApplying(true)
    try {
      // base_mtime：打开文档之后文件被 Obsidian 改过的话服务端 409，
      // 不许拿旧基底把外部编辑静默回滚掉
      const res = await docsApi.apply(doc.path, next, doc.mtime)
      toast.success(`已写回源文件（备份：${res.backup}）`)
      onApplied()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setApplying(false)
      setArmed(false)
    }
  }

  return (
    <div className="glib-improve">
      {fromSelection ? (
        <p className="glib-improve-scope">
          完善所选片段（选区来自渲染文本，只出建议供复制，不能直接写回）
        </p>
      ) : (
        <div className="glib-improve-scope">
          <span>完善节段</span>
          <Picker
            value={section ?? ''}
            onChange={pickSection}
            options={sectionOptions}
            placeholder="选择要完善的节段…"
            size="sm"
            aria-label="完善节段"
          />
        </div>
      )}
      <div
        className={`glib-improve-box ${dragOver ? 'is-drag' : ''}`}
        onDragOver={(e) => {
          if (!Array.from(e.dataTransfer.types).includes('Files')) return
          e.preventDefault()
          e.stopPropagation()
          e.dataTransfer.dropEffect = 'copy'
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          const files = Array.from(e.dataTransfer.files ?? [])
          setDragOver(false)
          if (files.length === 0) return
          e.preventDefault()
          e.stopPropagation()
          void addFiles(files)
        }}
      >
        <AttachStrip items={attachments} onChange={setAttachments} compact />
        <textarea
          className="glib-improve-input"
          placeholder="附加要求（可选）：例如「例句换成日常口语」「按这张图补一节」…可直接粘贴截图或拖入文件"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onPaste={(e) => {
            /* 文件判在文本之前：很多来源（访达复制的文件、截图工具）会
               同时给 files 和一段 text/plain，先读文本的话文件就丢了 */
            const files = Array.from(e.clipboardData.files ?? [])
            if (files.length === 0) return
            e.preventDefault()
            void addFiles(files)
          }}
          rows={2}
        />
        <div className="glib-improve-attach">
          <AttachButton onPick={(files) => void addFiles(files)} busy={uploading} />
        </div>
      </div>
      <div className="glib-improve-run">
        <button
          className="btn btn-soft btn-sm"
          disabled={source === null || phase === 'streaming'}
          onClick={run}
        >
          {phase === 'streaming' ? '生成中…' : phase === 'done' ? '重新生成' : '生成完善建议'}
        </button>
        {source !== null && <i>{source.length.toLocaleString('en-US')} 字符</i>}
      </div>

      {phase === 'error' && <p className="glib-improve-error">{error}</p>}
      {phase === 'streaming' && <pre className="glib-improve-stream">{text}</pre>}
      {phase === 'done' && (
        <>
          <div className="glib-improve-preview">
            <ObsidianMarkdown markdown={text} onWikiLink={() => {}} onWordClick={() => {}} />
          </div>
          <div className="glib-improve-actions">
            <button className="btn btn-soft btn-sm" onClick={copy}>
              复制 Markdown
            </button>
            <button className="btn btn-soft btn-sm" onClick={copyPlain}>
              复制纯文本
            </button>
            <button className="btn btn-soft btn-sm" onClick={download}>
              存为 .md
            </button>
            {!fromSelection && ran !== null && (
              <button
                className={`btn btn-sm ${armed ? 'btn-end' : 'btn-soft'}`}
                disabled={applying}
                onClick={() => {
                  if (armed) void apply()
                  else setArmed(true)
                }}
              >
                {applying ? '写回中…' : armed ? '确认写回（已自动备份）' : '写回源文件…'}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export function AiDrawer({
  state,
  doc,
  toc,
  onClose,
  onApplied,
  onJumpSection,
}: {
  state: DrawerState
  doc: DocContent | null
  toc: TocEntry[]
  onClose: () => void
  onApplied: () => void
  onJumpSection: (index: number) => void
}) {
  return (
    <aside className="glib-ai" aria-label="AI 面板">
      <div className="glib-ai-head">
        <b>{state.kind === 'sentence' ? '句子解析' : 'AI 完善文档'}</b>
        <button className="icon-btn" title="关闭" onClick={onClose}>
          <IconClose />
        </button>
      </div>
      <div className="glib-ai-body">
        {state.kind === 'sentence' && <SentencePanel sel={state.sel} />}
        {state.kind === 'improve' && doc !== null && (
          <ImprovePane
            doc={doc}
            toc={toc}
            selection={state.selection}
            onApplied={onApplied}
            onJumpSection={onJumpSection}
          />
        )}
      </div>
    </aside>
  )
}
