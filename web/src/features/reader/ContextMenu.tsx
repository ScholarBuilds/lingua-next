/* 正文右键菜单（FR-378）：把点词/朗读/批注/AI 这些散在各处的动作收进一个菜单。

   菜单项按"当前右键落在什么上"动态裁剪——右键在词上才有查词，
   有选区才有高亮与词组，没句子锚点就不给朗读，避免出现点了没反应的死项。 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { IconSparkle, IconSpeaker, IconStar } from '../../components/icons'
import { IconBookmark, IconCopy, IconGrammar, IconTranslate } from './readerIcons'
import { IconHighlighter } from './local-icons'
import type { AnnotationColor } from '../../lib/api-reader-m5'

export interface MenuTarget {
  x: number
  y: number
  /** 右键落点所在段落 */
  paragraphId: number
  /** 落在词上时的词元信息 */
  word: { word: string; surface: string; start: number; end: number } | null
  /** 覆盖落点的句子 */
  sentence: { id: number; text: string; start: number; end: number } | null
  /** 当前选区文本（跨词组时用） */
  selection: { text: string; start: number; end: number } | null
}

export interface ContextMenuActions {
  onLookup: () => void
  onCollect: () => void
  onSpeak: () => void
  onSpeakOn: () => void
  onTranslate: () => void
  onGrammar: () => void
  onAskAi: () => void
  onHighlight: (color: AnnotationColor) => void
  onNote: () => void
  onBookmark: () => void
  onCopy: () => void
  onPhrase: () => void
}

const COLORS: Array<{ value: AnnotationColor; label: string }> = [
  { value: 'yellow', label: '黄' },
  { value: 'green', label: '绿' },
  { value: 'blue', label: '蓝' },
  { value: 'pink', label: '粉' },
]

const MENU_W = 232

export function ContextMenu({
  target,
  actions,
  onClose,
}: {
  target: MenuTarget
  actions: ContextMenuActions
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: target.x, y: target.y })

  // 贴边翻转：菜单不能被视口切掉，量到真实高度后再定位
  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight ?? 260
    setPos({
      x: Math.min(target.x, window.innerWidth - MENU_W - 10),
      y: target.y + h > window.innerHeight - 10 ? Math.max(10, target.y - h) : target.y,
    })
  }, [target])

  useEffect(() => {
    const close = () => onClose()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const run = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation()
    fn()
    onClose()
  }

  const selWords = target.selection?.text.split(/\s+/).filter(Boolean).length ?? 0
  const hasSel = target.selection !== null

  return (
    <div
      ref={ref}
      className="rc-menu"
      style={{ left: pos.x, top: pos.y, width: MENU_W }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {target.word !== null && (
        <>
          <div className="rc-head">{target.word.surface}</div>
          <button className="rc-item" onClick={run(actions.onLookup)}>
            <IconSparkle />
            查这个词
          </button>
          <button className="rc-item" onClick={run(actions.onCollect)}>
            <IconStar />
            加入生词本
          </button>
          <div className="rc-sep" />
        </>
      )}

      {hasSel && selWords >= 2 && selWords <= 6 && (
        <button className="rc-item" onClick={run(actions.onPhrase)}>
          <IconSparkle />
          解释这个词组
        </button>
      )}

      {target.sentence !== null && (
        <>
          <button className="rc-item" onClick={run(actions.onSpeak)}>
            <IconSpeaker />
            朗读本句
          </button>
          <button className="rc-item" onClick={run(actions.onSpeakOn)}>
            <IconSpeaker />
            从这里读下去
          </button>
          <button className="rc-item" onClick={run(actions.onTranslate)}>
            <IconTranslate />
            看本句翻译
          </button>
          <button className="rc-item" onClick={run(actions.onGrammar)}>
            <IconGrammar />
            语法分析
          </button>
          <div className="rc-sep" />
        </>
      )}

      <button className="rc-item" onClick={run(actions.onAskAi)}>
        <IconSparkle />
        问 AI 陪读
      </button>

      {hasSel && (
        <>
          <div className="rc-sep" />
          <div className="rc-colors">
            <IconHighlighter />
            {COLORS.map((c) => (
              <button
                key={c.value}
                className={`rc-dot c-${c.value}`}
                title={`${c.label}色高亮`}
                onClick={run(() => actions.onHighlight(c.value))}
              />
            ))}
          </div>
          <button className="rc-item" onClick={run(actions.onNote)}>
            <IconHighlighter />
            高亮并写笔记
          </button>
        </>
      )}

      <div className="rc-sep" />
      <button className="rc-item" onClick={run(actions.onBookmark)}>
        <IconBookmark />
        在这里插书签
      </button>
      <button className="rc-item" onClick={run(actions.onCopy)}>
        <IconCopy />
        {hasSel ? '复制所选' : '复制本段'}
      </button>
    </div>
  )
}
