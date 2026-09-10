/* 讲义正文右键菜单：查词 / 句子 AI 解析 / 朗读 / 复制 / AI 完善。

   菜单项按落点动态裁剪（与阅读器同一条设计原则 FR-378）：
   右键落在词上才有查词，有选区才有「完善所选」，避免点了没反应的死项。 */

import { useLayoutEffect, useRef, useState } from 'react'

import { IconSparkle, IconSpeaker } from '../../../components/icons'
import { IconBookmark, IconCopy, IconGrammar, IconTranslate } from '../../reader/readerIcons'
import { IconHighlighter } from '../../reader/local-icons'

export interface LibMenuTarget {
  x: number
  y: number
  /** 落点命中的已有批注 */
  annId: number | null
  /** 落在英文词上 */
  word: string | null
  /** 落点所在句（英文占多数时才给，AI 解析用） */
  sentence: string | null
  /** 当前选区文本 */
  selection: string | null
}

export interface LibMenuActions {
  onLookup: (word: string, context: string) => void
  onAnalyze: (sentence: string) => void
  onSpeak: (text: string) => void
  onCopy: (text: string) => void
  onImprove: (selection: string | null) => void
  /** 划词批注：颜色先给默认，进面板再改 */
  onAnnotate: () => void
  /** 落在已有批注上时直接打开它 */
  onOpenAnnotation: (id: number) => void
}

const MENU_W = 240

export function LibContextMenu({
  target,
  actions,
  onClose,
}: {
  target: LibMenuTarget
  actions: LibMenuActions
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: target.x, y: target.y })

  // 贴边翻转：菜单出屏幕就往回收
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    const h = el.offsetHeight
    setPos({
      x: Math.min(target.x, window.innerWidth - MENU_W - 8),
      y: target.y + h > window.innerHeight - 8 ? Math.max(8, target.y - h) : target.y,
    })
  }, [target])

  const run = (fn: () => void) => () => {
    fn()
    onClose()
  }
  const speakText = target.selection ?? target.sentence
  const copyText = target.selection ?? target.sentence

  return (
    <>
      <div className="glib-menu-backdrop" onClick={onClose} onContextMenu={(e) => e.preventDefault()} />
      <div className="glib-menu" ref={ref} style={{ left: pos.x, top: pos.y }} role="menu">
        {target.word !== null && (
          <button role="menuitem" onClick={run(() => actions.onLookup(target.word ?? '', target.sentence ?? ''))}>
            <IconTranslate />
            查词「{target.word}」
          </button>
        )}
        {target.sentence !== null && (
          <button role="menuitem" onClick={run(() => actions.onAnalyze(target.sentence ?? ''))}>
            <IconGrammar />
            AI 解析这句（翻译 · 语法 · 精讲）
          </button>
        )}
        {speakText !== null && (
          <button role="menuitem" onClick={run(() => actions.onSpeak(speakText))}>
            <IconSpeaker />
            朗读{target.selection !== null ? '所选' : '这句'}
          </button>
        )}
        {copyText !== null && (
          <button role="menuitem" onClick={run(() => actions.onCopy(copyText))}>
            <IconCopy />
            复制{target.selection !== null ? '所选' : '这句'}
          </button>
        )}
        {target.selection !== null && (
          <button role="menuitem" onClick={run(actions.onAnnotate)}>
            <IconHighlighter />
            批注所选（可再让 AI 分析）
          </button>
        )}
        {target.annId !== null && (
          <button
            role="menuitem"
            onClick={run(() => actions.onOpenAnnotation(target.annId ?? 0))}
          >
            <IconBookmark />
            打开这条批注
          </button>
        )}
        <div className="glib-menu-sep" />
        <button role="menuitem" onClick={run(() => actions.onImprove(target.selection))}>
          <IconSparkle />
          AI 完善{target.selection !== null ? '所选片段' : '这篇文档'}
        </button>
      </div>
    </>
  )
}
